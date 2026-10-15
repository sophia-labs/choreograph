#!/usr/bin/env bash
#
# Provision an Ubuntu (22.04) environment to run the Choreograph orchestrator
# with the real production code path: bubblewrap isolation + cgroup v2 limits.
#
# Runs as root INSIDE the VM (multipass guest) or WSL2 distro. Mirrors the prod
# host install, minus SSM/Cognito/S3 (dev = mock LLM,
# Mnemosyne disabled). Idempotent: safe to re-run.
#
# Usage (inside the VM):  sudo SRC_DIR=/host-repo RUN_USER=ubuntu bash provision.sh
#   SRC_DIR   where the host repo is readable (multipass mount, or /mnt/c/... on WSL)
#   RUN_USER  unprivileged user the orchestrator runs as (default: SUDO_USER or ubuntu)

set -euo pipefail

SRC_DIR="${SRC_DIR:-/host-repo}"
RUN_USER="${RUN_USER:-${SUDO_USER:-ubuntu}}"
WORK_DIR="/workspace"
DATA_DIR="/var/lib/choreograph"
PORT="${PORT:-3456}"

log() { printf '\033[1;36m[provision]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[provision] error:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "must run as root (use sudo)"
exec > >(tee /var/log/choreograph-provision.log) 2>&1

# ── 0. Preconditions ───────────────────────────────────────────────────────
id "${RUN_USER}" >/dev/null 2>&1 || die "run user '${RUN_USER}' does not exist"
[ -d "${SRC_DIR}/src" ] && [ -f "${SRC_DIR}/package.json" ] \
	|| die "SRC_DIR '${SRC_DIR}' is not the choreograph repo root"
# PID 1 must be systemd (tolerates a 'degraded' state, common on WSL2/minimal VMs).
[ "$(ps -p 1 -o comm= 2>/dev/null)" = "systemd" ] \
	|| die "systemd is not PID 1. On WSL2 set '[boot]' + 'systemd=true' in /etc/wsl.conf, then 'wsl --shutdown'."
[ -f /sys/fs/cgroup/cgroup.controllers ] \
	|| die "no cgroup v2 unified hierarchy at /sys/fs/cgroup — required by src/cgroup.ts"

# ── 1. System packages (the AL2023 `dnf install` analog) ────────────────────
log "installing system packages…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y bubblewrap zstd git curl ca-certificates file musl-tools rsync

# Node.js 22 (Ubuntu ships older) via NodeSource — mirrors userdata.sh.
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v 2>/dev/null)" != v22.* ]]; then
	log "installing Node.js 22…"
	curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
	apt-get install -y nodejs
fi
corepack enable
corepack prepare pnpm@10.34.5 --activate
npm install -g tsx >/dev/null 2>&1 || true   # convenience for `tsx src/stress.ts`

# Rust owns the Jupyter control implementation. Python remains only a pinned
# third-party guest payload built by package-runtime-bundles.sh below.
RUN_HOME="$(getent passwd "${RUN_USER}" | cut -d: -f6)"
if [ ! -x "${RUN_HOME}/.cargo/bin/rustup" ]; then
	log "installing rustup for the native Jupyter controller…"
	sudo -u "${RUN_USER}" env HOME="${RUN_HOME}" bash -c \
		'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain none'
fi
sudo -u "${RUN_USER}" env HOME="${RUN_HOME}" "${RUN_HOME}/.cargo/bin/rustup" toolchain install 1.95.0 \
	--profile minimal \
	--component clippy,rustfmt \
	--target x86_64-unknown-linux-musl

# ── 2. Unprivileged user namespaces (the Ubuntu 24.04 AppArmor trap) ────────
# bwrap's --unshare-all needs unprivileged userns. 24.04+ restricts via AppArmor.
if [ -e /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
	sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 || true
	echo 'kernel.apparmor_restrict_unprivileged_userns=0' > /etc/sysctl.d/99-choreograph-userns.conf
fi
sysctl -w kernel.unprivileged_userns_clone=1 2>/dev/null || true
log "bwrap userns preflight…"
sudo -u "${RUN_USER}" bwrap --unshare-user --ro-bind / / true \
	|| die "bwrap cannot create a user namespace as ${RUN_USER} — check AppArmor/sysctl (see CONTRIBUTING.md)"

# ── 3. Copy repo into a VM-local /workspace (NOT a live mount) ──────────────
# node_modules/dist must be Linux-native and VM-local so they never clobber the
# host's. Choreograph's host-side agent support is rebuilt in the VM; the
# sandbox entrypoint comes only from the resolved sophia-agent-runtime bundle.
log "syncing repo ${SRC_DIR} → ${WORK_DIR}…"
# Exclude node_modules (native binaries must be Linux/VM-local) and .git/.data, but
# KEEP dist/ — workspace packages (pi/* via workspace:*) ship prebuilt JS + types in
# dist/, and Choreograph's TypeScript dist is rebuilt below regardless. dist is pure JS, safe
# to copy across OSes; only node_modules is platform-specific.
mkdir -p "${WORK_DIR}"
rsync -a --delete \
	--exclude='.git/' --exclude='node_modules/' \
	--exclude='target/' --exclude='deploy/runtime-bundles/' \
	--exclude='deploy/runtime-manifests/' \
	--exclude='.data/' --exclude='*.log' \
	"${SRC_DIR}/" "${WORK_DIR}/"
chown -R "${RUN_USER}:${RUN_USER}" "${WORK_DIR}"

# ── 4. Install deps + build host support (as the run user) ──────────────
log "pnpm install + build (this can take a few minutes on first run)…"
sudo -u "${RUN_USER}" bash -lc "cd ${WORK_DIR} && pnpm install && pnpm build"
[ -f "${WORK_DIR}/src/runtime-bundles.dev.json" ] \
	|| die "source checkout is missing src/runtime-bundles.dev.json"

# ── 5. Data dir (DATA_DIR, like userdata.sh /var/lib/choreograph) ───────────
# chown the whole tree: the service user must own DATA_DIR itself (not just
# bundles/) to create the SQLite files there.
mkdir -p "${DATA_DIR}/bundles"
chown -R "${RUN_USER}:${RUN_USER}" "${DATA_DIR}"

# ── 6. Build + hydrate the exact guest runtime set ─────────────────────────
log "building and behavior-testing canonical guest runtime bundles…"
sudo -u "${RUN_USER}" env HOME="${RUN_HOME}" bash -lc \
	"export PATH=\"${RUN_HOME}/.cargo/bin:\$PATH\"; cd ${WORK_DIR}; CHOREOGRAPH_SKIP_PREBUILD=1 ./deploy/package-runtime-bundles.sh dev-local"
"${WORK_DIR}/deploy/hydrate-runtime-bundles.sh" \
	dev-local \
	"${DATA_DIR}/bundles" \
	/etc/choreograph/runtime-bundles.json

# ── 7. Install the local systemd unit (gives the orchestrator a delegated cgroup) ─
log "installing choreograph-dev systemd unit…"
sed "s/__RUN_USER__/${RUN_USER}/g" "${WORK_DIR}/scripts/vm/choreograph-dev.service" \
	> /etc/systemd/system/choreograph-dev.service
install -m755 "${WORK_DIR}/scripts/vm/run-orchestrator.sh" /usr/local/bin/choreograph-run
install -d /etc/choreograph
# Record the rsync source so `vm:sync` knows where to pull host edits from.
echo "${SRC_DIR}" > /etc/choreograph/vm-src
if [ ! -f /etc/choreograph/dev.env ]; then
	install -m644 "${WORK_DIR}/scripts/vm/dev.env.example" /etc/choreograph/dev.env
fi
systemctl daemon-reload
systemctl enable --now choreograph-dev
sleep 1

# ── 8. Report ───────────────────────────────────────────────────────────────
log "done. orchestrator service: choreograph-dev"
log "  logs:    journalctl -u choreograph-dev -f"
log "  health:  curl http://localhost:${PORT}/health"
systemctl is-active --quiet choreograph-dev \
	&& log "  status:  active ✔" \
	|| { systemctl --no-pager --lines=20 status choreograph-dev || true; die "service failed to start"; }
