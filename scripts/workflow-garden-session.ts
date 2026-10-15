#!/usr/bin/env tsx
/**
 * Agent-facing Garden workflow-book session CLI.
 *
 * Use this after `workflow-compose garden-draft` has created a graph-backed
 * workflow object. It keeps raw JSON available, but defaults to a compact
 * Markdown view of the current Garden workflow-book page and choices.
 */

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import {
	callGardenWorkflowAuthoringSession,
	gardenPageTurnDecisionDetail,
	gardenPageTurnDecisionLaunch,
	gardenPageTurnDecisions,
	gardenWorkflowFollowSuggestedCommand,
	gardenWorkflowRecommendedRouteId,
	gardenWorkflowRouteCommand,
	gardenWorkflowRouteSessionRequest,
	gardenWorkflowSessionChoicePacket,
	gardenWorkflowSuggestedSessionRequest,
	gardenWorkflowTranscriptEntry,
	gardenWorkflowTranscriptHandoff,
	gardenWorkflowWalkSuggested,
	gardenMcpCallerFromHttp,
	parseGardenWorkflowTranscriptJsonl,
	renderGardenPageTurnDecisionDetailMarkdown,
	renderGardenPageTurnDecisionsMarkdown,
	renderGardenWorkflowTranscriptHandoffMarkdown,
	renderGardenWorkflowSessionMarkdown,
	type GardenMcpCaller,
	type GardenWorkflowHandoffIntent,
	type GardenWorkflowTranscriptEntry,
	type GardenWorkflowTranscriptHandoff,
	type GardenWorkflowTranscriptDecision,
	type GardenWorkflowWalkResult,
	type GardenWorkflowSessionRequest,
} from "../src/workflow/garden-authoring.js";
import {
	type PageTurnDecision,
	pageTurnDecisionFromTranscriptEntry,
	pageTurnDecisionLaunchPage,
	pageTurnDecisionRouteCommand,
	pageTurnDecisionRouteMenu,
	renderPageTurnDecisionLaunchMarkdown,
	renderPageTurnDecisionMarkdown,
	renderPageTurnDecisionRouteMenuMarkdown,
	renderPageTurnDecisionTurtle,
} from "./lme-labeling/page-turn-decision.js";

type Command =
	| "list"
	| "catalog"
	| "decisions"
	| "decision"
	| "decision-routes"
	| "decision-launch"
	| "decision-launch-page"
	| "open"
	| "status"
	| "draft"
	| "choose"
	| "validate"
	| "watch"
	| "await"
	| "background-await"
	| "background-validate"
	| "prepare"
	| "execute"
	| "monitor"
	| "job-status"
	| "job-result"
	| "follow-suggested"
	| "follow-route"
	| "follow-decision-route"
	| "accept-suggested"
	| "accept-route"
	| "route"
	| "walk-suggested"
	| "handoff"
	| "transcript-decision"
	| "record-step";

interface Args {
	command: Command;
	graphId?: string;
	workflowName?: string;
	mcpUrl?: string;
	token?: string;
	pageId?: string;
	choiceId?: string;
	routeId?: string;
	runId?: string;
	jobId?: string;
	subject?: string;
	packetFile?: string;
	decisionFile?: string;
	resultPacketFile?: string;
	resultPacketOut?: string;
	transcriptFile?: string;
	handoffOut?: string;
	handoffTitle?: string;
	handoffIntent?: GardenWorkflowHandoffIntent;
	shardId?: string;
	entryIndex?: number;
	pageTurnDecisionOut?: string;
	pageTurnDecisionMarkdownOut?: string;
	pageTurnDecisionTurtleOut?: string;
	commandText?: string;
	decision?: GardenWorkflowTranscriptDecision;
	note?: string;
	nextOutput?: "markdown" | "packet" | "json";
	since?: number;
	pollMs?: number;
	timeoutMs?: number;
	maxTicks?: number;
	maxSteps?: number;
	limit?: number;
	includeEvents?: boolean;
	monitorLatest?: boolean;
	resolveOnChange?: boolean;
	out?: string;
	json: boolean;
	packet: boolean;
}

function usageText(): string {
	return [
		"usage:",
		"  pnpm exec tsx scripts/workflow-garden-session.ts list --graph <graph-id> --mcp-url <url>",
		"  pnpm exec tsx scripts/workflow-garden-session.ts decisions --graph <graph-id> --mcp-url <url>",
		"  pnpm exec tsx scripts/workflow-garden-session.ts decision --graph <graph-id> --subject <iri> --mcp-url <url>",
		"  pnpm exec tsx scripts/workflow-garden-session.ts decision-routes --decision-file <path>",
		"  pnpm exec tsx scripts/workflow-garden-session.ts decision-launch --decision-file <path>",
		"  pnpm exec tsx scripts/workflow-garden-session.ts decision-launch-page --graph <graph-id> [--workflow <name>] [--subject <iri>] --mcp-url <url>",
		"  pnpm exec tsx scripts/workflow-garden-session.ts open --graph <graph-id> [--workflow <name>] --mcp-url <url>",
		"  pnpm exec tsx scripts/workflow-garden-session.ts choose --graph <graph-id> --workflow <name> --choice <id> [--page <id>]",
		"  pnpm exec tsx scripts/workflow-garden-session.ts route --graph <graph-id> --workflow <name> --route <id> [--page <id>]",
		"  pnpm exec tsx scripts/workflow-garden-session.ts validate|watch|await|prepare|execute --graph <graph-id> --workflow <name>",
		"  pnpm exec tsx scripts/workflow-garden-session.ts background-await|background-validate --graph <graph-id> --workflow <name>",
		"  pnpm exec tsx scripts/workflow-garden-session.ts job-status|job-result --job <job-id>",
		"  pnpm exec tsx scripts/workflow-garden-session.ts follow-suggested --packet-file <path>",
		"  pnpm exec tsx scripts/workflow-garden-session.ts follow-route --packet-file <path> --route <id>",
		"  pnpm exec tsx scripts/workflow-garden-session.ts follow-decision-route --decision-file <path> --route <id>",
		"  pnpm exec tsx scripts/workflow-garden-session.ts accept-suggested --packet-file <path> [--transcript <path>]",
		"  pnpm exec tsx scripts/workflow-garden-session.ts accept-route --packet-file <path> --route <id> [--transcript <path>] [--page-turn-decision-out <path>]",
		"  pnpm exec tsx scripts/workflow-garden-session.ts walk-suggested --graph <graph-id> --transcript <path>",
		"  pnpm exec tsx scripts/workflow-garden-session.ts handoff --transcript <path>",
		"  pnpm exec tsx scripts/workflow-garden-session.ts transcript-decision --transcript <path> --handoff-out <path> --page-turn-decision-out <path>",
		"  pnpm exec tsx scripts/workflow-garden-session.ts record-step --packet-file <path> --transcript <path> [--route <id>]",
		"",
		"options:",
		"  --mcp-url <url>         Garden MCP JSON-RPC URL (or GARDEN_MCP_URL)",
		"  --token <token>         Garden bearer token (or GARDEN_LOOPBACK_TOKEN / GARDEN_TOKEN)",
		"  --graph <graph-id>      Garden graph id",
		"  --workflow <name>       workflow name",
		"  --page <id>             workflow-book page id",
		"  --choice <id>           workflow-book choice id",
		"  --route <id>            workflow-book navigation route id",
		"  --run-id <id>           run id for monitor",
		"  --job <id>              Garden local job id",
		"  --subject <iri>         RDF subject for decision detail",
		"  --packet-file <path>    compact choice packet for follow-suggested / accept-route",
		"  --decision-file <path>  retained PageTurnDecision JSON for follow-decision-route",
		"  --result-packet-file <path>  optional resulting packet for record-step",
		"  --result-packet-out <path>   write accept-suggested result packet JSON",
		"  --transcript <path>     JSONL transcript file for route, accept-suggested, record-step, or handoff",
		"  --handoff-out <path>    write transcript handoff Markdown after walk-suggested",
		"  --handoff-title <text>  title for transcript handoff output",
		"  --handoff-intent <mode> suggested, analysis-scout, or run-prep (default: suggested)",
		"  --shard <id>            shard id for retained PageTurnDecision artifacts",
		"  --entry <n>             1-based transcript entry for transcript-decision",
		"  --page-turn-decision-out <path>  write retained PageTurnDecision JSON for accept-route or transcript-decision",
		"  --page-turn-decision-md <path>   write retained PageTurnDecision Markdown",
		"  --page-turn-decision-ttl <path>  write retained PageTurnDecision Turtle",
		"  --command <command>     command to record instead of generating one",
		"  --decision <decision>   previewed, accepted, declined, modified, or observed",
		"  --note <text>           note to include in transcript entry",
		"  --next-output <mode>    append output mode to generated command: markdown, packet, json",
		"  --since <n>             event cursor for watch/await/monitor",
		"  --poll-ms <n>           poll interval",
		"  --timeout-ms <n>        bounded await/background timeout",
		"  --max-ticks <n>         bounded await/background max ticks",
		"  --max-steps <n>         bounded accepted page turns for walk-suggested",
		"  --limit <n>             decision rows to show (default: 25, max: 100)",
		"  --include-events / --no-include-events",
		"  --monitor-latest / --no-monitor-latest",
		"  --resolve-on-change / --no-resolve-on-change",
		"  --json                  print raw JSON instead of Markdown view",
		"  --packet                print compact choice packet JSON",
		"  --out <path>            write output to a file",
	].join("\n");
}

function usage(): never {
	throw new Error(usageText());
}

function parseArgs(argv: string[]): Args {
	const rawCommand = argv[0];
	if (!rawCommand || rawCommand === "--help" || rawCommand === "-h") {
		process.stdout.write(`${usageText()}\n`);
		process.exit(0);
	}
	const command = rawCommand as Command;
	if (
		command !== "list" &&
		command !== "catalog" &&
			command !== "decisions" &&
			command !== "decision" &&
			command !== "decision-routes" &&
			command !== "decision-launch" &&
			command !== "decision-launch-page" &&
			command !== "open" &&
		command !== "status" &&
		command !== "draft" &&
		command !== "choose" &&
		command !== "validate" &&
		command !== "watch" &&
		command !== "await" &&
		command !== "background-await" &&
		command !== "background-validate" &&
		command !== "prepare" &&
		command !== "execute" &&
		command !== "monitor" &&
		command !== "job-status" &&
		command !== "job-result" &&
		command !== "follow-suggested" &&
			command !== "follow-route" &&
			command !== "follow-decision-route" &&
			command !== "accept-suggested" &&
			command !== "accept-route" &&
			command !== "route" &&
			command !== "walk-suggested" &&
			command !== "handoff" &&
			command !== "transcript-decision" &&
			command !== "record-step"
	)
		usage();
	const args: Args = { command, json: false, packet: false };
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		const next = () => {
			const value = argv[++i];
			if (!value) throw new Error(`missing value for ${arg}`);
			return value;
		};
		const numberNext = () => {
			const value = Number(next());
			if (!Number.isFinite(value)) throw new Error(`expected number for ${arg}`);
			return value;
		};
		switch (arg) {
			case "--graph":
				args.graphId = next();
				break;
			case "--workflow":
				args.workflowName = next();
				break;
			case "--mcp-url":
				args.mcpUrl = next();
				break;
			case "--token":
				args.token = next();
				break;
			case "--page":
				args.pageId = next();
				break;
			case "--choice":
				args.choiceId = next();
				break;
			case "--route":
				args.routeId = next();
				break;
			case "--run-id":
				args.runId = next();
				break;
			case "--job":
				args.jobId = next();
				break;
			case "--subject":
				args.subject = next();
				break;
			case "--packet-file":
				args.packetFile = next();
				break;
			case "--decision-file":
				args.decisionFile = next();
				break;
			case "--result-packet-file":
				args.resultPacketFile = next();
				break;
			case "--result-packet-out":
				args.resultPacketOut = next();
				break;
			case "--transcript":
				args.transcriptFile = next();
				break;
			case "--handoff-out":
				args.handoffOut = next();
				break;
			case "--handoff-title":
				args.handoffTitle = next();
				break;
			case "--handoff-intent":
				args.handoffIntent = parseHandoffIntent(next());
				break;
			case "--shard":
				args.shardId = next();
				break;
			case "--entry":
				args.entryIndex = numberNext();
				break;
			case "--page-turn-decision-out":
				args.pageTurnDecisionOut = next();
				break;
			case "--page-turn-decision-md":
				args.pageTurnDecisionMarkdownOut = next();
				break;
			case "--page-turn-decision-ttl":
				args.pageTurnDecisionTurtleOut = next();
				break;
			case "--command":
				args.commandText = next();
				break;
			case "--decision": {
				const value = next();
				if (
					value !== "previewed" &&
					value !== "accepted" &&
					value !== "declined" &&
					value !== "modified" &&
					value !== "observed"
				) {
					throw new Error("--decision must be previewed, accepted, declined, modified, or observed");
				}
				args.decision = value;
				break;
			}
			case "--note":
				args.note = next();
				break;
			case "--next-output": {
				const value = next();
				if (value !== "markdown" && value !== "packet" && value !== "json") {
					throw new Error("--next-output must be markdown, packet, or json");
				}
				args.nextOutput = value;
				break;
			}
			case "--since":
				args.since = numberNext();
				break;
			case "--poll-ms":
				args.pollMs = numberNext();
				break;
			case "--timeout-ms":
				args.timeoutMs = numberNext();
				break;
			case "--max-ticks":
				args.maxTicks = numberNext();
				break;
			case "--max-steps":
				args.maxSteps = numberNext();
				break;
			case "--limit":
				args.limit = numberNext();
				break;
			case "--include-events":
				args.includeEvents = true;
				break;
			case "--no-include-events":
				args.includeEvents = false;
				break;
			case "--monitor-latest":
				args.monitorLatest = true;
				break;
			case "--no-monitor-latest":
				args.monitorLatest = false;
				break;
			case "--resolve-on-change":
				args.resolveOnChange = true;
				break;
			case "--no-resolve-on-change":
				args.resolveOnChange = false;
				break;
			case "--json":
				args.json = true;
				break;
			case "--packet":
				args.packet = true;
				break;
			case "--out":
				args.out = next();
				break;
			default:
				throw new Error(`unknown arg: ${arg}`);
		}
	}
	if (args.json && args.packet) {
		throw new Error("--json and --packet are mutually exclusive");
	}
	if (args.command === "follow-suggested" && (args.json || args.packet)) {
		throw new Error("follow-suggested uses --next-output instead of --json/--packet");
	}
	if (args.command === "follow-route" && (args.json || args.packet)) {
		throw new Error("follow-route uses --next-output instead of --json/--packet");
	}
	if (args.command === "follow-decision-route" && (args.json || args.packet)) {
		throw new Error("follow-decision-route uses --next-output instead of --json/--packet");
	}
	if (args.command === "accept-suggested" && args.nextOutput) {
		throw new Error("accept-suggested uses --json/--packet for result output");
	}
	if (args.command === "accept-route" && args.nextOutput) {
		throw new Error("accept-route uses --json/--packet for result output");
	}
	if (args.command === "walk-suggested" && args.nextOutput) {
		throw new Error("walk-suggested uses --json/--packet for final output");
	}
	if (args.command === "handoff" && args.packet) {
		throw new Error("handoff emits Markdown by default or JSON with --json");
	}
	if (args.command === "transcript-decision" && args.packet) {
		throw new Error("transcript-decision emits JSON artifacts and optional Markdown/Turtle, not packets");
	}
	if (args.maxSteps !== undefined && (!Number.isInteger(args.maxSteps) || args.maxSteps < 0)) {
		throw new Error("--max-steps must be a non-negative integer");
	}
	if (args.entryIndex !== undefined && (!Number.isInteger(args.entryIndex) || args.entryIndex < 1)) {
		throw new Error("--entry must be a positive 1-based integer");
	}
	if (args.command === "record-step" && (args.json || args.packet)) {
		throw new Error("record-step emits JSON transcript entries; use --out to write a copy");
	}
	if (args.command === "decisions" && args.packet) {
		throw new Error("decisions emits Markdown by default or JSON with --json");
	}
	if (args.command === "decision" && args.packet) {
		throw new Error("decision emits Markdown by default or JSON with --json");
	}
	if (args.command === "decision-routes" && args.packet) {
		throw new Error("decision-routes emits Markdown by default or JSON with --json");
	}
	if (args.command === "decision-launch" && args.packet) {
		throw new Error("decision-launch emits Markdown by default or JSON with --json");
	}
	return args;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.command === "follow-suggested") {
		emitText(args, followSuggestedCommand(args));
		return;
	}
	if (args.command === "follow-route") {
		emitText(args, followRouteCommand(args));
		return;
	}
	if (args.command === "follow-decision-route") {
		emitText(args, followDecisionRouteCommand(args));
		return;
	}
	if (args.command === "decision-routes") {
		emitDecisionRouteMenu(args);
		return;
	}
	if (args.command === "decision-launch") {
		emitDecisionLaunch(args);
		return;
	}
	if (args.command === "record-step") {
		emitJson(args, recordTranscriptStep(args));
		return;
	}
	if (args.command === "handoff") {
		emitHandoff(args, transcriptHandoff(args));
		return;
	}
	if (args.command === "transcript-decision") {
		emitJson(args, transcriptPageTurnDecision(args));
		return;
	}
	const caller = gardenMcpCallerFromHttp({
		mcpUrl: args.mcpUrl ?? process.env.GARDEN_MCP_URL ?? missing("Garden MCP URL", "--mcp-url or GARDEN_MCP_URL"),
		token: args.token ?? process.env.GARDEN_LOOPBACK_TOKEN ?? process.env.GARDEN_TOKEN,
	});
	const payload = await runCommand(caller, args);
	emit(args, payload);
}

async function runCommand(caller: GardenMcpCaller, args: Args): Promise<unknown> {
	if (args.command === "job-status") {
		return caller.callTool("get_job_status", { jobId: args.jobId ?? missing("job id", "--job") });
	}
	if (args.command === "job-result") {
		return caller.callTool("get_job_result", { jobId: args.jobId ?? missing("job id", "--job") });
	}
	if (args.command === "follow-suggested") {
		throw new Error("follow-suggested is handled offline before Garden MCP setup");
	}
	if (args.command === "follow-route") {
		throw new Error("follow-route is handled offline before Garden MCP setup");
	}
	if (args.command === "follow-decision-route") {
		throw new Error("follow-decision-route is handled offline before Garden MCP setup");
	}
	if (args.command === "decision-routes") {
		throw new Error("decision-routes is handled offline before Garden MCP setup");
	}
	if (args.command === "decision-launch") {
		throw new Error("decision-launch is handled offline before Garden MCP setup");
	}
	if (args.command === "record-step") {
		throw new Error("record-step is handled offline before Garden MCP setup");
	}
	if (args.command === "handoff") {
		throw new Error("handoff is handled offline before Garden MCP setup");
	}
	if (args.command === "transcript-decision") {
		throw new Error("transcript-decision is handled offline before Garden MCP setup");
	}
	if (args.command === "accept-suggested") {
		return acceptSuggestedTurn(caller, args);
	}
	if (args.command === "accept-route") {
		return acceptRouteTurn(caller, args);
	}
	if (args.command === "walk-suggested") {
		return walkSuggestedTurns(caller, args);
	}
	if (args.command === "decisions") {
		return gardenPageTurnDecisions(caller, {
			graphId: args.graphId ?? missing("graph id", "--graph"),
			limit: args.limit,
		});
	}
	if (args.command === "decision") {
		return gardenPageTurnDecisionDetail(caller, {
			graphId: args.graphId ?? missing("graph id", "--graph"),
			subject: args.subject ?? missing("decision subject", "--subject"),
		});
	}
	if (args.command === "decision-launch-page") {
		return gardenPageTurnDecisionLaunch(caller, {
			graphId: args.graphId ?? missing("graph id", "--graph"),
			workflowName: args.workflowName,
			subject: args.subject,
			handoffIntent: args.handoffIntent,
		});
	}
	if (args.command === "route") {
		return takeRoute(caller, args);
	}
	const request = sessionRequest(args);
	return callGardenWorkflowAuthoringSession(caller, request);
}

function sessionRequest(args: Args): GardenWorkflowSessionRequest {
	const graphId = args.graphId ?? missing("graph id", "--graph");
	const common = {
		graphId,
		workflowName: args.workflowName,
		pageId: args.pageId,
		runId: args.runId,
		since: args.since,
		pollMs: args.pollMs,
		timeoutMs: args.timeoutMs,
		maxTicks: args.maxTicks,
		includeEvents: args.includeEvents,
		monitorLatest: args.monitorLatest,
		resolveOnChange: args.resolveOnChange,
		handoffIntent: args.handoffIntent,
	};
	switch (args.command) {
		case "list":
		case "catalog":
			return {
				graphId,
				operation: "status",
				pageId: args.pageId,
			};
		case "decisions":
			throw new Error("decisions uses sparql_query, not workflow_authoring_session");
		case "decision":
			throw new Error("decision uses sparql_query, not workflow_authoring_session");
		case "decision-routes":
			throw new Error("decision-routes is derived from a saved PageTurnDecision");
		case "decision-launch":
			throw new Error("decision-launch is derived from a saved PageTurnDecision");
		case "decision-launch-page":
			throw new Error("decision-launch-page opens a native Garden launch page directly");
		case "open":
		case "status":
			return { ...common, operation: "status" };
		case "draft":
			return { ...common, operation: "draft" };
		case "choose":
			return {
				...common,
				operation: "choose",
				choiceId: args.choiceId ?? missing("choice id", "--choice"),
			};
		case "route":
			throw new Error("route resolves a named navigation route before choosing");
		case "validate":
			return { ...common, operation: "validate" };
		case "watch":
			return { ...common, operation: "watch" };
		case "await":
			return { ...common, operation: "await" };
		case "background-await":
			return { ...common, operation: "background", mode: "await" };
		case "background-validate":
			return { ...common, operation: "background", mode: "validate" };
		case "prepare":
			return { ...common, operation: "prepare_execute" };
		case "execute":
			return { ...common, operation: "execute" };
		case "monitor":
			return { ...common, operation: "monitor" };
		case "follow-suggested":
			throw new Error("follow-suggested does not map to workflow_authoring_session");
		case "follow-route":
			throw new Error("follow-route does not map to workflow_authoring_session");
		case "follow-decision-route":
			throw new Error("follow-decision-route does not map to workflow_authoring_session");
		case "accept-suggested":
			throw new Error("accept-suggested is derived from a saved choice packet");
		case "accept-route":
			throw new Error("accept-route is derived from a saved choice packet");
		case "walk-suggested":
			throw new Error("walk-suggested is an operator loop over saved or opened packets");
		case "handoff":
			throw new Error("handoff does not map to workflow_authoring_session");
		case "transcript-decision":
			throw new Error("transcript-decision is derived from a saved transcript");
		case "record-step":
			throw new Error("record-step does not map to workflow_authoring_session");
		default:
			throw new Error(`unsupported workflow session command: ${args.command}`);
	}
}

function followSuggestedCommand(args: Args): string {
	const packetFile = args.packetFile ?? missing("packet file", "--packet-file");
	const packet = JSON.parse(readFileSync(resolve(packetFile), "utf8"));
	return gardenWorkflowFollowSuggestedCommand(packet, {
		mcpUrl: args.mcpUrl,
		token: args.token,
		packetFile,
		output: args.nextOutput,
	});
}

function followRouteCommand(args: Args): string {
	const packetFile = args.packetFile ?? missing("packet file", "--packet-file");
	const packet = JSON.parse(readFileSync(resolve(packetFile), "utf8"));
	return gardenWorkflowRouteCommand(packet, args.routeId ?? missing("route id", "--route"), {
		mcpUrl: args.mcpUrl,
		token: args.token,
		handoffIntent: args.handoffIntent,
		output: args.nextOutput,
	});
}

function followDecisionRouteCommand(args: Args): string {
	const decisionFile = args.decisionFile ?? missing("decision file", "--decision-file");
	const decision = JSON.parse(readFileSync(resolve(decisionFile), "utf8")) as PageTurnDecision;
	return pageTurnDecisionRouteCommand(decision, args.routeId ?? missing("route id", "--route"), {
		mcpUrl: args.mcpUrl,
		token: args.token,
		handoffIntent: args.handoffIntent,
		output: args.nextOutput,
	});
}

function emitDecisionRouteMenu(args: Args): void {
	const decisionFile = args.decisionFile ?? missing("decision file", "--decision-file");
	const decision = JSON.parse(readFileSync(resolve(decisionFile), "utf8")) as PageTurnDecision;
	const menu = pageTurnDecisionRouteMenu(decision, {
		mcpUrl: args.mcpUrl,
		token: args.token,
		handoffIntent: args.handoffIntent,
		output: args.nextOutput,
	});
	const output = args.json
		? `${JSON.stringify(menu, null, 2)}\n`
		: renderPageTurnDecisionRouteMenuMarkdown(menu);
	if (args.out) {
		writeFileSync(resolve(args.out), output);
		console.log(`wrote ${args.out}`);
	} else {
		process.stdout.write(output);
	}
}

function emitDecisionLaunch(args: Args): void {
	const decisionFile = args.decisionFile ?? missing("decision file", "--decision-file");
	const decision = JSON.parse(readFileSync(resolve(decisionFile), "utf8")) as PageTurnDecision;
	const launch = pageTurnDecisionLaunchPage(decision, {
		mcpUrl: args.mcpUrl,
		token: args.token,
		handoffIntent: args.handoffIntent,
		output: args.nextOutput,
	});
	const output = args.json ? `${JSON.stringify(launch, null, 2)}\n` : renderPageTurnDecisionLaunchMarkdown(launch);
	if (args.out) {
		writeFileSync(resolve(args.out), output);
		console.log(`wrote ${args.out}`);
	} else {
		process.stdout.write(output);
	}
}

async function takeRoute(caller: GardenMcpCaller, args: Args): Promise<unknown> {
	const routeId = args.routeId ?? missing("route id", "--route");
	const current = await callGardenWorkflowAuthoringSession(caller, {
		graphId: args.graphId ?? missing("graph id", "--graph"),
		operation: "status",
		workflowName: args.workflowName,
		pageId: args.pageId,
		handoffIntent: args.handoffIntent,
	});
	const packet = gardenWorkflowSessionChoicePacket(current);
	const request = gardenWorkflowRouteSessionRequest(packet, routeId);
	if (args.handoffIntent !== undefined) request.handoffIntent = args.handoffIntent;
	const payload = await callGardenWorkflowAuthoringSession(caller, request);
	if (args.transcriptFile) {
		const resultPacket = gardenWorkflowSessionChoicePacket(payload);
		const entry = gardenWorkflowTranscriptEntry(packet, {
			decision: "accepted",
			followOptions: {
				mcpUrl: args.mcpUrl,
				token: args.token,
				handoffIntent: args.handoffIntent,
				output: outputMode(args),
			},
			note: args.note,
			resultPacket,
			routeId,
		});
		appendFileSync(resolve(args.transcriptFile), `${JSON.stringify(entry)}\n`);
	}
	return payload;
}

function recordTranscriptStep(args: Args): unknown {
	const packetFile = args.packetFile ?? missing("packet file", "--packet-file");
	const transcriptFile = args.transcriptFile ?? missing("transcript file", "--transcript");
	const packet = JSON.parse(readFileSync(resolve(packetFile), "utf8"));
	const resultPacket = args.resultPacketFile
		? JSON.parse(readFileSync(resolve(args.resultPacketFile), "utf8"))
		: undefined;
	const entry = gardenWorkflowTranscriptEntry(packet, {
		command: args.commandText,
		decision: args.decision,
		followOptions: {
			mcpUrl: args.mcpUrl,
			token: args.token,
			handoffIntent: args.handoffIntent,
			output: args.nextOutput,
		},
		note: args.note,
		resultPacket,
		routeId: args.routeId,
	});
	appendFileSync(resolve(transcriptFile), `${JSON.stringify(entry)}\n`);
	return entry;
}

async function acceptSuggestedTurn(caller: GardenMcpCaller, args: Args): Promise<unknown> {
	const packetFile = args.packetFile ?? missing("packet file", "--packet-file");
	const packet = JSON.parse(readFileSync(resolve(packetFile), "utf8"));
	const request = gardenWorkflowSuggestedSessionRequest(packet);
	const routeId = gardenWorkflowRecommendedRouteId(packet);
	if (args.handoffIntent !== undefined) request.handoffIntent = args.handoffIntent;
	const payload = await callGardenWorkflowAuthoringSession(caller, request);
	const resultPacket = gardenWorkflowSessionChoicePacket(payload);
	if (args.resultPacketOut) {
		writeFileSync(resolve(args.resultPacketOut), `${JSON.stringify(resultPacket, null, 2)}\n`);
	}
	let entry: GardenWorkflowTranscriptEntry | undefined;
	if (args.transcriptFile) {
		entry = gardenWorkflowTranscriptEntry(packet, {
			decision: "accepted",
			followOptions: {
				mcpUrl: args.mcpUrl,
				token: args.token,
				output: outputMode(args),
			},
			note: args.note,
			resultPacket,
			routeId,
		});
		appendFileSync(resolve(args.transcriptFile), `${JSON.stringify(entry)}\n`);
	}
	return payload;
}

async function acceptRouteTurn(caller: GardenMcpCaller, args: Args): Promise<unknown> {
	const packetFile = args.packetFile ?? missing("packet file", "--packet-file");
	const routeId = args.routeId ?? missing("route id", "--route");
	const packet = JSON.parse(readFileSync(resolve(packetFile), "utf8"));
	const request = gardenWorkflowRouteSessionRequest(packet, routeId);
	if (args.handoffIntent !== undefined) request.handoffIntent = args.handoffIntent;
	const payload = await callGardenWorkflowAuthoringSession(caller, request);
	const resultPacket = gardenWorkflowSessionChoicePacket(payload);
	if (args.resultPacketOut) {
		writeFileSync(resolve(args.resultPacketOut), `${JSON.stringify(resultPacket, null, 2)}\n`);
	}
	if (args.transcriptFile) {
		const entry = gardenWorkflowTranscriptEntry(packet, {
			decision: "accepted",
			followOptions: {
				mcpUrl: args.mcpUrl,
				token: args.token,
				handoffIntent: args.handoffIntent,
				output: outputMode(args),
			},
			note: args.note,
			resultPacket,
			routeId,
		});
		appendFileSync(resolve(args.transcriptFile), `${JSON.stringify(entry)}\n`);
	}
	if (args.pageTurnDecisionOut || args.pageTurnDecisionMarkdownOut || args.pageTurnDecisionTurtleOut) {
		if (!entry) {
			throw new Error("accept-route PageTurnDecision output requires --transcript so the accepted turn has evidence");
		}
		writeAcceptedRoutePageTurnDecision(args, entry, packetFile);
	}
	return payload;
}

function writeAcceptedRoutePageTurnDecision(
	args: Args,
	entry: GardenWorkflowTranscriptEntry,
	packetFile: string,
): PageTurnDecision {
	const transcriptFile = args.transcriptFile ?? missing("transcript file", "--transcript");
	const decision = pageTurnDecisionFromTranscriptEntry(entry, {
		shardId: args.shardId ?? defaultTranscriptDecisionShardId(transcriptFile, 0),
		intent: args.handoffIntent,
		evidenceRefs: {
			handoff: args.handoffOut ?? packetFile,
			transcript: transcriptFile,
		},
	});
	if (args.pageTurnDecisionOut) {
		writeFileSync(resolve(args.pageTurnDecisionOut), `${JSON.stringify(decision, null, 2)}\n`);
	}
	if (args.pageTurnDecisionMarkdownOut) {
		writeFileSync(resolve(args.pageTurnDecisionMarkdownOut), renderPageTurnDecisionMarkdown(decision));
	}
	if (args.pageTurnDecisionTurtleOut) {
		writeFileSync(resolve(args.pageTurnDecisionTurtleOut), renderPageTurnDecisionTurtle(decision));
	}
	return decision;
}

function outputMode(args: Args): "packet" | "json" | undefined {
	if (args.packet) return "packet";
	if (args.json) return "json";
	return undefined;
}

function transcriptHandoff(args: Args): GardenWorkflowTranscriptHandoff {
	const transcriptFile = args.transcriptFile ?? missing("transcript file", "--transcript");
	const entries = parseGardenWorkflowTranscriptJsonl(readFileSync(resolve(transcriptFile), "utf8"));
	return gardenWorkflowTranscriptHandoff(entries, {
		transcriptPath: transcriptFile,
		title: args.handoffTitle,
		intent: args.handoffIntent,
	});
}

interface TranscriptPageTurnDecisionArtifact {
	kind: "workflowPageTurnDecisionArtifact";
	transcriptFile: string;
	entryIndex: number;
	handoffOut: string;
	pageTurnDecisionOut?: string;
	pageTurnDecisionMarkdownOut?: string;
	pageTurnDecisionTurtleOut?: string;
	decision: PageTurnDecision;
}

function transcriptPageTurnDecision(args: Args): TranscriptPageTurnDecisionArtifact {
	const transcriptFile = args.transcriptFile ?? missing("transcript file", "--transcript");
	const handoffOut = args.handoffOut ?? missing("handoff output", "--handoff-out");
	const entries = parseGardenWorkflowTranscriptJsonl(readFileSync(resolve(transcriptFile), "utf8"));
	const selected = selectTranscriptDecisionEntry(entries, args.entryIndex);
	writeHandoff(args, transcriptFile, handoffOut);
	const decision = pageTurnDecisionFromTranscriptEntry(selected.entry, {
		shardId: args.shardId ?? defaultTranscriptDecisionShardId(transcriptFile, selected.index),
		intent: args.handoffIntent,
		evidenceRefs: {
			handoff: handoffOut,
			transcript: transcriptFile,
		},
	});
	if (args.pageTurnDecisionOut) {
		writeFileSync(resolve(args.pageTurnDecisionOut), `${JSON.stringify(decision, null, 2)}\n`);
	}
	if (args.pageTurnDecisionMarkdownOut) {
		writeFileSync(resolve(args.pageTurnDecisionMarkdownOut), renderPageTurnDecisionMarkdown(decision));
	}
	if (args.pageTurnDecisionTurtleOut) {
		writeFileSync(resolve(args.pageTurnDecisionTurtleOut), renderPageTurnDecisionTurtle(decision));
	}
	return {
		kind: "workflowPageTurnDecisionArtifact",
		transcriptFile,
		entryIndex: selected.index + 1,
		handoffOut,
		pageTurnDecisionOut: args.pageTurnDecisionOut,
		pageTurnDecisionMarkdownOut: args.pageTurnDecisionMarkdownOut,
		pageTurnDecisionTurtleOut: args.pageTurnDecisionTurtleOut,
		decision,
	};
}

function selectTranscriptDecisionEntry(
	entries: GardenWorkflowTranscriptEntry[],
	entryIndex: number | undefined,
): { entry: GardenWorkflowTranscriptEntry; index: number } {
	if (entries.length === 0) throw new Error("transcript has no entries");
	if (entryIndex !== undefined) {
		const index = entryIndex - 1;
		const entry = entries[index];
		if (!entry) throw new Error(`transcript does not contain entry ${entryIndex}`);
		return { entry, index };
	}
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.summary.followedRouteId) return { entry, index };
	}
	return { entry: entries[entries.length - 1], index: entries.length - 1 };
}

function defaultTranscriptDecisionShardId(transcriptFile: string, index: number): string {
	const name = basename(transcriptFile).replace(/\.(jsonl|json|md|txt)$/i, "");
	return `${name || "transcript"}-entry-${index + 1}`;
}

type SessionWorkflowWalkResult = GardenWorkflowWalkResult & { transcriptFile: string };

async function walkSuggestedTurns(caller: GardenMcpCaller, args: Args): Promise<SessionWorkflowWalkResult> {
	const transcriptFile = args.transcriptFile ?? missing("transcript file", "--transcript");
	const packet = args.packetFile ? JSON.parse(readFileSync(resolve(args.packetFile), "utf8")) : undefined;
	const result = await gardenWorkflowWalkSuggested(caller, {
		packet,
		graphId: args.graphId,
		workflowName: args.workflowName,
		pageId: args.pageId,
		maxSteps: args.maxSteps,
		handoffIntent: args.handoffIntent,
		note: args.note,
		followOptions: {
			mcpUrl: args.mcpUrl,
			token: args.token,
			output: "packet",
		},
		onTranscriptEntry(entry) {
			appendFileSync(resolve(transcriptFile), `${JSON.stringify(entry)}\n`);
		},
	});
	if (args.handoffOut) {
		writeHandoff(args, transcriptFile, args.handoffOut);
	}
	return {
		...result,
		transcriptFile,
	};
}

function writeHandoff(args: Args, transcriptFile: string, outputPath: string): void {
	const handoff = gardenWorkflowTranscriptHandoff(
		parseGardenWorkflowTranscriptJsonl(readFileSync(resolve(transcriptFile), "utf8")),
		{
			transcriptPath: transcriptFile,
			title: args.handoffTitle,
			intent: args.handoffIntent,
		},
	);
	writeFileSync(resolve(outputPath), renderGardenWorkflowTranscriptHandoffMarkdown(handoff));
}

function emit(args: Args, payload: unknown): void {
	const walk = workflowWalkResult(payload);
	const decisions = pageTurnDecisionList(payload);
	const decision = pageTurnDecisionDetail(payload);
	const output = args.json
		? `${JSON.stringify(payload, null, 2)}\n`
		: args.packet
			? `${JSON.stringify(walk ? walk.finalPacket : gardenWorkflowSessionChoicePacket(payload), null, 2)}\n`
			: decisions
				? renderGardenPageTurnDecisionsMarkdown(decisions)
				: decision
					? renderGardenPageTurnDecisionDetailMarkdown(decision)
				: walk
				? walk.finalPayload
					? renderGardenWorkflowSessionMarkdown(walk.finalPayload)
					: `${JSON.stringify(walk.finalPacket, null, 2)}\n`
				: renderGardenWorkflowSessionMarkdown(payload);
	if (args.out) {
		writeFileSync(resolve(args.out), output);
		console.log(`wrote ${args.out}`);
	} else {
		process.stdout.write(output);
	}
}

function workflowWalkResult(payload: unknown): SessionWorkflowWalkResult | undefined {
	return payload &&
		typeof payload === "object" &&
		(payload as { kind?: unknown }).kind === "gardenWorkflowWalkResult"
		? (payload as SessionWorkflowWalkResult)
		: undefined;
}

function pageTurnDecisionList(payload: unknown): Parameters<typeof renderGardenPageTurnDecisionsMarkdown>[0] | undefined {
	return payload &&
		typeof payload === "object" &&
		(payload as { kind?: unknown }).kind === "gardenPageTurnDecisionList"
		? (payload as Parameters<typeof renderGardenPageTurnDecisionsMarkdown>[0])
		: undefined;
}

function pageTurnDecisionDetail(payload: unknown): Parameters<typeof renderGardenPageTurnDecisionDetailMarkdown>[0] | undefined {
	return payload &&
		typeof payload === "object" &&
		(payload as { kind?: unknown }).kind === "gardenPageTurnDecisionDetail"
		? (payload as Parameters<typeof renderGardenPageTurnDecisionDetailMarkdown>[0])
		: undefined;
}

function emitJson(args: Args, payload: unknown): void {
	const output = `${JSON.stringify(payload, null, 2)}\n`;
	if (args.out) {
		writeFileSync(resolve(args.out), output);
		console.log(`wrote ${args.out}`);
	} else {
		process.stdout.write(output);
	}
}

function emitText(args: Args, output: string): void {
	const text = output.endsWith("\n") ? output : `${output}\n`;
	if (args.out) {
		writeFileSync(resolve(args.out), text);
		console.log(`wrote ${args.out}`);
	} else {
		process.stdout.write(text);
	}
}

function emitHandoff(args: Args, handoff: GardenWorkflowTranscriptHandoff): void {
	const output = args.json
		? `${JSON.stringify(handoff, null, 2)}\n`
		: renderGardenWorkflowTranscriptHandoffMarkdown(handoff);
	if (args.out) {
		writeFileSync(resolve(args.out), output);
		console.log(`wrote ${args.out}`);
	} else {
		process.stdout.write(output);
	}
}

function missing(label: string, source: string): never {
	throw new Error(`missing ${label}; pass ${source}`);
}

function parseHandoffIntent(value: string): GardenWorkflowHandoffIntent {
	if (value === "suggested" || value === "analysis-scout" || value === "run-prep") return value;
	throw new Error("--handoff-intent must be suggested, analysis-scout, or run-prep");
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
