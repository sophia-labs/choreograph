import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as oxigraph from "oxigraph";
import {
	compileGraphPlan,
	GraphPlanError,
	graphPlanDigest,
	parseTerm,
	stepOutputSchema,
	type Triple,
	triplesFromSparqlResult,
	WF,
} from "../workflow/graph-plan.js";
import {
	buildGraphPlanInputs,
	serializeGraphPlanRun,
	serializeGraphPlanRunTurtle,
} from "../workflow/script-graph-plan.js";

// The definition as a live gardend answered `SELECT ?s ?p ?o WHERE { GRAPH <urn:sophia:wf:freud-ch1:v1> { … } }`
// on 2026-10-18; the run that day pinned this digest, and the browser pane computes the same one
// (shrubbery apps/organism/src/cell/__tests__/graph-plan.test.ts).
const FIXTURE = JSON.parse(
	readFileSync(new URL("./fixtures/graph-plan-freud-ch1.sparql.json", import.meta.url), "utf8"),
) as unknown;
const PINNED = "sha256:3d3efe3add6543d7d800941ee10559f4729e29b6d69c8416ce5c00d37dcc0b33";
// The same definition with a source the Reader reads and a margin the verified entries go to (2026-10-19).
const PINNED_WITH_SOURCES = "sha256:e0f63e28e36771e32eb181a178e8b8b96021dd20b84cbce7c5440c38df83546a";

const RDF_TYPE_IRI = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

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

	it("writes the same testimony as Turtle about the run alone, for gardend's workflow_run_record", () => {
		const input = {
			runId: "wfr-1/a",
			status: "completed",
			definition: "urn:sophia:wf:freud-ch1:v1",
			digest: PINNED,
			workflow: "urn:sophia:wf:freud-ch1",
			output: {
				collections: {
					"urn:sophia:wf:freud-ch1#passages": [{ text: "one" }, { text: "two" }],
					"urn:sophia:wf:freud-ch1#verified": [{ who: "Maury", quote: 'He said "no".' }],
				},
				refused: [{ step: "urn:sophia:wf:freud-ch1#censor", item: { who: "x" }, verdict: { pass: false } }],
				steps: [{ step: "urn:sophia:wf:freud-ch1#censor", runs: 2, produced: 1, refused: 1 }],
			},
		};
		const store = new oxigraph.Store();
		const runGraph = oxigraph.namedNode("urn:sophia:wf:freud-ch1:run:wfr-1_a");
		store.load(serializeGraphPlanRunTurtle(input), { format: "text/turtle", to_graph_name: runGraph });
		const quads = store.match(null, null, null, runGraph);
		// gardend refuses any triple whose subject is not in the run's own namespace: every one here is.
		for (const q of quads) assert.match(q.subject.value, /^urn:sophia:wf:freud-ch1:run:wfr-1_a#/);
		const count = (type: string) =>
			store.match(null, oxigraph.namedNode(RDF_TYPE_IRI), oxigraph.namedNode(`${WF}${type}`), runGraph).length;
		assert.deepEqual(["GraphPlanRun", "Item", "Refusal", "StepRun"].map(count), [1, 3, 1, 1]);
		const json = store.match(null, oxigraph.namedNode(`${WF}json`), null, runGraph).map((q) => q.object.value);
		assert.ok(json.includes(JSON.stringify({ who: "Maury", quote: 'He said "no".' })));
		// The update form says the same triples.
		const viaUpdate = new oxigraph.Store();
		viaUpdate.update(serializeGraphPlanRun(input));
		assert.equal(viaUpdate.match(null, null, null, runGraph).length, quads.length);
	});

	describe("sources and destinations (2026-10-19)", () => {
		const W = "urn:sophia:wf:freud-ch1";
		const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
		const iri = (value: string) => ({ kind: "iri" as const, value });
		const text = (value: string) => ({ kind: "literal" as const, value });
		const base = () => triplesFromSparqlResult(FIXTURE);
		const book: Triple[] = [
			{ s: `${W}#book`, p: RDF_TYPE, o: iri(`${WF}Source`) },
			{ s: `${W}#book`, p: `${WF}label`, o: text("The Interpretation of Dreams, I.C") },
			{ s: `${W}#book`, p: `${WF}documentId`, o: text("freud-dreams-1") },
			{ s: `${W}#book`, p: `${WF}fromBlock`, o: text("block-be1fe535") },
			{ s: `${W}#book`, p: `${WF}toBlock`, o: text("block-0c1d2e3f") },
			{ s: `${W}#reader`, p: `${WF}reads`, o: iri(`${W}#book`) },
		];
		const margin: Triple[] = [
			{ s: `${W}#margin`, p: RDF_TYPE, o: iri(`${WF}Destination`) },
			{ s: `${W}#margin`, p: `${WF}label`, o: text("The book's margin") },
			{ s: `${W}#margin`, p: `${WF}kind`, o: text("margin") },
			{ s: `${W}#margin`, p: `${WF}receives`, o: iri(`${W}#verified`) },
			{ s: `${W}#margin`, p: `${WF}documentId`, o: text("freud-dreams-1") },
		];
		const problemsOf = (triples: readonly Triple[]): readonly string[] => {
			try {
				compileGraphPlan(triples);
				return [];
			} catch (error) {
				if (error instanceof GraphPlanError) return error.problems;
				throw error;
			}
		};

		it("a plan without them keeps its pinned digest", () => {
			const plan = compileGraphPlan(base());
			assert.equal("sources" in plan, false);
			assert.equal("destinations" in plan, false);
			assert.equal(
				plan.phases.flatMap((p) => p.steps).some((s) => "reads" in s),
				false,
			);
		});

		it("compiles what a workflow reads and where it publishes, and the digest covers them", () => {
			const plan = compileGraphPlan([...base(), ...book, ...margin]);
			assert.deepEqual(plan.sources, [
				{
					iri: `${W}#book`,
					id: "book",
					label: "The Interpretation of Dreams, I.C",
					documentId: "freud-dreams-1",
					fromBlock: "block-be1fe535",
					toBlock: "block-0c1d2e3f",
				},
			]);
			assert.deepEqual(plan.destinations, [
				{
					iri: `${W}#margin`,
					id: "margin",
					label: "The book's margin",
					kind: "margin",
					receives: `${W}#verified`,
					documentId: "freud-dreams-1",
				},
			]);
			assert.deepEqual(plan.phases[0].steps[0].reads, [`${W}#book`]);
			const digest = graphPlanDigest(plan);
			// The browser pane reaches the same digest (shrubbery apps/organism/src/cell/__tests__/graph-plan.test.ts).
			assert.equal(digest, PINNED_WITH_SOURCES);
			const elsewhere = [...base(), ...book, ...margin].map((t) =>
				t.p === `${WF}documentId` && t.s.endsWith("#margin") ? { ...t, o: text("another-doc") } : t,
			);
			assert.notEqual(graphPlanDigest(compileGraphPlan(elsewhere)), digest, "where it publishes is approved too");
		});

		it("refuses, in the words gardend uses, what is not a source or a destination", () => {
			const triples = [
				...base(),
				...book.filter((t) => t.p !== `${WF}documentId` && t.p !== `${WF}toBlock`),
				{ s: `${W}#book`, p: `${WF}toBlock`, o: text("block with spaces") },
				{ s: `${W}#clerk`, p: `${WF}reads`, o: iri(`${W}#passages`) },
				...margin.map((t) => (t.p === `${WF}kind` ? { ...t, o: text("email") } : t)),
				{ s: `${W}#late`, p: RDF_TYPE, o: iri(`${WF}Destination`) },
				{ s: `${W}#late`, p: `${WF}label`, o: text("Elsewhere") },
				{ s: `${W}#late`, p: `${WF}kind`, o: text("margin") },
				{ s: `${W}#late`, p: `${WF}receives`, o: iri(`${W}#nothing`) },
				{ s: `${W}#late`, p: `${WF}documentId`, o: text("not/an/id") },
			];
			const problems = problemsOf(triples);
			for (const expected of [
				"book has no wf:documentId",
				"book's wf:toBlock is not a block id",
				"clerk reads passages, which is not a source of this workflow (wf:Source)",
				'margin\'s wf:kind is "email"; use "margin"',
				"late receives nothing, which no step produces",
				"late's wf:documentId is not a document id",
			]) {
				assert.ok(problems.includes(expected), `${expected}\n  in: ${problems.join(" | ")}`);
			}
			const unnamed = problemsOf([
				...base(),
				...margin.filter((t) => t.p !== `${WF}receives` && t.p !== `${WF}kind`),
			]);
			assert.ok(unnamed.includes("margin has no wf:receives"), unnamed.join(" | "));
			assert.ok(unnamed.includes("margin has no wf:kind"), unnamed.join(" | "));
		});

		it("caps sources and destinations", () => {
			const many = Array.from({ length: 7 }, (_, i) => [
				{ s: `${W}#s${i}`, p: RDF_TYPE, o: iri(`${WF}Source`) },
				{ s: `${W}#s${i}`, p: `${WF}label`, o: text(`source ${i}`) },
				{ s: `${W}#s${i}`, p: `${WF}documentId`, o: text(`doc-${i}`) },
			]).flat();
			assert.ok(problemsOf([...base(), ...many]).includes("at most 6 sources"));
		});

		it("tells a step what it reads, and starts it on its sources", () => {
			const plan = compileGraphPlan([...base(), ...book, ...margin]);
			const built = buildGraphPlanInputs({
				graphId: "freud-dreams",
				graphOwnerPrincipal: "user:default",
				request: { definition: `${W}:draft`, digest: graphPlanDigest(plan), inputs: {} },
				plan,
				digest: graphPlanDigest(plan),
				runtimeBundle: { id: "sophia-agent-runtime", digest: "0".repeat(64) },
				inference: { provider: "openrouter", model: "test/model" },
				now: 0,
			});
			const steps = (
				built.args as { plan: { phases: { steps: { id: string; agent: { systemPrompt: string } }[] }[] } }
			).plan.phases.flatMap((p) => p.steps);
			const reader = steps.find((s) => s.id === "reader");
			assert.match(
				reader?.agent.systemPrompt ?? "",
				/You read:\n- The Interpretation of Dreams, I\.C: document freud-dreams-1, from block block-be1fe535 through block block-0c1d2e3f\./,
			);
			const clerk = steps.find((s) => s.id === "clerk");
			assert.doesNotMatch(clerk?.agent.systemPrompt ?? "", /You read:/);
		});
	});
});
