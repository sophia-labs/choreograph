import { createHash } from "node:crypto";

/**
 * Owner-scoped provider credential names: where a person's own provider key lives in the encrypted parameter store
 * (`openrouter-credentials.ts`). The owner is hashed, so a parameter path never carries the subject.
 */

const OWNER_HASH_DOMAIN = "choreograph.provider-credential.owner.v1\0";
const PROVIDER_ID = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export class ProviderCredentialFault extends Error {
	constructor(
		readonly code: "provider_credential_invalid",
		message: string,
		readonly cause?: unknown,
	) {
		super(message);
		this.name = "ProviderCredentialFault";
	}
}

export function providerCredentialOwnerHash(ownerUserId: string): string {
	const owner = normalizeOwnerUserId(ownerUserId);
	return createHash("sha256").update(OWNER_HASH_DOMAIN).update(owner).digest("hex");
}

export function providerCredentialParameterName(prefix: string, ownerUserId: string, provider: string): string {
	const normalizedPrefix = normalizeParameterPrefix(prefix);
	const normalizedProvider = normalizeProvider(provider);
	return `${normalizedPrefix}/${providerCredentialOwnerHash(ownerUserId)}/${normalizedProvider}`;
}

function normalizeOwnerUserId(ownerUserId: string): string {
	const owner = ownerUserId.trim();
	if (!owner || owner.length > 512 || /[\0\r\n]/.test(owner)) throw invalid("owner user id is invalid");
	return owner;
}

function normalizeProvider(provider: string): string {
	const normalized = provider.trim().toLowerCase();
	if (!PROVIDER_ID.test(normalized)) throw invalid("provider id is invalid");
	return normalized;
}

function normalizeParameterPrefix(prefix: string): string {
	const normalized = prefix.trim();
	if (!normalized.startsWith("/") || normalized.endsWith("/") || normalized.includes("//")) {
		throw invalid("provider credential parameter prefix is invalid");
	}
	if (!/^\/[A-Za-z0-9_./-]+$/.test(normalized) || /(?:^|\/)\.\.?($|\/)/.test(normalized)) {
		throw invalid("provider credential parameter prefix is invalid");
	}
	return normalized;
}

function invalid(message: string, cause?: unknown): ProviderCredentialFault {
	return new ProviderCredentialFault("provider_credential_invalid", message, cause);
}
