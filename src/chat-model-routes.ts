/**
 * `GET /api/models?view=chat` — the catalogue of voices the SPA lists.
 *
 * It extends the route the gateway already proxies for `GET /chat/models` (Choreograph's `/api/models`), so it
 * reuses that route's host-side catalogue and its authority. The legacy unfiltered listing is untouched. The
 * gateway's own `/chat/models` projection reads a fixed upstream query (`sort=id&limit=500`) and a fixed set of
 * fields, so the SPA reaches this view only through a small gateway addition (named in the return contracts);
 * until then it can compute the same admissible set from `/chat/models` plus the registry's host block.
 *
 * Errors: 503 `model_catalogue_unavailable` (no catalogue on this host, or it cannot be read); 503 `pricing_unavailable`
 * (`catalogue_stale`: its prices are older than a day, so no voice is offered, exactly as admission would refuse
 * them); 400 `invalid_view`, `invalid_limit`, `invalid_sort`.
 */

import type { ServerResponse } from "node:http";
import { resolveBillingMarkupBps } from "./billing-rate-card.js";
import { sendCodedError, sendJson } from "./chat-http.js";
import {
	type ChatModelCatalogueQuery,
	type ChatModelCatalogueSource,
	catalogueIsUsable,
	chatModelRefusalStatus,
	parseChatModelDenylist,
	projectChatModelCatalogue,
} from "./chat-models.js";
import type { ChatVoiceMarket } from "./chat-precision.js";
import { resolveWorkspaceChatInference } from "./workflow/workspace-chat.js";

export const CHAT_MODELS_VIEW = "chat";
export const CHAT_MODEL_CATALOGUE_MAX_LIMIT = 1_000;
const MAX_QUERY_TEXT_CHARS = 100;

export async function handleChatModelCatalogue(input: {
	readonly catalog: ChatModelCatalogueSource | undefined;
	readonly response: ServerResponse;
	readonly url: URL;
	readonly env?: NodeJS.ProcessEnv;
	readonly now?: number;
	/** The providers the host has read for each voice: without it, only `any` is offered (no guess at `full`). */
	readonly market?: ChatVoiceMarket;
}): Promise<void> {
	const { catalog, response, url } = input;
	const env = input.env ?? process.env;
	if (!catalog) {
		sendCodedError(response, 503, "model_catalogue_unavailable", "this host has no live model catalogue");
		return;
	}

	const query: { q?: string; vendor?: string; limit?: number; sort?: "id" | "price" } = {};
	const q = url.searchParams.get("q")?.trim();
	if (q) query.q = q.slice(0, MAX_QUERY_TEXT_CHARS);
	const vendor = url.searchParams.get("vendor")?.trim();
	if (vendor) query.vendor = vendor.slice(0, MAX_QUERY_TEXT_CHARS);
	const limitRaw = url.searchParams.get("limit");
	if (limitRaw !== null) {
		const limit = /^\d{1,4}$/.test(limitRaw) ? Number.parseInt(limitRaw, 10) : Number.NaN;
		if (!Number.isInteger(limit) || limit < 1 || limit > CHAT_MODEL_CATALOGUE_MAX_LIMIT) {
			sendCodedError(
				response,
				400,
				"invalid_limit",
				`limit must be an integer from 1 to ${CHAT_MODEL_CATALOGUE_MAX_LIMIT}`,
			);
			return;
		}
		query.limit = limit;
	}
	const sort = url.searchParams.get("sort");
	if (sort !== null) {
		if (sort !== "id" && sort !== "price") {
			sendCodedError(response, 400, "invalid_sort", "sort must be 'id' or 'price'");
			return;
		}
		query.sort = sort;
	}

	let snapshot: Awaited<ReturnType<ChatModelCatalogueSource["snapshotRows"]>>;
	try {
		snapshot = await catalog.snapshotRows();
	} catch {
		sendCodedError(response, 503, "model_catalogue_unavailable", "the live model catalogue could not be read");
		return;
	}
	if (snapshot.bundledOnly) {
		// The provider could not be reached, so there are only the rows the host ships, which carry no live price.
		// Answering 200 with no voices would say the catalogue loaded; it did not.
		sendCodedError(response, 503, "model_catalogue_unavailable", "the live model catalogue could not be fetched");
		return;
	}
	if (!catalogueIsUsable(snapshot.fetchedAt, input.now ?? Date.now())) {
		sendCodedError(
			response,
			chatModelRefusalStatus("pricing_unavailable"),
			"pricing_unavailable",
			"the live model catalogue's prices are more than a day old",
			{ reason: "catalogue_stale" },
		);
		return;
	}
	const view = projectChatModelCatalogue({
		snapshot,
		houseDefault: resolveWorkspaceChatInference(env),
		markupBps: resolveBillingMarkupBps(env),
		denylist: parseChatModelDenylist(env),
		query: query as ChatModelCatalogueQuery,
		...(input.market ? { market: input.market } : {}),
		...(input.now !== undefined ? { now: input.now } : {}),
	});
	response.setHeader("cache-control", "private, max-age=60");
	sendJson(response, 200, view);
}
