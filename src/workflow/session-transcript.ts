/**
 * The Agent Session transcript, as a pure function of the durable document.
 *
 * The store owns the transaction; this module owns what a transcript item is.
 * Keeping it pure lets the same rules serve the writers (a durable command
 * completes, a materialization's outcome is committed) and the reader (a
 * client is served a Session document), and lets the tests state them without
 * a running sandbox.
 *
 * Which item is canonical (decision recorded for the SPA, D3):
 * - the first message of a chat is `document.source.prompt`;
 * - the generation-zero reply is the `node-result` item `result:<invocationId>`;
 * - every later turn is a durable command: its message is `command:<id>:input`
 *   (role user) and its reply is `command:<id>:result` (kind `command-result`).
 *
 * A regrown generation's materialization result also carries the command's
 * output, so it used to be written a second time as `result:aca_...`. That id is
 * not a coincidence: a command activation is named by
 * `agentSessionCommandActivationId(session, command, generation)`, so the
 * duplicate is recognisable causally, with no comparison of text. Two separate
 * turns that happen to say the same words are never confused.
 *
 * Every item carries `ts` (epoch milliseconds): the moment its event happened.
 * A client renders that instead of the time it read the document (D4).
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "@sophia-labs/canonical-json";

type DocumentRecord = Record<string, unknown>;

/** The id of the activation that regrows a Session generation to deliver one durable command. */
export function agentSessionCommandActivationId(sessionId: string, commandId: string, generation: number): string {
	return `aca_${createHash("sha256")
		.update(canonicalJson({ kind: "agent_session_command_activation", sessionId, commandId, generation }))
		.digest("hex")}`;
}

export interface CommandTranscriptInput {
	readonly sessionId: string;
	readonly commandId: string;
	/** The durable command's name (`follow_up`, `prompt`, `steer`, `quiesce`, `goal.get`...). */
	readonly commandName: string;
	readonly payload: Record<string, unknown>;
	/** When the person's command was accepted. */
	readonly submittedAt: number;
	readonly generation: number;
	readonly status: "completed" | "failed";
	readonly result: unknown;
	readonly error?: string | null;
	/** When the command's outcome was committed. */
	readonly completedAt: number;
	/** The Session's pinned model, so a reply can say which voice answered. */
	readonly model?: string;
}

/**
 * Record a durable command's message and its reply. Returns a new document.
 * A `quiesce` is host bookkeeping, not conversation, and writes nothing. A node
 * result already written for the activation that delivered this command is
 * removed: the command's own reply is the canonical one.
 */
export function appendCommandTranscript(document: DocumentRecord, input: CommandTranscriptInput): DocumentRecord {
	if (input.commandName === "quiesce") return document;
	const { transcript, order, items } = readTranscript(document);
	const inputId = `command:${input.commandId}:input`;
	const resultId = `command:${input.commandId}:result`;
	const output = isRecord(input.result) ? input.result.output : undefined;
	const hasResult = typeof output === "string" || input.status === "failed";
	const nextItems: Record<string, unknown> = {
		...items,
		[inputId]: {
			id: inputId,
			role: "user",
			kind: input.commandName,
			text: typeof input.payload.text === "string" ? input.payload.text : input.commandName,
			generation: input.generation,
			ts: input.submittedAt,
		},
		...(hasResult
			? {
					[resultId]: {
						id: resultId,
						role: "assistant",
						kind: "command-result",
						text: typeof output === "string" ? output : (input.error ?? "Command failed"),
						state: input.status,
						generation: input.generation,
						ts: input.completedAt,
						...(input.model === undefined ? {} : { model: input.model }),
					},
				}
			: {}),
	};
	let nextOrder = [
		...order,
		...(order.includes(inputId) ? [] : [inputId]),
		...(hasResult && !order.includes(resultId) ? [resultId] : []),
	];
	for (const id of mirroredNodeResultIds(input.sessionId, nextItems)) {
		delete nextItems[id];
		nextOrder = nextOrder.filter((entry) => entry !== id);
	}
	return { ...document, transcript: { ...transcript, order: nextOrder, items: nextItems } };
}

export interface NodeResultTranscriptInput {
	readonly sessionId: string;
	/** `result:<invocationId ?? sessionId ?? label>` */
	readonly eventId: string;
	readonly output: string;
	readonly state: string;
	readonly model: string;
	readonly tokens: number;
	readonly toolCalls: number;
	readonly checkpointRef?: unknown;
	readonly generation: number;
	/** When the outcome was committed. */
	readonly now: number;
}

/**
 * Record a materialization's outcome as a `node-result` item. Returns a new
 * document. It is not written when the outcome only repeats a durable command's
 * reply that is already in the transcript (the regrown generation's result).
 */
export function appendNodeResultTranscript(document: DocumentRecord, input: NodeResultTranscriptInput): DocumentRecord {
	const { transcript, order, items } = readTranscript(document);
	if (mirroredNodeResultIds(input.sessionId, items).has(input.eventId)) return document;
	return {
		...document,
		transcript: {
			...transcript,
			order: order.includes(input.eventId) ? order : [...order, input.eventId],
			items: {
				...items,
				[input.eventId]: {
					id: input.eventId,
					role: "assistant",
					kind: "node-result",
					text: input.output,
					state: input.state,
					model: input.model,
					tokens: input.tokens,
					toolCalls: input.toolCalls,
					...(input.checkpointRef ? { checkpointObject: input.checkpointRef } : {}),
					generation: input.generation,
					ts: input.now,
				},
			},
		},
	};
}

/**
 * The transcript as a client should read it: causal duplicates written before
 * the fix are dropped. Pure and read-only: the stored document is not a
 * migration target, and a document with nothing to drop is returned as is.
 */
export function canonicalTranscript(document: DocumentRecord, sessionId: string): DocumentRecord {
	const { transcript, order, items } = readTranscript(document);
	const mirrored = mirroredNodeResultIds(sessionId, items);
	const present = [...mirrored].filter((id) => id in items || order.includes(id));
	if (present.length === 0) return document;
	const nextItems = { ...items };
	for (const id of present) delete nextItems[id];
	return {
		...document,
		transcript: { ...transcript, order: order.filter((id) => !mirrored.has(id)), items: nextItems },
	};
}

export interface TranscriptTimeSources {
	readonly commands: ReadonlyArray<{ command_id: string; submitted_at: number; completed_at: number | null }>;
	readonly ops: ReadonlyArray<{ ts: number; patch: unknown }>;
	/** The Session's pinned model. It never changes for the life of a Session, so it spoke every assistant reply. */
	readonly sessionModel?: string;
}

/**
 * Fill what a legacy item lacks from what the Session records. A missing `ts` is read from the events that made the
 * item: a command message from the command's `submitted_at`, its reply from `completed_at` (else `submitted_at`), a
 * node result from the `transcript.result.append` document operation that appended it. An assistant reply written
 * before the model was recorded on it gets the Session's pinned model (the inference fence rejects a turn on any
 * other, so it is exact). Items that already have a value keep it; an item with no event to read stays without a
 * `ts`. Returns a new document.
 */
export function annotateTranscriptTimestamps(document: DocumentRecord, sources: TranscriptTimeSources): DocumentRecord {
	const { transcript, order, items } = readTranscript(document);
	const commands = new Map(sources.commands.map((command) => [command.command_id, command]));
	const appended = new Map<string, number>();
	for (const op of sources.ops) {
		const patch = isRecord(op.patch) ? op.patch : undefined;
		if (patch?.op === "transcript.result.append" && typeof patch.resultEventId === "string") {
			appended.set(patch.resultEventId, op.ts);
		}
	}
	const nextItems: Record<string, unknown> = {};
	for (const [id, raw] of Object.entries(items)) {
		const item = isRecord(raw) ? raw : undefined;
		if (!item) {
			nextItems[id] = raw;
			continue;
		}
		let next: Record<string, unknown> = item;
		if (typeof item.ts !== "number") {
			const ts = timeOfItem(id, commands, appended);
			if (ts !== undefined) next = { ...next, ts };
		}
		if (item.role === "assistant" && typeof item.model !== "string" && sources.sessionModel) {
			next = { ...next, model: sources.sessionModel };
		}
		nextItems[id] = next;
	}
	return { ...document, transcript: { ...transcript, order, items: nextItems } };
}

function timeOfItem(
	id: string,
	commands: ReadonlyMap<string, { submitted_at: number; completed_at: number | null }>,
	appended: ReadonlyMap<string, number>,
): number | undefined {
	const input = /^command:(.+):input$/.exec(id);
	if (input) return commands.get(input[1])?.submitted_at;
	const result = /^command:(.+):result$/.exec(id);
	if (result) {
		const command = commands.get(result[1]);
		return command ? (command.completed_at ?? command.submitted_at) : undefined;
	}
	return appended.get(id);
}

/** The `result:aca_...` ids that only repeat the reply of a command already in the transcript. */
function mirroredNodeResultIds(sessionId: string, items: Record<string, unknown>): Set<string> {
	const ids = new Set<string>();
	for (const [id, raw] of Object.entries(items)) {
		const item = isRecord(raw) ? raw : undefined;
		if (item?.kind !== "command-result") continue;
		const match = /^command:(.+):result$/.exec(id);
		const generation = item.generation;
		if (!match || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) continue;
		ids.add(`result:${agentSessionCommandActivationId(sessionId, match[1], generation)}`);
	}
	return ids;
}

function readTranscript(document: DocumentRecord): {
	transcript: Record<string, unknown>;
	order: string[];
	items: Record<string, unknown>;
} {
	const transcript = isRecord(document.transcript) ? document.transcript : {};
	const order = Array.isArray(transcript.order)
		? transcript.order.filter((entry): entry is string => typeof entry === "string")
		: [];
	return { transcript, order, items: isRecord(transcript.items) ? transcript.items : {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
