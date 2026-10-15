/**
 * Sandbox spawner — integrates bwrap, cgroup management, and SQLite store.
 *
 * Manages the full lifecycle: spawn bwrap with cgroup limits, track state,
 * read resource usage on exit, support graceful kill.
 *
 * Spawn requests are accepted immediately (state: "queued") and executed
 * in the background with bounded concurrency via a semaphore.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { type Span, type SpanContext, SpanStatusCode, trace } from "@opentelemetry/api";
import type { AuthorityCapabilityBackend } from "./acp/authority-backend.js";
import { AgentModeError, type AgentModeFenceV1 } from "./agent-runtime/agent-mode.js";
import {
	type AgentSessionCommandActivation,
	AgentSessionCommandActivationService,
	AgentSessionCommandActivationTerminalError,
} from "./agent-runtime/agent-session-command-activation-service.js";
import type { AgentSessionFamilyGraphProxy } from "./agent-runtime/agent-session-family-graph-projection.js";
import {
	type AgentSessionFamilyProjectionGraphAuthority,
	type AgentSessionFamilyProjectionGraphLease,
	AgentSessionFamilyProjectionPump,
} from "./agent-runtime/agent-session-family-projection-pump.js";
import {
	AgentSessionHeartbeatHostRequestFault,
	type AgentSessionHeartbeatParentContext,
	type AgentSessionHeartbeatPort,
	AgentSessionHeartbeatService,
} from "./agent-runtime/agent-session-heartbeat-service.js";
import {
	type AgentSessionScheduleActivation,
	AgentSessionScheduleActivationTerminalError,
	AgentSessionSchedulerService,
} from "./agent-runtime/agent-session-scheduler-service.js";
import {
	type AgentSessionChildCleanupInput,
	type AgentSessionChildCleanupResult,
	AgentSessionChildCleanupUnavailable,
	type AgentSessionChildDurableAuthority,
	type AgentSessionChildExecutionResult,
	AgentSessionChildExecutionService,
	AgentSessionChildHostRequestFault,
} from "./agent-runtime/child-execution-service.js";
import {
	assertVerifiedExecutionCapsuleReplay,
	type VerifiedExecutionCapsuleV1,
} from "./agent-runtime/content-authority-contract.js";
import {
	type ContentAuthorityAdmissionPort,
	type ContentAuthorityAdmissionPortInput,
	createContentAuthorityAdmissionPort,
	isSealedVerifiedExecutionCapsule,
} from "./agent-runtime/content-authority-runtime.js";
import {
	type AgentEmbodimentV1,
	digestAgentEmbodiment,
	digestAgentRuntimeBindingV2,
	validateAgentEmbodiment,
} from "./agent-runtime/evolution.js";
import {
	invokeKernelHostCapability,
	KernelExecutionService,
	KernelSpawnFailure,
} from "./agent-runtime/execution-service.js";
import type { PrimeExtensionBuilder } from "./agent-runtime/extension-builder.js";
import {
	PRIME_HOST_PROTOCOL_VERSION,
	type PrimeCommandResultV1,
	type PrimeGoalHostResponseV1,
	type PrimeHostBridgeMessageV1,
	type PrimeHostCommandV1,
	type PrimeHostErrorV1,
	PrimeHostProtocolFault,
	type PrimeHostResponseV1,
	type PrimeWorkerEventV1,
	type PrimeWorkerRequestV1,
	type PrimeWorkerResultV1,
	parsePrimeHostBridgeMessage,
} from "./agent-runtime/host-protocol.js";
import {
	createMeaningfulObjectRef,
	type MeaningfulObjectRefV1,
	sameMeaningfulObjectRef,
	validateMeaningfulObjectRef,
} from "./agent-runtime/meaningful-object.js";
import type { AgentMemory } from "./agent-runtime/memory.js";
import { projectExecutionCellToNotebook } from "./agent-runtime/notebook-graph-projection.js";
import {
	assertAgentOntologyRuntimeMatch,
	digestAgentOntologyBinding,
	validateAgentOntologyBinding,
} from "./agent-runtime/ontology-binding.js";
import { digestAgentRuntimeBinding, validateResolvedAgentRuntimeBinding } from "./agent-runtime/profile.js";
import {
	AgentResultValidationFault,
	PRIME_RUNTIME_STATE_SCHEMA,
	type PrimeRuntimeStateV2,
	validateCanonicalAgentSpawnResult,
	validatePrimeSemanticEventAuthority,
} from "./agent-runtime/result-validation.js";
import { parseRlmHostError, type RlmHostError } from "./agent-runtime/rlm-control-contract.js";
import { AGENT_SESSION_SEMANTIC_EVENT_SCHEMA, mirrorAgentSessionEvent } from "./agent-runtime/session-event-mirror.js";
import { toolFailureLogLine } from "./agent-runtime/tool-error-summary.js";
import { type DeletionReceiptV1, deletionReceipts } from "./agent-runtime/tool-targets.js";
import { admitTurnContextRefs, turnTextForModel } from "./agent-runtime/turn-context.js";
import { canonicalDigest, canonicalJson } from "./agent-subject/canonical-json.js";
import type { HostedAuthContext } from "./auth.js";
import {
	type CreditAdmission,
	INSUFFICIENT_CREDIT_CODE,
	INSUFFICIENT_CREDIT_PREFIX,
	InsufficientCreditError,
	isProviderPaymentFailure,
	PROVIDER_UNAVAILABLE_CODE,
	PROVIDER_UNAVAILABLE_MESSAGE,
	PROVIDER_UNAVAILABLE_PREFIX,
} from "./billing-gate.js";
import { providerModelForAccounting, staticPricingVersion } from "./billing-pricing.js";
import {
	inferenceContextHasImages,
	OPENROUTER_TOOL_ROUTING,
	openRouterFallbackRouting,
	openRouterRoutingForRateCard,
	priceAtProviderReport,
	priceInferenceCall,
	providerChargeMicroUsd,
	type RateCardV1,
	rateCardFromSessionDocumentJson,
} from "./billing-rate-card.js";
import type { BillingStore, UsageEventInput, UsageEventRecord } from "./billing-store.js";
import { BrowserCapabilityBackend, resolveBrowserServiceUrl } from "./browser-capability.js";
import { applyHostCapabilityGrantPolicy, type HostCapabilityGrantPolicyV1 } from "./capabilities/grant-gate.js";
import {
	type CgroupConfig,
	type CgroupHierarchy,
	createSandboxCgroup,
	launchInCgroup,
	readUsage,
	removeSandboxCgroup,
} from "./cgroup.js";
import { type ChatModelHealth, classifyOpenRouterRefusal } from "./chat-model-health.js";
import { type ChatSeedResolver, parseAgentSeedRef, resolveSeededSystemPrompt } from "./chat-seed.js";
import type { BusEvent, CapabilityEvent, SandboxEventBus } from "./event-bus.js";
import { resolveBridge, resolveLocalPythonBridge, resolvePythonRuntimeBridge } from "./kernel-bridges.js";
import {
	activeSandboxes,
	agentRunDurationSeconds,
	agentRunErrorsTotal,
	agentRunsTotal,
	agentTurnsPerRun,
	cpuUsageSeconds,
	exitsTotal,
	gateCallDurationSeconds,
	gateCallsTotal,
	killsTotal,
	llmRequestDurationSeconds,
	llmRequestsTotal,
	llmTokensTotal,
	memoryPeakBytes,
	sandboxLifetimeSeconds,
	spawnDurationSeconds,
	spawnErrorsTotal,
	spawnQueueDepth,
	spawnQueueWaitSeconds,
	spawnsTotal,
	toolCallDurationSeconds,
	toolCallsTotal,
} from "./metrics.js";
import {
	type CapabilityBackend,
	HostedMnemosyneProxy,
	type HostedSessionCapabilities,
	resolveDirectMcpAuth,
	resolveGatewayServiceAuth,
	wrapMnemosyneProxy,
} from "./mnemosyne.js";
import { proxyMockModel } from "./mock-llm.js";
import type { ModelCatalogResolver } from "./model-catalog.js";
import { NdjsonLineLimitError, parseNdjsonLine } from "./ndjson-line.js";
import {
	type CaptureEmitter,
	type CaptureIdentity,
	type CaptureOutcome,
	captureIdentityForHostedRequest,
	emitCaptureSoft,
} from "./observatory-capture.js";
import { proxyLlmRequest } from "./openrouter.js";
import { type OpenRouterKeyStore, selectOpenRouterCredential } from "./openrouter-credentials.js";
import { withPriceCeilingFallback } from "./openrouter-fallback.js";
import { resolveAgentLlmProvider } from "./provider-default.js";
import { PROVIDER_REGISTRY, resolveProviderEntry } from "./provider-registry.js";
import {
	digestLocalAgentRuntime,
	PYTHON_RUNTIME_SANDBOX_PATH,
	resolveRuntimeBundleDescriptor,
	SOPHIA_AGENT_PYTHONPATH,
	SOPHIA_AGENT_RUNTIME_BUNDLE_ID,
	SOPHIA_AGENT_SANDBOX_PATH,
} from "./runtime-bundles.js";
import type { ResourceConfig, SandboxRecord, SandboxStore } from "./sandbox-store.js";
import {
	buildBwrapArgs,
	type PrivateSandboxMount,
	resolveTemplateFilesystemIds,
	type WorkerEntrypoint,
} from "./templates.js";
import {
	type AgentSpawnRequest,
	type AgentSpawnResult,
	type AgentWorkerConfig,
	HARNESS_MATERIALIZATION_SCHEMA,
	type HarnessMaterializationV1,
	isAgentWorkerConfig,
	isKernelWorkerConfig,
	isRuntimeWorkerConfig,
	type KernelKind,
	type MnemosyneSessionDescriptor,
	type OrchestratorMessage,
	type ProxyAssistantMessageEvent,
	RUNTIME_OVERLAY_MATERIALIZATION_SCHEMA,
	type RuntimeKind,
	type SandboxEvent,
	type WardConfig,
	type WorkerMessage,
	ZERO_USAGE,
} from "./wire-protocol.js";
import { type AgentModeReader, HostedAgentModeReader, rereadPinnedAgentMode } from "./workflow/agent-mode-reader.js";
import {
	type AgentToolGrantV1,
	assertGrantActive,
	grantDigest,
	parseAgentToolGrant,
} from "./workflow/agent-tool-grant.js";
import { type CurrentGrantReader, HostedCurrentGrantReader } from "./workflow/current-grant-reader.js";
import { unwrapAuthoredJsonDocument } from "./workflow/graph-writer.js";
import { makeNodeRunner } from "./workflow/run-node.js";
import { makeRuntimeNodeRunner } from "./workflow/runtime-control.js";
import {
	type AgentSessionChildRunClaim,
	type AgentSessionCommandName,
	type AgentSessionCommandRecord,
	type AgentSessionInferenceBillingEvent,
	type AgentSessionInferenceFenceInput,
	type AgentSessionRecord,
	AgentSessionScheduleFault,
	type AgentSessionScheduleRecord,
	agentNodeSpecForCommandActivation,
	agentNodeSpecForScheduledActivation,
	agentSessionHeartbeatScheduleDefinitionFromSpec,
	agentSessionIncludeTools,
	pinnedAgentSessionModeRef,
	type ReserveAgentSessionInferenceBudgetInput,
	type WorkflowRuntimeStore,
} from "./workflow/runtime-store.js";
import type { AgentNodeResult } from "./workflow/types.js";
import {
	builtInModeFenceForSession,
	workspaceChatGrantTools,
	workspaceChatHostWritesGraph,
} from "./workflow/workspace-chat.js";

const tracer = trace.getTracer("sandbox-mgmt.spawner");
const GATE_LIST_TOOLS = "__list_tools";
const TERMINAL_STATES_SET = new Set(["done", "truncated", "error", "timeout", "killed"]);
const DEFAULT_BILLING_OUTBOX_LEASE_MS = 30_000;
const MATERIALIZATION_HEARTBEAT_MS = 10_000;
const MIN_BILLING_OUTBOX_WAKE_MS = 25;
const MAX_BILLING_OUTBOX_WAKE_MS = 30_000;
const DEFAULT_WARDS: WardConfig = {
	max_turns: 12,
	max_depth: 0,
	require_done_tool: true,
};

export type SandboxMode = "bwrap" | "local-native";

// ─── Types ──────────────────────────────────────────────────────────────

export interface SpawnOptions {
	template: string;
	filesystems?: string[];
	resources?: ResourceConfig;
	intent?: string;
	timeout_ms?: number;
	worker_config?: Record<string, unknown>;
	authContext?: HostedAuthContext;
	ownerUserId?: string;
	/** Reject legacy/direct graph auth; used by durable cloud supervisor work. */
	requireGatewayServiceAuth?: boolean;
	authMethod?: string;
	mnemosyne?: MnemosyneRequestOptions;
	/**
	 * The per-session `acp.authority` capability backend (CA-1 / B-keystone). When
	 * present it is registered in the capability registry under `acp.authority`, so
	 * the worker's destructive-tool `beforeToolCall` gate can round-trip
	 * `request_permission` to the session's driver. The orchestrator owns one
	 * backend per session (over the per-session `DriverPresence`) and passes it on
	 * enqueue; absent ⇒ no authority capability is registered.
	 */
	authority?: AuthorityCapabilityBackend;
	/**
	 * Trusted host-side capability bindings for this sandbox. Values stay on the
	 * host; the worker receives only gate results. The spawner owns and closes
	 * every supplied backend when the sandbox terminates.
	 */
	capabilityBackends?: ReadonlyMap<string, CapabilityBackend>;
	/** Trusted exact steward/profile grant enforced at the host gate. */
	capabilityGrantPolicy?: HostCapabilityGrantPolicyV1;
	/**
	 * Exact per-job mounts for trusted in-process stage drivers. Public HTTP
	 * request parsing never forwards this field.
	 */
	privateMounts?: readonly PrivateSandboxMount[];
	/**
	 * Trusted host-only arbitration that must succeed after sandbox-id allocation
	 * but before any worker adapter or OS process is started. Recursive Agent
	 * Sessions use this to bind an exact leased launch intent to the sandbox.
	 */
	preSpawnGate?: (info: { sandboxId: string }) => void | Promise<void>;
	/**
	 * Awaited after ChildProcess emits `spawn`, but before init or generic running
	 * testimony. Hosted children bind their durable body at this exact boundary.
	 */
	onProcessSpawn?: (info: { sandboxId: string; pid: number }) => void | Promise<void>;
}

export interface MnemosyneRequestOptions {
	apiBaseUrl?: string;
	mcpUrl?: string;
	ownerPrincipal?: string;
	graphId?: string;
	toolProfile?: MnemosyneSessionDescriptor["tool_profile"];
	runtime?: string;
	label?: string;
	requiredTools?: readonly string[];
	capabilities?: HostedSessionCapabilities;
}

interface ActiveSandbox {
	record: SandboxRecord;
	process: ChildProcess;
	cgroupPath?: string;
	timeout?: ReturnType<typeof setTimeout>;
	/** Set by killProcess/timeout to override the exit handler's terminal state */
	pendingTerminalState?: "killed" | "timeout";
	/** Saved from spawn span for cross-trace linking */
	spawnSpanContext?: SpanContext;
	/** Resolves when the async exit handler has finished cleanup */
	exitDone?: Promise<void>;
	/** Preserves retry identity when post-exit capability/cgroup cleanup fails. */
	exitCleanupError?: unknown;
	workerTerminalState?: "done" | "truncated" | "error";
	workerResultFault?: string;
	workerResult?: AgentSpawnResult | Record<string, unknown>;
	agentRequest?: AgentSpawnRequest;
	agentRunStartedAt?: number;
	toolCallStarts?: Map<string, number[]>;
	toolCallSpans?: Map<string, Span[]>;
	mockLlmState?: { requestCount: number };
	isAgentRun?: boolean;
	isRuntimeRun?: boolean;
	isKernelRun?: boolean;
	runtimeKind?: RuntimeKind;
	kernelKind?: KernelKind;
	nextRuntimeInputId?: number;
	nextKernelInputId?: number;
	nextHostCommandId?: number;
	nextHostResponseId?: number;
	nextPrimeWorkerSequence?: number;
	/**
	 * Exact first durable prompt whose result also resolves a command-first
	 * materialization. It remains pinned so replayed command results cannot enter
	 * the later resident-command checkpoint/passivation path.
	 */
	materializationResultCommandId?: string;
	/** Serializes H1 witness/result storage so worker order survives async I/O. */
	goalHandoffTail?: Promise<void>;
	/**
	 * H command IDs that can lawfully own a bare Prime goal.updated witness.
	 * The wire event deliberately has no command ID, so this host-only fence keeps
	 * it out of the legacy opaque mirror until its matching command.result settles.
	 */
	goalHandoffCommandIds?: Set<string>;
	/**
	 * The person's own words of each turn delivered with a context note (D5), by command id: the worker echoes the
	 * text it was given, and the host mirrors the echo with these words instead, so the note stays the model's.
	 */
	personTurnTexts?: Map<string, string>;
	bridgeAbortControllers?: Map<string, AbortController>;
	/**
	 * Capability registry — replaces the old single `hostedMnemosyne` field.
	 * Maps capability name → CapabilityBackend (e.g. "mnemosyne", "subject.web").
	 * handleGateCall() looks up msg.capability here; no special-casing.
	 */
	capabilityRegistry?: Map<string, CapabilityBackend>;
	/** Host-owned graph writer retained for data-only runtime projections. */
	graphProjectionProxy?: AgentSessionFamilyGraphProxy;
	/**
	 * Billing context (Phase 0 OBSERVE): the graph this sandbox's agent acts on,
	 * captured at spawn from the requested Mnemosyne descriptor. Informational —
	 * stamped onto usage events for attribution. Undefined when Mnemosyne is off.
	 */
	graphId?: string;
	/** Boundary identity used only to construct closed, content-free testimony. */
	captureIdentity: CaptureIdentity;
	turnStartedAt?: number;
	turnToolCount?: number;
	/** Host-resolved inference identity used to reject/replace sandbox model claims. */
	trustedInference?: {
		provider: string;
		model: string;
		ownerUserId?: string;
		descriptor?: AgentSpawnRequest["model_descriptor"];
		allowedModels?: ReadonlyMap<string, NonNullable<AgentSpawnRequest["model_descriptor"]>>;
	};
	/** Runtime limits pinned by the selected profile. */
	runtimeBinding?: AgentSpawnRequest["runtime_binding"];
	/** In-memory caller authority; child backends are freshly minted from it. */
	authContext?: HostedAuthContext;
	/** Recovery/closure cleanup owns durable terminal testimony for this exit. */
	durableSupervisorExit?: boolean;
	/** Exact admitted child run controlling body heartbeat ownership. */
	hostedChildRunId?: string;
	/** False until the observed OS process is durably bound as an Agent body. */
	bodyBound?: boolean;
	/** Serializes close handling behind the post-spawn durable bind decision. */
	spawnBinding?: Promise<void>;
	/** Async NDJSON handlers whose durable effects must precede exit settlement. */
	workerLineRequests?: Set<Promise<void>>;
	/** Synchronous no-new-host-work latch for cancellation/shutdown arbitration. */
	hostWorkAdmissionClosed?: boolean;
	/** Kernel-first cleanup started by an unexpected Prime worker PID exit. */
	unexpectedWorkerKernelReap?: Promise<void>;
	/** Distinguishes a natural Prime worker crash from a supervisor-owned admission latch. */
	unexpectedWorkerExit?: boolean;
	/** Host-visible side of the private Unix socket mounted into a headed Prime sandbox. */
	primeDaemonHostSocket?: string;
	primeDaemonHostDir?: string;
	/**
	 * Set when the credit gate refused a model call of the command now running. The Prime worker ends a
	 * refused turn QUIETLY and reports the command `completed`, so `handleCommandResult` reads this to
	 * settle that one command as failed (and clears it).
	 */
	creditRefusal?: { readonly message: string; readonly balanceMicroUsd: number; readonly requiredMicroUsd: number };
}

interface DurableInferenceReservation {
	readonly fundingSource: "platform" | "user";
	readonly operationId: string;
	/** The rate card the Session is pinned to, if any: the settlement and the testimony price with the same card. */
	readonly rateCard?: RateCardV1;
	readonly fence: Omit<AgentSessionInferenceFenceInput, "now">;
	readonly billingProvenance: {
		readonly userId: string;
		readonly graphId: string;
		readonly childRunId: string | null;
		readonly allocationId: string | null;
	};
}

interface ResolvedWorkerRuntime {
	runtime: string | WorkerEntrypoint;
	initMessage:
		| { kind: "init"; config: Record<string, unknown> }
		| Extract<PrimeHostCommandV1, { name: "runtime.initialize" | "runtime.restore" }>;
	keepStdinOpen: boolean;
	isAgentRun: boolean;
	isRuntimeRun: boolean;
	isKernelRun: boolean;
	runtimeKind?: RuntimeKind;
	kernelKind?: KernelKind;
	bridgeFilesystems?: string[];
	privateMounts?: readonly PrivateSandboxMount[];
	capabilityRegistry?: Map<string, CapabilityBackend>;
	graphProjectionProxy?: AgentSessionFamilyGraphProxy;
	environment?: Record<string, string>;
	agentRequest?: AgentSpawnRequest;
	primeDaemonHostSocket?: string;
	primeDaemonHostDir?: string;
}

// ─── Semaphore ──────────────────────────────────────────────────────────

class Semaphore {
	private current = 0;
	private readonly waiters: (() => void)[] = [];

	constructor(private readonly max: number) {}

	async acquire(): Promise<void> {
		if (this.current < this.max) {
			this.current++;
			return;
		}
		await new Promise<void>((resolve) => this.waiters.push(resolve));
	}

	release(): void {
		this.current--;
		const next = this.waiters.shift();
		if (next) {
			this.current++;
			next();
		}
	}

	get available(): number {
		return this.max - this.current;
	}

	get pending(): number {
		return this.waiters.length;
	}
}

// ─── Spawner ────────────────────────────────────────────────────────────

export class SandboxCleanupUnavailable extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SandboxCleanupUnavailable";
	}
}

/** A deletion receipt the store has not taken yet: its identity, its Session, and the tool call it came from. */
interface PendingDeletionReceipt {
	readonly key: string;
	readonly sessionId: string;
	readonly generation: number;
	readonly callId: string;
	readonly receipt: DeletionReceiptV1;
	/** When it was first queued (ms): an entry older than `pendingReceiptTtlMs` is dropped, not retried. */
	readonly queuedAt: number;
}

export class SandboxSpawner {
	private readonly active = new Map<string, ActiveSandbox>();
	private readonly workerScript: string;
	private readonly defaultTimeoutMs: number;
	private readonly killTermGraceMs: number;
	private readonly killForceGraceMs: number;
	private readonly exitCleanupGraceMs: number;
	private readonly spawnProcess: typeof spawn;
	private readonly semaphore: Semaphore;
	private readonly eventBus?: SandboxEventBus;
	/** Billing Phase 0 (OBSERVE) usage ledger; undefined ⇒ usage capture is off. */
	private readonly billing?: BillingStore;
	/** The credit gate's per-call door (Door B); undefined ⇒ no credit admission (legacy behaviour). */
	private readonly creditGate?: CreditAdmission;
	/** Provisional Observatory testimony; independent of OTEL and billing. */
	private readonly capture?: CaptureEmitter;
	/** Trusted host-side dynamic model facts; never exposed as a sandbox network capability. */
	private readonly modelCatalog?: ModelCatalogResolver;
	private readonly executionService: KernelExecutionService;
	private readonly agentMemory?: AgentMemory;
	private readonly workflowRuntime?: WorkflowRuntimeStore;
	/** Where a continued chat's earlier conversation is resolved from, every time its body is built. */
	private readonly chatSeeds?: ChatSeedResolver;
	private readonly childExecutionService?: AgentSessionChildExecutionService;
	private readonly schedulerService?: AgentSessionSchedulerService;
	private readonly commandActivationService?: AgentSessionCommandActivationService;
	private readonly heartbeatService?: AgentSessionHeartbeatService;
	private readonly familyProjectionPump?: AgentSessionFamilyProjectionPump;
	private readonly currentGrantReader?: CurrentGrantReader;
	private readonly agentModeReader?: AgentModeReader;
	private readonly kernelHostRequests = new Set<Promise<void>>();
	private readonly spawnTasks = new Set<Promise<void>>();
	private readonly spawnTasksBySandbox = new Map<string, Promise<void>>();
	private readonly workerLineRequests = new Set<Promise<void>>();
	/** Host-owned async work that may touch durable runtime state off request paths. */
	private readonly supervisorTasks = new Set<Promise<unknown>>();
	private billingOutboxDrain?: Promise<void>;
	private billingOutboxDrainRequested = false;
	private billingOutboxWakeTimer?: ReturnType<typeof setTimeout>;
	private billingOutboxWakeAt?: number;
	private readonly billingOutboxConsumer = `choreograph:${String(process.pid)}:${randomUUID()}`;
	private readonly billingOutboxLeaseMs: number;
	private readonly inferenceRequests = new Set<Promise<void>>();
	private shuttingDown = false;
	private readonly passivationTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly passivationTasks = new Map<string, Promise<void>>();
	private readonly unexpectedKernelCleanupRetries = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly restoredKernelLeases = new Set<string>();
	private materializationHeartbeatTimer?: ReturnType<typeof setInterval>;
	private materializationHeartbeatTask?: Promise<void>;
	/** Host-only owner API-key store, distinct from the OAuth subscription broker. */
	private readonly openRouterKeyStore?: OpenRouterKeyStore;
	private readonly openRouterUserInferenceEnabled: boolean;
	/** Focused provider-dispatch seam; production uses the host-owned egress. */
	private readonly llmProxy: typeof proxyLlmRequest;
	private readonly chatModelHealth?: Pick<ChatModelHealth, "record">;
	/** Undefined deliberately means I-authoritative nodes fail before any mutation. */
	private readonly contentAuthorityAdmission?: ContentAuthorityAdmissionPort;

	constructor(
		private readonly store: SandboxStore,
		private readonly cgroup: CgroupHierarchy,
		options?: {
			workerScript?: string;
			defaultTimeoutMs?: number;
			maxConcurrentSpawns?: number;
			eventBus?: SandboxEventBus;
			billing?: BillingStore;
			/** Door B of the credit gate (Sobremesa): clamps each model call's reservation to the balance. */
			creditGate?: CreditAdmission;
			capture?: CaptureEmitter;
			modelCatalog?: ModelCatalogResolver;
			extensionArtifactResolver?: Pick<PrimeExtensionBuilder, "resolveArtifact">;
			openRouterKeyStore?: OpenRouterKeyStore;
			openRouterUserInferenceEnabled?: boolean;
			sandboxMode?: SandboxMode;
			/** local-native only: run bodies under this identity (default: read from the environment). */
			localNativeBody?: LocalNativeBodyIdentity | null;
			agentMemory?: AgentMemory;
			workflowRuntime?: WorkflowRuntimeStore;
			/** The seed store a continued chat resolves from; defaults to `workflowRuntime`, which holds it. */
			chatSeeds?: ChatSeedResolver;
			/** Focused recovery-test seam; production uses a 30-second durable claim. */
			billingOutboxLeaseMs?: number;
			/** Focused injection seam for kernel-dispatch tests. */
			childExecutionService?: AgentSessionChildExecutionService;
			/** Focused injection seam for durable scheduler lifecycle proofs. */
			schedulerService?: AgentSessionSchedulerService;
			/** Focused injection seam for durable passivated-command activation proofs. */
			commandActivationService?: AgentSessionCommandActivationService;
			/** Focused injection seam for the durable family projector. */
			familyProjectionPump?: AgentSessionFamilyProjectionPump;
			/** Exact current-grant reader for external-capability scheduled activation. */
			currentGrantReader?: CurrentGrantReader;
			/** Mode reader for re-activations of mode-bound Sessions (Choreograph modes v1). */
			agentModeReader?: AgentModeReader;
			/** Focused physical-reap proof seams; production keeps conservative bounds. */
			killTermGraceMs?: number;
			killForceGraceMs?: number;
			exitCleanupGraceMs?: number;
			/** Focused OS-launch failure seam; production always uses node:child_process spawn. */
			spawnProcess?: typeof spawn;
			/** Focused inference-host seam; production always uses provider-keyed egress. */
			llmProxy?: typeof proxyLlmRequest;
			/** Where the house's refused calls are recorded, so a voice that fails for everyone is hidden. */
			chatModelHealth?: Pick<ChatModelHealth, "record">;
			/** Explicit host-owned immutable CAS + physical mount ports for I authority. */
			contentAuthority?: ContentAuthorityAdmissionPortInput;
		},
	) {
		this.workerScript = options?.workerScript ?? resolve(fileURLToPath(new URL("./worker.mjs", import.meta.url)));
		this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 60_000;
		this.killTermGraceMs = options?.killTermGraceMs ?? 5_000;
		this.killForceGraceMs = options?.killForceGraceMs ?? 5_000;
		this.exitCleanupGraceMs = options?.exitCleanupGraceMs ?? 10_000;
		this.spawnProcess = options?.spawnProcess ?? spawn;
		this.llmProxy = options?.llmProxy ?? proxyLlmRequest;
		this.chatModelHealth = options?.chatModelHealth;
		this.contentAuthorityAdmission = options?.contentAuthority
			? createContentAuthorityAdmissionPort(options.contentAuthority)
			: undefined;
		this.semaphore = new Semaphore(options?.maxConcurrentSpawns ?? 8);
		this.eventBus = options?.eventBus;
		this.billing = options?.billing;
		this.creditGate = options?.creditGate;
		this.capture = options?.capture;
		this.modelCatalog = options?.modelCatalog;
		this.agentMemory = options?.agentMemory;
		this.workflowRuntime = options?.workflowRuntime;
		this.chatSeeds = options?.chatSeeds ?? options?.workflowRuntime;
		this.currentGrantReader = options?.currentGrantReader ?? HostedCurrentGrantReader.fromEnvironment();
		this.agentModeReader = options?.agentModeReader ?? HostedAgentModeReader.fromEnvironment();
		this.heartbeatService = this.workflowRuntime
			? new AgentSessionHeartbeatService({ port: this.createAgentSessionHeartbeatPort(this.workflowRuntime) })
			: undefined;
		this.billingOutboxLeaseMs = positiveModelInteger(options?.billingOutboxLeaseMs, DEFAULT_BILLING_OUTBOX_LEASE_MS);
		this.extensionArtifactResolver = options?.extensionArtifactResolver;
		this.openRouterKeyStore = options?.openRouterKeyStore;
		this.openRouterUserInferenceEnabled = options?.openRouterUserInferenceEnabled === true;
		this.sandboxMode = options?.sandboxMode ?? "bwrap";
		this.localNativeBody =
			this.sandboxMode === "local-native"
				? options?.localNativeBody === undefined
					? resolveLocalNativeBodyIdentity(process.env)
					: (options.localNativeBody ?? undefined)
				: undefined;
		this.executionService = new KernelExecutionService({
			spawnKernel: async ({ ownerUserId, timeoutMs, sessionId, generation, activationId, signal }) => {
				let bodyObserved = false;
				const record = await this.spawn({
					template: "bare",
					timeout_ms: timeoutMs,
					ownerUserId,
					authMethod: "execution-service",
					worker_config: { mode: "kernel", kernel: "python3" },
					preSpawnGate: async ({ sandboxId }) => {
						if (signal.aborted) throw signal.reason;
						if (!this.workflowRuntime) throw new Error("Kernel launch requires the workflow runtime");
						await this.workflowRuntime.beginAgentSessionKernelLaunch(sessionId, generation, {
							activationId,
							sandboxId,
							now: Date.now(),
						});
						if (signal.aborted) throw signal.reason;
					},
					onProcessSpawn: async ({ sandboxId }) => {
						if (signal.aborted) throw signal.reason;
						if (!this.workflowRuntime) throw new Error("Kernel launch requires the workflow runtime");
						await this.workflowRuntime.bindAgentSessionKernelLaunch(sessionId, generation, {
							activationId,
							sandboxId,
							now: Date.now(),
						});
						bodyObserved = true;
						if (signal.aborted) throw signal.reason;
					},
				});
				if (record.state !== "running") {
					if (!bodyObserved) {
						await this.workflowRuntime?.failUnboundAgentSessionKernelLaunch(sessionId, generation, {
							activationId,
							sandboxId: record.sandbox_id,
							now: Date.now(),
						});
					}
					if (bodyObserved) {
						try {
							await this.killProcess(record.sandbox_id, "killed");
						} catch (cleanupError) {
							throw new KernelSpawnFailure("Kernel wrapper exited before readiness and remains cleanup-owned", {
								bodyObserved: true,
								sandboxId: record.sandbox_id,
								reaped: false,
								cause: cleanupError,
							});
						}
					}
					throw new KernelSpawnFailure(`Kernel sandbox failed to start (state: ${record.state})`, {
						bodyObserved,
						...(bodyObserved ? { sandboxId: record.sandbox_id } : {}),
						reaped: true,
					});
				}
				try {
					await this.waitForKernelReady(record.sandbox_id, 90_000, signal);
				} catch (error) {
					try {
						await this.killProcess(record.sandbox_id, "killed");
					} catch (cleanupError) {
						throw new KernelSpawnFailure("Kernel wrapper failed before readiness and remains cleanup-owned", {
							bodyObserved: true,
							sandboxId: record.sandbox_id,
							reaped: false,
							cause: new AggregateError([error, cleanupError]),
						});
					}
					throw new KernelSpawnFailure("Kernel wrapper failed before readiness", {
						bodyObserved: true,
						sandboxId: record.sandbox_id,
						reaped: true,
						cause: error,
					});
				}
				return { sandboxId: record.sandbox_id };
			},
			subscribeKernel: (sandboxId, observer) => {
				if (!this.eventBus) throw new Error("Kernel execution service requires the sandbox event bus");
				return this.eventBus.subscribe(observer, { sandbox_id: sandboxId });
			},
			executeKernel: (sandboxId, code) => this.sendKernelExecute(sandboxId, code),
			interruptKernel: (sandboxId) => {
				this.interruptKernel(sandboxId);
			},
			killKernel: async (sandboxId) => {
				// Idempotent verified reap: a retry after monitorExit completed accepts
				// the terminal Sandbox instead of treating it as a fresh public kill.
				await this.killProcess(sandboxId, "killed");
			},
			emitCell: async (agentSandboxId, cell) => {
				if (this.workflowRuntime) {
					const lease = this.executionService.getLease(cell.leaseId);
					if (!lease || lease.sessionId !== cell.sessionId) {
						throw new Error(`Execution cell ${cell.cellRef} lost its kernel activation fence`);
					}
					await this.workflowRuntime.appendExecutionCell(cell.sessionId, lease.activationId, cell);
				}
				const active = this.active.get(agentSandboxId);
				if (this.workflowRuntime && active?.graphProjectionProxy) {
					try {
						const session = await this.workflowRuntime.readAgentSession(cell.sessionId);
						if (!session) throw new Error(`Agent session not found: ${cell.sessionId}`);
						await projectExecutionCellToNotebook(active.graphProjectionProxy, {
							graphId: session.graph_id,
							sessionId: cell.sessionId,
							cell,
							layoutAuthoredAt: session.created_at,
							attachToGardenCenter: process.env.SOPHIA_NOTEBOOK_ATTACH_CENTER === "1",
						});
					} catch (error) {
						// The execution journal is authoritative. A display projection outage
						// is visible, but cannot rewrite a successful kernel result.
						console.error(
							`[workflow] notebook projection failed for ${cell.sessionId}/${cell.cellRef}: ${
								error instanceof Error ? error.message : String(error)
							}`,
						);
					}
				}
				this.emitBusEvent({
					category: "execution",
					type: "compute.cell",
					sandbox_id: agentSandboxId,
					ts: new Date(cell.completedAt).toISOString(),
					cell,
				});
			},
			recordKernelState: async ({ sessionId, generation, activationId, state, now }) => {
				await this.workflowRuntime?.recordAgentSessionKernelState(sessionId, generation, {
					activationId,
					state,
					now,
				});
			},
			handleUnexpectedKernelExit: (input) => this.handleUnexpectedKernelExit(input),
		});
		this.familyProjectionPump =
			options?.familyProjectionPump ??
			(this.workflowRuntime
				? new AgentSessionFamilyProjectionPump({
						store: this.workflowRuntime,
						consumer: `choreograph-family:${process.pid}:${randomUUID()}`,
						proxyFactory: (authority) => this.createFamilyProjectionGraphLease(authority),
						// A Reader workspace chat may belong to someone who can only view the graph: the host never writes
						// its family into the graph as them (exam 1, finding 2).
						projects: (root) => workspaceChatHostWritesGraph(root),
					})
				: undefined);
		this.childExecutionService =
			options?.childExecutionService ??
			(this.workflowRuntime && this.agentMemory && this.eventBus
				? new AgentSessionChildExecutionService({
						runtime: this.workflowRuntime,
						execute: (input) => this.executeAgentSessionChild(input),
						cleanup: (input) => this.cleanupAgentSessionChild(input),
						onDurableChange: () => this.familyProjectionPump?.wake(),
					})
				: undefined);
		this.schedulerService =
			options?.schedulerService ??
			(this.workflowRuntime && this.agentMemory && this.eventBus
				? new AgentSessionSchedulerService({
						store: this.workflowRuntime,
						consumer: `choreograph-scheduler:${process.pid}:${randomUUID()}`,
						activate: (input) => this.activateAgentSessionSchedule(input),
					})
				: undefined);
		this.commandActivationService =
			options?.commandActivationService ??
			(this.workflowRuntime && this.agentMemory && this.eventBus
				? new AgentSessionCommandActivationService({
						store: this.workflowRuntime,
						consumer: `choreograph-command-activation:${process.pid}:${randomUUID()}`,
						activate: (input) => this.activateAgentSessionCommand(input),
					})
				: undefined);
		this.scheduleInferenceBillingOutboxDrain();
	}

	/** Runtime composition uses this one host-constructed port for normal and recovered paths. */
	contentAuthorityAdmissionPort(): ContentAuthorityAdmissionPort | undefined {
		return this.contentAuthorityAdmission;
	}

	private createAgentSessionHeartbeatPort(runtime: WorkflowRuntimeStore): AgentSessionHeartbeatPort {
		const wake = (): void => this.wakeDurableSupervision();
		const record = async (schedule: AgentSessionScheduleRecord) => {
			const fires = await runtime.listAgentSessionScheduleFires(schedule.session_id, schedule.schedule_id);
			const terminalFires = fires.filter((fire) => fire.completed_at !== null);
			const latest = terminalFires.at(-1);
			return {
				id: schedule.schedule_id,
				revision: schedule.revision,
				status: schedule.state,
				label: schedule.label,
				delivery_mode: schedule.delivery_mode,
				instruction: schedule.prompt.text,
				schedule:
					schedule.definition.kind === "interval"
						? renderHeartbeatInterval(schedule.definition.intervalMs)
						: schedule.definition.kind === "cron"
							? schedule.definition.expression
							: new Date(schedule.definition.fireAt).toISOString(),
				created_at: new Date(schedule.created_at).toISOString(),
				updated_at: new Date(schedule.updated_at).toISOString(),
				next_run_at:
					schedule.state === "active" && schedule.next_fire_at !== null
						? new Date(schedule.next_fire_at).toISOString()
						: null,
				last_run_at:
					latest?.completed_at === null || latest?.completed_at === undefined
						? null
						: new Date(latest.completed_at).toISOString(),
				last_error: latest?.last_error ?? null,
				run_count: terminalFires.length,
			};
		};
		return {
			async list(input: { includeInactive: boolean; sessionId: string }): Promise<unknown> {
				const schedules = await runtime.listAgentSessionSchedules(input.sessionId);
				return {
					heartbeats: await Promise.all(
						schedules
							.filter(
								(item) =>
									item.source === "rlm_heartbeat" &&
									item.definition.kind !== "once" &&
									item.state !== "completed" &&
									(input.includeInactive || item.state === "active"),
							)
							.map(record),
					),
				};
			},
			async create(input: Parameters<AgentSessionHeartbeatPort["create"]>[0]): Promise<unknown> {
				const result = await runtime.createAgentSessionSchedule(input.sessionId, {
					requestId: input.requestId,
					scheduleId: `rlm-heartbeat:${input.requestId}`,
					definition: agentSessionHeartbeatScheduleDefinitionFromSpec(input.schedule, input.now),
					prompt: input.input,
					clientId: input.clientId,
					now: input.now,
					options: input.options,
				});
				if (result.created) wake();
				return { heartbeat: await record(result.schedule) };
			},
			async control(input: Parameters<AgentSessionHeartbeatPort["control"]>[0]): Promise<unknown> {
				const result = await runtime.controlAgentSessionSchedule(input.sessionId, {
					...input.control,
					clientId: input.clientId,
					now: input.now,
				});
				if (result.applied) wake();
				return { heartbeat: await record(result.schedule) };
			},
			async cancel(input: Parameters<AgentSessionHeartbeatPort["cancel"]>[0]): Promise<unknown> {
				const result = await runtime.cancelAgentSessionSchedule(input.sessionId, input.scheduleId, {
					requestId: input.requestId,
					clientId: input.clientId,
					now: input.now,
				});
				if (result.applied) wake();
				return { heartbeat: await record(result.schedule) };
			},
		} as AgentSessionHeartbeatPort;
	}

	private readonly sandboxMode: SandboxMode;
	private readonly localNativeBody: LocalNativeBodyIdentity | undefined;
	private readonly extensionArtifactResolver?: Pick<PrimeExtensionBuilder, "resolveArtifact">;

	get bus(): SandboxEventBus | undefined {
		return this.eventBus;
	}

	wakeDurableSupervision(): void {
		this.childExecutionService?.wake();
		this.schedulerService?.wake();
		this.commandActivationService?.wake();
		this.familyProjectionPump?.wake();
	}

	/** Recover durable host work before any public listener begins serving. */
	async start(): Promise<void> {
		if (this.shuttingDown) throw new Error("Cannot start a shutting-down sandbox spawner");
		await this.heartbeatLiveAgentMaterializations();
		// Generic materialization recovery must converge before a schedule can
		// reclaim the exact fire-owned activation on process restart.
		await this.childExecutionService?.start();
		await this.schedulerService?.start();
		await this.commandActivationService?.start();
		await this.familyProjectionPump?.start();
		this.materializationHeartbeatTimer = setInterval(() => {
			this.startMaterializationHeartbeat();
		}, MATERIALIZATION_HEARTBEAT_MS);
		this.materializationHeartbeatTimer.unref?.();
	}

	private trackSupervisorTask<T>(task: Promise<T>): Promise<T> {
		let tracked!: Promise<T>;
		tracked = task.finally(() => this.supervisorTasks.delete(tracked));
		this.supervisorTasks.add(tracked);
		return tracked;
	}

	private startMaterializationHeartbeat(): void {
		if (this.shuttingDown || this.materializationHeartbeatTask) return;
		let running!: Promise<void>;
		running = this.trackSupervisorTask(
			this.heartbeatLiveAgentMaterializations()
				.catch((error) => {
					console.error(`[supervisor] materialization heartbeat failed: ${boundedInferenceFailure(error)}`);
				})
				.finally(() => {
					if (this.materializationHeartbeatTask === running) this.materializationHeartbeatTask = undefined;
				}),
		);
		this.materializationHeartbeatTask = running;
	}

	private async heartbeatLiveAgentMaterializations(): Promise<void> {
		if (!this.workflowRuntime || this.shuttingDown) return;
		const live = [...this.active.values()].filter(
			(active): active is ActiveSandbox & { agentRequest: AgentSpawnRequest } =>
				Boolean(active.bodyBound !== false && active.isAgentRun && active.agentRequest),
		);
		await Promise.allSettled(
			live.map(async (active) => {
				const request = active.agentRequest;
				if (active.hostedChildRunId) {
					const childRun = await this.workflowRuntime!.readAgentSessionChildRun(active.hostedChildRunId);
					if (!childRun || !["completed", "failed", "cancelled"].includes(childRun.state)) {
						// The serialized child-service loop is the sole body heartbeat
						// writer until exact logical settlement commits.
						return;
					}
					// Resident Prime ownership transfers only after the child service
					// has paused/drained its heartbeat before terminal run settlement.
					if (this.active.get(active.record.sandbox_id) !== active || active.hostWorkAdmissionClosed) {
						return;
					}
					active.durableSupervisorExit = false;
				}
				const materialization = await this.workflowRuntime!.readAgentMaterialization(
					request.session_id,
					request.generation,
				);
				if (
					!materialization ||
					materialization.sandbox_id !== active.record.sandbox_id ||
					!["claimed", "running", "quiescing", "quiescent"].includes(materialization.state)
				) {
					return;
				}
				await this.workflowRuntime!.heartbeatAgentMaterialization(request.session_id, request.generation, {
					activationId: materialization.activation_id,
					now: Date.now(),
				});
			}),
		);
	}

	private emitBusEvent(event: BusEvent): void {
		this.eventBus?.emit(event);
	}

	private scheduleInferenceBillingOutboxDrain(): void {
		if (!this.workflowRuntime || !this.billing || this.shuttingDown) return;
		this.clearInferenceBillingOutboxWake();
		this.billingOutboxDrainRequested = true;
		if (this.billingOutboxDrain) return;
		const draining = (async () => {
			while (true) {
				this.billingOutboxDrainRequested = false;
				try {
					await this.drainInferenceBillingOutbox();
				} catch (error) {
					console.error(`[billing] inference outbox drain paused: ${boundedInferenceFailure(error)}`);
				}
				if (this.billingOutboxDrainRequested) continue;
				await this.armInferenceBillingOutboxWake();
				if (this.billingOutboxDrainRequested) {
					this.clearInferenceBillingOutboxWake();
					continue;
				}
				break;
			}
		})()
			.catch((error) => {
				console.error(`[billing] inference outbox wake planning failed: ${boundedInferenceFailure(error)}`);
				this.armInferenceBillingOutboxWakeAfter(MIN_BILLING_OUTBOX_WAKE_MS);
			})
			.finally(() => {
				if (this.billingOutboxDrain === draining) this.billingOutboxDrain = undefined;
			});
		this.billingOutboxDrain = draining;
	}

	private async armInferenceBillingOutboxWake(): Promise<void> {
		if (!this.workflowRuntime || !this.billing || this.shuttingDown) return;
		const now = Date.now();
		const nextAvailableAt = await this.workflowRuntime.readAgentSessionInferenceBillingOutboxNextAvailableAt(now);
		if (nextAvailableAt === null) {
			this.clearInferenceBillingOutboxWake();
			return;
		}
		const delayMs = Math.max(MIN_BILLING_OUTBOX_WAKE_MS, Math.min(MAX_BILLING_OUTBOX_WAKE_MS, nextAvailableAt - now));
		this.armInferenceBillingOutboxWakeAfter(delayMs);
	}

	private armInferenceBillingOutboxWakeAfter(delayMs: number): void {
		if (!this.workflowRuntime || !this.billing || this.shuttingDown) return;
		const wakeAt = Date.now() + delayMs;
		if (this.billingOutboxWakeTimer && this.billingOutboxWakeAt !== undefined && this.billingOutboxWakeAt <= wakeAt) {
			return;
		}
		this.clearInferenceBillingOutboxWake();
		this.billingOutboxWakeAt = wakeAt;
		this.billingOutboxWakeTimer = setTimeout(() => {
			this.billingOutboxWakeTimer = undefined;
			this.billingOutboxWakeAt = undefined;
			this.scheduleInferenceBillingOutboxDrain();
		}, delayMs);
		this.billingOutboxWakeTimer.unref?.();
	}

	private clearInferenceBillingOutboxWake(): void {
		if (this.billingOutboxWakeTimer) clearTimeout(this.billingOutboxWakeTimer);
		this.billingOutboxWakeTimer = undefined;
		this.billingOutboxWakeAt = undefined;
	}

	private async drainInferenceBillingOutbox(): Promise<void> {
		if (!this.workflowRuntime || !this.billing) return;
		while (true) {
			const claimed = await this.workflowRuntime.claimAgentSessionInferenceBillingOutbox({
				consumer: this.billingOutboxConsumer,
				leaseMs: this.billingOutboxLeaseMs,
				now: Date.now(),
			});
			if (!claimed) return;
			if (!claimed.claim_token) throw new Error(`Billing outbox claim ${claimed.operation_id} has no token`);
			const inserted = await this.billing.recordUsageAndDebit(claimed.payload);
			if (!inserted) {
				const existing = await this.billing.getEvent(claimed.payload.eventId);
				if (!existing || !sameBillingUsageEvent(claimed.payload, existing)) {
					throw new Error(`Billing sink conflict for inference operation ${claimed.operation_id}`);
				}
			}
			// The debit is delivered: the credit hold that covered this call's worst case is released HERE, not
			// when the call ended (that would reopen the window between "ended" and "landed").
			this.creditGate?.releaseHold(claimed.operation_id);
			await this.workflowRuntime.completeAgentSessionInferenceBillingOutbox({
				operationId: claimed.operation_id,
				consumer: this.billingOutboxConsumer,
				claimToken: claimed.claim_token,
				now: Date.now(),
			});
		}
	}

	private wakeAgentSessionFamilyProjection(): Promise<void> {
		this.familyProjectionPump?.wake();
		return Promise.resolve();
	}

	/** Refresh a family from a currently materialized body without coupling callers to graph transport. */
	async refreshAgentSessionFamily(sessionId: string, sandboxId: string): Promise<void> {
		void sessionId;
		void sandboxId;
		await this.wakeAgentSessionFamilyProjection();
	}

	/** Resolve the bind-before-spawn race once the active body owns its graph writer. */
	private activateAgentSessionFamilyProjection(sandboxId: string): Promise<void> {
		void sandboxId;
		return this.wakeAgentSessionFamilyProjection();
	}

	/**
	 * Accept a spawn request immediately. Creates the SQLite record in
	 * "queued" state and begins background execution gated by the
	 * concurrency semaphore.
	 *
	 * Returns the queued record without waiting for the sandbox to start.
	 */
	enqueue(opts: SpawnOptions): SandboxRecord {
		if (this.shuttingDown) throw new Error("Sandbox admission is closed during shutdown");
		// Admission is synchronous and precedes the queued record. Agent requests
		// therefore cannot return a false 202 and fail later because their semantic
		// authority or executable artifact pin was absent/drifted.
		if (isAgentWorkerConfig(opts.worker_config)) {
			admitAgentExecution(opts.worker_config, this.sandboxMode);
		}
		const record = this.store.create(opts.template, opts.resources, opts.intent, {
			ownerUserId: opts.ownerUserId,
			authMethod: opts.authMethod,
			filesystems: resolveTemplateFilesystemIds(opts.template, opts.filesystems),
		});
		spawnQueueDepth.add(1, { template: opts.template });
		this.emitBusEvent({
			category: "lifecycle",
			type: "queued",
			sandbox_id: record.sandbox_id,
			ts: record.queued_at,
			record,
		});

		// Background admission is explicitly tracked so shutdown can latch, await,
		// and then take a stable active-body snapshot.
		let spawnTask!: Promise<void>;
		spawnTask = this.executeSpawn(record.sandbox_id, opts)
			.catch((err) => {
				console.error(`[spawner] sandbox ${record.sandbox_id}: background spawn failed (${safeErrorKind(err)})`);
			})
			.finally(() => {
				this.spawnTasks.delete(spawnTask);
				if (this.spawnTasksBySandbox.get(record.sandbox_id) === spawnTask) {
					this.spawnTasksBySandbox.delete(record.sandbox_id);
				}
			});
		this.spawnTasks.add(spawnTask);
		this.spawnTasksBySandbox.set(record.sandbox_id, spawnTask);

		return record;
	}

	/**
	 * Enqueue a spawn and wait for it to reach "running" (or terminal)
	 * state. Used by tests and by code that needs a running sandbox.
	 */
	async spawn(opts: SpawnOptions): Promise<SandboxRecord> {
		const record = this.enqueue(opts);
		const observed = await this.waitForRunningOrTerminal(record.sandbox_id);
		if (observed.state === "running") return observed;
		// A terminal SandboxStore transition precedes capability/cgroup cleanup and
		// active-map removal. Callers that arbitrate durable body absence (notably
		// kernel failed_unbound) need the tracked spawn continuation's verified reap,
		// not merely the early generic terminal record.
		await this.awaitSpawnAttempt(record.sandbox_id);
		return this.store.get(record.sandbox_id) ?? observed;
	}

	/** Await verified cleanup for the one launch continuation behind a queued record. */
	async awaitSpawnAttempt(sandboxId: string): Promise<void> {
		await this.spawnTasksBySandbox.get(sandboxId);
		while (true) {
			const record = this.store.get(sandboxId);
			if (!record || !TERMINAL_STATES_SET.has(record.state) || !this.active.has(sandboxId)) return;
			try {
				await this.killProcess(sandboxId, "killed");
			} catch (error) {
				console.error(
					`[spawner] launch cleanup retry remains pending for ${sandboxId}: ${boundedInferenceFailure(error)}`,
				);
			}
			if (!this.active.has(sandboxId)) return;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}

	async kill(sandboxId: string): Promise<SandboxRecord> {
		const active = this.active.get(sandboxId);
		if (!active) {
			const record = this.store.get(sandboxId);
			if (!record) throw new Error(`Sandbox not found: ${sandboxId}`);
			if (record.state !== "running") {
				throw new Error(`Sandbox ${sandboxId} is not running (state: ${record.state})`);
			}
			throw new Error(`Sandbox ${sandboxId} has no active process`);
		}

		return this.killProcess(sandboxId, "killed");
	}

	sendRuntimeInput(sandboxId: string, code: string): { sandbox: SandboxRecord; inputId: string } {
		const active = this.getActiveRuntime(sandboxId);
		const inputId = `input-${active.nextRuntimeInputId ?? 0}`;
		active.nextRuntimeInputId = (active.nextRuntimeInputId ?? 0) + 1;
		this.writeWorkerMessage(active.process, {
			kind: "runtime_input",
			input_id: inputId,
			code,
		});
		return {
			sandbox: active.record,
			inputId,
		};
	}

	async drainAgentSessionCommands(sandboxId: string): Promise<AgentSessionCommandRecord[]> {
		if (!this.workflowRuntime) throw new Error("Agent command runtime is not configured");
		const active = this.getActiveAgent(sandboxId);
		if (this.shuttingDown || active.hostWorkAdmissionClosed) return [];
		const request = active.agentRequest;
		if (!request) throw new Error(`Sandbox ${sandboxId} has no admitted Prime request`);
		const commands = await this.workflowRuntime.claimAgentSessionCommandsForDelivery(
			request.session_id,
			request.generation,
			Date.now(),
		);
		if (this.shuttingDown || active.hostWorkAdmissionClosed) {
			await Promise.allSettled(
				commands.map((command) =>
					this.workflowRuntime!.releaseAgentSessionCommandDelivery(command.command_id, request.generation),
				),
			);
			return [];
		}
		return this.deliverAgentSessionCommands(active, commands);
	}

	/** Deliver only the immutable command owned by one scheduler fire. */
	async drainExactAgentSessionCommand(
		sandboxId: string,
		commandId: string,
	): Promise<AgentSessionCommandRecord | null> {
		if (!this.workflowRuntime) throw new Error("Agent command runtime is not configured");
		const active = this.getActiveAgent(sandboxId);
		if (this.shuttingDown || active.hostWorkAdmissionClosed) return null;
		const request = active.agentRequest;
		if (!request) throw new Error(`Sandbox ${sandboxId} has no admitted Prime request`);
		const command = await this.workflowRuntime.claimExactAgentSessionCommandForDelivery(
			request.session_id,
			request.generation,
			commandId,
			Date.now(),
		);
		if (!command) return null;
		if (this.shuttingDown || active.hostWorkAdmissionClosed) {
			await this.workflowRuntime.releaseAgentSessionCommandDelivery(command.command_id, request.generation);
			return null;
		}
		await this.deliverAgentSessionCommands(active, [command]);
		return command;
	}

	private async drainShutdownQuiesceCommand(
		sandboxId: string,
		commandId: string,
	): Promise<AgentSessionCommandRecord[]> {
		if (!this.workflowRuntime) throw new Error("Agent command runtime is not configured");
		const active = this.getActiveAgent(sandboxId);
		if (!this.shuttingDown || active.hostWorkAdmissionClosed) return [];
		const request = active.agentRequest;
		if (!request) throw new Error(`Sandbox ${sandboxId} has no admitted Prime request`);
		const command = await this.workflowRuntime.claimExactAgentSessionCommandForDelivery(
			request.session_id,
			request.generation,
			commandId,
			Date.now(),
		);
		if (!command) return [];
		if (command.name !== "quiesce" || command.command_id !== commandId) {
			await this.workflowRuntime.releaseAgentSessionCommandDelivery(command.command_id, request.generation);
			throw new Error("Shutdown command delivery is restricted to the exact quiesce command");
		}
		if (active.hostWorkAdmissionClosed) {
			await this.workflowRuntime.releaseAgentSessionCommandDelivery(command.command_id, request.generation);
			return [];
		}
		return this.deliverAgentSessionCommands(active, [command]);
	}

	private async deliverAgentSessionCommands(
		active: ActiveSandbox,
		commands: AgentSessionCommandRecord[],
	): Promise<AgentSessionCommandRecord[]> {
		if (!this.workflowRuntime) throw new Error("Agent command runtime is not configured");
		const request = active.agentRequest;
		if (!request) throw new Error(`Sandbox ${active.record.sandbox_id} has no admitted Prime request`);
		if (commands.some((command) => command.name !== "quiesce")) {
			const timer = this.passivationTimers.get(request.session_id);
			if (timer) clearTimeout(timer);
			this.passivationTimers.delete(request.session_id);
		}
		for (const command of commands) {
			try {
				// What the person has open is named to the model only once the session's own graph backend (its mode, as
				// the person) has answered it (exam 1); a ref it cannot read, or no backend at all, names nothing.
				const admittedContextRefs = await this.admitCommandContextRefs(active, command);
				this.sendDurableAgentCommand(active, command, admittedContextRefs);
			} catch (error) {
				await this.workflowRuntime.releaseAgentSessionCommandDelivery(command.command_id, request.generation);
				throw error;
			}
		}
		return commands;
	}

	private async admitCommandContextRefs(
		active: ActiveSandbox,
		command: AgentSessionCommandRecord,
	): Promise<readonly string[]> {
		const payload = command.payload as Record<string, unknown> | null;
		if (
			(command.name !== "prompt" && command.name !== "follow_up") ||
			!payload ||
			!Array.isArray(payload.contextRefs)
		) {
			return [];
		}
		const backend = active.capabilityRegistry?.get("mnemosyne");
		const refs = payload.contextRefs.filter((ref): ref is string => typeof ref === "string");
		return admitTurnContextRefs(refs, backend ? (tool, args) => backend.callTool(tool, args) : undefined);
	}

	private sendDurableAgentCommand(
		active: ActiveSandbox,
		command: AgentSessionCommandRecord,
		admittedContextRefs: readonly string[] = [],
	): void {
		const request = active.agentRequest;
		if (!request) throw new Error(`Sandbox ${active.record.sandbox_id} has no admitted Prime request`);
		if (command.session_id !== request.session_id || command.delivery_generation !== request.generation) {
			throw new Error("Durable command does not belong to the active materialization");
		}
		const commandSequence = active.nextHostCommandId ?? 0;
		active.nextHostCommandId = commandSequence + 1;
		const messageId = `host.command:${active.record.sandbox_id}:${request.generation}:${commandSequence}`;
		if (
			request.await_initial_command === true &&
			(command.name === "prompt" ||
				command.name === "follow_up" ||
				command.name === "steer" ||
				isPrimeGoalCommandName(command.name)) &&
			active.materializationResultCommandId === undefined
		) {
			active.materializationResultCommandId = command.command_id;
		}
		if (isPrimeGoalCommandName(command.name)) {
			let commandIds = active.goalHandoffCommandIds;
			if (!commandIds) {
				commandIds = new Set();
				active.goalHandoffCommandIds = commandIds;
			}
			commandIds.add(command.command_id);
		}
		this.writeWorkerMessage(active.process, {
			protocol: PRIME_HOST_PROTOCOL_VERSION,
			messageId,
			sessionId: request.session_id,
			sandboxId: active.record.sandbox_id,
			generation: request.generation,
			correlationId: command.command_id,
			causationId: `${request.generation === 0 ? "runtime.initialize" : "runtime.restore"}:${active.record.sandbox_id}:${request.generation}`,
			commandId: command.command_id,
			direction: "host_to_worker",
			kind: "command",
			name: bridgeCommandName(command.name),
			payload: workerCommandPayload(active, command, admittedContextRefs),
		} as PrimeHostCommandV1);
	}

	closeHeadedAgent(sandboxId: string): SandboxRecord {
		const active = this.getActiveAgent(sandboxId);
		if (active.agentRequest?.interaction_mode !== "headed") {
			throw new Error(`Sandbox ${sandboxId} is not a headed Prime session`);
		}
		this.writeWorkerMessage(active.process, { kind: "headed_close" });
		return active.record;
	}

	attachHeadedAgent(sandboxId: string): SandboxRecord {
		const active = this.getActiveAgent(sandboxId);
		if (active.agentRequest?.interaction_mode !== "headed") {
			throw new Error(`Sandbox ${sandboxId} is not a headed Prime session`);
		}
		this.writeWorkerMessage(active.process, { kind: "headed_attach" });
		return active.record;
	}

	connectPrimeDaemon(sandboxId: string): Socket {
		const active = this.getActiveAgent(sandboxId);
		if (active.agentRequest?.interaction_mode !== "headed" || !active.primeDaemonHostSocket) {
			throw new Error(`Sandbox ${sandboxId} has no headed Prime daemon`);
		}
		return createConnection(active.primeDaemonHostSocket);
	}

	closeRuntime(sandboxId: string): SandboxRecord {
		const active = this.getActiveRuntime(sandboxId);
		this.writeWorkerMessage(active.process, { kind: "runtime_close" });
		return active.record;
	}

	private getActiveKernel(sandboxId: string): ActiveSandbox {
		const active = this.active.get(sandboxId);
		if (!active) {
			const record = this.store.get(sandboxId);
			if (!record) {
				throw new Error(`Sandbox not found: ${sandboxId}`);
			}
			throw new Error(`Sandbox ${sandboxId} is not active (state: ${record.state})`);
		}
		if (!active.isKernelRun) {
			throw new Error(`Sandbox ${sandboxId} is not a kernel session`);
		}
		if (active.record.state !== "running") {
			throw new Error(`Sandbox ${sandboxId} is not running (state: ${active.record.state})`);
		}
		return active;
	}

	private getActiveAgent(sandboxId: string): ActiveSandbox {
		const active = this.active.get(sandboxId);
		if (!active) {
			const record = this.store.get(sandboxId);
			if (!record) {
				throw new Error(`Sandbox not found: ${sandboxId}`);
			}
			throw new Error(`Sandbox ${sandboxId} is not active (state: ${record.state})`);
		}
		if (!active.isAgentRun) {
			throw new Error(`Sandbox ${sandboxId} is not an agent session`);
		}
		if (active.record.state !== "running") {
			throw new Error(`Sandbox ${sandboxId} is not running (state: ${active.record.state})`);
		}
		return active;
	}

	sendKernelExecute(sandboxId: string, code: string): { sandbox: SandboxRecord; inputId: string } {
		const active = this.getActiveKernel(sandboxId);
		const inputId = `input-${active.nextKernelInputId ?? 0}`;
		active.nextKernelInputId = (active.nextKernelInputId ?? 0) + 1;
		this.writeWorkerMessage(active.process, {
			kind: "kernel_execute",
			input_id: inputId,
			code,
		});
		return {
			sandbox: active.record,
			inputId,
		};
	}

	interruptKernel(sandboxId: string): SandboxRecord {
		const active = this.getActiveKernel(sandboxId);
		this.writeWorkerMessage(active.process, { kind: "kernel_interrupt" });
		return active.record;
	}

	closeKernel(sandboxId: string): SandboxRecord {
		const active = this.getActiveKernel(sandboxId);
		this.writeWorkerMessage(active.process, { kind: "kernel_close" });
		return active.record;
	}

	async shutdownAll(): Promise<void> {
		this.shuttingDown = true;
		const cleanupFailures: unknown[] = [];
		const goalHandoffTails = [...this.active.values()].flatMap((active) =>
			active.goalHandoffTail ? [active.goalHandoffTail] : [],
		);
		// Close durable activation admission first. Active callbacks observe abort
		// and join exact body cleanup before the general supervisor drain begins.
		try {
			await this.commandActivationService?.stop();
		} catch (error) {
			cleanupFailures.push(error);
		}
		try {
			await this.schedulerService?.stop();
		} catch (error) {
			cleanupFailures.push(error);
		}
		if (this.materializationHeartbeatTimer) clearInterval(this.materializationHeartbeatTimer);
		this.materializationHeartbeatTimer = undefined;
		if (this.materializationHeartbeatTask) await Promise.allSettled([this.materializationHeartbeatTask]);
		for (const timer of this.passivationTimers.values()) clearTimeout(timer);
		this.passivationTimers.clear();
		while (this.passivationTasks.size > 0) {
			await Promise.allSettled([...this.passivationTasks.values()]);
		}
		while (this.spawnTasks.size > 0) {
			await Promise.allSettled([...this.spawnTasks]);
		}
		await this.childExecutionService?.stop();
		this.childExecutionService?.abortExecutions(new Error("Choreograph host is shutting down"));
		for (const timer of this.unexpectedKernelCleanupRetries.values()) clearTimeout(timer);
		this.unexpectedKernelCleanupRetries.clear();
		await this.passivateResidentAgentsForShutdown();
		try {
			await this.executionService.shutdownAll();
		} catch (error) {
			cleanupFailures.push(error);
		}
		while (this.billingOutboxDrain) await this.billingOutboxDrain;
		// A settlement may have landed after the shutdown latch suppressed its
		// ordinary scheduler call. Drain all work claimable now; a still-leased row
		// remains durable for the next process startup.
		try {
			await this.drainInferenceBillingOutbox();
		} catch (error) {
			console.error(`[billing] final inference outbox drain paused: ${boundedInferenceFailure(error)}`);
		}
		this.clearInferenceBillingOutboxWake();
		const promises: Promise<void>[] = [];
		for (const sandboxId of this.active.keys()) {
			promises.push(
				this.killProcess(sandboxId, "killed")
					.then(() => {})
					.catch((error) => {
						cleanupFailures.push(error);
					}),
			);
		}
		await Promise.all(promises);
		// Kernel detach and worker abort make every pre-latch bridge request
		// settle. Draining these sets before physical teardown can deadlock on the
		// very kernel/body cleanup that resolves them.
		while (this.kernelHostRequests.size > 0) {
			await Promise.allSettled([...this.kernelHostRequests]);
		}
		while (this.inferenceRequests.size > 0) {
			await Promise.allSettled([...this.inferenceRequests]);
		}
		while (this.billingOutboxDrain) await this.billingOutboxDrain;
		// A provider settlement can land only after physical teardown aborts its
		// worker request. Re-run the final claim sweep after that stable drain.
		try {
			await this.drainInferenceBillingOutbox();
		} catch (error) {
			console.error(`[billing] post-body final outbox drain paused: ${boundedInferenceFailure(error)}`);
		}
		this.clearInferenceBillingOutboxWake();
		while (this.workerLineRequests.size > 0) {
			await Promise.allSettled([...this.workerLineRequests]);
		}
		await Promise.allSettled(goalHandoffTails);
		await this.childExecutionService?.awaitExecutionDrain();
		while (this.supervisorTasks.size > 0) {
			await Promise.allSettled([...this.supervisorTasks]);
		}
		await this.familyProjectionPump?.stop();
		if (this.active.size > 0) {
			cleanupFailures.push(
				new SandboxCleanupUnavailable(
					`Shutdown retained unverified active sandboxes: ${[...this.active.keys()].join(", ")}`,
				),
			);
		}
		if (cleanupFailures.length > 0) {
			throw new AggregateError(cleanupFailures, "Sandbox shutdown could not verify every physical reap");
		}
	}

	private async passivateResidentAgentsForShutdown(): Promise<void> {
		if (!this.workflowRuntime || !this.agentMemory) return;
		const residents = [...this.active.values()].filter(
			(active): active is ActiveSandbox & { agentRequest: AgentSpawnRequest } =>
				// A Prime resident passivates at shutdown as it does when idle (`scheduleAgentPassivation`), kernel or not:
				// the workspace chat has none (exam 1, finding 8) and must still keep its conversation across a restart.
				Boolean(active.isAgentRun && active.agentRequest?.runtime_binding.kind === "prime"),
		);
		for (const active of residents) {
			const request = active.agentRequest;
			try {
				if (active.hostedChildRunId) {
					const childRun = await this.workflowRuntime.readAgentSessionChildRun(active.hostedChildRunId);
					if (!childRun || !["completed", "failed", "cancelled"].includes(childRun.state)) {
						// The admitted child executor is being aborted concurrently. A
						// nonterminal run has no logical outcome authorizing passivation;
						// kernel-first physical reap leaves exact live truth for recovery.
						continue;
					}
				}
				const materialization = await this.workflowRuntime.readAgentMaterialization(
					request.session_id,
					request.generation,
				);
				if (!materialization || materialization.state !== "running") continue;
				const session = await this.workflowRuntime.readAgentSession(request.session_id);
				if (!session) continue;
				await this.startPassivationTask({
					sessionId: request.session_id,
					generation: request.generation,
					ownerPrincipal: session.graph_owner_principal,
					graphId: session.graph_id,
					runtimeBundleDigest: request.runtime_binding.bundle.digest,
				});
			} catch (error) {
				console.error(
					`[supervisor] shutdown passivation failed for ${request.session_id}: ${boundedInferenceFailure(error)}`,
				);
			}
		}
	}

	private trackHostRequest(request: Promise<void>): Promise<void> {
		this.kernelHostRequests.add(request);
		return request.finally(() => {
			this.kernelHostRequests.delete(request);
		});
	}

	scheduleAgentPassivation(input: {
		sessionId: string;
		generation: number;
		ownerPrincipal: string;
		graphId: string;
		runtimeBundleDigest: string;
		idleMs: number;
		runtimeKind?: string;
	}): Promise<void> {
		if (this.shuttingDown) return Promise.resolve();
		// Passivation parks a persistent kernel; only prime residents have one.
		// A one-shot simple session must never be passivated — the store refuses
		// the transition ("one-shot simple Session cannot passivate") and that
		// refusal poisons an otherwise-healthy run. Guard at the scheduler so
		// every caller inherits the law.
		if (input.runtimeKind !== undefined && input.runtimeKind !== "prime") {
			return Promise.resolve();
		}
		const existing = this.passivationTimers.get(input.sessionId);
		if (existing) clearTimeout(existing);
		if (input.idleMs === 0) return this.startPassivationTask(input);
		const timer = setTimeout(() => {
			this.passivationTimers.delete(input.sessionId);
			if (this.shuttingDown) return;
			void this.startPassivationTask(input).catch((error) => {
				console.error(`[memory] passivation failed for ${input.sessionId}: ${String(error)}`);
			});
		}, input.idleMs);
		timer.unref?.();
		this.passivationTimers.set(input.sessionId, timer);
		return Promise.resolve();
	}

	private startPassivationTask(input: {
		sessionId: string;
		generation: number;
		ownerPrincipal: string;
		graphId: string;
		runtimeBundleDigest: string;
	}): Promise<void> {
		const existing = this.passivationTasks.get(input.sessionId);
		if (existing) return existing;
		let tracked!: Promise<void>;
		tracked = this.trackSupervisorTask(
			this.passivateAgentSession(input).finally(() => {
				if (this.passivationTasks.get(input.sessionId) === tracked) this.passivationTasks.delete(input.sessionId);
			}),
		);
		this.passivationTasks.set(input.sessionId, tracked);
		return tracked;
	}

	async passivateAgentSession(input: {
		sessionId: string;
		generation: number;
		ownerPrincipal: string;
		graphId: string;
		runtimeBundleDigest: string;
	}): Promise<{ checkpointedKernel: boolean; liveBodies: 0 }> {
		if (!this.workflowRuntime || !this.agentMemory) throw new Error("Agent memory runtime is not configured");
		const timer = this.passivationTimers.get(input.sessionId);
		if (timer) clearTimeout(timer);
		this.passivationTimers.delete(input.sessionId);
		const materialization = await this.workflowRuntime.readAgentMaterialization(input.sessionId, input.generation);
		if (!materialization || materialization.state !== "running") {
			throw new Error("Passivation requires the active running materialization");
		}
		const quiesceCommandId = `runtime.quiesce:${input.sessionId}:${String(input.generation)}`;
		await this.workflowRuntime.submitAgentSessionCommand(input.sessionId, {
			commandId: quiesceCommandId,
			idempotencyKey: quiesceCommandId,
			name: "quiesce",
			payload: { reason: "idle", drainDeadlineMs: 10_000 },
			clientId: "choreograph.agent-memory",
			now: Date.now(),
			targetGeneration: input.generation,
			requireDriver: false,
		});
		await this.workflowRuntime.transitionAgentMaterialization(input.sessionId, input.generation, {
			activationId: materialization.activation_id,
			from: "running",
			to: "quiescing",
			now: Date.now(),
		});
		if (this.shuttingDown) {
			await this.drainShutdownQuiesceCommand(materialization.sandbox_id, quiesceCommandId);
		} else {
			await this.drainAgentSessionCommands(materialization.sandbox_id);
		}
		const quiesce = await this.waitForAgentCommandCompletion(quiesceCommandId);
		if (quiesce.state !== "completed") throw new Error(quiesce.error ?? "Prime quiescence command failed");
		await this.waitForAgentBodyExit(input.sessionId, input.generation);
		const kernel = this.executionService.getLeaseForSession(input.sessionId);
		if (kernel && kernel.pending !== 0)
			throw new Error("Kernel still has active executions at the quiescence barrier");
		let checkpointedKernel = false;
		if (kernel) {
			const cells = await this.workflowRuntime.listExecutionJournal(input.sessionId);
			const head = cells.at(-1);
			if (head) {
				const namespace = await this.executionService.probeNamespace(kernel.leaseId);
				await this.workflowRuntime.commitKernelReplayWitness(
					{
						sessionId: input.sessionId,
						generation: input.generation,
						journalHeadDigest: head.cellDigest,
						namespace,
						createdAt: Date.now(),
					},
					materialization.activation_id,
				);
				try {
					const capture = await this.executionService.captureSnapshot(kernel.leaseId);
					await this.agentMemory.commitKernelSnapshot({
						sessionId: input.sessionId,
						generation: input.generation,
						ownerPrincipal: input.ownerPrincipal,
						graphId: input.graphId,
						runtimeBundleDigest: input.runtimeBundleDigest,
						journalHeadDigest: head.cellDigest,
						capture,
						createdAt: new Date().toISOString(),
					});
					checkpointedKernel = true;
				} catch (error) {
					console.error(`[memory] kernel snapshot unavailable; journal remains authoritative: ${String(error)}`);
				}
			}
		}
		await this.workflowRuntime.transitionAgentMaterialization(input.sessionId, input.generation, {
			activationId: materialization.activation_id,
			from: "quiescing",
			to: "quiescent",
			now: Date.now(),
		});
		if (kernel) {
			this.restoredKernelLeases.delete(kernel.leaseId);
			await this.executionService.shutdown(kernel.leaseId);
		}
		if (this.sessionBodyCount(input.sessionId) !== 0) throw new Error("Passivation did not reach zero live bodies");
		await this.workflowRuntime.transitionAgentMaterialization(input.sessionId, input.generation, {
			activationId: materialization.activation_id,
			from: "quiescent",
			to: "passivated",
			now: Date.now(),
		});
		await this.wakeAgentSessionFamilyProjection();
		return { checkpointedKernel, liveBodies: 0 };
	}

	sessionBodyCount(sessionId: string): number {
		let count = this.executionService.getLeaseForSession(sessionId) ? 1 : 0;
		for (const active of this.active.values()) {
			if (active.bodyBound !== false && active.isAgentRun && active.agentRequest?.session_id === sessionId)
				count += 1;
		}
		return count;
	}

	/** Internal lifecycle inspection; never part of the public child handle or graph projection. */
	getKernelLeaseForSession(sessionId: string) {
		return this.executionService.getLeaseForSession(sessionId);
	}

	getActive(): Map<string, ActiveSandbox> {
		return this.active;
	}

	/** Spawn queue stats for health endpoint / backpressure */
	getQueueStats(): { spawning: number; available: number; pending: number } {
		return {
			spawning: this.active.size,
			available: this.semaphore.available,
			pending: this.semaphore.pending,
		};
	}

	// ─── Internal ─────────────────────────────────────────────────────────
	private async waitForAgentBodyExit(sessionId: string, generation: number): Promise<void> {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const live = [...this.active.values()].some(
				(active) =>
					active.isAgentRun &&
					active.agentRequest?.session_id === sessionId &&
					active.agentRequest.generation === generation,
			);
			if (!live) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
		}
		throw new Error("Agent body did not exit before the quiescence deadline");
	}

	private async waitForAgentCommandCompletion(commandId: string): Promise<AgentSessionCommandRecord> {
		if (!this.workflowRuntime) throw new Error("Agent command runtime is not configured");
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) {
			const command = await this.workflowRuntime.readAgentSessionCommand(commandId);
			if (
				command &&
				(command.state === "completed" || command.state === "failed" || command.state === "cancelled")
			) {
				return command;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
		}
		throw new Error("Agent command did not complete before the quiescence deadline");
	}

	private getActiveRuntime(sandboxId: string): ActiveSandbox {
		const active = this.active.get(sandboxId);
		if (!active) {
			const record = this.store.get(sandboxId);
			if (!record) {
				throw new Error(`Sandbox not found: ${sandboxId}`);
			}
			throw new Error(`Sandbox ${sandboxId} is not active (state: ${record.state})`);
		}
		if (!active.isRuntimeRun) {
			throw new Error(`Sandbox ${sandboxId} is not a runtime session`);
		}
		if (active.record.state !== "running") {
			throw new Error(`Sandbox ${sandboxId} is not running (state: ${active.record.state})`);
		}
		return active;
	}

	private resolveWorkerRuntime(sandboxId: string, opts: SpawnOptions): Promise<ResolvedWorkerRuntime> {
		return this.resolveWorkerRuntimeInner(sandboxId, opts);
	}

	private async resolveWorkerRuntimeInner(sandboxId: string, opts: SpawnOptions): Promise<ResolvedWorkerRuntime> {
		if (isKernelWorkerConfig(opts.worker_config)) {
			const bridge =
				this.sandboxMode === "local-native"
					? resolveLocalPythonBridge("kernel")
					: resolveBridge(opts.worker_config.kernel);
			return {
				runtime: this.workerScript,
				initMessage: {
					kind: "init",
					config: {
						...opts.worker_config,
						bridge_command: bridge.command,
						env: { ...bridge.env, ...(opts.worker_config.env ?? {}) },
					},
				},
				keepStdinOpen: true,
				isAgentRun: false,
				isRuntimeRun: false,
				isKernelRun: true,
				kernelKind: opts.worker_config.kernel,
				bridgeFilesystems: bridge.filesystems,
			};
		}

		if (isRuntimeWorkerConfig(opts.worker_config)) {
			const bridge = opts.worker_config.runtime === "python" ? resolvePythonRuntimeBridge() : undefined;
			return {
				runtime: this.workerScript,
				initMessage: {
					kind: "init",
					config: bridge
						? {
								...opts.worker_config,
								bridge_command: bridge.command,
								env: { ...bridge.env, ...(opts.worker_config.env ?? {}) },
							}
						: opts.worker_config,
				},
				keepStdinOpen: true,
				isAgentRun: false,
				isRuntimeRun: true,
				isKernelRun: false,
				runtimeKind: opts.worker_config.runtime,
				bridgeFilesystems: bridge?.filesystems,
				capabilityRegistry: cloneCapabilityRegistry(opts.capabilityBackends),
			};
		}

		if (!isAgentWorkerConfig(opts.worker_config)) {
			return {
				runtime: this.workerScript,
				initMessage: {
					kind: "init",
					config: opts.worker_config ?? {
						max_iterations: 60,
						sleep_ms: 1000,
					},
				},
				keepStdinOpen: false,
				isAgentRun: false,
				isRuntimeRun: false,
				isKernelRun: false,
			};
		}

		if (opts.template !== "agent") {
			throw new Error(`Agent workloads require the agent template (got: ${opts.template})`);
		}

		const built = await this.buildAgentRequest(sandboxId, opts, opts.worker_config);
		const evolutionRuntime = await this.resolvePrimeRuntimeOverlays(built.request);
		let capabilityRegistry = built.capabilityRegistry ?? new Map<string, CapabilityBackend>();
		mergeCapabilityRegistry(capabilityRegistry, opts.capabilityBackends);
		if (capabilityRegistry.size > 0) {
			if (!opts.capabilityGrantPolicy) {
				await closeCapabilityRegistry(capabilityRegistry);
				throw new Error("Agent host capabilities require an exact trusted grant policy");
			}
			capabilityRegistry = applyHostCapabilityGrantPolicy(capabilityRegistry, opts.capabilityGrantPolicy);
		}
		const hostCapabilityDescriptors = Object.fromEntries(
			[...capabilityRegistry.keys()]
				.filter((name) => name !== "mnemosyne" && name !== "acp.authority")
				.map((name) => [name, { kind: "host" }]),
		);
		const request = {
			...built.request,
			...primeRuntimeOverlayEnvelope(built.request, evolutionRuntime.materializations),
			capabilities:
				Object.keys(hostCapabilityDescriptors).length > 0 || built.request.capabilities
					? { ...built.request.capabilities, ...hostCapabilityDescriptors }
					: undefined,
		};
		// Hard cutover: simple and Prime are constraint profiles over the same
		// Sophia-hosted semantic core. There is no older one-shot worker branch.
		const runtime =
			this.sandboxMode === "local-native"
				? { hostScriptPath: resolveSophiaAgentLocalEntrypoint() }
				: { sandboxEntrypointPath: SOPHIA_AGENT_SANDBOX_PATH };
		const agentFilesystems = [
			SOPHIA_AGENT_RUNTIME_BUNDLE_ID,
			...(request.runtime_binding.constraints.allowPersistentKernel ? ["python-runtime"] : []),
		];
		const restoreState = resolvePrimeRestoreState(request, opts.worker_config.restore_state);
		const activationName = restoreState ? "runtime.restore" : "runtime.initialize";
		const hasPersonalWorkspace = opts.privateMounts?.some(
			(mount) => mount.guestPath === "/workspace" && mount.mode === "rw",
		);
		const primeDaemon = preparePrimeDaemonSocket(request, sandboxId, this.sandboxMode, this.localNativeBody);

		return {
			runtime,
			initMessage: {
				protocol: PRIME_HOST_PROTOCOL_VERSION,
				messageId: `${activationName}:${sandboxId}:${request.generation}`,
				sessionId: request.session_id,
				sandboxId,
				generation: request.generation,
				correlationId: `materialization:${sandboxId}:${request.generation}`,
				direction: "host_to_worker",
				kind: "command",
				name: activationName,
				payload: restoreState
					? { request, sessionRevision: restoreState.workerSequence, state: restoreState }
					: { request, sessionRevision: 0 },
			},
			keepStdinOpen: true,
			isAgentRun: true,
			isRuntimeRun: false,
			isKernelRun: false,
			bridgeFilesystems: agentFilesystems,
			privateMounts: [
				...(built.privateMounts ?? []),
				...evolutionRuntime.mounts,
				...(primeDaemon?.mount ? [primeDaemon.mount] : []),
			],
			environment:
				this.sandboxMode === "local-native"
					? {
							...(process.env.SOPHIA_PRIME_KERNEL_PYTHON
								? { SOPHIA_PRIME_KERNEL_PYTHON: process.env.SOPHIA_PRIME_KERNEL_PYTHON }
								: {}),
							...(process.env.SOPHIA_PRIME_PYTHONPATH
								? { SOPHIA_PRIME_PYTHONPATH: process.env.SOPHIA_PRIME_PYTHONPATH }
								: {}),
							...(hasPersonalWorkspace ? { SOPHIA_AGENT_WORKSPACE: "/workspace" } : {}),
							...(primeDaemon ? { SOPHIA_PRIME_DAEMON_SOCKET: primeDaemon.workerSocket } : {}),
						}
					: {
							SOPHIA_PRIME_KERNEL_PYTHON: PYTHON_RUNTIME_SANDBOX_PATH,
							SOPHIA_PRIME_PYTHONPATH: SOPHIA_AGENT_PYTHONPATH,
							...(hasPersonalWorkspace ? { SOPHIA_AGENT_WORKSPACE: "/workspace" } : {}),
							...(primeDaemon ? { SOPHIA_PRIME_DAEMON_SOCKET: primeDaemon.workerSocket } : {}),
						},
			agentRequest: request,
			primeDaemonHostSocket: primeDaemon?.hostSocket,
			primeDaemonHostDir: primeDaemon?.hostDir,
			capabilityRegistry: capabilityRegistry.size > 0 ? capabilityRegistry : undefined,
			graphProjectionProxy: built.graphProjectionProxy,
		};
	}

	private async resolvePrimeRuntimeOverlays(request: AgentSpawnRequest): Promise<{
		materializations: NonNullable<AgentSpawnRequest["runtime_overlays"]>;
		mounts: readonly PrivateSandboxMount[];
	}> {
		const evolutionBinding = request.embodiment_binding?.runtimeBinding;
		if (!evolutionBinding || evolutionBinding.overlays.length === 0) return { materializations: [], mounts: [] };
		if (this.sandboxMode !== "bwrap") {
			throw new Error("Prime runtime overlays require the bwrap security boundary");
		}
		if (!this.extensionArtifactResolver) {
			throw new Error("Prime runtime overlays require a host extension artifact resolver");
		}
		const materializations: NonNullable<AgentSpawnRequest["runtime_overlays"]> = [];
		const mounts: PrivateSandboxMount[] = [];
		for (const overlay of evolutionBinding.overlays) {
			if (overlay.role === "evaluation-fixture") {
				throw new Error("Active Agent Embodiments cannot materialize evaluation fixtures");
			}
			const resolved = await this.extensionArtifactResolver.resolveArtifact(
				overlay.ownerPrincipal,
				overlay.artifact,
			);
			const artifact = resolved.record.artifact;
			if (artifact.ownerPrincipal !== overlay.ownerPrincipal || artifact.abi !== evolutionBinding.extensionAbi) {
				throw new Error("Resolved Prime extension artifact differs from its runtime overlay");
			}
			const guestPath = `/opt/sophia/extensions/${String(overlay.order)}-${artifact.extensionId}` as const;
			materializations.push({
				schema: RUNTIME_OVERLAY_MATERIALIZATION_SCHEMA,
				role: overlay.role,
				ownerPrincipal: overlay.ownerPrincipal,
				artifact: overlay.artifact,
				manifestRef: overlay.manifestRef,
				order: overlay.order,
				guestPath,
				artifactDigest: artifact.artifactDigest,
				manifestDigest: artifact.manifestDigest,
			});
			mounts.push({ hostPath: resolved.hostPath, guestPath, mode: "ro" });
		}
		return { materializations, mounts };
	}

	private async buildAgentRequest(
		sandboxId: string,
		opts: SpawnOptions,
		config: AgentWorkerConfig,
	): Promise<{
		request: AgentSpawnRequest;
		capabilityRegistry?: Map<string, CapabilityBackend>;
		graphProjectionProxy?: AgentSessionFamilyGraphProxy;
		privateMounts?: readonly PrivateSandboxMount[];
	}> {
		const request = config.request ?? {};
		const semantic = resolveAgentSemanticAuthority(request, config);
		const contentAuthority = resolveSealedContentAuthority(request, config);
		const intent = request.intent ?? config.intent ?? opts.intent ?? "Run sandbox agent";
		const messages = request.messages ??
			config.messages ?? [
				{
					role: "user",
					content: [{ type: "text", text: intent }],
					timestamp: Date.now(),
				},
			];
		const wards = {
			...DEFAULT_WARDS,
			...(config.wards ?? {}),
			...(request.wards ?? {}),
		};
		const defaultMnemosyne = buildDefaultMnemosyneDescriptor(opts.mnemosyne);
		const configMnemosyne = config.mnemosyne ?? {};
		const requestMnemosyne = request.mnemosyne ?? {};
		const mergedMnemosyne: MnemosyneSessionDescriptor = {
			...defaultMnemosyne,
			...configMnemosyne,
			...requestMnemosyne,
			graph_scope: {
				...defaultMnemosyne.graph_scope,
				...(configMnemosyne.graph_scope ?? {}),
				...(requestMnemosyne.graph_scope ?? {}),
			},
		};

		// ── Capability registry (Contract B / Slice 3) ──────────────────────
		// Always build a registry.  "mnemosyne" is bound implicitly from the
		// hosted proxy.  Per-node capabilities declared in config.capabilities
		// are bound here too (the agent names them; access-level is enforced
		// inside each backend — wrapMnemosyneProxy filters/rejects write tools
		// when the session's capabilities disable writes).

		const registry = new Map<string, CapabilityBackend>();
		let graphProjectionProxy: HostedMnemosyneProxy | undefined;

		if (isHostedMnemosyneDescriptor(mergedMnemosyne)) {
			const serviceAuth = resolveGatewayServiceAuth(opts.ownerUserId);
			if (serviceAuth) {
				mergedMnemosyne.graph_scope.default_graph_owner ??= `user:${serviceAuth.onBehalfOf}`;
				mergedMnemosyne.graph_scope.bound_cell = true;
			}
			console.error(
				`[spawner] sandbox ${sandboxId.slice(0, 8)}: creating hosted Mnemosyne proxy (mcp_url=${mergedMnemosyne.mcp_url}, graph=${mergedMnemosyne.graph_scope.default_graph_id})`,
			);
			const proxy = this.createHostedMnemosyneProxy(sandboxId, mergedMnemosyne, opts);
			const hostedSession = await proxy.start();
			graphProjectionProxy = proxy;
			console.error(
				`[spawner] sandbox ${sandboxId.slice(0, 8)}: hosted session created (userId=${hostedSession.userId}, expires=${hostedSession.expiresAt})`,
			);
			mergedMnemosyne.session_token = "host-proxy";
			mergedMnemosyne.expires_at = hostedSession.expiresAt;

			// Wrap proxy as the "mnemosyne" CapabilityBackend.
			// Access-level comes from the session's declared capabilities (writes flag).
			const sessionCaps = opts.mnemosyne?.capabilities ?? { reads: true, writes: true, dangerous_ops: false };
			registry.set("mnemosyne", wrapMnemosyneProxy(proxy, sessionCaps));
		} else {
			console.error(
				`[spawner] sandbox ${sandboxId.slice(0, 8)}: mnemosyne disabled (mcp_url=${mergedMnemosyne.mcp_url})`,
			);
		}

		// Bind per-node declared capabilities (agent names them; backend is resolved here).
		const nodeCaps = config.capabilities ?? {};
		for (const [capName, descriptor] of Object.entries(nodeCaps)) {
			if (descriptor.kind === "web") {
				console.error(
					`[spawner] sandbox ${sandboxId.slice(0, 8)}: binding capability "${capName}" → subject.web ` +
						`(engine=${descriptor.engine ?? "chromium"}, boundOrigin=${descriptor.boundOrigin ?? "none"})`,
				);
				const browser = new BrowserCapabilityBackend({
					serviceBaseUrl: resolveBrowserServiceUrl(),
					engine: descriptor.engine ?? "chromium",
					capabilityName: capName,
					storageStateRef: typeof descriptor.storageStateRef === "string" ? descriptor.storageStateRef : undefined,
					boundOrigin: typeof descriptor.boundOrigin === "string" ? descriptor.boundOrigin : undefined,
					accessLevel: descriptor.accessLevel === "ro" ? "ro" : "rw",
				});
				const { sessionId } = await browser.create();
				console.error(
					`[spawner] sandbox ${sandboxId.slice(0, 8)}: browser session minted for "${capName}" (sessionId=${sessionId.slice(0, 8)}…)`,
				);
				registry.set(capName, browser);
			}
			// Future backends (garden, etc.) — leave seam, not built in Slice 3.
		}

		// ── acp.authority (CA-1 / B-keystone) ───────────────────────────────
		// Register the per-session multi-driver permission backend, when the
		// orchestrator supplied one. The worker's destructive-tool gate
		// round-trips `acp.authority.request_permission` here; the backend blocks
		// on the driver's decision (or the S3 auto-deny timeout). Additive: with
		// no `opts.authority` the registry is unchanged.
		if (opts.authority) {
			console.error(
				`[spawner] sandbox ${sandboxId.slice(0, 8)}: registering acp.authority capability (multi-driver permission gate)`,
			);
			registry.set(opts.authority.capabilityName, opts.authority);
		}

		// ── Resolve the two identity-bearing fields ONCE so the observer id and the
		// wire `model`/`system_prompt` are derived from the SAME values. ──────────
		const resolvedModel = request.model ?? config.model ?? "mock:done";
		const baseSystemPrompt = request.system_prompt ?? config.system_prompt;
		// A continued chat's earlier conversation reaches the model only here, resolved anew every time
		// its body is built (first spawn and every regrow): the system prompt is rebuilt from the durable
		// record at each activation and is not part of the checkpoint, so nothing else would carry it.
		if (config.seed_ref && contentAuthority) {
			throw new Error("A continued chat cannot also carry a sealed content-authority prompt");
		}
		const resolvedSystemPrompt = config.seed_ref
			? await resolveSeededSystemPrompt({
					resolver: this.chatSeeds,
					seed: parseAgentSeedRef(config.seed_ref, "worker config seed_ref"),
					sessionId: semantic.sessionId,
					ownerUserId: opts.ownerUserId,
					basePrompt: baseSystemPrompt,
					onDegraded: (reason) =>
						console.error(
							`[spawner] sandbox ${sandboxId.slice(0, 8)}: ${reason} for continued chat session ${semantic.sessionId}`,
						),
				})
			: (contentAuthority?.prompt.finalPromptUtf8 ?? baseSystemPrompt);
		const effectiveProvider = request.provider ?? config.provider ?? resolveAgentLlmProvider(process.env);
		// Catalog network and snapshot access stay on the trusted host. Ignore any
		// caller-provided request.model_descriptor and mint the overlay here.
		const modelDescriptor = await this.modelCatalog?.resolveModel(effectiveProvider, resolvedModel, {
			requireTools: true,
		});
		const listedModels =
			request.interaction_mode === "headed" || config.interaction_mode === "headed"
				? ((await this.modelCatalog?.listModels?.(effectiveProvider)) ?? []).filter(
						(descriptor) => descriptor.provider === effectiveProvider && descriptor.supportsTools !== false,
					)
				: [];
		const modelCatalog = new Map(listedModels.map((descriptor) => [descriptor.id, descriptor]));
		if (modelDescriptor) modelCatalog.set(modelDescriptor.id, modelDescriptor);
		const candidateWorkspace = resolveCandidateWorkspaceMount(config.candidate_workspace, semantic);
		const harnessMaterialization = resolveHarnessMaterialization(config.harness_materialization, semantic);
		// The durable materialization fence is host composition authority.  In
		// particular, a nested request is potentially worker-authored and cannot
		// mint or replace the activation that guards H goal witness/result settlement.
		if (request.invocation_id !== undefined) {
			throw new Error("Agent request cannot supply a host materialization activation id");
		}
		const invocationId = parseOptionalHostMaterializationActivationId(config.invocation_id);

		return {
			capabilityRegistry: registry.size > 0 ? registry : undefined,
			graphProjectionProxy,
			...(candidateWorkspace ? { privateMounts: [candidateWorkspace.mount] } : {}),
			request: {
				spawn_id: request.spawn_id ?? sandboxId,
				session_id: semantic.sessionId,
				generation: semantic.generation,
				...(invocationId === undefined ? {} : { invocation_id: invocationId }),
				intent,
				await_initial_command: request.await_initial_command ?? config.await_initial_command,
				messages,
				system_prompt: resolvedSystemPrompt,
				...(contentAuthority ? { verified_execution_capsule: contentAuthority } : {}),
				wards,
				mnemosyne: mergedMnemosyne,
				medium: request.medium ?? config.medium ?? "conversation",
				model: resolvedModel,
				// Per-request inference provider (CA-1 shared substrate). Additive —
				// forwarded verbatim; unset ⇒ the worker resolves the env-default.
				provider: request.provider ?? config.provider,
				model_descriptor: modelDescriptor,
				...(modelCatalog.size > 0 ? { model_catalog: [...modelCatalog.values()] } : {}),
				interaction_mode: request.interaction_mode ?? config.interaction_mode ?? "headless",
				// Stable agent-subject observer id (see mint above). Additive; threaded
				// to the worker, which injects it as `observer_agent_id` on Geist tools.
				agent_id: semantic.ontology.subject.agentId,
				depth: request.depth ?? config.depth ?? 0,
				parent_spawn_id: request.parent_spawn_id ?? config.parent_spawn_id,
				// Workflow-engine ("Loom") per-node knobs — forwarded verbatim to the worker.
				output_schema: request.output_schema ?? config.output_schema,
				tool_mode: request.tool_mode ?? config.tool_mode,
				exclude_tools: request.exclude_tools ?? config.exclude_tools,
				include_tools: request.include_tools ?? config.include_tools,
				strict_tool_manifest: request.strict_tool_manifest ?? config.strict_tool_manifest,
				// Multi-driver permission gate (CA-1 / B-keystone). The worker installs
				// its destructive-tool `beforeToolCall` hook iff this is true. We force
				// it on whenever an `acp.authority` backend was registered, so the gate
				// and its answerer are always wired together (no half-state). Otherwise
				// fall through to the request/config flag (default unset ⇒ no gate).
				gate_destructive_tools:
					opts.authority !== undefined || request.gate_destructive_tools || config.gate_destructive_tools,
				// Forward capability declarations to the worker (informational; binding already done above).
				capabilities: config.capabilities,
				runtime_binding: semantic.runtime,
				runtime_binding_digest: semantic.runtimeDigest,
				agent_ontology: semantic.ontology,
				agent_ontology_binding_digest: semantic.ontologyDigest,
				...(semantic.embodiment && semantic.embodimentRef && semantic.embodimentDigest
					? {
							embodiment_ref: semantic.embodimentRef,
							embodiment_binding: semantic.embodiment,
							embodiment_binding_digest: semantic.embodimentDigest,
						}
					: {}),
				...(candidateWorkspace ? { candidate_workspace: candidateWorkspace.publicDescriptor } : {}),
				...(harnessMaterialization ? { harness_materialization: harnessMaterialization } : {}),
				initial_goal: request.initial_goal ?? config.initial_goal,
			},
		};
	}

	private createHostedMnemosyneProxy(
		sandboxId: string,
		descriptor: MnemosyneSessionDescriptor,
		opts: SpawnOptions,
	): HostedMnemosyneProxy {
		// Gateway service-auth (platform-next cells cloud) skips the legacy mint:
		// the acting user is the authenticated chat owner, asserted on-behalf-of.
		const serviceAuth = resolveGatewayServiceAuth(opts.ownerUserId);
		if (opts.requireGatewayServiceAuth && !serviceAuth) {
			throw new Error("durable cloud supervisor graph access requires gateway service auth");
		}
		// Durable cloud work is a hard authority branch, not merely a preference.
		// Never even parse legacy/direct credentials in this mode: malformed ambient
		// env or a parent bearer cannot poison or become resident in a child proxy.
		const directMcp = opts.requireGatewayServiceAuth ? undefined : resolveDirectMcpAuth(opts.ownerUserId);
		// In service-auth mode the proxy short-circuits and never dials apiBaseUrl,
		// but rank the live gateway ahead of MNEMOSYNE_API_BASE_URL so a future
		// degradation can't silently fall back to the (possibly dead) legacy plane.
		const apiBaseUrl = opts.requireGatewayServiceAuth
			? serviceAuth!.gatewayBaseUrl
			: opts.mnemosyne?.apiBaseUrl?.trim() ||
				serviceAuth?.gatewayBaseUrl ||
				process.env.MNEMOSYNE_API_BASE_URL?.trim() ||
				directMcp?.mcpUrl;
		if (!apiBaseUrl) {
			throw new Error(
				"MNEMOSYNE_API_BASE_URL, direct MCP auth (MNEMOSYNE_MCP_URL + MNEMOSYNE_MCP_ACCESS_TOKEN), " +
					"or gateway service-auth (MNEMOSYNE_SERVICE_TOKEN + MNEMOSYNE_GATEWAY_BASE_URL) is required " +
					"for hosted Mnemosyne proxy mode",
			);
		}

		return new HostedMnemosyneProxy({
			apiBaseUrl,
			ownerPrincipal: descriptor.graph_scope.default_graph_owner,
			graphId: descriptor.graph_scope.default_graph_id,
			toolProfile: descriptor.tool_profile,
			runtime: opts.mnemosyne?.runtime ?? process.env.MNEMOSYNE_RUNTIME ?? "choreograph",
			label: opts.mnemosyne?.label ?? `sandbox-${sandboxId.slice(0, 8)}`,
			requestTimeoutMs: parseIntegerEnv("MNEMOSYNE_REQUEST_TIMEOUT_MS") ?? 60_000,
			authContext: opts.requireGatewayServiceAuth ? undefined : opts.authContext,
			apiToken: opts.requireGatewayServiceAuth ? undefined : process.env.MNEMOSYNE_API_TOKEN,
			allowGlobalTokenFallback: opts.requireGatewayServiceAuth
				? false
				: (parseBooleanEnv("MNEMOSYNE_ALLOW_GLOBAL_TOKEN_FALLBACK") ?? false),
			requiredTools: opts.mnemosyne?.requiredTools ?? [
				"search_documents",
				"read_document",
				"append_to_document",
				"remember",
			],
			capabilities: opts.mnemosyne?.capabilities,
			preferredMcpUrl: opts.requireGatewayServiceAuth ? undefined : (opts.mnemosyne?.mcpUrl ?? descriptor.mcp_url),
			serviceAuth,
			directMcp,
		});
	}

	private async createFamilyProjectionGraphLease(
		authority: AgentSessionFamilyProjectionGraphAuthority,
	): Promise<AgentSessionFamilyProjectionGraphLease> {
		const mnemosyne: MnemosyneRequestOptions = {
			ownerPrincipal: authority.graphOwnerPrincipal,
			graphId: authority.graphId,
			toolProfile: "full",
			label: `family-projection-${authority.rootSessionId}`,
			requiredTools: ["sparql_update"],
			capabilities: { reads: true, writes: true, dangerous_ops: false },
		};
		const proxy = this.createHostedMnemosyneProxy(
			`projection:${authority.rootSessionId}`,
			buildDefaultMnemosyneDescriptor(mnemosyne),
			{
				template: "bare",
				ownerUserId: authority.ownerUserId,
				requireGatewayServiceAuth: this.sandboxMode !== "local-native",
				authMethod: "internal-service",
				mnemosyne,
			},
		);
		await proxy.start();
		return { proxy, close: () => proxy.close() };
	}

	private async waitForRunningOrTerminal(sandboxId: string, timeoutMs = 30_000): Promise<SandboxRecord> {
		const deadline = Date.now() + timeoutMs;
		const TERMINAL = new Set(["running", "done", "truncated", "error", "timeout", "killed"]);
		while (Date.now() < deadline) {
			const record = this.store.get(sandboxId);
			if (record && TERMINAL.has(record.state)) return record;
			await new Promise((r) => setTimeout(r, 50));
		}
		const final = this.store.get(sandboxId);
		throw new Error(
			`Sandbox ${sandboxId} did not reach running state within ${timeoutMs}ms (state: ${final?.state})`,
		);
	}

	private async waitForKernelReady(sandboxId: string, timeoutMs = 90_000, signal?: AbortSignal): Promise<void> {
		if (!this.eventBus) throw new Error("Kernel readiness requires the sandbox event bus");
		await new Promise<void>((resolveReady, rejectReady) => {
			let settled = false;
			let unsubscribe = () => {};
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				unsubscribe();
				signal?.removeEventListener("abort", abort);
				if (error) rejectReady(error);
				else resolveReady();
			};
			const abort = () =>
				finish(
					signal?.reason instanceof Error
						? signal.reason
						: new Error("Kernel readiness was aborted by its Session reap fence"),
				);
			const inspect = (event: BusEvent) => {
				if (event.category === "system" && event.type === "snapshot") {
					for (const replayed of event.recent_events) inspect(replayed);
					return;
				}
				if (event.category === "system" && event.type === "kernel_ready") {
					finish();
					return;
				}
				if (event.category === "lifecycle" && event.type === "terminal") {
					finish(new Error(`Kernel sandbox terminated before readiness (state: ${event.state})`));
				}
			};
			const timer = setTimeout(
				() => finish(new Error(`Kernel sandbox ${sandboxId} was not ready within ${timeoutMs}ms`)),
				timeoutMs,
			);
			unsubscribe = this.eventBus!.subscribe(inspect, { sandbox_id: sandboxId });
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			if (settled) unsubscribe();
		});
	}

	private async executeSpawn(sandboxId: string, opts: SpawnOptions): Promise<void> {
		const queueEnterTime = performance.now();

		// Wait for a spawn slot
		await this.semaphore.acquire();

		const queueWaitSec = (performance.now() - queueEnterTime) / 1000;
		spawnQueueWaitSeconds.record(queueWaitSec, { template: opts.template });
		spawnQueueDepth.add(-1, { template: opts.template });

		// Check if the sandbox was killed while queued
		const current = this.store.get(sandboxId);
		if (!current || current.state !== "queued") {
			this.semaphore.release();
			return;
		}

		try {
			if (this.shuttingDown) throw new Error("Sandbox spawn was cancelled by host shutdown");
			await opts.preSpawnGate?.({ sandboxId });
			// The authority gate can itself be in flight when shutdown latches.
			// Recheck after it resolves so no adapter can enter behind the stable
			// shutdown barrier merely because it passed an earlier admission check.
			if (this.shuttingDown) throw new Error("Sandbox spawn was cancelled by host shutdown");
			// The gate can race an exact cancellation which terminalizes the queued
			// sandbox. Never enter an adapter after that durable arbitration.
			const gated = this.store.get(sandboxId);
			if (!gated || gated.state !== "queued") return;
			await this.doSpawn(sandboxId, opts);
		} catch (error) {
			const gated = this.store.get(sandboxId);
			if (gated?.state === "queued") {
				const detail = error instanceof Error ? error.message : "pre-spawn authority rejected";
				this.store.transition(sandboxId, "killed", detail);
				this.emitBusEvent({
					category: "lifecycle",
					type: "terminal",
					sandbox_id: sandboxId,
					ts: new Date().toISOString(),
					state: "killed",
					error_detail: detail,
				});
			}
			await Promise.allSettled(
				[...new Set([...(opts.capabilityBackends?.values() ?? []), opts.authority].filter(Boolean))].map(
					(backend) => backend!.close(),
				),
			);
			throw error;
		} finally {
			this.semaphore.release();
		}
	}

	private async doSpawn(sandboxId: string, opts: SpawnOptions): Promise<void> {
		return tracer.startActiveSpan("sandbox.spawn", async (spawnSpan) => {
			const spawnStartTime = performance.now();

			spawnSpan.setAttributes({
				"sandbox.id": sandboxId,
				"sandbox.template": opts.template,
				"sandbox.timeout_ms": opts.timeout_ms ?? this.defaultTimeoutMs,
			});
			if (opts.filesystems?.length) {
				spawnSpan.setAttribute("sandbox.filesystem_count", opts.filesystems.length);
			}
			if (opts.resources?.memory_max_bytes != null) {
				spawnSpan.setAttribute("sandbox.resources.memory_max_bytes", opts.resources.memory_max_bytes);
			}
			if (opts.resources?.cpu_quota_us != null) {
				spawnSpan.setAttribute("sandbox.resources.cpu_quota_us", opts.resources.cpu_quota_us);
			}
			if (opts.resources?.pids_max != null) {
				spawnSpan.setAttribute("sandbox.resources.pids_max", opts.resources.pids_max);
			}
			if (opts.intent) {
				spawnSpan.setAttribute("sandbox.intent", opts.intent);
			}

			let workerRuntime: ResolvedWorkerRuntime | undefined;
			try {
				workerRuntime = await this.resolveWorkerRuntime(sandboxId, opts);

				// 1. Resolve the sandbox launch command. bwrap is the production path;
				// local-native is a development path that runs the same worker as a
				// direct Node child process on the host.
				let effectiveFilesystems = opts.filesystems ?? [];
				if (workerRuntime.bridgeFilesystems) {
					effectiveFilesystems = [...new Set([...effectiveFilesystems, ...workerRuntime.bridgeFilesystems])];
				}
				const launch =
					this.sandboxMode === "local-native"
						? localNativeLaunch(workerRuntime.runtime, workerRuntime.environment, this.localNativeBody)
						: {
								command: "bwrap",
								args: buildBwrapArgs(opts.template, workerRuntime.runtime, workerRuntime.environment, {
									filesystems: effectiveFilesystems,
									privateMounts: [...(opts.privateMounts ?? []), ...(workerRuntime.privateMounts ?? [])],
								}),
								env: process.env,
							};

				// 2. Create cgroup with resource limits
				const cgroupConfig: CgroupConfig = {
					memory_max_bytes: opts.resources?.memory_max_bytes,
					cpu_quota_us: opts.resources?.cpu_quota_us,
					cpu_period_us: opts.resources?.cpu_period_us,
					pids_max: opts.resources?.pids_max,
				};
				const cgroupPath =
					this.sandboxMode === "local-native"
						? undefined
						: await createSandboxCgroup(this.cgroup.parentPath, sandboxId, cgroupConfig);

				// 3. Batch: transition to spawning + set cgroup path
				this.store.transitionToSpawning(sandboxId, cgroupPath ?? "local-native");
				this.emitBusEvent({
					category: "lifecycle",
					type: "spawning",
					sandbox_id: sandboxId,
					ts: new Date().toISOString(),
				});

				// 4. Spawn worker process
				await tracer.startActiveSpan(`sandbox.spawn.${this.sandboxMode}_exec`, async (execSpan) => {
					const processLaunch = cgroupPath
						? { ...launch, ...launchInCgroup(cgroupPath, launch.command, launch.args) }
						: launch;
					const child = this.spawnProcess(processLaunch.command, processLaunch.args, {
						stdio: ["pipe", "pipe", "pipe"],
						env: processLaunch.env,
						cwd: processLaunch.cwd,
						...("uid" in processLaunch && processLaunch.uid !== undefined
							? { uid: processLaunch.uid, gid: processLaunch.gid }
							: {}),
					});

					const record = this.store.get(sandboxId)!;
					const active: ActiveSandbox = {
						record,
						process: child,
						cgroupPath,
						bodyBound: false,
						isAgentRun: workerRuntime.isAgentRun,
						isRuntimeRun: workerRuntime.isRuntimeRun,
						isKernelRun: workerRuntime.isKernelRun,
						runtimeKind: workerRuntime.runtimeKind,
						kernelKind: workerRuntime.kernelKind,
						nextRuntimeInputId: workerRuntime.isRuntimeRun ? 0 : undefined,
						nextKernelInputId: workerRuntime.isKernelRun ? 0 : undefined,
						nextHostCommandId: workerRuntime.isAgentRun ? 0 : undefined,
						nextHostResponseId: workerRuntime.isAgentRun ? 0 : undefined,
						nextPrimeWorkerSequence: workerRuntime.isAgentRun ? 0 : undefined,
						bridgeAbortControllers: workerRuntime.isAgentRun ? new Map() : undefined,
						capabilityRegistry: workerRuntime.capabilityRegistry,
						graphProjectionProxy: workerRuntime.graphProjectionProxy,
						graphId: opts.mnemosyne?.graphId,
						mockLlmState: workerRuntime.isAgentRun ? { requestCount: 0 } : undefined,
						toolCallStarts: workerRuntime.isAgentRun ? new Map() : undefined,
						toolCallSpans: workerRuntime.isAgentRun ? new Map() : undefined,
						captureIdentity: captureIdentityFor(opts),
						turnToolCount: workerRuntime.isAgentRun ? 0 : undefined,
						trustedInference: workerRuntime.agentRequest
							? {
									provider: workerRuntime.agentRequest.provider ?? resolveAgentLlmProvider(process.env),
									model: workerRuntime.agentRequest.model,
									ownerUserId: record.owner_user_id ?? opts.ownerUserId,
									descriptor: workerRuntime.agentRequest.model_descriptor,
									allowedModels: new Map(
										(workerRuntime.agentRequest.model_catalog ?? []).map((descriptor) => [
											`${descriptor.provider}/${descriptor.id}`,
											descriptor,
										]),
									),
								}
							: undefined,
						agentRequest: workerRuntime.agentRequest,
						runtimeBinding: workerRuntime.agentRequest?.runtime_binding,
						authContext: opts.authContext,
						primeDaemonHostSocket: workerRuntime.primeDaemonHostSocket,
						primeDaemonHostDir: workerRuntime.primeDaemonHostDir,
					};
					active.spawnSpanContext = spawnSpan.spanContext();
					this.active.set(sandboxId, active);
					// Close/exit can race the awaited durable body bind. Install both
					// observers immediately and let monitorExit serialize behind
					// active.spawnBinding before deciding whether an Agent body existed.
					this.monitorOutput(sandboxId, child, active);
					this.monitorExit(sandboxId, child, cgroupPath);

					// Handle spawn event — assign cgroup and transition to running
					await new Promise<void>((resolveSpawn, rejectSpawn) => {
						child.once("spawn", () => {
							const binding = (async () => {
								const pid = child.pid!;
								spawnSpan.setAttribute("sandbox.pid", pid);

								// The pre-exec launcher moved this PID before bwrap could
								// create a user namespace; descendants inherit membership.
								if (cgroupPath) execSpan.setAttribute("sandbox.cgroup_preassigned", true);
								await opts.onProcessSpawn?.({ sandboxId, pid });
								active.bodyBound = true;

								// Batch: set PID + transition to running
								const updated = this.store.transitionToRunning(sandboxId, pid);
								active.record = updated;
								if (workerRuntime.isAgentRun) {
									active.agentRunStartedAt = performance.now();
									agentRunsTotal.add(1, { template: opts.template, medium: "conversation" });
								}

								// Record spawn metrics
								const spawnDuration = (performance.now() - spawnStartTime) / 1000;
								spawnDurationSeconds.record(spawnDuration, { template: opts.template });
								spawnsTotal.add(1, { template: opts.template });
								activeSandboxes.add(1, { template: opts.template });
								emitCaptureSoft(this.capture, {
									kind: "sandbox.spawn",
									...active.captureIdentity,
									outcome: "ok",
									durationMs: Math.max(0, Math.round(spawnDuration * 1_000)),
									payload: { template: opts.template, sandboxId },
								});

								console.error(
									`[spawner] sandbox ${sandboxId}: running (PID ${pid}, template=${opts.template}, mode=${this.sandboxMode})`,
								);
								this.emitBusEvent({
									category: "lifecycle",
									type: "running",
									sandbox_id: sandboxId,
									ts: new Date().toISOString(),
									pid,
								});
								void this.activateAgentSessionFamilyProjection(sandboxId).catch((error) => {
									console.error(
										`[workflow] active family projection failed for ${sandboxId}: ${String(error)}`,
									);
								});
								execSpan.end();
								resolveSpawn();
							})();
							active.spawnBinding = binding;
							binding.catch((err) => {
								execSpan.recordException(err as Error);
								execSpan.setStatus({ code: SpanStatusCode.ERROR });
								execSpan.end();
								rejectSpawn(err);
							});
						});

						child.once("error", (err) => {
							// No `spawn` event means no OS body and no durable body bind.
							// The outer cleanup path waits for close before removing the
							// unbound ActiveSandbox identity.
							spawnErrorsTotal.add(1, { template: opts.template });
							execSpan.recordException(err);
							execSpan.setStatus({ code: SpanStatusCode.ERROR });
							execSpan.end();
							rejectSpawn(err);
						});
					});

					// 5. Send init message with worker config
					tracer.startActiveSpan("sandbox.spawn.send_init", (initSpan) => {
						try {
							child.stdin!.on("error", () => {}); // swallow EPIPE if child exits early
							child.stdin!.write(`${JSON.stringify(workerRuntime.initMessage)}\n`);
							if (!workerRuntime.keepStdinOpen) {
								child.stdin!.end();
							}
						} catch {
							// child may have exited between spawn and init write
						}
						initSpan.end();
					});
					if (workerRuntime.isAgentRun && active.agentRequest?.await_initial_command !== true) {
						void this.trackSupervisorTask(
							this.drainAgentSessionCommands(sandboxId).catch((error) => {
								console.error(`[commands] initial drain failed for ${sandboxId}: ${String(error)}`);
							}),
						);
					}

					// 6. Set wall-clock timeout (output/exit observers were installed
					// before the post-spawn bind so no fast exit can escape them).
					const timeoutMs = opts.timeout_ms ?? this.defaultTimeoutMs;
					active.timeout = setTimeout(() => {
						console.error(`[spawner] sandbox ${sandboxId}: timeout after ${timeoutMs}ms`);
						void this.killProcess(sandboxId, "timeout").catch((error) => {
							console.error(
								`[spawner] verified timeout reap deferred for ${sandboxId}: ${boundedInferenceFailure(error)}`,
							);
							this.wakeDurableSupervision();
						});
					}, timeoutMs);
				});

				spawnSpan.end();
			} catch (err) {
				const errorMessage = (err as Error).message;
				const active = this.active.get(sandboxId);
				let cleanupFailure: unknown;
				if (active) {
					if (active.timeout) clearTimeout(active.timeout);
					if (active.bodyBound === false) active.durableSupervisorExit = true;
					try {
						if (active.bodyBound === false && active.process.pid === undefined && active.exitDone) {
							const closed = await Promise.race([
								active.exitDone.then(() => true),
								new Promise<false>((resolveTimeout) =>
									setTimeout(() => resolveTimeout(false), this.exitCleanupGraceMs),
								),
							]);
							if (!closed || this.active.get(sandboxId) === active) {
								throw new SandboxCleanupUnavailable(
									`Sandbox ${sandboxId} launch failed before spawn and close cleanup was not observed`,
								);
							}
						} else {
							await this.killProcess(sandboxId, "killed");
						}
					} catch (cleanupError) {
						cleanupFailure = cleanupError;
					}
				}
				if (cleanupFailure !== undefined) {
					const unavailable = new SandboxCleanupUnavailable(
						`Sandbox ${sandboxId} launch failed and its process could not be verified reaped`,
						{ cause: cleanupFailure },
					);
					spawnSpan.recordException(unavailable);
					spawnSpan.setStatus({ code: SpanStatusCode.ERROR, message: unavailable.message });
					spawnSpan.end();
					throw unavailable;
				}

				const current = this.store.get(sandboxId);
				let transitionedToError = false;
				if (current && !TERMINAL_STATES_SET.has(current.state)) {
					try {
						this.store.transition(sandboxId, "error", errorMessage);
						this.store.updateErrorDetail(sandboxId, errorMessage);
						transitionedToError = true;
					} catch {
						// already in terminal state
					}
				}
				if (transitionedToError) {
					this.emitBusEvent({
						category: "lifecycle",
						type: "terminal",
						sandbox_id: sandboxId,
						ts: new Date().toISOString(),
						state: "error",
						error_detail: errorMessage,
					});
				}
				await closeCapabilityRegistry(workerRuntime?.capabilityRegistry).catch(() => {});
				cleanupPrimeDaemonDir(workerRuntime?.primeDaemonHostDir);
				spawnErrorsTotal.add(1, { template: opts.template });
				spawnSpan.recordException(err as Error);
				spawnSpan.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
				spawnSpan.end();
				throw err;
			}
		});
	}

	private async killProcess(sandboxId: string, reason: "killed" | "timeout"): Promise<SandboxRecord> {
		return tracer.startActiveSpan(
			"sandbox.kill",
			{
				links: this.active.get(sandboxId)?.spawnSpanContext
					? [{ context: this.active.get(sandboxId)!.spawnSpanContext! }]
					: [],
			},
			async (killSpan) => {
				killSpan.setAttributes({
					"sandbox.id": sandboxId,
					"sandbox.kill.reason": reason,
				});

				const active = this.active.get(sandboxId);
				if (!active) {
					const record = this.store.get(sandboxId);
					killSpan.end();
					if (!record) throw new SandboxCleanupUnavailable(`Sandbox ${sandboxId} has no cleanup identity`);
					if (!TERMINAL_STATES_SET.has(record.state)) {
						throw new SandboxCleanupUnavailable(
							`Sandbox ${sandboxId} has no active process and no observed terminal state (${record.state})`,
						);
					}
					return record;
				}

				killsTotal.add(1, {
					template: active.record.template,
					reason,
				});

				// Mark the intended terminal state so the exit handler uses it
				// monitorExit will read usage and write it in one transaction
				active.pendingTerminalState = reason;

				// Clear timeout
				if (active.timeout) {
					clearTimeout(active.timeout);
					active.timeout = undefined;
				}

				const child = active.process;
				// A worker may be blocked in a kernel/capability bridge request whose
				// Promise is part of monitorExit's durable line-work barrier. Cancel
				// those host calls before signalling the worker so cleanup cannot
				// deadlock waiting on an independent leased kernel operation.
				this.closeActiveHostWorkAdmission(active, new Error(`Sandbox ${sandboxId} is terminating`));

				// SIGTERM first
				const sigtermSpan = tracer.startSpan("sandbox.kill.sigterm");
				try {
					child.kill("SIGTERM");
				} catch (error) {
					if (child.exitCode === null && child.signalCode === null) {
						active.pendingTerminalState = undefined;
						killSpan.end();
						throw new SandboxCleanupUnavailable(
							`Sandbox ${sandboxId} rejected SIGTERM: ${boundedInferenceFailure(error)}`,
							{ cause: error },
						);
					}
				}

				// Wait up to 5 seconds for graceful exit
				const exited = await new Promise<boolean>((resolve) => {
					if (child.exitCode !== null || child.signalCode !== null) {
						resolve(true);
						return;
					}
					const timer = setTimeout(() => resolve(false), this.killTermGraceMs);
					child.once("exit", () => {
						clearTimeout(timer);
						resolve(true);
					});
				});
				sigtermSpan.end();

				let physicallyExited = exited;
				if (!physicallyExited) {
					// Force kill
					const sigkillSpan = tracer.startSpan("sandbox.kill.sigkill");
					try {
						child.kill("SIGKILL");
					} catch (error) {
						if (child.exitCode === null && child.signalCode === null) {
							active.pendingTerminalState = undefined;
							sigkillSpan.end();
							killSpan.end();
							throw new SandboxCleanupUnavailable(
								`Sandbox ${sandboxId} rejected SIGKILL: ${boundedInferenceFailure(error)}`,
								{ cause: error },
							);
						}
					}
					physicallyExited = await new Promise<boolean>((resolve) => {
						if (child.exitCode !== null || child.signalCode !== null) {
							resolve(true);
							return;
						}
						const timer = setTimeout(() => resolve(false), this.killForceGraceMs);
						child.once("exit", () => {
							clearTimeout(timer);
							resolve(true);
						});
					});
					sigkillSpan.end();
				}
				if (!physicallyExited) {
					active.pendingTerminalState = undefined;
					killSpan.setStatus({ code: SpanStatusCode.ERROR, message: "physical exit was not observed" });
					killSpan.end();
					throw new SandboxCleanupUnavailable(`Sandbox ${sandboxId} did not exit after SIGTERM and SIGKILL`);
				}

				// Wait for monitorExit's async close handler to finish cleanup
				let exitCleanupFinished = false;
				if (active.exitCleanupError !== undefined) {
					await this.retryObservedExitCleanup(sandboxId, active);
					exitCleanupFinished = true;
				} else if (active.exitDone) {
					try {
						exitCleanupFinished = await Promise.race([
							active.exitDone.then(() => true),
							new Promise<false>((resolve) => setTimeout(() => resolve(false), this.exitCleanupGraceMs)),
						]);
					} catch (error) {
						throw new SandboxCleanupUnavailable(`Sandbox ${sandboxId} exited but its terminal cleanup failed`, {
							cause: error,
						});
					}
				} else if (this.active.has(sandboxId)) {
					exitCleanupFinished = await new Promise<boolean>((resolve) => {
						const timer = setTimeout(() => resolve(false), this.exitCleanupGraceMs);
						child.once("close", () => {
							clearTimeout(timer);
							setTimeout(() => resolve(true), 50);
						});
					});
				} else {
					exitCleanupFinished = true;
				}

				// Physical exit alone is insufficient: monitorExit owns terminal body
				// testimony and capability/cgroup cleanup. Keep the body identifiable
				// and fail the caller when that barrier did not finish.
				if (!exitCleanupFinished || this.active.has(sandboxId)) {
					killSpan.setStatus({ code: SpanStatusCode.ERROR, message: "exit cleanup was not observed" });
					killSpan.end();
					throw new SandboxCleanupUnavailable(
						`Sandbox ${sandboxId} exited but its terminal cleanup did not finish`,
					);
				}

				killSpan.setAttribute("sandbox.kill.graceful_exit", exited);
				killSpan.end();
				return this.store.get(sandboxId)!;
			},
		);
	}

	private async retryObservedExitCleanup(sandboxId: string, active: ActiveSandbox): Promise<void> {
		if (active.process.exitCode === null && active.process.signalCode === null) {
			throw new SandboxCleanupUnavailable(`Sandbox ${sandboxId} cleanup retry has no observed process exit`);
		}
		await this.reapPairedKernelForUnexpectedWorkerExit(active);
		while (active.workerLineRequests?.size) {
			await Promise.allSettled([...active.workerLineRequests]);
		}
		await closeCapabilityRegistry(active.capabilityRegistry).catch(() => {});
		if (active.cgroupPath) await removeSandboxCgroup(active.cgroupPath);
		// Agent materialization/body testimony follows verified cgroup-empty. A
		// recoverable root must not reopen generation N+1 while descendants of the
		// old process remain in its retained cgroup.
		await this.recordDurableAgentBodyExit(active, active.process.exitCode);
		if (this.active.get(sandboxId) === active) this.active.delete(sandboxId);
		active.exitCleanupError = undefined;
		active.exitDone = Promise.resolve();
	}

	private closeActiveHostWorkAdmission(active: ActiveSandbox, reason: Error): void {
		active.hostWorkAdmissionClosed = true;
		for (const controller of active.bridgeAbortControllers?.values() ?? []) {
			if (!controller.signal.aborted) controller.abort(reason);
		}
	}

	private async reapPairedKernelForUnexpectedWorkerExit(active: ActiveSandbox | undefined): Promise<void> {
		if (
			!this.workflowRuntime ||
			!active?.isAgentRun ||
			!active.agentRequest ||
			active.bodyBound === false ||
			active.agentRequest.runtime_binding.kind !== "prime"
		) {
			return;
		}
		if (active.hostWorkAdmissionClosed) return;
		active.unexpectedWorkerExit = true;
		this.closeActiveHostWorkAdmission(active, new Error("Prime worker exited unexpectedly"));
		const request = active.agentRequest;
		const materialization = await this.workflowRuntime.readAgentMaterialization(
			request.session_id,
			request.generation,
		);
		if (
			!materialization ||
			materialization.sandbox_id !== active.record.sandbox_id ||
			(materialization.state !== "claimed" && materialization.state !== "running")
		) {
			return;
		}
		const kernel = this.executionService.getLeaseForSession(request.session_id);
		if (kernel) this.restoredKernelLeases.delete(kernel.leaseId);
		// Kernel termination rejects the blocked cell/bridge request that may be in
		// workerLineRequests. It must therefore precede that line-work barrier.
		await this.executionService.reapSessionAcquisition(
			request.session_id,
			request.generation,
			materialization.activation_id,
			"faulted",
		);
	}

	private monitorOutput(sandboxId: string, child: ChildProcess, active: ActiveSandbox): void {
		if (!child.stdout) return;

		const monitorSpan = tracer.startSpan("sandbox.monitor", {
			links: active.spawnSpanContext ? [{ context: active.spawnSpanContext }] : [],
		});
		monitorSpan.setAttribute("sandbox.id", sandboxId);

		let heartbeatCount = 0;
		const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
		rl.on("line", (line) => {
			const pending = active.workerLineRequests ?? new Set<Promise<void>>();
			active.workerLineRequests = pending;
			let request!: Promise<void>;
			request = this.handleWorkerLine({
				sandboxId,
				line,
				child,
				active,
				monitorSpan,
				onHeartbeat: () => {
					heartbeatCount++;
				},
			})
				.catch((error) => {
					console.error(`[sandbox ${sandboxId.slice(0, 8)}] worker line failed: ${String(error)}`);
				})
				.finally(() => {
					pending.delete(request);
					this.workerLineRequests.delete(request);
				});
			pending.add(request);
			this.workerLineRequests.add(request);
		});

		rl.on("close", () => {
			monitorSpan.setAttribute("sandbox.monitor.heartbeat_count", heartbeatCount);
			monitorSpan.end();
		});

		if (child.stderr) {
			child.stderr.on("data", (chunk: Buffer) => {
				const text = chunk.toString().trim();
				if (text) {
					console.error(
						`[sandbox ${sandboxId.slice(0, 8)}] stderr: content-suppressed bytes=${Buffer.byteLength(text)}`,
					);
				}
			});
		}
	}

	private async handleWorkerLine(opts: {
		sandboxId: string;
		line: string;
		child: ChildProcess;
		active: ActiveSandbox;
		monitorSpan: Span;
		onHeartbeat: () => void;
	}): Promise<void> {
		const trimmed = opts.line.trim();
		if (!trimmed) return;

		let msg:
			| WorkerMessage
			| PrimeWorkerRequestV1
			| PrimeWorkerEventV1
			| PrimeWorkerResultV1
			| PrimeCommandResultV1
			| { kind?: string; event?: any; result?: any };
		try {
			const parsed = parseNdjsonLine(opts.line);
			if (!parsed || typeof parsed !== "object") return;
			if (opts.active.isAgentRun) {
				if (!("protocol" in parsed)) {
					throw new PrimeHostProtocolFault("Prime worker emitted a non-bridge message");
				}
				const bridge = parsePrimeHostBridgeMessage(parsed);
				this.validateWorkerBridgeContext(opts.sandboxId, opts.active, bridge);
				msg = bridge as PrimeWorkerRequestV1 | PrimeWorkerEventV1 | PrimeWorkerResultV1 | PrimeCommandResultV1;
			} else {
				msg = parsed as WorkerMessage | { kind?: string; event?: any; result?: any };
			}
		} catch (error) {
			if (
				error instanceof NdjsonLineLimitError ||
				error instanceof PrimeHostProtocolFault ||
				(opts.active.isAgentRun && error instanceof SyntaxError)
			) {
				opts.active.workerTerminalState = "error";
				opts.active.workerResultFault = error.message;
				console.error(`[sandbox ${opts.sandboxId.slice(0, 8)}] ${error.message}`);
				try {
					opts.child.kill("SIGKILL");
				} catch {
					// worker may already have exited
				}
			}
			return;
		}

		switch (msg.kind) {
			case "request":
				if (msg.name === "request.cancel") {
					this.handleBridgeCancellation(msg, opts.child, opts.active);
					return;
				}
				if (msg.name === "inference.request") {
					await this.handleLlmRequest(opts.sandboxId, msg, opts.child, opts.active);
					return;
				}
				if (msg.name === "capability.request") {
					await this.trackHostRequest(
						this.handleGateCall(
							{
								kind: "gate_call",
								call_id: msg.payload.requestId,
								capability: msg.payload.capability,
								tool: msg.payload.tool,
								args: msg.payload.args,
							},
							opts.child,
							opts.active,
							msg,
						),
					);
					return;
				}
				if (msg.name === "kernel.request") {
					await this.trackHostRequest(this.handleKernelRequest(msg, opts.child, opts.active));
				}
				return;

			case "event":
				if ("protocol" in msg) {
					await this.handlePrimeWorkerEvent(opts.sandboxId, msg, opts.active, opts.monitorSpan, opts.onHeartbeat);
				} else {
					if (opts.active.isKernelRun && msg.event?.type === "kernel_host_request") {
						await this.trackHostRequest(this.handleKernelHostRequest(opts.sandboxId, msg.event, opts.active));
						return;
					}
					this.handleWorkerEvent(opts.sandboxId, msg.event, opts.active, opts.monitorSpan, opts.onHeartbeat);
				}
				return;

			case "result":
				if ("protocol" in msg && msg.name === "command.result") {
					await this.handleCommandResult(msg, opts.active);
					return;
				}
				this.handleWorkerResult(
					opts.sandboxId,
					"protocol" in msg ? msg.payload.result : msg.result,
					opts.active,
					opts.monitorSpan,
				);
				return;

			case "gate_call":
				await this.trackHostRequest(this.handleGateCall(msg, opts.child, opts.active));
				return;

			case "spawn":
				this.handleSpawnRequest(msg, opts.child);
				return;

			default:
				return;
		}
	}

	private validateWorkerBridgeContext(
		sandboxId: string,
		active: ActiveSandbox,
		message: PrimeHostBridgeMessageV1,
	): void {
		const request = active.agentRequest;
		if (!request || message.direction !== "worker_to_host") {
			throw new PrimeHostProtocolFault("worker emitted a bridge message outside an agent request");
		}
		if (
			message.sandboxId !== sandboxId ||
			message.sandboxId !== request.spawn_id ||
			message.sessionId !== request.session_id ||
			message.generation !== request.generation
		) {
			throw new PrimeHostProtocolFault("worker bridge context does not match its admitted materialization", {
				expected: {
					sandboxId,
					sessionId: request.session_id,
					generation: request.generation,
				},
				actual: {
					sandboxId: message.sandboxId,
					sessionId: message.sessionId,
					generation: message.generation,
				},
			});
		}
		if (message.kind === "request" && message.correlationId !== message.payload.requestId) {
			throw new PrimeHostProtocolFault("worker bridge request correlationId must equal payload.requestId");
		}
		const expectedSequence = active.nextPrimeWorkerSequence ?? 0;
		if (message.workerSequence !== expectedSequence) {
			throw new PrimeHostProtocolFault("worker bridge sequence is not the next admitted value", {
				expected: expectedSequence,
				actual: message.workerSequence,
			});
		}
		active.nextPrimeWorkerSequence = expectedSequence + 1;
	}

	private async handlePrimeWorkerEvent(
		sandboxId: string,
		message: PrimeWorkerEventV1,
		active: ActiveSandbox,
		monitorSpan: Span,
		onHeartbeat: () => void,
	): Promise<void> {
		const request = active.agentRequest;
		if (!request) throw new PrimeHostProtocolFault("Prime event has no admitted agent request");
		if (message.name === "goal.updated" && active.goalHandoffCommandIds?.size) {
			if (!this.workflowRuntime) throw new PrimeHostProtocolFault("Goal witness has no durable runtime store");
			const handled = await this.enqueueGoalHandoff(active, async () =>
				this.workflowRuntime!.recordPrimeGoalUpdatedWitness({
					sessionId: request.session_id,
					generation: request.generation,
					activationId: request.invocation_id,
					workerSequence: message.workerSequence,
					now: Date.now(),
				}),
			);
			if (!handled) {
				throw new PrimeHostProtocolFault("Goal witness does not match a delivered mutating durable goal command");
			}
			return;
		}
		this.handleWorkerEvent(
			sandboxId,
			withPersonTurnText(primeWorkerEventToSandboxEvent(message, request), active),
			active,
			monitorSpan,
			onHeartbeat,
		);
	}

	private async enqueueGoalHandoff<T>(active: ActiveSandbox, work: () => Promise<T>): Promise<T> {
		const prior = active.goalHandoffTail ?? Promise.resolve();
		const result = prior.catch(() => undefined).then(work);
		active.goalHandoffTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private handleWorkerEvent(
		sandboxId: string,
		event: any,
		active: ActiveSandbox,
		monitorSpan: Span,
		onHeartbeat: () => void,
	): void {
		if (event?.type === "heartbeat") {
			onHeartbeat();
			if (event.iteration % 50 === 1) {
				console.error(
					`[sandbox ${sandboxId.slice(0, 8)}] heartbeat #${event.iteration} ` +
						`rss=${formatBytes(event.memory?.rss)} ` +
						`uptime=${event.uptime?.toFixed(1)}s`,
				);
			}
			return;
		}

		if (event?.type === "started") {
			monitorSpan.addEvent("worker_started", { "worker.pid": event.pid ?? 0 });
			console.error(`[sandbox ${sandboxId.slice(0, 8)}] worker started (PID ${event.pid})`);
			this.emitBusEvent({
				category: "system",
				type: "started",
				sandbox_id: sandboxId,
				ts: new Date().toISOString(),
				pid: event.pid,
			});
			return;
		}

		if (event?.type === "stdout" || event?.type === "stderr") {
			const text = typeof event.text === "string" ? event.text.trimEnd() : "";
			if (text) {
				console.error(
					`[sandbox ${sandboxId.slice(0, 8)}] ${event.type}: content-suppressed bytes=${Buffer.byteLength(text)}`,
				);
				this.emitBusEvent({
					category: "system",
					type: event.type,
					sandbox_id: sandboxId,
					ts: new Date().toISOString(),
					text,
				});
			}
			return;
		}

		if (event?.type === "progress") {
			const message = typeof event.message === "string" ? event.message : "progress";
			console.error(
				`[sandbox ${sandboxId.slice(0, 8)}] progress: content-suppressed bytes=${Buffer.byteLength(message)}`,
			);
			this.emitBusEvent({
				category: "system",
				type: "progress",
				sandbox_id: sandboxId,
				ts: new Date().toISOString(),
				message,
			});
			return;
		}

		if (active.isRuntimeRun) {
			switch (event?.type) {
				case "runtime_ready":
					console.error(`[sandbox ${sandboxId.slice(0, 8)}] runtime_ready: ${event.runtime}`);
					this.emitBusEvent({
						category: "system",
						type: "runtime_ready",
						sandbox_id: sandboxId,
						ts: new Date().toISOString(),
						runtime: event.runtime,
					});
					return;

				case "runtime_busy":
					console.error(`[sandbox ${sandboxId.slice(0, 8)}] runtime_busy: ${event.input_id}`);
					this.emitBusEvent({
						category: "system",
						type: "runtime_busy",
						sandbox_id: sandboxId,
						ts: new Date().toISOString(),
						input_id: event.input_id,
					});
					return;

				case "runtime_stdout":
				case "runtime_stderr": {
					const text = String(event.text ?? "");
					if (text) {
						console.error(`[sandbox ${sandboxId.slice(0, 8)}] ${event.type}: ${text.trimEnd()}`);
						this.emitBusEvent({
							category: "system",
							type: event.type,
							sandbox_id: sandboxId,
							ts: new Date().toISOString(),
							input_id: event.input_id,
							text,
						});
					}
					return;
				}

				case "runtime_result":
					console.error(
						`[sandbox ${sandboxId.slice(0, 8)}] runtime_result: ${event.input_id} ok=${Boolean(event.ok)}`,
					);
					this.emitBusEvent({
						category: "system",
						type: "runtime_result",
						sandbox_id: sandboxId,
						ts: new Date().toISOString(),
						input_id: event.input_id,
						ok: Boolean(event.ok),
						result: typeof event.result === "string" ? event.result : undefined,
						result_json: typeof event.result_json === "string" ? event.result_json : undefined,
						error: typeof event.error === "string" ? event.error : undefined,
					});
					return;

				case "runtime_exit":
					console.error(
						`[sandbox ${sandboxId.slice(0, 8)}] runtime_exit: ${event.runtime} code=${event.exit_code ?? "?"}`,
					);
					this.emitBusEvent({
						category: "system",
						type: "runtime_exit",
						sandbox_id: sandboxId,
						ts: new Date().toISOString(),
						runtime: event.runtime,
						exit_code: event.exit_code,
						signal: event.signal,
					});
					return;
			}

			return;
		}

		if (active.isKernelRun) {
			switch (event?.type) {
				case "kernel_ready":
					console.error(`[sandbox ${sandboxId.slice(0, 8)}] kernel_ready: ${event.kernel}`);
					this.emitBusEvent({
						category: "system",
						type: "kernel_ready",
						sandbox_id: sandboxId,
						ts: new Date().toISOString(),
						kernel: event.kernel,
					});
					return;

				case "kernel_busy":
					console.error(`[sandbox ${sandboxId.slice(0, 8)}] kernel_busy: ${event.input_id}`);
					this.emitBusEvent({
						category: "system",
						type: "kernel_busy",
						sandbox_id: sandboxId,
						ts: new Date().toISOString(),
						input_id: event.input_id,
					});
					return;

				case "kernel_idle":
					console.error(`[sandbox ${sandboxId.slice(0, 8)}] kernel_idle: ${event.input_id}`);
					this.emitBusEvent({
						category: "system",
						type: "kernel_idle",
						sandbox_id: sandboxId,
						ts: new Date().toISOString(),
						input_id: event.input_id,
					});
					return;

				case "kernel_stream": {
					const text = String(event.text ?? "");
					if (text) {
						console.error(`[sandbox ${sandboxId.slice(0, 8)}] kernel_stream[${event.name}]: ${text.trimEnd()}`);
						this.emitBusEvent({
							category: "system",
							type: "kernel_stream",
							sandbox_id: sandboxId,
							ts: new Date().toISOString(),
							input_id: event.input_id,
							name: event.name,
							text,
						});
					}
					return;
				}

				case "kernel_display":
					console.error(`[sandbox ${sandboxId.slice(0, 8)}] kernel_display: ${event.input_id}`);
					this.emitBusEvent({
						category: "system",
						type: "kernel_display",
						sandbox_id: sandboxId,
						ts: new Date().toISOString(),
						input_id: event.input_id,
						data: event.data,
						metadata: event.metadata,
					});
					return;

				case "kernel_result":
					console.error(
						`[sandbox ${sandboxId.slice(0, 8)}] kernel_result: ${event.input_id} exec_count=${event.execution_count}`,
					);
					this.emitBusEvent({
						category: "system",
						type: "kernel_result",
						sandbox_id: sandboxId,
						ts: new Date().toISOString(),
						input_id: event.input_id,
						data: event.data,
						metadata: event.metadata,
						execution_count: event.execution_count,
					});
					return;

				case "kernel_error":
					console.error(
						`[sandbox ${sandboxId.slice(0, 8)}] kernel_error: ${event.input_id} ${event.ename}: ${event.evalue}`,
					);
					this.emitBusEvent({
						category: "system",
						type: "kernel_error",
						sandbox_id: sandboxId,
						ts: new Date().toISOString(),
						input_id: event.input_id,
						ename: event.ename,
						evalue: event.evalue,
						traceback: event.traceback,
					});
					return;

				case "kernel_reply":
					console.error(
						`[sandbox ${sandboxId.slice(0, 8)}] kernel_reply: ${event.input_id} status=${event.status}`,
					);
					this.emitBusEvent({
						category: "system",
						type: "kernel_reply",
						sandbox_id: sandboxId,
						ts: new Date().toISOString(),
						input_id: event.input_id,
						status: event.status,
						execution_count: event.execution_count,
					});
					return;

				case "kernel_exit":
					console.error(
						`[sandbox ${sandboxId.slice(0, 8)}] kernel_exit: ${event.kernel} code=${event.exit_code ?? "?"}`,
					);
					this.emitBusEvent({
						category: "system",
						type: "kernel_exit",
						sandbox_id: sandboxId,
						ts: new Date().toISOString(),
						kernel: event.kernel,
						exit_code: event.exit_code,
						signal: event.signal,
					});
					return;
			}

			return;
		}

		if (!active.isAgentRun) {
			return;
		}
		if (event?.type === "prime_event") {
			try {
				if (!active.agentRequest) throw new AgentResultValidationFault("Prime event has no host request binding");
				validatePrimeSemanticEventAuthority(event, active.agentRequest);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.error(`[sandbox ${sandboxId.slice(0, 8)}] rejected Prime event: ${message}`);
				this.emitBusEvent({
					category: "agent",
					type: "error",
					sandbox_id: sandboxId,
					ts: new Date().toISOString(),
					event: { type: "error", message },
				});
				return;
			}
		}

		switch (event?.type) {
			case "turn_start":
				active.turnStartedAt = performance.now();
				active.turnToolCount = 0;
				console.error(`[sandbox ${sandboxId.slice(0, 8)}] turn_start: #${event.turn}`);
				break;

			case "text":
				console.error(
					`[sandbox ${sandboxId.slice(0, 8)}] text: content-suppressed bytes=${contentBytes(event.content)}`,
				);
				break;

			case "thinking":
				console.error(
					`[sandbox ${sandboxId.slice(0, 8)}] thinking: content-suppressed bytes=${contentBytes(event.content)}`,
				);
				break;

			case "tool_call": {
				active.turnToolCount = (active.turnToolCount ?? 0) + 1;
				const toolName = String(event.gate ?? "unknown");
				const starts = active.toolCallStarts?.get(toolName) ?? [];
				starts.push(performance.now());
				active.toolCallStarts?.set(toolName, starts);

				// Start a trace span for this tool execution
				const toolSpan = tracer.startSpan("tool.execute", {
					attributes: {
						"tool.name": toolName,
						"sandbox.template": active.record.template,
						"sandbox.id": sandboxId,
					},
				});
				const spans = active.toolCallSpans?.get(toolName) ?? [];
				spans.push(toolSpan);
				active.toolCallSpans?.set(toolName, spans);

				console.error(`[sandbox ${sandboxId.slice(0, 8)}] tool_call: ${toolName}`);
				break;
			}

			case "tool_result": {
				const toolName = String(event.gate ?? "unknown");
				const starts = active.toolCallStarts?.get(toolName);
				const start = starts?.shift();
				if (start != null) {
					toolCallDurationSeconds.record((performance.now() - start) / 1000, {
						template: active.record.template,
						tool_name: toolName,
					});
				}
				toolCallsTotal.add(1, {
					template: active.record.template,
					tool_name: toolName,
					outcome: event.is_error ? "error" : "ok",
				});

				// End the matching tool span
				const toolSpan = active.toolCallSpans?.get(toolName)?.shift();
				if (toolSpan) {
					toolSpan.setAttribute("tool.outcome", event.is_error ? "error" : "ok");
					if (event.is_error) {
						toolSpan.setStatus({ code: SpanStatusCode.ERROR, message: "tool call failed" });
					}
					toolSpan.end();
				}

				console.error(
					`[sandbox ${sandboxId.slice(0, 8)}] tool_result: ${toolName} error=${Boolean(event.is_error)}`,
				);
				// Why it failed, under the Session's id: the durable record keeps no result (metadata only, never content).
				if (event.is_error) {
					console.error(
						toolFailureLogLine({
							where: "worker",
							sessionId: active.agentRequest?.session_id,
							sandboxId,
							tool: toolName,
							result: event.result,
						}),
					);
				}
				break;
			}

			case "turn_end": {
				const turn = Number.isSafeInteger(event.turn) ? Number(event.turn) : undefined;
				emitCaptureSoft(this.capture, {
					kind: "agent.turn",
					...active.captureIdentity,
					outcome: "ok",
					durationMs:
						active.turnStartedAt === undefined
							? undefined
							: Math.max(0, Math.round(performance.now() - active.turnStartedAt)),
					payload: {
						template: active.record.template,
						sandboxId,
						stepIndex: turn === undefined ? undefined : Math.max(0, turn - 1),
						toolCount: active.turnToolCount ?? 0,
					},
				});
				active.turnStartedAt = undefined;
				active.turnToolCount = 0;
				console.error(`[sandbox ${sandboxId.slice(0, 8)}] turn_end: #${event.turn}`);
				break;
			}

			case "steer":
				console.error(
					`[sandbox ${sandboxId.slice(0, 8)}] steer: ${String(event.command_id ?? "?")} content-suppressed bytes=${contentBytes(event.text)}`,
				);
				break;

			case "prompt":
			case "follow_up":
				console.error(
					`[sandbox ${sandboxId.slice(0, 8)}] ${event.type}: ${event.command_id} ${event.text.trimEnd()}`,
				);
				break;

			case "done":
				console.error(
					`[sandbox ${sandboxId.slice(0, 8)}] done: content-suppressed bytes=${contentBytes(event.output)}`,
				);
				break;

			case "truncated":
				console.error(`[sandbox ${sandboxId.slice(0, 8)}] truncated after ${event.turns ?? "?"} turns`);
				break;

			case "error":
				console.error(`[sandbox ${sandboxId.slice(0, 8)}] agent_error: content-suppressed`);
				break;
		}

		// Emit all agent events to the bus
		if (event?.type) {
			this.emitBusEvent({
				category: "agent",
				type: event.type,
				sandbox_id: sandboxId,
				ts: new Date().toISOString(),
				event,
			});
		}
	}

	private handleWorkerResult(
		sandboxId: string,
		result: AgentSpawnResult | Record<string, unknown>,
		active: ActiveSandbox,
		monitorSpan: Span,
	): void {
		if (active.isAgentRun) {
			try {
				if (!active.agentRequest) throw new AgentResultValidationFault("agent result has no host request binding");
				validateCanonicalAgentSpawnResult(result, active.agentRequest);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				active.workerResultFault = message;
				active.workerTerminalState = "error";
				active.workerResult = {
					spawn_id: active.agentRequest?.spawn_id ?? sandboxId,
					status: "error",
					output: message,
					turns: 0,
					session_id: active.agentRequest?.session_id,
					runtime_binding_digest: active.agentRequest?.runtime_binding_digest,
					agent_ontology_binding_digest: active.agentRequest?.agent_ontology_binding_digest,
				};
				monitorSpan.addEvent("worker_result_rejected", { "worker.error": message });
				console.error(`[sandbox ${sandboxId.slice(0, 8)}] rejected result: ${message}`);
				return;
			}
		}

		const status = typeof result?.status === "string" ? result.status : "unknown";
		monitorSpan.addEvent("worker_result", { "worker.status": status });
		active.workerResult = result;

		if (active.isAgentRun) {
			active.workerTerminalState = status === "truncated" ? "truncated" : status === "error" ? "error" : "done";
			this.emitBusEvent({
				category: "agent-runtime",
				type: "materialization.result",
				sandbox_id: sandboxId,
				ts: new Date().toISOString(),
				result: result as AgentSpawnResult,
			});
		}

		console.error(`[sandbox ${sandboxId.slice(0, 8)}] result: ${status}`);
	}

	private async handleCommandResult(message: PrimeCommandResultV1, active: ActiveSandbox): Promise<void> {
		if (!this.workflowRuntime) throw new PrimeHostProtocolFault("Command result has no durable runtime store");
		const request = active.agentRequest;
		if (!request) throw new PrimeHostProtocolFault("Command result has no admitted agent request");
		const command = await this.workflowRuntime.readAgentSessionCommand(message.commandId);
		if (
			!command ||
			command.session_id !== request.session_id ||
			bridgeCommandName(command.name) !== message.payload.commandName
		) {
			throw new PrimeHostProtocolFault("Command result does not match a durable session command");
		}
		if (isPrimeGoalCommandName(command.name)) {
			const result = message.payload.result as PrimeGoalHostResponseV1 | undefined;
			const settled = await this.enqueueGoalHandoff(active, async () =>
				this.workflowRuntime!.settlePrimeGoalCommandResult({
					sessionId: request.session_id,
					generation: request.generation,
					activationId: request.invocation_id,
					workerSequence: message.workerSequence,
					commandId: message.commandId,
					commandName: command.name,
					status: message.payload.status,
					...(result === undefined ? {} : { result }),
					...(message.payload.error === undefined ? {} : { error: message.payload.error }),
					now: Date.now(),
				}),
			);
			this.emitBusEvent({
				category: "agent-runtime",
				type: "command.result",
				sandbox_id: request.spawn_id,
				ts: new Date().toISOString(),
				command_id: message.commandId,
				command_name: command.name,
				status: settled.state === "failed" ? "failed" : "completed",
				...(result === undefined ? {} : { result }),
				...(message.payload.error === undefined ? {} : { error: message.payload.error }),
			});
			active.goalHandoffCommandIds?.delete(message.commandId);
			return;
		}
		const ownsMaterializationResult = active.materializationResultCommandId === message.commandId;

		let status = message.payload.status;
		let error = message.payload.error;
		const result = message.payload.result;
		try {
			if (result) {
				validateCanonicalAgentSpawnResult(result, request);
				if (result.prime_state && !ownsMaterializationResult) {
					await this.commitResidentPrimeState(request, result.prime_state, message.commandId);
				}
			}
		} catch (cause) {
			status = "failed";
			error = cause instanceof Error ? cause.message : String(cause);
		}
		const creditRefusal = active.creditRefusal;
		if (creditRefusal && (command.name === "prompt" || command.name === "follow_up" || command.name === "steer")) {
			// A refused model call ended this command's turn quietly, so the worker reports "completed" with an
			// empty answer. The person's message was NOT answered: settle it as failed, with the coded reason.
			active.creditRefusal = undefined;
			if (status === "completed") {
				status = "failed";
				error = creditRefusal.message;
			}
		}
		await this.workflowRuntime.completeAgentSessionCommand(message.commandId, request.generation, {
			status,
			...(result ? { result } : {}),
			...(error ? { error } : {}),
			now: Date.now(),
		});
		if (command.name !== "quiesce" && !ownsMaterializationResult) {
			const session = await this.workflowRuntime.readAgentSession(request.session_id);
			if (session) {
				void this.scheduleAgentPassivation({
					sessionId: request.session_id,
					generation: request.generation,
					ownerPrincipal: session.graph_owner_principal,
					graphId: session.graph_id,
					runtimeBundleDigest: request.runtime_binding.bundle.digest,
					idleMs: request.runtime_binding.constraints.idlePassivateMs,
					runtimeKind: request.runtime_binding.kind,
				}).catch((cause) => {
					console.error(`[memory] command idle scheduling failed for ${request.session_id}: ${String(cause)}`);
				});
			}
		}
		this.emitBusEvent({
			category: "agent-runtime",
			type: "command.result",
			sandbox_id: request.spawn_id,
			ts: new Date().toISOString(),
			command_id: message.commandId,
			command_name: command.name,
			status,
			...(result ? { result } : {}),
			...(error ? { error } : {}),
		});
	}

	private async commitResidentPrimeState(
		request: AgentSpawnRequest,
		state: PrimeRuntimeStateV2,
		causationId: string,
	): Promise<void> {
		if (!this.workflowRuntime || !this.agentMemory) throw new Error("Agent memory runtime is not configured");
		const session = await this.workflowRuntime.readAgentSession(request.session_id);
		if (!session) throw new Error(`Agent session not found: ${request.session_id}`);
		const document = JSON.parse(session.document_json) as { meaningfulObjects?: { agentSession?: unknown } };
		const agentSession = document.meaningfulObjects?.agentSession;
		validateMeaningfulObjectRef(agentSession, "agent-session");
		await this.agentMemory.commitPrimeState({
			ownerPrincipal: session.graph_owner_principal,
			graphId: session.graph_id,
			agentSession: agentSession as MeaningfulObjectRefV1<"agent-session">,
			state,
			runtimeBundle: request.runtime_binding.bundle,
			causationId,
		});
	}

	private handleLlmRequest(
		sandboxId: string,
		request: Extract<PrimeWorkerRequestV1, { name: "inference.request" }>,
		child: ChildProcess,
		active: ActiveSandbox,
	): Promise<void> {
		if (this.shuttingDown || active.hostWorkAdmissionClosed) {
			this.writeInferenceResponse(
				child,
				active,
				{ type: "error", reason: "error", errorMessage: "Choreograph is shutting down", usage: ZERO_USAGE },
				request,
			);
			return Promise.resolve();
		}
		let running!: Promise<void>;
		running = this.performLlmRequest(sandboxId, request, child, active).finally(() => {
			this.inferenceRequests.delete(running);
		});
		this.inferenceRequests.add(running);
		return running;
	}

	private async performLlmRequest(
		sandboxId: string,
		request: Extract<PrimeWorkerRequestV1, { name: "inference.request" }>,
		child: ChildProcess,
		active: ActiveSandbox,
	): Promise<void> {
		const { context, model, requestId } = request.payload;
		let trustedModel: Record<string, unknown>;
		let reservation: DurableInferenceReservation;
		let selectedCredential: { apiKey: string | undefined; fundingSource: "platform" | "user" } = {
			apiKey: undefined,
			fundingSource: "platform",
		};
		try {
			if (!this.workflowRuntime || !active.agentRequest) {
				throw new Error("Agent inference requires the durable Workflow Runtime Store");
			}
			trustedModel = resolveTrustedInferenceModel(active, model);
			const admitted = active.agentRequest;
			const materialization = await this.workflowRuntime.readAgentMaterialization(
				admitted.session_id,
				admitted.generation,
			);
			if (!materialization) throw new Error("Agent inference has no durable materialization");
			const requestDigest = `sha256:${canonicalDigest({
				schema: "choreograph.agent-session-inference-request.v1",
				sessionId: admitted.session_id,
				generation: admitted.generation,
				sandboxId,
				requestId,
				model: trustedModel,
				context,
			})}`;
			const durableSession = await this.workflowRuntime.readAgentSession(admitted.session_id);
			if (!durableSession) throw new Error("Inference requires a durable session owner");
			// The Session's price is pinned in its document (a rate card from the live catalogue, or none for a legacy
			// Session that keeps the static table). Read here for the settlement; the store reads it again, in the same
			// transaction as the reservation, for the worst case and for its own re-derivation of the billing event.
			const rateCard = rateCardFromSessionDocumentJson(durableSession.document_json);
			if (rateCard && inferenceContextHasImages(context)) {
				// The card prices tokens of text and holds no price for an image, so a provider's image charge would
				// be billed by nobody. Refused before anything is reserved; a legacy Session is left as it was.
				throw new Error(
					"this Session is priced by text tokens, and an image in its context has no price on its rate card: the request is refused",
				);
			}
			if (getModelProvider(trustedModel) === "openrouter" && !getModelName(trustedModel).startsWith("mock:")) {
				selectedCredential = await selectOpenRouterCredential(
					this.openRouterKeyStore,
					durableSession.owner_user_id,
					process.env.OPENROUTER_API_KEY,
					this.openRouterUserInferenceEnabled,
				);
			}
			const workflowRuntime = this.workflowRuntime;
			const reservationInput: ReserveAgentSessionInferenceBudgetInput = {
				fundingSource: selectedCredential.fundingSource,
				generation: admitted.generation,
				activationId: materialization.activation_id,
				sandboxId,
				requestId,
				requestDigest,
				causationId: request.messageId,
				provider: getModelProvider(trustedModel),
				model: getModelName(trustedModel),
				estimatedInputTokens: estimateInferenceContextTokens(context),
				requestedOutputTokens: positiveModelInteger(trustedModel.maxTokens, 4096),
				pricingVersion: rateCard?.version ?? staticPricingVersion(),
				now: Date.now(),
			};
			// Door B of the credit gate: the person's balance is a second cost ceiling on the reservation,
			// never a check of the unclamped worst case. Without a gate this is the reservation as it was.
			const reserved = this.creditGate
				? await this.creditGate.admitCall(
						{
							userId: durableSession.owner_user_id,
							provider: reservationInput.provider,
							model: reservationInput.model,
							fundingSource: selectedCredential.fundingSource,
							sessionId: admitted.session_id,
							estimatedInputTokens: reservationInput.estimatedInputTokens,
							requestedOutputTokens: reservationInput.requestedOutputTokens,
							// The card the reservation (and the settlement) price with: what a refusal and a
							// would-be verdict quote, so the gate and the host cannot name two prices for a call.
							...(rateCard ? { rateCard } : {}),
						},
						(credit) =>
							workflowRuntime.reserveAgentSessionInferenceBudget(admitted.session_id, {
								...reservationInput,
								...(credit.ceilingCostUsdMicros === undefined
									? {}
									: {
											creditCeilingCostUsdMicros: credit.ceilingCostUsdMicros,
											creditEnforce: credit.enforce,
										}),
							}),
					)
				: await workflowRuntime.reserveAgentSessionInferenceBudget(admitted.session_id, reservationInput);
			if (!reserved.applied) {
				throw new Error(`Inference request ${requestId} was already durably admitted`);
			}
			trustedModel = { ...trustedModel, maxTokens: reserved.maxOutputTokens };
			if (getModelProvider(trustedModel) === "openrouter") {
				// Never charged more than the card, and kept to one provider (price-gap, 2026-10-01): Pi sends
				// compat.openRouterRouting as the request's provider preferences. Every call, card or not, asks only
				// for endpoints that support what it sends, its tools first (DESIGN-empowered-chat §11.3).
				const compat =
					typeof trustedModel.compat === "object" && trustedModel.compat !== null ? trustedModel.compat : {};
				trustedModel = {
					...trustedModel,
					compat: {
						...compat,
						openRouterRouting: rateCard ? openRouterRoutingForRateCard(rateCard) : OPENROUTER_TOOL_ROUTING,
					},
				};
			}
			reservation = {
				operationId: reserved.reservation.operation_id,
				fundingSource: reserved.reservation.funding_source,
				...(rateCard ? { rateCard } : {}),
				billingProvenance: reserved.billingProvenance,
				fence: {
					generation: admitted.generation,
					activationId: materialization.activation_id,
					sandboxId,
					requestId,
					requestDigest,
				},
			};
			void this.wakeAgentSessionFamilyProjection();
		} catch (error) {
			if (error instanceof InsufficientCreditError) await this.surfaceCreditRefusal(active, error);
			this.writeInferenceResponse(
				child,
				active,
				{
					type: "error",
					reason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					usage: ZERO_USAGE,
				},
				request,
			);
			return;
		}
		const modelName = getModelName(trustedModel);
		const providerName = getModelProvider(trustedModel);
		const toolCount = Array.isArray((context as any)?.tools) ? (context as any).tools.length : 0;

		return tracer.startActiveSpan(
			"llm.request",
			{
				attributes: {
					"llm.model": modelName,
					"llm.provider": providerName,
					"llm.tool_count": toolCount,
					"llm.is_mock": modelName.startsWith("mock:"),
					"sandbox.template": active.record.template,
					"sandbox.id": sandboxId,
				},
			},
			async (llmSpan) => {
				const start = performance.now();
				const providerStartedAt = Date.now();
				let dispatchStarted = false;
				let terminalCommitted = false;

				llmRequestsTotal.add(1, {
					template: active.record.template,
					provider: providerName,
					model: modelName,
				});

				console.error(
					`[sandbox ${sandboxId.slice(0, 8)}] inference_request: provider=${providerName} model=${modelName} tools=${toolCount}`,
				);
				try {
					dispatchStarted = true;
					const proxyOptions = {
						...(providerName === "openrouter" ? { apiKey: selectedCredential.apiKey } : {}),
						referer: process.env.OPENROUTER_HTTP_REFERER ?? process.env.OPENROUTER_HTTP_REFERER_URL,
						title: process.env.OPENROUTER_TITLE ?? "Choreograph Sandbox Management Spike",
					};
					// A Session priced from a card asks OpenRouter never to charge more than the card. When no provider at
					// or under it is up, the call is retried once without the ceiling, its quantization rule kept, through
					// the usage tap, and billed at what OpenRouter reports it charged (Vera, 2026-10-01).
					const card = reservation.rateCard;
					const ceiling = (trustedModel as { compat?: { openRouterRouting?: { max_price?: unknown } } }).compat
						?.openRouterRouting?.max_price;
					let fallbackTaken = false;
					const stream = modelName.startsWith("mock:")
						? proxyMockModel(modelName, active.mockLlmState ?? { requestCount: 0 })
						: // Provider-keyed egress (CA-1 shared substrate): dispatch on the
							// model's `provider` (carried per-request), resolve its key from the
							// registry. An openrouter model is byte-identical to before; a known
							// non-openrouter model routes to its baseUrl + keyEnv; unknown → throw.
							providerName === "openrouter" && card && ceiling
							? withPriceCeilingFallback(this.llmProxy(trustedModel, context, proxyOptions), () => {
									fallbackTaken = true;
									const compat =
										typeof trustedModel.compat === "object" && trustedModel.compat !== null
											? trustedModel.compat
											: {};
									return this.llmProxy(
										{
											...trustedModel,
											compat: { ...compat, openRouterRouting: openRouterFallbackRouting(card) },
										},
										context,
										{ ...proxyOptions, tapUsage: true },
									);
								})
							: this.llmProxy(trustedModel, context, proxyOptions);

					let lastEventType = "";
					let lastReason = "";
					let terminalRecorded = false;
					let billedCostMicroUsd: number | undefined;
					for await (const event of stream) {
						lastEventType = event.type;
						if (event.type === "done") lastReason = (event as any).reason ?? "";
						if (event.type === "error") lastReason = "error";
						let outgoingEvent: ProxyAssistantMessageEvent = event;
						const firstTerminal = (event.type === "done" || event.type === "error") && !terminalRecorded;
						if (firstTerminal) {
							terminalRecorded = true;
							const terminalAt = Date.now();
							const settlement = buildInferenceSettlement({
								event,
								active,
								reservation,
								providerName,
								modelName,
								durationMs: Math.max(0, terminalAt - providerStartedAt),
								now: terminalAt,
								fallback: fallbackTaken,
							});
							billedCostMicroUsd = settlement.billingEvent.costMicroUsd;
							// A refusal of the house's call that holds for every person hides the voice (Vera, 2026-10-01).
							if (
								event.type === "error" &&
								providerName === "openrouter" &&
								selectedCredential.fundingSource === "platform" &&
								this.chatModelHealth
							) {
								const refusal = classifyOpenRouterRefusal((event as { errorMessage?: string }).errorMessage);
								if (refusal) void this.chatModelHealth.record(modelName, refusal.kind);
							}
							const settled = await this.workflowRuntime!.settleAgentSessionInferenceBudget(
								reservation.operationId,
								{
									...reservation.fence,
									now: terminalAt,
									usage: settlement.usage,
									billingEvent: settlement.billingEvent,
								},
							);
							terminalCommitted = true;
							void this.wakeAgentSessionFamilyProjection();
							const budgetViolation =
								settled.exhaustedDimensions.length === 0
									? undefined
									: `Agent runtime budget exceeded (${settled.exhaustedDimensions.join(", ")})`;
							if (budgetViolation) {
								outgoingEvent = {
									type: "error",
									reason: "error",
									errorMessage: budgetViolation,
									usage: event.usage,
								};
							} else if (
								event.type === "error" &&
								reservation.fundingSource === "platform" &&
								providerName === "openrouter" &&
								isProviderPaymentFailure(event.errorMessage)
							) {
								// The PLATFORM's provider account could not pay. That is not the person's empty
								// balance: say so, keep the raw provider text off their screen, and raise the alarm.
								const detail = event.errorMessage ?? "";
								if (this.creditGate) {
									await this.creditGate.recordProviderUnavailable({
										userId: reservation.billingProvenance.userId,
										model: modelName,
										detail,
									});
								} else {
									console.error(
										`[billing] ALARM provider_payment_failure model=${modelName} ` +
											`detail=${detail.slice(0, 120)}`,
									);
								}
								outgoingEvent = {
									type: "error",
									reason: "error",
									errorMessage: PROVIDER_UNAVAILABLE_MESSAGE,
									usage: event.usage,
								};
							}
						}
						this.writeInferenceResponse(child, active, outgoingEvent, request);
						if (firstTerminal && (event.type === "done" || event.type === "error")) {
							recordProxyUsage(
								event,
								active,
								providerName,
								modelName,
								this.capture,
								Math.max(0, Math.round(performance.now() - start)),
								reservation.rateCard,
								billedCostMicroUsd,
							);
							this.scheduleInferenceBillingOutboxDrain();
						}
					}
					if (!terminalCommitted) throw new Error("Inference stream ended without a terminal event");
					llmSpan.addEvent("llm.complete", {
						"llm.last_event": lastEventType,
						"llm.reason": lastReason,
					});
					llmSpan.setStatus({ code: SpanStatusCode.OK });

					const elapsed = ((performance.now() - start) / 1000).toFixed(2);
					console.error(
						`[sandbox ${sandboxId.slice(0, 8)}] llm_response: model=${modelName} last=${lastEventType} reason=${lastReason} (${elapsed}s)`,
					);
				} catch (err) {
					const elapsed = ((performance.now() - start) / 1000).toFixed(2);
					console.error(
						`[sandbox ${sandboxId.slice(0, 8)}] llm_error: model=${modelName} kind=${safeErrorKind(err)} (${elapsed}s)`,
					);
					llmSpan.setStatus({
						code: SpanStatusCode.ERROR,
						message: "LLM provider request failed",
					});
					llmSpan.recordException(new Error("LLM provider request failed"));

					if (!terminalCommitted) {
						const reason = boundedInferenceFailure(err);
						try {
							if (dispatchStarted) {
								await this.workflowRuntime!.markAgentSessionInferenceBudgetIndeterminate(
									reservation.operationId,
									{ ...reservation.fence, reason, now: Date.now() },
								);
							} else {
								await this.workflowRuntime!.releaseAgentSessionInferenceBudget(reservation.operationId, {
									...reservation.fence,
									reason,
									now: Date.now(),
								});
							}
							// No debit will ever follow a released or indeterminate reservation.
							this.creditGate?.releaseHold(reservation.operationId);
							void this.wakeAgentSessionFamilyProjection();
						} catch (ledgerError) {
							const ledgerFault = `Inference ledger could not record uncertain provider completion: ${boundedInferenceFailure(ledgerError)}`;
							active.workerTerminalState = "error";
							active.workerResultFault = ledgerFault;
							try {
								child.kill("SIGKILL");
							} catch {
								// The body may already have exited; never answer without the durable fence.
							}
							return;
						}
						this.writeInferenceResponse(
							child,
							active,
							{ type: "error", reason: "error", errorMessage: reason, usage: ZERO_USAGE },
							request,
						);
					}
				} finally {
					llmRequestDurationSeconds.record((performance.now() - start) / 1000, {
						template: active.record.template,
						model: modelName,
					});
					llmSpan.end();
				}
			},
		);
	}

	/**
	 * A refused call must reach the person. The Prime worker ends a refused turn QUIETLY (no throw,
	 * `agent-loop.ts` on `stopReason: "error"`) and completes the command with an empty `done`, so the host
	 * writes the `turn.failed` itself; `handleCommandResult` then settles the running command as failed.
	 */
	private async surfaceCreditRefusal(active: ActiveSandbox, refusal: InsufficientCreditError): Promise<void> {
		active.creditRefusal = {
			message: refusal.message,
			balanceMicroUsd: refusal.balanceMicroUsd,
			requiredMicroUsd: refusal.requiredMicroUsd,
		};
		const request = active.agentRequest;
		if (!request || !this.workflowRuntime) return;
		try {
			const materialization = await this.workflowRuntime.readAgentMaterialization(
				request.session_id,
				request.generation,
			);
			if (!materialization) return;
			await this.workflowRuntime.appendAgentSessionEventForGeneration(
				request.session_id,
				request.generation,
				materialization.activation_id,
				{
					type: "turn.failed",
					ts: Date.now(),
					payload: {
						schema: AGENT_SESSION_SEMANTIC_EVENT_SCHEMA,
						sourceType: "host.credit_gate",
						value: {
							message: refusal.message,
							code: INSUFFICIENT_CREDIT_CODE,
							balanceMicroUsd: refusal.balanceMicroUsd,
							requiredMicroUsd: refusal.requiredMicroUsd,
						},
						meaningfulObjects: {},
					},
				},
			);
		} catch (error) {
			console.error(`[billing] could not record the credit refusal event: ${boundedInferenceFailure(error)}`);
		}
	}

	private async restoreKernelForGeneration(
		request: Extract<PrimeWorkerRequestV1, { name: "kernel.request" }>,
		active: ActiveSandbox,
		acquired: { leaseId: string; kernelSandboxId: string; expiresAt: number },
		bootstrapCode: string,
	): Promise<{ leaseId: string; kernelSandboxId: string; expiresAt: number }> {
		if (this.restoredKernelLeases.has(acquired.leaseId)) return acquired;
		if (!this.workflowRuntime || !this.agentMemory) throw new Error("Agent memory runtime is not configured");
		const acquiredLease = this.executionService.getLease(acquired.leaseId);
		if (!acquiredLease || acquiredLease.sessionId !== request.sessionId) {
			throw new Error("Kernel restoration lost its materialization activation fence");
		}
		const activationId = acquiredLease.activationId;
		const cells = await this.workflowRuntime.listExecutionJournal(request.sessionId);
		if (cells.length === 0) {
			this.restoredKernelLeases.add(acquired.leaseId);
			return acquired;
		}
		const witness = await this.workflowRuntime.readLatestKernelReplayWitness(request.sessionId);
		if (!witness || witness.generation !== request.generation - 1) {
			throw new Error("Kernel journal has no preceding-generation namespace witness");
		}
		const head = cells.at(-1)!;
		if (head.cellDigest !== witness.journalHeadDigest)
			throw new Error("Kernel journal head differs from its witness");
		const checkpoint = await this.workflowRuntime.readLatestKernelCheckpoint(request.sessionId);
		let snapshotFailure = "no compatible snapshot";
		if (
			checkpoint &&
			checkpoint.manifest.generation === request.generation - 1 &&
			checkpoint.manifest.runtimeBundleDigest === active.agentRequest?.runtime_binding.bundle.digest &&
			checkpoint.manifest.journalHeadDigest === witness.journalHeadDigest
		) {
			try {
				const capture = await this.agentMemory.restoreKernelSnapshot(checkpoint);
				const restored = await this.executionService.restoreSnapshot(acquired.leaseId, capture);
				if (
					restored.status === "restored" &&
					JSON.stringify(restored.namespace) === JSON.stringify(witness.namespace)
				) {
					this.restoredKernelLeases.add(acquired.leaseId);
					await this.workflowRuntime.appendAgentSessionEventForGeneration(
						request.sessionId,
						request.generation,
						activationId,
						{
							type: "runtime.resumed",
							payload: { generation: request.generation, method: "snapshot", checkpoint: checkpoint.object },
						},
					);
					return acquired;
				}
				snapshotFailure = restored.reason ?? "snapshot namespace differs from the journal witness";
			} catch (error) {
				snapshotFailure = error instanceof Error ? error.message : String(error);
			}
		}

		// A generation owns at most one append-only kernel body testimony. Replacing
		// the wrapper here would terminalize that row and then attempt the illegal
		// shutdown→running rewrite in the same generation. Reset the already-leased
		// IPython namespace in place before bootstrap+journal replay instead.
		const reset = await this.executionService.execute(acquired.leaseId, "%reset -f", undefined, true);
		if (reset.status !== "ok") {
			await this.executionService.fault(acquired.leaseId);
			throw new Error("Resident kernel could not reset its namespace for journal replay");
		}
		const bootstrapped = await this.executionService.execute(acquired.leaseId, bootstrapCode, undefined, true);
		if (bootstrapped.status !== "ok") {
			await this.executionService.fault(acquired.leaseId);
			throw new Error("Fresh kernel failed its runtime bootstrap before journal replay");
		}
		const replay = await this.executionService.replayJournal(acquired.leaseId, cells, witness.namespace);
		if (replay.status !== "restored") {
			await this.workflowRuntime.appendAgentSessionEventForGeneration(
				request.sessionId,
				request.generation,
				activationId,
				{
					type: "runtime.fault",
					payload: { generation: request.generation, kind: "kernel-replay-divergence", replay, snapshotFailure },
				},
			);
			throw new Error(`Kernel journal replay diverged: ${replay.divergence?.reason ?? "unknown divergence"}`);
		}
		this.restoredKernelLeases.add(acquired.leaseId);
		await this.workflowRuntime.appendAgentSessionEventForGeneration(
			request.sessionId,
			request.generation,
			activationId,
			{
				type: "runtime.resumed",
				payload: { generation: request.generation, method: "journal", replay, snapshotFailure },
			},
		);
		return acquired;
	}

	private async handleKernelRequest(
		request: Extract<PrimeWorkerRequestV1, { name: "kernel.request" }>,
		child: ChildProcess,
		active: ActiveSandbox,
	): Promise<void> {
		if (this.shuttingDown || active.hostWorkAdmissionClosed) {
			this.writeBridgeErrorResponse(child, active, request, {
				code: "kernel_runtime_shutting_down",
				class: "unavailable",
				message: "Kernel work is unavailable during host shutdown",
				retryable: false,
			});
			return;
		}
		const admitted = active.agentRequest;
		if (!admitted?.runtime_binding.constraints.allowPersistentKernel) {
			this.writeBridgeErrorResponse(child, active, request, {
				code: "kernel_not_granted",
				class: "denied",
				message: "Persistent kernel is not granted by the runtime binding",
				retryable: false,
			});
			return;
		}
		const { operation, leaseId, code } = request.payload;
		const abortController = new AbortController();
		active.bridgeAbortControllers?.set(request.payload.requestId, abortController);
		try {
			let value: unknown;
			if (operation === "acquire") {
				const materialization = await this.workflowRuntime?.readAgentMaterialization(
					request.sessionId,
					request.generation,
				);
				if (!materialization || materialization.sandbox_id !== request.sandboxId) {
					throw new Error("Kernel acquire has no active materialization fence");
				}
				if (abortController.signal.aborted || active.hostWorkAdmissionClosed) {
					throw new Error("Kernel acquire was fenced by worker host-work shutdown");
				}
				value = await this.executionService.acquire({
					sessionId: request.sessionId,
					agentSandboxId: request.sandboxId,
					ownerUserId: active.record.owner_user_id ?? "unknown",
					generation: request.generation,
					activationId: materialization.activation_id,
				});
			} else {
				if (!leaseId) throw new Error(`Kernel ${operation} requires a lease id`);
				const lease = this.executionService.getLease(leaseId);
				if (!lease || lease.sessionId !== request.sessionId)
					throw new Error("Kernel lease does not belong to this session");
				if (operation === "execute") {
					const internal = request.payload.internal === true;
					if (request.generation > 0 && internal && !this.restoredKernelLeases.has(leaseId)) {
						const bootstrap = await this.executionService.execute(
							leaseId,
							code ?? "",
							abortController.signal,
							true,
						);
						if (bootstrap.status !== "ok") {
							value = bootstrap;
						} else {
							const restored = await this.restoreKernelForGeneration(
								request,
								active,
								{ leaseId, kernelSandboxId: lease.kernelSandboxId, expiresAt: 0 },
								code ?? "",
							);
							const finalized = await this.executionService.execute(
								restored.leaseId,
								code ?? "",
								abortController.signal,
								true,
							);
							value = {
								...finalized,
								leaseId: restored.leaseId,
								kernelSandboxId: restored.kernelSandboxId,
							};
						}
					} else {
						value = await this.executionService.execute(leaseId, code ?? "", abortController.signal, internal);
					}
				} else if (operation === "interrupt") {
					this.executionService.interrupt(leaseId);
					value = { interrupted: true };
				} else if (operation === "release") {
					value = await this.executionService.release(leaseId);
				} else {
					await this.executionService.shutdown(leaseId);
					value = { shutdown: true };
				}
			}
			this.writeBridgeResponse(child, active, request, { kind: "kernel.result", value });
		} catch (error) {
			this.writeBridgeErrorResponse(child, active, request, kernelBridgeError(error));
		} finally {
			active.bridgeAbortControllers?.delete(request.payload.requestId);
		}
	}

	/** Embody one already-claimed fire; public for deterministic local organism composition. */
	async activateAgentSessionSchedule(input: AgentSessionScheduleActivation): Promise<void> {
		if (!this.workflowRuntime || !this.agentMemory || !this.eventBus) {
			throw new AgentSessionScheduleActivationTerminalError("Scheduled activation runtime is not configured");
		}
		if (this.shuttingDown || input.signal.aborted) {
			throw input.signal.reason ?? new Error("Scheduled activation host is stopping");
		}
		if (
			input.command.command_id !== input.fire.command_id ||
			input.command.session_id !== input.fire.session_id ||
			input.command.target_generation !== input.fire.target_generation ||
			input.command.name !== input.fire.command_name
		) {
			throw new AgentSessionScheduleActivationTerminalError("Schedule fire lost its exact durable prompt command");
		}

		const command = await this.workflowRuntime.readAgentSessionCommand(input.fire.command_id);
		if (!command || command.session_id !== input.fire.session_id) {
			throw new AgentSessionScheduleActivationTerminalError("Schedule fire command vanished from durable storage");
		}
		if (command.state === "completed") return;
		if (command.state === "failed" || command.state === "cancelled" || command.state === "rejected") {
			throw new AgentSessionScheduleActivationTerminalError(
				command.error ?? `Schedule prompt settled ${command.state}`,
			);
		}

		const session = await this.workflowRuntime.readAgentSession(input.fire.session_id);
		if (!session) throw new AgentSessionScheduleActivationTerminalError("Scheduled Agent Session was not found");
		const materialization = await this.workflowRuntime.readAgentMaterialization(
			input.fire.session_id,
			input.fire.target_generation,
		);
		if (!materialization || materialization.activation_id !== input.fire.activation_id) {
			throw new AgentSessionScheduleActivationTerminalError("Schedule fire lost its materialization fence");
		}
		// Fence both the resident exact-command path and composted body path before
		// either delivery, adapter mint, or process admission.
		let scheduleGrantPolicy: HostCapabilityGrantPolicyV1 | null;
		try {
			scheduleGrantPolicy = await this.rebindCurrentScheduleGrant(session, input);
		} catch (error) {
			if (
				input.fire.grant_snapshot_digest !== null &&
				input.fire.consumer !== null &&
				input.fire.claim_token !== null &&
				error instanceof AgentSessionScheduleActivationTerminalError
			) {
				if (error.message === "schedule_grant_current_unavailable") {
					await this.workflowRuntime.recordAgentSessionScheduleFireAuthorityUnavailable({
						fireId: input.fire.fire_id,
						consumer: input.fire.consumer,
						claimToken: input.fire.claim_token,
						code: error.message,
						now: Date.now(),
					});
					throw new Error(error.message);
				}
				await this.workflowRuntime.rejectAgentSessionScheduleFireAuthority({
					fireId: input.fire.fire_id,
					consumer: input.fire.consumer,
					claimToken: input.fire.claim_token,
					outcome: "rejected",
					code: error.message,
					now: Date.now(),
				});
				return;
			}
			throw error;
		}

		if (materialization.state === "running") {
			const active = this.active.get(materialization.sandbox_id);
			if (
				!active?.isAgentRun ||
				active.agentRequest?.session_id !== input.fire.session_id ||
				active.agentRequest.generation !== input.fire.target_generation
			) {
				throw new Error("Scheduled resident body is not owned by this host");
			}
			if (command.state === "queued") {
				const delivered = await this.drainExactAgentSessionCommand(
					materialization.sandbox_id,
					input.fire.command_id,
				);
				if (!delivered) throw new Error("Scheduled resident prompt could not acquire delivery");
			}
			return;
		}
		if (materialization.state !== "claimed" || materialization.sandbox_id !== `claim:${input.fire.activation_id}`) {
			throw new AgentSessionScheduleActivationTerminalError(
				`Schedule activation cannot start from materialization ${materialization.state}`,
			);
		}

		const spec = agentNodeSpecForScheduledActivation(session, {
			generation: input.fire.target_generation,
			activationId: input.fire.activation_id,
		});
		if (Object.keys(spec.capabilities ?? {}).length > 0 && !scheduleGrantPolicy) {
			throw new AgentSessionScheduleActivationTerminalError("schedule_grant_snapshot_missing");
		}
		let boundSandboxId: string | undefined;
		let resolveBound!: (sandboxId: string) => void;
		const bound = new Promise<string>((resolveBoundPromise) => {
			resolveBound = resolveBoundPromise;
		});
		const baseRunner = makeNodeRunner({
			spawner: this,
			eventBus: this.eventBus,
			contentAuthorityAdmission: this.contentAuthorityAdmission,
			ownerUserId: session.owner_user_id,
			requireGatewayServiceAuth: this.sandboxMode !== "local-native",
			mnemosyne: {
				ownerPrincipal: session.graph_owner_principal,
				graphId: session.graph_id,
				capabilities: { reads: true, writes: true, dangerous_ops: false },
			},
			// Rebound only from the Session-pinned snapshot after a current
			// authority-graph reread; no parent proxy or ambient registry enters.
			resolveCapabilityGrantPolicy: () => scheduleGrantPolicy ?? { exactTools: { mnemosyne: [] } },
			preSpawnGate: async ({ sandboxId }) => {
				if (input.signal.aborted || this.shuttingDown) {
					throw input.signal.reason ?? new Error("Scheduled activation stopped before spawn");
				}
				const current = await this.workflowRuntime!.readAgentMaterialization(
					input.fire.session_id,
					input.fire.target_generation,
				);
				if (
					!current ||
					current.activation_id !== input.fire.activation_id ||
					current.state !== "claimed" ||
					current.sandbox_id !== `claim:${input.fire.activation_id}`
				) {
					throw new Error("Scheduled activation lost its pre-spawn reservation");
				}
				if (!sandboxId) throw new Error("Scheduled activation has no sandbox identity");
			},
			onProcessSpawn: async ({ sandboxId }) => {
				if (input.signal.aborted || this.shuttingDown) {
					throw input.signal.reason ?? new Error("Scheduled activation stopped before durable bind");
				}
				await this.workflowRuntime!.bindAgentSandbox(input.fire.session_id, {
					sandboxId,
					generation: input.fire.target_generation,
					activationId: input.fire.activation_id,
					now: Date.now(),
				});
				boundSandboxId = sandboxId;
				resolveBound(sandboxId);
				void this.refreshAgentSessionFamily(input.fire.session_id, sandboxId);
			},
			onEvent: async ({ event }) => {
				if ("category" in event && event.category === "execution" && event.type === "compute.cell") return;
				const semanticEvent = mirrorAgentSessionEvent(event, spec);
				if (!semanticEvent) return;
				await this.workflowRuntime!.appendAgentSessionEventForGeneration(
					input.fire.session_id,
					input.fire.target_generation,
					input.fire.activation_id,
					semanticEvent,
				);
			},
		});
		const runner = makeRuntimeNodeRunner({
			runtime: this.workflowRuntime,
			memory: this.agentMemory,
			baseRunner,
			contentAuthorityAdmission: this.contentAuthorityAdmission,
			runId: session.run_id,
			workflowName: session.workflow_name,
			graphId: session.graph_id,
			ownerUserId: session.owner_user_id,
			graphOwnerPrincipal: session.graph_owner_principal,
			preserveMaterializationOnActivationFailure: true,
			onDurableSessionTransition: async () => {
				const current = await this.workflowRuntime!.readAgentMaterialization(
					input.fire.session_id,
					input.fire.target_generation,
				);
				if (current) await this.refreshAgentSessionFamily(input.fire.session_id, current.sandbox_id);
			},
			onIdle: () =>
				this.scheduleAgentPassivation({
					sessionId: input.fire.session_id,
					generation: input.fire.target_generation,
					ownerPrincipal: session.graph_owner_principal,
					graphId: session.graph_id,
					runtimeBundleDigest: spec.runtime!.bundle.digest,
					idleMs: spec.runtime!.constraints.idlePassivateMs,
					runtimeKind: spec.runtime!.kind,
				}),
		});

		let abortCleanup: Promise<void> | undefined;
		const cleanupBoundBody = (): Promise<void> => {
			if (!boundSandboxId) return Promise.resolve();
			abortCleanup ??= this.reapAgentSessionBodiesWithoutSettlement(
				input.fire.session_id,
				input.fire.target_generation,
			);
			return abortCleanup;
		};
		const abort = (): void => {
			void cleanupBoundBody().catch(() => undefined);
		};
		input.signal.addEventListener("abort", abort, { once: true });
		const execution = runner(spec);
		try {
			const sandboxId = await Promise.race([
				bound,
				execution.then(() => {
					throw new Error("Scheduled materialization returned before its durable body bind");
				}),
			]);
			if (input.signal.aborted || this.shuttingDown) {
				throw input.signal.reason ?? new Error("Scheduled activation stopped after durable bind");
			}
			const delivered = await this.drainExactAgentSessionCommand(sandboxId, input.fire.command_id);
			if (!delivered) {
				const current = await this.workflowRuntime.readAgentSessionCommand(input.fire.command_id);
				if (current?.state !== "delivered" && current?.state !== "completed") {
					throw new Error("Scheduled prompt did not acquire its exact materialization");
				}
			}
			await execution;
		} catch (error) {
			await cleanupBoundBody().catch(() => undefined);
			throw error;
		} finally {
			input.signal.removeEventListener("abort", abort);
			await abortCleanup;
		}
	}

	/** Embody one leased queued command whose target Prime was already composted. */
	async activateAgentSessionCommand(input: AgentSessionCommandActivation): Promise<void> {
		if (!this.workflowRuntime || !this.agentMemory || !this.eventBus) {
			throw new AgentSessionCommandActivationTerminalError("Command activation runtime is not configured");
		}
		if (this.shuttingDown || input.signal.aborted) {
			throw input.signal.reason ?? new Error("Command activation host is stopping");
		}
		if (
			input.command.command_id !== input.activation.command_id ||
			input.command.session_id !== input.activation.session_id ||
			input.command.target_generation > input.activation.target_generation ||
			(input.command.name !== "prompt" &&
				input.command.name !== "follow_up" &&
				input.command.name !== "steer" &&
				!isPrimeGoalCommandName(input.command.name))
		) {
			throw new AgentSessionCommandActivationTerminalError("Command activation lost its exact durable command");
		}
		const durableCommand = await this.workflowRuntime.readAgentSessionCommand(input.command.command_id);
		if (!durableCommand || durableCommand.session_id !== input.activation.session_id) {
			throw new AgentSessionCommandActivationTerminalError("Command activation command vanished");
		}
		if (durableCommand.state === "completed") return;
		if (["failed", "cancelled", "rejected"].includes(durableCommand.state)) {
			throw new AgentSessionCommandActivationTerminalError(
				durableCommand.error ?? `Command settled ${durableCommand.state}`,
			);
		}
		const session = await this.workflowRuntime.readAgentSession(input.activation.session_id);
		if (!session) throw new AgentSessionCommandActivationTerminalError("Command activation Session was not found");
		const materialization = await this.workflowRuntime.readAgentMaterialization(
			input.activation.session_id,
			input.activation.target_generation,
		);
		if (
			!materialization ||
			materialization.activation_id !== input.activation.activation_id ||
			materialization.state !== "claimed" ||
			materialization.sandbox_id !== `claim:${input.activation.activation_id}`
		) {
			throw new AgentSessionCommandActivationTerminalError(
				"Command activation lost its exact unembodied materialization",
			);
		}

		const grantPolicy = await this.rebindCurrentCommandActivationGrant(session, input);
		const spec = agentNodeSpecForCommandActivation(session, {
			generation: input.activation.target_generation,
			activationId: input.activation.activation_id,
		});
		if ((Object.keys(spec.capabilities ?? {}).length > 0 || (spec.includeTools?.length ?? 0) > 0) && !grantPolicy) {
			await this.workflowRuntime.rejectAgentSessionCommandActivationAuthority({
				commandId: input.activation.command_id,
				consumer: requiredCommandActivationCoordinate(input.activation.consumer, "consumer"),
				claimToken: requiredCommandActivationCoordinate(input.activation.claim_token, "claim token"),
				code: "command_activation_grant_snapshot_missing",
				now: Date.now(),
			});
			throw new AgentSessionCommandActivationTerminalError("command_activation_grant_snapshot_missing");
		}

		let boundSandboxId: string | undefined;
		let resolveBound!: (sandboxId: string) => void;
		const bound = new Promise<string>((resolveBoundPromise) => {
			resolveBound = resolveBoundPromise;
		});
		const baseRunner = makeNodeRunner({
			spawner: this,
			eventBus: this.eventBus,
			contentAuthorityAdmission: this.contentAuthorityAdmission,
			ownerUserId: session.owner_user_id,
			requireGatewayServiceAuth: this.sandboxMode !== "local-native",
			mnemosyne: {
				ownerPrincipal: session.graph_owner_principal,
				graphId: session.graph_id,
				capabilities: { reads: true, writes: true, dangerous_ops: false },
			},
			resolveCapabilityGrantPolicy: () => grantPolicy ?? { exactTools: { mnemosyne: [] } },
			preSpawnGate: async ({ sandboxId }) => {
				if (input.signal.aborted || this.shuttingDown) {
					throw input.signal.reason ?? new Error("Command activation stopped before spawn");
				}
				const [current, command] = await Promise.all([
					this.workflowRuntime!.readAgentMaterialization(
						input.activation.session_id,
						input.activation.target_generation,
					),
					this.workflowRuntime!.readAgentSessionCommand(input.activation.command_id),
				]);
				if (
					!current ||
					current.activation_id !== input.activation.activation_id ||
					current.state !== "claimed" ||
					current.sandbox_id !== `claim:${input.activation.activation_id}` ||
					command?.state !== "queued"
				) {
					throw new Error("Command activation lost its pre-spawn reservation");
				}
				if (!sandboxId) throw new Error("Command activation has no sandbox identity");
			},
			onProcessSpawn: async ({ sandboxId }) => {
				if (input.signal.aborted || this.shuttingDown) {
					throw input.signal.reason ?? new Error("Command activation stopped before durable bind");
				}
				await this.workflowRuntime!.bindAgentSandbox(input.activation.session_id, {
					sandboxId,
					generation: input.activation.target_generation,
					activationId: input.activation.activation_id,
					now: Date.now(),
				});
				boundSandboxId = sandboxId;
				resolveBound(sandboxId);
				void this.refreshAgentSessionFamily(input.activation.session_id, sandboxId);
			},
			onEvent: async ({ event }) => {
				if ("category" in event && event.category === "execution" && event.type === "compute.cell") return;
				const semanticEvent = mirrorAgentSessionEvent(event, spec);
				if (!semanticEvent) return;
				await this.workflowRuntime!.appendAgentSessionEventForGeneration(
					input.activation.session_id,
					input.activation.target_generation,
					input.activation.activation_id,
					semanticEvent,
				);
			},
		});
		const runner = makeRuntimeNodeRunner({
			runtime: this.workflowRuntime,
			memory: this.agentMemory,
			baseRunner,
			contentAuthorityAdmission: this.contentAuthorityAdmission,
			runId: session.run_id,
			workflowName: session.workflow_name,
			graphId: session.graph_id,
			ownerUserId: session.owner_user_id,
			graphOwnerPrincipal: session.graph_owner_principal,
			preserveMaterializationOnActivationFailure: true,
			onDurableSessionTransition: async () => {
				const current = await this.workflowRuntime!.readAgentMaterialization(
					input.activation.session_id,
					input.activation.target_generation,
				);
				if (current) await this.refreshAgentSessionFamily(input.activation.session_id, current.sandbox_id);
			},
			onIdle: () =>
				this.scheduleAgentPassivation({
					sessionId: input.activation.session_id,
					generation: input.activation.target_generation,
					ownerPrincipal: session.graph_owner_principal,
					graphId: session.graph_id,
					runtimeBundleDigest: spec.runtime!.bundle.digest,
					idleMs: spec.runtime!.constraints.idlePassivateMs,
					runtimeKind: spec.runtime!.kind,
				}),
		});

		let abortCleanup: Promise<void> | undefined;
		const cleanupBoundBody = (): Promise<void> => {
			if (!boundSandboxId) return Promise.resolve();
			abortCleanup ??= this.reapAgentSessionBodiesWithoutSettlement(
				input.activation.session_id,
				input.activation.target_generation,
			);
			return abortCleanup;
		};
		const abort = (): void => {
			void cleanupBoundBody().catch(() => undefined);
		};
		input.signal.addEventListener("abort", abort, { once: true });
		const execution = runner(spec);
		try {
			const sandboxId = await Promise.race([
				bound,
				execution.then(() => {
					throw new Error("Command materialization returned before its durable body bind");
				}),
			]);
			if (input.signal.aborted || this.shuttingDown) {
				throw input.signal.reason ?? new Error("Command activation stopped after durable bind");
			}
			const delivered = await this.drainExactAgentSessionCommand(sandboxId, input.activation.command_id);
			if (!delivered) {
				const current = await this.workflowRuntime.readAgentSessionCommand(input.activation.command_id);
				if (current?.state !== "delivered" && current?.state !== "completed") {
					throw new Error("Command did not acquire its exact materialization");
				}
			}
			await execution;
		} catch (error) {
			await cleanupBoundBody().catch(() => undefined);
			throw error;
		} finally {
			input.signal.removeEventListener("abort", abort);
			await abortCleanup;
		}
	}

	private async rebindCurrentCommandActivationGrant(
		session: AgentSessionRecord,
		input: AgentSessionCommandActivation,
	): Promise<HostCapabilityGrantPolicyV1 | null> {
		if (input.activation.grant_snapshot_digest === null) return this.builtInModeCommandPolicy(session, input);
		const consumer = requiredCommandActivationCoordinate(input.activation.consumer, "consumer");
		const claimToken = requiredCommandActivationCoordinate(input.activation.claim_token, "claim token");
		const reject = async (
			code: string,
			current?: { readonly digest: string; readonly revision: string | number },
		): Promise<never> => {
			await this.workflowRuntime!.rejectAgentSessionCommandActivationAuthority({
				commandId: input.activation.command_id,
				consumer,
				claimToken,
				...(current ? { grantDigest: current.digest, revision: current.revision } : {}),
				code,
				now: Date.now(),
			});
			throw new AgentSessionCommandActivationTerminalError(code);
		};
		if (!this.currentGrantReader) return reject("command_activation_grant_reader_unavailable");
		const stored = await this.workflowRuntime!.readAgentSessionScheduleGrantBinding(
			input.activation.session_id,
			input.activation.grant_snapshot_digest,
		);
		if (!stored) return reject("command_activation_grant_snapshot_missing");
		const snapshot = stored.binding.snapshot;
		let current: Awaited<ReturnType<CurrentGrantReader["readCurrentGrant"]>>;
		try {
			current = await this.currentGrantReader.readCurrentGrant({
				grantAuthorityGraphId: snapshot.grantAuthorityGraphId,
				grantDocumentId: snapshot.grantDocumentId,
				grantAuthorityOwnerPrincipal: snapshot.grantAuthorityOwnerPrincipal,
			});
		} catch {
			await this.workflowRuntime!.recordAgentSessionCommandActivationAuthority({
				commandId: input.activation.command_id,
				consumer,
				claimToken,
				outcome: "unavailable",
				code: "command_activation_grant_current_unavailable",
				now: Date.now(),
			});
			throw new Error("command_activation_grant_current_unavailable");
		}
		let grant: AgentToolGrantV1;
		try {
			grant = parseAgentToolGrant(JSON.parse(unwrapAuthoredJsonDocument(current.canonicalBytes)) as unknown);
		} catch {
			return reject("command_activation_grant_current_malformed", current);
		}
		if (
			grantDigest(grant) !== current.digest ||
			current.digest !== snapshot.toolbelt.grantDigest ||
			grant.grantId !== snapshot.grant.grantId ||
			grant.authorityGraphId !== snapshot.grantAuthorityGraphId ||
			grant.issuedBy !== snapshot.grantAuthorityOwnerPrincipal ||
			grant.subjectAgentId !== session.agent_id
		) {
			return reject("command_activation_grant_current_mismatch", current);
		}
		try {
			assertGrantActive(grant, session.agent_id ?? "", Date.now());
		} catch {
			return reject("command_activation_grant_current_inactive", current);
		}
		let modeFence: AgentModeFenceV1 | undefined;
		try {
			modeFence = await this.rereadSessionModeFence(session);
		} catch (error) {
			if (error instanceof AgentModeError && error.code === "mode_unavailable") {
				await this.workflowRuntime!.recordAgentSessionCommandActivationAuthority({
					commandId: input.activation.command_id,
					consumer,
					claimToken,
					outcome: "unavailable",
					code: "command_activation_mode_unavailable",
					now: Date.now(),
				});
				throw new Error("command_activation_mode_unavailable");
			}
			return reject(`command_activation_${error instanceof AgentModeError ? error.code : "mode_invalid"}`, current);
		}
		await this.workflowRuntime!.recordAgentSessionCommandActivationAuthority({
			commandId: input.activation.command_id,
			consumer,
			claimToken,
			outcome: "accepted",
			grantDigest: current.digest,
			revision: current.revision,
			code: "ok",
			now: Date.now(),
		});
		const exactTools = snapshot.toolbelt.tools
			.filter((tool) => tool.available && tool.capability === "mnemosyne")
			.map((tool) => tool.name);
		return {
			exactTools: { mnemosyne: exactTools },
			toolDestructiveness: Object.fromEntries(snapshot.toolbelt.tools.map((tool) => [tool.name, tool.destructive])),
			capabilities: snapshot.toolbelt.capabilities,
			...(modeFence ? { mode: modeFence } : {}),
		};
	}

	/**
	 * A Session bound to a host built-in mode (the workspace chat Reader) has no
	 * graph grant to re-read. Its re-activation authority is the built-in mode
	 * itself, re-derived for the Session's own graph: exactly the mode's tools,
	 * under the same host gate. Any other grantless Session keeps today's
	 * behavior (null ⇒ no graph tools may be bound).
	 */
	private async builtInModeCommandPolicy(
		session: AgentSessionRecord,
		input: AgentSessionCommandActivation,
	): Promise<HostCapabilityGrantPolicyV1 | null> {
		const pinned = pinnedAgentSessionModeRef(session);
		if (!pinned) return null;
		const builtIn = builtInModeFenceForSession(pinned, session.graph_id);
		if (!builtIn) return null;
		if ("mismatch" in builtIn) {
			await this.workflowRuntime!.rejectAgentSessionCommandActivationAuthority({
				commandId: input.activation.command_id,
				consumer: requiredCommandActivationCoordinate(input.activation.consumer, "consumer"),
				claimToken: requiredCommandActivationCoordinate(input.activation.claim_token, "claim token"),
				code: "command_activation_mode_current_mismatch",
				now: Date.now(),
			});
			throw new AgentSessionCommandActivationTerminalError("command_activation_mode_current_mismatch");
		}
		// Bounded by what the Session was handed at its start and its prompt names (exam 1, finding 7).
		return {
			exactTools: {
				mnemosyne: workspaceChatGrantTools(builtIn.fence.mode.allowsTool, agentSessionIncludeTools(session)),
			},
			mode: builtIn.fence,
		};
	}

	/**
	 * Choreograph modes v1: a mode-bound Session re-reads its pinned mode from
	 * the agent's graph at every re-activation and requires the pinned digest,
	 * mirroring the current-grant reread. Unbound Sessions return undefined.
	 */
	private async rereadSessionModeFence(session: AgentSessionRecord): Promise<AgentModeFenceV1 | undefined> {
		const pinned = pinnedAgentSessionModeRef(session);
		if (!pinned) return undefined;
		// Host-owned built-in modes are re-derived from code, never read from a graph.
		const builtIn = builtInModeFenceForSession(pinned, session.graph_id);
		if (builtIn && "mismatch" in builtIn) {
			throw new AgentModeError(
				"mode_current_mismatch",
				`built-in mode <${pinned.iri}> no longer matches the digest this Session was bound to`,
			);
		}
		if (builtIn) return builtIn.fence;
		if (!this.agentModeReader) {
			throw new AgentModeError("mode_unavailable", "no agent mode reader is configured on this host");
		}
		if (!session.agent_id) throw new AgentModeError("mode_invalid", "a mode-bound Session has no agent identity");
		const mode = await rereadPinnedAgentMode(
			this.agentModeReader,
			{ graphOwnerPrincipal: session.graph_owner_principal, graphId: session.graph_id, agentId: session.agent_id },
			pinned,
		);
		return { mode, digest: pinned.digest, boundGraphId: session.graph_id };
	}

	/**
	 * F6-style live authority fence for a scheduled external-capability wake.
	 * This occurs before `makeNodeRunner` can mint a graph adapter or a body.
	 */
	private async rebindCurrentScheduleGrant(
		session: AgentSessionRecord,
		input: AgentSessionScheduleActivation,
	): Promise<HostCapabilityGrantPolicyV1 | null> {
		if (input.fire.grant_snapshot_digest === null) return null;
		if (!this.currentGrantReader) {
			throw new AgentSessionScheduleActivationTerminalError("schedule_grant_reader_unavailable");
		}
		const stored = await this.workflowRuntime!.readAgentSessionScheduleGrantBinding(
			input.fire.session_id,
			input.fire.grant_snapshot_digest,
		);
		if (!stored) throw new AgentSessionScheduleActivationTerminalError("schedule_grant_snapshot_missing");
		const snapshot = stored.binding.snapshot;
		let current: Awaited<ReturnType<CurrentGrantReader["readCurrentGrant"]>>;
		try {
			current = await this.currentGrantReader.readCurrentGrant({
				grantAuthorityGraphId: snapshot.grantAuthorityGraphId,
				grantDocumentId: snapshot.grantDocumentId,
				grantAuthorityOwnerPrincipal: snapshot.grantAuthorityOwnerPrincipal,
			});
		} catch {
			throw new AgentSessionScheduleActivationTerminalError("schedule_grant_current_unavailable");
		}
		let grant: AgentToolGrantV1;
		try {
			grant = parseAgentToolGrant(JSON.parse(unwrapAuthoredJsonDocument(current.canonicalBytes)) as unknown);
		} catch {
			throw new AgentSessionScheduleActivationTerminalError("schedule_grant_current_malformed");
		}
		if (
			grantDigest(grant) !== current.digest ||
			current.digest !== snapshot.toolbelt.grantDigest ||
			grant.grantId !== snapshot.grant.grantId ||
			grant.authorityGraphId !== snapshot.grantAuthorityGraphId ||
			grant.issuedBy !== snapshot.grantAuthorityOwnerPrincipal ||
			grant.subjectAgentId !== session.agent_id
		) {
			throw new AgentSessionScheduleActivationTerminalError("schedule_grant_current_mismatch");
		}
		try {
			assertGrantActive(grant, session.agent_id ?? "", Date.now());
		} catch {
			throw new AgentSessionScheduleActivationTerminalError("schedule_grant_current_inactive");
		}
		let modeFence: AgentModeFenceV1 | undefined;
		try {
			modeFence = await this.rereadSessionModeFence(session);
		} catch (error) {
			const code = error instanceof AgentModeError ? error.code : "mode_invalid";
			// Unavailable reuses the grant's retryable-unavailable accounting path.
			throw new AgentSessionScheduleActivationTerminalError(
				code === "mode_unavailable" ? "schedule_grant_current_unavailable" : `schedule_${code}`,
			);
		}
		if (input.fire.consumer === null || input.fire.claim_token === null) {
			throw new AgentSessionScheduleActivationTerminalError("schedule_grant_fire_lease_missing");
		}
		await this.workflowRuntime!.recordAgentSessionScheduleFireAuthorityAccepted({
			fireId: input.fire.fire_id,
			consumer: input.fire.consumer,
			claimToken: input.fire.claim_token,
			grantDigest: current.digest,
			revision: current.revision,
			now: Date.now(),
		});
		const exactTools = snapshot.toolbelt.tools
			.filter((tool) => tool.available && tool.capability === "mnemosyne")
			.map((tool) => tool.name);
		return {
			exactTools: { mnemosyne: exactTools },
			toolDestructiveness: Object.fromEntries(snapshot.toolbelt.tools.map((tool) => [tool.name, tool.destructive])),
			capabilities: snapshot.toolbelt.capabilities,
			...(modeFence ? { mode: modeFence } : {}),
		};
	}

	private async executeAgentSessionChild(input: {
		readonly claim: AgentSessionChildRunClaim;
		readonly authority: AgentSessionChildDurableAuthority;
		readonly signal: AbortSignal;
	}): Promise<AgentSessionChildExecutionResult> {
		const { claim, authority, signal } = input;
		if (!this.workflowRuntime || !this.agentMemory || !this.eventBus) {
			throw new Error("Hosted child execution requires the workflow runtime, memory, and event bus");
		}
		if (
			claim.child.owner_user_id !== authority.ownerUserId ||
			claim.child.graph_owner_principal !== authority.graphOwnerPrincipal ||
			claim.child.graph_id !== authority.graphId
		) {
			throw new Error("Claimed child escaped its durable owner or graph authority boundary");
		}
		const runtime = claim.spec.runtime;
		if (!runtime) throw new Error("Recursive child execution requires a resolved host runtime profile");
		if (
			(runtime.kind === "simple" && runtime.constraints.allowPersistentKernel) ||
			(runtime.kind === "prime" && !runtime.constraints.allowPersistentKernel)
		) {
			throw new Error(`Recursive ${runtime.kind} child has a dishonest persistent-kernel binding`);
		}
		// A child of a mode-bound Session carries the same pinned mode on its
		// ontology binding; the host gate fences it exactly like its parent.
		const childModeFence = await this.rereadSessionModeFence(claim.child);
		let spawnedSandboxId: string | undefined;
		let bodyDurablyBound = false;
		let abortReap: Promise<void> | undefined;
		const abortBody = (): void => {
			if (!spawnedSandboxId || abortReap) return;
			const sandboxId = spawnedSandboxId;
			const active = this.active.get(sandboxId);
			if (active) {
				this.closeActiveHostWorkAdmission(active, new Error("Hosted child execution was aborted"));
			}
			abortReap = (async () => {
				if (bodyDurablyBound) {
					const currentRun = await this.workflowRuntime!.readAgentSessionChildRun(claim.run.child_run_id);
					if (currentRun?.state === "cancelling") {
						await this.cancelLiveAgentMaterialization(claim.child.session_id, 0, "durable child cancellation");
					} else {
						// Host shutdown is not cancellation authority. Physically reap the
						// exact pair, but leave live durable testimony for leased recovery.
						await this.reapAgentSessionBodiesWithoutSettlement(claim.child.session_id, 0);
					}
					return;
				}
				const deadline = Date.now() + 30_000;
				while (Date.now() < deadline) {
					if (this.active.has(sandboxId)) {
						await this.killProcess(sandboxId, "killed").catch(() => undefined);
						return;
					}
					const record = this.store.get(sandboxId);
					if (!record || TERMINAL_STATES_SET.has(record.state)) return;
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
			})().catch(() => undefined);
		};
		signal.addEventListener("abort", abortBody, { once: true });
		if (signal.aborted) abortBody();

		const baseRunner = makeNodeRunner({
			spawner: this,
			eventBus: this.eventBus,
			contentAuthorityAdmission: this.contentAuthorityAdmission,
			ownerUserId: claim.child.owner_user_id,
			requireGatewayServiceAuth: this.sandboxMode !== "local-native",
			mnemosyne: {
				ownerPrincipal: authority.graphOwnerPrincipal,
				graphId: claim.child.graph_id,
				capabilities: { reads: true, writes: false, dangerous_ops: false },
			},
			// No capabilityBackends are inherited from the parent. The ordinary
			// node runner asks this spawner to mint a fresh graph proxy and fresh
			// model-catalog overlay from the durable child spec.
			resolveCapabilityGrantPolicy: (spec) => ({
				exactTools: { mnemosyne: spec.includeTools ?? [] },
				...(childModeFence ? { mode: childModeFence } : {}),
			}),
			preSpawnGate: async ({ spec, sandboxId }) => {
				spawnedSandboxId = sandboxId;
				if (!spec.sessionId) throw new Error("Child execution lost its durable Agent Session id");
				if (signal.aborted) {
					throw signal.reason ?? new Error("child execution cancelled during spawn");
				}
				// Reassert the leased launch authority without becoming a second
				// heartbeat writer. The child service serializes all renewals; the
				// post-spawn bind below provides the final atomic lease/session CAS.
				const current = await this.workflowRuntime!.readAgentSessionChildRun(claim.run.child_run_id);
				const checkedAt = Date.now();
				if (
					!current ||
					current.state !== "claimed" ||
					current.consumer !== claim.run.consumer ||
					current.claim_token !== claim.run.claim_token ||
					current.claim_expires_at === null ||
					current.claim_expires_at <= checkedAt
				) {
					throw new Error("Child launch authority is no longer current before process preparation");
				}
			},
			onProcessSpawn: async ({ spec, sandboxId }) => {
				if (!spec.sessionId) throw new Error("Child execution lost its durable Agent Session id");
				if (signal.aborted) {
					throw signal.reason ?? new Error("child execution cancelled before durable body bind");
				}
				await this.workflowRuntime!.bindAgentSandbox(spec.sessionId, {
					sandboxId,
					generation: spec.sandboxGeneration ?? 0,
					activationId: spec.invocationId ?? claim.run.child_run_id,
					childRunConsumer: claim.run.consumer!,
					childRunClaimToken: claim.run.claim_token!,
					// Bind only after the OS reports an actual process, using the current
					// clock rather than the older enqueue timestamp.
					now: Date.now(),
				});
				bodyDurablyBound = true;
				const active = this.active.get(sandboxId);
				if (!active) throw new Error("Spawned child process lost its active host identity during durable bind");
				// The leased child executor/recovery path owns body→run→Session order.
				// monitorExit still records the generic Sandbox close, but never races
				// this admitted generation into a standalone fault cascade.
				active.durableSupervisorExit = true;
				active.hostedChildRunId = claim.run.child_run_id;
				this.familyProjectionPump?.wake();
			},
			onEvent: async ({ spec, event }) => {
				if (!spec.sessionId) return;
				if ("category" in event && event.category === "execution" && event.type === "compute.cell") return;
				const semanticEvent = mirrorAgentSessionEvent(event, spec);
				if (!semanticEvent) return;
				await this.workflowRuntime!.appendAgentSessionEventForGeneration(
					spec.sessionId,
					spec.sandboxGeneration ?? 0,
					spec.invocationId ?? claim.run.child_run_id,
					semanticEvent,
				);
			},
		});
		const runner = makeRuntimeNodeRunner({
			runtime: this.workflowRuntime,
			memory: this.agentMemory,
			baseRunner,
			contentAuthorityAdmission: this.contentAuthorityAdmission,
			runId: claim.child.run_id,
			workflowName: claim.child.workflow_name,
			graphId: claim.child.graph_id,
			ownerUserId: claim.child.owner_user_id,
			graphOwnerPrincipal: authority.graphOwnerPrincipal,
			childRunLease: {
				consumer: claim.run.consumer!,
				claimToken: claim.run.claim_token!,
			},
			onIdle:
				runtime.kind === "prime"
					? (spec) => {
							if (signal.aborted || this.shuttingDown) return Promise.resolve();
							return this.scheduleAgentPassivation({
								sessionId: spec.sessionId ?? claim.child.session_id,
								generation: spec.sandboxGeneration ?? 0,
								ownerPrincipal: authority.graphOwnerPrincipal,
								graphId: claim.child.graph_id,
								runtimeBundleDigest: runtime.bundle.digest,
								idleMs: runtime.constraints.idlePassivateMs,
								runtimeKind: runtime.kind,
							});
						}
					: undefined,
		});
		let result: AgentNodeResult;
		try {
			if (signal.aborted) {
				// No body exists yet. Durable cancellation already owns and removes
				// the launch intent; host shutdown leaves it under the expiring run
				// lease for honest restart reclaim. Never invent worker testimony.
				throw signal.reason ?? new Error("child execution cancelled before spawn");
			}
			result = await runner({ ...claim.spec, sandboxGeneration: 0 });
		} catch (error) {
			if (signal.aborted) {
				abortBody();
				await abortReap;
			}
			if (runtime.kind === "simple" && !signal.aborted && bodyDurablyBound) {
				await this.finishSimpleChildMaterialization(claim.child.session_id, 0, "faulted");
			}
			throw error;
		} finally {
			signal.removeEventListener("abort", abortBody);
		}
		if (signal.aborted) {
			abortBody();
			await abortReap;
		} else if (runtime.kind === "simple") {
			await this.finishSimpleChildMaterialization(
				claim.child.session_id,
				0,
				result.state === "error" ? "faulted" : "completed",
			);
		} else {
			await this.assertResidentPrimeChildPair(claim.child.session_id, 0);
		}
		const materialization = await this.workflowRuntime.readAgentMaterialization(claim.child.session_id, 0);
		if (!materialization) throw new Error(`Child ${claim.child.session_id} lost its materialization testimony`);
		return { result, materialization };
	}

	private async cleanupAgentSessionChild(
		input: AgentSessionChildCleanupInput,
	): Promise<AgentSessionChildCleanupResult> {
		if (!this.workflowRuntime) throw new Error("Hosted child cleanup requires the workflow runtime");
		if (input.phase === "prepare_closure") {
			const materialization =
				(await this.workflowRuntime.readAgentMaterialization(
					input.materialization.session_id,
					input.materialization.generation,
				)) ?? input.materialization;
			if (["passivated", "completed", "faulted", "cancelled"].includes(materialization.state)) {
				return {
					materializationState: materialization.state as AgentSessionChildCleanupResult["materializationState"],
				};
			}
			const active = this.active.get(materialization.sandbox_id);
			if (!active?.isAgentRun || !active.agentRequest) {
				throw new AgentSessionChildCleanupUnavailable("resident child body is not owned by this host activation");
			}
			if (active.agentRequest.runtime_binding.kind === "prime") {
				await this.startPassivationTask({
					sessionId: materialization.session_id,
					generation: materialization.generation,
					ownerPrincipal: input.authority.graphOwnerPrincipal,
					graphId: input.authority.graphId,
					runtimeBundleDigest: active.agentRequest.runtime_binding.bundle.digest,
				});
				return { materializationState: "passivated", kernelState: "shutdown" };
			}
			await this.cancelLiveAgentMaterialization(
				materialization.session_id,
				materialization.generation,
				input.reason,
			);
			return { materializationState: "cancelled" };
		}

		if (input.phase === "recovery") {
			const materialization = input.claim.materialization;
			const runtimeKind = await this.readDurableAgentRuntimeKind(materialization.session_id);
			const kernelBodyExisted = input.claim.kernel_state !== null;
			if (runtimeKind === "prime" && input.claim.kernel_launch_state === null) {
				throw new AgentSessionChildCleanupUnavailable(
					"Prime recovery has no durable kernel launch authority for this generation",
				);
			}
			if (runtimeKind === "prime" && input.claim.kernel_launch_state === "bound" && !kernelBodyExisted) {
				throw new Error("Bound kernel launch lost its append-only body testimony");
			}
			if (runtimeKind === "prime" && input.claim.kernel_launch_state === "launching") {
				const kernelSandboxId = input.claim.kernel_launch_sandbox_id;
				if (!kernelSandboxId) throw new Error("Unbound kernel launch lost its cleanup sandbox identity");
				if (this.active.has(kernelSandboxId)) await this.killProcess(kernelSandboxId, "killed");
				await this.workflowRuntime.failUnboundAgentSessionKernelLaunch(
					materialization.session_id,
					materialization.generation,
					{
						activationId: materialization.activation_id,
						sandboxId: kernelSandboxId,
						now: Date.now(),
					},
				);
			}
			const active = this.active.get(materialization.sandbox_id);
			if (
				active?.isAgentRun &&
				active.agentRequest?.session_id === materialization.session_id &&
				active.agentRequest.generation === materialization.generation
			) {
				this.closeActiveHostWorkAdmission(active, new Error("Agent Session materialization recovery began"));
			}
			// Kernel bridge calls are tracked as worker-line work. Reap/detach the
			// exact kernel lease first so pending execute calls reject and the worker
			// close handler can drain instead of deadlocking on kernel idle.
			if (runtimeKind === "prime") {
				await this.executionService.reapForRecovery(materialization.session_id, materialization.generation);
			}
			if (
				active?.isAgentRun &&
				active.agentRequest?.session_id === materialization.session_id &&
				active.agentRequest.generation === materialization.generation
			) {
				active.durableSupervisorExit = true;
				await this.killProcess(materialization.sandbox_id, "killed");
			}
			if (input.terminalIntent === "completed") {
				return {
					materializationState: "completed",
					...(runtimeKind === "prime" && kernelBodyExisted ? { kernelState: "shutdown" as const } : {}),
				};
			}
			if (input.terminalIntent === "cancelled") {
				return {
					materializationState: "cancelled",
					...(runtimeKind === "prime" && kernelBodyExisted ? { kernelState: "cancelled" as const } : {}),
				};
			}
			return {
				materializationState: "faulted",
				faultKind: "worker_exit",
				recoverable: materialization.checkpoint_id !== null,
				...(runtimeKind === "prime" && kernelBodyExisted ? { kernelState: "faulted" as const } : {}),
			};
		}

		const materialization = input.claim.materialization;
		if (this.active.has(materialization.sandbox_id)) {
			throw new Error(`Closure ${input.claim.request.closure_id} still has a worker body`);
		}
		if (this.executionService.getLeaseForSession(materialization.session_id)) {
			await this.executionService.reapForRecovery(materialization.session_id, materialization.generation);
		}
		const runtimeKind = await this.readDurableAgentRuntimeKind(materialization.session_id);
		const materializationState = materialization.state as AgentSessionChildCleanupResult["materializationState"];
		return {
			materializationState,
			...(runtimeKind === "prime"
				? {
						kernelState:
							materializationState === "faulted"
								? ("faulted" as const)
								: materializationState === "cancelled"
									? ("cancelled" as const)
									: ("shutdown" as const),
					}
				: {}),
		};
	}

	private async cancelLiveAgentMaterialization(sessionId: string, generation: number, reason: string): Promise<void> {
		if (!this.workflowRuntime) throw new Error("Hosted child cancellation requires the workflow runtime");
		const materialization = await this.workflowRuntime.readAgentMaterialization(sessionId, generation);
		if (!materialization) throw new Error(`Cancellation materialization missing: ${sessionId}/${generation}`);
		if (["passivated", "completed", "faulted", "cancelled"].includes(materialization.state)) return;
		const active = this.active.get(materialization.sandbox_id);
		if (active) this.closeActiveHostWorkAdmission(active, new Error("Agent Session cancellation began"));
		// Cancel the paired kernel before waiting for the worker close. A pending
		// kernel bridge request is part of workerLineRequests; detaching this exact
		// lease rejects that call and lets monitorExit reach its durable barrier.
		const kernel = this.executionService.getLeaseForSession(sessionId);
		if (kernel) this.restoredKernelLeases.delete(kernel.leaseId);
		await this.executionService.reapSessionAcquisition(
			sessionId,
			generation,
			materialization.activation_id,
			"cancelled",
		);
		if (active) {
			active.durableSupervisorExit = true;
			await this.killProcess(materialization.sandbox_id, "killed");
		}
		const current = await this.workflowRuntime.readAgentMaterialization(sessionId, generation);
		if (
			!current ||
			current.state === "passivated" ||
			current.state === "completed" ||
			current.state === "faulted" ||
			current.state === "cancelled"
		)
			return;
		if (current.state !== "claimed" && current.state !== "running") {
			throw new Error(`Cancellation cannot finish materialization from ${current.state}`);
		}
		await this.workflowRuntime.finishAgentMaterialization(sessionId, generation, {
			activationId: current.activation_id,
			from: current.state,
			to: "cancelled",
			now: Date.now(),
		});
		console.error(`[supervisor] cancelled materialization ${sessionId}/${generation}: ${reason}`);
		this.wakeDurableSupervision();
	}

	private async reapAgentSessionBodiesWithoutSettlement(sessionId: string, generation: number): Promise<void> {
		if (!this.workflowRuntime) throw new Error("Hosted child shutdown reap requires the workflow runtime");
		const materialization = await this.workflowRuntime.readAgentMaterialization(sessionId, generation);
		if (!materialization || ["passivated", "completed", "faulted", "cancelled"].includes(materialization.state)) {
			return;
		}
		const active = this.active.get(materialization.sandbox_id);
		if (active) this.closeActiveHostWorkAdmission(active, new Error("Agent Session shutdown reap began"));
		await this.executionService.reapForRecovery(sessionId, generation);
		if (active) {
			active.durableSupervisorExit = true;
			await this.killProcess(materialization.sandbox_id, "killed");
		}
		this.wakeDurableSupervision();
	}

	private async readDurableAgentRuntimeKind(sessionId: string): Promise<"simple" | "prime"> {
		if (!this.workflowRuntime) throw new Error("Hosted child cleanup requires the workflow runtime");
		const session = await this.workflowRuntime.readAgentSession(sessionId);
		if (!session) throw new Error(`Agent Session not found: ${sessionId}`);
		const document = JSON.parse(session.document_json) as { runtime?: { kind?: unknown } };
		if (document.runtime?.kind !== "simple" && document.runtime?.kind !== "prime") {
			throw new Error(`Agent Session ${sessionId} has no durable runtime kind`);
		}
		return document.runtime.kind;
	}

	private async assertResidentPrimeChildPair(sessionId: string, generation: number): Promise<void> {
		if (!this.workflowRuntime) throw new Error("Hosted child execution requires the workflow runtime");
		const materialization = await this.workflowRuntime.readAgentMaterialization(sessionId, generation);
		if (!materialization || materialization.state !== "running") {
			throw new Error(`Prime child ${sessionId} did not retain its running worker materialization`);
		}
		const worker = this.active.get(materialization.sandbox_id);
		if (
			!worker?.isAgentRun ||
			worker.agentRequest?.session_id !== sessionId ||
			worker.agentRequest.generation !== generation ||
			worker.agentRequest.runtime_binding.kind !== "prime"
		) {
			throw new Error(`Prime child ${sessionId} has no authoritative resident worker body`);
		}
		const kernel = this.executionService.getLeaseForSession(sessionId);
		if (
			!kernel ||
			kernel.generation !== generation ||
			kernel.agentSandboxId !== materialization.sandbox_id ||
			kernel.kernelSandboxId === materialization.sandbox_id
		) {
			throw new Error(`Prime child ${sessionId} has no independently leased resident kernel body`);
		}
		if (this.sessionBodyCount(sessionId) !== 2) {
			throw new Error(`Prime child ${sessionId} did not materialize as one worker and one kernel`);
		}
	}

	private async finishSimpleChildMaterialization(
		sessionId: string,
		generation: number,
		outcome: "completed" | "faulted",
	): Promise<void> {
		if (!this.workflowRuntime) throw new Error("Hosted child execution requires the workflow runtime");
		const materialization = await this.workflowRuntime.readAgentMaterialization(sessionId, generation);
		if (!materialization) throw new Error(`Simple child ${sessionId} has no materialization to finish`);
		if (
			materialization.state !== outcome &&
			materialization.state !== "claimed" &&
			materialization.state !== "running"
		) {
			throw new Error(`Simple child ${sessionId} cannot finish ${materialization.state} as ${outcome}`);
		}

		// A Sophia host worker deliberately remains resident after emitting its
		// materialization result. That is correct for Prime, but a simple child is
		// one-shot: close its host channel only after the terminal result has been
		// validated, then wait for monitorExit to reap the actual body.
		await this.compostSimpleAgentBody(sessionId, generation, materialization.sandbox_id);
		await this.waitForAgentBodyExit(sessionId, generation);
		if (this.sessionBodyCount(sessionId) !== 0) {
			throw new Error(`Simple child ${sessionId} still has a live body at terminal settlement`);
		}
		if (materialization.state === outcome) return;
		const from = materialization.state;
		if (from !== "claimed" && from !== "running") {
			throw new Error(`Simple child ${sessionId} cannot finish from ${from}`);
		}
		await this.workflowRuntime.finishAgentMaterialization(sessionId, generation, {
			activationId: materialization.activation_id,
			from,
			to: outcome,
			...(outcome === "faulted" ? { faultKind: "worker_exit" as const, recoverable: false } : {}),
			now: Date.now(),
		});
	}

	private async compostSimpleAgentBody(sessionId: string, generation: number, sandboxId: string): Promise<void> {
		const active = this.active.get(sandboxId);
		if (!active) return;
		const request = active.agentRequest;
		if (
			active.record.sandbox_id !== sandboxId ||
			!active.isAgentRun ||
			!request ||
			request.session_id !== sessionId ||
			request.generation !== generation ||
			active.runtimeBinding?.kind !== "simple" ||
			active.runtimeBinding.constraints.allowPersistentKernel
		) {
			throw new Error(`Refusing to compost a body outside simple child ${sessionId} generation ${generation}`);
		}
		if (!active.workerResult || !active.workerTerminalState) {
			throw new Error(`Refusing to compost simple child ${sessionId} before its terminal result`);
		}

		if (active.timeout) {
			clearTimeout(active.timeout);
			active.timeout = undefined;
		}

		// Closing stdin lets the Sophia worker observe host-channel EOF and run its
		// own cleanup/finally path. Signals are bounded fallbacks only. Unlike
		// public kill(), this never sets pendingTerminalState, so monitorExit keeps
		// the already-validated done/truncated/error testimony as the sandbox state.
		try {
			active.process.stdin?.end();
		} catch {
			// The worker may have exited between the active-map fence and close.
		}
		if (await this.waitForSandboxReap(sandboxId, active, 2_000)) return;

		try {
			active.process.kill("SIGTERM");
		} catch {
			// The process may already be exiting; monitorExit remains authoritative.
		}
		if (await this.waitForSandboxReap(sandboxId, active, 5_000)) return;

		try {
			active.process.kill("SIGKILL");
		} catch {
			// The process may already be exiting; monitorExit remains authoritative.
		}
		if (await this.waitForSandboxReap(sandboxId, active, 5_000)) return;
		throw new Error(`Simple child ${sessionId} body was not reaped after terminal result`);
	}

	private async waitForSandboxReap(sandboxId: string, active: ActiveSandbox, timeoutMs: number): Promise<boolean> {
		if (this.active.get(sandboxId) !== active) return true;
		if (active.exitDone) {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const completed = await Promise.race([
				active.exitDone.then(() => true),
				new Promise<false>((resolveTimeout) => {
					timeout = setTimeout(() => resolveTimeout(false), timeoutMs);
					timeout.unref?.();
				}),
			]);
			if (timeout) clearTimeout(timeout);
			return completed && this.active.get(sandboxId) !== active;
		}
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (this.active.get(sandboxId) !== active) return true;
			await new Promise<void>((resolvePoll) => setTimeout(resolvePoll, 10));
		}
		return this.active.get(sandboxId) !== active;
	}

	private async handleKernelHostRequest(
		kernelSandboxId: string,
		event: { request_id: string; input_id: string; payload: Record<string, unknown> },
		kernelActive: ActiveSandbox,
	): Promise<void> {
		const respond = (ok: boolean, value: unknown): void => {
			const canonicalValue = ok
				? value
				: kernelHostErrorForBridge(value, (error) => {
						console.error(
							`[kernel ${kernelSandboxId.slice(0, 8)}] invalid host-error testimony: ${String(error)}`,
						);
					});
			try {
				this.executionService.recordHostRequest(kernelSandboxId, event.input_id, {
					requestId: event.request_id,
					payload: event.payload,
					ok,
					...(ok ? { result: canonicalValue } : { error: canonicalValue }),
				});
			} catch (error) {
				console.error(`[kernel ${kernelSandboxId.slice(0, 8)}] host-request testimony rejected: ${String(error)}`);
			}
			this.writeWorkerMessage(kernelActive.process, {
				kind: "kernel_host_response",
				request_id: event.request_id,
				ok,
				...(ok ? { result: canonicalValue } : { error: canonicalValue }),
			});
		};
		if (this.shuttingDown) {
			respond(false, {
				code: "kernel_host_shutting_down",
				class: "unavailable",
				message: "Kernel host work is unavailable during shutdown",
				retryable: false,
			});
			return;
		}
		const lease = this.executionService.getLeaseForKernel(kernelSandboxId);
		if (!lease) {
			respond(false, {
				code: "kernel_lease_not_found",
				class: "not_found",
				message: "Kernel has no active lease",
				retryable: false,
			});
			return;
		}
		const agentActive = this.active.get(lease.agentSandboxId);
		if (!agentActive?.isAgentRun) {
			respond(false, {
				code: "agent_materialization_unavailable",
				class: "unavailable",
				message: "Agent materialization is unavailable",
				retryable: false,
			});
			return;
		}
		if (agentActive.hostWorkAdmissionClosed) {
			respond(false, {
				code: "agent_materialization_unavailable",
				class: "unavailable",
				message: "Agent materialization is no longer accepting host work",
				retryable: false,
			});
			return;
		}
		const durableRequest =
			typeof event.payload.type === "string" &&
			(event.payload.type.startsWith("rlm_heartbeat.") || event.payload.type.startsWith("rlm."));
		if (durableRequest) {
			try {
				const [parentSession, materialization] = await Promise.all([
					this.workflowRuntime?.readAgentSession(lease.sessionId),
					this.workflowRuntime?.readAgentMaterialization(lease.sessionId, lease.generation),
				]);
				const admitted = agentActive.agentRequest;
				if (
					!parentSession ||
					!materialization ||
					materialization.generation !== lease.generation ||
					materialization.activation_id !== lease.activationId ||
					materialization.state !== "running" ||
					materialization.sandbox_id !== lease.agentSandboxId ||
					parentSession.owner_user_id !== lease.ownerUserId ||
					admitted?.session_id !== lease.sessionId ||
					admitted.generation !== lease.generation ||
					admitted.mnemosyne.graph_scope.default_graph_owner !== parentSession.graph_owner_principal ||
					admitted.mnemosyne.graph_scope.default_graph_id !== parentSession.graph_id
				) {
					respond(false, {
						code: "agent_session_generation_stale",
						class: "conflict",
						message: "Kernel host request does not belong to the active parent materialization",
						retryable: false,
					});
					return;
				}
				if (typeof event.payload.type === "string" && event.payload.type.startsWith("rlm_heartbeat.")) {
					try {
						if (!this.workflowRuntime || !this.heartbeatService) {
							throw new AgentSessionHeartbeatHostRequestFault(
								"rlm_heartbeat_unavailable",
								"unavailable",
								"Heartbeat host is unavailable",
								true,
							);
						}
						const parent: AgentSessionHeartbeatParentContext = {
							sessionId: lease.sessionId,
							generation: lease.generation,
							activationId: materialization.activation_id,
							ownerUserId: parentSession.owner_user_id,
							graphOwnerPrincipal: parentSession.graph_owner_principal,
							graphId: parentSession.graph_id,
							agentId: parentSession.agent_id,
						};
						const result = await this.heartbeatService.handle({
							requestId: event.request_id,
							payload: event.payload,
							parent,
							now: Date.now(),
						});
						respond(true, result);
					} catch (error) {
						respond(
							false,
							error instanceof AgentSessionHeartbeatHostRequestFault
								? error.structured
								: heartbeatHostError(error),
						);
					}
					return;
				}
				if (typeof event.payload.type === "string" && event.payload.type.startsWith("rlm.")) {
					try {
						if (this.shuttingDown) {
							respond(false, {
								code: "child_runtime_shutting_down",
								class: "unavailable",
								message: "Hosted child admission is shutting down",
								retryable: false,
							});
							return;
						}
						if (!this.workflowRuntime || !this.childExecutionService) {
							respond(false, {
								code: "child_runtime_unavailable",
								class: "unavailable",
								message: "Hosted child execution is not configured",
								retryable: false,
							});
							return;
						}
						const result = await this.childExecutionService.handle({
							requestId: event.request_id,
							payload: event.payload,
							parent: {
								sessionId: lease.sessionId,
								generation: lease.generation,
								activationId: materialization.activation_id,
								agentSandboxId: lease.agentSandboxId,
								ownerUserId: parentSession.owner_user_id,
								graphOwnerPrincipal: parentSession.graph_owner_principal,
								graphId: parentSession.graph_id,
							},
						});
						respond(true, result);
						this.familyProjectionPump?.wake();
					} catch (error) {
						respond(false, childHostRequestError(error));
					}
					return;
				}
			} catch (error) {
				respond(
					false,
					typeof event.payload.type === "string" && event.payload.type.startsWith("rlm_heartbeat.")
						? heartbeatHostError(error)
						: childHostRequestError(error),
				);
			}
			return;
		}
		const started = performance.now();
		try {
			const invocation = await invokeKernelHostCapability(agentActive.capabilityRegistry, event.payload);
			this.emitCapabilityCall(
				agentActive,
				{
					kind: "gate_call",
					call_id: event.request_id,
					capability: invocation.capability,
					tool: invocation.tool,
					args: invocation.args,
				},
				"ok",
				performance.now() - started,
				invocation.result,
			);
			respond(true, { result: invocation.result });
		} catch (error) {
			const outcome = capabilityFailureOutcome(error);
			const capability = typeof event.payload.capability === "string" ? event.payload.capability : "invalid";
			const tool = typeof event.payload.tool === "string" ? event.payload.tool : "invalid";
			this.emitCapabilityCall(
				agentActive,
				{
					kind: "gate_call",
					call_id: event.request_id,
					capability,
					tool,
					args: {},
				},
				outcome,
				performance.now() - started,
			);
			respond(false, capabilityBridgeError(error));
		}
	}

	private async handleGateCall(
		msg: Extract<WorkerMessage, { kind: "gate_call" }>,
		child: ChildProcess,
		active: ActiveSandbox,
		bridgeRequest?: Extract<PrimeWorkerRequestV1, { name: "capability.request" }>,
	): Promise<void> {
		const sandboxId = active.record.sandbox_id;
		const template = active.record.template;
		if (this.shuttingDown || active.hostWorkAdmissionClosed) {
			this.writeCapabilityResponse(
				child,
				active,
				msg.call_id,
				{
					code: "capability_runtime_shutting_down",
					class: "unavailable",
					message: "Capability work is unavailable during host shutdown",
					retryable: false,
				},
				true,
				bridgeRequest,
			);
			return;
		}
		const registry = active.capabilityRegistry;
		const abortController = bridgeRequest ? new AbortController() : undefined;
		if (bridgeRequest && abortController) {
			active.bridgeAbortControllers?.set(bridgeRequest.payload.requestId, abortController);
		}

		// Look up the capability backend by name (Contract B / Slice 3 promoted envelope).
		// No special-casing beyond the lookup — __list_tools / callTool are unified here.
		const backend = registry?.get(msg.capability);
		if (!backend) {
			gateCallsTotal.add(1, { template, gate: `${msg.capability}.${msg.tool}`, outcome: "no_backend" });
			console.error(
				`[sandbox ${sandboxId.slice(0, 8)}] gate_call: ${msg.capability}.${msg.tool} → no backend for capability "${msg.capability}"`,
			);
			this.writeCapabilityResponse(
				child,
				active,
				msg.call_id,
				`No capability backend registered for "${msg.capability}".`,
				true,
				bridgeRequest,
			);
			this.emitBusEvent({
				category: "capability",
				type: "call",
				sandbox_id: sandboxId,
				ts: new Date().toISOString(),
				call_id: msg.call_id,
				capability: msg.capability,
				operation: msg.tool,
				outcome: "denied",
				duration_ms: 0,
			});
			if (bridgeRequest) active.bridgeAbortControllers?.delete(bridgeRequest.payload.requestId);
			return;
		}

		const gateLabel = `${msg.capability}.${msg.tool}`;
		return tracer.startActiveSpan(
			"gate.call",
			{
				attributes: {
					"gate.capability": msg.capability,
					"gate.tool": msg.tool,
					"sandbox.template": template,
					"sandbox.id": sandboxId,
				},
			},
			async (gateSpan) => {
				const start = performance.now();
				try {
					if (msg.tool === GATE_LIST_TOOLS) {
						console.error(`[sandbox ${sandboxId.slice(0, 8)}] gate_call: ${gateLabel} (discovering tools...)`);
						const descriptors = await backend.listTools();
						if (abortController?.signal.aborted) throw abortController.signal.reason;
						const elapsed = ((performance.now() - start) / 1000).toFixed(2);
						console.error(
							`[sandbox ${sandboxId.slice(0, 8)}] gate_result: ${gateLabel} → ${descriptors.length} tools (${elapsed}s)`,
						);
						this.writeCapabilityResponse(child, active, msg.call_id, descriptors, false, bridgeRequest);
						gateSpan.setStatus({ code: SpanStatusCode.OK });
						gateCallsTotal.add(1, { template, gate: gateLabel, outcome: "ok" });
						gateCallDurationSeconds.record((performance.now() - start) / 1000, { template, gate: gateLabel });
						this.emitCapabilityCall(active, msg, "ok", performance.now() - start);
						return;
					}

					console.error(`[sandbox ${sandboxId.slice(0, 8)}] gate_call: ${gateLabel}`);
					const result = await backend.callTool(msg.tool, msg.args, abortController?.signal);
					// A deletion the cell accepted is recorded by the host, durably, before the worker hears of it.
					const answered = await this.recordDeletionReceipt(active, msg, result);
					const elapsed = ((performance.now() - start) / 1000).toFixed(2);
					console.error(`[sandbox ${sandboxId.slice(0, 8)}] gate_result: ${gateLabel} ok (${elapsed}s)`);
					// The call went through, but the cell refused it: say why (metadata only, never content).
					if (isToolErrorResult(result)) {
						console.error(
							toolFailureLogLine({
								where: "cell",
								sessionId: active.agentRequest?.session_id,
								sandboxId,
								tool: gateLabel,
								result,
							}),
						);
					}
					this.writeCapabilityResponse(child, active, msg.call_id, answered, false, bridgeRequest);
					gateSpan.setStatus({ code: SpanStatusCode.OK });
					gateCallsTotal.add(1, { template, gate: gateLabel, outcome: "ok" });
					gateCallDurationSeconds.record((performance.now() - start) / 1000, { template, gate: gateLabel });
					this.emitCapabilityCall(active, msg, "ok", performance.now() - start, result);
				} catch (err) {
					const elapsed = ((performance.now() - start) / 1000).toFixed(2);
					console.error(
						`[sandbox ${sandboxId.slice(0, 8)}] gate_error: ${gateLabel} kind=${safeErrorKind(err)} (${elapsed}s)`,
					);
					gateSpan.setStatus({
						code: SpanStatusCode.ERROR,
						message: "host capability call failed",
					});
					gateSpan.recordException(new Error("host capability call failed"));
					gateCallsTotal.add(1, { template, gate: gateLabel, outcome: "error" });
					gateCallDurationSeconds.record((performance.now() - start) / 1000, { template, gate: gateLabel });
					this.emitCapabilityCall(active, msg, capabilityFailureOutcome(err), performance.now() - start);

					this.writeCapabilityResponse(
						child,
						active,
						msg.call_id,
						bridgeRequest ? err : err instanceof Error ? err.message : String(err),
						true,
						bridgeRequest,
					);
				} finally {
					if (bridgeRequest) active.bridgeAbortControllers?.delete(bridgeRequest.payload.requestId);
					gateSpan.end();
				}
			},
		);
	}

	private handleBridgeCancellation(
		request: Extract<PrimeWorkerRequestV1, { name: "request.cancel" }>,
		child: ChildProcess,
		active: ActiveSandbox,
	): void {
		const controller = active.bridgeAbortControllers?.get(request.payload.targetRequestId);
		if (controller && !controller.signal.aborted) {
			const cancellation = new Error(request.payload.reason ?? "Bridge request cancelled");
			cancellation.name = "AbortError";
			controller.abort(cancellation);
		}
		this.writeBridgeResponse(child, active, request, {
			kind: "request.cancelled",
			targetRequestId: request.payload.targetRequestId,
			cancelled: controller !== undefined,
		});
	}

	/**
	 * Delays between the attempts to keep a deletion receipt the store did not take (exam 2, C): bounded, so a failing
	 * store costs one gate call a few seconds, never an unbounded stall. A test may shorten them.
	 */
	private deletionReceiptRetryDelaysMs: number[] = [100, 400, 1600];

	/** Receipts the store has not taken yet, by Session. In memory: lost if the host restarts first. */
	private readonly pendingDeletionReceipts = new Map<string, PendingDeletionReceipt[]>();
	private readonly receiptLocks = new Map<string, Promise<void>>();
	/** The pending queue is bounded: per Session, per host, and by age. The oldest go first. A test may lower them. */
	private maxPendingReceiptsPerSession = 200;
	private maxPendingReceiptsPerHost = 2_000;
	private pendingReceiptTtlMs = 60 * 60 * 1000;
	/** At most one flush in flight per Session; triggers that arrive meanwhile set `again` and are one more round. */
	private readonly receiptFlushes = new Map<string, { again: boolean }>();

	/** A drop is an error log naming the Session, tool, call and receiptKey, never content. */
	private dropPendingReceipt(entry: PendingDeletionReceipt, why: string): void {
		console.error(
			`[chat] ERROR: dropped a pending deletion receipt (${why}); it is lost: session=${entry.sessionId} tool=${entry.receipt.tool} call=${entry.callId} receiptKey=${entry.key}`,
		);
	}

	/** Drop what has aged out of a Session's queue. */
	private expirePendingReceipts(sessionId: string): void {
		const queue = this.pendingDeletionReceipts.get(sessionId);
		if (!queue) return;
		const now = Date.now();
		const kept = queue.filter((entry) => {
			if (now - entry.queuedAt <= this.pendingReceiptTtlMs) return true;
			this.dropPendingReceipt(entry, "older than the time limit");
			return false;
		});
		if (kept.length === 0) this.pendingDeletionReceipts.delete(sessionId);
		else this.pendingDeletionReceipts.set(sessionId, kept);
	}

	/** Enforce the per-Session and per-host caps by dropping the oldest. */
	private enforcePendingReceiptCaps(sessionId: string): void {
		const queue = this.pendingDeletionReceipts.get(sessionId) ?? [];
		while (queue.length > this.maxPendingReceiptsPerSession) {
			this.dropPendingReceipt(queue.shift() as PendingDeletionReceipt, "the Session's queue is full");
		}
		while (this.pendingDeletionReceiptCount() > this.maxPendingReceiptsPerHost) {
			let oldest: { sessionId: string; at: number } | undefined;
			for (const [id, entries] of this.pendingDeletionReceipts) {
				const head = entries[0];
				if (head && (!oldest || head.queuedAt < oldest.at)) oldest = { sessionId: id, at: head.queuedAt };
			}
			if (!oldest) break;
			const entries = this.pendingDeletionReceipts.get(oldest.sessionId) ?? [];
			this.dropPendingReceipt(entries.shift() as PendingDeletionReceipt, "the host's queue is full");
			if (entries.length === 0) this.pendingDeletionReceipts.delete(oldest.sessionId);
		}
		if (queue.length === 0) this.pendingDeletionReceipts.delete(sessionId);
	}

	/** How many deletion receipts are waiting for the store, for one Session or all (observability, and tests). */
	pendingDeletionReceiptCount(sessionId?: string): number {
		if (sessionId !== undefined) return this.pendingDeletionReceipts.get(sessionId)?.length ?? 0;
		let count = 0;
		for (const pending of this.pendingDeletionReceipts.values()) count += pending.length;
		return count;
	}

	/** One at a time per Session: a queue operation never interleaves with another. */
	private async withReceiptLock<T>(key: string, run: () => Promise<T>): Promise<T> {
		const previous = this.receiptLocks.get(key) ?? Promise.resolve();
		let release: () => void = () => {};
		const mine = new Promise<void>((resolve) => {
			release = resolve;
		});
		const chained = previous.then(() => mine);
		this.receiptLocks.set(key, chained);
		await previous;
		try {
			return await run();
		} finally {
			release();
			if (this.receiptLocks.get(key) === chained) this.receiptLocks.delete(key);
		}
	}

	/** The receipt's identity: this Session, this materialization, this tool call, this chunk, these targets. */
	private deletionReceiptKey(
		sessionId: string,
		generation: number,
		callId: string,
		receipt: DeletionReceiptV1,
	): string {
		const digest = createHash("sha256")
			.update(
				[
					sessionId,
					generation,
					callId,
					receipt.part?.index ?? 0,
					...receipt.targets.map((t) => `${t.kind}:${t.id}`),
				].join("\n"),
			)
			.digest("hex")
			.slice(0, 32);
		return `dr_${digest}`;
	}

	private async appendDeletionReceipt(entry: PendingDeletionReceipt): Promise<void> {
		if (!this.workflowRuntime) throw new Error("no runtime store to record into");
		await this.workflowRuntime.appendAgentSessionEventOnce(entry.sessionId, entry.key, {
			type: "capability.called",
			payload: {
				schema: AGENT_SESSION_SEMANTIC_EVENT_SCHEMA,
				sourceType: "host.deletion-receipt",
				value: {
					callId: entry.callId,
					receiptKey: entry.key,
					capability: "mnemosyne",
					operation: entry.receipt.tool,
					outcome: "ok",
					receipt: entry.receipt,
				},
				meaningfulObjects: {},
			},
		});
	}

	/**
	 * The deletion receipt (exam 1, finding 4; simplified after exam 5). When the cell accepts a graph deletion
	 * (`delete_document`, or `delete` of a wire or document), append a receipt to the Session's durable events
	 * (`capability.called`, source `host.deletion-receipt`) before the answer is written to the worker. **The claim:
	 * receipts are durable whenever the runtime store accepts writes; while it refuses they are best-effort, in memory.**
	 * Identities come from the cell's own answer where the arguments do not name them; every one is recorded (chunked);
	 * each carries a deterministic key, and the store appends a key once (check-then-insert in one write transaction),
	 * so a retry after an ambiguous success never duplicates it. A store that does not take a receipt is retried a
	 * bounded number of times; if it still does not, the receipt stays pending in memory (an error is logged, and the
	 * answer handed to the model says so, in words) until a background flush, triggered by the Session's next gate call,
	 * gets it in, or the host restarts (then it is lost, and the error log is the record).
	 *
	 * Ordinary calls never wait on receipt work: the flush is started, not awaited.
	 *
	 * Returns what the worker is to be told: the cell's answer, with that notice appended when a receipt is pending.
	 */
	private async recordDeletionReceipt(
		active: ActiveSandbox,
		msg: Extract<WorkerMessage, { kind: "gate_call" }>,
		result: unknown,
	): Promise<unknown> {
		const sessionId = active.agentRequest?.session_id;
		if (!sessionId || !this.workflowRuntime) return result;
		this.flushPendingDeletionReceiptsInBackground(sessionId);
		if (msg.capability !== "mnemosyne") return result;
		const receipts = deletionReceipts(msg.tool, msg.args, result);
		if (receipts.length === 0) return result;
		const generation = active.agentRequest?.generation ?? 0;
		const unkept: PendingDeletionReceipt[] = [];
		for (const receipt of receipts) {
			const entry: PendingDeletionReceipt = {
				key: this.deletionReceiptKey(sessionId, generation, msg.call_id, receipt),
				sessionId,
				generation,
				callId: msg.call_id,
				receipt,
				queuedAt: Date.now(),
			};
			let lastError: unknown;
			let kept = false;
			for (let attempt = 0; attempt <= this.deletionReceiptRetryDelaysMs.length && !kept; attempt += 1) {
				if (attempt > 0)
					await new Promise((resolve) => setTimeout(resolve, this.deletionReceiptRetryDelaysMs[attempt - 1]));
				try {
					await this.appendDeletionReceipt(entry);
					kept = true;
				} catch (error) {
					lastError = error;
				}
			}
			if (kept) continue;
			unkept.push(entry);
			console.error(
				`[chat] ERROR: deletion receipt for ${sessionId} (${msg.tool}, call ${msg.call_id}) could not be recorded after ${this.deletionReceiptRetryDelaysMs.length + 1} attempts and is pending in memory (lost if the host restarts): ${boundedInferenceFailure(lastError)}`,
			);
		}
		if (unkept.length === 0) return result;
		await this.withReceiptLock(sessionId, async () => {
			const queue = this.pendingDeletionReceipts.get(sessionId) ?? [];
			for (const entry of unkept) {
				if (!queue.some((queued) => queued.key === entry.key)) queue.push(entry);
			}
			this.pendingDeletionReceipts.set(sessionId, queue);
			this.expirePendingReceipts(sessionId);
			this.enforcePendingReceiptCaps(sessionId);
		});
		const named = unkept.flatMap((entry) => entry.receipt.targets.map((target) => target.id));
		const shown = named.slice(0, 50).join(", ");
		const notice =
			`Host notice: the deletion succeeded (${shown}${named.length > 50 ? ` and ${named.length - 50} more` : ""}) ` +
			"but its receipt could not be recorded in this session's record, and will be retried. " +
			"Tell the person plainly what was deleted, and that the record of it is pending.";
		const answer = result !== null && typeof result === "object" && !Array.isArray(result) ? result : {};
		const content = (answer as { content?: unknown }).content;
		return { ...answer, content: [...(Array.isArray(content) ? content : []), { type: "text", text: notice }] };
	}

	/**
	 * Start a flush for the Session if it has pending receipts; never awaited by the call that triggered it. At most one
	 * flush runs per Session: a trigger that arrives while one runs sets a single "again" flag and is one more round,
	 * so N triggers cost at most one extra round, not N.
	 */
	private flushPendingDeletionReceiptsInBackground(sessionId: string): void {
		if (!this.pendingDeletionReceipts.get(sessionId)?.length) return;
		const running = this.receiptFlushes.get(sessionId);
		if (running) {
			running.again = true;
			return;
		}
		const state = { again: false };
		this.receiptFlushes.set(sessionId, state);
		void (async () => {
			try {
				do {
					state.again = false;
					await this.flushPendingDeletionReceipts(sessionId);
				} while (state.again && this.pendingDeletionReceipts.get(sessionId)?.length);
			} catch (error) {
				console.error(`[chat] ERROR: a pending deletion-receipt flush failed: ${boundedInferenceFailure(error)}`);
			} finally {
				this.receiptFlushes.delete(sessionId);
			}
		})();
	}

	/**
	 * One try for each receipt the store did not take earlier, under the Session's lock. It removes from the queue only
	 * what it persisted, by key; whatever else was queued meanwhile, or still fails, stays pending.
	 */
	private async flushPendingDeletionReceipts(sessionId: string): Promise<void> {
		await this.withReceiptLock(sessionId, async () => {
			this.expirePendingReceipts(sessionId);
			const persisted = new Set<string>();
			for (const entry of [...(this.pendingDeletionReceipts.get(sessionId) ?? [])]) {
				try {
					await this.appendDeletionReceipt(entry);
					persisted.add(entry.key);
				} catch {
					// still pending
				}
			}
			if (persisted.size === 0) return;
			const rest = (this.pendingDeletionReceipts.get(sessionId) ?? []).filter((entry) => !persisted.has(entry.key));
			if (rest.length === 0) this.pendingDeletionReceipts.delete(sessionId);
			else this.pendingDeletionReceipts.set(sessionId, rest);
		});
	}

	private emitCapabilityCall(
		active: ActiveSandbox,
		msg: Extract<WorkerMessage, { kind: "gate_call" }>,
		outcome: "ok" | "error" | "denied",
		durationMs: number,
		result?: unknown,
	): void {
		const foldedReceipt = outcome === "ok" && result !== undefined ? capabilityResultReceipt(result) : {};
		const receipt =
			msg.capability === "workflow" && msg.tool === "propose_amendment" && foldedReceipt.decision === "accepted"
				? { ...foldedReceipt, decision: "proposed" as const }
				: foldedReceipt;
		this.emitBusEvent({
			category: "capability",
			type: "call",
			sandbox_id: active.record.sandbox_id,
			ts: new Date().toISOString(),
			call_id: msg.call_id,
			capability: msg.capability,
			operation: msg.tool,
			outcome,
			// Event-bus testimony is also the source for CaptureEvent v0.2,
			// whose duration_ms is an integer. performance.now() is fractional,
			// so normalize once at the host boundary instead of letting the
			// fail-soft capture writer silently reject an otherwise valid call.
			duration_ms: Math.max(0, Math.round(durationMs)),
			...receipt,
		});
	}

	private handleSpawnRequest(msg: Extract<WorkerMessage, { kind: "spawn" }>, child: ChildProcess): void {
		this.writeWorkerMessage(child, {
			kind: "spawn_result",
			spawn_id: msg.request.spawn_id,
			result: {
				spawn_id: msg.request.spawn_id,
				status: "error",
				output: "Recursive child spawning is not yet implemented in the spike agent path.",
				turns: 0,
			},
		});
	}

	private writeInferenceResponse(
		child: ChildProcess,
		active: ActiveSandbox,
		event: ProxyAssistantMessageEvent,
		bridgeRequest: Extract<PrimeWorkerRequestV1, { name: "inference.request" }>,
	): void {
		if (event.type === "error") {
			this.writeBridgeErrorResponse(child, active, bridgeRequest, inferenceBridgeError(event));
			return;
		}
		this.writeBridgeResponse(child, active, bridgeRequest, {
			kind: "inference.chunk",
			event,
		});
	}

	private writeCapabilityResponse(
		child: ChildProcess,
		active: ActiveSandbox,
		requestId: string,
		result: unknown,
		isError: boolean,
		bridgeRequest?: Extract<PrimeWorkerRequestV1, { name: "capability.request" }>,
	): void {
		if (!bridgeRequest) {
			this.writeWorkerMessage(child, {
				kind: "gate_result",
				call_id: requestId,
				result,
				is_error: isError,
			});
			return;
		}
		if (isError) {
			this.writeBridgeErrorResponse(child, active, bridgeRequest, capabilityBridgeError(result));
			return;
		}
		this.writeBridgeResponse(child, active, bridgeRequest, {
			kind: "capability.result",
			result,
			isError,
		});
	}

	private writeBridgeErrorResponse(
		child: ChildProcess,
		active: ActiveSandbox,
		request: PrimeWorkerRequestV1,
		error: PrimeHostErrorV1,
	): void {
		const responseId = active.nextHostResponseId ?? 0;
		active.nextHostResponseId = responseId + 1;
		this.writeWorkerMessage(child, {
			protocol: PRIME_HOST_PROTOCOL_VERSION,
			messageId: `host.response:${request.sandboxId}:${request.generation}:${responseId}`,
			sessionId: request.sessionId,
			sandboxId: request.sandboxId,
			generation: request.generation,
			correlationId: request.correlationId,
			causationId: request.messageId,
			direction: "host_to_worker",
			kind: "response",
			requestId: request.payload.requestId,
			ok: false,
			error,
		});
	}

	private writeBridgeResponse(
		child: ChildProcess,
		active: ActiveSandbox,
		request: PrimeWorkerRequestV1,
		result: unknown,
	): void {
		const responseId = active.nextHostResponseId ?? 0;
		active.nextHostResponseId = responseId + 1;
		this.writeWorkerMessage(child, {
			protocol: PRIME_HOST_PROTOCOL_VERSION,
			messageId: `host.response:${request.sandboxId}:${request.generation}:${responseId}`,
			sessionId: request.sessionId,
			sandboxId: request.sandboxId,
			generation: request.generation,
			correlationId: request.correlationId,
			causationId: request.messageId,
			direction: "host_to_worker",
			kind: "response",
			requestId: request.payload.requestId,
			ok: true,
			result,
		});
	}

	private writeWorkerMessage(
		child: ChildProcess,
		msg: OrchestratorMessage | PrimeHostCommandV1 | PrimeHostResponseV1,
	): void {
		try {
			child.stdin?.write(`${JSON.stringify(msg)}\n`);
		} catch {
			// child may have exited between dispatch and write
		}
	}

	private async recordDurableAgentBodyExit(active: ActiveSandbox | undefined, code: number | null): Promise<void> {
		// A hosted child delegates normal logical completion and every explicit
		// supervisor-owned reap to the leased child controller. An external worker
		// close has neither a validated result nor a synchronously latched host-work
		// fence, so it must establish physical body truth immediately even while the
		// child run itself remains claimed for its lease owner/restart recovery.
		const expectedHostedChildExit = Boolean(
			active?.durableSupervisorExit &&
				((active.hostWorkAdmissionClosed && !active.unexpectedWorkerExit) ||
					(active.agentRequest?.runtime_binding.kind === "simple" && active.workerResult !== undefined)),
		);
		if (
			!this.workflowRuntime ||
			!active?.isAgentRun ||
			!active.agentRequest ||
			active.bodyBound === false ||
			expectedHostedChildExit
		)
			return;
		const request = active.agentRequest;
		const materialization = await this.workflowRuntime.readAgentMaterialization(
			request.session_id,
			request.generation,
		);
		if (!materialization || materialization.sandbox_id !== active.record.sandbox_id) return;
		if (["passivated", "completed", "faulted", "cancelled"].includes(materialization.state)) {
			this.wakeDurableSupervision();
			return;
		}
		// Quiescence owns its own ordered body/checkpoint/kernel testimony.
		if (materialization.state === "quiescing" || materialization.state === "quiescent") return;
		if (materialization.state !== "claimed" && materialization.state !== "running") return;

		try {
			if (request.runtime_binding.kind === "simple") {
				const completed = code === 0 && Boolean(active.workerResult) && active.workerTerminalState !== "error";
				await this.workflowRuntime.finishAgentMaterialization(request.session_id, request.generation, {
					activationId: materialization.activation_id,
					from: materialization.state,
					...(completed
						? { to: "completed" as const }
						: {
								to: "faulted" as const,
								faultKind: code === 137 ? ("worker_oom" as const) : ("worker_exit" as const),
								recoverable: false,
							}),
					now: Date.now(),
				});
			} else {
				const kernel = this.executionService.getLeaseForSession(request.session_id);
				if (
					kernel &&
					kernel.generation === request.generation &&
					kernel.activationId === materialization.activation_id
				) {
					this.restoredKernelLeases.delete(kernel.leaseId);
					await this.executionService.fault(kernel.leaseId);
				}
				await this.workflowRuntime.finishAgentMaterialization(request.session_id, request.generation, {
					activationId: materialization.activation_id,
					from: materialization.state,
					to: "faulted",
					faultKind: code === 137 ? "worker_oom" : active.workerResultFault ? "worker_protocol" : "worker_exit",
					recoverable: materialization.checkpoint_id !== null,
					now: Date.now(),
				});
			}
		} catch (error) {
			// A child run or recovery lease may own the first-wins terminal order.
			// Its durable supervisor will finish the paired testimony from the store.
			console.error(
				`[supervisor] deferred body settlement for ${request.session_id}/${request.generation}: ${boundedInferenceFailure(error)}`,
			);
		} finally {
			this.wakeDurableSupervision();
		}
	}

	private async handleUnexpectedKernelExit(input: {
		leaseId: string;
		sessionId: string;
		generation: number;
		activationId: string;
		agentSandboxId: string;
		kernelSandboxId: string;
		exitCode: number | null;
		signal: string | null;
	}): Promise<void> {
		const retryKey = `${input.sessionId}:${String(input.generation)}:${input.activationId}`;
		const existingRetry = this.unexpectedKernelCleanupRetries.get(retryKey);
		if (existingRetry) clearTimeout(existingRetry);
		this.unexpectedKernelCleanupRetries.delete(retryKey);
		this.restoredKernelLeases.delete(input.leaseId);
		const active = this.active.get(input.agentSandboxId);
		const ownsWorker = Boolean(
			active?.isAgentRun &&
				active.agentRequest?.session_id === input.sessionId &&
				active.agentRequest.generation === input.generation,
		);
		let workerReaped = !active;
		if (ownsWorker && active) {
			active.durableSupervisorExit = true;
			try {
				await this.killProcess(input.agentSandboxId, "killed");
				workerReaped = !this.active.has(input.agentSandboxId);
			} catch (error) {
				console.error(
					`[supervisor] failed to reap worker after kernel exit for ${input.sessionId}: ${boundedInferenceFailure(error)}`,
				);
				if (!this.shuttingDown) {
					const retry = setTimeout(() => {
						this.unexpectedKernelCleanupRetries.delete(retryKey);
						void this.trackSupervisorTask(
							this.handleUnexpectedKernelExit(input).catch((retryError) => {
								console.error(
									`[supervisor] kernel-exit worker cleanup retry failed for ${input.sessionId}: ${boundedInferenceFailure(retryError)}`,
								);
							}),
						);
					}, 1_000);
					retry.unref?.();
					this.unexpectedKernelCleanupRetries.set(retryKey, retry);
				}
			}
		}
		try {
			if (!this.workflowRuntime) return;
			// Retry the exact durable kernel testimony independently of the execution
			// service's first attempt. The store makes this replay idempotent.
			await this.workflowRuntime.recordAgentSessionKernelState(input.sessionId, input.generation, {
				activationId: input.activationId,
				state: "faulted",
				now: Date.now(),
			});
			if (!workerReaped) return;
			const current = await this.workflowRuntime.readAgentMaterialization(input.sessionId, input.generation);
			if (
				!current ||
				current.activation_id !== input.activationId ||
				current.state === "passivated" ||
				current.state === "completed" ||
				current.state === "faulted" ||
				current.state === "cancelled"
			) {
				return;
			}
			if (current.state !== "claimed" && current.state !== "running") return;
			await this.workflowRuntime.finishAgentMaterialization(input.sessionId, input.generation, {
				activationId: input.activationId,
				from: current.state,
				to: "faulted",
				faultKind: "kernel_fault",
				recoverable: current.checkpoint_id !== null,
				now: Date.now(),
			});
			console.error(
				`[supervisor] kernel ${input.kernelSandboxId} exited unexpectedly for ${input.sessionId}/${String(input.generation)}`,
			);
		} catch (error) {
			console.error(
				`[supervisor] deferred kernel-exit settlement for ${input.sessionId}/${String(input.generation)}: ${boundedInferenceFailure(error)}`,
			);
		} finally {
			this.wakeDurableSupervision();
		}
	}

	private monitorExit(sandboxId: string, child: ChildProcess, cgroupPath: string | undefined): void {
		const active = this.active.get(sandboxId);
		const startUnexpectedWorkerKernelReap = (): Promise<void> => {
			if (!active) return Promise.resolve();
			if (!active.unexpectedWorkerKernelReap) {
				active.unexpectedWorkerKernelReap = this.trackSupervisorTask(
					this.reapPairedKernelForUnexpectedWorkerExit(active),
				);
				// The close/cleanup continuation awaits the original rejecting promise;
				// this observer only prevents a natural PID exit from becoming an
				// unhandled rejection while stdio close is still blocked on the kernel.
				void active.unexpectedWorkerKernelReap.catch(() => undefined);
			}
			return active.unexpectedWorkerKernelReap;
		};
		let resolveExitDone: () => void;
		let rejectExitDone: (error: unknown) => void;
		const exitDone = new Promise<void>((resolve, reject) => {
			resolveExitDone = resolve;
			rejectExitDone = reject;
		});
		// Keep natural exits free of unhandled rejections while preserving the
		// original rejecting Promise for kill/shutdown retry callers.
		void exitDone.catch(() => undefined);
		if (active) active.exitDone = exitDone;
		// `close` can wait indefinitely for inherited/open stdio owned by a blocked
		// kernel request. PID `exit` is sufficient to begin exact paired-kernel reap;
		// all durable worker/cgroup testimony still waits for `close` below.
		child.once("exit", () => {
			void startUnexpectedWorkerKernelReap();
		});

		child.once("close", (code) => {
			(async () => {
				const exitSpan = tracer.startSpan("sandbox.exit", {
					links: active?.spawnSpanContext ? [{ context: active.spawnSpanContext }] : [],
				});
				exitSpan.setAttributes({
					"sandbox.id": sandboxId,
				});
				if (code !== null) {
					exitSpan.setAttribute("sandbox.exit_code", code);
				}
				// An actual process can close while its post-spawn child-run bind is
				// still awaiting SQLite. Let that exact arbitration finish first: a
				// successful bind owns normal body-exit testimony; a rejected bind is
				// an unbound process and must never manufacture an Agent body.
				await active?.spawnBinding?.catch(() => undefined);
				await startUnexpectedWorkerKernelReap();
				// The process can close while a command.result handler is still
				// committing its checkpoint/document effects. Preserve line order and
				// drain those effects before physical body-exit testimony.
				while (active?.workerLineRequests?.size) {
					await Promise.allSettled([...active.workerLineRequests]);
				}

				// Clear timeout
				if (active?.timeout) {
					clearTimeout(active.timeout);
				}

				// Read resource usage before cleanup. Local-native runs have no cgroup
				// accounting, so they report an empty usage envelope.
				const usage = cgroupPath ? await readUsage(cgroupPath) : {};

				if (usage.memory_peak_bytes != null) {
					exitSpan.setAttribute("sandbox.resources.memory_peak_bytes", usage.memory_peak_bytes);
				}
				if (usage.cpu_usage_us != null) {
					exitSpan.setAttribute("sandbox.resources.cpu_usage_us", usage.cpu_usage_us);
				}

				// Transition to terminal state with all data in one transaction
				const record = this.store.get(sandboxId);
				let finalRecord = record;
				if (record && record.state === "running") {
					const terminalState =
						active?.pendingTerminalState ?? active?.workerTerminalState ?? (code === 0 ? "done" : "error");
					const isOom = code === 137 && !active?.pendingTerminalState;
					const reason = active?.pendingTerminalState
						? `${active.pendingTerminalState} via API`
						: active?.workerResultFault
							? `sandbox result rejected: ${active.workerResultFault}`
							: active?.workerTerminalState === "truncated"
								? "agent turn budget exhausted"
								: isOom
									? "OOM killed by cgroup memory limit"
									: code === 0
										? "clean exit"
										: `exit code ${code}`;

					const oomDetail = active?.workerResultFault
						? active.workerResultFault
						: isOom
							? `Process killed by OOM (SIGKILL, exit 137). ` +
								`memory.max=${record.memory_max_bytes ?? "unset"}, ` +
								`memory_peak=${formatBytes(usage.memory_peak_bytes)}`
							: undefined;

					exitSpan.setAttributes({
						"sandbox.terminal_state": terminalState,
						"sandbox.oom": isOom,
					});

					try {
						finalRecord = this.store.transitionToTerminal(sandboxId, terminalState, {
							exitCode: code ?? undefined,
							usage,
							reason,
							errorDetail: oomDetail,
						});
						if (isOom) {
							exitSpan.addEvent("oom_kill", {
								"sandbox.resources.memory_max_bytes": record.memory_max_bytes ?? 0,
								"sandbox.resources.memory_peak_bytes": usage.memory_peak_bytes ?? 0,
							});
							exitSpan.setStatus({ code: SpanStatusCode.ERROR, message: "OOM killed by cgroup memory limit" });
						}
					} catch {
						// may have been killed/timed out already
						finalRecord = this.store.get(sandboxId);
					}
				} else if (record?.state === "spawning") {
					// `spawn` was observed but the durable body bind rejected (or the
					// process died before it completed). Only the generic Sandbox attempt
					// existed; no Agent body was bound.
					try {
						finalRecord = this.store.transition(sandboxId, "error", "process exited before durable body bind");
						this.store.updateResourceUsage(sandboxId, usage);
						if (code !== null) this.store.updateExitCode(sandboxId, code);
						finalRecord = this.store.get(sandboxId);
					} catch {
						finalRecord = this.store.get(sandboxId);
					}
				} else if (record) {
					// Already in terminal state (killed/timed out) — just update usage
					this.store.updateResourceUsage(sandboxId, usage);
					if (code !== null) this.store.updateExitCode(sandboxId, code);
					finalRecord = this.store.get(sandboxId);
				}

				// Record exit metrics
				const template = finalRecord?.template ?? active?.record.template ?? "unknown";
				const terminalState = finalRecord?.state ?? "unknown";
				const isOom = String(code === 137 && !active?.pendingTerminalState);

				exitsTotal.add(1, { template, terminal_state: terminalState, oom: isOom });
				if (active) {
					activeSandboxes.add(-1, { template });
				}

				if (finalRecord?.running_at && finalRecord?.exited_at) {
					const runningAt = new Date(finalRecord.running_at).getTime();
					const exitedAt = new Date(finalRecord.exited_at).getTime();
					const lifetimeSec = (exitedAt - runningAt) / 1000;
					if (lifetimeSec >= 0) {
						sandboxLifetimeSeconds.record(lifetimeSec, { template, terminal_state: terminalState });
					}
				}

				if (usage.memory_peak_bytes != null) {
					memoryPeakBytes.record(usage.memory_peak_bytes, { template, terminal_state: terminalState });
				}

				if (usage.cpu_usage_us != null) {
					cpuUsageSeconds.record(usage.cpu_usage_us / 1_000_000, { template, terminal_state: terminalState });
				}

				if (active?.isAgentRun) {
					const turns = typeof active.workerResult?.turns === "number" ? active.workerResult.turns : 0;
					if (turns > 0) {
						agentTurnsPerRun.record(turns, { template, terminal_state: terminalState });
					}
					if (active.agentRunStartedAt != null) {
						agentRunDurationSeconds.record((performance.now() - active.agentRunStartedAt) / 1000, {
							template,
							terminal_state: terminalState,
						});
					}
					if (terminalState === "error") {
						agentRunErrorsTotal.add(1, { template });
					}
				}

				if (finalRecord && active) {
					emitCaptureSoft(this.capture, {
						kind: "sandbox.reap",
						...active.captureIdentity,
						outcome: captureOutcomeForTerminal(finalRecord.state),
						durationMs: captureSandboxDurationMs(finalRecord),
						payload: {
							template: finalRecord.template,
							sandboxId,
							reason: captureReapReason(finalRecord.state, code),
							exitCode: code ?? undefined,
							memoryPeakBytes: usage.memory_peak_bytes,
							cpuUsageUs: usage.cpu_usage_us,
						},
					});
				}

				// Emit terminal event before cleanup
				if (finalRecord) {
					// Attach final Pi messages from SpawnResult for session persistence
					const resultMessages = Array.isArray(active?.workerResult?.messages)
						? (active.workerResult.messages as unknown[])
						: undefined;
					this.emitBusEvent({
						category: "lifecycle",
						type: "terminal",
						sandbox_id: sandboxId,
						ts: finalRecord.exited_at ?? new Date().toISOString(),
						state: finalRecord.state as any,
						exit_code: code ?? undefined,
						error_detail: finalRecord.error_detail,
						messages: resultMessages,
						// Full SpawnResult for workflow node telemetry (status/turns/tokens/structured_output).
						result: active?.workerResult as AgentSpawnResult | undefined,
					});
				}

				// End any orphaned tool spans (sandbox exited mid-tool-call)
				if (active?.toolCallSpans) {
					for (const [, spans] of active.toolCallSpans) {
						for (const span of spans) {
							span.setAttribute("tool.outcome", "abandoned");
							span.setStatus({ code: SpanStatusCode.ERROR, message: "sandbox exited during tool call" });
							span.end();
						}
					}
				}

				await closeCapabilityRegistry(active?.capabilityRegistry).catch(() => {});
				cleanupPrimeDaemonDir(active?.primeDaemonHostDir);

				// Clean up cgroup
				if (cgroupPath) {
					await removeSandboxCgroup(cgroupPath);
				}

				// Only now is the OS body/cgroup authority actually gone. Keep Agent
				// materialization truth live until this verified physical barrier.
				await this.recordDurableAgentBodyExit(active, code);

				// Remove from active map
				this.active.delete(sandboxId);
				if (active?.isKernelRun) {
					await this.executionService.observeKernelSandboxExit(sandboxId, {
						exitCode: code,
						signal: child.signalCode,
					});
				}

				console.error(
					`[spawner] sandbox ${sandboxId.slice(0, 8)}: exited ` +
						`state=${finalRecord?.state} code=${code} ` +
						`mem_peak=${formatBytes(usage.memory_peak_bytes)} ` +
						`cpu=${usage.cpu_usage_us ? `${(usage.cpu_usage_us / 1000).toFixed(1)}ms` : "n/a"}`,
				);

				exitSpan.end();
			})().then(
				() => resolveExitDone(),
				(err) => {
					console.error(`[spawner] sandbox ${sandboxId}: exit handler error: ${err}`);
					if (active) active.exitCleanupError = err;
					rejectExitDone(err);
				},
			);
		});
	}
}

export function primeRuntimeOverlayEnvelope(
	request: Pick<AgentSpawnRequest, "embodiment_ref" | "embodiment_binding" | "embodiment_binding_digest">,
	materializations: NonNullable<AgentSpawnRequest["runtime_overlays"]>,
): { runtime_overlays: NonNullable<AgentSpawnRequest["runtime_overlays"]> } | Record<string, never> {
	const embodimentFields = [request.embodiment_ref, request.embodiment_binding, request.embodiment_binding_digest];
	const hasEmbodimentAuthority = embodimentFields.some((field) => field !== undefined);
	if (!hasEmbodimentAuthority) {
		if (materializations.length > 0) {
			throw new Error("Prime runtime overlays require a complete Agent Embodiment authority envelope");
		}
		return {};
	}
	if (embodimentFields.some((field) => field === undefined)) {
		throw new Error("Prime Agent Embodiment authority envelope is incomplete");
	}
	return { runtime_overlays: materializations };
}

interface PrimeDaemonSocketMaterialization {
	readonly hostDir: string;
	readonly hostSocket: string;
	readonly workerSocket: string;
	readonly mount?: PrivateSandboxMount;
}

function preparePrimeDaemonSocket(
	request: AgentSpawnRequest,
	sandboxId: string,
	sandboxMode: SandboxMode,
	body?: LocalNativeBodyIdentity,
): PrimeDaemonSocketMaterialization | undefined {
	if (request.interaction_mode !== "headed") return undefined;
	const root = resolve(process.env.SOPHIA_PRIME_SOCKET_ROOT?.trim() || "/tmp/choreograph-prime-sockets");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const hostDir = mkdtempSync(join(root, `${sandboxId}-`));
	if (body) {
		// The body binds its daemon socket here; it may traverse the root but not list it.
		chmodSync(root, 0o711);
		chownSync(hostDir, body.uid, body.gid);
	}
	const hostSocket = join(hostDir, "daemon.sock");
	if (sandboxMode === "local-native") {
		return { hostDir, hostSocket, workerSocket: hostSocket };
	}
	const guestDir = "/sandbox/prime-daemon" as const;
	return {
		hostDir,
		hostSocket,
		workerSocket: `${guestDir}/daemon.sock`,
		mount: { hostPath: hostDir, guestPath: guestDir, mode: "rw" },
	};
}

function cleanupPrimeDaemonDir(hostDir: string | undefined): void {
	if (!hostDir) return;
	try {
		rmSync(hostDir, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup after the exact per-sandbox directory has been fenced.
	}
}

export function resolveHarnessMaterialization(
	materialization: HarnessMaterializationV1 | undefined,
	semantic: Pick<ResolvedAgentSemanticAuthority, "runtime" | "ontology">,
): HarnessMaterializationV1 | undefined {
	if (!materialization) return undefined;
	if (semantic.runtime.schema !== "choreograph.agent-runtime-binding.v2") {
		throw new Error("Harness materialization requires runtime binding v2");
	}
	if (materialization.schema !== HARNESS_MATERIALIZATION_SCHEMA) {
		throw new Error("Harness materialization schema is unsupported");
	}
	validateMeaningfulObjectRef(materialization.harnessRef, "harness");
	if (!sameMeaningfulObjectRef(materialization.harnessRef, semantic.ontology.objects.harness)) {
		throw new Error("Harness materialization differs from the active Agent Ontology");
	}
	if (!recordOrUndefined(materialization.snapshot) || materialization.snapshot.schema !== 1) {
		throw new Error("Harness materialization snapshot schema is unsupported");
	}
	const bytes = Buffer.byteLength(JSON.stringify(materialization.snapshot));
	if (bytes > 2 * 1024 * 1024) throw new Error("Harness materialization snapshot exceeds 2 MiB");
	const exactRef = createMeaningfulObjectRef({
		kind: "harness",
		ownerPrincipal: materialization.harnessRef.ownerPrincipal,
		graphId: materialization.harnessRef.graphId,
		objectId: materialization.harnessRef.objectId,
		version: materialization.harnessRef.version,
		value: materialization.snapshot,
	});
	if (!sameMeaningfulObjectRef(exactRef, materialization.harnessRef)) {
		throw new Error("Harness materialization digest does not identify its snapshot");
	}
	return materialization;
}

// ─── Helpers ────────────────────────────────────────────────────────────

interface ResolvedAgentSemanticAuthority {
	sessionId: string;
	generation: number;
	runtime: AgentSpawnRequest["runtime_binding"];
	runtimeDigest: string;
	ontology: AgentSpawnRequest["agent_ontology"];
	ontologyDigest: string;
	embodiment?: AgentEmbodimentV1;
	embodimentRef?: MeaningfulObjectRefV1<"embodiment">;
	embodimentDigest?: string;
}

function resolveCandidateWorkspaceMount(
	lease: AgentWorkerConfig["candidate_workspace"],
	semantic: ResolvedAgentSemanticAuthority,
):
	| {
			mount: PrivateSandboxMount;
			publicDescriptor: NonNullable<AgentSpawnRequest["candidate_workspace"]>;
	  }
	| undefined {
	if (!lease) return undefined;
	if (
		lease.schema !== "sophia.candidate-workspace-lease.v1" ||
		lease.ownerPrincipal !== semantic.ontology.objects.agent.ownerPrincipal ||
		lease.agentId !== semantic.ontology.subject.agentId ||
		lease.mountPath !== "/candidate" ||
		!lease.workspaceId.trim() ||
		!lease.leaseToken.trim() ||
		!Number.isSafeInteger(lease.generation) ||
		lease.generation < 0 ||
		!Number.isSafeInteger(lease.expiresAt) ||
		lease.expiresAt <= Date.now()
	) {
		throw new Error("Candidate workspace lease does not match this owner, Agent, or active lease window");
	}
	if (!isAbsolute(lease.hostPath) || !existsSync(lease.hostPath)) {
		throw new Error("Candidate workspace lease has no absolute host materialization");
	}
	const hostPath = realpathSync(lease.hostPath);
	if (hostPath === "/" || hostPath.split("/").filter(Boolean).length < 3) {
		throw new Error("Candidate workspace host path is too broad");
	}
	return {
		mount: { hostPath, guestPath: "/candidate", mode: "rw" },
		publicDescriptor: {
			schema: "sophia.candidate-workspace-mount.v1",
			workspaceId: lease.workspaceId,
			mountPath: "/candidate",
			generation: lease.generation,
			leaseToken: lease.leaseToken,
		},
	};
}

function resolvePrimeRestoreState(request: AgentSpawnRequest, value: unknown): PrimeRuntimeStateV2 | undefined {
	if (request.generation === 0) {
		if (value !== undefined) throw new Error("Generation zero cannot restore prior Prime state");
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Every generation after zero requires host-verified Prime state");
	}
	const state = value as PrimeRuntimeStateV2;
	if (
		state.schema !== PRIME_RUNTIME_STATE_SCHEMA ||
		state.sessionId !== request.session_id ||
		state.generation !== request.generation - 1 ||
		state.runtimeBindingDigest !== request.runtime_binding_digest ||
		state.ontologyBindingDigest !== request.agent_ontology_binding_digest ||
		!Number.isSafeInteger(state.workerSequence) ||
		state.workerSequence < 0
	) {
		throw new Error("Prime restore state is not the compatible preceding session generation");
	}
	return state;
}

function resolveAgentSemanticAuthority(
	request: Partial<AgentSpawnRequest>,
	config: AgentWorkerConfig,
): ResolvedAgentSemanticAuthority {
	const sessionId = request.session_id ?? config.session_id;
	if (typeof sessionId !== "string" || !sessionId.trim()) {
		throw new Error("Agent execution requires a canonical session_id");
	}
	const generation = request.generation ?? config.generation;
	if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) {
		throw new Error("Agent execution requires a non-negative fenced generation");
	}

	const runtime = request.runtime_binding ?? config.runtime_binding;
	if (!runtime) throw new Error("Agent execution requires a pinned runtime binding Meaningful Object");
	validateResolvedAgentRuntimeBinding(runtime);
	const runtimeDigest = digestAgentRuntimeBinding(runtime);
	let embodiment: AgentEmbodimentV1 | undefined;
	let embodimentRef: MeaningfulObjectRefV1<"embodiment"> | undefined;
	let embodimentDigest: string | undefined;
	embodiment = request.embodiment_binding ?? config.embodiment_binding;
	embodimentRef = request.embodiment_ref ?? config.embodiment_ref;
	const assertedEmbodimentDigest = request.embodiment_binding_digest ?? config.embodiment_binding_digest;
	if (embodiment || embodimentRef || assertedEmbodimentDigest) {
		if (!embodiment || !embodimentRef || !assertedEmbodimentDigest) {
			throw new Error("Agent Embodiment authority must be supplied as one complete envelope");
		}
		validateAgentEmbodiment(embodiment);
		validateMeaningfulObjectRef(embodimentRef, "embodiment");
		embodimentDigest = digestAgentEmbodiment(embodiment);
		if (assertedEmbodimentDigest !== embodimentDigest || embodimentRef.digest !== embodimentDigest) {
			throw new Error("Agent Embodiment digest mismatch");
		}
		if (
			embodiment.embodimentId !== embodimentRef.objectId ||
			embodiment.ownerPrincipal !== embodimentRef.ownerPrincipal ||
			digestAgentRuntimeBindingV2(embodiment.runtimeBinding) !== embodiment.runtimeBindingDigest ||
			embodiment.runtimeBinding.kind !== runtime.kind ||
			embodiment.runtimeBinding.baseBundle.id !== runtime.bundle.id ||
			embodiment.runtimeBinding.baseBundle.digest !== runtime.bundle.digest ||
			!sameMeaningfulObjectRef(embodiment.runtimeBinding.profileRef, runtime.profileRef) ||
			canonicalJson(embodiment.runtimeBinding.constraints) !== canonicalJson(runtime.constraints)
		) {
			throw new Error("Agent Embodiment does not exactly extend the requested runtime profile");
		}
	}
	const baseBundle = runtime.bundle;
	if (baseBundle.id !== SOPHIA_AGENT_RUNTIME_BUNDLE_ID) {
		throw new Error(
			`Agent runtime bundle '${baseBundle.id}' is not executable; expected '${SOPHIA_AGENT_RUNTIME_BUNDLE_ID}'`,
		);
	}
	const assertedRuntimeDigest = request.runtime_binding_digest ?? config.runtime_binding_digest;
	if (assertedRuntimeDigest !== runtimeDigest) {
		throw new Error(
			`Agent runtime binding digest mismatch: expected ${runtimeDigest}, got ${String(assertedRuntimeDigest)}`,
		);
	}

	const ontology = request.agent_ontology ?? config.agent_ontology ?? embodiment?.ontologyBinding;
	if (!ontology) throw new Error("Agent execution requires a complete Agent Ontology / Meaningful Objects binding");
	validateAgentOntologyBinding(ontology);
	const ontologyDigest = digestAgentOntologyBinding(ontology);
	const assertedOntologyDigest =
		request.agent_ontology_binding_digest ??
		config.agent_ontology_binding_digest ??
		embodiment?.ontologyBindingDigest;
	if (assertedOntologyDigest !== ontologyDigest) {
		throw new Error(
			`Agent Ontology binding digest mismatch: expected ${ontologyDigest}, got ${String(assertedOntologyDigest)}`,
		);
	}
	const assertedAgentId = request.agent_id ?? config.agent_id;
	assertAgentOntologyRuntimeMatch(ontology, {
		agentId: assertedAgentId,
		runtimeProfileRef: runtime.profileRef,
	});
	if (embodiment) {
		if (
			embodiment.agentId !== ontology.subject.agentId ||
			embodiment.ontologyBindingDigest !== ontologyDigest ||
			digestAgentOntologyBinding(embodiment.ontologyBinding) !== ontologyDigest ||
			!sameMeaningfulObjectRef(embodiment.runtimeBinding.profileRef, ontology.objects.runtimeProfile)
		) {
			throw new Error("Agent Embodiment does not exactly bind the requested Agent Ontology");
		}
	}

	return {
		sessionId,
		generation,
		runtime,
		runtimeDigest,
		ontology,
		ontologyDigest,
		...(embodiment && embodimentRef && embodimentDigest ? { embodiment, embodimentRef, embodimentDigest } : {}),
	};
}

/**
 * Optional because legacy resident sessions predate fenced materializations.
 * When present it is a host-derived durable activation identity, so reject
 * malformed values before they can reach H's witness/result store assertions.
 */
function parseOptionalHostMaterializationActivationId(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value, "utf8") > 256) {
		throw new Error("Host materialization activation id must be non-empty and bounded");
	}
	return value;
}

function admitAgentExecution(config: AgentWorkerConfig, sandboxMode: SandboxMode): void {
	const semantic = resolveAgentSemanticAuthority(config.request ?? {}, config);
	resolveSealedContentAuthority(config.request ?? {}, config);
	const expectedArtifactDigest =
		sandboxMode === "local-native"
			? digestLocalAgentRuntime(resolveSophiaAgentLocalEntrypoint())
			: `sha256:${resolveRuntimeBundleDescriptor(SOPHIA_AGENT_RUNTIME_BUNDLE_ID).digest}`;
	const baseBundle = semantic.runtime.bundle;
	if (baseBundle.digest !== expectedArtifactDigest) {
		throw new Error(
			`Agent runtime artifact digest mismatch: executed ${expectedArtifactDigest}, binding pins ${baseBundle.digest}`,
		);
	}
	if (sandboxMode === "local-native" && (semantic.embodiment?.runtimeBinding.overlays.length ?? 0) > 0) {
		throw new Error("Prime runtime overlays require the bwrap security boundary");
	}
	if (sandboxMode === "local-native" && config.candidate_workspace) {
		throw new Error("Candidate evolution workspaces require the bwrap security boundary");
	}
}

function resolveSealedContentAuthority(
	request: Partial<AgentSpawnRequest>,
	config: AgentWorkerConfig,
): VerifiedExecutionCapsuleV1 | undefined {
	const requestCapsule = request.verified_execution_capsule;
	const configCapsule = config.verified_execution_capsule;
	if (requestCapsule !== undefined && configCapsule !== undefined && requestCapsule.digest !== configCapsule.digest) {
		throw new Error("Agent request and worker configuration disagree on the verified execution capsule");
	}
	const capsule = requestCapsule ?? configCapsule;
	if (!capsule) return undefined;
	assertVerifiedExecutionCapsuleReplay(capsule, capsule.prompt.finalPromptUtf8);
	if (!isSealedVerifiedExecutionCapsule(capsule)) {
		throw new Error("I-authoritative execution capsule was not sealed by immutable-CAS preflight admission");
	}
	for (const [label, prompt] of [
		["request.system_prompt", request.system_prompt],
		["config.system_prompt", config.system_prompt],
	] as const) {
		if (prompt !== undefined && prompt !== capsule.prompt.finalPromptUtf8) {
			throw new Error(`${label} may not override the sealed I-authority final prompt bytes`);
		}
	}
	return capsule;
}

function formatBytes(bytes?: number): string {
	if (bytes == null) return "n/a";
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function contentBytes(value: unknown): number {
	return Buffer.byteLength(typeof value === "string" ? value : value == null ? "" : String(value));
}

function safeErrorKind(value: unknown): string {
	if (value instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value.name)) return value.name;
	return "Error";
}

/**
 * A separate OS identity for local-native bodies. With it, a body cannot read
 * the orchestrator's /proc/<pid>/environ (provider keys, service tokens) or any
 * orchestrator-only file, because the kernel refuses cross-uid access. Without
 * it, bodies share the orchestrator's uid and that boundary is absent.
 */
export interface LocalNativeBodyIdentity {
	readonly uid: number;
	readonly gid: number;
	/** Body-owned HOME/TMPDIR, so a body never writes into orchestrator paths. */
	readonly home?: string;
}

/**
 * CHOREOGRAPH_LOCAL_NATIVE_BODY_UID / _GID (numeric) and optional _HOME. Unset
 * means the legacy same-uid harness. Set but unusable fails closed at startup:
 * the orchestrator must be root to switch identity, and the body uid must differ.
 */
export function resolveLocalNativeBodyIdentity(
	environment: NodeJS.ProcessEnv,
	orchestratorUid: number | undefined = process.getuid?.(),
): LocalNativeBodyIdentity | undefined {
	const rawUid = environment.CHOREOGRAPH_LOCAL_NATIVE_BODY_UID?.trim();
	const rawGid = environment.CHOREOGRAPH_LOCAL_NATIVE_BODY_GID?.trim();
	if (!rawUid && !rawGid) return undefined;
	const parse = (name: string, raw: string | undefined): number => {
		if (!raw || !/^[0-9]{1,10}$/.test(raw))
			throw new Error(`${name} must be a numeric id, got ${JSON.stringify(raw ?? "")}`);
		return Number(raw);
	};
	const uid = parse("CHOREOGRAPH_LOCAL_NATIVE_BODY_UID", rawUid);
	const gid = parse("CHOREOGRAPH_LOCAL_NATIVE_BODY_GID", rawGid);
	if (uid === 0 || gid === 0) throw new Error("local-native bodies must not run as root");
	if (orchestratorUid === undefined) throw new Error("local-native body identity needs a POSIX host");
	if (orchestratorUid !== 0) {
		throw new Error(
			`local-native body identity ${uid}:${gid} needs the orchestrator to run as root (it runs as ${orchestratorUid})`,
		);
	}
	const home = environment.CHOREOGRAPH_LOCAL_NATIVE_BODY_HOME?.trim();
	if (home !== undefined && home !== "" && !isAbsolute(home)) {
		throw new Error("CHOREOGRAPH_LOCAL_NATIVE_BODY_HOME must be an absolute path");
	}
	return { uid, gid, ...(home ? { home: resolve(home) } : {}) };
}

export function localNativeLaunch(
	worker: string | WorkerEntrypoint,
	runtimeEnvironment?: Record<string, string>,
	body?: LocalNativeBodyIdentity,
): {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	cwd?: string;
	uid?: number;
	gid?: number;
} {
	const entrypoint = localNativeEntrypoint(worker);
	const env: NodeJS.ProcessEnv = { ...localNativeSandboxEnvironment(process.env), ...(runtimeEnvironment ?? {}) };
	if (body?.home) {
		mkdirSync(body.home, { recursive: true, mode: 0o700 });
		chownSync(body.home, body.uid, body.gid);
		env.HOME = body.home;
		env.TMPDIR = body.home;
	}
	return {
		command: process.execPath,
		args: entrypoint.endsWith(".ts") ? ["--import", "tsx", entrypoint] : [entrypoint],
		env,
		...(entrypoint.endsWith(".ts") ? { cwd: resolveLocalNativeSourceProjectRoot(entrypoint) } : {}),
		...(body ? { uid: body.uid, gid: body.gid } : {}),
	};
}

/**
 * Source-mode runtime bundles need their own tsconfig path aliases. The child
 * otherwise inherits Choreograph's cwd and resolves workspace packages through
 * unbuilt `dist/` exports instead of the reviewed TypeScript source graph.
 */
export function resolveLocalNativeSourceProjectRoot(entrypoint: string): string {
	let directory = dirname(resolve(entrypoint));
	while (true) {
		if (existsSync(join(directory, "tsconfig.json"))) return directory;
		const parent = dirname(directory);
		if (parent === directory) {
			throw new Error(`No tsconfig.json found above local-native TypeScript entrypoint: ${entrypoint}`);
		}
		directory = parent;
	}
}

/** Keep host-edge authority out of the intentionally weaker macOS dev harness too. */
export function localNativeSandboxEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const sandboxEnvironment = { ...environment };
	const secretNames = new Set([
		...Object.values(PROVIDER_REGISTRY)
			.map((entry) => entry.keyEnv)
			.filter((name): name is string => Boolean(name)),
		"ANTHROPIC_API_KEY",
		"OPENAI_API_KEY",
		"PRIME_API_KEY",
		"GITHUB_EFFECT_TOKEN",
		"GITHUB_TOKEN",
		"GH_TOKEN",
		"DISCORD_TOKEN",
		"PHANES_CAPABILITY_TOKEN",
		"PHANES_TRANSCRIBE_TOKEN",
		"MNEMOSYNE_API_TOKEN",
		"MNEMOSYNE_MCP_ACCESS_TOKEN",
		"MNEMOSYNE_SERVICE_TOKEN",
		"MNEMOSYNE_INTERNAL_SERVICE_SECRET",
		"GARDEN_TOKEN",
		"GARDEND_TOKEN",
		"GARDEN_LOOPBACK_TOKEN",
		"GARDEN_SERVICE_TOKEN",
		"STRIPE_SECRET_KEY",
		"STRIPE_WEBHOOK_SECRET",
		"HOJA_PROBE_PASSWORD",
		"NPM_TOKEN",
		"NODE_AUTH_TOKEN",
		"VAULT_TOKEN",
		"AWS_ACCESS_KEY_ID",
		"AWS_SECRET_ACCESS_KEY",
		"AWS_SESSION_TOKEN",
		"AWS_WEB_IDENTITY_TOKEN_FILE",
		"AWS_SHARED_CREDENTIALS_FILE",
		"AWS_CONFIG_FILE",
		"AWS_PROFILE",
		"PROVIDER_CREDENTIALS_SSM_PREFIX",
		"PROVIDER_CREDENTIALS_KMS_KEY_ID",
		"KUBECONFIG",
		"GOOGLE_APPLICATION_CREDENTIALS",
		"SSH_AUTH_SOCK",
		"GPG_AGENT_INFO",
		"DATABASE_URL",
		"REDIS_URL",
	]);
	for (const name of Object.keys(sandboxEnvironment)) {
		if (secretNames.has(name) || isSecretEnvironmentName(name)) delete sandboxEnvironment[name];
	}
	return {
		...sandboxEnvironment,
		NODE_NO_WARNINGS: environment.NODE_NO_WARNINGS ?? "1",
		CHOREOGRAPH_SANDBOX: environment.CHOREOGRAPH_SANDBOX ?? "local-native",
	};
}

function isSecretEnvironmentName(name: string): boolean {
	return /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|AUTHORIZATION|COOKIE)(?:_|$)/i.test(
		name,
	);
}

function resolveSophiaAgentLocalEntrypoint(): string {
	const configured = process.env.SOPHIA_AGENT_RUNTIME_ENTRYPOINT?.trim();
	if (!configured) {
		throw new Error(
			"SOPHIA_AGENT_RUNTIME_ENTRYPOINT is required for an agent node in local-native mode; point it at Sophia host-worker.js or host-worker.ts",
		);
	}
	return resolve(configured);
}

function localNativeEntrypoint(worker: string | WorkerEntrypoint): string {
	if (typeof worker === "string") {
		return resolve(worker);
	}
	if (worker.hostScriptPath) {
		return resolve(worker.hostScriptPath);
	}
	if (worker.sandboxEntrypointPath) {
		throw new Error(
			`local-native sandbox mode cannot resolve sandbox-only entrypoint ${worker.sandboxEntrypointPath}`,
		);
	}
	throw new Error("Worker entrypoint must provide either hostScriptPath or sandboxEntrypointPath");
}

export function buildDefaultMnemosyneDescriptor(options?: MnemosyneRequestOptions): MnemosyneSessionDescriptor {
	const apiBaseUrl = options?.apiBaseUrl?.trim() || process.env.MNEMOSYNE_API_BASE_URL?.trim();
	const explicitMcpUrl = options?.mcpUrl?.trim() || process.env.MNEMOSYNE_MCP_URL?.trim();
	// Gateway service-auth (platform-next): the real per-graph MCP URL is built
	// inside the proxy from MNEMOSYNE_GATEWAY_BASE_URL + the graph id, so having
	// service-auth configured is enough to enable the hosted path even without an
	// explicit API base / MCP URL. The `{base}/g` here is just a non-"disabled"
	// marker; the proxy ignores preferredMcpUrl in service-auth mode.
	const gatewayServiceBase =
		process.env.MNEMOSYNE_SERVICE_TOKEN?.trim() && process.env.MNEMOSYNE_GATEWAY_BASE_URL?.trim()
			? process.env.MNEMOSYNE_GATEWAY_BASE_URL.trim().replace(/\/$/, "")
			: undefined;
	// Gateway service-auth wins over MNEMOSYNE_API_BASE_URL: when both are set the
	// proxy uses the gateway per-graph path and never dials the legacy control
	// plane, so the descriptor marker (and the spawner log that reads it) must
	// reflect the gateway, not stale `/mcp`. Explicit overrides still win first;
	// legacy mode (no service-auth) is unchanged (apiBaseUrl `/mcp`).
	const hostedMcpUrl = explicitMcpUrl
		? explicitMcpUrl
		: gatewayServiceBase
			? `${gatewayServiceBase}/g`
			: apiBaseUrl
				? new URL("/mcp", apiBaseUrl).toString()
				: undefined;

	if (!hostedMcpUrl) {
		return {
			mcp_url: "disabled",
			session_token: "disabled",
			graph_scope: {
				// Transport may be disabled in a local supervisor, but its durable
				// Session authority is still exact and must reach restored workers.
				...(options?.ownerPrincipal?.trim() ? { default_graph_owner: options.ownerPrincipal.trim() } : {}),
				default_graph_id: options?.graphId?.trim() || "disabled",
			},
			tool_profile: "chat",
			expires_at: new Date(Date.now() + 3_600_000).toISOString(),
		};
	}

	return {
		mcp_url: hostedMcpUrl,
		session_token: "host-proxy",
		graph_scope: {
			...(options?.ownerPrincipal?.trim() || process.env.MNEMOSYNE_GRAPH_OWNER?.trim()
				? {
						default_graph_owner: options?.ownerPrincipal?.trim() || process.env.MNEMOSYNE_GRAPH_OWNER?.trim(),
					}
				: {}),
			default_graph_id: options?.graphId?.trim() || process.env.MNEMOSYNE_GRAPH_ID?.trim() || "choreograph-2",
		},
		// PER-AGENT GEIST PRECONDITION (CA-1 observer seam): the Geist-family tools
		// recall/music/sing are NOT in the `chat` profile — the hosted cell only
		// surfaces them under `familiar`/`full`. (`remember` is the exception: it is
		// in choreograph's curated CHAT_SERVICE_TOOLSET and the cell's chat profile.)
		// So for an agent to SEE the full Geist surface the observer seam targets, its
		// `tool_profile` must be `familiar`/`full`. This is SETTABLE PER-SPAWN via
		// `options.toolProfile` (MnemosyneRequestOptions.toolProfile); the default is
		// the env (`MNEMOSYNE_TOOL_PROFILE`) or `chat`. The live chat / workflow-engine
		// orchestrator paths already pass `full` (see orchestrator.ts ~1404). We do NOT
		// change the default here — the observer is supplied regardless of profile; the
		// profile only governs which Geist tools are visible to set it on.
		tool_profile: options?.toolProfile ?? readToolProfile(process.env.MNEMOSYNE_TOOL_PROFILE),
		expires_at: new Date(Date.now() + 3_600_000).toISOString(),
	};
}

function isHostedMnemosyneDescriptor(descriptor: MnemosyneSessionDescriptor): boolean {
	return descriptor.mcp_url !== "disabled" && descriptor.mcp_url !== "local-stdio";
}

function readToolProfile(rawValue: string | undefined): MnemosyneSessionDescriptor["tool_profile"] {
	switch (rawValue?.trim()) {
		case "familiar":
			return "familiar";
		case "full":
			return "full";
		case undefined:
		case "":
		case "chat":
			return "chat";
		default:
			throw new Error(`Invalid MNEMOSYNE_TOOL_PROFILE: ${rawValue}`);
	}
}

function parseIntegerEnv(name: string): number | undefined {
	const rawValue = process.env[name]?.trim();
	if (!rawValue) {
		return undefined;
	}

	const parsed = Number.parseInt(rawValue, 10);
	if (!Number.isFinite(parsed)) {
		throw new Error(`${name} must be an integer`);
	}
	return parsed;
}

function parseBooleanEnv(name: string): boolean | undefined {
	const rawValue = process.env[name]?.trim().toLowerCase();
	if (!rawValue) {
		return undefined;
	}

	if (rawValue === "1" || rawValue === "true" || rawValue === "yes") {
		return true;
	}
	if (rawValue === "0" || rawValue === "false" || rawValue === "no") {
		return false;
	}
	throw new Error(`${name} must be a boolean`);
}

function resolveTrustedInferenceModel(active: ActiveSandbox, asserted: unknown): Record<string, unknown> {
	const binding = active.trustedInference;
	if (!binding) throw new Error("Sandbox has no host-pinned inference binding");
	if (typeof asserted !== "object" || asserted === null || Array.isArray(asserted)) {
		throw new Error("Sandbox sent a non-object inference model");
	}
	const candidate = asserted as Record<string, unknown>;
	const candidateId = typeof candidate.id === "string" ? candidate.id : "";
	const candidateProvider = typeof candidate.provider === "string" ? candidate.provider : "";
	const isDefault = candidateId === binding.model && candidateProvider === binding.provider;
	const admittedDescriptor = isDefault
		? binding.descriptor
		: binding.allowedModels?.get(`${candidateProvider}/${candidateId}`);
	if (!isDefault && !admittedDescriptor) {
		throw new Error(`Sandbox model is not host-admitted for this session: ${candidateProvider}/${candidateId}`);
	}
	const provider = resolveProviderEntry(candidateProvider);
	if (!provider) throw new Error(`Unsupported host-pinned provider: ${candidateProvider}`);
	const profileMaxTokens =
		active.runtimeBinding?.constraints.maxCompletionTokensPerCall ??
		active.runtimeBinding?.constraints.maxTokens ??
		Number.MAX_SAFE_INTEGER;
	if (admittedDescriptor) {
		assertOpenRouterRoutingCarried(candidateProvider, admittedDescriptor.api);
		return {
			...admittedDescriptor,
			baseUrl: provider.baseUrl,
			maxTokens: Math.min(admittedDescriptor.maxTokens, profileMaxTokens),
		};
	}

	const api = typeof candidate.api === "string" ? candidate.api : "openai-completions";
	if (!new Set(["openai-completions", "anthropic-messages"]).has(api)) {
		throw new Error(`Sandbox requested unsupported inference API: ${api}`);
	}
	assertOpenRouterRoutingCarried(candidateProvider, api);
	const input = Array.isArray(candidate.input)
		? candidate.input.filter((entry): entry is "text" | "image" => entry === "text" || entry === "image")
		: ["text" as const];
	const contextWindow = positiveModelInteger(candidate.contextWindow, 128_000);
	const requestedMaxTokens = positiveModelInteger(candidate.maxTokens, 4096);
	return {
		id: candidateId,
		name: typeof candidate.name === "string" && candidate.name ? candidate.name : candidateId,
		api,
		provider: candidateProvider,
		baseUrl: provider.baseUrl,
		reasoning: candidate.reasoning === true,
		input: input.length > 0 ? input : ["text"],
		cost: normalizeModelCost(candidate.cost),
		contextWindow,
		maxTokens: Math.min(requestedMaxTokens, profileMaxTokens),
	};
}

/**
 * Every OpenRouter call carries the host's provider routing (`compat.openRouterRouting`, with `require_parameters`, so an
 * endpoint without the call's tools never qualifies). Only Pi's openai-completions serializer sends it; its Anthropic
 * serializer drops it (exam 1, finding 6). So an OpenRouter model on any other API is refused, whoever asserted it.
 */
function assertOpenRouterRoutingCarried(provider: string, api: unknown): void {
	if (provider === "openrouter" && api !== "openai-completions") {
		throw new Error(
			`OpenRouter inference must use the openai-completions API, the one that carries provider routing (require_parameters); refused ${String(api)}`,
		);
	}
}

function estimateInferenceContextTokens(context: unknown): number {
	try {
		// One token per canonical UTF-8 byte is a deliberately conservative upper
		// bound. Provider tokenizers can only settle downward from this reservation.
		return Math.max(1, Buffer.byteLength(canonicalJson(context), "utf8"));
	} catch {
		throw new Error("Agent inference context is not JSON-serializable");
	}
}

function buildInferenceSettlement(input: {
	event: Extract<ProxyAssistantMessageEvent, { type: "done" | "error" }>;
	active: ActiveSandbox;
	reservation: DurableInferenceReservation;
	providerName: string;
	modelName: string;
	durationMs: number;
	now: number;
	/** The call was the one retry without the card's ceiling (`openrouter-fallback.ts`). */
	fallback?: boolean;
}): {
	usage: { turns: number; wallTimeMs: number; tokens: number; costUsdMicros: number; artifactBytes: number };
	billingEvent: AgentSessionInferenceBillingEvent;
} {
	const observed = input.event.usage;
	for (const [name, value] of Object.entries({
		input: observed.input,
		output: observed.output,
		cacheRead: observed.cacheRead,
		cacheWrite: observed.cacheWrite,
		totalTokens: observed.totalTokens,
	})) {
		if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Provider usage ${name} is invalid`);
	}
	const inputAndOutput = observed.input + observed.output;
	if (!Number.isSafeInteger(inputAndOutput)) throw new Error("Provider token usage exceeded safe integer range");
	const accountedTokens = Math.max(observed.totalTokens, inputAndOutput);
	const card = input.reservation.rateCard;
	const atCard = priceInferenceCall({
		card,
		model: input.modelName,
		provider: input.providerName,
		tokens: {
			input: observed.input,
			output: observed.output,
			cacheRead: observed.cacheRead,
			cacheWrite: observed.cacheWrite,
		},
	});
	// Normally the card. A fallback is billed at what OpenRouter reports it charged, plus the card's markup; one whose
	// charge did not come back is billed at the card and says so. The card's figure is kept beside the actual.
	const providerUsage = input.event.type === "done" ? input.event.providerUsage : undefined;
	let cost = atCard;
	let pricingBasis: UsageEventInput["pricingBasis"] = card ? "card" : undefined;
	let reportedCostMicroUsd: number | null = null;
	if (card && input.fallback) {
		const charged = providerUsage ? providerChargeMicroUsd(providerUsage.costUsd) : null;
		if (charged !== null) {
			cost = priceAtProviderReport(atCard, charged, card.markupBps);
			pricingBasis = "fallback-actual";
			reportedCostMicroUsd = charged;
		} else {
			pricingBasis = "fallback-card";
		}
	}
	const billingEvent: AgentSessionInferenceBillingEvent = {
		eventId: input.reservation.operationId,
		fundingSource: input.reservation.fundingSource,
		ts: input.now,
		userId: input.reservation.billingProvenance.userId,
		graphId: input.reservation.billingProvenance.graphId,
		sandboxId: input.reservation.fence.sandboxId,
		template: input.active.record.template,
		sessionId: input.active.agentRequest!.session_id,
		generation: input.reservation.fence.generation,
		inferenceOperationId: input.reservation.operationId,
		requestId: input.reservation.fence.requestId,
		childRunId: input.reservation.billingProvenance.childRunId,
		allocationId: input.reservation.billingProvenance.allocationId,
		provider: input.providerName,
		model: input.modelName,
		modelPriced: cost.modelPriced,
		reason: input.event.reason,
		inputTokens: observed.input,
		outputTokens: observed.output,
		cacheReadTokens: observed.cacheRead,
		cacheWriteTokens: observed.cacheWrite,
		totalTokens: observed.totalTokens,
		inputCostMicroUsd: cost.inputCostMicroUsd,
		outputCostMicroUsd: cost.outputCostMicroUsd,
		cacheReadCostMicroUsd: cost.cacheReadCostMicroUsd,
		cacheWriteCostMicroUsd: cost.cacheWriteCostMicroUsd,
		providerCostMicroUsd: cost.providerCostMicroUsd,
		// Pi's `usage.cost` is Pi's arithmetic over a static catalogue table, not the provider's charge (price-gap,
		// 2026-10-01): the provider's own receipt is read from its generation record by the receipts reconciler.
		providerReportedCostMicroUsd: reportedCostMicroUsd,
		providerGenerationId: input.event.responseId ?? providerUsage?.generationId ?? null,
		...(pricingBasis
			? {
					pricingBasis,
					cardCostMicroUsd: atCard.totalCostMicroUsd,
					cardProviderCostMicroUsd: atCard.providerCostMicroUsd,
				}
			: {}),
		markupMicroUsd: cost.markupMicroUsd,
		costMicroUsd: cost.totalCostMicroUsd,
		pricingVersion: input.reservation.rateCard?.version ?? staticPricingVersion(),
		pricedDefault: cost.pricedDefault,
	};
	return {
		usage: {
			turns: 1,
			wallTimeMs: input.durationMs,
			tokens: accountedTokens,
			costUsdMicros: cost.totalCostMicroUsd,
			artifactBytes: 0,
		},
		billingEvent,
	};
}

function boundedInferenceFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (Buffer.byteLength(message, "utf8") <= 2000) return message || "Inference failed";
	return Buffer.from(message, "utf8").subarray(0, 2000).toString("utf8");
}

function sameBillingUsageEvent(expected: UsageEventInput, actual: UsageEventRecord): boolean {
	return canonicalJson(normalizeBillingUsageEvent(expected)) === canonicalJson(normalizeBillingUsageEvent(actual));
}

function normalizeBillingUsageEvent(value: UsageEventInput): Record<string, unknown> {
	return {
		eventId: value.eventId,
		fundingSource: value.fundingSource ?? "platform",
		ts: value.ts,
		userId: value.userId,
		graphId: value.graphId,
		sandboxId: value.sandboxId,
		template: value.template,
		sessionId: value.sessionId ?? null,
		generation: value.generation ?? null,
		inferenceOperationId: value.inferenceOperationId ?? null,
		requestId: value.requestId ?? null,
		childRunId: value.childRunId ?? null,
		allocationId: value.allocationId ?? null,
		provider: value.provider,
		model: value.model,
		modelPriced: value.modelPriced,
		reason: value.reason,
		inputTokens: value.inputTokens,
		outputTokens: value.outputTokens,
		cacheReadTokens: value.cacheReadTokens,
		cacheWriteTokens: value.cacheWriteTokens,
		totalTokens: value.totalTokens,
		inputCostMicroUsd: value.inputCostMicroUsd,
		outputCostMicroUsd: value.outputCostMicroUsd,
		cacheReadCostMicroUsd: value.cacheReadCostMicroUsd,
		cacheWriteCostMicroUsd: value.cacheWriteCostMicroUsd,
		providerCostMicroUsd: value.providerCostMicroUsd,
		providerReportedCostMicroUsd: value.providerReportedCostMicroUsd ?? null,
		providerGenerationId: value.providerGenerationId ?? null,
		pricingBasis: value.pricingBasis ?? null,
		cardCostMicroUsd: value.cardCostMicroUsd ?? null,
		cardProviderCostMicroUsd: value.cardProviderCostMicroUsd ?? null,
		markupMicroUsd: value.markupMicroUsd,
		costMicroUsd: value.costMicroUsd,
		pricingVersion: value.pricingVersion,
		pricedDefault: value.pricedDefault,
	};
}

function positiveModelInteger(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizeModelCost(value: unknown): Record<"input" | "output" | "cacheRead" | "cacheWrite", number> {
	const candidate = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	return {
		input: nonNegativeModelNumber(candidate.input),
		output: nonNegativeModelNumber(candidate.output),
		cacheRead: nonNegativeModelNumber(candidate.cacheRead),
		cacheWrite: nonNegativeModelNumber(candidate.cacheWrite),
	};
}

function nonNegativeModelNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function getModelName(model: unknown): string {
	if (typeof model === "string") return model;
	if (typeof model !== "object" || model === null) return "unknown";
	const candidate = model as { id?: unknown; name?: unknown };
	if (typeof candidate.id === "string" && candidate.id) return candidate.id;
	if (typeof candidate.name === "string" && candidate.name) return candidate.name;
	return "unknown";
}

function getModelProvider(model: unknown): string {
	if (typeof model !== "object" || model === null) return "openrouter";
	const candidate = model as { provider?: unknown };
	return typeof candidate.provider === "string" && candidate.provider.trim()
		? candidate.provider.trim().toLowerCase()
		: "openrouter";
}

/**
 * Close all backends in a capability registry.  Best-effort — errors are logged
 * but do not propagate (registry close is always called in finally / cleanup paths).
 */
async function closeCapabilityRegistry(registry: Map<string, CapabilityBackend> | undefined): Promise<void> {
	if (!registry) return;
	await Promise.allSettled([...new Set(registry.values())].map((b) => b.close()));
}

function cloneCapabilityRegistry(
	registry: ReadonlyMap<string, CapabilityBackend> | undefined,
): Map<string, CapabilityBackend> | undefined {
	if (!registry || registry.size === 0) return undefined;
	return new Map(registry);
}

function mergeCapabilityRegistry(
	target: Map<string, CapabilityBackend> | undefined,
	additional: ReadonlyMap<string, CapabilityBackend> | undefined,
): void {
	if (!additional?.size) return;
	if (!target) {
		throw new Error("internal capability registry was not initialized");
	}
	for (const [name, backend] of additional) {
		if (target.has(name)) {
			throw new Error(`Capability backend already registered for "${name}"`);
		}
		target.set(name, backend);
	}
}

function capabilityFailureOutcome(error: unknown): "error" | "denied" {
	if (!error || typeof error !== "object") return "error";
	const candidate = error as { code?: unknown; status?: unknown };
	return candidate.code === "capability_denied" || candidate.status === 403 ? "denied" : "error";
}

/**
 * The payload the worker is given for a durable command. A turn (`prompt`, `follow_up`) that carries what the person has
 * open (`contextRefs`, D5) is given to the model as one text: the person's words and a note naming those ids
 * (`turnTextForModel`). The refs field itself never reaches the worker, and the person's words are kept by command id
 * so the worker's echo of the turn is mirrored as they wrote it. Every other command is delivered exactly as stored.
 */
function workerCommandPayload(
	active: ActiveSandbox,
	command: AgentSessionCommandRecord,
	admittedContextRefs: readonly string[],
): Record<string, unknown> {
	const payload = command.payload as Record<string, unknown>;
	if ((command.name !== "prompt" && command.name !== "follow_up") || !Object.hasOwn(payload, "contextRefs")) {
		return payload;
	}
	const { contextRefs: _sent, ...rest } = payload;
	const text = String(payload.text);
	// Only refs the session's graph answered for the person are named (`admitCommandContextRefs`), never the sent list.
	const modelText = turnTextForModel(text, admittedContextRefs);
	if (modelText !== text) {
		active.personTurnTexts ??= new Map();
		active.personTurnTexts.set(command.command_id, text);
	}
	return { ...rest, text: modelText };
}

/** The worker's echo of a turn delivered with a context note, mirrored with the person's own words (D5). */
function withPersonTurnText(event: SandboxEvent, active: ActiveSandbox): SandboxEvent {
	if ((event.type !== "prompt" && event.type !== "follow_up") || !active.personTurnTexts) return event;
	const text = active.personTurnTexts.get(event.command_id);
	if (text === undefined) return event;
	active.personTurnTexts.delete(event.command_id);
	return { ...event, text };
}

function bridgeCommandName(
	name: AgentSessionCommandName,
):
	| "input.prompt"
	| "input.follow_up"
	| "input.steer"
	| "input.abort"
	| "runtime.quiesce"
	| "goal.get"
	| "goal.create"
	| "goal.complete" {
	switch (name) {
		case "prompt":
			return "input.prompt";
		case "follow_up":
			return "input.follow_up";
		case "steer":
			return "input.steer";
		case "abort":
			return "input.abort";
		case "quiesce":
			return "runtime.quiesce";
		case "goal.get":
			return "goal.get";
		case "goal.create":
			return "goal.create";
		case "goal.complete":
			return "goal.complete";
	}
}

function isPrimeGoalCommandName(
	name: AgentSessionCommandName,
): name is Extract<AgentSessionCommandName, "goal.get" | "goal.create" | "goal.complete"> {
	return name === "goal.get" || name === "goal.create" || name === "goal.complete";
}

/** An MCP tool result the cell answered with `isError: true` (a refusal that is not a transport error). */
function isToolErrorResult(result: unknown): boolean {
	return result !== null && typeof result === "object" && (result as { isError?: unknown }).isError === true;
}

function primeWorkerEventToSandboxEvent(message: PrimeWorkerEventV1, request: AgentSpawnRequest): SandboxEvent {
	const payload = message.payload as Record<string, unknown>;
	switch (message.name) {
		case "input.prompt":
			return { type: "prompt", text: String(payload.text), command_id: String(message.commandId) };
		case "input.follow_up":
			return { type: "follow_up", text: String(payload.text), command_id: String(message.commandId) };
		case "input.steer":
			return {
				type: "steer",
				text: String(payload.text),
				...(message.commandId ? { command_id: message.commandId } : {}),
				...(typeof payload.clientId === "string" ? { client_id: payload.clientId } : {}),
			};
		case "turn.started":
			return { type: "turn_start", turn: Number(payload.turn) };
		case "turn.completed":
			return { type: "turn_end", turn: Number(payload.turn) };
		case "turn.failed":
			return { type: "error", message: String(payload.message) };
		case "message.delta":
			return { type: "text", content: String(payload.delta) };
		case "message.completed":
			return { type: "done", output: String(payload.output) };
		case "reasoning.delta":
			return { type: "thinking", content: String(payload.delta) };
		case "tool.started":
			return {
				type: "tool_call",
				gate: String(payload.tool),
				args:
					typeof payload.args === "object" && payload.args !== null && !Array.isArray(payload.args)
						? (payload.args as Record<string, unknown>)
						: {},
			};
		case "tool.completed":
		case "tool.failed":
			return {
				type: "tool_result",
				gate: String(payload.tool),
				result: String(payload.result ?? ""),
				is_error: message.name === "tool.failed",
				...(typeof payload.cellRef === "string" ? { cell_ref: payload.cellRef } : {}),
			};
		case "budget.exhausted":
			return { type: "truncated", output: String(payload.output), turns: Number(payload.turns) };
		case "goal.updated":
		case "compaction.started":
		case "compaction.completed":
		case "refine.completed":
		case "refine.failed":
		case "recap.updated":
			return {
				type: "prime_event",
				name: primeSemanticSourceName(message.name),
				payload: message.payload,
				session_id: request.session_id,
				runtime_binding_digest: request.runtime_binding_digest,
				agent_ontology_binding_digest: request.agent_ontology_binding_digest,
			};
	}
}

function primeSemanticSourceName(
	name:
		| "goal.updated"
		| "compaction.started"
		| "compaction.completed"
		| "refine.completed"
		| "refine.failed"
		| "recap.updated",
): string {
	switch (name) {
		case "goal.updated":
			return "goal_update";
		case "compaction.started":
			return "compaction_start";
		case "compaction.completed":
			return "compaction_end";
		case "refine.completed":
			return "refine_complete";
		case "refine.failed":
			return "refine_failed";
		case "recap.updated":
			return "recap_update";
	}
}

function inferenceBridgeError(event: Extract<ProxyAssistantMessageEvent, { type: "error" }>): PrimeHostErrorV1 {
	const message =
		event.errorMessage ?? (event.reason === "aborted" ? "Inference request cancelled" : "Inference failed");
	const normalized = message.toLowerCase();
	const details = { reason: event.reason, usage: event.usage };
	if (event.reason === "aborted") {
		return { code: "inference_cancelled", class: "cancelled", message, retryable: false, details };
	}
	if (message.startsWith(INSUFFICIENT_CREDIT_PREFIX)) {
		// The person's balance cannot fund the call: a retry cannot fix it.
		return { code: "inference_credit_exhausted", class: "budget", message, retryable: false, details };
	}
	if (message.startsWith(PROVIDER_UNAVAILABLE_PREFIX)) {
		return { code: PROVIDER_UNAVAILABLE_CODE, class: "unavailable", message, retryable: true, details };
	}
	if (/\bbudget\b|token limit|cost limit|spend limit/.test(normalized)) {
		return { code: "inference_budget_exhausted", class: "budget", message, retryable: false, details };
	}
	if (/model drift|non-object inference model|unsupported inference|validation/.test(normalized)) {
		return { code: "inference_invalid", class: "invalid", message, retryable: false, details };
	}
	return { code: "inference_failed", class: "unavailable", message, retryable: true, details };
}

function capabilityBridgeError(error: unknown): PrimeHostErrorV1 {
	if (isPrimeHostError(error)) return error;
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : JSON.stringify(error);
	const safeMessage = message || "Capability request failed";
	const normalized = safeMessage.toLowerCase();
	if (
		(error instanceof Error && error.name === "AbortError") ||
		/\babort(?:ed)?\b|\bcancel(?:led|ed)?\b/.test(normalized)
	) {
		return { code: "capability_cancelled", class: "cancelled", message: safeMessage, retryable: false };
	}
	if (/no capability backend|not found|unknown capability/.test(normalized)) {
		return { code: "capability_backend_not_found", class: "not_found", message: safeMessage, retryable: false };
	}
	if (/denied|not permitted|not granted|read-only|forbidden/.test(normalized)) {
		return { code: "capability_denied", class: "denied", message: safeMessage, retryable: false };
	}
	if (/timeout|timed out|deadline/.test(normalized)) {
		return { code: "capability_deadline", class: "deadline", message: safeMessage, retryable: true };
	}
	return { code: "capability_failed", class: "internal", message: safeMessage, retryable: false };
}

function childHostRequestError(error: unknown): PrimeHostErrorV1 {
	if (error instanceof AgentSessionChildHostRequestFault) {
		return {
			code: error.code,
			class: error.errorClass,
			message: error.message,
			retryable: error.retryable,
		};
	}
	return {
		code: "child_runtime_unavailable",
		class: "unavailable",
		message: error instanceof Error ? error.message : String(error),
		retryable: false,
	};
}

function heartbeatHostError(error: unknown): PrimeHostErrorV1 {
	if (error instanceof AgentSessionHeartbeatHostRequestFault) return error.structured;
	if (error instanceof AgentSessionScheduleFault) {
		const unavailable = error.reason === "lease_lost" || error.reason === "lease_expired";
		const notFound = error.reason === "session_not_found" || error.reason === "schedule_not_found";
		return {
			code: error.code,
			class: unavailable
				? "unavailable"
				: notFound
					? "not_found"
					: error.reason === "request_conflict"
						? "conflict"
						: "invalid",
			message: error.message,
			retryable: unavailable,
		};
	}
	return {
		code: "rlm_heartbeat_unavailable",
		class: "unavailable",
		message: "Heartbeat host is temporarily unavailable",
		retryable: true,
	};
}

function renderHeartbeatInterval(intervalMs: number): string {
	if (intervalMs % 3_600_000 === 0) return `every ${intervalMs / 3_600_000}h`;
	if (intervalMs % 60_000 === 0) return `every ${intervalMs / 60_000}m`;
	return `every ${intervalMs / 1_000}s`;
}

function kernelBridgeError(error: unknown): PrimeHostErrorV1 {
	const message = error instanceof Error ? error.message : String(error);
	const normalized = message.toLowerCase();
	if ((error instanceof Error && error.name === "AbortError") || /abort|cancel/.test(normalized)) {
		return { code: "kernel_cancelled", class: "cancelled", message, retryable: false };
	}
	if (/lease.*not found|does not belong/.test(normalized)) {
		return { code: "kernel_lease_not_found", class: "not_found", message, retryable: false };
	}
	if (/not granted|denied|forbidden/.test(normalized)) {
		return { code: "kernel_denied", class: "denied", message, retryable: false };
	}
	if (/timeout|timed out|deadline/.test(normalized)) {
		return { code: "kernel_deadline", class: "deadline", message, retryable: true };
	}
	return { code: "kernel_failed", class: "unavailable", message, retryable: true };
}

function isPrimeHostError(value: unknown): value is PrimeHostErrorV1 {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<PrimeHostErrorV1>;
	return (
		typeof candidate.code === "string" &&
		[
			"invalid",
			"denied",
			"not_found",
			"conflict",
			"cancelled",
			"deadline",
			"budget",
			"unavailable",
			"internal",
		].includes(candidate.class ?? "") &&
		typeof candidate.message === "string" &&
		typeof candidate.retryable === "boolean"
	);
}

/** Exact error testimony accepted by the Rust bridge and kernel-side RLM edge. */
export function normalizeKernelHostError(value: unknown): RlmHostError {
	if (!isPrimeHostError(value)) {
		throw new Error("kernel host response requires structured Prime error testimony");
	}
	const errorClass =
		value.class === "cancelled"
			? "conflict"
			: value.class === "deadline"
				? "unavailable"
				: value.class === "budget"
					? "denied"
					: value.class;
	return parseRlmHostError({
		code: value.code,
		class: errorClass,
		message: value.message,
		retryable:
			value.class === "deadline"
				? true
				: value.class === "cancelled" || value.class === "budget"
					? false
					: value.retryable,
	});
}

/** Preserve bridge liveness while ensuring invalid testimony never crosses it. */
export function kernelHostErrorForBridge(value: unknown, onInvalid?: (error: unknown) => void): RlmHostError {
	try {
		return normalizeKernelHostError(value);
	} catch (error) {
		onInvalid?.(error);
		return {
			code: "kernel_host_error_invalid",
			class: "internal",
			message: "Kernel host error testimony was invalid",
			retryable: false,
		};
	}
}

/** Fan terminal usage to OTEL and content-free Observatory testimony. */
function recordProxyUsage(
	event: Extract<ProxyAssistantMessageEvent, { type: "done" | "error" }>,
	active: ActiveSandbox,
	providerName: string,
	modelName: string,
	capture?: CaptureEmitter,
	durationMs?: number,
	rateCard?: RateCardV1,
	billedCostMicroUsd?: number,
): void {
	const template = active.record.template;
	if (event.usage.input > 0) {
		llmTokensTotal.add(event.usage.input, { template, provider: providerName, model: modelName, direction: "input" });
	}
	if (event.usage.output > 0) {
		llmTokensTotal.add(event.usage.output, {
			template,
			provider: providerName,
			model: modelName,
			direction: "output",
		});
	}
	if (event.usage.cacheRead > 0) {
		llmTokensTotal.add(event.usage.cacheRead, {
			template,
			provider: providerName,
			model: modelName,
			direction: "cache_read",
		});
	}
	if (event.usage.cacheWrite > 0) {
		llmTokensTotal.add(event.usage.cacheWrite, {
			template,
			provider: providerName,
			model: modelName,
			direction: "cache_write",
		});
	}

	// Capture uses the same deterministic platform price as the durable runtime
	// settlement. BillingStore delivery happens only through the durable outbox.
	const u = event.usage;
	const cost = priceInferenceCall({
		card: rateCard,
		model: modelName,
		provider: providerName,
		tokens: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite },
	});
	const accountingModel = providerModelForAccounting(providerName, modelName);
	emitCaptureSoft(capture, {
		kind: "llm.call",
		...active.captureIdentity,
		outcome: event.type === "done" ? "ok" : "error",
		durationMs,
		payload: {
			model: accountingModel,
			inputTokens: u.input,
			outputTokens: u.output,
			totalTokens: u.totalTokens,
			cacheReadTokens: u.cacheRead > 0 ? u.cacheRead : undefined,
			cacheWriteTokens: u.cacheWrite > 0 ? u.cacheWrite : undefined,
			// What was billed: the settlement's figure when there is one (a fallback is billed at OpenRouter's charge).
			costMicroUsd: billedCostMicroUsd ?? cost.totalCostMicroUsd,
		},
	});
}

function captureIdentityFor(opts: SpawnOptions): CaptureIdentity {
	return captureIdentityForHostedRequest({
		authMethod: opts.authContext?.method,
		ownerUserId: opts.ownerUserId,
		graphId: opts.mnemosyne?.graphId,
	});
}

type CapabilityResultReceipt = Pick<
	CapabilityEvent,
	"result_digest" | "object_refs" | "decision" | "revision" | "reason"
>;

/**
 * Fold a successful host result into content-free semantic testimony. The
 * result body still returns only to the sandbox; shared Agent Session history
 * receives its digest, validated Meaningful Object refs, and bounded CAS facts.
 */
function capabilityResultReceipt(value: unknown): CapabilityResultReceipt {
	const objectRefs = collectMeaningfulObjectRefs(value);
	const root = recordOrUndefined(value);
	const subject = recordOrUndefined(root?.subject);
	const control = recordOrUndefined(subject?.control);
	const revisionValue = root?.revision ?? control?.revision ?? objectRefs[0]?.version;
	const revision =
		typeof revisionValue === "number" && Number.isSafeInteger(revisionValue) && revisionValue >= 0
			? revisionValue
			: typeof revisionValue === "string" && /^\d+$/.test(revisionValue)
				? Number(revisionValue)
				: undefined;
	const reason = typeof root?.reason === "string" && root.reason.length <= 256 ? root.reason : undefined;
	return {
		result_digest: `sha256:${canonicalDigest(value)}`,
		...(objectRefs.length === 0 ? {} : { object_refs: objectRefs }),
		...(root?.applied === true
			? { decision: "accepted" as const }
			: root?.applied === false
				? { decision: "rejected" as const }
				: {}),
		...(revision === undefined || !Number.isSafeInteger(revision) ? {} : { revision }),
		...(reason === undefined ? {} : { reason }),
	};
}

function collectMeaningfulObjectRefs(value: unknown): readonly MeaningfulObjectRefV1[] {
	const refs: MeaningfulObjectRefV1[] = [];
	const keys = new Set<string>();
	const seen = new WeakSet<object>();
	const visit = (candidate: unknown, depth: number): void => {
		if (depth > 12 || refs.length >= 32 || candidate === null || typeof candidate !== "object") return;
		if (seen.has(candidate)) return;
		seen.add(candidate);
		try {
			validateMeaningfulObjectRef(candidate);
			const key = canonicalDigest(candidate);
			if (!keys.has(key)) {
				keys.add(key);
				refs.push(candidate);
			}
			return;
		} catch {
			// Ordinary nested result object; keep looking for explicit MO refs.
		}
		for (const child of Array.isArray(candidate) ? candidate : Object.values(candidate)) {
			visit(child, depth + 1);
		}
	};
	visit(value, 0);
	return refs;
}

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function requiredCommandActivationCoordinate(value: string | null, label: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new AgentSessionCommandActivationTerminalError(`Command activation ${label} is missing`);
	}
	return value;
}

function captureOutcomeForTerminal(state: SandboxRecord["state"]): CaptureOutcome {
	if (state === "done") return "ok";
	if (state === "timeout") return "timeout";
	return "error";
}

function captureReapReason(state: SandboxRecord["state"], exitCode: number | null): string {
	if (state === "done") return "completed";
	if (state === "truncated") return "turn_limit";
	if (state === "timeout") return "timeout";
	if (state === "killed") return "killed";
	if (exitCode === 137) return "oom";
	return "error";
}

function captureSandboxDurationMs(record: SandboxRecord): number | undefined {
	if (!record.running_at || !record.exited_at) return undefined;
	const duration = new Date(record.exited_at).getTime() - new Date(record.running_at).getTime();
	return Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : undefined;
}
