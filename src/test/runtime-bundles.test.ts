import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	digestSophiaAgentSourceTree,
	JUPYTER_BRIDGE_GUEST_ROOT,
	listRuntimeBundles,
	PYTHON_RUNTIME_GUEST_ROOT,
	resolveRuntimeBundleDescriptor,
	resolveRuntimeBundleMounts,
	SOPHIA_AGENT_PACKAGE_ROOT,
	SOPHIA_AGENT_PYTHONPATH,
	SOPHIA_AGENT_RUNTIME_GUEST_ROOT,
	SOPHIA_KERNEL_RUNTIME_GUEST_ROOT,
} from "../runtime-bundles.js";
import { createRuntimeBundleFixture } from "./runtime-bundle-fixture.js";

describe("runtime bundles", () => {
	it("loads runtime bundle ids from the configured manifest", () => {
		const fixture = createRuntimeBundleFixture();
		const restore = fixture.apply();
		try {
			const ids = listRuntimeBundles().map((bundle) => bundle.id);
			assert.deepEqual(ids.sort(), [
				"cpp-runtime",
				"julia-runtime",
				"jupyter-bridge",
				"ocaml-runtime",
				"python-runtime",
				"sophia-agent-runtime",
				"sophia-kernel-runtime",
			]);
		} finally {
			restore();
			fixture.cleanup();
		}
	});

	it("resolves host-backed development mounts from the runtime bundle manifest", () => {
		const fixture = createRuntimeBundleFixture();
		const restore = fixture.apply();
		try {
			assert.deepEqual(resolveRuntimeBundleMounts("sophia-agent-runtime"), [
				{
					hostPath: fixture.workspaceRoot,
					guestPath: SOPHIA_AGENT_RUNTIME_GUEST_ROOT,
					mode: "ro",
				},
			]);
		} finally {
			restore();
			fixture.cleanup();
		}
	});

	it("resolves the python and bridge guest roots", () => {
		const fixture = createRuntimeBundleFixture();
		const restore = fixture.apply();
		try {
			const pythonMount = resolveRuntimeBundleMounts("python-runtime");
			const bridgeMount = resolveRuntimeBundleMounts("jupyter-bridge");
			const kernelRuntimeMount = resolveRuntimeBundleMounts("sophia-kernel-runtime");
			assert.equal(pythonMount[0]?.guestPath, PYTHON_RUNTIME_GUEST_ROOT);
			assert.equal(bridgeMount[0]?.guestPath, JUPYTER_BRIDGE_GUEST_ROOT);
			assert.equal(kernelRuntimeMount[0]?.guestPath, SOPHIA_KERNEL_RUNTIME_GUEST_ROOT);
			assert.equal(kernelRuntimeMount[0]?.mode, "ro");
		} finally {
			restore();
			fixture.cleanup();
		}
	});

	it("points Python at Prime's runtime and bundled Garden façade", () => {
		assert.deepEqual(SOPHIA_AGENT_PYTHONPATH.split(":"), [
			`${SOPHIA_AGENT_PACKAGE_ROOT}/dist/prime-agent-runtime/src`,
			`${SOPHIA_AGENT_PACKAGE_ROOT}/dist/skills/garden/src`,
		]);
	});

	it("attests an explicit Sophia source mount and rejects stale manifest bytes", () => {
		const root = mkdtempSync(join(tmpdir(), "sophia-source-attestation-"));
		const entrypoint = join(root, "packages", "coding-agent", "src", "sophia", "host-worker.ts");
		const manifest = join(root, "runtime-bundles.json");
		mkdirSync(join(root, "packages", "coding-agent", "src", "sophia"), { recursive: true });
		for (const file of [
			"package.json",
			"pnpm-lock.yaml",
			"pnpm-workspace.yaml",
			"tsconfig.json",
			"tsconfig.base.json",
		]) {
			writeFileSync(join(root, file), "{}\n");
		}
		mkdirSync(join(root, "prime-agent-runtime", ".venv", "bin"), { recursive: true });
		writeFileSync(join(root, "prime-agent-runtime", ".venv", "bin", "python"), "generated environment\n");
		writeFileSync(entrypoint, "export const runtime = 1;\n");
		const digest = digestSophiaAgentSourceTree(entrypoint);
		writeFileSync(join(root, "prime-agent-runtime", ".venv", "bin", "python"), "different local environment\n");
		assert.equal(
			digestSophiaAgentSourceTree(entrypoint),
			digest,
			"generated virtualenv bytes are not runtime source",
		);
		writeFileSync(
			manifest,
			JSON.stringify({
				bundles: [
					{
						id: "sophia-agent-runtime",
						digest: digest.slice("sha256:".length),
						mounts: [{ guest_path: SOPHIA_AGENT_RUNTIME_GUEST_ROOT, host_path: root, mode: "ro" }],
					},
				],
			}),
		);
		const previous = process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST;
		process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST = manifest;
		try {
			assert.equal(resolveRuntimeBundleDescriptor("sophia-agent-runtime").digest, digest.slice(7));
			writeFileSync(entrypoint, "export const runtime = 2;\n");
			assert.throws(() => resolveRuntimeBundleDescriptor("sophia-agent-runtime"), /does not attest/);
		} finally {
			if (previous === undefined) delete process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST;
			else process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST = previous;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
