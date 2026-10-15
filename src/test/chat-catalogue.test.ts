import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { InStatement } from "@libsql/client";
import {
	CHAT_SESSION_LIST_MAX_LIMIT,
	CHAT_TITLE_AUTO_MAX_CHARS,
	CHAT_TITLE_EXPLICIT_MAX_CHARS,
	CHAT_UNTITLED,
	CHAT_WORKFLOW_NAMES,
	ChatSessionQueryError,
	decodeChatSessionCursor,
	deriveChatTitle,
	encodeChatSessionCursor,
	isOtherChatOwner,
	normalizeExplicitChatTitle,
	parseChatSessionListQuery,
} from "../chat-catalogue.js";
import { routeRequest } from "../orchestrator.js";
import type { WriteMode } from "../persistence/libsql-store.js";
import { type ChatBackfillCandidate, WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import { DOMAIN_AGENT_ACTIVITY_LOOP_NAME } from "../workflow/script-domain-agent-activity-loop.js";
import { agentSessionCommandActivationId } from "../workflow/session-transcript.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { WORKSPACE_CHAT_WORKFLOW_NAME } from "../workflow/workspace-chat.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

/**
 * The chat session catalogue (Sobremesa sub-task 1): every chat Agent Session
 * carries a title, its resolved model and provider, `createdAt` and
 * `lastActivityAt`, and a person can list their own chats per graph, newest
 * first and paged. Real stores and the real router; no mocks.
 */

// ─── Pure: titles, cursor, query, owner check ────────────────────────────────

describe("chat titles", () => {
	it("takes the first message, whitespace collapsed", () => {
		assert.equal(deriveChatTitle("  What   is\n in\tthis workspace?  "), "What is in this workspace?");
	});

	it("names an empty first message rather than leaving a blank row", () => {
		assert.equal(deriveChatTitle("   \n\t "), CHAT_UNTITLED);
		assert.equal(deriveChatTitle(""), CHAT_UNTITLED);
	});

	it("cuts a long message to about 80 characters at a word boundary, with an ellipsis", () => {
		const title = deriveChatTitle("alpha ".repeat(50));
		assert.ok(Array.from(title).length <= CHAT_TITLE_AUTO_MAX_CHARS, title);
		assert.ok(title.endsWith("…"));
		assert.ok(!title.endsWith(" …"));
		assert.ok(
			title
				.slice(0, -1)
				.split(" ")
				.every((word) => word === "alpha"),
			"no word is cut in half",
		);
	});

	it("leaves an exactly-80-character message alone and cuts one character more", () => {
		const exact = "x".repeat(CHAT_TITLE_AUTO_MAX_CHARS);
		assert.equal(deriveChatTitle(exact), exact);
		const over = deriveChatTitle("x".repeat(CHAT_TITLE_AUTO_MAX_CHARS + 1));
		assert.equal(Array.from(over).length, CHAT_TITLE_AUTO_MAX_CHARS);
		assert.ok(over.endsWith("…"));
	});

	it("counts code points, never splitting a surrogate pair", () => {
		const title = deriveChatTitle("🙂".repeat(100));
		assert.equal(Array.from(title).length, CHAT_TITLE_AUTO_MAX_CHARS);
		assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(title), "no lone high surrogate");
		assert.ok(!/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(title), "no lone low surrogate");
	});

	it("drops control characters", () => {
		assert.equal(deriveChatTitle("a\u0000b\u0007c"), "abc");
	});

	it("leaves no double space where a control character sat between two words", () => {
		assert.equal(deriveChatTitle("a \u0007 b"), "a b");
		assert.equal(deriveChatTitle("one\u0000 \u0007 two\u007F three"), "one two three");
		assert.equal(normalizeExplicitChatTitle("Old \u0007 chat"), "Old chat");
		assert.equal(deriveChatTitle("\u0007 \u0000 \u0007"), CHAT_UNTITLED);
	});

	it("normalizes an explicit title, caps it, and ignores a blank or non-string one", () => {
		assert.equal(normalizeExplicitChatTitle(undefined), undefined);
		assert.equal(normalizeExplicitChatTitle(5), undefined);
		assert.equal(normalizeExplicitChatTitle("   "), undefined);
		assert.equal(normalizeExplicitChatTitle("  Old chat\n· continued "), "Old chat · continued");
		const capped = normalizeExplicitChatTitle("t".repeat(CHAT_TITLE_EXPLICIT_MAX_CHARS + 100));
		assert.equal(Array.from(capped ?? "").length, CHAT_TITLE_EXPLICIT_MAX_CHARS);
	});
});

describe("chat session cursor and list query", () => {
	it("round-trips a cursor and refuses anything this route did not issue", () => {
		const cursor = { lastActivityAt: 1_790_000_000_000, sessionId: "ags_abc" };
		assert.deepEqual(decodeChatSessionCursor(encodeChatSessionCursor(cursor)), cursor);
		assert.equal(decodeChatSessionCursor("not a cursor!!"), undefined);
		assert.equal(
			decodeChatSessionCursor(`${encodeChatSessionCursor(cursor)}!!!!`),
			undefined,
			"trailing characters the base64url decoder ignores are not a cursor this route issued",
		);
		assert.equal(decodeChatSessionCursor(`%${encodeChatSessionCursor(cursor)}`), undefined);
		assert.equal(decodeChatSessionCursor(`${encodeChatSessionCursor(cursor)}=`), undefined, "nor is a padded one");
		const forge = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
		assert.equal(decodeChatSessionCursor(forge({ t: 1.5, s: "x" })), undefined);
		assert.equal(decodeChatSessionCursor(forge({ t: -1, s: "x" })), undefined);
		assert.equal(decodeChatSessionCursor(forge({ t: 1, s: "" })), undefined);
		assert.equal(decodeChatSessionCursor(forge({ t: "1", s: "x" })), undefined);
		assert.equal(decodeChatSessionCursor(forge([1, "x"])), undefined);
	});

	it("defaults to a page of 50 and bounds the limit", () => {
		assert.deepEqual(parseChatSessionListQuery(new URLSearchParams("view=chat-sessions")), { limit: 50 });
		assert.equal(parseChatSessionListQuery(new URLSearchParams("limit=100")).limit, CHAT_SESSION_LIST_MAX_LIMIT);
		for (const bad of ["0", "101", "abc", "-1", "1.5", "99999"]) {
			assert.throws(
				() => parseChatSessionListQuery(new URLSearchParams(`limit=${bad}`)),
				(error: unknown) => error instanceof ChatSessionQueryError && error.code === "invalid_limit",
				bad,
			);
		}
	});

	it("accepts a graph, a workflow and a cursor, and refuses malformed ones with a code", () => {
		const cursor = encodeChatSessionCursor({ lastActivityAt: 5, sessionId: "ags_x" });
		const parsed = parseChatSessionListQuery(
			new URLSearchParams(`graph_id=angels&workflow=workspace-chat-v1&cursor=${cursor}&limit=7`),
		);
		assert.deepEqual(parsed, {
			limit: 7,
			cursor: { lastActivityAt: 5, sessionId: "ags_x" },
			graphId: "angels",
			workflow: "workspace-chat-v1",
		});
		const codeOf = (query: string) => {
			try {
				parseChatSessionListQuery(new URLSearchParams(query));
			} catch (error) {
				return error instanceof ChatSessionQueryError ? error.code : "other";
			}
			return "none";
		};
		assert.equal(codeOf("cursor=garbage"), "invalid_cursor");
		assert.equal(codeOf("graph_id="), "invalid_graph_id");
		assert.equal(codeOf(`graph_id=${"g".repeat(201)}`), "invalid_graph_id");
		assert.equal(codeOf("workflow="), "invalid_workflow");
	});

	it("treats only someone else's identity as another owner, in both spellings", () => {
		assert.equal(isOtherChatOwner(null, "user-a"), false);
		assert.equal(isOtherChatOwner("   ", "user-a"), false);
		assert.equal(isOtherChatOwner("user-a", "user-a"), false);
		assert.equal(isOtherChatOwner("user:user-a", "user-a"), false);
		assert.equal(isOtherChatOwner("user-b", "user-a"), true);
		assert.equal(isOtherChatOwner("user:user-b", "user-a"), true);
		assert.equal(isOtherChatOwner("service:user-a", "user-a"), true);
	});
});

// ─── Fixtures: real store, real sessions ─────────────────────────────────────

class InspectableRuntime extends WorkflowRuntimeStore {
	/** The SQL of every statement the store's own `read` and `write` ran, in order: a real pass-through, nothing faked. */
	readonly statements: string[] = [];

	protected override read(stmt: InStatement) {
		this.statements.push(typeof stmt === "string" ? stmt : stmt.sql);
		return super.read(stmt);
	}

	protected override write(stmt: InStatement, mode?: WriteMode) {
		this.statements.push(typeof stmt === "string" ? stmt : stmt.sql);
		return super.write(stmt, mode);
	}

	raw(sql: string, args: unknown[] = []) {
		return this.db.execute({ sql, args: args as never });
	}

	/** The two halves of a backfill, apart, so a test can commit something between them. */
	candidatesToBackfill(scope: { ownerUserId: string }, limit: number) {
		return this.readBackfillCandidates(scope, limit);
	}

	backfillOne(candidate: ChatBackfillCandidate) {
		return this.writeBackfillCandidate(candidate);
	}
}

/** How many times the backfill went looking for legacy chats (its candidate query is the only reader of `$.source.prompt`). */
const legacyScans = (runtime: InspectableRuntime) =>
	runtime.statements.filter((sql) => sql.includes("$.source.prompt")).length;

async function withRuntime(run: (runtime: InspectableRuntime) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "chat-catalogue-"));
	const runtime = new InspectableRuntime(join(dir, "runtime.sqlite"));
	await runtime.init();
	try {
		await run(runtime);
	} finally {
		runtime.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

interface ChatFixture {
	readonly n: number;
	readonly owner?: string;
	readonly graphId?: string;
	readonly graphOwner?: string;
	readonly prompt?: string;
	readonly title?: string;
	readonly headed?: boolean;
	readonly model?: string;
	readonly now?: number;
	/** The workflow that started the Session (default `workspace-chat-v1`). */
	readonly workflow?: string;
}

async function beginChat(runtime: WorkflowRuntimeStore, fixture: ChatFixture) {
	const owner = fixture.owner ?? "user-a";
	const graphId = fixture.graphId ?? "g1";
	const model = fixture.model ?? "google/gemini-2.5-flash";
	const now = fixture.now ?? fixture.n * 1_000;
	const sessionId = `ags-chat-${fixture.n}`;
	const runId = `wfr-chat-${fixture.n}`;
	const nodeKey = "1:pilot-headed";
	const workflowName = fixture.workflow ?? "workspace-chat-v1";
	await runtime.createWorkflowInstance({
		runId,
		workflowName,
		graphId,
		ownerUserId: owner,
		sourceSha256: "sha",
		sourceText: "export const meta = {}",
		inputs: { config: { graphId, model }, args: {} },
		startedAt: now,
	});
	const semantic = makeTestAgentSemanticBinding({ graphId, kind: "prime", registeredName: `chat-agent-${fixture.n}` });
	const spec: AgentNodeSpec = {
		label: "pilot-headed",
		phaseIndex: 1,
		prompt: fixture.prompt ?? `message ${fixture.n}`,
		model,
		provider: "openrouter",
		graphId,
		toolMode: "none",
		...(fixture.headed === false ? {} : { interactionMode: "headed" as const }),
		...(fixture.title === undefined ? {} : { chat: { title: fixture.title } }),
		...semantic,
	};
	await runtime.beginAgentSession({
		sessionId,
		runId,
		workflowName,
		graphId,
		ownerUserId: owner,
		graphOwnerPrincipal: fixture.graphOwner ?? "user:graph-owner",
		spec,
		nodeKey,
		frontier: { kind: "before-node", nodeKey, sessionId, label: "pilot-headed", phaseIndex: 1, ts: now },
		now,
	});
	return { sessionId, runId, nodeKey };
}

/** Generation zero: claim, bind, and commit the first reply (what a real first turn leaves behind). */
async function finishFirstTurn(
	runtime: WorkflowRuntimeStore,
	chat: { sessionId: string; nodeKey: string },
	input: { output: string; now: number; model?: string },
) {
	const activationId = `${chat.sessionId}:generation:0`;
	await runtime.claimAgentMaterialization(chat.sessionId, { generation: 0, activationId, now: input.now - 2 });
	await runtime.bindAgentSandbox(chat.sessionId, {
		sandboxId: `sandbox-${chat.sessionId}`,
		generation: 0,
		activationId,
		now: input.now - 1,
	});
	await runtime.finishAgentSession(chat.sessionId, {
		result: {
			nodeKey: chat.nodeKey,
			sessionId: chat.sessionId,
			invocationId: activationId,
			label: "pilot-headed",
			phaseIndex: 1,
			state: "done",
			output: input.output,
			model: input.model ?? "google/gemini-2.5-flash",
			turns: 1,
			toolCalls: 0,
			tokens: 2_256,
			queuedAt: input.now - 100,
			startedAt: input.now - 50,
			durationMs: 50,
		},
		status: "completed",
		generation: 0,
		activationId,
		now: input.now,
		frontier: {
			kind: "after-node",
			nodeKey: chat.nodeKey,
			sessionId: chat.sessionId,
			label: "pilot-headed",
			phaseIndex: 1,
			ts: input.now,
		},
	});
}

// ─── The store ───────────────────────────────────────────────────────────────

describe("the catalogue row a chat session is born with", () => {
	it("records the title from the first message, the resolved model and provider, and both times", async () => {
		await withRuntime(async (runtime) => {
			const prompt =
				"  Tell me about\nthe harbour   of Montevideo, and whether the ferries still run in winter or only in the summer. ";
			const chat = await beginChat(runtime, { n: 1, prompt, now: 1_000 });
			const row = await runtime.readChatSessionCatalogue(chat.sessionId);
			assert.ok(row);
			assert.equal(row.title, deriveChatTitle(prompt));
			assert.ok(Array.from(row.title).length <= CHAT_TITLE_AUTO_MAX_CHARS);
			assert.equal(row.title_source, "first-message");
			assert.equal(row.model, "google/gemini-2.5-flash");
			assert.equal(row.provider, "openrouter");
			assert.equal(row.created_at, 1_000);
			assert.equal(row.last_activity_at, 1_000);
			assert.equal(row.owner_user_id, "user-a");
			assert.equal(row.graph_id, "g1");
			assert.equal(row.graph_owner_principal, "user:graph-owner");
			assert.equal(row.workflow_name, "workspace-chat-v1");
			assert.equal(row.run_id, chat.runId);
			assert.equal(row.continues_json, null);
			assert.equal(row.seed_window_json, null);
		});
	});

	it("takes an explicit title over the first message", async () => {
		await withRuntime(async (runtime) => {
			const chat = await beginChat(runtime, {
				n: 1,
				prompt: "the newest message",
				title: "  Old chat\n· continued ",
			});
			const row = await runtime.readChatSessionCatalogue(chat.sessionId);
			assert.equal(row?.title, "Old chat · continued");
			assert.equal(row?.title_source, "explicit");
		});
	});

	it("does not list a session that is not a headed chat", async () => {
		await withRuntime(async (runtime) => {
			const headless = await beginChat(runtime, { n: 1, headed: false });
			assert.equal(await runtime.readChatSessionCatalogue(headless.sessionId), null);
			const page = await runtime.listChatSessions({ ownerUserId: "user-a", limit: 10 });
			assert.deepEqual(page.sessions, []);
		});
	});

	it("moves lastActivityAt only for what a person did or what an assistant finished, and never backwards", async () => {
		await withRuntime(async (runtime) => {
			const chat = await beginChat(runtime, { n: 1, now: 1_000 });
			const activity = async () => (await runtime.readChatSessionCatalogue(chat.sessionId))?.last_activity_at;
			await runtime.appendAgentSessionEvent(chat.sessionId, { type: "message.delta", ts: 5_000, payload: {} });
			await runtime.appendAgentSessionEvent(chat.sessionId, {
				type: "budget.ledger_updated",
				ts: 5_500,
				payload: {},
			});
			assert.equal(await activity(), 1_000, "streaming deltas and ledger bookkeeping are not conversation");
			await runtime.appendAgentSessionEvent(chat.sessionId, { type: "message.completed", ts: 6_000, payload: {} });
			assert.equal(await activity(), 6_000);
			await runtime.appendAgentSessionEvent(chat.sessionId, { type: "turn.completed", ts: 5_900, payload: {} });
			assert.equal(await activity(), 6_000, "a late, older event never moves it back");
			const accepted = await runtime.submitAgentSessionCommand(chat.sessionId, {
				commandId: "cmd-1",
				idempotencyKey: "key-1",
				name: "follow_up",
				payload: { text: "and again?" },
				clientId: "spa",
				now: 7_000,
			});
			assert.equal(accepted?.accepted, true);
			assert.equal(await activity(), 7_000, "a person's follow-up counts the moment it is accepted");
		});
	});
});

describe("what counts as a chat's activity", () => {
	it("does not count the host quiescing the chat's body: a chat nobody touched does not jump to the top of the list", async () => {
		await withRuntime(async (runtime) => {
			const chat = await beginChat(runtime, { n: 1, now: 1_000 });
			const activity = async () => (await runtime.readChatSessionCatalogue(chat.sessionId))?.last_activity_at;
			await runtime.submitAgentSessionCommand(chat.sessionId, {
				commandId: "cmd-1",
				idempotencyKey: "key-1",
				name: "follow_up",
				payload: { text: "a question" },
				clientId: "spa",
				now: 5_000,
			});
			assert.equal(await activity(), 5_000);
			// What the spawner submits when a body idles, and at every graceful shutdown (so at every deploy).
			const accepted = await runtime.submitAgentSessionCommand(chat.sessionId, {
				commandId: `runtime.quiesce:${chat.sessionId}:0`,
				idempotencyKey: `runtime.quiesce:${chat.sessionId}:0`,
				name: "quiesce",
				payload: { reason: "idle", drainDeadlineMs: 10_000 },
				clientId: "choreograph.agent-memory",
				now: 9_000,
				requireDriver: false,
			});
			assert.equal(accepted?.accepted, true);
			assert.equal(await activity(), 5_000, "the host's own bookkeeping is not conversation");
			await runtime.submitAgentSessionCommand(chat.sessionId, {
				commandId: "cmd-2",
				idempotencyKey: "key-2",
				name: "steer",
				payload: { text: "a correction" },
				clientId: "spa",
				now: 9_500,
			});
			assert.equal(await activity(), 9_500, "a person's steer still is");
		});
	});

	it("does not count it in a legacy chat's backfilled activity either", async () => {
		await withRuntime(async (runtime) => {
			const chat = await beginChat(runtime, { n: 1, now: 1_000 });
			await runtime.raw("DELETE FROM chat_session_catalogue");
			for (const [ts, name] of [
				[6_000, "follow_up"],
				[9_000, "quiesce"],
			] as const) {
				await runtime.appendAgentSessionEvent(chat.sessionId, {
					type: "command.accepted",
					ts,
					payload: { commandId: `c-${ts}`, name },
				});
			}
			await runtime.backfillChatSessionCatalogue({ ownerUserId: "user-a" });
			assert.equal((await runtime.readChatSessionCatalogue(chat.sessionId))?.last_activity_at, 6_000);
		});
	});
});

describe("which Sessions are chats", () => {
	it("names the two built-in workflows a person chats through, and no other headed workflow is a chat", async () => {
		assert.deepEqual(
			[...CHAT_WORKFLOW_NAMES].sort(),
			[DOMAIN_AGENT_ACTIVITY_LOOP_NAME, WORKSPACE_CHAT_WORKFLOW_NAME].sort(),
			"the catalogue's names are the workflows' own",
		);
		await withRuntime(async (runtime) => {
			const workspace = await beginChat(runtime, { n: 1, workflow: WORKSPACE_CHAT_WORKFLOW_NAME });
			const domain = await beginChat(runtime, { n: 2, workflow: DOMAIN_AGENT_ACTIVITY_LOOP_NAME });
			const other = await beginChat(runtime, { n: 3, workflow: "some-headed-workflow-v1" });
			assert.ok(await runtime.readChatSessionCatalogue(workspace.sessionId));
			assert.ok(
				await runtime.readChatSessionCatalogue(domain.sessionId),
				"the Domain Agent's headed pilot is a chat",
			);
			assert.equal(
				await runtime.readChatSessionCatalogue(other.sessionId),
				null,
				"a headed root agent is not thereby a chat",
			);
			const page = await runtime.listChatSessions({ ownerUserId: "user-a", limit: 10 });
			assert.equal(page.sessions.length, 2);

			await runtime.raw("DELETE FROM chat_session_catalogue");
			assert.equal(
				await runtime.backfillChatSessionCatalogue({ ownerUserId: "user-a" }),
				2,
				"nor is it backfilled as one",
			);
			assert.equal(await runtime.readChatSessionCatalogue(other.sessionId), null);
		});
	});
});

describe("listing a person's chats", () => {
	it("pages newest activity first, per owner and per graph, without gaps or repeats", async () => {
		await withRuntime(async (runtime) => {
			for (let n = 1; n <= 5; n++) await beginChat(runtime, { n, now: n * 1_000 });
			await beginChat(runtime, { n: 6, owner: "user-b", now: 6_000 });
			await beginChat(runtime, { n: 7, graphId: "g2", now: 7_000 });

			const first = await runtime.listChatSessions({ ownerUserId: "user-a", graphId: "g1", limit: 2 });
			assert.deepEqual(
				first.sessions.map((row) => row.session_id),
				["ags-chat-5", "ags-chat-4"],
			);
			assert.ok(first.nextCursor);
			const second = await runtime.listChatSessions({
				ownerUserId: "user-a",
				graphId: "g1",
				limit: 2,
				cursor: first.nextCursor,
			});
			assert.deepEqual(
				second.sessions.map((row) => row.session_id),
				["ags-chat-3", "ags-chat-2"],
			);
			const third = await runtime.listChatSessions({
				ownerUserId: "user-a",
				graphId: "g1",
				limit: 2,
				cursor: second.nextCursor ?? undefined,
			});
			assert.deepEqual(
				third.sessions.map((row) => row.session_id),
				["ags-chat-1"],
			);
			assert.equal(third.nextCursor, null);

			const everywhere = await runtime.listChatSessions({ ownerUserId: "user-a", limit: 50 });
			assert.deepEqual(
				everywhere.sessions.map((row) => row.session_id),
				["ags-chat-7", "ags-chat-5", "ags-chat-4", "ags-chat-3", "ags-chat-2", "ags-chat-1"],
			);
			const theirs = await runtime.listChatSessions({ ownerUserId: "user-b", limit: 50 });
			assert.deepEqual(
				theirs.sessions.map((row) => row.session_id),
				["ags-chat-6"],
			);
			const nobody = await runtime.listChatSessions({ ownerUserId: "user-c", limit: 50 });
			assert.deepEqual(nobody.sessions, []);
		});
	});

	it("keeps a stable order across pages when two chats share an activity time", async () => {
		await withRuntime(async (runtime) => {
			for (let n = 1; n <= 4; n++) await beginChat(runtime, { n, now: 9_000 });
			const seen: string[] = [];
			let cursor: { lastActivityAt: number; sessionId: string } | undefined;
			for (let page = 0; page < 6; page++) {
				const result = await runtime.listChatSessions({
					ownerUserId: "user-a",
					limit: 1,
					...(cursor ? { cursor } : {}),
				});
				seen.push(...result.sessions.map((row) => row.session_id));
				if (!result.nextCursor) break;
				cursor = result.nextCursor;
			}
			assert.deepEqual([...seen].sort(), ["ags-chat-1", "ags-chat-2", "ags-chat-3", "ags-chat-4"]);
			assert.equal(new Set(seen).size, 4);
		});
	});

	it("separates two graphs that share a slug by their graph owner", async () => {
		await withRuntime(async (runtime) => {
			await beginChat(runtime, { n: 1, graphOwner: "user:owner-one" });
			await beginChat(runtime, { n: 2, graphOwner: "user:owner-two" });
			const page = await runtime.listChatSessions({
				ownerUserId: "user-a",
				graphId: "g1",
				graphOwnerPrincipal: "user:owner-two",
				limit: 10,
			});
			assert.deepEqual(
				page.sessions.map((row) => row.session_id),
				["ags-chat-2"],
			);
		});
	});

	it("reports each chat's outcome and lifecycle beside its catalogue facts", async () => {
		await withRuntime(async (runtime) => {
			await beginChat(runtime, { n: 1 });
			const [row] = (await runtime.listChatSessions({ ownerUserId: "user-a", limit: 5 })).sessions;
			assert.equal(row.session_status, "queued");
			assert.equal(row.session_lifecycle_state, "open");
		});
	});
});

describe("chats that predate the catalogue (legacy sessions, decision: lazy backfill on list)", () => {
	it("catalogues them from their own record: title from the first message, model from the pinned binding", async () => {
		await withRuntime(async (runtime) => {
			const chat = await beginChat(runtime, { n: 1, prompt: "an old question about ferries", now: 1_000 });
			await runtime.appendAgentSessionEvent(chat.sessionId, { type: "message.completed", ts: 9_000, payload: {} });
			// Simulate a session created before the catalogue existed.
			await runtime.raw("DELETE FROM chat_session_catalogue WHERE session_id = ?", [chat.sessionId]);
			assert.equal(await runtime.readChatSessionCatalogue(chat.sessionId), null);

			assert.equal(await runtime.backfillChatSessionCatalogue({ ownerUserId: "user-a" }), 1);
			const row = await runtime.readChatSessionCatalogue(chat.sessionId);
			assert.ok(row);
			assert.equal(row.title, "an old question about ferries");
			assert.equal(row.title_source, "backfill");
			assert.equal(row.model, "google/gemini-2.5-flash");
			assert.equal(row.provider, "openrouter");
			assert.equal(row.created_at, 1_000);
			assert.equal(row.last_activity_at, 9_000, "last activity is read from the session's own events");

			assert.equal(await runtime.backfillChatSessionCatalogue({ ownerUserId: "user-a" }), 0, "idempotent");
		});
	});

	it("never catalogues another person's session or a session that is not a headed chat", async () => {
		await withRuntime(async (runtime) => {
			const mine = await beginChat(runtime, { n: 1 });
			const theirs = await beginChat(runtime, { n: 2, owner: "user-b" });
			const headless = await beginChat(runtime, { n: 3, headed: false });
			await runtime.raw("DELETE FROM chat_session_catalogue");
			assert.equal(await runtime.backfillChatSessionCatalogue({ ownerUserId: "user-a" }), 1);
			assert.ok(await runtime.readChatSessionCatalogue(mine.sessionId));
			assert.equal(await runtime.readChatSessionCatalogue(theirs.sessionId), null);
			assert.equal(await runtime.readChatSessionCatalogue(headless.sessionId), null);
		});
	});

	it("bounds one backfill call and finishes on the next", async () => {
		await withRuntime(async (runtime) => {
			for (let n = 1; n <= 3; n++) await beginChat(runtime, { n });
			await runtime.raw("DELETE FROM chat_session_catalogue");
			assert.equal(await runtime.backfillChatSessionCatalogue({ ownerUserId: "user-a", limit: 2 }), 2);
			assert.equal(await runtime.backfillChatSessionCatalogue({ ownerUserId: "user-a", limit: 2 }), 1);
			assert.equal(await runtime.backfillChatSessionCatalogue({ ownerUserId: "user-a", limit: 2 }), 0);
		});
	});

	it("does not bring back a chat that was purged between reading it and writing its row", async () => {
		await withRuntime(async (runtime) => {
			const chat = await beginChat(runtime, { n: 1, prompt: "words that were private", now: 1_000 });
			await runtime.raw("DELETE FROM chat_session_catalogue");
			const candidates = await runtime.candidatesToBackfill({ ownerUserId: "user-a" }, 10);
			assert.equal(candidates.length, 1, "the backfill read the chat");
			// A privacy retirement commits now: the Session and its rows are gone (what purgePhanesPrivacyEpochs does,
			// which deletes the Session's dependants first; here the constraint that orders that is simply lifted).
			await runtime.raw("PRAGMA foreign_keys = OFF");
			for (const table of ["agent_session_document_ops", "agent_session_events", "agent_sessions"]) {
				await runtime.raw(`DELETE FROM ${table} WHERE session_id = ?`, [chat.sessionId]);
			}
			assert.equal(await runtime.backfillOne(candidates[0]), 0, "nothing is written for a chat that is gone");
			const rows = await runtime.raw("SELECT COUNT(*) AS n FROM chat_session_catalogue");
			assert.equal(Number(rows.rows[0].n), 0, "so no title, owner or model of it survives the purge");
		});
	});

	it("passes over a Session whose document is not readable JSON, and still catalogues the rest", async () => {
		await withRuntime(async (runtime) => {
			const first = await beginChat(runtime, { n: 1, prompt: "readable one", now: 1_000 });
			const broken = await beginChat(runtime, { n: 2, prompt: "cut off", now: 2_000 });
			const last = await beginChat(runtime, { n: 3, prompt: "readable two", now: 3_000 });
			await runtime.raw("UPDATE agent_sessions SET document_json = ? WHERE session_id = ?", [
				'{"source": {"prompt": "cut off in the mid',
				broken.sessionId,
			]);
			await runtime.raw("DELETE FROM chat_session_catalogue");
			assert.equal(await runtime.backfillChatSessionCatalogue({ ownerUserId: "user-a" }), 2, "the two it can read");
			assert.equal((await runtime.readChatSessionCatalogue(first.sessionId))?.title, "readable one");
			assert.equal((await runtime.readChatSessionCatalogue(last.sessionId))?.title, "readable two");
			assert.equal(await runtime.readChatSessionCatalogue(broken.sessionId), null);
			assert.equal(
				await runtime.backfillChatSessionCatalogue({ ownerUserId: "user-a" }),
				0,
				"and it is not a wound that reopens",
			);
		});
	});

	it("does not open the document of a chat that already has a row", async () => {
		await withRuntime(async (runtime) => {
			const chat = await beginChat(runtime, { n: 1, prompt: "already catalogued" });
			// Were this document opened at all, SQLite's JSON functions would refuse it.
			await runtime.raw("UPDATE agent_sessions SET document_json = ? WHERE session_id = ?", [
				"not json",
				chat.sessionId,
			]);
			assert.equal(await runtime.backfillChatSessionCatalogue({ ownerUserId: "user-a" }), 0);
		});
	});

	it("costs next to nothing for the chats it has already catalogued, however long their documents are", async () => {
		await withRuntime(async (runtime) => {
			for (let n = 1; n <= 120; n++) await beginChat(runtime, { n, now: n * 1_000 });
			// A long conversation lives inside its Session's document: make each of these 250 KB.
			await runtime.raw("UPDATE agent_sessions SET document_json = json_set(document_json, '$.source.padding', ?)", [
				"x".repeat(250_000),
			]);
			const fastest = async (work: () => Promise<unknown>) => {
				let best = Number.POSITIVE_INFINITY;
				for (let attempt = 0; attempt < 5; attempt++) {
					const started = performance.now();
					await work();
					best = Math.min(best, performance.now() - started);
				}
				return best;
			};
			// What merely opening every one of those documents costs on this machine, measured now, beside it.
			const openingEveryDocument = await fastest(() =>
				runtime.raw(
					"SELECT count(*) AS n FROM agent_sessions WHERE owner_user_id = ? AND json_extract(document_json, '$.source.interactionMode') = 'headed'",
					["user-a"],
				),
			);
			const backfill = await fastest(() =>
				runtime.backfillChatSessionCatalogue({ ownerUserId: "user-a", limit: 50 }),
			);
			assert.ok(
				backfill * 4 < openingEveryDocument,
				`the backfill (${backfill.toFixed(1)} ms) should be a fraction of opening every document (${openingEveryDocument.toFixed(1)} ms)`,
			);
		});
	});

	it("computes a chat's last activity inside the insert, so an event committed a moment earlier is not lost", async () => {
		await withRuntime(async (runtime) => {
			const chats = [];
			for (let n = 1; n <= 12; n++) chats.push(await beginChat(runtime, { n, now: 1_000 }));
			await runtime.raw("DELETE FROM chat_session_catalogue");
			runtime.statements.length = 0;
			await Promise.all([
				runtime.backfillChatSessionCatalogue({ ownerUserId: "user-a" }),
				...chats.map((chat, index) =>
					runtime.appendAgentSessionEvent(chat.sessionId, {
						type: "message.completed",
						ts: 50_000 + index,
						payload: {},
					}),
				),
			]);
			for (const [index, chat] of chats.entries()) {
				assert.equal(
					(await runtime.readChatSessionCatalogue(chat.sessionId))?.last_activity_at,
					50_000 + index,
					chat.sessionId,
				);
			}
			// The structural reason: the store never reads a Session's events on its own to carry them into a write.
			assert.equal(
				runtime.statements.filter(
					(sql) => sql.includes("MAX(ts)") && !sql.includes("INSERT INTO chat_session_catalogue"),
				).length,
				0,
				"the maximum is taken by the insert itself",
			);
		});
	});
});

// ─── The transcript, as the store writes it (D3, D4) ─────────────────────────

describe("transcript items written by the store", () => {
	it("stamps the first reply with the time its outcome was committed and remembers its generation", async () => {
		await withRuntime(async (runtime) => {
			const chat = await beginChat(runtime, { n: 1 });
			await finishFirstTurn(runtime, chat, { output: "I can help you read and search.", now: 1_200 });
			const session = await runtime.readAgentSession(chat.sessionId);
			const document = JSON.parse(session?.document_json ?? "{}") as {
				transcript: { order: string[]; items: Record<string, Record<string, unknown>> };
			};
			const id = `result:${chat.sessionId}:generation:0`;
			assert.deepEqual(document.transcript.order, [id]);
			assert.equal(document.transcript.items[id].kind, "node-result");
			assert.equal(document.transcript.items[id].ts, 1_200);
			assert.equal(document.transcript.items[id].generation, 0);
			assert.equal(document.transcript.items[id].text, "I can help you read and search.");
		});
	});

	it("stamps a follow-up with when it was sent and when it was answered, and names the model", async () => {
		await withRuntime(async (runtime) => {
			const chat = await beginChat(runtime, { n: 1 });
			const activationId = `${chat.sessionId}:generation:0`;
			await runtime.claimAgentMaterialization(chat.sessionId, { generation: 0, activationId, now: 1_009 });
			await runtime.bindAgentSandbox(chat.sessionId, {
				sandboxId: "sandbox-1",
				generation: 0,
				activationId,
				now: 1_010,
			});
			await runtime.submitAgentSessionCommand(chat.sessionId, {
				commandId: "cmd-1",
				idempotencyKey: "key-1",
				name: "follow_up",
				payload: { text: "Say that again in five words or fewer." },
				clientId: "spa",
				targetGeneration: 0,
				now: 2_000,
			});
			await runtime.claimAgentSessionCommandsForDelivery(chat.sessionId, 0, 2_010);
			await runtime.completeAgentSessionCommand("cmd-1", 0, {
				status: "completed",
				result: { output: "Read and search workspace." },
				now: 2_500,
			});
			const session = await runtime.readAgentSession(chat.sessionId);
			const document = JSON.parse(session?.document_json ?? "{}") as {
				transcript: { order: string[]; items: Record<string, Record<string, unknown>> };
			};
			assert.deepEqual(document.transcript.order, ["command:cmd-1:input", "command:cmd-1:result"]);
			assert.equal(document.transcript.items["command:cmd-1:input"].ts, 2_000);
			assert.equal(document.transcript.items["command:cmd-1:result"].ts, 2_500);
			assert.equal(document.transcript.items["command:cmd-1:result"].model, "google/gemini-2.5-flash");
			assert.equal(document.transcript.items["command:cmd-1:result"].generation, 0);
		});
	});
});

// ─── The routes ──────────────────────────────────────────────────────────────

function request(method: string, url: string, headers: Record<string, string> = {}, body?: unknown) {
	const raw = body === undefined ? "" : JSON.stringify(body);
	return {
		method,
		url,
		headers: { host: "localhost", "x-internal-service": "test-secret", "x-user-id": "user-a", ...headers },
		on() {},
		async *[Symbol.asyncIterator]() {
			if (raw) yield Buffer.from(raw);
		},
	} as unknown as IncomingMessage;
}

function recorder() {
	let body = "";
	let statusCode = 0;
	const headers: Record<string, string> = {};
	return {
		get body() {
			return JSON.parse(body || "null") as Record<string, any>;
		},
		get statusCode() {
			return statusCode;
		},
		set statusCode(value: number) {
			statusCode = value;
		},
		headers,
		setHeader(name: string, value: string) {
			headers[name.toLowerCase()] = value;
		},
		end(value?: string) {
			body = value ?? "";
		},
	} as unknown as ServerResponse & { body: Record<string, any>; statusCode: number; headers: Record<string, string> };
}

async function withRoutes(
	run: (harness: {
		runtime: InspectableRuntime;
		get: (url: string, headers?: Record<string, string>) => Promise<ReturnType<typeof recorder>>;
	}) => Promise<void>,
): Promise<void> {
	const previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
	process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "test-secret";
	try {
		await withRuntime(async (runtime) => {
			const ctx = { runtime } as never;
			await run({
				runtime,
				get: async (url, headers) => {
					const response = recorder();
					await routeRequest(request("GET", url, headers), response, ctx);
					return response;
				},
			});
		});
	} finally {
		if (previousSecret === undefined) delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		else process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
	}
}

describe("GET /api/workflows/runs?view=chat-sessions", () => {
	it("lists the caller's own chats in one graph, newest first, with the catalogue contract", async () => {
		await withRoutes(async ({ runtime, get }) => {
			await beginChat(runtime, { n: 1, prompt: "first question", now: 1_000 });
			await beginChat(runtime, { n: 2, prompt: "second question", now: 2_000 });
			await beginChat(runtime, { n: 3, owner: "user-b", prompt: "someone else's question", now: 1_500 });
			await beginChat(runtime, { n: 4, graphId: "g2", prompt: "another graph", now: 3_000 });

			const response = await get("/api/workflows/runs?view=chat-sessions", { "x-graph-id": "g1" });
			assert.equal(response.statusCode, 200, JSON.stringify(response.body));
			assert.equal(response.headers["cache-control"], "private, no-store");
			assert.equal(response.body.view, "chat-sessions");
			assert.equal(response.body.nextCursor, null);
			assert.deepEqual(
				response.body.sessions.map((session: { sessionId: string }) => session.sessionId),
				["ags-chat-2", "ags-chat-1"],
			);
			assert.deepEqual(response.body.sessions[0], {
				sessionId: "ags-chat-2",
				runId: "wfr-chat-2",
				graphId: "g1",
				graphOwnerPrincipal: "user:graph-owner",
				workflow: "workspace-chat-v1",
				title: "second question",
				titleSource: "first-message",
				model: "google/gemini-2.5-flash",
				provider: "openrouter",
				createdAt: 2_000,
				lastActivityAt: 2_000,
				status: "queued",
				lifecycleState: "open",
			});

			const theirs = await get("/api/workflows/runs?view=chat-sessions", {
				"x-graph-id": "g1",
				"x-user-id": "user-b",
			});
			assert.deepEqual(
				theirs.body.sessions.map((session: { sessionId: string }) => session.sessionId),
				["ags-chat-3"],
			);
		});
	});

	it("scopes to the gateway-minted graph, the query graph, or every graph the caller has chatted in", async () => {
		await withRoutes(async ({ runtime, get }) => {
			await beginChat(runtime, { n: 1, graphId: "g1" });
			await beginChat(runtime, { n: 2, graphId: "g2" });
			const ids = (response: ReturnType<typeof recorder>) =>
				response.body.sessions.map((session: { sessionId: string }) => session.sessionId).sort();
			assert.deepEqual(ids(await get("/api/workflows/runs?view=chat-sessions", { "x-graph-id": "g2" })), [
				"ags-chat-2",
			]);
			assert.deepEqual(ids(await get("/api/workflows/runs?view=chat-sessions&graph_id=g1")), ["ags-chat-1"]);
			assert.deepEqual(ids(await get("/api/workflows/runs?view=chat-sessions")), ["ags-chat-1", "ags-chat-2"]);
			const mismatch = await get("/api/workflows/runs?view=chat-sessions&graph_id=g2", { "x-graph-id": "g1" });
			assert.equal(mismatch.statusCode, 400);
			assert.equal(mismatch.body.error.code, "graph_mismatch");
		});
	});

	it("honours the canonical graph owner the gateway minted", async () => {
		await withRoutes(async ({ runtime, get }) => {
			await beginChat(runtime, { n: 1, graphOwner: "user:owner-one" });
			await beginChat(runtime, { n: 2, graphOwner: "user:owner-two" });
			const response = await get("/api/workflows/runs?view=chat-sessions", {
				"x-graph-id": "g1",
				"x-graph-owner": "user:owner-two",
			});
			assert.deepEqual(
				response.body.sessions.map((session: { sessionId: string }) => session.sessionId),
				["ags-chat-2"],
			);
		});
	});

	it("pages with an opaque cursor until nextCursor is null", async () => {
		await withRoutes(async ({ runtime, get }) => {
			for (let n = 1; n <= 3; n++) await beginChat(runtime, { n, now: n * 1_000 });
			const seen: string[] = [];
			let url = "/api/workflows/runs?view=chat-sessions&limit=1";
			for (let page = 0; page < 5; page++) {
				const response = await get(url, { "x-graph-id": "g1" });
				assert.equal(response.statusCode, 200);
				seen.push(...response.body.sessions.map((session: { sessionId: string }) => session.sessionId));
				if (response.body.nextCursor === null) break;
				assert.equal(typeof response.body.nextCursor, "string");
				url = `/api/workflows/runs?view=chat-sessions&limit=1&cursor=${encodeURIComponent(response.body.nextCursor)}`;
			}
			assert.deepEqual(seen, ["ags-chat-3", "ags-chat-2", "ags-chat-1"]);
		});
	});

	it("refuses a request that names someone else as the owner with 403, and accepts the caller's own name", async () => {
		await withRoutes(async ({ runtime, get }) => {
			await beginChat(runtime, { n: 1, owner: "user-b" });
			await beginChat(runtime, { n: 2, owner: "user-a" });
			for (const other of ["user-b", "user:user-b", "service:user-a"]) {
				const denied = await get(`/api/workflows/runs?view=chat-sessions&owner=${encodeURIComponent(other)}`);
				assert.equal(denied.statusCode, 403, other);
				assert.equal(denied.body.error.code, "owner_mismatch");
				assert.equal(JSON.stringify(denied.body).includes("ags-chat-1"), false, "nothing of theirs leaks");
			}
			for (const own of ["user-a", "user:user-a"]) {
				const allowed = await get(`/api/workflows/runs?view=chat-sessions&owner=${encodeURIComponent(own)}`);
				assert.equal(allowed.statusCode, 200, own);
				assert.deepEqual(
					allowed.body.sessions.map((session: { sessionId: string }) => session.sessionId),
					["ags-chat-2"],
				);
			}
		});
	});

	it("answers malformed paging with 400 and a code, an unknown view with 400, and no credentials with 401", async () => {
		await withRoutes(async ({ get }) => {
			const codes: Array<[string, string]> = [
				["limit=0", "invalid_limit"],
				["limit=101", "invalid_limit"],
				["cursor=garbage", "invalid_cursor"],
				["graph_id=", "invalid_graph_id"],
			];
			for (const [query, code] of codes) {
				const response = await get(`/api/workflows/runs?view=chat-sessions&${query}`);
				assert.equal(response.statusCode, 400, query);
				assert.equal(response.body.error.code, code, query);
			}
			const unknown = await get("/api/workflows/runs?view=nonsense");
			assert.equal(unknown.statusCode, 400);
			assert.equal(unknown.body.error.code, "invalid_view");
			const anonymous = await get("/api/workflows/runs?view=chat-sessions", { "x-internal-service": "" });
			assert.equal(anonymous.statusCode, 401);
		});
	});

	it("refuses a cursor that only decodes because the decoder ignores what is wrong with it, and a graph owner that is no principal", async () => {
		await withRoutes(async ({ runtime, get }) => {
			await beginChat(runtime, { n: 1, now: 1_000 });
			await beginChat(runtime, { n: 2, now: 2_000 });
			const first = await get("/api/workflows/runs?view=chat-sessions&limit=1", { "x-graph-id": "g1" });
			const cursor = first.body.nextCursor as string;
			assert.equal(typeof cursor, "string");
			for (const mangled of [`${cursor}!!!!`, `${cursor}=`, `%25${cursor}`]) {
				const response = await get(`/api/workflows/runs?view=chat-sessions&limit=1&cursor=${mangled}`, {
					"x-graph-id": "g1",
				});
				assert.equal(response.statusCode, 400, mangled);
				assert.equal(response.body.error.code, "invalid_cursor", mangled);
			}
			const genuine = await get(`/api/workflows/runs?view=chat-sessions&limit=1&cursor=${cursor}`, {
				"x-graph-id": "g1",
			});
			assert.equal(genuine.statusCode, 200);
			for (const owner of ["foo", "someone@example.com", "user:", "organization", "user:a b"]) {
				const response = await get("/api/workflows/runs?view=chat-sessions", {
					"x-graph-id": "g1",
					"x-graph-owner": owner,
				});
				assert.equal(response.statusCode, 400, owner);
				assert.equal(response.body.error.code, "invalid_graph_owner", owner);
			}
		});
	});

	it("catalogues every legacy chat of a person with a few hundred, so one traversal shows them all", async () => {
		await withRoutes(async ({ runtime, get }) => {
			for (let n = 1; n <= 260; n++) await beginChat(runtime, { n, now: n * 1_000 });
			await runtime.raw("DELETE FROM chat_session_catalogue");
			const seen = new Set<string>();
			let url = "/api/workflows/runs?view=chat-sessions&limit=100";
			for (let page = 0; page < 6; page++) {
				const response = await get(url, { "x-graph-id": "g1" });
				assert.equal(response.statusCode, 200);
				for (const session of response.body.sessions as Array<{ sessionId: string }>) seen.add(session.sessionId);
				if (response.body.nextCursor === null) break;
				url = `/api/workflows/runs?view=chat-sessions&limit=100&cursor=${encodeURIComponent(response.body.nextCursor)}`;
			}
			assert.equal(seen.size, 260, "the first traversal ends only when nothing is left to find");
		});
	});

	it("looks for legacy chats once per person and graph, not on every first page", async () => {
		await withRoutes(async ({ runtime, get }) => {
			const legacy = await beginChat(runtime, { n: 1, prompt: "from before the release", now: 1_000 });
			await beginChat(runtime, { n: 2, graphId: "g2", prompt: "in another graph", now: 2_000 });
			await runtime.raw("DELETE FROM chat_session_catalogue WHERE session_id = ?", [legacy.sessionId]);
			runtime.statements.length = 0;

			const first = await get("/api/workflows/runs?view=chat-sessions", { "x-graph-id": "g1" });
			assert.equal(first.body.sessions[0].titleSource, "backfill");
			assert.equal(legacyScans(runtime), 1);
			for (let again = 0; again < 3; again++) {
				const page = await get("/api/workflows/runs?view=chat-sessions", { "x-graph-id": "g1" });
				assert.equal(page.body.sessions.length, 1);
			}
			assert.equal(legacyScans(runtime), 1, "nothing was left to catalogue, so nothing is scanned again");

			await get("/api/workflows/runs?view=chat-sessions", { "x-graph-id": "g2" });
			assert.equal(legacyScans(runtime), 2, "another graph is another scope");
			await get("/api/workflows/runs?view=chat-sessions", { "x-graph-id": "g2", "x-user-id": "user-b" });
			assert.equal(legacyScans(runtime), 3, "and so is another person");
		});
	});

	it("serves the list even when the backfill itself fails, and says so in the log", async () => {
		await withRoutes(async ({ runtime, get }) => {
			await beginChat(runtime, { n: 1, prompt: "catalogued", now: 1_000 });
			const legacy = await beginChat(runtime, { n: 2, prompt: "legacy", now: 2_000 });
			await runtime.raw("DELETE FROM chat_session_catalogue WHERE session_id = ?", [legacy.sessionId]);
			// A real fault under the backfill's feet: the table it takes a Session's activity from is gone.
			await runtime.raw("ALTER TABLE agent_session_events RENAME TO agent_session_events_gone");
			const logged: string[] = [];
			const original = console.error;
			console.error = (...args: unknown[]) => {
				logged.push(args.map(String).join(" "));
			};
			let response: ReturnType<typeof recorder>;
			try {
				response = await get("/api/workflows/runs?view=chat-sessions", { "x-graph-id": "g1" });
			} finally {
				console.error = original;
			}
			assert.equal(response.statusCode, 200, JSON.stringify(response.body));
			assert.deepEqual(
				response.body.sessions.map((session: { sessionId: string }) => session.sessionId),
				["ags-chat-1"],
				"the chats that have rows are still listed",
			);
			assert.ok(
				logged.some((line) => line.includes("[chat-catalogue]") && line.includes("backfill")),
				`the failure is logged: ${JSON.stringify(logged)}`,
			);
			assert.equal(JSON.stringify(logged).includes("legacy"), false, "and no chat content is in the log");
		});
	});

	it("lists the rest of a person's chats when one Session's document cannot be read", async () => {
		await withRoutes(async ({ runtime, get }) => {
			await beginChat(runtime, { n: 1, prompt: "legacy and readable", now: 1_000 });
			const broken = await beginChat(runtime, { n: 2, prompt: "legacy and broken", now: 2_000 });
			await runtime.raw("UPDATE agent_sessions SET document_json = ? WHERE session_id = ?", ["{", broken.sessionId]);
			await runtime.raw("DELETE FROM chat_session_catalogue");
			const response = await get("/api/workflows/runs?view=chat-sessions", { "x-graph-id": "g1" });
			assert.equal(response.statusCode, 200, JSON.stringify(response.body));
			assert.deepEqual(
				response.body.sessions.map((session: { title: string }) => session.title),
				["legacy and readable"],
			);
		});
	});

	it("catalogues a legacy chat on first sight and lists it as a backfilled row", async () => {
		await withRoutes(async ({ runtime, get }) => {
			const chat = await beginChat(runtime, { n: 1, prompt: "a question from before the release", now: 1_000 });
			await runtime.raw("DELETE FROM chat_session_catalogue WHERE session_id = ?", [chat.sessionId]);
			const response = await get("/api/workflows/runs?view=chat-sessions", { "x-graph-id": "g1" });
			assert.equal(response.statusCode, 200);
			assert.equal(response.body.sessions.length, 1);
			assert.equal(response.body.sessions[0].titleSource, "backfill");
			assert.equal(response.body.sessions[0].title, "a question from before the release");
			assert.equal(response.body.sessions[0].model, "google/gemini-2.5-flash");
		});
	});
});

describe("the catalogue facts on a Session read", () => {
	it("returns them with the session and with the run's agent index, and refuses another person's read", async () => {
		await withRoutes(async ({ runtime, get }) => {
			const chat = await beginChat(runtime, { n: 1, prompt: "what is here?", now: 1_000 });
			const session = await get(`/api/agent-sessions/${chat.sessionId}`);
			assert.equal(session.statusCode, 200);
			assert.deepEqual(session.body.session.chat, {
				title: "what is here?",
				titleSource: "first-message",
				model: "google/gemini-2.5-flash",
				provider: "openrouter",
				createdAt: 1_000,
				lastActivityAt: 1_000,
			});
			const agents = await get(`/api/workflows/runs/${chat.runId}/agents`);
			assert.equal(agents.statusCode, 200);
			assert.equal(agents.body.agents[0].chat.title, "what is here?");
			const denied = await get(`/api/agent-sessions/${chat.sessionId}`, { "x-user-id": "user-b" });
			assert.equal(denied.statusCode, 403);
		});
	});

	it("serves a legacy conversation once, with a time on every item (D3, D4 at read time)", async () => {
		await withRoutes(async ({ runtime, get }) => {
			const chat = await beginChat(runtime, { n: 1, now: 1_000 });
			await finishFirstTurn(runtime, chat, { output: "Again.", now: 1_200 });
			await runtime.submitAgentSessionCommand(chat.sessionId, {
				commandId: "cmd-1",
				idempotencyKey: "key-1",
				name: "follow_up",
				payload: { text: "again" },
				clientId: "spa",
				targetGeneration: 1,
				now: 2_000,
			});
			// The document as a pre-release Choreograph left it: no ts anywhere, and the
			// regrown generation's node result repeating the command's reply.
			const duplicate = `result:${agentSessionCommandActivationId(chat.sessionId, "cmd-1", 1)}`;
			const stored = await runtime.readAgentSession(chat.sessionId);
			const document = JSON.parse(stored?.document_json ?? "{}") as Record<string, any>;
			const zero = `result:${chat.sessionId}:generation:0`;
			document.transcript = {
				order: [zero, "command:cmd-1:input", "command:cmd-1:result", duplicate],
				items: {
					[zero]: { id: zero, role: "assistant", kind: "node-result", text: "Again.", state: "done" },
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
					[duplicate]: { id: duplicate, role: "assistant", kind: "node-result", text: "Again.", state: "done" },
				},
			};
			await runtime.raw("UPDATE agent_sessions SET document_json = ? WHERE session_id = ?", [
				JSON.stringify(document),
				chat.sessionId,
			]);

			const response = await get(`/api/agent-sessions/${chat.sessionId}`);
			assert.equal(response.statusCode, 200);
			const served = response.body.document.transcript as {
				order: string[];
				items: Record<string, Record<string, unknown>>;
			};
			assert.deepEqual(served.order, [zero, "command:cmd-1:input", "command:cmd-1:result"]);
			assert.equal(served.items[duplicate], undefined);
			assert.equal(typeof served.items[zero].ts, "number");
			assert.equal(served.items["command:cmd-1:input"].ts, 2_000);
			assert.equal(typeof served.items["command:cmd-1:result"].ts, "number");
			// A Session's model is pinned for its whole life, so who spoke is known for an old reply too.
			assert.equal(served.items[zero].model, "google/gemini-2.5-flash");
			assert.equal(served.items["command:cmd-1:result"].model, "google/gemini-2.5-flash");
			assert.equal(served.items["command:cmd-1:input"].model, undefined, "a person's message has no model");
			// The stored document was not rewritten by reading it.
			const after = await runtime.readAgentSession(chat.sessionId);
			assert.ok(JSON.parse(after?.document_json ?? "{}").transcript.items[duplicate], "reading is not a migration");
		});
	});
});
