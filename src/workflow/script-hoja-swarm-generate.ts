import type { WorkflowRunInputs } from "./harness.js";
import { assertHojaGraphId } from "./hoja-swarm.js";

export const HOJA_SWARM_GENERATE_NAME = "hoja-swarm-generate-v1";

const stringProperty = { type: "string", minLength: 1 } as const;
const documentIdentityProperties = {
	graphId: stringProperty,
	documentId: stringProperty,
} as const;

function actionSchema(
	capability: string | readonly string[],
	tool: string,
	args: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	return {
		type: "object",
		additionalProperties: false,
		required: ["capability", "tool", "args"],
		properties: {
			capability: Array.isArray(capability) ? { enum: capability } : { const: capability },
			tool: { const: tool },
			args,
		},
	};
}

const refSchema = {
	type: "object",
	additionalProperties: false,
	required: ["beat"],
	properties: {
		beat: stringProperty,
		action: { type: "integer", minimum: 0 },
		path: { type: "string", minLength: 1 },
	},
} as const;

const SCENARIO_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["schema", "id", "runId", "description", "beats", "invariants"],
	properties: {
		schema: { const: "sophia.hoja.scenario.v1" },
		id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
		runId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
		description: { type: "string", maxLength: 4000 },
		beats: {
			type: "array",
			minItems: 1,
			maxItems: 64,
			contains: {
				type: "object",
				required: ["capture"],
				properties: { capture: { const: true } },
			},
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "operation", "mode", "actions"],
				properties: {
					id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
					operation: {
						enum: ["create", "type", "edit-block", "concurrent-edit", "rename", "list", "delete-later"],
					},
					mode: { enum: ["sequential", "concurrent"] },
					capture: { type: "boolean" },
					actions: {
						type: "array",
						minItems: 1,
						maxItems: 16,
						items: {
							oneOf: [
								actionSchema(["browser.chromium"], "navigate", {
									type: "object",
									additionalProperties: false,
									required: ["action", "url"],
									properties: { action: { const: "url" }, url: stringProperty },
								}),
								actionSchema(["browser.chromium"], "read_a11y_tree", {
									type: "object",
									additionalProperties: false,
									properties: {},
								}),
								actionSchema(["browser.chromium"], "probe", {
									type: "object",
									additionalProperties: false,
									properties: {},
								}),
								actionSchema(["browser.chromium"], "act", {
									type: "object",
									additionalProperties: false,
									required: ["ref", "action"],
									properties: {
										ref: stringProperty,
										action: { enum: ["click", "type", "select", "press"] },
										value: stringProperty,
										delayMs: { type: "integer", minimum: 0, maximum: 10000 },
									},
								}),
								actionSchema(["browser.chromium"], "screenshot", {
									type: "object",
									additionalProperties: false,
									properties: { ref: stringProperty },
								}),
								actionSchema("http", "get", {
									type: "object",
									additionalProperties: false,
									required: ["path"],
									properties: { path: stringProperty, accept: stringProperty },
								}),
								actionSchema("http", "head", {
									type: "object",
									additionalProperties: false,
									required: ["path"],
									properties: { path: stringProperty, accept: stringProperty },
								}),
								actionSchema("mcp", "create_document", {
									type: "object",
									additionalProperties: false,
									required: ["graphId", "documentId", "title"],
									properties: { ...documentIdentityProperties, title: stringProperty },
								}),
								actionSchema("mcp", "write_document", {
									type: "object",
									additionalProperties: false,
									required: ["graphId", "documentId", "content", "format", "awaitDurable"],
									properties: {
										...documentIdentityProperties,
										title: stringProperty,
										content: { type: "string" },
										format: { enum: ["plain", "markdown", "html", "xml"] },
										awaitDurable: { const: true },
									},
								}),
								actionSchema("mcp", "read_document", {
									type: "object",
									additionalProperties: false,
									required: ["graphId", "documentId", "format"],
									properties: {
										...documentIdentityProperties,
										format: { enum: ["markdown", "json", "xml", "ids_only"] },
									},
								}),
								actionSchema("mcp", "list_documents", {
									type: "object",
									additionalProperties: false,
									required: ["graphId"],
									properties: { graphId: stringProperty },
								}),
								actionSchema("mcp", "delete_document", {
									type: "object",
									additionalProperties: false,
									required: ["graphId", "documentId"],
									properties: documentIdentityProperties,
								}),
								actionSchema("yws", "snapshot", {
									type: "object",
									additionalProperties: false,
									required: ["documentId"],
									properties: { documentId: stringProperty, includeUpdate: { type: "boolean" } },
								}),
								actionSchema("yws", "append_block", {
									type: "object",
									additionalProperties: false,
									required: ["documentId", "blockId", "text"],
									properties: {
										documentId: stringProperty,
										blockId: stringProperty,
										text: { type: "string" },
									},
								}),
								actionSchema("yws", "concurrent_append", {
									type: "object",
									additionalProperties: false,
									required: ["documentId", "blocks"],
									properties: {
										documentId: stringProperty,
										blocks: {
											type: "array",
											minItems: 2,
											maxItems: 2,
											items: {
												type: "object",
												additionalProperties: false,
												required: ["blockId", "text"],
												properties: { blockId: stringProperty, text: { type: "string" } },
											},
										},
									},
								}),
								actionSchema("sparql", "query", {
									type: "object",
									additionalProperties: false,
									required: ["query"],
									properties: { query: stringProperty },
								}),
								actionSchema("soil", "roundtrip", {
									type: "object",
									additionalProperties: false,
									required: ["body"],
									properties: { body: { type: "string", pattern: "\\n$" } },
								}),
							],
						},
					},
				},
			},
		},
		invariants: {
			type: "array",
			minItems: 5,
			maxItems: 6,
			items: {
				oneOf: [
					{
						type: "object",
						additionalProperties: false,
						required: ["id", "kind", "left", "right"],
						properties: {
							id: { const: "I1" },
							kind: { const: "markdown_equal" },
							left: refSchema,
							right: refSchema,
						},
					},
					{
						type: "object",
						additionalProperties: false,
						required: ["id", "kind", "refs"],
						properties: {
							id: { const: "I2" },
							kind: { const: "face_agreement" },
							refs: { type: "array", minItems: 2, maxItems: 8, items: refSchema },
						},
					},
					{
						type: "object",
						additionalProperties: false,
						required: ["id", "kind", "ref"],
						properties: { id: { const: "I3" }, kind: { const: "converged" }, ref: refSchema },
					},
					{
						type: "object",
						additionalProperties: false,
						required: ["id", "kind", "left", "right"],
						properties: {
							id: { const: "I4" },
							kind: { const: "block_identity" },
							left: refSchema,
							right: refSchema,
						},
					},
					{
						type: "object",
						additionalProperties: false,
						required: ["id", "kind", "ref", "maxMs"],
						properties: {
							id: { const: "I5" },
							kind: { const: "projection_latency" },
							ref: refSchema,
							maxMs: { type: "integer", minimum: 1, maximum: 120000 },
						},
					},
					{
						type: "object",
						additionalProperties: false,
						required: ["id", "kind", "ref", "text"],
						properties: {
							id: { const: "I6" },
							kind: { const: "a11y_contains" },
							ref: refSchema,
							text: { type: "string", minLength: 1, maxLength: 4000 },
						},
					},
				],
			},
		},
	},
} as const;

const SCENARIO_INTENT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["description", "title", "witness", "leftBlock", "rightBlock"],
	properties: {
		description: { type: "string", minLength: 1, maxLength: 4000 },
		title: { type: "string", minLength: 1, maxLength: 200 },
		witness: {
			type: "string",
			minLength: 1,
			maxLength: 1024,
			pattern: "^[A-Za-z0-9][A-Za-z0-9 .,;:!?\"'()/-]{0,1023}$",
			description: "One line of plain ASCII witness text with no surrounding whitespace or Markdown control syntax.",
		},
		leftBlock: { type: "string", minLength: 1, maxLength: 2000 },
		rightBlock: { type: "string", minLength: 1, maxLength: 2000 },
	},
} as const;

export const HOJA_SWARM_GENERATE_SCRIPT = `export const meta = {
	name: "hoja-swarm-generate-v1",
	description: "Use an Inkling-Small generator to mint a deterministic, replayable cross-modal Hoja scenario as graph-storable data.",
	executor: "gated",
	execution: {
		schema: "choreograph.execution-binding.v1",
		controller: "agent",
		modelUse: "agentic",
		isolation: "sandbox",
		effects: "capability-bound",
		reproducibility: "nondeterministic",
		capabilities: ["garden.graph", "choreograph.agent"],
		authority: { minimumRole: "editor", dangerousOps: false },
		mayInvokeChildren: false,
	},
	inputs: {
		type: "object",
		additionalProperties: false,
		required: ["runId", "scenarioId", "corpus", "modalityPairs", "model"],
		properties: {
			runId: { type: "string" }, scenarioId: { type: "string" }, model: { type: "string" },
			corpus: { type: "array", minItems: 1, maxItems: 64, items: { type: "string" } },
			modalityPairs: { type: "array", minItems: 1, maxItems: 49, items: { type: "string" } },
		},
	},
	outputs: {
		type: "object",
		additionalProperties: false,
		required: ["scenario", "synthesis"],
		properties: { scenario: { type: "object" }, synthesis: { type: "object" } },
	},
}

contract("sophia.hoja.scenario.v1", ${JSON.stringify(SCENARIO_SCHEMA)})
const intentSchema = contract("sophia.hoja.scenario-intent.v1", ${JSON.stringify(SCENARIO_INTENT_SCHEMA)})
phase("generate")
const prompt = [
	"Supply the creative intent for one minimal, adversarial Hoja functional scenario.",
	"Hoja is one Meaningful Object with six doors: browser, HTTP md/html/xml/json, MCP, y-websocket, SPARQL, and Soil .sd.",
	"The Choreograph program, not you, owns every capability action, URL, graph/document identity, invariant reference, capture beat, and delete-later handoff.",
	"Return only a concise description, title, one single-line plain-ASCII witness text, and two distinct block texts. The program constructs canonical Markdown; do not emit Markdown in the witness field or invent tools, paths, URLs, ids, or cleanup actions.",
	"Use the corpus and modality pairs to make the content adversarial enough to exercise representation boundaries while remaining safe and deterministic.",
	"runId=" + args.runId,
	"scenarioId=" + args.scenarioId,
	"graphId=" + args.graphId,
	"browserUrl=" + (args.browserUrl || "not supplied"),
	"corpus=" + JSON.stringify(args.corpus),
	"modalityPairs=" + JSON.stringify(args.modalityPairs),
].join("\\n\\n")
const generated = await agent(prompt, {
	label: "scenario-generator",
	model: args.model,
	toolMode: "none",
	graphAccess: "read",
	maxTurns: 4,
	agentType: "hoja-scenario-generator",
	schema: intentSchema,
})
if (!generated.structured) throw new Error("scenario generator omitted structured intent")
if (!args.browserUrl) throw new Error("scenario generator requires the runtime Hoja browser URL")
const intent = generated.structured
const documentId = args.scenarioId.slice(0, 123) + "-doc"
const documentTitle = intent.title.replace(/\\s+/g, " ").trim() || "Hoja witness"
const canonicalMarkdown = "# Hoja witness\\n\\nWitness: " + intent.witness + "\\n"
const exportPath = (format) => documentId + "/export?format=" + format
const scenario = {
	schema: "sophia.hoja.scenario.v1",
	id: args.scenarioId,
	runId: args.runId,
	description: intent.description,
	beats: [
		{
			id: "create",
			operation: "create",
			mode: "sequential",
			actions: [
				{ capability: "mcp", tool: "create_document", args: { graphId: args.graphId, documentId, title: documentTitle } },
				{ capability: "mcp", tool: "write_document", args: { graphId: args.graphId, documentId, title: documentTitle, content: canonicalMarkdown, format: "markdown", awaitDurable: true } },
				{ capability: "soil", tool: "roundtrip", args: { body: canonicalMarkdown } },
			],
		},
		{
			id: "concurrent",
			operation: "concurrent-edit",
			mode: "sequential",
			actions: [{ capability: "yws", tool: "concurrent_append", args: { documentId, blocks: [
				{ blockId: "left", text: intent.leftBlock }, { blockId: "right", text: intent.rightBlock },
			] } }],
		},
		{
			id: "faces",
			operation: "list",
			mode: "sequential",
			actions: [
				{ capability: "mcp", tool: "read_document", args: { graphId: args.graphId, documentId, format: "markdown" } },
				{ capability: "mcp", tool: "read_document", args: { graphId: args.graphId, documentId, format: "xml" } },
				{ capability: "http", tool: "get", args: { path: exportPath("markdown"), accept: "text/markdown" } },
				{ capability: "http", tool: "get", args: { path: exportPath("html"), accept: "text/html" } },
				{ capability: "http", tool: "get", args: { path: exportPath("json"), accept: "application/json" } },
				{ capability: "http", tool: "get", args: { path: exportPath("xml"), accept: "application/xml" } },
			],
		},
		{
			id: "observe",
			operation: "list",
			mode: "sequential",
			capture: true,
			actions: [
				{ capability: "yws", tool: "snapshot", args: { documentId, includeUpdate: false } },
				{ capability: "sparql", tool: "query", args: { query: "SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o }" } },
				{ capability: "browser.chromium", tool: "navigate", args: { action: "url", url: args.browserUrl } },
			],
		},
		{
			id: "cleanup",
			operation: "delete-later",
			mode: "sequential",
			actions: [{ capability: "mcp", tool: "delete_document", args: { graphId: args.graphId, documentId } }],
		},
	],
	invariants: [
		{ id: "I1", kind: "markdown_equal", left: { beat: "faces", action: 0, path: "value.structuredContent.content" }, right: { beat: "faces", action: 2, path: "value.body" } },
		{ id: "I2", kind: "face_agreement", refs: [{ beat: "faces", action: 1, path: "value.structuredContent.content" }, { beat: "faces", action: 5, path: "value.body" }] },
		{ id: "I3", kind: "converged", ref: { beat: "concurrent", action: 0, path: "value" } },
		{ id: "I4", kind: "block_identity", left: { beat: "concurrent", action: 0, path: "value.snapshot.blockIds" }, right: { beat: "observe", action: 0, path: "value.blockIds" } },
		{ id: "I5", kind: "projection_latency", ref: { beat: "observe", action: 1, path: "value" }, maxMs: 120000 },
	],
}
const markdown = [
	"# Hoja scenario " + scenario.id,
	"",
	"Deterministic replay source for the obs-hoja swarm.",
	"",
	"\`\`\`json",
	JSON.stringify(scenario, null, 2),
	"\`\`\`",
].join("\\n")
return { scenario, synthesis: { title: "Hoja scenario " + scenario.id, markdown } }
`;

export function buildHojaSwarmGenerateInputs(body: unknown, graphId: string): WorkflowRunInputs {
	assertHojaGraphId(graphId);
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw bad("request must be an object");
	const request = body as Record<string, unknown>;
	const input = request.workflow_args ?? request;
	if (typeof input !== "object" || input === null || Array.isArray(input))
		throw bad("workflow_args must be an object");
	const argsInput = input as Record<string, unknown>;
	const runId = opaque(argsInput.run_id ?? argsInput.runId, "run_id");
	const scenarioId = opaque(argsInput.scenario_id ?? argsInput.scenarioId, "scenario_id");
	const corpus = stringArray(argsInput.corpus, "corpus", 64);
	const modalityPairs = stringArray(argsInput.modality_pairs ?? argsInput.modalityPairs, "modality_pairs", 49);
	const model =
		(typeof argsInput.model === "string" && argsInput.model.trim()) ||
		process.env.HOJA_SWARM_GENERATOR_MODEL?.trim() ||
		"thinkingmachines/inkling-small";
	const schemaInput = { runId, scenarioId, corpus, modalityPairs, model };
	const args = {
		...schemaInput,
		graphId,
		browserUrl: process.env.HOJA_BASE_URL?.trim() || "",
	};
	return { config: { graphId, model }, args, schemaInput };
}

function opaque(value: unknown, name: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw bad(`${name} is invalid`);
	return value;
}

function stringArray(value: unknown, name: string, max: number): string[] {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		value.length > max ||
		value.some((item) => typeof item !== "string")
	) {
		throw bad(`${name} must be a non-empty bounded string array`);
	}
	return value as string[];
}

function bad(message: string): Error {
	return Object.assign(new Error(message), { status: 400 });
}
