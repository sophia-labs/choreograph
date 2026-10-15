#!/usr/bin/env bash
# Phase 2 of the C++ payload: make the installed conda closure into a sandbox
# artifact, and prove it is one.
#
# The problem this file exists to solve: xeus-cpp does not carry a compiler
# configuration, it *discovers* one at kernel start, and both discovery paths
# are unavailable inside the sandbox.
#
#   CppInterOp::DetectResourceDir()            popen("clang -print-resource-dir")
#   CppInterOp::DetectSystemCompilerIncludePaths()
#                                              popen("LC_ALL=C c++ -xc++ -E -v …")
#     — lib/CppInterOp/CppInterOp.cpp @ v1.9.0, lines 3572 and 3589
#
# The sandbox is --unshare-all with PATH=/nonexistent and no compiler, so both
# return nothing and clang-repl is left with no builtin headers and no C++
# standard library. xeus-cpp's own createInterpreter() skips its resource-dir
# detection if and only if the literal string "-resource-dir" appears in argv
# (src/xinterpreter.cpp @ 0.10.0, lines 35-48), and passes every other argv
# element through to Clang unparsed (line 246 — everything but `-f <file>`,
# which libxeus strips first). So the configuration has to be *given*, and it
# has to be given as paths that exist inside the bundle.
#
# This script therefore:
#   1. finds those paths in the installed closure,
#   2. publishes them behind version-free symlinks, so no LLVM version and no
#      conda triple leaks into src/kernel-bridges.ts — the same discipline as
#      deploy/julia-runtime/launch_kernel.jl keeping the depot hash out of it,
#   3. records them in a manifest the smoke re-reads, so the argv in the
#      registry and the argv this build verified cannot drift apart,
#   4. proves, with the bundled driver and an empty environment, that a
#      #include <iostream> resolves entirely inside the bundle, and
#   5. proves the kernel binds five unix-domain sockets under transport:ipc.
set -euo pipefail

CPP_RUNTIME_ROOT="${CPP_RUNTIME_ROOT:?CPP_RUNTIME_ROOT is required}"
CPP_LLVM_MAJOR="${CPP_LLVM_MAJOR:?CPP_LLVM_MAJOR is required}"
XEUS_CPP_VERSION="${XEUS_CPP_VERSION:?XEUS_CPP_VERSION is required}"
CPPINTEROP_VERSION="${CPPINTEROP_VERSION:?CPPINTEROP_VERSION is required}"
CPP_STD="${CPP_STD:?CPP_STD is required}"

TOOLCHAIN_DIR="${CPP_RUNTIME_ROOT}/share/choreograph"
KERNEL_BIN="${CPP_RUNTIME_ROOT}/bin/xcpp"
DRIVER_BIN="${CPP_RUNTIME_ROOT}/bin/clang++"

# Shared objects the sandbox may resolve from the host bind of /usr: the C
# runtime the orchestrator's own node process already depends on, and nothing
# else. libstdc++ is deliberately NOT on this list. conda-forge builds against a
# newer libstdc++ than most hosts ship, and "the C++ kernel works on the build
# image and not on the fleet" is precisely the failure this excludes.
HOST_BASELINE_SONAMES=(
	"linux-vdso.so.1"
	"ld-linux-x86-64.so.2"
	"libc.so.6"
	"libm.so.6"
	"libdl.so.2"
	"libpthread.so.0"
	"librt.so.1"
)

is_host_baseline() {
	local soname="$1"
	for allowed in "${HOST_BASELINE_SONAMES[@]}"; do
		[ "${soname}" = "${allowed}" ] && return 0
	done
	return 1
}

fail() {
	echo "ERROR: $*" >&2
	exit 1
}

echo "==> Locating the pieces xeus-cpp cannot find for itself"

RESOURCE_DIR="${CPP_RUNTIME_ROOT}/lib/clang/${CPP_LLVM_MAJOR}"
[ -f "${RESOURCE_DIR}/include/stddef.h" ] || fail \
	"the clang resource directory is missing its builtin headers: ${RESOURCE_DIR}/include/stddef.h
       conda-forge ships lib/clang/${CPP_LLVM_MAJOR}/* in the clang-${CPP_LLVM_MAJOR}
       output (clangdev-feedstock recipe.yaml). If this path is absent, that
       package did not land — check the lock, not this script."
echo "    resource dir:   ${RESOURCE_DIR}"

# conda's cross-file layout: <prefix>/<triple>/sysroot holds the glibc headers,
# and the compiler support files live under <prefix>/lib/gcc/<triple>/<version>.
SYSROOT=""
for candidate in "${CPP_RUNTIME_ROOT}"/*-conda-linux-gnu/sysroot; do
	[ -f "${candidate}/usr/include/stdio.h" ] || continue
	SYSROOT="${candidate}"
done
[ -n "${SYSROOT}" ] || fail \
	"no conda sysroot with glibc headers under ${CPP_RUNTIME_ROOT}/*-conda-linux-gnu/sysroot
       sysroot_linux-64 provides it. Without it clang-repl cannot open stdio.h
       and every #include <iostream> fails inside the sandbox."
echo "    sysroot:        ${SYSROOT}"

# --gcc-toolchain points at the prefix, and clang walks lib/gcc/<triple>/<ver>
# from there. Assert the layout rather than trusting it: a missing crtbegin.o is
# how "clang found no GCC installation" presents, three layers down.
GCC_TOOLCHAIN="${CPP_RUNTIME_ROOT}"
GCC_INSTALL="$(find "${CPP_RUNTIME_ROOT}/lib/gcc" -mindepth 2 -maxdepth 2 -type d -print -quit 2>/dev/null || true)"
[ -n "${GCC_INSTALL}" ] || fail \
	"no GCC installation under ${CPP_RUNTIME_ROOT}/lib/gcc/<triple>/<version>
       gxx_impl_linux-64 provides it, and clang's --gcc-toolchain search starts
       there. Without it the C++ standard library headers are unreachable."
echo "    gcc toolchain:  ${GCC_TOOLCHAIN} (installation: ${GCC_INSTALL})"

CXX_INCLUDE="$(find "${CPP_RUNTIME_ROOT}" -maxdepth 4 -type f -name 'iostream' -path '*/include/c++/*' -print -quit || true)"
[ -n "${CXX_INCLUDE}" ] || fail \
	"no libstdc++ <iostream> anywhere under ${CPP_RUNTIME_ROOT}"
echo "    libstdc++:      $(dirname "${CXX_INCLUDE}")"

echo "==> Publishing them behind version-free names"
mkdir -p "${TOOLCHAIN_DIR}"
# Relative link targets: the bundle is mounted at the path it was built at, but
# a relative link also survives being inspected from outside that mount, which
# is exactly what deploy/smoke-cpp-bundles.mjs does.
ln -sfn "../../lib/clang/${CPP_LLVM_MAJOR}" "${TOOLCHAIN_DIR}/resource-dir"
ln -sfn "../../$(basename "$(dirname "${SYSROOT}")")/sysroot" "${TOOLCHAIN_DIR}/sysroot"
ln -sfn "../.." "${TOOLCHAIN_DIR}/gcc-toolchain"
for link in resource-dir sysroot gcc-toolchain; do
	[ -e "${TOOLCHAIN_DIR}/${link}" ] || fail "the ${link} symlink does not resolve"
	echo "    ${TOOLCHAIN_DIR}/${link} -> $(readlink "${TOOLCHAIN_DIR}/${link}")"
done

# The exact flags src/kernel-bridges.ts must pass, written where the smoke can
# read them. A registry entry and a payload that disagree about the toolchain
# produce a kernel that starts and then cannot compile #include <iostream> —
# a failure that looks like a user error and is not one.
CLANG_ARGS=(
	"-std=${CPP_STD}"
	"-resource-dir"
	"${TOOLCHAIN_DIR}/resource-dir"
	"--gcc-toolchain=${TOOLCHAIN_DIR}/gcc-toolchain"
	"--sysroot=${TOOLCHAIN_DIR}/sysroot"
	"-I"
	"${CPP_RUNTIME_ROOT}/include"
)

echo "==> Writing the toolchain manifest"
{
	printf '{\n'
	printf '  "schema": "choreograph.cpp-runtime/1",\n'
	printf '  "xeus_cpp_version": "%s",\n' "${XEUS_CPP_VERSION}"
	printf '  "cppinterop_version": "%s",\n' "${CPPINTEROP_VERSION}"
	printf '  "llvm_major": "%s",\n' "${CPP_LLVM_MAJOR}"
	printf '  "std": "%s",\n' "${CPP_STD}"
	printf '  "clang_args": [\n'
	for index in "${!CLANG_ARGS[@]}"; do
		if [ "${index}" -eq $((${#CLANG_ARGS[@]} - 1)) ]; then
			printf '    "%s"\n' "${CLANG_ARGS[$index]}"
		else
			printf '    "%s",\n' "${CLANG_ARGS[$index]}"
		fi
	done
	printf '  ]\n'
	printf '}\n'
} > "${TOOLCHAIN_DIR}/toolchain.json"
cat "${TOOLCHAIN_DIR}/toolchain.json"

echo "==> Proving the include closure is inside the bundle"
# `env -i` is the point. It removes PATH, LD_LIBRARY_PATH, CONDA_PREFIX and
# every activation variable, which is the environment the sandbox actually
# provides — and it is the difference between proving the bundle and proving
# the build image, which still has Debian's own g++ and its headers.
[ -x "${DRIVER_BIN}" ] || fail "the bundled clang driver is missing: ${DRIVER_BIN}"
mkdir -p /tmp/cpp-probe
cat > /tmp/cpp-probe/probe.cpp <<'PROBE'
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

int main()
{
    std::vector<std::string> lines;
    std::ifstream input("/proc/self/cmdline");
    std::cout << 6 * 7 << std::endl;
    return lines.empty() && input.good() ? 0 : 0;
}
PROBE
# -H names every header opened, one per line, prefixed by depth dots.
env -i "${DRIVER_BIN}" -x c++ "${CLANG_ARGS[@]}" -fsyntax-only -H \
	/tmp/cpp-probe/probe.cpp 2> /tmp/cpp-probe/headers.txt || {
	echo "--- clang search paths ---" >&2
	env -i "${DRIVER_BIN}" -x c++ "${CLANG_ARGS[@]}" -fsyntax-only -v \
		/tmp/cpp-probe/probe.cpp >&2 2>&1 || true
	echo "--- headers opened before the failure ---" >&2
	cat /tmp/cpp-probe/headers.txt >&2 || true
	fail "the bundled toolchain cannot compile #include <iostream> with the argv the registry passes"
}
ESCAPED=0
while IFS= read -r line; do
	case "${line}" in
		.*) ;;
		*) continue ;;
	esac
	header="${line#"${line%%[! .]*}"}"
	case "${header}" in
		"${CPP_RUNTIME_ROOT}"/*) ;;
		*)
			echo "ERROR: header resolved outside the bundle: ${header}" >&2
			ESCAPED=$((ESCAPED + 1))
			;;
	esac
done < /tmp/cpp-probe/headers.txt
[ "${ESCAPED}" -eq 0 ] || fail "${ESCAPED} header(s) resolved outside ${CPP_RUNTIME_ROOT}"
echo "    $(grep -c '^\.' /tmp/cpp-probe/headers.txt) headers, all inside the bundle"
rm -rf /tmp/cpp-probe

echo "==> Verifying the kernel's shared objects resolve inside the bundle"
UNRESOLVED=0
while read -r soname arrow path _address; do
	if [ "${arrow}" = "=>" ] && [ "${path}" = "not" ]; then
		echo "ERROR: xcpp cannot resolve ${soname}" >&2
		UNRESOLVED=$((UNRESOLVED + 1))
		continue
	fi
	[ "${arrow}" = "=>" ] || continue
	[ -n "${path}" ] || continue
	is_host_baseline "${soname}" && continue
	case "${path}" in
		"${CPP_RUNTIME_ROOT}"/*) ;;
		*)
			echo "ERROR: xcpp resolves ${soname} outside the bundle: ${path}" >&2
			UNRESOLVED=$((UNRESOLVED + 1))
			;;
	esac
done < <(ldd "${KERNEL_BIN}" 2>/dev/null | sed 's/^[[:space:]]*//')
[ "${UNRESOLVED}" -eq 0 ] || exit 1

echo "==> Pruning build-only state"
rm -rf \
	"${CPP_RUNTIME_ROOT}/pkgs" \
	"${CPP_RUNTIME_ROOT}/share/man" \
	"${CPP_RUNTIME_ROOT}/share/doc" \
	"${CPP_RUNTIME_ROOT}/share/gtk-doc" \
	"${CPP_RUNTIME_ROOT}/share/info"
# Top-level static archives only. lib/clang/<major>/lib holds the compiler-rt
# builtins clang-repl links into JIT'd code and must survive.
find "${CPP_RUNTIME_ROOT}/lib" -maxdepth 1 -type f -name '*.a' -delete

echo "==> Proving transport:ipc against a live kernel"
# Same shape as deploy/ocaml-runtime/build-switch.sh, and the same reason: the
# only bind that can work under --unshare-all is a unix-domain one, and the
# kernel's own opinion of its address is not evidence. xeus-zmq formats
# `transport + "://" + ip + sep + port` with sep '-' for anything that is not
# tcp (xeus-zmq src/common/xmiddleware.cpp, get_end_point) — which is the
# convention the Rust bridge waits for, so no patch is needed here. This proves
# it rather than citing it.
PROBE_PREFIX="/tmp/cpp-ipc-probe"
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
# env -i again: a kernel that only starts with conda's activation in the
# environment is not a kernel this sandbox can run.
env -i HOME=/tmp PATH=/nonexistent \
	"${KERNEL_BIN}" -f "${PROBE_CONNECTION}" "${CLANG_ARGS[@]}" &
PROBE_PID=$!
trap 'kill -9 "${PROBE_PID}" 2>/dev/null || true' EXIT
# Generous: clang-repl builds a full CompilerInstance and parses the preamble
# before xeus binds anything, and this is a cold page cache.
for _ in $(seq 1 1200); do
	READY=1
	for port in 1 2 3 4 5; do
		[ -S "${PROBE_PREFIX}-${port}" ] || READY=0
	done
	[ "${READY}" -eq 1 ] && break
	kill -0 "${PROBE_PID}" 2>/dev/null ||
		fail "the kernel exited before binding its ipc sockets"
	sleep 0.1
done
for port in 1 2 3 4 5; do
	[ -S "${PROBE_PREFIX}-${port}" ] ||
		fail "${PROBE_PREFIX}-${port} is not a unix-domain socket"
done
LISTENERS="$(awk 'NR > 1 && $4 == "0A"' /proc/net/tcp /proc/net/tcp6 | wc -l)"
if [ "${LISTENERS}" -ne 0 ]; then
	awk 'NR > 1 && $4 == "0A"' /proc/net/tcp /proc/net/tcp6 >&2
	fail "the kernel opened ${LISTENERS} TCP listeners under transport:ipc"
fi
echo "    5/5 channels bound as unix-domain sockets, 0 TCP listeners"
kill -9 "${PROBE_PID}" 2>/dev/null || true
trap - EXIT
rm -f "${PROBE_CONNECTION}" "${PROBE_PREFIX}"-[1-5]

echo "==> Baked C++ payload"
env -i "${KERNEL_BIN}" --version || true
du -sh "${CPP_RUNTIME_ROOT}/lib" "${CPP_RUNTIME_ROOT}/bin" "${CPP_RUNTIME_ROOT}"
echo "xeus-cpp ${XEUS_CPP_VERSION} | CppInterOp ${CPPINTEROP_VERSION} | LLVM ${CPP_LLVM_MAJOR} | ${CPP_STD}"
