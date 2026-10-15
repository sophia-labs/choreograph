import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canonicalJson } from "@sophia-labs/canonical-json";
import type { ExecutionCell } from "../agent-runtime/execution-service.js";
import {
	AgentNotebookLayoutCasMismatchError,
	buildAgentNotebookAttachedLayoutCasMigration,
	buildAgentNotebookFamilyLayout,
	buildAgentNotebookLayout,
	buildAgentNotebookLayoutCasMigration,
	buildAgentNotebookLayoutSeed,
	buildAgentNotebookProjection,
	notebookProjectionIdentity,
	projectExecutionCellToNotebook,
} from "../agent-runtime/notebook-graph-projection.js";

const GRAPH_ID = "prime-notebook-lab";
const SESSION_ID = "ags_notebook_surface";
const AUTHORED_AT = Date.parse("2026-08-07T12:00:00.000Z");

function cell(overrides: Partial<ExecutionCell> = {}): ExecutionCell {
	return {
		schema: "choreograph.compute-cell.v1",
		cellRef: `compute.cell:${SESSION_ID}:0:0`,
		sessionId: SESSION_ID,
		leaseId: "lease-1",
		kernelSandboxId: "kernel-1",
		inputId: "input-1",
		ordinal: 0,
		generation: 0,
		code: 'print("hello\\nworld")\n{"answer": 42}',
		status: "ok",
		executionCount: 1,
		outputs: [
			{ kind: "stream", name: "stdout", text: "hello\nworld\n" },
			{
				kind: "result",
				data: {
					"text/plain": "{'answer': 42}",
					"application/json": { answer: 42 },
					"text/html": '<strong data-answer="42">forty-two</strong>',
				},
			},
		],
		startedAt: AUTHORED_AT + 100,
		completedAt: AUTHORED_AT + 250,
		durationMs: 150,
		hostRequests: [],
		cellDigest: "sha256:cell-digest",
		...overrides,
	};
}

describe("agent notebook graph projection", () => {
	it("authors a polling LayoutDocument over ordered compute-cell resources", () => {
		const layout = buildAgentNotebookLayout(GRAPH_ID, SESSION_ID, AUTHORED_AT) as {
			graphId: string;
			createdAt: string;
			nodes: Record<string, { children: Record<string, unknown> }>;
		};
		const children = layout.nodes["notebook-cells"].children;
		assert.equal(layout.graphId, GRAPH_ID);
		assert.equal(layout.createdAt, "2026-08-07T12:00:00.000Z");
		assert.equal(children.itemFaceId, "compute.cell");
		assert.deepEqual(children.itemParams, { graphId: "?graphId" });
		assert.equal(children.refreshSeconds, 1);
		assert.match((children.collection as { queryId: string }).queryId, /ORDER BY \?generation \?ordinal/);
		assert.match(
			(children.collection as { queryId: string }).queryId,
			/GRAPH <urn:mnemosyne:local:graph:prime-notebook-lab:user:rdf>/,
		);
	});

	it("mints stable opaque identities without embedding session or cell refs", () => {
		const a = notebookProjectionIdentity(SESSION_ID, cell().cellRef);
		const b = notebookProjectionIdentity(SESSION_ID, cell().cellRef);
		assert.deepEqual(a, b);
		assert.ok(!a.notebookIri.includes(SESSION_ID));
		assert.ok(!a.cellIri.includes(cell().cellRef));
	});

	it("builds a deterministic, idempotent data projection with no UX writes", () => {
		const input = {
			graphId: GRAPH_ID,
			sessionId: SESSION_ID,
			cell: cell(),
			layoutAuthoredAt: AUTHORED_AT,
			attachToGardenCenter: true,
		};
		const first = buildAgentNotebookProjection(input);
		const second = buildAgentNotebookProjection(input);
		assert.equal(first, second);
		assert.match(first, /GRAPH <urn:mnemosyne:local:graph:prime-notebook-lab:user:rdf>/);
		assert.match(first, /a comp:ComputeCell/);
		assert.match(first, /comp:source "print\(\\"hello/);
		assert.match(first, /comp:outputsJson/);
		assert.doesNotMatch(first, /ux:config|ux:layoutJson|PREFIX (?:sux|ux):|sux:/);
		assert.equal((first.match(/<urn:sophia:compute-cell:[^>]+>/g) ?? []).length, 3);
	});

	it("builds an absence-only deterministic layout and workspace seed", () => {
		const input = {
			graphId: GRAPH_ID,
			sessionId: SESSION_ID,
			layoutAuthoredAt: AUTHORED_AT,
			attachToGardenCenter: true,
		};
		const first = buildAgentNotebookLayoutSeed(input);
		const second = buildAgentNotebookLayoutSeed(input);
		assert.equal(first, second);
		assert.doesNotMatch(first, /\bDELETE\b/);
		assert.match(first, /ux:layoutJson/);
		assert.match(first, /FILTER NOT EXISTS \{ GRAPH .* ux:layoutJson \?existingLayout/);
		assert.match(first, /a sux:Workspace/);
		assert.match(first, /FILTER NOT EXISTS \{ GRAPH .* \{ \?workspace a sux:Workspace/);
		assert.match(first, /sux:renderedByComponent \?existingComponent/);
		assert.match(first, /sux:fragmentSurface \?existingSurface/);
	});

	it("seeds the layout without rearranging Garden when attachment is not explicit", () => {
		const update = buildAgentNotebookLayoutSeed({
			graphId: GRAPH_ID,
			sessionId: SESSION_ID,
			layoutAuthoredAt: AUTHORED_AT,
		});
		assert.match(update, /ux:layoutJson/);
		assert.ok(!update.includes("sux:renderedByComponent"));
		assert.ok(!update.includes("sux:fragmentSurface"));
		assert.ok(!update.includes("a sux:Workspace"));
	});

	it("builds an exact-match-only layout migration deterministically", () => {
		const expectedLayoutJson = '{"schemaVersion":1, "sentinel":"byte-exact-source"}';
		const replacementLayoutJson = '{"schemaVersion":1,"sentinel":"replacement"}';
		const input = {
			graphId: GRAPH_ID,
			sessionId: SESSION_ID,
			currentLayoutJson: expectedLayoutJson,
			expectedLayoutJson,
			replacementLayoutJson,
		};
		const first = buildAgentNotebookLayoutCasMigration(input);
		const second = buildAgentNotebookLayoutCasMigration(input);
		assert.equal(first, second);
		assert.match(first, /DELETE[\s\S]+INSERT[\s\S]+WHERE/);
		assert.equal((first.match(/byte-exact-source/g) ?? []).length, 2);
		assert.equal((first.match(/replacement/g) ?? []).length, 1);
		assert.doesNotMatch(first, /\?oldLayout|\?existingLayout/);
	});

	it("upgrades only the exact runtime seed to a notebook and Session-family split", () => {
		const currentLayoutJson = canonicalJson(buildAgentNotebookLayout(GRAPH_ID, SESSION_ID, AUTHORED_AT));
		const replacement = buildAgentNotebookFamilyLayout({
			graphId: GRAPH_ID,
			sessionId: SESSION_ID,
			familyRootSessionIri: "urn:sophia:agent:agent-example:session:ags_root",
			currentLayoutJson,
			updatedAt: AUTHORED_AT + 1_000,
		});
		const parsed = JSON.parse(replacement) as {
			rootNodeId: string;
			nodes: Record<string, Record<string, unknown>>;
			updatedAt: string;
		};
		assert.equal(parsed.rootNodeId, "agent-session-split");
		assert.deepEqual(parsed.nodes["agent-session-split"], {
			axis: "horizontal",
			endNodeId: "agent-session-family",
			id: "agent-session-split",
			kind: "split",
			startBasisPoints: 6500,
			startNodeId: "notebook-cells",
		});
		assert.equal(
			(parsed.nodes["agent-session-family"].descriptor as { faceId: string }).faceId,
			"agent.session-family",
		);
		const familyCellsQuery = (parsed.nodes["notebook-cells"].children as { collection: { queryId: string } })
			.collection.queryId;
		assert.match(familyCellsQuery, /\(\^ar:parentSession\/ar:childSession\)\+/);
		assert.match(familyCellsQuery, /agt:sessionId \?sessionId/);
		assert.match(familyCellsQuery, /comp:sessionId \?sessionId/);
		assert.match(familyCellsQuery, /ORDER BY \?depth \?sessionId \?generation \?ordinal/);
		assert.match(familyCellsQuery, new RegExp(`GRAPH <urn:mnemosyne:local:graph:${GRAPH_ID}:user:rdf>`));
		assert.equal(parsed.updatedAt, "2026-08-07T12:00:01.000Z");

		assert.throws(
			() =>
				buildAgentNotebookFamilyLayout({
					graphId: GRAPH_ID,
					sessionId: SESSION_ID,
					familyRootSessionIri: "urn:sophia:agent:agent-example:session:ags_root",
					currentLayoutJson: canonicalJson({
						...JSON.parse(currentLayoutJson),
						authored: true,
					}),
					updatedAt: AUTHORED_AT + 1_000,
				}),
			AgentNotebookLayoutCasMismatchError,
		);
	});

	it("atomically fences the exact layout and exact center attachment", () => {
		const expectedLayoutJson = canonicalJson(buildAgentNotebookLayout(GRAPH_ID, SESSION_ID, AUTHORED_AT));
		const replacementLayoutJson = buildAgentNotebookFamilyLayout({
			graphId: GRAPH_ID,
			sessionId: SESSION_ID,
			familyRootSessionIri: "urn:sophia:agent:agent-example:session:ags_root",
			currentLayoutJson: expectedLayoutJson,
			updatedAt: AUTHORED_AT + 1_000,
		});
		const update = buildAgentNotebookAttachedLayoutCasMigration({
			graphId: GRAPH_ID,
			sessionId: SESSION_ID,
			currentLayoutJson: expectedLayoutJson,
			expectedLayoutJson,
			replacementLayoutJson,
			expectedCenterSurfaceIri: "urn:sophia:ux:surface:agent-notebook:prior",
		});
		const target = notebookProjectionIdentity(SESSION_ID, "layout").surfaceIri;
		assert.match(update, /DELETE[\s\S]+INSERT[\s\S]+WHERE/);
		assert.equal((update.match(/fragmentSurface/g) ?? []).length, 3);
		assert.equal((update.match(/agent-notebook:prior/g) ?? []).length, 2);
		assert.equal((update.match(new RegExp(target, "g")) ?? []).length, 4);
		assert.doesNotMatch(update, /OPTIONAL|FILTER NOT EXISTS/);
	});

	it("refuses a mismatched migration and reports authored-layout preservation without leaking it", () => {
		const authoredLayoutJson = '{"schemaVersion":1,"sentinel":"authored-layout-must-survive"}';
		let refusal: unknown;
		try {
			buildAgentNotebookLayoutCasMigration({
				graphId: GRAPH_ID,
				sessionId: SESSION_ID,
				currentLayoutJson: authoredLayoutJson,
				expectedLayoutJson: '{"schemaVersion":1,"sentinel":"stale-read"}',
				replacementLayoutJson: '{"schemaVersion":1,"sentinel":"replacement"}',
			});
		} catch (error) {
			refusal = error;
		}
		assert.ok(refusal instanceof AgentNotebookLayoutCasMismatchError);
		assert.equal(refusal.code, "agent_notebook_layout_cas_mismatch");
		assert.equal(refusal.preserved, true);
		assert.equal(refusal.expectedSha256.length, 64);
		assert.equal(refusal.actualSha256.length, 64);
		assert.notEqual(refusal.expectedSha256, refusal.actualSha256);
		assert.ok(!refusal.message.includes("authored-layout-must-survive"));

		const seed = buildAgentNotebookLayoutSeed({
			graphId: GRAPH_ID,
			sessionId: SESSION_ID,
			layoutAuthoredAt: AUTHORED_AT,
			attachToGardenCenter: true,
		});
		assert.doesNotMatch(seed, /\bDELETE\b/);
		assert.match(seed, /FILTER NOT EXISTS[\s\S]+\?existingLayout/);
		assert.match(seed, /FILTER NOT EXISTS[\s\S]+\?existingComponent/);
		assert.match(seed, /FILTER NOT EXISTS[\s\S]+\?existingSurface/);
	});

	it("calls the cloud-2 cell with data first and the absence-only seed second", async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		await projectExecutionCellToNotebook(
			{
				async callTool(name, args) {
					calls.push({ name, args });
					return { ok: true };
				},
			},
			{ graphId: GRAPH_ID, sessionId: SESSION_ID, cell: cell(), layoutAuthoredAt: AUTHORED_AT },
		);
		assert.equal(calls.length, 2);
		assert.equal(calls[0].name, "sparql_update");
		assert.equal(calls[0].args.graphId, GRAPH_ID);
		assert.doesNotMatch(String(calls[0].args.update), /ux:config|ux:layoutJson/);
		assert.equal(calls[1].name, "sparql_update");
		assert.equal(calls[1].args.graphId, GRAPH_ID);
		assert.match(String(calls[1].args.update), /ux:layoutJson/);
		assert.doesNotMatch(String(calls[1].args.update), /\bDELETE\b/);
	});

	it("rejects authority or identity drift before writing", () => {
		assert.throws(
			() =>
				buildAgentNotebookProjection({
					graphId: "Bad_Graph",
					sessionId: SESSION_ID,
					cell: cell(),
					layoutAuthoredAt: AUTHORED_AT,
				}),
			/graph id is invalid/,
		);
		assert.throws(
			() =>
				buildAgentNotebookProjection({
					graphId: GRAPH_ID,
					sessionId: SESSION_ID,
					cell: cell({ sessionId: "other-session" }),
					layoutAuthoredAt: AUTHORED_AT,
				}),
			/session does not match/,
		);
	});
});
