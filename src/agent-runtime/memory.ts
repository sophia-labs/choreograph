import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "@sophia-labs/canonical-json";
import type { SophiaContentRefV1, SophiaContentStore } from "./content-store.js";
import type { KernelSnapshotCapture } from "./execution-service.js";
import { PRIME_HOST_PROTOCOL_VERSION } from "./host-protocol.js";
import type { MeaningfulObjectRefV1 } from "./meaningful-object.js";
import { createMeaningfulObjectRef, validateMeaningfulObjectRef } from "./meaningful-object.js";
import { PRIME_RUNTIME_STATE_SCHEMA, type PrimeRuntimeStateV2 } from "./result-validation.js";

export const AGENT_CHECKPOINT_SCHEMA = "sophia.agent-checkpoint.v2" as const;
export const KERNEL_CHECKPOINT_SCHEMA = "sophia.kernel-checkpoint.v1" as const;

export interface AgentCheckpointCompatibilityV2 {
	readonly primeStateSchema: typeof PRIME_RUNTIME_STATE_SCHEMA;
	readonly primeBridgeProtocol: typeof PRIME_HOST_PROTOCOL_VERSION;
	readonly runtimeBundleId: string;
	readonly runtimeBundleDigest: string;
	readonly sessionFormatVersion: number;
}

export interface AgentCheckpointManifestV2 {
	readonly schema: typeof AGENT_CHECKPOINT_SCHEMA;
	readonly checkpointId: string;
	readonly agentSession: MeaningfulObjectRefV1<"agent-session">;
	readonly sessionId: string;
	readonly sessionSequence: number;
	readonly workerSequence: number;
	readonly generation: number;
	readonly sandboxId: string;
	readonly runtimeBindingDigest: string;
	readonly ontologyBindingDigest: string;
	readonly compatibility: AgentCheckpointCompatibilityV2;
	readonly state: SophiaContentRefV1;
	readonly stateDigest: string;
	readonly previousCheckpoint?: MeaningfulObjectRefV1<"agent-checkpoint">;
	readonly causationId: string;
	readonly createdAt: string;
}

export interface AgentCheckpointCommitV2 {
	readonly object: MeaningfulObjectRefV1<"agent-checkpoint">;
	readonly manifest: AgentCheckpointManifestV2;
}

export interface KernelCheckpointManifestV1 {
	readonly schema: typeof KERNEL_CHECKPOINT_SCHEMA;
	readonly checkpointId: string;
	readonly sessionId: string;
	readonly generation: number;
	readonly runtimeBundleDigest: string;
	readonly journalHeadDigest: string;
	readonly pythonVersion: string;
	readonly pythonImplementation: string;
	readonly pythonCacheTag: string;
	readonly dillVersion: string;
	readonly namespace: readonly string[];
	readonly skipped: Readonly<Record<string, string>>;
	readonly payload: SophiaContentRefV1;
	readonly createdAt: string;
}

export interface KernelCheckpointCommitV1 {
	readonly object: MeaningfulObjectRefV1<"kernel-checkpoint">;
	readonly manifest: KernelCheckpointManifestV1;
}

export interface AgentCheckpointRepository {
	commitAgentCheckpoint(checkpoint: AgentCheckpointCommitV2): Promise<void>;
	readLatestAgentCheckpoint(sessionId: string): Promise<AgentCheckpointCommitV2 | null>;
	commitKernelCheckpoint(checkpoint: KernelCheckpointCommitV1): Promise<void>;
	readLatestKernelCheckpoint(sessionId: string): Promise<KernelCheckpointCommitV1 | null>;
}

export interface CommitPrimeStateInput {
	readonly ownerPrincipal: string;
	readonly graphId: string;
	readonly agentSession: MeaningfulObjectRefV1<"agent-session">;
	readonly state: PrimeRuntimeStateV2;
	readonly runtimeBundle: { readonly id: string; readonly digest: string };
	readonly causationId: string;
}

/**
 * Sophia's memory boundary. Prime supplies process state; this coordinator
 * verifies it, spills the exact bytes to CAS, and commits a Meaningful Object
 * whose identity carries lineage, incarnation, compatibility, and causation.
 */
export class AgentMemory {
	constructor(
		private readonly content: SophiaContentStore,
		private readonly repository: AgentCheckpointRepository,
	) {}

	async commitPrimeState(input: CommitPrimeStateInput): Promise<AgentCheckpointCommitV2> {
		validateMeaningfulObjectRef(input.agentSession, "agent-session");
		validatePrimeStateShape(input.state);
		if (input.state.sessionId !== input.agentSession.objectId) {
			throw new AgentMemoryFault("Prime state does not belong to the Agent Session Meaningful Object");
		}
		const previous = await this.repository.readLatestAgentCheckpoint(input.state.sessionId);
		if (
			previous &&
			input.state.generation === previous.manifest.generation &&
			input.state.workerSequence <= previous.manifest.workerSequence
		) {
			throw new AgentMemoryFault("Agent checkpoint sequence must advance monotonically");
		}
		if (previous && input.state.generation < previous.manifest.generation) {
			throw new AgentMemoryFault("Agent checkpoint generation cannot move backwards");
		}
		const encoded = Buffer.from(canonicalJson(input.state), "utf8");
		const state = await this.content.put(encoded, "application/vnd.sophia.prime-runtime-state+json");
		const sessionFormatVersion = sessionVersion(input.state.sessionHeader);
		const checkpointId = `checkpoint_${randomUUID()}`;
		const manifest: AgentCheckpointManifestV2 = {
			schema: AGENT_CHECKPOINT_SCHEMA,
			checkpointId,
			agentSession: input.agentSession,
			sessionId: input.state.sessionId,
			sessionSequence: (previous?.manifest.sessionSequence ?? -1) + 1,
			workerSequence: input.state.workerSequence,
			generation: input.state.generation,
			sandboxId: input.state.sandboxId,
			runtimeBindingDigest: input.state.runtimeBindingDigest,
			ontologyBindingDigest: input.state.ontologyBindingDigest,
			compatibility: {
				primeStateSchema: PRIME_RUNTIME_STATE_SCHEMA,
				primeBridgeProtocol: PRIME_HOST_PROTOCOL_VERSION,
				runtimeBundleId: input.runtimeBundle.id,
				runtimeBundleDigest: input.runtimeBundle.digest,
				sessionFormatVersion,
			},
			state,
			stateDigest: input.state.digest,
			...(previous ? { previousCheckpoint: previous.object } : {}),
			causationId: input.causationId,
			createdAt: input.state.createdAt,
		};
		const object = createMeaningfulObjectRef({
			kind: "agent-checkpoint",
			ownerPrincipal: input.ownerPrincipal,
			graphId: input.graphId,
			objectId: checkpointId,
			version: `${String(manifest.generation)}:${String(manifest.sessionSequence)}`,
			value: manifest,
		});
		const checkpoint = { object, manifest } satisfies AgentCheckpointCommitV2;
		await this.repository.commitAgentCheckpoint(checkpoint);
		return checkpoint;
	}

	async restorePrimeState(checkpoint: AgentCheckpointCommitV2): Promise<PrimeRuntimeStateV2> {
		validateCheckpointCommit(checkpoint);
		const bytes = await this.content.get(checkpoint.manifest.state);
		let state: unknown;
		try {
			state = JSON.parse(bytes.toString("utf8"));
		} catch {
			throw new AgentMemoryFault("Agent checkpoint state is not valid JSON");
		}
		validatePrimeStateShape(state);
		if (
			state.digest !== checkpoint.manifest.stateDigest ||
			state.sessionId !== checkpoint.manifest.sessionId ||
			state.generation !== checkpoint.manifest.generation ||
			state.workerSequence !== checkpoint.manifest.workerSequence ||
			state.runtimeBindingDigest !== checkpoint.manifest.runtimeBindingDigest ||
			state.ontologyBindingDigest !== checkpoint.manifest.ontologyBindingDigest
		) {
			throw new AgentMemoryFault("Agent checkpoint manifest and Prime state disagree");
		}
		return state;
	}

	async commitKernelSnapshot(input: {
		sessionId: string;
		generation: number;
		ownerPrincipal: string;
		graphId: string;
		runtimeBundleDigest: string;
		journalHeadDigest: string;
		capture: KernelSnapshotCapture;
		createdAt: string;
	}): Promise<KernelCheckpointCommitV1> {
		const payload = await this.content.put(input.capture.payload, "application/vnd.sophia.kernel-dill");
		const checkpointId = `kernel_${randomUUID()}`;
		const manifest: KernelCheckpointManifestV1 = {
			schema: KERNEL_CHECKPOINT_SCHEMA,
			checkpointId,
			sessionId: input.sessionId,
			generation: input.generation,
			runtimeBundleDigest: input.runtimeBundleDigest,
			journalHeadDigest: input.journalHeadDigest,
			pythonVersion: input.capture.pythonVersion,
			pythonImplementation: input.capture.pythonImplementation,
			pythonCacheTag: input.capture.pythonCacheTag,
			dillVersion: input.capture.dillVersion,
			namespace: input.capture.namespace,
			skipped: input.capture.skipped,
			payload,
			createdAt: input.createdAt,
		};
		const object = createMeaningfulObjectRef({
			kind: "kernel-checkpoint",
			ownerPrincipal: input.ownerPrincipal,
			graphId: input.graphId,
			objectId: checkpointId,
			version: `${String(input.generation)}:${input.journalHeadDigest}`,
			value: manifest,
		});
		const checkpoint = { object, manifest } satisfies KernelCheckpointCommitV1;
		await this.repository.commitKernelCheckpoint(checkpoint);
		return checkpoint;
	}

	async restoreKernelSnapshot(checkpoint: KernelCheckpointCommitV1): Promise<KernelSnapshotCapture> {
		validateMeaningfulObjectRef(checkpoint.object, "kernel-checkpoint");
		if (
			checkpoint.manifest.schema !== KERNEL_CHECKPOINT_SCHEMA ||
			checkpoint.manifest.checkpointId !== checkpoint.object.objectId ||
			checkpoint.object.digest !== digestMeaningfulObject(checkpoint.manifest)
		) {
			throw new AgentMemoryFault("Kernel checkpoint identity or manifest is invalid");
		}
		const payload = await this.content.get(checkpoint.manifest.payload);
		return {
			pythonVersion: checkpoint.manifest.pythonVersion,
			pythonImplementation: checkpoint.manifest.pythonImplementation,
			pythonCacheTag: checkpoint.manifest.pythonCacheTag,
			dillVersion: checkpoint.manifest.dillVersion,
			namespace: [...checkpoint.manifest.namespace],
			skipped: { ...checkpoint.manifest.skipped },
			payload,
		};
	}
}

export class AgentMemoryFault extends Error {
	readonly code = "agent_memory_invalid";

	constructor(
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "AgentMemoryFault";
	}
}

export function validateCheckpointCommit(value: unknown): asserts value is AgentCheckpointCommitV2 {
	if (!isRecord(value) || !isRecord(value.manifest)) throw new AgentMemoryFault("Agent checkpoint commit is invalid");
	validateMeaningfulObjectRef(value.object, "agent-checkpoint");
	const manifest = value.manifest;
	if (manifest.schema !== AGENT_CHECKPOINT_SCHEMA)
		throw new AgentMemoryFault("Agent checkpoint schema is unsupported");
	if (manifest.checkpointId !== value.object.objectId) throw new AgentMemoryFault("Agent checkpoint identity drifted");
	if (value.object.digest !== digestMeaningfulObject(manifest)) {
		throw new AgentMemoryFault("Agent checkpoint Meaningful Object digest does not match its manifest");
	}
}

function validatePrimeStateShape(value: unknown): asserts value is PrimeRuntimeStateV2 {
	if (!isRecord(value) || value.schema !== PRIME_RUNTIME_STATE_SCHEMA) {
		throw new AgentMemoryFault("Prime runtime state schema is unsupported");
	}
	for (const key of [
		"sessionId",
		"sandboxId",
		"runtimeBindingDigest",
		"ontologyBindingDigest",
		"createdAt",
	] as const) {
		if (typeof value[key] !== "string" || value[key].length === 0) {
			throw new AgentMemoryFault(`Prime runtime state ${key} is missing`);
		}
	}
	if (!Number.isSafeInteger(value.generation) || (value.generation as number) < 0) {
		throw new AgentMemoryFault("Prime runtime state generation is invalid");
	}
	if (!Number.isSafeInteger(value.workerSequence) || (value.workerSequence as number) < 0) {
		throw new AgentMemoryFault("Prime runtime state worker sequence is invalid");
	}
	if (!isRecord(value.sessionHeader) || value.sessionHeader.type !== "session") {
		throw new AgentMemoryFault("Prime runtime state session header is invalid");
	}
	if (!Array.isArray(value.entries)) throw new AgentMemoryFault("Prime runtime state entries are invalid");
	if (typeof value.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.digest)) {
		throw new AgentMemoryFault("Prime runtime state digest is invalid");
	}
	const { digest, ...unsigned } = value;
	const expected = `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}`;
	if (digest !== expected) throw new AgentMemoryFault("Prime runtime state digest does not match its content");
}

function sessionVersion(value: unknown): number {
	if (!isRecord(value) || !Number.isSafeInteger(value.version) || (value.version as number) < 1) {
		throw new AgentMemoryFault("Prime session format version is missing");
	}
	return value.version as number;
}

function digestMeaningfulObject(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
