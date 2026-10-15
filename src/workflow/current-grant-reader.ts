import { canonicalJson } from "@sophia-labs/canonical-json";
import { HostedMnemosyneProxy, type HostedServiceAuthConfig } from "../mnemosyne.js";
import { grantDigest, parseAgentToolGrant } from "./agent-tool-grant.js";
import { makeHostedGraphWriter, unwrapAuthoredJsonDocument } from "./graph-writer.js";

/** The sole activation-time read authority for a Session-bound grant. */
export interface CurrentGrantReader {
	readCurrentGrant(ref: {
		readonly grantAuthorityGraphId: string;
		readonly grantDocumentId: string;
		readonly grantAuthorityOwnerPrincipal: string;
	}): Promise<{ readonly canonicalBytes: string; readonly digest: string; readonly revision: number | string }>;
}

/** Hosted Garden/service-auth composition; it never receives a Session proxy. */
export class HostedCurrentGrantReader implements CurrentGrantReader {
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
	): HostedCurrentGrantReader | undefined {
		const gatewayBaseUrl = env.MNEMOSYNE_GATEWAY_BASE_URL?.trim();
		const serviceToken = env.MNEMOSYNE_SERVICE_TOKEN?.trim();
		if (!gatewayBaseUrl || !serviceToken) return undefined;
		return new HostedCurrentGrantReader({ gatewayBaseUrl, serviceToken });
	}

	async readCurrentGrant(ref: {
		readonly grantAuthorityGraphId: string;
		readonly grantDocumentId: string;
		readonly grantAuthorityOwnerPrincipal: string;
	}): Promise<{ readonly canonicalBytes: string; readonly digest: string; readonly revision: number | string }> {
		const onBehalfOf = requireUserPrincipal(ref.grantAuthorityOwnerPrincipal);
		const proxy = await this.proxy(ref.grantAuthorityOwnerPrincipal, ref.grantAuthorityGraphId, onBehalfOf);
		const document = await makeHostedGraphWriter(proxy).readDocument(ref.grantAuthorityGraphId, ref.grantDocumentId, {
			format: "markdown",
		});
		if (!document.text?.trim() || (document.revision === undefined && !document.changeId)) {
			throw new Error("current grant document is unavailable");
		}
		const grant = parseAgentToolGrant(JSON.parse(unwrapAuthoredJsonDocument(document.text)) as unknown);
		return {
			canonicalBytes: canonicalJson(grant),
			digest: grantDigest(grant),
			revision: document.revision ?? document.changeId!,
		};
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
			runtime: "choreograph-schedule-grant-reader",
			label: `schedule-grant:${graphId}`,
			requestTimeoutMs: this.config.requestTimeoutMs ?? 30_000,
			requiredTools: ["read_document"],
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
	if (!matched) throw new Error("grant authority owner must be a canonical user principal");
	return matched[1]!;
}
