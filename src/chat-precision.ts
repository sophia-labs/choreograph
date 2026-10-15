/**
 * Precision: where a voice can be served, and at what quality (Vera's ruling, 2026-10-01: "let people choose").
 *
 * OpenRouter lists, per model, the providers ("endpoints") that serve it, each with its own price and the quantization it
 * serves at (`fp4`, `int4`, `fp8`, `bf16`, … or `unknown`). The catalogue's model-level price, which today's cards are
 * built from, is one provider's price, often a quantized one (Kimi K2.6: Baidu, fp4). A voice is therefore offered at:
 *
 *   any   today's card (the model-level price); any quantization the routing finds at or under that price;
 *   full  the cheapest live, tool-capable provider serving FP8 or better, at that provider's own price.
 *
 * "FP8 or better" is `fp8`, `fp16`, `bf16` or `fp32`. A provider that publishes no quantization (`unknown`) never
 * counts as full: full precision is a promise the host makes to a paying person, and an endpoint that does not say what
 * it serves cannot back it; and OpenRouter's `quantizations` filter cannot tell a lab serving its own weights from a
 * third party that does not say. The models their makers serve alone (most of OpenAI's, Anthropic's, Google's: 161 of
 * 287 voices on 2026-10-01, every endpoint `unknown`) have nothing to choose: they are offered at `any` only.
 *
 * An endpoint's listed `prompt` and `completion` are what OpenRouter charges; its numeric `discount` only says how far
 * that is below the maker's own price (2026-10-01: Baidu's $0.43415 and StreamLake's $0.5985 per million for Kimi K2.6
 * are Moonshot's $0.95 less their stated 0.543 and 0.37, and live calls were charged exactly the listed prices).
 */
import type { RawPricing } from "./billing-rate-card.js";

export type ChatPrecision = "any" | "full";
export const CHAT_PRECISIONS: readonly ChatPrecision[] = ["any", "full"];
export const DEFAULT_CHAT_PRECISION: ChatPrecision = "any";

/** OpenRouter's quantization labels that count as full precision, as its routing filter takes them. */
export const FULL_PRECISION_QUANTIZATIONS = ["fp8", "fp16", "bf16", "fp32"] as const;

/** Every label OpenRouter uses; a card's routing may only name these. */
export const OPENROUTER_QUANTIZATIONS: ReadonlySet<string> = new Set([
	"int4",
	"int8",
	"fp4",
	"fp6",
	"fp8",
	"fp16",
	"bf16",
	"fp32",
	"unknown",
]);

export function isChatPrecision(value: unknown): value is ChatPrecision {
	return value === "any" || value === "full";
}

/** One provider of a model, as the host keeps it from OpenRouter's endpoints listing. */
export interface ProviderEndpoint {
	readonly provider: string;
	/** OpenRouter's routing tag for the endpoint (e.g. `streamlake/fp8`), when it gives one. */
	readonly tag: string | null;
	/** Lower-case quantization label; `unknown` when the provider does not publish one. */
	readonly quantization: string;
	/** 0 is live; OpenRouter marks degraded or unavailable endpoints with negative codes. */
	readonly status: number;
	/** Whether the endpoint takes tools, which every chat turn needs. */
	readonly tools: boolean;
	/** The endpoint's price strings (USD per token): what OpenRouter charges for a call it serves. */
	readonly pricing: RawPricing;
	/** How far that price is below the maker's own, as OpenRouter states it (information only). */
	readonly discount: number;
	/**
	 * OpenRouter's uptime figure for the last day (percent); null when the endpoint has none, which is when it served no
	 * counted call in that day. Absent on a listing kept before the host read it (then nothing is concluded from it).
	 */
	readonly uptimeLastDay?: number | null;
}

export interface ModelEndpointsRow {
	readonly modelId: string;
	/** When the host read the listing (ISO instant). */
	readonly fetchedAt: string;
	/** When OpenRouter first listed the model (ISO instant), when the listing says. */
	readonly listedSince?: string;
	readonly endpoints: readonly ProviderEndpoint[];
}

/**
 * What the host knows about a voice beyond the model-level price: the providers that serve it, and whether providers
 * have refused it outright (see `chat-model-health.ts`). Both are optional on a host: without them a voice is offered at
 * `any` only and nothing is hidden, exactly as before precision existed.
 */
export interface ChatVoiceMarket {
	endpoints(modelId: string): ModelEndpointsRow | undefined;
	refusal?(modelId: string, now: number): { readonly kind: string; readonly message: string } | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** OpenRouter's `GET /api/v1/models/{id}/endpoints` answer as the host keeps it, or undefined if it is not one. */
export function normalizeEndpointsResponse(body: unknown, fetchedAt: string): ModelEndpointsRow | undefined {
	const data = isRecord(body) && isRecord(body.data) ? body.data : undefined;
	if (!data || typeof data.id !== "string" || !Array.isArray(data.endpoints)) return undefined;
	const endpoints: ProviderEndpoint[] = [];
	for (const entry of data.endpoints) {
		if (!isRecord(entry) || typeof entry.provider_name !== "string" || !entry.provider_name) continue;
		const rawPricing = isRecord(entry.pricing) ? entry.pricing : {};
		const pricing: Record<string, string | readonly never[]> = {};
		for (const [key, value] of Object.entries(rawPricing)) {
			if (typeof value === "string") pricing[key] = value;
			else if (key === "overrides" && Array.isArray(value)) pricing[key] = value as never[];
		}
		const discount =
			typeof rawPricing.discount === "number" && Number.isFinite(rawPricing.discount) ? rawPricing.discount : 0;
		const quantization =
			typeof entry.quantization === "string" && entry.quantization ? entry.quantization.toLowerCase() : "unknown";
		const parameters = Array.isArray(entry.supported_parameters) ? entry.supported_parameters : [];
		endpoints.push({
			provider: entry.provider_name,
			tag: typeof entry.tag === "string" && entry.tag ? entry.tag : null,
			quantization: OPENROUTER_QUANTIZATIONS.has(quantization) ? quantization : "unknown",
			status: typeof entry.status === "number" ? entry.status : -1,
			tools: parameters.includes("tools"),
			pricing: pricing as RawPricing,
			discount,
			uptimeLastDay:
				typeof entry.uptime_last_1d === "number" && Number.isFinite(entry.uptime_last_1d)
					? entry.uptime_last_1d
					: null,
		});
	}
	const listedSince =
		typeof data.created === "number" && Number.isFinite(data.created) && data.created > 0
			? new Date(data.created * 1000).toISOString()
			: undefined;
	return { modelId: data.id, fetchedAt, ...(listedSince ? { listedSince } : {}), endpoints };
}

/** USD per token as a comparable number (the exact strings stay on the card; this only orders providers). */
function priceOf(pricing: RawPricing, key: "prompt" | "completion"): number {
	const text = pricing[key];
	const value = typeof text === "string" ? Number(text) : Number.NaN;
	return Number.isFinite(value) && value >= 0 ? value : Number.POSITIVE_INFINITY;
}

/**
 * The provider whose price a full-precision card states: the cheapest live, tool-capable endpoint serving FP8 or
 * better, by prompt price then completion price; undefined when there is none.
 */
export function fullPrecisionEndpoint(row: ModelEndpointsRow): ProviderEndpoint | undefined {
	const full = new Set<string>(FULL_PRECISION_QUANTIZATIONS);
	const candidates = row.endpoints.filter(
		(endpoint) =>
			endpoint.status === 0 &&
			endpoint.tools &&
			full.has(endpoint.quantization) &&
			Number.isFinite(priceOf(endpoint.pricing, "prompt")) &&
			Number.isFinite(priceOf(endpoint.pricing, "completion")),
	);
	candidates.sort(
		(left, right) =>
			priceOf(left.pricing, "prompt") - priceOf(right.pricing, "prompt") ||
			priceOf(left.pricing, "completion") - priceOf(right.pricing, "completion") ||
			left.provider.localeCompare(right.provider),
	);
	return candidates[0];
}

/** The live providers that list exactly these prices, with their quantization (who an `any` card's price belongs to). */
export function providersAtPrice(
	row: ModelEndpointsRow,
	prices: { readonly prompt: string; readonly completion: string },
): Array<{ readonly name: string; readonly quantization: string | null }> {
	const seen = new Set<string>();
	const out: Array<{ name: string; quantization: string | null }> = [];
	for (const endpoint of row.endpoints) {
		if (endpoint.status !== 0) continue;
		if (
			!samePrice(endpoint.pricing.prompt, prices.prompt) ||
			!samePrice(endpoint.pricing.completion, prices.completion)
		)
			continue;
		const key = `${endpoint.provider}\u0000${endpoint.quantization}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ name: endpoint.provider, quantization: endpoint.quantization });
	}
	return out;
}

/** Two price strings for the same number (listings may differ in trailing zeros); for matching only, never billing. */
function samePrice(left: unknown, right: unknown): boolean {
	if (typeof left !== "string" || typeof right !== "string") return false;
	return left === right || (Number.isFinite(Number(left)) && Number(left) === Number(right));
}
