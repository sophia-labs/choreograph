/**
 * The whole live OpenRouter catalogue as `GET https://openrouter.ai/api/v1/models` returned it on 2026-09-29
 * (464 models), trimmed to the fields the host reads, with each model's `pricing` object whole and verbatim
 * (`openrouter-catalogue-20260929.json`), plus what an independent implementation says the host must do
 * with it (`pricing-oracle.mjs`: exact rational arithmetic, written from `E-billing-enforce.md` 4.3):
 *
 * - `openrouter-catalogue-20260929.partition.json`: which ids are offered, and the first rule that refuses every
 *   other one;
 * - `pricing-goldens.json`: named token cases with the exact cost in integer micro-USD, the cost of the smallest
 *   viable call, and the billed price per million tokens.
 *
 * Public data, not hostile content. Regenerate with `node pricing-oracle.mjs <openrouter-models.json>`.
 */

import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenRouterModelCatalog } from "../../model-catalog.js";
import {
	mergeOpenRouterModelCatalogs,
	type OpenRouterCatalogPayload,
	type OpenRouterLiveModel,
	type OpenRouterModelRow,
} from "../../openrouter.js";

function readJson<T>(name: string): T {
	return JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8")) as T;
}

const FILE = readJson<{ fetchedAt: string; count: number; models: OpenRouterLiveModel[] }>(
	"openrouter-catalogue-20260929.json",
);

/** The fetch time the oracle pinned, for tests that want a deterministic snapshot. */
export const FULL_CATALOGUE_FETCHED_AT = FILE.fetchedAt;
export const FULL_CATALOGUE_LIVE: readonly OpenRouterLiveModel[] = FILE.models;

const FULL_ROWS: readonly OpenRouterModelRow[] = mergeOpenRouterModelCatalogs([], FILE.models);

/** Every model as the host's own merge code turns live entries into catalogue rows. */
export function fullCatalogue(fetchedAt: string = new Date().toISOString()): OpenRouterCatalogPayload {
	return {
		provider: "openrouter",
		fetched_at: fetchedAt,
		auth_configured: true,
		catalog_count: 0,
		live_count: FILE.models.length,
		models: [...FULL_ROWS],
	};
}

export function fullRows(): readonly OpenRouterModelRow[] {
	return FULL_ROWS;
}

export function fullRow(id: string): OpenRouterModelRow {
	const row = FULL_ROWS.find((candidate) => candidate.id === id);
	if (!row) throw new Error(`${id} is not in the 2026-09-29 catalogue fixture`);
	return row;
}

export interface Partition {
	readonly total: number;
	readonly offered: readonly string[];
	readonly refused: Readonly<Record<string, string>>;
	readonly counts: Readonly<Record<string, number>>;
}

export const PARTITION = readJson<Partition>("openrouter-catalogue-20260929.partition.json");

export interface GoldenTokens {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface GoldenCase {
	readonly name: string;
	readonly model: string;
	readonly markupBps: number;
	readonly tokens: GoldenTokens;
	readonly expect: {
		readonly inputCostMicroUsd: number;
		readonly outputCostMicroUsd: number;
		readonly cacheReadCostMicroUsd: number;
		readonly cacheWriteCostMicroUsd: number;
		readonly providerCostMicroUsd: number;
		readonly markupMicroUsd: number;
		readonly costMicroUsd: number;
		readonly exactProviderMicroUsd: string;
		readonly exactTotalMicroUsd: string;
	};
}

export interface Goldens {
	readonly cases: readonly GoldenCase[];
	readonly viableCall: ReadonlyArray<{
		readonly model: string;
		readonly markupBps: number;
		readonly costMicroUsd: number;
		readonly afterFloor: number;
	}>;
	readonly perMillion: ReadonlyArray<{
		readonly model: string;
		readonly markupBps: number;
		readonly promptMicroUsdPerMillion: number;
		readonly completionMicroUsdPerMillion: number;
	}>;
}

export const GOLDENS = readJson<Goldens>("pricing-goldens.json");

export function golden(name: string): GoldenCase {
	const found = GOLDENS.cases.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`no golden case named ${name}`);
	return found;
}

/**
 * A real `OpenRouterModelCatalog` fed the whole catalogue through its own `loadCatalog` seam (no network),
 * initialized and refreshed once so it holds live rows. `fetchedAt` defaults to now.
 */
export async function withFullCatalogue(
	run: (catalogue: OpenRouterModelCatalog, dir: string) => Promise<void>,
	options: { readonly fetchedAt?: string; readonly load?: () => OpenRouterCatalogPayload } = {},
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "full-catalogue-"));
	const catalogue = new OpenRouterModelCatalog({
		snapshotPath: join(dir, "openrouter.json"),
		refreshOnInit: false,
		refreshIntervalMs: 0,
		authConfigured: true,
		loadCatalog: async () => (options.load ? options.load() : fullCatalogue(options.fetchedAt)),
	});
	try {
		await catalogue.initialize();
		await catalogue.refresh();
		await run(catalogue, dir);
	} finally {
		catalogue.close();
		await rm(dir, { recursive: true, force: true });
	}
}
