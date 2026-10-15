#!/usr/bin/env bash
# Build, prove, and optionally publish the host release plus the complete runtime
# bundle manifest as one rollout unit. The canonical manifest is uploaded last.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION="${1:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)}"
MODE="${2:-}"

if [ -n "$MODE" ] && [ "$MODE" != "--upload" ]; then
	echo "ERROR: unsupported release mode: $MODE" >&2
	exit 1
fi

# A Cloud-2 host always wires the Soil capability and fails boot when the
# executable is absent.  Keep developer-only packages permissive, but make the
# canonical publisher close that gap before it spends time building anything.
# The native builder supplies this binary from the independently pinned Soil
# source stratum; an upload from any other path must do the same.
REQUIRE_SOIL="${CHOREOGRAPH_REQUIRE_SOIL_BINARY:-0}"
if [ "$MODE" = "--upload" ]; then
	REQUIRE_SOIL=1
	export CHOREOGRAPH_REQUIRE_SOIL_BINARY=1
	if [ -z "${CHOREOGRAPH_SOIL_BINARY:-}" ]; then
		echo "ERROR: Cloud-2 release upload requires CHOREOGRAPH_SOIL_BINARY" >&2
		exit 1
	fi
fi

RELEASE_TARBALL="$REPO_ROOT/deploy/choreograph-${VERSION}.tar.gz"
RUNTIME_MANIFEST_PATH="$REPO_ROOT/deploy/runtime-manifests/runtime-bundles-${VERSION}.json"
RUNTIME_MANIFEST_KEY="runtime-manifests/$(basename "$RUNTIME_MANIFEST_PATH")"
METADATA_PATH="$REPO_ROOT/deploy/release-metadata-${VERSION}.json"
TFVARS_PATH="$REPO_ROOT/deploy/release-terraform-${VERSION}.auto.tfvars.json"
DEFAULT_DEPLOY_BUCKET="choreograph-deploy-20260402192255814600000001"

if [ "$MODE" = "--upload" ]; then
	DEPLOY_BUCKET="${DEPLOY_BUCKET:-$DEFAULT_DEPLOY_BUCKET}"
	command -v aws >/dev/null 2>&1 || {
		echo "ERROR: aws CLI is required for --upload" >&2
		exit 1
	}
else
	DEPLOY_BUCKET="${DEPLOY_BUCKET:-}"
fi

echo "==> Preparing and proving choreograph release unit: $VERSION"
cd "$REPO_ROOT"
if [ -n "${PNPM_STORE_DIR:-}" ]; then
	pnpm install --frozen-lockfile --store-dir "$PNPM_STORE_DIR"
else
	pnpm install --frozen-lockfile
fi
pnpm build

# Neither package command can upload. Every build, import, hash, Rust, Jupyter,
# bwrap, ASR provenance, hydration, and manifest gate completes before this
# script reaches S3.
CHOREOGRAPH_SKIP_PREBUILD=1 "$SCRIPT_DIR/package.sh" "$VERSION"
CHOREOGRAPH_SKIP_PREBUILD=1 \
	INCLUDE_ASR_BUNDLES="${INCLUDE_ASR_BUNDLES:-1}" \
	"$SCRIPT_DIR/package-runtime-bundles.sh" "$VERSION"

# Verify the host artifact as a deployable unit before producing metadata or
# publishing any object.  Materialize the listing: `tar | grep -q` under
# pipefail turns an early successful match into a false failure when tar gets
# SIGPIPE (the same historical foot-gun guarded in the native builder).
RELEASE_LISTING="$(mktemp)"
trap 'rm -f "$RELEASE_LISTING"' EXIT
tar tzf "$RELEASE_TARBALL" > "$RELEASE_LISTING"
grep -Fqx 'choreograph/dist/browser-service/main.js' "$RELEASE_LISTING" || {
	echo "ERROR: host release is missing the compiled browser service" >&2
	exit 1
}
grep -Fq 'choreograph/node_modules/.pnpm/@esbuild+linux-x64@' "$RELEASE_LISTING" || {
	echo "ERROR: host release is missing the Linux esbuild runtime" >&2
	exit 1
}
if grep -Fq 'choreograph/node_modules/.pnpm/@esbuild+darwin-' "$RELEASE_LISTING"; then
	echo "ERROR: host release contains a Darwin esbuild runtime" >&2
	exit 1
fi
if [ "$REQUIRE_SOIL" = "1" ]; then
	grep -Fqx 'choreograph/bin/soil' "$RELEASE_LISTING" || {
		echo "ERROR: Cloud-2 host release is missing the pinned Soil capability" >&2
		exit 1
	}
fi

node "$SCRIPT_DIR/write-release-metadata.mjs" \
	"$VERSION" \
	"$RELEASE_TARBALL" \
	"$RUNTIME_MANIFEST_PATH" \
	"$METADATA_PATH" \
	"$TFVARS_PATH" \
	"$DEPLOY_BUCKET"

echo "==> Wrote release metadata: $METADATA_PATH"
echo "==> Wrote directly consumable Terraform vars: $TFVARS_PATH"

if [ "$MODE" = "--upload" ]; then
	echo "==> All local gates passed; publishing immutable artifacts"
	aws s3 cp "$RELEASE_TARBALL" "s3://${DEPLOY_BUCKET}/releases/$(basename "$RELEASE_TARBALL")"

	while IFS=$'\t' read -r bundle_id s3_key archive_suffix; do
		if [ -z "$bundle_id" ] || [ -z "$s3_key" ] || [ -z "$archive_suffix" ]; then
			echo "ERROR: malformed runtime manifest upload row" >&2
			exit 1
		fi
		aws s3 cp \
			"$REPO_ROOT/deploy/runtime-bundles/${bundle_id}-${VERSION}${archive_suffix}" \
			"s3://${DEPLOY_BUCKET}/${s3_key}"
	done < <(node --input-type=module - "$RUNTIME_MANIFEST_PATH" <<'NODE'
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const bundle of manifest.bundles) {
  const suffix = bundle.s3_key.endsWith(".tar.gz")
    ? ".tar.gz"
    : bundle.s3_key.endsWith(".tar")
      ? ".tar"
      : null;
  if (!suffix) throw new Error(`unsupported runtime bundle key: ${bundle.s3_key}`);
  console.log(`${bundle.id}\t${bundle.s3_key}\t${suffix}`);
}
NODE
)

	# Publish the canonical pointer last. Failed earlier uploads leave only
	# unreachable content-addressed objects, never an incomplete release manifest.
	aws s3 cp "$RUNTIME_MANIFEST_PATH" "s3://${DEPLOY_BUCKET}/${RUNTIME_MANIFEST_KEY}"
	echo "==> Published verified release unit: $VERSION"
else
	echo "==> Artifacts built and proved locally. Upload mode was not requested."
fi

echo "==> Authoritative Terraform handoff (platform-next/terraform):"
echo "    terraform plan -var-file=$TFVARS_PATH"
