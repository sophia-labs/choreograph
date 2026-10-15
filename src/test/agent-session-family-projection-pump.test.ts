import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Store, type Term } from "oxigraph";
import type { AgentSessionFamilyGraphProxy } from "../agent-runtime/agent-session-family-graph-projection.js";
import {
	type AgentSessionFamilyProjectionGraphAuthority,
	AgentSessionFamilyProjectionPump,
} from "../agent-runtime/agent-session-family-projection-pump.js";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { mintAgentSessionUri } from "../agent-subject/agent-ontology.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

const GRAPH_ID = "prime-notebook-lab";
const USER_GRAPH = `urn:mnemosyne:local:graph:${GRAPH_ID}:user:rdf`;
const OWNER = "user:ada";
const QUIET_LOGGER = { error() {}, warn() {} };

describe("Agent Session family projection pump", () => {
	it("reclaims an expired claim after process death and rebuilds graph authority from the durable root", async () => {
		await withDatabase(async ({ path, first }) => {
			const seeded = await seedRoot(first, "crash-reopen");
			const deadClaim = await first.claimAgentSessionFamilyProjectionOutbox({
				consumer: "dead-process",
				leaseMs: 10,
				now: 100,
			});
			assert.equal(deadClaim?.work.root_session_id, seeded.sessionId);
			first.close();

			const reopened = new WorkflowRuntimeStore(path);
			await reopened.init();
			const graph = new Store();
			const authorities: AgentSessionFamilyProjectionGraphAuthority[] = [];
			const pump = new AgentSessionFamilyProjectionPump({
				store: reopened,
				consumer: "restarted-projector",
				leaseMs: 20,
				now: () => 111,
				idlePollMs: 10,
				logger: QUIET_LOGGER,
				proxyFactory: async (authority) => {
					authorities.push(authority);
					return graphLease(new GraphProxy(graph));
				},
			});
			try {
				await pump.start();
				assert.deepEqual(authorities, [
					{
						rootSessionId: seeded.sessionId,
						ownerUserId: OWNER,
						graphOwnerPrincipal: "organization:projection-lab",
						graphId: GRAPH_ID,
					},
				]);
				assert.equal(readProjectionRevision(graph, seeded), deadClaim!.snapshot!.projectionRevision);
				assert.equal(
					await reopened.claimAgentSessionFamilyProjectionOutbox({
						consumer: "should-be-empty",
						leaseMs: 10,
						now: 112,
					}),
					null,
				);
			} finally {
				await pump.stop();
				reopened.close();
			}
		});
	});

	it("backs off a transient proxy failure and redelivers without execution coupling", async () => {
		await withDatabase(async ({ first }) => {
			const seeded = await seedRoot(first, "transient");
			const graph = new Store();
			let calls = 0;
			const proxy = new GraphProxy(graph, async () => {
				calls += 1;
				if (calls === 1) throw new Error("temporary graph outage");
			});
			const pump = new AgentSessionFamilyProjectionPump({
				store: first,
				consumer: "retry-projector",
				leaseMs: 200,
				retryBaseMs: 10,
				retryMaxMs: 20,
				idlePollMs: 5,
				logger: QUIET_LOGGER,
				proxyFactory: async () => graphLease(proxy),
			});
			try {
				await pump.start();
				await waitFor(() => calls === 2);
				assert.ok(readProjectionRevision(graph, seeded) > 0);
			} finally {
				await pump.stop();
			}
		});
	});

	it("coalesces a mutation committed during a claim into a later exact delivery", async () => {
		await withDatabase(async ({ first }) => {
			const seeded = await seedRoot(first, "coalesce");
			const graph = new Store();
			const gate = deferred();
			const entered = deferred();
			const revisions: number[] = [];
			let calls = 0;
			const proxy = new GraphProxy(graph, async (_name, args) => {
				calls += 1;
				const update = requiredUpdate(args);
				revisions.push(revisionFromUpdate(update));
				if (calls === 1) {
					entered.resolve();
					await gate.promise;
				}
			});
			const pump = new AgentSessionFamilyProjectionPump({
				store: first,
				consumer: "coalescing-projector",
				leaseMs: 1_000,
				idlePollMs: 10,
				logger: QUIET_LOGGER,
				proxyFactory: async () => graphLease(proxy),
			});
			const started = pump.start();
			try {
				await entered.promise;
				await bindKernelBody(first, seeded.sessionId, seeded.activationId, 4);
				const stopped = pump.stop();
				gate.resolve();
				await Promise.all([started, stopped]);
				assert.equal(calls, 2);
				assert.ok(revisions[1]! > revisions[0]!);
				assert.equal(readProjectionRevision(graph, seeded), revisions[1]);
			} finally {
				gate.resolve();
				await pump.stop();
			}
		});
	});

	it("permits only one graph delivery across two competing pumps", async () => {
		await withDatabase(async ({ first, second }) => {
			await seedRoot(first, "two-pump-race");
			const graph = new Store();
			let calls = 0;
			const proxy = new GraphProxy(graph, async () => {
				calls += 1;
			});
			const pumpA = projectionPump(first, "projector-a", proxy);
			const pumpB = projectionPump(second, "projector-b", proxy);
			try {
				await Promise.all([pumpA.start(), pumpB.start()]);
				assert.equal(calls, 1);
			} finally {
				await Promise.all([pumpA.stop(), pumpB.stop()]);
			}
		});
	});

	it("renews a slow graph write so a second consumer cannot reclaim live work", async () => {
		await withDatabase(async ({ first, second }) => {
			await seedRoot(first, "lease-renewal");
			const gate = deferred();
			const entered = deferred();
			const pump = new AgentSessionFamilyProjectionPump({
				store: first,
				consumer: "renewing-projector",
				leaseMs: 120,
				idlePollMs: 10,
				logger: QUIET_LOGGER,
				proxyFactory: async () =>
					graphLease(
						new GraphProxy(new Store(), async () => {
							entered.resolve();
							await gate.promise;
						}),
					),
			});
			const started = pump.start();
			try {
				await entered.promise;
				await new Promise((resolve) => setTimeout(resolve, 180));
				assert.equal(
					await second.claimAgentSessionFamilyProjectionOutbox({
						consumer: "competing-projector",
						leaseMs: 120,
						now: Date.now(),
					}),
					null,
				);
				gate.resolve();
				await started;
			} finally {
				gate.resolve();
				await pump.stop();
			}
		});
	});

	it("keeps a delayed stale project behind a newer durable retirement tombstone", async () => {
		await withDatabase(async ({ first, second }) => {
			const parent = await seedRoot(first, "retire-parent");
			const detached = await seedRoot(first, "retire-detached");
			await drainOutbox(first, 100);
			await bindKernelBody(first, detached.sessionId, detached.activationId, 110);

			const graph = new Store();
			const staleEntered = deferred();
			const releaseStale = deferred();
			const staleWarnings: string[] = [];
			const stalePump = new AgentSessionFamilyProjectionPump({
				store: first,
				consumer: "stale-projector",
				leaseMs: 10_000,
				idlePollMs: 10,
				logger: { error() {}, warn: (message) => staleWarnings.push(message) },
				proxyFactory: async () =>
					graphLease(
						new GraphProxy(graph, async () => {
							staleEntered.resolve();
							await releaseStale.promise;
						}),
					),
			});
			const staleStarted = stalePump.start();
			await staleEntered.promise;
			await second.registerAgentSessionChild(parent.sessionId, detached.sessionId, {
				causationId: "attach-detached-root",
				now: 111,
			});

			const freshPump = projectionPump(second, "retirement-projector", new GraphProxy(graph));
			try {
				await freshPump.start();
				const retirementRevision = readProjectionRevision(graph, detached);
				assert.ok(retirementRevision > 0);
				releaseStale.resolve();
				await staleStarted;
				assert.equal(readProjectionRevision(graph, detached), retirementRevision);
				assert.equal(hasRootAggregate(graph, detached), false);
				assert.ok(
					staleWarnings.some((message) => message.includes("completion lost")),
					"stale token is rejected",
				);
			} finally {
				releaseStale.resolve();
				await Promise.all([stalePump.stop(), freshPump.stop()]);
			}
		});
	});

	it("does not mutate durable family authority when graph projection fails", async () => {
		await withDatabase(async ({ first }) => {
			const seeded = await seedRoot(first, "failure-is-derived");
			const sessionBefore = await first.readAgentSession(seeded.sessionId);
			const familyBefore = await first.readAgentSessionFamilyProjection(seeded.sessionId);
			const graph = new Store();
			const pump = new AgentSessionFamilyProjectionPump({
				store: first,
				consumer: "failed-projector",
				leaseMs: 1_000,
				retryBaseMs: 10_000,
				retryMaxMs: 10_000,
				idlePollMs: 10,
				logger: QUIET_LOGGER,
				proxyFactory: async () =>
					graphLease(
						new GraphProxy(graph, async () => {
							throw new Error("graph unavailable");
						}),
					),
			});
			await pump.start();
			await pump.stop();
			assert.deepEqual(await first.readAgentSession(seeded.sessionId), sessionBefore);
			assert.deepEqual(await first.readAgentSessionFamilyProjection(seeded.sessionId), familyBefore);
			assert.equal(readProjectionRevision(graph, seeded), null);
		});
	});
});

class GraphProxy implements AgentSessionFamilyGraphProxy {
	constructor(
		private readonly graph: Store,
		private readonly beforeUpdate?: (name: string, args: Record<string, unknown>) => Promise<void>,
	) {}

	async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
		assert.equal(name, "sparql_update");
		assert.equal(args.graphId, GRAPH_ID);
		await this.beforeUpdate?.(name, args);
		this.graph.update(requiredUpdate(args));
		return { ok: true };
	}
}

function graphLease(proxy: AgentSessionFamilyGraphProxy) {
	return { proxy, async close() {} };
}

function projectionPump(store: WorkflowRuntimeStore, consumer: string, proxy: AgentSessionFamilyGraphProxy) {
	return new AgentSessionFamilyProjectionPump({
		store,
		consumer,
		leaseMs: 1_000,
		idlePollMs: 10,
		logger: QUIET_LOGGER,
		proxyFactory: async () => graphLease(proxy),
	});
}

interface SeededRoot {
	readonly sessionId: string;
	readonly agentId: string;
	readonly activationId: string;
}

async function seedRoot(runtime: WorkflowRuntimeStore, suffix: string): Promise<SeededRoot> {
	const sessionId = `ags-pump-${suffix}`;
	const runId = `wfr-pump-${suffix}`;
	const workflowName = `projection-pump-${suffix}`;
	const semantic = makeTestAgentSemanticBinding({ graphId: GRAPH_ID, kind: "prime", registeredName: "phanes" });
	await runtime.createWorkflowInstance({
		runId,
		workflowName,
		graphId: GRAPH_ID,
		ownerUserId: OWNER,
		inputs: {},
		startedAt: 1,
	});
	const spec: AgentNodeSpec = {
		label: "pilot-attend",
		phaseIndex: 1,
		prompt: "Attend.",
		model: "mock:done",
		provider: "openrouter",
		graphId: GRAPH_ID,
		sessionId,
		agentId: semantic.agentId,
		runtime: semantic.runtime,
		runtimeBindingDigest: digestAgentRuntimeBinding(semantic.runtime),
		ontology: semantic.ontology,
		ontologyBindingDigest: semantic.ontologyBindingDigest,
	};
	await runtime.beginAgentSession({
		sessionId,
		runId,
		workflowName,
		graphId: GRAPH_ID,
		ownerUserId: OWNER,
		graphOwnerPrincipal: "organization:projection-lab",
		spec,
		nodeKey: "1:pilot-attend",
		frontier: { kind: "before-node", sessionId, phaseIndex: 1, ts: 1 },
		now: 1,
	});
	const activationId = `act-pump-${suffix}`;
	await runtime.claimAgentMaterialization(sessionId, { generation: 0, activationId, now: 2 });
	await runtime.bindAgentSandbox(sessionId, {
		generation: 0,
		activationId,
		sandboxId: `sbx-pump-${suffix}`,
		now: 3,
	});
	return { sessionId, agentId: semantic.agentId, activationId };
}

async function bindKernelBody(
	runtime: WorkflowRuntimeStore,
	sessionId: string,
	activationId: string,
	now: number,
): Promise<void> {
	const sandboxId = `kernel-${sessionId}-${activationId}`;
	await runtime.beginAgentSessionKernelLaunch(sessionId, 0, { activationId, sandboxId, now });
	await runtime.bindAgentSessionKernelLaunch(sessionId, 0, { activationId, sandboxId, now });
}

async function drainOutbox(runtime: WorkflowRuntimeStore, now: number): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const claim = await runtime.claimAgentSessionFamilyProjectionOutbox({
			consumer: "setup-drain",
			leaseMs: 1_000,
			now: now + attempt,
		});
		if (!claim) return;
		await runtime.completeAgentSessionFamilyProjectionOutbox({
			rootSessionId: claim.work.root_session_id,
			consumer: claim.work.consumer!,
			claimToken: claim.work.claim_token!,
			workKind: claim.work.work_kind,
			projectedRevision: claim.work.claimed_projection_revision!,
			now: now + attempt,
		});
	}
	throw new Error("projection outbox setup drain did not reach emptiness");
}

function requiredUpdate(args: Record<string, unknown>): string {
	assert.equal(typeof args.update, "string");
	return args.update as string;
}

function revisionFromUpdate(update: string): number {
	const match = update.match(/projectionRevision "(\d+)"\^\^xsd:long/);
	if (!match) throw new Error("projection update has no revision");
	return Number(match[1]);
}

function readProjectionRevision(graph: Store, root: SeededRoot): number | null {
	const rootIri = mintAgentSessionUri(root.agentId, root.sessionId);
	const rows = graph.query(`PREFIX ar: <http://sophia.ai/agent-runtime#>
SELECT ?revision WHERE {
  GRAPH <${USER_GRAPH}> { <${rootIri}> ar:projectionRevision ?revision . }
}`) as Array<Map<string, Term>>;
	const value = rows[0]?.get("revision")?.value;
	return value === undefined ? null : Number(value);
}

function hasRootAggregate(graph: Store, root: SeededRoot): boolean {
	const rootIri = mintAgentSessionUri(root.agentId, root.sessionId);
	return graph.query(`PREFIX ar: <http://sophia.ai/agent-runtime#>
ASK { GRAPH <${USER_GRAPH}> { <${rootIri}> ar:directAcceptedChildren ?count . } }`) as boolean;
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("timed out waiting for projection pump condition");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function withDatabase(
	run: (input: { path: string; first: WorkflowRuntimeStore; second: WorkflowRuntimeStore }) => Promise<void>,
): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "agent-family-projection-pump-"));
	const path = join(directory, "runtime.sqlite");
	const first = new WorkflowRuntimeStore(path);
	const second = new WorkflowRuntimeStore(path);
	try {
		await first.init();
		await second.init();
		await run({ path, first, second });
	} finally {
		first.close();
		second.close();
		rmSync(directory, { recursive: true, force: true });
	}
}
