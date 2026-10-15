/**
 * The voices that fail for everyone, and how the host knows (Vera's ruling, 2026-10-01: hide them).
 *
 * Two signals, both derived; neither is a list kept by hand (the operator's denylist stays for anything else):
 *
 *   the listing   no provider has served the voice in a day: every endpoint OpenRouter lists for it has no uptime
 *                 figure for the last day, and it has been listed for longer than that (or it lists no endpoint at
 *                 all). On 2026-10-01 that was true of exactly three of 270 listed voices, amazon/nova-premier-v1 (end
 *                 of life at AWS), openai/gpt-5.2-chat (its one endpoint is BYOK-only) and kwaipilot/kat-coder-pro-v2.5
 *                 (its one provider answers 400), and all three refused every call made to them; every voice that
 *                 answered carried a figure, one listed eight hours earlier included. An endpoint's `status` is not
 *                 read: every endpoint of qwen/qwen-2.5-72b-instruct was marked negative, and it answered.
 *   a refusal     what OpenRouter answered a call made with the house's key, when that answer holds for every call of
 *                 every person: an account attestation (18+), the account's data policy, the model's end of life,
 *                 endpoints that are all BYOK-only. A rate limit, a provider's 400, a 5xx, or a refusal under the
 *                 card's price or quantization rule never counts: those belong to a moment or to a request.
 *
 * A recorded refusal lapses after a day, so a voice whose cause went away (an attestation made, a policy changed) comes
 * back on its own, at the cost of at most one refused call a day, which costs its caller nothing. The reason a person
 * is shown is the host's own sentence for the kind; no part of OpenRouter's text is kept.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ChatVoiceMarket, ModelEndpointsRow } from "./chat-precision.js";

export type ChatVoiceRefusalKind =
	| "no_live_endpoint"
	| "attestation_required"
	| "data_policy"
	| "end_of_life"
	| "byok_only";

export interface ChatVoiceRefusal {
	readonly kind: ChatVoiceRefusalKind;
	readonly message: string;
}

const MESSAGES: Record<ChatVoiceRefusalKind, string> = {
	no_live_endpoint: "no provider has served this model in the last day",
	attestation_required: "the provider requires an account attestation before this model can be used",
	data_policy: "this host's data policy excludes every provider of this model",
	end_of_life: "the provider has retired this model",
	byok_only: "every provider of this model requires the caller's own provider key",
};

const DAY_MS = 24 * 3_600_000;

function refusalOf(kind: ChatVoiceRefusalKind): ChatVoiceRefusal {
	return { kind, message: MESSAGES[kind] };
}

/** A voice no provider has served in a day, read from its listing; undefined when the listing does not show that. */
export function noLiveEndpoint(row: ModelEndpointsRow | undefined): ChatVoiceRefusal | undefined {
	if (!row) return undefined;
	if (row.endpoints.length === 0) return refusalOf("no_live_endpoint");
	// Only a listing that carries the figures, for every endpoint, says anything.
	if (!row.endpoints.every((endpoint) => endpoint.uptimeLastDay === null)) return undefined;
	const listedSince = row.listedSince ? Date.parse(row.listedSince) : Number.NaN;
	const readAt = Date.parse(row.fetchedAt);
	if (!Number.isFinite(listedSince) || !Number.isFinite(readAt) || readAt - listedSince < DAY_MS) return undefined;
	return refusalOf("no_live_endpoint");
}

const ATTESTATION = /requires you to complete the following before use/i;
const DATA_POLICY = /guardrail restrictions and data policy|matching your data policy/i;
const END_OF_LIFE = /\bend of (?:its )?life\b/i;
const BYOK_ONLY = /\bBYOK-only\b/;
const REMOVED_IN_ROUTING = /\bNo endpoints found for\b[^\n]*\bEvery candidate endpoint was removed during routing\b/i;
const REQUEST_CONSTRAINT = /\bmax price\b|\bquantization\b/i;

/** The kind of an OpenRouter answer that holds for every call of every person, or undefined. */
export function classifyOpenRouterRefusal(message: string | undefined): ChatVoiceRefusal | undefined {
	if (typeof message !== "string" || !message) return undefined;
	if (/^4(?:29|00)\b/.test(message) || /^5\d\d\b/.test(message)) return undefined;
	if (ATTESTATION.test(message)) return refusalOf("attestation_required");
	if (DATA_POLICY.test(message)) return refusalOf("data_policy");
	if (END_OF_LIFE.test(message)) return refusalOf("end_of_life");
	if (BYOK_ONLY.test(message) && REMOVED_IN_ROUTING.test(message) && !REQUEST_CONSTRAINT.test(message)) {
		return refusalOf("byok_only");
	}
	return undefined;
}

interface Recorded {
	readonly kind: ChatVoiceRefusalKind;
	readonly recordedAt: string;
}

const SNAPSHOT_SCHEMA = "choreograph.chat-model-health.v1";
const KINDS = new Set<string>(Object.keys(MESSAGES));

/** The refusals the house's calls recorded, kept on disk for a day. */
export class ChatModelHealth {
	private readonly refusals = new Map<string, Recorded>();
	private readonly ttlMs: number;
	private readonly now: () => number;
	private writing: Promise<void> = Promise.resolve();

	constructor(private readonly options: { snapshotPath?: string; ttlMs?: number; now?: () => number } = {}) {
		this.ttlMs = options.ttlMs !== undefined && options.ttlMs > 0 ? options.ttlMs : DAY_MS;
		this.now = options.now ?? Date.now;
	}

	async initialize(): Promise<void> {
		if (!this.options.snapshotPath) return;
		try {
			const snapshot = JSON.parse(await readFile(this.options.snapshotPath, "utf8")) as {
				schema?: unknown;
				refusals?: unknown;
			};
			if (snapshot.schema !== SNAPSHOT_SCHEMA || typeof snapshot.refusals !== "object" || !snapshot.refusals) return;
			for (const [modelId, entry] of Object.entries(snapshot.refusals as Record<string, Recorded>)) {
				if (entry && KINDS.has(entry.kind) && typeof entry.recordedAt === "string") {
					this.refusals.set(modelId, { kind: entry.kind, recordedAt: entry.recordedAt });
				}
			}
		} catch {
			// a missing or damaged record: start with none
		}
	}

	/** Record a refusal of `modelId`; the record is on disk when the promise settles. */
	record(modelId: string, kind: ChatVoiceRefusalKind): Promise<void> {
		if (!KINDS.has(kind) || kind === "no_live_endpoint") return Promise.resolve();
		this.refusals.set(modelId, { kind, recordedAt: new Date(this.now()).toISOString() });
		this.writing = this.writing.then(
			() => this.persist(),
			() => this.persist(),
		);
		return this.writing;
	}

	refusal(modelId: string, now: number): ChatVoiceRefusal | undefined {
		const entry = this.refusals.get(modelId);
		if (!entry) return undefined;
		const age = now - Date.parse(entry.recordedAt);
		return Number.isFinite(age) && age <= this.ttlMs ? refusalOf(entry.kind) : undefined;
	}

	private async persist(): Promise<void> {
		const path = this.options.snapshotPath;
		if (!path) return;
		try {
			await mkdir(dirname(path), { recursive: true });
			const temporary = `${path}.${randomUUID()}.tmp`;
			await writeFile(
				temporary,
				JSON.stringify({ schema: SNAPSHOT_SCHEMA, refusals: Object.fromEntries(this.refusals) }),
			);
			await rename(temporary, path);
		} catch (error) {
			console.error("[chat-model-health] the record of refusals could not be written", error);
		}
	}
}

/** The host's view of each voice: its providers, and a refusal from a recorded call or from its listing. */
export function composeChatVoiceMarket(input: {
	readonly endpoints: (modelId: string) => ModelEndpointsRow | undefined;
	readonly health?: ChatModelHealth;
}): ChatVoiceMarket {
	return {
		endpoints: (modelId) => input.endpoints(modelId),
		refusal: (modelId, now) => input.health?.refusal(modelId, now) ?? noLiveEndpoint(input.endpoints(modelId)),
	};
}
