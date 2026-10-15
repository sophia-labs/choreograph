/**
 * Choreograph's native Observatory CaptureEvent witness writer.
 *
 * This is deliberately not a logging facade. The public input is a closed
 * union of content-free events, serialization is canonical, and fd 1 is the
 * only production sink. Ordinary diagnostics belong on stderr.
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { Writable } from "node:stream";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const PRINCIPAL_PATTERN = /^(anon|service:[a-z][a-z0-9-]{0,63}|[A-Za-z0-9][A-Za-z0-9._:@-]{0,255})$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/;
const GRAPH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const ROUTE_LABEL_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const MODEL_ID_PATTERN = /^(?:~[A-Za-z0-9][A-Za-z0-9._:/-]{0,126}|[A-Za-z0-9][A-Za-z0-9._:/-]{0,127})$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EVIDENCE_URI_PATTERN = /^s3:\/\/[a-z0-9][a-z0-9.-]{2,62}\/[A-Za-z0-9._/@%+=,:~-]{1,1024}$/;

export const CAPTURE_WIRE_VERSION = 1;
export const CAPTURE_MAX_LINE_BYTES = 4096;
export const DEFAULT_CAPTURE_QUEUE_CAPACITY = 256;
export const DEFAULT_CAPTURE_HEARTBEAT_MS = 60_000;
export const OBSERVATORY_CAPTURE_ACTIVATION_ENV = "SOPHIA_OBSERVATORY_CAPTURE_ENABLED";
export const OBSERVATORY_CONTRACT_BUNDLE_SHA256_ENV = "SOPHIA_OBSERVATORY_CONTRACT_BUNDLE_SHA256";
export const OBSERVATORY_CONTRACT_BUNDLE_SHA256 = "c60d81fe4b431c3a88bd2450189a16da97627cc6ba36c4b127942d593a6c2bbb";

export type CaptureOutcome = "ok" | "denied" | "error" | "timeout";
export type CaptureAuthMethod = "cognito_jwt" | "api_key" | "service_token" | "signed_url" | "none";

export interface CaptureIdentity {
	principal: string;
	onBehalfOf?: string;
	viaService?: string;
	authMethod?: CaptureAuthMethod;
	graphId?: string;
}

interface CaptureEventBase extends CaptureIdentity {
	outcome: CaptureOutcome;
	durationMs?: number;
}

export interface LlmCallPayload {
	model: string;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	costMicroUsd?: number;
}

export interface SandboxSpawnPayload {
	template: string;
	sandboxId: string;
}

export interface AgentTurnPayload {
	template: string;
	sandboxId: string;
	stepIndex?: number;
	toolCount?: number;
}

export interface ChatTurnPayload {
	messageBytes: number;
	turnIndex?: number;
	model?: string;
}

export interface SandboxReapPayload {
	template: string;
	sandboxId: string;
	reason: string;
	exitCode?: number;
	memoryPeakBytes?: number;
	cpuUsageUs?: number;
}

export interface CapabilityCallPayload {
	runId: string;
	sandboxId: string;
	callId: string;
	capability: string;
	tool: string;
}

export interface TestBeatPayload {
	runId: string;
	scenarioId: string;
	beatId: string;
	engine: "chromium" | "camoufox";
	operation: "create" | "type" | "edit-block" | "concurrent-edit" | "rename" | "list" | "delete-later";
	actionCount: number;
	evidenceUri: string;
	evidenceSha256: string;
}

export interface TestVerdictPayload {
	runId: string;
	scenarioId: string;
	invariant: "I1" | "I2" | "I3" | "I4" | "I5" | "L1" | "L2-primary" | "L2-foreign";
	passed: boolean;
	verdictCode: string;
	beatId?: string;
	engine?: "chromium" | "camoufox";
	evidenceUri?: string;
	evidenceSha256?: string;
	observedMs?: number;
	maximumMs?: number;
}

export interface SiteLifecyclePayload {
	effectKey: string;
	sourceTurnDigest: string;
	proposalDigest: string;
	executionDigest: string;
	grantDigest: string;
	publicName: string;
	interpreterDigest?: string;
	reasonCode?: string;
}

export type ChoreographCaptureEvent =
	| (CaptureEventBase & { kind: "llm.call"; payload: LlmCallPayload })
	| (CaptureEventBase & { kind: "sandbox.spawn"; payload: SandboxSpawnPayload })
	| (CaptureEventBase & { kind: "agent.turn"; payload: AgentTurnPayload })
	| (CaptureEventBase & { kind: "chat.turn"; payload: ChatTurnPayload })
	| (CaptureEventBase & { kind: "sandbox.reap"; payload: SandboxReapPayload })
	| (CaptureEventBase & { kind: "capability.call"; payload: CapabilityCallPayload })
	| (CaptureEventBase & { kind: "test.beat"; payload: TestBeatPayload })
	| (CaptureEventBase & { kind: "test.verdict"; payload: TestVerdictPayload })
	| (CaptureEventBase & {
			kind: "site.mint" | "site.route" | "site.publish" | "site.retire";
			payload: SiteLifecyclePayload;
	  });

export interface CaptureEmitter {
	emit(input: ChoreographCaptureEvent): void;
}

export function emitCaptureSoft(capture: CaptureEmitter | undefined, event: ChoreographCaptureEvent): void {
	try {
		capture?.emit(event);
	} catch {
		// Testimony is observational and can never alter product behavior.
	}
}

export function captureIdentityForHostedRequest(input: {
	authMethod?: "delegated_bearer" | "internal_service";
	ownerUserId?: string;
	graphId?: string;
}): CaptureIdentity {
	const ownerUserId = input.ownerUserId?.trim();
	if (input.authMethod === "delegated_bearer" && ownerUserId) {
		return {
			principal: ownerUserId,
			authMethod: "cognito_jwt",
			graphId: input.graphId,
		};
	}
	if (input.authMethod === "internal_service") {
		return {
			principal: "service:choreograph",
			onBehalfOf: ownerUserId,
			viaService: "choreograph",
			authMethod: "service_token",
			graphId: input.graphId,
		};
	}
	return {
		principal: "service:choreograph",
		onBehalfOf: ownerUserId,
		graphId: input.graphId,
	};
}

export interface CaptureWriterCounters {
	emittedTotal: number;
	droppedTotal: number;
	nextSeq: bigint;
}

export interface CaptureWriterOptions {
	sink?: Writable;
	hostId?: string;
	instanceId?: string;
	queueCapacity?: number;
	heartbeatMs?: number;
	clock?: () => number;
	idFactory?: (timestampMs: number) => string;
}

export type CaptureRuntimeConfig =
	| { enabled: false }
	| {
			enabled: true;
			hostId?: string;
			queueCapacity: number;
			heartbeatMs: number;
	  };

/**
 * Read the shared Observatory canary switch and Choreograph-local tuning.
 *
 * Activation is deliberately default-off. When it is off, service-specific
 * values are not parsed at all: merely deploying this code cannot alter the
 * pre-Observatory process or make malformed dormant tuning prevent startup.
 */
export function readCaptureRuntimeConfig(
	env: Readonly<Record<string, string | undefined>> = process.env,
): CaptureRuntimeConfig {
	const activation = env[OBSERVATORY_CAPTURE_ACTIVATION_ENV]?.trim().toLowerCase();
	if (activation === undefined || activation === "" || activation === "0" || activation === "false") {
		return { enabled: false };
	}
	if (activation !== "1" && activation !== "true") {
		throw new Error(`${OBSERVATORY_CAPTURE_ACTIVATION_ENV} must be one of: 0, false, 1, true`);
	}
	if (env[OBSERVATORY_CONTRACT_BUNDLE_SHA256_ENV] !== OBSERVATORY_CONTRACT_BUNDLE_SHA256) {
		throw new Error(
			`${OBSERVATORY_CONTRACT_BUNDLE_SHA256_ENV} must equal the baked CaptureEvent v0.3 bundle SHA-256 ${OBSERVATORY_CONTRACT_BUNDLE_SHA256}`,
		);
	}

	const hostId = env.OBSERVATORY_CAPTURE_HOST_ID?.trim() || env.EC2_INSTANCE_ID?.trim() || undefined;
	return {
		enabled: true,
		hostId,
		queueCapacity: parseEnvironmentInteger(
			env.OBSERVATORY_CAPTURE_QUEUE_CAPACITY,
			DEFAULT_CAPTURE_QUEUE_CAPACITY,
			1,
			Number.MAX_SAFE_INTEGER,
			"OBSERVATORY_CAPTURE_QUEUE_CAPACITY",
		),
		heartbeatMs: parseEnvironmentInteger(
			env.OBSERVATORY_CAPTURE_HEARTBEAT_MS,
			DEFAULT_CAPTURE_HEARTBEAT_MS,
			0,
			Number.MAX_SAFE_INTEGER,
			"OBSERVATORY_CAPTURE_HEARTBEAT_MS",
		),
	};
}

/** Construct the sole production fd-1 witness, or nothing when canary is off. */
export function createCaptureWriterFromEnv(
	env: Readonly<Record<string, string | undefined>> = process.env,
	sink: Writable = process.stdout,
): CaptureWriter | undefined {
	const config = readCaptureRuntimeConfig(env);
	if (!config.enabled) return undefined;
	return new CaptureWriter({
		sink,
		hostId: config.hostId,
		queueCapacity: config.queueCapacity,
		heartbeatMs: config.heartbeatMs,
	});
}

/** A bounded, synchronous, fail-soft CaptureEvent admission API. */
export class CaptureWriter {
	readonly witness: string;

	private readonly sink: Writable;
	private readonly queueCapacity: number;
	private readonly clock: () => number;
	private readonly idFactory: (timestampMs: number) => string;
	private readonly sequence = new BigUint64Array(new SharedArrayBuffer(BigUint64Array.BYTES_PER_ELEMENT));
	private readonly queue: string[] = [];
	private readonly idleWaiters = new Set<() => void>();
	private heartbeatTimer?: ReturnType<typeof setInterval>;
	private cancelDrainWait?: () => void;
	private emittedTotal = 0;
	private droppedTotal = 0;
	private inFlight = 0;
	private pumping = false;
	private disconnected = false;
	private closed = false;

	constructor(options: CaptureWriterOptions = {}) {
		this.sink = options.sink ?? process.stdout;
		this.queueCapacity = integerInRange(
			options.queueCapacity ?? DEFAULT_CAPTURE_QUEUE_CAPACITY,
			1,
			Number.MAX_SAFE_INTEGER,
			"queueCapacity",
		);
		this.clock = options.clock ?? Date.now;
		this.idFactory = options.idFactory ?? mintUlid;

		const hostId = options.hostId ?? hostname();
		if (!OPAQUE_ID_PATTERN.test(hostId)) {
			throw new Error("CaptureEvent hostId must be an opaque identifier");
		}
		const instanceId = options.instanceId ?? this.idFactory(this.clock());
		if (!ULID_PATTERN.test(instanceId)) {
			throw new Error("CaptureEvent instanceId must be a ULID");
		}
		this.witness = `choreograph:${hostId}/${instanceId}`;

		const heartbeatMs = integerInRange(
			options.heartbeatMs ?? DEFAULT_CAPTURE_HEARTBEAT_MS,
			0,
			Number.MAX_SAFE_INTEGER,
			"heartbeatMs",
		);

		// Writer-lifetime listeners make EPIPE a witness failure rather than an
		// uncaught process error. close()/disconnect() detach them so tests and
		// embedded lifecycles cannot accumulate listeners on a shared sink.
		this.sink.on("error", this.disconnect);
		this.sink.on("close", this.disconnect);

		if (heartbeatMs > 0) {
			this.heartbeatTimer = setInterval(() => this.emitHeartbeat(), heartbeatMs);
			this.heartbeatTimer.unref();
		}
	}

	/**
	 * Reserve sequence, build, serialize, and try-admit one event. This method
	 * never throws and never waits on the sink.
	 */
	emit(input: ChoreographCaptureEvent): void {
		this.admit(input, "agent");
	}

	/** Periodic loss evidence; public so deterministic tests can force a beat. */
	emitHeartbeat(): void {
		this.admit(
			{
				kind: "obs.heartbeat",
				principal: "service:choreograph",
				outcome: "ok",
				payload: {
					emittedTotal: this.emittedTotal,
					droppedTotal: this.droppedTotal,
				},
			},
			"service",
		);
	}

	get counters(): CaptureWriterCounters {
		return {
			emittedTotal: this.emittedTotal,
			droppedTotal: this.droppedTotal,
			nextSeq: Atomics.load(this.sequence, 0),
		};
	}

	/** Test/shutdown seam. Product-path emit remains entirely synchronous. */
	async whenIdle(timeoutMs = 1_000): Promise<boolean> {
		if (!this.pumping && this.inFlight === 0 && this.queue.length === 0) return true;
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const finish = (idle: boolean) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.idleWaiters.delete(onIdle);
				resolve(idle);
			};
			const onIdle = () => finish(true);
			const timer = setTimeout(() => finish(false), timeoutMs);
			// The caller is explicitly awaiting this deadline. Keeping it referenced
			// is what guarantees close()/whenIdle() settles even when the stalled
			// sink is the process's only other handle.
			this.idleWaiters.add(onIdle);
		});
	}

	async close(timeoutMs = 1_000): Promise<boolean> {
		this.closed = true;
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
		const idle = await this.whenIdle(timeoutMs);
		if (!idle) this.disconnect();
		this.detachSinkListeners();
		return idle;
	}

	private admit(input: ChoreographCaptureEvent | HeartbeatInput, clientClass: "agent" | "service"): void {
		const seqRaw = Atomics.add(this.sequence, 0, 1n);
		try {
			if (this.closed || this.disconnected) {
				this.droppedTotal++;
				return;
			}
			if (seqRaw > BigInt(Number.MAX_SAFE_INTEGER)) {
				this.droppedTotal++;
				return;
			}
			// Drop-newest backpressure is already decisive at capacity. Check it
			// before clocking, minting, validating, and serializing so a stalled sink
			// cannot turn the synchronous witness seam into expensive busy work.
			// `admit` is synchronous, so queue + inFlight cannot change underneath us.
			if (this.queue.length + this.inFlight >= this.queueCapacity) {
				this.droppedTotal++;
				return;
			}

			const ts = positiveInteger(this.clock(), "ts");
			const eventId = this.idFactory(ts);
			if (!ULID_PATTERN.test(eventId)) throw new Error("event_id");
			const line = serializeCaptureEvent(input, {
				eventId,
				ts,
				witness: this.witness,
				seq: Number(seqRaw),
				clientClass,
			});
			if (Buffer.byteLength(line, "utf8") > CAPTURE_MAX_LINE_BYTES) {
				this.droppedTotal++;
				return;
			}
			this.queue.push(line);
			this.emittedTotal++;
			this.schedulePump();
		} catch {
			this.droppedTotal++;
		}
	}

	private schedulePump(): void {
		if (this.pumping || this.disconnected) return;
		this.pumping = true;
		queueMicrotask(() => void this.pump());
	}

	private async pump(): Promise<void> {
		try {
			while (!this.disconnected) {
				const line = this.queue.shift();
				if (line === undefined) break;
				this.inFlight = 1;
				try {
					let belowHighWaterMark: boolean;
					try {
						belowHighWaterMark = this.sink.write(line, "utf8");
					} catch {
						this.disconnect();
						break;
					}
					if (!belowHighWaterMark && !(await this.waitForDrain())) break;
				} finally {
					this.inFlight = 0;
				}
			}
		} catch {
			this.disconnect();
		} finally {
			this.pumping = false;
			if (!this.disconnected && this.queue.length > 0) {
				this.schedulePump();
			} else {
				this.resolveIdle();
			}
		}
	}

	private waitForDrain(): Promise<boolean> {
		if (this.disconnected || this.sink.destroyed) return Promise.resolve(false);
		return new Promise<boolean>((resolve) => {
			let settled = false;
			const cleanup = () => {
				this.sink.off("drain", onDrain);
				this.sink.off("error", onFailure);
				this.sink.off("close", onFailure);
				if (this.cancelDrainWait === cancel) this.cancelDrainWait = undefined;
			};
			const finish = (drained: boolean) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(drained);
			};
			const onDrain = () => {
				finish(true);
			};
			const onFailure = () => {
				finish(false);
			};
			const cancel = () => finish(false);
			this.cancelDrainWait = cancel;
			this.sink.once("drain", onDrain);
			this.sink.once("error", onFailure);
			this.sink.once("close", onFailure);
		});
	}

	private readonly disconnect = (): void => {
		if (this.disconnected) return;
		this.disconnected = true;
		this.queue.length = 0;
		this.cancelDrainWait?.();
		this.detachSinkListeners();
		if (!this.pumping) this.resolveIdle();
	};

	private detachSinkListeners(): void {
		this.sink.off("error", this.disconnect);
		this.sink.off("close", this.disconnect);
	}

	private resolveIdle(): void {
		for (const resolve of this.idleWaiters) resolve();
		this.idleWaiters.clear();
	}
}

interface HeartbeatInput {
	kind: "obs.heartbeat";
	principal: "service:choreograph";
	outcome: "ok";
	payload: { emittedTotal: number; droppedTotal: number };
}

interface SerializationContext {
	eventId: string;
	ts: number;
	witness: string;
	seq: number;
	clientClass: "agent" | "service";
}

function serializeCaptureEvent(input: ChoreographCaptureEvent | HeartbeatInput, context: SerializationContext): string {
	assertExactKeys(
		input as unknown as Record<string, unknown>,
		input.kind === "obs.heartbeat"
			? ["kind", "principal", "outcome", "payload"]
			: [
					"kind",
					"principal",
					"onBehalfOf",
					"viaService",
					"authMethod",
					"graphId",
					"outcome",
					"durationMs",
					"payload",
				],
	);

	const principal = domainString(input.principal, PRINCIPAL_PATTERN, "principal");
	const envelope: Record<string, unknown> = {
		v: CAPTURE_WIRE_VERSION,
		event_id: context.eventId,
		ts: context.ts,
		witness: context.witness,
		kind: input.kind,
		principal,
	};

	if (input.kind !== "obs.heartbeat") {
		if (input.onBehalfOf !== undefined) {
			if (!principal.startsWith("service:")) throw new Error("delegation");
			envelope.on_behalf_of = domainString(input.onBehalfOf, SUBJECT_PATTERN, "on_behalf_of");
		}
		if (input.viaService !== undefined) {
			envelope.via_service = domainString(input.viaService, IDENTIFIER_PATTERN, "via_service");
		}
		if (input.authMethod !== undefined) {
			if (!(["cognito_jwt", "api_key", "service_token", "signed_url", "none"] as const).includes(input.authMethod)) {
				throw new Error("auth_method");
			}
			envelope.auth_method = input.authMethod;
		}
	}

	envelope.client_class = context.clientClass;
	if (input.kind !== "obs.heartbeat" && input.graphId !== undefined) {
		envelope.graph_id = domainString(input.graphId, GRAPH_ID_PATTERN, "graph_id");
	}
	if (!(["ok", "denied", "error", "timeout"] as const).includes(input.outcome)) throw new Error("outcome");
	envelope.outcome = input.outcome;
	if (input.kind !== "obs.heartbeat" && input.durationMs !== undefined) {
		envelope.duration_ms = nonnegativeInteger(input.durationMs, "duration_ms");
	}
	envelope.seq = nonnegativeInteger(context.seq, "seq");
	envelope.payload = buildPayload(input);
	return `${JSON.stringify(envelope)}\n`;
}

function buildPayload(input: ChoreographCaptureEvent | HeartbeatInput): Record<string, unknown> {
	switch (input.kind) {
		case "llm.call": {
			assertExactKeys(input.payload as unknown as Record<string, unknown>, [
				"model",
				"inputTokens",
				"outputTokens",
				"totalTokens",
				"cacheReadTokens",
				"cacheWriteTokens",
				"costMicroUsd",
			]);
			const payload: Record<string, unknown> = {
				model: domainString(input.payload.model, MODEL_ID_PATTERN, "model"),
				input_tokens: nonnegativeInteger(input.payload.inputTokens, "input_tokens"),
				output_tokens: nonnegativeInteger(input.payload.outputTokens, "output_tokens"),
				total_tokens: nonnegativeInteger(input.payload.totalTokens, "total_tokens"),
			};
			if (input.payload.cacheReadTokens !== undefined) {
				payload.cache_read_tokens = nonnegativeInteger(input.payload.cacheReadTokens, "cache_read_tokens");
			}
			if (input.payload.cacheWriteTokens !== undefined) {
				payload.cache_write_tokens = nonnegativeInteger(input.payload.cacheWriteTokens, "cache_write_tokens");
			}
			if (input.payload.costMicroUsd !== undefined) {
				payload.cost_micro_usd = nonnegativeInteger(input.payload.costMicroUsd, "cost_micro_usd");
			}
			return payload;
		}
		case "sandbox.spawn":
			assertExactKeys(input.payload as unknown as Record<string, unknown>, ["template", "sandboxId"]);
			return {
				template: domainString(input.payload.template, IDENTIFIER_PATTERN, "template"),
				sandbox_id: domainString(input.payload.sandboxId, OPAQUE_ID_PATTERN, "sandbox_id"),
			};
		case "agent.turn": {
			assertExactKeys(input.payload as unknown as Record<string, unknown>, [
				"template",
				"sandboxId",
				"stepIndex",
				"toolCount",
			]);
			const payload: Record<string, unknown> = {
				template: domainString(input.payload.template, IDENTIFIER_PATTERN, "template"),
				sandbox_id: domainString(input.payload.sandboxId, OPAQUE_ID_PATTERN, "sandbox_id"),
			};
			if (input.payload.stepIndex !== undefined) {
				payload.step_index = nonnegativeInteger(input.payload.stepIndex, "step_index");
			}
			if (input.payload.toolCount !== undefined) {
				payload.tool_count = nonnegativeInteger(input.payload.toolCount, "tool_count");
			}
			return payload;
		}
		case "chat.turn": {
			assertExactKeys(input.payload as unknown as Record<string, unknown>, ["messageBytes", "turnIndex", "model"]);
			const payload: Record<string, unknown> = {
				message_bytes: nonnegativeInteger(input.payload.messageBytes, "message_bytes"),
			};
			if (input.payload.turnIndex !== undefined) {
				payload.turn_index = nonnegativeInteger(input.payload.turnIndex, "turn_index");
			}
			if (input.payload.model !== undefined) {
				payload.model = domainString(input.payload.model, MODEL_ID_PATTERN, "model");
			}
			return payload;
		}
		case "sandbox.reap": {
			assertExactKeys(input.payload as unknown as Record<string, unknown>, [
				"template",
				"sandboxId",
				"reason",
				"exitCode",
				"memoryPeakBytes",
				"cpuUsageUs",
			]);
			const payload: Record<string, unknown> = {
				template: domainString(input.payload.template, IDENTIFIER_PATTERN, "template"),
				sandbox_id: domainString(input.payload.sandboxId, OPAQUE_ID_PATTERN, "sandbox_id"),
				reason: domainString(input.payload.reason, IDENTIFIER_PATTERN, "reason"),
			};
			if (input.payload.exitCode !== undefined) payload.exit_code = integer(input.payload.exitCode, "exit_code");
			if (input.payload.memoryPeakBytes !== undefined) {
				payload.memory_peak_bytes = nonnegativeInteger(input.payload.memoryPeakBytes, "memory_peak_bytes");
			}
			if (input.payload.cpuUsageUs !== undefined) {
				payload.cpu_usage_us = nonnegativeInteger(input.payload.cpuUsageUs, "cpu_usage_us");
			}
			return payload;
		}
		case "capability.call":
			assertExactKeys(input.payload as unknown as Record<string, unknown>, [
				"runId",
				"sandboxId",
				"callId",
				"capability",
				"tool",
			]);
			return {
				run_id: domainString(input.payload.runId, OPAQUE_ID_PATTERN, "run_id"),
				sandbox_id: domainString(input.payload.sandboxId, OPAQUE_ID_PATTERN, "sandbox_id"),
				call_id: domainString(input.payload.callId, OPAQUE_ID_PATTERN, "call_id"),
				capability: domainString(input.payload.capability, TOOL_NAME_PATTERN, "capability"),
				tool: domainString(input.payload.tool, TOOL_NAME_PATTERN, "tool"),
			};
		case "test.beat":
			assertExactKeys(input.payload as unknown as Record<string, unknown>, [
				"runId",
				"scenarioId",
				"beatId",
				"engine",
				"operation",
				"actionCount",
				"evidenceUri",
				"evidenceSha256",
			]);
			return {
				run_id: domainString(input.payload.runId, OPAQUE_ID_PATTERN, "run_id"),
				scenario_id: domainString(input.payload.scenarioId, OPAQUE_ID_PATTERN, "scenario_id"),
				beat_id: domainString(input.payload.beatId, OPAQUE_ID_PATTERN, "beat_id"),
				engine: enumString(input.payload.engine, ["chromium", "camoufox"], "engine"),
				operation: enumString(
					input.payload.operation,
					["create", "type", "edit-block", "concurrent-edit", "rename", "list", "delete-later"],
					"operation",
				),
				action_count: nonnegativeInteger(input.payload.actionCount, "action_count"),
				evidence_uri: domainString(input.payload.evidenceUri, EVIDENCE_URI_PATTERN, "evidence_uri"),
				evidence_sha256: domainString(input.payload.evidenceSha256, SHA256_PATTERN, "evidence_sha256"),
			};
		case "test.verdict": {
			assertExactKeys(input.payload as unknown as Record<string, unknown>, [
				"runId",
				"scenarioId",
				"invariant",
				"passed",
				"verdictCode",
				"beatId",
				"engine",
				"evidenceUri",
				"evidenceSha256",
				"observedMs",
				"maximumMs",
			]);
			const payload: Record<string, unknown> = {
				run_id: domainString(input.payload.runId, OPAQUE_ID_PATTERN, "run_id"),
				scenario_id: domainString(input.payload.scenarioId, OPAQUE_ID_PATTERN, "scenario_id"),
				invariant: enumString(
					input.payload.invariant,
					["I1", "I2", "I3", "I4", "I5", "L1", "L2-primary", "L2-foreign"],
					"invariant",
				),
				passed: boolean(input.payload.passed, "passed"),
				verdict_code: domainString(input.payload.verdictCode, IDENTIFIER_PATTERN, "verdict_code"),
			};
			if (input.payload.beatId !== undefined) {
				payload.beat_id = domainString(input.payload.beatId, OPAQUE_ID_PATTERN, "beat_id");
			}
			if (input.payload.engine !== undefined) {
				payload.engine = enumString(input.payload.engine, ["chromium", "camoufox"], "engine");
			}
			if (input.payload.evidenceUri !== undefined) {
				payload.evidence_uri = domainString(input.payload.evidenceUri, EVIDENCE_URI_PATTERN, "evidence_uri");
			}
			if (input.payload.evidenceSha256 !== undefined) {
				payload.evidence_sha256 = domainString(input.payload.evidenceSha256, SHA256_PATTERN, "evidence_sha256");
			}
			if ((input.payload.evidenceUri === undefined) !== (input.payload.evidenceSha256 === undefined)) {
				throw new Error("evidence_ref");
			}
			if (input.payload.observedMs !== undefined) {
				payload.observed_ms = nonnegativeInteger(input.payload.observedMs, "observed_ms");
			}
			if (input.payload.maximumMs !== undefined) {
				payload.maximum_ms = nonnegativeInteger(input.payload.maximumMs, "maximum_ms");
			}
			return payload;
		}
		case "site.mint":
		case "site.route":
		case "site.publish":
		case "site.retire": {
			assertExactKeys(input.payload as unknown as Record<string, unknown>, [
				"effectKey",
				"sourceTurnDigest",
				"proposalDigest",
				"executionDigest",
				"grantDigest",
				"publicName",
				"interpreterDigest",
				"reasonCode",
			]);
			const payload: Record<string, unknown> = {
				effect_key: domainString(input.payload.effectKey, OPAQUE_ID_PATTERN, "effect_key"),
				source_turn_digest: domainString(input.payload.sourceTurnDigest, SHA256_PATTERN, "source_turn_digest"),
				proposal_digest: domainString(input.payload.proposalDigest, SHA256_PATTERN, "proposal_digest"),
				execution_digest: domainString(input.payload.executionDigest, SHA256_PATTERN, "execution_digest"),
				grant_digest: domainString(input.payload.grantDigest, SHA256_PATTERN, "grant_digest"),
				public_name: domainString(input.payload.publicName, ROUTE_LABEL_PATTERN, "public_name"),
			};
			if (input.payload.interpreterDigest !== undefined) {
				payload.interpreter_digest = domainString(
					input.payload.interpreterDigest,
					SHA256_PATTERN,
					"interpreter_digest",
				);
			}
			if (input.payload.reasonCode !== undefined) {
				payload.reason_code = domainString(input.payload.reasonCode, IDENTIFIER_PATTERN, "reason_code");
			}
			return payload;
		}
		case "obs.heartbeat":
			assertExactKeys(input.payload as unknown as Record<string, unknown>, ["emittedTotal", "droppedTotal"]);
			return {
				emitted_total: nonnegativeInteger(input.payload.emittedTotal, "emitted_total"),
				dropped_total: nonnegativeInteger(input.payload.droppedTotal, "dropped_total"),
			};
	}
}

function enumString<const T extends string>(value: unknown, allowed: readonly T[], field: string): T {
	if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(field);
	return value as T;
}

function boolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") throw new Error(field);
	return value;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("object");
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedSet.has(key)) throw new Error(`unknown field: ${key}`);
		if (value[key] === null) throw new Error(`null field: ${key}`);
	}
}

function domainString(value: unknown, pattern: RegExp, field: string): string {
	if (typeof value !== "string" || !pattern.test(value)) throw new Error(field);
	return value;
}

function integer(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value)) throw new Error(field);
	return value as number;
}

function nonnegativeInteger(value: unknown, field: string): number {
	const result = integer(value, field);
	if (result < 0) throw new Error(field);
	return result;
}

function positiveInteger(value: unknown, field: string): number {
	const result = integer(value, field);
	if (result <= 0) throw new Error(field);
	return result;
}

function integerInRange(value: unknown, min: number, max: number, field: string): number {
	const result = integer(value, field);
	if (result < min || result > max) throw new Error(field);
	return result;
}

function parseEnvironmentInteger(
	value: string | undefined,
	fallback: number,
	min: number,
	max: number,
	field: string,
): number {
	if (value === undefined || value.trim() === "") return fallback;
	const normalized = value.trim();
	if (!/^(0|[1-9][0-9]*)$/.test(normalized)) throw new Error(`${field} must be a base-10 integer`);
	return integerInRange(Number(normalized), min, max, field);
}

export function mintUlid(timestampMs = Date.now()): string {
	integerInRange(timestampMs, 0, 2 ** 48 - 1, "ULID timestamp");
	let randomness = 0n;
	for (const byte of randomBytes(10)) randomness = (randomness << 8n) | BigInt(byte);
	return `${encodeCrockford(BigInt(timestampMs), 10)}${encodeCrockford(randomness, 16)}`;
}

function encodeCrockford(value: bigint, width: number): string {
	let output = "";
	let remaining = value;
	for (let i = 0; i < width; i++) {
		output = CROCKFORD[Number(remaining & 31n)] + output;
		remaining >>= 5n;
	}
	if (remaining !== 0n) throw new Error("Crockford value exceeds width");
	return output;
}
