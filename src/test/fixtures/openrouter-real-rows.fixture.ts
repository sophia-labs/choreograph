/**
 * Rows of the real OpenRouter catalogue, as `GET https://openrouter.ai/api/v1/models` returned them on
 * 2026-09-29 (464 models, 396 with tool support, 300 with a cache-read price), kept in
 * `openrouter-real-rows.json` and trimmed to the fields the host reads (descriptions dropped; each model's
 * `pricing` object is whole and verbatim: strings, overrides and all).
 *
 * Real data on purpose: the Sobremesa admission rules are written against what the catalogue actually
 * looks like (router models priced at -1, image-output models, free models, tiered prices), not against
 * a tidy invention. It is public data and not hostile content. `openrouter-catalogue.fixture.ts` holds the
 * whole catalogue; this is the dozen rows a test can name at a glance.
 */

import { readFileSync } from "node:fs";
import {
	mergeOpenRouterModelCatalogs,
	type OpenRouterCatalogPayload,
	type OpenRouterLiveModel,
} from "../../openrouter.js";

interface RealRow {
	readonly why: string;
	readonly live: OpenRouterLiveModel;
}

export const REAL_OPENROUTER_ROWS: Readonly<Record<string, RealRow>> = JSON.parse(
	readFileSync(new URL("./openrouter-real-rows.json", import.meta.url), "utf8"),
);

/**
 * The rows as the host's own merge code turns live entries into catalogue rows (no static catalogue).
 * `fetchedAt` defaults to now, so the catalogue is fresh for the rule that refuses prices older than a day;
 * pass a fixed or an old time to test that rule.
 */
export function realCatalogue(
	ids: readonly string[] = Object.keys(REAL_OPENROUTER_ROWS),
	fetchedAt: string = new Date().toISOString(),
): OpenRouterCatalogPayload {
	const live = ids.map((id) => REAL_OPENROUTER_ROWS[id].live);
	return {
		provider: "openrouter",
		fetched_at: fetchedAt,
		auth_configured: true,
		catalog_count: 0,
		live_count: live.length,
		models: mergeOpenRouterModelCatalogs([], live),
	};
}
