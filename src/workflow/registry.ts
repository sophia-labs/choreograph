/**
 * In-process workflow registry — Slice 1.
 *
 * Holds the statically-registered set of compiled workflows. Each entry bundles
 * the compiled script, its sha256 (for emporium ingest), and a per-workflow
 * input builder so the run handler stays generic.
 *
 * The registry is populated at module-load time (orchestrator calls
 * `registerWorkflow` for every built-in) and is thereafter read-only during
 * request handling. Dynamic workflow source uses the same `WorkflowRegistryEntry`
 * shape without mutating the registry: Garden can hand Choreograph a trusted,
 * graph-stored workflow binding for one run, while built-ins stay startup-only.
 */

import { createHash } from "node:crypto";
import type { DomainGraphAddressV1 } from "./domain-agent-config.js";
import { type CompiledWorkflow, compileWorkflow, type WorkflowRunInputs } from "./harness.js";
import {
	type ExecutionBindingV1,
	type InvocationEnvelopeV1,
	legacyExecutorFor,
	resolveExecutionBinding,
} from "./invocation.js";
import { localAgentDefaults, localAgentDefaultsEnabled } from "./local-agent-defaults.js";
import type { AgentNodeSpec } from "./types.js";

// ── Registry entry ────────────────────────────────────────────────────────────

/**
 * Per-run context threaded into `buildInputs` so workflow-specific shims can
 * perform graph I/O (e.g. document search) without embedding the graph proxy
 * in the registry at registration time.
 */
export interface WorkflowRunContext {
	/** The graph the run will operate on. */
	graph?: import("./graph-writer.js").GraphWriter;
	/** Resolve another authorized owner-scoped cell, used for Layer 0 authority documents. */
	graphFor?: (address: DomainGraphAddressV1) => Promise<import("./graph-writer.js").GraphWriter>;
	graphId: string;
	/** Host-resolved owner half of the home graph tuple. */
	graphOwnerPrincipal?: string;
	/** Durable host services and canonical invocation facts; never workflow_args. */
	runtime?: import("./runtime-store.js").WorkflowRuntimeStore;
	invocation?: InvocationEnvelopeV1;
	actorRef?: string;
	/** The acting person the host authenticated (the gateway's `x-user-id`); the owner of what they create. */
	ownerUserId?: string;
	/** The host's live model catalogue; absent on a host that has none (a narrow test, a bare development box). */
	modelCatalog?: import("../chat-models.js").ChatModelCatalogueSource;
	/** The providers of each voice and their refusals (precision, `chat-precision.ts`). */
	chatVoiceMarket?: import("../chat-precision.js").ChatVoiceMarket;
	/** Where the host records the decisions it takes about a request (the credit gate's `gate_events`): a refused voice is one. */
	creditGate?: Pick<import("../billing-gate.js").CreditAdmission, "recordModelUnpriced">;
	/** Authenticated ingress facts produced by the host, never by workflow_args. */
	caller?: {
		readonly authMethod: "owner" | "internal-service";
		readonly triggerAdapter?: string;
	};
	/**
	 * The caller's role on the graph as the gateway minted it (`x-sophia-graph-role`), passed on only when the
	 * request authenticated as the internal service (the gateway). Unvalidated: a workflow that uses it must
	 * refuse anything that is not exactly a role.
	 */
	gatewayGraphRole?: string;
	/**
	 * A read of the run's graph as the acting person (the run's graph proxy), for facts a workflow must check before it
	 * tells a model they hold: the workspace chat admits the first turn's `contextRefs` with it.
	 */
	readGraph?: import("../agent-runtime/turn-context.js").TurnContextRefReader;
	/** The tool names the run's graph serves the acting person (every page of its live tools/list). */
	listGraphTools?: () => Promise<readonly string[]>;
}

export interface WorkflowFinalizeContext {
	graph: import("./graph-writer.js").GraphWriter;
	runtime: import("./runtime-store.js").WorkflowRuntimeStore;
	graphId: string;
	ownerUserId: string;
	actorRef: string;
	inputs: WorkflowRunInputs;
}

/**
 * One registered workflow: its compiled artifact, the sha256 of its source
 * (for emporium ingest — NOT stored on `CompiledWorkflow` so harness.ts stays
 * frozen), and a per-workflow function that turns a raw request body into
 * `WorkflowRunInputs`.
 */
export interface WorkflowRegistryEntry {
	compiled: CompiledWorkflow;
	/** sha256 (hex) of the workflow script source — emporium ingest lineage. */
	scriptSha256: string;
	/**
	 * Build the `WorkflowRunInputs` for a run from the raw JSON request body
	 * and the per-request run context. Workflow-specific validation and input
	 * construction happen here; generic callers that send `workflow_args` use
	 * `body.workflow_args` directly and ignore the context. May be async (e.g.
	 * survey-synthesize performs a doc-search when no explicit doc_ids are given).
	 */
	buildInputs: (body: unknown, ctx: WorkflowRunContext) => WorkflowRunInputs | Promise<WorkflowRunInputs>;
	/** Trusted post-wave edge. Runs after every sandbox is terminal and before the invocation receipt is sealed. */
	finalizeRun?: (run: import("./types.js").RunRecord, ctx: WorkflowFinalizeContext) => void | Promise<void>;
	/**
	 * What this host tells clients about the workflow beyond its declared schema: defaults and limits taken from
	 * host configuration (the House default voice, seed limits). Read afresh on every registry listing.
	 */
	host?: () => Record<string, unknown>;
}

export interface DynamicWorkflowSourceBinding {
	/** Portable workflow source (`export const meta = { … }` + top-level body). */
	source: string;
	/** Optional caller expectation; a mismatch is a 400-class composition error. */
	expectedName?: string;
	/** Optional caller-supplied sha. When present it must match the source bytes. */
	expectedSha256?: string;
}

export interface DynamicWorkflowRunBody {
	workflow_args?: unknown;
	model?: string;
	workflow_model?: string;
	tool_mode?: AgentNodeSpec["toolMode"];
	system_prompt?: string;
}

// ── The registry ─────────────────────────────────────────────────────────────

const REGISTRY = new Map<string, WorkflowRegistryEntry>();

/**
 * Register a workflow. Called once per workflow at module load (before the
 * HTTP server starts accepting connections). Silently overwrites if the same
 * name is registered twice (last-write wins; useful for tests).
 */
export function registerWorkflow(entry: WorkflowRegistryEntry): void {
	REGISTRY.set(entry.compiled.meta.name, entry);
}

/**
 * Build a one-off registry entry from trusted workflow source without registering
 * it globally. This is the Choreograph half of the graph-native composition loop:
 * Garden/Emporium remains the workbench and source of truth, Choreograph compiles
 * the supplied binding for validation/execution and journals the run normally.
 */
export function workflowEntryFromSource(
	binding: DynamicWorkflowSourceBinding,
	defaults: { graphId: string; model: string },
): WorkflowRegistryEntry {
	const compiled = compileWorkflow(binding.source);
	if (binding.expectedName && compiled.meta.name !== binding.expectedName) {
		throw Object.assign(
			new Error(
				`workflow_source meta.name '${compiled.meta.name}' does not match workflow_name '${binding.expectedName}'`,
			),
			{ status: 400 },
		);
	}
	const scriptSha256 = createHash("sha256").update(compiled.source).digest("hex");
	if (binding.expectedSha256 && binding.expectedSha256 !== scriptSha256) {
		throw Object.assign(new Error("workflow_source sha256 does not match supplied scriptSha256"), { status: 400 });
	}
	return {
		compiled,
		scriptSha256,
		buildInputs(body, ctx) {
			const b = body as DynamicWorkflowRunBody;
			const workflowArgs = b.workflow_args ?? {};
			const ownerPrincipal = ctx.graphOwnerPrincipal ?? (ctx.ownerUserId ? `user:${ctx.ownerUserId}` : undefined);
			// A local Choreograph binds agent() steps that name no runtime or ontology (local-agent-defaults.ts).
			const agentDefaults =
				localAgentDefaultsEnabled() && ownerPrincipal
					? localAgentDefaults({ workflowName: compiled.meta.name, graphId: ctx.graphId, ownerPrincipal })
					: undefined;
			return {
				config: {
					graphId: ctx.graphId,
					model: b.workflow_model ?? b.model ?? defaults.model,
					toolMode: b.tool_mode,
					systemPrompt: b.system_prompt,
					...(agentDefaults ?? {}),
				},
				args: workflowArgs,
				schemaInput: workflowArgs,
			};
		},
	};
}

/**
 * Look up a workflow by name. Returns `undefined` if the name is not
 * registered — callers should respond 400 for unknown names.
 */
export function getWorkflow(name: string): WorkflowRegistryEntry | undefined {
	return REGISTRY.get(name);
}

/**
 * Enumerate all registered workflows as a lightweight summary suitable for
 * the `GET /api/workflows` listing endpoint.
 */
export function listWorkflows(): Array<{
	name: string;
	workflowUri: string;
	definitionDigest: string;
	description?: string;
	whenToUse?: string;
	phases?: Array<{ title: string; detail?: string }>;
	inputs?: Record<string, unknown>;
	outputs?: Record<string, unknown>;
	executor?: "gated" | "dumb";
	execution: ExecutionBindingV1;
	host?: Record<string, unknown>;
}> {
	return [...REGISTRY.values()].map(({ compiled: { meta }, scriptSha256, host }) => ({
		name: meta.name,
		workflowUri: `urn:sophia:wf:${meta.name}`,
		definitionDigest: scriptSha256,
		description: meta.description,
		whenToUse: meta.whenToUse,
		phases: meta.phases,
		inputs: meta.inputs,
		outputs: meta.outputs,
		executor: legacyExecutorFor(resolveExecutionBinding(meta)),
		execution: resolveExecutionBinding(meta),
		...(host ? { host: host() } : {}),
	}));
}

/**
 * Project a registered workflow into the `api:WorkflowBinding` schema shape for
 * the `GET /api/workflows/{name}/schema` endpoint. Returns `undefined` for an
 * unregistered name (the route maps that to a 404).
 *
 * `inputSchema`/`outputSchema` are the workflow's declared `meta.inputs`/
 * `meta.outputs` JSON Schemas verbatim, or the permissive `{ "type": "object" }`
 * default when a workflow declares none — so the endpoint always returns a valid
 * JSON Schema. `executor` defaults to `"gated"`.
 */
export function workflowSchema(name: string):
	| {
			name: string;
			workflowUri: string;
			definitionDigest: string;
			executor: "gated" | "dumb";
			execution: ExecutionBindingV1;
			inputSchema: Record<string, unknown>;
			outputSchema: Record<string, unknown>;
	  }
	| undefined {
	const entry = REGISTRY.get(name);
	if (!entry) return undefined;
	const { meta } = entry.compiled;
	const execution = resolveExecutionBinding(meta);
	const permissive = (): Record<string, unknown> => ({ type: "object" });
	return {
		name: meta.name,
		workflowUri: `urn:sophia:wf:${meta.name}`,
		definitionDigest: entry.scriptSha256,
		executor: legacyExecutorFor(execution),
		execution,
		inputSchema: meta.inputs ?? permissive(),
		outputSchema: meta.outputs ?? permissive(),
	};
}
