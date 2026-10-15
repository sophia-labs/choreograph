import type { IncomingMessage, ServerResponse } from "node:http";
import type { SandboxEventBus } from "../event-bus.js";
import { resolveGatewayServiceAuth } from "../mnemosyne.js";
import type { SandboxStore } from "../sandbox-store.js";
import type { SandboxSpawner } from "../spawner.js";
import { GardenNotebookRunClaims } from "./claims.js";
import { DevelopmentGarden } from "./garden.js";
import { callNotebookTool, notebookTools } from "./mcp.js";
import { HostedNotebookWorkspace } from "./workspace.js";

const MAX_REQUEST_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const OWNER = /^user:[A-Za-z0-9][A-Za-z0-9._:@-]{0,191}$/;

export interface NotebookBinding {
	graphId: string;
	graphOwner: string;
	userId: string;
}

/** The gateway has already authenticated, authorized, and minted this binding. */
export function notebookBinding(headers: IncomingMessage["headers"], internalService: boolean): NotebookBinding {
	if (!internalService) throw new Error("Hosted notebooks require gateway service authentication");
	const graphId = headers["x-graph-id"];
	const graphOwner = headers["x-graph-owner"];
	const userId = headers["x-user-id"];
	if (typeof graphId !== "string" || !ID.test(graphId)) throw new Error("Invalid gateway graph binding");
	if (typeof graphOwner !== "string" || !OWNER.test(graphOwner)) throw new Error("Invalid gateway graph owner");
	if (typeof userId !== "string" || !ID.test(userId)) throw new Error("Invalid gateway acting user");
	return { graphId, graphOwner, userId };
}

async function boundedJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const part of request) {
		const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
		size += chunk.length;
		if (size > MAX_REQUEST_BYTES) throw new Error("Notebook MCP request exceeds 1 MiB");
		chunks.push(chunk);
	}
	const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Notebook MCP request must be an object");
	return value as Record<string, unknown>;
}

function send(response: ServerResponse, status: number, value?: unknown): void {
	response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	response.end(value === undefined ? undefined : JSON.stringify(value));
}

/** One process owns the hosted kernel table. Garden owns the durable receipts. */
export class HostedNotebookService {
	private readonly workspaces = new Map<
		string,
		{ workspace: HostedNotebookWorkspace; active: number; lastUsed: number }
	>();
	constructor(
		private readonly spawner: SandboxSpawner,
		private readonly store: SandboxStore,
		private readonly eventBus: SandboxEventBus,
	) {}

	private workspace(binding: NotebookBinding): {
		workspace: HostedNotebookWorkspace;
		active: number;
		lastUsed: number;
	} {
		const key = `${binding.graphOwner}\0${binding.graphId}\0${binding.userId}`;
		let slot = this.workspaces.get(key);
		if (slot) return slot;
		if (this.workspaces.size >= 64) {
			const idle = [...this.workspaces.entries()]
				.filter(([, value]) => value.active === 0)
				.sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
			if (!idle) throw new Error("Hosted notebook workspace capacity reached");
			this.workspaces.delete(idle[0]);
			void idle[1].workspace
				.close()
				.catch((error) => console.error("[notebooks] idle workspace cleanup failed", error));
		}
		const auth = resolveGatewayServiceAuth(binding.userId);
		if (!auth) throw new Error("Hosted Garden gateway service authentication is unavailable");
		const path = `/o/${encodeURIComponent(binding.graphOwner)}/g/${encodeURIComponent(binding.graphId)}`;
		const apiUrl = `${auth.gatewayBaseUrl.replace(/\/$/, "")}${path}`;
		const garden = new DevelopmentGarden(
			{
				apiUrl,
				mcpUrl: `${apiUrl}/mcp`,
				token: auth.serviceToken,
				onBehalfOf: binding.userId,
			},
			binding.graphId,
		);
		slot = {
			workspace: new HostedNotebookWorkspace(
				garden,
				binding.userId,
				this.spawner,
				this.store,
				this.eventBus,
				new GardenNotebookRunClaims(garden),
			),
			active: 0,
			lastUsed: Date.now(),
		};
		this.workspaces.set(key, slot);
		return slot;
	}

	async handle(request: IncomingMessage, response: ServerResponse, binding: NotebookBinding): Promise<void> {
		let message: Record<string, unknown>;
		try {
			message = await boundedJson(request);
		} catch (error) {
			send(response, 400, {
				jsonrpc: "2.0",
				id: null,
				error: { code: -32700, message: error instanceof Error ? error.message : "Invalid JSON" },
			});
			return;
		}
		const id = message.id ?? null;
		const result = (value: unknown) => send(response, 200, { jsonrpc: "2.0", id, result: value });
		if (typeof message.method !== "string") {
			send(response, 400, { jsonrpc: "2.0", id, error: { code: -32600, message: "Missing method" } });
			return;
		}
		if (message.method.startsWith("notifications/")) {
			send(response, 202);
			return;
		}
		if (message.method === "initialize") {
			result({
				protocolVersion: "2024-11-05",
				capabilities: { tools: {} },
				serverInfo: { name: "choreograph-notebooks", version: "1.0.0" },
			});
			return;
		}
		if (message.method === "ping") {
			result({});
			return;
		}
		if (message.method === "tools/list") {
			result({ tools: notebookTools });
			return;
		}
		if (message.method !== "tools/call") {
			send(response, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
			return;
		}
		try {
			const params = message.params;
			if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("Missing tool params");
			const call = params as Record<string, unknown>;
			if (typeof call.name !== "string") throw new Error("Missing tool name");
			const args = call.arguments;
			if (
				!args ||
				typeof args !== "object" ||
				Array.isArray(args) ||
				(args as Record<string, unknown>).graphId !== binding.graphId
			)
				throw new Error("Tool graphId differs from gateway binding");
			const slot = this.workspace(binding);
			slot.active++;
			let value: unknown;
			try {
				value = await callNotebookTool(slot.workspace, call.name, args);
			} finally {
				slot.active--;
				slot.lastUsed = Date.now();
			}
			result({ content: [{ type: "text", text: JSON.stringify(value ?? null) }] });
		} catch (error) {
			result({
				isError: true,
				content: [{ type: "text", text: error instanceof Error ? error.message : "Notebook request failed" }],
			});
		}
	}

	async close(): Promise<void> {
		await Promise.allSettled([...this.workspaces.values()].map((slot) => slot.workspace.close()));
		this.workspaces.clear();
	}
}
