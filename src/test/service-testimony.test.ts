import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import type { CaptureEmitter, CaptureIdentity, ChoreographCaptureEvent } from "../observatory-capture.js";
import { CaptureWriter, OBSERVATORY_CONTRACT_BUNDLE_SHA256 } from "../observatory-capture.js";
import { hojaLogicalRunId } from "../workflow/hoja-testimony.js";
import { SERVICE_BATTERY_RESULT_SCHEMA } from "../workflow/script-service-battery.js";
import { emitServiceResultTestimony } from "../workflow/service-testimony.js";

class RecordingCapture implements CaptureEmitter {
	readonly events: ChoreographCaptureEvent[] = [];
	emit(event: ChoreographCaptureEvent): void {
		this.events.push(event);
	}
}

const RUN_ID = "svc-run-11";
const SCENARIO_ID = "svc-scenario-11";
const GRAPH_ID = "obs-svc-canary";
const IDENTITY: CaptureIdentity = { principal: "service:choreograph", graphId: GRAPH_ID };

/** The ratified `test_invariant` domain — `observatory/contract/obs.golden.json`. */
const RATIFIED_INVARIANTS = ["I1", "I2", "I3", "I4", "I5", "L1", "L2-primary", "L2-foreign"];
/** `IDENTIFIER_PATTERN`, observatory-capture.ts:19 — the open axis the family rides. */
const VERDICT_CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
const WIRE_VERDICT_FIELDS = [
	"run_id",
	"scenario_id",
	"invariant",
	"passed",
	"verdict_code",
	"beat_id",
	"engine",
	"evidence_uri",
	"evidence_sha256",
	"observed_ms",
	"maximum_ms",
];
const PAYLOAD_KEYS = ["runId", "scenarioId", "invariant", "passed", "verdictCode", "observedMs", "maximumMs"];

const SURVIVAL_MS = 3_612_000;
const PAYLOAD_LINE = "This paragraph is written through the MCP door and read through the export door.";
const PRIOR_LINE = "Run svc-run-10 nonce a1b2c3.";

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
		scenarioDigest: "a".repeat(64),
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
						// A field the projector must never read, holding a byte it must never carry.
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
			payloadSha256: "b".repeat(64),
			blockIds: ["blk-c1", "blk-c2", "blk-c3"],
			writtenAtMs: 1_783_890_000_000,
		},
		ledger: { status: "written", sutGraph: GRAPH_ID, documentId: `obs-svc-findings-${RUN_ID}` },
		...overrides,
	};
}

const verdictEvents = (capture: RecordingCapture) =>
	capture.events.filter(
		(event): event is Extract<ChoreographCaptureEvent, { kind: "test.verdict" }> => event.kind === "test.verdict",
	);

describe("Garden service battery Observatory projection", () => {
	it("projects exactly the four service verdicts and never a browser beat", () => {
		const capture = new RecordingCapture();
		emitServiceResultTestimony({
			capture,
			identity: IDENTITY,
			runId: RUN_ID,
			output: batteryResult(passedVerdicts()),
		});

		assert.equal(
			capture.events.filter((event) => event.kind === "test.beat").length,
			0,
			"this flow drives no browser and stores no bytes; a fabricated engine would be false testimony",
		);
		const verdicts = verdictEvents(capture);
		assert.equal(verdicts.length, 4);
		assert.deepEqual(
			verdicts.map((event) => event.payload),
			[
				{ runId: RUN_ID, scenarioId: SCENARIO_ID, invariant: "I1", passed: true, verdictCode: "echo_pass" },
				{
					runId: RUN_ID,
					scenarioId: SCENARIO_ID,
					invariant: "I1",
					passed: true,
					verdictCode: "durability_pass",
					observedMs: SURVIVAL_MS,
				},
				{
					runId: RUN_ID,
					scenarioId: SCENARIO_ID,
					invariant: "I4",
					passed: true,
					verdictCode: "identity_pass",
					observedMs: SURVIVAL_MS,
				},
				{
					runId: RUN_ID,
					scenarioId: SCENARIO_ID,
					invariant: "I5",
					passed: true,
					verdictCode: "projection_pass",
					observedMs: 812,
					maximumMs: 30_000,
				},
			],
		);
		assert.deepEqual(
			verdicts.map((event) => event.outcome),
			["ok", "ok", "ok", "ok"],
		);
		for (const event of verdicts) assert.equal(event.graphId, GRAPH_ID);
	});

	it("emits only decisive readings — an undecided invariant is silence", () => {
		const capture = new RecordingCapture();
		emitServiceResultTestimony({
			capture,
			identity: IDENTITY,
			runId: RUN_ID,
			output: batteryResult(
				[
					{ invariant: "I1", code: "echo", result: "pass", verdictCode: "echo_pass" },
					// The cell went away mid-run: recorded in the run output, never on the wire.
					{ invariant: "I1", code: "durability", result: "inconclusive" },
					{
						invariant: "I4",
						code: "identity",
						result: "fail",
						verdictCode: "identity_fail",
						observedMs: SURVIVAL_MS,
					},
					{
						invariant: "I5",
						code: "projection",
						result: "fail",
						verdictCode: "projection_slow",
						observedMs: 41_000,
						maximumMs: 30_000,
					},
				],
				{
					status: "failed",
					inconclusive: [{ invariant: "I1", code: "durability", reason: "graph_activating", beat: "verify-face" }],
				},
			),
		});

		const verdicts = verdictEvents(capture);
		assert.deepEqual(
			verdicts.map((event) => event.payload.verdictCode),
			["echo_pass", "identity_fail", "projection_slow"],
		);
		assert.deepEqual(
			verdicts.map((event) => event.outcome),
			["ok", "error", "error"],
		);
		assert.deepEqual(
			verdicts.map((event) => event.payload.passed),
			[true, false, false],
		);
	});

	it("carries coordinates and bounded integers only — never an observed byte", () => {
		const capture = new RecordingCapture();
		const leaky = passedVerdicts().map((verdict) => ({
			...verdict,
			// A shape a future implementation might grow; testimony must ignore it.
			observed: { left: PAYLOAD_LINE, right: PRIOR_LINE },
		}));
		emitServiceResultTestimony({ capture, identity: IDENTITY, runId: RUN_ID, output: batteryResult(leaky) });

		const serialized = JSON.stringify(capture.events);
		for (const secret of [PAYLOAD_LINE, PRIOR_LINE, "blk-c1", "b".repeat(64)]) {
			assert.equal(serialized.includes(secret), false, `service testimony leaked ${secret}`);
		}
		for (const event of verdictEvents(capture)) {
			for (const key of Object.keys(event.payload)) {
				assert.ok(PAYLOAD_KEYS.includes(key), `unauthorized verdict payload field ${key}`);
			}
		}
	});

	it("is a no-op for foreign output and for a result missing its coordinates", () => {
		for (const output of [
			batteryResult(passedVerdicts(), { schema: "sophia.hoja.swarm-result.v1" }),
			batteryResult(passedVerdicts(), { scenarioId: "not a scenario id" }),
			batteryResult(passedVerdicts(), { verdicts: undefined }),
			undefined,
		]) {
			const capture = new RecordingCapture();
			emitServiceResultTestimony({ capture, identity: IDENTITY, runId: RUN_ID, output });
			assert.deepEqual(capture.events, []);
		}

		// Absent testimony is not an error: the campaign may run before capture is on.
		assert.doesNotThrow(() =>
			emitServiceResultTestimony({ identity: IDENTITY, runId: RUN_ID, output: batteryResult(passedVerdicts()) }),
		);
	});

	it("keeps every emitted verdict inside the ratified CaptureEvent contract", async () => {
		assert.equal(
			OBSERVATORY_CONTRACT_BUNDLE_SHA256,
			"c60d81fe4b431c3a88bd2450189a16da97627cc6ba36c4b127942d593a6c2bbb",
		);
		const sink = new PassThrough();
		let output = "";
		sink.setEncoding("utf8");
		sink.on("data", (chunk: string) => {
			output += chunk;
		});
		const writer = new CaptureWriter({ sink, hostId: "host-a", heartbeatMs: 0 });
		emitServiceResultTestimony({
			capture: writer,
			identity: IDENTITY,
			runId: RUN_ID,
			output: batteryResult(passedVerdicts()),
		});
		assert.equal(await writer.close(), true);

		// A verdict_code outside the identifier domain would be dropped here rather
		// than serialized; that silence is the regression this test exists to catch.
		assert.deepEqual(writer.counters, { emittedTotal: 4, droppedTotal: 0, nextSeq: 4n });
		const lines = output.trimEnd().split("\n");
		assert.equal(lines.length, 4);
		for (const line of lines) {
			const event = JSON.parse(line) as { kind: string; graph_id: string; payload: Record<string, unknown> };
			assert.equal(event.kind, "test.verdict");
			assert.equal(event.graph_id, GRAPH_ID);
			assert.match(String(event.payload.verdict_code), VERDICT_CODE);
			assert.ok(RATIFIED_INVARIANTS.includes(String(event.payload.invariant)));
			for (const key of Object.keys(event.payload)) {
				assert.ok(WIRE_VERDICT_FIELDS.includes(key), `unauthorized test.verdict wire field ${key}`);
			}
		}
		assert.deepEqual(
			lines.map((line) => (JSON.parse(line) as { payload: { verdict_code: string } }).payload.verdict_code),
			["echo_pass", "durability_pass", "identity_pass", "projection_pass"],
		);
	});

	it("never lets a verdict code outside the identifier domain reach the wire", async () => {
		const sink = new PassThrough();
		let output = "";
		sink.setEncoding("utf8");
		sink.on("data", (chunk: string) => {
			output += chunk;
		});
		const writer = new CaptureWriter({ sink, hostId: "host-a", heartbeatMs: 0 });
		emitServiceResultTestimony({
			capture: writer,
			identity: IDENTITY,
			runId: RUN_ID,
			output: batteryResult([
				{ invariant: "I1", code: "echo", result: "pass", verdictCode: "Durability Pass" },
				{ invariant: "S1", code: "durability", result: "pass", verdictCode: "durability_pass" },
			]),
		});
		assert.equal(await writer.close(), true);
		assert.equal(output, "", "S1 has no slot in the ratified enum and a spaced code is not an identifier");
		// An empty wire alone does not fence WHERE the rejection happened: CaptureWriter.admit
		// discards anything that fails serialization, so a projector that emitted both of these
		// and let the writer drop them would also leave output === "". Assert nothing was ever
		// offered, which is only true if the projector itself refused.
		assert.equal(
			writer.counters.droppedTotal,
			0,
			"the projector must refuse at the source, not lean on the writer to discard",
		);
		assert.equal(writer.counters.emittedTotal, 0, "and it must not have offered these to the wire at all");
	});

	it("reuses the shared logical run id resolution for service scenarios", () => {
		assert.equal(hojaLogicalRunId({ scenario: { runId: RUN_ID } }, "wfr-fallback"), RUN_ID);
		assert.equal(hojaLogicalRunId({ scenario: {} }, "wfr-fallback"), "wfr-fallback");
	});
});
