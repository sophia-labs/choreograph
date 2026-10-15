/** Hosted cloud-2 transport for the Phanes-standard site effect worker. */

import { HostedMnemosyneProxy, type HostedServiceAuthConfig } from "../mnemosyne.js";
import type { CaptureEmitter } from "../observatory-capture.js";
import { type GraphWriter, makeHostedGraphWriter } from "./graph-writer.js";
import type { CommittedSiteTarget } from "./proposed-effect.js";
import type { EffectHandoffRecord, WorkflowRuntimeStore } from "./runtime-store.js";
import {
	REVIEWED_GARDEN_SITE_BUNDLE,
	type ReviewedSiteBundleV1,
	SiteEffectError,
	SiteEffectExecutor,
	type SiteEffectHost,
	SiteEffectWorker,
	type SiteMaterializationRequestV1,
} from "./site-effect-worker.js";

const USER_PRINCIPAL = /^user:([A-Za-z0-9_.@:-]{1,192})$/;
const GRAPH_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface HostedSiteEffectConfig {
	readonly gatewayBaseUrl: string;
	readonly serviceToken: string;
	readonly routeRegistryOwnerPrincipal: string;
	readonly routeRegistryGraphId: string;
	readonly routeRegistryActorSub?: string;
	readonly requestTimeoutMs?: number;
	readonly bundle?: ReviewedSiteBundleV1;
	readonly fetchFn?: typeof fetch;
}

interface HostedGraphHandle {
	readonly proxy: HostedMnemosyneProxy;
	readonly writer: GraphWriter;
}

interface ControlGraphRecord {
	readonly owner: string;
	readonly graphId: string;
	readonly description?: string;
	readonly lifecycleState?: string;
}

/**
 * Credential-bearing transport. Every request chooses an exact typed graph
 * owner and an explicit user assertion; neither is accepted from proposal
 * fields because the proposal has already been rebound to the source turn.
 */
export class HostedSiteEffectHost implements SiteEffectHost {
	readonly siteSourceEndpoint: string;
	readonly bundle: ReviewedSiteBundleV1;
	private readonly gatewayBaseUrl: string;
	private readonly fetchFn: typeof fetch;
	private readonly requestTimeoutMs: number;
	private readonly handles = new Map<string, Promise<HostedGraphHandle>>();

	constructor(private readonly config: HostedSiteEffectConfig) {
		this.gatewayBaseUrl = normalizeOrigin(config.gatewayBaseUrl, "site gateway");
		if (!config.serviceToken.trim()) throw new Error("site effect service token is empty");
		requireUserPrincipal(config.routeRegistryOwnerPrincipal, "site route registry owner");
		if (!GRAPH_ID.test(config.routeRegistryGraphId)) throw new Error("site route registry graph id is invalid");
		if (config.routeRegistryActorSub && !USER_PRINCIPAL.test(`user:${config.routeRegistryActorSub}`)) {
			throw new Error("site route registry actor subject is invalid");
		}
		this.fetchFn = config.fetchFn ?? fetch;
		this.requestTimeoutMs = positiveInteger(config.requestTimeoutMs ?? 60_000, "site request timeout");
		this.siteSourceEndpoint = this.gatewayBaseUrl;
		this.bundle = config.bundle ?? REVIEWED_GARDEN_SITE_BUNDLE;
	}

	async readGrant(record: EffectHandoffRecord): Promise<string> {
		const actorSub = requireUserPrincipal(record.grant_authority_owner_principal, "grant authority owner");
		const handle = await this.graph(
			record.grant_authority_owner_principal,
			record.grant_authority_graph_id,
			actorSub,
			["read_document"],
			false,
		);
		const document = await handle.writer.readDocument(record.grant_authority_graph_id, record.grant_document_id, {
			format: "markdown",
		});
		if (!document.text?.trim()) throw new Error("current grant document is empty");
		return document.text;
	}

	async ensureGraph(input: {
		readonly ownerPrincipal: string;
		readonly graphId: string;
		readonly title: string;
		readonly description: string;
		readonly idempotencyKey: string;
	}): Promise<unknown> {
		const actorSub = requireUserPrincipal(input.ownerPrincipal, "site graph owner");
		if (!GRAPH_ID.test(input.graphId)) throw terminal("site-graph-id-invalid");
		if (!/^effect:[0-9a-f]{64}$/.test(input.idempotencyKey)) throw terminal("site-effect-identity-invalid");
		if (input.description !== `Sophia site graph; materialized by ${input.idempotencyKey}`) {
			throw terminal("site-graph-custody-marker-invalid");
		}
		const existing = await this.findGraph(actorSub, input.ownerPrincipal, input.graphId);
		if (existing) return assertGraphReplay(existing, input.description);
		try {
			return await this.controlTool(actorSub, "create_graph", {
				owner: input.ownerPrincipal,
				graphId: input.graphId,
				title: input.title,
				description: input.description,
			});
		} catch (error) {
			// A transport timeout or concurrent retry may occur after the canonical
			// create committed. Re-read and accept only our exact effect marker.
			const replay = await this.findGraph(actorSub, input.ownerPrincipal, input.graphId).catch(() => undefined);
			if (replay) return assertGraphReplay(replay, input.description);
			if (error instanceof SiteEffectError) throw error;
			throw retryable("site-graph-create-unavailable", error);
		}
	}

	async targetGraph(target: CommittedSiteTarget): Promise<GraphWriter> {
		const actorSub = requireUserPrincipal(target.ownerPrincipal, "site graph owner");
		return (await this.graph(target.ownerPrincipal, target.graphId, actorSub, ["sparql_query"], true)).writer;
	}

	async routeRegistryGraph(_record: EffectHandoffRecord): Promise<{ graphId: string; writer: GraphWriter }> {
		const actorSub =
			this.config.routeRegistryActorSub ??
			requireUserPrincipal(this.config.routeRegistryOwnerPrincipal, "site route registry owner");
		const handle = await this.graph(
			this.config.routeRegistryOwnerPrincipal,
			this.config.routeRegistryGraphId,
			actorSub,
			["sparql_query"],
			true,
		);
		return { graphId: this.config.routeRegistryGraphId, writer: handle.writer };
	}

	async materialize(ownerPrincipal: string, request: SiteMaterializationRequestV1): Promise<unknown> {
		const actorSub = requireUserPrincipal(ownerPrincipal, "site materialization owner");
		let response: Response;
		try {
			response = await this.fetchFn(new URL("/internal/site-publications/materialize", `${this.gatewayBaseUrl}/`), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.config.serviceToken}`,
					"content-type": "application/json",
					"x-pn-on-behalf-of": actorSub,
				},
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(this.requestTimeoutMs),
			});
		} catch (error) {
			throw retryable("site-materialization-unavailable", error);
		}
		if (!response.ok) {
			const code = `site-materialization-http-${response.status}`;
			if (response.status === 429 || response.status >= 500) throw retryable(code);
			throw terminal(code);
		}
		return responseTextJson(response);
	}

	async close(): Promise<void> {
		const handles = await Promise.allSettled([...this.handles.values()]);
		await Promise.allSettled(
			handles.flatMap((result) => (result.status === "fulfilled" ? [result.value.proxy.close()] : [])),
		);
		this.handles.clear();
	}

	private async findGraph(actorSub: string, owner: string, graphId: string): Promise<ControlGraphRecord | undefined> {
		const value = await this.controlTool(actorSub, "list_graphs", {});
		if (!Array.isArray(value)) throw retryable("site-control-list-invalid");
		return value.find(
			(candidate): candidate is ControlGraphRecord =>
				isRecord(candidate) && candidate.owner === owner && candidate.graphId === graphId,
		);
	}

	private async controlTool(actorSub: string, name: string, arguments_: Record<string, unknown>): Promise<unknown> {
		let response: Response;
		try {
			response = await this.fetchFn(new URL("/control/mcp", `${this.gatewayBaseUrl}/`), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.config.serviceToken}`,
					"content-type": "application/json",
					"x-pn-on-behalf-of": actorSub,
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: `site:${name}:${Date.now()}`,
					method: "tools/call",
					params: { name, arguments: arguments_ },
				}),
				signal: AbortSignal.timeout(this.requestTimeoutMs),
			});
		} catch (error) {
			throw retryable("site-control-unavailable", error);
		}
		if (!response.ok) {
			if (response.status === 429 || response.status >= 500) throw retryable(`site-control-http-${response.status}`);
			throw terminal(`site-control-http-${response.status}`);
		}
		const envelope = await responseTextJson(response);
		if (!isRecord(envelope)) throw retryable("site-control-response-invalid");
		if (isRecord(envelope.error)) {
			throw terminal("site-control-refused", new Error(String(envelope.error.message ?? "control tool refused")));
		}
		const result = isRecord(envelope.result) ? envelope.result.structuredContent : undefined;
		if (result === undefined) throw retryable("site-control-response-invalid");
		return result;
	}

	private graph(
		ownerPrincipal: string,
		graphId: string,
		actorSub: string,
		requiredTools: readonly string[],
		withEmporium: boolean,
	): Promise<HostedGraphHandle> {
		if (!GRAPH_ID.test(graphId)) return Promise.reject(terminal("site-graph-id-invalid"));
		const key = `${ownerPrincipal}\0${graphId}\0${actorSub}\0${withEmporium ? "rw" : "ro"}`;
		const existing = this.handles.get(key);
		if (existing) return existing;
		const created = this.openGraph(ownerPrincipal, graphId, actorSub, requiredTools, withEmporium).catch((error) => {
			this.handles.delete(key);
			throw error;
		});
		this.handles.set(key, created);
		return created;
	}

	private async openGraph(
		ownerPrincipal: string,
		graphId: string,
		actorSub: string,
		requiredTools: readonly string[],
		withEmporium: boolean,
	): Promise<HostedGraphHandle> {
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
			runtime: "choreograph-site-edge",
			label: `site-effect:${graphId}`,
			requestTimeoutMs: this.requestTimeoutMs,
			requiredTools,
			serviceAuth,
			fetchFn: this.fetchFn,
		});
		try {
			await proxy.start();
			const writer = makeHostedGraphWriter(
				proxy,
				withEmporium
					? {
							emporium: {
								baseUrl: this.gatewayBaseUrl,
								auth: {
									mode: "gateway",
									serviceToken: this.config.serviceToken,
									onBehalfOf: actorSub,
									ownerPrincipal,
								},
								fetchFn: this.fetchFn,
							},
						}
					: {},
			);
			return { proxy, writer };
		} catch (error) {
			await proxy.close().catch(() => {});
			throw retryable("site-graph-unavailable", error);
		}
	}
}

export function startHostedSiteEffectWorkerFromEnv(
	runtime: WorkflowRuntimeStore,
	env: Readonly<Record<string, string | undefined>> = process.env,
	fetchFn: typeof fetch = fetch,
	capture?: CaptureEmitter,
): SiteEffectWorker | undefined {
	if (!enabled(env.SITE_EFFECT_WORKER_ENABLED)) return undefined;
	const gatewayBaseUrl = requiredEnv(env, "MNEMOSYNE_GATEWAY_BASE_URL");
	const serviceToken = requiredEnv(env, "MNEMOSYNE_SERVICE_TOKEN");
	const routeRegistryOwnerPrincipal = requiredEnv(env, "SITE_ROUTE_REGISTRY_OWNER");
	const routeRegistryGraphId = requiredEnv(env, "SITE_ROUTE_REGISTRY_GRAPH");
	const requestTimeoutMs = optionalInteger(
		env.SITE_EFFECT_REQUEST_TIMEOUT_MS,
		60_000,
		"SITE_EFFECT_REQUEST_TIMEOUT_MS",
	);
	const host = new HostedSiteEffectHost({
		gatewayBaseUrl,
		serviceToken,
		routeRegistryOwnerPrincipal,
		routeRegistryGraphId,
		...(env.SITE_ROUTE_REGISTRY_ACTOR_SUB?.trim()
			? { routeRegistryActorSub: env.SITE_ROUTE_REGISTRY_ACTOR_SUB.trim() }
			: {}),
		requestTimeoutMs,
		bundle: reviewedBundleFromEnv(env),
		fetchFn,
	});
	return new SiteEffectWorker(runtime, host, new SiteEffectExecutor(host, host.bundle), {
		consumer: env.SITE_EFFECT_CONSUMER?.trim() || "choreograph-site-edge",
		pollMs: optionalInteger(env.SITE_EFFECT_POLL_MS, 1_000, "SITE_EFFECT_POLL_MS"),
		leaseMs: optionalInteger(env.SITE_EFFECT_LEASE_MS, 60_000, "SITE_EFFECT_LEASE_MS"),
		capture,
		log: (message, error) => console.error(`[site-effect] ${message}`, error ?? ""),
	});
}

export function reviewedBundleFromEnv(env: Readonly<Record<string, string | undefined>>): ReviewedSiteBundleV1 {
	const names = [
		"SITE_BUNDLE_ID",
		"SITE_BUNDLE_VERSION",
		"SITE_INTERPRETER_PACKAGE",
		"SITE_INTERPRETER_VERSION",
		"SITE_LAYOUT_SEED_SHA256",
		"SITE_EMPORIUM_PACK_VERSION",
		"SITE_EMPORIUM_PACK_SHA256",
	] as const;
	const present = names.filter((name) => env[name]?.trim());
	if (present.length === 0) return REVIEWED_GARDEN_SITE_BUNDLE;
	if (present.length !== names.length) {
		throw new Error(`reviewed site bundle override is incomplete; set all of ${names.join(", ")}`);
	}
	const bundle: ReviewedSiteBundleV1 = {
		bundleId: env.SITE_BUNDLE_ID!.trim(),
		bundleVersion: env.SITE_BUNDLE_VERSION!.trim(),
		packageName: env.SITE_INTERPRETER_PACKAGE!.trim(),
		version: env.SITE_INTERPRETER_VERSION!.trim(),
		layoutSeedSha256: env.SITE_LAYOUT_SEED_SHA256!.trim(),
		emporiumPackName: "shrubbery-site",
		emporiumPackVersion: env.SITE_EMPORIUM_PACK_VERSION!.trim(),
		emporiumPackSha256: env.SITE_EMPORIUM_PACK_SHA256!.trim(),
	};
	for (const value of [bundle.layoutSeedSha256, bundle.emporiumPackSha256]) {
		if (!SHA256.test(value)) throw new Error("reviewed site bundle override has an invalid SHA-256 digest");
	}
	return bundle;
}

function assertGraphReplay(record: ControlGraphRecord, description: string): ControlGraphRecord {
	if (record.description !== description) throw terminal("site-graph-already-exists");
	if (
		record.lifecycleState === "tombstoned" ||
		record.lifecycleState === "purged" ||
		record.lifecycleState === "purging"
	) {
		throw terminal("site-graph-not-visible");
	}
	return record;
}

async function responseTextJson(response: Response): Promise<unknown> {
	let text: string;
	try {
		text = await response.text();
	} catch (error) {
		throw retryable("site-response-unreadable", error);
	}
	if (!text) return {};
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw retryable("site-response-invalid-json", error);
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
	if (!match) throw terminal("site-user-owner-required", new Error(`${label} must be user:<subject>`));
	return match[1]!;
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`site effect worker requires ${name}`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function terminal(code: string, cause?: unknown): SiteEffectError {
	return new SiteEffectError(code, false, cause instanceof Error ? `${code}: ${cause.message}` : code);
}

function retryable(code: string, cause?: unknown): SiteEffectError {
	return new SiteEffectError(code, true, cause instanceof Error ? `${code}: ${cause.message}` : code);
}
