/**
 * Unit tests for the GAP-2 fix in `graph-writer.ts`:
 *  - `scopeUpdateToUserRdfGraph` wraps a bare provenance update body in a LITERAL
 *    `GRAPH <…:user:rdf>` clause so it lands in the cell's UI-readable authority
 *    graph (not oxigraph's default graph, where Studio's Provenance view can't
 *    see it).
 *  - `makeHostedGraphWriter` forwards the CELL tool contract (camelCase
 *    `{ graphId, update }` / `{ graphId, query }`), GRAPH-scoping every update.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { HostedMnemosyneProxy } from "../mnemosyne.js";
import {
	fencedJsonDocument,
	JsonDocumentWriteError,
	MAX_DOCUMENT_READ_CHARS,
	makeHostedGraphWriter,
	normalizeGraphDocumentRead,
	scopeUpdateToUserRdfGraph,
	unwrapAuthoredJsonDocument,
	writeJsonDocument,
} from "../workflow/graph-writer.js";
import {
	serializeAgentRunProvenance,
	serializeRunProvenance,
	serializeRunStartedProvenance,
} from "../workflow/provenance.js";
import type { AgentNodeResult, RunRecord } from "../workflow/types.js";
import { userRdfGraphIri } from "../workflow/vocab.js";
import { gardenDocumentFace } from "./markdown-face-fixture.js";

const GRAPH = "canary-studio-demo";
const USER_RDF = userRdfGraphIri(GRAPH);

function agent(label: string, phaseIndex: number): AgentNodeResult {
	const t = 1_781_773_331_000;
	return {
		label,
		phaseIndex,
		state: "done",
		output: "",
		model: "mistralai/mistral-nemo",
		turns: 1,
		toolCalls: 1,
		tokens: 321,
		queuedAt: t,
		startedAt: t + 100,
		durationMs: 900,
		agentType: "graph-surveyor",
	};
}

function fixtureRun(over: Partial<RunRecord> = {}): RunRecord {
	return {
		runId: "wfr-test-aa31",
		workflowName: "graph-survey-synthesize",
		workflowUri: "urn:sophia:wf:graph-survey-synthesize",
		status: "completed",
		startedAt: 1_781_773_331_000,
		endedAt: 1_781_773_372_230,
		durationMs: 41230,
		agentCount: 2,
		totalTokens: 642,
		agents: [agent("map:canary-notes", 1), agent("synthesize", 2)],
		...over,
	};
}

describe("scopeUpdateToUserRdfGraph — graph scoping", () => {
	it("mints the cell user-RDF graph IRI for the graph_id", () => {
		assert.equal(USER_RDF, "urn:mnemosyne:local:graph:canary-studio-demo:user:rdf");
	});

	it("wraps a bare INSERT DATA body in GRAPH <…:user:rdf> { … }", () => {
		const scoped = scopeUpdateToUserRdfGraph(GRAPH, serializeRunProvenance(fixtureRun()));
		// The literal named-graph clause is present.
		assert.match(scoped, new RegExp(`GRAPH <${USER_RDF.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}> \\{`));
		// The run + agent triples survive the wrap (predicate set intact).
		assert.ok(scoped.includes("a wf:Run, prov:Activity"));
		assert.ok(scoped.includes("a wf:AgentRun"));
		assert.ok(scoped.includes("wf:partOfRun "));
		// PREFIX preamble stays OUTSIDE the GRAPH clause (before INSERT DATA).
		assert.ok(scoped.indexOf("PREFIX wf:") < scoped.indexOf("INSERT DATA"));
		assert.ok(scoped.indexOf("INSERT DATA") < scoped.indexOf(`GRAPH <${USER_RDF}>`));
		// Still a single balanced INSERT DATA operation.
		assert.equal((scoped.match(/INSERT DATA/g) ?? []).length, 1);
	});

	it("wraps the incremental run_started and agentRun emits too", () => {
		const started = scopeUpdateToUserRdfGraph(GRAPH, serializeRunStartedProvenance(fixtureRun()));
		assert.ok(started.includes(`GRAPH <${USER_RDF}>`));
		assert.ok(started.includes("a wf:Run, prov:Activity"));

		const agentRun = scopeUpdateToUserRdfGraph(
			GRAPH,
			serializeAgentRunProvenance("wfr-test-aa31", agent("map:x", 1)),
		);
		assert.ok(agentRun.includes(`GRAPH <${USER_RDF}>`));
		assert.ok(agentRun.includes("a wf:AgentRun"));
	});

	it("wraps a DELETE WHERE idempotency body (literal GRAPH, never a variable)", () => {
		const del = "PREFIX wf: <http://mnemosyne.dev/workflow#>\nDELETE WHERE { <urn:sophia:wf-run:r1> ?p ?o }";
		const scoped = scopeUpdateToUserRdfGraph(GRAPH, del);
		assert.match(
			scoped,
			new RegExp(`DELETE WHERE \\{[\\s\\S]*GRAPH <${USER_RDF.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`),
		);
		// The cell validator bans variable-graph targets — assert we never emit one.
		assert.ok(!/GRAPH \?/.test(scoped));
		assert.ok(!/WITH \?/.test(scoped));
	});

	it("is idempotent / a no-op when a GRAPH clause is already present", () => {
		const already = `INSERT DATA { GRAPH <${USER_RDF}> { <urn:s> <urn:p> <urn:o> } }`;
		assert.equal(scopeUpdateToUserRdfGraph(GRAPH, already), already);
	});

	it("leaves an unrecognised update verbatim (no operation keyword)", () => {
		const odd = "PREFIX wf: <http://mnemosyne.dev/workflow#>\nLOAD <urn:x>";
		assert.equal(scopeUpdateToUserRdfGraph(GRAPH, odd), odd);
	});
});

describe("makeHostedGraphWriter — cell tool contract (camelCase) + graph scoping", () => {
	interface Call {
		tool: string;
		args: Record<string, unknown>;
	}

	function fakeProxy(): { proxy: HostedMnemosyneProxy; calls: Call[] } {
		const calls: Call[] = [];
		const proxy = {
			async callTool(tool: string, args: Record<string, unknown>) {
				calls.push({ tool, args });
				return { content: [] };
			},
		} as unknown as HostedMnemosyneProxy;
		return { proxy, calls };
	}

	it("sparqlUpdate forwards { graphId, update } (camelCase) with the body GRAPH-scoped", async () => {
		const { proxy, calls } = fakeProxy();
		const writer = makeHostedGraphWriter(proxy);
		await writer.sparqlUpdate(GRAPH, serializeRunProvenance(fixtureRun()));

		assert.equal(calls.length, 1);
		assert.equal(calls[0].tool, "sparql_update");
		// Cell contract: camelCase keys, NOT snake_case graph_id/sparql.
		assert.equal(calls[0].args.graphId, GRAPH);
		assert.ok(typeof calls[0].args.update === "string");
		assert.equal(calls[0].args.graph_id, undefined);
		assert.equal(calls[0].args.sparql, undefined);
		// And the update lands in the user-RDF named graph.
		assert.ok((calls[0].args.update as string).includes(`GRAPH <${USER_RDF}>`));
	});

	it("sparqlQuery forwards { graphId, query } (camelCase)", async () => {
		const { proxy, calls } = fakeProxy();
		const writer = makeHostedGraphWriter(proxy);
		await writer.sparqlQuery(GRAPH, "SELECT * WHERE { ?s ?p ?o }");

		assert.equal(calls[0].tool, "sparql_query");
		assert.equal(calls[0].args.graphId, GRAPH);
		assert.equal(calls[0].args.query, "SELECT * WHERE { ?s ?p ?o }");
		assert.equal(calls[0].args.graph_id, undefined);
		assert.equal(calls[0].args.sparql, undefined);
	});

	it("readDocument normalizes the MCP structured-content face", async () => {
		const calls: Call[] = [];
		const proxy = {
			async callTool(tool: string, args: Record<string, unknown>) {
				calls.push({ tool, args });
				return {
					structuredContent: {
						graph_id: GRAPH,
						document_id: "agent-prompt-phanes-system",
						format: "markdown",
						content: "You are Phanes.",
						// The page fields garden sends on every read since r20260807a (2026-08-07).
						offset: 0,
						nextOffset: null,
						complete: true,
						totalChars: 15,
						revision: 7,
						change_id: "chg-7",
						blocks: [{ id: "identity", type: "paragraph", text: "You are Phanes." }],
					},
				};
			},
		} as unknown as HostedMnemosyneProxy;
		const document = await makeHostedGraphWriter(proxy).readDocument(GRAPH, "agent-prompt-phanes-system");

		assert.deepEqual(calls[0], {
			tool: "read_document",
			args: { graph_id: GRAPH, document_id: "agent-prompt-phanes-system", format: "markdown", maxChars: 262_144 },
		});
		assert.equal(document.text, "You are Phanes.");
		assert.equal(document.revision, 7);
		assert.equal(
			document.blocks[0]?.blockUri,
			"urn:mnemosyne:local:document:agent-prompt-phanes-system#block-identity",
		);
	});
});

describe("normalizeGraphDocumentRead", () => {
	it("unwraps JSON carried in MCP text content and fails to invent graph identity", () => {
		const normalized = normalizeGraphDocumentRead(
			{ content: [{ type: "text", text: JSON.stringify({ document_id: "charter", content: "Bounded waves." }) }] },
			{ graphId: "phanes", documentId: "fallback", format: "markdown" },
		);
		assert.equal(normalized.graphId, "phanes");
		assert.equal(normalized.documentId, "charter");
		assert.equal(normalized.documentUri, "urn:mnemosyne:local:document:charter");
		assert.equal(normalized.text, "Bounded waves.");
	});
});

/**
 * A cell that pages `read_document` exactly as garden r20261002 does (document_mcp_service.rs:14,138-168): 65,536
 * characters unless `maxChars` (clamped to 1..262,144) is passed, from `offset`, answering `nextOffset`, `complete`
 * and `totalChars`. Writes keep the content as given and remember the arguments.
 */
function pagingCell(initial: Record<string, string> = {}) {
	const documents = new Map(Object.entries(initial));
	const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	const proxy = {
		async callTool(tool: string, args: Record<string, unknown>) {
			calls.push({ tool, args });
			const documentId = String(args.document_id ?? args.documentId);
			if (tool === "write_document") {
				// Kept as garden's document face keeps it (`markdown-face-fixture.ts`), not as sent.
				documents.set(
					documentId,
					gardenDocumentFace(String(args.content), typeof args.format === "string" ? args.format : undefined),
				);
				return { structuredContent: { document_id: documentId, revision: 1 } };
			}
			if (tool !== "read_document") throw new Error(`unexpected tool ${tool}`);
			const content = documents.get(documentId);
			if (content === undefined) throw new Error(`document not found: ${documentId}`);
			const chars = [...content];
			const offset = Math.min(Number(args.offset ?? 0), chars.length);
			const maxChars = Math.max(1, Math.min(Number(args.maxChars ?? 65_536), 262_144));
			const visible = chars.slice(offset, offset + maxChars).join("");
			const next = offset + [...visible].length;
			const complete = next >= chars.length;
			return {
				structuredContent: {
					graph_id: GRAPH,
					document_id: documentId,
					format: args.format ?? "markdown",
					content: visible,
					offset,
					nextOffset: complete ? null : next,
					complete,
					totalChars: chars.length,
					maxChars,
					revision: 3,
				},
			};
		},
	} as unknown as HostedMnemosyneProxy;
	return { proxy, calls, documents };
}

describe("readDocument reads the whole document, page by page (the 65,536-character truncation)", () => {
	it("reads a 94,639-character tool manifest whole, where one default page held 65,536", async () => {
		// The size of Phanes' phanes-prime-tool-manifest-v3, pretty-printed (RETURN-json-face.md, item 1).
		const manifest = JSON.stringify({ tools: "x".repeat(94_639 - 12) });
		assert.equal(manifest.length, 94_639);
		const { proxy, calls } = pagingCell({ "phanes-prime-tool-manifest-v3": manifest });
		const document = await makeHostedGraphWriter(proxy).readDocument(GRAPH, "phanes-prime-tool-manifest-v3");
		assert.equal(document.text, manifest);
		assert.deepEqual(JSON.parse(document.text ?? ""), JSON.parse(manifest));
		assert.equal(calls.length, 1, "one page of 262,144 holds it");
	});

	it("follows nextOffset until complete for a document longer than the largest page", async () => {
		const long = "abc\n".repeat(150_000);
		const { proxy, calls } = pagingCell({ long });
		const document = await makeHostedGraphWriter(proxy).readDocument(GRAPH, "long");
		assert.equal(document.text, long);
		assert.deepEqual(
			calls.map((call) => call.args.offset ?? 0),
			[0, 262_144, 524_288],
		);
	});

	// The cases this name once claimed but did not cover (advancing empty pages, offset regressions, an absent
	// `complete`, an oversized completed page) are the strict reader's suite below (exam 1, section 4).
	it("refuses a page that does not advance, and a document over the host's bound, instead of looping", async () => {
		const stuck = {
			async callTool() {
				return {
					structuredContent: {
						graph_id: GRAPH,
						document_id: "stuck",
						content: "",
						offset: 0,
						nextOffset: 0,
						complete: false,
						totalChars: 10,
					},
				};
			},
		} as unknown as HostedMnemosyneProxy;
		await assert.rejects(() => makeHostedGraphWriter(stuck).readDocument(GRAPH, "stuck"), /did not advance/);
		const endless = {
			async callTool(_tool: string, args: Record<string, unknown>) {
				const offset = Number(args.offset ?? 0);
				return {
					structuredContent: {
						graph_id: GRAPH,
						document_id: "huge",
						content: "y".repeat(262_144),
						offset,
						nextOffset: offset + 262_144,
						complete: false,
						totalChars: MAX_DOCUMENT_READ_CHARS * 2,
					},
				};
			},
		} as unknown as HostedMnemosyneProxy;
		await assert.rejects(() => makeHostedGraphWriter(endless).readDocument(GRAPH, "huge"), /longer than/);
	});
});

/**
 * A cell that answers `read_document` pages from a script, one answer per call, and refuses to answer more than
 * `limit` calls: a reader that loops is seen failing on the limit instead of hanging the suite.
 */
function scriptedCell(
	pages: ReadonlyArray<Record<string, unknown> | ((args: Record<string, unknown>) => unknown)>,
	limit = 200,
) {
	const calls: Array<Record<string, unknown>> = [];
	const proxy = {
		async callTool(_tool: string, args: Record<string, unknown>) {
			calls.push(args);
			if (calls.length > limit) throw new Error(`the scripted cell was asked for more than ${limit} pages`);
			const page = pages[Math.min(calls.length - 1, pages.length - 1)];
			return typeof page === "function" ? page(args) : { structuredContent: page };
		},
	} as unknown as HostedMnemosyneProxy;
	return { proxy, calls };
}

const page = (fields: Record<string, unknown>) => ({ graph_id: GRAPH, document_id: "doc", revision: 3, ...fields });

describe("exam 1: the paged reader is strict (graph-writer.ts:194,212)", () => {
	const read = (cell: { proxy: HostedMnemosyneProxy }) => makeHostedGraphWriter(cell.proxy).readDocument(GRAPH, "doc");

	it("succeeds only on an explicit complete: true, never on a page that says nothing", async () => {
		// The exam's first reproduction: no `complete`, so the reader returned "partial" as the whole document.
		await assert.rejects(read(scriptedCell([{ content: "partial", nextOffset: 7, totalChars: 100 }])), /complete/);
		await assert.rejects(read(scriptedCell([page({ content: "partial", offset: 0, totalChars: 7 })])), /complete/);
		// A page that names a document whole is read whole.
		const whole = await read(
			scriptedCell([page({ content: "all of it", offset: 0, complete: true, totalChars: 9 })]),
		);
		assert.equal(whole.text, "all of it");
	});

	it("refuses a page whose offset is not where the last page ended (the exam's regression: abc then abc again at 0)", async () => {
		const regression = scriptedCell([
			page({ content: "abc", offset: 0, nextOffset: 3, complete: false, totalChars: 6 }),
			page({ content: "abc", offset: 0, nextOffset: 6, complete: true, totalChars: 6 }),
		]);
		await assert.rejects(read(regression), /offset/);
		// A first page that does not begin at the beginning is refused too.
		await assert.rejects(
			read(scriptedCell([page({ content: "def", offset: 3, complete: true, totalChars: 6 })])),
			/offset/,
		);
		// And a nextOffset that skips text the page did not carry.
		const skipping = scriptedCell([
			page({ content: "abc", offset: 0, nextOffset: 5, complete: false, totalChars: 8 }),
			page({ content: "fgh", offset: 5, nextOffset: null, complete: true, totalChars: 8 }),
		]);
		await assert.rejects(read(skipping), /offset/);
	});

	it("cannot loop on empty pages whose offsets advance (the exam's third reproduction)", async () => {
		const empty = scriptedCell([
			(args: Record<string, unknown>) => {
				const offset = Number(args.offset ?? 0);
				return {
					structuredContent: page({
						content: "",
						offset,
						nextOffset: offset + 1,
						complete: false,
						totalChars: 10,
					}),
				};
			},
		]);
		await assert.rejects(read(empty), /empty|offset/);
		assert.ok(empty.calls.length <= 2, `it stopped at once, not after ${empty.calls.length} pages`);
	});

	it("refuses an oversized first page, completed or not, and a document whose total is over the bound", async () => {
		// The exam's fourth reproduction: 4,194,305 characters in one completed page passed the 4 Mi bound.
		const big = "z".repeat(MAX_DOCUMENT_READ_CHARS + 1);
		await assert.rejects(
			read(scriptedCell([page({ content: big, offset: 0, complete: true, totalChars: big.length })])),
			/longer than/,
		);
		await assert.rejects(
			read(scriptedCell([page({ content: big, offset: 0, complete: true })])),
			/longer than/,
			"even when the cell does not say its total",
		);
		await assert.rejects(
			read(
				scriptedCell([
					page({
						content: "abc",
						offset: 0,
						nextOffset: 3,
						complete: false,
						totalChars: MAX_DOCUMENT_READ_CHARS + 1,
					}),
				]),
			),
			/longer than/,
			"refused on the first page's word, before reading on",
		);
	});

	it("holds a page-count bound, so a cell that pages a character at a time cannot keep the host reading", async () => {
		const trickle = scriptedCell(
			[
				(args: Record<string, unknown>) => {
					const offset = Number(args.offset ?? 0);
					return {
						structuredContent: page({
							content: "x",
							offset,
							nextOffset: offset + 1,
							complete: false,
							totalChars: 100_000,
						}),
					};
				},
			],
			10_000,
		);
		await assert.rejects(read(trickle), /pages/);
		assert.ok(
			trickle.calls.length <= MAX_DOCUMENT_READ_CHARS / 65_536 + 1,
			`stopped after ${trickle.calls.length} pages`,
		);
	});

	it("keeps the document's identity, revision and total stable across pages", async () => {
		const first = page({ content: "abc", offset: 0, nextOffset: 3, complete: false, totalChars: 6 });
		for (const [label, second] of [
			[
				"another document",
				{ ...page({ content: "def", offset: 3, complete: true, totalChars: 6 }), document_id: "other" },
			],
			["a new revision", { ...page({ content: "def", offset: 3, complete: true, totalChars: 6 }), revision: 4 }],
			[
				"a revision that vanished",
				(() => {
					const p = page({ content: "def", offset: 3, complete: true, totalChars: 6 });
					delete (p as Record<string, unknown>).revision;
					return p;
				})(),
			],
			[
				"another graph",
				{ ...page({ content: "def", offset: 3, complete: true, totalChars: 6 }), graph_id: "elsewhere" },
			],
			["a total that changed", page({ content: "def", offset: 3, complete: true, totalChars: 7 })],
		] as const) {
			await assert.rejects(
				read(scriptedCell([first, second])),
				/changed|identity|revision|total|graph|document/,
				label,
			);
		}
	});

	it("refuses a last page that says complete short of the total, and an error in the middle of a document", async () => {
		await assert.rejects(
			read(scriptedCell([page({ content: "abc", offset: 0, complete: true, totalChars: 6 })])),
			/total|complete/,
		);
		const failing = scriptedCell([
			page({ content: "abc", offset: 0, nextOffset: 3, complete: false, totalChars: 6 }),
			() => ({ isError: true, content: [{ type: "text", text: "cell restarting" }] }),
		]);
		await assert.rejects(read(failing), /cell restarting|error/);
	});

	it("returns a cell's error answer to the first page as the error it is, for the caller to classify", async () => {
		const missing = scriptedCell([
			() => ({ isError: true, content: [{ type: "text", text: "document not found: doc" }] }),
		]);
		const answer = await read(missing);
		assert.equal((answer.raw as { isError?: boolean }).isError, true);
		assert.equal(answer.text, "document not found: doc");
	});
});

/**
 * Exam 2, finding D. A completed read must come from the cell that was asked, about the document that was asked, with
 * the total the cell counts. The replies below are the shape garden's `read_document` always sends since r20260807a
 * (`document_mcp_service.rs`: `graph_id`, `document_id`, `totalChars`, `offset`, `nextOffset`, `complete`; `revision`
 * since r20260807b, hours later the same day), so refusing their absence refuses no cell this host is released against.
 * `revision` stays optional because the cells between those two commits did not send it; it must still agree across
 * pages (above).
 */
describe("exam 2, D: a completed read must carry the cell's total and name the graph and document asked for", () => {
	const read = (cell: { proxy: HostedMnemosyneProxy }) => makeHostedGraphWriter(cell.proxy).readDocument(GRAPH, "doc");

	it("refuses a completed page that does not say how long the document is (the exam's first reply)", async () => {
		await assert.rejects(
			read(scriptedCell([{ content: "partial", offset: 0, complete: true }])),
			/totalChars|total|graph/,
			"no total, no revision, no identity",
		);
		await assert.rejects(
			read(scriptedCell([page({ content: "partial", offset: 0, complete: true })])),
			/totalChars|total/,
			"identity and revision, but no total",
		);
		await assert.rejects(
			read(scriptedCell([page({ content: "abc", offset: 0, nextOffset: 3, complete: false })])),
			/totalChars|total/,
			"an unfinished first page without a total",
		);
	});

	it("refuses a first page that names another graph than the one requested (the exam's second reply)", async () => {
		const wrong = await read(
			scriptedCell([
				{
					graph_id: "elsewhere",
					document_id: "doc",
					revision: 1,
					content: "abc",
					offset: 0,
					complete: true,
					totalChars: 3,
				},
			]),
		).then(
			(answer) => answer,
			(error: unknown) => error,
		);
		assert.ok(wrong instanceof Error, `read from the wrong graph: ${JSON.stringify(wrong)}`);
		assert.match(wrong.message, /graph/);
	});

	it("refuses a first page that names another document, or no graph or document at all", async () => {
		await assert.rejects(
			read(
				scriptedCell([
					{ ...page({ content: "abc", offset: 0, complete: true, totalChars: 3 }), document_id: "other" },
				]),
			),
			/document/,
		);
		const noGraph = page({ content: "abc", offset: 0, complete: true, totalChars: 3 });
		delete (noGraph as Record<string, unknown>).graph_id;
		await assert.rejects(read(scriptedCell([noGraph])), /graph/);
		const noDocument = page({ content: "abc", offset: 0, complete: true, totalChars: 3 });
		delete (noDocument as Record<string, unknown>).document_id;
		await assert.rejects(read(scriptedCell([noDocument])), /document/);
	});

	it("still reads garden's real reply whole, with or without a revision, and across pages", async () => {
		const real = {
			graph_id: GRAPH,
			document_id: "doc",
			title: "Doc",
			format: "markdown",
			content: "hello",
			fragment: false,
			offset: 0,
			nextOffset: null,
			complete: true,
			totalChars: 5,
			maxChars: 262_144,
			revision: 7,
			block_count: 1,
		};
		assert.equal((await read(scriptedCell([real]))).text, "hello");
		const { revision: _omitted, ...older } = real;
		assert.equal((await read(scriptedCell([older]))).text, "hello", "a cell older than r20260807b sends no revision");
		const paged = await read(
			scriptedCell([
				{ ...real, content: "hel", nextOffset: 3, complete: false, totalChars: 5, fragment: true },
				{ ...real, content: "lo", offset: 3, nextOffset: null, complete: true, totalChars: 5, fragment: true },
			]),
		);
		assert.equal(paged.text, "hello");
	});
});

describe("JSON documents are written as fenced code and read back exactly (the markdown-face rewrite)", () => {
	it("accepts any fence of three or more backticks, as garden fences one longer than the longest run inside", () => {
		assert.equal(unwrapAuthoredJsonDocument('```json\n{"a":1}\n```'), '{"a":1}');
		assert.equal(unwrapAuthoredJsonDocument('````json\n{"a":"```"}\n````'), '{"a":"```"}');
		assert.equal(unwrapAuthoredJsonDocument('`````JSON\n{"a":"````"}\n`````\n'), '{"a":"````"}');
		assert.equal(unwrapAuthoredJsonDocument('{"plain":true}'), '{"plain":true}');
		// A closer shorter than the opener is code, not the end of the fence.
		assert.equal(unwrapAuthoredJsonDocument('````json\n{"a":1}\n```'), '````json\n{"a":1}\n```');
	});

	it("fences JSON with one more backtick than its longest run, never fewer than three", () => {
		assert.equal(fencedJsonDocument('{"a":1}'), '```json\n{"a":1}\n```\n');
		assert.equal(fencedJsonDocument('{"a":"``` x"}'), '````json\n{"a":"``` x"}\n````\n');
	});

	it("writes JSON whose text would read as markdown (backtick pairs, **, an escaped quote) as a fenced block with format markdown, and rereads it byte for byte", async () => {
		const value = { prompt: "Use `read_document`, **never** guess.", quote: 'say "hi"', fence: "```" };
		const { proxy, calls, documents } = pagingCell();
		const writer = makeHostedGraphWriter(proxy);
		await writeJsonDocument(writer, GRAPH, "prompt-binding-phanes", value);
		const write = calls.find((call) => call.tool === "write_document");
		assert.ok(write);
		assert.equal(write.args.format, "markdown");
		const json = JSON.stringify(value, null, 2);
		assert.equal(write.args.content, fencedJsonDocument(json));
		assert.ok(String(documents.get("prompt-binding-phanes")).startsWith("````json\n"));
		assert.ok(
			calls.some((call) => call.tool === "read_document"),
			"the write is read back",
		);
		assert.deepEqual(JSON.parse(unwrapAuthoredJsonDocument(String(documents.get("prompt-binding-phanes")))), value);
		// The control: the same JSON written bare is changed by the cell's face, so the reread above holds by the fence.
		await writer.writeDocument(GRAPH, "bare", json);
		assert.notEqual(documents.get("bare"), json);
		await writer.writeDocument(GRAPH, "plain", json, { format: "plain" });
		assert.notEqual(documents.get("plain"), json);
	});

	it("refuses when the reread is not the JSON it wrote", async () => {
		const { proxy, documents } = pagingCell();
		const changing = {
			async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
				const inner = proxy as unknown as {
					callTool(tool: string, args: Record<string, unknown>): Promise<unknown>;
				};
				const result: unknown = await inner.callTool(tool, args);
				// The cell rewrote the text at write: the backslash of an escaped quote was consumed.
				if (tool === "write_document")
					documents.set(String(args.document_id), '```json\n{"quote": "say "hi""}\n```');
				return result;
			},
		};
		await assert.rejects(
			() =>
				writeJsonDocument(makeHostedGraphWriter(changing as unknown as HostedMnemosyneProxy), GRAPH, "x", {
					quote: 'say "hi"',
				}),
			(error: unknown) => error instanceof JsonDocumentWriteError && /read back/.test(error.message),
		);
	});

	it("passes an explicit format through writeDocument when one is given", async () => {
		const { proxy, calls } = pagingCell();
		const writer = makeHostedGraphWriter(proxy);
		await writer.writeDocument(GRAPH, "a", "plain text", { format: "plain" });
		await writer.writeDocument(GRAPH, "b", "# Heading");
		assert.equal(calls[0].args.format, "plain");
		assert.equal("format" in calls[1].args, false, "no format is still no format");
	});
});
