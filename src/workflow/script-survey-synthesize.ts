/**
 * `graph-survey-synthesize` expressed as a portable Workflow SCRIPT (the FORM (A)
 * interpreter form), replacing the original hand-written control flow. Same
 * topology, prompts, schemas, and `RunRecord` output — but now
 * a script the harness `new Function`-evals against the live primitives, so it is
 * a portable artifact the commons can file (SPEC §9.1).
 *
 * The script body uses ONLY the primitive globals (`agent/parallel/pipeline/
 * phase/log/contract`) + `args`. Everything run-specific — the question, the doc
 * ids, the per-phase models, the TypeBox schemas, and the prompt templates —
 * arrives through `args` (built by `buildSurveySynthesizeInputs`), because a
 * `new Function` body closes over NOTHING but its declared params.
 *
 * Code serializes: the script RETURNS the synthesis payload as `WorkflowOutput`
 * (`{ synthesis: { title, markdown }, question }`); the harness writes the
 * synthesis document. No agent ever calls `write_document` for the artifact.
 */

import type { WorkflowMeta, WorkflowRunInputs } from "./harness.js";
import { MapFindingsSchema, SynthesisSchema } from "./types.js";

export const WORKFLOW_NAME = "graph-survey-synthesize";
export const WORKFLOW_DESCRIPTION = "Survey graph documents in parallel with cheap models and synthesize an answer.";

/** The run-specific inputs the survey-synthesize workflow takes (driver-parity). */
export interface SurveySynthesizeInput {
	graphId: string;
	question: string;
	docIds: string[];
	mapModel: string;
	synthModel: string;
}

const MAP_SYSTEM_PROMPT =
	"You are a graph surveyor. Read exactly the one document you are given (use read_document with the provided id), " +
	"then call submit() with structured findings about how that document bears on the question. Be terse and evidence-based.";

const SYNTH_SYSTEM_PROMPT =
	"You are a findings synthesizer. You are given per-document findings (as JSON). Synthesize a single, well-organized " +
	"answer to the question in Markdown, citing documents by their id. Then call submit() with the title and markdown.";

/**
 * The `meta` block + the source the harness compiles. Kept as a single string so
 * `compileWorkflow` reads it exactly as it reads an on-disk `.mjs` artifact (the
 * `export const meta` literal + the top-level async body ending in `return`).
 *
 * The body pulls EVERYTHING it needs from `args`:
 *   - args.question, args.docIds, args.mapModel, args.synthModel, args.graphId
 *   - args.mapSchema, args.synthSchema      (TypeBox schemas — opaque to the script)
 *   - args.mapSystemPrompt, args.synthSystemPrompt
 */
export const SURVEY_SYNTHESIZE_SCRIPT = `export const meta = {
	name: "graph-survey-synthesize",
	description: "Survey graph documents in parallel with cheap models and synthesize an answer.",
	whenToUse: "Use to answer a question over a known set of graph documents: map each doc with a cheap model, then synthesize.",
	phases: [
		{ title: "map", detail: "One cheap-model surveyor per document (parallel, curated read tools, forced findings schema)." },
		{ title: "synthesize", detail: "One synthesizer reasons over the per-document findings (no tools, forced synthesis schema)." },
	],
	executor: "gated",
	inputs: {
		$schema: "http://json-schema.org/draft-07/schema#",
		type: "object",
		title: "graph-survey-synthesize inputs",
		description: "The run inputs (the POST /api/workflows/run body for this workflow).",
		properties: {
			question: { type: "string", description: "The question to answer over the surveyed documents." },
			doc_ids: {
				type: "array",
				items: { type: "string" },
				description: "Explicit document ids to survey. If omitted/empty, doc_query (or question) is searched.",
			},
			doc_query: { type: "string", description: "Search query used to discover documents when doc_ids is absent (defaults to question)." },
			k: { type: "integer", minimum: 1, maximum: 16, default: 6, description: "Max documents to survey (clamped 1..16)." },
			map_model: { type: "string", description: "OpenRouter model id for the per-document map phase." },
			synth_model: { type: "string", description: "OpenRouter model id for the synthesis phase." },
		},
		required: ["question"],
		additionalProperties: false,
	},
	outputs: {
		$schema: "http://json-schema.org/draft-07/schema#",
		type: "object",
		title: "graph-survey-synthesize output",
		description: "The synthesis payload the workflow returns (the harness serializes it into a document).",
		properties: {
			question: { type: "string", description: "Echo of the answered question." },
			synthesis: {
				type: "object",
				description: "The synthesized answer; absent if the synthesizer produced no structured result.",
				properties: {
					title: { type: "string", description: "A concise title for the synthesis." },
					markdown: { type: "string", description: "The synthesis in Markdown, citing documents by id." },
				},
				required: ["markdown"],
				additionalProperties: false,
			},
		},
		additionalProperties: false,
	},
}

const mapPrompt = (question, docId) => [
	"Question: " + question,
	"",
	'Survey the document with id "' + docId + '". Read it with read_document, then submit your findings:',
	"- relevance (0..1) of this document to the question",
	"- keyPoints bearing on the question",
	"- short evidence quotes",
	"",
	'Set docId to "' + docId + '".',
].join("\\n")

const synthPrompt = (question, findings) => [
	"Question: " + question,
	"",
	"Per-document findings (JSON):",
	"\\\`\\\`\\\`json",
	JSON.stringify(findings, null, 2),
	"\\\`\\\`\\\`",
	"",
	"Synthesize a single answer in Markdown that cites documents by id, then submit{ title, markdown }.",
].join("\\n")

// ── Phase 1: map (parallel, cheap model, curated read tools, forced schema).
phase("map")
const mapResults = await parallel(
	args.docIds.map((docId) => () => agent(mapPrompt(args.question, docId), {
		label: "map:" + docId,
		model: args.mapModel,
		toolMode: "curated",
		schema: args.mapSchema,
		agentType: "graph-surveyor",
		maxTurns: 4,
		systemPrompt: args.mapSystemPrompt,
	})),
)

// ── Phase 2: synthesize (×1, no tools — reasons over the provided findings).
phase("synthesize")
const findings = mapResults.map((r) => r.structured).filter((f) => f !== undefined)
const synth = await agent(synthPrompt(args.question, findings), {
	label: "synthesize",
	model: args.synthModel,
	toolMode: "none",
	schema: args.synthSchema,
	agentType: "findings-synthesizer",
	maxTurns: 2,
	systemPrompt: args.synthSystemPrompt,
})

// ── Code serializes: return the synthesis payload; the harness writes the doc.
const s = synth.structured
const synthesis = s && typeof s === "object" && typeof s.title === "string" && typeof s.markdown === "string"
	? { title: s.title, markdown: s.markdown }
	: undefined
return { synthesis, question: args.question }
`;

/** The compiled-meta companion (so callers can register without re-parsing). */
export const SURVEY_SYNTHESIZE_META: WorkflowMeta = {
	name: WORKFLOW_NAME,
	description: WORKFLOW_DESCRIPTION,
	whenToUse: "Use to answer a question over a known set of graph documents.",
	phases: [
		{ title: "map", detail: "One cheap-model surveyor per document." },
		{ title: "synthesize", detail: "One synthesizer reasons over the per-document findings." },
	],
	executor: "gated",
	inputs: {
		$schema: "http://json-schema.org/draft-07/schema#",
		type: "object",
		title: "graph-survey-synthesize inputs",
		properties: {
			question: { type: "string" },
			doc_ids: { type: "array", items: { type: "string" } },
			doc_query: { type: "string" },
			k: { type: "integer", minimum: 1, maximum: 16, default: 6 },
			map_model: { type: "string" },
			synth_model: { type: "string" },
		},
		required: ["question"],
		additionalProperties: false,
	},
	outputs: {
		$schema: "http://json-schema.org/draft-07/schema#",
		type: "object",
		title: "graph-survey-synthesize output",
		properties: {
			question: { type: "string" },
			synthesis: {
				type: "object",
				properties: { title: { type: "string" }, markdown: { type: "string" } },
				required: ["markdown"],
				additionalProperties: false,
			},
		},
		additionalProperties: false,
	},
};

/**
 * Build the `WorkflowRunInputs` for the survey-synthesize script from the same
 * `SurveySynthesizeInput` the driver took — the schemas + prompts + per-phase
 * models all travel through `args` (a `new Function` body closes over nothing).
 */
export function buildSurveySynthesizeInputs(input: SurveySynthesizeInput): WorkflowRunInputs {
	return {
		config: {
			graphId: input.graphId,
			// Interpreter default model; each agent() overrides with its phase model.
			model: input.mapModel,
		},
		args: {
			question: input.question,
			docIds: input.docIds,
			graphId: input.graphId,
			mapModel: input.mapModel,
			synthModel: input.synthModel,
			mapSchema: MapFindingsSchema,
			synthSchema: SynthesisSchema,
			mapSystemPrompt: MAP_SYSTEM_PROMPT,
			synthSystemPrompt: SYNTH_SYSTEM_PROMPT,
		},
		schemaInput: {
			question: input.question,
			doc_ids: input.docIds,
			map_model: input.mapModel,
			synth_model: input.synthModel,
		},
	};
}
