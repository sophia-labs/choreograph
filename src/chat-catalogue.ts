/**
 * Chat session catalogue (Sobremesa): the owner-only "one conversation home"
 * list, carried without a transcript.
 *
 * A chat Agent Session is a ROOT Agent Session whose node is headed
 * (`interactionMode: "headed"`): an owner-driven conversation, whichever
 * built-in workflow started it (`workspace-chat-v1`, or the Domain Agent's
 * headed pilot). The runtime store keeps one small catalogue row for each of
 * them: a title, the resolved model and provider, and two timestamps. This
 * module holds the pure parts only: title derivation, list paging, and the wire
 * projection. It never sees a transcript and never sees seed bytes.
 *
 * Everything here is deterministic and has no I/O, so the same functions serve
 * the store (row creation, backfill), the HTTP route and the tests.
 */

export const CHAT_TITLE_AUTO_MAX_CHARS = 80;
export const CHAT_TITLE_EXPLICIT_MAX_CHARS = 200;
export const CHAT_SESSION_LIST_DEFAULT_LIMIT = 50;
export const CHAT_SESSION_LIST_MAX_LIMIT = 100;
/** Legacy chats catalogued per backfill call, and the most calls one first-page list makes. */
export const CHAT_SESSION_LIST_BACKFILL_PAGE = 50;
/** 20 pages of 50: a person with a thousand legacy chats has them all in the first traversal, at about a second once. */
export const CHAT_SESSION_LIST_BACKFILL_ROUNDS = 20;
/** Shown when a chat has no usable first message (an all-whitespace prompt). */
export const CHAT_UNTITLED = "New chat";

/**
 * Where the stored title came from:
 * - `explicit`: the caller supplied one (`input.title`, or a continuation's `seed.title`);
 * - `first-message`: derived from the person's first message;
 * - `backfill`: derived from a session that predates the catalogue.
 */
export type ChatTitleSource = "explicit" | "first-message" | "backfill";

/**
 * Event types that count as conversation activity for `lastActivityAt`: the
 * person did something, or the assistant finished something. Streaming deltas,
 * budget ledger updates and lifecycle bookkeeping deliberately do not.
 */
export const CHAT_ACTIVITY_EVENT_TYPES: ReadonlySet<string> = new Set([
	"command.accepted",
	"input.prompt",
	"input.follow_up",
	"input.steer",
	"message.completed",
	"turn.completed",
	"turn.failed",
]);

/**
 * The workflows whose headed root Sessions are chats a person has: the built-in workspace assistant, and the Domain
 * Agent's headed pilot. A headed root agent of any other workflow is not thereby a chat. Named as text because this
 * module is pure; a test holds them equal to the workflows' own names.
 */
export const CHAT_WORKFLOW_NAMES: ReadonlySet<string> = new Set(["workspace-chat-v1", "domain-agent-activity-loop-v1"]);

/**
 * The durable commands a person sends into a chat. The host sends others of its own: `quiesce` when a body idles and
 * at every graceful shutdown (so, at every deploy), goal bookkeeping, an abort. They are not conversation, and a chat
 * nobody touched must not jump to the top of the list because the host tidied up.
 */
export const CHAT_ACTIVITY_COMMAND_NAMES: ReadonlySet<string> = new Set(["prompt", "follow_up", "steer"]);

/** Does this event mean the person did something, or an assistant finished something? */
export function isChatActivityEvent(type: string, payload: unknown): boolean {
	if (!CHAT_ACTIVITY_EVENT_TYPES.has(type)) return false;
	if (type !== "command.accepted") return true;
	const name = isRecord(payload) ? payload.name : undefined;
	return typeof name === "string" && CHAT_ACTIVITY_COMMAND_NAMES.has(name);
}

/** The archived conversation a chat continues, recorded verbatim from the invocation. */
export interface ChatContinuation {
	readonly archiveConversationUrn: string;
	readonly revisionId: string;
}

/** `{kept, omitted, total}` messages of the conversation a continuation window carried. */
export interface ChatWindowCounts {
	readonly kept: number;
	readonly omitted: number;
	readonly total: number;
}

/** One catalogue row, exactly as stored (snake_case, epoch-ms integers). */
export interface ChatSessionCatalogueRecord {
	session_id: string;
	run_id: string;
	owner_user_id: string;
	graph_owner_principal: string;
	graph_id: string;
	workflow_name: string;
	title: string;
	title_source: ChatTitleSource;
	model: string;
	provider: string;
	continues_json: string | null;
	seed_window_json: string | null;
	created_at: number;
	last_activity_at: number;
}

/** A catalogue row joined with the Session's outcome and lifecycle. */
export interface ChatSessionListRow extends ChatSessionCatalogueRecord {
	session_status: string;
	session_lifecycle_state: string;
}

export interface ChatSessionCursor {
	readonly lastActivityAt: number;
	readonly sessionId: string;
}

export interface ChatSessionListPage {
	readonly sessions: readonly ChatSessionListRow[];
	readonly nextCursor: ChatSessionCursor | null;
}

/** What the store needs to page one owner's chats. Owner scoping is never optional. */
export interface ChatSessionListStoreQuery {
	readonly ownerUserId: string;
	readonly graphId?: string;
	readonly graphOwnerPrincipal?: string;
	readonly workflowName?: string;
	readonly limit: number;
	readonly cursor?: ChatSessionCursor;
}

/** The wire face of one chat, camelCase like every other Choreograph projection. */
export interface ChatSessionSummaryV1 {
	readonly sessionId: string;
	readonly runId: string;
	readonly graphId: string;
	readonly graphOwnerPrincipal: string;
	readonly workflow: string;
	readonly title: string;
	readonly titleSource: ChatTitleSource;
	readonly model: string;
	readonly provider: string;
	readonly createdAt: number;
	readonly lastActivityAt: number;
	readonly status: string;
	readonly lifecycleState: string;
	readonly continuesConversation?: ChatContinuation;
	readonly seedWindow?: ChatWindowCounts;
}

export class ChatSessionQueryError extends Error {
	constructor(
		readonly code: "invalid_limit" | "invalid_cursor" | "invalid_graph_id" | "invalid_workflow",
		message: string,
	) {
		super(message);
		this.name = "ChatSessionQueryError";
	}
}

// ─── Titles ──────────────────────────────────────────────────────────────────

/**
 * Collapse all whitespace to single spaces and drop control characters. Whitespace goes first (a newline or a tab
 * is a space between words), then control characters, then spaces once more: a control character that sat between
 * two spaces ("a \u0007 b") must not leave a double space behind.
 */
export function sanitizeChatTitle(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
		.replace(/ {2,}/g, " ")
		.trim();
}

/**
 * The auto title: the first message, whitespace-collapsed, cut to at most
 * `maxChars` code points. A long message is cut at a word boundary when one
 * falls in the last 40% of the budget, and marked with an ellipsis.
 */
export function deriveChatTitle(text: string, maxChars = CHAT_TITLE_AUTO_MAX_CHARS): string {
	const cleaned = sanitizeChatTitle(text);
	if (!cleaned) return CHAT_UNTITLED;
	const points = Array.from(cleaned);
	if (points.length <= maxChars) return cleaned;
	const head = points.slice(0, maxChars - 1).join("");
	const lastSpace = head.lastIndexOf(" ");
	const cut = lastSpace >= Math.floor(maxChars * 0.6) ? head.slice(0, lastSpace) : head;
	return `${cut.trimEnd()}…`;
}

/**
 * An explicit title as supplied, sanitized and capped at
 * `CHAT_TITLE_EXPLICIT_MAX_CHARS` code points; `undefined` when absent or blank.
 * The caller chose these words, so nothing is added to a cut one.
 */
export function normalizeExplicitChatTitle(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const cleaned = sanitizeChatTitle(value);
	if (cleaned === "") return undefined;
	const points = Array.from(cleaned);
	return points.length <= CHAT_TITLE_EXPLICIT_MAX_CHARS
		? cleaned
		: points.slice(0, CHAT_TITLE_EXPLICIT_MAX_CHARS).join("").trimEnd();
}

// ─── Paging ──────────────────────────────────────────────────────────────────

export function encodeChatSessionCursor(cursor: ChatSessionCursor): string {
	return Buffer.from(JSON.stringify({ t: cursor.lastActivityAt, s: cursor.sessionId }), "utf8").toString("base64url");
}

export function decodeChatSessionCursor(value: string): ChatSessionCursor | undefined {
	try {
		const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
		if (!isRecord(parsed)) return undefined;
		const t = parsed.t;
		const s = parsed.s;
		if (typeof t !== "number" || !Number.isSafeInteger(t) || t < 0) return undefined;
		if (typeof s !== "string" || s === "" || s.length > 200) return undefined;
		const cursor = { lastActivityAt: t, sessionId: s };
		// The decoder ignores characters that are not base64url: a cursor is only what this route issued.
		return encodeChatSessionCursor(cursor) === value ? cursor : undefined;
	} catch {
		return undefined;
	}
}

export interface ChatSessionListQuery {
	readonly limit: number;
	readonly cursor?: ChatSessionCursor;
	/** The `graph_id` query parameter, when the caller sent one. */
	readonly graphId?: string;
	readonly workflow?: string;
}

/** Parse the paging and filter parameters of `GET /api/workflows/runs?view=chat-sessions`. */
export function parseChatSessionListQuery(params: URLSearchParams): ChatSessionListQuery {
	const limitRaw = params.get("limit");
	let limit = CHAT_SESSION_LIST_DEFAULT_LIMIT;
	if (limitRaw !== null && limitRaw !== "") {
		if (!/^\d{1,4}$/.test(limitRaw)) {
			throw new ChatSessionQueryError(
				"invalid_limit",
				`limit must be an integer from 1 to ${CHAT_SESSION_LIST_MAX_LIMIT}`,
			);
		}
		limit = Number.parseInt(limitRaw, 10);
		if (limit < 1 || limit > CHAT_SESSION_LIST_MAX_LIMIT) {
			throw new ChatSessionQueryError(
				"invalid_limit",
				`limit must be an integer from 1 to ${CHAT_SESSION_LIST_MAX_LIMIT}`,
			);
		}
	}
	const cursorRaw = params.get("cursor");
	let cursor: ChatSessionCursor | undefined;
	if (cursorRaw !== null && cursorRaw !== "") {
		cursor = decodeChatSessionCursor(cursorRaw);
		if (!cursor) throw new ChatSessionQueryError("invalid_cursor", "cursor is not a cursor this route issued");
	}
	const graphRaw = params.get("graph_id")?.trim();
	if (graphRaw !== undefined && (graphRaw === "" || graphRaw.length > 200)) {
		throw new ChatSessionQueryError(
			"invalid_graph_id",
			"graph_id must be a non-empty string of at most 200 characters",
		);
	}
	const workflowRaw = params.get("workflow")?.trim();
	if (workflowRaw !== undefined && (workflowRaw === "" || workflowRaw.length > 100)) {
		throw new ChatSessionQueryError(
			"invalid_workflow",
			"workflow must be a non-empty string of at most 100 characters",
		);
	}
	return {
		limit,
		...(cursor ? { cursor } : {}),
		...(graphRaw === undefined ? {} : { graphId: graphRaw }),
		...(workflowRaw === undefined ? {} : { workflow: workflowRaw }),
	};
}

/**
 * Whether the caller named an owner other than themselves. The route serves the
 * caller's own chats only; an explicit `owner` is accepted as a defence in depth
 * (a gateway may pass it) and refused with 403 when it is anyone else. Both the
 * bare Cognito sub and the `user:<sub>` principal form are recognized.
 */
export function isOtherChatOwner(requested: string | null, callerUserId: string): boolean {
	if (requested === null) return false;
	const trimmed = requested.trim();
	if (trimmed === "") return false;
	return trimmed !== callerUserId && trimmed !== `user:${callerUserId}`;
}

// ─── Wire projection ─────────────────────────────────────────────────────────

export function projectChatSession(row: ChatSessionListRow): ChatSessionSummaryV1 {
	const continuation = parseChatContinuation(row.continues_json);
	const seedWindow = parseChatWindowCounts(row.seed_window_json);
	return {
		sessionId: row.session_id,
		runId: row.run_id,
		graphId: row.graph_id,
		graphOwnerPrincipal: row.graph_owner_principal,
		workflow: row.workflow_name,
		title: row.title,
		titleSource: row.title_source,
		model: row.model,
		provider: row.provider,
		createdAt: row.created_at,
		lastActivityAt: row.last_activity_at,
		status: row.session_status,
		lifecycleState: row.session_lifecycle_state,
		...(continuation ? { continuesConversation: continuation } : {}),
		...(seedWindow ? { seedWindow } : {}),
	};
}

/** The smaller face used inside a Session projection (no list-only fields). */
export interface ChatSessionFactsV1 {
	readonly title: string;
	readonly titleSource: ChatTitleSource;
	readonly model: string;
	readonly provider: string;
	readonly createdAt: number;
	readonly lastActivityAt: number;
	readonly continuesConversation?: ChatContinuation;
	readonly seedWindow?: ChatWindowCounts;
}

export function projectChatSessionFacts(record: ChatSessionCatalogueRecord): ChatSessionFactsV1 {
	const continuation = parseChatContinuation(record.continues_json);
	const seedWindow = parseChatWindowCounts(record.seed_window_json);
	return {
		title: record.title,
		titleSource: record.title_source,
		model: record.model,
		provider: record.provider,
		createdAt: record.created_at,
		lastActivityAt: record.last_activity_at,
		...(continuation ? { continuesConversation: continuation } : {}),
		...(seedWindow ? { seedWindow } : {}),
	};
}

export function parseChatContinuation(json: string | null): ChatContinuation | undefined {
	if (!json) return undefined;
	try {
		const parsed: unknown = JSON.parse(json);
		if (!isRecord(parsed)) return undefined;
		const urn = parsed.archiveConversationUrn;
		const revision = parsed.revisionId;
		if (typeof urn !== "string" || urn === "" || typeof revision !== "string" || revision === "") return undefined;
		return { archiveConversationUrn: urn, revisionId: revision };
	} catch {
		return undefined;
	}
}

export function parseChatWindowCounts(json: string | null): ChatWindowCounts | undefined {
	if (!json) return undefined;
	try {
		const parsed: unknown = JSON.parse(json);
		if (!isRecord(parsed)) return undefined;
		const { kept, omitted, total } = parsed;
		for (const count of [kept, omitted, total]) {
			if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return undefined;
		}
		return { kept: kept as number, omitted: omitted as number, total: total as number };
	} catch {
		return undefined;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
