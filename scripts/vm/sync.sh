#!/usr/bin/env bash
#
# Push host edits into the VM's /workspace, rebuild, and restart the orchestrator.
# Use after editing on the host (alternatively edit in-VM via vm:shell or VS Code
# Remote-SSH/WSL and skip syncing).

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
require_driver
vm_running || die "VM '${VM_NAME}' is not running. Run: pnpm vm:up"

# Sync routine executed (as root) in the guest. $1 = rsync source dir.
read -r -d '' _SYNC_BODY <<'EOF' || true
set -euo pipefail
SRC="$1"
[ -d "$SRC/src" ] || { echo "[sync] error: source '$SRC' is not the repo root" >&2; exit 1; }
RUN_USER="$(stat -c %U /workspace)"
rsync -a --delete \
	--exclude='.git/' --exclude='node_modules/' \
	--exclude='target/' --exclude='deploy/runtime-bundles/' \
	--exclude='deploy/runtime-manifests/' \
	--exclude='.data/' --exclude='*.log' \
	"$SRC/" /workspace/
chown -R "$RUN_USER:$RUN_USER" /workspace
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
sudo -u "$RUN_USER" env HOME="$RUN_HOME" bash -lc \
	"export PATH=\"$RUN_HOME/.cargo/bin:\$PATH\"; cd /workspace; pnpm install; pnpm build; CHOREOGRAPH_SKIP_PREBUILD=1 ./deploy/package-runtime-bundles.sh dev-local"
/workspace/deploy/hydrate-runtime-bundles.sh \
	dev-local \
	/var/lib/choreograph/bundles \
	/etc/choreograph/runtime-bundles.json
systemctl restart choreograph-dev
echo "[sync] done; choreograph-dev restarted"
EOF

# Source dir: the deterministic mount path per driver; in-place reads the original
# checkout recorded at provision time (the running tree lives at /workspace).
src="$(guest_src_dir)"
if [ "${DRIVER}" = "inplace" ]; then
	src="$(cat /etc/choreograph/vm-src 2>/dev/null || echo "${src}")"
fi

log "syncing ${src} → ${WORK_DIR} and rebuilding…"
guest_root "${_SYNC_BODY}" "${src}"
