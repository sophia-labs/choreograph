import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import * as oxigraph from "oxigraph";
import { mintAgentUri, mintStandaloneAgentId } from "../agent-subject/agent-ontology.js";
import { type BusEvent, createSandboxEventBus } from "../event-bus.js";
import type { SandboxStore } from "../sandbox-store.js";
import {
	compileGraphPlan,
	GraphPlanError,
	type GraphPlanV1,
	graphPlanDigest,
	parseTerm,
	stepOutputSchema,
	type Triple,
	triplesFromSparqlResult,
	WF,
} from "../workflow/graph-plan.js";
import type { GraphWriter } from "../workflow/graph-writer.js";
import { compileWorkflow, runWorkflow } from "../workflow/harness.js";
import { awaitNodeResult, REQUIRED_STRUCTURED_OUTPUT_ERROR } from "../workflow/run-node.js";
import {
	buildGraphPlanInputs,
	finalizeGraphPlanRun,
	GRAPH_PLAN_SCRIPT,
	graphPlanRunGraphIri,
	graphPlanRuntimeConstraints,
	serializeGraphPlanRun,
	serializeGraphPlanRunTurtle,
} from "../workflow/script-graph-plan.js";
import type { AgentNodeSpec, NodeRunner } from "../workflow/types.js";

// The definition as a live gardend answered `SELECT ?s ?p ?o WHERE { GRAPH <urn:sophia:wf:freud-ch1:v1> { … } }`
// on 2026-10-18; the run that day pinned this digest, and the browser pane computes the same one
// (shrubbery apps/organism/src/cell/__tests__/graph-plan.test.ts).
const FIXTURE = JSON.parse(
	readFileSync(new URL("./fixtures/graph-plan-freud-ch1.sparql.json", import.meta.url), "utf8"),
) as unknown;
const PINNED = "sha256:3d3efe3add6543d7d800941ee10559f4729e29b6d69c8416ce5c00d37dcc0b33";
// The same definition with a source the Reader reads and a margin the verified entries go to (2026-10-19).
const PINNED_WITH_SOURCES = "sha256:e0f63e28e36771e32eb181a178e8b8b96021dd20b84cbce7c5440c38df83546a";
// And with its clerk bound to a class, "Dream report" at workspace@1 (2026-10-20, typed items).
const PINNED_WITH_CLASS = "sha256:0f3d4c27f1df880a97607426131228ca4c3335869a4ba8bc0a6f2d9bc89a69eb";

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

	describe("sources and destinations (2026-10-19)", () => {
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

	describe("typed items (2026-10-20, plans/2026-10-20-typed-objects §4)", () => {
		const DREAM_REPORT = "urn:sophia:type:freud-dreams:workspace#DreamReport";
		// What `workflow_plan_compose` writes on a step bound to a class (D4): the class, and the vocabulary version it
		// pinned. (It also overwrites `wf:itemSchema` with the class's derived schema; the compilers carry that as they
		// carry any schema, so this case keeps the fixture's.)
		const classBound: Triple[] = [
			{ s: `${W}#clerk`, p: `${WF}itemClass`, o: iri(DREAM_REPORT) },
			{ s: `${W}#clerk`, p: `${WF}itemVocab`, o: text("workspace@1") },
		];
		const stepsOf = (plan: GraphPlanV1) => plan.phases.flatMap((p) => p.steps);
		const promptsOf = (plan: GraphPlanV1): Map<string, string> => {
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
			return new Map(steps.map((s) => [s.id, s.agent.systemPrompt]));
		};

		it("carries a step's class and its pinned vocabulary into the compiled step, and the digest pins both", () => {
			const plan = compileGraphPlan([...base(), ...book, ...margin, ...classBound]);
			const clerk = stepsOf(plan).find((s) => s.id === "clerk");
			assert.equal(clerk?.itemClass, DREAM_REPORT);
			assert.equal(clerk?.itemVocab, "workspace@1");
			for (const other of stepsOf(plan).filter((s) => s.id !== "clerk")) {
				assert.equal("itemClass" in other, false, `${other.id} names no class, so it carries none`);
				assert.equal("itemVocab" in other, false);
			}
			const digest = graphPlanDigest(plan);
			// The browser pane reaches the same digest (shrubbery apps/organism/src/cell/__tests__/graph-plan.test.ts).
			assert.equal(digest, PINNED_WITH_CLASS);
			assert.notEqual(digest, PINNED_WITH_SOURCES, "binding a class is approved too");
			const bumped = [...base(), ...book, ...margin, ...classBound].map((t) =>
				t.p === `${WF}itemVocab` ? { ...t, o: text("workspace@2") } : t,
			);
			assert.notEqual(graphPlanDigest(compileGraphPlan(bumped)), digest, "a new class version needs a new approval");
			// The runner and the submit tool are unchanged: they still read the step's schema.
			const untyped = stepsOf(compileGraphPlan([...base(), ...book, ...margin])).find((s) => s.id === "clerk");
			assert.ok(clerk && untyped);
			assert.deepEqual(stepOutputSchema(clerk), stepOutputSchema(untyped));
		});

		it("refuses a class that is not an IRI, a vocabulary with no version, and either one without the other", () => {
			const problems = problemsOf([
				...base(),
				{ s: `${W}#clerk`, p: `${WF}itemClass`, o: text("DreamReport") },
				{ s: `${W}#clerk`, p: `${WF}itemVocab`, o: text("workspace") },
			]);
			for (const expected of [
				'clerk\'s wf:itemClass must be an IRI, not "DreamReport"',
				'clerk\'s wf:itemVocab is "workspace"; write it as <vocab>@<version>',
			]) {
				assert.ok(problems.includes(expected), `${expected}\n  in: ${problems.join(" | ")}`);
			}
			const alone = problemsOf([...base(), classBound[0], { ...classBound[1], s: `${W}#reader` }]);
			for (const expected of [
				"clerk names a class (wf:itemClass) but not the vocabulary version that pins it (wf:itemVocab)",
				"reader names a vocabulary version (wf:itemVocab) but no class (wf:itemClass)",
			]) {
				assert.ok(alone.includes(expected), `${expected}\n  in: ${alone.join(" | ")}`);
			}
		});

		it("tells a class-bound step what it hands back, by the class's label when the plan carries one", () => {
			const prompts = promptsOf(compileGraphPlan([...base(), ...classBound]));
			// The plan carries no label: the class IRI's fragment names it.
			assert.match(
				prompts.get("clerk") ?? "",
				/\nYou are given one item\. Answer with the items you produce from it \(an empty list if there are none\)\.\nEach item you hand back is a DreamReport\.\n/,
			);
			for (const id of ["reader", "censor"]) assert.doesNotMatch(prompts.get(id) ?? "", /Each item you hand back/);
			// The class's derived schema names it (JSON Schema's `title`): the step is told the label.
			const titled = [...base(), ...classBound].map((t) => {
				if (t.s !== `${W}#clerk` || t.p !== `${WF}itemSchema`) return t;
				return { ...t, o: text(JSON.stringify({ ...JSON.parse(t.o.value), title: "Dream report" })) };
			});
			assert.match(
				promptsOf(compileGraphPlan(titled)).get("clerk") ?? "",
				/\nEach item you hand back is a Dream report\.\n/,
			);
			const observation = [...base(), ...classBound].map((t) =>
				t.p === `${WF}itemClass` ? { ...t, o: iri("urn:sophia:type:freud-dreams:workspace#Observation") } : t,
			);
			assert.match(
				promptsOf(compileGraphPlan(observation)).get("clerk") ?? "",
				/\nEach item you hand back is an Observation\.\n/,
			);
		});

		describe("a run, recorded", () => {
			// A real run in Sophia.app (2026-10-20), the same events Shrubbery's own test reads: what its cutter, its clerks
			// and its checkers handed back. Here the Freud plan, its clerk bound to a class, is run by the real script and the
			// real result mapping, each node answering what a node of that run answered.
			const APP_RUN = JSON.parse(
				readFileSync(new URL("./fixtures/graph-plan-run-events-20261020.json", import.meta.url), "utf8"),
			) as { type: string; label: string; payload?: Record<string, unknown> }[];
			const handedBack = (label: string): Record<string, unknown> => {
				const event = APP_RUN.find((e) => e.label === label && (e.type === "node_done" || e.type === "error"));
				assert.ok(event?.payload, `the recorded run has no answer from ${label}`);
				const { status, output, turns, tokens, tool_calls, structured_output } = event.payload;
				return { status, output, turns, tokens, tool_calls, ...(structured_output ? { structured_output } : {}) };
			};
			const passages = (handedBack("Passage cutter").structured_output as { items: unknown[] }).items.slice(0, 4);
			const reports = (handedBack("Experiment clerk #3").structured_output as { items: Record<string, unknown>[] })
				.items;
			const submitted = (structured: unknown) => ({
				status: "terminated",
				output: JSON.stringify(structured, null, 2),
				structured_output: structured,
			});
			// What each node answers, by its label. Clerk #3 answers in plain text (its answer as prose JSON) and never calls
			// submit(), twice: the way three of 26 clerks lost their passage on 2026-10-18. The second check loses its model
			// call once, as checker #5 did in the recorded run, and passes when asked again.
			const CLERK = "the Experimenter's Clerk";
			const CENSOR = "the Censor";
			const asPlainText = { status: "terminated", output: handedBack("Experiment clerk #3").output };
			const answers: Record<string, Record<string, unknown>> = {
				"the Reader": submitted({ items: passages }),
				[`${CLERK} #1`]: submitted({ items: reports.slice(0, 2) }),
				[`${CLERK} #2`]: handedBack("Experiment clerk #2"),
				[`${CLERK} #3`]: asPlainText,
				[`${CLERK} #3 again`]: asPlainText,
				[`${CLERK} #4`]: submitted({ items: reports.slice(2) }),
				[`${CENSOR} #1`]: handedBack("Exact-quote checker #1"),
				[`${CENSOR} #2`]: handedBack("Exact-quote checker #5"),
				[`${CENSOR} #2 again`]: handedBack("Exact-quote checker #5 again"),
				[`${CENSOR} #3`]: handedBack("Exact-quote checker #1"),
				[`${CENSOR} #4`]: submitted({ ok: false, reason: "The quote is not word for word in the passage." }),
				[`${CENSOR} #5`]: handedBack("Exact-quote checker #1"),
			};
			const stubStore = { get: () => undefined } as unknown as SandboxStore;

			/** `stopped`: sittings the host ends (by label), as the spawner reports them: a terminal state and its words. */
			const runThePlan = async (stopped: Record<string, { state: string; error_detail: string }> = {}) => {
				const plan = compileGraphPlan([...base(), ...book, ...margin, ...classBound]);
				const digest = graphPlanDigest(plan);
				const inputs = buildGraphPlanInputs({
					graphId: "freud-dreams",
					graphOwnerPrincipal: "user:default",
					request: { definition: `${W}:draft`, digest, inputs: {} },
					plan,
					digest,
					runtimeBundle: { id: "sophia-agent-runtime", digest: "0".repeat(64) },
					inference: { provider: "openrouter", model: "test/model" },
					now: 0,
				});
				const specs: AgentNodeSpec[] = [];
				let clock = 1_000;
				const runNode: NodeRunner = (spec) => {
					specs.push(spec);
					const result = answers[spec.label];
					assert.ok(result, `no recorded answer for ${spec.label}`);
					const bus = createSandboxEventBus(stubStore);
					const sandboxId = `sb-${specs.length}`;
					const pending = awaitNodeResult(bus, sandboxId, spec, clock, () => ++clock);
					const ended = stopped[spec.label];
					bus.emit(
						(ended
							? {
									category: "lifecycle",
									type: "terminal",
									sandbox_id: sandboxId,
									ts: new Date(clock).toISOString(),
									...ended,
								}
							: {
									category: "lifecycle",
									type: "terminal",
									sandbox_id: sandboxId,
									ts: new Date(clock).toISOString(),
									state: "done",
									result: { spawn_id: sandboxId, turns: 1, tokens: 0, tool_calls: 0, ...result },
								}) as BusEvent,
					);
					return pending;
				};
				const run = await runWorkflow(
					{ runNode, runId: "wfr-typed-1", now: () => clock },
					compileWorkflow(GRAPH_PLAN_SCRIPT),
					inputs,
				);
				return { plan, inputs, specs, run };
			};

			/** gardend's `workflow_run_record` as far as a finalizer meets it: the subject rule, onto a real store. */
			const recordingInto = (store: oxigraph.Store, refuseRecord = false): GraphWriter =>
				({
					async recordWorkflowRun(_graphId: string, run: { documentId: string; runId: string; turtle: string }) {
						if (refuseRecord) throw new Error("unknown tool: workflow_run_record");
						const runGraph = graphPlanRunGraphIri(`urn:sophia:wf:${run.documentId}`, run.runId);
						const scratch = new oxigraph.Store();
						scratch.load(run.turtle, { format: "text/turtle", to_graph_name: oxigraph.namedNode(runGraph) });
						for (const quad of scratch.match(null, null, null, null)) {
							const rest = quad.subject.value.startsWith(runGraph)
								? quad.subject.value.slice(runGraph.length)
								: null;
							if (
								quad.subject.termType !== "NamedNode" ||
								rest === null ||
								(rest !== "" && !rest.startsWith("#"))
							) {
								throw new Error(`${quad.subject.value} is not about this run`);
							}
							store.add(quad);
						}
					},
					async sparqlUpdate(_graphId: string, sparql: string) {
						store.update(sparql);
					},
				}) as unknown as GraphWriter;

			it("keeps beside each item the sitting that handed it back, never inside the item the next step sees", async () => {
				const { specs, run } = await runThePlan();
				const out = run.output as {
					collections: Record<string, unknown[]>;
					sittings: Record<string, string[]>;
				};
				assert.deepEqual(out.collections[`${W}#candidates`], reports);
				assert.deepEqual(out.sittings[`${W}#candidates`], [
					`${CLERK} #1`,
					`${CLERK} #1`,
					`${CLERK} #4`,
					`${CLERK} #4`,
					`${CLERK} #4`,
				]);
				// A check passes items; it does not make them. What it passed keeps the sitting of the clerk who made it.
				assert.deepEqual(out.collections[`${W}#verified`], [reports[0], reports[1], reports[2], reports[4]]);
				assert.deepEqual(out.sittings[`${W}#verified`], [
					`${CLERK} #1`,
					`${CLERK} #1`,
					`${CLERK} #4`,
					`${CLERK} #4`,
				]);
				assert.deepEqual(out.sittings[`${W}#passages`], ["the Reader", "the Reader", "the Reader", "the Reader"]);
				// Each check is given the item exactly as the clerk handed it back (a retry is the same prompt and a nudge).
				const given = specs
					.filter((s) => s.label.startsWith(CENSOR) && !s.label.endsWith(" again"))
					.map((s) => JSON.parse(s.prompt.slice("The item:\n".length)) as unknown);
				assert.deepEqual(given, reports);
			});

			it("records a sitting the host stopped as unfit in its words, gives it no second chance, and goes on", async () => {
				// 2026-10-21: the clerk that read one block two dozen times. Its wall clock ends it; the phase goes on.
				const words = "Stopped after 5 minutes without an answer.";
				const { specs, run } = await runThePlan({ [`${CLERK} #2`]: { state: "timeout", error_detail: words } });
				const out = run.output as { unfit: unknown[]; collections: Record<string, unknown[]> };
				assert.deepEqual(out.unfit, [
					{ step: `${W}#clerk`, sitting: `${CLERK} #2`, violation: words },
					{ step: `${W}#clerk`, sitting: `${CLERK} #3`, violation: REQUIRED_STRUCTURED_OUTPUT_ERROR },
				]);
				const labels = specs.map((s) => s.label);
				assert.equal(labels.includes(`${CLERK} #2 again`), false, "a stopped sitting is not asked again");
				assert.ok(labels.includes(`${CLERK} #3 again`), "a sitting that answered in prose still is");
				assert.ok(labels.includes(`${CENSOR} #1`), "the next phase ran on what was handed back");
				assert.deepEqual(out.collections[`${W}#candidates`], reports);
				const node = run.agents.find((a) => a.label === `${CLERK} #2`);
				assert.equal(node?.state, "error");
				assert.equal(node?.stopped, words);
			});

			it("binds every sitting to a five-minute wall clock and sixteen turns", async () => {
				const { specs } = await runThePlan();
				for (const spec of specs) {
					assert.equal(spec.runtime?.constraints.maxWallTimeMs, 300_000, spec.label);
					assert.equal(spec.runtime?.constraints.maxTurns, 16, spec.label);
					assert.equal(spec.maxTurns, 16, spec.label);
				}
				assert.equal(graphPlanRuntimeConstraints("2").maxWallTimeMs, 120_000);
				assert.equal(graphPlanRuntimeConstraints("0.5").maxWallTimeMs, 30_000);
				assert.equal(graphPlanRuntimeConstraints("soon").maxWallTimeMs, 300_000);
				// Never past the Reader profile it narrows.
				assert.equal(graphPlanRuntimeConstraints("120").maxWallTimeMs, 900_000);
			});

			it("records what did not fit, with the sitting and the runtime's words, instead of dropping it", async () => {
				const { run } = await runThePlan();
				const out = run.output as { unfit: unknown[] };
				assert.deepEqual(out.unfit, [
					{ step: `${W}#clerk`, sitting: `${CLERK} #3`, violation: REQUIRED_STRUCTURED_OUTPUT_ERROR },
				]);
			});

			it("writes the cast being, the sittings and the unfit into the run graph, every subject the run's", async () => {
				const { plan, inputs, run } = await runThePlan();
				const store = new oxigraph.Store();
				await finalizeGraphPlanRun(run, { graph: recordingInto(store), graphId: "freud-dreams", inputs });
				const runGraph = oxigraph.namedNode(graphPlanRunGraphIri(plan.workflow, run.runId));
				const quads = store.match(null, null, null, runGraph);
				assert.ok(quads.length > 0);
				for (const q of quads) assert.match(q.subject.value, /^urn:sophia:wf:freud-ch1:run:wfr-typed-1#/);
				const nn = oxigraph.namedNode;
				const objectsOf = (subject: oxigraph.Term, p: string) =>
					store.match(subject as oxigraph.NamedNode, nn(`${WF}${p}`), null, runGraph).map((q) => q.object.value);
				const subjectsOf = (type: string) =>
					store.match(null, nn(RDF_TYPE_IRI), nn(`${WF}${type}`), runGraph).map((q) => q.subject);

				// Per step, the being cast for that post: one per step, the same being every one of its sittings ran as.
				const castFor = new Map(
					subjectsOf("StepRun").map((s) => [objectsOf(s, "step")[0], objectsOf(s, "castAgent")]),
				);
				const being = (step: string) =>
					mintAgentUri(
						mintStandaloneAgentId({ name: `graph-plan-v1:user:default/freud-dreams/freud-ch1/${step}` }),
					);
				assert.deepEqual(castFor.get(`${W}#clerk`), [being("clerk")]);
				assert.deepEqual(castFor.get(`${W}#reader`), [being("reader")]);
				assert.deepEqual(castFor.get(`${W}#censor`), [being("censor")]);
				const clerkNodes = run.agents.filter((a) => a.label.startsWith(CLERK));
				assert.equal(clerkNodes.length, 5);
				for (const node of clerkNodes) assert.equal(mintAgentUri(node.agentId ?? ""), being("clerk"));

				// Per item, its sitting.
				const verified = subjectsOf("Item")
					.filter((s) => objectsOf(s, "inCollection")[0] === `${W}#verified`)
					.map((s) => [Number(objectsOf(s, "position")[0]), objectsOf(s, "sitting")] as const)
					.sort((a, b) => a[0] - b[0]);
				assert.deepEqual(verified, [
					[0, [`${CLERK} #1`]],
					[1, [`${CLERK} #1`]],
					[2, [`${CLERK} #4`]],
					[3, [`${CLERK} #4`]],
				]);
				// The item JSON is what the clerk handed back, nothing added.
				const json = store.match(null, nn(`${WF}json`), null, runGraph).map((q) => q.object.value);
				assert.ok(json.includes(JSON.stringify(reports[4])));
				assert.ok(json.every((j) => !j.includes(CLERK)));

				// What did not fit.
				const unfit = subjectsOf("Unfit");
				assert.equal(unfit.length, 1);
				assert.deepEqual(
					["step", "sitting", "violation", "partOfRun"].map((p) => objectsOf(unfit[0], p)),
					[[`${W}#clerk`], [`${CLERK} #3`], [REQUIRED_STRUCTURED_OUTPUT_ERROR], [`${runGraph.value}#run`]],
				);

				// A cell without workflow_run_record takes the same triples as an update.
				const viaUpdate = new oxigraph.Store();
				await finalizeGraphPlanRun(run, {
					graph: recordingInto(viaUpdate, true),
					graphId: "freud-dreams",
					inputs,
				});
				const nquads = (s: oxigraph.Store) =>
					s
						.match(null, null, null, runGraph)
						.map((q) => q.toString())
						.sort();
				assert.deepEqual(nquads(viaUpdate), nquads(store));
			});
		});
	});
});
