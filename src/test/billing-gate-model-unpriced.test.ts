/**
 * A voice the host will not price is refused, and the refusal is RECORDED (Vera, 2026-10-03: "record
 * `model_unpriced` refusals in `gate_events`"). `model_unpriced` was already one of the gate's decisions and
 * nothing wrote it: a person turned away from a model (a router priced -1, a free model, one with no tools, a
 * precision no provider offers) left no trace except the 422 they were sent, so which voices people ask for and
 * the host will not give could not be counted, and the next catalogue rule or price had nothing to be told by.
 *
 * REAL libSQL ledger, the REAL router with a REAL catalogue (the 2026-09-29 rows) and the real gate, NO MOCKS:
 *
 *  - the gate writes one row naming the person, the voice and the reason, door `ingress.invocation`, in whichever
 *    mode it is in (the refusal is not a credit verdict: it is the same in observe and enforce, and never
 *    "would"), and a countable log line; a write that fails is logged and never breaks the request;
 *  - over the real route each way the host says `model_unpriced` leaves exactly one such row, the 422 is
 *    unchanged (code, reason), and no run exists;
 *  - what is NOT an unpriced voice is not recorded as one (an unknown id is a 404, another provider a 400), and a
 *    voice that is priced leaves no row at all;
 *  - a host with no gate answers the same 422 and nothing breaks.
 *
 * RUN:  npx tsx --test src/test/billing-gate-model-unpriced.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { type BillingGateMode, CreditAdmission } from "../billing-gate.js";
import type { BillingStore } from "../billing-store.js";
import { asPerson, CreditRouteRig, httpJson, workspaceChatEnvelope } from "./billing-credit-fixture.js";
import { openBilling } from "./billing-ledger-fixture.js";

const ASYNC = { prefer: "respond-async" };
const KIMI = "moonshotai/kimi-k2.5";

describe("the gate records a refused voice as one row", () => {
	let dir = "";
	let billing: BillingStore;

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "gate-model-unpriced-"));
		billing = await openBilling(dir);
	});
	afterEach(() => {
		billing.close();
		rmSync(dir, { recursive: true, force: true });
	});

	for (const mode of ["observe", "enforce"] as const satisfies readonly BillingGateMode[]) {
		it(`${mode}: one row, naming the person, the voice and the reason; the same row in either mode, never a would_`, async () => {
			const lines: string[] = [];
			const gate = new CreditAdmission({
				billing,
				mode,
				now: () => 1_790_000_000_000,
				log: (line) => lines.push(line),
			});
			await gate.recordModelUnpriced({ userId: "owner-1", model: "openrouter/auto", reason: "price_dynamic" });
			const rows = await billing.listGateEvents({ userId: "owner-1" });
			assert.equal(rows.length, 1);
			assert.deepEqual(
				{ ...rows[0], id: undefined },
				{
					id: undefined,
					ts: 1_790_000_000_000,
					userId: "owner-1",
					mode,
					door: "ingress.invocation",
					decision: "model_unpriced",
					model: "openrouter/auto",
					balanceMicroUsd: null,
					requiredMicroUsd: null,
					reason: "reason=price_dynamic",
				},
			);
			assert.ok(
				lines.some((line) =>
					line.startsWith(`[billing] gate=model_unpriced mode=${mode} door=ingress.invocation user=owner-1`),
				),
				`a countable log line, got ${JSON.stringify(lines)}`,
			);
		});
	}

	it("a refusal with no person to attribute it to is still a row", async () => {
		const gate = new CreditAdmission({ billing, mode: "enforce", log: () => {} });
		await gate.recordModelUnpriced({ userId: null, model: "perplexity/sonar", reason: "no_tools" });
		const [row] = await billing.listGateEvents();
		assert.equal(row.userId, null);
		assert.equal(row.decision, "model_unpriced");
		assert.equal(row.model, "perplexity/sonar");
	});

	it("a ledger that cannot be written to never breaks the request: logged, not thrown", async () => {
		const lines: string[] = [];
		const gate = new CreditAdmission({ billing, mode: "enforce", log: (line) => lines.push(line) });
		billing.close();
		await gate.recordModelUnpriced({ userId: "owner-1", model: "openrouter/auto", reason: "price_dynamic" });
		assert.ok(
			lines.some((line) => line.includes("gate event write failed (non-fatal)")),
			JSON.stringify(lines),
		);
	});
});

describe("over the real route, each way the host says model_unpriced leaves one row", { concurrency: false }, () => {
	const rig = new CreditRouteRig();
	let counter = 0;
	const nextUser = () => `owner-unpriced-${++counter}`;

	before(() => rig.start({ catalogue: true }));
	after(() => rig.stop());

	async function chat(userId: string, inference: Record<string, unknown>) {
		const envelope = workspaceChatEnvelope(`unpriced.${userId}`, userId);
		(envelope.input as Record<string, unknown>).inference = inference;
		return httpJson(rig.server.baseUrl, "POST", "/api/invocations", {
			body: envelope,
			headers: asPerson(userId, ASYNC),
		});
	}

	const REFUSALS: Array<[string, Record<string, unknown>, string]> = [
		["a router priced -1", { provider: "openrouter", model: "openrouter/auto" }, "price_dynamic"],
		["a free model", { provider: "openrouter", model: "qwen/qwen3.8-27b:free" }, "zero_priced"],
		["a model with no tools", { provider: "openrouter", model: "perplexity/sonar" }, "no_tools"],
		[
			"a priced model at a precision no provider is shown to offer",
			{ provider: "openrouter", model: KIMI, precision: "full" },
			"precision_unavailable",
		],
	];

	for (const mode of ["enforce", "observe"] as const satisfies readonly BillingGateMode[]) {
		for (const [label, inference, reason] of REFUSALS) {
			it(`${mode}: ${label} is a 422 model_unpriced/${reason} and one row`, async () => {
				rig.gate = new CreditAdmission({ billing: rig.billing, mode, log: () => {} });
				const user = nextUser();
				const runsBefore = await rig.journal.listRuns({ ownerUserId: user, limit: 100 });
				const res = await chat(user, inference);
				assert.equal(res.status, 422, res.text);
				const error = (res.body as { error: { code: string; details: { reason: string } } }).error;
				assert.equal(error.code, "model_unpriced");
				assert.equal(error.details.reason, reason, "the response is as it was");

				const rows = await rig.billing.listGateEvents({ userId: user });
				assert.equal(rows.length, 1, JSON.stringify(rows));
				assert.equal(rows[0].decision, "model_unpriced");
				assert.equal(rows[0].door, "ingress.invocation");
				assert.equal(rows[0].mode, mode);
				assert.equal(rows[0].model, inference.model);
				assert.equal(rows[0].reason, `reason=${reason}`);
				assert.equal(rows[0].balanceMicroUsd, null, "not a credit verdict: no balance was read");
				assert.equal(rows[0].requiredMicroUsd, null);
				assert.deepEqual(
					await rig.journal.listRuns({ ownerUserId: user, limit: 100 }),
					runsBefore,
					"no run exists",
				);
			});
		}
	}

	it("what is not an unpriced voice is not recorded as one, and a priced voice leaves no row", async () => {
		rig.gate = new CreditAdmission({ billing: rig.billing, mode: "enforce", log: () => {} });
		const unknown = nextUser();
		const missing = await chat(unknown, { provider: "openrouter", model: "vendor/not-a-model" });
		assert.equal(missing.status, 404, missing.text);
		const other = nextUser();
		const provider = await chat(other, { provider: "openai", model: "gpt-5" });
		assert.equal(provider.status, 400, provider.text);
		const priced = nextUser();
		const started = await chat(priced, { provider: "openrouter", model: KIMI });
		assert.equal(started.status, 202, started.text);
		for (const user of [unknown, other, priced]) {
			assert.deepEqual(await rig.billing.listGateEvents({ userId: user }), [], user);
		}
	});

	it("a host with no gate answers the same 422, and nothing breaks", async () => {
		rig.gate = undefined;
		const user = nextUser();
		const res = await chat(user, { provider: "openrouter", model: "openrouter/auto" });
		assert.equal(res.status, 422, res.text);
		assert.equal((res.body as { error: { code: string } }).error.code, "model_unpriced");
		assert.deepEqual(await rig.billing.listGateEvents({ userId: user }), []);
	});
});
