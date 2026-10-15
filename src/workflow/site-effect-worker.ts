/**
 * Durable host edge for the generic `site` capability.
 *
 * This deliberately follows Phanes's Discord worker rather than treating RDF
 * intent as executable authority. The sandbox proposes. Choreograph leases the
 * proposal, rereads the exact steward grant, binds the committed source-turn
 * target, asks Garden to validate/materialize graph projections, and finally
 * asks Platform to materialize routing state. No credential enters a sandbox.
 */

import { createHash } from "node:crypto";
import {
	type CaptureEmitter,
	type CaptureOutcome,
	emitCaptureSoft,
	type SiteLifecyclePayload,
} from "../observatory-capture.js";
import {
	type AgentToolGrantV1,
	assertGrantActive,
	effectApprovalPolicyFor,
	findGrantedCapability,
	grantDigest,
	parseAgentToolGrant,
} from "./agent-tool-grant.js";
import { stableJson } from "./agent-tool-manifest.js";
import {
	type DomainSourceTurnV1,
	domainSourceTurnDigest,
	domainTriggerDigest,
	parseDomainSourceTurn,
} from "./domain-source-turn.js";
import type { GenericIngestRequest, GenericProjectionRecord } from "./emporium-ingest.js";
import { type GraphWriter, unwrapAuthoredJsonDocument } from "./graph-writer.js";
import {
	type CommittedSiteTarget,
	type EffectApprovalV1,
	type ProposedEffectV1,
	parseCommittedSiteTarget,
	parseProposedEffect,
	proposedEffectDigest,
	proposedEffectExecutionDigest,
} from "./proposed-effect.js";
import type { EffectHandoffRecord, WorkflowRuntimeStore } from "./runtime-store.js";

export const SITE_MATERIALIZATION_SCHEMA = "sophia.site-materialization.v1" as const;
export const SITE_EFFECT_COMPLETION_SCHEMA = "sophia.site-effect-completion.v1" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const USER_PRINCIPAL = /^user:[A-Za-z0-9_.@:-]{1,192}$/;
const SITE_OPERATIONS = new Set(["mint", "update", "publish", "retire"]);
const AGENT_MUTABLE_SITE_RECORDS = new Set(["Surface", "Route", "Theme"]);

export interface ReviewedSiteBundleV1 {
	readonly bundleId: string;
	readonly bundleVersion: string;
	readonly packageName: string;
	readonly version: string;
	readonly layoutSeedSha256: string;
	readonly emporiumPackName: "shrubbery-site";
	readonly emporiumPackVersion: string;
	readonly emporiumPackSha256: string;
}

export const REVIEWED_GARDEN_SITE_BUNDLE: ReviewedSiteBundleV1 = Object.freeze({
	bundleId: "garden",
	bundleVersion: "0.1.0-local",
	packageName: "@shrubbery/planter",
	version: "0.0.0",
	layoutSeedSha256: "c00aa0a84a386ea02046d43e614d2cff3d04170636c18a9731e9fe543a606cd1",
	emporiumPackName: "shrubbery-site",
	emporiumPackVersion: "0.2.1",
	emporiumPackSha256: "22a1159852508fd6099dbea5a6ea082d3ae32d25a4862a769627b738d96b72c8",
});

export interface SiteInterpreterWitnessV1 {
	readonly packageName: string;
	readonly version: string;
	readonly bundleId: string;
	readonly bundleVersion: string;
	readonly layoutSeedSha256: string;
	readonly siteDefinitionIri: string;
	readonly siteDefinitionDigest: string;
}

export interface SiteMaterializationRequestV1 {
	readonly schema: typeof SITE_MATERIALIZATION_SCHEMA;
	readonly operation: "mint" | "update" | "publish" | "retire";
	readonly effectIndex: number;
	readonly proposalDigest: string;
	readonly executionDigest: string;
	readonly sourceTurnDigest: string;
	readonly sourceTurn: DomainSourceTurnV1;
	readonly trigger: Readonly<Record<string, unknown>>;
	readonly proposal: ProposedEffectV1;
	readonly route: CommittedSiteTarget;
	readonly interpreter: SiteInterpreterWitnessV1;
	readonly grant: {
		readonly grantId: string;
		readonly grantDigest: string;
		readonly authorityOwnerPrincipal: string;
		readonly authorityGraphId: string;
	};
	readonly approval?: {
		readonly approvedBy: string;
		readonly approvedAt: number;
		readonly proposalDigest: string;
		readonly grantId: string;
	};
}

export interface SiteEffectCompletionV1 {
	readonly schema: typeof SITE_EFFECT_COMPLETION_SCHEMA;
	readonly idempotencyKey: string;
	readonly operation: SiteMaterializationRequestV1["operation"];
	readonly route: CommittedSiteTarget;
	readonly interpreter: SiteInterpreterWitnessV1;
	readonly materialization: unknown;
}

export interface ValidatedSiteHandoff {
	readonly record: EffectHandoffRecord;
	readonly sourceTurn: DomainSourceTurnV1;
	readonly trigger: Readonly<Record<string, unknown>>;
	readonly proposal: ProposedEffectV1;
	readonly target: CommittedSiteTarget;
	readonly operation: SiteMaterializationRequestV1["operation"];
	readonly approval?: EffectApprovalV1;
}

export interface VerifiedSiteGrant {
	readonly grant: AgentToolGrantV1;
	readonly digest: string;
}

export class SiteEffectError extends Error {
	constructor(
		readonly code: string,
		readonly retryable: boolean,
		message = code,
	) {
		super(message);
		this.name = "SiteEffectError";
	}
}

export interface SiteEffectHost {
	/** Publicly safe gateway origin recorded as ContentSource testimony. */
	readonly siteSourceEndpoint?: string;
	readGrant(record: EffectHandoffRecord): Promise<string>;
	ensureGraph(input: {
		readonly ownerPrincipal: string;
		readonly graphId: string;
		readonly title: string;
		readonly description: string;
		readonly idempotencyKey: string;
	}): Promise<unknown>;
	targetGraph(target: CommittedSiteTarget): Promise<GraphWriter>;
	routeRegistryGraph(record: EffectHandoffRecord): Promise<{ graphId: string; writer: GraphWriter }>;
	materialize(ownerPrincipal: string, request: SiteMaterializationRequestV1): Promise<unknown>;
	close?(): Promise<void>;
}

/** Recompute every host-owned identity before touching a credentialed adapter. */
export function validateSiteHandoff(record: EffectHandoffRecord): ValidatedSiteHandoff {
	if (
		!record.source_turn_id ||
		!record.source_turn_digest ||
		!record.source_owner_principal ||
		!SHA256.test(record.source_turn_digest)
	) {
		throw terminal("source-turn-witness-missing");
	}
	let sourceTurn: DomainSourceTurnV1;
	try {
		sourceTurn = parseDomainSourceTurn(record.source_turn);
	} catch (error) {
		throw terminal("source-turn-invalid", error);
	}
	if (
		sourceTurn.turnId !== record.source_turn_id ||
		domainSourceTurnDigest(sourceTurn) !== record.source_turn_digest ||
		sourceTurn.target.graphId !== record.graph_id ||
		sourceTurn.target.ownerPrincipal !== record.source_owner_principal ||
		sourceTurn.agentId !== record.agent_id ||
		sourceTurn.actorRef !== record.actor_ref
	) {
		throw terminal("source-turn-authority-mismatch");
	}
	if (!isRecord(record.trigger) || domainTriggerDigest(record.trigger) !== sourceTurn.triggerDigest) {
		throw terminal("trigger-witness-mismatch");
	}
	if (record.capability !== "site" || !SITE_OPERATIONS.has(record.operation)) {
		throw terminal("site-operation-invalid");
	}
	let proposal: ProposedEffectV1;
	try {
		proposal = parseProposedEffect(record.proposal);
	} catch (error) {
		throw terminal("site-proposal-invalid", error);
	}
	if (
		proposal.capability !== "site" ||
		proposal.operation !== record.operation ||
		proposedEffectExecutionDigest(proposal) !== record.execution_digest
	) {
		throw terminal("site-proposal-witness-mismatch");
	}
	const expectedKey = `effect:${sha256({ sourceTurnId: sourceTurn.turnId, effectIndex: record.effect_index })}`;
	if (record.idempotency_key !== expectedKey || proposal.idempotencyKey !== expectedKey) {
		throw terminal("site-effect-identity-mismatch");
	}
	let target: CommittedSiteTarget;
	try {
		target = parseCommittedSiteTarget(record.trigger);
	} catch (error) {
		throw terminal("site-target-invalid", error);
	}
	if (target.ownerPrincipal !== sourceTurn.target.ownerPrincipal) {
		throw terminal("site-target-owner-mismatch");
	}
	for (const [field, expected] of Object.entries(target)) {
		if (proposal.arguments[field] !== expected) throw terminal(`site-target-${field}-mismatch`);
	}
	const approval = parseApproval(record.approval, proposal, record);
	if ((record.operation === "publish" || record.operation === "retire") && !approval) {
		throw terminal("site-human-approval-required");
	}
	return {
		record,
		sourceTurn,
		trigger: record.trigger,
		proposal,
		target,
		operation: record.operation as ValidatedSiteHandoff["operation"],
		...(approval ? { approval } : {}),
	};
}

/** Phanes-standard current-grant check: current bytes must equal the witness. */
export async function verifyCurrentSiteGrant(
	host: SiteEffectHost,
	handoff: ValidatedSiteHandoff,
	now = Date.now(),
): Promise<VerifiedSiteGrant> {
	let raw: string;
	try {
		raw = await host.readGrant(handoff.record);
	} catch (error) {
		throw retryable("grant-unavailable", error);
	}
	let grant: AgentToolGrantV1;
	try {
		grant = parseAgentToolGrant(JSON.parse(unwrapAuthoredJsonDocument(raw)) as unknown);
	} catch (error) {
		throw terminal("grant-malformed", error);
	}
	const digest = grantDigest(grant);
	if (digest !== handoff.record.grant_digest) throw terminal("grant-digest-changed");
	if (
		grant.grantId !== handoff.record.grant_id ||
		grant.authorityGraphId !== handoff.record.grant_authority_graph_id
	) {
		throw terminal("grant-witness-mismatch");
	}
	try {
		assertGrantActive(grant, handoff.record.agent_id, now);
	} catch (error) {
		throw terminal("grant-inactive", error);
	}
	const capability = findGrantedCapability(grant, "site", handoff.operation);
	if (!capability || capability.access !== "write") throw terminal("grant-operation-denied");
	const fence = capability.fence;
	if (
		fence.graphIds?.length &&
		!fence.graphIds.includes(handoff.target.graphId) &&
		!fence.graphIdPrefixes?.some((prefix) => handoff.target.graphId.startsWith(prefix))
	) {
		throw terminal("grant-graph-denied");
	}
	if (
		fence.graphIdPrefixes?.length &&
		!fence.graphIds?.includes(handoff.target.graphId) &&
		!fence.graphIdPrefixes.some((prefix) => handoff.target.graphId.startsWith(prefix))
	) {
		throw terminal("grant-graph-denied");
	}
	if (
		fence.resourcePrefixes?.length &&
		!fence.resourcePrefixes.some((prefix) => handoff.target.publicName.startsWith(prefix))
	) {
		throw terminal("grant-resource-denied");
	}
	if (
		fence.pathPrefixes?.length &&
		!fence.pathPrefixes.some((prefix) => handoff.target.pathPrefix.startsWith(prefix))
	) {
		throw terminal("grant-path-denied");
	}
	if (
		fence.maxPayloadBytes !== undefined &&
		Buffer.byteLength(stableJson(handoff.proposal.arguments)) > fence.maxPayloadBytes
	) {
		throw terminal("grant-payload-denied");
	}
	const policy = effectApprovalPolicyFor(capability, handoff.operation);
	if (
		(policy === "human-always" || handoff.operation === "publish" || handoff.operation === "retire") &&
		!handoff.approval
	) {
		throw terminal("site-human-approval-required");
	}
	if (handoff.approval && handoff.approval.approvedAt > now) throw terminal("site-approval-from-future");
	return { grant, digest };
}

export class SiteEffectExecutor {
	constructor(
		private readonly host: SiteEffectHost,
		private readonly bundle: ReviewedSiteBundleV1 = REVIEWED_GARDEN_SITE_BUNDLE,
	) {
		validateReviewedBundle(bundle);
	}

	async execute(handoff: ValidatedSiteHandoff, grant: VerifiedSiteGrant): Promise<SiteEffectCompletionV1> {
		if (handoff.operation === "mint") {
			const title =
				optionalBoundedText(handoff.proposal.arguments.title, "arguments.title", 128) ?? handoff.target.publicName;
			await this.host.ensureGraph({
				ownerPrincipal: handoff.target.ownerPrincipal,
				graphId: handoff.target.graphId,
				title,
				description: `Sophia site graph; materialized by ${handoff.record.idempotency_key}`,
				idempotencyKey: handoff.record.idempotency_key,
			});
		}

		const targetGraph = await this.host.targetGraph(handoff.target);
		if (handoff.operation === "mint") {
			await applyEmporium(
				targetGraph,
				handoff.target.graphId,
				siteSeedRequest(handoff.target, this.bundle, this.host.siteSourceEndpoint),
				"site-seed",
			);
		} else if (handoff.operation === "update") {
			const request = siteUpdateRequest(handoff.proposal.arguments.records);
			await applyEmporium(targetGraph, handoff.target.graphId, request, "site-update");
		}

		const interpreter = await resolveSiteInterpreter(targetGraph, handoff.target.graphId, this.bundle);
		if (handoff.operation !== "update") {
			const registry = await this.host.routeRegistryGraph(handoff.record);
			await applyEmporium(
				registry.writer,
				registry.graphId,
				routeIntentRequest(handoff, interpreter),
				"site-route-intent",
			);
		}
		const request = materializationRequest(handoff, grant, interpreter);
		const materialization = await this.host.materialize(handoff.target.ownerPrincipal, request);
		return {
			schema: SITE_EFFECT_COMPLETION_SCHEMA,
			idempotencyKey: handoff.record.idempotency_key,
			operation: handoff.operation,
			route: handoff.target,
			interpreter,
			materialization,
		};
	}
}

export class SiteEffectWorker {
	private timer: ReturnType<typeof setInterval> | undefined;
	private active: Promise<boolean> | undefined;
	private closed = false;

	constructor(
		private readonly runtime: WorkflowRuntimeStore,
		private readonly host: SiteEffectHost,
		private readonly executor = new SiteEffectExecutor(host),
		private readonly options: {
			readonly consumer?: string;
			readonly pollMs?: number;
			readonly leaseMs?: number;
			readonly now?: () => number;
			readonly capture?: CaptureEmitter;
			readonly log?: (message: string, error?: unknown) => void;
		} = {},
	) {}

	start(): void {
		if (this.timer || this.closed) return;
		const pollMs = positiveInteger(this.options.pollMs ?? 1_000, "site effect poll interval");
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
		const startedAt = now;
		const consumer = this.options.consumer ?? "choreograph-site-edge";
		const record = await this.runtime.claimEffectHandoff({
			consumer,
			capabilities: ["site"],
			leaseMs: positiveInteger(this.options.leaseMs ?? 60_000, "site effect lease"),
			now,
		});
		if (!record) return false;
		let handoff: ValidatedSiteHandoff | undefined;
		try {
			handoff = validateSiteHandoff(record);
			const grant = await verifyCurrentSiteGrant(this.host, handoff, this.options.now?.() ?? Date.now());
			const completion = await this.executor.execute(handoff, grant);
			await this.runtime.completeEffectHandoff({
				idempotencyKey: record.idempotency_key,
				consumer,
				claimToken: requiredClaimToken(record),
				outcome: "executed",
				completion,
				now: this.options.now?.() ?? Date.now(),
			});
			emitSiteEffectTestimony({
				capture: this.options.capture,
				handoff,
				outcome: "ok",
				durationMs: elapsed(startedAt, this.options.now?.() ?? Date.now()),
				interpreterDigest: completion.interpreter.siteDefinitionDigest,
			});
		} catch (error) {
			const failure = error instanceof SiteEffectError ? error : retryable("site-host-failure", error);
			try {
				await this.runtime.completeEffectHandoff({
					idempotencyKey: record.idempotency_key,
					consumer,
					claimToken: requiredClaimToken(record),
					outcome: failure.retryable ? "failed-retryable" : "failed-terminal",
					completion: { schema: SITE_EFFECT_COMPLETION_SCHEMA, code: failure.code },
					...(failure.retryable ? { retryAfterMs: retryDelay(record.attempt) } : {}),
					now: this.options.now?.() ?? Date.now(),
				});
				if (handoff) {
					emitSiteEffectTestimony({
						capture: this.options.capture,
						handoff,
						outcome: failure.retryable ? "timeout" : "error",
						durationMs: elapsed(startedAt, this.options.now?.() ?? Date.now()),
						reasonCode: failure.code,
					});
				}
			} catch (completionError) {
				this.options.log?.("site effect completion could not be persisted", completionError);
			}
		}
		return true;
	}

	private schedule(): void {
		if (this.closed || this.active) return;
		this.active = this.runOnce()
			.catch((error) => this.options.log?.("site effect worker recovered from a poll failure", error))
			.then(() => true)
			.finally(() => {
				this.active = undefined;
			});
	}
}

/**
 * Emit only host-validated, content-free lifecycle testimony. A successful
 * mint/publish/retire also changes the durable route projection, so it emits
 * the corresponding `site.route` witness after the operation witness. An
 * update is represented by `site.route` alone.
 */
export function emitSiteEffectTestimony(input: {
	readonly capture?: CaptureEmitter;
	readonly handoff: ValidatedSiteHandoff;
	readonly outcome: CaptureOutcome;
	readonly durationMs: number;
	readonly interpreterDigest?: string;
	readonly reasonCode?: string;
}): void {
	if (!input.capture) return;
	const payload: SiteLifecyclePayload = {
		effectKey: input.handoff.record.idempotency_key,
		sourceTurnDigest: domainSourceTurnDigest(input.handoff.sourceTurn),
		proposalDigest: proposedEffectDigest(input.handoff.proposal),
		executionDigest: proposedEffectExecutionDigest(input.handoff.proposal),
		grantDigest: input.handoff.record.grant_digest,
		publicName: input.handoff.target.publicName,
		...(input.interpreterDigest ? { interpreterDigest: input.interpreterDigest } : {}),
		...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
	};
	const base = {
		principal: "service:choreograph" as const,
		onBehalfOf: input.handoff.sourceTurn.target.ownerPrincipal,
		viaService: "choreograph",
		authMethod: "service_token" as const,
		graphId: input.handoff.target.graphId,
		outcome: input.outcome,
		durationMs: input.durationMs,
		payload,
	};
	const primaryKind = siteCaptureKind(input.handoff.operation);
	emitCaptureSoft(input.capture, { kind: primaryKind, ...base });
	if (input.outcome === "ok" && primaryKind !== "site.route") {
		emitCaptureSoft(input.capture, { kind: "site.route", ...base });
	}
}

function siteCaptureKind(
	operation: ValidatedSiteHandoff["operation"],
): "site.mint" | "site.route" | "site.publish" | "site.retire" {
	if (operation === "update") return "site.route";
	return `site.${operation}`;
}

function elapsed(startedAt: number, finishedAt: number): number {
	if (!Number.isSafeInteger(startedAt) || !Number.isSafeInteger(finishedAt)) return 0;
	return Math.max(0, finishedAt - startedAt);
}

export function pinnedSiteDefinitionDigest(input: {
	readonly definitionIri: string;
	readonly bundleId: string;
	readonly bundleVersion: string;
	readonly packageName: string;
	readonly version: string;
	readonly layoutSha256: string;
}): string {
	return createHash("sha256")
		.update(
			[
				input.definitionIri,
				input.bundleId,
				input.bundleVersion,
				input.packageName,
				input.version,
				input.layoutSha256,
			].join("\0"),
		)
		.digest("hex");
}

export async function resolveSiteInterpreter(
	graph: GraphWriter,
	graphId: string,
	bundle: ReviewedSiteBundleV1,
): Promise<SiteInterpreterWitnessV1> {
	const projection = `urn:mnemosyne:local:graph:${graphId}:projection:site`;
	let result: unknown;
	try {
		result = await graph.sparqlQuery(
			graphId,
			`SELECT ?definition ?bundleId ?bundleVersion ?package ?version ?layoutSha WHERE {
  GRAPH <${projection}> {
    ?definition a <http://sophia.ai/site#SiteDefinition> ;
      <http://sophia.ai/site#bundleId> ?bundleId ;
      <http://sophia.ai/site#bundleVersion> ?bundleVersion ;
      <http://sophia.ai/site#interpreterPackage> ?package ;
      <http://sophia.ai/site#interpreterVersion> ?version ;
      <http://sophia.ai/site#layoutSeedSha256> ?layoutSha .
  }
}
ORDER BY ?definition
LIMIT 2`,
		);
	} catch (error) {
		throw retryable("site-definition-unavailable", error);
	}
	const rows = sparqlRows(result);
	if (rows.length !== 1) throw terminal("site-definition-ambiguous");
	const row = rows[0]!;
	const siteDefinitionIri = iriTerm(row.definition, "definition");
	const witness: SiteInterpreterWitnessV1 = {
		packageName: literalTerm(row.package, "package"),
		version: literalTerm(row.version, "version"),
		bundleId: literalTerm(row.bundleId, "bundleId"),
		bundleVersion: literalTerm(row.bundleVersion, "bundleVersion"),
		layoutSeedSha256: literalTerm(row.layoutSha, "layoutSha"),
		siteDefinitionIri,
		siteDefinitionDigest: "",
	};
	for (const [actual, expected] of [
		[witness.packageName, bundle.packageName],
		[witness.version, bundle.version],
		[witness.bundleId, bundle.bundleId],
		[witness.bundleVersion, bundle.bundleVersion],
		[witness.layoutSeedSha256, bundle.layoutSeedSha256],
	]) {
		if (actual !== expected) throw terminal("site-interpreter-unreviewed");
	}
	return {
		...witness,
		siteDefinitionDigest: pinnedSiteDefinitionDigest({
			definitionIri: siteDefinitionIri,
			bundleId: witness.bundleId,
			bundleVersion: witness.bundleVersion,
			packageName: witness.packageName,
			version: witness.version,
			layoutSha256: witness.layoutSeedSha256,
		}),
	};
}

function siteSeedRequest(
	target: CommittedSiteTarget,
	bundle: ReviewedSiteBundleV1,
	sourceEndpoint = "https://api.garden.example.invalid",
): GenericIngestRequest {
	let endpoint: URL;
	try {
		endpoint = new URL(sourceEndpoint);
	} catch (error) {
		throw terminal("site-source-endpoint-invalid", error);
	}
	if (
		!/^https?:$/.test(endpoint.protocol) ||
		endpoint.username ||
		endpoint.password ||
		endpoint.search ||
		endpoint.hash
	) {
		throw terminal("site-source-endpoint-invalid");
	}
	return genericRequest([
		{
			kind: "SiteDefinition",
			localId: bundle.bundleId,
			bundleId: bundle.bundleId,
			bundleVersion: bundle.bundleVersion,
			interpreterPackage: bundle.packageName,
			interpreterVersion: bundle.version,
			layoutSeedSha256: bundle.layoutSeedSha256,
		},
		{
			kind: "ContentSource",
			localId: "hosted-gateway",
			endpoint: endpoint.toString().replace(/\/$/, ""),
			ownerPrincipal: target.ownerPrincipal,
			graphId: target.graphId,
			graphIri: `urn:mnemosyne:local:graph:${target.graphId}:ux:config`,
			authMode: "service",
			liveness: "poll",
			observer: "planter-pool",
			tripleCount: 0,
		},
		{
			kind: "PackProvenance",
			localId: bundle.bundleId,
			packName: bundle.emporiumPackName,
			packVersion: bundle.emporiumPackVersion,
			contentSha: bundle.emporiumPackSha256,
			witness: "choreograph-site-edge",
		},
	]);
}

function siteUpdateRequest(value: unknown): GenericIngestRequest {
	if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
		throw terminal("site-update-records-invalid");
	}
	const records = value.map((entry, index): GenericProjectionRecord => {
		if (!isRecord(entry)) throw terminal("site-update-records-invalid");
		const kind = text(entry.kind);
		const localId = text(entry.localId);
		if (!kind || !AGENT_MUTABLE_SITE_RECORDS.has(kind) || !localId || !/^[A-Za-z0-9._:-]{1,128}$/.test(localId)) {
			throw terminal(
				"site-update-records-invalid",
				new Error(`records[${index}] is outside the mutable site schema`),
			);
		}
		return { ...entry, kind, localId };
	});
	return genericRequest(records);
}

function routeIntentRequest(
	handoff: ValidatedSiteHandoff,
	interpreter: SiteInterpreterWitnessV1,
): GenericIngestRequest {
	const publicationState =
		handoff.operation === "publish" ? "published" : handoff.operation === "retire" ? "retired" : "unlisted";
	const record: GenericProjectionRecord = {
		kind: "PublicationRoute",
		localId: `route-${sha256(handoff.target.publicName).slice(0, 32)}`,
		publicName: handoff.target.publicName,
		pathPrefix: handoff.target.pathPrefix,
		ownerPrincipal: handoff.target.ownerPrincipal,
		graphId: handoff.target.graphId,
		siteDefinition: interpreter.siteDefinitionIri,
		interpreterPackage: interpreter.packageName,
		interpreterVersion: interpreter.version,
		publicationState,
	};
	if (publicationState === "published" && handoff.approval) {
		record.approvedBy = handoff.approval.approvedBy;
		record.approvedAt = new Date(handoff.approval.approvedAt).toISOString();
	}
	return genericRequest([record]);
}

function materializationRequest(
	handoff: ValidatedSiteHandoff,
	grant: VerifiedSiteGrant,
	interpreter: SiteInterpreterWitnessV1,
): SiteMaterializationRequestV1 {
	return {
		schema: SITE_MATERIALIZATION_SCHEMA,
		operation: handoff.operation,
		effectIndex: handoff.record.effect_index,
		proposalDigest: handoff.record.proposal_digest,
		executionDigest: handoff.record.execution_digest,
		sourceTurnDigest: handoff.record.source_turn_digest!,
		sourceTurn: handoff.sourceTurn,
		trigger: handoff.trigger,
		proposal: handoff.proposal,
		route: handoff.target,
		interpreter,
		grant: {
			grantId: grant.grant.grantId,
			grantDigest: grant.digest,
			authorityOwnerPrincipal: handoff.record.grant_authority_owner_principal,
			authorityGraphId: handoff.record.grant_authority_graph_id,
		},
		...(handoff.approval
			? {
					approval: {
						approvedBy: handoff.approval.approvedBy,
						approvedAt: handoff.approval.approvedAt,
						proposalDigest: handoff.approval.proposalDigest,
						grantId: handoff.approval.grantId,
					},
				}
			: {}),
	};
}

async function applyEmporium(
	graph: GraphWriter,
	graphId: string,
	request: GenericIngestRequest,
	code: string,
): Promise<void> {
	if (!graph.emporiumIngest) throw terminal(`${code}-emporium-unavailable`);
	try {
		assertEmporiumResult(await graph.emporiumIngest(graphId, { ...request, dry_run: true }), `${code}-dry-run`);
		assertEmporiumResult(await graph.emporiumIngest(graphId, request), `${code}-apply`);
		assertEmporiumResult(await graph.emporiumIngest(graphId, { ...request, dry_run: true }), `${code}-replay`);
	} catch (error) {
		if (error instanceof SiteEffectError) throw error;
		throw retryable(`${code}-unavailable`, error);
	}
}

function assertEmporiumResult(value: unknown, code: string): void {
	const result = unwrapStructured(value);
	if (!isRecord(result) || result.ok !== true) throw terminal(`${code}-refused`);
}

function genericRequest(records: GenericProjectionRecord[]): GenericIngestRequest {
	return {
		vocab: "shrubbery-site",
		dry_run: false,
		replace_class: false,
		payload: { kind: "generic", records },
	};
}

function parseApproval(
	value: unknown,
	proposal: ProposedEffectV1,
	record: EffectHandoffRecord,
): EffectApprovalV1 | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) throw terminal("site-approval-invalid");
	const approval = value as unknown as EffectApprovalV1;
	if (
		approval.effectId !== proposal.effectId ||
		approval.grantId !== record.grant_id ||
		approval.proposalDigest !== record.proposal_digest ||
		!USER_PRINCIPAL.test(approval.approvedBy) ||
		!Number.isSafeInteger(approval.approvedAt) ||
		approval.approvedAt < 0
	) {
		throw terminal("site-approval-invalid");
	}
	return approval;
}

function sparqlRows(value: unknown): Record<string, unknown>[] {
	const unwrapped = unwrapStructured(value);
	if (isRecord(unwrapped) && Array.isArray(unwrapped.rows)) {
		return unwrapped.rows.filter(isRecord);
	}
	return [];
}

function unwrapStructured(value: unknown): unknown {
	if (!isRecord(value)) return value;
	for (const key of ["structuredContent", "structured_content", "result"] as const) {
		if (value[key] !== undefined) return unwrapStructured(value[key]);
	}
	if (Array.isArray(value.content)) {
		for (const entry of value.content) {
			if (!isRecord(entry) || typeof entry.text !== "string") continue;
			try {
				return unwrapStructured(JSON.parse(entry.text) as unknown);
			} catch {
				// Continue to the original envelope.
			}
		}
	}
	return value;
}

function iriTerm(value: unknown, label: string): string {
	if (isRecord(value) && value.type === "iri" && text(value.value)) return value.value as string;
	const lexical = text(value);
	if (lexical?.startsWith("<") && lexical.endsWith(">")) return lexical.slice(1, -1);
	if (lexical && /^(?:https?|urn):/.test(lexical)) return lexical;
	throw terminal("site-definition-invalid", new Error(`${label} is not an IRI`));
}

function literalTerm(value: unknown, label: string): string {
	if (isRecord(value) && value.type === "literal" && text(value.value)) return value.value as string;
	const lexical = text(value);
	if (!lexical) throw terminal("site-definition-invalid", new Error(`${label} is not a literal`));
	const match = /^"((?:\\.|[^"\\])*)"(?:\^\^<[^>]+>|@[A-Za-z0-9-]+)?$/.exec(lexical);
	if (!match) return lexical;
	try {
		return JSON.parse(`"${match[1]}"`) as string;
	} catch {
		throw terminal("site-definition-invalid", new Error(`${label} has invalid escaping`));
	}
}

function validateReviewedBundle(bundle: ReviewedSiteBundleV1): void {
	for (const [label, value] of [
		["bundleId", bundle.bundleId],
		["bundleVersion", bundle.bundleVersion],
		["packageName", bundle.packageName],
		["version", bundle.version],
		["emporiumPackVersion", bundle.emporiumPackVersion],
	] as const) {
		if (!value || value === "latest" || value.includes("*")) throw new Error(`reviewed site ${label} is not exact`);
	}
	if (!SHA256.test(bundle.layoutSeedSha256) || !SHA256.test(bundle.emporiumPackSha256)) {
		throw new Error("reviewed site digests must be lowercase SHA-256");
	}
}

function requiredClaimToken(record: EffectHandoffRecord): string {
	if (!record.claim_token) throw new Error("site effect lease has no claim token");
	return record.claim_token;
}

function retryDelay(attempt: number): number {
	return Math.min(3_600_000, 1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 11));
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
	return value;
}

function optionalBoundedText(value: unknown, label: string, maximum: number): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\u0000-\u001f]/.test(value)) {
		throw terminal("site-proposal-invalid", new Error(`${label} must be 1-${maximum} safe characters`));
	}
	return value;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: unknown): string {
	return createHash("sha256")
		.update(typeof value === "string" ? value : stableJson(value))
		.digest("hex");
}

function terminal(code: string, cause?: unknown): SiteEffectError {
	return new SiteEffectError(code, false, cause instanceof Error ? `${code}: ${cause.message}` : code);
}

function retryable(code: string, cause?: unknown): SiteEffectError {
	return new SiteEffectError(code, true, cause instanceof Error ? `${code}: ${cause.message}` : code);
}
