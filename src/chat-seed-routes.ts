/**
 * `POST /api/chat-seeds` — the seed store's door.
 *
 * The body is the seed document's bytes (`sophia.chat-seed.v1`, see `chat-seed.ts`),
 * posted as they are. The response is `{ digest, bytes, expiresAt }`: 201 the first
 * time these bytes are stored for the caller, 200 when they already were (the same
 * bytes from the same person are the same seed). The seed is the caller's alone:
 * it is stored under the acting user the gateway authenticated.
 *
 * The gateway forwards at most 1 MiB of any Choreograph request body, and that is the
 * binding limit; the cap here (`CHAT_SEED_MAX_BYTES`) sits below it, checked against the
 * declared length before reading and again while counting a streamed body.
 *
 * Errors: 413 `seed_too_large`, 400 `seed_invalid`. A message never quotes the body.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendCodedError, sendJson } from "./chat-http.js";
import { CHAT_SEED_MAX_BYTES, ChatSeedFault } from "./chat-seed.js";
import type { WorkflowRuntimeStore } from "./workflow/runtime-store.js";

export interface ChatSeedPutRequest {
	readonly runtime: WorkflowRuntimeStore;
	readonly request: IncomingMessage;
	readonly response: ServerResponse;
	/** The acting person the gateway authenticated: the seed's owner. */
	readonly ownerUserId: string;
	readonly now?: () => number;
}

export async function handleChatSeedPut(input: ChatSeedPutRequest): Promise<void> {
	const { runtime, request, response, ownerUserId } = input;
	const body = await readBoundedBody(request, CHAT_SEED_MAX_BYTES);
	if (body === "too-large") {
		sendCodedError(response, 413, "seed_too_large", `a seed is at most ${CHAT_SEED_MAX_BYTES} bytes`);
		return;
	}
	try {
		const stored = await runtime.putChatSeed({ ownerUserId, bytes: body, now: (input.now ?? Date.now)() });
		response.setHeader("cache-control", "private, no-store");
		sendJson(response, stored.created ? 201 : 200, {
			digest: stored.digest,
			bytes: stored.bytes,
			expiresAt: stored.expiresAt,
		});
	} catch (error) {
		if (error instanceof ChatSeedFault) {
			sendCodedError(response, error.status, error.code, error.message);
			return;
		}
		throw error;
	}
}

/**
 * Read a request body, refusing more than `maxBytes`. The declared length is checked
 * first; a body with no (or a false) length is counted as it streams. Past the cap the
 * rest is drained without being kept, and the request is never destroyed, so the 413
 * can still reach the client on the same connection.
 */
async function readBoundedBody(request: IncomingMessage, maxBytes: number): Promise<Buffer | "too-large"> {
	const declared = Number(request.headers["content-length"]);
	if (Number.isFinite(declared) && declared > maxBytes) return "too-large";
	const chunks: Buffer[] = [];
	let total = 0;
	let tooLarge = false;
	const iterator = request[Symbol.asyncIterator]();
	for (;;) {
		const step = await iterator.next();
		if (step.done) break;
		const chunk: Buffer = typeof step.value === "string" ? Buffer.from(step.value) : step.value;
		total += chunk.length;
		if (total > maxBytes) {
			tooLarge = true;
			chunks.length = 0;
		} else if (!tooLarge) {
			chunks.push(chunk);
		}
	}
	return tooLarge ? "too-large" : Buffer.concat(chunks, total);
}
