#!/usr/bin/env bash
# Hydrate a locally built canonical bundle set into the same digest-addressed
# cache layout used by cloud hosts. This command never builds or uploads.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION="${1:?usage: hydrate-runtime-bundles.sh <version> <cache-dir> <manifest-destination>}"
CACHE_DIR="${2:?usage: hydrate-runtime-bundles.sh <version> <cache-dir> <manifest-destination>}"
MANIFEST_DESTINATION="${3:?usage: hydrate-runtime-bundles.sh <version> <cache-dir> <manifest-destination>}"
MANIFEST_SOURCE="$SCRIPT_DIR/runtime-manifests/runtime-bundles-${VERSION}.json"

for command in install node sha256sum tar; do
	command -v "$command" >/dev/null 2>&1 || {
		echo "ERROR: required hydration command is missing: $command" >&2
		exit 1
	}
done

node "$SCRIPT_DIR/check-python-boundary.mjs" "$MANIFEST_SOURCE"
mkdir -p "$CACHE_DIR" "$(dirname "$MANIFEST_DESTINATION")"

while IFS=$'\t' read -r bundle_id digest; do
	if [ -z "$bundle_id" ] || ! [[ "$digest" =~ ^[a-f0-9]{64}$ ]]; then
		echo "ERROR: malformed canonical runtime manifest row" >&2
		exit 1
	fi
	archive="$SCRIPT_DIR/runtime-bundles/${bundle_id}-${VERSION}.tar.gz"
	printf '%s  %s\n' "$digest" "$archive" | sha256sum --check --status || {
		echo "ERROR: runtime bundle archive digest mismatch: $archive" >&2
		exit 1
	}
	destination="$CACHE_DIR/$digest"
	if [ ! -d "$destination" ]; then
		temporary="$(mktemp -d "$CACHE_DIR/.${digest}.XXXXXX")"
		tar xzf "$archive" -C "$temporary"
		if ! mv "$temporary" "$destination" 2>/dev/null; then
			rm -rf "$temporary"
			test -d "$destination" || exit 1
		fi
	fi
done < <(node --input-type=module - "$MANIFEST_SOURCE" <<'NODE'
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
for (const bundle of manifest.bundles) console.log(`${bundle.id}\t${bundle.digest}`);
NODE
)

install -m 0644 "$MANIFEST_SOURCE" "$MANIFEST_DESTINATION"
echo "hydrated canonical runtime bundles: $MANIFEST_DESTINATION"
