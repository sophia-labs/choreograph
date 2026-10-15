import { CaptureWriter, type ChoreographCaptureEvent } from "../../observatory-capture.js";

const ids = [
	"01J00000000000000000000002",
	"01J0000000000000000000000P",
	"01J0000000000000000000000Q",
	"01J0000000000000000000000R",
	"01J00000000000000000000012",
	"01J00000000000000000000013",
	"01J00000000000000000000014",
	"01J00000000000000000000015",
	"01J00000000000000000000016",
	"01J00000000000000000000017",
	"01J00000000000000000000018",
	"01J00000000000000000000019",
];
const times = [
	1783890000002, 1783890000022, 1783890000023, 1783890000024, 1783890000027, 1783890000028, 1783890000029,
	1783890000030, 1783890000031, 1783890000032, 1783890000033, 1783890000034,
];
const identity = {
	principal: "service:choreograph",
	onBehalfOf: "user-alpha-0001",
	graphId: "organism-dev",
} as const;
const events: ChoreographCaptureEvent[] = [
	{
		kind: "llm.call",
		...identity,
		viaService: "choreograph",
		authMethod: "service_token",
		outcome: "ok",
		durationMs: 240,
		payload: {
			model: "openrouter/deepseek-v4-pro",
			inputTokens: 20,
			outputTokens: 10,
			totalTokens: 30,
			costMicroUsd: 42,
		},
	},
	{
		kind: "sandbox.spawn",
		...identity,
		outcome: "ok",
		durationMs: 83,
		payload: { template: "agent", sandboxId: "sbx-alpha-0001" },
	},
	{
		kind: "agent.turn",
		...identity,
		outcome: "ok",
		durationMs: 920,
		payload: { template: "agent", sandboxId: "sbx-alpha-0001", stepIndex: 0, toolCount: 2 },
	},
	{
		kind: "sandbox.reap",
		...identity,
		outcome: "ok",
		durationMs: 1100,
		payload: {
			template: "agent",
			sandboxId: "sbx-alpha-0001",
			reason: "completed",
			exitCode: 0,
			memoryPeakBytes: 67_108_864,
			cpuUsageUs: 810_000,
		},
	},
	{
		kind: "chat.turn",
		...identity,
		viaService: "choreograph",
		authMethod: "service_token",
		outcome: "ok",
		durationMs: 930,
		payload: { messageBytes: 128, turnIndex: 1, model: "openrouter/deepseek-v4-pro" },
	},
	{
		kind: "capability.call",
		...identity,
		outcome: "ok",
		durationMs: 27,
		payload: {
			runId: "run-1",
			sandboxId: "sbx-alpha-0001",
			callId: "gate-1",
			capability: "browser.camoufox",
			tool: "capture_beat",
		},
	},
	{
		kind: "test.beat",
		...identity,
		outcome: "ok",
		durationMs: 930,
		payload: {
			runId: "run-1",
			scenarioId: "scenario-1",
			beatId: "beat-1",
			engine: "camoufox",
			operation: "edit-block",
			actionCount: 2,
			evidenceUri: `s3://sophia-observatory-evidence/run-1/scenario-1/beat-1/camoufox/manifest-${"a".repeat(64)}.json`,
			evidenceSha256: "a".repeat(64),
		},
	},
	{
		kind: "test.verdict",
		...identity,
		outcome: "error",
		payload: {
			runId: "run-1",
			scenarioId: "scenario-1",
			invariant: "I5",
			passed: false,
			verdictCode: "projection_timeout",
			beatId: "beat-1",
			engine: "camoufox",
			evidenceUri: `s3://sophia-observatory-evidence/run-1/scenario-1/beat-1/camoufox/manifest-${"a".repeat(64)}.json`,
			evidenceSha256: "a".repeat(64),
			observedMs: 930,
			maximumMs: 500,
		},
	},
	...(
		[
			["site.mint", 121, "ok"],
			["site.route", 121, "ok"],
			["site.publish", 18, "ok"],
			["site.retire", 9, "error"],
		] as const
	).map(([kind, durationMs, outcome]) => ({
		kind,
		...identity,
		viaService: "choreograph" as const,
		authMethod: "service_token" as const,
		outcome,
		durationMs,
		payload: {
			effectKey: `effect:${"a".repeat(64)}`,
			sourceTurnDigest: "b".repeat(64),
			proposalDigest: "c".repeat(64),
			executionDigest: "d".repeat(64),
			grantDigest: "e".repeat(64),
			publicName: "site-shrub1-demo",
			interpreterDigest: "f".repeat(64),
			...(kind === "site.retire" ? { reasonCode: "retirement-delayed" } : {}),
		},
	})),
];

let idIndex = 0;
let timeIndex = 0;
const writer = new CaptureWriter({
	hostId: "host-a",
	instanceId: "01J0000000000000000000000B",
	heartbeatMs: 0,
	clock: () => times[timeIndex++],
	idFactory: () => ids[idIndex++],
});
for (const event of events) writer.emit(event);
if (!(await writer.close(2_000))) {
	console.error("CaptureWriter did not drain before timeout");
	process.exitCode = 1;
}
