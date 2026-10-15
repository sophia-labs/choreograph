/**
 * Gated gateway integration test for the Loom provenance round-trip.
 *
 * This does NOT need bwrap (no worker spawn) — it exercises the orchestrator→graph
 * half end-to-end against a live Mnemosyne gateway: emit wf:Run + wf:AgentRun via
 * sparql_update, then read them back via sparql_query and assert the contract.
 *
 * Enable by setting (the canary host has these):
 *   MNEMOSYNE_GATEWAY_BASE_URL  e.g. https://gateway.internal
 *   MNEMOSYNE_SERVICE_TOKEN     the service bearer
 *   WORKFLOW_TEST_GRAPH         a scratch graph the acting user can write (e.g. workflow-engine-smoke)
 *   WORKFLOW_TEST_USER          the on-behalf-of Cognito sub with ACL on that graph
 *
 * Full fan-out (real worker spawn) E2E is host-only (needs bwrap) — see
 * docs/workflow-engine/STATUS.md for the curl recipe.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostedMnemosyneProxy } from "../mnemosyne.js";
import { makeHostedGraphWriter } from "../workflow/graph-writer.js";
import { buildRunDelete, emitRunProvenance } from "../workflow/provenance.js";
import type { AgentNodeResult, RunRecord } from "../workflow/types.js";
import { mintRunUri, PREFIXES, userRdfGraphIri } from "../workflow/vocab.js";

const GATEWAY = process.env.MNEMOSYNE_GATEWAY_BASE_URL;
const SERVICE_TOKEN = process.env.MNEMOSYNE_SERVICE_TOKEN;
const GRAPH = process.env.WORKFLOW_TEST_GRAPH;
const USER = process.env.WORKFLOW_TEST_USER;
const ENABLED = Boolean(GATEWAY && SERVICE_TOKEN && GRAPH && USER);

function agent(label: string, phaseIndex: number): AgentNodeResult {
	const t = 1_781_773_331_000;
	return {
		label,
		phaseIndex,
		state: "done",
		output: "",
		model: "mistralai/mistral-nemo",
		turns: 1,
		toolCalls: 1,
		tokens: 321,
		queuedAt: t,
		startedAt: t + 100,
		durationMs: 900,
		agentType: phaseIndex === 1 ? "graph-surveyor" : "findings-synthesizer",
	};
}

describe("workflow provenance — live gateway round-trip", () => {
	it(
		"emits wf:Run + wf:AgentRun and reads them back via SPARQL",
		{ skip: ENABLED ? false : "set MNEMOSYNE_GATEWAY_BASE_URL/_SERVICE_TOKEN + WORKFLOW_TEST_GRAPH/_USER to run" },
		async () => {
			const runId = `itest-${Date.now().toString(36)}`;
			const run: RunRecord = {
				runId,
				workflowName: "graph-survey-synthesize",
				workflowUri: "urn:sophia:wf:graph-survey-synthesize",
				status: "completed",
				startedAt: 1_781_773_331_000,
				endedAt: 1_781_773_372_230,
				durationMs: 41230,
				agentCount: 2,
				totalTokens: 642,
				agents: [agent("map:doc-1", 1), agent("synthesize", 2)],
			};

			const proxy = new HostedMnemosyneProxy({
				apiBaseUrl: GATEWAY as string,
				graphId: GRAPH as string,
				toolProfile: "full",
				runtime: "choreograph",
				label: "workflow-itest",
				requestTimeoutMs: 60_000,
				requiredTools: ["sparql_update", "sparql_query"],
				serviceAuth: {
					serviceToken: SERVICE_TOKEN as string,
					gatewayBaseUrl: GATEWAY as string,
					onBehalfOf: USER as string,
				},
			});

			try {
				await proxy.start();
				const graph = makeHostedGraphWriter(proxy);

				const assertion = await emitRunProvenance(graph, GRAPH as string, run);
				assert.ok(assertion.ok, `structural assertion failed: ${assertion.failures.join("; ")}`);

				// Read back: the protocol run-timeline join (run + its agents). Provenance
				// is now written to the cell's UI-readable `:user:rdf` named graph (GAP-2
				// fix), NOT the default graph, so the read-back MUST be GRAPH-scoped to
				// that same authority graph — an unscoped pattern matches only the default
				// graph in oxigraph and would (correctly) find nothing.
				const userRdf = userRdfGraphIri(GRAPH as string);
				const query = `${PREFIXES}\nSELECT ?run ?wf ?agent WHERE { GRAPH <${userRdf}> { ?run wf:runId "${runId}" ; prov:used ?wf . ?agent wf:partOfRun ?run } }`;
				const raw = await graph.sparqlQuery(GRAPH as string, query);
				const serialized = JSON.stringify(raw);
				assert.ok(serialized.includes(mintRunUri(runId)), "run subject should be queryable after emit");
				assert.ok(
					serialized.includes("urn:sophia:wf:graph-survey-synthesize"),
					"prov:used workflow should resolve",
				);
			} finally {
				// Cleanup: best-effort delete of the test run's subjects.
				try {
					const graph = makeHostedGraphWriter(proxy);
					for (const del of buildRunDelete(run).split("\n;\n")) {
						await graph.sparqlUpdate(GRAPH as string, del);
					}
				} catch {
					// ignore cleanup failures
				}
				await proxy.close().catch(() => {});
			}
		},
	);
});
