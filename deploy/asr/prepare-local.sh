#!/usr/bin/env bash
# Reproducibly prepare Linux/x86_64 ASR roots through an AL2023-compatible build
# container. This does not package, upload, or deploy anything.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUTPUT_ROOT="${1:-$REPO_ROOT/.cache/asr-bundles}"
BUILDER_IMAGE="${ASR_BUILDER_IMAGE:-choreograph-asr-builder:local}"

docker build --file "$SCRIPT_DIR/Dockerfile.build" --tag "$BUILDER_IMAGE" "$REPO_ROOT"
mkdir -p "$OUTPUT_ROOT"

docker run --rm \
	--platform linux/amd64 \
	--volume "$REPO_ROOT:/workspace:ro" \
	--volume "$OUTPUT_ROOT:/output" \
	--volume choreograph-asr-source-cache:/build-cache \
	--env ASR_SOURCE_CACHE_DIR=/build-cache \
	--env ASR_BUILD_JOBS="${ASR_BUILD_JOBS:-4}" \
	"$BUILDER_IMAGE" \
	/workspace/deploy/asr/build-runtime.sh /output/runtime

docker run --rm \
	--platform linux/amd64 \
	--volume "$REPO_ROOT:/workspace:ro" \
	--volume "$OUTPUT_ROOT:/output" \
	"$BUILDER_IMAGE" \
	/workspace/deploy/asr/download-models.sh /output/models

echo "Prepared local ASR roots: $OUTPUT_ROOT"
