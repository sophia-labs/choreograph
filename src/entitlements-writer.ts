/**
 * Push a resolved tier LABEL to the gateway's internal entitlements WRITE route
 * (Identity & Entitlements P1c, choreograph side). After the subscription fold
 * lands a NEW tier in `subscription_state`, this PUTs it to the gateway, which
 * upserts the cloud-2 entitlements table. Best-effort by contract: the fold's
 * `subscription_state` row is the source of truth, so a failed push is logged
 * and reconcilable (Stripe redelivery re-runs the idempotent fold + re-pushes);
 * it must never fail the webhook.
 *
 * Auth: the `MNEMOSYNE_SERVICE_TOKEN` Bearer (must equal the gateway's
 * `PN_SERVICE_TOKEN`); the gateway's `check_service_token` validates it + the
 * path subject. CODE ONLY until `MNEMOSYNE_GATEWAY_BASE_URL` + the token are set.
 */
import type { Tier } from "./billing-store.js";

export interface GatewayWriterConfig {
	/** `MNEMOSYNE_GATEWAY_BASE_URL` — the gateway origin. */
	baseUrl: string;
	/** `MNEMOSYNE_SERVICE_TOKEN` — presented as Bearer; must match the gateway `PN_SERVICE_TOKEN`. */
	serviceToken: string;
	/** Injectable fetch (tests drive a real loopback server, not a mock). */
	fetchImpl?: typeof fetch;
}

export interface PushResult {
	ok: boolean;
	status: number;
}

/** `PUT {baseUrl}/internal/entitlements/{sub}` with the service token + `{tier}`. */
export async function pushTierToGateway(sub: string, tier: Tier, cfg: GatewayWriterConfig): Promise<PushResult> {
	const base = cfg.baseUrl.replace(/\/+$/, "");
	const url = `${base}/internal/entitlements/${encodeURIComponent(sub)}`;
	const doFetch = cfg.fetchImpl ?? fetch;
	const res = await doFetch(url, {
		method: "PUT",
		headers: {
			authorization: `Bearer ${cfg.serviceToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ tier }),
	});
	return { ok: res.ok, status: res.status };
}
