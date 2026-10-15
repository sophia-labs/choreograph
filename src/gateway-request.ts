/**
 * What the gateway mints on a graph-scoped Choreograph request, read exactly.
 *
 * After its ACL check the gateway sends `x-graph-id` (always), `x-graph-owner` (on the owner-qualified route
 * `/o/{owner}/g/{graph}`; the legacy `/g/{graph}` route names no owner and binds the request to the caller as owner,
 * `routes.rs` `force_canonical_invocation_binding`) and `x-sophia-graph-role`. Choreograph believes them only on the
 * internal-service path, which only the gateway and in-host services can authenticate as.
 *
 * Each header is read once: a header sent more than once (an array here, or two raw lines) is unreadable and refused,
 * never resolved to its first value. Node joins most repeated headers with ", ", which no role or graph id is.
 */

import type { IncomingMessage } from "node:http";
import type { HostedAuthContext } from "./auth.js";
import { InvocationFault } from "./workflow/invocation.js";
import {
	GATEWAY_GRAPH_ROLE_HEADER,
	parseGatewayGraphRole,
	type WorkspaceChatRole,
} from "./workflow/workspace-chat-contract.js";

export const GATEWAY_GRAPH_ID_HEADER = "x-graph-id";
export const GATEWAY_GRAPH_OWNER_HEADER = "x-graph-owner";

type HeaderSource = Pick<IncomingMessage, "headers"> & { readonly rawHeaders?: readonly string[] };

/** The graph a request was addressed through, as the gateway checked it. */
export interface GatewayGraphAddress {
	readonly graphId: string;
	readonly graphOwnerPrincipal: string;
}

/** The one value of a header, or undefined when absent; `null` when it was sent more than once. */
function singleHeader(request: HeaderSource, name: string): string | undefined | null {
	if (Array.isArray(request.rawHeaders)) {
		let lines = 0;
		for (let index = 0; index < request.rawHeaders.length; index += 2) {
			if (request.rawHeaders[index]?.toLowerCase() === name) lines += 1;
		}
		if (lines > 1) return null;
	}
	const value = request.headers[name];
	if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
	return value;
}

/**
 * The caller's role on the graph as the gateway minted it, on the internal-service path only; absent otherwise. An
 * unreadable value (not exactly `owner`, `editor` or `viewer`, or sent twice) is the caller's 400 `graph_role_invalid`.
 */
export function gatewayGraphRoleOf(
	request: HeaderSource,
	authContext: HostedAuthContext | undefined,
): WorkspaceChatRole | undefined {
	if (authContext?.method !== "internal_service") return undefined;
	const value = singleHeader(request, GATEWAY_GRAPH_ROLE_HEADER);
	if (value === null) {
		throw new InvocationFault("graph_role_invalid", "the caller's graph role was sent more than once", 400);
	}
	return parseGatewayGraphRole(value);
}

/**
 * The graph the gateway addressed this request through, on the internal-service path only: `x-graph-id`, and
 * `x-graph-owner` or, on the legacy route that names no owner, the caller's own principal (as the gateway binds an
 * invocation there). Undefined when the request names no graph (an in-host service, a direct caller). A repeated or
 * empty graph header is the caller's 400 `graph_binding_invalid`.
 */
export function gatewayGraphAddressOf(
	request: HeaderSource,
	authContext: HostedAuthContext | undefined,
): GatewayGraphAddress | undefined {
	if (authContext?.method !== "internal_service") return undefined;
	const graphId = singleHeader(request, GATEWAY_GRAPH_ID_HEADER);
	const owner = singleHeader(request, GATEWAY_GRAPH_OWNER_HEADER);
	if (graphId === null || owner === null) {
		throw new InvocationFault("graph_binding_invalid", "the request's graph was named more than once", 400);
	}
	if (graphId === undefined) {
		if (owner !== undefined) {
			throw new InvocationFault("graph_binding_invalid", "the request names a graph owner but no graph", 400);
		}
		return undefined;
	}
	if (!graphId.trim() || (owner !== undefined && !owner.trim())) {
		throw new InvocationFault("graph_binding_invalid", "the request's graph headers are empty", 400);
	}
	const caller = authContext.userId.startsWith("user:") ? authContext.userId : `user:${authContext.userId}`;
	return { graphId: graphId.trim(), graphOwnerPrincipal: owner?.trim() ?? caller };
}

/**
 * The facts a session-addressed or invocation route needs from the gateway, together: the minted role and the graph it
 * was minted for. A role that names no graph is unreadable (the gateway always sends both), so a role can never be
 * applied to a graph nobody checked.
 */
export function gatewayRequestFacts(
	request: HeaderSource,
	authContext: HostedAuthContext | undefined,
): { readonly role?: WorkspaceChatRole; readonly address?: GatewayGraphAddress } {
	const role = gatewayGraphRoleOf(request, authContext);
	const address = gatewayGraphAddressOf(request, authContext);
	if (role !== undefined && address === undefined) {
		throw new InvocationFault(
			"graph_role_invalid",
			"a minted graph role must name the graph it was minted for (x-graph-id)",
			400,
		);
	}
	return { ...(role !== undefined ? { role } : {}), ...(address ? { address } : {}) };
}

/** A session lives on exactly one graph; a request addressed through another graph does not reach it. */
export function sessionIsOnGraph(
	session: { readonly graph_id: string; readonly graph_owner_principal: string },
	address: GatewayGraphAddress,
): boolean {
	return session.graph_id === address.graphId && session.graph_owner_principal === address.graphOwnerPrincipal;
}
