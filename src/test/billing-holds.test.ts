/**
 * Holds (Sobremesa, E §4.2) — REAL substrate, NO MOCKS.
 *
 * Admission is not atomic with the debit: two calls can read the same balance, and the outbox
 * adds a window between "the call ended" and "the debit landed". A HOLD closes both. It is an
 * in-memory, per-person record of what a reserved call could still cost, created when the
 * reservation is made and released when the DEBIT IS DELIVERED, not when the call ends:
 * releasing at settle would reopen exactly the window it exists to close. One Choreograph
 * process today, so memory is enough; a restart drops holds, and because an undelivered outbox
 * row still debits on the next drain, spend is never lost, the worst case is ONE extra call.
 *
 * RUN:  npx tsx --test src/test/billing-holds.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	type AdmittedReservation,
	type CallAdmissionInput,
	CreditAdmission,
	CreditHolds,
	HOLD_TTL_MS,
	insufficientCreditBody,
} from "../billing-gate.js";
import { BillingStore } from "../billing-store.js";
import { useBillingFee } from "./billing-fee-fixture.js";
import {
	activeFor,
	completion,
	hostInference,
	inferenceOperationIds,
	responseChild,
	seedRunningRoot,
	type WorkerResponse,
	waitFor,
	waitForBillingEvent,
	withInferenceHarness,
} from "./billing-inference-fixture.js";
import { seedBalance } from "./billing-ledger-fixture.js";

// The numbers below are the flip's: BILLING_FEE_BPS=2000 is set together with BILLING_GATE_MODE=enforce.
// (The default regime, 15%, is pinned in billing-fee.test.ts and billing-credit-card.test.ts.)
useBillingFee(2000);

const HOUSE = "google/gemini-2.5-flash";

// ─── CreditHolds itself ────────────────────────────────────────────────────

describe("CreditHolds: what a reserved call could still cost", () => {
	it("adds up per person and never leaks across people", () => {
		const holds = new CreditHolds();
		holds.set("a", "op-1", 5_000);
		holds.set("a", "op-2", 2_500);
		holds.set("b", "op-3", 900);
		assert.equal(holds.total("a"), 7_500);
		assert.equal(holds.total("b"), 900);
		assert.equal(holds.total("nobody"), 0);
		assert.equal(holds.size, 3);
	});

	it("releases exactly the operation named, once", () => {
		const holds = new CreditHolds();
		holds.set("a", "op-1", 5_000);
		holds.set("a", "op-2", 2_500);
		assert.equal(holds.release("op-1"), true);
		assert.equal(holds.total("a"), 2_500);
		assert.equal(holds.release("op-1"), false, "a second release is a no-op");
		assert.equal(holds.release("never-held"), false);
		assert.equal(holds.release("op-2"), true);
		assert.equal(holds.total("a"), 0);
		assert.equal(holds.size, 0);
	});

	it("re-registering an operation replaces its hold instead of doubling it", () => {
		const holds = new CreditHolds();
		holds.set("a", "op-1", 5_000);
		holds.set("a", "op-1", 3_000);
		assert.equal(holds.total("a"), 3_000);
		assert.equal(holds.size, 1);
	});

	it("refuses a hold that is not a non-negative integer of µUSD", () => {
		const holds = new CreditHolds();
		for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			assert.throws(() => holds.set("a", "op", bad), /integer/);
		}
		assert.equal(holds.size, 0);
		holds.set("a", "op-zero", 0);
		assert.equal(holds.total("a"), 0);
	});

	it("forgets a hold older than its TTL, so a leaked one cannot lock a person out forever", () => {
		let now = 1_000_000;
		const holds = new CreditHolds({ now: () => now });
		holds.set("a", "op-old", 5_000);
		now += HOLD_TTL_MS - 1;
		holds.set("a", "op-new", 700);
		assert.equal(holds.total("a"), 5_700, "inside the TTL both count");
		now += 2;
		assert.equal(holds.total("a"), 700, "the old one has expired");
		assert.equal(holds.release("op-old"), false, "and is gone");
		assert.equal(HOLD_TTL_MS, 30 * 60 * 1000);
	});
});

// ─── The gate: the lock and the ceiling ────────────────────────────────────

async function gateHarness() {
	const dir = mkdtempSync(join(tmpdir(), "credit-holds-"));
	after(() => rmSync(dir, { recursive: true, force: true }));
	const store = new BillingStore(join(dir, "billing.sqlite"));
	await store.init();
	after(() => store.close());
	const lines: string[] = [];
	const gate = (mode: "observe" | "enforce" = "enforce") =>
		new CreditAdmission({ billing: store, mode, now: () => 1_790_000_000_000, log: (l) => lines.push(l) });
	return { store, gate, lines };
}

function callInput(userId: string, over: Partial<CallAdmissionInput> = {}): CallAdmissionInput {
	return {
		userId,
		provider: "openrouter",
		model: HOUSE,
		fundingSource: "platform",
		sessionId: "ags-holds",
		estimatedInputTokens: 15_000,
		requestedOutputTokens: 32_000,
		...over,
	};
}

function reserved(operationId: string, costUsdMicros: number, applied = true): AdmittedReservation {
	return { applied, reservation: { operation_id: operationId, budget: { costUsdMicros } } };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("Door B: one reservation at a time per person, and each sees the last one's hold", () => {
	it("serializes a person's calls, and the second is offered balance minus the first's hold", async () => {
		const h = await gateHarness();
		await seedBalance(h.store, "u", 100_000);
		const gate = h.gate();
		const order: string[] = [];
		const ceilings: Array<number | undefined> = [];
		let unblockFirst!: () => void;
		const firstMayFinish = new Promise<void>((resolve) => {
			unblockFirst = resolve;
		});

		const first = gate.admitCall(callInput("u"), async (credit) => {
			order.push("first:start");
			ceilings.push(credit.ceilingCostUsdMicros);
			await firstMayFinish;
			order.push("first:end");
			return reserved("op-1", 70_000);
		});
		const second = gate.admitCall(callInput("u"), async (credit) => {
			order.push("second:start");
			ceilings.push(credit.ceilingCostUsdMicros);
			return reserved("op-2", 10_000);
		});
		await sleep(25); // give the second every chance to start too early
		assert.deepEqual(order, ["first:start"], "the second waits for the first to register its hold");
		unblockFirst();
		await Promise.all([first, second]);

		assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
		assert.deepEqual(ceilings, [100_000, 30_000], "the second is offered 100,000 - the first's 70,000 hold");
		assert.equal(gate.holds.total("u"), 80_000);
		gate.releaseHold("op-1");
		assert.equal(gate.holds.total("u"), 10_000);
		gate.releaseHold("op-2");
		assert.equal(gate.holds.total("u"), 0);
	});

	it("does not make different people wait for each other", async () => {
		const h = await gateHarness();
		await seedBalance(h.store, "slow", 100_000);
		await seedBalance(h.store, "quick", 100_000);
		const gate = h.gate();
		let unblock!: () => void;
		const gateOpen = new Promise<void>((resolve) => {
			unblock = resolve;
		});
		const slow = gate.admitCall(callInput("slow"), async () => {
			await gateOpen;
			return reserved("op-slow", 1_000);
		});
		const quick = await Promise.race([
			gate.admitCall(callInput("quick"), async () => reserved("op-quick", 1_000)).then(() => "quick"),
			sleep(500).then(() => "timeout"),
		]);
		assert.equal(quick, "quick", "another person's call is not queued behind a slow reservation");
		unblock();
		await slow;
	});

	it("a reservation that throws frees the lock and leaves no hold", async () => {
		const h = await gateHarness();
		await seedBalance(h.store, "u", 100_000);
		const gate = h.gate();
		await assert.rejects(
			gate.admitCall(callInput("u"), async () => {
				throw new Error("the ledger is on fire");
			}),
			/on fire/,
		);
		assert.equal(gate.holds.total("u"), 0);
		const next = await gate.admitCall(callInput("u"), async () => reserved("op-after", 5_000));
		assert.equal(next.reservation.operation_id, "op-after", "the lock was released");
		assert.equal(gate.holds.total("u"), 5_000);
	});

	it("a replayed reservation (applied: false) creates no second hold", async () => {
		const h = await gateHarness();
		await seedBalance(h.store, "u", 100_000);
		const gate = h.gate();
		await gate.admitCall(callInput("u"), async () => reserved("op-1", 5_000));
		await gate.admitCall(callInput("u"), async () => reserved("op-1", 5_000, false));
		assert.equal(gate.holds.total("u"), 5_000);
	});

	it("own-key funding takes no lock, no ceiling and no hold", async () => {
		const h = await gateHarness();
		await seedBalance(h.store, "byok", 0);
		const gate = h.gate();
		let seen: { ceilingCostUsdMicros?: number; enforce: boolean } | undefined;
		await gate.admitCall(callInput("byok", { fundingSource: "user" }), async (credit) => {
			seen = credit;
			return reserved("op-byok", 9_000);
		});
		assert.deepEqual(seen, { enforce: false });
		assert.equal(gate.holds.total("byok"), 0);
	});

	it("a shared CreditHolds is one ledger of holds for every door that reserves", async () => {
		const h = await gateHarness();
		await seedBalance(h.store, "u", 100_000);
		const holds = new CreditHolds();
		const one = new CreditAdmission({ billing: h.store, mode: "enforce", holds });
		const two = new CreditAdmission({ billing: h.store, mode: "enforce", holds });
		await one.admitCall(callInput("u"), async () => reserved("op-shared", 60_000));
		assert.equal(two.holds.total("u"), 60_000);
		let ceiling: number | undefined;
		await two.admitCall(callInput("u"), async (credit) => {
			ceiling = credit.ceilingCostUsdMicros;
			return reserved("op-shared-2", 1_000);
		});
		assert.equal(ceiling, 40_000);
	});
});

describe("Door A sees the holds too", () => {
	it("refuses a person whose balance is spoken for, and admits them again once the hold is released", async () => {
		const h = await gateHarness();
		await seedBalance(h.store, "u", 50_000);
		const gate = h.gate();
		const voice = { provider: "openrouter", model: HOUSE } as const;
		assert.deepEqual(await gate.admitIngress({ door: "ingress.command", userId: "u", ...voice }), { allow: true });

		gate.holds.set("u", "op-in-flight", 45_000);
		const refused = await gate.admitIngress({ door: "ingress.command", userId: "u", ...voice });
		assert.equal(refused.allow, false);
		if (!refused.allow) {
			// The person is told what is SPENDABLE right now, so the numbers in the refusal are consistent.
			assert.deepEqual(refused.body, insufficientCreditBody(5_000, 6_168));
		}
		const [row] = await h.store.listGateEvents({ userId: "u" });
		assert.match(row.reason ?? "", /balance=50000 holds=45000/);

		gate.releaseHold("op-in-flight");
		assert.deepEqual(await gate.admitIngress({ door: "ingress.command", userId: "u", ...voice }), { allow: true });
	});
});

// ─── The spawner: real reservations, real outbox ───────────────────────────

function failureOf(responses: WorkerResponse[]) {
	return responses.find((response) => response.ok === false)?.error;
}

describe("Holds through the spawner: two concurrent calls against a balance that fits one", () => {
	it("admits exactly one, clamped to the balance, and refuses the other", async () => {
		await withInferenceHarness(
			async ({ runtime, billing, spawner, gate }) => {
				const session = await seedRunningRoot(runtime, { suffix: "race", model: HOUSE });
				await seedBalance(billing, session.ownerUserId, 20_000);
				const a: WorkerResponse[] = [];
				const b: WorkerResponse[] = [];
				const active = activeFor(session);

				await Promise.all([
					hostInference(spawner, session, active, responseChild(a), "req-race-a"),
					hostInference(spawner, session, active, responseChild(b), "req-race-b"),
				]);

				const outcomes = [a, b].map((responses) => (failureOf(responses) ? "refused" : "admitted")).sort();
				assert.deepEqual(outcomes, ["admitted", "refused"], "the balance funded exactly one of them");
				const operations = await inferenceOperationIds(runtime, session.sessionId);
				assert.equal(operations.length, 1);
				const reservation = await runtime.readAgentSessionInferenceReservation(operations[0]);
				assert.equal(gate?.holds.total(session.ownerUserId), reservation?.budget.costUsdMicros);
				const decisions = (await billing.listGateEvents({ userId: session.ownerUserId }))
					.map((row) => row.decision)
					.sort();
				assert.deepEqual(decisions, ["block", "clamp"]);
			},
			{ automaticBilling: false, llmProxy: completion(2_228, 28) },
		);
	});
});

describe("Holds through the spawner: released when the debit is delivered, not when the call ends", () => {
	it("keeps the hold after the call has ended while no debit has landed, and the next call feels it", async () => {
		await withInferenceHarness(
			async ({ runtime, billing, spawner, gate }) => {
				const session = await seedRunningRoot(runtime, { suffix: "undelivered", model: HOUSE });
				await seedBalance(billing, session.ownerUserId, 20_000);
				const active = activeFor(session);

				const first: WorkerResponse[] = [];
				await hostInference(spawner, session, active, responseChild(first), "req-undelivered-1");
				assert.equal(failureOf(first), undefined, "the first call ran to completion");
				const [operationId] = await inferenceOperationIds(runtime, session.sessionId);
				assert.equal((await runtime.readAgentSessionInferenceReservation(operationId))?.state, "settled");
				const stillHeld = gate?.holds.total(session.ownerUserId) ?? 0;
				assert.ok(stillHeld > 0, "settled, but the debit has not landed: still held");

				const second: WorkerResponse[] = [];
				await hostInference(spawner, session, active, responseChild(second), "req-undelivered-2");
				assert.ok(failureOf(second), "so the next call cannot spend the same money twice");
			},
			{ automaticBilling: false, llmProxy: completion(2_228, 28) },
		);
	});

	it("releases the hold once the debit is delivered, and the person can spend again", async () => {
		await withInferenceHarness(
			async ({ runtime, billing, spawner, gate }) => {
				const session = await seedRunningRoot(runtime, { suffix: "delivered", model: HOUSE });
				await seedBalance(billing, session.ownerUserId, 500_000);
				const active = activeFor(session);

				await hostInference(spawner, session, active, responseChild([]), "req-delivered-1");
				const [operationId] = await inferenceOperationIds(runtime, session.sessionId);
				const billed = await waitForBillingEvent(billing, operationId);
				await waitFor(() => gate?.holds.total(session.ownerUserId) === 0, "the hold was released on delivery");
				assert.equal(gate?.holds.size, 0);
				const credit = await billing.getCredit(session.ownerUserId);
				assert.equal(credit?.balanceMicroUsd, 500_000 - billed.costMicroUsd);

				const again: WorkerResponse[] = [];
				await hostInference(spawner, session, active, responseChild(again), "req-delivered-2");
				assert.equal(failureOf(again), undefined);
			},
			{ llmProxy: completion(2_228, 28) },
		);
	});

	it("releases the hold when the provider call dies mid-flight (the reservation goes indeterminate)", async () => {
		await withInferenceHarness(
			async ({ runtime, billing, spawner, gate }) => {
				const session = await seedRunningRoot(runtime, { suffix: "indeterminate", model: HOUSE });
				await seedBalance(billing, session.ownerUserId, 20_000);
				const responses: WorkerResponse[] = [];
				await hostInference(spawner, session, activeFor(session), responseChild(responses), "req-dies");
				assert.ok(failureOf(responses));
				const [operationId] = await inferenceOperationIds(runtime, session.sessionId);
				assert.equal((await runtime.readAgentSessionInferenceReservation(operationId))?.state, "indeterminate");
				assert.equal(gate?.holds.total(session.ownerUserId), 0, "no debit will ever follow, so nothing is held");
				assert.equal((await billing.getCredit(session.ownerUserId))?.balanceMicroUsd, 20_000);
			},
			{
				automaticBilling: false,
				llmProxy: async function* () {
					yield { type: "start" };
					throw new Error("socket hang up");
				},
			},
		);
	});
});

describe("Holds through the spawner: a restart forgets them, and that costs at most one extra call", () => {
	it("reopens exactly one more call for the person, then holds again", async () => {
		await withInferenceHarness(
			async ({ runtime, billing, spawner, spawnerWithGate }) => {
				const session = await seedRunningRoot(runtime, { suffix: "restart", model: HOUSE });
				await seedBalance(billing, session.ownerUserId, 20_000);
				const active = activeFor(session);

				await hostInference(spawner, session, active, responseChild([]), "req-restart-1");
				const beforeRestart: WorkerResponse[] = [];
				await hostInference(spawner, session, active, responseChild(beforeRestart), "req-restart-2");
				assert.ok(failureOf(beforeRestart), "before the restart the hold refuses the second call");

				// The host restarts: holds (memory) are gone; the undelivered outbox row and the ledger are not.
				const gateAfter = new CreditAdmission({ billing, mode: "enforce" });
				const spawnerAfter = await spawnerWithGate(gateAfter);
				const reopened: WorkerResponse[] = [];
				await hostInference(spawnerAfter, session, active, responseChild(reopened), "req-restart-3");
				assert.equal(failureOf(reopened), undefined, "the forgotten hold lets one more call through");
				const again: WorkerResponse[] = [];
				await hostInference(spawnerAfter, session, active, responseChild(again), "req-restart-4");
				assert.ok(failureOf(again), "and no more than one: the new process holds again");
			},
			{ automaticBilling: false, llmProxy: completion(2_228, 28) },
		);
	});
});
