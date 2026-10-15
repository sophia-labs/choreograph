import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentSessionFamilyGraphProxy } from "../agent-runtime/agent-session-family-graph-projection.js";
import { AgentSessionFamilyProjectionPump } from "../agent-runtime/agent-session-family-projection-pump.js";
import { SophiaContentStore } from "../agent-runtime/content-store.js";
import { AgentMemory } from "../agent-runtime/memory.js";
import { digestAgentOntologyBinding } from "../agent-runtime/ontology-binding.js";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { createSandboxEventBus } from "../event-bus.js";
import type { CapabilityBackend } from "../mnemosyne.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import type { CurrentGrantReader } from "../workflow/current-grant-reader.js";
import {
	parseDomainAgentInvocationRequest,
	type ResolvedDomainAgentConfigV1,
	resolveDomainAgentConfig,
} from "../workflow/domain-agent-config.js";
import { commitDomainSourceTurn } from "../workflow/domain-source-turn.js";
import { documentUri, type GraphDocumentRead, type GraphWriter } from "../workflow/graph-writer.js";
import { compileWorkflow, runWorkflow } from "../workflow/harness.js";
import type { InvocationEnvelopeV1 } from "../workflow/invocation.js";
import { makeNodeRunner } from "../workflow/run-node.js";
import { makeRuntimeNodeRunner } from "../workflow/runtime-control.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import {
	buildDomainAgentActivityInputs,
	DOMAIN_AGENT_ACTIVITY_LOOP_SCRIPT,
	finalizeDomainAgentActivityRun,
} from "../workflow/script-domain-agent-activity-loop.js";
import type { AgentNodeResult, AgentNodeSpec, RunRecord } from "../workflow/types.js";
import { CellRdfStore } from "./cell-rdf-store.js";

/**
 * Shared, test-only configured-runtime gate for F6-derived Domain organisms.
 * It deliberately carries paths only; callers retain ownership of process and
 * assertion choreography.
 */
export function configuredPhanesLocalRuntime(env: NodeJS.ProcessEnv = process.env) {
	const entrypoint = env.SOPHIA_AGENT_RUNTIME_ENTRYPOINT?.trim();
	const bridge = env.SOPHIA_JUPYTER_BRIDGE_PATH?.trim();
	const python = env.SOPHIA_PRIME_KERNEL_PYTHON?.trim();
	const phanesRoot = env.SOPHIA_PHANES_REPO?.trim();
	const driver = phanesRoot ? join(phanesRoot, "tests/fixtures/arc_f6_phanes_driver.py") : undefined;
	const skip =
		!entrypoint ||
		!existsSync(entrypoint) ||
		!bridge ||
		!existsSync(bridge) ||
		!python ||
		!existsSync(python) ||
		!phanesRoot ||
		!existsSync(phanesRoot) ||
		!driver ||
		!existsSync(driver)
			? "set the Prime worker, Jupyter bridge, kernel Python, and Phanes repository paths"
			: false;
	return { entrypoint, bridge, python, phanesRoot, driver, skip };
}

/** A test-only graph fixture which preserves graph identity and captures writes. */
export class LocalGraph implements GraphWriter {
	readonly writes: Array<{ graphId: string; documentId: string; content: string }> = [];
	readonly updates: string[] = [];

	constructor(
		readonly graphId: string,
		readonly documents: Readonly<Record<string, string>>,
	) {}

	async sparqlUpdate(graphId: string, sparql: string): Promise<void> {
		assert.equal(graphId, this.graphId);
		this.updates.push(sparql);
	}

	/** A real (empty) cell RDF face: this fixture's graph authority lives in documents. */
	private readonly rdf = new CellRdfStore();

	async sparqlQuery(_graphId: string, sparql: string): Promise<unknown> {
		return this.rdf.query(sparql);
	}

	async searchDocuments(): Promise<[]> {
		return [];
	}

	async readDocument(
		graphId: string,
		documentId: string,
		options?: { format?: GraphDocumentRead["format"] },
	): Promise<GraphDocumentRead> {
		assert.equal(graphId, this.graphId);
		const text = this.documents[documentId];
		if (text === undefined) throw new Error(`missing fixture document ${graphId}/${documentId}`);
		return {
			graphId,
			documentId,
			documentUri: documentUri(documentId),
			format: options?.format ?? "markdown",
			text,
			blocks: [],
			raw: text,
		};
	}

	async writeDocument(graphId: string, documentId: string, content: string): Promise<unknown> {
		assert.equal(graphId, this.graphId);
		this.writes.push({ graphId, documentId, content });
		return { documentId };
	}
}

export interface LocalHarness {
	readonly runtime: WorkflowRuntimeStore;
	readonly sandboxStore: SandboxStore;
	readonly memory: AgentMemory;
	readonly spawner: SandboxSpawner;
	readonly projectionUpdates: string[];
}

/**
 * Production-shaped local runtime fixture.  Call closeLocalHarness before
 * removing its directory so spawner-owned worker and projection processes
 * cannot outlive the test.
 */
export async function createLocalHarness(
	tempDir: string,
	consumer: string,
	options: { readonly currentGrantReader?: CurrentGrantReader } = {},
): Promise<LocalHarness> {
	const sandboxStore = new SandboxStore(join(tempDir, "sandboxes.sqlite"));
	const runtime = new WorkflowRuntimeStore(join(tempDir, "runtime.sqlite"));
	await runtime.init();
	const memory = new AgentMemory(
		SophiaContentStore.fromUrl(pathToFileURL(`${join(tempDir, "memory")}/`).toString()),
		runtime,
	);
	const eventBus = createSandboxEventBus(sandboxStore, { cleanupDelayMs: 0 });
	const projectionUpdates: string[] = [];
	const projectionPump = new AgentSessionFamilyProjectionPump({
		store: runtime,
		consumer,
		leaseMs: 2_000,
		idlePollMs: 10,
		logger: { error() {}, warn() {} },
		proxyFactory: async () => {
			const proxy: AgentSessionFamilyGraphProxy = {
				async callTool(name, args) {
					assert.equal(name, "sparql_update");
					projectionUpdates.push(String(args.update));
					return { ok: true };
				},
			};
			return { proxy, async close() {} };
		},
	});
	const spawner = new SandboxSpawner(
		sandboxStore,
		{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
		{
			sandboxMode: "local-native",
			defaultTimeoutMs: 180_000,
			maxConcurrentSpawns: 4,
			eventBus,
			agentMemory: memory,
			workflowRuntime: runtime,
			familyProjectionPump: projectionPump,
			currentGrantReader: options.currentGrantReader,
		},
	);
	return { runtime, sandboxStore, memory, spawner, projectionUpdates };
}

export interface LocalDomainInvocation {
	readonly harness: LocalHarness;
	readonly home: LocalGraph;
	readonly authority: LocalGraph;
	readonly envelope: InvocationEnvelopeV1;
	readonly runId: string;
	readonly homeGraphId: string;
	readonly homeOwnerPrincipal: string;
	readonly authorityGraphId: string;
	readonly authorityOwnerPrincipal: string;
	readonly ownerUserId: string;
	readonly actorRef: string;
	readonly now: number;
	readonly internalServiceSecret: string;
	readonly capabilityGateError: string;
	readonly onResolved?: (resolved: ResolvedDomainAgentConfigV1) => void;
	readonly deterministicNode?: (spec: AgentNodeSpec, now: number) => AgentNodeResult | undefined;
}

/**
 * Executes the real Domain activity loop while retaining fixture-only graph and
 * node behavior as injected inputs.  It deliberately does not own any F6
 * assertion, Phanes driver, or process lifecycle.
 */
export async function executeLocalDomainInvocation(input: LocalDomainInvocation): Promise<RunRecord> {
	const request = parseDomainAgentInvocationRequest(input.envelope.input);
	const resolved = await resolveDomainAgentConfig({
		graph: input.home,
		graphId: input.homeGraphId,
		homeOwnerPrincipal: input.homeOwnerPrincipal,
		request,
		graphFor: async (address) => {
			assert.deepEqual(address, {
				ownerPrincipal: input.authorityOwnerPrincipal,
				graphId: input.authorityGraphId,
			});
			return input.authority;
		},
		trustedGrantAuthorities: [{ ownerPrincipal: input.authorityOwnerPrincipal, graphId: input.authorityGraphId }],
		trustedTriggerAdapters: ["discord"],
		caller: { authMethod: "internal-service", triggerAdapter: "discord" },
		now: input.now,
	});
	input.onResolved?.(resolved);
	const sourceTurn = await commitDomainSourceTurn({
		runtime: input.harness.runtime,
		request,
		resolved,
		graphOwnerPrincipal: input.homeOwnerPrincipal,
		graphId: input.homeGraphId,
		actorRef: input.actorRef,
		caller: { authMethod: "internal-service", triggerAdapter: "discord" },
		invocation: input.envelope,
		now: Date.now(),
	});
	const inputs = buildDomainAgentActivityInputs({ graphId: input.homeGraphId, request, resolved, sourceTurn });
	await input.harness.runtime.createWorkflowInstance({
		runId: input.runId,
		workflowName: "domain-agent-activity-loop-v1",
		graphId: input.homeGraphId,
		ownerUserId: input.ownerUserId,
		inputs,
		startedAt: Date.now(),
	});

	const graphToolDestructiveness = Object.fromEntries(
		resolved.toolbelt.tools.map((tool) => [tool.name, tool.destructive]),
	);
	const graphBackend = (): CapabilityBackend => ({
		capabilityName: "mnemosyne",
		accessLevel: "rw",
		async listTools() {
			return resolved.pilotToolInclude.map((name) => ({
				name,
				destructive: graphToolDestructiveness[name] ?? false,
			}));
		},
		async callTool() {
			throw new Error(input.capabilityGateError);
		},
		async close() {},
	});
	const eventBus = input.harness.spawner.bus!;
	const baseRunner = makeNodeRunner({
		spawner: input.harness.spawner,
		eventBus,
		authContext: {
			method: "internal_service",
			userId: input.ownerUserId,
			internalServiceSecret: input.internalServiceSecret,
		},
		ownerUserId: input.ownerUserId,
		mnemosyne: {
			mcpUrl: "disabled",
			ownerPrincipal: input.homeOwnerPrincipal,
			graphId: input.homeGraphId,
			capabilities: { reads: true, writes: true, dangerous_ops: false },
		},
		bindCapabilities: async () => new Map([["mnemosyne", graphBackend()]]),
		resolveCapabilityGrantPolicy: (spec) => ({ exactTools: { mnemosyne: spec.includeTools ?? [] } }),
		onProcessSpawn: ({ spec, sandboxId }) =>
			input.harness.runtime.bindAgentSandbox(spec.sessionId!, {
				sandboxId,
				generation: spec.sandboxGeneration ?? 0,
				activationId: spec.invocationId!,
				now: Date.now(),
			}),
		onEvent: async ({ spec, event }) => {
			if ("category" in event && event.category === "execution" && event.type === "compute.cell") {
				await input.harness.runtime.appendExecutionCell(spec.sessionId!, spec.invocationId!, event.cell);
			}
		},
	});
	const residentRunner = makeRuntimeNodeRunner({
		runtime: input.harness.runtime,
		baseRunner,
		memory: input.harness.memory,
		runId: input.runId,
		workflowName: "domain-agent-activity-loop-v1",
		graphId: input.homeGraphId,
		ownerUserId: input.ownerUserId,
		graphOwnerPrincipal: input.homeOwnerPrincipal,
	});
	let now = Date.now();
	const run = await runWorkflow(
		{
			runId: input.runId,
			now: () => now++,
			graph: input.home,
			async runNode(spec) {
				const deterministic = input.deterministicNode?.(spec, now++);
				if (deterministic) return deterministic;
				return residentRunner({
					...spec,
					depth: 0,
					runtimeBindingDigest: digestAgentRuntimeBinding(spec.runtime!),
					ontologyBindingDigest: digestAgentOntologyBinding(spec.ontology!),
				});
			},
		},
		compileWorkflow(DOMAIN_AGENT_ACTIVITY_LOOP_SCRIPT),
		inputs,
	);
	await finalizeDomainAgentActivityRun({
		run,
		inputs,
		graph: input.home,
		runtime: input.harness.runtime,
		graphId: input.homeGraphId,
		ownerUserId: input.ownerUserId,
		actorRef: input.actorRef,
	});
	return run;
}

export async function closeLocalHarness(harness: LocalHarness): Promise<void> {
	await harness.spawner.shutdownAll();
	harness.runtime.close();
	harness.sandboxStore.close();
}
