/**
 * The fee is a boot-time setting (`BILLING_FEE_BPS`: unset means today's 1500, the flip sets 2000). A suite that
 * pins the numbers of one regime says so in a line and gets that fee for its whole run, restored after.
 *
 * Not a test file (it is outside the `*.test.ts` glob).
 */

import { after, before } from "node:test";

export const BILLING_FEE_ENV = "BILLING_FEE_BPS";

/** Set the fee in this process's environment (`undefined` unsets it); returns what puts it back. */
export function setBillingFeeEnv(bps: number | undefined): () => void {
	const saved = process.env[BILLING_FEE_ENV];
	if (bps === undefined) delete process.env[BILLING_FEE_ENV];
	else process.env[BILLING_FEE_ENV] = String(bps);
	return () => {
		if (saved === undefined) delete process.env[BILLING_FEE_ENV];
		else process.env[BILLING_FEE_ENV] = saved;
	};
}

/**
 * Hold the fee at `bps` (or unset it) for the suite this is called in, and restore it after. Called at the top of a
 * file it covers the file; called inside a `describe` it covers that block.
 */
export function useBillingFee(bps: number | undefined): void {
	let restore: (() => void) | undefined;
	before(() => {
		restore = setBillingFeeEnv(bps);
	});
	after(() => {
		restore?.();
	});
}
