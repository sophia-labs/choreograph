import type { WorkflowBook } from "./book.js";
import type { WorkflowMeta } from "./harness.js";
import type { AgentNodeSpec } from "./types.js";

export interface WorkflowCompositionPlanInput {
	workflowPath: string;
	argsPath?: string;
	graphId?: string;
	meta: WorkflowMeta;
	sha256: string;
	specs: AgentNodeSpec[];
	book: WorkflowBook;
}

export interface WorkflowCompositionPlan {
	kind: "workflowCompositionPlan";
	schemaVersion: 1;
	workflowName: string;
	workflowPath: string;
	argsPath?: string;
	graphId?: string;
	sha256: string;
	subgraph: WorkflowCompositionSubgraph;
	validation: {
		warningCount: number;
		warnings: string[];
	};
	recommendedNextAction: WorkflowCompositionAction;
	nextActions: WorkflowCompositionAction[];
}

export interface WorkflowCompositionSubgraph {
	phaseCount: number;
	agentCount: number;
	phases: WorkflowCompositionPhase[];
}

export interface WorkflowCompositionPhase {
	index: number;
	title: string;
	detail?: string;
	agents: WorkflowCompositionAgent[];
}

export interface WorkflowCompositionAgent {
	label: string;
	phaseIndex: number;
	agentType?: string;
	model?: string;
	toolMode?: string;
	hasSchema: boolean;
	maxTurns?: number;
	runtimeKind: "simple" | "prime" | "unbound";
	ontologyBound: boolean;
}

export interface WorkflowCompositionAction {
	kind: "inspect" | "book" | "adventure" | "garden-draft-validate" | "garden-handoff";
	label: string;
	rationale: string;
	requiresLiveMcp?: boolean;
	requiresExplicitAuthorization?: boolean;
	commandTemplate: string;
}

export function workflowCompositionPlan(input: WorkflowCompositionPlanInput): WorkflowCompositionPlan {
	const subgraph = workflowCompositionSubgraph(input);
	const warnings = workflowCompositionWarnings(input.book);
	const nextActions = workflowCompositionActions(input);
	return {
		kind: "workflowCompositionPlan",
		schemaVersion: 1,
		workflowName: input.meta.name,
		workflowPath: input.workflowPath,
		argsPath: input.argsPath,
		graphId: input.graphId,
		sha256: input.sha256,
		subgraph,
		validation: {
			warningCount: warnings.length,
			warnings,
		},
		recommendedNextAction: nextActions.find((action) => action.kind === "garden-handoff") ?? nextActions[0],
		nextActions,
	};
}

export function renderWorkflowCompositionPlanMarkdown(plan: WorkflowCompositionPlan): string {
	const lines = [
		`# Workflow Composition Plan - ${plan.workflowName}`,
		"",
		`Workflow source: ${plan.workflowPath}`,
		...(plan.argsPath ? [`Arguments: ${plan.argsPath}`] : []),
		`Graph: ${plan.graphId ?? "<graph-id>"}`,
		`Script SHA-256: ${plan.sha256}`,
		`Subgraph: ${plan.subgraph.phaseCount} phase(s), ${plan.subgraph.agentCount} agent node(s)`,
		"",
		"## Agent Subgraph",
	];
	for (const phase of plan.subgraph.phases) {
		lines.push(`- Phase ${phase.index}: ${phase.title}${phase.detail ? ` - ${phase.detail}` : ""}`);
		if (phase.agents.length === 0) {
			lines.push("  - No materialized agent nodes yet.");
		}
		for (const agent of phase.agents) {
			const detail = [
				agent.agentType,
				agent.model,
				agent.toolMode ? `tools=${agent.toolMode}` : undefined,
				agent.hasSchema ? "schema" : "no-schema",
				agent.maxTurns !== undefined ? `maxTurns=${agent.maxTurns}` : undefined,
				`runtime=${agent.runtimeKind}`,
				agent.ontologyBound ? "ontology=bound" : "ontology=unbound-invalid",
			]
				.filter(Boolean)
				.join("; ");
			lines.push(`  - ${agent.label}${detail ? ` (${detail})` : ""}`);
		}
	}
	lines.push("", "## Validation");
	if (plan.validation.warnings.length === 0) {
		lines.push("- No local composition warnings.");
	} else {
		for (const warning of plan.validation.warnings) lines.push(`- ${warning}`);
	}
	lines.push("", "## Recommended Next Action");
	lines.push(`Kind: ${plan.recommendedNextAction.kind}`);
	lines.push(`Rationale: ${plan.recommendedNextAction.rationale}`);
	if (plan.recommendedNextAction.requiresLiveMcp) lines.push("Requires live Garden MCP: true");
	if (plan.recommendedNextAction.requiresExplicitAuthorization)
		lines.push("Execution authorization: required before run submit");
	lines.push(`Command: \`${plan.recommendedNextAction.commandTemplate}\``);
	lines.push("", "## Next Actions");
	for (const action of plan.nextActions) {
		lines.push(`- ${action.label}: \`${action.commandTemplate}\``);
	}
	lines.push("", "## Boundary");
	lines.push(
		"Drafting and validation are safe authoring actions. Execution remains gated inside the Garden workflow book and requires explicit authorization before any run submission.",
	);
	return `${lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()}\n`;
}

function workflowCompositionSubgraph(input: WorkflowCompositionPlanInput): WorkflowCompositionSubgraph {
	const phaseCount = input.book.workflow.phaseCount;
	const phases = Array.from({ length: phaseCount }, (_, index) => {
		const phaseIndex = index + 1;
		const declared = input.meta.phases?.[index];
		return {
			index: phaseIndex,
			title: declared?.title ?? `Phase ${phaseIndex}`,
			detail: declared?.detail,
			agents: input.specs
				.filter((spec) => spec.phaseIndex === phaseIndex)
				.map((spec) => ({
					label: spec.label,
					phaseIndex: spec.phaseIndex,
					agentType: spec.agentType,
					model: spec.model,
					toolMode: spec.toolMode,
					hasSchema: spec.schema !== undefined,
					maxTurns: spec.maxTurns,
					runtimeKind: spec.runtime?.kind ?? "unbound",
					ontologyBound: spec.ontology !== undefined,
				})),
		};
	});
	return {
		phaseCount,
		agentCount: input.book.workflow.agentCount,
		phases,
	};
}

function workflowCompositionWarnings(book: WorkflowBook): string[] {
	const globalWarningPages = new Set(["overview", "validation", "execute"]);
	const warnings = book.pages.filter((page) => globalWarningPages.has(page.id)).flatMap((page) => page.warnings);
	return [...new Set(warnings)];
}

function workflowCompositionActions(input: WorkflowCompositionPlanInput): WorkflowCompositionAction[] {
	const prefix = ["pnpm", "exec", "tsx", "scripts/workflow-compose.ts"];
	const graphId = input.graphId ?? raw("<graph-id>");
	const workflowAndArgs = [input.workflowPath, ...optionalArgs(input.argsPath)];
	return [
		{
			kind: "inspect",
			label: "Inspect source metadata",
			rationale: "Read the portable workflow metadata without drafting or executing anything.",
			commandTemplate: shellCommand([...prefix, "inspect", input.workflowPath]),
		},
		{
			kind: "book",
			label: "Render local book",
			rationale: "Render the offline workflow-book face for source-side review.",
			commandTemplate: shellCommand([...prefix, "book", ...workflowAndArgs]),
		},
		{
			kind: "adventure",
			label: "Open local adventure",
			rationale:
				"Open the perceptual/conceptual page-turn packet over the local workflow book before a live Garden connection exists.",
			commandTemplate: shellCommand([
				...prefix,
				"adventure",
				...workflowAndArgs,
				"--graph",
				graphId,
				"--intent",
				"analysis-scout",
			]),
		},
		{
			kind: "garden-draft-validate",
			label: "Draft and validate in Garden",
			rationale: "Mint the workflow subgraph in Garden and start the background validation watcher.",
			requiresLiveMcp: true,
			commandTemplate: shellCommand([
				...prefix,
				"garden-draft",
				...workflowAndArgs,
				"--graph",
				graphId,
				"--mcp-url",
				raw('"$GARDEN_MCP_URL"'),
				"--validate-watch",
			]),
		},
		{
			kind: "garden-handoff",
			label: "Open scout handoff",
			rationale:
				"Draft the workflow subgraph, start validation, and enter the Garden workflow-book loop on the analysis route.",
			requiresLiveMcp: true,
			requiresExplicitAuthorization: true,
			commandTemplate: shellCommand([
				...prefix,
				"garden-handoff",
				...workflowAndArgs,
				"--graph",
				graphId,
				"--mcp-url",
				raw('"$GARDEN_MCP_URL"'),
				"--handoff-intent",
				"analysis-scout",
				"--max-steps",
				"1",
				"--validate-watch",
			]),
		},
	];
}

function optionalArgs(argsPath: string | undefined): string[] {
	return argsPath ? ["--args", argsPath] : [];
}

type ShellPart = string | { raw: string };

function raw(value: string): { raw: string } {
	return { raw: value };
}

function shellCommand(parts: ShellPart[]): string {
	return parts.map((part) => (typeof part === "string" ? shellQuote(part) : part.raw)).join(" ");
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}
