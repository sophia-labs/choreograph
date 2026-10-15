import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildIngestRequest,
	emporiumIngestUrl,
	type IngestRequest,
	postEmporiumIngest,
	resolveEmporiumIngestBaseUrl,
} from "../workflow/emporium-ingest.js";
import type { RunRecord } from "../workflow/types.js";

/**
 * A representative finished run: 1 map + 1 synth, distinct time fields so the
 * startedAt→startTimeMs / endedAt→endTimeMs renames are observable (and the
 * silent-drop trap is caught — a naive JSON.stringify would lose the times).
 */
function representativeRun(): RunRecord {
	return {
		runId: "wfr-abc123",
		workflowName: "graph-survey-synthesize",
		workflowUri: "urn:sophia:wf:graph-survey-synthesize",
		status: "completed",
		startedAt: 1_700_000_000_000,
		endedAt: 1_700_000_005_000,
		durationMs: 5000,
		agentCount: 2,
		totalTokens: 350,
		agents: [
			{
				label: "map:d1",
				phaseIndex: 1,
				state: "done",
				output: "m",
				model: "mistralai/mistral-nemo",
				turns: 2,
				toolCalls: 1,
				tokens: 100,
				queuedAt: 1_700_000_000_100,
				startedAt: 1_700_000_000_200,
				durationMs: 900,
				agentType: "graph-surveyor",
			},
			{
				label: "synthesize",
				phaseIndex: 2,
				state: "done",
				output: "s",
				model: "google/gemini-2.5-flash",
				turns: 1,
				toolCalls: 0,
				tokens: 250,
				queuedAt: 1_700_000_001_000,
				startedAt: 1_700_000_001_100,
				durationMs: 3800,
				agentType: "findings-synthesizer",
			},
		],
		synthesisDocId: "wf-synthesis-wfr-abc123",
	};
}

const SCRIPT_SHA = "deadbeefcafef00d";

describe("buildIngestRequest", () => {
	it("round-trips a RunRecord to the EXACT IngestRequest shape (golden / schemas.rs)", () => {
		const run = representativeRun();
		const req = buildIngestRequest(run, SCRIPT_SHA);

		// The full golden — asserts the entire structure in one shot, including the
		// camelCase renames, the two kind discriminators, cached:false, empty
		// anatomy, dry_run:false, and populated startTimeMs/endTimeMs.
		const expected: IngestRequest = {
			vocab: "workflow",
			dry_run: false,
			payload: {
				kind: "workflow",
				parsed: {
					kind: "run-record",
					name: "graph-survey-synthesize",
					scriptSha256: SCRIPT_SHA,
					script: "",
					phases: [],
					nodes: [],
					edges: [],
					run: {
						runId: "wfr-abc123",
						status: "completed",
						startTimeMs: 1_700_000_000_000,
						endTimeMs: 1_700_000_005_000,
						totalTokens: 350,
						agentCount: 2,
						durationMs: 5000,
						agents: [
							{
								label: "map:d1",
								phaseIndex: 1,
								model: "mistralai/mistral-nemo",
								state: "done",
								tokens: 100,
								toolCalls: 1,
								durationMs: 900,
								queuedAt: 1_700_000_000_100,
								startedAt: 1_700_000_000_200,
								cached: false,
								agentType: "graph-surveyor",
							},
							{
								label: "synthesize",
								phaseIndex: 2,
								model: "google/gemini-2.5-flash",
								state: "done",
								tokens: 250,
								toolCalls: 0,
								durationMs: 3800,
								queuedAt: 1_700_000_001_000,
								startedAt: 1_700_000_001_100,
								cached: false,
								agentType: "findings-synthesizer",
							},
						],
					},
				},
			},
		};
		assert.deepEqual(req, expected);
	});

	it("stamps the two kind discriminators", () => {
		const req = buildIngestRequest(representativeRun(), SCRIPT_SHA);
		assert.equal(req.payload.kind, "workflow");
		assert.equal(req.payload.parsed.kind, "run-record");
	});

	it("renames startedAt→startTimeMs and endedAt→endTimeMs (the silent-drop trap)", () => {
		const run = representativeRun();
		const req = buildIngestRequest(run, SCRIPT_SHA);
		const runIn = req.payload.parsed.run;
		// Populated from RunRecord.startedAt / endedAt under the NEW names.
		assert.equal(runIn.startTimeMs, run.startedAt);
		assert.equal(runIn.endTimeMs, run.endedAt);
		assert.ok(runIn.startTimeMs > 0, "startTimeMs must be populated, not dropped");
		assert.ok(runIn.endTimeMs > 0, "endTimeMs must be populated, not dropped");
		// The legacy names must NOT appear on the wire object (serde would drop them).
		const serialized = JSON.parse(JSON.stringify(req)) as Record<string, unknown>;
		const runJson = (serialized as any).payload.parsed.run;
		assert.equal("startedAt" in runJson, false, "RunIn must not carry startedAt");
		assert.equal("endedAt" in runJson, false, "RunIn must not carry endedAt");
		assert.equal(runJson.startTimeMs, run.startedAt);
		assert.equal(runJson.endTimeMs, run.endedAt);
	});

	it("hardcodes cached:false on every agent", () => {
		const req = buildIngestRequest(representativeRun(), SCRIPT_SHA);
		for (const agent of req.payload.parsed.run.agents) {
			assert.equal(agent.cached, false);
		}
	});

	it("emits empty phases/nodes/edges and an empty script (runs-only client)", () => {
		const parsed = buildIngestRequest(representativeRun(), SCRIPT_SHA).payload.parsed;
		assert.deepEqual(parsed.phases, []);
		assert.deepEqual(parsed.nodes, []);
		assert.deepEqual(parsed.edges, []);
		assert.equal(parsed.script, "");
		assert.equal(parsed.scriptSha256, SCRIPT_SHA);
	});

	it("carries dry_run:false and vocab:'workflow'", () => {
		const req = buildIngestRequest(representativeRun(), SCRIPT_SHA);
		assert.equal(req.dry_run, false);
		assert.equal(req.vocab, "workflow");
	});

	it("omits agentType when the agent has none (serde default Option<String>)", () => {
		const run = representativeRun();
		delete run.agents[0].agentType;
		const agent = buildIngestRequest(run, SCRIPT_SHA).payload.parsed.run.agents[0];
		assert.equal("agentType" in agent, false);
	});

	it("matches the schemas.rs golden field names on serialize (no snake_case leak)", () => {
		const json = JSON.parse(JSON.stringify(buildIngestRequest(representativeRun(), SCRIPT_SHA)));
		// Top-level: vocab, dry_run (snake — IngestRequest is NOT camelCase in Rust), payload.
		assert.deepEqual(Object.keys(json).sort(), ["dry_run", "payload", "vocab"]);
		// parsed is camelCase: scriptSha256, not script_sha256.
		assert.ok("scriptSha256" in json.payload.parsed);
		assert.equal("script_sha256" in json.payload.parsed, false);
		// RunIn camelCase: startTimeMs/endTimeMs/totalTokens/agentCount/durationMs/runId.
		const runKeys = Object.keys(json.payload.parsed.run).sort();
		assert.deepEqual(runKeys, [
			"agentCount",
			"agents",
			"durationMs",
			"endTimeMs",
			"runId",
			"startTimeMs",
			"status",
			"totalTokens",
		]);
		// AgentTelemetryIn camelCase: phaseIndex/toolCalls/queuedAt/startedAt.
		const agentKeys = Object.keys(json.payload.parsed.run.agents[0]).sort();
		assert.deepEqual(agentKeys, [
			"agentType",
			"cached",
			"durationMs",
			"label",
			"model",
			"phaseIndex",
			"queuedAt",
			"startedAt",
			"state",
			"tokens",
			"toolCalls",
		]);
	});
});

describe("emporiumIngestUrl", () => {
	it("gateway mode binds an owner tuple and keeps the route graph param", () => {
		assert.equal(
			emporiumIngestUrl("https://api.canary.example.com", "emporium-p01", "gateway", "user:user-sub-1"),
			"https://api.canary.example.com/o/user%3Auser-sub-1/g/emporium-p01/emporium/ingest/emporium-p01",
		);
	});

	it("local mode puts graphId ONCE (direct route)", () => {
		assert.equal(
			emporiumIngestUrl("http://127.0.0.1:9090", "emporium-p01", "local"),
			"http://127.0.0.1:9090/emporium/ingest/emporium-p01",
		);
	});

	it("trims a trailing slash on the base", () => {
		assert.equal(
			emporiumIngestUrl("http://127.0.0.1:9090/", "g1", "local"),
			"http://127.0.0.1:9090/emporium/ingest/g1",
		);
	});
});

describe("resolveEmporiumIngestBaseUrl", () => {
	it("uses the hosted gateway automatically when service-auth is active", () => {
		assert.equal(
			resolveEmporiumIngestBaseUrl("https://api.garden.example.invalid", undefined),
			"https://api.garden.example.invalid",
		);
	});

	it("keeps the explicit local/custom route as the higher-precedence override", () => {
		assert.equal(
			resolveEmporiumIngestBaseUrl("https://api.garden.example.invalid", " http://127.0.0.1:9090 "),
			"http://127.0.0.1:9090",
		);
	});

	it("leaves legacy/direct mode disabled when neither route exists", () => {
		assert.equal(resolveEmporiumIngestBaseUrl("  ", ""), undefined);
	});
});

describe("postEmporiumIngest", () => {
	function fakeFetch(impl: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch {
		return (async (input: any, init: any) => impl(String(input), init ?? {})) as unknown as typeof fetch;
	}

	it("gateway mode sends service auth to the owner-scoped URL", async () => {
		let seenUrl = "";
		let seenHeaders: Record<string, string> = {};
		const fetchFn = fakeFetch((url, init) => {
			seenUrl = url;
			seenHeaders = init.headers as Record<string, string>;
			return new Response("{}", { status: 200 });
		});
		const body = buildIngestRequest(representativeRun(), SCRIPT_SHA);
		const res = await postEmporiumIngest(
			"https://api.canary.example.com",
			"emporium-p01",
			body,
			{ mode: "gateway", serviceToken: "svc-tok", onBehalfOf: "user-sub-1" },
			fetchFn,
		);
		assert.equal(res.ok, true);
		assert.equal(
			seenUrl,
			"https://api.canary.example.com/o/user%3Auser-sub-1/g/emporium-p01/emporium/ingest/emporium-p01",
		);
		assert.equal(seenHeaders.Authorization, "Bearer svc-tok");
		assert.equal(seenHeaders["x-pn-on-behalf-of"], "user-sub-1");
	});

	it("gateway mode preserves an explicit typed graph owner", async () => {
		let seenUrl = "";
		const fetchFn = fakeFetch((url) => {
			seenUrl = url;
			return new Response("{}", { status: 200 });
		});
		const res = await postEmporiumIngest(
			"https://api.canary.example.com",
			"platform-domain",
			buildIngestRequest(representativeRun(), SCRIPT_SHA),
			{
				mode: "gateway",
				serviceToken: "svc-tok",
				onBehalfOf: "user-sub-1",
				ownerPrincipal: "service:platform-steward",
			},
			fetchFn,
		);
		assert.equal(res.ok, true);
		assert.equal(
			seenUrl,
			"https://api.canary.example.com/o/service%3Aplatform-steward/g/platform-domain/emporium/ingest/platform-domain",
		);
	});

	it("local mode sends the loopback bearer to the once-graphId URL", async () => {
		let seenUrl = "";
		let seenHeaders: Record<string, string> = {};
		const fetchFn = fakeFetch((url, init) => {
			seenUrl = url;
			seenHeaders = init.headers as Record<string, string>;
			return new Response("ok", { status: 200 });
		});
		const res = await postEmporiumIngest(
			"http://127.0.0.1:9090",
			"g1",
			buildIngestRequest(representativeRun(), SCRIPT_SHA),
			{ mode: "local", bearer: "loop-tok" },
			fetchFn,
		);
		assert.equal(res.ok, true);
		assert.equal(seenUrl, "http://127.0.0.1:9090/emporium/ingest/g1");
		assert.equal(seenHeaders.Authorization, "Bearer loop-tok");
		assert.equal("x-pn-on-behalf-of" in seenHeaders, false);
	});

	it("is NON-FATAL on a non-2xx response (returns ok:false, never throws)", async () => {
		const fetchFn = fakeFetch(() => new Response("boom", { status: 503 }));
		const res = await postEmporiumIngest(
			"http://127.0.0.1:9090",
			"g1",
			buildIngestRequest(representativeRun(), SCRIPT_SHA),
			{ mode: "local" },
			fetchFn,
		);
		assert.equal(res.ok, false);
		assert.equal(res.status, 503);
		assert.match(res.error ?? "", /503/);
	});

	it("is NON-FATAL on a transport throw (returns ok:false, never throws)", async () => {
		const fetchFn = fakeFetch(() => {
			throw new Error("ECONNREFUSED");
		});
		const res = await postEmporiumIngest(
			"http://127.0.0.1:9090",
			"g1",
			buildIngestRequest(representativeRun(), SCRIPT_SHA),
			{ mode: "local" },
			fetchFn,
		);
		assert.equal(res.ok, false);
		assert.match(res.error ?? "", /ECONNREFUSED/);
	});

	it("POSTs a JSON body whose RunIn carries startTimeMs/endTimeMs (end-to-end serialize)", async () => {
		let sentBody = "";
		const fetchFn = fakeFetch((_url, init) => {
			sentBody = String(init.body);
			return new Response("{}", { status: 200 });
		});
		const run = representativeRun();
		await postEmporiumIngest(
			"http://127.0.0.1:9090",
			"g1",
			buildIngestRequest(run, SCRIPT_SHA),
			{ mode: "local" },
			fetchFn,
		);
		const parsed = JSON.parse(sentBody);
		assert.equal(parsed.payload.parsed.run.startTimeMs, run.startedAt);
		assert.equal(parsed.payload.parsed.run.endTimeMs, run.endedAt);
		assert.equal("startedAt" in parsed.payload.parsed.run, false);
	});
});
