import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type HostedMcpClientFactory,
	type HostedMcpClientFactoryOptions,
	type HostedMcpToolDescriptor,
	HostedMnemosyneProxy,
	isDirectMcpAuthConfigured,
	isGatewayServiceAuthConfigured,
	READ_ONLY_MNEMOSYNE_TOOLS,
	resolveDirectMcpAuth,
	resolveGatewayServiceAuth,
	wrapMnemosyneProxy,
} from "../mnemosyne.js";
import { buildDefaultMnemosyneDescriptor } from "../spawner.js";

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: {
			"content-type": "application/json",
		},
	});
}

describe("HostedMnemosyneProxy", () => {
	it("mints allowlist sessions from a delegated bearer and revokes via session/me", async () => {
		const fetchCalls: Array<{ url: string; method: string; headers: Headers; body?: unknown }> = [];
		const clientFactory: HostedMcpClientFactory = async ({ accessToken, mcpUrl }) => {
			assert.equal(accessToken, "agsa_initial");
			assert.equal(mcpUrl, "https://api.tabula.example.invalid/mcp");
			return {
				async listTools() {
					return [
						{ name: "search_documents" },
						{ name: "read_document" },
						{ name: "insert_blocks" },
						{ name: "remember" },
					];
				},
				async callTool(name, arguments_) {
					return { name, arguments_ };
				},
				async close() {},
			};
		};

		const proxy = new HostedMnemosyneProxy({
			apiBaseUrl: "https://api.tabula.example.invalid",
			graphId: "choreograph-2",
			toolProfile: "chat",
			authContext: {
				method: "delegated_bearer",
				bearerToken: "jwt-token",
			},
			requiredTools: ["search_documents", "read_document", "append_to_document", "remember"],
			fetchFn: async (input, init) => {
				const url = String(input);
				const headers = new Headers(init?.headers);
				const body = init?.body ? JSON.parse(String(init.body)) : undefined;
				fetchCalls.push({
					url,
					method: init?.method ?? "GET",
					headers,
					body,
				});

				if (url.endsWith("/api/agent/session")) {
					assert.equal(headers.get("authorization"), "Bearer jwt-token");
					assert.deepEqual(body, {
						runtime: "choreograph",
						tool_profile: "chat",
						graph_scope: {
							mode: "allowlist",
							default_graph_id: "choreograph-2",
							allowed_graph_ids: ["choreograph-2"],
						},
						capabilities: {
							reads: true,
							writes: true,
							dangerous_ops: false,
						},
						metadata: {
							graph_id: "choreograph-2",
							source: "choreograph-spike",
							auth_method: "delegated_bearer",
						},
					});
					return jsonResponse({
						session_id: "agsn_initial",
						user_id: "ada",
						mcp_url: "https://api.tabula.example.invalid/mcp",
						access_token: "agsa_initial",
						refresh_token: "agrf_initial",
						access_expires_at: new Date(Date.now() + 300_000).toISOString(),
						idle_expires_at: new Date(Date.now() + 600_000).toISOString(),
						absolute_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
					});
				}

				if (url.endsWith("/api/agent/session/me/revoke")) {
					assert.equal(headers.get("authorization"), "Bearer agsa_initial");
					return new Response("", { status: 204 });
				}

				throw new Error(`Unexpected fetch: ${url}`);
			},
			clientFactory,
		});

		const start = await proxy.start();
		assert.equal(start.userId, "ada");
		const toolResult = await proxy.callTool("search_documents", { query: "choreograph", limit: 3 });
		assert.deepEqual(toolResult, {
			name: "search_documents",
			arguments_: { graph_id: "choreograph-2", query: "choreograph", limit: 3 },
		});
		await proxy.close();

		assert.equal(fetchCalls.filter((call) => call.url.endsWith("/api/agent/session")).length, 1);
		assert.equal(fetchCalls.filter((call) => call.url.endsWith("/api/agent/session/me/revoke")).length, 1);
	});

	it("maps append_to_document onto hosted insert_blocks when present", async () => {
		const proxy = new HostedMnemosyneProxy({
			apiBaseUrl: "https://api.tabula.example.invalid",
			graphId: "choreograph-2",
			toolProfile: "chat",
			authContext: {
				method: "delegated_bearer",
				bearerToken: "jwt-token",
			},
			requiredTools: ["append_to_document"],
			fetchFn: async (input) => {
				const url = String(input);
				if (url.endsWith("/api/agent/session")) {
					return jsonResponse({
						session_id: "agsn_initial",
						user_id: "ada",
						mcp_url: "https://api.tabula.example.invalid/mcp",
						access_token: "agsa_initial",
						refresh_token: "agrf_initial",
						access_expires_at: new Date(Date.now() + 300_000).toISOString(),
						idle_expires_at: new Date(Date.now() + 600_000).toISOString(),
						absolute_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
					});
				}
				if (url.endsWith("/api/agent/session/me/revoke")) {
					return new Response("", { status: 204 });
				}
				throw new Error(`Unexpected fetch: ${url}`);
			},
			clientFactory: async () => ({
				async listTools() {
					return [{ name: "insert_blocks" }];
				},
				async callTool(name, arguments_) {
					return { name, arguments_ };
				},
				async close() {},
			}),
		});

		await proxy.start();
		const result = await proxy.callTool("append_to_document", {
			graph_id: "choreograph-2",
			document_id: "doc-1",
			text: "Hello",
		});
		assert.deepEqual(result, {
			name: "insert_blocks",
			arguments_: {
				graph_id: "choreograph-2",
				document_id: "doc-1",
				content: "Hello",
			},
		});
		await proxy.close();
	});

	it("heartbeats and refreshes hosted sessions before tool execution", async () => {
		const fetchLog: string[] = [];
		let currentAccessToken = "agsa_initial";
		const clientFactory: HostedMcpClientFactory = async ({ accessToken }) => {
			currentAccessToken = accessToken;
			return {
				async listTools() {
					return [{ name: "search_documents" }];
				},
				async callTool(name, arguments_) {
					return { currentAccessToken, name, arguments_ };
				},
				async close() {},
			};
		};

		const proxy = new HostedMnemosyneProxy({
			apiBaseUrl: "https://api.tabula.example.invalid",
			graphId: "choreograph-2",
			toolProfile: "chat",
			authContext: {
				method: "delegated_bearer",
				bearerToken: "jwt-token",
			},
			requiredTools: ["search_documents"],
			fetchFn: async (input, _init) => {
				const url = String(input);
				fetchLog.push(url);

				if (url.endsWith("/api/agent/session")) {
					return jsonResponse({
						session_id: "agsn_initial",
						user_id: "ada",
						mcp_url: "https://api.tabula.example.invalid/mcp",
						access_token: "agsa_initial",
						refresh_token: "agrf_initial",
						access_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
						idle_expires_at: new Date(Date.now() + 600_000).toISOString(),
						absolute_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
					});
				}

				if (url.endsWith("/api/agent/session/me/heartbeat")) {
					return jsonResponse({
						session_id: "agsn_initial",
						status: "active",
						revoked: false,
						user_id: "ada",
						runtime: "choreograph",
						tool_profile: "chat",
						graph_scope: {
							mode: "allowlist",
							default_graph_id: "choreograph-2",
							allowed_graph_ids: ["choreograph-2"],
						},
						last_activity_at: new Date().toISOString(),
						idle_expires_at: new Date(Date.now() + 600_000).toISOString(),
						absolute_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
						capabilities: {
							reads: true,
							writes: true,
							dangerous_ops: false,
						},
						mcp_url: "https://api.tabula.example.invalid/mcp",
					});
				}

				if (url.endsWith("/api/agent/session/refresh")) {
					return jsonResponse({
						session_id: "agsn_initial",
						user_id: "ada",
						mcp_url: "https://api.tabula.example.invalid/mcp",
						access_token: "agsa_refreshed",
						refresh_token: "agrf_refreshed",
						access_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
						idle_expires_at: new Date(Date.now() + 600_000).toISOString(),
						absolute_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
					});
				}

				if (url.endsWith("/api/agent/session/me/revoke")) {
					return new Response("", { status: 204 });
				}

				throw new Error(`Unexpected fetch: ${url}`);
			},
			clientFactory,
		});

		await proxy.start();
		(proxy as any).session.lastHeartbeatAt = 0;
		let result = await proxy.callTool("search_documents", { query: "first" });
		assert.deepEqual(result, {
			currentAccessToken: "agsa_initial",
			name: "search_documents",
			arguments_: { graph_id: "choreograph-2", query: "first" },
		});

		(proxy as any).session.accessExpiresAt = Date.now() - 1;
		result = await proxy.callTool("search_documents", { query: "second" });
		assert.deepEqual(result, {
			currentAccessToken: "agsa_refreshed",
			name: "search_documents",
			arguments_: { graph_id: "choreograph-2", query: "second" },
		});

		await proxy.close();

		assert.ok(fetchLog.some((url) => url.endsWith("/api/agent/session/me/heartbeat")));
		assert.ok(fetchLog.some((url) => url.endsWith("/api/agent/session/refresh")));
	});
});

describe("HostedMnemosyneProxy gateway service-auth", () => {
	it("discovers and activates an owner tuple before tools and strips graph selectors", async () => {
		let factoryOpts: HostedMcpClientFactoryOptions | undefined;
		const fetchLog: string[] = [];
		let activationPolls = 0;
		const clientFactory: HostedMcpClientFactory = async (opts) => {
			factoryOpts = opts;
			return {
				async listTools() {
					return [
						{ name: "search_documents" },
						{ name: "read_document" },
						{ name: "insert_blocks" },
						{ name: "remember" },
					];
				},
				async callTool(name, arguments_) {
					return { name, arguments_ };
				},
				async close() {},
			};
		};

		const proxy = new HostedMnemosyneProxy({
			// apiBaseUrl is unused in service-auth mode (no mint); the proxy builds
			// the per-graph MCP URL from gatewayBaseUrl + graphId.
			apiBaseUrl: "https://unused.example.com",
			ownerPrincipal: "user:graph-owner",
			graphId: "g-feecbc6a5c",
			toolProfile: "chat",
			requiredTools: ["search_documents", "read_document", "append_to_document", "remember"],
			fetchFn: async (input, init) => {
				const url = String(input);
				fetchLog.push(url);
				const headers = new Headers(init?.headers);
				assert.equal(headers.get("authorization"), "Bearer pn-service-secret");
				assert.equal(headers.get("x-pn-on-behalf-of"), "a1b2c3d4-1111-2222-3333-444455556666");
				if (url.endsWith("/control/mcp")) {
					const body = JSON.parse(String(init?.body));
					assert.equal(body.params.name, "list_graphs");
					return jsonResponse({
						jsonrpc: "2.0",
						id: body.id,
						result: {
							structuredContent: [{ owner: "user:graph-owner", graphId: "g-feecbc6a5c" }],
						},
					});
				}
				if (url.endsWith("/o/user%3Agraph-owner/g/g-feecbc6a5c/activate")) {
					return jsonResponse({ ready: false, pollUrl: "/activations/activation-1" }, 202);
				}
				if (url.endsWith("/activations/activation-1")) {
					activationPolls += 1;
					return jsonResponse({ phase: activationPolls === 1 ? "hydrating" : "ready" });
				}
				throw new Error(`unexpected service-auth fetch: ${url}`);
			},
			serviceAuth: {
				serviceToken: "pn-service-secret",
				gatewayBaseUrl: "https://api.garden.example.invalid",
				onBehalfOf: "a1b2c3d4-1111-2222-3333-444455556666",
			},
			clientFactory,
		});

		const start = await proxy.start();
		assert.equal(start.userId, "a1b2c3d4-1111-2222-3333-444455556666");

		const result = await proxy.callTool("search_documents", {
			graph_id: "attacker-snake",
			graphId: "attacker-camel",
			query: "x",
		});
		assert.deepEqual(result, {
			name: "search_documents",
			arguments_: { query: "x" },
		});

		await proxy.close();

		assert.ok(factoryOpts, "client factory should have been called");
		assert.equal(factoryOpts?.mcpUrl, "https://api.garden.example.invalid/o/user%3Agraph-owner/g/g-feecbc6a5c/mcp");
		assert.equal(factoryOpts?.accessToken, "pn-service-secret");
		assert.equal(factoryOpts?.onBehalfOf, "a1b2c3d4-1111-2222-3333-444455556666");
		// On the service-auth path identity rides on x-pn-on-behalf-of, never X-User-ID.
		assert.equal(factoryOpts?.userId, "a1b2c3d4-1111-2222-3333-444455556666");
		assert.deepEqual(fetchLog, [
			"https://api.garden.example.invalid/control/mcp",
			"https://api.garden.example.invalid/o/user%3Agraph-owner/g/g-feecbc6a5c/activate",
			"https://api.garden.example.invalid/activations/activation-1",
			"https://api.garden.example.invalid/activations/activation-1",
		]);
	});

	it("names the bound graph for a tool whose schema knows only graph_id, and strips every caller selector", async () => {
		// The cell injects `graphId` when a call carries no selector (garden r20261002 cell_graph_boundary.rs
		// scope_graph_arguments), but the text-artifact tools accept only `graph_id` and refuse any other field
		// (artifact_text_service.rs mcp_mutate: "unsupported text mutation field graphId"). Stripping alone made
		// create_artifact_text and write_artifact_text unusable through the host.
		const calls: Array<{ name: string; arguments_: Record<string, unknown> }> = [];
		const proxy = new HostedMnemosyneProxy({
			apiBaseUrl: "https://unused.example.com",
			ownerPrincipal: "user:graph-owner",
			graphId: "g-feecbc6a5c",
			toolProfile: "full",
			fetchFn: async (input, init) => {
				const url = String(input);
				if (url.endsWith("/control/mcp")) {
					const body = JSON.parse(String(init?.body));
					return jsonResponse({
						jsonrpc: "2.0",
						id: body.id,
						result: { structuredContent: [{ owner: "user:graph-owner", graphId: "g-feecbc6a5c" }] },
					});
				}
				if (url.endsWith("/activate")) return jsonResponse({ ready: true }, 200);
				throw new Error(`unexpected service-auth fetch: ${url}`);
			},
			serviceAuth: {
				serviceToken: "pn-service-secret",
				gatewayBaseUrl: "https://api.graphs.example.invalid",
				onBehalfOf: "a1b2c3d4-1111-2222-3333-444455556666",
			},
			clientFactory: async () => ({
				async listTools() {
					return [
						{
							name: "search_documents",
							destructive: false,
							inputSchema: { type: "object", properties: { query: {} } },
						},
						{
							name: "create_artifact_text",
							destructive: true,
							inputSchema: {
								type: "object",
								properties: { graph_id: {}, graph_incarnation: {}, artifact_id: {}, text: {} },
								required: ["graph_id", "graph_incarnation", "artifact_id", "text"],
							},
						},
						{
							name: "move_folder",
							destructive: true,
							inputSchema: { type: "object", properties: { graph_id: {}, graphId: {}, folder_id: {} } },
						},
						{
							name: "insert_blocks",
							destructive: true,
							inputSchema: { type: "object", properties: { graphId: {}, documentId: {} } },
						},
					] satisfies HostedMcpToolDescriptor[];
				},
				async callTool(name, arguments_) {
					calls.push({ name, arguments_ });
					return { ok: true };
				},
				async close() {},
			}),
		});
		await proxy.start();
		await proxy.callTool("create_artifact_text", {
			graph_id: "attacker-snake",
			graphId: "attacker-camel",
			graph_incarnation: "inc-1",
			artifact_id: "board-1",
			text: "<p>x</p>",
		});
		await proxy.callTool("create_artifact_text", { graph_incarnation: "inc-1", artifact_id: "board-2", text: "" });
		await proxy.callTool("search_documents", { graph_id: "attacker-snake", query: "x" });
		await proxy.callTool("move_folder", { graph_id: "attacker-snake", folder_id: "f" });
		await proxy.callTool("insert_blocks", { graphId: "attacker-camel", documentId: "d" });
		await proxy.close();
		assert.deepEqual(calls, [
			{
				name: "create_artifact_text",
				arguments_: {
					graph_id: "g-feecbc6a5c",
					graph_incarnation: "inc-1",
					artifact_id: "board-1",
					text: "<p>x</p>",
				},
			},
			{
				name: "create_artifact_text",
				arguments_: { graph_id: "g-feecbc6a5c", graph_incarnation: "inc-1", artifact_id: "board-2", text: "" },
			},
			// Tools that take the cell's injected camel spelling keep relying on it.
			{ name: "search_documents", arguments_: { query: "x" } },
			{ name: "move_folder", arguments_: { folder_id: "f" } },
			{ name: "insert_blocks", arguments_: { documentId: "d" } },
		]);
	});

	it("fails closed after list_graphs and never activates an unknown tuple", async () => {
		const fetchLog: string[] = [];
		const proxy = new HostedMnemosyneProxy({
			apiBaseUrl: "https://unused.example.com",
			ownerPrincipal: "user:owner",
			graphId: "missing",
			toolProfile: "full",
			serviceAuth: {
				serviceToken: "service",
				gatewayBaseUrl: "https://gateway.example",
				onBehalfOf: "caller",
			},
			fetchFn: async (input) => {
				fetchLog.push(String(input));
				return jsonResponse({ jsonrpc: "2.0", id: "x", result: { structuredContent: [] } });
			},
			clientFactory: async () => {
				throw new Error("unknown graph must never construct a data-plane client");
			},
		});
		await assert.rejects(() => proxy.start(), /not in this identity's list_graphs/);
		assert.deepEqual(fetchLog, ["https://gateway.example/control/mcp"]);
	});

	it("reactivates once when safe MCP tool discovery loses a Ready-to-idle race", async () => {
		let activationCalls = 0;
		let factoryCalls = 0;
		let closedClients = 0;
		const proxy = new HostedMnemosyneProxy({
			apiBaseUrl: "https://unused.example.com",
			ownerPrincipal: "user:owner",
			graphId: "cold-graph",
			toolProfile: "full",
			requiredTools: ["read_document"],
			serviceAuth: {
				serviceToken: "service",
				gatewayBaseUrl: "https://gateway.example",
				onBehalfOf: "caller",
			},
			fetchFn: async (input) => {
				const url = String(input);
				if (url.endsWith("/control/mcp")) {
					return jsonResponse({
						jsonrpc: "2.0",
						id: "x",
						result: {
							structuredContent: [{ owner: "user:owner", graphId: "cold-graph" }],
						},
					});
				}
				if (url.endsWith("/o/user%3Aowner/g/cold-graph/activate")) {
					activationCalls += 1;
					return jsonResponse({ ready: true });
				}
				throw new Error(`unexpected service-auth fetch: ${url}`);
			},
			clientFactory: async () => {
				factoryCalls += 1;
				const attempt = factoryCalls;
				return {
					async listTools() {
						if (attempt === 1) {
							throw Object.assign(new Error("MCP error -32001: Request timed out"), {
								code: -32001,
								data: { timeout: 60_000 },
							});
						}
						return [{ name: "read_document" }];
					},
					async callTool(name, arguments_) {
						return { name, arguments_ };
					},
					async close() {
						closedClients += 1;
					},
				};
			},
		});

		await proxy.start();
		assert.equal(factoryCalls, 2);
		assert.equal(activationCalls, 2);
		assert.equal(closedClients, 1, "the timed-out transport must be closed before retry");
		assert.deepEqual(await proxy.listTools(), [{ name: "read_document" }]);
		await proxy.close();
		assert.equal(closedClients, 2);
	});

	it("does not retry a non-transient required-tool contract failure", async () => {
		let activationCalls = 0;
		let factoryCalls = 0;
		const proxy = new HostedMnemosyneProxy({
			apiBaseUrl: "https://unused.example.com",
			ownerPrincipal: "user:owner",
			graphId: "wrong-tools",
			toolProfile: "full",
			requiredTools: ["read_document"],
			serviceAuth: {
				serviceToken: "service",
				gatewayBaseUrl: "https://gateway.example",
				onBehalfOf: "caller",
			},
			fetchFn: async (input) => {
				const url = String(input);
				if (url.endsWith("/control/mcp")) {
					return jsonResponse({
						jsonrpc: "2.0",
						id: "x",
						result: {
							structuredContent: [{ owner: "user:owner", graphId: "wrong-tools" }],
						},
					});
				}
				if (url.endsWith("/o/user%3Aowner/g/wrong-tools/activate")) {
					activationCalls += 1;
					return jsonResponse({ ready: true });
				}
				throw new Error(`unexpected service-auth fetch: ${url}`);
			},
			clientFactory: async () => {
				factoryCalls += 1;
				return {
					async listTools() {
						return [];
					},
					async callTool() {
						return undefined;
					},
					async close() {},
				};
			},
		});

		await assert.rejects(() => proxy.start(), /missing required tools: read_document/);
		assert.equal(factoryCalls, 1);
		assert.equal(activationCalls, 1);
	});
});

describe("HostedMnemosyneProxy direct MCP auth", () => {
	it("talks straight to a configured MCP URL without minting a session", async () => {
		let factoryOpts: HostedMcpClientFactoryOptions | undefined;
		const clientFactory: HostedMcpClientFactory = async (opts) => {
			factoryOpts = opts;
			return {
				async listTools() {
					return [{ name: "sparql_query" }];
				},
				async callTool(name, arguments_) {
					return { name, arguments_ };
				},
				async close() {},
			};
		};

		const proxy = new HostedMnemosyneProxy({
			apiBaseUrl: "http://127.0.0.1:53961/mcp",
			graphId: "sophia-code-lab",
			toolProfile: "full",
			requiredTools: ["sparql_query"],
			fetchFn: async (input) => {
				throw new Error(`direct MCP auth must not call the control plane: ${String(input)}`);
			},
			directMcp: {
				mcpUrl: "http://127.0.0.1:53961/mcp",
				accessToken: "garden-loopback-token",
				userId: "ada",
			},
			clientFactory,
		});

		const start = await proxy.start();
		assert.equal(start.userId, "ada");

		const result = await proxy.callTool("sparql_query", {
			graph_id: "attacker-snake",
			graphId: "attacker-camel",
			query: "ASK {}",
		});
		assert.deepEqual(result, {
			name: "sparql_query",
			arguments_: { graphId: "sophia-code-lab", query: "ASK {}" },
		});

		await proxy.close();

		assert.ok(factoryOpts, "client factory should have been called");
		assert.equal(factoryOpts?.mcpUrl, "http://127.0.0.1:53961/mcp");
		assert.equal(factoryOpts?.accessToken, "garden-loopback-token");
		assert.equal(factoryOpts?.userId, "ada");
		assert.equal(factoryOpts?.onBehalfOf, undefined);
	});
});

describe("resolveGatewayServiceAuth", () => {
	function withEnv(env: Record<string, string | undefined>, fn: () => void) {
		const saved: Record<string, string | undefined> = {};
		for (const key of Object.keys(env)) {
			saved[key] = process.env[key];
			const value = env[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		try {
			fn();
		} finally {
			for (const key of Object.keys(saved)) {
				const value = saved[key];
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
	}

	it("returns undefined when service-auth is not fully configured", () => {
		withEnv({ MNEMOSYNE_SERVICE_TOKEN: undefined, MNEMOSYNE_GATEWAY_BASE_URL: undefined }, () => {
			assert.equal(resolveGatewayServiceAuth("user-1"), undefined);
		});
		withEnv({ MNEMOSYNE_SERVICE_TOKEN: "tok", MNEMOSYNE_GATEWAY_BASE_URL: undefined }, () => {
			assert.equal(resolveGatewayServiceAuth("user-1"), undefined);
		});
	});

	it("resolves config when both vars are set", () => {
		withEnv({ MNEMOSYNE_SERVICE_TOKEN: "tok", MNEMOSYNE_GATEWAY_BASE_URL: "https://gw" }, () => {
			assert.deepEqual(resolveGatewayServiceAuth("user-1"), {
				serviceToken: "tok",
				gatewayBaseUrl: "https://gw",
				onBehalfOf: "user-1",
			});
		});
	});

	it("throws when enabled but no acting user is available (fail-closed)", () => {
		withEnv({ MNEMOSYNE_SERVICE_TOKEN: "tok", MNEMOSYNE_GATEWAY_BASE_URL: "https://gw" }, () => {
			assert.throws(() => resolveGatewayServiceAuth(undefined), /no acting user/);
		});
	});
});

describe("resolveDirectMcpAuth", () => {
	function withEnv(env: Record<string, string | undefined>, fn: () => void) {
		const saved: Record<string, string | undefined> = {};
		for (const key of Object.keys(env)) {
			saved[key] = process.env[key];
			const value = env[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		try {
			fn();
		} finally {
			for (const key of Object.keys(saved)) {
				const value = saved[key];
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
	}

	it("resolves Garden loopback direct MCP auth", () => {
		withEnv(
			{
				MNEMOSYNE_MCP_URL: "http://127.0.0.1:53961/mcp",
				MNEMOSYNE_MCP_ACCESS_TOKEN: "loopback-token",
				MNEMOSYNE_MCP_BEARER_TOKEN: undefined,
			},
			() => {
				assert.equal(isDirectMcpAuthConfigured(), true);
				assert.deepEqual(resolveDirectMcpAuth("ada"), {
					mcpUrl: "http://127.0.0.1:53961/mcp",
					accessToken: "loopback-token",
					userId: "ada",
				});
			},
		);
	});

	it("throws when only one direct MCP env var is set", () => {
		withEnv(
			{
				MNEMOSYNE_MCP_URL: undefined,
				MNEMOSYNE_MCP_ACCESS_TOKEN: "loopback-token",
				MNEMOSYNE_MCP_BEARER_TOKEN: undefined,
			},
			() => {
				assert.equal(isDirectMcpAuthConfigured(), false);
				assert.throws(() => resolveDirectMcpAuth("ada"), /requires both MNEMOSYNE_MCP_URL/);
			},
		);
	});
});

describe("gateway service-auth descriptor precedence", () => {
	function withEnv(env: Record<string, string | undefined>, fn: () => void) {
		const saved: Record<string, string | undefined> = {};
		for (const key of Object.keys(env)) {
			saved[key] = process.env[key];
			if (env[key] === undefined) delete process.env[key];
			else process.env[key] = env[key];
		}
		try {
			fn();
		} finally {
			for (const key of Object.keys(saved)) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
		}
	}

	it("prefers the gateway over MNEMOSYNE_API_BASE_URL when service-auth is configured", () => {
		withEnv(
			{
				MNEMOSYNE_SERVICE_TOKEN: "tok",
				MNEMOSYNE_GATEWAY_BASE_URL: "https://api.garden.example.invalid",
				MNEMOSYNE_API_BASE_URL: "https://api.tabula.example.invalid",
				MNEMOSYNE_MCP_URL: undefined,
			},
			() => {
				assert.equal(isGatewayServiceAuthConfigured(), true);
				// The descriptor marker (read by the spawner log) must reflect the
				// gateway, NOT the dead legacy control plane.
				assert.equal(buildDefaultMnemosyneDescriptor().mcp_url, "https://api.garden.example.invalid/g");
			},
		);
	});

	it("falls back to legacy MNEMOSYNE_API_BASE_URL when service-auth is not configured", () => {
		withEnv(
			{
				MNEMOSYNE_SERVICE_TOKEN: undefined,
				MNEMOSYNE_GATEWAY_BASE_URL: undefined,
				MNEMOSYNE_API_BASE_URL: "https://api.tabula.example.invalid",
				MNEMOSYNE_MCP_URL: undefined,
			},
			() => {
				assert.equal(isGatewayServiceAuthConfigured(), false);
				assert.equal(buildDefaultMnemosyneDescriptor().mcp_url, "https://api.tabula.example.invalid/mcp");
			},
		);
	});

	it("retains supplied durable graph coordinates when graph transport is disabled", () => {
		withEnv(
			{
				MNEMOSYNE_SERVICE_TOKEN: undefined,
				MNEMOSYNE_GATEWAY_BASE_URL: undefined,
				MNEMOSYNE_API_BASE_URL: undefined,
				MNEMOSYNE_MCP_URL: undefined,
				MNEMOSYNE_GRAPH_OWNER: undefined,
				MNEMOSYNE_GRAPH_ID: undefined,
			},
			() => {
				const descriptor = buildDefaultMnemosyneDescriptor({
					ownerPrincipal: "user:durable-owner",
					graphId: "durable-graph",
				});
				assert.equal(descriptor.mcp_url, "disabled");
				assert.equal(descriptor.session_token, "disabled");
				assert.deepEqual(descriptor.graph_scope, {
					default_graph_owner: "user:durable-owner",
					default_graph_id: "durable-graph",
				});
			},
		);
	});
});

describe("control-plane prod-egress env override (transcript safety)", () => {
	// Outbound credentials for a real control plane must come from the deployment
	// environment (installed out-of-band), NEVER echoed from whatever the caller
	// typed into an inbound request header. These tests pin both halves: env set ⇒
	// env wins and X-User-ID is dropped (platform-1 rejects it); env unset ⇒ the
	// pre-existing echo behavior is byte-identical.
	async function withEnvAsync(env: Record<string, string | undefined>, fn: () => Promise<void>) {
		const saved: Record<string, string | undefined> = {};
		for (const key of Object.keys(env)) {
			saved[key] = process.env[key];
			const value = env[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		try {
			await fn();
		} finally {
			for (const key of Object.keys(saved)) {
				const value = saved[key];
				if (value === undefined) {
					delete process.env[key];
				} else {
					process.env[key] = value;
				}
			}
		}
	}

	function mintingProxy(
		authContext:
			| { method: "internal_service"; userId: string; internalServiceSecret: string }
			| { method: "delegated_bearer"; bearerToken: string },
		onMintHeaders: (headers: Headers) => void,
	): HostedMnemosyneProxy {
		return new HostedMnemosyneProxy({
			apiBaseUrl: "https://api.tabula.example.invalid",
			graphId: "default",
			toolProfile: "chat",
			authContext,
			requiredTools: ["read_document"],
			fetchFn: async (input, init) => {
				const url = String(input);
				if (url.endsWith("/api/agent/session")) {
					onMintHeaders(new Headers(init?.headers));
					return jsonResponse({
						session_id: "agsn_x",
						user_id: "bo",
						mcp_url: "https://api.tabula.example.invalid/mcp",
						access_token: "agsa_x",
						refresh_token: "agrf_x",
						access_expires_at: new Date(Date.now() + 300_000).toISOString(),
						idle_expires_at: new Date(Date.now() + 600_000).toISOString(),
						absolute_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
					});
				}
				if (url.endsWith("/api/agent/session/me/revoke")) {
					return new Response("", { status: 204 });
				}
				throw new Error(`Unexpected fetch: ${url}`);
			},
			clientFactory: async () => ({
				async listTools() {
					return [{ name: "read_document" }];
				},
				async callTool(name, arguments_) {
					return { name, arguments_ };
				},
				async close() {},
			}),
		});
	}

	it("internal_service + both env vars ⇒ env secret + Bearer ID token, NO X-User-ID, inbound secret never egresses", async () => {
		await withEnvAsync(
			{ MNEMOSYNE_PROD_SERVICE_SECRET: "prod-secret-from-env", MNEMOSYNE_PROD_ID_TOKEN: "id-token-from-env" },
			async () => {
				let mintHeaders: Headers | undefined;
				const proxy = mintingProxy(
					{ method: "internal_service", userId: "dev-user", internalServiceSecret: "inbound-dev-secret" },
					(headers) => {
						mintHeaders = headers;
					},
				);
				await proxy.start();
				await proxy.close();
				assert.ok(mintHeaders);
				assert.equal(mintHeaders.get("x-internal-service"), "prod-secret-from-env");
				assert.equal(mintHeaders.get("authorization"), "Bearer id-token-from-env");
				// Platform-1 403s internal-service requests that assert X-User-ID.
				assert.equal(mintHeaders.get("x-user-id"), null);
			},
		);
	});

	it("internal_service + env unset ⇒ pre-existing echo behavior (inbound secret + X-User-ID, no Authorization)", async () => {
		await withEnvAsync({ MNEMOSYNE_PROD_SERVICE_SECRET: undefined, MNEMOSYNE_PROD_ID_TOKEN: undefined }, async () => {
			let mintHeaders: Headers | undefined;
			const proxy = mintingProxy(
				{ method: "internal_service", userId: "dev-user", internalServiceSecret: "inbound-dev-secret" },
				(headers) => {
					mintHeaders = headers;
				},
			);
			await proxy.start();
			await proxy.close();
			assert.ok(mintHeaders);
			assert.equal(mintHeaders.get("x-internal-service"), "inbound-dev-secret");
			assert.equal(mintHeaders.get("x-user-id"), "dev-user");
			assert.equal(mintHeaders.get("authorization"), null);
		});
	});

	it("internal_service + secret WITHOUT ID token ⇒ echo (the pair is all-or-nothing; a secret alone cannot reach prod)", async () => {
		await withEnvAsync(
			{ MNEMOSYNE_PROD_SERVICE_SECRET: "prod-secret-from-env", MNEMOSYNE_PROD_ID_TOKEN: undefined },
			async () => {
				let mintHeaders: Headers | undefined;
				const proxy = mintingProxy(
					{ method: "internal_service", userId: "dev-user", internalServiceSecret: "inbound-dev-secret" },
					(headers) => {
						mintHeaders = headers;
					},
				);
				await proxy.start();
				await proxy.close();
				assert.ok(mintHeaders);
				assert.equal(mintHeaders.get("x-internal-service"), "inbound-dev-secret");
				assert.equal(mintHeaders.get("x-user-id"), "dev-user");
				assert.equal(mintHeaders.get("authorization"), null);
			},
		);
	});

	it("delegated_bearer + env ID token ⇒ env token wins over the inbound bearer", async () => {
		await withEnvAsync(
			{ MNEMOSYNE_PROD_SERVICE_SECRET: undefined, MNEMOSYNE_PROD_ID_TOKEN: "id-token-from-env" },
			async () => {
				let mintHeaders: Headers | undefined;
				const proxy = mintingProxy({ method: "delegated_bearer", bearerToken: "inbound-jwt" }, (headers) => {
					mintHeaders = headers;
				});
				await proxy.start();
				await proxy.close();
				assert.ok(mintHeaders);
				assert.equal(mintHeaders.get("authorization"), "Bearer id-token-from-env");
			},
		);
	});

	it("delegated_bearer + env unset ⇒ inbound bearer echoes as before", async () => {
		await withEnvAsync({ MNEMOSYNE_PROD_SERVICE_SECRET: undefined, MNEMOSYNE_PROD_ID_TOKEN: undefined }, async () => {
			let mintHeaders: Headers | undefined;
			const proxy = mintingProxy({ method: "delegated_bearer", bearerToken: "inbound-jwt" }, (headers) => {
				mintHeaders = headers;
			});
			await proxy.start();
			await proxy.close();
			assert.ok(mintHeaders);
			assert.equal(mintHeaders.get("authorization"), "Bearer inbound-jwt");
		});
	});
});

describe("wrapMnemosyneProxy read-only enforcement (identity-pollution safety)", () => {
	// When a session declares writes:false, the wrapper is THE lock — platform-side
	// capability enforcement does not cover the Geist/graph-mutation routes
	// (remember, sing, value, create_wires), so the host gate cannot delegate to
	// the server. Deny-by-default: anything not allowlisted is rejected and hidden.
	function stubProxy(calls: string[], toolNames: string[]): HostedMnemosyneProxy {
		return {
			callTool: async (name: string, arguments_: Record<string, unknown>) => {
				calls.push(name);
				return { name, arguments_ };
			},
			listTools: async () => toolNames.map((name) => ({ name })),
			close: async () => {},
		} as unknown as HostedMnemosyneProxy;
	}

	const MIXED_SURFACE = [
		"quick_orient",
		"context_bundle",
		"list_documents",
		"read_document",
		"search_documents",
		"get_workspace",
		"music",
		"recall",
		"remember",
		"sing",
		"value",
		"create_wires",
		"insert_blocks",
		"write_document",
		"sparql_update",
		"some_future_tool",
	];

	it("writes:false ⇒ remember and sing are REJECTED at the gate and never reach the proxy", async () => {
		const calls: string[] = [];
		const backend = wrapMnemosyneProxy(stubProxy(calls, MIXED_SURFACE), {
			reads: true,
			writes: false,
			dangerous_ops: false,
		});
		assert.equal(backend.accessLevel, "ro");
		await assert.rejects(() => backend.callTool("remember", { text: "polluting memory" }), /Read-only/);
		await assert.rejects(() => backend.callTool("sing", { verse: "a stranger's verse" }), /Read-only/);
		await assert.rejects(() => backend.callTool("value", { block_id: "x" }), /Read-only/);
		await assert.rejects(() => backend.callTool("create_wires", {}), /Read-only/);
		assert.deepEqual(calls, []);
	});

	it("writes:false ⇒ the curated alias append_to_document is rejected BEFORE alias resolution", async () => {
		const calls: string[] = [];
		const backend = wrapMnemosyneProxy(stubProxy(calls, MIXED_SURFACE), {
			reads: true,
			writes: false,
			dangerous_ops: false,
		});
		await assert.rejects(() => backend.callTool("append_to_document", { text: "hi" }), /Read-only/);
		assert.deepEqual(calls, []);
	});

	it("writes:false ⇒ unknown/future tools are denied by default", async () => {
		const calls: string[] = [];
		const backend = wrapMnemosyneProxy(stubProxy(calls, MIXED_SURFACE), {
			reads: true,
			writes: false,
			dangerous_ops: false,
		});
		await assert.rejects(() => backend.callTool("some_future_tool", {}), /Read-only/);
		assert.deepEqual(calls, []);
	});

	it("writes:false ⇒ attunement and compact document reads pass through", async () => {
		const calls: string[] = [];
		const backend = wrapMnemosyneProxy(stubProxy(calls, MIXED_SURFACE), {
			reads: true,
			writes: false,
			dangerous_ops: false,
		});
		await backend.callTool("quick_orient", {});
		await backend.callTool("list_documents", { limit: 2 });
		await backend.callTool("music", {});
		await backend.callTool("recall", {});
		await backend.callTool("read_document", { document_id: "agent-alpha" });
		await backend.callTool("get_important_blocks", {});
		assert.deepEqual(calls, [
			"quick_orient",
			"list_documents",
			"music",
			"recall",
			"read_document",
			"get_important_blocks",
		]);
	});

	it("writes:false ⇒ context_bundle cannot re-enable its home-graph preference write", async () => {
		let observed: Record<string, unknown> | undefined;
		const proxy = {
			callTool: async (_name: string, arguments_: Record<string, unknown>) => {
				observed = arguments_;
				return { ok: true };
			},
			listTools: async () => [{ name: "context_bundle" }],
			close: async () => {},
		} as unknown as HostedMnemosyneProxy;
		const backend = wrapMnemosyneProxy(proxy, {
			reads: true,
			writes: false,
			dangerous_ops: false,
		});
		await backend.callTool("context_bundle", { set_home: true, setHome: true, recall_limit: 3 });
		assert.deepEqual(observed, { set_home: false, setHome: false, recall_limit: 3 });
	});

	it("writes:false ⇒ listTools advertises ONLY the allowlisted subset (the model never sees write tools)", async () => {
		const backend = wrapMnemosyneProxy(stubProxy([], MIXED_SURFACE), {
			reads: true,
			writes: false,
			dangerous_ops: false,
		});
		const advertised = (await backend.listTools()).map((tool) => tool.name);
		assert.deepEqual(advertised, [
			"quick_orient",
			"context_bundle",
			"list_documents",
			"read_document",
			"search_documents",
			"get_workspace",
			"music",
			"recall",
		]);
		for (const name of advertised) {
			assert.ok(READ_ONLY_MNEMOSYNE_TOOLS.has(name));
		}
	});

	it("writes:true ⇒ full passthrough, byte-identical to the pre-enforcement wrapper", async () => {
		const calls: string[] = [];
		const backend = wrapMnemosyneProxy(stubProxy(calls, MIXED_SURFACE), {
			reads: true,
			writes: true,
			dangerous_ops: false,
		});
		assert.equal(backend.accessLevel, "rw");
		await backend.callTool("remember", { text: "a legitimate memory" });
		await backend.callTool("sing", { verse: "a legitimate verse" });
		assert.deepEqual(calls, ["remember", "sing"]);
		const advertised = (await backend.listTools()).map((tool) => tool.name);
		assert.deepEqual(advertised, MIXED_SURFACE);
	});

	it("the allowlist itself contains no mutating tool names (spot-pin the wound tools)", () => {
		for (const wound of [
			"remember",
			"care",
			"sing",
			"value",
			"revaluate",
			"store_memory",
			"create_wires",
			"insert_blocks",
			"update_blocks",
			"edit_block_text",
			"write_document",
			"delete",
			"rename",
			"sparql_update",
			"set_home_graph",
			"append_to_document",
		]) {
			assert.equal(READ_ONLY_MNEMOSYNE_TOOLS.has(wound), false, `allowlist must not contain ${wound}`);
		}
	});
});
