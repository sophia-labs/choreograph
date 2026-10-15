import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mirrorAgentSessionEvent } from "../agent-runtime/session-event-mirror.js";
import { toolCallTargets, toolResultTargets } from "../agent-runtime/tool-targets.js";
import type { BusEvent } from "../event-bus.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { WORKSPACE_CHAT_TOOL_FAMILIES } from "../workflow/workspace-chat-contract.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

/**
 * The durable Session record keeps a tool call's name and outcome, never its arguments or result (content-free
 * testimony). What the SPA's "Changed in this turn" strip needs is which objects a write touched: an id-only receipt
 * (`targets`), derived here from the call: ids, the kind of change, wire endpoints, the revision before and after where
 * the call or its result says, and a title only where a result names one. Never document text, artifact bytes, SPARQL,
 * comment bodies or any other content. Shrubbery reads it as `value.targets` on `tool.started` / `tool.completed`
 * (RETURN-spa-chat.md §5). Adapted from the SPA body's proposal (`proposed-mirror-targets.diff`, choreograph
 * the 2026-10-06 tool-targets proposal branch @ r20261006b).
 */
const semantic = makeTestAgentSemanticBinding({ graphId: "g1", kind: "prime", registeredName: "workspace" });
const spec: AgentNodeSpec = {
	label: "pilot-headed",
	phaseIndex: 0,
	prompt: "chat",
	model: "mock:done",
	graphId: "g1",
	sessionId: "ags-chat",
	...semantic,
};

function agentEvent(event: Record<string, unknown>): BusEvent {
	return {
		category: "agent",
		type: String(event.type),
		sandbox_id: "sb-1",
		ts: new Date(1000).toISOString(),
		event,
	} as unknown as BusEvent;
}

describe("tool targets: what a write touched, ids only", () => {
	it("names the documents, blocks, folders, artifacts and wires a write call touched, and the kind of change", () => {
		assert.deepEqual(
			toolCallTargets("write_document", {
				documentId: "plan",
				content: "secret words",
				title: "T",
				expectedRevision: 4,
			}),
			[{ kind: "document", id: "plan", change: "edited", revisionBefore: 4 }],
		);
		assert.deepEqual(
			toolCallTargets("edit_block_text", { documentId: "plan", blockId: "b7", operations: [{ insert: "x" }] }),
			[{ kind: "block", id: "b7", documentId: "plan", change: "edited" }],
		);
		assert.deepEqual(toolCallTargets("delete_blocks", { documentId: "plan", blockIds: ["b1", "b2"] }), [
			{ kind: "block", id: "b1", documentId: "plan", change: "removed" },
			{ kind: "block", id: "b2", documentId: "plan", change: "removed" },
		]);
		assert.deepEqual(toolCallTargets("delete_document", { documentId: "old" }), [
			{ kind: "document", id: "old", change: "deleted" },
		]);
		assert.deepEqual(toolCallTargets("delete", { type: "wires", wireIds: ["w1"] }), [
			{ kind: "wire", id: "w1", change: "deleted" },
		]);
		assert.deepEqual(toolCallTargets("move_documents", { documentIds: ["a", "b"], parentId: "f" }), [
			{ kind: "document", id: "a", change: "moved" },
			{ kind: "document", id: "b", change: "moved" },
		]);
		assert.deepEqual(toolCallTargets("rename", { entity_type: "folder", entity_id: "f1", new_name: "New" }), [
			{ kind: "folder", id: "f1", change: "renamed" },
		]);
		assert.deepEqual(
			toolCallTargets("create_artifact_text", {
				artifact_id: "board",
				mime_type: "text/html",
				filename: "b.html",
				text: "<p>secret</p>",
			}),
			[{ kind: "artifact", id: "board", mediaType: "text/html", change: "created" }],
		);
		assert.deepEqual(toolCallTargets("edit_comment", { action: "delete", document_id: "c1", comment_id: "k" }), [
			{ kind: "comment", id: "k", documentId: "c1", removed: true, change: "removed" },
		]);
	});

	it("names a wire's endpoints, document or block, and the wire itself when the call names it", () => {
		assert.deepEqual(toolCallTargets("create_wires", { wires: [{ sourceDocumentId: "s", targetDocumentId: "t" }] }), [
			{ kind: "document", id: "s", change: "linked", source: "s", target: "t" },
		]);
		assert.deepEqual(
			toolCallTargets("create_wires", {
				sourceDocumentId: "s",
				sourceBlockId: "b1",
				target_document_id: "t",
				target_block_id: "b2",
				wireId: "w-9",
				predicate: "secret predicate text",
			}),
			[{ kind: "wire", id: "w-9", change: "linked", source: "s#b1", target: "t#b2" }],
		);
	});

	it("names nothing for a read, and nothing that is not id-shaped", () => {
		assert.deepEqual(toolCallTargets("read_document", { documentId: "plan" }), []);
		assert.deepEqual(toolCallTargets("sparql_query", { query: "SELECT * WHERE { ?s ?p ?o }" }), []);
		assert.deepEqual(toolCallTargets("write_document", { documentId: "R1 root note" }), []);
		assert.deepEqual(toolCallTargets("write_document", "not an object" as unknown as Record<string, unknown>), []);
	});

	it("names from a result what only the result can say: a new object, its title, the revision after", () => {
		assert.deepEqual(
			toolResultTargets("create_document", JSON.stringify({ documentId: "fresh-1", title: "Fresh" })),
			[{ kind: "document", id: "fresh-1", change: "created", title: "Fresh" }],
		);
		assert.deepEqual(
			toolResultTargets("write_document", JSON.stringify({ document_id: "plan", revision: 5, content: "body" })),
			[{ kind: "document", id: "plan", change: "edited", revisionAfter: 5 }],
		);
		// A title that is not one line of at most 200 characters is left out, never cut or kept.
		assert.deepEqual(
			toolResultTargets("create_document", JSON.stringify({ documentId: "f2", title: `two\nlines` })),
			[{ kind: "document", id: "f2", change: "created" }],
		);
		assert.deepEqual(
			toolResultTargets("create_document", JSON.stringify({ documentId: "f3", title: "x".repeat(201) })),
			[{ kind: "document", id: "f3", change: "created" }],
		);
		assert.deepEqual(toolResultTargets("create_document", "Created."), []);
		assert.deepEqual(toolResultTargets("read_document", JSON.stringify({ documentId: "x" })), []);
	});

	it("rides the mirrored tool events, and leaves every other event and every read as it was", () => {
		const started = mirrorAgentSessionEvent(
			agentEvent({ type: "tool_call", gate: "write_document", args: { documentId: "plan", content: "secret" } }),
			spec,
		);
		assert.deepEqual(started?.payload.value, {
			tool: "write_document",
			targets: [{ kind: "document", id: "plan", change: "edited" }],
		});
		assert.doesNotMatch(JSON.stringify(started), /secret/);

		const completed = mirrorAgentSessionEvent(
			agentEvent({
				type: "tool_result",
				gate: "create_document",
				result: JSON.stringify({ documentId: "n1", title: "Plan", content: "Private body" }),
				is_error: false,
			}),
			spec,
		);
		assert.deepEqual(completed?.payload.value, {
			tool: "create_document",
			isError: false,
			targets: [{ kind: "document", id: "n1", change: "created", title: "Plan" }],
		});
		assert.doesNotMatch(JSON.stringify(completed), /Private body/);

		const read = mirrorAgentSessionEvent(
			agentEvent({ type: "tool_call", gate: "read_document", args: { documentId: "plan" } }),
			spec,
		);
		assert.deepEqual(read?.payload.value, { tool: "read_document" });
	});
});

/**
 * The lead's guard: the mirror keeps targets only. Every Writer tool is called with a sentinel in every argument that
 * is not an id (text, operations, edits, blocks, comment bodies, CSS, names, titles, predicates, quoted text), and every
 * tool answers with the sentinel in every content field of its result. The sentinel must never reach a durable event,
 * and the ids must (so this guard cannot pass by mirroring nothing, as r20261006a did).
 */
describe("the guard: content never reaches the mirror, ids do", () => {
	const SENTINEL = "SENTINEL-CONTENT-7f3a";
	const contentArgs = {
		content: SENTINEL,
		text: SENTINEL,
		title: SENTINEL,
		name: SENTINEL,
		new_name: SENTINEL,
		newName: SENTINEL,
		filename: `${SENTINEL}.html`,
		operations: [{ insert: SENTINEL }],
		edits: [{ blockId: "b1", text: SENTINEL }],
		blocks: [{ type: "paragraph", text: SENTINEL }],
		tiptapJson: { type: "doc", content: [{ type: "text", text: SENTINEL }] },
		cssText: SENTINEL,
		quotedText: SENTINEL,
		find: SENTINEL,
		author: SENTINEL,
		predicate: SENTINEL,
		tags: [SENTINEL],
		query: `SELECT ?s WHERE { ?s ?p "${SENTINEL}" }`,
		update: `INSERT DATA { <a> <b> "${SENTINEL}" }`,
	};
	const ids = {
		documentId: "doc-1",
		document_id: "doc-1",
		blockId: "b1",
		blockIds: ["b1"],
		comment_id: "k1",
		folderId: "f1",
		folder_id: "f1",
		documentIds: ["doc-1"],
		entity_type: "document",
		entity_id: "doc-1",
		artifact_id: "art-1",
		mime_type: "text/html",
		sourceDocumentId: "doc-1",
		targetDocumentId: "doc-2",
		type: "wire",
		wireIds: ["w1"],
		expectedRevision: 2,
	};
	const result = JSON.stringify({
		documentId: "doc-1",
		folderId: "f1",
		revision: 3,
		content: SENTINEL,
		text: SENTINEL,
		markdown: SENTINEL,
		body: SENTINEL,
		snippet: SENTINEL,
		blocks: [{ id: "b1", text: SENTINEL }],
		message: SENTINEL,
	});

	const writerTools = [...new Set(WORKSPACE_CHAT_TOOL_FAMILIES.flatMap((family) => family.write))];
	const readerTools = [...new Set(WORKSPACE_CHAT_TOOL_FAMILIES.flatMap((family) => family.read))];

	it("keeps no argument or result content of any workspace chat tool, and names the ids of every write", () => {
		for (const tool of [...writerTools, ...readerTools, "sparql_update", "rdf_load"]) {
			const started = mirrorAgentSessionEvent(
				agentEvent({ type: "tool_call", gate: tool, args: { ...contentArgs, ...ids } }),
				spec,
			);
			const completed = mirrorAgentSessionEvent(
				agentEvent({ type: "tool_result", gate: tool, result, is_error: false }),
				spec,
			);
			for (const [label, event] of [
				["started", started],
				["completed", completed],
			] as const) {
				assert.ok(event, `${tool} ${label} is mirrored`);
				assert.ok(
					!JSON.stringify(event).includes(SENTINEL),
					`${tool} ${label} carries content: ${JSON.stringify(event)}`,
				);
			}
			if (writerTools.includes(tool) && tool !== "custom_css") {
				const targets = (started?.payload.value as { targets?: unknown[] }).targets ?? [];
				assert.ok(targets.length > 0, `${tool} names what it touched`);
			}
		}
	});
});
