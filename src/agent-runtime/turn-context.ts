/**
 * What the person has open, carried with a turn as its own part (Vera's ruling D5, 2026-10-06): the ids of the
 * documents, artifacts, folders or blocks in their view, never free text. The SPA sends them with every turn: the first
 * (the invocation's `input.contextRefs`) and each later one (`payload.contextRefs` on a `prompt` or `follow_up`
 * command).
 *
 * The host renders them into the text the model is given, once, and nowhere else. The durable transcript, the chat's
 * title and the mirrored input event keep the person's own words, so a reload never shows the note as something the
 * person wrote. A reference that is not id-shaped is kept in the request as sent but never rendered: nothing the
 * person's client sends reaches the model as prose.
 */

/** At most this many references in one request (the invocation's existing rule). */
export const TURN_CONTEXT_REFS_MAX = 100;
/** At most this many are named to the model. */
export const TURN_CONTEXT_REFS_RENDERED = 8;
/** A document, artifact or folder id, optionally `#` a block id: the cell's id grammar (garden `ids.rs`). */
const ID_REF = /^[A-Za-z0-9_-]{1,128}(?:#[A-Za-z0-9_-]{1,128})?$/;

export class TurnContextRefsError extends Error {
	readonly code = "context_refs_invalid";
	readonly status = 400;
}

/**
 * A request's `contextRefs`. Absent or null is none; otherwise an array of at most 100 non-empty strings, or the
 * caller's 400. The array is returned as sent: which entries the model sees is `turnTextForModel`'s rule.
 */
export function parseTurnContextRefs(value: unknown): readonly string[] | undefined {
	if (value === undefined || value === null) return undefined;
	if (
		!Array.isArray(value) ||
		value.length > TURN_CONTEXT_REFS_MAX ||
		value.some((ref) => typeof ref !== "string" || !ref)
	) {
		throw new TurnContextRefsError(
			`contextRefs must be an array of at most ${TURN_CONTEXT_REFS_MAX} non-empty strings`,
		);
	}
	return value as string[];
}

/** The references the model is told about: id-shaped only, each once, in order, at most eight. */
export function renderableTurnContextRefs(refs: readonly string[] | undefined): string[] {
	if (!refs) return [];
	return [...new Set(refs.filter((ref) => typeof ref === "string" && ID_REF.test(ref)))].slice(
		0,
		TURN_CONTEXT_REFS_RENDERED,
	);
}

/**
 * The text a turn is given to the model with: the person's words, then (when they have something open) one note
 * naming it by id, so "this document" resolves. With nothing renderable it is exactly the person's words.
 */
export function turnTextForModel(text: string, refs: readonly string[] | undefined): string {
	const named = renderableTurnContextRefs(refs);
	if (named.length === 0) return text;
	return `${text}\n\n(Open in the person's view, by id: ${named.map((ref) => `\`${ref}\``).join(", ")}. "This document" means the first.)`;
}

/**
 * A read of the bound graph, as the person (the session's own mode-gated backend, or the run's graph proxy): a tool name
 * and its arguments, answered as the cell answers (an MCP result, `isError` for a refusal) or thrown.
 */
export type TurnContextRefReader = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

/** The object an MCP result carries, when it carries one. */
function resultObject(result: unknown): Record<string, unknown> | undefined {
	if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
	const value = result as Record<string, unknown>;
	if (value.structuredContent && typeof value.structuredContent === "object") {
		return value.structuredContent as Record<string, unknown>;
	}
	const first = Array.isArray(value.content) ? (value.content[0] as { text?: unknown } | undefined) : undefined;
	if (typeof first?.text === "string" && first.text.trim().startsWith("{")) {
		try {
			return JSON.parse(first.text) as Record<string, unknown>;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * The refs the model may be told are open (exam 1): the renderable ones (id-shaped, each once, at most eight), each
 * admitted only when the bound graph answers a read of it for the person. A document is read (`read_document`, ids only,
 * one block); `doc#block` reads the block (`get_block`). A ref is admitted only on a parsed answer that names that
 * document (and block); a refusal, an error, a throw, or an answer naming another or none drops it; with no reader,
 * nothing is named. The person's own words are never affected.
 */
export async function admitTurnContextRefs(
	refs: readonly string[] | undefined,
	read: TurnContextRefReader | undefined,
): Promise<string[]> {
	const candidates = renderableTurnContextRefs(refs);
	if (!read || candidates.length === 0) return [];
	const admitted = await Promise.all(
		candidates.map(async (ref) => {
			const [documentId, blockId] = ref.split("#") as [string, string | undefined];
			try {
				const result = blockId
					? await read("get_block", { documentId, blockId })
					: await read("read_document", { document_id: documentId, format: "ids_only", limit: 1 });
				if (!result || typeof result !== "object" || (result as { isError?: unknown }).isError === true) {
					return false;
				}
				// Affirmative evidence only (exam 2, E): a parsed answer that names this document and, for `doc#block`, this
				// block. An answer that names nothing (prose, an empty object, an unparseable text) proves nothing.
				const named = resultObject(result);
				if (!named) return false;
				const answeredFor = named.document_id ?? named.documentId;
				if (answeredFor !== documentId) return false;
				if (blockId === undefined) return true;
				const block =
					named.block && typeof named.block === "object" ? (named.block as Record<string, unknown>) : {};
				const answeredBlock = block.id ?? block.blockId ?? block.block_id ?? named.block_id ?? named.blockId;
				return answeredBlock === blockId;
			} catch {
				return false;
			}
		}),
	);
	return candidates.filter((_, index) => admitted[index]);
}
