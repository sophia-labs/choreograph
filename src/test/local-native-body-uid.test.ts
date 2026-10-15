/**
 * local-native bodies under a separate uid.
 *
 * The threat: a compromised body reads the orchestrator's /proc/<pid>/environ
 * (provider keys, bridge token, internal secret) or a root-only options file.
 * The root-gated cases spawn a REAL body through localNativeLaunch and read the
 * REAL /proc entry of this process (the orchestrator stand-in). A same-uid
 * control body proves the probe can see the secret when the boundary is absent,
 * so a pass cannot come from a probe that sees nothing.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type LocalNativeBodyIdentity, localNativeLaunch, resolveLocalNativeBodyIdentity } from "../spawner.js";

describe("resolveLocalNativeBodyIdentity", () => {
	it("is off when unset", () => {
		assert.equal(resolveLocalNativeBodyIdentity({}, 0), undefined);
	});
	it("parses numeric uid/gid and an absolute home", () => {
		assert.deepEqual(
			resolveLocalNativeBodyIdentity(
				{
					CHOREOGRAPH_LOCAL_NATIVE_BODY_UID: "1000",
					CHOREOGRAPH_LOCAL_NATIVE_BODY_GID: "1000",
					CHOREOGRAPH_LOCAL_NATIVE_BODY_HOME: "/tmp/body",
				},
				0,
			),
			{ uid: 1000, gid: 1000, home: "/tmp/body" },
		);
	});
	it("fails closed: non-root orchestrator, root body, bad ids, relative home", () => {
		const ok = { CHOREOGRAPH_LOCAL_NATIVE_BODY_UID: "1000", CHOREOGRAPH_LOCAL_NATIVE_BODY_GID: "1000" };
		assert.throws(() => resolveLocalNativeBodyIdentity(ok, 1000), /needs the orchestrator to run as root/);
		assert.throws(
			() => resolveLocalNativeBodyIdentity({ ...ok, CHOREOGRAPH_LOCAL_NATIVE_BODY_UID: "0" }, 0),
			/must not run as root/,
		);
		assert.throws(() => resolveLocalNativeBodyIdentity({ CHOREOGRAPH_LOCAL_NATIVE_BODY_UID: "1000" }, 0), /GID/);
		assert.throws(
			() => resolveLocalNativeBodyIdentity({ ...ok, CHOREOGRAPH_LOCAL_NATIVE_BODY_UID: "node" }, 0),
			/numeric/,
		);
		assert.throws(
			() => resolveLocalNativeBodyIdentity({ ...ok, CHOREOGRAPH_LOCAL_NATIVE_BODY_HOME: "rel/home" }, 0),
			/absolute/,
		);
	});
});

const isRootLinux = process.platform === "linux" && process.getuid?.() === 0;
const BODY: LocalNativeBodyIdentity = { uid: 1000, gid: 1000 };

const PROBE = `
import { readFileSync } from "node:fs";
const attempt = (path) => { try { return "read:" + readFileSync(path).toString("base64"); } catch (e) { return "denied:" + e.code; } };
let setuidBack = "denied";
try { process.setuid(0); setuidBack = "became-root"; } catch (e) { setuidBack = "denied:" + e.code; }
process.stdout.write(JSON.stringify({
	uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(),
	environ: attempt("/proc/" + process.env.PROBE_ORCH_PID + "/environ"),
	options: attempt(process.env.PROBE_OPTIONS_FILE),
	home: process.env.HOME,
	setuidBack,
}));
`;

async function runBody(dir: string, body: LocalNativeBodyIdentity | undefined, optionsFile: string) {
	const launch = localNativeLaunch(
		join(dir, "probe.mjs"),
		{ PROBE_ORCH_PID: String(process.pid), PROBE_OPTIONS_FILE: optionsFile },
		body,
	);
	const child = spawn(launch.command, launch.args, {
		env: launch.env,
		cwd: launch.cwd,
		stdio: ["ignore", "pipe", "pipe"],
		...(launch.uid !== undefined ? { uid: launch.uid, gid: launch.gid } : {}),
	});
	let out = "";
	let err = "";
	child.stdout.on("data", (chunk) => {
		out += chunk;
	});
	child.stderr.on("data", (chunk) => {
		err += chunk;
	});
	const code = await new Promise<number | null>((done) => child.on("close", done));
	assert.equal(code, 0, `probe body failed: ${err}`);
	return JSON.parse(out) as {
		uid: number;
		gid: number;
		groups: number[];
		environ: string;
		options: string;
		home: string;
		setuidBack: string;
	};
}

describe(
	"local-native body under a separate uid (root, Linux)",
	{ skip: !isRootLinux && "needs root on Linux" },
	() => {
		it("cannot read the orchestrator's environ or a root-only options file; a same-uid body can", async () => {
			const dir = mkdtempSync(join(tmpdir(), "body-uid-"));
			try {
				chmodSync(dir, 0o755);
				writeFileSync(join(dir, "probe.mjs"), PROBE, { mode: 0o644 });
				const optionsFile = join(dir, "options.json");
				writeFileSync(optionsFile, JSON.stringify({ openrouter_api_key: "sk-or-canary" }), { mode: 0o600 });
				const ownEnviron = readFileSync(`/proc/${process.pid}/environ`);
				assert.ok(ownEnviron.length > 0, "orchestrator environ must be non-empty for the control to mean anything");

				// Control: same uid (the prototype's shape) — the secret leaks.
				const same = await runBody(dir, undefined, optionsFile);
				assert.equal(same.uid, 0);
				assert.equal(same.environ, `read:${ownEnviron.toString("base64")}`);
				assert.match(same.options, /^read:/);

				// Separate uid — the kernel refuses both, and the body cannot climb back.
				const home = join(dir, "body-home");
				const separate = await runBody(dir, { ...BODY, home }, optionsFile);
				assert.equal(separate.uid, BODY.uid);
				assert.equal(separate.gid, BODY.gid);
				assert.ok(!separate.groups.includes(0), `body kept root's groups: ${separate.groups}`);
				assert.equal(separate.environ, "denied:EACCES");
				assert.equal(separate.options, "denied:EACCES");
				assert.match(separate.setuidBack, /^denied:EPERM$/);
				assert.equal(separate.home, home);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	},
);
