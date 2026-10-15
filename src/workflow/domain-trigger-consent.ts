import { createHash } from "node:crypto";
import { stableJson } from "./agent-tool-manifest.js";

export const DOMAIN_TRIGGER_CONSENT_SCHEMA = "sophia.domain-trigger-consent.v1" as const;

export interface DomainTriggerConsentV1 {
	readonly schema: typeof DOMAIN_TRIGGER_CONSENT_SCHEMA;
	readonly consentId: string;
	readonly subjectAgentId: string;
	readonly issuedBy: string;
	readonly authorityGraphId: string;
	readonly adapter: string;
	readonly triggerKinds: readonly string[];
	readonly sourcePrefixes: readonly string[];
	readonly issuedAt: number;
	readonly notBefore?: number;
	readonly expiresAt?: number;
	readonly status: "active" | "suspended" | "revoked" | "expired";
	readonly maxContextRefs: number;
	readonly maxContextBytes: number;
	readonly retention: "ephemeral" | "graph-referenced";
	readonly sourceRefs: readonly string[];
}

export class TriggerConsentError extends Error {
	constructor(
		readonly code:
			| "trigger_consent_invalid"
			| "trigger_consent_inactive"
			| "trigger_consent_not_yet_valid"
			| "trigger_consent_expired"
			| "trigger_consent_scope_denied",
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "TriggerConsentError";
	}
}

export function parseDomainTriggerConsent(value: unknown): DomainTriggerConsentV1 {
	const input = record(value, "trigger consent");
	if (input.schema !== DOMAIN_TRIGGER_CONSENT_SCHEMA) {
		throw invalid(`expected trigger consent schema '${DOMAIN_TRIGGER_CONSENT_SCHEMA}'`);
	}
	const consent = value as unknown as DomainTriggerConsentV1;
	for (const [label, field] of [
		["consentId", consent.consentId],
		["subjectAgentId", consent.subjectAgentId],
		["issuedBy", consent.issuedBy],
		["authorityGraphId", consent.authorityGraphId],
		["adapter", consent.adapter],
	] as const) {
		if (!text(field)) throw invalid(`${label} is required`);
	}
	if (!uniqueStrings(consent.triggerKinds)) throw invalid("triggerKinds must be non-empty and unique");
	if (!uniqueStrings(consent.sourcePrefixes)) throw invalid("sourcePrefixes must be non-empty and unique");
	if (!Number.isFinite(consent.issuedAt)) throw invalid("issuedAt must be finite epoch milliseconds");
	if (consent.notBefore !== undefined && !Number.isFinite(consent.notBefore))
		throw invalid("notBefore must be finite");
	if (consent.expiresAt !== undefined && !Number.isFinite(consent.expiresAt))
		throw invalid("expiresAt must be finite");
	if (!(<readonly unknown[]>["active", "suspended", "revoked", "expired"]).includes(consent.status)) {
		throw invalid("status is unsupported");
	}
	boundedInteger(consent.maxContextRefs, "maxContextRefs", 0, 10_000);
	boundedInteger(consent.maxContextBytes, "maxContextBytes", 0, 16_777_216);
	if (consent.retention !== "ephemeral" && consent.retention !== "graph-referenced") {
		throw invalid("retention is unsupported");
	}
	if (!Array.isArray(consent.sourceRefs) || consent.sourceRefs.some((ref) => !text(ref))) {
		throw invalid("sourceRefs must be strings");
	}
	return consent;
}

export function domainTriggerConsentDigest(consent: DomainTriggerConsentV1): string {
	return createHash("sha256")
		.update(stableJson(parseDomainTriggerConsent(consent)))
		.digest("hex");
}

export function assertDomainTriggerConsentActive(
	consent: DomainTriggerConsentV1,
	input: {
		agentId: string;
		kind: string;
		adapter: string;
		resource: string;
		contextRefs: readonly string[];
		now?: number;
	},
): void {
	const now = input.now ?? Date.now();
	if (consent.status !== "active") {
		throw new TriggerConsentError("trigger_consent_inactive", `trigger consent is ${consent.status}`);
	}
	if (consent.notBefore !== undefined && now < consent.notBefore) {
		throw new TriggerConsentError("trigger_consent_not_yet_valid", "trigger consent is not valid yet");
	}
	if (consent.expiresAt !== undefined && now >= consent.expiresAt) {
		throw new TriggerConsentError("trigger_consent_expired", "trigger consent has expired");
	}
	const allowed =
		consent.subjectAgentId === input.agentId &&
		consent.adapter === input.adapter &&
		consent.triggerKinds.includes(input.kind) &&
		consent.sourcePrefixes.some((prefix) => input.resource.startsWith(prefix)) &&
		input.contextRefs.length <= consent.maxContextRefs &&
		input.contextRefs.reduce((bytes, ref) => bytes + Buffer.byteLength(ref), 0) <= consent.maxContextBytes &&
		(consent.retention !== "graph-referenced" || input.contextRefs.every(isAbsoluteRef));
	if (!allowed) {
		throw new TriggerConsentError("trigger_consent_scope_denied", "trigger is outside its current consent scope", {
			kind: input.kind,
			adapter: input.adapter,
			resource: input.resource,
			contextRefCount: input.contextRefs.length,
		});
	}
}

function invalid(message: string): TriggerConsentError {
	return new TriggerConsentError("trigger_consent_invalid", message);
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): void {
	if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw invalid(`${label} must be an integer from ${minimum} to ${maximum}`);
	}
}

function uniqueStrings(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.length > 0 && value.every(text) && new Set(value).size === value.length;
}

function isAbsoluteRef(value: string): boolean {
	try {
		return Boolean(new URL(value).protocol);
	} catch {
		return value.startsWith("urn:");
	}
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw invalid(`${label} must be an object`);
	return value;
}

function text(value: unknown): value is string {
	return typeof value === "string" && Boolean(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
