import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SOPHIA_CONTENT_REF_SCHEMA } from "../agent-runtime/content-store.js";
import { PRIME_HOST_PROTOCOL_VERSION } from "../agent-runtime/host-protocol.js";
import { createMeaningfulObjectRef, type MeaningfulObjectRefV1 } from "../agent-runtime/meaningful-object.js";
import { AGENT_CHECKPOINT_SCHEMA, type AgentCheckpointManifestV2 } from "../agent-runtime/memory.js";
import {
	type AgentRuntimeConstraintsV2,
	type AgentRuntimeKind,
	digestAgentRuntimeBinding,
} from "../agent-runtime/profile.js";
import { PRIME_RUNTIME_STATE_SCHEMA } from "../agent-runtime/result-validation.js";
import { computeCost, PRICING_VERSION } from "../billing-pricing.js";
import {
	AgentSessionBudgetFault,
	AgentSessionGenerationFault,
	type AgentSessionInferenceBillingProvenance,
	type AgentSessionInferenceReservationRecord,
	WorkflowRuntimeStore,
} from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

type AcceptedChild = Extract<
	Awaited<ReturnType<WorkflowRuntimeStore["admitAgentSessionChild"]>>,
	{ decision: "accepted" }
>;

describe("Agent Session F4 cross-store authority", () => {
	it("serializes child lifetime, occupancy, and budget aggregates across independent connections", async () => {
		await withTwoRuntimes(async (first, second) => {
			const seeded = await seedDomainParent(first, "child-race", {
				parentConstraintOverrides: {
					maxChildren: 3,
					maxConcurrentChildren: 2,
					maxCostUsdMicros: 1_000_000,
					maxArtifactBytes: 805_306_368,
				},
			});
			const firstWavePromise = Promise.all(
				Array.from({ length: 6 }, (_, index) =>
					(index % 2 === 0 ? first : second).admitAgentSessionChild(seeded.parentSessionId, {
						...seeded.parentFence,
						requestId: `cross-child-${index}`,
						prompt: `Concurrent child ${index}.`,
						requestedName: `cross_child_${index}`,
						causationId: `cause-cross-child-${index}`,
						now: 20 + index,
					}),
				),
			);
			await assert.doesNotReject(firstWavePromise, "contention must not escape as SQLITE_BUSY");
			const firstWave = await firstWavePromise;
			const accepted = firstWave.filter((decision): decision is AcceptedChild => decision.decision === "accepted");
			const denied = firstWave.filter((decision) => decision.decision === "denied");
			assert.equal(accepted.length, 2, "the exact generation occupancy ceiling admits");
			assert.equal(denied.length, 4);
			assert.ok(
				denied.every(
					(decision) =>
						decision.decision === "denied" &&
						decision.request.denial_code === "max_concurrent_children_exhausted",
				),
			);
			assert.equal((await first.listAgentSessionChildren(seeded.parentSessionId)).length, 2);
			let account = await second.readAgentSessionBudgetSnapshot(seeded.parentSessionId);
			assert.equal(account?.account.reserved.costUsdMicros, 1_000_000);
			assert.equal(account?.account.reserved.artifactBytes, 536_870_912);
			assert.equal(account?.account.revision, 2);

			await completeSimpleChild(second, accepted[0]!, 40);
			const secondWavePromise = Promise.all([
				first.admitAgentSessionChild(seeded.parentSessionId, {
					...seeded.parentFence,
					requestId: "cross-child-lifetime-a",
					prompt: "Compete for the final lifetime slot.",
					requestedName: "cross_child_lifetime_a",
					causationId: "cause-cross-child-lifetime-a",
					now: 50,
				}),
				second.admitAgentSessionChild(seeded.parentSessionId, {
					...seeded.parentFence,
					requestId: "cross-child-lifetime-b",
					prompt: "Compete for the final lifetime slot.",
					requestedName: "cross_child_lifetime_b",
					causationId: "cause-cross-child-lifetime-b",
					now: 51,
				}),
			]);
			await assert.doesNotReject(secondWavePromise, "the second cross-store race must remain lock-safe");
			const secondWave = await secondWavePromise;
			assert.equal(secondWave.filter((decision) => decision.decision === "accepted").length, 1);
			assert.equal(secondWave.filter((decision) => decision.decision === "denied").length, 1);
			const lifetimeDenial = secondWave.find((decision) => decision.decision === "denied");
			assert.equal(
				lifetimeDenial?.decision === "denied" ? lifetimeDenial.request.denial_code : null,
				"max_children_exhausted",
			);
			assert.equal((await second.listAgentSessionChildren(seeded.parentSessionId)).length, 3);
			account = await first.readAgentSessionBudgetSnapshot(seeded.parentSessionId);
			assert.equal(account?.account.reserved.costUsdMicros, 1_000_000);
			assert.equal(account?.account.reserved.artifactBytes, 536_870_912);
			assert.equal(account?.account.spent.costUsdMicros, 0);
			assert.equal(account?.account.revision, 4);
			assert.deepEqual(
				account?.entries.map((entry) => entry.kind),
				["account_opened", "child_allocated", "child_allocated", "child_settled", "child_allocated"],
			);
		});
	});

	it("preserves exact concurrent inference accounting, outbox claims, and replay after reopen", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agent-session-f4-reopen-"));
		const path = join(directory, "runtime.sqlite");
		const first = new WorkflowRuntimeStore(path);
		const second = new WorkflowRuntimeStore(path);
		let reopened: WorkflowRuntimeStore | null = null;
		try {
			await first.init();
			await second.init();
			const session = await seedInferenceSession(first, "inference-race");
			const requests = Array.from({ length: 8 }, (_, index) =>
				inferenceRequest(session, `cross-inference-${index}`, 20 + index),
			);
			const reserveRace = Promise.allSettled(
				requests.map((request, index) =>
					(index % 2 === 0 ? first : second).reserveAgentSessionInferenceBudget(session.sessionId, request),
				),
			);
			await assert.doesNotReject(reserveRace, "cross-store inference contention must settle without SQLITE_BUSY");
			const reserveResults = await reserveRace;
			const winners = reserveResults.flatMap((result, index) =>
				result.status === "fulfilled" ? [{ value: result.value, request: requests[index]! }] : [],
			);
			const failures = reserveResults.filter(
				(result): result is PromiseRejectedResult => result.status === "rejected",
			);
			assert.equal(winners.length, 4);
			assert.equal(failures.length, 4);
			assert.ok(
				failures.every(
					(result) =>
						result.reason instanceof AgentSessionBudgetFault && result.reason.reason === "budget_exhausted",
				),
			);
			let snapshot = await second.readAgentSessionBudgetSnapshot(session.sessionId);
			assert.equal(snapshot?.account.revision, 4);
			assert.deepEqual(snapshot?.account.reserved, {
				turns: 4,
				wallTimeMs: 0,
				tokens: 400,
				costUsdMicros: 0,
				artifactBytes: 0,
			});

			const settlements = winners.map(({ value, request }, index) => {
				const usage = {
					turns: 1,
					wallTimeMs: 10,
					tokens: 50,
					costUsdMicros: 0,
					artifactBytes: 5,
				} as const;
				return {
					value,
					request,
					usage,
					billingEvent: billingEventFor(value.reservation, value.billingProvenance, 60 + index, {
						inputTokens: 20,
						outputTokens: 30,
					}),
				};
			});
			const settleRace = Promise.all(
				settlements.map((settlement, index) =>
					(index % 2 === 0 ? second : first).settleAgentSessionInferenceBudget(
						settlement.value.reservation.operation_id,
						{
							...inferenceFence(session, settlement.request, 60 + index),
							usage: settlement.usage,
							billingEvent: settlement.billingEvent,
						},
					),
				),
			);
			await assert.doesNotReject(settleRace, "settlements must serialize without lost revisions");
			await settleRace;
			snapshot = await first.readAgentSessionBudgetSnapshot(session.sessionId);
			assert.equal(snapshot?.account.revision, 8);
			assert.deepEqual(snapshot?.account.reserved, zeroBudget());
			assert.deepEqual(snapshot?.account.spent, {
				turns: 4,
				wallTimeMs: 40,
				tokens: 200,
				costUsdMicros: 0,
				artifactBytes: 20,
			});
			assert.deepEqual(snapshot?.available, {
				turns: 0,
				wallTimeMs: 60,
				tokens: 200,
				costUsdMicros: 1_000,
				artifactBytes: 80,
			});

			const claimsPromise = Promise.all(
				Array.from({ length: 8 }, (_, index) =>
					(index % 2 === 0 ? first : second).claimAgentSessionInferenceBillingOutbox({
						consumer: `cross-billing-${index}`,
						leaseMs: 100,
						now: 100,
					}),
				),
			);
			await assert.doesNotReject(claimsPromise, "outbox claiming must remain lock-safe");
			const claims = (await claimsPromise).filter((claim) => claim !== null);
			assert.equal(claims.length, 4);
			assert.equal(new Set(claims.map((claim) => claim.operation_id)).size, 4, "one operation has one live claim");
			assert.deepEqual(
				new Set(claims.map((claim) => claim.operation_id)),
				new Set(winners.map(({ value }) => value.reservation.operation_id)),
			);
			await Promise.all(
				claims.map((claim, index) =>
					(index % 2 === 0 ? second : first).completeAgentSessionInferenceBillingOutbox({
						operationId: claim.operation_id,
						consumer: claim.consumer!,
						claimToken: claim.claim_token!,
						now: 101,
					}),
				),
			);

			first.close();
			second.close();
			reopened = new WorkflowRuntimeStore(path);
			await reopened.init();
			const afterReopen = await reopened.readAgentSessionBudgetSnapshot(session.sessionId);
			assert.deepEqual(afterReopen, snapshot, "the durable account and immutable ledger survive reopen exactly");
			const replayTarget = settlements[0]!;
			const reserveReplay = await reopened.reserveAgentSessionInferenceBudget(session.sessionId, {
				...replayTarget.request,
				now: 200,
			});
			assert.equal(reserveReplay.applied, false);
			const settleReplay = await reopened.settleAgentSessionInferenceBudget(
				replayTarget.value.reservation.operation_id,
				{
					...inferenceFence(session, replayTarget.request, 201),
					usage: replayTarget.usage,
					billingEvent: replayTarget.billingEvent,
				},
			);
			assert.equal(settleReplay.applied, false);
			assert.equal((await reopened.readAgentSessionBudgetSnapshot(session.sessionId))?.account.revision, 8);
			assert.equal(
				await reopened.claimAgentSessionInferenceBillingOutbox({
					consumer: "after-reopen",
					leaseMs: 100,
					now: 202,
				}),
				null,
				"delivered outbox rows never reappear after reopen",
			);
		} finally {
			if (reopened) reopened.close();
			else {
				first.close();
				second.close();
			}
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("releases passivated generation occupancy and fences a regrow against a full sibling slot", async () => {
		await withTwoRuntimes(async (first, second) => {
			const seeded = await seedDomainParent(first, "generation-occupancy", {
				childKind: "prime",
				parentConstraintOverrides: {
					maxTurns: 48,
					maxWallTimeMs: 1_800_000,
					maxTokens: 200_000,
					maxCostUsdMicros: 2_000_000,
					maxChildren: 2,
					maxConcurrentChildren: 1,
					maxArtifactBytes: 536_870_912,
				},
				childConstraintOverrides: {
					maxTokens: 100_000,
					maxChildren: 0,
					maxChildDepth: 0,
					maxConcurrentChildren: 0,
				},
			});
			const firstChild = await admitChild(first, seeded, "resident-a", 20);
			await materializeAndPassivate(first, firstChild, 0, "resident-a-0", 30);
			assert.equal(
				(await second.readAgentSessionChildGenerationOccupancy(firstChild.child.session_id, 0))?.state,
				"released",
			);

			const secondChild = await admitChild(second, seeded, "resident-b", 50);
			await assert.rejects(
				first.claimAgentMaterialization(firstChild.child.session_id, {
					generation: 1,
					activationId: "act-resident-a-1-denied",
					now: 51,
				}),
				(error: unknown) =>
					error instanceof AgentSessionGenerationFault &&
					error.message === "Parent maxConcurrentChildren capacity is exhausted",
			);
			assert.equal(await second.readAgentMaterialization(firstChild.child.session_id, 1), null);

			await materializeAndPassivate(second, secondChild, 0, "resident-b-0", 60);
			const regrown = await first.claimAgentMaterialization(firstChild.child.session_id, {
				generation: 1,
				activationId: "act-resident-a-1",
				now: 80,
			});
			assert.equal(regrown.generation, 1);
			assert.equal(
				(await second.readAgentSessionChildGenerationOccupancy(firstChild.child.session_id, 1))?.state,
				"occupied",
			);
			const family = await first.readAgentSessionFamilyProjection(seeded.parentSessionId);
			assert.equal(family?.root.directAcceptedChildren, 2);
			assert.equal(family?.root.occupiedChildren, 1);
		});
	});

	it("reconciles exact simple-child overage into the parent and keeps exhaustion sticky after capacity returns", async () => {
		await withTwoRuntimes(async (first, second) => {
			const seeded = await seedDomainParent(first, "child-overage", {
				childModel: "openai/gpt-4.1",
				parentConstraintOverrides: {
					maxChildren: 2,
					maxConcurrentChildren: 2,
					maxCostUsdMicros: 1_000_000,
					maxArtifactBytes: 536_870_912,
				},
			});
			const overageChild = await admitChild(first, seeded, "overage", 20);
			const unusedChild = await admitChild(second, seeded, "unused", 21);
			const overageClaim = await first.claimAgentSessionChildRun(overageChild.run.child_run_id, {
				consumer: "overage-child-worker",
				leaseMs: 100,
				now: 30,
			});
			assert.equal(overageClaim.claimed, true);
			const activationId = "act-overage-child";
			const sandboxId = "sbx-overage-child";
			await second.claimAgentSessionChildMaterialization(overageChild.run.child_run_id, {
				consumer: overageClaim.run.consumer!,
				claimToken: overageClaim.run.claim_token!,
				generation: 0,
				activationId,
				now: 31,
			});
			await second.bindAgentSandbox(overageChild.child.session_id, {
				generation: 0,
				activationId,
				sandboxId,
				childRunConsumer: overageClaim.run.consumer!,
				childRunClaimToken: overageClaim.run.claim_token!,
				now: 32,
			});
			const request = {
				generation: 0,
				activationId,
				sandboxId,
				requestId: "overage-inference",
				requestDigest: `sha256:${"d".repeat(64)}`,
				causationId: "cause-overage-inference",
				provider: "openrouter",
				model: seeded.childModel,
				estimatedInputTokens: 1,
				requestedOutputTokens: 1,
				pricingVersion: PRICING_VERSION,
				now: 33,
			} as const;
			const reserved = await first.reserveAgentSessionInferenceBudget(overageChild.child.session_id, request);
			const actualTokens = { input: 0, output: 70_000, cacheRead: 0, cacheWrite: 0 } as const;
			const actualCost = computeCost(seeded.childModel, actualTokens, "openrouter");
			assert.ok(actualCost.totalCostMicroUsd > overageChild.allocation.budget.maxCostUsdMicros);
			const usage = {
				turns: 1,
				wallTimeMs: 25,
				tokens: actualTokens.output,
				costUsdMicros: actualCost.totalCostMicroUsd,
				artifactBytes: 0,
			} as const;
			await second.settleAgentSessionInferenceBudget(reserved.reservation.operation_id, {
				...inferenceFence(
					{ sessionId: overageChild.child.session_id, generation: 0, activationId, sandboxId },
					request,
					34,
				),
				usage,
				billingEvent: billingEventFor(reserved.reservation, reserved.billingProvenance, 34, {
					inputTokens: actualTokens.input,
					outputTokens: actualTokens.output,
				}),
			});
			const result = await recordChildOutcome(
				first,
				overageChild,
				overageClaim,
				activationId,
				"over budget, exactly accounted",
				35,
			);
			await first.finishAgentMaterialization(overageChild.child.session_id, 0, {
				activationId,
				from: "running",
				to: "completed",
				now: 36,
			});
			await second.settleAgentSessionChildRun(overageChild.run.child_run_id, {
				consumer: overageClaim.run.consumer!,
				claimToken: overageClaim.run.claim_token!,
				status: "completed",
				terminalPolicy: "close",
				materializationGeneration: 0,
				materializationState: "completed",
				result,
				now: 37,
			});

			let parent = await first.readAgentSessionBudgetSnapshot(seeded.parentSessionId);
			assert.equal(parent?.account.spent.costUsdMicros, actualCost.totalCostMicroUsd);
			assert.equal(parent?.account.reserved.costUsdMicros, unusedChild.allocation.budget.maxCostUsdMicros);
			assert.equal(parent?.account.exhausted, true);
			assert.equal(
				(await second.readAgentSessionChildBudgetAllocation(overageChild.allocation.allocation_id))?.state,
				"settled",
			);

			await completeSimpleChild(first, unusedChild, 40);
			parent = await second.readAgentSessionBudgetSnapshot(seeded.parentSessionId);
			assert.equal(parent?.account.reserved.costUsdMicros, 0);
			assert.equal(parent?.account.spent.costUsdMicros, actualCost.totalCostMicroUsd);
			assert.equal(parent?.available.costUsdMicros, 1_000_000 - actualCost.totalCostMicroUsd);
			assert.equal(parent?.account.exhausted, true, "exhaustion remains sticky after unrelated capacity returns");
			assert.deepEqual(
				parent?.entries.map((entry) => entry.kind),
				["account_opened", "child_allocated", "child_allocated", "child_settled", "child_settled"],
			);
			await assert.rejects(
				first.reserveAgentSessionInferenceBudget(seeded.parentSessionId, {
					generation: seeded.parentFence.parentGeneration,
					activationId: seeded.parentFence.parentActivationId,
					sandboxId: seeded.parentFence.parentSandboxId,
					requestId: "sticky-parent-inference",
					requestDigest: `sha256:${"e".repeat(64)}`,
					causationId: "cause-sticky-parent-inference",
					provider: "openrouter",
					model: "mock:done",
					estimatedInputTokens: 1,
					requestedOutputTokens: 1,
					pricingVersion: PRICING_VERSION,
					now: 50,
				}),
				(error: unknown) => error instanceof AgentSessionBudgetFault && error.reason === "budget_exhausted",
			);
		});
	});
});

async function withTwoRuntimes(
	run: (first: WorkflowRuntimeStore, second: WorkflowRuntimeStore) => Promise<void>,
): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "agent-session-f4-cross-store-"));
	const path = join(directory, "runtime.sqlite");
	const first = new WorkflowRuntimeStore(path);
	const second = new WorkflowRuntimeStore(path);
	try {
		await first.init();
		await second.init();
		await run(first, second);
	} finally {
		first.close();
		second.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

interface SeedDomainParentOptions {
	readonly childKind?: AgentRuntimeKind;
	readonly childModel?: string;
	readonly parentConstraintOverrides?: Partial<AgentRuntimeConstraintsV2>;
	readonly childConstraintOverrides?: Partial<AgentRuntimeConstraintsV2>;
}

interface SeededParent {
	readonly parentSessionId: string;
	readonly childModel: string;
	readonly parentFence: {
		readonly parentGeneration: number;
		readonly parentActivationId: string;
		readonly parentSandboxId: string;
	};
}

async function seedDomainParent(
	runtime: WorkflowRuntimeStore,
	suffix: string,
	options: SeedDomainParentOptions = {},
): Promise<SeededParent> {
	const parentSessionId = `ags-${suffix}-parent`;
	const ownerUserId = "user:ada";
	const graphId = "prime-notebook-lab";
	const runId = `wfr-${suffix}-parent`;
	const workflowName = "domain-agent-activity-loop-v1";
	const registeredName = `f4-${suffix}`;
	const pilotBase = makeTestAgentSemanticBinding({ graphId, kind: "prime", registeredName });
	const childBase = makeTestAgentSemanticBinding({
		graphId,
		kind: options.childKind ?? "simple",
		registeredName,
	});
	const pilot = {
		...pilotBase,
		runtime: {
			...pilotBase.runtime,
			constraints: { ...pilotBase.runtime.constraints, ...options.parentConstraintOverrides },
		},
	};
	const child = {
		...childBase,
		runtime: {
			...childBase.runtime,
			constraints: { ...childBase.runtime.constraints, ...options.childConstraintOverrides },
		},
	};
	const childModel = options.childModel ?? "mock:done";
	await runtime.createWorkflowInstance({
		runId,
		workflowName,
		graphId,
		ownerUserId,
		graphOwnerPrincipal: ownerUserId,
		inputs: {
			hostContext: {
				schema: "sophia.domain-agent-host-context.v1",
				runtimes: { pilot: pilot.runtime, emanation: child.runtime },
				ontologies: { pilot: pilot.ontology, emanation: child.ontology },
				emanation: {
					enabled: true,
					provider: "openrouter",
					model: childModel,
					maxEmanations: 1,
					maxTurns: child.runtime.constraints.maxTurns,
				},
				emanationToolInclude: ["recall"],
				systemPrompt: "You are an F4 persistence proof agent.",
				toolbelt: { tools: [{ name: "recall", capability: "mnemosyne", access: "read", available: true }] },
			},
		},
		startedAt: 1,
	});
	const spec: AgentNodeSpec = {
		label: "pilot-attend",
		phaseIndex: 1,
		prompt: "Attend.",
		model: "mock:done",
		provider: "openrouter",
		graphId,
		sessionId: parentSessionId,
		agentId: pilot.agentId,
		runtime: pilot.runtime,
		runtimeBindingDigest: digestAgentRuntimeBinding(pilot.runtime),
		ontology: pilot.ontology,
		ontologyBindingDigest: pilot.ontologyBindingDigest,
	};
	await runtime.beginAgentSession({
		sessionId: parentSessionId,
		runId,
		workflowName,
		graphId,
		ownerUserId,
		graphOwnerPrincipal: ownerUserId,
		spec,
		nodeKey: "1:pilot-attend",
		frontier: { kind: "before-node", sessionId: parentSessionId, phaseIndex: 1, ts: 1 },
		now: 1,
	});
	const parentFence = {
		parentGeneration: 0,
		parentActivationId: `act-${suffix}-parent`,
		parentSandboxId: `sbx-${suffix}-parent`,
	} as const;
	await runtime.claimAgentMaterialization(parentSessionId, {
		generation: parentFence.parentGeneration,
		activationId: parentFence.parentActivationId,
		now: 2,
	});
	await runtime.bindAgentSandbox(parentSessionId, {
		generation: parentFence.parentGeneration,
		activationId: parentFence.parentActivationId,
		sandboxId: parentFence.parentSandboxId,
		now: 3,
	});
	return { parentSessionId, childModel, parentFence };
}

async function seedInferenceSession(
	runtime: WorkflowRuntimeStore,
	suffix: string,
): Promise<{ sessionId: string; generation: number; activationId: string; sandboxId: string }> {
	const sessionId = `ags-${suffix}`;
	const runId = `wfr-${suffix}`;
	const graphId = "g-f4-cross-store";
	const semantic = makeTestAgentSemanticBinding({ graphId, kind: "prime", registeredName: suffix });
	const runtimeBinding = {
		...semantic.runtime,
		constraints: {
			...semantic.runtime.constraints,
			maxTurns: 4,
			maxWallTimeMs: 100,
			maxTokens: 400,
			maxCostUsdMicros: 1_000,
			maxArtifactBytes: 100,
		},
	};
	await runtime.createWorkflowInstance({
		runId,
		workflowName: "f4-cross-store-inference",
		graphId,
		ownerUserId: "user:test",
		graphOwnerPrincipal: "user:test",
		inputs: {},
		startedAt: 1,
	});
	const spec: AgentNodeSpec = {
		label: "f4-inference",
		phaseIndex: 0,
		prompt: "Exercise the ledger.",
		model: "mock:done",
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
		workflowName: "f4-cross-store-inference",
		graphId,
		ownerUserId: "user:test",
		graphOwnerPrincipal: "user:test",
		spec,
		nodeKey: "root",
		frontier: { kind: "before-node", sessionId, ts: 1 },
		now: 1,
	});
	const fence = { sessionId, generation: 0, activationId: `act-${suffix}`, sandboxId: `sbx-${suffix}` };
	await runtime.claimAgentMaterialization(sessionId, {
		generation: fence.generation,
		activationId: fence.activationId,
		now: 2,
	});
	await runtime.bindAgentSandbox(sessionId, { ...fence, now: 3 });
	return fence;
}

function inferenceRequest(
	session: { readonly generation: number; readonly activationId: string; readonly sandboxId: string },
	requestId: string,
	now: number,
) {
	const character = (now % 16).toString(16);
	return {
		generation: session.generation,
		activationId: session.activationId,
		sandboxId: session.sandboxId,
		requestId,
		requestDigest: `sha256:${character.repeat(64)}`,
		causationId: `cause-${requestId}`,
		provider: "openrouter",
		model: "mock:done",
		estimatedInputTokens: 10,
		requestedOutputTokens: 90,
		pricingVersion: PRICING_VERSION,
		now,
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

function billingEventFor(
	reservation: AgentSessionInferenceReservationRecord,
	provenance: AgentSessionInferenceBillingProvenance,
	ts: number,
	usage: {
		readonly inputTokens: number;
		readonly outputTokens: number;
	},
) {
	const cost = computeCost(
		reservation.model,
		{
			input: usage.inputTokens,
			output: usage.outputTokens,
			cacheRead: 0,
			cacheWrite: 0,
		},
		reservation.provider,
	);
	return {
		eventId: reservation.operation_id,
		ts,
		userId: provenance.userId,
		graphId: provenance.graphId,
		sandboxId: reservation.sandbox_id,
		template: "sophia-agent",
		sessionId: reservation.session_id,
		generation: reservation.generation,
		inferenceOperationId: reservation.operation_id,
		requestId: reservation.request_id,
		childRunId: provenance.childRunId,
		allocationId: provenance.allocationId,
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

async function admitChild(
	runtime: WorkflowRuntimeStore,
	seeded: SeededParent,
	requestId: string,
	now: number,
): Promise<AcceptedChild> {
	const decision = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
		...seeded.parentFence,
		requestId,
		prompt: `Run ${requestId}.`,
		requestedName: requestId.replaceAll("-", "_"),
		causationId: `cause-${requestId}`,
		now,
	});
	assert.equal(
		decision.decision,
		"accepted",
		decision.decision === "denied"
			? `child ${requestId} was denied: ${decision.request.denial_code} (${decision.request.denial_message})`
			: undefined,
	);
	if (decision.decision !== "accepted") throw new Error(`child ${requestId} was not accepted`);
	return decision;
}

async function completeSimpleChild(
	runtime: WorkflowRuntimeStore,
	admitted: AcceptedChild,
	start: number,
): Promise<void> {
	const childRunClaim = await runtime.claimAgentSessionChildRun(admitted.run.child_run_id, {
		consumer: `worker-${admitted.run.child_run_id}`,
		leaseMs: 100,
		now: start,
	});
	assert.equal(childRunClaim.claimed, true);
	const activationId = `act-${admitted.child.session_id}`;
	await runtime.claimAgentSessionChildMaterialization(admitted.run.child_run_id, {
		consumer: childRunClaim.run.consumer!,
		claimToken: childRunClaim.run.claim_token!,
		generation: 0,
		activationId,
		now: start + 1,
	});
	await runtime.bindAgentSandbox(admitted.child.session_id, {
		generation: 0,
		activationId,
		sandboxId: `sbx-${admitted.child.session_id}`,
		childRunConsumer: childRunClaim.run.consumer!,
		childRunClaimToken: childRunClaim.run.claim_token!,
		now: start + 2,
	});
	const result = await recordChildOutcome(runtime, admitted, childRunClaim, activationId, "done", start + 3);
	await runtime.finishAgentMaterialization(admitted.child.session_id, 0, {
		activationId,
		from: "running",
		to: "completed",
		now: start + 4,
	});
	await runtime.settleAgentSessionChildRun(admitted.run.child_run_id, {
		consumer: childRunClaim.run.consumer!,
		claimToken: childRunClaim.run.claim_token!,
		status: "completed",
		terminalPolicy: "close",
		materializationGeneration: 0,
		materializationState: "completed",
		result,
		now: start + 5,
	});
}

async function materializeAndPassivate(
	runtime: WorkflowRuntimeStore,
	admitted: AcceptedChild,
	generation: number,
	suffix: string,
	start: number,
): Promise<void> {
	const activationId = `act-${suffix}`;
	const sandboxId = `sbx-${suffix}`;
	assert.equal(generation, 0, "this helper materializes the admitted child-run generation");
	const childRunClaim = await runtime.claimAgentSessionChildRun(admitted.run.child_run_id, {
		consumer: `resident-worker-${admitted.run.child_run_id}`,
		leaseMs: 100,
		now: start,
	});
	assert.equal(childRunClaim.claimed, true);
	await runtime.claimAgentSessionChildMaterialization(admitted.run.child_run_id, {
		consumer: childRunClaim.run.consumer!,
		claimToken: childRunClaim.run.claim_token!,
		generation,
		activationId,
		now: start,
	});
	await runtime.bindAgentSandbox(admitted.child.session_id, {
		generation,
		activationId,
		sandboxId,
		childRunConsumer: childRunClaim.run.consumer!,
		childRunClaimToken: childRunClaim.run.claim_token!,
		now: start + 1,
	});
	const kernelSandboxId = `kernel-${suffix}`;
	await runtime.beginAgentSessionKernelLaunch(admitted.child.session_id, generation, {
		activationId,
		sandboxId: kernelSandboxId,
		now: start + 2,
	});
	await runtime.bindAgentSessionKernelLaunch(admitted.child.session_id, generation, {
		activationId,
		sandboxId: kernelSandboxId,
		now: start + 2,
	});
	await commitCheckpoint(runtime, admitted, generation, sandboxId, start + 2);
	const result = await recordChildOutcome(
		runtime,
		admitted,
		childRunClaim,
		activationId,
		`${suffix} ready`,
		start + 3,
	);
	await runtime.settleAgentSessionChildRun(admitted.run.child_run_id, {
		consumer: childRunClaim.run.consumer!,
		claimToken: childRunClaim.run.claim_token!,
		status: "completed",
		terminalPolicy: "keep_open",
		materializationGeneration: 0,
		materializationState: "running",
		result,
		now: start + 4,
	});
	await runtime.transitionAgentMaterialization(admitted.child.session_id, generation, {
		activationId,
		from: "running",
		to: "quiescing",
		now: start + 5,
	});
	await runtime.transitionAgentMaterialization(admitted.child.session_id, generation, {
		activationId,
		from: "quiescing",
		to: "quiescent",
		now: start + 6,
	});
	await runtime.transitionAgentMaterialization(admitted.child.session_id, generation, {
		activationId,
		from: "quiescent",
		to: "passivated",
		now: start + 7,
	});
	await runtime.recordAgentSessionKernelState(admitted.child.session_id, generation, {
		activationId,
		state: "released",
		now: start + 8,
	});
}

async function recordChildOutcome(
	runtime: WorkflowRuntimeStore,
	admitted: AcceptedChild,
	claim: Awaited<ReturnType<WorkflowRuntimeStore["claimAgentSessionChildRun"]>>,
	activationId: string,
	output: string,
	now: number,
) {
	const result = {
		nodeKey: admitted.spec.nodeKey,
		sessionId: admitted.child.session_id,
		invocationId: admitted.run.child_run_id,
		label: admitted.spec.label,
		phaseIndex: admitted.spec.phaseIndex,
		state: "done" as const,
		output,
		model: admitted.spec.model,
		turns: 1,
		toolCalls: 0,
		tokens: 1,
		queuedAt: admitted.run.created_at,
		startedAt: admitted.run.claimed_at ?? now,
		durationMs: 1,
	};
	await runtime.finishAgentSession(admitted.child.session_id, {
		result,
		status: "completed",
		generation: 0,
		activationId,
		childRunConsumer: claim.run.consumer!,
		childRunClaimToken: claim.run.claim_token!,
		now,
		frontier: {
			kind: "after-node",
			nodeKey: admitted.spec.nodeKey!,
			sessionId: admitted.child.session_id,
			label: admitted.spec.label,
			phaseIndex: admitted.spec.phaseIndex,
			ts: now,
		},
	});
	return result;
}

async function commitCheckpoint(
	runtime: WorkflowRuntimeStore,
	admitted: AcceptedChild,
	generation: number,
	sandboxId: string,
	now: number,
): Promise<void> {
	const document = JSON.parse(admitted.child.document_json) as {
		meaningfulObjects: { agentSession: MeaningfulObjectRefV1<"agent-session"> };
	};
	const checkpointId = `checkpoint-${admitted.child.session_id}-${generation}`;
	const manifest: AgentCheckpointManifestV2 = {
		schema: AGENT_CHECKPOINT_SCHEMA,
		checkpointId,
		agentSession: document.meaningfulObjects.agentSession,
		sessionId: admitted.child.session_id,
		sessionSequence: generation,
		workerSequence: generation + 1,
		generation,
		sandboxId,
		runtimeBindingDigest: admitted.spec.runtimeBindingDigest!,
		ontologyBindingDigest: admitted.spec.ontologyBindingDigest!,
		compatibility: {
			primeStateSchema: PRIME_RUNTIME_STATE_SCHEMA,
			primeBridgeProtocol: PRIME_HOST_PROTOCOL_VERSION,
			runtimeBundleId: admitted.spec.runtime!.bundle.id,
			runtimeBundleDigest: admitted.spec.runtime!.bundle.digest,
			sessionFormatVersion: 3,
		},
		state: {
			schema: SOPHIA_CONTENT_REF_SCHEMA,
			uri: `file:///tmp/${checkpointId}`,
			digest: `sha256:${"0".repeat(64)}`,
			bytes: 0,
			mediaType: "application/vnd.sophia.prime-runtime-state+json",
		},
		stateDigest: `sha256:${"1".repeat(64)}`,
		causationId: `cause-${checkpointId}`,
		createdAt: new Date(now).toISOString(),
	};
	await runtime.commitAgentCheckpoint({
		manifest,
		object: createMeaningfulObjectRef({
			kind: "agent-checkpoint",
			ownerPrincipal: admitted.child.owner_user_id,
			graphId: admitted.child.graph_id,
			objectId: checkpointId,
			version: `${generation}:${generation}`,
			value: manifest,
		}),
	});
}

function zeroBudget() {
	return { turns: 0, wallTimeMs: 0, tokens: 0, costUsdMicros: 0, artifactBytes: 0 };
}
