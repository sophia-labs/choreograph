import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	createReadStream,
	existsSync,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	type Stats,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { resolveRuntimeBundleMounts } from "../runtime-bundles.js";
import type { PrivateSandboxMount } from "../templates.js";
import {
	InternalJobRequestError,
	InternalStageInputValidationError,
	type InternalStageJob,
	type InternalStageSubmission,
	requireSha256,
} from "./contracts.js";
import type { InternalStageAttemptPlan, InternalStageDriver, InternalStagePromotion } from "./registry.js";

const SEGMENT_ID_PATTERN = /^[0-9]{6}$/;
const VIBE_MODEL = "vibeasr-bitnet";
const WHISPER_MODEL = "whisper-small-en";
const SUPPORTED_MODELS = new Set([VIBE_MODEL, WHISPER_MODEL]);

interface CaptureSegment {
	segment_id: string;
	speaker_id: string;
	start_ms: number;
	end_ms: number;
	duration_ms: number;
	path: string;
}

interface ValidatedCapture {
	jobDir: string;
	inputDir: string;
	outputDir: string;
	manifestSha256: string;
	segments: CaptureSegment[];
}

interface ModelDefinition {
	bundleId: string;
	engine: "vibe" | "whisper";
}

interface ValidatedResultMetrics {
	audio_seconds: number;
	wall_seconds: number;
	rtf: number;
	peak_rss_bytes: number;
}

const MODELS: Record<string, ModelDefinition> = {
	[VIBE_MODEL]: {
		bundleId: "asr-vibeasr-bitnet-model",
		engine: "vibe",
	},
	[WHISPER_MODEL]: {
		bundleId: "asr-whisper-small-en-model",
		engine: "whisper",
	},
};

export class StageInputValidationError extends InternalStageInputValidationError {}
export class StageResultValidationError extends Error {}

export interface TranscriptionDriverOptions {
	spoolRoot: string;
	runtimeBundleId?: string;
	maxJobBytes?: number;
	maxSegmentBytes?: number;
	maxSegmentMs?: number;
	maxAudioMs?: number;
	timeoutMs?: number;
	memoryMaxBytes?: number;
	cpuQuotaUs?: number;
	pidsMax?: number;
	threads?: number;
}

export class TranscriptionStageDriver implements InternalStageDriver {
	readonly stage = "transcription" as const;
	readonly maxAttempts = 2;
	private readonly spoolRoot: string;
	private readonly runtimeBundleId: string;
	private readonly limits: Required<
		Pick<TranscriptionDriverOptions, "maxJobBytes" | "maxSegmentBytes" | "maxSegmentMs" | "maxAudioMs">
	>;
	private readonly timeoutMs: number;
	private readonly resources: {
		memory_max_bytes: number;
		cpu_quota_us: number;
		cpu_period_us: number;
		pids_max: number;
	};
	private readonly threads: number;

	constructor(options: TranscriptionDriverOptions) {
		this.spoolRoot = realpathSync(resolve(options.spoolRoot));
		this.runtimeBundleId = options.runtimeBundleId ?? "asr-runtime";
		this.limits = {
			maxJobBytes: options.maxJobBytes ?? 8 * 1024 * 1024 * 1024,
			maxSegmentBytes: options.maxSegmentBytes ?? 2 * 1024 * 1024,
			maxSegmentMs: options.maxSegmentMs ?? 15_000,
			maxAudioMs: options.maxAudioMs ?? 3 * 60 * 60 * 1000,
		};
		this.timeoutMs = options.timeoutMs ?? 3 * 60 * 60 * 1000;
		this.resources = {
			memory_max_bytes: options.memoryMaxBytes ?? 7 * 1024 * 1024 * 1024,
			cpu_quota_us: options.cpuQuotaUs ?? 200_000,
			cpu_period_us: 100_000,
			pids_max: options.pidsMax ?? 64,
		};
		this.threads = Math.max(1, Math.min(options.threads ?? 2, 8));
	}

	initialModel(submission: InternalStageSubmission): string {
		const preferred = submission.parameters.preferred_model ?? VIBE_MODEL;
		if (typeof preferred !== "string" || !SUPPORTED_MODELS.has(preferred)) {
			throw new InternalJobRequestError(`unsupported preferred_model: ${String(preferred)}`);
		}
		return preferred;
	}

	retryModel(job: InternalStageJob, nextAttempt: number): string {
		if (nextAttempt !== 2) {
			throw new InternalJobRequestError("transcription only supports one fallback attempt", 409);
		}
		return job.model === VIBE_MODEL ? WHISPER_MODEL : VIBE_MODEL;
	}

	async validateSubmission(submission: InternalStageSubmission): Promise<void> {
		if (
			Object.keys(submission.input).some((key) => key !== "manifest_sha256") ||
			Object.keys(submission.parameters).some((key) => key !== "preferred_model")
		) {
			throw new InternalJobRequestError("transcription request contains unsupported fields");
		}
		if (submission.input.manifest_sha256 !== submission.input_digest) {
			throw new InternalJobRequestError("input.manifest_sha256 must equal input_digest");
		}
		this.initialModel(submission);
		await validateCaptureManifest(this.spoolRoot, submission.job_id, submission.input_digest, this.limits, {
			verifyAudioDigests: false,
		});
	}

	async prepareAttempt(job: InternalStageJob): Promise<InternalStageAttemptPlan> {
		const capture = await validateCaptureManifest(this.spoolRoot, job.job_id, job.input_digest, this.limits);
		const attemptsRoot = join(capture.outputDir, "attempts");
		requireDirectory(attemptsRoot, capture.outputDir);
		const attemptOutput = join(attemptsRoot, String(job.attempt));
		if (existsSync(attemptOutput)) {
			throw new Error(`attempt output directory already exists: ${job.attempt}`);
		}
		mkdirSync(attemptOutput, { mode: 0o770 });
		requireDirectory(attemptOutput, attemptsRoot);

		const model = MODELS[job.model];
		if (!model) {
			throw new Error(`stage store contains unsupported model: ${job.model}`);
		}
		const runtimeRoot = resolveSingleBundleRoot(this.runtimeBundleId);
		const modelRoot = resolveSingleBundleRoot(model.bundleId);
		const mounts: PrivateSandboxMount[] = [
			{ hostPath: capture.inputDir, guestPath: "/stage-input", mode: "ro" },
			{ hostPath: attemptOutput, guestPath: "/stage-output", mode: "rw" },
			{ hostPath: runtimeRoot, guestPath: "/stage-runtime", mode: "ro" },
			{ hostPath: modelRoot, guestPath: "/stage-model", mode: "ro" },
		];

		return {
			template: "bare",
			privateMounts: mounts,
			resources: this.resources,
			timeoutMs: this.timeoutMs,
			workerConfig: {
				mode: "command",
				command: [
					"/usr/bin/python3",
					"/stage-runtime/transcribe_job.py",
					"--manifest",
					"/stage-input/manifest.json",
					"--output",
					"/stage-output/result.json",
					"--model",
					job.model,
					"--engine",
					model.engine,
					"--threads",
					String(this.threads),
					"--runtime-root",
					"/stage-runtime",
					"--model-root",
					"/stage-model",
				],
				env: {
					PHANES_EXPECTED_JOB_ID: job.job_id,
					PHANES_EXPECTED_MANIFEST_SHA256: job.input_digest,
				},
			},
		};
	}

	async validateAndPromote(job: InternalStageJob): Promise<InternalStagePromotion> {
		const capture = await validateCaptureManifest(this.spoolRoot, job.job_id, job.input_digest, this.limits, {
			verifyAudioDigests: false,
		});
		const source = join(capture.outputDir, "attempts", String(job.attempt), "result.json");
		const raw = readStableResultFile(source, dirname(source), 5 * 1024 * 1024);
		const resultDigest = createHash("sha256").update(raw).digest("hex");
		const result = parseResult(raw);
		const metrics = validateResult(
			result,
			job,
			capture,
			resolveExpectedProvenance(this.runtimeBundleId, job.model),
			this.resources.memory_max_bytes,
		);
		promoteImmutable(raw, capture.outputDir, resultDigest);
		return { resultDigest, metrics };
	}
}

export function validateCaptureManifest(
	spoolRoot: string,
	jobId: string,
	expectedDigest: string,
	limits: { maxJobBytes: number; maxSegmentBytes: number; maxSegmentMs: number; maxAudioMs: number },
	options: { verifyAudioDigests?: boolean } = {},
): Promise<ValidatedCapture> {
	return validateCaptureManifestAsync(spoolRoot, jobId, expectedDigest, limits, options);
}

async function validateCaptureManifestAsync(
	spoolRoot: string,
	jobId: string,
	expectedDigest: string,
	limits: { maxJobBytes: number; maxSegmentBytes: number; maxSegmentMs: number; maxAudioMs: number },
	options: { verifyAudioDigests?: boolean },
): Promise<ValidatedCapture> {
	const root = realpathSync(resolve(spoolRoot));
	const jobDir = join(root, jobId);
	requireDirectory(jobDir, root);
	if (dirname(realpathSync(jobDir)) !== root || basename(jobDir) !== jobId) {
		throw new StageInputValidationError("job directory escapes the configured spool");
	}
	const inputDir = join(jobDir, "input");
	const outputDir = join(jobDir, "output");
	const segmentDir = join(inputDir, "segments");
	requireDirectory(inputDir, jobDir);
	requireDirectory(outputDir, jobDir);
	requireDirectory(segmentDir, inputDir);
	requireExactEntries(jobDir, new Set(["input", "output"]));
	requireExactEntries(inputDir, new Set([".ready", "manifest.json", "segments"]));
	requireSealedMode(inputDir);
	requireSealedMode(segmentDir);
	const ready = join(inputDir, ".ready");
	requireRegularSingleLink(ready, inputDir);
	requireSealedMode(ready);
	if (!readFileSync(ready).equals(Buffer.from("ready\n"))) {
		throw new StageInputValidationError("capture ready marker is malformed");
	}
	const manifestPath = join(inputDir, "manifest.json");
	const manifestStat = requireRegularSingleLink(manifestPath, inputDir);
	requireSealedMode(manifestPath);
	if (manifestStat.size > 2 * 1024 * 1024) {
		throw new StageInputValidationError("capture manifest exceeds 2 MiB");
	}
	const raw = readFileSync(manifestPath);
	const digest = createHash("sha256").update(raw).digest("hex");
	if (digest !== requireSha256(expectedDigest, "input_digest")) {
		throw new StageInputValidationError("capture manifest digest mismatch");
	}
	let manifest: unknown;
	try {
		manifest = JSON.parse(raw.toString("utf8"));
	} catch {
		throw new StageInputValidationError("capture manifest is not valid JSON");
	}
	if (!isObject(manifest) || manifest.schema_version !== 1 || manifest.job_id !== jobId) {
		throw new StageInputValidationError("capture manifest identity or schema is invalid");
	}
	const capture = manifest.capture;
	if (
		!isObject(capture) ||
		capture.codec !== "pcm_s16le" ||
		capture.sample_rate !== 48_000 ||
		capture.channels !== 1 ||
		capture.sample_width !== 2 ||
		capture.dave !== true
	) {
		throw new StageInputValidationError("capture manifest audio format is unsupported");
	}
	if (!Array.isArray(manifest.participants) || manifest.participants.length > 1000) {
		throw new StageInputValidationError("capture manifest participants are not a bounded array");
	}
	const participantIds = new Set<string>();
	for (const participant of manifest.participants) {
		if (
			!isObject(participant) ||
			typeof participant.discord_user_id !== "string" ||
			participant.discord_user_id.length < 1 ||
			participant.discord_user_id.length > 128 ||
			typeof participant.display_name_snapshot !== "string" ||
			participant.display_name_snapshot.length > 256
		) {
			throw new StageInputValidationError("capture participant metadata is invalid");
		}
		if (participantIds.has(participant.discord_user_id)) {
			throw new StageInputValidationError("capture participant IDs must be unique");
		}
		participantIds.add(participant.discord_user_id);
	}
	if (
		!Array.isArray(manifest.capture_warnings) ||
		manifest.capture_warnings.length > 1000 ||
		manifest.capture_warnings.some((warning) => typeof warning !== "string" || warning.length > 1000)
	) {
		throw new StageInputValidationError("capture warnings exceed their bounds");
	}
	if (!Array.isArray(manifest.segments) || manifest.segments.length > 100_000) {
		throw new StageInputValidationError("capture manifest segments are not a bounded array");
	}
	const segments: CaptureSegment[] = [];
	const seen = new Set<string>();
	let totalBytes = raw.byteLength;
	let totalDurationMs = 0;
	for (const value of manifest.segments) {
		if (!isObject(value)) {
			throw new StageInputValidationError("capture segment must be an object");
		}
		const segmentId = value.segment_id;
		if (typeof segmentId !== "string" || !SEGMENT_ID_PATTERN.test(segmentId) || seen.has(segmentId)) {
			throw new StageInputValidationError("capture segment ID is invalid or duplicated");
		}
		seen.add(segmentId);
		if (value.path !== `segments/${segmentId}.wav`) {
			throw new StageInputValidationError(`capture segment ${segmentId} has an unsafe path`);
		}
		if (typeof value.speaker_id !== "string" || value.speaker_id.length < 1 || value.speaker_id.length > 128) {
			throw new StageInputValidationError(`capture segment ${segmentId} speaker is invalid`);
		}
		if (!participantIds.has(value.speaker_id)) {
			throw new StageInputValidationError(`capture segment ${segmentId} speaker is not a participant`);
		}
		const startMs = requireInteger(value.start_ms, `${segmentId}.start_ms`);
		const endMs = requireInteger(value.end_ms, `${segmentId}.end_ms`);
		const durationMs = requireInteger(value.duration_ms, `${segmentId}.duration_ms`);
		if (startMs < 0 || durationMs <= 0 || durationMs > limits.maxSegmentMs || endMs !== startMs + durationMs) {
			throw new StageInputValidationError(`capture segment ${segmentId} timing is invalid`);
		}
		const path = join(segmentDir, `${segmentId}.wav`);
		const fileStat = requireRegularSingleLink(path, segmentDir);
		requireSealedMode(path);
		const manifestBytes = requireInteger(value.bytes, `${segmentId}.bytes`);
		if (fileStat.size !== manifestBytes || fileStat.size > limits.maxSegmentBytes) {
			throw new StageInputValidationError(`capture segment ${segmentId} byte count is invalid`);
		}
		const manifestDigest = requireSha256(value.sha256, `${segmentId}.sha256`);
		if (options.verifyAudioDigests !== false && (await sha256File(path, fileStat)) !== manifestDigest) {
			throw new StageInputValidationError(`capture segment ${segmentId} digest mismatch`);
		}
		const wav = inspectPcmWav(path);
		if (wav.durationMs !== durationMs || wav.dataBytes !== value.pcm_bytes) {
			throw new StageInputValidationError(`capture segment ${segmentId} WAV duration is invalid`);
		}
		totalBytes += fileStat.size;
		totalDurationMs += durationMs;
		if (totalBytes > limits.maxJobBytes || totalDurationMs > limits.maxAudioMs) {
			throw new StageInputValidationError("capture exceeds the configured job limits");
		}
		segments.push({
			segment_id: segmentId,
			speaker_id: value.speaker_id,
			start_ms: startMs,
			end_ms: endMs,
			duration_ms: durationMs,
			path: value.path,
		});
	}
	requireExactEntries(segmentDir, new Set(segments.map((segment) => `${segment.segment_id}.wav`)));
	return { jobDir, inputDir, outputDir, manifestSha256: digest, segments };
}

function inspectPcmWav(path: string): { durationMs: number; dataBytes: number } {
	const fileSize = statSync(path).size;
	const header = Buffer.alloc(Math.min(fileSize, 64 * 1024));
	const descriptor = openSync(path, constants.O_RDONLY);
	try {
		readSync(descriptor, header, 0, header.length, 0);
	} finally {
		closeSync(descriptor);
	}
	if (header.length < 44 || header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
		throw new StageInputValidationError("capture WAV header is invalid");
	}
	let offset = 12;
	let formatValid = false;
	let dataBytes: number | undefined;
	while (offset + 8 <= header.length) {
		const chunkId = header.toString("ascii", offset, offset + 4);
		const chunkSize = header.readUInt32LE(offset + 4);
		const dataOffset = offset + 8;
		if (chunkId === "fmt " && chunkSize >= 16 && dataOffset + 16 <= header.length) {
			formatValid =
				header.readUInt16LE(dataOffset) === 1 &&
				header.readUInt16LE(dataOffset + 2) === 1 &&
				header.readUInt32LE(dataOffset + 4) === 48_000 &&
				header.readUInt32LE(dataOffset + 8) === 96_000 &&
				header.readUInt16LE(dataOffset + 12) === 2 &&
				header.readUInt16LE(dataOffset + 14) === 16;
		}
		if (chunkId === "data") {
			dataBytes = chunkSize;
			if (dataOffset + chunkSize > fileSize) {
				throw new StageInputValidationError("capture WAV data chunk exceeds file size");
			}
			break;
		}
		offset = dataOffset + chunkSize + (chunkSize % 2);
	}
	if (!formatValid || dataBytes == null || dataBytes % 2 !== 0) {
		throw new StageInputValidationError("capture WAV PCM format is invalid");
	}
	if (header.readUInt32LE(4) + 8 !== fileSize) {
		throw new StageInputValidationError("capture WAV RIFF size is invalid");
	}
	return {
		durationMs: Math.round((dataBytes / 2 / 48_000) * 1000),
		dataBytes,
	};
}

function validateResult(
	result: Record<string, unknown>,
	job: InternalStageJob,
	capture: ValidatedCapture,
	provenance: { runtimeCommit: string; modelRevision: string },
	memoryMaxBytes: number,
): ValidatedResultMetrics {
	if (result.schema_version !== 1 || result.job_id !== job.job_id || result.manifest_sha256 !== job.input_digest) {
		throw new StageResultValidationError("transcription result identity or schema mismatch");
	}
	if (
		!isObject(result.model) ||
		result.model.name !== job.model ||
		result.model.runtime_commit !== provenance.runtimeCommit ||
		result.model.model_revision !== provenance.modelRevision
	) {
		throw new StageResultValidationError("transcription result provenance mismatch");
	}
	if (!Array.isArray(result.segments) || result.segments.length !== capture.segments.length) {
		throw new StageResultValidationError("transcription result segment count mismatch");
	}
	let totalTextBytes = 0;
	for (const [index, expected] of capture.segments.entries()) {
		const actual = result.segments[index];
		if (
			!isObject(actual) ||
			actual.segment_id !== expected.segment_id ||
			actual.speaker_id !== expected.speaker_id ||
			actual.start_ms !== expected.start_ms ||
			actual.end_ms !== expected.end_ms ||
			typeof actual.text !== "string"
		) {
			throw new StageResultValidationError(`transcription result segment ${expected.segment_id} mismatch`);
		}
		totalTextBytes += Buffer.byteLength(actual.text);
		const segmentTextLimit = 256 + Math.floor((expected.duration_ms / 1000) * 48);
		if (Buffer.byteLength(actual.text) > segmentTextLimit) {
			throw new StageResultValidationError(
				`transcription result segment ${expected.segment_id} expanded beyond its audio-duration bound`,
			);
		}
		if (totalTextBytes > 4 * 1024 * 1024) {
			throw new StageResultValidationError("transcription result text exceeds 4 MiB");
		}
		if (
			actual.confidence !== null &&
			(typeof actual.confidence !== "number" ||
				!Number.isFinite(actual.confidence) ||
				actual.confidence < 0 ||
				actual.confidence > 1)
		) {
			throw new StageResultValidationError(`transcription result confidence is invalid`);
		}
	}
	if (
		!Array.isArray(result.warnings) ||
		result.warnings.length > 1000 ||
		result.warnings.some((item) => typeof item !== "string" || item.length > 1000) ||
		typeof result.completed_at !== "string" ||
		!Number.isFinite(Date.parse(result.completed_at))
	) {
		throw new StageResultValidationError("transcription result metadata is invalid");
	}
	if (!isObject(result.metrics)) {
		throw new StageResultValidationError("transcription result metrics are missing");
	}
	const audioSeconds = requireFiniteMetric(result.metrics.audio_seconds, "audio_seconds");
	const wallSeconds = requireFiniteMetric(result.metrics.wall_seconds, "wall_seconds");
	const rtf = requireFiniteMetric(result.metrics.rtf, "rtf");
	const peakRssBytes = requireFiniteMetric(result.metrics.peak_rss_bytes, "peak_rss_bytes");
	const expectedAudioSeconds = capture.segments.reduce((total, segment) => total + segment.duration_ms, 0) / 1000;
	const expectedRtf = expectedAudioSeconds === 0 ? 0 : wallSeconds / expectedAudioSeconds;
	if (
		Math.abs(audioSeconds - expectedAudioSeconds) > 0.000_001 ||
		wallSeconds < 0 ||
		Math.abs(rtf - expectedRtf) > Math.max(0.000_001, expectedRtf * 0.000_001) ||
		!Number.isSafeInteger(peakRssBytes) ||
		peakRssBytes < 0 ||
		peakRssBytes > memoryMaxBytes
	) {
		throw new StageResultValidationError("transcription result metrics are inconsistent");
	}
	return {
		audio_seconds: audioSeconds,
		wall_seconds: wallSeconds,
		rtf,
		peak_rss_bytes: peakRssBytes,
	};
}

function resolveExpectedProvenance(
	runtimeBundleId: string,
	modelName: string,
): { runtimeCommit: string; modelRevision: string } {
	const model = MODELS[modelName];
	if (!model) throw new Error(`unsupported model: ${modelName}`);
	const runtimeRoot = resolveSingleBundleRoot(runtimeBundleId);
	const modelRoot = resolveSingleBundleRoot(model.bundleId);
	const runtime = readJsonObject(join(runtimeRoot, "provenance.json"));
	const modelProvenance = readJsonObject(join(modelRoot, "provenance.json"));
	const runtimeCommit = model.engine === "vibe" ? runtime.vibeasr_commit : runtime.whisper_cpp_commit;
	if (typeof runtimeCommit !== "string" || typeof modelProvenance.model_revision !== "string") {
		throw new Error("ASR bundle provenance is incomplete");
	}
	return { runtimeCommit, modelRevision: modelProvenance.model_revision };
}

function resolveSingleBundleRoot(bundleId: string): string {
	const mounts = resolveRuntimeBundleMounts(bundleId);
	if (mounts.length !== 1 || mounts[0]!.mode !== "ro") {
		throw new Error(`ASR bundle ${bundleId} must resolve to exactly one read-only mount`);
	}
	const root = realpathSync(mounts[0]!.hostPath);
	if (!lstatSync(root).isDirectory()) {
		throw new Error(`ASR bundle ${bundleId} root is not a directory`);
	}
	return root;
}

function promoteImmutable(raw: Buffer, outputDir: string, digest: string): void {
	const destination = join(outputDir, "result.json");
	if (existsSync(destination)) {
		const existing = createHash("sha256")
			.update(readStableResultFile(destination, outputDir, 5 * 1024 * 1024))
			.digest("hex");
		if (existing !== digest) {
			throw new StageResultValidationError("immutable promoted result already exists with a different digest");
		}
		return;
	}
	const temporary = join(outputDir, `.result.${digest}.${randomUUID()}.tmp`);
	const fd = openSync(
		temporary,
		constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
		0o440,
	);
	try {
		writeFileSync(fd, raw);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		linkSync(temporary, destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const existing = createHash("sha256")
			.update(readStableResultFile(destination, outputDir, 5 * 1024 * 1024))
			.digest("hex");
		if (existing !== digest) {
			throw new StageResultValidationError("immutable promoted result already exists with a different digest");
		}
	} finally {
		unlinkSync(temporary);
	}
	const promoted = readStableResultFile(destination, outputDir, 5 * 1024 * 1024);
	if (createHash("sha256").update(promoted).digest("hex") !== digest) {
		throw new StageResultValidationError("promoted result changed during atomic installation");
	}
	const resultFile = openSync(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		fsyncSync(resultFile);
	} finally {
		closeSync(resultFile);
	}
	const directory = openSync(outputDir, constants.O_RDONLY);
	try {
		fsyncSync(directory);
	} finally {
		closeSync(directory);
	}
}

function readStableResultFile(path: string, expectedParent: string, maxBytes: number): Buffer {
	let expected: Stats;
	try {
		expected = lstatSync(path);
		if (
			!expected.isFile() ||
			expected.isSymbolicLink() ||
			expected.nlink !== 1 ||
			dirname(realpathSync(path)) !== realpathSync(expectedParent)
		) {
			throw new StageResultValidationError("sandbox result is not a regular single-link file");
		}
	} catch (error) {
		if (error instanceof StageResultValidationError) throw error;
		throw new StageResultValidationError(`sandbox result cannot be inspected: ${basename(path)}`);
	}
	if (expected.size > maxBytes) {
		throw new StageResultValidationError("sandbox result exceeds 5 MiB");
	}
	let descriptor: number;
	try {
		descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch {
		throw new StageResultValidationError("sandbox result changed before it could be opened");
	}
	try {
		const before = fstatSync(descriptor);
		if (
			!before.isFile() ||
			before.nlink !== 1 ||
			before.dev !== expected.dev ||
			before.ino !== expected.ino ||
			before.size !== expected.size
		) {
			throw new StageResultValidationError("sandbox result changed before validation");
		}
		const raw = Buffer.alloc(before.size);
		let offset = 0;
		while (offset < raw.length) {
			const count = readSync(descriptor, raw, offset, raw.length - offset, offset);
			if (count === 0) {
				throw new StageResultValidationError("sandbox result ended before its declared size");
			}
			offset += count;
		}
		const after = fstatSync(descriptor);
		if (
			!after.isFile() ||
			after.nlink !== 1 ||
			after.dev !== before.dev ||
			after.ino !== before.ino ||
			after.size !== before.size ||
			after.mtimeMs !== before.mtimeMs ||
			after.ctimeMs !== before.ctimeMs
		) {
			throw new StageResultValidationError("sandbox result changed during validation");
		}
		return raw;
	} finally {
		closeSync(descriptor);
	}
}

async function sha256File(path: string, expectedStat: Stats): Promise<string> {
	const digest = createHash("sha256");
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const opened = fstatSync(descriptor);
		if (
			!opened.isFile() ||
			opened.nlink !== 1 ||
			opened.dev !== expectedStat.dev ||
			opened.ino !== expectedStat.ino ||
			opened.size !== expectedStat.size
		) {
			throw new StageInputValidationError("capture segment changed during validation");
		}
		const stream = createReadStream(path, {
			fd: descriptor,
			autoClose: true,
			highWaterMark: 1024 * 1024,
		});
		for await (const chunk of stream) {
			digest.update(chunk);
		}
	} catch (error) {
		try {
			closeSync(descriptor);
		} catch {
			// The read stream already closed the descriptor.
		}
		throw error;
	}
	try {
		closeSync(descriptor);
	} catch {
		// The read stream owns and closes the descriptor.
	}
	return digest.digest("hex");
}

function requireDirectory(path: string, expectedParent: string): void {
	let info: Stats;
	try {
		info = lstatSync(path);
	} catch {
		throw new StageInputValidationError(`required directory is missing: ${basename(path)}`);
	}
	if (!info.isDirectory() || info.isSymbolicLink() || dirname(realpathSync(path)) !== realpathSync(expectedParent)) {
		throw new StageInputValidationError(`unsafe directory in job tree: ${basename(path)}`);
	}
}

function requireRegularSingleLink(path: string, expectedParent: string): Stats {
	let info: Stats;
	try {
		info = lstatSync(path);
	} catch {
		throw new StageInputValidationError(`required file is missing: ${basename(path)}`);
	}
	if (
		!info.isFile() ||
		info.isSymbolicLink() ||
		info.nlink !== 1 ||
		dirname(realpathSync(path)) !== realpathSync(expectedParent)
	) {
		throw new StageInputValidationError(`unsafe file in job tree: ${basename(path)}`);
	}
	return info;
}

function requireSealedMode(path: string): void {
	if ((lstatSync(path).mode & 0o222) !== 0) {
		throw new StageInputValidationError(`sealed input remains writable: ${basename(path)}`);
	}
}

function requireExactEntries(directory: string, expected: Set<string>): void {
	const actual = readdirSync(directory);
	if (actual.length !== expected.size || actual.some((entry) => !expected.has(entry))) {
		throw new StageInputValidationError(`unexpected entry in sealed input tree: ${basename(directory)}`);
	}
}

function parseResult(raw: Buffer): Record<string, unknown> {
	try {
		const parsed = JSON.parse(raw.toString("utf8"));
		if (!isObject(parsed)) throw new Error("not an object");
		return parsed;
	} catch {
		throw new StageResultValidationError("sandbox result is not a JSON object");
	}
}

function readJsonObject(path: string): Record<string, unknown> {
	const parsed = JSON.parse(readFileSync(path, "utf8"));
	if (!isObject(parsed)) throw new Error(`expected JSON object: ${path}`);
	return parsed;
}

function requireInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value)) {
		throw new StageInputValidationError(`${field} must be an integer`);
	}
	return Number(value);
}

function requireFiniteMetric(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new StageResultValidationError(`transcription metric ${field} must be finite`);
	}
	return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
