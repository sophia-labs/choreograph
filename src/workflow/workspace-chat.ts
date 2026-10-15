/**
 * Built-in workspace chat (`workspace-chat-v1`).
 *
 * Hosted chat used to require a hand-provisioned Domain Agent in every graph
 * (definition, charter, tool manifest, prompt binding and a grant in a trusted
 * authority graph). A graph without one could not chat at all. This module is
 * the host-owned fallback: one headed pilot in the workspace it was invoked in,
 * acting for the calling person with that person's role.
 *
 * Authority, from the outside in:
 * - The gateway checks the caller's role on the graph before the invocation
 *   reaches Choreograph, and every graph call the pilot makes goes back through
 *   the gateway on behalf of that same person; the cell's signed lease refuses
 *   any tool the person's live role does not allow.
 * - There is no per-graph grant. The host binds a built-in mode chosen by the
 *   person's role (`workspace-chat-contract.ts` `resolveWorkspaceChatRole`):
 *   owners and editors get the Writer (`urn:sophia:mode:workspace-writer`: an
 *   exact list of read and write tools, a graph scope of this one workspace and
 *   a host argument policy), viewers the Reader
 *   (`urn:sophia:mode:workspace-reader`: a read ceiling and the read tools).
 *   Both are enforced by the same mode gate (`gateModeCapabilityBackend`) that
 *   governs graph-authored modes, and re-derived (never read from a graph) when
 *   a passivated session wakes, including the Reader of chats begun before the
 *   Writer existed.
 * - A Reader pilot's Mnemosyne session is opened read-only (`graphAccess: "read"`).
 *
 * Model and provider come from host configuration (see
 * `resolveWorkspaceChatInference`), not from the graph.
 */

import {
	type AgentModeFenceV1,
	type AgentModeRefV1,
	type AgentModeV1,
	agentModeDigest,
	agentModeRef,
	graphIdFromScopeIri,
	graphScopeIri,
} from "../agent-runtime/agent-mode.js";
import { createMeaningfulObjectRef } from "../agent-runtime/meaningful-object.js";
import {
	AGENT_ONTOLOGY_BINDING_SCHEMA,
	type AgentOntologyBindingV1,
	validateAgentOntologyBinding,
} from "../agent-runtime/ontology-binding.js";
import {
	AGENT_RUNTIME_BINDING_SCHEMA,
	AGENT_RUNTIME_PLATFORM_CEILINGS,
	type AgentRuntimeBindingV2,
	type AgentRuntimeBundleRefV1,
	type AgentRuntimeConstraintsV2,
	PRIME_AGENT_RUNTIME_BASELINE,
	validateResolvedAgentRuntimeBinding,
} from "../agent-runtime/profile.js";
import { renderableTurnContextRefs } from "../agent-runtime/turn-context.js";
import {
	mintAgentUri,
	mintStandaloneAgentId,
	STANDALONE_AGENT_IDENTITY_ALGORITHM,
} from "../agent-subject/agent-ontology.js";
import { type RateCardV1, resolveBillingMarkupBps } from "../billing-rate-card.js";
import {
	CHAT_TITLE_EXPLICIT_MAX_CHARS,
	type ChatContinuation,
	type ChatWindowCounts,
	normalizeExplicitChatTitle,
} from "../chat-catalogue.js";
import {
	CHAT_PRECISIONS,
	type ChatPrecision,
	DEFAULT_CHAT_PRECISION,
	FULL_PRECISION_QUANTIZATIONS,
	isChatPrecision,
} from "../chat-precision.js";
import {
	type AgentSeedRefV1,
	CHAT_SEED_DIGEST_PATTERN,
	CHAT_SEED_MAX_BYTES,
	CHAT_SEED_UNCLAIMED_TTL_MS,
	ChatSeedFault,
	parseChatSeedContent,
	renderChatSeed,
	resolveChatSeedRenderBudget,
} from "../chat-seed.js";
import { READ_ONLY_MNEMOSYNE_TOOLS } from "../mnemosyne.js";
import type { WorkflowRunInputs } from "./harness.js";
import { InvocationFault } from "./invocation.js";
import type { AgentNodeSpec } from "./types.js";
import {
	WORKSPACE_CHAT_REQUIRED_TOOLS,
	WORKSPACE_READER_TOOLS_V1,
	type WorkspaceChatAccess,
	type WorkspaceChatRole,
	workspaceChatAccessForRole,
	workspaceChatExposedTools,
	workspaceChatSystemPrompt,
	workspaceChatTools,
} from "./workspace-chat-contract.js";

export { workspaceChatSystemPrompt } from "./workspace-chat-contract.js";

export const WORKSPACE_CHAT_WORKFLOW_NAME = "workspace-chat-v1";
export const WORKSPACE_CHAT_HOST_CONTEXT_SCHEMA = "sophia.workspace-chat-host-context.v1" as const;
export const WORKSPACE_READER_MODE_IRI = "urn:sophia:mode:workspace-reader";
export const WORKSPACE_WRITER_MODE_IRI = "urn:sophia:mode:workspace-writer";
export const WORKSPACE_CHAT_REGISTERED_NAME_PREFIX = "sophia-workspace-assistant";
/** Default OpenRouter model when the host sets none (`CHOREOGRAPH_WORKSPACE_CHAT_MODEL`). */
export const DEFAULT_WORKSPACE_CHAT_MODEL = "google/gemini-2.5-flash";
export const WORKSPACE_CHAT_MAX_TEXT_CHARS = 32_000;

/**
 * The Reader's exact tool list (viewers): document reads and history, search and SPARQL SELECT, orientation
 * without side effects, wires, valuations, artifact reads and `surface`. Deliberately absent: `context_bundle`
 * (sets the home location), `music`/`recall` (Geist state), and every write. Each name is also in the host's
 * read-only Mnemosyne set.
 */
export const WORKSPACE_READER_TOOLS: readonly string[] = workspaceChatTools("read");
/** The Writer's exact tool list (owners and editors): the Reader's plus the write families. */
export const WORKSPACE_WRITER_TOOLS: readonly string[] = workspaceChatTools("write");
for (const tool of [...WORKSPACE_READER_TOOLS, ...WORKSPACE_READER_TOOLS_V1]) {
	if (!READ_ONLY_MNEMOSYNE_TOOLS.has(tool)) {
		throw new Error(`workspace reader tool '${tool}' is not in the host read-only Mnemosyne set`);
	}
}

/**
 * A chat session's cost budget in USD micros. Unset, it is the Prime baseline ($1), as hosted has always run. A
 * self-host may raise or lower it with `CHOREOGRAPH_WORKSPACE_CHAT_MAX_COST_USD` (dollars, e.g. `5` or `2.50`), read
 * once at boot. A value that is not a positive amount keeps the baseline with a boot warning; one above the Prime
 * platform ceiling is held to the ceiling, since a binding may never widen it.
 */
export function workspaceChatMaxCostUsdMicros(raw = process.env.CHOREOGRAPH_WORKSPACE_CHAT_MAX_COST_USD): number {
	const baseline = PRIME_AGENT_RUNTIME_BASELINE.maxCostUsdMicros;
	const value = raw?.trim();
	if (!value) return baseline;
	const micros = /^\d+(?:\.\d+)?$/.test(value) ? Math.round(Number(value) * 1_000_000) : 0;
	if (!Number.isSafeInteger(micros) || micros <= 0) {
		console.warn(
			`[workspace-chat] CHOREOGRAPH_WORKSPACE_CHAT_MAX_COST_USD=${JSON.stringify(value)} is not a positive dollar amount; keeping $${baseline / 1_000_000}`,
		);
		return baseline;
	}
	const ceiling = AGENT_RUNTIME_PLATFORM_CEILINGS.prime.maxCostUsdMicros;
	if (micros > ceiling) {
		console.warn(
			`[workspace-chat] CHOREOGRAPH_WORKSPACE_CHAT_MAX_COST_USD=${value} is above the Prime ceiling; holding it to $${ceiling / 1_000_000}`,
		);
		return ceiling;
	}
	return micros;
}

/**
 * The runtime profile: the proven headed Prime baseline with every child
 * capacity removed. The chat cannot spawn children, schedule itself or propose
 * workflows, and it has no persistent kernel (exam 1, finding 8): its prompt says
 * it cannot run code, so the binding says so too, and the host refuses every
 * kernel operation for it (`kernel_not_granted`).
 */
export const WORKSPACE_CHAT_RUNTIME_CONSTRAINTS: AgentRuntimeConstraintsV2 = Object.freeze({
	...PRIME_AGENT_RUNTIME_BASELINE,
	maxCostUsdMicros: workspaceChatMaxCostUsdMicros(),
	maxChildren: 0,
	maxChildDepth: 0,
	maxConcurrentChildren: 0,
	allowPersistentKernel: false,
	allowAutonomousContinuation: false,
	allowSchedules: false,
	allowWorkflowProposals: false,
});

function builtInMode(
	graphId: string,
	iri: string,
	label: string,
	access: "read" | "write",
	tools: readonly string[],
): AgentModeV1 {
	const scope = graphScopeIri(graphId);
	return {
		iri,
		label,
		access,
		allowsTool: [...tools],
		// A graph id the scope grammar cannot carry falls back to the session
		// graph binding alone (the proxy is still bound to that one graph).
		graphScope: graphIdFromScopeIri(scope) === graphId ? [scope] : [],
		requiresApproval: [],
	};
}

/** The built-in Reader mode for one workspace (viewers). The graph scope pins it to that graph. */
export function workspaceReaderMode(graphId: string): AgentModeV1 {
	return builtInMode(graphId, WORKSPACE_READER_MODE_IRI, "Reader", "read", WORKSPACE_READER_TOOLS);
}

/** The Reader as it shipped before the Writer (frozen; only chats begun under it wake under it). */
export function workspaceReaderModeV1(graphId: string): AgentModeV1 {
	return builtInMode(graphId, WORKSPACE_READER_MODE_IRI, "Reader", "read", WORKSPACE_READER_TOOLS_V1);
}

/** The built-in Writer mode for one workspace (owners and editors). */
export function workspaceWriterMode(graphId: string): AgentModeV1 {
	return builtInMode(graphId, WORKSPACE_WRITER_MODE_IRI, "Writer", "write", WORKSPACE_WRITER_TOOLS);
}

function readerFence(mode: AgentModeV1, graphId: string): AgentModeFenceV1 {
	return {
		mode,
		digest: agentModeDigest(mode),
		boundGraphId: graphId,
		trustedReadTools: [...mode.allowsTool],
	};
}

/**
 * The host-gate fence for a built-in Reader session. Its tools are classified
 * read by the host, so a cell that omits `requiredScopes` metadata does not
 * leave the chat without tools; live scopes still win when the cell sends them.
 */
export function workspaceReaderFence(graphId: string): AgentModeFenceV1 {
	return readerFence(workspaceReaderMode(graphId), graphId);
}

/** The fence of the Reader chats begun before this release were bound to. */
export function workspaceReaderFenceV1(graphId: string): AgentModeFenceV1 {
	return readerFence(workspaceReaderModeV1(graphId), graphId);
}

/**
 * The host-gate fence for a built-in Writer session: the exact tool list, this graph only, and the host's
 * `workspace-writer-v1` argument policy (custom_css read face, no wire into another graph, no graph rename).
 */
export function workspaceWriterFence(graphId: string): AgentModeFenceV1 {
	const mode = workspaceWriterMode(graphId);
	return {
		mode,
		digest: agentModeDigest(mode),
		boundGraphId: graphId,
		trustedReadTools: [...WORKSPACE_READER_TOOLS],
		argumentPolicy: "workspace-writer-v1",
	};
}

/**
 * The host's exact grant for a built-in workspace chat: the mode's tools, bounded by the ones the session was handed
 * and its prompt names (`described`, the session's `includeTools`; exam 1, finding 7). A session with no list keeps
 * the mode's tools.
 */
export function workspaceChatGrantTools(
	modeTools: readonly string[],
	described: readonly string[] | undefined,
): string[] {
	if (!described) return [...modeTools];
	const named = new Set(described);
	return modeTools.filter((tool) => named.has(tool));
}

/** The fence for a new chat with this access. */
export function workspaceChatFence(graphId: string, access: WorkspaceChatAccess): AgentModeFenceV1 {
	return access === "write" ? workspaceWriterFence(graphId) : workspaceReaderFence(graphId);
}

/**
 * Re-derive the fence for a durable session whose ontology binding pins a
 * built-in mode. Returns undefined for graph-authored modes (the caller reads
 * those from the agent's graph). A pinned built-in whose digest matches none of
 * the host's definitions of that mode for this graph is refused: the session was
 * bound to a mode this host does not enforce. The Reader has two definitions:
 * today's, and the frozen one of chats begun before the Writer.
 */
export function builtInModeFenceForSession(
	pinned: AgentModeRefV1,
	graphId: string,
): { readonly fence: AgentModeFenceV1 } | { readonly mismatch: true } | undefined {
	const candidates =
		pinned.iri === WORKSPACE_READER_MODE_IRI
			? [workspaceReaderFence(graphId), workspaceReaderFenceV1(graphId)]
			: pinned.iri === WORKSPACE_WRITER_MODE_IRI
				? [workspaceWriterFence(graphId)]
				: undefined;
	if (!candidates) return undefined;
	const fence = candidates.find((candidate) => candidate.digest === pinned.digest);
	return fence ? { fence } : { mismatch: true };
}

export interface WorkspaceChatInferenceV1 {
	readonly provider: "openrouter";
	readonly model: string;
}

/** Host configuration: `CHOREOGRAPH_WORKSPACE_CHAT_MODEL`, else `OPENROUTER_MODEL`, else the default. */
export function resolveWorkspaceChatInference(env: NodeJS.ProcessEnv = process.env): WorkspaceChatInferenceV1 {
	const configured = env.CHOREOGRAPH_WORKSPACE_CHAT_MODEL?.trim() || env.OPENROUTER_MODEL?.trim();
	return { provider: "openrouter", model: configured || DEFAULT_WORKSPACE_CHAT_MODEL };
}

/**
 * What this host tells a client about `workspace-chat-v1`, on its registry entry: the voice a chat gets when none
 * is chosen, the limits a client can check before it sends (so it never learns them by being refused), and the
 * markup charged on the provider's price.
 * Computed at each read from the host's configuration, so it is never a stale copy of an environment variable.
 */
export function workspaceChatHostFacts(env: NodeJS.ProcessEnv = process.env): {
	readonly defaults: { readonly inference: WorkspaceChatInferenceV1 };
	/**
	 * Whether a chat writes, per role (the SPA body's F2): the same rule that binds the mode
	 * (`workspaceChatAccessForRole`). A Session's own `document.source.graphAccess` stays the answer for a chat that exists.
	 */
	readonly access: Readonly<Record<WorkspaceChatRole, WorkspaceChatAccess>>;
	readonly limits: Readonly<Record<string, number>>;
	readonly pricing: { readonly currency: "USD"; readonly markupPercent: number; readonly markupBps: number };
	readonly precision: {
		readonly values: readonly ChatPrecision[];
		readonly default: ChatPrecision;
		readonly fullQuantizations: readonly string[];
	};
} {
	const markupBps = resolveBillingMarkupBps(env);
	return {
		defaults: { inference: resolveWorkspaceChatInference(env) },
		access: {
			owner: workspaceChatAccessForRole("owner"),
			editor: workspaceChatAccessForRole("editor"),
			viewer: workspaceChatAccessForRole("viewer"),
		},
		pricing: { currency: "USD", markupPercent: markupBps / 100, markupBps },
		precision: {
			values: [...CHAT_PRECISIONS],
			default: DEFAULT_CHAT_PRECISION,
			fullQuantizations: [...FULL_PRECISION_QUANTIZATIONS],
		},
		limits: {
			triggerTextMaxChars: WORKSPACE_CHAT_MAX_TEXT_CHARS,
			titleMaxChars: CHAT_TITLE_EXPLICIT_MAX_CHARS,
			seedMaxBytes: CHAT_SEED_MAX_BYTES,
			seedTtlSeconds: CHAT_SEED_UNCLAIMED_TTL_MS / 1000,
			seedRenderMaxChars: resolveChatSeedRenderBudget(env),
		},
	};
}

/**
 * The `seed` input: the earlier conversation a new chat continues, by reference. The browser has already
 * POSTed the window to the seed store and holds its digest; the invocation carries only the digest, the
 * byte count it expects, which archived conversation this continues, and the window's counts.
 */
export interface WorkspaceChatSeedInputV1 {
	readonly seedDigest: string;
	readonly bytes: number;
	readonly continuesConversation: ChatContinuation;
	readonly window: ChatWindowCounts;
	/** The chat's title, when the caller names one ("the old title · continued"); never derived from the seed. */
	readonly title?: string;
}

export interface WorkspaceChatRequestV1 {
	readonly text: string;
	readonly trigger: Readonly<Record<string, unknown>>;
	readonly contextRefs: readonly string[];
	readonly seed?: WorkspaceChatSeedInputV1;
	/** An explicit title; wins over `seed.title`. */
	readonly title?: string;
	/**
	 * The voice the person chose: `{ provider, model }`, unvalidated here beyond its shape. Admission
	 * (`admitWorkspaceChatInference`) checks it against the live catalogue.
	 */
	readonly inference?: { readonly provider: string; readonly model: string; readonly precision?: ChatPrecision };
}

/** Parse the invocation input. Malformed input is a 400, never a 500. */
export function parseWorkspaceChatRequest(body: unknown): WorkspaceChatRequestV1 {
	const envelope = asRecord(body);
	if (!envelope) throw badRequest("request body must be an object");
	const args = asRecord(envelope.workflow_args) ?? asRecord(envelope.input) ?? envelope;
	const trigger = asRecord(args.trigger);
	if (!trigger) throw badRequest("trigger must be an object");
	const text = typeof trigger.text === "string" ? trigger.text.trim() : "";
	if (!text) throw badRequest("trigger.text must be a non-empty string");
	if (text.length > WORKSPACE_CHAT_MAX_TEXT_CHARS) {
		throw badRequest(`trigger.text exceeds ${WORKSPACE_CHAT_MAX_TEXT_CHARS} characters`);
	}
	const interactionMode = args.interactionMode ?? args.interaction_mode;
	if (interactionMode !== undefined && interactionMode !== "headed") {
		throw badRequest("workspace chat supports only interactionMode 'headed'");
	}
	const rawRefs = args.contextRefs ?? args.context_refs ?? [];
	if (!Array.isArray(rawRefs) || rawRefs.length > 100 || rawRefs.some((ref) => typeof ref !== "string" || !ref)) {
		throw badRequest("contextRefs must be an array of at most 100 non-empty strings");
	}
	// An optional input that is absent or null is not provided: `null` is how a client in another language says
	// "no value", and a client that does not know an input must never be refused for leaving it out.
	const seed = args.seed === undefined || args.seed === null ? undefined : parseSeedInput(args.seed);
	const title = parseTitleInput(args.title, "title");
	const inference =
		args.inference === undefined || args.inference === null ? undefined : parseInferenceInput(args.inference);
	return {
		text,
		trigger,
		contextRefs: rawRefs as string[],
		...(seed ? { seed } : {}),
		...(title ? { title } : {}),
		...(inference ? { inference } : {}),
	};
}

/** `{ provider, model }` and nothing else. Whether the provider and model are acceptable is admission's question. */
function parseInferenceInput(value: unknown): { provider: string; model: string; precision?: ChatPrecision } {
	const inference = asRecord(value);
	if (!inference) throw badRequest("inference must be an object");
	const unknown = Object.keys(inference).filter((key) => key !== "provider" && key !== "model" && key !== "precision");
	if (unknown.length > 0) throw badRequest(`inference has unknown fields: ${unknown.sort().join(", ")}`);
	if (typeof inference.provider !== "string" || typeof inference.model !== "string") {
		throw badRequest("inference must be { provider, model }, both text");
	}
	// Precision (2026-10-01): `any` is today's card, `full` the cheapest provider at FP8 or better. Absent means `any`.
	if (inference.precision !== undefined && inference.precision !== null && !isChatPrecision(inference.precision)) {
		throw badRequest("inference.precision must be any or full");
	}
	return {
		provider: inference.provider,
		model: inference.model,
		...(isChatPrecision(inference.precision) ? { precision: inference.precision } : {}),
	};
}

const SEED_INPUT_KEYS = new Set(["seedDigest", "bytes", "continuesConversation", "window", "title"]);
const MAX_CONVERSATION_URN_CHARS = 500;
const MAX_REVISION_ID_CHARS = 200;

/** A malformed seed is the caller's 400: unknown keys are refused, never silently dropped. */
function parseSeedInput(value: unknown): WorkspaceChatSeedInputV1 {
	const seed = asRecord(value);
	if (!seed) throw badRequest("seed must be an object");
	const unknown = Object.keys(seed).filter((key) => !SEED_INPUT_KEYS.has(key));
	if (unknown.length > 0) throw badRequest(`seed has unknown fields: ${unknown.sort().join(", ")}`);
	if (typeof seed.seedDigest !== "string" || !CHAT_SEED_DIGEST_PATTERN.test(seed.seedDigest)) {
		throw badRequest("seed.seedDigest must be a sha256 digest (sha256:<64 lower-case hex>)");
	}
	const bytes = seed.bytes;
	if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > CHAT_SEED_MAX_BYTES) {
		throw badRequest(`seed.bytes must be an integer from 1 to ${CHAT_SEED_MAX_BYTES}`);
	}
	const continues = asRecord(seed.continuesConversation);
	if (
		!continues ||
		Object.keys(continues).some((key) => key !== "archiveConversationUrn" && key !== "revisionId") ||
		typeof continues.archiveConversationUrn !== "string" ||
		continues.archiveConversationUrn === "" ||
		continues.archiveConversationUrn.length > MAX_CONVERSATION_URN_CHARS ||
		typeof continues.revisionId !== "string" ||
		continues.revisionId === "" ||
		continues.revisionId.length > MAX_REVISION_ID_CHARS
	) {
		throw badRequest("seed.continuesConversation must be { archiveConversationUrn, revisionId }, non-empty text");
	}
	const window = asRecord(seed.window);
	if (!window || Object.keys(window).some((key) => key !== "kept" && key !== "omitted" && key !== "total")) {
		throw badRequest("seed.window must be { kept, omitted, total }");
	}
	const { kept, omitted, total } = window;
	for (const count of [kept, omitted, total]) {
		if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
			throw badRequest("seed.window counts must be non-negative integers");
		}
	}
	if ((kept as number) < 1 || (total as number) !== (kept as number) + (omitted as number)) {
		throw badRequest("seed.window must keep at least one message, and total must be kept plus omitted");
	}
	const title = parseTitleInput(seed.title, "seed.title");
	return {
		seedDigest: seed.seedDigest,
		bytes,
		continuesConversation: {
			archiveConversationUrn: continues.archiveConversationUrn,
			revisionId: continues.revisionId,
		},
		window: { kept: kept as number, omitted: omitted as number, total: total as number },
		...(title ? { title } : {}),
	};
}

function parseTitleInput(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw badRequest(`${label} must be text`);
	return normalizeExplicitChatTitle(value);
}

/**
 * Admit a seed at invocation, before any run exists: it must be this person's, unexpired, the size the
 * invocation names, and its document must hold exactly the messages the window says it kept. Returns the
 * reference the Session will carry, with the window as the model will be shown it (the host enforces head
 * and tail whatever the browser sent) and the rendering budget pinned so every activation renders the
 * same window. The seed is held for its Session: admission renews an unclaimed seed's hour and puts it among
 * the newest of the person's unused seeds, so the next upload cannot displace it before the run has begun the
 * Session that claims it. Throws `ChatSeedFault`; a seed that is missing, expired or someone else's is one answer.
 */
export async function admitWorkspaceChatSeed(input: {
	readonly seed: WorkspaceChatSeedInputV1;
	readonly ownerUserId: string;
	readonly runtime: {
		reserveChatSeed(query: {
			ownerUserId: string;
			digest: string;
			now: number;
		}): Promise<{ bytes: number; content: string } | null>;
	};
	readonly now: number;
	readonly renderMaxChars: number;
}): Promise<AgentSeedRefV1> {
	const stored = await input.runtime.reserveChatSeed({
		ownerUserId: input.ownerUserId,
		digest: input.seed.seedDigest,
		now: input.now,
	});
	if (!stored) throw new ChatSeedFault("seed_not_found", "no such seed for this person, or it has expired");
	if (stored.bytes !== input.seed.bytes) {
		throw new ChatSeedFault("seed_bytes_mismatch", "the seed's size is not the size the invocation named");
	}
	const document = parseChatSeedContent(stored.content);
	if (document.messages.length !== input.seed.window.kept) {
		throw new ChatSeedFault("seed_window_mismatch", "the seed does not hold the number of messages its window says");
	}
	const rendering = renderChatSeed({
		document,
		window: input.seed.window,
		renderMaxChars: input.renderMaxChars,
	});
	return {
		digest: input.seed.seedDigest,
		bytes: stored.bytes,
		continuesConversation: input.seed.continuesConversation,
		window: rendering.effective,
		renderMaxChars: input.renderMaxChars,
	};
}

export interface WorkspaceChatHostContextV1 {
	readonly schema: typeof WORKSPACE_CHAT_HOST_CONTEXT_SCHEMA;
	readonly agentId: string;
	readonly graphId: string;
	readonly tools: readonly string[];
	readonly mode: { readonly mode: AgentModeV1; readonly digest: string };
	/** The person's role on the graph when the chat began, as the host resolved it; it chose the mode. */
	readonly role?: WorkspaceChatRole;
	/** The earlier conversation this chat continues, as a reference (never the bytes). Host-derived. */
	readonly seed?: AgentSeedRefV1;
	/**
	 * What the person had open on the first turn, the id-shaped refs only (D5). Stamped onto the pilot's spec, rendered
	 * into the model's first message, never into the run's prompt.
	 */
	readonly contextRefs?: readonly string[];
	/** Chat facts the host supplies for the catalogue row: an explicit title. */
	readonly chat?: { readonly title: string };
	/** The rate card the host admitted the voice on: the price this Session is billed at. Host-derived. */
	readonly pricing?: RateCardV1;
}

/**
 * Stamp the host-derived chat facts onto the Session spec a workflow script produced. The script cannot
 * name a seed, a title or a price: whatever it set is dropped, and only the trusted host context (persisted with
 * the run, never part of the script's `args`) supplies them. A spec that is not a workspace chat's is
 * returned as it is.
 */
export function stampWorkspaceChatSpec(
	spec: AgentNodeSpec,
	host: WorkspaceChatHostContextV1 | undefined,
): AgentNodeSpec {
	if (!host) return spec;
	const {
		seed: _scriptSeed,
		chat: _scriptChat,
		pricing: _scriptPricing,
		contextRefs: _scriptContextRefs,
		...rest
	} = spec;
	return {
		...rest,
		...(host.seed ? { seed: host.seed } : {}),
		...(host.contextRefs?.length ? { contextRefs: [...host.contextRefs] } : {}),
		...(host.chat ? { chat: host.chat } : {}),
		...(host.pricing ? { pricing: host.pricing } : {}),
	};
}

/** What a session route asks of an Agent Session: drive it (the driver lease), make it speak (a turn, a steer, a goal), or stop it. */
export type WorkspaceChatSessionAct = "drive" | "speak" | "stop";

/**
 * Viewer chat (Vera's D4, 2026-10-06), the session routes' half. The gateway admits a person who can only view a graph
 * to the session write routes of their own workspace chats and mints `x-sophia-graph-role: viewer`; the session's owner
 * is checked by each route as before. This says what such a person may do to a session they own:
 * - a session that is not a workspace chat: nothing (`viewer_session_refused`);
 * - a workspace chat bound to the Reader: anything;
 * - a workspace chat begun with edit rights (the Writer, or a document this host cannot read): drive it and stop it,
 *   but not make it speak (`workspace_chat_role_changed`): its tools are an editor's, and the person is now a viewer.
 */
export function workspaceChatViewerRefusal(
	session: { readonly workflow_name: string; readonly document_json: string },
	act: WorkspaceChatSessionAct,
): { readonly status: 403; readonly code: string; readonly message: string } | undefined {
	if (session.workflow_name !== WORKSPACE_CHAT_WORKFLOW_NAME) {
		return {
			status: 403,
			code: "viewer_session_refused",
			message: "someone who can only view this workspace may drive only their own workspace chats",
		};
	}
	if (act !== "speak") return undefined;
	let graphAccess: unknown;
	try {
		graphAccess = (JSON.parse(session.document_json) as { source?: { graphAccess?: unknown } } | null)?.source
			?.graphAccess;
	} catch {
		graphAccess = undefined;
	}
	if (graphAccess === "read") return undefined;
	return {
		status: 403,
		code: "workspace_chat_role_changed",
		message:
			"this chat was begun with edit rights, and you can now only view this workspace: start a new chat to go on",
	};
}

/**
 * Whether the host may write its own bookkeeping for this Session into the graph (exam 1, finding 2): the Session-family
 * projection, like the run's provenance, is written with `sparql_update` as the person, outside every manifest. A
 * workspace chat writes to the graph only if it was begun with edit rights (`source.graphAccess` is `write`); a Reader
 * chat, which may belong to someone who can only view the graph, gets none. Every other Session is unchanged.
 */
export function workspaceChatHostWritesGraph(session: {
	readonly workflow_name: string;
	readonly document_json: string;
}): boolean {
	if (session.workflow_name !== WORKSPACE_CHAT_WORKFLOW_NAME) return true;
	try {
		const source = (JSON.parse(session.document_json) as { source?: { graphAccess?: unknown } } | null)?.source;
		return source?.graphAccess === "write";
	} catch {
		return false;
	}
}

export function readWorkspaceChatHostContext(value: unknown): WorkspaceChatHostContextV1 | undefined {
	const context = asRecord(value);
	if (context?.schema !== WORKSPACE_CHAT_HOST_CONTEXT_SCHEMA) return undefined;
	return context as unknown as WorkspaceChatHostContextV1;
}

/** Stable per-workspace identity, so memory and audit never bleed across graphs. */
export function workspaceChatAgentIdentity(
	ownerPrincipal: string,
	graphId: string,
): {
	readonly registeredName: string;
	readonly agentId: string;
	readonly agentUri: string;
} {
	const registeredName = `${WORKSPACE_CHAT_REGISTERED_NAME_PREFIX}:${ownerPrincipal}/${graphId}`;
	const agentId = mintStandaloneAgentId({ name: registeredName });
	return { registeredName, agentId, agentUri: mintAgentUri(agentId) };
}

export function buildWorkspaceChatInputs(input: {
	readonly graphId: string;
	readonly graphOwnerPrincipal: string;
	readonly request: WorkspaceChatRequestV1;
	readonly runtimeBundle: AgentRuntimeBundleRefV1;
	readonly inference?: WorkspaceChatInferenceV1;
	/** An admitted seed reference (see `admitWorkspaceChatSeed`); recorded in the trusted host context only. */
	readonly seed?: AgentSeedRefV1;
	/** The chat's explicit title, if any. */
	readonly title?: string;
	/** The rate card the voice was admitted on (see `admitWorkspaceChatInference`); recorded in the host context only. */
	readonly pricing?: RateCardV1;
	/**
	 * The person's role on the graph (`resolveWorkspaceChatRole`). Owners and editors get the Writer, viewers the
	 * Reader. Absent means the Reader: a chat never writes on a role nobody resolved.
	 */
	readonly role?: WorkspaceChatRole;
	/**
	 * What the person has open on the first turn, as admitted against the bound graph (`admitTurnContextRefs`): only these
	 * reach the model. Absent means none: a ref nobody checked is never named.
	 */
	readonly admittedContextRefs?: readonly string[];
	/**
	 * The tools the bound graph's cell serves the person (every page of its live tools/list). The session is handed, and
	 * its prompt names, the mode's tools that are live (exam 1, finding 7); absent means the whole manifest.
	 */
	readonly liveTools?: readonly string[];
	readonly now?: number;
}): WorkflowRunInputs {
	const { graphId, graphOwnerPrincipal: ownerPrincipal } = input;
	const now = input.now ?? Date.now();
	const inference = input.inference ?? resolveWorkspaceChatInference();
	const identity = workspaceChatAgentIdentity(ownerPrincipal, graphId);
	const role: WorkspaceChatRole = input.role ?? "viewer";
	const access = workspaceChatAccessForRole(role);
	const fence = workspaceChatFence(graphId, access);
	const manifestName = access === "write" ? "writer" : "reader";
	const exposed = workspaceChatExposedTools(access, input.liveTools);
	const unavailable = WORKSPACE_CHAT_REQUIRED_TOOLS.filter((tool) => !exposed.includes(tool));
	if (unavailable.length > 0) {
		throw new InvocationFault(
			"workspace_chat_tools_unavailable",
			`this workspace does not serve ${unavailable.join(", ")}, which a workspace chat needs`,
			503,
		);
	}
	const systemPrompt = workspaceChatSystemPrompt({ graphId, role, model: inference.model, tools: exposed });
	const ref = <Kind extends Parameters<typeof createMeaningfulObjectRef>[0]["kind"]>(
		kind: Kind,
		objectId: string,
		value: unknown,
	) => createMeaningfulObjectRef({ kind, ownerPrincipal, graphId, objectId, version: "1", value });

	const runtimeProfile = ref(
		"agent-runtime-profile",
		`builtin:${WORKSPACE_CHAT_WORKFLOW_NAME}:runtime-profile`,
		WORKSPACE_CHAT_RUNTIME_CONSTRAINTS,
	);
	const runtime: AgentRuntimeBindingV2 = {
		schema: AGENT_RUNTIME_BINDING_SCHEMA,
		kind: "prime",
		bundle: {
			id: input.runtimeBundle.id,
			digest: input.runtimeBundle.digest.startsWith("sha256:")
				? input.runtimeBundle.digest
				: `sha256:${input.runtimeBundle.digest}`,
		},
		profileRef: runtimeProfile,
		constraints: { ...WORKSPACE_CHAT_RUNTIME_CONSTRAINTS },
	};
	validateResolvedAgentRuntimeBinding(runtime);

	const ontology: AgentOntologyBindingV1 = {
		schema: AGENT_ONTOLOGY_BINDING_SCHEMA,
		subject: {
			agentId: identity.agentId,
			agentUri: identity.agentUri,
			observerId: identity.agentId,
			registeredName: identity.registeredName,
			identityAlgorithm: STANDALONE_AGENT_IDENTITY_ALGORITHM,
		},
		objects: {
			agent: ref("agent", identity.agentUri, {
				registeredName: identity.registeredName,
				agentId: identity.agentId,
				agentUri: identity.agentUri,
			}),
			geist: ref("geist", `builtin:${WORKSPACE_CHAT_WORKFLOW_NAME}:geist`, {
				home: graphId,
				observer: identity.agentId,
			}),
			prompt: ref("prompt", `builtin:${WORKSPACE_CHAT_WORKFLOW_NAME}:prompt`, { systemPrompt }),
			skills: [],
			harness: ref("harness", WORKSPACE_CHAT_WORKFLOW_NAME, { workflow: WORKSPACE_CHAT_WORKFLOW_NAME }),
			toolManifest: ref("tool-manifest", `builtin:${WORKSPACE_CHAT_WORKFLOW_NAME}:${manifestName}-tools`, {
				tools: fence.mode.allowsTool,
			}),
			// Host-issued: there is no graph-resident grant. The built-in mode below is
			// the whole authority, and the gateway ACL and the cell's lease still govern
			// every call against the person's live role.
			toolGrant: ref("tool-grant", `builtin:${WORKSPACE_CHAT_WORKFLOW_NAME}:${manifestName}-grant`, {
				issuer: "choreograph-host",
				mode: agentModeRef(fence.mode),
			}),
			runtimeProfile,
		},
		mode: agentModeRef(fence.mode),
		resolvedAt: now,
	};
	validateAgentOntologyBinding(ontology);

	// What the session is handed and its prompt names: the mode's tools that are live. The mode itself stays whole, so its
	// digest is the one every wake re-derives; the host's grant is bounded by this list (`workspaceChatGrantTools`).
	const tools = [...exposed];
	const contextRefs = renderableTurnContextRefs(input.admittedContextRefs);
	const args = {
		// The person's words only: what they have open travels as the turn's own part (host context, below).
		text: input.request.text,
		pilot: {
			agentId: identity.agentId,
			provider: inference.provider,
			model: inference.model,
			systemPrompt,
			includeTools: tools,
			graphAccess: access,
			maxTurns: runtime.constraints.maxTurns,
			runtime,
			ontology,
		},
	};
	const hostContext: WorkspaceChatHostContextV1 = {
		schema: WORKSPACE_CHAT_HOST_CONTEXT_SCHEMA,
		agentId: identity.agentId,
		graphId,
		tools,
		mode: { mode: fence.mode, digest: fence.digest },
		role,
		...(input.seed ? { seed: input.seed } : {}),
		...(contextRefs.length > 0 ? { contextRefs } : {}),
		...(input.title ? { chat: { title: input.title } } : {}),
		...(input.pricing ? { pricing: input.pricing } : {}),
	};
	return {
		config: {
			graphId,
			provider: inference.provider,
			model: inference.model,
			agentId: identity.agentId,
			toolMode: "dynamic",
			includeTools: tools,
			// The live cell may not expose every reader tool; missing ones are simply
			// absent rather than failing the conversation.
			strictToolManifest: false,
			systemPrompt,
			runtime,
			ontology,
		},
		args,
		schemaInput: {
			trigger: input.request.trigger,
			contextRefs: [...input.request.contextRefs],
			interactionMode: "headed",
		},
		hostContext,
	};
}

export const WORKSPACE_CHAT_SCRIPT = `export const meta = {
	name: "${WORKSPACE_CHAT_WORKFLOW_NAME}",
	description: "Built-in workspace chat: one headed pilot that acts in the graph it was invoked in, with the caller's role: it reads and searches for viewers, and also writes for owners and editors.",
	whenToUse: "Use for hosted chat in a graph that has no Domain Agent definition.",
	phases: [
		{ title: "respond", detail: "A headed pilot answers the person in this workspace, and changes it when they may and ask it to." },
	],
	executor: "gated",
	execution: {
		schema: "choreograph.execution-binding.v1",
		controller: "composite",
		modelUse: "agentic",
		isolation: "sandbox",
		effects: "capability-bound",
		reproducibility: "nondeterministic",
		capabilities: ["garden.graph", "choreograph.agent"],
		authority: { minimumRole: "viewer", dangerousOps: false },
		mayInvokeChildren: false,
	},
	inputs: {
		type: "object",
		additionalProperties: false,
		required: ["trigger"],
		properties: {
			trigger: {
				type: "object",
				required: ["kind", "text"],
				properties: { kind: { type: "string" }, text: { type: "string", minLength: 1 } },
			},
			contextRefs: { type: "array", maxItems: 100, items: { type: "string" } },
			interactionMode: { enum: ["headed"] },
			title: { type: "string", maxLength: 200 },
			inference: {
				type: "object",
				additionalProperties: false,
				required: ["provider", "model"],
				properties: {
					provider: { enum: ["openrouter"] },
					model: { type: "string", minLength: 1, maxLength: 200 },
					precision: { enum: ["any", "full"] },
				},
			},
			seed: {
				type: "object",
				additionalProperties: false,
				required: ["seedDigest", "bytes", "continuesConversation", "window"],
				properties: {
					seedDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
					bytes: { type: "integer", minimum: 1, maximum: ${CHAT_SEED_MAX_BYTES} },
					continuesConversation: {
						type: "object",
						additionalProperties: false,
						required: ["archiveConversationUrn", "revisionId"],
						properties: {
							archiveConversationUrn: { type: "string", minLength: 1 },
							revisionId: { type: "string", minLength: 1 },
						},
					},
					window: {
						type: "object",
						additionalProperties: false,
						required: ["kept", "omitted", "total"],
						properties: {
							kept: { type: "integer", minimum: 1 },
							omitted: { type: "integer", minimum: 0 },
							total: { type: "integer", minimum: 1 },
						},
					},
					title: { type: "string", maxLength: 200 },
				},
			},
		},
	},
	outputs: {
		type: "object",
		additionalProperties: false,
		required: ["response"],
		properties: { response: {} },
	},
}

phase("respond")
const headed = await agent(String(args.text), {
	label: "pilot-headed",
	agentId: args.pilot.agentId,
	model: args.pilot.model,
	provider: args.pilot.provider,
	interactionMode: "headed",
	systemPrompt: args.pilot.systemPrompt,
	toolMode: "dynamic",
	graphAccess: args.pilot.graphAccess === "write" ? "write" : "read",
	includeTools: args.pilot.includeTools,
	strictToolManifest: false,
	maxTurns: args.pilot.maxTurns,
	runtime: args.pilot.runtime,
	ontology: args.pilot.ontology,
	agentType: "workspace-chat-pilot",
})
return { response: headed.output }
`;

function badRequest(message: string): InvocationFault {
	return new InvocationFault("workspace_chat_input_invalid", message, 400);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
