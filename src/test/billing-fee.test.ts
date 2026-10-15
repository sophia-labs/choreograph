/**
 * The fee is a boot-time setting (Vera, 2026-10-03): the service fee on a model's price is 15% until the FLIP, when
 * `BILLING_FEE_BPS=2000` and `BILLING_GATE_MODE=enforce` are set together and one guarded restart makes it 20%. The
 * observe-mode deploy therefore changes nobody's price. Set the same way the gate mode is (an SSM value that
 * `load-env.sh` writes into the service's environment), read the same way (a restart changes it, nothing else does).
 *
 * What these pin: the reading (a typo never moves a bill: not to zero, not to a guess), the static table at both
 * fees with hand-computed numbers, the version stamp (byte-identical to the deployed one at the default, qualified
 * by the fee otherwise, so an event is re-derivable from its own stamp), the cards and quotes and the host's facts,
 * and a legacy Session priced, stamped and re-derived by the host's three readers at the fee in force. A card keeps
 * the fee it was admitted at: the flip does not re-price a chat already begun.
 *
 * Real stores and the real spawner (the provider's network is the one stand-in, as in every inference suite).
 *
 * RUN:  npx tsx --test src/test/billing-fee.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { minAdmitMicroUsd, rateCardAdmissionPricing } from "../billing-gate.js";
import * as pricing from "../billing-pricing.js";
import { computeCost, MARKUP_PERCENT, PRICING_VERSION } from "../billing-pricing.js";
import {
	buildRateCard,
	computeRateCardCost,
	DEFAULT_BILLING_MARKUP_BPS,
	type RateCardV1,
	resolveBillingMarkupBps,
	resolveBillingMarkupPercent,
} from "../billing-rate-card.js";
import { workspaceChatHostFacts } from "../workflow/workspace-chat.js";
import { setBillingFeeEnv } from "./billing-fee-fixture.js";
import {
	inferenceOperationId,
	proxyAnswering,
	runInference,
	seedPricedSession,
	waitForBillingEvent,
	withPricingHarness,
} from "./chat-pricing-fixture.js";
import { fullRow } from "./fixtures/openrouter-catalogue.fixture.js";

const HOUSE = "google/gemini-2.5-flash";
const HOUSE_VOICE = { provider: "openrouter", model: HOUSE };
/** The House's first live turn: 2,228 input tokens at $0.30/M = 668.4 -> 668 and 28 output at $2.50/M = 70: 738 µUSD. */
const FIRST_TURN = { input: 2228, output: 28, cacheRead: 0, cacheWrite: 0 };
const CATALOGUE = { digest: "0123456789abcdef".repeat(4), fetchedAt: "2026-09-29T20:00:00.000Z" };

function cardAt(id: string, markupBps: number): RateCardV1 {
	const built = buildRateCard({ model: id, pricing: fullRow(id).pricing_raw, catalogue: CATALOGUE, markupBps });
	assert.ok(built.ok, `${id} builds a card`);
	return built.card;
}

/** Run `body` with the fee set to `bps` (or unset) in this process, and put it back. */
async function atFee<T>(bps: number | undefined, body: () => Promise<T> | T): Promise<T> {
	const restore = setBillingFeeEnv(bps);
	try {
		return await body();
	} finally {
		restore();
	}
}

describe("BILLING_FEE_BPS: the fee is read at boot, 15% until the flip says 20%", () => {
	it("is today's 1500 when unset, and 2000 when the flip sets it", () => {
		assert.equal(pricing.DEFAULT_BILLING_FEE_BPS, 1500);
		assert.equal(
			MARKUP_PERCENT * 100,
			pricing.DEFAULT_BILLING_FEE_BPS,
			"one default, in percent and in basis points",
		);
		assert.equal(pricing.resolveBillingFeeBps({}), 1500);
		assert.equal(pricing.resolveBillingFeeBps({ BILLING_FEE_BPS: "2000" }), 2000);
		assert.equal(pricing.resolveBillingFeeBps({ BILLING_FEE_BPS: " 2000 " }), 2000);
		assert.equal(pricing.resolveBillingFeeBps({ BILLING_FEE_BPS: "1250" }), 1250);
		assert.equal(pricing.resolveBillingFeeBps({ BILLING_FEE_BPS: "0" }), 0, "zero is a choice");
		assert.equal(
			pricing.resolveBillingFeeBps({ BILLING_FEE_BPS: "100000" }),
			100_000,
			"the ceiling itself is allowed",
		);
	});

	it("falls back to the default on nonsense, never to zero and never to a guess, and says so", () => {
		for (const bad of [
			"-1",
			"abc",
			"20%",
			"2000.5",
			"1e3",
			"1,5",
			"0x10",
			"+2000",
			"Infinity",
			"NaN",
			"100001",
			"1000000",
			"２０００",
		]) {
			const read = pricing.readBillingFee({ BILLING_FEE_BPS: bad });
			assert.equal(read.bps, 1500, JSON.stringify(bad));
			assert.equal(read.source, "default", JSON.stringify(bad));
			assert.match(read.warnings.join(" "), /BILLING_FEE_BPS/, JSON.stringify(bad));
		}
		for (const blank of ["", "   "]) {
			assert.deepEqual(pricing.readBillingFee({ BILLING_FEE_BPS: blank }), {
				bps: 1500,
				source: "default",
				warnings: [],
			});
		}
	});

	it("reports where the fee came from, and warns about one that is probably a unit mistake", () => {
		assert.deepEqual(pricing.readBillingFee({}), { bps: 1500, source: "default", warnings: [] });
		assert.deepEqual(pricing.readBillingFee({ BILLING_FEE_BPS: "2000" }), { bps: 2000, source: "env", warnings: [] });
		for (const usual of ["500", "1500", "2000", "5000"]) {
			assert.deepEqual(pricing.readBillingFee({ BILLING_FEE_BPS: usual }).warnings, [], usual);
		}
		for (const unusual of ["0", "20", "499", "5001", "100000"]) {
			const read = pricing.readBillingFee({ BILLING_FEE_BPS: unusual });
			assert.equal(read.bps, Number(unusual), `${unusual} is honoured`);
			assert.match(read.warnings.join(" "), /basis points/, `${unusual} is flagged: 2000 is 20%`);
		}
	});

	it("retires the percent knob of the pricing release: CHOREOGRAPH_BILLING_MARKUP_PERCENT changes nothing, and says so", () => {
		const read = pricing.readBillingFee({ CHOREOGRAPH_BILLING_MARKUP_PERCENT: "20" });
		assert.equal(read.bps, 1500, "a second knob for one number is how a fee moves by accident");
		assert.match(read.warnings.join(" "), /CHOREOGRAPH_BILLING_MARKUP_PERCENT is no longer read/);
		assert.equal(
			pricing.resolveBillingFeeBps({ CHOREOGRAPH_BILLING_MARKUP_PERCENT: "20", BILLING_FEE_BPS: "1500" }),
			1500,
		);
		// The rate card module's names are the same reading, not a second one.
		assert.equal(DEFAULT_BILLING_MARKUP_BPS, pricing.DEFAULT_BILLING_FEE_BPS);
		assert.equal(resolveBillingMarkupBps({}), 1500);
		assert.equal(resolveBillingMarkupBps({ BILLING_FEE_BPS: "2000" }), 2000);
		assert.equal(resolveBillingMarkupPercent({ BILLING_FEE_BPS: "1250" }), 12.5);
	});
});

describe("the static table prices at the fee in force", () => {
	it("bills the House first turn at 848 µUSD at the default 15% and 885 at the flip's 20% (hand-computed, truncating)", async () => {
		await atFee(undefined, () => {
			const cost = computeCost(HOUSE, FIRST_TURN);
			assert.equal(cost.providerCostMicroUsd, 738);
			assert.equal(cost.markupMicroUsd, 110, "738 x 15% = 110.7, truncated");
			assert.equal(cost.totalCostMicroUsd, 848);
		});
		await atFee(2000, () => {
			const cost = computeCost(HOUSE, FIRST_TURN);
			assert.equal(cost.providerCostMicroUsd, 738);
			assert.equal(cost.markupMicroUsd, 147, "738 x 20% = 147.6, truncated");
			assert.equal(cost.totalCostMicroUsd, 885);
		});
	});

	it("takes the fee as an argument when it is given one, whatever the environment says", async () => {
		await atFee(2000, () => {
			assert.equal(computeCost(HOUSE, FIRST_TURN, "openrouter", 1500).totalCostMicroUsd, 848);
			assert.equal(computeCost(HOUSE, FIRST_TURN, "openrouter", 1250).totalCostMicroUsd, 830, "738 x 12.5% = 92.25");
			assert.equal(computeCost(HOUSE, FIRST_TURN, "openrouter", 0).totalCostMicroUsd, 738);
		});
	});

	it("carries exactly the fee of the provider's cost on every priced shape, at both fees", async () => {
		const shapes = [
			{ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			{ input: 15_000, output: 256, cacheRead: 0, cacheWrite: 0 },
			{ input: 2_228, output: 28, cacheRead: 0, cacheWrite: 0 },
			{ input: 300_000, output: 10_000, cacheRead: 1_000, cacheWrite: 500 },
		];
		for (const bps of [1500, 2000]) {
			await atFee(bps, () => {
				for (const model of [HOUSE, "anthropic/claude-opus-4.5", "some/unknown-model"]) {
					for (const tokens of shapes) {
						const cost = computeCost(model, tokens);
						assert.equal(
							cost.markupMicroUsd,
							Math.trunc((cost.providerCostMicroUsd * bps) / 10_000),
							`${bps} ${model} ${JSON.stringify(tokens)}`,
						);
						assert.equal(cost.totalCostMicroUsd, cost.providerCostMicroUsd + cost.markupMicroUsd);
					}
				}
			});
		}
	});

	it("prices nothing for a local model or a mock, at any fee", async () => {
		for (const bps of [1500, 2000]) {
			await atFee(bps, () => {
				assert.equal(computeCost("qwen3-8b", FIRST_TURN, "lmstudio").totalCostMicroUsd, 0);
				assert.equal(computeCost("mock:done", FIRST_TURN).totalCostMicroUsd, 0);
			});
		}
	});

	it("stamps the version: the deployed string at the default, qualified by the fee otherwise", async () => {
		assert.equal(PRICING_VERSION, "p0-2026-08-05-luna", "the string the deployed build stamps, unchanged");
		assert.equal(pricing.staticPricingVersion(1500), "p0-2026-08-05-luna");
		assert.equal(pricing.staticPricingVersion(2000), "p0-2026-08-05-luna+fee2000");
		assert.equal(pricing.staticPricingVersion(0), "p0-2026-08-05-luna+fee0");
		await atFee(undefined, () => assert.equal(pricing.staticPricingVersion(), PRICING_VERSION));
		await atFee(2000, () => assert.equal(pricing.staticPricingVersion(), "p0-2026-08-05-luna+fee2000"));
	});
});

describe("cards, quotes and the host's facts follow the fee in force", () => {
	it("the host block of workspace-chat-v1 states the fee in force", () => {
		assert.deepEqual(workspaceChatHostFacts({}).pricing, { currency: "USD", markupPercent: 15, markupBps: 1500 });
		assert.deepEqual(workspaceChatHostFacts({ BILLING_FEE_BPS: "2000" }).pricing, {
			currency: "USD",
			markupPercent: 20,
			markupBps: 2000,
		});
	});

	it("the House's smallest viable call is 5,911 at 15% and 6,168 at 20%, on the table and on a card", async () => {
		for (const [bps, expected] of [
			[1500, 5_911],
			[2000, 6_168],
		] as const) {
			await atFee(bps, () => {
				assert.equal(minAdmitMicroUsd(rateCardAdmissionPricing, HOUSE_VOICE), expected, `${bps}: a legacy Session`);
				assert.equal(
					minAdmitMicroUsd(rateCardAdmissionPricing, HOUSE_VOICE, cardAt(HOUSE, bps)),
					expected,
					`${bps}: a card admitted at that fee`,
				);
			});
		}
	});

	it("a card keeps the fee it was admitted at when the process fee moves: the flip does not re-price a chat already begun", async () => {
		const begunBeforeTheFlip = cardAt(HOUSE, 1500);
		await atFee(2000, () => {
			assert.equal(minAdmitMicroUsd(rateCardAdmissionPricing, HOUSE_VOICE, begunBeforeTheFlip), 5_911);
			assert.equal(computeRateCardCost(begunBeforeTheFlip, FIRST_TURN).totalCostMicroUsd, 850);
			assert.equal(
				minAdmitMicroUsd(rateCardAdmissionPricing, HOUSE_VOICE),
				6_168,
				"while a legacy Session, which has no card, moves with the fee",
			);
		});
	});
});

describe("through the host: a legacy Session is priced, stamped and re-derived at the fee in force", () => {
	for (const bps of [1500, 2000]) {
		it(`at ${bps} bps the reservation, the event and the store's own re-derivation all name that fee`, async () => {
			await atFee(bps, async () => {
				await withPricingHarness(
					async ({ runtime, billing, spawner }) => {
						const session = await seedPricedSession(runtime, { suffix: `fee-${bps}`, model: HOUSE });
						await runInference(spawner, session, `req-fee-${bps}`);
						const operationId = await inferenceOperationId(runtime, session.sessionId);
						const reservation = await runtime.readAgentSessionInferenceReservation(operationId);
						assert.equal(reservation?.pricing_version, pricing.staticPricingVersion(bps));
						// The event only reaches the ledger if the store's own re-derivation (a third reader of the
						// price) agrees with the settlement: this fails with "a reader priced it differently".
						const event = await waitForBillingEvent(billing, operationId);
						const expected = computeCost(HOUSE, FIRST_TURN, "openrouter", bps);
						assert.equal(event.pricingVersion, pricing.staticPricingVersion(bps));
						assert.equal(event.costMicroUsd, expected.totalCostMicroUsd);
						assert.equal(event.markupMicroUsd, expected.markupMicroUsd);
						assert.equal(event.pricedDefault, false);
					},
					{ llmProxy: proxyAnswering({ input: FIRST_TURN.input, output: FIRST_TURN.output }) },
				);
			});
		});
	}

	it("a card admitted at 1500 is still billed at 1500 when the host has been restarted at 2000", async () => {
		const card = cardAt(HOUSE, 1500);
		await atFee(2000, async () => {
			await withPricingHarness(
				async ({ runtime, billing, spawner }) => {
					const session = await seedPricedSession(runtime, { suffix: "fee-pinned", model: HOUSE, pricing: card });
					await runInference(spawner, session, "req-fee-pinned");
					const operationId = await inferenceOperationId(runtime, session.sessionId);
					const event = await waitForBillingEvent(billing, operationId);
					assert.equal(event.pricingVersion, card.version);
					assert.equal(event.costMicroUsd, computeRateCardCost(card, FIRST_TURN).totalCostMicroUsd);
					assert.equal(event.costMicroUsd, 850, "the 15% the chat was admitted at");
				},
				{ llmProxy: proxyAnswering({ input: FIRST_TURN.input, output: FIRST_TURN.output }) },
			);
		});
	});
});
