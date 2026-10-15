import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { compileWorkflow } from "../workflow/harness.js";
import { assertJsonSchema, resolveExecutionBinding } from "../workflow/invocation.js";
import {
	buildServiceBatteryWorkflowInputs,
	SERVICE_BATTERY_RESULT_SCHEMA,
	SERVICE_BATTERY_SCRIPT,
	SERVICE_BATTERY_WORKFLOW_NAME,
} from "../workflow/script-service-battery.js";
import {
	assertServiceRecordGraph,
	assertServiceSutGraph,
	buildServiceBatteryInputs,
	buildServiceScenario,
	type NormalizedServiceScenario,
	normalizeServiceScenario,
	SERVICE_CAPABILITIES,
	SERVICE_INVARIANTS,
	SERVICE_MIN_INCARNATION_GAP_MS,
	SERVICE_OPERATIONS,
	SERVICE_RECORD_GRAPH_DEFAULT,
	SERVICE_RECORD_GRAPHS,
	type ServicePriorRunV1,
	type ServiceScenarioV1,
} from "../workflow/service-battery.js";

const graphId = "obs-svc-canary";
const payloadDocumentId = "svc-durability-payload";

const scenario = {
	schema: "sophia.service.scenario.v1",
	id: "svc-scenario-1",
	runId: "svc-run-1",
	description: "Write through the MCP door and read back through the export door.",
	sutGraph: graphId,
	payloadDocumentId,
	payload: { title: "Sophia service battery payload", content: "Sophia cloud two service battery payload." },
	beats: [
		{
			id: "wake",
			operation: "wake",
			actions: [{ capability: "mcp", tool: "get_workspace", args: { graphId }, retries: 0 }],
		},
		{
			id: "echo-face",
			operation: "echo-face",
			actions: [
				{
					capability: "http",
					tool: "get",
					args: { path: `${payloadDocumentId}/export?format=markdown`, accept: "text/markdown" },
					retries: 1,
				},
			],
		},
	],
	invariants: [
		{
			id: "I1",
			kind: "markdown_equal",
			code: "echo",
			left: { scenarioPath: "payload.content" },
			right: { beat: "echo-face", path: "value.body" },
		},
	],
};

const buildRequest = {
	runId: "svc-run-2",
	scenarioId: "svc-scenario-2",
	sutGraph: graphId,
	payloadDocumentId,
	nonce: "b3c1d2",
	now: 4_000_000,
};

const priorContent = [
	"Sophia cloud two service battery payload.",
	"Run svc-run-1 nonce a1b2c3.",
	"This paragraph is written through the MCP door and read through the export door.",
].join("\n\n");

const prior: ServicePriorRunV1 = {
	status: "passed",
	payloadContent: priorContent,
	nextExpected: {
		runId: "svc-run-1",
		payloadDocumentId,
		payloadSha256: "a".repeat(64),
		blockIds: ["block-1", "block-2", "block-3"],
		writtenAtMs: 4_000_000 - SERVICE_MIN_INCARNATION_GAP_MS,
	},
};

function mutate(patch: Record<string, unknown>): unknown {
	return { ...structuredClone(scenario), ...patch };
}

describe("Garden service battery scenarios", () => {
	it("canonicalizes graph-storable scenarios into a deterministic replay digest", () => {
		const first = normalizeServiceScenario(scenario);
		const second = normalizeServiceScenario(structuredClone(scenario));
		const permuted = normalizeServiceScenario({
			invariants: structuredClone(scenario.invariants),
			beats: structuredClone(scenario.beats),
			payload: structuredClone(scenario.payload),
			payloadDocumentId,
			sutGraph: graphId,
			description: scenario.description,
			runId: scenario.runId,
			id: scenario.id,
			schema: scenario.schema,
		});
		assert.equal(first.digest, second.digest);
		assert.equal(first.digest, permuted.digest);
		assert.match(first.digest, /^[a-f0-9]{64}$/);
		assert.equal(JSON.parse(first.canonicalJson).schema, "sophia.service.scenario.v1");
	});

	it("fences the system under test to obs-svc campaign graphs and re-checks the echoed scenario graph", () => {
		assert.throws(() => buildServiceBatteryInputs({ scenario }, "obs-hoja-local"), /restricted to obs-svc/);
		assert.throws(() => buildServiceBatteryInputs({ scenario }, "sophia-code-lab"), /restricted to obs-svc/);
		assert.throws(
			() => buildServiceBatteryInputs({ scenario }, "obs-svc-other"),
			/does not match the run's system under test/,
		);
		assert.throws(() => normalizeServiceScenario(mutate({ sutGraph: "obs-hoja-local" })), /restricted to obs-svc/);

		const inputs = buildServiceBatteryInputs({ workflow_args: { scenario } }, graphId);
		assert.equal((inputs.args as { sutGraph: string }).sutGraph, graphId);
		assert.equal((inputs.config as { model: string }).model, "none");
		assert.deepEqual(inputs.schemaInput, {
			scenario: normalizeServiceScenario(scenario).scenario,
			digest: normalizeServiceScenario(scenario).digest,
			sutGraph: graphId,
			recordGraph: SERVICE_RECORD_GRAPH_DEFAULT,
		});
	});

	/**
	 * The split Vera asked for: the graph being TESTED and the graph being WRITTEN
	 * are different questions with different fences.
	 */
	it("defaults the record graph to observatory and admits nothing else", () => {
		assert.equal(SERVICE_RECORD_GRAPH_DEFAULT, "observatory");
		assert.deepEqual([...SERVICE_RECORD_GRAPHS], ["observatory"]);

		const explicit = buildServiceBatteryInputs({ workflow_args: { scenario, recordGraph: "observatory" } }, graphId);
		assert.equal((explicit.args as { recordGraph: string }).recordGraph, "observatory");
		// An absent recordGraph is the default, not a licence to skip the record.
		const defaulted = buildServiceBatteryInputs({ workflow_args: { scenario } }, graphId);
		assert.equal((defaulted.args as { recordGraph: string }).recordGraph, "observatory");

		// A pattern fence would have taken all four of these. An allowlist takes none.
		for (const recordGraph of ["observatory-scratch", "observatoryy", "obs-svc-canary", "sophia-code-lab"]) {
			assert.throws(
				() => buildServiceBatteryInputs({ workflow_args: { scenario, recordGraph } }, graphId),
				/is not a record graph/,
				`record graph fence admitted '${recordGraph}'`,
			);
		}
		// Not a string is not a graph name.
		for (const recordGraph of [42, {}, ["observatory"], ""]) {
			assert.throws(() => buildServiceBatteryInputs({ workflow_args: { scenario, recordGraph } }, graphId));
		}
	});

	/**
	 * The two roles never collapse into one graph. Today the fences are disjoint,
	 * so this is a property of the pair rather than a reachable input — the guard
	 * exists for the day the allowlist grows, and the assertion pins the property
	 * the guard protects.
	 */
	it("keeps the record out of the graph it is judging", () => {
		for (const recordGraph of SERVICE_RECORD_GRAPHS) {
			assert.throws(() => assertServiceSutGraph(recordGraph), /restricted to obs-svc/);
		}
		assert.throws(() => assertServiceRecordGraph(graphId), /is not a record graph/);
		assert.equal(
			buildServiceBatteryInputs({ workflow_args: { scenario } }, graphId).args !== undefined &&
				(buildServiceBatteryInputs({ workflow_args: { scenario } }, graphId).args as { recordGraph: string })
					.recordGraph !== graphId,
			true,
		);
	});

	/**
	 * A scenario is replayable data that may live in a graph. If it could name the
	 * record graph, a stored scenario would choose where its own verdict is filed.
	 */
	it("keeps the record graph out of the replayable scenario document", () => {
		assert.throws(
			() => normalizeServiceScenario({ ...structuredClone(scenario), recordGraph: "observatory" }),
			/unknown fields: recordGraph/,
		);
		assert.equal(Object.hasOwn(normalizeServiceScenario(scenario).scenario, "recordGraph"), false);
	});

	it("rejects anything the campaign fence does not name", () => {
		assert.throws(() => normalizeServiceScenario(mutate({ token: "forbidden" })), /unknown fields: token/);
		assert.throws(
			() =>
				normalizeServiceScenario(
					mutate({
						beats: [
							{
								id: "wake",
								operation: "wake",
								actions: [{ capability: "mcp", tool: "delete_document", args: { graphId }, retries: 0 }],
							},
						],
						invariants: [],
					}),
				),
			/tool 'delete_document' is not allowed for mcp/,
		);
		assert.throws(
			() =>
				normalizeServiceScenario(
					mutate({
						beats: [structuredClone(scenario.beats[0]), structuredClone(scenario.beats[0])],
						invariants: [],
					}),
				),
			/beat ids must be unique/,
		);
		assert.throws(
			() =>
				normalizeServiceScenario(
					mutate({
						invariants: [
							{
								...structuredClone(scenario.invariants[0]),
								right: { beat: "verify-face", path: "value.body" },
							},
						],
					}),
				),
			/references unknown beat 'verify-face'/,
		);
		assert.throws(
			() =>
				normalizeServiceScenario(
					mutate({
						invariants: [{ ...structuredClone(scenario.invariants[0]), left: { scenarioPath: "payload.title" } }],
					}),
				),
			/scenarioPath is outside the allowlist/,
		);
		assert.throws(
			() =>
				normalizeServiceScenario(
					mutate({
						invariants: [
							{ ...structuredClone(scenario.invariants[0]), left: { scenarioPath: "expected.content" } },
						],
					}),
				),
			/without a licensed expectation/,
		);
		assert.throws(
			() =>
				normalizeServiceScenario(
					mutate({
						beats: [
							{
								id: "echo-face",
								operation: "echo-face",
								actions: [{ ...structuredClone(scenario.beats[1].actions[0]), retries: 3 }],
							},
						],
					}),
				),
			/retries must be an integer in 0\.\.2/,
		);
		assert.throws(
			() =>
				normalizeServiceScenario(
					mutate({
						beats: [
							{
								id: "write",
								operation: "write",
								actions: [
									{
										capability: "mcp",
										tool: "write_document",
										args: { graphId, documentId: payloadDocumentId, content: "x", format: "markdown" },
										retries: 1,
									},
								],
							},
						],
						invariants: [],
					}),
				),
			/tool 'write_document' must declare retries 0/,
		);
		assert.throws(
			() =>
				normalizeServiceScenario(
					mutate({
						invariants: [structuredClone(scenario.invariants[0]), structuredClone(scenario.invariants[0])],
					}),
				),
			/invariant codes must be unique/,
		);
	});

	it("holds at most one SPARQL action so a run can never storm the cell's two permits", () => {
		const projectBeat = (id: string) => ({
			id,
			operation: "project",
			actions: [
				{
					capability: "mcp",
					tool: "sparql_query",
					args: { graphId, query: "SELECT ?s WHERE { ?s ?p ?o } LIMIT 1" },
					retries: 0,
				},
			],
		});
		assert.doesNotThrow(() => normalizeServiceScenario(mutate({ beats: [projectBeat("project")], invariants: [] })));
		assert.throws(
			() =>
				normalizeServiceScenario(
					mutate({ beats: [projectBeat("project"), projectBeat("project-2")], invariants: [] }),
				),
			/at most one sparql_query action/,
		);
	});

	it("builds the seed shape when no prior incarnation licenses the durability leg", () => {
		const seed = buildServiceScenario(buildRequest);
		assert.equal(seed.mode, "seed");
		assert.equal(seed.scenario.expected, undefined);
		assert.deepEqual(
			seed.scenario.beats.map((beat) => beat.id),
			["wake", "write", "echo-face", "project", "record-ids", "findings"],
		);
		assert.deepEqual(
			seed.scenario.invariants.map((invariant) => `${invariant.id}:${invariant.code}`),
			["I1:echo", "I5:projection"],
		);
		assert.match(seed.scenario.payload.content, /Run svc-run-2 nonce b3c1d2\./);
		assert.doesNotMatch(seed.scenario.payload.content, /[#*_[\]`>|]/);
		assert.equal(
			seed.scenario.beats.find((beat) => beat.id === "findings")?.actions[0].args.documentId,
			"obs-svc-findings-svc-run-2",
		);
	});

	it("licenses the durability leg only from a clean prior run across a full incarnation gap", () => {
		const verify = buildServiceScenario({ ...buildRequest, prior });
		assert.equal(verify.mode, "verify");
		assert.deepEqual(
			verify.scenario.beats.map((beat) => beat.id),
			["wake", "verify-face", "verify-ids", "write", "echo-face", "project", "record-ids", "findings"],
		);
		assert.deepEqual(
			verify.scenario.invariants.map((invariant) => `${invariant.id}:${invariant.code}`),
			["I1:echo", "I1:durability", "I4:identity", "I5:projection"],
		);
		assert.deepEqual(verify.scenario.expected, {
			runId: "svc-run-1",
			content: priorContent,
			blockIds: ["block-1", "block-2", "block-3"],
			writtenAtMs: prior.nextExpected?.writtenAtMs,
		});

		const early = buildServiceScenario({ ...buildRequest, now: buildRequest.now - 1, prior });
		assert.equal(early.mode, "seed");
		const unclean = buildServiceScenario({ ...buildRequest, prior: { ...prior, status: "failed" } });
		assert.equal(unclean.mode, "seed");
		const unwritten = buildServiceScenario({ ...buildRequest, prior: { ...prior, nextExpected: undefined } });
		assert.equal(unwritten.mode, "seed");
		const foreignDocument = buildServiceScenario({
			...buildRequest,
			prior: {
				...prior,
				nextExpected: { ...prior.nextExpected!, payloadDocumentId: "svc-other-payload" },
			},
		});
		assert.equal(foreignDocument.mode, "seed");
	});

	it("refuses to mint a payload that would make I1 a test of the markdown renderer", () => {
		assert.throws(
			() => buildServiceScenario({ ...buildRequest, nonce: "b3_c1" }),
			/payload content line is not markdown-inert/,
		);
	});
});

// ── Replay: the compiled script driven against real service-shaped doors ─────
//
// The script IS the component under test and runs unmodified, through the same
// compile seam the sandbox uses. Only the two host-mediated capabilities are
// supplied locally, and they answer with the exact byte shapes the gateway and
// the cell answer with. Nothing here can reach the canary service.

const GATEWAY = "https://api.garden.example.invalid";
const OWNER_SEGMENT = "user%3A0a1b2c3d-probe";
/** A fixed point in the past, so the durability leg measures a real elapsed span. */
const REPLAY_NOW = 1_783_890_000_000;
const PRIOR_BLOCK_IDS = ["blk-p1", "blk-p2", "blk-p3"];
const WRITTEN_BLOCK_IDS = ["blk-c1", "blk-c2", "blk-c3"];

interface ServiceVerdictRecord {
	readonly invariant: string;
	readonly code: string;
	readonly result: "pass" | "fail" | "inconclusive";
	readonly verdictCode?: string;
	readonly observedMs?: number;
	readonly maximumMs?: number;
}

interface ServiceActionRecord {
	readonly ok: boolean;
	readonly class: "ok" | "inconclusive" | "error";
	readonly durationMs: number;
	readonly attempts: number;
	readonly status?: number;
}

interface ServiceBatteryResult {
	readonly schema: string;
	readonly scenarioId: string;
	readonly scenarioDigest: string;
	readonly status: "passed" | "failed" | "inconclusive";
	readonly beats: ReadonlyArray<{
		readonly id: string;
		readonly operation: string;
		readonly durationMs: number;
		readonly actions: readonly ServiceActionRecord[];
	}>;
	readonly verdicts: readonly ServiceVerdictRecord[];
	readonly inconclusive: ReadonlyArray<{
		readonly invariant?: string;
		readonly code?: string;
		readonly beat?: string;
		readonly reason: string;
	}>;
	readonly nextExpected?: {
		readonly runId: string;
		readonly payloadDocumentId: string;
		readonly payloadSha256: string;
		readonly blockIds: readonly string[];
		readonly writtenAtMs: number;
	};
	readonly ledger: { readonly status: string; readonly sutGraph: string; readonly documentId?: string };
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The exact envelope gardend's MCP dispatcher returns for every tool value
 * (`garden/src-tauri/src/mcp_tool_dispatch.rs:60-72`); the hosted proxy hands it
 * to `invoke()` unchanged (`mnemosyne.ts:1041`).
 */
function mcpResult(value: Record<string, unknown>): Record<string, unknown> {
	return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

/** The exact record the read-only `http` capability returns for a face read. */
function httpFace(status: number, body: string, contentType = "text/markdown; charset=utf-8") {
	const bytes = Buffer.from(body, "utf8");
	return {
		url: `${GATEWAY}/o/${OWNER_SEGMENT}/g/${graphId}/documents/${graphId}/${payloadDocumentId}/export?format=markdown`,
		status,
		ok: status >= 200 && status < 300,
		contentType,
		headers: { "content-type": contentType },
		body,
		bodyEncoding: "utf8",
		bodyBytes: bytes.byteLength,
		bodySha256: createHash("sha256").update(bytes).digest("hex"),
	};
}

/** `graph_routes_v1.rs:156-178` — what the gateway says while the cell comes back. */
const GRAPH_ACTIVATING_BODY = JSON.stringify({
	code: "graph_activating",
	graph: { owner: "user:0a1b2c3d-probe", graph_id: graphId },
	activationId: "act-1",
	phase: "provisioning",
	pollUrl: "/activations/act-1",
	eventsUrl: "/activations/act-1/events",
});

function idsOnly(blockIds: readonly string[]): Record<string, unknown> {
	return mcpResult({
		graph_id: graphId,
		document_id: payloadDocumentId,
		format: "ids_only",
		block_ids: [...blockIds],
		block_count: blockIds.length,
	});
}

function sparqlRows(count: number, warnings: readonly string[] = []): Record<string, unknown> {
	return mcpResult({
		resultType: "bindings",
		variables: ["s"],
		rows: Array.from({ length: count }, () => ({
			s: `http://mnemosyne.dev/graph/${graphId}/doc/${payloadDocumentId}`,
		})),
		boolean: null,
		graph: null,
		quadCount: count,
		warnings,
	});
}

/**
 * The cell's real diagnostic, verbatim, for a pattern that could not have matched.
 * Reproduced here rather than paraphrased: this exact string is what came back on
 * 2026-08-06 from the canary, and matching on its SHAPE (a non-empty warnings
 * array) rather than its text is the point of the guard being tested.
 */
const CELL_UNSCOPED_QUERY_WARNING =
	"query has no GRAPH clause but this store is named-graph-partitioned " +
	"(601227 quads live in named graphs); wrap your pattern in GRAPH ?g { } " +
	"or target an explicit graph IRI";

type ServiceDoor =
	| "wake"
	| "verify-face"
	| "verify-ids"
	| "write"
	| "echo-face"
	| "project"
	| "record-ids"
	| "ledger-create"
	| "ledger-write";

type DoorHandler = () => Promise<unknown>;

interface RecordedCall {
	readonly capability: string;
	readonly tool: string;
	readonly args: Record<string, unknown>;
	readonly door: ServiceDoor;
}

/** Beats are sequential and the tool sequence is fixed, so call ordinals name the door. */
function doorFor(key: string, ordinal: number, mode: "seed" | "verify"): ServiceDoor {
	switch (key) {
		case "mcp/get_workspace":
			return "wake";
		case "http/get":
			return mode === "verify" && ordinal === 1 ? "verify-face" : "echo-face";
		case "mcp/read_document":
			return mode === "verify" && ordinal === 1 ? "verify-ids" : "record-ids";
		case "mcp/write_document":
			return ordinal === 1 ? "write" : "ledger-write";
		case "mcp/sparql_query":
			return "project";
		case "mcp/create_document":
			return "ledger-create";
		default:
			throw new Error(`the service battery called an undeclared door ${key}`);
	}
}

function serviceDoors(subject: ServiceScenarioV1, overrides: Partial<Record<ServiceDoor, DoorHandler>> = {}) {
	const mode = subject.expected === undefined ? "seed" : "verify";
	const priorFace = subject.expected?.content ?? "";
	const priorBlockIds = subject.expected?.blockIds ?? [];
	const defaults: Record<ServiceDoor, DoorHandler> = {
		wake: async () =>
			mcpResult({
				graph_id: graphId,
				documents: [{ documentId: payloadDocumentId, title: subject.payload.title }],
			}),
		"verify-face": async () => httpFace(200, priorFace),
		// Reversed on purpose: I4 compares block-id SETS, not read order.
		"verify-ids": async () => idsOnly([...priorBlockIds].reverse()),
		write: async () =>
			mcpResult({
				success: true,
				graph_id: graphId,
				graphId,
				document_id: payloadDocumentId,
				documentId: payloadDocumentId,
				title: subject.payload.title,
				block_ids: [...WRITTEN_BLOCK_IDS],
				blockIds: [...WRITTEN_BLOCK_IDS],
				durability_checked: true,
				durabilityChecked: true,
				source_format: "markdown",
				sourceFormat: "markdown",
				warnings: [],
			}),
		"echo-face": async () => httpFace(200, subject.payload.content),
		project: async () => sparqlRows(1),
		"record-ids": async () => idsOnly(WRITTEN_BLOCK_IDS),
		"ledger-create": async () => mcpResult({ success: true, documentId: `obs-svc-findings-${subject.runId}` }),
		"ledger-write": async () => mcpResult({ success: true, block_ids: ["blk-l1"], blockIds: ["blk-l1"] }),
	};
	const seen = new Map<string, number>();
	const calls: RecordedCall[] = [];
	const invoke = async (invocation: { capability: string; tool: string; args: Record<string, unknown> }) => {
		const key = `${invocation.capability}/${invocation.tool}`;
		// A retry repeats the same action's exact arguments back to back; it is the
		// same door answering again, not the next beat's door.
		const last = calls[calls.length - 1];
		const isRetry =
			last !== undefined &&
			`${last.capability}/${last.tool}` === key &&
			JSON.stringify(last.args) === JSON.stringify(invocation.args);
		let door: ServiceDoor;
		if (isRetry) {
			door = last.door;
		} else {
			const ordinal = (seen.get(key) ?? 0) + 1;
			seen.set(key, ordinal);
			door = doorFor(key, ordinal, mode);
		}
		calls.push({ ...invocation, door });
		return (overrides[door] ?? defaults[door])();
	};
	return { invoke, calls };
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
	...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

const journey = async (
	items: readonly unknown[],
	handler: (item: unknown, control: { directives: string[] }) => Promise<unknown>,
) => {
	const results: unknown[] = [];
	for (const item of items) results.push(await handler(item, { directives: [] }));
	return results;
};

async function replay(
	built: NormalizedServiceScenario,
	overrides: Partial<Record<ServiceDoor, DoorHandler>> = {},
): Promise<{ output: ServiceBatteryResult; calls: readonly RecordedCall[] }> {
	const compiled = compileWorkflow(SERVICE_BATTERY_SCRIPT);
	const doors = serviceDoors(built.scenario, overrides);
	const execute = new AsyncFunction(
		"args",
		"invoke",
		"phase",
		"journey",
		"log",
		"parallel",
		"pipeline",
		"contract",
		compiled.bodySource,
	);
	const output = await execute(
		{
			scenario: built.scenario,
			canonicalJson: built.canonicalJson,
			digest: built.digest,
			sutGraph: graphId,
			recordGraph: SERVICE_RECORD_GRAPH_DEFAULT,
		},
		doors.invoke,
		() => {},
		journey,
		() => {},
		(thunks: Array<() => Promise<unknown>>) => Promise.all(thunks.map((thunk) => thunk())),
		(items: unknown[], ...stages: Array<(value: unknown) => Promise<unknown>>) =>
			Promise.all(
				items.map(async (item) => {
					let value = item;
					for (const stage of stages) value = await stage(value);
					return value;
				}),
			),
		(_name: string, schema: unknown) => schema,
	);
	// The production path validates program output against the declared schema
	// (program-runner.ts:159); a local replay clears the identical gate.
	assertJsonSchema(output, compiled.meta.outputs, "output");
	return { output: output as ServiceBatteryResult, calls: doors.calls };
}

const seedRun = () =>
	buildServiceScenario({
		runId: "svc-run-10",
		scenarioId: "svc-scenario-10",
		sutGraph: graphId,
		payloadDocumentId,
		nonce: "9f3a2b7c",
		now: REPLAY_NOW,
	});

const verifyRun = () =>
	buildServiceScenario({
		runId: "svc-run-11",
		scenarioId: "svc-scenario-11",
		sutGraph: graphId,
		payloadDocumentId,
		nonce: "51d0c4ae",
		now: REPLAY_NOW + SERVICE_MIN_INCARNATION_GAP_MS,
		prior: {
			status: "passed",
			payloadContent: priorContent,
			nextExpected: {
				runId: "svc-run-10",
				payloadDocumentId,
				payloadSha256: sha256(priorContent),
				blockIds: [...PRIOR_BLOCK_IDS],
				writtenAtMs: REPLAY_NOW,
			},
		},
	});

function draft(built: NormalizedServiceScenario, change: (value: Record<string, any>) => void): unknown {
	const copy = structuredClone(built.scenario) as unknown as Record<string, any>;
	change(copy);
	return copy;
}

const decisive = (output: ServiceBatteryResult) =>
	output.verdicts.filter((verdict) => verdict.result === "pass" || verdict.result === "fail");

const byCode = (output: ServiceBatteryResult, code: string) => output.verdicts.find((verdict) => verdict.code === code);

/**
 * An undecided invariant is recorded in the run's own ledger and NEVER carries a
 * verdict code — that absence is what keeps it out of Observatory testimony.
 */
function assertUndecided(
	output: ServiceBatteryResult,
	code: string,
	expected: { readonly reason: string; readonly beat?: string },
): void {
	const record = byCode(output, code);
	if (record !== undefined) {
		assert.equal(record.result, "inconclusive");
		assert.equal(record.verdictCode, undefined, `${code} must not carry a verdict code`);
	}
	const entry = output.inconclusive.find((item) => item.code === code);
	assert.ok(entry, `${code} must be recorded in the run's inconclusive ledger`);
	assert.equal(entry.reason, expected.reason);
	if (expected.beat !== undefined) assert.equal(entry.beat, expected.beat);
}

describe("Garden service battery workflow definition", () => {
	it("compiles an agentless program workflow bound to only the mcp and http doors", () => {
		const compiled = compileWorkflow(SERVICE_BATTERY_SCRIPT);
		assert.equal(SERVICE_BATTERY_WORKFLOW_NAME, "service-battery-durability-v1");
		assert.equal(compiled.meta.name, SERVICE_BATTERY_WORKFLOW_NAME);
		assert.equal(compiled.meta.executor, "dumb");

		const execution = resolveExecutionBinding(compiled.meta);
		assert.equal(execution.controller, "program");
		assert.equal(execution.modelUse, "none");
		assert.equal(execution.isolation, "sandbox");
		assert.equal(execution.effects, "capability-bound");
		assert.equal(execution.reproducibility, "recorded-external");
		assert.equal(execution.mayInvokeChildren, false);
		assert.equal(execution.authority.minimumRole, "editor");
		assert.equal(execution.authority.dangerousOps, false);
		assert.deepEqual(compiled.meta.execution?.capabilities, ["mcp", "http"]);
		assert.deepEqual(execution.capabilities, ["http", "mcp"], "the resolved binding is the sorted set");
		assert.deepEqual([...SERVICE_CAPABILITIES], ["mcp", "http"]);
		assert.deepEqual([...SERVICE_INVARIANTS], ["I1", "I4", "I5"]);
		assert.deepEqual(
			[...SERVICE_OPERATIONS],
			["wake", "verify-face", "verify-ids", "write", "echo-face", "project", "record-ids", "findings"],
		);

		// No browser, no evaluator, no second graph bind: service doors only.
		assert.equal(SERVICE_BATTERY_SCRIPT.includes("browser."), false);
		assert.equal(SERVICE_BATTERY_SCRIPT.includes("evaluation."), false);
		assert.equal(SERVICE_BATTERY_SCRIPT.includes("capture_beat"), false);

		// The registry envelope reaches the same fenced inputs the runner validates.
		const wrapped = buildServiceBatteryWorkflowInputs({ workflow_args: { scenario } }, graphId);
		assertJsonSchema(wrapped.schemaInput, compiled.meta.inputs, "input");
		assert.throws(() =>
			assertJsonSchema(
				{ ...(wrapped.schemaInput as Record<string, unknown>), sutGraph: "obs-hoja-local" },
				compiled.meta.inputs,
				"input",
			),
		);

		// Both graphs are named in the PORTABLE program source, so a reader of the
		// stored definition can see which graph a run corrupts and which it files
		// into without reading the host. The declared record enum is the same pin
		// the host applies, asserted here because they are two copies of one fact.
		const inputs = compiled.meta.inputs as {
			required: string[];
			properties: Record<string, { enum?: string[]; pattern?: string }>;
		};
		assert.deepEqual(inputs.required, ["scenario", "digest", "sutGraph", "recordGraph"]);
		assert.deepEqual(inputs.properties.recordGraph.enum, [...SERVICE_RECORD_GRAPHS]);
		assert.equal(inputs.properties.sutGraph.pattern, "^obs-svc-[A-Za-z0-9._-]+$");
		assert.throws(() =>
			assertJsonSchema(
				{ ...(wrapped.schemaInput as Record<string, unknown>), recordGraph: "observatory-scratch" },
				compiled.meta.inputs,
				"input",
			),
		);

		// The sandbox never writes the record: it holds no capability against a
		// second graph, and the program body never mentions the record graph at all.
		assert.equal(SERVICE_BATTERY_SCRIPT.includes("args.recordGraph"), false);
		assert.equal(SERVICE_BATTERY_SCRIPT.includes("sparql_update"), false);

		// The host attaches the record outcome after the sandbox returns, so the
		// declared output must admit it — and must still validate without it.
		const outputs = compiled.meta.outputs as { required: string[]; properties: Record<string, unknown> };
		assert.ok(Object.hasOwn(outputs.properties, "record"));
		assert.equal(outputs.required.includes("record"), false);
	});
});

describe("Garden service battery replay", () => {
	it("passes all four invariants when both doors agree across the incarnation boundary", async () => {
		const built = verifyRun();
		const startedAt = Date.now();
		const { output, calls } = await replay(built);

		assert.equal(output.schema, SERVICE_BATTERY_RESULT_SCHEMA);
		assert.equal(output.scenarioId, built.scenario.id);
		assert.equal(output.scenarioDigest, built.digest);
		assert.equal(output.status, "passed");
		assert.deepEqual(
			decisive(output)
				.map((verdict) => verdict.verdictCode)
				.sort(),
			["durability_pass", "echo_pass", "identity_pass", "projection_pass"],
		);
		assert.deepEqual(output.inconclusive, []);

		// The nine capability.call events of one verify run, in order. The ledger is
		// written after the verdicts exist, so its two calls come last.
		assert.deepEqual(
			calls.map((call) => `${call.capability}/${call.tool}`),
			[
				"mcp/get_workspace",
				"http/get",
				"mcp/read_document",
				"mcp/write_document",
				"http/get",
				"mcp/sparql_query",
				"mcp/read_document",
				"mcp/create_document",
				"mcp/write_document",
			],
		);
		assert.equal(
			calls.filter((call) => call.tool === "sparql_query").length,
			1,
			"one query, one attempt, never concurrent",
		);
		assert.deepEqual(
			output.beats.map((beat) => beat.id),
			["wake", "verify-face", "verify-ids", "write", "echo-face", "project", "record-ids", "findings"],
		);

		const durability = byCode(output, "durability");
		assert.equal(durability?.invariant, "I1");
		assert.ok((durability?.observedMs ?? 0) > 0, "durability carries the content survival age");
		assert.equal(byCode(output, "identity")?.invariant, "I4");
		assert.ok((byCode(output, "identity")?.observedMs ?? 0) > 0);
		assert.equal(byCode(output, "projection")?.invariant, "I5");
		assert.equal(byCode(output, "projection")?.maximumMs, 30_000);
		assert.equal(byCode(output, "echo")?.observedMs, undefined, "the cross-door echo measures no span");

		const next = output.nextExpected;
		assert.ok(next);
		assert.equal(next.runId, built.scenario.runId);
		assert.equal(next.payloadDocumentId, payloadDocumentId);
		assert.equal(next.payloadSha256, sha256(built.scenario.payload.content));
		assert.deepEqual([...next.blockIds].sort(), [...WRITTEN_BLOCK_IDS].sort());
		assert.ok(next.writtenAtMs >= startedAt);
		assert.deepEqual(output.ledger, {
			status: "written",
			sutGraph: graphId,
			documentId: "obs-svc-findings-svc-run-11",
		});

		// The run output carries coordinates, classes and bounded integers only.
		const serialized = JSON.stringify(output);
		for (const secret of ["This paragraph is written through the MCP door", "nonce 51d0c4ae", "nonce a1b2c3"]) {
			assert.equal(serialized.includes(secret), false, `run output leaked observed content: ${secret}`);
		}
	});

	it("runs the seed shape with two verdicts, one face read and no durability claim", async () => {
		const built = seedRun();
		const { output, calls } = await replay(built);
		assert.equal(built.mode, "seed");
		assert.equal(output.status, "passed");
		assert.deepEqual(
			decisive(output)
				.map((verdict) => verdict.verdictCode)
				.sort(),
			["echo_pass", "projection_pass"],
		);
		assert.equal(calls.filter((call) => call.capability === "http").length, 1);
		assert.equal(
			calls.some((call) => call.door === "verify-face" || call.door === "verify-ids"),
			false,
		);
		assert.ok(output.nextExpected);
	});

	it("treats a mid-run cell reprovision as inconclusive rather than a durability failure", async () => {
		const { output } = await replay(verifyRun(), {
			"verify-face": async () => httpFace(202, GRAPH_ACTIVATING_BODY, "application/json"),
			"verify-ids": async () => {
				throw new Error("mcp read_document failed: 202 graph_activating");
			},
		});
		assert.equal(output.status, "inconclusive");
		assert.deepEqual(
			decisive(output)
				.map((verdict) => verdict.verdictCode)
				.sort(),
			["echo_pass", "projection_pass"],
		);
		assertUndecided(output, "durability", { reason: "graph_activating", beat: "verify-face" });
		assertUndecided(output, "identity", { reason: "graph_activating", beat: "verify-ids" });
		assert.deepEqual(
			output.inconclusive.map((entry) => entry.code),
			["durability", "identity"],
			"an idle reap and a spot interrupt look identical from here, and both are silence",
		);
	});

	it("fails durability decisively when a live cell says the payload does not exist", async () => {
		const { output } = await replay(verifyRun(), {
			"verify-face": async () => httpFace(404, "document not found", "text/plain; charset=utf-8"),
			"verify-ids": async () => {
				throw new Error(`read_document failed: document '${payloadDocumentId}' not found`);
			},
		});
		assert.equal(byCode(output, "durability")?.result, "fail");
		assert.equal(byCode(output, "durability")?.verdictCode, "durability_missing");
		assert.equal(output.status, "failed");
		// A denial or a call error is an authority question (S2), not a face defect.
		assertUndecided(output, "identity", { reason: "call_error", beat: "verify-ids" });
	});

	it("emits no verdict at all when the liveness gate never opens", async () => {
		const { output } = await replay(verifyRun(), {
			wake: async () => {
				throw new Error(`POST ${GATEWAY}/o/${OWNER_SEGMENT}/g/${graphId}/mcp timed out after 180000ms`);
			},
		});
		assert.equal(output.status, "inconclusive");
		assert.deepEqual(output.verdicts, [], "an unreachable cell makes every downstream reading a guess");
		assert.deepEqual(output.inconclusive, [{ beat: "wake", reason: "timeout" }]);
		assert.equal(output.nextExpected, undefined);
	});

	it("resolves a timed-out first write by re-reading instead of calling it a failure", async () => {
		const built = verifyRun();
		let attempts = 0;
		const { output } = await replay(built, {
			write: async () => {
				attempts += 1;
				// The known cold-cell defect, verbatim from mnemosyne.ts:816.
				throw new Error(`POST ${GATEWAY}/o/${OWNER_SEGMENT}/g/${graphId}/mcp timed out after 60000ms`);
			},
		});
		assert.equal(attempts, 1, "a timed-out write is never retried");
		assert.equal(byCode(output, "echo")?.result, "pass");
		assert.equal(byCode(output, "echo")?.verdictCode, "echo_pass", "the read decides whether the write landed");
		assert.notEqual(output.status, "failed");

		const write = output.beats.find((beat) => beat.id === "write");
		assert.equal(write?.actions[0]?.attempts, 1);
		assert.equal(write?.actions[0]?.class, "inconclusive");
		assert.equal(write?.actions[0]?.ok, false);
		// An uncertain write makes the projection question vacuous: the node the
		// SPARQL face returns may be the previous run's.
		assertUndecided(output, "projection", { reason: "timeout", beat: "write" });
	});

	it("re-attempts only an inconclusive read, and only within the scenario's licence", async () => {
		const built = verifyRun();
		let faceCalls = 0;
		const { output } = await replay(built, {
			"verify-face": async () => {
				faceCalls += 1;
				return faceCalls === 1 ? httpFace(503, "upstream unavailable", "text/plain") : httpFace(200, priorContent);
			},
		});
		assert.equal(faceCalls, 2, "retries: 1 buys exactly one more attempt");
		assert.equal(byCode(output, "durability")?.result, "pass");
		assert.equal(output.beats.find((beat) => beat.id === "verify-face")?.actions[0]?.attempts, 2);
	});

	it("separates a projection that never arrived from one that arrived too late", async () => {
		const empty = await replay(verifyRun(), { project: async () => sparqlRows(0) });
		assert.equal(byCode(empty.output, "projection")?.result, "fail");
		assert.equal(byCode(empty.output, "projection")?.verdictCode, "projection_missing");
		assert.equal(empty.output.status, "failed");

		// Real elapsed time against a one-millisecond bound; no clock is faked.
		const impatient = normalizeServiceScenario(
			draft(verifyRun(), (copy) => {
				for (const invariant of copy.invariants) if (invariant.id === "I5") invariant.maxMs = 1;
			}),
		);
		const late = await replay(impatient, {
			project: async () => {
				await delay(40);
				return sparqlRows(1);
			},
		});
		const slow = byCode(late.output, "projection");
		assert.equal(slow?.result, "fail");
		assert.equal(slow?.verdictCode, "projection_slow");
		assert.equal(slow?.maximumMs, 1);
		assert.ok((slow?.observedMs ?? 0) > 1);
	});

	it("defers to the cell's own diagnosis instead of blaming the platform for a bad query", async () => {
		// Zero rows AND a warning is the cell saying "your pattern could not match",
		// not "the content is absent". Judging that as projection_missing is exactly
		// the mistake this battery made on 2026-08-05 against a healthy cell.
		const misjudged = await replay(verifyRun(), {
			project: async () => sparqlRows(0, [CELL_UNSCOPED_QUERY_WARNING]),
		});
		assertUndecided(misjudged.output, "projection", {
			reason: "projection_query_rejected",
			beat: "project",
		});
		assert.equal(
			misjudged.output.status,
			"inconclusive",
			"a run that could not read its own projection has not proved the projection wrong",
		);

		// The guard keys on the warning, not on emptiness — an unflagged empty result
		// is still a real, decisive finding about the platform.
		const genuinelyEmpty = await replay(verifyRun(), { project: async () => sparqlRows(0) });
		assert.equal(byCode(genuinelyEmpty.output, "projection")?.verdictCode, "projection_missing");
	});

	it("chains run k's expectation out of run k-1's own output", async () => {
		const seed = seedRun();
		const first = await replay(seed);
		const written = first.output.nextExpected;
		assert.ok(written, "a clean seed run seals the state the next run will assert");

		const chained = buildServiceScenario({
			runId: "svc-run-12",
			scenarioId: "svc-scenario-12",
			sutGraph: graphId,
			payloadDocumentId,
			nonce: "77b0e1d3",
			now: written.writtenAtMs + SERVICE_MIN_INCARNATION_GAP_MS,
			prior: {
				status: first.output.status,
				payloadContent: seed.scenario.payload.content,
				nextExpected: written,
			},
		});
		assert.equal(chained.mode, "verify");
		assert.deepEqual(chained.scenario.expected, {
			runId: seed.scenario.runId,
			content: seed.scenario.payload.content,
			blockIds: [...WRITTEN_BLOCK_IDS],
			writtenAtMs: written.writtenAtMs,
		});

		// And it reads clean against a cell that kept the bytes it was handed.
		const second = await replay(chained);
		assert.equal(second.output.status, "passed");
		assert.deepEqual(
			decisive(second.output)
				.map((verdict) => verdict.verdictCode)
				.sort(),
			["durability_pass", "echo_pass", "identity_pass", "projection_pass"],
		);
	});
});
