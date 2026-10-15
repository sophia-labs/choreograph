/**
 * The gate has NO exemption by account (Vera, 2026-10-03: "House probe accounts are FUNDED by script through the
 * CLI (test funding), no exemption in the gate"). A probe, a test account, an operator, a friend: when the
 * balance cannot pay for the smallest viable call, enforce refuses, and the way back in is money, put in by the
 * adjustment script like anyone's. The only people the gate never gates are the ones who pay their own provider
 * (BYOK, `lmstudio`) and host-internal `mock:` models: nobody by who they are.
 *
 * Two guards, because "no exemption" is a thing that can be added in two ways:
 *
 *  1. BEHAVIOUR: against the real gate and a real ledger, an empty account is refused in enforce whoever it is,
 *     and whatever the environment says about it (every exemption-shaped variable a person might reach for is
 *     set to the account's own id); funded through the script's own library, the same account is admitted with
 *     the environment clean, so it was the money that let it in;
 *  2. STRUCTURE: the gate module reads exactly one environment variable, `BILLING_GATE_MODE`. A second one in
 *     that file is a knob that can excuse someone, and it fails here until a person decides it should not.
 *
 * RUN:  npx tsx --test src/test/billing-gate-no-exemption.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { applyAdjustments, parseAdjustmentBatch, planAdjustments } from "../billing-adjust.js";
import { CreditAdmission } from "../billing-gate.js";
import type { BillingStore } from "../billing-store.js";
import { openBilling, seedBalance } from "./billing-ledger-fixture.js";

const GATE_SOURCE = new URL("../billing-gate.ts", import.meta.url).pathname;

/** Every exemption-shaped name a person might reach for. None of them is read by anything. */
const EXEMPTION_SHAPED_ENV = [
	"BILLING_EXEMPT_USER_IDS",
	"BILLING_EXEMPT_USERS",
	"BILLING_EXEMPT_ACCOUNTS",
	"BILLING_ALLOWLIST",
	"BILLING_ALLOW_USER_IDS",
	"BILLING_BYPASS_USER_IDS",
	"BILLING_PROBE_USER_IDS",
	"BILLING_FREE_USER_IDS",
	"BILLING_GATE_EXEMPT",
	"BILLING_GATE_EXEMPT_USERS",
	"BILLING_GATE_ALLOWLIST",
	"CREDIT_GATE_EXEMPT_USERS",
	"CHOREOGRAPH_BILLING_EXEMPT_USERS",
] as const;

describe("the gate excuses no account: a probe is funded, never exempt", () => {
	let dir = "";
	let billing: BillingStore;
	const saved = new Map<string, string | undefined>();

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "gate-no-exemption-"));
		billing = await openBilling(dir);
	});
	afterEach(() => {
		billing.close();
		rmSync(dir, { recursive: true, force: true });
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		saved.clear();
	});

	function setEnv(name: string, value: string): void {
		if (!saved.has(name)) saved.set(name, process.env[name]);
		process.env[name] = value;
	}

	const ask = (userId: string) =>
		new CreditAdmission({ billing, mode: "enforce", log: () => {} }).admitIngress({
			door: "ingress.invocation",
			userId,
			provider: "openrouter",
			model: "google/gemini-2.5-flash",
		});

	it("an empty account is refused in enforce whoever it is, and whatever the environment says about it", async () => {
		const people = ["house-probe-0001", "0a1b2c3d-0000-4000-8000-00000000abcd", "operator-ada", "a-friend"];
		for (const id of people) await seedBalance(billing, id, 3_800);
		for (const id of people)
			assert.equal((await ask(id)).allow, false, `${id} has $0.0038: below the smallest viable call`);

		for (const name of EXEMPTION_SHAPED_ENV) setEnv(name, people.join(","));
		setEnv("BILLING_GATE_MODE", "enforce");
		for (const id of people) {
			assert.equal((await ask(id)).allow, false, `${id}: no variable excuses an account`);
		}
	});

	it("funded by the script's own library, the same account is admitted with the environment clean: the money let it in", async () => {
		const probe = "house-probe-0002";
		await seedBalance(billing, probe, 3_800);
		assert.equal((await ask(probe)).allow, false);

		const batch = parseAdjustmentBatch({
			schema: "sophia.credit-adjustment-batch.v1",
			batch: "probe-funding-1",
			actor: "operator:ada",
			adjustments: [
				{
					label: "house-probe",
					userId: probe,
					amountMicroUsd: 2_000_000,
					kind: "operator_funding",
					reason: "Test funding for acceptance runs",
				},
			],
		});
		const plan = await planAdjustments(billing, batch);
		assert.deepEqual(plan.blocking, []);
		await applyAdjustments(billing, batch, { expectedPlanSha256: plan.planSha256 });

		for (const name of EXEMPTION_SHAPED_ENV) assert.equal(process.env[name], undefined, `${name} is not set`);
		assert.equal((await ask(probe)).allow, true, "admitted on its balance, nothing else");
		await billing.recordCreditAdjustment({
			adjustmentId: "ops:probe-drain:1",
			userId: probe,
			amountMicroUsd: -2_000_000,
			kind: "correction",
			reason: "Test funding spent",
			actor: "operator:ada",
		});
		assert.equal((await ask(probe)).allow, false, "and refused again the moment the money is gone");
	});
});

describe("the gate module reads exactly one environment variable", () => {
	/** The code of the file, without its comments: prose may mention a variable, code may not read one. */
	function codeOf(path: string): string {
		return readFileSync(path, "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/^\s*\/\/.*$/gm, "");
	}

	/** Every `env.NAME`, `process.env.NAME` and `env["NAME"]` in the code, and the count of reads by a computed name. */
	function envReadsOf(code: string): { names: string[]; dynamic: number } {
		const names = new Set<string>();
		let dynamic = 0;
		for (const match of code.matchAll(
			/\b(?:process\.)?env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["'`]([^"'`]+)["'`]\s*\]|\[)/g,
		)) {
			const name = match[1] ?? match[2];
			if (name) names.add(name);
			else dynamic += 1;
		}
		return { names: [...names].sort(), dynamic };
	}

	it("BILLING_GATE_MODE, and no read of the environment by a name it computes", () => {
		const reads = envReadsOf(codeOf(GATE_SOURCE));
		assert.deepEqual(reads.names, ["BILLING_GATE_MODE"]);
		assert.equal(reads.dynamic, 0);
	});

	it("the check can fail: a second read in the file, by name or by a computed one, is seen", () => {
		const code = codeOf(GATE_SOURCE);
		const named = envReadsOf(`${code}\nconst excused = process.env.BILLING_EXEMPT_USER_IDS;\n`);
		assert.deepEqual(named.names, ["BILLING_EXEMPT_USER_IDS", "BILLING_GATE_MODE"]);
		const bracketed = envReadsOf(`${code}\nconst excused = process.env["BILLING_EXEMPT_USER_IDS"];\n`);
		assert.deepEqual(bracketed.names, ["BILLING_EXEMPT_USER_IDS", "BILLING_GATE_MODE"]);
		const computed = envReadsOf(`${code}\nconst excused = process.env[name];\n`);
		assert.equal(computed.dynamic, 1);
	});
});
