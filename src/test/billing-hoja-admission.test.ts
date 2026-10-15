/**
 * The Hoja evaluators under the credit gate (Sobremesa, E §3.2 S1) — REAL store, REAL gate,
 * REAL evaluation backend bound through the REAL host capability catalog; NO MOCKS.
 *
 * `evaluation.visual|primary|foreign` call OpenRouter DIRECTLY with the platform key, so they
 * never pass `performLlmRequest` and were the unmetered door: priced by the static table and
 * debited after the fact, with no admission at all. They now ask the same gate the chat asks,
 * once per provider call and before it, with the same predicate; the worst case of the call is
 * held until its debit lands. The only stand-in is the provider egress (an injected `fetchFn`
 * returning real `Response` objects), exactly as `hoja-evaluation.test.ts` does.
 *
 * RUN:  npx tsx --test src/test/billing-hoja-admission.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { CreditAdmission, insufficientCreditBody } from "../billing-gate.js";
import { computeCost } from "../billing-pricing.js";
import type { BillingStore } from "../billing-store.js";
import { createDefaultHostCapabilityCatalog } from "../capabilities/default-catalog.js";
import type { CapabilityBackend } from "../mnemosyne.js";
import { useBillingFee } from "./billing-fee-fixture.js";
import { openBilling, seedBalance } from "./billing-ledger-fixture.js";

// The numbers below are the flip's: BILLING_FEE_BPS=2000 is set together with BILLING_GATE_MODE=enforce.
// (The default regime, 15%, is pinned in billing-fee.test.ts and billing-credit-card.test.ts.)
useBillingFee(2000);

const MODEL = "google/gemini-2.5-flash";
const OWNER = "hoja-probe";
/** At the 20% markup, the House model's smallest viable call: 6,168 µUSD (hand-computed in billing-gate.test). */
const HOUSE_MIN_ADMIT = 6_168;
const ENV = ["CHOREOGRAPH_EVIDENCE_S3_URL", "OPENROUTER_API_KEY", "HOJA_L2_MODEL"] as const;

const REFLECTION = {
	schema: "sophia.hoja.wave-reflection.v1",
	hypotheses: [{ code: "save_echo", summary: "Save echo may reorder the list.", supports: ["beat-1"] }],
	prioritizedFindings: [
		{ priority: 1, title: "Check echo", detail: "Re-run with delayed typing.", evidenceSha256s: [] },
	],
	nextWave: [{ objective: "Stress save echo", modalityPairs: ["M1xM4"], operations: ["type"] }],
};

function providerResponse(promptTokens = 1_200, completionTokens = 300): Response {
	return new Response(
		JSON.stringify({
			id: "generation-credit",
			choices: [{ message: { role: "assistant", content: JSON.stringify(REFLECTION) } }],
			usage: {
				prompt_tokens: promptTokens,
				completion_tokens: completionTokens,
				total_tokens: promptTokens + completionTokens,
				prompt_tokens_details: { cached_tokens: 0 },
			},
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("Hoja evaluators: the credit gate in front of the direct OpenRouter call", { concurrency: false }, () => {
	const saved: Record<string, string | undefined> = {};
	let dir: string;
	let billing: BillingStore;
	let providerCalls = 0;
	let onProviderCall: () => Promise<void> = async () => {};

	before(async () => {
		for (const name of ENV) saved[name] = process.env[name];
		dir = mkdtempSync(join(tmpdir(), "credit-hoja-"));
		process.env.CHOREOGRAPH_EVIDENCE_S3_URL = `${pathToFileURL(join(dir, "evidence")).toString()}/`;
		process.env.OPENROUTER_API_KEY = "platform-host-secret";
		process.env.HOJA_L2_MODEL = MODEL;
		billing = await openBilling(dir);
	});

	after(() => {
		billing.close();
		rmSync(dir, { recursive: true, force: true });
		for (const name of ENV) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
	});

	async function evaluator(gate: CreditAdmission | undefined, owner: string): Promise<CapabilityBackend> {
		const catalog = createDefaultHostCapabilityCatalog({
			billing,
			...(gate ? { creditGate: gate } : {}),
			evaluationFetch: async () => {
				providerCalls += 1;
				await onProviderCall();
				return providerResponse();
			},
		});
		const bound = await catalog.bind(["evaluation.primary"], {
			graphId: "obs-hoja-credit",
			actorRef: `user:${owner}`,
			ownerUserId: owner,
			authority: { minimumRole: "viewer", dangerousOps: false },
		});
		const backend = bound.get("evaluation.primary");
		assert.ok(backend);
		return backend;
	}

	const reflect = (backend: CapabilityBackend) =>
		backend.callTool("reflect_wave", { runId: "run-1", wave: { verdicts: [{ invariant: "I4", passed: false }] } });

	it("enforce: below the bar the evaluator is refused BEFORE the provider is called", async () => {
		const owner = `${OWNER}-refused`;
		await seedBalance(billing, owner, 3_800);
		// `seedBalance` spends the seed down through one real usage row; a refused call must add none.
		const usageRowsBefore = (await billing.sumByUser(owner, 0, Date.now() + 1)).n;
		const gate = new CreditAdmission({ billing, mode: "enforce" });
		const backend = await evaluator(gate, owner);
		const callsBefore = providerCalls;

		await assert.rejects(
			() => reflect(backend),
			(error: Error) => {
				assert.match(error.message, /^insufficient_credit: /);
				assert.equal((error as { code?: string }).code, "insufficient_credit");
				assert.deepEqual((error as { body?: unknown }).body, insufficientCreditBody(3_800, HOUSE_MIN_ADMIT));
				return true;
			},
		);

		assert.equal(providerCalls, callsBefore, "the platform key was never used");
		assert.equal(
			(await billing.sumByUser(owner, 0, Date.now() + 1)).n,
			usageRowsBefore,
			"a refused call leaves no usage row",
		);
		assert.equal(gate.holds.total(owner), 0, "and no hold");
		const [row] = await billing.listGateEvents({ userId: owner });
		assert.equal(row.decision, "block");
		assert.equal(row.door, "evaluator");
		assert.equal(row.mode, "enforce");
		assert.equal(row.model, MODEL);
		assert.equal(row.balanceMicroUsd, 3_800);
		assert.equal(row.requiredMicroUsd, HOUSE_MIN_ADMIT);
	});

	it("observe: the same evaluator runs, and the dry run records would_block on the evaluator door", async () => {
		const owner = `${OWNER}-observe`;
		await seedBalance(billing, owner, 3_800);
		const gate = new CreditAdmission({ billing, mode: "observe" });
		const backend = await evaluator(gate, owner);
		const callsBefore = providerCalls;

		const result = (await reflect(backend)) as { requestId: string };
		assert.equal(providerCalls, callsBefore + 1);
		const [row] = await billing.listGateEvents({ userId: owner });
		assert.equal(row.decision, "would_block");
		assert.equal(row.door, "evaluator");
		assert.ok(result.requestId);
	});

	it("a funded evaluator holds its worst case while in flight and releases it when the debit lands", async () => {
		const owner = `${OWNER}-funded`;
		await seedBalance(billing, owner, 500_000);
		const gate = new CreditAdmission({ billing, mode: "enforce" });
		const backend = await evaluator(gate, owner);
		let heldDuringCall = 0;
		onProviderCall = async () => {
			heldDuringCall = gate.holds.total(owner);
		};

		const result = (await reflect(backend)) as { requestId: string };
		onProviderCall = async () => {};

		// The hold covered at least the output cap (8,192 tokens) priced through the same table.
		const outputCap = computeCost(MODEL, { input: 0, output: 8_192, cacheRead: 0, cacheWrite: 0 }).totalCostMicroUsd;
		assert.ok(heldDuringCall >= outputCap, `held ${heldDuringCall}, worst-case output alone is ${outputCap}`);

		const billed = await waitForEvent(billing, result.requestId);
		const usage = { input: 1_200, output: 300, cacheRead: 0, cacheWrite: 0 };
		const expected = computeCost(MODEL, usage).totalCostMicroUsd;
		assert.equal(billed.costMicroUsd, expected, "settled on actual cost, exactly as before");
		await waitUntil(() => gate.holds.total(owner) === 0);
		assert.equal((await billing.getCredit(owner))?.balanceMicroUsd, 500_000 - expected);
		assert.deepEqual(await billing.listGateEvents({ userId: owner }), []);
	});

	it("two concurrent evaluator calls against a balance that fits one: exactly one runs", async () => {
		const owner = `${OWNER}-race`;
		await seedBalance(billing, owner, 20_000);
		const gate = new CreditAdmission({ billing, mode: "enforce" });
		const backend = await evaluator(gate, owner);
		onProviderCall = () => new Promise<void>((resolve) => setTimeout(resolve, 40));

		const outcomes = await Promise.allSettled([reflect(backend), reflect(backend)]);
		onProviderCall = async () => {};

		assert.deepEqual(outcomes.map((o) => o.status).sort(), ["fulfilled", "rejected"]);
		const refusal = outcomes.find((o): o is PromiseRejectedResult => o.status === "rejected");
		assert.match(String((refusal?.reason as Error).message), /^insufficient_credit: /);
		const rows = await billing.listGateEvents({ userId: owner });
		assert.deepEqual(
			rows.map((row) => row.decision),
			["block"],
		);
	});

	it("without a credit gate the evaluator behaves exactly as it did (admission is opt-in)", async () => {
		const owner = `${OWNER}-nogate`;
		await seedBalance(billing, owner, 0);
		const backend = await evaluator(undefined, owner);
		const callsBefore = providerCalls;
		await reflect(backend);
		assert.equal(providerCalls, callsBefore + 1);
	});
});

async function waitForEvent(billing: BillingStore, eventId: string) {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		const event = await billing.getEvent(eventId);
		if (event) return event;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`billing event ${eventId} was not projected`);
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("condition was not reached in time");
}
