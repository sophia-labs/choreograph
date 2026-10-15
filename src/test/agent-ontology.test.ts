/**
 * CA-1 / S5 — agent ontology v1 (agt:) fold + serializer + self-check, against a
 * REAL file: libSQL database.
 *
 * No mocks. Every leg exercises the real {@link SessionStore} (real
 * `@libsql/client` on a real on-disk file via `mkdtempSync`), the real S1
 * {@link SessionStoreIntentLog} discipline + `freeze()`, and the real S5
 * {@link foldSessionToAgentSubject} fold. The only literal values are the seeded
 * `grow_interface` trace rows — that is data, not a mock.
 *
 * ASSERT-A  — the fold emits the agent-subject spine: agt:Agent, agt:Session,
 *             3× agt:Turn (ordinals 0/1/2), agt:ofAgent, agt:inSession,
 *             agt:usedTool → a tool subject for grow_interface (toolStatus=declared,
 *             demand-signal), and agt:ownerUserId === the seeded cognito sub —
 *             round-tripped FIELD-FOR-FIELD off the structured record, with the
 *             tool name extracted from the STRUCTURED toolName field (not regex).
 * ASSERT-B  — FORBIDDEN_ANATOMY: the sparql contains NONE of the raw message body,
 *             any CRDT/substrate token, the prefixes mnemo:/doc:, an API-key
 *             pattern, or a Pi AssistantMessage internal field — substrate-blind +
 *             no-body-leak.
 * ASSERT-C  — assertAgentSparql passes on a conformant fold and FAILS a negative
 *             case that drops agt:ofAgent. The agt:toolAccess enum is read|write.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
	assertAgentSparql,
	FORBIDDEN_ANATOMY,
	foldSessionToAgentSubject,
	mintAgentUri,
	mintCapabilityUri,
	mintStandaloneAgentId,
	mintToolUri,
	mintVoiceUri,
	serializeAgentSubject,
} from "../agent-subject/agent-ontology.js";
import { SessionStoreIntentLog } from "../agent-subject/intent-log.js";
import { type SerializableMessage, SessionStore } from "../session-store.js";

function tmpDbPath(label: string): { dir: string; path: string } {
	const dir = mkdtempSync(join(tmpdir(), `ca1-s5-${label}-`));
	return { dir, path: join(dir, "sessions.sqlite") };
}

/** The cognito sub the seeded session is owned by — round-tripped in ASSERT-A. */
const COGNITO_SUB = "0a1b2c3d-cognito-sub";

/**
 * The grow_interface trace as `SerializableMessage[]` — three turns: a user
 * asking for an interface, the agent CALLING grow_interface, and the tool result.
 * Ordinals 0/1/2. The free-text body strings are checked-against in ASSERT-B.
 */
const USER_BODY = "give me an interface please";
const ASSISTANT_BODY_HINT = "growing-you-a-panel"; // would only appear if a body leaked

function growInterfaceTrace(): SerializableMessage[] {
	const t0 = 1_700_000_000_000;
	return [
		{
			role: "user",
			content: [{ type: "text", text: USER_BODY }],
			timestamp: t0,
		},
		{
			role: "assistant",
			// A real assistant turn: a toolCall block (the structured toolName the fold
			// extracts) plus an internal `errorMessage` field that MUST NOT leak.
			content: [
				{ type: "text", text: ASSISTANT_BODY_HINT },
				{ type: "toolCall", toolCallId: "call_grow_1", toolName: "grow_interface", args: { component: "panel" } },
			],
			usage: { input: 11, output: 7, totalTokens: 18 },
			stopReason: "toolUse",
			model: "claude-opus-4-8",
			timestamp: t0 + 1000,
		},
		{
			role: "toolResult",
			content: {
				toolCallId: "call_grow_1",
				toolName: "grow_interface",
				isError: false,
				content: "panel grown: panel-1",
			},
			timestamp: t0 + 2000,
		},
	];
}

/**
 * Seed a fresh real file: libSQL store with a session owned by COGNITO_SUB and the
 * grow_interface trace, then fold it. Returns the fold result + the store handles
 * so the caller can assert and close.
 */
async function seedAndFold(label: string): Promise<{
	store: SessionStore;
	dir: string;
	sessionId: string;
	agentId: string;
	record: Awaited<ReturnType<typeof foldSessionToAgentSubject>>["record"];
	sparql: string;
}> {
	const { dir, path } = tmpDbPath(label);
	const store = new SessionStore(path);
	await store.init();
	const session = await store.createSession(COGNITO_SUB, {
		graphId: "sophia-code-lab",
		model: "claude-opus-4-8",
	});
	const log = new SessionStoreIntentLog(store, session.session_id);
	await log.append(growInterfaceTrace());

	// Identity comes from the registered Agent object, never its mutable model or prompt.
	const agentId = mintStandaloneAgentId({ name: "interface-grower" });

	const { record, sparql } = await foldSessionToAgentSubject(
		store,
		{ agentId, model: "claude-opus-4-8" },
		session.session_id,
		log,
	);
	return { store, dir, sessionId: session.session_id, agentId, record, sparql };
}

describe("CA-1/S5 agent ontology v1 (agt:) fold (real file: libSQL, no mocks)", () => {
	it("mints registered agent identity independently of model and prompt revisions", () => {
		const first = mintStandaloneAgentId({ name: "Phanes" });
		const second = mintStandaloneAgentId({ name: "  Phanes  " });
		assert.equal(first, second);
		assert.match(first, /^agent-[0-9a-f]{16}$/);
		assert.notEqual(first, mintStandaloneAgentId({ name: "Hoja" }));
		assert.throws(() => mintStandaloneAgentId({ name: "  " }), /non-empty registered agent name/);
	});

	it("ASSERT-A: the fold emits the agent-subject spine, round-tripped field-for-field", async () => {
		const { store, dir, sessionId, agentId, record, sparql } = await seedAndFold("assert-a");
		after(() => rmSync(dir, { recursive: true, force: true }));

		// ── the structured record (the value behind the SPARQL) ──────────────
		assert.equal(record.agentId, agentId, "agentId is the registered Agent id, not the session id");
		assert.equal(record.model, "claude-opus-4-8");
		assert.equal(record.sessionId, sessionId);
		assert.equal(record.ownerUserId, COGNITO_SUB, "ownerUserId === the seeded cognito sub");
		assert.equal(record.graphId, "sophia-code-lab");
		assert.equal(record.turnCount, 3, "three turns folded");
		assert.deepEqual(
			record.turns.map((t) => t.ordinal),
			[0, 1, 2],
			"turn ordinals 0/1/2 in append order",
		);
		assert.deepEqual(
			record.turns.map((t) => t.role),
			["user", "assistant", "toolResult"],
			"turn roles in append order",
		);

		// grow_interface was extracted from the STRUCTURED toolName field on BOTH the
		// assistant toolCall block and the toolResult envelope — never by regexing a body.
		assert.equal(record.turns[1].usedTool, "grow_interface", "assistant turn used grow_interface (structured)");
		assert.equal(
			record.turns[2].usedTool,
			"grow_interface",
			"toolResult turn references grow_interface (structured)",
		);
		assert.equal(record.turns[0].usedTool, undefined, "the plain user turn used no tool");

		// grow_interface appears as a DECLARED Tool subject (demand-signal): it is the
		// default declared tool AND it was used → status flips to "used"? No — the
		// declared default is the demand-signal; the trace USING it means it is "used".
		// The DECLARED demand-signal property is proven by the negative-fold test below;
		// here we assert the tool subject exists with the read|write access enum.
		const growTool = record.tools.find((t) => t.toolName === "grow_interface");
		assert.ok(growTool, "a grow_interface tool subject exists");
		assert.equal(growTool?.access, "write", "grow_interface access is write (a member of read|write)");
		assert.ok(["read", "write"].includes(growTool!.access), "tool access is in the read|write enum");

		// ── the serialized SPARQL ────────────────────────────────────────────
		assert.match(sparql, /a agt:Agent, prov:Agent/, "emits an agt:Agent (also prov:Agent)");
		assert.match(sparql, /a agt:Session/, "emits an agt:Session");
		assert.equal((sparql.match(/a agt:Turn/g) ?? []).length, 3, "emits exactly 3 agt:Turn subjects");

		// the load-bearing edges
		assert.match(sparql, /agt:ofAgent /, "agt:ofAgent wires session/tool/capability → agent");
		assert.match(sparql, /agt:inSession /, "agt:inSession wires turn → session");
		assert.match(sparql, /agt:usedTool /, "agt:usedTool points a turn at a tool subject");

		// the usedTool pointer targets the grow_interface tool subject URI
		const toolUriFragment = `:tool:grow_interface`;
		assert.ok(sparql.includes(toolUriFragment), "the tool subject URI carries the grow_interface slug");

		// ownerUserId === the seeded cognito sub, present in the SPARQL literal too
		assert.ok(sparql.includes(`agt:ownerUserId "${COGNITO_SUB}"`), "ownerUserId literal === cognito sub");

		// ordinals 0/1/2 present as typed turn ordinals
		for (const ord of [0, 1, 2]) {
			assert.ok(
				sparql.includes(`agt:ordinal "${ord}"^^xsd:integer`),
				`agt:ordinal ${ord} present as a typed literal`,
			);
		}

		store.close();
	});

	it("ASSERT-A (declared demand-signal): a tool DECLARED but never used keeps toolStatus=declared", async () => {
		// A fresh session that NEVER calls grow_interface still mints it as a DECLARED
		// tool subject — the demand-signal posture (grow_interface exists as a subject
		// before it is ever invoked).
		const { dir, path } = tmpDbPath("declared");
		after(() => rmSync(dir, { recursive: true, force: true }));
		const store = new SessionStore(path);
		await store.init();
		const session = await store.createSession(COGNITO_SUB, { model: "claude-opus-4-8" });
		const log = new SessionStoreIntentLog(store, session.session_id);
		// Only a plain user turn — no tool usage.
		await log.append([{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 }]);

		const agentId = mintStandaloneAgentId({ name: "declared-interface-grower" });
		const { record, sparql } = await foldSessionToAgentSubject(
			store,
			{ agentId, model: "claude-opus-4-8" },
			session.session_id,
			log,
		);

		const grow = record.tools.find((t) => t.toolName === "grow_interface");
		assert.ok(grow, "grow_interface is still minted as a tool subject when never used");
		assert.equal(grow?.status, "declared", "toolStatus=declared (demand-signal) when never invoked");
		assert.ok(sparql.includes(`agt:toolStatus "declared"`), "the SPARQL carries the declared status");
		store.close();
	});

	it("ASSERT-B: FORBIDDEN_ANATOMY — substrate-blind, no body leak, no foreign vocab, no key", async () => {
		const { store, dir, sparql } = await seedAndFold("assert-b");
		after(() => rmSync(dir, { recursive: true, force: true }));

		// The raw free-text message bodies MUST NOT appear (Turn carries pointers,
		// not the body). Both the user text and the assistant text hint are absent.
		assert.ok(!sparql.includes(USER_BODY), "the raw user message body must NOT leak into agt: triples");
		assert.ok(
			!sparql.includes(ASSISTANT_BODY_HINT),
			"the raw assistant message body must NOT leak into agt: triples",
		);

		// No substrate token, no foreign-vocab prefix, no Pi AssistantMessage internal field.
		for (const forbidden of FORBIDDEN_ANATOMY) {
			assert.ok(!sparql.includes(forbidden), `fold must NOT emit forbidden token "${forbidden}"`);
		}

		// No OpenAI/OpenRouter-style API-key pattern.
		assert.ok(!/\bsk-[A-Za-z0-9_-]{16,}\b/.test(sparql), "no OpenAI/OpenRouter-style API key pattern in the fold");

		// The usage object (a Pi-internal envelope) must not leak its fields either.
		assert.ok(!sparql.includes("totalTokens"), "Pi usage envelope fields do not leak");
		assert.ok(!sparql.includes("cacheWrite"), "Pi usage envelope fields do not leak");
		store.close();
	});

	it("ASSERT-C: assertAgentSparql passes a conformant fold and FAILS when agt:ofAgent is dropped", async () => {
		const { store, dir, record, sparql } = await seedAndFold("assert-c");
		after(() => rmSync(dir, { recursive: true, force: true }));

		// Positive: the conformant fold passes the self-check.
		const ok = assertAgentSparql(sparql);
		assert.ok(ok.ok, `conformant fold must pass the self-check: ${ok.failures.join("; ")}`);
		assert.deepEqual(ok.failures, [], "no failures on a conformant fold");

		// Negative: drop EVERY agt:ofAgent edge → the session/tool/capability is
		// dangling. The self-check MUST fail (this is the load-bearing negative case).
		const broken = sparql.replace(/\n\tagt:ofAgent <[^>]*> ;/g, "");
		assert.ok(!broken.includes("agt:ofAgent "), "the negative case genuinely removed agt:ofAgent");
		const bad = assertAgentSparql(broken);
		assert.ok(!bad.ok, "self-check FAILS when agt:ofAgent is dropped");
		assert.ok(
			bad.failures.some((f) => f.includes("agt:ofAgent")),
			`a failure must name the missing agt:ofAgent edge: ${bad.failures.join("; ")}`,
		);

		// The toolAccess enum is read|write only: serialize a record and confirm the
		// self-check accepts read|write and rejects a smuggled value.
		const conformant = serializeAgentSubject(record);
		assert.ok(assertAgentSparql(conformant).ok, "a re-serialized record stays conformant");
		const tampered = conformant.replace(/agt:toolAccess "write"/, 'agt:toolAccess "dangerous"');
		const tamperedResult = assertAgentSparql(tampered);
		assert.ok(!tamperedResult.ok, "self-check FAILS a forbidden toolAccess value");
		assert.ok(
			tamperedResult.failures.some((f) => f.includes("dangerous")),
			"a failure names the forbidden toolAccess value",
		);
		store.close();
	});
});

// ─── Registered identity + witness IRI (pure URI/mint unit tests, no I/O) ─────
describe("CA-1 registered Agent identity + witness-IRI byte-match", () => {
	it("identity is registered-name stable and independent of inference manifestation", () => {
		const first = mintStandaloneAgentId({ name: "Phanes" });
		const promoted = mintStandaloneAgentId({ name: "  Phanes  " });
		assert.equal(first, promoted);
		assert.notEqual(first, mintStandaloneAgentId({ name: "Phanes Emanation" }));
		assert.match(first, /^agent-[0-9a-f]{16}$/);
	});

	it("mintAgentUri byte-matches L0's observer_iri stem (urn:sophia:agent:)", () => {
		assert.equal(
			mintAgentUri("agent-deadbeef"),
			"urn:sophia:agent:agent-deadbeef",
			"subject IRI uses the unified urn:sophia:agent: stem, not urn:sophia:agt:agent:",
		);
		// And for a registered id the subject IRI is exactly urn:sophia:agent:{id}.
		const id = mintStandaloneAgentId({ name: "Phanes" });
		assert.equal(mintAgentUri(id), `urn:sophia:agent:${id}`);
	});

	it("tool + capability IRIs are sub-paths of the agent IRI (derived, not re-inlined)", () => {
		const agentUri = mintAgentUri("agent-deadbeef");
		const toolUri = mintToolUri("agent-deadbeef", "grow_interface");
		const capUri = mintCapabilityUri("agent-deadbeef", "write");
		const voiceUri = mintVoiceUri("agent-deadbeef", "monovocal");
		assert.ok(toolUri.startsWith(`${agentUri}:`), `tool IRI is a sub-path of the agent IRI: ${toolUri}`);
		assert.ok(capUri.startsWith(`${agentUri}:`), `capability IRI is a sub-path of the agent IRI: ${capUri}`);
		assert.ok(voiceUri.startsWith(`${agentUri}:`), `voice IRI is a sub-path of the agent IRI: ${voiceUri}`);
		assert.equal(toolUri, "urn:sophia:agent:agent-deadbeef:tool:grow_interface");
		assert.equal(capUri, "urn:sophia:agent:agent-deadbeef:cap:write");
		assert.equal(voiceUri, "urn:sophia:agent:agent-deadbeef:voice:monovocal");
		// No occurrence of the stale stem in any minted IRI.
		assert.ok(!toolUri.includes("agt:agent:"), "tool IRI does not carry the stale agt:agent: stem");
		assert.ok(!agentUri.includes("agt:agent:"), "agent IRI does not carry the stale agt:agent: stem");
		assert.throws(() => mintVoiceUri("agent-deadbeef", "voice:bad"), /non-canonical IRI segment/);
	});

	it("mintAgentUri rejects a non-canonical agent id (latent slug-divergence guard)", () => {
		// A non-canonical token (space, colon, @, full IRI, uppercase, bare/edge dash)
		// sanitizes DIFFERENTLY in L1 `slug` vs L0 `observer_segment`, which would
		// silently split the agt:Agent IRI from its mem:observedBy witness. The guard
		// turns that into a loud failure instead.
		for (const bad of [
			"agent id",
			"agent:x",
			"weird@@token",
			"urn:sophia:agent:x",
			"AGENT-DEADBEEF",
			"agent-",
			"-agent-x",
			"agent-xyz",
		]) {
			assert.throws(
				() => mintAgentUri(bad),
				/non-canonical agent id/,
				`mintAgentUri must reject ${JSON.stringify(bad)}`,
			);
		}
		// Canonical tokens (the registered identity shape + the fixture) still mint cleanly.
		assert.equal(mintAgentUri("agent-deadbeef"), "urn:sophia:agent:agent-deadbeef");
		const id = mintStandaloneAgentId({ name: "Phanes" });
		assert.equal(mintAgentUri(id), `urn:sophia:agent:${id}`);
	});
});
