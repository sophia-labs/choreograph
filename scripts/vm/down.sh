#!/usr/bin/env bash
#
# Stop the dev VM (or the orchestrator service when running in-place).
#   down.sh           stop the VM (keeps it for next time)
#   down.sh --purge   delete the VM entirely (lima/multipass)

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"
require_driver

purge="${1:-}"
is_purge() { [ "${purge}" = "--purge" ] || [ "${purge}" = "--delete" ]; }

case "${DRIVER}" in
	lima)
		vm_exists || { log "lima VM '${VM_NAME}' does not exist; nothing to do."; exit 0; }
		if is_purge; then
			log "deleting lima VM '${VM_NAME}'…"
			limactl stop "${VM_NAME}" 2>/dev/null || true
			limactl delete "${VM_NAME}"
		else
			log "stopping lima VM '${VM_NAME}' (use --purge to delete)…"
			limactl stop "${VM_NAME}"
		fi
		;;
	multipass)
		vm_exists || { log "multipass VM '${VM_NAME}' does not exist; nothing to do."; exit 0; }
		if is_purge; then
			log "deleting multipass VM '${VM_NAME}'…"
			multipass delete --purge "${VM_NAME}"
		else
			log "stopping multipass VM '${VM_NAME}' (use --purge to delete)…"
			multipass stop "${VM_NAME}"
		fi
		;;
	inplace)
		log "stopping orchestrator service…"
		sudo systemctl stop choreograph-dev || true
		;;
esac
