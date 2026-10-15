/**
 * `GET /api/workflows/runs?view=chat-sessions` — a person's own chats, per graph.
 *
 * The gateway already proxies `GET /g/{graph}/workflows/runs` (its `ListRuns`
 * route: Viewer on the graph, query string forwarded, `x-graph-id` and
 * `x-graph-owner` minted from the ACL-checked URL), so this view needs no gateway
 * change. It answers only for the caller's own chats: a chat is private to the
 * person who had it, so even the owner of the graph does not list a
 * collaborator's conversations.
 *
 * Errors are `{ error: { code, message } }`, the same envelope invocations use:
 * 400 `invalid_view | invalid_limit | invalid_cursor | invalid_graph_id |
 * invalid_workflow | invalid_graph_owner | graph_mismatch`, 403 `owner_mismatch`.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
	CHAT_SESSION_LIST_BACKFILL_PAGE,
	CHAT_SESSION_LIST_BACKFILL_ROUNDS,
	ChatSessionQueryError,
	encodeChatSessionCursor,
	isOtherChatOwner,
	parseChatSessionListQuery,
	projectChatSession,
} from "./chat-catalogue.js";
import { firstHeader, sendCodedError, sendJson } from "./chat-http.js";
import { isCanonicalGraphOwnerPrincipal } from "./graph-owner-principal.js";
import type { WorkflowRuntimeStore } from "./workflow/runtime-store.js";

export const CHAT_SESSIONS_VIEW = "chat-sessions";

export interface ChatSessionListRequest {
	readonly runtime: WorkflowRuntimeStore;
	readonly request: IncomingMessage;
	readonly response: ServerResponse;
	readonly url: URL;
	/** The acting person: `x-user-id` under internal-service auth, the token's subject otherwise. */
	readonly ownerUserId: string;
	/** True when the caller is the gateway, whose `x-graph-id` and `x-graph-owner` are minted after the ACL check. */
	readonly trustedGateway: boolean;
}

export async function handleChatSessionList(input: ChatSessionListRequest): Promise<void> {
	const { runtime, request, response, url, ownerUserId, trustedGateway } = input;

	let query: ReturnType<typeof parseChatSessionListQuery>;
	try {
		query = parseChatSessionListQuery(url.searchParams);
	} catch (error) {
		if (error instanceof ChatSessionQueryError) {
			sendCodedError(response, 400, error.code, error.message);
			return;
		}
		throw error;
	}
	if (isOtherChatOwner(url.searchParams.get("owner"), ownerUserId)) {
		sendCodedError(response, 403, "owner_mismatch", "chat sessions are private to the person who had them");
		return;
	}

	// The gateway-minted graph is authoritative: a different graph in the query
	// contradicts the ACL check that already ran and is refused, not obeyed.
	const mintedGraph = trustedGateway ? firstHeader(request.headers["x-graph-id"]) : undefined;
	if (mintedGraph && query.graphId !== undefined && mintedGraph !== query.graphId) {
		sendCodedError(response, 400, "graph_mismatch", "graph_id contradicts the graph this request was authorized for");
		return;
	}
	const graphId = mintedGraph || query.graphId;
	const graphOwnerPrincipal = trustedGateway ? firstHeader(request.headers["x-graph-owner"]) : undefined;
	if (graphOwnerPrincipal !== undefined && !isCanonicalGraphOwnerPrincipal(graphOwnerPrincipal)) {
		sendCodedError(response, 400, "invalid_graph_owner", "x-graph-owner is not a graph owner principal");
		return;
	}

	// Chats that predate the catalogue are catalogued lazily, from their own record, on the first page only
	// (bounded, idempotent, and asked once per person and graph while the process lives). This is a courtesy to
	// the person's old chats, never a condition of the list: if it fails, the chats that already have rows are
	// still served, and the failure is logged (no chat content in it) for someone to look at.
	if (!query.cursor) {
		try {
			await runtime.catalogueLegacyChats({
				ownerUserId,
				...(graphId === undefined ? {} : { graphId }),
				...(graphOwnerPrincipal === undefined ? {} : { graphOwnerPrincipal }),
				pageSize: CHAT_SESSION_LIST_BACKFILL_PAGE,
				maxRounds: CHAT_SESSION_LIST_BACKFILL_ROUNDS,
			});
		} catch (error) {
			console.error(
				`[chat-catalogue] backfill failed, serving the list without it: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	const page = await runtime.listChatSessions({
		ownerUserId,
		...(graphId === undefined ? {} : { graphId }),
		...(graphOwnerPrincipal === undefined ? {} : { graphOwnerPrincipal }),
		...(query.workflow === undefined ? {} : { workflowName: query.workflow }),
		limit: query.limit,
		...(query.cursor ? { cursor: query.cursor } : {}),
	});
	response.setHeader("cache-control", "private, no-store");
	sendJson(response, 200, {
		view: CHAT_SESSIONS_VIEW,
		sessions: page.sessions.map(projectChatSession),
		nextCursor: page.nextCursor ? encodeChatSessionCursor(page.nextCursor) : null,
	});
}
