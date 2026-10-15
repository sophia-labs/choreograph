import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
	CHAT_SEED_DIGEST_PATTERN,
	CHAT_SEED_MAX_BYTES,
	CHAT_SEED_MAX_MESSAGES,
	CHAT_SEED_MAX_UNCLAIMED_PER_OWNER,
	CHAT_SEED_SCHEMA,
	CHAT_SEED_UNCLAIMED_TTL_MS,
	ChatSeedFault,
	digestChatSeedBytes,
	prepareChatSeed,
} from "../chat-seed.js";
import { beginChat, withRoutes, withRuntime } from "./chat-runtime-fixture.js";
import {
	AWKWARD_TEXT,
	FORGED_STRUCTURE,
	INJECTED_INSTRUCTIONS,
	SEED_MARKER,
} from "./fixtures/adversarial-chat-seed-strings.fixture.js";

/**
 * The seed store (Sobremesa sub-task 2): what a browser hands Choreograph so a new
 * chat can continue an old one without the transcript ever travelling through the
 * run journal, the start payload, the event log or a checkpoint.
 *
 * Content-addressed (sha256 of the exact bytes), owner-only, capped below the
 * gateway's binding 1 MiB body limit, one-hour TTL while unclaimed, and a claimed
 * seed lives exactly as long as its Session. Real store, real router, no mocks.
 */

const T0 = 1_790_000_000_000;

const MESSAGES = [
	{
		role: "user",
		text: "What did we decide about the ferry timetable?",
		occurredAt: "2026-07-01T10:00:00Z",
		voice: null,
	},
	{
		role: "assistant",
		text: "You decided to keep the winter schedule until March.",
		occurredAt: "2026-07-01T10:00:05Z",
		voice: { model: "moonshotai/kimi-k2.5" },
	},
];

function seedBytes(over: { messages?: unknown; schema?: unknown; extra?: Record<string, unknown> } = {}): Buffer {
	return Buffer.from(
		JSON.stringify({
			schema: over.schema ?? CHAT_SEED_SCHEMA,
			messages: over.messages ?? MESSAGES,
			...(over.extra ?? {}),
		}),
		"utf8",
	);
}

function faultOf(run: () => unknown): ChatSeedFault | undefined {
	try {
		run();
	} catch (error) {
		if (error instanceof ChatSeedFault) return error;
		throw error;
	}
	return undefined;
}

// ─── The seed document ───────────────────────────────────────────────────────

describe("the seed document", () => {
	it("is addressed by the sha256 of its exact bytes", () => {
		const bytes = seedBytes();
		const digest = digestChatSeedBytes(bytes);
		assert.match(digest, CHAT_SEED_DIGEST_PATTERN);
		assert.equal(digest, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
		assert.notEqual(digest, digestChatSeedBytes(seedBytes({ extra: { note: "different bytes" } })));
	});

	it("states its limits below the gateway's 1 MiB body cap and a one-hour unclaimed lifetime", () => {
		assert.ok(CHAT_SEED_MAX_BYTES < 1_048_576, "the cap sits below the binding gateway limit");
		assert.ok(CHAT_SEED_MAX_BYTES >= 262_144, "and is still roomy enough for a real window");
		assert.equal(CHAT_SEED_UNCLAIMED_TTL_MS, 3_600_000);
		assert.ok(CHAT_SEED_MAX_MESSAGES >= 500);
	});

	it("parses messages with role, date and voice, and keeps hostile text as plain data", () => {
		const hostile = [...INJECTED_INSTRUCTIONS, ...FORGED_STRUCTURE, ...AWKWARD_TEXT.slice(0, 4), SEED_MARKER];
		const prepared = prepareChatSeed(
			seedBytes({
				messages: [...MESSAGES, ...hostile.map((text) => ({ role: "user", text, occurredAt: null, voice: null }))],
			}),
		);
		assert.equal(prepared.document.messages.length, MESSAGES.length + hostile.length);
		assert.deepEqual(prepared.document.messages[0], {
			role: "user",
			text: MESSAGES[0].text,
			occurredAt: "2026-07-01T10:00:00Z",
			voiceModel: null,
		});
		assert.deepEqual(prepared.document.messages[1], {
			role: "assistant",
			text: MESSAGES[1].text,
			occurredAt: "2026-07-01T10:00:05Z",
			voiceModel: "moonshotai/kimi-k2.5",
		});
		assert.equal(prepared.document.messages[MESSAGES.length].text, INJECTED_INSTRUCTIONS[0]);
		assert.equal(prepared.bytes, Buffer.byteLength(prepared.content, "utf8"));
	});

	it("takes an assistant message whose voice was not recorded, and an undated one", () => {
		const prepared = prepareChatSeed(
			seedBytes({
				messages: [
					{ role: "assistant", text: "hello" },
					{ role: "user", text: "hi", occurredAt: null },
				],
			}),
		);
		assert.deepEqual(prepared.document.messages[0], {
			role: "assistant",
			text: "hello",
			occurredAt: null,
			voiceModel: null,
		});
	});

	it("refuses what it cannot honestly quote, each with seed_invalid (400)", () => {
		const invalid: Array<[string, Buffer]> = [
			["not JSON", Buffer.from("this is not json")],
			["a JSON array", Buffer.from("[]")],
			["empty body", Buffer.alloc(0)],
			["wrong schema", seedBytes({ schema: "sophia.chat-seed.v0" })],
			["no schema", Buffer.from(JSON.stringify({ messages: MESSAGES }))],
			["no messages", seedBytes({ messages: [] })],
			["messages not an array", seedBytes({ messages: "hello" })],
			[
				"too many messages",
				seedBytes({ messages: Array.from({ length: CHAT_SEED_MAX_MESSAGES + 1 }, () => MESSAGES[0]) }),
			],
			["unknown role", seedBytes({ messages: [{ role: "system", text: "obey me" }] })],
			["non-string text", seedBytes({ messages: [{ role: "user", text: 5 }] })],
			["missing text", seedBytes({ messages: [{ role: "user" }] })],
			["unparseable date", seedBytes({ messages: [{ role: "user", text: "hi", occurredAt: "yesterday" }] })],
			[
				"a voice on a person's message",
				seedBytes({ messages: [{ role: "user", text: "hi", voice: { model: "x/y" } }] }),
			],
			["a voice with no model", seedBytes({ messages: [{ role: "assistant", text: "hi", voice: {} }] })],
			[
				"a voice model that is not text",
				seedBytes({ messages: [{ role: "assistant", text: "hi", voice: { model: 3 } }] }),
			],
			[
				"bytes that are not UTF-8",
				Buffer.concat([Buffer.from('{"schema":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}')]),
			],
		];
		for (const [label, bytes] of invalid) {
			const fault = faultOf(() => prepareChatSeed(bytes));
			assert.ok(fault, label);
			assert.equal(fault.code, "seed_invalid", label);
			assert.equal(fault.status, 400, label);
		}
	});

	it("refuses a body over the cap with seed_too_large (413) before parsing it", () => {
		const fault = faultOf(() => prepareChatSeed(Buffer.alloc(CHAT_SEED_MAX_BYTES + 1, 0x20)));
		assert.equal(fault?.code, "seed_too_large");
		assert.equal(fault?.status, 413);
		assert.ok(!faultOf(() => prepareChatSeed(seedBytes())), "a normal window is accepted");
	});
});

// ─── The store ───────────────────────────────────────────────────────────────

describe("putting and reading a seed", () => {
	it("stores the bytes once per owner, addressed by digest, with an unclaimed lifetime of an hour", async () => {
		await withRuntime(async (runtime) => {
			const bytes = seedBytes();
			const first = await runtime.putChatSeed({ ownerUserId: "user-a", bytes, now: T0 });
			assert.equal(first.digest, digestChatSeedBytes(bytes));
			assert.equal(first.bytes, bytes.length);
			assert.equal(first.created, true);
			assert.equal(first.expiresAt, T0 + CHAT_SEED_UNCLAIMED_TTL_MS);

			const again = await runtime.putChatSeed({ ownerUserId: "user-a", bytes, now: T0 + 60_000 });
			assert.equal(again.digest, first.digest);
			assert.equal(again.created, false, "the same bytes from the same owner are the same seed");
			assert.equal(
				again.expiresAt,
				T0 + 60_000 + CHAT_SEED_UNCLAIMED_TTL_MS,
				"putting it again refreshes the lifetime",
			);

			const stored = await runtime.readChatSeed({ ownerUserId: "user-a", digest: first.digest, now: T0 + 1 });
			assert.ok(stored);
			assert.equal(stored.bytes, bytes.length);
			assert.equal(stored.content, bytes.toString("utf8"));
			assert.equal(stored.claimed, false);
			const peeked = await runtime.peekChatSeed({ ownerUserId: "user-a", digest: first.digest, now: T0 + 1 });
			assert.deepEqual(peeked, {
				digest: first.digest,
				bytes: bytes.length,
				claimed: false,
				expiresAt: T0 + 60_000 + CHAT_SEED_UNCLAIMED_TTL_MS,
			});
		});
	});

	it("is owner-only: another person cannot read, peek at or tell that a seed exists", async () => {
		await withRuntime(async (runtime) => {
			const bytes = seedBytes({ extra: { note: SEED_MARKER } });
			const mine = await runtime.putChatSeed({ ownerUserId: "user-a", bytes, now: T0 });
			assert.equal(await runtime.readChatSeed({ ownerUserId: "user-b", digest: mine.digest, now: T0 }), null);
			assert.equal(await runtime.peekChatSeed({ ownerUserId: "user-b", digest: mine.digest, now: T0 }), null);
			// The same bytes from the other person are THEIR seed, a separate row.
			const theirs = await runtime.putChatSeed({ ownerUserId: "user-b", bytes, now: T0 });
			assert.equal(theirs.digest, mine.digest);
			assert.equal(theirs.created, true);
			const rows = await runtime.raw("SELECT owner_user_id FROM chat_seeds ORDER BY owner_user_id");
			assert.deepEqual(
				rows.rows.map((row) => String(row.owner_user_id)),
				["user-a", "user-b"],
			);
		});
	});

	it("does not serve an unclaimed seed after its hour, even before it has been reaped", async () => {
		await withRuntime(async (runtime) => {
			const stored = await runtime.putChatSeed({ ownerUserId: "user-a", bytes: seedBytes(), now: T0 });
			const justBefore = T0 + CHAT_SEED_UNCLAIMED_TTL_MS - 1;
			assert.ok(await runtime.readChatSeed({ ownerUserId: "user-a", digest: stored.digest, now: justBefore }));
			const expired = T0 + CHAT_SEED_UNCLAIMED_TTL_MS;
			assert.equal(await runtime.readChatSeed({ ownerUserId: "user-a", digest: stored.digest, now: expired }), null);
			assert.equal(await runtime.peekChatSeed({ ownerUserId: "user-a", digest: stored.digest, now: expired }), null);
		});
	});

	it("reserves a seed for admission: an unclaimed seed's hour is renewed from now, a claimed seed is left as it is, and what read refuses it refuses", async () => {
		await withRuntime(async (runtime) => {
			const seed = await runtime.putChatSeed({ ownerUserId: "user-a", bytes: seedBytes(), now: T0 });
			const reserved = await runtime.reserveChatSeed({
				ownerUserId: "user-a",
				digest: seed.digest,
				now: T0 + 60_000,
			});
			assert.ok(reserved);
			assert.equal(reserved.claimed, false);
			assert.equal(reserved.expiresAt, T0 + 60_000 + CHAT_SEED_UNCLAIMED_TTL_MS);
			assert.equal(reserved.content, seedBytes().toString("utf8"));
			assert.ok(
				await runtime.readChatSeed({
					ownerUserId: "user-a",
					digest: seed.digest,
					now: T0 + CHAT_SEED_UNCLAIMED_TTL_MS,
				}),
				"it would have expired at T0 + 1h, and has been given a new hour",
			);

			// A claimed seed's lifetime is its Session's: nothing is moved.
			const chat = await beginChat(runtime, { n: 1, now: T0 + 70_000 });
			await runtime.claimChatSeed({
				sessionId: chat.sessionId,
				ownerUserId: "user-a",
				digest: seed.digest,
				now: T0 + 70_000,
			});
			const before = await runtime.raw("SELECT expires_at FROM chat_seeds WHERE digest = ?", [seed.digest]);
			const again = await runtime.reserveChatSeed({ ownerUserId: "user-a", digest: seed.digest, now: T0 + 80_000 });
			assert.equal(again?.claimed, true);
			const after = await runtime.raw("SELECT expires_at FROM chat_seeds WHERE digest = ?", [seed.digest]);
			assert.deepEqual(after.rows[0], before.rows[0]);

			// Refusals are read's refusals: someone else's, never put, and expired.
			assert.equal(await runtime.reserveChatSeed({ ownerUserId: "user-b", digest: seed.digest, now: T0 + 1 }), null);
			assert.equal(
				await runtime.reserveChatSeed({ ownerUserId: "user-a", digest: `sha256:${"0".repeat(64)}`, now: T0 + 1 }),
				null,
			);
			const stale = await runtime.putChatSeed({
				ownerUserId: "user-a",
				bytes: seedBytes({ extra: { n: 9 } }),
				now: T0,
			});
			assert.equal(
				await runtime.reserveChatSeed({
					ownerUserId: "user-a",
					digest: stale.digest,
					now: T0 + CHAT_SEED_UNCLAIMED_TTL_MS,
				}),
				null,
			);
			assert.equal(
				(await runtime.raw("SELECT expires_at FROM chat_seeds WHERE digest = ?", [stale.digest])).rows[0]
					.expires_at,
				T0 + CHAT_SEED_UNCLAIMED_TTL_MS,
				"a refusal renews nothing",
			);
		});
	});

	it("holds at most 16 seeds a person has not used: a newer upload displaces the oldest, never a claimed seed", async () => {
		await withRuntime(async (runtime) => {
			const LIMIT = CHAT_SEED_MAX_UNCLAIMED_PER_OWNER;
			assert.equal(LIMIT, 16);
			const claimedSeed = await runtime.putChatSeed({
				ownerUserId: "user-a",
				bytes: seedBytes({ extra: { n: "claimed" } }),
				now: T0 - 1_000,
			});
			const chat = await beginChat(runtime, { n: 1 });
			await runtime.claimChatSeed({
				sessionId: chat.sessionId,
				ownerUserId: "user-a",
				digest: claimedSeed.digest,
				now: T0 - 500,
			});
			const someoneElses = await runtime.putChatSeed({
				ownerUserId: "user-b",
				bytes: seedBytes({ extra: { n: "theirs" } }),
				now: T0 - 1_000,
			});
			const digests: string[] = [];
			for (let n = 0; n < LIMIT + 4; n++) {
				const put = await runtime.putChatSeed({
					ownerUserId: "user-a",
					bytes: seedBytes({ extra: { n } }),
					now: T0 + n,
				});
				assert.equal(put.created, true);
				digests.push(put.digest);
			}
			const held = async (owner: string) =>
				(
					await runtime.raw(
						"SELECT digest FROM chat_seeds WHERE owner_user_id = ? AND first_claimed_at IS NULL ORDER BY expires_at, digest",
						[owner],
					)
				).rows.map((row) => String(row.digest));
			assert.deepEqual(await held("user-a"), digests.slice(4), "the sixteen newest are kept, the four oldest went");
			for (const gone of digests.slice(0, 4)) {
				assert.equal(await runtime.readChatSeed({ ownerUserId: "user-a", digest: gone, now: T0 + 100 }), null);
			}
			assert.ok(
				await runtime.readChatSeed({ ownerUserId: "user-a", digest: claimedSeed.digest, now: T0 + 100 }),
				"a seed a Session has claimed is not counted and not displaced",
			);
			assert.ok(
				await runtime.readChatSeed({ ownerUserId: "user-b", digest: someoneElses.digest, now: T0 + 100 }),
				"another person's seeds are not this person's to displace",
			);

			// Putting a seed the person already holds moves nothing out, and keeps it among the newest.
			const again = await runtime.putChatSeed({
				ownerUserId: "user-a",
				bytes: seedBytes({ extra: { n: LIMIT + 3 } }),
				now: T0 + 200,
			});
			assert.equal(again.created, false);
			assert.equal((await held("user-a")).length, LIMIT);
		});
	});

	it("holds exactly 16 when seeds share one instant, however their digests sort: the newest upload is always among them", async () => {
		await withRuntime(async (runtime) => {
			const LIMIT = CHAT_SEED_MAX_UNCLAIMED_PER_OWNER;
			const made = Array.from({ length: LIMIT + 1 }, (_, n) => {
				const bytes = seedBytes({ extra: { n } });
				return { bytes, digest: digestChatSeedBytes(bytes) };
			}).sort((a, b) => (a.digest < b.digest ? -1 : 1));
			// The sixteen that sort highest arrive first; the one that sorts lowest arrives last, in the same millisecond.
			const [newest, ...existing] = made;
			for (const entry of existing) {
				await runtime.putChatSeed({ ownerUserId: "user-a", bytes: entry.bytes, now: T0 });
			}
			await runtime.putChatSeed({ ownerUserId: "user-a", bytes: newest.bytes, now: T0 });
			const held = (
				await runtime.raw(
					"SELECT digest FROM chat_seeds WHERE owner_user_id = ? AND first_claimed_at IS NULL ORDER BY digest",
					["user-a"],
				)
			).rows.map((row) => String(row.digest));
			assert.equal(held.length, LIMIT, "no more than the cap, whatever the order the digests sort in");
			assert.ok(held.includes(newest.digest), "the seed just put is never the one displaced");
		});
	});

	it("never holds more than 16 however many seeds arrive in one instant", async () => {
		await withRuntime(async (runtime) => {
			const LIMIT = CHAT_SEED_MAX_UNCLAIMED_PER_OWNER;
			for (let n = 0; n < 60; n++) {
				const put = await runtime.putChatSeed({
					ownerUserId: "user-a",
					bytes: seedBytes({ extra: { n } }),
					now: T0,
				});
				const held = await runtime.raw(
					"SELECT digest FROM chat_seeds WHERE owner_user_id = ? AND first_claimed_at IS NULL",
					["user-a"],
				);
				assert.ok(held.rows.length <= LIMIT, `after ${n + 1} puts, ${held.rows.length} are held`);
				assert.ok(
					held.rows.some((row) => String(row.digest) === put.digest),
					`put ${n} is held`,
				);
			}
		});
	});

	it("refuses an invalid or over-cap body without storing anything", async () => {
		await withRuntime(async (runtime) => {
			await assert.rejects(
				runtime.putChatSeed({ ownerUserId: "user-a", bytes: Buffer.from("nope"), now: T0 }),
				(error: unknown) => error instanceof ChatSeedFault && error.code === "seed_invalid",
			);
			await assert.rejects(
				runtime.putChatSeed({ ownerUserId: "user-a", bytes: Buffer.alloc(CHAT_SEED_MAX_BYTES + 1, 0x20), now: T0 }),
				(error: unknown) => error instanceof ChatSeedFault && error.code === "seed_too_large",
			);
			const rows = await runtime.raw("SELECT COUNT(*) AS n FROM chat_seeds");
			assert.equal(Number(rows.rows[0].n), 0);
		});
	});
});

describe("claiming a seed for a Session", () => {
	it("binds it to the Session, after which the Session (and only it) can resolve the bytes", async () => {
		await withRuntime(async (runtime) => {
			const bytes = seedBytes();
			const seed = await runtime.putChatSeed({ ownerUserId: "user-a", bytes, now: T0 });
			const chat = await beginChat(runtime, { n: 1 });
			await runtime.claimChatSeed({
				sessionId: chat.sessionId,
				ownerUserId: "user-a",
				digest: seed.digest,
				bytes: seed.bytes,
				now: T0 + 1,
			});
			const resolved = await runtime.readChatSeedForSession({
				sessionId: chat.sessionId,
				ownerUserId: "user-a",
				digest: seed.digest,
			});
			assert.equal(resolved, bytes.toString("utf8"));
			assert.equal(
				(await runtime.peekChatSeed({ ownerUserId: "user-a", digest: seed.digest, now: T0 + 2 }))?.claimed,
				true,
			);

			const other = await beginChat(runtime, { n: 2 });
			assert.equal(
				await runtime.readChatSeedForSession({
					sessionId: other.sessionId,
					ownerUserId: "user-a",
					digest: seed.digest,
				}),
				null,
				"a Session that did not claim it cannot resolve it",
			);
			assert.equal(
				await runtime.readChatSeedForSession({
					sessionId: chat.sessionId,
					ownerUserId: "user-b",
					digest: seed.digest,
				}),
				null,
				"nor can anyone under another identity",
			);
		});
	});

	it("keeps a claimed seed past its unclaimed hour", async () => {
		await withRuntime(async (runtime) => {
			const seed = await runtime.putChatSeed({ ownerUserId: "user-a", bytes: seedBytes(), now: T0 });
			const chat = await beginChat(runtime, { n: 1 });
			await runtime.claimChatSeed({
				sessionId: chat.sessionId,
				ownerUserId: "user-a",
				digest: seed.digest,
				now: T0 + 1,
			});
			const muchLater = T0 + 30 * 24 * 3_600_000;
			assert.ok(await runtime.readChatSeed({ ownerUserId: "user-a", digest: seed.digest, now: muchLater }));
			const reaped = await runtime.reapChatSeeds({ now: muchLater });
			assert.equal(reaped.expired, 0);
			assert.ok(await runtime.readChatSeed({ ownerUserId: "user-a", digest: seed.digest, now: muchLater }));
		});
	});

	it("is idempotent for the same Session and seed, and refuses a second, different seed", async () => {
		await withRuntime(async (runtime) => {
			const one = await runtime.putChatSeed({ ownerUserId: "user-a", bytes: seedBytes(), now: T0 });
			const two = await runtime.putChatSeed({
				ownerUserId: "user-a",
				bytes: seedBytes({ extra: { n: 2 } }),
				now: T0,
			});
			const chat = await beginChat(runtime, { n: 1 });
			const claim = (digest: string) =>
				runtime.claimChatSeed({ sessionId: chat.sessionId, ownerUserId: "user-a", digest, now: T0 + 1 });
			await claim(one.digest);
			await claim(one.digest);
			await assert.rejects(
				claim(two.digest),
				(error: unknown) => error instanceof ChatSeedFault && error.code === "seed_claim_conflict",
			);
			const claims = await runtime.raw("SELECT COUNT(*) AS n FROM chat_seed_claims");
			assert.equal(Number(claims.rows[0].n), 1);
		});
	});

	it("lets two Sessions of one owner share a seed when they start from the same window", async () => {
		await withRuntime(async (runtime) => {
			const seed = await runtime.putChatSeed({ ownerUserId: "user-a", bytes: seedBytes(), now: T0 });
			const first = await beginChat(runtime, { n: 1 });
			const second = await beginChat(runtime, { n: 2 });
			for (const chat of [first, second]) {
				await runtime.claimChatSeed({
					sessionId: chat.sessionId,
					ownerUserId: "user-a",
					digest: seed.digest,
					now: T0 + 1,
				});
			}
			for (const chat of [first, second]) {
				assert.ok(
					await runtime.readChatSeedForSession({
						sessionId: chat.sessionId,
						ownerUserId: "user-a",
						digest: seed.digest,
					}),
				);
			}
		});
	});

	it("says a seed was not found the same way whether it never existed, expired, or belongs to someone else", async () => {
		await withRuntime(async (runtime) => {
			const seed = await runtime.putChatSeed({ ownerUserId: "user-a", bytes: seedBytes(), now: T0 });
			const theirs = await beginChat(runtime, { n: 1, owner: "user-b" });
			const mine = await beginChat(runtime, { n: 2 });
			const notFound = (error: unknown) =>
				error instanceof ChatSeedFault && error.code === "seed_not_found" && error.status === 404;
			// Another person's Session cannot claim my digest.
			await assert.rejects(
				runtime.claimChatSeed({
					sessionId: theirs.sessionId,
					ownerUserId: "user-b",
					digest: seed.digest,
					now: T0 + 1,
				}),
				notFound,
			);
			// A digest that never existed.
			await assert.rejects(
				runtime.claimChatSeed({
					sessionId: mine.sessionId,
					ownerUserId: "user-a",
					digest: `sha256:${"0".repeat(64)}`,
					now: T0 + 1,
				}),
				notFound,
			);
			// My own seed after its hour.
			await assert.rejects(
				runtime.claimChatSeed({
					sessionId: mine.sessionId,
					ownerUserId: "user-a",
					digest: seed.digest,
					now: T0 + CHAT_SEED_UNCLAIMED_TTL_MS,
				}),
				notFound,
			);
		});
	});

	it("refuses a claim whose byte count is not the stored one, and a claim for a Session that is not the claimant's", async () => {
		await withRuntime(async (runtime) => {
			const seed = await runtime.putChatSeed({ ownerUserId: "user-a", bytes: seedBytes(), now: T0 });
			const mine = await beginChat(runtime, { n: 1 });
			await assert.rejects(
				runtime.claimChatSeed({
					sessionId: mine.sessionId,
					ownerUserId: "user-a",
					digest: seed.digest,
					bytes: seed.bytes + 1,
					now: T0 + 1,
				}),
				(error: unknown) =>
					error instanceof ChatSeedFault && error.code === "seed_bytes_mismatch" && error.status === 409,
			);
			const theirs = await beginChat(runtime, { n: 2, owner: "user-b" });
			await assert.rejects(
				runtime.claimChatSeed({
					sessionId: theirs.sessionId,
					ownerUserId: "user-a",
					digest: seed.digest,
					now: T0 + 1,
				}),
				(error: unknown) => error instanceof ChatSeedFault && error.code === "seed_claim_invalid",
			);
			await assert.rejects(
				runtime.claimChatSeed({
					sessionId: "ags-no-such-session",
					ownerUserId: "user-a",
					digest: seed.digest,
					now: T0 + 1,
				}),
				(error: unknown) => error instanceof ChatSeedFault && error.code === "seed_claim_invalid",
			);
		});
	});
});

describe("a claim counts only while its Session is open or closing", () => {
	const closeSession = (runtime: { raw: (sql: string, args?: unknown[]) => Promise<unknown> }, sessionId: string) =>
		runtime.raw(
			`UPDATE agent_sessions SET lifecycle_state = 'closed', lifecycle_terminal_digest = 'sha256:x' WHERE session_id = ?`,
			[sessionId],
		);

	it("does not keep an expired seed alive, or let a new Session claim it, once its only Session has closed and before the reaper runs", async () => {
		await withRuntime(async (runtime) => {
			const seed = await runtime.putChatSeed({ ownerUserId: "user-a", bytes: seedBytes(), now: T0 });
			const first = await beginChat(runtime, { n: 1, now: T0 + 1 });
			await runtime.claimChatSeed({
				sessionId: first.sessionId,
				ownerUserId: "user-a",
				digest: seed.digest,
				now: T0 + 2,
			});
			const afterItsHour = T0 + CHAT_SEED_UNCLAIMED_TTL_MS + 1;
			assert.equal(
				(await runtime.peekChatSeed({ ownerUserId: "user-a", digest: seed.digest, now: afterItsHour }))?.claimed,
				true,
				"while its Session is open the seed lives past the hour",
			);

			await closeSession(runtime, first.sessionId);
			assert.equal(
				await runtime.peekChatSeed({ ownerUserId: "user-a", digest: seed.digest, now: afterItsHour }),
				null,
				"a closed Session's claim is not a reason to serve it",
			);
			assert.equal(
				await runtime.readChatSeed({ ownerUserId: "user-a", digest: seed.digest, now: afterItsHour }),
				null,
			);
			const second = await beginChat(runtime, { n: 2, now: afterItsHour });
			await assert.rejects(
				runtime.claimChatSeed({
					sessionId: second.sessionId,
					ownerUserId: "user-a",
					digest: seed.digest,
					now: afterItsHour,
				}),
				(error: unknown) => error instanceof ChatSeedFault && error.code === "seed_not_found",
			);
		});
	});

	it("keeps a seed that is put again after its last Session closed: the reaper does not take what was just renewed", async () => {
		await withRuntime(async (runtime) => {
			const bytes = seedBytes();
			const seed = await runtime.putChatSeed({ ownerUserId: "user-a", bytes, now: T0 });
			const chat = await beginChat(runtime, { n: 1, now: T0 + 1 });
			await runtime.claimChatSeed({
				sessionId: chat.sessionId,
				ownerUserId: "user-a",
				digest: seed.digest,
				now: T0 + 2,
			});
			await closeSession(runtime, chat.sessionId);

			const again = await runtime.putChatSeed({ ownerUserId: "user-a", bytes, now: T0 + 5_000 });
			assert.equal(again.created, false);
			const reaped = await runtime.reapChatSeeds({ now: T0 + 6_000 });
			assert.equal(reaped.deletedClaimed, 0, "a seed put again is fresh and unclaimed, not an orphan");
			const kept = await runtime.readChatSeed({ ownerUserId: "user-a", digest: seed.digest, now: T0 + 6_000 });
			assert.ok(kept, "the renewed seed survived the reaper");
			assert.equal(kept.claimed, false);
			assert.equal(kept.expiresAt, T0 + 5_000 + CHAT_SEED_UNCLAIMED_TTL_MS);
			// And it is still subject to its hour like any unclaimed seed.
			const later = await runtime.reapChatSeeds({ now: T0 + 5_000 + CHAT_SEED_UNCLAIMED_TTL_MS });
			assert.equal(later.expired, 1);
		});
	});
});

describe("a claimed seed is deleted with its Session", () => {
	it("reaps unclaimed seeds after their hour and leaves fresh ones", async () => {
		await withRuntime(async (runtime) => {
			const stale = await runtime.putChatSeed({
				ownerUserId: "user-a",
				bytes: seedBytes({ extra: { n: 1 } }),
				now: T0,
			});
			const fresh = await runtime.putChatSeed({
				ownerUserId: "user-a",
				bytes: seedBytes({ extra: { n: 2 } }),
				now: T0 + CHAT_SEED_UNCLAIMED_TTL_MS,
			});
			const result = await runtime.reapChatSeeds({ now: T0 + CHAT_SEED_UNCLAIMED_TTL_MS + 1 });
			assert.equal(result.expired, 1);
			const digests = await runtime.raw("SELECT digest FROM chat_seeds");
			assert.deepEqual(
				digests.rows.map((row) => String(row.digest)),
				[fresh.digest],
			);
			assert.notEqual(stale.digest, fresh.digest);
		});
	});

	it("deletes the seed when its last Session closes, and keeps it while another open Session needs it", async () => {
		await withRuntime(async (runtime) => {
			const seed = await runtime.putChatSeed({ ownerUserId: "user-a", bytes: seedBytes(), now: T0 });
			const first = await beginChat(runtime, { n: 1 });
			const second = await beginChat(runtime, { n: 2 });
			for (const chat of [first, second]) {
				await runtime.claimChatSeed({
					sessionId: chat.sessionId,
					ownerUserId: "user-a",
					digest: seed.digest,
					now: T0 + 1,
				});
			}
			const close = (sessionId: string) =>
				runtime.raw(
					`UPDATE agent_sessions SET lifecycle_state = 'closed', lifecycle_terminal_digest = 'sha256:x' WHERE session_id = ?`,
					[sessionId],
				);
			const later = T0 + 5_000;
			await close(first.sessionId);
			const afterFirst = await runtime.reapChatSeeds({ now: later });
			assert.equal(afterFirst.releasedClaims, 1);
			assert.ok(
				await runtime.readChatSeed({ ownerUserId: "user-a", digest: seed.digest, now: later }),
				"still needed",
			);
			assert.equal(
				await runtime.readChatSeedForSession({
					sessionId: first.sessionId,
					ownerUserId: "user-a",
					digest: seed.digest,
				}),
				null,
			);

			await close(second.sessionId);
			const afterSecond = await runtime.reapChatSeeds({ now: later + 1 });
			assert.equal(afterSecond.releasedClaims, 1);
			assert.equal(afterSecond.deletedClaimed, 1);
			const left = await runtime.raw("SELECT COUNT(*) AS n FROM chat_seeds");
			assert.equal(Number(left.rows[0].n), 0, "the seed went with the last Session that used it");
			const claims = await runtime.raw("SELECT COUNT(*) AS n FROM chat_seed_claims");
			assert.equal(Number(claims.rows[0].n), 0);
		});
	});

	it("does not touch a seed whose Session is merely closing, only one that is closed or gone", async () => {
		await withRuntime(async (runtime) => {
			const seed = await runtime.putChatSeed({ ownerUserId: "user-a", bytes: seedBytes(), now: T0 });
			const chat = await beginChat(runtime, { n: 1 });
			await runtime.claimChatSeed({
				sessionId: chat.sessionId,
				ownerUserId: "user-a",
				digest: seed.digest,
				now: T0 + 1,
			});
			await runtime.raw("UPDATE agent_sessions SET lifecycle_state = 'closing' WHERE session_id = ?", [
				chat.sessionId,
			]);
			const closing = await runtime.reapChatSeeds({ now: T0 + 10 });
			assert.equal(closing.releasedClaims, 0);
			assert.ok(await runtime.readChatSeed({ ownerUserId: "user-a", digest: seed.digest, now: T0 + 10 }));
		});
	});
});

describe("where the seed's bytes live", () => {
	it("only in chat_seeds: a marker in the seed reaches no other table, through put, claim and a begun Session", async () => {
		await withRuntime(async (runtime) => {
			const bytes = seedBytes({
				messages: [
					...MESSAGES,
					{ role: "user", text: `${SEED_MARKER} ${INJECTED_INSTRUCTIONS[0]}`, occurredAt: null },
				],
			});
			const seed = await runtime.putChatSeed({ ownerUserId: "user-a", bytes, now: T0 });
			const chat = await beginChat(runtime, { n: 1 });
			await runtime.claimChatSeed({
				sessionId: chat.sessionId,
				ownerUserId: "user-a",
				digest: seed.digest,
				now: T0 + 1,
			});
			await runtime.appendAgentSessionEvent(chat.sessionId, { type: "message.completed", ts: T0 + 2, payload: {} });

			const dump = await runtime.dumpTables();
			assert.ok(dump.chat_seeds.includes(SEED_MARKER), "the store itself holds the bytes");
			for (const [table, text] of Object.entries(dump)) {
				if (table === "chat_seeds") continue;
				assert.equal(text.includes(SEED_MARKER), false, `${table} must not hold seed bytes`);
			}
		});
	});
});

// ─── The route ───────────────────────────────────────────────────────────────

describe("POST /api/chat-seeds", () => {
	it("stores the posted bytes for the caller and returns { digest, bytes, expiresAt }", async () => {
		await withRoutes(async ({ runtime, post }) => {
			const bytes = seedBytes();
			const before = Date.now();
			const created = await post("/api/chat-seeds", bytes);
			assert.equal(created.statusCode, 201, JSON.stringify(created.body));
			assert.equal(created.headers["cache-control"], "private, no-store");
			assert.equal(created.body.digest, digestChatSeedBytes(bytes));
			assert.equal(created.body.bytes, bytes.length);
			assert.ok(created.body.expiresAt >= before + CHAT_SEED_UNCLAIMED_TTL_MS);
			assert.deepEqual(Object.keys(created.body).sort(), ["bytes", "digest", "expiresAt"]);

			const again = await post("/api/chat-seeds", bytes);
			assert.equal(again.statusCode, 200, "the same bytes again are the same seed");
			assert.equal(again.body.digest, created.body.digest);

			const stored = await runtime.readChatSeed({
				ownerUserId: "user-a",
				digest: created.body.digest,
				now: Date.now(),
			});
			assert.equal(stored?.content, bytes.toString("utf8"));
			assert.equal(
				await runtime.readChatSeed({ ownerUserId: "user-b", digest: created.body.digest, now: Date.now() }),
				null,
			);
		});
	});

	it("reads a streamed body in several chunks and hashes the exact bytes", async () => {
		await withRoutes(async ({ post }) => {
			const bytes = seedBytes({ messages: [...MESSAGES, { role: "user", text: "é ü ñ 🙂".repeat(50) }] });
			const response = await post("/api/chat-seeds", bytes, {}, 37);
			assert.equal(response.statusCode, 201);
			assert.equal(response.body.digest, digestChatSeedBytes(bytes));
			assert.equal(response.body.bytes, bytes.length);
		});
	});

	it("refuses an oversized body with 413 seed_too_large, by declared length and by counting a streamed one", async () => {
		await withRoutes(async ({ runtime, post }) => {
			const declared = await post("/api/chat-seeds", Buffer.alloc(16), {
				"content-length": String(CHAT_SEED_MAX_BYTES + 1),
			});
			assert.equal(declared.statusCode, 413);
			assert.equal(declared.body.error.code, "seed_too_large");

			const streamed = await post("/api/chat-seeds", Buffer.alloc(CHAT_SEED_MAX_BYTES + 1, 0x20), {}, 65_536);
			assert.equal(streamed.statusCode, 413);
			assert.equal(streamed.body.error.code, "seed_too_large");
			const rows = await runtime.raw("SELECT COUNT(*) AS n FROM chat_seeds");
			assert.equal(Number(rows.rows[0].n), 0, "nothing was stored");
		});
	});

	it("refuses a body that is not a seed with 400 seed_invalid, and no credentials with 401", async () => {
		await withRoutes(async ({ post }) => {
			for (const body of [
				Buffer.alloc(0),
				Buffer.from("not json"),
				seedBytes({ messages: [] }),
				seedBytes({ schema: "x" }),
			]) {
				const response = await post("/api/chat-seeds", body);
				assert.equal(response.statusCode, 400);
				assert.equal(response.body.error.code, "seed_invalid");
			}
			const anonymous = await post("/api/chat-seeds", seedBytes(), { "x-internal-service": "" });
			assert.equal(anonymous.statusCode, 401);
			assert.deepEqual(Object.keys(anonymous.body.error).sort(), ["code", "message"]);
			assert.equal(anonymous.body.error.code, "unauthenticated");
			assert.equal(anonymous.headers["www-authenticate"], 'Bearer realm="choreograph"');
		});
	});

	it("answers every authentication failure in the coded envelope a client reads error.code from", async () => {
		await withRoutes(async ({ post }) => {
			const body = seedBytes();
			const wrongSecret = await post("/api/chat-seeds", body, { "x-internal-service": "not-the-secret" });
			assert.equal(wrongSecret.statusCode, 400);
			assert.equal(wrongSecret.body.error.code, "invalid_credentials");
			assert.match(wrongSecret.body.error.message, /X-Internal-Service/);
			const noUser = await post("/api/chat-seeds", body, { "x-user-id": "" });
			assert.equal(noUser.statusCode, 400);
			assert.equal(noUser.body.error.code, "invalid_credentials");
		});
	});

	it("leaves the other routes' authentication errors as they were: the coded envelope is the chat doors' own", async () => {
		await withRoutes(async ({ get }) => {
			const anonymous = await get("/api/workflows/runs", { "x-internal-service": "" });
			assert.equal(anonymous.statusCode, 401);
			assert.equal(
				typeof anonymous.body.error,
				"string",
				"a route that predates the chat doors keeps its flat error",
			);
		});
	});

	it("does not log or echo the seed's text in any response", async () => {
		await withRoutes(async ({ post }) => {
			const marked = seedBytes({ messages: [{ role: "user", text: SEED_MARKER }] });
			const ok = await post("/api/chat-seeds", marked);
			assert.equal(JSON.stringify(ok.body).includes(SEED_MARKER), false);
			const bad = await post(
				"/api/chat-seeds",
				Buffer.from(`{"schema":"nope","messages":[{"text":"${SEED_MARKER}"}]}`),
			);
			assert.equal(bad.statusCode, 400);
			assert.equal(JSON.stringify(bad.body).includes(SEED_MARKER), false, "an error never quotes the body");
		});
	});
});
