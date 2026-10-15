import { createHash } from "node:crypto";
import type { WorkflowBook, WorkflowBookChoice, WorkflowBookPage } from "./book.js";

const WFUI_NS = "https://sophia-labs.com/ns/workflow-ui#";
const WF_NS = "http://mnemosyne.dev/workflow#";

export type WorkflowAdventureIntent = "suggested" | "analysis-scout" | "run-prep" | "raw-sparql" | "validation";

export interface WorkflowAdventurePacketInput {
	book: WorkflowBook;
	workflowPath?: string;
	argsPath?: string;
	graphId?: string;
	pageId?: string;
	routeId?: string;
	intent?: WorkflowAdventureIntent;
	generatedAt?: string;
}

export interface WorkflowAdventurePacket {
	kind: "workflowAdventurePacket";
	schemaVersion: 1;
	id?: string;
	rdfSubjectIri?: string;
	legacyRdfSubjectIri?: string;
	generatedAt: string;
	workflowName: string;
	workflowPath?: string;
	argsPath?: string;
	graphId?: string;
	intent: WorkflowAdventureIntent;
	page: {
		id: string;
		title: string;
		scene: string;
	};
	fromPage?: {
		id: string;
		title: string;
	};
	followedRoute?: WorkflowAdventureNavigationRoute;
	perception: {
		objects: string[];
		warnings: string[];
	};
	concepts: WorkflowAdventureConcept[];
	choices: WorkflowAdventureChoice[];
	suggestedChoice?: WorkflowAdventureChoice;
	navigationRoutes: WorkflowAdventureNavigationRoute[];
	recommendedNextAction?: WorkflowAdventureRecommendedNextAction;
	raw: {
		sparql: Array<{ title: string; query: string }>;
	};
}

export interface WorkflowAdventureConcept {
	kind: "phase" | "agent" | "contract" | "model" | "toolMode" | "capability" | "rdf" | "endpoint" | "unknown";
	id: string;
	label: string;
}

export interface WorkflowAdventureChoice {
	id: string;
	label: string;
	kind: string;
	targetPageId?: string;
	description?: string;
	suggested: boolean;
	requiresExplicitAuthorization?: boolean;
	authorizationReason?: string;
	action?: string;
	payload?: Record<string, unknown>;
}

export interface WorkflowAdventureNavigationRoute {
	id: string;
	label: string;
	kind: "intent" | "object" | "validation" | "run-prep" | "raw-sparql" | "back";
	choiceId: string;
	choiceLabel?: string;
	targetPageId?: string;
	intent?: WorkflowAdventureIntent;
	rationale: string;
	requiresExplicitAuthorization?: boolean;
	authorizationReason?: string;
	action: WorkflowAdventureAction;
}

export interface WorkflowAdventureAction {
	tool: "workflow_compose_adventure" | "sparql_query";
	arguments: Record<string, unknown>;
	text: string;
}

export interface WorkflowAdventureRecommendedNextAction {
	kind: "follow-route" | "choose";
	source: "intent-route" | "suggested-route" | "suggested-choice";
	routeId?: string;
	routeLabel?: string;
	choiceId: string;
	choiceLabel?: string;
	targetPageId?: string;
	rationale?: string;
	requiresExplicitAuthorization?: boolean;
	authorizationReason?: string;
	commandTemplate: string;
	action: WorkflowAdventureAction;
}

export function workflowAdventurePacket(input: WorkflowAdventurePacketInput): WorkflowAdventurePacket {
	const intent = input.intent ?? "analysis-scout";
	const startPage = findPage(input.book, input.pageId ?? input.book.startPageId);
	const startRoutes = workflowAdventureRoutes(input.book, startPage, input);
	const followedRoute = input.routeId ? findRoute(startRoutes, input.routeId, startPage.id) : undefined;
	const page = followedRoute?.targetPageId ? findPage(input.book, followedRoute.targetPageId) : startPage;
	const routes = workflowAdventureRoutes(input.book, page, input);
	const recommendation = workflowAdventureRecommendation(input, page, routes, intent);
	const choices = page.choices.map((choice) => workflowAdventureChoice(choice, recommendation?.choiceId));
	const packet: WorkflowAdventurePacket = {
		kind: "workflowAdventurePacket",
		schemaVersion: 1,
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		workflowName: input.book.workflow.name,
		workflowPath: input.workflowPath,
		argsPath: input.argsPath,
		graphId: input.graphId,
		intent,
		page: {
			id: page.id,
			title: page.title,
			scene: page.scene,
		},
		...(followedRoute
			? {
					fromPage: {
						id: startPage.id,
						title: startPage.title,
					},
					followedRoute,
				}
			: {}),
		perception: {
			objects: page.objects,
			warnings: page.warnings,
		},
		concepts: page.objects.map(workflowAdventureConcept),
		choices,
		suggestedChoice: choices.find((choice) => choice.id === recommendation?.choiceId),
		navigationRoutes: routes,
		recommendedNextAction: recommendation,
		raw: {
			sparql: input.book.raw.sparql,
		},
	};
	const rdfSubjectIri = workflowAdventureSubjectIri(packet);
	const legacyRdfSubjectIri = workflowAdventureLegacySubjectIri(packet);
	return {
		...packet,
		id: rdfSubjectIri,
		rdfSubjectIri,
		legacyRdfSubjectIri,
	};
}

export function renderWorkflowAdventureMarkdown(packet: WorkflowAdventurePacket): string {
	const lines = [
		`# Workflow Adventure - ${packet.workflowName} / ${packet.page.title}`,
		"",
		`Generated: ${packet.generatedAt}`,
		`RDF subject: ${packet.rdfSubjectIri ?? workflowAdventureSubjectIri(packet)}`,
		`Page: ${packet.page.id}`,
		`Intent: ${packet.intent}`,
		...(packet.graphId ? [`Graph: ${packet.graphId}`] : []),
		...(packet.workflowPath ? [`Workflow source: ${packet.workflowPath}`] : []),
		...(packet.argsPath ? [`Arguments: ${packet.argsPath}`] : []),
		...(packet.followedRoute
			? [
					`Followed route: ${packet.followedRoute.id} -> ${packet.followedRoute.choiceId}${packet.followedRoute.targetPageId ? ` -> ${packet.followedRoute.targetPageId}` : ""}`,
				]
			: []),
		"",
		"## Scene",
		packet.page.scene,
		"",
		"## Perception",
		...renderList("Objects", packet.perception.objects),
		...renderList("Warnings", packet.perception.warnings),
		"",
		"## Concepts",
		...(packet.concepts.length === 0
			? ["- No explicit concepts on this page."]
			: packet.concepts.map((concept) => `- ${concept.kind}:${concept.id} - ${concept.label}`)),
		"",
		"## Routes",
	];
	if (packet.navigationRoutes.length === 0) {
		lines.push("- No named routes on this page.");
	} else {
		for (const route of packet.navigationRoutes) {
			const flags = [
				route.targetPageId ? `target=${route.targetPageId}` : undefined,
				route.requiresExplicitAuthorization ? "authorization=required" : undefined,
			]
				.filter(Boolean)
				.join("; ");
			lines.push(`- ${route.id}: ${route.label} -> ${route.choiceId}${flags ? ` (${flags})` : ""}`);
			lines.push(`  ${route.rationale}`);
			lines.push(`  Command: \`${route.action.text}\``);
		}
	}
	lines.push("", "## Choices");
	for (const choice of packet.choices) {
		const flags = [
			choice.suggested ? "suggested" : undefined,
			choice.targetPageId ? `target=${choice.targetPageId}` : undefined,
			choice.requiresExplicitAuthorization ? "authorization=required" : undefined,
		]
			.filter(Boolean)
			.join("; ");
		lines.push(`- ${choice.id}: ${choice.label} [${choice.kind}]${flags ? ` (${flags})` : ""}`);
		if (choice.description) lines.push(`  ${choice.description}`);
	}
	if (packet.recommendedNextAction) {
		lines.push("", "## Recommended Next Action");
		lines.push(`Kind: ${packet.recommendedNextAction.kind}`);
		lines.push(`Source: ${packet.recommendedNextAction.source}`);
		if (packet.recommendedNextAction.routeId) {
			lines.push(`Route: ${packet.recommendedNextAction.routeId}`);
		}
		lines.push(`Choice: ${packet.recommendedNextAction.choiceId}`);
		if (packet.recommendedNextAction.requiresExplicitAuthorization) {
			lines.push(
				`Authorization: required${packet.recommendedNextAction.authorizationReason ? ` - ${packet.recommendedNextAction.authorizationReason}` : ""}`,
			);
		}
		if (packet.recommendedNextAction.rationale) lines.push(`Rationale: ${packet.recommendedNextAction.rationale}`);
		lines.push(`Command: \`${packet.recommendedNextAction.commandTemplate}\``);
	}
	lines.push("", "## Raw SPARQL");
	for (const query of packet.raw.sparql) {
		lines.push(`- ${query.title}`);
	}
	return `${lines
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()}\n`;
}

export function workflowAdventureSubjectIri(
	packet: Pick<
		WorkflowAdventurePacket,
		| "graphId"
		| "workflowName"
		| "page"
		| "intent"
		| "fromPage"
		| "followedRoute"
		| "perception"
		| "navigationRoutes"
		| "recommendedNextAction"
		| "raw"
	>,
): string {
	const hash = sha256Text(canonicalJson(workflowPageViewIdentityPayload(packet))).slice(0, 32);
	return [
		"urn:sophia:wf:page-view",
		stableToken(packet.graphId ?? "unknown-graph"),
		stableToken(packet.workflowName),
		stableToken(packet.page.id),
		stableToken(packet.intent),
		hash,
	].join(":");
}

export function workflowAdventureLegacySubjectIri(
	packet: Pick<WorkflowAdventurePacket, "graphId" | "workflowName" | "page" | "intent">,
): string {
	return [
		"urn:sophia:workflow-adventure",
		stableToken(packet.graphId ?? "unknown-graph"),
		stableToken(packet.workflowName),
		stableToken(packet.page.id),
		stableToken(packet.intent),
	].join(":");
}

export function renderWorkflowAdventureTurtle(packet: WorkflowAdventurePacket): string {
	const subjectIri = packet.rdfSubjectIri ?? workflowAdventureSubjectIri(packet);
	const legacySubjectIri = packet.legacyRdfSubjectIri ?? workflowAdventureLegacySubjectIri(packet);
	const subject = iri(subjectIri);
	const legacySubject = iri(legacySubjectIri);
	const flags = workflowAdventureAuthorizationFlags(packet);
	const pageViewPairs: Array<[string, string]> = [
		["a", "wf:PageView, prov:Entity"],
		["dcterms:identifier", str(packet.id ?? subjectIri)],
		["prov:generatedAtTime", dateTimeLit(packet.generatedAt)],
		["wf:schemaVersion", intLit(packet.schemaVersion)],
		["wf:intent", str(packet.intent)],
		["wf:workflowName", str(packet.workflowName)],
		["wf:pageId", str(packet.page.id)],
		["wf:pageTitle", str(packet.page.title)],
		["wf:pageScene", str(packet.page.scene)],
		["wf:visibleObjectCount", intLit(packet.perception.objects.length)],
		["wf:warningCount", intLit(packet.perception.warnings.length)],
		["wf:authorizationFlagCount", intLit(flags.length)],
		["wf:supersedesPageView", iri(legacySubjectIri)],
	];
	if (packet.graphId) pageViewPairs.push(["wf:graphId", str(packet.graphId)]);
	if (packet.workflowPath) pageViewPairs.push(["wf:workflowPath", str(packet.workflowPath)]);
	if (packet.argsPath) pageViewPairs.push(["wf:argsPath", str(packet.argsPath)]);
	if (packet.fromPage) pageViewPairs.push(["wf:fromPage", str(packet.fromPage.id)]);
	if (packet.followedRoute) pageViewPairs.push(["wf:followedRouteId", str(packet.followedRoute.id)]);
	if (packet.recommendedNextAction) {
		pageViewPairs.push(["wf:recommendedAction", iri(adventureRecommendedActionIri(subjectIri))]);
	}
	for (let i = 0; i < packet.raw.sparql.length; i++) {
		pageViewPairs.push(["wf:hasRawSparqlQuery", iri(adventureRawSparqlQueryIri(subjectIri, i))]);
	}
	for (const route of packet.navigationRoutes) {
		pageViewPairs.push(["wf:hasNavigationRoute", iri(adventureRouteIri(subjectIri, route.id))]);
	}
	for (let i = 0; i < flags.length; i++) {
		pageViewPairs.push(["wf:hasAuthorizationFlag", iri(adventureAuthorizationFlagIri(subjectIri, i))]);
	}

	const legacyPairs: Array<[string, string]> = [
		["a", "wfui:WorkflowAdventurePacket, prov:Entity"],
		["dcterms:identifier", str(legacySubjectIri)],
		["prov:generatedAtTime", dateTimeLit(packet.generatedAt)],
		["wfui:schemaVersion", intLit(packet.schemaVersion)],
		["wfui:intent", str(packet.intent)],
		["wfui:workflowName", str(packet.workflowName)],
		["wfui:pageId", str(packet.page.id)],
		["wfui:pageTitle", str(packet.page.title)],
		["wfui:pageScene", str(packet.page.scene)],
		["wfui:visibleObjectCount", intLit(packet.perception.objects.length)],
		["wfui:warningCount", intLit(packet.perception.warnings.length)],
		["wfui:rawSparqlJson", str(canonicalJson(packet.raw.sparql))],
		["wfui:authorizationFlagCount", intLit(flags.length)],
	];
	if (packet.graphId) legacyPairs.push(["wfui:graphId", str(packet.graphId)]);
	if (packet.workflowPath) legacyPairs.push(["wfui:workflowPath", str(packet.workflowPath)]);
	if (packet.argsPath) legacyPairs.push(["wfui:argsPath", str(packet.argsPath)]);
	if (packet.fromPage) legacyPairs.push(["wfui:fromPage", str(packet.fromPage.id)]);
	if (packet.followedRoute) legacyPairs.push(["wfui:followedRouteId", str(packet.followedRoute.id)]);
	if (packet.recommendedNextAction?.routeId) {
		legacyPairs.push(["wfui:recommendedRouteId", str(packet.recommendedNextAction.routeId)]);
	}
	if (packet.recommendedNextAction?.routeLabel) {
		legacyPairs.push(["wfui:recommendedRouteLabel", str(packet.recommendedNextAction.routeLabel)]);
	}
	if (packet.recommendedNextAction?.choiceId) {
		legacyPairs.push(["wfui:recommendedChoiceId", str(packet.recommendedNextAction.choiceId)]);
	}
	for (const route of packet.navigationRoutes) {
		legacyPairs.push(["wfui:hasNavigationRoute", iri(adventureRouteIri(legacySubjectIri, route.id))]);
	}
	for (let i = 0; i < flags.length; i++) {
		legacyPairs.push(["wfui:hasAuthorizationFlag", iri(adventureAuthorizationFlagIri(legacySubjectIri, i))]);
	}

	const blocks = [
		`@prefix wf: <${WF_NS}> .`,
		`@prefix wfui: <${WFUI_NS}> .`,
		"@prefix prov: <http://www.w3.org/ns/prov#> .",
		"@prefix dcterms: <http://purl.org/dc/terms/> .",
		"@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .",
		"",
		stmt(subject, pageViewPairs),
		stmt(legacySubject, legacyPairs),
	];

	for (let i = 0; i < packet.raw.sparql.length; i++) {
		const query = packet.raw.sparql[i];
		const queryPairs: Array<[string, string]> = [
			["a", "wf:RawSparqlQuery, prov:Entity"],
			["wf:queryTitle", str(query.title)],
			["wf:queryText", str(query.query)],
			["wf:queryOrder", intLit(i + 1)],
			["wf:partOfPageView", subject],
		];
		if (packet.graphId) queryPairs.push(["wf:queryGraph", str(packet.graphId)]);
		blocks.push(stmt(iri(adventureRawSparqlQueryIri(subjectIri, i)), queryPairs));
	}

	for (const route of packet.navigationRoutes) {
		const routeIri = adventureRouteIri(subjectIri, route.id);
		const actionIri = adventureRouteActionIri(subjectIri, route.id);
		const routePairs: Array<[string, string]> = [
			["a", "wf:NavigationRoute, prov:Entity"],
			["wf:routeId", str(route.id)],
			["wf:routeLabel", str(route.label)],
			["wf:routeKind", str(route.kind)],
			["wf:choiceId", str(route.choiceId)],
			["wf:source", str("workflow-page-view")],
			["wf:rationale", str(route.rationale)],
			["wf:routeAction", iri(actionIri)],
		];
		if (packet.graphId) routePairs.push(["wf:graphId", str(packet.graphId)]);
		routePairs.push(["wf:workflowName", str(packet.workflowName)]);
		routePairs.push(["wf:fromPage", str(packet.page.id)]);
		if (route.intent) routePairs.push(["wf:intent", str(route.intent)]);
		if (route.choiceLabel) routePairs.push(["wf:choiceLabel", str(route.choiceLabel)]);
		blocks.push(stmt(iri(routeIri), routePairs));
		blocks.push(renderRouteActionBlock(actionIri, route.action));

		const legacyRoutePairs: Array<[string, string]> = [
			["a", "wfui:NavigationRoute, prov:Entity"],
			["wfui:routeId", str(route.id)],
			["wfui:routeLabel", str(route.label)],
			["wfui:routeKind", str(route.kind)],
			["wfui:choiceId", str(route.choiceId)],
			["wfui:source", str("workflow-adventure-packet")],
			["wfui:rationale", str(route.rationale)],
			["wfui:actionJson", str(canonicalJson(route.action))],
		];
		if (packet.graphId) legacyRoutePairs.push(["wfui:graphId", str(packet.graphId)]);
		legacyRoutePairs.push(["wfui:workflowName", str(packet.workflowName)]);
		legacyRoutePairs.push(["wfui:fromPage", str(packet.page.id)]);
		if (route.intent) legacyRoutePairs.push(["wfui:intent", str(route.intent)]);
		if (route.choiceLabel) legacyRoutePairs.push(["wfui:choiceLabel", str(route.choiceLabel)]);
		blocks.push(stmt(iri(adventureRouteIri(legacySubjectIri, route.id)), legacyRoutePairs));
	}

	if (packet.recommendedNextAction) {
		const recommendation = packet.recommendedNextAction;
		const recommendationPairs: Array<[string, string]> = [
			["a", "wf:RecommendedAction, prov:Entity"],
			["wf:recommendationSource", str(recommendation.source)],
			["wf:recommendedChoice", str(recommendation.choiceId)],
			["wf:commandTemplate", str(recommendation.commandTemplate)],
			["wf:actionTool", str(recommendation.action.tool)],
		];
		if (recommendation.routeId) recommendationPairs.push(["wf:recommendedRoute", str(recommendation.routeId)]);
		if (recommendation.choiceLabel) recommendationPairs.push(["wf:choiceLabel", str(recommendation.choiceLabel)]);
		if (recommendation.routeLabel) recommendationPairs.push(["wf:routeLabel", str(recommendation.routeLabel)]);
		if (recommendation.rationale) recommendationPairs.push(["wf:rationale", str(recommendation.rationale)]);
		blocks.push(stmt(iri(adventureRecommendedActionIri(subjectIri)), recommendationPairs));
	}

	for (let i = 0; i < flags.length; i++) {
		const flag = flags[i];
		blocks.push(
			stmt(iri(adventureAuthorizationFlagIri(subjectIri, i)), [
				["a", "wf:AuthorizationFlag, prov:Entity"],
				["wf:pageId", str(flag.pageId)],
				["wf:choiceId", str(flag.choiceId)],
				...(flag.reason ? ([["wf:authorizationReason", str(flag.reason)]] as Array<[string, string]>) : []),
			]),
		);
		blocks.push(
			stmt(iri(adventureAuthorizationFlagIri(legacySubjectIri, i)), [
				["a", "wfui:AuthorizationFlag, prov:Entity"],
				["wfui:pageId", str(flag.pageId)],
				["wfui:choiceId", str(flag.choiceId)],
				...(flag.reason ? ([["wfui:authorizationReason", str(flag.reason)]] as Array<[string, string]>) : []),
			]),
		);
	}

	return `${blocks
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()}\n`;
}

function workflowAdventureAuthorizationFlags(
	packet: WorkflowAdventurePacket,
): Array<{ pageId: string; choiceId: string; reason?: string }> {
	return packet.choices
		.filter((choice) => choice.requiresExplicitAuthorization)
		.map((choice) => ({
			pageId: packet.page.id,
			choiceId: choice.id,
			reason: choice.authorizationReason,
		}));
}

function workflowPageViewIdentityPayload(
	packet: Pick<
		WorkflowAdventurePacket,
		| "graphId"
		| "workflowName"
		| "page"
		| "intent"
		| "fromPage"
		| "followedRoute"
		| "perception"
		| "navigationRoutes"
		| "recommendedNextAction"
		| "raw"
	>,
): unknown {
	return {
		graphId: packet.graphId ?? null,
		workflowName: packet.workflowName,
		page: packet.page,
		intent: packet.intent,
		fromPage: packet.fromPage?.id ?? null,
		followedRoute: packet.followedRoute?.id ?? null,
		perception: packet.perception,
		rawSparql: packet.raw.sparql,
		navigationRoutes: packet.navigationRoutes.map((route) => ({
			id: route.id,
			label: route.label,
			kind: route.kind,
			choiceId: route.choiceId,
			choiceLabel: route.choiceLabel ?? null,
			targetPageId: route.targetPageId ?? null,
			intent: route.intent ?? null,
			rationale: route.rationale,
			requiresExplicitAuthorization: route.requiresExplicitAuthorization ?? false,
			authorizationReason: route.authorizationReason ?? null,
			actionHash: sha256Text(canonicalJson(route.action)),
		})),
		recommendedNextAction: packet.recommendedNextAction
			? {
					kind: packet.recommendedNextAction.kind,
					source: packet.recommendedNextAction.source,
					routeId: packet.recommendedNextAction.routeId ?? null,
					choiceId: packet.recommendedNextAction.choiceId,
					targetPageId: packet.recommendedNextAction.targetPageId ?? null,
					actionHash: sha256Text(canonicalJson(packet.recommendedNextAction.action)),
				}
			: null,
	};
}

function renderRouteActionBlock(actionIri: string, action: WorkflowAdventureAction): string {
	const pairs: Array<[string, string]> = [
		["a", "wf:RouteAction, prov:Entity"],
		["wf:actionTool", str(action.tool)],
		["wf:actionKind", str(action.tool)],
		["wf:commandTemplate", str(action.text)],
		["wf:argumentHash", str(sha256Text(canonicalJson(action.arguments)))],
	];
	const blocks = [stmt(iri(actionIri), pairs)];
	for (const [key, value] of Object.entries(action.arguments).sort(([a], [b]) => a.localeCompare(b))) {
		const argumentIri = adventureActionArgumentIri(actionIri, key);
		pairs.push(["wf:argument", iri(argumentIri)]);
		blocks.push(
			stmt(iri(argumentIri), [
				["a", "wf:ActionArgument, prov:Entity"],
				["wf:argumentName", str(key)],
				["wf:argumentValue", str(argumentValue(value))],
				["wf:partOfAction", iri(actionIri)],
			]),
		);
	}
	blocks[0] = stmt(iri(actionIri), pairs);
	return blocks.join("\n");
}

function argumentValue(value: unknown): string {
	return typeof value === "string" ? value : canonicalJson(value);
}

function renderList(label: string, values: string[]): string[] {
	if (values.length === 0) return [`${label}: none`];
	return [`${label}:`, ...values.map((value) => `- ${value}`)];
}

function workflowAdventureRoutes(
	book: WorkflowBook,
	page: WorkflowBookPage,
	input: WorkflowAdventurePacketInput,
): WorkflowAdventureNavigationRoute[] {
	const routes: WorkflowAdventureNavigationRoute[] = [];
	const addRoute = (
		id: string,
		label: string,
		kind: WorkflowAdventureNavigationRoute["kind"],
		choice: WorkflowBookChoice | undefined,
		rationale: string,
		intent?: WorkflowAdventureIntent,
	) => {
		if (!choice) return;
		const adventureChoice = workflowAdventureChoice(choice);
		routes.push({
			id,
			label,
			kind,
			choiceId: choice.id,
			choiceLabel: choice.label,
			targetPageId: choice.targetPageId,
			intent,
			rationale,
			requiresExplicitAuthorization: adventureChoice.requiresExplicitAuthorization,
			authorizationReason: adventureChoice.authorizationReason,
			action: routeAction(input, page, choice, id),
		});
	};

	if (page.id === "overview") {
		addRoute(
			"analysis-scout",
			"Analysis scout",
			"intent",
			choiceById(page, "inspect-phases"),
			"Walk the phase and agent objects before any validation or execution-preparation route.",
			"analysis-scout",
		);
		addRoute(
			"validation",
			"Validation",
			"validation",
			choiceById(page, "validate-workflow"),
			"Inspect local warnings and contracts before drafting or running the workflow.",
			"validation",
		);
		addRoute(
			"run-prep",
			"Run preparation",
			"run-prep",
			choiceById(page, "execute-async"),
			"Open the execution-preparation page without submitting a run.",
			"run-prep",
		);
		addRoute(
			"raw-sparql",
			"Raw SPARQL",
			"raw-sparql",
			choiceById(page, "raw-sparql"),
			"Drop to exact RDF queries when the adventure abstraction is too coarse.",
			"raw-sparql",
		);
		return routes;
	}

	if (page.id.startsWith("phase-")) {
		for (const choice of page.choices.filter((choice) => choice.id.startsWith("inspect-"))) {
			addRoute(
				choice.id.replace(/^inspect-/, "agent-"),
				choice.label.replace(/^Inspect /, "Agent: "),
				"object",
				choice,
				"Inspect this materialized agent node as the next object in the workflow graph.",
			);
		}
		addRoute("overview", "Overview", "back", choiceById(page, "overview"), "Return to the workflow overview.");
		addRawPageRoute(book, routes, input, page);
		return routes;
	}

	if (page.id.startsWith("agent-")) {
		addRoute("phase", "Parent phase", "back", choiceById(page, "phase"), "Return to the containing phase.");
		addRoute(
			"edit-agent",
			"Edit agent",
			"object",
			choiceById(page, "edit-agent"),
			"Revise this node's prompt, model, tools, or schema.",
		);
		addRawPageRoute(book, routes, input, page);
		return routes;
	}

	if (page.id === "validation") {
		addRoute(
			"garden-dry-run",
			"Garden dry-run",
			"validation",
			choiceById(page, "dry-run-emporium"),
			"Ask Garden to validate the workflow subgraph without applying it.",
			"validation",
		);
		addRoute(
			"source-preview",
			"Source preview",
			"validation",
			choiceById(page, "preview-topology"),
			"Re-run the local preview harness to inspect materialized topology.",
		);
		addRoute("overview", "Overview", "back", choiceById(page, "overview"), "Return to the workflow overview.");
		addRawPageRoute(book, routes, input, page);
		return routes;
	}

	if (page.id === "execute") {
		addRoute(
			"submit-run",
			"Submit run",
			"run-prep",
			choiceById(page, "submit-run"),
			"Submit the workflow only after explicit operator authorization.",
			"run-prep",
		);
		addRoute(
			"monitor-run",
			"Monitor run",
			"run-prep",
			choiceById(page, "monitor-run"),
			"Open run monitoring for an existing run.",
		);
		addRoute("overview", "Overview", "back", choiceById(page, "overview"), "Return to the workflow overview.");
		addRawPageRoute(book, routes, input, page);
		return routes;
	}

	if (page.id === "raw") {
		for (const choice of page.choices) {
			addRoute(choice.id, choice.label, "raw-sparql", choice, "Run or adapt this exact SPARQL query.", "raw-sparql");
		}
	}
	return routes;
}

function addRawPageRoute(
	book: WorkflowBook,
	routes: WorkflowAdventureNavigationRoute[],
	input: WorkflowAdventurePacketInput,
	page: WorkflowBookPage,
) {
	if (!book.pages.some((candidate) => candidate.id === "raw")) return;
	const choice: WorkflowBookChoice = {
		id: "raw-sparql",
		label: "Raw SPARQL",
		description: "Drop to the exact RDF query layer.",
		kind: "raw",
		targetPageId: "raw",
	};
	routes.push({
		id: "raw-sparql",
		label: "Raw SPARQL",
		kind: "raw-sparql",
		choiceId: choice.id,
		choiceLabel: choice.label,
		targetPageId: "raw",
		intent: "raw-sparql",
		rationale: "Drop to exact RDF queries when the adventure abstraction is too coarse.",
		action: routeAction(input, page, choice, "raw-sparql"),
	});
}

function workflowAdventureRecommendation(
	input: WorkflowAdventurePacketInput,
	page: WorkflowBookPage,
	routes: WorkflowAdventureNavigationRoute[],
	intent: WorkflowAdventureIntent,
): WorkflowAdventureRecommendedNextAction | undefined {
	const intentRoute = routes.find((route) => route.intent === intent || route.id === intent);
	if (intentRoute) return recommendedForRoute(intentRoute, "intent-route");
	const suggestedRoute = routes.find((route) => !route.requiresExplicitAuthorization);
	if (suggestedRoute) return recommendedForRoute(suggestedRoute, "suggested-route");
	const firstChoice = page.choices[0];
	if (!firstChoice) return undefined;
	const choice = workflowAdventureChoice(firstChoice);
	return {
		kind: "choose",
		source: "suggested-choice",
		choiceId: choice.id,
		choiceLabel: choice.label,
		targetPageId: choice.targetPageId,
		requiresExplicitAuthorization: choice.requiresExplicitAuthorization,
		authorizationReason: choice.authorizationReason,
		commandTemplate: choiceCommand(input, choice.targetPageId ?? page.id),
		action: choiceAction(input, page.id, choice),
	};
}

function recommendedForRoute(
	route: WorkflowAdventureNavigationRoute,
	source: "intent-route" | "suggested-route",
): WorkflowAdventureRecommendedNextAction {
	return {
		kind: "follow-route",
		source,
		routeId: route.id,
		routeLabel: route.label,
		choiceId: route.choiceId,
		choiceLabel: route.choiceLabel,
		targetPageId: route.targetPageId,
		rationale: route.rationale,
		requiresExplicitAuthorization: route.requiresExplicitAuthorization,
		authorizationReason: route.authorizationReason,
		commandTemplate: route.action.text,
		action: route.action,
	};
}

function workflowAdventureChoice(choice: WorkflowBookChoice, suggestedChoiceId?: string): WorkflowAdventureChoice {
	const requiresExplicitAuthorization = choiceRequiresAuthorization(choice);
	return {
		id: choice.id,
		label: choice.label,
		kind: choice.kind,
		targetPageId: choice.targetPageId,
		description: choice.description,
		suggested: choice.id === suggestedChoiceId,
		requiresExplicitAuthorization: requiresExplicitAuthorization || undefined,
		authorizationReason: requiresExplicitAuthorization ? "choice can start or prepare workflow execution" : undefined,
		action: choice.action,
		payload: choice.payload,
	};
}

function choiceRequiresAuthorization(choice: WorkflowBookChoice): boolean {
	if (choice.kind === "execute") return true;
	if (choice.targetPageId === "execute") return true;
	return choice.action === "workflow.execute" || choice.action === "choreograph.workflows.run";
}

function workflowAdventureConcept(object: string): WorkflowAdventureConcept {
	const [prefix, ...rest] = object.split(":");
	const value = rest.join(":") || object;
	const kind =
		prefix === "phase"
			? "phase"
			: prefix === "agent"
				? "agent"
				: prefix === "contract"
					? "contract"
					: prefix === "model"
						? "model"
						: prefix === "toolMode"
							? "toolMode"
							: prefix === "capability"
								? "capability"
								: prefix === "rdf"
									? "rdf"
									: prefix === "endpoint"
										? "endpoint"
										: "unknown";
	return {
		kind,
		id: value || object,
		label: object,
	};
}

function routeAction(
	input: WorkflowAdventurePacketInput,
	page: WorkflowBookPage,
	choice: WorkflowBookChoice,
	routeId: string,
): WorkflowAdventureAction {
	if (choice.action === "sparql.query") {
		return {
			tool: "sparql_query",
			arguments: choice.payload ?? {},
			text: "sparql_query <query from packet.raw.sparql>",
		};
	}
	const nextPageId = choice.targetPageId ?? page.id;
	return {
		tool: "workflow_compose_adventure",
		arguments: compactRecord({
			workflowPath: input.workflowPath,
			argsPath: input.argsPath,
			graphId: input.graphId,
			pageId: nextPageId,
			intent: routeIdToIntent(routeId, input.intent),
		}),
		text: choiceCommand(input, nextPageId, routeIdToIntent(routeId, input.intent)),
	};
}

function choiceAction(
	input: WorkflowAdventurePacketInput,
	pageId: string,
	choice: WorkflowAdventureChoice,
): WorkflowAdventureAction {
	return {
		tool: "workflow_compose_adventure",
		arguments: compactRecord({
			workflowPath: input.workflowPath,
			argsPath: input.argsPath,
			graphId: input.graphId,
			pageId: choice.targetPageId ?? pageId,
			intent: input.intent,
		}),
		text: choiceCommand(input, choice.targetPageId ?? pageId, input.intent),
	};
}

function choiceCommand(input: WorkflowAdventurePacketInput, pageId: string, intent?: string): string {
	if (!input.workflowPath) return "workflow_compose_adventure <workflow-source>";
	const parts = [
		"pnpm",
		"exec",
		"tsx",
		"scripts/workflow-compose.ts",
		"adventure",
		input.workflowPath,
		...optionalArg("--args", input.argsPath),
		...optionalArg("--graph", input.graphId),
		"--page",
		pageId,
		...optionalArg("--intent", intent),
	];
	return shellCommand(parts);
}

function routeIdToIntent(routeId: string, fallback: string | undefined): string | undefined {
	if (routeId === "analysis-scout" || routeId === "run-prep" || routeId === "raw-sparql" || routeId === "validation") {
		return routeId;
	}
	return fallback;
}

function optionalArg(flag: string, value: string | undefined): string[] {
	return value ? [flag, value] : [];
}

function findPage(book: WorkflowBook, pageId: string): WorkflowBookPage {
	const page = book.pages.find((candidate) => candidate.id === pageId);
	if (!page) throw new Error(`workflow book does not contain page '${pageId}'`);
	return page;
}

function findRoute(
	routes: WorkflowAdventureNavigationRoute[],
	routeId: string,
	pageId: string,
): WorkflowAdventureNavigationRoute {
	const route = routes.find((candidate) => candidate.id === routeId);
	if (!route) throw new Error(`workflow adventure page '${pageId}' does not contain route '${routeId}'`);
	return route;
}

function choiceById(page: WorkflowBookPage, id: string): WorkflowBookChoice | undefined {
	return page.choices.find((choice) => choice.id === id);
}

function compactRecord<T extends Record<string, unknown>>(record: T): T {
	return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

type ShellPart = string;

function shellCommand(parts: ShellPart[]): string {
	return parts.map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_./:=@+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function adventureRouteIri(subjectIri: string, routeId: string): string {
	return `${subjectIri}:route:${stableToken(routeId)}`;
}

function adventureRouteActionIri(subjectIri: string, routeId: string): string {
	return `${adventureRouteIri(subjectIri, routeId)}:action`;
}

function adventureActionArgumentIri(actionIri: string, argumentName: string): string {
	return `${actionIri}:arg:${stableToken(argumentName)}`;
}

function adventureRawSparqlQueryIri(subjectIri: string, index: number): string {
	return `${subjectIri}:raw-sparql:${index + 1}`;
}

function adventureRecommendedActionIri(subjectIri: string): string {
	return `${subjectIri}:recommended-action`;
}

function adventureAuthorizationFlagIri(subjectIri: string, index: number): string {
	return `${subjectIri}:authorization:${index + 1}`;
}

function stableToken(value: string): string {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9_.-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "unknown"
	);
}

function iri(value: string): string {
	return `<${value.replace(/>/g, "%3E")}>`;
}

function str(value: string): string {
	return `"${value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t")}"`;
}

function intLit(value: number): string {
	return `"${Math.trunc(value)}"^^xsd:integer`;
}

function dateTimeLit(value: string): string {
	return `${str(value)}^^xsd:dateTime`;
}

function stmt(subject: string, pairs: Array<[string, string]>): string {
	return `${subject}\n${pairs.map(([predicate, object], index) => `  ${predicate} ${object}${index === pairs.length - 1 ? " ." : " ;"}`).join("\n")}`;
}

function canonicalJson(value: unknown): string {
	return JSON.stringify(sortJson(value));
}

function sha256Text(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function sortJson(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortJson);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => [key, sortJson(item)]),
	);
}
