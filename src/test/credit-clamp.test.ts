/**
 * The credit clamp (Door B's arithmetic, E §4.1) — pure, no I/O.
 *
 * The gate never checks the unclamped reservation (a House turn reserves $0.097 against
 * an actual cost of $0.0008). It passes the person's spendable balance into the
 * reservation as a second cost ceiling next to the session's own; the reservation's
 * existing binary search then shrinks the output cap until the worst case fits both.
 * A call that cannot keep a viable output (256 tokens, or what it asked for if less) is
 * refused with `credit_exhausted`. `planCreditClamp` is that decision, separated from
 * the durable store so the boundary cases can be pinned exactly.
 *
 * RUN:  npx tsx --test src/test/credit-clamp.test.ts
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeCost } from "../billing-pricing.js";
import {
	CREDIT_EXHAUSTED_REASON,
	type CreditClampInput,
	isCreditExhaustedFault,
	MIN_VIABLE_OUTPUT_TOKENS,
	planCreditClamp,
} from "../credit-clamp.js";

/**
 * A linear price: `perOutputToken` µUSD per output token after a fixed `inputCost`. The
 * function under test only needs "the most output a cost ceiling can fund", so a closed
 * form is an honest oracle for the boundaries.
 */
function linearTokens(inputCost: number, perOutputToken: number, requested: number) {
	return (ceiling: number): number => {
		if (ceiling < inputCost) return 0;
		return Math.min(requested, Math.floor((ceiling - inputCost) / perOutputToken));
	};
}

function input(over: Partial<CreditClampInput> & { requested?: number; sessionCost?: number }): CreditClampInput {
	const requested = over.requested ?? 32_000;
	return {
		creditCeilingCostUsdMicros: undefined,
		creditEnforce: true,
		requestedOutputTokens: requested,
		sessionAvailableCostUsdMicros: over.sessionCost ?? 1_000_000,
		maxTokensUnder: linearTokens(5_000, 3, requested),
		...over,
	};
}

describe("planCreditClamp: no credit ceiling is the reservation as it always was", () => {
	it("returns the session-only maximum and no probe", () => {
		const plan = planCreditClamp(input({}));
		assert.equal(plan.refuse, false);
		assert.equal(plan.maxOutputTokens, 32_000);
		assert.equal(plan.costCeilingUsdMicros, 1_000_000);
		assert.equal(plan.probe, undefined);
	});

	it("evaluates the price function exactly once when nothing is clamped", () => {
		let calls = 0;
		const plan = planCreditClamp(
			input({
				maxTokensUnder: (ceiling) => {
					calls += 1;
					return linearTokens(5_000, 3, 32_000)(ceiling);
				},
			}),
		);
		assert.equal(plan.refuse, false);
		assert.equal(calls, 1);
	});

	it("a ceiling at or above the session's own dollars is not binding: no clamp, no probe", () => {
		for (const ceiling of [1_000_000, 5_000_000]) {
			const plan = planCreditClamp(input({ creditCeilingCostUsdMicros: ceiling }));
			assert.equal(plan.refuse, false);
			assert.equal(plan.maxOutputTokens, 32_000);
			assert.equal(plan.costCeilingUsdMicros, 1_000_000);
			assert.equal(plan.probe, undefined);
		}
	});
});

describe("planCreditClamp: enforce shrinks the output to what the balance funds", () => {
	it("clamps the worst case to the balance, shrinking the output cap", () => {
		// input costs 5,000; each output token 3: a 20,000 ceiling funds (20,000 - 5,000) / 3 = 5,000 tokens.
		const plan = planCreditClamp(input({ creditCeilingCostUsdMicros: 20_000 }));
		assert.equal(plan.refuse, false);
		assert.equal(plan.maxOutputTokens, 5_000);
		assert.equal(plan.costCeilingUsdMicros, 20_000);
		assert.ok(plan.probe);
		assert.equal(plan.probe.wouldClamp, true);
		assert.equal(plan.probe.wouldBlock, false);
		assert.equal(plan.probe.maxOutputTokensSessionOnly, 32_000);
		assert.equal(plan.probe.maxOutputTokensUnderCredit, 5_000);
		assert.equal(plan.probe.ceilingCostUsdMicros, 20_000);
	});

	it("a clamp that still leaves the full request is a clamp of nothing: no wouldClamp", () => {
		const plan = planCreditClamp(input({ creditCeilingCostUsdMicros: 999_999, requested: 100 }));
		assert.equal(plan.refuse, false);
		assert.equal(plan.maxOutputTokens, 100);
		assert.equal(plan.probe?.wouldClamp, false);
		assert.equal(plan.probe?.wouldBlock, false);
	});

	it("refuses exactly at the viable-output boundary: 256 tokens admit, 255 refuse", () => {
		// ceiling that funds exactly N output tokens: inputCost + 3N.
		const funds = (n: number) => 5_000 + 3 * n;
		const admitted = planCreditClamp(input({ creditCeilingCostUsdMicros: funds(MIN_VIABLE_OUTPUT_TOKENS) }));
		assert.equal(admitted.maxOutputTokens, MIN_VIABLE_OUTPUT_TOKENS);
		assert.equal(admitted.refuse, false);
		const refused = planCreditClamp(input({ creditCeilingCostUsdMicros: funds(MIN_VIABLE_OUTPUT_TOKENS) - 1 }));
		assert.equal(refused.maxOutputTokens, MIN_VIABLE_OUTPUT_TOKENS - 1);
		assert.equal(refused.refuse, true);
		assert.equal(refused.probe?.wouldBlock, true);
	});

	it("refuses when the input alone exceeds the ceiling", () => {
		const plan = planCreditClamp(input({ creditCeilingCostUsdMicros: 4_999 }));
		assert.equal(plan.maxOutputTokens, 0);
		assert.equal(plan.refuse, true);
	});

	it("refuses at a zero balance", () => {
		const plan = planCreditClamp(input({ creditCeilingCostUsdMicros: 0 }));
		assert.equal(plan.refuse, true);
		assert.equal(plan.probe?.wouldBlock, true);
	});

	it("a small request is not refused for being under 256 when it is what the caller asked for", () => {
		const plan = planCreditClamp(input({ creditCeilingCostUsdMicros: 5_000 + 3 * 64, requested: 64 }));
		assert.equal(plan.maxOutputTokens, 64);
		assert.equal(plan.refuse, false);
		const short = planCreditClamp(input({ creditCeilingCostUsdMicros: 5_000 + 3 * 63, requested: 64 }));
		assert.equal(short.refuse, true, "63 of the 64 it asked for is not viable either");
	});

	it("does not blame the balance when the session's own budget could not run the call either", () => {
		// Session dollars leave 100 tokens (< 256): the session budget is the wall, not credit.
		const plan = planCreditClamp(input({ sessionCost: 5_000 + 3 * 100, creditCeilingCostUsdMicros: 5_000 + 3 * 50 }));
		assert.equal(plan.probe?.wouldBlock, false, "not a credit refusal: the call keeps its smaller cap");
		assert.equal(plan.refuse, false);
		assert.equal(plan.probe?.wouldClamp, true);
		assert.equal(plan.maxOutputTokens, 50);
	});
});

describe("planCreditClamp: observe computes the same verdict and applies none of it", () => {
	it("reports would-clamp without shrinking the reservation", () => {
		const plan = planCreditClamp(input({ creditCeilingCostUsdMicros: 20_000, creditEnforce: false }));
		assert.equal(plan.refuse, false);
		assert.equal(plan.maxOutputTokens, 32_000, "the reservation is exactly what it was before the gate");
		assert.equal(plan.costCeilingUsdMicros, 1_000_000);
		assert.equal(plan.probe?.wouldClamp, true);
		assert.equal(plan.probe?.maxOutputTokensUnderCredit, 5_000);
	});

	it("reports would-block without refusing", () => {
		const plan = planCreditClamp(input({ creditCeilingCostUsdMicros: 100, creditEnforce: false }));
		assert.equal(plan.refuse, false);
		assert.equal(plan.maxOutputTokens, 32_000);
		assert.equal(plan.probe?.wouldBlock, true);
	});

	it("an omitted creditEnforce means enforce (fail closed on the arithmetic, the mode decides upstream)", () => {
		const plan = planCreditClamp({ ...input({ creditCeilingCostUsdMicros: 100 }), creditEnforce: undefined });
		assert.equal(plan.refuse, true);
	});
});

describe("planCreditClamp against the real price table (independent oracle)", () => {
	it("House with $0.02 left funds the output an independent scan of computeCost says it does", () => {
		const model = "google/gemini-2.5-flash";
		const estimatedInput = 15_086; // the F-step-zero worst case
		const requested = 32_000;
		const cost = (out: number) =>
			computeCost(model, { input: estimatedInput, output: out, cacheRead: 0, cacheWrite: 0 }).totalCostMicroUsd;
		const ceiling = 20_000; // $0.02
		// Independent oracle: the largest n with cost(n) <= ceiling, by a linear scan.
		let expected = 0;
		while (expected < requested && cost(expected + 1) <= ceiling) expected += 1;

		const maxTokensUnder = (limit: number): number => {
			let low = 0;
			let high = requested;
			while (low < high) {
				const mid = Math.ceil((low + high) / 2);
				if (cost(mid) <= limit) low = mid;
				else high = mid - 1;
			}
			return low;
		};
		const plan = planCreditClamp({
			creditCeilingCostUsdMicros: ceiling,
			creditEnforce: true,
			requestedOutputTokens: requested,
			sessionAvailableCostUsdMicros: 1_000_000,
			maxTokensUnder,
		});
		assert.equal(plan.maxOutputTokens, expected);
		assert.ok(expected > MIN_VIABLE_OUTPUT_TOKENS, "House at $0.02 still runs, with a clamped output");
		assert.ok(expected < requested, "and the clamp bit");
		assert.equal(plan.refuse, false);
		assert.ok(cost(plan.maxOutputTokens) <= ceiling, "the reserved worst case fits the balance");
		assert.ok(cost(plan.maxOutputTokens + 1) > ceiling, "and it is the largest that does");
	});
});

describe("isCreditExhaustedFault", () => {
	it("recognizes the budget fault by shape, without importing the store", () => {
		const fault = Object.assign(new Error("credit"), {
			code: "agent_session_budget_invalid",
			reason: CREDIT_EXHAUSTED_REASON,
		});
		assert.equal(isCreditExhaustedFault(fault), true);
		assert.equal(CREDIT_EXHAUSTED_REASON, "credit_exhausted");
	});

	it("does not mistake the session's own exhaustion, a plain error or a non-error", () => {
		const other = Object.assign(new Error("x"), { code: "agent_session_budget_invalid", reason: "budget_exhausted" });
		assert.equal(isCreditExhaustedFault(other), false);
		assert.equal(isCreditExhaustedFault(new Error("credit_exhausted")), false);
		assert.equal(isCreditExhaustedFault(undefined), false);
		assert.equal(isCreditExhaustedFault("credit_exhausted"), false);
	});
});
