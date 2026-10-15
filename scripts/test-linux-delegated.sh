#!/usr/bin/env bash
# Run the Linux test suite as the checkout owner inside a delegated cgroup-v2
# service. The user identity matters: bubblewrap must be able to traverse the
# checkout after entering its user namespace.
set -euo pipefail

test_uid="$(id -u)"
test_gid="$(id -g)"
workdir="$(pwd)"
pnpm_bin="$(command -v pnpm)"

systemd_args=(
	--wait
	--pipe
	--collect
	--quiet
	--uid="$test_uid"
	--gid="$test_gid"
	--property=Delegate=yes
	--working-directory="$workdir"
	--setenv="HOME=$HOME"
	--setenv="PATH=$PATH"
)
if [[ -n "${PNPM_HOME:-}" ]]; then
	systemd_args+=(--setenv="PNPM_HOME=$PNPM_HOME")
fi

exec sudo systemd-run "${systemd_args[@]}" "$pnpm_bin" test:linux
