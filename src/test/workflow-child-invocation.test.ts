import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BoundedChildInvocationMediator, type ChildInvocationDispatch } from "../workflow/child-invocation.js";
import type { DomainAgentProgramBindingV1 } from "../workflow/domain-agent-config.js";
import { INVOCATION_RECEIPT_SCHEMA, type InvocationEnvelopeV1, InvocationFault } from "../workflow/invocation.js";

const DIGEST = "c".repeat(64);
const PROGRAM: DomainAgentProgramBindingV1 = {
	programId: "acceptance",
	title: "Acceptance journey",
	description: "Exercise one claim.",
	workflowName: "acceptance-v1",
	workflowUri: "urn:sophia:wf:acceptance-v1",
	definitionDigest: DIGEST,
	inputSchema: {
		type: "object",
		required: ["claimRef", "graphId"],
		properties: { claimRef: { type: "string" }, graphId: { type: "string" } },
		additionalProperties: false,
	},
	authority: {
		capability: "workflow",
		operation: "loom_run",
		access: "write",
		resourceRef: "shrubbery:program:acceptance-v1",
	},
	graph: { mode: "input-field", inputField: "graphId" },
};

const TOOLBELT = {
	schema: "sophia.granted-toolbelt.v1" as const,
	grantId: "grant-shrub-1",
	grantDigest: "a".repeat(64),
	manifestId: "atm-shrub-1",
	manifestHash: "b".repeat(64),
	agentId: "agent-shrub-1",
	tools: [],
	capabilities: [
		{
			capability: "workflow",
			operations: ["loom_run"],
			access: "write" as const,
			approvalPolicy: "ordinary" as const,
			fence: {
				graphIdPrefixes: ["obs-hoja-"],
				resourcePrefixes: ["shrubbery:program:"],
				maxPayloadBytes: 4096,
			},
			quota: { maxPerWave: 1, maxConcurrent: 1 },
		},
	],
	suppressions: [],
	failures: [],
	resolvedAt: 1000,
};

function receipt(envelope: InvocationEnvelopeV1) {
	return {
		schema: INVOCATION_RECEIPT_SCHEMA,
		invocationId: envelope.invocationId,
		target: envelope.target,
		execution: {
			schema: "choreograph.execution-binding.v1" as const,
			controller: "program" as const,
			modelUse: "none" as const,
			isolation: "sandbox" as const,
			effects: "pure" as const,
			reproducibility: "pure" as const,
			runtime: { kind: "node" as const },
			capabilities: [],
			authority: { minimumRole: "editor" as const, dangerousOps: false },
			mayInvokeChildren: false,
		},
		status: "completed" as const,
		startedAt: 1100,
		endedAt: 1200,
		durationMs: 100,
		output: { verdict: "PASS" },
		childInvocationIds: [],
		effects: [],
		usage: { agentCount: 0, totalTokens: 0 },
	};
}

function mediator(dispatch: ChildInvocationDispatch, max = 1) {
	return new BoundedChildInvocationMediator({
		parentRunId: "wfr-parent",
		parentInvocationId: "inv-parent",
		actorRef: "user:ada",
		graphId: "shrubbery-domain",
		graphOwnerPrincipal: "user:ada",
		programs: [PROGRAM],
		toolbelt: TOOLBELT,
		maxChildInvocations: max,
		parentDeadlineMs: 5000,
		now: () => 1000,
		dispatch,
	});
}

describe("bounded Domain Agent child invocation", () => {
	it("derives a witnessed child envelope from the exact graph-bound target", async () => {
		const envelopes: InvocationEnvelopeV1[] = [];
		const subject = mediator(async (envelope) => {
			envelopes.push(envelope);
			return {
				invocationId: envelope.invocationId,
				status: "completed" as const,
				output: { verdict: "PASS" },
				receipt: receipt(envelope),
			};
		});
		const result = await subject.invoke({
			workflowName: PROGRAM.workflowName,
			workflowUri: PROGRAM.workflowUri,
			definitionDigest: PROGRAM.definitionDigest,
			input: { claimRef: "urn:claim:1", graphId: "obs-hoja-proof" },
			idempotencyKey: "pilot-must-not-control-this",
			deadlineMs: 4500,
		});

		assert.match(result.invocationId, /^inv-child-[0-9a-f]{32}$/);
		assert.deepEqual(subject.invocationIds, [result.invocationId]);
		assert.equal(envelopes.length, 1);
		const envelope = envelopes[0];
		assert.equal(envelope.actorRef, "user:ada");
		assert.deepEqual(envelope.graph, { graphId: "obs-hoja-proof", ownerPrincipal: "user:ada" });
		assert.deepEqual(envelope.cause, {
			kind: "invocation",
			ref: "wfr-parent",
			parentInvocationId: "inv-parent",
		});
		assert.match(envelope.idempotencyKey ?? "", /^child:[0-9a-f]{64}$/);
		assert.notEqual(envelope.idempotencyKey, "pilot-must-not-control-this");
		assert.equal(envelope.deadlineMs, 4500);
		assert.deepEqual(envelope.budget, { maxChildInvocations: 0 });
	});

	it("rejects a pilot-selected target or input outside the graph binding", async () => {
		let dispatches = 0;
		const subject = mediator(async () => {
			dispatches++;
			throw new Error("unreachable");
		});
		await assert.rejects(
			subject.invoke({
				workflowName: PROGRAM.workflowName,
				workflowUri: "urn:sophia:wf:other",
				definitionDigest: PROGRAM.definitionDigest,
				input: { claimRef: "urn:claim:1", graphId: "obs-hoja-proof" },
			}),
			(error: unknown) => error instanceof InvocationFault && error.code === "child_target_denied",
		);
		await assert.rejects(
			subject.invoke({
				workflowName: PROGRAM.workflowName,
				workflowUri: PROGRAM.workflowUri,
				definitionDigest: PROGRAM.definitionDigest,
				input: { unexpected: true },
			}),
			(error: unknown) => error instanceof InvocationFault && error.code === "invalid_input",
		);
		await assert.rejects(
			subject.invoke({
				workflowName: PROGRAM.workflowName,
				workflowUri: PROGRAM.workflowUri,
				definitionDigest: PROGRAM.definitionDigest,
				input: { claimRef: "urn:claim:1", graphId: "other-graph" },
			}),
			(error: unknown) => error instanceof InvocationFault && error.code === "child_authority_denied",
		);
		assert.equal(dispatches, 0);
	});

	it("spends the bounded child budget once and requires an exact receipt", async () => {
		const subject = mediator(async (envelope) => ({
			invocationId: envelope.invocationId,
			status: "completed" as const,
			output: {},
			receipt: receipt(envelope),
		}));
		const request = {
			workflowName: PROGRAM.workflowName,
			workflowUri: PROGRAM.workflowUri,
			definitionDigest: PROGRAM.definitionDigest,
			input: { claimRef: "urn:claim:1", graphId: "obs-hoja-proof" },
		};
		await subject.invoke(request);
		await assert.rejects(
			subject.invoke(request),
			(error: unknown) => error instanceof InvocationFault && error.code === "child_budget_exhausted",
		);

		const contested = mediator(async (envelope) => ({
			invocationId: envelope.invocationId,
			status: "completed" as const,
			receipt: { ...receipt(envelope), invocationId: "inv-wrong" },
		}));
		await assert.rejects(
			contested.invoke(request),
			(error: unknown) => error instanceof InvocationFault && error.code === "child_receipt_invalid",
		);
		assert.deepEqual(contested.invocationIds, []);
	});
});
