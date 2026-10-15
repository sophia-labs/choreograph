import {
	type AgentModeCatalogV1,
	AgentModeError,
	type AgentModeRefV1,
	type AgentModeV1,
	agentModeDigest,
	buildAgentModeCatalogQuery,
	parseAgentModeCatalog,
	resolveSessionMode,
} from "../agent-runtime/agent-mode.js";
import { HostedMnemosyneProxy, type HostedServiceAuthConfig } from "../mnemosyne.js";
import type { GraphWriter } from "./graph-writer.js";

/** The activation-time read authority for an agent's modes (its own graph). */
export interface AgentModeReader {
	readAgentModeCatalog(ref: {
		readonly graphOwnerPrincipal: string;
		readonly graphId: string;
		readonly agentId: string;
	}): Promise<AgentModeCatalogV1>;
}

/** Read the catalog through any graph writer bound to the agent's graph. */
export async function readAgentModeCatalogFromGraph(
	graph: Pick<GraphWriter, "sparqlQuery">,
	graphId: string,
	agentId: string,
): Promise<AgentModeCatalogV1> {
	let result: unknown;
	try {
		result = await graph.sparqlQuery(graphId, buildAgentModeCatalogQuery(agentId, graphId));
	} catch (error) {
		throw new AgentModeError("mode_unavailable", "the agent's mode catalog could not be read", {
			cause: error instanceof Error ? error.message : String(error),
		});
	}
	return parseAgentModeCatalog(agentId, result);
}

/**
 * Re-read the mode a durable session was bound to and require the pinned
 * digest (the grant reread discipline): an edited or deleted mode never
 * silently changes what a resumed session may do.
 */
export async function rereadPinnedAgentMode(
	reader: AgentModeReader,
	ref: { readonly graphOwnerPrincipal: string; readonly graphId: string; readonly agentId: string },
	pinned: AgentModeRefV1,
): Promise<AgentModeV1> {
	const catalog = await reader.readAgentModeCatalog(ref);
	const mode = resolveSessionMode(catalog, pinned.iri);
	if (!mode) throw new AgentModeError("mode_unknown", `pinned mode <${pinned.iri}> is gone`);
	const digest = agentModeDigest(mode);
	if (digest !== pinned.digest) {
		throw new AgentModeError("mode_current_mismatch", `mode <${pinned.iri}> changed since the session was bound`, {
			expected: pinned.digest,
			actual: digest,
		});
	}
	return mode;
}

/** Hosted Garden/service-auth composition, mirroring HostedCurrentGrantReader. */
export class HostedAgentModeReader implements AgentModeReader {
	private readonly handles = new Map<string, Promise<HostedMnemosyneProxy>>();

	constructor(
		private readonly config: {
			readonly gatewayBaseUrl: string;
			readonly serviceToken: string;
			readonly requestTimeoutMs?: number;
			readonly fetchFn?: typeof fetch;
		},
	) {}

	static fromEnvironment(
		env: Readonly<Record<string, string | undefined>> = process.env,
	): HostedAgentModeReader | undefined {
		const gatewayBaseUrl = env.MNEMOSYNE_GATEWAY_BASE_URL?.trim();
		const serviceToken = env.MNEMOSYNE_SERVICE_TOKEN?.trim();
		if (!gatewayBaseUrl || !serviceToken) return undefined;
		return new HostedAgentModeReader({ gatewayBaseUrl, serviceToken });
	}

	async readAgentModeCatalog(ref: {
		readonly graphOwnerPrincipal: string;
		readonly graphId: string;
		readonly agentId: string;
	}): Promise<AgentModeCatalogV1> {
		const onBehalfOf = requireUserPrincipal(ref.graphOwnerPrincipal);
		const proxy = await this.proxy(ref.graphOwnerPrincipal, ref.graphId, onBehalfOf);
		return readAgentModeCatalogFromGraph(
			{ sparqlQuery: (graphId, query) => proxy.callTool("sparql_query", { graphId, query }) },
			ref.graphId,
			ref.agentId,
		);
	}

	async close(): Promise<void> {
		const proxies = await Promise.allSettled([...this.handles.values()]);
		await Promise.allSettled(proxies.flatMap((item) => (item.status === "fulfilled" ? [item.value.close()] : [])));
		this.handles.clear();
	}

	private proxy(ownerPrincipal: string, graphId: string, onBehalfOf: string): Promise<HostedMnemosyneProxy> {
		const key = `${ownerPrincipal}\0${graphId}\0${onBehalfOf}`;
		const cached = this.handles.get(key);
		if (cached) return cached;
		const opened = this.open(ownerPrincipal, graphId, onBehalfOf).catch((error) => {
			this.handles.delete(key);
			throw error;
		});
		this.handles.set(key, opened);
		return opened;
	}

	private async open(ownerPrincipal: string, graphId: string, onBehalfOf: string): Promise<HostedMnemosyneProxy> {
		const serviceAuth: HostedServiceAuthConfig = {
			serviceToken: this.config.serviceToken,
			gatewayBaseUrl: this.config.gatewayBaseUrl,
			onBehalfOf,
		};
		const proxy = new HostedMnemosyneProxy({
			apiBaseUrl: this.config.gatewayBaseUrl,
			ownerPrincipal,
			graphId,
			toolProfile: "full",
			runtime: "choreograph-agent-mode-reader",
			label: `agent-mode:${graphId}`,
			requestTimeoutMs: this.config.requestTimeoutMs ?? 30_000,
			requiredTools: ["sparql_query"],
			serviceAuth,
			fetchFn: this.config.fetchFn,
		});
		try {
			await proxy.start();
			return proxy;
		} catch (error) {
			await proxy.close().catch(() => undefined);
			throw error;
		}
	}
}

function requireUserPrincipal(value: string): string {
	const matched = /^user:([A-Za-z0-9_.@:-]{1,192})$/.exec(value);
	if (!matched) throw new AgentModeError("mode_unavailable", "agent graph owner must be a canonical user principal");
	return matched[1]!;
}
