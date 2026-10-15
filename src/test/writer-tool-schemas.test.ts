/**
 * The Writer's tools as the model is handed them: the schemas the host advertises must accept the arguments the model
 * can send.
 *
 * Live, 2026-10-07 (session `ags_0863a3e56ec5d02f599e`, Choreograph r20261006c): the chat's `write_document` failed and
 * never reached the host. garden's `write_document` schema requires a graph selector through
 * `allOf: [{anyOf: [{required: ["graph_id"]}, {required: ["graphId"]}]}, …]`; the host binds the graph itself (it strips
 * a caller's selector), the worker removes `graph_id`/`graphId` from `properties` and closes the object
 * (`additionalProperties: false`, sophia-agent `host-tools.ts` `exposedSchema`), and nobody touched the `allOf`. The
 * schema the model was handed could not be satisfied: without a selector the `anyOf` fails, with one the closed object
 * does, and the worker's validator refused every call before it reached the gate.
 *
 * This test serves garden's real schemas (`fixtures/garden-writer-tool-schemas-r20261006g.json`) from a real MCP cell,
 * reads them through the host's real chain (hosted proxy, mode gate, grant gate), and validates the model's arguments the
 * way the worker does: graph-free, against the closed object.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { Ajv } from "ajv";
import { applyHostCapabilityGrantPolicy } from "../capabilities/grant-gate.js";
import { type CapabilityBackend, HostedMnemosyneProxy, wrapMnemosyneProxy } from "../mnemosyne.js";
import { WORKSPACE_WRITER_TOOLS, workspaceWriterFence } from "../workflow/workspace-chat.js";
import { GardenDocumentCell } from "./garden-document-cell.js";

const GRAPH = "hoja-qa";
const fixture = JSON.parse(
	readFileSync(new URL("./fixtures/garden-writer-tool-schemas-r20261006g.json", import.meta.url), "utf8"),
) as { tools: Array<{ name: string; requiredScopes: string[]; inputSchema: Record<string, unknown> }> };

/** The worker's view of an advertised schema: graph selectors are never the model's, and the object is closed. */
function asTheWorkerHandsIt(schema: Record<string, unknown>): Record<string, unknown> {
	const properties = { ...((schema.properties as Record<string, unknown> | undefined) ?? {}) };
	delete properties.graph_id;
	delete properties.graphId;
	const required = Array.isArray(schema.required)
		? schema.required.filter((key) => key !== "graph_id" && key !== "graphId")
		: undefined;
	return {
		...schema,
		properties,
		...(required ? { required } : {}),
		additionalProperties: schema.additionalProperties ?? false,
	};
}

describe("the Writer's advertised tool schemas (garden's real ones, through the host chain)", () => {
	let cell: GardenDocumentCell;
	let proxy: HostedMnemosyneProxy;
	let gated: CapabilityBackend;

	before(async () => {
		cell = new GardenDocumentCell();
		cell.tools = fixture.tools.map((tool) => ({
			name: tool.name,
			scopes: tool.requiredScopes,
			inputSchema: tool.inputSchema,
		}));
		await cell.start();
		proxy = new HostedMnemosyneProxy({
			apiBaseUrl: cell.url,
			graphId: GRAPH,
			toolProfile: "full",
			fetchFn: async (input) => {
				throw new Error(`direct MCP must not call a control plane: ${String(input)}`);
			},
			directMcp: { mcpUrl: cell.url, accessToken: "cell-token", userId: "owner-1" },
		});
		await proxy.start();
		const fence = workspaceWriterFence(GRAPH);
		gated = applyHostCapabilityGrantPolicy(
			new Map([["mnemosyne", wrapMnemosyneProxy(proxy, { reads: true, writes: true, dangerous_ops: false })]]),
			{ exactTools: { mnemosyne: [...fence.mode.allowsTool] }, mode: fence },
		).get("mnemosyne")!;
	});

	after(async () => {
		await proxy.close();
		await cell.stop();
	});

	it("write_document accepts a document id, markdown content and its format, and the write reaches the cell", async () => {
		const tools = await gated.listTools();
		const write = tools.find((tool) => tool.name === "write_document");
		assert.ok(write?.inputSchema, "the Writer is handed write_document with its schema");
		const validate = new Ajv({ strict: false, allErrors: true }).compile(asTheWorkerHandsIt(write.inputSchema));
		// The live e2e's request, as a model sends it: no graph selector (the host binds the graph).
		const args = {
			documentId: "train3-e2e-writer",
			format: "markdown",
			content: "Train 3 release check: this document exists only to be deleted again.",
		};
		assert.ok(validate(args), `the model's write_document arguments are refused: ${JSON.stringify(validate.errors)}`);
		assert.ok(validate({ documentId: "d1", content: "x", expectedRevision: 3 }), JSON.stringify(validate.errors));
		// The schema still means what garden means: a document and its content are required.
		assert.equal(validate({ content: "no document" }), false);
		assert.equal(validate({ documentId: "d1" }), false);

		await gated.callTool("write_document", args);
		assert.equal(cell.documents.get("train3-e2e-writer"), args.content);
		const call = cell.calls.find((entry) => entry.tool === "write_document");
		assert.equal(call?.args.graphId, GRAPH, "the host names the bound graph to the cell");
	});

	it("every Writer tool's advertised schema names no graph selector the model could not send", async () => {
		const tools = await gated.listTools();
		assert.deepEqual(tools.map((tool) => tool.name).sort(), [...WORKSPACE_WRITER_TOOLS].sort());
		const ajv = new Ajv({ strict: false, allErrors: true });
		for (const tool of tools) {
			const text = JSON.stringify(tool.inputSchema ?? {});
			assert.doesNotMatch(text, /"graph_?[iI]d"/, `${tool.name} still advertises a graph selector`);
			ajv.compile(asTheWorkerHandsIt(tool.inputSchema ?? {}));
		}
	});
});
