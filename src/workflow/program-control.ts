import type { CapabilityBackend, HostedMcpToolDescriptor } from "../mnemosyne.js";
import type { WorkflowBeatDecision, WorkflowRuntimeStore } from "./runtime-store.js";

export const PROGRAM_CONTROL_CAPABILITY = "choreograph.control";

/**
 * Host-only control capability injected into a program workflow sandbox.
 *
 * It has no graph, credential, model, toolbelt, or effect authority. Its only
 * operations expose semantic journey boundaries for the run already selected
 * by the trusted invocation edge. Vehicle writes amendments to libSQL through
 * authenticated HTTP routes; the sandbox may only witness/apply them at a
 * boundary and mark that boundary complete.
 */
export class WorkflowProgramControlBackend implements CapabilityBackend {
	readonly capabilityName = PROGRAM_CONTROL_CAPABILITY;
	readonly accessLevel = "rw" as const;

	constructor(
		private readonly runtime: WorkflowRuntimeStore,
		private readonly runId: string,
		private readonly now: () => number = () => Date.now(),
	) {}

	async callTool(tool: string, args: Record<string, unknown>): Promise<WorkflowBeatDecision> {
		if (tool === "plan") {
			return this.required(
				await this.runtime.planWorkflowBeats(this.runId, {
					pendingBeatIds: stringArray(args.pendingBeatIds, "pendingBeatIds"),
					now: this.now(),
					...(args.allowedAmendments === undefined
						? {}
						: { allowedAmendments: amendmentKinds(args.allowedAmendments) }),
				}),
			);
		}
		if (tool === "enter") {
			return this.required(
				await this.runtime.enterWorkflowBeat(this.runId, {
					beatId: stringValue(args.beatId, "beatId"),
					pendingBeatIds: stringArray(args.pendingBeatIds, "pendingBeatIds"),
					parameters: recordValue(args.parameters, "parameters"),
					modelUse: modelUse(args.modelUse),
					now: this.now(),
					...(args.allowedAmendments === undefined
						? {}
						: { allowedAmendments: amendmentKinds(args.allowedAmendments) }),
				}),
			);
		}
		if (tool === "complete") {
			return this.required(
				await this.runtime.completeWorkflowBeat(this.runId, {
					beatId: stringValue(args.beatId, "beatId"),
					now: this.now(),
				}),
			);
		}
		throw new Error(`unknown program-control tool '${tool}'`);
	}

	async listTools(): Promise<readonly HostedMcpToolDescriptor[]> {
		return [
			{
				name: "plan",
				inputSchema: {
					type: "object",
					properties: { pendingBeatIds: { type: "array", items: { type: "string" } } },
					required: ["pendingBeatIds"],
					additionalProperties: false,
				},
			},
			{
				name: "enter",
				inputSchema: {
					type: "object",
					properties: {
						beatId: { type: "string" },
						pendingBeatIds: { type: "array", items: { type: "string" } },
						parameters: { type: "object" },
						modelUse: { enum: ["none", "inference", "agentic"] },
					},
					required: ["beatId", "pendingBeatIds", "parameters", "modelUse"],
					additionalProperties: false,
				},
			},
			{
				name: "complete",
				inputSchema: {
					type: "object",
					properties: { beatId: { type: "string" } },
					required: ["beatId"],
					additionalProperties: false,
				},
			},
		];
	}

	async close(): Promise<void> {}

	private required(decision: WorkflowBeatDecision | null): WorkflowBeatDecision {
		if (!decision) throw new Error(`workflow control state is missing for '${this.runId}'`);
		return decision;
	}
}

function stringValue(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
	return value;
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error(`${label} must be a string array`);
	}
	return value;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function modelUse(value: unknown): "none" | "inference" | "agentic" {
	if (value === "none" || value === "inference" || value === "agentic") return value;
	throw new Error("modelUse must be none, inference, or agentic");
}

function amendmentKinds(value: unknown): Array<"skip" | "reorder" | "reparameterize" | "directive"> {
	const kinds = stringArray(value, "allowedAmendments");
	if (kinds.some((kind) => !["skip", "reorder", "reparameterize", "directive"].includes(kind))) {
		throw new Error("allowedAmendments contains an unsupported workflow amendment kind");
	}
	return kinds as Array<"skip" | "reorder" | "reparameterize" | "directive">;
}
