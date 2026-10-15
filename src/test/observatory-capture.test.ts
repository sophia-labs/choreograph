import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	CAPTURE_MAX_LINE_BYTES,
	CaptureWriter,
	type ChoreographCaptureEvent,
	createCaptureWriterFromEnv,
	mintUlid,
	OBSERVATORY_CAPTURE_ACTIVATION_ENV,
	OBSERVATORY_CONTRACT_BUNDLE_SHA256,
	OBSERVATORY_CONTRACT_BUNDLE_SHA256_ENV,
	readCaptureRuntimeConfig,
} from "../observatory-capture.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(TEST_DIR, "../..");
const REVIEWED_FIXTURE = resolve(TEST_DIR, "fixtures/observatory-choreograph.valid.ndjson");
const HOST_FIXTURE = resolve(TEST_DIR, "fixtures/observatory-capture-host.ts");

const REVIEWED_LINES = readFileSync(REVIEWED_FIXTURE, "utf8");

const CANONICAL_KEYS = [
	"v",
	"event_id",
	"ts",
	"witness",
	"kind",
	"principal",
	"on_behalf_of",
	"via_service",
	"auth_method",
	"client_class",
	"graph_id",
	"outcome",
	"duration_ms",
	"seq",
	"payload",
] as const;

const CHOREOGRAPH_PAYLOAD_KEYS: Readonly<Record<string, readonly string[]>> = {
	"agent.turn": ["template", "sandbox_id", "step_index", "tool_count"],
	"chat.turn": ["message_bytes", "turn_index", "model"],
	"llm.call": [
		"model",
		"input_tokens",
		"output_tokens",
		"total_tokens",
		"cache_read_tokens",
		"cache_write_tokens",
		"cost_micro_usd",
	],
	"sandbox.reap": ["template", "sandbox_id", "reason", "exit_code", "memory_peak_bytes", "cpu_usage_us"],
	"sandbox.spawn": ["template", "sandbox_id"],
	"capability.call": ["run_id", "sandbox_id", "call_id", "capability", "tool"],
	"test.beat": [
		"run_id",
		"scenario_id",
		"beat_id",
		"engine",
		"operation",
		"action_count",
		"evidence_uri",
		"evidence_sha256",
	],
	"test.verdict": [
		"run_id",
		"scenario_id",
		"invariant",
		"passed",
		"verdict_code",
		"beat_id",
		"engine",
		"evidence_uri",
		"evidence_sha256",
		"observed_ms",
		"maximum_ms",
	],
	"site.mint": [
		"effect_key",
		"source_turn_digest",
		"proposal_digest",
		"execution_digest",
		"grant_digest",
		"public_name",
		"interpreter_digest",
		"reason_code",
	],
	"site.route": [
		"effect_key",
		"source_turn_digest",
		"proposal_digest",
		"execution_digest",
		"grant_digest",
		"public_name",
		"interpreter_digest",
		"reason_code",
	],
	"site.publish": [
		"effect_key",
		"source_turn_digest",
		"proposal_digest",
		"execution_digest",
		"grant_digest",
		"public_name",
		"interpreter_digest",
		"reason_code",
	],
	"site.retire": [
		"effect_key",
		"source_turn_digest",
		"proposal_digest",
		"execution_digest",
		"grant_digest",
		"public_name",
		"interpreter_digest",
		"reason_code",
	],
};

function validateNativeCaptureStream(stream: string): {
	accepted: number;
	kinds: Record<string, number>;
} {
	assert.ok(stream.endsWith("\n"), "CaptureEvent stream must end at a line boundary");
	const lines = stream.trimEnd().split("\n");
	assert.ok(lines.length > 0, "CaptureEvent stream must not be empty");
	const kinds: Record<string, number> = {};

	for (const [index, line] of lines.entries()) {
		assert.ok(Buffer.byteLength(line, "utf8") <= CAPTURE_MAX_LINE_BYTES);
		const event = JSON.parse(line) as Record<string, unknown>;
		assert.deepEqual(
			Object.keys(event),
			CANONICAL_KEYS.filter((key) => Object.hasOwn(event, key)),
			`line ${index + 1} is not in canonical key order`,
		);
		assert.equal(event.v, 1);
		assert.match(String(event.event_id), /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
		assert.equal(typeof event.ts, "number");
		assert.match(String(event.witness), /^choreograph:[^/\s]+\/[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
		assert.equal(event.principal, "service:choreograph");
		assert.equal(event.client_class, "agent");
		assert.ok(["ok", "denied", "error", "timeout"].includes(String(event.outcome)));
		assert.equal(event.seq, index);

		const kind = String(event.kind);
		const allowedPayloadKeys = CHOREOGRAPH_PAYLOAD_KEYS[kind];
		assert.ok(allowedPayloadKeys, `line ${index + 1} has unauthorized Choreograph kind ${kind}`);
		assert.equal(typeof event.payload, "object");
		assert.ok(event.payload !== null && !Array.isArray(event.payload));
		for (const key of Object.keys(event.payload as Record<string, unknown>)) {
			assert.ok(allowedPayloadKeys.includes(key), `line ${index + 1} has unknown ${kind} payload field ${key}`);
		}
		kinds[kind] = (kinds[kind] ?? 0) + 1;
	}

	return { accepted: lines.length, kinds };
}

class StalledWritable extends Writable {
	private callbacks: Array<(error?: Error | null) => void> = [];
	readonly chunks: Buffer[] = [];

	constructor() {
		super({ highWaterMark: 1 });
	}

	_write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.chunks.push(Buffer.from(chunk));
		this.callbacks.push(callback);
	}

	releaseAll(): void {
		for (const callback of this.callbacks.splice(0)) callback();
	}
}

class BrokenWritable extends Writable {
	_write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		callback(new Error("broken pipe"));
	}
}

function fixtureEvents(): ChoreographCaptureEvent[] {
	const identity = {
		principal: "service:choreograph",
		onBehalfOf: "user-alpha-0001",
		graphId: "organism-dev",
	} as const;
	return [
		{
			kind: "llm.call",
			...identity,
			viaService: "choreograph",
			authMethod: "service_token",
			outcome: "ok",
			durationMs: 240,
			payload: {
				model: "openrouter/deepseek-v4-pro",
				inputTokens: 20,
				outputTokens: 10,
				totalTokens: 30,
				costMicroUsd: 42,
			},
		},
		{
			kind: "sandbox.spawn",
			...identity,
			outcome: "ok",
			durationMs: 83,
			payload: { template: "agent", sandboxId: "sbx-alpha-0001" },
		},
		{
			kind: "agent.turn",
			...identity,
			outcome: "ok",
			durationMs: 920,
			payload: { template: "agent", sandboxId: "sbx-alpha-0001", stepIndex: 0, toolCount: 2 },
		},
		{
			kind: "sandbox.reap",
			...identity,
			outcome: "ok",
			durationMs: 1100,
			payload: {
				template: "agent",
				sandboxId: "sbx-alpha-0001",
				reason: "completed",
				exitCode: 0,
				memoryPeakBytes: 67_108_864,
				cpuUsageUs: 810_000,
			},
		},
		{
			kind: "chat.turn",
			...identity,
			viaService: "choreograph",
			authMethod: "service_token",
			outcome: "ok",
			durationMs: 930,
			payload: { messageBytes: 128, turnIndex: 1, model: "openrouter/deepseek-v4-pro" },
		},
		{
			kind: "capability.call",
			...identity,
			outcome: "ok",
			durationMs: 27,
			payload: {
				runId: "run-1",
				sandboxId: "sbx-alpha-0001",
				callId: "gate-1",
				capability: "browser.camoufox",
				tool: "capture_beat",
			},
		},
		{
			kind: "test.beat",
			...identity,
			outcome: "ok",
			durationMs: 930,
			payload: {
				runId: "run-1",
				scenarioId: "scenario-1",
				beatId: "beat-1",
				engine: "camoufox",
				operation: "edit-block",
				actionCount: 2,
				evidenceUri: `s3://sophia-observatory-evidence/run-1/scenario-1/beat-1/camoufox/manifest-${"a".repeat(64)}.json`,
				evidenceSha256: "a".repeat(64),
			},
		},
		{
			kind: "test.verdict",
			...identity,
			outcome: "error",
			payload: {
				runId: "run-1",
				scenarioId: "scenario-1",
				invariant: "I5",
				passed: false,
				verdictCode: "projection_timeout",
				beatId: "beat-1",
				engine: "camoufox",
				evidenceUri: `s3://sophia-observatory-evidence/run-1/scenario-1/beat-1/camoufox/manifest-${"a".repeat(64)}.json`,
				evidenceSha256: "a".repeat(64),
				observedMs: 930,
				maximumMs: 500,
			},
		},
		...(["site.mint", "site.route", "site.publish", "site.retire"] as const).map((kind, index) => ({
			kind,
			...identity,
			viaService: "choreograph" as const,
			authMethod: "service_token" as const,
			outcome: (kind === "site.retire" ? "error" : "ok") as "error" | "ok",
			durationMs: [121, 121, 18, 9][index],
			payload: {
				effectKey: `effect:${"a".repeat(64)}`,
				sourceTurnDigest: "b".repeat(64),
				proposalDigest: "c".repeat(64),
				executionDigest: "d".repeat(64),
				grantDigest: "e".repeat(64),
				publicName: "site-shrub1-demo",
				interpreterDigest: "f".repeat(64),
				...(kind === "site.retire" ? { reasonCode: "retirement-delayed" } : {}),
			},
		})),
	];
}

function deterministicWriter(sink: Writable): CaptureWriter {
	const ids = [
		"01J00000000000000000000002",
		"01J0000000000000000000000P",
		"01J0000000000000000000000Q",
		"01J0000000000000000000000R",
		"01J00000000000000000000012",
		"01J00000000000000000000013",
		"01J00000000000000000000014",
		"01J00000000000000000000015",
		"01J00000000000000000000016",
		"01J00000000000000000000017",
		"01J00000000000000000000018",
		"01J00000000000000000000019",
	];
	const times = [
		1783890000002, 1783890000022, 1783890000023, 1783890000024, 1783890000027, 1783890000028, 1783890000029,
		1783890000030, 1783890000031, 1783890000032, 1783890000033, 1783890000034,
	];
	let idIndex = 0;
	let timeIndex = 0;
	return new CaptureWriter({
		sink,
		hostId: "host-a",
		instanceId: "01J0000000000000000000000B",
		heartbeatMs: 0,
		clock: () => times[timeIndex++],
		idFactory: () => ids[idIndex++],
	});
}

describe("Observatory CaptureWriter", { concurrency: false }, () => {
	it("is default-off and does not parse dormant service-specific tuning", () => {
		assert.deepEqual(readCaptureRuntimeConfig({}), { enabled: false });
		assert.deepEqual(
			readCaptureRuntimeConfig({
				[OBSERVATORY_CAPTURE_ACTIVATION_ENV]: "false",
				[OBSERVATORY_CONTRACT_BUNDLE_SHA256_ENV]: "not-read-while-disabled",
				OBSERVATORY_CAPTURE_QUEUE_CAPACITY: "not-an-integer",
				OBSERVATORY_CAPTURE_HOST_ID: "not a valid host id",
			}),
			{ enabled: false },
		);
		const sink = new PassThrough();
		assert.equal(createCaptureWriterFromEnv({}, sink), undefined);
		assert.equal(sink.listenerCount("error"), 0);
		assert.equal(sink.listenerCount("close"), 0);
	});

	it("requires an explicit valid shared canary switch", () => {
		assert.throws(
			() => readCaptureRuntimeConfig({ [OBSERVATORY_CAPTURE_ACTIVATION_ENV]: "yes" }),
			new RegExp(OBSERVATORY_CAPTURE_ACTIVATION_ENV),
		);
		assert.throws(
			() =>
				readCaptureRuntimeConfig({
					[OBSERVATORY_CAPTURE_ACTIVATION_ENV]: "1",
					[OBSERVATORY_CONTRACT_BUNDLE_SHA256_ENV]: OBSERVATORY_CONTRACT_BUNDLE_SHA256,
					OBSERVATORY_CAPTURE_QUEUE_CAPACITY: "2.5",
				}),
			/OBSERVATORY_CAPTURE_QUEUE_CAPACITY/,
		);
	});

	it("requires the exact ratified contract-bundle pin before taking sink ownership", () => {
		assert.equal(
			OBSERVATORY_CONTRACT_BUNDLE_SHA256,
			"c60d81fe4b431c3a88bd2450189a16da97627cc6ba36c4b127942d593a6c2bbb",
		);
		const sink = new PassThrough();
		const baseline = {
			error: sink.listenerCount("error"),
			close: sink.listenerCount("close"),
		};
		for (const pin of [undefined, OBSERVATORY_CONTRACT_BUNDLE_SHA256.toUpperCase(), "0".repeat(64)]) {
			assert.throws(
				() =>
					createCaptureWriterFromEnv(
						{
							[OBSERVATORY_CAPTURE_ACTIVATION_ENV]: "true",
							[OBSERVATORY_CONTRACT_BUNDLE_SHA256_ENV]: pin,
						},
						sink,
					),
				new RegExp(OBSERVATORY_CONTRACT_BUNDLE_SHA256_ENV),
			);
			assert.deepEqual(
				{
					error: sink.listenerCount("error"),
					close: sink.listenerCount("close"),
				},
				baseline,
			);
		}
	});

	it("constructs an enabled writer from bounded Choreograph-local tuning", async () => {
		const sink = new PassThrough();
		const writer = createCaptureWriterFromEnv(
			{
				[OBSERVATORY_CAPTURE_ACTIVATION_ENV]: "true",
				[OBSERVATORY_CONTRACT_BUNDLE_SHA256_ENV]: OBSERVATORY_CONTRACT_BUNDLE_SHA256,
				EC2_INSTANCE_ID: "i-0123456789abcdef0",
				OBSERVATORY_CAPTURE_QUEUE_CAPACITY: "7",
				OBSERVATORY_CAPTURE_HEARTBEAT_MS: "0",
			},
			sink,
		);
		assert.ok(writer);
		assert.match(writer.witness, /^choreograph:i-0123456789abcdef0\/[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
		assert.equal(await writer.close(), true);
	});

	it("reproduces all reviewed Choreograph fixtures byte for byte", async () => {
		const sink = new PassThrough();
		let output = "";
		sink.setEncoding("utf8");
		sink.on("data", (chunk: string) => {
			output += chunk;
		});
		const writer = deterministicWriter(sink);
		for (const event of fixtureEvents()) writer.emit(event);
		assert.equal(await writer.close(), true);
		assert.equal(output, REVIEWED_LINES);
	});

	it("keeps its reviewed native fixture inside the ratified contract lock", () => {
		assert.equal(
			OBSERVATORY_CONTRACT_BUNDLE_SHA256,
			"c60d81fe4b431c3a88bd2450189a16da97627cc6ba36c4b127942d593a6c2bbb",
		);
		assert.deepEqual(validateNativeCaptureStream(REVIEWED_LINES), {
			accepted: 12,
			kinds: {
				"agent.turn": 1,
				"capability.call": 1,
				"chat.turn": 1,
				"llm.call": 1,
				"sandbox.reap": 1,
				"sandbox.spawn": 1,
				"site.mint": 1,
				"site.publish": 1,
				"site.retire": 1,
				"site.route": 1,
				"test.beat": 1,
				"test.verdict": 1,
			},
		});
	});

	it("keeps every admitted event at or below the 4 KiB wire bound", async () => {
		const sink = new PassThrough();
		const chunks: Buffer[] = [];
		sink.on("data", (chunk: Buffer) => chunks.push(chunk));
		const writer = new CaptureWriter({ sink, hostId: "h".repeat(127), heartbeatMs: 0 });
		writer.emit({
			kind: "sandbox.reap",
			principal: `u${"x".repeat(255)}`,
			graphId: `g${"x".repeat(127)}`,
			outcome: "error",
			durationMs: Number.MAX_SAFE_INTEGER,
			payload: {
				template: `a${"x".repeat(63)}`,
				sandboxId: `s${"x".repeat(127)}`,
				reason: `r${"x".repeat(63)}`,
				exitCode: Number.MIN_SAFE_INTEGER,
				memoryPeakBytes: Number.MAX_SAFE_INTEGER,
				cpuUsageUs: Number.MAX_SAFE_INTEGER,
			},
		});
		assert.equal(await writer.close(), true);
		const line = Buffer.concat(chunks);
		assert.ok(line.byteLength > 0);
		assert.ok(line.byteLength <= CAPTURE_MAX_LINE_BYTES, `${line.byteLength} > ${CAPTURE_MAX_LINE_BYTES}`);
	});

	it("makes content-bearing and malformed inputs unrepresentable at runtime", async () => {
		const sink = new PassThrough();
		let output = "";
		sink.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		const writer = new CaptureWriter({ sink, hostId: "host-a", heartbeatMs: 0 });
		const base = fixtureEvents()[0];
		writer.emit({ ...base, prompt: "secret" } as ChoreographCaptureEvent);
		writer.emit({ ...base, payload: { ...base.payload, result: "secret" } } as ChoreographCaptureEvent);
		writer.emit({
			...base,
			payload: { ...base.payload, model: "secret prompt with spaces" },
		} as ChoreographCaptureEvent);
		writer.emit({
			...base,
			payload: { ...base.payload, model: "~" },
		} as ChoreographCaptureEvent);
		assert.equal(await writer.close(), true);
		assert.equal(output, "");
		assert.deepEqual(writer.counters, { emittedTotal: 0, droppedTotal: 4, nextSeq: 4n });
	});

	it("accepts an OpenRouter-style alias model id with a leading tilde", async () => {
		const sink = new PassThrough();
		let output = "";
		sink.on("data", (chunk: Buffer) => {
			output += chunk.toString("utf8");
		});
		const writer = new CaptureWriter({ sink, hostId: "host-a", heartbeatMs: 0 });
		const base = fixtureEvents()[0];
		writer.emit({
			...base,
			payload: { ...base.payload, model: "~openai/gpt-mini-latest" },
		} as ChoreographCaptureEvent);
		assert.equal(await writer.close(), true);
		assert.deepEqual(writer.counters, { emittedTotal: 1, droppedTotal: 0, nextSeq: 1n });
		assert.ok(output.includes("~openai/gpt-mini-latest"));
	});

	it("drops newest under a stalled Writable without blocking or unbounded admission", async () => {
		const sink = new StalledWritable();
		const writer = new CaptureWriter({ sink, hostId: "host-a", queueCapacity: 1, heartbeatMs: 0 });
		const event = fixtureEvents()[1];
		writer.emit(event); // the one admitted line moves in-flight
		await new Promise<void>((resolve) => setImmediate(resolve));
		writer.emit(event); // dropped: in-flight is part of queueCapacity
		const startedAt = performance.now();
		for (let i = 0; i < 1_000; i++) writer.emit(event);
		const elapsedMs = performance.now() - startedAt;
		assert.ok(elapsedMs < 1_000, `emit path stalled for ${elapsedMs.toFixed(1)}ms`);
		assert.equal(writer.counters.emittedTotal, 1, "capacity includes the in-flight sink write");
		assert.equal(writer.counters.droppedTotal, 1_001);
		assert.equal(writer.counters.nextSeq, 1_002n);
		assert.ok(sink.writableLength <= CAPTURE_MAX_LINE_BYTES);
		assert.equal(await writer.whenIdle(5), false);
		sink.releaseAll();
		assert.equal(await writer.close(), true);
	});

	it("exposes sequence gaps and cumulative loss in a later heartbeat", async () => {
		const sink = new StalledWritable();
		const writer = new CaptureWriter({ sink, hostId: "host-a", queueCapacity: 2, heartbeatMs: 0 });
		const event = fixtureEvents()[1];
		writer.emit(event); // seq 0, in sink
		await new Promise<void>((resolve) => setImmediate(resolve));
		writer.emit(event); // seq 1, queued
		writer.emit(event); // seq 2, dropped
		writer.emitHeartbeat(); // seq 3, dropped
		assert.deepEqual(writer.counters, { emittedTotal: 2, droppedTotal: 2, nextSeq: 4n });
		sink.releaseAll();
		await new Promise<void>((resolve) => setImmediate(resolve));
		sink.releaseAll();
		assert.equal(await writer.whenIdle(), true);
		writer.emitHeartbeat(); // seq 4, contains counters as observed before admission
		await new Promise<void>((resolve) => setImmediate(resolve));
		sink.releaseAll();
		assert.equal(await writer.close(), true);
		const events = Buffer.concat(sink.chunks)
			.toString("utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		assert.deepEqual(
			events.map((event) => event.seq),
			[0, 1, 4],
		);
		assert.deepEqual(events[2].payload, { emitted_total: 2, dropped_total: 2 });
	});

	it("treats a broken stdout sink as a soft witness failure", async () => {
		const sink = new BrokenWritable();
		const baselineErrorListeners = sink.listenerCount("error");
		const baselineCloseListeners = sink.listenerCount("close");
		const writer = new CaptureWriter({ sink, hostId: "host-a", heartbeatMs: 0 });
		assert.doesNotThrow(() => writer.emit(fixtureEvents()[1]));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.doesNotThrow(() => writer.emit(fixtureEvents()[1]));
		assert.deepEqual(writer.counters, { emittedTotal: 1, droppedTotal: 1, nextSeq: 2n });
		assert.equal(await writer.close(), true);
		assert.equal(sink.listenerCount("error"), baselineErrorListeners);
		assert.equal(sink.listenerCount("close"), baselineCloseListeners);
	});

	it("cleans permanent and drain listeners across repeated writer lifecycles", async () => {
		const sink = new PassThrough();
		const baseline = {
			drain: sink.listenerCount("drain"),
			error: sink.listenerCount("error"),
			close: sink.listenerCount("close"),
		};
		for (let i = 0; i < 25; i++) {
			const writer = new CaptureWriter({ sink, hostId: "host-a", heartbeatMs: 0 });
			assert.equal(sink.listenerCount("error"), baseline.error + 1);
			assert.equal(sink.listenerCount("close"), baseline.close + 1);
			writer.emit(fixtureEvents()[1]);
			assert.equal(await writer.close(), true);
			assert.deepEqual(
				{
					drain: sink.listenerCount("drain"),
					error: sink.listenerCount("error"),
					close: sink.listenerCount("close"),
				},
				baseline,
			);
		}
	});

	it("does not attach sink listeners when constructor validation rejects", () => {
		const sink = new PassThrough();
		const baseline = {
			error: sink.listenerCount("error"),
			close: sink.listenerCount("close"),
		};
		assert.throws(() => new CaptureWriter({ sink, hostId: "host-a", heartbeatMs: -1 }), /heartbeatMs/);
		assert.deepEqual(
			{
				error: sink.listenerCount("error"),
				close: sink.listenerCount("close"),
			},
			baseline,
		);
	});

	it("cancels a stalled drain wait and removes every listener on close timeout", async () => {
		const sink = new StalledWritable();
		const baseline = {
			drain: sink.listenerCount("drain"),
			error: sink.listenerCount("error"),
			close: sink.listenerCount("close"),
		};
		const writer = new CaptureWriter({ sink, hostId: "host-a", queueCapacity: 1, heartbeatMs: 0 });
		writer.emit(fixtureEvents()[1]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(await writer.close(5), false);
		assert.deepEqual(
			{
				drain: sink.listenerCount("drain"),
				error: sink.listenerCount("error"),
				close: sink.listenerCount("close"),
			},
			baseline,
		);
		sink.releaseAll();
	});

	it("mints wire-valid ULIDs", () => {
		assert.match(mintUlid(1_783_890_000_000), /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
	});

	it("emits from a real host process and passes the native contract gate", () => {
		const host = spawnSync(process.execPath, ["--import", "tsx", HOST_FIXTURE], {
			cwd: WORKSPACE_ROOT,
			encoding: "utf8",
		});
		assert.equal(host.status, 0, host.stderr);
		assert.equal(host.stdout, REVIEWED_LINES);
		assert.deepEqual(validateNativeCaptureStream(host.stdout), {
			accepted: 12,
			kinds: {
				"agent.turn": 1,
				"capability.call": 1,
				"chat.turn": 1,
				"llm.call": 1,
				"sandbox.reap": 1,
				"sandbox.spawn": 1,
				"site.mint": 1,
				"site.publish": 1,
				"site.retire": 1,
				"site.route": 1,
				"test.beat": 1,
				"test.verdict": 1,
			},
		});
	});
});
