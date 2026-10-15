#!/usr/bin/env bash
#
# Launcher for the local-dev orchestrator (systemd ExecStart target).
#
# The orchestrator does NOT read .env itself — in prod docker-compose injects
# the environment, so locally we export it here before exec'ing tsx. Defaults
# give a zero-cloud boot: mock LLM (no API key), Mnemosyne disabled, OTEL off.
# Override any value via /etc/choreograph/dev.env (EnvironmentFile in the unit).

set -euo pipefail

export PORT="${PORT:-3456}"
export DATA_DIR="${DATA_DIR:-/var/lib/choreograph}"
export WORKSPACE_ROOT="${WORKSPACE_ROOT:-/workspace}"
export CHOREOGRAPH_RELEASE_ROOT="${CHOREOGRAPH_RELEASE_ROOT:-/workspace}"
# Provisioning builds, behavior-tests, and hydrates the canonical manifest.
export CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST="${CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST:-/etc/choreograph/runtime-bundles.json}"
export CHOREOGRAPH_BUNDLE_CACHE_DIR="${CHOREOGRAPH_BUNDLE_CACHE_DIR:-/var/lib/choreograph/bundles}"

# Observability is optional locally; keep boot quiet unless explicitly enabled.
export OTEL_SERVICE_NAME="${OTEL_SERVICE_NAME:-sandbox-mgmt}"
export OTEL_SDK_DISABLED="${OTEL_SDK_DISABLED:-true}"

# Mnemosyne disabled by default (no Cognito/gateway/token needed to boot).
export MNEMOSYNE_TOOL_TRANSPORT="${MNEMOSYNE_TOOL_TRANSPORT:-disabled}"

# Internal-service auth secret for the sandbox/chat API (matches docker-compose default).
export MNEMOSYNE_INTERNAL_SERVICE_SECRET="${MNEMOSYNE_INTERNAL_SERVICE_SECRET:-dev-internal-secret}"

cd "${WORKSPACE_ROOT}"
exec node_modules/.bin/tsx src/orchestrator.ts
