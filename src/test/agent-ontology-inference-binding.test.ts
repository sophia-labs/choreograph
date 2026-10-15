/**
 * CA-1 / Track A (A-binding) — the agent ontology (agt:) records the SESSION's
 * declared inference binding, folded straight from the persisted session row.
 *
 * NO MOCKS. Every leg exercises the REAL {@link SessionStore} (real
 * `@libsql/client` on a real on-disk file via `mkdtempSync`), the REAL S1
 * {@link SessionStoreIntentLog} discipline + `freeze()`, and the REAL Track-A
 * extension to the S5 {@link foldSessionToAgentSubject} fold. The only literal
 * values are the seeded session binding + a one-turn trace — data, not a mock.
 *
 * This is the agent-as-subject view of the resolver's `session` precedence layer:
 * the same `{provider, model}` the worker folds into `worker_config` is recorded
 * on the `agt:Session` as `agt:inferenceProvider` / `agt:inferenceModel`.
 *
 * ASSERT-BIND-A — a session created with {provider:deepseek, model:deepseek-v4-flash}
 *                 folds to a record whose `inferenceBinding` round-trips both fields,
 *                 and the SPARQL carries `agt:inferenceProvider "deepseek"` +
 *                 `agt:inferenceModel "deepseek-v4-flash"` ON the agt:Session subject,
 *                 still passing assertAgentSparql.
 * ASSERT-BIND-B — FORBIDDEN_ANATOMY still holds with the binding present (the
 *                 binding is agt:, not a substrate/foreign-vocab/key leak), AND the
 *                 DEEPSEEK_API_KEY value never appears (only the provider NAME).
 * ASSERT-BIND-C — a session pinning NO binding (provider/model both null) emits NO
 *                 inference triple — byte-identical to the pre-Track-A fold; and a
 *                 provider-only session emits ONLY agt:inferenceProvider (the
 *                 model-inherited-at-resolve-time case).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	assertAgentSparql,
	FORBIDDEN_ANATOMY,
	foldSessionInferenceBinding,
	foldSessionToAgentSubject,
	mintStandaloneAgentId,
} from "../agent-subject/agent-ontology.js";
import { SessionStoreIntentLog } from "../agent-subject/intent-log.js";
import { type SerializableMessage, SessionStore } from "../session-store.js";

function tmpDbPath(label: string): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), `ca1-A-bind-${label}-`));
	return { dir, path: join(dir, "sessions.sqlite") };
}

const COGNITO_SUB = "0a1b2c3d-cognito-sub";
const DEEPSEEK_PROVIDER = "deepseek";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
/** A realistic DEEPSEEK_API_KEY value — must NEVER appear in the fold. */
const DEEPSEEK_KEY = "sk-deepseek-0123456789abcdef0123456789abcdef";

function oneTurn(): SerializableMessage[] {
	return [{ role: "user", content: [{ type: "text", text: "think natively please" }], timestamp: 1_700_000_000_000 }];
}

/**
 * Seed a real file: libSQL session with an explicit inference binding + a one-turn
 * trace, then fold. `binding` is the stored session binding under test.
 */
async function seedAndFold(
	label: string,
	binding: { provider?: string; model?: string },
): Promise<{
	store: SessionStore;
	dir: string;
	sessionId: string;
	record: Awaited<ReturnType<typeof foldSessionToAgentSubject>>["record"];
	sparql: string;
}> {
	const { dir, path } = tmpDbPath(label);
	const store = new SessionStore(path);
	await store.init();
	const session = await store.createSession(COGNITO_SUB, {
		graphId: "sophia-code-lab",
		...(binding.model !== undefined ? { model: binding.model } : {}),
		...(binding.provider !== undefined ? { provider: binding.provider } : {}),
	});
	const log = new SessionStoreIntentLog(store, session.session_id);
	await log.append(oneTurn());

	const agentId = mintStandaloneAgentId({ name: "native-thinker" });
	const { record, sparql } = await foldSessionToAgentSubject(
		store,
		{ agentId, model: binding.model ?? "claude-opus-4-8" },
		session.session_id,
		log,
	);
	return { store, dir, sessionId: session.session_id, record, sparql };
}

describe("CA-1/A-binding — agt: records the session's inference binding (real file: libSQL, no mocks)", () => {
	it("ASSERT-BIND-A: {deepseek, deepseek-v4-flash} folds to inference triples on the agt:Session", async () => {
		const { store, dir, record, sparql } = await seedAndFold("bind-a", {
			provider: DEEPSEEK_PROVIDER,
			model: DEEPSEEK_MODEL,
		});
		after(() => rmSync(dir, { recursive: true, force: true }));

		// the structured record round-trips both fields off the session row
		assert.ok(record.inferenceBinding, "the fold carries an inferenceBinding");
		assert.equal(record.inferenceBinding?.provider, DEEPSEEK_PROVIDER);
		assert.equal(record.inferenceBinding?.model, DEEPSEEK_MODEL);

		// the SPARQL carries the binding predicates as literals
		assert.ok(
			sparql.includes(`agt:inferenceProvider "${DEEPSEEK_PROVIDER}"`),
			"agt:inferenceProvider literal === deepseek",
		);
		assert.ok(
			sparql.includes(`agt:inferenceModel "${DEEPSEEK_MODEL}"`),
			"agt:inferenceModel literal === deepseek-v4-flash",
		);

		// the binding sits ON the agt:Session subject (not a free-floating triple):
		// the inferenceProvider predicate appears AFTER `a agt:Session` and BEFORE the
		// next subject (`a agt:Turn`/`a agt:Tool`) — i.e. inside the session block.
		const sessionStart = sparql.indexOf("a agt:Session");
		const providerAt = sparql.indexOf("agt:inferenceProvider");
		const nextSubjectAt = sparql.indexOf("a agt:Turn");
		assert.ok(sessionStart >= 0 && providerAt > sessionStart, "inference predicate is after the agt:Session head");
		assert.ok(
			nextSubjectAt === -1 || providerAt < nextSubjectAt,
			"inference predicate is inside the session block (before the next subject)",
		);

		// still conformant
		const check = assertAgentSparql(sparql);
		assert.ok(check.ok, `conformant fold with a binding must pass the self-check: ${check.failures.join("; ")}`);
		store.close();
	});

	it("ASSERT-BIND-B: FORBIDDEN_ANATOMY holds with the binding present + the API KEY VALUE never leaks", async () => {
		const { store, dir, sparql } = await seedAndFold("bind-b", {
			provider: DEEPSEEK_PROVIDER,
			model: DEEPSEEK_MODEL,
		});
		after(() => rmSync(dir, { recursive: true, force: true }));

		// the provider NAME is fine (it's the binding); the KEY value is NOT — the
		// fold reads the session row, which never carries a key, so it cannot leak.
		assert.ok(!sparql.includes(DEEPSEEK_KEY), "the DEEPSEEK_API_KEY value must NOT appear in the fold");
		assert.ok(
			!/\bsk-[A-Za-z0-9_-]{16,}\b/.test(sparql),
			"no API-key pattern in the fold (binding records the NAME only)",
		);

		for (const forbidden of FORBIDDEN_ANATOMY) {
			assert.ok(!sparql.includes(forbidden), `fold with a binding must NOT emit forbidden token "${forbidden}"`);
		}
		// the provider name DOES appear (sanity: we are testing the right artifact)
		assert.ok(sparql.includes(DEEPSEEK_PROVIDER), "the provider NAME is recorded (the binding is legible)");
		store.close();
	});

	it("ASSERT-BIND-C: no-binding session emits NO inference triple; provider-only emits only the provider", async () => {
		// (1) a session pinning NEITHER provider NOR model → byte-identical to pre-Track-A
		const { store: s1, dir: d1, record: r1, sparql: noBind } = await seedAndFold("bind-c-none", {});
		after(() => rmSync(d1, { recursive: true, force: true }));
		assert.equal(r1.inferenceBinding, undefined, "no binding when the row pins neither field");
		assert.ok(!noBind.includes("agt:inferenceProvider"), "no agt:inferenceProvider when the session pins nothing");
		assert.ok(!noBind.includes("agt:inferenceModel"), "no agt:inferenceModel when the session pins nothing");
		assert.ok(assertAgentSparql(noBind).ok, "the no-binding fold is still conformant");
		s1.close();

		// (2) a session pinning ONLY a provider (model inherited at resolve time) →
		// ONLY agt:inferenceProvider is emitted.
		const {
			store: s2,
			dir: d2,
			record: r2,
			sparql: provOnly,
		} = await seedAndFold("bind-c-prov", {
			provider: DEEPSEEK_PROVIDER,
		});
		after(() => rmSync(d2, { recursive: true, force: true }));
		assert.equal(r2.inferenceBinding?.provider, DEEPSEEK_PROVIDER);
		assert.equal(r2.inferenceBinding?.model, undefined, "model omitted (inherited at resolve time)");
		assert.ok(provOnly.includes(`agt:inferenceProvider "${DEEPSEEK_PROVIDER}"`), "provider-only emits the provider");
		assert.ok(!provOnly.includes("agt:inferenceModel"), "provider-only emits NO model triple");
		assert.ok(assertAgentSparql(provOnly).ok, "the provider-only fold is conformant");
		s2.close();
	});

	it("foldSessionInferenceBinding drops null/empty fields (pure unit, no store)", () => {
		// plain rows as DATA — the pure fold the reconstruct path uses.
		assert.equal(foldSessionInferenceBinding({ provider: null, model: null }), undefined);
		assert.equal(foldSessionInferenceBinding({ provider: "", model: "" }), undefined);
		assert.deepEqual(foldSessionInferenceBinding({ provider: "deepseek", model: null }), { provider: "deepseek" });
		assert.deepEqual(foldSessionInferenceBinding({ provider: null, model: "deepseek-v4-flash" }), {
			model: "deepseek-v4-flash",
		});
		assert.deepEqual(foldSessionInferenceBinding({ provider: "deepseek", model: "deepseek-v4-flash" }), {
			provider: "deepseek",
			model: "deepseek-v4-flash",
		});
	});
});
