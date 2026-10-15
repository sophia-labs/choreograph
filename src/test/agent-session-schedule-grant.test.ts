import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AGENT_SESSION_SCHEDULE_GRANT_SNAPSHOT_SCHEMA,
	type AgentSessionScheduleGrantBindingV1,
	type AgentSessionScheduleGrantSnapshotV1,
	bindAgentSessionScheduleGrantSnapshot,
	parseAgentSessionScheduleGrantBinding,
	verifyAgentSessionScheduleGrantBinding,
} from "../workflow/agent-session-schedule-grant.js";
import { type AgentToolGrantV1, type GrantedToolbeltV1, grantDigest } from "../workflow/agent-tool-grant.js";
import type { MountedTool } from "../workflow/agent-tool-manifest.js";

const NOW = 1_700_000_000_000;

describe("G2 durable scheduled grant binding", () => {
	it("parses and verifies a deterministic rich authority fixture", () => {
		const binding = fixture();
		const parsed = parseAgentSessionScheduleGrantBinding(binding);
		const snapshot = verifyAgentSessionScheduleGrantBinding(parsed, identity());
		assert.deepEqual(snapshot, binding.snapshot);
		assert.equal(snapshot.grant.capabilities.length, 2);
		assert.equal(snapshot.grant.capabilities[0]?.fence.requiredScopeSchema, "sophia.discord-capability-scope.v2");
		assert.equal(snapshot.grant.capabilities[0]?.fence.requiredDatasetObjectKind, "dataset-epoch");
		assert.deepEqual(
			snapshot.toolbelt.tools.map((tool) => [tool.name, tool.destructive]),
			[
				["recall", false],
				["remember", true],
			],
		);
	});

	it("rejects the adversarial mutation table at the trust boundary", () => {
		const mutations: ReadonlyArray<readonly [string, (binding: AgentSessionScheduleGrantBindingV1) => void]> = [
			["unknown binding key", (binding) => setField(binding, "poison", true)],
			["unknown snapshot key", (binding) => setField(binding.snapshot, "extra", true)],
			["credential-like key", (binding) => setField(binding, "apiToken", "do-not-store")],
			["NUL in owner", (binding) => setField(binding.snapshot, "ownerUserId", "ada\0evil")],
			["binding digest drift", (binding) => setField(binding, "digest", "0".repeat(64))],
			["runtime digest drift", (binding) => setField(binding.snapshot, "runtimeBindingDigest", "e".repeat(64))],
			["subject drift", (binding) => setField(binding.snapshot.grant, "subjectAgentId", "agent-other")],
			["owner drift", (binding) => setField(binding.snapshot, "graphOwnerPrincipal", "user:other")],
			["graph drift", (binding) => setField(binding.snapshot.grant, "authorityGraphId", "other-graph")],
			["grant digest drift", (binding) => setField(binding.snapshot.toolbelt, "grantDigest", "f".repeat(64))],
			["manifest digest drift", (binding) => setField(binding.snapshot.toolbelt, "manifestHash", "f".repeat(64))],
			[
				"unknown fence field",
				(binding) => {
					const fence = binding.snapshot.grant.capabilities[0]?.fence as Record<string, unknown>;
					setField(fence, "unrecognizedPhanesFence", "poison");
					Object.assign(binding, bindAgentSessionScheduleGrantSnapshot(binding.snapshot));
				},
			],
			[
				"empty required scope schema",
				(binding) => {
					const fence = binding.snapshot.grant.capabilities[0]?.fence as Record<string, unknown>;
					setField(fence, "requiredScopeSchema", "");
					Object.assign(binding, bindAgentSessionScheduleGrantSnapshot(binding.snapshot));
				},
			],
			[
				"oversize required dataset object kind",
				(binding) => {
					const fence = binding.snapshot.grant.capabilities[0]?.fence as Record<string, unknown>;
					setField(fence, "requiredDatasetObjectKind", "x".repeat(257));
					Object.assign(binding, bindAgentSessionScheduleGrantSnapshot(binding.snapshot));
				},
			],
			[
				"destructive projection drift",
				(binding) => {
					const tool = binding.snapshot.toolbelt.tools[0] as unknown as Record<string, unknown>;
					setField(tool, "destructive", true);
					Object.assign(binding, bindAgentSessionScheduleGrantSnapshot(binding.snapshot));
				},
			],
			[
				"tool capability drift",
				(binding) => {
					const tool = binding.snapshot.toolbelt.tools[0] as unknown as Record<string, unknown>;
					setField(tool, "capability", "cap-unknown");
					Object.assign(binding, bindAgentSessionScheduleGrantSnapshot(binding.snapshot));
				},
			],
			[
				"required tool failure",
				(binding) => {
					const toolbelt = binding.snapshot.toolbelt as unknown as Record<string, unknown>;
					setField(toolbelt, "failures", [{ name: "recall", reason: "missing implementation", required: true }]);
					Object.assign(binding, bindAgentSessionScheduleGrantSnapshot(binding.snapshot));
				},
			],
			[
				"grant expired",
				(binding) => {
					setField(binding.snapshot.grant, "expiresAt", NOW);
					Object.assign(binding, bindAgentSessionScheduleGrantSnapshot(binding.snapshot));
				},
			],
		];

		for (const [label, mutate] of mutations) {
			const candidate = structuredClone(fixture()) as AgentSessionScheduleGrantBindingV1;
			mutate(candidate);
			assert.throws(() => verifyAgentSessionScheduleGrantBinding(candidate, identity()), undefined, label);
		}
	});

	it("rejects a Session identity mismatch even when the binding itself is valid", () => {
		assert.throws(
			() => verifyAgentSessionScheduleGrantBinding(fixture(), { ...identity(), graphId: "other-graph" }),
			/graphId does not match/,
		);
	});
});

function identity() {
	return {
		agentId: "agent-prime",
		runtimeBindingDigest: `sha256:${"1".repeat(64)}`,
		agentOntologyDigest: `sha256:${"2".repeat(64)}`,
		ownerUserId: "ada",
		graphOwnerPrincipal: "user:ada",
		graphId: "prime-notebook-lab",
		now: NOW,
	} as const;
}

function fixture(): AgentSessionScheduleGrantBindingV1 {
	const readCapability = {
		capability: "mnemosyne",
		operations: ["recall"],
		access: "read" as const,
		approvalPolicy: "ordinary" as const,
		fence: {
			graphIds: ["prime-notebook-lab"],
			requiredScopeSchema: "sophia.discord-capability-scope.v2",
			requiredDatasetObjectKind: "dataset-epoch",
		},
		quota: { maxPerWave: 10 },
	};
	const writeCapability = {
		capability: "mnemosyne-write",
		operations: ["remember"],
		access: "write" as const,
		approvalPolicy: "notify" as const,
		operationPolicies: { remember: "notify" as const },
		fence: { graphIds: ["prime-notebook-lab"], maxPayloadBytes: 10_000 },
		quota: { maxPerDay: 100, maxConcurrent: 2 },
	};
	const grant: AgentToolGrantV1 = {
		schema: "sophia.agent-toolbelt-grant.v1",
		grantId: "grant-prime-1",
		subjectAgentId: "agent-prime",
		issuedBy: "user:ada",
		authorityGraphId: "prime-notebook-lab",
		issuedAt: NOW - 1_000,
		notBefore: NOW - 500,
		expiresAt: NOW + 86_400_000,
		status: "active",
		capabilities: [readCapability, writeCapability],
		sourceRefs: ["urn:sophia:grant:prime-1"],
	};
	const tools: MountedTool[] = [
		tool("recall", "mnemosyne", "read", false),
		tool("remember", "mnemosyne-write", "write", true),
	];
	const toolbelt: GrantedToolbeltV1 = {
		schema: "sophia.granted-toolbelt.v1",
		grantId: grant.grantId,
		grantDigest: grantDigest(grant),
		manifestId: "manifest-prime-1",
		manifestHash: "3".repeat(64),
		agentId: grant.subjectAgentId,
		tools,
		capabilities: grant.capabilities,
		suppressions: [],
		failures: [],
		resolvedAt: NOW - 500,
	};
	const snapshot: AgentSessionScheduleGrantSnapshotV1 = {
		schema: AGENT_SESSION_SCHEDULE_GRANT_SNAPSHOT_SCHEMA,
		agentId: "agent-prime",
		runtimeBindingDigest: `sha256:${"1".repeat(64)}`,
		agentOntologyDigest: `sha256:${"2".repeat(64)}`,
		ownerUserId: "ada",
		graphOwnerPrincipal: "user:ada",
		graphId: "prime-notebook-lab",
		grantAuthorityGraphId: "prime-notebook-lab",
		grantAuthorityOwnerPrincipal: "user:ada",
		grantDocumentId: "doc-grant-prime-1",
		grant,
		toolbelt,
		capturedAt: NOW - 500,
	};
	return bindAgentSessionScheduleGrantSnapshot(snapshot);
}

function tool(name: string, capability: string, access: MountedTool["access"], destructive: boolean): MountedTool {
	return {
		toolId: `tool-${name}`,
		toolUri: `urn:sophia:agent:agent-prime:tool:${name}`,
		name,
		capability,
		access,
		destructive,
		risk: access === "write" ? "medium" : "low",
		required: true,
		approvalPolicy: { mode: "never" },
		runtimeState: "mounted",
		available: true,
	};
}

function setField(value: object, key: string, fieldValue: unknown): void {
	(value as Record<string, unknown>)[key] = fieldValue;
}
