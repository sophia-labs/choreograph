#!/usr/bin/env bash
# Download and verify the immutable VibeASR and whisper.cpp model bundles.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=pins.env
source "$SCRIPT_DIR/pins.env"

OUTPUT_ROOT="${1:-}"
if [ -z "$OUTPUT_ROOT" ] || [ "$OUTPUT_ROOT" = "/" ]; then
	echo "usage: $0 <output-root>" >&2
	exit 2
fi
for command_name in curl node sha256sum; do
	command -v "$command_name" >/dev/null || {
		echo "ERROR: required command is missing: $command_name" >&2
		exit 1
	}
done

download_verified() {
	local url="$1"
	local destination="$2"
	local expected_sha256="$3"
	local expected_bytes="$4"
	local temporary="${destination}.download"
	if [ -f "$destination" ] &&
		[ "$(stat -c %s "$destination" 2>/dev/null || stat -f %z "$destination")" = "$expected_bytes" ] &&
		[ "$(sha256sum "$destination" | awk '{print $1}')" = "$expected_sha256" ]; then
		echo "Reusing verified model: $destination"
		return
	fi
	rm -f "$temporary"
	curl --fail --location --retry 5 --retry-all-errors --output "$temporary" "$url"
	if [ "$(stat -c %s "$temporary" 2>/dev/null || stat -f %z "$temporary")" != "$expected_bytes" ]; then
		echo "ERROR: downloaded model has the wrong byte count: $destination" >&2
		exit 1
	fi
	echo "$expected_sha256  $temporary" | sha256sum --check -
	mv "$temporary" "$destination"
}

VIBE_OUTPUT="$OUTPUT_ROOT/vibeasr-bitnet"
WHISPER_OUTPUT="$OUTPUT_ROOT/whisper-small-en"
mkdir -p "$VIBE_OUTPUT" "$WHISPER_OUTPUT"

download_verified \
	"https://huggingface.co/${VIBE_MODEL_REPOSITORY}/resolve/${VIBE_MODEL_REVISION}/${VIBE_VAE_FILENAME}" \
	"$VIBE_OUTPUT/$VIBE_VAE_FILENAME" \
	"$VIBE_VAE_SHA256" \
	"$VIBE_VAE_BYTES"
download_verified \
	"https://huggingface.co/${VIBE_MODEL_REPOSITORY}/resolve/${VIBE_MODEL_REVISION}/${VIBE_LM_FILENAME}" \
	"$VIBE_OUTPUT/$VIBE_LM_FILENAME" \
	"$VIBE_LM_SHA256" \
	"$VIBE_LM_BYTES"
download_verified \
	"https://huggingface.co/${WHISPER_MODEL_REPOSITORY}/resolve/${WHISPER_MODEL_REVISION}/${WHISPER_MODEL_FILENAME}" \
	"$WHISPER_OUTPUT/$WHISPER_MODEL_FILENAME" \
	"$WHISPER_MODEL_SHA256" \
	"$WHISPER_MODEL_BYTES"

curl --fail --location --retry 5 \
	"https://raw.githubusercontent.com/microsoft/VibeASR.cpp/${VIBEASR_COMMIT}/LICENSE" \
	--output "$VIBE_OUTPUT/LICENSE"
curl --fail --location --retry 5 \
	"https://huggingface.co/${VIBE_MODEL_REPOSITORY}/raw/${VIBE_MODEL_REVISION}/README.md" \
	--output "$VIBE_OUTPUT/MODEL_CARD.md"
curl --fail --location --retry 5 \
	"https://raw.githubusercontent.com/ggml-org/whisper.cpp/${WHISPER_CPP_COMMIT}/LICENSE" \
	--output "$WHISPER_OUTPUT/LICENSE"
curl --fail --location --retry 5 \
	"https://huggingface.co/${WHISPER_MODEL_REPOSITORY}/raw/${WHISPER_MODEL_REVISION}/README.md" \
	--output "$WHISPER_OUTPUT/MODEL_CARD.md"

node - "$VIBE_OUTPUT" "$VIBE_MODEL_REVISION" "$VIBE_VAE_FILENAME" "$VIBE_LM_FILENAME" <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [root, revision, vaeName, lmName] = process.argv.slice(2);
function record(path) {
	const raw = readFileSync(join(root, path));
	return { path, sha256: createHash("sha256").update(raw).digest("hex"), bytes: statSync(join(root, path)).size };
}
writeFileSync(
	join(root, "provenance.json"),
	`${JSON.stringify(
		{
			schema_version: 1,
			name: "vibeasr-bitnet",
			model_revision: revision,
			files: {
				vae: record(vaeName),
				lm: record(lmName),
				license: record("LICENSE"),
				model_card: record("MODEL_CARD.md"),
			},
		},
		null,
		2,
	)}\n`,
);
NODE

node - "$WHISPER_OUTPUT" "$WHISPER_MODEL_REVISION" "$WHISPER_MODEL_FILENAME" <<'NODE'
const { createHash } = require("node:crypto");
const { readFileSync, statSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [root, revision, modelName] = process.argv.slice(2);
function record(path) {
	const raw = readFileSync(join(root, path));
	return { path, sha256: createHash("sha256").update(raw).digest("hex"), bytes: statSync(join(root, path)).size };
}
writeFileSync(
	join(root, "provenance.json"),
	`${JSON.stringify(
		{
			schema_version: 1,
			name: "whisper-small-en",
			model_revision: revision,
			files: {
				model: record(modelName),
				license: record("LICENSE"),
				model_card: record("MODEL_CARD.md"),
			},
		},
		null,
		2,
	)}\n`,
);
NODE

echo "Prepared model bundle roots under: $OUTPUT_ROOT"
