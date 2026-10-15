/**
 * Choreograph Workflow Engine ("Loom") — shared types.
 *
 * The engine is built on one primitive — `runAgentNode(spec) -> AgentNodeResult`
 * — composed by deterministic drivers. A chat turn is a degenerate single-node
 * workflow; a workflow is many nodes. See docs/workflow-engine/SPEC.md.
 */

import { Type } from "@earendil-works/pi-ai";
import type {
	ContentAuthorityBindingV1,
	VerifiedExecutionCapsuleV1,
} from "../agent-runtime/content-authority-contract.js";
import type { AgentCheckpointCommitV2 } from "../agent-runtime/memory.js";
import type { AgentOntologyBindingV1 } from "../agent-runtime/ontology-binding.js";
import type { AgentRuntimeBindingV2, AgentRuntimeBundleRefV1, AgentRuntimeKind } from "../agent-runtime/profile.js";
import type { PrimeRuntimeStateV2 } from "../agent-runtime/result-validation.js";
import type { RateCardV1 } from "../billing-rate-card.js";
import type { BrowserEngine } from "../browser-service/types.js";
import type { AgentSeedRefV1 } from "../chat-seed.js";
import type { ExecutionBindingV1, InvocationReceiptV1 } from "./invocation.js";
import type { EffectReceiptV1 } from "./proposed-effect.js";

export type NodeState = "done" | "truncated" | "error";
export type WorkflowTerminalStatus = "completed" | "failed" | "stopped" | "paused";

// ─── Per-node capability declarations ───────────────────────────────────
//
// A capability declaration names a capability the node needs and describes
// the backend binding the orchestrator should instantiate at spawn time.
// The agent names the capability (e.g. "memory", "subject"), never the
// backend; access-level is enforced at the gate.
//
// Supported backends (Slice 3):
//   web(boundOrigin?, storageStateRef?) — subject.web / garden-browser-service
//
// Future backends (leave seams; not built in Slice 3):
//   garden(graphId?, "ro"|"rw")         — subject.garden / memory.garden
//   own()                               — agent's own Garden

/** Backend descriptor for a `subject.web` (Chromium) capability. */
export interface WebCapabilityDescriptor {
	readonly kind: "web";
	/** Browser engine. Defaults to Chromium. */
	readonly engine?: BrowserEngine;
	/** Origin whitelist for navigation clamping (e.g. https://garden.example.invalid). */
	readonly boundOrigin?: string;
	/** Playwright storageState JSON file path — consumed server-side, never echoed. */
	readonly storageStateRef?: string;
	/** Access level. Defaults to "rw". */
	readonly accessLevel?: "ro" | "rw";
}

// Seam for future garden capability (not built in Slice 3).
// export interface GardenCapabilityDescriptor { kind: "garden"; graphId?: string; accessLevel?: "ro" | "rw" }

/** Union of all backend descriptor kinds. */
export type CapabilityDescriptor = WebCapabilityDescriptor; // extend union as backends land

/** Map of capability name → backend descriptor. The agent names the capability. */
export type CapabilityRequest = Record<string, CapabilityDescriptor>;

/** What a single agent node needs to run. */
export interface AgentNodeSpec {
	/**
	 * Stable runtime key for this node inside one workflow run. The runtime layer
	 * uses this for safe resume/replay; callers normally let it be derived from
	 * phase + label.
	 */
	nodeKey?: string;
	/**
	 * Vehicle/ACP-facing collaborative session id for this invocation. Assigned by
	 * the workflow runtime before the node is spawned, then echoed through journal
	 * payloads and results.
	 */
	sessionId?: string;
	/** Host-owned Agent Session family depth; roots are zero. */
	depth?: number;
	/** Fenced sandbox materialization generation; new sessions start at zero. */
	sandboxGeneration?: number;
	/** Host-resolved prior memory for a generation N+1 activation. */
	restoreState?: PrimeRuntimeStateV2;
	/**
	 * Construct/restore the resident body without an initial prompt turn. The
	 * first durable `input.prompt` command becomes this materialization's result.
	 */
	awaitInitialCommand?: true;
	/** Attempt/run-grain id for one execution of a node session. */
	invocationId?: string;
	/** Node label — wf:label, and (slugged) the agentRun URI suffix. */
	label: string;
	/** 1-based phase index — wf:phaseIndex. */
	phaseIndex: number;
	/** The task for the node (becomes the user message). */
	prompt: string;
	/** Optional system prompt; the worker has a sensible default. */
	systemPrompt?: string;
	/**
	 * Explicit I-authority opt-in. This is the unadmitted review/selection input;
	 * runtime control must resolve it through an injected immutable-CAS port before
	 * any durable session, capability, queue, or resource is created.
	 */
	contentAuthority?: ContentAuthorityBindingV1;
	/** Sealed preflight result persisted for restart/replay; never caller-authored. */
	verifiedExecutionCapsule?: VerifiedExecutionCapsuleV1;
	/**
	 * Config-derived agt:Agent identity. Computed at agent() materialization and
	 * forwarded to the spawner before enqueue so L1's subject id matches L0's
	 * observer/membrane id byte-for-byte.
	 */
	agentId?: string;
	/** Per-node attenuation of the host-bound Garden/Mnemosyne capability. */
	graphAccess?: "read" | "write";
	/** Per-node model (an OpenRouter model id — the cheap-model fan-out lever). */
	model: string;
	/** Host-resolved inference provider pinned by the prompt/runtime authority. */
	provider?: string;
	/** Native Prime daemon/TUI lifecycle for an owner-driven interactive session. */
	interactionMode?: "headless" | "headed";
	/** Graph the node operates on. */
	graphId: string;
	/** Mnemosyne tool surface for this node. Default "curated". */
	toolMode?: "dynamic" | "curated" | "none";
	/** Tool names to exclude (dynamic mode only). */
	excludeTools?: string[];
	/** Strict tool allowlist (dynamic mode only). */
	includeTools?: string[];
	/** Fail closed when an included tool is absent at runtime discovery. */
	strictToolManifest?: boolean;
	/** JSON Schema for forced structured output (a TypeBox schema is one). */
	schema?: unknown;
	/** Turn budget for this node. */
	maxTurns?: number;
	/**
	 * Versioned agent runtime selection. It must resolve to a pinned profile
	 * before enqueue; absence is rejected rather than interpreted as simple.
	 */
	runtime?: AgentRuntimeBindingV2;
	/** Host-computed digest of the fully resolved runtime binding. */
	runtimeBindingDigest?: string;
	/**
	 * Pinned Agent/Geist/prompt/skill/harness/tool/runtime Meaningful Objects.
	 * Required for every executable node. Simple and Prime differ in runtime
	 * constraints, never in semantic identity or authority.
	 */
	ontology?: AgentOntologyBindingV1;
	/** Host-computed digest of the validated ontology binding. */
	ontologyBindingDigest?: string;
	/** Optional durable goal seed for Prime's canonical session projection. */
	initialGoal?: { objective: string; tokenBudget?: number };
	/** Optional archetype label — wf:agentType. */
	agentType?: string;
	/** Future WS-7 pooling knob; absence means the default pooled faculty behavior. */
	poolMode?: "pooled" | "differentiated";
	/**
	 * Per-node capability declarations.
	 *
	 * Example: { subject: { kind: "web", boundOrigin: "https://garden.example.invalid" } }
	 *
	 * The orchestrator binds each declared capability at spawn (agent names the
	 * capability, never the backend; access-level is enforced at the gate).
	 * "mnemosyne" is always bound implicitly from the session's hosted proxy.
	 */
	capabilities?: CapabilityRequest;
	/**
	 * Chat facts the HOST derives from the invocation, never a workflow script: an
	 * explicit title for the chat catalogue row. It is consumed when the Session is
	 * created (the catalogue row is written in the same transaction) and is not
	 * persisted in the Session document.
	 */
	chat?: { readonly title?: string };
	/**
	 * HOST-derived: the earlier conversation this chat continues, as a reference (digest, byte count and
	 * window counts), never the bytes. The spawner resolves the digest into the system prompt every time
	 * the Session's body is built. Stamped by the orchestrator from the invocation's host context, never by
	 * a workflow script, and persisted in the Session document as `source.seed`.
	 */
	seed?: AgentSeedRefV1;
	/**
	 * HOST-derived: the rate card the Session is priced by (the model's own price strings, its tiers, the markup, the
	 * catalogue snapshot they came from). Stamped by the orchestrator from the invocation's host context, never by a
	 * workflow script, persisted in the Session document as `source.pricing`, and read by the reservation, the
	 * settlement and the store's re-derivation of every billing event. Absent on a legacy Session, which keeps the
	 * static price table.
	 */
	pricing?: RateCardV1;
	/**
	 * HOST-derived: what the person has open on the first turn, as ids (Vera's D5, 2026-10-06). Run-node renders them
	 * into the model's first message only (`agent-runtime/turn-context.ts`); `prompt` stays the person's words, so the
	 * Session's transcript and title never show the note. Stamped by the orchestrator from the invocation's host
	 * context, never by a workflow script, and not persisted in the Session document.
	 */
	contextRefs?: readonly string[];
}

/** The outcome of one agent node, including provenance-grade telemetry. */
export interface AgentNodeResult {
	nodeKey?: string;
	sessionId?: string;
	invocationId?: string;
	label: string;
	phaseIndex: number;
	state: NodeState;
	/** The node's terminal text output (done summary). */
	output: string;
	/** Validated structured output, when a schema was supplied. */
	structured?: unknown;
	model: string;
	/** Config-derived agt:Agent identity for this completed/reconstructed node. */
	agentId?: string;
	/** Tool names observed for this node in the run journal, when reconstructed. */
	usedTools?: string[];
	turns: number;
	toolCalls: number;
	tokens: number;
	/** Epoch ms — wf:queuedAt. */
	queuedAt: number;
	/** Epoch ms — wf:startedAt. */
	startedAt: number;
	/** wf:durationMs. */
	durationMs: number;
	agentType?: string;
	/** Exact runtime evidence; populated by the profile dispatcher. */
	runtime?: {
		kind: AgentRuntimeKind;
		bindingDigest: string;
		bundle: AgentRuntimeBundleRefV1;
	};
	ontology?: {
		bindingDigest: string;
		agentId: string;
		observerId: string;
	};
	/** Restorable process state emitted by Prime, pending Sophia memory commit. */
	primeState?: unknown;
	/** Sophia-owned durable memory committed from the Prime state. */
	agentCheckpoint?: AgentCheckpointCommitV2;
}

/** Runs one node to completion. Injected into drivers so they are testable. */
export type NodeRunner = (spec: AgentNodeSpec) => Promise<AgentNodeResult>;

/** A complete workflow run — the input to provenance emission. */
export interface RunRecord {
	runId: string;
	workflowName: string;
	/** prov:used target — a urn:sophia:wf workflow subject. */
	workflowUri: string;
	status: WorkflowTerminalStatus;
	startedAt: number;
	endedAt: number;
	durationMs: number;
	agentCount: number;
	totalTokens: number;
	agents: AgentNodeResult[];
	/** The workflow script's JSON-compatible return value. */
	output?: unknown;
	/** Host-edge decisions over the sandbox's typed proposals. */
	effectReceipts?: EffectReceiptV1[];
	/** Exact witnessed child invocations selected during this run. */
	childInvocationIds?: string[];
	/** Canonical execution posture used for this run. */
	execution?: ExecutionBindingV1;
	/** Portable witnessed-invocation receipt when this run entered via that face. */
	invocationReceipt?: InvocationReceiptV1;
	synthesisDocId?: string;
	synthesisMarkdown?: string;
	/**
	 * sha256 (hex) of the compiled workflow SOURCE this run executed. A property
	 * of the workflow DEFINITION, not run telemetry — populated by the caller
	 * that knows the script source (orchestrator, from `compileWorkflow(...).source`).
	 * Threaded into the emporium ingest `parsed.scriptSha256`. Optional: the
	 * direct-provenance path (`serializeRunProvenance`) never reads it.
	 */
	scriptSha256?: string;
	/** Non-fatal note (e.g. best-effort synthesis-doc write failed). */
	note?: string;
	/**
	 * Non-fatal provenance-projection error (gateway SPARQL reject / emporium
	 * ingest failure). Set by the orchestrator's post-fan-out finalize step; never
	 * read by the serializer. Surfaced in the sync-mode response body.
	 */
	provenanceError?: string;
	/**
	 * Result of the final-fold structural self-check (`assertRunSparql`). Set by
	 * the orchestrator's finalize step (direct-emit path only). Surfaced in the
	 * sync-mode response body.
	 */
	provenanceAssertion?: { ok: boolean; failures: string[] };
}

// ─── Demo workflow schemas (graph-survey-synthesize) ─────────────────────

/** Per-document findings returned by a map node. */
export const MapFindingsSchema = Type.Object(
	{
		docId: Type.String({ description: "The document id you surveyed." }),
		relevance: Type.Number({ description: "0..1 — how relevant this document is to the question." }),
		keyPoints: Type.Array(Type.String(), {
			description: "Salient points from this document bearing on the question.",
		}),
		evidence: Type.Array(Type.String(), { description: "Short verbatim quotes/snippets supporting the key points." }),
	},
	{ additionalProperties: false },
);

export interface MapFindings {
	docId: string;
	relevance: number;
	keyPoints: string[];
	evidence: string[];
}

/** The synthesizer's output. */
export const SynthesisSchema = Type.Object(
	{
		title: Type.String({ description: "A concise title for the synthesis." }),
		markdown: Type.String({ description: "The synthesis in Markdown, citing documents by id." }),
	},
	{ additionalProperties: false },
);

export interface Synthesis {
	title: string;
	markdown: string;
}
