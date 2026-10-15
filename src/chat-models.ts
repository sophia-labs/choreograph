/**
 * Voices (Sobremesa): the model a chat speaks with, chosen from the LIVE OpenRouter catalogue.
 *
 * Which models may speak is decided by one function over a catalogue row (`assessChatModelRow`), and that one
 * function serves both halves of the feature: admission (an invocation asks for a model, or takes the House
 * default) and the catalogue the SPA lists. The two cannot disagree, because a listed model is by construction one
 * this host would admit.
 *
 * A model is admitted when the provider offers it now, it advertises tool support (the chat reads a workspace through
 * tools), its price can be read exactly (an unpriced model is refused, never billed at a fallback rate), it is not a
 * batch route, not free, has a context of at least 32,000 tokens, takes and gives text alone, and the operator has
 * not denied it. Admission also refuses a catalogue whose prices are older than a day. What admission produces is a
 * RATE CARD (see `billing-rate-card.ts`): the model's own price strings, pinned on the Session it starts.
 *
 * Every refusal has a code, an HTTP status and a reason:
 *   model_not_found 404 (not_in_catalogue) · model_denied 403 (operator_denylist) ·
 *   pricing_unavailable 503, retryable (catalogue_missing, catalogue_stale, model_not_live) ·
 *   model_unpriced 422 (batch_variant, zero_priced, price_missing, price_malformed, price_dynamic, no_tools,
 *   override_unmodelled, override_time_window, price_unmodelled, per_request_fee, reasoning_priced_separately,
 *   context_too_small, output_not_text, input_not_text, precision_unavailable) ·
 *   model_unavailable 503 (provider_refused: a provider refused the voice outright, `chat-model-health.ts`).
 *
 * Precision (2026-10-01, `chat-precision.ts`): a voice is offered at `any` (today's card) and, where a provider
 * publishes FP8 or better, at `full`, priced from that provider's listing. A chat asks with `inference.precision`.
 */

import {
	billedMicroUsdPerMillion,
	buildRateCard,
	checkBasePrices,
	type PriceRefusalReason,
	parsePriceText,
	type RateCardV1,
} from "./billing-rate-card.js";
import {
	CHAT_PRECISIONS,
	type ChatPrecision,
	type ChatVoiceMarket,
	DEFAULT_CHAT_PRECISION,
	FULL_PRECISION_QUANTIZATIONS,
	fullPrecisionEndpoint,
	providersAtPrice,
} from "./chat-precision.js";
import type { CatalogueSnapshotRows, ResolvedCatalogueRow } from "./model-catalog.js";
import type { OpenRouterModelRow } from "./openrouter.js";
import { InvocationFault } from "./workflow/invocation.js";

export const CHAT_MODEL_CATALOGUE_SCHEMA = "choreograph.chat-models.v1" as const;

/** A price older than this is not a price: admission and the catalogue of voices refuse it, retryably. */
export const CATALOGUE_MAX_AGE_MS = 24 * 3_600_000;
/** A chat reads a workspace and keeps a conversation: a context smaller than this cannot hold one. */
export const CHAT_MIN_CONTEXT_TOKENS = 32_000;

export type ChatModelRefusalCode =
	| "model_not_found"
	| "model_denied"
	| "pricing_unavailable"
	| "model_unpriced"
	| "model_unavailable";

export type ChatModelRefusalReason =
	| "not_in_catalogue"
	| "operator_denylist"
	| "catalogue_missing"
	| "catalogue_stale"
	| "model_not_live"
	| PriceRefusalReason
	| "batch_variant"
	| "zero_priced"
	| "no_tools"
	| "context_too_small"
	| "output_not_text"
	| "input_not_text"
	| "precision_unavailable"
	| "provider_refused";

const REFUSAL_STATUS: Readonly<Record<ChatModelRefusalCode, number>> = {
	model_not_found: 404,
	model_denied: 403,
	pricing_unavailable: 503,
	model_unpriced: 422,
	model_unavailable: 503,
};

export function chatModelRefusalStatus(code: ChatModelRefusalCode): number {
	return REFUSAL_STATUS[code];
}

const MODEL_ID_PATTERN = /^~?[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
const MAX_MODEL_ID_CHARS = 200;

/** A model id a person may send: OpenRouter's own grammar (the `~vendor/name-latest` aliases included), no mocks. */
export function isValidChatModelId(id: string): boolean {
	return (
		id !== "" && id.length <= MAX_MODEL_ID_CHARS && MODEL_ID_PATTERN.test(id) && !id.toLowerCase().startsWith("mock:")
	);
}

/** How far into the future a snapshot's time may lie before it is a clock that jumped, not a fresh price. */
const CATALOGUE_CLOCK_SKEW_MS = 5 * 60_000;

/** Are these prices young enough to bill from? Younger than a day is; a day old is not, nor is a time from the future. */
export function catalogueIsUsable(fetchedAt: string, now: number): boolean {
	const fetched = Date.parse(fetchedAt);
	if (!Number.isFinite(fetched)) return false;
	const age = now - fetched;
	return age > -CATALOGUE_CLOCK_SKEW_MS && age < CATALOGUE_MAX_AGE_MS;
}

// ─── The operator's denylist ─────────────────────────────────────────────────

/**
 * `CHOREOGRAPH_CHAT_MODEL_DENYLIST`: comma-separated model ids to refuse, or `vendor/*` for every model of a
 * vendor. A switch for the operator (a runaway price, an abusive route), not a roster: the roster is the catalogue.
 */
export function parseChatModelDenylist(env: NodeJS.ProcessEnv = process.env): readonly string[] {
	return (env.CHOREOGRAPH_CHAT_MODEL_DENYLIST ?? "")
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry !== "");
}

/**
 * An OpenRouter alias (`~openai/gpt-sol-latest`) is the vendor's model under a moving name: the `~` marks the alias, it
 * is not part of the vendor. So `openai/*` (or `~openai/*`) denies the vendor's aliases as well as its ordinary ids,
 * while an exact entry names exactly one id, as written.
 */
function withoutAliasMark(id: string): string {
	return id.startsWith("~") ? id.slice(1) : id;
}

export function isChatModelDenied(modelId: string, denylist: readonly string[]): boolean {
	const id = modelId.toLowerCase();
	const bare = withoutAliasMark(id);
	return denylist.some((entry) =>
		entry.endsWith("/*") ? bare.startsWith(withoutAliasMark(entry).slice(0, -1)) : id === entry,
	);
}

// ─── One row: may it speak, and on what card ─────────────────────────────────

export type ChatModelAssessment =
	| { readonly ok: true; readonly card: RateCardV1 }
	| {
			readonly ok: false;
			readonly code: ChatModelRefusalCode;
			readonly reason: ChatModelRefusalReason;
			readonly message: string;
	  };

export interface AssessChatModelOptions {
	readonly denylist?: readonly string[];
	/** The snapshot the row was read from: named in the card, so a price can be traced to what stated it. */
	readonly catalogue: { readonly digest: string; readonly fetchedAt: string };
	/** The markup the card pins, in basis points. */
	readonly markupBps: number;
}

function refuse(code: ChatModelRefusalCode, reason: ChatModelRefusalReason, message: string): ChatModelAssessment {
	return { ok: false, code, reason, message };
}

function unpriced(reason: ChatModelRefusalReason, message: string): ChatModelAssessment {
	return refuse("model_unpriced", reason, message);
}

/**
 * The one rule. The checks run in a fixed order and the first that fails is reported (the order is mirrored by
 * `pricing-oracle.mjs`, which the tests hold this function to over the whole 464-model catalogue): the operator's
 * denylist, whether the provider lists the model now, a batch route, a free or zero-priced model, the two prices
 * every call needs, tool support, the rest of the price (overrides, unknown dimensions, a per-request fee, separately
 * priced reasoning), the context, and the modalities.
 */
export function assessChatModelRow(row: OpenRouterModelRow, options: AssessChatModelOptions): ChatModelAssessment {
	const denylist = options.denylist ?? [];
	if (isChatModelDenied(row.id, denylist) || (row.canonical_id && isChatModelDenied(row.canonical_id, denylist))) {
		return refuse("model_denied", "operator_denylist", `model '${row.id}' is not offered on this host`);
	}
	if (!row.live_available) {
		return refuse(
			"pricing_unavailable",
			"model_not_live",
			`model '${row.id}' is not offered by the provider right now`,
		);
	}
	if (row.id.endsWith(":batch")) {
		return unpriced("batch_variant", `model '${row.id}' is a batch route, not one a chat can speak with`);
	}
	const raw = row.pricing_raw;
	if (row.id.endsWith(":free") || parsePriceText(raw?.prompt) === 0n || parsePriceText(raw?.completion) === 0n) {
		return unpriced(
			"zero_priced",
			`model '${row.id}' prices its input or its output at zero, which the ledger cannot bill`,
		);
	}
	const base = checkBasePrices(raw);
	if (base) return unpriced(base.reason, `model '${row.id}': ${base.message}, and an unpriced model is never billed`);
	if (row.supports_tools !== true) {
		return unpriced("no_tools", `model '${row.id}' does not advertise tool support, which chat requires`);
	}
	const built = buildRateCard({
		model: row.id,
		pricing: raw,
		catalogue: options.catalogue,
		markupBps: options.markupBps,
	});
	if (!built.ok) return unpriced(built.reason, `model '${row.id}': ${built.message}`);
	if (row.context_length === null || row.context_length < CHAT_MIN_CONTEXT_TOKENS) {
		return unpriced("context_too_small", `model '${row.id}' has a context under ${CHAT_MIN_CONTEXT_TOKENS} tokens`);
	}
	// What a row does not say it gives or takes is not proven to be text: the ledger bills tokens of text and nothing else.
	if (
		!row.output_modalities ||
		row.output_modalities.length === 0 ||
		row.output_modalities.some((modality) => modality !== "text")
	) {
		return unpriced("output_not_text", `model '${row.id}' is not shown to give text alone`);
	}
	if (!row.input_modalities || !row.input_modalities.includes("text")) {
		return unpriced("input_not_text", `model '${row.id}' is not shown to take text`);
	}
	return { ok: true, card: built.card };
}

function refusalFault(code: ChatModelRefusalCode, reason: ChatModelRefusalReason, message: string): InvocationFault {
	return new InvocationFault(code, message, chatModelRefusalStatus(code), { reason });
}

// ─── Admission ───────────────────────────────────────────────────────────────

export interface ChatModelCatalogueSource {
	resolveRow(modelId: string): Promise<ResolvedCatalogueRow | undefined>;
	snapshotRows(): Promise<CatalogueSnapshotRows>;
}

/** What the invocation asked for: unvalidated, straight from the input. */
export interface ChatInferenceRequest {
	readonly provider: string;
	readonly model: string;
	/** `any` (today's card, the default) or `full` (the cheapest provider at FP8 or better). */
	readonly precision?: ChatPrecision;
}

export interface ChatInferenceV1 {
	readonly provider: "openrouter";
	readonly model: string;
}

/** What the catalogue said about the admitted model, at the moment it was admitted. */
export interface ChatModelFactsV1 {
	readonly model: string;
	readonly catalogDigest: string;
	readonly catalogFetchedAt: string;
	readonly contextLength: number | null;
	readonly maxCompletionTokens: number | null;
}

/** The card a Session is priced by, and the exact snapshot bytes its catalogue digest names (for the archive). */
export interface ChatModelPricingPin {
	readonly card: RateCardV1;
	readonly catalogueJson: () => string;
}

export interface ChatInferenceAdmission {
	readonly inference: ChatInferenceV1;
	readonly source: "requested" | "house-default";
	/** Absent only for a host with no catalogue, or a mock House default in development: unpinned, unpriced. */
	readonly facts?: ChatModelFactsV1;
	/** Absent under the same conditions: such a Session is a legacy Session and keeps the static price table. */
	readonly pricing?: ChatModelPricingPin;
}

type Resolution =
	| { readonly ok: true; readonly resolved: ResolvedCatalogueRow; readonly card: RateCardV1 }
	| Extract<ChatModelAssessment, { ok: false }>;

/** Resolve a model in the live catalogue and put it through the one rule. */
async function resolveAndAssess(input: {
	readonly catalog: Pick<ChatModelCatalogueSource, "resolveRow">;
	readonly modelId: string;
	readonly denylist: readonly string[];
	readonly markupBps: number;
	readonly now: number;
}): Promise<Resolution> {
	let resolved: ResolvedCatalogueRow | undefined;
	try {
		resolved = await input.catalog.resolveRow(input.modelId);
	} catch {
		return {
			ok: false,
			code: "pricing_unavailable",
			reason: "catalogue_missing",
			message: "the live model catalogue could not be read, so no model can be priced",
		};
	}
	if (!resolved) {
		return {
			ok: false,
			code: "model_not_found",
			reason: "not_in_catalogue",
			message: `model '${input.modelId}' is not in the live catalogue`,
		};
	}
	if (!catalogueIsUsable(resolved.fetchedAt, input.now)) {
		return {
			ok: false,
			code: "pricing_unavailable",
			reason: "catalogue_stale",
			message: "the live model catalogue's prices are more than a day old",
		};
	}
	const assessment = assessChatModelRow(resolved.row, {
		denylist: input.denylist,
		catalogue: { digest: resolved.digest, fetchedAt: resolved.fetchedAt },
		markupBps: input.markupBps,
	});
	if (!assessment.ok) return assessment;
	return { ok: true, resolved, card: assessment.card };
}

/**
 * Admit the voice of a chat. A requested model must resolve in the live catalogue and pass `assessChatModelRow`,
 * else a refusal with a code and a reason (400 `inference_provider_unsupported` and `inference_model_invalid`, 403
 * `model_denied`, 404 `model_not_found`, 422 `model_unpriced`, 503 `pricing_unavailable` when there is no catalogue,
 * it cannot be read, or its prices are older than a day). With no request the House default is admitted the same way;
 * if it is not one this host would admit, that is the host's fault (503 `model_house_default_unavailable`, with the
 * reason and the code), never a silent fallback price.
 */
export async function admitWorkspaceChatInference(input: {
	readonly requested?: ChatInferenceRequest;
	readonly houseDefault: ChatInferenceV1;
	readonly catalog: Pick<ChatModelCatalogueSource, "resolveRow"> | undefined;
	readonly denylist: readonly string[];
	readonly markupBps: number;
	readonly now?: number;
	/** The providers of each voice and the providers' outright refusals; without it: `any` only, nothing hidden. */
	readonly market?: ChatVoiceMarket;
}): Promise<ChatInferenceAdmission> {
	const now = input.now ?? Date.now();
	if (input.requested) {
		if (input.requested.provider !== "openrouter") {
			throw new InvocationFault("inference_provider_unsupported", "inference.provider must be 'openrouter'", 400);
		}
		const id = input.requested.model.trim();
		if (!isValidChatModelId(id)) {
			throw new InvocationFault(
				"inference_model_invalid",
				`inference.model must be a model id of at most ${MAX_MODEL_ID_CHARS} characters`,
				400,
			);
		}
		if (!input.catalog) {
			throw refusalFault(
				"pricing_unavailable",
				"catalogue_missing",
				"this host has no live model catalogue to price a model against",
			);
		}
		const outcome = await resolveAndAssess({
			catalog: input.catalog,
			modelId: id,
			denylist: input.denylist,
			markupBps: input.markupBps,
			now,
		});
		if (!outcome.ok) throw refusalFault(outcome.code, outcome.reason, outcome.message);
		const refused = input.market?.refusal?.(outcome.resolved.row.id, now);
		if (refused) {
			throw new InvocationFault(
				"model_unavailable",
				`model '${outcome.resolved.row.id}' was refused by its provider (${refused.kind}); choose another voice`,
				chatModelRefusalStatus("model_unavailable"),
				{ reason: "provider_refused", kind: refused.kind },
			);
		}
		const precise = atPrecision(
			outcome,
			input.requested.precision ?? DEFAULT_CHAT_PRECISION,
			input.market,
			input.markupBps,
		);
		if (!precise.ok) throw refusalFault(precise.code, precise.reason, precise.message);
		return admitted(precise, "requested");
	}

	const house = input.houseDefault;
	if (house.model.toLowerCase().startsWith("mock:") || !input.catalog) {
		return { inference: house, source: "house-default" };
	}
	const outcome = await resolveAndAssess({
		catalog: input.catalog,
		modelId: house.model,
		denylist: input.denylist,
		markupBps: input.markupBps,
		now,
	});
	const houseRefused = outcome.ok ? input.market?.refusal?.(outcome.resolved.row.id, now) : undefined;
	if (houseRefused) {
		throw new InvocationFault(
			"model_house_default_unavailable",
			`the House default model '${house.model}' was refused by its provider (${houseRefused.kind}); choose a voice`,
			503,
			{ reason: "provider_refused", code: "model_unavailable", kind: houseRefused.kind },
		);
	}
	if (!outcome.ok) {
		throw new InvocationFault(
			"model_house_default_unavailable",
			`the House default model '${house.model}' is not one this host would admit (${outcome.reason}); choose a voice`,
			503,
			{ reason: outcome.reason, code: outcome.code },
		);
	}
	return admitted(outcome, "house-default");
}

/**
 * The card for the precision asked for. `any` is the card the one rule produced (today's). `full` is priced from the
 * cheapest provider OpenRouter lists at FP8 or better, through the same card builder (an endpoint whose price cannot be
 * read exactly is refused like any other), and names that provider and its quantization rule in its route. With no
 * provider at full precision, or a host that has not read the providers, `full` is refused: never guessed.
 */
function atPrecision(
	outcome: Extract<Resolution, { ok: true }>,
	precision: ChatPrecision,
	market: ChatVoiceMarket | undefined,
	markupBps: number,
): Resolution {
	if (precision === "any") return outcome;
	const id = outcome.resolved.row.id;
	const endpoints = market?.endpoints(id);
	const endpoint = endpoints ? fullPrecisionEndpoint(endpoints) : undefined;
	if (!endpoints || !endpoint) {
		return {
			ok: false,
			code: "model_unpriced",
			reason: "precision_unavailable",
			message: `model '${id}' is not offered at full precision (FP8 or better) by any provider this host has read`,
		};
	}
	const built = buildRateCard({
		model: id,
		pricing: endpoint.pricing,
		catalogue: outcome.card.catalogue,
		markupBps,
		precision: "full",
		route: {
			quantizations: [...FULL_PRECISION_QUANTIZATIONS],
			endpoint: {
				provider: endpoint.provider,
				tag: endpoint.tag,
				quantization: endpoint.quantization,
				listedAt: endpoints.fetchedAt,
			},
		},
	});
	if (!built.ok) {
		return {
			ok: false,
			code: "model_unpriced",
			reason: built.reason,
			message: `model '${id}' at full precision: ${built.message}`,
		};
	}
	return { ok: true, resolved: outcome.resolved, card: built.card };
}

function admitted(
	outcome: Extract<Resolution, { ok: true }>,
	source: ChatInferenceAdmission["source"],
): ChatInferenceAdmission {
	const { resolved, card } = outcome;
	return {
		inference: { provider: "openrouter", model: resolved.row.id },
		source,
		facts: {
			model: resolved.row.id,
			catalogDigest: resolved.digest,
			catalogFetchedAt: resolved.fetchedAt,
			contextLength: resolved.row.context_length,
			maxCompletionTokens: resolved.row.max_completion_tokens,
		},
		pricing: { card, catalogueJson: resolved.coreJson },
	};
}

// ─── The catalogue the SPA reads ─────────────────────────────────────────────

export interface ChatModelCatalogueQuery {
	readonly q?: string;
	readonly vendor?: string;
	readonly limit?: number;
	readonly sort?: "id" | "price";
}

/** One selectable voice. Prices are what a person is charged: the provider's rate plus the operator's markup. */
export interface ChatModelEntryV1 {
	readonly id: string;
	readonly name: string;
	readonly provider: "openrouter";
	readonly vendor: string;
	readonly contextLength: number | null;
	readonly maxCompletionTokens: number | null;
	/** Billed USD per million input tokens, rounded up to a micro-dollar. Above the tier threshold it is higher. */
	readonly promptPerMillionUsd: number;
	readonly completionPerMillionUsd: number;
	readonly tools: true;
	readonly reasoning: boolean;
	readonly inputModalities: readonly string[];
	readonly houseDefault: boolean;
	/** True when the price rises above a prompt size (long-context tiers): the price shown is the base price. */
	readonly tiered: boolean;
	/**
	 * The precisions the voice is offered at, `any` first (its prices are the entry's own). `full` is listed when a
	 * provider publishes FP8 or better; its prices are that provider's plus the fee. `providers` names who serves at
	 * that price and their quantization, or is null when the host has not read the voice's providers.
	 */
	readonly precisions: readonly ChatVoicePrecisionV1[];
}

export interface ChatVoicePrecisionV1 {
	readonly precision: ChatPrecision;
	readonly promptPerMillionUsd: number;
	readonly completionPerMillionUsd: number;
	readonly providers: ReadonlyArray<{ readonly name: string; readonly quantization: string | null }> | null;
}

export interface ChatModelCatalogueV1 {
	readonly schema: typeof CHAT_MODEL_CATALOGUE_SCHEMA;
	readonly provider: "openrouter";
	readonly fetchedAt: string;
	readonly catalogDigest: string;
	readonly stale: boolean;
	readonly houseDefault: {
		readonly provider: "openrouter";
		readonly model: string;
		readonly admissible: boolean;
		readonly refusal?: { readonly code: ChatModelRefusalCode; readonly reason: ChatModelRefusalReason };
	};
	readonly pricing: {
		readonly currency: "USD";
		readonly unit: "per-million-tokens";
		readonly source: "openrouter-live-catalogue";
		readonly markupPercent: number;
		readonly markupBps: number;
		/** What the precisions mean on this host (`chat-precision.ts`). */
		readonly precision: {
			readonly values: readonly ChatPrecision[];
			readonly default: ChatPrecision;
			readonly fullQuantizations: readonly string[];
		};
	};
	/** How many admissible models matched the query, before `limit`. */
	readonly count: number;
	readonly models: readonly ChatModelEntryV1[];
}

function vendorOf(id: string): string {
	const bare = withoutAliasMark(id);
	const slash = bare.indexOf("/");
	return slash === -1 ? bare : bare.slice(0, slash);
}

function byCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

/** Every admissible model of a catalogue snapshot as the SPA lists it, House default marked. */
export function projectChatModelCatalogue(input: {
	readonly snapshot: Pick<CatalogueSnapshotRows, "rows" | "digest" | "fetchedAt" | "stale">;
	readonly houseDefault: ChatInferenceV1;
	readonly markupBps: number;
	readonly denylist: readonly string[];
	readonly query?: ChatModelCatalogueQuery;
	/** The providers of each voice and their outright refusals; without it: `any` only, nothing hidden. */
	readonly market?: ChatVoiceMarket;
	readonly now?: number;
}): ChatModelCatalogueV1 {
	const now = input.now ?? Date.now();
	const house = input.houseDefault.model;
	const isHouse = (row: OpenRouterModelRow) => row.id === house || row.canonical_id === house;
	const assessOptions = {
		denylist: input.denylist,
		catalogue: { digest: input.snapshot.digest, fetchedAt: input.snapshot.fetchedAt },
		markupBps: input.markupBps,
	};
	const admissible: Array<{
		row: OpenRouterModelRow;
		card: RateCardV1;
		promptMicro: number;
		completionMicro: number;
	}> = [];
	for (const row of input.snapshot.rows) {
		// Admission refuses an id outside the grammar before it looks anything up: so must the list.
		if (!isValidChatModelId(row.id)) continue;
		const assessment = assessChatModelRow(row, assessOptions);
		if (!assessment.ok) continue;
		// A voice its provider refused outright (end of life, an account attestation, no endpoint) is not offered.
		if (input.market?.refusal?.(row.id, now)) continue;
		admissible.push({
			row,
			card: assessment.card,
			promptMicro: billedMicroUsdPerMillion(assessment.card.prices.prompt, input.markupBps),
			completionMicro: billedMicroUsdPerMillion(assessment.card.prices.completion, input.markupBps),
		});
	}

	const houseRow = input.snapshot.rows.find(isHouse);
	const houseAssessment = houseRow ? assessChatModelRow(houseRow, assessOptions) : undefined;
	const houseVerdict = !houseAssessment
		? { admissible: false, refusal: { code: "model_not_found" as const, reason: "not_in_catalogue" as const } }
		: houseAssessment.ok
			? { admissible: true }
			: { admissible: false, refusal: { code: houseAssessment.code, reason: houseAssessment.reason } };

	const q = input.query?.q?.trim().toLowerCase();
	const vendor = input.query?.vendor?.trim().toLowerCase();
	let matching = admissible.filter(
		({ row }) =>
			(!q || row.id.toLowerCase().includes(q) || row.name.toLowerCase().includes(q)) &&
			(!vendor || vendorOf(row.id).toLowerCase() === vendor),
	);
	matching =
		input.query?.sort === "price"
			? matching.sort((a, b) => a.promptMicro - b.promptMicro || byCodeUnits(a.row.id, b.row.id))
			: matching.sort((a, b) => byCodeUnits(a.row.id, b.row.id));
	const limit = input.query?.limit;

	return {
		schema: CHAT_MODEL_CATALOGUE_SCHEMA,
		provider: "openrouter",
		fetchedAt: input.snapshot.fetchedAt,
		catalogDigest: input.snapshot.digest,
		stale: input.snapshot.stale,
		houseDefault: { provider: "openrouter", model: house, ...houseVerdict },
		pricing: {
			currency: "USD",
			unit: "per-million-tokens",
			source: "openrouter-live-catalogue",
			markupPercent: input.markupBps / 100,
			markupBps: input.markupBps,
			precision: {
				values: [...CHAT_PRECISIONS],
				default: DEFAULT_CHAT_PRECISION,
				fullQuantizations: [...FULL_PRECISION_QUANTIZATIONS],
			},
		},
		count: matching.length,
		models: (limit === undefined ? matching : matching.slice(0, limit)).map(
			({ row, card, promptMicro, completionMicro }) => ({
				id: row.id,
				name: row.name,
				provider: "openrouter" as const,
				vendor: vendorOf(row.id),
				contextLength: row.context_length,
				maxCompletionTokens: row.max_completion_tokens,
				promptPerMillionUsd: promptMicro / 1_000_000,
				completionPerMillionUsd: completionMicro / 1_000_000,
				tools: true as const,
				reasoning:
					row.reasoning ??
					(row.supported_parameters?.includes("reasoning") === true ||
						row.supported_parameters?.includes("reasoning_effort") === true),
				inputModalities: row.input_modalities ?? ["text"],
				houseDefault: isHouse(row),
				tiered: card.tiers.length > 0,
				precisions: precisionsOf(row.id, card, promptMicro, completionMicro, input.market, input.markupBps),
			}),
		),
	};
}

/** The precisions a voice is offered at, as the picker lists them (`ChatVoicePrecisionV1`). */
function precisionsOf(
	id: string,
	card: RateCardV1,
	promptMicro: number,
	completionMicro: number,
	market: ChatVoiceMarket | undefined,
	markupBps: number,
): ChatVoicePrecisionV1[] {
	const endpoints = market?.endpoints(id);
	const out: ChatVoicePrecisionV1[] = [
		{
			precision: "any",
			promptPerMillionUsd: promptMicro / 1_000_000,
			completionPerMillionUsd: completionMicro / 1_000_000,
			providers: endpoints ? providersAtPrice(endpoints, card.prices) : null,
		},
	];
	const full = endpoints ? fullPrecisionEndpoint(endpoints) : undefined;
	if (endpoints && full) {
		const built = buildRateCard({ model: id, pricing: full.pricing, catalogue: card.catalogue, markupBps });
		if (built.ok) {
			out.push({
				precision: "full",
				promptPerMillionUsd: billedMicroUsdPerMillion(built.card.prices.prompt, markupBps) / 1_000_000,
				completionPerMillionUsd: billedMicroUsdPerMillion(built.card.prices.completion, markupBps) / 1_000_000,
				providers: providersAtPrice(endpoints, built.card.prices).filter((provider) =>
					(FULL_PRECISION_QUANTIZATIONS as readonly string[]).includes(provider.quantization ?? ""),
				),
			});
		}
	}
	return out;
}
