import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Store, type Term } from "oxigraph";
import {
	agentSessionFamilyRelationIri,
	buildAgentSessionFamilyProjection,
	buildAgentSessionFamilyProjectionRetirement,
	projectAgentSessionFamilyFromStore,
} from "../agent-runtime/agent-session-family-graph-projection.js";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { mintAgentSessionUri, mintStandaloneAgentId } from "../agent-subject/agent-ontology.js";
import { type AgentSessionFamilyProjectionSnapshot, WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeResult, AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

const GRAPH_ID = "prime-notebook-lab";
const USER_GRAPH = `urn:mnemosyne:local:graph:${GRAPH_ID}:user:rdf`;
const AGENT_ID = mintStandaloneAgentId({ name: "phanes" });
const ROOT_ID = "ags_parent_family";
const CHILD_ID = "ags_child_research";
const GRANDCHILD_ID = "ags_grandchild_sources";
const SIBLING_ID = "ags_child_review";
const ROOT_IRI = mintAgentSessionUri(AGENT_ID, ROOT_ID);
const CHILD_IRI = mintAgentSessionUri(AGENT_ID, CHILD_ID);
const GRANDCHILD_IRI = mintAgentSessionUri(AGENT_ID, GRANDCHILD_ID);
const RELATION_ONE = `asr_${"1".repeat(64)}`;
const RELATION_TWO = `asr_${"2".repeat(64)}`;

function fixtureSnapshot(projectionRevision = 42): AgentSessionFamilyProjectionSnapshot {
	return {
		projectionRevision,
		root: {
			sessionId: ROOT_ID,
			agentId: AGENT_ID,
			graphId: GRAPH_ID,
			sessionState: "open",
			materializationState: "running",
			materializationGeneration: 3,
			materializationFaultKind: null,
			materializationRecoverable: null,
			workerState: "running",
			kernelState: "running",
			directAcceptedChildren: 1,
			maxChildren: 4,
			occupiedChildren: 1,
			maxConcurrentChildren: 2,
			budgetCostSpentUsdMicros: 25_000,
			budgetCostReservedUsdMicros: 250_000,
			budgetCostRemainingUsdMicros: 725_000,
			budgetCostMaxUsdMicros: 1_000_000,
			budgetAccountExhausted: false,
			budgetAccountRevision: 7,
		},
		children: [
			{
				relationId: RELATION_TWO,
				parentSessionId: CHILD_ID,
				child: {
					sessionId: GRANDCHILD_ID,
					agentId: AGENT_ID,
					graphId: GRAPH_ID,
					sessionState: "open",
				},
				childName: "sources",
				depth: 2,
				registeredAt: Date.parse("2026-08-08T02:00:00.000Z"),
				admission: null,
				childRunState: null,
				materializationState: null,
				materializationGeneration: null,
				materializationFaultKind: null,
				materializationRecoverable: null,
				workerState: null,
				kernelState: null,
			},
			{
				relationId: RELATION_ONE,
				parentSessionId: ROOT_ID,
				child: {
					sessionId: CHILD_ID,
					agentId: AGENT_ID,
					graphId: GRAPH_ID,
					sessionState: "open",
				},
				childName: "research",
				depth: 1,
				registeredAt: Date.parse("2026-08-08T01:00:00.000Z"),
				admission: {
					childName: "research",
					depth: 1,
					runtimeKind: "prime",
					allocationState: "reserved",
					allocationHoldKind: null,
					settledActualCostUsdMicros: null,
					budget: {
						schema: "choreograph.agent-session-child-budget.v1",
						maxTurns: 12,
						maxWallTimeMs: 45_000,
						maxTokens: 8_192,
						maxCostUsdMicros: 250_000,
						maxArtifactBytes: 1_048_576,
					},
				},
				childRunState: "claimed",
				materializationState: "running",
				materializationGeneration: 0,
				materializationFaultKind: null,
				materializationRecoverable: null,
				workerState: "running",
				kernelState: "running",
			},
		],
	};
}

describe("Agent Session family graph projection", () => {
	it("serializes Shrubbery r20260808 exactly and executes its Face shape in Oxigraph", () => {
		const snapshot = fixtureSnapshot();
		const first = buildAgentSessionFamilyProjection(snapshot);
		assert.equal(first, buildAgentSessionFamilyProjection(snapshot));
		assert.match(first, new RegExp(`GRAPH <${USER_GRAPH}>`));
		assert.match(first, new RegExp(`<${ROOT_IRI}> a agt:Session`));
		assert.doesNotMatch(first, /ar:sessionStatus/);
		for (const predicate of [
			"ar:sessionState",
			"ar:projectionRevision",
			"ar:parentSession",
			"ar:childSession",
			"ar:childName",
			"ar:depth",
			"ar:registrationStatus",
			"ar:admissionStatus",
			"ar:runtimeKind",
			"ar:childRunState",
			"ar:allocationState",
			"ar:materializationGeneration",
			"ar:materializationState",
			"ar:workerState",
			"ar:kernelState",
			"ar:directAcceptedChildren",
			"ar:maxChildren",
			"ar:occupiedChildren",
			"ar:maxConcurrentChildren",
			"ar:budgetCostSpentUsdMicros",
			"ar:budgetCostReservedUsdMicros",
			"ar:budgetCostRemainingUsdMicros",
			"ar:budgetCostMaxUsdMicros",
			"ar:budgetAccountExhausted",
			"ar:budgetAccountRevision",
			"prov:generatedAtTime",
		]) {
			assert.ok(first.includes(predicate), `missing Face predicate ${predicate}`);
		}
		assert.ok(first.indexOf(agentSessionFamilyRelationIri(RELATION_ONE)) < first.indexOf(RELATION_TWO));

		const graph = new Store();
		graph.update(first);
		const initialSize = graph.size;
		graph.update(first);
		assert.equal(graph.size, initialSize, "exact replay is idempotent");
		const rows = graph.query(`PREFIX ar: <http://sophia.ai/agent-runtime#>
PREFIX agt: <http://mnemosyne.dev/agent#>
SELECT ?parentState ?projectionRevision ?parentGeneration ?childSessionId ?childSessionState
       ?childRunState ?allocationState ?generation ?materializationState ?workerState ?kernelState
WHERE {
  GRAPH <${USER_GRAPH}> {
    <${ROOT_IRI}> a agt:Session ; ar:sessionState ?parentState ; ar:projectionRevision ?projectionRevision ;
      ar:materializationGeneration ?parentGeneration .
    <${ROOT_IRI}> (^ar:parentSession/ar:childSession)+ ?child .
    ?child agt:sessionId ?childSessionId ; ar:sessionState ?childSessionState .
    OPTIONAL {
      ?relation ar:childSession ?child ; ar:childRunState ?childRunState ; ar:allocationState ?allocationState .
    }
    OPTIONAL {
      ?child ar:materializationGeneration ?generation ; ar:materializationState ?materializationState ;
        ar:workerState ?workerState ; ar:kernelState ?kernelState .
    }
  }
}
ORDER BY ?childSessionId`) as Array<Map<string, Term>>;
		assert.deepEqual(
			rows.map((row) => ({
				id: row.get("childSessionId")?.value,
				session: row.get("childSessionState")?.value,
				run: row.get("childRunState")?.value ?? null,
				allocation: row.get("allocationState")?.value ?? null,
				generation: row.get("generation")?.value ?? null,
				materialization: row.get("materializationState")?.value ?? null,
				worker: row.get("workerState")?.value ?? null,
				kernel: row.get("kernelState")?.value ?? null,
			})),
			[
				{
					id: CHILD_ID,
					session: "open",
					run: "claimed",
					allocation: "reserved",
					generation: "0",
					materialization: "running",
					worker: "running",
					kernel: "running",
				},
				{
					id: GRANDCHILD_ID,
					session: "open",
					run: null,
					allocation: null,
					generation: null,
					materialization: null,
					worker: null,
					kernel: null,
				},
			],
		);
		for (const row of rows) {
			assert.equal(row.get("parentState")?.value, "open");
			assert.equal(row.get("projectionRevision")?.value, "42");
			assert.equal(row.get("parentGeneration")?.value, "3");
		}
	});

	it("emits exact cancellation, fault, and accounting-hold testimony", () => {
		const fixture = fixtureSnapshot();
		const admitted = fixture.children[1]!;
		const update = buildAgentSessionFamilyProjection({
			...fixture,
			root: {
				...fixture.root,
				sessionState: "closing",
				materializationState: "faulted",
				materializationFaultKind: "worker_timeout",
				materializationRecoverable: true,
				workerState: "faulted",
				kernelState: "faulted",
			},
			children: [
				fixture.children[0]!,
				{
					...admitted,
					child: { ...admitted.child, sessionState: "closing" },
					childRunState: "cancelling",
					admission: {
						...admitted.admission!,
						allocationState: "accounting_hold",
						allocationHoldKind: "unresolved_child_reservations",
					},
					materializationState: "faulted",
					materializationFaultKind: "kernel_fault",
					materializationRecoverable: false,
					workerState: "faulted",
					kernelState: "faulted",
				},
			],
		});
		assert.match(update, /ar:sessionState "closing"/);
		assert.match(update, /ar:childRunState "cancelling"/);
		assert.match(update, /ar:allocationState "accounting_hold"/);
		assert.match(update, /ar:allocationHoldKind "unresolved_child_reservations"/);
		assert.match(update, /ar:materializationFaultKind "worker_timeout"/);
		assert.match(update, /ar:materializationFaultKind "kernel_fault"/);
		assert.match(update, /ar:materializationRecoverable "true"\^\^xsd:boolean/);
		assert.match(update, /ar:materializationRecoverable "false"\^\^xsd:boolean/);
	});

	it("emits settled cost iff settled and hold kind iff accounting_hold", () => {
		const fixture = fixtureSnapshot();
		const child = fixture.children[1]!;
		const settled = buildAgentSessionFamilyProjection({
			...fixture,
			root: {
				...fixture.root,
				occupiedChildren: 0,
				budgetCostSpentUsdMicros: 300_000,
				budgetCostReservedUsdMicros: 0,
				budgetCostRemainingUsdMicros: 700_000,
				budgetAccountExhausted: true,
			},
			children: [
				fixture.children[0]!,
				{
					...child,
					admission: {
						...child.admission!,
						allocationState: "settled",
						allocationHoldKind: null,
						settledActualCostUsdMicros: 300_000,
					},
				},
			],
		});
		assert.match(settled, /ar:allocationState "settled"/);
		assert.match(settled, /ar:settledActualCostUsdMicros "300000"\^\^xsd:long/);
		assert.doesNotMatch(settled, /ar:allocationHoldKind/);

		assert.throws(
			() =>
				buildAgentSessionFamilyProjection({
					...fixture,
					children: [
						fixture.children[0]!,
						{
							...child,
							admission: { ...child.admission!, settledActualCostUsdMicros: 1 },
						},
					],
				}),
			/dishonest settled cost testimony/,
		);
		assert.throws(
			() =>
				buildAgentSessionFamilyProjection({
					...fixture,
					children: [
						fixture.children[0]!,
						{
							...child,
							admission: {
								...child.admission!,
								allocationHoldKind: "unresolved_child_reservations",
							},
						},
					],
				}),
			/dishonest accounting hold testimony/,
		);
	});

	it("rejects unknown and structurally partial lifecycle testimony", () => {
		const fixture = fixtureSnapshot();
		const child = fixture.children[1]!;
		assert.throws(
			() =>
				buildAgentSessionFamilyProjection({
					...fixture,
					root: { ...fixture.root, sessionState: "completed" as never },
				}),
			/invalid Session state/,
		);
		assert.throws(
			() =>
				buildAgentSessionFamilyProjection({
					...fixture,
					children: [fixture.children[0]!, { ...child, materializationGeneration: null }],
				}),
			/partial materialization testimony/,
		);
		assert.throws(
			() =>
				buildAgentSessionFamilyProjection({
					...fixture,
					children: [
						fixture.children[0]!,
						{
							...child,
							materializationFaultKind: "worker_exit",
							materializationRecoverable: true,
						},
					],
				}),
			/dishonest fault testimony/,
		);
		assert.throws(
			() =>
				buildAgentSessionFamilyProjection({
					...fixture,
					children: [fixture.children[0]!, { ...child, childRunState: null }],
				}),
			/invalid child run testimony/,
		);
		assert.throws(
			() =>
				buildAgentSessionFamilyProjection({
					...fixture,
					children: [{ ...fixture.children[0]!, childRunState: "queued" }, child],
				}),
			/orphaned child run testimony/,
		);
		assert.throws(
			() =>
				buildAgentSessionFamilyProjection({
					...fixture,
					children: [
						fixture.children[0]!,
						{
							...child,
							admission: { ...child.admission!, allocationState: "pending" as never },
						},
					],
				}),
			/invalid allocation state/,
		);
	});

	it("does not leak private host coordinates from untyped callers", () => {
		const tainted = {
			...fixtureSnapshot(),
			prompt: "TOP SECRET PROMPT",
			model: "private-model-coordinate",
			ownerUserId: "user:private-owner",
			requestId: "private-request-id",
			claimToken: "private-claim-token",
			sandboxId: "private-sandbox-body-id",
			children: fixtureSnapshot().children.map((child) => ({
				...child,
				childRunId: "acr_private_child_run",
				bodyId: "private-body-id",
			})),
		} as unknown as AgentSessionFamilyProjectionSnapshot;
		const update = buildAgentSessionFamilyProjection(tainted);
		for (const forbidden of [
			"TOP SECRET PROMPT",
			"private-model-coordinate",
			"user:private-owner",
			"private-request-id",
			"private-claim-token",
			"private-sandbox-body-id",
			"acr_private_child_run",
			"private-body-id",
		]) {
			assert.ok(!update.includes(forbidden), `projection leaked ${forbidden}`);
		}
		assert.doesNotMatch(update, /ux:config|ux:layoutJson|PREFIX (?:sux|ux):|sux:/);
	});

	it("reads every F1 descendant in depth order and exposes only complete latest body testimony", async () => {
		await withRuntime(async (runtime) => {
			await seedRegisteredFamily(runtime);
			await runtime.registerAgentSessionChild(ROOT_ID, CHILD_ID, { now: 10 });
			await runtime.registerAgentSessionChild(CHILD_ID, GRANDCHILD_ID, { now: 11 });
			await runtime.registerAgentSessionChild(ROOT_ID, SIBLING_ID, { now: 12 });
			await runtime.claimAgentMaterialization(GRANDCHILD_ID, {
				generation: 0,
				activationId: "family-grandchild-generation-0",
				now: 13,
			});

			const claimed = await runtime.readAgentSessionFamilyProjection(ROOT_ID);
			assert.ok(claimed);
			assert.deepEqual(
				claimed.children.map((child) => [
					child.child.sessionId,
					child.depth,
					child.admission,
					child.childRunState,
					child.materializationGeneration,
					child.materializationState,
					child.workerState,
				]),
				[
					[CHILD_ID, 1, null, null, null, null, null],
					[SIBLING_ID, 1, null, null, null, null, null],
					[GRANDCHILD_ID, 2, null, null, null, null, null],
				],
				"a merely claimed body is not projected without worker testimony",
			);

			await runtime.bindAgentSandbox(GRANDCHILD_ID, {
				sandboxId: "private-family-grandchild-worker",
				generation: 0,
				activationId: "family-grandchild-generation-0",
				now: 14,
			});
			const bound = await runtime.readAgentSessionFamilyProjection(GRANDCHILD_ID);
			assert.ok(bound);
			assert.equal(bound.root.sessionId, ROOT_ID, "a nested member resolves to the canonical family root");
			assert.deepEqual(
				bound.children.map((child) => [
					child.parentSessionId,
					child.child.sessionId,
					child.depth,
					child.materializationGeneration,
					child.materializationState,
					child.workerState,
				]),
				[
					[ROOT_ID, CHILD_ID, 1, null, null, null],
					[ROOT_ID, SIBLING_ID, 1, null, null, null],
					[CHILD_ID, GRANDCHILD_ID, 2, 0, "running", "running"],
				],
			);
			assert.equal(await runtime.readAgentSessionFamilyProjection("ags_missing"), null);
			assert.ok(!buildAgentSessionFamilyProjection(bound).includes("private-family-grandchild-worker"));
		});
	});

	it("reads an atomic F2 admission, run, and allocation snapshot", async () => {
		await withRuntime(async (runtime) => {
			const seeded = await seedDomainParent(runtime);
			const admitted = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
				...seeded.parentFence,
				requestId: "family-projection-admission",
				prompt: "This task content must not reach the family projection.",
				requestedName: "research",
				causationId: "family-projection-admission-cause",
				now: 20,
			});
			assert.equal(admitted.decision, "accepted");
			if (admitted.decision !== "accepted") return;
			const snapshot = await runtime.readAgentSessionFamilyProjection(seeded.parentSessionId);
			assert.ok(snapshot);
			assert.equal(snapshot.children.length, 1);
			assert.deepEqual(
				{
					directAcceptedChildren: snapshot.root.directAcceptedChildren,
					maxChildren: snapshot.root.maxChildren,
					occupiedChildren: snapshot.root.occupiedChildren,
					maxConcurrentChildren: snapshot.root.maxConcurrentChildren,
					budgetCostSpentUsdMicros: snapshot.root.budgetCostSpentUsdMicros,
					budgetCostReservedUsdMicros: snapshot.root.budgetCostReservedUsdMicros,
					budgetCostRemainingUsdMicros: snapshot.root.budgetCostRemainingUsdMicros,
					budgetCostMaxUsdMicros: snapshot.root.budgetCostMaxUsdMicros,
					budgetAccountExhausted: snapshot.root.budgetAccountExhausted,
				},
				{
					directAcceptedChildren: 1,
					maxChildren: 4,
					occupiedChildren: 1,
					maxConcurrentChildren: 2,
					budgetCostSpentUsdMicros: 0,
					budgetCostReservedUsdMicros: admitted.allocation.budget.maxCostUsdMicros,
					budgetCostRemainingUsdMicros: 1_000_000 - admitted.allocation.budget.maxCostUsdMicros,
					budgetCostMaxUsdMicros: 1_000_000,
					budgetAccountExhausted: false,
				},
			);
			assert.ok(snapshot.root.budgetAccountRevision > 0);
			assert.equal(snapshot.children[0]?.childRunState, "queued");
			assert.deepEqual(snapshot.children[0]?.admission, {
				childName: "research",
				depth: 1,
				runtimeKind: "simple",
				allocationState: "reserved",
				allocationHoldKind: null,
				settledActualCostUsdMicros: null,
				budget: admitted.allocation.budget,
			});
			assert.deepEqual(
				[
					snapshot.children[0]?.materializationGeneration,
					snapshot.children[0]?.materializationState,
					snapshot.children[0]?.workerState,
				],
				[null, null, null],
			);
			const update = buildAgentSessionFamilyProjection(snapshot);
			assert.match(update, /ar:childRunState "queued"/);
			assert.match(update, /ar:allocationState "reserved"/);
			assert.ok(!update.includes("This task content must not reach"));
		});
	});

	it("reads the leased resident Prime worker and kernel body without private body identifiers", async () => {
		await withRuntime(async (runtime) => {
			const seeded = await seedDomainParent(runtime, "prime");
			const admitted = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
				...seeded.parentFence,
				requestId: "family-prime-body",
				prompt: "Use the durable notebook.",
				requestedName: "prime_researcher",
				causationId: "family-prime-body-cause",
				now: 30,
			});
			assert.equal(admitted.decision, "accepted");
			if (admitted.decision !== "accepted") return;
			const consumer = "family-prime-supervisor";
			const claim = await runtime.claimAgentSessionChildRun(admitted.run.child_run_id, {
				consumer,
				leaseMs: 1_000,
				now: 31,
			});
			assert.equal(claim.claimed, true);
			assert.ok(claim.run.claim_token);
			await runtime.claimAgentSessionChildMaterialization(admitted.run.child_run_id, {
				consumer,
				claimToken: claim.run.claim_token,
				generation: 0,
				activationId: "prime-child-activation",
				now: 32,
			});
			await runtime.bindAgentSandbox(admitted.child.session_id, {
				sandboxId: "private-prime-worker-id",
				generation: 0,
				activationId: "prime-child-activation",
				childRunConsumer: consumer,
				childRunClaimToken: claim.run.claim_token,
				now: 33,
			});
			await runtime.beginAgentSessionKernelLaunch(admitted.child.session_id, 0, {
				activationId: "prime-child-activation",
				sandboxId: "prime-child-kernel",
				now: 34,
			});
			const kernel = await runtime.bindAgentSessionKernelLaunch(admitted.child.session_id, 0, {
				activationId: "prime-child-activation",
				sandboxId: "prime-child-kernel",
				now: 34,
			});
			assert.equal(kernel.state, "running");

			const running = await runtime.readAgentSessionFamilyProjection(seeded.parentSessionId);
			assert.ok(running);
			assert.deepEqual(
				{
					runtimeKind: running.children[0]?.admission?.runtimeKind,
					childRunState: running.children[0]?.childRunState,
					materializationGeneration: running.children[0]?.materializationGeneration,
					materializationState: running.children[0]?.materializationState,
					workerState: running.children[0]?.workerState,
					kernelState: running.children[0]?.kernelState,
				},
				{
					runtimeKind: "prime",
					childRunState: "claimed",
					materializationGeneration: 0,
					materializationState: "running",
					workerState: "running",
					kernelState: "running",
				},
			);
			const update = buildAgentSessionFamilyProjection(running);
			assert.match(update, /ar:runtimeKind "prime"/);
			assert.match(update, /ar:childRunState "claimed"/);
			assert.match(update, /ar:materializationGeneration "0"\^\^xsd:long/);
			assert.match(update, /ar:workerState "running"/);
			assert.match(update, /ar:kernelState "running"/);
			assert.ok(!update.includes("private-prime-worker-id"));
		});
	});

	it("reads exact terminal simple run, worker, lifecycle, and settled allocation testimony", async () => {
		await withRuntime(async (runtime) => {
			const seeded = await seedDomainParent(runtime);
			const admitted = await runtime.admitAgentSessionChild(seeded.parentSessionId, {
				...seeded.parentFence,
				requestId: "family-terminal-simple",
				prompt: "Finish once.",
				causationId: "family-terminal-simple-cause",
				now: 40,
			});
			assert.equal(admitted.decision, "accepted");
			if (admitted.decision !== "accepted") return;
			const consumer = "family-simple-supervisor";
			const claim = await runtime.claimAgentSessionChildRun(admitted.run.child_run_id, {
				consumer,
				leaseMs: 1_000,
				now: 41,
			});
			assert.ok(claim.run.claim_token);
			await runtime.claimAgentSessionChildMaterialization(admitted.run.child_run_id, {
				consumer,
				claimToken: claim.run.claim_token,
				generation: 0,
				activationId: "simple-child-activation",
				now: 42,
			});
			await runtime.bindAgentSandbox(admitted.child.session_id, {
				sandboxId: "private-simple-worker-id",
				generation: 0,
				activationId: "simple-child-activation",
				childRunConsumer: consumer,
				childRunClaimToken: claim.run.claim_token,
				now: 43,
			});
			const result = terminalSimpleResult(admitted.run.child_run_id, admitted.child.session_id);
			await runtime.finishAgentSession(admitted.child.session_id, {
				result,
				status: "completed",
				generation: 0,
				activationId: "simple-child-activation",
				childRunConsumer: consumer,
				childRunClaimToken: claim.run.claim_token,
				now: 44,
				frontier: {
					kind: "after-node",
					sessionId: admitted.child.session_id,
					phaseIndex: admitted.child.phase_index,
					ts: 44,
				},
			});
			await runtime.finishAgentMaterialization(admitted.child.session_id, 0, {
				activationId: "simple-child-activation",
				from: "running",
				to: "completed",
				now: 45,
			});
			await runtime.settleAgentSessionChildRun(admitted.run.child_run_id, {
				consumer,
				claimToken: claim.run.claim_token,
				status: "completed",
				terminalPolicy: "close",
				materializationGeneration: 0,
				materializationState: "completed",
				result,
				now: 46,
			});

			const snapshot = await runtime.readAgentSessionFamilyProjection(seeded.parentSessionId);
			assert.ok(snapshot);
			assert.deepEqual(
				{
					sessionState: snapshot.children[0]?.child.sessionState,
					childRunState: snapshot.children[0]?.childRunState,
					materializationGeneration: snapshot.children[0]?.materializationGeneration,
					materializationState: snapshot.children[0]?.materializationState,
					workerState: snapshot.children[0]?.workerState,
					kernelState: snapshot.children[0]?.kernelState,
					allocationState: snapshot.children[0]?.admission?.allocationState,
					allocationHoldKind: snapshot.children[0]?.admission?.allocationHoldKind,
					settledActualCostUsdMicros: snapshot.children[0]?.admission?.settledActualCostUsdMicros,
				},
				{
					sessionState: "closed",
					childRunState: "completed",
					materializationGeneration: 0,
					materializationState: "completed",
					workerState: "completed",
					kernelState: null,
					allocationState: "settled",
					allocationHoldKind: null,
					settledActualCostUsdMicros: 0,
				},
			);
			assert.equal(snapshot.root.occupiedChildren, 0);
			assert.equal(snapshot.root.budgetCostReservedUsdMicros, 0);
			assert.equal(snapshot.root.budgetCostSpentUsdMicros, 0);
			const update = buildAgentSessionFamilyProjection(snapshot);
			assert.match(update, /ar:sessionState "closed"/);
			assert.match(update, /ar:childRunState "completed"/);
			assert.match(update, /ar:workerState "completed"/);
			assert.match(update, /ar:allocationState "settled"/);
			assert.match(update, /ar:settledActualCostUsdMicros "0"\^\^xsd:long/);
			assert.ok(!update.includes("private-simple-worker-id"));
		});
	});

	it("fences a delayed project behind a newer project revision", () => {
		const graph = new Store();
		const older = fixtureSnapshot(41);
		const newer = {
			...fixtureSnapshot(42),
			root: { ...fixtureSnapshot(42).root, sessionState: "closing" as const },
		};
		graph.update(buildAgentSessionFamilyProjection(newer));
		graph.update(buildAgentSessionFamilyProjection(older));
		const rows = graph.query(`PREFIX ar: <http://sophia.ai/agent-runtime#>
SELECT ?revision ?state WHERE {
  GRAPH <${USER_GRAPH}> { <${ROOT_IRI}> ar:projectionRevision ?revision ; ar:sessionState ?state . }
}`) as Array<Map<string, Term>>;
		assert.deepEqual(
			rows.map((row) => [row.get("revision")?.value, row.get("state")?.value]),
			[["42", "closing"]],
		);
	});

	it("retire is a monotone tombstone in both race orders and preserves Session/body/relation facts", () => {
		const project = fixtureSnapshot(42);
		const retirement = {
			graphId: GRAPH_ID,
			rootSessionId: ROOT_ID,
			rootAgentId: AGENT_ID,
			projectionRevision: 50,
		};
		const retire = buildAgentSessionFamilyProjectionRetirement(retirement);
		assert.match(retire, /ar:projectionRevision "50"\^\^xsd:long/);
		assert.doesNotMatch(retire, /ar:sessionState|ar:materializationState|ChildSessionRelation/);

		for (const order of ["project-retire", "retire-project"] as const) {
			const graph = new Store();
			if (order === "project-retire") {
				graph.update(buildAgentSessionFamilyProjection(project));
				graph.update(retire);
			} else {
				graph.update(retire);
				graph.update(buildAgentSessionFamilyProjection(project));
			}
			const tombstone = graph.query(`PREFIX ar: <http://sophia.ai/agent-runtime#>
PREFIX agt: <http://mnemosyne.dev/agent#>
SELECT ?revision ?state ?generation ?relation WHERE {
  GRAPH <${USER_GRAPH}> {
    <${ROOT_IRI}> ar:projectionRevision ?revision .
    OPTIONAL { <${ROOT_IRI}> ar:sessionState ?state . }
    OPTIONAL { <${ROOT_IRI}> ar:materializationGeneration ?generation . }
    OPTIONAL { ?relation a ar:ChildSessionRelation ; ar:parentSession <${ROOT_IRI}> . }
  }
}`) as Array<Map<string, Term>>;
			assert.equal(tombstone.length, order === "project-retire" ? 1 : 1);
			assert.equal(tombstone[0]?.get("revision")?.value, "50");
			if (order === "project-retire") {
				assert.equal(tombstone[0]?.get("state")?.value, "open", "retire preserves root Session state");
				assert.equal(tombstone[0]?.get("generation")?.value, "3", "retire preserves root body state");
				assert.equal(
					tombstone[0]?.get("relation")?.value,
					agentSessionFamilyRelationIri(RELATION_ONE),
					"retire preserves immutable relation facts",
				);
			} else {
				assert.equal(tombstone[0]?.get("state"), undefined, "stale project cannot install Session facts");
				assert.equal(tombstone[0]?.get("relation"), undefined, "stale project cannot install relation facts");
			}
			const aggregates = graph.query(`PREFIX ar: <http://sophia.ai/agent-runtime#>
ASK { GRAPH <${USER_GRAPH}> { <${ROOT_IRI}> ar:directAcceptedChildren ?value . } }`);
			assert.equal(aggregates, false, `${order} cannot resurrect former-root aggregates`);
		}
	});

	it("writes one exact store payload and rejects a missing family", async () => {
		const snapshot = fixtureSnapshot();
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		await projectAgentSessionFamilyFromStore(
			{
				async callTool(name, args) {
					calls.push({ name, args });
					return { ok: true };
				},
			},
			{
				async readAgentSessionFamilyProjection() {
					return snapshot;
				},
			},
			ROOT_ID,
		);
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.name, "sparql_update");
		assert.equal(calls[0]?.args.graphId, GRAPH_ID);
		assert.equal(calls[0]?.args.update, buildAgentSessionFamilyProjection(snapshot));
		await assert.rejects(
			projectAgentSessionFamilyFromStore(
				{
					async callTool() {
						return { ok: true };
					},
				},
				{
					async readAgentSessionFamilyProjection() {
						return null;
					},
				},
				"ags_missing",
			),
			/family member not found/,
		);
	});

	it("rejects dishonest family structure and invalid retirement coordinates", () => {
		const fixture = fixtureSnapshot();
		assert.throws(
			() =>
				buildAgentSessionFamilyProjection({
					...fixture,
					children: [{ ...fixture.children[0]!, depth: 1 }, fixture.children[1]!],
				}),
			/dishonest depth/,
		);
		assert.throws(
			() =>
				buildAgentSessionFamilyProjectionRetirement({
					graphId: "Unsafe Graph",
					rootSessionId: ROOT_ID,
					rootAgentId: AGENT_ID,
					projectionRevision: 50,
				}),
			/graph id is invalid/,
		);
		assert.throws(() => agentSessionFamilyRelationIri("asr_not_canonical"), /invalid Agent Session relation id/);
	});

	it("does not fabricate body or admission facts for a registered-only descendant", () => {
		const fixture = fixtureSnapshot();
		const registeredOnly = fixture.children[1]!;
		const update = buildAgentSessionFamilyProjection({
			...fixture,
			root: {
				...fixture.root,
				directAcceptedChildren: 0,
				occupiedChildren: 0,
				budgetCostReservedUsdMicros: 0,
				budgetCostRemainingUsdMicros: 975_000,
			},
			children: [
				{
					...registeredOnly,
					admission: null,
					childRunState: null,
					materializationGeneration: null,
					materializationState: null,
					workerState: null,
					kernelState: null,
					materializationFaultKind: null,
					materializationRecoverable: null,
				},
			],
		});
		const insert = update.slice(update.indexOf("INSERT"), update.indexOf("WHERE"));
		assert.match(insert, new RegExp(`<${CHILD_IRI}> a agt:Session`));
		assert.doesNotMatch(insert, /ar:admissionStatus|ar:childRunState|ar:allocationState/);
		assert.doesNotMatch(insert, /<[^>]+child_research[^>]+>[\s\S]*ar:materializationState/);
		assert.ok(!update.includes(GRANDCHILD_IRI), "the omitted grandchild is not invented");
	});
});

async function withRuntime(run: (runtime: WorkflowRuntimeStore) => Promise<void>): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "agent-session-family-projection-"));
	const runtime = new WorkflowRuntimeStore(join(directory, "runtime.sqlite"));
	try {
		await runtime.init();
		await run(runtime);
	} finally {
		runtime.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

async function seedRegisteredFamily(runtime: WorkflowRuntimeStore): Promise<void> {
	const runId = "wfr-family-projection";
	const workflowName = "family-projection-fixture";
	const ownerUserId = "user:ada";
	const semantic = makeTestAgentSemanticBinding({ graphId: GRAPH_ID, registeredName: "phanes" });
	await runtime.createWorkflowInstance({
		runId,
		workflowName,
		graphId: GRAPH_ID,
		ownerUserId,
		inputs: {},
		startedAt: 1,
	});
	for (const [index, sessionId] of [ROOT_ID, CHILD_ID, GRANDCHILD_ID, SIBLING_ID].entries()) {
		const spec: AgentNodeSpec = {
			label: sessionId,
			phaseIndex: index + 1,
			prompt: `run ${sessionId}`,
			model: "mock:done",
			graphId: GRAPH_ID,
			sessionId,
			...semantic,
		};
		await runtime.beginAgentSession({
			sessionId,
			runId,
			workflowName,
			graphId: GRAPH_ID,
			ownerUserId,
			graphOwnerPrincipal: "user:projection-owner",
			spec,
			nodeKey: `${String(index + 1)}:${sessionId}`,
			frontier: { kind: "before-node", sessionId, phaseIndex: index + 1, ts: index + 1 },
			now: index + 1,
		});
	}
}

async function seedDomainParent(
	runtime: WorkflowRuntimeStore,
	childKind: "simple" | "prime" = "simple",
): Promise<{
	parentSessionId: string;
	parentFence: { parentGeneration: number; parentActivationId: string; parentSandboxId: string };
}> {
	const parentSessionId = "ags_domain_family_parent";
	const ownerUserId = "user:ada";
	const runId = "wfr-domain-family-parent";
	const workflowName = "domain-agent-activity-loop-v1";
	const pilot = makeTestAgentSemanticBinding({ graphId: GRAPH_ID, kind: "prime", registeredName: "phanes" });
	const childBase = makeTestAgentSemanticBinding({ graphId: GRAPH_ID, kind: childKind, registeredName: "phanes" });
	const child =
		childKind === "prime"
			? {
					...childBase,
					runtime: {
						...childBase.runtime,
						constraints: {
							...childBase.runtime.constraints,
							maxChildren: 0,
							maxChildDepth: 0,
							maxConcurrentChildren: 0,
						},
					},
				}
			: childBase;
	await runtime.createWorkflowInstance({
		runId,
		workflowName,
		graphId: GRAPH_ID,
		ownerUserId,
		inputs: {
			hostContext: {
				schema: "sophia.domain-agent-host-context.v1",
				runtimes: { pilot: pilot.runtime, emanation: child.runtime },
				ontologies: { pilot: pilot.ontology, emanation: child.ontology },
				emanation: {
					enabled: true,
					provider: "openrouter",
					model: "mock:done",
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
		graphId: GRAPH_ID,
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
		graphId: GRAPH_ID,
		ownerUserId,
		graphOwnerPrincipal: "user:projection-owner",
		spec,
		nodeKey: "1:pilot-attend",
		frontier: { kind: "before-node", sessionId: parentSessionId, phaseIndex: 1, ts: 1 },
		now: 1,
	});
	const parentFence = {
		parentGeneration: 0,
		parentActivationId: "family-parent-activation",
		parentSandboxId: "family-parent-sandbox",
	};
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
	return { parentSessionId, parentFence };
}

function terminalSimpleResult(childRunId: string, sessionId: string): AgentNodeResult {
	return {
		invocationId: childRunId,
		sessionId,
		label: "emanation",
		phaseIndex: 2,
		state: "done",
		output: "done",
		model: "mock:done",
		turns: 1,
		toolCalls: 0,
		tokens: 8,
		queuedAt: 41,
		startedAt: 42,
		durationMs: 2,
	};
}
