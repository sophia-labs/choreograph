/**
 * The credit clamp: Door B's arithmetic (Sobremesa, E §4.1). Pure, no I/O, no imports.
 *
 * The gate never compares the person's balance to the UNCLAMPED reservation. That figure is the
 * worst case (an estimated input plus a 32,000-token output cap): $0.097 for a House turn that
 * actually costs $0.0008, so checking it would refuse anyone under ten cents. Instead the
 * balance goes into the durable reservation as a SECOND cost ceiling next to the session's own
 * dollars. The reservation's existing binary search (`maximalAffordableOutputTokens`) already
 * shrinks the output cap until the worst case fits; with this ceiling it shrinks to the balance
 * as well. Settlement then debits ACTUAL cost, so an over-estimate only ever bites the last few
 * cents of a balance.
 *
 * A call is refused (`credit_exhausted`) only when the balance cannot keep a VIABLE output:
 * 256 tokens, or whatever the caller asked for when that is less. And only when the balance is
 * the reason: if the session's own budget could not have run the call either, the reservation's
 * `budget_exhausted` rule speaks, not this one.
 *
 * `planCreditClamp` is separated from the durable store so its boundaries are testable exactly.
 * The price function is INJECTED (`maxTokensUnder`), so whichever rate card the reservation
 * prices with, the clamp and the reservation cannot disagree.
 */

/** The smallest output the clamp may leave a call. */
export const MIN_VIABLE_OUTPUT_TOKENS = 256;

/** The `AgentSessionBudgetFault.reason` a refused call carries. */
export const CREDIT_EXHAUSTED_REASON = "credit_exhausted" as const;

const BUDGET_FAULT_CODE = "agent_session_budget_invalid";

/** What the clamp computed, whether or not it was applied (observe reports it, enforce acts on it). */
export interface CreditProbe {
	/** The balance-derived cost ceiling that was considered, integer µUSD. */
	readonly ceilingCostUsdMicros: number;
	/** The most output the session's own budget would have allowed. */
	readonly maxOutputTokensSessionOnly: number;
	/** The most output the balance funds (0 when the input alone does not fit). */
	readonly maxOutputTokensUnderCredit: number;
	/** The balance shrinks the output but the call still has a viable one. */
	readonly wouldClamp: boolean;
	/** The balance cannot keep a viable output, and the session's budget could have. */
	readonly wouldBlock: boolean;
}

export interface CreditClampInput {
	/** The person's spendable balance as a cost ceiling; undefined = no credit ceiling for this call. */
	readonly creditCeilingCostUsdMicros: number | undefined;
	/** false = compute the verdict and apply none of it (observe). Omitted = enforce. */
	readonly creditEnforce: boolean | undefined;
	/** What the caller asked for. */
	readonly requestedOutputTokens: number;
	/** The dollars the session's own budget still allows. */
	readonly sessionAvailableCostUsdMicros: number;
	/** The most output tokens a cost ceiling funds, priced exactly as the reservation prices. */
	readonly maxTokensUnder: (costCeilingUsdMicros: number) => number;
}

export interface CreditClampPlan {
	/** The cost ceiling the reservation must respect (session-only when the clamp is not applied). */
	readonly costCeilingUsdMicros: number;
	/** The output cap the reservation should use. */
	readonly maxOutputTokens: number;
	/** true = refuse the call with `credit_exhausted` before anything is reserved. */
	readonly refuse: boolean;
	/** Present whenever the balance was the binding cost constraint. */
	readonly probe?: CreditProbe;
}

export function planCreditClamp(input: CreditClampInput): CreditClampPlan {
	const sessionCost = input.sessionAvailableCostUsdMicros;
	const sessionOnlyMax = input.maxTokensUnder(sessionCost);
	const ceiling = input.creditCeilingCostUsdMicros;
	// No ceiling, or a ceiling the session's own dollars already undercut: the balance is not binding.
	if (ceiling === undefined || ceiling >= sessionCost) {
		return { costCeilingUsdMicros: sessionCost, maxOutputTokens: sessionOnlyMax, refuse: false };
	}
	const underCredit = input.maxTokensUnder(ceiling);
	const viable = Math.min(MIN_VIABLE_OUTPUT_TOKENS, input.requestedOutputTokens);
	const wouldBlock = sessionOnlyMax >= viable && underCredit < viable;
	const wouldClamp = !wouldBlock && underCredit < sessionOnlyMax;
	const probe: CreditProbe = {
		ceilingCostUsdMicros: ceiling,
		maxOutputTokensSessionOnly: sessionOnlyMax,
		maxOutputTokensUnderCredit: underCredit,
		wouldClamp,
		wouldBlock,
	};
	if (input.creditEnforce === false) {
		return { costCeilingUsdMicros: sessionCost, maxOutputTokens: sessionOnlyMax, refuse: false, probe };
	}
	return { costCeilingUsdMicros: ceiling, maxOutputTokens: underCredit, refuse: wouldBlock, probe };
}

/**
 * True for the budget fault `planCreditClamp`'s caller throws when the balance cannot fund a viable
 * call. Recognized by shape so the gate does not import the durable store to catch it.
 */
export function isCreditExhaustedFault(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { code?: unknown; reason?: unknown };
	return candidate.code === BUDGET_FAULT_CODE && candidate.reason === CREDIT_EXHAUSTED_REASON;
}
