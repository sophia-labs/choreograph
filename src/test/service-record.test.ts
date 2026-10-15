import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { HostedMnemosyneProxy } from "../mnemosyne.js";
import type { CaptureIdentity } from "../observatory-capture.js";
import { CaptureWriter } from "../observatory-capture.js";
import { makeHostedGraphWriter, scopeUpdateToUserRdfGraph } from "../workflow/graph-writer.js";
import { SERVICE_BATTERY_RESULT_SCHEMA } from "../workflow/script-service-battery.js";
import { SERVICE_RECORD_GRAPH_DEFAULT } from "../workflow/service-battery.js";
import {
	fileServiceBatteryRecord,
	SERVICE_CANON_PROFILE,
	SERVICE_WITNESS_AGENT,
	type ServiceRecordInput,
	serializeServiceBatteryRecord,
	serviceRecordFailure,
	serviceRunSubject,
	serviceTestimonyGraphIri,
	serviceVerdictSubject,
} from "../workflow/service-record.js";
import { emitServiceResultTestimony } from "../workflow/service-testimony.js";
import { userRdfGraphIri } from "../workflow/vocab.js";

/**
 * The record face of the Garden service battery.
 *
 * `service-testimony.test.ts` owns the CaptureEvent face; this file owns the
 * durable one and the seam between them. The two are not alternatives, so the
 * central property here is not "the record is written" but "the record and the
 * stream say the same thing about the same run".
 *
 * NOTHING IS MOCKED. The serializer is exercised on real battery output; the
 * writer is the production `makeHostedGraphWriter` over an in-memory MCP
 * transport that stores what it is handed (the same shape
 * `workflow-graph-writer.test.ts` uses — a transport that records, not a
 * collaborator that pretends); the GRAPH-scoping wrapper is the real one; and
 * the CaptureEvent comparison runs the real `CaptureWriter`. One thing is NOT
 * covered here and is called out where it bites: driving `runProgramInvocation`
 * end to end needs a real sandbox spawner, cgroups and bwrap, which exist only
 * on Linux (`_linux-only.ts`), so the runner's use of this module is tested
 * through the pure decision function it applies, not through the runner.
 */

const RECORD_GRAPH = SERVICE_RECORD_GRAPH_DEFAULT;
const SUT_GRAPH = "obs-svc-canary";
const RUN_ID = "svc-run-11";
const SCENARIO_ID = "svc-scenario-11";
const DIGEST = "a".repeat(64);
const PAYLOAD_SHA = "b".repeat(64);
const OBSERVED_AT = 1_783_890_000_000;
const FILED_AT = 1_783_890_061_000;
const SURVIVAL_MS = 3_612_000;
const PAYLOAD_LINE = "This paragraph is written through the MCP door and read through the export door.";
const PRIOR_LINE = "Run svc-run-10 nonce a1b2c3.";
const IDENTITY: CaptureIdentity = { principal: "service:choreograph", graphId: SUT_GRAPH };

const passedVerdicts = () => [
	{ invariant: "I1", code: "echo", result: "pass", verdictCode: "echo_pass" },
	{ invariant: "I1", code: "durability", result: "pass", verdictCode: "durability_pass", observedMs: SURVIVAL_MS },
	{ invariant: "I4", code: "identity", result: "pass", verdictCode: "identity_pass", observedMs: SURVIVAL_MS },
	{
		invariant: "I5",
		code: "projection",
		result: "pass",
		verdictCode: "projection_pass",
		observedMs: 812,
		maximumMs: 30_000,
	},
];

/** The declared `sophia.service.battery-result.v1` output of one verify run. */
function batteryResult(verdicts: readonly unknown[], overrides: Record<string, unknown> = {}): unknown {
	return {
		schema: SERVICE_BATTERY_RESULT_SCHEMA,
		scenarioId: SCENARIO_ID,
		scenarioDigest: DIGEST,
		status: "passed",
		beats: [
			{
				id: "verify-face",
				operation: "verify-face",
				durationMs: 412,
				actions: [{ ok: true, class: "ok", durationMs: 410, attempts: 1, status: 200 }],
			},
			{
				id: "write",
				operation: "write",
				durationMs: 1_204,
				actions: [
					{
						ok: false,
						class: "inconclusive",
						durationMs: 60_000,
						attempts: 1,
						// A field the record must never read, holding a byte it must never carry.
						error: `write_document failed for '${PAYLOAD_LINE}'`,
					},
				],
			},
		],
		verdicts,
		inconclusive: [],
		nextExpected: {
			runId: RUN_ID,
			payloadDocumentId: "svc-durability-payload",
			payloadSha256: PAYLOAD_SHA,
			blockIds: ["blk-c1", "blk-c2", "blk-c3"],
			writtenAtMs: OBSERVED_AT,
		},
		ledger: { status: "written", sutGraph: SUT_GRAPH, documentId: `obs-svc-findings-${RUN_ID}` },
		...overrides,
	};
}

function recordInput(output: unknown, overrides: Partial<ServiceRecordInput> = {}): ServiceRecordInput {
	return {
		recordGraph: RECORD_GRAPH,
		sutGraph: SUT_GRAPH,
		runId: RUN_ID,
		workflowName: "service-battery-durability-v1",
		output,
		observedAtMs: OBSERVED_AT,
		filedAtMs: FILED_AT,
		...overrides,
	};
}

interface Call {
	tool: string;
	args: Record<string, unknown>;
}

/**
 * The production `GraphWriter` over an in-memory transport. `callTool` really is
 * the cell's entry point — it just keeps what it was given instead of shipping
 * it, so every assertion below is against the bytes a cell would receive.
 */
function recordingWriter(behavior?: (tool: string) => void) {
	const calls: Call[] = [];
	const proxy = {
		async callTool(tool: string, args: Record<string, unknown>) {
			calls.push({ tool, args });
			behavior?.(tool);
			return { content: [] };
		},
	} as unknown as HostedMnemosyneProxy;
	return { writer: makeHostedGraphWriter(proxy), calls };
}

const serialize = (output: unknown = batteryResult(passedVerdicts())) =>
	serializeServiceBatteryRecord(recordInput(output));

describe("Garden service battery record — the named graph", () => {
	it("files into a testimony membrane inside the record graph, not the record graph at large", () => {
		const named = serviceTestimonyGraphIri(RECORD_GRAPH);
		assert.equal(named, "urn:mnemosyne:local:graph:observatory:testimony:service-battery");

		// The membrane is a sibling of the general user-RDF lane, never the same
		// graph: mixing the battery's opinions into `observatory`'s own assertions
		// is exactly what attribution is supposed to prevent.
		assert.notEqual(named, userRdfGraphIri(RECORD_GRAPH));
		// And it is not inside the space `rdf_authority.rs` reserves and refuses.
		assert.equal(named.includes(":projection:"), false);
		assert.equal(named.startsWith("urn:mnemosyne:local:profile:"), false);
		assert.notEqual(named, `urn:mnemosyne:local:graph:${RECORD_GRAPH}`);
	});

	it("carries the literal GRAPH clause that survives the user-RDF wrapper untouched", () => {
		const serialized = serialize();
		assert.ok(serialized);
		const named = serviceTestimonyGraphIri(RECORD_GRAPH);
		assert.ok(serialized.sparql.includes(`GRAPH <${named}> {`));

		// The load-bearing mechanic: `GraphWriter.sparqlUpdate` wraps a BARE update
		// into `…:user:rdf`, and returns an already-scoped one unchanged. Without
		// the explicit clause this testimony would silently land in the record
		// graph's general lane, attributed to nobody.
		assert.equal(scopeUpdateToUserRdfGraph(RECORD_GRAPH, serialized.sparql), serialized.sparql);
		assert.equal(serialized.sparql.includes(userRdfGraphIri(RECORD_GRAPH)), false);

		// One balanced INSERT DATA operation, so the wrapper's brace scan and the
		// cell's parser see the same thing.
		assert.equal(serialized.sparql.split("INSERT DATA").length - 1, 1);
		let depth = 0;
		for (const character of serialized.sparql) {
			if (character === "{") depth += 1;
			if (character === "}") depth -= 1;
			assert.ok(depth >= 0, "unbalanced braces in the record update");
		}
		assert.equal(depth, 0);
		assert.ok(serialized.sparql.startsWith("PREFIX bat: <http://mnemosyne.dev/battery#>"));
	});

	it("describes the membrane so a reader can tell whose account it is", () => {
		const serialized = serialize();
		assert.ok(serialized);
		const named = serviceTestimonyGraphIri(RECORD_GRAPH);
		assert.ok(serialized.sparql.includes(`<${named}>`));
		assert.ok(serialized.sparql.includes("a prov:Entity, bat:PerspectiveGraph"));
		assert.ok(serialized.sparql.includes(`prov:wasAttributedTo <${SERVICE_WITNESS_AGENT}>`));
		assert.equal(SERVICE_WITNESS_AGENT, "urn:sophia:agent:service-battery");
	});
});

describe("Garden service battery record — attributed testimony", () => {
	it("files the run and every decisive verdict as attributed claims", () => {
		const serialized = serialize();
		assert.ok(serialized);
		const { sparql } = serialized;
		assert.equal(serialized.runSubject, `urn:sophia:battery:run:${RUN_ID}`);
		assert.equal(serialized.claimCount, 4);

		// The run: what was observed, by whom, when, against what.
		assert.ok(sparql.includes(`<${serviceRunSubject(RUN_ID)}>`));
		for (const triple of [
			"a bat:Run",
			'bat:runState "complete"',
			`bat:witnessAgent <${SERVICE_WITNESS_AGENT}>`,
			'bat:workflowName "service-battery-durability-v1"',
			`bat:runId "${RUN_ID}"`,
			`bat:scenarioId "${SCENARIO_ID}"`,
			`bat:submissionSha256 "${DIGEST}"`,
			`bat:canonProfile "${SERVICE_CANON_PROFILE}"`,
			`bat:sutGraph "${SUT_GRAPH}"`,
			'bat:outcome "passed"',
			'bat:verdictCount "4"^^xsd:integer',
			'bat:inconclusiveCount "0"^^xsd:integer',
			'bat:beatCount "2"^^xsd:integer',
			`bat:observedAt "${new Date(OBSERVED_AT).toISOString()}"^^xsd:dateTime`,
			`bat:filedAt "${new Date(FILED_AT).toISOString()}"^^xsd:dateTime`,
			`bat:findingsDocument "obs-svc-findings-${RUN_ID}"`,
		]) {
			assert.ok(sparql.includes(triple), `record is missing ${triple}`);
		}

		// Each verdict: its own subject, its own attribution, its own clock.
		for (const verdict of passedVerdicts()) {
			assert.ok(sparql.includes(`<${serviceVerdictSubject(RUN_ID, verdict.verdictCode)}>`));
			assert.ok(sparql.includes(`bat:verdictCode "${verdict.verdictCode}"`));
		}
		assert.equal(sparql.split("a bat:Verdict").length - 1, 4);
		assert.equal(sparql.split(`bat:partOfRun <${serviceRunSubject(RUN_ID)}>`).length - 1, 4);
		assert.equal(sparql.split(`prov:wasAttributedTo <${SERVICE_WITNESS_AGENT}>`).length - 1, 6);
		assert.ok(sparql.includes('bat:invariant "I5"'));
		assert.ok(sparql.includes('bat:observedMs "812"^^xsd:integer'));
		assert.ok(sparql.includes('bat:maximumMs "30000"^^xsd:integer'));
		assert.ok(sparql.includes('bat:passed "true"^^xsd:boolean'));
	});

	it("records a failing verdict as a false claim, not as an absent one", () => {
		const serialized = serialize(
			batteryResult(
				[
					{ invariant: "I1", code: "echo", result: "pass", verdictCode: "echo_pass" },
					{
						invariant: "I4",
						code: "identity",
						result: "fail",
						verdictCode: "identity_fail",
						observedMs: SURVIVAL_MS,
					},
				],
				{ status: "failed" },
			),
		);
		assert.ok(serialized);
		assert.equal(serialized.claimCount, 2);
		assert.ok(serialized.sparql.includes('bat:outcome "failed"'));
		assert.ok(serialized.sparql.includes('bat:passed "false"^^xsd:boolean'));
		assert.ok(serialized.sparql.includes(`<${serviceVerdictSubject(RUN_ID, "identity_fail")}>`));
	});

	it("files no claim for an undecided invariant, exactly as the event stream emits none", () => {
		const output = batteryResult(
			[
				{ invariant: "I1", code: "echo", result: "pass", verdictCode: "echo_pass" },
				// The cell went away mid-run.
				{ invariant: "I1", code: "durability", result: "inconclusive" },
				// S1 has no slot in the ratified invariant enum; a spaced code is not an identifier.
				{ invariant: "S1", code: "durability", result: "pass", verdictCode: "durability_pass" },
				{ invariant: "I4", code: "identity", result: "pass", verdictCode: "Identity Pass" },
			],
			{
				status: "inconclusive",
				inconclusive: [{ invariant: "I1", code: "durability", reason: "graph_activating", beat: "verify-face" }],
			},
		);
		const serialized = serialize(output);
		assert.ok(serialized);
		assert.equal(serialized.claimCount, 1);
		assert.ok(serialized.sparql.includes('bat:verdictCode "echo_pass"'));
		assert.equal(serialized.sparql.includes("durability_pass"), false);
		assert.equal(serialized.sparql.includes("Identity Pass"), false);
		// An inconclusive run is still testimony: "this run asserted nothing" is a
		// fact worth filing, and the count says so without inventing a verdict.
		assert.ok(serialized.sparql.includes('bat:outcome "inconclusive"'));
		assert.ok(serialized.sparql.includes('bat:verdictCount "1"^^xsd:integer'));
		assert.ok(serialized.sparql.includes('bat:inconclusiveCount "1"^^xsd:integer'));
	});

	/**
	 * The two faces of one testimony must agree. If they can disagree, one of them
	 * is decoration — and the durable one is the one nobody would notice drifting.
	 */
	it("files exactly the verdicts the CaptureEvent stream emits, and no others", async () => {
		const output = batteryResult([
			{ invariant: "I1", code: "echo", result: "pass", verdictCode: "echo_pass" },
			{ invariant: "I1", code: "durability", result: "inconclusive" },
			{ invariant: "I4", code: "identity", result: "fail", verdictCode: "identity_fail", observedMs: SURVIVAL_MS },
			{
				invariant: "I5",
				code: "projection",
				result: "fail",
				verdictCode: "projection_slow",
				observedMs: 41_000,
				maximumMs: 30_000,
			},
		]);

		const sink = new PassThrough();
		let wire = "";
		sink.setEncoding("utf8");
		sink.on("data", (chunk: string) => {
			wire += chunk;
		});
		const writer = new CaptureWriter({ sink, hostId: "host-a", heartbeatMs: 0 });
		emitServiceResultTestimony({ capture: writer, identity: IDENTITY, runId: RUN_ID, output });
		assert.equal(await writer.close(), true);

		const emitted = wire
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line) as { payload: { verdict_code: string; invariant: string; passed: boolean } });
		const serialized = serialize(output);
		assert.ok(serialized);

		assert.equal(serialized.claimCount, emitted.length);
		for (const event of emitted) {
			assert.ok(
				serialized.sparql.includes(`<${serviceVerdictSubject(RUN_ID, event.payload.verdict_code)}>`),
				`the stream emitted ${event.payload.verdict_code} and the record did not file it`,
			);
			assert.ok(serialized.sparql.includes(`bat:invariant "${event.payload.invariant}"`));
			assert.ok(serialized.sparql.includes(`bat:passed "${event.payload.passed}"^^xsd:boolean`));
		}
		assert.deepEqual(
			emitted.map((event) => event.payload.verdict_code),
			["echo_pass", "identity_fail", "projection_slow"],
		);
	});

	it("carries coordinates and bounded integers only — never an observed byte", () => {
		const leaky = passedVerdicts().map((verdict) => ({
			...verdict,
			// A shape a future implementation might grow; the record must ignore it.
			observed: { left: PAYLOAD_LINE, right: PRIOR_LINE },
		}));
		const serialized = serialize(batteryResult(leaky));
		assert.ok(serialized);
		for (const secret of [PAYLOAD_LINE, PRIOR_LINE, "blk-c1", PAYLOAD_SHA, "write_document failed"]) {
			assert.equal(serialized.sparql.includes(secret), false, `the record leaked ${secret}`);
		}
		// The payload digest in particular: a durable graph is a worse place to
		// leave a content fingerprint than a 72-hour window, not a better one.
		assert.equal(serialized.sparql.includes("nextExpected"), false);
	});

	it("is deterministic — re-filing the same run rewrites the same subjects", () => {
		const first = serialize();
		const second = serialize();
		assert.ok(first && second);
		assert.equal(first.sparql, second.sparql);
		assert.equal(first.runSubject, second.runSubject);
	});

	it("refuses foreign output and coordinates the fence does not admit", () => {
		assert.equal(serialize(batteryResult(passedVerdicts(), { schema: "sophia.hoja.swarm-result.v1" })), undefined);
		assert.equal(serialize(batteryResult(passedVerdicts(), { scenarioId: "not a scenario id" })), undefined);
		assert.equal(serialize(batteryResult(passedVerdicts(), { status: "green" })), undefined);
		// Not via `serialize`: its default argument would swallow the undefined.
		assert.equal(serializeServiceBatteryRecord(recordInput(undefined)), undefined);
		assert.equal(serialize("a string"), undefined);
		for (const bad of [{ runId: "not a run id" }, { recordGraph: "" }, { sutGraph: "obs svc canary" }]) {
			assert.equal(
				serializeServiceBatteryRecord(recordInput(batteryResult(passedVerdicts()), bad)),
				undefined,
				`the record fence admitted ${JSON.stringify(bad)}`,
			);
		}
		// A digest that is not a digest drops the digest, not the record: the run
		// still happened and its verdicts are still true.
		const noDigest = serialize(batteryResult(passedVerdicts(), { scenarioDigest: "nope" }));
		assert.ok(noDigest);
		assert.equal(noDigest.sparql.includes("bat:submissionSha256"), false);
		assert.equal(noDigest.claimCount, 4);
	});
});

describe("Garden service battery record — the write", () => {
	it("writes through the cell's camelCase contract, bound to the RECORD graph", async () => {
		const { writer, calls } = recordingWriter();
		const requested: string[] = [];
		const outcome = await fileServiceBatteryRecord(
			{
				recordWriterFor: async (graphId) => {
					requested.push(graphId);
					return writer;
				},
			},
			recordInput(batteryResult(passedVerdicts())),
		);
		// The writer is asked for by the RECORD graph, never the run's own graph.
		assert.deepEqual(requested, [RECORD_GRAPH]);

		assert.deepEqual(outcome, {
			status: "written",
			recordGraph: RECORD_GRAPH,
			namedGraph: serviceTestimonyGraphIri(RECORD_GRAPH),
			runSubject: serviceRunSubject(RUN_ID),
			claimCount: 4,
		});
		assert.equal(calls.length, 1);
		assert.equal(calls[0].tool, "sparql_update");
		// The cell reads ONLY camelCase; the snake_case shape degrades to an empty update.
		assert.equal(calls[0].args.graphId, RECORD_GRAPH);
		assert.equal(calls[0].args.graph_id, undefined);
		assert.equal(calls[0].args.sparql, undefined);
		// Under service-auth the gateway strips `graphId` and routes by the proxy's
		// owner-scoped URL, so the SUT graph must never appear as the call's target.
		assert.notEqual(calls[0].args.graphId, SUT_GRAPH);
		const update = calls[0].args.update as string;
		assert.ok(update.includes(`GRAPH <${serviceTestimonyGraphIri(RECORD_GRAPH)}>`));
		assert.equal(update.includes(`graph:${SUT_GRAPH}:`), false);
	});

	it("is a no-op for every workflow whose output is not a battery result", async () => {
		const { writer, calls } = recordingWriter();
		const outcome = await fileServiceBatteryRecord(
			{ recordWriterFor: async () => writer },
			recordInput({ schema: "sophia.hoja.swarm-result.v1", scenarioId: SCENARIO_ID }),
		);
		assert.equal(outcome, undefined);
		assert.deepEqual(calls, []);
		assert.equal(serviceRecordFailure(outcome), undefined);
	});

	it("classifies a refused write without carrying the provider's message into the record", async () => {
		const cases: ReadonlyArray<{ error: Error; reason: string }> = [
			{ error: new Error("MCP error -32000: HTTP 403 forbidden"), reason: "denied" },
			{ error: new Error("sparql_update timed out after 60000ms"), reason: "timeout" },
			{ error: new Error('202 {"code":"graph_activating","phase":"hydrating"}'), reason: "transport" },
			{ error: new Error("socket hang up"), reason: "transport" },
			{ error: new Error("the cell said no"), reason: "call_error" },
		];
		for (const { error, reason } of cases) {
			const { writer } = recordingWriter((tool) => {
				if (tool === "sparql_update") throw error;
			});
			const outcome = await fileServiceBatteryRecord(
				{ recordWriterFor: async () => writer },
				recordInput(batteryResult(passedVerdicts())),
			);
			assert.equal(outcome?.status, "error");
			assert.equal(outcome?.reason, reason, `'${error.message}' classified as ${outcome?.reason}`);
			// The reason is a closed vocabulary; the operator-facing text lives in the
			// invocation error envelope, which is host telemetry and not testimony.
			assert.equal(JSON.stringify(outcome).includes(error.message), false);
		}
	});

	/**
	 * The other door to the same lie: not a refused write, a run that could never
	 * have been addressed. Unreachable through `buildServiceBatteryInputs`, which
	 * always resolves an allowlisted record graph — but a silent skip here would be
	 * indistinguishable from a clean run, so it is a failure, not a no-op.
	 */
	it("refuses to pass a battery result it cannot address to a record", async () => {
		for (const bad of [{ recordGraph: "" }, { runId: "not a run id" }]) {
			const { writer, calls } = recordingWriter();
			const outcome = await fileServiceBatteryRecord(
				{ recordWriterFor: async () => writer },
				recordInput(batteryResult(passedVerdicts()), bad),
			);
			assert.equal(outcome?.status, "error", `${JSON.stringify(bad)} was treated as a clean run`);
			assert.equal(outcome?.reason, "unrecordable");
			assert.equal(outcome?.claimCount, 0);
			assert.deepEqual(calls, [], "nothing may be written when the record cannot be addressed");
			assert.equal(serviceRecordFailure(outcome)?.code, "record_write_failed");
		}
	});

	it("reports a run with no bound record writer as unavailable, never as written", async () => {
		const outcome = await fileServiceBatteryRecord({}, recordInput(batteryResult(passedVerdicts())));
		assert.equal(outcome?.status, "unavailable");
		assert.equal(outcome?.reason, "no_writer");
		// The claims were computed; they simply were not filed. Saying so is what
		// keeps "nothing was written" distinguishable from "nothing to write".
		assert.equal(outcome?.claimCount, 4);
	});

	it("surfaces a writer that cannot even be opened as a record failure, not a crash", async () => {
		const outcome = await fileServiceBatteryRecord(
			{
				recordWriterFor: async () => {
					throw new Error("graph 'observatory' is not visible to this owner tuple");
				},
			},
			recordInput(batteryResult(passedVerdicts())),
		);
		assert.equal(outcome?.status, "error");
		assert.equal(outcome?.reason, "call_error");
	});
});

/**
 * The run's verdict on its own recording.
 *
 * This is the decision `runProgramInvocation` applies verbatim: `serviceRecordFailure`
 * is the whole rule, and the runner does nothing with it but choose a receipt
 * status. Driving the runner itself would need a real spawner + cgroup v2 +
 * bwrap (Linux only, `_linux-only.ts`), so the rule is tested where it lives
 * rather than through a stubbed sandbox — which would prove only that the stub
 * behaves as written.
 */
describe("Garden service battery record — an unfiled judgment is not a success", () => {
	it("fails the run when the record write failed, and names the record path", async () => {
		const { writer } = recordingWriter((tool) => {
			if (tool === "sparql_update") throw new Error("HTTP 403 forbidden");
		});
		const outcome = await fileServiceBatteryRecord(
			{ recordWriterFor: async () => writer },
			recordInput(batteryResult(passedVerdicts())),
		);
		const failure = serviceRecordFailure(outcome);
		assert.ok(failure);
		assert.equal(failure.code, "record_write_failed");
		// The error is about the RECORD, never about Garden: a record failure that
		// read as a service defect would poison the metric the three-valued design
		// exists to protect.
		assert.match(failure.message, /record/);
		assert.equal(failure.message.includes("invariant"), false);
		assert.deepEqual(failure.details, {
			recordGraph: RECORD_GRAPH,
			namedGraph: serviceTestimonyGraphIri(RECORD_GRAPH),
			runSubject: serviceRunSubject(RUN_ID),
			claimCount: 4,
			reason: "denied",
		});
	});

	it("fails the run when there was no writer at all — half a battery is not a green one", async () => {
		const failure = serviceRecordFailure(
			await fileServiceBatteryRecord({}, recordInput(batteryResult(passedVerdicts()))),
		);
		assert.ok(failure);
		assert.equal(failure.code, "record_write_unavailable");
	});

	it("passes the run only when the record actually landed", async () => {
		const { writer } = recordingWriter();
		const outcome = await fileServiceBatteryRecord(
			{ recordWriterFor: async () => writer },
			recordInput(batteryResult(passedVerdicts())),
		);
		assert.equal(outcome?.status, "written");
		assert.equal(serviceRecordFailure(outcome), undefined);
	});

	it("leaves every other program workflow's outcome untouched", () => {
		assert.equal(serviceRecordFailure(undefined), undefined);
	});
});
