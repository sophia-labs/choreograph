#!/usr/bin/env bash
# Render the narrowly scoped Phanes container env into tmpfs.
set -euo pipefail

SSM_PREFIX="${PHANES_SSM_PREFIX:-/phanes/}"
REGION="${AWS_DEFAULT_REGION:-us-west-1}"
RUNTIME_DIR="/run/phanes"
SSM_JSON="$RUNTIME_DIR/ssm.json"
ENV_FILE="$RUNTIME_DIR/env"
CHOREOGRAPH_ENV_FILE="/run/choreograph/env"

install -d -m 0700 "$RUNTIME_DIR"
umask 077

aws ssm get-parameters-by-path \
	--path "$SSM_PREFIX" \
	--recursive \
	--with-decryption \
	--region "$REGION" \
	--output json > "$SSM_JSON"

node - "$SSM_JSON" "$CHOREOGRAPH_ENV_FILE" "$ENV_FILE" "$SSM_PREFIX" <<'NODE'
const { readFileSync, renameSync, writeFileSync } = require("node:fs");

const [ssmPath, choreographEnvPath, outputPath, prefix] = process.argv.slice(2);
const allowed = new Set([
	"DISCORD_TOKEN",
	"GUILD_ID",
	"GATED_ROLE_ID",
	"APPROVER_USER_ID",
	"ROLE_REQUEST_CHANNEL_ID",
	"PHANES_RECORDER_ROLE_ID",
	"PHANES_GRAPH_OWNER",
	"PHANES_ON_BEHALF_OF",
	"PHANES_DISCORD_READ_CHANNEL_IDS",
	"PHANES_PRIVACY_HMAC_KEY",
	"PHANES_PRIME_MODEL",
	"PHANES_EMANATION_MODEL",
	"PHANES_GARDEN_ACTIVATION_TIMEOUT_SECONDS",
	"PHANES_EFFECT_POLL_SECONDS",
	"PHANES_DOMAIN_TURN_RECOVERY_SECONDS",
	"PHANES_ASR_MODEL",
	"PHANES_ASR_AUTO_FALLBACK",
	"PHANES_MAX_CALL_SECONDS",
	"PHANES_SUCCESS_AUDIO_RETENTION_SECONDS",
	"PHANES_FAILED_AUDIO_RETENTION_SECONDS",
	"PHANES_PROVENANCE_RETENTION_SECONDS",
]);
const required = new Set([
	"DISCORD_TOKEN",
	"GUILD_ID",
	"PHANES_GRAPH_OWNER",
	"PHANES_ON_BEHALF_OF",
	"PHANES_DISCORD_READ_CHANNEL_IDS",
	"PHANES_PRIVACY_HMAC_KEY",
]);
const values = new Map();
const payload = JSON.parse(readFileSync(ssmPath, "utf8"));
for (const parameter of payload.Parameters ?? []) {
	const name = parameter.Name;
	const value = parameter.Value;
	if (typeof name !== "string" || !name.startsWith(prefix) || typeof value !== "string") {
		throw new Error("malformed Phanes SSM parameter response");
	}
	const key = name.slice(prefix.length);
	if (!allowed.has(key)) continue;
	if (/[\r\n\0]/.test(value)) throw new Error(`Phanes parameter ${key} contains a forbidden newline or NUL`);
	values.set(key, value);
}
const choreographValues = new Map();
for (const line of readFileSync(choreographEnvPath, "utf8").split(/\r?\n/)) {
	const separator = line.indexOf("=");
	if (separator < 1) continue;
	const key = line.slice(0, separator);
	choreographValues.set(key, line.slice(separator + 1));
	if ([
		"PHANES_CAPABILITY_TOKEN",
		"PHANES_TRANSCRIBE_TOKEN",
		"MNEMOSYNE_GATEWAY_BASE_URL",
		"MNEMOSYNE_SERVICE_TOKEN",
	].includes(key)) values.set(key, line.slice(separator + 1));
}
required.add("PHANES_CAPABILITY_TOKEN");
required.add("PHANES_TRANSCRIBE_TOKEN");
required.add("MNEMOSYNE_GATEWAY_BASE_URL");
required.add("MNEMOSYNE_SERVICE_TOKEN");
for (const key of required) {
	if (!values.get(key)) throw new Error(`required Phanes setting is absent or empty: ${key}`);
}
const fixed = new Map([
	["PHANES_ENABLED_COGS", "roles,privacy,agent"],
	["PHANES_GRAPH_ID", "phanes"],
	["PHANES_CONTROL_GRAPH_ID", "phanes-control"],
	["PHANES_PRIVACY_GRAPH_ID", "phanes-privacy"],
	["PHANES_SOCIAL_GRAPH_ID", "phanes-social"],
	["PHANES_SOURCE_GRAPH_ID", "phanes-discord-source"],
	["PHANES_SPOOL_ROOT", "/var/lib/phanes/jobs"],
	["PHANES_STATE_DB", "/var/lib/phanes/state/phanes.sqlite"],
	["PHANES_PRIVACY_CONTROL_DB", "/var/lib/phanes/state/privacy-control.sqlite"],
	["PHANES_HEARTBEAT_PATH", "/var/lib/phanes/state/heartbeat"],
	["PHANES_CAPABILITY_HOST", "0.0.0.0"],
	["PHANES_CAPABILITY_PORT", "8765"],
	["PHANES_TRANSCRIBE_SOCKET", "/run/choreograph-phanes/transcribe.sock"],
	["PHANES_HEALTH_REQUIRE_SOCKET", "true"],
	["PHANES_SEGMENT_MAX_MS", "15000"],
	["DOMAIN_AGENT_GRANT_AUTHORITY_GRAPH_ID", "observatory"],
]);
for (const [key, value] of fixed) values.set(key, value);
values.set("DOMAIN_AGENT_GRANT_AUTHORITY_OWNER", values.get("PHANES_GRAPH_OWNER"));
const runtimeManifest = JSON.parse(readFileSync("/var/lib/choreograph/runtime-bundles.json", "utf8"));
const agentRuntime = Array.isArray(runtimeManifest.bundles)
	? runtimeManifest.bundles.find((bundle) => bundle?.id === "sophia-agent-runtime")
	: undefined;
if (!agentRuntime || typeof agentRuntime.digest !== "string" || !/^[0-9a-f]{64}$/.test(agentRuntime.digest)) {
	throw new Error("canonical Sophia agent runtime digest is absent from the installed manifest");
}
values.set("SOPHIA_AGENT_RUNTIME_DIGEST", `sha256:${agentRuntime.digest}`);
const pilotModel = values.get("PHANES_PRIME_MODEL")
	|| choreographValues.get("PHANES_PRIME_MODEL")
	|| choreographValues.get("WORKFLOW_MODEL")
	|| choreographValues.get("OPENROUTER_MODEL")
	|| "google/gemini-2.5-flash";
if (typeof pilotModel !== "string" || !pilotModel.trim() || /[\r\n\0]/.test(pilotModel)) {
	throw new Error("Phanes Prime model binding is invalid");
}
values.set("PHANES_PRIME_MODEL", pilotModel);
if (!values.get("PHANES_EMANATION_MODEL")) values.set("PHANES_EMANATION_MODEL", pilotModel);
const serialized = [...values]
	.sort(([left], [right]) => left.localeCompare(right))
	.map(([key, value]) => `${key}=${value}`)
	.join("\n");
const temporary = `${outputPath}.tmp`;
writeFileSync(temporary, `${serialized}\n`, { mode: 0o600 });
renameSync(temporary, outputPath);
NODE

rm -f "$SSM_JSON"
chmod 0600 "$ENV_FILE"
echo "[load-phanes-env] rendered $(grep -c '=' "$ENV_FILE") allowlisted settings"
