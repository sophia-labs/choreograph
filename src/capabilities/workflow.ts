import { createHash } from "node:crypto";
import {
	MEANINGFUL_OBJECT_REF_SCHEMA,
	type MeaningfulObjectKind,
	type MeaningfulObjectRefV1,
} from "../agent-runtime/meaningful-object.js";
import type { CapabilityBackend, HostedMcpToolDescriptor } from "../mnemosyne.js";
import type {
	WorkflowBeatAmendmentKind,
	WorkflowControlMutationResult,
	WorkflowControlRecord,
	WorkflowRuntimeStore,
} from "../workflow/runtime-store.js";

const TOOLS = [
	{
		name: "inspect",
		destructive: false,
		description:
			"Inspect this run's driver, semantic beat frontier, and amendment Meaningful Objects without changing them.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "claim_driver",
		destructive: true,
		description:
			"Claim the currently unheld workflow driver lease for this exact Agent Session; never displaces another driver.",
		inputSchema: {
			type: "object",
			properties: { expected_revision: { type: "integer", minimum: 0 } },
			required: ["expected_revision"],
			additionalProperties: false,
		},
	},
	{
		name: "release_driver",
		destructive: true,
		description: "Release this Agent Session's workflow driver lease.",
		inputSchema: {
			type: "object",
			properties: { expected_revision: { type: "integer", minimum: 0 } },
			required: ["expected_revision"],
			additionalProperties: false,
		},
	},
	{
		name: "propose_amendment",
		destructive: true,
		description:
			"CAS-queue a bounded workflow amendment Meaningful Object for a future semantic beat; authority, tools, models, grants, and budgets cannot be widened.",
		inputSchema: {
			type: "object",
			properties: {
				amendment_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
				kind: { enum: ["skip", "reorder", "reparameterize", "directive"] },
				target_beat_id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" },
				payload: { type: "object" },
				expected_revision: { type: "integer", minimum: 0 },
				lease_epoch: { type: "integer", minimum: 1 },
			},
			required: ["amendment_id", "kind", "expected_revision", "lease_epoch"],
			additionalProperties: false,
		},
	},
] as const satisfies readonly HostedMcpToolDescriptor[];

const TOOL_NAMES = new Set<string>(TOOLS.map((tool) => tool.name));
const MUTATING_TOOLS = new Set(["claim_driver", "release_driver", "propose_amendment"]);

export interface WorkflowCapabilityBackendOptions {
	readonly runtime: WorkflowRuntimeStore;
	readonly runId: string;
	readonly graphId: string;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly sessionId: string;
	readonly nodeKey?: string;
	readonly ontologyBindingDigest?: string;
	readonly allowedTools: readonly string[];
	readonly now?: () => number;
}

/**
 * A node-scoped ontological control surface over the same CAS state Vehicle
 * drives. The sandbox never chooses a run, graph, owner, agent, session, or
 * driver identity; all are closed over by the trusted invocation edge.
 */
export class WorkflowCapabilityBackend implements CapabilityBackend {
	readonly capabilityName = "workflow";
	readonly accessLevel: "ro" | "rw";
	private readonly allowedTools: ReadonlySet<string>;
	private readonly clientId: string;
	private readonly now: () => number;

	constructor(private readonly options: WorkflowCapabilityBackendOptions) {
		if (!options.runId.trim() || !options.graphId.trim() || !options.ownerPrincipal.trim()) {
			throw new Error("workflow: bound run, owner, and graph are required");
		}
		if (!options.agentId.trim() || !options.sessionId.trim()) {
			throw new Error("workflow: an Agent Session Meaningful Object binding is required");
		}
		this.allowedTools = new Set(options.allowedTools);
		const unknown = [...this.allowedTools].filter((name) => !TOOL_NAMES.has(name));
		if (unknown.length > 0) throw new Error(`workflow: grant names unsupported tools: ${unknown.sort().join(", ")}`);
		if (this.allowedTools.size === 0) throw new Error("workflow: the Agent tool grant exposes no workflow tools");
		this.accessLevel = [...this.allowedTools].some((name) => MUTATING_TOOLS.has(name)) ? "rw" : "ro";
		this.clientId = `agent-session:${createHash("sha256")
			.update(`${options.agentId}\0${options.sessionId}`)
			.digest("hex")
			.slice(0, 32)}`;
		this.now = options.now ?? (() => Date.now());
	}

	async listTools(): Promise<readonly HostedMcpToolDescriptor[]> {
		return TOOLS.filter((tool) => this.allowedTools.has(tool.name));
	}

	async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
		if (!this.allowedTools.has(tool)) throw new Error(`workflow: tool '${tool}' is outside the Agent tool grant`);
		if (tool === "inspect") {
			return this.testimony(await this.requiredControl(), "workflow");
		}
		if (tool === "claim_driver") {
			const current = await this.requiredControl();
			if (current.driverLease && current.driverLease.holder !== this.clientId) {
				return this.testimony(current, "workflow", false, "not_driver");
			}
			const result = await this.options.runtime.claimWorkflowDriver(this.options.runId, {
				clientId: this.clientId,
				now: this.now(),
				expectedRevision: integer(args.expected_revision, "expected_revision", 0),
			});
			return this.mutation(result, "workflow");
		}
		if (tool === "release_driver") {
			const result = await this.options.runtime.releaseWorkflowDriver(this.options.runId, {
				clientId: this.clientId,
				now: this.now(),
				expectedRevision: integer(args.expected_revision, "expected_revision", 0),
			});
			return this.mutation(result, "workflow");
		}
		if (tool === "propose_amendment") {
			const amendmentId = stableId(args.amendment_id, "amendment_id");
			const result = await this.options.runtime.queueWorkflowBeatAmendment(this.options.runId, {
				clientId: this.clientId,
				amendmentId,
				kind: amendmentKind(args.kind),
				...(args.target_beat_id === undefined
					? {}
					: { targetBeatId: stableId(args.target_beat_id, "target_beat_id") }),
				...(args.payload === undefined ? {} : { payload: record(args.payload, "payload") }),
				expectedRevision: integer(args.expected_revision, "expected_revision", 0),
				leaseEpoch: integer(args.lease_epoch, "lease_epoch", 1),
				now: this.now(),
			});
			return this.mutation(result, "workflow-amendment", amendmentId);
		}
		throw new Error(`workflow: unknown tool '${tool}'`);
	}

	async close(): Promise<void> {}

	private async requiredControl(): Promise<WorkflowControlRecord> {
		const control = await this.options.runtime.getWorkflowControl(this.options.runId);
		if (!control) throw new Error(`workflow: control state is missing for '${this.options.runId}'`);
		return control;
	}

	private mutation(
		result: WorkflowControlMutationResult | null,
		kind: "workflow" | "workflow-amendment",
		amendmentId?: string,
	): unknown {
		if (!result) throw new Error(`workflow: control state is missing for '${this.options.runId}'`);
		return this.testimony(result.control, kind, result.applied, result.reason, amendmentId);
	}

	private testimony(
		control: WorkflowControlRecord,
		kind: "workflow" | "workflow-amendment",
		applied?: boolean,
		reason?: WorkflowControlMutationResult["reason"],
		amendmentId?: string,
	): Record<string, unknown> {
		const subject = {
			runId: this.options.runId,
			control,
			agent: {
				agentId: this.options.agentId,
				sessionId: this.options.sessionId,
				...(this.options.nodeKey ? { nodeKey: this.options.nodeKey } : {}),
				...(this.options.ontologyBindingDigest
					? { ontologyBindingDigest: this.options.ontologyBindingDigest }
					: {}),
			},
		};
		return {
			schema: "sophia.meaningful-object-testimony.v1",
			object: meaningfulObjectRef(this.options, kind, control.revision, subject, amendmentId),
			subject,
			...(applied === undefined ? {} : { applied }),
			...(reason === undefined ? {} : { reason }),
		};
	}
}

function meaningfulObjectRef(
	options: WorkflowCapabilityBackendOptions,
	kind: MeaningfulObjectKind,
	revision: number,
	subject: unknown,
	amendmentId?: string,
): MeaningfulObjectRefV1 {
	return {
		schema: MEANINGFUL_OBJECT_REF_SCHEMA,
		kind,
		ownerPrincipal: options.ownerPrincipal,
		graphId: options.graphId,
		objectId:
			kind === "workflow-amendment"
				? `urn:sophia:workflow:${options.runId}:amendment:${amendmentId ?? "unknown"}`
				: `urn:sophia:workflow:${options.runId}`,
		version: String(revision),
		digest: `sha256:${createHash("sha256").update(canonicalJson(subject)).digest("hex")}`,
	};
}

function amendmentKind(value: unknown): WorkflowBeatAmendmentKind {
	if (value === "skip" || value === "reorder" || value === "reparameterize" || value === "directive") {
		return value;
	}
	throw new Error("workflow: kind must be skip, reorder, reparameterize, or directive");
}

function integer(value: unknown, label: string, minimum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		throw new Error(`workflow: ${label} must be an integer >= ${minimum}`);
	}
	return value;
}

function stableId(value: unknown, label: string): string {
	const text = typeof value === "string" ? value.trim() : "";
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) {
		throw new Error(`workflow: ${label} must be a stable 1..128 character identifier`);
	}
	return text;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(`workflow: ${label} must be an object`);
	return value as Record<string, unknown>;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([, child]) => child !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => [key, sortValue(child)]),
	);
}
