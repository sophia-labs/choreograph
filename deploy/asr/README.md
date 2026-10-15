# Phanes ASR bundles

The ASR sandbox receives four exact mounts: sealed input (read-only), an
attempt-specific output directory (writable), this runtime (read-only), and one
selected model (read-only). It has no network and no credentials.

`pins.env` is the source of truth for VibeASR.cpp, its llama.cpp submodule,
whisper.cpp, FFmpeg, both Microsoft GGUF files, and the quantized Whisper model.
The model downloader checks byte counts and SHA-256 values before promotion.

Prepare Linux/x86_64 roots locally through the pinned Amazon Linux 2023 build
container:

```bash
deploy/asr/prepare-local.sh
```

Build a complete release manifest from already prepared roots without
downloading or compiling again:

```bash
INCLUDE_ASR_BUNDLES=1 \
ASR_SKIP_PREPARE=1 \
ASR_BUILD_ROOT="$PWD/.cache/asr-bundles" \
deploy/package-runtime-bundles.sh local-asr
```

The ASR archives are deterministic uncompressed tar files. GGUF is already
quantized and gains little from recompression. The runtime includes license
texts, an SPDX SBOM, exact source commits, per-file hashes, and a dependency
allowlist check. `release.sh` includes ASR by default; set
`INCLUDE_ASR_BUNDLES=0` only for an intentionally host-only development build.

No script uploads unless `--upload` is passed explicitly. Uploading is a
production mutation and requires approval.
