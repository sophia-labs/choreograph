import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createClient } from "@libsql/client";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { computeCost, PRICING_VERSION } from "../billing-pricing.js";
import { AgentSessionBudgetFault, WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

const SESSION_MODEL = "openai/gpt-5-mini";

describe("Agent Session budget ledger", () => {
	it("upgrades an old pending operation without changing its platform digest or funding", async () => {
		const directory = mkdtempSync(join(tmpdir(), "byok-old-schema-"));
		const path = join(directory, "runtime.sqlite");
		let runtime = new WorkflowRuntimeStore(path);
		try {
			await runtime.init();
			const session = await seedRunningSession(runtime);
			const input = inferenceReservation(session, "old-pending", 10);
			const reserved = await runtime.reserveAgentSessionInferenceBudget(session.sessionId, input);
			runtime.close();
			const legacy = createClient({ url: `file:${path}` });
			try {
				await legacy.execute("ALTER TABLE agent_session_inference_reservations DROP COLUMN funding_source");
			} finally {
				legacy.close();
			}
			runtime = new WorkflowRuntimeStore(path);
			await runtime.init();
			const restored = await runtime.readAgentSessionInferenceReservation(reserved.reservation.operation_id);
			assert.equal(restored?.funding_source, "platform");
			assert.equal(restored?.reservation_digest, reserved.reservation.reservation_digest);
			assert.equal((await runtime.reserveAgentSessionInferenceBudget(session.sessionId, input)).applied, false);
			const billingEvent = billingEventFor(reserved.reservation, 11, { inputTokens: 10, outputTokens: 10 });
			assert.equal(Object.hasOwn(billingEvent, "fundingSource"), false);
			await runtime.settleAgentSessionInferenceBudget(reserved.reservation.operation_id, {
				...inferenceFence(session, input, 11),
				usage: { turns: 1, wallTimeMs: 1, tokens: 20, costUsdMicros: billingEvent.costMicroUsd, artifactBytes: 0 },
				billingEvent,
			});
			const outbox = await runtime.claimAgentSessionInferenceBillingOutbox({
				consumer: "legacy-reader",
				leaseMs: 10,
				now: 12,
			});
			assert.equal(outbox?.payload.fundingSource, undefined);
			await assert.rejects(
				runtime.reserveAgentSessionInferenceBudget(session.sessionId, { ...input, fundingSource: "user" }),
				/different reservation evidence/,
			);
		} finally {
			runtime.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("pins funding across reservation/settlement replays and preserves historical platform semantics", async () => {
		await withRuntime(async (runtime) => {
			const session = await seedRunningSession(runtime);
			const input = { ...inferenceReservation(session, "byok-pinned", 10), fundingSource: "user" as const };
			const reserved = await runtime.reserveAgentSessionInferenceBudget(session.sessionId, input);
			assert.equal(reserved.reservation.funding_source, "user");
			assert.equal((await runtime.reserveAgentSessionInferenceBudget(session.sessionId, input)).applied, false);
			await assert.rejects(
				runtime.reserveAgentSessionInferenceBudget(session.sessionId, { ...input, fundingSource: "platform" }),
				/different reservation evidence/,
			);
			const billingEvent = {
				...billingEventFor(reserved.reservation, 11, { inputTokens: 10, outputTokens: 10 }),
				fundingSource: "user" as const,
			};
			const settlement = {
				...inferenceFence(session, input, 11),
				usage: { turns: 1, wallTimeMs: 1, tokens: 20, costUsdMicros: billingEvent.costMicroUsd, artifactBytes: 0 },
				billingEvent,
			};
			await assert.rejects(
				runtime.settleAgentSessionInferenceBudget(reserved.reservation.operation_id, {
					...settlement,
					billingEvent: { ...billingEvent, fundingSource: "platform" },
				}),
				/funding diverges/,
			);
			await assert.rejects(
				runtime.settleAgentSessionInferenceBudget(reserved.reservation.operation_id, {
					...settlement,
					billingEvent: { ...billingEvent, userId: "forged" },
				}),
				/userId diverges/,
			);
			assert.equal(
				(await runtime.settleAgentSessionInferenceBudget(reserved.reservation.operation_id, settlement)).applied,
				true,
			);
			assert.equal(
				(await runtime.settleAgentSessionInferenceBudget(reserved.reservation.operation_id, settlement)).applied,
				false,
			);
			const claimed = await runtime.claimAgentSessionInferenceBillingOutbox({
				consumer: "first",
				leaseMs: 1,
				now: 12,
			});
			assert.equal(claimed?.payload.fundingSource, "user");
			const replay = await runtime.claimAgentSessionInferenceBillingOutbox({
				consumer: "retry",
				leaseMs: 1,
				now: 14,
			});
			assert.deepEqual(replay?.payload, claimed?.payload);
		});
		await withRuntime(async (runtime) => {
			const session = await seedRunningSession(runtime);
			const legacy = inferenceReservation(session, "legacy-platform", 10);
			const reserved = await runtime.reserveAgentSessionInferenceBudget(session.sessionId, legacy);
			assert.equal(reserved.reservation.funding_source, "platform");
			assert.equal(
				(
					await runtime.reserveAgentSessionInferenceBudget(session.sessionId, {
						...legacy,
						fundingSource: "platform",
					})
				).applied,
				false,
			);
			await assert.rejects(
				runtime.reserveAgentSessionInferenceBudget(session.sessionId, { ...legacy, fundingSource: "user" }),
				/different reservation evidence/,
			);
		});
	});

	it("serializes competing reserves, replays exactly, records overage truth, and drains billing with reclaim", async () => {
		await withRuntime(async (runtime) => {
			const session = await seedRunningSession(runtime);
			const requests = [
				inferenceReservation(session, "req-a", 10),
				inferenceReservation(session, "req-b", 11),
			] as const;
			const raced = await Promise.allSettled(
				requests.map((request) => runtime.reserveAgentSessionInferenceBudget(session.sessionId, request)),
			);
			const successes = raced.filter(
				(
					result,
				): result is PromiseFulfilledResult<
					Awaited<ReturnType<typeof runtime.reserveAgentSessionInferenceBudget>>
				> => result.status === "fulfilled",
			);
			const failures = raced.filter((result): result is PromiseRejectedResult => result.status === "rejected");
			assert.equal(successes.length, 1);
			assert.equal(failures.length, 1);
			assert.ok(
				failures[0]?.reason instanceof AgentSessionBudgetFault && failures[0].reason.reason === "budget_exhausted",
			);
			const reserved = successes[0]!.value;
			assert.deepEqual(reserved.billingProvenance, {
				userId: "user:test",
				graphId: "g-budget",
				childRunId: null,
				allocationId: null,
			});
			assert.equal(reserved.maxOutputTokens, 80, "the tx selects the exact token-capacity maximum");
			assert.deepEqual(reserved.reservation.budget, {
				turns: 1,
				wallTimeMs: 0,
				tokens: 90,
				costUsdMicros: computeCost(SESSION_MODEL, {
					input: 10,
					output: 80,
					cacheRead: 0,
					cacheWrite: 0,
				}).totalCostMicroUsd,
				artifactBytes: 0,
			});
			const winningRequest = requests.find((request) => request.requestId === reserved.reservation.request_id)!;
			const replay = await runtime.reserveAgentSessionInferenceBudget(session.sessionId, {
				...winningRequest,
				now: 12,
			});
			assert.equal(replay.applied, false);
			assert.equal(replay.reservation.operation_id, reserved.reservation.operation_id);
			await assert.rejects(
				runtime.reserveAgentSessionInferenceBudget(session.sessionId, {
					...winningRequest,
					requestDigest: `sha256:${"f".repeat(64)}`,
					now: 13,
				}),
				(error: unknown) => error instanceof AgentSessionBudgetFault && error.reason === "request_conflict",
			);

			const fence = inferenceFence(session, winningRequest, 20);
			const billedCost = computeCost(SESSION_MODEL, {
				input: 50,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
			});
			const usage = {
				turns: 1,
				wallTimeMs: 125,
				tokens: 1_050,
				costUsdMicros: billedCost.totalCostMicroUsd,
				artifactBytes: 7,
			} as const;
			const billingEvent = billingEventFor(reserved.reservation, 20, {
				inputTokens: 50,
				outputTokens: 1_000,
			});
			for (const forged of [
				{ userId: "user:forged" },
				{ graphId: "g-forged" },
				{ childRunId: "acr_forged" },
				{ allocationId: "asba_forged" },
			] as const) {
				await assert.rejects(
					runtime.settleAgentSessionInferenceBudget(reserved.reservation.operation_id, {
						...fence,
						usage,
						billingEvent: { ...billingEvent, ...forged },
					}),
					(error: unknown) => error instanceof AgentSessionBudgetFault && error.reason === "request_conflict",
				);
			}
			await assert.rejects(
				runtime.settleAgentSessionInferenceBudget(reserved.reservation.operation_id, {
					...fence,
					usage,
					billingEvent: { ...billingEvent, eventId: winningRequest.requestId },
				}),
				(error: unknown) => error instanceof AgentSessionBudgetFault && error.reason === "request_conflict",
			);
			const settled = await runtime.settleAgentSessionInferenceBudget(reserved.reservation.operation_id, {
				...fence,
				usage,
				billingEvent,
			});
			assert.equal(settled.applied, true);
			assert.equal(settled.account.exhausted, true);
			assert.deepEqual(settled.exhaustedDimensions.sort(), ["costUsdMicros", "tokens"]);
			assert.deepEqual(settled.account.reserved, {
				turns: 0,
				wallTimeMs: 0,
				tokens: 0,
				costUsdMicros: 0,
				artifactBytes: 0,
			});
			assert.deepEqual(settled.account.spent, usage);
			const settlementReplay = await runtime.settleAgentSessionInferenceBudget(reserved.reservation.operation_id, {
				...fence,
				now: 21,
				usage,
				billingEvent,
			});
			assert.equal(settlementReplay.applied, false);
			await assert.rejects(
				runtime.settleAgentSessionInferenceBudget(reserved.reservation.operation_id, {
					...fence,
					now: 22,
					usage: { ...usage, tokens: 1_051 },
					billingEvent,
				}),
				(error: unknown) => error instanceof AgentSessionBudgetFault && error.reason === "request_conflict",
			);
			await assert.rejects(
				runtime.reserveAgentSessionInferenceBudget(
					session.sessionId,
					inferenceReservation(session, "req-after-exhaustion", 23),
				),
				(error: unknown) => error instanceof AgentSessionBudgetFault && error.reason === "budget_exhausted",
			);

			const events = await runtime.listAgentSessionEvents(session.sessionId);
			assert.equal(events.filter((event) => event.type === "budget.exhausted").length, 1);
			const ledgerEntries = await runtime.listAgentSessionBudgetEntries(session.sessionId);
			assert.deepEqual(
				ledgerEntries.map((entry) => entry.kind),
				["account_opened", "inference_reserved", "inference_settled"],
			);
			for (const entry of ledgerEntries) {
				assert.deepEqual(Object.keys(entry.reserved_delta).sort(), [
					"artifactBytes",
					"costUsdMicros",
					"tokens",
					"turns",
					"wallTimeMs",
				]);
			}

			const firstClaim = await runtime.claimAgentSessionInferenceBillingOutbox({
				consumer: "billing-a",
				leaseMs: 10,
				now: 30,
			});
			assert.equal(firstClaim?.operation_id, reserved.reservation.operation_id);
			assert.equal(await runtime.readAgentSessionInferenceBillingOutboxNextAvailableAt(31), 40);
			assert.equal(
				await runtime.claimAgentSessionInferenceBillingOutbox({ consumer: "billing-b", leaseMs: 10, now: 39 }),
				null,
			);
			await assert.rejects(
				runtime.completeAgentSessionInferenceBillingOutbox({
					operationId: reserved.reservation.operation_id,
					consumer: "billing-a",
					claimToken: firstClaim!.claim_token!,
					now: 40,
				}),
				/lost claim/,
			);
			const reclaimed = await runtime.claimAgentSessionInferenceBillingOutbox({
				consumer: "billing-b",
				leaseMs: 10,
				now: 40,
			});
			assert.equal(reclaimed?.operation_id, reserved.reservation.operation_id);
			assert.notEqual(reclaimed?.claim_token, firstClaim?.claim_token);
			await assert.rejects(
				runtime.completeAgentSessionInferenceBillingOutbox({
					operationId: reserved.reservation.operation_id,
					consumer: "billing-a",
					claimToken: firstClaim!.claim_token!,
					now: 41,
				}),
			);
			const delivered = await runtime.completeAgentSessionInferenceBillingOutbox({
				operationId: reserved.reservation.operation_id,
				consumer: "billing-b",
				claimToken: reclaimed!.claim_token!,
				now: 42,
			});
			assert.equal(delivered.state, "delivered");
			assert.equal(await runtime.readAgentSessionInferenceBillingOutboxNextAvailableAt(43), null);
		});
	});

	it("holds an indeterminate reservation fail-closed until an exact release", async () => {
		await withRuntime(async (runtime) => {
			const session = await seedRunningSession(runtime);
			const request = inferenceReservation(session, "req-indeterminate", 10);
			const reserved = await runtime.reserveAgentSessionInferenceBudget(session.sessionId, request);
			const fence = inferenceFence(session, request, 11);
			const indeterminate = await runtime.markAgentSessionInferenceBudgetIndeterminate(
				reserved.reservation.operation_id,
				{ ...fence, reason: "provider stream ended without a terminal frame" },
			);
			assert.equal(indeterminate.reservation.state, "indeterminate");
			assert.equal(indeterminate.account.reserved.tokens, 90);
			const replay = await runtime.markAgentSessionInferenceBudgetIndeterminate(reserved.reservation.operation_id, {
				...fence,
				now: 12,
				reason: "provider stream ended without a terminal frame",
			});
			assert.equal(replay.applied, false);
			const released = await runtime.releaseAgentSessionInferenceBudget(reserved.reservation.operation_id, {
				...fence,
				now: 13,
				reason: "operator reconciled no provider charge",
			});
			assert.equal(released.reservation.state, "released");
			assert.equal(released.account.reserved.tokens, 0);
			assert.equal(
				(
					await runtime.releaseAgentSessionInferenceBudget(reserved.reservation.operation_id, {
						...fence,
						now: 14,
						reason: "operator reconciled no provider charge",
					})
				).applied,
				false,
			);
		});
	});

	it("rejects provider/model substitution before pricing or ledger mutation", async () => {
		await withRuntime(async (runtime) => {
			const session = await seedRunningSession(runtime);
			await assert.rejects(
				runtime.reserveAgentSessionInferenceBudget(session.sessionId, {
					...inferenceReservation(session, "req-substitution", 10),
					provider: "mock",
					model: "mock:free",
				}),
				(error: unknown) => error instanceof AgentSessionBudgetFault && error.reason === "request_conflict",
			);
			assert.deepEqual(
				(await runtime.readAgentSessionBudgetSnapshot(session.sessionId))?.entries.map((entry) => entry.kind),
				["account_opened"],
			);
		});
	});

	it("rejects an internally consistent caller-supplied price that diverges from the pinned catalogue", async () => {
		await withRuntime(async (runtime) => {
			const session = await seedRunningSession(runtime);
			const request = inferenceReservation(session, "req-mispriced", 10);
			const reserved = await runtime.reserveAgentSessionInferenceBudget(session.sessionId, request);
			const truth = billingEventFor(reserved.reservation, 11, { inputTokens: 10, outputTokens: 10 });
			const forged = {
				...truth,
				inputCostMicroUsd: 0,
				outputCostMicroUsd: 0,
				cacheReadCostMicroUsd: 0,
				cacheWriteCostMicroUsd: 0,
				providerCostMicroUsd: 0,
				markupMicroUsd: 0,
				costMicroUsd: 0,
			};
			await assert.rejects(
				runtime.settleAgentSessionInferenceBudget(reserved.reservation.operation_id, {
					...inferenceFence(session, request, 11),
					usage: { turns: 1, wallTimeMs: 1, tokens: 20, costUsdMicros: 0, artifactBytes: 0 },
					billingEvent: forged,
				}),
				(error: unknown) => error instanceof AgentSessionBudgetFault && error.reason === "request_conflict",
			);
			assert.equal(
				(await runtime.readAgentSessionInferenceReservation(reserved.reservation.operation_id))?.state,
				"reserved",
			);
		});
	});

	it("keeps exhaustion sticky after releasing unrelated reserved capacity", async () => {
		await withRuntime(async (runtime) => {
			const session = await seedRunningSession(runtime);
			const firstRequest = {
				...inferenceReservation(session, "req-overage", 10),
				requestedOutputTokens: 40,
			};
			const secondRequest = {
				...inferenceReservation(session, "req-release", 11),
				requestedOutputTokens: 40,
			};
			const first = await runtime.reserveAgentSessionInferenceBudget(session.sessionId, firstRequest);
			const second = await runtime.reserveAgentSessionInferenceBudget(session.sessionId, secondRequest);
			const cost = computeCost(SESSION_MODEL, { input: 20, output: 40, cacheRead: 0, cacheWrite: 0 });
			const usage = {
				turns: 1,
				wallTimeMs: 10,
				tokens: 60,
				costUsdMicros: cost.totalCostMicroUsd,
				artifactBytes: 0,
			} as const;
			await runtime.markAgentSessionInferenceBudgetIndeterminate(second.reservation.operation_id, {
				...inferenceFence(session, secondRequest, 19),
				reason: "provider outcome requires operator release",
			});
			const settled = await runtime.settleAgentSessionInferenceBudget(first.reservation.operation_id, {
				...inferenceFence(session, firstRequest, 20),
				usage,
				billingEvent: billingEventFor(first.reservation, 20, {
					inputTokens: 20,
					outputTokens: 40,
				}),
			});
			assert.equal(settled.account.exhausted, true);
			const beforeReleaseFamily = await runtime.readAgentSessionFamilyProjection(session.sessionId);
			assert.ok(beforeReleaseFamily);
			const released = await runtime.releaseAgentSessionInferenceBudget(second.reservation.operation_id, {
				...inferenceFence(session, secondRequest, 22),
				reason: "operator confirmed no provider charge",
			});
			assert.equal(released.account.exhausted, true);
			assert.equal(released.account.spent.tokens, 60);
			assert.equal(released.account.reserved.tokens, 0);
			const family = await runtime.readAgentSessionFamilyProjection(session.sessionId);
			assert.ok(family);
			assert.ok(
				family.projectionRevision > beforeReleaseFamily.projectionRevision,
				"budget-account mutations advance the family CAS clock",
			);
			assert.equal(family.root.budgetAccountExhausted, true);
			assert.equal(family.root.budgetCostRemainingUsdMicros, 1_000 - cost.totalCostMicroUsd);
		});
	});
});

async function withRuntime(run: (runtime: WorkflowRuntimeStore) => Promise<void>): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "agent-session-budget-ledger-"));
	const runtime = new WorkflowRuntimeStore(join(directory, "runtime.sqlite"));
	try {
		await runtime.init();
		await run(runtime);
	} finally {
		runtime.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

async function seedRunningSession(runtime: WorkflowRuntimeStore): Promise<{
	readonly sessionId: string;
	readonly generation: number;
	readonly activationId: string;
	readonly sandboxId: string;
}> {
	const sessionId = "ags-budget-root";
	const runId = "wfr-budget-root";
	const graphId = "g-budget";
	const semantic = makeTestAgentSemanticBinding({ graphId, kind: "prime", registeredName: "budget-root" });
	const runtimeBinding = {
		...semantic.runtime,
		constraints: {
			...semantic.runtime.constraints,
			maxTurns: 2,
			maxWallTimeMs: 1_000,
			maxTokens: 100,
			maxCostUsdMicros: 1_000,
			maxArtifactBytes: 1_000,
		},
	};
	await runtime.createWorkflowInstance({
		runId,
		workflowName: "budget-ledger-test",
		graphId,
		ownerUserId: "user:test",
		inputs: {},
		startedAt: 1,
	});
	const spec: AgentNodeSpec = {
		label: "budget-root",
		phaseIndex: 0,
		prompt: "Budget this.",
		model: SESSION_MODEL,
		provider: "openrouter",
		graphId,
		sessionId,
		agentId: semantic.agentId,
		runtime: runtimeBinding,
		runtimeBindingDigest: digestAgentRuntimeBinding(runtimeBinding),
		ontology: semantic.ontology,
		ontologyBindingDigest: semantic.ontologyBindingDigest,
	};
	await runtime.beginAgentSession({
		sessionId,
		runId,
		workflowName: "budget-ledger-test",
		graphId,
		ownerUserId: "user:test",
		graphOwnerPrincipal: "user:test",
		spec,
		nodeKey: "root",
		frontier: { kind: "before-node", sessionId, ts: 1 },
		now: 1,
	});
	const fence = { sessionId, generation: 0, activationId: "act-budget-root", sandboxId: "sbx-budget-root" };
	await runtime.claimAgentMaterialization(sessionId, { generation: 0, activationId: fence.activationId, now: 2 });
	await runtime.bindAgentSandbox(sessionId, { ...fence, now: 3 });
	return fence;
}

function inferenceReservation(
	session: { readonly generation: number; readonly activationId: string; readonly sandboxId: string },
	requestId: string,
	now: number,
) {
	const digestCharacter = requestId === "req-a" ? "a" : "b";
	return {
		generation: session.generation,
		activationId: session.activationId,
		sandboxId: session.sandboxId,
		requestId,
		requestDigest: `sha256:${digestCharacter.repeat(64)}`,
		causationId: `cause-${requestId}`,
		provider: "openrouter",
		model: SESSION_MODEL,
		estimatedInputTokens: 10,
		requestedOutputTokens: 80,
		pricingVersion: PRICING_VERSION,
		now,
	};
}

function billingEventFor(
	reservation: Awaited<ReturnType<WorkflowRuntimeStore["reserveAgentSessionInferenceBudget"]>>["reservation"],
	ts: number,
	usage: { readonly inputTokens: number; readonly outputTokens: number },
) {
	const cost = computeCost(
		reservation.model,
		{ input: usage.inputTokens, output: usage.outputTokens, cacheRead: 0, cacheWrite: 0 },
		reservation.provider,
	);
	return {
		eventId: reservation.operation_id,
		ts,
		userId: "user:test",
		graphId: "g-budget",
		sandboxId: reservation.sandbox_id,
		template: "sophia-agent",
		sessionId: reservation.session_id,
		generation: reservation.generation,
		inferenceOperationId: reservation.operation_id,
		requestId: reservation.request_id,
		childRunId: null,
		allocationId: null,
		provider: reservation.provider,
		model: reservation.model,
		modelPriced: cost.modelPriced,
		reason: "stop",
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: usage.inputTokens + usage.outputTokens,
		inputCostMicroUsd: cost.inputCostMicroUsd,
		outputCostMicroUsd: cost.outputCostMicroUsd,
		cacheReadCostMicroUsd: cost.cacheReadCostMicroUsd,
		cacheWriteCostMicroUsd: cost.cacheWriteCostMicroUsd,
		providerCostMicroUsd: cost.providerCostMicroUsd,
		providerReportedCostMicroUsd: cost.providerCostMicroUsd,
		markupMicroUsd: cost.markupMicroUsd,
		costMicroUsd: cost.totalCostMicroUsd,
		pricingVersion: reservation.pricing_version,
		pricedDefault: cost.pricedDefault,
	};
}

function inferenceFence(
	session: { readonly generation: number; readonly activationId: string; readonly sandboxId: string },
	request: { readonly requestId: string; readonly requestDigest: string },
	now: number,
) {
	return {
		generation: session.generation,
		activationId: session.activationId,
		sandboxId: session.sandboxId,
		requestId: request.requestId,
		requestDigest: request.requestDigest,
		now,
	};
}
