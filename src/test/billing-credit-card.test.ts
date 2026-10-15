/**
 * The credit gate on a Session priced from a rate card (Sobremesa: the credits release meets the pricing release).
 * REAL stores, a real orchestrator on loopback, a real spawner; NO MOCKS. The one stand-in is the provider's
 * network (the spawner's own `llmProxy` seam), as in every inference suite of the house.
 *
 * The pricing release (r20261001) prices a chat from the live catalogue: the Session pins a card, and the
 * reservation, the settlement and the store's re-derivation all read it. The credit gate was written a week
 * earlier against the static table (27 rows, the Sonnet rate for anything else), so every place it quotes or
 * clamps has to follow the card, or it is wrong in both directions:
 *
 *   - a cheap catalogue voice the table has no row for (Mistral Nemo at $0.019/M) would be refused for want of
 *     $0.059 it does not cost, and Kimi K2.5 at a sixth of the Sonnet rate would be quoted at six times its price;
 *   - a premium voice (GPT-5.4 Pro at $30/M) would be waved through at a tenth of its price.
 *
 * Door A quotes the smallest viable call on the card; Door B clamps the reservation with the card; settlement
 * debits the ACTUAL cost under the basis it carries (`card`, or `fallback-actual` when OpenRouter could not serve
 * the call at the card and it was retried without the ceiling), and the hold is released when that debit lands.
 *
 * RUN:  npx tsx --test src/test/billing-credit-card.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	CreditAdmission,
	insufficientCreditBody,
	MIN_ADMIT_FLOOR_MICRO_USD,
	MIN_ADMIT_INPUT_TOKENS,
	minAdmitMicroUsd,
} from "../billing-gate.js";
import { computeCost } from "../billing-pricing.js";
import {
	buildRateCard,
	computeRateCardCost,
	MIN_VIABLE_CALL,
	minimumViableCallCostMicroUsd,
	priceAtProviderReport,
	type RateCardV1,
} from "../billing-rate-card.js";
import type { BillingStore } from "../billing-store.js";
import { MIN_VIABLE_OUTPUT_TOKENS } from "../credit-clamp.js";
import { type ProxyAssistantMessageEvent, ZERO_USAGE } from "../wire-protocol.js";
import {
	asPerson,
	CreditRouteRig,
	httpJson,
	seedAgentSession,
	workspaceChatEnvelope,
} from "./billing-credit-fixture.js";
import { useBillingFee } from "./billing-fee-fixture.js";
import {
	activeFor,
	completion,
	hostInference,
	inferenceOperationIds,
	responseChild,
	seedRunningRoot,
	type WorkerResponse,
	waitFor,
	waitForBillingEvent,
	withInferenceHarness,
} from "./billing-inference-fixture.js";
import { openBilling, seedBalance } from "./billing-ledger-fixture.js";
import { fullRow } from "./fixtures/openrouter-catalogue.fixture.js";

const HOUSE = "google/gemini-2.5-flash";
const KIMI = "moonshotai/kimi-k2.5";
const NEMO = "mistralai/mistral-nemo";
const SONNET = "anthropic/claude-sonnet-4.5";
const OPUS = "anthropic/claude-opus-4.5";
const PRO = "openai/gpt-5.4-pro";
const CATALOGUE = { digest: "0123456789abcdef".repeat(4), fetchedAt: "2026-09-29T20:00:00.000Z" };
const ASYNC = { prefer: "respond-async" };
const NO_ENDPOINTS = "404 No endpoints found that satisfy the max price for this request";

/** A card from the real 2026-09-29 catalogue row's own price strings, admitted at `markupBps`. */
function cardAt(id: string, markupBps: number): RateCardV1 {
	const built = buildRateCard({ model: id, pricing: fullRow(id).pricing_raw, catalogue: CATALOGUE, markupBps });
	assert.ok(built.ok, `${id} builds a card`);
	return built.card;
}

/** What the reservation holds for a card Session: the dearest of three readings of the prompt, plus the output. */
function worstCase(card: RateCardV1, estimatedInput: number, output: number): number {
	const priced = (prompt: { input: number; cacheRead: number; cacheWrite: number }) =>
		computeRateCardCost(card, { ...prompt, output }).totalCostMicroUsd;
	return Math.max(
		priced({ input: estimatedInput, cacheRead: 0, cacheWrite: 0 }),
		priced({ input: 0, cacheRead: 0, cacheWrite: estimatedInput }),
		priced({ input: 0, cacheRead: estimatedInput, cacheWrite: 0 }),
	);
}

/** Independent oracle: the largest output whose worst case fits `ceiling`, by a linear scan. */
function maxOutputFor(card: RateCardV1, estimatedInput: number, ceiling: number, requested: number): number {
	let n = 0;
	while (n < requested && worstCase(card, estimatedInput, n + 1) <= ceiling) n += 1;
	return n;
}

const quote = (card: RateCardV1, model: string) =>
	minimumViableCallCostMicroUsd({ card, model, provider: "openrouter" });

function refusalBody(verdict: Awaited<ReturnType<CreditAdmission["admitIngress"]>>) {
	assert.equal(verdict.allow, false, "the person is refused");
	if (verdict.allow) throw new Error("unreachable");
	return verdict.body;
}

/**
 * The two fees this release runs at. The observe deploy keeps today's 15% (BILLING_FEE_BPS unset); the flip sets
 * BILLING_FEE_BPS=2000 together with BILLING_GATE_MODE=enforce. The gate's behaviour is the same in both; the numbers
 * it names are not, so every suite below runs at both, with the hand-computed figures of each:
 *   the House's smallest viable call, 15,000 input + 256 output tokens: 4,500 + 640 = 5,140 µUSD of provider cost,
 *     + 15% = 5,911, + 20% = 6,168 (exact, on the table and on a card);
 *   a model the table has no row for is billed at the Sonnet rate: 45,000 + 3,840 = 48,840, + 15% = 56,166, + 20% = 58,608.
 */
interface Regime {
	readonly bps: number;
	readonly label: string;
	readonly houseMinAdmit: number;
	readonly sonnetFallbackMinAdmit: number;
}
const REGIMES: readonly Regime[] = [
	{ bps: 1500, label: "observe, today's 15%", houseMinAdmit: 5_911, sonnetFallbackMinAdmit: 56_166 },
	{ bps: 2000, label: "the flip's 20%", houseMinAdmit: 6_168, sonnetFallbackMinAdmit: 58_608 },
];

// ─── The quote ───────────────────────────────────────────────────────────────
for (const regime of REGIMES) {
	describe(`the credit gate on a card-priced Session, at ${regime.label}`, { concurrency: false }, () => {
		useBillingFee(regime.bps);
		/** A card admitted at the fee in force in this regime. */
		const cardFor = (id: string) => cardAt(id, regime.bps);

		describe("the gate quotes the smallest viable call on the Session's card", () => {
			let dir = "";
			let billing: BillingStore;
			let counter = 0;
			before(async () => {
				dir = mkdtempSync(join(tmpdir(), "credit-card-quote-"));
				billing = await openBilling(dir);
			});
			after(() => {
				billing.close();
				rmSync(dir, { recursive: true, force: true });
			});
			const gate = (mode: "observe" | "enforce") => new CreditAdmission({ billing, mode, log: () => {} });
			const voiceOf = (model: string) => ({ provider: "openrouter", model });
			const nextUser = () => `user:card-quote-${++counter}`;

			it("is the pricing release's own figure for every voice, at the card's fee; a legacy Session keeps the static table", () => {
				const enforce = gate("enforce");
				for (const model of [HOUSE, KIMI, NEMO, SONNET, OPUS, PRO]) {
					assert.equal(
						minAdmitMicroUsd(enforce.pricing, voiceOf(model), cardFor(model)),
						quote(cardFor(model), model),
						model,
					);
				}
				assert.equal(
					minAdmitMicroUsd(enforce.pricing, voiceOf(HOUSE)),
					regime.houseMinAdmit,
					"a legacy Session: the House voice on the static table at the fee in force (5,140 micro-dollars of provider cost + the fee, exact)",
				);
				assert.equal(
					minAdmitMicroUsd(enforce.pricing, voiceOf(HOUSE), cardFor(HOUSE)),
					regime.houseMinAdmit,
					"and the House card agrees with the table to the micro-dollar",
				);
			});

			it("shares its three constants with the pricing release's smallest viable call", () => {
				assert.equal(MIN_ADMIT_INPUT_TOKENS, MIN_VIABLE_CALL.inputTokens);
				assert.equal(MIN_ADMIT_FLOOR_MICRO_USD, MIN_VIABLE_CALL.floorMicroUsd);
				assert.equal(MIN_VIABLE_OUTPUT_TOKENS, MIN_VIABLE_CALL.outputTokens);
			});

			it("admits a person with $0.01 on a cheap catalogue voice the static table has no row for", async () => {
				const user = nextUser();
				await seedBalance(billing, user, 10_000);
				const card = cardFor(NEMO);
				assert.equal(quote(card, NEMO), 1_000, "the voice costs less than the floor of a thousandth of a dollar");
				const enforce = gate("enforce");
				const input = { door: "ingress.invocation", userId: user, provider: "openrouter", model: NEMO } as const;
				assert.equal(
					(await enforce.admitIngress({ ...input, rateCard: card })).allow,
					true,
					"on its card: admitted",
				);
				// A Session with no card is priced by the static table, which bills an unknown model at the Sonnet rate.
				const legacyQuote = computeCost(
					NEMO,
					{ input: 15_000, output: 256, cacheRead: 0, cacheWrite: 0 },
					"openrouter",
				);
				assert.equal(legacyQuote.totalCostMicroUsd, regime.sonnetFallbackMinAdmit);
				const legacy = refusalBody(await enforce.admitIngress(input));
				assert.equal(
					legacy.error.requiredMicroUsd,
					regime.sonnetFallbackMinAdmit,
					"a legacy Session keeps that quote, as it keeps that price",
				);
			});

			it("does not wave a person with $0.20 through to a premium voice at the Sonnet rate", async () => {
				const user = nextUser();
				await seedBalance(billing, user, 200_000);
				const card = cardFor(PRO);
				const atCard = quote(card, PRO);
				assert.ok(atCard > 200_000, `GPT-5.4 Pro's smallest viable call is $${atCard / 1_000_000}`);
				const enforce = gate("enforce");
				const body = refusalBody(
					await enforce.admitIngress({
						door: "ingress.invocation",
						userId: user,
						provider: "openrouter",
						model: PRO,
						rateCard: card,
					}),
				);
				assert.deepEqual(body, insufficientCreditBody(200_000, atCard), "the card's figure, in the coded envelope");
				const [row] = await billing.listGateEvents({ userId: user });
				assert.equal(row.decision, "block");
				assert.equal(row.requiredMicroUsd, atCard);
				assert.equal(
					(
						await enforce.admitIngress({
							door: "ingress.invocation",
							userId: user,
							provider: "openrouter",
							model: PRO,
						})
					).allow,
					true,
					"the static table's Sonnet fallback quotes a tenth of that and would have admitted a legacy Session",
				);
			});
		});

		// ─── Door A, over real HTTP, against a catalogue-backed chat ─────────────────

		describe("Door A over real HTTP prices a catalogue chat on its card", { concurrency: false }, () => {
			const rig = new CreditRouteRig();
			let enforce: CreditAdmission;
			let observe: CreditAdmission;
			let counter = 0;
			const nextUser = () => `owner-card-${++counter}`;

			before(async () => {
				await rig.start({ catalogue: true });
				enforce = new CreditAdmission({ billing: rig.billing, mode: "enforce", log: () => {} });
				observe = new CreditAdmission({ billing: rig.billing, mode: "observe", log: () => {} });
			});
			after(() => rig.stop());

			async function chat(userId: string, model: string) {
				const envelope = workspaceChatEnvelope(`credit.card.${userId}`, userId);
				(envelope.input as Record<string, unknown>).inference = { provider: "openrouter", model };
				return httpJson(rig.server.baseUrl, "POST", "/api/invocations", {
					body: envelope,
					headers: asPerson(userId, ASYNC),
				});
			}

			it("enforce: $0.05 starts a chat on Kimi K2.5, a sixth of the Sonnet rate the static table would have quoted", async () => {
				rig.gate = enforce;
				const user = nextUser();
				await seedBalance(rig.billing, user, 50_000);
				assert.ok(quote(cardFor(KIMI), KIMI) < 50_000, "Kimi's smallest viable call on its card fits $0.05");
				const res = await chat(user, KIMI);
				assert.equal(res.status, 202, res.text);
				assert.deepEqual(await rig.billing.listGateEvents({ userId: user }), [], "an allow leaves no row");
			});

			it("enforce: $0.01 starts a chat on a cheap voice the table has no row for", async () => {
				rig.gate = enforce;
				const user = nextUser();
				await seedBalance(rig.billing, user, 10_000);
				const res = await chat(user, NEMO);
				assert.equal(res.status, 202, res.text);
			});

			it("enforce: $0.20 is refused a premium voice with the card's own required figure, and nothing is left behind", async () => {
				rig.gate = enforce;
				const user = nextUser();
				await seedBalance(rig.billing, user, 200_000);
				const required = quote(cardFor(PRO), PRO);
				const runsBefore = await rig.journal.listRuns({ ownerUserId: user, limit: 100 });
				const res = await chat(user, PRO);
				assert.equal(res.status, 402, res.text);
				assert.deepEqual(res.body, insufficientCreditBody(200_000, required));
				const [row] = await rig.billing.listGateEvents({ userId: user });
				assert.equal(row.decision, "block");
				assert.equal(row.door, "ingress.invocation");
				assert.equal(row.model, PRO);
				assert.equal(row.requiredMicroUsd, required);
				assert.deepEqual(
					await rig.journal.listRuns({ ownerUserId: user, limit: 100 }),
					runsBefore,
					"no run was started",
				);
			});

			it("the House default is the same on its card as on the table: $0.0038 is refused with 6,168", async () => {
				rig.gate = enforce;
				const user = nextUser();
				await seedBalance(rig.billing, user, 3_800);
				const res = await httpJson(rig.server.baseUrl, "POST", "/api/invocations", {
					body: workspaceChatEnvelope(`credit.card.house.${user}`, user),
					headers: asPerson(user, ASYNC),
				});
				assert.equal(res.status, 402, res.text);
				assert.deepEqual(res.body, insufficientCreditBody(3_800, regime.houseMinAdmit));
			});

			it("observe: the same refusal is recorded at the card's figure and the chat starts", async () => {
				rig.gate = observe;
				const user = nextUser();
				await seedBalance(rig.billing, user, 3_800);
				const required = quote(cardFor(KIMI), KIMI);
				assert.ok(required > 3_800);
				const res = await chat(user, KIMI);
				assert.equal(res.status, 202, res.text);
				const [row] = await rig.billing.listGateEvents({ userId: user });
				assert.equal(row.decision, "would_block");
				assert.equal(row.mode, "observe");
				assert.equal(row.requiredMicroUsd, required);
				assert.equal(row.balanceMicroUsd, 3_800);
			});

			it("a follow-up on a Session pinned to a card is quoted on THAT card", async () => {
				rig.gate = enforce;
				const user = nextUser();
				const card = cardFor(PRO);
				const session = await seedAgentSession(rig.runtime, {
					suffix: `card-cmd-${counter}`,
					ownerUserId: user,
					model: PRO,
					pricing: card,
				});
				await seedBalance(rig.billing, user, 200_000);
				const res = await httpJson(
					rig.server.baseUrl,
					"POST",
					`/api/agent-sessions/${session.sessionId}/commands`,
					{
						body: {
							commandId: "cmd-card-1",
							idempotencyKey: "cmd-card-1",
							clientId: "client-1",
							name: "follow_up",
							payload: { text: "and?" },
						},
						headers: asPerson(user),
					},
				);
				assert.equal(res.status, 402, res.text);
				assert.deepEqual(res.body, insufficientCreditBody(200_000, quote(card, PRO)));
				assert.equal(
					Boolean(await rig.runtime.readAgentSessionCommand("cmd-card-1")),
					false,
					"no command was recorded",
				);
			});
		});

		// ─── Door B and settlement, on a card Session ────────────────────────────────

		const refusalEvent = (message: string): ProxyAssistantMessageEvent => ({
			type: "error",
			reason: "error",
			errorMessage: message,
			usage: ZERO_USAGE,
		});

		function failureOf(responses: WorkerResponse[]) {
			return responses.find((response) => response.ok === false)?.error;
		}

		describe("Door B clamps a card Session with its card, and settles on the actual cost", () => {
			it("shrinks the output to what the balance funds AT THE CARD (Kimi at $0.02), settles on the card, releases the hold", async () => {
				const card = cardFor(KIMI);
				const dispatched: Array<{ maxTokens?: number }> = [];
				await withInferenceHarness(
					async ({ runtime, billing, spawner, gate }) => {
						const session = await seedRunningRoot(runtime, { suffix: "card-clamp", model: KIMI, pricing: card });
						await seedBalance(billing, session.ownerUserId, 20_000);
						const responses: WorkerResponse[] = [];

						await hostInference(spawner, session, activeFor(session), responseChild(responses), "req-card-clamp");

						const [operationId] = await inferenceOperationIds(runtime, session.sessionId);
						const reservation = await runtime.readAgentSessionInferenceReservation(operationId);
						assert.ok(reservation);
						assert.equal(reservation.pricing_version, card.version, "the reservation is the card's");
						const estimated = reservation.estimated_input_tokens;
						const expected = maxOutputFor(card, estimated, 20_000, 32_000);
						assert.ok(
							expected >= 256 && expected < 32_000,
							`Kimi at $0.02 runs with a clamped output (${expected})`,
						);
						assert.equal(
							reservation.max_output_tokens,
							expected,
							"the clamp is what an independent scan of the CARD says",
						);
						assert.equal(reservation.budget.costUsdMicros, worstCase(card, estimated, expected));
						assert.ok(reservation.budget.costUsdMicros <= 20_000, "the reserved worst case fits the balance");
						assert.ok(worstCase(card, estimated, expected + 1) > 20_000, "and one more token would not");
						assert.equal(dispatched[0]?.maxTokens, expected, "the provider was asked for the clamped cap");
						// The static table prices Kimi at the Sonnet fallback, six times too dear: it could not even fit the prompt.
						assert.equal(
							computeCost(KIMI, { input: estimated, output: 1, cacheRead: 0, cacheWrite: 0 }, "openrouter")
								.totalCostMicroUsd > 20_000,
							true,
						);

						const billed = await waitForBillingEvent(billing, operationId);
						const atCard = computeRateCardCost(card, { input: 2_228, output: 28, cacheRead: 0, cacheWrite: 0 });
						assert.equal(billed.pricingBasis, "card");
						assert.equal(
							billed.costMicroUsd,
							atCard.totalCostMicroUsd,
							"settlement debits the actual cost, at the card",
						);
						assert.equal(
							(await billing.getCredit(session.ownerUserId))?.balanceMicroUsd,
							20_000 - billed.costMicroUsd,
						);
						await waitFor(
							() => gate?.holds.total(session.ownerUserId) === 0,
							"the hold is released when the debit lands",
						);
						const [clamp] = await billing.listGateEvents({ userId: session.ownerUserId });
						assert.equal(clamp.decision, "clamp");
						assert.equal(clamp.balanceMicroUsd, 20_000);
					},
					{
						llmProxy: async function* (model, _context) {
							dispatched.push(model as { maxTokens?: number });
							yield* completion(2_228, 28)();
						},
					},
				);
			});

			it("refuses a card voice dearer than the balance with the card's required figure, and still runs a cheap one", async () => {
				const dispatched: unknown[] = [];
				await withInferenceHarness(
					async ({ runtime, billing, spawner }) => {
						const pro = await seedRunningRoot(runtime, { suffix: "card-pro", model: PRO, pricing: cardFor(PRO) });
						await seedBalance(billing, pro.ownerUserId, 100_000);
						const responses: WorkerResponse[] = [];
						await hostInference(spawner, pro, activeFor(pro), responseChild(responses), "req-card-pro");
						const failure = failureOf(responses);
						assert.match(failure?.message ?? "", /^insufficient_credit: /);
						assert.deepEqual(await inferenceOperationIds(runtime, pro.sessionId), [], "nothing was reserved");
						assert.equal(dispatched.length, 0, "the provider was never called");
						const [row] = await billing.listGateEvents({ userId: pro.ownerUserId });
						assert.equal(row.decision, "block");
						assert.equal(row.door, "call");
						assert.equal(row.balanceMicroUsd, 100_000);
						// What THIS call needed at the smallest viable output, on the card, not on the Sonnet fallback.
						const estimated = 15_000;
						const needed = computeRateCardCost(cardFor(PRO), {
							input: estimated,
							output: 256,
							cacheRead: 0,
							cacheWrite: 0,
						}).totalCostMicroUsd;
						assert.ok(needed > 100_000);
						assert.ok(
							(row.requiredMicroUsd ?? 0) >= needed && (row.requiredMicroUsd ?? 0) < needed * 1.05,
							`required ${row.requiredMicroUsd} is the card's figure for this call (~${needed})`,
						);

						// The same balance runs a cheap voice: the gate does not refuse for want of a table row.
						const nemo = await seedRunningRoot(runtime, {
							suffix: "card-nemo",
							model: NEMO,
							pricing: cardFor(NEMO),
						});
						await seedBalance(billing, nemo.ownerUserId, 100_000);
						await hostInference(spawner, nemo, activeFor(nemo), responseChild([]), "req-card-nemo");
						assert.equal(
							(await inferenceOperationIds(runtime, nemo.sessionId)).length,
							1,
							"the cheap voice was reserved",
						);
					},
					{
						llmProxy: async function* (model) {
							dispatched.push(model);
							yield* completion(1, 1)();
						},
					},
				);
			});

			it("settles a fallback at OpenRouter's actual charge, debits exactly that, releases the hold; the next call sees it", async () => {
				const card = cardFor(KIMI);
				let calls = 0;
				await withInferenceHarness(
					async ({ runtime, billing, spawner, gate }) => {
						const session = await seedRunningRoot(runtime, {
							suffix: "card-fallback",
							model: KIMI,
							pricing: card,
						});
						await seedBalance(billing, session.ownerUserId, 20_000);
						await hostInference(spawner, session, activeFor(session), responseChild([]), "req-card-fallback");
						assert.equal(calls, 2, "the call was retried once without the ceiling");

						const [operationId] = await inferenceOperationIds(runtime, session.sessionId);
						const billed = await waitForBillingEvent(billing, operationId);
						const atCard = computeRateCardCost(card, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
						const actual = priceAtProviderReport(atCard, 1_235, card.markupBps);
						assert.equal(billed.pricingBasis, "fallback-actual");
						assert.equal(
							billed.costMicroUsd,
							actual.totalCostMicroUsd,
							"the charge plus the card's fee, not the card's figure",
						);
						assert.notEqual(billed.costMicroUsd, atCard.totalCostMicroUsd);
						assert.equal(
							billed.cardCostMicroUsd,
							atCard.totalCostMicroUsd,
							"the card's figure is kept beside it",
						);
						assert.equal(
							(await billing.getCredit(session.ownerUserId))?.balanceMicroUsd,
							20_000 - actual.totalCostMicroUsd,
							"the balance moved by the debit, which is the actual cost",
						);
						await waitFor(
							() => gate?.holds.total(session.ownerUserId) === 0,
							"the hold is released when the debit lands",
						);

						// The next admission sees the balance the debit left.
						await hostInference(spawner, session, activeFor(session), responseChild([]), "req-card-fallback-2");
						assert.equal((await inferenceOperationIds(runtime, session.sessionId)).length, 2);
					},
					{
						llmProxy: async function* () {
							calls += 1;
							if (calls === 1) {
								yield refusalEvent(NO_ENDPOINTS);
								return;
							}
							yield { type: "start" };
							yield {
								type: "done",
								reason: "stop",
								usage: { ...ZERO_USAGE, input: 100, output: 10, totalTokens: 110 },
								responseId: `gen-${calls}`,
								providerUsage: { costUsd: 0.0012345, generationId: `gen-${calls}`, provider: "Crusoe" },
							} as ProxyAssistantMessageEvent;
						},
					},
				);
			});

			it("a fallback dearer than the whole balance is still debited in full; the balance goes below zero and the NEXT call is refused", async () => {
				const card = cardFor(KIMI);
				let calls = 0;
				await withInferenceHarness(
					async ({ runtime, billing, spawner, gate }) => {
						const session = await seedRunningRoot(runtime, {
							suffix: "card-overshoot",
							model: KIMI,
							pricing: card,
						});
						await seedBalance(billing, session.ownerUserId, 12_000);
						await hostInference(spawner, session, activeFor(session), responseChild([]), "req-overshoot-1");
						const [operationId] = await inferenceOperationIds(runtime, session.sessionId);
						const billed = await waitForBillingEvent(billing, operationId);
						assert.equal(billed.pricingBasis, "fallback-actual");
						assert.ok(billed.costMicroUsd > 12_000, "OpenRouter charged more than the whole balance");
						const balance = (await billing.getCredit(session.ownerUserId))?.balanceMicroUsd ?? 0;
						assert.equal(
							balance,
							12_000 - billed.costMicroUsd,
							"every recorded cost is debited: no silent floor",
						);
						assert.ok(balance < 0);
						await waitFor(() => gate?.holds.total(session.ownerUserId) === 0, "the hold is released");

						const responses: WorkerResponse[] = [];
						await hostInference(
							spawner,
							session,
							activeFor(session),
							responseChild(responses),
							"req-overshoot-2",
						);
						assert.match(
							failureOf(responses)?.message ?? "",
							/^insufficient_credit: /,
							"the next admission refuses",
						);
						const rows = await billing.listGateEvents({ userId: session.ownerUserId });
						assert.equal(rows[0]?.decision, "block", "the newest row is the refusal");
						assert.equal(rows[0]?.balanceMicroUsd, balance, "it saw the negative balance");
					},
					{
						llmProxy: async function* () {
							calls += 1;
							if (calls === 1) {
								yield refusalEvent(NO_ENDPOINTS);
								return;
							}
							yield { type: "start" };
							yield {
								type: "done",
								reason: "stop",
								usage: { ...ZERO_USAGE, input: 100, output: 10, totalTokens: 110 },
								providerUsage: { costUsd: 0.02, generationId: "gen-overshoot", provider: "Crusoe" },
							} as ProxyAssistantMessageEvent;
						},
					},
				);
			});

			it("observe records what enforce would do at the card's figure and changes nothing about the call", async () => {
				const card = cardFor(KIMI);
				await withInferenceHarness(
					async ({ runtime, billing, spawner, gate }) => {
						const session = await seedRunningRoot(runtime, {
							suffix: "card-observe",
							model: KIMI,
							pricing: card,
						});
						await seedBalance(billing, session.ownerUserId, 5_000);
						await hostInference(spawner, session, activeFor(session), responseChild([]), "req-card-observe");
						const [operationId] = await inferenceOperationIds(runtime, session.sessionId);
						const reservation = await runtime.readAgentSessionInferenceReservation(operationId);
						assert.equal(reservation?.max_output_tokens, 32_000, "the reservation is exactly what it always was");
						const [row] = await billing.listGateEvents({ userId: session.ownerUserId });
						assert.equal(row.decision, "would_block");
						assert.equal(row.mode, "observe");
						assert.equal(row.door, "call");
						assert.equal(row.balanceMicroUsd, 5_000);
						const estimated = reservation?.estimated_input_tokens ?? 0;
						const needed = computeRateCardCost(card, {
							input: estimated,
							output: 256,
							cacheRead: 0,
							cacheWrite: 0,
						}).totalCostMicroUsd;
						assert.equal(
							row.requiredMicroUsd,
							Math.max(MIN_ADMIT_FLOOR_MICRO_USD, needed),
							"at the card's figure",
						);
						await waitForBillingEvent(billing, operationId);
						await waitFor(() => gate?.holds.total(session.ownerUserId) === 0, "the hold is released");
					},
					{ gate: "observe", llmProxy: completion(2_228, 28) },
				);
			});
		});
	});
}
