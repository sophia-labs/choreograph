import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeAgentRuntimeDispatcher, makeStaticAgentRuntimeResolver } from "../agent-runtime/dispatch.js";
import {
	MEANINGFUL_OBJECT_REF_SCHEMA,
	type MeaningfulObjectKind,
	type MeaningfulObjectRefV1,
} from "../agent-runtime/meaningful-object.js";
import { AGENT_ONTOLOGY_BINDING_SCHEMA, type AgentOntologyBindingV1 } from "../agent-runtime/ontology-binding.js";
import {
	AGENT_RUNTIME_BINDING_SCHEMA,
	AGENT_RUNTIME_PLATFORM_CEILINGS,
	AgentRuntimeBindingFault,
	type AgentRuntimeBindingV2,
	type AgentRuntimeBundleRefV1,
	digestAgentRuntimeBinding,
	PRIME_AGENT_RUNTIME_BASELINE,
	resolveAgentRuntimeBinding,
	SIMPLE_AGENT_RUNTIME_BASELINE,
} from "../agent-runtime/profile.js";
import { mintAgentUri, STANDALONE_AGENT_IDENTITY_ALGORITHM } from "../agent-subject/agent-ontology.js";
import type { AgentNodeResult, AgentNodeSpec, NodeRunner } from "../workflow/types.js";

const simpleBundle: AgentRuntimeBundleRefV1 = {
	id: "sophia-agent-runtime",
	digest: `sha256:${"a".repeat(64)}`,
};
const primeBundle: AgentRuntimeBundleRefV1 = {
	id: "sophia-agent-runtime",
	digest: `sha256:${"a".repeat(64)}`,
};
const bundles = { simple: simpleBundle, prime: primeBundle };
const agentId = "agent-0123456789abcdef";

function mo<Kind extends MeaningfulObjectKind>(
	kind: Kind,
	objectId: string,
	digestCharacter: string,
): MeaningfulObjectRefV1<Kind> {
	return {
		schema: MEANINGFUL_OBJECT_REF_SCHEMA,
		kind,
		ownerPrincipal: "user:test",
		graphId: "g1",
		objectId,
		version: "1",
		digest: `sha256:${digestCharacter.repeat(64)}`,
	};
}

const simpleRuntimeProfileRef = mo("agent-runtime-profile", "profile-simple", "8");
const runtimeProfileRef = mo("agent-runtime-profile", "profile-prime-researcher", "c");
const simpleProfile: AgentRuntimeBindingV2 = {
	schema: AGENT_RUNTIME_BINDING_SCHEMA,
	kind: "simple",
	bundle: simpleBundle,
	profileRef: simpleRuntimeProfileRef,
	constraints: SIMPLE_AGENT_RUNTIME_BASELINE,
};
const primeProfile: AgentRuntimeBindingV2 = {
	schema: AGENT_RUNTIME_BINDING_SCHEMA,
	kind: "prime",
	bundle: primeBundle,
	profileRef: runtimeProfileRef,
	constraints: PRIME_AGENT_RUNTIME_BASELINE,
};

function ontologyFor(profileRef: MeaningfulObjectRefV1<"agent-runtime-profile">): AgentOntologyBindingV1 {
	return {
		schema: AGENT_ONTOLOGY_BINDING_SCHEMA,
		subject: {
			agentId,
			agentUri: mintAgentUri(agentId),
			observerId: agentId,
			registeredName: "prime-researcher",
			identityAlgorithm: STANDALONE_AGENT_IDENTITY_ALGORITHM,
		},
		objects: {
			agent: mo("agent", "agent-prime-researcher", "1"),
			geist: mo("geist", "geist-prime-researcher", "2"),
			prompt: mo("prompt", "prompt-prime-researcher", "3"),
			skills: [mo("skill", "skill-edit", "4")],
			harness: mo("harness", "harness-prime-researcher", "5"),
			toolManifest: mo("tool-manifest", "tools-prime-researcher", "6"),
			toolGrant: mo("tool-grant", "grant-prime-researcher", "7"),
			runtimeProfile: profileRef,
		},
		resolvedAt: 1,
	};
}

const ontology = ontologyFor(runtimeProfileRef);
const simpleOntology = ontologyFor(simpleRuntimeProfileRef);

const spec: AgentNodeSpec = {
	label: "node",
	phaseIndex: 1,
	prompt: "do the thing",
	model: "mock:done",
	graphId: "g1",
	agentId,
	runtime: simpleProfile,
	ontology: simpleOntology,
};
const profilesByDigest = new Map([
	[simpleRuntimeProfileRef.digest, simpleProfile],
	[runtimeProfileRef.digest, primeProfile],
]);

function result(input: AgentNodeSpec): AgentNodeResult {
	return {
		label: input.label,
		phaseIndex: input.phaseIndex,
		state: "done",
		output: "ok",
		model: input.model,
		turns: 1,
		toolCalls: 0,
		tokens: 1,
		queuedAt: 1,
		startedAt: 1,
		durationMs: 1,
	};
}

describe("agent runtime binding", () => {
	it("resolves an explicit simple profile Meaningful Object without defaulting the kind", () => {
		const binding = resolveAgentRuntimeBinding(
			{ kind: "simple", profileRef: simpleRuntimeProfileRef },
			{ bundles, profile: simpleProfile },
		);
		assert.equal(binding.schema, AGENT_RUNTIME_BINDING_SCHEMA);
		assert.equal(binding.kind, "simple");
		assert.deepEqual(binding.bundle, simpleBundle);
		assert.equal(binding.constraints.maxTurns, 6);
		assert.equal(binding.constraints.maxChildren, 0);
		assert.equal(binding.constraints.allowPersistentKernel, false);
	});

	it("attenuates a host-resolved Prime profile and preserves its semantic ref", () => {
		const profile: AgentRuntimeBindingV2 = {
			schema: AGENT_RUNTIME_BINDING_SCHEMA,
			kind: "prime",
			bundle: primeBundle,
			profileRef: {
				schema: MEANINGFUL_OBJECT_REF_SCHEMA,
				kind: "agent-runtime-profile",
				ownerPrincipal: "user:test",
				graphId: "g1",
				objectId: "profile-prime-researcher",
				version: "3",
				digest: `sha256:${"c".repeat(64)}`,
			},
			constraints: {
				maxTurns: 20,
				maxWallTimeMs: 600_000,
				maxTokens: 80_000,
				maxCostUsdMicros: 900_000,
				maxChildren: 4,
				maxChildDepth: 2,
				maxConcurrentChildren: 2,
				maxArtifactBytes: 200_000_000,
				idlePassivateMs: 60_000,
				allowPersistentKernel: true,
				allowAutonomousContinuation: false,
				allowSchedules: false,
				allowWorkflowProposals: true,
			},
		};
		const binding = resolveAgentRuntimeBinding(
			{
				kind: "prime",
				profileRef: profile.profileRef,
				constraints: {
					maxTurns: 8,
					maxChildren: 1,
					maxChildDepth: 1,
					maxConcurrentChildren: 1,
					allowAutonomousContinuation: false,
					allowSchedules: false,
				},
			},
			{ bundles, profile },
		);
		assert.equal(binding.constraints.maxTurns, 8);
		assert.equal(binding.constraints.maxChildren, 1);
		assert.equal(binding.constraints.allowPersistentKernel, true);
		assert.equal(binding.constraints.allowAutonomousContinuation, false);
		assert.deepEqual(binding.profileRef, profile.profileRef);
	});

	it("admits an explicit Prime schedule grant without widening any default or simple profile", () => {
		assert.equal(SIMPLE_AGENT_RUNTIME_BASELINE.allowSchedules, false);
		assert.equal(PRIME_AGENT_RUNTIME_BASELINE.allowSchedules, false);
		assert.equal(AGENT_RUNTIME_PLATFORM_CEILINGS.simple.allowSchedules, false);
		assert.equal(AGENT_RUNTIME_PLATFORM_CEILINGS.prime.allowSchedules, true);

		const scheduleGrant: AgentRuntimeBindingV2 = {
			...primeProfile,
			constraints: { ...primeProfile.constraints, allowSchedules: true },
		};
		const granted = resolveAgentRuntimeBinding(
			{ kind: "prime", profileRef: runtimeProfileRef },
			{ bundles, profile: scheduleGrant },
		);
		assert.equal(granted.constraints.allowSchedules, true);

		const attenuated = resolveAgentRuntimeBinding(
			{ kind: "prime", profileRef: runtimeProfileRef, constraints: { allowSchedules: false } },
			{ bundles, profile: scheduleGrant },
		);
		assert.equal(attenuated.constraints.allowSchedules, false);

		assert.throws(
			() =>
				resolveAgentRuntimeBinding(
					{ kind: "simple", profileRef: simpleRuntimeProfileRef },
					{
						bundles,
						profile: {
							...simpleProfile,
							constraints: { ...simpleProfile.constraints, allowSchedules: true },
						},
					},
				),
			AgentRuntimeBindingFault,
		);
	});

	it("rejects numeric and boolean privilege widening", () => {
		assert.throws(
			() =>
				resolveAgentRuntimeBinding(
					{ kind: "prime", profileRef: runtimeProfileRef },
					{
						bundles,
						profile: {
							...primeProfile,
							constraints: { ...primeProfile.constraints, allowAutonomousContinuation: true },
						},
					},
				),
			/host platform ceiling/,
		);
		assert.throws(
			() =>
				resolveAgentRuntimeBinding(
					{ kind: "simple", profileRef: simpleRuntimeProfileRef, constraints: { maxTurns: 7 } },
					{ bundles, profile: simpleProfile },
				),
			AgentRuntimeBindingFault,
		);
		assert.throws(
			() =>
				resolveAgentRuntimeBinding(
					{ kind: "simple", profileRef: simpleRuntimeProfileRef },
					{
						bundles,
						profile: {
							...simpleProfile,
							constraints: { ...simpleProfile.constraints, allowWorkflowProposals: true },
						},
					},
				),
			AgentRuntimeBindingFault,
		);
		assert.throws(
			() =>
				resolveAgentRuntimeBinding(
					{ kind: "simple", profileRef: simpleRuntimeProfileRef, constraints: { allowPersistentKernel: true } },
					{ bundles, profile: simpleProfile },
				),
			AgentRuntimeBindingFault,
		);
		assert.throws(
			() =>
				resolveAgentRuntimeBinding(
					{
						kind: "simple",
						profileRef: simpleRuntimeProfileRef,
						bundle: { ...simpleBundle, digest: `sha256:${"f".repeat(64)}` },
					},
					{ bundles, profile: simpleProfile },
				),
			AgentRuntimeBindingFault,
		);
	});

	it("rejects the excised workspace promise and the v1 binding schema", () => {
		assert.throws(
			() =>
				resolveAgentRuntimeBinding(
					{
						kind: "prime",
						profileRef: runtimeProfileRef,
						constraints: { maxWorkspaceBytes: 1 } as never,
					},
					{ bundles, profile: primeProfile },
				),
			(error: unknown) =>
				error instanceof AgentRuntimeBindingFault &&
				JSON.stringify(error.details) === JSON.stringify({ unknown: ["maxWorkspaceBytes"] }),
		);
		assert.throws(
			() =>
				resolveAgentRuntimeBinding(
					{
						schema: "choreograph.agent-runtime-binding.v1",
						kind: "prime",
						profileRef: runtimeProfileRef,
					} as never,
					{ bundles, profile: primeProfile },
				),
			/unsupported runtime binding schema/,
		);
	});

	it("rejects a profile reference that differs from the host-resolved Meaningful Object", () => {
		assert.throws(
			() =>
				resolveAgentRuntimeBinding(
					{
						kind: "prime",
						profileRef: {
							schema: MEANINGFUL_OBJECT_REF_SCHEMA,
							kind: "agent-runtime-profile",
							ownerPrincipal: "user:test",
							graphId: "g",
							objectId: "p",
							version: "1",
							digest: `sha256:${"d".repeat(64)}`,
						},
					},
					{ bundles, profile: primeProfile },
				),
			/node profileRef does not match the host-resolved profile/,
		);
	});

	it("produces a stable digest independent of object insertion order", () => {
		const first = resolveAgentRuntimeBinding(
			{ kind: "prime", profileRef: runtimeProfileRef, constraints: { maxTurns: 8 } },
			{ bundles, profile: primeProfile },
		);
		const second = {
			constraints: { ...first.constraints },
			profileRef: { ...first.profileRef },
			bundle: { ...first.bundle },
			kind: first.kind,
			schema: first.schema,
		} satisfies AgentRuntimeBindingV2;
		assert.equal(digestAgentRuntimeBinding(first), digestAgentRuntimeBinding(second));
	});
});

describe("agent runtime dispatcher", () => {
	it("routes simple and Prime profiles through one semantic core and records runtime evidence", async () => {
		const calls: AgentRuntimeBindingV2["kind"][] = [];
		const run: NodeRunner = async (input) => {
			assert.ok(input.runtime);
			calls.push(input.runtime.kind);
			if (input.runtime?.kind === "simple") assert.equal(input.maxTurns, 6);
			return result(input);
		};
		const runner = makeAgentRuntimeDispatcher({
			resolve: makeStaticAgentRuntimeResolver({
				bundles,
				profilesByDigest,
			}),
			run,
		});

		const simpleResult = await runner(spec);
		const primeResult = await makeAgentRuntimeDispatcher({
			resolve: makeStaticAgentRuntimeResolver({
				bundles,
				profilesByDigest,
			}),
			run,
		})({
			...spec,
			label: "prime",
			agentId,
			runtime: primeProfile,
			ontology,
		});
		assert.deepEqual(calls, ["simple", "prime"]);
		assert.equal(simpleResult.runtime?.kind, "simple");
		assert.equal(primeResult.runtime?.kind, "prime");
		assert.match(primeResult.runtime?.bindingDigest ?? "", /^sha256:[0-9a-f]{64}$/);
	});

	it("requires both simple and Prime nodes to carry a pinned Agent Ontology binding", async () => {
		const runner = makeAgentRuntimeDispatcher({
			resolve: makeStaticAgentRuntimeResolver({
				bundles,
				profilesByDigest,
			}),
			run: async (input) => result(input),
		});
		await assert.rejects(
			() => runner({ ...spec, ontology: undefined }),
			(error: unknown) =>
				error instanceof Error && (error as Error & { code?: string }).code === "agent_ontology_binding_required",
		);
		await assert.rejects(
			() => runner({ ...spec, ontology: undefined, runtime: primeProfile }),
			(error: unknown) =>
				error instanceof Error && (error as Error & { code?: string }).code === "agent_ontology_binding_required",
		);
	});

	it("rejects an unbound node instead of manufacturing a simple profile", async () => {
		const runner = makeAgentRuntimeDispatcher({
			resolve: makeStaticAgentRuntimeResolver({ bundles, profilesByDigest }),
			run: async (input) => result(input),
		});
		await assert.rejects(() => runner({ ...spec, runtime: undefined }), AgentRuntimeBindingFault);
	});
});
