#!/usr/bin/env bash
# deploy/load-env.sh — Pull secrets from SSM Parameter Store into an env file.
#
# Called by systemd ExecStartPre before the orchestrator starts.
# Reads all parameters under /choreograph/ and writes them as KEY=VALUE
# to a tmpfs-backed runtime env file that only the choreograph user can read.
#
# Parameters are stored as (gen-2 set):
#   /choreograph/OPENROUTER_API_KEY          (SecureString)
#   /choreograph/MNEMOSYNE_GATEWAY_BASE_URL  (String)
#   /choreograph/MNEMOSYNE_SERVICE_TOKEN     (SecureString)
#   /choreograph/CHOREOGRAPH_GATEWAY_HUMAN_DELEGATION_SECRET (SecureString)
#   /choreograph/COGNITO_USER_POOL_ID        (String)
#   /choreograph/COGNITO_CLIENT_ID           (String)
#   /choreograph/HOJA_PROBE_USERNAME          (String)
#   /choreograph/HOJA_PROBE_PASSWORD          (SecureString)
#   /choreograph/GITHUB_EFFECT_TOKEN           (SecureString; optional host edge)
#
# SITE_EFFECT_WORKER_ENABLED, BUILD_EFFECT_WORKER_ENABLED,
# PLATFORM_RELEASE_EFFECT_WORKER_ENABLED, SCRATCH_EFFECT_WORKER_ENABLED, and the site's
# exact route-registry tuple are non-secret launch-template configuration.
# When enabled below, credential-bearing host edges still refuse to boot unless
# the gateway URL and service token are present in this SSM snapshot.
#   ...etc
#
# The parameter name after the prefix becomes the env var name.
set -euo pipefail

SSM_PREFIX="${CHOREOGRAPH_SSM_PREFIX:-/choreograph/}"
ENV_FILE="/run/choreograph/env"
# All /choreograph/* SSM params live ONLY in us-west-1 — default there, not a
# neutral region (us-east-1 would silently find zero params). Override via
# AWS_DEFAULT_REGION if the params ever move.
REGION="${AWS_DEFAULT_REGION:-us-west-1}"

# /run/choreograph is created by systemd RuntimeDirectory=choreograph
# with correct ownership.  No mkdir needed.

# Pull all parameters under the prefix, decrypt SecureStrings
PARAMS=$(aws ssm get-parameters-by-path \
  --path "$SSM_PREFIX" \
  --with-decryption \
  --region "$REGION" \
  --query 'Parameters[*].[Name,Value]' \
  --output text 2>&1) || {
  # FAIL CLOSED: an SSM fetch failure used to write an empty env file and
  # exit 0, so the orchestrator booted keyless and silently failed. Exit non-zero
  # instead — a failed ExecStartPre fails the unit, the host fails the ELB health
  # check, and a bad instance never serves traffic.
  echo "[load-env] FATAL: SSM fetch failed for ${SSM_PREFIX} in ${REGION}: $PARAMS" >&2
  exit 1
}

# Write env file — strip prefix from parameter names
: > "$ENV_FILE"
while IFS=$'\t' read -r name value; do
  key="${name#${SSM_PREFIX}}"
  echo "${key}=${value}" >> "$ENV_FILE"
done <<< "$PARAMS"

# The Phanes container owns these two identity bindings under /phanes/. The
# orchestrator also needs their exact values to turn the token-authenticated
# Unix trigger into a fixed, internal-service invocation. Pull only these
# non-secret bindings; never mirror the Discord credential into Choreograph.
if [ -n "${PHANES_TRANSCRIBE_SOCKET:-}" ]; then
  PHANES_BINDINGS=$(aws ssm get-parameters \
    --names /phanes/PHANES_GRAPH_OWNER /phanes/PHANES_ON_BEHALF_OF \
    --with-decryption \
    --region "$REGION" \
    --query 'Parameters[*].[Name,Value]' \
    --output text 2>&1) || {
    echo "[load-env] FATAL: could not load the fixed Phanes graph identity: $PHANES_BINDINGS" >&2
    exit 1
  }
  PHANES_GRAPH_OWNER_VALUE=""
  while IFS=$'\t' read -r name value; do
    case "$name" in
      /phanes/PHANES_GRAPH_OWNER)
        PHANES_GRAPH_OWNER_VALUE="$value"
        echo "PHANES_GRAPH_OWNER=${value}" >> "$ENV_FILE"
        ;;
      /phanes/PHANES_ON_BEHALF_OF) echo "PHANES_ON_BEHALF_OF=${value}" >> "$ENV_FILE" ;;
    esac
  done <<< "$PHANES_BINDINGS"

  # Domain Agent definitions cannot nominate their own Layer-0 trust root.
  # The canary Phanes edge has one fixed owner-bound authority graph and one
  # authenticated ingress adapter, so derive the fail-closed runtime trust
  # configuration from the same SSM-bound graph identity used by its trigger
  # submitter.  These values are host-only; no sandbox receives them.
  if [[ ! "$PHANES_GRAPH_OWNER_VALUE" =~ ^user:[A-Za-z0-9_.@:-]{1,192}$ ]]; then
    echo "[load-env] FATAL: PHANES_GRAPH_OWNER must be a typed user principal" >&2
    exit 1
  fi
  echo "DOMAIN_AGENT_GRANT_AUTHORITY_OWNER=${PHANES_GRAPH_OWNER_VALUE}" >> "$ENV_FILE"
  echo "DOMAIN_AGENT_GRANT_AUTHORITY_GRAPHS=observatory" >> "$ENV_FILE"
  echo "DOMAIN_AGENT_TRUSTED_TRIGGER_ADAPTERS=discord" >> "$ENV_FILE"
fi

chmod 600 "$ENV_FILE"

COUNT=$(grep -c '=' "$ENV_FILE" 2>/dev/null || echo 0)
echo "[load-env] Loaded $COUNT parameter(s) from SSM ${SSM_PREFIX}"

# FAIL CLOSED: assert the secrets the orchestrator cannot run without are present
# and non-empty. A keyless boot otherwise looks healthy until the first LLM/gateway
# call fails — better to fail ExecStartPre here so the host fails its ELB health
# check and is replaced.
#
# get_param KEY -> the value as written to ENV_FILE (empty if absent).
get_param() {
  # Last assignment wins; strip the leading "KEY=" to get the bare value.
  grep -E "^${1}=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2-
}

# OPENROUTER_API_KEY is always required.
if [ -z "$(get_param OPENROUTER_API_KEY)" ]; then
  echo "[load-env] FATAL: required secret OPENROUTER_API_KEY missing or empty in ${SSM_PREFIX}" >&2
  exit 1
fi

# Mnemosyne auth: either the gen-2 service token OR the inbound service secret.
if [ -z "$(get_param MNEMOSYNE_SERVICE_TOKEN)" ] && [ -z "$(get_param MNEMOSYNE_INTERNAL_SERVICE_SECRET)" ]; then
  echo "[load-env] FATAL: need MNEMOSYNE_SERVICE_TOKEN or MNEMOSYNE_INTERNAL_SERVICE_SECRET in ${SSM_PREFIX} — both missing/empty" >&2
  exit 1
fi

# Owner-authenticated browser ingress is delegated by the public gateway using
# a dedicated secret. It must never reuse the broad internal-service secret.
if [ -z "$(get_param CHOREOGRAPH_GATEWAY_HUMAN_DELEGATION_SECRET)" ]; then
  echo "[load-env] FATAL: required secret CHOREOGRAPH_GATEWAY_HUMAN_DELEGATION_SECRET missing or empty in ${SSM_PREFIX}" >&2
  exit 1
fi
if [ "$(get_param CHOREOGRAPH_GATEWAY_HUMAN_DELEGATION_SECRET)" = "$(get_param MNEMOSYNE_INTERNAL_SERVICE_SECRET)" ]; then
  echo "[load-env] FATAL: CHOREOGRAPH_GATEWAY_HUMAN_DELEGATION_SECRET must differ from MNEMOSYNE_INTERNAL_SERVICE_SECRET" >&2
  exit 1
fi

# Hoja's browser wing is an authenticated functional test, not an anonymous
# screenshot probe. These two values are consumed by the host-side
# hoja-storage-state helper; neither is exposed to sandboxes or browser tools.
if [ "${HOJA_BROWSER_AUTH_REQUIRED:-false}" = "true" ] && \
   { [ -z "$(get_param HOJA_PROBE_USERNAME)" ] || [ -z "$(get_param HOJA_PROBE_PASSWORD)" ]; }; then
  echo "[load-env] FATAL: HOJA_PROBE_USERNAME and HOJA_PROBE_PASSWORD are required for the authenticated Hoja browser capability" >&2
  exit 1
fi

if [ -n "${PHANES_TRANSCRIBE_SOCKET:-}" ] && [ -z "$(get_param PHANES_TRANSCRIBE_TOKEN)" ]; then
  echo "[load-env] FATAL: PHANES_TRANSCRIBE_TOKEN is required when the private Phanes listener is enabled" >&2
  exit 1
fi
if [ -n "${PHANES_TRANSCRIBE_SOCKET:-}" ] && [ -z "$(get_param PHANES_CAPABILITY_TOKEN)" ]; then
  echo "[load-env] FATAL: PHANES_CAPABILITY_TOKEN is required when the private Phanes capability edge is enabled" >&2
  exit 1
fi
if [ -n "${PHANES_TRANSCRIBE_SOCKET:-}" ] && \
   [ "$(get_param PHANES_CAPABILITY_BASE_URL)" != "http://127.0.0.1:8765" ]; then
  echo "[load-env] FATAL: PHANES_CAPABILITY_BASE_URL must be the fixed loopback endpoint http://127.0.0.1:8765" >&2
  exit 1
fi
if [ -n "${PHANES_TRANSCRIBE_SOCKET:-}" ] && \
   { [ -z "$(get_param PHANES_GRAPH_OWNER)" ] || \
     [ -z "$(get_param PHANES_ON_BEHALF_OF)" ] || \
     [ -z "$(get_param MNEMOSYNE_INTERNAL_SERVICE_SECRET)" ]; }; then
  echo "[load-env] FATAL: Phanes domain triggers require PHANES_GRAPH_OWNER, PHANES_ON_BEHALF_OF, and MNEMOSYNE_INTERNAL_SERVICE_SECRET" >&2
  exit 1
fi

if [ "${SITE_EFFECT_WORKER_ENABLED:-0}" = "1" ] || [ "${SITE_EFFECT_WORKER_ENABLED:-}" = "true" ]; then
  if [ -z "$(get_param MNEMOSYNE_GATEWAY_BASE_URL)" ] || [ -z "$(get_param MNEMOSYNE_SERVICE_TOKEN)" ]; then
    echo "[load-env] FATAL: the site effect edge requires MNEMOSYNE_GATEWAY_BASE_URL and MNEMOSYNE_SERVICE_TOKEN" >&2
    exit 1
  fi
  if [[ ! "${SITE_ROUTE_REGISTRY_OWNER:-}" =~ ^user:[A-Za-z0-9_.@:-]{1,192}$ ]] || \
     [[ ! "${SITE_ROUTE_REGISTRY_GRAPH:-}" =~ ^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$ ]]; then
    echo "[load-env] FATAL: the site effect edge requires an exact typed registry owner and canonical graph id" >&2
    exit 1
  fi
fi

if [ "${GITHUB_EFFECT_WORKER_ENABLED:-0}" = "1" ] || [ "${GITHUB_EFFECT_WORKER_ENABLED:-}" = "true" ]; then
  if [ -z "$(get_param MNEMOSYNE_GATEWAY_BASE_URL)" ] || \
     [ -z "$(get_param MNEMOSYNE_SERVICE_TOKEN)" ] || \
     [ -z "$(get_param GITHUB_EFFECT_TOKEN)" ]; then
    echo "[load-env] FATAL: the GitHub effect edge requires gateway service auth and GITHUB_EFFECT_TOKEN" >&2
    exit 1
  fi
fi

if [ "${BUILD_EFFECT_WORKER_ENABLED:-0}" = "1" ] || [ "${BUILD_EFFECT_WORKER_ENABLED:-}" = "true" ]; then
  if [ -z "$(get_param MNEMOSYNE_GATEWAY_BASE_URL)" ] || \
     [ -z "$(get_param MNEMOSYNE_SERVICE_TOKEN)" ]; then
    echo "[load-env] FATAL: the native-build effect edge requires gateway service auth" >&2
    exit 1
  fi
fi

if [ "${PLATFORM_RELEASE_EFFECT_WORKER_ENABLED:-0}" = "1" ] || \
   [ "${PLATFORM_RELEASE_EFFECT_WORKER_ENABLED:-}" = "true" ]; then
  if [ -z "$(get_param MNEMOSYNE_GATEWAY_BASE_URL)" ] || \
     [ -z "$(get_param MNEMOSYNE_SERVICE_TOKEN)" ]; then
    echo "[load-env] FATAL: the platform release effect edge requires gateway service auth" >&2
    exit 1
  fi
fi

if [ "${SCRATCH_EFFECT_WORKER_ENABLED:-0}" = "1" ] || [ "${SCRATCH_EFFECT_WORKER_ENABLED:-}" = "true" ]; then
  if [ -z "$(get_param MNEMOSYNE_GATEWAY_BASE_URL)" ] || \
     [ -z "$(get_param MNEMOSYNE_SERVICE_TOKEN)" ]; then
    echo "[load-env] FATAL: the scratch-cell effect edge requires gateway service auth" >&2
    exit 1
  fi
fi

echo "[load-env] required secrets present"
