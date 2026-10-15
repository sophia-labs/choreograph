/**
 * Exam 1, `contextRefs`: the host checked only that a reference was id-shaped before telling the model "open in the
 * person's view". `contextRefs: ["someone-elses-doc"]` became the host's assertion, and "this document". Now each ref is
 * admitted only when the bound graph answers a read of it as the person (the session's own mode-gated backend on a
 * follow-up; the run's graph proxy on the first turn): a document the graph does not have, or the person may not read,
 * or a block that is not there, is dropped, and with no way to check, nothing is named.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { parsePrimeHostBridgeMessage } from "../agent-runtime/host-protocol.js";
import { admitTurnContextRefs, type TurnContextRefReader } from "../agent-runtime/turn-context.js";
import type { CapabilityBackend } from "../mnemosyne.js";
import type { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";

const NOTE = (ids: string) => `\n\n(Open in the person's view, by id: ${ids}. "This document" means the first.)`;
const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const missing = (message: string) => ({ isError: true, content: [{ type: "text", text: message }] });

/** A graph as the person may read it: documents and their blocks; anything else answers as garden does, an error. */
function graphAsPerson(documents: Record<string, readonly string[]>) {
	const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	const read: TurnContextRefReader = async (tool, args) => {
		calls.push({ tool, args });
		const documentId = String(args.document_id ?? args.documentId);
		const blocks = documents[documentId];
		if (!blocks) return missing(`document not found: ${documentId}`);
		if (tool === "read_document") return text({ document_id: documentId, block_ids: blocks.slice(0, 1) });
		if (tool === "get_block") {
			const blockId = String(args.blockId);
			return blocks.includes(blockId)
				? text({ document_id: documentId, block_id: blockId })
				: missing(`block not found: ${blockId}`);
		}
		throw new Error(`unexpected tool ${tool}`);
	};
	return { read, calls };
}

describe("exam 1: a context ref is named to the model only when the bound graph answers it for the person", () => {
	it("keeps refs the graph answers, in order, and drops a document it does not have and a block that is not there", async () => {
		const { read } = graphAsPerson({ "q3-plan": ["b1"], notes: ["b7"] });
		assert.deepEqual(
			await admitTurnContextRefs(["q3-plan", "someone-elses-doc", "notes#b7", "notes#gone", "free text"], read),
			["q3-plan", "notes#b7"],
		);
	});

	it("drops a ref whose read fails or answers for another document, and names nothing when it cannot check", async () => {
		const throwing: TurnContextRefReader = async () => {
			throw new Error("cell unavailable");
		};
		assert.deepEqual(await admitTurnContextRefs(["q3-plan"], throwing), []);
		const elsewhere: TurnContextRefReader = async () => text({ document_id: "another-doc" });
		assert.deepEqual(await admitTurnContextRefs(["q3-plan"], elsewhere), []);
		assert.deepEqual(await admitTurnContextRefs(["q3-plan"], undefined), []);
		assert.deepEqual(await admitTurnContextRefs(undefined, graphAsPerson({ "q3-plan": [] }).read), []);
	});

	it("reads at most the eight refs the model could be told, each once", async () => {
		const ids = Array.from({ length: 12 }, (_, index) => `doc-${index}`);
		const { read, calls } = graphAsPerson(Object.fromEntries(ids.map((id) => [id, []])));
		assert.deepEqual(await admitTurnContextRefs([...ids, "doc-0"], read), ids.slice(0, 8));
		assert.equal(calls.length, 8);
	});
});

/**
 * Exam 2, finding E. Refusals, errors, throws and answers naming another document were dropped, but an answer that named
 * NO document was admitted: `{content: [{type: "text", text: "not a document answer"}]}` made `missing` "open in the
 * person's view". A ref is admitted only on affirmative evidence: a parsed answer that names that document (and, for
 * `doc#block`, that block).
 */
describe("exam 2, E: a context ref is admitted only on an answer that names it", () => {
	const answering =
		(answer: unknown): TurnContextRefReader =>
		async () =>
			answer;

	it("refuses a text answer that is not a document answer (the exam's case), and an answer that names nothing", async () => {
		const prose = { content: [{ type: "text", text: "not a document answer" }] };
		assert.deepEqual(await admitTurnContextRefs(["missing"], answering(prose)), []);
		assert.deepEqual(await admitTurnContextRefs(["missing"], answering({})), []);
		assert.deepEqual(await admitTurnContextRefs(["missing"], answering({ content: [] })), []);
		assert.deepEqual(await admitTurnContextRefs(["missing"], answering(text({ block_ids: [] }))), []);
		assert.deepEqual(await admitTurnContextRefs(["missing"], answering(text({ document_id: 7 }))), []);
		assert.deepEqual(
			await admitTurnContextRefs(["missing"], answering({ content: [{ type: "text", text: "{broken" }] })),
			[],
		);
		assert.deepEqual(await admitTurnContextRefs(["missing"], answering("ok")), []);
	});

	it("admits a document on an answer naming it, in either spelling, as garden's structured or text answer", async () => {
		assert.deepEqual(await admitTurnContextRefs(["q3-plan"], answering(text({ document_id: "q3-plan" }))), [
			"q3-plan",
		]);
		assert.deepEqual(await admitTurnContextRefs(["q3-plan"], answering(text({ documentId: "q3-plan" }))), [
			"q3-plan",
		]);
		assert.deepEqual(
			await admitTurnContextRefs(["q3-plan"], answering({ structuredContent: { document_id: "q3-plan" } })),
			["q3-plan"],
		);
	});

	it("admits a block only on an answer naming its document and the block, as garden's get_block does", async () => {
		const gardenBlock = (documentId: string, blockId: string) =>
			text({ graph_id: "g1", document_id: documentId, block: { id: blockId, index: 0 } });
		assert.deepEqual(await admitTurnContextRefs(["notes#b7"], answering(gardenBlock("notes", "b7"))), ["notes#b7"]);
		assert.deepEqual(
			await admitTurnContextRefs(["notes#b7"], answering(gardenBlock("notes", "b9"))),
			[],
			"another block",
		);
		assert.deepEqual(
			await admitTurnContextRefs(["notes#b7"], answering(text({ document_id: "notes" }))),
			[],
			"no block named",
		);
		assert.deepEqual(
			await admitTurnContextRefs(["notes#b7"], answering(gardenBlock("other", "b7"))),
			[],
			"another document",
		);
	});
});

describe("exam 1: a follow-up's refs are checked with the session's own authority before the note is written", () => {
	const stubStore = { get: () => undefined } as unknown as SandboxStore;

	function body(spawner: SandboxSpawner, backend?: CapabilityBackend) {
		const stdin = new PassThrough();
		let written = "";
		stdin.on("data", (chunk: Buffer) => {
			written += chunk.toString("utf8");
		});
		const active = {
			record: { sandbox_id: "sbx-adm", template: "agent", state: "running" },
			process: { stdin },
			isAgentRun: true,
			nextHostCommandId: 0,
			agentRequest: { spawn_id: "sbx-adm", session_id: "ags-adm", generation: 1, invocation_id: "act-1" },
			...(backend ? { capabilityRegistry: new Map([["mnemosyne", backend]]) } : {}),
		};
		(spawner as unknown as { active: Map<string, unknown> }).active.set("sbx-adm", active);
		(spawner as unknown as { workflowRuntime: unknown }).workflowRuntime = {
			async claimAgentSessionCommandsForDelivery() {
				return [
					{
						command_id: "cmd-adm",
						session_id: "ags-adm",
						idempotency_key: "cmd-adm",
						command_digest: `sha256:${"a".repeat(64)}`,
						name: "follow_up",
						payload: {
							text: "Summarize this document",
							contextRefs: ["someone-elses-doc", "q3-plan", "notes#gone"],
						},
						client_id: "spa-1",
						target_generation: 1,
						delivery_generation: 1,
						state: "delivered",
						error: null,
						submitted_at: 42,
						delivered_at: 43,
						completed_at: null,
					},
				];
			},
			async releaseAgentSessionCommandDelivery() {},
		};
		return () =>
			written
				.split("\n")
				.filter(Boolean)
				.map((line) => parsePrimeHostBridgeMessage(JSON.parse(line)) as { payload: Record<string, unknown> });
	}

	it("names only what the session's graph answers for the person", async () => {
		const spawner = new SandboxSpawner(stubStore, {
			parentPath: "local-native",
			managerPath: "local-native",
			controllers: [],
		});
		const { read, calls } = graphAsPerson({ "q3-plan": ["b1"], notes: ["b7"] });
		const backend: CapabilityBackend = {
			capabilityName: "mnemosyne",
			accessLevel: "ro",
			callTool: (tool, args) => read(tool, args),
			listTools: async () => [],
			close: async () => {},
		};
		const messages = body(spawner, backend);
		await spawner.drainAgentSessionCommands("sbx-adm");
		assert.deepEqual(messages()[0]?.payload, { text: `Summarize this document${NOTE("`q3-plan`")}` });
		assert.ok(calls.length >= 3, "each candidate was read through the session's backend");
	});

	it("names nothing when the session has no graph backend to check with", async () => {
		const spawner = new SandboxSpawner(stubStore, {
			parentPath: "local-native",
			managerPath: "local-native",
			controllers: [],
		});
		const messages = body(spawner);
		await spawner.drainAgentSessionCommands("sbx-adm");
		assert.deepEqual(messages()[0]?.payload, { text: "Summarize this document" });
	});
});
