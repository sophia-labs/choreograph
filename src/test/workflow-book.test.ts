import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
	renderWorkflowAdventureMarkdown,
	renderWorkflowAdventureTurtle,
	workflowAdventureLegacySubjectIri,
	workflowAdventurePacket,
	workflowAdventureSubjectIri,
} from "../workflow/adventure.js";
import { renderWorkflowBook } from "../workflow/book.js";
import { renderWorkflowCompositionPlanMarkdown, workflowCompositionPlan } from "../workflow/composition-plan.js";
import { compileWorkflow, runWorkflow } from "../workflow/harness.js";
import type { WorkflowDeps } from "../workflow/interpreter-primitives.js";
import type { AgentNodeResult, AgentNodeSpec, NodeRunner } from "../workflow/types.js";

const BOOK_SCRIPT = `export const meta = {
	name: "book-demo",
	description: "Demonstrates a workflow book over a two-phase graph.",
	whenToUse: "Use to test the workflow-book UX.",
	phases: [
		{ title: "extract", detail: "Two extractors inspect the input in parallel." },
		{ title: "adjudicate", detail: "One adjudicator resolves the extractor outputs." },
	],
	executor: "gated",
	inputs: { type: "object", properties: { item: { type: "string" } }, required: ["item"] },
	outputs: { type: "object", properties: { ok: { type: "boolean" } } },
}

phase("extract")
const extracted = await parallel([
	() => agent("Extract A: " + args.item, {
		label: "extractor-a",
		model: args.extractorModel,
		toolMode: "none",
		schema: args.schema,
		agentType: "extractor",
		maxTurns: 1,
	}),
	() => agent("Extract B: " + args.item, {
		label: "extractor-b",
		model: args.extractorModel,
		toolMode: "none",
		schema: args.schema,
		agentType: "extractor",
		maxTurns: 1,
	}),
])

phase("adjudicate")
await agent("Adjudicate: " + JSON.stringify(extracted.map((r) => r.structured)), {
	label: "adjudicator",
	model: args.adjudicatorModel,
	toolMode: "none",
	schema: args.schema,
	agentType: "adjudicator",
	maxTurns: 1,
})

return { result: { ok: true } }
`;

function fakeRunner() {
	const calls: AgentNodeSpec[] = [];
	const runNode: NodeRunner = async (spec) => {
		calls.push(spec);
		const result: AgentNodeResult = {
			label: spec.label,
			phaseIndex: spec.phaseIndex,
			state: "done",
			output: `done:${spec.label}`,
			structured: { ok: true, label: spec.label },
			model: spec.model,
			turns: 1,
			toolCalls: spec.schema ? 1 : 0,
			tokens: 1,
			queuedAt: 0,
			startedAt: 0,
			durationMs: 1,
			agentType: spec.agentType,
		};
		return result;
	};
	return { runNode, calls };
}

function deps(runNode: NodeRunner): WorkflowDeps {
	let t = 1;
	return { runNode, runId: "book-run", now: () => t++ };
}

describe("workflow book renderer", () => {
	it("renders overview, phase, agent, validation, execution, and raw pages from a materialized workflow", async () => {
		const compiled = compileWorkflow(BOOK_SCRIPT);
		const { runNode, calls } = fakeRunner();
		await runWorkflow(deps(runNode), compiled, {
			config: { graphId: "book-graph", model: "fallback/model", toolMode: "none" },
			args: {
				item: "case-1",
				extractorModel: "openai/gpt-5.5-medium",
				adjudicatorModel: "openai/gpt-5.5-medium",
				schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
			},
		});

		const sha256 = createHash("sha256").update(BOOK_SCRIPT).digest("hex");
		const book = renderWorkflowBook({
			meta: compiled.meta,
			source: BOOK_SCRIPT,
			sha256,
			graphId: "book-graph",
			args: { item: "case-1" },
			specs: calls,
		});

		assert.equal(book.workflow.name, "book-demo");
		assert.equal(book.workflow.phaseCount, 2);
		assert.equal(book.workflow.agentCount, 3);
		assert.equal(book.startPageId, "overview");

		const pageIds = new Set(book.pages.map((page) => page.id));
		assert.ok(pageIds.has("overview"));
		assert.ok(pageIds.has("phase-1"));
		assert.ok(pageIds.has("phase-2"));
		assert.ok(pageIds.has("agent-extractor-a"));
		assert.ok(pageIds.has("agent-adjudicator"));
		assert.ok(pageIds.has("validation"));
		assert.ok(pageIds.has("execute"));
		assert.ok(pageIds.has("raw"));

		const overview = book.pages.find((page) => page.id === "overview");
		assert.ok(overview);
		assert.ok(overview.objects.includes("agent:extractor-a"));
		assert.ok(overview.choices.some((choice) => choice.id === "raw-sparql"));
		assert.deepEqual(overview.warnings, []);

		const execution = book.pages.find((page) => page.id === "execute");
		assert.ok(execution);
		const submit = execution.choices.find((choice) => choice.id === "submit-run");
		assert.ok(submit);
		assert.equal(submit.payload?.workflow_name, "book-demo");
		assert.equal((submit.payload?.workflow_binding as Record<string, unknown> | undefined)?.scriptSha256, sha256);

		assert.equal(book.raw.sparql.length, 3);
		assert.match(book.raw.sparql[0].query, /wf:Workflow/);
		assert.equal((book.raw.choreographRunBody.workflow_binding as Record<string, unknown>).name, "book-demo");

		const plan = workflowCompositionPlan({
			workflowPath: "scripts/demo.workflow.js",
			argsPath: "scripts/demo.args.json",
			graphId: "book-graph",
			meta: compiled.meta,
			sha256,
			specs: calls,
			book,
		});

		assert.equal(plan.kind, "workflowCompositionPlan");
		assert.equal(plan.schemaVersion, 1);
		assert.equal(plan.subgraph.phaseCount, 2);
		assert.equal(plan.subgraph.agentCount, 3);
		assert.deepEqual(
			plan.subgraph.phases.map((phase) => [phase.title, phase.agents.map((agent) => agent.label)]),
			[
				["extract", ["extractor-a", "extractor-b"]],
				["adjudicate", ["adjudicator"]],
			],
		);
		assert.equal(plan.recommendedNextAction.kind, "garden-handoff");
		assert.equal(plan.recommendedNextAction.requiresLiveMcp, true);
		assert.equal(plan.recommendedNextAction.requiresExplicitAuthorization, true);
		assert.equal(plan.nextActions.find((action) => action.kind === "adventure")?.label, "Open local adventure");
		assert.match(plan.recommendedNextAction.commandTemplate, /garden-handoff scripts\/demo\.workflow\.js/);
		assert.match(plan.recommendedNextAction.commandTemplate, /--args scripts\/demo\.args\.json/);
		assert.match(plan.recommendedNextAction.commandTemplate, /--graph book-graph/);
		assert.match(plan.recommendedNextAction.commandTemplate, /--mcp-url "\$GARDEN_MCP_URL"/);
		assert.match(plan.recommendedNextAction.commandTemplate, /--handoff-intent analysis-scout/);
		assert.match(plan.recommendedNextAction.commandTemplate, /--validate-watch/);

		const markdown = renderWorkflowCompositionPlanMarkdown(plan);
		assert.match(markdown, /^# Workflow Composition Plan - book-demo/m);
		assert.match(markdown, /## Agent Subgraph/);
		assert.match(markdown, /Phase 1: extract/);
		assert.match(markdown, /extractor-a .*lme-frame|extractor-a/);
		assert.match(markdown, /## Recommended Next Action/);
		assert.match(markdown, /Command: `pnpm exec tsx scripts\/workflow-compose\.ts garden-handoff/);

		const adventure = workflowAdventurePacket({
			book,
			workflowPath: "scripts/demo.workflow.js",
			argsPath: "scripts/demo.args.json",
			graphId: "book-graph",
			intent: "analysis-scout",
			generatedAt: "2026-06-25T05:00:00.000Z",
		});
		assert.equal(adventure.kind, "workflowAdventurePacket");
		assert.equal(adventure.schemaVersion, 1);
		assert.equal(adventure.generatedAt, "2026-06-25T05:00:00.000Z");
		assert.match(
			adventure.rdfSubjectIri ?? "",
			/^urn:sophia:wf:page-view:book-graph:book-demo:overview:analysis-scout:[a-f0-9]{32}$/,
		);
		assert.equal(
			adventure.legacyRdfSubjectIri,
			"urn:sophia:workflow-adventure:book-graph:book-demo:overview:analysis-scout",
		);
		assert.equal(workflowAdventureSubjectIri(adventure), adventure.rdfSubjectIri);
		assert.equal(workflowAdventureLegacySubjectIri(adventure), adventure.legacyRdfSubjectIri);
		assert.equal(adventure.page.id, "overview");
		assert.equal(
			adventure.navigationRoutes.find((route) => route.id === "analysis-scout")?.choiceId,
			"inspect-phases",
		);
		assert.equal(adventure.navigationRoutes.find((route) => route.id === "raw-sparql")?.targetPageId, "raw");
		assert.equal(
			adventure.navigationRoutes.find((route) => route.id === "run-prep")?.requiresExplicitAuthorization,
			true,
		);
		assert.equal(adventure.recommendedNextAction?.kind, "follow-route");
		assert.equal(adventure.recommendedNextAction?.routeId, "analysis-scout");
		assert.equal(adventure.suggestedChoice?.id, "inspect-phases");
		assert.match(adventure.recommendedNextAction?.commandTemplate ?? "", /workflow-compose\.ts adventure/);
		assert.match(adventure.recommendedNextAction?.commandTemplate ?? "", /--page phase-1/);
		assert.match(adventure.recommendedNextAction?.commandTemplate ?? "", /--intent analysis-scout/);

		const phaseAdventure = workflowAdventurePacket({
			book,
			workflowPath: "scripts/demo.workflow.js",
			argsPath: "scripts/demo.args.json",
			graphId: "book-graph",
			routeId: "analysis-scout",
			intent: "analysis-scout",
			generatedAt: "2026-06-25T05:01:00.000Z",
		});
		assert.equal(phaseAdventure.page.id, "phase-1");
		assert.equal(phaseAdventure.fromPage?.id, "overview");
		assert.equal(phaseAdventure.followedRoute?.id, "analysis-scout");
		assert.deepEqual(
			phaseAdventure.navigationRoutes
				.filter((route) => route.kind === "object")
				.map((route) => [route.id, route.choiceId]),
			[
				["agent-extractor-a", "inspect-extractor-a"],
				["agent-extractor-b", "inspect-extractor-b"],
			],
		);

		const adventureMarkdown = renderWorkflowAdventureMarkdown(adventure);
		assert.match(adventureMarkdown, /^# Workflow Adventure - book-demo \/ book-demo/m);
		assert.match(adventureMarkdown, /## Routes/);
		assert.match(adventureMarkdown, /analysis-scout: Analysis scout -> inspect-phases/);
		assert.match(adventureMarkdown, /raw-sparql: Raw SPARQL -> raw-sparql/);
		assert.match(adventureMarkdown, /## Raw SPARQL/);

		const adventureTurtle = renderWorkflowAdventureTurtle(adventure);
		assert.match(adventureTurtle, /@prefix wf: <http:\/\/mnemosyne.dev\/workflow#> ./);
		assert.match(adventureTurtle, /@prefix wfui: <https:\/\/sophia-labs.com\/ns\/workflow-ui#> ./);
		assert.match(adventureTurtle, /a wf:PageView, prov:Entity/);
		assert.match(
			adventureTurtle,
			/wf:supersedesPageView <urn:sophia:workflow-adventure:book-graph:book-demo:overview:analysis-scout>/,
		);
		assert.match(adventureTurtle, /a wf:RawSparqlQuery, prov:Entity/);
		assert.match(adventureTurtle, /wf:queryText "PREFIX wf: <http:\/\/mnemosyne.dev\/workflow#>/);
		assert.match(adventureTurtle, /a wf:RouteAction, prov:Entity/);
		assert.match(
			adventureTurtle,
			/wf:argument <urn:sophia:wf:page-view:.*:route:analysis-scout:action:arg:workflowpath>/,
		);
		assert.match(adventureTurtle, /a wf:RecommendedAction, prov:Entity/);
		assert.match(adventureTurtle, /a wfui:WorkflowAdventurePacket, prov:Entity/);
		assert.match(adventureTurtle, /wfui:workflowName "book-demo"/);
		assert.match(adventureTurtle, /wfui:pageId "overview"/);
		assert.match(adventureTurtle, /wfui:recommendedRouteId "analysis-scout"/);
		assert.match(adventureTurtle, /wfui:recommendedChoiceId "inspect-phases"/);
		assert.match(adventureTurtle, /wfui:hasNavigationRoute <urn:sophia:workflow-adventure:.*:route:analysis-scout>/);
		assert.match(adventureTurtle, /a wfui:NavigationRoute, prov:Entity/);
		assert.match(adventureTurtle, /wfui:routeKind "raw-sparql"/);
		assert.match(adventureTurtle, /wfui:rawSparqlJson "\[\{\\"query\\":/);
		assert.match(adventureTurtle, /wfui:hasAuthorizationFlag <urn:sophia:workflow-adventure:.*:authorization:1>/);
		assert.match(adventureTurtle, /a wfui:AuthorizationFlag, prov:Entity/);
		assert.match(adventureTurtle, /wfui:choiceId "execute-async"/);
	});
});
