import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { GraphWriter } from "../workflow/graph-writer.js";
import { assertRunSparql, buildRunDelete, emitRunProvenance, serializeRunProvenance } from "../workflow/provenance.js";
import type { AgentNodeResult, RunRecord } from "../workflow/types.js";
import { mintAgentRunUri, mintRunUri, slug } from "../workflow/vocab.js";

function agent(label: string, phaseIndex: number, over: Partial<AgentNodeResult> = {}): AgentNodeResult {
	return {
		label,
		phaseIndex,
		state: "done",
		output: "",
		model: "mistralai/mistral-nemo",
		turns: 2,
		toolCalls: 1,
		tokens: 1234,
		queuedAt: 1_781_773_331_000,
		startedAt: 1_781_773_331_450,
		durationMs: 9820,
		agentType: "graph-surveyor",
		...over,
	};
}

function fixtureRun(over: Partial<RunRecord> = {}): RunRecord {
	return {
		runId: "20260614-aa31",
		workflowName: "graph-survey-synthesize",
		workflowUri: "urn:sophia:wf:graph-survey-synthesize",
		status: "completed",
		startedAt: 1_781_773_331_000,
		endedAt: 1_781_773_372_230,
		durationMs: 41230,
		agentCount: 3,
		totalTokens: 18422,
		agents: [
			agent("map:doc-3", 1),
			agent("map:doc/7 X", 1),
			agent("synthesize", 2, { agentType: "findings-synthesizer" }),
		],
		...over,
	};
}

describe("workflow provenance — slug + URI minting", () => {
	it("slugs labels: non-alnum runs collapse to '-', case preserved", () => {
		assert.equal(slug("map:doc-3"), "map-doc-3");
		assert.equal(slug("map:doc/7 X"), "map-doc-7-X");
		assert.equal(slug("--Survey//Graph--"), "Survey-Graph");
		assert.equal(slug("synthesize"), "synthesize");
	});

	it("mints urn run + agentRun subjects", () => {
		assert.equal(mintRunUri("r1"), "urn:sophia:wf-run:r1");
		assert.equal(mintAgentRunUri("r1", "map:doc-3"), "urn:sophia:wf-run:r1:agent:map-doc-3");
	});
});

describe("workflow provenance — serialization", () => {
	const sparql = serializeRunProvenance(fixtureRun());

	it("is an INSERT DATA block with the wf/prov/xsd prefixes", () => {
		assert.match(sparql, /PREFIX wf: <http:\/\/mnemosyne\.dev\/workflow#>/);
		assert.match(sparql, /PREFIX prov: <http:\/\/www\.w3\.org\/ns\/prov#>/);
		assert.match(sparql, /INSERT DATA \{/);
	});

	it("types the run as wf:Run AND prov:Activity with all required predicates", () => {
		assert.match(sparql, /<urn:sophia:wf-run:20260614-aa31> a wf:Run, prov:Activity/);
		for (const p of [
			"wf:runId",
			"wf:workflowName",
			"wf:status",
			"wf:totalTokens",
			"wf:agentCount",
			"wf:durationMs",
			"prov:used",
			"prov:startedAtTime",
			"prov:endedAtTime",
		]) {
			assert.ok(sparql.includes(`${p} `), `run missing ${p}`);
		}
	});

	it("emits one wf:AgentRun per agent with wf:partOfRun (NEVER wf:run)", () => {
		assert.match(sparql, /<urn:sophia:wf-run:20260614-aa31:agent:map-doc-3> a wf:AgentRun/);
		assert.match(sparql, /<urn:sophia:wf-run:20260614-aa31:agent:map-doc-7-X> a wf:AgentRun/);
		assert.match(sparql, /<urn:sophia:wf-run:20260614-aa31:agent:synthesize> a wf:AgentRun/);
		assert.ok(sparql.includes("wf:partOfRun "), "must use wf:partOfRun");
		assert.ok(!/\bwf:run\b/.test(sparql), "must NOT contain the v0.1 drift predicate wf:run");
	});

	it("uses the contract datatypes (xsd:long for queued/started, integer/boolean/dateTime elsewhere)", () => {
		assert.match(sparql, /wf:queuedAt "1781773331000"\^\^xsd:long/);
		assert.match(sparql, /wf:startedAt "1781773331450"\^\^xsd:long/);
		assert.match(sparql, /wf:tokens "1234"\^\^xsd:integer/);
		assert.match(sparql, /wf:cached "false"\^\^xsd:boolean/);
		assert.match(sparql, /prov:startedAtTime ".*Z"\^\^xsd:dateTime/);
	});

	it("links prov:used to the workflow subject", () => {
		assert.match(sparql, /prov:used <urn:sophia:wf:graph-survey-synthesize>/);
	});

	it("passes its own structural self-check", () => {
		const { ok, failures } = assertRunSparql(sparql);
		assert.ok(ok, `assertion failed: ${failures.join("; ")}`);
	});
});

describe("workflow provenance — assertion catches drift", () => {
	it("flags a forbidden wf:run predicate", () => {
		const tampered = serializeRunProvenance(fixtureRun()).replace("wf:partOfRun", "wf:run");
		const { ok, failures } = assertRunSparql(tampered);
		assert.equal(ok, false);
		assert.ok(failures.some((f) => f.includes("wf:run")));
	});

	it("flags a missing required predicate", () => {
		const stripped = serializeRunProvenance(fixtureRun()).replace(/wf:totalTokens [^;]+;/, "");
		const { ok, failures } = assertRunSparql(stripped);
		assert.equal(ok, false);
		assert.ok(failures.some((f) => f.includes("wf:totalTokens")));
	});
});

describe("workflow provenance — idempotency delete", () => {
	it("builds a DELETE WHERE per subject (run + each agent)", () => {
		const del = buildRunDelete(fixtureRun());
		const clauses = del.split("\n;\n");
		assert.equal(clauses.length, 4); // run + 3 agents
		assert.ok(clauses[0].includes("DELETE WHERE { <urn:sophia:wf-run:20260614-aa31> ?p ?o }"));
		assert.ok(clauses.every((c) => c.includes("DELETE WHERE")));
	});

	it("strictly deletes every projected subject before inserting the final fold", async () => {
		const updates: string[] = [];
		const graph = {
			async sparqlUpdate(_graphId: string, update: string) {
				updates.push(update);
			},
		} as GraphWriter;

		const assertion = await emitRunProvenance(graph, "g1", fixtureRun());
		assert.equal(assertion.ok, true);
		assert.equal(updates.length, 5);
		assert.ok(updates.slice(0, -1).every((update) => update.includes("DELETE WHERE")));
		assert.ok(updates.at(-1)?.includes("INSERT DATA"));
	});

	it("does not compound stale values when any required delete fails", async () => {
		const updates: string[] = [];
		const graph = {
			async sparqlUpdate(_graphId: string, update: string) {
				updates.push(update);
				if (updates.length === 2) {
					throw new Error("delete rejected");
				}
			},
		} as GraphWriter;

		await assert.rejects(() => emitRunProvenance(graph, "g1", fixtureRun()), /delete rejected/);
		assert.ok(updates.every((update) => !update.includes("INSERT DATA")));
	});
});
