import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { createSandboxEventBus, type SandboxEventBus } from "../event-bus.js";
import { loopbackChildInvocationDispatch, routeRequest } from "../orchestrator.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import { compileWorkflow } from "../workflow/harness.js";
import { INVOCATION_ENVELOPE_SCHEMA, INVOCATION_RECEIPT_SCHEMA } from "../workflow/invocation.js";
import { JournalStore } from "../workflow/journal-store.js";
import { registerWorkflow } from "../workflow/registry.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import {
	DOMAIN_AGENT_ACTIVITY_LOOP_NAME,
	DOMAIN_AGENT_ACTIVITY_LOOP_SCRIPT,
} from "../workflow/script-domain-agent-activity-loop.js";

const API_PROGRAM = `export const meta = {
	name: "invocation-route-proof",
	execution: {
		controller: "program",
		modelUse: "none",
		isolation: "sandbox",
		effects: "pure",
		reproducibility: "pure",
	},
	inputs: {
		type: "object",
		properties: { text: { type: "string" } },
		required: ["text"],
		additionalProperties: false,
	},
	outputs: {
		type: "object",
		properties: { upper: { type: "string" } },
		required: ["upper"],
		additionalProperties: false,
	},
}

phase("transform")
return { upper: args.text.toUpperCase() }
`;

const DYNAMIC_API_PROGRAM = API_PROGRAM.replace("invocation-route-proof", "dynamic-invocation-route-proof");
const OWNER_INGRESS_PROGRAM = API_PROGRAM.replace("invocation-route-proof", "owner-ingress-route-proof");

class MockResponse {
	statusCode = 200;
	headers = new Map<string, string>();
	body = "";
	setHeader(name: string, value: string) {
		this.headers.set(name.toLowerCase(), value);
	}
	end(chunk?: string) {
		if (chunk) this.body += chunk;
	}
	setTimeout(_timeoutMs: number) {}
}

function request(body: unknown) {
	return Object.assign(Readable.from([JSON.stringify(body)]), {
		method: "POST",
		url: "/api/invocations",
		headers: {
			"content-type": "application/json",
			"x-internal-service": "shared-secret",
			"x-user-id": "ada",
		},
	});
}

function asyncRequest(body: unknown) {
	const message = request(body);
	message.headers.prefer = "respond-async";
	return message;
}

function delegatedRequest(body: unknown, headers: Record<string, string> = {}) {
	const message = request(body);
	Object.assign(message.headers, {
		"x-sophia-human-delegation": "gateway-exclusive-human-secret",
		...headers,
	});
	return message;
}

describe("POST /api/invocations — model-free durable path", { concurrency: false }, () => {
	let tempDir: string;
	let store: SandboxStore;
	let eventBus: SandboxEventBus;
	let spawner: SandboxSpawner;
	let journal: JournalStore;
	let runtime: WorkflowRuntimeStore;
	let previousSecret: string | undefined;
	let previousDynamicSource: string | undefined;
	let previousHumanDelegationSecret: string | undefined;
	const compiled = compileWorkflow(API_PROGRAM);
	const scriptSha256 = createHash("sha256").update(compiled.source).digest("hex");
	const dynamicScriptSha256 = createHash("sha256").update(DYNAMIC_API_PROGRAM).digest("hex");
	const ownerIngressCompiled = compileWorkflow(OWNER_INGRESS_PROGRAM);
	const ownerIngressScriptSha256 = createHash("sha256").update(ownerIngressCompiled.source).digest("hex");

	before(async () => {
		previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		previousDynamicSource = process.env.WORKFLOW_DYNAMIC_SOURCE;
		previousHumanDelegationSecret = process.env.CHOREOGRAPH_GATEWAY_HUMAN_DELEGATION_SECRET;
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "shared-secret";
		process.env.CHOREOGRAPH_GATEWAY_HUMAN_DELEGATION_SECRET = "gateway-exclusive-human-secret";
		delete process.env.WORKFLOW_DYNAMIC_SOURCE;
		tempDir = mkdtempSync(join(tmpdir(), "choreograph-invocation-route-"));
		store = new SandboxStore(join(tempDir, "sandboxes.sqlite"));
		eventBus = createSandboxEventBus(store, { cleanupDelayMs: 0 });
		spawner = new SandboxSpawner(
			store,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{ sandboxMode: "local-native", defaultTimeoutMs: 10_000, eventBus },
		);
		journal = new JournalStore(join(tempDir, "journal.sqlite"));
		runtime = new WorkflowRuntimeStore(join(tempDir, "runtime.sqlite"));
		await journal.init();
		await runtime.init();
		registerWorkflow({
			compiled,
			scriptSha256,
			buildInputs(body) {
				const input = (body as { workflow_args?: unknown }).workflow_args ?? {};
				return {
					config: { graphId: "graphless", model: "unused" },
					args: input,
					schemaInput: input,
				};
			},
		});
		registerWorkflow({
			compiled: ownerIngressCompiled,
			scriptSha256: ownerIngressScriptSha256,
			buildInputs(body, context) {
				if (context?.caller?.authMethod !== "owner") {
					throw new Error("owner ingress required");
				}
				const input = (body as { workflow_args?: unknown }).workflow_args ?? {};
				return {
					config: { graphId: "owner-proof", model: "unused" },
					args: input,
					schemaInput: input,
				};
			},
		});
	});

	after(async () => {
		await spawner.shutdownAll();
		journal.close();
		runtime.close();
		store.close();
		rmSync(tempDir, { recursive: true, force: true });
		if (previousSecret === undefined) delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		else process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
		if (previousDynamicSource === undefined) delete process.env.WORKFLOW_DYNAMIC_SOURCE;
		else process.env.WORKFLOW_DYNAMIC_SOURCE = previousDynamicSource;
		if (previousHumanDelegationSecret === undefined) delete process.env.CHOREOGRAPH_GATEWAY_HUMAN_DELEGATION_SECRET;
		else process.env.CHOREOGRAPH_GATEWAY_HUMAN_DELEGATION_SECRET = previousHumanDelegationSecret;
	});

	it("returns a zero-agent receipt and journals the real bare-sandbox execution", async () => {
		const response = new MockResponse();
		await routeRequest(
			request({
				schema: INVOCATION_ENVELOPE_SCHEMA,
				invocationId: "inv-local-proof",
				target: {
					workflowName: "invocation-route-proof",
					definitionDigest: scriptSha256,
				},
				input: { text: "hello sandbox" },
				actorRef: "user:ada",
				cause: { kind: "http", ref: "local-test" },
				budget: { maxDurationMs: 10_000 },
			}) as never,
			response as never,
			{ spawner, eventBus, journal, runtime } as never,
		);

		assert.equal(response.statusCode, 200);
		const body = JSON.parse(response.body);
		assert.deepEqual(body.result, { upper: "HELLO SANDBOX" });
		assert.equal(body.receipt.schema, INVOCATION_RECEIPT_SCHEMA);
		assert.equal(body.receipt.status, "completed");
		assert.equal(body.receipt.usage.agentCount, 0);
		assert.equal(body.receipt.usage.totalTokens, 0);
		assert.equal(body.execution.controller, "program");

		const { header, events } = await journal.readRun(body.runId);
		assert.equal(header?.status, "completed");
		assert.ok(events.some((event) => event.type === "run_started"));
		assert.ok(events.some((event) => event.type === "phase_entered"));
		assert.ok(events.some((event) => event.type === "run_done"));
		assert.equal((await runtime.getWorkflowInstance(body.runId))?.status, "completed");
		assert.ok(store.list().some((sandbox) => sandbox.template === "bare" && sandbox.owner_user_id === "ada"));
	});

	it("accepts only the gateway-exclusive secret plus exact canonical owner tuple as owner ingress", async () => {
		const envelope = {
			schema: INVOCATION_ENVELOPE_SCHEMA,
			invocationId: "inv-owner-route-proof",
			target: {
				workflowName: "owner-ingress-route-proof",
				definitionDigest: ownerIngressScriptSha256,
			},
			input: { text: "owner" },
			actorRef: "user:ada",
			graph: { ownerPrincipal: "user:ada", graphId: "sophia-cluster" },
		};
		const accepted = new MockResponse();
		await routeRequest(
			delegatedRequest(envelope) as never,
			accepted as never,
			{
				spawner,
				eventBus,
				journal,
				runtime,
			} as never,
		);
		assert.equal(accepted.statusCode, 200, accepted.body);
		assert.deepEqual(JSON.parse(accepted.body).result, { upper: "OWNER" });

		for (const [suffix, headers, graphOwner] of [
			["poison", { "x-sophia-human-delegation": "caller-poison" }, "user:ada"],
			["adapter", { "x-sophia-trigger-adapter": "vehicle" }, "user:ada"],
			["editor", {}, "user:graph-owner"],
		] as const) {
			const denied = new MockResponse();
			await routeRequest(
				delegatedRequest(
					{
						...envelope,
						invocationId: `inv-owner-route-${suffix}`,
						graph: { ownerPrincipal: graphOwner, graphId: "sophia-cluster" },
					},
					headers,
				) as never,
				denied as never,
				{ spawner, eventBus, journal, runtime } as never,
			);
			assert.equal(denied.statusCode, 400, `${suffix}: ${denied.body}`);
			assert.match(JSON.parse(denied.body).error.message, /owner ingress required/);
		}
	});

	it("rejects a stale Meaningful Object definition digest before execution", async () => {
		const before = store.list().length;
		const response = new MockResponse();
		await routeRequest(
			request({
				schema: INVOCATION_ENVELOPE_SCHEMA,
				invocationId: "inv-stale-definition",
				target: { workflowName: "invocation-route-proof", definitionDigest: "stale" },
				input: { text: "nope" },
				actorRef: "user:ada",
			}) as never,
			response as never,
			{ spawner, eventBus, journal, runtime } as never,
		);

		assert.equal(response.statusCode, 409);
		assert.equal(JSON.parse(response.body).error.code, "definition_digest_mismatch");
		assert.equal(store.list().length, before);
	});

	it("rejects invalid async input before claiming that a durable run exists", async () => {
		const before = await journal.listRuns({ ownerUserId: "ada", limit: 100 });
		const response = new MockResponse();
		await routeRequest(
			asyncRequest({
				schema: INVOCATION_ENVELOPE_SCHEMA,
				invocationId: "inv-invalid-async-input",
				target: {
					workflowName: "invocation-route-proof",
					definitionDigest: scriptSha256,
				},
				input: { text: 42 },
				actorRef: "user:ada",
			}) as never,
			response as never,
			{ spawner, eventBus, journal, runtime } as never,
		);

		assert.equal(response.statusCode, 400, response.body);
		assert.equal(JSON.parse(response.body).error.code, "invalid_input");
		const after = await journal.listRuns({ ownerUserId: "ada", limit: 100 });
		assert.equal(after.length, before.length);
	});

	it("accepts digest-pinned graph source for program execution without the trusted-source flag", async () => {
		const response = new MockResponse();
		const workflowUri = "urn:mnemosyne:local:graph:phanes:doc:program-proof";
		await routeRequest(
			request({
				schema: INVOCATION_ENVELOPE_SCHEMA,
				invocationId: "inv-dynamic-program",
				target: {
					workflowName: "dynamic-invocation-route-proof",
					workflowUri,
					definitionDigest: dynamicScriptSha256,
				},
				input: { text: "from garden" },
				actorRef: "user:ada",
				graph: { graphId: "phanes" },
				workflow_binding: {
					name: "dynamic-invocation-route-proof",
					workflowUri,
					scriptSha256: dynamicScriptSha256,
					executor: "dumb",
					execution: {
						schema: "choreograph.execution-binding.v1",
						controller: "program",
						modelUse: "none",
						isolation: "sandbox",
						effects: "pure",
						reproducibility: "pure",
						runtime: { kind: "node" },
						capabilities: [],
						authority: { minimumRole: "editor", dangerousOps: false },
						mayInvokeChildren: false,
					},
					source: DYNAMIC_API_PROGRAM,
				},
			}) as never,
			response as never,
			{ spawner, eventBus, journal, runtime } as never,
		);

		assert.equal(response.statusCode, 200, response.body);
		const body = JSON.parse(response.body);
		assert.deepEqual(body.result, { upper: "FROM GARDEN" });
		assert.equal(body.receipt.target.workflowUri, workflowUri);
		assert.equal(body.provenance.workflowUri, workflowUri);
	});

	it("fails closed when the published execution face disagrees with source metadata", async () => {
		const before = store.list().length;
		const response = new MockResponse();
		await routeRequest(
			request({
				schema: INVOCATION_ENVELOPE_SCHEMA,
				invocationId: "inv-contested-posture",
				target: {
					workflowName: "invocation-route-proof",
					definitionDigest: scriptSha256,
				},
				input: { text: "do not run" },
				actorRef: "user:ada",
				workflow_binding: {
					name: "invocation-route-proof",
					scriptSha256,
					executor: "dumb",
					execution: {
						controller: "program",
						modelUse: "none",
						isolation: "sandbox",
						effects: "capability-bound",
						reproducibility: "recorded-external",
					},
					source: API_PROGRAM,
				},
			}) as never,
			response as never,
			{ spawner, eventBus, journal, runtime } as never,
		);

		assert.equal(response.statusCode, 409);
		assert.equal(JSON.parse(response.body).error.code, "execution_binding_mismatch");
		assert.equal(store.list().length, before);
	});

	it("fails closed when the published Operation schema disagrees with source metadata", async () => {
		const before = store.list().length;
		const response = new MockResponse();
		await routeRequest(
			request({
				schema: INVOCATION_ENVELOPE_SCHEMA,
				invocationId: "inv-contested-schema",
				target: {
					workflowName: "invocation-route-proof",
					definitionDigest: scriptSha256,
				},
				input: { text: "do not run" },
				actorRef: "user:ada",
				workflow_binding: {
					name: "invocation-route-proof",
					scriptSha256,
					executor: "dumb",
					execution: compiled.meta.execution,
					inputSchema: JSON.stringify({ type: "array" }),
					source: API_PROGRAM,
				},
			}) as never,
			response as never,
			{ spawner, eventBus, journal, runtime } as never,
		);

		assert.equal(response.statusCode, 409);
		assert.equal(JSON.parse(response.body).error.code, "workflow_schema_mismatch");
		assert.equal(store.list().length, before);
	});

	it("recognizes an exact graph mirror of a registered composite without enabling arbitrary host JS", async () => {
		const before = store.list().length;
		const response = new MockResponse();
		const digest = createHash("sha256").update(DOMAIN_AGENT_ACTIVITY_LOOP_SCRIPT).digest("hex");
		await routeRequest(
			request({
				schema: INVOCATION_ENVELOPE_SCHEMA,
				invocationId: "inv-reviewed-composite-mirror",
				target: {
					workflowName: DOMAIN_AGENT_ACTIVITY_LOOP_NAME,
					workflowUri: "urn:mnemosyne:local:graph:phanes:doc:activity-loop",
					definitionDigest: digest,
				},
				input: {},
				actorRef: "user:ada",
				graph: { graphId: "phanes" },
				workflow_binding: {
					name: DOMAIN_AGENT_ACTIVITY_LOOP_NAME,
					workflowUri: "urn:mnemosyne:local:graph:phanes:doc:activity-loop",
					scriptSha256: digest,
					executor: "dumb",
					// Deliberately contested. Reaching execution-face comparison proves
					// exact registered bytes passed the otherwise gated host-JS boundary.
					execution: {
						controller: "program",
						modelUse: "none",
						isolation: "sandbox",
						effects: "pure",
						reproducibility: "pure",
					},
					source: DOMAIN_AGENT_ACTIVITY_LOOP_SCRIPT,
				},
			}) as never,
			response as never,
			{ spawner, eventBus, journal, runtime } as never,
		);

		assert.equal(response.statusCode, 409, response.body);
		assert.equal(JSON.parse(response.body).error.code, "execution_binding_mismatch");
		assert.equal(store.list().length, before);
	});

	it("dispatches a child invocation over loopback with inherited host auth and no async preference", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const dispatch = loopbackChildInvocationDispatch(
			{ method: "internal_service", userId: "ada", internalServiceSecret: "shared-secret" },
			async (input, init) => {
				calls.push({ url: String(input), init });
				const envelope = JSON.parse(String(init?.body));
				return new Response(
					JSON.stringify({
						result: { upper: "CHILD" },
						receipt: {
							schema: INVOCATION_RECEIPT_SCHEMA,
							invocationId: envelope.invocationId,
							target: envelope.target,
							status: "completed",
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
			4567,
		);
		const result = await dispatch({
			schema: INVOCATION_ENVELOPE_SCHEMA,
			invocationId: "inv-child-loopback-proof",
			target: {
				workflowName: "invocation-route-proof",
				workflowUri: "urn:sophia:wf:invocation-route-proof",
				definitionDigest: scriptSha256,
			},
			input: { text: "child" },
			actorRef: "user:ada",
			deadlineMs: Date.now() + 10_000,
		});

		assert.equal(calls[0]?.url, "http://127.0.0.1:4567/api/invocations");
		const headers = calls[0]?.init?.headers as Record<string, string>;
		assert.equal(headers["x-internal-service"], "shared-secret");
		assert.equal(headers["x-user-id"], "ada");
		assert.equal(headers.prefer, undefined);
		assert.deepEqual(result.output, { upper: "CHILD" });
		assert.equal(result.status, "completed");
	});
});
