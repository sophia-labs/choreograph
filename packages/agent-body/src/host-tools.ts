/**
 * The body's tools: what the host grants, discovered over the bridge, plus the one terminal tool that ends a task.
 *
 * Every tool runs on the host (`capability.request`); the body only names it. Graph tools come from the `mnemosyne`
 * capability, filtered by the request's tool mode and allow/deny lists; other host capabilities are exposed as
 * `<capability>__<tool>`. Authority arguments (graph, owner, agent, session …) are hidden from the model and filled
 * in from the host's own request, never from what the model wrote.
 */

import { type TSchema, Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentSpawnRequest } from "../../../src/wire-protocol.js";
import { type HostBridge, isRecord } from "./bridge.js";

const LIST_TOOLS = "__list_tools";
const CURATED_GRAPH_TOOLS = new Set(["search_documents", "read_document", "append_to_document", "remember"]);
/** Memory tools that need to know which agent observes. */
export const OBSERVER_TOOLS: ReadonlySet<string> = new Set([
	"remember",
	"recall",
	"music",
	"sing",
	"context_bundle",
	"value",
	"revaluate",
	"get_important_blocks",
]);
/** Arguments that carry authority: hidden from the model, filled in by the body from the host's request. */
const AUTHORITY_ARGUMENTS = [
	"graph_id",
	"graphId",
	"observer_agent_id",
	"owner_principal",
	"ownerPrincipal",
	"agent_id",
	"agentId",
	"session_id",
	"sessionId",
	"embodiment_ref",
	"embodimentRef",
	"expected_embodiment_digest",
	"expectedEmbodimentDigest",
	"workspace_id",
	"workspaceId",
	"lease_token",
	"leaseToken",
	"generation",
] as const;
const HIDDEN = new Set<string>(AUTHORITY_ARGUMENTS);

interface HostToolDescriptor {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	readonly destructive: boolean;
}

interface Binding {
	readonly capability: string;
	readonly descriptor: HostToolDescriptor;
	readonly exposedName: string;
}

export interface TerminalState {
	signaled: boolean;
	output?: string;
	structuredOutput?: unknown;
}

export interface HostToolSurface {
	readonly tools: ToolDefinition[];
	readonly terminal: TerminalState;
	/** Forget the previous command's completion before the resident body takes another prompt. */
	beginCommand(): void;
}

export async function createHostToolSurface(request: AgentSpawnRequest, bridge: HostBridge): Promise<HostToolSurface> {
	const terminal: TerminalState = { signaled: false };
	const bindings = await discoverBindings(request, bridge);
	const seen = new Set<string>();
	const tools: ToolDefinition[] = [];
	for (const binding of bindings) {
		if (seen.has(binding.exposedName)) throw new Error(`two host tools share the name ${binding.exposedName}`);
		seen.add(binding.exposedName);
		tools.push(gateTool(binding, request, bridge));
	}
	const finish = terminalTool(request, terminal);
	if (seen.has(finish.name)) throw new Error(`the terminal tool collides with host tool ${finish.name}`);
	tools.unshift(finish);
	return {
		tools,
		terminal,
		beginCommand() {
			terminal.signaled = false;
			delete terminal.output;
			delete terminal.structuredOutput;
		},
	};
}

async function discoverBindings(request: AgentSpawnRequest, bridge: HostBridge): Promise<Binding[]> {
	const bindings: Binding[] = [];
	if (request.mnemosyne.mcp_url !== "disabled" && request.tool_mode !== "none") {
		const descriptors = await listTools("mnemosyne", bridge);
		const exclude = new Set(request.exclude_tools ?? []);
		const include = request.include_tools ? new Set(request.include_tools) : undefined;
		const selected = descriptors.filter((descriptor) => {
			if (exclude.has(descriptor.name)) return false;
			if (include && !include.has(descriptor.name)) return false;
			return request.tool_mode !== "curated" || CURATED_GRAPH_TOOLS.has(descriptor.name);
		});
		if (request.strict_tool_manifest && include) {
			const available = new Set(selected.map((descriptor) => descriptor.name));
			const missing = [...include].filter((name) => !available.has(name)).sort();
			if (missing.length > 0)
				throw new Error(`the strict tool manifest names tools the host does not serve: ${missing.join(", ")}`);
		}
		bindings.push(
			...selected.map((descriptor) => ({ capability: "mnemosyne", descriptor, exposedName: descriptor.name })),
		);
	}
	const others = Object.keys(request.capabilities ?? {})
		.filter((name) => name !== "mnemosyne" && name !== "acp.authority")
		.sort();
	for (const capability of others) {
		const descriptors = (await listTools(capability, bridge)).filter((descriptor) => {
			if (capability === "workflow" && !request.runtime_binding.constraints.allowWorkflowProposals) {
				return descriptor.name === "inspect";
			}
			// Agent evolution needs the hosted body's sandbox; this body never offers it.
			return capability !== "evolution";
		});
		bindings.push(
			...descriptors.map((descriptor) => ({
				capability,
				descriptor,
				exposedName: `${toolSegment(capability)}__${descriptor.name}`,
			})),
		);
	}
	return bindings;
}

async function listTools(capability: string, bridge: HostBridge): Promise<HostToolDescriptor[]> {
	const response = await bridge.callCapability(capability, LIST_TOOLS, {});
	if (response.isError) throw new Error(`${capability}.${LIST_TOOLS} failed: ${render(response.result)}`);
	if (!Array.isArray(response.result)) throw new Error(`${capability}.${LIST_TOOLS} did not return a list`);
	return response.result.map((value, index) => parseDescriptor(capability, value, index));
}

function parseDescriptor(capability: string, value: unknown, index: number): HostToolDescriptor {
	if (!isRecord(value)) throw new Error(`${capability} tool #${index + 1} is not an object`);
	if (typeof value.name !== "string" || !value.name.trim())
		throw new Error(`${capability} tool #${index + 1} has no name`);
	if (typeof value.description !== "string") throw new Error(`${capability}.${value.name} has no description`);
	if (!isRecord(value.inputSchema)) throw new Error(`${capability}.${value.name} has no input schema`);
	if (value.destructive !== undefined && typeof value.destructive !== "boolean") {
		throw new Error(`${capability}.${value.name} has a destructive flag that is not a boolean`);
	}
	return {
		name: value.name,
		description: value.description,
		inputSchema: value.inputSchema,
		destructive: value.destructive ?? nameSoundsDestructive(value.name),
	};
}

function gateTool(binding: Binding, request: AgentSpawnRequest, bridge: HostBridge): ToolDefinition {
	return defineTool({
		name: binding.exposedName,
		label: binding.exposedName,
		description:
			binding.capability === "mnemosyne"
				? binding.descriptor.description
				: `[${binding.capability}] ${binding.descriptor.description}`,
		parameters: Type.Unsafe<Record<string, unknown>>(exposedSchema(binding, request) as TSchema),
		execute: async (toolCallId, params, signal) => {
			const args = withAuthority(binding, request, isRecord(params) ? params : {});
			if (request.gate_destructive_tools && binding.descriptor.destructive) {
				const permission = await bridge.callCapability(
					"acp.authority",
					"request_permission",
					{ callId: toolCallId, tool: binding.descriptor.name, capability: binding.capability, args },
					signal,
				);
				if (permission.isError || !permissionAllowed(permission.result)) {
					throw new Error(`permission denied for ${binding.capability}.${binding.descriptor.name}`);
				}
			}
			const response = await bridge.callCapability(binding.capability, binding.descriptor.name, args, signal);
			return gateResult(binding.exposedName, response.result, response.isError);
		},
	});
}

/** `done` (the task's result as text) or `submit` (a result that satisfies the request's output schema). */
function terminalTool(request: AgentSpawnRequest, state: TerminalState): ToolDefinition {
	const receipt = (text: string, details: Record<string, unknown>) => ({
		content: [{ type: "text" as const, text }],
		details,
		terminate: true,
	});
	if (request.output_schema) {
		return defineTool({
			name: "submit",
			label: "Submit the structured result",
			description: "Submit the final answer exactly once, using the required schema.",
			parameters: Type.Unsafe<Record<string, unknown>>(request.output_schema as TSchema),
			executionMode: "sequential",
			execute: async (_toolCallId, params) => {
				state.signaled = true;
				state.structuredOutput = params;
				state.output = render(params);
				return receipt("Submission accepted. The host ends this activity here; nothing more is needed.", {
					terminal: true,
					disposition: "accepted",
				});
			},
		});
	}
	return defineTool({
		name: "done",
		label: "Finish the task",
		description: "Call this once the task is complete, with the complete final result.",
		parameters: Type.Object({ summary: Type.String({ description: "The complete final result for the caller." }) }),
		executionMode: "sequential",
		execute: async (_toolCallId, params) => {
			state.signaled = true;
			state.output = params.summary;
			return receipt("Result accepted. The host ends this activity here; nothing more is needed.", {
				terminal: true,
				disposition: "accepted",
			});
		},
	});
}

function exposedSchema(binding: Binding, request: AgentSpawnRequest): Record<string, unknown> {
	const schema = structuredClone(binding.descriptor.inputSchema);
	const properties = isRecord(schema.properties) ? { ...schema.properties } : undefined;
	if (properties) for (const key of AUTHORITY_ARGUMENTS) delete properties[key];
	const required = Array.isArray(schema.required)
		? schema.required.filter((entry): entry is string => typeof entry === "string" && !HIDDEN.has(entry))
		: undefined;
	return {
		...schema,
		...(properties ? { properties } : {}),
		...(required ? { required } : {}),
		additionalProperties: schema.additionalProperties ?? false,
		$comment: `Bound by ${request.agent_ontology_binding_digest}`,
	};
}

function withAuthority(
	binding: Binding,
	request: AgentSpawnRequest,
	params: Record<string, unknown>,
): Record<string, unknown> {
	const clean: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(params)) if (!HIDDEN.has(key)) clean[key] = value;
	let args = clean;
	if (binding.capability === "mnemosyne" && !request.mnemosyne.graph_scope.bound_cell) {
		args = { graph_id: request.mnemosyne.graph_scope.default_graph_id, ...args };
	}
	if (binding.capability === "mnemosyne" && OBSERVER_TOOLS.has(binding.descriptor.name)) {
		args = { observer_agent_id: request.agent_id, ...args };
	}
	return args;
}

function gateResult(
	toolName: string,
	raw: unknown,
	transportError: boolean,
): { content: Array<{ type: "text"; text: string }>; details: unknown } {
	const envelope = isRecord(raw) ? raw : undefined;
	const isError = transportError || envelope?.isError === true;
	const text = contentText(envelope?.content);
	const details = envelope?.structuredContent ?? jsonText(text) ?? raw;
	const shown = text || render(details);
	if (isError) throw new Error(`${toolName} failed: ${shown}`.trim());
	// details must survive the session record (JSON): the host's results are JSON already.
	return { content: [{ type: "text", text: shown }], details: JSON.parse(JSON.stringify(details ?? null)) };
}

function permissionAllowed(value: unknown): boolean {
	if (value === true) return true;
	if (!isRecord(value)) return false;
	return value.allowed === true || value.decision === "allow_once" || value.decision === "allow_session";
}

function nameSoundsDestructive(name: string): boolean {
	return /(^|_)(append|create|delete|execute|issue|mutate|patch|post|publish|remember|remove|send|set|update|write)($|_)/i.test(
		name,
	);
}

function toolSegment(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9_]+/g, "_")
			.replace(/^_+|_+$/g, "") || "capability"
	);
}

function contentText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block) =>
			isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
		)
		.join("\n")
		.trim();
}

function jsonText(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

export function render(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "";
	return JSON.stringify(value, null, 2);
}
