#!/usr/bin/env bash
#
# Shared config + driver helpers for the local-dev VM scripts (scripts/vm/*).
#
# The local dev story runs the REAL Choreograph runtime (bwrap + cgroup v2) in a
# plain Linux VM — never Docker, never a fork spawner. The repo is copied INTO the
# VM (rsync, VM-local ext4) rather than live-mounted, so the VM's Linux
# node_modules/dist never clobber the host's native binaries.
#
# Platforms / drivers:
#   macOS    → lima (Apple Virtualization.framework, native) or multipass (QEMU)
#   Windows  → WSL2 (in-place; WSL2 is itself the Linux VM)
#   Linux    → in-place
# Override the macOS driver with CHOREOGRAPH_VM_DRIVER=lima|multipass.

set -euo pipefail

# ─── Config (env-overridable) ─────────────────────────────────────────────
VM_NAME="${CHOREOGRAPH_VM_NAME:-choreograph}"
VM_IMAGE="${CHOREOGRAPH_VM_IMAGE:-22.04}"   # pin 22.04: 24.04 AppArmor-restricts unprivileged userns
VM_CPUS="${CHOREOGRAPH_VM_CPUS:-4}"
VM_MEM="${CHOREOGRAPH_VM_MEM:-6G}"
VM_DISK="${CHOREOGRAPH_VM_DISK:-20G}"
PORT="${PORT:-3456}"

# Multipass mounts the host repo here (read-only, rsync source). Lima mounts the
# repo at its own host path. Both rsync into a VM-local /workspace; the agent
# worker development mount resolves from that stable path. Python/Jupyter use
# the same digest-addressed guest bundles as production.
HOST_REPO_MOUNT="/host-repo"
WORK_DIR="/workspace"

_VM_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${_VM_SCRIPT_DIR}/../.." && pwd)"

# ─── Logging ──────────────────────────────────────────────────────────────
log()  { printf '\033[1;36m[vm]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[vm]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[vm] error:\033[0m %s\n' "$*" >&2; exit 1; }

# ─── Platform + driver selection ──────────────────────────────────────────
detect_platform() {
	case "$(uname -s)" in
		Darwin) echo "mac" ;;
		Linux)
			if grep -qiE "microsoft|wsl" /proc/version 2>/dev/null; then echo "wsl"; else echo "linux"; fi ;;
		*) echo "unsupported" ;;
	esac
}

PLATFORM="$(detect_platform)"

select_driver() {
	case "${PLATFORM}" in
		mac)
			case "${CHOREOGRAPH_VM_DRIVER:-auto}" in
				lima)      echo "lima" ;;
				multipass) echo "multipass" ;;
				auto)
					if command -v limactl >/dev/null 2>&1; then echo "lima"
					elif command -v multipass >/dev/null 2>&1; then echo "multipass"
					else echo "none"; fi ;;
				*) echo "none" ;;
			esac ;;
		wsl|linux) echo "inplace" ;;
		*) echo "none" ;;
	esac
}

DRIVER="$(select_driver)"

require_driver() {
	case "${DRIVER}" in
		lima)      command -v limactl >/dev/null 2>&1 || die "limactl not found. Install Lima: brew install lima — see CONTRIBUTING.md" ;;
		multipass) command -v multipass >/dev/null 2>&1 || die "multipass not found. Install: brew install --cask multipass" ;;
		inplace)   : ;;
		*)         die "no supported VM driver for this host (set CHOREOGRAPH_VM_DRIVER=lima|multipass on macOS)." ;;
	esac
}

# ─── Driver primitives ────────────────────────────────────────────────────
# In-guest path of the host repo (the rsync source for provision/sync).
guest_src_dir() {
	case "${DRIVER}" in
		multipass) echo "${HOST_REPO_MOUNT}" ;;
		lima)      echo "${REPO_ROOT}" ;;   # Lima mounts the repo at the same host path
		inplace)   echo "${REPO_ROOT}" ;;
	esac
}

vm_exists() {
	case "${DRIVER}" in
		multipass) multipass info "${VM_NAME}" >/dev/null 2>&1 ;;
		lima)      [ -n "$(limactl list -q "${VM_NAME}" 2>/dev/null)" ] ;;
		inplace)   return 0 ;;
	esac
}

vm_running() {
	case "${DRIVER}" in
		multipass) [ "$(multipass info "${VM_NAME}" --format csv 2>/dev/null | awk -F, 'NR==2{print $2}')" = "Running" ] ;;
		lima)      [ "$(limactl list "${VM_NAME}" --format '{{.Status}}' 2>/dev/null)" = "Running" ] ;;
		inplace)   return 0 ;;
	esac
}

# Run a command in the guest, cwd = /workspace. Usage: guest_run pnpm test
guest_run() {
	case "${DRIVER}" in
		multipass) multipass exec "${VM_NAME}" -- bash -lc 'cd /workspace && exec "$@"' _ "$@" ;;
		lima)      limactl shell --workdir "${WORK_DIR}" "${VM_NAME}" bash -lc 'exec "$@"' _ "$@" ;;
		inplace)   ( cd "${WORK_DIR}" 2>/dev/null || cd "${REPO_ROOT}"; exec "$@" ) ;;
	esac
}

# Run a root shell body in the guest. Usage: guest_root '<bash body>' arg1 arg2…
guest_root() {
	local body="$1"; shift
	case "${DRIVER}" in
		multipass) multipass exec "${VM_NAME}" -- sudo bash -c "${body}" _ "$@" ;;
		lima)      limactl shell "${VM_NAME}" sudo bash -c "${body}" _ "$@" ;;
		inplace)   sudo bash -c "${body}" _ "$@" ;;
	esac
}

# How to reach the orchestrator from the host.
host_url() {
	case "${DRIVER}" in
		multipass) local ip; ip="$(multipass info "${VM_NAME}" 2>/dev/null | awk '/IPv4/{print $2; exit}')"; echo "http://${ip:-<vm-ip>}:${PORT}" ;;
		lima|inplace) echo "http://localhost:${PORT}" ;;   # lima/WSL2 forward localhost
	esac
}
