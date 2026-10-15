import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { workspaceChatSystemPrompt } from "../workflow/workspace-chat.js";
import { useInvocationHarness } from "./chat-runtime-fixture.js";
import { HARNESS_CELL_TOOLS } from "./garden-document-cell.js";

/**
 * The live SPA against this host (Sobremesa: nothing already deployed may break).
 *
 * Today's SPA is shrubbery `r20260926` (bundle `main-BeZtzTzl.js`). It has never heard of a voice, a seed or a title.
 * Every request and every check below is what its `packages/runtime/src/chat-services/hosted-chat-service.ts` does,
 * copied from that commit, and driven through the real router and spawner:
 *
 *   discoverWorkflows   GET  /workflows  ->  `validatedWorkflow(workflows, 'workspace-chat-v1', uri, ['trigger'])`
 *   postInvocation      POST /invocations with the envelope built in `liveSpaEnvelope`
 *   resolveAgentSession GET  /workflows/runs/{runId}/agents  ->  the one `pilot-headed` Session
 *
 * The new inputs (`inference`, `seed`, `title`) are optional, and what a client does not send is not required of it.
 */

const WORKSPACE_WORKFLOW_NAME = "workspace-chat-v1";
const WORKSPACE_WORKFLOW_URI = `urn:sophia:wf:${WORKSPACE_WORKFLOW_NAME}`;
const DIGEST = /^[a-f0-9]{64}$/;
const AGENT_SESSION_ID = /^ags[-_][A-Za-z0-9._:-]+$/;

interface WorkflowSummary {
	readonly name?: unknown;
	readonly workflowUri?: unknown;
	readonly definitionDigest?: unknown;
	readonly inputs?: unknown;
	readonly outputs?: unknown;
}

const asRecord = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** `validatedWorkflow` of the live SPA, statement for statement. Throws where it throws. */
function validatedWorkflow(
	workflows: readonly WorkflowSummary[],
	name: string,
	uri: string,
	requiredInputs: readonly string[],
): { name: string; workflowUri: string; definitionDigest: string } | undefined {
	const matches = workflows.filter((workflow) => workflow.name === name);
	if (matches.length === 0) return undefined;
	if (matches.length !== 1)
		throw new Error(`Expected exactly one ${name} registry entry; received ${matches.length}.`);
	const workflow = matches[0];
	const required = Array.isArray(asRecord(workflow.inputs).required)
		? (asRecord(workflow.inputs).required as unknown[])
		: [];
	if (
		workflow.workflowUri !== uri ||
		typeof workflow.definitionDigest !== "string" ||
		!DIGEST.test(workflow.definitionDigest) ||
		requiredInputs.some((field) => !required.includes(field)) ||
		asRecord(workflow.outputs).type !== "object"
	) {
		throw new Error(`${name} registry entry failed digest/URI/schema validation.`);
	}
	return { name, workflowUri: uri, definitionDigest: workflow.definitionDigest };
}

/**
 * The first message of a chat, exactly as `postInvocation` builds it for the built-in workspace assistant, with
 * one difference. The live SPA names no graph owner (`graph: { graphId }`): at the gateway the host takes the acting
 * person's own principal from its service-auth (`x-pn-on-behalf-of`). This harness has no gateway, so the same
 * principal is named in the envelope, as every other suite here does. Nothing in this release touches that seam.
 */
function liveSpaEnvelope(suffix: string, definitionDigest: string, text: string, graphId = "angels") {
	const virtualId = `c2chat-${suffix}`;
	const resource = `graph:${graphId}:chat:${virtualId}`;
	const trigger = { kind: "sophia-cluster.message", eventId: `c2chat.event.${suffix}`, resource, text };
	return {
		schema: "choreograph.invocation-envelope.v1",
		invocationId: `c2chat.inv.${suffix}.ws`,
		target: { workflowName: WORKSPACE_WORKFLOW_NAME, workflowUri: WORKSPACE_WORKFLOW_URI, definitionDigest },
		input: { trigger, contextRefs: [] as string[], interactionMode: "headed" },
		actorRef: "user:owner-1",
		graph: { graphId, ownerPrincipal: "user:owner-1" },
		cause: { kind: "trigger", ref: resource },
		idempotencyKey: `sophia-cluster:${virtualId}:ws`,
	};
}

describe("the live SPA against this host", { concurrency: false }, () => {
	const h = useInvocationHarness({
		catalogue: true,
		env: { CHOREOGRAPH_WORKSPACE_CHAT_MODEL: "google/gemini-2.5-flash" },
	});

	const discover = async () => {
		const registry = await h.get("/api/workflows");
		assert.equal(registry.statusCode, 200, registry.body);
		const workflow = validatedWorkflow(registry.json.workflows, WORKSPACE_WORKFLOW_NAME, WORKSPACE_WORKFLOW_URI, [
			"trigger",
		]);
		assert.ok(workflow, "the registry offers the built-in workspace assistant");
		return { workflow, registry: registry.json.workflows as WorkflowSummary[] };
	};

	it("still finds and validates the workspace assistant in the registry, the new host block and inputs notwithstanding", async () => {
		const { workflow, registry } = await discover();
		assert.match(workflow.definitionDigest, DIGEST);
		// What the live SPA does not know is present and ignored: it reads name, uri, digest, inputs.required, outputs.type.
		const entry = registry.find((candidate) => candidate.name === WORKSPACE_WORKFLOW_NAME) as Record<string, unknown>;
		assert.ok(entry.host, "the entry now carries a host block");
		assert.deepEqual(
			asRecord(entry.inputs).required,
			["trigger"],
			"the one input a client must send is still the trigger",
		);
		const properties = asRecord(asRecord(entry.inputs).properties);
		for (const optional of ["inference", "seed", "title"]) {
			assert.ok(properties[optional], `${optional} is declared`);
			assert.equal(
				(asRecord(entry.inputs).required as string[]).includes(optional),
				false,
				`${optional} is optional`,
			);
		}
		// The other chat workflow's entry is untouched: no host block, the same required inputs.
		const domain = registry.find((candidate) => candidate.name === "domain-agent-activity-loop-v1") as Record<
			string,
			unknown
		>;
		assert.equal(domain.host, undefined);
	});

	it("takes the first message exactly as it sends it: 202, its own invocation id back, a run, one headed Session", async () => {
		const { workflow } = await discover();
		const text = "What is in this workspace?";
		const body = liveSpaEnvelope("compat1", workflow.definitionDigest, text);
		const response = await h.post(body);
		assert.equal(response.statusCode, 202, response.body);
		assert.equal(response.json.invocationId, body.invocationId, "the SPA checks this");
		assert.equal(typeof response.json.runId, "string");
		assert.ok(response.json.runId, "and this");

		// resolveAgentSession polls until the Session exists; then exactly one `pilot-headed` agent with a session id it accepts.
		const session = await h.waitForSession(response.json.runId);
		const agents = await h.get(`/api/workflows/runs/${encodeURIComponent(response.json.runId)}/agents`);
		assert.equal(agents.statusCode, 200, agents.body);
		const intended = (agents.json.agents as Array<{ label?: string; sessionId?: string }>).filter(
			(agent) =>
				agent.label === "pilot-headed" &&
				typeof agent.sessionId === "string" &&
				AGENT_SESSION_ID.test(agent.sessionId),
		);
		assert.equal(intended.length, 1);

		assert.equal(session.session_id, intended[0].sessionId);
		// Nothing asked for a voice, so the chat speaks with the House default; nothing carried a seed.
		assert.equal(session.model, "google/gemini-2.5-flash");
		const source = (JSON.parse(session.document_json) as { source: Record<string, unknown> }).source;
		assert.equal(source.prompt, text);
		assert.equal(source.seed, undefined, "no seed, no continuation");
		assert.equal(source.provider, "openrouter");
		const handed = await h.waitForSpawn(session.session_id);
		assert.equal(
			handed.system_prompt,
			workspaceChatSystemPrompt({
				graphId: "angels",
				role: "editor",
				model: "google/gemini-2.5-flash",
				// The harness cell serves five tools: the prompt names the Writer's that are live (exam 1, finding 7).
				tools: HARNESS_CELL_TOOLS,
			}),
			"the host's prompt, byte for byte (a person with no minted role is an editor)",
		);
		const claims = await h.runtime.raw("SELECT COUNT(*) AS n FROM chat_seed_claims WHERE session_id = ?", [
			session.session_id,
		]);
		assert.equal(Number(claims.rows[0].n), 0);
		const row = await h.runtime.readChatSessionCatalogue(session.session_id);
		assert.equal(row?.title, text, "titled from the first message, as before there was a title input");
		assert.equal(row?.title_source, "first-message");
		assert.equal(row?.continues_json, null);
		await h.settle();
	});

	it("reads the Session back as it did, with the new facts beside what it read before", async () => {
		const { workflow } = await discover();
		const response = await h.post(liveSpaEnvelope("compat2", workflow.definitionDigest, "Read me back."));
		assert.equal(response.statusCode, 202, response.body);
		const session = await h.waitForSession(response.json.runId);
		const read = await h.get(`/api/agent-sessions/${session.session_id}`);
		assert.equal(read.statusCode, 200, read.body);
		// The members a client of the deployed release reads are all still there.
		for (const member of ["session", "document", "documentBackend", "documentRevision", "documentOps", "events"]) {
			assert.ok(member in read.json, member);
		}
		assert.equal(
			read.json.session.sessionId ?? read.json.session.session_id ?? session.session_id,
			session.session_id,
		);
		assert.equal(read.json.document.source.prompt, "Read me back.");
		assert.ok(Array.isArray(read.json.document.transcript.order));
		// Added, and ignorable: the chat's own facts.
		assert.equal(read.json.session.chat.title, "Read me back.");
		assert.equal(read.json.session.chat.model, "google/gemini-2.5-flash");
		await h.settle();
	});

	it("ignores what it does not know, at every level of the envelope, instead of refusing it", async () => {
		const { workflow } = await discover();
		const body = liveSpaEnvelope("compat3", workflow.definitionDigest, "With something from the future.");
		const future = {
			...body,
			futureEnvelopeField: { anything: true },
			input: {
				...body.input,
				futureInputField: "ignored",
				trigger: { ...body.input.trigger, futureTriggerField: 1 },
			},
		};
		const response = await h.post(future);
		assert.equal(response.statusCode, 202, response.body);
		const session = await h.waitForSession(response.json.runId);
		assert.equal(session.model, "google/gemini-2.5-flash");
		assert.equal(
			await h.runtime.readChatSessionCatalogue(session.session_id).then((row) => row?.title),
			"With something from the future.",
		);
		await h.settle();
	});

	it("reads null as 'not provided' for the three new inputs, as a client in another language would send it", async () => {
		const { workflow } = await discover();
		const body = liveSpaEnvelope("compat4", workflow.definitionDigest, "Nothing chosen, everything null.");
		const response = await h.post({ ...body, input: { ...body.input, inference: null, seed: null, title: null } });
		assert.equal(response.statusCode, 202, response.body);
		const session = await h.waitForSession(response.json.runId);
		assert.equal(session.model, "google/gemini-2.5-flash", "the House default, since no voice was chosen");
		const source = (JSON.parse(session.document_json) as { source: Record<string, unknown> }).source;
		assert.equal(source.seed, undefined);
		assert.equal((await h.runtime.readChatSessionCatalogue(session.session_id))?.title_source, "first-message");
		await h.settle();
	});

	it("gives a client that cached the old digest one clear refusal, and the registry's digest is the way out", async () => {
		const { workflow } = await discover();
		const stale = liveSpaEnvelope("compat5", "0".repeat(64), "A stale tab.");
		const refused = await h.post(stale);
		assert.equal(refused.statusCode, 409, refused.body);
		assert.equal(refused.json.error.code, "definition_digest_mismatch");
		assert.equal(
			refused.json.error.details.actual,
			workflow.definitionDigest,
			"the refusal names the current digest",
		);
		const retried = await h.post(liveSpaEnvelope("compat5", refused.json.error.details.actual, "A stale tab."));
		assert.equal(retried.statusCode, 202, retried.body);
		await h.waitForSession(retried.json.runId);
		await h.settle();
	});
});
