/** Hosted cloud-2 transport for the Phanes-standard scratch-cell effect edge. */

import { HostedMnemosyneProxy, type HostedServiceAuthConfig } from "../mnemosyne.js";
import { developmentRetryable, developmentTerminal } from "./development-effect.js";
import { type GraphWriter, makeHostedGraphWriter } from "./graph-writer.js";
import type { EffectHandoffRecord, WorkflowRuntimeStore } from "./runtime-store.js";
import {
	type ScratchEffectHost,
	ScratchEffectWorker,
	type ScratchMaterializationRequestV1,
	type ScratchMaterializationResponseV1,
} from "./scratch-effect-worker.js";

const USER_PRINCIPAL = /^user:([A-Za-z0-9_.@:-]{1,192})$/;
const GRAPH_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const MAX_RESPONSE_BYTES = 1_048_576;

export interface HostedScratchEffectConfig {
	readonly gatewayBaseUrl: string;
	readonly serviceToken: string;
	readonly requestTimeoutMs?: number;
	readonly fetchFn?: typeof fetch;
}

interface HostedGraphHandle {
	readonly proxy: HostedMnemosyneProxy;
	readonly writer: GraphWriter;
}

export class HostedScratchEffectHost implements ScratchEffectHost {
	private readonly gatewayBaseUrl: string;
	private readonly fetchFn: typeof fetch;
	private readonly requestTimeoutMs: number;
	private readonly grantHandles = new Map<string, Promise<HostedGraphHandle>>();

	constructor(private readonly config: HostedScratchEffectConfig) {
		this.gatewayBaseUrl = normalizeOrigin(config.gatewayBaseUrl, "scratch gateway");
		if (!config.serviceToken.trim()) throw new Error("scratch effect service token is empty");
		this.fetchFn = config.fetchFn ?? fetch;
		this.requestTimeoutMs = positiveInteger(config.requestTimeoutMs ?? 60_000, "scratch request timeout");
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
		if (!document.text?.trim()) throw developmentRetryable("scratch-grant-document-empty");
		return document.text;
	}

	async materialize(request: ScratchMaterializationRequestV1): Promise<ScratchMaterializationResponseV1> {
		const actorSub = requireUserPrincipal(request.target.ownerPrincipal, "scratch owner");
		if (!GRAPH_ID.test(request.target.scratchGraphId) || !request.target.scratchGraphId.startsWith("dev-")) {
			throw developmentTerminal("scratch-graph-invalid");
		}
		let response: Response;
		try {
			response = await this.fetchFn(`${this.gatewayBaseUrl}/internal/scratch-cells/materialize`, {
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
			throw developmentRetryable("scratch-materialization-unavailable", error);
		}
		if (!response.ok) {
			const code = `scratch-materialization-http-${response.status}`;
			if (response.status === 429 || response.status >= 500) throw developmentRetryable(code);
			throw developmentTerminal(code);
		}
		return (await boundedJson(response)) as ScratchMaterializationResponseV1;
	}

	async close(): Promise<void> {
		const handles = await Promise.allSettled([...this.grantHandles.values()]);
		await Promise.allSettled(
			handles.flatMap((result) => (result.status === "fulfilled" ? [result.value.proxy.close()] : [])),
		);
		this.grantHandles.clear();
	}

	private grantGraph(ownerPrincipal: string, graphId: string, actorSub: string): Promise<HostedGraphHandle> {
		if (!GRAPH_ID.test(graphId)) return Promise.reject(developmentTerminal("scratch-grant-graph-invalid"));
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
			runtime: "choreograph-scratch-edge",
			label: `scratch-grant:${graphId}`,
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
			throw developmentRetryable("scratch-grant-graph-unavailable", error);
		}
	}
}

export function startHostedScratchEffectWorkerFromEnv(
	runtime: WorkflowRuntimeStore,
	env: Readonly<Record<string, string | undefined>> = process.env,
	fetchFn: typeof fetch = fetch,
): ScratchEffectWorker | undefined {
	if (!enabled(env.SCRATCH_EFFECT_WORKER_ENABLED)) return undefined;
	const host = new HostedScratchEffectHost({
		gatewayBaseUrl: requiredEnv(env, "MNEMOSYNE_GATEWAY_BASE_URL"),
		serviceToken: requiredEnv(env, "MNEMOSYNE_SERVICE_TOKEN"),
		requestTimeoutMs: optionalInteger(
			env.SCRATCH_EFFECT_REQUEST_TIMEOUT_MS,
			60_000,
			"SCRATCH_EFFECT_REQUEST_TIMEOUT_MS",
		),
		fetchFn,
	});
	return new ScratchEffectWorker(runtime, host, undefined, {
		consumer: env.SCRATCH_EFFECT_CONSUMER?.trim() || "choreograph-scratch-edge",
		pollMs: optionalInteger(env.SCRATCH_EFFECT_POLL_MS, 1_000, "SCRATCH_EFFECT_POLL_MS"),
		leaseMs: optionalInteger(env.SCRATCH_EFFECT_LEASE_MS, 60_000, "SCRATCH_EFFECT_LEASE_MS"),
		log: (message, error) => console.error(`[scratch-effect] ${message}`, error ?? ""),
	});
}

async function boundedJson(response: Response): Promise<unknown> {
	let text: string;
	try {
		text = await response.text();
	} catch (error) {
		throw developmentRetryable("scratch-materialization-response-unreadable", error);
	}
	if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
		throw developmentTerminal("scratch-materialization-response-too-large");
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw developmentRetryable("scratch-materialization-response-invalid-json", error);
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
	if (!match) throw developmentTerminal("scratch-user-owner-required", new Error(`${label} must be user:<subject>`));
	return match[1]!;
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`scratch effect worker requires ${name}`);
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
