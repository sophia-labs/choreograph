#!/usr/bin/env bash
#
# Ensure the dev VM exists and is running. macOS launches/starts a lima or
# multipass VM; WSL2/Linux are in-place (the environment IS the VM), so no-op.

VM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${VM_DIR}/_common.sh"
require_driver

case "${DRIVER}" in
	lima)
		if ! vm_exists; then
			log "launching lima VM '${VM_NAME}' (Ubuntu ${VM_IMAGE}, vz, ${VM_CPUS} cpu / ${VM_MEM} / ${VM_DISK})…"
			rendered="$(mktemp -t choreograph-lima.XXXXXX.yaml)"
			trap 'rm -f "${rendered}"' EXIT
			sed -e "s|__REPO_ROOT__|${REPO_ROOT}|g" \
				-e "s|__CPUS__|${VM_CPUS}|g" \
				-e "s|__MEMORY__|${VM_MEM/G/GiB}|g" \
				-e "s|__DISK__|${VM_DISK/G/GiB}|g" \
				"${VM_DIR}/lima-choreograph.yaml" > "${rendered}"
			limactl start --name="${VM_NAME}" --tty=false "${rendered}"
		elif ! vm_running; then
			log "starting existing lima VM '${VM_NAME}'…"
			limactl start "${VM_NAME}"
		else
			log "lima VM '${VM_NAME}' already running."
		fi
		;;
	multipass)
		if ! vm_exists; then
			log "launching multipass VM '${VM_NAME}' (Ubuntu ${VM_IMAGE}, ${VM_CPUS} cpu / ${VM_MEM} / ${VM_DISK})…"
			multipass launch "${VM_IMAGE}" --name "${VM_NAME}" \
				--cpus "${VM_CPUS}" --memory "${VM_MEM}" --disk "${VM_DISK}"
		elif ! vm_running; then
			log "starting existing multipass VM '${VM_NAME}'…"
			multipass start "${VM_NAME}"
		else
			log "multipass VM '${VM_NAME}' already running."
		fi
		# (Re)mount the host repo as rsync source. Idempotent; ignore "already mounted".
		multipass mount "${REPO_ROOT}" "${VM_NAME}:${HOST_REPO_MOUNT}" 2>/dev/null || true
		;;
	inplace)
		log "running in-place (${PLATFORM}); no separate VM needed (this environment is the VM)."
		;;
esac
