#!/usr/bin/env bash
#
# Run a command inside the dev VM, at the orchestrator's working tree (/workspace).
# Used by `pnpm test:vm`. Example: scripts/vm/run.sh pnpm test

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
require_driver

[ "$#" -ge 1 ] || die "usage: run.sh <command> [args…]"
vm_running || die "VM '${VM_NAME}' is not running. Run: pnpm vm:up"

guest_run "$@"
