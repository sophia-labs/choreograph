/**
 * What a workspace write touched, as ids only: the receipt the durable Session record keeps beside a tool
 * call's name and outcome (`value.targets` on `tool.started` / `tool.completed`).
 *
 * The record is content-free testimony: it never keeps a call's arguments or its result. The SPA's
 * "Changed in this turn" strip (shrubbery `turn-changes.ts`, RETURN-spa-chat.md §5) needs only which
 * documents, blocks, comments, folders, artifacts and wires a write touched, so it can name them after a
 * reload and link each to its History. What is taken (the lead's guard, 2026-10-06):
 * - ids, in the cell's own id grammar, and an artifact's media type;
 * - the kind of change, from the tool;
 * - a wire's endpoints, as `doc` or `doc#block`;
 * - the revision before (a write's `expectedRevision`) and after (a result's `revision`), where known;
 * - a title, only where a result names one, one line of at most 200 characters.
 * Never document text, artifact bytes, SPARQL, comment bodies, names given in arguments or any other content
 * (pinned by `agent-session-tool-targets.test.ts`, which sends a sentinel in every content field).
 *
 * Adapted from the SPA body's proposal (the 2026-10-06 tool-targets proposal branch @ r20261006b).
 * Tool names and argument keys are garden engine r20261002's (`src/test/fixtures/garden-cell-tools-r20261002.json`).
 */

export type ToolChangeKind =
	| "created"
	| "edited"
	| "removed"
	| "commented"
	| "valued"
	| "moved"
	| "renamed"
	| "linked"
	| "restored"
	| "deleted";

export interface ToolTargetV1 {
	readonly kind: "document" | "block" | "comment" | "folder" | "artifact" | "wire";
	readonly id: string;
	/** The document a block or comment belongs to. */
	readonly documentId?: string;
	/** An artifact's media type, when the call named it (`text/html` is previewed live). */
	readonly mediaType?: string;
	/** A comment the call removed. */
	readonly removed?: true;
	/** What the call did to it. */
	readonly change?: ToolChangeKind;
	/** A wire's endpoints: `documentId` or `documentId#blockId`. */
	readonly source?: string;
	readonly target?: string;
	/** The revision the call said it read (`expectedRevision`), and the one its result reports. */
	readonly revisionBefore?: number;
	readonly revisionAfter?: number;
	/** Only from a result that names it: one line, at most 200 characters. */
	readonly title?: string;
}

/** The cell's id grammar (garden `src-tauri/src/ids.rs`): letters, digits, `-`, `_`. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const MEDIA_TYPE = /^[a-z]+\/[a-z0-9.+-]{1,64}$/i;
const MAX_TARGETS = 32;
const MAX_TITLE_CHARS = 200;

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function idOf(value: unknown): string | undefined {
	return typeof value === "string" && ID.test(value) ? value : undefined;
}

function first(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const id = idOf(source[key]);
		if (id) return id;
	}
	return undefined;
}

function revisionOf(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
	}
	return undefined;
}

function titleOf(source: Record<string, unknown>): string | undefined {
	const value = source.title;
	if (typeof value !== "string") return undefined;
	const title = value.trim();
	// One line of text, nothing a strip could not show as a name: anything else is left out, never cut.
	if (!title || [...title].length > MAX_TITLE_CHARS || /[\u0000-\u001f\u007f]/.test(title)) return undefined;
	return title;
}

function ids(source: Record<string, unknown>, listKeys: readonly string[], oneKeys: readonly string[]): string[] {
	const found: string[] = [];
	for (const key of listKeys) {
		const list = source[key];
		if (Array.isArray(list))
			for (const item of list) {
				const id = idOf(item);
				if (id) found.push(id);
			}
	}
	const one = first(source, oneKeys);
	if (one) found.push(one);
	return [...new Set(found)];
}

const DOC = ["documentId", "document_id"] as const;
const BLOCK = ["blockId", "block_id"] as const;
const ARTIFACT = ["artifact_id", "artifactId"] as const;
const FOLDER = ["folderId", "folder_id"] as const;
const EXPECTED_REVISION = ["expectedRevision", "expected_revision"] as const;

function documentOrBlock(change: ToolChangeKind) {
	return (args: Record<string, unknown>): ToolTargetV1[] => {
		const documentId = first(args, DOC);
		if (!documentId) return [];
		const blockId = first(args, BLOCK);
		return blockId
			? [{ kind: "block", id: blockId, documentId, change }]
			: [{ kind: "document", id: documentId, change }];
	};
}

function artifact(change: ToolChangeKind, withType = false) {
	return (args: Record<string, unknown>): ToolTargetV1[] => {
		const id = first(args, ARTIFACT);
		if (!id) return [];
		const mediaType =
			typeof args.mime_type === "string" && MEDIA_TYPE.test(args.mime_type) ? args.mime_type : undefined;
		return [{ kind: "artifact", id, ...(withType && mediaType ? { mediaType } : {}), change }];
	};
}

function endpoint(source: Record<string, unknown>, side: "source" | "target"): string | undefined {
	const documentId = first(source, [`${side}DocumentId`, `${side}_document_id`]);
	if (!documentId) return undefined;
	const blockId = first(source, [`${side}BlockId`, `${side}_block_id`]);
	return blockId ? `${documentId}#${blockId}` : documentId;
}

function blocksOf(documentId: string, blocks: readonly string[], change: ToolChangeKind): ToolTargetV1[] {
	return blocks.length > 0
		? blocks.map((id) => ({ kind: "block" as const, id, documentId, change }))
		: [{ kind: "document", id: documentId, change }];
}

const FROM_ARGS: Readonly<Record<string, (args: Record<string, unknown>) => ToolTargetV1[]>> = {
	create_document: (args) => {
		const id = first(args, DOC);
		return id ? [{ kind: "document", id, change: "created" }] : [];
	},
	write_document: (args) => {
		const id = first(args, DOC);
		if (!id) return [];
		const revisionBefore = revisionOf(args, EXPECTED_REVISION);
		return [{ kind: "document", id, change: "edited", ...(revisionBefore !== undefined ? { revisionBefore } : {}) }];
	},
	insert_blocks: documentOrBlock("edited"),
	update_blocks: (args) => {
		const documentId = first(args, DOC);
		if (!documentId) return [];
		const edits = Array.isArray(args.edits) ? args.edits.map(record) : [];
		const blocks = [
			...new Set(
				[first(args, BLOCK), ...edits.map((edit) => first(edit, BLOCK))].filter((id): id is string => !!id),
			),
		];
		return blocksOf(documentId, blocks, "edited");
	},
	edit_block_text: documentOrBlock("edited"),
	delete_blocks: (args) => {
		const documentId = first(args, DOC);
		if (!documentId) return [];
		return blocksOf(documentId, ids(args, ["blockIds", "block_ids"], BLOCK), "removed");
	},
	edit_comment: (args) => {
		const documentId = first(args, DOC);
		if (!documentId) return [];
		const commentId = first(args, ["comment_id", "commentId"]);
		const removed = args.action === "delete";
		if (!commentId) return [{ kind: "document", id: documentId, change: removed ? "removed" : "commented" }];
		return [
			{
				kind: "comment",
				id: commentId,
				documentId,
				...(removed ? { removed: true as const } : {}),
				change: removed ? "removed" : "commented",
			},
		];
	},
	value: (args) => {
		const items = Array.isArray(args.valuations) && args.valuations.length > 0 ? args.valuations.map(record) : [args];
		return items.flatMap((item): ToolTargetV1[] => {
			const documentId = first(item, DOC) ?? first(args, DOC);
			if (!documentId) return [];
			const blockId = first(item, BLOCK);
			return blockId
				? [{ kind: "block", id: blockId, documentId, change: "valued" }]
				: [{ kind: "document", id: documentId, change: "valued" }];
		});
	},
	create_folder: (args) => {
		const id = first(args, FOLDER);
		return id ? [{ kind: "folder", id, change: "created" }] : [];
	},
	move_documents: (args) =>
		ids(args, ["documentIds", "document_ids"], DOC).map((id) => ({
			kind: "document" as const,
			id,
			change: "moved" as const,
		})),
	move_folder: (args) => {
		const id = first(args, FOLDER);
		return id ? [{ kind: "folder", id, change: "moved" }] : [];
	},
	rename: (args) => {
		const type = args.entity_type ?? args.entityType;
		const id = first(args, ["entity_id", "entityId"]);
		if (!id || (type !== "document" && type !== "folder")) return [];
		return [{ kind: type, id, change: "renamed" }];
	},
	create_wires: (args) => {
		const wires = Array.isArray(args.wires) && args.wires.length > 0 ? args.wires.map(record) : [args];
		return wires.flatMap((wire): ToolTargetV1[] => {
			const source = endpoint(wire, "source");
			const target = endpoint(wire, "target");
			const ends = { ...(source ? { source } : {}), ...(target ? { target } : {}) };
			const wireId = first(wire, ["wireId", "wire_id"]);
			if (wireId) return [{ kind: "wire", id: wireId, change: "linked", ...ends }];
			// A new wire has no id until the cell answers: it is listed under the document it starts from.
			const sourceDocument = first(wire, ["sourceDocumentId", "source_document_id"]);
			return sourceDocument ? [{ kind: "document", id: sourceDocument, change: "linked", ...ends }] : [];
		});
	},
	create_artifact_text: artifact("created", true),
	write_artifact_text: artifact("edited"),
	restore_artifact_revision: artifact("restored"),
	delete_document: (args) => {
		const id = first(args, DOC);
		return id ? [{ kind: "document", id, change: "deleted" }] : [];
	},
	delete: (args) => {
		const type = typeof args.type === "string" ? args.type.toLowerCase() : "";
		if (type === "wire" || type === "wires") {
			return ids(args, ["wireIds", "wire_ids"], ["wireId", "wire_id"]).map((id) => ({
				kind: "wire" as const,
				id,
				change: "deleted" as const,
			}));
		}
		if (type === "document" || type === "documents") {
			return ids(args, ["documentIds", "document_ids"], DOC).map((id) => ({
				kind: "document" as const,
				id,
				change: "deleted" as const,
			}));
		}
		if (type === "block" || type === "blocks") {
			const documentId = first(args, DOC);
			if (!documentId) return [];
			return ids(args, ["blockIds", "block_ids"], BLOCK).map((id) => ({
				kind: "block" as const,
				id,
				documentId,
				change: "removed" as const,
			}));
		}
		if (type === "folder" || type === "folders") {
			const id = first(args, FOLDER);
			return id ? [{ kind: "folder", id, change: "deleted" }] : [];
		}
		return [];
	},
};

function documentFromResult(change: ToolChangeKind, withTitle: boolean) {
	return (result: Record<string, unknown>): ToolTargetV1[] => {
		const id = first(result, [...DOC, "id"]);
		if (!id) return [];
		const revisionAfter = revisionOf(result, ["revision"]);
		const title = withTitle ? titleOf(result) : undefined;
		return [
			{
				kind: "document",
				id,
				change,
				...(revisionAfter !== undefined ? { revisionAfter } : {}),
				...(title ? { title } : {}),
			},
		];
	};
}

/** Results that name what the call made or left: a new object, its title, the revision after. */
const FROM_RESULT: Readonly<Record<string, (result: Record<string, unknown>) => ToolTargetV1[]>> = {
	create_document: documentFromResult("created", true),
	write_document: documentFromResult("edited", false),
	delete_document: documentFromResult("deleted", true),
	create_folder: (result) => {
		const id = first(result, [...FOLDER, "id"]);
		if (!id) return [];
		const title = titleOf(result);
		return [{ kind: "folder", id, change: "created", ...(title ? { title } : {}) }];
	},
};

/** What a write call touched, from its arguments, every one of them (the receipts of a deletion are never cut). */
function callTargets(tool: string, args: unknown): ToolTargetV1[] {
	const rule = FROM_ARGS[tool];
	if (!rule) return [];
	try {
		return rule(record(args));
	} catch {
		return [];
	}
}

/** What a write call touched, from its arguments: ids only, at most 32. Reads touch nothing. */
export function toolCallTargets(tool: string, args: unknown): ToolTargetV1[] {
	return callTargets(tool, args).slice(0, MAX_TARGETS);
}

/** What a write call made, from its result (a JSON object, or its text), where only the result can say. */
export function toolResultTargets(tool: string, result: unknown): ToolTargetV1[] {
	const rule = FROM_RESULT[tool];
	if (!rule) return [];
	let parsed: unknown = result;
	if (typeof result === "string") {
		const trimmed = result.trim();
		if (!trimmed.startsWith("{")) return [];
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			return [];
		}
	}
	try {
		return rule(record(parsed)).slice(0, MAX_TARGETS);
	} catch {
		return [];
	}
}

export const DELETION_RECEIPT_SCHEMA = "sophia.deletion-receipt.v1" as const;

/**
 * The receipt the host records for a deletion the cell accepted (exam 1, finding 4): what was deleted (targets, with a
 * title only where the cell's answer names one), whether its history went with it, and the sentence the person is shown.
 * The host appends it to the Session's events before the worker hears the answer, so it does not depend on the model's
 * reply ever arriving.
 */
export interface DeletionReceiptV1 {
	readonly schema: typeof DELETION_RECEIPT_SCHEMA;
	readonly tool: string;
	readonly targets: readonly ToolTargetV1[];
	/** A deleted document takes its history with it (garden keeps it under the document); a wire never had one. */
	readonly historyRemoved: boolean;
	readonly notice: string;
	/** Set when a deletion's targets did not fit one receipt: this is part `index` (from 0) of `of`. */
	readonly part?: { readonly index: number; readonly of: number };
}

/** The object an MCP tool result carries: its structured content, or the JSON of its first text part. */
function mcpResultObject(result: unknown): Record<string, unknown> {
	const value = record(result);
	if (value.structuredContent !== undefined) return record(value.structuredContent);
	if (Array.isArray(value.content)) {
		const first = record(value.content[0]);
		if (typeof first.text === "string" && first.text.trim().startsWith("{")) {
			try {
				return record(JSON.parse(first.text));
			} catch {
				return {};
			}
		}
		return {};
	}
	return value;
}

/** An id the cell reported deleting: kept as the cell spelled it, whatever its grammar (a receipt never drops one). */
function reportedId(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const id = value.trim();
	return id && id.length <= 256 && !/[\u0000-\u001f\u007f]/.test(id) ? id : undefined;
}

/**
 * What the cell says it deleted: the `deleted` array of its answer (garden: `{type: "wires", deleted: [{wire_id,
 * wireId, value}]}`, `{type: "documents", deleted: [{document_id, documentId, value}]}`), where the cell resolved the
 * identities itself (a wire selected by `documentId`) and the arguments cannot name them. Undefined when the answer
 * carries no such list.
 */
function deletedByResult(tool: string, args: unknown, result: Record<string, unknown>): ToolTargetV1[] | undefined {
	const list = result.deleted;
	if (!Array.isArray(list) || list.length === 0) return undefined;
	const answered = typeof result.type === "string" ? result.type.toLowerCase() : "";
	const asked = typeof record(args).type === "string" ? String(record(args).type).toLowerCase() : "";
	const kindName = answered || asked;
	const kind: "wire" | "document" | undefined =
		kindName === "wire" || kindName === "wires"
			? "wire"
			: kindName === "document" || kindName === "documents" || tool === "delete_document"
				? "document"
				: undefined;
	if (!kind) return undefined;
	const keys = kind === "wire" ? ["wire_id", "wireId", "id"] : ["document_id", "documentId", "id"];
	const found: ToolTargetV1[] = [];
	for (const item of list) {
		const entry = record(item);
		const id = reportedId(typeof item === "string" ? item : keys.map((key) => entry[key]).find(reportedId));
		if (!id) continue;
		const title = titleOf(entry);
		found.push({ kind, id, change: "deleted", ...(title ? { title } : {}) });
	}
	return found.length > 0 ? found : undefined;
}

/**
 * The tools whose answers are read as deletions (exam 6): the Writer's `delete_document` and its `delete` (wires only,
 * by the argument policy). Any other tool that happens to answer with a `deleted` array is not a deletion.
 * (`delete_blocks` removes blocks, which History keeps; it leaves no receipt.)
 */
export const DELETION_RECEIPT_TOOLS: ReadonlySet<string> = new Set(["delete", "delete_document"]);

/** A receipt names at most this many targets; a larger deletion is recorded in several, in order. */
export const DELETION_RECEIPT_CHUNK = 50;

function receiptFor(
	tool: string,
	targets: readonly ToolTargetV1[],
	part: { index: number; of: number } | undefined,
): DeletionReceiptV1 {
	const documents = targets.filter((target) => target.kind === "document");
	const wires = targets.filter((target) => target.kind === "wire");
	const name = (target: ToolTargetV1) => (target.title ? `"${target.title}" (${target.id})` : target.id);
	const sentences = [
		...(documents.length > 0
			? [
					`Deleted ${documents.map(name).join(", ")} with ${documents.length === 1 ? "its" : "their"} history: ${documents.length === 1 ? "it" : "they"} cannot be brought back from History.`,
				]
			: []),
		...(wires.length > 0
			? [
					`Removed ${wires.length === 1 ? "the wire" : "the wires"} ${wires.map(name).join(", ")}. A wire keeps no history; it can be made again between the same two points.`,
				]
			: []),
	];
	return {
		schema: DELETION_RECEIPT_SCHEMA,
		tool,
		targets,
		historyRemoved: documents.length > 0,
		notice: `${sentences.join(" ")}${part ? ` (part ${part.index + 1} of ${part.of})` : ""}`,
		...(part ? { part } : {}),
	};
}

/**
 * The receipts for a successful deletion call, or none when the call deleted nothing (or the cell refused it).
 * Identities come from the cell's own answer (its `deleted` array) when it gives one, since the cell may resolve them
 * (a wire selected by `documentId`); otherwise from the arguments. Every one is recorded: a deletion that names more
 * than `DELETION_RECEIPT_CHUNK` targets leaves several receipts, in order, none cut.
 */
export function deletionReceipts(tool: string, args: unknown, result: unknown): DeletionReceiptV1[] {
	if (!DELETION_RECEIPT_TOOLS.has(tool)) return [];
	if (record(result).isError === true) return [];
	const answer = mcpResultObject(result);
	const fromArguments = callTargets(tool, args).filter(
		(target) => target.change === "deleted" && (target.kind === "document" || target.kind === "wire"),
	);
	const deleted = deletedByResult(tool, args, answer) ?? fromArguments;
	if (deleted.length === 0) return [];
	const named = toolResultTargets(tool, answer);
	const seen = new Set<string>();
	const targets: ToolTargetV1[] = [];
	for (const target of deleted) {
		const key = `${target.kind}\u0000${target.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const title =
			target.title ?? named.find((candidate) => candidate.kind === target.kind && candidate.id === target.id)?.title;
		targets.push(title ? { ...target, title } : target);
	}
	const chunks: ToolTargetV1[][] = [];
	for (let at = 0; at < targets.length; at += DELETION_RECEIPT_CHUNK) {
		chunks.push(targets.slice(at, at + DELETION_RECEIPT_CHUNK));
	}
	return chunks.map((chunk, index) =>
		receiptFor(tool, chunk, chunks.length > 1 ? { index, of: chunks.length } : undefined),
	);
}
