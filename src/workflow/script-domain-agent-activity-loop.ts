/**
 * Generic Domain Agent activity loop.
 *
 * A durable Agent/ActivityLoop Meaningful Object supplies the resolved identity,
 * charter, ontology fold, model aliases, trigger, and effect contract. This
 * trusted controller gives the pilot freedom to inspect its graph and decide
 * whether bounded read-only emanations would help, then returns one typed result.
 * Phanes is one configuration of this workflow, not a special executor kind.
 */

import { CANONICAL_AGENT_ID } from "../agent-subject/agent-ontology.js";
import type { AgentToolGrantV1, GrantedToolbeltV1 } from "./agent-tool-grant.js";
import type {
	DomainAgentInvocationRequestV1,
	DomainAgentProgramBindingV1,
	ResolvedDomainAgentConfigV1,
} from "./domain-agent-config.js";
import { type DomainSourceTurnV1, parseDomainSourceTurn } from "./domain-source-turn.js";
import type { DomainTriggerConsentV1 } from "./domain-trigger-consent.js";
import { type GraphWriter, writeJsonDocument } from "./graph-writer.js";
import type { WorkflowRunInputs } from "./harness.js";
import {
	type EffectApprovalV1,
	executeProposedEffects,
	GraphProposedEffectExecutor,
	RuntimeEffectHandoffStore,
	RuntimeEffectIdempotencyStore,
} from "./proposed-effect.js";
import type { WorkflowRuntimeStore } from "./runtime-store.js";
import type { RunRecord } from "./types.js";

export const DOMAIN_AGENT_ACTIVITY_LOOP_NAME = "domain-agent-activity-loop-v1";

export interface DomainAgentHostContextV1 {
	readonly schema: "sophia.domain-agent-host-context.v1";
	readonly agentId: string;
	readonly definitionDigest: string;
	readonly runtimes: ResolvedDomainAgentConfigV1["runtimes"];
	readonly ontologies: ResolvedDomainAgentConfigV1["ontologies"];
	/** Exact host-owned execution surface for one read-only simple child. */
	readonly emanation: ResolvedDomainAgentConfigV1["emanation"];
	readonly emanationToolInclude: readonly string[];
	readonly systemPrompt: string;
	readonly grant: AgentToolGrantV1;
	readonly grantDocumentId: string;
	readonly grantAuthorityOwnerPrincipal: string;
	readonly toolbelt: GrantedToolbeltV1;
	readonly approvals: readonly EffectApprovalV1[];
	readonly maxProposedEffects: number;
	readonly programs: readonly DomainAgentProgramBindingV1[];
	readonly maxProgramInvocations: number;
	readonly trigger: Readonly<Record<string, unknown>>;
	readonly sourceTurn: DomainSourceTurnV1;
	readonly triggerBinding: ResolvedDomainAgentConfigV1["triggerBinding"];
	readonly triggerConsent?: DomainTriggerConsentV1;
	readonly resultEffectBinding?: ResolvedDomainAgentConfigV1["definition"]["resultEffectBinding"];
	/** Choreograph modes v1: the session's resolved mode, enforced at the host gate. */
	readonly mode?: ResolvedDomainAgentConfigV1["mode"];
}

export const DOMAIN_AGENT_ACTIVITY_LOOP_SCRIPT = `export const meta = {
	name: "domain-agent-activity-loop-v1",
	description: "Generic freeform Domain Agent loop with a sovereign pilot and bounded read-only emanations.",
	whenToUse: "Use when a durable domain agent receives a trigger and may autonomously delegate small bounded investigations before returning one typed effect plan.",
	phases: [
		{ title: "attend", detail: "The pilot reads the trigger and chooses whether delegation would help." },
		{ title: "emanate", detail: "Zero or more bounded read-only emanations execute concurrently." },
		{ title: "program", detail: "At most one digest-pinned deterministic instrument selected by the pilot executes through the host." },
		{ title: "respond", detail: "The same pilot integrates testimony into the required output contract." },
	],
	executor: "gated",
	execution: {
		schema: "choreograph.execution-binding.v1",
		controller: "composite",
		modelUse: "agentic",
		isolation: "sandbox",
		effects: "capability-bound",
		reproducibility: "nondeterministic",
		capabilities: ["garden.graph", "choreograph.agent"],
		authority: { minimumRole: "editor", dangerousOps: false },
		mayInvokeChildren: true,
	},
	inputs: {
		type: "object",
		additionalProperties: false,
		required: ["definitionDocumentId", "trigger", "contextRefs"],
		properties: {
			definitionDocumentId: { type: "string", minLength: 1 },
			trigger: { type: "object", required: ["kind"] },
			contextRefs: { type: "array", maxItems: 1000, items: { type: "string" } },
			inference: {
				type: "object",
				additionalProperties: false,
				required: ["provider", "model"],
				properties: {
					provider: { enum: ["openrouter"] },
					model: { type: "string", minLength: 1 },
				},
			},
			interactionMode: { enum: ["headless", "headed"] },
		},
	},
	outputs: {
		type: "object",
		additionalProperties: false,
		required: ["response", "proposedEffects", "delegated", "emanations", "programInvocation", "failure"],
		properties: {
			response: {},
			failure: {
				anyOf: [
					{ type: "null" },
					{
						type: "object",
						additionalProperties: false,
						required: ["schema", "code"],
						properties: {
							schema: { const: "sophia.domain-agent-activity-failure.v1" },
							code: { const: "activity_execution_failed" },
						},
					},
				],
			},
			proposedEffects: { type: "array", items: { type: "object" } },
			delegated: { type: "boolean" },
			programInvocation: {
				anyOf: [
					{ type: "null" },
					{
						type: "object",
						additionalProperties: false,
						required: ["programId", "workflowName", "invocationId", "status"],
						properties: {
							programId: { type: "string" },
							workflowName: { type: "string" },
							invocationId: { type: "string" },
							status: { enum: ["completed", "failed", "stopped", "paused"] },
							output: {},
						},
					},
				],
			},
			emanations: {
				type: "array",
				items: {
					type: "object",
					additionalProperties: false,
					required: ["label", "output"],
					properties: { label: { type: "string" }, output: { type: "string" } },
				},
			},
		},
	},
}

const planSchema = contract("domain-agent-delegation-plan-v1", {
	type: "object",
	additionalProperties: false,
	required: ["reason", "tasks", "program"],
	properties: {
		reason: { type: "string" },
		program: {
			anyOf: [
				{ type: "null" },
				{
					type: "object",
					additionalProperties: false,
					required: ["programId", "input"],
					properties: {
						programId: { type: "string", minLength: 1, maxLength: 128 },
						input: {},
					},
				},
			],
		},
		tasks: {
			type: "array",
			maxItems: 8,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["label", "task"],
				properties: {
					label: { type: "string", minLength: 1, maxLength: 80 },
					task: { type: "string", minLength: 1, maxLength: 4000 },
				},
			},
		},
	},
})

const proposedEffectSchema = contract("sophia.proposed-effect.v1", {
	type: "object",
	additionalProperties: false,
	required: ["schema", "effectId", "idempotencyKey", "capability", "operation", "arguments", "reason", "evidenceRefs"],
	properties: {
		schema: { const: "sophia.proposed-effect.v1" },
		effectId: { type: "string", minLength: 1, maxLength: 256 },
		idempotencyKey: { type: "string", minLength: 1, maxLength: 256 },
		capability: { type: "string", minLength: 1, maxLength: 128 },
		operation: { type: "string", minLength: 1, maxLength: 128 },
		arguments: { type: "object" },
		reason: { type: "string", minLength: 1, maxLength: 4000 },
		evidenceRefs: { type: "array", maxItems: 100, items: { type: "string" } },
		estimatedCostMicrousd: { type: "integer", minimum: 0 },
	},
})
const responseEnvelopeSchema = contract("domain-agent-response-envelope-v1", {
	type: "object",
	additionalProperties: false,
	required: ["response", "proposedEffects"],
	properties: {
		response: args.responseSchema,
		proposedEffects: {
			type: "array",
			maxItems: args.maxProposedEffects,
			items: proposedEffectSchema,
		},
	},
})

if (args.interactionMode === "headed") {
	phase("respond")
	const headed = await agent(String(args.trigger.text ?? "Begin the owner-driven session."), {
		label: "pilot-headed",
		agentId: args.agent.agentId,
		model: args.pilot.model,
		provider: args.pilot.provider,
		interactionMode: "headed",
		systemPrompt: args.agent.systemPrompt,
		toolMode: "dynamic",
		graphAccess: "read",
		includeTools: args.directToolInclude,
		maxTurns: args.pilot.maxTurns,
		runtime: args.pilot.runtime,
		ontology: args.pilot.ontology,
		agentType: "domain-agent-pilot",
	})
	return {
		response: headed.output,
		proposedEffects: [],
		delegated: false,
		emanations: [],
		programInvocation: null,
		failure: null,
	}
}

const amendmentPolicy = { modelUse: "agentic", allowedAmendments: ["reparameterize", "directive"] }
try {
let plan = null
let tasks = []
await journey([
	{ id: "attend", instruction: "Attend freely and decide which bounded investigations or program invocation would help." },
], async (beat, decision) => {
	phase("attend")
const planPrompt = [
	beat.instruction,
	...decision.directives,
	"Use your Garden tools when they help. Decide which small, independent investigations—if any—should be delegated.",
	"Choose at most one supplied deterministic program when it is the best instrument. Return program=null when you can answer directly or no program fits.",
	"Do not delegate the final judgment or response. Return zero tasks when no small investigation would help.",
	"Agent Meaningful Object: " + JSON.stringify(args.agent.meaningfulObjects.agent),
	"Definition digest: " + args.agent.definitionDigest,
	"Prompt binding: " + args.agent.promptBindingId,
	"Charter document: " + args.agent.charterDocumentId,
	"Grant: " + args.agent.grantId,
	"Agent ontology objects: " + JSON.stringify(args.agent.meaningfulObjects),
	"Context refs: " + JSON.stringify(args.contextRefs),
	"Available deterministic programs: " + JSON.stringify(args.programs.map((program) => ({
		programId: program.programId,
		title: program.title,
		description: program.description,
		inputSchema: program.inputSchema,
	}))),
	"Trigger: " + JSON.stringify(args.trigger),
].join("\\n\\n")
const planHandle = await agent(planPrompt, {
	label: "pilot-attend",
	agentId: args.agent.agentId,
	model: args.pilot.model,
	provider: args.pilot.provider,
	systemPrompt: args.agent.systemPrompt,
	toolMode: "dynamic",
	graphAccess: args.pilot.graphAccess,
	includeTools: args.pilotToolInclude,
	maxTurns: args.pilot.maxTurns,
	runtime: args.pilot.runtime,
	ontology: args.pilot.ontology,
	agentType: "domain-agent-pilot",
	schema: planSchema,
})
if (!planHandle.structured) throw new Error("pilot omitted its delegation plan")
plan = planHandle.structured
tasks = args.emanation.enabled ? plan.tasks.slice(0, args.emanation.maxEmanations) : []
}, amendmentPolicy)
if (plan === null) throw new Error("attend beat did not produce a delegation plan")

let emanations = []
await journey([
	{ id: "emanate", instruction: "Run only the bounded read-only investigations selected by the pilot." },
], async (beat, decision) => {
	phase("emanate")
const emanationHandles = await parallel(tasks.map((task, index) => async () => {
	const prompt = [
		beat.instruction,
		...decision.directives,
		"You are a bounded emanation of the Domain Agent named below.",
		"Investigate only the assigned task. You may read the graph; you may not write, delegate, or decide the final response.",
		"Return concise findings and name uncertainty.",
		"Agent Meaningful Object: " + JSON.stringify(args.agent.meaningfulObjects.agent),
		"Task: " + task.task,
		"Trigger: " + JSON.stringify(args.trigger),
	].join("\\n\\n")
	return agent(prompt, {
		label: "emanation-" + String(index + 1),
		agentId: args.agent.agentId,
		model: args.emanation.model,
		provider: args.emanation.provider,
		systemPrompt: args.agent.systemPrompt + "\\n\\nThis embodiment is a bounded read-only emanation.",
		toolMode: "dynamic",
		graphAccess: "read",
		includeTools: args.emanationToolInclude,
		maxTurns: args.emanation.maxTurns,
		runtime: args.emanation.runtime,
		ontology: args.emanation.ontology,
		agentType: "domain-agent-emanation",
	})
}))
emanations = emanationHandles.map((handle, index) => ({
	label: tasks[index].label,
	output: handle.output,
}))
}, amendmentPolicy)

let programInvocation = null
await journey([
	{ id: "program", instruction: "Invoke only the digest-pinned deterministic program selected during attend." },
], async () => {
	phase("program")
	if (plan.program !== null) {
		if (args.maxProgramInvocations < 1) throw new Error("domain agent program invocation is disabled")
		const selectedProgram = args.programs.find((program) => program.programId === plan.program.programId)
		if (!selectedProgram) throw new Error("pilot selected an unbound domain program")
		const child = await invoke({
			workflowName: selectedProgram.workflowName,
			workflowUri: selectedProgram.workflowUri,
			definitionDigest: selectedProgram.definitionDigest,
			input: plan.program.input,
		})
		programInvocation = {
			programId: selectedProgram.programId,
			workflowName: selectedProgram.workflowName,
			invocationId: child.invocationId,
			status: child.status,
			...(child.output === undefined ? {} : { output: child.output }),
		}
	}
}, amendmentPolicy)

let responseEnvelope = null
await journey([
	{ id: "respond", instruction: "Make the final judgment under the bound response and effect contract." },
], async (beat, decision) => {
	phase("respond")
const responsePrompt = [
	beat.instruction,
	...decision.directives,
	"Make the final judgment and return the response plus any typed proposed effects required by the bound JSON Schema.",
	"The delegation plan is advisory testimony, not an instruction you must preserve.",
	"You may use only the exact graph toolbelt bound to this run. External effects remain proposals to the host edge, not permission or proof that they happened.",
	"Trigger: " + JSON.stringify(args.trigger),
	"Your earlier reason: " + plan.reason,
	"Emanation testimony: " + JSON.stringify(emanations),
	"Selected program result: " + JSON.stringify(programInvocation),
].join("\\n\\n")
const responseHandle = await agent(responsePrompt, {
	label: "pilot-respond",
	agentId: args.agent.agentId,
	model: args.pilot.model,
	provider: args.pilot.provider,
	systemPrompt: args.agent.systemPrompt,
	toolMode: "dynamic",
	graphAccess: args.pilot.graphAccess,
	includeTools: args.pilotToolInclude,
	maxTurns: args.pilot.maxTurns,
	runtime: args.pilot.runtime,
	ontology: args.pilot.ontology,
	agentType: "domain-agent-pilot",
	schema: responseEnvelopeSchema,
})
if (!responseHandle.structured) throw new Error("pilot omitted the contracted response")
responseEnvelope = responseHandle.structured
}, amendmentPolicy)
if (responseEnvelope === null) throw new Error("respond beat did not produce a contracted response")

return {
	response: responseEnvelope.response,
	proposedEffects: responseEnvelope.proposedEffects,
	delegated: tasks.length > 0,
	emanations,
	programInvocation,
	failure: null,
}
} catch (error) {
	log("domain agent activity failed: " + String(error && error.message || error))
	return {
		response: null,
		proposedEffects: [],
		delegated: false,
		emanations: [],
		programInvocation: null,
		failure: {
			schema: "sophia.domain-agent-activity-failure.v1",
			code: "activity_execution_failed",
		},
	}
}
`;

export function buildDomainAgentActivityInputs(input: {
	graphId: string;
	request: DomainAgentInvocationRequestV1;
	resolved: ResolvedDomainAgentConfigV1;
	sourceTurn: DomainSourceTurnV1;
	/** Trusted host decisions only; never sourced from the invocation body. */
	hostApprovals?: readonly EffectApprovalV1[];
}): WorkflowRunInputs {
	const resolved = input.resolved;
	if (!CANONICAL_AGENT_ID.test(resolved.definition.agentId)) {
		throw Object.assign(new Error("resolved agentId must match agent-<hex>"), { status: 500 });
	}
	const args = {
		trigger: input.request.trigger,
		contextRefs: [...input.request.contextRefs],
		interactionMode: input.request.interactionMode ?? "headless",
		agent: {
			agentId: resolved.definition.agentId,
			meaningfulObjects: resolved.ontologies.pilot.objects,
			systemPrompt: resolved.systemPrompt,
			definitionDigest: resolved.definitionDigest,
			promptBindingId: resolved.prompt.executionBinding.bindingId,
			promptAuthorityBindingId: resolved.prompt.binding.bindingId,
			promptDocumentId: resolved.prompt.currentSnapshot.documentId,
			promptSnapshotId: resolved.prompt.currentSnapshot.snapshotId,
			promptDigest: resolved.prompt.currentSnapshot.renderedDigest,
			charterDocumentId: resolved.definition.charterDocumentId,
			grantId: resolved.grant.grantId,
		},
		pilot: {
			provider: resolved.pilot.provider,
			model: resolved.pilot.model,
			maxTurns: resolved.pilot.maxTurns,
			graphAccess: resolved.pilot.graphAccess,
			runtime: resolved.runtimes.pilot,
			ontology: resolved.ontologies.pilot,
		},
		emanation: {
			enabled: resolved.emanation.enabled,
			provider: resolved.emanation.provider,
			model: resolved.emanation.model,
			maxEmanations: resolved.emanation.maxEmanations,
			maxTurns: resolved.emanation.maxTurns,
			runtime: resolved.runtimes.emanation,
			ontology: resolved.ontologies.emanation,
		},
		pilotToolInclude: [...resolved.pilotToolInclude],
		emanationToolInclude: [...resolved.emanationToolInclude],
		responseSchema: resolved.definition.responseSchema,
		maxProposedEffects: resolved.definition.budgets.maxProposedEffects,
		programs: resolved.programs.map((program) => ({ ...program })),
		maxProgramInvocations: resolved.maxProgramInvocations,
	};
	const schemaInput = {
		definitionDocumentId: input.request.definitionDocumentId,
		trigger: input.request.trigger,
		contextRefs: [...input.request.contextRefs],
		...(input.request.inference ? { inference: input.request.inference } : {}),
		...(input.request.interactionMode ? { interactionMode: input.request.interactionMode } : {}),
	};
	const hostContext: DomainAgentHostContextV1 = {
		schema: "sophia.domain-agent-host-context.v1",
		agentId: resolved.definition.agentId,
		definitionDigest: resolved.definitionDigest,
		runtimes: resolved.runtimes,
		ontologies: resolved.ontologies,
		emanation: resolved.emanation,
		emanationToolInclude: [...resolved.emanationToolInclude],
		systemPrompt: resolved.systemPrompt,
		grant: resolved.grant,
		grantDocumentId: resolved.definition.grantRef.documentId,
		grantAuthorityOwnerPrincipal: resolved.definition.grantRef.ownerPrincipal,
		toolbelt: resolved.toolbelt,
		approvals: [...(input.hostApprovals ?? [])],
		maxProposedEffects: resolved.definition.budgets.maxProposedEffects,
		programs: resolved.programs.map((program) => ({ ...program })),
		maxProgramInvocations: resolved.maxProgramInvocations,
		trigger: input.request.trigger,
		sourceTurn: input.sourceTurn,
		triggerBinding: resolved.triggerBinding,
		triggerConsent: resolved.triggerConsent,
		resultEffectBinding: resolved.definition.resultEffectBinding,
		...(resolved.mode ? { mode: resolved.mode } : {}),
	};
	return {
		config: {
			graphId: input.graphId,
			provider: resolved.pilot.provider,
			model: resolved.pilot.model,
			agentId: resolved.definition.agentId,
			toolMode: "dynamic",
			includeTools: [...resolved.pilotToolInclude],
			strictToolManifest: true,
			systemPrompt: resolved.systemPrompt,
			runtime: resolved.runtimes.pilot,
			ontology: resolved.ontologies.pilot,
		},
		args,
		schemaInput,
		hostContext,
	};
}

export function readDomainAgentHostContext(value: unknown): DomainAgentHostContextV1 | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const context = value as Partial<DomainAgentHostContextV1>;
	if (context.schema !== "sophia.domain-agent-host-context.v1") return undefined;
	parseDomainSourceTurn(context.sourceTurn);
	return context as DomainAgentHostContextV1;
}

export async function finalizeDomainAgentActivityRun(input: {
	run: RunRecord;
	inputs: WorkflowRunInputs;
	graph: GraphWriter;
	runtime: WorkflowRuntimeStore;
	graphId: string;
	ownerUserId: string;
	actorRef: string;
}): Promise<void> {
	const host = readDomainAgentHostContext(input.inputs.hostContext);
	if (!host) throw new Error("domain agent run is missing its trusted host context");
	const output = asRecord(input.run.output);
	const failure = asRecord(output?.failure);
	if (failure?.schema === "sophia.domain-agent-activity-failure.v1") {
		input.run.status = "failed";
		input.run.note = [input.run.note, "domain agent activity failed before producing a contracted response"]
			.filter(Boolean)
			.join("; ");
	}
	const proposedByAgent = output && Array.isArray(output.proposedEffects) ? output.proposedEffects : [];
	const proposals = failure
		? materializeBoundFailureEffects(host, input.run.runId)
		: materializeBoundResultEffects(host, output, proposedByAgent, input.run.runId);
	if (proposals.length > host.maxProposedEffects) {
		throw new Error(`domain agent proposed ${proposals.length} effects, above its ${host.maxProposedEffects} cap`);
	}
	const receipts = await executeProposedEffects({
		proposals,
		context: {
			runId: input.run.runId,
			graphId: input.graphId,
			agentId: host.agentId,
			actorRef: input.actorRef,
			sourceTurn: host.sourceTurn,
			grant: host.grant,
			grantDocumentId: host.grantDocumentId,
			grantAuthorityOwnerPrincipal: host.grantAuthorityOwnerPrincipal,
			definitionDigest: host.definitionDigest,
			trigger: host.trigger,
			approvals: host.approvals,
		},
		executor: new GraphProposedEffectExecutor(input.graph),
		idempotency: new RuntimeEffectIdempotencyStore(input.runtime),
		handoff: new RuntimeEffectHandoffStore(input.runtime),
	});
	input.run.effectReceipts = receipts;
	input.run.output = { ...(output ?? {}), effectReceipts: receipts };
	try {
		await writeJsonDocument(input.graph, input.graphId, `effect-receipts-${input.run.runId}`, {
			schema: "sophia.effect-receipt-batch.v1",
			runId: input.run.runId,
			agentId: host.agentId,
			definitionDigest: host.definitionDigest,
			sourceTurnId: host.sourceTurn.turnId,
			ownerUserId: input.ownerUserId,
			receipts,
		});
	} catch (error) {
		input.run.note = [
			input.run.note,
			`effect-receipt graph projection failed: ${error instanceof Error ? error.message : String(error)}`,
		]
			.filter(Boolean)
			.join("; ");
	}
}

export function materializeBoundResultEffects(
	host: DomainAgentHostContextV1,
	output: Record<string, unknown> | undefined,
	proposedByAgent: readonly unknown[],
	runId: string,
): readonly unknown[] {
	if (host.resultEffectBinding?.kind !== "discord-placeholder-edit") return [...proposedByAgent];
	if (host.maxProposedEffects < 1) throw new Error("bound Discord response effect requires a positive effect budget");
	const trigger = asRecord(host.trigger);
	const response = asRecord(output?.response);
	const content = response?.content;
	const resource = trigger?.resource;
	const contextHandle = trigger?.privacyContextHandle;
	const channelHandle = trigger?.channelHandle;
	const responseHandle = trigger?.responseHandle;
	if (
		typeof content !== "string" ||
		!content.trim() ||
		typeof resource !== "string" ||
		typeof contextHandle !== "string" ||
		typeof channelHandle !== "string" ||
		typeof responseHandle !== "string"
	) {
		throw new Error("bound Discord response effect could not resolve its typed result/trigger fields");
	}
	const retained = proposedByAgent.filter((value) => {
		const proposal = asRecord(value);
		return !(proposal?.capability === "discord" && proposal.operation === "message.edit");
	});
	return [
		...retained.slice(0, host.maxProposedEffects - 1),
		{
			schema: "sophia.proposed-effect.v1",
			effectId: `host-response-edit:${runId}`,
			idempotencyKey: `discord-response:${host.sourceTurn.turnId}`,
			capability: "discord",
			operation: "message.edit",
			arguments: { resource, contextHandle, channelHandle, responseHandle, text: content },
			reason: "Apply the graph-bound typed Domain Agent response to the host-owned Discord placeholder.",
			evidenceRefs: [host.sourceTurn.sourceRef],
		},
	];
}

/**
 * Turn an agent-wave failure into a deterministic, graph-authored placeholder
 * edit. This still traverses the ordinary proposed-effect/grant/handoff path;
 * it is not a privileged Discord escape hatch. A run-specific idempotency key
 * lets a later retry replace the failure with a successful response.
 */
export function materializeBoundFailureEffects(host: DomainAgentHostContextV1, runId: string): readonly unknown[] {
	const binding = host.resultEffectBinding;
	if (binding?.kind !== "discord-placeholder-edit" || !binding.failureContent?.trim()) return [];
	if (host.maxProposedEffects < 1) throw new Error("bound Discord failure effect requires a positive effect budget");
	const trigger = asRecord(host.trigger);
	const resource = trigger?.resource;
	const contextHandle = trigger?.privacyContextHandle;
	const channelHandle = trigger?.channelHandle;
	const responseHandle = trigger?.responseHandle;
	if (
		typeof resource !== "string" ||
		typeof contextHandle !== "string" ||
		typeof channelHandle !== "string" ||
		typeof responseHandle !== "string"
	) {
		throw new Error("bound Discord failure effect could not resolve its trigger fields");
	}
	return [
		{
			schema: "sophia.proposed-effect.v1",
			effectId: `host-response-failure-edit:${runId}`,
			idempotencyKey: `discord-response-failure:${host.sourceTurn.turnId}:${runId}`,
			capability: "discord",
			operation: "message.edit",
			arguments: {
				resource,
				contextHandle,
				channelHandle,
				responseHandle,
				text: binding.failureContent,
			},
			reason: "Replace the host-owned Discord placeholder with the graph-bound activity failure response.",
			evidenceRefs: [host.sourceTurn.sourceRef],
		},
	];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
