import { createHash } from "node:crypto";
import type { WorkflowMeta } from "./harness.js";
import { userRdfGraphIri } from "./vocab.js";

export interface GardenMcpCaller {
	callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface GardenMcpHttpOptions {
	mcpUrl: string;
	token?: string;
	fetchFn?: typeof fetch;
}

export interface GardenWorkflowBlockRef {
	documentId: string;
	blockId: string;
}

export interface GardenWorkflowDraftMove {
	operation: "create_workflow" | "add_phase" | "attach_agent_node" | "bind_input_block";
	[key: string]: unknown;
}

export interface GardenWorkflowDraftAgentNode {
	label: string;
	phaseIndex?: number;
	agentType?: string;
	documentId?: string;
}

export interface GardenWorkflowDraftPlan {
	workflowName: string;
	scriptSha256: string;
	sourceBlock: GardenWorkflowBlockRef;
	inputBlock?: GardenWorkflowBlockRef;
	agentNodes: GardenWorkflowDraftAgentNode[];
	moves: GardenWorkflowDraftMove[];
}

export interface ComposeGardenWorkflowDraftRequest {
	graphId: string;
	meta: WorkflowMeta;
	source: string;
	workflowArgs?: unknown;
	workflowName?: string;
	pageId?: string;
	agentNodes?: GardenWorkflowDraftAgentNode[];
	sourceBlock?: GardenWorkflowBlockRef;
	inputBlock?: GardenWorkflowBlockRef;
	sourceDocumentId?: string;
	inputDocumentId?: string;
}

export interface ComposeGardenWorkflowDraftResult {
	plan: GardenWorkflowDraftPlan;
	sourceWrite?: unknown;
	inputWrite?: unknown;
	draft: unknown;
	validationWatch?: unknown;
}

export interface GardenValidationWatchRequest {
	graphId: string;
	workflowName: string;
	pageId?: string;
	pollMs?: number;
	timeoutMs?: number;
	maxTicks?: number;
	resolveOnChange?: boolean;
}

export interface GardenWorkflowSessionRequest {
	graphId: string;
	operation:
		| "status"
		| "choose"
		| "validate"
		| "watch"
		| "await"
		| "background"
		| "draft"
		| "prepare_execute"
		| "execute"
		| "monitor";
	workflowName?: string;
	pageId?: string;
	choiceId?: string;
	mode?: "await" | "validate";
	runId?: string;
	since?: number;
	pollMs?: number;
	timeoutMs?: number;
	maxTicks?: number;
	includeEvents?: boolean;
	monitorLatest?: boolean;
	resolveOnChange?: boolean;
	executionChoiceId?: string;
	handoffIntent?: GardenWorkflowHandoffIntent;
}

export interface GardenPageTurnDecisionRow {
	subject: string;
	generatedAt?: string;
	graphId?: string;
	workflowName?: string;
	fromPage?: string;
	intent?: string;
	readiness?: string;
	nativeSuggestedChoice?: string;
	recommendedRoute?: string;
	recommendedRouteLabel?: string;
	recommendedChoice?: string;
	followedRoute?: string;
	followedRouteLabel?: string;
	followedChoice?: string;
	followedChoiceLabel?: string;
	executionAuthorized?: boolean;
	authorizationFlagCount?: number;
	rationale?: string;
}

export interface GardenPageTurnDecisionList {
	kind: "gardenPageTurnDecisionList";
	graphId: string;
	limit: number;
	query: string;
	decisions: GardenPageTurnDecisionRow[];
}

export interface GardenPageTurnDecisionEvidence {
	subject: string;
	role?: string;
	path?: string;
}

export interface GardenPageTurnDecisionNavigationRoute {
	subject: string;
	routeId?: string;
	routeLabel?: string;
	routeKind?: string;
	intent?: string;
	choiceId?: string;
	choiceLabel?: string;
	source?: string;
	rationale?: string;
	actionJson?: string;
	routeAction?: string;
	actionTool?: string;
	actionKind?: string;
	commandTemplate?: string;
	argumentHash?: string;
}

export interface GardenPageTurnDecisionAuthorizationFlag {
	subject: string;
	pageId?: string;
	choiceId?: string;
	reason?: string;
}

export interface GardenPageTurnDecisionDetail {
	kind: "gardenPageTurnDecisionDetail";
	graphId: string;
	subject: string;
	query: string;
	decision?: GardenPageTurnDecisionRow;
	evidence: GardenPageTurnDecisionEvidence[];
	navigationRoutes: GardenPageTurnDecisionNavigationRoute[];
	authorizationFlags: GardenPageTurnDecisionAuthorizationFlag[];
}

export interface GardenPageTurnDecisionLaunchOptions {
	graphId: string;
	workflowName?: string;
	subject?: string;
	handoffIntent?: GardenWorkflowHandoffIntent;
}

export interface GardenPageTurnDecisionLaunchSelection {
	subject?: string;
	launchChoiceId: string;
	launchPageId?: string;
}

export interface GardenWorkflowAdventureDetailSelection {
	subject?: string;
	detailChoiceId: string;
	detailPageId?: string;
}

export interface GardenWorkflowChoicePacket {
	kind: "gardenWorkflowChoicePacket";
	operation?: string;
	graphId?: string;
	workflowName?: string;
	page: {
		id: string;
		title: string;
		kind?: string;
		summary?: string;
		scene?: string;
	};
	status?: string;
	message?: string;
	validation?: {
		passed?: boolean;
		summary?: string;
	};
	latestRun?: {
		runId?: string;
		status?: string;
	};
	facts: GardenWorkflowPacketFact[];
	warnings: string[];
	objects: GardenWorkflowPacketObject[];
	sections: GardenWorkflowPacketSection[];
	choices: GardenWorkflowPacketChoice[];
	suggestedChoice?: GardenWorkflowPacketChoice;
	intentRecommendation?: GardenWorkflowIntentRecommendation;
	navigationRoutes?: GardenWorkflowNavigationRoute[];
	recommendedNextAction?: GardenWorkflowRecommendedNextAction;
	nextActions: GardenWorkflowPacketAction[];
}

export interface GardenWorkflowPacketFact {
	label: string;
	value: unknown;
}

export interface GardenWorkflowPacketObject {
	kind: string;
	label?: string;
	id?: string;
	subject?: string;
	status?: string;
	latestRunStatus?: string;
	pageId?: string;
	graphId?: string;
	workflowName?: string;
	fromPage?: string;
	intent?: string;
	readiness?: string;
	nativeSuggestedChoice?: string;
	recommendedRoute?: string;
	recommendedRouteLabel?: string;
	recommendedChoice?: string;
	followedRoute?: string;
	followedRouteLabel?: string;
	followedChoice?: string;
	followedChoiceLabel?: string;
	primaryRoute?: string;
	primaryRouteLabel?: string;
	primaryChoice?: string;
	primaryChoiceLabel?: string;
	routeCount?: number;
	navigationRouteCount?: number;
	rawSparqlQueryCount?: number;
	executionAuthorized?: boolean;
	evidenceCount?: number;
	authorizationFlagsVisible?: number;
	role?: string;
	reason?: string;
	choiceId?: string;
	phaseOrder?: number;
	phaseCount?: number;
	agentCount?: number;
	runCount?: number;
	documentId?: string;
	blockId?: string;
	method?: string;
	path?: string;
	parsed?: boolean;
}

export interface GardenWorkflowPacketSection {
	id?: string;
	title: string;
	items: GardenWorkflowPacketSectionItem[];
}

export interface GardenWorkflowPacketSectionItem {
	label?: string;
	description?: string;
	subject?: string;
	generatedAt?: string;
	workflowName?: string;
	pageId?: string;
	pageTitle?: string;
	intent?: string;
	recommendedRoute?: string;
	recommendedRouteLabel?: string;
	recommendedChoice?: string;
	navigationRouteCount?: number;
	rawSparqlQueryCount?: number;
	pageIdForBook?: string;
	routeId?: string;
	routeLabel?: string;
	routeKind?: string;
	routeStatus?: string;
	choiceLabel?: string;
	source?: string;
	rationale?: string;
	actionJson?: string;
	choiceId?: string;
	workflowUri?: string;
	documentId?: string;
	phaseCount?: number;
	agentCount?: number;
	runCount?: number;
}

export interface GardenWorkflowPacketChoice {
	id: string;
	label: string;
	kind?: string;
	targetPageId?: string;
	description?: string;
	suggested: boolean;
	requiresExplicitAuthorization?: boolean;
	authorizationReason?: string;
	action?: unknown;
}

export interface GardenWorkflowIntentRecommendation {
	intent?: string;
	choiceId: string;
	choiceLabel?: string;
	source?: string;
	rationale?: string;
}

export interface GardenWorkflowNavigationRoute {
	id: string;
	label: string;
	kind?: string;
	intent?: string;
	choiceId: string;
	choiceLabel?: string;
	source?: string;
	rationale?: string;
	requiresExplicitAuthorization?: boolean;
	authorizationReason?: string;
	action?: GardenWorkflowPacketAction;
}

export interface GardenWorkflowPacketAction {
	tool: string;
	arguments?: Record<string, unknown>;
	text: string;
}

export interface GardenWorkflowRecommendedNextAction {
	kind: "accept-route" | "choose" | "tool-action";
	source: "intent-recommendation" | "suggested-route" | "suggested-choice" | "next-action";
	routeId?: string;
	routeLabel?: string;
	choiceId?: string;
	choiceLabel?: string;
	rationale?: string;
	requiresLiveMcp: true;
	requiresPacketFile?: boolean;
	requiresExplicitAuthorization?: boolean;
	authorizationReason?: string;
	commandTemplate: string;
	action?: GardenWorkflowPacketAction;
}

export type GardenWorkflowHandoffIntent = "suggested" | "analysis-scout" | "run-prep";

export interface GardenWorkflowFollowCommandOptions {
	commandPrefix?: string[];
	mcpUrl?: string;
	token?: string;
	packetFile?: string;
	handoffIntent?: GardenWorkflowHandoffIntent;
	output?: "markdown" | "packet" | "json";
}

export type GardenWorkflowTranscriptDecision = "previewed" | "accepted" | "declined" | "modified" | "observed";

export interface GardenWorkflowTranscriptEntryOptions {
	command?: string;
	decision?: GardenWorkflowTranscriptDecision;
	followOptions?: GardenWorkflowFollowCommandOptions;
	note?: string;
	recordedAt?: string;
	resultPacket?: unknown;
	routeId?: string;
}

export interface GardenWorkflowTranscriptEntry {
	kind: "gardenWorkflowTranscriptEntry";
	schemaVersion: 1;
	recordedAt: string;
	decision: GardenWorkflowTranscriptDecision;
	command?: string;
	note?: string;
	packet: Record<string, unknown>;
	resultPacket?: Record<string, unknown>;
	summary: {
		graphId?: string;
		workflowName?: string;
		pageId?: string;
		pageTitle?: string;
		status?: string;
		suggestedChoiceId?: string;
		suggestedChoiceLabel?: string;
		recommendedRouteId?: string;
		recommendedRouteLabel?: string;
		followedRouteId?: string;
		followedRouteLabel?: string;
		followedRouteChoiceId?: string;
		followedRouteChoiceLabel?: string;
		resultPageId?: string;
		resultStatus?: string;
	};
}

export interface GardenWorkflowTranscriptHandoffOptions {
	generatedAt?: string;
	title?: string;
	transcriptPath?: string;
	intent?: GardenWorkflowHandoffIntent;
	preferredNextChoiceId?: string;
}

export type HandoffNextChoiceSource = "garden-suggested" | "handoff-preferred" | "garden-intent-recommendation";

export interface GardenWorkflowTranscriptHandoff {
	kind: "gardenWorkflowTranscriptHandoff";
	schemaVersion: 1;
	generatedAt: string;
	title: string;
	transcriptPath?: string;
	entryCount: number;
	decisionCounts: Record<string, number>;
	current?: {
		graphId?: string;
		workflowName?: string;
		pageId?: string;
		pageTitle?: string;
		status?: string;
		suggestedChoiceId?: string;
		suggestedChoiceLabel?: string;
		latestRunId?: string;
		latestRunStatus?: string;
	};
	path: Array<{
		index: number;
		recordedAt: string;
		decision: GardenWorkflowTranscriptDecision;
		pageId?: string;
		pageTitle?: string;
		status?: string;
		suggestedChoiceId?: string;
		suggestedChoiceLabel?: string;
		recommendedRouteId?: string;
		recommendedRouteLabel?: string;
		followedRouteId?: string;
		followedRouteLabel?: string;
		followedRouteChoiceId?: string;
		followedRouteChoiceLabel?: string;
		resultPageId?: string;
		resultStatus?: string;
		command?: string;
		note?: string;
	}>;
	currentFacts: GardenWorkflowPacketFact[];
	currentWarnings: string[];
	currentObjects: GardenWorkflowPacketObject[];
	currentSections: GardenWorkflowPacketSection[];
	currentRoutes: GardenWorkflowNavigationRoute[];
	currentChoices: GardenWorkflowPacketChoice[];
	suggestedNext?: {
		routeId?: string;
		routeLabel?: string;
		choiceId: string;
		label: string;
		kind?: string;
		targetPageId?: string;
		source?: HandoffNextChoiceSource;
		rationale: string;
		expectedNextPage?: string;
		safetyBoundary?: string;
	};
	nextActions: GardenWorkflowPacketAction[];
	nextCommand?: string;
}

export interface GardenWorkflowWalkSuggestedOptions {
	packet?: unknown;
	graphId?: string;
	workflowName?: string;
	pageId?: string;
	maxSteps?: number;
	handoffIntent?: GardenWorkflowHandoffIntent;
	note?: string;
	followOptions?: GardenWorkflowFollowCommandOptions;
	onTranscriptEntry?: (entry: GardenWorkflowTranscriptEntry) => void | Promise<void>;
}

export interface GardenWorkflowWalkStep {
	index: number;
	command: string;
	request: Record<string, unknown>;
	packet: unknown;
	resultPacket: unknown;
}

export interface GardenWorkflowWalkResult {
	kind: "gardenWorkflowWalkResult";
	startedFrom: "packet" | "session";
	maxSteps: number;
	steps: GardenWorkflowWalkStep[];
	stopReason: string;
	finalPacket: unknown;
	finalPayload?: unknown;
	transcriptEntries: GardenWorkflowTranscriptEntry[];
}

export function gardenMcpCallerFromHttp(options: GardenMcpHttpOptions): GardenMcpCaller {
	const mcpUrl = options.mcpUrl.trim();
	const fetchFn = options.fetchFn ?? fetch;
	let id = 0;
	return {
		async callTool(name, args) {
			const response = await fetchFn(mcpUrl, {
				method: "POST",
				headers: {
					...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
					"Content-Type": "application/json",
					Accept: "application/json",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: `garden-authoring-${++id}`,
					method: "tools/call",
					params: { name, arguments: args },
				}),
			});
			const text = await response.text();
			const body = parseJsonRpcBody(name, response.status, text);
			if (!response.ok || body.error) {
				throw new Error(`${name} failed HTTP ${response.status}: ${JSON.stringify(body)}`);
			}
			return unwrapMcpToolResult(body.result);
		},
	};
}

export async function callGardenWorkflowAuthoringSession(
	caller: GardenMcpCaller,
	request: GardenWorkflowSessionRequest,
): Promise<unknown> {
	return caller.callTool("workflow_authoring_session", gardenWorkflowSessionArguments(request));
}

export async function gardenPageTurnDecisions(
	caller: GardenMcpCaller,
	options: { graphId: string; limit?: number },
): Promise<GardenPageTurnDecisionList> {
	const limit = normalizeDecisionLimit(options.limit);
	const query = gardenPageTurnDecisionsQuery(options.graphId, limit);
	const result = await caller.callTool("sparql_query", { graphId: options.graphId, query });
	return {
		kind: "gardenPageTurnDecisionList",
		graphId: options.graphId,
		limit,
		query,
		decisions: sparqlRows(result).map(pageTurnDecisionRow),
	};
}

export function gardenPageTurnDecisionsQuery(graphId: string, limit = 25): string {
	const safeLimit = normalizeDecisionLimit(limit);
	return [
		"PREFIX wf: <http://mnemosyne.dev/workflow#>",
		"PREFIX wfui: <https://sophia-labs.com/ns/workflow-ui#>",
		"PREFIX prov: <http://www.w3.org/ns/prov#>",
		"SELECT DISTINCT ?decision ?generatedAt ?graphId ?workflowName ?fromPage ?intent ?readiness ?nativeSuggestedChoice ?recommendedRoute ?recommendedRouteLabel ?recommendedChoice ?followedRoute ?followedRouteLabel ?followedChoice ?followedChoiceLabel ?executionAuthorized ?authorizationFlagCount ?rationale WHERE {",
		`  GRAPH <${userRdfGraphIri(graphId)}> {`,
		"    ?decision a ?decisionType .",
		"    VALUES ?decisionType { wf:PageTurnDecision wfui:PageTurnDecision }",
		"    OPTIONAL { ?decision prov:generatedAtTime ?generatedAt }",
		"    OPTIONAL { ?decision wf:graphId ?wfGraphId }",
		"    OPTIONAL { ?decision wfui:graphId ?wfuiGraphId }",
		"    BIND(COALESCE(?wfGraphId, ?wfuiGraphId) AS ?graphId)",
		"    OPTIONAL { ?decision wf:workflowName ?wfWorkflowName }",
		"    OPTIONAL { ?decision wfui:workflowName ?wfuiWorkflowName }",
		"    BIND(COALESCE(?wfWorkflowName, ?wfuiWorkflowName) AS ?workflowName)",
		"    OPTIONAL { ?decision wf:fromPage ?wfFromPage }",
		"    OPTIONAL { ?decision wfui:fromPage ?wfuiFromPage }",
		"    BIND(COALESCE(?wfFromPage, ?wfuiFromPage) AS ?fromPage)",
		"    OPTIONAL { ?decision wf:intent ?wfIntent }",
		"    OPTIONAL { ?decision wfui:intent ?wfuiIntent }",
		"    BIND(COALESCE(?wfIntent, ?wfuiIntent) AS ?intent)",
		"    OPTIONAL { ?decision wf:readiness ?wfReadiness }",
		"    OPTIONAL { ?decision wfui:readiness ?wfuiReadiness }",
		"    BIND(COALESCE(?wfReadiness, ?wfuiReadiness) AS ?readiness)",
		"    OPTIONAL { ?decision wf:nativeSuggestedChoiceId ?wfNativeSuggestedChoice }",
		"    OPTIONAL { ?decision wfui:nativeSuggestedChoiceId ?wfuiNativeSuggestedChoice }",
		"    BIND(COALESCE(?wfNativeSuggestedChoice, ?wfuiNativeSuggestedChoice) AS ?nativeSuggestedChoice)",
		"    OPTIONAL { ?decision wf:recommendedRouteId ?wfRecommendedRoute }",
		"    OPTIONAL { ?decision wfui:recommendedRouteId ?wfuiRecommendedRoute }",
		"    BIND(COALESCE(?wfRecommendedRoute, ?wfuiRecommendedRoute) AS ?recommendedRoute)",
		"    OPTIONAL { ?decision wf:recommendedRouteLabel ?wfRecommendedRouteLabel }",
		"    OPTIONAL { ?decision wfui:recommendedRouteLabel ?wfuiRecommendedRouteLabel }",
		"    BIND(COALESCE(?wfRecommendedRouteLabel, ?wfuiRecommendedRouteLabel) AS ?recommendedRouteLabel)",
		"    OPTIONAL { ?decision wf:recommendedChoiceId ?wfRecommendedChoice }",
		"    OPTIONAL { ?decision wfui:recommendedChoiceId ?wfuiRecommendedChoice }",
		"    BIND(COALESCE(?wfRecommendedChoice, ?wfuiRecommendedChoice) AS ?recommendedChoice)",
		"    OPTIONAL { ?decision wf:followedRouteId ?wfFollowedRoute }",
		"    OPTIONAL { ?decision wfui:followedRouteId ?wfuiFollowedRoute }",
		"    BIND(COALESCE(?wfFollowedRoute, ?wfuiFollowedRoute) AS ?followedRoute)",
		"    OPTIONAL { ?decision wf:followedRouteLabel ?wfFollowedRouteLabel }",
		"    OPTIONAL { ?decision wfui:followedRouteLabel ?wfuiFollowedRouteLabel }",
		"    BIND(COALESCE(?wfFollowedRouteLabel, ?wfuiFollowedRouteLabel) AS ?followedRouteLabel)",
		"    OPTIONAL { ?decision wf:followedChoiceId ?wfFollowedChoice }",
		"    OPTIONAL { ?decision wfui:followedChoiceId ?wfuiFollowedChoice }",
		"    BIND(COALESCE(?wfFollowedChoice, ?wfuiFollowedChoice) AS ?followedChoice)",
		"    OPTIONAL { ?decision wf:followedChoiceLabel ?wfFollowedChoiceLabel }",
		"    OPTIONAL { ?decision wfui:followedChoiceLabel ?wfuiFollowedChoiceLabel }",
		"    BIND(COALESCE(?wfFollowedChoiceLabel, ?wfuiFollowedChoiceLabel) AS ?followedChoiceLabel)",
		"    OPTIONAL { ?decision wf:executionAuthorized ?wfExecutionAuthorized }",
		"    OPTIONAL { ?decision wfui:executionAuthorized ?wfuiExecutionAuthorized }",
		"    BIND(COALESCE(?wfExecutionAuthorized, ?wfuiExecutionAuthorized) AS ?executionAuthorized)",
		"    OPTIONAL { ?decision wf:authorizationFlagCount ?wfAuthorizationFlagCount }",
		"    OPTIONAL { ?decision wfui:authorizationFlagCount ?wfuiAuthorizationFlagCount }",
		"    BIND(COALESCE(?wfAuthorizationFlagCount, ?wfuiAuthorizationFlagCount) AS ?authorizationFlagCount)",
		"    OPTIONAL { ?decision prov:value ?rationale }",
		"  }",
		"}",
		"ORDER BY DESC(?generatedAt)",
		`LIMIT ${safeLimit}`,
	].join("\n");
}

export function renderGardenPageTurnDecisionsMarkdown(list: GardenPageTurnDecisionList): string {
	const lines = [
		`# PageTurnDecision Objects - ${list.graphId}`,
		"",
		`Decisions: ${list.decisions.length}`,
		`Limit: ${list.limit}`,
	];
	if (list.decisions.length === 0) {
		lines.push(
			"",
			"No PageTurnDecision objects were found in this graph's user RDF. Generate or load a retained decision Turtle artifact first.",
		);
	} else {
		for (const [index, decision] of list.decisions.entries()) {
			const heading = [decision.workflowName, decision.fromPage].filter(Boolean).join(" / ") || decision.subject;
			lines.push("", `## ${index + 1}. ${heading}`);
			lines.push(`Subject: ${decision.subject}`);
			appendKey(lines, "Generated", decision.generatedAt);
			appendKey(lines, "Intent", decision.intent);
			appendKey(lines, "Readiness", decision.readiness);
			appendKey(lines, "Native suggested choice", decision.nativeSuggestedChoice);
			appendKey(lines, "Recommended route", routeLabel(decision.recommendedRoute, decision.recommendedRouteLabel));
			appendKey(lines, "Recommended choice", decision.recommendedChoice);
			appendKey(lines, "Followed route", routeLabel(decision.followedRoute, decision.followedRouteLabel));
			appendKey(lines, "Followed choice", choiceLabel(decision.followedChoice, decision.followedChoiceLabel));
			lines.push(`Execution authorized: ${decision.executionAuthorized === true ? "true" : "false"}`);
			if (decision.authorizationFlagCount !== undefined) {
				lines.push(`Authorization flags: ${decision.authorizationFlagCount}`);
			}
			appendKey(lines, "Rationale", decision.rationale);
		}
	}
	lines.push("", "## Raw SPARQL", "", "```sparql", list.query, "```");
	return `${lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()}\n`;
}

export async function gardenPageTurnDecisionDetail(
	caller: GardenMcpCaller,
	options: { graphId: string; subject: string },
): Promise<GardenPageTurnDecisionDetail> {
	const subject = normalizeIri(options.subject);
	const query = gardenPageTurnDecisionDetailQuery(options.graphId, subject);
	const result = await caller.callTool("sparql_query", { graphId: options.graphId, query });
	return pageTurnDecisionDetailFromRows(options.graphId, subject, query, sparqlRows(result));
}

export async function gardenPageTurnDecisionLaunch(
	caller: GardenMcpCaller,
	options: GardenPageTurnDecisionLaunchOptions,
): Promise<unknown> {
	const trail = await callGardenWorkflowAuthoringSession(caller, {
		graphId: options.graphId,
		operation: "status",
		workflowName: options.workflowName,
		pageId: "decision-trail",
		handoffIntent: options.handoffIntent,
	});
	const selection = gardenPageTurnDecisionLaunchSelection(trail, options.subject);
	return callGardenWorkflowAuthoringSession(caller, {
		graphId: options.graphId,
		operation: "choose",
		workflowName: options.workflowName,
		pageId: "decision-trail",
		choiceId: selection.launchChoiceId,
		handoffIntent: options.handoffIntent,
	});
}

export async function gardenWorkflowAdventureDetail(
	caller: GardenMcpCaller,
	options: { graphId: string; workflowName?: string; subject?: string },
): Promise<unknown> {
	const trail = await callGardenWorkflowAuthoringSession(caller, {
		graphId: options.graphId,
		operation: "status",
		workflowName: options.workflowName,
		pageId: "adventure-trail",
	});
	const selection = gardenWorkflowAdventureDetailSelection(trail, options.subject);
	return callGardenWorkflowAuthoringSession(caller, {
		graphId: options.graphId,
		operation: "choose",
		workflowName: options.workflowName,
		pageId: "adventure-trail",
		choiceId: selection.detailChoiceId,
	});
}

export function gardenWorkflowAdventureDetailSelection(
	trailSession: unknown,
	subject?: string,
): GardenWorkflowAdventureDetailSelection {
	const parts = workflowSessionParts(trailSession);
	if (parts.pageKind !== "adventureTrail") {
		throw new Error(`expected Garden adventure-trail page, got ${parts.pageKind ?? "unknown"}`);
	}
	const wantedSubject = subject ? normalizeIri(subject) : undefined;
	const items = parts.sections
		.filter((section) => stringValue(section.id) === "workflowAdventures")
		.flatMap((section) => arrayValue(section.items))
		.map(asRecord)
		.filter((item): item is Record<string, unknown> => item !== undefined);
	const item = wantedSubject ? items.find((candidate) => stringValue(candidate.subject) === wantedSubject) : items[0];
	const detailChoiceId = stringValue(item?.choiceId) ?? firstAdventureChoiceId(parts.choices);
	if (!detailChoiceId) {
		const qualifier = wantedSubject ? ` for ${wantedSubject}` : "";
		throw new Error(`Garden adventure-trail has no adventure detail choice${qualifier}`);
	}
	return compactRecord({
		subject: stringValue(item?.subject) ?? wantedSubject,
		detailChoiceId,
		detailPageId: stringValue(item?.pageIdForBook),
	});
}

function firstAdventureChoiceId(choices: Record<string, unknown>[]): string | undefined {
	return choices.map((choice) => stringValue(choice.id)).find((id) => id?.startsWith("open-adventure-"));
}

export function gardenPageTurnDecisionLaunchSelection(
	trailSession: unknown,
	subject?: string,
): GardenPageTurnDecisionLaunchSelection {
	const parts = workflowSessionParts(trailSession);
	if (parts.pageKind !== "decisionTrail") {
		throw new Error(`expected Garden decision-trail page, got ${parts.pageKind ?? "unknown"}`);
	}
	const wantedSubject = subject ? normalizeIri(subject) : undefined;
	const items = parts.sections
		.filter((section) => stringValue(section.id) === "pageTurnDecisions")
		.flatMap((section) => arrayValue(section.items))
		.map(asRecord)
		.filter((item): item is Record<string, unknown> => item !== undefined);
	const item = wantedSubject ? items.find((candidate) => stringValue(candidate.subject) === wantedSubject) : items[0];
	const launchChoiceId =
		stringValue(item?.launchChoiceId) ??
		launchChoiceFromOpenChoice(stringValue(item?.choiceId)) ??
		firstLaunchChoiceId(parts.choices);
	if (!launchChoiceId) {
		const qualifier = wantedSubject ? ` for ${wantedSubject}` : "";
		throw new Error(`Garden decision-trail has no launch choice${qualifier}`);
	}
	return compactRecord({
		subject: stringValue(item?.subject) ?? wantedSubject,
		launchChoiceId,
		launchPageId: stringValue(item?.launchPageId),
	});
}

function launchChoiceFromOpenChoice(choiceId: string | undefined): string | undefined {
	const suffix = choiceId?.match(/^open-decision-(\d+)$/)?.[1];
	return suffix ? `launch-decision-${suffix}` : undefined;
}

function firstLaunchChoiceId(choices: Record<string, unknown>[]): string | undefined {
	return choices.map((choice) => stringValue(choice.id)).find((id) => id?.startsWith("launch-decision-"));
}

export function gardenPageTurnDecisionDetailQuery(graphId: string, subject: string): string {
	const decision = sparqlIri(normalizeIri(subject));
	return [
		"PREFIX wf: <http://mnemosyne.dev/workflow#>",
		"PREFIX wfui: <https://sophia-labs.com/ns/workflow-ui#>",
		"PREFIX prov: <http://www.w3.org/ns/prov#>",
		"PREFIX dcterms: <http://purl.org/dc/terms/>",
		"SELECT ?decision ?generatedAt ?graphId ?workflowName ?fromPage ?intent ?readiness ?nativeSuggestedChoice ?recommendedRoute ?recommendedRouteLabel ?recommendedChoice ?followedRoute ?followedRouteLabel ?followedChoice ?followedChoiceLabel ?executionAuthorized ?authorizationFlagCount ?rationale ?evidence ?evidenceRole ?evidencePath ?navigationRoute ?routeId ?routeLabel ?routeKind ?routeIntent ?routeChoiceId ?routeChoiceLabel ?routeSource ?routeRationale ?routeActionJson ?routeAction ?routeActionTool ?routeActionKind ?routeCommandTemplate ?routeArgumentHash ?flag ?flagPageId ?flagChoiceId ?flagReason WHERE {",
		`  GRAPH <${userRdfGraphIri(graphId)}> {`,
		`    BIND(${decision} AS ?decision)`,
		"    ?decision a ?decisionType .",
		"    VALUES ?decisionType { wf:PageTurnDecision wfui:PageTurnDecision }",
		"    OPTIONAL { ?decision prov:generatedAtTime ?generatedAt }",
		"    OPTIONAL { ?decision wf:graphId ?wfGraphId }",
		"    OPTIONAL { ?decision wfui:graphId ?wfuiGraphId }",
		"    BIND(COALESCE(?wfGraphId, ?wfuiGraphId) AS ?graphId)",
		"    OPTIONAL { ?decision wf:workflowName ?wfWorkflowName }",
		"    OPTIONAL { ?decision wfui:workflowName ?wfuiWorkflowName }",
		"    BIND(COALESCE(?wfWorkflowName, ?wfuiWorkflowName) AS ?workflowName)",
		"    OPTIONAL { ?decision wf:fromPage ?wfFromPage }",
		"    OPTIONAL { ?decision wfui:fromPage ?wfuiFromPage }",
		"    BIND(COALESCE(?wfFromPage, ?wfuiFromPage) AS ?fromPage)",
		"    OPTIONAL { ?decision wf:intent ?wfIntent }",
		"    OPTIONAL { ?decision wfui:intent ?wfuiIntent }",
		"    BIND(COALESCE(?wfIntent, ?wfuiIntent) AS ?intent)",
		"    OPTIONAL { ?decision wf:readiness ?wfReadiness }",
		"    OPTIONAL { ?decision wfui:readiness ?wfuiReadiness }",
		"    BIND(COALESCE(?wfReadiness, ?wfuiReadiness) AS ?readiness)",
		"    OPTIONAL { ?decision wf:nativeSuggestedChoiceId ?wfNativeSuggestedChoice }",
		"    OPTIONAL { ?decision wfui:nativeSuggestedChoiceId ?wfuiNativeSuggestedChoice }",
		"    BIND(COALESCE(?wfNativeSuggestedChoice, ?wfuiNativeSuggestedChoice) AS ?nativeSuggestedChoice)",
		"    OPTIONAL { ?decision wf:recommendedRouteId ?wfRecommendedRoute }",
		"    OPTIONAL { ?decision wfui:recommendedRouteId ?wfuiRecommendedRoute }",
		"    BIND(COALESCE(?wfRecommendedRoute, ?wfuiRecommendedRoute) AS ?recommendedRoute)",
		"    OPTIONAL { ?decision wf:recommendedRouteLabel ?wfRecommendedRouteLabel }",
		"    OPTIONAL { ?decision wfui:recommendedRouteLabel ?wfuiRecommendedRouteLabel }",
		"    BIND(COALESCE(?wfRecommendedRouteLabel, ?wfuiRecommendedRouteLabel) AS ?recommendedRouteLabel)",
		"    OPTIONAL { ?decision wf:recommendedChoiceId ?wfRecommendedChoice }",
		"    OPTIONAL { ?decision wfui:recommendedChoiceId ?wfuiRecommendedChoice }",
		"    BIND(COALESCE(?wfRecommendedChoice, ?wfuiRecommendedChoice) AS ?recommendedChoice)",
		"    OPTIONAL { ?decision wf:followedRouteId ?wfFollowedRoute }",
		"    OPTIONAL { ?decision wfui:followedRouteId ?wfuiFollowedRoute }",
		"    BIND(COALESCE(?wfFollowedRoute, ?wfuiFollowedRoute) AS ?followedRoute)",
		"    OPTIONAL { ?decision wf:followedRouteLabel ?wfFollowedRouteLabel }",
		"    OPTIONAL { ?decision wfui:followedRouteLabel ?wfuiFollowedRouteLabel }",
		"    BIND(COALESCE(?wfFollowedRouteLabel, ?wfuiFollowedRouteLabel) AS ?followedRouteLabel)",
		"    OPTIONAL { ?decision wf:followedChoiceId ?wfFollowedChoice }",
		"    OPTIONAL { ?decision wfui:followedChoiceId ?wfuiFollowedChoice }",
		"    BIND(COALESCE(?wfFollowedChoice, ?wfuiFollowedChoice) AS ?followedChoice)",
		"    OPTIONAL { ?decision wf:followedChoiceLabel ?wfFollowedChoiceLabel }",
		"    OPTIONAL { ?decision wfui:followedChoiceLabel ?wfuiFollowedChoiceLabel }",
		"    BIND(COALESCE(?wfFollowedChoiceLabel, ?wfuiFollowedChoiceLabel) AS ?followedChoiceLabel)",
		"    OPTIONAL { ?decision wf:executionAuthorized ?wfExecutionAuthorized }",
		"    OPTIONAL { ?decision wfui:executionAuthorized ?wfuiExecutionAuthorized }",
		"    BIND(COALESCE(?wfExecutionAuthorized, ?wfuiExecutionAuthorized) AS ?executionAuthorized)",
		"    OPTIONAL { ?decision wf:authorizationFlagCount ?wfAuthorizationFlagCount }",
		"    OPTIONAL { ?decision wfui:authorizationFlagCount ?wfuiAuthorizationFlagCount }",
		"    BIND(COALESCE(?wfAuthorizationFlagCount, ?wfuiAuthorizationFlagCount) AS ?authorizationFlagCount)",
		"    OPTIONAL { ?decision prov:value ?rationale }",
		"    OPTIONAL {",
		"      ?decision prov:wasDerivedFrom ?evidence .",
		"      OPTIONAL { ?evidence dcterms:identifier ?evidenceRole }",
		"      OPTIONAL { ?evidence wf:path ?wfEvidencePath }",
		"      OPTIONAL { ?evidence wfui:path ?wfuiEvidencePath }",
		"      BIND(COALESCE(?wfEvidencePath, ?wfuiEvidencePath) AS ?evidencePath)",
		"    }",
		"    OPTIONAL {",
		"      { ?decision wf:hasNavigationRoute ?navigationRoute . } UNION { ?decision wfui:hasNavigationRoute ?navigationRoute . }",
		"      OPTIONAL { ?navigationRoute wf:routeId ?wfRouteId }",
		"      OPTIONAL { ?navigationRoute wfui:routeId ?wfuiRouteId }",
		"      BIND(COALESCE(?wfRouteId, ?wfuiRouteId) AS ?routeId)",
		"      OPTIONAL { ?navigationRoute wf:routeLabel ?wfRouteLabel }",
		"      OPTIONAL { ?navigationRoute wfui:routeLabel ?wfuiRouteLabel }",
		"      BIND(COALESCE(?wfRouteLabel, ?wfuiRouteLabel) AS ?routeLabel)",
		"      OPTIONAL { ?navigationRoute wf:routeKind ?wfRouteKind }",
		"      OPTIONAL { ?navigationRoute wfui:routeKind ?wfuiRouteKind }",
		"      BIND(COALESCE(?wfRouteKind, ?wfuiRouteKind) AS ?routeKind)",
		"      OPTIONAL { ?navigationRoute wf:intent ?wfRouteIntent }",
		"      OPTIONAL { ?navigationRoute wfui:intent ?wfuiRouteIntent }",
		"      BIND(COALESCE(?wfRouteIntent, ?wfuiRouteIntent) AS ?routeIntent)",
		"      OPTIONAL { ?navigationRoute wf:choiceId ?wfRouteChoiceId }",
		"      OPTIONAL { ?navigationRoute wfui:choiceId ?wfuiRouteChoiceId }",
		"      BIND(COALESCE(?wfRouteChoiceId, ?wfuiRouteChoiceId) AS ?routeChoiceId)",
		"      OPTIONAL { ?navigationRoute wf:choiceLabel ?wfRouteChoiceLabel }",
		"      OPTIONAL { ?navigationRoute wfui:choiceLabel ?wfuiRouteChoiceLabel }",
		"      BIND(COALESCE(?wfRouteChoiceLabel, ?wfuiRouteChoiceLabel) AS ?routeChoiceLabel)",
		"      OPTIONAL { ?navigationRoute wf:source ?wfRouteSource }",
		"      OPTIONAL { ?navigationRoute wfui:source ?wfuiRouteSource }",
		"      BIND(COALESCE(?wfRouteSource, ?wfuiRouteSource) AS ?routeSource)",
		"      OPTIONAL { ?navigationRoute wf:rationale ?wfRouteRationale }",
		"      OPTIONAL { ?navigationRoute wfui:rationale ?wfuiRouteRationale }",
		"      BIND(COALESCE(?wfRouteRationale, ?wfuiRouteRationale) AS ?routeRationale)",
		"      OPTIONAL { ?navigationRoute wfui:actionJson ?routeActionJson }",
		"      OPTIONAL {",
		"        ?navigationRoute wf:routeAction ?routeAction .",
		"        OPTIONAL { ?routeAction wf:actionTool ?routeActionTool }",
		"        OPTIONAL { ?routeAction wf:actionKind ?routeActionKind }",
		"        OPTIONAL { ?routeAction wf:commandTemplate ?routeCommandTemplate }",
		"        OPTIONAL { ?routeAction wf:argumentHash ?routeArgumentHash }",
		"      }",
		"    }",
		"    OPTIONAL {",
		"      { ?decision wf:hasAuthorizationFlag ?flag . } UNION { ?decision wfui:hasAuthorizationFlag ?flag . }",
		"      OPTIONAL { ?flag wf:pageId ?wfFlagPageId }",
		"      OPTIONAL { ?flag wfui:pageId ?wfuiFlagPageId }",
		"      BIND(COALESCE(?wfFlagPageId, ?wfuiFlagPageId) AS ?flagPageId)",
		"      OPTIONAL { ?flag wf:choiceId ?wfFlagChoiceId }",
		"      OPTIONAL { ?flag wfui:choiceId ?wfuiFlagChoiceId }",
		"      BIND(COALESCE(?wfFlagChoiceId, ?wfuiFlagChoiceId) AS ?flagChoiceId)",
		"      OPTIONAL { ?flag wf:authorizationReason ?wfFlagReason }",
		"      OPTIONAL { ?flag wfui:authorizationReason ?wfuiFlagReason }",
		"      BIND(COALESCE(?wfFlagReason, ?wfuiFlagReason) AS ?flagReason)",
		"    }",
		"  }",
		"}",
		"ORDER BY ?evidenceRole ?routeId ?flagPageId ?flagChoiceId",
	].join("\n");
}

export function renderGardenPageTurnDecisionDetailMarkdown(detail: GardenPageTurnDecisionDetail): string {
	const decision = detail.decision;
	const title =
		decision && [decision.workflowName, decision.fromPage].filter(Boolean).length > 0
			? [decision.workflowName, decision.fromPage].filter(Boolean).join(" / ")
			: detail.subject;
	const lines = [`# PageTurnDecision - ${title}`, "", `Subject: ${detail.subject}`];
	if (!decision) {
		lines.push("", "No PageTurnDecision object was found for this subject in the graph's user RDF.");
	} else {
		appendKey(lines, "Generated", decision.generatedAt);
		appendKey(lines, "Intent", decision.intent);
		appendKey(lines, "Readiness", decision.readiness);
		appendKey(lines, "Native suggested choice", decision.nativeSuggestedChoice);
		appendKey(lines, "Recommended route", routeLabel(decision.recommendedRoute, decision.recommendedRouteLabel));
		appendKey(lines, "Recommended choice", decision.recommendedChoice);
		appendKey(lines, "Followed route", routeLabel(decision.followedRoute, decision.followedRouteLabel));
		appendKey(lines, "Followed choice", choiceLabel(decision.followedChoice, decision.followedChoiceLabel));
		lines.push(`Execution authorized: ${decision.executionAuthorized === true ? "true" : "false"}`);
		if (decision.authorizationFlagCount !== undefined) {
			lines.push(`Authorization flags declared: ${decision.authorizationFlagCount}`);
		}
		appendKey(lines, "Rationale", decision.rationale);
	}
	if (detail.evidence.length > 0) {
		lines.push("", "## Evidence");
		for (const evidence of detail.evidence) {
			lines.push(`- ${evidence.role ?? evidence.subject}${evidence.path ? `: ${evidence.path}` : ""}`);
		}
	}
	if (detail.navigationRoutes.length > 0) {
		lines.push("", "## Navigation Routes");
		for (const route of detail.navigationRoutes) {
			const label = routeLabel(route.routeId, route.routeLabel) ?? route.subject;
			const choice = route.choiceId
				? ` -> ${route.choiceId}${route.choiceLabel ? ` (${route.choiceLabel})` : ""}`
				: "";
			lines.push(
				`- ${label}${route.routeKind ? ` [${route.routeKind}]` : ""}${choice}${route.rationale ? ` - ${route.rationale}` : ""}`,
			);
		}
	}
	if (detail.authorizationFlags.length > 0) {
		lines.push("", "## Authorization Flags");
		for (const flag of detail.authorizationFlags) {
			const label = [flag.pageId, flag.choiceId].filter(Boolean).join(" / ") || flag.subject;
			lines.push(`- ${label}${flag.reason ? ` - ${flag.reason}` : ""}`);
		}
	}
	lines.push("", "## Raw SPARQL", "", "```sparql", detail.query, "```");
	return `${lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()}\n`;
}

export function gardenWorkflowSessionArguments(request: GardenWorkflowSessionRequest): Record<string, unknown> {
	return {
		graphId: request.graphId,
		operation: request.operation,
		...(request.workflowName !== undefined ? { workflowName: request.workflowName } : {}),
		...(request.pageId !== undefined ? { pageId: request.pageId } : {}),
		...(request.choiceId !== undefined ? { choiceId: request.choiceId } : {}),
		...(request.mode !== undefined ? { mode: request.mode } : {}),
		...(request.runId !== undefined ? { runId: request.runId } : {}),
		...(request.since !== undefined ? { since: request.since } : {}),
		...(request.pollMs !== undefined ? { pollMs: request.pollMs } : {}),
		...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
		...(request.maxTicks !== undefined ? { maxTicks: request.maxTicks } : {}),
		...(request.includeEvents !== undefined ? { includeEvents: request.includeEvents } : {}),
		...(request.monitorLatest !== undefined ? { monitorLatest: request.monitorLatest } : {}),
		...(request.resolveOnChange !== undefined ? { resolveOnChange: request.resolveOnChange } : {}),
		...(request.executionChoiceId !== undefined ? { executionChoiceId: request.executionChoiceId } : {}),
		...(request.handoffIntent !== undefined ? { handoffIntent: request.handoffIntent } : {}),
	};
}

export async function composeGardenWorkflowDraft(
	caller: GardenMcpCaller,
	request: ComposeGardenWorkflowDraftRequest,
	options: { startValidationWatch?: boolean } = {},
): Promise<ComposeGardenWorkflowDraftResult> {
	const workflowName = request.workflowName ?? request.meta.name;
	if (workflowName !== request.meta.name) {
		throw new Error(`workflowName '${workflowName}' does not match meta.name '${request.meta.name}'`);
	}
	const source = request.source;
	const scriptSha256 = createHash("sha256").update(source).digest("hex");
	let sourceWrite: unknown;
	let sourceBlock = request.sourceBlock;
	if (!sourceBlock) {
		const written = await writeGardenBlock(caller, {
			graphId: request.graphId,
			documentId: request.sourceDocumentId ?? `${slug(workflowName)}-workflow-source`,
			content: fenced(source, "js"),
		});
		sourceWrite = written.writeResult;
		sourceBlock = { documentId: written.documentId, blockId: written.blockId };
	}
	let inputWrite: unknown;
	let inputBlock = request.inputBlock;
	if (!inputBlock && request.workflowArgs !== undefined) {
		const written = await writeGardenBlock(caller, {
			graphId: request.graphId,
			documentId: request.inputDocumentId ?? `${slug(workflowName)}-workflow-input`,
			content: fenced(JSON.stringify(request.workflowArgs, null, 2), "json"),
		});
		inputWrite = written.writeResult;
		inputBlock = { documentId: written.documentId, blockId: written.blockId };
	}
	const plan = gardenWorkflowDraftPlan({
		meta: request.meta,
		sourceBlock,
		inputBlock,
		scriptSha256,
		agentNodes: request.agentNodes,
	});
	const draft = await caller.callTool("workflow_authoring_session", {
		graphId: request.graphId,
		operation: "draft",
		workflowName,
		pageId: request.pageId ?? "execute",
		moves: plan.moves,
	});
	const validationWatch = options.startValidationWatch
		? await startGardenWorkflowValidationWatch(caller, {
				graphId: request.graphId,
				workflowName,
				pageId: request.pageId ?? "overview",
			})
		: undefined;
	return {
		plan,
		sourceWrite,
		inputWrite,
		draft,
		validationWatch,
	};
}

export function gardenWorkflowDraftPlan(input: {
	meta: WorkflowMeta;
	sourceBlock: GardenWorkflowBlockRef;
	inputBlock?: GardenWorkflowBlockRef;
	scriptSha256: string;
	agentNodes?: GardenWorkflowDraftAgentNode[];
}): GardenWorkflowDraftPlan {
	const workflowName = input.meta.name;
	const agentNodes = normalizeDraftAgentNodes(input.agentNodes);
	const moves: GardenWorkflowDraftMove[] = [
		{
			operation: "create_workflow",
			description: input.meta.description ?? `Workflow ${workflowName}.`,
			whenToUse: input.meta.whenToUse,
			sourceDocumentId: input.sourceBlock.documentId,
			sourceBlockId: input.sourceBlock.blockId,
			scriptSha256: input.scriptSha256,
		},
		...(input.meta.phases ?? []).map((phase, index) => ({
			operation: "add_phase" as const,
			phaseOrder: index + 1,
			phaseTitle: phase.title,
			phaseDescription: phase.detail,
		})),
		...agentNodes.map((node) =>
			compactRecord({
				operation: "attach_agent_node" as const,
				label: node.label,
				phaseIndex: node.phaseIndex,
				agentType: node.agentType,
				documentId: node.documentId,
			}),
		),
	];
	if (input.inputBlock) {
		moves.push({
			operation: "bind_input_block",
			inputDocumentId: input.inputBlock.documentId,
			inputBlockId: input.inputBlock.blockId,
		});
	}
	return {
		workflowName,
		scriptSha256: input.scriptSha256,
		sourceBlock: input.sourceBlock,
		inputBlock: input.inputBlock,
		agentNodes,
		moves,
	};
}

function normalizeDraftAgentNodes(nodes: GardenWorkflowDraftAgentNode[] | undefined): GardenWorkflowDraftAgentNode[] {
	const seen = new Set<string>();
	const normalized: GardenWorkflowDraftAgentNode[] = [];
	for (const node of nodes ?? []) {
		const label = typeof node.label === "string" ? node.label.trim() : "";
		if (!label || seen.has(label)) continue;
		seen.add(label);
		normalized.push(
			compactRecord({
				label,
				phaseIndex:
					typeof node.phaseIndex === "number" && Number.isFinite(node.phaseIndex) && node.phaseIndex > 0
						? Math.trunc(node.phaseIndex)
						: undefined,
				agentType: typeof node.agentType === "string" && node.agentType.trim() ? node.agentType.trim() : undefined,
				documentId:
					typeof node.documentId === "string" && node.documentId.trim() ? node.documentId.trim() : undefined,
			}),
		);
	}
	return normalized;
}

export async function startGardenWorkflowValidationWatch(
	caller: GardenMcpCaller,
	request: GardenValidationWatchRequest,
): Promise<unknown> {
	return caller.callTool("workflow_authoring_session", {
		graphId: request.graphId,
		operation: "background",
		mode: "validate",
		workflowName: request.workflowName,
		pageId: request.pageId ?? "overview",
		...(request.pollMs !== undefined ? { pollMs: request.pollMs } : {}),
		...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
		...(request.maxTicks !== undefined ? { maxTicks: request.maxTicks } : {}),
		...(request.resolveOnChange !== undefined ? { resolveOnChange: request.resolveOnChange } : {}),
	});
}

export async function executeGardenWorkflowDraft(
	caller: GardenMcpCaller,
	request: { graphId: string; workflowName: string },
): Promise<unknown> {
	return caller.callTool("workflow_authoring_session", {
		graphId: request.graphId,
		workflowName: request.workflowName,
		operation: "execute",
	});
}

export async function backgroundAwaitGardenWorkflow(
	caller: GardenMcpCaller,
	request: {
		graphId: string;
		workflowName: string;
		pollMs?: number;
		timeoutMs?: number;
		maxTicks?: number;
	},
): Promise<unknown> {
	return caller.callTool("workflow_authoring_session", {
		graphId: request.graphId,
		workflowName: request.workflowName,
		operation: "background",
		mode: "await",
		pageId: "execute",
		...(request.pollMs !== undefined ? { pollMs: request.pollMs } : {}),
		...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
		...(request.maxTicks !== undefined ? { maxTicks: request.maxTicks } : {}),
	});
}

export function renderGardenWorkflowSessionMarkdown(session: unknown): string {
	const parts = workflowSessionParts(session);
	const { payload, draft, pageKind, workflowName, title } = parts;
	const lines = [workflowName ? `# ${workflowName} / ${title}` : `# ${title}`, ""];
	appendKey(lines, "Operation", parts.operation);
	appendKey(lines, "Status", parts.status);
	appendKey(lines, "Message", parts.message);
	appendKey(lines, "Summary", parts.summary);
	if (parts.validation) {
		const passed = parts.validation.passed;
		const summary = parts.validation.summary;
		lines.push(
			`Validation: ${typeof passed === "boolean" ? (passed ? "passed" : "failed") : "unknown"}${summary ? ` - ${summary}` : ""}`,
		);
	}
	if (parts.latestRun) {
		lines.push(`Latest run: ${[parts.latestRun.runId, parts.latestRun.status].filter(Boolean).join(" ")}`);
	}
	if (parts.scene) {
		lines.push("", "## Scene", parts.scene);
	}
	const facts = parts.facts.map(describeFact).filter(Boolean);
	if (facts.length > 0) {
		lines.push("", "## Facts", ...facts.map((fact) => `- ${fact}`));
	}
	const warnings = parts.warnings;
	if (warnings.length > 0) {
		lines.push("", "## Warnings", ...warnings.map((warning) => `- ${warning}`));
	}
	const objects = parts.objects.map(describeWorkflowObject).filter(Boolean);
	if (objects.length > 0) {
		lines.push("", "## Objects", ...objects.map((object) => `- ${object}`));
	}
	const routes = parts.navigationRoutes
		.map((route) => navigationRoutePacket(route))
		.filter((route): route is GardenWorkflowNavigationRoute => route !== undefined);
	if (routes.length > 0) {
		lines.push("", "## Routes", ...routes.map((route) => `- ${describeNavigationRoute(route)}`));
	}
	const recommendedNextAction = gardenWorkflowSessionChoicePacket(session).recommendedNextAction;
	if (recommendedNextAction) {
		lines.push("", "## Recommended Next Action", `Kind: ${recommendedNextAction.kind}`);
		if (recommendedNextAction.routeId) {
			lines.push(`Route: ${routeLabel(recommendedNextAction.routeId, recommendedNextAction.routeLabel)}`);
		}
		if (recommendedNextAction.choiceId) {
			lines.push(`Choice: ${choiceLabel(recommendedNextAction.choiceId, recommendedNextAction.choiceLabel)}`);
		}
		lines.push(`Source: ${recommendedNextAction.source}`);
		appendKey(lines, "Rationale", recommendedNextAction.rationale);
		if (recommendedNextAction.requiresExplicitAuthorization) {
			lines.push(
				`Authorization: required${recommendedNextAction.authorizationReason ? ` - ${recommendedNextAction.authorizationReason}` : ""}`,
			);
		}
		lines.push(`Command: \`${recommendedNextAction.commandTemplate}\``);
	}
	if (pageKind === "catalog") {
		for (const section of parts.sections) {
			const sectionTitle = stringValue(section.title) ?? stringValue(section.id) ?? "Section";
			const items = arrayValue(section.items).map(describeSectionItem).filter(Boolean);
			if (items.length > 0) {
				lines.push("", `## ${sectionTitle}`, ...items.map((item) => `- ${item}`));
			}
		}
	}
	if (parts.choices.length > 0) {
		lines.push("", "## Choices");
		for (const choice of parts.choices) {
			const id = stringValue(choice.id) ?? "choice";
			const label = stringValue(choice.label) ?? id;
			const description = stringValue(choice.description);
			const kind = stringValue(choice.kind);
			const target = stringValue(choice.targetPageId);
			const marker = parts.suggestedChoiceId === id ? "*" : "-";
			const suffix = [kind, target ? `-> ${target}` : undefined].filter(Boolean).join(" ");
			lines.push(
				`${marker} ${id}: ${label}${suffix ? ` (${suffix})` : ""}${description ? ` - ${description}` : ""}`,
			);
		}
	}
	const nextActions = collectNextActionPackets(payload, draft).map((action) => action.text);
	if (nextActions.length > 0) {
		lines.push("", "## Next Actions", ...nextActions.map((action) => `- ${action}`));
	}
	return `${lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()}\n`;
}

export function gardenWorkflowSessionChoicePacket(session: unknown): GardenWorkflowChoicePacket {
	const parts = workflowSessionParts(session);
	const choices = parts.choices.map((choice) => choicePacket(choice, parts.suggestedChoiceId));
	const intentRecommendation = intentRecommendationPacket(parts.intentRecommendation, choices);
	const navigationRoutes = parts.navigationRoutes
		.map((route) => navigationRoutePacket(route, choices))
		.filter((route): route is GardenWorkflowNavigationRoute => route !== undefined);
	const nextActions = collectNextActionPackets(parts.payload, parts.draft);
	return compactRecord({
		kind: "gardenWorkflowChoicePacket" as const,
		operation: parts.operation,
		graphId: parts.graphId,
		workflowName: parts.workflowName,
		page: compactRecord({
			id: parts.pageId,
			title: parts.title,
			kind: parts.pageKind,
			summary: parts.summary,
			scene: parts.scene,
		}),
		status: parts.status,
		message: parts.message,
		validation: parts.validation,
		latestRun: parts.latestRun,
		facts: parts.facts.map(factPacket).filter((fact): fact is GardenWorkflowPacketFact => fact !== undefined),
		warnings: parts.warnings,
		objects: parts.objects
			.map(objectPacket)
			.filter((object): object is GardenWorkflowPacketObject => object !== undefined),
		sections: parts.sections
			.map(sectionPacket)
			.filter((section): section is GardenWorkflowPacketSection => section !== undefined),
		choices,
		suggestedChoice: choices.find((choice) => choice.suggested),
		intentRecommendation,
		navigationRoutes: navigationRoutes.length > 0 ? navigationRoutes : undefined,
		recommendedNextAction: recommendedNextActionPacket({
			graphId: parts.graphId,
			workflowName: parts.workflowName,
			pageId: parts.pageId,
			choices,
			suggestedChoice: choices.find((choice) => choice.suggested),
			intentRecommendation,
			navigationRoutes,
			nextActions,
		}),
		nextActions,
	});
}

export function gardenWorkflowFollowSuggestedCommand(
	packet: unknown,
	options: GardenWorkflowFollowCommandOptions = {},
): string {
	const parsed = workflowChoicePacketRecord(packet);
	const recommended = recommendedNextActionRecord(parsed.recommendedNextAction);
	if (recommended) {
		return recommendedNextActionCommand(parsed, recommended, options);
	}
	const suggestedChoice = asRecord(parsed.suggestedChoice);
	if (suggestedChoice) {
		const choiceId = stringValue(suggestedChoice.id);
		if (!choiceId) throw new Error("choice packet suggestedChoice is missing id");
		return gardenWorkflowChoiceCommand(parsed, choiceId, options);
	}
	const commandPrefix = options.commandPrefix ?? ["pnpm", "exec", "tsx", "scripts/workflow-garden-session.ts"];
	const nextAction = arrayValue(parsed.nextActions).map(asRecord).find(Boolean);
	if (nextAction) {
		return nextActionCommand(nextAction, commandPrefix, options);
	}
	throw new Error("choice packet has no suggestedChoice or nextActions");
}

export function gardenWorkflowRecommendedRouteId(packet: unknown): string | undefined {
	const parsed = workflowChoicePacketRecord(packet);
	const recommended = recommendedNextActionRecord(parsed.recommendedNextAction);
	return stringValue(recommended?.kind) === "accept-route" ? stringValue(recommended?.routeId) : undefined;
}

export function gardenWorkflowChoiceCommand(
	packet: unknown,
	choiceId: string,
	options: GardenWorkflowFollowCommandOptions = {},
): string {
	const parsed = workflowChoicePacketRecord(packet);
	const choices = arrayValue(parsed.choices)
		.map(packetChoiceRecord)
		.filter((choice): choice is GardenWorkflowPacketChoice => choice !== undefined);
	if (!choices.some((choice) => choice.id === choiceId)) {
		throw new Error(`choice packet does not contain choice '${choiceId}'`);
	}
	const commandPrefix = options.commandPrefix ?? ["pnpm", "exec", "tsx", "scripts/workflow-garden-session.ts"];
	const page = asRecord(parsed.page) ?? {};
	const graphId = stringValue(parsed.graphId);
	const args = [
		...commandPrefix,
		"choose",
		...requiredFlag("--graph", graphId, "choice packet graphId is required"),
		...optionalFlag("--workflow", stringValue(parsed.workflowName)),
		...requiredFlag("--page", stringValue(page.id), "choice packet page.id is required"),
		"--choice",
		choiceId,
		...optionalFlag("--handoff-intent", options.handoffIntent),
		...sessionConnectionFlags(options),
		...outputFlags(options.output),
	];
	return shellCommand(args);
}

function recommendedNextActionCommand(
	packet: Record<string, unknown>,
	recommended: Record<string, unknown>,
	options: GardenWorkflowFollowCommandOptions,
): string {
	const kind = stringValue(recommended.kind);
	if (kind === "accept-route") {
		const routeId = requiredValue(stringValue(recommended.routeId), "recommended next action is missing routeId");
		if (options.packetFile) {
			const commandPrefix = options.commandPrefix ?? workflowSessionCommandPrefix();
			return shellCommand([
				...commandPrefix,
				"accept-route",
				"--packet-file",
				options.packetFile,
				"--route",
				routeId,
				...sessionConnectionFlags(options),
				...outputFlags(options.output),
			]);
		}
		return gardenWorkflowRouteCommand(packet, routeId, options);
	}
	if (kind === "choose") {
		return gardenWorkflowChoiceCommand(
			packet,
			requiredValue(stringValue(recommended.choiceId), "recommended next action is missing choiceId"),
			options,
		);
	}
	if (kind === "tool-action") {
		const action = asRecord(recommended.action);
		if (!action) throw new Error("recommended next action is missing tool action");
		const commandPrefix = options.commandPrefix ?? workflowSessionCommandPrefix();
		return nextActionCommand(action, commandPrefix, options);
	}
	throw new Error(`unsupported recommended next action kind: ${kind ?? "unknown"}`);
}

export function gardenWorkflowRouteCommand(
	packet: unknown,
	routeId: string,
	options: GardenWorkflowFollowCommandOptions = {},
): string {
	const parsed = workflowChoicePacketRecord(packet);
	const route = workflowRoutePacket(parsed, routeId);
	const commandPrefix = options.commandPrefix ?? ["pnpm", "exec", "tsx", "scripts/workflow-garden-session.ts"];
	const page = asRecord(parsed.page) ?? {};
	const actionArgs = route.action?.arguments ?? {};
	const graphId = stringValue(actionArgs.graphId) ?? stringValue(parsed.graphId);
	const handoffIntent = options.handoffIntent ?? routeActionIntent(route);
	const args = [
		...commandPrefix,
		"route",
		...requiredFlag("--graph", graphId, "choice packet graphId is required"),
		...optionalFlag("--workflow", stringValue(actionArgs.workflowName) ?? stringValue(parsed.workflowName)),
		...requiredFlag(
			"--page",
			stringValue(actionArgs.pageId) ?? stringValue(page.id),
			"choice packet page.id is required",
		),
		"--route",
		route.id,
		...optionalFlag("--handoff-intent", handoffIntent),
		...sessionConnectionFlags(options),
		...outputFlags(options.output),
	];
	return shellCommand(args);
}

export function gardenWorkflowSuggestedSessionRequest(packet: unknown): GardenWorkflowSessionRequest {
	const parsed = workflowChoicePacketRecord(packet);
	const recommended = recommendedNextActionRecord(parsed.recommendedNextAction);
	if (recommended) {
		return recommendedNextActionSessionRequest(parsed, recommended);
	}
	const suggestedChoice = asRecord(parsed.suggestedChoice);
	const page = asRecord(parsed.page) ?? {};
	const graphId = stringValue(parsed.graphId);
	if (suggestedChoice) {
		const choiceId = stringValue(suggestedChoice.id);
		if (!choiceId) throw new Error("choice packet suggestedChoice is missing id");
		return compactRecord({
			graphId: requiredValue(graphId, "choice packet graphId is required"),
			operation: "choose",
			workflowName: stringValue(parsed.workflowName),
			pageId: requiredValue(stringValue(page.id), "choice packet page.id is required"),
			choiceId,
			handoffIntent: packetHandoffIntent(parsed),
		});
	}
	const nextAction = arrayValue(parsed.nextActions).map(asRecord).find(Boolean);
	if (nextAction) {
		return nextActionSessionRequest(nextAction);
	}
	throw new Error("choice packet has no suggestedChoice or nextActions");
}

function recommendedNextActionSessionRequest(
	packet: Record<string, unknown>,
	recommended: Record<string, unknown>,
): GardenWorkflowSessionRequest {
	const kind = stringValue(recommended.kind);
	if (kind === "accept-route") {
		return gardenWorkflowRouteSessionRequest(
			packet,
			requiredValue(stringValue(recommended.routeId), "recommended next action is missing routeId"),
		);
	}
	if (kind === "choose") {
		const page = asRecord(packet.page) ?? {};
		const graphId = stringValue(packet.graphId);
		return compactRecord({
			graphId: requiredValue(graphId, "choice packet graphId is required"),
			operation: "choose" as const,
			workflowName: stringValue(packet.workflowName),
			pageId: requiredValue(stringValue(page.id), "choice packet page.id is required"),
			choiceId: requiredValue(stringValue(recommended.choiceId), "recommended next action is missing choiceId"),
			handoffIntent: packetHandoffIntent(packet),
		});
	}
	if (kind === "tool-action") {
		const action = asRecord(recommended.action);
		if (!action) throw new Error("recommended next action is missing tool action");
		return nextActionSessionRequest(action);
	}
	throw new Error(`unsupported recommended next action kind: ${kind ?? "unknown"}`);
}

export function gardenWorkflowRouteSessionRequest(packet: unknown, routeId: string): GardenWorkflowSessionRequest {
	const parsed = workflowChoicePacketRecord(packet);
	const route = workflowRoutePacket(parsed, routeId);
	const page = asRecord(parsed.page) ?? {};
	const actionArgs = route.action?.arguments ?? {};
	return compactRecord({
		graphId: requiredValue(
			stringValue(actionArgs.graphId) ?? stringValue(parsed.graphId),
			"route action graphId is required",
		),
		operation: "choose" as const,
		workflowName: stringValue(actionArgs.workflowName) ?? stringValue(parsed.workflowName),
		pageId: requiredValue(stringValue(actionArgs.pageId) ?? stringValue(page.id), "route action pageId is required"),
		choiceId: requiredValue(stringValue(actionArgs.choiceId) ?? route.choiceId, "route action choiceId is required"),
		handoffIntent: routeActionIntent(route),
	});
}

function packetHandoffIntent(packet: Record<string, unknown>): GardenWorkflowHandoffIntent | undefined {
	const intent = stringValue(asRecord(packet.intentRecommendation)?.intent);
	if (intent === "analysis-scout" || intent === "run-prep") return intent;
	return undefined;
}

export function gardenWorkflowTranscriptEntry(
	packet: unknown,
	options: GardenWorkflowTranscriptEntryOptions = {},
): GardenWorkflowTranscriptEntry {
	const packetRecord = workflowChoicePacketRecord(packet);
	const resultPacketRecord = options.resultPacket ? workflowChoicePacketRecord(options.resultPacket) : undefined;
	const decision = options.decision ?? "previewed";
	const command =
		options.command ??
		(decision === "observed"
			? undefined
			: options.routeId
				? gardenWorkflowRouteCommand(packetRecord, options.routeId, options.followOptions)
				: gardenWorkflowFollowSuggestedCommand(packetRecord, options.followOptions));
	return compactRecord({
		kind: "gardenWorkflowTranscriptEntry" as const,
		schemaVersion: 1 as const,
		recordedAt: options.recordedAt ?? new Date().toISOString(),
		decision,
		command,
		note: options.note,
		packet: packetRecord,
		resultPacket: resultPacketRecord,
		summary: transcriptSummary(packetRecord, resultPacketRecord, options.routeId),
	});
}

export function parseGardenWorkflowTranscriptJsonl(text: string): GardenWorkflowTranscriptEntry[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line, index) => {
			const parsed = JSON.parse(line);
			const entry = asRecord(parsed);
			if (!entry || entry.kind !== "gardenWorkflowTranscriptEntry") {
				throw new Error(`transcript line ${index + 1} is not a gardenWorkflowTranscriptEntry`);
			}
			return parsed as GardenWorkflowTranscriptEntry;
		});
}

export function gardenWorkflowTranscriptHandoff(
	entries: GardenWorkflowTranscriptEntry[],
	options: GardenWorkflowTranscriptHandoffOptions = {},
): GardenWorkflowTranscriptHandoff {
	const currentPacket = currentTranscriptPacket(entries);
	const currentPage = asRecord(currentPacket?.page) ?? {};
	const currentSuggestedChoice = asRecord(currentPacket?.suggestedChoice);
	const latestRun = asRecord(currentPacket?.latestRun);
	const currentChoiceList = currentPacket ? currentChoices(currentPacket) : [];
	const nextChoice = currentPacket ? handoffNextChoice(currentPacket, currentChoiceList, options) : undefined;
	const nextRoute =
		currentPacket && nextChoice ? routeForChoice(currentPacket, nextChoice.choice.id, options.intent) : undefined;
	const nextCommand = currentPacket
		? nextChoice
			? nextRoute
				? (tryRouteCommand(currentPacket, nextRoute.id, options.intent) ??
					tryChoiceCommand(currentPacket, nextChoice.choice.id, options.intent))
				: tryChoiceCommand(currentPacket, nextChoice.choice.id, options.intent)
			: tryFollowCommand(currentPacket)
		: undefined;
	return {
		kind: "gardenWorkflowTranscriptHandoff",
		schemaVersion: 1,
		generatedAt: options.generatedAt ?? new Date().toISOString(),
		title: options.title ?? handoffTitle(currentPacket, entries),
		...(options.transcriptPath ? { transcriptPath: options.transcriptPath } : {}),
		entryCount: entries.length,
		decisionCounts: transcriptDecisionCounts(entries),
		current: currentPacket
			? compactRecord({
					graphId: stringValue(currentPacket.graphId),
					workflowName: stringValue(currentPacket.workflowName),
					pageId: stringValue(currentPage.id),
					pageTitle: stringValue(currentPage.title),
					status: stringValue(currentPacket.status),
					suggestedChoiceId: stringValue(currentSuggestedChoice?.id),
					suggestedChoiceLabel: stringValue(currentSuggestedChoice?.label),
					latestRunId: stringValue(latestRun?.runId),
					latestRunStatus: stringValue(latestRun?.status),
				})
			: undefined,
		path: entries.map((entry, index) =>
			compactRecord({
				index: index + 1,
				recordedAt: entry.recordedAt,
				decision: entry.decision,
				pageId: entry.summary.pageId,
				pageTitle: entry.summary.pageTitle,
				status: entry.summary.status,
				suggestedChoiceId: entry.summary.suggestedChoiceId,
				suggestedChoiceLabel: entry.summary.suggestedChoiceLabel,
				recommendedRouteId: entry.summary.recommendedRouteId,
				recommendedRouteLabel: entry.summary.recommendedRouteLabel,
				followedRouteId: entry.summary.followedRouteId,
				followedRouteLabel: entry.summary.followedRouteLabel,
				followedRouteChoiceId: entry.summary.followedRouteChoiceId,
				followedRouteChoiceLabel: entry.summary.followedRouteChoiceLabel,
				resultPageId: entry.summary.resultPageId,
				resultStatus: entry.summary.resultStatus,
				command: entry.command,
				note: entry.note,
			}),
		),
		currentFacts: currentPacket ? currentFacts(currentPacket) : [],
		currentWarnings: currentPacket ? currentWarnings(currentPacket) : [],
		currentObjects: currentPacket ? currentObjects(currentPacket) : [],
		currentSections: currentPacket ? currentSections(currentPacket) : [],
		currentRoutes: currentPacket ? currentRoutes(currentPacket) : [],
		currentChoices: currentChoiceList,
		...(currentPacket && nextChoice
			? {
					suggestedNext: compactRecord({
						routeId: nextRoute?.id,
						routeLabel: nextRoute?.label,
						choiceId: nextChoice.choice.id,
						label: nextChoice.choice.label,
						kind: nextChoice.choice.kind,
						targetPageId: nextChoice.choice.targetPageId,
						source: nextChoice.source,
						rationale:
							nextChoice.rationale ??
							handoffNextRationale(currentPacket, nextChoice.choice, nextChoice.source, options.intent),
						expectedNextPage: expectedNextPage(nextChoice.choice),
						safetyBoundary: suggestedNextSafetyBoundary(nextChoice.choice),
					}),
				}
			: {}),
		nextActions: currentPacket ? currentNextActions(currentPacket) : [],
		...(nextCommand ? { nextCommand } : {}),
	};
}

export function renderGardenWorkflowTranscriptHandoffMarkdown(handoff: GardenWorkflowTranscriptHandoff): string {
	const lines = [`# ${handoff.title}`, ""];
	lines.push(`Generated: ${handoff.generatedAt}`);
	if (handoff.transcriptPath) lines.push(`Transcript: ${handoff.transcriptPath}`);
	lines.push(`Entries: ${handoff.entryCount}`);
	const decisions = Object.entries(handoff.decisionCounts)
		.map(([decision, count]) => `${decision}=${count}`)
		.join(" ");
	if (decisions) lines.push(`Decisions: ${decisions}`);
	if (handoff.current) {
		lines.push("", "## Current Page");
		appendKey(lines, "Graph", handoff.current.graphId);
		appendKey(lines, "Workflow", handoff.current.workflowName);
		appendKey(lines, "Page", [handoff.current.pageId, handoff.current.pageTitle].filter(Boolean).join(" - "));
		appendKey(lines, "Status", handoff.current.status);
		if (handoff.current.latestRunId || handoff.current.latestRunStatus) {
			lines.push(
				`Latest run: ${[handoff.current.latestRunId, handoff.current.latestRunStatus].filter(Boolean).join(" ")}`,
			);
		}
		if (handoff.current.suggestedChoiceId || handoff.current.suggestedChoiceLabel) {
			lines.push(
				`Suggested: ${[handoff.current.suggestedChoiceId, handoff.current.suggestedChoiceLabel]
					.filter(Boolean)
					.join(" - ")}`,
			);
		}
	}
	if (handoff.suggestedNext) {
		const nextHeading =
			handoff.suggestedNext.source && handoff.suggestedNext.source !== "garden-suggested"
				? "## Recommended Next Rationale"
				: "## Suggested Next Rationale";
		lines.push("", nextHeading);
		if (handoff.suggestedNext.routeId) {
			lines.push(`Route: ${handoff.suggestedNext.routeId} - ${handoff.suggestedNext.routeLabel ?? ""}`.trim());
		}
		lines.push(
			`Choice: ${handoff.suggestedNext.choiceId} - ${handoff.suggestedNext.label}${handoff.suggestedNext.kind ? ` (${handoff.suggestedNext.kind}${handoff.suggestedNext.targetPageId ? ` -> ${handoff.suggestedNext.targetPageId}` : ""})` : ""}`,
		);
		lines.push(`Rationale: ${handoff.suggestedNext.rationale}`);
		if (handoff.suggestedNext.expectedNextPage) {
			lines.push(`Expected next page: ${handoff.suggestedNext.expectedNextPage}`);
		}
		if (handoff.suggestedNext.safetyBoundary) {
			lines.push(`Safety boundary: ${handoff.suggestedNext.safetyBoundary}`);
		}
	}
	if (handoff.path.length > 0) {
		lines.push("", "## Path");
		for (const step of handoff.path) {
			const result = step.resultPageId ? ` -> ${step.resultPageId}` : "";
			const suggestion = step.suggestedChoiceId ? ` suggested=${step.suggestedChoiceId}` : "";
			const route = step.recommendedRouteId ? ` route=${step.recommendedRouteId}` : "";
			const followedRoute = step.followedRouteId
				? ` followedRoute=${step.followedRouteId}${step.followedRouteChoiceId ? ` choice=${step.followedRouteChoiceId}` : ""}`
				: "";
			const note = step.note ? ` - ${step.note}` : "";
			lines.push(
				`- ${step.index}. ${step.decision} ${step.pageId ?? "page"}${result}${suggestion}${route}${followedRoute}${note}`,
			);
		}
	}
	if (handoff.currentFacts.length > 0) {
		lines.push("", "## Facts", ...handoff.currentFacts.map((fact) => `- ${fact.label}: ${shortScalar(fact.value)}`));
	}
	if (handoff.currentWarnings.length > 0) {
		lines.push("", "## Warnings", ...handoff.currentWarnings.map((warning) => `- ${warning}`));
	}
	if (handoff.currentObjects.length > 0) {
		lines.push(
			"",
			"## Objects",
			...handoff.currentObjects
				.map((object) => describeWorkflowObject(object))
				.filter((object): object is string => object !== undefined)
				.map((object) => `- ${object}`),
		);
	}
	if (handoff.currentRoutes.length > 0) {
		lines.push("", "## Routes", ...handoff.currentRoutes.map((route) => `- ${describeNavigationRoute(route)}`));
	}
	for (const section of handoff.currentSections) {
		const items = section.items.map(describeSectionItem).filter((item): item is string => item !== undefined);
		if (items.length > 0) {
			lines.push("", `## ${section.title}`, ...items.map((item) => `- ${item}`));
		}
	}
	if (handoff.currentChoices.length > 0) {
		lines.push("", "## Choices");
		for (const choice of handoff.currentChoices) {
			const marker = choice.suggested ? "*" : "-";
			const suffix = [choice.kind, choice.targetPageId ? `-> ${choice.targetPageId}` : undefined]
				.filter(Boolean)
				.join(" ");
			lines.push(
				`${marker} ${choice.id}: ${choice.label}${suffix ? ` (${suffix})` : ""}${choice.description ? ` - ${choice.description}` : ""}`,
			);
			if (choice.requiresExplicitAuthorization) {
				lines.push(
					`  Authorization: explicit authorization required${choice.authorizationReason ? ` - ${choice.authorizationReason}` : ""}`,
				);
			}
		}
	}
	if (handoff.nextCommand) {
		lines.push(
			"",
			handoff.suggestedNext?.source && handoff.suggestedNext.source !== "garden-suggested"
				? "## Recommended Next"
				: "## Suggested Next",
			`\`${handoff.nextCommand}\``,
		);
		lines.push(
			"",
			"Command context: this command requires a live Garden MCP connection through `--mcp-url`/`--token` or `GARDEN_MCP_URL`/`GARDEN_LOOPBACK_TOKEN`. If this is a retained local handoff and the temporary Garden profile has shut down, use the retained page-audit artifact for offline inspection or regenerate the handoff against a live graph.",
		);
	}
	if (handoff.nextActions.length > 0) {
		lines.push("", "## Next Actions", ...handoff.nextActions.map((action) => `- ${action.text}`));
	}
	return `${lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()}\n`;
}

export async function gardenWorkflowWalkSuggested(
	caller: GardenMcpCaller,
	options: GardenWorkflowWalkSuggestedOptions,
): Promise<GardenWorkflowWalkResult> {
	const maxSteps = options.maxSteps ?? 1;
	if (!Number.isInteger(maxSteps) || maxSteps < 0) {
		throw new Error("maxSteps must be a non-negative integer");
	}
	const initial = await initialGardenWorkflowWalkPacket(caller, options);
	let currentPacket = initial.packet;
	let finalPayload = initial.payload;
	const steps: GardenWorkflowWalkStep[] = [];
	const transcriptEntries: GardenWorkflowTranscriptEntry[] = [];
	const recordEntry = async (entry: GardenWorkflowTranscriptEntry) => {
		transcriptEntries.push(entry);
		await options.onTranscriptEntry?.(entry);
	};
	await recordEntry(
		gardenWorkflowTranscriptEntry(currentPacket, {
			decision: "observed",
			note: options.note,
		}),
	);
	let stopReason = "max_steps";
	for (let index = 1; index <= maxSteps; index++) {
		let request: GardenWorkflowSessionRequest;
		let command: string;
		let routeId: string | undefined;
		try {
			request = gardenWorkflowSuggestedSessionRequest(currentPacket);
			if (options.handoffIntent !== undefined) request.handoffIntent = options.handoffIntent;
			routeId = gardenWorkflowRecommendedRouteId(currentPacket);
			command = gardenWorkflowFollowSuggestedCommand(currentPacket, {
				...options.followOptions,
				handoffIntent: options.handoffIntent ?? options.followOptions?.handoffIntent,
				output: options.followOptions?.output ?? "packet",
			});
		} catch (error) {
			stopReason = error instanceof Error ? error.message : String(error);
			break;
		}
		const payload = await callGardenWorkflowAuthoringSession(caller, request);
		const resultPacket = gardenWorkflowSessionChoicePacket(payload);
		await recordEntry(
			gardenWorkflowTranscriptEntry(currentPacket, {
				command,
				decision: "accepted",
				note: options.note,
				resultPacket,
				routeId,
			}),
		);
		steps.push({
			index,
			command,
			request: gardenWorkflowSessionArguments(request),
			packet: currentPacket,
			resultPacket,
		});
		currentPacket = resultPacket;
		finalPayload = payload;
	}
	return {
		kind: "gardenWorkflowWalkResult",
		startedFrom: initial.startedFrom,
		maxSteps,
		steps,
		stopReason,
		finalPacket: currentPacket,
		...(finalPayload !== undefined ? { finalPayload } : {}),
		transcriptEntries,
	};
}

async function initialGardenWorkflowWalkPacket(
	caller: GardenMcpCaller,
	options: GardenWorkflowWalkSuggestedOptions,
): Promise<{ startedFrom: "packet" | "session"; packet: unknown; payload?: unknown }> {
	if (options.packet !== undefined) {
		return { startedFrom: "packet", packet: options.packet };
	}
	const graphId = requiredValue(options.graphId, "graphId is required when no starting packet is provided");
	const payload = await callGardenWorkflowAuthoringSession(caller, {
		graphId,
		operation: "status",
		workflowName: options.workflowName,
		pageId: options.pageId,
		handoffIntent: options.handoffIntent,
	});
	return {
		startedFrom: "session",
		packet: gardenWorkflowSessionChoicePacket(payload),
		payload,
	};
}

async function writeGardenBlock(
	caller: GardenMcpCaller,
	input: { graphId: string; documentId: string; content: string },
): Promise<GardenWorkflowBlockRef & { writeResult: unknown }> {
	const writeResult = await caller.callTool("write_document", {
		graphId: input.graphId,
		documentId: input.documentId,
		content: input.content,
		format: "markdown",
	});
	const blockId = firstBlockId(writeResult);
	if (!blockId) {
		throw new Error(
			`write_document did not return a block id for ${input.documentId}: ${JSON.stringify(writeResult)}`,
		);
	}
	return { documentId: input.documentId, blockId, writeResult };
}

function firstBlockId(value: unknown): string | undefined {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	const candidates = [record.blockIds, record.block_ids];
	for (const candidate of candidates) {
		if (Array.isArray(candidate)) {
			const id = candidate.find((entry): entry is string => typeof entry === "string" && entry.length > 0);
			if (id) return id;
		}
	}
	return undefined;
}

function fenced(value: string, language: "js" | "json"): string {
	return `\`\`\`${language}\n${value.replaceAll("```", "\\`\\`\\`")}\n\`\`\`\n`;
}

function parseJsonRpcBody(toolName: string, status: number, text: string): Record<string, unknown> {
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch {
		throw new Error(`${toolName} returned non-JSON HTTP ${status}: ${text.slice(0, 500)}`);
	}
}

export function unwrapMcpToolResult(result: unknown): unknown {
	if (!result || typeof result !== "object") return result;
	const record = result as Record<string, unknown>;
	if (record.structuredContent !== undefined) return record.structuredContent;
	if (Array.isArray(record.content)) {
		for (const part of record.content) {
			if (!part || typeof part !== "object") continue;
			const text = (part as Record<string, unknown>).text;
			if (typeof text === "string") {
				const parsed = tryParseJson(text);
				if (parsed !== undefined) return parsed;
			}
		}
	}
	return result;
}

function tryParseJson(text: string): unknown {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
	try {
		return JSON.parse(trimmed);
	} catch {
		return undefined;
	}
}

function slug(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "workflow";
}

interface WorkflowSessionParts {
	record: Record<string, unknown>;
	payload: Record<string, unknown>;
	authoring: Record<string, unknown>;
	draft: Record<string, unknown>;
	book: Record<string, unknown>;
	innerBook: Record<string, unknown>;
	page: Record<string, unknown>;
	operation?: string;
	graphId?: string;
	workflowName?: string;
	pageId: string;
	pageKind?: string;
	title: string;
	status?: string;
	message?: string;
	summary?: string;
	scene?: string;
	validation?: GardenWorkflowChoicePacket["validation"];
	latestRun?: GardenWorkflowChoicePacket["latestRun"];
	facts: unknown[];
	warnings: string[];
	objects: unknown[];
	sections: Record<string, unknown>[];
	choices: Record<string, unknown>[];
	suggestedChoiceId?: string;
	intentRecommendation?: Record<string, unknown>;
	navigationRoutes: Record<string, unknown>[];
}

function workflowSessionParts(session: unknown): WorkflowSessionParts {
	const record = asRecord(session) ?? {};
	const payload = asRecord(record.payload) ?? {};
	const authoring = asRecord(record.authoring) ?? {};
	const draft = asRecord(payload.draft) ?? {};
	const book = findWorkflowBook(record);
	const innerBook = asRecord(book.book) ?? {};
	const page = asRecord(book.page) ?? {};
	const pageKind = stringValue(page.kind);
	const namedWorkflow =
		stringValue(record.workflowName) ??
		stringValue(authoring.workflowName) ??
		stringValue(draft.workflowName) ??
		stringValue(innerBook.workflowName) ??
		stringValue(asRecord(book.workflow)?.name);
	const workflowName = pageKind === "catalog" ? undefined : (namedWorkflow ?? "workflow");
	const pageId = stringValue(record.pageId) ?? stringValue(authoring.pageId) ?? stringValue(page.id) ?? "page";
	const validation = validationPacket(asRecord(payload.validation) || asRecord(draft.validation));
	const latestRun = latestRunPacket(asRecord(payload.latestRun) ?? latestRunFromBook(book));
	return {
		record,
		payload,
		authoring,
		draft,
		book,
		innerBook,
		page,
		operation: stringValue(record.operation),
		graphId: stringValue(record.graphId) ?? stringValue(innerBook.graphId) ?? stringValue(book.graphId),
		workflowName,
		pageId,
		pageKind,
		title: stringValue(page.title) ?? pageId,
		status: stringValue(authoring.status) ?? stringValue(draft.status),
		message: stringValue(authoring.message) ?? stringValue(draft.message),
		summary: stringValue(page.summary),
		scene: stringValue(page.scene),
		validation,
		latestRun,
		facts: arrayValue(page.facts),
		warnings: arrayValue(page.warnings)
			.map(shortValue)
			.filter((value): value is string => Boolean(value)),
		objects: arrayValue(page.objects),
		sections: arrayValue(page.sections)
			.map(asRecord)
			.filter((value): value is Record<string, unknown> => value !== undefined),
		choices: arrayValue(page.choices)
			.map(asRecord)
			.filter((value): value is Record<string, unknown> => value !== undefined),
		suggestedChoiceId: stringValue(page.suggestedChoiceId),
		intentRecommendation:
			asRecord(page.intentRecommendation) ?? asRecord(authoring.intentRecommendation) ?? undefined,
		navigationRoutes: arrayValue(page.navigationRoutes ?? authoring.navigationRoutes)
			.map(asRecord)
			.filter((value): value is Record<string, unknown> => value !== undefined),
	};
}

function findWorkflowBook(session: Record<string, unknown>): Record<string, unknown> {
	const payload = asRecord(session.payload);
	return (
		asRecord(session.book ? session : undefined) ??
		asRecord(payload?.book) ??
		asRecord(asRecord(payload?.draft)?.book) ??
		asRecord(asRecord(payload?.validationWatch)?.book) ??
		{}
	);
}

function latestRunFromBook(book: Record<string, unknown>): Record<string, unknown> | undefined {
	const pages = arrayValue(asRecord(book.book)?.pages);
	const currentObjects = arrayValue(asRecord(book.page)?.objects);
	const objects = [...currentObjects, ...pages.flatMap((page) => arrayValue(asRecord(page)?.objects))];
	return objects.map(asRecord).find((object) => object?.kind === "workflowRun");
}

function collectNextActionPackets(
	payload: Record<string, unknown>,
	draft: Record<string, unknown> | undefined,
): GardenWorkflowPacketAction[] {
	const actions = [
		asRecord(draft?.nextAction),
		asRecord(asRecord(payload.background)?.nextAction),
		asRecord(asRecord(payload.watch)?.nextAction),
		asRecord(asRecord(payload.await)?.nextAction),
	]
		.map(actionPacket)
		.filter((value): value is GardenWorkflowPacketAction => value !== undefined);
	const backgroundJob = asRecord(asRecord(payload.background)?.job);
	const jobId = stringValue(backgroundJob?.job_id) ?? stringValue(backgroundJob?.jobId);
	if (jobId) actions.unshift(actionPacket({ tool: "get_job_status", arguments: { jobId } })!);
	return uniqueActions(actions);
}

function actionPacket(action: Record<string, unknown> | undefined): GardenWorkflowPacketAction | undefined {
	if (!action) return undefined;
	const tool = stringValue(action.tool);
	const args = asRecord(action.arguments);
	if (!tool) return undefined;
	return {
		tool,
		...(args ? { arguments: args } : {}),
		text: `${tool}${args ? ` ${JSON.stringify(args)}` : ""}`,
	};
}

function uniqueActions(actions: GardenWorkflowPacketAction[]): GardenWorkflowPacketAction[] {
	const seen = new Set<string>();
	const unique: GardenWorkflowPacketAction[] = [];
	for (const action of actions) {
		const key = action.text;
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(action);
	}
	return unique;
}

function describeWorkflowObject(value: unknown): string | undefined {
	const object = asRecord(value);
	if (!object) return undefined;
	const kind = stringValue(object.kind) ?? "object";
	const label =
		stringValue(object.name) ??
		stringValue(object.title) ??
		stringValue(object.label) ??
		stringValue(object.workflowName) ??
		stringValue(object.runId) ??
		stringValue(object.documentId) ??
		stringValue(object.queryId);
	const status = stringValue(object.status);
	const latestRunStatus = stringValue(object.latestRunStatus);
	const counts = [
		countLabel("phases", object.phaseCount),
		countLabel("agents", object.agentCount),
		countLabel("runs", object.runCount),
	]
		.filter(Boolean)
		.join(" ");
	const id = stringValue(object.id) ?? stringValue(object.workflowUri) ?? stringValue(object.blockId);
	return [
		kind,
		label,
		status ? `[${status}]` : undefined,
		latestRunStatus ? `[latest ${latestRunStatus}]` : undefined,
		counts || undefined,
		id ? `(${id})` : undefined,
	]
		.filter(Boolean)
		.join(" ");
}

function describeFact(value: unknown): string | undefined {
	const fact = asRecord(value);
	if (!fact) return undefined;
	const label = stringValue(fact.label) ?? stringValue(fact.name);
	if (!label) return undefined;
	return `${label}: ${shortScalar(fact.value)}`;
}

function describeSectionItem(value: unknown): string | undefined {
	const item = asRecord(value);
	if (!item) return shortValue(value);
	const name = stringValue(item.name) ?? stringValue(item.title) ?? stringValue(item.label);
	const description = stringValue(item.description);
	const choice = stringValue(item.pageChoiceId);
	const counts = [
		countLabel("phases", item.phaseCount),
		countLabel("agents", item.agentCount),
		countLabel("runs", item.runCount),
	]
		.filter(Boolean)
		.join(" ");
	const id = stringValue(item.workflowUri) ?? stringValue(item.documentId);
	const lead = name ?? id;
	if (!lead) return shortValue(item);
	return [
		lead,
		counts || undefined,
		choice ? `choice=${choice}` : undefined,
		description ? `- ${description}` : undefined,
		id && id !== lead ? `(${id})` : undefined,
	]
		.filter(Boolean)
		.join(" ");
}

function describeNavigationRoute(route: GardenWorkflowNavigationRoute): string {
	const qualifiers =
		route.kind === "intent" && route.intent
			? [`intent=${route.intent}`]
			: [route.kind, route.intent ? `intent=${route.intent}` : undefined].filter(Boolean);
	const kind = qualifiers.length > 0 ? ` [${qualifiers.join(" ")}]` : "";
	const choice = `-> ${route.choiceId}${route.choiceLabel ? ` (${route.choiceLabel})` : ""}`;
	const rationale = route.rationale ? ` - ${route.rationale}` : "";
	const authorization = route.requiresExplicitAuthorization
		? `; authorization: required${route.authorizationReason ? ` - ${route.authorizationReason}` : ""}`
		: "";
	const turn = route.action ? `; turn: route ${route.id}` : "";
	return `${route.id}: ${route.label}${kind} ${choice}${rationale}${authorization}${turn}`;
}

function countLabel(label: string, value: unknown): string | undefined {
	return typeof value === "number" ? `${label}=${value}` : undefined;
}

function shortScalar(value: unknown): string {
	if (value === null || value === undefined) return "none";
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}

function validationPacket(validation: Record<string, unknown> | undefined): GardenWorkflowChoicePacket["validation"] {
	if (!validation) return undefined;
	return compactRecord({
		passed: typeof validation.passed === "boolean" ? validation.passed : undefined,
		summary: stringValue(validation.summary),
	});
}

function latestRunPacket(latestRun: Record<string, unknown> | undefined): GardenWorkflowChoicePacket["latestRun"] {
	if (!latestRun) return undefined;
	return compactRecord({
		runId: stringValue(latestRun.runId),
		status: stringValue(latestRun.status),
	});
}

function factPacket(value: unknown): GardenWorkflowPacketFact | undefined {
	const fact = asRecord(value);
	if (!fact) return undefined;
	const label = stringValue(fact.label) ?? stringValue(fact.name);
	if (!label) return undefined;
	return { label, value: fact.value };
}

function objectPacket(value: unknown): GardenWorkflowPacketObject | undefined {
	const object = asRecord(value);
	if (!object) return undefined;
	return compactRecord({
		kind: stringValue(object.kind) ?? "object",
		label:
			stringValue(object.name) ??
			stringValue(object.title) ??
			stringValue(object.label) ??
			stringValue(object.workflowName) ??
			stringValue(object.runId) ??
			stringValue(object.documentId) ??
			stringValue(object.queryId),
		id:
			stringValue(object.id) ??
			stringValue(object.workflowUri) ??
			stringValue(object.blockId) ??
			stringValue(object.subject),
		subject: stringValue(object.subject),
		status: stringValue(object.status),
		latestRunStatus: stringValue(object.latestRunStatus),
		pageId: stringValue(object.pageId),
		graphId: stringValue(object.graphId),
		workflowName: stringValue(object.workflowName),
		fromPage: stringValue(object.fromPage),
		intent: stringValue(object.intent),
		readiness: stringValue(object.readiness),
		nativeSuggestedChoice: stringValue(object.nativeSuggestedChoice),
		recommendedRoute: stringValue(object.recommendedRoute),
		recommendedRouteLabel: stringValue(object.recommendedRouteLabel),
		recommendedChoice: stringValue(object.recommendedChoice),
		followedRoute: stringValue(object.followedRoute),
		followedRouteLabel: stringValue(object.followedRouteLabel),
		followedChoice: stringValue(object.followedChoice),
		followedChoiceLabel: stringValue(object.followedChoiceLabel),
		primaryRoute: stringValue(object.primaryRoute),
		primaryRouteLabel: stringValue(object.primaryRouteLabel),
		primaryChoice: stringValue(object.primaryChoice),
		primaryChoiceLabel: stringValue(object.primaryChoiceLabel),
		routeCount: numberValue(object.routeCount),
		navigationRouteCount: numberValue(object.navigationRouteCount),
		rawSparqlQueryCount: numberValue(object.rawSparqlQueryCount),
		executionAuthorized: booleanValue(object.executionAuthorized),
		evidenceCount: numberValue(object.evidenceCount),
		authorizationFlagsVisible: numberValue(object.authorizationFlagsVisible),
		role: stringValue(object.role),
		reason: stringValue(object.reason),
		choiceId: stringValue(object.choiceId),
		phaseOrder: numberValue(object.phaseOrder) ?? numberValue(object.order),
		phaseCount: numberValue(object.phaseCount),
		agentCount: numberValue(object.agentCount),
		runCount: numberValue(object.runCount),
		documentId: stringValue(object.documentId),
		blockId: stringValue(object.blockId),
		method: stringValue(object.method),
		path: stringValue(object.path),
		parsed: typeof object.parsed === "boolean" ? object.parsed : undefined,
	});
}

function sectionPacket(section: Record<string, unknown>): GardenWorkflowPacketSection | undefined {
	const items = arrayValue(section.items)
		.map(sectionItemPacket)
		.filter((value): value is GardenWorkflowPacketSectionItem => value !== undefined);
	if (items.length === 0) return undefined;
	return compactRecord({
		id: stringValue(section.id),
		title: stringValue(section.title) ?? stringValue(section.id) ?? "Section",
		items,
	});
}

function sectionItemPacket(value: unknown): GardenWorkflowPacketSectionItem | undefined {
	const item = asRecord(value);
	if (!item) return undefined;
	const label = stringValue(item.name) ?? stringValue(item.title) ?? stringValue(item.label);
	const workflowUri = stringValue(item.workflowUri);
	const documentId = stringValue(item.documentId);
	const subject = stringValue(item.subject);
	const routeId = stringValue(item.routeId);
	if (!label && !workflowUri && !documentId && !subject && !routeId) return undefined;
	return compactRecord({
		label,
		description: stringValue(item.description),
		subject,
		generatedAt: stringValue(item.generatedAt),
		workflowName: stringValue(item.workflowName),
		pageId: stringValue(item.pageId),
		pageTitle: stringValue(item.pageTitle),
		intent: stringValue(item.intent),
		recommendedRoute: stringValue(item.recommendedRoute),
		recommendedRouteLabel: stringValue(item.recommendedRouteLabel),
		recommendedChoice: stringValue(item.recommendedChoice),
		navigationRouteCount: numberValue(item.navigationRouteCount),
		rawSparqlQueryCount: numberValue(item.rawSparqlQueryCount),
		pageIdForBook: stringValue(item.pageIdForBook),
		routeId,
		routeLabel: stringValue(item.routeLabel),
		routeKind: stringValue(item.routeKind),
		routeStatus: stringValue(item.routeStatus),
		choiceId: stringValue(item.pageChoiceId) ?? stringValue(item.choiceId),
		choiceLabel: stringValue(item.choiceLabel),
		source: stringValue(item.source),
		rationale: stringValue(item.rationale),
		actionJson: stringValue(item.actionJson),
		workflowUri,
		documentId,
		phaseCount: numberValue(item.phaseCount),
		agentCount: numberValue(item.agentCount),
		runCount: numberValue(item.runCount),
	});
}

function choicePacket(
	choice: Record<string, unknown>,
	suggestedChoiceId: string | undefined,
): GardenWorkflowPacketChoice {
	const id = stringValue(choice.id) ?? "choice";
	const kind = stringValue(choice.kind);
	const targetPageId = stringValue(choice.targetPageId);
	const action = choice.action;
	const authorization = choiceAuthorization(id, kind, targetPageId, action);
	return compactRecord({
		id,
		label: stringValue(choice.label) ?? id,
		kind,
		targetPageId,
		description: stringValue(choice.description),
		suggested: suggestedChoiceId === id,
		requiresExplicitAuthorization: authorization.required ? true : undefined,
		authorizationReason: authorization.reason,
		action,
	});
}

function intentRecommendationPacket(
	value: unknown,
	choices: GardenWorkflowPacketChoice[],
): GardenWorkflowIntentRecommendation | undefined {
	const recommendation = asRecord(value);
	const choiceId = stringValue(recommendation?.choiceId);
	if (!recommendation || !choiceId) return undefined;
	const choice = choices.find((candidate) => candidate.id === choiceId);
	if (!choice) return undefined;
	return compactRecord({
		intent: stringValue(recommendation.intent),
		choiceId,
		choiceLabel: stringValue(recommendation.choiceLabel) ?? choice.label,
		source: stringValue(recommendation.source),
		rationale: stringValue(recommendation.rationale),
	});
}

function navigationRoutePacket(
	value: unknown,
	choices: GardenWorkflowPacketChoice[] = [],
): GardenWorkflowNavigationRoute | undefined {
	const route = asRecord(value);
	const id = stringValue(route?.id);
	const choiceId = stringValue(route?.choiceId);
	if (!route || !id || !choiceId) return undefined;
	const choice = choices.find((candidate) => candidate.id === choiceId);
	if (choices.length > 0 && !choice) return undefined;
	const action = actionPacket(asRecord(route.action));
	const actionChoiceId = stringValue(action?.arguments?.choiceId);
	const authorization = routeAuthorization(route, choice, actionChoiceId);
	return compactRecord({
		id,
		label: stringValue(route.label) ?? id,
		kind: stringValue(route.kind),
		intent: stringValue(route.intent),
		choiceId,
		choiceLabel: stringValue(route.choiceLabel) ?? choice?.label,
		source: stringValue(route.source),
		rationale: stringValue(route.rationale),
		requiresExplicitAuthorization: authorization.required ? true : undefined,
		authorizationReason: authorization.reason,
		action,
	});
}

function recommendedNextActionPacket(input: {
	graphId?: string;
	workflowName?: string;
	pageId: string;
	choices: GardenWorkflowPacketChoice[];
	suggestedChoice?: GardenWorkflowPacketChoice;
	intentRecommendation?: GardenWorkflowIntentRecommendation;
	navigationRoutes: GardenWorkflowNavigationRoute[];
	nextActions: GardenWorkflowPacketAction[];
}): GardenWorkflowRecommendedNextAction | undefined {
	const intentRoute = input.intentRecommendation
		? routeForIntentRecommendation(input.navigationRoutes, input.intentRecommendation)
		: undefined;
	if (intentRoute) {
		return routeRecommendedNextAction(
			"intent-recommendation",
			intentRoute,
			input.intentRecommendation?.rationale ?? intentRoute.rationale,
		);
	}
	const intentChoice = input.intentRecommendation
		? input.choices.find((choice) => choice.id === input.intentRecommendation?.choiceId)
		: undefined;
	if (intentChoice) {
		return choiceRecommendedNextAction(
			input,
			intentChoice,
			"intent-recommendation",
			input.intentRecommendation?.rationale,
			handoffIntentValue(input.intentRecommendation?.intent),
		);
	}
	const suggestedRoute = input.suggestedChoice
		? routeForChoiceFromNavigationRoutes(input.navigationRoutes, input.suggestedChoice.id, undefined)
		: undefined;
	if (suggestedRoute) {
		return routeRecommendedNextAction("suggested-route", suggestedRoute, suggestedRoute.rationale);
	}
	if (input.suggestedChoice) {
		return choiceRecommendedNextAction(input, input.suggestedChoice, "suggested-choice");
	}
	const nextAction = input.nextActions[0];
	if (!nextAction) return undefined;
	return compactRecord({
		kind: "tool-action" as const,
		source: "next-action" as const,
		requiresLiveMcp: true as const,
		commandTemplate: nextActionCommandTemplate(nextAction),
		action: nextAction,
	});
}

function routeRecommendedNextAction(
	source: "intent-recommendation" | "suggested-route",
	route: GardenWorkflowNavigationRoute,
	rationale: string | undefined,
): GardenWorkflowRecommendedNextAction {
	return compactRecord({
		kind: "accept-route" as const,
		source,
		routeId: route.id,
		routeLabel: route.label,
		choiceId: route.choiceId,
		choiceLabel: route.choiceLabel,
		rationale,
		requiresLiveMcp: true as const,
		requiresPacketFile: true,
		requiresExplicitAuthorization: route.requiresExplicitAuthorization ? true : undefined,
		authorizationReason: route.authorizationReason,
		commandTemplate: acceptRouteCommandTemplate(route),
		action: route.action,
	});
}

function choiceRecommendedNextAction(
	input: { graphId?: string; workflowName?: string; pageId: string },
	choice: GardenWorkflowPacketChoice,
	source: "intent-recommendation" | "suggested-choice",
	rationale?: string,
	handoffIntent?: GardenWorkflowHandoffIntent,
): GardenWorkflowRecommendedNextAction {
	return compactRecord({
		kind: "choose" as const,
		source,
		choiceId: choice.id,
		choiceLabel: choice.label,
		rationale,
		requiresLiveMcp: true as const,
		requiresExplicitAuthorization: choice.requiresExplicitAuthorization ? true : undefined,
		authorizationReason: choice.authorizationReason,
		commandTemplate: chooseCommandTemplate(input, choice.id, handoffIntent),
		action: actionPacket(asRecord(choice.action)),
	});
}

function routeForIntentRecommendation(
	routes: GardenWorkflowNavigationRoute[],
	recommendation: GardenWorkflowIntentRecommendation,
): GardenWorkflowNavigationRoute | undefined {
	return (
		routeForChoiceFromNavigationRoutes(routes, recommendation.choiceId, recommendation.intent) ??
		routes.find((route) => route.id === recommendation.intent || route.intent === recommendation.intent)
	);
}

function routeForChoiceFromNavigationRoutes(
	routes: GardenWorkflowNavigationRoute[],
	choiceId: string,
	intent: string | undefined,
): GardenWorkflowNavigationRoute | undefined {
	const direct = routes.filter((route) => route.choiceId === choiceId);
	const actionMatched =
		direct.length > 0
			? direct
			: routes.filter((route) => stringValue(route.action?.arguments?.choiceId) === choiceId);
	const matches = actionMatched.length > 0 ? actionMatched : direct;
	if (intent) {
		return matches.find((route) => route.intent === intent || route.id === intent) ?? matches[0];
	}
	return matches[0];
}

type ShellCommandTemplatePart = string | { raw: string };

function acceptRouteCommandTemplate(route: GardenWorkflowNavigationRoute): string {
	return shellCommandTemplate([
		...workflowSessionCommandPrefix(),
		"accept-route",
		"--packet-file",
		rawTemplate("<packet-file>"),
		"--route",
		route.id,
		"--mcp-url",
		rawTemplate('"$GARDEN_MCP_URL"'),
		"--token",
		rawTemplate('"$GARDEN_LOOPBACK_TOKEN"'),
		"--packet",
	]);
}

function chooseCommandTemplate(
	input: { graphId?: string; workflowName?: string; pageId: string },
	choiceId: string,
	handoffIntent?: GardenWorkflowHandoffIntent,
): string {
	return shellCommandTemplate([
		...workflowSessionCommandPrefix(),
		"choose",
		"--graph",
		input.graphId ?? rawTemplate("<graph-id>"),
		...(input.workflowName ? ["--workflow", input.workflowName] : []),
		"--page",
		input.pageId,
		"--choice",
		choiceId,
		...(handoffIntent ? ["--handoff-intent", handoffIntent] : []),
		"--mcp-url",
		rawTemplate('"$GARDEN_MCP_URL"'),
		"--token",
		rawTemplate('"$GARDEN_LOOPBACK_TOKEN"'),
		"--packet",
	]);
}

function nextActionCommandTemplate(action: GardenWorkflowPacketAction): string {
	const commandPrefix = workflowSessionCommandPrefix();
	try {
		const args = action.arguments ?? {};
		if (action.tool === "workflow_authoring_session") {
			return shellCommandTemplate([
				...commandPrefix,
				...workflowAuthoringActionCommand(args),
				"--mcp-url",
				rawTemplate('"$GARDEN_MCP_URL"'),
				"--token",
				rawTemplate('"$GARDEN_LOOPBACK_TOKEN"'),
				"--packet",
			]);
		}
		if (action.tool === "get_job_status" || action.tool === "get_job_result") {
			return shellCommandTemplate([
				...commandPrefix,
				action.tool === "get_job_status" ? "job-status" : "job-result",
				"--job",
				stringValue(args.jobId) ?? stringValue(args.job_id) ?? rawTemplate("<job-id>"),
				"--mcp-url",
				rawTemplate('"$GARDEN_MCP_URL"'),
				"--token",
				rawTemplate('"$GARDEN_LOOPBACK_TOKEN"'),
				"--packet",
			]);
		}
	} catch {
		return action.text;
	}
	return action.text;
}

function workflowSessionCommandPrefix(): string[] {
	return ["pnpm", "exec", "tsx", "scripts/workflow-garden-session.ts"];
}

function rawTemplate(raw: string): { raw: string } {
	return { raw };
}

function shellCommandTemplate(parts: ShellCommandTemplatePart[]): string {
	return parts.map((part) => (typeof part === "string" ? shellQuote(part) : part.raw)).join(" ");
}

function routeAuthorization(
	route: Record<string, unknown>,
	choice: GardenWorkflowPacketChoice | undefined,
	actionChoiceId: string | undefined,
): { required: boolean; reason?: string } {
	if (choice?.requiresExplicitAuthorization) {
		return { required: true, reason: choice.authorizationReason };
	}
	const actionChoiceAuthorization = actionChoiceId
		? choiceAuthorization(actionChoiceId, stringValue(route.kind), undefined, route.action)
		: { required: false };
	if (actionChoiceAuthorization.required) return actionChoiceAuthorization;
	return { required: false };
}

function choiceAuthorization(
	id: string,
	kind: string | undefined,
	targetPageId: string | undefined,
	action: unknown,
): { required: boolean; reason?: string } {
	const actionRecord = asRecord(action) ?? {};
	const facade = asRecord(actionRecord.facade);
	const actionTool = stringValue(actionRecord.tool);
	const actionKind = facade
		? `${stringValue(facade.method) ?? "HTTP"} ${stringValue(facade.path) ?? ""}`.trim()
		: undefined;
	if (actionTool === "workflow_run_start") {
		return {
			required: true,
			reason: "choice calls workflow_run_start and may start Choreograph sidecar work",
		};
	}
	if (actionKind === "POST /workflows/runs") {
		return {
			required: true,
			reason: "choice submits a workflow run through the Garden facade",
		};
	}
	if (kind === "execute" || /^(start-run|submit-run)/.test(id)) {
		return {
			required: true,
			reason: "choice can start or submit workflow execution",
		};
	}
	if (id === "execute-async" || targetPageId === "execute") {
		return {
			required: true,
			reason: "choice opens run-preparation actions; inspect only unless execution is explicitly authorized",
		};
	}
	return { required: false };
}

function compactRecord<T extends Record<string, unknown>>(record: T): T {
	return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function workflowChoicePacketRecord(packet: unknown): Record<string, unknown> {
	const record = asRecord(packet);
	if (!record || record.kind !== "gardenWorkflowChoicePacket") {
		throw new Error("expected gardenWorkflowChoicePacket");
	}
	return record;
}

function transcriptSummary(
	packet: Record<string, unknown>,
	resultPacket: Record<string, unknown> | undefined,
	followedRouteId?: string,
): GardenWorkflowTranscriptEntry["summary"] {
	const page = asRecord(packet.page) ?? {};
	const suggestedChoice = asRecord(packet.suggestedChoice);
	const resultPage = asRecord(resultPacket?.page) ?? {};
	const summaryRoute = transcriptSummaryRoute(packet);
	const followedRoute = followedRouteId ? workflowRoutePacket(packet, followedRouteId) : undefined;
	return compactRecord({
		graphId: stringValue(packet.graphId),
		workflowName: stringValue(packet.workflowName),
		pageId: stringValue(page.id),
		pageTitle: stringValue(page.title),
		status: stringValue(packet.status),
		suggestedChoiceId: stringValue(suggestedChoice?.id),
		suggestedChoiceLabel: stringValue(suggestedChoice?.label),
		recommendedRouteId: summaryRoute?.id,
		recommendedRouteLabel: summaryRoute?.label,
		followedRouteId: followedRoute?.id,
		followedRouteLabel: followedRoute?.label,
		followedRouteChoiceId: followedRoute?.choiceId,
		followedRouteChoiceLabel: followedRoute?.choiceLabel,
		resultPageId: stringValue(resultPage.id),
		resultStatus: stringValue(resultPacket?.status),
	});
}

function transcriptSummaryRoute(packet: Record<string, unknown>): GardenWorkflowNavigationRoute | undefined {
	const intentRecommendation = asRecord(packet.intentRecommendation);
	const intentChoiceId = stringValue(intentRecommendation?.choiceId);
	const intent = packetHandoffIntent(packet);
	if (intentChoiceId) {
		return routeForChoice(packet, intentChoiceId, intent);
	}
	const suggestedChoiceId = stringValue(asRecord(packet.suggestedChoice)?.id);
	return suggestedChoiceId ? routeForChoice(packet, suggestedChoiceId, undefined) : undefined;
}

function currentTranscriptPacket(entries: GardenWorkflowTranscriptEntry[]): Record<string, unknown> | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		const resultPacket = asRecord(entry.resultPacket);
		if (resultPacket) return resultPacket;
		const packet = asRecord(entry.packet);
		if (packet) return packet;
	}
	return undefined;
}

function transcriptDecisionCounts(entries: GardenWorkflowTranscriptEntry[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const entry of entries) {
		counts[entry.decision] = (counts[entry.decision] ?? 0) + 1;
	}
	return counts;
}

function handoffTitle(packet: Record<string, unknown> | undefined, entries: GardenWorkflowTranscriptEntry[]): string {
	const page = asRecord(packet?.page);
	const workflowName = stringValue(packet?.workflowName);
	const pageTitle = stringValue(page?.title) ?? stringValue(page?.id);
	if (workflowName && pageTitle) return `Workflow Handoff - ${workflowName} / ${pageTitle}`;
	if (pageTitle) return `Workflow Handoff - ${pageTitle}`;
	return entries.length > 0 ? "Workflow Handoff" : "Workflow Handoff - Empty Transcript";
}

function tryFollowCommand(packet: Record<string, unknown>): string | undefined {
	try {
		return gardenWorkflowFollowSuggestedCommand(packet, { output: "packet" });
	} catch {
		return undefined;
	}
}

function tryChoiceCommand(
	packet: Record<string, unknown>,
	choiceId: string,
	intent: GardenWorkflowHandoffIntent | undefined,
): string | undefined {
	try {
		return gardenWorkflowChoiceCommand(packet, choiceId, { handoffIntent: intent, output: "packet" });
	} catch {
		return undefined;
	}
}

function tryRouteCommand(
	packet: Record<string, unknown>,
	routeId: string,
	intent: GardenWorkflowHandoffIntent | undefined,
): string | undefined {
	try {
		return gardenWorkflowRouteCommand(packet, routeId, { handoffIntent: intent, output: "packet" });
	} catch {
		return undefined;
	}
}

function handoffNextChoice(
	packet: Record<string, unknown>,
	choices: GardenWorkflowPacketChoice[],
	options: GardenWorkflowTranscriptHandoffOptions,
): { choice: GardenWorkflowPacketChoice; source: HandoffNextChoiceSource; rationale?: string } | undefined {
	if (options.preferredNextChoiceId) {
		const preferred = choices.find((choice) => choice.id === options.preferredNextChoiceId);
		if (preferred) {
			return {
				choice: preferred,
				source: preferred.suggested ? "garden-suggested" : "handoff-preferred",
			};
		}
	}
	const intentRecommendation = packetIntentRecommendation(packet, choices);
	if (intentRecommendationMatches(intentRecommendation, options.intent)) {
		const recommended = choices.find((choice) => choice.id === intentRecommendation.choiceId);
		if (recommended) {
			return {
				choice: recommended,
				source: "garden-intent-recommendation",
				rationale: intentRecommendation.rationale,
			};
		}
	}
	const preferredChoiceId = handoffIntentChoiceId(options.intent, choices);
	if (preferredChoiceId) {
		const preferred = choices.find((choice) => choice.id === preferredChoiceId);
		if (preferred) {
			return {
				choice: preferred,
				source: preferred.suggested ? "garden-suggested" : "handoff-preferred",
			};
		}
	}
	const suggested = choices.find((choice) => choice.suggested);
	return suggested ? { choice: suggested, source: "garden-suggested" } : undefined;
}

function packetIntentRecommendation(
	packet: Record<string, unknown>,
	choices: GardenWorkflowPacketChoice[],
): GardenWorkflowIntentRecommendation | undefined {
	return intentRecommendationPacket(asRecord(packet.intentRecommendation), choices);
}

function intentRecommendationMatches(
	recommendation: GardenWorkflowIntentRecommendation | undefined,
	intent: GardenWorkflowHandoffIntent | undefined,
): recommendation is GardenWorkflowIntentRecommendation {
	if (!recommendation || !intent || intent === "suggested") return false;
	return recommendation.intent === intent;
}

function handoffIntentChoiceId(
	intent: GardenWorkflowHandoffIntent | undefined,
	choices: GardenWorkflowPacketChoice[],
): string | undefined {
	if (intent === "analysis-scout") {
		return firstChoiceId(choices, [
			"perception-map",
			"concept-phase-1",
			"enter-phases",
			"validate-graph",
			"raw-sparql",
		]);
	}
	if (intent === "run-prep") {
		return firstChoiceId(choices, ["validate-graph", "execute-async", "prepare-execute"]);
	}
	return undefined;
}

function firstChoiceId(choices: GardenWorkflowPacketChoice[], ids: string[]): string | undefined {
	for (const id of ids) {
		if (choices.some((choice) => choice.id === id)) return id;
	}
	return undefined;
}

function currentFacts(packet: Record<string, unknown>): GardenWorkflowPacketFact[] {
	return arrayValue(packet.facts)
		.map(factPacket)
		.filter((fact): fact is GardenWorkflowPacketFact => fact !== undefined);
}

function currentWarnings(packet: Record<string, unknown>): string[] {
	return arrayValue(packet.warnings)
		.map(shortValue)
		.filter((warning): warning is string => Boolean(warning));
}

function currentObjects(packet: Record<string, unknown>): GardenWorkflowPacketObject[] {
	return arrayValue(packet.objects)
		.map(objectPacket)
		.filter((object): object is GardenWorkflowPacketObject => object !== undefined);
}

function currentSections(packet: Record<string, unknown>): GardenWorkflowPacketSection[] {
	return arrayValue(packet.sections)
		.map(asRecord)
		.filter((section): section is Record<string, unknown> => section !== undefined)
		.map(sectionPacket)
		.filter((section): section is GardenWorkflowPacketSection => section !== undefined);
}

function currentChoices(packet: Record<string, unknown>): GardenWorkflowPacketChoice[] {
	return arrayValue(packet.choices)
		.map(packetChoiceRecord)
		.filter((choice): choice is GardenWorkflowPacketChoice => choice !== undefined);
}

function currentRoutes(packet: Record<string, unknown>): GardenWorkflowNavigationRoute[] {
	const choices = currentChoices(packet);
	return arrayValue(packet.navigationRoutes)
		.map((route) => navigationRoutePacket(route, choices))
		.filter((route): route is GardenWorkflowNavigationRoute => route !== undefined);
}

function recommendedNextActionRecord(value: unknown): Record<string, unknown> | undefined {
	const action = asRecord(value);
	return stringValue(action?.kind) ? action : undefined;
}

function workflowRoutePacket(packet: Record<string, unknown>, routeId: string): GardenWorkflowNavigationRoute {
	const route = currentRoutes(packet).find((candidate) => candidate.id === routeId);
	if (!route) throw new Error(`choice packet does not contain route '${routeId}'`);
	return route;
}

function routeForChoice(
	packet: Record<string, unknown>,
	choiceId: string,
	intent: GardenWorkflowHandoffIntent | undefined,
): GardenWorkflowNavigationRoute | undefined {
	const routes = currentRoutes(packet).filter((route) => route.choiceId === choiceId);
	if (intent) {
		return routes.find((route) => route.intent === intent || route.id === intent) ?? routes[0];
	}
	return routes[0];
}

function routeActionIntent(route: GardenWorkflowNavigationRoute): GardenWorkflowHandoffIntent | undefined {
	const value = stringValue(route.action?.arguments?.handoffIntent) ?? route.intent;
	return handoffIntentValue(value);
}

function handoffIntentValue(value: string | undefined): GardenWorkflowHandoffIntent | undefined {
	if (value === "analysis-scout" || value === "run-prep") return value;
	return undefined;
}

function packetChoiceRecord(value: unknown): GardenWorkflowPacketChoice | undefined {
	const choice = asRecord(value);
	const id = stringValue(choice?.id);
	if (!choice || !id) return undefined;
	return compactRecord({
		id,
		label: stringValue(choice.label) ?? id,
		kind: stringValue(choice.kind),
		targetPageId: stringValue(choice.targetPageId),
		description: stringValue(choice.description),
		suggested: choice.suggested === true,
		requiresExplicitAuthorization: choice.requiresExplicitAuthorization === true ? true : undefined,
		authorizationReason: stringValue(choice.authorizationReason),
		action: choice.action,
	});
}

function pageTurnDecisionRow(row: Record<string, unknown>): GardenPageTurnDecisionRow {
	const subject = termLexical(row.decision) ?? "unknown-decision";
	return compactRecord({
		subject,
		generatedAt: termLexical(row.generatedAt),
		graphId: termLexical(row.graphId),
		workflowName: termLexical(row.workflowName),
		fromPage: termLexical(row.fromPage),
		intent: termLexical(row.intent),
		readiness: termLexical(row.readiness),
		nativeSuggestedChoice: termLexical(row.nativeSuggestedChoice),
		recommendedRoute: termLexical(row.recommendedRoute),
		recommendedRouteLabel: termLexical(row.recommendedRouteLabel),
		recommendedChoice: termLexical(row.recommendedChoice),
		followedRoute: termLexical(row.followedRoute),
		followedRouteLabel: termLexical(row.followedRouteLabel),
		followedChoice: termLexical(row.followedChoice),
		followedChoiceLabel: termLexical(row.followedChoiceLabel),
		executionAuthorized: booleanTerm(row.executionAuthorized),
		authorizationFlagCount: integerTerm(row.authorizationFlagCount),
		rationale: termLexical(row.rationale),
	});
}

function routeLabel(routeId: string | undefined, label: string | undefined): string | undefined {
	if (!routeId) return undefined;
	return label ? `${routeId} - ${label}` : routeId;
}

function choiceLabel(choiceId: string | undefined, label: string | undefined): string | undefined {
	if (!choiceId) return undefined;
	return label ? `${choiceId} - ${label}` : choiceId;
}

function pageTurnDecisionDetailFromRows(
	graphId: string,
	subject: string,
	query: string,
	rows: Record<string, unknown>[],
): GardenPageTurnDecisionDetail {
	const decision = rows.length > 0 ? pageTurnDecisionRow(rows[0]) : undefined;
	const evidence = new Map<string, GardenPageTurnDecisionEvidence>();
	const navigationRoutes = new Map<string, GardenPageTurnDecisionNavigationRoute>();
	const flags = new Map<string, GardenPageTurnDecisionAuthorizationFlag>();
	for (const row of rows) {
		const evidenceSubject = termLexical(row.evidence);
		if (evidenceSubject && !evidence.has(evidenceSubject)) {
			evidence.set(
				evidenceSubject,
				compactRecord({
					subject: evidenceSubject,
					role: termLexical(row.evidenceRole),
					path: termLexical(row.evidencePath),
				}),
			);
		}
		const routeSubject = termLexical(row.navigationRoute);
		if (routeSubject && !navigationRoutes.has(routeSubject)) {
			navigationRoutes.set(
				routeSubject,
				compactRecord({
					subject: routeSubject,
					routeId: termLexical(row.routeId),
					routeLabel: termLexical(row.routeLabel),
					routeKind: termLexical(row.routeKind),
					intent: termLexical(row.routeIntent),
					choiceId: termLexical(row.routeChoiceId),
					choiceLabel: termLexical(row.routeChoiceLabel),
					source: termLexical(row.routeSource),
					rationale: termLexical(row.routeRationale),
					actionJson: termLexical(row.routeActionJson),
					routeAction: termLexical(row.routeAction),
					actionTool: termLexical(row.routeActionTool),
					actionKind: termLexical(row.routeActionKind),
					commandTemplate: termLexical(row.routeCommandTemplate),
					argumentHash: termLexical(row.routeArgumentHash),
				}),
			);
		}
		const flagSubject = termLexical(row.flag);
		if (flagSubject && !flags.has(flagSubject)) {
			flags.set(
				flagSubject,
				compactRecord({
					subject: flagSubject,
					pageId: termLexical(row.flagPageId),
					choiceId: termLexical(row.flagChoiceId),
					reason: termLexical(row.flagReason),
				}),
			);
		}
	}
	return {
		kind: "gardenPageTurnDecisionDetail",
		graphId,
		subject,
		query,
		decision,
		evidence: [...evidence.values()],
		navigationRoutes: [...navigationRoutes.values()],
		authorizationFlags: [...flags.values()],
	};
}

function sparqlRows(result: unknown): Record<string, unknown>[] {
	return arrayValue(asRecord(result)?.rows)
		.map(asRecord)
		.filter((row): row is Record<string, unknown> => row !== undefined);
}

function normalizeDecisionLimit(value: number | undefined): number {
	const limit = value === undefined ? 25 : Math.trunc(value);
	if (!Number.isFinite(limit) || limit < 1) return 25;
	return Math.min(limit, 100);
}

function termLexical(value: unknown): string | undefined {
	if (typeof value !== "string" || value.length === 0) return undefined;
	if (value.startsWith("<") && value.endsWith(">")) return value.slice(1, -1);
	const literal = value.match(/^"((?:\\.|[^"\\])*)"(?:\^\^<[^>]+>|@[A-Za-z0-9-]+)?$/);
	if (literal) return unescapeSparqlLiteral(literal[1] ?? "");
	return value;
}

function normalizeIri(value: string): string {
	const trimmed = value.trim();
	if (trimmed.startsWith("<") && trimmed.endsWith(">")) return trimmed.slice(1, -1);
	return trimmed;
}

function sparqlIri(value: string): string {
	return `<${value.replace(/>/g, "%3E")}>`;
}

function booleanTerm(value: unknown): boolean | undefined {
	const lexical = termLexical(value);
	if (lexical === "true") return true;
	if (lexical === "false") return false;
	return undefined;
}

function integerTerm(value: unknown): number | undefined {
	const lexical = termLexical(value);
	if (!lexical || !/^-?\d+$/.test(lexical)) return undefined;
	return Number(lexical);
}

function unescapeSparqlLiteral(value: string): string {
	return value
		.replace(/\\n/g, "\n")
		.replace(/\\r/g, "\r")
		.replace(/\\t/g, "\t")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");
}

function currentNextActions(packet: Record<string, unknown>): GardenWorkflowPacketAction[] {
	return arrayValue(packet.nextActions)
		.map((action) => actionPacket(asRecord(action)))
		.filter((action): action is GardenWorkflowPacketAction => action !== undefined);
}

function handoffNextRationale(
	packet: Record<string, unknown>,
	choice: GardenWorkflowPacketChoice,
	source: HandoffNextChoiceSource,
	intent: GardenWorkflowHandoffIntent | undefined,
): string {
	if (source === "garden-intent-recommendation") {
		return `Garden's native intent recommendation selects '${choice.id}' for '${intent ?? "unspecified"}'.`;
	}
	if (source === "handoff-preferred" && intent === "analysis-scout") {
		const suggested = stringValue(asRecord(packet.suggestedChoice)?.id);
		return [
			"handoff intent is analysis-scout",
			"prefer perceptual/conceptual orientation before any execute route",
			suggested ? `Garden's current suggested choice remains '${suggested}' and is still visible` : undefined,
		]
			.filter(Boolean)
			.join("; ")
			.concat(".");
	}
	if (source === "handoff-preferred" && choice.id) {
		return `Handoff preference selects '${choice.id}' for this launch context.`;
	}
	return suggestedNextRationale(packet, choice);
}

function suggestedNextRationale(packet: Record<string, unknown>, choice: GardenWorkflowPacketChoice): string {
	const status = stringValue(packet.status);
	const validation = asRecord(packet.validation);
	const validationSummary = stringValue(validation?.summary);
	const validationPassed = typeof validation?.passed === "boolean" ? validation.passed : undefined;
	const page = asRecord(packet.page);
	const pageId = stringValue(page?.id);
	const target = choice.targetPageId;
	const fragments = [
		status ? `current status is ${status}` : undefined,
		validationPassed !== undefined ? `validation ${validationPassed ? "passes" : "does not pass"}` : undefined,
		validationSummary,
		target
			? `the workflow book marks '${choice.id}' as the suggested route from ${pageId ?? "the current page"} to ${target}`
			: undefined,
	].filter(Boolean);
	return fragments.length > 0
		? `${fragments.join("; ")}.`
		: `The workflow book marks '${choice.id}' as the suggested next choice.`;
}

function expectedNextPage(choice: GardenWorkflowPacketChoice): string | undefined {
	if (!choice.targetPageId) return undefined;
	if (choice.targetPageId === "perception") {
		return "Perception map with visible workflow anatomy, conceptual phase/agent routes, and raw-SPARQL actions.";
	}
	if (choice.targetPageId === "execute") {
		return "Execute page with explicit run-preparation/submission choices; inspect it before starting a run.";
	}
	return `${choice.targetPageId} page.`;
}

function suggestedNextSafetyBoundary(choice: GardenWorkflowPacketChoice): string | undefined {
	const text = [choice.id, choice.label, choice.kind, choice.targetPageId].filter(Boolean).join(" ").toLowerCase();
	if (!/\b(execute|run|submit|async)\b/.test(text)) return undefined;
	if (choice.targetPageId === "execute" || choice.kind === "navigate") {
		return "This page turn is navigation/preparation only. Do not submit or start extractor/adjudicator agents unless explicitly authorized.";
	}
	return "This choice may lead toward execution. Inspect the next page/action and stop before starting a run unless explicitly authorized.";
}

function nextActionCommand(
	action: Record<string, unknown>,
	commandPrefix: string[],
	options: GardenWorkflowFollowCommandOptions,
): string {
	const tool = stringValue(action.tool);
	const args = asRecord(action.arguments) ?? {};
	if (tool === "get_job_status") {
		return shellCommand([
			...commandPrefix,
			"job-status",
			...requiredFlag(
				"--job",
				stringValue(args.jobId) ?? stringValue(args.job_id),
				"job status action missing jobId",
			),
			...sessionConnectionFlags(options),
			...outputFlags(options.output),
		]);
	}
	if (tool === "get_job_result") {
		return shellCommand([
			...commandPrefix,
			"job-result",
			...requiredFlag(
				"--job",
				stringValue(args.jobId) ?? stringValue(args.job_id),
				"job result action missing jobId",
			),
			...sessionConnectionFlags(options),
			...outputFlags(options.output),
		]);
	}
	if (tool === "workflow_authoring_session") {
		return shellCommand([
			...commandPrefix,
			...workflowAuthoringActionCommand(args),
			...sessionConnectionFlags(options),
			...outputFlags(options.output),
		]);
	}
	throw new Error(`unsupported next action tool: ${tool ?? "unknown"}`);
}

function nextActionSessionRequest(action: Record<string, unknown>): GardenWorkflowSessionRequest {
	const tool = stringValue(action.tool);
	const args = asRecord(action.arguments) ?? {};
	if (tool !== "workflow_authoring_session") {
		throw new Error(`suggested action ${tool ?? "unknown"} cannot be executed as a workflow session page turn`);
	}
	return workflowAuthoringActionSessionRequest(args);
}

function workflowAuthoringActionSessionRequest(args: Record<string, unknown>): GardenWorkflowSessionRequest {
	const operation = stringValue(args.operation);
	const graphId = requiredValue(stringValue(args.graphId), "workflow_authoring_session action missing graphId");
	const workflowName = stringValue(args.workflowName);
	const pageId = stringValue(args.pageId);
	const common = {
		graphId,
		workflowName,
		pageId,
		runId: stringValue(args.runId),
		since: numberValue(args.since),
		pollMs: numberValue(args.pollMs),
		timeoutMs: numberValue(args.timeoutMs),
		maxTicks: numberValue(args.maxTicks),
		includeEvents: booleanValue(args.includeEvents),
		monitorLatest: booleanValue(args.monitorLatest),
		resolveOnChange: booleanValue(args.resolveOnChange),
		executionChoiceId: stringValue(args.executionChoiceId),
	};
	switch (operation) {
		case "status":
			return { ...common, operation: "status" };
		case "choose":
			return {
				...common,
				operation: "choose",
				choiceId: requiredValue(
					stringValue(args.choiceId),
					"workflow_authoring_session choose action missing choiceId",
				),
			};
		case "validate":
		case "watch":
		case "await":
		case "execute":
		case "monitor":
			return { ...common, operation };
		case "background": {
			const mode = stringValue(args.mode);
			if (mode !== "await" && mode !== "validate") {
				throw new Error(`unsupported workflow_authoring_session background mode: ${mode ?? "unknown"}`);
			}
			return { ...common, operation: "background", mode };
		}
		case "prepare_execute":
			return { ...common, operation: "prepare_execute" };
		default:
			throw new Error(`unsupported workflow_authoring_session operation: ${operation ?? "unknown"}`);
	}
}

function workflowAuthoringActionCommand(args: Record<string, unknown>): string[] {
	const operation = stringValue(args.operation);
	const graphId = stringValue(args.graphId);
	const workflowName = stringValue(args.workflowName);
	const pageId = stringValue(args.pageId);
	const common = [
		...requiredFlag("--graph", graphId, "workflow_authoring_session action missing graphId"),
		...optionalFlag("--workflow", workflowName),
		...optionalFlag("--page", pageId),
	];
	switch (operation) {
		case "status":
			return [workflowName ? "open" : "list", ...common];
		case "choose":
			return [
				"choose",
				...common,
				...requiredFlag(
					"--choice",
					stringValue(args.choiceId),
					"workflow_authoring_session choose action missing choiceId",
				),
			];
		case "validate":
		case "watch":
		case "await":
		case "execute":
		case "monitor":
			return [
				operation,
				...common,
				...optionalFlag("--run-id", stringValue(args.runId)),
				...optionalNumberFlag("--since", args.since),
				...optionalNumberFlag("--poll-ms", args.pollMs),
				...optionalNumberFlag("--timeout-ms", args.timeoutMs),
				...optionalNumberFlag("--max-ticks", args.maxTicks),
			];
		case "background": {
			const mode = stringValue(args.mode);
			if (mode !== "await" && mode !== "validate") {
				throw new Error(`unsupported workflow_authoring_session background mode: ${mode ?? "unknown"}`);
			}
			return [
				mode === "await" ? "background-await" : "background-validate",
				...common,
				...optionalNumberFlag("--since", args.since),
				...optionalNumberFlag("--poll-ms", args.pollMs),
				...optionalNumberFlag("--timeout-ms", args.timeoutMs),
				...optionalNumberFlag("--max-ticks", args.maxTicks),
			];
		}
		case "prepare_execute":
			return ["prepare", ...common];
		default:
			throw new Error(`unsupported workflow_authoring_session operation: ${operation ?? "unknown"}`);
	}
}

function sessionConnectionFlags(options: GardenWorkflowFollowCommandOptions): string[] {
	return [...optionalFlag("--mcp-url", options.mcpUrl), ...optionalFlag("--token", options.token)];
}

function outputFlags(output: GardenWorkflowFollowCommandOptions["output"]): string[] {
	if (output === "json") return ["--json"];
	if (output === "packet") return ["--packet"];
	return [];
}

function requiredFlag(flag: string, value: string | undefined, message: string): string[] {
	if (!value) throw new Error(message);
	return [flag, value];
}

function requiredValue<T>(value: T | undefined, message: string): T {
	if (value === undefined) throw new Error(message);
	return value;
}

function optionalFlag(flag: string, value: string | undefined): string[] {
	return value ? [flag, value] : [];
}

function optionalNumberFlag(flag: string, value: unknown): string[] {
	return typeof value === "number" && Number.isFinite(value) ? [flag, String(value)] : [];
}

function shellCommand(args: string[]): string {
	return args.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function appendKey(lines: string[], key: string, value: string | undefined): void {
	if (value) lines.push(`${key}: ${value}`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function shortValue(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return undefined;
	return JSON.stringify(value);
}
