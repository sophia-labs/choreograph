import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { test } from "node:test";

test("rejected OTLP export cannot terminate an independent durable signal drain", async () => {
	// Reserve then close a loopback port: exercise the real SDK's rejected
	// shutdown export, without contacting any external telemetry/provider service.
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	await new Promise<void>((resolve) => server.close(() => resolve()));
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			"--input-type=module",
			"--eval",
			`
await import(${JSON.stringify(new URL("../telemetry.ts", import.meta.url).href)});
const { trace } = await import("@opentelemetry/api");
trace.getTracer("shutdown-test").startSpan("pending-export").end();
process.on("SIGTERM", () => {
  setTimeout(() => { console.log("DURABLE_DRAIN_COMPLETE"); process.exit(0); }, 300);
});
process.emit("SIGTERM");
process.emit("SIGINT");
`,
		],
		{
			cwd: new URL("../..", import.meta.url),
			env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}` },
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (data) => {
		stdout += data;
	});
	child.stderr.on("data", (data) => {
		stderr += data;
	});
	const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
	try {
		const code = await new Promise<number | null>((resolve, reject) => {
			child.on("error", reject);
			child.on("close", resolve);
		});
		assert.equal(code, 0, stderr);
		assert.match(stdout, /DURABLE_DRAIN_COMPLETE/);
		assert.equal(stderr.match(/SDK shutdown export failed; continuing host drain/g)?.length, 1, stderr);
		assert.doesNotMatch(stderr, /triggerUncaughtException/);
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null) child.kill("SIGKILL");
	}
});
