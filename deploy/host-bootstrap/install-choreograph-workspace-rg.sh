#!/usr/bin/env bash
# Install the one workspace-shell tool AL2023 does not package. This runs as
# root during host bootstrap; bwrap's PATH deliberately reaches /usr/bin/rg.
set -euo pipefail
umask 077

readonly RG_URL="https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz"
readonly RG_ARCHIVE_SHA256="33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c"
readonly RG_MEMBER="ripgrep-15.2.0-x86_64-unknown-linux-musl/rg"
readonly RG_BINARY_SHA256="e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849"
target="${1:-/usr/bin/rg}"

fail() {
	echo "ERROR: workspace rg bootstrap: $*" >&2
	exit 1
}

sha256_file() {
	sha256sum "$1" | awk '{print $1}'
}

[ "$(id -u)" = "0" ] || fail "must run as root"
case "$target" in /usr/bin/rg|/tmp/*) ;; *) fail "target must be /usr/bin/rg" ;; esac
target_dir="$(dirname "$target")"
[ -d "$target_dir" ] || fail "target directory does not exist"

archive="$(mktemp)"
binary="$(mktemp)"
trap 'rm -f "$archive" "$binary"' EXIT
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 --output "$archive" "$RG_URL"
[ "$(sha256_file "$archive")" = "$RG_ARCHIVE_SHA256" ] || fail "archive digest mismatch"
# Do not use grep -q here: with pipefail, a real multi-member archive lets
# grep exit after the match and tar then fails on SIGPIPE, falsely reporting
# that the pinned member is absent.
tar -tzf "$archive" | grep -Fx "$RG_MEMBER" >/dev/null || fail "archive is missing pinned rg member"
tar -xzf "$archive" -O "$RG_MEMBER" > "$binary"
[ "$(sha256_file "$binary")" = "$RG_BINARY_SHA256" ] || fail "binary digest mismatch"
install -o root -g root -m 0555 "$binary" "$target"
echo "==> Installed pinned workspace rg at $target"
