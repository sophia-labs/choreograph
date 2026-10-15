import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { RawPriceOverride, RawPricing } from "./billing-rate-card.js";
import { OpenRouterUsageTap, type UsageTapSession } from "./openrouter-usage-tap.js";
import { isKnownProvider, PROVIDER_REGISTRY, resolveProviderEntry } from "./provider-registry.js";
import type { ProxyAssistantMessageEvent } from "./wire-protocol.js";

export interface OpenRouterOptions {
	apiKey?: string;
	referer?: string;
	title?: string;
}

/** Options for the provider-keyed egress. `referer`/`title` apply only to openrouter. */
export interface ProxyLlmOptions {
	/** The process env to read the provider's key from (default process.env). */
	env?: NodeJS.ProcessEnv;
	/** Explicit trusted-host credential. Required for owner-scoped OAuth providers. */
	apiKey?: string;
	/** Stable host session identity for provider-side cache affinity. */
	sessionId?: string;
	/** Force a transport where provider/runtime compatibility requires it. */
	transport?: "sse" | "websocket" | "websocket-cached" | "auto";
	/** OpenRouter attribution headers (ignored for non-openrouter providers). */
	referer?: string;
	title?: string;
	/**
	 * Send the call through the loopback usage tap and put OpenRouter's own charge for it on the terminal event
	 * (`providerUsage`). Used for the fallback call, which is billed at that charge (`openrouter-fallback.ts`).
	 */
	tapUsage?: boolean;
}

export interface LoadOpenRouterModelCatalogOptions extends OpenRouterOptions {
	category?: string;
	includeLive?: boolean;
	/** Treat a failed/malformed live response as a failed refresh instead of a static-only result. */
	failOnLiveError?: boolean;
}

export interface ListOpenRouterModelsOptions extends LoadOpenRouterModelCatalogOptions {
	query?: string;
	limit?: number;
	sort?: "id" | "prompt_price";
}

export interface PiCatalogModel {
	id: string;
	name: string;
	api: string;
	provider: string;
	baseUrl: string;
	reasoning: boolean;
	input: string[];
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	contextWindow: number;
	maxTokens: number;
}

/**
 * A live model's `pricing` object as the catalogue states it: USD per token as decimal strings, plus dimensions
 * (`input_cache_write_1h`, `internal_reasoning`, `web_search`, `overrides`, ...) that come and go. The named keys
 * are the ones the host has always read; the rest is kept verbatim in the row's `pricing_raw`.
 */
export interface OpenRouterLivePricing {
	prompt?: string;
	completion?: string;
	request?: string;
	image?: string;
	/** Per cached prompt token read / written, when the provider prices caching. */
	input_cache_read?: string;
	input_cache_write?: string;
	[key: string]: unknown;
}

export interface OpenRouterLiveModel {
	id: string;
	canonical_slug?: string;
	name?: string;
	description?: string;
	created?: number;
	pricing?: OpenRouterLivePricing;
	context_length?: number;
	architecture?: {
		modality?: string;
		input_modalities?: string[];
		output_modalities?: string[];
		tokenizer?: string;
		instruct_type?: string;
	};
	top_provider?: {
		is_moderated?: boolean;
		context_length?: number;
		max_completion_tokens?: number;
	};
	supported_parameters?: string[];
}

export interface OpenRouterModelRow {
	id: string;
	canonical_id: string | null;
	name: string;
	description: string | null;
	created: number | null;
	prompt_price: number | null;
	completion_price: number | null;
	request_price: number | null;
	image_price: number | null;
	/** USD per cached prompt token read / written; null when the provider states no cache price. */
	cache_read_price: number | null;
	cache_write_price: number | null;
	/**
	 * The model's whole `pricing` object as the catalogue states it: exact decimal strings and the overrides,
	 * verbatim (the floats above lose digits, and drop the tiers). What a Session is billed from; null for a model
	 * the provider does not list live.
	 */
	pricing_raw: RawPricing | null;
	context_length: number | null;
	max_completion_tokens: number | null;
	input_modalities: string[] | null;
	output_modalities: string[] | null;
	supported_parameters: string[] | null;
	supports_tools: boolean | null;
	reasoning: boolean | null;
	api: string | null;
	base_url: string | null;
	catalog_cost_per_million: PiCatalogModel["cost"] | null;
	live_available: boolean;
	catalog_available: boolean;
}

export interface OpenRouterCatalogPayload {
	provider: "openrouter";
	fetched_at: string;
	auth_configured: boolean;
	catalog_count: number;
	live_count: number;
	live_error?: string;
	models: OpenRouterModelRow[];
}

let piAiPromise: Promise<any> | undefined;

/**
 * The retention an OpenRouter call asks for, named here so the host's environment cannot change it. A Session priced
 * from the catalogue is billed cache writes at the listed (five-minute) price, the only kind this host asks for. Pi
 * asks OpenRouter's Anthropic models for a ONE-HOUR write (`cache_control` ttl `1h`, dearer, and not counted apart
 * in the ledger) when `PI_CACHE_RETENTION=long` is in the environment, which would quietly bill every write too low.
 */
/**
 * The provider's own id for a call, as Pi keeps it on the final message (`responseId`; OpenRouter: the generation id).
 * Settlement keeps it on the usage event, so the call can be looked up in the provider's record of what it charged.
 */
function responseIdOf(message: unknown): { responseId?: string } {
	const id = (message as { responseId?: unknown } | null | undefined)?.responseId;
	return typeof id === "string" && id.length > 0 && Buffer.byteLength(id, "utf8") <= 200 ? { responseId: id } : {};
}

function openRouterCacheRetention(provider: string): { cacheRetention?: "short" } {
	return provider === "openrouter" ? { cacheRetention: "short" } : {};
}

/**
 * An OpenRouter call goes out only through Pi's openai-completions serializer: it is the one that sends the model's
 * `compat.openRouterRouting` as the request's `provider` (the host's `require_parameters`, price cap and sort). Any
 * other API for OpenRouter would leave without them (exam 1, finding 6), so it is refused before a byte is sent.
 */
function assertOpenRouterApi(provider: string, model: unknown): void {
	if (provider !== "openrouter") return;
	const api = (model as { api?: unknown } | null)?.api;
	if (api !== undefined && api !== "openai-completions") {
		throw new Error(
			`OpenRouter calls must use the openai-completions API, which carries provider routing (require_parameters); refused ${String(api)}`,
		);
	}
}

/** Read the provider id off a resolved Pi model object (default "openrouter"). */
function providerOf(model: unknown): string {
	if (model && typeof model === "object") {
		const p = (model as { provider?: unknown }).provider;
		if (typeof p === "string" && p.length > 0) return p;
	}
	return "openrouter";
}

/**
 * Provider-keyed LLM egress (CA-1 shared substrate). The host-mediated LLM proxy
 * dispatches HERE: it reads the provider off the resolved model, looks up the
 * egress `{ baseUrl, keyEnv }` in the provider registry, resolves that provider's
 * key from env, and streams via Pi's `streamSimple`. An UNKNOWN provider is the
 * ONLY rejection (the generalized "400 for unknown" — was previously a hardcoded
 * OpenRouter pipe). OpenRouter keeps its attribution headers; other providers do
 * not get them. The key is passed EXPLICITLY (from `keyEnv`) so the egress, not
 * Pi's internal env-fallback, owns key selection and the missing-key error.
 */
export async function* proxyLlmRequest(
	model: unknown,
	context: unknown,
	options: ProxyLlmOptions = {},
): AsyncGenerator<ProxyAssistantMessageEvent> {
	const env = options.env ?? process.env;
	const provider = providerOf(model);
	assertOpenRouterApi(provider, model);

	const entry = resolveProviderEntry(provider);
	if (!entry) {
		throw new Error(`Unsupported LLM provider: "${provider}" (known: ${Object.keys(PROVIDER_REGISTRY).join(", ")})`);
	}

	const apiKey = options.apiKey ?? env[entry.credential.keyEnv];
	if (!apiKey) throw new Error(`${entry.credential.keyEnv} is required for non-mock ${provider} models`);

	const { streamSimple } = await loadPiAiModule();
	// OpenRouter attribution headers are provider-specific; only send them for openrouter.
	const headers =
		provider === "openrouter"
			? buildOpenRouterHeaders({ referer: options.referer, title: options.title })
			: undefined;
	let tap: UsageTapSession | undefined;
	let routedModel = model;
	const upstreamBaseUrl = (model as { baseUrl?: unknown } | null)?.baseUrl;
	if (options.tapUsage && provider === "openrouter" && typeof upstreamBaseUrl === "string" && upstreamBaseUrl) {
		tap = await usageTap().open(upstreamBaseUrl);
		routedModel = { ...(model as Record<string, unknown>), baseUrl: tap.baseUrl };
	}
	const stream = streamSimple(routedModel as any, context as any, {
		apiKey,
		headers,
		sessionId: options.sessionId,
		transport: options.transport,
		...openRouterCacheRetention(provider),
	});

	try {
		for await (const event of stream) {
			const proxied = toProxyEvent(event);
			if (tap && proxied.type === "done") {
				const charged = await tap.usage();
				yield charged ? { ...proxied, providerUsage: { ...charged } } : proxied;
				continue;
			}
			yield proxied;
		}
	} finally {
		tap?.close();
	}
}

let sharedUsageTap: OpenRouterUsageTap | undefined;
function usageTap(): OpenRouterUsageTap {
	sharedUsageTap ??= new OpenRouterUsageTap();
	return sharedUsageTap;
}

/**
 * Back-compat shim: the OpenRouter-specific egress entry point. Delegates to the
 * provider-keyed {@link proxyLlmRequest} — preserved so existing callers passing
 * an explicit `apiKey` keep working byte-for-byte. When `model.provider` is
 * openrouter (the common case) this is identical to before; when it is a known
 * non-openrouter provider, the registry routes it correctly.
 */
export async function* proxyOpenRouterRequest(
	model: unknown,
	context: unknown,
	options: OpenRouterOptions,
): AsyncGenerator<ProxyAssistantMessageEvent> {
	const provider = providerOf(model);
	// Honor an explicit apiKey only when it matches the openrouter egress; otherwise
	// defer to the provider-keyed env resolution. Preserves the legacy contract
	// (explicit OPENROUTER_API_KEY passed by the spawner for an openrouter model).
	if (provider === "openrouter" && options.apiKey) {
		assertOpenRouterApi(provider, model);
		if (!isKnownProvider(provider)) {
			throw new Error(`Unsupported LLM provider: "${provider}"`);
		}
		const { streamSimple } = await loadPiAiModule();
		const headers = buildOpenRouterHeaders(options);
		const stream = streamSimple(model as any, context as any, {
			apiKey: options.apiKey,
			headers,
			...openRouterCacheRetention(provider),
		});
		for await (const event of stream) {
			yield toProxyEvent(event);
		}
		return;
	}
	yield* proxyLlmRequest(model, context, { referer: options.referer, title: options.title });
}

export async function loadOpenRouterModelCatalog(
	options: LoadOpenRouterModelCatalogOptions = {},
): Promise<OpenRouterCatalogPayload> {
	const { getModels } = await loadPiAiModule();
	const catalog = (getModels("openrouter") as PiCatalogModel[]) ?? [];

	let live: OpenRouterLiveModel[] = [];
	let liveError: string | undefined;

	if (options.includeLive !== false) {
		try {
			live = await fetchOpenRouterModels(options);
		} catch (err) {
			liveError = err instanceof Error ? err.message : String(err);
			if (options.failOnLiveError) throw err;
		}
	}

	const merged = mergeOpenRouterModelCatalogs(catalog, live);
	return {
		provider: "openrouter",
		fetched_at: new Date().toISOString(),
		auth_configured: Boolean(options.apiKey),
		catalog_count: catalog.length,
		live_count: live.length,
		...(liveError ? { live_error: liveError } : {}),
		models: merged,
	};
}

export async function listOpenRouterModels(
	options: ListOpenRouterModelsOptions = {},
): Promise<OpenRouterCatalogPayload> {
	const catalog = await loadOpenRouterModelCatalog(options);
	return selectOpenRouterModels(catalog, options);
}

export function selectOpenRouterModels(
	catalog: OpenRouterCatalogPayload,
	options: Pick<ListOpenRouterModelsOptions, "query" | "limit" | "sort"> = {},
): OpenRouterCatalogPayload {
	const query = options.query?.trim().toLowerCase();
	let filtered = query
		? catalog.models.filter((model) =>
				[String(model.id), String(model.name ?? ""), String(model.description ?? "")]
					.join(" ")
					.toLowerCase()
					.includes(query),
			)
		: catalog.models;

	filtered = [...filtered].sort((a, b) => {
		if (options.sort === "prompt_price") {
			const priceA = sortPrice(a.prompt_price);
			const priceB = sortPrice(b.prompt_price);
			if (priceA !== priceB) return priceA - priceB;
		}
		return String(a.id).localeCompare(String(b.id));
	});

	const limit = clampLimit(options.limit);

	return {
		...catalog,
		models: filtered.slice(0, limit),
	};
}

function resolveWorkspaceRoot(): string {
	if (process.env.WORKSPACE_ROOT) {
		return resolve(process.env.WORKSPACE_ROOT);
	}
	return resolve(process.cwd());
}

function loadPiAiModule(): Promise<any> {
	if (!piAiPromise) {
		// Try the npm-installed package first (deployed tarball), then the submodule path (dev).
		piAiPromise = import("@earendil-works/pi-ai").catch(() => {
			const modulePath = join(resolveWorkspaceRoot(), "pi", "packages", "ai", "dist", "index.js");
			return import(pathToFileURL(modulePath).href);
		});
	}
	return piAiPromise;
}

function buildOpenRouterHeaders(options: OpenRouterOptions): Record<string, string> | undefined {
	const headers: Record<string, string> = {};
	if (options.referer) {
		headers["HTTP-Referer"] = options.referer;
	}
	if (options.title) {
		headers["X-OpenRouter-Title"] = options.title;
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

export async function fetchOpenRouterModels(
	options: OpenRouterOptions & { category?: string },
): Promise<OpenRouterLiveModel[]> {
	const params = new URLSearchParams();
	if (options.category) {
		params.set("category", options.category);
	}

	const headers: Record<string, string> = {
		"content-type": "application/json",
		...buildOpenRouterHeaders(options),
	};
	if (options.apiKey) {
		headers.Authorization = `Bearer ${options.apiKey}`;
	}

	const response = await fetch(
		`https://openrouter.ai/api/v1/models${params.size > 0 ? `?${params.toString()}` : ""}`,
		{ headers },
	);
	if (!response.ok) {
		throw new Error(`OpenRouter models request failed: ${response.status} ${response.statusText}`);
	}

	const payload = (await response.json()) as { data?: OpenRouterLiveModel[] };
	if (!Array.isArray(payload.data)) {
		throw new Error("OpenRouter models response did not contain a data array");
	}
	return payload.data;
}

export function mergeOpenRouterModelCatalogs(
	catalog: PiCatalogModel[],
	live: OpenRouterLiveModel[],
): OpenRouterModelRow[] {
	const catalogMap = new Map(catalog.map((model) => [model.id, model]));
	const liveMap = new Map(live.map((model) => [model.id, model]));
	const liveCanonicalMap = new Map<string, OpenRouterLiveModel[]>();

	for (const model of live) {
		if (!model.canonical_slug) continue;
		const matches = liveCanonicalMap.get(model.canonical_slug) ?? [];
		matches.push(model);
		liveCanonicalMap.set(model.canonical_slug, matches);
	}

	const allIds = new Set<string>([...catalogMap.keys(), ...liveMap.keys()]);

	const rows = Array.from(allIds, (id) => {
		const catalogModel = catalogMap.get(id);
		const liveModel = liveMap.get(id) ?? selectCanonicalLiveMatch(liveCanonicalMap.get(id), catalogModel);
		const supportedParameters = liveModel?.supported_parameters ?? null;
		return {
			id: liveModel?.id ?? catalogModel?.id ?? id,
			canonical_id:
				liveModel?.canonical_slug && liveModel.canonical_slug !== (liveModel.id ?? catalogModel?.id ?? id)
					? liveModel.canonical_slug
					: null,
			name: liveModel?.name ?? catalogModel?.name ?? id,
			description: liveModel?.description ?? null,
			created: liveModel?.created ?? null,
			prompt_price: parseNumeric(liveModel?.pricing?.prompt),
			completion_price: parseNumeric(liveModel?.pricing?.completion),
			request_price: parseNumeric(liveModel?.pricing?.request),
			image_price: parseNumeric(liveModel?.pricing?.image),
			cache_read_price: parseNumeric(liveModel?.pricing?.input_cache_read),
			cache_write_price: parseNumeric(liveModel?.pricing?.input_cache_write),
			pricing_raw: normalizeRawPricing(liveModel?.pricing),
			context_length:
				liveModel?.context_length ?? liveModel?.top_provider?.context_length ?? catalogModel?.contextWindow ?? null,
			max_completion_tokens: liveModel?.top_provider?.max_completion_tokens ?? catalogModel?.maxTokens ?? null,
			input_modalities: liveModel?.architecture?.input_modalities ?? catalogModel?.input ?? null,
			output_modalities: liveModel?.architecture?.output_modalities ?? null,
			supported_parameters: supportedParameters,
			supports_tools: Array.isArray(supportedParameters) ? supportedParameters.includes("tools") : null,
			reasoning: catalogModel?.reasoning ?? null,
			api: catalogModel?.api ?? null,
			base_url: catalogModel?.baseUrl ?? null,
			catalog_cost_per_million: catalogModel?.cost ?? null,
			live_available: Boolean(liveModel),
			catalog_available: Boolean(catalogModel),
		};
	});

	const deduped = new Map<string, OpenRouterModelRow>();
	for (const row of rows) {
		const id = String(row.id);
		const existing = deduped.get(id);
		deduped.set(id, existing ? mergeModelRows(existing, row) : row);
	}

	return Array.from(deduped.values());
}

const MAX_RAW_PRICING_KEYS = 32;
const MAX_RAW_OVERRIDES = 32;
const MAX_RAW_OVERRIDE_KEYS = 16;
const MAX_RAW_TEXT_CHARS = 128;
/** A price key: lower snake case, or one of the host's own `?` markers. */
const RAW_PRICING_KEY = /^\??[a-z][a-z0-9_]{0,63}$/;
/** Stands where the catalogue sent something a price cannot be: never a number, never blank, never a price. */
const UNREADABLE = "?";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawText(value: unknown): string {
	return typeof value === "string" && value.length <= MAX_RAW_TEXT_CHARS ? value : UNREADABLE;
}

function normalizeRawOverride(value: unknown): RawPriceOverride {
	if (!isPlainObject(value)) return {};
	const out: Record<string, string | number> = {};
	let count = 0;
	for (const [key, entry] of Object.entries(value)) {
		if (count >= MAX_RAW_OVERRIDE_KEYS) {
			out["?truncated"] = UNREADABLE;
			break;
		}
		count += 1;
		const name = RAW_PRICING_KEY.test(key) ? key : "?key";
		out[name] = typeof entry === "number" && Number.isSafeInteger(entry) ? entry : rawText(entry);
	}
	return out;
}

/**
 * A model's `pricing` object, kept verbatim for billing: price strings as strings, `overrides` as a list of
 * objects of strings and integers, and a `?` marker (never a valid price, never a known key) for anything else,
 * so an oddity is refused downstream rather than silently dropped or read as a price. Bounded, and idempotent, so a
 * snapshot's digest verifies after it is written and read back. Null when there is no pricing object at all.
 */
export function normalizeRawPricing(value: unknown): RawPricing | null {
	if (!isPlainObject(value)) return null;
	const out: Record<string, string | readonly RawPriceOverride[]> = {};
	let count = 0;
	for (const [key, entry] of Object.entries(value)) {
		if (count >= MAX_RAW_PRICING_KEYS) {
			out["?truncated"] = UNREADABLE;
			break;
		}
		count += 1;
		if (key === "overrides") {
			out.overrides = Array.isArray(entry)
				? [
						...entry.slice(0, MAX_RAW_OVERRIDES).map(normalizeRawOverride),
						...(entry.length > MAX_RAW_OVERRIDES ? [{ "?truncated": UNREADABLE }] : []),
					]
				: UNREADABLE;
			continue;
		}
		out[RAW_PRICING_KEY.test(key) ? key : "?key"] = rawText(entry);
	}
	return out;
}

function parseNumeric(value?: string): number | null {
	if (value == null) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function clampLimit(value?: number): number {
	if (value == null || Number.isNaN(value)) return 100;
	return Math.max(1, Math.min(500, Math.trunc(value)));
}

function sortPrice(value: unknown): number {
	const numeric = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(numeric) || numeric < 0) return Number.POSITIVE_INFINITY;
	return numeric;
}

function mergeModelRows(base: OpenRouterModelRow, next: OpenRouterModelRow): OpenRouterModelRow {
	const merged = { ...base } as OpenRouterModelRow & Record<string, unknown>;
	for (const [key, value] of Object.entries(next)) {
		if (key === "live_available" || key === "catalog_available" || key === "supports_tools") {
			merged[key] = Boolean(base[key]) || Boolean(value);
			continue;
		}
		if (merged[key] == null && value != null) {
			merged[key] = value;
		}
	}
	return merged;
}

function selectCanonicalLiveMatch(
	liveModels: OpenRouterLiveModel[] | undefined,
	catalogModel: PiCatalogModel | undefined,
): OpenRouterLiveModel | undefined {
	if (!liveModels || liveModels.length === 0) return undefined;
	if (liveModels.length === 1) return liveModels[0];

	if (catalogModel) {
		const exactNameMatch = liveModels.find((model) => model.name === catalogModel.name);
		if (exactNameMatch) return exactNameMatch;
	}

	return [...liveModels].sort((a, b) => {
		const priceA = sortPrice(parseNumeric(a.pricing?.prompt));
		const priceB = sortPrice(parseNumeric(b.pricing?.prompt));
		if (priceA !== priceB) return priceA - priceB;
		return a.id.localeCompare(b.id);
	})[0];
}

function toProxyEvent(event: any): ProxyAssistantMessageEvent {
	switch (event.type) {
		case "start":
			return { type: "start" };

		case "text_start":
			return { type: "text_start", contentIndex: event.contentIndex };

		case "text_delta":
			return { type: "text_delta", contentIndex: event.contentIndex, delta: event.delta };

		case "text_end": {
			const content = event.partial?.content?.[event.contentIndex];
			return {
				type: "text_end",
				contentIndex: event.contentIndex,
				contentSignature: content?.type === "text" ? content.textSignature : undefined,
			};
		}

		case "thinking_start":
			return { type: "thinking_start", contentIndex: event.contentIndex };

		case "thinking_delta":
			return { type: "thinking_delta", contentIndex: event.contentIndex, delta: event.delta };

		case "thinking_end": {
			const content = event.partial?.content?.[event.contentIndex];
			return {
				type: "thinking_end",
				contentIndex: event.contentIndex,
				contentSignature: content?.type === "thinking" ? content.thinkingSignature : undefined,
			};
		}

		case "toolcall_start": {
			const content = event.partial?.content?.[event.contentIndex];
			return {
				type: "toolcall_start",
				contentIndex: event.contentIndex,
				id: content?.type === "toolCall" ? content.id : "",
				toolName: content?.type === "toolCall" ? content.name : "",
			};
		}

		case "toolcall_delta":
			return { type: "toolcall_delta", contentIndex: event.contentIndex, delta: event.delta };

		case "toolcall_end":
			return { type: "toolcall_end", contentIndex: event.contentIndex };

		case "done":
			return { type: "done", reason: event.reason, usage: event.message.usage, ...responseIdOf(event.message) };

		case "error":
			return {
				type: "error",
				reason: event.reason,
				errorMessage: event.error?.errorMessage,
				usage: event.error?.usage ?? {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				...responseIdOf(event.error),
			};
	}

	throw new Error(`Unsupported assistant event type: ${event?.type}`);
}
