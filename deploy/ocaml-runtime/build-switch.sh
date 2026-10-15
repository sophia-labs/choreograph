#!/usr/bin/env bash
# Bake the read-only OCaml switch the sandbox mounts.
#
# This runs at IMAGE BUILD time, where the network exists. The bwrap sandbox is
# --unshare-all and mounts this tree read-only, so the compiler, the libraries,
# the C stubs and every shared object those stubs dlopen have to already be here.
#
# opam is not relocatable, and OCaml is the sharpest case of it. A switch bakes
# its own prefix into findlib.conf, into lib/ocaml/ld.conf, into the shebang of
# every bytecode executable, and into Config.standard_library inside ocamlrun.
# Julia's .ji caches only *validate* recorded paths; OCaml *executes* them. So
# the switch is created at ${OCAML_RUNTIME_ROOT} and never moved, and the
# sandbox binds the bundle at exactly that path.
#
# Scope cut, deliberate, mirroring the Julia payload: the kernel and nothing
# else. No merlin (completion/inspection only), no topfind, no jupyter.notebook
# rich display. They enlarge the bundle without touching the transport under
# proof, and merlin in particular would put a compiler server inside a sandbox
# that has no network and no writable prefix.
set -euo pipefail

OCAML_RUNTIME_ROOT="${OCAML_RUNTIME_ROOT:?OCAML_RUNTIME_ROOT is required}"
OCAML_JUPYTER_SRC="${OCAML_JUPYTER_SRC:?OCAML_JUPYTER_SRC is required}"
OCAML_JUPYTER_VERSION="${OCAML_JUPYTER_VERSION:?OCAML_JUPYTER_VERSION is required}"
OCAML_JUPYTER_COMMIT="${OCAML_JUPYTER_COMMIT:?OCAML_JUPYTER_COMMIT is required}"
OCAML_VERSION="${OCAML_VERSION:?OCAML_VERSION is required}"
PATCH_DIR="${PATCH_DIR:?PATCH_DIR is required}"

SWITCH="${OCAML_RUNTIME_ROOT}/_opam"
BUNDLED_LIB_DIR="${OCAML_RUNTIME_ROOT}/lib"
KERNEL_BIN="${SWITCH}/bin/ocaml-jupyter-kernel"

# Shared objects the sandbox may legitimately resolve from the host bind of
# /usr: the C runtime the orchestrator's own node process already depends on.
# Anything else has to travel inside the bundle.
HOST_BASELINE_SONAMES=(
	"linux-vdso.so.1"
	"ld-linux-x86-64.so.2"
	"libc.so.6"
	"libm.so.6"
	"libdl.so.2"
	"libpthread.so.0"
	"librt.so.1"
	"libstdc++.so.6"
	"libgcc_s.so.1"
)

is_host_baseline() {
	local soname="$1"
	for allowed in "${HOST_BASELINE_SONAMES[@]}"; do
		[ "${soname}" = "${allowed}" ] && return 0
	done
	return 1
}

stub_directories() {
	printf '%s\n' "${SWITCH}/lib/stublibs" "${SWITCH}/lib/ocaml/stublibs"
}

list_shared_objects() {
	local directory
	while IFS= read -r directory; do
		[ -d "${directory}" ] || continue
		find "${directory}" -maxdepth 1 -type f -name '*.so' -print
	done < <(stub_directories)
	if [ -d "${BUNDLED_LIB_DIR}" ]; then
		find "${BUNDLED_LIB_DIR}" -maxdepth 1 -type f -name '*.so*' -print
	fi
}

echo "==> Verifying the pinned ocaml-jupyter checkout"
cd "${OCAML_JUPYTER_SRC}"
ACTUAL_COMMIT="$(git rev-parse HEAD)"
if [ "${ACTUAL_COMMIT}" != "${OCAML_JUPYTER_COMMIT}" ]; then
	echo "ERROR: ocaml-jupyter commit drift: expected ${OCAML_JUPYTER_COMMIT}, got ${ACTUAL_COMMIT}" >&2
	exit 1
fi

echo "==> Applying Sophia patches to ocaml-jupyter ${OCAML_JUPYTER_VERSION}"
shopt -s nullglob
PATCHES=("${PATCH_DIR}"/*.patch)
shopt -u nullglob
if [ ${#PATCHES[@]} -eq 0 ]; then
	echo "ERROR: no patches found in ${PATCH_DIR}; the ipc transport fix is mandatory" >&2
	exit 1
fi
for patch in "${PATCHES[@]}"; do
	echo "    $(basename "${patch}")"
	git apply --verbose "${patch}"
done
# Fail loudly if a patch silently no-ops after an upstream bump: the ipc address
# form is the difference between a working kernel and a 90 s socket timeout.
grep -q 'transport = "tcp"' src/kernel/connection_info.ml ||
	{ echo "ERROR: the ipc address patch did not take" >&2; exit 1; }
grep -q 'SHELL_ABORT \[@name "aborted"\]' src/core/shell.ml ||
	{ echo "ERROR: the execute_reply status patch did not take" >&2; exit 1; }
grep -q 'Lwt_mvar.take_available repl.exec_status' src/repl/process.ml ||
	{ echo "ERROR: the stale exec status patch did not take" >&2; exit 1; }
# opam pins a directory that contains a .git through its git backend, and the
# git backend installs the committed HEAD — a working tree full of applied
# patches would be silently ignored. Commit, so the pinned revision *is* the
# patched source and the build log shows which revision was installed.
git -c user.name="Choreograph runtime build" \
	-c user.email="runtime-build@choreograph.invalid" \
	commit --quiet --all --message "Sophia sandbox patches for ocaml-jupyter ${OCAML_JUPYTER_VERSION}"
echo "    patched revision: $(git rev-parse HEAD)"

echo "==> Installing jupyter ${OCAML_JUPYTER_VERSION} into ${SWITCH}"
# --no-depexts is load-bearing rather than tidy: conf-zmq declares libzmq3-dev
# as a Debian depext, and letting opam apt-install it would link the OCaml stubs
# against a /usr copy that the sandbox bundle does not carry.
opam install --switch "${OCAML_RUNTIME_ROOT}" --yes --no-depexts .

echo "==> Harvesting the shared objects the C stubs need"
mkdir -p "${BUNDLED_LIB_DIR}"
while :; do
	COPIED=0
	while IFS= read -r object; do
		while read -r soname _arrow path _address; do
			[ "${_arrow}" = "=>" ] || continue
			[ -n "${path}" ] && [ "${path}" != "not" ] || continue
			is_host_baseline "${soname}" && continue
			case "${path}" in
				"${OCAML_RUNTIME_ROOT}"/*) continue ;;
			esac
			echo "    ${soname}  <-  ${path}"
			cp -L "${path}" "${BUNDLED_LIB_DIR}/${soname}"
			chmod 0755 "${BUNDLED_LIB_DIR}/${soname}"
			COPIED=$((COPIED + 1))
		done < <(ldd "${object}" 2>/dev/null | sed 's/^[[:space:]]*//')
	done < <(list_shared_objects)
	[ "${COPIED}" -eq 0 ] && break
	# Newly copied libraries can pull in libraries of their own; repeat to a
	# fixpoint rather than assuming a one-level closure.
	while IFS= read -r object; do
		patchelf --set-rpath "${BUNDLED_LIB_DIR}" "${object}"
	done < <(list_shared_objects)
done

echo "==> Baking an absolute RUNPATH at the guest path"
# rpath over LD_LIBRARY_PATH: the loader path travels with the artifact instead
# of with the registry entry, so a bundle that resolves here resolves anywhere
# it is mounted at its baked path — and an env var cannot be forgotten.
while IFS= read -r object; do
	patchelf --set-rpath "${BUNDLED_LIB_DIR}" "${object}"
done < <(list_shared_objects)

echo "==> Folding the switch's stub directories into ld.conf"
# The one place opam's non-relocatability hides outside the filesystem. The
# compiler writes only its own two directories into lib/ocaml/ld.conf; the
# packages' stubs — dllzmq_stubs.so among them — live in <switch>/lib/stublibs,
# which opam publishes as CAML_LD_LIBRARY_PATH from `opam env`. The sandbox has
# no opam, no shell and no profile, so that path has to be *in the artifact* or
# the registry entry would have to carry it as environment. ld.conf is the
# OCaml runtime's own absolute-path configuration and it ships inside the
# bundle, so it goes there. Prepended, matching opam's own precedence.
LD_CONF="${SWITCH}/lib/ocaml/ld.conf"
MISSING_STUB_DIRS=""
while IFS= read -r directory; do
	[ -d "${directory}" ] || continue
	grep -qx "${directory}" "${LD_CONF}" && continue
	MISSING_STUB_DIRS="${MISSING_STUB_DIRS}${directory}"$'\n'
	echo "    + ${directory}"
done < <(stub_directories)
if [ -n "${MISSING_STUB_DIRS}" ]; then
	printf '%s' "${MISSING_STUB_DIRS}" | cat - "${LD_CONF}" > "${LD_CONF}.new"
	mv "${LD_CONF}.new" "${LD_CONF}"
fi

echo "==> Pruning build-only switch state"
rm -rf \
	"${SWITCH}/.opam-switch/sources" \
	"${SWITCH}/.opam-switch/build" \
	"${SWITCH}/.opam-switch/backup" \
	"${SWITCH}/doc" \
	"${SWITCH}/man" \
	"${SWITCH}/share/man" \
	"${SWITCH}/share/doc" \
	"${OCAML_RUNTIME_ROOT}/share/man" \
	"${OCAML_RUNTIME_ROOT}/share/doc"
# Interface trees exist for merlin, which is deliberately not in this bundle.
find "${SWITCH}/lib" -type f \( -name '*.cmt' -o -name '*.cmti' \) -delete
# libtool archives describe how to relink; nothing in the sandbox links.
find "${BUNDLED_LIB_DIR}" -maxdepth 1 -type f -name '*.la' -delete

echo "==> Verifying the baked switch"
test -x "${KERNEL_BIN}" || { echo "ERROR: ${KERNEL_BIN} is missing" >&2; exit 1; }
# `(modes byte)` in ocaml-jupyter's dune: the kernel is a bytecode image whose
# interpreter is named absolutely on line 1. That shebang is the single most
# direct proof that the switch has to live where it was built.
SHEBANG="$(head -c 128 "${KERNEL_BIN}" | head -n 1)"
echo "    shebang: ${SHEBANG}"
[ "${SHEBANG}" = "#!${SWITCH}/bin/ocamlrun" ] ||
	{ echo "ERROR: kernel shebang does not name the baked ocamlrun" >&2; exit 1; }
echo "    ld.conf:"
sed 's/^/      /' "${LD_CONF}"
# ocamlrun resolves every C stub through ld.conf, whose entries are absolute.
# Assert the containment both ways round: each directory that actually holds a
# stub must be listed, so a future opam layout change cannot quietly strand one.
while IFS= read -r directory; do
	[ -d "${directory}" ] || continue
	[ -n "$(find "${directory}" -maxdepth 1 -name 'dll*.so' -print -quit)" ] || continue
	echo "    stub directory: ${directory}"
	grep -qx "${directory}" "${LD_CONF}" ||
		{ echo "ERROR: ld.conf does not name stub directory ${directory}" >&2; exit 1; }
done < <(stub_directories)
"${KERNEL_BIN}" -version

echo "==> Verifying every stub resolves inside the bundle"
UNRESOLVED=0
while IFS= read -r object; do
	while read -r soname _arrow path _address; do
		if [ "${_arrow}" = "=>" ] && [ "${path}" = "not" ]; then
			echo "ERROR: $(basename "${object}") cannot resolve ${soname}" >&2
			UNRESOLVED=1
			continue
		fi
		[ "${_arrow}" = "=>" ] || continue
		[ -n "${path}" ] || continue
		is_host_baseline "${soname}" && continue
		case "${path}" in
			"${OCAML_RUNTIME_ROOT}"/*) ;;
			*)
				echo "ERROR: $(basename "${object}") resolves ${soname} outside the bundle: ${path}" >&2
				UNRESOLVED=1
				;;
		esac
	done < <(ldd "${object}" 2>/dev/null | sed 's/^[[:space:]]*//')
done < <(list_shared_objects)
[ "${UNRESOLVED}" -eq 0 ] || exit 1
echo "    bundled libraries: $(ls "${BUNDLED_LIB_DIR}" | tr '\n' ' ')"

echo "==> Proving the ipc transport patch against a live kernel"
# The whole reason this bundle carries a patch. Start the real kernel against a
# real connection file in transport:ipc and assert it binds five unix-domain
# sockets at <ip>-<port> — the form the Rust bridge waits for — and opens no TCP
# listener, which is the only shape that can work under --unshare-all.
PROBE_PREFIX="/tmp/ocaml-ipc-probe"
PROBE_CONNECTION="${PROBE_PREFIX}.json"
cat > "${PROBE_CONNECTION}" <<EOF
{
  "transport": "ipc",
  "ip": "${PROBE_PREFIX}",
  "signature_scheme": "hmac-sha256",
  "key": "00000000-0000-4000-8000-000000000000",
  "stdin_port": 1,
  "control_port": 2,
  "hb_port": 3,
  "shell_port": 4,
  "iopub_port": 5
}
EOF
"${KERNEL_BIN}" -noinit --verbosity app --connection-file "${PROBE_CONNECTION}" &
PROBE_PID=$!
trap 'kill -9 "${PROBE_PID}" 2>/dev/null || true' EXIT
for _ in $(seq 1 300); do
	READY=1
	for port in 1 2 3 4 5; do
		[ -S "${PROBE_PREFIX}-${port}" ] || READY=0
	done
	[ "${READY}" -eq 1 ] && break
	kill -0 "${PROBE_PID}" 2>/dev/null ||
		{ echo "ERROR: kernel exited before binding its ipc sockets" >&2; exit 1; }
	sleep 0.1
done
for port in 1 2 3 4 5; do
	[ -S "${PROBE_PREFIX}-${port}" ] ||
		{ echo "ERROR: ${PROBE_PREFIX}-${port} is not a unix-domain socket" >&2; exit 1; }
done
# /proc/net/tcp{,6} state 0A is LISTEN. A tcp:// bind here would mean the patch
# had not taken and the kernel would be unreachable inside --unshare-all.
LISTENERS="$(awk 'NR > 1 && $4 == "0A"' /proc/net/tcp /proc/net/tcp6 | wc -l)"
if [ "${LISTENERS}" -ne 0 ]; then
	echo "ERROR: the kernel opened ${LISTENERS} TCP listeners under transport:ipc" >&2
	awk 'NR > 1 && $4 == "0A"' /proc/net/tcp /proc/net/tcp6 >&2
	exit 1
fi
echo "    5/5 channels bound as unix-domain sockets, 0 TCP listeners"
kill -9 "${PROBE_PID}" 2>/dev/null || true
trap - EXIT
rm -f "${PROBE_CONNECTION}" "${PROBE_PREFIX}"-[1-5]

echo "==> Baked OCaml payload sizes"
du -sh "${SWITCH}/lib/ocaml" "${SWITCH}/lib" "${SWITCH}/bin" "${BUNDLED_LIB_DIR}" "${OCAML_RUNTIME_ROOT}"
echo "ocaml ${OCAML_VERSION} | ocaml-jupyter ${OCAML_JUPYTER_VERSION} (${OCAML_JUPYTER_COMMIT})"
