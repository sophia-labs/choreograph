/**
 * The credit gate (Sobremesa, E §4.1): two doors, one predicate.
 *
 *     allow  iff  balance - holds >= minAdmit(voice)
 *
 * `minAdmit` is the price of the smallest viable call on the voice's rate: 15,000 input tokens and
 * 256 output tokens, markup included, never less than 1,000 µUSD (the pricing release's
 * `MIN_VIABLE_CALL`). "The voice's rate" is the Session's pinned rate card when it has one, the static
 * table for a legacy Session: the gate quotes the price the call is reserved and settled at, never a
 * second one. It is NEVER the unclamped reservation (a House turn reserves ~$0.10 for an actual cost
 * of $0.0008).
 *
 *  - Door A, ingress (friendly, before any run, command or sandbox exists): `admitIngress`. In
 *    enforce a person below the bar gets the coded HTTP 402 the SPA already parses.
 *  - Door B, per model call (hard; covers every Prime workload, including scheduled and triggered
 *    runs that have no HTTP ingress): `admitCall` wraps the durable budget reservation and passes the
 *    person's spendable balance in as a second cost ceiling (see `credit-clamp.ts`).
 *
 * Both run in BOTH modes. `observe` is the dry run: the same verdict is computed and recorded
 * (`would_block`, `would_clamp`) and nothing is refused, so the gate changes nothing a person can see
 * until it is flipped (the deploy's one other effect, a debit with no floor, is real in observe: the debit
 * always was; the fee stays 15% until the flip sets BILLING_FEE_BPS=2000 together with BILLING_GATE_MODE=enforce).
 * Decisions land in `gate_events` (non-trivial ones) and
 * `gate_daily_counts` (the plain allows) inside `billing.sqlite`, whose existing S3 snapshots carry the
 * dry run off the box.
 *
 * FAIL-OPEN: an unreadable ledger never blocks chat (availability over billing precision; the
 * immutable usage rows still reconcile). It is recorded (`fail_open`) and logged as a countable line.
 *
 * Who is never gated: own-key (BYOK) OpenRouter funding, `lmstudio` (the person runs their own model) and
 * host-internal `mock:` models. Humans get no exemption otherwise.
 *
 * The floor: the old dead gate compared the balance to -$0.50 while the debit guard stopped a balance
 * just above that, so the one frozen account was allowed forever. The debit no longer has a floor; the
 * floor is an ADMISSION rule (`admissionFloorMicroUsd`) and the balance view reports it.
 */

import { trace } from "@opentelemetry/api";
import { computeCost, FREE_TIER_BALANCE_MICRO_USD, MIN_ALLOWED_BALANCE_MICRO_USD } from "./billing-pricing.js";
import { MIN_VIABLE_CALL, priceInferenceCall, type RateCardV1 } from "./billing-rate-card.js";
import type { BillingStore, GateCounterDelta, GateDoor, GateEventInput } from "./billing-store.js";
import { type CreditProbe, isCreditExhaustedFault, MIN_VIABLE_OUTPUT_TOKENS } from "./credit-clamp.js";

export type BillingGateMode = "observe" | "enforce";

/** The admission floor once the gate enforces: no overdraft, a person at $0 is out of credits. */
export const ENFORCE_ADMISSION_FLOOR_MICRO_USD = 0;

/**
 * The floor the balance view reports (and the gateway's `can_make_requests` derives
 * from): the legacy -$0.50 while the gate only observes, so nothing visible changes
 * before the flip, and $0 under enforce. It is an ADMISSION rule only — the debit no
 * longer has a floor, so a cost already incurred is always recorded.
 */
export function admissionFloorMicroUsd(mode: BillingGateMode): number {
	return mode === "enforce" ? ENFORCE_ADMISSION_FLOOR_MICRO_USD : MIN_ALLOWED_BALANCE_MICRO_USD;
}

/**
 * Parse `BILLING_GATE_MODE` once. Anything but the literal "enforce"
 * (case/whitespace-insensitive) ⇒ "observe" — a typo never enforces (fail-safe).
 */
export function readBillingGateMode(env: NodeJS.ProcessEnv = process.env): BillingGateMode {
	return env.BILLING_GATE_MODE?.trim().toLowerCase() === "enforce" ? "enforce" : "observe";
}

// ─── The contract with the person ──────────────────────────────────────────

/** The code the SPA keys its out-of-credits banner on. */
export const INSUFFICIENT_CREDIT_CODE = "insufficient_credit" as const;
/** A provider-side failure: never reported as the person's empty balance. */
export const PROVIDER_UNAVAILABLE_CODE = "provider_unavailable" as const;

/** The HTTP 402 body: the coded envelope the SPA already parses (`error.code`), not a flat body. */
export interface InsufficientCreditBody {
	readonly error: {
		readonly code: typeof INSUFFICIENT_CREDIT_CODE;
		readonly message: string;
		readonly balanceMicroUsd: number;
		readonly requiredMicroUsd: number;
	};
}

export function insufficientCreditBody(balanceMicroUsd: number, requiredMicroUsd: number): InsufficientCreditBody {
	return {
		error: {
			code: INSUFFICIENT_CREDIT_CODE,
			message: "You're out of credits.",
			balanceMicroUsd,
			requiredMicroUsd,
		},
	};
}

/** The prefixes messages carry across the worker boundary and into session events; the SPA keys on them. */
export const INSUFFICIENT_CREDIT_PREFIX = "insufficient_credit:";
export const PROVIDER_UNAVAILABLE_PREFIX = "provider_unavailable:";

/**
 * The text a mid-run refusal carries (the `turn.failed` message and the failed command's error). The SPA
 * keys on the prefix; the rest reads as a sentence if it is ever shown raw.
 */
export const INSUFFICIENT_CREDIT_REFUSAL_MESSAGE = `${INSUFFICIENT_CREDIT_PREFIX} You're out of credits. Your message is saved. Add credits to continue.`;

/** The text of a provider-side payment failure: honest, and explicitly not about the person's balance. */
export const PROVIDER_UNAVAILABLE_MESSAGE = `${PROVIDER_UNAVAILABLE_PREFIX} The model provider is unavailable. This is not about your balance. Try again shortly.`;

/** A refusal raised by Door B (or an evaluator) in place of the call. */
export class InsufficientCreditError extends Error {
	readonly code = INSUFFICIENT_CREDIT_CODE;

	constructor(
		readonly balanceMicroUsd: number,
		readonly requiredMicroUsd: number,
		readonly door: GateDoor,
	) {
		super(INSUFFICIENT_CREDIT_REFUSAL_MESSAGE);
		this.name = "InsufficientCreditError";
	}

	get body(): InsufficientCreditBody {
		return insufficientCreditBody(this.balanceMicroUsd, this.requiredMicroUsd);
	}
}

const PROVIDER_PAYMENT_FAILURE =
	/(^|\D)402(\D|$)|insufficient (credits?|funds|balance)|payment required|requires more credits|settings\/credits/i;

/** True when an upstream provider's error says the PLATFORM's account could not pay (an OpenRouter 402). */
export function isProviderPaymentFailure(message: string | undefined): boolean {
	return typeof message === "string" && PROVIDER_PAYMENT_FAILURE.test(message);
}

// ─── The price of the smallest viable call ─────────────────────────────────

/**
 * The smallest viable call is the pricing release's own definition (`MIN_VIABLE_CALL`: 15,000 input tokens, 256
 * output tokens, never less than a thousandth of a dollar), not a second copy of its three numbers. The clamp's
 * 256-token floor (`credit-clamp.ts`, which imports nothing) is pinned to the same value by a test.
 */
export const MIN_ADMIT_INPUT_TOKENS = MIN_VIABLE_CALL.inputTokens;
export const MIN_ADMIT_FLOOR_MICRO_USD = MIN_VIABLE_CALL.floorMicroUsd;

export interface AdmissionVoice {
	readonly provider: string;
	readonly model: string;
}

export interface AdmissionTokens {
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
}

/**
 * The price, in integer µUSD with the markup included, of a call of this shape on this voice, or `undefined`
 * when the voice cannot be priced (the gate then falls back to the absolute minimum rather than fail closed on
 * a pricing gap). `card` is the Session's pinned rate card when it has one: the price of a Session admitted from
 * the live catalogue is its card's, and the gate must quote what the reservation and the settlement will charge.
 */
export interface AdmissionPricing {
	quoteMicroUsd(voice: AdmissionVoice, tokens: AdmissionTokens, card?: RateCardV1): number | undefined;
}

/** The legacy static table (`computeCost`), always: what a Session created before the catalogue pin prices with. */
export const staticAdmissionPricing: AdmissionPricing = {
	quoteMicroUsd(voice, tokens) {
		return computeCost(
			voice.model,
			{
				input: tokens.input,
				output: tokens.output,
				cacheRead: tokens.cacheRead ?? 0,
				cacheWrite: tokens.cacheWrite ?? 0,
			},
			voice.provider,
		).totalCostMicroUsd;
	},
};

/**
 * The price as the host prices every call (`priceInferenceCall`): from the Session's card when it has one, else,
 * for a legacy Session, from the static table exactly as before. The default of the gate.
 */
export const rateCardAdmissionPricing: AdmissionPricing = {
	quoteMicroUsd(voice, tokens, card) {
		return priceInferenceCall({
			card,
			model: voice.model,
			provider: voice.provider,
			tokens: {
				input: tokens.input,
				output: tokens.output,
				cacheRead: tokens.cacheRead ?? 0,
				cacheWrite: tokens.cacheWrite ?? 0,
			},
		}).totalCostMicroUsd;
	},
};

/** The bar Door A holds a person to for this voice: the smallest viable call on the card, or on the table for a legacy Session. */
export function minAdmitMicroUsd(pricing: AdmissionPricing, voice: AdmissionVoice, card?: RateCardV1): number {
	const quote = pricing.quoteMicroUsd(
		voice,
		{ input: MIN_ADMIT_INPUT_TOKENS, output: MIN_VIABLE_OUTPUT_TOKENS },
		card,
	);
	return Math.max(MIN_ADMIT_FLOOR_MICRO_USD, quote ?? 0);
}

// ─── Holds ─────────────────────────────────────────────────────────────────

/** A hold older than this is forgotten: a leaked one must not lock a person out forever. */
export const HOLD_TTL_MS = 30 * 60 * 1000;

/**
 * What each person's reserved calls could still cost (E §4.2). In memory, per person, keyed by inference
 * operation: created when the reservation is made, released when the DEBIT is delivered (not when the call
 * ends: releasing at settle would reopen the window between "the call ended" and "the debit landed"), on
 * release, or on indeterminate. One Choreograph process today, so memory is enough; a restart drops holds,
 * and because an undelivered outbox row still debits on the next drain, spend is never lost, the worst
 * case is ONE extra call per person. If Choreograph ever runs twice, promote this to a table.
 */
export class CreditHolds {
	private readonly byOperation = new Map<string, { userId: string; microUsd: number; at: number }>();
	private readonly totals = new Map<string, number>();
	private readonly now: () => number;
	private readonly ttlMs: number;

	constructor(options: { now?: () => number; ttlMs?: number } = {}) {
		this.now = options.now ?? Date.now;
		this.ttlMs = options.ttlMs ?? HOLD_TTL_MS;
	}

	/** Hold `microUsd` for `userId` under `operationId`; re-registering an operation replaces its hold. */
	set(userId: string, operationId: string, microUsd: number): void {
		if (!Number.isSafeInteger(microUsd) || microUsd < 0) {
			throw new Error("credit hold must be a non-negative integer µUSD");
		}
		this.release(operationId);
		this.byOperation.set(operationId, { userId, microUsd, at: this.now() });
		this.totals.set(userId, (this.totals.get(userId) ?? 0) + microUsd);
	}

	/** Release one operation's hold. Returns false when there was none (already released, or expired). */
	release(operationId: string): boolean {
		const hold = this.byOperation.get(operationId);
		if (!hold) return false;
		this.byOperation.delete(operationId);
		const remaining = (this.totals.get(hold.userId) ?? 0) - hold.microUsd;
		if (remaining > 0) this.totals.set(hold.userId, remaining);
		else this.totals.delete(hold.userId);
		return true;
	}

	/** Everything currently held for a person. */
	total(userId: string): number {
		this.prune();
		return this.totals.get(userId) ?? 0;
	}

	get size(): number {
		this.prune();
		return this.byOperation.size;
	}

	private prune(): void {
		const cutoff = this.now() - this.ttlMs;
		for (const [operationId, hold] of this.byOperation) {
			if (hold.at < cutoff) this.release(operationId);
		}
	}
}

// ─── The gate ──────────────────────────────────────────────────────────────

export interface CreditAdmissionOptions {
	readonly billing: BillingStore | undefined;
	/** Default: `BILLING_GATE_MODE` from the environment (observe unless it says enforce). */
	readonly mode?: BillingGateMode;
	readonly pricing?: AdmissionPricing;
	/** Share one ledger of holds between every door that reserves (default: this gate's own). */
	readonly holds?: CreditHolds;
	readonly now?: () => number;
	/** Where the countable log lines go; default `console.error`. */
	readonly log?: (line: string) => void;
}

export interface IngressAdmissionInput {
	readonly door: "ingress.invocation" | "ingress.command";
	readonly userId: string;
	readonly provider?: string;
	readonly model: string;
	/** Trusted host credential selection; absent = platform funded. */
	readonly fundingSource?: "platform" | "user";
	readonly sessionId?: string;
	/** The rate card the chat is priced on (a new chat's admitted voice, or a Session's pin); absent = the static table. */
	readonly rateCard?: RateCardV1;
}

export type IngressVerdict =
	| { readonly allow: true }
	| { readonly allow: false; readonly status: 402; readonly body: InsufficientCreditBody };

const ALLOW: IngressVerdict = Object.freeze({ allow: true as const });

export interface CallAdmissionInput {
	readonly userId: string;
	readonly provider: string;
	readonly model: string;
	readonly fundingSource: "platform" | "user";
	readonly sessionId: string;
	/** The host's estimate of the call's input, tokens. */
	readonly estimatedInputTokens: number;
	/** What the caller asked for, output tokens. */
	readonly requestedOutputTokens: number;
	/** The Session's pinned rate card: what a refusal or a would-be verdict quotes. Absent = the static table. */
	readonly rateCard?: RateCardV1;
}

/** What the reservation must apply for this call. */
export interface CallCredit {
	/** The cost ceiling to clamp the reservation to; undefined = none (bypass, fail-open, no ledger). */
	readonly ceilingCostUsdMicros?: number;
	/** true = enforce the ceiling; false = only report what it would have done. */
	readonly enforce: boolean;
}

/** The part of a durable reservation result the gate reads (structurally the runtime store's). */
export interface AdmittedReservation {
	readonly applied: boolean;
	readonly reservation: { readonly operation_id: string; readonly budget: { readonly costUsdMicros: number } };
	readonly creditProbe?: CreditProbe;
}

/** An evaluator call's hold is keyed like an inference operation, so one ledger of holds serves both. */
export function evaluatorHoldKey(requestId: string): string {
	return `eval:${requestId}`;
}

export interface EvaluatorAdmissionInput {
	readonly userId: string;
	readonly model: string;
	/** The evaluator's own request id: it names the hold and, later, the usage row. */
	readonly requestId: string;
	/** Upper-bound estimate of the request's input, tokens. */
	readonly estimatedInputTokens: number;
	/** The output cap the provider request carries. */
	readonly maxCompletionTokens: number;
}

function voiceOf(provider: string | undefined, model: string): AdmissionVoice {
	return { provider: provider?.trim().toLowerCase() || "openrouter", model };
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class CreditAdmission {
	readonly mode: BillingGateMode;
	readonly pricing: AdmissionPricing;
	readonly holds: CreditHolds;
	private readonly billing: BillingStore | undefined;
	private readonly now: () => number;
	private readonly log: (line: string) => void;
	private readonly pendingCounts = new Map<string, GateCounterDelta>();
	private readonly userLocks = new Map<string, Promise<void>>();
	private counterTimer: ReturnType<typeof setInterval> | undefined;

	constructor(options: CreditAdmissionOptions) {
		this.billing = options.billing;
		this.mode = options.mode ?? readBillingGateMode();
		this.pricing = options.pricing ?? rateCardAdmissionPricing;
		this.now = options.now ?? Date.now;
		this.holds = options.holds ?? new CreditHolds({ now: this.now });
		this.log = options.log ?? ((line) => console.error(line));
	}

	/** Own-key, local and host-internal mock inference are not credit surfaces. */
	isBypassed(voice: AdmissionVoice, fundingSource?: "platform" | "user"): boolean {
		if (fundingSource === "user" && voice.provider === "openrouter") return true;
		return voice.provider === "lmstudio" || voice.model.startsWith("mock:");
	}

	// ── Door A ────────────────────────────────────────────────────────────

	/**
	 * Ingress admission, after the caller is authenticated and the input is valid, before any run,
	 * command or sandbox exists. Enforce refuses below the bar; observe records `would_block` and admits.
	 */
	async admitIngress(input: IngressAdmissionInput): Promise<IngressVerdict> {
		const voice = voiceOf(input.provider, input.model);
		if (this.isBypassed(voice, input.fundingSource)) return ALLOW;
		const billing = this.billing;
		if (!billing) return ALLOW;
		let balance: number;
		try {
			balance = await this.readBalance(billing, input.userId);
		} catch (error) {
			await this.recordFailOpen(input.door, input.userId, voice.model, error, input.sessionId);
			return ALLOW;
		}
		const held = this.heldFor(input.userId);
		const available = balance - held;
		let required: number;
		try {
			required = minAdmitMicroUsd(this.pricing, voice, input.rateCard);
		} catch (error) {
			// A card that does not belong to the voice (a caller's bug) is not a verdict on the person: like an
			// unreadable ledger it fails open, loudly, and the per-call door still decides.
			await this.recordFailOpen(input.door, input.userId, voice.model, error, input.sessionId);
			return ALLOW;
		}
		const span = trace.getActiveSpan();
		span?.setAttribute("billing.gate.mode", this.mode);
		if (available >= required) {
			span?.setAttribute("billing.gate.decision", "allow");
			this.count(input.door, "allow");
			return ALLOW;
		}
		const decision = this.mode === "observe" ? "would_block" : "block";
		span?.setAttribute("billing.gate.decision", decision);
		await this.record({
			door: input.door,
			decision,
			userId: input.userId,
			model: voice.model,
			balanceMicroUsd: available,
			requiredMicroUsd: required,
			reason: this.reasonOf(balance, held, input.sessionId),
		});
		if (this.mode === "observe") return ALLOW;
		return { allow: false, status: 402, body: insufficientCreditBody(available, required) };
	}

	// ── Door B ────────────────────────────────────────────────────────────

	/**
	 * Wrap the durable budget reservation of ONE model call. `reserve` receives the cost ceiling to pass
	 * into the reservation; a refusal (`credit_exhausted`) comes back as an `InsufficientCreditError`
	 * after a `block` row, and observe's would-be verdicts are recorded from the reservation's probe.
	 */
	async admitCall<T extends AdmittedReservation>(
		input: CallAdmissionInput,
		reserve: (credit: CallCredit) => Promise<T>,
	): Promise<T> {
		const voice = voiceOf(input.provider, input.model);
		const billing = this.billing;
		if (!billing || this.isBypassed(voice, input.fundingSource)) return reserve({ enforce: false });
		// One reservation at a time per person: the balance read, the reservation and the hold registration
		// are ONE critical section, so two concurrent calls can never both be offered the same money.
		return this.withUserLock(input.userId, async () => {
			let balance: number;
			try {
				balance = await this.readBalance(billing, input.userId);
			} catch (error) {
				await this.recordFailOpen("call", input.userId, voice.model, error, input.sessionId);
				const unread = await reserve({ enforce: false });
				this.registerHold(input.userId, unread);
				return unread;
			}
			const held = this.heldFor(input.userId);
			const available = balance - held;
			let result: T;
			try {
				result = await reserve({
					ceilingCostUsdMicros: Math.max(0, available),
					enforce: this.mode === "enforce",
				});
			} catch (error) {
				if (!isCreditExhaustedFault(error)) throw error;
				const required = this.viableCallCost(voice, input);
				await this.record({
					door: "call",
					decision: "block",
					userId: input.userId,
					model: voice.model,
					balanceMicroUsd: available,
					requiredMicroUsd: required,
					reason: this.reasonOf(balance, held, input.sessionId),
				});
				throw new InsufficientCreditError(available, required, "call");
			}
			this.registerHold(input.userId, result);
			await this.recordProbe(input, voice, { balance, held, available }, result.creditProbe);
			return result;
		});
	}

	// ── The Hoja evaluators ───────────────────────────────────────────────

	/**
	 * Admission for a direct OpenRouter call made by a host capability (the Hoja evaluators bypass
	 * `performLlmRequest`, so Door B never sees them). Once per provider call, before it: the SAME
	 * predicate as Door A. Enforce refuses with an `InsufficientCreditError`; observe records and runs.
	 * The call's worst case (input estimate plus the output cap) is held until its debit lands: the
	 * caller releases `evaluatorHoldKey(requestId)` after the debit.
	 */
	async admitEvaluator(input: EvaluatorAdmissionInput): Promise<void> {
		const voice = voiceOf("openrouter", input.model);
		const billing = this.billing;
		if (!billing || this.isBypassed(voice, "platform")) return;
		await this.withUserLock(input.userId, async () => {
			let balance: number;
			try {
				balance = await this.readBalance(billing, input.userId);
			} catch (error) {
				await this.recordFailOpen("evaluator", input.userId, voice.model, error, undefined);
				return;
			}
			const held = this.heldFor(input.userId);
			const available = balance - held;
			const required = minAdmitMicroUsd(this.pricing, voice);
			if (available < required) {
				const enforce = this.mode === "enforce";
				await this.record({
					door: "evaluator",
					decision: enforce ? "block" : "would_block",
					userId: input.userId,
					model: voice.model,
					balanceMicroUsd: available,
					requiredMicroUsd: required,
					reason: this.reasonOf(balance, held, undefined),
				});
				if (enforce) throw new InsufficientCreditError(available, required, "evaluator");
			} else {
				this.count("evaluator", "allow");
			}
			const worstCase = this.pricing.quoteMicroUsd(voice, {
				input: input.estimatedInputTokens,
				output: input.maxCompletionTokens,
			});
			this.holds.set(input.userId, evaluatorHoldKey(input.requestId), worstCase ?? 0);
		});
	}

	/** Register the new reservation's worst case as a hold; released when its debit is delivered. */
	private registerHold(userId: string, result: AdmittedReservation): void {
		if (result.applied) {
			this.holds.set(userId, result.reservation.operation_id, result.reservation.budget.costUsdMicros);
		}
	}

	/** Release an operation's hold: its debit was delivered, or the reservation was released or went indeterminate. */
	releaseHold(operationId: string): void {
		this.holds.release(operationId);
	}

	private async withUserLock<T>(userId: string, run: () => Promise<T>): Promise<T> {
		const previous = this.userLocks.get(userId) ?? Promise.resolve();
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = previous.then(() => held);
		this.userLocks.set(userId, tail);
		await previous;
		try {
			return await run();
		} finally {
			release();
			if (this.userLocks.get(userId) === tail) this.userLocks.delete(userId);
		}
	}

	private async recordProbe(
		input: CallAdmissionInput,
		voice: AdmissionVoice,
		seen: { balance: number; held: number; available: number },
		probe: CreditProbe | undefined,
	): Promise<void> {
		if (!probe || (!probe.wouldBlock && !probe.wouldClamp)) {
			this.count("call", "allow");
			return;
		}
		const detail = `maxOut=${probe.maxOutputTokensUnderCredit} of=${probe.maxOutputTokensSessionOnly}`;
		const reason = `${this.reasonOf(seen.balance, seen.held, input.sessionId)} ${detail}`;
		if (probe.wouldBlock) {
			// Only reachable in observe: enforce refused before a reservation existed.
			await this.record({
				door: "call",
				decision: "would_block",
				userId: input.userId,
				model: voice.model,
				balanceMicroUsd: seen.available,
				requiredMicroUsd: this.viableCallCost(voice, input),
				reason,
			});
			return;
		}
		await this.record({
			door: "call",
			decision: this.mode === "enforce" ? "clamp" : "would_clamp",
			userId: input.userId,
			model: voice.model,
			balanceMicroUsd: seen.available,
			requiredMicroUsd: null,
			reason,
		});
	}

	/** The cost of the smallest viable version of THIS call: what a refusal says it needed. */
	private viableCallCost(voice: AdmissionVoice, input: CallAdmissionInput): number {
		let quote: number | undefined;
		try {
			quote = this.pricing.quoteMicroUsd(
				voice,
				{
					input: input.estimatedInputTokens,
					output: Math.min(MIN_VIABLE_OUTPUT_TOKENS, input.requestedOutputTokens),
				},
				input.rateCard,
			);
		} catch {
			// A refusal is already being reported: a card that cannot price it only costs the figure its precision.
			quote = undefined;
		}
		return Math.max(MIN_ADMIT_FLOOR_MICRO_USD, quote ?? 0);
	}

	/**
	 * A provider that could not be paid (an upstream 402 on the PLATFORM's account) is not the person's
	 * empty balance. Recorded and logged as an alarm; the caller rewrites the error the person sees.
	 */
	async recordProviderUnavailable(input: { userId: string; model: string; detail: string }): Promise<void> {
		const detail = input.detail.replace(/\s+/g, " ").slice(0, 120);
		this.log(
			`[billing] ALARM provider_payment_failure mode=${this.mode} user=${input.userId} ` +
				`model=${input.model} detail=${detail}`,
		);
		await this.record(
			{
				door: "call",
				decision: "provider_unavailable",
				userId: input.userId,
				model: input.model,
				balanceMicroUsd: null,
				requiredMicroUsd: null,
				reason: `detail=${detail}`,
			},
			false,
		);
	}

	/**
	 * A voice the host will not price (a router priced -1, a free model, one with no tools, a precision no
	 * provider is shown to offer) is refused 422 `model_unpriced` before any run exists, in BOTH modes. It is not
	 * a credit verdict (nothing about the person's balance was read), so it is never a `would_`; it is a decision
	 * about a request, recorded so the refusals can be counted by voice and by reason: what people ask for and the
	 * host will not give is what the next catalogue rule or price should be told. Like every record it never
	 * breaks the request: a failed write is logged.
	 */
	async recordModelUnpriced(input: { userId: string | null; model: string | null; reason: string }): Promise<void> {
		await this.record({
			door: "ingress.invocation",
			decision: "model_unpriced",
			userId: input.userId,
			model: input.model,
			balanceMicroUsd: null,
			requiredMicroUsd: null,
			reason: `reason=${input.reason}`,
		});
	}

	// ── The record ────────────────────────────────────────────────────────

	/** What is in flight for this person and not yet debited. */
	private heldFor(userId: string): number {
		return this.holds.total(userId);
	}

	private reasonOf(balance: number, held: number, sessionId: string | undefined): string {
		return `balance=${balance} holds=${held}${sessionId ? ` session=${sessionId}` : ""}`;
	}

	private async readBalance(billing: BillingStore, userId: string): Promise<number> {
		const credit = await billing.getCredit(userId);
		return credit?.balanceMicroUsd ?? FREE_TIER_BALANCE_MICRO_USD;
	}

	private async recordFailOpen(
		door: GateDoor,
		userId: string,
		model: string,
		error: unknown,
		sessionId: string | undefined,
	): Promise<void> {
		trace.getActiveSpan()?.setAttribute("billing.gate.decision", "allow_fail_open");
		this.log(
			`[billing] gate=fail_open mode=${this.mode} door=${door} user=${userId} err=${messageOf(error)}` +
				`${sessionId ? ` session=${sessionId}` : ""}`,
		);
		await this.record(
			{
				door,
				decision: "fail_open",
				userId,
				model,
				balanceMicroUsd: null,
				requiredMicroUsd: null,
				reason: `err=${messageOf(error)}`,
			},
			false,
		);
	}

	/** Write one decision row; a failed write is logged and never propagates (the gate must not break chat). */
	private async record(event: Omit<GateEventInput, "ts" | "mode">, announce = true): Promise<void> {
		if (announce) {
			this.log(
				`[billing] gate=${event.decision} mode=${this.mode} door=${event.door} user=${event.userId ?? "-"} ` +
					`balance=${event.balanceMicroUsd ?? "-"} required=${event.requiredMicroUsd ?? "-"}`,
			);
		}
		const billing = this.billing;
		if (!billing) return;
		try {
			await billing.recordGateEvent({ ...event, ts: this.now(), mode: this.mode });
		} catch (error) {
			this.log(`[billing] gate event write failed (non-fatal): ${messageOf(error)}`);
		}
	}

	// ── Counters for the plain allows ─────────────────────────────────────

	private count(door: GateDoor, decision: "allow"): void {
		const day = new Date(this.now()).toISOString().slice(0, 10);
		this.addCount({ day, mode: this.mode, door, decision, n: 1 });
	}

	private addCount(delta: GateCounterDelta): void {
		const key = `${delta.day}|${delta.mode}|${delta.door}|${delta.decision}`;
		const existing = this.pendingCounts.get(key);
		this.pendingCounts.set(key, existing ? { ...existing, n: existing.n + delta.n } : delta);
	}

	/** Write the accumulated allow counts; on failure they are kept for the next flush. */
	async flushCounters(): Promise<void> {
		const billing = this.billing;
		if (!billing || this.pendingCounts.size === 0) return;
		const rows = [...this.pendingCounts.values()];
		this.pendingCounts.clear();
		try {
			await billing.bumpGateCounters(rows);
		} catch (error) {
			for (const row of rows) this.addCount(row);
			this.log(`[billing] gate counter flush failed (kept for the next flush): ${messageOf(error)}`);
		}
	}

	/** Flush the counters on an interval (unref'd, so it never holds the process open). */
	startCounterFlush(intervalMs = 60_000): void {
		if (this.counterTimer) return;
		this.counterTimer = setInterval(() => void this.flushCounters(), intervalMs);
		this.counterTimer.unref?.();
	}

	/** Stop the interval and write what is pending. Call before the ledger closes. */
	async stop(): Promise<void> {
		if (this.counterTimer) clearInterval(this.counterTimer);
		this.counterTimer = undefined;
		await this.flushCounters();
	}
}
