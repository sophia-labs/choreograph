/**
 * Choreograph's pi agent body (packages/agent-body) under a real local-native orchestrator: a real server, real body
 * processes, the host's own scripted models (`mock:*`, served by the host's inference proxy, so no network and no
 * key). Nothing is stubbed: the workflow goes in over HTTP and the run comes back from the journal.
 */

import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	digestAgentBodyArtifact,
	digestLocalAgentRuntime,
	resolveRuntimeBundleDescriptor,
} from "../runtime-bundles.js";
import { LOCAL_AGENT_CONSTRAINTS, localAgentDefaults } from "../workflow/local-agent-defaults.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BODY_ENTRY = join(ROOT, "packages/agent-body/src/main.ts");
const BODY_ROOT = join(ROOT, "packages/agent-body");

async function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => resolvePort(typeof address === "object" && address ? address.port : 0));
		});
	});
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function workflowSource(name: string, model: string, extra = ""): string {
	return `export const meta = {
	name: ${JSON.stringify(name)},
	description: "One agent step on the local pi body.",
	phases: [{ title: "answer" }],
	execution: { schema: "choreograph.execution-binding.v1", controller: "composite", modelUse: "agentic", isolation: "sandbox", effects: "capability-bound", reproducibility: "nondeterministic", capabilities: ["choreograph.agent"], authority: { minimumRole: "editor", dangerousOps: false }, mayInvokeChildren: false },
	inputs: { type: "object", additionalProperties: false, required: ["question"], properties: { question: { type: "string", minLength: 1 } } },
}
phase("answer")
const result = await agent(args.question, { label: "answerer", model: ${JSON.stringify(model)}, provider: "openrouter", toolMode: "none", maxTurns: 4${extra} })
return { output: result.output, status: result.status }
`;
}

describe("the pi agent body under a local-native orchestrator", { concurrency: false }, () => {
	let child: ChildProcess | undefined;
	let dataDir = "";
	let base = "";
	let log = "";
	const secret = `test-secret-${Math.random().toString(36).slice(2)}`;
	const headers = { "content-type": "application/json", "x-internal-service": secret, "x-user-id": "owner" };

	before(async () => {
		dataDir = mkdtempSync(join(tmpdir(), "choreograph-body-e2e-"));
		const port = await freePort();
		base = `http://127.0.0.1:${port}`;
		child = spawn(process.execPath, ["--import", "tsx", "src/orchestrator.ts"], {
			cwd: ROOT,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				PATH: process.env.PATH,
				HOME: process.env.HOME,
				PORT: String(port),
				DATA_DIR: dataDir,
				CHOREOGRAPH_SANDBOX_MODE: "local-native",
				CHOREOGRAPH_BIND_HOST: "127.0.0.1",
				OTEL_SDK_DISABLED: "true",
				BILLING_FEE_BPS: "0",
				MNEMOSYNE_INTERNAL_SERVICE_SECRET: secret,
				WORKFLOW_DYNAMIC_SOURCE: "1",
				CHOREOGRAPH_LOCAL_AGENT_DEFAULTS: "1",
				SOPHIA_AGENT_RUNTIME_ENTRYPOINT: BODY_ENTRY,
			},
		});
		child.stdout?.on("data", (chunk) => {
			log += chunk;
		});
		child.stderr?.on("data", (chunk) => {
			log += chunk;
		});
		for (let attempt = 0; ; attempt += 1) {
			try {
				if ((await fetch(`${base}/health`)).ok) break;
			} catch {
				// not listening yet
			}
			if (attempt > 240) throw new Error(`the orchestrator never answered /health:\n${log.slice(-4000)}`);
			await sleep(250);
		}
	});

	after(async () => {
		child?.kill("SIGTERM");
		await sleep(500);
		rmSync(dataDir, { recursive: true, force: true });
	});

	async function run(name: string, model: string, extra = "") {
		const response = await fetch(`${base}/api/workflows/run`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				workflow_name: name,
				workflow_source: workflowSource(name, model, extra),
				workflow_args: { question: "Say hello, then finish." },
				graph_id: "body-e2e",
				graph_owner: "user:owner",
			}),
		});
		const started = (await response.json()) as { runId?: string };
		assert.equal(response.status, 202, JSON.stringify(started));
		assert.ok(started.runId);
		for (let attempt = 0; attempt < 120; attempt += 1) {
			const detail = (await (await fetch(`${base}/api/workflows/runs/${started.runId}`, { headers })).json()) as {
				header: { status: string };
				events: Array<{ type: string; payload?: Record<string, unknown> }>;
			};
			if (["completed", "failed", "cancelled"].includes(detail.header.status)) return detail;
			await sleep(250);
		}
		throw new Error(`run ${started.runId} did not finish:\n${log.slice(-4000)}`);
	}

	it("runs an agent step that names no runtime or ontology, through the done tool", { timeout: 60_000 }, async () => {
		const detail = await run("body-e2e-done", "mock:done");
		assert.equal(detail.header.status, "completed", log.slice(-3000));
		const done = detail.events.find((event) => event.type === "node_done");
		assert.equal(done?.payload?.status, "terminated");
		assert.equal(done?.payload?.output, "Mock sandbox validation completed.");
		assert.equal(done?.payload?.tool_calls, 1);
		const queued = detail.events.find((event) => event.type === "node_queued");
		assert.equal(queued?.payload?.runtimeKind, "prime");
		assert.match(String(queued?.payload?.runtimeBindingDigest), /^sha256:[0-9a-f]{64}$/);
	});

	it(
		"fails a step whose model answers in text without calling done(), as the hosted body does",
		{
			timeout: 60_000,
		},
		async () => {
			const detail = await run("body-e2e-text", "mock:text");
			assert.equal(detail.header.status, "failed", log.slice(-3000));
			const failed = detail.events.find((event) => event.type === "error");
			assert.equal(failed?.payload?.status, "error");
			assert.equal(failed?.payload?.output, "The agent stopped without calling done().");
		},
	);

	it("fails a step whose required structured result never arrives", { timeout: 60_000 }, async () => {
		const detail = await run(
			"body-e2e-schema",
			"mock:text",
			', schema: { type: "object", required: ["answer"], properties: { answer: { type: "string" } } }',
		);
		assert.equal(detail.header.status, "failed", log.slice(-3000));
		const failed = detail.events.find((event) => event.type === "error");
		assert.equal(failed?.payload?.status, "error");
		assert.match(String(failed?.payload?.output), /without calling submit\(\)/);
	});

	it("attests the body it runs: the binding pins the digest of the body's own files", () => {
		const digest = digestLocalAgentRuntime(BODY_ENTRY);
		assert.equal(digest, digestAgentBodyArtifact(BODY_ROOT));
		assert.match(log, /sandbox mode: local-native/);
	});
});

describe("the body's attestation and the host's local defaults", () => {
	it("changes the digest when any file of the body changes, and ignores its tests", () => {
		const copy = mkdtempSync(join(tmpdir(), "choreograph-body-digest-"));
		try {
			cpSync(join(BODY_ROOT, "package.json"), join(copy, "package.json"));
			mkdirSync(join(copy, "src"));
			writeFileSync(join(copy, "src", "main.ts"), "export {};\n");
			const before = digestAgentBodyArtifact(copy);
			mkdirSync(join(copy, "test"));
			writeFileSync(join(copy, "test", "x.test.ts"), "// not part of the body\n");
			assert.equal(digestAgentBodyArtifact(copy), before);
			writeFileSync(join(copy, "src", "main.ts"), "export const changed = 1;\n");
			assert.notEqual(digestAgentBodyArtifact(copy), before);
			assert.throws(() => digestAgentBodyArtifact(tmpdir()), /Not a Choreograph agent body/);
		} finally {
			rmSync(copy, { recursive: true, force: true });
		}
	});

	it("derives the runtime descriptor from the body only for a local-native host without a manifest", () => {
		const saved = { ...process.env };
		try {
			delete process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST;
			delete process.env.RUNTIME_BUNDLE_MANIFEST;
			process.env.SOPHIA_AGENT_RUNTIME_ENTRYPOINT = BODY_ENTRY;
			process.env.CHOREOGRAPH_SANDBOX_MODE = "local-native";
			const descriptor = resolveRuntimeBundleDescriptor("sophia-agent-runtime");
			assert.equal(`sha256:${descriptor.digest}`, digestAgentBodyArtifact(BODY_ROOT));
			assert.deepEqual(descriptor.mounts, []);
			const defaults = localAgentDefaults({ workflowName: "w", graphId: "g", ownerPrincipal: "user:owner" });
			assert.equal(defaults.runtime.bundle.digest, `sha256:${descriptor.digest}`);
			assert.deepEqual(defaults.runtime.constraints, LOCAL_AGENT_CONSTRAINTS);
			assert.equal(defaults.runtime.constraints.allowPersistentKernel, false);
			assert.equal(defaults.ontology.subject.registeredName, "workflow-w");
			process.env.CHOREOGRAPH_SANDBOX_MODE = "bwrap";
			assert.throws(() => resolveRuntimeBundleDescriptor("sophia-agent-runtime"), /manifest is not configured/);
		} finally {
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
			Object.assign(process.env, saved);
		}
	});
});
