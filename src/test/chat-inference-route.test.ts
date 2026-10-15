import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { parseRateCard, rateCardVersion } from "../billing-rate-card.js";
import { useInvocationHarness } from "./chat-runtime-fixture.js";

/**
 * Choosing a voice through the real router and spawner (Sobremesa sub-tasks 4 and 5).
 *
 * `inference: { provider: "openrouter", model }` is admitted only if the model resolves in the LIVE
 * catalogue with tools and prices. What is admitted is on the run, on the Session, in the catalogue row,
 * in the request the sandbox is handed, and priced: the Session carries a rate card of the catalogue row's own
 * price strings, and the snapshot they came from is archived. What is not admitted is refused before any run
 * exists, with a 4xx or 5xx and a reason code. The catalogue here is a real `OpenRouterModelCatalog` fed the real
 * 2026-09-29 rows.
 */

interface SessionSource {
	readonly pricing?: unknown;
	readonly model?: string;
	readonly provider?: string;
}

const sourceOf = (documentJson: string): SessionSource =>
	(JSON.parse(documentJson) as { source: SessionSource }).source;

describe("POST /api/invocations choosing a voice", { concurrency: false }, () => {
	const h = useInvocationHarness({
		catalogue: true,
		env: {
			CHOREOGRAPH_WORKSPACE_CHAT_MODEL: "google/gemini-2.5-flash",
			CHOREOGRAPH_CHAT_MODEL_DENYLIST: "openai/*",
		},
	});

	it("refuses, before any run exists, a voice the catalogue would not admit, each with its own code and reason", async () => {
		const runsBefore = await h.journal.listRuns({ ownerUserId: "owner-1", limit: 100 });
		const cases: Array<[string, unknown, number, string, string | undefined]> = [
			[
				"an id no catalogue has",
				{ provider: "openrouter", model: "vendor/not-a-model" },
				404,
				"model_not_found",
				"not_in_catalogue",
			],
			[
				"a router priced -1",
				{ provider: "openrouter", model: "openrouter/auto" },
				422,
				"model_unpriced",
				"price_dynamic",
			],
			[
				"a model with no tools",
				{ provider: "openrouter", model: "perplexity/sonar" },
				422,
				"model_unpriced",
				"no_tools",
			],
			[
				"an image-output model",
				{ provider: "openrouter", model: "google/gemini-3.1-flash-image" },
				422,
				"model_unpriced",
				"no_tools",
			],
			[
				"a free model",
				{ provider: "openrouter", model: "qwen/qwen3.8-27b:free" },
				422,
				"model_unpriced",
				"zero_priced",
			],
			[
				"a model the operator denied",
				{ provider: "openrouter", model: "openai/gpt-5" },
				403,
				"model_denied",
				"operator_denylist",
			],
			["another provider", { provider: "openai", model: "gpt-5" }, 400, "inference_provider_unsupported", undefined],
			["a mock model", { provider: "openrouter", model: "mock:done" }, 400, "inference_model_invalid", undefined],
			["a malformed input", { provider: "openrouter" }, 400, "workspace_chat_input_invalid", undefined],
		];
		for (const [index, [label, inference, status, code, reason]] of cases.entries()) {
			const response = await h.post(h.chat(`c2chat.inv.voice-refused-${index}`, { inference }));
			assert.equal(response.statusCode, status, `${label}: ${response.body}`);
			assert.equal(response.json.error.code, code, label);
			if (reason) assert.equal(response.json.error.details.reason, reason, label);
		}
		assert.deepEqual(
			await h.journal.listRuns({ ownerUserId: "owner-1", limit: 100 }),
			runsBefore,
			"no run was started",
		);
	});

	it("starts the chat on the requested voice: the run, the Session, the catalogue row and the sandbox request all name it", async () => {
		const response = await h.post(
			h.chat("c2chat.inv.voice-kimi", { inference: { provider: "openrouter", model: "moonshotai/kimi-k2.5" } }),
		);
		assert.equal(response.statusCode, 202, response.body);
		const { runId } = response.json;

		const instance = await h.runtime.getWorkflowInstance(runId);
		const inputs = JSON.parse(instance?.inputs_json ?? "{}");
		assert.equal(inputs.config.model, "moonshotai/kimi-k2.5");
		assert.equal(inputs.config.provider, "openrouter");
		assert.equal(inputs.args.pilot.model, "moonshotai/kimi-k2.5");

		const session = await h.waitForSession(runId);
		assert.equal(session.model, "moonshotai/kimi-k2.5");
		const source = sourceOf(session.document_json);
		assert.equal(source.model, "moonshotai/kimi-k2.5");
		assert.equal(source.provider, "openrouter");
		const row = await h.runtime.readChatSessionCatalogue(session.session_id);
		assert.equal(row?.model, "moonshotai/kimi-k2.5");
		assert.equal(row?.provider, "openrouter");

		const handed = await h.waitForSpawn(session.session_id);
		assert.equal(handed.model, "moonshotai/kimi-k2.5");
		assert.equal(handed.model_descriptor?.id, "moonshotai/kimi-k2.5");
		assert.equal(handed.model_descriptor?.contextWindow, 262_144);
		await h.settle();
	});

	it("prices the chat from the catalogue: the Session carries a rate card of the row's own price strings, at the markup in force", async () => {
		const response = await h.post(
			h.chat("c2chat.inv.voice-priced", { inference: { provider: "openrouter", model: "moonshotai/kimi-k2.5" } }),
		);
		assert.equal(response.statusCode, 202, response.body);
		const session = await h.waitForSession(response.json.runId);
		const card = parseRateCard(sourceOf(session.document_json).pricing, "source.pricing");
		const snapshot = await h.catalogue!.snapshotRows();
		assert.equal(card.model, "moonshotai/kimi-k2.5");
		assert.deepEqual(card.prices, { prompt: "0.00000045", completion: "0.00000225", inputCacheRead: "0.00000007" });
		assert.deepEqual(card.tiers, []);
		assert.equal(card.markupBps, 1500, "today's 15%: this release changes nobody's fee");
		assert.equal(card.catalogue.digest, snapshot.digest);
		assert.equal(card.catalogue.fetchedAt, snapshot.fetchedAt);
		assert.equal(card.version, rateCardVersion(snapshot.digest, snapshot.fetchedAt));

		const instance = await h.runtime.getWorkflowInstance(response.json.runId);
		const inputs = JSON.parse(instance?.inputs_json ?? "{}");
		assert.deepEqual(inputs.hostContext.pricing, card, "the host's own record of what it admitted");
		assert.equal(
			JSON.stringify(inputs.args).includes("markupBps"),
			false,
			"the script's arguments never carry a price",
		);
		await h.settle();
	});

	it("archives the catalogue snapshot the price came from, once, so any billed event can be re-derived", async () => {
		const first = await h.post(
			h.chat("c2chat.inv.voice-archive-1", { inference: { provider: "openrouter", model: "moonshotai/kimi-k2.5" } }),
		);
		const second = await h.post(
			h.chat("c2chat.inv.voice-archive-2", {
				inference: { provider: "openrouter", model: "deepseek/deepseek-chat" },
			}),
		);
		assert.equal(first.statusCode, 202, first.body);
		assert.equal(second.statusCode, 202, second.body);
		const card = parseRateCard(
			sourceOf((await h.waitForSession(first.json.runId)).document_json).pricing,
			"source.pricing",
		);
		const archived = await h.runtime.readPricingCatalogueArchive(card.catalogue.digest);
		assert.ok(archived, "the snapshot a Session was priced from is kept");
		assert.equal(archived.digest, card.catalogue.digest);
		assert.equal(archived.fetchedAt, card.catalogue.fetchedAt);
		assert.equal(
			createHash("sha256").update(archived.coreJson).digest("hex"),
			card.catalogue.digest,
			"the archived bytes are the bytes the digest names",
		);
		const core = JSON.parse(archived.coreJson) as { models: Array<{ id: string; pricing_raw: { prompt: string } }> };
		assert.equal(core.models.find((model) => model.id === "moonshotai/kimi-k2.5")?.pricing_raw.prompt, "0.00000045");
		assert.equal(
			core.models.find((model) => model.id === "deepseek/deepseek-chat")?.pricing_raw.prompt,
			"0.0000002574",
		);
		const counted = await h.runtime.raw("SELECT COUNT(*) AS n FROM pricing_catalogue_archive WHERE digest = ?", [
			card.catalogue.digest,
		]);
		assert.equal(Number(counted.rows[0].n), 1, "two chats from one snapshot archive it once");
		assert.equal(await h.runtime.readPricingCatalogueArchive("f".repeat(64)), null);
		await h.settle();
	});

	it("accepts a canonical slug and pins the live route id the provider is called with", async () => {
		const response = await h.post(
			h.chat("c2chat.inv.voice-canonical", {
				inference: { provider: "openrouter", model: "moonshotai/kimi-k2.5-0127" },
			}),
		);
		assert.equal(response.statusCode, 202, response.body);
		const session = await h.waitForSession(response.json.runId);
		assert.equal(session.model, "moonshotai/kimi-k2.5");
		assert.equal(
			parseRateCard(sourceOf(session.document_json).pricing, "source.pricing").model,
			"moonshotai/kimi-k2.5",
		);
		await h.settle();
	});

	it("starts a chat with no voice asked for on the House default, admitted and priced from the same live catalogue", async () => {
		const response = await h.post(h.chat("c2chat.inv.voice-house", {}));
		assert.equal(response.statusCode, 202, response.body);
		const session = await h.waitForSession(response.json.runId);
		assert.equal(session.model, "google/gemini-2.5-flash");
		const card = parseRateCard(sourceOf(session.document_json).pricing, "source.pricing");
		assert.equal(card.model, "google/gemini-2.5-flash", "the default model included, no static table");
		assert.equal(card.prices.inputCacheWrite, "0.0000000833333333333333");
		const handed = await h.waitForSpawn(session.session_id);
		assert.equal(handed.model, "google/gemini-2.5-flash");
		assert.equal(handed.model_descriptor?.contextWindow, 1_048_576);
		await h.settle();
	});
});

describe("POST /api/invocations when the House default is not one the host would admit", { concurrency: false }, () => {
	const h = useInvocationHarness({
		catalogue: true,
		env: { CHOREOGRAPH_WORKSPACE_CHAT_MODEL: "openrouter/auto" },
	});

	it("answers 503 model_house_default_unavailable with the reason, and starts nothing, rather than billing a fallback rate", async () => {
		const runsBefore = await h.journal.listRuns({ ownerUserId: "owner-1", limit: 100 });
		const response = await h.post(h.chat("c2chat.inv.house-broken", {}));
		assert.equal(response.statusCode, 503, response.body);
		assert.equal(response.json.error.code, "model_house_default_unavailable");
		assert.equal(response.json.error.details.reason, "price_dynamic");
		assert.equal(response.json.error.details.code, "model_unpriced");
		assert.deepEqual(await h.journal.listRuns({ ownerUserId: "owner-1", limit: 100 }), runsBefore);
		// A person who chooses a voice the host does admit is not held hostage to the House default.
		const chosen = await h.post(
			h.chat("c2chat.inv.house-broken-chosen", {
				inference: { provider: "openrouter", model: "deepseek/deepseek-chat" },
			}),
		);
		assert.equal(chosen.statusCode, 202, chosen.body);
		await h.settle();
	});
});

describe("POST /api/invocations when the catalogue's prices are older than a day", { concurrency: false }, () => {
	const h = useInvocationHarness({
		catalogue: true,
		catalogueAgeMs: 25 * 3_600_000,
		env: { CHOREOGRAPH_WORKSPACE_CHAT_MODEL: "google/gemini-2.5-flash" },
	});

	it("answers 503 pricing_unavailable, which a client may retry, and starts nothing, for a voice or for the House default", async () => {
		const runsBefore = await h.journal.listRuns({ ownerUserId: "owner-1", limit: 100 });
		const chosen = await h.post(
			h.chat("c2chat.inv.stale-chosen", { inference: { provider: "openrouter", model: "moonshotai/kimi-k2.5" } }),
		);
		assert.equal(chosen.statusCode, 503, chosen.body);
		assert.equal(chosen.json.error.code, "pricing_unavailable");
		assert.equal(chosen.json.error.details.reason, "catalogue_stale");
		const house = await h.post(h.chat("c2chat.inv.stale-house", {}));
		assert.equal(house.statusCode, 503, house.body);
		assert.equal(house.json.error.code, "model_house_default_unavailable");
		assert.equal(house.json.error.details.reason, "catalogue_stale");
		assert.deepEqual(await h.journal.listRuns({ ownerUserId: "owner-1", limit: 100 }), runsBefore);
	});
});
