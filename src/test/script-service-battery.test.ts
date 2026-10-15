import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileWorkflow } from "../workflow/harness.js";
import { SERVICE_BATTERY_SCRIPT } from "../workflow/script-service-battery.js";
import {
	buildServiceScenario,
	type NormalizedServiceScenario,
	normalizeServiceScenario,
	SERVICE_RECORD_GRAPH_DEFAULT,
} from "../workflow/service-battery.js";

/**
 * The decisiveness edges of the replay fold.
 *
 * `service-battery.test.ts` owns the scenario fence and the ordinary replay
 * paths. This file covers only the three places where the flow has to decide
 * whether an observation is decisive AT ALL — the cases where the difference
 * between a verdict and silence is the whole point of the campaign.
 */

const graphId = "obs-svc-canary";
const payloadDocumentId = "svc-durability-payload";

const compiled = compileWorkflow(SERVICE_BATTERY_SCRIPT);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
	...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

interface BatteryResult {
	readonly status: string;
	readonly verdicts: ReadonlyArray<{ code: string; result: string; verdictCode: string }>;
	readonly inconclusive: ReadonlyArray<{ code?: string; beat?: string; reason: string }>;
	readonly nextExpected?: { blockIds: readonly string[] };
}

function httpFace(status: number, body: string) {
	return {
		url: `https://api.garden.example.invalid/documents/${graphId}/${payloadDocumentId}/export?format=markdown`,
		status,
		ok: status >= 200 && status < 300,
		contentType: "text/markdown; charset=utf-8",
		headers: {},
		body,
		bodyEncoding: "utf8",
		bodyBytes: Buffer.byteLength(body, "utf8"),
		bodySha256: "b".repeat(64),
	};
}

const mcpResult = (value: Record<string, unknown>) => ({
	content: [{ type: "text", text: JSON.stringify(value) }],
	structuredContent: value,
});

const seedRun = () =>
	buildServiceScenario({
		runId: "svc-run-20",
		scenarioId: "svc-scenario-20",
		sutGraph: graphId,
		payloadDocumentId,
		nonce: "4c8ea19f",
		now: 1_900_000_000_000,
	});

/** Replay the compiled body with a face reader supplied per run. */
async function replay(built: NormalizedServiceScenario, face: (body: string) => unknown): Promise<BatteryResult> {
	const execute = new AsyncFunction("args", "invoke", "phase", "journey", compiled.bodySource);
	const journey = async (
		items: readonly unknown[],
		handler: (item: unknown, control: { directives: string[] }) => Promise<unknown>,
	) => {
		const results: unknown[] = [];
		for (const item of items) results.push(await handler(item, { directives: [] }));
		return results;
	};
	const invoke = async (invocation: { capability: string; tool: string }) => {
		if (invocation.capability === "http") return face(built.scenario.payload.content);
		switch (invocation.tool) {
			case "read_document":
				return mcpResult({ block_ids: ["blk-1", "blk-2"] });
			case "sparql_query":
				return mcpResult({ resultType: "bindings", rows: [{ s: "urn:doc" }] });
			default:
				return mcpResult({ success: true, block_ids: ["blk-1", "blk-2"] });
		}
	};
	return (await execute(
		{
			scenario: built.scenario,
			canonicalJson: built.canonicalJson,
			digest: built.digest,
			sutGraph: graphId,
			recordGraph: SERVICE_RECORD_GRAPH_DEFAULT,
		},
		invoke,
		() => {},
		journey,
	)) as BatteryResult;
}

const byCode = (output: BatteryResult, code: string) => output.verdicts.find((verdict) => verdict.code === code);

describe("Garden service battery decisiveness edges", () => {
	it("withholds the next expectation when this run's own echo did not pass", async () => {
		const output = await replay(seedRun(), () => httpFace(200, "an entirely different document\n"));

		assert.equal(byCode(output, "echo")?.verdictCode, "echo_fail");
		assert.equal(output.status, "failed");
		// Run k+1's durability question is only answerable because run k proved its
		// own write landed. A failed echo must not seal an expectation.
		assert.equal(output.nextExpected, undefined);
	});

	it("treats a 404 on this run's own write as undecided, not as a lost document", async () => {
		const output = await replay(seedRun(), () => httpFace(404, "document not found"));

		// The 404-is-decisive rule belongs to the CROSS-INCARNATION leg only. On this
		// run's own payload a 404 may simply mean the write is still in flight, and
		// the flow may not convert that ambiguity into a defect report.
		assert.equal(byCode(output, "echo"), undefined);
		assert.deepEqual(
			output.inconclusive.filter((entry) => entry.code === "echo"),
			[{ invariant: "I1", code: "echo", reason: "unexpected_status", beat: "echo-face" }],
		);
		assert.equal(output.status, "inconclusive");
		assert.equal(output.nextExpected, undefined);
	});

	it("stays silent when a reference resolves to nothing rather than comparing against absence", async () => {
		const seed = seedRun();
		const drafted = structuredClone(seed.scenario) as unknown as {
			invariants: Array<{ code: string; right?: { beat: string; path: string } }>;
		};
		for (const invariant of drafted.invariants) {
			if (invariant.code === "echo" && invariant.right) invariant.right.path = "value.absentField";
		}
		const output = await replay(normalizeServiceScenario(drafted), (content) => httpFace(200, `${content}\n`));

		// An unresolvable path is a harness defect, not a face defect. Comparing a
		// payload against `undefined` would manufacture a failure out of our own bug.
		assert.equal(byCode(output, "echo"), undefined);
		assert.deepEqual(
			output.inconclusive.filter((entry) => entry.code === "echo").map((entry) => entry.reason),
			["unresolved"],
		);
		assert.equal(output.status, "inconclusive");
	});
});
