import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	compileGraphPlan,
	GraphPlanError,
	graphPlanDigest,
	parseTerm,
	stepOutputSchema,
	triplesFromSparqlResult,
} from "../workflow/graph-plan.js";
import { serializeGraphPlanRun } from "../workflow/script-graph-plan.js";

// The definition as a live gardend answered `SELECT ?s ?p ?o WHERE { GRAPH <urn:sophia:wf:freud-ch1:v1> { … } }`
// on 2026-10-18; the run that day pinned this digest, and the browser pane computes the same one
// (shrubbery apps/organism/src/cell/__tests__/graph-plan.test.ts).
const FIXTURE = JSON.parse(
	readFileSync(new URL("./fixtures/graph-plan-freud-ch1.sparql.json", import.meta.url), "utf8"),
) as unknown;
const PINNED = "sha256:3d3efe3add6543d7d800941ee10559f4729e29b6d69c8416ce5c00d37dcc0b33";

describe("graph-plan-v1 compiler", () => {
	it("compiles the Freud definition into three phases, in order", () => {
		const plan = compileGraphPlan(triplesFromSparqlResult(FIXTURE));
		assert.equal(plan.name, "freud-ch1");
		assert.deepEqual(
			plan.phases.map((p) => [p.title, p.steps.map((s) => s.label)]),
			[
				["Day residue", ["the Reader"]],
				["Dream-work", ["the Experimenter's Clerk"]],
				["The Censor", ["the Censor"]],
			],
		);
		const censor = plan.phases[2].steps[0];
		assert.equal(censor.mode, "perItem");
		assert.equal(censor.checks, censor.over);
		assert.deepEqual(stepOutputSchema(censor).required, ["ok"]);
	});

	it("pins the digest the live run approved", () => {
		assert.equal(graphPlanDigest(compileGraphPlan(triplesFromSparqlResult(FIXTURE))), PINNED);
	});

	it("refuses a step that reads a collection no earlier phase produced", () => {
		const triples = triplesFromSparqlResult(FIXTURE).filter(
			(t) => !(t.s.endsWith("#reader") && t.p.endsWith("#produces")),
		);
		assert.throws(
			() => compileGraphPlan(triples),
			(error: unknown) =>
				error instanceof GraphPlanError &&
				error.problems.some((p) => p.includes("reads passages, which no step produces")),
		);
	});

	it("parses N-Triples terms as gardend prints them", () => {
		assert.deepEqual(parseTerm('"a \\"quoted\\" line\\n"'), { kind: "literal", value: 'a "quoted" line\n' });
		assert.deepEqual(parseTerm('"3"^^<http://www.w3.org/2001/XMLSchema#integer>'), {
			kind: "literal",
			value: "3",
			datatype: "http://www.w3.org/2001/XMLSchema#integer",
		});
	});

	it("writes a run's testimony into the run's own named graph", () => {
		const sparql = serializeGraphPlanRun({
			runId: "wfr-1",
			status: "completed",
			definition: "urn:sophia:wf:freud-ch1:v1",
			digest: PINNED,
			workflow: "urn:sophia:wf:freud-ch1",
			output: {
				collections: { "urn:sophia:wf:freud-ch1#verified": [{ who: "Maury", quote: 'He said "no".' }] },
				refused: [],
				steps: [],
			},
		});
		assert.match(sparql, /INSERT DATA \{ GRAPH <urn:sophia:wf:freud-ch1:run:wfr-1> \{/);
		assert.match(sparql, /wf:json "\{\\"who\\":\\"Maury\\",\\"quote\\":\\"He said \\\\\\"no\\\\\\"\.\\"\}"/);
	});
});
