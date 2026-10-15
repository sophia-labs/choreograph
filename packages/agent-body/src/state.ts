/**
 * The body's restorable state, in the shape the host verifies and commits as an agent checkpoint
 * (`sophia.prime-runtime-state.v2`, `src/agent-runtime/result-validation.ts`): the pi session's header and entries,
 * pinned to the request's bindings, digested canonically. A later generation of the same session is handed this
 * state back (`runtime.restore`) and continues from it; the process that wrote it is gone by then.
 */

import { createHash } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { canonicalJson } from "@sophia-labs/canonical-json";
import type { PrimeRuntimeStateV2 } from "../../../src/agent-runtime/result-validation.js";
import type { AgentSpawnRequest } from "../../../src/wire-protocol.js";

export const RUNTIME_STATE_SCHEMA = "sophia.prime-runtime-state.v2" as const;

export function runtimeState(
	request: AgentSpawnRequest,
	sessionManager: Pick<SessionManager, "getHeader" | "getEntries">,
	workerSequence: number,
	now: Date = new Date(),
): PrimeRuntimeStateV2 {
	const sessionHeader = sessionManager.getHeader();
	if (!sessionHeader) throw new Error("the pi session has no header");
	// Digest exactly what crosses the bridge: JSON drops `undefined`, so the digest is taken after a round trip.
	const unsigned = JSON.parse(
		JSON.stringify({
			schema: RUNTIME_STATE_SCHEMA,
			sessionId: request.session_id,
			sandboxId: request.spawn_id,
			generation: request.generation,
			runtimeBindingDigest: request.runtime_binding_digest,
			ontologyBindingDigest: request.agent_ontology_binding_digest,
			sessionHeader,
			...(request.embodiment_binding_digest ? { embodimentDigest: request.embodiment_binding_digest } : {}),
			...(request.runtime_overlays
				? { runtimeOverlayDigests: request.runtime_overlays.map((overlay) => overlay.artifactDigest) }
				: {}),
			entries: sessionManager.getEntries(),
			// This body keeps no goal or autonomy state; the fields stay for the checkpoint's shape.
			goal: null,
			autonomous: null,
			workerSequence,
			createdAt: now.toISOString(),
		}),
	) as Omit<PrimeRuntimeStateV2, "digest">;
	return { ...unsigned, digest: digestCanonical(unsigned) };
}

/** Check a state the host hands back before the body builds a session on it. */
export function assertRestorableState(
	state: PrimeRuntimeStateV2,
	request: AgentSpawnRequest,
	sessionRevision: number,
): void {
	if (state.schema !== RUNTIME_STATE_SCHEMA) throw new Error("the restore state has an unsupported schema");
	if (state.sessionId !== request.session_id) throw new Error("the restore state belongs to another session");
	if (!Number.isSafeInteger(state.generation) || state.generation >= request.generation) {
		throw new Error("the restore state must come from an earlier generation");
	}
	if (state.workerSequence !== sessionRevision) throw new Error("the restore revision does not match the state");
	if (state.runtimeBindingDigest !== request.runtime_binding_digest) {
		throw new Error("the restore state was made under another runtime binding");
	}
	if (state.ontologyBindingDigest !== request.agent_ontology_binding_digest) {
		throw new Error("the restore state was made under another Agent Ontology binding");
	}
	const header = state.sessionHeader as { type?: unknown } | null;
	if (!header || typeof header !== "object" || header.type !== "session")
		throw new Error("the restore state has no session header");
	if (!Array.isArray(state.entries)) throw new Error("the restore state has no entries");
	const { digest, ...unsigned } = state;
	if (digest !== digestCanonical(unsigned)) throw new Error("the restore state does not match its digest");
}

export function digestCanonical(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
