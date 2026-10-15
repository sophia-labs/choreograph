import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
	PYTHON_RUNTIME_BIN_DIR,
	PYTHON_RUNTIME_GUEST_ROOT,
	SOPHIA_AGENT_RUNTIME_GUEST_ROOT,
	SOPHIA_AGENT_SANDBOX_PATH,
} from "../runtime-bundles.js";
import { buildBwrapArgs, listTemplates, resolveTemplateFilesystemIds } from "../templates.js";
import { createRuntimeBundleFixture, type RuntimeBundleFixture } from "./runtime-bundle-fixture.js";

const DUMMY_WORKER = "/tmp/worker.mjs";

describe("templates", () => {
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

	describe("listTemplates()", () => {
		it("returns all four templates", () => {
			const templates = listTemplates();
			assert.equal(templates.length, 4);
			const ids = templates.map((t) => t.id);
			assert.ok(ids.includes("agent"));
			assert.ok(ids.includes("bare"));
			assert.ok(ids.includes("workspace"));
			assert.ok(ids.includes("python"));
		});

		it("each template has id and description", () => {
			for (const t of listTemplates()) {
				assert.ok(t.id, "template should have id");
				assert.ok(t.description, "template should have description");
			}
		});

		it("exposes default filesystem bundles for templates that need them", () => {
			const byId = new Map(listTemplates().map((template) => [template.id, template]));
			assert.deepEqual(byId.get("agent")?.default_filesystems, ["sophia-agent-runtime"]);
			assert.deepEqual(byId.get("workspace")?.default_filesystems, ["workspace"]);
			assert.deepEqual(byId.get("python")?.default_filesystems, ["python-runtime"]);
			assert.equal(byId.get("bare")?.default_filesystems, undefined);
		});
	});

	describe("resolveTemplateFilesystemIds()", () => {
		it("deduplicates template defaults and explicit bundle ids", () => {
			assert.deepEqual(resolveTemplateFilesystemIds("workspace", ["workspace", "runtime-cache"]), [
				"workspace",
				"runtime-cache",
			]);
		});
	});

	describe("buildBwrapArgs()", () => {
		it("bare template includes isolation args", () => {
			const args = buildBwrapArgs("bare", DUMMY_WORKER);
			assert.ok(args.includes("--unshare-all"), "should include --unshare-all");
			assert.ok(args.includes("--die-with-parent"), "should include --die-with-parent");
			assert.ok(args.includes("--clearenv"), "should include --clearenv");

			// --cap-drop ALL should appear as consecutive elements
			const capIdx = args.indexOf("--cap-drop");
			assert.ok(capIdx >= 0, "should include --cap-drop");
			assert.equal(args[capIdx + 1], "ALL");
		});

		it("bare template mounts system libs read-only", () => {
			const args = buildBwrapArgs("bare", DUMMY_WORKER);
			// Check for --ro-bind /usr /usr
			const roBinds = args.reduce((acc: string[][], arg, i) => {
				if (arg === "--ro-bind" && i + 2 < args.length) {
					acc.push([args[i + 1], args[i + 2]]);
				}
				return acc;
			}, []);
			assert.ok(
				roBinds.some(([src, dst]) => src === "/usr" && dst === "/usr"),
				"should ro-bind /usr",
			);
		});

		it("bare template includes worker script and entrypoint", () => {
			const args = buildBwrapArgs("bare", DUMMY_WORKER);
			assert.ok(args.includes("/sandbox/worker.mjs"), "should bind worker at /sandbox/worker.mjs");
			// Entrypoint should be after "--"
			const sepIdx = args.indexOf("--");
			assert.ok(sepIdx >= 0, "should have -- separator");
			assert.ok(args[sepIdx + 2] === "/sandbox/worker.mjs", "entrypoint should be worker.mjs");
		});

		it("workspace template includes /workspace mount", () => {
			process.env.WORKSPACE_ROOT = "/tmp/choreograph-workspace";
			try {
				const args = buildBwrapArgs("workspace", DUMMY_WORKER);
				const roBinds = args.reduce((acc: string[][], arg, i) => {
					if (arg === "--ro-bind" && i + 2 < args.length) {
						acc.push([args[i + 1], args[i + 2]]);
					}
					return acc;
				}, []);
				assert.ok(
					roBinds.some(([src, dst]) => src === "/tmp/choreograph-workspace" && dst === "/workspace"),
					"should ro-bind WORKSPACE_ROOT at /workspace",
				);
			} finally {
				delete process.env.WORKSPACE_ROOT;
			}
		});

		it("agent template mounts the bundled worker runtime and executes its guest entrypoint", () => {
			const args = buildBwrapArgs("agent", { sandboxEntrypointPath: SOPHIA_AGENT_SANDBOX_PATH });
			const roBinds = args.reduce((acc: string[][], arg, i) => {
				if (arg === "--ro-bind" && i + 2 < args.length) {
					acc.push([args[i + 1], args[i + 2]]);
				}
				return acc;
			}, []);
			assert.ok(
				roBinds.some(
					([src, dst]) => src === runtimeBundles.workspaceRoot && dst === SOPHIA_AGENT_RUNTIME_GUEST_ROOT,
				),
				"should mount the configured agent worker runtime bundle",
			);
			assert.ok(args.includes(SOPHIA_AGENT_SANDBOX_PATH), "should execute the Sophia agent entrypoint");
			assert.ok(args.includes("CHOREOGRAPH_SANDBOX"), "should set CHOREOGRAPH_SANDBOX for agent runs");
		});

		it("python template mounts the bundled python runtime and writable home", () => {
			const args = buildBwrapArgs("python", DUMMY_WORKER);
			const roBinds = args.reduce((acc: string[][], arg, i) => {
				if (arg === "--ro-bind" && i + 2 < args.length) {
					acc.push([args[i + 1], args[i + 2]]);
				}
				return acc;
			}, []);
			assert.ok(
				roBinds.some(([src, dst]) => src === runtimeBundles.pythonRuntimeRoot && dst === PYTHON_RUNTIME_GUEST_ROOT),
				"should mount the configured python runtime bundle root",
			);
			// Should have writable /home/sandbox (via --tmpfs)
			const tmpfsIdx = args.findIndex((a, i) => a === "--tmpfs" && args[i + 1] === "/home/sandbox");
			assert.ok(tmpfsIdx >= 0, "should have writable /home/sandbox");
			const pathIndices = args.reduce((acc: number[], arg, i) => {
				if (arg === "PATH" && args[i - 1] === "--setenv") {
					acc.push(i);
				}
				return acc;
			}, []);
			assert.ok(pathIndices.length > 0, "should set PATH for bundled python");
			const lastPathIdx = pathIndices[pathIndices.length - 1]!;
			assert.ok(
				args[lastPathIdx + 1]?.startsWith(`${PYTHON_RUNTIME_BIN_DIR}:`),
				"should prepend the bundled python bin directory to PATH",
			);
		});

		it("throws on unknown template", () => {
			assert.throws(() => buildBwrapArgs("nonexistent", DUMMY_WORKER), /Unknown template: nonexistent/);
		});

		it("env parameter adds --setenv args", () => {
			const args = buildBwrapArgs("bare", DUMMY_WORKER, { FOO: "bar", BAZ: "qux" });
			const fooIdx = args.indexOf("FOO");
			assert.ok(fooIdx >= 0, "should include env var name FOO");
			assert.equal(args[fooIdx - 1], "--setenv");
			assert.equal(args[fooIdx + 1], "bar");

			const bazIdx = args.indexOf("BAZ");
			assert.ok(bazIdx >= 0, "should include env var name BAZ");
			assert.equal(args[bazIdx - 1], "--setenv");
			assert.equal(args[bazIdx + 1], "qux");
		});

		it("adds exact private stage mounts without exposing arbitrary guest paths", () => {
			const args = buildBwrapArgs("bare", DUMMY_WORKER, undefined, {
				privateMounts: [
					{ hostPath: "/tmp/input", guestPath: "/stage-input", mode: "ro" },
					{ hostPath: "/tmp/output", guestPath: "/stage-output", mode: "rw" },
				],
			});
			assert.ok(
				args.some(
					(arg, index) =>
						arg === "--ro-bind" && args[index + 1] === "/tmp/input" && args[index + 2] === "/stage-input",
				),
			);
			assert.ok(
				args.some(
					(arg, index) =>
						arg === "--bind" && args[index + 1] === "/tmp/output" && args[index + 2] === "/stage-output",
				),
			);
			assert.throws(
				() =>
					buildBwrapArgs("bare", DUMMY_WORKER, undefined, {
						privateMounts: [
							{
								hostPath: "/tmp/input",
								guestPath: "/etc" as "/stage-input",
								mode: "ro",
							},
						],
					}),
				/not allowlisted/,
			);
		});

		it("allows only a writable trusted private mount at the agent workspace path", () => {
			const args = buildBwrapArgs("agent", { sandboxEntrypointPath: SOPHIA_AGENT_SANDBOX_PATH }, undefined, {
				privateMounts: [{ hostPath: "/tmp/owner-workspace", guestPath: "/workspace", mode: "rw" }],
			});
			assert.ok(
				args.some(
					(arg, index) =>
						arg === "--bind" && args[index + 1] === "/tmp/owner-workspace" && args[index + 2] === "/workspace",
				),
			);
			assert.throws(
				() =>
					buildBwrapArgs("agent", { sandboxEntrypointPath: SOPHIA_AGENT_SANDBOX_PATH }, undefined, {
						privateMounts: [{ hostPath: "/tmp/owner-workspace", guestPath: "/workspace", mode: "ro" }],
					}),
				/Personal workspace private mount must be writable/,
			);
		});

		it("mounts a private writable socket directory only at the headed Prime path", () => {
			const args = buildBwrapArgs("agent", { sandboxEntrypointPath: SOPHIA_AGENT_SANDBOX_PATH }, undefined, {
				privateMounts: [{ hostPath: "/tmp/prime-session", guestPath: "/sandbox/prime-daemon", mode: "rw" }],
			});
			assert.ok(
				args.some(
					(arg, index) =>
						arg === "--bind" &&
						args[index + 1] === "/tmp/prime-session" &&
						args[index + 2] === "/sandbox/prime-daemon",
				),
			);
			assert.throws(
				() =>
					buildBwrapArgs("agent", { sandboxEntrypointPath: SOPHIA_AGENT_SANDBOX_PATH }, undefined, {
						privateMounts: [
							{
								hostPath: "/tmp/prime-session",
								guestPath: "/sandbox/another-socket" as "/sandbox/prime-daemon",
								mode: "rw",
							},
						],
					}),
				/not allowlisted/,
			);
		});
	});
});
