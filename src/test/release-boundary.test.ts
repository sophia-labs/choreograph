import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveBridge, resolvePythonRuntimeBridge } from "../kernel-bridges.js";
import {
	JUPYTER_BRIDGE_GUEST_PATH,
	PYTHON_RUNTIME_SANDBOX_PATH,
	SOPHIA_AGENT_RUNTIME_BUNDLE_ID,
	SOPHIA_KERNEL_RUNTIME_BUNDLE_ID,
	SOPHIA_KERNEL_RUNTIME_PYTHON_ROOT,
} from "../runtime-bundles.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(TEST_DIR, "../..");

function run(command: string, args: string[], env?: NodeJS.ProcessEnv) {
	return spawnSync(command, args, {
		cwd: REPO_ROOT,
		env: { ...process.env, ...env },
		encoding: "utf8",
	});
}

function runNode(script: string, args: string[] = []) {
	return run(process.execPath, [resolve(REPO_ROOT, script), ...args]);
}

function assertPassed(result: ReturnType<typeof run>) {
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

function assertFailed(result: ReturnType<typeof run>, pattern: RegExp) {
	assert.notEqual(result.status, 0, "command unexpectedly succeeded");
	assert.match(`${result.stdout}\n${result.stderr}`, pattern);
}

const canonicalBundles = [
	{
		id: "sophia-agent-runtime",
		description: "Sophia agent semantic core with simple and constrained-Prime profiles",
		digest: "a".repeat(64),
		guestPath: "/opt/choreograph-runtime/sophia-agent",
		archiveSuffix: ".tar.gz",
	},
	{
		id: "sophia-kernel-runtime",
		description: "Sophia-owned Python kernel control and harness runtime",
		digest: "b".repeat(64),
		guestPath: "/opt/choreograph-runtime/sophia-kernel-runtime",
		archiveSuffix: ".tar.gz",
	},
	{
		id: "jupyter-bridge",
		description: "Sophia-owned native Rust Jupyter controller",
		digest: "c".repeat(64),
		guestPath: "/opt/choreograph-runtime/bridges",
		archiveSuffix: ".tar.gz",
	},
	{
		id: "python-runtime",
		description: "Pinned third-party CPython and ipykernel sandbox guest payload",
		digest: "d".repeat(64),
		guestPath: "/opt/runtime/python",
		archiveSuffix: ".tar.gz",
	},
	{
		id: "asr-runtime",
		description: "Pinned sandbox-only VibeASR and Whisper executable runtime",
		digest: "e".repeat(64),
		guestPath: "/opt/choreograph-runtime/asr",
		archiveSuffix: ".tar",
	},
	{
		id: "asr-vibeasr-bitnet-model",
		description: "Pinned Microsoft VibeASR BitNet model payload",
		digest: "f".repeat(64),
		guestPath: "/opt/choreograph-models/vibeasr-bitnet",
		archiveSuffix: ".tar",
	},
	{
		id: "asr-whisper-small-en-model",
		description: "Pinned whisper.cpp small.en fallback model payload",
		digest: "1".repeat(64),
		guestPath: "/opt/choreograph-models/whisper-small-en",
		archiveSuffix: ".tar",
	},
];

describe("hermetic runtime release boundary", () => {
	it("delays the first Phanes health check from timer activation", () => {
		const timer = readFileSync(resolve(REPO_ROOT, "deploy/phanes-health.timer"), "utf8");
		assert.match(timer, /^OnActiveSec=2min$/m);
		assert.doesNotMatch(timer, /^OnBootSec=/m);
	});

	it("boots the Phanes domain edge with listener and effect-loop settings", () => {
		const loader = readFileSync(resolve(REPO_ROOT, "deploy/load-phanes-env.sh"), "utf8");
		const hostLoader = readFileSync(resolve(REPO_ROOT, "deploy/load-env.sh"), "utf8");
		const unit = readFileSync(resolve(REPO_ROOT, "deploy/phanes.service"), "utf8");
		assert.match(loader, /\["PHANES_ENABLED_COGS", "roles,privacy,agent"\]/);
		assert.match(loader, /"PHANES_DISCORD_READ_CHANNEL_IDS"/);
		assert.match(loader, /"PHANES_PRIVACY_HMAC_KEY"/);
		assert.match(loader, /\["PHANES_SOCIAL_GRAPH_ID", "phanes-social"\]/);
		assert.match(loader, /\["PHANES_SOURCE_GRAPH_ID", "phanes-discord-source"\]/);
		assert.match(loader, /\["PHANES_CONTROL_GRAPH_ID", "phanes-control"\]/);
		assert.doesNotMatch(loader, /PHANES_SOCIAL_GRAPH_PREFIX/);
		assert.match(loader, /const required = new Set\(\[[\s\S]*"PHANES_PRIVACY_HMAC_KEY"/);
		assert.doesNotMatch(loader, /PHANES_LISTEN_CHANNEL_IDS/);
		assert.match(loader, /"PHANES_EFFECT_POLL_SECONDS"/);
		assert.match(loader, /"PHANES_DOMAIN_TURN_RECOVERY_SECONDS"/);
		assert.match(loader, /"PHANES_CAPABILITY_TOKEN"/);
		assert.match(loader, /required\.add\("PHANES_CAPABILITY_TOKEN"\)/);
		assert.match(loader, /\["PHANES_CAPABILITY_HOST", "0\.0\.0\.0"\]/);
		assert.match(loader, /\["PHANES_CAPABILITY_PORT", "8765"\]/);
		assert.match(hostLoader, /PHANES_CAPABILITY_BASE_URL must be the fixed loopback endpoint/);
		assert.match(unit, /--publish 127\.0\.0\.1:8765:8765/);
		assert.doesNotMatch(unit, /--publish 0\.0\.0\.0:/);
	});

	it("binds Phanes triggers to the fixed Layer-0 authority and Discord adapter", () => {
		const loader = readFileSync(resolve(REPO_ROOT, "deploy/load-env.sh"), "utf8");
		assert.match(loader, /DOMAIN_AGENT_GRANT_AUTHORITY_OWNER=\$\{PHANES_GRAPH_OWNER_VALUE\}/);
		assert.match(loader, /DOMAIN_AGENT_GRANT_AUTHORITY_GRAPHS=observatory/);
		assert.match(loader, /DOMAIN_AGENT_TRUSTED_TRIGGER_ADAPTERS=discord/);
		assert.match(loader, /PHANES_GRAPH_OWNER must be a typed user principal/);
	});

	it("fails startup closed without a distinct gateway human-delegation secret", () => {
		const loader = readFileSync(resolve(REPO_ROOT, "deploy/load-env.sh"), "utf8");
		assert.match(loader, /required secret CHOREOGRAPH_GATEWAY_HUMAN_DELEGATION_SECRET missing or empty/);
		assert.match(
			loader,
			/CHOREOGRAPH_GATEWAY_HUMAN_DELEGATION_SECRET must differ from MNEMOSYNE_INTERNAL_SERVICE_SECRET/,
		);
	});

	it("uses the same native Rust controller for kernel and Python runtime modes", () => {
		const expected = (protocol: "kernel" | "runtime") => ({
			filesystems: [
				"python-runtime",
				"jupyter-bridge",
				SOPHIA_KERNEL_RUNTIME_BUNDLE_ID,
				SOPHIA_AGENT_RUNTIME_BUNDLE_ID,
			],
			command: [
				JUPYTER_BRIDGE_GUEST_PATH,
				"--protocol",
				protocol,
				"--python",
				PYTHON_RUNTIME_SANDBOX_PATH,
				"--runtime-root",
				SOPHIA_KERNEL_RUNTIME_PYTHON_ROOT,
			],
			env: {},
		});

		assert.deepEqual(resolveBridge("python3"), expected("kernel"));
		assert.deepEqual(resolvePythonRuntimeBridge(), expected("runtime"));
	});

	it("contains no Sophia-owned Python implementation or fallback", () => {
		const result = runNode("deploy/check-python-boundary.mjs");
		assertPassed(result);
		assert.match(result.stdout, /zero Sophia-owned Python/);
	});

	it("keeps the release install frozen while accepting the remote pnpm store", () => {
		const release = readFileSync(resolve(REPO_ROOT, "deploy/release.sh"), "utf8");
		assert.match(release, /pnpm install --frozen-lockfile --store-dir "\$PNPM_STORE_DIR"/);
		assert.match(release, /pnpm install --frozen-lockfile/);
		assert.doesNotMatch(release, /\|\|\s*pnpm install/);
	});

	it("deploys the host runtime from the locked pnpm graph", () => {
		const packager = readFileSync(resolve(REPO_ROOT, "deploy/package.sh"), "utf8");
		assert.match(
			packager,
			/--filter choreograph-workspace[\s\\]+deploy --prod --offline --ignore-scripts "\$PNPM_DEPLOY_TARGET"/,
		);
		assert.match(packager, /@esbuild\/linux-x64\/bin\/esbuild/);
		assert.doesNotMatch(packager, /\bnpm\b/);
		assert.doesNotMatch(packager, /\|\|\s*pnpm install/);
	});

	it("deploys the complete Sophia workspace from the locked pnpm graph", () => {
		const packager = readFileSync(resolve(REPO_ROOT, "deploy/package-runtime-bundles.sh"), "utf8");
		assert.match(packager, /pnpm install --frozen-lockfile --store-dir "\$PNPM_STORE_DIR"/);
		assert.match(
			packager,
			/--filter @earendil-works\/pi-coding-agent[\s\\]+deploy --prod --offline --ignore-scripts "\$SA_PACKAGE"/,
		);
		assert.match(packager, /normalize-sophia-agent-runtime\.mjs/);
		assert.match(packager, /build_bundle "sophia-kernel-runtime"/);
		assert.match(packager, /HYDRATED\/sophia-kernel-runtime/);
		assert.match(packager, /rlm\.mcp_base, rlm\.skill/);
		assert.doesNotMatch(packager, /\bnpm\b/);
		assert.doesNotMatch(packager, /\|\|\s*pnpm install/);
	});

	it("normalizes a portable Sophia runtime without build-host links", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "choreograph-sophia-runtime-"));
		try {
			const runtimeRoot = join(tempDir, "runtime");
			const packageRoot = join(runtimeRoot, "node_modules/@earendil-works/pi-coding-agent");
			const layouts = [
				{
					name: "@earendil-works/pi-coding-agent",
					root: packageRoot,
					required: "dist/sophia/host-worker.js",
					dependencies: {
						"@earendil-works/pi-agent-core": "file:///workspace/packages/agent",
						"@earendil-works/pi-ai": "file:///workspace/packages/ai",
						"@earendil-works/pi-tui": "file:///workspace/packages/tui",
					},
				},
				{
					name: "@earendil-works/pi-agent-core",
					root: join(packageRoot, "node_modules/@earendil-works/pi-agent-core"),
					required: "dist/index.js",
					dependencies: { "@earendil-works/pi-ai": "file:///workspace/packages/ai" },
				},
				{
					name: "@earendil-works/pi-ai",
					root: join(packageRoot, "node_modules/@earendil-works/pi-ai"),
					required: "dist/index.js",
					dependencies: {},
				},
				{
					name: "@earendil-works/pi-tui",
					root: join(packageRoot, "node_modules/@earendil-works/pi-tui"),
					required: "dist/index.js",
					dependencies: {},
				},
			];
			for (const layout of layouts) {
				mkdirSync(dirname(join(layout.root, layout.required)), { recursive: true });
				writeFileSync(
					join(layout.root, "package.json"),
					`${JSON.stringify({ name: layout.name, version: "0.7.0", dependencies: layout.dependencies })}\n`,
				);
				writeFileSync(join(layout.root, layout.required), "export {};\n");
			}
			writeFileSync(join(packageRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
			mkdirSync(join(packageRoot, "dist/prime-agent-runtime"), { recursive: true });
			writeFileSync(join(packageRoot, "dist/prime-agent-runtime/rlm.py"), "legacy = True\n");
			mkdirSync(join(packageRoot, "node_modules/.pnpm"), { recursive: true });
			writeFileSync(join(packageRoot, "node_modules/.modules.yaml"), "storeDir: /workspace/store\n");
			writeFileSync(join(packageRoot, "node_modules/.pnpm/lock.yaml"), "lockfileVersion: '9.0'\n");
			writeFileSync(join(packageRoot, "node_modules/.pnpm-workspace-state-v1.json"), "{}\n");
			const portableLink = join(packageRoot, "node_modules/portable-link");
			symlinkSync(join(packageRoot, "dist"), portableLink, "dir");

			assertPassed(runNode("deploy/normalize-sophia-agent-runtime.mjs", [runtimeRoot, packageRoot]));
			assert.equal(existsSync(join(packageRoot, "pnpm-lock.yaml")), false);
			assert.equal(existsSync(join(packageRoot, "node_modules/.modules.yaml")), false);
			assert.equal(existsSync(join(packageRoot, "node_modules/.pnpm/lock.yaml")), false);
			assert.equal(existsSync(join(packageRoot, "node_modules/.pnpm-workspace-state-v1.json")), false);
			assert.equal(existsSync(join(packageRoot, "dist/prime-agent-runtime")), false);
			const codingManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
			assert.equal(codingManifest.dependencies["@earendil-works/pi-agent-core"], "^0.7.0");
			assert.equal(codingManifest.dependencies["@earendil-works/pi-ai"], "^0.7.0");
			assert.equal(codingManifest.dependencies["@earendil-works/pi-tui"], "^0.7.0");

			symlinkSync(tempDir, join(packageRoot, "escape"), "dir");
			assertFailed(
				runNode("deploy/normalize-sophia-agent-runtime.mjs", [runtimeRoot, packageRoot]),
				/escapes its bundle/,
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("separates musl native compilation from the final static Rust link", () => {
		const packager = readFileSync(resolve(REPO_ROOT, "deploy/package-runtime-bundles.sh"), "utf8");
		assert.match(packager, /CC_x86_64_unknown_linux_musl=.*musl-gcc/);
		assert.match(packager, /CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=.*rust-lld/);
		assert.match(packager, /target-feature=\+crt-static/);
		assert.match(packager, /readelf --program-headers/);
		assert.match(packager, /BRIDGE_PROGRAM_HEADERS.*INTERP/s);
	});

	it("writes a complete canonical manifest and exact digest-pinned Terraform handoff", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "choreograph-release-boundary-"));
		try {
			const manifestPath = join(tempDir, "runtime-bundles-test.json");
			const manifestArgs = canonicalBundles.flatMap((bundle) => [
				bundle.id,
				bundle.digest,
				`runtime-bundles/${bundle.id}/sha256-${bundle.digest}${bundle.archiveSuffix}`,
				bundle.guestPath,
			]);
			assertPassed(runNode("deploy/write-runtime-manifest.mjs", [manifestPath, ...manifestArgs]));

			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			assert.deepEqual(
				manifest.bundles.map((bundle: { id: string; description: string }) => ({
					id: bundle.id,
					description: bundle.description,
				})),
				canonicalBundles.map(({ id, description }) => ({ id, description })),
			);
			assertPassed(runNode("deploy/check-python-boundary.mjs", [manifestPath]));

			const releaseTarball = join(tempDir, "choreograph-test.tar.gz");
			const metadataPath = join(tempDir, "release-metadata-test.json");
			const tfvarsPath = join(tempDir, "release-test.auto.tfvars.json");
			writeFileSync(releaseTarball, "release artifact bytes", "utf8");
			assertPassed(
				runNode("deploy/write-release-metadata.mjs", [
					"test",
					releaseTarball,
					manifestPath,
					metadataPath,
					tfvarsPath,
					"test-bucket",
				]),
			);

			const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
			const releaseSha256 = sha256(releaseTarball);
			const manifestSha256 = sha256(manifestPath);
			const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
			assert.equal(metadata.release_sha256, releaseSha256);
			assert.equal(metadata.runtime_manifest_sha256, manifestSha256);
			assert.equal(metadata.deploy_bucket, "test-bucket");

			const tfvars = JSON.parse(readFileSync(tfvarsPath, "utf8"));
			assert.deepEqual(Object.keys(tfvars).sort(), [
				"choreograph_release_sha256",
				"choreograph_release_version",
				"choreograph_runtime_manifest_key",
				"choreograph_runtime_manifest_sha256",
			]);
			assert.deepEqual(tfvars, {
				choreograph_release_version: "test",
				choreograph_release_sha256: releaseSha256,
				choreograph_runtime_manifest_key: "runtime-manifests/runtime-bundles-test.json",
				choreograph_runtime_manifest_sha256: manifestSha256,
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects incomplete manifests and every pre-gate upload escape hatch", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "choreograph-release-reject-"));
		try {
			const incompleteManifest = join(tempDir, "incomplete.json");
			const releaseTarball = join(tempDir, "release.tar.gz");
			writeFileSync(incompleteManifest, JSON.stringify({ bundles: [] }), "utf8");
			writeFileSync(releaseTarball, "release", "utf8");
			assertFailed(runNode("deploy/check-python-boundary.mjs", [incompleteManifest]), /exact canonical bundle set/);
			assertFailed(
				runNode("deploy/write-release-metadata.mjs", [
					"test",
					releaseTarball,
					incompleteManifest,
					join(tempDir, "metadata.json"),
					join(tempDir, "tfvars.json"),
				]),
				/not canonical/,
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}

		assertFailed(run("/bin/bash", ["deploy/package.sh", "test", "--upload"]), /does not upload/);
		assertFailed(run("/bin/bash", ["deploy/package-runtime-bundles.sh", "test", "--upload"]), /does not upload/);
		assertFailed(
			run("/usr/bin/env", ["-u", "HOME", "/bin/bash", "deploy/package-runtime-bundles.sh", "test", "--upload"]),
			/does not upload/,
		);
		assertFailed(
			run("/bin/bash", ["deploy/package-runtime-bundles.sh", "test"], {
				SKIP_PYTHON_RUNTIME_BUNDLE: "1",
			}),
			/removed because it produced incomplete canonical manifests/,
		);
		assertFailed(run("/bin/bash", ["deploy/release.sh", "test", "--not-a-mode"]), /unsupported release mode/);
		assertFailed(
			run("/bin/bash", ["deploy/release.sh", "test", "--upload"], {
				CHOREOGRAPH_SOIL_BINARY: "",
				CHOREOGRAPH_REQUIRE_SOIL_BINARY: "0",
			}),
			/Cloud-2 release upload requires CHOREOGRAPH_SOIL_BINARY/,
		);
	});
});
