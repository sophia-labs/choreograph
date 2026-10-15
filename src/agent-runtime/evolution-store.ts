import { createHash } from "node:crypto";
import type { Row, Transaction } from "@libsql/client";
import { LibsqlStore } from "../persistence/libsql-store.js";
import {
	type AgentEmbodimentV1,
	EMBODIMENT_ACTIVATION_SCHEMA,
	type EmbodimentActivationV1,
	type EmbodimentCandidateV1,
	type EvolutionDocumentV1,
	type EvolutionObjectKind,
	type PromotionDecisionV1,
	ROLLBACK_DECISION_SCHEMA,
	type RollbackDecisionV1,
	validateAgentEmbodiment,
	validateEmbodimentActivation,
	validateEmbodimentCandidate,
	validateEvaluationPolicy,
	validateEvolutionDocument,
	validatePromotionDecision,
	validateRollbackDecision,
} from "./evolution.js";
import { type EvolutionProjectionSink, serializeEvolutionObjectRdf } from "./evolution-rdf.js";
import { type ExtensionVerificationRunV1, validateExtensionVerificationRun } from "./extension-evaluation.js";
import {
	createMeaningfulObjectRef,
	type MeaningfulObjectKind,
	type MeaningfulObjectRefV1,
	sameMeaningfulObjectRef,
	validateMeaningfulObjectRef,
} from "./meaningful-object.js";

export interface EvolutionObjectRecord {
	readonly ref: MeaningfulObjectRefV1<EvolutionObjectKind>;
	readonly agentId: string | null;
	readonly document: EvolutionDocumentV1;
	readonly createdAt: number;
}

export interface EvolutionEvidenceRecord {
	readonly ref: MeaningfulObjectRefV1;
	readonly agentId: string;
	readonly document: unknown;
	readonly createdAt: number;
}

export interface AgentEmbodimentHead {
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly embodimentRef: MeaningfulObjectRefV1<"embodiment">;
	readonly revision: number;
	readonly updatedAt: number;
}

export interface CandidateEvaluationRecord {
	readonly candidateRef: MeaningfulObjectRefV1<"embodiment-candidate">;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly expectedIncumbentDigest: string;
	readonly policyRef: MeaningfulObjectRefV1<"evaluation-policy">;
	readonly evaluationSetDigest: string;
	readonly state: "eligible" | "ineligible" | "stale" | "quarantined";
	readonly evaluatedBy: string;
	readonly evaluatedAt: number;
}

export interface ListEvolutionObjectsInput {
	readonly ownerPrincipal: string;
	readonly agentId?: string;
	readonly kind?: EvolutionObjectKind;
	readonly limit?: number;
}

export interface PublishEvolutionObjectInput<Kind extends EvolutionObjectKind, Document extends EvolutionDocumentV1> {
	readonly kind: Kind;
	readonly graphId: string;
	readonly version: string;
	readonly document: Document;
	readonly createdAt: number;
}

export interface CommitEmbodimentActivationInput {
	readonly activationId: string;
	readonly graphId: string;
	readonly version: string;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly expectedIncumbentRef: MeaningfulObjectRefV1<"embodiment">;
	readonly nextEmbodimentRef: MeaningfulObjectRefV1<"embodiment">;
	readonly candidateRef: MeaningfulObjectRefV1<"embodiment-candidate">;
	readonly promotionDecisionRef: MeaningfulObjectRefV1<"promotion-decision">;
	readonly mode: EmbodimentActivationV1["mode"];
	readonly committedBy: string;
	readonly committedAt: number;
}

export interface CommitRollbackInput {
	readonly decisionId: string;
	readonly graphId: string;
	readonly version: string;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly activationRef: MeaningfulObjectRefV1<"embodiment-activation">;
	readonly targetEmbodimentRef: MeaningfulObjectRefV1<"embodiment">;
	readonly evidenceRefs: readonly MeaningfulObjectRefV1[];
	readonly decidedBy: string;
	readonly automatic: boolean;
	readonly reason: string;
	readonly decidedAt: number;
	readonly quarantineCurrent: boolean;
}

export class EvolutionObjectConflictError extends Error {
	readonly code = "evolution_object_conflict";

	constructor(readonly ref: MeaningfulObjectRefV1) {
		super(`evolution object '${ref.kind}:${ref.objectId}@${ref.version}' already exists with different content`);
		this.name = "EvolutionObjectConflictError";
	}
}

export class EmbodimentActivationConflictError extends Error {
	readonly code = "embodiment_activation_conflict";

	constructor(
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "EmbodimentActivationConflictError";
	}
}

/**
 * Transactional authority for owner-scoped evolution state.
 *
 * Garden may project these documents, but only this store chooses a live head,
 * records evaluation eligibility, commits activation CAS, or rolls a head back.
 */
export class AgentEvolutionStore extends LibsqlStore {
	constructor(databasePath: string) {
		super(databasePath, {
			snapshotName: "agent-evolution",
			s3Url: process.env.AGENT_EVOLUTION_S3_URL,
		});
	}

	protected async createSchema(): Promise<void> {
		await this.db.batch(
			[
				`CREATE TABLE IF NOT EXISTS evolution_objects (
					kind            TEXT NOT NULL,
					owner_principal TEXT NOT NULL,
					graph_id        TEXT NOT NULL,
					object_id       TEXT NOT NULL,
					version         TEXT NOT NULL,
					digest          TEXT NOT NULL,
					agent_id        TEXT,
					document_json   TEXT NOT NULL,
					created_at      INTEGER NOT NULL,
					PRIMARY KEY (kind, owner_principal, graph_id, object_id, version)
				)`,
				`CREATE TABLE IF NOT EXISTS agent_embodiment_heads (
					owner_principal TEXT NOT NULL,
					agent_id        TEXT NOT NULL,
					graph_id        TEXT NOT NULL,
					object_id       TEXT NOT NULL,
					version         TEXT NOT NULL,
					digest          TEXT NOT NULL,
					revision        INTEGER NOT NULL,
					updated_at      INTEGER NOT NULL,
					PRIMARY KEY (owner_principal, agent_id)
				)`,
				`CREATE TABLE IF NOT EXISTS candidate_evaluations (
					candidate_digest             TEXT PRIMARY KEY,
					candidate_ref_json           TEXT NOT NULL,
					owner_principal              TEXT NOT NULL,
					agent_id                     TEXT NOT NULL,
					expected_incumbent_digest    TEXT NOT NULL,
					policy_ref_json              TEXT NOT NULL,
					evaluation_set_digest        TEXT NOT NULL,
					state                         TEXT NOT NULL,
					evaluated_by                  TEXT NOT NULL,
					evaluated_at                  INTEGER NOT NULL
				)`,
				`CREATE TABLE IF NOT EXISTS embodiment_activations (
					activation_id       TEXT PRIMARY KEY,
					activation_ref_json TEXT NOT NULL,
					owner_principal     TEXT NOT NULL,
					agent_id            TEXT NOT NULL,
					from_digest         TEXT NOT NULL,
					to_digest           TEXT NOT NULL,
					mode                TEXT NOT NULL,
					transaction_revision INTEGER NOT NULL,
					committed_at        INTEGER NOT NULL,
					UNIQUE(owner_principal, agent_id, transaction_revision, mode, activation_id)
				)`,
				`CREATE TABLE IF NOT EXISTS embodiment_canaries (
					activation_id       TEXT PRIMARY KEY,
					owner_principal     TEXT NOT NULL,
					agent_id            TEXT NOT NULL,
					expected_head_digest TEXT NOT NULL,
					embodiment_ref_json TEXT NOT NULL,
					created_at          INTEGER NOT NULL,
					revoked_at          INTEGER
				)`,
				`CREATE TABLE IF NOT EXISTS rollback_decisions (
					decision_id       TEXT PRIMARY KEY,
					decision_ref_json TEXT NOT NULL,
					owner_principal   TEXT NOT NULL,
					agent_id          TEXT NOT NULL,
					from_digest       TEXT NOT NULL,
					to_digest         TEXT NOT NULL,
					transaction_revision INTEGER NOT NULL,
					decided_at        INTEGER NOT NULL
				)`,
				`CREATE TABLE IF NOT EXISTS embodiment_quarantine (
					embodiment_digest TEXT PRIMARY KEY,
					owner_principal   TEXT NOT NULL,
					agent_id          TEXT NOT NULL,
					decision_ref_json TEXT NOT NULL,
					quarantined_at    INTEGER NOT NULL
				)`,
				`CREATE INDEX IF NOT EXISTS idx_evolution_objects_agent
					ON evolution_objects(owner_principal, agent_id, created_at)`,
				`CREATE INDEX IF NOT EXISTS idx_candidate_evaluations_agent
					ON candidate_evaluations(owner_principal, agent_id, state, evaluated_at)`,
				`CREATE INDEX IF NOT EXISTS idx_embodiment_activations_agent
					ON embodiment_activations(owner_principal, agent_id, committed_at)`,
				`CREATE TABLE IF NOT EXISTS evolution_evidence_objects (
					kind            TEXT NOT NULL,
					owner_principal TEXT NOT NULL,
					graph_id        TEXT NOT NULL,
					object_id       TEXT NOT NULL,
					version         TEXT NOT NULL,
					digest          TEXT NOT NULL,
					agent_id        TEXT NOT NULL,
					document_json   TEXT NOT NULL,
					created_at      INTEGER NOT NULL,
					PRIMARY KEY (kind, owner_principal, graph_id, object_id, version)
				)`,
				`CREATE TABLE IF NOT EXISTS evolution_evidence_blobs (
					ref_digest      TEXT PRIMARY KEY,
					owner_principal TEXT NOT NULL,
					media_type      TEXT NOT NULL,
					content_digest  TEXT NOT NULL,
					body            BLOB NOT NULL,
					created_at      INTEGER NOT NULL
				)`,
				`CREATE INDEX IF NOT EXISTS idx_evolution_evidence_agent
					ON evolution_evidence_objects(owner_principal, agent_id, created_at)`,
				`CREATE TABLE IF NOT EXISTS evolution_projection_outbox (
					ref_digest    TEXT PRIMARY KEY,
					record_json   TEXT NOT NULL,
					enqueued_at   INTEGER NOT NULL,
					attempts      INTEGER NOT NULL DEFAULT 0,
					last_error    TEXT,
					projected_at  INTEGER
				)`,
				`CREATE INDEX IF NOT EXISTS idx_evolution_projection_pending
					ON evolution_projection_outbox(projected_at, enqueued_at)`,
			],
			"write",
		);
	}

	async publishEvolutionObject<Kind extends EvolutionObjectKind, Document extends EvolutionDocumentV1>(
		input: PublishEvolutionObjectInput<Kind, Document>,
	): Promise<MeaningfulObjectRefV1<Kind>> {
		validateEvolutionDocument(input.kind, input.document);
		const identity = documentIdentity(input.document);
		const objectId = documentId(input.kind, input.document);
		const ref = createMeaningfulObjectRef({
			kind: input.kind,
			ownerPrincipal: identity.ownerPrincipal,
			graphId: required(input.graphId, "graphId"),
			objectId,
			version: required(input.version, "version"),
			value: input.document,
		});
		await this.tx(async (tx) => {
			await insertEvolutionObject(tx, {
				ref,
				agentId: identity.agentId,
				document: input.document,
				createdAt: input.createdAt,
			});
		}, "UPSERT_IF_ABSENT");
		return ref;
	}

	async getEvolutionObject(ref: MeaningfulObjectRefV1): Promise<EvolutionObjectRecord | null> {
		if (!isEvolutionKind(ref.kind)) return null;
		validateMeaningfulObjectRef(ref, ref.kind);
		const result = await this.read({
			sql: `SELECT * FROM evolution_objects
			       WHERE kind = ? AND owner_principal = ? AND graph_id = ?
			         AND object_id = ? AND version = ? AND digest = ?`,
			args: [ref.kind, ref.ownerPrincipal, ref.graphId, ref.objectId, ref.version, ref.digest],
		});
		return result.rows[0] ? rowToEvolutionObject(result.rows[0]) : null;
	}

	async publishEvidenceObject(input: {
		readonly ref: MeaningfulObjectRefV1;
		readonly agentId: string;
		readonly document: unknown;
		readonly createdAt: number;
	}): Promise<MeaningfulObjectRefV1> {
		validateMeaningfulObjectRef(input.ref);
		const exact = createMeaningfulObjectRef({
			kind: input.ref.kind,
			ownerPrincipal: input.ref.ownerPrincipal,
			graphId: input.ref.graphId,
			objectId: input.ref.objectId,
			version: input.ref.version,
			value: input.document,
		});
		if (!sameMeaningfulObjectRef(exact, input.ref)) {
			throw new EvolutionObjectConflictError(input.ref);
		}
		await this.tx(async (tx) => {
			const existing = await tx.execute({
				sql: `SELECT digest FROM evolution_evidence_objects
				       WHERE kind = ? AND owner_principal = ? AND graph_id = ? AND object_id = ? AND version = ?`,
				args: [input.ref.kind, input.ref.ownerPrincipal, input.ref.graphId, input.ref.objectId, input.ref.version],
			});
			if (existing.rows[0]) {
				if (String(existing.rows[0].digest) !== input.ref.digest) throw new EvolutionObjectConflictError(input.ref);
				return;
			}
			await tx.execute({
				sql: `INSERT INTO evolution_evidence_objects
					(kind, owner_principal, graph_id, object_id, version, digest, agent_id, document_json, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				args: [
					input.ref.kind,
					input.ref.ownerPrincipal,
					input.ref.graphId,
					input.ref.objectId,
					input.ref.version,
					input.ref.digest,
					required(input.agentId, "agentId"),
					JSON.stringify(input.document),
					input.createdAt,
				],
			});
		}, "UPSERT_IF_ABSENT");
		return input.ref;
	}

	async getEvidenceObject(ref: MeaningfulObjectRefV1): Promise<EvolutionEvidenceRecord | null> {
		validateMeaningfulObjectRef(ref);
		const result = await this.read({
			sql: `SELECT * FROM evolution_evidence_objects
			       WHERE kind = ? AND owner_principal = ? AND graph_id = ? AND object_id = ?
			         AND version = ? AND digest = ?`,
			args: [ref.kind, ref.ownerPrincipal, ref.graphId, ref.objectId, ref.version, ref.digest],
		});
		const row = result.rows[0];
		if (!row) return null;
		return {
			ref: rowToRef(row, ref.kind),
			agentId: String(row.agent_id),
			document: JSON.parse(String(row.document_json)) as unknown,
			createdAt: Number(row.created_at),
		};
	}

	async getEvidenceObjectById(input: {
		readonly ownerPrincipal: string;
		readonly kind: MeaningfulObjectKind;
		readonly objectId: string;
	}): Promise<EvolutionEvidenceRecord | null> {
		const result = await this.read({
			sql: `SELECT * FROM evolution_evidence_objects
			       WHERE owner_principal = ? AND kind = ? AND object_id = ?
			       ORDER BY created_at DESC, version DESC LIMIT 1`,
			args: [input.ownerPrincipal, input.kind, input.objectId],
		});
		const row = result.rows[0];
		if (!row) return null;
		return {
			ref: rowToRef(row, input.kind),
			agentId: String(row.agent_id),
			document: JSON.parse(String(row.document_json)) as unknown,
			createdAt: Number(row.created_at),
		};
	}

	async putEvidenceBlob(input: {
		readonly ref: MeaningfulObjectRefV1<"artifact">;
		readonly mediaType: string;
		readonly contentDigest: string;
		readonly body: Uint8Array;
		readonly createdAt: number;
	}): Promise<void> {
		validateMeaningfulObjectRef(input.ref, "artifact");
		if (!/^sha256:[0-9a-f]{64}$/.test(input.contentDigest)) throw new Error("evidence blob digest is invalid");
		const actualDigest = `sha256:${createHash("sha256").update(input.body).digest("hex")}`;
		if (actualDigest !== input.contentDigest) throw new Error("evidence blob bytes differ from their content digest");
		await this.tx(async (tx) => {
			const existing = await tx.execute({
				sql: "SELECT media_type, content_digest, body FROM evolution_evidence_blobs WHERE ref_digest = ?",
				args: [input.ref.digest],
			});
			if (existing.rows[0]) {
				const priorBody = Buffer.from(existing.rows[0].body as Uint8Array);
				if (
					String(existing.rows[0].media_type) !== input.mediaType ||
					String(existing.rows[0].content_digest) !== input.contentDigest ||
					!priorBody.equals(Buffer.from(input.body))
				) {
					throw new EvolutionObjectConflictError(input.ref);
				}
				return;
			}
			await tx.execute({
				sql: `INSERT INTO evolution_evidence_blobs
					(ref_digest, owner_principal, media_type, content_digest, body, created_at)
					VALUES (?, ?, ?, ?, ?, ?)`,
				args: [
					input.ref.digest,
					input.ref.ownerPrincipal,
					required(input.mediaType, "mediaType"),
					input.contentDigest,
					input.body,
					input.createdAt,
				],
			});
		}, "UPSERT_IF_ABSENT");
	}

	async getEvidenceBlob(
		ownerPrincipal: string,
		ref: MeaningfulObjectRefV1<"artifact">,
	): Promise<{ readonly mediaType: string; readonly contentDigest: string; readonly body: Uint8Array } | null> {
		validateMeaningfulObjectRef(ref, "artifact");
		if (ref.ownerPrincipal !== ownerPrincipal) return null;
		const result = await this.read({
			sql: `SELECT media_type, content_digest, body FROM evolution_evidence_blobs
			       WHERE ref_digest = ? AND owner_principal = ?`,
			args: [ref.digest, ownerPrincipal],
		});
		const row = result.rows[0];
		if (!row) return null;
		return {
			mediaType: String(row.media_type),
			contentDigest: String(row.content_digest),
			body: row.body as Uint8Array,
		};
	}

	async getEvolutionObjectById(input: {
		readonly ownerPrincipal: string;
		readonly kind: EvolutionObjectKind;
		readonly objectId: string;
		readonly version?: string;
	}): Promise<EvolutionObjectRecord | null> {
		const versionClause = input.version === undefined ? "" : " AND version = ?";
		const args = [input.kind, input.ownerPrincipal, input.objectId];
		if (input.version !== undefined) args.push(input.version);
		const result = await this.read({
			sql: `SELECT * FROM evolution_objects
			       WHERE kind = ? AND owner_principal = ? AND object_id = ?${versionClause}
			       ORDER BY created_at DESC, version DESC LIMIT 1`,
			args,
		});
		return result.rows[0] ? rowToEvolutionObject(result.rows[0]) : null;
	}

	async listEvolutionObjects(input: ListEvolutionObjectsInput): Promise<readonly EvolutionObjectRecord[]> {
		const limit = input.limit ?? 100;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
			throw new Error("evolution object list limit must be between 1 and 500");
		}
		const clauses = ["owner_principal = ?"];
		const args: (string | number)[] = [input.ownerPrincipal];
		if (input.agentId !== undefined) {
			clauses.push("agent_id = ?");
			args.push(input.agentId);
		}
		if (input.kind !== undefined) {
			clauses.push("kind = ?");
			args.push(input.kind);
		}
		args.push(limit);
		const result = await this.read({
			sql: `SELECT * FROM evolution_objects
			       WHERE ${clauses.join(" AND ")}
			       ORDER BY created_at DESC, kind, object_id, version DESC LIMIT ?`,
			args,
		});
		return result.rows.map(rowToEvolutionObject);
	}

	async getCandidateEvaluation(
		candidateRef: MeaningfulObjectRefV1<"embodiment-candidate">,
	): Promise<CandidateEvaluationRecord | null> {
		validateMeaningfulObjectRef(candidateRef, "embodiment-candidate");
		const result = await this.read({
			sql: "SELECT * FROM candidate_evaluations WHERE candidate_digest = ?",
			args: [candidateRef.digest],
		});
		return result.rows[0] ? rowToCandidateEvaluation(result.rows[0]) : null;
	}

	async flushProjectionOutbox(
		sink: EvolutionProjectionSink,
		input: { readonly limit?: number; readonly now?: number } = {},
	): Promise<{ readonly projected: number; readonly failed: number; readonly pending: number }> {
		const limit = input.limit ?? 100;
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("projection limit is invalid");
		const rows = await this.read({
			sql: `SELECT ref_digest, record_json FROM evolution_projection_outbox
			       WHERE projected_at IS NULL ORDER BY enqueued_at, ref_digest LIMIT ?`,
			args: [limit],
		});
		let projected = 0;
		let failed = 0;
		for (const row of rows.rows) {
			const digest = String(row.ref_digest);
			try {
				const record = parseProjectionRecord(row.record_json);
				await sink.publish(record, serializeEvolutionObjectRdf(record));
				await this.write(
					{
						sql: `UPDATE evolution_projection_outbox
						       SET projected_at = ?, attempts = attempts + 1, last_error = NULL
						       WHERE ref_digest = ? AND projected_at IS NULL`,
						args: [input.now ?? Date.now(), digest],
					},
					"CAS",
				);
				projected += 1;
			} catch (error) {
				failed += 1;
				await this.write(
					{
						sql: `UPDATE evolution_projection_outbox
						       SET attempts = attempts + 1, last_error = ?
						       WHERE ref_digest = ? AND projected_at IS NULL`,
						args: [(error instanceof Error ? error.message : String(error)).slice(0, 2_000), digest],
					},
					"UPSERT",
				);
			}
		}
		const pendingResult = await this.read(
			"SELECT COUNT(*) AS count FROM evolution_projection_outbox WHERE projected_at IS NULL",
		);
		return { projected, failed, pending: Number(pendingResult.rows[0]?.count ?? 0) };
	}

	async initializeActiveEmbodiment(input: {
		readonly embodimentRef: MeaningfulObjectRefV1<"embodiment">;
		readonly embodiment: AgentEmbodimentV1;
		readonly now: number;
	}): Promise<AgentEmbodimentHead> {
		validateAgentEmbodiment(input.embodiment);
		assertDocumentRef(input.embodimentRef, input.embodiment);
		return this.tx(async (tx) => {
			const stored = await requireStoredObject(tx, input.embodimentRef);
			validateAgentEmbodiment(stored.document);
			const existing = await selectHead(tx, input.embodiment.ownerPrincipal, input.embodiment.agentId);
			if (existing) {
				if (!sameMeaningfulObjectRef(existing.embodimentRef, input.embodimentRef)) {
					throw new EmbodimentActivationConflictError("Agent already has a different active Embodiment", {
						existing: existing.embodimentRef,
						requested: input.embodimentRef,
					});
				}
				return existing;
			}
			await tx.execute({
				sql: `INSERT INTO agent_embodiment_heads
					(owner_principal, agent_id, graph_id, object_id, version, digest, revision, updated_at)
					VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
				args: [
					input.embodiment.ownerPrincipal,
					input.embodiment.agentId,
					input.embodimentRef.graphId,
					input.embodimentRef.objectId,
					input.embodimentRef.version,
					input.embodimentRef.digest,
					input.now,
				],
			});
			return {
				ownerPrincipal: input.embodiment.ownerPrincipal,
				agentId: input.embodiment.agentId,
				embodimentRef: input.embodimentRef,
				revision: 1,
				updatedAt: input.now,
			};
		}, "UPSERT_IF_ABSENT");
	}

	/**
	 * Rebind an unevolved bootstrap head to the host's current runtime/ontology
	 * snapshot. This is deliberately narrower than activation: it can move only
	 * a bootstrap embodiment with no overlays and no activation history.
	 */
	async rebindBootstrapEmbodiment(input: {
		readonly expectedHead: AgentEmbodimentHead;
		readonly embodimentRef: MeaningfulObjectRefV1<"embodiment">;
		readonly embodiment: AgentEmbodimentV1;
		readonly now: number;
	}): Promise<AgentEmbodimentHead> {
		validateAgentEmbodiment(input.embodiment);
		assertDocumentRef(input.embodimentRef, input.embodiment);
		return this.tx(async (tx) => {
			const head = await selectHead(tx, input.expectedHead.ownerPrincipal, input.expectedHead.agentId);
			if (
				!head ||
				head.revision !== input.expectedHead.revision ||
				!sameMeaningfulObjectRef(head.embodimentRef, input.expectedHead.embodimentRef)
			) {
				throw new EmbodimentActivationConflictError("bootstrap rebind compare-and-swap lost");
			}
			if (!(await isUnevolvedBootstrapHeadTx(tx, head))) {
				throw new EmbodimentActivationConflictError(
					"only an unevolved bootstrap Embodiment can follow a refreshed host binding",
				);
			}
			await requireStoredObject(tx, input.embodimentRef);
			const revision = head.revision + 1;
			const updated = await tx.execute({
				sql: `UPDATE agent_embodiment_heads
				       SET graph_id = ?, object_id = ?, version = ?, digest = ?, revision = ?, updated_at = ?
				       WHERE owner_principal = ? AND agent_id = ? AND digest = ? AND revision = ?`,
				args: [
					input.embodimentRef.graphId,
					input.embodimentRef.objectId,
					input.embodimentRef.version,
					input.embodimentRef.digest,
					revision,
					input.now,
					head.ownerPrincipal,
					head.agentId,
					head.embodimentRef.digest,
					head.revision,
				],
			});
			if (updated.rowsAffected !== 1) {
				throw new EmbodimentActivationConflictError("bootstrap rebind compare-and-swap lost");
			}
			return {
				ownerPrincipal: head.ownerPrincipal,
				agentId: head.agentId,
				embodimentRef: input.embodimentRef,
				revision,
				updatedAt: input.now,
			};
		}, "CAS");
	}

	async getActiveEmbodiment(ownerPrincipal: string, agentId: string): Promise<AgentEmbodimentHead | null> {
		const result = await this.read({
			sql: "SELECT * FROM agent_embodiment_heads WHERE owner_principal = ? AND agent_id = ?",
			args: [ownerPrincipal, agentId],
		});
		return result.rows[0] ? rowToHead(result.rows[0]) : null;
	}

	/**
	 * A bootstrap authored by an older host contract may no longer pass the
	 * current Embodiment validator. It is never execution authority in that
	 * state, but the host may replace the exact digest-bound, overlay-free head
	 * when no activation has ever promoted it.
	 */
	async isRebindableBootstrapEmbodiment(expectedHead: AgentEmbodimentHead): Promise<boolean> {
		return this.tx(async (tx) => {
			const head = await selectHead(tx, expectedHead.ownerPrincipal, expectedHead.agentId);
			if (
				!head ||
				head.revision !== expectedHead.revision ||
				!sameMeaningfulObjectRef(head.embodimentRef, expectedHead.embodimentRef)
			) {
				return false;
			}
			return isUnevolvedBootstrapHeadTx(tx, head);
		}, "CAS");
	}

	async recordCandidateEvaluation(input: {
		readonly candidateRef: MeaningfulObjectRefV1<"embodiment-candidate">;
		readonly verificationRuns: readonly {
			readonly ref: MeaningfulObjectRefV1<"verification-run">;
			readonly run: ExtensionVerificationRunV1;
		}[];
		readonly evaluatedBy: string;
		readonly evaluatedAt: number;
	}): Promise<CandidateEvaluationRecord> {
		return this.tx(async (tx) => {
			const candidateObject = await requireStoredObject(tx, input.candidateRef);
			validateEmbodimentCandidate(candidateObject.document);
			const candidate = candidateObject.document;
			const policyObject = await requireStoredObject(tx, candidate.evaluationPolicyRef);
			validateEvaluationPolicy(policyObject.document);
			const policy = policyObject.document;
			if (!input.evaluatedBy.startsWith("service:") || input.evaluatedBy === candidate.agentId) {
				throw new EmbodimentActivationConflictError(
					"candidate eligibility must be recorded by an independent host service",
				);
			}
			const suppliedRefs = input.verificationRuns.map((item) => item.ref);
			if (!sameReferenceSet(suppliedRefs, candidate.verificationRunRefs)) {
				throw new EmbodimentActivationConflictError(
					"verification testimony differs from the candidate evaluation set",
				);
			}
			let eligible = true;
			for (const item of input.verificationRuns) {
				validateExtensionVerificationRun(item.run);
				const expectedRef = createMeaningfulObjectRef({
					kind: "verification-run",
					ownerPrincipal: item.run.ownerPrincipal,
					graphId: item.ref.graphId,
					objectId: item.run.runId,
					version: item.ref.version,
					value: item.run,
				});
				if (!sameMeaningfulObjectRef(expectedRef, item.ref)) {
					throw new EmbodimentActivationConflictError("verification run ref is not bound to its exact testimony");
				}
				if (
					item.run.ownerPrincipal !== candidate.ownerPrincipal ||
					item.run.agentId !== candidate.agentId ||
					item.run.candidateId !== candidate.candidateId ||
					item.run.candidateRuntimeBindingDigest !== candidate.runtimeBindingDigest ||
					!sameMeaningfulObjectRef(item.run.policyRef, candidate.evaluationPolicyRef) ||
					!candidate.artifactRefs.some((ref) => sameMeaningfulObjectRef(ref, item.run.artifactRef))
				) {
					throw new EmbodimentActivationConflictError("verification run is not bound to the exact candidate");
				}
				if (!item.run.passed || item.run.completedAt > input.evaluatedAt) eligible = false;
			}
			for (const suite of policy.requiredSuites.filter((item) => item.required)) {
				const run = input.verificationRuns.find((item) =>
					sameMeaningfulObjectRef(item.run.suiteRef, suite.suiteRef),
				);
				if (!run) {
					eligible = false;
					continue;
				}
				if (suite.maximumAgeMs !== undefined && input.evaluatedAt - run.run.completedAt > suite.maximumAgeMs) {
					eligible = false;
				}
			}
			if (candidate.status === "eligible" && !eligible) {
				throw new EmbodimentActivationConflictError(
					"candidate claims eligibility but its host testimony fails policy",
				);
			}
			const record: CandidateEvaluationRecord = {
				candidateRef: input.candidateRef,
				ownerPrincipal: candidate.ownerPrincipal,
				agentId: candidate.agentId,
				expectedIncumbentDigest: candidate.expectedIncumbentDigest,
				policyRef: candidate.evaluationPolicyRef,
				evaluationSetDigest: candidate.evaluationSetDigest,
				state: eligible ? "eligible" : "ineligible",
				evaluatedBy: required(input.evaluatedBy, "evaluatedBy"),
				evaluatedAt: input.evaluatedAt,
			};
			const existing = await tx.execute({
				sql: "SELECT * FROM candidate_evaluations WHERE candidate_digest = ?",
				args: [input.candidateRef.digest],
			});
			if (existing.rows[0]) {
				const prior = rowToCandidateEvaluation(existing.rows[0]);
				if (
					prior.evaluationSetDigest !== record.evaluationSetDigest ||
					prior.policyRef.digest !== record.policyRef.digest ||
					prior.state !== record.state
				) {
					throw new EmbodimentActivationConflictError("candidate evaluation conflicts with committed testimony");
				}
				return prior;
			}
			await tx.execute({
				sql: `INSERT INTO candidate_evaluations
					(candidate_digest, candidate_ref_json, owner_principal, agent_id,
					 expected_incumbent_digest, policy_ref_json, evaluation_set_digest,
					 state, evaluated_by, evaluated_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				args: [
					input.candidateRef.digest,
					JSON.stringify(input.candidateRef),
					record.ownerPrincipal,
					record.agentId,
					record.expectedIncumbentDigest,
					JSON.stringify(record.policyRef),
					record.evaluationSetDigest,
					record.state,
					record.evaluatedBy,
					record.evaluatedAt,
				],
			});
			return record;
		}, "UPSERT_IF_ABSENT");
	}

	async commitActivation(input: CommitEmbodimentActivationInput): Promise<{
		readonly activation: EmbodimentActivationV1;
		readonly activationRef: MeaningfulObjectRefV1<"embodiment-activation">;
		readonly head: AgentEmbodimentHead;
	}> {
		if (input.committedBy !== input.ownerPrincipal) {
			throw new EmbodimentActivationConflictError("owner-scoped activation must be committed by its owner");
		}
		return this.tx(async (tx) => {
			const head = await selectHead(tx, input.ownerPrincipal, input.agentId);
			if (!head) throw new EmbodimentActivationConflictError("Agent has no active incumbent Embodiment");
			if (!sameMeaningfulObjectRef(head.embodimentRef, input.expectedIncumbentRef)) {
				throw new EmbodimentActivationConflictError("activation compare-and-swap lost to another generation", {
					expected: input.expectedIncumbentRef,
					actual: head.embodimentRef,
				});
			}

			const candidateObject = await requireStoredObject(tx, input.candidateRef);
			const decisionObject = await requireStoredObject(tx, input.promotionDecisionRef);
			const nextObject = await requireStoredObject(tx, input.nextEmbodimentRef);
			validateEmbodimentCandidate(candidateObject.document);
			validatePromotionDecision(decisionObject.document);
			validateAgentEmbodiment(nextObject.document);
			const candidate = candidateObject.document;
			const decision = decisionObject.document;
			const next = nextObject.document;
			const proposalObject = await requireStoredObject(tx, candidate.proposalRef);
			if (proposalObject.document.schema !== "sophia.evolution-proposal.v1") {
				throw new EmbodimentActivationConflictError("candidate proposal ref does not resolve to a proposal");
			}
			const policyObject = await requireStoredObject(tx, candidate.evaluationPolicyRef);
			validateEvaluationPolicy(policyObject.document);
			validateEmbodimentCandidate(candidate, { proposal: proposalObject.document, embodiment: next });
			validatePromotionDecision(decision, { candidate, policy: policyObject.document });
			assertActivationIdentity(input, candidate, decision, next);
			if (candidate.status !== "eligible" || decision.verdict !== "approved") {
				throw new EmbodimentActivationConflictError("candidate is not approved and eligible");
			}
			if (candidate.expiresAt < input.committedAt || decision.expiresAt < input.committedAt) {
				throw new EmbodimentActivationConflictError("candidate or promotion decision has expired");
			}
			const evaluationResult = await tx.execute({
				sql: "SELECT * FROM candidate_evaluations WHERE candidate_digest = ?",
				args: [input.candidateRef.digest],
			});
			if (!evaluationResult.rows[0]) {
				throw new EmbodimentActivationConflictError("candidate has no independently recorded evaluation verdict");
			}
			const evaluation = rowToCandidateEvaluation(evaluationResult.rows[0]);
			if (
				evaluation.state !== "eligible" ||
				evaluation.evaluationSetDigest !== candidate.evaluationSetDigest ||
				evaluation.policyRef.digest !== candidate.evaluationPolicyRef.digest
			) {
				throw new EmbodimentActivationConflictError("candidate evaluation is stale, ineligible, or quarantined");
			}
			const quarantine = await tx.execute({
				sql: "SELECT embodiment_digest FROM embodiment_quarantine WHERE embodiment_digest = ?",
				args: [input.nextEmbodimentRef.digest],
			});
			if (quarantine.rows[0]) throw new EmbodimentActivationConflictError("next Embodiment is quarantined");

			const transactionRevision = input.mode === "canary-session" ? head.revision : head.revision + 1;
			const activation: EmbodimentActivationV1 = {
				schema: EMBODIMENT_ACTIVATION_SCHEMA,
				activationId: required(input.activationId, "activationId"),
				ownerPrincipal: input.ownerPrincipal,
				agentId: input.agentId,
				expectedIncumbentRef: input.expectedIncumbentRef,
				expectedIncumbentDigest: input.expectedIncumbentRef.digest,
				nextEmbodimentRef: input.nextEmbodimentRef,
				nextEmbodimentDigest: input.nextEmbodimentRef.digest,
				candidateRef: input.candidateRef,
				promotionDecisionRef: input.promotionDecisionRef,
				mode: input.mode,
				rollbackTargetRef: input.expectedIncumbentRef,
				committedBy: input.committedBy,
				committedAt: input.committedAt,
				transactionRevision,
			};
			validateEmbodimentActivation(activation);
			const activationRef = createMeaningfulObjectRef({
				kind: "embodiment-activation",
				ownerPrincipal: input.ownerPrincipal,
				graphId: required(input.graphId, "graphId"),
				objectId: activation.activationId,
				version: required(input.version, "version"),
				value: activation,
			});
			await insertEvolutionObject(tx, {
				ref: activationRef,
				agentId: input.agentId,
				document: activation,
				createdAt: input.committedAt,
			});
			await tx.execute({
				sql: `INSERT INTO embodiment_activations
					(activation_id, activation_ref_json, owner_principal, agent_id,
					 from_digest, to_digest, mode, transaction_revision, committed_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				args: [
					activation.activationId,
					JSON.stringify(activationRef),
					input.ownerPrincipal,
					input.agentId,
					input.expectedIncumbentRef.digest,
					input.nextEmbodimentRef.digest,
					input.mode,
					transactionRevision,
					input.committedAt,
				],
			});

			if (input.mode === "canary-session") {
				await tx.execute({
					sql: `INSERT INTO embodiment_canaries
						(activation_id, owner_principal, agent_id, expected_head_digest,
						 embodiment_ref_json, created_at)
						VALUES (?, ?, ?, ?, ?, ?)`,
					args: [
						activation.activationId,
						input.ownerPrincipal,
						input.agentId,
						head.embodimentRef.digest,
						JSON.stringify(input.nextEmbodimentRef),
						input.committedAt,
					],
				});
				return { activation, activationRef, head };
			}

			const updated = await tx.execute({
				sql: `UPDATE agent_embodiment_heads
					   SET graph_id = ?, object_id = ?, version = ?, digest = ?, revision = ?, updated_at = ?
					 WHERE owner_principal = ? AND agent_id = ? AND digest = ? AND revision = ?`,
				args: [
					input.nextEmbodimentRef.graphId,
					input.nextEmbodimentRef.objectId,
					input.nextEmbodimentRef.version,
					input.nextEmbodimentRef.digest,
					transactionRevision,
					input.committedAt,
					input.ownerPrincipal,
					input.agentId,
					head.embodimentRef.digest,
					head.revision,
				],
			});
			if (updated.rowsAffected !== 1) {
				throw new EmbodimentActivationConflictError("activation compare-and-swap lost during commit");
			}
			await tx.execute({
				sql: `UPDATE candidate_evaluations
					   SET state = 'stale'
					 WHERE owner_principal = ? AND agent_id = ?
					   AND expected_incumbent_digest = ? AND candidate_digest != ?`,
				args: [input.ownerPrincipal, input.agentId, head.embodimentRef.digest, input.candidateRef.digest],
			});
			return {
				activation,
				activationRef,
				head: {
					ownerPrincipal: input.ownerPrincipal,
					agentId: input.agentId,
					embodimentRef: input.nextEmbodimentRef,
					revision: transactionRevision,
					updatedAt: input.committedAt,
				},
			};
		}, "CAS");
	}

	async resolveEmbodiment(input: {
		readonly ownerPrincipal: string;
		readonly agentId: string;
		readonly canaryActivationId?: string;
	}): Promise<AgentEmbodimentHead | null> {
		const head = await this.getActiveEmbodiment(input.ownerPrincipal, input.agentId);
		if (!head || input.canaryActivationId === undefined) return head;
		const canary = await this.read({
			sql: `SELECT * FROM embodiment_canaries
			       WHERE activation_id = ? AND owner_principal = ? AND agent_id = ? AND revoked_at IS NULL`,
			args: [input.canaryActivationId, input.ownerPrincipal, input.agentId],
		});
		if (!canary.rows[0]) return head;
		if (String(canary.rows[0].expected_head_digest) !== head.embodimentRef.digest) return head;
		const embodimentRef = parseRef(canary.rows[0].embodiment_ref_json, "embodiment");
		return { ...head, embodimentRef };
	}

	async commitRollback(input: CommitRollbackInput): Promise<{
		readonly decision: RollbackDecisionV1;
		readonly decisionRef: MeaningfulObjectRefV1<"rollback-decision">;
		readonly head: AgentEmbodimentHead;
	}> {
		if (!input.automatic && input.decidedBy !== input.ownerPrincipal) {
			throw new EmbodimentActivationConflictError("manual rollback must be committed by the owner");
		}
		if (input.decidedBy === input.agentId) {
			throw new EmbodimentActivationConflictError("Agent cannot be sole rollback authority");
		}
		return this.tx(async (tx) => {
			const head = await selectHead(tx, input.ownerPrincipal, input.agentId);
			if (!head) throw new EmbodimentActivationConflictError("Agent has no active Embodiment to roll back");
			const activationObject = await requireStoredObject(tx, input.activationRef);
			validateEmbodimentActivation(activationObject.document);
			const activation = activationObject.document;
			if (
				activation.ownerPrincipal !== input.ownerPrincipal ||
				activation.agentId !== input.agentId ||
				!sameMeaningfulObjectRef(activation.nextEmbodimentRef, head.embodimentRef) ||
				!sameMeaningfulObjectRef(activation.rollbackTargetRef, input.targetEmbodimentRef)
			) {
				throw new EmbodimentActivationConflictError("rollback is not bound to the active transition");
			}
			await requireStoredObject(tx, input.targetEmbodimentRef);
			const transactionRevision = head.revision + 1;
			const decision: RollbackDecisionV1 = {
				schema: ROLLBACK_DECISION_SCHEMA,
				decisionId: required(input.decisionId, "decisionId"),
				ownerPrincipal: input.ownerPrincipal,
				agentId: input.agentId,
				activationRef: input.activationRef,
				fromEmbodimentRef: head.embodimentRef,
				fromEmbodimentDigest: head.embodimentRef.digest,
				toEmbodimentRef: input.targetEmbodimentRef,
				toEmbodimentDigest: input.targetEmbodimentRef.digest,
				evidenceRefs: input.evidenceRefs,
				decidedBy: input.decidedBy,
				automatic: input.automatic,
				reason: required(input.reason, "reason"),
				decidedAt: input.decidedAt,
				transactionRevision,
			};
			validateRollbackDecision(decision);
			const decisionRef = createMeaningfulObjectRef({
				kind: "rollback-decision",
				ownerPrincipal: input.ownerPrincipal,
				graphId: required(input.graphId, "graphId"),
				objectId: decision.decisionId,
				version: required(input.version, "version"),
				value: decision,
			});
			await insertEvolutionObject(tx, {
				ref: decisionRef,
				agentId: input.agentId,
				document: decision,
				createdAt: input.decidedAt,
			});
			const updated = await tx.execute({
				sql: `UPDATE agent_embodiment_heads
					   SET graph_id = ?, object_id = ?, version = ?, digest = ?, revision = ?, updated_at = ?
					 WHERE owner_principal = ? AND agent_id = ? AND digest = ? AND revision = ?`,
				args: [
					input.targetEmbodimentRef.graphId,
					input.targetEmbodimentRef.objectId,
					input.targetEmbodimentRef.version,
					input.targetEmbodimentRef.digest,
					transactionRevision,
					input.decidedAt,
					input.ownerPrincipal,
					input.agentId,
					head.embodimentRef.digest,
					head.revision,
				],
			});
			if (updated.rowsAffected !== 1) throw new EmbodimentActivationConflictError("rollback compare-and-swap lost");
			await tx.execute({
				sql: `INSERT INTO rollback_decisions
					(decision_id, decision_ref_json, owner_principal, agent_id,
					 from_digest, to_digest, transaction_revision, decided_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				args: [
					decision.decisionId,
					JSON.stringify(decisionRef),
					input.ownerPrincipal,
					input.agentId,
					head.embodimentRef.digest,
					input.targetEmbodimentRef.digest,
					transactionRevision,
					input.decidedAt,
				],
			});
			if (input.quarantineCurrent) {
				await tx.execute({
					sql: `INSERT INTO embodiment_quarantine
						(embodiment_digest, owner_principal, agent_id, decision_ref_json, quarantined_at)
						VALUES (?, ?, ?, ?, ?)
						ON CONFLICT(embodiment_digest) DO NOTHING`,
					args: [
						head.embodimentRef.digest,
						input.ownerPrincipal,
						input.agentId,
						JSON.stringify(decisionRef),
						input.decidedAt,
					],
				});
				await tx.execute({
					sql: "UPDATE candidate_evaluations SET state = 'quarantined' WHERE candidate_digest = ?",
					args: [activation.candidateRef.digest],
				});
			}
			return {
				decision,
				decisionRef,
				head: {
					ownerPrincipal: input.ownerPrincipal,
					agentId: input.agentId,
					embodimentRef: input.targetEmbodimentRef,
					revision: transactionRevision,
					updatedAt: input.decidedAt,
				},
			};
		}, "CAS");
	}
}

async function insertEvolutionObject(tx: Transaction, record: EvolutionObjectRecord): Promise<void> {
	const existing = await tx.execute({
		sql: `SELECT * FROM evolution_objects
		       WHERE kind = ? AND owner_principal = ? AND graph_id = ? AND object_id = ? AND version = ?`,
		args: [record.ref.kind, record.ref.ownerPrincipal, record.ref.graphId, record.ref.objectId, record.ref.version],
	});
	if (existing.rows[0]) {
		const prior = rowToEvolutionObject(existing.rows[0]);
		if (prior.ref.digest !== record.ref.digest) throw new EvolutionObjectConflictError(record.ref);
		await enqueueEvolutionProjection(tx, prior);
		return;
	}
	await tx.execute({
		sql: `INSERT INTO evolution_objects
			(kind, owner_principal, graph_id, object_id, version, digest, agent_id, document_json, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [
			record.ref.kind,
			record.ref.ownerPrincipal,
			record.ref.graphId,
			record.ref.objectId,
			record.ref.version,
			record.ref.digest,
			record.agentId,
			JSON.stringify(record.document),
			record.createdAt,
		],
	});
	await enqueueEvolutionProjection(tx, record);
}

async function enqueueEvolutionProjection(tx: Transaction, record: EvolutionObjectRecord): Promise<void> {
	await tx.execute({
		sql: `INSERT INTO evolution_projection_outbox(ref_digest, record_json, enqueued_at)
		       VALUES (?, ?, ?) ON CONFLICT(ref_digest) DO NOTHING`,
		args: [record.ref.digest, JSON.stringify(record), record.createdAt],
	});
}

async function requireStoredObject(tx: Transaction, ref: MeaningfulObjectRefV1): Promise<EvolutionObjectRecord> {
	if (!isEvolutionKind(ref.kind)) {
		throw new EmbodimentActivationConflictError(`'${ref.kind}' is not stored by the evolution authority`);
	}
	const result = await tx.execute({
		sql: `SELECT * FROM evolution_objects
		       WHERE kind = ? AND owner_principal = ? AND graph_id = ?
		         AND object_id = ? AND version = ? AND digest = ?`,
		args: [ref.kind, ref.ownerPrincipal, ref.graphId, ref.objectId, ref.version, ref.digest],
	});
	if (!result.rows[0]) {
		throw new EmbodimentActivationConflictError(`required evolution object '${ref.kind}:${ref.objectId}' is absent`);
	}
	return rowToEvolutionObject(result.rows[0]);
}

async function selectHead(
	tx: Transaction,
	ownerPrincipal: string,
	agentId: string,
): Promise<AgentEmbodimentHead | null> {
	const result = await tx.execute({
		sql: "SELECT * FROM agent_embodiment_heads WHERE owner_principal = ? AND agent_id = ?",
		args: [ownerPrincipal, agentId],
	});
	return result.rows[0] ? rowToHead(result.rows[0]) : null;
}

async function isUnevolvedBootstrapHeadTx(tx: Transaction, head: AgentEmbodimentHead): Promise<boolean> {
	const result = await tx.execute({
		sql: `SELECT * FROM evolution_objects
		       WHERE kind = 'embodiment' AND owner_principal = ? AND graph_id = ?
		         AND object_id = ? AND version = ? AND digest = ?`,
		args: [
			head.embodimentRef.ownerPrincipal,
			head.embodimentRef.graphId,
			head.embodimentRef.objectId,
			head.embodimentRef.version,
			head.embodimentRef.digest,
		],
	});
	const row = result.rows[0];
	if (!row) return false;
	let document: unknown;
	try {
		document = JSON.parse(String(row.document_json));
	} catch {
		return false;
	}
	if (!document || typeof document !== "object" || Array.isArray(document)) return false;
	const candidate = document as Record<string, unknown>;
	if (
		candidate.schema !== "sophia.agent-embodiment.v1" ||
		candidate.ownerPrincipal !== head.ownerPrincipal ||
		candidate.agentId !== head.agentId ||
		candidate.embodimentId !== head.embodimentRef.objectId ||
		typeof candidate.embodimentId !== "string" ||
		!candidate.embodimentId.startsWith("embodiment-bootstrap-")
	) {
		return false;
	}
	const runtime = candidate.runtimeBinding;
	if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return false;
	const runtimeRecord = runtime as Record<string, unknown>;
	if (
		runtimeRecord.schema !== "choreograph.agent-runtime-binding.v2" ||
		runtimeRecord.kind !== "prime" ||
		!Array.isArray(runtimeRecord.overlays) ||
		runtimeRecord.overlays.length !== 0
	) {
		return false;
	}
	const expectedRef = createMeaningfulObjectRef({
		kind: "embodiment",
		ownerPrincipal: head.embodimentRef.ownerPrincipal,
		graphId: head.embodimentRef.graphId,
		objectId: head.embodimentRef.objectId,
		version: head.embodimentRef.version,
		value: document,
	});
	if (expectedRef.digest !== head.embodimentRef.digest) return false;
	const priorActivation = await tx.execute({
		sql: `SELECT 1 FROM embodiment_activations
		       WHERE owner_principal = ? AND agent_id = ? AND to_digest = ? LIMIT 1`,
		args: [head.ownerPrincipal, head.agentId, head.embodimentRef.digest],
	});
	return priorActivation.rows.length === 0;
}

function rowToEvolutionObject(row: Row): EvolutionObjectRecord {
	const kind = String(row.kind);
	if (!isEvolutionKind(kind)) throw new Error(`stored evolution object has unsupported kind '${kind}'`);
	const document = JSON.parse(String(row.document_json)) as unknown;
	validateEvolutionDocument(kind, document);
	const ref: MeaningfulObjectRefV1<EvolutionObjectKind> = {
		schema: "sophia.meaningful-object-ref.v1",
		kind,
		ownerPrincipal: String(row.owner_principal),
		graphId: String(row.graph_id),
		objectId: String(row.object_id),
		version: String(row.version),
		digest: String(row.digest),
	};
	validateMeaningfulObjectRef(ref, kind);
	assertDocumentRef(ref, document);
	return {
		ref,
		agentId: row.agent_id === null ? null : String(row.agent_id),
		document,
		createdAt: Number(row.created_at),
	};
}

function rowToRef<Kind extends MeaningfulObjectKind>(row: Row, kind: Kind): MeaningfulObjectRefV1<Kind> {
	const ref: MeaningfulObjectRefV1<Kind> = {
		schema: "sophia.meaningful-object-ref.v1",
		kind,
		ownerPrincipal: String(row.owner_principal),
		graphId: String(row.graph_id),
		objectId: String(row.object_id),
		version: String(row.version),
		digest: String(row.digest),
	};
	validateMeaningfulObjectRef(ref, kind);
	return ref;
}

function rowToHead(row: Row): AgentEmbodimentHead {
	const embodimentRef: MeaningfulObjectRefV1<"embodiment"> = {
		schema: "sophia.meaningful-object-ref.v1",
		kind: "embodiment",
		ownerPrincipal: String(row.owner_principal),
		graphId: String(row.graph_id),
		objectId: String(row.object_id),
		version: String(row.version),
		digest: String(row.digest),
	};
	validateMeaningfulObjectRef(embodimentRef, "embodiment");
	return {
		ownerPrincipal: String(row.owner_principal),
		agentId: String(row.agent_id),
		embodimentRef,
		revision: Number(row.revision),
		updatedAt: Number(row.updated_at),
	};
}

function rowToCandidateEvaluation(row: Row): CandidateEvaluationRecord {
	const state = String(row.state);
	if (!new Set(["eligible", "ineligible", "stale", "quarantined"]).has(state)) {
		throw new Error(`stored candidate evaluation has invalid state '${state}'`);
	}
	return {
		candidateRef: parseRef(row.candidate_ref_json, "embodiment-candidate"),
		ownerPrincipal: String(row.owner_principal),
		agentId: String(row.agent_id),
		expectedIncumbentDigest: String(row.expected_incumbent_digest),
		policyRef: parseRef(row.policy_ref_json, "evaluation-policy"),
		evaluationSetDigest: String(row.evaluation_set_digest),
		state: state as CandidateEvaluationRecord["state"],
		evaluatedBy: String(row.evaluated_by),
		evaluatedAt: Number(row.evaluated_at),
	};
}

function parseRef<Kind extends EvolutionObjectKind>(value: unknown, kind: Kind): MeaningfulObjectRefV1<Kind> {
	const parsed = JSON.parse(String(value)) as unknown;
	validateMeaningfulObjectRef(parsed, kind);
	return parsed as MeaningfulObjectRefV1<Kind>;
}

function parseProjectionRecord(value: unknown): EvolutionObjectRecord {
	const parsed = JSON.parse(String(value)) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("projection outbox record is invalid");
	}
	const record = parsed as Record<string, unknown>;
	validateMeaningfulObjectRef(record.ref);
	const ref = record.ref as MeaningfulObjectRefV1;
	if (!isEvolutionKind(ref.kind)) throw new Error("projection outbox kind is invalid");
	validateEvolutionDocument(ref.kind, record.document);
	assertDocumentRef(ref, record.document);
	if (record.agentId !== null && typeof record.agentId !== "string") {
		throw new Error("projection outbox Agent identity is invalid");
	}
	if (typeof record.createdAt !== "number" || !Number.isSafeInteger(record.createdAt)) {
		throw new Error("projection outbox timestamp is invalid");
	}
	return {
		ref: ref as MeaningfulObjectRefV1<EvolutionObjectKind>,
		agentId: record.agentId as string | null,
		document: record.document,
		createdAt: record.createdAt,
	};
}

function assertDocumentRef(ref: MeaningfulObjectRefV1, document: EvolutionDocumentV1): void {
	const identity = documentIdentity(document);
	if (
		ref.ownerPrincipal !== identity.ownerPrincipal ||
		ref.objectId !== documentId(ref.kind as EvolutionObjectKind, document)
	) {
		throw new EmbodimentActivationConflictError("Meaningful Object ref identity differs from its document");
	}
	const expected = createMeaningfulObjectRef({
		kind: ref.kind,
		ownerPrincipal: ref.ownerPrincipal,
		graphId: ref.graphId,
		objectId: ref.objectId,
		version: ref.version,
		value: document,
	});
	if (expected.digest !== ref.digest) {
		throw new EmbodimentActivationConflictError("Meaningful Object ref digest differs from its document");
	}
}

function assertActivationIdentity(
	input: CommitEmbodimentActivationInput,
	candidate: EmbodimentCandidateV1,
	decision: PromotionDecisionV1,
	next: AgentEmbodimentV1,
): void {
	if (
		candidate.ownerPrincipal !== input.ownerPrincipal ||
		candidate.agentId !== input.agentId ||
		decision.ownerPrincipal !== input.ownerPrincipal ||
		decision.agentId !== input.agentId ||
		next.ownerPrincipal !== input.ownerPrincipal ||
		next.agentId !== input.agentId
	) {
		throw new EmbodimentActivationConflictError("activation objects cross an owner or Agent boundary");
	}
	if (
		!sameMeaningfulObjectRef(candidate.expectedIncumbent, input.expectedIncumbentRef) ||
		!sameMeaningfulObjectRef(candidate.embodimentRef, input.nextEmbodimentRef) ||
		!sameMeaningfulObjectRef(decision.candidateRef, input.candidateRef)
	) {
		throw new EmbodimentActivationConflictError("activation is not bound to the exact candidate generation");
	}
	if (next.predecessorRef && !sameMeaningfulObjectRef(next.predecessorRef, input.expectedIncumbentRef)) {
		throw new EmbodimentActivationConflictError("next Embodiment predecessor differs from incumbent");
	}
	if (!next.rollbackTargetRef || !sameMeaningfulObjectRef(next.rollbackTargetRef, input.expectedIncumbentRef)) {
		throw new EmbodimentActivationConflictError("next Embodiment does not preserve the exact rollback target");
	}
}

function documentIdentity(document: EvolutionDocumentV1): { ownerPrincipal: string; agentId: string | null } {
	if (document.schema === "sophia.agent-evaluation-policy.v1") {
		return { ownerPrincipal: document.ownerPrincipal, agentId: null };
	}
	return { ownerPrincipal: document.ownerPrincipal, agentId: document.agentId };
}

function documentId(kind: EvolutionObjectKind, document: EvolutionDocumentV1): string {
	switch (kind) {
		case "embodiment":
			validateAgentEmbodiment(document);
			return document.embodimentId;
		case "evolution-proposal":
			if (document.schema !== "sophia.evolution-proposal.v1") break;
			return document.proposalId;
		case "embodiment-candidate":
			validateEmbodimentCandidate(document);
			return document.candidateId;
		case "evaluation-policy":
			validateEvaluationPolicy(document);
			return document.policyId;
		case "promotion-decision":
			validatePromotionDecision(document);
			return document.decisionId;
		case "embodiment-activation":
			validateEmbodimentActivation(document);
			return document.activationId;
		case "rollback-decision":
			validateRollbackDecision(document);
			return document.decisionId;
	}
	throw new Error(`evolution document schema does not match kind '${kind}'`);
}

function isEvolutionKind(value: string): value is EvolutionObjectKind {
	return new Set([
		"embodiment",
		"evolution-proposal",
		"embodiment-candidate",
		"evaluation-policy",
		"promotion-decision",
		"embodiment-activation",
		"rollback-decision",
	]).has(value);
}

function sameReferenceSet(left: readonly MeaningfulObjectRefV1[], right: readonly MeaningfulObjectRefV1[]): boolean {
	if (left.length !== right.length) return false;
	const keys = (values: readonly MeaningfulObjectRefV1[]) =>
		values
			.map((value) =>
				[value.kind, value.ownerPrincipal, value.graphId, value.objectId, value.version, value.digest].join(
					"\u0000",
				),
			)
			.sort();
	const leftKeys = keys(left);
	const rightKeys = keys(right);
	return leftKeys.every((value, index) => value === rightKeys[index]);
}

function required(value: string, label: string): string {
	if (value.trim().length === 0) throw new EmbodimentActivationConflictError(`${label} is required`);
	return value;
}
