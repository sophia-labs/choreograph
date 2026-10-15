/**
 * A REAL orchestrator on loopback for the billing routes that are bearer-only
 * (`/api/billing/*`, Sobremesa credits). NO MOCKS.
 *
 * The happy path of those routes needs a signed-in human, and a Cognito JWKS cannot be reached
 * from a test. The orchestrator has a second, documented way to resolve a delegated bearer when
 * no Cognito pool is configured: `GET {MNEMOSYNE_API_BASE_URL}/profile/me`. This rig serves
 * exactly that over a real loopback HTTP server (token `tok-<userId>` answers `{user_id}`), so a
 * request travels the true route: header parsing, bearer-only rule, identity lookup, handler.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BillingGateMode, CreditAdmission } from "../billing-gate.js";
import type { BillingStore } from "../billing-store.js";
import { type LoopbackOrchestrator, type RouteCtx, startLoopbackOrchestrator } from "./billing-credit-fixture.js";
import { openBilling } from "./billing-ledger-fixture.js";

export interface BillingRouteRig {
	readonly billing: BillingStore;
	readonly gate: CreditAdmission | undefined;
	readonly baseUrl: string;
	readonly dir: string;
	/** The Authorization header for a signed-in person. */
	bearer(userId: string): Record<string, string>;
	stop(): Promise<void>;
}

const ENV = [
	"MNEMOSYNE_API_BASE_URL",
	"COGNITO_USER_POOL_ID",
	"MNEMOSYNE_INTERNAL_SERVICE_SECRET",
	"STRIPE_SECRET_KEY",
	"STRIPE_WEBHOOK_SECRET",
	"STRIPE_PRO_PRICE_ID",
	"STRIPE_API_BASE_URL",
	"STRIPE_API_VERSION",
	"BILLING_CHECKOUT_SUCCESS_URL",
	"BILLING_CHECKOUT_CANCEL_URL",
	"BILLING_PORTAL_RETURN_URL",
	"BILLING_EXEMPT_USER_IDS",
	"BILLING_FEE_BPS",
	"CREDITS_START_DATE",
	"MNEMOSYNE_GATEWAY_BASE_URL",
	"MNEMOSYNE_SERVICE_TOKEN",
] as const;

export async function startBillingRouteRig(
	options: { mode?: BillingGateMode | "none"; env?: Record<string, string | undefined> } = {},
): Promise<BillingRouteRig> {
	const dir = mkdtempSync(join(tmpdir(), "credit-billing-routes-"));
	const billing = await openBilling(dir);
	const gate =
		options.mode === undefined || options.mode === "none"
			? undefined
			: new CreditAdmission({ billing, mode: options.mode, log: () => {} });

	const profile: Server = createServer((request, response) => {
		const token = /^Bearer (tok-.+)$/.exec(String(request.headers.authorization ?? ""))?.[1];
		if (request.url !== "/profile/me" || !token) {
			response.statusCode = 401;
			response.end("{}");
			return;
		}
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ user_id: token.slice("tok-".length) }));
	});
	await new Promise<void>((resolve) => profile.listen(0, "127.0.0.1", resolve));
	const profileUrl = `http://127.0.0.1:${(profile.address() as AddressInfo).port}`;

	const saved: Record<string, string | undefined> = {};
	for (const name of ENV) saved[name] = process.env[name];
	process.env.MNEMOSYNE_API_BASE_URL = profileUrl;
	delete process.env.COGNITO_USER_POOL_ID;
	process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "shared-secret";
	for (const name of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_PRO_PRICE_ID"]) delete process.env[name];
	for (const [name, value] of Object.entries(options.env ?? {})) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}

	const orchestrator: LoopbackOrchestrator = await startLoopbackOrchestrator(
		() => ({ billing, ...(gate ? { creditGate: gate } : {}) }) as unknown as RouteCtx,
	);
	return {
		billing,
		gate,
		baseUrl: orchestrator.baseUrl,
		dir,
		bearer: (userId) => ({ authorization: `Bearer tok-${userId}` }),
		stop: async () => {
			await orchestrator.close();
			await new Promise<void>((resolve) => {
				profile.closeAllConnections?.();
				profile.close(() => resolve());
			});
			billing.close();
			rmSync(dir, { recursive: true, force: true });
			for (const name of ENV) {
				if (saved[name] === undefined) delete process.env[name];
				else process.env[name] = saved[name];
			}
		},
	};
}
