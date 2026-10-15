/** Credential-owning host edge for ephemeral Development Domain scratch cells. */

import {
	DevelopmentEffectError,
	type DevelopmentGrantHost,
	developmentTerminal,
	type ValidatedDevelopmentHandoff,
	validateDevelopmentHandoff,
	verifyCurrentDevelopmentGrant,
} from "./development-effect.js";
import type { DomainSourceTurnV1 } from "./domain-source-turn.js";
import type { CommittedDevelopmentTarget, ProposedEffectV1 } from "./proposed-effect.js";
import type { EffectHandoffRecord, WorkflowRuntimeStore } from "./runtime-store.js";

export const SCRATCH_MATERIALIZATION_SCHEMA = "sophia.scratch-cell-materialization.v1" as const;
export const SCRATCH_EFFECT_COMPLETION_SCHEMA = "sophia.scratch-effect-completion.v1" as const;
export const SCRATCH_RECEIPT_SCHEMA = "sophia.scratch-cell-receipt.v1" as const;

const SCRATCH_OPERATIONS = new Set(["cell.launch", "cell.inspect", "cell.teardown"]);
const SHA256 = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

export type ScratchOperation = "cell.launch" | "cell.inspect" | "cell.teardown";
export type ScratchCellState =
	| "launching"
	| "ready"
	| "terminating"
	| "terminal"
	| "expired"
	| "absent"
	| "teardown-requested";

export interface ConcreteScratchTarget extends CommittedDevelopmentTarget {
	readonly imageDigest: string;
	readonly seedDigest: string;
	readonly ttlHours: number;
}

export interface ScratchMaterializationRequestV1 {
	readonly schema: typeof SCRATCH_MATERIALIZATION_SCHEMA;
	readonly operation: ScratchOperation;
	readonly effectIndex: number;
	readonly proposalDigest: string;
	readonly executionDigest: string;
	readonly sourceTurnDigest: string;
	readonly sourceTurn: DomainSourceTurnV1;
	readonly trigger: Readonly<Record<string, unknown>>;
	readonly proposal: ProposedEffectV1;
	readonly target: ConcreteScratchTarget;
	readonly grant: {
		readonly grantId: string;
		readonly grantDigest: string;
		readonly authorityOwnerPrincipal: string;
		readonly authorityGraphId: string;
	};
	readonly runId: string;
}

export interface ScratchCellReceiptV1 {
	readonly schema: typeof SCRATCH_RECEIPT_SCHEMA;
	readonly receiptId: string;
	readonly requestDigest: string;
	readonly effectIdempotencyKey: string;
	readonly sourceTurnId: string;
	readonly operation: ScratchOperation;
	readonly ownerPrincipal: string;
	readonly graphId: string;
	readonly scratchId: string;
	readonly repository: string;
	readonly sourceRevision: string;
	readonly scenarioDigest: string;
	readonly imageDigest: string;
	readonly seedDigest: string;
	readonly ttlHours: number;
	readonly invocationId: string;
	readonly state: ScratchCellState;
	readonly podUid?: string;
	readonly createdAtMs?: number;
	readonly expiresAtMs?: number;
	readonly observedAtMs: number;
}

export interface ScratchMaterializationResponseV1 {
	readonly created: boolean;
	readonly deleted: boolean;
	readonly receipt: ScratchCellReceiptV1;
}

export interface ScratchEffectCompletionV1 {
	readonly schema: typeof SCRATCH_EFFECT_COMPLETION_SCHEMA;
	readonly idempotencyKey: string;
	readonly operation: ScratchOperation;
	readonly ownerPrincipal: string;
	readonly graphId: string;
	readonly repository: string;
	readonly scenarioDigest: string;
	readonly imageDigest: string;
	readonly seedDigest: string;
	readonly ttlHours: number;
	readonly created: boolean;
	readonly deleted: boolean;
	readonly receipt: ScratchCellReceiptV1;
}

export interface ScratchEffectHost extends DevelopmentGrantHost {
	materialize(request: ScratchMaterializationRequestV1): Promise<ScratchMaterializationResponseV1>;
	close?(): Promise<void>;
}

export function validateScratchHandoff(record: EffectHandoffRecord): ValidatedDevelopmentHandoff {
	return validateDevelopmentHandoff(record, {
		capability: "cell.scratch",
		operations: SCRATCH_OPERATIONS,
	});
}

export class ScratchEffectExecutor {
	constructor(private readonly host: ScratchEffectHost) {}

	async execute(handoff: ValidatedDevelopmentHandoff): Promise<ScratchEffectCompletionV1> {
		const target = concreteTarget(handoff.target);
		const request: ScratchMaterializationRequestV1 = {
			schema: SCRATCH_MATERIALIZATION_SCHEMA,
			operation: handoff.record.operation as ScratchOperation,
			effectIndex: handoff.record.effect_index,
			proposalDigest: handoff.record.proposal_digest,
			executionDigest: handoff.record.execution_digest,
			sourceTurnDigest: requiredText(handoff.record.source_turn_digest, "source turn digest"),
			sourceTurn: handoff.sourceTurn,
			trigger: handoff.trigger,
			proposal: handoff.proposal,
			target,
			grant: {
				grantId: handoff.record.grant_id,
				grantDigest: handoff.record.grant_digest,
				authorityOwnerPrincipal: handoff.record.grant_authority_owner_principal,
				authorityGraphId: handoff.record.grant_authority_graph_id,
			},
			runId: handoff.record.run_id,
		};
		const result = await this.host.materialize(request);
		validateMaterializationResponse(result, request, handoff.record.idempotency_key);
		return {
			schema: SCRATCH_EFFECT_COMPLETION_SCHEMA,
			idempotencyKey: handoff.record.idempotency_key,
			operation: request.operation,
			ownerPrincipal: target.ownerPrincipal,
			graphId: target.scratchGraphId,
			repository: target.repository,
			scenarioDigest: target.scenarioDigest,
			imageDigest: target.imageDigest,
			seedDigest: target.seedDigest,
			ttlHours: target.ttlHours,
			created: result.created,
			deleted: result.deleted,
			receipt: result.receipt,
		};
	}
}

export class ScratchEffectWorker {
	private timer: ReturnType<typeof setInterval> | undefined;
	private active: Promise<boolean> | undefined;
	private closed = false;

	constructor(
		private readonly runtime: WorkflowRuntimeStore,
		private readonly host: ScratchEffectHost,
		private readonly executor = new ScratchEffectExecutor(host),
		private readonly options: {
			readonly consumer?: string;
			readonly pollMs?: number;
			readonly leaseMs?: number;
			readonly now?: () => number;
			readonly log?: (message: string, error?: unknown) => void;
		} = {},
	) {}

	start(): void {
		if (this.timer || this.closed) return;
		const pollMs = positiveInteger(this.options.pollMs ?? 1_000, "scratch effect poll interval");
		this.timer = setInterval(() => this.schedule(), pollMs);
		this.timer.unref?.();
		this.schedule();
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.active?.catch(() => {});
		await this.host.close?.();
	}

	async runOnce(): Promise<boolean> {
		const now = this.options.now?.() ?? Date.now();
		const consumer = this.options.consumer ?? "choreograph-scratch-edge";
		const record = await this.runtime.claimEffectHandoff({
			consumer,
			capabilities: ["cell.scratch"],
			leaseMs: positiveInteger(this.options.leaseMs ?? 60_000, "scratch effect lease"),
			now,
		});
		if (!record) return false;
		try {
			const handoff = validateScratchHandoff(record);
			await verifyCurrentDevelopmentGrant(this.host, handoff, this.options.now?.() ?? Date.now());
			const completion = await this.executor.execute(handoff);
			await this.runtime.completeEffectHandoff({
				idempotencyKey: record.idempotency_key,
				consumer,
				claimToken: requiredClaimToken(record),
				outcome: "executed",
				completion,
				now: this.options.now?.() ?? Date.now(),
			});
		} catch (error) {
			const failure =
				error instanceof DevelopmentEffectError ? error : new DevelopmentEffectError("scratch-host-failure", true);
			try {
				await this.runtime.completeEffectHandoff({
					idempotencyKey: record.idempotency_key,
					consumer,
					claimToken: requiredClaimToken(record),
					outcome: failure.retryable ? "failed-retryable" : "failed-terminal",
					completion: { schema: SCRATCH_EFFECT_COMPLETION_SCHEMA, code: failure.code },
					...(failure.retryable ? { retryAfterMs: retryDelay(record.attempt) } : {}),
					now: this.options.now?.() ?? Date.now(),
				});
			} catch (completionError) {
				this.options.log?.("scratch effect completion could not be persisted", completionError);
			}
		}
		return true;
	}

	private schedule(): void {
		if (this.closed || this.active) return;
		this.active = this.runOnce()
			.catch((error) => {
				this.options.log?.("scratch effect poll failed", error);
				return false;
			})
			.finally(() => {
				this.active = undefined;
			});
	}
}

function concreteTarget(target: CommittedDevelopmentTarget): ConcreteScratchTarget {
	if (!target.imageDigest || !IMAGE_DIGEST.test(target.imageDigest)) {
		throw developmentTerminal("scratch-image-digest-required");
	}
	if (!target.seedDigest || !SHA256.test(target.seedDigest)) {
		throw developmentTerminal("scratch-seed-digest-required");
	}
	if (!Number.isSafeInteger(target.ttlHours) || Number(target.ttlHours) < 1) {
		throw developmentTerminal("scratch-ttl-required");
	}
	return target as ConcreteScratchTarget;
}

function validateMaterializationResponse(
	value: unknown,
	request: ScratchMaterializationRequestV1,
	idempotencyKey: string,
): asserts value is ScratchMaterializationResponseV1 {
	if (!isRecord(value) || typeof value.created !== "boolean" || typeof value.deleted !== "boolean") {
		throw developmentTerminal("scratch-materialization-response-invalid");
	}
	const receipt = value.receipt;
	if (
		!isRecord(receipt) ||
		receipt.schema !== SCRATCH_RECEIPT_SCHEMA ||
		receipt.effectIdempotencyKey !== idempotencyKey ||
		receipt.sourceTurnId !== request.sourceTurn.turnId ||
		receipt.operation !== request.operation ||
		receipt.ownerPrincipal !== request.target.ownerPrincipal ||
		receipt.graphId !== request.target.scratchGraphId ||
		receipt.repository !== request.target.repository ||
		receipt.sourceRevision !== request.target.sourceRevision ||
		receipt.scenarioDigest !== request.target.scenarioDigest ||
		receipt.imageDigest !== request.target.imageDigest ||
		receipt.seedDigest !== request.target.seedDigest ||
		receipt.ttlHours !== request.target.ttlHours ||
		receipt.invocationId !== request.runId ||
		!SHA256.test(String(receipt.requestDigest)) ||
		typeof receipt.receiptId !== "string" ||
		!receipt.receiptId.startsWith("scratch-receipt:") ||
		!Number.isSafeInteger(receipt.observedAtMs)
	) {
		throw developmentTerminal("scratch-materialization-receipt-invalid");
	}
}

function requiredClaimToken(record: EffectHandoffRecord): string {
	if (!record.claim_token) throw new Error("scratch effect lease has no claim token");
	return record.claim_token;
}

function requiredText(value: string | null | undefined, label: string): string {
	if (!value) throw developmentTerminal(`scratch-${label.replaceAll(" ", "-")}-missing`);
	return value;
}

function retryDelay(attempt: number): number {
	return Math.min(3_600_000, 1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 11));
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
