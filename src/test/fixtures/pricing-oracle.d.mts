/** Types for `pricing-oracle.mjs`, the independent reference the pricing tests are held to. */

export interface OracleModel {
	readonly id: string;
	readonly pricing: Readonly<Record<string, unknown>>;
	readonly supported_parameters?: readonly string[];
	readonly context_length?: number;
	readonly architecture?: { readonly input_modalities?: readonly string[] | null; readonly output_modalities?: readonly string[] | null };
	readonly top_provider?: { readonly context_length?: number | null };
}

export interface OracleTokens {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface OracleCost {
	readonly inputCostMicroUsd: number;
	readonly outputCostMicroUsd: number;
	readonly cacheReadCostMicroUsd: number;
	readonly cacheWriteCostMicroUsd: number;
	readonly providerCostMicroUsd: number;
	readonly markupMicroUsd: number;
	readonly costMicroUsd: number;
	readonly exactProviderMicroUsd: string;
	readonly exactTotalMicroUsd: string;
}

/** An exact, reduced fraction of two BigInts. */
export class Rat {
	constructor(numerator: bigint, denominator?: bigint);
	static decimal(text: string): Rat;
	ceil(): bigint;
	toString(): string;
}

/** `null` if the host would offer the model, else the reason code of the first rule that refuses it. */
export function assess(model: OracleModel): string | null;
export function cardPrices(model: OracleModel): {
	readonly base: Record<string, Rat>;
	readonly tiers: ReadonlyArray<readonly [number, Record<string, Rat>]>;
};
export function eventCost(model: OracleModel, tokens: OracleTokens, markupBps: number): OracleCost;
export function perMillionMicro(price: Rat, markupBps: number): number;
