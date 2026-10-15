import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
	AgentResultValidationFault,
	PRIME_RUNTIME_STATE_SCHEMA,
	validateCanonicalAgentSpawnResult,
	validatePrimeSemanticEventAuthority,
} from "../agent-runtime/result-validation.js";
import type { AgentSpawnRequest } from "../wire-protocol.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

function request(): AgentSpawnRequest {
	const semantic = makeTestAgentSemanticBinding({ kind: "prime", registeredName: "result-validator" });
	return {
		spawn_id: "sandbox-result-validator",
		session_id: "session-result-validator",
		generation: 3,
		intent: "validate",
		wards: { max_turns: 24, max_depth: 2, require_done_tool: true },
		mnemosyne: {
			mcp_url: "disabled",
			session_token: "disabled",
			graph_scope: { default_graph_id: "g1" },
			tool_profile: "chat",
			expires_at: new Date(0).toISOString(),
		},
		medium: "conversation",
		model: "mock:done",
		agent_id: semantic.agentId,
		depth: 0,
		runtime_binding: semantic.runtime,
		runtime_binding_digest: semantic.runtimeBindingDigest,
		agent_ontology: semantic.ontology,
		agent_ontology_binding_digest: semantic.ontologyBindingDigest,
		output_schema: {
			type: "object",
			additionalProperties: false,
			required: ["content"],
			properties: { content: { type: "string" } },
		},
	};
}

function runtimeState(req: AgentSpawnRequest): Record<string, unknown> {
	const unsigned = {
		schema: PRIME_RUNTIME_STATE_SCHEMA,
		sessionId: req.session_id,
		sandboxId: req.spawn_id,
		generation: req.generation,
		runtimeBindingDigest: req.runtime_binding_digest,
		ontologyBindingDigest: req.agent_ontology_binding_digest,
		sessionHeader: { type: "session", version: 3, id: req.session_id, cwd: "/workspace" },
		entries: [],
		goal: null,
		autonomous: { enabled: false },
		workerSequence: 12,
		createdAt: "2026-08-05T00:00:00.000Z",
	};
	return { ...unsigned, digest: digest(unsigned) };
}

function result(req: AgentSpawnRequest): Record<string, unknown> {
	return {
		spawn_id: req.spawn_id,
		status: "terminated",
		output: "ok",
		turns: 1,
		tokens: 10,
		tool_calls: 1,
		structured_output: { content: "ok" },
		session_id: req.session_id,
		runtime_binding_digest: req.runtime_binding_digest,
		agent_ontology_binding_digest: req.agent_ontology_binding_digest,
		prime_state: runtimeState(req),
	};
}

describe("canonical Agent result validation", () => {
	it("accepts a result and Prime state bound to the exact host request", () => {
		const req = request();
		assert.doesNotThrow(() => validateCanonicalAgentSpawnResult(result(req), req));
		assert.doesNotThrow(() =>
			validatePrimeSemanticEventAuthority(
				{
					type: "prime_event",
					name: "goal_update",
					payload: {},
					session_id: req.session_id,
					runtime_binding_digest: req.runtime_binding_digest,
					agent_ontology_binding_digest: req.agent_ontology_binding_digest,
				},
				req,
			),
		);
	});

	it("rejects session, generation, digest, schema, and structured-output drift", () => {
		const req = request();
		for (const mutate of [
			(value: Record<string, unknown>) => {
				value.session_id = "session-other";
			},
			(value: Record<string, unknown>) => {
				(value.prime_state as Record<string, unknown>).generation = req.generation + 1;
			},
			(value: Record<string, unknown>) => {
				(value.prime_state as Record<string, unknown>).digest = `sha256:${"f".repeat(64)}`;
			},
			(value: Record<string, unknown>) => {
				value.structured_output = { wrong: true };
			},
		]) {
			const candidate = result(req);
			mutate(candidate);
			assert.throws(() => validateCanonicalAgentSpawnResult(candidate, req), AgentResultValidationFault);
		}
	});

	it("rejects a semantic event that claims another Agent Ontology binding", () => {
		const req = request();
		assert.throws(
			() =>
				validatePrimeSemanticEventAuthority(
					{
						type: "prime_event",
						name: "goal_update",
						payload: {},
						session_id: req.session_id,
						runtime_binding_digest: req.runtime_binding_digest,
						agent_ontology_binding_digest: `sha256:${"0".repeat(64)}`,
					},
					req,
				),
			AgentResultValidationFault,
		);
	});

	it("rejects oversized untrusted output before terminal/session persistence", () => {
		const req = request();
		const candidate = result(req);
		candidate.output = "x".repeat(1024 * 1024 + 1);
		assert.throws(() => validateCanonicalAgentSpawnResult(candidate, req), /output exceeds the host byte fence/);
	});
});

function digest(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value as Record<string, unknown>)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
