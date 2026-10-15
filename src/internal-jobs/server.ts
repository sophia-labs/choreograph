import { timingSafeEqual } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import {
	type MeaningfulObjectKind,
	type MeaningfulObjectRefV1,
	validateMeaningfulObjectRef,
} from "../agent-runtime/meaningful-object.js";
import { isCanonicalGraphOwnerPrincipal } from "../graph-owner-principal.js";
import type { EffectHandoffRecord, WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import {
	InternalJobRequestError,
	type InternalStageJob,
	parseInternalStageSubmission,
	parseRetryRequest,
	requireCanonicalJobId,
	requireInternalStageKind,
} from "./contracts.js";
import type { InternalJobRunner } from "./runner.js";

const MAX_BODY_BYTES = 64 * 1024;
const SOURCE_EVENT_ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const PRIVACY_HANDLE = /^(?:ctx|guild|channel|message|response|principal)_[A-Za-z0-9_-]{24}$/;
const DATASET_EPOCH_ID = /^[0-9a-f]{32}$/;
const GRAPH_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export interface PhanesDomainTriggerRequest {
	readonly schema: "sophia.phanes-domain-trigger.v2";
	readonly sourceCommit: {
		readonly eventId: string;
		readonly eventRef: string;
		readonly digest: string;
	};
	readonly trigger: Readonly<Record<string, unknown>>;
	readonly contextRefs: readonly string[];
}

export interface PhanesDomainTriggerSubmitter {
	submit(request: PhanesDomainTriggerRequest): Promise<{ runId: string; invocationId: string }>;
}

export interface PhanesPrivacyRetirementHandler {
	retire(activeEpochId: string): Promise<Readonly<Record<string, unknown>>>;
}

export interface InternalJobServer {
	server: Server;
	socketPath: string;
	close(): Promise<void>;
}

export async function startInternalJobServer(options: {
	socketPath: string;
	token: string;
	runner: InternalJobRunner;
	effectStore?: WorkflowRuntimeStore;
	effectCapabilities?: readonly string[];
	domainTrigger?: PhanesDomainTriggerSubmitter;
	privacyRetirement?: PhanesPrivacyRetirementHandler;
}): Promise<InternalJobServer> {
	if (!options.token || options.token.length < 32) {
		throw new Error("PHANES_TRANSCRIBE_TOKEN must contain at least 32 characters");
	}
	mkdirSync(dirname(options.socketPath), { recursive: true, mode: 0o770 });
	removeStaleSocket(options.socketPath);
	let admissionOpen = true;
	const requests = new Set<Promise<void>>();
	const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		response.setHeader("content-type", "application/json; charset=utf-8");
		if (!isAuthorized(request, options.token)) {
			send(response, 401, { error: "unauthorized" });
			return;
		}
		try {
			await route(
				request,
				response,
				options.runner,
				options.effectStore,
				new Set(options.effectCapabilities ?? []),
				options.domainTrigger,
				options.privacyRetirement,
			);
		} catch (error) {
			const status = error instanceof InternalJobRequestError ? error.statusCode : 500;
			send(response, status, {
				error: error instanceof Error ? error.message : "internal stage request failed",
			});
		}
	};
	const server = createServer((request, response) => {
		// Unix listener close does not fence a request already pipelined on an
		// accepted connection. This synchronous application latch does.
		if (!admissionOpen) {
			response.setHeader("connection", "close");
			send(response, 503, { error: "internal stage server is shutting down" });
			return;
		}
		let tracked!: Promise<void>;
		tracked = handle(request, response).finally(() => requests.delete(tracked));
		requests.add(tracked);
	});
	server.maxConnections = 32;
	// Privacy retirement may wait for an in-flight sandbox to reach a safe
	// terminal frontier before securely purging its epoch testimony.
	server.requestTimeout = 300_000;
	server.headersTimeout = 10_000;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	chmodSync(options.socketPath, 0o660);
	let closing: Promise<void> | undefined;
	return {
		server,
		socketPath: options.socketPath,
		async close() {
			if (closing) return closing;
			admissionOpen = false;
			closing = (async () => {
				const serverClosed = new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
				});
				await Promise.allSettled([...requests]);
				server.closeAllConnections?.();
				await serverClosed;
				try {
					removeStaleSocket(options.socketPath);
				} catch {
					// The process is already shutting down; the runtime directory is ephemeral.
				}
			})();
			return closing;
		},
	};
}

async function route(
	request: IncomingMessage,
	response: ServerResponse,
	runner: InternalJobRunner,
	effectStore: WorkflowRuntimeStore | undefined,
	effectCapabilities: ReadonlySet<string>,
	domainTrigger: PhanesDomainTriggerSubmitter | undefined,
	privacyRetirement: PhanesPrivacyRetirementHandler | undefined,
): Promise<void> {
	const method = request.method ?? "GET";
	const pathname = new URL(request.url ?? "/", "http://internal").pathname;
	if (method === "POST" && pathname === "/internal/domain-agents/phanes/trigger") {
		if (!domainTrigger) throw new InternalJobRequestError("route not found", 404);
		const submitted = await domainTrigger.submit(parsePhanesDomainTrigger(await readJsonBody(request)));
		send(response, 202, { run_id: submitted.runId, invocation_id: submitted.invocationId, status: "running" });
		return;
	}
	if (method === "POST" && pathname === "/internal/privacy/phanes/retire") {
		if (!privacyRetirement) throw new InternalJobRequestError("route not found", 404);
		const body = requestObject(await readJsonBody(request), ["schema", "active_epoch_id"]);
		if (body.schema !== "sophia.privacy-epoch-retirement-request.v1") {
			throw new InternalJobRequestError("unsupported privacy retirement schema");
		}
		const activeEpochId = body.active_epoch_id;
		if (typeof activeEpochId !== "string" || !DATASET_EPOCH_ID.test(activeEpochId)) {
			throw new InternalJobRequestError("active_epoch_id must be a canonical privacy epoch");
		}
		send(response, 200, { receipt: await privacyRetirement.retire(activeEpochId) });
		return;
	}
	if (method === "POST" && pathname === "/internal/effects/claim") {
		if (!effectStore || effectCapabilities.size === 0) throw new InternalJobRequestError("route not found", 404);
		const claim = parseEffectClaim(await readJsonBody(request), effectCapabilities);
		const effect = await effectStore.claimEffectHandoff({ ...claim, now: Date.now() });
		send(response, 200, { effect: effect ? publicEffect(effect, true) : null });
		return;
	}
	const effectMatch = pathname.match(/^\/internal\/effects\/(effect%3A|effect:)([a-f0-9]{64})(?:\/(complete))?$/i);
	if (effectMatch) {
		if (!effectStore || effectCapabilities.size === 0) throw new InternalJobRequestError("route not found", 404);
		const idempotencyKey = `effect:${effectMatch[2].toLowerCase()}`;
		if (method === "GET" && !effectMatch[3]) {
			const effect = await effectStore.getEffectHandoff(idempotencyKey);
			if (!effect || !effectCapabilities.has(effect.capability)) {
				throw new InternalJobRequestError("effect handoff not found", 404);
			}
			send(response, 200, { effect: publicEffect(effect, false) });
			return;
		}
		if (method === "POST" && effectMatch[3] === "complete") {
			const completion = parseEffectCompletion(await readJsonBody(request));
			const existing = await effectStore.getEffectHandoff(idempotencyKey);
			if (!existing || !effectCapabilities.has(existing.capability)) {
				throw new InternalJobRequestError("effect handoff not found", 404);
			}
			try {
				const effect = await effectStore.completeEffectHandoff({
					idempotencyKey,
					...completion,
					now: Date.now(),
				});
				send(response, 200, { effect: publicEffect(effect, false) });
			} catch (error) {
				throw new InternalJobRequestError(error instanceof Error ? error.message : String(error), 409);
			}
			return;
		}
		throw new InternalJobRequestError("method not allowed", 405);
	}
	if (method === "POST" && pathname === "/internal/jobs") {
		const submission = parseInternalStageSubmission(await readJsonBody(request));
		send(response, 202, { job: publicStatus(await runner.submit(submission)) });
		return;
	}
	const match = pathname.match(/^\/internal\/jobs\/([^/]+)\/stages\/([^/]+)(?:\/(retry|cancel))?$/);
	if (!match) {
		throw new InternalJobRequestError("route not found", 404);
	}
	const jobId = requireCanonicalJobId(match[1]);
	const stage = requireInternalStageKind(match[2]);
	const action = match[3];
	if (method === "GET" && !action) {
		send(response, 200, { job: publicStatus(runner.status(jobId, stage)) });
		return;
	}
	if (method === "POST" && action === "retry") {
		const retry = parseRetryRequest(await readJsonBody(request));
		send(response, 202, {
			job: publicStatus(runner.retry(jobId, stage, retry.expected_attempt, retry.idempotency_key)),
		});
		return;
	}
	if (method === "POST" && action === "cancel") {
		await readJsonBody(request);
		send(response, 200, { job: publicStatus(await runner.cancel(jobId, stage)) });
		return;
	}
	throw new InternalJobRequestError("method not allowed", 405);
}

function parsePhanesDomainTrigger(value: unknown): PhanesDomainTriggerRequest {
	const body = requestObject(value, ["schema", "source_commit", "trigger", "context_refs"]);
	if (body.schema !== "sophia.phanes-domain-trigger.v2") {
		throw new InternalJobRequestError("unsupported Phanes trigger schema");
	}
	const source = requestObject(body.source_commit, ["event_id", "event_ref", "digest"]);
	const eventId = source.event_id;
	if (typeof eventId !== "string" || !SOURCE_EVENT_ULID.test(eventId)) {
		throw new InternalJobRequestError("source_commit.event_id must be a canonical ULID");
	}
	const eventRef = source.event_ref;
	const digest = source.digest;
	if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
		throw new InternalJobRequestError("source_commit.digest must be lowercase SHA-256");
	}
	const trigger = requestObject(body.trigger, [
		"kind",
		"event_id",
		"resource",
		"privacy_context_handle",
		"guild_handle",
		"channel_handle",
		"channel_handles",
		"message_handle",
		"response_handle",
		"dataset_epoch",
		"meaningful_objects",
	]);
	const kind = trigger.kind;
	if (kind !== "discord.message.mention") {
		throw new InternalJobRequestError("Phanes only accepts explicit Discord mentions");
	}
	if (trigger.event_id !== eventId) throw new InternalJobRequestError("trigger event_id is inconsistent");
	const contextHandle = privacyHandle(trigger.privacy_context_handle, "ctx", "trigger.privacy_context_handle");
	const guildHandle = privacyHandle(trigger.guild_handle, "guild", "trigger.guild_handle");
	const channelHandle = privacyHandle(trigger.channel_handle, "channel", "trigger.channel_handle");
	const messageHandle = privacyHandle(trigger.message_handle, "message", "trigger.message_handle");
	const responseHandle = privacyHandle(trigger.response_handle, "response", "trigger.response_handle");
	if (
		!Array.isArray(trigger.channel_handles) ||
		trigger.channel_handles.length === 0 ||
		trigger.channel_handles.length > 64
	) {
		throw new InternalJobRequestError("trigger.channel_handles must contain 1-64 opaque channels");
	}
	const channelHandles = [
		...new Set(trigger.channel_handles.map((entry) => privacyHandle(entry, "channel", "trigger.channel_handles"))),
	];
	if (channelHandles.length !== trigger.channel_handles.length || !channelHandles.includes(channelHandle)) {
		throw new InternalJobRequestError("trigger.channel_handles must be unique and include trigger.channel_handle");
	}
	const resource = trigger.resource;
	if (resource !== `discord-context:${contextHandle}`) {
		throw new InternalJobRequestError("trigger resource is inconsistent");
	}
	const datasetEpoch = parseDatasetEpoch(trigger.dataset_epoch);
	if (
		typeof eventRef !== "string" ||
		eventRef !== `urn:phanes:dataset-epoch:${datasetEpoch.epochId}:source-event:${eventId}`
	) {
		throw new InternalJobRequestError("source_commit.event_ref is inconsistent");
	}
	if (!Array.isArray(body.context_refs) || body.context_refs.length > 64) {
		throw new InternalJobRequestError("context_refs must contain at most 64 references");
	}
	const contextRefs = body.context_refs.map((ref) => {
		if (typeof ref !== "string" || ref.length === 0 || ref.length > 512 || /[\r\n\0]/.test(ref)) {
			throw new InternalJobRequestError("context_refs contains an invalid reference");
		}
		return ref;
	});
	if (!contextRefs.includes(eventRef)) {
		throw new InternalJobRequestError("context_refs must include the durable source event");
	}
	const meaningfulObjects = phanesMeaningfulObjects(trigger.meaningful_objects, {
		eventId,
		eventRef,
		digest,
		contextHandle,
		channelHandle,
		messageHandle,
		datasetEpoch,
	});
	for (const object of Object.values(meaningfulObjects)) {
		if (!contextRefs.includes(object.objectId)) {
			throw new InternalJobRequestError("context_refs must include every trigger Meaningful Object");
		}
	}
	return {
		schema: "sophia.phanes-domain-trigger.v2",
		sourceCommit: { eventId, eventRef, digest },
		trigger: {
			kind,
			eventId,
			resource,
			privacyContextHandle: contextHandle,
			guildHandle,
			channelHandle,
			channelHandles,
			messageHandle,
			responseHandle,
			datasetEpoch,
			meaningfulObjects,
		},
		contextRefs,
	};
}

function phanesMeaningfulObjects(
	value: unknown,
	coordinates: {
		readonly eventId: string;
		readonly eventRef: string;
		readonly digest: string;
		readonly contextHandle: string;
		readonly channelHandle: string;
		readonly messageHandle: string;
		readonly datasetEpoch: DatasetEpochV1;
	},
): Readonly<Record<string, MeaningfulObjectRefV1>> {
	const objects = requestObject(value, [
		"sourceEvent",
		"datasetEpoch",
		"privacyContext",
		"channel",
		"message",
		"author",
	]);
	for (const required of ["sourceEvent", "datasetEpoch", "privacyContext", "channel", "message", "author"] as const) {
		if (objects[required] === undefined) {
			throw new InternalJobRequestError(`trigger.meaningful_objects.${required} is required`);
		}
	}
	const expected: Readonly<Record<string, { kinds: readonly MeaningfulObjectKind[]; objectId?: string }>> = {
		sourceEvent: { kinds: ["privacy-bound-source-event"], objectId: coordinates.eventRef },
		datasetEpoch: {
			kinds: ["dataset-epoch"],
			objectId: `urn:phanes:dataset-epoch:${coordinates.datasetEpoch.epochId}`,
		},
		privacyContext: {
			kinds: ["privacy-context"],
			objectId: `urn:phanes:privacy-context:${coordinates.contextHandle}`,
		},
		channel: {
			kinds: ["discord-channel", "discord-thread"],
			objectId: `urn:phanes:discord-channel:${coordinates.channelHandle}`,
		},
		message: { kinds: ["discord-message"], objectId: `urn:phanes:discord-message:${coordinates.messageHandle}` },
		author: { kinds: ["social-identity"] },
	};
	const validated: Record<string, MeaningfulObjectRefV1> = {};
	let ownerPrincipal: string | undefined;
	for (const [name, raw] of Object.entries(objects)) {
		const rule = expected[name];
		if (!rule) throw new InternalJobRequestError(`trigger.meaningful_objects.${name} is unsupported`);
		try {
			validateMeaningfulObjectRef(raw);
		} catch {
			throw new InternalJobRequestError(`trigger.meaningful_objects.${name} is invalid`);
		}
		if (!rule.kinds.includes(raw.kind) || (rule.objectId !== undefined && raw.objectId !== rule.objectId)) {
			throw new InternalJobRequestError(`trigger.meaningful_objects.${name} differs from the Discord trigger`);
		}
		if (raw.graphId !== coordinates.datasetEpoch.graphId || !isCanonicalGraphOwnerPrincipal(raw.ownerPrincipal)) {
			throw new InternalJobRequestError(`trigger.meaningful_objects.${name} has invalid graph authority`);
		}
		ownerPrincipal ??= raw.ownerPrincipal;
		if (raw.ownerPrincipal !== ownerPrincipal) {
			throw new InternalJobRequestError("trigger Meaningful Objects must share one owner authority");
		}
		validated[name] = raw;
	}
	const sourceEvent = validated.sourceEvent;
	if (sourceEvent.version !== coordinates.eventId || sourceEvent.digest !== `sha256:${coordinates.digest}`) {
		throw new InternalJobRequestError("source-event Meaningful Object differs from the durable source commit");
	}
	if (validated.datasetEpoch?.version !== coordinates.datasetEpoch.manifestDigest) {
		throw new InternalJobRequestError("dataset-epoch Meaningful Object differs from the trigger epoch");
	}
	return validated;
}

interface DatasetEpochV1 {
	readonly schema: "sophia.dataset-epoch.v1";
	readonly object: {
		readonly kind: "dataset-epoch";
		readonly objectId: string;
		readonly version: string;
	};
	readonly epochId: string;
	readonly graphId: string;
	readonly preferenceRevision: number;
	readonly policyDigest: string;
	readonly activatedAt: string;
	readonly documentCount: number;
	readonly messageCount: number;
	readonly manifestDigest: string;
}

function parseDatasetEpoch(value: unknown): DatasetEpochV1 {
	const epoch = requestObject(value, [
		"schema",
		"object",
		"epochId",
		"graphId",
		"preferenceRevision",
		"policyDigest",
		"activatedAt",
		"documentCount",
		"messageCount",
		"manifestDigest",
	]);
	if (epoch.schema !== "sophia.dataset-epoch.v1") {
		throw new InternalJobRequestError("trigger.dataset_epoch has an unsupported schema");
	}
	const epochId = epoch.epochId;
	const graphId = epoch.graphId;
	const preferenceRevision = epoch.preferenceRevision;
	const policyDigest = epoch.policyDigest;
	const manifestDigest = epoch.manifestDigest;
	const activatedAt = epoch.activatedAt;
	const documentCount = epoch.documentCount;
	const messageCount = epoch.messageCount;
	if (typeof epochId !== "string" || !DATASET_EPOCH_ID.test(epochId)) {
		throw new InternalJobRequestError("trigger.dataset_epoch.epochId is invalid");
	}
	if (typeof graphId !== "string" || !GRAPH_ID.test(graphId)) {
		throw new InternalJobRequestError("trigger.dataset_epoch.graphId is invalid");
	}
	if (!Number.isSafeInteger(preferenceRevision) || Number(preferenceRevision) < 0) {
		throw new InternalJobRequestError("trigger.dataset_epoch.preferenceRevision is invalid");
	}
	if (
		typeof policyDigest !== "string" ||
		!/^sha256:[0-9a-f]{64}$/.test(policyDigest) ||
		typeof manifestDigest !== "string" ||
		!/^sha256:[0-9a-f]{64}$/.test(manifestDigest)
	) {
		throw new InternalJobRequestError("trigger.dataset_epoch digests are invalid");
	}
	if (typeof activatedAt !== "string" || !Number.isFinite(Date.parse(activatedAt))) {
		throw new InternalJobRequestError("trigger.dataset_epoch.activatedAt is invalid");
	}
	if (
		!Number.isSafeInteger(documentCount) ||
		Number(documentCount) < 1 ||
		!Number.isSafeInteger(messageCount) ||
		Number(messageCount) < 0
	) {
		throw new InternalJobRequestError("trigger.dataset_epoch counts are invalid");
	}
	const object = requestObject(epoch.object, ["kind", "objectId", "version"]);
	if (
		object.kind !== "dataset-epoch" ||
		object.objectId !== `urn:phanes:dataset-epoch:${epochId}` ||
		object.version !== manifestDigest
	) {
		throw new InternalJobRequestError("trigger.dataset_epoch object identity is inconsistent");
	}
	return {
		schema: "sophia.dataset-epoch.v1",
		object: {
			kind: "dataset-epoch",
			objectId: String(object.objectId),
			version: String(object.version),
		},
		epochId,
		graphId,
		preferenceRevision: Number(preferenceRevision),
		policyDigest,
		activatedAt,
		documentCount: Number(documentCount),
		messageCount: Number(messageCount),
		manifestDigest,
	};
}

function privacyHandle(value: unknown, prefix: string, field: string): string {
	if (typeof value !== "string" || !value.startsWith(`${prefix}_`) || !PRIVACY_HANDLE.test(value)) {
		throw new InternalJobRequestError(`${field} must be an opaque ${prefix} handle`);
	}
	return value;
}

function parseEffectClaim(
	value: unknown,
	allowedCapabilities: ReadonlySet<string>,
): { consumer: string; capabilities: string[]; leaseMs: number } {
	const body = requestObject(value, ["consumer", "capabilities", "lease_ms"]);
	const consumer = safeIdentifier(body.consumer, "consumer");
	const requested = body.capabilities;
	if (!Array.isArray(requested) || requested.length === 0 || requested.some((item) => typeof item !== "string")) {
		throw new InternalJobRequestError("capabilities must be a non-empty string array");
	}
	const capabilities = [...new Set(requested)].filter((capability) => allowedCapabilities.has(capability));
	if (capabilities.length !== requested.length) {
		throw new InternalJobRequestError("requested effect capability is not available to this edge", 403);
	}
	const leaseMs = boundedInteger(body.lease_ms, "lease_ms", 1_000, 300_000);
	return { consumer, capabilities, leaseMs };
}

function parseEffectCompletion(value: unknown): {
	consumer: string;
	claimToken: string;
	outcome: "executed" | "failed-retryable" | "failed-terminal";
	completion: Record<string, unknown>;
	retryAfterMs?: number;
} {
	const body = requestObject(value, ["consumer", "claim_token", "outcome", "completion", "retry_after_ms"]);
	const consumer = safeIdentifier(body.consumer, "consumer");
	const claimToken = safeIdentifier(body.claim_token, "claim_token");
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claimToken)) {
		throw new InternalJobRequestError("claim_token must be a canonical UUIDv4");
	}
	if (!(["executed", "failed-retryable", "failed-terminal"] as unknown[]).includes(body.outcome)) {
		throw new InternalJobRequestError("unsupported effect completion outcome");
	}
	if (!body.completion || typeof body.completion !== "object" || Array.isArray(body.completion)) {
		throw new InternalJobRequestError("completion must be an object");
	}
	const retryAfterMs =
		body.retry_after_ms === undefined
			? undefined
			: boundedInteger(body.retry_after_ms, "retry_after_ms", 0, 3_600_000);
	if (body.outcome !== "failed-retryable" && retryAfterMs !== undefined) {
		throw new InternalJobRequestError("retry_after_ms is only valid for failed-retryable");
	}
	return {
		consumer,
		claimToken,
		outcome: body.outcome as "executed" | "failed-retryable" | "failed-terminal",
		completion: body.completion as Record<string, unknown>,
		...(retryAfterMs === undefined ? {} : { retryAfterMs }),
	};
}

function requestObject(value: unknown, allowedFields: readonly string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new InternalJobRequestError("request body must be an object");
	}
	const body = value as Record<string, unknown>;
	const unexpected = Object.keys(body).filter((key) => !allowedFields.includes(key));
	if (unexpected.length > 0) throw new InternalJobRequestError(`unsupported fields: ${unexpected.join(", ")}`);
	return body;
}

function safeIdentifier(value: unknown, field: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
		throw new InternalJobRequestError(`${field} must contain 1-128 safe characters`);
	}
	return value;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
		throw new InternalJobRequestError(`${field} must be an integer from ${minimum} through ${maximum}`);
	}
	return Number(value);
}

function publicEffect(record: EffectHandoffRecord, includeLease: boolean): Record<string, unknown> {
	return {
		idempotency_key: record.idempotency_key,
		execution_digest: record.execution_digest,
		proposal_digest: record.proposal_digest,
		run_id: record.run_id,
		graph_id: record.graph_id,
		agent_id: record.agent_id,
		actor_ref: record.actor_ref,
		grant: {
			grant_id: record.grant_id,
			document_id: record.grant_document_id,
			authority_graph_id: record.grant_authority_graph_id,
			authority_owner_principal: record.grant_authority_owner_principal,
			digest: record.grant_digest,
		},
		definition_digest: record.definition_digest,
		source_turn: record.source_turn,
		source_turn_digest: record.source_turn_digest,
		capability: record.capability,
		operation: record.operation,
		proposal: record.proposal,
		trigger: record.trigger,
		approval: record.approval,
		effect_index: record.effect_index,
		state: record.state,
		attempt: record.attempt,
		completion: record.completion,
		created_at: record.created_at,
		updated_at: record.updated_at,
		...(includeLease
			? {
					consumer: record.consumer,
					claim_token: record.claim_token,
					lease_expires_at: record.lease_expires_at,
				}
			: {}),
	};
}

function publicStatus(job: InternalStageJob): Omit<InternalStageJob, "input" | "parameters"> {
	const { input: _input, parameters: _parameters, ...status } = job;
	return status;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const value of request) {
		const chunk = typeof value === "string" ? Buffer.from(value) : value;
		bytes += chunk.length;
		if (bytes > MAX_BODY_BYTES) {
			throw new InternalJobRequestError("request body exceeds 64 KiB", 413);
		}
		chunks.push(chunk);
	}
	if (chunks.length === 0) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new InternalJobRequestError("request body must be valid JSON");
	}
}

function isAuthorized(request: IncomingMessage, expectedToken: string): boolean {
	const authorization = request.headers.authorization;
	if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) return false;
	const candidate = Buffer.from(authorization.slice("Bearer ".length));
	const expected = Buffer.from(expectedToken);
	return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function send(response: ServerResponse, status: number, body: unknown): void {
	response.statusCode = status;
	response.end(JSON.stringify(body));
}

function removeStaleSocket(path: string): void {
	try {
		const info = lstatSync(path);
		if (!info.isSocket()) {
			throw new Error(`refusing to replace non-socket path: ${path}`);
		}
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}
