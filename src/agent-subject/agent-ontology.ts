/**
 * Agent ontology v1 (`agt:`) — the minimal agent-as-subject vocabulary, projected
 * by a SUBSTRATE-BLIND fold of a frozen session.
 *
 * CA-1 / S5. A sibling of `foldRunToProvenance` (../workflow/projection.ts ~:31),
 * but reading the FROZEN {@link FrozenSnapshot} produced by S1's
 * {@link IntentLog.freeze} (../agent-subject/intent-log.ts ~:103) — never a live
 * store handle and never a CRDT. The fold re-frames the already-persisted intent
 * journal as five RDF classes describing the agent as a *subject*:
 *
 *   agt:Agent       — a stable registered identity carried by an Agent Meaningful Object
 *   agt:Session     — one conversational session owned by an agent + a user
 *   agt:Turn        — one journal entry as METADATA + tool-usage POINTERS only
 *   agt:Capability  — a coarse access posture (read | write) the agent holds
 *   agt:Tool        — a tool the agent used or DECLARED (demand-signal)
 *
 * THE ANATOMY IS DELIBERATELY THIN. A `agt:Turn` carries its ordinal, role,
 * timestamp, and POINTERS (`agt:usedTool`, `agt:recallRef`, `agt:songRef`) — it
 * NEVER carries the free-text message body. Memory/Song are referenced by
 * POINTER only; this module imports NO gen-2 Perception/Memory/Judgment schema.
 *
 * "Agents judge, code serializes": {@link serializeAgentSubject} is pure (no I/O)
 * and emits EXACTLY these five classes' predicates. {@link assertAgentSparql} is
 * an in-process substring/structural self-check — a clone of `assertRunSparql`
 * (../workflow/provenance.ts ~:117), NOT a SHACL engine. A real RDF/SHACL
 * validator is a Vera-gated dependency / the S9 real-infra gate; shipping one
 * here would be the premature apparatus the verification forbids.
 *
 * PUBLICATION: Garden serves `sophia-agent-core` and the compatible
 * `wf-agent-session-projection` write pack. Hosted workflow runs publish the
 * cumulative journal fold through Emporium's SHACL gate into reserved
 * `:projection:session`; direct/local mode may retain this serializer as an
 * inspectable `user:rdf` compatibility face. No sandbox writes a reserved
 * projection graph directly.
 *
 * Namespace `agt:` = http://mnemosyne.dev/agent# .
 */

import { createHash } from "node:crypto";
// Grounding type import: the REAL Pi message shape this fold reads (from a
// frozen SessionStore row). We import the type so the role/usage handling stays
// honest against Pi's contract; we never serialize its internal fields
// (errorMessage / responseId / provider / api / diagnostics) into a triple.
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { SessionRecord, SessionStore } from "../session-store.js";
import type { FrozenEntry, FrozenSnapshot, IntentLog } from "./intent-log.js";

// ─── Namespace + frozen vocabulary ─────────────────────────────────────────

export const AGT = "http://mnemosyne.dev/agent#";
export const PROV = "http://www.w3.org/ns/prov#";
export const XSD = "http://www.w3.org/2001/XMLSchema#";

export const PREFIXES = [`PREFIX agt: <${AGT}>`, `PREFIX prov: <${PROV}>`, `PREFIX xsd: <${XSD}>`].join("\n");

/**
 * The five classes of agent ontology v1. The self-check rejects any subject not
 * typed as one of these (structural frozen-vocab guard).
 */
export const AGENT_CLASSES = ["agt:Agent", "agt:Session", "agt:Run", "agt:Turn", "agt:Capability", "agt:Tool"] as const;

/**
 * The coarse access posture. MIRRORS `MnemosyneToolAccess`
 * (the packaged Prime host-tool surface) — `read | write` ONLY. We do not
 * invent a "dangerous" / "admin" value; the toolset enum is the source of truth.
 */
export type ToolAccess = "read" | "write";
export const TOOL_ACCESS_VALUES: readonly ToolAccess[] = ["read", "write"] as const;

/**
 * Tool lifecycle status. `used` = the agent actually called it in this session;
 * `declared` = a tool the agent is allowed to call but has not (yet) — the
 * demand-signal posture that lets `grow_interface` exist as a subject before it
 * is ever invoked.
 */
export type ToolStatus = "used" | "declared";

/** Required predicates per class — the assertion self-check pins these. */
export const REQUIRED_AGENT_PREDICATES = ["agt:agentId"] as const;
export const REQUIRED_SESSION_PREDICATES = ["agt:ofAgent", "agt:ownerUserId", "agt:turnCount"] as const;
export const REQUIRED_RUN_PREDICATES = ["agt:ofAgent", "agt:ofSession", "agt:runId"] as const;

/**
 * The inference-binding predicates an `agt:Session` carries WHEN the session row
 * persists a binding (CA-1 Track A). They are the agent-as-subject's "how does it
 * think" declared at the session layer — `agt:inferenceProvider` (e.g. "deepseek")
 * and `agt:inferenceModel` (e.g. "deepseek-v4-flash"), folded straight from the
 * stored `SessionRecord.{provider, model}`. OPTIONAL (a session that pins no
 * binding emits neither) so the self-check only requires them when present.
 *
 * These predicates make the precedence resolver's `session` layer LEGIBLE in RDF:
 * the same `{provider, model}` the worker folds into `worker_config` is what the
 * agent ontology records the session as declaring. They are scalars on the
 * existing `agt:Session` subject — NOT a new class — so the fold's frozen-vocab
 * guarantee (exactly the five `AGENT_CLASSES`) is untouched.
 */
export const SESSION_INFERENCE_PREDICATES = ["agt:inferenceProvider", "agt:inferenceModel"] as const;
export const REQUIRED_TURN_PREDICATES = ["agt:inSession", "agt:ordinal", "agt:role"] as const;
export const REQUIRED_TOOL_PREDICATES = ["agt:toolName", "agt:toolStatus"] as const;
export const REQUIRED_CAPABILITY_PREDICATES = ["agt:toolAccess"] as const;

// ─── The folded record (the value behind the SPARQL) ────────────────────────

/** One tool subject in the fold: the structured `toolName`, status, and access. */
export interface AgentToolRecord {
	readonly toolName: string;
	readonly status: ToolStatus;
	readonly access: ToolAccess;
}

/**
 * One turn in the fold: METADATA + POINTERS only. `usedTool` is the structured
 * tool name (extracted from the entry's tool-call/tool-result envelope — NOT by
 * regexing the body), or undefined for a plain text turn. `recallRef`/`songRef`
 * are opaque pointers into Memory/Song (no schema import).
 */
export interface AgentTurnRecord {
	readonly ordinal: number;
	readonly role: FrozenEntry["role"];
	readonly timestamp: number;
	readonly usedTool?: string;
	readonly recallRef?: string;
	readonly songRef?: string;
}

/** One capability posture the agent holds. */
export interface AgentCapabilityRecord {
	readonly access: ToolAccess;
}

/**
 * The inference binding the SESSION declares (CA-1 Track A) — folded straight from
 * the persisted `SessionRecord.{provider, model}`. Both OPTIONAL: a session that
 * pins neither emits no inference triple; one that pins only a provider (model
 * inherited at resolve time) emits only `agt:inferenceProvider`. This is the
 * agent-subject view of the resolver's `session` precedence layer — the same
 * `{provider, model}` the worker folds into `worker_config`, made legible as RDF.
 */
export interface AgentInferenceBindingRecord {
	readonly provider?: string;
	readonly model?: string;
}

/** The full folded agent-subject record — the value `serializeAgentSubject` emits. */
export interface AgentSubjectRecord {
	readonly agentId: string;
	readonly model: string;
	readonly sessionId: string;
	readonly ownerUserId: string;
	readonly graphId?: string;
	readonly turnCount: number;
	readonly turns: readonly AgentTurnRecord[];
	readonly tools: readonly AgentToolRecord[];
	readonly capabilities: readonly AgentCapabilityRecord[];
	/**
	 * The inference binding the session declares (CA-1 Track A), folded from the
	 * session row. Absent (or both fields absent) ⇒ no inference triple is emitted
	 * — byte-identical to the pre-Track-A serialization.
	 */
	readonly inferenceBinding?: AgentInferenceBindingRecord;
}

// ─── Stable registered agent id ─────────────────────────────────────────────

/**
 * Stable production identity for a registered agent. It is minted from the
 * registered name and therefore survives model swaps and prompt promotion. The
 * complete Agent Meaningful Object is the runtime authority; this deterministic
 * mint is the graph-seed validation rule for its subject id.
 */
export const STANDALONE_AGENT_IDENTITY_ALGORITHM = "agent-identity-v1-registered-name";

export function mintStandaloneAgentId(config: { name: string }): string {
	const name = config.name.trim();
	if (!name) throw new Error("mintStandaloneAgentId: a non-empty registered agent name is required");
	const digest = createHash("sha256").update(`agent-name:${name}`).digest("hex").slice(0, 16);
	return `agent-${digest}`;
}

// ─── URI minting ─────────────────────────────────────────────────────────────

/** Slug a label for a URI suffix: collapse non `[A-Za-z0-9_-]` to `-`, trim, preserve case. */
export function slug(label: string): string {
	return label.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The `agt:Agent` subject IRI. §4 identity unification: the stem is
 * `urn:sophia:agent:` (NOT the old `urn:sophia:agt:agent:` infix) so it
 * BYTE-MATCHES L0's `observer_iri` (`rdf_authority.rs::observer_iri`, the witness
 * IRI already baked into stored `mem:observedBy` + `<graph> prov:wasAttributedTo`
 * triples). For a clean token `agent-<hex16>`, `slug` is a no-op, so
 * `mintAgentUri("agent-deadbeef") === "urn:sophia:agent:agent-deadbeef"` ===
 * `observer_iri("agent-deadbeef")`. The agent now IS its own memory-witness.
 */
export const CANONICAL_AGENT_ID = /^agent-[0-9a-f]+$/;
export const CANONICAL_IRI_SEGMENT = /^[A-Za-z0-9_-]+$/;

function assertCanonicalIriSegment(label: string, value: string): void {
	if (!CANONICAL_IRI_SEGMENT.test(value)) {
		throw new Error(
			`${label}: non-canonical IRI segment ${JSON.stringify(value)} — segments must match [A-Za-z0-9_-] so L1 slug and L0 observer_segment remain byte-identical.`,
		);
	}
}

export function mintAgentUri(agentId: string): string {
	// §4 witness-identity guard: the agt:Agent IRI must byte-match L0's observer_iri,
	// but L1 `slug` and L0 `observer_segment` sanitize DIVERGENTLY off the canonical
	// charset (different replacement char + collapse + trim). A canonical `agent-<hex>`
	// token is a no-op for both → they agree; a non-canonical token would silently
	// split the subject from its own witness, so fail loudly instead. The registered
	// identity mint emits a canonical token; this fires if another id source leaks in.
	if (!CANONICAL_AGENT_ID.test(agentId)) {
		throw new Error(
			`mintAgentUri: non-canonical agent id ${JSON.stringify(agentId)} — must be agent-<hex> so the agt:Agent IRI byte-matches L0's observer_iri (L1 slug vs L0 observer_segment diverge off this charset). Fix the id source, not the guard.`,
		);
	}
	return `urn:sophia:agent:${slug(agentId)}`;
}

export function mintSessionUri(sessionId: string): string {
	return `urn:sophia:agt:session:${slug(sessionId)}`;
}

export function mintTurnUri(sessionId: string, ordinal: number): string {
	return `urn:sophia:agt:session:${slug(sessionId)}:turn:${ordinal}`;
}

/** WS-7 run-grain agt:Session IRI, nested under the canonical agent witness. */
export function mintRunSessionUri(agentId: string, runId: string): string {
	assertCanonicalIriSegment("mintRunSessionUri(runId)", runId);
	return `${mintAgentUri(agentId)}:session:${slug(runId)}`;
}

/** WS-7 node-grain agt:Turn IRI, nested under the run-grain agt:Session. */
export function mintRunTurnUri(agentId: string, runId: string, ordinal: number): string {
	return `${mintRunSessionUri(agentId, runId)}:turn:${ordinal}`;
}

/** Graph-persistent episode subject for the relevelled Agent ⊃ Session hierarchy. */
export function mintAgentSessionUri(agentId: string, sessionId: string): string {
	assertCanonicalIriSegment("mintAgentSessionUri(sessionId)", sessionId);
	return `${mintAgentUri(agentId)}:session:${sessionId}`;
}

/** One bounded workflow execution within a graph-persistent agent session. */
export function mintAgentRunEpisodeUri(agentId: string, sessionId: string, runId: string): string {
	assertCanonicalIriSegment("mintAgentRunEpisodeUri(runId)", runId);
	return `${mintAgentSessionUri(agentId, sessionId)}:run:${runId}`;
}

/** One node/turn within a bounded workflow execution. */
export function mintAgentRunTurnUri(agentId: string, sessionId: string, runId: string, ordinal: number): string {
	return `${mintAgentRunEpisodeUri(agentId, sessionId, runId)}:turn:${ordinal}`;
}

/** WS-7 URN-safe agt:Voice IRI, nested under the canonical agent witness. */
export function mintVoiceUri(agentId: string, voiceId: string): string {
	assertCanonicalIriSegment("mintVoiceUri(voiceId)", voiceId);
	return `${mintAgentUri(agentId)}:voice:${voiceId}`;
}

/**
 * A tool subject IRI, DERIVED from {@link mintAgentUri} so it tracks the unified
 * agent stem (a sub-path of the agent's IRI) instead of re-inlining the stem.
 */
export function mintToolUri(agentId: string, toolName: string): string {
	return `${mintAgentUri(agentId)}:tool:${slug(toolName)}`;
}

/**
 * A capability subject IRI, DERIVED from {@link mintAgentUri} (a sub-path of the
 * agent's IRI) so it tracks the unified agent stem.
 */
export function mintCapabilityUri(agentId: string, access: ToolAccess): string {
	return `${mintAgentUri(agentId)}:cap:${access}`;
}

// ─── Typed-literal serialization (clone of vocab.ts helpers) ─────────────────

export function iri(uri: string): string {
	return `<${uri}>`;
}

export function escapeLiteral(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
}

export function str(value: string): string {
	return `"${escapeLiteral(value)}"`;
}

export function xsdInt(n: number): string {
	return `"${Math.trunc(n)}"^^xsd:integer`;
}

export function xsdLong(n: number): string {
	return `"${Math.trunc(n)}"^^xsd:long`;
}

export function xsdDateTime(epochMs: number): string {
	return `"${new Date(epochMs).toISOString()}"^^xsd:dateTime`;
}

export function xsdBoolean(value: boolean): string {
	return `"${value ? "true" : "false"}"^^xsd:boolean`;
}

// ─── The fold ────────────────────────────────────────────────────────────────

/**
 * Extract the STRUCTURED tool name from one frozen entry, if it carries a tool
 * usage. We read the parsed JSON envelope's structured field — NEVER a regex over
 * the message body. An assistant turn whose first content block is a `toolCall`
 * yields its `toolName`; a `toolResult` turn yields the envelope's `toolName`.
 * Plain text turns yield undefined.
 */
function structuredToolName(entry: FrozenEntry): string | undefined {
	let content: unknown;
	try {
		content = JSON.parse(entry.content_json);
	} catch {
		return undefined;
	}
	if (entry.role === "toolResult") {
		// content_json is the envelope { toolCallId, toolName, isError, content }.
		const env = content as { toolName?: unknown };
		return typeof env.toolName === "string" ? env.toolName : undefined;
	}
	if (entry.role === "assistant" && Array.isArray(content)) {
		// AssistantMessage["content"] is an array of blocks; a toolCall block (Pi's
		// `ToolCall` content) carries a structured `toolName`. We type the block
		// against the real AssistantMessage content shape, then read the field.
		type AssistantContentBlock = AssistantMessage["content"][number] & { type?: string; toolName?: unknown };
		for (const block of content as AssistantContentBlock[]) {
			if (block && typeof block === "object" && block.type === "toolCall" && typeof block.toolName === "string") {
				return block.toolName;
			}
		}
	}
	return undefined;
}

/** The pieces of agent identity the fold needs beyond the persisted session. */
export interface AgentIdentity {
	readonly agentId: string;
	readonly model: string;
	/**
	 * Tools the agent DECLARES (allowed but maybe never called) — each becomes an
	 * `agt:Tool` with `toolStatus=declared`. `grow_interface` is the canonical
	 * demand-signal entry. Defaults to a single declared `grow_interface`.
	 */
	readonly declaredTools?: readonly { name: string; access: ToolAccess }[];
	/** Coarse capability postures the agent holds. Defaults to `["read", "write"]`. */
	readonly capabilities?: readonly ToolAccess[];
}

/**
 * Pure reconstruction of an {@link AgentSubjectRecord} from a session record + a
 * frozen snapshot + the agent identity. Exposed for direct unit assertions (seed
 * the inputs, assert field-for-field). Mirrors `reconstructRunRecord`'s shape
 * (../workflow/projection.ts ~:50): a pure value fold over plain rows.
 */
export function reconstructAgentSubject(
	session: SessionRecord,
	snapshot: FrozenSnapshot,
	identity: AgentIdentity,
): AgentSubjectRecord {
	const declared = identity.declaredTools ?? [{ name: "grow_interface", access: "write" as ToolAccess }];
	const capabilities = (identity.capabilities ?? ["read", "write"]).map((access) => ({ access }));

	// Turns: metadata + tool-usage pointer only. No body.
	const usedToolNames = new Map<string, ToolAccess>();
	const turns: AgentTurnRecord[] = snapshot.entries.map((entry) => {
		const usedTool = structuredToolName(entry);
		if (usedTool) {
			// A used tool defaults to `write` access unless it is a declared read tool.
			const declaredMatch = declared.find((d) => d.name === usedTool);
			usedToolNames.set(usedTool, declaredMatch?.access ?? "write");
		}
		return {
			ordinal: entry.seq,
			role: entry.role,
			timestamp: entry.timestamp,
			...(usedTool ? { usedTool } : {}),
		};
	});

	// Tools: the union of declared tools + tools actually used. Declared tools
	// keep `toolStatus=declared` (demand-signal); a tool that was used flips to
	// `used`. Keyed by name so a declared-then-used tool appears once.
	const toolByName = new Map<string, AgentToolRecord>();
	for (const d of declared) {
		toolByName.set(d.name, { toolName: d.name, status: "declared", access: d.access });
	}
	for (const [name, access] of usedToolNames) {
		const existing = toolByName.get(name);
		toolByName.set(name, { toolName: name, status: "used", access: existing?.access ?? access });
	}

	// The session's declared inference binding, folded straight from the row.
	// Only present fields are carried (null → omitted); an all-null row yields an
	// `undefined` binding so the serializer emits no inference triple.
	const inferenceBinding = foldSessionInferenceBinding(session);

	return {
		agentId: identity.agentId,
		model: identity.model,
		sessionId: session.session_id,
		ownerUserId: session.user_id,
		graphId: session.graph_id ?? undefined,
		turnCount: turns.length,
		turns,
		tools: [...toolByName.values()],
		capabilities,
		...(inferenceBinding ? { inferenceBinding } : {}),
	};
}

/**
 * Fold a session row's persisted `{provider, model}` into an
 * {@link AgentInferenceBindingRecord}, dropping null/empty fields. Returns
 * `undefined` when the row pins NEITHER (so the serializer emits no inference
 * triple and the fold is byte-identical to the pre-Track-A output). PURE.
 */
export function foldSessionInferenceBinding(
	session: Pick<SessionRecord, "provider" | "model">,
): AgentInferenceBindingRecord | undefined {
	const provider = session.provider && session.provider.length > 0 ? session.provider : undefined;
	const model = session.model && session.model.length > 0 ? session.model : undefined;
	if (provider === undefined && model === undefined) return undefined;
	return {
		...(provider !== undefined ? { provider } : {}),
		...(model !== undefined ? { model } : {}),
	};
}

/**
 * Fold a session into agent-subject `agt:` triples. SUBSTRATE-BLIND: reads the
 * session record + the FROZEN IntentLog snapshot (S1's `freeze()`), never a live
 * CRDT handle. Returns both the rebuilt record and the SPARQL so the caller can
 * inspect the former and file the latter into a caller-authorized graph face.
 * The hosted workflow path uses the typed `wf-agent-session-projection` generic
 * ingest instead, so Garden owns SHACL validation and the reserved target.
 *
 * `identity` is mandatory: callers must supply the Agent Meaningful Object's
 * registered subject id. A session model describes an inference manifestation,
 * never the identity of the agent that owns it.
 */
export async function foldSessionToAgentSubject(
	store: SessionStore,
	identity: AgentIdentity,
	sessionId: string,
	intentLog: IntentLog,
): Promise<{ record: AgentSubjectRecord; sparql: string }> {
	const session = await store.getSession(sessionId);
	if (!session) {
		throw new Error(`foldSessionToAgentSubject: no session for ${sessionId}`);
	}
	const snapshot = await intentLog.freeze();
	const record = reconstructAgentSubject(session, snapshot, identity);
	const sparql = serializeAgentSubject(record);
	return { record, sparql };
}

// ─── The serializer (pure, no I/O) ───────────────────────────────────────────

function agentBlock(record: AgentSubjectRecord): string {
	const uri = mintAgentUri(record.agentId);
	return [
		`${iri(uri)} a agt:Agent, prov:Agent ;`,
		`\tagt:agentId ${str(record.agentId)} ;`,
		`\tagt:model ${str(record.model)} .`,
	].join("\n");
}

function sessionBlock(record: AgentSubjectRecord): string {
	// Build the predicate list, then terminate: every line but the last ends in
	// " ;", the last in " ." — so optional trailing predicates (graphId, the
	// inference binding) compose without per-line terminator juggling.
	const preds: string[] = [
		`agt:ofAgent ${iri(mintAgentUri(record.agentId))}`,
		`agt:sessionId ${str(record.sessionId)}`,
		`agt:ownerUserId ${str(record.ownerUserId)}`,
		`agt:turnCount ${xsdInt(record.turnCount)}`,
	];
	if (record.graphId) {
		preds.push(`agt:graphId ${str(record.graphId)}`);
	}
	// CA-1 Track A: the session's declared inference binding — `agt:inferenceProvider`
	// / `agt:inferenceModel`, each emitted only when the folded binding pins it. This
	// is the resolver's `session` precedence layer made legible as RDF.
	if (record.inferenceBinding?.provider) {
		preds.push(`agt:inferenceProvider ${str(record.inferenceBinding.provider)}`);
	}
	if (record.inferenceBinding?.model) {
		preds.push(`agt:inferenceModel ${str(record.inferenceBinding.model)}`);
	}
	const body = preds.map((p, i) => `\t${p}${i === preds.length - 1 ? " ." : " ;"}`).join("\n");
	return `${iri(uri(record))} a agt:Session ;\n${body}`;
}

/** The `agt:Session` subject URI for a record (local helper, keeps sessionBlock terse). */
function uri(record: AgentSubjectRecord): string {
	return mintSessionUri(record.sessionId);
}

function turnBlock(record: AgentSubjectRecord, turn: AgentTurnRecord): string {
	const uri = mintTurnUri(record.sessionId, turn.ordinal);
	const sessionUri = mintSessionUri(record.sessionId);
	const pointers: string[] = [];
	if (turn.usedTool) {
		pointers.push(`\tagt:usedTool ${iri(mintToolUri(record.agentId, turn.usedTool))} ;`);
	}
	if (turn.recallRef) {
		pointers.push(`\tagt:recallRef ${iri(turn.recallRef)} ;`);
	}
	if (turn.songRef) {
		pointers.push(`\tagt:songRef ${iri(turn.songRef)} ;`);
	}
	return [
		`${iri(uri)} a agt:Turn ;`,
		`\tagt:inSession ${iri(sessionUri)} ;`,
		`\tagt:ordinal ${xsdInt(turn.ordinal)} ;`,
		`\tagt:role ${str(turn.role)} ;`,
		...pointers,
		`\tagt:turnTime ${xsdDateTime(turn.timestamp)} .`,
	].join("\n");
}

function toolBlock(record: AgentSubjectRecord, tool: AgentToolRecord): string {
	const uri = mintToolUri(record.agentId, tool.toolName);
	const agentUri = mintAgentUri(record.agentId);
	return [
		`${iri(uri)} a agt:Tool ;`,
		`\tagt:ofAgent ${iri(agentUri)} ;`,
		`\tagt:toolName ${str(tool.toolName)} ;`,
		`\tagt:toolStatus ${str(tool.status)} ;`,
		`\tagt:toolAccess ${str(tool.access)} .`,
	].join("\n");
}

function capabilityBlock(record: AgentSubjectRecord, cap: AgentCapabilityRecord): string {
	const uri = mintCapabilityUri(record.agentId, cap.access);
	const agentUri = mintAgentUri(record.agentId);
	return [
		`${iri(uri)} a agt:Capability ;`,
		`\tagt:ofAgent ${iri(agentUri)} ;`,
		`\tagt:toolAccess ${str(cap.access)} .`,
	].join("\n");
}

/**
 * Serialize an {@link AgentSubjectRecord} to a single `INSERT DATA { … }` block
 * (with PREFIXes). Pure, no I/O. Emits only registered agent classes — the
 * serializer has no notion of any other anatomy, so the fold STRUCTURALLY CANNOT
 * mint a workflow/CRDT/memory subject.
 */
export function serializeAgentSubject(record: AgentSubjectRecord): string {
	const blocks: string[] = [
		agentBlock(record),
		sessionBlock(record),
		...record.turns.map((t) => turnBlock(record, t)),
		...record.tools.map((t) => toolBlock(record, t)),
		...record.capabilities.map((c) => capabilityBlock(record, c)),
	];
	return `${PREFIXES}\nINSERT DATA {\n${blocks.join("\n")}\n}`;
}

// ─── The self-check (in-process, NOT a SHACL engine) ─────────────────────────

/**
 * Self-check the generated INSERT. A clone of `assertRunSparql`
 * (../workflow/provenance.ts ~:117): substring/structural checks only — NO RDF
 * parser, NO SHACL. Verifies the INSERT shell, the required predicates of each
 * present class, the `agt:Agent`/`agt:Session` spine, and the `agt:toolAccess`
 * enum (read|write only). Returns `{ ok, failures }`.
 */
export function assertAgentSparql(
	sparql: string,
	opts?: { expectTurns?: boolean; expectTools?: boolean },
): { ok: boolean; failures: string[] } {
	const failures: string[] = [];

	if (!/INSERT DATA/.test(sparql)) {
		failures.push("missing INSERT DATA");
	}

	// The spine: an Agent and a Session must always be present, wired by ofAgent.
	if (!sparql.includes("a agt:Agent")) {
		failures.push("missing agt:Agent subject");
	}
	if (!sparql.includes("a agt:Session")) {
		failures.push("missing agt:Session subject");
	}
	// `agt:ofAgent` is the load-bearing edge from Session/Tool/Capability → Agent.
	// Its absence is the canonical negative case (a dangling session/tool).
	if (!sparql.includes("agt:ofAgent ")) {
		failures.push("missing agt:ofAgent edge (session/tool/capability not wired to an agent)");
	}

	for (const p of REQUIRED_AGENT_PREDICATES) {
		if (!sparql.includes(`${p} `)) failures.push(`agent missing predicate ${p}`);
	}
	for (const p of REQUIRED_SESSION_PREDICATES) {
		if (!sparql.includes(`${p} `)) failures.push(`session missing predicate ${p}`);
	}
	if (sparql.includes("a agt:Run")) {
		for (const p of REQUIRED_RUN_PREDICATES) {
			if (!sparql.includes(`${p} `)) failures.push(`run missing predicate ${p}`);
		}
	}

	if (opts?.expectTurns !== false && sparql.includes("a agt:Turn")) {
		for (const p of REQUIRED_TURN_PREDICATES) {
			if (!sparql.includes(`${p} `)) failures.push(`turn missing predicate ${p}`);
		}
	}
	if (opts?.expectTools !== false && sparql.includes("a agt:Tool")) {
		for (const p of REQUIRED_TOOL_PREDICATES) {
			if (!sparql.includes(`${p} `)) failures.push(`tool missing predicate ${p}`);
		}
	}

	// `agt:toolAccess` enum: every value must be read|write. Scan each occurrence.
	const accessMatches = sparql.match(/agt:toolAccess\s+"([^"]*)"/g) ?? [];
	for (const m of accessMatches) {
		const value = m.replace(/.*"([^"]*)"/, "$1");
		if (!TOOL_ACCESS_VALUES.includes(value as ToolAccess)) {
			failures.push(`agt:toolAccess has forbidden value "${value}" (must be read|write)`);
		}
	}

	// CA-1 Track A: the inference-binding predicates are OPTIONAL, but when present
	// MUST carry a non-empty literal (an empty `agt:inferenceProvider ""` is a
	// degenerate fold the serializer never produces — the binding fold drops empty
	// fields). This is the only inference-binding structural rule.
	for (const p of SESSION_INFERENCE_PREDICATES) {
		const re = new RegExp(`${p}\\s+"([^"]*)"`, "g");
		for (const match of sparql.match(re) ?? []) {
			const value = match.replace(/.*"([^"]*)"/, "$1");
			if (value.length === 0) failures.push(`${p} has an empty literal (must be a non-empty provider/model id)`);
		}
	}

	return { ok: failures.length === 0, failures };
}

/**
 * The string tokens an agent-subject fold MUST NEVER emit. Proving their absence
 * is the substrate-blind + no-body-leak guarantee (clone of the
 * workflow-projection FORBIDDEN_ANATOMY string-scan). Substrate tokens (CRDT),
 * foreign-vocab prefixes, and Pi-internal field names are all banned; the raw
 * message body is checked separately against the seeded trace.
 */
export const FORBIDDEN_ANATOMY = [
	// substrate tokens — the fold is substrate-blind
	"yrs",
	"Loro",
	"yjs",
	"CRDT",
	"Y.Doc",
	// foreign-vocab prefixes — agt: is self-contained
	"mnemo:",
	"doc:",
	"wf:",
	"mem:",
	// Pi AssistantMessage internal fields — never leak the runtime envelope
	"errorMessage",
	"responseId",
	"thoughtSignature",
] as const;
