import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { listFilesystems } from "../filesystems.js";
import { SOPHIA_AGENT_SANDBOX_PATH } from "../runtime-bundles.js";
import { buildBwrapArgs, resolveTemplateFilesystemIds } from "../templates.js";
import { createRuntimeBundleFixture, type RuntimeBundleFixture } from "./runtime-bundle-fixture.js";

const DUMMY_WORKER = "/tmp/worker.mjs";

describe("filesystem bundles", () => {
	let runtimeBundles: RuntimeBundleFixture;
	let restoreRuntimeEnv: (() => void) | undefined;

	before(() => {
		runtimeBundles = createRuntimeBundleFixture();
		restoreRuntimeEnv = runtimeBundles.apply();
	});

	after(() => {
		restoreRuntimeEnv?.();
		runtimeBundles.cleanup();
	});

	it("lists built-in filesystem bundles", () => {
		const ids = listFilesystems().map((bundle) => bundle.id);
		assert.ok(ids.includes("sophia-agent-runtime"));
		assert.ok(ids.includes("workspace"));
		assert.ok(ids.includes("python-runtime"));
		assert.ok(ids.includes("julia-runtime"));
		assert.ok(ids.includes("ocaml-runtime"));
		assert.ok(ids.includes("cpp-runtime"));
		assert.ok(ids.includes("sophia-kernel-runtime"));
	});

	it("merges template default filesystem bundles without duplicates", () => {
		assert.deepEqual(resolveTemplateFilesystemIds("workspace", ["workspace"]), ["workspace"]);
		assert.deepEqual(resolveTemplateFilesystemIds("python"), ["python-runtime"]);
	});

	it("loads manifest bundles and mounts them into the sandbox", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "filesystem-manifest-test-"));
		const runtimeDir = join(tempDir, "runtime-cache");
		const manifestPath = join(tempDir, "filesystems.json");
		mkdirSync(runtimeDir);
		writeFileSync(join(runtimeDir, "hello.txt"), "warm bundle");
		writeFileSync(
			manifestPath,
			JSON.stringify({
				filesystems: [
					{
						id: "runtime-cache",
						description: "Prebuilt runtime cache",
						mounts: [
							{
								host_path: "./runtime-cache",
								guest_path: "/opt/runtime-cache",
							},
						],
					},
				],
			}),
			"utf8",
		);

		process.env.CHOREOGRAPH_SANDBOX_FILESYSTEMS_MANIFEST = manifestPath;
		try {
			const listed = listFilesystems();
			assert.ok(listed.some((bundle) => bundle.id === "runtime-cache"));

			const args = buildBwrapArgs("bare", DUMMY_WORKER, undefined, {
				filesystems: ["runtime-cache"],
			});
			const roBinds = args.reduce((acc: string[][], arg, index) => {
				if (arg === "--ro-bind" && index + 2 < args.length) {
					acc.push([args[index + 1], args[index + 2]]);
				}
				return acc;
			}, []);
			assert.ok(
				roBinds.some(([src, dst]) => src === resolve(runtimeDir) && dst === "/opt/runtime-cache"),
				"should mount the manifest-defined runtime cache",
			);
		} finally {
			delete process.env.CHOREOGRAPH_SANDBOX_FILESYSTEMS_MANIFEST;
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects unknown filesystem bundle IDs", () => {
		assert.throws(
			() =>
				buildBwrapArgs("bare", DUMMY_WORKER, undefined, {
					filesystems: ["does-not-exist"],
				}),
			/Unknown filesystem bundle: does-not-exist/,
		);
	});

	it("resolves the agent runtime bundle through the configured runtime bundle manifest", () => {
		const args = buildBwrapArgs("agent", { sandboxEntrypointPath: SOPHIA_AGENT_SANDBOX_PATH });
		const roBinds = args.reduce((acc: string[][], arg, index) => {
			if (arg === "--ro-bind" && index + 2 < args.length) {
				acc.push([args[index + 1], args[index + 2]]);
			}
			return acc;
		}, []);

		assert.ok(
			roBinds.some(
				([src, dst]) => src === runtimeBundles.workspaceRoot && dst === "/opt/choreograph-runtime/sophia-agent",
			),
			"should mount the configured Sophia agent runtime bundle",
		);
	});
});
