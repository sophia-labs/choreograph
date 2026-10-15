#!/usr/bin/env bash
# deploy/package-local.sh: build services/choreograph/ for a local Choreograph supervised by gardend.
#
# Usage:
#   deploy/package-local.sh <target> [--prime <prime-source-dir>] [--out <out-dir>]
#
#   <target>   darwin-x64 | darwin-arm64 | linux-x64 | linux-arm64 (Linux means glibc: Ubuntu, Debian, WSL2)
#   --prime    optional: a Prime (sophia-agent) source checkout to bundle as the agent body; only its tracked files
#              are taken when it is a git tree. Without it the package is the orchestrator alone, and agent and chat
#              requests answer 503 runtime_unavailable until a body is configured
#              (CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST + SOPHIA_AGENT_RUNTIME_ENTRYPOINT).
#   --out      default deploy/local-package/<target>; receives services/choreograph/
#
# Produces <out-dir>/services/choreograph/:
#   service.json          gardend's local service manifest: command = choreograph/node_modules/.bin/tsx,
#                         args = src/orchestrator.ts, workingDir = choreograph (command and workingDir resolve against
#                         this directory; env paths resolve against the working directory)
#   choreograph/          the orchestrator source and a hoisted production node_modules for <target>
#   with --prime:
#   runtime-bundles.json  one sophia-agent-runtime bundle, host_path = prime, digest over the Prime source tree
#   prime/                the Prime source tree and its hoisted production node_modules (plus tsx) for <target>
#
# The orchestrator runs from TypeScript source under tsx, as hosted does, and a Prime body runs its host-worker.ts
# the same way (local-native mode), so nothing here compiles them. Node >= 22.13 must be on PATH where
# the package runs. node_modules is built with node-linker=hoisted and holds no symlinks: gardend's updater skips
# symlinks. Native prebuilds are chosen for <target> (pnpm supportedArchitectures), so a Linux package can be
# assembled on a Mac; it is only smoke-tested when <target> is the machine it is built on.
#
# With --prime: the Prime fork pulls @sophia-labs/canonical-json from a private registry. When the tree does not carry its
# own packages/canonical-json, this script packs Choreograph's (the same contract) into prime/vendor/ and overrides
# the dependency with it, so no registry credentials are needed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

die() { echo "package-local: $*" >&2; exit 1; }
USAGE="usage: deploy/package-local.sh <darwin-x64|darwin-arm64|linux-x64|linux-arm64> [--prime <prime-source-dir>] [--out <out-dir>]"
[ $# -ge 1 ] || die "$USAGE"
TARGET="$1"
shift
PRIME_SRC=""
OUT=""
while [ $# -gt 0 ]; do
	case "$1" in
		--prime) [ $# -ge 2 ] || die "$USAGE"; PRIME_SRC="$(cd "$2" && pwd)" || die "no Prime source directory: $2"; shift 2 ;;
		--out) [ $# -ge 2 ] || die "$USAGE"; OUT="$2"; shift 2 ;;
		*) die "$USAGE" ;;
	esac
done
OUT="${OUT:-$REPO_ROOT/deploy/local-package/$TARGET}"

case "$TARGET" in
	darwin-x64) OS=darwin CPU=x64 LIBC= ;;
	darwin-arm64) OS=darwin CPU=arm64 LIBC= ;;
	linux-x64) OS=linux CPU=x64 LIBC=glibc ;;
	linux-arm64) OS=linux CPU=arm64 LIBC=glibc ;;
	*) die "unknown target: $TARGET" ;;
esac
HOST_TARGET="$(node -p '`${process.platform}-${process.arch}`')"
LIBSQL_PACKAGE="@libsql/$OS-$CPU${LIBC:+-gnu}"
ESBUILD_PACKAGE="@esbuild/$OS-$CPU"

node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' \
	|| die "node >= 22.13 is required (found $(node --version))"
[ -z "$PRIME_SRC" ] || test -f "$PRIME_SRC/packages/coding-agent/src/sophia/host-worker.ts" \
	|| die "$PRIME_SRC is not a Prime source tree (no packages/coding-agent/src/sophia/host-worker.ts)"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/choreograph-local-package.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
echo "==> Packaging local Choreograph for $TARGET (stage $STAGE)"

# Native prebuilds for the target only, whatever machine builds the package.
supported_architectures() {
	printf 'supportedArchitectures:\n  os: [%s]\n  cpu: [%s]\n' "$OS" "$CPU"
	[ -z "$LIBC" ] || printf '  libc: [%s]\n' "$LIBC"
}

# ── 1. The Choreograph workspace: canonical-json is a workspace package consumed through its dist/ ──
if [ "${CHOREOGRAPH_SKIP_PREBUILD:-0}" != "1" ]; then
	(cd "$REPO_ROOT" && pnpm install --frozen-lockfile && pnpm --filter @sophia-labs/canonical-json build)
fi
test -f "$REPO_ROOT/packages/canonical-json/dist/index.js" || die "packages/canonical-json is not built"

# ── 2. Stage the orchestrator: what hosted ships (src without tests), plus the manifests pnpm installs from ──
APP="$STAGE/choreograph"
mkdir -p "$APP/packages/canonical-json"
cp -R "$REPO_ROOT/src" "$APP/src"
rm -rf "$APP/src/test" "$APP/src/Dockerfile"* "$APP/src/docker-compose.yml" "$APP/src/browser-service/test"
find "$APP/src" -name '*.test.ts' -delete
cp "$REPO_ROOT/package.json" "$REPO_ROOT/pnpm-lock.yaml" "$REPO_ROOT/.npmrc" "$REPO_ROOT/LICENSE" "$REPO_ROOT/NOTICE" "$APP/"
(cd "$REPO_ROOT/packages/canonical-json" && cp -R package.json README.md golden-vectors.json dist "$APP/packages/canonical-json/")
{ printf 'packages:\n  - packages/canonical-json\n'; supported_architectures; } > "$APP/pnpm-workspace.yaml"

echo "==> Installing the orchestrator's production dependencies (hoisted)"
(cd "$APP" && pnpm install --prod --frozen-lockfile --ignore-scripts --config.node-linker=hoisted --reporter=append-only)

# ── 3. With --prime: stage the Prime body from source ──
PRIME="$STAGE/prime"
PRIME_REV=""
stage_prime() {
mkdir -p "$PRIME"
if git -C "$PRIME_SRC" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
	PRIME_REV="$(git -C "$PRIME_SRC" rev-parse HEAD)"
	[ -z "$(git -C "$PRIME_SRC" status --porcelain --untracked-files=no)" ] \
		|| echo "    note: $PRIME_SRC has uncommitted changes; packaging HEAD ($PRIME_REV)" >&2
	git -C "$PRIME_SRC" archive --format=tar HEAD | tar -x -C "$PRIME"
else
	PRIME_REV="unknown (not a git tree)"
	(cd "$PRIME_SRC" && tar -c --exclude=node_modules --exclude=dist --exclude=.git . ) | tar -x -C "$PRIME"
fi

# Install-time edits to the staged copy only (the digest is taken afterwards, over exactly what ships):
# - a workspace of packages/* (the examples' dependencies stay out);
# - tsx as a dependency: the body runs `node --import tsx host-worker.ts` from this tree;
# - canonical-json from Choreograph when the fork does not carry it (its own registry is private);
# - no private registry line, and the target's prebuilds.
CANONICAL_TGZ=""
if [ ! -d "$PRIME/packages/canonical-json" ] && grep -q '"@sophia-labs/canonical-json"' "$PRIME/packages/coding-agent/package.json"; then
	mkdir -p "$PRIME/vendor"
	(cd "$REPO_ROOT/packages/canonical-json" && pnpm pack --pack-destination "$PRIME/vendor" >/dev/null)
	CANONICAL_TGZ="$(cd "$PRIME" && ls vendor/sophia-labs-canonical-json-*.tgz | head -1)"
	test -n "$CANONICAL_TGZ" || die "could not pack packages/canonical-json"
fi
node - "$PRIME/package.json" "$CANONICAL_TGZ" <<'NODE'
const fs = require("node:fs");
const [path, canonicalTgz] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(path, "utf8"));
const tsx = pkg.devDependencies?.tsx ?? pkg.dependencies?.tsx;
if (!tsx) throw new Error("Prime declares no tsx");
pkg.dependencies = { ...(pkg.dependencies ?? {}), tsx };
delete pkg.devDependencies?.tsx;
delete pkg.scripts?.prepare;
if (canonicalTgz) {
	pkg.pnpm = pkg.pnpm ?? {};
	pkg.pnpm.overrides = { ...(pkg.pnpm.overrides ?? {}), "@sophia-labs/canonical-json": `file:${canonicalTgz}` };
}
fs.writeFileSync(path, `${JSON.stringify(pkg, null, "\t")}\n`);
NODE
{ printf 'packages:\n  - packages/*\n'; supported_architectures; } > "$PRIME/pnpm-workspace.yaml"
if [ -f "$PRIME/.npmrc" ]; then
	grep -v -E '^@sophia-labs:registry=' "$PRIME/.npmrc" > "$PRIME/.npmrc.local" || true
	mv "$PRIME/.npmrc.local" "$PRIME/.npmrc"
fi

echo "==> Installing Prime's production dependencies (hoisted)"
(cd "$PRIME" && pnpm install --prod --no-frozen-lockfile --ignore-scripts --config.node-linker=hoisted --reporter=append-only)
}
[ -z "$PRIME_SRC" ] || stage_prime

# ── 4. Assemble services/choreograph ──
SVC="$OUT/services/choreograph"
rm -rf "$SVC"
mkdir -p "$SVC"
mv "$APP" "$SVC/choreograph"
TREES=(choreograph)
if [ -n "$PRIME_SRC" ]; then
	mv "$PRIME" "$SVC/prime"
	TREES+=(prime)
	(cd "$REPO_ROOT" && node --import tsx scripts/local-runtime-manifest.ts "$SVC/prime" --out "$SVC/runtime-bundles.json")
fi

CHOREOGRAPH_REV="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)"
node - "$SVC/service.json" "$TARGET" "$CHOREOGRAPH_REV" "$PRIME_REV" <<'NODE'
const fs = require("node:fs");
const [path, target, choreographRev, primeRev = ""] = process.argv.slice(2);
const env = (name, value) => ({ name, value });
const manifest = {
	serviceId: "choreograph",
	// Resolved by gardend against this file's directory.
	command: "choreograph/node_modules/.bin/tsx",
	workingDir: "choreograph",
	// Passed as given: relative to the working directory.
	args: ["src/orchestrator.ts"],
	healthPath: "/health",
	proxyMount: "/services/choreograph",
	// Values are passed as given; the relative paths resolve against the working directory (choreograph/).
	// gardend adds CHOREOGRAPH_SANDBOX_MODE=local-native, PORT, DATA_DIR, the MCP URL and token and the internal secret.
	env: [
		env("CHOREOGRAPH_BIND_HOST", "127.0.0.1"),
		...(primeRev
			? [
					env("CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST", "../runtime-bundles.json"),
					env("SOPHIA_AGENT_RUNTIME_ENTRYPOINT", "../prime/packages/coding-agent/src/sophia/host-worker.ts"),
				]
			: []),
		env("OTEL_SDK_DISABLED", "true"),
		env("BILLING_FEE_BPS", "0"),
		env("NODE_ENV", "production"),
	],
	build: { target, choreograph: choreographRev, ...(primeRev ? { prime: primeRev } : {}) },
};
fs.writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

# Workspace packages are symlinked even under the hoisted linker, and gardend's updater skips symlinks.
# - Choreograph consumes canonical-json through its dist/: that link becomes a copy.
# - Prime's packages link to one another; the body runs from source under tsx, which resolves them through Prime's
#   tsconfig paths (packages/*/src), and the linked packages have no dist/ to serve anyway: those links are dropped.
while IFS= read -r link; do
	target="$(cd "$(dirname "$link")" && cd "$(readlink "$link")" && pwd)"
	rm "$link"
	mkdir -p "$link"
	(cd "$target" && tar -c --exclude=node_modules .) | tar -x -C "$link"
done < <(find "$SVC/choreograph/node_modules" -type l ! -path '*/.bin/*')
[ -z "$PRIME_SRC" ] || find "$SVC/prime" -type l -path '*/node_modules/@earendil-works/*' ! -path '*/.bin/*' -delete

# pnpm writes node_modules/.bin entries as symlinks too: each becomes a two-line sh shim that executes the same
# relative target.
while IFS= read -r link; do
	target="$(readlink "$link")"
	case "$target" in /*) die "absolute bin link: $link -> $target" ;; esac
	test -e "$(dirname "$link")/$target" || { rm "$link"; continue; }
	rm "$link"
	printf '#!/bin/sh\nexec "$(dirname "$0")/%s" "$@"\n' "$target" > "$link"
	chmod 0755 "$link"
done < <(find "$SVC" -type l -path '*/node_modules/.bin/*')

# ── 5. Gates ──
LINKS="$(find "$SVC" -type l | head -5)"
[ -z "$LINKS" ] || die "symlinks in the package (gardend's updater skips them):
$LINKS"
for tree in "${TREES[@]}"; do
	test -x "$SVC/$tree/node_modules/.bin/tsx" || die "$tree: no node_modules/.bin/tsx"
	test -d "$SVC/$tree/node_modules/$ESBUILD_PACKAGE" || die "$tree: no $ESBUILD_PACKAGE (esbuild for $TARGET)"
done
test -d "$SVC/choreograph/node_modules/$LIBSQL_PACKAGE" || die "choreograph: no $LIBSQL_PACKAGE (libSQL for $TARGET)"
test -d "$SVC/choreograph/node_modules/@sophia-labs/canonical-json/dist" || die "choreograph: canonical-json not installed"
if [ "$TARGET" = "$HOST_TARGET" ]; then
	(cd "$SVC/choreograph" && node_modules/.bin/tsx --version >/dev/null) || die "the packaged tsx does not run"
	[ -z "$PRIME_SRC" ] || (cd "$SVC/prime" && node --import tsx -e 'import("@sophia-labs/canonical-json").then(() => process.exit(0))') \
		|| die "Prime cannot load its dependencies under tsx"
else
	echo "    note: $TARGET is not this machine ($HOST_TARGET): native binaries were selected but not executed"
fi

echo "==> Built $SVC"
for tree in "${TREES[@]}"; do du -sh "$SVC/$tree"; done | sed 's/^/    /'
du -sh "$SVC" | sed 's/^/    /'
[ -n "$PRIME_SRC" ] || echo "    no agent body bundled (no --prime): agent and chat requests answer 503 runtime_unavailable"
