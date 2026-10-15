import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentModeError } from "../agent-runtime/agent-mode.js";
import {
	DEFAULT_DOMAIN_AGENT_DEFINITION_ID,
	DomainAgentConfigError,
	resolveDomainAgentConfig,
} from "../workflow/domain-agent-config.js";
import { documentUri, type GraphDocumentRead, type GraphWriter } from "../workflow/graph-writer.js";
import { InvocationFault } from "../workflow/invocation.js";
import {
	classifyInvocationFailure,
	formatInvocationFailureLog,
	invocationFailureBody,
	redactForLog,
} from "../workflow/invocation-failure.js";

describe("classifyInvocationFailure", () => {
	it("maps configuration and authority verdicts to definite 4xx codes", () => {
		const cases: Array<[DomainAgentConfigError, number]> = [
			[new DomainAgentConfigError("domain_agent_not_provisioned", "none", undefined, 404), 404],
			[new DomainAgentConfigError("definition_invalid", "bad"), 409],
			[new DomainAgentConfigError("charter_invalid", "empty"), 409],
			[new DomainAgentConfigError("model_binding_mismatch", "x"), 409],
			[new DomainAgentConfigError("ontology_binding_mismatch", "x"), 409],
			[new DomainAgentConfigError("grant_digest_mismatch", "x"), 409],
			[new DomainAgentConfigError("grant_authority_denied", "x"), 403],
			[new DomainAgentConfigError("interaction_mode_denied", "x"), 403],
			[new DomainAgentConfigError("trigger_source_denied", "x"), 403],
			[new DomainAgentConfigError("mode_denied", "x", undefined, 403), 403],
			[new DomainAgentConfigError("graph_unavailable", "down"), 503],
		];
		for (const [error, status] of cases) {
			const failure = classifyInvocationFailure(error);
			assert.equal(failure.status, status, error.code);
			assert.equal(failure.code, error.code);
		}
	});

	it("keeps InvocationFaults, honours explicit statuses and codes unknown errors", () => {
		assert.deepEqual(classifyInvocationFailure(new InvocationFault("capability_unavailable", "no", 409)), {
			status: 409,
			code: "capability_unavailable",
			message: "no",
		});
		const unavailable = classifyInvocationFailure(new AgentModeError("mode_unavailable", "stall"));
		assert.equal(unavailable.status, 503);
		assert.equal(unavailable.code, "mode_unavailable");
		const tagged = classifyInvocationFailure(Object.assign(new Error("bad request"), { status: 400 }));
		assert.deepEqual(tagged, { status: 400, code: "invalid_request", message: "bad request" });
		const unknown = classifyInvocationFailure(new Error("boom"), "input_build_failed");
		assert.deepEqual(unknown, { status: 500, code: "input_build_failed", message: "boom" });
		assert.deepEqual(invocationFailureBody(unknown), { error: { code: "input_build_failed", message: "boom" } });
	});

	it("serializes Error causes in details as name and message only", () => {
		const failure = classifyInvocationFailure(
			new DomainAgentConfigError("graph_unavailable", "down", { cause: new Error("ECONNREFUSED 10.0.0.1") }),
		);
		assert.deepEqual(failure.details, { cause: { name: "Error", message: "ECONNREFUSED 10.0.0.1" } });
	});
});

describe("invocation failure logging", () => {
	it("writes one JSON line and scrubs bearer tokens, JWTs and keys", () => {
		const line = formatInvocationFailureLog({
			stage: "build-inputs",
			status: 503,
			code: "graph_unavailable",
			message:
				"fetch failed: Authorization: Bearer abc.def-123 token eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl sk-or-v1-0123456789abcdef https://x/y?token=s3cret&x=1",
			graphId: "angels",
		});
		assert.ok(line.startsWith("[invocation] {"));
		const record = JSON.parse(line.slice("[invocation] ".length));
		assert.equal(record.event, "invocation_failed");
		assert.equal(record.code, "graph_unavailable");
		for (const secret of ["abc.def-123", "eyJhbGciOiJI", "sk-or-v1-0123456789abcdef", "s3cret"]) {
			assert.ok(!line.includes(secret), secret);
		}
		assert.equal(redactForLog("x".repeat(600)).length, 501);
	});
});

/** A real in-memory document graph that answers like gardend for absent and unreachable documents. */
class AnsweringGraph implements GraphWriter {
	constructor(private readonly behavior: "tool-error" | "throws-not-found" | "unreachable") {}
	async sparqlUpdate(): Promise<void> {}
	async sparqlQuery(): Promise<unknown> {
		return { resultType: "solutions", rows: [] };
	}
	async searchDocuments(): Promise<[]> {
		return [];
	}
	async readDocument(graphId: string, documentId: string): Promise<GraphDocumentRead> {
		if (this.behavior === "unreachable") throw new Error("connect ECONNREFUSED 127.0.0.1:443");
		if (this.behavior === "throws-not-found") throw new Error(`MCP error -32603: document not found: ${documentId}`);
		const raw = { isError: true, content: [{ type: "text", text: `document not found: ${documentId}` }] };
		return {
			graphId,
			documentId,
			documentUri: documentUri(documentId),
			format: "markdown",
			text: `document not found: ${documentId}`,
			blocks: [],
			raw,
		};
	}
	async writeDocument(): Promise<unknown> {
		return {};
	}
}

describe("resolveDomainAgentConfig on a graph that was never provisioned", () => {
	const request = {
		definitionDocumentId: DEFAULT_DOMAIN_AGENT_DEFINITION_ID,
		trigger: { kind: "sophia-cluster.message", text: "hi" },
		contextRefs: [],
		interactionMode: "headed" as const,
	};

	for (const behavior of ["tool-error", "throws-not-found"] as const) {
		it(`reports domain_agent_not_provisioned (404) when the definition is absent (${behavior})`, async () => {
			await assert.rejects(
				() =>
					resolveDomainAgentConfig({
						graph: new AnsweringGraph(behavior),
						graphId: "angels",
						homeOwnerPrincipal: "user:owner-1",
						request,
						trustedGrantAuthorities: [],
					}),
				(error: unknown) => {
					assert.ok(error instanceof DomainAgentConfigError);
					assert.equal(error.code, "domain_agent_not_provisioned");
					assert.equal(classifyInvocationFailure(error).status, 404);
					return true;
				},
			);
		});
	}

	it("reports graph_unavailable (503), not a missing definition, when the cell cannot be reached", async () => {
		await assert.rejects(
			() =>
				resolveDomainAgentConfig({
					graph: new AnsweringGraph("unreachable"),
					graphId: "angels",
					homeOwnerPrincipal: "user:owner-1",
					request,
					trustedGrantAuthorities: [],
				}),
			(error: unknown) => {
				assert.ok(error instanceof DomainAgentConfigError);
				assert.equal(error.code, "graph_unavailable");
				assert.equal(classifyInvocationFailure(error).status, 503);
				return true;
			},
		);
	});
});
