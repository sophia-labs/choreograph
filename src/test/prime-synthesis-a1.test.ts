import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalDigest } from "@sophia-labs/canonical-json";
import { createMeaningfulObjectRef } from "../agent-runtime/meaningful-object.js";
import { PRIME_RUNTIME_STATE_SCHEMA, validateCanonicalAgentSpawnResult } from "../agent-runtime/result-validation.js";
import type { AgentSpawnRequest } from "../wire-protocol.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

const MEANINGFUL_OBJECT_DIGEST = "sha256:423544dd87815a0b10d8e0453a22eff4a21c5e3f9d3d4bfc6aae06e29ef4d185";
const RUNTIME_BINDING_DIGEST = "sha256:e708c1f9d3897119585438a43bb311c080ca05396f674f397714005cf9e1848d";
const ONTOLOGY_BINDING_DIGEST = "sha256:00009af36856031f510c90cfe9bf0c1ae6ec2d29e7f0833cafb8294aec89bebc";
const PRIME_STATE_DIGEST = "sha256:a79134e97dd0d67ece7f4c00b1ef5fe00f5f85269b6a8a042fcf88d58ea00e34";

describe("Prime Synthesis admission digest contract", () => {
	it("pins all four digests after the runtime binding v2 migration", () => {
		const meaningfulValue = {
			z: [3, { beta: true, alpha: null }],
			a: "Sophia",
			nested: { two: 2, one: 1 },
		};
		const ref = createMeaningfulObjectRef({
			kind: "testimony",
			ownerPrincipal: "user:test",
			graphId: "g1",
			objectId: "canonical-vector",
			version: "1",
			value: meaningfulValue,
		});
		assert.equal(ref.digest, MEANINGFUL_OBJECT_DIGEST);

		const semantic = makeTestAgentSemanticBinding({ kind: "prime", registeredName: "canonical-vector" });
		assert.equal(semantic.runtimeBindingDigest, RUNTIME_BINDING_DIGEST);
		assert.equal(semantic.ontologyBindingDigest, ONTOLOGY_BINDING_DIGEST);

		const request = requestFixture(semantic);
		const unsignedState = {
			schema: PRIME_RUNTIME_STATE_SCHEMA,
			sessionId: request.session_id,
			sandboxId: request.spawn_id,
			generation: request.generation,
			runtimeBindingDigest: request.runtime_binding_digest,
			ontologyBindingDigest: request.agent_ontology_binding_digest,
			sessionHeader: { type: "session", version: 3, id: request.session_id, cwd: "/workspace" },
			entries: [{ type: "message", role: "user", content: "hello" }],
			goal: null,
			autonomous: { enabled: false },
			workerSequence: 7,
			createdAt: "2026-08-07T00:00:00.000Z",
		};
		assert.equal(`sha256:${canonicalDigest(unsignedState)}`, PRIME_STATE_DIGEST);
		assert.doesNotThrow(() =>
			validateCanonicalAgentSpawnResult(
				{
					spawn_id: request.spawn_id,
					status: "terminated",
					output: "ok",
					turns: 1,
					session_id: request.session_id,
					runtime_binding_digest: request.runtime_binding_digest,
					agent_ontology_binding_digest: request.agent_ontology_binding_digest,
					prime_state: { ...unsignedState, digest: PRIME_STATE_DIGEST },
				},
				request,
			),
		);
	});
});

function requestFixture(semantic: ReturnType<typeof makeTestAgentSemanticBinding>): AgentSpawnRequest {
	return {
		spawn_id: "sandbox-vector",
		session_id: "session-vector",
		generation: 3,
		intent: "validate canonical identity",
		wards: { max_turns: 24, max_depth: 2, require_done_tool: true },
		mnemosyne: {
			mcp_url: "disabled",
			session_token: "disabled",
			graph_scope: { default_graph_id: "g1" },
			tool_profile: "chat",
			expires_at: "2030-01-01T00:00:00.000Z",
		},
		medium: "conversation",
		model: "mock:done",
		agent_id: semantic.agentId,
		depth: 0,
		runtime_binding: semantic.runtime,
		runtime_binding_digest: semantic.runtimeBindingDigest,
		agent_ontology: semantic.ontology,
		agent_ontology_binding_digest: semantic.ontologyBindingDigest,
	};
}
