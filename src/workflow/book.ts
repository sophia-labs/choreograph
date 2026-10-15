import type { WorkflowMeta } from "./harness.js";
import type { AgentNodeSpec } from "./types.js";

export type WorkflowBookChoiceKind = "navigate" | "validate" | "execute" | "edit" | "raw";

export interface WorkflowBookChoice {
	id: string;
	label: string;
	description: string;
	kind: WorkflowBookChoiceKind;
	targetPageId?: string;
	action?: string;
	payload?: Record<string, unknown>;
}

export interface WorkflowBookPage {
	id: string;
	title: string;
	scene: string;
	objects: string[];
	warnings: string[];
	choices: WorkflowBookChoice[];
}

export interface WorkflowBook {
	workflow: {
		name: string;
		description?: string;
		sha256?: string;
		executor: "gated" | "dumb";
		phaseCount: number;
		agentCount: number;
	};
	startPageId: string;
	pages: WorkflowBookPage[];
	raw: {
		sparql: Array<{ title: string; query: string }>;
		choreographRunBody: Record<string, unknown>;
	};
}

export interface WorkflowBookInput {
	meta: WorkflowMeta;
	source?: string;
	sha256?: string;
	args?: unknown;
	graphId?: string;
	specs?: AgentNodeSpec[];
}

export function renderWorkflowBook(input: WorkflowBookInput): WorkflowBook {
	const specs = input.specs ?? [];
	const phases = materializedPhases(input.meta, specs);
	const pages: WorkflowBookPage[] = [];

	pages.push(overviewPage(input, phases, specs));
	for (const phase of phases) pages.push(phasePage(phase, specs));
	for (const spec of specs) pages.push(agentPage(spec));
	pages.push(validationPage(input.meta, specs));
	pages.push(executionPage(input));
	pages.push(rawPage(input.meta));

	return {
		workflow: {
			name: input.meta.name,
			description: input.meta.description,
			sha256: input.sha256,
			executor: input.meta.executor ?? "gated",
			phaseCount: phases.length,
			agentCount: specs.length,
		},
		startPageId: "overview",
		pages,
		raw: {
			sparql: workflowSparqlQueries(input.meta.name),
			choreographRunBody: choreographRunBody(input),
		},
	};
}

interface PhaseView {
	index: number;
	title: string;
	detail?: string;
}

function materializedPhases(meta: WorkflowMeta, specs: AgentNodeSpec[]): PhaseView[] {
	const declared = meta.phases ?? [];
	const maxSpecPhase = specs.reduce((max, spec) => Math.max(max, spec.phaseIndex), 0);
	const count = Math.max(declared.length, maxSpecPhase, declared.length > 0 ? 0 : 1);
	return Array.from({ length: count }, (_, i) => {
		const declaredPhase = declared[i];
		return {
			index: i + 1,
			title: declaredPhase?.title ?? `Phase ${i + 1}`,
			detail: declaredPhase?.detail,
		};
	});
}

function overviewPage(input: WorkflowBookInput, phases: PhaseView[], specs: AgentNodeSpec[]): WorkflowBookPage {
	const warnings = workflowWarnings(input.meta, specs);
	return {
		id: "overview",
		title: input.meta.name,
		scene:
			specs.length > 0
				? `A ${phases.length}-phase workflow with ${specs.length} materialized agent node(s).`
				: `A ${phases.length}-phase workflow definition. Preview with run args to reveal dynamic agent nodes.`,
		objects: [
			...phases.map((phase) => `phase:${phase.index}:${phase.title}`),
			...specs.map((spec) => `agent:${spec.label}`),
			...(input.meta.inputs ? ["contract:inputs"] : []),
			...(input.meta.outputs ? ["contract:outputs"] : []),
		],
		warnings,
		choices: [
			{
				id: "inspect-phases",
				label: "Inspect phases",
				description: "Walk the workflow phase by phase.",
				kind: "navigate",
				targetPageId: "phase-1",
			},
			{
				id: "validate-workflow",
				label: "Validate workflow",
				description: "Check the definition, declared contracts, and materialized nodes.",
				kind: "validate",
				targetPageId: "validation",
				action: "workflow.validate",
			},
			{
				id: "execute-async",
				label: "Execute async",
				description: "Submit this workflow binding to Choreograph and monitor the run journal.",
				kind: "execute",
				targetPageId: "execute",
				action: "workflow.execute",
			},
			{
				id: "raw-sparql",
				label: "Raw SPARQL",
				description: "Drop to the exact RDF query/update layer.",
				kind: "raw",
				targetPageId: "raw",
			},
		],
	};
}

function phasePage(phase: PhaseView, specs: AgentNodeSpec[]): WorkflowBookPage {
	const phaseSpecs = specs.filter((spec) => spec.phaseIndex === phase.index);
	return {
		id: `phase-${phase.index}`,
		title: `Phase ${phase.index}: ${phase.title}`,
		scene: phase.detail ?? `${phaseSpecs.length} agent node(s) materialize in this phase.`,
		objects: phaseSpecs.map((spec) => `agent:${spec.label}`),
		warnings: phaseSpecs.length === 0 ? ["No materialized agent nodes were observed for this phase."] : [],
		choices: [
			...phaseSpecs.map((spec) => ({
				id: `inspect-${slug(spec.label)}`,
				label: `Inspect ${spec.label}`,
				description: "Review model, tool surface, schema contract, and prompt shape.",
				kind: "navigate" as const,
				targetPageId: `agent-${slug(spec.label)}`,
			})),
			{
				id: "bind-contract",
				label: "Bind contract",
				description: "Attach or revise a JSON-schema contract for an agent in this phase.",
				kind: "edit",
				action: "workflow.bindContract",
				payload: { phaseIndex: phase.index },
			},
			{
				id: "overview",
				label: "Back to overview",
				description: "Return to the workflow overview.",
				kind: "navigate",
				targetPageId: "overview",
			},
		],
	};
}

function agentPage(spec: AgentNodeSpec): WorkflowBookPage {
	const warnings = [
		...(spec.schema === undefined ? ["No structured-output schema is bound to this agent."] : []),
		...(spec.toolMode === "dynamic" ? ["Dynamic tool mode is broad; prefer a narrower surface when possible."] : []),
		...(spec.maxTurns === undefined ? ["No explicit turn budget is set for this node."] : []),
		...(spec.ontology === undefined
			? ["No pinned Agent Ontology / Meaningful Objects binding is attached to this node."]
			: []),
		...(spec.prompt.length > 60_000
			? [
					`Prompt is ${spec.prompt.length} characters; prefer a document/artifact reference when the executor can read it.`,
				]
			: []),
	];
	return {
		id: `agent-${slug(spec.label)}`,
		title: spec.label,
		scene: `${spec.agentType ?? "agent"} using ${spec.runtime?.kind ?? "unbound (not executable)"} runtime, ${spec.model}, and ${spec.toolMode ?? "curated"} tools.`,
		objects: [
			`phase:${spec.phaseIndex}`,
			`runtime:${spec.runtime?.kind ?? "unbound"}`,
			`model:${spec.model}`,
			`toolMode:${spec.toolMode ?? "curated"}`,
			...(spec.ontology
				? [
						`agentMO:${spec.ontology.objects.agent.objectId}@${spec.ontology.objects.agent.version}`,
						`geistMO:${spec.ontology.objects.geist.objectId}@${spec.ontology.objects.geist.version}`,
						`runtimeProfileMO:${spec.ontology.objects.runtimeProfile.objectId}@${spec.ontology.objects.runtimeProfile.version}`,
					]
				: []),
			...(spec.schema !== undefined ? ["contract:outputSchema"] : []),
			...(spec.capabilities ? Object.keys(spec.capabilities).map((name) => `capability:${name}`) : []),
		],
		warnings,
		choices: [
			{
				id: "edit-agent",
				label: "Edit agent",
				description: "Change model, tool surface, budget, prompt, or capability declarations.",
				kind: "edit",
				action: "workflow.editAgent",
				payload: { label: spec.label },
			},
			{
				id: "preview-prompt",
				label: "Preview prompt",
				description: "Inspect the materialized prompt sent to this node.",
				kind: "navigate",
				targetPageId: `agent-${slug(spec.label)}`,
				payload: { prompt: spec.prompt },
			},
			{
				id: "phase",
				label: "Back to phase",
				description: "Return to this node's phase page.",
				kind: "navigate",
				targetPageId: `phase-${spec.phaseIndex}`,
			},
		],
	};
}

function validationPage(meta: WorkflowMeta, specs: AgentNodeSpec[]): WorkflowBookPage {
	const warnings = workflowWarnings(meta, specs);
	return {
		id: "validation",
		title: "Validation",
		scene:
			warnings.length === 0
				? "The workflow book has no local warnings."
				: "The workflow book found issues to review.",
		objects: ["contract:workflow", "contract:inputs", "contract:outputs", "emitter:emporium"],
		warnings,
		choices: [
			{
				id: "dry-run-emporium",
				label: "Dry-run Emporium",
				description: "Ask Garden to plan the workflow subgraph without applying it.",
				kind: "validate",
				action: "emporium.workflow.dryRun",
			},
			{
				id: "preview-topology",
				label: "Preview topology",
				description: "Re-run the harness with fake agents to inspect materialized nodes.",
				kind: "validate",
				action: "workflow.preview",
			},
			{
				id: "overview",
				label: "Back to overview",
				description: "Return to the workflow overview.",
				kind: "navigate",
				targetPageId: "overview",
			},
		],
	};
}

function executionPage(input: WorkflowBookInput): WorkflowBookPage {
	return {
		id: "execute",
		title: "Execute",
		scene: "Submit this workflow binding to Choreograph, then monitor the run via the run detail or SSE endpoints.",
		objects: ["endpoint:POST /api/workflows/run", "endpoint:GET /api/workflows/runs/:runId", "endpoint:SSE events"],
		warnings:
			input.source === undefined
				? ["This book has no source attached, so it cannot produce a dynamic run binding."]
				: ["Dynamic source execution requires a trusted Choreograph with WORKFLOW_DYNAMIC_SOURCE=1."],
		choices: [
			{
				id: "submit-run",
				label: "Submit run",
				description: "Execute the workflow asynchronously and return a run id.",
				kind: "execute",
				action: "choreograph.workflows.run",
				payload: choreographRunBody(input),
			},
			{
				id: "monitor-run",
				label: "Monitor run",
				description: "Open the journal stream for an existing run id.",
				kind: "execute",
				action: "choreograph.workflows.monitor",
			},
			{
				id: "overview",
				label: "Back to overview",
				description: "Return to the workflow overview.",
				kind: "navigate",
				targetPageId: "overview",
			},
		],
	};
}

function rawPage(meta: WorkflowMeta): WorkflowBookPage {
	return {
		id: "raw",
		title: "Raw Graph",
		scene: "Use SPARQL directly when the book abstraction is too coarse.",
		objects: ["rdf:wf:Workflow", "rdf:wf:Phase", "rdf:wf:AgentNode", "rdf:wf:Run"],
		warnings: [],
		choices: workflowSparqlQueries(meta.name).map((query) => ({
			id: `sparql-${slug(query.title)}`,
			label: query.title,
			description: "Run or adapt this SPARQL against the Garden graph.",
			kind: "raw" as const,
			action: "sparql.query",
			payload: { query: query.query },
		})),
	};
}

function workflowWarnings(meta: WorkflowMeta, specs: AgentNodeSpec[]): string[] {
	const warnings: string[] = [];
	if (!meta.description) warnings.push("Workflow meta.description is missing.");
	if (!meta.inputs) warnings.push("Workflow meta.inputs JSON Schema is missing.");
	if (!meta.outputs) warnings.push("Workflow meta.outputs JSON Schema is missing.");
	if (!meta.phases || meta.phases.length === 0) warnings.push("Workflow meta.phases is empty.");
	const labels = new Set<string>();
	for (const spec of specs) {
		if (labels.has(spec.label)) warnings.push(`Duplicate agent label observed: ${spec.label}.`);
		labels.add(spec.label);
		if (spec.schema === undefined) warnings.push(`Agent '${spec.label}' has no structured-output schema.`);
		if (spec.prompt.length > 60_000)
			warnings.push(`Agent '${spec.label}' has a very large prompt (${spec.prompt.length} characters).`);
	}
	return [...new Set(warnings)];
}

function choreographRunBody(input: WorkflowBookInput): Record<string, unknown> {
	const body: Record<string, unknown> = {
		graph_id: input.graphId ?? "workflow-compose-preview",
		workflow_name: input.meta.name,
		workflow_args: input.args ?? {},
	};
	if (input.source !== undefined) {
		body.workflow_binding = {
			name: input.meta.name,
			source: input.source,
			scriptSha256: input.sha256,
		};
	}
	return body;
}

function workflowSparqlQueries(workflowName: string): Array<{ title: string; query: string }> {
	const escaped = workflowName.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return [
		{
			title: "Find workflow",
			query: [
				"PREFIX wf: <http://mnemosyne.dev/workflow#>",
				"SELECT ?workflow ?sha WHERE {",
				"  GRAPH ?g {",
				`    ?workflow a wf:Workflow ; wf:name "${escaped}" ; wf:scriptSha256 ?sha .`,
				"  }",
				"}",
			].join("\n"),
		},
		{
			title: "List nodes",
			query: [
				"PREFIX wf: <http://mnemosyne.dev/workflow#>",
				"SELECT ?node ?label ?phase WHERE {",
				"  GRAPH ?g {",
				`    ?workflow wf:name "${escaped}" .`,
				"    ?node a wf:AgentNode ; wf:partOfWorkflow ?workflow ; wf:label ?label ; wf:phaseIndex ?phase .",
				"  }",
				"} ORDER BY ?phase ?label",
			].join("\n"),
		},
		{
			title: "List runs",
			query: [
				"PREFIX wf: <http://mnemosyne.dev/workflow#>",
				"PREFIX prov: <http://www.w3.org/ns/prov#>",
				"SELECT ?run ?status ?started WHERE {",
				"  GRAPH ?g {",
				`    ?workflow wf:name "${escaped}" .`,
				"    ?run a wf:Run ; prov:used ?workflow ; wf:status ?status ; prov:startedAtTime ?started .",
				"  }",
				"} ORDER BY DESC(?started)",
			].join("\n"),
		},
	];
}

function slug(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "item";
}
