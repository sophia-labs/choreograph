import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { canonicalJson, parseInternalStageSubmission, parseRetryRequest } from "../internal-jobs/contracts.js";
import { InternalJobStore } from "../internal-jobs/store.js";
import {
	StageInputValidationError,
	StageResultValidationError,
	TranscriptionStageDriver,
	validateCaptureManifest,
} from "../internal-jobs/transcription.js";

const JOB_ID = "77777777-7777-4777-8777-777777777777";
const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		makeWritable(directory);
		rmSync(directory, { recursive: true, force: true });
	}
	delete process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST;
});

function makeWritable(path: string): void {
	const info = lstatSync(path);
	if (!info.isDirectory()) {
		chmodSync(path, 0o600);
		return;
	}
	chmodSync(path, 0o700);
	for (const entry of readdirSync(path)) makeWritable(join(path, entry));
}

function temporaryRoot(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(root);
	return root;
}

function wavBytes(frames = 960): Buffer {
	const dataBytes = frames * 2;
	const buffer = Buffer.alloc(44 + dataBytes);
	buffer.write("RIFF", 0);
	buffer.writeUInt32LE(36 + dataBytes, 4);
	buffer.write("WAVE", 8);
	buffer.write("fmt ", 12);
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(1, 22);
	buffer.writeUInt32LE(48_000, 24);
	buffer.writeUInt32LE(96_000, 28);
	buffer.writeUInt16LE(2, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write("data", 36);
	buffer.writeUInt32LE(dataBytes, 40);
	return buffer;
}

function createCapture(root: string): { spool: string; jobDir: string; digest: string } {
	const spool = join(root, "jobs");
	const jobDir = join(spool, JOB_ID);
	const input = join(jobDir, "input");
	const segments = join(input, "segments");
	mkdirSync(segments, { recursive: true });
	mkdirSync(join(jobDir, "output", "attempts"), { recursive: true });
	const wav = wavBytes();
	const wavPath = join(segments, "000001.wav");
	writeFileSync(wavPath, wav);
	const manifest = {
		schema_version: 1,
		job_id: JOB_ID,
		guild_id: "100",
		voice_channel_id: "200",
		text_channel_id: "300",
		requested_by_user_id: "400",
		started_at: "2026-07-30T22:00:00+00:00",
		ended_at: "2026-07-30T22:00:01+00:00",
		capture: {
			codec: "pcm_s16le",
			sample_rate: 48_000,
			channels: 1,
			sample_width: 2,
			dave: true,
		},
		participants: [{ discord_user_id: "speaker-1", display_name_snapshot: "Alice" }],
		segments: [
			{
				segment_id: "000001",
				speaker_id: "speaker-1",
				display_name_snapshot: "Alice",
				ssrc: 1,
				start_ms: 0,
				end_ms: 20,
				duration_ms: 20,
				path: "segments/000001.wav",
				sha256: createHash("sha256").update(wav).digest("hex"),
				bytes: wav.length,
				pcm_bytes: wav.length - 44,
			},
		],
		capture_warnings: [],
	};
	const raw = Buffer.from(JSON.stringify(manifest));
	writeFileSync(join(input, "manifest.json"), raw);
	writeFileSync(join(input, ".ready"), "ready\n");
	chmodSync(wavPath, 0o440);
	chmodSync(join(input, "manifest.json"), 0o440);
	chmodSync(join(input, ".ready"), 0o440);
	chmodSync(segments, 0o550);
	chmodSync(input, 0o550);
	return { spool, jobDir, digest: createHash("sha256").update(raw).digest("hex") };
}

function submission(digest: string) {
	return parseInternalStageSubmission({
		schema_version: 1,
		job_id: JOB_ID,
		stage: "transcription",
		input_digest: digest,
		input: { manifest_sha256: digest },
		parameters: { preferred_model: "vibeasr-bitnet" },
	});
}

function installFakeBundles(root: string): void {
	const runtime = join(root, "runtime");
	const vibe = join(root, "vibe");
	const whisper = join(root, "whisper");
	for (const directory of [runtime, vibe, whisper]) mkdirSync(directory);
	writeFileSync(
		join(runtime, "provenance.json"),
		JSON.stringify({
			vibeasr_commit: "vibe-runtime-commit",
			whisper_cpp_commit: "whisper-runtime-commit",
			files: {},
		}),
	);
	writeFileSync(
		join(vibe, "provenance.json"),
		JSON.stringify({ name: "vibeasr-bitnet", model_revision: "vibe-model-revision", files: {} }),
	);
	writeFileSync(
		join(whisper, "provenance.json"),
		JSON.stringify({ name: "whisper-small-en", model_revision: "whisper-model-revision", files: {} }),
	);
	const manifest = join(root, "runtime-bundles.json");
	writeFileSync(
		manifest,
		JSON.stringify({
			bundles: [
				{ id: "asr-runtime", mounts: [{ guest_path: "/ignored", host_path: runtime, mode: "ro" }] },
				{
					id: "asr-vibeasr-bitnet-model",
					mounts: [{ guest_path: "/ignored", host_path: vibe, mode: "ro" }],
				},
				{
					id: "asr-whisper-small-en-model",
					mounts: [{ guest_path: "/ignored", host_path: whisper, mode: "ro" }],
				},
			],
		}),
	);
	process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST = manifest;
}

describe("internal stage contracts and store", () => {
	it("canonicalizes immutable request objects and rejects unsafe input", () => {
		assert.equal(canonicalJson({ b: 2, a: 1 }), '{"a":1,"b":2}');
		assert.throws(
			() =>
				parseInternalStageSubmission({
					schema_version: 1,
					job_id: "../../escape",
					stage: "transcription",
					input_digest: "a".repeat(64),
					input: {},
				}),
			/canonical lowercase UUID/,
		);
		assert.throws(
			() => parseRetryRequest({ expected_attempt: 1, idempotency_key: "spaces are rejected" }),
			/safe characters/,
		);
		assert.throws(
			() =>
				parseInternalStageSubmission({
					...submission("a".repeat(64)),
					unexpected: true,
				}),
			/unsupported fields/,
		);
	});

	it("makes submit and retry idempotent while preserving attempt history", () => {
		const root = temporaryRoot("internal-store-");
		const store = new InternalJobStore(join(root, "jobs.sqlite"));
		const digest = "a".repeat(64);
		const request = submission(digest);
		const created = store.createOrGet(request, "vibeasr-bitnet");
		assert.equal(created.created, true);
		assert.equal(store.createOrGet(request, "vibeasr-bitnet").created, false);
		assert.throws(
			() => store.createOrGet({ ...request, input_digest: "b".repeat(64) }, "vibeasr-bitnet"),
			/different immutable input/,
		);
		const running = store.claimNextQueued()!;
		store.finish(running, "failed_retryable", { error: "model failed" });
		const retried = store.retry(JOB_ID, "transcription", 1, "retry-key-1", "whisper-small-en", 2);
		assert.equal(retried.attempt, 2);
		assert.equal(retried.model, "whisper-small-en");
		const replay = store.retry(JOB_ID, "transcription", 1, "retry-key-1", "whisper-small-en", 2);
		assert.equal(replay.attempt, 2);
		store.close();
	});
});

describe("transcription input and promotion boundary", () => {
	it("validates the sealed WAV and rejects hard links", async () => {
		const root = temporaryRoot("internal-capture-");
		const capture = createCapture(root);
		const validated = await validateCaptureManifest(capture.spool, JOB_ID, capture.digest, {
			maxJobBytes: 1024 * 1024,
			maxSegmentBytes: 1024 * 1024,
			maxSegmentMs: 20_000,
			maxAudioMs: 60_000,
		});
		assert.equal(validated.segments[0]?.duration_ms, 20);
		await assert.rejects(
			async () =>
				validateCaptureManifest(capture.spool, JOB_ID, capture.digest, {
					maxJobBytes: 1024 * 1024,
					maxSegmentBytes: 1024 * 1024,
					maxSegmentMs: 19,
					maxAudioMs: 60_000,
				}),
			StageInputValidationError,
		);
		const wav = join(capture.jobDir, "input", "segments", "000001.wav");
		linkSync(wav, join(root, "alias.wav"));
		await assert.rejects(
			async () =>
				validateCaptureManifest(capture.spool, JOB_ID, capture.digest, {
					maxJobBytes: 1024 * 1024,
					maxSegmentBytes: 1024 * 1024,
					maxSegmentMs: 20_000,
					maxAudioMs: 60_000,
				}),
			StageInputValidationError,
		);
	});

	it("constructs only fixed mounts/argv and promotes a validated result once", async () => {
		const root = temporaryRoot("internal-driver-");
		const capture = createCapture(root);
		installFakeBundles(root);
		const driver = new TranscriptionStageDriver({
			spoolRoot: capture.spool,
			maxJobBytes: 1024 * 1024,
			maxSegmentBytes: 1024 * 1024,
			maxSegmentMs: 20_000,
			maxAudioMs: 60_000,
		});
		const store = new InternalJobStore(join(root, "jobs.sqlite"));
		store.createOrGet(submission(capture.digest), "vibeasr-bitnet");
		const job = store.claimNextQueued()!;
		const plan = await driver.prepareAttempt(job);
		assert.deepEqual(
			plan.privateMounts.map((mount) => [mount.guestPath, mount.mode]),
			[
				["/stage-input", "ro"],
				["/stage-output", "rw"],
				["/stage-runtime", "ro"],
				["/stage-model", "ro"],
			],
		);
		const command = plan.workerConfig.command as string[];
		assert.deepEqual(command.slice(0, 2), ["/usr/bin/python3", "/stage-runtime/transcribe_job.py"]);
		assert.equal(command.includes("../../escape"), false);
		const attemptOutput = join(capture.jobDir, "output", "attempts", "1");
		writeFileSync(
			join(attemptOutput, "result.json"),
			JSON.stringify({
				schema_version: 1,
				job_id: JOB_ID,
				manifest_sha256: capture.digest,
				model: {
					name: "vibeasr-bitnet",
					runtime_commit: "vibe-runtime-commit",
					model_revision: "vibe-model-revision",
					threads: 2,
				},
				segments: [
					{
						segment_id: "000001",
						speaker_id: "speaker-1",
						start_ms: 0,
						end_ms: 20,
						text: "hello",
						confidence: null,
					},
				],
				warnings: [],
				metrics: { audio_seconds: 0.02, wall_seconds: 0.01, rtf: 0.5, peak_rss_bytes: 1024 },
				completed_at: "2026-07-30T22:01:00+00:00",
			}),
		);
		const promotion = await driver.validateAndPromote(job);
		assert.equal(
			createHash("sha256")
				.update(readFileSync(join(capture.jobDir, "output", "result.json")))
				.digest("hex"),
			promotion.resultDigest,
		);
		assert.equal((await driver.validateAndPromote(job)).resultDigest, promotion.resultDigest);
		const promotedResult = join(capture.jobDir, "output", "result.json");
		const resultAlias = join(root, "promoted-result-alias.json");
		linkSync(promotedResult, resultAlias);
		await assert.rejects(() => driver.validateAndPromote(job), StageResultValidationError);
		unlinkSync(resultAlias);
		chmodSync(join(capture.jobDir, "output", "result.json"), 0o440);
		store.close();
	});

	it("rejects transcript expansion that is disproportionate to segment duration", async () => {
		const root = temporaryRoot("internal-result-expansion-");
		const capture = createCapture(root);
		installFakeBundles(root);
		const driver = new TranscriptionStageDriver({ spoolRoot: capture.spool });
		const store = new InternalJobStore(join(root, "jobs.sqlite"));
		store.createOrGet(submission(capture.digest), "vibeasr-bitnet");
		const job = store.claimNextQueued()!;
		await driver.prepareAttempt(job);
		writeFileSync(
			join(capture.jobDir, "output", "attempts", "1", "result.json"),
			JSON.stringify({
				schema_version: 1,
				job_id: JOB_ID,
				manifest_sha256: capture.digest,
				model: {
					name: "vibeasr-bitnet",
					runtime_commit: "vibe-runtime-commit",
					model_revision: "vibe-model-revision",
					threads: 2,
				},
				segments: [
					{
						segment_id: "000001",
						speaker_id: "speaker-1",
						start_ms: 0,
						end_ms: 20,
						text: "x".repeat(300),
						confidence: null,
					},
				],
				warnings: [],
				metrics: { audio_seconds: 0.02, wall_seconds: 0.01, rtf: 0.5, peak_rss_bytes: 1024 },
				completed_at: "2026-07-30T22:01:00+00:00",
			}),
		);
		await assert.rejects(() => driver.validateAndPromote(job), /expanded beyond its audio-duration bound/);
		store.close();
	});
});
