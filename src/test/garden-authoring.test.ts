import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
	callGardenWorkflowAuthoringSession,
	composeGardenWorkflowDraft,
	type GardenMcpCaller,
	gardenMcpCallerFromHttp,
	gardenPageTurnDecisionDetail,
	gardenPageTurnDecisionDetailQuery,
	gardenPageTurnDecisionLaunch,
	gardenPageTurnDecisionLaunchSelection,
	gardenPageTurnDecisions,
	gardenPageTurnDecisionsQuery,
	gardenWorkflowAdventureDetail,
	gardenWorkflowAdventureDetailSelection,
	gardenWorkflowChoiceCommand,
	gardenWorkflowDraftPlan,
	gardenWorkflowFollowSuggestedCommand,
	gardenWorkflowRecommendedRouteId,
	gardenWorkflowRouteCommand,
	gardenWorkflowRouteSessionRequest,
	gardenWorkflowSessionArguments,
	gardenWorkflowSessionChoicePacket,
	gardenWorkflowSuggestedSessionRequest,
	gardenWorkflowTranscriptEntry,
	gardenWorkflowTranscriptHandoff,
	gardenWorkflowWalkSuggested,
	parseGardenWorkflowTranscriptJsonl,
	renderGardenPageTurnDecisionDetailMarkdown,
	renderGardenPageTurnDecisionsMarkdown,
	renderGardenWorkflowSessionMarkdown,
	renderGardenWorkflowTranscriptHandoffMarkdown,
} from "../workflow/garden-authoring.js";
import type { WorkflowMeta } from "../workflow/harness.js";

const META: WorkflowMeta = {
	name: "garden-bridge-demo",
	description: "Draft a workflow through Garden's graph-backed workflow book.",
	whenToUse: "Use when a Choreograph workflow should become a Garden Meaningful Object.",
	phases: [
		{ title: "Scout", detail: "Inspect the relevant graph context." },
		{ title: "Synthesize", detail: "Return one compact synthesis." },
	],
};

const SOURCE = `export const meta = {
	name: "garden-bridge-demo",
}

phase("Scout")
await agent("Inspect the graph.", { label: "scout" })

phase("Synthesize")
return { synthesis: { markdown: "done" } }
`;

describe("Garden workflow authoring bridge", () => {
	it("writes source and args blocks, drafts workflow moves, and can start Garden validation watching", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const caller: GardenMcpCaller = {
			async callTool(name, args) {
				calls.push({ name, args });
				if (name === "write_document") {
					return { blockIds: calls.length === 1 ? ["source-block"] : ["input-block"] };
				}
				if (name === "workflow_authoring_session" && args.operation === "draft") {
					return { operation: "draft", payload: { draft: { kind: "workflowAuthoringDraft" } } };
				}
				if (name === "workflow_authoring_session" && args.mode === "validate") {
					return { operation: "background", payload: { background: { mode: "validate" } } };
				}
				throw new Error(`unexpected tool call ${name}: ${JSON.stringify(args)}`);
			},
		};

		const result = await composeGardenWorkflowDraft(
			caller,
			{
				graphId: "garden-graph",
				meta: META,
				source: SOURCE,
				workflowArgs: { shardId: "shard-01" },
			},
			{ startValidationWatch: true },
		);

		const expectedSha = createHash("sha256").update(SOURCE).digest("hex");
		assert.equal(result.plan.workflowName, "garden-bridge-demo");
		assert.equal(result.plan.scriptSha256, expectedSha);
		assert.deepEqual(result.plan.sourceBlock, {
			documentId: "garden-bridge-demo-workflow-source",
			blockId: "source-block",
		});
		assert.deepEqual(result.plan.inputBlock, {
			documentId: "garden-bridge-demo-workflow-input",
			blockId: "input-block",
		});
		assert.deepEqual(result.plan.moves, [
			{
				operation: "create_workflow",
				description: META.description,
				whenToUse: META.whenToUse,
				sourceDocumentId: "garden-bridge-demo-workflow-source",
				sourceBlockId: "source-block",
				scriptSha256: expectedSha,
			},
			{
				operation: "add_phase",
				phaseOrder: 1,
				phaseTitle: "Scout",
				phaseDescription: "Inspect the relevant graph context.",
			},
			{
				operation: "add_phase",
				phaseOrder: 2,
				phaseTitle: "Synthesize",
				phaseDescription: "Return one compact synthesis.",
			},
			{
				operation: "bind_input_block",
				inputDocumentId: "garden-bridge-demo-workflow-input",
				inputBlockId: "input-block",
			},
		]);

		assert.equal(calls.length, 4);
		assert.equal(calls[0].name, "write_document");
		assert.equal(calls[0].args.graphId, "garden-graph");
		assert.equal(calls[0].args.documentId, "garden-bridge-demo-workflow-source");
		assert.equal(calls[0].args.format, "markdown");
		assert.match(String(calls[0].args.content), /^```js\nexport const meta/);

		assert.equal(calls[1].name, "write_document");
		assert.equal(calls[1].args.documentId, "garden-bridge-demo-workflow-input");
		assert.match(String(calls[1].args.content), /^```json\n\{/);

		assert.deepEqual(calls[2], {
			name: "workflow_authoring_session",
			args: {
				graphId: "garden-graph",
				operation: "draft",
				workflowName: "garden-bridge-demo",
				pageId: "execute",
				moves: result.plan.moves,
			},
		});
		assert.deepEqual(calls[3], {
			name: "workflow_authoring_session",
			args: {
				graphId: "garden-graph",
				operation: "background",
				mode: "validate",
				workflowName: "garden-bridge-demo",
				pageId: "overview",
			},
		});
	});

	it("can build draft moves from existing Garden block references without writing inputs", () => {
		const plan = gardenWorkflowDraftPlan({
			meta: { name: "existing-ref-demo" },
			sourceBlock: { documentId: "source-doc", blockId: "source-block" },
			scriptSha256: "abc123",
		});

		assert.deepEqual(plan.moves, [
			{
				operation: "create_workflow",
				description: "Workflow existing-ref-demo.",
				whenToUse: undefined,
				sourceDocumentId: "source-doc",
				sourceBlockId: "source-block",
				scriptSha256: "abc123",
			},
		]);
		assert.equal(plan.inputBlock, undefined);
		assert.deepEqual(plan.agentNodes, []);
	});

	it("adds materialized agent nodes to Garden draft moves", () => {
		const plan = gardenWorkflowDraftPlan({
			meta: {
				name: "agent-node-demo",
				phases: [
					{ title: "Extract", detail: "Extract labels." },
					{ title: "Adjudicate", detail: "Adjudicate labels." },
				],
			},
			sourceBlock: { documentId: "source-doc", blockId: "source-block" },
			scriptSha256: "abc123",
			agentNodes: [
				{ label: "extractor-a", phaseIndex: 1, agentType: "lme-frame-extractor" },
				{ label: "adjudicator", phaseIndex: 2, agentType: "lme-frame-adjudicator" },
			],
		});

		assert.deepEqual(plan.agentNodes, [
			{ label: "extractor-a", phaseIndex: 1, agentType: "lme-frame-extractor" },
			{ label: "adjudicator", phaseIndex: 2, agentType: "lme-frame-adjudicator" },
		]);
		assert.deepEqual(
			plan.moves.filter((move) => move.operation === "attach_agent_node"),
			[
				{
					operation: "attach_agent_node",
					label: "extractor-a",
					phaseIndex: 1,
					agentType: "lme-frame-extractor",
				},
				{
					operation: "attach_agent_node",
					label: "adjudicator",
					phaseIndex: 2,
					agentType: "lme-frame-adjudicator",
				},
			],
		);
	});

	it("unwraps Garden MCP structuredContent and JSON text results", async () => {
		const responses = [
			new Response(JSON.stringify({ result: { structuredContent: { ok: "structured" } } })),
			new Response(JSON.stringify({ result: { content: [{ type: "text", text: '{"ok":"text"}' }] } })),
		];
		const requests: unknown[] = [];
		const caller = gardenMcpCallerFromHttp({
			mcpUrl: "http://127.0.0.1:1234/mcp",
			token: "token-1",
			fetchFn: (async (_url, init) => {
				requests.push(init);
				const response = responses.shift();
				if (!response) throw new Error("no response queued");
				return response;
			}) as typeof fetch,
		});

		assert.deepEqual(await caller.callTool("first_tool", { a: 1 }), { ok: "structured" });
		assert.deepEqual(await caller.callTool("second_tool", { b: 2 }), { ok: "text" });
		assert.equal(requests.length, 2);
		assert.match(JSON.stringify(requests[0]), /Bearer token-1/);
	});

	it("queries and renders PageTurnDecision objects from Garden user RDF", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const caller: GardenMcpCaller = {
			async callTool(name, callArgs) {
				calls.push({ name, args: callArgs });
				if (name !== "sparql_query") throw new Error(`unexpected tool call ${name}`);
				return {
					rows: [
						{
							decision:
								"<urn:sophia:workflow-page-turn-decision:lme-labeled-memory-50-v0:lme-label-shard:overview:perception-map:analysis-scout:shard-01>",
							generatedAt: '"2026-06-25T03:49:50.428Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
							graphId: '"lme-labeled-memory-50-v0"',
							workflowName: '"lme-label-shard"',
							fromPage: '"overview"',
							intent: '"analysis-scout"',
							readiness: '"inspect_before_execute"',
							nativeSuggestedChoice: '"execute-async"',
							recommendedRoute: '"analysis-scout"',
							recommendedRouteLabel: '"Analysis scout"',
							recommendedChoice: '"perception-map"',
							followedRoute: '"analysis-scout"',
							followedRouteLabel: '"Analysis scout"',
							followedChoice: '"perception-map"',
							followedChoiceLabel: '"Perception map"',
							executionAuthorized: '"false"^^<http://www.w3.org/2001/XMLSchema#boolean>',
							authorizationFlagCount: '"5"^^<http://www.w3.org/2001/XMLSchema#integer>',
							rationale: '"Prefer perceptual orientation before execute."',
						},
					],
				};
			},
		};

		const result = await gardenPageTurnDecisions(caller, { graphId: "lme-labeled-memory-50-v0", limit: 5 });

		assert.equal(result.kind, "gardenPageTurnDecisionList");
		assert.equal(result.decisions.length, 1);
		assert.equal(result.decisions[0].workflowName, "lme-label-shard");
		assert.equal(result.decisions[0].recommendedRoute, "analysis-scout");
		assert.equal(result.decisions[0].recommendedRouteLabel, "Analysis scout");
		assert.equal(result.decisions[0].followedRoute, "analysis-scout");
		assert.equal(result.decisions[0].followedChoiceLabel, "Perception map");
		assert.equal(result.decisions[0].executionAuthorized, false);
		assert.equal(result.decisions[0].authorizationFlagCount, 5);
		assert.match(result.query, /GRAPH <urn:mnemosyne:local:graph:lme-labeled-memory-50-v0:user:rdf>/);
		assert.match(result.query, /^PREFIX wf: <http:\/\/mnemosyne\.dev\/workflow#>/);
		assert.match(result.query, /VALUES \?decisionType \{ wf:PageTurnDecision wfui:PageTurnDecision \}/);
		assert.match(result.query, /COALESCE\(\?wfRecommendedRoute, \?wfuiRecommendedRoute\) AS \?recommendedRoute/);
		assert.match(gardenPageTurnDecisionsQuery("lme-labeled-memory-50-v0", 500), /LIMIT 100$/);
		assert.deepEqual(calls, [
			{
				name: "sparql_query",
				args: {
					graphId: "lme-labeled-memory-50-v0",
					query: result.query,
				},
			},
		]);

		const markdown = renderGardenPageTurnDecisionsMarkdown(result);
		assert.match(markdown, /^# PageTurnDecision Objects - lme-labeled-memory-50-v0/m);
		assert.match(markdown, /Native suggested choice: execute-async/);
		assert.match(markdown, /Recommended route: analysis-scout - Analysis scout/);
		assert.match(markdown, /Recommended choice: perception-map/);
		assert.match(markdown, /Followed route: analysis-scout - Analysis scout/);
		assert.match(markdown, /Followed choice: perception-map - Perception map/);
		assert.match(markdown, /Execution authorized: false/);
		assert.match(markdown, /```sparql\nPREFIX wf:/);
		assert.match(markdown, /PREFIX wfui:/);
	});

	it("queries and renders one PageTurnDecision with evidence and authorization flags", async () => {
		const subject =
			"urn:sophia:workflow-page-turn-decision:lme-labeled-memory-50-v0:lme-label-shard:overview:perception-map:analysis-scout:shard-01";
		const evidence = `${subject}:evidence:handoff`;
		const route = `${subject}:route:analysis-scout`;
		const flag = `${subject}:authorization:1`;
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const caller: GardenMcpCaller = {
			async callTool(name, callArgs) {
				calls.push({ name, args: callArgs });
				if (name !== "sparql_query") throw new Error(`unexpected tool call ${name}`);
				return {
					rows: [
						{
							decision: `<${subject}>`,
							generatedAt: '"2026-06-25T03:49:50.428Z"^^<http://www.w3.org/2001/XMLSchema#dateTime>',
							graphId: '"lme-labeled-memory-50-v0"',
							workflowName: '"lme-label-shard"',
							fromPage: '"overview"',
							intent: '"analysis-scout"',
							readiness: '"inspect_before_execute"',
							nativeSuggestedChoice: '"execute-async"',
							recommendedRoute: '"analysis-scout"',
							recommendedRouteLabel: '"Analysis scout"',
							recommendedChoice: '"perception-map"',
							followedRoute: '"analysis-scout"',
							followedRouteLabel: '"Analysis scout"',
							followedChoice: '"perception-map"',
							followedChoiceLabel: '"Perception map"',
							executionAuthorized: '"false"^^<http://www.w3.org/2001/XMLSchema#boolean>',
							authorizationFlagCount: '"1"^^<http://www.w3.org/2001/XMLSchema#integer>',
							rationale: '"Prefer perceptual orientation before execute."',
							evidence: `<${evidence}>`,
							evidenceRole: '"handoff"',
							evidencePath: '"scripts/lme-labeling/batches/50case-v0/workflow-args/shard-01.handoff.md"',
							navigationRoute: `<${route}>`,
							routeId: '"analysis-scout"',
							routeLabel: '"Analysis scout"',
							routeKind: '"intent"',
							routeIntent: '"analysis-scout"',
							routeChoiceId: '"perception-map"',
							routeChoiceLabel: '"Perception map"',
							routeSource: '"garden-navigation-routes"',
							routeRationale: '"Start with perception before run prep."',
							routeActionJson: '"{\\"tool\\":\\"workflow_book_choose\\"}"',
							routeAction: `<${route}:action>`,
							routeActionTool: '"workflow_book_choose"',
							routeActionKind: '"workflow_book_choose"',
							routeCommandTemplate: '"turn: route analysis-scout"',
							routeArgumentHash: '"hash-analysis-scout"',
							flag: `<${flag}>`,
							flagPageId: '"execute"',
							flagChoiceId: '"start-run-mcp"',
							flagReason: '"choice calls workflow_run_start and may start Choreograph sidecar work"',
						},
						{
							decision: `<${subject}>`,
							evidence: `<${evidence}>`,
							evidenceRole: '"handoff"',
							evidencePath: '"scripts/lme-labeling/batches/50case-v0/workflow-args/shard-01.handoff.md"',
							navigationRoute: `<${route}>`,
							routeId: '"analysis-scout"',
							routeLabel: '"Analysis scout"',
							routeChoiceId: '"perception-map"',
							flag: `<${flag}>`,
							flagPageId: '"execute"',
							flagChoiceId: '"start-run-mcp"',
							flagReason: '"choice calls workflow_run_start and may start Choreograph sidecar work"',
						},
					],
				};
			},
		};

		const result = await gardenPageTurnDecisionDetail(caller, {
			graphId: "lme-labeled-memory-50-v0",
			subject: `<${subject}>`,
		});

		assert.equal(result.kind, "gardenPageTurnDecisionDetail");
		assert.equal(result.subject, subject);
		assert.equal(result.decision?.recommendedRoute, "analysis-scout");
		assert.equal(result.decision?.recommendedChoice, "perception-map");
		assert.equal(result.decision?.followedRoute, "analysis-scout");
		assert.equal(result.decision?.followedChoice, "perception-map");
		assert.equal(result.evidence.length, 1);
		assert.equal(result.evidence[0].role, "handoff");
		assert.equal(result.navigationRoutes.length, 1);
		assert.equal(result.navigationRoutes[0].routeId, "analysis-scout");
		assert.equal(result.navigationRoutes[0].choiceId, "perception-map");
		assert.equal(result.navigationRoutes[0].routeAction, `${route}:action`);
		assert.equal(result.navigationRoutes[0].actionTool, "workflow_book_choose");
		assert.equal(result.navigationRoutes[0].actionKind, "workflow_book_choose");
		assert.equal(result.navigationRoutes[0].commandTemplate, "turn: route analysis-scout");
		assert.equal(result.navigationRoutes[0].argumentHash, "hash-analysis-scout");
		assert.equal(result.authorizationFlags.length, 1);
		assert.equal(result.authorizationFlags[0].choiceId, "start-run-mcp");
		assert.match(result.query, new RegExp(`BIND\\(<${subject}> AS \\?decision\\)`));
		assert.match(result.query, /VALUES \?decisionType \{ wf:PageTurnDecision wfui:PageTurnDecision \}/);
		assert.match(result.query, /\?navigationRoute wf:routeAction \?routeAction/);
		assert.match(result.query, /COALESCE\(\?wfFlagReason, \?wfuiFlagReason\) AS \?flagReason/);
		assert.equal(calls[0].name, "sparql_query");
		assert.equal(calls[0].args.query, result.query);
		assert.match(gardenPageTurnDecisionDetailQuery("lme-labeled-memory-50-v0", `<${subject}>`), /ORDER BY/);

		const markdown = renderGardenPageTurnDecisionDetailMarkdown(result);
		assert.match(markdown, /^# PageTurnDecision - lme-label-shard \/ overview/m);
		assert.match(markdown, /Recommended route: analysis-scout - Analysis scout/);
		assert.match(markdown, /Followed route: analysis-scout - Analysis scout/);
		assert.match(markdown, /Followed choice: perception-map - Perception map/);
		assert.match(markdown, /## Evidence\n- handoff: scripts\/lme-labeling/);
		assert.match(
			markdown,
			/## Navigation Routes\n- analysis-scout - Analysis scout \[intent\] -> perception-map \(Perception map\)/,
		);
		assert.match(markdown, /## Authorization Flags\n- execute \/ start-run-mcp - choice calls workflow_run_start/);
		assert.match(markdown, /```sparql\nPREFIX wf:/);
		assert.match(markdown, /PREFIX wfui:/);
	});

	it("rejects mismatched workflow names before mutating Garden", async () => {
		await assert.rejects(
			() =>
				composeGardenWorkflowDraft(
					{ callTool: async () => ({}) },
					{
						graphId: "garden-graph",
						meta: META,
						source: SOURCE,
						workflowName: "other-name",
					},
				),
			/workflowName 'other-name' does not match meta.name 'garden-bridge-demo'/,
		);
	});

	it("maps Garden workflow-session requests to the authoring-session MCP contract", async () => {
		const args = gardenWorkflowSessionArguments({
			graphId: "garden-graph",
			workflowName: "garden-bridge-demo",
			operation: "background",
			mode: "validate",
			pageId: "overview",
			pollMs: 250,
			timeoutMs: 10_000,
			maxTicks: 40,
			resolveOnChange: true,
		});
		assert.deepEqual(args, {
			graphId: "garden-graph",
			operation: "background",
			workflowName: "garden-bridge-demo",
			pageId: "overview",
			mode: "validate",
			pollMs: 250,
			timeoutMs: 10_000,
			maxTicks: 40,
			resolveOnChange: true,
		});

		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const response = await callGardenWorkflowAuthoringSession(
			{
				async callTool(name, callArgs) {
					calls.push({ name, args: callArgs });
					return { ok: true };
				},
			},
			{
				graphId: "garden-graph",
				workflowName: "garden-bridge-demo",
				operation: "choose",
				pageId: "overview",
				choiceId: "perception-map",
			},
		);
		assert.deepEqual(response, { ok: true });
		assert.deepEqual(calls, [
			{
				name: "workflow_authoring_session",
				args: {
					graphId: "garden-graph",
					operation: "choose",
					workflowName: "garden-bridge-demo",
					pageId: "overview",
					choiceId: "perception-map",
				},
			},
		]);
	});

	it("walks suggested workflow-book page turns and records transcript entries", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const caller: GardenMcpCaller = {
			async callTool(name, callArgs) {
				calls.push({ name, args: callArgs });
				if (name !== "workflow_authoring_session") {
					throw new Error(`unexpected tool call ${name}`);
				}
				if (callArgs.operation === "status") {
					return {
						operation: "status",
						graphId: "garden-graph",
						payload: {
							book: {
								page: {
									id: "catalog",
									kind: "catalog",
									title: "Workflow Books",
									suggestedChoiceId: "open-garden-bridge-demo",
									choices: [
										{
											id: "open-garden-bridge-demo",
											label: "Open garden-bridge-demo",
											kind: "open-workflow",
											targetPageId: "overview",
										},
									],
								},
							},
						},
					};
				}
				if (callArgs.operation === "choose") {
					return {
						operation: "choose",
						graphId: "garden-graph",
						workflowName: "garden-bridge-demo",
						authoring: { status: "ready", message: "Opened workflow." },
						payload: {
							book: {
								page: {
									id: "overview",
									title: "Overview",
									suggestedChoiceId: "raw",
									choices: [
										{
											id: "raw",
											label: "Raw SPARQL",
											kind: "navigate",
											targetPageId: "raw",
										},
									],
								},
							},
						},
					};
				}
				throw new Error(`unexpected authoring operation ${String(callArgs.operation)}`);
			},
		};

		const observed: unknown[] = [];
		const walk = await gardenWorkflowWalkSuggested(caller, {
			graphId: "garden-graph",
			maxSteps: 1,
			note: "handoff seed",
			followOptions: { output: "packet" },
			onTranscriptEntry(entry) {
				observed.push(entry);
			},
		});

		assert.equal(walk.kind, "gardenWorkflowWalkResult");
		assert.equal(walk.startedFrom, "session");
		assert.equal(walk.maxSteps, 1);
		assert.equal(walk.steps.length, 1);
		assert.equal(walk.stopReason, "max_steps");
		assert.equal(walk.transcriptEntries.length, 2);
		assert.equal(observed.length, 2);
		assert.equal(walk.transcriptEntries[0].decision, "observed");
		assert.equal(walk.transcriptEntries[0].summary.pageId, "catalog");
		assert.equal(walk.transcriptEntries[1].decision, "accepted");
		assert.equal(walk.transcriptEntries[1].summary.resultPageId, "overview");
		assert.match(
			walk.steps[0].command,
			/choose --graph garden-graph --page catalog --choice open-garden-bridge-demo --packet/,
		);
		assert.deepEqual(calls, [
			{
				name: "workflow_authoring_session",
				args: { graphId: "garden-graph", operation: "status" },
			},
			{
				name: "workflow_authoring_session",
				args: {
					graphId: "garden-graph",
					operation: "choose",
					pageId: "catalog",
					choiceId: "open-garden-bridge-demo",
				},
			},
		]);
	});

	it("renders a Garden workflow session as an agent-readable choice page", () => {
		const session = {
			operation: "status",
			graphId: "garden-graph",
			workflowName: "garden-bridge-demo",
			authoring: {
				status: "ready_to_execute",
				message: "Workflow is ready.",
			},
			payload: {
				validation: { passed: true, summary: "1 workflow, 2 phases." },
				latestRun: { runId: "wfr-1", status: "completed" },
				book: {
					page: {
						id: "overview",
						title: "Overview",
						scene: "You are looking at the workflow overview.",
						suggestedChoiceId: "execute",
						warnings: ["review prompt size"],
						objects: [
							{ kind: "workflow", name: "garden-bridge-demo", workflowUri: "urn:wf:garden-bridge-demo" },
							{ kind: "workflowRun", runId: "wfr-1", status: "completed" },
						],
						choices: [
							{
								id: "execute",
								label: "Execute",
								kind: "execute",
								targetPageId: "execute",
								description: "Prepare and run the workflow.",
							},
							{
								id: "raw",
								label: "Raw SPARQL",
								kind: "navigate",
								targetPageId: "raw",
							},
						],
					},
				},
				watch: {
					nextAction: {
						tool: "workflow_authoring_session",
						arguments: { graphId: "garden-graph", operation: "watch" },
					},
				},
			},
		};
		const markdown = renderGardenWorkflowSessionMarkdown(session);

		assert.match(markdown, /^# garden-bridge-demo \/ Overview/m);
		assert.match(markdown, /Status: ready_to_execute/);
		assert.match(markdown, /Validation: passed - 1 workflow, 2 phases\./);
		assert.match(markdown, /Latest run: wfr-1 completed/);
		assert.match(markdown, /## Scene\nYou are looking at the workflow overview\./);
		assert.match(markdown, /- review prompt size/);
		assert.match(markdown, /\* execute: Execute \(execute -> execute\) - Prepare and run the workflow\./);
		assert.match(markdown, /workflow_authoring_session \{"graphId":"garden-graph","operation":"watch"\}/);

		const packet = gardenWorkflowSessionChoicePacket(session);
		assert.equal(packet.kind, "gardenWorkflowChoicePacket");
		assert.equal(packet.graphId, "garden-graph");
		assert.equal(packet.workflowName, "garden-bridge-demo");
		assert.deepEqual(packet.page, {
			id: "overview",
			title: "Overview",
			scene: "You are looking at the workflow overview.",
		});
		assert.deepEqual(packet.validation, { passed: true, summary: "1 workflow, 2 phases." });
		assert.deepEqual(packet.latestRun, { runId: "wfr-1", status: "completed" });
		assert.deepEqual(packet.suggestedChoice, {
			id: "execute",
			label: "Execute",
			kind: "execute",
			targetPageId: "execute",
			description: "Prepare and run the workflow.",
			suggested: true,
			requiresExplicitAuthorization: true,
			authorizationReason: "choice can start or submit workflow execution",
		});
		assert.equal(packet.choices.find((choice) => choice.id === "raw")?.requiresExplicitAuthorization, undefined);
		assert.deepEqual(packet.nextActions, [
			{
				tool: "workflow_authoring_session",
				arguments: { graphId: "garden-graph", operation: "watch" },
				text: 'workflow_authoring_session {"graphId":"garden-graph","operation":"watch"}',
			},
		]);
		assert.equal(
			gardenWorkflowFollowSuggestedCommand(packet),
			"pnpm exec tsx scripts/workflow-garden-session.ts choose --graph garden-graph --workflow garden-bridge-demo --page overview --choice execute",
		);
		assert.deepEqual(gardenWorkflowSuggestedSessionRequest(packet), {
			graphId: "garden-graph",
			operation: "choose",
			workflowName: "garden-bridge-demo",
			pageId: "overview",
			choiceId: "execute",
		});

		const transcriptEntry = gardenWorkflowTranscriptEntry(packet, {
			recordedAt: "2026-06-25T00:00:00.000Z",
			followOptions: { output: "packet" },
			note: "preview next page",
		});
		assert.equal(transcriptEntry.kind, "gardenWorkflowTranscriptEntry");
		assert.equal(transcriptEntry.schemaVersion, 1);
		assert.equal(transcriptEntry.recordedAt, "2026-06-25T00:00:00.000Z");
		assert.equal(transcriptEntry.decision, "previewed");
		assert.equal(
			transcriptEntry.command,
			"pnpm exec tsx scripts/workflow-garden-session.ts choose --graph garden-graph --workflow garden-bridge-demo --page overview --choice execute --packet",
		);
		assert.equal(transcriptEntry.note, "preview next page");
		assert.deepEqual(transcriptEntry.summary, {
			graphId: "garden-graph",
			workflowName: "garden-bridge-demo",
			pageId: "overview",
			pageTitle: "Overview",
			status: "ready_to_execute",
			suggestedChoiceId: "execute",
			suggestedChoiceLabel: "Execute",
		});

		const observedEntry = gardenWorkflowTranscriptEntry(packet, {
			decision: "observed",
			recordedAt: "2026-06-25T00:01:00.000Z",
			resultPacket: {
				kind: "gardenWorkflowChoicePacket",
				page: { id: "execute", title: "Execute" },
				status: "ready",
				facts: [],
				warnings: [],
				objects: [],
				sections: [],
				choices: [],
				nextActions: [],
			},
		});
		assert.equal(observedEntry.command, undefined);
		assert.equal(observedEntry.summary.resultPageId, "execute");
		assert.equal(observedEntry.summary.resultStatus, "ready");

		const acceptedEntry = gardenWorkflowTranscriptEntry(packet, {
			command:
				"pnpm exec tsx scripts/workflow-garden-session.ts choose --graph garden-graph --workflow garden-bridge-demo --page overview --choice execute --packet",
			decision: "accepted",
			recordedAt: "2026-06-25T00:02:00.000Z",
			resultPacket: packet,
		});
		const parsedEntries = parseGardenWorkflowTranscriptJsonl(
			[transcriptEntry, acceptedEntry].map((entry) => JSON.stringify(entry)).join("\n"),
		);
		const handoff = gardenWorkflowTranscriptHandoff(parsedEntries, {
			generatedAt: "2026-06-25T00:03:00.000Z",
			transcriptPath: "transcript.jsonl",
		});
		assert.equal(handoff.kind, "gardenWorkflowTranscriptHandoff");
		assert.equal(handoff.entryCount, 2);
		assert.deepEqual(handoff.decisionCounts, { previewed: 1, accepted: 1 });
		assert.equal(handoff.current?.workflowName, "garden-bridge-demo");
		assert.equal(handoff.current?.pageId, "overview");
		assert.equal(handoff.current?.suggestedChoiceId, "execute");
		assert.match(handoff.nextCommand ?? "", /choose --graph garden-graph --workflow garden-bridge-demo/);
		const handoffMarkdown = renderGardenWorkflowTranscriptHandoffMarkdown(handoff);
		assert.match(handoffMarkdown, /^# Workflow Handoff - garden-bridge-demo \/ Overview/m);
		assert.match(handoffMarkdown, /## Path\n- 1\. previewed overview suggested=execute - preview next page/);
		assert.match(handoffMarkdown, /## Suggested Next\n`pnpm exec tsx scripts\/workflow-garden-session\.ts choose/);
		assert.match(handoffMarkdown, /Command context: this command requires a live Garden MCP connection/);
	});

	it("can recommend perception first for analysis-scout handoffs without changing Garden's suggestion", () => {
		const packet = {
			kind: "gardenWorkflowChoicePacket",
			graphId: "garden-graph",
			workflowName: "lme-label-shard",
			page: { id: "overview", title: "Overview" },
			status: "ready",
			facts: [],
			warnings: [],
			objects: [],
			sections: [],
			choices: [
				{
					id: "perception-map",
					label: "Perception map",
					kind: "navigate",
					targetPageId: "perception",
					description: "Choose the next graph percept or conceptual route.",
					suggested: false,
				},
				{
					id: "execute-async",
					label: "Prepare async run",
					kind: "navigate",
					targetPageId: "execute",
					description: "Open explicit Choreograph run actions.",
					suggested: true,
				},
			],
			suggestedChoice: {
				id: "execute-async",
				label: "Prepare async run",
				kind: "navigate",
				targetPageId: "execute",
				description: "Open explicit Choreograph run actions.",
				suggested: true,
			},
			nextActions: [],
		};
		const entry = gardenWorkflowTranscriptEntry(packet, {
			decision: "observed",
			recordedAt: "2026-06-25T01:00:00.000Z",
		});
		const handoff = gardenWorkflowTranscriptHandoff([entry], {
			generatedAt: "2026-06-25T01:01:00.000Z",
			intent: "analysis-scout",
		});

		assert.equal(handoff.current?.suggestedChoiceId, "execute-async");
		assert.equal(handoff.suggestedNext?.choiceId, "perception-map");
		assert.equal(handoff.suggestedNext?.source, "handoff-preferred");
		assert.match(handoff.suggestedNext?.rationale ?? "", /prefer perceptual\/conceptual orientation/);
		assert.equal(
			handoff.nextCommand,
			"pnpm exec tsx scripts/workflow-garden-session.ts choose --graph garden-graph --workflow lme-label-shard --page overview --choice perception-map --handoff-intent analysis-scout --packet",
		);
		assert.equal(
			gardenWorkflowChoiceCommand(packet, "perception-map", { handoffIntent: "analysis-scout", output: "packet" }),
			handoff.nextCommand,
		);
		const markdown = renderGardenWorkflowTranscriptHandoffMarkdown(handoff);
		assert.match(markdown, /Suggested: execute-async - Prepare async run/);
		assert.match(markdown, /## Recommended Next Rationale\nChoice: perception-map - Perception map/);
		assert.match(
			markdown,
			/## Recommended Next\n`pnpm exec tsx scripts\/workflow-garden-session\.ts choose .*--choice perception-map --handoff-intent analysis-scout --packet`/,
		);
		assert.match(markdown, /use the retained page-audit artifact for offline inspection/);
	});

	it("preserves Garden-native intent recommendations and uses them for matching handoffs", () => {
		const session = {
			graphId: "garden-graph",
			workflowName: "lme-label-shard",
			payload: {
				book: {
					page: {
						id: "overview",
						title: "Overview",
						suggestedChoiceId: "execute-async",
						choices: [
							{
								id: "perception-map",
								label: "Perception map",
								kind: "navigate",
								targetPageId: "perception",
							},
							{
								id: "execute-async",
								label: "Prepare async run",
								kind: "navigate",
								targetPageId: "execute",
							},
						],
						intentRecommendation: {
							intent: "analysis-scout",
							choiceId: "perception-map",
							choiceLabel: "Perception map",
							source: "garden-intent-rule",
							rationale: "Garden-native analysis-scout route starts with perception.",
						},
						navigationRoutes: [
							{
								id: "analysis-scout",
								label: "Analysis scout",
								kind: "intent",
								intent: "analysis-scout",
								choiceId: "perception-map",
								choiceLabel: "Perception map",
								source: "garden-route-rule",
								rationale: "Start with perceptual/conceptual orientation.",
								action: {
									tool: "workflow_book_choose",
									arguments: {
										graphId: "garden-graph",
										workflowName: "lme-label-shard",
										pageId: "overview",
										choiceId: "perception-map",
										handoffIntent: "analysis-scout",
									},
								},
							},
							{
								id: "run-prep",
								label: "Run preparation",
								kind: "intent",
								intent: "run-prep",
								choiceId: "execute-async",
								choiceLabel: "Prepare async run",
								source: "garden-route-rule",
								rationale: "Move toward explicit run preparation.",
								action: {
									tool: "workflow_book_choose",
									arguments: {
										graphId: "garden-graph",
										workflowName: "lme-label-shard",
										pageId: "overview",
										choiceId: "execute-async",
										handoffIntent: "run-prep",
									},
								},
							},
						],
					},
				},
			},
		};
		const packet = gardenWorkflowSessionChoicePacket(session);
		assert.deepEqual(packet.intentRecommendation, {
			intent: "analysis-scout",
			choiceId: "perception-map",
			choiceLabel: "Perception map",
			source: "garden-intent-rule",
			rationale: "Garden-native analysis-scout route starts with perception.",
		});
		assert.equal(packet.suggestedChoice?.id, "execute-async");
		assert.deepEqual(
			packet.navigationRoutes?.map((route) => [route.id, route.choiceId]),
			[
				["analysis-scout", "perception-map"],
				["run-prep", "execute-async"],
			],
		);
		assert.equal(packet.navigationRoutes?.[0]?.action?.tool, "workflow_book_choose");
		assert.equal(packet.navigationRoutes?.[1]?.requiresExplicitAuthorization, true);
		assert.match(packet.navigationRoutes?.[1]?.authorizationReason ?? "", /run-preparation/);
		assert.deepEqual(packet.navigationRoutes?.[0]?.action?.arguments, {
			graphId: "garden-graph",
			workflowName: "lme-label-shard",
			pageId: "overview",
			choiceId: "perception-map",
			handoffIntent: "analysis-scout",
		});
		assert.match(
			packet.navigationRoutes?.[0]?.action?.text ?? "",
			/workflow_book_choose .*"choiceId":"perception-map"/,
		);
		assert.equal(packet.recommendedNextAction?.kind, "accept-route");
		assert.equal(packet.recommendedNextAction?.source, "intent-recommendation");
		assert.equal(packet.recommendedNextAction?.routeId, "analysis-scout");
		assert.equal(packet.recommendedNextAction?.choiceId, "perception-map");
		assert.equal(
			packet.recommendedNextAction?.rationale,
			"Garden-native analysis-scout route starts with perception.",
		);
		assert.equal(
			packet.recommendedNextAction?.commandTemplate,
			'pnpm exec tsx scripts/workflow-garden-session.ts accept-route --packet-file <packet-file> --route analysis-scout --mcp-url "$GARDEN_MCP_URL" --token "$GARDEN_LOOPBACK_TOKEN" --packet',
		);
		assert.equal(gardenWorkflowRecommendedRouteId(packet), "analysis-scout");
		assert.equal(
			gardenWorkflowFollowSuggestedCommand(packet, { output: "packet" }),
			"pnpm exec tsx scripts/workflow-garden-session.ts route --graph garden-graph --workflow lme-label-shard --page overview --route analysis-scout --handoff-intent analysis-scout --packet",
		);
		assert.equal(
			gardenWorkflowFollowSuggestedCommand(packet, {
				packetFile: "native-route-launch.packet.json",
				output: "packet",
			}),
			"pnpm exec tsx scripts/workflow-garden-session.ts accept-route --packet-file native-route-launch.packet.json --route analysis-scout --packet",
		);
		assert.equal(
			gardenWorkflowRouteCommand(packet, "analysis-scout", { output: "packet" }),
			"pnpm exec tsx scripts/workflow-garden-session.ts route --graph garden-graph --workflow lme-label-shard --page overview --route analysis-scout --handoff-intent analysis-scout --packet",
		);
		assert.deepEqual(gardenWorkflowRouteSessionRequest(packet, "analysis-scout"), {
			graphId: "garden-graph",
			operation: "choose",
			workflowName: "lme-label-shard",
			pageId: "overview",
			choiceId: "perception-map",
			handoffIntent: "analysis-scout",
		});
		const detailRoutePacket = gardenWorkflowSessionChoicePacket({
			kind: "workflowAuthoringSession",
			graphId: "garden-graph",
			workflowName: "lme-label-shard",
			payload: {
				book: {
					book: {
						workflowName: "lme-label-shard",
					},
					page: {
						id: "decision-urn-demo",
						kind: "decisionDetail",
						suggestedChoiceId: "route-analysis-scout",
						choices: [
							{
								id: "route-analysis-scout",
								label: "Route: Analysis scout",
								kind: "retained-route",
							},
						],
						navigationRoutes: [
							{
								id: "analysis-scout",
								label: "Analysis scout",
								kind: "retained-route",
								intent: "analysis-scout",
								choiceId: "route-analysis-scout",
								choiceLabel: "Route: Analysis scout",
								source: "garden-retained-decision-route",
								rationale: "Replay the retained analysis route.",
								action: {
									tool: "workflow_book_choose",
									arguments: {
										graphId: "garden-graph",
										workflowName: "lme-label-shard",
										pageId: "overview",
										choiceId: "perception-map",
										routeId: "analysis-scout",
										handoffIntent: "analysis-scout",
									},
								},
							},
						],
					},
				},
			},
		});
		assert.equal(detailRoutePacket.navigationRoutes?.[0]?.choiceId, "route-analysis-scout");
		assert.equal(detailRoutePacket.recommendedNextAction?.source, "suggested-route");
		assert.equal(detailRoutePacket.recommendedNextAction?.routeId, "analysis-scout");
		assert.equal(detailRoutePacket.recommendedNextAction?.choiceId, "route-analysis-scout");
		assert.equal(
			detailRoutePacket.recommendedNextAction?.commandTemplate,
			'pnpm exec tsx scripts/workflow-garden-session.ts accept-route --packet-file <packet-file> --route analysis-scout --mcp-url "$GARDEN_MCP_URL" --token "$GARDEN_LOOPBACK_TOKEN" --packet',
		);
		assert.equal(
			gardenWorkflowFollowSuggestedCommand(detailRoutePacket, {
				packetFile: "decision-launch.packet.json",
				output: "packet",
			}),
			"pnpm exec tsx scripts/workflow-garden-session.ts accept-route --packet-file decision-launch.packet.json --route analysis-scout --packet",
		);
		assert.deepEqual(gardenWorkflowRouteSessionRequest(detailRoutePacket, "analysis-scout"), {
			graphId: "garden-graph",
			operation: "choose",
			workflowName: "lme-label-shard",
			pageId: "overview",
			choiceId: "perception-map",
			handoffIntent: "analysis-scout",
		});
		assert.equal(
			gardenWorkflowRouteCommand(detailRoutePacket, "analysis-scout", { output: "packet" }),
			"pnpm exec tsx scripts/workflow-garden-session.ts route --graph garden-graph --workflow lme-label-shard --page overview --route analysis-scout --handoff-intent analysis-scout --packet",
		);
		const routeResultPacket = gardenWorkflowSessionChoicePacket({
			kind: "workflowAuthoringSession",
			graphId: "garden-graph",
			workflowName: "lme-label-shard",
			payload: {
				book: {
					book: {
						workflowName: "lme-label-shard",
					},
					page: {
						id: "perception",
						title: "Perception map",
						kind: "perception",
						choices: [],
					},
				},
			},
		});
		const routeTranscriptEntry = gardenWorkflowTranscriptEntry(detailRoutePacket, {
			decision: "accepted",
			resultPacket: routeResultPacket,
			routeId: "analysis-scout",
		});
		assert.equal(routeTranscriptEntry.summary.followedRouteId, "analysis-scout");
		assert.equal(routeTranscriptEntry.summary.followedRouteLabel, "Analysis scout");
		assert.equal(routeTranscriptEntry.summary.followedRouteChoiceId, "route-analysis-scout");
		assert.equal(routeTranscriptEntry.summary.followedRouteChoiceLabel, "Route: Analysis scout");
		assert.match(routeTranscriptEntry.command ?? "", /route --graph garden-graph .* --route analysis-scout/);
		const routeHandoffMarkdown = renderGardenWorkflowTranscriptHandoffMarkdown(
			gardenWorkflowTranscriptHandoff([routeTranscriptEntry]),
		);
		assert.match(routeHandoffMarkdown, /followedRoute=analysis-scout choice=route-analysis-scout/);
		const sessionMarkdown = renderGardenWorkflowSessionMarkdown(session);
		assert.match(sessionMarkdown, /## Routes/);
		assert.match(sessionMarkdown, /analysis-scout: Analysis scout \[intent=analysis-scout\] -> perception-map/);
		assert.match(sessionMarkdown, /run-prep: Run preparation .*authorization: required/);
		assert.match(sessionMarkdown, /## Recommended Next Action/);
		assert.match(
			sessionMarkdown,
			/Command: `pnpm exec tsx scripts\/workflow-garden-session\.ts accept-route --packet-file <packet-file> --route analysis-scout --mcp-url "\$GARDEN_MCP_URL" --token "\$GARDEN_LOOPBACK_TOKEN" --packet`/,
		);
		assert.match(sessionMarkdown, /turn: route analysis-scout/);

		const transcriptEntry = gardenWorkflowTranscriptEntry(packet, {
			decision: "observed",
			recordedAt: "2026-06-25T01:10:00.000Z",
		});
		assert.equal(transcriptEntry.summary.recommendedRouteId, "analysis-scout");
		assert.equal(transcriptEntry.summary.recommendedRouteLabel, "Analysis scout");
		const handoff = gardenWorkflowTranscriptHandoff([transcriptEntry], {
			generatedAt: "2026-06-25T01:11:00.000Z",
			intent: "analysis-scout",
		});

		assert.equal(handoff.current?.suggestedChoiceId, "execute-async");
		assert.equal(handoff.suggestedNext?.routeId, "analysis-scout");
		assert.equal(handoff.suggestedNext?.choiceId, "perception-map");
		assert.equal(handoff.suggestedNext?.source, "garden-intent-recommendation");
		assert.equal(handoff.suggestedNext?.rationale, "Garden-native analysis-scout route starts with perception.");
		assert.deepEqual(
			handoff.currentRoutes.map((route) => [route.id, route.choiceId]),
			[
				["analysis-scout", "perception-map"],
				["run-prep", "execute-async"],
			],
		);
		assert.equal(handoff.currentRoutes[1]?.action?.tool, "workflow_book_choose");
		assert.equal(
			handoff.nextCommand,
			"pnpm exec tsx scripts/workflow-garden-session.ts route --graph garden-graph --workflow lme-label-shard --page overview --route analysis-scout --handoff-intent analysis-scout --packet",
		);
		const handoffMarkdown = renderGardenWorkflowTranscriptHandoffMarkdown(handoff);
		assert.match(handoffMarkdown, /## Routes/);
		assert.match(handoffMarkdown, /Route: analysis-scout - Analysis scout/);
		assert.match(handoffMarkdown, /run-prep: Run preparation \[intent=run-prep\] -> execute-async/);
		assert.match(handoffMarkdown, /turn: route run-prep/);
	});

	it("preserves PageTurnDecision route provenance in Garden page objects", () => {
		const session = {
			graphId: "garden-graph",
			workflowName: "lme-label-shard",
			payload: {
				book: {
					page: {
						id: "decision-1",
						kind: "decisionDetail",
						title: "lme-label-shard -> analysis-scout",
						objects: [
							{
								kind: "pageTurnDecision",
								subject:
									"urn:sophia:workflow-page-turn-decision:garden-graph:lme-label-shard:overview:analysis-scout",
								pageId: "decision-1",
								graphId: "garden-graph",
								workflowName: "lme-label-shard",
								fromPage: "overview",
								intent: "analysis-scout",
								readiness: "inspect_before_execute",
								nativeSuggestedChoice: "execute-async",
								recommendedRoute: "analysis-scout",
								recommendedRouteLabel: "Analysis scout",
								recommendedChoice: "perception-map",
								executionAuthorized: false,
								evidenceCount: 4,
								authorizationFlagsVisible: 3,
							},
						],
						choices: [],
					},
				},
			},
		};

		const packet = gardenWorkflowSessionChoicePacket(session);
		assert.deepEqual(packet.objects[0], {
			kind: "pageTurnDecision",
			label: "lme-label-shard",
			id: "urn:sophia:workflow-page-turn-decision:garden-graph:lme-label-shard:overview:analysis-scout",
			subject: "urn:sophia:workflow-page-turn-decision:garden-graph:lme-label-shard:overview:analysis-scout",
			pageId: "decision-1",
			graphId: "garden-graph",
			workflowName: "lme-label-shard",
			fromPage: "overview",
			intent: "analysis-scout",
			readiness: "inspect_before_execute",
			nativeSuggestedChoice: "execute-async",
			recommendedRoute: "analysis-scout",
			recommendedRouteLabel: "Analysis scout",
			recommendedChoice: "perception-map",
			executionAuthorized: false,
			evidenceCount: 4,
			authorizationFlagsVisible: 3,
		});
	});

	it("selects a native Garden launch choice from a decision-trail page", () => {
		const subject = "urn:sophia:workflow-page-turn-decision:garden-graph:lme-label-shard:overview:analysis-scout";
		const trail = {
			graphId: "garden-graph",
			workflowName: "lme-label-shard",
			payload: {
				book: {
					page: {
						id: "decision-trail",
						kind: "decisionTrail",
						title: "Decision Trail",
						sections: [
							{
								id: "pageTurnDecisions",
								title: "PageTurnDecisions",
								items: [
									{
										subject,
										choiceId: "open-decision-1",
										launchChoiceId: "launch-decision-1",
										launchPageId:
											"decision-launch-urn-sophia-workflow-page-turn-decision-garden-graph-lme-label-shard-overview-analysis-scout",
									},
								],
							},
						],
						choices: [
							{ id: "launch-decision-1", label: "Launch lme-label-shard", targetPageId: "decision-launch-1" },
							{ id: "open-decision-1", label: "Inspect lme-label-shard", targetPageId: "decision-1" },
						],
					},
				},
			},
		};

		assert.deepEqual(gardenPageTurnDecisionLaunchSelection(trail, `<${subject}>`), {
			subject,
			launchChoiceId: "launch-decision-1",
			launchPageId:
				"decision-launch-urn-sophia-workflow-page-turn-decision-garden-graph-lme-label-shard-overview-analysis-scout",
		});
	});

	it("opens Garden's native PageTurnDecision launch page", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const subject = "urn:sophia:workflow-page-turn-decision:garden-graph:lme-label-shard:overview:analysis-scout";
		const caller: GardenMcpCaller = {
			async callTool(name, callArgs) {
				calls.push({ name, args: callArgs });
				if (name !== "workflow_authoring_session") throw new Error(`unexpected tool call ${name}`);
				if (callArgs.operation === "status") {
					return {
						graphId: "garden-graph",
						workflowName: "lme-label-shard",
						payload: {
							book: {
								page: {
									id: "decision-trail",
									kind: "decisionTrail",
									title: "Decision Trail",
									sections: [
										{
											id: "pageTurnDecisions",
											items: [{ subject, launchChoiceId: "launch-decision-1" }],
										},
									],
									choices: [{ id: "launch-decision-1", label: "Launch", targetPageId: "decision-launch-1" }],
								},
							},
						},
					};
				}
				if (callArgs.operation === "choose") {
					return {
						graphId: "garden-graph",
						workflowName: "lme-label-shard",
						payload: {
							book: {
								page: {
									id: "decision-launch-1",
									kind: "decisionLaunch",
									title: "Launch lme-label-shard",
									choices: [{ id: "route-analysis-scout", label: "Route: Analysis scout" }],
								},
							},
						},
					};
				}
				throw new Error(`unexpected operation ${String(callArgs.operation)}`);
			},
		};

		const launch = await gardenPageTurnDecisionLaunch(caller, {
			graphId: "garden-graph",
			workflowName: "lme-label-shard",
			subject,
			handoffIntent: "analysis-scout",
		});
		const packet = gardenWorkflowSessionChoicePacket(launch);
		assert.equal(packet.page.kind, "decisionLaunch");
		assert.equal(packet.choices[0]?.id, "route-analysis-scout");
		assert.deepEqual(calls, [
			{
				name: "workflow_authoring_session",
				args: {
					graphId: "garden-graph",
					operation: "status",
					workflowName: "lme-label-shard",
					pageId: "decision-trail",
					handoffIntent: "analysis-scout",
				},
			},
			{
				name: "workflow_authoring_session",
				args: {
					graphId: "garden-graph",
					operation: "choose",
					workflowName: "lme-label-shard",
					pageId: "decision-trail",
					choiceId: "launch-decision-1",
					handoffIntent: "analysis-scout",
				},
			},
		]);
	});

	it("selects and opens Garden's native WorkflowAdventurePacket detail page", async () => {
		const subject = "urn:sophia:workflow-adventure:lme-labeled-memory-50-v0:lme-label-shard:overview:analysis-scout";
		const trail = {
			graphId: "garden-graph",
			workflowName: "lme-label-shard",
			payload: {
				book: {
					page: {
						id: "adventure-trail",
						kind: "adventureTrail",
						title: "Adventure Trail",
						objects: [
							{
								kind: "workflowAdventurePacket",
								subject,
								workflowName: "lme-label-shard",
								pageId: "overview",
								intent: "analysis-scout",
								recommendedRoute: "analysis-scout",
								navigationRouteCount: 4,
								rawSparqlQueryCount: 3,
							},
						],
						sections: [
							{
								id: "workflowAdventures",
								title: "WorkflowAdventurePackets",
								items: [
									{
										subject,
										workflowName: "lme-label-shard",
										pageId: "overview",
										intent: "analysis-scout",
										recommendedRoute: "analysis-scout",
										navigationRouteCount: 4,
										rawSparqlQueryCount: 3,
										pageIdForBook: "adventure-urn-sophia-workflow-adventure",
										choiceId: "open-adventure-1",
									},
								],
							},
						],
						choices: [
							{
								id: "open-adventure-1",
								label: "Inspect lme-label-shard / overview / analysis-scout",
								targetPageId: "adventure-urn-sophia-workflow-adventure",
							},
							{
								id: "perceive-workflow-adventures",
								label: "Perceive adventure RDF",
								kind: "raw-sparql",
							},
						],
					},
				},
			},
		};

		assert.deepEqual(gardenWorkflowAdventureDetailSelection(trail, `<${subject}>`), {
			subject,
			detailChoiceId: "open-adventure-1",
			detailPageId: "adventure-urn-sophia-workflow-adventure",
		});

		const packet = gardenWorkflowSessionChoicePacket(trail);
		assert.equal(packet.page.kind, "adventureTrail");
		assert.equal(packet.objects[0]?.kind, "workflowAdventurePacket");
		assert.equal(packet.objects[0]?.navigationRouteCount, 4);
		assert.equal(packet.objects[0]?.rawSparqlQueryCount, 3);
		assert.equal(packet.sections[0]?.items[0]?.subject, subject);
		assert.equal(packet.sections[0]?.items[0]?.rawSparqlQueryCount, 3);

		const topLevelTrail = {
			graphId: "garden-graph",
			workflowName: "lme-label-shard",
			book: {
				workflowName: "lme-label-shard",
			},
			page: trail.payload.book.page,
			authoring: {
				currentPageId: "adventure-trail",
				status: "ready",
				message: "Adventure trail ready.",
			},
		};
		const topLevelPacket = gardenWorkflowSessionChoicePacket(topLevelTrail);
		assert.equal(topLevelPacket.page.kind, "adventureTrail");
		assert.equal(topLevelPacket.objects[0]?.kind, "workflowAdventurePacket");
		assert.equal(topLevelPacket.sections[0]?.items[0]?.choiceId, "open-adventure-1");

		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const caller: GardenMcpCaller = {
			async callTool(name, callArgs) {
				calls.push({ name, args: callArgs });
				if (name !== "workflow_authoring_session") throw new Error(`unexpected tool call ${name}`);
				if (callArgs.operation === "status") return topLevelTrail;
				if (callArgs.operation === "choose") {
					return {
						graphId: "garden-graph",
						workflowName: "lme-label-shard",
						book: {
							workflowName: "lme-label-shard",
						},
						page: {
							id: "adventure-urn-sophia-workflow-adventure",
							kind: "adventureDetail",
							title: "lme-label-shard / overview / analysis-scout",
							objects: [
								{
									kind: "workflowAdventurePacket",
									subject,
									rawSparqlQueryCount: 3,
								},
							],
							sections: [
								{
									id: "routeMap",
									title: "Route Map",
									items: [
										{ routeId: "analysis-scout", choiceId: "perception-map" },
										{ routeId: "raw-sparql", choiceId: "raw-sparql" },
									],
								},
							],
							choices: [
								{
									id: "route-analysis-scout",
									label: "Route: Analysis scout",
									kind: "retained-adventure-route",
								},
							],
						},
					};
				}
				throw new Error(`unexpected operation ${String(callArgs.operation)}`);
			},
		};

		const detail = gardenWorkflowSessionChoicePacket(
			await gardenWorkflowAdventureDetail(caller, {
				graphId: "garden-graph",
				workflowName: "lme-label-shard",
				subject,
			}),
		);

		assert.equal(detail.page.kind, "adventureDetail");
		assert.equal(detail.objects[0]?.rawSparqlQueryCount, 3);
		assert.deepEqual(
			detail.sections.find((section) => section.id === "routeMap")?.items.map((item) => item.routeId),
			["analysis-scout", "raw-sparql"],
		);
		assert.deepEqual(calls, [
			{
				name: "workflow_authoring_session",
				args: {
					graphId: "garden-graph",
					operation: "status",
					workflowName: "lme-label-shard",
					pageId: "adventure-trail",
				},
			},
			{
				name: "workflow_authoring_session",
				args: {
					graphId: "garden-graph",
					operation: "choose",
					workflowName: "lme-label-shard",
					pageId: "adventure-trail",
					choiceId: "open-adventure-1",
				},
			},
		]);
	});

	it("renders a catalog session as a workflow-book index page", () => {
		const session = {
			operation: "status",
			graphId: "garden-graph",
			workflowName: "envelope-hint-should-not-title-catalog",
			authoring: {
				status: "ready",
				message: "Choose a workflow.",
			},
			payload: {
				book: {
					page: {
						id: "catalog",
						kind: "catalog",
						title: "Workflow Books",
						summary: "Choose a workflow, or inspect the raw RDF/SPARQL surface.",
						scene: "You are looking at 2 workflow book(s) in graph 'garden-graph'.",
						facts: [
							{ label: "graphId", value: "garden-graph" },
							{ label: "workflowCount", value: 2 },
						],
						objects: [
							{
								kind: "workflow",
								name: "ontology-scout",
								workflowUri: "urn:wf:ontology-scout",
								phaseCount: 3,
								agentCount: 5,
								runCount: 1,
								latestRunStatus: "completed",
							},
						],
						sections: [
							{
								id: "workflows",
								title: "Workflows",
								items: [
									{
										name: "ontology-scout",
										description: "Scout ontology applicability.",
										workflowUri: "urn:wf:ontology-scout",
										phaseCount: 3,
										agentCount: 5,
										runCount: 1,
										pageChoiceId: "open-ontology-scout",
									},
								],
							},
						],
						suggestedChoiceId: "open-ontology-scout",
						choices: [
							{
								id: "open-ontology-scout",
								label: "Open ontology-scout",
								kind: "open-workflow",
								targetPageId: "overview",
								description: "Enter the navigable workflow book.",
							},
							{
								id: "raw-sparql",
								label: "Raw SPARQL",
								kind: "navigate",
								targetPageId: "raw",
							},
						],
					},
				},
			},
		};
		const markdown = renderGardenWorkflowSessionMarkdown(session);

		assert.match(markdown, /^# Workflow Books/m);
		assert.match(markdown, /Summary: Choose a workflow, or inspect the raw RDF\/SPARQL surface\./);
		assert.match(markdown, /## Facts\n- graphId: garden-graph\n- workflowCount: 2/);
		assert.match(markdown, /workflow ontology-scout \[latest completed\] phases=3 agents=5 runs=1/);
		assert.match(markdown, /## Workflows\n- ontology-scout phases=3 agents=5 runs=1 choice=open-ontology-scout/);
		assert.match(markdown, /\* open-ontology-scout: Open ontology-scout \(open-workflow -> overview\)/);

		const packet = gardenWorkflowSessionChoicePacket(session);
		assert.equal(packet.workflowName, undefined);
		assert.deepEqual(packet.page, {
			id: "catalog",
			title: "Workflow Books",
			kind: "catalog",
			summary: "Choose a workflow, or inspect the raw RDF/SPARQL surface.",
			scene: "You are looking at 2 workflow book(s) in graph 'garden-graph'.",
		});
		assert.deepEqual(packet.facts, [
			{ label: "graphId", value: "garden-graph" },
			{ label: "workflowCount", value: 2 },
		]);
		assert.deepEqual(packet.objects[0], {
			kind: "workflow",
			label: "ontology-scout",
			id: "urn:wf:ontology-scout",
			latestRunStatus: "completed",
			phaseCount: 3,
			agentCount: 5,
			runCount: 1,
		});
		assert.equal(packet.sections[0].title, "Workflows");
		assert.deepEqual(packet.sections[0].items[0], {
			label: "ontology-scout",
			description: "Scout ontology applicability.",
			choiceId: "open-ontology-scout",
			workflowUri: "urn:wf:ontology-scout",
			phaseCount: 3,
			agentCount: 5,
			runCount: 1,
		});
		assert.equal(packet.suggestedChoice?.id, "open-ontology-scout");
		assert.equal(
			gardenWorkflowFollowSuggestedCommand(packet, {
				mcpUrl: "http://127.0.0.1:1234/mcp",
				token: "token-1",
				output: "packet",
			}),
			"pnpm exec tsx scripts/workflow-garden-session.ts choose --graph garden-graph --page catalog --choice open-ontology-scout --mcp-url http://127.0.0.1:1234/mcp --token token-1 --packet",
		);
		assert.deepEqual(gardenWorkflowSuggestedSessionRequest(packet), {
			graphId: "garden-graph",
			operation: "choose",
			pageId: "catalog",
			choiceId: "open-ontology-scout",
		});
	});

	it("maps workflow-authoring next actions when a packet has no suggested choice", () => {
		const packet = {
			kind: "gardenWorkflowChoicePacket",
			page: { id: "execute", title: "Execute" },
			facts: [],
			warnings: [],
			objects: [],
			sections: [],
			choices: [],
			nextActions: [
				{
					tool: "workflow_authoring_session",
					arguments: {
						graphId: "garden-graph",
						workflowName: "garden-bridge-demo",
						operation: "watch",
						pageId: "execute",
						since: 12,
						includeEvents: true,
						pollMs: 500,
					},
					text: 'workflow_authoring_session {"graphId":"garden-graph","workflowName":"garden-bridge-demo","operation":"watch"}',
				},
			],
		};
		assert.equal(
			gardenWorkflowFollowSuggestedCommand(packet),
			"pnpm exec tsx scripts/workflow-garden-session.ts watch --graph garden-graph --workflow garden-bridge-demo --page execute --since 12 --poll-ms 500",
		);
		assert.deepEqual(gardenWorkflowSuggestedSessionRequest(packet), {
			graphId: "garden-graph",
			operation: "watch",
			workflowName: "garden-bridge-demo",
			pageId: "execute",
			runId: undefined,
			since: 12,
			pollMs: 500,
			timeoutMs: undefined,
			maxTicks: undefined,
			includeEvents: true,
			monitorLatest: undefined,
			resolveOnChange: undefined,
			executionChoiceId: undefined,
		});
	});

	it("prints job next-action commands without treating them as page turns", () => {
		const packet = {
			kind: "gardenWorkflowChoicePacket",
			page: { id: "execute", title: "Execute" },
			facts: [],
			warnings: [],
			objects: [],
			sections: [],
			choices: [],
			nextActions: [
				{
					tool: "get_job_status",
					arguments: { jobId: "job-123" },
					text: 'get_job_status {"jobId":"job-123"}',
				},
			],
		};
		const command = gardenWorkflowFollowSuggestedCommand(packet);
		assert.equal(command, "pnpm exec tsx scripts/workflow-garden-session.ts job-status --job job-123");
		assert.throws(
			() => gardenWorkflowSuggestedSessionRequest(packet),
			/suggested action get_job_status cannot be executed as a workflow session page turn/,
		);
	});
});
