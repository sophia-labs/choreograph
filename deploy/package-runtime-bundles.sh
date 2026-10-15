#!/usr/bin/env bash
# Build the complete, content-addressed runtime bundle set. This command never
# uploads: deploy/release.sh owns the single post-verification publication gate.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOPHIA_AGENT_SOURCE="${SOPHIA_AGENT_SOURCE:-$REPO_ROOT/../prime-agent-sophia}"
VERSION="${1:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)}"
MODE="${2:-}"

PYTHON_ASSET="cpython-3.12.13+20260510-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"
PYTHON_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20260510/cpython-3.12.13%2B20260510-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"
PYTHON_SHA256="d480f5d5878910ecbae212bf23bd7c25d7b209eb8cf5e98823c977384d272e88"
UV_ASSET="uv-x86_64-unknown-linux-gnu.tar.gz"
UV_URL="https://github.com/astral-sh/uv/releases/download/0.11.28/uv-x86_64-unknown-linux-gnu.tar.gz"
UV_SHA256="e490a6464492183c5d4534a5527fb4440f7f2bb2f228162ad7e4afe076dc0224"
PYTHON_GUEST_PATH="/opt/runtime/python/bin/python3"

OUT_BUNDLES_DIR="$REPO_ROOT/deploy/runtime-bundles"
OUT_MANIFESTS_DIR="$REPO_ROOT/deploy/runtime-manifests"
CACHE_DIR="${CHOREOGRAPH_RUNTIME_DOWNLOAD_CACHE:-${XDG_CACHE_HOME:-${HOME:-/tmp}/.cache}/choreograph-runtime}"
STAGE="$(mktemp -d)"

trap 'rm -rf "$STAGE"' EXIT

if [ -n "$MODE" ]; then
	echo "ERROR: package-runtime-bundles.sh does not upload. Run deploy/release.sh <version> --upload after all gates pass." >&2
	exit 1
fi
if [ -n "${SKIP_PYTHON_RUNTIME_BUNDLE:-}" ]; then
	echo "ERROR: SKIP_PYTHON_RUNTIME_BUNDLE was removed because it produced incomplete canonical manifests." >&2
	exit 1
fi
if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
	echo "ERROR: canonical runtime bundles must be built on Linux x86_64 (got $(uname -s) $(uname -m))." >&2
	exit 1
fi
if [ ! -f "$SOPHIA_AGENT_SOURCE/packages/coding-agent/package.json" ]; then
	echo "ERROR: SOPHIA_AGENT_SOURCE must point at the reviewed Sophia Prime fork" >&2
	exit 1
fi

for command in bwrap cargo curl file gzip musl-gcc node pnpm readelf sha256sum tar; do
	command -v "$command" >/dev/null 2>&1 || {
		echo "ERROR: required build command is missing: $command" >&2
		exit 1
	}
done

mkdir -p "$OUT_BUNDLES_DIR" "$OUT_MANIFESTS_DIR" "$CACHE_DIR"
echo "==> Building complete runtime bundle set for version: $VERSION"
node "$SCRIPT_DIR/check-python-boundary.mjs"

fetch_verified() {
	local url="$1"
	local digest="$2"
	local destination="$3"
	local temporary="${destination}.part.$$"

	if [ -f "$destination" ] && printf '%s  %s\n' "$digest" "$destination" | sha256sum --check --status; then
		return
	fi
	rm -f "$destination" "$temporary"
	curl --fail --location --retry 3 --output "$temporary" "$url"
	printf '%s  %s\n' "$digest" "$temporary" | sha256sum --check --status || {
		rm -f "$temporary"
		echo "ERROR: checksum mismatch for $url" >&2
		exit 1
	}
	mv "$temporary" "$destination"
}

if [ "${CHOREOGRAPH_SKIP_PREBUILD:-0}" != "1" ]; then
	cd "$REPO_ROOT"
	if [ -n "${PNPM_STORE_DIR:-}" ]; then
		pnpm install --frozen-lockfile --store-dir "$PNPM_STORE_DIR"
	else
		pnpm install --frozen-lockfile
	fi
	pnpm build
	cd "$SOPHIA_AGENT_SOURCE"
	if [ -n "${PNPM_STORE_DIR:-}" ]; then
		pnpm install --frozen-lockfile --store-dir "$PNPM_STORE_DIR"
	else
		pnpm install --frozen-lockfile
	fi
	pnpm build
fi

test -f "$SOPHIA_AGENT_SOURCE/packages/coding-agent/dist/sophia/host-worker.js" || {
	echo "ERROR: Sophia agent host worker is not built" >&2
	exit 1
}

PYTHON_ARCHIVE="$CACHE_DIR/$PYTHON_ASSET"
UV_ARCHIVE="$CACHE_DIR/$UV_ASSET"
fetch_verified "$PYTHON_URL" "$PYTHON_SHA256" "$PYTHON_ARCHIVE"
fetch_verified "$UV_URL" "$UV_SHA256" "$UV_ARCHIVE"

mkdir -p \
	"$STAGE/sophia-agent-runtime" \
	"$STAGE/sophia-kernel-runtime" \
	"$STAGE/jupyter-bridge" \
	"$STAGE/python-runtime" \
	"$STAGE/uv"

echo "==> Hydrating pinned standalone Python guest payload"
tar xzf "$PYTHON_ARCHIVE" -C "$STAGE/python-runtime" --strip-components=1
tar xzf "$UV_ARCHIVE" -C "$STAGE/uv"
UV_BIN="$(find "$STAGE/uv" -type f -name uv -perm -111 -print -quit)"
if [ -z "$UV_BIN" ]; then
	echo "ERROR: verified uv archive did not contain an executable uv binary" >&2
	exit 1
fi

UV_SYSTEM_PYTHON=1 "$UV_BIN" pip install \
	--python "$STAGE/python-runtime/bin/python3" \
	--system \
	--require-hashes \
	--no-deps \
	--only-binary :all: \
	-r "$SCRIPT_DIR/python-runtime-requirements.lock"

normalize_python_payload() {
	local python_root="$1"
	local script
	local first_line
	local staging_matches

	# uv correctly targets the staged interpreter, but its generated console
	# entrypoints therefore capture the random build directory. Rewrite only
	# Python shebangs to the immutable guest path used after mounting.
	while IFS= read -r -d '' script; do
		if [ "$(head -c 2 "$script" 2>/dev/null || true)" != "#!" ]; then
			continue
		fi
		first_line="$(head -n 1 "$script")"
		if [[ "$first_line" == "#!${python_root}/bin/python3"* ]]; then
			sed -i "1c\\#!${PYTHON_GUEST_PATH}" "$script"
		fi
	done < <(find "$python_root/bin" -maxdepth 1 -type f -print0)

	# Bytecode embeds co_filename with the random staging prefix. A read-only
	# guest can import source directly, so shipping it would add no authority and
	# would make identical committed inputs hash differently across builds.
	find "$python_root" -type d -name __pycache__ -prune -exec rm -rf {} +
	find "$python_root" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete

	# Console-script bytes changed, so refresh their wheel RECORD hashes as well.
	# Leaving uv's pre-normalization hashes would preserve the random staging path
	# indirectly and make otherwise identical payload trees hash differently.
	node --input-type=module - "$python_root" <<'NODE'
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
const records = [];
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) visit(path);
    else if (entry.name === "RECORD" && directory.endsWith(".dist-info")) records.push(path);
  }
}
visit(join(root, "lib", "python3.12", "site-packages"));

for (const record of records) {
  const lines = readFileSync(record, "utf8").trimEnd().split("\n");
  const normalized = lines.map((line) => {
    if (!line.startsWith("../../../bin/")) return line;
    const comma = line.indexOf(",");
    const relativePath = line.slice(0, comma);
    const script = join(root, "bin", relativePath.slice("../../../bin/".length));
    if (!existsSync(script)) return line;
    const bytes = readFileSync(script);
    const digest = createHash("sha256").update(bytes).digest("base64url");
    return `${relativePath},sha256=${digest},${statSync(script).size}`;
  });
  writeFileSync(record, `${normalized.join("\n")}\n`, "utf8");
}
NODE

	if [ "$(head -n 1 "$python_root/bin/ipython")" != "#!${PYTHON_GUEST_PATH}" ]; then
		echo "ERROR: Python console entrypoints were not normalized to the guest interpreter" >&2
		exit 1
	fi
	staging_matches="$(grep -RlaF "$python_root" "$python_root" || true)"
	if [ -n "$staging_matches" ]; then
		echo "ERROR: Python guest payload contains its temporary staging path:" >&2
		printf '%s\n' "$staging_matches" >&2
		exit 1
	fi
}

normalize_python_payload "$STAGE/python-runtime"
PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 "$STAGE/python-runtime/bin/python3" -I -c \
	'import sys, ipykernel, jupyter_client, zmq; assert sys.version_info[:2] == (3, 12)'

echo "==> Staging Sophia-owned kernel runtime"
cp -R "$REPO_ROOT/packages/sophia-kernel-runtime/src" "$STAGE/sophia-kernel-runtime/src"
cp -R "$REPO_ROOT/packages/sophia-kernel-runtime/contract" "$STAGE/sophia-kernel-runtime/contract"
cp "$REPO_ROOT/packages/sophia-kernel-runtime/pyproject.toml" "$STAGE/sophia-kernel-runtime/pyproject.toml"
cp "$REPO_ROOT/packages/sophia-kernel-runtime/README.md" "$STAGE/sophia-kernel-runtime/README.md"
PYTHONPATH="$STAGE/sophia-kernel-runtime/src" PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 \
	"$STAGE/python-runtime/bin/python3" -c \
	'import dill, httpx, mcp, pathlib, rlm, rlm.mcp_base, rlm.skill, tyro; assert pathlib.Path(rlm.__file__).is_relative_to(pathlib.Path("'"$STAGE"'/sophia-kernel-runtime/src"))'

echo "==> Building and checking the Sophia-owned Rust bridge"
(
	cd "$REPO_ROOT/crates/jupyter-bridge"
	# `ring` compiles native objects and therefore needs a musl C compiler, but
	# using musl-gcc as Rust's final linker produces a dynamically-linked PIE on
	# some distributions. Keep those responsibilities separate: musl-gcc builds
	# the native dependency objects; Rust's pinned rust-lld links the final,
	# self-contained static PIE that the release contract requires.
	export CC_x86_64_unknown_linux_musl="${CC_x86_64_unknown_linux_musl:-musl-gcc}"
	export CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER="${CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER:-rust-lld}"
	cargo fmt -- --check
	cargo clippy --locked -- -D warnings
	cargo test --locked
	RUSTFLAGS="${RUSTFLAGS:+${RUSTFLAGS} }-C target-feature=+crt-static" \
		cargo build --locked --release --target x86_64-unknown-linux-musl
)
cp "$REPO_ROOT/crates/jupyter-bridge/target/x86_64-unknown-linux-musl/release/choreograph-jupyter-bridge" \
	"$STAGE/jupyter-bridge/jupyter-bridge"
chmod 0755 "$STAGE/jupyter-bridge/jupyter-bridge"
"$STAGE/jupyter-bridge/jupyter-bridge" --version
BRIDGE_FILE_INFO="$(file "$STAGE/jupyter-bridge/jupyter-bridge")"
BRIDGE_PROGRAM_HEADERS="$(readelf --program-headers "$STAGE/jupyter-bridge/jupyter-bridge")"
echo "$BRIDGE_FILE_INFO"
if [[ "$BRIDGE_FILE_INFO" != *"ELF 64-bit"* || "$BRIDGE_FILE_INFO" != *"x86-64"* ]] \
	|| [[ "$BRIDGE_PROGRAM_HEADERS" == *" INTERP "* ]]; then
	echo "ERROR: canonical bridge must be a static Linux x86_64 ELF (musl)" >&2
	exit 1
fi

# Sophia agent runtime: deploy the reviewed fork and all of its production
# workspace dependencies from the frozen pnpm graph. Both simple and Prime
# profiles execute this exact content-addressed payload.
SA="$STAGE/sophia-agent-runtime"
SA_PACKAGE="$SA/node_modules/@earendil-works/pi-coding-agent"
PNPM_DEPLOY=(pnpm --dir "$SOPHIA_AGENT_SOURCE")
if [ -n "${PNPM_STORE_DIR:-}" ]; then
	PNPM_DEPLOY+=(--store-dir "$PNPM_STORE_DIR")
fi
echo "==> Deploying locked Sophia agent runtime with pnpm"
"${PNPM_DEPLOY[@]}" \
	--filter @earendil-works/pi-coding-agent \
	deploy --prod --offline --ignore-scripts "$SA_PACKAGE"
node "$SCRIPT_DIR/normalize-sophia-agent-runtime.mjs" "$SA" "$SA_PACKAGE"
node --check "$SA_PACKAGE/dist/sophia/host-worker.js"

echo "==> Exercising staged guest capabilities with real bwrap"
node "$SCRIPT_DIR/smoke-jupyter-bundles.mjs" \
	"$STAGE/python-runtime" \
	"$STAGE/jupyter-bridge" \
	"$STAGE/sophia-kernel-runtime" \
	"$REPO_ROOT/src/worker.mjs"
normalize_python_payload "$STAGE/python-runtime"

BUNDLE_IDS=()
BUNDLE_TARBALLS=()
MANIFEST_ARGS=()

build_bundle() {
	local bundle_id="$1"
	local source_dir="$2"
	local guest_path="$3"
	local archive_format="${4:-tar.gz}"
	local tarball_path="$OUT_BUNDLES_DIR/${bundle_id}-${VERSION}.${archive_format}"
	local digest
	local s3_key

	case "$archive_format" in
		tar.gz)
			TZ=UTC tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -cf - -C "$source_dir" . \
				| gzip -n > "$tarball_path"
			;;
		tar)
			if ! tar --version 2>/dev/null | head -n1 | grep -q "GNU tar"; then
				echo "ERROR: deterministic raw archives require GNU tar." >&2
				exit 1
			fi
			TZ=UTC tar \
				--sort=name \
				--mtime='@0' \
				--owner=0 \
				--group=0 \
				--numeric-owner \
				-cf "$tarball_path" \
				-C "$source_dir" .
			;;
		*)
			echo "ERROR: unsupported runtime bundle archive format: $archive_format" >&2
			exit 1
			;;
	esac
	digest="$(sha256sum "$tarball_path" | awk '{print $1}')"
	s3_key="runtime-bundles/${bundle_id}/sha256-${digest}.${archive_format}"
	BUNDLE_IDS+=("$bundle_id")
	BUNDLE_TARBALLS+=("$tarball_path")
	MANIFEST_ARGS+=("$bundle_id" "$digest" "$s3_key" "$guest_path")
}

build_bundle "sophia-agent-runtime" "$STAGE/sophia-agent-runtime" "/opt/choreograph-runtime/sophia-agent"
build_bundle "sophia-kernel-runtime" "$STAGE/sophia-kernel-runtime" "/opt/choreograph-runtime/sophia-kernel-runtime"
build_bundle "jupyter-bridge" "$STAGE/jupyter-bridge" "/opt/choreograph-runtime/bridges"
build_bundle "python-runtime" "$STAGE/python-runtime" "/opt/runtime/python"

if tar tzf "$OUT_BUNDLES_DIR/jupyter-bridge-${VERSION}.tar.gz" | grep -Eq '\.py([co])?$'; then
	echo "ERROR: Sophia-owned bridge bundle contains Python implementation files" >&2
	exit 1
fi

# ASR weights are intentionally separate from the host release and from the
# executable runtime. A selected sandbox mounts the small runtime plus exactly
# one model bundle. Raw deterministic tar archives avoid wasting CPU trying to
# recompress already-quantized GGUF files and keep their content addresses
# stable across releases.
if [ "${INCLUDE_ASR_BUNDLES:-0}" = "1" ]; then
	ASR_BUILD_ROOT="${ASR_BUILD_ROOT:-$REPO_ROOT/.cache/asr-bundles}"
	ASR_RUNTIME_ROOT="${ASR_RUNTIME_ROOT:-$ASR_BUILD_ROOT/runtime}"
	ASR_MODELS_ROOT="${ASR_MODELS_ROOT:-$ASR_BUILD_ROOT/models}"

	if [ "${ASR_SKIP_PREPARE:-0}" != "1" ]; then
		bash "$SCRIPT_DIR/asr/build-runtime.sh" "$ASR_RUNTIME_ROOT"
		bash "$SCRIPT_DIR/asr/download-models.sh" "$ASR_MODELS_ROOT"
	fi
	for required_file in \
		"$ASR_RUNTIME_ROOT/provenance.json" \
		"$ASR_MODELS_ROOT/vibeasr-bitnet/provenance.json" \
		"$ASR_MODELS_ROOT/whisper-small-en/provenance.json"; do
		if [ ! -f "$required_file" ]; then
			echo "ERROR: prepared ASR bundle is missing: $required_file" >&2
			exit 1
		fi
	done

	build_bundle "asr-runtime" "$ASR_RUNTIME_ROOT" "/opt/choreograph-runtime/asr" "tar"
	build_bundle \
		"asr-vibeasr-bitnet-model" \
		"$ASR_MODELS_ROOT/vibeasr-bitnet" \
		"/opt/choreograph-models/vibeasr-bitnet" \
		"tar"
	build_bundle \
		"asr-whisper-small-en-model" \
		"$ASR_MODELS_ROOT/whisper-small-en" \
		"/opt/choreograph-models/whisper-small-en" \
		"tar"
fi

MANIFEST_PATH="$OUT_MANIFESTS_DIR/runtime-bundles-${VERSION}.json"
node "$SCRIPT_DIR/write-runtime-manifest.mjs" "$MANIFEST_PATH" "${MANIFEST_ARGS[@]}"
node "$SCRIPT_DIR/check-python-boundary.mjs" "$MANIFEST_PATH"

# Rehydrate the actual tarballs and repeat the behavioral gate. This proves the
# content-addressed artifact, not merely the pre-tar staging directory.
HYDRATED="$STAGE/hydrated"
mkdir -p "$HYDRATED"
for index in "${!BUNDLE_IDS[@]}"; do
	mkdir -p "$HYDRATED/${BUNDLE_IDS[$index]}"
	case "${BUNDLE_TARBALLS[$index]}" in
		*.tar.gz) tar xzf "${BUNDLE_TARBALLS[$index]}" -C "$HYDRATED/${BUNDLE_IDS[$index]}" ;;
		*.tar) tar xf "${BUNDLE_TARBALLS[$index]}" -C "$HYDRATED/${BUNDLE_IDS[$index]}" ;;
		*) echo "ERROR: unsupported hydrated bundle archive: ${BUNDLE_TARBALLS[$index]}" >&2; exit 1 ;;
	esac
done
node "$SCRIPT_DIR/smoke-jupyter-bundles.mjs" \
	"$HYDRATED/python-runtime" \
	"$HYDRATED/jupyter-bridge" \
	"$HYDRATED/sophia-kernel-runtime" \
	"$REPO_ROOT/src/worker.mjs"

echo "==> Built complete runtime manifest: $MANIFEST_PATH"
