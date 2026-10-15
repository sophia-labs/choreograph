/**
 * The credit gate, Door A and the predicate (Sobremesa, E §4.1) — REAL libSQL, NO MOCKS.
 *
 * The gate had no call site since `r20260806` (2026-08-06), and as written it compared the
 * balance to -$0.50 while the debit guard stopped a balance just above that, so the one
 * frozen account was allowed forever (E G17). It is now one predicate:
 *
 *     allow  iff  balance - holds >= minAdmit(voice)
 *
 * where minAdmit is the cost of the smallest viable call on the voice's price. The same
 * predicate runs in both modes: `observe` records what `enforce` would have done and never
 * refuses. A refusal is the coded 402 envelope the SPA already parses.
 *
 * Every test opens a real `file:` libSQL store, seeds it with the genuine debit / grant
 * paths and runs the real gate over that projection. Failures are real ones (a dropped
 * table, a closed store), never a stubbed function.
 *
 * RUN:  npx tsx --test src/test/billing-gate.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createClient } from "@libsql/client";
import {
	type AdmissionPricing,
	type BillingGateMode,
	CreditAdmission,
	INSUFFICIENT_CREDIT_CODE,
	insufficientCreditBody,
	MIN_ADMIT_FLOOR_MICRO_USD,
	minAdmitMicroUsd,
	readBillingGateMode,
	staticAdmissionPricing,
} from "../billing-gate.js";
import { computeCost, FREE_TIER_BALANCE_MICRO_USD, PRICING_VERSION } from "../billing-pricing.js";
import { BillingStore, type UsageEventInput } from "../billing-store.js";
import { useBillingFee } from "./billing-fee-fixture.js";

// The numbers below are the flip's: BILLING_FEE_BPS=2000 is set together with BILLING_GATE_MODE=enforce.
// (The default regime, 15%, is pinned in billing-fee.test.ts and billing-credit-card.test.ts.)
useBillingFee(2000);

const HOUSE = { provider: "openrouter", model: "google/gemini-2.5-flash" } as const;
const OPUS = { provider: "openrouter", model: "anthropic/claude-opus-4.5" } as const;
/** Hand-computed at the 20% markup: input 4,500 + output 640 = 5,140; markup 1,028. */
const HOUSE_MIN_ADMIT = 6_168;
/** Hand-computed: input 75,000 + output 6,400 = 81,400; markup 16,280. */
const OPUS_MIN_ADMIT = 97_680;
const NOW = 1_790_000_000_000;
const NOW_DAY = new Date(NOW).toISOString().slice(0, 10);

interface Harness {
	store: BillingStore;
	path: string;
	lines: string[];
	gate: (mode: BillingGateMode, pricing?: AdmissionPricing) => CreditAdmission;
}

async function harness(prefix = "billing-gate-"): Promise<Harness> {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "billing.sqlite");
	const store = new BillingStore(path);
	await store.init();
	after(() => store.close());
	const lines: string[] = [];
	return {
		store,
		path,
		lines,
		gate: (mode, pricing) =>
			new CreditAdmission({
				billing: store,
				mode,
				...(pricing ? { pricing } : {}),
				now: () => NOW,
				log: (line) => lines.push(line),
			}),
	};
}

function usage(
	over: Partial<UsageEventInput> & { eventId: string; userId: string; costMicroUsd: number },
): UsageEventInput {
	const cost = computeCost(HOUSE.model, { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 });
	return {
		ts: NOW,
		graphId: "g",
		sandboxId: "sbx",
		template: "agent",
		provider: "openrouter",
		model: HOUSE.model,
		modelPriced: cost.modelPriced,
		reason: "stop",
		inputTokens: 1000,
		outputTokens: 500,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		totalTokens: 1500,
		inputCostMicroUsd: cost.inputCostMicroUsd,
		outputCostMicroUsd: cost.outputCostMicroUsd,
		cacheReadCostMicroUsd: 0,
		cacheWriteCostMicroUsd: 0,
		providerCostMicroUsd: cost.providerCostMicroUsd,
		markupMicroUsd: cost.markupMicroUsd,
		pricingVersion: PRICING_VERSION,
		pricedDefault: false,
		...over,
	};
}

/** Land a user on exactly `balance` µUSD using the genuine lazy-seed + debit path. */
async function seedBalance(store: BillingStore, userId: string, balance: number): Promise<void> {
	await store.recordUsageAndDebit(
		usage({ eventId: `seed-${userId}`, userId, costMicroUsd: FREE_TIER_BALANCE_MICRO_USD - balance }),
	);
	assert.equal((await store.getCredit(userId))?.balanceMicroUsd, balance);
}

// ─── mode ──────────────────────────────────────────────────────────────────

describe("billing-gate: readBillingGateMode toggle", () => {
	it("unset / garbage / whitespace map to observe; only literal enforce enforces", () => {
		assert.equal(readBillingGateMode({} as NodeJS.ProcessEnv), "observe", "unset ⇒ observe");
		assert.equal(readBillingGateMode({ BILLING_GATE_MODE: "enforce" } as NodeJS.ProcessEnv), "enforce");
		assert.equal(readBillingGateMode({ BILLING_GATE_MODE: "ENFORCE " } as NodeJS.ProcessEnv), "enforce");
		assert.equal(readBillingGateMode({ BILLING_GATE_MODE: "observe" } as NodeJS.ProcessEnv), "observe");
		assert.equal(readBillingGateMode({ BILLING_GATE_MODE: "enforcer" } as NodeJS.ProcessEnv), "observe");
		assert.equal(readBillingGateMode({ BILLING_GATE_MODE: "" } as NodeJS.ProcessEnv), "observe");
		assert.equal(readBillingGateMode({ BILLING_GATE_MODE: "garbage" } as NodeJS.ProcessEnv), "observe");
	});

	it("the gate carries the mode it was built with", async () => {
		const h = await harness();
		assert.equal(h.gate("observe").mode, "observe");
		assert.equal(h.gate("enforce").mode, "enforce");
	});
});

// ─── minAdmit ──────────────────────────────────────────────────────────────

describe("billing-gate: minAdmit is the price of the smallest viable call", () => {
	it("House (gemini-2.5-flash) at the 20% markup: 15,000 input + 256 output tokens = 6,168 µUSD", () => {
		assert.equal(minAdmitMicroUsd(staticAdmissionPricing, HOUSE), HOUSE_MIN_ADMIT);
	});

	it("a premium voice needs proportionally more (claude-opus-4.5: 97,680 µUSD)", () => {
		assert.equal(minAdmitMicroUsd(staticAdmissionPricing, OPUS), OPUS_MIN_ADMIT);
		assert.ok(OPUS_MIN_ADMIT > HOUSE_MIN_ADMIT * 10);
	});

	it("never goes below the absolute minimum, even for a voice that prices to nothing", () => {
		assert.equal(MIN_ADMIT_FLOOR_MICRO_USD, 1_000);
		assert.equal(minAdmitMicroUsd(staticAdmissionPricing, { provider: "openrouter", model: "mock:done" }), 1_000);
	});

	it("falls back to the absolute minimum when the price port cannot price the voice", () => {
		const none: AdmissionPricing = { quoteMicroUsd: () => undefined };
		assert.equal(minAdmitMicroUsd(none, HOUSE), MIN_ADMIT_FLOOR_MICRO_USD);
	});

	it("follows an injected price port: the seam the catalogue-pinned rate card plugs into", () => {
		const asked: Array<{ model: string; input: number; output: number }> = [];
		const card: AdmissionPricing = {
			quoteMicroUsd: (voice, tokens) => {
				asked.push({ model: voice.model, input: tokens.input, output: tokens.output });
				return 12_345;
			},
		};
		assert.equal(minAdmitMicroUsd(card, HOUSE), 12_345);
		assert.deepEqual(asked, [{ model: HOUSE.model, input: 15_000, output: 256 }]);
	});
});

// ─── the 402 envelope ──────────────────────────────────────────────────────

describe("billing-gate: the refusal is the coded envelope the SPA already parses", () => {
	it("is exactly {error:{code,message,balanceMicroUsd,requiredMicroUsd}}, not the old flat body", () => {
		assert.equal(INSUFFICIENT_CREDIT_CODE, "insufficient_credit");
		assert.deepEqual(insufficientCreditBody(6_167, HOUSE_MIN_ADMIT), {
			error: {
				code: "insufficient_credit",
				message: "You're out of credits.",
				balanceMicroUsd: 6_167,
				requiredMicroUsd: 6_168,
			},
		});
	});
});

// ─── Door A ────────────────────────────────────────────────────────────────

describe("Door A: enforce refuses below minAdmit with the coded 402, and only there", () => {
	it("allows a funded person and refuses a person one µUSD short: the boundary is exact", async () => {
		const h = await harness();
		await seedBalance(h.store, "at-bar", HOUSE_MIN_ADMIT);
		await seedBalance(h.store, "under-bar", HOUSE_MIN_ADMIT - 1);
		const gate = h.gate("enforce");

		const allowed = await gate.admitIngress({ door: "ingress.invocation", userId: "at-bar", ...HOUSE });
		assert.deepEqual(allowed, { allow: true });

		const refused = await gate.admitIngress({ door: "ingress.invocation", userId: "under-bar", ...HOUSE });
		assert.equal(refused.allow, false);
		if (refused.allow) return;
		assert.equal(refused.status, 402);
		assert.deepEqual(refused.body, insufficientCreditBody(HOUSE_MIN_ADMIT - 1, HOUSE_MIN_ADMIT));
	});

	it("a person with no ledger row has the $1.00 starter credit and is allowed", async () => {
		const h = await harness();
		const verdict = await h.gate("enforce").admitIngress({
			door: "ingress.invocation",
			userId: "brand-new",
			...HOUSE,
		});
		assert.deepEqual(verdict, { allow: true });
		assert.equal(await h.store.getCredit("brand-new"), undefined, "admission never writes the ledger");
	});

	it("refuses at zero and below, including the balance the dead gate allowed forever", async () => {
		const h = await harness();
		// E G17: -499,914 sat 86 µUSD above the old floor, so the old predicate said allow every time.
		for (const [user, balance] of [
			["zero", 0],
			["overdrawn", -250_000],
			["frozen", -499_914],
			["dust", 86],
		] as const) {
			await seedBalance(h.store, user, balance);
			const verdict = await h.gate("enforce").admitIngress({ door: "ingress.invocation", userId: user, ...HOUSE });
			assert.equal(verdict.allow, false, `${user} (${balance})`);
			if (!verdict.allow) assert.equal(verdict.body.error.balanceMicroUsd, balance);
		}
	});

	it("prices the bar by the voice: $0.05 funds House and does not fund Opus", async () => {
		const h = await harness();
		await seedBalance(h.store, "five-cents", 50_000);
		const gate = h.gate("enforce");
		assert.deepEqual(await gate.admitIngress({ door: "ingress.command", userId: "five-cents", ...HOUSE }), {
			allow: true,
		});
		const opus = await gate.admitIngress({ door: "ingress.command", userId: "five-cents", ...OPUS });
		assert.equal(opus.allow, false);
		if (!opus.allow) assert.deepEqual(opus.body, insufficientCreditBody(50_000, OPUS_MIN_ADMIT));
	});

	it("uses the injected price port for the bar (the catalogue-pinned card seam)", async () => {
		const h = await harness();
		await seedBalance(h.store, "card", 100_000);
		const pricey: AdmissionPricing = { quoteMicroUsd: () => 200_000 };
		const verdict = await h.gate("enforce", pricey).admitIngress({
			door: "ingress.invocation",
			userId: "card",
			...HOUSE,
		});
		assert.equal(verdict.allow, false);
		if (!verdict.allow) assert.equal(verdict.body.error.requiredMicroUsd, 200_000);
	});

	it("records the refusal as a `block` row naming the door, the voice and the numbers", async () => {
		const h = await harness();
		await seedBalance(h.store, "logged", 3_800);
		await h.gate("enforce").admitIngress({
			door: "ingress.invocation",
			userId: "logged",
			sessionId: "ags-1",
			...HOUSE,
		});
		const rows = await h.store.listGateEvents({ userId: "logged" });
		assert.equal(rows.length, 1);
		assert.equal(rows[0].decision, "block");
		assert.equal(rows[0].mode, "enforce");
		assert.equal(rows[0].door, "ingress.invocation");
		assert.equal(rows[0].model, HOUSE.model);
		assert.equal(rows[0].balanceMicroUsd, 3_800);
		assert.equal(rows[0].requiredMicroUsd, HOUSE_MIN_ADMIT);
		assert.equal(rows[0].ts, NOW);
		assert.match(rows[0].reason ?? "", /session=ags-1/);
	});
});

describe("Door A: observe is the dry run of enforce and never refuses", () => {
	it("admits the person enforce would refuse, and records `would_block` with the same numbers", async () => {
		const h = await harness();
		await seedBalance(h.store, "broke", 3_800);
		const verdict = await h.gate("observe").admitIngress({
			door: "ingress.command",
			userId: "broke",
			...HOUSE,
		});
		assert.deepEqual(verdict, { allow: true });
		const [row] = await h.store.listGateEvents({ userId: "broke" });
		assert.equal(row.decision, "would_block");
		assert.equal(row.mode, "observe");
		assert.equal(row.door, "ingress.command");
		assert.equal(row.balanceMicroUsd, 3_800);
		assert.equal(row.requiredMicroUsd, HOUSE_MIN_ADMIT);
	});

	it("the two modes reach the same verdict for the same ledger: only the consequence differs", async () => {
		const h = await harness();
		const cases: Array<[string, number]> = [
			["a", 0],
			["b", HOUSE_MIN_ADMIT - 1],
			["c", HOUSE_MIN_ADMIT],
			["d", 900_000],
		];
		for (const [user, balance] of cases) await seedBalance(h.store, user, balance);
		for (const [user, balance] of cases) {
			const enforce = await h.gate("enforce").admitIngress({ door: "ingress.invocation", userId: user, ...HOUSE });
			await h.gate("observe").admitIngress({ door: "ingress.invocation", userId: user, ...HOUSE });
			const rows = await h.store.listGateEvents({ userId: user });
			const wouldBlock = rows.some((r) => r.decision === "would_block");
			const blocked = rows.some((r) => r.decision === "block");
			assert.equal(blocked, !enforce.allow);
			assert.equal(wouldBlock, balance < HOUSE_MIN_ADMIT, `${user}: observe predicts exactly what enforce did`);
		}
	});

	it("counts the plain allows per day instead of logging each one", async () => {
		const h = await harness();
		await seedBalance(h.store, "rich", 900_000);
		const gate = h.gate("observe");
		for (let i = 0; i < 3; i++) await gate.admitIngress({ door: "ingress.invocation", userId: "rich", ...HOUSE });
		await gate.admitIngress({ door: "ingress.command", userId: "rich", ...HOUSE });
		assert.deepEqual(await h.store.listGateEvents({ userId: "rich" }), [], "an allow is not a row");
		await gate.flushCounters();
		const counts = await h.store.gateDailyCounts({ day: NOW_DAY });
		assert.deepEqual(
			counts.map((c) => [c.mode, c.door, c.decision, c.n]),
			[
				["observe", "ingress.command", "allow", 1],
				["observe", "ingress.invocation", "allow", 3],
			],
		);
		await gate.flushCounters();
		assert.equal((await h.store.gateDailyCounts({ day: NOW_DAY })).length, 2, "a flush drains what it wrote");
		const again = await h.store.gateDailyCounts({ day: NOW_DAY });
		assert.equal(again.find((c) => c.door === "ingress.invocation")?.n, 3, "and never writes it twice");
	});
});

describe("Door A: who is never gated", () => {
	it("own-key, local and host-internal mock inference bypass, and never read the ledger", async () => {
		const h = await harness();
		h.store.close(); // a closed store fails every read: a bypass that touched it would log fail_open
		const gate = h.gate("enforce");
		const cases = [
			{ provider: "openrouter", model: HOUSE.model, fundingSource: "user" as const },
			{ provider: "lmstudio", model: "qwen3-8b" },
			{ provider: "openrouter", model: "mock:done" },
		];
		for (const voice of cases) {
			assert.deepEqual(await gate.admitIngress({ door: "ingress.invocation", userId: "u", ...voice }), {
				allow: true,
			});
		}
		assert.deepEqual(h.lines, [], "no fail_open, no read: the bypass decided before the ledger");
	});

	it("platform funding is the default: an absent fundingSource is gated", async () => {
		const h = await harness();
		await seedBalance(h.store, "default-funding", 0);
		const verdict = await h.gate("enforce").admitIngress({
			door: "ingress.invocation",
			userId: "default-funding",
			...HOUSE,
		});
		assert.equal(verdict.allow, false);
	});
});

describe("Door A: a ledger that cannot be read never blocks chat", () => {
	it("fails open on a real substrate failure, records `fail_open`, and logs a countable line", async () => {
		const h = await harness();
		await seedBalance(h.store, "u-fo", 0);
		// A real failure, not a stub: the credits table disappears under the running store.
		const raw = createClient({ url: `file:${h.path}` });
		await raw.execute("DROP TABLE credits");
		raw.close();

		const verdict = await h.gate("enforce").admitIngress({ door: "ingress.invocation", userId: "u-fo", ...HOUSE });
		assert.deepEqual(verdict, { allow: true }, "availability over billing precision; usage still reconciles");
		const [row] = await h.store.listGateEvents({ userId: "u-fo" });
		assert.equal(row.decision, "fail_open");
		assert.equal(row.mode, "enforce");
		assert.equal(row.door, "ingress.invocation");
		assert.equal(row.balanceMicroUsd, null);
		assert.ok(h.lines.some((line) => line.includes("gate=fail_open") && line.includes("user=u-fo")));
	});

	it("also fails open when the store is closed, even though the fail_open row cannot be written", async () => {
		const h = await harness();
		h.store.close();
		const verdict = await h.gate("enforce").admitIngress({ door: "ingress.command", userId: "u-closed", ...HOUSE });
		assert.deepEqual(verdict, { allow: true });
		assert.ok(h.lines.some((line) => line.includes("gate=fail_open")));
	});

	it("an absent BillingStore admits everyone (a narrow deployment without a ledger)", async () => {
		const gate = new CreditAdmission({ billing: undefined, mode: "enforce" });
		assert.deepEqual(await gate.admitIngress({ door: "ingress.invocation", userId: "u", ...HOUSE }), {
			allow: true,
		});
	});
});
