#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { createHash } from "node:crypto";

const [version, releaseTarball, runtimeManifest, metadataPath, tfvarsPath, deployBucket = ""] =
	process.argv.slice(2);
if (!version || !releaseTarball || !runtimeManifest || !metadataPath || !tfvarsPath) {
	throw new Error(
		"usage: write-release-metadata.mjs <version> <release-tarball> <runtime-manifest> <metadata> <tfvars> [bucket]",
	);
}
if (!existsSync(releaseTarball)) throw new Error(`release tarball does not exist: ${releaseTarball}`);

const canonicalBundles = {
	"sophia-agent-runtime": {
		description: "Sophia agent semantic core with simple and constrained-Prime profiles",
		guestPath: "/opt/choreograph-runtime/sophia-agent",
		archiveSuffix: ".tar.gz",
	},
	"sophia-kernel-runtime": {
		description: "Sophia-owned Python kernel control and harness runtime",
		guestPath: "/opt/choreograph-runtime/sophia-kernel-runtime",
		archiveSuffix: ".tar.gz",
	},
	"jupyter-bridge": {
		description: "Sophia-owned native Rust Jupyter controller",
		guestPath: "/opt/choreograph-runtime/bridges",
		archiveSuffix: ".tar.gz",
	},
	"python-runtime": {
		description: "Pinned third-party CPython and ipykernel sandbox guest payload",
		guestPath: "/opt/runtime/python",
		archiveSuffix: ".tar.gz",
	},
	"asr-runtime": {
		description: "Pinned sandbox-only VibeASR and Whisper executable runtime",
		guestPath: "/opt/choreograph-runtime/asr",
		archiveSuffix: ".tar",
	},
	"asr-vibeasr-bitnet-model": {
		description: "Pinned Microsoft VibeASR BitNet model payload",
		guestPath: "/opt/choreograph-models/vibeasr-bitnet",
		archiveSuffix: ".tar",
	},
	"asr-whisper-small-en-model": {
		description: "Pinned whisper.cpp small.en fallback model payload",
		guestPath: "/opt/choreograph-models/whisper-small-en",
		archiveSuffix: ".tar",
	},
};

const manifest = JSON.parse(readFileSync(runtimeManifest, "utf8"));
const bundles = manifest.bundles;
const ids = bundles?.map((bundle) => bundle.id).sort();
const expected = Object.keys(canonicalBundles).sort();
if (!Array.isArray(bundles) || JSON.stringify(ids) !== JSON.stringify(expected)) {
	throw new Error(`runtime manifest is not canonical: ${JSON.stringify(ids)}`);
}
for (const bundle of bundles) {
	const canonical = canonicalBundles[bundle.id];
	if (
		bundle.description !== canonical.description ||
		!/^[a-f0-9]{64}$/.test(bundle.digest) ||
		bundle.s3_key !==
			`runtime-bundles/${bundle.id}/sha256-${bundle.digest}${canonical.archiveSuffix}` ||
		JSON.stringify(bundle.mounts) !==
			JSON.stringify([{ guest_path: canonical.guestPath, local_subpath: ".", mode: "ro" }])
	) {
		throw new Error(`runtime manifest bundle is incomplete or non-canonical: ${bundle.id}`);
	}
}

const runtimeManifestKey = `runtime-manifests/${basename(runtimeManifest)}`;
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const releaseSha256 = sha256(releaseTarball);
const runtimeManifestSha256 = sha256(runtimeManifest);
const metadata = {
	release_version: version,
	release_tarball: `deploy/${basename(releaseTarball)}`,
	release_sha256: releaseSha256,
	runtime_manifest_path: `deploy/runtime-manifests/${basename(runtimeManifest)}`,
	runtime_manifest_key: runtimeManifestKey,
	runtime_manifest_sha256: runtimeManifestSha256,
	terraform_vars_file: `deploy/${basename(tfvarsPath)}`,
};
if (deployBucket) metadata.deploy_bucket = deployBucket;

writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
writeFileSync(
	tfvarsPath,
	`${JSON.stringify(
		{
			choreograph_release_version: version,
			choreograph_release_sha256: releaseSha256,
			choreograph_runtime_manifest_key: runtimeManifestKey,
			choreograph_runtime_manifest_sha256: runtimeManifestSha256,
		},
		null,
		2,
	)}\n`,
	"utf8",
);
