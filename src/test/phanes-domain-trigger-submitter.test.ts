import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PhanesDomainTriggerRequest } from "../internal-jobs/server.js";
import { phanesDomainTriggerSubmitter } from "../orchestrator.js";
import { INVOCATION_ENVELOPE_SCHEMA } from "../workflow/invocation.js";
import { DOMAIN_AGENT_ACTIVITY_LOOP_NAME } from "../workflow/script-domain-agent-activity-loop.js";
import { phanesPrivacyFixture } from "./phanes-privacy-fixture.js";

const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const FIXTURE = phanesPrivacyFixture(EVENT_ID, "f".repeat(64));
const EVENT_REF = FIXTURE.sourceRef;

function request(): PhanesDomainTriggerRequest {
	return {
		schema: "sophia.phanes-domain-trigger.v2",
		sourceCommit: { eventId: EVENT_ID, eventRef: EVENT_REF, digest: "f".repeat(64) },
		trigger: FIXTURE.trigger,
		contextRefs: FIXTURE.contextRefs,
	};
}

describe("Phanes private trigger submitter", () => {
	it("translates the committed host turn into one fixed internal-service invocation", async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			return new Response(
				JSON.stringify({
					runId: "wfr-phanes-1",
					invocationId: `inv-phanes-${EVENT_ID}`,
				}),
				{ status: 202, headers: { "content-type": "application/json" } },
			);
		}) as typeof fetch;
		const submitter = phanesDomainTriggerSubmitter(
			fakeFetch,
			{
				MNEMOSYNE_INTERNAL_SERVICE_SECRET: "internal-secret",
				PHANES_ON_BEHALF_OF: "cognito-subject",
				PHANES_GRAPH_OWNER: "user:phanes-owner",
				PHANES_GRAPH_ID: "phanes-home",
				PHANES_SOCIAL_GRAPH_ID: "phanes-social",
				PHANES_AGENT_DEFINITION_DOCUMENT_ID: "phanes-domain-agent",
			},
			4567,
		);

		const receipt = await submitter.submit(request());

		assert.deepEqual(receipt, {
			runId: "wfr-phanes-1",
			invocationId: `inv-phanes-${EVENT_ID}`,
		});
		assert.equal(calls.length, 1);
		assert.equal(calls[0]?.url, "http://127.0.0.1:4567/api/invocations");
		assert.deepEqual(calls[0]?.init?.headers, {
			"content-type": "application/json",
			prefer: "respond-async",
			"x-internal-service": "internal-secret",
			"x-user-id": "cognito-subject",
			"x-sophia-trigger-adapter": "discord",
		});
		const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
		assert.equal(body.schema, INVOCATION_ENVELOPE_SCHEMA);
		assert.equal(body.invocationId, `inv-phanes-${EVENT_ID}`);
		assert.equal((body.target as Record<string, unknown>).workflowName, DOMAIN_AGENT_ACTIVITY_LOOP_NAME);
		assert.deepEqual(body.graph, { ownerPrincipal: "user:phanes-owner", graphId: "phanes-home" });
		assert.deepEqual(body.cause, { kind: "trigger", ref: EVENT_REF });
		assert.equal(body.idempotencyKey, `phanes:${EVENT_ID}`);
		assert.deepEqual(body.input, {
			definitionDocumentId: "phanes-domain-agent",
			sourceCommit: {
				eventId: EVENT_ID,
				sourceRef: EVENT_REF,
				digest: "f".repeat(64),
			},
			trigger: {
				...request().trigger,
				sourceEventRef: EVENT_REF,
				sourceEventDigest: "f".repeat(64),
			},
			contextRefs: request().contextRefs,
		});
	});

	it("fails before HTTP when the fixed graph authority is incomplete", async () => {
		let called = false;
		const fakeFetch = (async () => {
			called = true;
			throw new Error("unexpected fetch");
		}) as typeof fetch;

		await assert.rejects(
			phanesDomainTriggerSubmitter(fakeFetch, {}, 4567).submit(request()),
			/authority is not configured/,
		);
		assert.equal(called, false);
	});

	it("rejects a legacy epoch-suffixed social graph before invocation", async () => {
		let called = false;
		const fakeFetch = (async () => {
			called = true;
			throw new Error("unexpected fetch");
		}) as typeof fetch;
		const legacy = structuredClone(request());
		(legacy.trigger.datasetEpoch as Record<string, unknown>).graphId = "phanes-social-deadbeef";

		await assert.rejects(
			phanesDomainTriggerSubmitter(
				fakeFetch,
				{
					MNEMOSYNE_INTERNAL_SERVICE_SECRET: "internal-secret",
					PHANES_ON_BEHALF_OF: "cognito-subject",
					PHANES_GRAPH_OWNER: "user:phanes-owner",
					PHANES_SOCIAL_GRAPH_ID: "phanes-social",
				},
				4567,
			).submit(legacy),
			/privacy dataset graph is invalid/,
		);
		assert.equal(called, false);
	});
});
