#!/usr/bin/env bash
# Acceptance gate for the Choreograph kernel image (Dockerfile.kernels).
#
# Runs every kernel battery in sequence inside the image, under real bwrap,
# against the payloads baked at their guest paths. Stops at the first failure.
# Exactly one thing reaches stdout: a bounded JSON summary. Everything a human
# would want to read goes to stderr and to per-battery log files, so a caller
# can pipe stdout straight into a parser.
#
#   exit 0  — accepted; every requested battery passed
#   exit 1  — rejected; the summary names the battery that failed and carries
#             the tail of its log
#   exit 2  — the environment could not run the batteries at all (no bwrap,
#             missing payload, missing harness). Still emits a summary.
#
# ── ENVIRONMENT ────────────────────────────────────────────────────────────
# Nothing is required. Every variable below is optional and has a default that
# is correct inside the image; they exist so the platform side can narrow a
# run without editing the image.
#
#   KERNEL_ACCEPTANCE_KERNELS      space-separated subset, in order.
#                                  default: "python julia ocaml cpp"
#   KERNEL_ACCEPTANCE_TIMEOUT_S    per-battery wall clock, seconds.
#                                  default: 1200 (a cold C++ kernel is the slow
#                                  one; the bridge alone allows 90 s for sockets)
#   KERNEL_ACCEPTANCE_LOG_DIR      where per-battery logs land.
#                                  default: /tmp/kernel-acceptance
#   KERNEL_ACCEPTANCE_TAIL_LINES   log tail lines carried in the summary.
#                                  default: 40
#   KERNEL_ACCEPTANCE_WORKER       path to the agent worker the harnesses bind
#                                  into the sandbox.
#                                  default: <repo>/src/worker.mjs, resolved
#                                  relative to this script — the image keeps the
#                                  repository layout precisely so this script
#                                  runs unchanged from a checkout on a Linux box
#
# ── WHAT THE SANDBOX NEEDS FROM THE POD ────────────────────────────────────
# bwrap needs to create user + mount namespaces. In Kubernetes that means a
# securityContext that does not block it: either allow unprivileged user
# namespaces on the node and drop the default seccomp filter's clone3/unshare
# restriction, or grant CAP_SYS_ADMIN. No network is required — every sandbox
# is --unshare-all and every payload is baked. No writable host path is
# required beyond the container's own /tmp.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

KERNELS="${KERNEL_ACCEPTANCE_KERNELS:-python julia ocaml cpp}"
TIMEOUT_S="${KERNEL_ACCEPTANCE_TIMEOUT_S:-1200}"
LOG_DIR="${KERNEL_ACCEPTANCE_LOG_DIR:-/tmp/kernel-acceptance}"
TAIL_LINES="${KERNEL_ACCEPTANCE_TAIL_LINES:-40}"

# Guest paths are baked, not configured. The payloads are mounted at the path
# they were built at (an opam switch and a Julia depot both record it), so a
# variable here would only ever be a way to lie about where they are.
WORKER_PATH="${KERNEL_ACCEPTANCE_WORKER:-${REPO_ROOT}/src/worker.mjs}"
BRIDGE_ROOT="/opt/choreograph-runtime/bridges"
IMAGE_METADATA="/opt/choreograph-runtime/kernel-image.json"

# kernel|payload root|harness
BATTERIES=(
	"python|/opt/runtime/python|${SCRIPT_DIR}/smoke-jupyter-bundles.mjs"
	"julia|/opt/runtime/julia|${SCRIPT_DIR}/smoke-julia-bundles.mjs"
	"ocaml|/opt/runtime/ocaml|${SCRIPT_DIR}/smoke-ocaml-bundles.mjs"
	"cpp|/opt/runtime/cpp|${SCRIPT_DIR}/smoke-cpp-bundles.mjs"
)

# Milliseconds from bash's own clock rather than from `date +%s%3N`. GNU date
# understands %3N and BSD date silently emits the literal "N", which produced a
# non-numeric timestamp, an arithmetic expansion error, and — because such an
# error unwinds the enclosing function — an environment failure that printed no
# summary and exited 0. EPOCHREALTIME is bash 5 and always digits.
now_ms() {
	if [ -n "${EPOCHREALTIME:-}" ]; then
		local microseconds="${EPOCHREALTIME/[.,]/}"
		printf '%s\n' "$((microseconds / 1000))"
		return
	fi
	printf '%s\n' "$(($(date +%s) * 1000))"
}

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_MS="$(now_ms)"
mkdir -p "${LOG_DIR}"
RECORDS="${LOG_DIR}/records.ndjson"
: > "${RECORDS}"

note() { printf '%s\n' "$*" >&2; }

record() {
	# kernel status exit_code duration_ms checks log
	printf '{"kernel":"%s","status":"%s","exit_code":%s,"duration_ms":%s,"checks":%s,"log":"%s"}\n' \
		"$1" "$2" "$3" "$4" "$5" "$6" >> "${RECORDS}"
}

# The summary is assembled by node rather than by printf: log tails are
# arbitrary bytes (ANSI, quotes, newlines, a stray NUL from a crashed kernel)
# and hand-rolled JSON escaping in bash is how acceptance output becomes
# unparseable exactly on the runs that matter. node is in this image by
# construction — it is what runs the harnesses.
emit_summary() {
	local outcome="$1"
	local reason="$2"
	local ended_ms
	ended_ms="$(now_ms)"
	node "${SCRIPT_DIR}/kernel-image-acceptance-summary.mjs" \
		--records "${RECORDS}" \
		--outcome "${outcome}" \
		--reason "${reason}" \
		--started-at "${STARTED_AT}" \
		--duration-ms "$((ended_ms - STARTED_MS))" \
		--requested "${KERNELS}" \
		--log-dir "${LOG_DIR}" \
		--tail-lines "${TAIL_LINES}" \
		--image-metadata "${IMAGE_METADATA}"
}

fail_environment() {
	note "ERROR: $1"
	# In a subshell on purpose. Anything that aborts a bash function — an
	# arithmetic expansion error is the easy one to write by accident — unwinds
	# only to the function boundary, which would skip the exit below and turn a
	# rejection into an exit 0. A subshell cannot skip it.
	(emit_summary "environment" "$1") || note "WARNING: the acceptance summary could not be written"
	exit 2
}

command -v node >/dev/null 2>&1 || fail_environment "node is not on PATH"
command -v bwrap >/dev/null 2>&1 || fail_environment "bwrap is not on PATH"
command -v timeout >/dev/null 2>&1 || fail_environment "timeout(1) is not on PATH"
[ -f "${WORKER_PATH}" ] || fail_environment "the agent worker is missing: ${WORKER_PATH}"
[ -x "${BRIDGE_ROOT}/jupyter-bridge" ] || fail_environment "the Rust bridge is missing: ${BRIDGE_ROOT}/jupyter-bridge"

# Preflight the sandbox itself, before any kernel. A pod whose securityContext
# forbids user namespaces fails every battery with a different-looking error
# 20 minutes apart; this turns that into one legible line in one second.
note "==> Preflight: bwrap can create a sandbox"
PREFLIGHT_ARGS=(--unshare-all --die-with-parent --ro-bind /usr /usr)
[ -d /lib64 ] && PREFLIGHT_ARGS+=(--ro-bind /lib64 /lib64)
PREFLIGHT_ARGS+=(--symlink /usr/lib /lib --symlink /usr/bin /bin --tmpfs /tmp --proc /proc --dev /dev --cap-drop ALL)
PREFLIGHT_OUTPUT="$(bwrap "${PREFLIGHT_ARGS[@]}" -- /bin/true 2>&1)" \
	|| fail_environment "bwrap cannot create a sandbox in this pod: ${PREFLIGHT_OUTPUT}"

note "==> Preflight: the Rust bridge runs"
BRIDGE_VERSION="$("${BRIDGE_ROOT}/jupyter-bridge" --version 2>&1)" \
	|| fail_environment "the Rust bridge does not run: ${BRIDGE_VERSION}"
note "    ${BRIDGE_VERSION}"

FAILED_KERNEL=""
FAILED_REASON=""

for kernel in ${KERNELS}; do
	entry=""
	for candidate in "${BATTERIES[@]}"; do
		[ "${candidate%%|*}" = "${kernel}" ] && entry="${candidate}"
	done
	if [ -z "${entry}" ]; then
		fail_environment "unknown kernel requested: ${kernel}"
	fi

	rest="${entry#*|}"
	payload_root="${rest%%|*}"
	harness="${rest#*|}"

	[ -d "${payload_root}" ] || fail_environment "${kernel}: payload is missing from the image: ${payload_root}"
	[ -f "${harness}" ] || fail_environment "${kernel}: harness is missing from the image: ${harness}"

	log="${LOG_DIR}/${kernel}.log"
	note ""
	note "==> ${kernel} battery — $(basename "${harness}")"
	battery_started="$(now_ms)"
	status=0
	timeout --signal=TERM --kill-after=30s "${TIMEOUT_S}" \
		node "${harness}" "${payload_root}" "${BRIDGE_ROOT}" "${WORKER_PATH}" \
		> "${log}" 2>&1 || status=$?
	battery_ended="$(now_ms)"
	duration=$((battery_ended - battery_started))
	# The harnesses that use record() print one "  PASS  " line per check; the
	# Python one predates that convention and prints a single closing line, so a
	# zero here means "not instrumented", not "nothing ran".
	checks="$(grep -c '^[[:space:]]*PASS[[:space:]]' "${log}" 2>/dev/null || true)"
	checks="${checks:-0}"

	tail -n "${TAIL_LINES}" "${log}" >&2

	if [ "${status}" -eq 0 ]; then
		record "${kernel}" "pass" "${status}" "${duration}" "${checks}" "${log}"
		note "    ${kernel}: PASS in ${duration} ms (${checks} recorded checks)"
		continue
	fi

	record "${kernel}" "fail" "${status}" "${duration}" "${checks}" "${log}"
	FAILED_KERNEL="${kernel}"
	if [ "${status}" -eq 124 ] || [ "${status}" -eq 137 ]; then
		FAILED_REASON="${kernel} battery exceeded ${TIMEOUT_S}s (exit ${status})"
	else
		FAILED_REASON="${kernel} battery exited ${status}"
	fi
	note "    ${kernel}: FAIL — ${FAILED_REASON}"
	# First failure wins. Later batteries would only bury it: the kernels share
	# the bridge and the sandbox shape, so a second failure is usually the same
	# failure wearing a different language.
	break
done

if [ -n "${FAILED_KERNEL}" ]; then
	emit_summary "rejected" "${FAILED_REASON}"
	exit 1
fi

emit_summary "accepted" ""
exit 0
