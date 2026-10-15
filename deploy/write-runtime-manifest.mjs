#!/usr/bin/env node

import { writeFileSync } from "node:fs";

const [outputPath, ...fields] = process.argv.slice(2);
if (!outputPath || fields.length === 0 || fields.length % 4 !== 0) {
	throw new Error("usage: write-runtime-manifest.mjs <output> (<id> <digest> <s3-key> <guest-path>)+");
}

const bundles = [];
const descriptions = {
	"sophia-agent-runtime": "Sophia agent semantic core with simple and constrained-Prime profiles",
	"sophia-kernel-runtime": "Sophia-owned Python kernel control and harness runtime",
	"jupyter-bridge": "Sophia-owned native Rust Jupyter controller",
	"python-runtime": "Pinned third-party CPython and ipykernel sandbox guest payload",
	"asr-runtime": "Pinned sandbox-only VibeASR and Whisper executable runtime",
	"asr-vibeasr-bitnet-model": "Pinned Microsoft VibeASR BitNet model payload",
	"asr-whisper-small-en-model": "Pinned whisper.cpp small.en fallback model payload",
};
for (let index = 0; index < fields.length; index += 4) {
	const [id, digest, s3Key, guestPath] = fields.slice(index, index + 4);
	if (
		!id ||
		!descriptions[id] ||
		!/^[a-f0-9]{64}$/.test(digest) ||
		!s3Key ||
		!guestPath?.startsWith("/")
	) {
		throw new Error(`invalid runtime bundle manifest entry at index ${index / 4}`);
	}
	bundles.push({
		id,
		description: descriptions[id],
		digest,
		s3_key: s3Key,
		mounts: [{ guest_path: guestPath, local_subpath: ".", mode: "ro" }],
	});
}

const baseExpected = ["sophia-agent-runtime", "sophia-kernel-runtime", "jupyter-bridge", "python-runtime"].sort();
const asrExpected = [
	...baseExpected,
	"asr-runtime",
	"asr-vibeasr-bitnet-model",
	"asr-whisper-small-en-model",
].sort();
const actual = bundles.map((bundle) => bundle.id).sort();
if (
	JSON.stringify(actual) !== JSON.stringify(baseExpected) &&
	JSON.stringify(actual) !== JSON.stringify(asrExpected)
) {
	throw new Error(
		`canonical runtime manifest requires the base set or the base plus exact ASR set; got ${actual.join(", ")}`,
	);
}

writeFileSync(outputPath, `${JSON.stringify({ bundles }, null, 2)}\n`, "utf8");
