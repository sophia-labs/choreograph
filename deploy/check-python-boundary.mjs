#!/usr/bin/env node

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const excludedDirectories = new Set([
	// Generated third-party source/model caches are verified independently by
	// their pinned commits and content digests. Walking them both mistakes
	// upstream Python for Sophia-owned control code and follows build-system
	// symlinks whose generated targets may not exist after compilation.
	".cache",
	".git",
	"node_modules",
	"target",
	"runtime-bundles",
	"runtime-manifests",
	// deploy/package-local.sh output: a copy of src/ plus installed node_modules.
	"local-package",
]);

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
const baseBundleIds = [
	"sophia-agent-runtime",
	"sophia-kernel-runtime",
	"jupyter-bridge",
	"python-runtime",
].sort();
const asrBundleIds = [
	...baseBundleIds,
	"asr-runtime",
	"asr-vibeasr-bitnet-model",
	"asr-whisper-small-en-model",
].sort();

function ownedPythonFiles(directory) {
	const found = [];
	for (const entry of readdirSync(directory)) {
		if (excludedDirectories.has(entry)) continue;
		const path = join(directory, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) found.push(...ownedPythonFiles(path));
		else if (entry.endsWith(".py") || entry.endsWith(".pyc") || entry.endsWith(".pyo")) found.push(path);
	}
	return found;
}

const kernelRuntimeRoot = resolve(repoRoot, "packages/sophia-kernel-runtime");
const sandboxGuestPython = new Set([
	resolve(repoRoot, "deploy/asr/transcribe_job.py"),
	// This evaluator is never launched in the host namespace. The Node
	// coordinator read-only binds it into a no-network bwrap guest together
	// with the candidate extension and executes it under isolated Python.
	resolve(repoRoot, "src/agent-runtime/extension-evaluator.py"),
]);
const ownedPython = ownedPythonFiles(repoRoot).filter(
	(path) =>
		!sandboxGuestPython.has(resolve(path)) && !resolve(path).startsWith(`${kernelRuntimeRoot}/`),
);
assert.deepEqual(
	ownedPython,
	[],
	`Sophia-owned host/control Python implementation is forbidden; Python is confined to declared sandbox guest payloads: ${ownedPython.join(", ")}`,
);
assert.ok(
	readFileSync(resolve(repoRoot, "deploy/asr/transcribe_job.py"), "utf8").startsWith("#!/usr/bin/env python3\n"),
	"the ASR Python guest wrapper must remain explicit and sandbox-only",
);
assert.ok(
	readFileSync(resolve(repoRoot, "src/agent-runtime/extension-evaluator.py"), "utf8").startsWith(
		'"""Trusted pure-Python ABI evaluator for Sophia Prime extension v1.\n',
	),
	"the extension Python evaluator must remain explicit and sandbox-only",
);

const worker = readFileSync(join(repoRoot, "src/worker.mjs"), "utf8");
assert.doesNotMatch(worker, /PYTHON_RUNTIME_BRIDGE/);
assert.doesNotMatch(worker, /spawn\(\s*["']python3?["']/);
assert.match(worker, /python runtime config missing bridge_command/);

const bridgeRegistry = readFileSync(join(repoRoot, "src/kernel-bridges.ts"), "utf8");
assert.doesNotMatch(bridgeRegistry, /\.py["']/);
assert.match(bridgeRegistry, /JUPYTER_BRIDGE_GUEST_PATH/);
assert.match(bridgeRegistry, /PYTHON_RUNTIME_SANDBOX_PATH/);

const devManifest = JSON.parse(readFileSync(join(repoRoot, "src/runtime-bundles.dev.json"), "utf8"));
const devBundles = new Map(devManifest.bundles.map((bundle) => [bundle.id, bundle]));
assert.equal(devBundles.get("python-runtime")?.mounts?.[0]?.host_path, "/opt/runtime/python");
assert.equal(
	devBundles.get("jupyter-bridge")?.mounts?.[0]?.host_path,
	"/opt/choreograph-runtime/bridges",
);
assert.equal(
	devBundles.get("sophia-kernel-runtime")?.mounts?.[0]?.host_path,
	"/opt/choreograph-runtime/sophia-kernel-runtime",
);

const dockerfile = readFileSync(join(repoRoot, "src/Dockerfile"), "utf8");
assert.doesNotMatch(dockerfile, /apt-get install[^\n]*python/);
assert.doesNotMatch(dockerfile, /pip3 install/);
assert.match(dockerfile, /COPY --from=python-runtime-builder \/opt\/runtime\/python/);
assert.match(dockerfile, /COPY --from=jupyter-bridge-builder/);
assert.match(dockerfile, /COPY packages\/sophia-kernel-runtime \/opt\/choreograph-runtime\/sophia-kernel-runtime/);
assert.match(dockerfile, /PYTHONPATH=\/opt\/choreograph-runtime\/sophia-kernel-runtime\/src/);

const vmProvisioner = readFileSync(join(repoRoot, "scripts/vm/provision.sh"), "utf8");
assert.doesNotMatch(vmProvisioner, /apt-get install[^\n]*python/);
assert.match(vmProvisioner, /package-runtime-bundles\.sh dev-local/);
assert.match(vmProvisioner, /hydrate-runtime-bundles\.sh/);

const manifestPath = process.argv[2];
if (manifestPath) {
	const manifest = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
	assert.ok(Array.isArray(manifest.bundles), "runtime manifest must contain a bundles array");
	const ids = manifest.bundles.map((bundle) => bundle.id).sort();
	assert.ok(
		JSON.stringify(ids) === JSON.stringify(baseBundleIds) || JSON.stringify(ids) === JSON.stringify(asrBundleIds),
		"runtime manifest must contain the exact canonical bundle set: base or base plus the complete ASR set",
	);
	for (const bundle of manifest.bundles) {
		const canonical = canonicalBundles[bundle.id];
		assert.ok(canonical, `unknown runtime bundle: ${bundle.id}`);
		assert.equal(bundle.description, canonical.description, `noncanonical description for ${bundle.id}`);
		assert.match(bundle.digest, /^[a-f0-9]{64}$/, `invalid SHA-256 digest for ${bundle.id}`);
		assert.equal(
			bundle.s3_key,
			`runtime-bundles/${bundle.id}/sha256-${bundle.digest}${canonical.archiveSuffix}`,
			`noncanonical content-addressed key for ${bundle.id}`,
		);
		assert.deepEqual(
			bundle.mounts,
			[{ guest_path: canonical.guestPath, local_subpath: ".", mode: "ro" }],
			`noncanonical mount for ${bundle.id}`,
		);
	}
}

console.log(
	"python boundary: zero Sophia-owned Python in the host/control plane; CPython/ipykernel, ASR, and extension evaluators are confined to sandbox guest payloads",
);
