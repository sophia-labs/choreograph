import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { CognitoJwtVerifier } from "aws-jwt-verify";

export interface DelegatedBearerAuthContext {
	method: "delegated_bearer";
	bearerToken: string;
}

export interface InternalServiceAuthContext {
	method: "internal_service";
	userId: string;
	internalServiceSecret: string;
}

export type HostedAuthContext = DelegatedBearerAuthContext | InternalServiceAuthContext;

export interface ResolveHostedAuthContextOptions {
	expectedInternalServiceSecret?: string;
}

export interface ResolveHostedCallerUserIdOptions {
	apiBaseUrl: string;
	authContext: HostedAuthContext;
	requestTimeoutMs?: number;
	fetchFn?: typeof fetch;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export function resolveHostedAuthContext(
	headers: IncomingHttpHeaders,
	options?: ResolveHostedAuthContextOptions,
): HostedAuthContext | undefined {
	const internalServiceSecret = readSingleHeader(headers, "x-internal-service");
	const userId = readSingleHeader(headers, "x-user-id");

	if (internalServiceSecret) {
		const expectedInternalServiceSecret =
			options?.expectedInternalServiceSecret?.trim() || process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET?.trim();
		if (!expectedInternalServiceSecret) {
			throw new Error("MNEMOSYNE_INTERNAL_SERVICE_SECRET must be configured to accept internal-service auth");
		}
		if (!secretsMatch(internalServiceSecret, expectedInternalServiceSecret)) {
			throw new Error("X-Internal-Service is invalid");
		}
		if (!userId) {
			throw new Error("X-User-ID is required when X-Internal-Service is provided");
		}
		return {
			method: "internal_service",
			userId,
			internalServiceSecret,
		};
	}

	const authorization = readSingleHeader(headers, "authorization");
	if (!authorization) {
		return undefined;
	}

	const bearerToken = extractBearerToken(authorization);
	if (!bearerToken) {
		throw new Error("Authorization header must use the Bearer scheme");
	}

	return {
		method: "delegated_bearer",
		bearerToken,
	};
}

export function authMethodLabel(authContext: HostedAuthContext | undefined): string {
	return authContext?.method ?? "none";
}

export function extractBearerToken(authorizationHeader: string): string | undefined {
	const trimmed = authorizationHeader.trim();
	const match = /^Bearer\s+(.+)$/i.exec(trimmed);
	if (!match) {
		return undefined;
	}

	const token = match[1].trim();
	return token || undefined;
}

interface BearerSubVerifier {
	verify(token: string): Promise<{ sub?: unknown; email?: unknown; email_verified?: unknown }>;
}

let cachedCognitoVerifier: BearerSubVerifier | undefined;
let cachedCognitoPoolId: string | undefined;

function cognitoVerifier(userPoolId: string): BearerSubVerifier {
	if (!cachedCognitoVerifier || cachedCognitoPoolId !== userPoolId) {
		cachedCognitoVerifier = CognitoJwtVerifier.create({
			userPoolId,
			tokenUse: "id",
			clientId: process.env.COGNITO_CLIENT_ID?.trim() || null,
		}) as unknown as BearerSubVerifier;
		cachedCognitoPoolId = userPoolId;
	}
	return cachedCognitoVerifier;
}

async function verifyCognitoBearerSub(bearerToken: string, userPoolId: string): Promise<string> {
	const payload = await cognitoVerifier(userPoolId).verify(bearerToken);
	const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
	if (!sub) {
		throw new Error("Cognito ID token did not contain a sub claim");
	}
	return sub;
}

/** The longest address SMTP allows (RFC 5321). */
const MAX_EMAIL_CHARS = 254;

/**
 * The address a verified ID token vouches for, or nothing. Identity is the token's `sub`; the address only lets
 * Stripe send a receipt, so it is trusted only when the pool says it verified it (`email_verified` true, as a
 * boolean or as the string Cognito sometimes sends) and only when it is plainly one address.
 */
export function verifiedEmailClaim(claims: {
	readonly email?: unknown;
	readonly email_verified?: unknown;
}): string | undefined {
	const verified = claims.email_verified === true || claims.email_verified === "true";
	if (!verified || typeof claims.email !== "string") return undefined;
	const email = claims.email.trim();
	if (email.length === 0 || email.length > MAX_EMAIL_CHARS) return undefined;
	return /^[^\s@]+@[^\s@]+$/.test(email) ? email : undefined;
}

/**
 * The caller's verified email, best effort: a Cognito pool must be configured (the `/profile/me` fallback proves
 * an identity, not an address) and the request must carry a bearer ID token the pool verifies. Anything else (no
 * credentials, an internal-service caller, a malformed header, an expired token, a pool that is down) is
 * `undefined`, never an error: it must not be able to fail a checkout.
 */
export async function resolveCallerEmail(headers: IncomingHttpHeaders): Promise<string | undefined> {
	try {
		const userPoolId = process.env.COGNITO_USER_POOL_ID?.trim();
		if (!userPoolId) return undefined;
		const authorization = readSingleHeader(headers, "authorization");
		if (!authorization) return undefined;
		const token = extractBearerToken(authorization);
		if (!token) return undefined;
		return verifiedEmailClaim(await cognitoVerifier(userPoolId).verify(token));
	} catch {
		return undefined;
	}
}

export async function resolveHostedCallerUserId(options: ResolveHostedCallerUserIdOptions): Promise<string> {
	if (options.authContext.method === "internal_service") {
		return options.authContext.userId;
	}

	// Preferred: verify the delegated Cognito ID token locally against the user
	// pool's JWKS and use its `sub` as the caller identity — no dependency on a
	// legacy /profile/me service. Enabled when COGNITO_USER_POOL_ID is set;
	// otherwise falls back to the /profile/me lookup below.
	const cognitoUserPoolId = process.env.COGNITO_USER_POOL_ID?.trim();
	if (cognitoUserPoolId) {
		return verifyCognitoBearerSub(options.authContext.bearerToken, cognitoUserPoolId);
	}

	const apiBaseUrl = options.apiBaseUrl.trim();
	if (!apiBaseUrl) {
		throw new Error("MNEMOSYNE_API_BASE_URL is required to resolve delegated bearer identity");
	}

	const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	const fetchFn = options.fetchFn ?? fetch;
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort();
	}, requestTimeoutMs);

	try {
		const response = await fetchFn(new URL("/profile/me", apiBaseUrl), {
			headers: {
				Authorization: `Bearer ${options.authContext.bearerToken}`,
			},
			signal: controller.signal,
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(
				`GET ${new URL("/profile/me", apiBaseUrl)} failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`,
			);
		}

		const payload = (await response.json()) as { user_id?: unknown };
		if (typeof payload.user_id !== "string" || !payload.user_id.trim()) {
			throw new Error("GET /profile/me did not return user_id");
		}
		return payload.user_id.trim();
	} catch (error) {
		if (error instanceof Error && error.name === "AbortError") {
			throw new Error(`GET ${new URL("/profile/me", apiBaseUrl)} timed out after ${requestTimeoutMs}ms`);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

function readSingleHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
	const value = headers[name];
	if (Array.isArray(value)) {
		const first = value.find((entry) => entry.trim());
		return first?.trim() || undefined;
	}
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed || undefined;
	}
	return undefined;
}

function secretsMatch(provided: string, expected: string): boolean {
	const providedBuffer = Buffer.from(provided);
	const expectedBuffer = Buffer.from(expected);
	if (providedBuffer.length !== expectedBuffer.length) {
		return false;
	}
	return timingSafeEqual(providedBuffer, expectedBuffer);
}
