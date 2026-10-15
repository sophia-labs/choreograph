/**
 * The operator's credit adjustments (Sobremesa credits, E 4.4.4 and 4.6): the way a person moves a balance
 * without a card. Test funding for a designated account, the goodwill lift ("credits start"), forgiving an
 * overdraft, a refund honoured by hand. Run on the box, over SSM, by someone who has read the plan:
 * `billing-adjust-cli.ts` is the command line; this is the part with the rules, importable and testable.
 *
 * The shape is the house's for a money-moving one-off (`import_credits.py`): a DRY RUN that prints exactly
 * what would be applied and writes nothing; ONE apply of exactly what was reviewed, named by the plan's
 * sha256; idempotent keys (`ops:<batch>:<label>`) so a repeat can never move money twice; and refusals that
 * say why. The money moves through the store's own `recordCreditAdjustment` (one transaction, balance and
 * record together), so the credit history and the credit gate see it at once.
 *
 * What the digest binds: the batch, the actor, and for every row its key, person, amount, kind, reason, source
 * reference, what the apply would do (`new`, `already_applied`) and whether the account exists (a new one is
 * seeded with the $1.00 starter before the adjustment). It does NOT bind balances: people chat while an
 * operator reads, and a digest that moved with every cent could never be applied on a live box.
 *
 * What it refuses, loudly: a malformed batch (all its problems at once); a key already used for a DIFFERENT
 * movement (a conflict refuses the whole batch, nothing is applied); an account the ledger has never seen
 * (a typo would mint a ghost account holding $1.00 plus the amount) unless told; an amount of more than $100
 * a row or $1,000 a batch (a typo in the zeros) unless told.
 *
 * THE LIFT ("credits start", Vera 2026-10-03): just before the flip, every account below $1.00 is raised to
 * $1.00, as an operator batch, dry run first. The repository cannot know who has spent, so what ships reviewed
 * is a RULE (`credit-lift.v1`: the bar, the kind, the reason a person reads, the batch id that is its
 * idempotency key) and the accounts are read from the live ledger when the script runs (`planLift`). It is the
 * same machinery with one difference that matters: a lift's amounts ARE balances, and people chat while an
 * operator reads, so its digest binds WHO is lifted and the rule, not the amounts (a digest that bound them
 * would go stale at the first cent anyone spent). The apply raises each account to exactly the bar from its
 * balance at the moment it runs. An account that falls below the bar, or rises above it, between the review
 * and the apply is a different plan: refused. One gift per account: the key is `ops:<batch>:lift-<account>`.
 */

import { createHash } from "node:crypto";
import { canonicalDigest } from "./agent-subject/canonical-json.js";
import { FREE_TIER_BALANCE_MICRO_USD } from "./billing-pricing.js";
import { type BillingStore, CREDIT_ADJUSTMENT_KINDS, type CreditAdjustmentKind } from "./billing-store.js";

export const ADJUSTMENT_BATCH_SCHEMA = "sophia.credit-adjustment-batch.v1" as const;
export const ADJUSTMENT_PLAN_SCHEMA = "sophia.credit-adjustment-plan.v1" as const;

/** A row above this is a typo in the zeros until the operator says otherwise: $100. */
export const MAX_ROW_MICRO_USD = 100_000_000;
/** A batch whose rows add up (in magnitude) to more than this is the same typo, repeated: $1,000. */
export const MAX_BATCH_MICRO_USD = 1_000_000_000;
export const MAX_BATCH_ROWS = 1_000;

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ACTOR_PATTERN = /^(operator|script):[A-Za-z0-9._:-]{1,100}$/;
const REASON_MAX_CHARS = 500;
const TEXT_MAX_CHARS = 200;

/** Kinds that only ever add credit, and kinds that only ever take it back. `correction` is either. */
const POSITIVE_KINDS: ReadonlySet<CreditAdjustmentKind> = new Set(["goodwill", "operator_funding"]);
const NEGATIVE_KINDS: ReadonlySet<CreditAdjustmentKind> = new Set(["refund", "dispute"]);

export interface AdjustmentRowInput {
	/** Unique in the batch; with the batch id it is the idempotency key `ops:<batch>:<label>`. */
	readonly label: string;
	/** The ledger's account id (the Cognito sub). */
	readonly userId: string;
	/** Signed, non-zero, integer µUSD. */
	readonly amountMicroUsd: number;
	readonly kind: CreditAdjustmentKind;
	/** Written for the person: it is in their credit history. */
	readonly reason: string;
	/** What it relates to (a ticket, a PaymentIntent). Never shown to the person. */
	readonly sourceRef?: string;
}

export interface AdjustmentBatch {
	readonly schema: typeof ADJUSTMENT_BATCH_SCHEMA;
	readonly batch: string;
	/** `operator:<name>` or `script:<name>`: recorded on every row, never shown to the person. */
	readonly actor: string;
	readonly adjustments: readonly AdjustmentRowInput[];
}

/** A batch the script cannot read: every problem found, not the first. */
export class AdjustmentBatchError extends Error {
	constructor(readonly problems: readonly string[]) {
		super(`invalid adjustment batch: ${problems.join("; ")}`);
		this.name = "AdjustmentBatchError";
	}
}

/** A plan that must not be applied as it stands (a conflict, a typo guard, a stale digest). */
export class AdjustmentRefusal extends Error {
	constructor(readonly problems: readonly string[]) {
		super(problems.join("; "));
		this.name = "AdjustmentRefusal";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BATCH_KEYS = new Set(["schema", "batch", "actor", "adjustments"]);
const ROW_KEYS = new Set(["label", "userId", "amountMicroUsd", "kind", "reason", "sourceRef"]);

/** Read and check a batch file's JSON. Unknown keys are refused: `amountMicroUSD` must not become a silent zero. */
export function parseAdjustmentBatch(value: unknown): AdjustmentBatch {
	const problems: string[] = [];
	if (!isRecord(value)) throw new AdjustmentBatchError(["the batch must be a JSON object"]);
	for (const key of Object.keys(value)) if (!BATCH_KEYS.has(key)) problems.push(`unknown batch field ${key}`);
	if (value.schema !== ADJUSTMENT_BATCH_SCHEMA) problems.push(`schema must be ${ADJUSTMENT_BATCH_SCHEMA}`);
	if (typeof value.batch !== "string" || !ID_PATTERN.test(value.batch)) {
		problems.push(
			"batch must be 1 to 64 characters of a-z, 0-9, dot, dash or underscore, starting with a letter or digit",
		);
	}
	if (typeof value.actor !== "string" || !ACTOR_PATTERN.test(value.actor)) {
		problems.push("actor must be operator:<name> or script:<name>");
	}
	const rows = value.adjustments;
	if (!Array.isArray(rows) || rows.length === 0) {
		problems.push("adjustments must be a non-empty array");
	} else if (rows.length > MAX_BATCH_ROWS) {
		problems.push(`a batch has at most ${MAX_BATCH_ROWS} rows`);
	}

	const parsed: AdjustmentRowInput[] = [];
	const labels = new Set<string>();
	if (Array.isArray(rows)) {
		rows.forEach((row, index) => {
			const where = `row ${index + 1}`;
			if (!isRecord(row)) {
				problems.push(`${where} must be an object`);
				return;
			}
			for (const key of Object.keys(row)) if (!ROW_KEYS.has(key)) problems.push(`${where}: unknown field ${key}`);
			const label = row.label;
			if (typeof label !== "string" || !ID_PATTERN.test(label)) {
				problems.push(`${where}: label must be 1 to 64 characters of a-z, 0-9, dot, dash or underscore`);
			} else if (labels.has(label)) {
				problems.push(`${where}: duplicate label ${label}`);
			} else {
				labels.add(label);
			}
			const userId = row.userId;
			if (typeof userId !== "string" || userId.length === 0 || userId.length > TEXT_MAX_CHARS || /\s/.test(userId)) {
				problems.push(`${where}: userId must be the account id, without spaces`);
			}
			const amount = row.amountMicroUsd;
			if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount === 0) {
				problems.push(`${where}: amountMicroUsd must be a non-zero whole number of micro-dollars`);
			}
			const kind = row.kind;
			if (typeof kind !== "string" || !(CREDIT_ADJUSTMENT_KINDS as readonly string[]).includes(kind)) {
				problems.push(`${where}: kind must be one of ${CREDIT_ADJUSTMENT_KINDS.join(", ")}`);
			} else if (typeof amount === "number" && Number.isSafeInteger(amount) && amount !== 0) {
				if (POSITIVE_KINDS.has(kind as CreditAdjustmentKind) && amount < 0) {
					problems.push(`${where}: a ${kind} adjustment must be positive`);
				}
				if (NEGATIVE_KINDS.has(kind as CreditAdjustmentKind) && amount > 0) {
					problems.push(`${where}: a ${kind} adjustment must be negative`);
				}
			}
			const reason = row.reason;
			if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > REASON_MAX_CHARS) {
				problems.push(`${where}: reason is required (the person reads it), at most ${REASON_MAX_CHARS} characters`);
			}
			const sourceRef = row.sourceRef;
			if (sourceRef !== undefined && (typeof sourceRef !== "string" || sourceRef.length > TEXT_MAX_CHARS)) {
				problems.push(`${where}: sourceRef must be text of at most ${TEXT_MAX_CHARS} characters`);
			}
			if (
				typeof label === "string" &&
				typeof userId === "string" &&
				typeof amount === "number" &&
				typeof kind === "string" &&
				typeof reason === "string"
			) {
				parsed.push({
					label,
					userId,
					amountMicroUsd: amount,
					kind: kind as CreditAdjustmentKind,
					reason: reason.trim(),
					...(typeof sourceRef === "string" ? { sourceRef } : {}),
				});
			}
		});
	}
	if (problems.length > 0) throw new AdjustmentBatchError(problems);
	return {
		schema: ADJUSTMENT_BATCH_SCHEMA,
		batch: value.batch as string,
		actor: value.actor as string,
		adjustments: parsed,
	};
}

export type AdjustmentRowStatus = "new" | "already_applied" | "conflict";

export interface AdjustmentPlanRow {
	readonly key: string;
	readonly label: string;
	readonly userId: string;
	readonly amountMicroUsd: number;
	readonly kind: CreditAdjustmentKind;
	readonly reason: string;
	readonly sourceRef: string | null;
	readonly status: AdjustmentRowStatus;
	/** `new`: the ledger has no row for this person, and the apply seeds the $1.00 starter before adjusting. */
	readonly account: "existing" | "new";
	/** The balance now (after the rows above it in this batch); null for an account that does not exist yet. */
	readonly balanceBeforeMicroUsd: number | null;
	readonly balanceAfterMicroUsd: number;
}

export interface AdjustmentPlan {
	readonly schema: typeof ADJUSTMENT_PLAN_SCHEMA;
	readonly batch: string;
	readonly actor: string;
	readonly rows: readonly AdjustmentPlanRow[];
	/** What the apply would add, signed: the rows that are `new`. */
	readonly totalMicroUsd: number;
	/** Why this plan cannot be applied as flagged; empty when it can. */
	readonly blocking: readonly string[];
	/** Names what is to be done. Excludes balances, which move while the plan is read. */
	readonly planSha256: string;
}

export interface AdjustmentOptions {
	/** Allow a row for a person the ledger has never seen (it is created, seeded with the $1.00 starter). */
	readonly allowNewAccounts?: boolean;
	/** Allow more than $100 a row or $1,000 a batch. */
	readonly allowLarge?: boolean;
}

export const adjustmentKey = (batch: string, label: string): string => `ops:${batch}:${label}`;

const dollars = (microUsd: number): string =>
	`$${(microUsd / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;

/** What applying this batch would do, read from the ledger without writing to it. */
export async function planAdjustments(
	store: Pick<BillingStore, "getCredit" | "getCreditAdjustment">,
	batch: AdjustmentBatch,
	options: AdjustmentOptions = {},
): Promise<AdjustmentPlan> {
	const blocking: string[] = [];
	const projected = new Map<string, number | null>();
	const rows: AdjustmentPlanRow[] = [];
	let total = 0;
	let magnitude = 0;
	for (const row of batch.adjustments) {
		const key = adjustmentKey(batch.batch, row.label);
		if (!projected.has(row.userId)) {
			const credit = await store.getCredit(row.userId);
			projected.set(row.userId, credit ? credit.balanceMicroUsd : null);
		}
		const before = projected.get(row.userId) ?? null;
		const existing = await store.getCreditAdjustment(key);
		let status: AdjustmentRowStatus = "new";
		if (existing) {
			const same =
				existing.userId === row.userId &&
				existing.amountMicroUsd === row.amountMicroUsd &&
				existing.kind === row.kind;
			status = same ? "already_applied" : "conflict";
		}
		const accountExists = before !== null;
		let after = before ?? FREE_TIER_BALANCE_MICRO_USD;
		if (status === "new") {
			after += row.amountMicroUsd;
			projected.set(row.userId, after);
			total += row.amountMicroUsd;
			magnitude += Math.abs(row.amountMicroUsd);
			if (!accountExists && !options.allowNewAccounts) {
				blocking.push(
					`${row.label}: ${row.userId} has no credits row; applying would create the account with the ${dollars(FREE_TIER_BALANCE_MICRO_USD)} starter credit plus ${dollars(row.amountMicroUsd)} (check the id, or pass --allow-new-accounts)`,
				);
			}
			if (Math.abs(row.amountMicroUsd) > MAX_ROW_MICRO_USD && !options.allowLarge) {
				blocking.push(
					`${row.label}: ${dollars(Math.abs(row.amountMicroUsd))} exceeds ${dollars(MAX_ROW_MICRO_USD)} per row (a typo in the zeros? pass --allow-large)`,
				);
			}
		} else if (status === "conflict" && existing) {
			blocking.push(
				`${row.label}: the key ${key} was applied before as a different movement (${existing.userId}, ${dollars(existing.amountMicroUsd)}, ${existing.kind}); a key is one movement, choose another label`,
			);
		}
		rows.push({
			key,
			label: row.label,
			userId: row.userId,
			amountMicroUsd: row.amountMicroUsd,
			kind: row.kind,
			reason: row.reason,
			sourceRef: row.sourceRef ?? null,
			status,
			account: accountExists ? "existing" : "new",
			balanceBeforeMicroUsd: before,
			balanceAfterMicroUsd: after,
		});
	}
	if (magnitude > MAX_BATCH_MICRO_USD && !options.allowLarge) {
		blocking.push(
			`the batch moves ${dollars(magnitude)} in all, more than ${dollars(MAX_BATCH_MICRO_USD)} (pass --allow-large)`,
		);
	}
	const planSha256 = canonicalDigest({
		schema: ADJUSTMENT_PLAN_SCHEMA,
		batch: batch.batch,
		actor: batch.actor,
		rows: rows.map((row) => ({
			key: row.key,
			userId: row.userId,
			amountMicroUsd: row.amountMicroUsd,
			kind: row.kind,
			reason: row.reason,
			sourceRef: row.sourceRef,
			status: row.status,
			account: row.account,
		})),
	});
	return {
		schema: ADJUSTMENT_PLAN_SCHEMA,
		batch: batch.batch,
		actor: batch.actor,
		rows,
		totalMicroUsd: total,
		blocking,
		planSha256,
	};
}

export interface AdjustmentReceipt {
	readonly key: string;
	readonly userId: string;
	readonly amountMicroUsd: number;
	readonly kind: CreditAdjustmentKind;
	/** false: the ledger already had this movement (this run, or an earlier one); nothing moved. */
	readonly applied: boolean;
	/** The balance in the same transaction as the adjustment: exact, whatever else was spending meanwhile. */
	readonly balanceAfterMicroUsd: number;
}

/**
 * Apply exactly the plan that was reviewed. Re-reads the ledger, refuses if anything blocks or if what would be
 * done is no longer what `expectedPlanSha256` names, then writes each `new` row through the store (one
 * transaction apiece, idempotent on its key: a run that dies half way is finished by a fresh dry run and apply).
 */
export async function applyAdjustments(
	store: BillingStore,
	batch: AdjustmentBatch,
	options: AdjustmentOptions & { readonly expectedPlanSha256: string },
): Promise<{ plan: AdjustmentPlan; receipts: AdjustmentReceipt[] }> {
	const plan = await planAdjustments(store, batch, options);
	if (plan.blocking.length > 0) throw new AdjustmentRefusal(plan.blocking);
	if (plan.planSha256 !== options.expectedPlanSha256) {
		throw new AdjustmentRefusal([
			`the plan to apply does not match the plan that was reviewed (reviewed ${options.expectedPlanSha256}, now ${plan.planSha256}): something it depends on changed; run the dry run again and review it`,
		]);
	}
	return { plan, receipts: await writePlanRows(store, plan.rows, batch.actor, batch.batch) };
}

/** Write each `new` row through the store (one transaction apiece, idempotent on its key); report every row. */
async function writePlanRows(
	store: BillingStore,
	rows: readonly AdjustmentPlanRow[],
	actor: string,
	batchId: string,
): Promise<AdjustmentReceipt[]> {
	const receipts: AdjustmentReceipt[] = [];
	for (const row of rows) {
		if (row.status === "new") {
			const result = await store.recordCreditAdjustment({
				adjustmentId: row.key,
				userId: row.userId,
				amountMicroUsd: row.amountMicroUsd,
				kind: row.kind,
				reason: row.reason,
				actor,
				batchId,
				sourceRef: row.sourceRef,
			});
			receipts.push({
				key: row.key,
				userId: row.userId,
				amountMicroUsd: row.amountMicroUsd,
				kind: row.kind,
				applied: result.isNew,
				balanceAfterMicroUsd: result.balanceMicroUsd,
			});
		} else {
			const credit = await store.getCredit(row.userId);
			receipts.push({
				key: row.key,
				userId: row.userId,
				amountMicroUsd: row.amountMicroUsd,
				kind: row.kind,
				applied: false,
				balanceAfterMicroUsd: credit?.balanceMicroUsd ?? row.balanceAfterMicroUsd,
			});
		}
	}
	return receipts;
}

// ─── The lift ("credits start") ─────────────────────────────────────────

export const LIFT_DEFINITION_SCHEMA = "sophia.credit-lift.v1" as const;
export const LIFT_PLAN_SCHEMA = "sophia.credit-lift-plan.v1" as const;

/** The reviewed input of a lift: a rule, not a list of people (see the header). */
export interface LiftDefinition {
	readonly schema: typeof LIFT_DEFINITION_SCHEMA;
	/** The idempotency scope: one lift per account per batch id. */
	readonly batch: string;
	/** `operator:<name>` or `script:<name>`: recorded on every row, never shown to the person. */
	readonly actor: string;
	/** A lift only adds: `goodwill` (the credits-start gift) or `operator_funding`. */
	readonly kind: CreditAdjustmentKind;
	/** The bar, integer µUSD: every account below it is raised to it. */
	readonly liftToMicroUsd: number;
	/** Written for the person: it is in their credit history. */
	readonly reason: string;
	/** What it relates to. Never shown to the person. */
	readonly sourceRef?: string;
}

const LIFT_KEYS = new Set(["schema", "batch", "actor", "kind", "liftToMicroUsd", "reason", "sourceRef"]);

/** Read and check a lift definition's JSON, as a batch's is: every problem at once, unknown keys refused. */
export function parseLiftDefinition(value: unknown): LiftDefinition {
	if (!isRecord(value)) throw new AdjustmentBatchError(["the definition must be a JSON object"]);
	const problems: string[] = [];
	for (const key of Object.keys(value)) if (!LIFT_KEYS.has(key)) problems.push(`unknown definition field ${key}`);
	if (value.schema !== LIFT_DEFINITION_SCHEMA) problems.push(`schema must be ${LIFT_DEFINITION_SCHEMA}`);
	if (typeof value.batch !== "string" || !ID_PATTERN.test(value.batch)) {
		problems.push(
			"batch must be 1 to 64 characters of a-z, 0-9, dot, dash or underscore, starting with a letter or digit",
		);
	}
	if (typeof value.actor !== "string" || !ACTOR_PATTERN.test(value.actor)) {
		problems.push("actor must be operator:<name> or script:<name>");
	}
	if (typeof value.kind !== "string" || !POSITIVE_KINDS.has(value.kind as CreditAdjustmentKind)) {
		problems.push(`kind must be ${[...POSITIVE_KINDS].join(" or ")} (a lift only adds credit)`);
	}
	const target = value.liftToMicroUsd;
	if (typeof target !== "number" || !Number.isSafeInteger(target) || target <= 0) {
		problems.push("liftToMicroUsd must be a positive whole number of micro-dollars");
	}
	const reason = value.reason;
	if (typeof reason !== "string" || reason.trim().length === 0 || reason.length > REASON_MAX_CHARS) {
		problems.push(`reason is required (the person reads it), at most ${REASON_MAX_CHARS} characters`);
	}
	const sourceRef = value.sourceRef;
	if (sourceRef !== undefined && (typeof sourceRef !== "string" || sourceRef.length > TEXT_MAX_CHARS)) {
		problems.push(`sourceRef must be text of at most ${TEXT_MAX_CHARS} characters`);
	}
	if (problems.length > 0) throw new AdjustmentBatchError(problems);
	return {
		schema: LIFT_DEFINITION_SCHEMA,
		batch: value.batch as string,
		actor: value.actor as string,
		kind: value.kind as CreditAdjustmentKind,
		liftToMicroUsd: target as number,
		reason: (reason as string).trim(),
		...(typeof sourceRef === "string" ? { sourceRef } : {}),
	};
}

export interface LiftPlan extends Omit<AdjustmentPlan, "schema"> {
	readonly schema: typeof LIFT_PLAN_SCHEMA;
	readonly lift: { readonly toMicroUsd: number; readonly kind: CreditAdjustmentKind };
}

/** An account id that is already a clean key part is used as is; any other is keyed by a hash of it. */
const CLEAN_ACCOUNT_KEY_PART = /^[a-z0-9][a-z0-9._-]{0,58}$/;
function liftLabel(userId: string): string {
	return CLEAN_ACCOUNT_KEY_PART.test(userId)
		? `lift-${userId}`
		: `lift-x${createHash("sha256").update(userId).digest("hex").slice(0, 32)}`;
}

/**
 * Who a lift would raise and by how much, read from the ledger in one snapshot without writing to it. A row
 * per account below the bar; an account lifted before by this batch id is `already_applied` at its recorded
 * amount (one gift per account, however far it has spent since), never a second lift.
 */
export async function planLift(
	store: Pick<BillingStore, "listCreditsBelow" | "getCreditAdjustment">,
	definition: LiftDefinition,
	options: AdjustmentOptions = {},
): Promise<LiftPlan> {
	const bar = definition.liftToMicroUsd;
	const blocking: string[] = [];
	const rows: AdjustmentPlanRow[] = [];
	let total = 0;
	let magnitude = 0;
	for (const account of await store.listCreditsBelow(bar)) {
		const label = liftLabel(account.userId);
		const key = adjustmentKey(definition.batch, label);
		const existing = await store.getCreditAdjustment(key);
		let status: AdjustmentRowStatus = "new";
		let amount = bar - account.balanceMicroUsd;
		if (existing) {
			if (existing.userId === account.userId && existing.kind === definition.kind) {
				status = "already_applied";
				amount = existing.amountMicroUsd;
			} else {
				status = "conflict";
				blocking.push(
					`${label}: the key ${key} was applied before as a different movement (${existing.userId}, ${dollars(existing.amountMicroUsd)}, ${existing.kind}); a key is one movement, choose another batch id`,
				);
			}
		}
		if (status === "new") {
			total += amount;
			magnitude += amount;
			if (amount > MAX_ROW_MICRO_USD && !options.allowLarge) {
				blocking.push(
					`${label}: ${dollars(amount)} exceeds ${dollars(MAX_ROW_MICRO_USD)} per row (a bar of more than $100? pass --allow-large)`,
				);
			}
		}
		rows.push({
			key,
			label,
			userId: account.userId,
			amountMicroUsd: amount,
			kind: definition.kind,
			reason: definition.reason,
			sourceRef: definition.sourceRef ?? null,
			status,
			account: "existing",
			balanceBeforeMicroUsd: account.balanceMicroUsd,
			balanceAfterMicroUsd: status === "new" ? bar : account.balanceMicroUsd,
		});
	}
	if (magnitude > MAX_BATCH_MICRO_USD && !options.allowLarge) {
		blocking.push(
			`the lift moves ${dollars(magnitude)} in all, more than ${dollars(MAX_BATCH_MICRO_USD)} (pass --allow-large)`,
		);
	}
	// Binds who is lifted (and whether each is still to be done) and the rule: never the amounts or balances.
	const planSha256 = canonicalDigest({
		schema: LIFT_PLAN_SCHEMA,
		batch: definition.batch,
		actor: definition.actor,
		kind: definition.kind,
		toMicroUsd: bar,
		reason: definition.reason,
		sourceRef: definition.sourceRef ?? null,
		rows: rows.map((row) => ({ key: row.key, userId: row.userId, status: row.status })),
	});
	return {
		schema: LIFT_PLAN_SCHEMA,
		batch: definition.batch,
		actor: definition.actor,
		lift: { toMicroUsd: bar, kind: definition.kind },
		rows,
		totalMicroUsd: total,
		blocking,
		planSha256,
	};
}

/**
 * Apply exactly the lift that was reviewed: re-reads the ledger, refuses if anything blocks or if WHO would be
 * lifted (or the rule) is no longer what `expectedPlanSha256` names, then raises each account to the bar from
 * its balance as the apply reads it (the amounts follow the balances; the digest does not).
 */
export async function applyLift(
	store: BillingStore,
	definition: LiftDefinition,
	options: AdjustmentOptions & { readonly expectedPlanSha256: string },
): Promise<{ plan: LiftPlan; receipts: AdjustmentReceipt[] }> {
	const plan = await planLift(store, definition, options);
	if (plan.blocking.length > 0) throw new AdjustmentRefusal(plan.blocking);
	if (plan.planSha256 !== options.expectedPlanSha256) {
		throw new AdjustmentRefusal([
			`the plan to apply does not match the plan that was reviewed (reviewed ${options.expectedPlanSha256}, now ${plan.planSha256}): who is lifted, or the rule, changed; run the dry run again and review it`,
		]);
	}
	return { plan, receipts: await writePlanRows(store, plan.rows, definition.actor, definition.batch) };
}
