import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import * as Y from "yjs";
import { createSandboxEventBus } from "../event-bus.js";
import { GardenNotebookRunClaims } from "../notebooks/claims.js";
import type { DevelopmentGarden } from "../notebooks/garden.js";
import { callNotebookTool, notebookTools } from "../notebooks/mcp.js";
import {
	cellSourceVersion,
	exportIpynb,
	installMetadata,
	parseIpynb,
	readNotebook,
	replaceSource,
	tiptapJson,
} from "../notebooks/model.js";
import { HostedNotebookService, notebookBinding } from "../notebooks/service.js";
import { HostedNotebookWorkspace, type NotebookWorkspace } from "../notebooks/workspace.js";
import type { SandboxStore } from "../sandbox-store.js";
import type { SandboxSpawner } from "../spawner.js";

test("gateway minted graph and subject are required for hosted notebooks", () => {
	const headers = { "x-graph-owner": "user:owner", "x-graph-id": "notes", "x-user-id": "editor" };
	assert.deepEqual(notebookBinding(headers, true), { graphOwner: "user:owner", graphId: "notes", userId: "editor" });
	assert.throws(() => notebookBinding(headers, false), /gateway service authentication/);
	assert.throws(() => notebookBinding({ ...headers, "x-graph-owner": "user:../owner" }, true), /graph owner/);
	assert.throws(() => notebookBinding({ ...headers, "x-graph-id": "other/graph" }, true), /graph binding/);
});

test("hosted tool catalog is mode scoped and rejects a different graph", async () => {
	const workspace = {
		options: { garden: { graphId: "notes" } },
		supportedNotebookKernels: () => ["python3"],
	} as unknown as NotebookWorkspace;
	assert.deepEqual(
		((await callNotebookTool(workspace, "capabilities", { graphId: "notes" })) as { kernels: string[] }).kernels,
		["python3"],
	);
	await assert.rejects(callNotebookTool(workspace, "capabilities", { graphId: "other" }), /bound Garden graph/);
	assert.deepEqual(notebookTools.find((tool) => tool.name === "execute")?._meta["sophia.local.requiredScopes"], [
		"notebooks.execute",
	]);
	assert.deepEqual(notebookTools.find((tool) => tool.name === "read")?._meta["sophia.local.requiredScopes"], [
		"documents.read",
	]);
});

test("hosted notebook JSON-RPC serves a namespacable catalog and refuses an unbound tool call", async () => {
	const service = new HostedNotebookService(
		{} as SandboxSpawner,
		{} as SandboxStore,
		{} as ReturnType<typeof createSandboxEventBus>,
	);
	const server = createServer((request, response) => {
		void service.handle(request, response, { graphOwner: "user:owner", graphId: "notes", userId: "editor" });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const url = `http://127.0.0.1:${address.port}`;
	try {
		type RpcResponse = { result: { tools?: { name: string }[]; isError?: boolean; content?: { text: string }[] } };
		const post = async (method: string, params?: unknown) => {
			const response = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
			});
			assert.equal(response.status, 200);
			return response.json() as Promise<RpcResponse>;
		};
		const listed = await post("tools/list");
		assert.ok(listed.result.tools?.some((tool) => tool.name === "execute"));
		const refused = await post("tools/call", {
			name: "read",
			arguments: { graphId: "other", documentId: "notebook-one" },
		});
		assert.equal(refused.result.isError, true);
		assert.match(refused.result.content?.[0].text ?? "", /graphId differs/);
	} finally {
		await service.close();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("hosted notebook shares Garden cell IDs, source versions and nbformat metadata", () => {
	const original = parseIpynb(
		JSON.stringify({
			nbformat: 4,
			nbformat_minor: 2,
			metadata: { kernelspec: { name: "python3" }, custom: { retained: true } },
			cells: [
				{
					id: "code-a",
					cell_type: "code",
					source: "print(5)",
					metadata: { tags: ["proof"] },
					outputs: [],
					execution_count: null,
				},
			],
		}),
	);
	const doc = new Y.Doc();
	for (const block of tiptapJson(original).content as Array<{
		attrs: Record<string, string>;
		content: Array<{ text: string }>;
	}>) {
		const element = new Y.XmlElement("codeBlock"),
			source = new Y.XmlText();
		for (const [key, value] of Object.entries(block.attrs)) element.setAttribute(key, value);
		source.insert(0, block.content[0].text);
		element.insert(0, [source]);
		doc.getXmlFragment("content").insert(doc.getXmlFragment("content").length, [element]);
	}
	installMetadata(doc, original);
	const read = readNotebook(doc);
	const version = cellSourceVersion(read.cells[0], read.header);
	replaceSource(doc, "code-a", "print(8)", version);
	assert.throws(() => replaceSource(doc, "code-a", "stale", version), /version conflict/);
	const exported = JSON.parse(exportIpynb(readNotebook(doc)));
	assert.equal(exported.cells[0].id, "code-a");
	assert.equal(exported.cells[0].source, "print(8)");
	assert.deepEqual(exported.metadata.custom, { retained: true });
});

test("Garden run receipt creation is the exclusive, durable claim", async () => {
	let sent: Record<string, unknown> = {};
	const garden = {
		graphId: "notes",
		async call(name: string, args: Record<string, unknown>, timeoutMs: number) {
			assert.equal(name, "create_document_once");
			assert.equal(timeoutMs, 5 * 60_000);
			sent = args;
			return { outcome: "created", durabilityChecked: true, durability: "published" };
		},
	} as unknown as DevelopmentGarden;
	const claims = new GardenNotebookRunClaims(garden);
	assert.equal(await claims.claim("notebook-run-one", "exec-one", '{"status":"pending"}'), true);
	assert.equal(sent.graph_id, "notes");
	assert.equal(sent.document_id, "notebook-run-one");
	assert.equal(sent.requireDurable, true);
	assert.equal(sent.awaitDurable, true);
	assert.equal(
		(sent.tiptapJson as { content: Array<{ content: Array<{ text: string }> }> }).content[0].content[0].text,
		'{"status":"pending"}',
	);
	const pending = new GardenNotebookRunClaims({
		graphId: "notes",
		async call() {
			return { outcome: "created", durabilityChecked: false, durability: "pending" };
		},
	} as unknown as DevelopmentGarden);
	await assert.rejects(pending.claim("notebook-run-one", "exec-one", "{}"), /did not confirm durable/);
	const rejected = new GardenNotebookRunClaims({
		graphId: "notes",
		async call() {
			throw new Error("create_document_once refused: prior admission exists");
		},
	} as unknown as DevelopmentGarden);
	assert.equal(await rejected.claim("notebook-run-one", "exec-one", "{}"), false);
});

test("hosted execution persists a Garden result and never replays the same execution ID", async () => {
	let receipt: Record<string, unknown> | undefined;
	let version = 0;
	let spawns = 0;
	let input = 0;
	let claimAllowed = true;
	let runDocumentId: string | undefined;
	const garden = {
		graphId: "notes",
		async call(name: string, args?: { direction?: string }) {
			if (name === "read_document" && !receipt) throw new Error("not found");
			if (name === "get_wires")
				return {
					wires: args?.direction === "incoming" && runDocumentId ? [{ sourceDocumentId: runDocumentId }] : [],
				};
			return {};
		},
		async notebookCell() {
			return {
				documentId: "notebook-one",
				cellId: "cell-one",
				source: "2 + 3",
				sourceVersion: "source-v1",
				documentVersion: "doc-v1",
				kernel: "python3" as const,
			};
		},
		async flush() {},
		async snapshot() {
			return { version: `v${version}`, blocks: [{ text: JSON.stringify(receipt) }] };
		},
		async edit(_id: string, _block: string, source: string, expected: string) {
			assert.equal(expected, `v${version++}`);
			receipt = JSON.parse(source);
		},
		async recordNotebookExecution() {
			return true;
		},
		async close() {},
	} as unknown as DevelopmentGarden;
	const store = { get: () => ({ state: "running" }) } as unknown as SandboxStore;
	const bus = createSandboxEventBus(store);
	const spawner = {
		async spawn() {
			spawns++;
			bus.emit({ category: "system", type: "kernel_ready", kernel: "python3", sandbox_id: "sbx-1", ts: "now" });
			return { sandbox_id: "sbx-1", state: "running" };
		},
		sendKernelExecute() {
			const input_id = `input-${input++}`;
			bus.emit({
				category: "system",
				type: "kernel_result",
				sandbox_id: "sbx-1",
				ts: "now",
				input_id,
				data: { "text/plain": "5" },
				execution_count: 1,
			});
			bus.emit({
				category: "system",
				type: "kernel_reply",
				sandbox_id: "sbx-1",
				ts: "now",
				input_id,
				status: "ok",
				execution_count: 1,
			});
			bus.emit({ category: "system", type: "kernel_idle", sandbox_id: "sbx-1", ts: "now", input_id });
			return { inputId: input_id };
		},
	} as unknown as SandboxSpawner;
	const claims = {
		async claim(id: string, _executionId: string, serialized: string) {
			if (claimAllowed) {
				runDocumentId = id;
				receipt = JSON.parse(serialized);
			}
			return claimAllowed;
		},
	};
	const workspace = new HostedNotebookWorkspace(garden, "editor", spawner, store, bus, claims);
	const first = await workspace.executeSharedNotebookCell("notebook-one", "cell-one", "exec-one");
	assert.equal(first.record.status, "ok");
	assert.equal(first.record.outputs[0].kind, "result");
	assert.equal(receipt?.published, true);
	const history = await workspace.listSharedNotebookRuns("notebook-one");
	assert.equal(history.length, 1);
	const retry = await workspace.executeSharedNotebookCell("notebook-one", "cell-one", "exec-one");
	assert.deepEqual(retry.record, first.record);
	assert.equal(spawns, 1);
	assert.equal(input, 1);
	receipt = { ...receipt, published: false, currentOutput: undefined };
	const recovered = await workspace.executeSharedNotebookCell("notebook-one", "cell-one", "exec-one");
	assert.equal(recovered.currentOutput, true);
	assert.equal(receipt?.published, true);
	assert.equal(input, 1, "publication recovery must not run code again");
	receipt = { ...receipt, status: "pending", published: false, record: undefined };
	await assert.rejects(
		workspace.executeSharedNotebookCell("notebook-one", "cell-one", "exec-one"),
		/refusing automatic replay/,
	);
	assert.equal(input, 1);
	receipt = undefined;
	claimAllowed = false;
	await assert.rejects(
		workspace.executeSharedNotebookCell("notebook-one", "cell-one", "exec-contended"),
		/Another hosted worker claimed/,
	);
	assert.equal(input, 1, "a worker that lost the durable claim must not execute code");
});

test("execute returns each output's text, not a preview cut to its array index", async () => {
	// Regression (live smoke 2026-09-24): `.map(outputPreview)` passed the array
	// index as maxChars, so the first output came back as "" with truncated: true.
	const workspace = {
		options: { garden: { graphId: "notes" } },
		supportedNotebookKernels: () => ["python3"],
		executeSharedNotebookCell: async () => ({
			id: "exec-42",
			documentId: "notebook-one",
			cellId: "cell-one",
			kernel: "python3",
			sourceVersion: "v1",
			currentOutput: true,
			record: {
				status: "ok",
				executionCount: 1,
				durationMs: 1,
				outputs: [
					{ kind: "stream", name: "stdout", text: "42\n" },
					{ kind: "result", data: { "text/plain": "'second'" } },
				],
				outputTruncated: false,
			},
		}),
	} as unknown as NotebookWorkspace;
	const result = (await callNotebookTool(workspace, "execute", {
		graphId: "notes",
		documentId: "notebook-one",
		cellId: "cell-one",
		executionId: "exec-42",
	})) as { outputs: Array<{ text: string; truncated: boolean }>; outputsTruncated: boolean };
	assert.equal(result.outputs[0].text, "42\n");
	assert.equal(result.outputs[0].truncated, false);
	assert.equal(result.outputs[1].text, "'second'");
	assert.equal(result.outputs[1].truncated, false);
	assert.equal(result.outputsTruncated, false);
});
