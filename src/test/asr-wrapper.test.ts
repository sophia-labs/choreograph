import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const WRAPPER = resolve(TEST_DIR, "../../deploy/asr/transcribe_job.py");
const JOB_ID = "99999999-9999-4999-8999-999999999999";
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fileRecord(path: string, relative: string): { path: string; sha256: string; bytes: number } {
	const raw = readFileSync(path);
	return {
		path: relative,
		sha256: createHash("sha256").update(raw).digest("hex"),
		bytes: raw.length,
	};
}

function createWav(): Buffer {
	const dataBytes = 1920;
	const buffer = Buffer.alloc(44 + dataBytes);
	buffer.write("RIFF", 0);
	buffer.writeUInt32LE(36 + dataBytes, 4);
	buffer.write("WAVEfmt ", 8);
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

function updateRuntimeRecord(runtime: string, key: string, relative: string): void {
	const provenancePath = join(runtime, "provenance.json");
	const provenance = JSON.parse(readFileSync(provenancePath, "utf8"));
	provenance.files[key] = fileRecord(join(runtime, relative), relative);
	writeFileSync(provenancePath, JSON.stringify(provenance));
}

function fixture(engine: "vibe" | "whisper"): {
	root: string;
	runtime: string;
	model: string;
	manifest: string;
	output: string;
	digest: string;
} {
	const root = mkdtempSync(join(tmpdir(), `asr-wrapper-${engine}-`));
	roots.push(root);
	const runtime = join(root, "runtime");
	const model = join(root, "model");
	const input = join(root, "input");
	const outputDir = join(root, "output");
	for (const directory of [join(runtime, "bin"), model, join(input, "segments"), outputDir]) {
		mkdirSync(directory, { recursive: true });
	}
	copyFileSync(WRAPPER, join(runtime, "transcribe_job.py"));
	const ffmpeg = join(runtime, "bin", "ffmpeg");
	writeFileSync(
		ffmpeg,
		`#!/usr/bin/env python3
import pathlib, sys
source = bytearray(pathlib.Path(sys.argv[sys.argv.index("-i") + 1]).read_bytes())
sample_rate = int(sys.argv[sys.argv.index("-ar") + 1])
source[24:28] = sample_rate.to_bytes(4, "little")
source[28:32] = (sample_rate * 2).to_bytes(4, "little")
pathlib.Path(sys.argv[-1]).write_bytes(source)
`,
	);
	chmodSync(ffmpeg, 0o755);
	const runtimeFiles: Record<string, unknown> = {
		ffmpeg: fileRecord(ffmpeg, "bin/ffmpeg"),
		wrapper: fileRecord(join(runtime, "transcribe_job.py"), "transcribe_job.py"),
	};
	if (engine === "vibe") {
		const server = join(runtime, "bin", "asr_stream_server");
		writeFileSync(
			server,
			`#!/usr/bin/env python3
import sys
assert sys.argv[sys.argv.index("-c") + 1] == "2048"
assert sys.argv[sys.argv.index("--max-tokens") + 1] == "256"
print("fake vibe load", file=sys.stderr, flush=True)
print("---READY---", flush=True)
for line in sys.stdin:
    if line.strip() == "EXIT":
        break
    print("hello from vibe", flush=True)
    print("---END---", flush=True)
`,
		);
		chmodSync(server, 0o755);
		runtimeFiles.server = fileRecord(server, "bin/asr_stream_server");
	} else {
		const whisper = join(runtime, "bin", "whisper-cli");
		writeFileSync(
			whisper,
			`#!/usr/bin/env python3
import pathlib, sys
print("fake whisper load", file=sys.stderr)
prefix = pathlib.Path(sys.argv[sys.argv.index("-of") + 1])
prefix.with_suffix(".txt").write_text("hello from whisper\\n")
`,
		);
		chmodSync(whisper, 0o755);
		runtimeFiles.whisper = fileRecord(whisper, "bin/whisper-cli");
	}
	writeFileSync(
		join(runtime, "provenance.json"),
		JSON.stringify({
			vibeasr_commit: "vibe-commit",
			whisper_cpp_commit: "whisper-commit",
			files: runtimeFiles,
		}),
	);

	const modelFiles: Record<string, unknown> = {};
	if (engine === "vibe") {
		for (const [key, name] of [
			["vae", "vae.gguf"],
			["lm", "lm.gguf"],
		] as const) {
			const path = join(model, name);
			writeFileSync(path, key);
			modelFiles[key] = fileRecord(path, name);
		}
	} else {
		const path = join(model, "model.bin");
		writeFileSync(path, "model");
		modelFiles.model = fileRecord(path, "model.bin");
	}
	writeFileSync(
		join(model, "provenance.json"),
		JSON.stringify({
			name: engine === "vibe" ? "vibeasr-bitnet" : "whisper-small-en",
			model_revision: `${engine}-revision`,
			files: modelFiles,
		}),
	);

	const wav = createWav();
	writeFileSync(join(input, "segments", "000001.wav"), wav);
	const manifestValue = {
		schema_version: 1,
		job_id: JOB_ID,
		capture: {
			codec: "pcm_s16le",
			sample_rate: 48_000,
			channels: 1,
			sample_width: 2,
			dave: true,
		},
		participants: [{ discord_user_id: "speaker", display_name_snapshot: "Alice" }],
		segments: [
			{
				segment_id: "000001",
				speaker_id: "speaker",
				start_ms: 0,
				end_ms: 20,
				duration_ms: 20,
				path: "segments/000001.wav",
				sha256: createHash("sha256").update(wav).digest("hex"),
				bytes: wav.length,
				pcm_bytes: wav.length - 44,
			},
		],
		capture_warnings: ["local fixture"],
	};
	const manifestRaw = Buffer.from(JSON.stringify(manifestValue));
	const manifest = join(input, "manifest.json");
	writeFileSync(manifest, manifestRaw);
	return {
		root,
		runtime,
		model,
		manifest,
		output: join(outputDir, "result.json"),
		digest: createHash("sha256").update(manifestRaw).digest("hex"),
	};
}

for (const engine of ["vibe", "whisper"] as const) {
	describe(`ASR wrapper (${engine})`, () => {
		it("normalizes, transcribes, records provenance, and writes atomically", () => {
			const setup = fixture(engine);
			const model = engine === "vibe" ? "vibeasr-bitnet" : "whisper-small-en";
			const completed = spawnSync(
				"python3",
				[
					join(setup.runtime, "transcribe_job.py"),
					"--manifest",
					setup.manifest,
					"--output",
					setup.output,
					"--model",
					model,
					"--engine",
					engine,
					"--threads",
					"2",
					"--runtime-root",
					setup.runtime,
					"--model-root",
					setup.model,
				],
				{
					env: {
						...process.env,
						PHANES_EXPECTED_JOB_ID: JOB_ID,
						PHANES_EXPECTED_MANIFEST_SHA256: setup.digest,
					},
					encoding: "utf8",
					timeout: 30_000,
				},
			);
			assert.equal(completed.status, 0, completed.stderr);
			assert.equal(completed.stdout, "");
			const result = JSON.parse(readFileSync(setup.output, "utf8"));
			assert.equal(result.job_id, JOB_ID);
			assert.equal(result.segments[0].text, `hello from ${engine}`);
			assert.equal(result.model.name, model);
			assert.equal(result.model.runtime_commit, `${engine}-commit`);
			assert.deepEqual(result.warnings, ["local fixture"]);
			assert.equal(result.segments[0].confidence, null);
			assert.equal(readFileSync(join(setup.root, "output", "model.stderr")).length >= 0, true);
		});

		it("rejects audio bytes changed after the sealed manifest was hashed", () => {
			const setup = fixture(engine);
			const audio = join(setup.root, "input", "segments", "000001.wav");
			const tampered = readFileSync(audio);
			tampered[tampered.length - 1] ^= 0xff;
			writeFileSync(audio, tampered);
			const model = engine === "vibe" ? "vibeasr-bitnet" : "whisper-small-en";
			const completed = spawnSync(
				"python3",
				[
					join(setup.runtime, "transcribe_job.py"),
					"--manifest",
					setup.manifest,
					"--output",
					setup.output,
					"--model",
					model,
					"--engine",
					engine,
					"--threads",
					"2",
					"--runtime-root",
					setup.runtime,
					"--model-root",
					setup.model,
				],
				{
					env: {
						...process.env,
						PHANES_EXPECTED_JOB_ID: JOB_ID,
						PHANES_EXPECTED_MANIFEST_SHA256: setup.digest,
					},
					encoding: "utf8",
					timeout: 30_000,
				},
			);
			assert.notEqual(completed.status, 0);
			assert.match(completed.stderr, /does not match its sealed digest/);
			assert.equal(existsSync(setup.output), false);
		});

		it("persists bounded model diagnostics when inference fails", () => {
			const setup = fixture(engine);
			const executable =
				engine === "vibe"
					? join(setup.runtime, "bin", "asr_stream_server")
					: join(setup.runtime, "bin", "whisper-cli");
			writeFileSync(
				executable,
				engine === "vibe"
					? `#!/usr/bin/env python3
import sys
print("model failure detail", file=sys.stderr, flush=True)
print("---READY---", flush=True)
for line in sys.stdin:
    if line.strip() == "EXIT":
        break
    print("[ERROR] forced failure", flush=True)
`
					: `#!/usr/bin/env python3
import sys
print("model failure detail", file=sys.stderr, flush=True)
raise SystemExit(2)
`,
			);
			chmodSync(executable, 0o755);
			updateRuntimeRecord(
				setup.runtime,
				engine === "vibe" ? "server" : "whisper",
				engine === "vibe" ? "bin/asr_stream_server" : "bin/whisper-cli",
			);
			const completed = spawnSync(
				"python3",
				[
					join(setup.runtime, "transcribe_job.py"),
					"--manifest",
					setup.manifest,
					"--output",
					setup.output,
					"--model",
					engine === "vibe" ? "vibeasr-bitnet" : "whisper-small-en",
					"--engine",
					engine,
					"--threads",
					"2",
					"--runtime-root",
					setup.runtime,
					"--model-root",
					setup.model,
				],
				{
					env: {
						...process.env,
						PHANES_EXPECTED_JOB_ID: JOB_ID,
						PHANES_EXPECTED_MANIFEST_SHA256: setup.digest,
					},
					encoding: "utf8",
					timeout: 30_000,
				},
			);
			assert.notEqual(completed.status, 0);
			assert.equal(existsSync(setup.output), false);
			assert.match(readFileSync(join(setup.root, "output", "model.stderr"), "utf8"), /model failure detail/);
		});
	});
}
