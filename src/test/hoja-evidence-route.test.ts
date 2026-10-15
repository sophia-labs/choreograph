import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { EvidenceStore } from "../evidence-store.js";
import { routeRequest } from "../orchestrator.js";
import { JournalStore } from "../workflow/journal-store.js";
import { HOJA_SWARM_WORKFLOW_NAME } from "../workflow/script-hoja-swarm.js";

test("Hoja evidence route authorizes the logical run and verifies private bytes", async (context) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "choreograph-hoja-evidence-route-"));
	const journal = new JournalStore(path.join(root, "journal.sqlite"));
	await journal.init();
	context.after(async () => {
		journal.close();
		await rm(root, { recursive: true, force: true });
	});
	const previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
	process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "test-secret";
	context.after(() => {
		if (previousSecret === undefined) delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		else process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
	});

	await journal.createRun({
		run_id: "wfr-transport-1",
		workflow_name: HOJA_SWARM_WORKFLOW_NAME,
		graph_id: "obs-hoja-local",
		owner_user_id: "user-1",
		started_at: 1,
		payload: { testimonyRunId: "logical-run-1", graphOwner: "user:owner-a" },
	});
	const evidence = EvidenceStore.fromUrl(`${pathToFileURL(path.join(root, "evidence")).toString()}/`);
	const ref = await evidence.put(
		["logical-run-1", "scenario-1", "beat-1", "camoufox"],
		"manifest",
		"json",
		"application/json",
		'{"schema":"sophia.browser-evidence-beat.v1"}\n',
	);
	await journal.appendEvent("wfr-transport-1", {
		type: "evidence_index",
		payload: {
			schema: "sophia.hoja.evidence-index.v1",
			logicalRunId: "logical-run-1",
			refs: [{ uri: ref.uri, sha256: ref.sha256 }],
		},
	});
	const query = new URLSearchParams({ uri: ref.uri, sha256: ref.sha256 });
	const ctx = { journal, evidence } as never;

	const getResponse = mockResponse();
	await routeRequest(mockRequest(`/api/workflows/runs/logical-run-1/evidence?${query}`), getResponse.response, ctx);
	assert.equal(getResponse.state.statusCode, 200);
	assert.equal(getResponse.state.headers["content-type"], "application/json");
	assert.equal(getResponse.state.headers["content-length"], String(ref.bytes));
	assert.equal(getResponse.state.body.toString("utf8"), '{"schema":"sophia.browser-evidence-beat.v1"}\n');

	const headResponse = mockResponse();
	await routeRequest(
		mockRequest(`/api/workflows/runs/logical-run-1/evidence?${query}`, "HEAD"),
		headResponse.response,
		ctx,
	);
	assert.equal(headResponse.state.statusCode, 200);
	assert.equal(headResponse.state.body.byteLength, 0);

	// The platform gateway has already checked graph Viewer access before using
	// internal-service auth. A different legitimate graph viewer can therefore
	// render the probe-owned filmstrip without becoming the run owner.
	const graphViewerResponse = mockResponse();
	await routeRequest(
		mockRequest(`/api/workflows/runs/logical-run-1/evidence?${query}`, "GET", "user-2"),
		graphViewerResponse.response,
		ctx,
	);
	assert.equal(graphViewerResponse.state.statusCode, 200);

	const wrongGraphResponse = mockResponse();
	await routeRequest(
		mockRequest(`/api/workflows/runs/logical-run-1/evidence?${query}`, "GET", "user-2", "obs-hoja-other"),
		wrongGraphResponse.response,
		ctx,
	);
	assert.equal(wrongGraphResponse.state.statusCode, 404);

	const foreignRef = await evidence.put(
		["logical-run-1", "scenario-1", "beat-foreign", "camoufox"],
		"manifest",
		"json",
		"application/json",
		"{}\n",
	);
	const foreignQuery = new URLSearchParams({ uri: foreignRef.uri, sha256: foreignRef.sha256 });
	const foreignResponse = mockResponse();
	await routeRequest(
		mockRequest(`/api/workflows/runs/logical-run-1/evidence?${foreignQuery}`),
		foreignResponse.response,
		ctx,
	);
	assert.equal(foreignResponse.state.statusCode, 404);

	await journal.createRun({
		run_id: "wfr-transport-owner-b",
		workflow_name: HOJA_SWARM_WORKFLOW_NAME,
		graph_id: "obs-hoja-local",
		owner_user_id: "user-3",
		started_at: 2,
		payload: { testimonyRunId: "logical-run-1", graphOwner: "user:owner-b" },
	});
	await journal.appendEvent("wfr-transport-owner-b", {
		type: "evidence_index",
		payload: {
			schema: "sophia.hoja.evidence-index.v1",
			logicalRunId: "logical-run-1",
			refs: [{ uri: foreignRef.uri, sha256: foreignRef.sha256 }],
		},
	});
	const collidingOwnerResponse = mockResponse();
	await routeRequest(
		mockRequest(`/api/workflows/runs/logical-run-1/evidence?${foreignQuery}`),
		collidingOwnerResponse.response,
		ctx,
	);
	assert.equal(collidingOwnerResponse.state.statusCode, 404);

	const ownerBResponse = mockResponse();
	await routeRequest(
		mockRequest(
			`/api/workflows/runs/logical-run-1/evidence?${foreignQuery}`,
			"GET",
			"user-4",
			"obs-hoja-local",
			"user:owner-b",
		),
		ownerBResponse.response,
		ctx,
	);
	assert.equal(ownerBResponse.state.statusCode, 200);
});

function mockRequest(
	pathname: string,
	method = "GET",
	userId = "user-1",
	graphId = "obs-hoja-local",
	graphOwner = "user:owner-a",
): IncomingMessage {
	return {
		method,
		url: pathname,
		headers: {
			host: "localhost:3456",
			"x-internal-service": "test-secret",
			"x-user-id": userId,
			"x-graph-id": graphId,
			"x-graph-owner": graphOwner,
		},
	} as unknown as IncomingMessage;
}

function mockResponse(): {
	response: ServerResponse;
	state: { statusCode: number; headers: Record<string, string | number>; body: Buffer };
} {
	const state = { statusCode: 200, headers: {} as Record<string, string | number>, body: Buffer.alloc(0) };
	const response = {
		get statusCode() {
			return state.statusCode;
		},
		set statusCode(value: number) {
			state.statusCode = value;
		},
		setHeader(name: string, value: string | number) {
			state.headers[name.toLowerCase()] = value;
		},
		end(value?: string | Buffer) {
			state.body = value === undefined ? Buffer.alloc(0) : Buffer.from(value);
		},
	} as unknown as ServerResponse;
	return { response, state };
}
