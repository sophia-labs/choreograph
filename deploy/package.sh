#!/usr/bin/env bash
# deploy/package.sh — Build a deployment tarball for bare-metal EC2.
#
# Usage:
#   ./deploy/package.sh                    # version = git short SHA
#   ./deploy/package.sh v0.1.0             # explicit version tag
# Uploads are intentionally owned by deploy/release.sh so no artifact can be
# published before the complete release unit passes its gates.
#
# Produces: deploy/choreograph-<version>.tar.gz
#
# The tarball extracts to a choreograph/ directory containing:
#   src/              orchestrator TypeScript + basic worker.mjs
#   dist/             compiled host-side browser service
#   node_modules/     locked production graph materialized by pnpm deploy
#   bin/soil          optional Linux Soil CLI (required by the Cloud-2 builder)
#   package.json      deployment dependency manifest
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
VERSION="${1:-$(git -C "$REPO_ROOT" rev-parse --short HEAD)}"
UPLOAD="${2:-}"
TARBALL="choreograph-${VERSION}.tar.gz"
STAGE="$(mktemp -d)"

trap 'rm -rf "$STAGE"' EXIT

if [ -n "$UPLOAD" ]; then
  echo "ERROR: package.sh does not upload. Run deploy/release.sh <version> --upload after all gates pass." >&2
  exit 1
fi

echo "==> Building choreograph release: $VERSION"
echo "    stage dir: $STAGE"

# ── 1. Ensure workspace deps are installed and runtime services are compiled ──

if [ "${CHOREOGRAPH_SKIP_PREBUILD:-0}" != "1" ]; then
	cd "$REPO_ROOT"
	if [ -n "${PNPM_STORE_DIR:-}" ]; then
		pnpm install --frozen-lockfile --store-dir "$PNPM_STORE_DIR"
	else
		pnpm install --frozen-lockfile
	fi
	pnpm build   # canonical-json + host ACP/browser-service outputs
fi

# ── 2. Stage the application ────────────────────────────────────────────

DST="$STAGE/choreograph"
mkdir -p "$DST/src" "$DST/dist"

# Orchestrator source — copy everything, then prune what doesn't ship
cp -r src/* "$DST/src/"
rm -rf "$DST/src/test" "$DST/src/Dockerfile"* "$DST/src/docker-compose.yml"
find "$DST/src" -name '*.test.ts' -delete 2>/dev/null || true

# Compiled host runtime (the agent runtime ships only as its separate,
# content-addressed sophia-agent-runtime bundle).
cp -r dist/browser-service "$DST/dist/browser-service"

# Soil is built from its separately pinned source stratum by the native Linux
# builder. A local developer package may omit it; a publishable Cloud-2 release
# sets CHOREOGRAPH_REQUIRE_SOIL_BINARY=1 and therefore fails closed here.
SOIL_BINARY="${CHOREOGRAPH_SOIL_BINARY:-}"
if [ -n "$SOIL_BINARY" ]; then
	test -f "$SOIL_BINARY" || { echo "FATAL: Soil binary not found: $SOIL_BINARY" >&2; exit 1; }
	mkdir -p "$DST/bin"
	install -m 0755 "$SOIL_BINARY" "$DST/bin/soil"
elif [ "${CHOREOGRAPH_REQUIRE_SOIL_BINARY:-0}" = "1" ]; then
	echo "FATAL: CHOREOGRAPH_REQUIRE_SOIL_BINARY=1 but CHOREOGRAPH_SOIL_BINARY is unset" >&2
	exit 1
fi

# Deploy artifacts (systemd unit, included in tarball for userdata to find)
mkdir -p "$DST/deploy"
cp "$SCRIPT_DIR/choreograph.service" "$DST/deploy/"
cp "$SCRIPT_DIR/load-env.sh" "$DST/deploy/"
cp "$SCRIPT_DIR/observability.service" "$DST/deploy/"
cp "$SCRIPT_DIR/browser-service.service" "$DST/deploy/"
cp -r "$SCRIPT_DIR/browser-service" "$DST/deploy/browser-service"
cp "$SCRIPT_DIR/load-phanes-env.sh" "$DST/deploy/"
cp "$SCRIPT_DIR/phanes-health.sh" "$DST/deploy/"
cp "$SCRIPT_DIR/phanes-health.service" "$DST/deploy/"
cp "$SCRIPT_DIR/phanes-health.timer" "$DST/deploy/"
cp "$SCRIPT_DIR/phanes.service" "$DST/deploy/"

# Host-bootstrap scripts: the launch-template userdata gates boot on their
# presence inside the verified release (workspace rg installer, workbench
# observer installer, workspace-source bootstrap). Grafted from the d4 lineage
# (r20260810) 2026-08-20 after release r20260820 failed the gate on first boot.
cp -r "$SCRIPT_DIR/host-bootstrap" "$DST/deploy/host-bootstrap"
# The userdata boot gate is `test -x`: a mode regression bricks first boot
# fail-closed (witnessed twice, 2026-08-20/21). Enforce executability here.
chmod +x "$DST/deploy/host-bootstrap/"*.sh

# Observability stack configs (OTEL Collector, Prometheus, Jaeger, Grafana)
cp -r "$SCRIPT_DIR/observability" "$DST/deploy/observability"

# ── 3. Materialize the locked production dependency graph ─────────────

# pnpm deploy preserves the exact workspace lockfile resolution while making a
# self-contained node_modules tree whose links remain inside the deployment.
# Runtime imports belong in the root package's dependencies; this gate makes an
# accidental devDependency-only host requirement fail before publication.
PNPM_DEPLOY_TARGET="$STAGE/pnpm-deploy"
PNPM_DEPLOY=(pnpm --dir "$REPO_ROOT")
if [ -n "${PNPM_STORE_DIR:-}" ]; then
	PNPM_DEPLOY+=(--store-dir "$PNPM_STORE_DIR")
fi
echo "==> Deploying locked host runtime with pnpm"
"${PNPM_DEPLOY[@]}" \
	--filter choreograph-workspace \
	deploy --prod --offline --ignore-scripts "$PNPM_DEPLOY_TARGET"
cp "$PNPM_DEPLOY_TARGET/package.json" "$DST/package.json"
cp -a "$PNPM_DEPLOY_TARGET/node_modules" "$DST/node_modules"

# esbuild's platform package must be present or the tsx-run orchestrator
# crashes on the Linux host. pnpm keeps it inside the virtual store rather than
# flattening it at node_modules/@esbuild. There is deliberately no mutable
# install fallback: a missing locked optional dependency fails the BuildPlan.
ESBUILD_BINARY="$(find "$DST/node_modules/.pnpm" -type f -path '*/node_modules/@esbuild/linux-x64/bin/esbuild' -perm -111 -print -quit)"
test -n "$ESBUILD_BINARY" && test -x "$ESBUILD_BINARY" || { echo "FATAL: @esbuild/linux-x64 binary missing — aborting build"; exit 1; }
test -x "$DST/node_modules/.bin/tsx" || { echo "FATAL: locked tsx executable missing — aborting build"; exit 1; }
"$DST/node_modules/.bin/tsx" --version >/dev/null
echo "==> verified @esbuild/linux-x64 binary present"

# ── 4. Create tarball ──────────────────────────────────────────────────

echo "==> Creating tarball..."
cd "$STAGE"
tar czf "$REPO_ROOT/deploy/$TARBALL" choreograph

SIZE=$(du -h "$REPO_ROOT/deploy/$TARBALL" | cut -f1)
echo "==> Built: deploy/$TARBALL ($SIZE)"
