import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	type AgentRuntimeConstraintsV2,
	type AgentRuntimeKind,
	digestAgentRuntimeBinding,
} from "../agent-runtime/profile.js";
import { PRICING_VERSION } from "../billing-pricing.js";
import {
	AgentSessionChildAdmissionFault,
	AgentSessionChildRunFault,
	stableAgentSessionChildId,
	stableAgentSessionChildRunId,
	WorkflowRuntimeStore,
} from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

describe("host-owned child admission", () => {
	it("atomically persists the trusted child, decision, binding evidence, budget reservation, and run", async () => {
		await withRuntime(async (runtime) => {
			const seeded = await seedDomainParent(runtime);
			const result = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
				...seeded.parentFence,
				requestId: "rlm-request-1",
				prompt: "Investigate the source testimony.",
				requestedName: "source_audit",
				requestedModel: seeded.childModel,
				causationId: "kernel-host-request-1",
				now: 20,
			});
			assert.equal(result.decision, "accepted");
			if (result.decision !== "accepted") return;

			assert.equal(result.created, true);
			assert.equal(result.child.session_id, stableAgentSessionChildId(seeded.parentSessionId, "rlm-request-1"));
			assert.equal(result.run.child_run_id, stableAgentSessionChildRunId(seeded.parentSessionId, "rlm-request-1"));
			assert.equal(result.admission.child_run_id, result.run.child_run_id);
			assert.equal(result.request.child_run_id, result.run.child_run_id);
			assert.equal(result.child.owner_user_id, seeded.ownerUserId);
			assert.equal(result.child.graph_id, seeded.graphId);
			assert.equal(result.child.agent_id, seeded.agentId, "a child Session preserves the registered Agent identity");
			assert.equal(result.admission.child_name, "source_audit");
			assert.equal(result.spec.runtime?.kind, "simple");
			assert.equal(result.spec.runtime?.constraints.allowPersistentKernel, false);
			assert.equal(result.spec.runtime?.constraints.maxChildren, 0);
			assert.equal(result.spec.runtime?.constraints.maxChildDepth, 0);
			assert.equal(result.spec.runtime?.constraints.maxConcurrentChildren, 0);
			assert.equal(result.spec.depth, 1);
			assert.equal(result.spec.graphAccess, "read");
			assert.equal(result.spec.model, seeded.childModel);
			assert.equal(result.spec.agentId, seeded.agentId);
			assert.deepEqual(result.spec.includeTools, ["recall"]);
			assert.equal(result.allocation.state, "reserved");
			assert.equal(result.run.state, "queued");

			const document = JSON.parse(result.child.document_json) as Record<string, any>;
			assert.equal(document.source.kind, "child-admission");
			assert.equal(document.source.parentSessionId, seeded.parentSessionId);
			assert.equal(document.source.relationId, result.relation.relation_id);
			assert.equal(document.source.admissionId, result.admission.admission_id);
			assert.equal(document.source.childRunId, result.run.child_run_id);
			assert.notEqual(document.source.kind, "workflow-node");
			assert.equal(document.meaningfulObjects.workflowNode, undefined);
			assert.equal(document.source.nodeKey, undefined);
			assert.equal(document.source.phaseIndex, undefined);
			assert.equal(document.source.runId, undefined);
			assert.equal(document.source.workflowName, undefined);
			assert.equal(document.source.graphId, undefined);
			assert.deepEqual(document.source.workflowOrigin, {
				runId: seeded.runId,
				workflowName: seeded.workflowName,
				graphId: seeded.graphId,
			});

			const childEvents = (await runtime.listAgentSessionEvents(seeded.parentSessionId)).filter((event) =>
				event.type.startsWith("child."),
			);
			assert.deepEqual(
				childEvents.map((event) => event.type),
				["child.spawn_requested", "child.created"],
			);
			assert.deepEqual(childEvents[0]?.payload, {
				schema: "choreograph.agent-session-child-spawn-requested.v1",
				requestId: "rlm-request-1",
				causationId: "kernel-host-request-1",
				decision: "accepted",
				admissionId: result.admission.admission_id,
				childSessionId: result.child.session_id,
				childRunId: result.run.child_run_id,
				childName: "source_audit",
			});
			assert.deepEqual(childEvents[1]?.payload, {
				schema: "choreograph.agent-session-child-created.v1",
				admissionId: result.admission.admission_id,
				relationId: result.relation.relation_id,
				requestId: "rlm-request-1",
				causationId: "kernel-host-request-1",
				parentSessionId: seeded.parentSessionId,
				childSessionId: result.child.session_id,
				childRunId: result.run.child_run_id,
				childName: "source_audit",
				depth: 1,
				runtimeKind: "simple",
				runtimeBindingDigest: result.admission.runtime_binding_digest,
				ontologyBindingDigest: result.admission.ontology_binding_digest,
				budgetAllocationId: result.allocation.allocation_id,
				budgetSlice: result.allocation.budget,
			});

			const childRunClaim = await runtime.claimAgentSessionChildRun(result.run.child_run_id, {
				consumer: "billing-provenance-worker",
				leaseMs: 100,
				now: 21,
			});
			assert.equal(childRunClaim.claimed, true);
			await runtime.claimAgentSessionChildMaterialization(result.run.child_run_id, {
				consumer: childRunClaim.run.consumer!,
				claimToken: childRunClaim.run.claim_token!,
				generation: 0,
				activationId: "act-child-billing-provenance",
				now: 21,
			});
			await runtime.bindAgentSandbox(result.child.session_id, {
				generation: 0,
				activationId: "act-child-billing-provenance",
				sandboxId: "sbx-child-billing-provenance",
				childRunConsumer: childRunClaim.run.consumer!,
				childRunClaimToken: childRunClaim.run.claim_token!,
				now: 22,
			});
			const inference = await runtime.reserveAgentSessionInferenceBudget(result.child.session_id, {
				generation: 0,
				activationId: "act-child-billing-provenance",
				sandboxId: "sbx-child-billing-provenance",
				requestId: "child-inference-billing-provenance",
				requestDigest: `sha256:${"7".repeat(64)}`,
				causationId: "child-inference-billing-cause",
				provider: "openrouter",
				model: seeded.childModel,
				estimatedInputTokens: 1,
				requestedOutputTokens: 1,
				pricingVersion: PRICING_VERSION,
				now: 23,
			});
			assert.deepEqual(inference.billingProvenance, {
				userId: seeded.ownerUserId,
				graphId: seeded.graphId,
				childRunId: result.run.child_run_id,
				allocationId: result.allocation.allocation_id,
			});
		});
	});

	it("admits an attenuated Prime child only with the parent's persistent-kernel grant", async () => {
		await withRuntime(async (runtime) => {
			const seeded = await seedDomainParent(runtime, {
				childKind: "prime",
				childConstraintOverrides: { maxChildren: 0, maxChildDepth: 0, maxConcurrentChildren: 0 },
			});
			const admitted = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
				...seeded.parentFence,
				requestId: "rlm-request-prime-child",
				prompt: "Use a persistent notebook to investigate.",
				requestedName: "prime_researcher",
				causationId: "kernel-host-request-prime-child",
				now: 25,
			});
			assert.equal(admitted.decision, "accepted");
			if (admitted.decision !== "accepted") return;
			assert.equal(admitted.spec.runtime?.kind, "prime");
			assert.equal(admitted.spec.runtime?.constraints.allowPersistentKernel, true);
			assert.equal(admitted.spec.runtime?.constraints.maxChildren, 0);
			assert.equal(admitted.spec.runtime?.constraints.maxChildDepth, 0);
			assert.equal(admitted.spec.runtime?.constraints.maxConcurrentChildren, 0);
			assert.equal(admitted.spec.depth, 1);
			const created = (await runtime.listAgentSessionEvents(seeded.parentSessionId)).find(
				(event) => event.type === "child.created",
			);
			assert.equal((created?.payload as { runtimeKind?: unknown }).runtimeKind, "prime");
		});
	});

	it("denies Prime kernel widening and pre-F4 recursive child authority without partial state", async () => {
		for (const testCase of [
			{
				requestId: "prime-kernel-widening",
				expectedDenial: "binding_widening",
				options: {
					childKind: "prime" as const,
					parentConstraintOverrides: { allowPersistentKernel: false },
					childConstraintOverrides: { maxChildren: 0, maxChildDepth: 0, maxConcurrentChildren: 0 },
				},
			},
			{
				requestId: "prime-recursive-authority",
				expectedDenial: "max_child_depth_exhausted",
				options: { childKind: "prime" as const },
			},
			{
				requestId: "numeric-authority-widening",
				expectedDenial: "binding_widening",
				options: { parentConstraintOverrides: { maxTurns: 5 } },
			},
		] as const) {
			await withRuntime(async (runtime) => {
				const seeded = await seedDomainParent(runtime, testCase.options);
				const denied = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
					...seeded.parentFence,
					requestId: testCase.requestId,
					prompt: "Attempt authority widening.",
					causationId: `cause-${testCase.requestId}`,
					now: 26,
				});
				assert.equal(denied.decision, "denied");
				if (denied.decision === "denied") {
					assert.equal(denied.request.denial_code, testCase.expectedDenial);
				}
				assert.equal(
					await runtime.readAgentSession(stableAgentSessionChildId(seeded.parentSessionId, testCase.requestId)),
					null,
				);
				assert.deepEqual(await runtime.listAgentSessionChildren(seeded.parentSessionId), []);
			});
		}
	});

	it("replays an accepted request without duplicating any durable fact and rejects changed content", async () => {
		await withRuntime(async (runtime) => {
			const seeded = await seedDomainParent(runtime);
			const request = {
				...seeded.parentFence,
				requestId: "rlm-request-replay",
				prompt: "Read only.",
				requestedName: "reader",
				causationId: "kernel-host-request-replay",
				now: 30,
			} as const;
			const first = await runtime.admitAgentSessionChild(seeded.parentSessionId, request);
			const replay = await runtime.admitAgentSessionChild(seeded.parentSessionId, { ...request, now: 31 });
			assert.equal(first.decision, "accepted");
			assert.equal(replay.decision, "accepted");
			assert.equal(replay.created, false);
			if (first.decision === "accepted" && replay.decision === "accepted") {
				assert.equal(replay.child.session_id, first.child.session_id);
				assert.equal(replay.run.child_run_id, first.run.child_run_id);
				assert.equal(replay.allocation.allocation_id, first.allocation.allocation_id);
			}
			assert.equal((await runtime.listAgentSessionChildren(seeded.parentSessionId)).length, 1);
			assert.equal(
				(await runtime.listAgentSessionEvents(seeded.parentSessionId)).filter((event) =>
					event.type.startsWith("child."),
				).length,
				2,
			);
			await assert.rejects(
				runtime.admitAgentSessionChild(seeded.parentSessionId, {
					...request,
					prompt: "Different content under the same request identity.",
					now: 32,
				}),
				(error: unknown) => error instanceof AgentSessionChildAdmissionFault && error.reason === "request_conflict",
			);
			await assert.rejects(
				runtime.admitAgentSessionChild(seeded.parentSessionId, {
					...request,
					causationId: "different-kernel-host-request",
					now: 33,
				}),
				(error: unknown) => error instanceof AgentSessionChildAdmissionFault && error.reason === "request_conflict",
			);
		});
	});

	it("durably and idempotently denies model privilege widening without partial child state", async () => {
		await withRuntime(async (runtime) => {
			const seeded = await seedDomainParent(runtime);
			const request = {
				...seeded.parentFence,
				requestId: "rlm-request-denied",
				prompt: "Try to widen the model binding.",
				requestedModel: "openai/gpt-9-admin",
				causationId: "kernel-host-request-denied",
				now: 40,
			} as const;
			const denied = await runtime.admitAgentSessionChild(seeded.parentSessionId, request);
			const replay = await runtime.admitAgentSessionChild(seeded.parentSessionId, { ...request, now: 41 });
			assert.equal(denied.decision, "denied");
			assert.equal(replay.decision, "denied");
			assert.equal(replay.created, false);
			if (denied.decision === "denied") assert.equal(denied.request.denial_code, "model_not_granted");
			assert.equal(
				await runtime.readAgentSession(stableAgentSessionChildId(seeded.parentSessionId, request.requestId)),
				null,
			);
			assert.equal(
				await runtime.readAgentSessionChildRun(
					stableAgentSessionChildRunId(seeded.parentSessionId, request.requestId),
				),
				null,
			);
			assert.deepEqual(await runtime.listAgentSessionChildren(seeded.parentSessionId), []);
			const childEvents = (await runtime.listAgentSessionEvents(seeded.parentSessionId)).filter((event) =>
				event.type.startsWith("child."),
			);
			assert.equal(childEvents.length, 1);
			assert.equal(childEvents[0]?.type, "child.spawn_requested");
			assert.equal((childEvents[0]?.payload as any).decision, "denied");
		});
	});

	it("durably and idempotently denies a duplicate sibling name", async () => {
		await withRuntime(async (runtime) => {
			const seeded = await seedDomainParent(runtime);
			const first = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
				...seeded.parentFence,
				requestId: "rlm-request-first-name",
				prompt: "First child.",
				requestedName: "reader",
				causationId: "kernel-host-request-first-name",
				now: 45,
			});
			assert.equal(first.decision, "accepted");

			const duplicateRequest = {
				...seeded.parentFence,
				requestId: "rlm-request-duplicate-name",
				prompt: "Second child with the same name.",
				requestedName: "reader",
				causationId: "kernel-host-request-duplicate-name",
				now: 46,
			} as const;
			const denied = await runtime.admitAgentSessionChild(seeded.parentSessionId, duplicateRequest);
			const replay = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
				...duplicateRequest,
				now: 47,
			});
			assert.equal(denied.decision, "denied");
			assert.equal(replay.decision, "denied");
			assert.equal(replay.created, false);
			if (denied.decision === "denied") assert.equal(denied.request.denial_code, "child_name_conflict");
			assert.equal(
				await runtime.readAgentSession(
					stableAgentSessionChildId(seeded.parentSessionId, duplicateRequest.requestId),
				),
				null,
			);
			assert.equal(
				await runtime.readAgentSessionChildRun(
					stableAgentSessionChildRunId(seeded.parentSessionId, duplicateRequest.requestId),
				),
				null,
			);
			assert.equal((await runtime.listAgentSessionChildren(seeded.parentSessionId)).length, 1);
			assert.deepEqual(
				(await runtime.listAgentSessionEvents(seeded.parentSessionId))
					.filter((event) => event.type.startsWith("child."))
					.map((event) => [event.type, (event.payload as any).decision]),
				[
					["child.spawn_requested", "accepted"],
					["child.created", undefined],
					["child.spawn_requested", "denied"],
				],
			);
		});
	});

	it("rejects every unbounded or malformed request field before hashing or persistence", async () => {
		await withRuntime(async (runtime) => {
			const seeded = await seedDomainParent(runtime);
			const invalidRequests: Array<Record<string, unknown>> = [
				{
					requestId: "oversized-prompt",
					prompt: "é".repeat(32_769),
					causationId: "cause-oversized-prompt",
					now: 48,
				},
				{
					requestId: `r${"x".repeat(128)}`,
					prompt: "Read.",
					causationId: "cause-request-id",
					now: 48,
				},
				{
					requestId: "invalid-causation",
					prompt: "Read.",
					causationId: "not a bounded id",
					now: 48,
				},
				{
					requestId: "invalid-name",
					prompt: "Read.",
					requestedName: `n${"x".repeat(64)}`,
					causationId: "cause-invalid-name",
					now: 48,
				},
				{
					requestId: "invalid-model",
					prompt: "Read.",
					requestedModel: "model with spaces",
					causationId: "cause-invalid-model",
					now: 48,
				},
				{
					requestId: "oversized-model",
					prompt: "Read.",
					requestedModel: `m${"x".repeat(256)}`,
					causationId: "cause-oversized-model",
					now: 48,
				},
				{
					requestId: "non-string-model",
					prompt: "Read.",
					requestedModel: 123,
					causationId: "cause-non-string-model",
					now: 48,
				},
				{
					requestId: "unknown-field",
					prompt: "Read.",
					causationId: "cause-unknown-field",
					now: 48,
					requestedOwner: "user:mallory",
				},
			];
			for (const request of invalidRequests) {
				await assert.rejects(
					runtime.admitAgentSessionChild(
						seeded.parentSessionId,
						request as unknown as Parameters<WorkflowRuntimeStore["admitAgentSessionChild"]>[1],
					),
					(error: unknown) =>
						error instanceof AgentSessionChildAdmissionFault && error.reason === "request_invalid",
				);
			}
			assert.deepEqual(await runtime.listAgentSessionChildren(seeded.parentSessionId), []);
			assert.equal(
				(await runtime.listAgentSessionEvents(seeded.parentSessionId)).filter((event) =>
					event.type.startsWith("child."),
				).length,
				0,
			);
			assert.equal(
				await runtime.readAgentSessionChildSpawnRequest(seeded.parentSessionId, "oversized-prompt"),
				null,
			);
		});
	});

	it("claims once and settles the run and its durable budget exactly once", async () => {
		await withRuntime(async (runtime) => {
			const seeded = await seedDomainParent(runtime);
			const admitted = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
				...seeded.parentFence,
				requestId: "rlm-request-run",
				prompt: "Return a finding.",
				causationId: "kernel-host-request-run",
				now: 50,
			});
			assert.equal(admitted.decision, "accepted");
			if (admitted.decision !== "accepted") return;
			const firstClaim = await runtime.claimAgentSessionChildRun(admitted.run.child_run_id, {
				consumer: "simple-child-worker",
				leaseMs: 100,
				now: 51,
			});
			const duplicateClaim = await runtime.claimAgentSessionChildRun(admitted.run.child_run_id, {
				consumer: "duplicate-simple-child-worker",
				leaseMs: 100,
				now: 52,
			});
			assert.equal(firstClaim.claimed, true);
			assert.equal(duplicateClaim.claimed, false);
			assert.equal(firstClaim.spec.invocationId, admitted.run.child_run_id);
			assert.equal(firstClaim.spec.depth, 1);
			await runtime.claimAgentSessionChildMaterialization(admitted.run.child_run_id, {
				consumer: firstClaim.run.consumer!,
				claimToken: firstClaim.run.claim_token!,
				generation: 0,
				activationId: "act-simple-child",
				now: 53,
			});
			await runtime.bindAgentSandbox(admitted.child.session_id, {
				generation: 0,
				activationId: "act-simple-child",
				sandboxId: "sbx-simple-child",
				childRunConsumer: firstClaim.run.consumer!,
				childRunClaimToken: firstClaim.run.claim_token!,
				now: 54,
			});
			const result = await recordChildOutcome(runtime, admitted, firstClaim, "act-simple-child", "finding", 58);
			await runtime.finishAgentMaterialization(admitted.child.session_id, 0, {
				activationId: "act-simple-child",
				from: "running",
				to: "completed",
				now: 59,
			});
			const settled = await runtime.settleAgentSessionChildRun(admitted.run.child_run_id, {
				consumer: firstClaim.run.consumer!,
				claimToken: firstClaim.run.claim_token!,
				status: "completed",
				terminalPolicy: "close",
				materializationGeneration: 0,
				materializationState: "completed",
				result,
				now: 60,
			});
			const replay = await runtime.settleAgentSessionChildRun(admitted.run.child_run_id, {
				consumer: firstClaim.run.consumer!,
				claimToken: firstClaim.run.claim_token!,
				status: "completed",
				terminalPolicy: "close",
				materializationGeneration: 0,
				materializationState: "completed",
				result,
				now: 61,
			});
			assert.equal(settled.applied, true);
			assert.equal(replay.applied, false);
			assert.equal((await runtime.readAgentSessionChildRun(admitted.run.child_run_id))?.state, "completed");
			assert.equal(
				(await runtime.readAgentSessionChildBudgetAllocation(admitted.allocation.allocation_id))?.state,
				"settled",
			);
			assert.equal(
				(await runtime.listAgentSessionEvents(seeded.parentSessionId)).filter(
					(event) => event.type === "child.run.completed",
				).length,
				1,
			);
		});
	});

	it("refuses completed run settlement when the simple child body faulted", async () => {
		await withRuntime(async (runtime) => {
			const seeded = await seedDomainParent(runtime);
			const admitted = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
				...seeded.parentFence,
				requestId: "rlm-request-faulted-completed-mismatch",
				prompt: "Fault before reporting completion.",
				causationId: "kernel-host-request-faulted-completed-mismatch",
				now: 62,
			});
			assert.equal(admitted.decision, "accepted");
			if (admitted.decision !== "accepted") return;
			const childRunClaim = await runtime.claimAgentSessionChildRun(admitted.run.child_run_id, {
				consumer: "faulted-simple-child-worker",
				leaseMs: 100,
				now: 63,
			});
			assert.equal(childRunClaim.claimed, true);
			await runtime.claimAgentSessionChildMaterialization(admitted.run.child_run_id, {
				consumer: childRunClaim.run.consumer!,
				claimToken: childRunClaim.run.claim_token!,
				generation: 0,
				activationId: "act-faulted-simple-child",
				now: 64,
			});
			await runtime.bindAgentSandbox(admitted.child.session_id, {
				generation: 0,
				activationId: "act-faulted-simple-child",
				sandboxId: "sbx-faulted-simple-child",
				childRunConsumer: childRunClaim.run.consumer!,
				childRunClaimToken: childRunClaim.run.claim_token!,
				now: 65,
			});
			await runtime.finishAgentMaterialization(admitted.child.session_id, 0, {
				activationId: "act-faulted-simple-child",
				from: "running",
				to: "faulted",
				faultKind: "worker_exit",
				recoverable: false,
				now: 66,
			});
			await assert.rejects(
				runtime.settleAgentSessionChildRun(admitted.run.child_run_id, {
					consumer: childRunClaim.run.consumer!,
					claimToken: childRunClaim.run.claim_token!,
					status: "completed",
					terminalPolicy: "close",
					materializationGeneration: 0,
					materializationState: "faulted",
					result: { output: "dishonest success" },
					now: 67,
				}),
				(error: unknown) =>
					error instanceof AgentSessionChildRunFault && error.reason === "materialization_conflict",
			);
			assert.equal((await runtime.readAgentSessionChildRun(admitted.run.child_run_id))?.state, "claimed");
			assert.equal(
				(await runtime.readAgentSessionChildBudgetAllocation(admitted.allocation.allocation_id))?.state,
				"reserved",
			);
		});
	});

	it("enforces lifetime and generation occupancy independently under concurrent admission", async () => {
		await withRuntime(async (runtime) => {
			const seeded = await seedDomainParent(runtime, {
				parentConstraintOverrides: { maxChildren: 2, maxConcurrentChildren: 1 },
			});
			const first = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
				...seeded.parentFence,
				requestId: "occupancy-first",
				prompt: "First.",
				causationId: "cause-occupancy-first",
				now: 70,
			});
			assert.equal(first.decision, "accepted");
			if (first.decision !== "accepted") return;
			const concurrent = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
				...seeded.parentFence,
				requestId: "occupancy-concurrent-denied",
				prompt: "Compete.",
				causationId: "cause-occupancy-concurrent",
				now: 71,
			});
			assert.equal(concurrent.decision, "denied");
			if (concurrent.decision === "denied") {
				assert.equal(concurrent.request.denial_code, "max_concurrent_children_exhausted");
			}
			await completeSimpleChild(runtime, first, 72);
			assert.equal(
				(await runtime.readAgentSessionChildGenerationOccupancy(first.child.session_id, 0))?.state,
				"released",
			);

			const second = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
				...seeded.parentFence,
				requestId: "occupancy-second",
				prompt: "Second.",
				causationId: "cause-occupancy-second",
				now: 80,
			});
			assert.equal(second.decision, "accepted");
			const lifetime = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
				...seeded.parentFence,
				requestId: "occupancy-lifetime-denied",
				prompt: "Third.",
				causationId: "cause-occupancy-lifetime",
				now: 81,
			});
			assert.equal(lifetime.decision, "denied");
			if (lifetime.decision === "denied") {
				assert.equal(lifetime.request.denial_code, "max_children_exhausted");
			}
		});
	});

	it("carves cumulative child cost atomically and returns only verified unused simple capacity", async () => {
		await withRuntime(async (runtime) => {
			const seeded = await seedDomainParent(runtime, {
				parentConstraintOverrides: {
					maxChildren: 3,
					maxConcurrentChildren: 2,
					maxCostUsdMicros: 750_000,
				},
			});
			const first = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
				...seeded.parentFence,
				requestId: "cost-first",
				prompt: "First cost slice.",
				causationId: "cause-cost-first",
				now: 90,
			});
			assert.equal(first.decision, "accepted");
			if (first.decision !== "accepted") return;
			const denied = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
				...seeded.parentFence,
				requestId: "cost-denied",
				prompt: "Second overlapping cost slice.",
				causationId: "cause-cost-denied",
				now: 91,
			});
			assert.equal(denied.decision, "denied");
			if (denied.decision === "denied") {
				assert.equal(denied.request.denial_code, "child_cost_budget_exhausted");
			}
			await completeSimpleChild(runtime, first, 92);
			const account = await runtime.readAgentSessionBudgetSnapshot(seeded.parentSessionId);
			assert.equal(account?.account.reserved.costUsdMicros, 0);
			assert.equal(account?.account.spent.costUsdMicros, 0);
			assert.deepEqual(
				account?.entries.map((entry) => entry.kind),
				["account_opened", "child_allocated", "child_settled"],
			);
			const afterReconciliation = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
				...seeded.parentFence,
				requestId: "cost-after-reconciliation",
				prompt: "Use verified returned capacity.",
				causationId: "cause-cost-after-reconciliation",
				now: 100,
			});
			assert.equal(afterReconciliation.decision, "accepted");
		});
	});

	it("keeps a resident Prime allocation and occupancy open after its initial run settles", async () => {
		await withRuntime(async (runtime) => {
			const seeded = await seedDomainParent(runtime, {
				childKind: "prime",
				childConstraintOverrides: { maxChildren: 0, maxChildDepth: 0, maxConcurrentChildren: 0 },
			});
			const admitted = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
				...seeded.parentFence,
				requestId: "resident-prime-budget",
				prompt: "Remain resident.",
				causationId: "cause-resident-prime-budget",
				now: 110,
			});
			assert.equal(admitted.decision, "accepted");
			if (admitted.decision !== "accepted") return;
			const childRunClaim = await runtime.claimAgentSessionChildRun(admitted.run.child_run_id, {
				consumer: "resident-prime-worker",
				leaseMs: 100,
				now: 111,
			});
			assert.equal(childRunClaim.claimed, true);
			await runtime.claimAgentSessionChildMaterialization(admitted.run.child_run_id, {
				consumer: childRunClaim.run.consumer!,
				claimToken: childRunClaim.run.claim_token!,
				generation: 0,
				activationId: "act-resident-prime",
				now: 112,
			});
			await runtime.bindAgentSandbox(admitted.child.session_id, {
				generation: 0,
				activationId: "act-resident-prime",
				sandboxId: "sbx-resident-prime",
				childRunConsumer: childRunClaim.run.consumer!,
				childRunClaimToken: childRunClaim.run.claim_token!,
				now: 113,
			});
			const result = await recordChildOutcome(
				runtime,
				admitted,
				childRunClaim,
				"act-resident-prime",
				"initial result",
				114,
			);
			await runtime.settleAgentSessionChildRun(admitted.run.child_run_id, {
				consumer: childRunClaim.run.consumer!,
				claimToken: childRunClaim.run.claim_token!,
				status: "completed",
				terminalPolicy: "keep_open",
				materializationGeneration: 0,
				materializationState: "running",
				result,
				now: 115,
			});
			assert.equal(
				(await runtime.readAgentSessionChildBudgetAllocation(admitted.allocation.allocation_id))?.state,
				"reserved",
			);
			assert.equal(
				(await runtime.readAgentSessionChildGenerationOccupancy(admitted.child.session_id, 0))?.state,
				"occupied",
			);
		});
	});

	it("durably denies a stale parent body fence before any child or allocation exists", async () => {
		await withRuntime(async (runtime) => {
			const seeded = await seedDomainParent(runtime);
			const request = {
				...seeded.parentFence,
				parentSandboxId: "sbx-stale-parent",
				requestId: "stale-parent-fence",
				prompt: "Do not admit this.",
				causationId: "cause-stale-parent-fence",
				now: 120,
			} as const;
			const denied = await runtime.admitAgentSessionChild(seeded.parentSessionId, request);
			assert.equal(denied.decision, "denied");
			if (denied.decision === "denied") assert.equal(denied.request.denial_code, "parent_generation_stale");
			assert.deepEqual(await runtime.listAgentSessionChildren(seeded.parentSessionId), []);
			assert.deepEqual(
				(await runtime.readAgentSessionBudgetSnapshot(seeded.parentSessionId))?.entries.map((entry) => entry.kind),
				["account_opened"],
			);
			await assert.rejects(
				runtime.admitAgentSessionChild(seeded.parentSessionId, {
					...request,
					...seeded.parentFence,
					now: 121,
				}),
				(error: unknown) => error instanceof AgentSessionChildAdmissionFault && error.reason === "request_conflict",
			);
		});
	});

	it("attenuates remaining depth and refuses to invent a nested host binding", async () => {
		await withRuntime(async (runtime) => {
			const seeded = await seedDomainParent(runtime, {
				childKind: "prime",
				childConstraintOverrides: { maxChildren: 1, maxChildDepth: 1, maxConcurrentChildren: 1 },
			});
			const admitted = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
				...seeded.parentFence,
				requestId: "remaining-depth-child",
				prompt: "Hold exactly one remaining depth.",
				causationId: "cause-remaining-depth-child",
				now: 130,
			});
			assert.equal(admitted.decision, "accepted");
			if (admitted.decision !== "accepted") return;
			assert.equal(admitted.spec.runtime?.constraints.maxChildDepth, 1);
			const childFence = {
				parentGeneration: 0,
				parentActivationId: "act-nested-parent",
				parentSandboxId: "sbx-nested-parent",
			} as const;
			const childRunClaim = await runtime.claimAgentSessionChildRun(admitted.run.child_run_id, {
				consumer: "nested-parent-worker",
				leaseMs: 100,
				now: 130,
			});
			assert.equal(childRunClaim.claimed, true);
			await runtime.claimAgentSessionChildMaterialization(admitted.run.child_run_id, {
				consumer: childRunClaim.run.consumer!,
				claimToken: childRunClaim.run.claim_token!,
				generation: 0,
				activationId: childFence.parentActivationId,
				now: 131,
			});
			await runtime.bindAgentSandbox(admitted.child.session_id, {
				generation: 0,
				activationId: childFence.parentActivationId,
				sandboxId: childFence.parentSandboxId,
				childRunConsumer: childRunClaim.run.consumer!,
				childRunClaimToken: childRunClaim.run.claim_token!,
				now: 132,
			});
			const nested = await runtime.admitAgentSessionChild(admitted.child.session_id, {
				...childFence,
				requestId: "nested-binding-unavailable",
				prompt: "The host has not supplied a truthful next binding.",
				causationId: "cause-nested-binding-unavailable",
				now: 133,
			});
			assert.equal(nested.decision, "denied");
			if (nested.decision === "denied") assert.equal(nested.request.denial_code, "children_not_granted");
			assert.deepEqual(await runtime.listAgentSessionChildren(admitted.child.session_id), []);
		});
	});
});

async function completeSimpleChild(
	runtime: WorkflowRuntimeStore,
	admitted: Extract<Awaited<ReturnType<WorkflowRuntimeStore["admitAgentSessionChild"]>>, { decision: "accepted" }>,
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

async function recordChildOutcome(
	runtime: WorkflowRuntimeStore,
	admitted: Extract<Awaited<ReturnType<WorkflowRuntimeStore["admitAgentSessionChild"]>>, { decision: "accepted" }>,
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

async function withRuntime(run: (runtime: WorkflowRuntimeStore) => Promise<void>): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "agent-child-admission-"));
	const runtime = new WorkflowRuntimeStore(join(directory, "runtime.sqlite"));
	try {
		await runtime.init();
		await run(runtime);
	} finally {
		runtime.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

interface SeedDomainParentOptions {
	readonly childKind?: AgentRuntimeKind;
	readonly parentConstraintOverrides?: Partial<AgentRuntimeConstraintsV2>;
	readonly childConstraintOverrides?: Partial<AgentRuntimeConstraintsV2>;
}

async function seedDomainParent(
	runtime: WorkflowRuntimeStore,
	options: SeedDomainParentOptions = {},
): Promise<{
	parentSessionId: string;
	ownerUserId: string;
	graphId: string;
	agentId: string;
	childModel: string;
	runId: string;
	workflowName: string;
	parentFence: {
		readonly parentGeneration: number;
		readonly parentActivationId: string;
		readonly parentSandboxId: string;
	};
}> {
	const parentSessionId = "ags-domain-parent";
	const ownerUserId = "user:ada";
	const graphId = "prime-notebook-lab";
	const runId = "wfr-domain-parent";
	const workflowName = "domain-agent-activity-loop-v1";
	const registeredName = "phanes";
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
	const childModel = "mock:done";
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
				systemPrompt: "You are Phanes.",
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
		parentActivationId: "act-domain-parent",
		parentSandboxId: "sbx-domain-parent",
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
	return {
		parentSessionId,
		ownerUserId,
		graphId,
		agentId: pilot.agentId,
		childModel,
		runId,
		workflowName,
		parentFence,
	};
}
