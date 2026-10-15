import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	agentSessionCommandActivationId,
	annotateTranscriptTimestamps,
	appendCommandTranscript,
	appendNodeResultTranscript,
	canonicalTranscript,
} from "../workflow/session-transcript.js";

/**
 * The Agent Session transcript, as a pure function of the durable document.
 *
 * D3 (live probe 2026-09-28): after a reload a follow-up answer appeared twice,
 * once as the durable command's `command-result` and once as the regrown
 * generation's `node-result`, both with identical text. D4: transcript items
 * carried no `ts`, so a client stamped them with `Date.now()` at render time.
 *
 * The canonical assistant item for a follow-up turn is the command's
 * `command-result`. The generation-zero reply stays a `node-result` (the first
 * user message is `document.source.prompt`). A regrown generation's node result
 * is a causal duplicate: its id is `result:aca_...` and that activation id is
 * derived from (session, command, generation).
 */

const SESSION = "ags-transcript";

type Item = Record<string, unknown>;
type Transcript = { order: string[]; items: Record<string, Item> };

function emptyDocument(): Record<string, unknown> {
	return {
		schema: "choreograph.agent-session-document.v1",
		sessionId: SESSION,
		source: { prompt: "the first message" },
		transcript: { order: [], items: {} },
	};
}

function transcriptOf(document: Record<string, unknown>): Transcript {
	return document.transcript as Transcript;
}

function command(over: Partial<Parameters<typeof appendCommandTranscript>[1]> = {}) {
	return {
		sessionId: SESSION,
		commandId: "cmd-1",
		commandName: "follow_up",
		payload: { text: "Say that again in five words or fewer." },
		submittedAt: 2_000,
		generation: 1,
		status: "completed" as const,
		result: { output: "Read and search workspace." } as unknown,
		error: undefined as string | undefined,
		completedAt: 2_500,
		model: "google/gemini-2.5-flash",
		...over,
	};
}

function nodeResult(over: Partial<Parameters<typeof appendNodeResultTranscript>[1]> = {}) {
	return {
		sessionId: SESSION,
		eventId: `result:${SESSION}:generation:0`,
		output: "I can help you read and search your workspace.",
		state: "done",
		model: "google/gemini-2.5-flash",
		tokens: 2_256,
		toolCalls: 0,
		generation: 0,
		now: 1_200,
		...over,
	};
}

describe("transcript items carry the time of the event that made them (D4)", () => {
	it("stamps a follow-up's input with the moment it was sent and its reply with the moment it completed", () => {
		const document = appendCommandTranscript(emptyDocument(), command());
		const transcript = transcriptOf(document);
		assert.deepEqual(transcript.order, ["command:cmd-1:input", "command:cmd-1:result"]);
		assert.deepEqual(transcript.items["command:cmd-1:input"], {
			id: "command:cmd-1:input",
			role: "user",
			kind: "follow_up",
			text: "Say that again in five words or fewer.",
			generation: 1,
			ts: 2_000,
		});
		assert.deepEqual(transcript.items["command:cmd-1:result"], {
			id: "command:cmd-1:result",
			role: "assistant",
			kind: "command-result",
			text: "Read and search workspace.",
			state: "completed",
			generation: 1,
			ts: 2_500,
			model: "google/gemini-2.5-flash",
		});
	});

	it("stamps a node result with the time its outcome was committed, and records its generation", () => {
		const document = appendNodeResultTranscript(emptyDocument(), nodeResult());
		const item = transcriptOf(document).items[`result:${SESSION}:generation:0`];
		assert.equal(item.kind, "node-result");
		assert.equal(item.ts, 1_200);
		assert.equal(item.generation, 0);
		assert.equal(item.text, "I can help you read and search your workspace.");
		assert.equal(item.model, "google/gemini-2.5-flash");
		assert.equal(item.tokens, 2_256);
		assert.equal(item.checkpointObject, undefined);
	});

	it("keeps the checkpoint object reference on a node result when one was committed", () => {
		const ref = { schema: "sophia.meaningful-object-ref.v1", kind: "agent-checkpoint", objectId: "cp-1" };
		const document = appendNodeResultTranscript(emptyDocument(), nodeResult({ checkpointRef: ref }));
		assert.deepEqual(transcriptOf(document).items[`result:${SESSION}:generation:0`].checkpointObject, ref);
	});
});

describe("command transcript edge cases keep their existing meaning", () => {
	it("keeps a failed command's error as the reply", () => {
		const document = appendCommandTranscript(
			emptyDocument(),
			command({ status: "failed", result: undefined, error: "sandbox lost" }),
		);
		const reply = transcriptOf(document).items["command:cmd-1:result"];
		assert.equal(reply.text, "sandbox lost");
		assert.equal(reply.state, "failed");
		assert.equal(reply.kind, "command-result");
	});

	it("records only the person's message when a completed command produced no text", () => {
		const document = appendCommandTranscript(emptyDocument(), command({ result: {} }));
		assert.deepEqual(transcriptOf(document).order, ["command:cmd-1:input"]);
	});

	it("falls back to the command name when the payload has no text", () => {
		const document = appendCommandTranscript(emptyDocument(), command({ commandName: "goal.get", payload: {} }));
		assert.equal(transcriptOf(document).items["command:cmd-1:input"].text, "goal.get");
	});

	it("does not write a quiesce into the conversation", () => {
		const before = emptyDocument();
		const after = appendCommandTranscript(before, command({ commandName: "quiesce", payload: {} }));
		assert.deepEqual(transcriptOf(after), { order: [], items: {} });
	});

	it("does not duplicate order entries when the same command is applied twice", () => {
		const once = appendCommandTranscript(emptyDocument(), command());
		const twice = appendCommandTranscript(once, command());
		assert.deepEqual(transcriptOf(twice).order, ["command:cmd-1:input", "command:cmd-1:result"]);
	});

	it("never mutates the document it was given", () => {
		const before = emptyDocument();
		const snapshot = JSON.stringify(before);
		appendCommandTranscript(before, command());
		appendNodeResultTranscript(before, nodeResult());
		assert.equal(JSON.stringify(before), snapshot);
	});
});

describe("a regrown generation's node result does not repeat the command's reply (D3)", () => {
	const ACTIVATION = agentSessionCommandActivationId(SESSION, "cmd-1", 1);

	it("derives the activation id from session, command and generation", () => {
		assert.match(ACTIVATION, /^aca_[0-9a-f]{64}$/);
		assert.notEqual(ACTIVATION, agentSessionCommandActivationId(SESSION, "cmd-1", 2));
		assert.notEqual(ACTIVATION, agentSessionCommandActivationId(SESSION, "cmd-2", 1));
		assert.notEqual(ACTIVATION, agentSessionCommandActivationId("ags-other", "cmd-1", 1));
	});

	it("writes no node-result when the command's reply is already in the transcript", () => {
		let document = appendNodeResultTranscript(emptyDocument(), nodeResult());
		document = appendCommandTranscript(document, command());
		document = appendNodeResultTranscript(
			document,
			nodeResult({
				eventId: `result:${ACTIVATION}`,
				output: "Read and search workspace.",
				generation: 1,
				tokens: 4_543,
				now: 2_510,
			}),
		);
		assert.deepEqual(transcriptOf(document).order, [
			`result:${SESSION}:generation:0`,
			"command:cmd-1:input",
			"command:cmd-1:result",
		]);
		assert.equal(transcriptOf(document).items[`result:${ACTIVATION}`], undefined);
	});

	it("removes an already-written node-result when the command's reply arrives second", () => {
		let document = appendNodeResultTranscript(emptyDocument(), nodeResult());
		document = appendNodeResultTranscript(
			document,
			nodeResult({ eventId: `result:${ACTIVATION}`, output: "Read and search workspace.", generation: 1 }),
		);
		assert.ok(transcriptOf(document).order.includes(`result:${ACTIVATION}`));
		document = appendCommandTranscript(document, command());
		assert.deepEqual(transcriptOf(document).order, [
			`result:${SESSION}:generation:0`,
			"command:cmd-1:input",
			"command:cmd-1:result",
		]);
		assert.equal(transcriptOf(document).items[`result:${ACTIVATION}`], undefined);
	});

	it("keeps two genuinely separate answers that happen to have the same text", () => {
		// Failing direction: a text-equality dedupe would drop the second "Hello!".
		let document = appendNodeResultTranscript(emptyDocument(), nodeResult({ output: "Hello!" }));
		document = appendCommandTranscript(
			document,
			command({ payload: { text: "hi" }, result: { output: "Hello!" }, generation: 1 }),
		);
		const assistant = transcriptOf(document).order.filter(
			(id) => transcriptOf(document).items[id].role === "assistant",
		);
		assert.equal(assistant.length, 2);
	});

	it("keeps a node result whose activation is not a durable command's (a failure or a scheduled fire)", () => {
		let document = appendCommandTranscript(emptyDocument(), command());
		document = appendNodeResultTranscript(
			document,
			nodeResult({ eventId: "result:asf_fire-1", output: "Read and search workspace.", generation: 1 }),
		);
		document = appendNodeResultTranscript(
			document,
			nodeResult({ eventId: "result:aca_unrelated", output: "boom", state: "error", generation: 2 }),
		);
		assert.ok(transcriptOf(document).items["result:asf_fire-1"]);
		assert.ok(transcriptOf(document).items["result:aca_unrelated"]);
	});
});

describe("legacy documents are read as one conversation with honest times", () => {
	const ACTIVATION = agentSessionCommandActivationId(SESSION, "cmd-1", 1);

	function legacyDocument(): Record<string, unknown> {
		return {
			...emptyDocument(),
			transcript: {
				order: [
					`result:${SESSION}:generation:0`,
					"command:cmd-1:input",
					"command:cmd-1:result",
					`result:${ACTIVATION}`,
				],
				items: {
					[`result:${SESSION}:generation:0`]: {
						id: `result:${SESSION}:generation:0`,
						role: "assistant",
						kind: "node-result",
						text: "Again.",
						state: "done",
					},
					"command:cmd-1:input": {
						id: "command:cmd-1:input",
						role: "user",
						kind: "follow_up",
						text: "again",
						generation: 1,
					},
					"command:cmd-1:result": {
						id: "command:cmd-1:result",
						role: "assistant",
						kind: "command-result",
						text: "Again.",
						state: "completed",
						generation: 1,
					},
					[`result:${ACTIVATION}`]: {
						id: `result:${ACTIVATION}`,
						role: "assistant",
						kind: "node-result",
						text: "Again.",
						state: "done",
						tokens: 4_543,
					},
				},
			},
		};
	}

	it("drops only the causal duplicate, even when a different turn said the same words", () => {
		const legacy = legacyDocument();
		const snapshot = JSON.stringify(legacy);
		const clean = canonicalTranscript(legacy, SESSION);
		assert.deepEqual(transcriptOf(clean).order, [
			`result:${SESSION}:generation:0`,
			"command:cmd-1:input",
			"command:cmd-1:result",
		]);
		assert.equal(transcriptOf(clean).items[`result:${ACTIVATION}`], undefined);
		assert.ok(transcriptOf(clean).items[`result:${SESSION}:generation:0`], "generation zero's reply stays");
		assert.equal(JSON.stringify(legacy), snapshot, "reading never rewrites the document");
	});

	it("fills a missing ts from the command rows and the result-append operations, and only where it is missing", () => {
		const document = legacyDocument();
		const items = transcriptOf(document).items;
		items["command:cmd-1:result"].ts = 9_999;
		const annotated = annotateTranscriptTimestamps(document, {
			commands: [{ command_id: "cmd-1", submitted_at: 2_000, completed_at: 2_500 }],
			ops: [
				{ ts: 1_200, patch: { op: "transcript.result.append", resultEventId: `result:${SESSION}:generation:0` } },
				{ ts: 1_300, patch: { op: "frontier.set" } },
			],
		});
		const filled = transcriptOf(annotated).items;
		assert.equal(filled[`result:${SESSION}:generation:0`].ts, 1_200);
		assert.equal(filled["command:cmd-1:input"].ts, 2_000);
		assert.equal(filled["command:cmd-1:result"].ts, 9_999, "an item that already has a ts keeps it");
		assert.equal(filled[`result:${ACTIVATION}`].ts, undefined, "no event to read a time from");
		assert.equal(items["command:cmd-1:input"].ts, undefined, "the input document is untouched");
	});

	it("uses the submission time for a command reply whose completion time was never stored", () => {
		const document = legacyDocument();
		const annotated = annotateTranscriptTimestamps(document, {
			commands: [{ command_id: "cmd-1", submitted_at: 2_000, completed_at: null }],
			ops: [],
		});
		assert.equal(transcriptOf(annotated).items["command:cmd-1:result"].ts, 2_000);
	});
});
