import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { billedMicroUsdPerMillion, buildRateCard, computeRateCardCost, type RateCardV1 } from "../billing-rate-card.js";
import { assessChatModelRow } from "../chat-models.js";
import type { OpenRouterModelRow } from "../openrouter.js";
import {
	FULL_CATALOGUE_FETCHED_AT,
	FULL_CATALOGUE_LIVE,
	fullRow,
	PARTITION,
} from "./fixtures/openrouter-catalogue.fixture.js";
import {
	type OracleModel,
	type OracleTokens,
	assess as oracleAssess,
	cardPrices as oracleCardPrices,
	eventCost as oracleCost,
	perMillionMicro as oraclePerMillion,
} from "./fixtures/pricing-oracle.mjs";

/**
 * The host's money arithmetic against an independent implementation, over everything the catalogue offers.
 *
 * `pricing-oracle.mjs` re-implements the pricing rules from `E-billing-enforce.md` 4.3 with exact rationals (a BigInt
 * numerator over a BigInt denominator), where the host works in fixed-point BigInt (10^-30 dollars). The named cases
 * of `billing-rate-card.test.ts` hold the host to the oracle on sixteen calls; this holds it to the oracle on every
 * model the host offers (288), every tier boundary of every model, and pseudo-random calls from nothing at all to a
 * million tokens, at five fees from nothing to 999.99%. A disagreement of one micro-dollar on any of them fails.
 */

const CATALOGUE = { digest: "0123456789abcdef".repeat(4), fetchedAt: FULL_CATALOGUE_FETCHED_AT };
const MARKUPS = [0, 1, 1500, 2000, 99_999];
const RANDOM_CALLS_PER_MODEL = 40;

const modelsById = new Map(FULL_CATALOGUE_LIVE.map((model) => [model.id, model as unknown as OracleModel]));

/** A small deterministic generator (mulberry32), so a failure names a call that can be replayed. */
function generator(seed: string): () => number {
	let state = 0;
	for (const character of seed) state = (Math.imul(state, 31) + character.charCodeAt(0)) >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function component(next: () => number): number {
	const pick = next();
	if (pick < 0.25) return 0;
	if (pick < 0.6) return 1 + Math.floor(next() * 3_000);
	if (pick < 0.85) return 3_000 + Math.floor(next() * 117_000);
	return 120_000 + Math.floor(next() * 1_080_000);
}

function callsFor(id: string, card: RateCardV1): OracleTokens[] {
	const calls: OracleTokens[] = [
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		{ input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
		{ input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
		{ input: 0, output: 0, cacheRead: 1, cacheWrite: 0 },
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 1 },
		{ input: 2_228, output: 28, cacheRead: 0, cacheWrite: 0 },
		{ input: 15_000, output: 256, cacheRead: 0, cacheWrite: 0 },
		{ input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 },
	];
	// Every tier boundary, from both sides, with the prompt made of input alone, of cache reads alone, of cache writes
	// alone and of all three: the tier is chosen on their sum.
	for (const tier of card.tiers) {
		const edge = tier.minPromptTokens;
		for (const total of [edge - 1, edge, edge + 1]) {
			calls.push({ input: total, output: 500, cacheRead: 0, cacheWrite: 0 });
			calls.push({ input: 0, output: 500, cacheRead: total, cacheWrite: 0 });
			calls.push({ input: 0, output: 500, cacheRead: 0, cacheWrite: total });
			const third = Math.floor(total / 3);
			calls.push({ input: third, output: 500, cacheRead: third, cacheWrite: total - 2 * third });
		}
	}
	const next = generator(id);
	for (let n = 0; n < RANDOM_CALLS_PER_MODEL; n++) {
		calls.push({
			input: component(next),
			output: component(next),
			cacheRead: component(next),
			cacheWrite: component(next),
		});
	}
	return calls;
}

describe("the host's arithmetic against the independent oracle, over the whole offered catalogue", () => {
	it("agrees about which models are offered and why every other is not, from the oracle's current code", () => {
		const disagreements: string[] = [];
		for (const model of FULL_CATALOGUE_LIVE) {
			const reason = oracleAssess(model as unknown as OracleModel);
			const recorded = PARTITION.refused[model.id] ?? null;
			if (reason !== recorded)
				disagreements.push(`${model.id}: oracle says ${reason}, the fixture says ${recorded}`);
		}
		assert.deepEqual(
			disagreements,
			[],
			"the committed partition is what the oracle's code says (regenerate the fixtures)",
		);
		assert.equal(PARTITION.offered.length, 288);
	});

	it("refuses the same rows for the same reasons on rows made to be awkward, in the same order", () => {
		type Pricing = Record<string, unknown>;
		interface Awkward {
			readonly name: string;
			readonly id?: string;
			readonly pricing?: (pricing: Pricing) => Pricing;
			readonly output?: readonly string[] | null;
			readonly input?: readonly string[] | null;
			readonly context?: number;
		}
		const cases: Awkward[] = [
			{ name: "as it is" },
			{ name: "a free id", id: "google/gemini-2.5-flash:free" },
			{ name: "a batch id", id: "google/gemini-2.5-flash:batch" },
			{ name: "a zero prompt", pricing: (p) => ({ ...p, prompt: "0" }) },
			{ name: "a zero completion", pricing: (p) => ({ ...p, completion: "0" }) },
			{ name: "both zero", pricing: (p) => ({ ...p, prompt: "0", completion: "0" }) },
			{
				name: "a zero prompt and a missing completion",
				pricing: ({ completion: _c, ...p }) => ({ ...p, prompt: "0" }),
			},
			{ name: "free cache reads", pricing: (p) => ({ ...p, input_cache_read: "0" }) },
			{ name: "a prompt at the bound", pricing: (p) => ({ ...p, prompt: "0.01" }) },
			{ name: "a prompt above the bound", pricing: (p) => ({ ...p, prompt: "0.0100000000001" }) },
			{ name: "an absurd completion", pricing: (p) => ({ ...p, completion: "9007199255" }) },
			{ name: "a cache write above the bound", pricing: (p) => ({ ...p, input_cache_write: "0.02" }) },
			{ name: "a negative prompt", pricing: (p) => ({ ...p, prompt: "-1" }) },
			{ name: "a malformed prompt", pricing: (p) => ({ ...p, prompt: "1e-7" }) },
			{ name: "a missing completion", pricing: ({ completion: _c, ...p }) => p },
			{
				name: "a tier at nothing",
				pricing: (p) => ({ ...p, overrides: [{ min_prompt_tokens: 200_000, prompt: "0" }] }),
			},
			{
				name: "a tier completion at nothing",
				pricing: (p) => ({ ...p, overrides: [{ min_prompt_tokens: 200_000, completion: "0" }] }),
			},
			{
				name: "a tier above the bound",
				pricing: (p) => ({ ...p, overrides: [{ min_prompt_tokens: 200_000, prompt: "0.02" }] }),
			},
			{
				name: "a tier that is malformed and then zero",
				pricing: (p) => ({ ...p, overrides: [{ min_prompt_tokens: 1, prompt: "0", completion: "x" }] }),
			},
			{
				name: "a tier with free cache reads",
				pricing: (p) => ({ ...p, overrides: [{ min_prompt_tokens: 200_000, input_cache_read: "0" }] }),
			},
			{
				name: "a windowed tier",
				pricing: (p) => ({ ...p, overrides: [{ utc_start: "10:00", prompt: "0.000001" }] }),
			},
			{ name: "an unmodelled dimension", pricing: (p) => ({ ...p, video: "0.5" }) },
			{ name: "a per-request fee", pricing: (p) => ({ ...p, request: "0.005" }) },
			{ name: "reasoning priced apart", pricing: (p) => ({ ...p, internal_reasoning: "0.00001" }) },
			{ name: "a context that is too small", context: 16_000 },
			{ name: "no output modalities stated", output: null },
			{ name: "empty output modalities", output: [] },
			{ name: "an image output", output: ["text", "image"] },
			{ name: "no input modalities stated", input: null },
			{ name: "empty input modalities", input: [] },
			{ name: "an image-only input", input: ["image"] },
		];
		const bases = ["google/gemini-2.5-flash", "anthropic/claude-sonnet-4.5", "moonshotai/kimi-k2.5"];
		const disagreements: string[] = [];
		for (const baseId of bases) {
			const hostBase = fullRow(baseId);
			const oracleBase = modelsById.get(baseId) as unknown as OracleModel & Record<string, any>;
			for (const awkward of cases) {
				const id = awkward.id ?? baseId;
				const hostRow: OpenRouterModelRow = {
					...hostBase,
					id,
					...(awkward.pricing
						? { pricing_raw: awkward.pricing({ ...(hostBase.pricing_raw as Pricing) }) as never }
						: {}),
					...(awkward.output === undefined
						? {}
						: { output_modalities: awkward.output ? [...awkward.output] : null }),
					...(awkward.input === undefined ? {} : { input_modalities: awkward.input ? [...awkward.input] : null }),
					...(awkward.context === undefined ? {} : { context_length: awkward.context }),
				};
				const oracleModel = {
					...oracleBase,
					id,
					...(awkward.pricing ? { pricing: awkward.pricing({ ...oracleBase.pricing }) } : {}),
					architecture: {
						...oracleBase.architecture,
						...(awkward.output === undefined ? {} : { output_modalities: awkward.output }),
						...(awkward.input === undefined ? {} : { input_modalities: awkward.input }),
					},
					...(awkward.context === undefined
						? {}
						: { context_length: awkward.context, top_provider: { context_length: awkward.context } }),
				} as OracleModel;
				const host = assessChatModelRow(hostRow, { catalogue: CATALOGUE, markupBps: 1500 });
				const hostReason = host.ok ? null : host.reason;
				const oracleReason = oracleAssess(oracleModel);
				if (hostReason !== oracleReason) {
					disagreements.push(`${baseId}, ${awkward.name}: host ${hostReason}, oracle ${oracleReason}`);
				}
			}
		}
		assert.deepEqual(disagreements, []);
	});

	it("prices every call identically, to the micro-dollar, in every part", () => {
		let compared = 0;
		let tiered = 0;
		for (const id of PARTITION.offered) {
			const model = modelsById.get(id);
			assert.ok(model, id);
			const mismatches: string[] = [];
			for (const markupBps of MARKUPS) {
				const built = buildRateCard({
					model: id,
					pricing: fullRow(id).pricing_raw,
					catalogue: CATALOGUE,
					markupBps,
				});
				assert.ok(built.ok, `${id} builds a card`);
				if (markupBps === 0 && built.card.tiers.length > 0) tiered += 1;
				for (const tokens of callsFor(id, built.card)) {
					const host = computeRateCardCost(built.card, tokens);
					const reference = oracleCost(model, tokens, markupBps);
					const got = {
						inputCostMicroUsd: host.inputCostMicroUsd,
						outputCostMicroUsd: host.outputCostMicroUsd,
						cacheReadCostMicroUsd: host.cacheReadCostMicroUsd,
						cacheWriteCostMicroUsd: host.cacheWriteCostMicroUsd,
						providerCostMicroUsd: host.providerCostMicroUsd,
						markupMicroUsd: host.markupMicroUsd,
						costMicroUsd: host.totalCostMicroUsd,
					};
					const want = {
						inputCostMicroUsd: reference.inputCostMicroUsd,
						outputCostMicroUsd: reference.outputCostMicroUsd,
						cacheReadCostMicroUsd: reference.cacheReadCostMicroUsd,
						cacheWriteCostMicroUsd: reference.cacheWriteCostMicroUsd,
						providerCostMicroUsd: reference.providerCostMicroUsd,
						markupMicroUsd: reference.markupMicroUsd,
						costMicroUsd: reference.costMicroUsd,
					};
					compared += 1;
					if (JSON.stringify(got) !== JSON.stringify(want)) {
						mismatches.push(
							`${id} @${markupBps}bps ${JSON.stringify(tokens)}: host ${JSON.stringify(got)} oracle ${JSON.stringify(want)}`,
						);
						if (mismatches.length >= 3) break;
					}
				}
				if (mismatches.length >= 3) break;
			}
			assert.deepEqual(mismatches, [], `${id}: the host and the oracle disagree`);
		}
		assert.ok(compared > 50_000, `compared ${compared} calls`);
		assert.ok(tiered >= 40, `the tiered models were covered (${tiered})`);
	});

	it("shows every model's billed price per million tokens exactly as the oracle rounds it", () => {
		for (const id of PARTITION.offered) {
			const model = modelsById.get(id);
			assert.ok(model, id);
			const { base } = oracleCardPrices(model);
			const built = buildRateCard({
				model: id,
				pricing: fullRow(id).pricing_raw,
				catalogue: CATALOGUE,
				markupBps: 0,
			});
			assert.ok(built.ok, id);
			for (const markupBps of MARKUPS) {
				assert.equal(
					billedMicroUsdPerMillion(built.card.prices.prompt, markupBps),
					oraclePerMillion(base.prompt, markupBps),
					`${id} prompt @${markupBps}`,
				);
				assert.equal(
					billedMicroUsdPerMillion(built.card.prices.completion, markupBps),
					oraclePerMillion(base.completion, markupBps),
					`${id} completion @${markupBps}`,
				);
			}
		}
	});
});
