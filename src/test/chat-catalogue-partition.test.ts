import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { DEFAULT_BILLING_MARKUP_BPS, parseRateCard } from "../billing-rate-card.js";
import { assessChatModelRow, chatModelRefusalStatus, isValidChatModelId } from "../chat-models.js";
import { OpenRouterModelCatalog } from "../model-catalog.js";
import {
	FULL_CATALOGUE_FETCHED_AT,
	fullCatalogue,
	fullRow,
	fullRows,
	PARTITION,
	withFullCatalogue,
} from "./fixtures/openrouter-catalogue.fixture.js";

/**
 * The one rule for what a chat may speak with, over the WHOLE live catalogue of 2026-09-29 (464 models).
 *
 * `openrouter-catalogue-20260929.partition.json` is the answer of an independent implementation (`pricing-oracle.mjs`,
 * exact rational arithmetic): which ids are offered and the first rule that refuses each other. The
 * host must agree with it row for row. On this catalogue the billing map (`E-billing-enforce.md` 4.3) counted 173
 * refusals and 291 models on offer; the host refuses three more, the models that answer in something other than
 * text (an image model and two audio models), so it offers 288.
 */

const CATALOGUE = { digest: "0123456789abcdef".repeat(4), fetchedAt: FULL_CATALOGUE_FETCHED_AT };
const options = { catalogue: CATALOGUE, markupBps: DEFAULT_BILLING_MARKUP_BPS };

describe("the whole live catalogue, through the one offer rule", () => {
	it("has the 464 rows the billing map counted", () => {
		assert.equal(fullRows().length, 464);
		assert.equal(PARTITION.total, 464);
		assert.equal(new Set(fullRows().map((row) => row.id)).size, 464);
	});

	it("offers exactly the models the independent oracle offers, and refuses every other with the oracle's reason", () => {
		const offered: string[] = [];
		const refused: Record<string, string> = {};
		for (const row of fullRows()) {
			const assessment = assessChatModelRow(row, options);
			if (assessment.ok) offered.push(row.id);
			else refused[row.id] = assessment.reason;
		}
		assert.deepEqual(offered.sort(), [...PARTITION.offered]);
		assert.deepEqual(
			Object.fromEntries(Object.entries(refused).sort(([left], [right]) => (left < right ? -1 : 1))),
			PARTITION.refused,
		);
	});

	it("reproduces the billing map's per-reason counts, and adds three refusals of its own", () => {
		const counts: Record<string, number> = {};
		for (const reason of Object.values(PARTITION.refused)) counts[reason] = (counts[reason] ?? 0) + 1;
		assert.deepEqual(counts, {
			batch_variant: 75,
			zero_priced: 20,
			price_dynamic: 6,
			no_tools: 61,
			override_unmodelled: 5,
			override_time_window: 1,
			context_too_small: 5,
			output_not_text: 3,
		});
		assert.deepEqual({ ...PARTITION.counts }, counts);
		assert.equal(PARTITION.offered.length, 288);
		assert.equal(PARTITION.offered.length + Object.keys(PARTITION.refused).length, 464);
		const billingMapRefusals = Object.values(PARTITION.refused).filter((reason) => reason !== "output_not_text");
		assert.equal(billingMapRefusals.length, 173, "the billing map's 173, unchanged");
		assert.deepEqual(
			Object.entries(PARTITION.refused)
				.filter(([, reason]) => reason === "output_not_text")
				.map(([id]) => id),
			["google/gemini-3-pro-image", "openai/gpt-audio", "openai/gpt-audio-mini"],
		);
	});

	it("gives every refusal a reason and a status, and never a price fallback", () => {
		const statuses = new Set<number>();
		for (const row of fullRows()) {
			const assessment = assessChatModelRow(row, options);
			if (assessment.ok) continue;
			assert.ok(assessment.reason.length > 0, row.id);
			assert.ok(assessment.message.length > 0, row.id);
			statuses.add(chatModelRefusalStatus(assessment.code));
		}
		assert.deepEqual([...statuses].sort(), [422], "every refusal on a live catalogue is a 422 model_unpriced");
	});

	it("builds a card for every model it offers, from the row's own strings, and each survives a round trip", () => {
		for (const id of PARTITION.offered) {
			const row = fullRow(id);
			const assessment = assessChatModelRow(row, options);
			assert.ok(assessment.ok, id);
			assert.deepEqual(parseRateCard(JSON.parse(JSON.stringify(assessment.card))), assessment.card, id);
			assert.equal(assessment.card.model, id);
			assert.equal(
				assessment.card.prices.prompt,
				row.pricing_raw?.prompt,
				`${id}: the prompt price is the row's own string`,
			);
			assert.equal(
				assessment.card.prices.completion,
				row.pricing_raw?.completion,
				`${id}: so is the completion price`,
			);
			assert.equal(assessment.card.version, `cat:0123456789ab@${FULL_CATALOGUE_FETCHED_AT}`);
		}
	});

	it("carries a tier for every offered model that lists an override, and only the modelled prices in it", () => {
		let tiered = 0;
		for (const id of PARTITION.offered) {
			const overrides = fullRow(id).pricing_raw?.overrides;
			const assessment = assessChatModelRow(fullRow(id), options);
			assert.ok(assessment.ok, id);
			const listed = Array.isArray(overrides) ? overrides.length : 0;
			assert.equal(assessment.card.tiers.length, listed, id);
			if (listed > 0) tiered += 1;
			for (const tier of assessment.card.tiers) {
				for (const key of Object.keys(tier.prices)) {
					assert.ok(["prompt", "completion", "inputCacheRead", "inputCacheWrite"].includes(key), `${id}: ${key}`);
				}
			}
		}
		assert.equal(tiered, 51, "the oracle finds 51 models on offer with a tier");
	});

	it("offers only ids a person can send, the ~ aliases included, so the picker never lists a voice admission would refuse", () => {
		const aliases = PARTITION.offered.filter((id) => id.startsWith("~"));
		assert.equal(aliases.length, 17, "the catalogue's ~vendor/name-latest aliases");
		for (const id of PARTITION.offered) assert.equal(isValidChatModelId(id), true, id);
		for (const bad of [
			"",
			" ",
			"has space/in it",
			"mock:done",
			"MOCK:done",
			"x".repeat(201),
			"-lead/dash",
			"a\nb/c",
			"~",
			"~~a/b",
		]) {
			assert.equal(isValidChatModelId(bad), false, JSON.stringify(bad));
		}
	});
});

describe("asking the live catalogue for a model by the id it goes by", () => {
	it("resolves a canonical slug to the model itself, not to the :batch or :free variant that shares it", async () => {
		await withFullCatalogue(async (catalogue) => {
			assert.equal((await catalogue.resolveRow("openai/gpt-5-2025-08-07"))?.row.id, "openai/gpt-5");
			assert.equal((await catalogue.resolveRow("qwen/qwen3.8-27b-20260814"))?.row.id, "qwen/qwen3.8-27b");
			assert.equal(
				(await catalogue.resolveRow("openai/gpt-5:batch"))?.row.id,
				"openai/gpt-5:batch",
				"an exact id is exact",
			);
			assert.equal(await catalogue.resolveRow("vendor/not-a-model"), undefined);
		});
	});

	it("keeps each row's price strings through the snapshot it writes and the one it reads back", async () => {
		await withFullCatalogue(async (catalogue, dir) => {
			const written = await catalogue.snapshotRows();
			const kimi = written.rows.find((row) => row.id === "moonshotai/kimi-k2.5");
			assert.deepEqual(kimi?.pricing_raw, {
				prompt: "0.00000045",
				completion: "0.00000225",
				input_cache_read: "0.00000007",
			});
			const flash = written.rows.find((row) => row.id === "google/gemini-2.5-flash");
			assert.equal(flash?.pricing_raw?.input_cache_write, "0.0000000833333333333333");
			const reopened = new OpenRouterModelCatalog({
				snapshotPath: `${dir}/openrouter.json`,
				refreshOnInit: false,
				refreshIntervalMs: 0,
				loadCatalog: async () => {
					throw new Error("the snapshot on disk must be enough");
				},
			});
			try {
				const read = await reopened.snapshotRows();
				assert.equal(read.digest, written.digest, "the digest still verifies with the price strings in the rows");
				assert.deepEqual(read.rows, written.rows);
			} finally {
				reopened.close();
			}
		});
	});

	it("can hand back the exact bytes its digest names, so a snapshot can be archived and verified", async () => {
		await withFullCatalogue(async (catalogue) => {
			const resolved = await catalogue.resolveRow("moonshotai/kimi-k2.5");
			assert.ok(resolved);
			const json = resolved.coreJson();
			assert.equal(createHash("sha256").update(json).digest("hex"), resolved.digest);
			const core = JSON.parse(json) as { fetched_at: string; models: Array<{ id: string }> };
			assert.equal(core.models.length, 464);
			assert.equal(core.fetched_at, resolved.fetchedAt);
			const rows = await catalogue.snapshotRows();
			assert.equal(createHash("sha256").update(rows.coreJson()).digest("hex"), rows.digest);
		});
	});

	it("serves a catalogue payload the host's own merge produced, one fetch time for all", () => {
		const payload = fullCatalogue("2026-09-29T20:00:00.000Z");
		assert.equal(payload.models.length, 464);
		assert.equal(payload.fetched_at, "2026-09-29T20:00:00.000Z");
	});
});
