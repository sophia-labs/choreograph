#!/usr/bin/env bash
# Hydrate one immutable, local-only Git source closure before Choreograph
# starts. Arguments are supplied only by Terraform userdata:
#   <bucket> <manifest-key> <manifest-sha256> <artifact-root> <static-env-file>
set -euo pipefail
umask 077

[ "$#" -eq 5 ] || { echo "workspace-source bootstrap requires five arguments" >&2; exit 2; }
bucket="$1"
manifest_key="$2"
manifest_sha256="$3"
artifact_root="$4"
static_env_file="$5"
# This is the service group declared by the Cloud-2 systemd unit.  An
# explicitly supplied value is useful for an isolated root/offline test, but
# production deliberately defaults to the unit's fixed group.
source_group="${CHOREOGRAPH_WORKSPACE_SOURCE_GROUP:-choreograph}"

fail() {
	echo "ERROR: workspace-source bootstrap: $*" >&2
	exit 1
}

sha256_file() {
	node --input-type=module - "$1" <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
process.stdout.write(createHash("sha256").update(readFileSync(process.argv[2])).digest("hex"));
NODE
}

require_safe_directory() {
	local path="$1"
	[ ! -L "$path" ] || fail "refusing symlinked directory: $path"
	if [ -e "$path" ]; then
		[ -d "$path" ] || fail "expected directory: $path"
	else
		mkdir "$path" || fail "could not create directory: $path"
	fi
	[ ! -L "$path" ] && [ -d "$path" ] || fail "unsafe directory: $path"
	chown "root:$source_group" "$path"
	chmod 0750 "$path"
}

require_safe_regular_target() {
	local path="$1"
	[ ! -L "$path" ] || fail "refusing symlinked file: $path"
	if [ -e "$path" ]; then
		[ -f "$path" ] || fail "expected regular file: $path"
	fi
}

assert_safe_regular_tree() {
	local path="$1"
	[ ! -L "$path" ] && [ -d "$path" ] || fail "unsafe source repository path: $path"
	if find -P "$path" -type l -print -quit | grep -q .; then
		fail "source repository contains a symlink: $path"
	fi
	if find -P "$path" ! -type d ! -type f -print -quit | grep -q .; then
		fail "source repository contains a special entry: $path"
	fi
}

harden_source_repository() {
	local path="$1"
	assert_safe_regular_tree "$path"
	# Do not recurse through links or invoke any Git mutator here.  This changes
	# only host ownership/mode metadata; the hydrated object bytes and refs stay
	# exactly as the verified bundle created them.
	find -P "$path" -type d -exec chown "root:$source_group" {} +
	find -P "$path" -type d -exec chmod 0750 {} +
	find -P "$path" -type f -exec chown "root:$source_group" {} +
	find -P "$path" -type f -exec chmod 0640 {} +
}

source_git() {
	local path="$1"
	shift
	# Git's ownership guard is deliberately satisfied only for this one,
	# canonical immutable repository and only for this invocation.  Do not add a
	# global/system safe.directory entry: that would widen trust beyond the
	# verified source closure and leak into ordinary destination repositories.
	git -c "safe.directory=$path" -C "$path" "$@"
}

[ "$(id -u)" = "0" ] || fail "must run as root"
case "$source_group" in [a-z_][a-z0-9_-]* ) ;; *) fail "invalid workspace source group" ;; esac
[ "${#source_group}" -le 32 ] || fail "invalid workspace source group"
command -v getent >/dev/null 2>&1 || fail "getent is required to validate workspace source group"
getent group "$source_group" >/dev/null 2>&1 || fail "workspace source group does not exist: $source_group"
case "$bucket" in *[!a-z0-9.-]*|"") fail "invalid S3 bucket name" ;; esac
case "$manifest_key" in workspace-source-artifacts/sha256-[0-9a-f][0-9a-f]*/manifest.json) ;; *) fail "invalid manifest key" ;; esac
case "$manifest_sha256" in
	????????????????????????????????????????????????????????????????) ;;
	*) fail "manifest digest must be 64 lowercase hexadecimal characters" ;;
esac
case "$manifest_sha256" in *[!0-9a-f]*) fail "manifest digest must be lowercase hexadecimal" ;; esac
case "$artifact_root" in /*) ;; *) fail "artifact root must be absolute" ;; esac
case "$static_env_file" in /*) ;; *) fail "static environment file must be absolute" ;; esac
require_safe_regular_target "$static_env_file"

manifest_prefix="${manifest_key%/manifest.json}"
expected_prefix="workspace-source-artifacts/sha256-$manifest_sha256"
[ "$manifest_prefix" = "$expected_prefix" ] || fail "manifest key must be addressed by its exact digest"
artifact_dir="$artifact_root/sha256-$manifest_sha256"
manifest_path="$artifact_dir/manifest.json"
bundle_dir="$artifact_dir/bundles"
sources_root="$artifact_dir/repos"
metadata_tsv="$artifact_dir/repositories.tsv"

[ ! -L "$artifact_root" ] || fail "refusing symlinked artifact root"
if [ ! -e "$artifact_root" ]; then
	mkdir -p "$artifact_root" || fail "could not create artifact root"
fi
require_safe_directory "$artifact_root"
require_safe_directory "$artifact_dir"
require_safe_directory "$bundle_dir"
require_safe_directory "$sources_root"
require_safe_regular_target "$manifest_path"
require_safe_regular_target "$metadata_tsv"

manifest_staging="$(mktemp "$artifact_dir/.manifest.XXXXXX")"
trap 'rm -f "$manifest_staging"' EXIT
aws s3 cp "s3://$bucket/$manifest_key" "$manifest_staging" --only-show-errors
[ "$(sha256_file "$manifest_staging")" = "$manifest_sha256" ] || fail "manifest digest mismatch"
mv "$manifest_staging" "$manifest_path"
trap - EXIT
chown "root:$source_group" "$manifest_path"
chmod 0640 "$manifest_path"

node --input-type=module - "$manifest_path" "$metadata_tsv" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const expectedNames = ["garden", "platform-next", "prime-agent", "shrubbery", "sophia", "vehicle", "choreograph"].sort();
const [manifestPath, outputPath] = process.argv.slice(2);
const fail = (message) => { throw new Error("workspace-source manifest: " + message); };
let manifest;
try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { fail("is not valid JSON"); }
if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
    Object.keys(manifest).sort().join(",") !== "repositories,schema" ||
    manifest.schema !== "sophia.workspace-source-artifact.v1" ||
    !Array.isArray(manifest.repositories)) fail("does not match v1");
const names = manifest.repositories.map((repository) => repository?.name);
if (JSON.stringify(names) !== JSON.stringify(expectedNames)) fail("must contain the exact sorted seven-repository set");
const rows = manifest.repositories.map((repository) => {
  if (!repository || typeof repository !== "object" || Array.isArray(repository) ||
      Object.keys(repository).sort().join(",") !== "bundle,excludedSubmodules,name,objectFormat,refs,revision") fail("repository has invalid fields");
  const { name, objectFormat, revision, refs, excludedSubmodules, bundle } = repository;
  const oidLength = objectFormat === "sha1" ? 40 : objectFormat === "sha256" ? 64 : 0;
  if (!expectedNames.includes(name) || oidLength === 0 || typeof revision !== "string" ||
      !new RegExp("^[0-9a-f]{" + oidLength + "}$").test(revision)) fail(name + ": invalid source revision");
  if (!Array.isArray(refs) || refs.length === 0) fail(name + ": missing bundled refs");
  let previous = "";
  for (const ref of refs) {
    if (!ref || typeof ref !== "object" || Array.isArray(ref) || Object.keys(ref).sort().join(",") !== "name,oid" ||
        typeof ref.name !== "string" || typeof ref.oid !== "string" ||
        !new RegExp("^[0-9a-f]{" + oidLength + "}$").test(ref.oid) ||
        !/^refs\/(heads|tags|remotes)\/[A-Za-z0-9._/-]+$/.test(ref.name) || ref.name <= previous) fail(name + ": invalid bundled ref");
    previous = ref.name;
  }
  if (!Array.isArray(excludedSubmodules)) fail(name + ": invalid excluded submodules");
  previous = "";
  for (const submodule of excludedSubmodules) {
    if (!submodule || typeof submodule !== "object" || Array.isArray(submodule) ||
        Object.keys(submodule).sort().join(",") !== "path,revision" ||
        typeof submodule.path !== "string" || typeof submodule.revision !== "string" ||
        !new RegExp("^[0-9a-f]{40}(?:[0-9a-f]{24})?$").test(submodule.revision) ||
        submodule.path.startsWith("/") || submodule.path.includes("\\") ||
        submodule.path.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
        submodule.path <= previous) fail(name + ": invalid excluded submodule");
    previous = submodule.path;
  }
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle) ||
      Object.keys(bundle).sort().join(",") !== "bytes,key,sha256" ||
      bundle.key !== "bundles/" + name + ".bundle" || !/^[0-9a-f]{64}$/.test(bundle.sha256) ||
      !Number.isSafeInteger(bundle.bytes) || bundle.bytes <= 0) fail(name + ": invalid bundle descriptor");
  return [name, revision, bundle.key, bundle.sha256, String(bundle.bytes),
    Buffer.from(JSON.stringify(excludedSubmodules), "utf8").toString("base64")].join("\t");
});
writeFileSync(outputPath, rows.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
NODE

while IFS=$'\t' read -r name revision bundle_key bundle_sha256 bundle_bytes excluded_submodules_b64; do
	[ -n "$name" ] && [ -n "$revision" ] && [ -n "$bundle_key" ] && [ -n "$bundle_sha256" ] && [ -n "$bundle_bytes" ] && [ -n "$excluded_submodules_b64" ] \
		|| fail "malformed normalized repository descriptor"
	bundle_path="$artifact_dir/$bundle_key"
	require_safe_regular_target "$bundle_path"
	bundle_staging="$(mktemp "$bundle_dir/.$name.XXXXXX")"
	trap 'rm -f "$bundle_staging"' EXIT
	aws s3 cp "s3://$bucket/$manifest_prefix/$bundle_key" "$bundle_staging" --only-show-errors
	[ "$(sha256_file "$bundle_staging")" = "$bundle_sha256" ] || fail "$name bundle digest mismatch"
	[ "$(wc -c < "$bundle_staging" | tr -d '[:space:]')" = "$bundle_bytes" ] || fail "$name bundle byte count mismatch"
	mv "$bundle_staging" "$bundle_path"
	trap - EXIT
	chown "root:$source_group" "$bundle_path"
	chmod 0640 "$bundle_path"
	# `git bundle verify` always evaluates a bundle against a repository, even
	# when the bundle is self-contained.  Cold boot runs outside any repository,
	# so verify against a new empty bare repository rather than accidentally
	# borrowing objects from the builder's source checkout (or failing only
	# because no ambient repository exists).
	bundle_verify_staging="$(mktemp -d "$sources_root/.$name.bundle-verify.XXXXXX")"
	trap 'rm -rf "$bundle_verify_staging"' EXIT
	GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
		git init --bare --quiet "$bundle_verify_staging/repository.git" \
		|| fail "$name bundle verification repository could not be initialized"
	GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
		git --git-dir="$bundle_verify_staging/repository.git" bundle verify "$bundle_path" >/dev/null \
		|| fail "$name bundle is not Git-verifiable"
	rm -rf "$bundle_verify_staging"
	trap - EXIT

	source_path="$sources_root/$name.git"
	[ ! -L "$source_path" ] || fail "refusing symlinked $name source"
	if [ -d "$source_path" ]; then
		assert_safe_regular_tree "$source_path"
		source_path="$(cd "$source_path" && pwd -P)"
		actual="$(source_git "$source_path" rev-parse --verify "$revision^{commit}" 2>/dev/null || true)"
		[ "$actual" = "$revision" ] || fail "existing $name source does not match manifest revision"
	else
		source_staging="$(mktemp -d "$sources_root/.$name.XXXXXX")"
		trap 'rm -rf "$source_staging"' EXIT
		git clone --bare --no-local "$bundle_path" "$source_staging/repository.git" >/dev/null
		actual="$(git --git-dir="$source_staging/repository.git" rev-parse --verify "$revision^{commit}")"
		[ "$actual" = "$revision" ] || fail "$name source does not contain manifest revision"
		git --git-dir="$source_staging/repository.git" remote remove origin 2>/dev/null || true
		git --git-dir="$source_staging/repository.git" config core.hooksPath /dev/null
		git --git-dir="$source_staging/repository.git" config credential.helper ""
		mv "$source_staging/repository.git" "$source_path"
		rmdir "$source_staging"
		trap - EXIT
		source_path="$(cd "$source_path" && pwd -P)"
	fi
	harden_source_repository "$source_path"
	if grep -Eq '^\[remote([[:space:]]|\])' "$source_path/config"; then
		fail "$name source retained a remote"
	fi
	node --input-type=module - "$source_path" "$revision" "$excluded_submodules_b64" <<'NODE'
import { spawnSync } from "node:child_process";
const [gitDir, revision, encodedDeclared] = process.argv.slice(2);
const declared = JSON.parse(Buffer.from(encodedDeclared, "base64").toString("utf8"));
const result = spawnSync("git", ["-c", "safe.directory=" + gitDir, "-C", gitDir, "ls-tree", "-r", "-z", revision], { encoding: null });
if (result.status !== 0) throw new Error("could not inspect hydrated source tree");
const gitlinks = [];
for (const entry of result.stdout.toString("utf8").split("\0")) {
  if (!entry) continue;
  const tab = entry.indexOf("\t");
  const [mode, type, object] = entry.slice(0, tab).split(" ");
  if (mode === "160000") gitlinks.push({ path: entry.slice(tab + 1), revision: object, type });
}
gitlinks.sort((left, right) => left.path.localeCompare(right.path));
if (gitlinks.some((entry) => entry.type !== "commit") ||
    JSON.stringify(gitlinks.map(({ path, revision: oid }) => ({ path, revision: oid }))) !== JSON.stringify(declared)) {
  throw new Error("hydrated source gitlinks do not match manifest excluded-submodules testimony");
}
NODE
done < "$metadata_tsv"

# systemd EnvironmentFile supports single-quoted values; source paths are
# host-owned fixed coordinates, never an agent-supplied input.
repository_json="$(node --input-type=module - "$metadata_tsv" "$sources_root" <<'NODE'
import { readFileSync } from "node:fs";
const [metadataPath, sourceRoot] = process.argv.slice(2);
const repositories = readFileSync(metadataPath, "utf8").trimEnd().split("\n").map((line) => {
  const [name, revision] = line.split("\t");
  return { name, sourcePath: sourceRoot + "/" + name + ".git", revision };
});
process.stdout.write(JSON.stringify(repositories));
NODE
)"
node --input-type=module - "$static_env_file" "$repository_json" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
const [path, repositories] = process.argv.slice(2);
const existing = (() => { try { return readFileSync(path, "utf8"); } catch { return ""; } })();
const kept = existing.split("\n").filter((line) => !line.startsWith("CHOREOGRAPH_PERSONAL_WORKSPACE_REPOSITORIES_JSON="));
while (kept.length > 0 && kept.at(-1) === "") kept.pop();
kept.push("CHOREOGRAPH_PERSONAL_WORKSPACE_REPOSITORIES_JSON='" + repositories + "'");
writeFileSync(path, kept.join("\n") + "\n", { encoding: "utf8", mode: 0o600 });
NODE
chown "root:$source_group" "$static_env_file"
chmod 0640 "$static_env_file"
echo "==> Hydrated verified workspace source artifact sha256-$manifest_sha256"
