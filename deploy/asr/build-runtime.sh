#!/usr/bin/env bash
# Build the fixed Linux/x86_64 ASR runtime bundle from immutable source pins.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=pins.env
source "$SCRIPT_DIR/pins.env"

OUTPUT_DIR="${1:-}"
BUILD_ROOT="${ASR_SOURCE_CACHE_DIR:-$REPO_ROOT/.cache/asr-sources}"
BUILD_JOBS="${ASR_BUILD_JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)}"

if [ -z "$OUTPUT_DIR" ] || [ "$OUTPUT_DIR" = "/" ]; then
	echo "usage: $0 <output-directory>" >&2
	exit 2
fi
if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
	echo "ERROR: ASR runtime bundles must be built on Linux/x86_64." >&2
	exit 1
fi
for command_name in cmake git make node python3 sha256sum strip; do
	command -v "$command_name" >/dev/null || {
		echo "ERROR: required build command is missing: $command_name" >&2
		exit 1
	}
done
python3 "$SCRIPT_DIR/transcribe_job.py" --help >/dev/null

mkdir -p "$BUILD_ROOT"

checkout_exact() {
	local repository="$1"
	local commit="$2"
	local checkout_dir="$3"
	if [ ! -d "$checkout_dir/.git" ]; then
		rm -rf "$checkout_dir"
		git clone --filter=blob:none --no-checkout "$repository" "$checkout_dir"
	fi
	git -C "$checkout_dir" remote set-url origin "$repository"
	git -C "$checkout_dir" fetch --depth=1 origin "$commit"
	git -C "$checkout_dir" checkout --detach --force "$commit"
	test "$(git -C "$checkout_dir" rev-parse HEAD)" = "$commit"
}

VIBE_SOURCE="$BUILD_ROOT/vibeasr-$VIBEASR_COMMIT"
WHISPER_SOURCE="$BUILD_ROOT/whisper-$WHISPER_CPP_COMMIT"
FFMPEG_SOURCE="$BUILD_ROOT/ffmpeg-$FFMPEG_COMMIT"

checkout_exact "$VIBEASR_REPOSITORY" "$VIBEASR_COMMIT" "$VIBE_SOURCE"
git -C "$VIBE_SOURCE" submodule sync --recursive
git -C "$VIBE_SOURCE" submodule update --init --recursive --depth=1
if [ "$(git -C "$VIBE_SOURCE/3rdparty/llama.cpp" rev-parse HEAD)" != "$VIBEASR_LLAMA_COMMIT" ]; then
	echo "ERROR: VibeASR llama.cpp submodule does not match the reviewed pin." >&2
	exit 1
fi

checkout_exact "$WHISPER_CPP_REPOSITORY" "$WHISPER_CPP_COMMIT" "$WHISPER_SOURCE"
checkout_exact "$FFMPEG_REPOSITORY" "$FFMPEG_COMMIT" "$FFMPEG_SOURCE"

cmake -S "$VIBE_SOURCE" -B "$VIBE_SOURCE/build-phanes" \
	-DCMAKE_BUILD_TYPE=Release \
	-DBUILD_SHARED_LIBS=OFF \
	-DGGML_NATIVE=OFF \
	-DGGML_AVX=ON \
	-DGGML_AVX2=ON \
	-DGGML_FMA=ON
cmake --build "$VIBE_SOURCE/build-phanes" --target asr_stream_server --parallel "$BUILD_JOBS"

cmake -S "$WHISPER_SOURCE" -B "$WHISPER_SOURCE/build-phanes" \
	-DCMAKE_BUILD_TYPE=Release \
	-DBUILD_SHARED_LIBS=OFF \
	-DGGML_NATIVE=OFF \
	-DGGML_AVX=ON \
	-DGGML_AVX2=ON \
	-DGGML_FMA=ON \
	-DWHISPER_BUILD_TESTS=OFF \
	-DWHISPER_BUILD_SERVER=OFF \
	-DWHISPER_BUILD_EXAMPLES=ON
cmake --build "$WHISPER_SOURCE/build-phanes" --target whisper-cli --parallel "$BUILD_JOBS"

if [ ! -f "$FFMPEG_SOURCE/ffbuild/config.mak" ]; then
	(
		cd "$FFMPEG_SOURCE"
		./configure \
			--prefix="$FFMPEG_SOURCE/install-phanes" \
			--disable-debug \
			--disable-doc \
			--disable-network \
			--disable-autodetect \
			--disable-everything \
			--disable-x86asm \
			--enable-ffmpeg \
			--enable-avutil \
			--enable-avcodec \
			--enable-avformat \
			--enable-swresample \
			--enable-protocol=file \
			--enable-demuxer=wav \
			--enable-decoder=pcm_s16le \
			--enable-encoder=pcm_s16le \
			--enable-muxer=wav \
			--enable-filter=aresample \
			--enable-filter=aformat
	)
fi
make -C "$FFMPEG_SOURCE" -j"$BUILD_JOBS" ffmpeg

OUTPUT_PARENT="$(dirname "$OUTPUT_DIR")"
mkdir -p "$OUTPUT_PARENT"
STAGING_DIR="$(mktemp -d "$OUTPUT_PARENT/.asr-runtime.XXXXXX")"
trap 'rm -rf "$STAGING_DIR"' EXIT
chmod 0755 "$STAGING_DIR"
mkdir -p "$STAGING_DIR/bin" "$STAGING_DIR/LICENSES"

install -m 0755 "$VIBE_SOURCE/build-phanes/bin/asr_stream_server" "$STAGING_DIR/bin/asr_stream_server"
install -m 0755 "$WHISPER_SOURCE/build-phanes/bin/whisper-cli" "$STAGING_DIR/bin/whisper-cli"
install -m 0755 "$FFMPEG_SOURCE/ffmpeg" "$STAGING_DIR/bin/ffmpeg"
install -m 0755 "$SCRIPT_DIR/transcribe_job.py" "$STAGING_DIR/transcribe_job.py"
install -m 0644 "$VIBE_SOURCE/LICENSE" "$STAGING_DIR/LICENSES/VibeASR.txt"
install -m 0644 "$VIBE_SOURCE/3rdparty/llama.cpp/LICENSE" "$STAGING_DIR/LICENSES/llama.cpp.txt"
install -m 0644 "$WHISPER_SOURCE/LICENSE" "$STAGING_DIR/LICENSES/whisper.cpp.txt"
install -m 0644 "$FFMPEG_SOURCE/COPYING.LGPLv2.1" "$STAGING_DIR/LICENSES/FFmpeg-LGPLv2.1.txt"
install -m 0644 "$REPO_ROOT/LICENSE" "$STAGING_DIR/LICENSES/Choreograph.txt"

strip "$STAGING_DIR/bin/asr_stream_server" "$STAGING_DIR/bin/whisper-cli" "$STAGING_DIR/bin/ffmpeg"

check_dynamic_dependencies() {
	local executable="$1"
	local unexpected
	unexpected="$(
		ldd "$executable" 2>&1 |
			awk '/=>/ {print $1} /^[[:space:]]*\// {name=$1; sub(/^.*\//, "", name); print name}' |
			grep -Ev '^(linux-vdso\.so\.1|ld-linux-x86-64\.so\.2|libc\.so\.6|libm\.so\.6|libpthread\.so\.0|libdl\.so\.2|librt\.so\.1|libstdc\+\+\.so\.6|libgcc_s\.so\.1|libgomp\.so\.1)$' || true
	)"
	if [ -n "$unexpected" ]; then
		echo "ERROR: undeclared dynamic dependencies for $(basename "$executable"):" >&2
		echo "$unexpected" >&2
		exit 1
	fi
}
check_dynamic_dependencies "$STAGING_DIR/bin/asr_stream_server"
check_dynamic_dependencies "$STAGING_DIR/bin/whisper-cli"
check_dynamic_dependencies "$STAGING_DIR/bin/ffmpeg"

cat > "$STAGING_DIR/SBOM.spdx.json" <<EOF
{
  "spdxVersion": "SPDX-2.3",
  "dataLicense": "CC0-1.0",
  "SPDXID": "SPDXRef-DOCUMENT",
  "name": "phanes-asr-runtime",
  "documentNamespace": "https://sophia-labs.com/sbom/phanes-asr-runtime/${VIBEASR_COMMIT}",
  "creationInfo": {
    "created": "1970-01-01T00:00:00Z",
    "creators": ["Tool: deploy/asr/build-runtime.sh"]
  },
  "packages": [
    {"name": "VibeASR.cpp", "SPDXID": "SPDXRef-VibeASR", "versionInfo": "${VIBEASR_COMMIT}", "downloadLocation": "${VIBEASR_REPOSITORY}", "licenseConcluded": "MIT"},
    {"name": "llama.cpp", "SPDXID": "SPDXRef-llama", "versionInfo": "${VIBEASR_LLAMA_COMMIT}", "downloadLocation": "https://github.com/ggml-org/llama.cpp", "licenseConcluded": "MIT"},
    {"name": "whisper.cpp", "SPDXID": "SPDXRef-whisper", "versionInfo": "${WHISPER_CPP_COMMIT}", "downloadLocation": "${WHISPER_CPP_REPOSITORY}", "licenseConcluded": "MIT"},
    {"name": "FFmpeg", "SPDXID": "SPDXRef-ffmpeg", "versionInfo": "${FFMPEG_COMMIT}", "downloadLocation": "${FFMPEG_REPOSITORY}", "licenseConcluded": "LGPL-2.1-or-later"}
  ]
}
EOF

node - "$STAGING_DIR" "$VIBEASR_COMMIT" "$VIBEASR_LLAMA_COMMIT" "$WHISPER_CPP_COMMIT" "$FFMPEG_COMMIT" <<'NODE'
const { createHash } = require("node:crypto");
const { readdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { join, relative } = require("node:path");

const [root, vibeasrCommit, llamaCommit, whisperCommit, ffmpegCommit] = process.argv.slice(2);
const names = {
	"bin/asr_stream_server": "server",
	"bin/whisper-cli": "whisper",
	"bin/ffmpeg": "ffmpeg",
	"transcribe_job.py": "wrapper",
	"SBOM.spdx.json": "sbom",
};
const files = {};
function visit(directory) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const absolute = join(directory, entry.name);
		if (entry.isDirectory()) visit(absolute);
		else if (entry.isFile()) {
			const relativePath = relative(root, absolute);
			const raw = readFileSync(absolute);
			const key = names[relativePath] ?? `license_${entry.name.replace(/[^A-Za-z0-9]+/g, "_")}`;
			files[key] = {
				path: relativePath,
				sha256: createHash("sha256").update(raw).digest("hex"),
				bytes: statSync(absolute).size,
			};
		}
	}
}
visit(root);
writeFileSync(
	join(root, "provenance.json"),
	`${JSON.stringify(
		{
			schema_version: 1,
			vibeasr_commit: vibeasrCommit,
			vibeasr_llama_commit: llamaCommit,
			whisper_cpp_commit: whisperCommit,
			ffmpeg_commit: ffmpegCommit,
			build_target: "linux-x86_64-avx2-fma",
			files,
		},
		null,
		2,
	)}\n`,
);
NODE

rm -rf "$OUTPUT_DIR"
mv "$STAGING_DIR" "$OUTPUT_DIR"
trap - EXIT
echo "Built ASR runtime bundle root: $OUTPUT_DIR"
