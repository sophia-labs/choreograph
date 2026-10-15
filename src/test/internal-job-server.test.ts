import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { InternalStageJob } from "../internal-jobs/contracts.js";
import type { InternalJobRunner } from "../internal-jobs/runner.js";
import { type InternalJobServer, startInternalJobServer } from "../internal-jobs/server.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import { phanesPrivacyFixture } from "./phanes-privacy-fixture.js";

const JOB_ID = "88888888-8888-4888-8888-888888888888";
const DIGEST = "c".repeat(64);
const TOKEN = "0123456789abcdef0123456789abcdef";
const SOURCE_EVENT_1 = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SOURCE_EVENT_2 = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const SOURCE_EVENT_3 = "01ARZ3NDEKTSV4RRFFQ69G5FAX";

function job(): InternalStageJob {
	return {
		job_id: JOB_ID,
		stage: "transcription",
		state: "queued",
		input_digest: DIGEST,
		input: { manifest_sha256: DIGEST },
		parameters: { preferred_model: "vibeasr-bitnet" },
		attempt: 1,
		model: "vibeasr-bitnet",
		created_at: "2026-07-30T22:00:00Z",
		updated_at: "2026-07-30T22:00:00Z",
	};
}

function call(
	socketPath: string,
	path: string,
	options?: { token?: string; method?: string; body?: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> {
	const payload = options?.body == null ? undefined : JSON.stringify(options.body);
	return new Promise((resolve, reject) => {
		const req = request(
			{
				socketPath,
				path,
				method: options?.method ?? "GET",
				headers: {
					authorization: `Bearer ${options?.token ?? TOKEN}`,
					...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
				},
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk) => chunks.push(chunk));
				response.on("end", () => {
					resolve({
						status: response.statusCode ?? 0,
						body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
					});
				});
			},
		);
		req.on("error", reject);
		if (payload) req.write(payload);
		req.end();
	});
}

describe("internal Unix job server", () => {
	const root = mkdtempSync(join(tmpdir(), "internal-server-"));
	const socketPath = join(root, "jobs.sock");
	let server: InternalJobServer;
	let runtime: WorkflowRuntimeStore;
	const submittedTriggers: unknown[] = [];
	const retiredEpochs: string[] = [];
	const fakeRunner = {
		submit: () => job(),
		status: () => job(),
		retry: () => ({ ...job(), state: "running", attempt: 2, model: "whisper-small-en" }),
		cancel: async () => ({ ...job(), state: "cancelled" }),
	} as unknown as InternalJobRunner;

	before(async () => {
		runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		await runtime.init();
		server = await startInternalJobServer({
			socketPath,
			token: TOKEN,
			runner: fakeRunner,
			effectStore: runtime,
			effectCapabilities: ["discord", "audio"],
			domainTrigger: {
				async submit(trigger) {
					submittedTriggers.push(trigger);
					return { runId: "wfr-phanes-1", invocationId: "inv-phanes-source-event-1" };
				},
			},
			privacyRetirement: {
				async retire(activeEpochId) {
					retiredEpochs.push(activeEpochId);
					return {
						schema: "sophia.privacy-epoch-retirement-receipt.v1",
						activeEpochId,
						retiredRunCount: 2,
						retiredSnapshotCount: 2,
					};
				},
			},
		});
	});

	after(async () => {
		await server.close();
		runtime.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("requires the dedicated bearer token", async () => {
		const response = await call(socketPath, `/internal/jobs/${JOB_ID}/stages/transcription`, {
			token: "wrong",
		});
		assert.equal(response.status, 401);
	});

	it("returns only public stage status fields", async () => {
		const response = await call(socketPath, "/internal/jobs", {
			method: "POST",
			body: {
				schema_version: 1,
				job_id: JOB_ID,
				stage: "transcription",
				input_digest: DIGEST,
				input: { manifest_sha256: DIGEST },
				parameters: { preferred_model: "vibeasr-bitnet" },
			},
		});
		assert.equal(response.status, 202);
		const status = response.body.job as Record<string, unknown>;
		assert.equal(status.job_id, JOB_ID);
		assert.equal("input" in status, false);
		assert.equal("parameters" in status, false);
	});

	it("rejects path-shaped job IDs before routing", async () => {
		const response = await call(socketPath, "/internal/jobs/not-a-uuid/stages/transcription");
		assert.equal(response.status, 400);
	});

	it("routes stage names through the registered stage contract", async () => {
		const response = await call(socketPath, `/internal/jobs/${JOB_ID}/stages/agent-reasoning`);
		assert.equal(response.status, 400);
		assert.match(String(response.body.error), /unsupported stage/);
	});

	it("leases and completes a durable Discord effect without exposing the lease on status reads", async () => {
		const key = `effect:${"a".repeat(64)}`;
		await runtime.offerEffectHandoff({
			idempotencyKey: key,
			executionDigest: "b".repeat(64),
			proposalDigest: "c".repeat(64),
			runId: "wfr-1",
			graphId: "phanes",
			agentId: "agent-7068616e65730001",
			actorRef: "agent:phanes-listener",
			grantId: "grant-phanes",
			grantDocumentId: "grant-phanes",
			grantAuthorityGraphId: "observatory",
			grantAuthorityOwnerPrincipal: "user:platform-steward",
			grantDigest: "d".repeat(64),
			sourceTurnId: `turn:${"1".repeat(64)}`,
			sourceTurnDigest: "e".repeat(64),
			sourceOwnerPrincipal: "user:ada",
			sourceTurn: { schema: "sophia.domain-source-turn.v1", turnId: `turn:${"1".repeat(64)}` },
			capability: "discord",
			operation: "message.reply",
			proposal: { arguments: { channelId: "2", replyToMessageId: "3", text: "hello" } },
			trigger: { eventId: "source-1", resource: "discord:guild:1:channel:2:message:3" },
			approval: {
				effectId: "reply-1",
				grantId: "grant-phanes",
				proposalDigest: "c".repeat(64),
				approvedBy: "user:ada",
				approvedAt: Date.now() - 2,
			},
			effectIndex: 0,
			now: Date.now() - 1,
		});
		const claimed = await call(socketPath, "/internal/effects/claim", {
			method: "POST",
			body: { consumer: "phanes-listener", capabilities: ["discord"], lease_ms: 30_000 },
		});
		assert.equal(claimed.status, 200);
		const effect = claimed.body.effect as Record<string, unknown>;
		assert.equal(effect.idempotency_key, key);
		assert.equal(effect.state, "claimed");
		assert.equal((effect.approval as { approvedBy: string }).approvedBy, "user:ada");
		assert.match(String(effect.claim_token), /^[0-9a-f-]{36}$/);

		const stale = await call(socketPath, `/internal/effects/${encodeURIComponent(key)}/complete`, {
			method: "POST",
			body: {
				consumer: "phanes-listener",
				claim_token: "11111111-1111-4111-8111-111111111111",
				outcome: "executed",
				completion: { message_id: "4" },
			},
		});
		assert.equal(stale.status, 409);
		const completed = await call(socketPath, `/internal/effects/${encodeURIComponent(key)}/complete`, {
			method: "POST",
			body: {
				consumer: "phanes-listener",
				claim_token: effect.claim_token,
				outcome: "executed",
				completion: { message_id: "4" },
			},
		});
		assert.equal(completed.status, 200);
		assert.equal((completed.body.effect as Record<string, unknown>).state, "executed");

		const status = await call(socketPath, `/internal/effects/${encodeURIComponent(key)}`);
		assert.equal(status.status, 200);
		assert.equal("claim_token" in (status.body.effect as Record<string, unknown>), false);
	});

	it("refuses effect capabilities outside the socket's exact adapter allowlist", async () => {
		const response = await call(socketPath, "/internal/effects/claim", {
			method: "POST",
			body: { consumer: "phanes-listener", capabilities: ["site"], lease_ms: 30_000 },
		});
		assert.equal(response.status, 403);
	});

	it("retires a canonical Phanes privacy epoch through the private host boundary", async () => {
		const activeEpochId = "2".repeat(32);
		const response = await call(socketPath, "/internal/privacy/phanes/retire", {
			method: "POST",
			body: {
				schema: "sophia.privacy-epoch-retirement-request.v1",
				active_epoch_id: activeEpochId,
			},
		});
		assert.equal(response.status, 200);
		assert.equal((response.body.receipt as Record<string, unknown>).activeEpochId, activeEpochId);
		assert.deepEqual(retiredEpochs, [activeEpochId]);

		const rawCoordinate = await call(socketPath, "/internal/privacy/phanes/retire", {
			method: "POST",
			body: {
				schema: "sophia.privacy-epoch-retirement-request.v1",
				active_epoch_id: activeEpochId,
				guild_id: "123",
			},
		});
		assert.equal(rawCoordinate.status, 400);
	});

	it("accepts only a host-normalized Phanes trigger with a durable source witness", async () => {
		const fixture = phanesPrivacyFixture(SOURCE_EVENT_1, "f".repeat(64));
		const sourceRef = fixture.sourceRef;
		const response = await call(socketPath, "/internal/domain-agents/phanes/trigger", {
			method: "POST",
			body: {
				schema: "sophia.phanes-domain-trigger.v2",
				source_commit: { event_id: SOURCE_EVENT_1, event_ref: sourceRef, digest: "f".repeat(64) },
				trigger: fixture.wireTrigger,
				context_refs: fixture.contextRefs,
			},
		});
		assert.equal(response.status, 202);
		assert.equal(response.body.run_id, "wfr-phanes-1");
		assert.deepEqual(submittedTriggers.at(-1), {
			schema: "sophia.phanes-domain-trigger.v2",
			sourceCommit: { eventId: SOURCE_EVENT_1, eventRef: sourceRef, digest: "f".repeat(64) },
			trigger: fixture.trigger,
			contextRefs: fixture.contextRefs,
		});
		assert.equal(JSON.stringify(submittedTriggers.at(-1)).includes("guild_id"), false);
		assert.equal(JSON.stringify(submittedTriggers.at(-1)).includes("channel_id"), false);

		const missingCommit = await call(socketPath, "/internal/domain-agents/phanes/trigger", {
			method: "POST",
			body: {
				schema: "sophia.phanes-domain-trigger.v2",
				source_commit: { event_id: SOURCE_EVENT_1, event_ref: sourceRef, digest: "f".repeat(64) },
				trigger: fixture.wireTrigger,
				context_refs: [],
			},
		});
		assert.equal(missingCommit.status, 400);

		const ambientFixture = phanesPrivacyFixture(SOURCE_EVENT_2, "e".repeat(64));
		const ambient = await call(socketPath, "/internal/domain-agents/phanes/trigger", {
			method: "POST",
			body: {
				schema: "sophia.phanes-domain-trigger.v2",
				source_commit: {
					event_id: SOURCE_EVENT_2,
					event_ref: ambientFixture.sourceRef,
					digest: "e".repeat(64),
				},
				trigger: { ...ambientFixture.wireTrigger, kind: "discord.message.ambient" },
				context_refs: ambientFixture.contextRefs,
			},
		});
		assert.equal(ambient.status, 400);

		const rawCoordinateFixture = phanesPrivacyFixture(SOURCE_EVENT_3, "d".repeat(64));
		const rawCoordinate = await call(socketPath, "/internal/domain-agents/phanes/trigger", {
			method: "POST",
			body: {
				schema: "sophia.phanes-domain-trigger.v2",
				source_commit: {
					event_id: SOURCE_EVENT_3,
					event_ref: rawCoordinateFixture.sourceRef,
					digest: "d".repeat(64),
				},
				trigger: { ...rawCoordinateFixture.wireTrigger, guild_id: "1" },
				context_refs: rawCoordinateFixture.contextRefs,
			},
		});
		assert.equal(rawCoordinate.status, 400);
	});
});

describe("internal Unix job server shutdown admission", () => {
	it("drains a pre-latch request and rejects a post-latch accepted request before route authority", async () => {
		const root = mkdtempSync(join(tmpdir(), "internal-server-shutdown-"));
		const socketPath = join(root, "jobs.sock");
		let releaseSubmit!: () => void;
		const submitReleased = new Promise<void>((resolve) => {
			releaseSubmit = resolve;
		});
		let enterSubmit!: () => void;
		const submitEntered = new Promise<void>((resolve) => {
			enterSubmit = resolve;
		});
		let submitCalls = 0;
		let statusCalls = 0;
		const runner = {
			async submit() {
				submitCalls += 1;
				enterSubmit();
				await submitReleased;
				return job();
			},
			status() {
				statusCalls += 1;
				return job();
			},
		} as unknown as InternalJobRunner;
		const server = await startInternalJobServer({ socketPath, token: TOKEN, runner });
		const socket = connect(socketPath);
		const chunks: Buffer[] = [];
		socket.on("data", (chunk) => chunks.push(chunk));
		const ended = new Promise<void>((resolve, reject) => {
			socket.once("end", resolve);
			socket.once("error", reject);
		});
		const payload = JSON.stringify({
			schema_version: 1,
			job_id: JOB_ID,
			stage: "transcription",
			input_digest: DIGEST,
			input: { manifest_sha256: DIGEST },
			parameters: { preferred_model: "vibeasr-bitnet" },
		});
		try {
			await new Promise<void>((resolve, reject) => {
				socket.once("connect", resolve);
				socket.once("error", reject);
			});
			socket.write(
				`POST /internal/jobs HTTP/1.1\r\nHost: internal\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: keep-alive\r\n\r\n${payload}`,
			);
			await submitEntered;
			const closing = server.close();
			let rejectedBody = "";
			const rejectedResponse = {
				statusCode: 0,
				setHeader() {},
				end(body: string) {
					rejectedBody = body;
				},
			};
			// Force the exact request-listener seam that an already-accepted,
			// pipelined Unix-socket request reaches after the close latch. This
			// cannot be expressed through a second client write because Node's
			// current server.close() implementation discards that request first.
			server.server.emit("request", {} as never, rejectedResponse as never);
			assert.equal(rejectedResponse.statusCode, 503);
			assert.match(rejectedBody, /shutting down/);
			releaseSubmit();
			await closing;
			await ended;
			const raw = Buffer.concat(chunks).toString("utf8");
			assert.equal((raw.match(/HTTP\/1\.1 202/g) ?? []).length, 1, raw);
			assert.equal(submitCalls, 1);
			assert.equal(statusCalls, 0, "the post-latch route must not reach runner/store authority");
		} finally {
			releaseSubmit();
			socket.destroy();
			await server.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
