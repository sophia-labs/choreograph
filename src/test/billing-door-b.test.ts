/**
 * Door B: the per-call clamp in `performLlmRequest` (Sobremesa, E §4.1) — REAL spawner,
 * runtime store, billing store and credit gate; NO MOCKS.
 *
 * Door A is friendly and sits at ingress; Door B is the hard one and covers every Prime
 * workload, including scheduled and triggered runs that have no HTTP ingress. Immediately
 * before the durable budget reservation it passes the person's spendable balance in as a
 * second cost ceiling. The reservation's own binary search then shrinks the output cap to
 * what the balance can fund, and a call that cannot keep a viable output is refused. It
 * NEVER checks the unclamped reservation: a House turn reserves ~$0.10 against an actual
 * cost of $0.0008.
 *
 * What the refusal looks like was verified by reading the Prime worker, not guessed: an
 * error answer to `inference.request` ends the turn QUIETLY (`agent-loop.ts:351`) and the
 * worker completes the command as a normal, empty `done`. So the host itself writes the
 * `turn.failed` session event and settles the command as failed, or the person would see an
 * empty answer and no credit signal.
 *
 * RUN:  npx tsx --test src/test/billing-door-b.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PRIME_HOST_PROTOCOL_VERSION, type PrimeCommandResultV1 } from "../agent-runtime/host-protocol.js";
import { INSUFFICIENT_CREDIT_CODE } from "../billing-gate.js";
import { computeCost } from "../billing-pricing.js";
import { ZERO_USAGE } from "../wire-protocol.js";
import {
	activeFor,
	completion,
	contextOf,
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

const HOUSE = "google/gemini-2.5-flash";

/** Independent oracle: the largest output whose worst case (markup included) fits `ceiling`. */
function maxOutputFor(model: string, estimatedInput: number, ceiling: number, requested: number): number {
	let n = 0;
	while (
		n < requested &&
		computeCost(model, { input: estimatedInput, output: n + 1, cacheRead: 0, cacheWrite: 0 }).totalCostMicroUsd <=
			ceiling
	) {
		n += 1;
	}
	return n;
}

function failureOf(responses: WorkerResponse[]) {
	return responses.find((response) => response.ok === false)?.error;
}

function terminalChunks(responses: WorkerResponse[]) {
	return responses.filter(
		(response) => response.result?.kind === "inference.chunk" && response.result.event?.type === "done",
	);
}

describe("Door B: enforce clamps the reservation to what the balance can fund", () => {
	it("shrinks the output cap to the balance, dispatches it, settles on actual cost", async () => {
		const dispatched: Array<{ maxTokens?: number }> = [];
		await withInferenceHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedRunningRoot(runtime, { suffix: "clamp", model: HOUSE });
				await seedBalance(billing, session.ownerUserId, 20_000); // $0.02
				const responses: WorkerResponse[] = [];

				await hostInference(spawner, session, activeFor(session), responseChild(responses), "req-clamp");

				const [operationId] = await inferenceOperationIds(runtime, session.sessionId);
				const reservation = await runtime.readAgentSessionInferenceReservation(operationId);
				assert.ok(reservation);
				const expected = maxOutputFor(HOUSE, reservation.estimated_input_tokens, 20_000, 32_000);
				assert.ok(expected >= 256 && expected < 32_000, `House at $0.02 runs with a clamped output (${expected})`);
				assert.equal(reservation.max_output_tokens, expected, "the clamp is exactly what an independent scan says");
				assert.equal(
					reservation.budget.costUsdMicros,
					computeCost(HOUSE, {
						input: reservation.estimated_input_tokens,
						output: expected,
						cacheRead: 0,
						cacheWrite: 0,
					}).totalCostMicroUsd,
				);
				assert.ok(reservation.budget.costUsdMicros <= 20_000, "the reserved worst case fits the balance");
				assert.equal(dispatched[0]?.maxTokens, expected, "the provider was asked for the clamped cap");
				assert.equal(terminalChunks(responses).length, 1, "the call ran to completion");

				// Settlement debits ACTUAL cost, never the reservation.
				const billed = await waitForBillingEvent(billing, operationId);
				assert.equal(
					billed.costMicroUsd,
					computeCost(HOUSE, { input: 2_228, output: 28, cacheRead: 0, cacheWrite: 0 }).totalCostMicroUsd,
				);
				assert.equal((await billing.getCredit(session.ownerUserId))?.balanceMicroUsd, 20_000 - billed.costMicroUsd);

				const [row] = await billing.listGateEvents({ userId: session.ownerUserId });
				assert.equal(row.decision, "clamp");
				assert.equal(row.door, "call");
				assert.equal(row.mode, "enforce");
				assert.equal(row.model, HOUSE);
				assert.equal(row.balanceMicroUsd, 20_000);
			},
			{
				llmProxy: async function* (model, _context) {
					dispatched.push(model as { maxTokens?: number });
					yield* completion(2_228, 28)();
				},
			},
		);
	});

	it("a balance that funds the full worst case is not clamped and leaves no gate row", async () => {
		await withInferenceHarness(
			async ({ runtime, billing, spawner, gate }) => {
				const session = await seedRunningRoot(runtime, { suffix: "roomy", model: HOUSE });
				await seedBalance(billing, session.ownerUserId, 900_000);
				await hostInference(spawner, session, activeFor(session), responseChild([]), "req-roomy");
				const [operationId] = await inferenceOperationIds(runtime, session.sessionId);
				const reservation = await runtime.readAgentSessionInferenceReservation(operationId);
				assert.equal(reservation?.max_output_tokens, 32_000, "the reservation is exactly what it always was");
				assert.deepEqual(await billing.listGateEvents({ userId: session.ownerUserId }), []);
				await gate?.flushCounters();
				const counts = await billing.gateDailyCounts();
				assert.equal(counts.find((c) => c.door === "call" && c.decision === "allow")?.n, 1);
			},
			{ llmProxy: completion(2_228, 28) },
		);
	});
});

describe("Door B: enforce refuses when the balance cannot keep a viable output", () => {
	it("answers the worker with the coded budget error, reserves nothing and never calls the provider", async () => {
		const dispatched: unknown[] = [];
		await withInferenceHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedRunningRoot(runtime, { suffix: "refuse", model: HOUSE });
				await seedBalance(billing, session.ownerUserId, 100);
				// `seedBalance` spends the seed down through one real usage row; a refused call must add none.
				const usageRowsBefore = (await billing.sumByUser(session.ownerUserId, 0, Date.now() + 1)).n;
				const responses: WorkerResponse[] = [];

				await hostInference(spawner, session, activeFor(session), responseChild(responses), "req-refuse");

				const failure = failureOf(responses);
				assert.ok(failure, "the worker gets an error answer");
				assert.match(failure.message, /^insufficient_credit: /);
				assert.equal(failure.code, "inference_credit_exhausted");
				assert.equal(failure.class, "budget");
				assert.equal(failure.retryable, false, "a retry cannot fix an empty balance");
				assert.deepEqual(await inferenceOperationIds(runtime, session.sessionId), [], "no reservation exists");
				assert.equal(dispatched.length, 0, "the provider was never called");
				assert.equal(
					(await billing.sumByUser(session.ownerUserId, 0, Date.now() + 1)).n,
					usageRowsBefore,
					"nothing was billed",
				);
				assert.equal(
					(await billing.getCredit(session.ownerUserId))?.balanceMicroUsd,
					100,
					"the balance is untouched",
				);

				const [row] = await billing.listGateEvents({ userId: session.ownerUserId });
				assert.equal(row.decision, "block");
				assert.equal(row.door, "call");
				assert.equal(row.mode, "enforce");
				assert.equal(row.balanceMicroUsd, 100);
				assert.ok((row.requiredMicroUsd ?? 0) > 100);
			},
			{
				llmProxy: async function* (model) {
					dispatched.push(model);
					yield* completion(1, 1)();
				},
			},
		);
	});

	it("writes the turn.failed the Prime worker never will, so the SPA can key on insufficient_credit", async () => {
		await withInferenceHarness(async ({ runtime, billing, spawner }) => {
			const session = await seedRunningRoot(runtime, { suffix: "turn-failed", model: HOUSE });
			await seedBalance(billing, session.ownerUserId, 100);

			await hostInference(spawner, session, activeFor(session), responseChild([]), "req-turn-failed");

			const failed = (await runtime.listAgentSessionEvents(session.sessionId)).filter(
				(e) => e.type === "turn.failed",
			);
			assert.equal(failed.length, 1);
			const payload = failed[0].payload as {
				schema: string;
				sourceType: string;
				value: { message: string; code: string; balanceMicroUsd: number; requiredMicroUsd: number };
			};
			assert.equal(payload.schema, "sophia.agent-session-semantic-event.v1");
			assert.equal(payload.sourceType, "host.credit_gate");
			assert.match(payload.value.message, /^insufficient_credit: /);
			assert.equal(payload.value.code, INSUFFICIENT_CREDIT_CODE);
			assert.equal(payload.value.balanceMicroUsd, 100);
			assert.ok(payload.value.requiredMicroUsd > 100);
		});
	});

	it("the session survives: not faulted, and it runs again as soon as the balance is lifted", async () => {
		await withInferenceHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedRunningRoot(runtime, { suffix: "survives", model: HOUSE });
				await seedBalance(billing, session.ownerUserId, 100);
				const before = await runtime.readAgentSession(session.sessionId);
				const active = activeFor(session);

				const refused: WorkerResponse[] = [];
				await hostInference(spawner, session, active, responseChild(refused), "req-survives-1");
				assert.ok(failureOf(refused));
				const after = await runtime.readAgentSession(session.sessionId);
				assert.equal(after?.lifecycle_state, before?.lifecycle_state, "a refusal is not a lifecycle event");
				assert.notEqual(after?.lifecycle_state, "faulted");
				assert.equal((await runtime.readAgentMaterialization(session.sessionId, 0))?.state, "running");

				// The person adds credits (a real settled grant); the SAME session, the SAME body, answers.
				await billing.recordGrantAndCredit(
					{
						eventId: "evt_survives",
						eventType: "checkout.session.completed",
						stripeCreated: 1,
						apiVersion: null,
						livemode: 1,
						stripeCustomerId: "cus_survives",
						payloadSha256: null,
					},
					{
						grantId: "cs:cs_survives",
						userId: session.ownerUserId,
						stripeCustomerId: "cus_survives",
						sourceEventId: "evt_survives",
						stripeObject: "checkout_session",
						amountMicroUsd: 5_000_000,
						currency: "usd",
						livemode: 1,
					},
				);
				const resumed: WorkerResponse[] = [];
				await hostInference(spawner, session, active, responseChild(resumed), "req-survives-2");
				assert.equal(failureOf(resumed), undefined);
				assert.equal(terminalChunks(resumed).length, 1);
				assert.equal((await inferenceOperationIds(runtime, session.sessionId)).length, 1);
			},
			{ llmProxy: completion(2_228, 28) },
		);
	});

	it("fails the command that was running with the coded error, and only that one", async () => {
		await withInferenceHarness(async ({ runtime, billing, spawner }) => {
			const session = await seedRunningRoot(runtime, { suffix: "command", model: HOUSE });
			await seedBalance(billing, session.ownerUserId, 100);
			const submit = async (id: string) => {
				const submitted = await runtime.submitAgentSessionCommand(session.sessionId, {
					commandId: id,
					idempotencyKey: id,
					clientId: "client-1",
					name: "follow_up",
					payload: { text: "and then?" },
					now: 10,
				});
				assert.equal(submitted?.accepted, true);
			};
			const resultFor = (id: string): PrimeCommandResultV1 => ({
				protocol: PRIME_HOST_PROTOCOL_VERSION,
				messageId: `worker.result:${session.sandboxId}:0:${id}`,
				sessionId: session.sessionId,
				sandboxId: session.sandboxId,
				generation: 0,
				correlationId: id,
				direction: "worker_to_host",
				kind: "result",
				workerSequence: 1,
				name: "command.result",
				commandId: id,
				// What the Prime worker reports after a refused model call: the turn ended quietly, so "completed".
				payload: { commandId: id, commandName: "input.follow_up", status: "completed" },
			});
			const settle = (id: string, active: ReturnType<typeof activeFor>) =>
				(
					spawner as unknown as {
						handleCommandResult(message: PrimeCommandResultV1, active: unknown): Promise<void>;
					}
				).handleCommandResult(resultFor(id), active);

			const active = activeFor(session);
			await submit("cmd-refused");
			await runtime.claimAgentSessionCommandsForDelivery(session.sessionId, 0, 11);
			await hostInference(spawner, session, active, responseChild([]), "req-command-1");
			await settle("cmd-refused", active);

			const refused = await runtime.readAgentSessionCommand("cmd-refused");
			assert.equal(refused?.state, "failed", "the worker said completed; the host knows better");
			assert.match(refused?.error ?? "", /^insufficient_credit: /);
			const commandEvents = (await runtime.listAgentSessionEvents(session.sessionId)).filter(
				(e) => e.type === "command.failed",
			);
			assert.equal(commandEvents.length, 1, "the SPA's command-keyed wait sees a terminal event");
			assert.match(String((commandEvents[0].payload as { error?: string }).error), /^insufficient_credit: /);

			// The refusal is consumed by the command it failed: the next command's result is untouched.
			await submit("cmd-fine");
			await runtime.claimAgentSessionCommandsForDelivery(session.sessionId, 0, 12);
			await settle("cmd-fine", active);
			assert.equal((await runtime.readAgentSessionCommand("cmd-fine"))?.state, "completed");
		});
	});
});

describe("Door B: observe computes the same verdict and applies none of it", () => {
	it("reserves exactly as before the gate existed and records would_block", async () => {
		await withInferenceHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedRunningRoot(runtime, { suffix: "observe-block", model: HOUSE });
				await seedBalance(billing, session.ownerUserId, 100);
				const responses: WorkerResponse[] = [];

				await hostInference(spawner, session, activeFor(session), responseChild(responses), "req-observe");

				assert.equal(failureOf(responses), undefined, "observe never refuses");
				const [operationId] = await inferenceOperationIds(runtime, session.sessionId);
				const reservation = await runtime.readAgentSessionInferenceReservation(operationId);
				assert.equal(reservation?.max_output_tokens, 32_000, "the reservation is not clamped");
				const [row] = await billing.listGateEvents({ userId: session.ownerUserId });
				assert.equal(row.decision, "would_block");
				assert.equal(row.mode, "observe");
				assert.equal(row.door, "call");
				assert.equal(row.balanceMicroUsd, 100);
				assert.equal(
					(await runtime.listAgentSessionEvents(session.sessionId)).filter((e) => e.type === "turn.failed").length,
					0,
					"no credit failure is surfaced in the dry run",
				);
			},
			{ gate: "observe", llmProxy: completion(2_228, 28) },
		);
	});

	it("records would_clamp for a call that enforce would have shrunk, and does not shrink it", async () => {
		await withInferenceHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedRunningRoot(runtime, { suffix: "observe-clamp", model: HOUSE });
				await seedBalance(billing, session.ownerUserId, 20_000);
				await hostInference(spawner, session, activeFor(session), responseChild([]), "req-observe-clamp");
				const [operationId] = await inferenceOperationIds(runtime, session.sessionId);
				const reservation = await runtime.readAgentSessionInferenceReservation(operationId);
				assert.equal(reservation?.max_output_tokens, 32_000);
				const [row] = await billing.listGateEvents({ userId: session.ownerUserId });
				assert.equal(row.decision, "would_clamp");
				assert.equal(row.mode, "observe");
			},
			{ gate: "observe", llmProxy: completion(2_228, 28) },
		);
	});
});

describe("Door B: who is never clamped", () => {
	it("own-key (BYOK) funding is not gated, at any balance", async () => {
		await withInferenceHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedRunningRoot(runtime, { suffix: "byok", model: HOUSE });
				await seedBalance(billing, session.ownerUserId, 0);
				const responses: WorkerResponse[] = [];
				await hostInference(spawner, session, activeFor(session), responseChild(responses), "req-byok");
				assert.equal(failureOf(responses), undefined);
				const [operationId] = await inferenceOperationIds(runtime, session.sessionId);
				assert.equal((await runtime.readAgentSessionInferenceReservation(operationId))?.max_output_tokens, 32_000);
				assert.deepEqual(await billing.listGateEvents({ userId: session.ownerUserId }), []);
			},
			{
				openRouterUserInferenceEnabled: true,
				openRouterKeyStore: {
					get: async () => "sk-or-v1-fixtureOwnerAAAAAAAA",
					put: async () => {},
					delete: async () => {},
				},
				llmProxy: completion(2_228, 28),
			},
		);
	});

	it("host-internal mock inference is not gated", async () => {
		await withInferenceHarness(async ({ runtime, billing, spawner }) => {
			const session = await seedRunningRoot(runtime, { suffix: "mock", model: "mock:done" });
			await seedBalance(billing, session.ownerUserId, 0);
			const responses: WorkerResponse[] = [];
			await hostInference(spawner, session, activeFor(session), responseChild(responses), "req-mock", {
				context: contextOf(100),
			});
			assert.equal(failureOf(responses), undefined);
			assert.equal((await inferenceOperationIds(runtime, session.sessionId)).length, 1);
			assert.deepEqual(await billing.listGateEvents({ userId: session.ownerUserId }), []);
		});
	});

	it("a spawner without a credit gate reserves exactly as it did (nothing consults the ledger)", async () => {
		await withInferenceHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedRunningRoot(runtime, { suffix: "nogate", model: HOUSE });
				await seedBalance(billing, session.ownerUserId, 0);
				const responses: WorkerResponse[] = [];
				await hostInference(spawner, session, activeFor(session), responseChild(responses), "req-nogate");
				assert.equal(failureOf(responses), undefined);
				const [operationId] = await inferenceOperationIds(runtime, session.sessionId);
				assert.equal((await runtime.readAgentSessionInferenceReservation(operationId))?.max_output_tokens, 32_000);
			},
			{ gate: "none", llmProxy: completion(2_228, 28) },
		);
	});
});

describe("Door B: a provider that cannot be paid is not the person's empty balance", () => {
	it("rewrites an upstream 402 to provider_unavailable, never insufficient_credit, and does not bill it", async () => {
		await withInferenceHarness(
			async ({ runtime, billing, spawner, logLines }) => {
				const session = await seedRunningRoot(runtime, { suffix: "upstream-402", model: HOUSE });
				await seedBalance(billing, session.ownerUserId, 500_000);
				const responses: WorkerResponse[] = [];

				await hostInference(spawner, session, activeFor(session), responseChild(responses), "req-402");

				const failure = failureOf(responses);
				assert.ok(failure);
				assert.match(failure.message, /^provider_unavailable: /);
				assert.doesNotMatch(failure.message, /insufficient_credit/i);
				assert.equal(failure.code, "provider_unavailable");
				assert.equal(failure.retryable, true, "the provider outage is transient from the person's side");
				const [operationId] = await inferenceOperationIds(runtime, session.sessionId);
				await waitFor(async () => (await billing.getEvent(operationId)) !== undefined, "settled event");
				assert.equal(
					(await billing.getEvent(operationId))?.costMicroUsd,
					0,
					"an unpaid provider call costs nothing",
				);
				assert.equal(
					(await billing.getCredit(session.ownerUserId))?.balanceMicroUsd,
					500_000,
					"the person's balance is untouched",
				);
				const rows = await billing.listGateEvents({
					userId: session.ownerUserId,
					decision: "provider_unavailable",
				});
				assert.equal(rows.length, 1);
				assert.equal(rows[0].door, "call");
				assert.ok(logLines.some((line) => line.includes("ALARM") && line.includes("provider_payment_failure")));
			},
			{
				llmProxy: async function* () {
					yield { type: "start" };
					yield {
						type: "error",
						reason: "error",
						errorMessage: "402 Insufficient credits. Add more using https://openrouter.ai/settings/credits",
						usage: ZERO_USAGE,
					};
				},
			},
		);
	});

	it("leaves every other provider error exactly as it was", async () => {
		await withInferenceHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedRunningRoot(runtime, { suffix: "upstream-500", model: HOUSE });
				await seedBalance(billing, session.ownerUserId, 500_000);
				const responses: WorkerResponse[] = [];
				await hostInference(spawner, session, activeFor(session), responseChild(responses), "req-500");
				assert.equal(failureOf(responses)?.message, "502 Bad gateway from the upstream provider");
				assert.deepEqual(await billing.listGateEvents({ userId: session.ownerUserId }), []);
			},
			{
				llmProxy: async function* () {
					yield { type: "start" };
					yield {
						type: "error",
						reason: "error",
						errorMessage: "502 Bad gateway from the upstream provider",
						usage: ZERO_USAGE,
					};
				},
			},
		);
	});
});
