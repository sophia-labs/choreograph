/**
 * The body's process entry: Choreograph starts it with the host bridge on stdin/stdout (`SOPHIA_AGENT_RUNTIME_ENTRYPOINT`
 * names this file, or the bundled `body.mjs` built from it). pi is told it is offline and never phones home; the body
 * has no network reason to.
 */

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 19)) {
	process.stderr.write(`[agent-body] needs Node.js 22.19 or newer (this is ${process.versions.node})\n`);
	process.exit(1);
}
process.env.PI_OFFLINE = "1";
process.env.PI_TELEMETRY = "0";
process.env.PI_SKIP_VERSION_CHECK = "1";

const { runBody } = await import("./worker.js");
runBody().then(
	() => {
		process.exitCode = 0;
	},
	(error: unknown) => {
		process.stderr.write(`[agent-body] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	},
);
