/** Hosted cloud-2 transport for the digest-bound platform release effect edge. */

import { HostedMnemosyneProxy, type HostedServiceAuthConfig } from "../mnemosyne.js";
import { type GraphWriter, makeHostedGraphWriter } from "./graph-writer.js";
import {
	type PlatformRealizationRequestV1,
	type PlatformRealizationResponseV1,
	type PlatformReleaseEffectHost,
	PlatformReleaseEffectWorker,
	platformReleaseRetryable,
	platformReleaseTerminal,
} from "./platform-release-effect.js";
import type { EffectHandoffRecord, WorkflowRuntimeStore } from "./runtime-store.js";

const USER_PRINCIPAL = /^user:([A-Za-z0-9_.@:-]{1,192})$/;
const GRAPH_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const MAX_RESPONSE_BYTES = 1_048_576;

export interface HostedPlatformReleaseEffectConfig {
	readonly gatewayBaseUrl: string;
	readonly serviceToken: string;
	readonly requestTimeoutMs?: number;
	readonly fetchFn?: typeof fetch;
}

interface HostedGraphHandle {
	readonly proxy: HostedMnemosyneProxy;
	readonly writer: GraphWriter;
}

export class HostedPlatformReleaseEffectHost implements PlatformReleaseEffectHost {
	private readonly gatewayBaseUrl: string;
	private readonly fetchFn: typeof fetch;
	private readonly requestTimeoutMs: number;
	private readonly grantHandles = new Map<string, Promise<HostedGraphHandle>>();

	constructor(private readonly config: HostedPlatformReleaseEffectConfig) {
		this.gatewayBaseUrl = normalizeOrigin(config.gatewayBaseUrl, "platform release gateway");
		if (!config.serviceToken.trim()) throw new Error("platform release effect service token is empty");
		this.fetchFn = config.fetchFn ?? fetch;
		this.requestTimeoutMs = positiveInteger(config.requestTimeoutMs ?? 240_000, "platform release request timeout");
	}

	async readGrant(record: EffectHandoffRecord): Promise<string> {
		const actorSub = requireUserPrincipal(record.grant_authority_owner_principal, "grant authority owner");
		const handle = await this.grantGraph(
			record.grant_authority_owner_principal,
			record.grant_authority_graph_id,
			actorSub,
		);
		const document = await handle.writer.readDocument(record.grant_authority_graph_id, record.grant_document_id, {
			format: "markdown",
		});
		if (!document.text?.trim()) throw platformReleaseRetryable("platform-release-grant-document-empty");
		return document.text;
	}

	async materialize(request: PlatformRealizationRequestV1): Promise<PlatformRealizationResponseV1> {
		const actorSub = requireUserPrincipal(request.target.ownerPrincipal, "platform release owner");
		let response: Response;
		try {
			response = await this.fetchFn(`${this.gatewayBaseUrl}/internal/realizations/materialize`, {
				method: "POST",
				headers: {
					accept: "application/json",
					"content-type": "application/json",
					authorization: `Bearer ${this.config.serviceToken}`,
					"x-pn-on-behalf-of": actorSub,
				},
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(this.requestTimeoutMs),
			});
		} catch (error) {
			throw platformReleaseRetryable("platform-realization-unavailable", error);
		}
		if (!response.ok) {
			const code = `platform-realization-http-${response.status}`;
			if (response.status === 429 || response.status >= 500) throw platformReleaseRetryable(code);
			throw platformReleaseTerminal(code);
		}
		return (await boundedJson(response)) as PlatformRealizationResponseV1;
	}

	async close(): Promise<void> {
		const handles = await Promise.allSettled([...this.grantHandles.values()]);
		await Promise.allSettled(
			handles.flatMap((result) => (result.status === "fulfilled" ? [result.value.proxy.close()] : [])),
		);
		this.grantHandles.clear();
	}

	private grantGraph(ownerPrincipal: string, graphId: string, actorSub: string): Promise<HostedGraphHandle> {
		if (!GRAPH_ID.test(graphId))
			return Promise.reject(platformReleaseTerminal("platform-release-grant-graph-invalid"));
		const key = `${ownerPrincipal}\0${graphId}\0${actorSub}`;
		const existing = this.grantHandles.get(key);
		if (existing) return existing;
		const created = this.openGrantGraph(ownerPrincipal, graphId, actorSub).catch((error) => {
			this.grantHandles.delete(key);
			throw error;
		});
		this.grantHandles.set(key, created);
		return created;
	}

	private async openGrantGraph(ownerPrincipal: string, graphId: string, actorSub: string): Promise<HostedGraphHandle> {
		const serviceAuth: HostedServiceAuthConfig = {
			serviceToken: this.config.serviceToken,
			gatewayBaseUrl: this.gatewayBaseUrl,
			onBehalfOf: actorSub,
		};
		const proxy = new HostedMnemosyneProxy({
			apiBaseUrl: this.gatewayBaseUrl,
			ownerPrincipal,
			graphId,
			toolProfile: "full",
			runtime: "choreograph-platform-release-edge",
			label: `platform-release-grant:${graphId}`,
			requestTimeoutMs: this.requestTimeoutMs,
			requiredTools: ["read_document"],
			serviceAuth,
			fetchFn: this.fetchFn,
		});
		try {
			await proxy.start();
			return { proxy, writer: makeHostedGraphWriter(proxy) };
		} catch (error) {
			await proxy.close().catch(() => {});
			throw platformReleaseRetryable("platform-release-grant-graph-unavailable", error);
		}
	}
}

export function startHostedPlatformReleaseEffectWorkerFromEnv(
	runtime: WorkflowRuntimeStore,
	env: Readonly<Record<string, string | undefined>> = process.env,
	fetchFn: typeof fetch = fetch,
): PlatformReleaseEffectWorker | undefined {
	if (!enabled(env.PLATFORM_RELEASE_EFFECT_WORKER_ENABLED)) return undefined;
	const requestTimeoutMs = optionalInteger(
		env.PLATFORM_RELEASE_EFFECT_REQUEST_TIMEOUT_MS,
		240_000,
		"PLATFORM_RELEASE_EFFECT_REQUEST_TIMEOUT_MS",
	);
	if (requestTimeoutMs > 240_000) {
		throw new Error("PLATFORM_RELEASE_EFFECT_REQUEST_TIMEOUT_MS must not exceed the cloud-2 request envelope");
	}
	const host = new HostedPlatformReleaseEffectHost({
		gatewayBaseUrl: requiredEnv(env, "MNEMOSYNE_GATEWAY_BASE_URL"),
		serviceToken: requiredEnv(env, "MNEMOSYNE_SERVICE_TOKEN"),
		requestTimeoutMs,
		fetchFn,
	});
	const leaseMs = optionalInteger(env.PLATFORM_RELEASE_EFFECT_LEASE_MS, 600_000, "PLATFORM_RELEASE_EFFECT_LEASE_MS");
	if (leaseMs < requestTimeoutMs * 2 + 30_000) {
		throw new Error("PLATFORM_RELEASE_EFFECT_LEASE_MS must cover grant reread plus the hosted realization request");
	}
	return new PlatformReleaseEffectWorker(runtime, host, undefined, {
		consumer: env.PLATFORM_RELEASE_EFFECT_CONSUMER?.trim() || "choreograph-platform-release-edge",
		pollMs: optionalInteger(env.PLATFORM_RELEASE_EFFECT_POLL_MS, 1_000, "PLATFORM_RELEASE_EFFECT_POLL_MS"),
		leaseMs,
		log: (message, error) => console.error(`[platform-release-effect] ${message}`, error ?? ""),
	});
}

async function boundedJson(response: Response): Promise<unknown> {
	let text: string;
	try {
		text = await response.text();
	} catch (error) {
		throw platformReleaseRetryable("platform-realization-response-unreadable", error);
	}
	if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
		throw platformReleaseTerminal("platform-realization-response-too-large");
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw platformReleaseRetryable("platform-realization-response-invalid-json", error);
	}
}

function normalizeOrigin(value: string, label: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label} must be an absolute URL`);
	}
	if (!/^https?:$/.test(url.protocol) || !url.host || url.username || url.password || url.search || url.hash) {
		throw new Error(`${label} must be a credential-free http(s) origin`);
	}
	return url.toString().replace(/\/$/, "");
}

function requireUserPrincipal(value: string, label: string): string {
	const match = USER_PRINCIPAL.exec(value);
	if (!match) {
		throw platformReleaseTerminal(
			"platform-release-user-owner-required",
			new Error(`${label} must be user:<subject>`),
		);
	}
	return match[1]!;
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`platform release effect worker requires ${name}`);
	return value;
}

function optionalInteger(value: string | undefined, fallback: number, label: string): number {
	if (!value?.trim()) return fallback;
	return positiveInteger(Number(value), label);
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
	return value;
}

function enabled(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true";
}
