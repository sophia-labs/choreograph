/**
 * Bwrap Sandbox Management — HTTP orchestrator.
 *
 * Standalone spike server that demonstrates:
 *   - SQLite sandbox registry with state machine
 *   - Cgroup v2 resource limits on bwrap processes
 *   - Named templates for sandbox filesystem layout
 *   - Kill via API
 *
 * Run inside Docker (privileged) via:
 *   docker compose up --build
 */

// OTEL SDK must initialize before node:http is imported
import "./telemetry.js";
import "./metrics.js";

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { trace } from "@opentelemetry/api";
import { type RawData, WebSocket, WebSocketServer } from "ws";
import { AuthorityCapabilityBackend } from "./acp/authority-backend.js";
import { authorityFrameToBusEvent } from "./acp/authority-gate.js";
import { InProcessLwwPresence } from "./acp/driver-presence.js";
import {
	type AcpBridgeDeps,
	type AcpRequestEnvelope,
	type AuthorityBusFrame,
	handleAcpRequest,
	isNotDriver,
	parseAcpRequest,
} from "./acp/http-bridge.js";
import { attenuateAgentCapabilitiesForRuntime } from "./agent-runtime/capability-attenuation.js";
import { SophiaContentStore } from "./agent-runtime/content-store.js";
import { makeAgentRuntimeDispatcher, resolvePinnedAgentRuntime } from "./agent-runtime/dispatch.js";
import {
	type PersonalEvolutionController,
	PersonalEvolutionController as PersonalEvolutionControllerImpl,
} from "./agent-runtime/evolution-controller.js";
import { AgentEvolutionStore } from "./agent-runtime/evolution-store.js";
import { PrimeExtensionBuilder } from "./agent-runtime/extension-builder.js";
import { ExtensionEvaluationCoordinator } from "./agent-runtime/extension-evaluation.js";
import { type MeaningfulObjectRefV1, validateMeaningfulObjectRef } from "./agent-runtime/meaningful-object.js";
import { AgentMemory } from "./agent-runtime/memory.js";
import {
	AGENT_SESSION_COMMAND_SCHEMA,
	AgentSessionContractFault,
	validateAgentSessionCommand,
} from "./agent-runtime/session-contract.js";
import { mirrorAgentSessionEvent } from "./agent-runtime/session-event-mirror.js";
import { admitTurnContextRefs, parseTurnContextRefs, TurnContextRefsError } from "./agent-runtime/turn-context.js";
import { canonicalJson } from "./agent-subject/canonical-json.js";
import { SessionStoreIntentLog } from "./agent-subject/intent-log.js";
import { fork, HeadProjection } from "./agent-subject/session-projection.js";
import {
	authMethodLabel,
	extractBearerToken,
	type HostedAuthContext,
	resolveCallerEmail,
	resolveHostedAuthContext,
	resolveHostedCallerUserId,
} from "./auth.js";
import {
	type CheckoutDeps,
	CheckoutRequestError,
	createCheckoutSession,
	createPortalSession,
} from "./billing-checkout.js";
import { CreditAdmission, type InsufficientCreditBody, readBillingGateMode } from "./billing-gate.js";
import { readBillingFee } from "./billing-pricing.js";
import { type RateCardV1, rateCardFromSessionDocumentJson, resolveBillingMarkupBps } from "./billing-rate-card.js";
import {
	CreditHistoryQueryError,
	creditHistoryQuery,
	readBillingBalance,
	readBillingSubscription,
	readBillingUsage,
	readCreditHistory,
	readCreditsStartDate,
	usageWindow,
} from "./billing-read.js";
import { BillingStore, type Tier } from "./billing-store.js";
import { createDefaultHostCapabilityCatalog } from "./capabilities/default-catalog.js";
import { cleanupStaleCgroups, initCgroupHierarchy } from "./cgroup.js";
import { projectChatSessionFacts } from "./chat-catalogue.js";
import { sendCodedError } from "./chat-http.js";
import { ChatModelHealth, composeChatVoiceMarket } from "./chat-model-health.js";
import { CHAT_MODELS_VIEW, handleChatModelCatalogue } from "./chat-model-routes.js";
import { admitWorkspaceChatInference, parseChatModelDenylist, projectChatModelCatalogue } from "./chat-models.js";
import type { ChatVoiceMarket } from "./chat-precision.js";
import { type AgentSeedRefV1, ChatSeedFault, resolveChatSeedRenderBudget } from "./chat-seed.js";
import { handleChatSeedPut } from "./chat-seed-routes.js";
import { CHAT_SESSIONS_VIEW, handleChatSessionList } from "./chat-session-routes.js";
import { pushTierToGateway } from "./entitlements-writer.js";
import { isExecutedDirectly } from "./entrypoint.js";
import { createSandboxEventBus, type SandboxEventBus } from "./event-bus.js";
import { type EvidenceRef, EvidenceStore } from "./evidence-store.js";
import { listFilesystems } from "./filesystems.js";
import { type GatewayGraphAddress, gatewayRequestFacts, sessionIsOnGraph } from "./gateway-request.js";
import { InternalStageRegistry } from "./internal-jobs/registry.js";
import { InternalJobRunner } from "./internal-jobs/runner.js";
import {
	type InternalJobServer,
	type PhanesDomainTriggerRequest,
	type PhanesDomainTriggerSubmitter,
	startInternalJobServer,
} from "./internal-jobs/server.js";
import { InternalJobStore } from "./internal-jobs/store.js";
import { TranscriptionStageDriver } from "./internal-jobs/transcription.js";
import { resolveBridge } from "./kernel-bridges.js";
import { authContextsTotal } from "./metrics.js";
import {
	HostedMnemosyneProxy,
	isDirectMcpAuthConfigured,
	isGatewayServiceAuthConfigured,
	resolveDirectMcpAuth,
	resolveGatewayServiceAuth,
} from "./mnemosyne.js";
import { OpenRouterModelCatalog } from "./model-catalog.js";
import { OpenRouterEndpointsCatalog } from "./model-endpoints.js";
import { HostedNotebookService, type NotebookBinding, notebookBinding } from "./notebooks/service.js";
import { type CaptureEmitter, createCaptureWriterFromEnv } from "./observatory-capture.js";
import { listOpenRouterModels } from "./openrouter.js";
import {
	configureOpenRouterKeyStore,
	handleOpenRouterCredential,
	type OpenRouterKeyStore,
	selectOpenRouterCredential,
} from "./openrouter-credentials.js";
import { createPhanesPrivacyRetirementHandler, PhanesPrivacyEpochGate } from "./privacy/phanes-epoch-retirement.js";
import { resolveRuntimeBundleDescriptor, SOPHIA_AGENT_RUNTIME_BUNDLE_ID } from "./runtime-bundles.js";
import { ALL_STATES, type SandboxState, SandboxStore } from "./sandbox-store.js";
import { SessionStore } from "./session-store.js";
import {
	buildDefaultMnemosyneDescriptor,
	type MnemosyneRequestOptions,
	type SandboxMode,
	SandboxSpawner,
} from "./spawner.js";
import { startSseStream } from "./sse-transport.js";
import { processStripeWebhook } from "./stripe-webhook.js";
import { listTemplates, resolveTemplateFilesystemIds } from "./templates.js";
import { readUsageExplorer, usagePageQuery } from "./usage-explorer.js";
import { isAgentWorkerConfig, isKernelWorkerConfig, isRuntimeWorkerConfig } from "./wire-protocol.js";
import { graphPlanStepGrantPolicy } from "./workflow/being-geist.js";
import { startHostedBuildEffectWorkerFromEnv } from "./workflow/build-effect-hosted.js";
import { BoundedChildInvocationMediator, type ChildInvocationDispatch } from "./workflow/child-invocation.js";
import {
	type DomainAgentCallerContextV1,
	type DomainAgentProgramBindingV1,
	type DomainGraphAddressV1,
	parseDomainAgentInvocationRequest,
	readTrustedGrantAuthorities,
	resolveDomainAgentConfig,
} from "./workflow/domain-agent-config.js";
import { commitDomainSourceTurn } from "./workflow/domain-source-turn.js";
import { buildIngestRequest, postEmporiumIngest, resolveEmporiumIngestBaseUrl } from "./workflow/emporium-ingest.js";
import { startHostedGitHubEffectWorkerFromEnv } from "./workflow/github-effect-hosted.js";
import type { GraphWriter } from "./workflow/graph-writer.js";
import { makeHostedGraphWriter, readOnlyGraphWriter } from "./workflow/graph-writer.js";
import { compileWorkflow, runWorkflow } from "./workflow/harness.js";
import {
	type ExecutionBindingInput,
	INVOCATION_ENVELOPE_SCHEMA,
	INVOCATION_RECEIPT_SCHEMA,
	type InvocationEnvelopeV1,
	InvocationFault,
	type InvocationReceiptV1,
	legacyExecutorFor,
	resolveExecutionBinding,
} from "./workflow/invocation.js";
import {
	classifyInvocationFailure,
	invocationFailureBody,
	logInvocationFailure,
} from "./workflow/invocation-failure.js";
import { JournalStore } from "./workflow/journal-store.js";
import { localAgentDefaultsEnabled } from "./workflow/local-agent-defaults.js";
import { startHostedPlatformReleaseEffectWorkerFromEnv } from "./workflow/platform-release-effect-hosted.js";
import { WorkflowProgramControlBackend } from "./workflow/program-control.js";
import { runProgramInvocation, validateProgramInvocationInput } from "./workflow/program-runner.js";
import {
	foldOwnerGraphRunsToAgentSessionProjection,
	foldRunToAgentBindings,
	foldRunToAgentSubject,
	foldRunToProvenance,
} from "./workflow/projection.js";
import {
	emitRunProvenance,
	ensureWorkflowDef,
	serializeAgentRunProvenance,
	serializeRunStartedProvenance,
} from "./workflow/provenance.js";
import {
	getWorkflow,
	listWorkflows,
	registerWorkflow,
	type WorkflowRegistryEntry,
	workflowEntryFromSource,
	workflowSchema,
} from "./workflow/registry.js";
// `readRunProjected` / `resolveSinceCursor` / `startRunSseStream` remain exported,
// unit-tested helpers in run-endpoints.ts; the live `:runId` + `:runId/events`
// routes are served by the base Contract-A handlers, so only the run-LIST
// projector is wired here.
import { listRunsProjected } from "./workflow/run-endpoints.js";
import { projectJournalEvent, RunTelemetryEmitter, type TelemetryEvent } from "./workflow/run-telemetry.js";
import {
	parseMaybeJson,
	projectAgentSession,
	projectAgentSessionControlMutation,
	projectAgentSessionDocumentBackend,
	projectAgentSessionDocumentOp,
	projectAgentSessionEvent,
	projectRuntimeInstance,
	resolveAgentSessionRevisionCursor,
	resolveAgentSessionSinceCursor,
	startAgentSessionSseStream,
} from "./workflow/runtime-api.js";
import { makeRuntimeNodeRunner } from "./workflow/runtime-control.js";
import {
	AgentSessionCommandConflictError,
	type AgentSessionCommandName,
	AgentSessionScheduleFault,
	type AgentSessionScheduleRecord,
	WorkflowRuntimeStore,
} from "./workflow/runtime-store.js";
import { startHostedScratchEffectWorkerFromEnv } from "./workflow/scratch-effect-hosted.js";
import {
	buildDomainAgentActivityInputs,
	DOMAIN_AGENT_ACTIVITY_LOOP_NAME,
	DOMAIN_AGENT_ACTIVITY_LOOP_SCRIPT,
	finalizeDomainAgentActivityRun,
	readDomainAgentHostContext,
} from "./workflow/script-domain-agent-activity-loop.js";
import {
	buildGraphPlanInputs,
	finalizeGraphPlanRun,
	GRAPH_PLAN_SCRIPT,
	loadApprovedGraphPlan,
	parseGraphPlanRequest,
	readGraphPlanHostContext,
} from "./workflow/script-graph-plan.js";
import {
	buildHojaSwarmWorkflowInputs,
	HOJA_SWARM_SCRIPT,
	HOJA_SWARM_WORKFLOW_NAME,
} from "./workflow/script-hoja-swarm.js";
import { annotateTranscriptTimestamps, canonicalTranscript } from "./workflow/session-transcript.js";
import { startHostedSiteEffectWorkerFromEnv } from "./workflow/site-effect-hosted.js";
import type { AgentNodeResult, NodeRunner, RunRecord } from "./workflow/types.js";
import { mintRunUri, mintWorkflowUri } from "./workflow/vocab.js";
import { withJournal } from "./workflow/with-journal.js";
import {
	admitWorkspaceChatSeed,
	buildWorkspaceChatInputs,
	builtInModeFenceForSession,
	parseWorkspaceChatRequest,
	readWorkspaceChatHostContext,
	resolveWorkspaceChatInference,
	stampWorkspaceChatSpec,
	WORKSPACE_CHAT_SCRIPT,
	WORKSPACE_CHAT_WORKFLOW_NAME,
	type WorkspaceChatSessionAct,
	workspaceChatFence,
	workspaceChatGrantTools,
	workspaceChatHostFacts,
	workspaceChatViewerRefusal,
} from "./workflow/workspace-chat.js";
import {
	gatewayGraphRoleRequired,
	graphRoleRequiredFault,
	resolveWorkspaceChatRole,
	WORKSPACE_CHAT_REQUIRED_TOOLS,
	type WorkspaceChatRole,
} from "./workflow/workspace-chat-contract.js";
import { GitWorktreeProvider } from "./workspace/git-workspace-provider.js";

const DOMAIN_AGENT_ACTIVITY_LOOP_COMPILED = compileWorkflow(DOMAIN_AGENT_ACTIVITY_LOOP_SCRIPT);
const HOJA_SWARM_COMPILED = compileWorkflow(HOJA_SWARM_SCRIPT);
const WORKSPACE_CHAT_COMPILED = compileWorkflow(WORKSPACE_CHAT_SCRIPT);
const GRAPH_PLAN_COMPILED = compileWorkflow(GRAPH_PLAN_SCRIPT);

/**
 * sha256 (hex) of the compiled workflow SOURCE — a property of the workflow
 * DEFINITION, computed ONCE at module load. Threaded into the emporium ingest
 * `parsed.scriptSha256` when the hosted Emporium path is active.
 */
const DOMAIN_AGENT_ACTIVITY_LOOP_SCRIPT_SHA256 = createHash("sha256")
	.update(DOMAIN_AGENT_ACTIVITY_LOOP_COMPILED.source)
	.digest("hex");
const HOJA_SWARM_SCRIPT_SHA256 = createHash("sha256").update(HOJA_SWARM_COMPILED.source).digest("hex");
const WORKSPACE_CHAT_SCRIPT_SHA256 = createHash("sha256").update(WORKSPACE_CHAT_COMPILED.source).digest("hex");
const GRAPH_PLAN_SCRIPT_SHA256 = createHash("sha256").update(GRAPH_PLAN_COMPILED.source).digest("hex");

/**
 * Populate the in-process registry at module load (before the HTTP server
 * accepts connections). Each entry wires the compiled artifact, its sha256,
 * and the per-workflow input builder. The survey-synthesize entry includes the
 * question-validation + doc-search logic inside its `buildInputs` shim so the
 * generic run handler stays clean.
 */
registerWorkflow({
	compiled: DOMAIN_AGENT_ACTIVITY_LOOP_COMPILED,
	scriptSha256: DOMAIN_AGENT_ACTIVITY_LOOP_SCRIPT_SHA256,
	async buildInputs(body, ctx) {
		if (!ctx.graph) {
			throw Object.assign(new Error("domain agent activity requires its home graph capability"), { status: 409 });
		}
		if (!ctx.runtime || !ctx.invocation || !ctx.graphOwnerPrincipal || !ctx.actorRef || !ctx.caller) {
			throw Object.assign(new Error("domain agent activity requires a canonical, owner-scoped host invocation"), {
				status: 409,
			});
		}
		let request: ReturnType<typeof parseDomainAgentInvocationRequest>;
		try {
			request = parseDomainAgentInvocationRequest(body);
		} catch (error) {
			// A malformed invocation body is the caller's error, not the graph's.
			throw Object.assign(error instanceof Error ? error : new Error(String(error)), { status: 400 });
		}
		const resolved = await resolveDomainAgentConfig({
			graph: ctx.graph,
			graphId: ctx.graphId,
			homeOwnerPrincipal: ctx.graphOwnerPrincipal,
			request,
			graphFor: ctx.graphFor,
			trustedGrantAuthorities: resolveWorkflowGrantAuthorities({
				caller: ctx.caller,
				authenticatedActorRef: ctx.actorRef,
				homeOwnerPrincipal: ctx.graphOwnerPrincipal,
				graphId: ctx.graphId,
			}),
			caller: ctx.caller,
		});
		const sourceTurn = await commitDomainSourceTurn({
			runtime: ctx.runtime,
			request,
			resolved,
			graphOwnerPrincipal: ctx.graphOwnerPrincipal,
			graphId: ctx.graphId,
			actorRef: ctx.actorRef,
			caller: ctx.caller,
			invocation: ctx.invocation,
		});
		return buildDomainAgentActivityInputs({
			graphId: ctx.graphId,
			request,
			resolved,
			sourceTurn,
		});
	},
	async finalizeRun(run, ctx) {
		await finalizeDomainAgentActivityRun({ run, ...ctx });
	},
});

/**
 * Built-in workspace chat: hosted chat for any graph, with no graph-resident
 * definition or grant. The host binds the built-in Reader mode; the gateway
 * ACL governs every graph call on behalf of the calling user.
 */
registerWorkflow({
	compiled: WORKSPACE_CHAT_COMPILED,
	scriptSha256: WORKSPACE_CHAT_SCRIPT_SHA256,
	host: () => workspaceChatHostFacts(),
	async buildInputs(body, ctx) {
		if (!ctx.graphOwnerPrincipal || !ctx.caller) {
			throw new InvocationFault(
				"workspace_chat_requires_owner_scope",
				"workspace chat requires a canonical, owner-scoped host invocation",
				409,
			);
		}
		// The gateway authenticates the human, checks their role on this graph and
		// then calls upstream as an internal service (only the graph owner also
		// gets the human-delegation marker). Either shape is a person at the
		// gateway. A named trigger adapter (Discord, Vehicle…) is a service
		// trigger and does not open a headed chat.
		if (ctx.caller.triggerAdapter) {
			throw new InvocationFault(
				"interaction_mode_denied",
				"headed workspace chat is for people at the gateway, not service trigger adapters",
				403,
			);
		}
		const request = parseWorkspaceChatRequest(body);
		// Whose authority the chat carries: the person's role on this graph. Owners and editors get the Writer,
		// viewers the Reader; an unreadable minted role is the caller's 400, before any run exists.
		const role = resolveWorkspaceChatRole({
			caller: ctx.caller,
			ownsGraph: Boolean(ctx.ownerUserId) && ctx.graphOwnerPrincipal === canonicalActorRef(ctx.ownerUserId!),
			...(ctx.gatewayGraphRole !== undefined ? { gatewayGraphRole: ctx.gatewayGraphRole } : {}),
			gatewayRoleRequired: gatewayGraphRoleRequired(),
		});
		let runtimeBundle: { id: string; digest: string };
		try {
			const descriptor = resolveRuntimeBundleDescriptor(SOPHIA_AGENT_RUNTIME_BUNDLE_ID);
			runtimeBundle = { id: descriptor.id, digest: descriptor.digest };
		} catch (error) {
			throw new InvocationFault(
				"runtime_unavailable",
				`the agent runtime bundle is not installed on this host: ${error instanceof Error ? error.message : String(error)}`,
				503,
			);
		}
		// The voice: the person's choice, or the House default, admitted against the LIVE catalogue (tools,
		// prices, not denied). Refused here, before any run exists, with a reason code; never a fallback price.
		const voice = await admitWorkspaceChatInference({
			...(request.inference ? { requested: request.inference } : {}),
			houseDefault: resolveWorkspaceChatInference(),
			catalog: ctx.modelCatalog,
			denylist: parseChatModelDenylist(process.env),
			markupBps: resolveBillingMarkupBps(process.env),
			...(ctx.chatVoiceMarket ? { market: ctx.chatVoiceMarket } : {}),
		}).catch(async (error: unknown) => {
			// A voice the host will not price is turned away in BOTH gate modes, before any run exists. It is not a
			// credit verdict, but it is a decision about a person's request, and `gate_events` is where those are
			// counted (the House default is never refused this way: that is the host's 503).
			if (error instanceof InvocationFault && error.code === "model_unpriced") {
				const reason = (error.details as { reason?: unknown } | undefined)?.reason;
				await ctx.creditGate?.recordModelUnpriced({
					userId: ctx.ownerUserId ?? null,
					model: request.inference?.model.trim() ?? null,
					reason: typeof reason === "string" ? reason : "unspecified",
				});
			}
			throw error;
		});
		// The price is pinned on the Session the run will begin. Keep the catalogue snapshot it was read from, so any
		// billed event can be re-derived from its `pricingVersion` even after the live catalogue has moved on.
		if (voice.pricing && ctx.runtime) {
			await ctx.runtime.archivePricingCatalogue({
				digest: voice.pricing.card.catalogue.digest,
				fetchedAt: voice.pricing.card.catalogue.fetchedAt,
				coreJson: voice.pricing.catalogueJson,
				now: Date.now(),
			});
		}
		// A chat that continues an earlier one: the seed must exist for this person, be the size the
		// invocation names and hold the window it says. This is refused here, before any run exists.
		let seed: AgentSeedRefV1 | undefined;
		if (request.seed) {
			if (!ctx.runtime || !ctx.ownerUserId) {
				throw new InvocationFault(
					"workspace_chat_requires_owner_scope",
					"continuing a chat requires the durable runtime store and an authenticated person",
					409,
				);
			}
			try {
				seed = await admitWorkspaceChatSeed({
					seed: request.seed,
					ownerUserId: ctx.ownerUserId,
					runtime: ctx.runtime,
					now: Date.now(),
					renderMaxChars: resolveChatSeedRenderBudget(process.env, voice.facts?.contextLength),
				});
			} catch (error) {
				if (error instanceof ChatSeedFault) throw new InvocationFault(error.code, error.message, error.status);
				throw error;
			}
		}
		const title = request.title ?? request.seed?.title;
		// What the person has open is named to the model only once the graph has answered it for them (exam 1).
		const admittedContextRefs = await admitTurnContextRefs(request.contextRefs, ctx.readGraph);
		// The tools the cell serves this person: the session is handed, and its prompt names, only those (exam 1).
		const liveTools = ctx.listGraphTools ? await ctx.listGraphTools() : undefined;
		return buildWorkspaceChatInputs({
			graphId: ctx.graphId,
			graphOwnerPrincipal: ctx.graphOwnerPrincipal,
			request,
			runtimeBundle,
			role,
			admittedContextRefs,
			...(liveTools ? { liveTools } : {}),
			inference: voice.inference,
			...(voice.pricing ? { pricing: voice.pricing.card } : {}),
			...(seed ? { seed } : {}),
			...(title ? { title } : {}),
		});
	},
});

registerWorkflow({
	compiled: HOJA_SWARM_COMPILED,
	scriptSha256: HOJA_SWARM_SCRIPT_SHA256,
	buildInputs(body, ctx) {
		return buildHojaSwarmWorkflowInputs(body, ctx.graphId);
	},
});

/**
 * Built-in graph plan (`graph-plan-v1`, 2026-10-18): a workflow whose definition is a named RDF graph. The host reads
 * and compiles the definition, refuses unless the caller names the digest of exactly that plan, and binds every step
 * to an agent that reads the graph and writes only its own Geist. The script walks data; nothing from the graph is
 * evaluated, so no dynamic-source flag applies.
 */
registerWorkflow({
	compiled: GRAPH_PLAN_COMPILED,
	scriptSha256: GRAPH_PLAN_SCRIPT_SHA256,
	async buildInputs(body, ctx) {
		if (!ctx.graph || !ctx.graphOwnerPrincipal) {
			throw new InvocationFault(
				"graph_plan_requires_owner_scope",
				"a graph plan runs in its home graph, on an owner-scoped host invocation",
				409,
			);
		}
		const request = parseGraphPlanRequest(body);
		const { plan, digest } = await loadApprovedGraphPlan({ graph: ctx.graph, graphId: ctx.graphId, request });
		let runtimeBundle: { id: string; digest: string };
		try {
			const descriptor = resolveRuntimeBundleDescriptor(SOPHIA_AGENT_RUNTIME_BUNDLE_ID);
			runtimeBundle = { id: descriptor.id, digest: descriptor.digest };
		} catch (error) {
			throw new InvocationFault(
				"runtime_unavailable",
				`the agent runtime bundle is not installed on this host: ${error instanceof Error ? error.message : String(error)}`,
				503,
			);
		}
		const liveTools = ctx.listGraphTools ? await ctx.listGraphTools() : undefined;
		return buildGraphPlanInputs({
			graphId: ctx.graphId,
			graphOwnerPrincipal: ctx.graphOwnerPrincipal,
			request,
			plan,
			digest,
			runtimeBundle,
			inference: resolveWorkspaceChatInference(),
			...(liveTools ? { liveTools } : {}),
		});
	},
	async finalizeRun(run, ctx) {
		await finalizeGraphPlanRun(run, ctx);
	},
});

console.error(
	"[registry] registered workflows:",
	listWorkflows()
		.map((w) => w.name)
		.join(", "),
);

// ─── Config ─────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3456", 10);
/**
 * The address the HTTP edge binds. Hosted keeps every interface (`0.0.0.0`): the ALB reaches the host on its private
 * address. A self-host under gardend passes `127.0.0.1`, so only gardend's proxy can reach it.
 */
const BIND_HOST = process.env.CHOREOGRAPH_BIND_HOST?.trim() || "0.0.0.0";
const DATA_DIR = process.env.DATA_DIR ?? "/app/.data";
/** How often unclaimed and orphaned chat seeds are reaped. */
const CHAT_SEED_REAP_INTERVAL_MS = 10 * 60_000;
const DB_PATH = `${DATA_DIR}/sandbox-mgmt.sqlite`;
const SESSION_DB_PATH = `${DATA_DIR}/sessions.sqlite`;
const JOURNAL_DB_PATH = `${DATA_DIR}/journal.sqlite`;
const WORKFLOW_RUNTIME_DB_PATH = `${DATA_DIR}/workflow-runtime.sqlite`;
const BILLING_DB_PATH = `${DATA_DIR}/billing.sqlite`;
const AGENT_EVOLUTION_DB_PATH = `${DATA_DIR}/agent-evolution.sqlite`;
const OPENROUTER_CATALOG_PATH =
	process.env.OPENROUTER_CATALOG_SNAPSHOT_PATH?.trim() || `${DATA_DIR}/openrouter-model-catalog.json`;
const OPENROUTER_ENDPOINTS_PATH =
	process.env.OPENROUTER_ENDPOINTS_SNAPSHOT_PATH?.trim() || `${DATA_DIR}/openrouter-model-endpoints.json`;
const CHAT_MODEL_HEALTH_PATH =
	process.env.CHOREOGRAPH_CHAT_MODEL_HEALTH_PATH?.trim() || `${DATA_DIR}/chat-model-health.json`;
const WORKER_SCRIPT = process.env.WORKER_SCRIPT ?? fileURLToPath(new URL("./worker.mjs", import.meta.url));

/** A duration in ms from the environment: unset or blank takes the default; 0 or a negative value disables. */
function durationFromEnv(raw: string | undefined, fallback: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	return Number.isFinite(value) ? value : fallback;
}

// ─── Application Context ───────────────────────────────────────────────

interface AppContext {
	notebooks?: HostedNotebookService;
	sandboxMode?: SandboxMode;
	openRouterKeyStore?: OpenRouterKeyStore;
	openRouterUserInferenceEnabled?: boolean;
	store: SandboxStore;
	sessions: SessionStore;
	spawner: SandboxSpawner;
	eventBus?: SandboxEventBus;
	journal: JournalStore;
	runtime: WorkflowRuntimeStore;
	memory: AgentMemory;
	/** Billing Phase 0 (OBSERVE) usage-event ledger. */
	billing: BillingStore;
	/**
	 * The credit gate's ingress door (Door A). Absent in narrow route tests and deployments without a
	 * ledger: then the routes behave exactly as they did before credits.
	 */
	creditGate?: CreditAdmission;
	/** Contract A live-tail fan-out point. */
	telemetry: RunTelemetryEmitter;
	/** Default-off native Observatory witness. */
	capture?: CaptureEmitter;
	/** Trusted host-side provider catalog (optional in narrow route tests). */
	modelCatalog?: OpenRouterModelCatalog;
	/** The providers of each chat voice and their outright refusals (precision and the voices' health). */
	chatVoiceMarket?: ChatVoiceMarket;
	/** Private content-addressed browser evidence store. */
	evidence?: EvidenceStore;
	/** Async 202 workflow tails whose durable writes must drain before DB close. */
	workflowTails?: Set<Promise<void>>;
	/** Explicitly configured owner-scoped evolution plane; absent means disabled. */
	evolution?: PersonalEvolutionController;
}

// ─── ACP multi-driver authority registry (CA-1/S6 presence + S8 live mount) ──
//
// One authority cell per session, held in-process for the orchestrator lifetime
// and PERSISTING ACROSS REQUESTS — so a driver's claim AND a pending permission
// `callId` survive between the `session/prompt` request that opens them and the
// `session/answer` request that settles them. Each cell binds, over the SAME
// `InProcessLwwPresence`:
//   - `presence` — the S3 driver register the `session/prompt` gate authorizes
//     against (N=1 solo auto-claim preserved);
//   - `backend`  — the `acp.authority` {@link AuthorityCapabilityBackend} the
//     spawner registers for the worker's destructive-tool gate. Constructed over
//     the SAME presence, so a non-driver prompt and a non-driver permission
//     answer reject IDENTICALLY (one source of truth for "who is the driver").
//   - `activeSandboxId` — the sandbox_id of the session's CURRENT turn. The
//     authority BusEvent fan-out must reach the session's SSE subscribers, and
//     the bus is keyed per sandbox_id; the live SSE stream is opened over the
//     prompt's sandbox_id, so the fan-out emits under THIS id. `enqueuePrompt`
//     rebinds it each turn; the backend's `onRequest` hook reads the live value.
//
// Substrate-blind (an in-process LWW register); a future slice may relocate
// ordering authority to a CRDT relay.
interface AcpSessionAuthority {
	readonly presence: InProcessLwwPresence;
	readonly backend: AuthorityCapabilityBackend;
	/** The sandbox_id of the session's current turn — the fan-out emit scope. */
	activeSandboxId: string | null;
}

const acpAuthorityBySession = new Map<string, AcpSessionAuthority>();
const agentSessionScheduleControlWakeRequests = new Set<string>();

/**
 * Get-or-create the per-session authority cell. The first call for a session
 * constructs the {@link AuthorityCapabilityBackend} over a fresh presence and
 * wires its live fan-out hook to `ctx.eventBus.emit(...)`: when the worker's gate
 * opens a `request_permission`, the hook lifts the bridge {@link AuthorityBusFrame}
 * onto the bus as a `category:"authority"` event under the cell's CURRENT
 * `activeSandboxId` (the live turn the session SSE stream is reading). With no
 * `ctx.eventBus` (or no active turn) the hook is a safe no-op — the gate decision
 * is unaffected; only the observability fan-out is skipped.
 */
function acpAuthorityFor(ctx: AppContext, sessionId: string): AcpSessionAuthority {
	let cell = acpAuthorityBySession.get(sessionId);
	if (!cell) {
		const presence = new InProcessLwwPresence();
		const backend = new AuthorityCapabilityBackend(presence);
		const created: AcpSessionAuthority = { presence, backend, activeSandboxId: null };
		backend.setOnRequest((req) => {
			const sandboxId = created.activeSandboxId;
			if (!ctx.eventBus || !sandboxId) return;
			const frame: AuthorityBusFrame = {
				category: "authority",
				type: "permission",
				callId: req.callId,
				...(req.tool !== undefined ? { tool: req.tool } : {}),
				driverId: req.driverId,
			};
			ctx.eventBus.emit(authorityFrameToBusEvent(frame, { sandbox_id: sandboxId, ts: new Date().toISOString() }));
		});
		acpAuthorityBySession.set(sessionId, created);
		cell = created;
	}
	return cell;
}

/**
 * Build the ACP bridge's non-execution seams for one authenticated request.
 *   - createSession → ctx.sessions.createSession (the POST /api/sessions path)
 *   - loadHead/forkAt → S1 SessionStoreIntentLog + HeadProjection over ctx.sessions
 *   - enqueuePrompt → fail-closed tombstone for the deleted anonymous executor
 *   - abort → the SAME spawner.kill path as POST /api/sessions/:id/abort
 *   - presence → the per-session S3 register
 */
function buildAcpDeps(
	ctx: AppContext,
	_request: IncomingMessage,
	sessionId: string,
	ownerUserId: string,
): AcpBridgeDeps {
	// The per-session authority cell (presence + acp.authority backend over the
	// SAME presence + live fan-out hook). For `session/new` the id is "__new__"
	// (no prompt/answer in that request), so the cell is harmlessly ephemeral —
	// the REAL session's cell is created/looked-up at prompt/answer time by the
	// resolved sessionId. Persisting per session is what lets driver A's claim +
	// a pending callId survive between the prompt request and the answer request.
	const authorityCell = acpAuthorityFor(ctx, sessionId);
	return {
		async createSession(uid, opts) {
			const s = await ctx.sessions.createSession(uid, {
				model: opts?.model,
				provider: opts?.provider,
				graphId: opts?.graphId,
			});
			return s.session_id;
		},
		async loadHead(sid) {
			const snap = await new SessionStoreIntentLog(ctx.sessions, sid).freeze();
			return new HeadProjection().project(snap);
		},
		async enqueuePrompt() {
			throw Object.assign(
				new Error("Legacy ACP prompt execution was removed; invoke a graph-defined Agent workflow"),
				{ status: 410 },
			);
		},
		async forkAt(sid, atSeq) {
			return fork(new SessionStoreIntentLog(ctx.sessions, sid), atSeq, new HeadProjection());
		},
		async abort(_sid) {
			const running = ctx.store.list({ state: "running" }).filter((s) => s.owner_user_id === ownerUserId);
			if (running.length === 0) return false;
			await ctx.spawner.kill(running[0].sandbox_id);
			return true;
		},
		presence: authorityCell.presence,
		// S8 live mount: the per-session acp.authority backend shared with the
		// spawner-registered capability (same presence as the prompt gate). The
		// `category:"authority"` fan-out is driven by the backend's `onRequest` hook
		// (wired in `acpAuthorityFor` to `ctx.eventBus.emit` under the active turn's
		// sandbox_id) — NOT `emitAuthority`, because the LIVE gate path goes through
		// the worker → `spawner.handleGateCall` → `backend.requestPermission`, which
		// the bridge's `requestPermissionAndFanOut` is NOT on. So `emitAuthority` is
		// intentionally left unwired (its fan-out would double-emit); the hook is the
		// single fan-out point on the real gate path.
		authority: authorityCell.backend,
	};
}

// ─── HTTP Helpers ───────────────────────────────────────────────────────

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	const raw = Buffer.concat(chunks).toString("utf8").trim();
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		throw new BadRequestError("Request body must be valid JSON");
	}
}

/** Read the raw request body as a UTF-8 string WITHOUT trimming or parsing.
 *  Stripe webhook signatures are computed over the EXACT bytes, so the raw form
 *  must be preserved (readJsonBody trims + JSON.parses and would break verify). */
async function readRawBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** Classify, log (structured, no secrets) and send one failed invocation. */
function sendInvocationFailure(
	response: ServerResponse,
	stage: string,
	error: unknown,
	fields: { workflow?: string; graphId?: string; invocationId?: string; ownerUserId?: string },
	fallbackCode?: string,
): void {
	const failure = classifyInvocationFailure(error, fallbackCode);
	logInvocationFailure({ stage, status: failure.status, code: failure.code, message: failure.message, ...fields });
	sendJson(response, failure.status, invocationFailureBody(failure));
}

/** Log a failure whose response is already committed (an async tail or a 202 already sent). */
function logInvocationFailureFrom(
	stage: string,
	error: unknown,
	fields: { workflow?: string; graphId?: string; invocationId?: string; ownerUserId?: string; runId?: string },
): void {
	const failure = classifyInvocationFailure(error);
	logInvocationFailure({ stage, status: failure.status, code: failure.code, message: failure.message, ...fields });
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
	response.statusCode = statusCode;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.end(JSON.stringify(payload, null, 2));
}

function projectPublicAgentSessionSchedule(schedule: AgentSessionScheduleRecord) {
	return {
		schedule_id: schedule.schedule_id,
		session_id: schedule.session_id,
		definition: schedule.definition,
		prompt: schedule.prompt,
		revision: schedule.revision,
		source: schedule.source,
		label: schedule.label,
		delivery_mode: schedule.delivery_mode,
		state: schedule.state,
		next_fire_at: schedule.next_fire_at,
		fire_count: schedule.fire_count,
		cancel_reason: schedule.cancel_reason,
		created_at: schedule.created_at,
		updated_at: schedule.updated_at,
		completed_at: schedule.completed_at,
		cancelled_at: schedule.cancelled_at,
	};
}

function projectPublicAgentSessionScheduleReceipt(receipt: {
	readonly schema: string;
	readonly requestId: string;
	readonly scheduleId: string;
	readonly requestDigest: string;
	readonly priorRevision: number;
	readonly resultingRevision: number;
	readonly disposition: string;
	readonly priorState: string;
	readonly resultingState: string;
	readonly nextFireAt: string | null;
	readonly committedAt: string;
}) {
	return {
		schema: receipt.schema,
		requestId: receipt.requestId,
		scheduleId: receipt.scheduleId,
		priorRevision: receipt.priorRevision,
		resultingRevision: receipt.resultingRevision,
		disposition: receipt.disposition,
		priorState: receipt.priorState,
		resultingState: receipt.resultingState,
		nextFireAt: receipt.nextFireAt,
		committedAt: receipt.committedAt,
	};
}

function projectPublicAgentSessionScheduleCancellation(cancellation: {
	readonly cancellation_id: string;
	readonly session_id: string;
	readonly schedule_id: string;
	readonly request_id: string;
	readonly request_digest: string;
	readonly client_id: string;
	readonly reason: string;
	readonly disposition: string;
	readonly created_at: number;
}) {
	return {
		cancellation_id: cancellation.cancellation_id,
		session_id: cancellation.session_id,
		schedule_id: cancellation.schedule_id,
		request_id: cancellation.request_id,
		reason: cancellation.reason,
		disposition: cancellation.disposition,
		created_at: cancellation.created_at,
	};
}

function agentSessionScheduleFaultStatus(reason: AgentSessionScheduleFault["reason"]): number {
	if (reason === "session_not_found" || reason === "schedule_not_found") return 404;
	if (reason === "request_conflict" || reason === "materialization_conflict") return 409;
	if (reason === "lease_lost" || reason === "lease_expired") return 503;
	return 400;
}

function sendAgentSessionScheduleFault(response: ServerResponse, error: unknown): boolean {
	if (!(error instanceof AgentSessionScheduleFault)) return false;
	sendJson(response, agentSessionScheduleFaultStatus(error.reason), {
		error: error.message,
		code: error.code,
		reason: error.reason,
	});
	return true;
}

function sendEvidence(response: ServerResponse, method: string, blob: { ref: EvidenceRef; body: Buffer }): void {
	response.statusCode = 200;
	response.setHeader("content-type", blob.ref.mediaType);
	response.setHeader("content-length", String(blob.ref.bytes));
	response.setHeader("etag", `"sha256-${blob.ref.sha256}"`);
	response.setHeader("cache-control", "private, max-age=31536000, immutable");
	response.setHeader("vary", "authorization");
	response.setHeader("x-content-type-options", "nosniff");
	response.end(method === "HEAD" ? undefined : blob.body);
}

async function drainLiveAgentCommands(
	ctx: AppContext,
	sessionId: string,
	targetGeneration: number,
	enabled: boolean,
): Promise<{
	attempted: boolean;
	delivered: number;
	sandboxId: string | null;
	activationQueued?: true;
	error?: string;
}> {
	if (!enabled) {
		return { attempted: false, delivered: 0, sandboxId: null };
	}
	const materialization = await ctx.runtime.readAgentMaterialization(sessionId, targetGeneration);
	if (!materialization || materialization.state !== "running") {
		ctx.spawner.wakeDurableSupervision();
		return { attempted: false, delivered: 0, sandboxId: null, activationQueued: true };
	}
	const sandboxId = materialization.sandbox_id;
	try {
		const delivered = await ctx.spawner.drainAgentSessionCommands(sandboxId);
		return { attempted: true, delivered: delivered.length, sandboxId };
	} catch (err) {
		ctx.spawner.wakeDurableSupervision();
		return {
			attempted: true,
			delivered: 0,
			sandboxId,
			activationQueued: true,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

// ─── Credit gate, Door A: helpers shared by the ingress call sites ──────────

/** The voice a durable chat session is pinned to: its model, and the provider recorded in its source. */
function agentSessionVoice(session: { model: string; document_json: string }): { provider: string; model: string } {
	let provider = "openrouter";
	try {
		const parsed = JSON.parse(session.document_json) as { source?: { provider?: unknown } } | null;
		const pinned = parsed?.source?.provider;
		if (typeof pinned === "string" && pinned.trim()) provider = pinned.trim();
	} catch {
		// An unreadable document keeps the platform default provider; the per-call door still decides.
	}
	return { provider, model: session.model };
}

/**
 * Who would pay for this caller's next model call, as far as ingress can tell. Own-key funding is only in
 * play when the host enables it AND the person stored a key; a credential-store failure is not a credit
 * verdict, so it skips the friendly ingress check (the per-call door re-selects and decides).
 */
async function ingressFundingSource(
	ctx: AppContext,
	ownerUserId: string,
	provider: string | undefined,
): Promise<"platform" | "user"> {
	if (!ctx.openRouterUserInferenceEnabled || !ctx.openRouterKeyStore) return "platform";
	if ((provider ?? "openrouter").trim().toLowerCase() !== "openrouter") return "platform";
	try {
		const selected = await selectOpenRouterCredential(
			ctx.openRouterKeyStore,
			ownerUserId,
			process.env.OPENROUTER_API_KEY,
			true,
		);
		return selected.fundingSource;
	} catch {
		return "user";
	}
}

/**
 * The rate card a Session is pinned to, for the gate to quote on. A Session admitted from the live catalogue
 * carries one; a legacy Session has none and is quoted on the static table. A pin that cannot be read is not the
 * gate's to refuse a person for (the host refuses to run it): it is quoted as a legacy Session.
 */
function sessionRateCard(session: { document_json: string }): RateCardV1 | undefined {
	try {
		return rateCardFromSessionDocumentJson(session.document_json);
	} catch {
		return undefined;
	}
}

/**
 * Door A for a message sent into an existing chat (`prompt`, `follow_up`, `steer`). Returns the coded 402
 * body when the caller is out of credits, undefined to proceed. A retry of a command that was already
 * accepted stays idempotent: it returns the stored record, never a 402 for a message that was accepted.
 * The bar is the smallest viable call on the Session's own pinned card, the price the call will be settled at.
 */
async function creditRefusalForCommand(
	ctx: AppContext,
	ownerUserId: string,
	session: { session_id: string; model: string; document_json: string },
	commandId: string,
): Promise<InsufficientCreditBody | undefined> {
	const gate = ctx.creditGate;
	if (!gate) return undefined;
	if (await ctx.runtime.readAgentSessionCommand(commandId)) return undefined;
	const voice = agentSessionVoice(session);
	const rateCard = sessionRateCard(session);
	const verdict = await gate.admitIngress({
		door: "ingress.command",
		userId: ownerUserId,
		provider: voice.provider,
		model: voice.model,
		fundingSource: await ingressFundingSource(ctx, ownerUserId, voice.provider),
		sessionId: session.session_id,
		...(rateCard ? { rateCard } : {}),
	});
	return verdict.allow ? undefined : verdict.body;
}

/**
 * Resolve the caller of a browser-facing billing route. BEARER-ONLY: rejects the
 * internal-service identity-assertion path (X-Internal-Service + X-User-ID) so a
 * proxy that fails to strip client-supplied internal headers cannot read or act on
 * another user's billing. Sends the error response itself and returns undefined on
 * any failure (401 no-auth, 403 internal-service, 400/401 malformed).
 */
async function resolveBearerOnlyBillingCaller(
	request: IncomingMessage,
	response: ServerResponse,
): Promise<string | undefined> {
	try {
		const authContext = resolveHostedAuthContext(request.headers);
		if (!authContext) {
			response.setHeader("www-authenticate", 'Bearer realm="choreograph"');
			sendJson(response, 401, { error: "Authorization: Bearer <Cognito ID token> required" });
			return undefined;
		}
		if (authContext.method === "internal_service") {
			sendJson(response, 403, { error: "billing reads are bearer-only" });
			return undefined;
		}
		return await resolveSandboxOwnerUserId(authContext);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const statusCode = /authorization|x-user-id|bearer|internal-service/i.test(message) ? 400 : 401;
		sendJson(response, statusCode, { error: message });
		return undefined;
	}
}

/**
 * Write one Contract A `TelemetryEvent` onto an SSE response in the standard
 * `event: <type>\nid: <seq>\ndata: <json>\n\n` format.
 */
function writeRunTelemetrySse(response: ServerResponse, te: TelemetryEvent): void {
	response.write(`event: ${te.type}\nid: ${te.seq}\ndata: ${JSON.stringify(te)}\n\n`);
}

class BadRequestError extends Error {}

function asEvolutionRequestBody(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new BadRequestError("evolution request body must be an object");
	}
	return value as Record<string, unknown>;
}

function requiredEvolutionString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new BadRequestError(`${label} is required`);
	return value.trim();
}

function ownerMeaningfulRef<Kind extends MeaningfulObjectRefV1["kind"]>(
	value: unknown,
	kind: Kind,
	ownerPrincipal: string,
	label: string,
): MeaningfulObjectRefV1<Kind> {
	try {
		validateMeaningfulObjectRef(value, kind);
	} catch (error) {
		throw new BadRequestError(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
	}
	const ref = value as MeaningfulObjectRefV1<Kind>;
	if (ref.ownerPrincipal !== ownerPrincipal) throw new BadRequestError(`${label} belongs to a different owner`);
	return ref;
}

function evolutionIdempotencyKey(request: IncomingMessage, body: Record<string, unknown>): string {
	const header = firstHeaderValue(request.headers["idempotency-key"])?.trim();
	const bodyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
	const key = header || bodyKey;
	if (!key || key.length > 200) {
		throw new BadRequestError("Idempotency-Key header or idempotencyKey body field is required (max 200 chars)");
	}
	return key;
}

function sendEvolutionError(response: ServerResponse, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	const status =
		error instanceof BadRequestError
			? 400
			: /not found|was not found|is absent/i.test(message)
				? 404
				: /conflict|compare-and-swap|stale|eligible|expired|differs|crossed|owner|authority|quarantined/i.test(
							message,
						)
					? 409
					: 500;
	sendJson(response, status, { error: message });
}

// ─── Routing ────────────────────────────────────────────────────────────

export async function routeRequest(request: IncomingMessage, response: ServerResponse, ctx: AppContext): Promise<void> {
	const method = request.method ?? "GET";
	const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
	const pathname = url.pathname;

	const span = trace.getActiveSpan();
	if (method === "POST" && pathname === "/api/notebooks/mcp") {
		span?.updateName("POST /api/notebooks/mcp");
		if (ctx.sandboxMode !== "bwrap") {
			sendJson(response, 503, { error: "Hosted notebooks require isolated sandbox mode" });
			return;
		}
		let binding: NotebookBinding;
		try {
			const auth = resolveHostedAuthContext(request.headers);
			binding = notebookBinding(request.headers, auth?.method === "internal_service");
		} catch (error) {
			sendJson(response, 403, {
				error: error instanceof Error ? error.message : "Notebook gateway authentication required",
			});
			return;
		}
		if (!ctx.eventBus) {
			sendJson(response, 503, { error: "Notebook kernel events are unavailable" });
			return;
		}
		ctx.notebooks ??= new HostedNotebookService(ctx.spawner, ctx.store, ctx.eventBus);
		await ctx.notebooks.handle(request, response, binding);
		return;
	}

	// GET /health
	if (method === "GET" && pathname === "/health") {
		span?.updateName("GET /health");
		const stats = ctx.spawner.getQueueStats();
		const mem = process.memoryUsage();
		sendJson(response, 200, {
			status: "ok",
			uptime_seconds: process.uptime(),
			queue: stats,
			process: {
				rss_bytes: mem.rss,
				heap_used_bytes: mem.heapUsed,
			},
		});
		return;
	}

	// Owner-only Agent evolution control plane. Agent sandboxes never receive
	// these routes as tools: proposal/authoring is model-visible, while promotion,
	// activation, canary selection, quarantine, and rollback remain here.
	if (method === "GET" && pathname === "/api/evolutions") {
		span?.updateName("GET /api/evolutions");
		if (!ctx.evolution) {
			sendJson(response, 404, { error: "agent_evolution_not_enabled" });
			return;
		}
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;
		try {
			const agentId = url.searchParams.get("agent_id")?.trim() || undefined;
			sendJson(response, 200, {
				ownerPrincipal: `user:${ownerUserId}`,
				...(await ctx.evolution.listOwner(`user:${ownerUserId}`, agentId)),
			});
		} catch (error) {
			sendEvolutionError(response, error);
		}
		return;
	}

	const agentEvolutionMatch = /^\/api\/agents\/([^/]+)\/(embodiments|activations|evolutions)$/.exec(pathname);
	if (agentEvolutionMatch && method === "GET") {
		span?.updateName("GET /api/agents/:agentId/:evolutionView");
		if (!ctx.evolution) {
			sendJson(response, 404, { error: "agent_evolution_not_enabled" });
			return;
		}
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;
		try {
			const agentId = decodeURIComponent(agentEvolutionMatch[1]);
			const view = agentEvolutionMatch[2];
			const packet = await ctx.evolution.listAgent(`user:${ownerUserId}`, agentId);
			const kind =
				view === "embodiments"
					? new Set(["embodiment"])
					: view === "activations"
						? new Set(["embodiment-activation", "rollback-decision"])
						: new Set(["evolution-proposal", "embodiment-candidate", "promotion-decision"]);
			sendJson(response, 200, {
				agentId,
				activeHead: packet.head,
				objects: packet.objects.filter((item) => kind.has(item.ref.kind)),
			});
		} catch (error) {
			sendEvolutionError(response, error);
		}
		return;
	}

	const candidateRouteMatch = /^\/api\/candidates\/([^/]+)(?:\/(promotion-decisions|canary))?$/.exec(pathname);
	if (candidateRouteMatch && (method === "GET" || method === "POST")) {
		span?.updateName(`${method} /api/candidates/:candidateId${candidateRouteMatch[2] ? "/:action" : ""}`);
		if (!ctx.evolution) {
			sendJson(response, 404, { error: "agent_evolution_not_enabled" });
			return;
		}
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;
		const ownerPrincipal = `user:${ownerUserId}`;
		try {
			const candidateId = decodeURIComponent(candidateRouteMatch[1]);
			if (method === "GET" && candidateRouteMatch[2] === undefined) {
				sendJson(response, 200, await ctx.evolution.getCandidate(ownerPrincipal, candidateId));
				return;
			}
			const body = asEvolutionRequestBody(await readJsonBody(request));
			const candidateRef = ownerMeaningfulRef(
				body.candidateRef,
				"embodiment-candidate",
				ownerPrincipal,
				"candidateRef",
			);
			if (candidateRef.objectId !== candidateId)
				throw new BadRequestError("candidateRef differs from route candidate");
			const agentId = requiredEvolutionString(body.agentId, "agentId");
			if (candidateRouteMatch[2] === "promotion-decisions") {
				const verdict = body.verdict;
				if (verdict !== "approved" && verdict !== "rejected") {
					throw new BadRequestError("verdict must be approved or rejected");
				}
				sendJson(
					response,
					201,
					await ctx.evolution.decidePromotion({
						ownerPrincipal,
						agentId,
						candidateRef,
						verdict,
						idempotencyKey: evolutionIdempotencyKey(request, body),
						...(typeof body.reason === "string" ? { reason: body.reason } : {}),
					}),
				);
				return;
			}
			if (candidateRouteMatch[2] === "canary") {
				const promotionDecisionRef = ownerMeaningfulRef(
					body.promotionDecisionRef,
					"promotion-decision",
					ownerPrincipal,
					"promotionDecisionRef",
				);
				const expectedIncumbentRef = ownerMeaningfulRef(
					body.expectedIncumbentRef,
					"embodiment",
					ownerPrincipal,
					"expectedIncumbentRef",
				);
				sendJson(
					response,
					201,
					await ctx.evolution.activate({
						ownerPrincipal,
						agentId,
						candidateRef,
						promotionDecisionRef,
						expectedIncumbentRef,
						mode: "canary-session",
						idempotencyKey: evolutionIdempotencyKey(request, body),
					}),
				);
				return;
			}
			throw new BadRequestError("unsupported candidate action");
		} catch (error) {
			sendEvolutionError(response, error);
		}
		return;
	}

	const patchArtifactMatch = /^\/api\/patches\/([^/]+)\/content$/.exec(pathname);
	if (patchArtifactMatch && method === "GET") {
		span?.updateName("GET /api/patches/:patchSetId/content");
		if (!ctx.evolution) {
			sendJson(response, 404, { error: "agent_evolution_not_enabled" });
			return;
		}
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;
		try {
			const artifact = await ctx.evolution.readPatchArtifact(
				`user:${ownerUserId}`,
				decodeURIComponent(patchArtifactMatch[1]),
			);
			response.statusCode = 200;
			response.setHeader("content-type", artifact.mediaType);
			response.setHeader("content-length", String(artifact.body.byteLength));
			response.setHeader("etag", `"${artifact.contentDigest}"`);
			response.setHeader("cache-control", "private, max-age=31536000, immutable");
			response.setHeader("x-content-type-options", "nosniff");
			response.end(Buffer.from(artifact.body));
		} catch (error) {
			sendEvolutionError(response, error);
		}
		return;
	}

	const activationRouteMatch = /^\/api\/agents\/([^/]+)\/(activations|rollbacks)$/.exec(pathname);
	if (activationRouteMatch && method === "POST") {
		span?.updateName(`POST /api/agents/:agentId/${activationRouteMatch[2]}`);
		if (!ctx.evolution) {
			sendJson(response, 404, { error: "agent_evolution_not_enabled" });
			return;
		}
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;
		const ownerPrincipal = `user:${ownerUserId}`;
		try {
			const agentId = decodeURIComponent(activationRouteMatch[1]);
			const body = asEvolutionRequestBody(await readJsonBody(request));
			if (activationRouteMatch[2] === "activations") {
				const mode = body.mode;
				if (mode !== "future-sessions") {
					throw new BadRequestError("the v1 activation route supports future-sessions only");
				}
				sendJson(
					response,
					201,
					await ctx.evolution.activate({
						ownerPrincipal,
						agentId,
						candidateRef: ownerMeaningfulRef(
							body.candidateRef,
							"embodiment-candidate",
							ownerPrincipal,
							"candidateRef",
						),
						promotionDecisionRef: ownerMeaningfulRef(
							body.promotionDecisionRef,
							"promotion-decision",
							ownerPrincipal,
							"promotionDecisionRef",
						),
						expectedIncumbentRef: ownerMeaningfulRef(
							body.expectedIncumbentRef,
							"embodiment",
							ownerPrincipal,
							"expectedIncumbentRef",
						),
						mode,
						idempotencyKey: evolutionIdempotencyKey(request, body),
					}),
				);
				return;
			}
			sendJson(
				response,
				201,
				await ctx.evolution.rollback({
					ownerPrincipal,
					agentId,
					activationRef: ownerMeaningfulRef(
						body.activationRef,
						"embodiment-activation",
						ownerPrincipal,
						"activationRef",
					),
					targetEmbodimentRef: ownerMeaningfulRef(
						body.targetEmbodimentRef,
						"embodiment",
						ownerPrincipal,
						"targetEmbodimentRef",
					),
					reason: requiredEvolutionString(body.reason, "reason"),
					quarantineCurrent: body.quarantineCurrent === true,
					idempotencyKey: evolutionIdempotencyKey(request, body),
				}),
			);
		} catch (error) {
			sendEvolutionError(response, error);
		}
		return;
	}

	if (pathname === "/api/me/provider-credentials/openrouter") {
		await handleOpenRouterCredential(request, response, {
			store: ctx.openRouterKeyStore,
			userInferenceEnabled: ctx.openRouterUserInferenceEnabled,
			platformKey: process.env.OPENROUTER_API_KEY,
		});
		return;
	}

	// POST /api/stripe/webhook — Stripe events → subscription/credit folds.
	// Reads the RAW body (the signature is over the exact bytes); never readJsonBody.
	// The live endpoint needs STRIPE_WEBHOOK_SECRET (whsec_…); unset ⇒ every event
	// fails signature verification (400), so this route is inert until the secret
	// is provided (deferred live-wiring).
	if (method === "POST" && pathname === "/api/stripe/webhook") {
		span?.updateName("POST /api/stripe/webhook");
		const rawBody = await readRawBody(request);
		const sigHeader = request.headers["stripe-signature"];
		try {
			// Best-effort tier push to the gateway entitlements store (P1c), wired
			// only when the gateway origin + service token are configured.
			const gatewayBase = process.env.MNEMOSYNE_GATEWAY_BASE_URL;
			const serviceToken = process.env.MNEMOSYNE_SERVICE_TOKEN;
			const pushTier =
				gatewayBase && serviceToken
					? async (sub: string, tier: Tier) => {
							const r = await pushTierToGateway(sub, tier, { baseUrl: gatewayBase, serviceToken });
							if (!r.ok) throw new Error(`gateway entitlements PUT ${r.status}`);
						}
					: undefined;
			const result = await processStripeWebhook(rawBody, Array.isArray(sigHeader) ? sigHeader[0] : sigHeader, {
				billing: ctx.billing,
				secret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
				pushTier,
			});
			sendJson(response, result.status, result.body);
		} catch (err) {
			// A fold error (DB hiccup, malformed event) → 500 so Stripe retries;
			// never crash the request loop.
			sendJson(response, 500, {
				error: "webhook_processing_failed",
				detail: err instanceof Error ? err.message : String(err),
			});
		}
		return;
	}

	// GET /api/billing/{balance,subscription,usage} — the authenticated caller's
	// own billing state (read-only, off the choreograph libSQL ledger). Auth mirrors
	// the sandbox routes: a Cognito ID-token bearer (or internal-service + x-user-id).
	if (
		method === "GET" &&
		(pathname === "/api/billing/balance" ||
			pathname === "/api/billing/subscription" ||
			pathname === "/api/billing/usage" ||
			pathname === "/api/billing/usage/events" ||
			pathname === "/api/billing/credits/history")
	) {
		span?.updateName(`GET ${pathname}`);
		const userId = await resolveBearerOnlyBillingCaller(request, response);
		if (userId === undefined) return;

		// What moved this person's balance (top-ups, deposits, signed adjustments). A NEW route: the deployed
		// gateway parses the balance, subscription and usage views with deny_unknown_fields, so none of them
		// may grow a field. Owner-scoped by construction: the one user id is the verified bearer's.
		if (pathname === "/api/billing/credits/history") {
			try {
				sendJson(response, 200, await readCreditHistory(ctx.billing, userId, creditHistoryQuery(url.searchParams)));
			} catch (error) {
				if (!(error instanceof CreditHistoryQueryError)) throw error;
				sendJson(response, 400, { error: "invalid_history_query", message: error.message });
			}
			return;
		}

		if (pathname === "/api/billing/usage/events") {
			let query: ReturnType<typeof usagePageQuery>;
			try {
				query = usagePageQuery(userId, url.searchParams);
			} catch {
				sendJson(response, 400, { error: "invalid_usage_query" });
				return;
			}
			sendJson(response, 200, await readUsageExplorer(ctx.billing, userId, query));
			return;
		}
		if (pathname === "/api/billing/balance") {
			sendJson(response, 200, await readBillingBalance(ctx.billing, userId, ctx.creditGate?.mode));
			return;
		}
		if (pathname === "/api/billing/subscription") {
			sendJson(
				response,
				200,
				await readBillingSubscription(
					ctx.billing,
					userId,
					Boolean(process.env.STRIPE_SECRET_KEY && process.env.BILLING_PORTAL_RETURN_URL),
				),
			);
			return;
		}
		const { fromTs, toTs } = usageWindow(url.searchParams.get("from"), url.searchParams.get("to"), Date.now());
		sendJson(response, 200, await readBillingUsage(ctx.billing, userId, fromTs, toTs));
		return;
	}

	// POST /api/billing/{checkout,portal} — start a Stripe Checkout for a credit top-up
	// or open the Customer Portal. Bearer-only, like the reads. Inert until
	// STRIPE_SECRET_KEY is configured (a top-up needs no price id; a subscription is
	// refused, see billing-checkout.ts). The kind is stated, never defaulted: a body
	// that names none is a 400, not a silent subscription.
	if (method === "POST" && (pathname === "/api/billing/checkout" || pathname === "/api/billing/portal")) {
		span?.updateName(`POST ${pathname}`);
		const userId = await resolveBearerOnlyBillingCaller(request, response);
		if (userId === undefined) return;

		const secretKey = process.env.STRIPE_SECRET_KEY;
		if (!secretKey) {
			sendJson(response, 503, { error: "billing_not_configured" });
			return;
		}
		const checkoutDeps: CheckoutDeps = {
			billing: ctx.billing,
			secretKey,
			successUrl: process.env.BILLING_CHECKOUT_SUCCESS_URL ?? "",
			cancelUrl: process.env.BILLING_CHECKOUT_CANCEL_URL ?? "",
			portalReturnUrl: process.env.BILLING_PORTAL_RETURN_URL ?? "",
			...(process.env.STRIPE_API_BASE_URL?.trim() ? { baseUrl: process.env.STRIPE_API_BASE_URL } : {}),
			...(process.env.STRIPE_API_VERSION?.trim() ? { apiVersion: process.env.STRIPE_API_VERSION } : {}),
		};
		try {
			if (pathname === "/api/billing/portal") {
				sendJson(response, 200, await createPortalSession(checkoutDeps, userId));
				return;
			}
			const body = (await readJsonBody(request).catch(() => null)) as {
				kind?: unknown;
				amountCents?: unknown;
			} | null;
			if (body?.kind !== "topup" && body?.kind !== "subscription") {
				sendJson(response, 400, {
					error: "invalid_checkout_kind",
					message: "kind must be 'topup'",
				});
				return;
			}
			// The receipt goes to the address the sign-in vouched for, when it vouched for one.
			const email = body.kind === "topup" ? await resolveCallerEmail(request.headers) : undefined;
			sendJson(
				response,
				200,
				await createCheckoutSession(checkoutDeps, userId, {
					kind: body.kind,
					amountCents: body.amountCents as number | undefined,
					...(email ? { email } : {}),
				}),
			);
			return;
		} catch (err) {
			if (err instanceof CheckoutRequestError) {
				sendJson(response, err.status, { error: err.code, message: err.message, ...err.details });
				return;
			}
			const message = err instanceof Error ? err.message : String(err);
			const status = message === "no_billing_customer" ? 409 : 502;
			sendJson(response, status, { error: message });
			return;
		}
	}

	// GET /api/templates
	if (method === "GET" && pathname === "/api/templates") {
		span?.updateName("GET /api/templates");
		sendJson(response, 200, { templates: listTemplates().filter((template) => template.id !== "agent") });
		return;
	}

	// GET /api/filesystems
	if (method === "GET" && pathname === "/api/filesystems") {
		span?.updateName("GET /api/filesystems");
		sendJson(response, 200, { filesystems: listFilesystems() });
		return;
	}

	// GET /api/models — list OpenRouter models with merged local/live metadata
	if (method === "GET" && pathname === "/api/models") {
		span?.updateName("GET /api/models");
		// `?view=chat`: the catalogue of voices a person may choose for a chat (tool-capable, priced, live),
		// House default marked. Extends this route rather than adding one, so it stays behind the same authority.
		const modelsView = url.searchParams.get("view");
		if (modelsView !== null) {
			if (modelsView !== CHAT_MODELS_VIEW) {
				sendCodedError(response, 400, "invalid_view", `view must be '${CHAT_MODELS_VIEW}'`);
				return;
			}
			await handleChatModelCatalogue({
				catalog: ctx.modelCatalog,
				response,
				url,
				...(ctx.chatVoiceMarket ? { market: ctx.chatVoiceMarket } : {}),
			});
			return;
		}
		const provider = url.searchParams.get("provider") ?? "openrouter";
		if (provider !== "openrouter") {
			sendJson(response, 400, { error: `Unsupported provider: ${provider}` });
			return;
		}

		const limitRaw = url.searchParams.get("limit");
		const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
		if (limitRaw && (!Number.isFinite(limit) || limit <= 0)) {
			sendJson(response, 400, { error: `Invalid limit: ${limitRaw}` });
			return;
		}

		const sort = url.searchParams.get("sort");
		if (sort && sort !== "id" && sort !== "prompt_price") {
			sendJson(response, 400, { error: `Invalid sort: ${sort}` });
			return;
		}

		try {
			const category = url.searchParams.get("category") ?? undefined;
			const includeLive = url.searchParams.get("live") !== "0";
			const listOptions = {
				query: url.searchParams.get("q") ?? undefined,
				limit,
				sort: (sort as "id" | "prompt_price" | null) ?? undefined,
			};
			const payload =
				ctx.modelCatalog && includeLive && !category
					? await ctx.modelCatalog.list(listOptions)
					: await listOpenRouterModels({
							apiKey: process.env.OPENROUTER_API_KEY,
							referer: process.env.OPENROUTER_HTTP_REFERER ?? process.env.OPENROUTER_HTTP_REFERER_URL,
							title: process.env.OPENROUTER_TITLE ?? "Choreograph Sandbox Management Spike",
							...listOptions,
							category,
							includeLive,
						});
			sendJson(response, 200, payload);
		} catch (err) {
			sendJson(response, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return;
	}

	// POST /api/chat-seeds — the seed store's door (Sobremesa): a signed-in browser hands over the
	// window of an old conversation a new chat will continue. Owner-only, content-addressed, capped
	// below the gateway's 1 MiB body limit. The gateway needs a route for it (see chat-seed-routes.ts).
	if (method === "POST" && pathname === "/api/chat-seeds") {
		span?.updateName("POST /api/chat-seeds");
		const ownerUserId = await requireAuthenticatedOwner(request, response, { coded: true });
		if (!ownerUserId) return;
		// A seed is stored only for a workspace chat, so with rule 2 retired it takes a minted role like the chat's
		// other acts (exam 1); an unreadable or repeated role is the caller's 400 either way.
		try {
			const { role } = gatewayRequestFacts(request, resolveHostedAuthContext(request.headers));
			if (role === undefined && gatewayGraphRoleRequired()) throw graphRoleRequiredFault();
		} catch (error) {
			if (error instanceof InvocationFault) {
				sendCodedError(response, error.status, error.code, error.message);
				return;
			}
			throw error;
		}
		await handleChatSeedPut({ runtime: ctx.runtime, request, response, ownerUserId });
		return;
	}

	// POST /api/sandboxes — enqueue non-agent utility/runtime sandboxes.
	// Agent execution is admitted only through an ontology-resolved workflow.
	if (method === "POST" && pathname === "/api/sandboxes") {
		span?.updateName("POST /api/sandboxes");
		const body = (await readJsonBody(request)) as {
			template?: string;
			filesystems?: unknown;
			resources?: Record<string, number>;
			intent?: string;
			timeout_ms?: number;
			worker_config?: Record<string, unknown>;
			mnemosyne?: {
				api_base_url?: string;
				mcp_url?: string;
				graph_owner?: string;
				graph_id?: string;
				tool_profile?: "chat" | "familiar" | "full";
				runtime?: string;
				label?: string;
				required_tools?: string[];
				capabilities?: {
					reads?: boolean;
					writes?: boolean;
					dangerous_ops?: boolean;
				};
			};
		};

		const template = body.template ?? "bare";
		if (template === "agent") {
			sendJson(response, 410, {
				error: "Direct agent sandbox creation was removed; execute an ontology-resolved workflow Agent Node instead",
			});
			return;
		}
		const filesystems = parseFilesystemIds(body.filesystems);
		validateAgentSpawnConfig(template, body.worker_config);
		validateRuntimeSpawnConfig(template, filesystems, body.worker_config);
		validateKernelSpawnConfig(template, filesystems, body.worker_config);
		span?.setAttribute("sandbox.template", template);
		if (filesystems?.length) {
			span?.setAttribute("sandbox.filesystem_count", filesystems.length);
		}

		// Backpressure: reject if spawn queue is deeply saturated
		// The queue is cheap (Promises waiting on semaphore), so allow
		// a large buffer before shedding load.
		const MAX_QUEUE_DEPTH = 500;
		const stats = ctx.spawner.getQueueStats();
		if (stats.pending > MAX_QUEUE_DEPTH) {
			response.setHeader("Retry-After", "1");
			sendJson(response, 503, {
				error: "Spawn queue full — try again later",
				queue: stats,
			});
			return;
		}

		try {
			const authContext = resolveHostedAuthContext(request.headers);
			if (!authContext) {
				response.statusCode = 401;
				response.setHeader("www-authenticate", 'Bearer realm="choreograph"');
				sendJson(response, 401, {
					error: "Sandbox creation requires Authorization: Bearer <token> or internal-service auth headers",
				});
				return;
			}
			authContextsTotal.add(1, {
				method: authMethodLabel(authContext),
				route: "create_sandbox",
			});

			const mnemosyne = parseMnemosyneRequestOptions(body.mnemosyne);
			const ownerUserId = await resolveSandboxOwnerUserId(authContext);

			// Gateway service-auth mode: the gateway enforces per-graph ACL on every
			// MCP call (x-pn-on-behalf-of = the already-verified ownerUserId), so the
			// legacy hosted-session preflight is redundant — and it would dial the
			// legacy control plane (MNEMOSYNE_API_BASE_URL), a dead dependency here.
			if (
				requiresHostedAuth(template, body.worker_config, mnemosyne) &&
				!isGatewayServiceAuthConfigured() &&
				!isDirectMcpAuthConfigured()
			) {
				const hostedUserId = await preflightHostedSandboxAccess(authContext, mnemosyne);
				if (hostedUserId !== ownerUserId) {
					sendJson(response, 403, {
						error: "Hosted session user_id did not match the authenticated caller",
					});
					return;
				}
			}

			const record = ctx.spawner.enqueue({
				template,
				filesystems,
				resources: body.resources,
				intent: body.intent,
				timeout_ms: body.timeout_ms,
				worker_config: body.worker_config,
				authContext,
				ownerUserId,
				authMethod: authMethodLabel(authContext),
				mnemosyne,
			});
			// If the client accepts SSE, stream events instead of returning JSON
			if (ctx.eventBus && request.headers.accept?.includes("text/event-stream")) {
				response.setTimeout(0);
				startSseStream(request, response, ctx.eventBus, record.sandbox_id);
			} else {
				sendJson(response, 202, { sandbox: record });
			}
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			const statusCode =
				err instanceof BadRequestError || /authorization|x-user-id|bearer/i.test(errorMessage) ? 400 : 500;
			sendJson(response, statusCode, { error: errorMessage });
		}
		return;
	}

	// GET /api/sandboxes — list sandboxes
	if (method === "GET" && pathname === "/api/sandboxes") {
		span?.updateName("GET /api/sandboxes");
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) {
			return;
		}
		const stateFilter = url.searchParams.get("state") ?? undefined;
		if (stateFilter) span?.setAttribute("sandbox.state_filter", stateFilter);
		if (stateFilter && !ALL_STATES.has(stateFilter)) {
			sendJson(response, 400, { error: `Invalid state filter: ${stateFilter}` });
			return;
		}
		const sandboxes = ctx.store
			.list(stateFilter ? { state: stateFilter as SandboxState } : undefined)
			.filter((record) => record.owner_user_id === ownerUserId);
		sendJson(response, 200, { sandboxes, count: sandboxes.length });
		return;
	}

	// GET /api/sandboxes/:id
	const getMatch = pathname.match(/^\/api\/sandboxes\/([^/]+)$/);
	if (method === "GET" && getMatch) {
		span?.updateName("GET /api/sandboxes/:id");
		span?.setAttribute("sandbox.id", getMatch[1]);
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) {
			return;
		}
		const record = ctx.store.get(getMatch[1]);
		if (!record || record.owner_user_id !== ownerUserId) {
			sendJson(response, 404, { error: "Sandbox not found" });
			return;
		}
		sendJson(response, 200, { sandbox: record });
		return;
	}

	// GET /api/sandboxes/:id/events — SSE stream for a single sandbox
	const eventsMatch = pathname.match(/^\/api\/sandboxes\/([^/]+)\/events$/);
	if (method === "GET" && eventsMatch) {
		span?.updateName("GET /api/sandboxes/:id/events");
		const sandboxId = eventsMatch[1];
		span?.setAttribute("sandbox.id", sandboxId);

		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;

		const record = ctx.store.get(sandboxId);
		if (!record || record.owner_user_id !== ownerUserId) {
			sendJson(response, 404, { error: "Sandbox not found" });
			return;
		}

		if (!ctx.eventBus) {
			sendJson(response, 501, { error: "Event streaming not available" });
			return;
		}

		// Exempt SSE from the 30s request timeout
		response.setTimeout(0);
		startSseStream(request, response, ctx.eventBus, sandboxId);
		return;
	}

	// POST /api/sandboxes/:id/kill
	const killMatch = pathname.match(/^\/api\/sandboxes\/([^/]+)\/kill$/);
	if (method === "POST" && killMatch) {
		span?.updateName("POST /api/sandboxes/:id/kill");
		const sandboxId = killMatch[1];
		span?.setAttribute("sandbox.id", sandboxId);
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) {
			return;
		}
		const record = ctx.store.get(sandboxId);
		if (!record || record.owner_user_id !== ownerUserId) {
			sendJson(response, 404, { error: "Sandbox not found" });
			return;
		}
		if (record.state !== "running") {
			sendJson(response, 409, {
				error: `Sandbox is not running (state: ${record.state})`,
				sandbox: record,
			});
			return;
		}
		try {
			const updated = await ctx.spawner.kill(sandboxId);
			sendJson(response, 200, { sandbox: updated });
		} catch (err) {
			sendJson(response, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return;
	}

	// POST /api/sandboxes/:id/input
	const inputMatch = pathname.match(/^\/api\/sandboxes\/([^/]+)\/input$/);
	if (method === "POST" && inputMatch) {
		span?.updateName("POST /api/sandboxes/:id/input");
		const sandboxId = inputMatch[1];
		span?.setAttribute("sandbox.id", sandboxId);
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) {
			return;
		}

		const record = ctx.store.get(sandboxId);
		if (!record || record.owner_user_id !== ownerUserId) {
			sendJson(response, 404, { error: "Sandbox not found" });
			return;
		}
		if (record.state !== "running") {
			sendJson(response, 409, {
				error: `Sandbox is not running (state: ${record.state})`,
				sandbox: record,
			});
			return;
		}

		try {
			const body = (await readJsonBody(request)) as { code?: unknown };
			const code = parseRuntimeCode(body.code);
			const result = ctx.spawner.sendRuntimeInput(sandboxId, code);
			sendJson(response, 202, result);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const statusCode =
				err instanceof BadRequestError
					? 400
					: /not a runtime session|not active|not running/i.test(message)
						? 409
						: 500;
			sendJson(response, statusCode, { error: message });
		}
		return;
	}

	// POST /api/sandboxes/:id/close
	const closeMatch = pathname.match(/^\/api\/sandboxes\/([^/]+)\/close$/);
	if (method === "POST" && closeMatch) {
		span?.updateName("POST /api/sandboxes/:id/close");
		const sandboxId = closeMatch[1];
		span?.setAttribute("sandbox.id", sandboxId);
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) {
			return;
		}

		const record = ctx.store.get(sandboxId);
		if (!record || record.owner_user_id !== ownerUserId) {
			sendJson(response, 404, { error: "Sandbox not found" });
			return;
		}
		if (record.state !== "running") {
			sendJson(response, 409, {
				error: `Sandbox is not running (state: ${record.state})`,
				sandbox: record,
			});
			return;
		}

		try {
			const sandbox = ctx.spawner.closeRuntime(sandboxId);
			sendJson(response, 202, { sandbox });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const statusCode = /not a runtime session|not active|not running/i.test(message) ? 409 : 500;
			sendJson(response, statusCode, { error: message });
		}
		return;
	}

	// POST /api/sandboxes/:id/execute — send code to a kernel sandbox
	const executeMatch = pathname.match(/^\/api\/sandboxes\/([^/]+)\/execute$/);
	if (method === "POST" && executeMatch) {
		span?.updateName("POST /api/sandboxes/:id/execute");
		const sandboxId = executeMatch[1];
		span?.setAttribute("sandbox.id", sandboxId);
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) {
			return;
		}

		const record = ctx.store.get(sandboxId);
		if (!record || record.owner_user_id !== ownerUserId) {
			sendJson(response, 404, { error: "Sandbox not found" });
			return;
		}
		if (record.state !== "running") {
			sendJson(response, 409, {
				error: `Sandbox is not running (state: ${record.state})`,
				sandbox: record,
			});
			return;
		}

		try {
			const body = (await readJsonBody(request)) as { code?: unknown };
			const code = parseRuntimeCode(body.code);
			const result = ctx.spawner.sendKernelExecute(sandboxId, code);
			sendJson(response, 202, result);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const statusCode =
				err instanceof BadRequestError
					? 400
					: /not a kernel session|not active|not running/i.test(message)
						? 409
						: 500;
			sendJson(response, statusCode, { error: message });
		}
		return;
	}

	// POST /api/sandboxes/:id/interrupt — interrupt a kernel sandbox
	const interruptMatch = pathname.match(/^\/api\/sandboxes\/([^/]+)\/interrupt$/);
	if (method === "POST" && interruptMatch) {
		span?.updateName("POST /api/sandboxes/:id/interrupt");
		const sandboxId = interruptMatch[1];
		span?.setAttribute("sandbox.id", sandboxId);
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) {
			return;
		}

		const record = ctx.store.get(sandboxId);
		if (!record || record.owner_user_id !== ownerUserId) {
			sendJson(response, 404, { error: "Sandbox not found" });
			return;
		}
		if (record.state !== "running") {
			sendJson(response, 409, {
				error: `Sandbox is not running (state: ${record.state})`,
				sandbox: record,
			});
			return;
		}

		try {
			const sandbox = ctx.spawner.interruptKernel(sandboxId);
			sendJson(response, 202, { sandbox });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const statusCode = /not a kernel session|not active|not running/i.test(message) ? 409 : 500;
			sendJson(response, statusCode, { error: message });
		}
		return;
	}

	// ─── Session API ────────────────────────────────────────────────

	// POST /api/sessions — create a new chat session
	if (method === "POST" && pathname === "/api/sessions") {
		span?.updateName("POST /api/sessions");
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;

		const body = (await readJsonBody(request)) as {
			title?: string;
			model?: string;
			graph_id?: string;
			/** Session-lifetime Mnemosyne write lock. Explicit `false` ⇒ every sandbox
			 *  this session spawns runs read-only against the graph (write tools are
			 *  neither advertised nor callable — wrapMnemosyneProxy enforces). Create-time
			 *  only; there is deliberately no PATCH to promote a read-only session. */
			mnemosyne_writes?: boolean;
		};

		const session = await ctx.sessions.createSession(ownerUserId, {
			title: body.title,
			model: body.model,
			graphId: body.graph_id,
			mnemosyneWrites: body.mnemosyne_writes,
		});
		sendJson(response, 201, { session });
		return;
	}

	// GET /api/sessions — list user's sessions
	if (method === "GET" && pathname === "/api/sessions") {
		span?.updateName("GET /api/sessions");
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;

		const limitRaw = url.searchParams.get("limit");
		const offsetRaw = url.searchParams.get("offset");
		const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
		const offset = offsetRaw ? Number.parseInt(offsetRaw, 10) : 0;

		const sessions = await ctx.sessions.listSessions(ownerUserId, limit, offset);
		sendJson(response, 200, { sessions, count: sessions.length });
		return;
	}

	// GET /api/sessions/:id — get session detail
	const sessionGetMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (method === "GET" && sessionGetMatch) {
		span?.updateName("GET /api/sessions/:id");
		const sessionId = sessionGetMatch[1];
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;

		const session = await ctx.sessions.getSession(sessionId);
		if (!session || session.user_id !== ownerUserId) {
			sendJson(response, 404, { error: "Session not found" });
			return;
		}
		sendJson(response, 200, { session });
		return;
	}

	// PATCH /api/sessions/:id — update session metadata
	const sessionPatchMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (method === "PATCH" && sessionPatchMatch) {
		span?.updateName("PATCH /api/sessions/:id");
		const sessionId = sessionPatchMatch[1];
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;

		const existing = await ctx.sessions.getSession(sessionId);
		if (!existing || existing.user_id !== ownerUserId) {
			sendJson(response, 404, { error: "Session not found" });
			return;
		}

		const body = (await readJsonBody(request)) as { title?: string };
		if (body.title !== undefined) {
			const updated = await ctx.sessions.updateTitle(sessionId, body.title);
			sendJson(response, 200, { session: updated });
		} else {
			sendJson(response, 200, { session: existing });
		}
		return;
	}

	// DELETE /api/sessions/:id — delete session and messages
	const sessionDeleteMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
	if (method === "DELETE" && sessionDeleteMatch) {
		span?.updateName("DELETE /api/sessions/:id");
		const sessionId = sessionDeleteMatch[1];
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;

		const existing = await ctx.sessions.getSession(sessionId);
		if (!existing || existing.user_id !== ownerUserId) {
			sendJson(response, 404, { error: "Session not found" });
			return;
		}

		await ctx.sessions.deleteSession(sessionId);
		sendJson(response, 200, { deleted: true });
		return;
	}

	// GET /api/sessions/:id/messages — get message history
	const messagesMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/messages$/);
	if (method === "GET" && messagesMatch) {
		span?.updateName("GET /api/sessions/:id/messages");
		const sessionId = messagesMatch[1];
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;

		const session = await ctx.sessions.getSession(sessionId);
		if (!session || session.user_id !== ownerUserId) {
			sendJson(response, 404, { error: "Session not found" });
			return;
		}

		const messages = await ctx.sessions.getMessages(sessionId);
		// Deserialize content_json for the response
		const projected = messages.map((m) => ({
			message_id: m.message_id,
			ordinal: m.ordinal,
			role: m.role,
			content: JSON.parse(m.content_json),
			usage: m.usage_json ? JSON.parse(m.usage_json) : undefined,
			stop_reason: m.stop_reason ?? undefined,
			model: m.model ?? undefined,
			timestamp: m.timestamp,
		}));
		sendJson(response, 200, { messages: projected });
		return;
	}

	// POST /api/sessions/:id/message — tombstone for the deleted anonymous executor.
	const sendMessageMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/message$/);
	if (method === "POST" && sendMessageMatch) {
		span?.updateName("POST /api/sessions/:id/message");
		const sessionId = sendMessageMatch[1];
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;

		const session = await ctx.sessions.getSession(sessionId);
		if (!session || session.user_id !== ownerUserId) {
			sendJson(response, 404, { error: "Session not found" });
			return;
		}

		sendJson(response, 410, {
			error: "Legacy chat execution was removed; invoke a graph-defined Agent workflow",
			session_id: sessionId,
		});
		return;
	}

	// POST /acp — the ACP (Agent Client Protocol) front door (CA-1/S6).
	//
	// A single JSON-RPC endpoint multiplexing the ACP client→agent methods
	// (session/new, session/load, session/prompt, session/cancel, session/fork)
	// onto session/control seams via the pure S6 bridge. Prompt execution is a
	// hard-cutover tombstone until ACP names a graph-defined Agent Session. It
	// reuses ctx.sessions/ctx.eventBus and layers the S3 driver gate
	// AFTER requireAuthenticatedOwner, and — for session/prompt with
	// Accept: text/event-stream — streams the SAME bus over SSE (the live mount's
	// SandboxEvent SSE; the ACP session/update lift is the bridge's per-event
	// translator, exercised at live bring-up). ZERO change to the worker loop.
	if (method === "POST" && pathname === "/acp") {
		span?.updateName("POST /acp");
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;

		let parsed: ReturnType<typeof parseAcpRequest>;
		try {
			parsed = parseAcpRequest(await readJsonBody(request));
		} catch (err) {
			sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
			return;
		}

		// Ownership: every session-scoped method must target a session the caller owns.
		const targetSessionId = parsed.method === "session/new" ? undefined : (parsed as { sessionId: string }).sessionId;
		if (targetSessionId) {
			const session = await ctx.sessions.getSession(targetSessionId);
			if (!session || session.user_id !== ownerUserId) {
				sendJson(response, 404, { error: "Session not found" });
				return;
			}
		}

		// The ACP client id competes for the driver seat; default to the owner for
		// a single-client session (the lone client trivially drives — N=1 solo).
		const clientId =
			(typeof request.headers["x-acp-client-id"] === "string" && request.headers["x-acp-client-id"]) || ownerUserId;

		const deps = buildAcpDeps(ctx, request, targetSessionId ?? "__new__", ownerUserId);
		const env: AcpRequestEnvelope = { request: parsed, ownerUserId, clientId };

		try {
			const result = await handleAcpRequest(env, deps);
			if (isNotDriver(result)) {
				sendJson(response, 409, result);
				return;
			}
			// For an accepted prompt, optionally stream the run's bus over SSE
			// (same transport as POST /api/sessions/:id/message).
			if (
				parsed.method === "session/prompt" &&
				ctx.eventBus &&
				request.headers.accept?.includes("text/event-stream")
			) {
				response.setTimeout(0);
				startSseStream(request, response, ctx.eventBus, (result as { sandboxId: string }).sandboxId);
				return;
			}
			sendJson(response, parsed.method === "session/prompt" ? 202 : 200, result);
		} catch (err) {
			const status = (err as { status?: number }).status;
			sendJson(response, status === 410 ? 410 : 500, { error: err instanceof Error ? err.message : String(err) });
		}
		return;
	}

	// POST /api/sessions/:id/abort — kill active sandbox
	const sessionAbortMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/abort$/);
	if (method === "POST" && sessionAbortMatch) {
		span?.updateName("POST /api/sessions/:id/abort");
		const sessionId = sessionAbortMatch[1];
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;

		const session = await ctx.sessions.getSession(sessionId);
		if (!session || session.user_id !== ownerUserId) {
			sendJson(response, 404, { error: "Session not found" });
			return;
		}

		// Find running sandboxes owned by this user and kill the most recent
		const running = ctx.store.list({ state: "running" }).filter((s) => s.owner_user_id === ownerUserId);

		if (running.length === 0) {
			sendJson(response, 409, { error: "No active sandbox for this session" });
			return;
		}

		try {
			const updated = await ctx.spawner.kill(running[0].sandbox_id);
			sendJson(response, 200, { sandbox: updated });
		} catch (err) {
			sendJson(response, 500, {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return;
	}

	// GET /api/workflows — list all registered workflows. Definitional catalog
	// data (names/descriptions/schemas of every registered workflow) but still
	// gated: F1 fix — this route is not gateway-proxied (only the /run and
	// /runs* routes are, see pn/gateway ChoreographRoute), so it is reachable
	// directly against the EC2 origin and must authenticate like every sibling
	// route. No per-record ownership check applies (nothing here is owner-
	// scoped), so requireAuthenticatedOwner is used purely as a bearer gate.
	if (method === "GET" && pathname === "/api/workflows") {
		span?.updateName("GET /api/workflows");
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;
		sendJson(response, 200, { workflows: listWorkflows() });
		return;
	}

	// GET /api/workflows/:name/schema — the api:WorkflowBinding face (L0's EA-3
	// OpenAPI round-trip). Returns { name, executor, inputSchema, outputSchema };
	// inputSchema/outputSchema are the workflow's declared JSON Schemas, or the
	// permissive { type: "object" } default. Definitional (non-owner) data, but
	// gated the same as GET /api/workflows above (F1 fix — same no-auth finding
	// class; not gateway-proxied, so reachable directly against the EC2 origin).
	// Placed before the `/api/workflows/runs/:runId` matcher; the `/schema`
	// suffix keeps them disjoint.
	const workflowSchemaMatch = pathname.match(/^\/api\/workflows\/([^/]+)\/schema$/);
	if (method === "GET" && workflowSchemaMatch) {
		span?.updateName("GET /api/workflows/:name/schema");
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;
		const name = decodeURIComponent(workflowSchemaMatch[1]);
		span?.setAttribute("workflow.name", name);
		const schema = workflowSchema(name);
		if (!schema) {
			sendJson(response, 404, {
				error: {
					code: "unknown_workflow",
					message: `unknown workflow: ${name}`,
					details: { name },
				},
			});
			return;
		}
		sendJson(response, 200, schema);
		return;
	}

	// GET|HEAD /api/workflows/runs/:logicalRunId/evidence — authorized bytes for
	// Observatory filmstrips. CaptureEvents remain thin: the graph stores only a
	// content-addressed S3 ref, while this endpoint verifies graph authorization,
	// Hoja workflow provenance, run-prefix binding, byte length, and digest before
	// returning the private object. The gateway injects x-graph-id after stripping
	// caller-supplied internal headers. Its authenticated internal-service path has
	// already enforced the graph ACL, so graph viewers may see graph-owned runs;
	// direct bearer callers retain the narrower owner-only journal view.
	const runEvidenceMatch = pathname.match(/^\/api\/workflows\/runs\/([^/]+)\/evidence$/);
	if ((method === "GET" || method === "HEAD") && runEvidenceMatch) {
		span?.updateName(`${method} /api/workflows/runs/:logicalRunId/evidence`);
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;
		const trustedGraphAcl = resolveHostedAuthContext(request.headers)?.method === "internal_service";
		if (!ctx.evidence) {
			sendJson(response, 503, { error: "Evidence store is unavailable" });
			return;
		}

		let logicalRunId: string;
		try {
			logicalRunId = decodeURIComponent(runEvidenceMatch[1]);
		} catch {
			sendJson(response, 400, { error: "Invalid run id" });
			return;
		}
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(logicalRunId)) {
			sendJson(response, 400, { error: "Invalid run id" });
			return;
		}
		const graphId = firstHeaderValue(request.headers["x-graph-id"])?.trim();
		if (!graphId || !/^obs-hoja-[A-Za-z0-9._-]+$/.test(graphId)) {
			sendJson(response, 400, { error: "A valid trusted x-graph-id header is required" });
			return;
		}
		const graphOwner = trustedGraphAcl ? firstHeaderValue(request.headers["x-graph-owner"])?.trim() : undefined;
		if (graphOwner && !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/.test(graphOwner)) {
			sendJson(response, 400, { error: "Invalid trusted graph owner" });
			return;
		}

		const runs = trustedGraphAcl
			? await ctx.journal.listRunsForTrustedGraph({
					graphId,
					...(graphOwner ? { graphOwner } : {}),
					limit: 1_000,
				})
			: await ctx.journal.listRuns({ ownerUserId, graphId, limit: 1_000 });
		const ownedRun = runs.find(
			(header) =>
				header.workflow_name === HOJA_SWARM_WORKFLOW_NAME &&
				testimonyRunIdFromPayload(header.payload) === logicalRunId,
		);
		if (!ownedRun) {
			sendJson(response, 404, { error: "Run not found" });
			return;
		}

		const uri = url.searchParams.get("uri")?.trim();
		const sha256 = url.searchParams.get("sha256")?.trim();
		const bytesRaw = url.searchParams.get("bytes")?.trim();
		const mediaType = url.searchParams.get("media_type")?.trim();
		if (!uri || !sha256 || Boolean(bytesRaw) !== Boolean(mediaType)) {
			sendJson(response, 400, {
				error: "uri and sha256 are required; bytes and media_type must be supplied together",
			});
			return;
		}
		const events = await ctx.journal.listEvents(ownedRun.run_id);
		const indexed = events.some((event) => evidenceIndexContains(event, logicalRunId, uri, sha256));
		if (!indexed) {
			sendJson(response, 404, { error: "Evidence not found or invalid" });
			return;
		}

		try {
			ctx.evidence.assertRunUri(uri, logicalRunId);
			const blob =
				bytesRaw && mediaType
					? await ctx.evidence.get({ uri, sha256, bytes: Number(bytesRaw), mediaType })
					: await ctx.evidence.getThin({ uri, sha256 });
			sendEvidence(response, method, blob);
		} catch {
			// Do not reveal whether an out-of-prefix or digest-mismatched S3 object
			// exists. The authenticated run owner gets one stable failure shape.
			sendJson(response, 404, { error: "Evidence not found or invalid" });
		}
		return;
	}

	// GET /api/workflows/runs/:runId — read a run header + all events (JSON).
	const runGetMatch = pathname.match(/^\/api\/workflows\/runs\/([^/]+)$/);
	if (method === "GET" && runGetMatch) {
		span?.updateName("GET /api/workflows/runs/:runId");
		const runId = decodeURIComponent(runGetMatch[1]);
		span?.setAttribute("workflow.run_id", runId);

		const ownerUserId = await requireAuthenticatedOwnerOrToken(request, response, url);
		if (!ownerUserId) return;

		const { header, events } = await ctx.journal.readRun(runId);
		if (!header) {
			sendJson(response, 404, { error: "Run not found" });
			return;
		}
		if (header.owner_user_id !== ownerUserId) {
			sendJson(response, 403, { error: "Forbidden" });
			return;
		}

		sendJson(response, 200, { header, events });
		return;
	}

	// GET /api/workflows/runs/:runId/events — Contract A live-tail SSE stream +
	// poll-since-seq JSON fallback. Transport selected by Accept header:
	//   Accept: text/event-stream → SSE primary (replay from journal then tail live)
	//   Accept: application/json (default) → JSON snapshot of events since ?since=N
	//
	// Auth: query param `?token=<bearer>` is accepted here in addition to the
	// Authorization header — EventSource cannot set headers, so the FE sends the
	// access_token as a query param. Consumers MUST dedupe on (runId, seq).
	const runEventsMatch = pathname.match(/^\/api\/workflows\/runs\/([^/]+)\/events$/);
	if (method === "GET" && runEventsMatch) {
		span?.updateName("GET /api/workflows/runs/:runId/events");
		const runId = decodeURIComponent(runEventsMatch[1]);
		span?.setAttribute("workflow.run_id", runId);

		const ownerUserId = await requireAuthenticatedOwnerOrToken(request, response, url);
		if (!ownerUserId) return;

		const header = await ctx.journal.readHeader(runId);
		if (!header) {
			sendJson(response, 404, { error: "Run not found" });
			return;
		}
		if (header.owner_user_id !== ownerUserId) {
			sendJson(response, 403, { error: "Forbidden" });
			return;
		}

		// Resume cursor — INCLUSIVE (`listEventsSince` is `seq >= since`). `?since`
		// is the primary; if absent, honor the SSE `Last-Event-ID` reconnect header
		// (vertical resumability folded in here). Last-Event-ID carries the last seq
		// the client ALREADY saw, so resume at `+1` to avoid re-sending it — whereas
		// `?since=N` means "from N inclusive" (the FE poll cursor is already next).
		const sinceParam = url.searchParams.get("since");
		const lastEventId = firstHeaderValue(request.headers["last-event-id"]);
		let since: number;
		if (sinceParam !== null) {
			since = Math.max(0, parseInt(sinceParam, 10) || 0);
		} else if (lastEventId !== undefined && Number.isFinite(Number.parseInt(lastEventId, 10))) {
			since = Math.max(0, Number.parseInt(lastEventId, 10) + 1);
		} else {
			since = 0;
		}

		const acceptsSse = request.headers.accept?.includes("text/event-stream") ?? false;

		if (acceptsSse) {
			// ── SSE primary: replay past events then tail live ────────────────────
			// At-least-once: consumers dedupe on (runId, seq).
			response.setTimeout(0);
			response.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
				"x-accel-buffering": "no",
			});
			response.write(":ok\n\n");

			let closed = false;
			// Declared before cleanup() to avoid TDZ — assigned after the replay block.
			let unsubscribeLive: (() => void) | undefined;

			function cleanup() {
				closed = true;
				clearInterval(heartbeat);
				unsubscribeLive?.();
			}

			// Heartbeat to keep the connection alive through proxies / ALB.
			const heartbeat = setInterval(() => {
				if (!closed) response.write(":keepalive\n\n");
			}, 15_000);

			// Replay past events first (journal is source of truth).
			const pastEvents = await ctx.journal.listEventsSince(runId, since);
			let lastSeqSeen = since - 1;
			for (const ev of pastEvents) {
				if (closed) break;
				const te = projectJournalEvent({ runId, workflowName: header.workflow_name }, ev);
				if (te) {
					writeRunTelemetrySse(response, te);
					lastSeqSeen = ev.seq;
				}
			}

			// If the run is already finished, close after replay.
			if (header.status !== "running") {
				response.write(":eof\n\n");
				response.end();
				cleanup();
				return;
			}

			// Tail live events from the telemetry emitter.
			unsubscribeLive = ctx.telemetry.subscribe((te) => {
				if (closed) return;
				// Filter to this run and events we haven't already replayed.
				if (te.resultRef !== runId) return;
				if (te.seq <= lastSeqSeen) return;
				lastSeqSeen = te.seq;
				if (response.writableNeedDrain) return; // backpressure: drop
				writeRunTelemetrySse(response, te);
				// Close after run.finished.
				if (te.type === "run.finished") {
					setTimeout(() => {
						if (!closed) {
							response.write(":eof\n\n");
							response.end();
							cleanup();
						}
					}, 100);
				}
			});

			request.on("close", cleanup);
		} else {
			// ── Poll-since-seq: JSON snapshot ─────────────────────────────────────
			// FE consumer (RunTelemetryClient) expects a BARE ARRAY of TelemetryEvent
			// objects — no wrapper object.  The pagination cursor (nextSince) travels
			// in the X-Next-Since response header so the body stays a plain array.
			const journalEvents = await ctx.journal.listEventsSince(runId, since);
			const events: TelemetryEvent[] = [];
			for (const ev of journalEvents) {
				const te = projectJournalEvent({ runId, workflowName: header.workflow_name }, ev);
				if (te) events.push(te);
			}
			const nextSince = journalEvents.length > 0 ? (journalEvents.at(-1)?.seq ?? since) + 1 : since;
			response.setHeader("X-Next-Since", String(nextSince));
			sendJson(response, 200, events);
		}
		return;
	}

	// GET /api/workflows/runs/:runId/agents — Vehicle attach index for a workflow run.
	const runAgentsMatch = pathname.match(/^\/api\/workflows\/runs\/([^/]+)\/agents$/);
	if (method === "GET" && runAgentsMatch) {
		span?.updateName("GET /api/workflows/runs/:runId/agents");
		const runId = decodeURIComponent(runAgentsMatch[1]);
		const ownerUserId = await requireAuthenticatedOwnerOrToken(request, response, url);
		if (!ownerUserId) return;

		const instance = await ctx.runtime.getWorkflowInstance(runId);
		if (!instance) {
			sendJson(response, 404, { error: "Run not found" });
			return;
		}
		if (instance.owner_user_id !== ownerUserId) {
			sendJson(response, 403, { error: "Forbidden" });
			return;
		}

		const sessions = await ctx.runtime.listAgentSessionsForRun(runId, ownerUserId);
		const agents: Array<ReturnType<typeof projectAgentSession>> = [];
		for (const agent of sessions) {
			const chatFacts = await ctx.runtime.readChatSessionCatalogue(agent.session_id);
			agents.push(projectAgentSession(agent, chatFacts ? projectChatSessionFacts(chatFacts) : undefined));
		}
		sendJson(response, 200, {
			run: projectRuntimeInstance(instance),
			agents,
		});
		return;
	}

	// GET /api/workflows/runs/:runId/control — run-level beat/driver state.
	const runControlMatch = pathname.match(/^\/api\/workflows\/runs\/([^/]+)\/control$/);
	if (method === "GET" && runControlMatch) {
		span?.updateName("GET /api/workflows/runs/:runId/control");
		const runId = decodeURIComponent(runControlMatch[1]);
		const ownerUserId = await requireAuthenticatedOwnerOrToken(request, response, url);
		if (!ownerUserId) return;
		const instance = await ctx.runtime.getWorkflowInstance(runId);
		if (!instance) {
			sendJson(response, 404, { error: "Run not found" });
			return;
		}
		if (instance.owner_user_id !== ownerUserId) {
			sendJson(response, 403, { error: "Forbidden" });
			return;
		}
		const control = await ctx.runtime.getWorkflowControl(runId);
		sendJson(response, 200, { control });
		return;
	}

	// POST /api/workflows/runs/:runId/driver — claim/release the run control row.
	const runDriverMatch = pathname.match(/^\/api\/workflows\/runs\/([^/]+)\/driver$/);
	if (method === "POST" && runDriverMatch) {
		span?.updateName("POST /api/workflows/runs/:runId/driver");
		const runId = decodeURIComponent(runDriverMatch[1]);
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;
		const instance = await ctx.runtime.getWorkflowInstance(runId);
		if (!instance) {
			sendJson(response, 404, { error: "Run not found" });
			return;
		}
		if (instance.owner_user_id !== ownerUserId) {
			sendJson(response, 403, { error: "Forbidden" });
			return;
		}
		const body = (await readJsonBody(request)) as {
			action?: unknown;
			clientId?: unknown;
			ts?: unknown;
			expectedRevision?: unknown;
		};
		const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
		if (!clientId) {
			sendJson(response, 400, { error: "clientId is required" });
			return;
		}
		const expectedRevision =
			typeof body.expectedRevision === "number" && Number.isSafeInteger(body.expectedRevision)
				? body.expectedRevision
				: undefined;
		const now = Date.now();
		const action = body.action === "release" ? "release" : "claim";
		const result =
			action === "release"
				? await ctx.runtime.releaseWorkflowDriver(runId, { clientId, now, expectedRevision })
				: await ctx.runtime.claimWorkflowDriver(runId, {
						clientId,
						now,
						claimTs: typeof body.ts === "number" && Number.isFinite(body.ts) ? body.ts : now,
						expectedRevision,
					});
		if (!result) {
			sendJson(response, 404, { error: "Run control not found" });
			return;
		}
		sendJson(response, result.reason ? 409 : 200, result);
		return;
	}

	// POST /api/workflows/runs/:runId/amendments — driver-authorized beat CAS.
	const runAmendmentsMatch = pathname.match(/^\/api\/workflows\/runs\/([^/]+)\/amendments$/);
	if (method === "POST" && runAmendmentsMatch) {
		span?.updateName("POST /api/workflows/runs/:runId/amendments");
		const runId = decodeURIComponent(runAmendmentsMatch[1]);
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;
		const instance = await ctx.runtime.getWorkflowInstance(runId);
		if (!instance) {
			sendJson(response, 404, { error: "Run not found" });
			return;
		}
		if (instance.owner_user_id !== ownerUserId) {
			sendJson(response, 403, { error: "Forbidden" });
			return;
		}
		const body = (await readJsonBody(request)) as {
			clientId?: unknown;
			amendmentId?: unknown;
			kind?: unknown;
			targetBeatId?: unknown;
			payload?: unknown;
			expectedRevision?: unknown;
			leaseEpoch?: unknown;
		};
		const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
		const amendmentId = typeof body.amendmentId === "string" ? body.amendmentId.trim() : "";
		const kind = body.kind;
		if (!clientId || !amendmentId) {
			sendJson(response, 400, { error: "clientId and amendmentId are required" });
			return;
		}
		if (kind !== "skip" && kind !== "reorder" && kind !== "reparameterize" && kind !== "directive") {
			sendJson(response, 400, { error: "kind must be skip, reorder, reparameterize, or directive" });
			return;
		}
		if (typeof body.expectedRevision !== "number" || !Number.isSafeInteger(body.expectedRevision)) {
			sendJson(response, 400, { error: "expectedRevision is required" });
			return;
		}
		if (typeof body.leaseEpoch !== "number" || !Number.isSafeInteger(body.leaseEpoch)) {
			sendJson(response, 400, { error: "leaseEpoch is required" });
			return;
		}
		try {
			const result = await ctx.runtime.queueWorkflowBeatAmendment(runId, {
				clientId,
				amendmentId,
				kind,
				targetBeatId: typeof body.targetBeatId === "string" ? body.targetBeatId : undefined,
				payload: body.payload,
				expectedRevision: body.expectedRevision,
				leaseEpoch: body.leaseEpoch,
				now: Date.now(),
			});
			if (!result) {
				sendJson(response, 404, { error: "Run control not found" });
				return;
			}
			sendJson(response, result.reason ? 409 : 202, result);
		} catch (error) {
			const status = (error as { status?: number }).status ?? 500;
			sendJson(response, status, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	// POST /api/workflows/runs/:runId/pause — request a semantic safe-point pause.
	const runPauseMatch = pathname.match(/^\/api\/workflows\/runs\/([^/]+)\/pause$/);
	if (method === "POST" && runPauseMatch) {
		span?.updateName("POST /api/workflows/runs/:runId/pause");
		const runId = decodeURIComponent(runPauseMatch[1]);
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;

		const instance = await ctx.runtime.getWorkflowInstance(runId);
		if (!instance) {
			sendJson(response, 404, { error: "Run not found" });
			return;
		}
		if (instance.owner_user_id !== ownerUserId) {
			sendJson(response, 403, { error: "Forbidden" });
			return;
		}
		const body = (await readJsonBody(request)) as { reason?: string };
		const updated = await ctx.runtime.requestPause(runId, {
			reason: typeof body.reason === "string" ? body.reason : undefined,
			now: Date.now(),
		});
		sendJson(response, 202, { run: updated ? projectRuntimeInstance(updated) : null });
		return;
	}

	// GET /api/agent-sessions/:sessionId — read the collaborative session document.
	const agentSessionSchedulesMatch = pathname.match(
		/^\/api\/agent-sessions\/([^/]+)\/schedules(?:\/([^/]+))?(?:\/cancel)?$/,
	);
	const agentSessionScheduleCancelMatch = pathname.match(
		/^\/api\/agent-sessions\/([^/]+)\/schedules\/([^/]+)\/cancel$/,
	);
	if (
		(method === "POST" && agentSessionSchedulesMatch && !agentSessionSchedulesMatch[2]) ||
		(method === "GET" && agentSessionSchedulesMatch && !agentSessionScheduleCancelMatch) ||
		(method === "PATCH" &&
			agentSessionSchedulesMatch &&
			Boolean(agentSessionSchedulesMatch[2]) &&
			!agentSessionScheduleCancelMatch) ||
		(method === "POST" && agentSessionScheduleCancelMatch)
	) {
		const sessionId = decodeURIComponent(
			agentSessionSchedulesMatch?.[1] ?? agentSessionScheduleCancelMatch?.[1] ?? "",
		);
		const scheduleId = decodeURIComponent(
			agentSessionSchedulesMatch?.[2] ?? agentSessionScheduleCancelMatch?.[2] ?? "",
		);
		span?.updateName(`${method} /api/agent-sessions/:sessionId/schedules${scheduleId ? "/:scheduleId" : ""}`);
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;
		try {
			if (!(await readAddressedAgentSession(request, response, ctx.runtime, sessionId, ownerUserId))) return;
		} catch (error) {
			if (sendAgentSessionScheduleFault(response, error)) return;
			sendJson(response, 500, { error: "Agent session lookup failed" });
			return;
		}

		try {
			if (method === "GET") {
				if (scheduleId) {
					const schedule = await ctx.runtime.readAgentSessionSchedule(sessionId, scheduleId);
					if (!schedule) {
						sendJson(response, 404, { error: "Schedule not found" });
						return;
					}
					sendJson(response, 200, { schedule: projectPublicAgentSessionSchedule(schedule) });
					return;
				}
				sendJson(response, 200, {
					schedules: (await ctx.runtime.listAgentSessionSchedules(sessionId)).map(
						projectPublicAgentSessionSchedule,
					),
				});
				return;
			}

			const body = (await readJsonBody(request)) as Record<string, unknown>;
			if (method === "POST" && agentSessionScheduleCancelMatch) {
				const result = await ctx.runtime.cancelAgentSessionSchedule(sessionId, scheduleId, {
					requestId: typeof body.requestId === "string" ? body.requestId : "",
					clientId: ownerUserId,
					reason: typeof body.reason === "string" ? body.reason : undefined,
					now: Date.now(),
				});
				if (result.applied) ctx.spawner.wakeDurableSupervision();
				sendJson(response, result.applied ? 202 : 200, {
					schedule: projectPublicAgentSessionSchedule(result.schedule),
					cancellation: projectPublicAgentSessionScheduleCancellation(result.cancellation),
					applied: result.applied,
				});
				return;
			}

			if (method === "POST") {
				const options: Record<string, unknown> = { source: "public" };
				if (Object.hasOwn(body, "label")) options.label = body.label;
				if (Object.hasOwn(body, "deliveryMode")) options.deliveryMode = body.deliveryMode;
				const result = await ctx.runtime.createAgentSessionSchedule(sessionId, {
					requestId: typeof body.requestId === "string" ? body.requestId : "",
					scheduleId: typeof body.scheduleId === "string" ? body.scheduleId : "",
					definition: body.definition as never,
					prompt: body.prompt as never,
					clientId: ownerUserId,
					now: Date.now(),
					options: options as never,
				});
				if (result.created) ctx.spawner.wakeDurableSupervision();
				sendJson(response, result.created ? 201 : 200, {
					schedule: projectPublicAgentSessionSchedule(result.schedule),
					created: result.created,
				});
				return;
			}

			const result = await ctx.runtime.controlAgentSessionSchedule(sessionId, {
				schema: body.schema as never,
				requestId: typeof body.requestId === "string" ? body.requestId : "",
				scheduleId,
				clientId: ownerUserId,
				action: body.action as never,
				now: Date.now(),
				expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
			});
			const wakeKey = `${sessionId}\0${result.receipt.requestId}`;
			if (result.applied && !agentSessionScheduleControlWakeRequests.has(wakeKey)) {
				agentSessionScheduleControlWakeRequests.add(wakeKey);
				ctx.spawner.wakeDurableSupervision();
			}
			sendJson(response, 200, {
				schedule: projectPublicAgentSessionSchedule(result.schedule),
				receipt: projectPublicAgentSessionScheduleReceipt(result.receipt),
				applied: result.applied,
			});
		} catch (error) {
			if (sendAgentSessionScheduleFault(response, error)) return;
			if (error instanceof BadRequestError) {
				sendJson(response, 400, { error: error.message });
				return;
			}
			sendJson(response, 500, { error: "Agent session schedule request failed" });
		}
		return;
	}

	const agentSessionEventsMatch = pathname.match(/^\/api\/agent-sessions\/([^/]+)\/events$/);
	if (method === "GET" && agentSessionEventsMatch) {
		span?.updateName("GET /api/agent-sessions/:sessionId/events");
		const sessionId = decodeURIComponent(agentSessionEventsMatch[1]);
		const ownerUserId = await requireAuthenticatedOwnerOrToken(request, response, url);
		if (!ownerUserId) return;

		if (!(await readAddressedAgentSession(request, response, ctx.runtime, sessionId, ownerUserId))) return;

		const lastEventId = Array.isArray(request.headers["last-event-id"])
			? request.headers["last-event-id"][0]
			: request.headers["last-event-id"];
		const since = resolveAgentSessionSinceCursor(url.searchParams.get("since"), lastEventId);
		if (request.headers.accept?.includes("text/event-stream")) {
			response.setTimeout(0);
			startAgentSessionSseStream(request, response, ctx.runtime, sessionId, since);
			return;
		}

		const events = await ctx.runtime.listAgentSessionEventsAfter(sessionId, since);
		const nextSince = events.length > 0 ? (events.at(-1)?.seq ?? since) : since;
		response.setHeader("X-Next-Since", String(nextSince));
		sendJson(response, 200, events.map(projectAgentSessionEvent));
		return;
	}

	const agentSessionDocumentOpsMatch = pathname.match(/^\/api\/agent-sessions\/([^/]+)\/document-ops$/);
	if (method === "GET" && agentSessionDocumentOpsMatch) {
		span?.updateName("GET /api/agent-sessions/:sessionId/document-ops");
		const sessionId = decodeURIComponent(agentSessionDocumentOpsMatch[1]);
		const ownerUserId = await requireAuthenticatedOwnerOrToken(request, response, url);
		if (!ownerUserId) return;

		if (!(await readAddressedAgentSession(request, response, ctx.runtime, sessionId, ownerUserId))) return;

		const since = resolveAgentSessionRevisionCursor(
			url.searchParams.get("sinceRev") ?? url.searchParams.get("since"),
		);
		const ops = await ctx.runtime.listAgentSessionDocumentOpsAfter(sessionId, since);
		const nextRevision = ops.length > 0 ? (ops.at(-1)?.rev ?? since) : since;
		response.setHeader("X-Next-Revision", String(nextRevision));
		sendJson(response, 200, ops.map(projectAgentSessionDocumentOp));
		return;
	}

	const headedCloseMatch = pathname.match(/^\/api\/agent-sessions\/([^/]+)\/headed-close$/);
	if (method === "POST" && headedCloseMatch) {
		span?.updateName("POST /api/agent-sessions/:sessionId/headed-close");
		const sessionId = decodeURIComponent(headedCloseMatch[1]);
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;
		const addressed = await readAddressedAgentSession(request, response, ctx.runtime, sessionId, ownerUserId);
		if (!addressed) return;
		const { session } = addressed;
		if (refuseViewerSessionAct(response, session, "stop", addressed.role)) return;
		if (!session.sandbox_id) {
			sendJson(response, 409, { error: "Agent session has no active sandbox" });
			return;
		}
		try {
			const sandbox = ctx.spawner.closeHeadedAgent(session.sandbox_id);
			sendJson(response, 202, { sandbox });
		} catch (error) {
			sendJson(response, 409, { error: error instanceof Error ? error.message : String(error) });
		}
		return;
	}

	const agentSessionDriverMatch = pathname.match(/^\/api\/agent-sessions\/([^/]+)\/driver$/);
	if (method === "POST" && agentSessionDriverMatch) {
		span?.updateName("POST /api/agent-sessions/:sessionId/driver");
		const sessionId = decodeURIComponent(agentSessionDriverMatch[1]);
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;

		const addressed = await readAddressedAgentSession(request, response, ctx.runtime, sessionId, ownerUserId);
		if (!addressed) return;
		const { session } = addressed;
		if (refuseViewerSessionAct(response, session, "drive", addressed.role)) return;

		const body = (await readJsonBody(request)) as { action?: unknown; clientId?: unknown; ts?: unknown };
		const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
		if (!clientId) {
			sendJson(response, 400, { error: "clientId is required" });
			return;
		}
		const now = Date.now();
		const claimTs = typeof body.ts === "number" && Number.isFinite(body.ts) ? body.ts : now;
		const action = typeof body.action === "string" ? body.action : "claim";
		const result =
			action === "release"
				? await ctx.runtime.releaseAgentSessionDriver(sessionId, { clientId, now })
				: await ctx.runtime.claimAgentSessionDriver(sessionId, { clientId, now, claimTs });
		if (!result) {
			sendJson(response, 404, { error: "Agent session not found" });
			return;
		}
		sendJson(response, result.reason ? 409 : 200, projectAgentSessionControlMutation(result));
		return;
	}

	const agentSessionSteerMatch = pathname.match(/^\/api\/agent-sessions\/([^/]+)\/steer$/);
	const agentSessionCancelMatch = pathname.match(/^\/api\/agent-sessions\/([^/]+)\/cancel$/);
	if (method === "POST" && agentSessionCancelMatch) {
		span?.updateName("POST /api/agent-sessions/:sessionId/cancel");
		const sessionId = decodeURIComponent(agentSessionCancelMatch[1]);
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;
		const addressed = await readAddressedAgentSession(request, response, ctx.runtime, sessionId, ownerUserId);
		if (!addressed) return;
		const { session } = addressed;
		if (refuseViewerSessionAct(response, session, "stop", addressed.role)) return;
		const body = (await readJsonBody(request)) as { requestId?: unknown; reason?: unknown };
		const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
		const reason = typeof body.reason === "string" ? body.reason.trim() : "";
		if (!requestId || !reason) {
			sendJson(response, 400, { error: "requestId and reason are required" });
			return;
		}
		const cancellation = await ctx.runtime.requestAgentSessionCancellation(sessionId, {
			requestId,
			actor: { kind: "owner_api", ownerUserId },
			reason,
			now: Date.now(),
		});
		ctx.spawner.wakeDurableSupervision();
		sendJson(response, cancellation.applied ? 202 : 200, cancellation);
		return;
	}

	if (method === "POST" && agentSessionSteerMatch) {
		span?.updateName("POST /api/agent-sessions/:sessionId/steer");
		const sessionId = decodeURIComponent(agentSessionSteerMatch[1]);
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;

		const addressed = await readAddressedAgentSession(request, response, ctx.runtime, sessionId, ownerUserId);
		if (!addressed) return;
		const { session } = addressed;
		if (refuseViewerSessionAct(response, session, "speak", addressed.role)) return;

		const body = (await readJsonBody(request)) as {
			clientId?: unknown;
			text?: unknown;
			commandId?: unknown;
			ts?: unknown;
		};
		const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
		const text = typeof body.text === "string" ? body.text.trim() : "";
		if (!clientId) {
			sendJson(response, 400, { error: "clientId is required" });
			return;
		}
		if (!text) {
			sendJson(response, 400, { error: "text is required" });
			return;
		}
		const now = Date.now();
		const commandId = typeof body.commandId === "string" ? body.commandId.trim() : "";
		if (!commandId) {
			sendJson(response, 400, { error: "commandId is required" });
			return;
		}
		const steerRefusal = await creditRefusalForCommand(ctx, ownerUserId, session, commandId);
		if (steerRefusal) {
			sendJson(response, 402, steerRefusal);
			return;
		}
		try {
			const submitted = await ctx.runtime.submitAgentSessionCommand(sessionId, {
				clientId,
				commandId,
				idempotencyKey: commandId,
				name: "steer",
				payload: { text },
				now,
			});
			if (!submitted) {
				sendJson(response, 404, { error: "Agent session not found" });
				return;
			}
			const liveDelivery = await drainLiveAgentCommands(
				ctx,
				sessionId,
				submitted.record.target_generation,
				submitted.accepted && submitted.record.state === "queued",
			);
			sendJson(response, submitted.accepted ? (submitted.duplicate ? 200 : 202) : 409, {
				command: submitted.record,
				duplicate: submitted.duplicate,
				driver: submitted.driver,
				liveDelivery,
				...(submitted.accepted ? {} : { error: submitted.record.error, code: "agent_session_command_rejected" }),
			});
		} catch (error) {
			if (error instanceof AgentSessionCommandConflictError) {
				sendJson(response, 409, { error: error.message, code: error.code });
				return;
			}
			throw error;
		}
		return;
	}

	const agentSessionCommandsMatch = pathname.match(/^\/api\/agent-sessions\/([^/]+)\/commands$/);
	if (method === "POST" && agentSessionCommandsMatch) {
		span?.updateName("POST /api/agent-sessions/:sessionId/commands");
		const sessionId = decodeURIComponent(agentSessionCommandsMatch[1]);
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;
		const addressed = await readAddressedAgentSession(request, response, ctx.runtime, sessionId, ownerUserId);
		if (!addressed) return;
		const { session } = addressed;
		const body = (await readJsonBody(request)) as Record<string, unknown>;
		const commandId = typeof body.commandId === "string" ? body.commandId.trim() : "";
		const idempotencyKey = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
		const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
		const name = typeof body.name === "string" ? body.name : "";
		const payload =
			body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
				? (body.payload as Record<string, unknown>)
				: undefined;
		const allowed = new Set<AgentSessionCommandName>([
			"prompt",
			"follow_up",
			"steer",
			"abort",
			"goal.get",
			"goal.create",
			"goal.complete",
		]);
		if (!commandId || !idempotencyKey || !clientId || !allowed.has(name as AgentSessionCommandName) || !payload) {
			sendJson(response, 400, {
				error: "commandId, idempotencyKey, clientId, supported name, and payload are required",
			});
			return;
		}
		if (
			(name === "prompt" || name === "follow_up" || name === "steer") &&
			(typeof payload.text !== "string" || !payload.text.trim())
		) {
			sendJson(response, 400, { error: `${name} requires payload.text` });
			return;
		}
		if (refuseViewerSessionAct(response, session, name === "abort" ? "stop" : "speak", addressed.role)) return;
		// What the person has open travels as the turn's own part (D5): kept in the durable command beside the text,
		// rendered for the model when the host delivers the turn, never into the transcript.
		try {
			if (name === "prompt" || name === "follow_up") parseTurnContextRefs(payload.contextRefs);
			else if (payload.contextRefs !== undefined) {
				throw new TurnContextRefsError("contextRefs is accepted only with prompt and follow_up");
			}
		} catch (error) {
			if (error instanceof TurnContextRefsError) {
				sendJson(response, error.status, { error: error.message, code: error.code });
				return;
			}
			throw error;
		}
		if (name === "goal.get" || name === "goal.create" || name === "goal.complete") {
			try {
				validateAgentSessionCommand({
					schema: AGENT_SESSION_COMMAND_SCHEMA,
					commandId,
					idempotencyKey,
					sessionId,
					actor: { principalId: ownerUserId },
					submittedAt: new Date().toISOString(),
					name,
					payload,
				});
			} catch (error) {
				if (error instanceof AgentSessionContractFault) {
					sendJson(response, 400, { error: error.message, code: error.code });
					return;
				}
				throw error;
			}
		}
		if (name === "prompt" || name === "follow_up" || name === "steer") {
			const refusal = await creditRefusalForCommand(ctx, ownerUserId, session, commandId);
			if (refusal) {
				sendJson(response, 402, refusal);
				return;
			}
		}
		try {
			const submitted = await ctx.runtime.submitAgentSessionCommand(sessionId, {
				commandId,
				idempotencyKey,
				clientId,
				name: name as AgentSessionCommandName,
				payload,
				now: Date.now(),
			});
			if (!submitted) {
				sendJson(response, 404, { error: "Agent session not found" });
				return;
			}
			const liveDelivery = await drainLiveAgentCommands(
				ctx,
				sessionId,
				submitted.record.target_generation,
				submitted.accepted && !submitted.duplicate && submitted.record.state === "queued",
			);
			sendJson(response, submitted.accepted ? (submitted.duplicate ? 200 : 202) : 409, {
				command: submitted.record,
				duplicate: submitted.duplicate,
				driver: submitted.driver,
				liveDelivery,
				...(submitted.accepted ? {} : { error: submitted.record.error, code: "agent_session_command_rejected" }),
			});
		} catch (error) {
			if (error instanceof AgentSessionCommandConflictError) {
				sendJson(response, 409, { error: error.message, code: error.code });
				return;
			}
			throw error;
		}
		return;
	}
	const agentSessionCommandCancelMatch = pathname.match(/^\/api\/agent-sessions\/([^/]+)\/commands\/([^/]+)\/cancel$/);
	if (method === "POST" && agentSessionCommandCancelMatch) {
		span?.updateName("POST /api/agent-sessions/:sessionId/commands/:commandId/cancel");
		const sessionId = decodeURIComponent(agentSessionCommandCancelMatch[1]);
		const commandId = decodeURIComponent(agentSessionCommandCancelMatch[2]);
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;
		const addressed = await readAddressedAgentSession(request, response, ctx.runtime, sessionId, ownerUserId);
		if (!addressed) return;
		const { session } = addressed;
		if (refuseViewerSessionAct(response, session, "stop", addressed.role)) return;
		const body = (await readJsonBody(request)) as { clientId?: unknown };
		const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
		if (!clientId) {
			sendJson(response, 400, { error: "clientId is required" });
			return;
		}
		try {
			const cancelled = await ctx.runtime.cancelAgentSessionCommand(sessionId, commandId, {
				clientId,
				now: Date.now(),
			});
			if (!cancelled) {
				sendJson(response, 404, { error: "Agent session command not found" });
				return;
			}
			sendJson(response, 200, {
				command: cancelled.record,
				duplicate: cancelled.duplicate,
				driver: cancelled.driver,
			});
		} catch (error) {
			if (error instanceof AgentSessionCommandConflictError) {
				sendJson(response, 409, { error: error.message, code: error.code });
				return;
			}
			throw error;
		}
		return;
	}
	if (method === "GET" && agentSessionCommandsMatch) {
		span?.updateName("GET /api/agent-sessions/:sessionId/commands");
		const sessionId = decodeURIComponent(agentSessionCommandsMatch[1]);
		const ownerUserId = await requireAuthenticatedOwnerOrToken(request, response, url);
		if (!ownerUserId) return;
		if (!(await readAddressedAgentSession(request, response, ctx.runtime, sessionId, ownerUserId))) return;
		sendJson(response, 200, { commands: await ctx.runtime.listAgentSessionCommands(sessionId) });
		return;
	}

	const agentSessionMatch = pathname.match(/^\/api\/agent-sessions\/([^/]+)$/);
	if (method === "GET" && agentSessionMatch) {
		span?.updateName("GET /api/agent-sessions/:sessionId");
		const sessionId = decodeURIComponent(agentSessionMatch[1]);
		const ownerUserId = await requireAuthenticatedOwnerOrToken(request, response, url);
		if (!ownerUserId) return;

		const addressed = await readAddressedAgentSession(request, response, ctx.runtime, sessionId, ownerUserId);
		if (!addressed) return;
		const { session } = addressed;
		const events = await ctx.runtime.listAgentSessionEvents(sessionId);
		const storedDocument = parseMaybeJson(session.document_json);
		const documentOps = await ctx.runtime.listAgentSessionDocumentOps(sessionId);
		const documentBackend = projectAgentSessionDocumentBackend(storedDocument);
		// The transcript is served as one conversation with an honest time on every item: a
		// regrown generation's node result that repeated a durable command's reply is dropped
		// (D3) and a missing `ts` is read from the command rows and result-append operations
		// (D4). Reading never rewrites the stored document.
		const document =
			storedDocument && typeof storedDocument === "object" && !Array.isArray(storedDocument)
				? annotateTranscriptTimestamps(canonicalTranscript(storedDocument as Record<string, unknown>, sessionId), {
						commands: await ctx.runtime.listAgentSessionCommands(sessionId),
						ops: documentOps,
						sessionModel: session.model,
					})
				: storedDocument;
		const chatFacts = await ctx.runtime.readChatSessionCatalogue(sessionId);
		sendJson(response, 200, {
			session: projectAgentSession(session, chatFacts ? projectChatSessionFacts(chatFacts) : undefined),
			document,
			documentBackend,
			documentRevision: documentBackend.revision,
			documentChangeId: documentBackend.changeId,
			documentOps: documentOps.map(projectAgentSessionDocumentOp),
			events: events.map(projectAgentSessionEvent),
		});
		return;
	}

	// POST /api/workflows/run — legacy workflow-run face.
	// POST /api/invocations — canonical InvocationEnvelope/Receipt face.
	// Callers that send no `workflow_name` default to survey-synthesize: zero
	// stranded callers, one unified dispatch path.
	if (method === "POST" && (pathname === "/api/workflows/run" || pathname === "/api/invocations")) {
		span?.updateName(pathname === "/api/invocations" ? "POST /api/invocations" : "POST /api/workflows/run");
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;

		if (!ctx.eventBus) {
			sendJson(response, 500, { error: "event bus unavailable" });
			return;
		}
		const authContext = resolveHostedAuthContext(request.headers);
		if (!authContext) {
			sendJson(response, 401, { error: "Authentication required" });
			return;
		}
		const submittedBody = (await readJsonBody(request)) as {
			schema?: string;
			invocationId?: string;
			target?: { workflowName?: string; workflowUri?: string; definitionDigest?: string };
			input?: unknown;
			actorRef?: string;
			graph?: { ownerPrincipal?: string; graphId?: string };
			cause?: InvocationEnvelopeV1["cause"];
			idempotencyKey?: string;
			deadlineMs?: number;
			budget?: InvocationEnvelopeV1["budget"];
			graph_owner?: string;
			graph_id?: string;
			// Generic dispatch: callers send workflow_name to select a workflow.
			workflow_name?: string;
			// Witnessed dynamic dispatch: a Garden/Emporium binding can supply source
			// without restarting Choreograph. Arbitrary agent/composite host JS remains
			// trusted/local and flag-gated; sandboxed program source is safe to accept,
			// and exact bytes of a registered workflow select that reviewed entry.
			workflow_source?: string;
			workflow_binding?: {
				source?: string;
				script?: string;
				name?: string;
				workflowUri?: string;
				scriptSha256?: string;
				script_sha256?: string;
				executor?: "gated" | "dumb";
				execution?: ExecutionBindingInput;
				inputSchema?: unknown;
				outputSchema?: unknown;
			};
			// Generic args: passed verbatim to the script's `args` global for
			// non-survey-synthesize entries.
			workflow_args?: unknown;
			// survey-synthesize legacy fields (still handled by buildInputs shim):
			question?: string;
			doc_ids?: string[];
			doc_query?: string;
			k?: number;
			map_model?: string;
			synth_model?: string;
		};
		let envelope: InvocationEnvelopeV1 | undefined;
		let body = submittedBody;
		const invocationLogFields = () => ({
			workflow: body.workflow_name ?? submittedBody.target?.workflowName,
			graphId: body.graph_id ?? submittedBody.graph?.graphId,
			invocationId: envelope?.invocationId ?? submittedBody.invocationId,
			ownerUserId,
		});
		const failInvocation = (stage: string, error: unknown, fallbackCode?: string): void => {
			sendInvocationFailure(response, stage, error, invocationLogFields(), fallbackCode);
		};
		try {
			envelope = parseInvocationEnvelope(submittedBody, pathname, ownerUserId);
			if (envelope) {
				body = {
					...submittedBody,
					workflow_name: envelope.target.workflowName,
					workflow_args: envelope.input,
					graph_id: envelope.graph?.graphId,
					graph_owner: envelope.graph?.ownerPrincipal,
				};
			}
		} catch (error) {
			const fault =
				error instanceof InvocationFault ? error : new InvocationFault("invalid_envelope", String(error), 400);
			failInvocation("admission", fault);
			return;
		}
		// The gateway mints the caller's graph role after its ACL check. Only the gateway can authenticate as the
		// internal service, so the header is believed only on that path (and never on a direct owner bearer). When it
		// is present it is the only rule (D4); an unreadable one is the caller's 400 before anything resolves.
		let gatewayGraphRole: WorkspaceChatRole | undefined;
		let gatewayGraphAddress: GatewayGraphAddress | undefined;
		try {
			const facts = gatewayRequestFacts(request, authContext);
			gatewayGraphRole = facts.role;
			gatewayGraphAddress = facts.address;
		} catch (error) {
			failInvocation("admission", error);
			return;
		}
		const workflowCaller = resolveWorkflowCallerContext({
			authMethod: authContext.method,
			ownerUserId,
			triggerAdapter: firstHeaderValue(request.headers["x-sophia-trigger-adapter"])?.trim(),
			humanDelegation: firstHeaderValue(request.headers["x-sophia-human-delegation"])?.trim(),
			humanDelegationSecret: process.env.CHOREOGRAPH_GATEWAY_HUMAN_DELEGATION_SECRET?.trim(),
			actorRef: envelope?.actorRef,
			graphOwnerPrincipal: envelope?.graph?.ownerPrincipal,
			trustInternalVehicleAsOwner: process.env.CHOREOGRAPH_TRUST_INTERNAL_VEHICLE_AS_OWNER === "true",
		});

		const graphId = body.graph_id ?? process.env.MNEMOSYNE_GRAPH_ID ?? "choreograph-2";
		const prefersAsync = /(?:^|,)\s*respond-async\s*(?:,|$)/i.test(firstHeaderValue(request.headers.prefer) ?? "");

		// Resolve the entry: static registry by default; trusted dynamic source
		// when supplied. Unknown names remain a 400, preserving old callers.
		let entry: WorkflowRegistryEntry;
		try {
			entry = resolveWorkflowEntryForRun(body, graphId);
		} catch (err) {
			failInvocation("resolve-workflow", err, "workflow_unresolved");
			return;
		}
		// The run's graph is the graph the gateway checked (the gateway's exam, MAJOR): a role minted for one graph is
		// never applied to another. The gateway binds a canonical invocation's envelope to the URL's graph; this holds
		// the same line for every face of this route, whatever the role.
		if (
			gatewayGraphAddress &&
			(graphId !== gatewayGraphAddress.graphId ||
				(body.graph_owner !== undefined && body.graph_owner !== gatewayGraphAddress.graphOwnerPrincipal))
		) {
			failInvocation(
				"admission",
				new InvocationFault(
					"graph_binding_mismatch",
					"the invocation names a graph other than the one this request was addressed through",
					403,
				),
			);
			return;
		}
		// The graph's owner is the one the gateway checked (exam 2, A): when the request was addressed through a graph, the
		// session binds to exactly that owner+graph, whether or not the body names an owner, and never to the service
		// authentication's acting user or `MNEMOSYNE_GRAPH_OWNER`. A body that names another owner was refused above.
		const mintedGraphOwner = gatewayGraphAddress?.graphOwnerPrincipal;
		// Rule 2 retired (exam 1): a workspace chat starts only on a role the gateway minted, before any graph read.
		if (
			entry === getWorkflow(WORKSPACE_CHAT_WORKFLOW_NAME) &&
			gatewayGraphRole === undefined &&
			gatewayGraphRoleRequired()
		) {
			failInvocation("admission", graphRoleRequiredFault());
			return;
		}
		// A person who can only view the graph starts the reviewed workspace chat and nothing else (D4): the gateway
		// admits a viewer's invocation for that workflow only, and this host holds the same line on what it resolved.
		if (gatewayGraphRole === "viewer" && entry !== getWorkflow(WORKSPACE_CHAT_WORKFLOW_NAME)) {
			failInvocation(
				"admission",
				new InvocationFault(
					"workflow_role_insufficient",
					`someone who can only view this graph may start only ${WORKSPACE_CHAT_WORKFLOW_NAME}`,
					403,
				),
			);
			return;
		}

		if (envelope && envelope.target.definitionDigest !== entry.scriptSha256) {
			const fault = new InvocationFault(
				"definition_digest_mismatch",
				"invocation target digest does not match the resolved workflow definition",
				409,
				{ expected: envelope.target.definitionDigest, actual: entry.scriptSha256 },
			);
			failInvocation("admission", fault);
			return;
		}

		let execution: ReturnType<typeof resolveExecutionBinding>;
		try {
			execution = resolveExecutionBinding(entry.compiled.meta);
		} catch (error) {
			const fault =
				error instanceof InvocationFault
					? error
					: new InvocationFault(
							"execution_binding_invalid",
							error instanceof Error ? error.message : String(error),
							409,
						);
			failInvocation("admission", fault);
			return;
		}
		const suppliedBinding = body.workflow_binding;
		if (suppliedBinding?.name && suppliedBinding.name !== entry.compiled.meta.name) {
			const fault = new InvocationFault(
				"workflow_binding_mismatch",
				"workflow binding name does not match the resolved workflow",
				409,
				{ binding: suppliedBinding.name, source: entry.compiled.meta.name },
			);
			failInvocation("admission", fault);
			return;
		}
		if (envelope && suppliedBinding?.workflowUri && suppliedBinding.workflowUri !== envelope.target.workflowUri) {
			const fault = new InvocationFault(
				"workflow_binding_mismatch",
				"workflow binding URI does not match the invocation target URI",
				409,
				{ binding: suppliedBinding.workflowUri, target: envelope?.target.workflowUri },
			);
			failInvocation("admission", fault);
			return;
		}
		if (suppliedBinding?.executor && suppliedBinding.executor !== legacyExecutorFor(execution)) {
			const fault = new InvocationFault(
				"execution_binding_mismatch",
				"compatibility executor does not match the workflow source metadata",
				409,
				{ published: suppliedBinding.executor, source: legacyExecutorFor(execution) },
			);
			failInvocation("admission", fault);
			return;
		}
		if (suppliedBinding?.execution) {
			try {
				const declaredExecution = resolveExecutionBinding({
					name: entry.compiled.meta.name,
					executor: suppliedBinding.executor,
					execution: suppliedBinding.execution,
				});
				if (canonicalJson(declaredExecution) !== canonicalJson(execution)) {
					throw new InvocationFault(
						"execution_binding_mismatch",
						"published execution binding does not match the workflow source metadata",
						409,
						{ published: declaredExecution, source: execution },
					);
				}
			} catch (error) {
				const fault =
					error instanceof InvocationFault
						? error
						: new InvocationFault("execution_binding_invalid", String(error), 409);
				failInvocation("admission", fault);
				return;
			}
		}
		try {
			assertPublishedWorkflowSchema("input", suppliedBinding?.inputSchema, entry.compiled.meta.inputs);
			assertPublishedWorkflowSchema("output", suppliedBinding?.outputSchema, entry.compiled.meta.outputs);
		} catch (error) {
			const fault =
				error instanceof InvocationFault
					? error
					: new InvocationFault("workflow_schema_invalid", String(error), 409);
			failInvocation("admission", fault);
			return;
		}

		// Genuine agentless path: authenticated, durable, and sandboxed, with no
		// blanket HostedMnemosyneProxy or agent runner. Only the workflow's declared
		// host capabilities receive the authorized owner+graph tuple and service
		// bindings they need.
		if (execution.controller === "program" && execution.isolation === "sandbox") {
			const programServiceAuth = resolveGatewayServiceAuth(ownerUserId);
			const graphOwner =
				mintedGraphOwner ||
				body.graph_owner?.trim() ||
				process.env.MNEMOSYNE_GRAPH_OWNER?.trim() ||
				(programServiceAuth ? `user:${programServiceAuth.onBehalfOf}` : undefined);
			let inputs: import("./workflow/harness.js").WorkflowRunInputs;
			try {
				inputs = await entry.buildInputs(body, {
					graphId,
					graphOwnerPrincipal: graphOwner,
					runtime: ctx.runtime,
					invocation: envelope,
					actorRef: envelope?.actorRef ?? canonicalActorRef(ownerUserId),
					ownerUserId,
					...(ctx.modelCatalog ? { modelCatalog: ctx.modelCatalog } : {}),
					...(ctx.chatVoiceMarket ? { chatVoiceMarket: ctx.chatVoiceMarket } : {}),
					caller: workflowCaller,
				});
				validateProgramInvocationInput(entry, inputs);
			} catch (error) {
				const status = (error as { status?: number }).status ?? 400;
				failInvocation(
					"build-inputs",
					error instanceof InvocationFault
						? error
						: new InvocationFault(
								"invalid_input",
								error instanceof Error ? error.message : String(error),
								status,
							),
				);
				return;
			}

			const runId = `wfr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
			const invocationId = envelope?.invocationId ?? `inv-${runId.slice(4)}`;
			let timeoutMs: number | undefined;
			try {
				timeoutMs = invocationTimeoutMs(envelope);
			} catch (error) {
				const fault = error as InvocationFault;
				failInvocation("admission", fault);
				return;
			}
			// ── The record-graph edge. A program workflow that judges a disposable
			// graph and files its judgment in a durable one needs a SECOND
			// owner-scoped binding: under gateway service-auth the `graphId` tool
			// argument is stripped and routing is the proxy's own
			// /o/{owner}/g/{id}/mcp URL, so reusing the run's (SUT) binding would
			// quietly write the graph under test. The grant lives host-side and
			// never enters the sandbox (G0 §4.4d) — one serialized writer against a
			// two-permit SPARQL admission layer, and no editor authority inside bwrap.
			//
			// The owner is `SOPHIA_BATTERY_RECORD_GRAPH_OWNER` when set, else the
			// run's own resolved owner, which is correct for the single-tenant canary
			// where one sub owns both the obs-svc-* cell and `observatory`. It is
			// deliberately inferred no further: if that principal holds no editor
			// grant on the record graph — none exists today, G0 open decision D1 —
			// the gateway refuses, the record write reports `denied`, and the run
			// fails saying so. A battery whose testimony is not being filed has to be
			// loud; a quiet one is green runs over an empty graph.
			const programDirectMcp = resolveDirectMcpAuth(ownerUserId);
			const programApiBaseUrl =
				process.env.MNEMOSYNE_API_BASE_URL?.trim() ||
				programServiceAuth?.gatewayBaseUrl ||
				programDirectMcp?.mcpUrl;
			const recordGraphOwner = process.env.SOPHIA_BATTERY_RECORD_GRAPH_OWNER?.trim() || graphOwner;
			const recordProxies = new Map<string, HostedMnemosyneProxy>();
			const recordWriters = new Map<string, ReturnType<typeof makeHostedGraphWriter>>();
			const closeRecordProxies = async () => {
				await Promise.allSettled([...recordProxies.values()].map((proxy) => proxy.close()));
				recordProxies.clear();
				recordWriters.clear();
			};
			const recordWriterFor =
				programApiBaseUrl && recordGraphOwner
					? async (recordGraphId: string) => {
							const existing = recordWriters.get(recordGraphId);
							if (existing) return existing;
							const proxy = new HostedMnemosyneProxy({
								apiBaseUrl: programApiBaseUrl,
								ownerPrincipal: recordGraphOwner,
								graphId: recordGraphId,
								toolProfile: "full",
								runtime: process.env.MNEMOSYNE_RUNTIME ?? "choreograph",
								label: `workflow-record:${recordGraphId}`,
								requestTimeoutMs: readHostedRequestTimeoutMs(),
								authContext,
								apiToken: process.env.MNEMOSYNE_API_TOKEN,
								allowGlobalTokenFallback: false,
								requiredTools: ["sparql_update"],
								serviceAuth: programServiceAuth,
								directMcp: programDirectMcp,
							});
							await proxy.start();
							recordProxies.set(recordGraphId, proxy);
							// No Emporium adapter: the record lane is plain attributed RDF, not
							// a registered-vocabulary projection.
							const writer = makeHostedGraphWriter(proxy);
							recordWriters.set(recordGraphId, writer);
							return writer;
						}
					: undefined;

			const execute = async () => {
				try {
					return await runProgramInvocation(
						{
							spawner: ctx.spawner,
							eventBus: ctx.eventBus as SandboxEventBus,
							journal: ctx.journal,
							runtime: ctx.runtime,
							capture: ctx.capture,
							...(recordWriterFor ? { recordWriterFor } : {}),
							bindCapabilities: (binding) =>
								createDefaultHostCapabilityCatalog({
									billing: ctx.billing,
									creditGate: ctx.creditGate,
									capture: ctx.capture,
									modelCatalog: ctx.modelCatalog,
									workflowRuntime: ctx.runtime,
									evolution: ctx.evolution,
								}).bind(binding.names, binding),
						},
						{
							runId,
							invocationId,
							actorRef: envelope?.actorRef ?? canonicalActorRef(ownerUserId),
							ownerUserId,
							graphId,
							...(graphOwner ? { graphOwner } : {}),
							targetWorkflowUri: envelope?.target.workflowUri,
							entry,
							inputs,
							...(timeoutMs === undefined ? {} : { timeoutMs }),
							authContext,
						},
					);
				} finally {
					await closeRecordProxies();
				}
			};

			response.setTimeout(0);
			const syncMode = pathname === "/api/invocations" ? !prefersAsync : process.env.WORKFLOW_RUN_SYNC === "1";
			if (syncMode) {
				try {
					const run = await execute();
					sendJson(response, 200, buildRunResponseBody(run, graphId, entry.compiled.meta.name));
				} catch (error) {
					const fault =
						error instanceof InvocationFault
							? error
							: new InvocationFault(
									"execution_error",
									error instanceof Error ? error.message : String(error),
									500,
								);
					failInvocation("admission", fault);
				}
				return;
			}

			sendJson(response, 202, {
				runId,
				invocationId,
				status: "running",
				graph_id: graphId,
				workflowId: entry.compiled.meta.name,
			});
			let trackedTail!: Promise<void>;
			trackedTail = execute()
				.then(() => undefined)
				.catch((error) => {
					logInvocationFailureFrom("async-program-run", error, { ...invocationLogFields(), runId });
				})
				.finally(() => ctx.workflowTails?.delete(trackedTail));
			ctx.workflowTails?.add(trackedTail);
			return;
		}

		const serviceAuth = resolveGatewayServiceAuth(ownerUserId);
		const graphOwner =
			mintedGraphOwner ??
			body.graph_owner ??
			process.env.MNEMOSYNE_GRAPH_OWNER?.trim() ??
			(serviceAuth ? `user:${serviceAuth.onBehalfOf}` : undefined);
		const directMcp = resolveDirectMcpAuth(ownerUserId);
		const apiBaseUrl = process.env.MNEMOSYNE_API_BASE_URL?.trim() || serviceAuth?.gatewayBaseUrl || directMcp?.mcpUrl;
		const requiresGraph = execution.capabilities.includes("garden.graph");
		if (requiresGraph && !apiBaseUrl) {
			failInvocation(
				"graph-backend",
				new InvocationFault(
					"graph_backend_unconfigured",
					"workflow declares garden.graph, but no graph backend is configured; set MNEMOSYNE_API_BASE_URL, " +
						"direct MCP auth (MNEMOSYNE_MCP_URL + MNEMOSYNE_MCP_ACCESS_TOKEN), or gateway service-auth " +
						"(MNEMOSYNE_SERVICE_TOKEN + MNEMOSYNE_GATEWAY_BASE_URL)",
					503,
				),
			);
			return;
		}
		const graphEmporiumIngestUrl = apiBaseUrl ? resolveEmporiumIngestBaseUrl(serviceAuth?.gatewayBaseUrl) : undefined;
		const graphEmporiumAuth = graphEmporiumIngestUrl
			? serviceAuth
				? {
						mode: "gateway" as const,
						serviceToken: serviceAuth.serviceToken,
						onBehalfOf: serviceAuth.onBehalfOf,
						...(graphOwner ? { ownerPrincipal: graphOwner } : {}),
					}
				: {
						mode: "local" as const,
						bearer: process.env.WORKFLOW_EMPORIUM_INGEST_BEARER?.trim() ?? directMcp?.accessToken,
					}
			: undefined;
		const graphWriterOptions =
			graphEmporiumIngestUrl && graphEmporiumAuth
				? { emporium: { baseUrl: graphEmporiumIngestUrl, auth: graphEmporiumAuth } }
				: undefined;

		// Long-running: disable the per-request timeout for the workflow duration.
		response.setTimeout(0);

		// A graph is an explicitly declared workflow capability, not a prerequisite
		// for materializing an agent. Standalone Choreograph can therefore run a
		// graphless Prime workflow with mock inference; graph-bearing workflows keep
		// the same fail-closed proxy and authority path.
		const graphProxy = apiBaseUrl
			? new HostedMnemosyneProxy({
					apiBaseUrl,
					ownerPrincipal: graphOwner,
					graphId,
					toolProfile: "full",
					runtime: process.env.MNEMOSYNE_RUNTIME ?? "choreograph",
					label: "workflow-engine",
					requestTimeoutMs: readHostedRequestTimeoutMs(),
					authContext,
					apiToken: process.env.MNEMOSYNE_API_TOKEN,
					allowGlobalTokenFallback: false,
					// A workspace chat's run needs only to read (exam 1, finding 2): a Viewer's cell serves no write tool, and
					// demanding one refused every Viewer's chat at startup. Other workflows keep their write floor.
					requiredTools:
						entry === getWorkflow(WORKSPACE_CHAT_WORKFLOW_NAME)
							? [...WORKSPACE_CHAT_REQUIRED_TOOLS]
							: ["search_documents", "read_document", "write_document", "sparql_update", "sparql_query"],
					serviceAuth,
					directMcp,
				})
			: undefined;
		const auxiliaryGraphProxies = new Map<string, HostedMnemosyneProxy>();
		const closeWorkflowGraphProxies = async () => {
			await Promise.allSettled([...auxiliaryGraphProxies.values()].map((proxy) => proxy.close()));
			await graphProxy?.close().catch(() => {});
		};

		try {
			await graphProxy?.start();
			const graph = graphProxy ? makeHostedGraphWriter(graphProxy, graphWriterOptions) : undefined;
			const auxiliaryGraphWriters = new Map<string, ReturnType<typeof makeHostedGraphWriter>>();
			const graphFor =
				graph && apiBaseUrl
					? async (address: DomainGraphAddressV1) => {
							const key = `${address.ownerPrincipal}\u0000${address.graphId}`;
							if (address.graphId === graphId && address.ownerPrincipal === graphOwner) return graph;
							if (directMcp) {
								throw new Error("direct MCP mode cannot resolve a foreign owner-scoped authority graph");
							}
							const existing = auxiliaryGraphWriters.get(key);
							if (existing) return existing;
							const proxy = new HostedMnemosyneProxy({
								apiBaseUrl,
								ownerPrincipal: address.ownerPrincipal,
								graphId: address.graphId,
								toolProfile: "full",
								runtime: process.env.MNEMOSYNE_RUNTIME ?? "choreograph",
								label: `workflow-authority:${address.graphId}`,
								requestTimeoutMs: readHostedRequestTimeoutMs(),
								authContext,
								apiToken: process.env.MNEMOSYNE_API_TOKEN,
								allowGlobalTokenFallback: false,
								requiredTools: ["read_document"],
								serviceAuth,
								directMcp,
							});
							await proxy.start();
							auxiliaryGraphProxies.set(key, proxy);
							// Foreign authority cells are read-only on this edge. In particular,
							// never carry the home graph's privileged Emporium adapter across.
							const writer = makeHostedGraphWriter(proxy);
							auxiliaryGraphWriters.set(key, writer);
							return writer;
						}
					: undefined;

			// ── Per-workflow input construction (validation + optional doc-search
			// for survey-synthesize happen inside buildInputs). A 400-tagged error
			// from buildInputs surfaces as a 400 response.
			let inputs: import("./workflow/harness.js").WorkflowRunInputs;
			try {
				inputs = await entry.buildInputs(body, {
					...(graph ? { graph } : {}),
					...(graphFor ? { graphFor } : {}),
					graphId,
					graphOwnerPrincipal: graphOwner,
					runtime: ctx.runtime,
					invocation: envelope,
					actorRef: envelope?.actorRef ?? canonicalActorRef(ownerUserId),
					ownerUserId,
					...(ctx.modelCatalog ? { modelCatalog: ctx.modelCatalog } : {}),
					...(ctx.chatVoiceMarket ? { chatVoiceMarket: ctx.chatVoiceMarket } : {}),
					...(ctx.creditGate ? { creditGate: ctx.creditGate } : {}),
					caller: workflowCaller,
					...(gatewayGraphRole !== undefined ? { gatewayGraphRole } : {}),
					...(graphProxy
						? {
								readGraph: (tool, args) => graphProxy.callTool(tool, args),
								listGraphTools: async () => (await graphProxy.listTools()).map((tool) => tool.name),
							}
						: {}),
				});
			} catch (err) {
				// Configuration and authority verdicts (no definition, bad manifest,
				// unverifiable grant, denied mode…) are definite 4xx outcomes with a
				// stable code. No run exists yet, so nothing may have committed.
				failInvocation("build-inputs", err, "input_build_failed");
				await closeWorkflowGraphProxies();
				return;
			}

			// ── Credit gate, Door A (ingress). A person out of credits gets the coded 402 before any run,
			// sandbox or graph write exists. It sits after authentication and input validation (a 404 or a
			// 400 stays one) and only for agentic workloads: a model-free program never reaches this branch.
			// In observe mode the verdict is recorded and the invocation proceeds. A chat admitted from the live
			// catalogue carries the rate card its Session will be pinned to (in the trusted host context): the bar is
			// the smallest viable call on THAT card. Anything else is quoted on the static table, as it is billed.
			if (ctx.creditGate && execution.modelUse === "agentic") {
				const chatRateCard = readWorkspaceChatHostContext(inputs.hostContext)?.pricing;
				const verdict = await ctx.creditGate.admitIngress({
					door: "ingress.invocation",
					userId: ownerUserId,
					provider: inputs.config.provider,
					model: inputs.config.model,
					fundingSource: await ingressFundingSource(ctx, ownerUserId, inputs.config.provider),
					...(chatRateCard ? { rateCard: chatRateCard } : {}),
				});
				if (!verdict.allow) {
					sendJson(response, verdict.status, verdict.body);
					await closeWorkflowGraphProxies();
					return;
				}
			}

			// The runId is minted HERE, pre-fan-out, so the async 202 can return it
			// before any node spawns. RAW `wfr-` id — the gateway keys runs by it.
			const runId = `wfr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
			const startedAt = Date.now();
			const parentInvocationId = envelope?.invocationId ?? `inv-${runId.slice(4)}`;
			const domainHost = readDomainAgentHostContext(inputs.hostContext);
			const workspaceChatHost = readWorkspaceChatHostContext(inputs.hostContext);
			const graphPlanHost = readGraphPlanHostContext(inputs.hostContext);
			// Exam 1, finding 2: the host's own bookkeeping (wf: provenance at start, per node and at the end, the agt:
			// fold, Emporium ingest, evolution projection) is written as the person with sparql_update, outside every
			// manifest. A workspace chat bound to the Reader may belong to someone who can only view the graph: its run
			// writes nothing to the graph, and what it holds of the graph refuses writes (`readOnlyGraphWriter`). Its record
			// is Choreograph's own (journal, Session, catalogue). A Writer chat keeps the bookkeeping, as every run does.
			const hostWritesGraph = !workspaceChatHost || workspaceChatHost.mode.mode.access === "write";
			const runGraph = graph && !hostWritesGraph ? readOnlyGraphWriter(graph) : graph;
			const workflowActorRef = envelope?.actorRef ?? canonicalActorRef(ownerUserId);
			const agentCapabilityCatalog = createDefaultHostCapabilityCatalog({
				billing: ctx.billing,
				creditGate: ctx.creditGate,
				capture: ctx.capture,
				modelCatalog: ctx.modelCatalog,
				workflowRuntime: ctx.runtime,
				evolution: ctx.evolution,
			});
			const catalogNames = new Set(agentCapabilityCatalog.list());
			const implicitAgentCapabilities = new Set(["mnemosyne", "garden.graph", "choreograph.agent"]);
			const declaredAgentCapabilities = domainHost
				? [...new Set(domainHost.toolbelt.capabilities.map((capability) => capability.capability))]
				: [];
			const unavailableAgentCapabilities = declaredAgentCapabilities.filter(
				(name) => !implicitAgentCapabilities.has(name) && !catalogNames.has(name),
			);
			if (unavailableAgentCapabilities.length > 0) {
				throw new InvocationFault(
					"capability_unavailable",
					`Domain Agent grant names unavailable host capabilities: ${unavailableAgentCapabilities.sort().join(", ")}`,
					409,
				);
			}
			const bindableAgentCapabilities = declaredAgentCapabilities.filter((name) => catalogNames.has(name));
			const grantedAgentTools: Record<string, string[]> = {};
			const grantedAgentToolDestructiveness: Record<string, Record<string, boolean>> = {};
			for (const tool of domainHost?.toolbelt.tools ?? []) {
				if (!tool.available) continue;
				const capabilityTools = grantedAgentTools[tool.capability] ?? [];
				capabilityTools.push(tool.name);
				grantedAgentTools[tool.capability] = capabilityTools;
				const capabilityDestructiveness = grantedAgentToolDestructiveness[tool.capability] ?? {};
				capabilityDestructiveness[tool.name] = tool.destructive;
				grantedAgentToolDestructiveness[tool.capability] = capabilityDestructiveness;
			}
			let childMediator: BoundedChildInvocationMediator | undefined;
			if (domainHost?.programs.length) {
				if (!execution.mayInvokeChildren) {
					throw new InvocationFault(
						"child_invocation_denied",
						"workflow execution binding forbids its configured domain programs",
						409,
					);
				}
				assertRegisteredDomainPrograms(domainHost.programs);
				const envelopeLimit = envelope?.budget?.maxChildInvocations;
				const maxChildInvocations = Math.min(
					domainHost.maxProgramInvocations,
					envelopeLimit ?? domainHost.maxProgramInvocations,
				);
				const parentDeadlineMs = resolveInvocationDeadlineMs(envelope, startedAt);
				childMediator = new BoundedChildInvocationMediator({
					parentRunId: runId,
					parentInvocationId,
					actorRef: envelope?.actorRef ?? canonicalActorRef(ownerUserId),
					graphId,
					...(graphOwner ? { graphOwnerPrincipal: graphOwner } : {}),
					programs: domainHost.programs,
					toolbelt: domainHost.toolbelt,
					maxChildInvocations,
					...(parentDeadlineMs === undefined ? {} : { parentDeadlineMs }),
					dispatch: loopbackChildInvocationDispatch(authContext),
				});
			}

			await ctx.runtime.createWorkflowInstance({
				runId,
				workflowName: entry.compiled.meta.name,
				graphId,
				ownerUserId,
				sourceSha256: entry.scriptSha256,
				sourceText: entry.compiled.source,
				inputs,
				startedAt,
				payload: { workflowName: entry.compiled.meta.name },
			});

			// ── Journal: open the run header + run_started (non-fatal). The journal
			// is the source of truth; a hiccup here must never sink a good run.
			try {
				await ctx.journal.createRun({
					run_id: runId,
					workflow_name: entry.compiled.meta.name,
					graph_id: graphId,
					owner_user_id: ownerUserId,
					status: "running",
					started_at: startedAt,
				});
				await ctx.journal.appendEvent(runId, {
					type: "run_started",
					ts: startedAt,
					payload: { workflowName: entry.compiled.meta.name },
				});
			} catch (err) {
				console.error(`[workflow] journal createRun failed for ${runId}: ${String(err)}`);
			}

			// ── INCREMENTAL PROVENANCE (wf:Run on run_started). Emit a coarse
			// `wf:Run` row (status `running`, agentCount 0) BEFORE fan-out so the
			// graph is a live progress feed from t0 — not only at run_done. NON-FATAL
			// and frozen-vocab-safe (same predicate set as the final fold). Skipped
			// in emporium-ingest mode (that path owns the wf: emit). The final fold
			// strictly replaces this transient projection.
			const emporiumIngestUrl = graphEmporiumIngestUrl;
			const incrementalProvenance = Boolean(graph) && !emporiumIngestUrl && hostWritesGraph;
			if (graph && incrementalProvenance) {
				try {
					const seedWorkflowUri = mintWorkflowUri(entry.compiled.meta.name);
					const seedRun = {
						runId,
						workflowName: entry.compiled.meta.name,
						workflowUri: seedWorkflowUri,
						status: "running" as const,
						startedAt,
						endedAt: startedAt,
						durationMs: 0,
						agentCount: 0,
						totalTokens: 0,
						agents: [],
					};
					await graph.sparqlUpdate(graphId, serializeRunStartedProvenance(seedRun));
				} catch (err) {
					// A pre-fan-out SPARQL reject must NOT abort the run — log + carry on.
					console.error(`[workflow] incremental wf:Run emit failed for ${runId}: ${String(err)}`);
				}
			}

			// ── Journaled node runner: tees the per-sandbox bus into run_events
			// via a per-run serial writer (P1-WP3).
			const { runner, drain, onPhase, onLog } = withJournal(
				{
					spawner: ctx.spawner,
					eventBus: ctx.eventBus,
					authContext,
					ownerUserId,
					mnemosyne: { ownerPrincipal: graphOwner, graphId },
					...(bindableAgentCapabilities.length === 0
						? {}
						: {
								bindCapabilities: (spec) => {
									const attenuated = attenuateAgentCapabilitiesForRuntime({
										capabilityNames: bindableAgentCapabilities,
										grantedTools: grantedAgentTools,
										allowWorkflowProposals: spec.runtime?.constraints.allowWorkflowProposals === true,
									});
									return agentCapabilityCatalog.bind(attenuated.capabilityNames, {
										graphId,
										runId,
										...(graphOwner ? { graphOwner } : {}),
										actorRef: workflowActorRef,
										ownerUserId,
										authority: execution.authority,
										authContext,
										input: inputs.schemaInput,
										grantedTools: attenuated.grantedTools,
										grantedCapabilities: domainHost?.toolbelt.capabilities ?? [],
										semanticScope: domainHost?.trigger,
										agentSession: {
											sessionId: spec.sessionId ?? "",
											nodeKey: spec.nodeKey,
											agentId: spec.agentId ?? spec.ontology?.subject.agentId ?? "",
											ontologyBindingDigest: spec.ontologyBindingDigest,
										},
									});
								},
							}),
					resolveCapabilityGrantPolicy: (spec) => {
						if (workspaceChatHost) {
							// Built-in workspace chat: no graph grant. The host's built-in mode (the
							// Writer or the Reader the run was bound to) is the whole tool authority:
							// its exact tools, this graph, and the Writer's argument policy or the
							// Reader's read ceiling. Re-derived from code; a run whose recorded mode
							// this host does not define is refused.
							const builtIn = builtInModeFenceForSession(
								{ iri: workspaceChatHost.mode.mode.iri, digest: workspaceChatHost.mode.digest },
								workspaceChatHost.graphId,
							);
							if (!builtIn || "mismatch" in builtIn) {
								throw new Error(
									`workspace chat mode <${workspaceChatHost.mode.mode.iri}> is not a built-in mode this host enforces`,
								);
							}
							return {
								// Bounded by what the session was handed and its prompt names (exam 1, finding 7).
								exactTools: {
									mnemosyne: workspaceChatGrantTools(builtIn.fence.mode.allowsTool, workspaceChatHost.tools),
								},
								mode: builtIn.fence,
							};
						}
						if (graphPlanHost) {
							// Built-in graph plan: no graph grant. Every step's being wears the Reader with its own
							// memory, fenced to this graph, with exactly the tools its spec names (`being-geist.ts`).
							return graphPlanStepGrantPolicy(graphPlanHost.graphId, spec.includeTools);
						}
						if (!domainHost && localAgentDefaultsEnabled()) {
							// A local Choreograph (one person's gardend): a workflow's agent step that no graph-defined
							// agent grants anything gets the workspace chat's built-in authority on its graph: the
							// Writer's tools, or the Reader's for a step that asks only to read. Narrowed further by
							// the step's own includeTools; gardend still checks every call against the service's token.
							const fence = workspaceChatFence(spec.graphId, spec.graphAccess === "read" ? "read" : "write");
							const include = spec.includeTools ? new Set(spec.includeTools) : undefined;
							return {
								exactTools: {
									mnemosyne: fence.mode.allowsTool.filter((tool) => !include || include.has(tool)),
								},
								mode: fence,
							};
						}
						const attenuated = attenuateAgentCapabilitiesForRuntime({
							capabilityNames: bindableAgentCapabilities,
							grantedTools: grantedAgentTools,
							allowWorkflowProposals: spec.runtime?.constraints.allowWorkflowProposals === true,
						});
						return {
							exactTools: attenuated.grantedTools,
							toolDestructiveness: grantedAgentToolDestructiveness,
							capabilities: domainHost?.toolbelt.capabilities ?? [],
							...(domainHost?.mode
								? {
										mode: {
											mode: domainHost.mode.mode,
											digest: domainHost.mode.digest,
											boundGraphId: spec.graphId,
										},
									}
								: {}),
						};
					},
					...(ctx.evolution
						? {
								resolveAgentWorkerConfig: (spec, config) =>
									spec.runtime?.kind === "prime"
										? ctx.evolution!.resolveWorkerConfig(config, {
												ownerUserId,
												graphId: spec.graphId,
											})
										: Promise.resolve(config),
							}
						: {}),
					...(ctx.spawner.contentAuthorityAdmissionPort()
						? { contentAuthorityAdmission: ctx.spawner.contentAuthorityAdmissionPort() }
						: {}),
					onProcessSpawn: async ({ spec, sandboxId }) => {
						if (!spec.sessionId) return;
						await ctx.runtime.bindAgentSandbox(spec.sessionId, {
							sandboxId,
							generation: spec.sandboxGeneration ?? 0,
							activationId:
								spec.invocationId ?? `${spec.sessionId}:generation:${String(spec.sandboxGeneration ?? 0)}`,
							now: Date.now(),
						});
						void ctx.spawner.refreshAgentSessionFamily(spec.sessionId, sandboxId);
					},
					onEvent: async ({ spec, event }) => {
						if (!spec.sessionId) return;
						if ("category" in event && event.category === "execution" && event.type === "compute.cell") {
							return;
						}
						let evolutionObjectsMayHaveChanged =
							"category" in event && event.category === "capability" && event.capability === "evolution";
						if (
							ctx.evolution &&
							"category" in event &&
							event.category === "agent" &&
							event.event.type === "prime_event" &&
							event.event.name === "refine_complete"
						) {
							await ctx.evolution.ingestHarnessRefinement({
								ownerUserId,
								graphId: spec.graphId,
								agentId: spec.agentId ?? spec.ontology?.subject.agentId ?? "",
								sessionId: spec.sessionId,
								event: event.event,
								occurredAt: Date.parse(event.ts),
							});
							evolutionObjectsMayHaveChanged = true;
						}
						if (ctx.evolution && evolutionObjectsMayHaveChanged && hostWritesGraph) {
							const projection = await ctx.evolution.flushRdfProjection(graph, { limit: 100 });
							if (projection.failed > 0) {
								console.warn(
									`[evolution] RDF projection deferred after ${String(projection.failed)} failed object(s); ${String(projection.pending)} remain in the durable outbox`,
								);
							}
						}
						const semanticEvent = mirrorAgentSessionEvent(event, spec);
						if (!semanticEvent) return;
						await ctx.runtime.appendAgentSessionEventForGeneration(
							spec.sessionId,
							spec.sandboxGeneration ?? 0,
							spec.invocationId ?? `${spec.sessionId}:generation:${String(spec.sandboxGeneration ?? 0)}`,
							semanticEvent,
						);
					},
				},
				ctx.journal,
				runId,
			);

			const runtimeRunner = makeRuntimeNodeRunner({
				runtime: ctx.runtime,
				memory: ctx.memory,
				baseRunner: runner,
				runId,
				workflowName: entry.compiled.meta.name,
				graphId,
				ownerUserId,
				graphOwnerPrincipal: graphOwner,
				...(ctx.spawner.contentAuthorityAdmissionPort()
					? { contentAuthorityAdmission: ctx.spawner.contentAuthorityAdmissionPort() }
					: {}),
				onDurableSessionTransition: async (spec) => {
					if (!spec.sessionId) return;
					const materialization = await ctx.runtime.readAgentMaterialization(
						spec.sessionId,
						spec.sandboxGeneration ?? 0,
					);
					if (!materialization) return;
					await ctx.spawner.refreshAgentSessionFamily(spec.sessionId, materialization.sandbox_id);
				},
				onIdle: (spec) =>
					ctx.spawner.scheduleAgentPassivation({
						sessionId: spec.sessionId!,
						generation: spec.sandboxGeneration ?? 0,
						ownerPrincipal: graphOwner,
						graphId,
						runtimeBundleDigest: spec.runtime!.bundle.digest,
						idleMs: spec.runtime!.constraints.idlePassivateMs,
						runtimeKind: spec.runtime!.kind,
					}),
			});
			const executableRunner = makeAgentRuntimeDispatcher({
				resolve: resolvePinnedAgentRuntime,
				run: runtimeRunner,
			});

			// ── INCREMENTAL PROVENANCE (wf:AgentRun per node-finish). Wrap the
			// journaled runner so each completed node lands a `wf:AgentRun` row as it
			// happens. This stays OUTSIDE withJournal (whose contract forbids minting
			// wf: triples) and outside the frozen-vocab path (same `agentBlock`
			// builder as the final fold). NON-FATAL; the final fold replaces these with
			// final agent triples, but may carry transient timing values. Writes stay
			// off the fan-out critical path and are drained before the final strict
			// replacement, preventing a late incremental insert from racing it.
			const incrementalProvenanceWrites = new Set<Promise<void>>();
			const provenanceRunner: NodeRunner =
				incrementalProvenance && graph
					? async (spec) => {
							const result = await executableRunner(spec);
							emitAgentRunProvenanceBestEffort(graph, graphId, runId, result, incrementalProvenanceWrites);
							return result;
						}
					: executableRunner;
			// Host-derived chat facts (the seed reference, an explicit title) are stamped onto the node's
			// spec from the trusted host context, after the workflow script has produced it: a script can
			// name neither. Not a workspace chat: the runner is used as it is.
			const stampedRunner: NodeRunner = workspaceChatHost
				? (spec) => provenanceRunner(stampWorkspaceChatSpec(spec, workspaceChatHost))
				: provenanceRunner;

			// ── The post-fan-out continuation. Both the sync and async modes call
			// this; in async mode it runs AFTER the 202 has shipped (the response is
			// already closed, so this must never touch `response`).
			const fanOutAndFinalize = async (): Promise<RunRecord> => {
				// `provenanceRunner` (vertical) wraps the journaled runner for the
				// incremental wf:AgentRun emit; `onPhase`/`onLog` (base Contract-A) lift
				// the interpreter's phase()/log() shims into the run journal so they
				// project onto the SSE `phase.entered`/`phase.exited`/`log` stream.
				const run = await runWorkflow(
					{
						runNode: stampedRunner,
						...(runGraph ? { graph: runGraph } : {}),
						runId,
						now: () => Date.now(),
						control: new WorkflowProgramControlBackend(ctx.runtime, runId),
						onPhase,
						onLog,
						...(childMediator ? { invoke: childMediator.invoke } : {}),
					},
					entry.compiled,
					inputs,
				);
				if (childMediator) run.childInvocationIds = [...childMediator.invocationIds];
				if (envelope?.target.workflowUri) run.workflowUri = envelope.target.workflowUri;
				if (entry.finalizeRun) {
					if (!runGraph) {
						throw new InvocationFault(
							"workflow_graph_unavailable",
							`workflow '${entry.compiled.meta.name}' has a graph finalizer but does not declare garden.graph`,
							409,
						);
					}
					await entry.finalizeRun(run, {
						graph: runGraph,
						runtime: ctx.runtime,
						graphId,
						ownerUserId,
						actorRef: envelope?.actorRef ?? canonicalActorRef(ownerUserId),
						inputs,
					});
				}
				attachInvocationReceipt(run, envelope, entry, execution);

				// ── Journal: close the run. run_done is appended only AFTER the per-run
				// queue drains, so trailing node events can never land after it.
				try {
					await drain();
					await ctx.journal.appendEvent(runId, {
						type: "run_done",
						payload: {
							status: run.status,
							synthesisDocId: run.synthesisDocId,
							receipt: run.invocationReceipt,
						},
					});
					await ctx.journal.finishRun(runId, {
						status: run.status,
						ended_at: run.endedAt,
						duration_ms: run.durationMs,
						agent_count: run.agentCount,
						total_tokens: run.totalTokens,
						synthesis_doc_id: run.synthesisDocId ?? null,
					});
				} catch (err) {
					console.error(`[workflow] journal finishRun failed for ${runId}: ${String(err)}`);
				}
				try {
					await ctx.runtime.markWorkflowFinished(runId, {
						status: run.status,
						endedAt: run.endedAt,
						frontier: run.status === "paused" ? undefined : { kind: "run-finished", ts: run.endedAt },
					});
				} catch (err) {
					console.error(`[workflow-runtime] finish instance failed for ${runId}: ${String(err)}`);
				}

				// All node runners have returned. Drain their non-blocking incremental
				// projection writes before replacing them with the journal's final truth.
				await Promise.all([...incrementalProvenanceWrites]);

				// ── Provenance is a NON-FATAL projection of the journal. The whole block
				// (ensureWorkflowDef + the fold) is wrapped in an inner try/catch:
				// a gateway SPARQL reject must NOT turn a good run into a 500.
				// ensureWorkflowDef is relocated to AFTER fan-out so a pre-fan-out
				// SPARQL reject can't abort before any agent runs.
				if (graph && hostWritesGraph && emporiumIngestUrl) {
					let emporiumRunIngestOk = false;
					// ── ADDITIVE + FLAG-GATED: file the run via the emporium runs-ingest
					// route INSTEAD of the direct wf: emit. Same NON-FATAL posture — a
					// gateway/cell reject must NOT turn a good run into a 500. The journal
					// stays source of truth: fold it into a RunRecord and feed THAT to the
					// payload-builder (consistent with foldRunToProvenance's design).
					try {
						const { run: folded } = await foldRunToProvenance(ctx.journal, runId, {
							workflowUri: run.workflowUri,
						});
						folded.scriptSha256 = entry.scriptSha256;
						const ingestBody = buildIngestRequest(folded, entry.scriptSha256);
						// Gateway mode reuses the MCP path's service-auth; local mode uses a
						// loopback bearer. The URL shape differs (graphId twice vs once).
						const result = serviceAuth
							? await postEmporiumIngest(emporiumIngestUrl, graphId, ingestBody, {
									mode: "gateway",
									serviceToken: serviceAuth.serviceToken,
									onBehalfOf: serviceAuth.onBehalfOf,
									...(graphOwner ? { ownerPrincipal: graphOwner } : {}),
								})
							: await postEmporiumIngest(emporiumIngestUrl, graphId, ingestBody, {
									mode: "local",
									bearer: process.env.WORKFLOW_EMPORIUM_INGEST_BEARER?.trim(),
								});
						if (!result.ok) {
							run.provenanceError = result.error;
							console.error(`[workflow] emporium ingest failed for ${runId}: ${result.error}`);
						} else {
							emporiumRunIngestOk = true;
						}
					} catch (err) {
						run.provenanceError = err instanceof Error ? err.message : String(err);
						console.error(`[workflow] emporium ingest threw for ${runId}: ${run.provenanceError}`);
					}
					if (!emporiumRunIngestOk) {
						try {
							const { run: folded } = await foldRunToProvenance(ctx.journal, runId, {
								workflowUri: run.workflowUri,
							});
							run.provenanceAssertion = await emitRunProvenance(graph, graphId, folded);
							console.warn(
								`[workflow] emporium ingest unavailable for ${runId}; filed direct wf: provenance fallback`,
							);
						} catch (err) {
							const error = err instanceof Error ? err.message : String(err);
							run.provenanceError = run.provenanceError ? `${run.provenanceError}; fallback: ${error}` : error;
							console.error(`[workflow] direct wf: fallback failed for ${runId}: ${error}`);
						}
					}
				} else if (graph && hostWritesGraph) {
					try {
						const workflowUri =
							envelope?.target.workflowUri ??
							(await ensureWorkflowDef(
								graph,
								graphId,
								entry.compiled.meta.name,
								entry.compiled.meta.description ?? "",
							));
						run.workflowUri = workflowUri;
						// Re-project from the journal (source of truth), not the in-memory run.
						const { run: folded } = await foldRunToProvenance(ctx.journal, runId, { workflowUri });
						run.provenanceAssertion = await emitRunProvenance(graph, graphId, folded);
					} catch (err) {
						run.provenanceError = err instanceof Error ? err.message : String(err);
						console.error(`[workflow] provenance projection failed for ${runId}: ${run.provenanceError}`);
					}
				}
				if (graph && hostWritesGraph) {
					await emitWorkflowAgentArtifactsBestEffort({
						journal: ctx.journal,
						graph,
						graphId,
						runId,
						workflowUri: run.workflowUri,
						emporiumIngestUrl,
						serviceAuth,
						ownerPrincipal: graphOwner,
					});
				}
				return run;
			};
			const terminalizeFailedRun = async (error: unknown): Promise<void> => {
				const endedAt = Date.now();
				const code =
					error instanceof InvocationFault
						? error.code
						: typeof (error as { code?: unknown } | null)?.code === "string"
							? String((error as { code: string }).code)
							: "execution_error";
				const message = error instanceof Error ? error.message : String(error);
				await drain().catch(() => {});
				const sessions = await ctx.runtime.listAgentSessionsForRun(runId, ownerUserId).catch(() => []);
				try {
					await ctx.journal.appendEvent(runId, {
						type: "error",
						ts: endedAt,
						payload: { code, message },
					});
					await ctx.journal.appendEvent(runId, {
						type: "run_done",
						ts: endedAt,
						payload: { status: "failed", error: { code, message } },
					});
					await ctx.journal.finishRun(runId, {
						status: "failed",
						ended_at: endedAt,
						duration_ms: Math.max(0, endedAt - startedAt),
						agent_count: sessions.length,
						total_tokens: 0,
						synthesis_doc_id: null,
					});
				} catch (journalError) {
					console.error(`[workflow] failed to terminalize journal run ${runId}: ${String(journalError)}`);
				}
				try {
					await ctx.runtime.markWorkflowFinished(runId, {
						status: "failed",
						endedAt,
						frontier: { kind: "run-finished", ts: endedAt },
					});
				} catch (runtimeError) {
					console.error(`[workflow] failed to terminalize runtime run ${runId}: ${String(runtimeError)}`);
				}
			};

			// ── ASYNC MODE (default): return 202 {runId, status:'running'} NOW and
			// continue the fan-out off the request path. The graphProxy is a closure
			// var (not tied to `response`), so it outlives the 202 and is closed by
			// the async tail. Clients poll/SSE the run via GET /api/workflows/runs/...
			//
			// SYNC MODE (WORKFLOW_RUN_SYNC=1): the legacy blocking behavior — await
			// the full run and return 200 with the synthesis summary. Kept behind a
			// flag because some callers/tests still expect the inline result; remove
			// once they migrate to the poll/SSE surface.
			const syncMode = pathname === "/api/invocations" ? !prefersAsync : process.env.WORKFLOW_RUN_SYNC === "1";
			if (syncMode) {
				try {
					const run = await fanOutAndFinalize();
					sendJson(response, 200, buildRunResponseBody(run, graphId, entry.compiled.meta.name));
				} catch (error) {
					await terminalizeFailedRun(error);
					logInvocationFailureFrom("sync-run", error, { ...invocationLogFields(), runId });
					throw error;
				} finally {
					await closeWorkflowGraphProxies();
				}
				return;
			}

			// Async: ship the 202 immediately, then run + close the proxy off-path.
			sendJson(response, 202, {
				runId,
				...(envelope ? { invocationId: envelope.invocationId } : {}),
				status: "running",
				graph_id: graphId,
				workflowId: entry.compiled.meta.name,
			});
			let trackedTail!: Promise<void>;
			trackedTail = (async () => {
				try {
					await fanOutAndFinalize();
				} catch (err) {
					await terminalizeFailedRun(err);
					logInvocationFailureFrom("async-run", err, { ...invocationLogFields(), runId });
				} finally {
					await closeWorkflowGraphProxies();
				}
			})()
				.catch((error) => {
					console.error(`[workflow] async run ${runId} tail cleanup failed: ${String(error)}`);
				})
				.finally(() => ctx.workflowTails?.delete(trackedTail));
			ctx.workflowTails?.add(trackedTail);
		} catch (err) {
			if (response.headersSent) {
				logInvocationFailureFrom("start-run", err, invocationLogFields());
			} else {
				failInvocation("start-run", err);
			}
			await closeWorkflowGraphProxies();
		}
		return;
	}

	// GET /api/workflows/runs — run-list (since/limit/status), scoped to owner.
	// Thin wrapper over JournalStore.listRuns. The gateway proxies it as
	// `ChoreographRoute::ListRuns` (`GET /g/{graph}/workflows/runs`: Viewer on the graph,
	// query string forwarded, `x-graph-id` / `x-graph-owner` minted after the ACL check),
	// present in the deployed gateway image (src-r20260923-notebooks-r1).
	if (method === "GET" && pathname === "/api/workflows/runs") {
		span?.updateName("GET /api/workflows/runs");
		const ownerUserId = await requireAuthenticatedOwner(request, response);
		if (!ownerUserId) return;

		// `?view=chat-sessions`: the caller's own chats per graph (Sobremesa). The gateway already
		// proxies this path with its query string, so the view needs no gateway change.
		const view = url.searchParams.get("view");
		if (view !== null) {
			if (view !== CHAT_SESSIONS_VIEW) {
				sendCodedError(response, 400, "invalid_view", `view must be '${CHAT_SESSIONS_VIEW}'`);
				return;
			}
			await handleChatSessionList({
				runtime: ctx.runtime,
				request,
				response,
				url,
				ownerUserId,
				trustedGateway: resolveHostedAuthContext(request.headers)?.method === "internal_service",
			});
			return;
		}

		const sinceRaw = url.searchParams.get("since");
		const limitRaw = url.searchParams.get("limit");
		const statusRaw = url.searchParams.get("status") ?? undefined;
		// Optional graph scope: the gateway drops the `/g/{id}` path prefix but
		// PRESERVES the query, so the FE passes `?graph_id=…` to scope the run list
		// to one graph (absent → owner-global, back-compat).
		const graphRaw = url.searchParams.get("graph_id") ?? undefined;
		const since = sinceRaw ? Number.parseInt(sinceRaw, 10) : undefined;
		const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
		if (sinceRaw && !Number.isFinite(since)) {
			sendJson(response, 400, { error: `Invalid since: ${sinceRaw}` });
			return;
		}
		if (limitRaw && (!Number.isFinite(limit) || (limit ?? 0) <= 0)) {
			sendJson(response, 400, { error: `Invalid limit: ${limitRaw}` });
			return;
		}
		if (statusRaw && !RUN_STATUS_VALUES.has(statusRaw)) {
			sendJson(response, 400, { error: `Invalid status: ${statusRaw}` });
			return;
		}
		try {
			const runs = await listRunsProjected(ctx.journal, ownerUserId, {
				graphId: graphRaw,
				since,
				limit,
				status: statusRaw as import("./workflow/journal-store.js").RunStatus | undefined,
			});
			sendJson(response, 200, { runs, count: runs.length });
		} catch (err) {
			sendJson(response, 500, { error: err instanceof Error ? err.message : String(err) });
		}
		return;
	}

	// NOTE — `GET /api/workflows/runs/:runId/events` and `GET /api/workflows/runs/:runId`
	// are served EARLIER in this chain by the base Contract-A handlers (see above:
	// the `runEventsMatch` SSE+poll-since-seq handler and the `runGetMatch` JSON
	// detail handler). The vertical merge originally re-declared those two routes
	// here via `startRunSseStream` / `readRunProjected`; those route bodies were
	// dead (first-match-wins) AND re-declared `const runEventsMatch` in the same
	// scope (a compile error), so they are dropped. The vertical's resumability
	// (`Last-Event-ID` via `resolveSinceCursor`) is folded into the base events
	// handler above, and `startRunSseStream` / `readRunProjected` remain exported,
	// unit-tested helpers in run-endpoints.ts. Only the net-new run-LIST route
	// (`GET /api/workflows/runs`, no base equivalent) survives as its own handler.

	sendJson(response, 404, { error: "Route not found" });
}

/** Valid run-header statuses for the run-list `?status=` filter. */
const RUN_STATUS_VALUES = new Set(["running", "completed", "failed", "stopped", "paused"]);

function testimonyRunIdFromPayload(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const runId = (value as Record<string, unknown>).testimonyRunId;
	return typeof runId === "string" ? runId : undefined;
}

function evidenceIndexContains(
	event: { type: string; payload: unknown },
	logicalRunId: string,
	uri: string,
	sha256: string,
): boolean {
	if (event.type !== "evidence_index" || !event.payload || typeof event.payload !== "object") return false;
	const payload = event.payload as Record<string, unknown>;
	if (
		payload.schema !== "sophia.hoja.evidence-index.v1" ||
		payload.logicalRunId !== logicalRunId ||
		!Array.isArray(payload.refs)
	) {
		return false;
	}
	return payload.refs.some(
		(ref) =>
			typeof ref === "object" &&
			ref !== null &&
			!Array.isArray(ref) &&
			(ref as Record<string, unknown>).uri === uri &&
			(ref as Record<string, unknown>).sha256 === sha256,
	);
}

/**
 * Read the Agent Session a session-addressed route names, and answer for it when it may not be used: 400 for gateway
 * facts it cannot read (a repeated or unreadable role, a role that names no graph), 404 when there is no such session
 * OR when the request was addressed through a graph the session does not live on (the gateway's exam: a role minted for
 * `home` must never reach a session on `notes`; the answer is the one for a missing session, so it does not say that
 * one exists elsewhere), 403 when the session is someone else's. Returns the session and the minted role, or undefined
 * once it has answered.
 */
async function readAddressedAgentSession(
	request: IncomingMessage,
	response: ServerResponse,
	runtime: WorkflowRuntimeStore,
	sessionId: string,
	ownerUserId: string,
): Promise<
	| {
			readonly session: NonNullable<Awaited<ReturnType<WorkflowRuntimeStore["readAgentSession"]>>>;
			readonly role?: WorkspaceChatRole;
	  }
	| undefined
> {
	let facts: ReturnType<typeof gatewayRequestFacts>;
	try {
		facts = gatewayRequestFacts(request, resolveHostedAuthContext(request.headers));
	} catch (error) {
		if (error instanceof InvocationFault) {
			sendJson(response, error.status, { error: error.message, code: error.code });
			return undefined;
		}
		throw error;
	}
	const session = await runtime.readAgentSession(sessionId);
	if (!session || (facts.address && !sessionIsOnGraph(session, facts.address))) {
		sendJson(response, 404, { error: "Agent session not found" });
		return undefined;
	}
	if (session.owner_user_id !== ownerUserId) {
		sendJson(response, 403, { error: "Forbidden" });
		return undefined;
	}
	return { session, ...(facts.role !== undefined ? { role: facts.role } : {}) };
}

/**
 * The workspace chat's session acts (D4, and exam 1). With rule 2 retired (`CHOREOGRAPH_REQUIRE_GATEWAY_GRAPH_ROLE`),
 * any act on a workspace chat without a minted role is 403 `graph_role_required`, Writer and Reader alike. When the
 * gateway minted the caller as a viewer and this act on this session is not theirs (`workspaceChatViewerRefusal`), 403.
 * Answers and returns true when refused. Before the switch, an act with no minted role is decided by the session's
 * owner check and graph binding alone: the window rule 2 leaves open (see `resolveWorkspaceChatRole`).
 */
function refuseViewerSessionAct(
	response: ServerResponse,
	session: { readonly workflow_name: string; readonly document_json: string },
	act: WorkspaceChatSessionAct,
	role: WorkspaceChatRole | undefined,
): boolean {
	if (role === undefined) {
		if (session.workflow_name !== WORKSPACE_CHAT_WORKFLOW_NAME || !gatewayGraphRoleRequired()) return false;
		const fault = graphRoleRequiredFault();
		sendJson(response, fault.status, { error: fault.message, code: fault.code });
		return true;
	}
	if (role !== "viewer") return false;
	const refusal = workspaceChatViewerRefusal(session, act);
	if (!refusal) return false;
	sendJson(response, refusal.status, { error: refusal.message, code: refusal.code });
	return true;
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
	if (Array.isArray(value)) return value[0];
	return value;
}

/**
 * The synchronous-mode (`WORKFLOW_RUN_SYNC=1`) 200 response body — the legacy
 * inline result. Factored out of the run handler so the sync path and any future
 * caller share one shape. (The async default returns a 202 stub instead.)
 */
function buildRunResponseBody(run: RunRecord, graphId: string, workflowId: string): Record<string, unknown> {
	return {
		runId: run.runId,
		status: run.status,
		graph_id: graphId,
		workflowId,
		summary: run.synthesisMarkdown?.slice(0, 600),
		synthesisDocId: run.synthesisDocId,
		result: run.output ?? (run.synthesisMarkdown !== undefined ? undefined : run.agents.at(-1)?.output),
		receipt: run.invocationReceipt,
		execution: run.execution,
		note: run.note,
		provenanceError: run.provenanceError,
		provenance: {
			runUri: mintRunUri(run.runId),
			workflowUri: run.workflowUri,
			agentCount: run.agentCount,
			totalTokens: run.totalTokens,
			assertion: run.provenanceAssertion ?? { ok: false, failures: ["not attempted"] },
		},
		agents: run.agents.map((a) => ({
			label: a.label,
			state: a.state,
			model: a.model,
			tokens: a.tokens,
			toolCalls: a.toolCalls,
			durationMs: a.durationMs,
		})),
	};
}

/** Attach the same witnessed receipt contract to agentic and model-free runs. */
function attachInvocationReceipt(
	run: RunRecord,
	envelope: InvocationEnvelopeV1 | undefined,
	entry: WorkflowRegistryEntry,
	execution: ReturnType<typeof resolveExecutionBinding>,
): void {
	if (!envelope) return;
	run.invocationReceipt = {
		schema: INVOCATION_RECEIPT_SCHEMA,
		invocationId: envelope.invocationId,
		target: {
			workflowName: entry.compiled.meta.name,
			...(envelope.target.workflowUri ? { workflowUri: envelope.target.workflowUri } : {}),
			definitionDigest: entry.scriptSha256,
		},
		execution,
		status: run.status,
		startedAt: run.startedAt,
		endedAt: run.endedAt,
		durationMs: run.durationMs,
		...(run.output === undefined ? {} : { output: run.output }),
		...(run.status === "failed"
			? { error: { code: "workflow_failed", message: "one or more workflow nodes failed" } }
			: {}),
		childInvocationIds: run.childInvocationIds ?? [],
		effects: (run.effectReceipts ?? []).map((receipt) => ({
			capability: receipt.capability,
			operation: receipt.operation,
			outcome:
				receipt.outcome === "executed" || receipt.outcome === "duplicate"
					? ("ok" as const)
					: receipt.outcome === "handed-off" || receipt.outcome === "pending-approval"
						? ("pending" as const)
						: receipt.outcome === "error"
							? ("error" as const)
							: ("denied" as const),
		})),
		usage: { agentCount: run.agentCount, totalTokens: run.totalTokens },
	};
}

function canonicalActorRef(ownerUserId: string): string {
	return ownerUserId.startsWith("user:") ? ownerUserId : `user:${ownerUserId}`;
}

/**
 * The personal local stack has no delegated HTTP bearer: Vehicle reaches the
 * loopback orchestrator with its host-only internal secret. It may count as
 * owner ingress only behind an explicit host policy and only when the adapter,
 * authenticated user, witnessed actor, and graph owner are the same subject.
 */
export function resolveWorkflowCallerContext(input: {
	authMethod: HostedAuthContext["method"];
	ownerUserId: string;
	triggerAdapter?: string;
	humanDelegation?: string;
	humanDelegationSecret?: string;
	actorRef?: string;
	graphOwnerPrincipal?: string;
	trustInternalVehicleAsOwner?: boolean;
}): DomainAgentCallerContextV1 {
	if (input.authMethod !== "internal_service") return { authMethod: "owner" };
	const ownerPrincipal = canonicalActorRef(input.ownerUserId);
	const exactOwnerTuple = input.actorRef === ownerPrincipal && input.graphOwnerPrincipal === ownerPrincipal;
	// The public gateway terminates the human's Cognito/dev bearer, checks the
	// graph ACL, then necessarily authenticates upstream as an internal service.
	// Its gateway-exclusive delegation secret preserves that already-proven
	// human ingress without fabricating an external source commit or a Vehicle
	// adapter. A token with an adapter or any identity/owner mismatch remains service
	// ingress and must satisfy the ordinary source-commit rules.
	if (
		constantTimeSecretEqual(input.humanDelegation, input.humanDelegationSecret) &&
		!input.triggerAdapter &&
		exactOwnerTuple
	) {
		return { authMethod: "owner" };
	}
	if (input.trustInternalVehicleAsOwner === true && input.triggerAdapter === "vehicle" && exactOwnerTuple) {
		return { authMethod: "owner" };
	}
	return {
		authMethod: "internal-service",
		...(input.triggerAdapter ? { triggerAdapter: input.triggerAdapter } : {}),
	};
}

function constantTimeSecretEqual(presented?: string, expected?: string): boolean {
	if (!presented || !expected) return false;
	const presentedDigest = createHash("sha256").update(presented).digest();
	const expectedDigest = createHash("sha256").update(expected).digest();
	return timingSafeEqual(presentedDigest, expectedDigest);
}

/**
 * Owner-authenticated personal agents may place their grant in the exact graph
 * they own. Internal-service triggers remain constrained to the host's fixed
 * Layer-0 authority list; a graph definition can never nominate another trust
 * root for itself.
 */
export function resolveWorkflowGrantAuthorities(input: {
	caller: DomainAgentCallerContextV1;
	authenticatedActorRef: string;
	homeOwnerPrincipal: string;
	graphId: string;
	configuredAuthorities?: readonly DomainGraphAddressV1[];
}): readonly DomainGraphAddressV1[] {
	const configured = input.configuredAuthorities ?? readTrustedGrantAuthorities(process.env);
	if (input.caller.authMethod !== "owner" || input.authenticatedActorRef !== input.homeOwnerPrincipal) {
		return configured;
	}
	const home = { ownerPrincipal: input.homeOwnerPrincipal, graphId: input.graphId };
	if (
		configured.some(
			(authority) => authority.ownerPrincipal === home.ownerPrincipal && authority.graphId === home.graphId,
		)
	) {
		return configured;
	}
	return [...configured, home];
}

/** Parse the canonical envelope while leaving the legacy workflow body untouched. */
function parseInvocationEnvelope(
	body: {
		schema?: string;
		invocationId?: string;
		target?: { workflowName?: string; workflowUri?: string; definitionDigest?: string };
		input?: unknown;
		actorRef?: string;
		graph?: { ownerPrincipal?: string; graphId?: string };
		cause?: InvocationEnvelopeV1["cause"];
		idempotencyKey?: string;
		deadlineMs?: number;
		budget?: InvocationEnvelopeV1["budget"];
	},
	pathname: string,
	ownerUserId: string,
): InvocationEnvelopeV1 | undefined {
	const canonicalRoute = pathname === "/api/invocations";
	if (!canonicalRoute && body.schema === undefined) return undefined;
	if (body.schema !== INVOCATION_ENVELOPE_SCHEMA) {
		throw new InvocationFault("invalid_envelope", `expected schema '${INVOCATION_ENVELOPE_SCHEMA}'`, 400);
	}
	if (!body.invocationId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.invocationId)) {
		throw new InvocationFault("invalid_envelope", "invocationId is required and has an invalid format", 400);
	}
	if (!body.target?.workflowName?.trim()) {
		throw new InvocationFault("invalid_envelope", "target.workflowName is required", 400);
	}
	if (!body.target.definitionDigest?.trim()) {
		throw new InvocationFault("invalid_envelope", "target.definitionDigest is required", 400);
	}
	const authoritativeActor = canonicalActorRef(ownerUserId);
	if (body.actorRef !== authoritativeActor && body.actorRef !== ownerUserId) {
		throw new InvocationFault("actor_mismatch", "actorRef must match the authenticated principal", 403, {
			authenticatedActorRef: authoritativeActor,
		});
	}
	if (body.graph !== undefined && (!body.graph || typeof body.graph !== "object" || Array.isArray(body.graph))) {
		throw new InvocationFault("invalid_envelope", "graph must be an object", 400);
	}
	if (body.graph && (typeof body.graph.graphId !== "string" || !body.graph.graphId.trim())) {
		throw new InvocationFault("invalid_envelope", "graph.graphId must be a non-empty string", 400);
	}
	if (
		body.graph?.ownerPrincipal !== undefined &&
		(typeof body.graph.ownerPrincipal !== "string" || !body.graph.ownerPrincipal.trim())
	) {
		throw new InvocationFault("invalid_envelope", "graph.ownerPrincipal must be a non-empty string", 400);
	}
	if (body.cause !== undefined) {
		if (!body.cause || typeof body.cause !== "object") {
			throw new InvocationFault("invalid_envelope", "cause must be an object", 400);
		}
		const causeKinds = new Set(["http", "tool", "trigger", "schedule", "replay", "invocation"]);
		if (!causeKinds.has(body.cause.kind)) {
			throw new InvocationFault("invalid_envelope", "cause.kind is unsupported", 400);
		}
		for (const field of ["ref", "parentInvocationId"] as const) {
			const value = body.cause[field];
			if (value !== undefined && (typeof value !== "string" || value.length === 0 || value.length > 512)) {
				throw new InvocationFault("invalid_envelope", `cause.${field} must be a non-empty string`, 400);
			}
		}
	}
	if (
		body.idempotencyKey !== undefined &&
		(typeof body.idempotencyKey !== "string" || body.idempotencyKey.length === 0 || body.idempotencyKey.length > 256)
	) {
		throw new InvocationFault(
			"invalid_envelope",
			"idempotencyKey must be a non-empty string up to 256 characters",
			400,
		);
	}
	if (body.deadlineMs !== undefined && (!Number.isFinite(body.deadlineMs) || body.deadlineMs <= 0)) {
		throw new InvocationFault("invalid_envelope", "deadlineMs must be a positive epoch millisecond value", 400);
	}
	if (body.budget !== undefined && (!body.budget || typeof body.budget !== "object" || Array.isArray(body.budget))) {
		throw new InvocationFault("invalid_envelope", "budget must be an object", 400);
	}
	if (
		body.budget?.maxDurationMs !== undefined &&
		(!Number.isFinite(body.budget.maxDurationMs) || body.budget.maxDurationMs <= 0)
	) {
		throw new InvocationFault("invalid_envelope", "budget.maxDurationMs must be positive", 400);
	}
	for (const [field, value] of [
		["maxChildInvocations", body.budget?.maxChildInvocations],
		["maxTokens", body.budget?.maxTokens],
	] as const) {
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
			throw new InvocationFault("invalid_envelope", `budget.${field} must be a non-negative safe integer`, 400);
		}
	}

	return {
		schema: INVOCATION_ENVELOPE_SCHEMA,
		invocationId: body.invocationId,
		target: {
			workflowName: body.target.workflowName.trim(),
			...(body.target.workflowUri?.trim() ? { workflowUri: body.target.workflowUri.trim() } : {}),
			definitionDigest: body.target.definitionDigest.trim(),
		},
		input: body.input,
		actorRef: authoritativeActor,
		...(body.graph
			? {
					graph: {
						graphId: body.graph.graphId as string,
						...(body.graph.ownerPrincipal ? { ownerPrincipal: body.graph.ownerPrincipal } : {}),
					},
				}
			: {}),
		...(body.cause ? { cause: body.cause } : {}),
		...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
		...(body.deadlineMs === undefined ? {} : { deadlineMs: body.deadlineMs }),
		...(body.budget ? { budget: body.budget } : {}),
	};
}

function invocationTimeoutMs(envelope: InvocationEnvelopeV1 | undefined): number | undefined {
	if (!envelope) return undefined;
	const candidates: number[] = [];
	if (envelope.budget?.maxDurationMs !== undefined) candidates.push(envelope.budget.maxDurationMs);
	if (envelope.deadlineMs !== undefined) candidates.push(envelope.deadlineMs - Date.now());
	if (candidates.length === 0) return undefined;
	const timeoutMs = Math.floor(Math.min(...candidates));
	if (timeoutMs <= 0) {
		throw new InvocationFault("deadline_exceeded", "invocation deadline has already elapsed", 408);
	}
	return timeoutMs;
}

function resolveInvocationDeadlineMs(
	envelope: InvocationEnvelopeV1 | undefined,
	startedAt: number,
): number | undefined {
	if (!envelope) return undefined;
	const candidates: number[] = [];
	if (envelope.deadlineMs !== undefined) candidates.push(envelope.deadlineMs);
	if (envelope.budget?.maxDurationMs !== undefined) candidates.push(startedAt + envelope.budget.maxDurationMs);
	return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

function assertRegisteredDomainPrograms(programs: readonly DomainAgentProgramBindingV1[]): void {
	for (const program of programs) {
		const entry = getWorkflow(program.workflowName);
		if (!entry) {
			throw new InvocationFault(
				"domain_program_unavailable",
				`domain program '${program.programId}' is not registered by this Choreograph release`,
				409,
				{ workflowName: program.workflowName },
			);
		}
		if (entry.scriptSha256 !== program.definitionDigest) {
			throw new InvocationFault(
				"domain_program_stale",
				`domain program '${program.programId}' does not match the registered definition digest`,
				409,
				{ expected: program.definitionDigest, actual: entry.scriptSha256 },
			);
		}
		if (program.workflowUri !== mintWorkflowUri(entry.compiled.meta.name)) {
			throw new InvocationFault(
				"domain_program_identity_stale",
				`domain program '${program.programId}' workflow URI does not match the registered identity`,
				409,
				{ expected: program.workflowUri, actual: mintWorkflowUri(entry.compiled.meta.name) },
			);
		}
		const binding = resolveExecutionBinding(entry.compiled.meta);
		if (binding.controller !== "program" || binding.isolation !== "sandbox") {
			throw new InvocationFault(
				"domain_program_posture_denied",
				`domain program '${program.programId}' is not a sandboxed program controller`,
				409,
			);
		}
		if (canonicalJson(entry.compiled.meta.inputs ?? {}) !== canonicalJson(program.inputSchema)) {
			throw new InvocationFault(
				"domain_program_schema_stale",
				`domain program '${program.programId}' input contract does not match the registered definition`,
				409,
			);
		}
	}
}

export function loopbackChildInvocationDispatch(
	authContext: HostedAuthContext,
	fetchFn: typeof fetch = fetch,
	port: number = PORT,
): ChildInvocationDispatch {
	return async (envelope) => {
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (authContext.method === "internal_service") {
			headers["x-internal-service"] = authContext.internalServiceSecret;
			headers["x-user-id"] = authContext.userId;
		} else {
			headers.authorization = `Bearer ${authContext.bearerToken}`;
		}
		const remainingMs = envelope.deadlineMs === undefined ? 15 * 60_000 : envelope.deadlineMs - Date.now();
		if (remainingMs <= 0) throw new InvocationFault("deadline_exceeded", "child invocation deadline elapsed", 408);
		const response = await fetchFn(`http://127.0.0.1:${port}/api/invocations`, {
			method: "POST",
			headers,
			body: JSON.stringify(envelope),
			signal: AbortSignal.timeout(Math.min(2_147_483_647, Math.max(1, Math.floor(remainingMs)))),
		});
		let body: Record<string, unknown>;
		try {
			const value = await response.json();
			body = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
		} catch {
			throw new InvocationFault("child_transport_invalid", "child invocation returned invalid JSON", 502);
		}
		if (!response.ok) {
			const error =
				body.error && typeof body.error === "object" && !Array.isArray(body.error)
					? (body.error as Record<string, unknown>)
					: undefined;
			throw new InvocationFault(
				typeof error?.code === "string" ? error.code : "child_invocation_failed",
				typeof error?.message === "string" ? error.message : `child invocation returned HTTP ${response.status}`,
				response.status >= 400 && response.status < 600 ? response.status : 502,
			);
		}
		const receipt = body.receipt as InvocationReceiptV1 | undefined;
		return {
			invocationId: envelope.invocationId,
			status: receipt?.status ?? "failed",
			...(body.result === undefined ? {} : { output: body.result }),
			...(receipt ? { receipt } : {}),
		};
	};
}

function resolveWorkflowEntryForRun(
	body: {
		workflow_name?: string;
		workflow_source?: string;
		workflow_binding?: {
			source?: string;
			script?: string;
			name?: string;
			workflowUri?: string;
			scriptSha256?: string;
			script_sha256?: string;
			executor?: "gated" | "dumb";
			execution?: ExecutionBindingInput;
			inputSchema?: unknown;
			outputSchema?: unknown;
		};
	},
	graphId: string,
): WorkflowRegistryEntry {
	const source = workflowSourceFromRunBody(body);
	if (source) {
		const binding = body.workflow_binding;
		const sourceSha256 = createHash("sha256").update(source).digest("hex");
		const expectedSha256 = binding?.scriptSha256 ?? binding?.script_sha256;
		if (expectedSha256 && expectedSha256 !== sourceSha256) {
			throw Object.assign(new Error("workflow_source sha256 does not match supplied scriptSha256"), { status: 400 });
		}
		const registeredName = body.workflow_name ?? binding?.name;
		const registered = registeredName ? getWorkflow(registeredName) : undefined;
		// A graph may mirror a statically reviewed workflow definition. Exact byte
		// identity lets that durable Meaningful Object select the trusted registry
		// entry without turning on arbitrary host-side dynamic source execution.
		if (registered?.scriptSha256 === sourceSha256) {
			return registered;
		}
		const entry = workflowEntryFromSource(
			{
				source,
				expectedName: body.workflow_name ?? binding?.name,
				expectedSha256,
			},
			{
				graphId,
				model: process.env.WORKFLOW_MODEL ?? process.env.OPENROUTER_MODEL ?? "google/gemini-2.5-flash",
			},
		);
		const execution = resolveExecutionBinding(entry.compiled.meta);
		if (
			!dynamicWorkflowSourceEnabled() &&
			!(execution.controller === "program" && execution.isolation === "sandbox")
		) {
			throw Object.assign(
				new Error(
					"dynamic agent/composite workflow source is disabled; set WORKFLOW_DYNAMIC_SOURCE=1 for trusted/local composition",
				),
				{ status: 403 },
			);
		}
		return entry;
	}

	const workflowName = body.workflow_name;
	if (typeof workflowName !== "string" || !workflowName.trim()) {
		throw Object.assign(new Error("workflow_name is required; anonymous legacy workflow selection was removed"), {
			status: 400,
		});
	}
	const entry = getWorkflow(workflowName);
	if (!entry) {
		throw Object.assign(new Error(`unknown workflow: ${body.workflow_name}`), { status: 400 });
	}
	return entry;
}

/**
 * The published Operation schema is part of the executable Meaningful Object,
 * not merely OpenAPI decoration. When Garden supplies it, require structural
 * identity with the digest-pinned source metadata before any sandbox launches.
 */
function assertPublishedWorkflowSchema(
	role: "input" | "output",
	published: unknown,
	source: Record<string, unknown> | undefined,
): void {
	if (published === undefined) return;
	let parsed = published;
	if (typeof published === "string") {
		try {
			parsed = JSON.parse(published);
		} catch {
			throw new InvocationFault("workflow_schema_invalid", `published ${role}Schema is not valid JSON`, 409);
		}
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new InvocationFault("workflow_schema_invalid", `published ${role}Schema must be a JSON Schema object`, 409);
	}
	if (source === undefined || canonicalJson(parsed) !== canonicalJson(source)) {
		throw new InvocationFault(
			"workflow_schema_mismatch",
			`published ${role}Schema does not match the workflow source metadata`,
			409,
			{ role },
		);
	}
}

function workflowSourceFromRunBody(body: {
	workflow_source?: string;
	workflow_binding?: { source?: string; script?: string };
}): string | undefined {
	const raw = body.workflow_source ?? body.workflow_binding?.source ?? body.workflow_binding?.script;
	if (raw === undefined) return undefined;
	if (typeof raw !== "string" || raw.trim() === "") {
		throw Object.assign(new Error("workflow_source must be a non-empty string"), { status: 400 });
	}
	return raw;
}

function dynamicWorkflowSourceEnabled(): boolean {
	return process.env.WORKFLOW_DYNAMIC_SOURCE === "1";
}

async function emitWorkflowAgentArtifactsBestEffort(args: {
	journal: JournalStore;
	graph: GraphWriter;
	graphId: string;
	runId: string;
	workflowUri?: string;
	emporiumIngestUrl?: string;
	serviceAuth: ReturnType<typeof resolveGatewayServiceAuth>;
	ownerPrincipal?: string;
}): Promise<void> {
	const { journal, graph, graphId, runId, workflowUri, emporiumIngestUrl, serviceAuth, ownerPrincipal } = args;
	const opts = workflowUri ? { workflowUri } : undefined;

	try {
		const { sparql } = await foldRunToAgentSubject(journal, runId, opts);
		// In Emporium mode, the SHACL-gated projection sink is the source of truth.
		// The fold still runs here as the local structural tripwire. In direct mode,
		// file the agt: subjects into user:rdf so the run remains inspectable.
		if (!emporiumIngestUrl) {
			await graph.sparqlUpdate(graphId, sparql);
		}
	} catch (err) {
		console.error(
			`[workflow] WS-7 agt: run-fold failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (emporiumIngestUrl) {
		try {
			const { request } = await foldOwnerGraphRunsToAgentSessionProjection(journal, runId, {
				limit: readWorkflowSessionProjectionLimit(),
			});
			const result = serviceAuth
				? await postEmporiumIngest(emporiumIngestUrl, graphId, request, {
						mode: "gateway",
						serviceToken: serviceAuth.serviceToken,
						onBehalfOf: serviceAuth.onBehalfOf,
						...(ownerPrincipal ? { ownerPrincipal } : {}),
					})
				: await postEmporiumIngest(emporiumIngestUrl, graphId, request, {
						mode: "local",
						bearer: process.env.WORKFLOW_EMPORIUM_INGEST_BEARER?.trim(),
					});
			if (!result.ok) {
				console.error(`[workflow] WS-7 session projection ingest failed for ${runId}: ${result.error}`);
			}
		} catch (err) {
			console.error(
				`[workflow] WS-7 session projection threw for ${runId}: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	try {
		const { sparql } = await foldRunToAgentBindings(journal, runId, opts);
		await graph.sparqlUpdate(graphId, sparql);
	} catch (err) {
		console.error(
			`[workflow] WS-7 wf↔agt binding emit failed for ${runId}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}

/**
 * Fire-and-forget a single `wf:AgentRun` row for a just-finished node (the
 * incremental-provenance node-finish hook). NON-FATAL by construction: a slow or
 * rejecting SPARQL write must never stall the fan-out or sink the run, so this
 * never awaits in the caller's path and swallows (logs) every error. The final
 * fold re-INSERTs the identical triples idempotently.
 */
function emitAgentRunProvenanceBestEffort(
	graph: GraphWriter,
	graphId: string,
	runId: string,
	agent: AgentNodeResult,
	pending: Set<Promise<void>>,
): void {
	const sparql = serializeAgentRunProvenance(runId, agent);
	const write = graph.sparqlUpdate(graphId, sparql).catch((err) => {
		console.error(
			`[workflow] incremental wf:AgentRun emit failed for ${runId}/${agent.label}: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	});
	pending.add(write);
	void write.finally(() => pending.delete(write));
}

// ─── Main ───────────────────────────────────────────────────────────────

export function phanesDomainTriggerSubmitter(
	fetchFn: typeof fetch = fetch,
	environment: NodeJS.ProcessEnv = process.env,
	port: number = PORT,
	lifecycle?: {
		gate: PhanesPrivacyEpochGate;
		onAccepted?: (
			request: PhanesDomainTriggerRequest,
			receipt: { runId: string; invocationId: string },
		) => Promise<void>;
	},
): PhanesDomainTriggerSubmitter {
	return {
		async submit(request: PhanesDomainTriggerRequest) {
			const internalSecret = environment.MNEMOSYNE_INTERNAL_SERVICE_SECRET?.trim();
			const onBehalfOf = environment.PHANES_ON_BEHALF_OF?.trim();
			const graphOwner = environment.PHANES_GRAPH_OWNER?.trim();
			const homeGraphId = environment.PHANES_GRAPH_ID?.trim() || "phanes";
			const socialGraphId = environment.PHANES_SOCIAL_GRAPH_ID?.trim() || "phanes-social";
			if (!internalSecret || !onBehalfOf || !graphOwner) {
				throw new Error("Phanes domain trigger authority is not configured");
			}
			assertPhanesTriggerObjectAuthority(request.trigger, graphOwner, socialGraphId);
			const datasetEpoch = request.trigger.datasetEpoch as Readonly<Record<string, unknown>>;
			const epochId = String(datasetEpoch.epochId);
			const execute = async () => {
				const invocationId = `inv-phanes-${request.sourceCommit.eventId}`;
				const response = await fetchFn(`http://127.0.0.1:${port}/api/invocations`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						prefer: "respond-async",
						"x-internal-service": internalSecret,
						"x-user-id": onBehalfOf,
						"x-sophia-trigger-adapter": "discord",
					},
					body: JSON.stringify({
						schema: INVOCATION_ENVELOPE_SCHEMA,
						invocationId,
						target: {
							workflowName: DOMAIN_AGENT_ACTIVITY_LOOP_NAME,
							workflowUri: mintWorkflowUri(DOMAIN_AGENT_ACTIVITY_LOOP_NAME),
							definitionDigest: DOMAIN_AGENT_ACTIVITY_LOOP_SCRIPT_SHA256,
						},
						input: {
							definitionDocumentId:
								environment.PHANES_AGENT_DEFINITION_DOCUMENT_ID?.trim() || "domain-agent-definition",
							sourceCommit: {
								eventId: request.sourceCommit.eventId,
								sourceRef: request.sourceCommit.eventRef,
								digest: request.sourceCommit.digest,
							},
							trigger: {
								...request.trigger,
								sourceEventRef: request.sourceCommit.eventRef,
								sourceEventDigest: request.sourceCommit.digest,
							},
							contextRefs: request.contextRefs,
						},
						actorRef: canonicalActorRef(onBehalfOf),
						graph: { ownerPrincipal: graphOwner, graphId: homeGraphId },
						cause: { kind: "trigger", ref: request.sourceCommit.eventRef },
						idempotencyKey: `phanes:${request.sourceCommit.eventId}`,
					}),
					signal: AbortSignal.timeout(30_000),
				});
				if (response.status !== 202) {
					throw new Error(`local Phanes invocation returned HTTP ${response.status}`);
				}
				const body = (await response.json()) as { runId?: unknown; invocationId?: unknown };
				if (
					typeof body.runId !== "string" ||
					!/^wfr-[A-Za-z0-9-]+$/.test(body.runId) ||
					body.invocationId !== invocationId
				) {
					throw new Error("local Phanes invocation returned an invalid receipt");
				}
				const receipt = { runId: body.runId, invocationId };
				await lifecycle?.onAccepted?.(request, receipt);
				return receipt;
			};
			return lifecycle ? lifecycle.gate.submit(epochId, execute) : execute();
		},
	};
}

function assertPhanesTriggerObjectAuthority(
	trigger: Readonly<Record<string, unknown>>,
	graphOwner: string,
	expectedSocialGraphId: string,
): void {
	if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(expectedSocialGraphId)) {
		throw new Error("Phanes privacy dataset graph id is invalid");
	}
	const datasetEpoch = trigger.datasetEpoch;
	if (!datasetEpoch || typeof datasetEpoch !== "object" || Array.isArray(datasetEpoch)) {
		throw new Error("Phanes trigger is missing its privacy dataset epoch");
	}
	const socialGraphId = (datasetEpoch as Record<string, unknown>).graphId;
	if (
		typeof socialGraphId !== "string" ||
		!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(socialGraphId) ||
		socialGraphId !== expectedSocialGraphId
	) {
		throw new Error("Phanes trigger privacy dataset graph is invalid");
	}
	const objects = trigger.meaningfulObjects;
	if (!objects || typeof objects !== "object" || Array.isArray(objects)) {
		throw new Error("Phanes trigger is missing its Meaningful Object bindings");
	}
	for (const value of Object.values(objects)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("Phanes trigger contains an invalid Meaningful Object binding");
		}
		const ref = value as Record<string, unknown>;
		if (ref.ownerPrincipal !== graphOwner || ref.graphId !== socialGraphId) {
			throw new Error("Phanes trigger Meaningful Object authority differs from its private social epoch");
		}
	}
}

export async function main() {
	console.error("╔══════════════════════════════════════════════════╗");
	console.error("║  Choreograph Bwrap Sandbox Management Spike     ║");
	console.error("╚══════════════════════════════════════════════════╝");
	console.error();

	const sandboxMode = readSandboxMode();

	// 1. Initialize cgroup hierarchy
	console.error(`[init] sandbox mode: ${sandboxMode}`);
	const cgroup =
		sandboxMode === "local-native"
			? { parentPath: "local-native", managerPath: "local-native", controllers: [] }
			: initCgroupHierarchy();

	// 2. Clean up stale cgroups from previous runs
	if (sandboxMode !== "local-native") {
		await cleanupStaleCgroups(cgroup.parentPath);
	}

	// 3. Open SQLite databases
	console.error(`[init] opening sandbox database at ${DB_PATH}`);
	const store = new SandboxStore(DB_PATH);
	console.error(`[init] opening session database at ${SESSION_DB_PATH}`);
	const sessions = new SessionStore(SESSION_DB_PATH);
	await sessions.init();

	// Run journal (workflow source of truth). Like the session store, the async
	// libSQL client needs init() awaited before use.
	console.error(`[init] opening run-journal database at ${JOURNAL_DB_PATH}`);
	const journal = new JournalStore(JOURNAL_DB_PATH);
	await journal.init();

	console.error(`[init] opening workflow runtime database at ${WORKFLOW_RUNTIME_DB_PATH}`);
	const runtime = new WorkflowRuntimeStore(WORKFLOW_RUNTIME_DB_PATH);
	await runtime.init();
	const memoryCasUrl =
		process.env.CHOREOGRAPH_MEMORY_CAS_URL?.trim() || pathToFileURL(`${DATA_DIR}/agent-memory`).toString();
	const memory = new AgentMemory(SophiaContentStore.fromUrl(memoryCasUrl), runtime);
	console.error(`[init] Agent memory CAS at ${memoryCasUrl}`);
	const capture = createCaptureWriterFromEnv();
	if (capture) console.error(`[init] Observatory testimony enabled as ${capture.witness}`);
	const buildEffectWorker = startHostedBuildEffectWorkerFromEnv(runtime, process.env, fetch);
	if (buildEffectWorker) {
		buildEffectWorker.start();
		console.error("[init] Phanes-standard native-build effect edge enabled");
	}
	const platformReleaseEffectWorker = startHostedPlatformReleaseEffectWorkerFromEnv(runtime, process.env, fetch);
	if (platformReleaseEffectWorker) {
		platformReleaseEffectWorker.start();
		console.error("[init] digest-bound cloud-2 platform release effect edge enabled");
	}
	const siteEffectWorker = startHostedSiteEffectWorkerFromEnv(runtime, process.env, fetch, capture);
	if (siteEffectWorker) {
		siteEffectWorker.start();
		console.error("[init] Phanes-standard site effect edge enabled");
	}
	const githubEffectWorker = startHostedGitHubEffectWorkerFromEnv(runtime, process.env, fetch);
	if (githubEffectWorker) {
		githubEffectWorker.start();
		console.error("[init] Phanes-standard GitHub effect edge enabled");
	}
	const scratchEffectWorker = startHostedScratchEffectWorkerFromEnv(runtime, process.env, fetch);
	if (scratchEffectWorker) {
		scratchEffectWorker.start();
		console.error("[init] Phanes-standard scratch-cell effect edge enabled");
	}

	// Billing Phase 0 (OBSERVE) usage ledger — immutable, append-only. Same libSQL
	// + snapshot/restore lifecycle as the journal/sessions; init() awaited before use.
	console.error(`[init] opening billing database at ${BILLING_DB_PATH}`);
	const billing = new BillingStore(BILLING_DB_PATH);
	await billing.init();
	// Sobremesa credits: the gate that records (observe, the default) or also refuses (enforce) at the
	// two doors. The mode is read ONCE here, from BILLING_GATE_MODE; changing it takes a guarded restart.
	const creditGate = new CreditAdmission({ billing, mode: readBillingGateMode() });
	creditGate.startCounterFlush();
	console.error(`[init] credit gate mode: ${creditGate.mode}`);
	// The service fee is a boot-time setting too (BILLING_FEE_BPS, 1500 until the flip sets 2000 together with
	// BILLING_GATE_MODE=enforce). Both lines are what a person reads in the journal to know the flip took.
	const billingFee = readBillingFee();
	console.error(
		`[init] billing fee: ${billingFee.bps} bps (${billingFee.bps / 100}%), ${billingFee.source === "env" ? "from BILLING_FEE_BPS" : "the default"}`,
	);
	for (const warning of billingFee.warnings) console.error(`[init] WARNING ${warning}`);
	// And the day credits start (SSM CREDITS_START_DATE, set at notice time), which the balance view hands the SPA.
	const creditsStart = readCreditsStartDate();
	console.error(`[init] credits start date: ${creditsStart.date ?? "not set"}`);
	for (const warning of creditsStart.warnings) console.error(`[init] WARNING ${warning}`);

	// Personal self-evolution is fail-closed and explicitly enabled by a repository
	// path plus an exact deterministic evaluation contract. No ambient home checkout
	// is inferred, and the feature remains absent from the capability catalog when
	// these values are unset.
	let evolutionStore: AgentEvolutionStore | undefined;
	let extensionBuilder: PrimeExtensionBuilder | undefined;
	let evolution: PersonalEvolutionController | undefined;
	const evolutionRepositoryPath = process.env.AGENT_EVOLUTION_REPOSITORY_PATH?.trim();
	if (evolutionRepositoryPath) {
		if (sandboxMode !== "bwrap") {
			throw new Error("AGENT_EVOLUTION_REPOSITORY_PATH requires the bwrap sandbox boundary");
		}
		const skillName = process.env.AGENT_EVOLUTION_SKILL_NAME?.trim();
		const fixtures = parseEvolutionFixtures(process.env.AGENT_EVOLUTION_FIXTURES_JSON);
		if (!skillName || fixtures.length === 0) {
			throw new Error(
				"AGENT_EVOLUTION_SKILL_NAME and non-empty AGENT_EVOLUTION_FIXTURES_JSON are required when personal evolution is enabled",
			);
		}
		evolutionStore = new AgentEvolutionStore(AGENT_EVOLUTION_DB_PATH);
		await evolutionStore.init();
		const workspaceProvider = new GitWorktreeProvider({
			rootDirectory: `${DATA_DIR}/agent-evolution-workspaces`,
			leaseMs: readPositiveIntegerEnv("AGENT_EVOLUTION_WORKSPACE_LEASE_MS"),
		});
		extensionBuilder = new PrimeExtensionBuilder({
			artifactRoot: `${DATA_DIR}/agent-evolution-artifacts`,
			workspaceProvider,
		});
		evolution = new PersonalEvolutionControllerImpl({
			store: evolutionStore,
			workspaceProvider,
			builder: extensionBuilder,
			evaluator: new ExtensionEvaluationCoordinator(extensionBuilder, { bwrapBin: "bwrap" }),
			repository: {
				repositoryId: process.env.AGENT_EVOLUTION_REPOSITORY_ID?.trim() || "prime-agent",
				repositoryPath: evolutionRepositoryPath,
				baseRevision: process.env.AGENT_EVOLUTION_BASE_REVISION?.trim() || "HEAD",
				allowedPaths: parseCommaSeparatedEnv("AGENT_EVOLUTION_ALLOWED_PATHS", ["extension"]),
				maximumWorkspaceBytes: readPositiveIntegerEnv("AGENT_EVOLUTION_MAX_WORKSPACE_BYTES") ?? 256 * 1024 * 1024,
				extensionRoot: process.env.AGENT_EVOLUTION_EXTENSION_ROOT?.trim() || "extension",
			},
			evaluation: { skillName, fixtures },
			allowedExtensionCapabilities: new Set(parseCommaSeparatedEnv("AGENT_EVOLUTION_ALLOWED_CAPABILITIES", [])),
		});
		console.error(`[init] owner-scoped Agent evolution enabled for ${evolutionRepositoryPath}`);
	}

	// Contract A telemetry emitter — wired to the journal so every appendEvent
	// call fans out to live SSE consumers. Set once; never replaced.
	const telemetry = new RunTelemetryEmitter();
	journal.setTelemetryEmitter(telemetry);

	// Periodic coarse snapshot to S3 (gated on WORKFLOW_JOURNAL_S3_URL; no-op when
	// unset). RPO = point-of-last-snapshot.
	//
	// DURABILITY: DATA_DIR=/var/lib/choreograph (journal.sqlite + sessions.sqlite) is on
	// the instance's ephemeral root volume. Both DBs are snapshotted to S3 — journal to
	// WORKFLOW_JOURNAL_S3_URL, chat sessions to CHAT_DB_S3_URL — periodically and as a
	// final snapshot on graceful shutdown, and both are restored on boot before the
	// service starts (platform-next/terraform/userdata-choreograph.sh). Net: a controlled
	// instance-refresh is zero-loss; RPO ≤ snapshot interval on an uncontrolled crash.
	let periodicSnapshotTimer: ReturnType<typeof setInterval> | undefined;
	const periodicSnapshotTasks = new Set<Promise<void>>();
	if (
		process.env.WORKFLOW_JOURNAL_S3_URL ||
		process.env.WORKFLOW_RUNTIME_S3_URL ||
		process.env.CHAT_DB_S3_URL ||
		process.env.BILLING_DB_S3_URL ||
		process.env.AGENT_EVOLUTION_S3_URL
	) {
		const snapshotMs = Number(process.env.WORKFLOW_JOURNAL_SNAPSHOT_MS ?? 15 * 60_000);
		periodicSnapshotTimer = setInterval(() => {
			if (periodicSnapshotTasks.size > 0) return;
			const snap = (label: string, snapshot: Promise<string | null>): Promise<void> =>
				snapshot.then(
					(key) => {
						if (key) console.error(`[${label}] snapshot → ${key}`);
					},
					(error) => console.error(`[${label}] snapshot failed`, error),
				);
			let tracked!: Promise<void>;
			tracked = Promise.all([
				snap("journal", journal.snapshotToS3()),
				snap("workflow-runtime", runtime.snapshotToS3()),
				snap("chat", sessions.snapshotToS3()),
				snap("billing", billing.snapshotToS3()),
				...(evolutionStore ? [snap("agent-evolution", evolutionStore.snapshotToS3())] : []),
			])
				.then(() => undefined)
				.finally(() => periodicSnapshotTasks.delete(tracked));
			periodicSnapshotTasks.add(tracked);
		}, snapshotMs);
		periodicSnapshotTimer.unref?.();
		console.error(`[init] journal + chat + billing S3 snapshots every ${Math.round(snapshotMs / 60_000)}m`);
	}

	// 4. Create event bus + spawner
	const eventBus = createSandboxEventBus(store);
	const evidenceUrl = process.env.CHOREOGRAPH_EVIDENCE_S3_URL?.trim();
	const evidence = evidenceUrl ? EvidenceStore.fromUrl(evidenceUrl) : undefined;
	if (evidence) console.error(`[init] private evidence store enabled at ${evidenceUrl}`);
	const modelCatalog = new OpenRouterModelCatalog({
		snapshotPath: OPENROUTER_CATALOG_PATH,
		ttlMs: Number(process.env.OPENROUTER_CATALOG_TTL_MS),
		refreshIntervalMs: Number(process.env.OPENROUTER_CATALOG_REFRESH_MS),
		request: {
			apiKey: process.env.OPENROUTER_API_KEY,
			referer: process.env.OPENROUTER_HTTP_REFERER ?? process.env.OPENROUTER_HTTP_REFERER_URL,
			title: process.env.OPENROUTER_TITLE ?? "Choreograph Sandbox Management Spike",
		},
	});
	await modelCatalog.initialize();
	console.error(`[init] OpenRouter catalog snapshot at ${OPENROUTER_CATALOG_PATH}`);
	// Precision (2026-10-01): each voice's providers, read politely in the background and kept on disk.
	const endpointsCatalog = new OpenRouterEndpointsCatalog({ snapshotPath: OPENROUTER_ENDPOINTS_PATH });
	await endpointsCatalog.initialize();
	endpointsCatalog.startBackgroundRefresh(
		async () => {
			const snapshot = await modelCatalog.snapshotRows();
			if (snapshot.bundledOnly) return [];
			return projectChatModelCatalogue({
				snapshot,
				houseDefault: resolveWorkspaceChatInference(),
				markupBps: resolveBillingMarkupBps(process.env),
				denylist: parseChatModelDenylist(process.env),
			}).models.map((model) => model.id);
		},
		durationFromEnv(process.env.CHOREOGRAPH_MODEL_ENDPOINTS_REFRESH_MS, 30 * 60_000),
	);
	console.error(`[init] OpenRouter provider listings at ${OPENROUTER_ENDPOINTS_PATH}`);
	// The voices that fail for everyone are hidden: from their listing, and from the house's refused calls (2026-10-01).
	const chatModelHealth = new ChatModelHealth({ snapshotPath: CHAT_MODEL_HEALTH_PATH });
	await chatModelHealth.initialize();
	const chatVoiceMarket: ChatVoiceMarket = composeChatVoiceMarket({
		endpoints: (modelId) => endpointsCatalog.endpoints(modelId),
		health: chatModelHealth,
	});
	const openRouterKeyStore = configureOpenRouterKeyStore();
	// Funding provenance must be qualified before enabling BYOK inference.
	const openRouterUserInferenceEnabled = process.env.CHOREOGRAPH_OPENROUTER_USER_INFERENCE_ENABLED === "true";
	const spawner = new SandboxSpawner(store, cgroup, {
		workerScript: WORKER_SCRIPT,
		// 60s suits fast cloud models; slower egresses (local inference on the
		// host Mac) need more headroom for long generations. Env-tunable.
		defaultTimeoutMs: Number(process.env.SANDBOX_TIMEOUT_MS) > 0 ? Number(process.env.SANDBOX_TIMEOUT_MS) : 60_000,
		eventBus,
		billing,
		creditGate,
		capture,
		modelCatalog,
		openRouterKeyStore,
		openRouterUserInferenceEnabled,
		chatModelHealth,
		sandboxMode,
		agentMemory: memory,
		workflowRuntime: runtime,
		...(extensionBuilder ? { extensionArtifactResolver: extensionBuilder } : {}),
	});
	await spawner.start();
	console.error("[init] durable agent supervisors reached startup quiescence");

	const workflowTails = new Set<Promise<void>>();
	const ctx: AppContext = {
		chatVoiceMarket,
		sandboxMode,
		openRouterKeyStore,
		openRouterUserInferenceEnabled,
		store,
		sessions,
		spawner,
		eventBus,
		journal,
		runtime,
		memory,
		billing,
		creditGate,
		telemetry,
		capture,
		modelCatalog,
		evidence,
		workflowTails,
		evolution,
	};

	// Chat seeds (Sobremesa): an unclaimed seed is served for an hour and a claimed one for as long
	// as its Session, and reads already enforce both. This pass reclaims the space and deletes what a
	// closed Session left behind, so "deleted with its Session" is true on disk, not only on read.
	const chatSeedReaper = setInterval(() => {
		runtime.reapChatSeeds({ now: Date.now() }).then(
			(reaped) => {
				if (reaped.expired + reaped.releasedClaims + reaped.deletedClaimed > 0) {
					console.error(
						`[chat-seeds] reaped ${reaped.expired} expired, ${reaped.releasedClaims} released claim(s), ` +
							`${reaped.deletedClaimed} orphaned seed(s)`,
					);
				}
			},
			(error) => console.error("[chat-seeds] reap failed", error),
		);
	}, CHAT_SEED_REAP_INTERVAL_MS);
	chatSeedReaper.unref?.();

	// 5. Optional Phanes-only stage API. This is a separate Unix-domain
	// listener with a dedicated token; it never shares the public TCP router.
	let internalJobStore: InternalJobStore | undefined;
	let internalJobRunner: InternalJobRunner | undefined;
	let internalJobServer: InternalJobServer | undefined;
	const internalSocketPath = process.env.PHANES_TRANSCRIBE_SOCKET?.trim();
	if (internalSocketPath) {
		const internalToken = process.env.PHANES_TRANSCRIBE_TOKEN?.trim();
		if (!internalToken) {
			throw new Error("PHANES_TRANSCRIBE_TOKEN is required when PHANES_TRANSCRIBE_SOCKET is configured");
		}
		internalJobStore = new InternalJobStore(
			process.env.PHANES_INTERNAL_JOB_DB ?? `${DATA_DIR}/phanes-internal-jobs.sqlite`,
		);
		const stageRegistry = new InternalStageRegistry();
		stageRegistry.register(
			new TranscriptionStageDriver({
				spoolRoot: process.env.PHANES_SPOOL_ROOT ?? "/var/lib/phanes/jobs",
				runtimeBundleId: process.env.PHANES_ASR_RUNTIME_BUNDLE ?? "asr-runtime",
				maxJobBytes: readPositiveIntegerEnv("PHANES_ASR_MAX_JOB_BYTES"),
				maxSegmentBytes: readPositiveIntegerEnv("PHANES_ASR_MAX_SEGMENT_BYTES"),
				maxSegmentMs: readPositiveIntegerEnv("PHANES_ASR_MAX_SEGMENT_MS"),
				maxAudioMs: readPositiveIntegerEnv("PHANES_ASR_MAX_AUDIO_MS"),
				timeoutMs: readPositiveIntegerEnv("PHANES_ASR_TIMEOUT_MS"),
				memoryMaxBytes: readPositiveIntegerEnv("PHANES_ASR_MEMORY_MAX_BYTES"),
				cpuQuotaUs: readPositiveIntegerEnv("PHANES_ASR_CPU_QUOTA_US"),
				pidsMax: readPositiveIntegerEnv("PHANES_ASR_PIDS_MAX"),
				threads: readPositiveIntegerEnv("PHANES_ASR_THREADS"),
			}),
		);
		internalJobRunner = new InternalJobRunner(
			internalJobStore,
			stageRegistry,
			spawner,
			readPositiveIntegerEnv("PHANES_ASR_CONCURRENCY") ?? 1,
		);
		internalJobRunner.start();
		const phanesPrivacyEpochGate = new PhanesPrivacyEpochGate();
		const phanesHomeGraphId = process.env.PHANES_GRAPH_ID?.trim() || "phanes";
		const phanesOwnerUserId = process.env.PHANES_ON_BEHALF_OF?.trim();
		const phanesGraphOwner = process.env.PHANES_GRAPH_OWNER?.trim();
		if (!phanesOwnerUserId || !phanesGraphOwner) {
			throw new Error("Phanes privacy retirement requires its exact user and graph-owner bindings");
		}
		internalJobServer = await startInternalJobServer({
			socketPath: internalSocketPath,
			token: internalToken,
			runner: internalJobRunner,
			effectStore: runtime,
			effectCapabilities: ["discord", "audio"],
			domainTrigger: phanesDomainTriggerSubmitter(fetch, process.env, PORT, {
				gate: phanesPrivacyEpochGate,
				onAccepted: async (request, receipt) => {
					const datasetEpoch = request.trigger.datasetEpoch as Readonly<Record<string, unknown>>;
					await runtime.bindPhanesPrivacyEpochRun({
						runId: receipt.runId,
						epochId: String(datasetEpoch.epochId),
						datasetGraphId: String(datasetEpoch.graphId),
						sourceEventRef: request.sourceCommit.eventRef,
						datasetEpoch,
						now: Date.now(),
					});
				},
			}),
			privacyRetirement: createPhanesPrivacyRetirementHandler({
				gate: phanesPrivacyEpochGate,
				runtime,
				journal,
				spawner,
				sandboxStore: store,
				scope: {
					homeGraphId: phanesHomeGraphId,
					ownerUserId: phanesOwnerUserId,
					graphOwnerPrincipal: phanesGraphOwner,
					workflowName: DOMAIN_AGENT_ACTIVITY_LOOP_NAME,
				},
			}),
		});
		console.log(`[internal-jobs] Phanes stage API listening on Unix socket ${internalSocketPath}`);
	}

	// 6. Start HTTP server
	const REQUEST_TIMEOUT_MS = 30_000;
	const MAX_CONNECTIONS = 256;
	let publicRequestAdmissionOpen = true;
	const publicRequests = new Set<Promise<void>>();

	const handlePublicRequest = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		// Request timeout — prevents slow clients from holding connections
		response.setTimeout(REQUEST_TIMEOUT_MS, () => {
			if (!response.headersSent) {
				sendJson(response, 408, { error: "Request timeout" });
			}
			response.destroy();
		});

		// CORS headers for local development
		response.setHeader("access-control-allow-origin", "*");
		response.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
		response.setHeader("access-control-allow-headers", "content-type, authorization, x-internal-service, x-user-id");

		if (request.method === "OPTIONS") {
			response.statusCode = 204;
			response.end();
			return;
		}

		try {
			await routeRequest(request, response, ctx);
		} catch (error) {
			if (error instanceof BadRequestError) {
				sendJson(response, 400, { error: error.message });
				return;
			}
			sendJson(response, 500, {
				error: error instanceof Error ? error.message : "Unknown server error",
			});
		}
	};

	const server = createServer((request, response) => {
		// This application-level latch covers requests arriving on an already-open
		// keep-alive connection after server.close(). The check and tracking insert
		// are synchronous, so shutdown observes either a rejected request or one
		// exact in-flight handler that it must drain.
		if (!publicRequestAdmissionOpen) {
			response.setHeader("connection", "close");
			sendJson(response, 503, { error: "Server is shutting down" });
			return;
		}
		let tracked!: Promise<void>;
		tracked = handlePublicRequest(request, response).finally(() => publicRequests.delete(tracked));
		publicRequests.add(tracked);
	});
	const primeTunnelServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
	server.on("upgrade", (request, socket, head) => {
		void upgradePrimeTunnel(request, socket, head, ctx, primeTunnelServer);
	});

	server.maxConnections = MAX_CONNECTIONS;
	server.keepAliveTimeout = 5_000;

	server.listen(PORT, BIND_HOST, () => {
		console.error();
		console.error(`[server] listening on http://${BIND_HOST.includes(":") ? `[${BIND_HOST}]` : BIND_HOST}:${PORT}`);
		console.error();
		console.error("  Endpoints:");
		console.error(`    GET  /health                        — health + queue stats`);
		console.error(`    GET  /api/templates                 — list sandbox templates`);
		console.error(`    GET  /api/filesystems               — list filesystem bundles`);
		console.error(`    GET  /api/models                    — list OpenRouter models + metadata`);
		console.error(`    POST /api/sandboxes                 — enqueue non-agent sandbox (agent ⇒ HTTP 410)`);
		console.error(`    GET  /api/sandboxes                 — list all sandboxes`);
		console.error(`    GET  /api/sandboxes/:id             — get sandbox detail`);
		console.error(`    GET  /api/sandboxes/:id/events      — SSE event stream`);
		console.error(`    POST /api/sandboxes/:id/input       — send code to a runtime sandbox`);
		console.error(`    POST /api/sandboxes/:id/close       — close a runtime sandbox`);
		console.error(`    POST /api/sandboxes/:id/execute     — send code to a kernel sandbox`);
		console.error(`    POST /api/sandboxes/:id/interrupt   — interrupt a kernel sandbox`);
		console.error(`    POST /api/sandboxes/:id/kill        — kill a running sandbox`);
		console.error(`    POST /api/sessions                  — create chat session`);
		console.error(`    GET  /api/sessions                  — list user sessions`);
		console.error(`    GET  /api/sessions/:id              — get session detail`);
		console.error(`    PATCH /api/sessions/:id             — update session`);
		console.error(`    DELETE /api/sessions/:id            — delete session`);
		console.error(`    GET  /api/sessions/:id/messages     — get message history`);
		console.error(`    POST /api/sessions/:id/message      — removed legacy chat execution path (HTTP 410)`);
		console.error(`    POST /api/sessions/:id/abort        — abort active sandbox`);
		console.error(`    POST /api/workflows/run             — run a workflow (async 202; WORKFLOW_RUN_SYNC=1 ⇒ 200)`);
		console.error(`    POST /api/invocations               — invoke a witnessed workflow (programs sync by default)`);
		console.error(`    GET  /api/workflows/runs            — list runs (since/limit/status)`);
		console.error(`    GET  /api/workflows/runs/:id        — run detail (header + events)`);
		console.error(`    GET  /api/workflows/runs/:id/events — per-run SSE (resumable via ?since / Last-Event-ID)`);
		console.error(`    GET  /api/workflows/runs/:id/evidence — authorized private evidence bytes`);
		console.error(`    GET  /api/workflows/runs/:id/agents — Vehicle attach index for workflow agents`);
		console.error(`    GET  /api/workflows/runs/:id/control — run driver, amendments, and beat frontier`);
		console.error(`    POST /api/workflows/runs/:id/driver — claim/release run-level driver lease`);
		console.error(`    POST /api/workflows/runs/:id/amendments — queue driver-authorized beat amendment`);
		console.error(`    POST /api/workflows/runs/:id/pause  — request pause at next safe point`);
		console.error(`    GET  /api/agent-sessions/:id        — Vehicle/ACP collaborative session document`);
		console.error(`    GET  /api/agent-sessions/:id/events — per-agent-session event stream`);
		console.error(`    GET  /api/agent-sessions/:id/document-ops — document operation cursor`);
		console.error(`    POST /api/agent-sessions/:id/driver — claim/release Vehicle driver lease`);
		console.error(`    POST /api/agent-sessions/:id/cancel — durably cancel a Session and descendant family`);
		console.error(`    GET|POST /api/agent-sessions/:id/commands — durable resident input queue`);
		console.error(`    POST /api/agent-sessions/:id/commands/:commandId/cancel — cancel an undelivered command`);
		console.error(`    POST /api/agent-sessions/:id/steer  — append driver-authorized steering`);
		console.error(`    POST /api/agent-sessions/:id/headed-close — close native Prime session`);
		console.error();
	});

	// 7. Graceful shutdown
	let shutdownStarted = false;
	const shutdown = async (signal: string) => {
		if (shutdownStarted) return;
		shutdownStarted = true;
		console.error(`\n[shutdown] received ${signal}, draining...`);
		// F5 shutdown contains independently bounded phases whose legal sum is
		// greater than the historical 10-second watchdog: child control/drain
		// (30s), simple compost (12s), Prime quiesce (10s), physical reap, and
		// final snapshots (8s). Keep the outer crash fuse beyond their conservative
		// aggregate so it cannot preempt durable settlement or projection delivery.
		const forceExitTimer = setTimeout(() => {
			console.error("[shutdown] forced exit after timeout");
			process.exit(1);
		}, 180_000);
		forceExitTimer.unref();
		// Stop accepting public work before the spawner takes its stable admission
		// and host-request drain. Existing connections are reaped after sandboxes.
		publicRequestAdmissionOpen = false;
		if (periodicSnapshotTimer) clearInterval(periodicSnapshotTimer);
		periodicSnapshotTimer = undefined;
		clearInterval(chatSeedReaper);
		const publicServerClosed = new Promise<void>((resolve) => {
			server.close(() => resolve());
		});

		// Latch the internal runner before spawner drain. Its async shutdown call
		// sets `closing` synchronously, so no queued job can be claimed afterward.
		const internalJobDrain = internalJobRunner?.shutdown();
		const listenerAndEffectDrains: Promise<unknown>[] = [];
		if (internalJobServer)
			listenerAndEffectDrains.push(
				internalJobServer.close().catch((error) => {
					console.warn("[shutdown] could not close internal stage listener", error);
				}),
			);
		for (const [label, worker] of [
			["native-build", buildEffectWorker],
			["platform release", platformReleaseEffectWorker],
			["site", siteEffectWorker],
			["GitHub", githubEffectWorker],
			["scratch-cell", scratchEffectWorker],
		] as const) {
			if (worker)
				listenerAndEffectDrains.push(
					worker.close().catch((error) => {
						console.warn(`[shutdown] could not close ${label} effect edge`, error);
					}),
				);
		}

		// Start the spawner drain immediately after every admission latch. Public
		// handlers and internal listeners may themselves be awaiting sandbox
		// terminal outcomes, so waiting for them first would invert the dependency.
		let spawnerShutdownError: unknown;
		try {
			await spawner.shutdownAll();
		} catch (error) {
			spawnerShutdownError = error;
		}
		server.closeAllConnections?.();
		await Promise.allSettled([publicServerClosed, ...publicRequests, ...listenerAndEffectDrains]);
		await ctx.notebooks?.close();
		// Public handlers can add an async 202 tail before returning. Admission is
		// now closed and every handler has settled, so this snapshot is stable.
		await Promise.allSettled([...workflowTails, ...(internalJobDrain ? [internalJobDrain] : [])]);
		while (periodicSnapshotTasks.size > 0) {
			await Promise.allSettled([...periodicSnapshotTasks]);
		}
		if (spawnerShutdownError !== undefined) throw spawnerShutdownError;
		internalJobStore?.close();
		modelCatalog.close();
		await capture?.close(1_000);
		// The gate's pending plain-allow counts must reach billing.sqlite before its final snapshot.
		await creditGate.stop();

		// Final journal + chat snapshots before the DBs are closed — makes a controlled
		// instance-refresh zero-loss (RPO = 0). Each no-ops when its *_S3_URL is unset.
		// Individual failures are nonfatal, but every started snapshot is joined before
		// its backing database closes. The outer 180-second shutdown fuse is the sole
		// process-level bound; losing this Promise race would permit DB-after-close work.
		{
			const snap = (label: string, p: Promise<string | null>) =>
				p.then(
					(key) => {
						if (key) console.error(`[shutdown] final ${label} snapshot → ${key}`);
					},
					(err) => console.warn(`[shutdown] final ${label} snapshot failed (continuing)`, err),
				);
			await Promise.all([
				snap("journal", journal.snapshotToS3()),
				snap("workflow-runtime", runtime.snapshotToS3()),
				snap("chat", sessions.snapshotToS3()),
				snap("billing", billing.snapshotToS3()),
				...(evolutionStore ? [snap("agent-evolution", evolutionStore.snapshotToS3())] : []),
			]);
		}

		// Close databases
		store.close();
		journal.close();
		runtime.close();
		sessions.close();
		billing.close();
		evolutionStore?.close();

		clearTimeout(forceExitTimer);
		console.error("[shutdown] complete");
		process.exit(0);
	};

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}

async function upgradePrimeTunnel(
	request: IncomingMessage,
	socket: Socket,
	head: Buffer,
	ctx: AppContext,
	server: WebSocketServer,
): Promise<void> {
	const url = new URL(request.url ?? "/", "http://choreograph.local");
	const match = /^\/api\/agent-sessions\/([^/]+)\/prime-tunnel$/.exec(url.pathname);
	if (!match) {
		rejectWebSocketUpgrade(socket, 404, "Unknown WebSocket endpoint");
		return;
	}
	try {
		const authContext = resolveHostedAuthContext(request.headers);
		if (!authContext) throw Object.assign(new Error("Authentication required"), { status: 401 });
		const ownerUserId = await resolveSandboxOwnerUserId(authContext);
		const sessionId = decodeURIComponent(match[1] ?? "");
		const { address } = gatewayRequestFacts(request, authContext);
		const session = await ctx.runtime.readAgentSession(sessionId);
		if (!session || (address && !sessionIsOnGraph(session, address))) {
			throw Object.assign(new Error("Agent session not found"), { status: 404 });
		}
		if (session.owner_user_id !== ownerUserId) {
			throw Object.assign(new Error("Agent session belongs to another owner"), { status: 403 });
		}
		if (!session.sandbox_id) {
			throw Object.assign(new Error("Agent session has no active sandbox"), { status: 409 });
		}
		const sandboxId = session.sandbox_id;
		server.handleUpgrade(request, socket, head, (webSocket) => {
			bridgePrimeDaemonTunnel(webSocket, ctx.spawner, sandboxId);
		});
	} catch (error) {
		const status = isRecord(error) && typeof error.status === "number" ? error.status : 500;
		rejectWebSocketUpgrade(socket, status, error instanceof Error ? error.message : String(error));
	}
}

function bridgePrimeDaemonTunnel(webSocket: WebSocket, spawner: SandboxSpawner, sandboxId: string): void {
	let daemonSocket: Socket;
	try {
		daemonSocket = spawner.connectPrimeDaemon(sandboxId);
	} catch (error) {
		webSocket.close(1011, error instanceof Error ? error.message.slice(0, 120) : "Prime daemon unavailable");
		return;
	}
	let bridged = false;
	let clientAttached = false;
	let closing = false;
	const close = (notifyWorker: boolean, reason?: string): void => {
		if (closing) return;
		closing = true;
		daemonSocket.destroy();
		if (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING) {
			webSocket.close(1000, reason?.slice(0, 120));
		}
		if (notifyWorker && bridged && clientAttached) {
			try {
				spawner.closeHeadedAgent(sandboxId);
			} catch {
				// The worker may already have completed through done()/submit().
			}
		}
	};
	daemonSocket.once("connect", () => {
		bridged = true;
	});
	daemonSocket.on("data", (chunk) => {
		if (webSocket.readyState === WebSocket.OPEN) webSocket.send(chunk, { binary: true });
	});
	daemonSocket.once("error", (error) => close(false, error.message));
	daemonSocket.once("close", () => close(false));
	webSocket.on("message", (data) => {
		if (!clientAttached && isPrimeAttachCommandPayload(data)) {
			clientAttached = true;
			try {
				spawner.attachHeadedAgent(sandboxId);
			} catch (error) {
				close(false, error instanceof Error ? error.message : String(error));
				return;
			}
		}
		if (!daemonSocket.destroyed) daemonSocket.write(Buffer.from(data as ArrayBuffer));
	});
	webSocket.once("error", () => close(true));
	webSocket.once("close", () => close(true));
}

export function isPrimeAttachCommandPayload(data: RawData): boolean {
	const text = Buffer.from(data as ArrayBuffer).toString("utf8");
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value = JSON.parse(line) as unknown;
			if (
				isRecord(value) &&
				value.type === "command" &&
				isRecord(value.command) &&
				value.command.type === "attach"
			) {
				return true;
			}
		} catch {
			// A partial or future daemon frame is still forwarded unchanged.
		}
	}
	return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectWebSocketUpgrade(socket: Socket, status: number, message: string): void {
	const label =
		status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "Error";
	const body = `${message}\n`;
	socket.end(
		`HTTP/1.1 ${status} ${label}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
	);
}

if (isExecutedDirectly(import.meta.url)) {
	main().catch((err) => {
		console.error("[fatal]", err);
		process.exit(1);
	});
}

function requiresHostedAuth(
	template: string,
	workerConfig: Record<string, unknown> | undefined,
	mnemosyne: MnemosyneRequestOptions | undefined,
): boolean {
	if (!isAgentWorkerConfig(workerConfig)) {
		return false;
	}

	if (template !== "agent") {
		return false;
	}

	return Boolean(
		mnemosyne?.apiBaseUrl ||
			mnemosyne?.mcpUrl ||
			process.env.MNEMOSYNE_API_BASE_URL?.trim() ||
			process.env.MNEMOSYNE_MCP_URL?.trim(),
	);
}

async function requireAuthenticatedOwner(
	request: IncomingMessage,
	response: ServerResponse,
	/**
	 * `coded`: answer in the `{ error: { code, message } }` envelope the chat doors use
	 * (`unauthenticated` 401, `invalid_credentials` 400), not the flat `{ error }` of the routes
	 * that predate them. Statuses are the same either way.
	 */
	options: { readonly coded?: boolean } = {},
): Promise<string | undefined> {
	try {
		const authContext = resolveHostedAuthContext(request.headers);
		if (!authContext) {
			response.statusCode = 401;
			response.setHeader("www-authenticate", 'Bearer realm="choreograph"');
			const message = "Sandbox access requires Authorization: Bearer <token> or internal-service auth headers";
			if (options.coded) sendCodedError(response, 401, "unauthenticated", message);
			else sendJson(response, 401, { error: message });
			return undefined;
		}
		return await resolveSandboxOwnerUserId(authContext);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const statusCode = /authorization|x-user-id|bearer|internal-service/i.test(errorMessage) ? 400 : 401;
		if (options.coded) {
			sendCodedError(
				response,
				statusCode,
				statusCode === 400 ? "invalid_credentials" : "unauthenticated",
				errorMessage,
			);
		} else {
			sendJson(response, statusCode, { error: errorMessage });
		}
		return undefined;
	}
}

/**
 * Auth gate for Contract A run-telemetry endpoints.
 *
 * Accepts the same methods as `requireAuthenticatedOwner` PLUS a `?token=`
 * query parameter — required because `EventSource` (browser SSE) cannot set
 * `Authorization` headers. The token must be a valid bearer token (same as the
 * `Authorization: Bearer <token>` path). At-least-once: treat the token as the
 * access_token, not the id_token, consistent with the gateway's WS path.
 *
 * Security: the token travels in the URL; TLS is required in production. The
 * query-param path is ONLY honoured when no `Authorization` header is present
 * so header-based callers always win.
 */
async function requireAuthenticatedOwnerOrToken(
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
): Promise<string | undefined> {
	try {
		// Prefer the standard header.
		let authContext = resolveHostedAuthContext(request.headers);

		// Fallback: accept ?token= for EventSource (SSE only path).
		if (!authContext) {
			const tokenParam = url.searchParams.get("token")?.trim();
			if (tokenParam) {
				const bearer = extractBearerToken(`Bearer ${tokenParam}`);
				if (bearer) {
					authContext = { method: "delegated_bearer", bearerToken: bearer };
				}
			}
		}

		if (!authContext) {
			sendJson(response, 401, {
				error: "Authorization required (Authorization: Bearer header or ?token= query param)",
			});
			return undefined;
		}
		return await resolveSandboxOwnerUserId(authContext);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		const statusCode = /authorization|x-user-id|bearer|internal-service/i.test(errorMessage) ? 400 : 401;
		sendJson(response, statusCode, { error: errorMessage });
		return undefined;
	}
}

async function resolveSandboxOwnerUserId(authContext: HostedAuthContext): Promise<string> {
	if (authContext.method === "internal_service") {
		return authContext.userId;
	}

	// Gen-2 (pure Cognito) deploys verify the delegated ID token locally against
	// the user pool JWKS (resolveHostedCallerUserId prefers COGNITO_USER_POOL_ID),
	// so MNEMOSYNE_API_BASE_URL is only needed for the legacy /profile/me fallback.
	// Accept EITHER credential so a Cognito-only deploy needs no bogus API base URL.
	const apiBaseUrl = process.env.MNEMOSYNE_API_BASE_URL?.trim();
	const cognitoUserPoolId = process.env.COGNITO_USER_POOL_ID?.trim();
	if (!cognitoUserPoolId && !apiBaseUrl) {
		throw new Error("COGNITO_USER_POOL_ID or MNEMOSYNE_API_BASE_URL is required to validate delegated bearer auth");
	}

	return resolveHostedCallerUserId({
		apiBaseUrl: apiBaseUrl ?? "",
		authContext,
		requestTimeoutMs: readHostedRequestTimeoutMs(),
	});
}

async function preflightHostedSandboxAccess(
	authContext: HostedAuthContext,
	mnemosyne: MnemosyneRequestOptions | undefined,
): Promise<string> {
	const descriptor = buildDefaultMnemosyneDescriptor(mnemosyne);
	if (descriptor.mcp_url === "disabled" || descriptor.mcp_url === "local-stdio") {
		throw new Error("Hosted sandbox preflight requires MNEMOSYNE_API_BASE_URL or MNEMOSYNE_MCP_URL");
	}

	const apiBaseUrl = mnemosyne?.apiBaseUrl?.trim() || process.env.MNEMOSYNE_API_BASE_URL?.trim();
	if (!apiBaseUrl) {
		throw new Error("MNEMOSYNE_API_BASE_URL is required for hosted sandbox preflight");
	}

	const probe = new HostedMnemosyneProxy({
		apiBaseUrl,
		ownerPrincipal: descriptor.graph_scope.default_graph_owner,
		graphId: descriptor.graph_scope.default_graph_id,
		toolProfile: descriptor.tool_profile,
		runtime: mnemosyne?.runtime ?? process.env.MNEMOSYNE_RUNTIME ?? "choreograph",
		label: mnemosyne?.label ?? "sandbox-auth-preflight",
		requestTimeoutMs: readHostedRequestTimeoutMs(),
		authContext,
		apiToken: process.env.MNEMOSYNE_API_TOKEN,
		allowGlobalTokenFallback: false,
		requiredTools: [],
		capabilities: mnemosyne?.capabilities,
		preferredMcpUrl: mnemosyne?.mcpUrl ?? descriptor.mcp_url,
		source: "choreograph-spike-preflight",
	});

	try {
		const session = await probe.start();
		if (!session.userId) {
			throw new Error("Hosted session preflight did not return user_id");
		}
		return session.userId;
	} finally {
		await probe.close().catch(() => {});
	}
}

function readHostedRequestTimeoutMs(): number {
	const raw = process.env.MNEMOSYNE_REQUEST_TIMEOUT_MS?.trim();
	if (!raw) {
		return 60_000;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) {
		throw new Error("MNEMOSYNE_REQUEST_TIMEOUT_MS must be an integer");
	}
	return parsed;
}

function readWorkflowSessionProjectionLimit(): number {
	const raw = process.env.WORKFLOW_SESSION_PROJECTION_LIMIT?.trim();
	if (!raw) {
		return 1_000;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error("WORKFLOW_SESSION_PROJECTION_LIMIT must be a positive integer");
	}
	return parsed;
}

function readPositiveIntegerEnv(name: string): number | undefined {
	const raw = process.env[name]?.trim();
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return parsed;
}

function parseCommaSeparatedEnv(name: string, fallback: readonly string[]): readonly string[] {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const values = raw
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (values.length === 0 || new Set(values).size !== values.length) {
		throw new Error(`${name} must contain unique non-empty comma-separated values`);
	}
	return values;
}

function parseEvolutionFixtures(raw: string | undefined): readonly {
	readonly caseId: string;
	readonly input: unknown;
	readonly expectedOutput: unknown;
}[] {
	if (!raw?.trim()) return [];
	let value: unknown;
	try {
		value = JSON.parse(raw) as unknown;
	} catch {
		throw new Error("AGENT_EVOLUTION_FIXTURES_JSON must be valid JSON");
	}
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error("AGENT_EVOLUTION_FIXTURES_JSON must be a non-empty array");
	}
	return value.map((item, index) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error(`AGENT_EVOLUTION_FIXTURES_JSON[${index}] must be an object`);
		}
		const fixture = item as Record<string, unknown>;
		if (
			typeof fixture.caseId !== "string" ||
			!fixture.caseId.trim() ||
			!("input" in fixture) ||
			!("expectedOutput" in fixture)
		) {
			throw new Error(`AGENT_EVOLUTION_FIXTURES_JSON[${index}] requires caseId, input, and expectedOutput`);
		}
		return { caseId: fixture.caseId, input: fixture.input, expectedOutput: fixture.expectedOutput };
	});
}

function readSandboxMode(): SandboxMode {
	const raw = process.env.CHOREOGRAPH_SANDBOX_MODE?.trim().toLowerCase();
	if (!raw || raw === "bwrap") {
		return "bwrap";
	}
	if (raw === "local-native" || raw === "native" || raw === "local_native") {
		return "local-native";
	}
	throw new Error(`CHOREOGRAPH_SANDBOX_MODE must be "bwrap" or "local-native" (got ${JSON.stringify(raw)})`);
}

function parseFilesystemIds(value: unknown): string[] | undefined {
	if (value == null) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		throw new BadRequestError("filesystems must be an array of string bundle IDs");
	}

	const ids = value.map((entry) => {
		if (typeof entry !== "string" || entry.trim() === "") {
			throw new BadRequestError("filesystems must only contain non-empty string bundle IDs");
		}
		return entry.trim();
	});

	return ids.length > 0 ? Array.from(new Set(ids)) : undefined;
}

function validateAgentSpawnConfig(template: string, workerConfig: Record<string, unknown> | undefined): void {
	if (!isAgentWorkerConfig(workerConfig)) {
		return;
	}

	if (template !== "agent") {
		throw new BadRequestError("agent workloads require the agent template");
	}
}

function validateRuntimeSpawnConfig(
	template: string,
	filesystems: string[] | undefined,
	workerConfig: Record<string, unknown> | undefined,
): void {
	if (!isRuntimeWorkerConfig(workerConfig)) {
		return;
	}

	if (workerConfig.runtime !== "node" && workerConfig.runtime !== "python") {
		throw new BadRequestError(`Unsupported runtime: ${String(workerConfig.runtime)}`);
	}

	const effectiveFilesystems = resolveTemplateFilesystemIds(template, filesystems);
	if (workerConfig.runtime === "python" && !effectiveFilesystems.includes("python-runtime")) {
		throw new BadRequestError("python runtime requires the python template or the python-runtime filesystem bundle");
	}

	if (workerConfig.cwd != null && typeof workerConfig.cwd !== "string") {
		throw new BadRequestError("runtime cwd must be a string");
	}

	if (workerConfig.bootstrap_code != null && typeof workerConfig.bootstrap_code !== "string") {
		throw new BadRequestError("runtime bootstrap_code must be a string");
	}

	if (workerConfig.env != null && (typeof workerConfig.env !== "object" || Array.isArray(workerConfig.env))) {
		throw new BadRequestError("runtime env must be an object");
	}
}

function validateKernelSpawnConfig(
	_template: string,
	_filesystems: string[] | undefined,
	workerConfig: Record<string, unknown> | undefined,
): void {
	if (!isKernelWorkerConfig(workerConfig)) {
		return;
	}

	try {
		resolveBridge(workerConfig.kernel);
	} catch {
		throw new BadRequestError(`Unsupported kernel: ${String(workerConfig.kernel)}`);
	}

	if (workerConfig.cwd != null && typeof workerConfig.cwd !== "string") {
		throw new BadRequestError("kernel cwd must be a string");
	}

	if (workerConfig.bootstrap_code != null && typeof workerConfig.bootstrap_code !== "string") {
		throw new BadRequestError("kernel bootstrap_code must be a string");
	}

	if (workerConfig.env != null && (typeof workerConfig.env !== "object" || Array.isArray(workerConfig.env))) {
		throw new BadRequestError("kernel env must be an object");
	}
}

function parseRuntimeCode(value: unknown): string {
	if (typeof value !== "string") {
		throw new BadRequestError("runtime input requires a string code field");
	}
	return value;
}

function parseMnemosyneRequestOptions(
	value:
		| {
				api_base_url?: string;
				mcp_url?: string;
				graph_id?: string;
				tool_profile?: "chat" | "familiar" | "full";
				runtime?: string;
				label?: string;
				required_tools?: string[];
				capabilities?: {
					reads?: boolean;
					writes?: boolean;
					dangerous_ops?: boolean;
				};
		  }
		| undefined,
): MnemosyneRequestOptions | undefined {
	if (!value) {
		return undefined;
	}

	return {
		apiBaseUrl: value.api_base_url,
		mcpUrl: value.mcp_url,
		ownerPrincipal: value.graph_owner,
		graphId: value.graph_id,
		toolProfile: value.tool_profile,
		runtime: value.runtime,
		label: value.label,
		requiredTools: value.required_tools,
		capabilities: value.capabilities
			? {
					reads: value.capabilities.reads ?? true,
					writes: value.capabilities.writes ?? true,
					dangerous_ops: value.capabilities.dangerous_ops ?? false,
				}
			: undefined,
	};
}
