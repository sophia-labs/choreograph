import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { isDestructive } from "./acp/destructive.js";
import { requiredScopesFromToolMeta } from "./agent-runtime/agent-mode.js";
import type { HostedAuthContext } from "./auth.js";
import { requireCanonicalGraphOwnerPrincipal } from "./graph-owner-principal.js";
import {
	hostedSessionFallbacksTotal,
	hostedSessionOperationDurationSeconds,
	hostedSessionOperationsTotal,
} from "./metrics.js";

export interface HostedSessionCapabilities {
	reads: boolean;
	writes: boolean;
	dangerous_ops: boolean;
}

// ─── CapabilityBackend ───────────────────────────────────────────────────
//
// The orchestrator-side abstraction for a named capability (e.g. "mnemosyne",
// "subject.web").  handleGateCall() looks up msg.capability in the registry
// and dispatches — no special-casing beyond the lookup.

export interface CapabilityBackend {
	/** Canonical name (must match the key in the registry Map). */
	readonly capabilityName: string;
	/** Declared access level. Enforcement is the backend's own responsibility
	 *  (each backend knows its tools' semantics — see wrapMnemosyneProxy); the
	 *  generic gate dispatch does not consult this field. */
	readonly accessLevel: "ro" | "rw";
	/** Call a tool within this capability. */
	callTool(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
	/** Return available tool descriptors for this capability. */
	listTools(): Promise<readonly HostedMcpToolDescriptor[]>;
	/** Release resources (sessions, connections, browser contexts, …). */
	close(): Promise<void>;
}

/**
 * The Mnemosyne tools a read-only session (`capabilities.writes === false`) may
 * call. DENY-BY-DEFAULT: any tool absent from this set is rejected at the gate
 * and filtered out of the advertised surface, so a tool added to the hosted MCP
 * tomorrow is excluded until deliberately allowlisted here. This is the
 * load-bearing lock for pointing an experimental agent at a real graph:
 * platform-side `writes: false` gates CRDT document writes and graph jobs but
 * NOT the Geist/graph-mutation routes (remember, sing, value, create_wires), so
 * the host-side gate cannot rely on the server to refuse them.
 *
 * `recall` and `music` are pure reads (it is `care()` that bumps a memory's
 * last_active, not recall). `context_bundle` is admitted only because the
 * read-only wrapper below forcibly disables its optional home-graph write;
 * sandbox input can never restore that authority.
 */
export const READ_ONLY_MNEMOSYNE_TOOLS: ReadonlySet<string> = new Set([
	// document reads
	"list_documents",
	"read_document",
	"read_blocks",
	"read_document_at_snapshot",
	"query_blocks",
	"get_block",
	"check_document",
	"get_document_history",
	// search
	"search_documents",
	"search_blocks",
	"semantic_search",
	"sparql_query",
	// orientation
	"quick_orient",
	"context_bundle",
	"get_workspace",
	"get_user_location",
	"list_graphs",
	// wires (read)
	"get_wires",
	"traverse_wires",
	"list_wire_predicates",
	// valuation (read)
	"get_important_blocks",
	"get_block_values",
	"get_values",
	"document_digest",
	// Geist (read)
	"music",
	"recall",
	// artifacts (read): bytes or strict text, and the revision list; never a write
	"read_artifact",
	"list_artifact_revisions",
	// chat surface: resolves document titles for action references; reads only
	"surface",
]);

/**
 * Wrap a HostedMnemosyneProxy as the "mnemosyne" CapabilityBackend.
 *
 * The proxy already implements callTool / listTools / close; the
 * append_to_document→insert_blocks alias stays inside the proxy's callTool().
 *
 * When the session's declared capabilities disable writes, THIS WRAPPER is the
 * enforcement point (host-side, outside the sandbox — every worker Mnemosyne
 * call is a gate_call that lands here): `listTools` advertises only the
 * read-only allowlist and `callTool` rejects anything outside it. The check
 * runs on the REQUESTED tool name, before alias resolution, so the curated
 * surface's `append_to_document` is rejected as itself rather than sneaking
 * through as insert_blocks.
 */
export function wrapMnemosyneProxy(
	proxy: HostedMnemosyneProxy,
	capabilities: HostedSessionCapabilities,
): CapabilityBackend {
	const readOnly = !capabilities.writes;
	return {
		capabilityName: "mnemosyne",
		accessLevel: readOnly ? "ro" : "rw",
		callTool: (tool, args, signal) => {
			if (readOnly && !READ_ONLY_MNEMOSYNE_TOOLS.has(tool)) {
				return Promise.reject(
					new Error(
						`Read-only Mnemosyne session: tool "${tool}" is not permitted (writes are disabled for this session).`,
					),
				);
			}
			const readOnlyArgs =
				readOnly && tool === "context_bundle" ? { ...args, set_home: false, setHome: false } : args;
			return proxy.callTool(tool, readOnlyArgs, signal);
		},
		listTools: async () => {
			const tools = await proxy.listTools();
			return readOnly ? tools.filter((tool) => READ_ONLY_MNEMOSYNE_TOOLS.has(tool.name)) : tools;
		},
		close: () => proxy.close(),
	};
}

/**
 * Gateway service-auth (platform-next cells cloud). When set, the proxy talks
 * straight to the gateway's per-graph MCP route with a shared service token and
 * asserts the acting end-user via `x-pn-on-behalf-of` — SKIPPING the legacy
 * `/api/agent/session` mint entirely. The gateway authenticates the service
 * token (its `PN_SERVICE_TOKEN`) and runs its own per-graph ACL on `onBehalfOf`.
 */
export interface HostedServiceAuthConfig {
	/** Shared secret the gateway accepts as `PN_SERVICE_TOKEN`. */
	serviceToken: string;
	/** Gateway base URL (e.g. `https://api.garden.example.invalid`). The per-graph
	 *  MCP endpoint is derived as `{base}/g/{graphId}/mcp`. */
	gatewayBaseUrl: string;
	/** Cognito `sub` of the acting end-user, sent as `x-pn-on-behalf-of`. */
	onBehalfOf: string;
}

/**
 * Direct MCP auth for local-native development against Garden's loopback server.
 * The bearer comes from Garden's loopback manifest and already authorizes the
 * MCP endpoint, so no legacy `/api/agent/session` mint is involved.
 */
export interface HostedDirectMcpConfig {
	mcpUrl: string;
	accessToken: string;
	userId?: string;
}

export interface HostedMnemosyneProxyOptions {
	apiBaseUrl: string;
	/** Stable typed owner for a cloud-2 graph (`user:<subject>`). */
	ownerPrincipal?: string;
	graphId: string;
	toolProfile: "chat" | "familiar" | "full";
	runtime?: string;
	label?: string;
	requestTimeoutMs?: number;
	authContext?: HostedAuthContext;
	apiToken?: string;
	allowGlobalTokenFallback?: boolean;
	requiredTools?: readonly string[];
	capabilities?: HostedSessionCapabilities;
	source?: string;
	preferredMcpUrl?: string;
	fetchFn?: typeof fetch;
	clientFactory?: HostedMcpClientFactory;
	/** When set, bypass the legacy session mint and talk straight to the gateway
	 *  per-graph MCP route with service-token + on-behalf-of auth. */
	serviceAuth?: HostedServiceAuthConfig;
	/** When set, bypass the legacy session mint and talk straight to an MCP URL
	 *  with a pre-minted bearer token (Garden local loopback). */
	directMcp?: HostedDirectMcpConfig;
}

interface HostedAgentSessionGraphScope {
	mode: "all_user_graphs" | "allowlist";
	default_graph_id?: string;
	allowed_graph_ids?: string[];
}

interface HostedAgentSessionResponse {
	session_id: string;
	user_id?: string;
	runtime?: string;
	label?: string;
	tool_profile?: string;
	graph_scope?: HostedAgentSessionGraphScope;
	capabilities?: HostedSessionCapabilities;
	metadata?: Record<string, unknown>;
	mcp_url?: string;
	access_token: string;
	refresh_token: string;
	access_expires_at: string;
	idle_expires_at: string;
	absolute_expires_at: string;
}

interface HostedAgentSessionStatusResponse {
	session_id: string;
	status: "active" | "revoked" | "expired";
	revoked: boolean;
	user_id: string;
	runtime: string;
	label?: string;
	tool_profile: string;
	graph_scope: HostedAgentSessionGraphScope;
	last_activity_at: string;
	idle_expires_at: string;
	absolute_expires_at: string;
	capabilities: HostedSessionCapabilities;
	metadata?: Record<string, unknown>;
	mcp_url: string;
}

interface HostedMnemosyneSession {
	sessionId: string;
	userId?: string;
	accessToken: string;
	refreshToken: string;
	accessExpiresAt: number;
	idleExpiresAt: number;
	absoluteExpiresAt: number;
	mcpUrl: string;
	lastHeartbeatAt: number;
}

export interface HostedMcpToolDescriptor {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
	/** Trusted host classification consumed by the sandbox permission membrane. */
	destructive: boolean;
	/**
	 * gardend's `_meta["sophia.local.requiredScopes"]` from tools/list, when the
	 * cell advertises it. Drives the mode read ceiling (absent ⇒ write class).
	 */
	requiredScopes?: readonly string[];
}

interface HostedMcpClient {
	listTools(timeoutMs: number): Promise<readonly HostedMcpToolDescriptor[]>;
	callTool(
		name: string,
		arguments_: Record<string, unknown>,
		signal: AbortSignal | undefined,
		timeoutMs: number,
	): Promise<unknown>;
	close(): Promise<void>;
}

export interface HostedMcpClientFactoryOptions {
	mcpUrl: string;
	accessToken: string;
	userId?: string;
	timeoutMs: number;
	/** Gateway service-auth: when set, `accessToken` is the service token and the
	 *  acting end-user is sent as `x-pn-on-behalf-of` (no `X-User-ID`). */
	onBehalfOf?: string;
}

export type HostedMcpClientFactory = (options: HostedMcpClientFactoryOptions) => Promise<HostedMcpClient>;

interface HostedToolAlias {
	hostedName: string;
	mapArguments?: (arguments_: Record<string, unknown>) => Record<string, unknown>;
}

const HOSTED_TOOL_ALIASES: Record<string, HostedToolAlias> = {
	append_to_document: {
		hostedName: "insert_blocks",
		mapArguments: (arguments_) => {
			const { text, ...rest } = arguments_;
			return {
				...rest,
				content: rest.content ?? text,
			};
		},
	},
};

const ACCESS_REFRESH_SKEW_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const SERVICE_MCP_STARTUP_ATTEMPTS = 2;
const tracer = trace.getTracer("sandbox-mgmt.mnemosyne");

export class HostedMnemosyneProxy {
	private readonly apiBaseUrl: string;
	private readonly ownerPrincipal?: string;
	private readonly graphId: string;
	private readonly toolProfile: HostedMnemosyneProxyOptions["toolProfile"];
	private readonly runtime: string;
	private readonly label?: string;
	private readonly requestTimeoutMs: number;
	private readonly authContext?: HostedAuthContext;
	private readonly apiToken?: string;
	private readonly allowGlobalTokenFallback: boolean;
	private readonly requiredTools: readonly string[];
	private readonly capabilities: HostedSessionCapabilities;
	private readonly source: string;
	private readonly preferredMcpUrl?: string;
	private readonly fetchFn: typeof fetch;
	private readonly clientFactory: HostedMcpClientFactory;
	private readonly serviceAuth?: HostedServiceAuthConfig;
	private readonly directMcp?: HostedDirectMcpConfig;

	private session: HostedMnemosyneSession | undefined;
	private client: HostedMcpClient | undefined;
	private clientAccessToken: string | undefined;
	private availableToolNames: readonly string[] = [];
	private availableToolDescriptors: readonly HostedMcpToolDescriptor[] = [];
	private serviceBinding: Promise<void> | undefined;

	constructor(options: HostedMnemosyneProxyOptions) {
		this.apiBaseUrl = trimTrailingSlash(options.apiBaseUrl);
		this.ownerPrincipal = options.ownerPrincipal?.trim();
		this.graphId = options.graphId;
		this.toolProfile = options.toolProfile;
		this.runtime = options.runtime ?? "choreograph";
		this.label = options.label;
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.authContext = options.authContext;
		this.apiToken = options.apiToken;
		this.allowGlobalTokenFallback = options.allowGlobalTokenFallback ?? false;
		this.requiredTools = options.requiredTools ?? [];
		this.capabilities = options.capabilities ?? {
			reads: true,
			writes: true,
			dangerous_ops: false,
		};
		this.source = options.source ?? "choreograph-spike";
		this.preferredMcpUrl = options.preferredMcpUrl;
		this.fetchFn = options.fetchFn ?? fetch;
		this.clientFactory = options.clientFactory ?? defaultHostedMcpClientFactory;
		this.serviceAuth = options.serviceAuth;
		this.directMcp = options.directMcp;
	}

	async start(): Promise<{ expiresAt: string; userId?: string }> {
		// Cloud activation is infrastructure readiness, not agent execution. The
		// spawner awaits start() before it launches the worker/starts its run clock,
		// and start() proves discovery + readiness + tool discovery here.
		if (this.serviceAuth) await this.ensureClient();
		const session = await this.ensureFreshSession();
		return {
			expiresAt: new Date(session.accessExpiresAt).toISOString(),
			userId: session.userId,
		};
	}

	async callTool(name: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		return this.withSingleRefreshRetry(async () => {
			const client = await this.ensureClient();
			const boundArguments = this.serviceAuth
				? stripCallerGraphBinding(arguments_)
				: bindCanonicalGraph(this.graphId, arguments_, this.directMcp ? "garden" : "legacy");
			const call = resolveHostedToolCall(name, boundArguments, this.availableToolNames);
			const callArguments = this.serviceAuth
				? bindSnakeOnlyGraphSelector(this.graphId, this.availableToolDescriptors, call.name, call.arguments_)
				: call.arguments_;
			return client.callTool(call.name, callArguments, signal, this.requestTimeoutMs);
		});
	}

	/**
	 * The cell's tools as a caller may use them: the graph selector is the host's (every call is bound to this proxy's
	 * graph and a caller's selector is discarded), so it is advertised in no schema. The cell's own schemas stay in
	 * `availableToolDescriptors` for the host's binding (`bindSnakeOnlyGraphSelector`).
	 */
	async listTools(): Promise<readonly HostedMcpToolDescriptor[]> {
		await this.ensureClient();
		return this.availableToolDescriptors.map(withHostBoundGraph);
	}

	async close(): Promise<void> {
		await this.closeClient();

		// Service-auth and direct-MCP sessions are synthetic (no legacy mint) —
		// nothing to revoke on the legacy control plane.
		if (this.serviceAuth || this.directMcp) {
			this.session = undefined;
			this.serviceBinding = undefined;
			return;
		}

		const session = this.session;
		this.session = undefined;
		if (!session) {
			return;
		}

		const revokeStart = performance.now();
		try {
			await this.fetchResponse(new URL("/api/agent/session/me/revoke", this.apiBaseUrl), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${session.accessToken}`,
				},
			});
			recordHostedSessionOperation("revoke", "ok", revokeStart);
			return;
		} catch (error) {
			recordHostedSessionOperation("revoke", "error", revokeStart);
			if (!this.canUseControlPlaneFallback()) {
				return;
			}
			hostedSessionFallbacksTotal.add(1, {
				operation: "revoke",
				fallback: "control_plane_revoke",
			});
			const fallbackStart = performance.now();
			try {
				await this.fetchResponse(new URL(`/api/agent/session/${session.sessionId}/revoke`, this.apiBaseUrl), {
					method: "POST",
					headers: this.buildControlPlaneHeaders(),
				});
				recordHostedSessionOperation("revoke_fallback", "ok", fallbackStart);
			} catch {
				recordHostedSessionOperation("revoke_fallback", "error", fallbackStart);
			}
			if (error instanceof Error) {
				return;
			}
		}
	}

	private async withSingleRefreshRetry<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (!isUnauthorizedError(error)) {
				throw error;
			}
			if (this.serviceAuth || this.directMcp) {
				await this.closeClient();
				throw error;
			}
			await this.refreshSession();
			await this.closeClient();
			return operation();
		}
	}

	private async ensureFreshSession(): Promise<HostedMnemosyneSession> {
		// Gateway service-auth: no legacy mint/refresh/heartbeat — synthesize a
		// static session pointed at the gateway's per-graph MCP route. The service
		// token is the bearer; the gateway authorizes `onBehalfOf` via its own ACL.
		if (this.serviceAuth) {
			await this.ensureServiceBinding(this.serviceAuth);
			this.session ??= this.buildServiceSession(this.serviceAuth);
			return this.session;
		}
		if (this.directMcp) {
			this.session ??= this.buildDirectMcpSession(this.directMcp);
			return this.session;
		}
		if (!this.session) {
			this.session = await this.createSession();
			return this.session;
		}

		if (Date.now() >= this.session.accessExpiresAt - ACCESS_REFRESH_SKEW_MS) {
			await this.refreshSession();
			return this.session!;
		}

		if (Date.now() >= this.session.lastHeartbeatAt + HEARTBEAT_INTERVAL_MS) {
			await this.heartbeatSession();
		}

		return this.session;
	}

	private async ensureServiceBinding(serviceAuth: HostedServiceAuthConfig): Promise<void> {
		const binding = this.serviceBinding ?? this.ensureServiceGraphReady(serviceAuth);
		this.serviceBinding = binding;
		try {
			await binding;
		} catch (error) {
			// A transient activation failure must not poison this proxy forever. A
			// later safe initialization attempt may establish a fresh binding.
			if (this.serviceBinding === binding) this.serviceBinding = undefined;
			throw error;
		}
	}

	private buildServiceSession(serviceAuth: HostedServiceAuthConfig): HostedMnemosyneSession {
		// Far-future expiries so the access-refresh / heartbeat / idle paths in
		// ensureFreshSession are never taken; the gateway, not a minted session,
		// is the authority and validates the service token on every request.
		const farFuture = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
		const base = trimTrailingSlash(serviceAuth.gatewayBaseUrl);
		const owner = this.boundOwner(serviceAuth);
		return {
			sessionId: `service:${this.graphId}`,
			userId: serviceAuth.onBehalfOf,
			accessToken: serviceAuth.serviceToken,
			refreshToken: "",
			accessExpiresAt: farFuture,
			idleExpiresAt: farFuture,
			absoluteExpiresAt: farFuture,
			mcpUrl: `${base}/o/${encodeURIComponent(owner)}/g/${encodeURIComponent(this.graphId)}/mcp`,
			lastHeartbeatAt: Date.now(),
		};
	}

	private boundOwner(serviceAuth: HostedServiceAuthConfig): string {
		const owner = this.ownerPrincipal || `user:${serviceAuth.onBehalfOf}`;
		return requireCanonicalGraphOwnerPrincipal(owner, "typed graph owner");
	}

	private serviceHeaders(serviceAuth: HostedServiceAuthConfig, jsonBody = false): Record<string, string> {
		return {
			Authorization: `Bearer ${serviceAuth.serviceToken}`,
			"x-pn-on-behalf-of": serviceAuth.onBehalfOf,
			...(jsonBody ? { "content-type": "application/json" } : {}),
		};
	}

	private async ensureServiceGraphReady(serviceAuth: HostedServiceAuthConfig): Promise<void> {
		const base = trimTrailingSlash(serviceAuth.gatewayBaseUrl);
		const owner = this.boundOwner(serviceAuth);
		const controlResponse = await this.fetchResponse(new URL("/control/mcp", base), {
			method: "POST",
			headers: this.serviceHeaders(serviceAuth, true),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: `discover:${this.graphId}`,
				method: "tools/call",
				params: { name: "list_graphs", arguments: {} },
			}),
		});
		const control = (await controlResponse.json()) as {
			result?: { structuredContent?: Array<{ owner?: string; graphId?: string }> };
			error?: { message?: string };
		};
		if (control.error) {
			throw new Error(`control list_graphs failed: ${control.error.message ?? "unknown error"}`);
		}
		const visible = control.result?.structuredContent ?? [];
		if (!visible.some((graph) => graph.owner === owner && graph.graphId === this.graphId)) {
			throw new Error(`graph (${owner}, ${this.graphId}) is not in this identity's list_graphs`);
		}

		const graphBase = `/o/${encodeURIComponent(owner)}/g/${encodeURIComponent(this.graphId)}`;
		const activation = await this.fetchResponse(new URL(`${graphBase}/activate`, base), {
			method: "POST",
			headers: this.serviceHeaders(serviceAuth),
		});
		if (activation.status !== 202) return;
		const accepted = (await activation.json()) as { pollUrl?: string };
		if (!accepted.pollUrl) throw new Error("graph activation omitted pollUrl");
		const pollUrl = new URL(accepted.pollUrl, `${base}/`);
		const deadline = Date.now() + 300_000;
		for (;;) {
			const response = await this.fetchResponse(pollUrl, {
				method: "GET",
				headers: this.serviceHeaders(serviceAuth),
			});
			const status = (await response.json()) as { phase?: string; error?: string };
			if (status.phase === "ready") return;
			if (status.phase === "failed") {
				throw new Error(`graph activation failed: ${status.error ?? "unknown error"}`);
			}
			if (Date.now() >= deadline) throw new Error("timed out waiting for graph tool readiness");
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	}

	private buildDirectMcpSession(directMcp: HostedDirectMcpConfig): HostedMnemosyneSession {
		const farFuture = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
		return {
			sessionId: `direct-mcp:${this.graphId}`,
			userId: directMcp.userId,
			accessToken: directMcp.accessToken,
			refreshToken: "",
			accessExpiresAt: farFuture,
			idleExpiresAt: farFuture,
			absoluteExpiresAt: farFuture,
			mcpUrl: directMcp.mcpUrl,
			lastHeartbeatAt: Date.now(),
		};
	}

	private async createSession(): Promise<HostedMnemosyneSession> {
		return tracer.startActiveSpan("hosted_session.create", async (span) => {
			const start = performance.now();
			span.setAttributes({
				"mnemosyne.graph_id": this.graphId,
				"mnemosyne.tool_profile": this.toolProfile,
				"mnemosyne.auth_method": this.authContext?.method ?? "fallback",
			});

			try {
				const response = await this.fetchJson<HostedAgentSessionResponse>(
					new URL("/api/agent/session", this.apiBaseUrl),
					{
						method: "POST",
						headers: {
							...this.buildControlPlaneHeaders(),
							"content-type": "application/json",
						},
						body: JSON.stringify({
							runtime: this.runtime,
							label: this.label,
							tool_profile: this.toolProfile,
							graph_scope: {
								mode: "allowlist",
								default_graph_id: this.graphId,
								allowed_graph_ids: [this.graphId],
							},
							capabilities: this.capabilities,
							metadata: {
								graph_id: this.graphId,
								source: this.source,
								auth_method: this.authContext?.method ?? "global_token_fallback",
							},
						}),
					},
				);
				const session = normalizeSession(response, this.preferredMcpUrl);
				span.setAttributes({
					"mnemosyne.session_id": session.sessionId,
					"mnemosyne.user_id": session.userId ?? "unknown",
					"mnemosyne.mcp_url": session.mcpUrl,
				});
				recordHostedSessionOperation("create", "ok", start);
				span.end();
				return session;
			} catch (error) {
				recordHostedSessionOperation("create", "error", start);
				span.recordException(error as Error);
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: error instanceof Error ? error.message : String(error),
				});
				span.end();
				throw error;
			}
		});
	}

	private async refreshSession(): Promise<void> {
		if (!this.session) {
			this.session = await this.createSession();
			return;
		}

		const start = performance.now();
		try {
			const response = await this.fetchJson<HostedAgentSessionResponse>(
				new URL("/api/agent/session/refresh", this.apiBaseUrl),
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
					},
					body: JSON.stringify({ refresh_token: this.session.refreshToken }),
				},
			);
			this.session = normalizeSession(response, this.session.mcpUrl);
			recordHostedSessionOperation("refresh", "ok", start);
		} catch (error) {
			recordHostedSessionOperation("refresh", "error", start);
			throw error;
		}
	}

	private async heartbeatSession(): Promise<void> {
		if (!this.session) {
			return;
		}

		const start = performance.now();
		try {
			const response = await this.fetchJson<HostedAgentSessionStatusResponse>(
				new URL("/api/agent/session/me/heartbeat", this.apiBaseUrl),
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.session.accessToken}`,
					},
				},
			);
			this.session.idleExpiresAt = Date.parse(response.idle_expires_at);
			this.session.absoluteExpiresAt = Date.parse(response.absolute_expires_at);
			this.session.lastHeartbeatAt = Date.now();
			recordHostedSessionOperation("heartbeat", "ok", start);
		} catch (error) {
			recordHostedSessionOperation("heartbeat", "error", start);
			throw error;
		}
	}

	private async ensureClient(): Promise<HostedMcpClient> {
		let session = await this.ensureFreshSession();
		if (this.client && this.clientAccessToken === session.accessToken) {
			return this.client;
		}

		await this.closeClient();
		const attempts = this.serviceAuth ? SERVICE_MCP_STARTUP_ATTEMPTS : 1;
		for (let attempt = 1; attempt <= attempts; attempt += 1) {
			let client: HostedMcpClient | undefined;
			try {
				client = await this.clientFactory({
					mcpUrl: session.mcpUrl,
					accessToken: session.accessToken,
					userId: session.userId,
					timeoutMs: this.requestTimeoutMs,
					onBehalfOf: this.serviceAuth?.onBehalfOf,
				});

				const tools = await client.listTools(this.requestTimeoutMs);
				const names = tools.map((tool) => tool.name);
				if (this.requiredTools.length > 0) {
					const missing = this.requiredTools.filter((tool) => !isHostedToolSatisfied(tool, names));
					if (missing.length > 0) {
						throw new Error(`Hosted Mnemosyne MCP is missing required tools: ${missing.join(", ")}`);
					}
				}

				this.availableToolNames = names;
				this.availableToolDescriptors = tools;
				this.client = client;
				this.clientAccessToken = session.accessToken;
				return client;
			} catch (error) {
				await client?.close().catch(() => {});
				if (!this.serviceAuth || attempt >= attempts || !isRetryableServiceMcpStartupError(error)) {
					throw error;
				}
				hostedSessionFallbacksTotal.add(1, {
					operation: "client_start",
					fallback: "service_graph_reactivate",
				});
				// Tool discovery occurs before any agent action, so this retry cannot
				// duplicate a graph mutation. Re-run activation to close the narrow
				// Ready→idle-exit race, then create an entirely fresh MCP transport.
				this.serviceBinding = undefined;
				session = await this.ensureFreshSession();
			}
		}
		throw new Error("unreachable MCP client initialization state");
	}

	private async closeClient(): Promise<void> {
		const client = this.client;
		this.client = undefined;
		this.clientAccessToken = undefined;
		this.availableToolNames = [];
		this.availableToolDescriptors = [];

		if (client) {
			await client.close().catch(() => {});
		}
	}

	private buildControlPlaneHeaders(): Record<string, string> {
		// Transcript-safety: when env-provided prod egress credentials exist, prefer
		// them over echoing the INBOUND auth material outbound. The inbound secret is
		// whatever the caller typed into a request header (e.g. the dev secret in a
		// curl); the outbound credentials for a real control plane must come from the
		// deployment environment, installed out-of-band, never from a request.
		// Platform-1 prod additionally requires a Cognito ID token and REJECTS the
		// X-Internal-Service + X-User-ID combo (it derives the user from the token's
		// `sub`), so the env-credentialed branch sends secret + Bearer and drops
		// X-User-ID. Both vars unset (prod itself, plain dev) ⇒ behavior unchanged.
		const prodServiceSecret = process.env.MNEMOSYNE_PROD_SERVICE_SECRET?.trim();
		const prodIdToken = process.env.MNEMOSYNE_PROD_ID_TOKEN?.trim();

		if (this.authContext?.method === "internal_service") {
			if (prodServiceSecret && prodIdToken) {
				return {
					"X-Internal-Service": prodServiceSecret,
					Authorization: `Bearer ${prodIdToken}`,
				};
			}
			return {
				"X-Internal-Service": this.authContext.internalServiceSecret,
				"X-User-ID": this.authContext.userId,
			};
		}

		if (this.authContext?.method === "delegated_bearer") {
			return {
				Authorization: `Bearer ${prodIdToken || this.authContext.bearerToken}`,
			};
		}

		if (this.allowGlobalTokenFallback && this.apiToken) {
			hostedSessionFallbacksTotal.add(1, {
				operation: "create",
				fallback: "global_api_token",
			});
			return {
				Authorization: `Bearer ${this.apiToken}`,
			};
		}

		throw new Error("Hosted Mnemosyne proxy requires a request-scoped bearer or internal-service auth context");
	}

	private canUseControlPlaneFallback(): boolean {
		return Boolean(this.authContext || (this.allowGlobalTokenFallback && this.apiToken));
	}

	private async fetchResponse(url: URL, init: RequestInit): Promise<Response> {
		const controller = new AbortController();
		const timeout = setTimeout(() => {
			controller.abort();
		}, this.requestTimeoutMs);

		try {
			const response = await this.fetchFn(url, {
				...init,
				signal: controller.signal,
			});
			if (!response.ok) {
				const body = await response.text().catch(() => "");
				throw new Error(
					`${init.method ?? "GET"} ${url} failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`,
				);
			}
			return response;
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(`${init.method ?? "GET"} ${url} timed out after ${this.requestTimeoutMs}ms`);
			}
			throw error;
		} finally {
			clearTimeout(timeout);
		}
	}

	private async fetchJson<T>(url: URL, init: RequestInit): Promise<T> {
		const response = await this.fetchResponse(url, init);
		if (response.status === 204) {
			return undefined as T;
		}

		const body = await response.text();
		if (!body) {
			return undefined as T;
		}

		return JSON.parse(body) as T;
	}
}

function normalizeSession(
	response: HostedAgentSessionResponse,
	preferredMcpUrl: string | undefined,
): HostedMnemosyneSession {
	// Local override takes precedence over the platform's response so a
	// dev can split API and MCP onto different ports (e.g. when the local
	// k8s lacks the production ingress that fronts both behind one host).
	// Set MNEMOSYNE_MCP_URL to force a specific MCP endpoint.
	const explicitOverride = process.env.MNEMOSYNE_MCP_URL?.trim();
	const mcpUrl = (explicitOverride || response.mcp_url || preferredMcpUrl || "").trim();
	if (!mcpUrl) {
		throw new Error("Hosted session response did not include mcp_url");
	}

	return {
		sessionId: response.session_id,
		userId: response.user_id,
		accessToken: response.access_token,
		refreshToken: response.refresh_token,
		accessExpiresAt: Date.parse(response.access_expires_at),
		idleExpiresAt: Date.parse(response.idle_expires_at),
		absoluteExpiresAt: Date.parse(response.absolute_expires_at),
		mcpUrl,
		lastHeartbeatAt: Date.now(),
	};
}

function isUnauthorizedError(error: unknown): boolean {
	if (error instanceof StreamableHTTPError) {
		return error.code === 401 || error.code === 403;
	}
	if (!(error instanceof Error)) {
		return false;
	}
	return /\b401\b|\b403\b|unauthor/i.test(error.message);
}

function isRetryableServiceMcpStartupError(error: unknown): boolean {
	if (error instanceof StreamableHTTPError) {
		return typeof error.code === "number" && [202, 408, 425, 429, 502, 503, 504].includes(error.code);
	}
	if (!(error instanceof Error)) return false;
	const structured = error as Error & { code?: unknown; data?: { timeout?: unknown } };
	if (structured.code === -32001 && typeof structured.data?.timeout === "number") return true;
	return /request timed out|timed out after|graph_activating|\b(?:202|408|425|429|502|503|504)\b/i.test(error.message);
}

function trimTrailingSlash(value: string): string {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * Resolve gateway service-auth from the environment, or `undefined` when it is
 * not enabled (the proxy then falls back to the legacy `/api/agent/session`
 * mint). Enabled when BOTH `MNEMOSYNE_SERVICE_TOKEN` and
 * `MNEMOSYNE_GATEWAY_BASE_URL` are set. Throws when enabled but no acting user
 * is available — a trusted backend must always name the user it acts for.
 */
export function resolveGatewayServiceAuth(onBehalfOf: string | undefined): HostedServiceAuthConfig | undefined {
	const serviceToken = process.env.MNEMOSYNE_SERVICE_TOKEN?.trim();
	const gatewayBaseUrl = process.env.MNEMOSYNE_GATEWAY_BASE_URL?.trim();
	if (!serviceToken || !gatewayBaseUrl) {
		return undefined;
	}
	const actingUser = onBehalfOf?.trim();
	if (!actingUser) {
		throw new Error(
			"gateway service-auth is configured (MNEMOSYNE_SERVICE_TOKEN + MNEMOSYNE_GATEWAY_BASE_URL) " +
				"but no acting user is available for x-pn-on-behalf-of",
		);
	}
	return { serviceToken, gatewayBaseUrl, onBehalfOf: actingUser };
}

/**
 * Resolve direct local MCP auth from the environment. This is for Garden's
 * desktop loopback manifest:
 *
 *   MNEMOSYNE_MCP_URL=http://127.0.0.1:<port>/mcp
 *   MNEMOSYNE_MCP_ACCESS_TOKEN=<manifest token>
 *
 * `MNEMOSYNE_MCP_BEARER_TOKEN` is accepted as a compatibility alias.
 */
export function resolveDirectMcpAuth(userId: string | undefined): HostedDirectMcpConfig | undefined {
	const mcpUrl = process.env.MNEMOSYNE_MCP_URL?.trim();
	// A self-host operator may hand Choreograph a token of its own (`gardend token create`, set in the service manifest):
	// the member token gardend mints for a supervised service cannot load or update RDF, and a run's provenance and a
	// graph plan's testimony are RDF writes. gardend reserves the MNEMOSYNE_ names, hence a CHOREOGRAPH_ one.
	const accessToken =
		process.env.CHOREOGRAPH_MCP_ACCESS_TOKEN?.trim() ||
		process.env.MNEMOSYNE_MCP_ACCESS_TOKEN?.trim() ||
		process.env.MNEMOSYNE_MCP_BEARER_TOKEN?.trim();
	if (!mcpUrl && !accessToken) {
		return undefined;
	}
	if (!mcpUrl || !accessToken) {
		throw new Error(
			"direct MCP auth requires both MNEMOSYNE_MCP_URL and MNEMOSYNE_MCP_ACCESS_TOKEN " +
				"(or MNEMOSYNE_MCP_BEARER_TOKEN)",
		);
	}
	const actingUser = userId?.trim();
	return {
		mcpUrl,
		accessToken,
		userId: actingUser || undefined,
	};
}

/**
 * True when gateway service-auth is configured (both env vars present), without
 * requiring an acting user. Use this to gate OUT legacy hosted-mint code paths
 * (e.g. the sandbox-creation preflight) that would otherwise dial the legacy
 * control plane (`MNEMOSYNE_API_BASE_URL`) even though the real path uses the
 * gateway. In service-auth mode the gateway enforces per-graph ACL on every MCP
 * call, so a separate mint/preflight is both redundant and a dead dependency.
 */
export function isGatewayServiceAuthConfigured(): boolean {
	return Boolean(process.env.MNEMOSYNE_SERVICE_TOKEN?.trim() && process.env.MNEMOSYNE_GATEWAY_BASE_URL?.trim());
}

export function isDirectMcpAuthConfigured(): boolean {
	return Boolean(
		process.env.MNEMOSYNE_MCP_URL?.trim() &&
			(process.env.MNEMOSYNE_MCP_ACCESS_TOKEN?.trim() || process.env.MNEMOSYNE_MCP_BEARER_TOKEN?.trim()),
	);
}

function isHostedToolSatisfied(toolName: string, names: readonly string[]): boolean {
	if (names.includes(toolName)) {
		return true;
	}
	const alias = HOSTED_TOOL_ALIASES[toolName];
	return alias ? names.includes(alias.hostedName) : false;
}

function resolveHostedToolCall(
	toolName: string,
	arguments_: Record<string, unknown>,
	availableToolNames: readonly string[],
): { name: string; arguments_: Record<string, unknown> } {
	if (availableToolNames.includes(toolName)) {
		return { name: toolName, arguments_ };
	}

	const alias = HOSTED_TOOL_ALIASES[toolName];
	if (!alias || !availableToolNames.includes(alias.hostedName)) {
		return { name: toolName, arguments_ };
	}

	return {
		name: alias.hostedName,
		arguments_: alias.mapArguments ? alias.mapArguments(arguments_) : arguments_,
	};
}

/** A cloud-2 cell is already bound by its owner-scoped route and signed lease.
 * Caller-selected graph selectors are discarded at the trusted host gate so
 * they can neither retarget the call nor disagree with the canonical tuple. */
function stripCallerGraphBinding(arguments_: Record<string, unknown>): Record<string, unknown> {
	const { graph_id: _snake, graphId: _camel, ...bound } = arguments_;
	return bound;
}

const GRAPH_SELECTORS: ReadonlySet<string> = new Set(["graph_id", "graphId"]);

function isSchemaObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mentionsGraphSelector(schema: Record<string, unknown>): boolean {
	const text = JSON.stringify(schema);
	return text.includes('"graph_id"') || text.includes('"graphId"');
}

/**
 * A cell schema with the graph selector bound by the host: `graph_id`/`graphId` leave `properties` and `required`, and
 * an `anyOf`/`oneOf` with a branch only the selector satisfied is met (the host always names the graph), so it goes;
 * an `allOf` keeps its other members. Garden's `write_document` requires a selector through
 * `allOf: [{anyOf: [{required: ["graph_id"]}, {required: ["graphId"]}]}, …]`: left in place, a caller that may not
 * send a selector (the Prime worker removes both from `properties` and closes the object) could never satisfy it
 * (live, 2026-10-07: every Writer `write_document` failed in the worker's validator).
 */
export function hostBoundGraphSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const bound: Record<string, unknown> = { ...schema };
	if (isSchemaObject(bound.properties)) {
		bound.properties = Object.fromEntries(
			Object.entries(bound.properties).filter(([key]) => !GRAPH_SELECTORS.has(key)),
		);
	}
	if (Array.isArray(bound.required)) {
		const required = bound.required.filter((key) => typeof key !== "string" || !GRAPH_SELECTORS.has(key));
		if (required.length > 0) bound.required = required;
		else delete bound.required;
	}
	for (const combinator of ["allOf", "anyOf", "oneOf"] as const) {
		const branches = bound[combinator];
		if (!Array.isArray(branches)) continue;
		const next: unknown[] = [];
		let met = false;
		for (const branch of branches) {
			if (!isSchemaObject(branch) || !mentionsGraphSelector(branch)) {
				next.push(branch);
				continue;
			}
			const rebound = hostBoundGraphSchema(branch);
			// A branch the selector alone made: the host's binding satisfies it.
			if (Object.keys(rebound).length === 0) met = true;
			else next.push(rebound);
		}
		if (combinator === "allOf" ? next.length === 0 : met) delete bound[combinator];
		else bound[combinator] = next;
	}
	return bound;
}

function withHostBoundGraph(tool: HostedMcpToolDescriptor): HostedMcpToolDescriptor {
	if (!tool.inputSchema || !mentionsGraphSelector(tool.inputSchema)) return tool;
	return { ...tool, inputSchema: hostBoundGraphSchema(tool.inputSchema) };
}

/**
 * On a bound cell route the cell injects `graphId` into a call that carries no selector, but a few tools accept
 * only `graph_id` and refuse any other field: the text-artifact tools (garden r20261002
 * `artifact_text_service.rs` `mcp_mutate`, "unsupported text mutation field"). For a tool whose live schema
 * declares `graph_id` and not `graphId`, name the bound graph as `graph_id` after the caller's selectors were
 * stripped. The value is always the proxy's own graph, so it can never retarget the call.
 */
function bindSnakeOnlyGraphSelector(
	graphId: string,
	descriptors: readonly HostedMcpToolDescriptor[],
	toolName: string,
	arguments_: Record<string, unknown>,
): Record<string, unknown> {
	const properties = descriptors.find((tool) => tool.name === toolName)?.inputSchema?.properties;
	if (!properties || typeof properties !== "object" || Array.isArray(properties)) return arguments_;
	if (!("graph_id" in properties) || "graphId" in properties) return arguments_;
	return { graph_id: graphId, ...stripCallerGraphBinding(arguments_) };
}

/** Legacy and desktop MCP endpoints can host multiple graphs, unlike a
 * cloud-2 cell route. The host therefore restores its canonical graph after
 * discarding both caller-selectable spellings. */
function bindCanonicalGraph(
	graphId: string,
	arguments_: Record<string, unknown>,
	dialect: "garden" | "legacy",
): Record<string, unknown> {
	const bound = stripCallerGraphBinding(arguments_);
	return dialect === "garden" ? { graphId, ...bound } : { graph_id: graphId, ...bound };
}

function recordHostedSessionOperation(operation: string, outcome: "ok" | "error", startTime: number): void {
	hostedSessionOperationsTotal.add(1, { operation, outcome });
	hostedSessionOperationDurationSeconds.record((performance.now() - startTime) / 1000, {
		operation,
		outcome,
	});
}

/** The most tools/list pages read from one cell (garden answers 102 tools in one page today). */
const MAX_TOOLS_LIST_PAGES = 50;

async function defaultHostedMcpClientFactory(options: HostedMcpClientFactoryOptions): Promise<HostedMcpClient> {
	// X-User-ID is the side-channel for sidecar/hosted auth modes — the MCP
	// server uses it when the bearer is opaque (agsa_*) and can't be JWT-decoded.
	// Harmless when the server doesn't trust forwarded user-ids.
	const headers: Record<string, string> = {
		Authorization: `Bearer ${options.accessToken}`,
	};
	if (options.onBehalfOf) {
		// Gateway service-auth: the bearer IS the service token; the gateway reads
		// the acting end-user from x-pn-on-behalf-of and runs its own per-graph
		// ACL. Do NOT also send X-User-ID — identity is the on-behalf-of header.
		headers["x-pn-on-behalf-of"] = options.onBehalfOf;
	} else if (options.userId) {
		headers["X-User-ID"] = options.userId;
	}
	const transport = new StreamableHTTPClientTransport(new URL(options.mcpUrl), {
		requestInit: { headers },
	});
	const client = new Client({ name: "choreograph-sandbox-mgmt", version: "0.1.0" }, { capabilities: {} });
	try {
		await client.connect(transport, { timeout: options.timeoutMs });
	} catch (error) {
		await client.close().catch(() => {});
		await transport.close().catch(() => {});
		throw error;
	}

	return {
		async listTools(timeoutMs) {
			// Every page (exam 1, finding 7): a cell may page tools/list with `nextCursor`, and a tool past page one is
			// as real as the rest. Bounded, and a cursor that repeats is refused rather than followed in a loop.
			const tools: Awaited<ReturnType<typeof client.listTools>>["tools"] = [];
			const seen = new Set<string>();
			let cursor: string | undefined;
			for (let page = 0; ; page += 1) {
				if (page >= MAX_TOOLS_LIST_PAGES) {
					throw new Error(`Hosted Mnemosyne MCP tools/list did not end within ${MAX_TOOLS_LIST_PAGES} pages`);
				}
				const response = await client.listTools(cursor === undefined ? undefined : { cursor }, {
					timeout: timeoutMs,
				});
				tools.push(...response.tools);
				const next = response.nextCursor;
				if (next === undefined || next === "") break;
				if (seen.has(next)) throw new Error("Hosted Mnemosyne MCP tools/list repeated a page cursor");
				seen.add(next);
				cursor = next;
			}
			return tools.map((tool) => {
				const requiredScopes = requiredScopesFromToolMeta(tool._meta);
				return {
					name: tool.name,
					description: tool.description ?? "",
					inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
					// Garden's MCP schema does not carry this field yet. Classify once at
					// the trusted host ingress; the Prime worker consumes the typed bit.
					destructive: isDestructive(tool.name),
					...(requiredScopes ? { requiredScopes } : {}),
				};
			});
		},
		async callTool(name, arguments_, signal, timeoutMs) {
			return client.callTool({ name, arguments: arguments_ }, undefined, { signal, timeout: timeoutMs });
		},
		async close() {
			await client.close().catch(() => {});
			try {
				await transport.terminateSession();
			} catch {
				// Session termination is optional on the server side.
			}
			await transport.close().catch(() => {});
		},
	};
}
