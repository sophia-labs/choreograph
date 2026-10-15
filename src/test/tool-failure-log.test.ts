/**
 * A failed chat tool call leaves its reason in the host's log, under the Session's id, and never its content.
 *
 * Live, 2026-10-07: the Writer's `write_document` failed (session `ags_0863a3e56ec5d02f599e`); the durable record kept
 * `{tool, isError}` and the host logged only `tool_result: write_document error=true` under the sandbox id, so the
 * reason (the worker's validator refusing the arguments) was nowhere.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Span } from "@opentelemetry/api";
import { toolErrorSummary } from "../agent-runtime/tool-error-summary.js";
import { createSandboxEventBus } from "../event-bus.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";

const SENTINEL = "Train 3 release check: this document exists only to be deleted again.";

/** The worker's `tool_result` for a refused call: pi's validation error, rendered as the worker renders a tool result. */
const VALIDATION_FAILURE = JSON.stringify(
	{
		content: [
			{
				type: "text",
				text: `Validation failed for tool "write_document":\n  - graph_id: must have required properties graph_id\n  - graphId: must have required properties graphId\n  - root: must match a schema in anyOf\n\nReceived arguments:\n${JSON.stringify({ documentId: "train3-e2e-writer", format: "markdown", content: SENTINEL }, null, 2)}`,
			},
		],
		details: {},
	},
	null,
	2,
);

describe("toolErrorSummary", () => {
	it("keeps the worker's validation reason and drops its echo of the arguments", () => {
		const summary = toolErrorSummary(VALIDATION_FAILURE);
		assert.equal(summary.code, "argument_validation");
		assert.match(summary.message, /^Validation failed for tool "write_document": - graph_id: must have required/);
		assert.match(summary.message, /must match a schema in anyOf$/);
		assert.doesNotMatch(summary.message, /Train 3|Received arguments|train3-e2e-writer/);
	});

	it("reads a cell's refusal: an MCP error result, a structured code, a mode denial", () => {
		assert.deepEqual(
			toolErrorSummary({ isError: true, content: [{ type: "text", text: "document tombstoned: notes" }] }),
			{ message: "document tombstoned: notes" },
		);
		assert.deepEqual(
			toolErrorSummary({
				isError: true,
				content: [
					{
						type: "text",
						text: JSON.stringify({ error: { code: "revision_conflict", message: "expected 3, have 5" } }),
					},
				],
			}),
			{ code: "revision_conflict", message: "expected 3, have 5" },
		);
		const denied = toolErrorSummary(
			"write_document failed: mode_denied(graph_outside_scope): tool 'write_document' in mode <urn:sophia:mode:workspace-writer>: argument graphId=\"x\" is outside the mode's graph scope",
		);
		assert.equal(denied.code, "mode_denied:graph_outside_scope");
	});

	it("never carries a long quoted run or more than 300 characters", () => {
		const summary = toolErrorSummary(`write_document failed: cannot parse "${SENTINEL}" ${"x".repeat(400)}`);
		assert.doesNotMatch(summary.message, /Train 3/);
		assert.ok([...summary.message].length <= 301);
	});
});

describe("the host logs a failed chat tool call", () => {
	let tempDir: string;
	let store: SandboxStore;
	let spawner: SandboxSpawner;
	const lines: string[] = [];
	const originalConsoleError = console.error;

	before(() => {
		tempDir = mkdtempSync(join(tmpdir(), "choreograph-tool-failure-log-"));
		store = new SandboxStore(join(tempDir, "sandboxes.sqlite"));
		spawner = new SandboxSpawner(
			store,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{ sandboxMode: "local-native", defaultTimeoutMs: 10_000, eventBus: createSandboxEventBus(store) },
		);
	});

	after(async () => {
		console.error = originalConsoleError;
		await spawner.shutdownAll();
		store.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("names the Session, the tool and why, and never the arguments", () => {
		const active = {
			record: { sandbox_id: "sbx-writer-0001", template: "agent", state: "running" },
			isAgentRun: true,
			captureIdentity: { principal: "service:choreograph" },
			turnToolCount: 0,
			agentRequest: { session_id: "ags_0863a3e56ec5d02f599e" },
			toolCallStarts: new Map(),
			toolCallSpans: new Map(),
		};
		const span = { addEvent() {}, setAttribute() {} } as unknown as Span;
		const handle = (
			spawner as unknown as {
				handleWorkerEvent(
					sandboxId: string,
					event: Record<string, unknown>,
					active: Record<string, unknown>,
					span: Span,
					onHeartbeat: () => void,
				): void;
			}
		).handleWorkerEvent.bind(spawner);
		console.error = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};
		try {
			handle(
				"sbx-writer-0001",
				{ type: "tool_result", gate: "write_document", result: VALIDATION_FAILURE, is_error: true },
				active,
				span,
				() => {},
			);
			handle(
				"sbx-writer-0001",
				{ type: "tool_result", gate: "create_document", result: '{"content":[]}', is_error: false },
				active,
				span,
				() => {},
			);
		} finally {
			console.error = originalConsoleError;
		}
		const warned = lines.filter((line) => line.includes("[chat] WARN: tool failed"));
		assert.equal(warned.length, 1, lines.join("\n"));
		assert.match(
			warned[0]!,
			/session=ags_0863a3e56ec5d02f599e sandbox=sbx-writ tool=write_document code=argument_validation message="Validation failed for tool/,
		);
		assert.ok(
			lines.every((line) => !line.includes("Train 3")),
			"no content reaches the log",
		);
	});
});
