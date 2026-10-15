import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { after, before, describe, it } from "node:test";
import type { MeaningfulObjectKind, MeaningfulObjectRefV1 } from "../agent-runtime/meaningful-object.js";
import { routeRequest } from "../orchestrator.js";

const ownerUserId = "route-owner";
const ownerPrincipal = `user:${ownerUserId}`;
const agentId = "agent-0123456789abcdef";
const candidateId = "candidate-route-proof";
let priorInternalSecret: string | undefined;

before(() => {
	priorInternalSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
	process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "route-test-secret";
});

after(() => {
	if (priorInternalSecret === undefined) delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
	else process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = priorInternalSecret;
});

function ref<Kind extends MeaningfulObjectKind>(
	kind: Kind,
	objectId: string,
	principal = ownerPrincipal,
): MeaningfulObjectRefV1<Kind> {
	return {
		schema: "sophia.meaningful-object-ref.v1",
		kind,
		ownerPrincipal: principal,
		graphId: "g-route-evolution",
		objectId,
		version: "1",
		digest: `sha256:${"a".repeat(64)}`,
	};
}

function request(input: {
	readonly method?: string;
	readonly url: string;
	readonly body?: unknown;
	readonly headers?: Record<string, string>;
}): IncomingMessage {
	const body = input.body === undefined ? "" : JSON.stringify(input.body);
	return {
		method: input.method ?? "GET",
		url: input.url,
		headers: {
			host: "localhost:3456",
			"x-internal-service": "route-test-secret",
			"x-user-id": ownerUserId,
			...input.headers,
		},
		on() {},
		async *[Symbol.asyncIterator]() {
			if (body) yield Buffer.from(body);
		},
	} as unknown as IncomingMessage;
}

function response(): {
	readonly value: ServerResponse;
	readonly state: { status: number; headers: Record<string, string | number>; body: string | Buffer };
} {
	const state = { status: 0, headers: {} as Record<string, string | number>, body: "" as string | Buffer };
	const value = {
		get statusCode() {
			return state.status;
		},
		set statusCode(next: number) {
			state.status = next;
		},
		setHeader(name: string, next: string | number) {
			state.headers[name.toLowerCase()] = next;
		},
		end(chunk?: string | Buffer) {
			state.body = chunk ?? "";
		},
	} as unknown as ServerResponse;
	return { value, state };
}

function jsonBody(state: { readonly body: string | Buffer }): Record<string, unknown> {
	return JSON.parse(Buffer.isBuffer(state.body) ? state.body.toString("utf8") : state.body) as Record<string, unknown>;
}

describe("owner-scoped evolution HTTP routes", () => {
	it("lists and reads only through the authenticated owner context", async () => {
		const calls: unknown[] = [];
		const evolution = {
			async listOwner(principal: string, selectedAgentId?: string) {
				calls.push({ principal, selectedAgentId });
				return { objects: [{ ref: ref("embodiment-candidate", candidateId) }] };
			},
			async getCandidate(principal: string, selectedCandidateId: string) {
				calls.push({ principal, selectedCandidateId });
				return { candidate: { ref: ref("embodiment-candidate", selectedCandidateId) } };
			},
		};
		const inbox = response();
		await routeRequest(request({ url: `/api/evolutions?agent_id=${agentId}` }), inbox.value, { evolution } as never);
		assert.equal(inbox.state.status, 200);
		assert.equal(jsonBody(inbox.state).ownerPrincipal, ownerPrincipal);
		const room = response();
		await routeRequest(request({ url: `/api/candidates/${candidateId}` }), room.value, { evolution } as never);
		assert.equal(room.state.status, 200);
		assert.deepEqual(calls, [
			{ principal: ownerPrincipal, selectedAgentId: agentId },
			{ principal: ownerPrincipal, selectedCandidateId: candidateId },
		]);
	});

	it("requires idempotency and passes exact owner refs to promotion", async () => {
		let observed: Record<string, unknown> | undefined;
		const evolution = {
			async decidePromotion(input: Record<string, unknown>) {
				observed = input;
				return { decisionRef: ref("promotion-decision", "decision-route-proof") };
			},
		};
		const missingKey = response();
		await routeRequest(
			request({
				method: "POST",
				url: `/api/candidates/${candidateId}/promotion-decisions`,
				body: { agentId, candidateRef: ref("embodiment-candidate", candidateId), verdict: "approved" },
			}),
			missingKey.value,
			{ evolution } as never,
		);
		assert.equal(missingKey.state.status, 400);
		assert.equal(observed, undefined);

		const accepted = response();
		await routeRequest(
			request({
				method: "POST",
				url: `/api/candidates/${candidateId}/promotion-decisions`,
				headers: { "idempotency-key": "approve-route-proof" },
				body: {
					agentId,
					candidateRef: ref("embodiment-candidate", candidateId),
					verdict: "approved",
					reason: "Exact packet accepted.",
				},
			}),
			accepted.value,
			{ evolution } as never,
		);
		assert.equal(accepted.state.status, 201);
		assert.deepEqual(observed, {
			ownerPrincipal,
			agentId,
			candidateRef: ref("embodiment-candidate", candidateId),
			verdict: "approved",
			idempotencyKey: "approve-route-proof",
			reason: "Exact packet accepted.",
		});
	});

	it("rejects a cross-owner ref before calling the transition authority", async () => {
		let called = false;
		const evolution = {
			async activate() {
				called = true;
				return {};
			},
		};
		const result = response();
		await routeRequest(
			request({
				method: "POST",
				url: `/api/agents/${agentId}/activations`,
				headers: { "idempotency-key": "cross-owner-route-proof" },
				body: {
					mode: "future-sessions",
					candidateRef: ref("embodiment-candidate", candidateId, "user:attacker"),
					promotionDecisionRef: ref("promotion-decision", "decision-route-proof"),
					expectedIncumbentRef: ref("embodiment", "embodiment-incumbent"),
				},
			}),
			result.value,
			{ evolution } as never,
		);
		assert.equal(result.state.status, 400);
		assert.equal(called, false);
	});

	it("serves owner-authorized patch bytes without exposing a storage path", async () => {
		const body = Buffer.from("exact bounded patch\n", "utf8");
		const evolution = {
			async readPatchArtifact(principal: string, patchSetId: string) {
				assert.equal(principal, ownerPrincipal);
				assert.equal(patchSetId, "patch-route-proof");
				return { mediaType: "text/x-diff", contentDigest: `sha256:${"b".repeat(64)}`, body };
			},
		};
		const result = response();
		await routeRequest(request({ url: "/api/patches/patch-route-proof/content" }), result.value, {
			evolution,
		} as never);
		assert.equal(result.state.status, 200);
		assert.equal(result.state.headers["content-type"], "text/x-diff");
		assert.deepEqual(result.state.body, body);
		assert.equal(JSON.stringify(result.state).includes("hostPath"), false);
	});
});
