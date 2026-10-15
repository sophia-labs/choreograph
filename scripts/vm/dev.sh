#!/usr/bin/env bash
#
# Headline entry point: from a cold host to a running orchestrator.
# Ensures the VM, provisions it (install + rsync repo → /workspace + build + start
# the service), and prints how to reach the API. Re-runnable; provisioning is idempotent.

VM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${VM_DIR}/_common.sh"
require_driver

# 1. Ensure the VM exists / is running (no-op for in-place).
bash "${VM_DIR}/up.sh"

# 2. Provision: install deps, rsync repo → /workspace, build, start the service.
#    RUN_USER defaults to SUDO_USER inside provision.sh (ubuntu on multipass, the
#    host user on lima, the invoking user in-place) — no need to pass it.
log "provisioning '${VM_NAME}' (first run installs packages + builds — be patient)…"
guest_root 'export SRC_DIR="$1"; bash "$1/scripts/vm/provision.sh"' "$(guest_src_dir)"

# 3. Report.
log "orchestrator up. From the host:"
log "  health:  curl $(host_url)/health"
log "  logs:    pnpm vm:shell  →  journalctl -u choreograph-dev -f"
log "  edit:    edit on host then  pnpm vm:sync  (or edit in-VM via vm:shell / Remote-SSH)"
