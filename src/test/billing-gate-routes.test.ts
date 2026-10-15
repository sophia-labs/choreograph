/**
 * Door A at the real ingress (Sobremesa, E §4.1) — a REAL orchestrator on loopback, REAL
 * stores, NO MOCKS. The gate is exercised through `POST /api/invocations`,
 * `POST /api/agent-sessions/:id/commands` and `POST /api/agent-sessions/:id/steer` over
 * genuine HTTP, with the genuine ledger behind it.
 *
 * What this pins that a unit over the gate cannot: the call sites exist, they sit AFTER the
 * caller is authenticated and the input is valid (so a 404 or a 400 is still a 404 or a
 * 400), and BEFORE any run, sandbox or command exists (so a refused message leaves nothing
 * behind). A refusal is the coded 402 envelope; `observe` never refuses.
 *
 * RUN:  npx tsx --test src/test/billing-gate-routes.test.ts
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { CreditAdmission, insufficientCreditBody } from "../billing-gate.js";
import { FREE_TIER_BALANCE_MICRO_USD } from "../billing-pricing.js";
import { INVOCATION_ENVELOPE_SCHEMA } from "../workflow/invocation.js";
import { DOMAIN_AGENT_ACTIVITY_LOOP_NAME } from "../workflow/script-domain-agent-activity-loop.js";
import {
	asPerson,
	CreditRouteRig,
	definitionDigest,
	drainTo,
	httpJson,
	seedAgentSession,
	seedBalance,
	workspaceChatEnvelope,
} from "./billing-credit-fixture.js";
import { useBillingFee } from "./billing-fee-fixture.js";

// The numbers below are the flip's: BILLING_FEE_BPS=2000 is set together with BILLING_GATE_MODE=enforce.
// (The default regime, 15%, is pinned in billing-fee.test.ts and billing-credit-card.test.ts.)
useBillingFee(2000);

/** House (gemini-2.5-flash) at the 20% markup: 15,000 input + 256 output tokens. */
const HOUSE_MIN_ADMIT = 6_168;
/** claude-opus-4.5 at the same shape. */
const OPUS_MIN_ADMIT = 97_680;
const ASYNC = { prefer: "respond-async" };

describe("Door A over real HTTP: POST /api/invocations", { concurrency: false }, () => {
	const rig = new CreditRouteRig();
	let enforce: CreditAdmission;
	let observe: CreditAdmission;
	let counter = 0;
	const nextUser = () => `owner-${++counter}`;

	before(async () => {
		await rig.start();
		enforce = new CreditAdmission({ billing: rig.billing, mode: "enforce" });
		observe = new CreditAdmission({ billing: rig.billing, mode: "observe" });
	});
	after(() => rig.stop());
	beforeEach(() => {
		rig.gate = enforce;
	});

	async function chat(userId: string, invocationId: string) {
		// The CALLER (x-user-id) is who is billed, and the envelope's actor must be that caller.
		return httpJson(rig.server.baseUrl, "POST", "/api/invocations", {
			body: workspaceChatEnvelope(invocationId, userId),
			headers: asPerson(userId, ASYNC),
		});
	}

	it("enforce: a person below the bar gets the coded 402 and NOTHING is left behind", async () => {
		const user = nextUser();
		await seedBalance(rig.billing, user, 3_800);
		const runsBefore = await rig.journal.listRuns({ ownerUserId: user, limit: 100 });
		const sandboxesBefore = rig.store.list().length;

		const res = await chat(user, `credit.inv.${user}`);

		assert.equal(res.status, 402, res.text);
		assert.deepEqual(res.body, insufficientCreditBody(3_800, HOUSE_MIN_ADMIT));
		assert.match(String(res.headers.get("content-type")), /application\/json/);
		assert.deepEqual(await rig.journal.listRuns({ ownerUserId: user, limit: 100 }), runsBefore, "no run exists");
		assert.equal(rig.store.list().length, sandboxesBefore, "no sandbox was queued");
		const [row] = await rig.billing.listGateEvents({ userId: user });
		assert.equal(row.decision, "block");
		assert.equal(row.door, "ingress.invocation");
		assert.equal(row.mode, "enforce");
		assert.equal(row.requiredMicroUsd, HOUSE_MIN_ADMIT);
		assert.equal(row.balanceMicroUsd, 3_800);
	});

	it("enforce: a funded person starts the chat as before (202, a durable run)", async () => {
		const user = nextUser();
		await seedBalance(rig.billing, user, 500_000);
		const res = await chat(user, `credit.inv.${user}`);
		assert.equal(res.status, 202, res.text);
		const body = res.body as { runId: string; invocationId: string; workflowId: string };
		assert.match(body.runId, /^wfr-/);
		assert.equal(body.invocationId, `credit.inv.${user}`);
		assert.ok(await rig.runtime.getWorkflowInstance(body.runId), "the run is durable");
		assert.deepEqual(await rig.billing.listGateEvents({ userId: user }), [], "an allow is counted, not logged");
	});

	it("enforce: a person with no ledger row has the $1.00 starter credit and is not refused", async () => {
		const user = nextUser();
		assert.equal(await rig.billing.getCredit(user), undefined);
		const res = await chat(user, `credit.inv.${user}`);
		assert.equal(res.status, 202, res.text);
		assert.ok(FREE_TIER_BALANCE_MICRO_USD > HOUSE_MIN_ADMIT);
	});

	it("observe: the same person is admitted (202) and the dry run records would_block", async () => {
		rig.gate = observe;
		const user = nextUser();
		await seedBalance(rig.billing, user, 3_800);
		const res = await chat(user, `credit.inv.${user}`);
		assert.equal(res.status, 202, res.text);
		assert.ok(await rig.runtime.getWorkflowInstance((res.body as { runId: string }).runId));
		const [row] = await rig.billing.listGateEvents({ userId: user });
		assert.equal(row.decision, "would_block");
		assert.equal(row.mode, "observe");
		assert.equal(row.door, "ingress.invocation");
		assert.equal(row.balanceMicroUsd, 3_800);
	});

	it("a person out of credits in a graph with no Domain Agent still gets the 404 the SPA falls back on", async () => {
		// The SPA tries the Domain Agent loop first and falls back to the workspace chat on this 404;
		// the credit verdict belongs to the fallback, so the 404 must not become a 402.
		const user = nextUser();
		await seedBalance(rig.billing, user, 0);
		const res = await httpJson(rig.server.baseUrl, "POST", "/api/invocations", {
			headers: asPerson(user, ASYNC),
			body: {
				schema: INVOCATION_ENVELOPE_SCHEMA,
				invocationId: `credit.domain.${user}`,
				target: {
					workflowName: DOMAIN_AGENT_ACTIVITY_LOOP_NAME,
					workflowUri: `urn:sophia:wf:${DOMAIN_AGENT_ACTIVITY_LOOP_NAME}`,
					definitionDigest: definitionDigest(DOMAIN_AGENT_ACTIVITY_LOOP_NAME),
				},
				input: {
					definitionDocumentId: "domain-agent-definition",
					trigger: { kind: "sophia-cluster.message", text: "hello", resource: "graph:angels:chat:1" },
					contextRefs: [],
					interactionMode: "headed",
				},
				actorRef: `user:${user}`,
				graph: { ownerPrincipal: `user:${user}`, graphId: "angels" },
			},
		});
		assert.equal(res.status, 404, res.text);
		assert.equal((res.body as { error: { code: string } }).error.code, "domain_agent_not_provisioned");
		assert.deepEqual(await rig.billing.listGateEvents({ userId: user }), []);
	});

	it("invalid input is still a 400 for a person out of credits: validation precedes the gate", async () => {
		const user = nextUser();
		await seedBalance(rig.billing, user, 0);
		const envelope = workspaceChatEnvelope(`credit.bad.${user}`, user);
		(envelope.input as { trigger: { text?: string } }).trigger.text = "   ";
		const res = await httpJson(rig.server.baseUrl, "POST", "/api/invocations", {
			body: envelope,
			headers: asPerson(user, ASYNC),
		});
		assert.equal(res.status, 400, res.text);
		assert.equal((res.body as { error: { code: string } }).error.code, "workspace_chat_input_invalid");
		assert.deepEqual(await rig.billing.listGateEvents({ userId: user }), []);
	});

	it("an unauthenticated caller is 401 before the gate is asked anything", async () => {
		const before = (await rig.billing.listGateEvents()).length;
		const res = await httpJson(rig.server.baseUrl, "POST", "/api/invocations", {
			body: workspaceChatEnvelope("credit.anon", "nobody"),
			headers: ASYNC,
		});
		assert.equal(res.status, 401, res.text);
		assert.equal((await rig.billing.listGateEvents()).length, before);
	});

	it("without a credit gate configured the route behaves exactly as it did (no ledger consulted)", async () => {
		rig.gate = undefined;
		const user = nextUser();
		await seedBalance(rig.billing, user, 0);
		const res = await chat(user, `credit.inv.${user}`);
		assert.equal(res.status, 202, res.text);
	});
});

describe("Door A over real HTTP: follow-ups on an existing chat", { concurrency: false }, () => {
	const rig = new CreditRouteRig();
	let enforce: CreditAdmission;
	let observe: CreditAdmission;
	let counter = 0;

	before(async () => {
		await rig.start();
		enforce = new CreditAdmission({ billing: rig.billing, mode: "enforce" });
		observe = new CreditAdmission({ billing: rig.billing, mode: "observe" });
	});
	after(() => rig.stop());
	beforeEach(() => {
		rig.gate = enforce;
	});

	async function session(model = "google/gemini-2.5-flash") {
		const user = `owner-cmd-${++counter}`;
		const seeded = await seedAgentSession(rig.runtime, { suffix: `cmd-${counter}`, ownerUserId: user, model });
		return { user, ...seeded };
	}

	function commandBody(name: string, id: string, payload: Record<string, unknown> = { text: "and then?" }) {
		return { commandId: id, idempotencyKey: id, clientId: "client-1", name, payload };
	}

	it("enforce: a follow-up below the bar is the coded 402 and no command is recorded", async () => {
		const s = await session();
		await seedBalance(rig.billing, s.user, 3_800);
		const res = await httpJson(rig.server.baseUrl, "POST", `/api/agent-sessions/${s.sessionId}/commands`, {
			body: commandBody("follow_up", "cmd-broke-1"),
			headers: asPerson(s.user),
		});
		assert.equal(res.status, 402, res.text);
		assert.deepEqual(res.body, insufficientCreditBody(3_800, HOUSE_MIN_ADMIT));
		assert.equal(await rig.runtime.readAgentSessionCommand("cmd-broke-1"), null, "nothing was queued");
		const [row] = await rig.billing.listGateEvents({ userId: s.user });
		assert.equal(row.decision, "block");
		assert.equal(row.door, "ingress.command");
		assert.match(row.reason ?? "", new RegExp(`session=${s.sessionId}`));
	});

	it("enforce: prompt and steer commands are gated the same way", async () => {
		const s = await session();
		await seedBalance(rig.billing, s.user, 0);
		for (const name of ["prompt", "steer"]) {
			const res = await httpJson(rig.server.baseUrl, "POST", `/api/agent-sessions/${s.sessionId}/commands`, {
				body: commandBody(name, `cmd-${name}-1`),
				headers: asPerson(s.user),
			});
			assert.equal(res.status, 402, `${name}: ${res.text}`);
		}
	});

	it("enforce: the dedicated steer route is gated too", async () => {
		const s = await session();
		await seedBalance(rig.billing, s.user, 0);
		const res = await httpJson(rig.server.baseUrl, "POST", `/api/agent-sessions/${s.sessionId}/steer`, {
			body: { clientId: "client-1", commandId: "steer-broke-1", text: "actually, stop" },
			headers: asPerson(s.user),
		});
		assert.equal(res.status, 402, res.text);
		assert.equal(await rig.runtime.readAgentSessionCommand("steer-broke-1"), null);
	});

	it("enforce: a funded follow-up is accepted (202) and queued", async () => {
		const s = await session();
		await seedBalance(rig.billing, s.user, 500_000);
		const res = await httpJson(rig.server.baseUrl, "POST", `/api/agent-sessions/${s.sessionId}/commands`, {
			body: commandBody("follow_up", "cmd-funded-1"),
			headers: asPerson(s.user),
		});
		assert.equal(res.status, 202, res.text);
		assert.equal((await rig.runtime.readAgentSessionCommand("cmd-funded-1"))?.state, "queued");
	});

	it("a retry of a command that was already accepted is idempotent, never a 402", async () => {
		// The first send succeeded and drained the balance; a network retry of the SAME command must return
		// the stored record. A 402 would tell the person their accepted message was refused.
		const s = await session();
		await seedBalance(rig.billing, s.user, 500_000);
		const body = commandBody("follow_up", "cmd-retry-1");
		const first = await httpJson(rig.server.baseUrl, "POST", `/api/agent-sessions/${s.sessionId}/commands`, {
			body,
			headers: asPerson(s.user),
		});
		assert.equal(first.status, 202, first.text);
		await drainTo(rig.billing, s.user, 0, "retry");

		const retry = await httpJson(rig.server.baseUrl, "POST", `/api/agent-sessions/${s.sessionId}/commands`, {
			body,
			headers: asPerson(s.user),
		});
		assert.equal(retry.status, 200, retry.text);
		assert.equal((retry.body as { duplicate: boolean }).duplicate, true);

		const fresh = await httpJson(rig.server.baseUrl, "POST", `/api/agent-sessions/${s.sessionId}/commands`, {
			body: commandBody("follow_up", "cmd-retry-2"),
			headers: asPerson(s.user),
		});
		assert.equal(fresh.status, 402, "but a NEW message from the same broke person is refused");
	});

	it("abort and goal commands are never gated: stopping a run must always be possible", async () => {
		const s = await session();
		await seedBalance(rig.billing, s.user, 0);
		const abort = await httpJson(rig.server.baseUrl, "POST", `/api/agent-sessions/${s.sessionId}/commands`, {
			body: commandBody("abort", "cmd-abort-1", { reason: "user stopped" }),
			headers: asPerson(s.user),
		});
		assert.ok(abort.status === 202 || abort.status === 200, abort.text);
		assert.deepEqual(await rig.billing.listGateEvents({ userId: s.user }), []);
	});

	it("prices the bar by the session's own voice: $0.05 funds a House chat and not an Opus chat", async () => {
		const house = await session("google/gemini-2.5-flash");
		const opus = await session("anthropic/claude-opus-4.5");
		await seedBalance(rig.billing, house.user, 50_000);
		await seedBalance(rig.billing, opus.user, 50_000);
		const houseRes = await httpJson(rig.server.baseUrl, "POST", `/api/agent-sessions/${house.sessionId}/commands`, {
			body: commandBody("follow_up", "cmd-house-1"),
			headers: asPerson(house.user),
		});
		assert.equal(houseRes.status, 202, houseRes.text);
		const opusRes = await httpJson(rig.server.baseUrl, "POST", `/api/agent-sessions/${opus.sessionId}/commands`, {
			body: commandBody("follow_up", "cmd-opus-1"),
			headers: asPerson(opus.user),
		});
		assert.equal(opusRes.status, 402, opusRes.text);
		assert.deepEqual(opusRes.body, insufficientCreditBody(50_000, OPUS_MIN_ADMIT));
	});

	it("observe: the follow-up is accepted and the dry run records would_block on the command door", async () => {
		rig.gate = observe;
		const s = await session();
		await seedBalance(rig.billing, s.user, 3_800);
		const res = await httpJson(rig.server.baseUrl, "POST", `/api/agent-sessions/${s.sessionId}/commands`, {
			body: commandBody("follow_up", "cmd-observe-1"),
			headers: asPerson(s.user),
		});
		assert.equal(res.status, 202, res.text);
		const [row] = await rig.billing.listGateEvents({ userId: s.user });
		assert.equal(row.decision, "would_block");
		assert.equal(row.door, "ingress.command");
	});

	it("another person's session is 403 before the gate is consulted", async () => {
		const s = await session();
		const stranger = "stranger-1";
		await seedBalance(rig.billing, stranger, 0);
		const res = await httpJson(rig.server.baseUrl, "POST", `/api/agent-sessions/${s.sessionId}/commands`, {
			body: commandBody("follow_up", "cmd-stranger-1"),
			headers: asPerson(stranger),
		});
		assert.equal(res.status, 403, res.text);
		assert.deepEqual(await rig.billing.listGateEvents({ userId: stranger }), []);
	});
});
