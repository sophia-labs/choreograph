import type { HostedAuthContext } from "../auth.js";
import {
	type CapabilityBackend,
	type HostedMcpToolDescriptor,
	HostedMnemosyneProxy,
	resolveDirectMcpAuth,
	resolveGatewayServiceAuth,
	wrapMnemosyneProxy,
} from "../mnemosyne.js";

export interface GraphCapabilityOptions {
	readonly name: "mcp" | "sparql";
	readonly graphId: string;
	readonly graphOwner?: string;
	readonly ownerUserId: string;
	readonly authContext?: HostedAuthContext;
	readonly authority: {
		readonly minimumRole: "viewer" | "editor";
		readonly dangerousOps: boolean;
	};
}

/** Bind the cell's MCP surface under either the full MCP or narrowed SPARQL name. */
export async function createGraphCapability(options: GraphCapabilityOptions): Promise<CapabilityBackend> {
	const serviceAuth = resolveGatewayServiceAuth(options.ownerUserId);
	const directMcp = resolveDirectMcpAuth(options.ownerUserId);
	const apiBaseUrl = serviceAuth?.gatewayBaseUrl ?? process.env.MNEMOSYNE_API_BASE_URL?.trim() ?? directMcp?.mcpUrl;
	if (!apiBaseUrl) {
		throw new Error(
			`${options.name}: graph capability needs gateway service auth, direct local MCP auth, or MNEMOSYNE_API_BASE_URL`,
		);
	}

	const sparqlOnly = options.name === "sparql";
	const writes = !sparqlOnly && options.authority.minimumRole === "editor";
	const proxy = new HostedMnemosyneProxy({
		apiBaseUrl,
		graphId: options.graphId,
		ownerPrincipal: options.graphOwner ?? `user:${options.ownerUserId}`,
		toolProfile: "full",
		runtime: process.env.MNEMOSYNE_RUNTIME ?? "choreograph-invocation",
		label: `${options.name}-${options.graphId}`,
		requestTimeoutMs: integerEnv("MNEMOSYNE_REQUEST_TIMEOUT_MS") ?? 60_000,
		authContext: options.authContext,
		apiToken: process.env.MNEMOSYNE_API_TOKEN,
		allowGlobalTokenFallback: false,
		requiredTools: sparqlOnly ? ["sparql_query"] : [],
		capabilities: { reads: true, writes, dangerous_ops: false },
		preferredMcpUrl: directMcp?.mcpUrl,
		serviceAuth,
		directMcp,
	});
	await proxy.start();
	const base = wrapMnemosyneProxy(proxy, { reads: true, writes, dangerous_ops: false });
	if (!sparqlOnly) return aliasCapability("mcp", base);

	return {
		capabilityName: "sparql",
		accessLevel: "ro",
		async callTool(tool, args, signal) {
			if (tool !== "query") throw new Error(`sparql: unknown tool "${tool}"`);
			if (typeof args.query !== "string" || !args.query.trim()) throw new Error("sparql: query must be a string");
			return base.callTool("sparql_query", { query: args.query }, signal);
		},
		async listTools(): Promise<readonly HostedMcpToolDescriptor[]> {
			return [
				{
					name: "query",
					destructive: false,
					description: "Run a read-only SPARQL query against the invocation's bound graph.",
					inputSchema: {
						type: "object",
						properties: { query: { type: "string" } },
						required: ["query"],
					},
				},
			];
		},
		close: () => base.close(),
	};
}

function aliasCapability(name: string, backend: CapabilityBackend): CapabilityBackend {
	return {
		capabilityName: name,
		accessLevel: backend.accessLevel,
		callTool: (tool, args, signal) => backend.callTool(tool, args, signal),
		listTools: () => backend.listTools(),
		close: () => backend.close(),
	};
}

function integerEnv(name: string): number | undefined {
	const value = process.env[name]?.trim();
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
	return parsed;
}
