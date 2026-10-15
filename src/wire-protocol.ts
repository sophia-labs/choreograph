/**
 * NDJSON protocol for generic runtime and kernel workers.
 * Prime agents use `choreograph.prime-host-bridge.v1` exclusively.
 */

import type { VerifiedExecutionCapsuleV1 } from "./agent-runtime/content-authority-contract.js";
import type { AgentEmbodimentV1, RuntimeOverlayRole } from "./agent-runtime/evolution.js";
import type { MeaningfulObjectRefV1 } from "./agent-runtime/meaningful-object.js";
import type { AgentOntologyBindingV1 } from "./agent-runtime/ontology-binding.js";
import type { AgentRuntimeBindingV2 } from "./agent-runtime/profile.js";
import type { AgentSeedRefV1 } from "./chat-seed.js";

export const RUNTIME_OVERLAY_MATERIALIZATION_SCHEMA = "sophia.runtime-overlay-materialization.v1" as const;
export const HARNESS_MATERIALIZATION_SCHEMA = "sophia.harness-materialization.v1" as const;

export interface RuntimeOverlayMaterializationV1 {
	readonly schema: typeof RUNTIME_OVERLAY_MATERIALIZATION_SCHEMA;
	readonly role: Exclude<RuntimeOverlayRole, "evaluation-fixture">;
	readonly ownerPrincipal: string;
	readonly artifact: MeaningfulObjectRefV1<"release-artifact">;
	readonly manifestRef: MeaningfulObjectRefV1<"skill" | "tool-manifest" | "harness">;
	readonly order: number;
	readonly guestPath: string;
	readonly artifactDigest: string;
	readonly manifestDigest: string;
}

export interface HarnessMaterializationV1 {
	readonly schema: typeof HARNESS_MATERIALIZATION_SCHEMA;
	readonly harnessRef: MeaningfulObjectRefV1<"harness">;
	readonly snapshot: Readonly<Record<string, unknown>> & { readonly schema: 1 };
}

export interface MnemosyneSessionDescriptor {
	mcp_url: string;
	session_token: string;
	graph_scope: {
		default_graph_owner?: string;
		default_graph_id: string;
		allowed_graph_ids?: string[];
		/** True when the host has bound an owner-scoped cloud cell. */
		bound_cell?: boolean;
	};
	tool_profile: "chat" | "familiar" | "full";
	expires_at: string;
}

export interface WardConfig {
	max_turns: number;
	max_depth: number;
	require_done_tool: boolean;
}

/**
 * Host-validated model facts from the dynamic provider catalog. Deliberately
 * excludes credentials and base URLs: provider routing remains host authority.
 */
export interface TrustedModelDescriptor {
	id: string;
	canonicalId?: string;
	name: string;
	api: "openai-completions";
	provider: "openrouter";
	reasoning: boolean;
	input: Array<"text" | "image">;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
	supportedParameters: string[];
	supportsTools: boolean | null;
	catalogDigest: string;
	catalogFetchedAt: string;
}

export interface AgentSpawnRequest {
	spawn_id: string;
	/** Canonical collaborative session identity; never inferred from the sandbox id. */
	session_id: string;
	/** Fenced materialization generation for passivation/restart. */
	generation: number;
	/** Exact durable materialization activation fence, supplied by the host only. */
	invocation_id?: string;
	intent: string;
	/** Wait for an exact durable prompt command instead of inventing an initial turn. */
	await_initial_command?: true;
	messages?: unknown[];
	system_prompt?: string;
	/** Sealed I-authority receipt/capsule; Prime must derive its system prompt and skills only from this value. */
	verified_execution_capsule?: VerifiedExecutionCapsuleV1;
	wards: WardConfig;
	mnemosyne: MnemosyneSessionDescriptor;
	medium: "conversation" | "code";
	model: string;
	/**
	 * Per-request inference provider (CA-1 shared substrate). Optional and
	 * ADDITIVE — sits alongside the existing flat `model` (no `{model,provider}`
	 * nesting). Unset ⇒ the worker resolves the env-default ("openrouter"), so
	 * behavior is byte-identical to before. The agent-subject control surface:
	 * the binding rides per-request, NOT a global server env.
	 */
	provider?: string;
	/** Host-populated dynamic catalog overlay. Client-provided values are ignored by the spawner. */
	model_descriptor?: TrustedModelDescriptor;
	/** Host-admitted models exposed to a native headed client for this materialization. */
	model_catalog?: readonly TrustedModelDescriptor[];
	/** Headed sessions host the native Prime daemon until the attached client closes. */
	interaction_mode?: "headless" | "headed";
	/**
	 * Stable registered Agent identity. It is exactly the ontology subject and
	 * observer witness; model/prompt hashing is not an executable fallback.
	 */
	agent_id: string;
	depth: number;
	parent_spawn_id?: string;
	/**
	 * Forced structured output. When set, the worker exposes a required `submit`
	 * tool whose parameters are this JSON Schema; Pi validates the model's call
	 * against it (retrying on mismatch). The validated object is returned as
	 * `structured_output` on the result. This is the workflow-engine ("Loom")
	 * path — agents judge, the schema serializes.
	 */
	output_schema?: unknown;
	/** Mnemosyne tool surface: "dynamic" (full, default), "curated" (4 read/write tools), or "none". */
	tool_mode?: "dynamic" | "curated" | "none";
	/** Tool names to exclude (dynamic mode only). */
	exclude_tools?: string[];
	/** Strict tool allowlist (dynamic mode only). */
	include_tools?: string[];
	/** Fail closed when an included dynamic tool is not discovered. */
	strict_tool_manifest?: boolean;
	/**
	 * Multi-driver permission gate (CA-1 / B-keystone). When true, the worker
	 * installs a `beforeToolCall` hook that BLOCKS each destructive tool call
	 * until the session driver approves it via the `acp.authority` capability
	 * gate. ABSENT / false ⇒ no hook, byte-identical to the pre-keystone worker.
	 * The orchestrator sets this exactly when it also registers `acp.authority`.
	 */
	gate_destructive_tools?: boolean;
	/** Per-node host-bound capabilities; the sandbox sees names, never credentials. */
	capabilities?: Record<string, { kind: string; [key: string]: unknown }>;
	/** Fully resolved, digest-pinned runtime profile. Required for every execution. */
	runtime_binding: AgentRuntimeBindingV2;
	runtime_binding_digest: string;
	/** Complete Agent/observer Meaningful Object binding. Required for every execution. */
	agent_ontology: AgentOntologyBindingV1;
	agent_ontology_binding_digest: string;
	/** Required together for runtime-binding v2; omitted together for legacy v1. */
	embodiment_ref?: MeaningfulObjectRefV1<"embodiment">;
	embodiment_binding?: AgentEmbodimentV1;
	embodiment_binding_digest?: string;
	runtime_overlays?: readonly RuntimeOverlayMaterializationV1[];
	/** Exact graph-resolved harness state for the active Ontology binding. */
	harness_materialization?: HarnessMaterializationV1;
	/** Public face of a host-private candidate workspace mount. */
	candidate_workspace?: {
		readonly schema: "sophia.candidate-workspace-mount.v1";
		readonly workspaceId: string;
		readonly mountPath: "/candidate";
		readonly generation: number;
		readonly leaseToken: string;
	};
	/** Optional durable goal seed for the canonical session repository. */
	initial_goal?: { objective: string; token_budget?: number };
}

export interface AgentSpawnResult {
	spawn_id: string;
	status: "terminated" | "truncated" | "error";
	output: string;
	turns: number;
	messages?: unknown[];
	/** Total LLM tokens across the run (sum of assistant message usage). */
	tokens?: number;
	/** Number of tool calls the agent made. */
	tool_calls?: number;
	/** Validated structured output, when an `output_schema`/`submit` tool was used. */
	structured_output?: unknown;
	session_id?: string;
	runtime_binding_digest?: string;
	agent_ontology_binding_digest?: string;
	/** Untrusted restorable Prime state; Choreograph commits it as a Sophia checkpoint. */
	prime_state?: unknown;
	embodiment_digest?: string;
	runtime_overlay_digests?: readonly string[];
}

export type RuntimeKind = "node" | "python";

export type KernelKind = "python3" | "julia" | "ocaml" | "cpp";

/** Keys are MIME types, values are string-encoded content. */
export type MimeBundle = Record<string, string>;

export type SandboxEvent =
	| { type: "headed_ready" }
	| { type: "prompt"; text: string; command_id: string }
	| { type: "follow_up"; text: string; command_id: string }
	| { type: "turn_start"; turn: number }
	| { type: "text"; content: string }
	| { type: "thinking"; content: string }
	| { type: "tool_call"; gate: string; args: Record<string, unknown> }
	| { type: "tool_result"; gate: string; result: string; is_error: boolean; cell_ref?: string }
	| { type: "steer"; text: string; command_id?: string; client_id?: string }
	| { type: "turn_end"; turn: number }
	| { type: "done"; output: string }
	| { type: "truncated"; output: string; turns: number }
	| { type: "error"; message: string }
	| PrimeSemanticEvent;

export interface PrimeSemanticEvent {
	type: "prime_event";
	name: string;
	payload: unknown;
	session_id: string;
	runtime_binding_digest: string;
	agent_ontology_binding_digest: string;
	embodiment_digest?: string;
}

export type RuntimeEvent =
	| { type: "runtime_ready"; runtime: RuntimeKind }
	| { type: "runtime_busy"; input_id: string }
	| { type: "runtime_stdout"; input_id: string; text: string }
	| { type: "runtime_stderr"; input_id: string; text: string }
	| {
			type: "runtime_result";
			input_id: string;
			ok: boolean;
			/** Human-readable inspection face. */
			result?: string;
			/** Lossless JSON face for machine invocation results. */
			result_json?: string;
			error?: string;
	  }
	| { type: "runtime_exit"; runtime: RuntimeKind; exit_code?: number | null; signal?: string | null };

export type KernelEvent =
	// Lifecycle
	| { type: "kernel_ready"; kernel: KernelKind }
	| { type: "kernel_exit"; kernel: KernelKind; exit_code?: number | null; signal?: string | null }
	// Execution state (per input_id)
	| { type: "kernel_busy"; input_id: string }
	| { type: "kernel_idle"; input_id: string }
	// Stream output (stdout/stderr, may arrive in chunks)
	| { type: "kernel_stream"; input_id: string; name: "stdout" | "stderr"; text: string }
	// Rich outputs (MIME bundles)
	| { type: "kernel_display"; input_id: string; data: MimeBundle; metadata?: Record<string, unknown> }
	| {
			type: "kernel_result";
			input_id: string;
			data: MimeBundle;
			metadata?: Record<string, unknown>;
			execution_count: number;
	  }
	// Errors
	| { type: "kernel_error"; input_id: string; ename: string; evalue: string; traceback: string[] }
	// Shell reply (execution complete, status summary)
	| { type: "kernel_reply"; input_id: string; status: "ok" | "error"; execution_count: number }
	| { type: "kernel_host_request"; request_id: string; input_id: string; payload: Record<string, unknown> };

export type WorkerEvent =
	| SandboxEvent
	| RuntimeEvent
	| KernelEvent
	| {
			type: "started";
			mode?: string;
			pid?: number;
			child_pid?: number;
			command?: string[];
			cwd?: string;
			runtime?: RuntimeKind;
	  }
	| {
			type: "heartbeat";
			iteration: number;
			pid?: number;
			uptime?: number;
			memory?: Record<string, number>;
			buffersAllocated?: number;
	  }
	| { type: "stdout"; text: string }
	| { type: "stderr"; text: string }
	| { type: "progress"; message: string };

export interface ProxyUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export const ZERO_USAGE: ProxyUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export type ProxyAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; contentSignature?: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number }
	/** `responseId`: the provider's own id for the call (OpenRouter: the generation id `gen-…`), when it gave one. */
	| {
			type: "done";
			reason: "stop" | "length" | "toolUse";
			usage: ProxyUsage;
			responseId?: string;
			/** What OpenRouter reports it charged, for a call made through the usage tap (`openrouter-usage-tap.ts`). */
			providerUsage?: { costUsd: number; generationId: string | null; provider: string | null };
	  }
	| { type: "error"; reason: "aborted" | "error"; errorMessage?: string; usage: ProxyUsage; responseId?: string };

export type WorkerMessage =
	| { kind: "event"; event: WorkerEvent }
	| { kind: "result"; result: AgentSpawnResult | Record<string, unknown> }
	| { kind: "spawn"; request: AgentSpawnRequest }
	/**
	 * Gate call — Contract B / Slice 3 promoted envelope.
	 * capability: CapabilityBackend name ("mnemosyne", "subject.web", …)
	 * tool: tool name within the capability ("search_documents", "__list_tools", …)
	 * gate_result is UNCHANGED — keyed purely by call_id.
	 */
	| { kind: "gate_call"; call_id: string; capability: string; tool: string; args: Record<string, unknown> };

export type OrchestratorMessage =
	| { kind: "spawn_result"; spawn_id: string; result: AgentSpawnResult }
	| { kind: "gate_result"; call_id: string; result: unknown; is_error: boolean }
	| { kind: "steer"; text: string; command_id?: string; client_id?: string; ts?: number }
	| { kind: "headed_attach" }
	| { kind: "headed_close" }
	| { kind: "runtime_input"; input_id: string; code: string }
	| { kind: "runtime_close" }
	| { kind: "kernel_execute"; input_id: string; code: string }
	| { kind: "kernel_interrupt" }
	| { kind: "kernel_host_response"; request_id: string; ok: boolean; result?: unknown; error?: unknown }
	| { kind: "kernel_close" };

export interface AgentWorkerConfig {
	mode: "agent";
	request?: Partial<AgentSpawnRequest>;
	intent?: string;
	messages?: unknown[];
	system_prompt?: string;
	/** Host-sealed I authority; caller input never reaches this field without preflight admission. */
	verified_execution_capsule?: VerifiedExecutionCapsuleV1;
	wards?: Partial<WardConfig>;
	mnemosyne?: Partial<MnemosyneSessionDescriptor>;
	medium?: "conversation" | "code";
	model?: string;
	/** Per-request inference provider (CA-1 shared substrate). Additive; unset ⇒ env-default. */
	provider?: string;
	interaction_mode?: "headless" | "headed";
	/**
	 * Stable agent-subject observer id. Additive override: if a caller pins one it
	 * wins; otherwise the spawner mints it from the resolved `{model, system_prompt}`
	 * by the graph-resolved Agent Meaningful Object. Threaded onto `AgentSpawnRequest.agent_id`.
	 */
	agent_id?: string;
	depth?: number;
	parent_spawn_id?: string;
	/** Forced structured output schema (workflow-engine path). */
	output_schema?: unknown;
	/** Mnemosyne tool surface mode. */
	tool_mode?: "dynamic" | "curated" | "none";
	/** Tool names to exclude (dynamic mode only). */
	exclude_tools?: string[];
	/** Strict tool allowlist (dynamic mode only). */
	include_tools?: string[];
	/** Fail closed when an included dynamic tool is not discovered. */
	strict_tool_manifest?: boolean;
	/**
	 * Multi-driver permission gate (CA-1 / B-keystone). Forwarded verbatim to the
	 * worker request; the worker installs the destructive-tool `beforeToolCall`
	 * hook iff true. Absent ⇒ byte-identical to the pre-keystone path.
	 */
	gate_destructive_tools?: boolean;
	/** Required semantic authority. The spawner rejects absence before any side effect. */
	session_id?: string;
	generation?: number;
	/** Exact durable materialization activation fence, never supplied by a sandbox. */
	invocation_id?: string;
	/** Host-verified Prime state used only to construct runtime.restore. */
	restore_state?: unknown;
	/** Thread the durable-command-first startup mode to the Prime host request. */
	await_initial_command?: true;
	runtime_binding?: AgentRuntimeBindingV2;
	runtime_binding_digest?: string;
	agent_ontology?: AgentOntologyBindingV1;
	agent_ontology_binding_digest?: string;
	embodiment_ref?: MeaningfulObjectRefV1<"embodiment">;
	embodiment_binding?: AgentEmbodimentV1;
	embodiment_binding_digest?: string;
	/** Trusted graph-resolved harness state; request-level values are ignored. */
	harness_materialization?: HarnessMaterializationV1;
	/** Trusted host-only candidate workspace lease; its hostPath is never serialized. */
	candidate_workspace?: {
		readonly schema: "sophia.candidate-workspace-lease.v1";
		readonly ownerPrincipal: string;
		readonly agentId: string;
		readonly workspaceId: string;
		readonly hostPath: string;
		readonly mountPath: "/candidate";
		readonly generation: number;
		readonly leaseToken: string;
		readonly expiresAt: number;
	};
	initial_goal?: { objective: string; token_budget?: number };
	/** Capability declarations resolved into host backends before spawn. */
	capabilities?: Record<string, { kind: string; [key: string]: unknown }>;
	/**
	 * Host-only reference to the earlier conversation a continued chat carries. The spawner resolves it into
	 * the system prompt when it builds the worker request; it never reaches the sandbox as a field.
	 */
	seed_ref?: AgentSeedRefV1;
}

export interface RuntimeWorkerConfig {
	mode: "runtime";
	runtime: RuntimeKind;
	cwd?: string;
	env?: Record<string, string | number | boolean | null>;
	bootstrap_code?: string;
	/** Injected by spawner for Python — absolute Rust bridge launch command. */
	bridge_command?: string[];
}

export interface KernelWorkerConfig {
	mode: "kernel";
	kernel: KernelKind;
	cwd?: string;
	env?: Record<string, string>;
	bootstrap_code?: string;
	/** Injected by spawner — bridge launch command (guest paths). */
	bridge_command?: string[];
}

export function isKernelWorkerConfig(value: unknown): value is KernelWorkerConfig {
	return typeof value === "object" && value !== null && (value as { mode?: unknown }).mode === "kernel";
}

export function isAgentWorkerConfig(value: unknown): value is AgentWorkerConfig {
	return typeof value === "object" && value !== null && (value as { mode?: unknown }).mode === "agent";
}

export function isRuntimeWorkerConfig(value: unknown): value is RuntimeWorkerConfig {
	return typeof value === "object" && value !== null && (value as { mode?: unknown }).mode === "runtime";
}
