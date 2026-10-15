import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { assertAgentSparql, mintStandaloneAgentId } from "../agent-subject/agent-ontology.js";
import { JournalStore } from "../workflow/journal-store.js";
import {
	foldOwnerGraphRunsToAgentSessionProjection,
	foldRunToAgentBindings,
	foldRunToAgentSessionProjection,
	foldRunToAgentSubject,
	foldRunToProvenance,
	reconstructRunRecord,
} from "../workflow/projection.js";
import { assertRunSparql } from "../workflow/provenance.js";

const FORBIDDEN_ANATOMY = [
	"wf:Phase",
	"wf:AgentNode",
	"wf:Archetype",
	"wf:Contract",
	"wf:Variant",
	"flowsInto",
	"exemplifies",
	"produces",
];

const MAP_AGENT_ID = mintStandaloneAgentId({ name: "Graph Surveyor" });
const SYNTH_AGENT_ID = mintStandaloneAgentId({ name: "Findings Synthesizer" });

function tmpJournal(): { journal: JournalStore; dir: string } {
	const dir = mkdtempSync(join(tmpdir(), "projection-test-"));
	return { journal: new JournalStore(join(dir, "journal.sqlite")), dir };
}

/** Seed a journal with a complete 2-node run (1 map + 1 synth). */
async function seedRun(journal: JournalStore, runId: string): Promise<void> {
	const mapAgentId = MAP_AGENT_ID;
	const synthAgentId = SYNTH_AGENT_ID;

	await journal.createRun({
		run_id: runId,
		workflow_name: "graph-survey-synthesize",
		graph_id: "g1",
		owner_user_id: "owner-1",
		started_at: 1000,
	});
	await journal.appendEvent(runId, { type: "run_started", ts: 1000 });
	await journal.appendEvent(runId, {
		type: "phase_entered",
		ts: 1000,
		label: "map",
		phase_index: 1,
		payload: { phaseIndex: 1, phaseTitle: "map" },
	});

	// Map node.
	await journal.appendEvent(runId, {
		type: "node_queued",
		ts: 1000,
		sandbox_id: "sb-map",
		label: "map:d1",
		phase_index: 1,
		payload: { model: "cheap", agentId: mapAgentId, agentType: "graph-surveyor" },
	});
	await journal.appendEvent(runId, {
		type: "node_started",
		ts: 1010,
		sandbox_id: "sb-map",
		label: "map:d1",
		phase_index: 1,
	});
	await journal.appendEvent(runId, {
		type: "tool_call",
		ts: 1050,
		sandbox_id: "sb-map",
		label: "map:d1",
		phase_index: 1,
		payload: { gate: "remember", args: { content: "map finding" } },
	});
	await journal.appendEvent(runId, {
		type: "node_done",
		ts: 1100,
		sandbox_id: "sb-map",
		label: "map:d1",
		phase_index: 1,
		payload: { status: "terminated", tokens: 100, turns: 2, tool_calls: 1, output: "m" },
	});
	await journal.appendEvent(runId, {
		type: "token_usage",
		ts: 1100,
		sandbox_id: "sb-map",
		label: "map:d1",
		phase_index: 1,
		payload: { tokens: 100, turns: 2 },
	});

	// Synth node.
	await journal.appendEvent(runId, {
		type: "node_queued",
		ts: 1100,
		sandbox_id: "sb-synth",
		label: "synthesize",
		phase_index: 2,
		payload: { model: "smart", agentId: synthAgentId, agentType: "findings-synthesizer" },
	});
	await journal.appendEvent(runId, {
		type: "node_started",
		ts: 1110,
		sandbox_id: "sb-synth",
		label: "synthesize",
		phase_index: 2,
	});
	await journal.appendEvent(runId, {
		type: "node_done",
		ts: 1200,
		sandbox_id: "sb-synth",
		label: "synthesize",
		phase_index: 2,
		payload: { status: "terminated", tokens: 200, turns: 1, tool_calls: 0, output: "s" },
	});
	await journal.appendEvent(runId, {
		type: "token_usage",
		ts: 1200,
		sandbox_id: "sb-synth",
		label: "synthesize",
		phase_index: 2,
		payload: { tokens: 200, turns: 1 },
	});

	await journal.appendEvent(runId, { type: "run_done", ts: 1200, payload: { status: "completed" } });
	await journal.finishRun(runId, {
		status: "completed",
		ended_at: 1200,
		duration_ms: 200,
		agent_count: 2,
		total_tokens: 300,
		synthesis_doc_id: `wf-synthesis-${runId}`,
	});
}

describe("foldRunToProvenance", () => {
	it("reconstructs a RunRecord from the journal and serializes Run + AgentRun only", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await seedRun(journal, "run-fold");

		const { run, sparql } = await foldRunToProvenance(journal, "run-fold");

		// Header rebuilt.
		assert.equal(run.runId, "run-fold");
		assert.equal(run.workflowName, "graph-survey-synthesize");
		assert.equal(run.workflowUri, "urn:sophia:wf:graph-survey-synthesize");
		assert.equal(run.status, "completed");
		assert.equal(run.startedAt, 1000);
		assert.equal(run.endedAt, 1200);
		assert.equal(run.durationMs, 200);
		assert.equal(run.agentCount, 2);
		assert.equal(run.totalTokens, 300);
		assert.equal(run.synthesisDocId, "wf-synthesis-run-fold");

		// Agents rebuilt from node rows, in enqueue order.
		assert.equal(run.agents.length, 2);
		const [map, synth] = run.agents;
		assert.equal(map.label, "map:d1");
		assert.equal(map.phaseIndex, 1);
		assert.equal(map.model, "cheap");
		assert.equal(map.agentType, "graph-surveyor");
		assert.equal(map.agentId, MAP_AGENT_ID);
		assert.deepEqual(map.usedTools, ["remember"]);
		assert.equal(map.tokens, 100);
		assert.equal(map.turns, 2);
		assert.equal(map.toolCalls, 1);
		assert.equal(map.state, "done");
		assert.equal(map.queuedAt, 1000);
		assert.equal(map.startedAt, 1010);
		assert.equal(map.durationMs, 90);

		assert.equal(synth.label, "synthesize");
		assert.equal(synth.phaseIndex, 2);
		assert.equal(synth.model, "smart");
		assert.equal(synth.agentId, SYNTH_AGENT_ID);
		assert.equal(synth.tokens, 200);

		// Serialization passes the structural self-check.
		const assertion = assertRunSparql(sparql, { expectAgents: true });
		assert.ok(assertion.ok, `assertRunSparql failed: ${assertion.failures.join("; ")}`);

		// Emits wf:Run + N wf:AgentRun ...
		assert.match(sparql, /a wf:Run, prov:Activity/);
		assert.equal((sparql.match(/a wf:AgentRun/g) ?? []).length, 2);

		// ... and ZERO structural anatomy.
		for (const forbidden of FORBIDDEN_ANATOMY) {
			assert.ok(!sparql.includes(forbidden), `fold must NOT emit ${forbidden}`);
		}
		journal.close();
	});

	it("foldRunToAgentSubject emits Agent ⊃ Session ⊃ Run ⊃ node-grain Turn triples", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await seedRun(journal, "wfr-fold");

		const { sparql } = await foldRunToAgentSubject(journal, "wfr-fold");
		const cheapAgent = MAP_AGENT_ID;
		const smartAgent = SYNTH_AGENT_ID;

		const assertion = assertAgentSparql(sparql);
		assert.ok(assertion.ok, `assertAgentSparql failed: ${assertion.failures.join("; ")}`);
		assert.match(sparql, /INSERT DATA/);
		assert.match(sparql, new RegExp(`<urn:sophia:agent:${cheapAgent}> a agt:Agent, prov:Agent`));
		assert.match(sparql, new RegExp(`<urn:sophia:agent:${cheapAgent}>[\\s\\S]*agt:voicing agt:Monovocal`));
		assert.match(sparql, new RegExp(`<urn:sophia:agent:${cheapAgent}:voice:monovocal> a agt:Voice`));
		assert.match(sparql, new RegExp(`agt:voiceOf <urn:sophia:agent:${cheapAgent}>`));
		assert.match(sparql, new RegExp(`<urn:sophia:agent:${cheapAgent}:session:wfr-fold> a agt:Session`));
		assert.match(sparql, new RegExp(`<urn:sophia:agent:${cheapAgent}:session:wfr-fold:run:wfr-fold> a agt:Run`));
		assert.match(sparql, new RegExp(`agt:ofSession <urn:sophia:agent:${cheapAgent}:session:wfr-fold>`));
		assert.match(sparql, /agt:realizedBy <urn:sophia:wf-run:wfr-fold>/);
		assert.match(
			sparql,
			new RegExp(`<urn:sophia:agent:${cheapAgent}:session:wfr-fold:run:wfr-fold:turn:1> a agt:Turn`),
		);
		assert.match(sparql, new RegExp(`agt:inRun <urn:sophia:agent:${cheapAgent}:session:wfr-fold:run:wfr-fold>`));
		assert.match(sparql, /agt:realizedBy <urn:sophia:wf-run:wfr-fold:agent:map-d1>/);
		assert.match(sparql, new RegExp(`<urn:sophia:agent:${smartAgent}:session:wfr-fold> a agt:Session`));
		assert.match(sparql, /agt:turnGrain "node"/);
		assert.match(sparql, /agt:nodeLabel "map:d1"/);
		assert.match(sparql, /agt:usedTool <urn:sophia:agent:agent-[0-9a-f]{16}:tool:remember>/);
		assert.ok(!sparql.includes("#voice"), "run-fold subjects must stay URN-space, not fragment subjects");
		assert.ok(!sparql.includes("wf:"), "agt: run fold must not mint wf: triples");
		journal.close();
	});

	it("foldRunToAgentBindings emits wf:boundToAgent edges as a separate binding artifact", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await seedRun(journal, "wfr-bind");

		const { sparql } = await foldRunToAgentBindings(journal, "wfr-bind");
		const cheapAgent = MAP_AGENT_ID;
		const smartAgent = SYNTH_AGENT_ID;

		assert.match(sparql, /PREFIX wf: <http:\/\/mnemosyne\.dev\/workflow#>/);
		assert.equal((sparql.match(/wf:boundToAgent/g) ?? []).length, 4);
		assert.match(
			sparql,
			new RegExp(
				`<urn:sophia:wf-run:wfr-bind> wf:boundToAgent <urn:sophia:agent:${cheapAgent}:session:wfr-bind:run:wfr-bind>`,
			),
		);
		assert.match(
			sparql,
			new RegExp(
				`<urn:sophia:wf-run:wfr-bind:agent:map-d1> wf:boundToAgent <urn:sophia:agent:${cheapAgent}:session:wfr-bind:run:wfr-bind:turn:1>`,
			),
		);
		assert.match(
			sparql,
			new RegExp(
				`<urn:sophia:wf-run:wfr-bind> wf:boundToAgent <urn:sophia:agent:${smartAgent}:session:wfr-bind:run:wfr-bind>`,
			),
		);
		assert.ok(!sparql.includes("agt:realizedBy"), "binding artifact emits the forward materialized edge only");
		journal.close();
	});

	it("foldRunToAgentSessionProjection builds the generic projection:session ingest request", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await seedRun(journal, "wfr-project");

		const { request } = await foldRunToAgentSessionProjection(journal, "wfr-project");
		const cheapAgent = MAP_AGENT_ID;
		const cheapSession = `urn:sophia:agent:${cheapAgent}:session:wfr-project`;
		const cheapRun = `${cheapSession}:run:wfr-project`;
		const cheapTurn = `${cheapRun}:turn:1`;

		assert.equal(request.vocab, "wf-agent-session-projection");
		assert.equal(request.dry_run, false);
		assert.equal(request.payload.kind, "generic");
		assert.ok(
			request.payload.records.some(
				(r) => r.kind === "WorkflowRunAnchor" && r.localId === "urn:sophia:wf-run:wfr-project",
			),
			"the projection batch carries a wf:Run type anchor for SHACL realization checks",
		);

		const agent = request.payload.records.find(
			(r) => r.kind === "Agent" && r.localId === `urn:sophia:agent:${cheapAgent}`,
		);
		assert.ok(agent && agent.kind === "Agent");
		assert.equal(agent.voicing, "http://mnemosyne.dev/agent#Monovocal");
		assert.deepEqual(agent.hasVoice, [`urn:sophia:agent:${cheapAgent}:voice:monovocal`]);

		const session = request.payload.records.find((r) => r.kind === "Session" && r.localId === cheapSession);
		assert.ok(session && session.kind === "Session");
		assert.equal(session.ofAgent, `urn:sophia:agent:${cheapAgent}`);
		assert.equal(session.graphId, "g1");
		assert.equal(session.ownerUserId, "owner-1");
		assert.equal(session.model, "cheap");

		const run = request.payload.records.find((r) => r.kind === "Run" && r.localId === cheapRun);
		assert.ok(run && run.kind === "Run");
		assert.equal(run.ofSession, cheapSession);
		assert.equal(run.realizedBy, "urn:sophia:wf-run:wfr-project");
		assert.equal(run.supersedesLegacyRunSession, cheapSession);

		const turnAnchor = request.payload.records.find(
			(r) => r.kind === "WorkflowAgentRunAnchor" && r.localId === "urn:sophia:wf-run:wfr-project:agent:map-d1",
		);
		assert.ok(turnAnchor, "the projection batch carries a wf:AgentRun type anchor");

		const turn = request.payload.records.find((r) => r.kind === "Turn" && r.localId === cheapTurn);
		assert.ok(turn && turn.kind === "Turn");
		assert.equal(turn.inRun, cheapRun);
		assert.equal(turn.realizedBy, "urn:sophia:wf-run:wfr-project:agent:map-d1");
		assert.equal(turn.turnGrain, "node");
		assert.deepEqual(turn.usedTool, [`urn:sophia:agent:${cheapAgent}:tool:remember`]);
		journal.close();
	});

	it("foldOwnerGraphRunsToAgentSessionProjection submits a cumulative owner+graph projection window", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await seedRun(journal, "wfr-project-a");
		await seedRun(journal, "wfr-project-b");

		const { request } = await foldOwnerGraphRunsToAgentSessionProjection(journal, "wfr-project-b", { limit: 100 });
		const cheapAgent = MAP_AGENT_ID;
		const smartAgent = SYNTH_AGENT_ID;
		const records = request.payload.records;

		assert.ok(
			records.some(
				(r) => r.kind === "Session" && r.localId === `urn:sophia:agent:${cheapAgent}:session:wfr-project-a`,
			),
			"first run's cheap-agent session remains in the desired projection set",
		);
		assert.ok(
			records.some(
				(r) => r.kind === "Session" && r.localId === `urn:sophia:agent:${cheapAgent}:session:wfr-project-b`,
			),
			"second run's cheap-agent session is in the desired projection set",
		);
		assert.ok(
			records.some((r) => r.kind === "WorkflowRunAnchor" && r.localId === "urn:sophia:wf-run:wfr-project-a"),
			"first run's wf:Run anchor remains in the desired projection set",
		);
		assert.equal(
			records.filter((r) => r.kind === "Agent" && r.localId === `urn:sophia:agent:${cheapAgent}`).length,
			1,
			"shared cheap Agent anchor is deduped across runs",
		);
		assert.equal(
			records.filter((r) => r.kind === "Agent" && r.localId === `urn:sophia:agent:${smartAgent}`).length,
			1,
			"shared smart Agent anchor is deduped across runs",
		);
		journal.close();
	});

	it("a header still 'running' folds to status 'stopped' (re-projectable partial run)", () => {
		const run = reconstructRunRecord(
			{
				run_id: "r",
				workflow_name: "wf",
				graph_id: "g",
				owner_user_id: "u",
				status: "running",
				started_at: 0,
				ended_at: null,
				duration_ms: null,
				agent_count: null,
				total_tokens: null,
				synthesis_doc_id: null,
				payload: undefined,
			},
			[],
		);
		assert.equal(run.status, "stopped");
		assert.equal(run.agents.length, 0);
	});

	it("does NOT overwrite distinct nodes that share a label (keyed by sandbox_id)", async () => {
		const { journal, dir } = tmpJournal();
		after(() => rmSync(dir, { recursive: true, force: true }));
		await journal.init();
		await journal.createRun({
			run_id: "run-dup",
			workflow_name: "wf",
			graph_id: "g",
			owner_user_id: "u",
			started_at: 0,
		});
		// Two nodes, SAME label, DIFFERENT sandbox_ids.
		for (const sb of ["sb-x", "sb-y"]) {
			await journal.appendEvent("run-dup", {
				type: "node_queued",
				sandbox_id: sb,
				label: "map:dup",
				phase_index: 1,
				payload: { model: "m" },
			});
			await journal.appendEvent("run-dup", {
				type: "node_done",
				sandbox_id: sb,
				label: "map:dup",
				phase_index: 1,
				payload: { tokens: 10, status: "terminated" },
			});
		}
		const { header, events } = await journal.readRun("run-dup");
		assert.ok(header);
		const run = reconstructRunRecord(header, events);
		assert.equal(run.agents.length, 2, "two distinct sandboxes must yield two agents even with a shared label");
		journal.close();
	});
});
