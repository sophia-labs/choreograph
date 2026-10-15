import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CaptureEmitter, ChoreographCaptureEvent } from "../observatory-capture.js";
import { emitHojaResultTestimony, hojaLogicalRunId, indexHojaResultEvidence } from "../workflow/hoja-testimony.js";

class RecordingCapture implements CaptureEmitter {
	readonly events: ChoreographCaptureEvent[] = [];
	emit(event: ChoreographCaptureEvent): void {
		this.events.push(event);
	}
}

const ref = (sha: string) => ({
	uri: `s3://sophia-observatory-evidence/run-1/scenario-1/beat-1/cross-engine/artifact-${sha}.png`,
	sha256: sha,
	bytes: 42,
	mediaType: "image/png",
});

describe("Hoja Observatory projection", () => {
	it("uses the durable scenario run id for capability and test correlation", () => {
		assert.equal(hojaLogicalRunId({ scenario: { runId: "campaign-run-1" } }, "wfr-fallback"), "campaign-run-1");
		assert.equal(hojaLogicalRunId({ scenario: { runId: "contains spaces" } }, "wfr-fallback"), "wfr-fallback");
	});

	it("emits only bounded coordinates and thin S3 refs for beats and I1-I5/L1/L2 verdicts", () => {
		const capture = new RecordingCapture();
		const chromiumManifest = ref("a".repeat(64));
		const camoufoxManifest = ref("b".repeat(64));
		const diff = ref("c".repeat(64));
		emitHojaResultTestimony({
			capture,
			identity: { principal: "service:choreograph", graphId: "obs-hoja-local" },
			runId: "run-1",
			output: {
				schema: "sophia.hoja.swarm-result.v1",
				scenarioId: "scenario-1",
				beats: [
					{
						id: "beat-1",
						operation: "edit-block",
						durationMs: 300,
						actions: [{ value: "private graph content" }, { value: "more private content" }],
						evidence: [
							{ engine: "chromium", manifest: chromiumManifest, evidence: { screenshot: "private" } },
							{ engine: "camoufox", manifest: camoufoxManifest, evidence: { screenshot: "private" } },
						],
					},
				],
				verdicts: [{ invariant: "I5", passed: false, observed: { durationMs: 650, maxMs: 500, text: "private" } }],
				evaluations: [
					{
						beatId: "beat-1",
						diff: { diff },
						evaluation: {
							result: { verdict: "anomaly", claims: [{ summary: "private visual description" }] },
						},
						evidence: [chromiumManifest, camoufoxManifest],
					},
				],
				reflections: [
					{ result: { hypotheses: [{ summary: "private primary reasoning" }] } },
					{ result: { hypotheses: [{ summary: "private foreign reasoning" }] } },
				],
			},
		});

		assert.equal(capture.events.filter((event) => event.kind === "test.beat").length, 2);
		assert.deepEqual(
			capture.events.filter((event) => event.kind === "test.verdict").map((event) => event.payload.invariant),
			["I5", "L1", "L2-primary", "L2-foreign"],
		);
		const mechanical = capture.events.find(
			(event) => event.kind === "test.verdict" && event.payload.invariant === "I5",
		);
		assert.ok(mechanical?.kind === "test.verdict");
		assert.equal(mechanical.payload.observedMs, 650);
		assert.equal(mechanical.payload.maximumMs, 500);
		const serialized = JSON.stringify(capture.events);
		for (const forbidden of [
			"private graph content",
			"private visual description",
			"private primary reasoning",
			"private foreign reasoning",
		]) {
			assert.equal(serialized.includes(forbidden), false);
		}
	});

	it("never places local file refs into shared Observatory testimony", () => {
		const capture = new RecordingCapture();
		emitHojaResultTestimony({
			capture,
			identity: { principal: "service:choreograph", graphId: "obs-hoja-local" },
			runId: "run-1",
			output: {
				schema: "sophia.hoja.swarm-result.v1",
				scenarioId: "scenario-1",
				beats: [
					{
						id: "beat-1",
						operation: "create",
						actions: [{}],
						evidence: [
							{
								engine: "chromium",
								manifest: { uri: "file:///tmp/private.json", sha256: "a".repeat(64) },
							},
						],
					},
				],
				verdicts: [],
				evaluations: [],
				reflections: [],
			},
		});
		assert.equal(
			capture.events.some((event) => event.kind === "test.beat"),
			false,
		);
	});

	it("indexes only host-produced capture and visual-diff refs for private resolution", () => {
		const screenshot = ref("d".repeat(64));
		const manifest = ref("e".repeat(64));
		const diff = ref("f".repeat(64));
		const arbitrary = ref("9".repeat(64));
		const index = indexHojaResultEvidence({
			schema: "sophia.hoja.swarm-result.v1",
			beats: [
				{
					evidence: [{ manifest, evidence: { screenshot } }],
					diff: { diff },
					actions: [{ value: { modelSuppliedRef: arbitrary } }],
				},
			],
		});
		assert.deepEqual(
			index.map((entry) => entry.sha256).sort(),
			[screenshot.sha256, manifest.sha256, diff.sha256].sort(),
		);
	});
});
