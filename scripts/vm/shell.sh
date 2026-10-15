#!/usr/bin/env bash
#
# Open an interactive shell inside the dev VM. The orchestrator tree is at
# /workspace (run e.g. `tsx src/stress.ts spawn-flood` there).

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
require_driver
vm_running || die "VM '${VM_NAME}' is not running. Run: pnpm vm:up"

log "the orchestrator tree is at ${WORK_DIR}."
case "${DRIVER}" in
	lima)      exec limactl shell --workdir "${WORK_DIR}" "${VM_NAME}" ;;
	multipass) exec multipass shell "${VM_NAME}" ;;
	inplace)   cd "${WORK_DIR}" 2>/dev/null || cd "${REPO_ROOT}"; exec bash -l ;;
esac
