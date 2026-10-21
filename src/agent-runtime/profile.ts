import { createHash } from "node:crypto";
import { canonicalJson } from "@sophia-labs/canonical-json";
import {
	type MeaningfulObjectRefV1,
	sameMeaningfulObjectRef,
	validateMeaningfulObjectRef,
} from "./meaningful-object.js";

export const AGENT_RUNTIME_BINDING_SCHEMA = "choreograph.agent-runtime-binding.v2" as const;

export type AgentRuntimeKind = "simple" | "prime";

export interface AgentRuntimeBundleRefV1 {
	readonly id: string;
	readonly digest: string;
}

export type AgentRuntimeProfileRefV1 = MeaningfulObjectRefV1<"agent-runtime-profile">;

export interface AgentRuntimeConstraintsV2 {
	readonly maxTurns: number;
	readonly maxWallTimeMs: number;
	/** Cumulative, metered input + output tokens for the whole Agent session. */
	readonly maxTokens: number;
	/** Admission ceiling for one model-visible prompt before compaction is required. */
	readonly maxPromptTokensPerCall?: number;
	/** Completion reservation ceiling for one inference call. */
	readonly maxCompletionTokensPerCall?: number;
	/** Maximum capability result carried inline into the private Python kernel. */
	readonly maxInlineToolResultBytes?: number;
	readonly maxCostUsdMicros: number;
	readonly maxChildren: number;
	readonly maxChildDepth: number;
	readonly maxConcurrentChildren: number;
	readonly maxArtifactBytes: number;
	readonly idlePassivateMs: number;
	readonly allowPersistentKernel: boolean;
	readonly allowAutonomousContinuation: boolean;
	readonly allowSchedules: boolean;
	readonly allowWorkflowProposals: boolean;
}

export interface AgentRuntimeBindingV2 {
	readonly schema: typeof AGENT_RUNTIME_BINDING_SCHEMA;
	readonly kind: AgentRuntimeKind;
	readonly bundle: AgentRuntimeBundleRefV1;
	readonly profileRef: AgentRuntimeProfileRefV1;
	readonly constraints: AgentRuntimeConstraintsV2;
}

export interface AgentRuntimeBindingInputV2 {
	readonly schema?: typeof AGENT_RUNTIME_BINDING_SCHEMA;
	readonly kind: AgentRuntimeKind;
	readonly bundle?: AgentRuntimeBundleRefV1;
	readonly profileRef: AgentRuntimeProfileRefV1;
	readonly constraints?: Partial<AgentRuntimeConstraintsV2>;
}

export interface ResolveAgentRuntimeBindingOptions {
	readonly bundles: Readonly<Record<AgentRuntimeKind, AgentRuntimeBundleRefV1>>;
	/**
	 * Host-resolved Meaningful Object snapshot. There is no anonymous built-in
	 * profile: every executable simple or Prime node resolves one of these.
	 */
	readonly profile: AgentRuntimeBindingV2;
	/** Optional node-level turn attenuation projected into the resolved profile. */
	readonly nodeMaxTurns?: number;
	/** Optional node-level wall-clock attenuation (ms) projected into the resolved profile. */
	readonly nodeMaxWallTimeMs?: number;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CONSTRAINT_KEYS = [
	"maxTurns",
	"maxWallTimeMs",
	"maxTokens",
	"maxPromptTokensPerCall",
	"maxCompletionTokensPerCall",
	"maxInlineToolResultBytes",
	"maxCostUsdMicros",
	"maxChildren",
	"maxChildDepth",
	"maxConcurrentChildren",
	"maxArtifactBytes",
	"idlePassivateMs",
	"allowPersistentKernel",
	"allowAutonomousContinuation",
	"allowSchedules",
	"allowWorkflowProposals",
] as const satisfies ReadonlyArray<keyof AgentRuntimeConstraintsV2>;

const NUMERIC_CONSTRAINT_KEYS = [
	"maxTurns",
	"maxWallTimeMs",
	"maxTokens",
	"maxCostUsdMicros",
	"maxChildren",
	"maxChildDepth",
	"maxConcurrentChildren",
	"maxArtifactBytes",
	"idlePassivateMs",
] as const satisfies ReadonlyArray<keyof AgentRuntimeConstraintsV2>;

const OPTIONAL_NUMERIC_CONSTRAINT_KEYS = [
	"maxPromptTokensPerCall",
	"maxCompletionTokensPerCall",
	"maxInlineToolResultBytes",
] as const satisfies ReadonlyArray<keyof AgentRuntimeConstraintsV2>;

const BOOLEAN_CONSTRAINT_KEYS = [
	"allowPersistentKernel",
	"allowAutonomousContinuation",
	"allowSchedules",
	"allowWorkflowProposals",
] as const satisfies ReadonlyArray<keyof AgentRuntimeConstraintsV2>;

/** Authoring baseline for minting an explicit simple runtime-profile object. */
export const SIMPLE_AGENT_RUNTIME_BASELINE: AgentRuntimeConstraintsV2 = Object.freeze({
	maxTurns: 6,
	maxWallTimeMs: 300_000,
	maxTokens: 20_000,
	maxPromptTokensPerCall: 16_000,
	maxCompletionTokensPerCall: 4_000,
	maxInlineToolResultBytes: 16_384,
	maxCostUsdMicros: 500_000,
	maxChildren: 0,
	maxChildDepth: 0,
	maxConcurrentChildren: 0,
	maxArtifactBytes: 268_435_456,
	idlePassivateMs: 0,
	allowPersistentKernel: false,
	allowAutonomousContinuation: false,
	allowSchedules: false,
	allowWorkflowProposals: false,
});

/** Authoring baseline for minting an explicit Prime runtime-profile object. */
export const PRIME_AGENT_RUNTIME_BASELINE: AgentRuntimeConstraintsV2 = Object.freeze({
	maxTurns: 24,
	maxWallTimeMs: 900_000,
	maxTokens: 500_000,
	maxPromptTokensPerCall: 240_000,
	maxCompletionTokensPerCall: 32_000,
	maxInlineToolResultBytes: 32_768,
	maxCostUsdMicros: 1_000_000,
	maxChildren: 4,
	maxChildDepth: 2,
	maxConcurrentChildren: 2,
	maxArtifactBytes: 268_435_456,
	idlePassivateMs: 60_000,
	allowPersistentKernel: true,
	allowAutonomousContinuation: false,
	allowSchedules: false,
	allowWorkflowProposals: false,
});

/** Independent host ceilings: graph-authored profiles may attenuate these, never widen them. */
export const AGENT_RUNTIME_PLATFORM_CEILINGS: Readonly<Record<AgentRuntimeKind, AgentRuntimeConstraintsV2>> =
	Object.freeze({
		simple: Object.freeze({
			maxTurns: 16,
			maxWallTimeMs: 900_000,
			maxTokens: 100_000,
			maxPromptTokensPerCall: 96_000,
			maxCompletionTokensPerCall: 16_000,
			maxInlineToolResultBytes: 65_536,
			maxCostUsdMicros: 2_000_000,
			maxChildren: 0,
			maxChildDepth: 0,
			maxConcurrentChildren: 0,
			maxArtifactBytes: 536_870_912,
			idlePassivateMs: 0,
			allowPersistentKernel: false,
			allowAutonomousContinuation: false,
			allowSchedules: false,
			allowWorkflowProposals: false,
		}),
		prime: Object.freeze({
			maxTurns: 64,
			maxWallTimeMs: 3_600_000,
			maxTokens: 500_000,
			maxPromptTokensPerCall: 400_000,
			maxCompletionTokensPerCall: 128_000,
			maxInlineToolResultBytes: 262_144,
			maxCostUsdMicros: 10_000_000,
			maxChildren: 16,
			maxChildDepth: 4,
			maxConcurrentChildren: 4,
			maxArtifactBytes: 1_073_741_824,
			idlePassivateMs: 3_600_000,
			allowPersistentKernel: true,
			allowAutonomousContinuation: false,
			allowSchedules: true,
			allowWorkflowProposals: true,
		}),
	});

export class AgentRuntimeBindingFault extends Error {
	readonly code = "agent_runtime_binding_invalid";

	constructor(
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "AgentRuntimeBindingFault";
	}
}

/**
 * Resolve an author-facing runtime selection into the exact immutable binding
 * that is safe to persist on a node attempt.
 *
 * The supplied profile is already a host-verified Garden/profile snapshot.
 * Every node constraint is attenuation-only: numbers may decrease and boolean
 * grants may turn off, never the reverse.
 */
export function resolveAgentRuntimeBinding(
	input: AgentRuntimeBindingInputV2,
	options: ResolveAgentRuntimeBindingOptions,
): AgentRuntimeBindingV2 {
	assertKnownKeys(input, ["schema", "kind", "bundle", "profileRef", "constraints"], "runtime binding");
	if (input.schema !== undefined && input.schema !== AGENT_RUNTIME_BINDING_SCHEMA) {
		throw fault("unsupported runtime binding schema", { schema: input.schema });
	}

	validateResolvedAgentRuntimeBinding(options.profile);
	const kind = input.kind;
	if (kind !== "simple" && kind !== "prime") {
		throw fault("runtime kind must be simple or prime", { kind });
	}
	if (options.profile.kind !== kind) {
		throw fault("node runtime kind does not match resolved profile", {
			nodeKind: kind,
			profileKind: options.profile.kind,
		});
	}

	const profileRef = resolveProfileRef(input.profileRef, options.profile);
	const bundle = resolveBundle(input.bundle, kind, options);
	const base = options.profile.constraints;
	validateConstraints(base, kind, "resolved profile");
	let constraints = attenuateConstraints(base, input.constraints, "node runtime constraints");

	if (options.nodeMaxTurns !== undefined) {
		const nodeMaxTurns = positiveInteger(options.nodeMaxTurns, "node maxTurns");
		if (nodeMaxTurns > constraints.maxTurns) {
			throw fault("node maxTurns would widen the resolved runtime profile", {
				nodeMaxTurns,
				profileMaxTurns: constraints.maxTurns,
			});
		}
		constraints = { ...constraints, maxTurns: nodeMaxTurns };
	}
	if (options.nodeMaxWallTimeMs !== undefined) {
		const nodeMaxWallTimeMs = positiveInteger(options.nodeMaxWallTimeMs, "node maxWallTimeMs");
		if (nodeMaxWallTimeMs > constraints.maxWallTimeMs) {
			throw fault("node maxWallTimeMs would widen the resolved runtime profile", {
				nodeMaxWallTimeMs,
				profileMaxWallTimeMs: constraints.maxWallTimeMs,
			});
		}
		constraints = { ...constraints, maxWallTimeMs: nodeMaxWallTimeMs };
	}

	validateConstraints(constraints, kind, "resolved runtime binding");
	return {
		schema: AGENT_RUNTIME_BINDING_SCHEMA,
		kind,
		bundle,
		profileRef,
		constraints,
	};
}

export function attenuateAgentRuntimeBinding(
	profile: AgentRuntimeBindingV2,
	attenuation: AgentRuntimeBindingInputV2 | undefined,
): AgentRuntimeBindingV2 {
	if (!attenuation) return { ...profile, constraints: { ...profile.constraints } };
	return resolveAgentRuntimeBinding(attenuation, {
		bundles: { simple: profile.bundle, prime: profile.bundle },
		profile,
	});
}

export function digestAgentRuntimeBinding(binding: AgentRuntimeBindingV2): string {
	validateResolvedAgentRuntimeBinding(binding);
	return `sha256:${createHash("sha256").update(canonicalJson(binding)).digest("hex")}`;
}

export function validateResolvedAgentRuntimeBinding(value: unknown): asserts value is AgentRuntimeBindingV2 {
	if (!isRecord(value)) throw fault("resolved runtime binding must be an object");
	assertKnownKeys(value, ["schema", "kind", "bundle", "profileRef", "constraints"], "resolved runtime binding");
	if (value.schema !== AGENT_RUNTIME_BINDING_SCHEMA) {
		throw fault("resolved runtime binding has an unsupported schema", { schema: value.schema });
	}
	if (value.kind !== "simple" && value.kind !== "prime") {
		throw fault("resolved runtime binding has an unsupported kind", { kind: value.kind });
	}
	validateBundleRef(value.bundle, "runtime bundle");
	validateProfileRef(value.profileRef);
	validateConstraints(value.constraints, value.kind, "resolved runtime binding");
	assertWithinPlatformCeiling(value.constraints, value.kind);
}

function assertWithinPlatformCeiling(constraints: AgentRuntimeConstraintsV2, kind: AgentRuntimeKind): void {
	const ceiling = AGENT_RUNTIME_PLATFORM_CEILINGS[kind];
	for (const key of NUMERIC_CONSTRAINT_KEYS) {
		if (constraints[key] > ceiling[key]) {
			throw fault(`resolved runtime binding.constraints.${key} exceeds the host platform ceiling`, {
				value: constraints[key],
				ceiling: ceiling[key],
			});
		}
	}
	for (const key of OPTIONAL_NUMERIC_CONSTRAINT_KEYS) {
		const value = constraints[key];
		const maximum = ceiling[key];
		if (value !== undefined && maximum !== undefined && value > maximum) {
			throw fault(`resolved runtime binding.constraints.${key} exceeds the host platform ceiling`, {
				value,
				ceiling: maximum,
			});
		}
	}
	for (const key of BOOLEAN_CONSTRAINT_KEYS) {
		if (constraints[key] && !ceiling[key]) {
			throw fault(`resolved runtime binding.constraints.${key} exceeds the host platform ceiling`);
		}
	}
}

function resolveBundle(
	input: AgentRuntimeBundleRefV1 | undefined,
	kind: AgentRuntimeKind,
	options: ResolveAgentRuntimeBindingOptions,
): AgentRuntimeBundleRefV1 {
	const expected = options.profile?.bundle ?? options.bundles[kind];
	validateBundleRef(expected, "host runtime bundle");
	if (input === undefined) return expected;
	validateBundleRef(input, "node runtime bundle");
	if (input.id !== expected.id || input.digest !== expected.digest) {
		throw fault("node runtime bundle does not match the host-resolved bundle", {
			requested: input,
			expected,
		});
	}
	return expected;
}

function resolveProfileRef(
	input: AgentRuntimeProfileRefV1 | undefined,
	profile: AgentRuntimeBindingV2,
): AgentRuntimeProfileRefV1 {
	if (input !== undefined) validateProfileRef(input);
	validateResolvedAgentRuntimeBinding(profile);
	if (input && !sameMeaningfulObjectRef(input, profile.profileRef)) {
		throw fault("node profileRef does not match the host-resolved profile", {
			requested: input,
			resolved: profile.profileRef,
		});
	}
	return profile.profileRef;
}

function attenuateConstraints(
	base: AgentRuntimeConstraintsV2,
	attenuation: Partial<AgentRuntimeConstraintsV2> | undefined,
	label: string,
): AgentRuntimeConstraintsV2 {
	if (attenuation === undefined) return { ...base };
	if (!isRecord(attenuation)) throw fault(`${label} must be an object`);
	assertKnownKeys(attenuation, CONSTRAINT_KEYS, label);

	const next: AgentRuntimeConstraintsV2 = { ...base };
	for (const key of NUMERIC_CONSTRAINT_KEYS) {
		const raw = attenuation[key];
		if (raw === undefined) continue;
		const value = nonNegativeInteger(raw, `${label}.${key}`);
		if (value > base[key]) {
			throw fault(`${label}.${key} would widen the resolved profile`, {
				requested: value,
				maximum: base[key],
			});
		}
		(next as MutableConstraints)[key] = value;
	}
	for (const key of OPTIONAL_NUMERIC_CONSTRAINT_KEYS) {
		const raw = attenuation[key];
		if (raw === undefined) continue;
		const value = positiveInteger(raw, `${label}.${key}`);
		const maximum = base[key];
		if (maximum === undefined || value > maximum) {
			throw fault(`${label}.${key} would widen the resolved profile`, {
				requested: value,
				maximum,
			});
		}
		(next as MutableConstraints)[key] = value;
	}
	for (const key of BOOLEAN_CONSTRAINT_KEYS) {
		const raw = attenuation[key];
		if (raw === undefined) continue;
		if (typeof raw !== "boolean") throw fault(`${label}.${key} must be boolean`);
		if (raw && !base[key]) {
			throw fault(`${label}.${key} would widen the resolved profile`, {
				requested: raw,
				maximum: base[key],
			});
		}
		(next as MutableConstraints)[key] = raw;
	}
	return next;
}

type MutableConstraints = {
	-readonly [Key in keyof AgentRuntimeConstraintsV2]: AgentRuntimeConstraintsV2[Key];
};

function validateConstraints(
	value: unknown,
	kind: AgentRuntimeKind,
	label: string,
): asserts value is AgentRuntimeConstraintsV2 {
	if (!isRecord(value)) throw fault(`${label} constraints must be an object`);
	assertKnownKeys(value, CONSTRAINT_KEYS, `${label} constraints`);
	for (const key of NUMERIC_CONSTRAINT_KEYS) {
		nonNegativeInteger(value[key], `${label}.constraints.${key}`);
	}
	for (const key of OPTIONAL_NUMERIC_CONSTRAINT_KEYS) {
		if (value[key] !== undefined) positiveInteger(value[key], `${label}.constraints.${key}`);
	}
	for (const key of BOOLEAN_CONSTRAINT_KEYS) {
		if (typeof value[key] !== "boolean") throw fault(`${label}.constraints.${key} must be boolean`);
	}
	const constraints = value as unknown as AgentRuntimeConstraintsV2;
	if (constraints.maxTurns < 1) throw fault(`${label}.constraints.maxTurns must be at least 1`);
	if (constraints.maxWallTimeMs < 1) throw fault(`${label}.constraints.maxWallTimeMs must be at least 1`);
	if (constraints.maxTokens < 1) throw fault(`${label}.constraints.maxTokens must be at least 1`);
	if (constraints.maxChildren === 0 && (constraints.maxChildDepth !== 0 || constraints.maxConcurrentChildren !== 0)) {
		throw fault(`${label} cannot grant child depth or concurrency when maxChildren is zero`);
	}
	if (constraints.maxChildren > 0 && (constraints.maxChildDepth < 1 || constraints.maxConcurrentChildren < 1)) {
		throw fault(`${label} must grant positive child depth and concurrency when children are enabled`);
	}
	if (kind === "simple") {
		if (
			constraints.maxChildren !== 0 ||
			constraints.maxChildDepth !== 0 ||
			constraints.maxConcurrentChildren !== 0 ||
			constraints.allowPersistentKernel ||
			constraints.allowAutonomousContinuation ||
			constraints.allowSchedules ||
			constraints.allowWorkflowProposals
		) {
			throw fault("simple runtime cannot enable Prime-only persistence, autonomy, or workflow mutation constraints");
		}
	}
}

function validateBundleRef(value: unknown, label: string): asserts value is AgentRuntimeBundleRefV1 {
	if (!isRecord(value)) throw fault(`${label} must be an object`);
	assertKnownKeys(value, ["id", "digest"], label);
	if (typeof value.id !== "string" || value.id.trim().length === 0) throw fault(`${label}.id is required`);
	if (typeof value.digest !== "string" || !DIGEST.test(value.digest)) {
		throw fault(`${label}.digest must be a lowercase sha256 digest`);
	}
}

function validateProfileRef(value: unknown): asserts value is AgentRuntimeProfileRefV1 {
	validateMeaningfulObjectRef(value, "agent-runtime-profile");
}

function positiveInteger(value: unknown, label: string): number {
	const parsed = nonNegativeInteger(value, label);
	if (parsed < 1) throw fault(`${label} must be at least 1`);
	return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw fault(`${label} must be a non-negative safe integer`, { value });
	}
	return value;
}

function assertKnownKeys(value: object, allowed: readonly string[], label: string): void {
	const set = new Set(allowed);
	const unknown = Object.keys(value).filter((key) => !set.has(key));
	if (unknown.length > 0) throw fault(`${label} contains unknown fields`, { unknown });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fault(message: string, details?: unknown): AgentRuntimeBindingFault {
	return new AgentRuntimeBindingFault(message, details);
}
