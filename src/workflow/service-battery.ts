import { canonicalDigest, canonicalJson } from "../agent-subject/canonical-json.js";
import type { WorkflowRunInputs } from "./harness.js";

export const SERVICE_SCENARIO_SCHEMA = "sophia.service.scenario.v1" as const;
export const SERVICE_OPERATIONS = [
	"wake",
	"verify-face",
	"verify-ids",
	"write",
	"echo-face",
	"project",
	"record-ids",
	"findings",
] as const;
export const SERVICE_INVARIANTS = ["I1", "I4", "I5"] as const;
export const SERVICE_CAPABILITIES = ["mcp", "http"] as const;

/**
 * The service family (S1 durability, S2 authority, S3 isolation) has no slot in
 * the ratified `test_invariant` enum, so it is expressed THROUGH I1/I4/I5 and
 * discriminated by the open `verdict_code` axis. That is not a workaround: S1
 * durability genuinely is an I1 echo whose two reads straddle a cell
 * incarnation, and block identity after rehydrate genuinely is I4.
 */
const SERVICE_TOOLS_BY_CAPABILITY: Readonly<Record<ServiceCapability, ReadonlySet<string>>> = {
	// `get_workspace` is the liveness probe (see the wake beat): read-only, needs
	// only the graph id, and answers with an OBJECT. `list_documents` stays in the
	// set for scenarios that genuinely enumerate, but must not be used as a probe.
	mcp: new Set([
		"get_workspace",
		"list_documents",
		"read_document",
		"write_document",
		"create_document",
		"sparql_query",
	]),
	http: new Set(["get", "head"]),
};

/**
 * Tools a beat may attempt exactly once. Writes are single-attempt because a
 * timed-out write against a cold cell lands anyway and is resolved by the
 * following read, never by a retry; SPARQL is single-attempt because the cell
 * admits two process-wide query permits and the sandbox has no sleep to back
 * off with, so a retry loop is a request storm.
 */
const SERVICE_SINGLE_ATTEMPT_TOOLS: ReadonlySet<string> = new Set([
	"create_document",
	"write_document",
	"sparql_query",
]);

/** Closed allowlist so an invariant reference cannot wander the scenario. */
export const SERVICE_SCENARIO_PATHS = ["payload.content", "expected.content", "expected.blockIds"] as const;

/** Cadence floor: `PN_IDLE_TTL_SECONDS` (900 s) plus a minute of margin. */
export const SERVICE_MIN_INCARNATION_GAP_MS = 960_000;
export const SERVICE_PROJECTION_MAX_MS = 30_000;
export const SERVICE_PROJECTION_MIN_ROWS = 1;
export const SERVICE_SPARQL_TIMEOUT_MS = 15_000;
export const SERVICE_SPARQL_MAX_ROWS = 5;
export const SERVICE_PAYLOAD_TITLE = "Sophia service battery payload";
export const SERVICE_FINDINGS_PREFIX = "obs-svc-findings-";

/**
 * The record graph is fenced, and by a CLOSED ALLOWLIST rather than a pattern.
 *
 * The two fences guard opposite risks and so cannot be the same instrument. The
 * SUT fence is a pattern because the SUT is a FAMILY of disposable graphs: the
 * battery corrupts one on purpose, and the fence's job is to make sure the graph
 * it corrupts is always a member of that family and never something real. The
 * record graph is not a family. It is one durable graph that the campaign's
 * history accumulates in, and a pattern there would admit graphs nobody chose —
 * `^observ` would have taken `observatory-scratch`, and every run after the typo
 * would report success while filing its testimony somewhere no dashboard reads.
 *
 * G0 §4.4(b) settles it in one line: `recordGraph` is "pinned to `observatory`
 * and is not caller-supplied. The SUT can be corrupted by design; the record
 * cannot." An allowlist of one is that pin, made explicit and testable. It stays
 * a parameter rather than a constant so the pin is visible in the workflow's
 * declared input contract, where a reader of the portable program source can see
 * which graph a run files into without reading the host — and so a second entry
 * (a per-tenant record graph, say) is a one-line change against a test rather
 * than a refactor.
 */
export const SERVICE_RECORD_GRAPHS = ["observatory"] as const;
export type ServiceRecordGraph = (typeof SERVICE_RECORD_GRAPHS)[number];
export const SERVICE_RECORD_GRAPH_DEFAULT: ServiceRecordGraph = "observatory";

export type ServiceOperation = (typeof SERVICE_OPERATIONS)[number];
export type ServiceInvariantId = (typeof SERVICE_INVARIANTS)[number];
export type ServiceCapability = (typeof SERVICE_CAPABILITIES)[number];
export type ServiceScenarioPath = (typeof SERVICE_SCENARIO_PATHS)[number];

export interface ServiceActionV1 {
	readonly capability: ServiceCapability;
	readonly tool: string;
	readonly args: Readonly<Record<string, unknown>>;
	/** 0..2, default 0. Mutating and SPARQL tools MUST declare 0. */
	readonly retries?: number;
}

export type ServiceRefV1 =
	| { readonly beat: string; readonly action?: number; readonly path?: string }
	| { readonly scenarioPath: ServiceScenarioPath };

export type ServiceInvariantV1 =
	| {
			readonly id: "I1";
			readonly kind: "markdown_equal";
			readonly code: string;
			readonly left: ServiceRefV1;
			readonly right: ServiceRefV1;
	  }
	| {
			readonly id: "I4";
			readonly kind: "block_identity";
			readonly code: string;
			readonly left: ServiceRefV1;
			readonly right: ServiceRefV1;
	  }
	| {
			readonly id: "I5";
			readonly kind: "projection_latency";
			readonly code: string;
			readonly fromBeat: string;
			readonly toBeat: string;
			readonly ref: ServiceRefV1;
			/**
			 * Where the cell's own query diagnostics land. A warning here means the
			 * QUERY is in question, not the platform — see the evaluator in
			 * `script-service-battery.ts`.
			 */
			readonly warnRef: ServiceRefV1;
			readonly maxMs: number;
			readonly minRows: number;
	  };

/**
 * Run k−1's sealed state. It is an INPUT, never read back from the system under
 * test: a cell that lost everything and re-seeded itself must not be able to
 * satisfy the durability leg.
 */
export interface ServiceExpectedV1 {
	readonly runId: string;
	readonly content: string;
	readonly blockIds: readonly string[];
	readonly writtenAtMs: number;
}

export interface ServiceBeatV1 {
	readonly id: string;
	readonly operation: ServiceOperation;
	readonly actions: readonly ServiceActionV1[];
}

export interface ServiceScenarioV1 {
	readonly schema: typeof SERVICE_SCENARIO_SCHEMA;
	readonly id: string;
	readonly runId: string;
	readonly description?: string;
	/**
	 * The SYSTEM UNDER TEST. Echoed for canonicalization; the host re-checks it
	 * against the run graph. A scenario only ever touches the SUT — the record
	 * graph is the host's business and is deliberately absent from the replayable
	 * document, so a scenario stored in a graph cannot name where it gets filed.
	 */
	readonly sutGraph: string;
	readonly payloadDocumentId: string;
	readonly payload: { readonly title: string; readonly content: string };
	/** Present only when the durability leg is licensed. */
	readonly expected?: ServiceExpectedV1;
	/** Every beat is sequential. There is no concurrent mode — see SPARQL admission. */
	readonly beats: readonly ServiceBeatV1[];
	readonly invariants: readonly ServiceInvariantV1[];
}

export interface NormalizedServiceScenario {
	readonly scenario: ServiceScenarioV1;
	readonly canonicalJson: string;
	readonly digest: string;
}

/** Validate once on the host; replay bytes and digest are then immutable run inputs. */
export function normalizeServiceScenario(value: unknown): NormalizedServiceScenario {
	const scenario = parseScenario(value);
	const serialized = canonicalJson(scenario);
	return { scenario, canonicalJson: serialized, digest: canonicalDigest(scenario) };
}

/**
 * Bind one run to its two graphs.
 *
 * `sutGraph` is the run graph the invocation edge already authorized — the
 * disposable system under test. `recordGraph` is where the run's judgment is
 * filed, and it is resolved here rather than taken on trust, so the fence sits
 * in front of the workflow instead of inside it.
 */
export function buildServiceBatteryInputs(value: unknown, sutGraph: string): WorkflowRunInputs {
	assertServiceSutGraph(sutGraph);
	const request = asRecord(value, "request");
	const body = request.workflow_args === undefined ? request : asRecord(request.workflow_args, "workflow_args");
	const recordGraph = resolveServiceRecordGraph(body.recordGraph);
	// Belt beside the braces. The two fences are disjoint today, so this can only
	// fire if the allowlist ever grows to overlap the SUT pattern — and on that
	// day the run would be filing its record into the graph it is about to
	// corrupt, which is the one outcome the split exists to make impossible.
	if (recordGraph === sutGraph) throw invalid("recordGraph and sutGraph must not be the same graph");
	const normalized = normalizeServiceScenario(body.scenario);
	if (normalized.scenario.sutGraph !== sutGraph) {
		throw invalid("scenario.sutGraph does not match the run's system under test");
	}
	const args = { ...normalized, sutGraph, recordGraph };
	return {
		config: { graphId: sutGraph, model: "none" },
		args,
		schemaInput: { scenario: normalized.scenario, digest: normalized.digest, sutGraph, recordGraph },
	};
}

/** The disposable system under test — a graph the battery may corrupt and discard. */
export function assertServiceSutGraph(sutGraph: string): void {
	if (!/^obs-svc-[A-Za-z0-9._-]+$/.test(sutGraph)) {
		throw Object.assign(new Error("Service battery workflows are restricted to obs-svc-* campaign graphs"), {
			status: 400,
		});
	}
}

/** The durable record — see `SERVICE_RECORD_GRAPHS` for why this is an allowlist. */
export function assertServiceRecordGraph(recordGraph: string): void {
	if (!(SERVICE_RECORD_GRAPHS as readonly string[]).includes(recordGraph)) {
		throw Object.assign(
			new Error(
				`Service battery records are restricted to the ${SERVICE_RECORD_GRAPHS.join(", ")} graph; ` +
					`'${recordGraph}' is not a record graph`,
			),
			{ status: 400 },
		);
	}
}

export function resolveServiceRecordGraph(value: unknown): ServiceRecordGraph {
	if (value === undefined || value === null) return SERVICE_RECORD_GRAPH_DEFAULT;
	const recordGraph = boundedString(value, "recordGraph", 128);
	assertServiceRecordGraph(recordGraph);
	return recordGraph as ServiceRecordGraph;
}

/** Run k−1 as the scheduler retained it: its own status plus the state it sealed. */
export interface ServicePriorRunV1 {
	/** Run k−1's `status`; only `"passed"` licenses durability. */
	readonly status: string;
	/** Run k−1's `payload.content`, kept beside its scenario digest by the host. */
	readonly payloadContent: string;
	readonly nextExpected?: {
		readonly runId: string;
		readonly payloadDocumentId: string;
		readonly payloadSha256?: string;
		readonly blockIds: readonly string[];
		readonly writtenAtMs: number;
	};
}

export interface ServiceScenarioBuildRequest {
	readonly runId: string;
	readonly scenarioId: string;
	/** The disposable system under test; the record graph never reaches the scenario. */
	readonly sutGraph: string;
	readonly payloadDocumentId: string;
	/** Per-run salt so a stale read is detectable in the payload itself. */
	readonly nonce: string;
	/** Host clock, epoch ms. The script has no clock authority over licensing. */
	readonly now: number;
	readonly prior?: ServicePriorRunV1;
	readonly minIncarnationGapMs?: number;
	/** Override once block text is confirmed projected, to filter on the run nonce. */
	readonly projectionQuery?: string;
}

export interface BuiltServiceScenario extends NormalizedServiceScenario {
	readonly mode: "seed" | "verify";
}

/**
 * Chain run k onto run k−1.
 *
 * The flow cannot force a cell restart and does not pretend to. It is scheduled
 * on a cadence longer than the idle TTL against a graph exclusive to the
 * battery, so the cell necessarily self-exits between runs and run k's capability
 * bind rehydrates it. `expected` is licensed only when run k−1 passed its own
 * echo AND enough wall-clock has elapsed for the reaper to have acted. An
 * unlicensed run emits the seed shape — silence, not a false pass. The script
 * never branches on mode; the beat list is simply shorter.
 */
export function buildServiceScenario(request: ServiceScenarioBuildRequest): BuiltServiceScenario {
	assertServiceSutGraph(request.sutGraph);
	const runId = opaqueId(request.runId, "runId");
	const scenarioId = opaqueId(request.scenarioId, "scenarioId");
	const payloadDocumentId = opaqueId(request.payloadDocumentId, "payloadDocumentId");
	const nonce = opaqueId(request.nonce, "nonce");
	if (!Number.isSafeInteger(request.now) || request.now < 0) throw invalid("now must be epoch milliseconds");
	const gapMs = request.minIncarnationGapMs ?? SERVICE_MIN_INCARNATION_GAP_MS;
	if (!Number.isSafeInteger(gapMs) || gapMs < 0) throw invalid("minIncarnationGapMs");

	// The MCP tool argument stays `graphId`: that is the cell's own camelCase
	// contract for "the graph this call is against", and under service-auth the
	// gateway strips it anyway — routing is the proxy's owner-scoped URL. Renaming
	// it here would rename a wire field the cell reads.
	const graphId = request.sutGraph;
	const expected = licenseDurability(request, runId, payloadDocumentId, gapMs);
	const payload = { title: SERVICE_PAYLOAD_TITLE, content: servicePayloadContent(runId, nonce) };
	const exportPath = `${payloadDocumentId}/export?format=markdown`;
	const readIds = { graphId, documentId: payloadDocumentId, format: "ids_only" };
	const ledgerDocumentId = `${SERVICE_FINDINGS_PREFIX}${runId}`.slice(0, 128);
	const ledgerTitle = `Sophia service battery findings ${runId}`;

	const beats: ServiceBeatV1[] = [
		// The liveness gate. Every downstream classification is meaningful only
		// because this one succeeded against the freshly bound cell.
		//
		// NOT `list_documents`, though it is the obvious probe. That tool answers
		// with a bare JSON ARRAY in `structuredContent`, which the hosted proxy's
		// validator rejects — the same defect `list_graphs` has (a cell owns one
		// graph, so it too answers with an array). Proven live 2026-08-05: against
		// a WARM cell `list_documents` failed in 38 ms while `read_document` and
		// `sparql_query` succeeded in the same run, so this is not cold start.
		// Nor `sparql_query`: a scenario may hold at most one, and `project` owns
		// it — that fence protects the cell's two-permit admission layer.
		// `get_workspace` is read-only, needs only the graph id, and answers with
		// an object from the hydrated store.
		serviceBeat("wake", "wake", [serviceAction("mcp", "get_workspace", { graphId }, 0)]),
	];
	if (expected) {
		// Verify BEFORE write, so the run's first touches read the previous
		// incarnation's content off the rehydrated cell rather than its own.
		beats.push(
			serviceBeat("verify-face", "verify-face", [
				serviceAction("http", "get", { path: exportPath, accept: "text/markdown" }, 1),
			]),
			serviceBeat("verify-ids", "verify-ids", [serviceAction("mcp", "read_document", readIds, 1)]),
		);
	}
	beats.push(
		serviceBeat("write", "write", [
			serviceAction(
				"mcp",
				"write_document",
				{
					graphId,
					documentId: payloadDocumentId,
					title: payload.title,
					content: payload.content,
					format: "markdown",
					awaitDurable: true,
				},
				0,
			),
		]),
		serviceBeat("echo-face", "echo-face", [
			serviceAction("http", "get", { path: exportPath, accept: "text/markdown" }, 1),
		]),
		serviceBeat("project", "project", [
			serviceAction(
				"mcp",
				"sparql_query",
				{
					graphId,
					query: request.projectionQuery ?? defaultProjectionQuery(payloadDocumentId, nonce),
					maxRows: SERVICE_SPARQL_MAX_ROWS,
					timeoutMs: SERVICE_SPARQL_TIMEOUT_MS,
				},
				0,
			),
		]),
		serviceBeat("record-ids", "record-ids", [serviceAction("mcp", "read_document", readIds, 1)]),
		// Best-effort ledger. The script substitutes the run's findings markdown
		// for `content` before invoking, exactly as the hoja swarm writes its own.
		serviceBeat("findings", "findings", [
			serviceAction("mcp", "create_document", { graphId, documentId: ledgerDocumentId, title: ledgerTitle }, 0),
			serviceAction(
				"mcp",
				"write_document",
				{
					graphId,
					documentId: ledgerDocumentId,
					title: ledgerTitle,
					content: ledgerPlaceholder(runId, scenarioId),
					format: "markdown",
					awaitDurable: true,
				},
				0,
			),
		]),
	);

	const invariants: ServiceInvariantV1[] = [
		{
			id: "I1",
			kind: "markdown_equal",
			code: "echo",
			left: { scenarioPath: "payload.content" },
			right: { beat: "echo-face", path: "value.body" },
		},
	];
	if (expected) {
		invariants.push(
			{
				id: "I1",
				kind: "markdown_equal",
				code: "durability",
				left: { scenarioPath: "expected.content" },
				right: { beat: "verify-face", path: "value.body" },
			},
			{
				id: "I4",
				kind: "block_identity",
				code: "identity",
				left: { scenarioPath: "expected.blockIds" },
				right: { beat: "verify-ids", path: "value.structuredContent.block_ids" },
			},
		);
	}
	invariants.push({
		id: "I5",
		kind: "projection_latency",
		code: "projection",
		fromBeat: "write",
		toBeat: "project",
		ref: { beat: "project", path: "value.structuredContent.rows" },
		warnRef: { beat: "project", path: "value.structuredContent.warnings" },
		maxMs: SERVICE_PROJECTION_MAX_MS,
		minRows: SERVICE_PROJECTION_MIN_ROWS,
	});

	const scenario = {
		schema: SERVICE_SCENARIO_SCHEMA,
		id: scenarioId,
		runId,
		description: expected
			? "Read the previous incarnation's payload back through a cold-bound cell, then rewrite and re-echo it."
			: "Seed the campaign payload, echo it through the export door, and record its block identity.",
		sutGraph: graphId,
		payloadDocumentId,
		payload,
		...(expected === undefined ? {} : { expected }),
		beats,
		invariants,
	};
	// The builder's own output goes through the same fence as caller-supplied data.
	return { ...normalizeServiceScenario(scenario), mode: expected ? "verify" : "seed" };
}

/**
 * I5 asks whether THIS RUN'S CONTENT reached the SPARQL face — not merely whether
 * a document node exists. Two properties of the cell make that the right question
 * and make a single-shot query the right instrument; both were confirmed live
 * against the canary on 2026-08-06, and both are load-bearing:
 *
 *   1. **The store is named-graph-partitioned and the default graph is EMPTY.**
 *      Measured: 0 quads in the default graph against 601,227 in the store. Every
 *      projection lands in `…:projection:workspace` or
 *      `…:projection:document:{id}`. A pattern with no `GRAPH` clause therefore
 *      matches nothing, always, at full speed — which is exactly how the first
 *      version of this query produced a confident `projection_missing` against a
 *      healthy cell. The `GRAPH ?g` wrapper is not a stylistic choice; without it
 *      this invariant cannot pass.
 *   2. **The projection is SYNCHRONOUS with the write.** `save_document` runs
 *      `ensure_document_persistence_tail_with_tombstone_fence` inline, which opens
 *      the graph store and reconciles the document record before returning
 *      (`garden/src-tauri/src/document_persistence_service.rs`, timed as
 *      `rustPersistDocumentTailMs`). There is no async projection tail to wait on,
 *      so one query with no retry is sound — and it keeps the scenario inside the
 *      one-`sparql_query` fence that protects the cell's two-permit admission.
 *
 * Block text lives at `doc:textContent` on `…#block-…` subjects (NOT `doc:text`,
 * which the earlier note guessed at). Filtering on the run nonce is what makes a
 * stale projection from a previous incarnation unable to satisfy this check.
 */
export function defaultProjectionQuery(payloadDocumentId: string, nonce: string): string {
	opaqueId(payloadDocumentId, "payloadDocumentId");
	opaqueId(nonce, "nonce");
	return [
		"PREFIX doc: <http://mnemosyne.dev/doc#>",
		"SELECT ?b ?t WHERE {",
		"  GRAPH ?g { ?b doc:textContent ?t }",
		`  FILTER(CONTAINS(STR(?b), "${payloadDocumentId}#block-"))`,
		`  FILTER(CONTAINS(STR(?t), "${nonce}"))`,
		"} LIMIT 5",
	].join("\n");
}

function licenseDurability(
	request: ServiceScenarioBuildRequest,
	runId: string,
	payloadDocumentId: string,
	gapMs: number,
): ServiceExpectedV1 | undefined {
	const prior = request.prior;
	const next = prior?.nextExpected;
	if (!prior || !next) return undefined;
	if (prior.status !== "passed") return undefined;
	if (typeof prior.payloadContent !== "string" || prior.payloadContent.length === 0) return undefined;
	if (next.payloadDocumentId !== payloadDocumentId) return undefined;
	if (typeof next.runId !== "string" || next.runId === runId) return undefined;
	if (!Array.isArray(next.blockIds) || next.blockIds.length === 0) return undefined;
	if (next.blockIds.some((id) => typeof id !== "string" || id.length === 0)) return undefined;
	if (!Number.isSafeInteger(next.writtenAtMs) || next.writtenAtMs <= 0) return undefined;
	if (request.now - next.writtenAtMs < gapMs) return undefined;
	return {
		runId: next.runId,
		content: prior.payloadContent,
		blockIds: [...next.blockIds],
		writtenAtMs: next.writtenAtMs,
	};
}

/**
 * Three ASCII paragraphs with no Markdown-significant syntax. The export face is
 * regenerated from projected blocks, so any Markdown in the payload would turn
 * I1 into a fidelity test of the renderer — a different question and a reliable
 * source of cosmetic false failures. Keep the fixpoint clean.
 */
function servicePayloadContent(runId: string, nonce: string): string {
	const content = [
		"Sophia cloud two service battery payload.",
		`Run ${runId} nonce ${nonce}.`,
		"This paragraph is written through the MCP door and read through the export door.",
	].join("\n\n");
	assertMarkdownInert(content);
	return content;
}

function ledgerPlaceholder(runId: string, scenarioId: string): string {
	return [
		`Sophia service battery findings ${runId}.`,
		`Scenario ${scenarioId}.`,
		"The workflow overwrites this document with the run ledger.",
	].join("\n\n");
}

function assertMarkdownInert(content: string): void {
	for (const line of content.split("\n")) {
		if (line.length === 0) continue;
		if (!/^[A-Za-z][A-Za-z0-9 .,;:'"()/-]*$/.test(line)) throw invalid("payload content line is not markdown-inert");
	}
}

function serviceBeat(id: string, operation: ServiceOperation, actions: readonly ServiceActionV1[]): ServiceBeatV1 {
	return { id, operation, actions };
}

function serviceAction(
	capability: ServiceCapability,
	tool: string,
	args: Readonly<Record<string, unknown>>,
	retries: number,
): ServiceActionV1 {
	return { capability, tool, args, retries };
}

function parseScenario(value: unknown): ServiceScenarioV1 {
	const input = asRecord(value, "scenario");
	assertExactKeys(
		input,
		[
			"schema",
			"id",
			"runId",
			"description",
			"sutGraph",
			"payloadDocumentId",
			"payload",
			"expected",
			"beats",
			"invariants",
		],
		"scenario",
	);
	if (input.schema !== SERVICE_SCENARIO_SCHEMA) throw invalid("scenario.schema");
	const id = opaqueId(input.id, "scenario.id");
	const runId = opaqueId(input.runId, "scenario.runId");
	const description =
		input.description === undefined ? undefined : boundedString(input.description, "scenario.description", 4000);
	const sutGraph = boundedString(input.sutGraph, "scenario.sutGraph", 128);
	assertServiceSutGraph(sutGraph);
	const payloadDocumentId = opaqueId(input.payloadDocumentId, "scenario.payloadDocumentId");
	const payload = parsePayload(input.payload);
	const expected = input.expected === undefined ? undefined : parseExpected(input.expected);
	if (!Array.isArray(input.beats) || input.beats.length === 0 || input.beats.length > 64) {
		throw invalid("scenario.beats");
	}
	const beats = input.beats.map((beat, index) => parseBeat(beat, index));
	if (new Set(beats.map((beat) => beat.id)).size !== beats.length) throw invalid("scenario beat ids must be unique");
	const sparqlActions = beats.reduce(
		(total, parsed) => total + parsed.actions.filter((item) => item.tool === "sparql_query").length,
		0,
	);
	if (sparqlActions > 1) throw invalid("scenario may hold at most one sparql_query action");
	if (!Array.isArray(input.invariants) || input.invariants.length > 32) throw invalid("scenario.invariants");
	const invariants = input.invariants.map(parseInvariant);
	if (new Set(invariants.map((invariant) => invariant.code)).size !== invariants.length) {
		throw invalid("invariant codes must be unique — verdict_code is the family discriminator");
	}
	validateInvariantReferences(invariants, beats, expected);
	return {
		schema: SERVICE_SCENARIO_SCHEMA,
		id,
		runId,
		...(description === undefined ? {} : { description }),
		sutGraph,
		payloadDocumentId,
		payload,
		...(expected === undefined ? {} : { expected }),
		beats,
		invariants,
	};
}

function parsePayload(value: unknown): ServiceScenarioV1["payload"] {
	const input = asRecord(value, "scenario.payload");
	assertExactKeys(input, ["title", "content"], "scenario.payload");
	return {
		title: boundedString(input.title, "scenario.payload.title", 200),
		content: boundedString(input.content, "scenario.payload.content", 65_536),
	};
}

function parseExpected(value: unknown): ServiceExpectedV1 {
	const input = asRecord(value, "scenario.expected");
	assertExactKeys(input, ["runId", "content", "blockIds", "writtenAtMs"], "scenario.expected");
	if (!Array.isArray(input.blockIds) || input.blockIds.length > 1024) throw invalid("scenario.expected.blockIds");
	if (!Number.isSafeInteger(input.writtenAtMs) || (input.writtenAtMs as number) <= 0) {
		throw invalid("scenario.expected.writtenAtMs");
	}
	return {
		runId: opaqueId(input.runId, "scenario.expected.runId"),
		content: boundedString(input.content, "scenario.expected.content", 65_536),
		// Block ids are compared, never emitted; bound their length only, so a
		// legitimate id shape cannot silently disqualify the durability leg.
		blockIds: input.blockIds.map((id, index) => boundedString(id, `scenario.expected.blockIds[${index}]`, 256)),
		writtenAtMs: input.writtenAtMs as number,
	};
}

function parseBeat(value: unknown, index: number): ServiceBeatV1 {
	const input = asRecord(value, `beat[${index}]`);
	assertExactKeys(input, ["id", "operation", "actions"], `beat[${index}]`);
	const operation = input.operation as ServiceOperation;
	if (!SERVICE_OPERATIONS.includes(operation)) throw invalid(`beat[${index}].operation`);
	if (!Array.isArray(input.actions) || input.actions.length === 0 || input.actions.length > 8) {
		throw invalid(`beat[${index}].actions`);
	}
	return {
		id: opaqueId(input.id, `beat[${index}].id`),
		operation,
		actions: input.actions.map((action, actionIndex) => parseAction(action, index, actionIndex)),
	};
}

function parseAction(value: unknown, beat: number, index: number): ServiceActionV1 {
	const name = `beat[${beat}].actions[${index}]`;
	const input = asRecord(value, name);
	assertExactKeys(input, ["capability", "tool", "args", "retries"], name);
	if (typeof input.capability !== "string" || !SERVICE_CAPABILITIES.includes(input.capability as ServiceCapability)) {
		throw invalid(`${name}.capability`);
	}
	const capability = input.capability as ServiceCapability;
	const tool = boundedString(input.tool, `${name}.tool`, 128);
	if (!SERVICE_TOOLS_BY_CAPABILITY[capability].has(tool)) {
		throw invalid(`${name} tool '${tool}' is not allowed for ${capability}`);
	}
	const args = asRecord(input.args, `${name}.args`);
	if (Buffer.byteLength(JSON.stringify(args), "utf8") > 256 * 1024) throw invalid(`${name}.args is oversized`);
	const retries = input.retries;
	if (retries !== undefined && (!Number.isInteger(retries) || (retries as number) < 0 || (retries as number) > 2)) {
		throw invalid(`${name}.retries must be an integer in 0..2`);
	}
	if (SERVICE_SINGLE_ATTEMPT_TOOLS.has(tool) && retries !== undefined && retries !== 0) {
		throw invalid(`${name} tool '${tool}' must declare retries 0`);
	}
	return {
		capability,
		tool,
		args,
		...(retries === undefined ? {} : { retries: retries as number }),
	};
}

function parseInvariant(value: unknown): ServiceInvariantV1 {
	const input = asRecord(value, "invariant");
	if (!SERVICE_INVARIANTS.includes(input.id as ServiceInvariantId)) throw invalid("invariant.id");
	let parsed: ServiceInvariantV1;
	switch (input.id as ServiceInvariantId) {
		case "I1":
			assertExactKeys(input, ["id", "kind", "code", "left", "right"], "I1 invariant");
			if (input.kind !== "markdown_equal") throw invalid("I1 invariant.kind");
			parsed = {
				id: "I1",
				kind: "markdown_equal",
				code: verdictCodeStem(input.code),
				left: parseRef(input.left),
				right: parseRef(input.right),
			};
			break;
		case "I4":
			assertExactKeys(input, ["id", "kind", "code", "left", "right"], "I4 invariant");
			if (input.kind !== "block_identity") throw invalid("I4 invariant.kind");
			parsed = {
				id: "I4",
				kind: "block_identity",
				code: verdictCodeStem(input.code),
				left: parseRef(input.left),
				right: parseRef(input.right),
			};
			break;
		case "I5": {
			assertExactKeys(
				input,
				["id", "kind", "code", "fromBeat", "toBeat", "ref", "warnRef", "maxMs", "minRows"],
				"I5 invariant",
			);
			if (input.kind !== "projection_latency") throw invalid("I5 invariant.kind");
			if (!Number.isInteger(input.maxMs) || (input.maxMs as number) < 1 || (input.maxMs as number) > 600_000) {
				throw invalid("I5 invariant.maxMs");
			}
			if (!Number.isInteger(input.minRows) || (input.minRows as number) < 0 || (input.minRows as number) > 1000) {
				throw invalid("I5 invariant.minRows");
			}
			parsed = {
				id: "I5",
				kind: "projection_latency",
				code: verdictCodeStem(input.code),
				fromBeat: boundedString(input.fromBeat, "I5 invariant.fromBeat", 128),
				toBeat: boundedString(input.toBeat, "I5 invariant.toBeat", 128),
				ref: parseRef(input.ref),
				warnRef: parseRef(input.warnRef),
				maxMs: input.maxMs as number,
				minRows: input.minRows as number,
			};
			break;
		}
	}
	if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > 64 * 1024) throw invalid("invariant is oversized");
	return parsed;
}

function parseRef(value: unknown): ServiceRefV1 {
	const input = asRecord(value, "invariant ref");
	if (input.scenarioPath !== undefined) {
		assertExactKeys(input, ["scenarioPath"], "invariant ref");
		if (!SERVICE_SCENARIO_PATHS.includes(input.scenarioPath as ServiceScenarioPath)) {
			throw invalid("invariant ref.scenarioPath is outside the allowlist");
		}
		return { scenarioPath: input.scenarioPath as ServiceScenarioPath };
	}
	assertExactKeys(input, ["beat", "action", "path"], "invariant ref");
	const beat = boundedString(input.beat, "invariant ref.beat", 128);
	const action = input.action;
	if (action !== undefined && (!Number.isInteger(action) || (action as number) < 0)) {
		throw invalid("invariant ref.action");
	}
	const path = input.path === undefined ? undefined : boundedString(input.path, "invariant ref.path", 1024);
	return {
		beat,
		...(action === undefined ? {} : { action: action as number }),
		...(path === undefined ? {} : { path }),
	};
}

function validateInvariantReferences(
	invariants: readonly ServiceInvariantV1[],
	beats: readonly ServiceBeatV1[],
	expected: ServiceExpectedV1 | undefined,
): void {
	const byId = new Map(beats.map((beat) => [beat.id, beat]));
	for (const invariant of invariants) {
		const beatIds = invariant.id === "I5" ? [invariant.fromBeat, invariant.toBeat] : [];
		for (const beatId of beatIds) {
			if (!byId.has(beatId)) throw invalid(`invariant ${invariant.code} references unknown beat '${beatId}'`);
		}
		for (const ref of invariantRefs(invariant)) {
			if ("scenarioPath" in ref) {
				if (expected === undefined && ref.scenarioPath.startsWith("expected.")) {
					throw invalid(
						`invariant ${invariant.code} references ${ref.scenarioPath} without a licensed expectation`,
					);
				}
				continue;
			}
			const beat = byId.get(ref.beat);
			if (!beat) throw invalid(`invariant ${invariant.code} references unknown beat '${ref.beat}'`);
			const action = ref.action ?? 0;
			if (action >= beat.actions.length) {
				throw invalid(`invariant ${invariant.code} references missing action ${action} in beat '${ref.beat}'`);
			}
		}
	}
}

function invariantRefs(invariant: ServiceInvariantV1): readonly ServiceRefV1[] {
	return invariant.id === "I5" ? [invariant.ref] : [invariant.left, invariant.right];
}

/** The stem of the emitted `verdict_code`; suffixed forms stay inside the contract's identifier domain. */
function verdictCodeStem(value: unknown): string {
	if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,40}$/.test(value)) throw invalid("invariant.code");
	return value;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function assertExactKeys(input: Record<string, unknown>, allowed: readonly string[], name: string): void {
	const extras = Object.keys(input).filter((key) => !allowed.includes(key));
	if (extras.length > 0) throw invalid(`${name} has unknown fields: ${extras.sort().join(", ")}`);
}

function opaqueId(value: unknown, name: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw invalid(name);
	return value;
}

function boundedString(value: unknown, name: string, max: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) throw invalid(name);
	return value;
}

function invalid(message: string): Error {
	return Object.assign(new Error(`invalid service scenario: ${message}`), { status: 400 });
}
