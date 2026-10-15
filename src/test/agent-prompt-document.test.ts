import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	AGENT_PROMPT_BINDING_SCHEMA,
	buildAgentPromptBinding,
	buildAgentPromptSnapshot,
	PromptGraphError,
	promoteAgentPromptBinding,
	resolveAgentPromptBindingStrict,
} from "../workflow/agent-prompt-document.js";
import { documentUri, type GraphDocumentRead, type GraphWriter } from "../workflow/graph-writer.js";
import { gardenDocumentFace } from "./markdown-face-fixture.js";

class MemoryGraph implements GraphWriter {
	readonly documents = new Map<string, { text: string; revision: number }>();
	readonly writeFormats: Array<string | undefined> = [];

	async sparqlUpdate(): Promise<void> {}
	async sparqlQuery(): Promise<unknown> {
		return {};
	}
	async searchDocuments(): Promise<[]> {
		return [];
	}
	async readDocument(graphId: string, documentId: string): Promise<GraphDocumentRead> {
		const row = this.documents.get(documentId);
		if (!row) throw new Error(`not found: ${documentId}`);
		return {
			graphId,
			documentId,
			documentUri: documentUri(documentId),
			format: "markdown",
			text: row.text,
			blocks: [],
			revision: row.revision,
			changeId: `chg-${row.revision}`,
			raw: row,
		};
	}
	async writeDocument(
		_graphId: string,
		documentId: string,
		content: string,
		options?: { format?: string },
	): Promise<unknown> {
		this.writeFormats.push(options?.format);
		const previous = this.documents.get(documentId);
		// The cell keeps what its document face keeps, not what was sent (exam 1, section 4).
		this.documents.set(documentId, {
			text: gardenDocumentFace(content, options?.format),
			revision: (previous?.revision ?? 0) + 1,
		});
		return {};
	}
}

describe("graph-resident agent prompt bindings", () => {
	it("publishes a binding as a fenced JSON block written as markdown, so the cell keeps its text exactly", async () => {
		const graph = new MemoryGraph();
		graph.documents.set("prompt-phanes", {
			text: 'You are Phanes. Use `read_document`, **never** guess, and quote \\"exactly\\".',
			revision: 1,
		});
		const promoted = await promoteAgentPromptBinding({
			graph,
			graphId: "phanes",
			promptDocumentId: "prompt-phanes",
			bindingDocumentId: "prompt-binding-phanes",
			registeredName: "Phanes",
			provider: "openrouter",
			model: "thinkingmachines/inkling",
			promotedBy: "user:ada",
			now: 100,
		});
		const stored = graph.documents.get("prompt-binding-phanes")!.text;
		assert.match(stored, /^```json\n/);
		assert.deepEqual(graph.writeFormats, ["markdown"]);
		const resolved = await resolveAgentPromptBindingStrict({
			graph,
			graphId: "phanes",
			bindingDocumentId: "prompt-binding-phanes",
			expectedRegisteredName: "Phanes",
			now: 150,
		});
		assert.equal(resolved.binding.bindingId, promoted.bindingId);
		// The prompt as the cell holds it, backslashes and all, travelled through the binding unchanged.
		assert.equal(resolved.systemPrompt, graph.documents.get("prompt-phanes")!.text);
		// The control: the same binding written bare, as it was before the fence, does not survive this cell's face (the
		// escaped quotes of the prompt lose their backslash), so the test above holds because of the fence.
		const bare = JSON.stringify(JSON.parse(stored.replace(/^`+json\n|\n`+\n?$/g, "")), null, 2);
		await graph.writeDocument("phanes", "bare-binding", bare);
		assert.notEqual(graph.documents.get("bare-binding")!.text, bare);
		assert.throws(() => assert.deepEqual(JSON.parse(graph.documents.get("bare-binding")!.text), JSON.parse(bare)));
	});

	it("snapshots the current Garden text for each fresh session resolution", async () => {
		const graph = new MemoryGraph();
		graph.documents.set("prompt-phanes", { text: "You are Phanes. Attend carefully.", revision: 1 });
		const promoted = await promoteAgentPromptBinding({
			graph,
			graphId: "phanes",
			promptDocumentId: "prompt-phanes",
			bindingDocumentId: "prompt-binding-phanes",
			registeredName: "Phanes",
			provider: "openrouter",
			model: "thinkingmachines/inkling",
			promotedBy: "user:ada",
			now: 100,
		});
		assert.equal(promoted.schema, AGENT_PROMPT_BINDING_SCHEMA);

		const first = await resolveAgentPromptBindingStrict({
			graph,
			graphId: "phanes",
			bindingDocumentId: "prompt-binding-phanes",
			expectedRegisteredName: "Phanes",
			now: 150,
		});
		graph.documents.set("prompt-phanes", { text: "You are Phanes. This is the current Garden text.", revision: 2 });
		const resolved = await resolveAgentPromptBindingStrict({
			graph,
			graphId: "phanes",
			bindingDocumentId: "prompt-binding-phanes",
			expectedRegisteredName: "Phanes",
			now: 200,
		});

		assert.equal(resolved.dirty, true);
		assert.equal(first.systemPrompt, "You are Phanes. Attend carefully.");
		assert.equal(resolved.systemPrompt, "You are Phanes. This is the current Garden text.");
		assert.equal(resolved.currentSnapshot.renderedText, "You are Phanes. This is the current Garden text.");
		assert.equal(resolved.executionBinding.snapshot, resolved.currentSnapshot);
		assert.notEqual(resolved.executionBinding.bindingId, resolved.binding.bindingId);
		assert.equal(first.systemPrompt, "You are Phanes. Attend carefully.");
	});

	it("keeps registered identity stable across prompt and model promotion", () => {
		const document = (text: string, revision: number): GraphDocumentRead => ({
			graphId: "shrubbery-domain",
			documentId: "prompt-shrub-1",
			documentUri: documentUri("prompt-shrub-1"),
			format: "markdown",
			text,
			blocks: [],
			revision,
			changeId: `chg-${revision}`,
			raw: {},
		});
		const first = buildAgentPromptBinding({
			registeredName: "shrub-1",
			provider: "openrouter",
			model: "thinkingmachines/inkling",
			snapshot: buildAgentPromptSnapshot(document("first", 1), 10),
			promotedBy: "user:steward",
		});
		const second = buildAgentPromptBinding({
			registeredName: "shrub-1",
			provider: "openrouter",
			model: "thinkingmachines/inkling-next",
			snapshot: buildAgentPromptSnapshot(document("second", 2), 20),
			promotedBy: "user:steward",
		});
		assert.equal(first.agentId, second.agentId);
		assert.equal(first.agentUri, second.agentUri);
		assert.notEqual(first.bindingId, second.bindingId);
	});

	it("fails closed when the binding graph cannot be read", async () => {
		const graph = new MemoryGraph();
		await assert.rejects(
			resolveAgentPromptBindingStrict({
				graph,
				graphId: "phanes",
				bindingDocumentId: "missing-binding",
			}),
			(error: unknown) =>
				error instanceof PromptGraphError &&
				error.code === "graph_unavailable" &&
				error.documentId === "missing-binding",
		);
	});
});
