#!/usr/bin/env bash
# Bake the read-only Julia depot the sandbox mounts.
#
# This runs at IMAGE BUILD time, where the network exists. The bwrap sandbox is
# --unshare-all, so every package resolution AND every precompile cache has to
# already be here — a cold kernel inside the sandbox may only read.
#
# Scope cut, deliberate: IJulia only. No SciML, no DataFrames, no Plots. The
# proof under test is the kernel protocol, not the ecosystem; adding scientific
# stacks multiplies the depot size and the precompile time without touching a
# single line of the transport being proven.
set -euo pipefail

JULIA_RUNTIME_ROOT="${JULIA_RUNTIME_ROOT:?JULIA_RUNTIME_ROOT is required}"
IJULIA_VERSION="${IJULIA_VERSION:?IJULIA_VERSION is required}"

JULIA_BIN="${JULIA_RUNTIME_ROOT}/bin/julia"
DEPOT="${JULIA_RUNTIME_ROOT}/depot"
MINOR="$("${JULIA_BIN}" --startup-file=no -e 'print("v$(VERSION.major).$(VERSION.minor)")')"
PROJECT="${DEPOT}/environments/${MINOR}"

# Only the baked depot exists at build time; at runtime a tmpfs depot is
# stacked in front of it. Julia searches every DEPOT_PATH entry for caches and
# artifacts, so build-time-single and runtime-stacked resolve to the same files.
export JULIA_DEPOT_PATH="${DEPOT}"
# The bridge launches the kernel directly, so a Jupyter kernelspec would be a
# file nobody reads — and installkernel() writes it outside the depot.
export IJULIA_NODEFAULTKERNEL=1

echo "==> Installing IJulia ${IJULIA_VERSION} into ${DEPOT}"
"${JULIA_BIN}" --startup-file=no -e "
using Pkg
# A VersionNumber (not a String) is an exact pin — a String would be read as a
# caret range and let the depot drift on rebuild.
Pkg.add(Pkg.PackageSpec(name=\"IJulia\", version=v\"${IJULIA_VERSION}\"))
Pkg.pin(\"IJulia\")
"

echo "==> Precompiling with the exact flags the kernel is launched with"
# Cache validity is checked against the build flags recorded in the .ji, so the
# precompile has to be driven through the same argv the registry entry uses.
"${JULIA_BIN}" -i --color=yes --startup-file=no --history-file=no \
	--project="${PROJECT}" -e 'using Pkg; Pkg.precompile()' < /dev/null

# Registry and git clones only exist to resolve versions. Nothing at runtime may
# reach the network, so shipping them would be dead weight in the bundle.
rm -rf "${DEPOT}/registries" "${DEPOT}/clones" "${DEPOT}/logs"

echo "==> Verifying the baked depot"
# ZMQ is IJulia's dependency, not the project's, so it is reachable through
# IJulia's namespace rather than as a top-level import.
"${JULIA_BIN}" -i --color=yes --startup-file=no --history-file=no \
	--project="${PROJECT}" -e "
import IJulia
isdefined(IJulia, :run_kernel) || error(\"IJulia.run_kernel is missing\")
isdefined(IJulia, :ZMQ) || error(\"IJulia did not load ZMQ\")
string(pkgversion(IJulia)) == \"${IJULIA_VERSION}\" ||
	error(\"IJulia version drift: \$(pkgversion(IJulia))\")
println(\"julia \", VERSION, \" | IJulia \", pkgversion(IJulia), \" | ZMQ \", pkgversion(IJulia.ZMQ))
println(\"depot project: \", Base.active_project())
" < /dev/null

# A second load must not write anything: if the caches were not usable read-only
# the sandbox would silently recompile on every cold kernel.
BEFORE="$(find "${DEPOT}/compiled" -type f -printf '%p %s\n' | sort | sha256sum)"
"${JULIA_BIN}" -i --color=yes --startup-file=no --history-file=no \
	--project="${PROJECT}" -e 'import IJulia' < /dev/null
AFTER="$(find "${DEPOT}/compiled" -type f -printf '%p %s\n' | sort | sha256sum)"
if [ "${BEFORE}" != "${AFTER}" ]; then
	echo "ERROR: importing IJulia still writes precompile caches; the sandbox would recompile cold" >&2
	exit 1
fi

echo "==> Baked Julia payload sizes"
du -sh "${DEPOT}/compiled" "${DEPOT}/packages" "${DEPOT}/artifacts" "${DEPOT}" "${JULIA_RUNTIME_ROOT}"
