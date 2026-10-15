/**
 * Journal → wf: PROJECTION. The journal is the source of truth; the `wf:`
 * triples are a re-projectable FOLD of it.
 *
 * `foldRunToProvenance(journal, runId)` reads the run header + events, rebuilds
 * a `RunRecord`, and calls `serializeRunProvenance` VERBATIM (pure, no I/O).
 * The serializer emits EXACTLY `wf:Run` (+ `prov:Activity`) + N `wf:AgentRun`;
 * `assertRunSparql` has no notion of structural anatomy, so the fold
 * STRUCTURALLY CANNOT mint `wf:Phase`/`wf:AgentNode`/`wf:Archetype`/
 * `wf:Contract`/`wf:Variant`/`flowsInto`/`exemplifies`/`produces`.
 */

import {
	PREFIXES as AGENT_PREFIXES,
	AGT,
	iri as agentIri,
	str as agentStr,
	xsdDateTime as agentXsdDateTime,
	xsdInt as agentXsdInt,
	assertAgentSparql,
	mintAgentRunEpisodeUri,
	mintAgentRunTurnUri,
	mintAgentSessionUri,
	mintAgentUri,
	mintRunSessionUri,
	mintToolUri,
	mintVoiceUri,
} from "../agent-subject/agent-ontology.js";
import type { JournalStore, RunEvent, RunHeader } from "./journal-store.js";
import { serializeRunProvenance } from "./provenance.js";
import type { AgentNodeResult, NodeState, RunRecord } from "./types.js";
import {
	mintAgentRunUri,
	mintRunUri,
	mintWorkflowUri,
	PREFIXES as WORKFLOW_PREFIXES,
	iri as workflowIri,
} from "./vocab.js";

const NODE_EVENT_TYPES = new Set<RunEvent["type"]>([
	"node_queued",
	"node_started",
	"tool_call",
	"token_usage",
	"node_done",
	"error",
]);

export interface FoldOptions {
	/**
	 * Override the `prov:used` workflow subject. Defaults to
	 * `mintWorkflowUri(header.workflow_name)`, matching the runtime path.
	 */
	workflowUri?: string;
}

/**
 * Reconstruct a `RunRecord` from the journal and serialize its provenance.
 * Returns both the rebuilt record and the SPARQL so the caller can file the
 * latter (non-fatally) and inspect the former.
 */
export async function foldRunToProvenance(
	journal: JournalStore,
	runId: string,
	opts?: FoldOptions,
): Promise<{ run: RunRecord; sparql: string }> {
	const { header, events } = await journal.readRun(runId);
	if (!header) {
		throw new Error(`foldRunToProvenance: no run header for ${runId}`);
	}
	const run = reconstructRunRecord(header, events, opts);
	const sparql = serializeRunProvenance(run);
	return { run, sparql };
}

/**
 * WS-7 fold: reconstruct the run from the journal, then project it as an agt:
 * episode Session, execution Run, and node-grain Turns. This deliberately folds
 * over the workflow journal, not the chat SessionStore/IntentLog path.
 */
export async function foldRunToAgentSubject(
	journal: JournalStore,
	runId: string,
	opts?: FoldOptions,
): Promise<{ run: RunRecord; sparql: string }> {
	const { header, events } = await journal.readRun(runId);
	if (!header) {
		throw new Error(`foldRunToAgentSubject: no run header for ${runId}`);
	}
	const run = reconstructRunRecord(header, events, opts);
	const sparql = serializeRunAgentSubject(header, run);
	const check = assertAgentSparql(sparql);
	if (!check.ok) {
		throw new Error(`foldRunToAgentSubject: generated non-conformant agt: projection: ${check.failures.join("; ")}`);
	}
	return { run, sparql };
}

/**
 * WS-7 binding fold: emit ONLY the workflow-side binding edges that connect the
 * existing wf:Run / wf:AgentRun subjects to the agt:Session / agt:Turn subjects.
 * This stays separate from `foldRunToAgentSubject`, whose agt: SPARQL must not
 * mint wf: triples.
 */
export async function foldRunToAgentBindings(
	journal: JournalStore,
	runId: string,
	opts?: FoldOptions,
): Promise<{ run: RunRecord; sparql: string }> {
	const { header, events } = await journal.readRun(runId);
	if (!header) {
		throw new Error(`foldRunToAgentBindings: no run header for ${runId}`);
	}
	const run = reconstructRunRecord(header, events, opts);
	const sparql = serializeRunAgentBindings(run);
	return { run, sparql };
}

export type RunAgentSessionProjectionRecord =
	| {
			kind: "WorkflowRunAnchor";
			localId: string;
	  }
	| {
			kind: "WorkflowAgentRunAnchor";
			localId: string;
	  }
	| {
			kind: "Agent";
			localId: string;
			agentId: string;
			voicing: string;
			hasVoice: string[];
	  }
	| {
			kind: "Voice";
			localId: string;
			voiceOf: string;
			voiceId: string;
	  }
	| {
			kind: "Session";
			localId: string;
			ofAgent: string;
			sessionId: string;
			ownerUserId?: string;
			graphId?: string;
			model?: string;
			turnCount?: number;
	  }
	| {
			kind: "Run";
			localId: string;
			ofAgent: string;
			ofSession: string;
			realizedBy: string;
			runId: string;
			ownerUserId?: string;
			graphId?: string;
			model?: string;
			turnCount?: number;
			supersedesLegacyRunSession?: string;
	  }
	| {
			kind: "Turn";
			localId: string;
			inSession: string;
			inRun: string;
			realizedBy: string;
			ordinal: number;
			role?: string;
			turnGrain: "node";
			nodeLabel?: string;
			phaseIndex?: number;
			state?: string;
			turnTime?: number;
			usedTool?: string[];
	  }
	| {
			kind: "Tool";
			localId: string;
			ofAgent?: string;
			toolName: string;
			toolStatus?: string;
			toolAccess?: "read" | "write";
	  };

export interface RunAgentSessionProjectionIngestRequest {
	vocab: "wf-agent-session-projection";
	dry_run: boolean;
	payload: {
		kind: "generic";
		records: RunAgentSessionProjectionRecord[];
	};
}

/**
 * Build the generic-ingest payload for Garden's `wf-agent-session-projection`
 * pack. The `localId` values are full URIs because the pack's subject_rule is
 * `{localId}`; Garden mints the exact URN-space subjects the TS fold checked.
 */
export function buildRunAgentSessionProjectionRecords(
	header: RunHeader,
	run: RunRecord,
): RunAgentSessionProjectionRecord[] {
	const records: RunAgentSessionProjectionRecord[] = [{ kind: "WorkflowRunAnchor", localId: mintRunUri(run.runId) }];
	const groups = groupRunAgents(run.agents, run.runId);
	for (const group of groups) {
		const agentUri = mintAgentUri(group.agentId);
		const voiceUri = mintVoiceUri(group.agentId, "monovocal");
		const sessionUri = mintAgentSessionUri(group.agentId, group.sessionId);
		const runUri = mintAgentRunEpisodeUri(group.agentId, group.sessionId, run.runId);
		records.push({
			kind: "Agent",
			localId: agentUri,
			agentId: group.agentId,
			voicing: `${AGT}Monovocal`,
			hasVoice: [voiceUri],
		});
		records.push({
			kind: "Voice",
			localId: voiceUri,
			voiceOf: agentUri,
			voiceId: "monovocal",
		});
		records.push({
			kind: "Session",
			localId: sessionUri,
			ofAgent: agentUri,
			sessionId: group.sessionId,
			ownerUserId: header.owner_user_id,
			graphId: header.graph_id,
			model: group.model,
			turnCount: group.turns.length,
		});
		records.push({
			kind: "Run",
			localId: runUri,
			ofAgent: agentUri,
			ofSession: sessionUri,
			realizedBy: mintRunUri(run.runId),
			runId: run.runId,
			ownerUserId: header.owner_user_id,
			graphId: header.graph_id,
			model: group.model,
			turnCount: group.turns.length,
			supersedesLegacyRunSession: mintRunSessionUri(group.agentId, run.runId),
		});
		group.turns.forEach((turn, index) => {
			const ordinal = index + 1;
			const agentRunUri = mintAgentRunUri(run.runId, turn.label);
			const turnUri = mintAgentRunTurnUri(group.agentId, group.sessionId, run.runId, ordinal);
			const usedTool = (turn.usedTools ?? []).map((tool) => mintToolUri(group.agentId, tool));
			records.push({ kind: "WorkflowAgentRunAnchor", localId: agentRunUri });
			records.push({
				kind: "Turn",
				localId: turnUri,
				inSession: sessionUri,
				inRun: runUri,
				realizedBy: agentRunUri,
				ordinal,
				role: "node",
				turnGrain: "node",
				nodeLabel: turn.label,
				phaseIndex: turn.phaseIndex,
				state: turn.state,
				turnTime: turn.startedAt,
				...(usedTool.length > 0 ? { usedTool } : {}),
			});
		});
		group.tools.forEach((tool) => {
			records.push({
				kind: "Tool",
				localId: mintToolUri(group.agentId, tool),
				ofAgent: agentUri,
				toolName: tool,
				toolStatus: "used",
				toolAccess: "write",
			});
		});
	}
	return records;
}

export function buildRunAgentSessionProjectionIngestRequest(
	header: RunHeader,
	run: RunRecord,
): RunAgentSessionProjectionIngestRequest {
	return {
		vocab: "wf-agent-session-projection",
		dry_run: false,
		payload: {
			kind: "generic",
			records: buildRunAgentSessionProjectionRecords(header, run),
		},
	};
}

export async function foldRunToAgentSessionProjection(
	journal: JournalStore,
	runId: string,
	opts?: FoldOptions,
): Promise<{ run: RunRecord; request: RunAgentSessionProjectionIngestRequest }> {
	const { header, events } = await journal.readRun(runId);
	if (!header) {
		throw new Error(`foldRunToAgentSessionProjection: no run header for ${runId}`);
	}
	const run = reconstructRunRecord(header, events, opts);
	return { run, request: buildRunAgentSessionProjectionIngestRequest(header, run) };
}

/**
 * Build the whole desired `projection:session` set for the recent finished runs in
 * the same owner+graph partition as `runId`. Garden's generic `projection:*`
 * lane is a reconcile sink, not an append log: every ingest replaces each
 * class-span with the submitted desired set. A workflow-run materializer therefore
 * has to submit the cumulative session projection window, or a second run would
 * erase the first run's `agt:Session`/`agt:Turn` rows.
 */
export async function foldOwnerGraphRunsToAgentSessionProjection(
	journal: JournalStore,
	runId: string,
	opts: { limit: number },
): Promise<{ runs: RunRecord[]; request: RunAgentSessionProjectionIngestRequest }> {
	const { header } = await journal.readRun(runId);
	if (!header) {
		throw new Error(`foldOwnerGraphRunsToAgentSessionProjection: no run header for ${runId}`);
	}
	const headers = await journal.listRuns({
		ownerUserId: header.owner_user_id,
		graphId: header.graph_id,
		limit: opts.limit,
	});
	const byRunId = new Map<string, RunHeader>();
	for (const candidate of headers) {
		byRunId.set(candidate.run_id, candidate);
	}
	byRunId.set(header.run_id, header);
	const ordered = [...byRunId.values()]
		.filter((candidate) => candidate.status !== "running")
		.sort((a, b) => a.started_at - b.started_at || a.run_id.localeCompare(b.run_id));

	const recordsByKey = new Map<string, RunAgentSessionProjectionRecord>();
	const runs: RunRecord[] = [];
	for (const candidate of ordered) {
		const { header: runHeader, events } = await journal.readRun(candidate.run_id);
		if (!runHeader || runHeader.status === "running") {
			continue;
		}
		const run = reconstructRunRecord(runHeader, events);
		runs.push(run);
		for (const record of buildRunAgentSessionProjectionRecords(runHeader, run)) {
			const key = `${record.kind}\u0000${record.localId}`;
			if (!recordsByKey.has(key)) {
				recordsByKey.set(key, record);
			}
		}
	}

	return {
		runs,
		request: {
			vocab: "wf-agent-session-projection",
			dry_run: false,
			payload: {
				kind: "generic",
				records: [...recordsByKey.values()],
			},
		},
	};
}

/**
 * Pure reconstruction of a `RunRecord` from a header + event log. Exposed for
 * unit tests (seed a fake journal, assert field-for-field against the driver
 * output).
 */
export function reconstructRunRecord(header: RunHeader, events: RunEvent[], opts?: FoldOptions): RunRecord {
	const agents = reconstructAgents(events);

	const startedAt = header.started_at;
	const endedAt = header.ended_at ?? startedAt;
	// Prefer header rollups when present (set by finishRun); else recompute.
	const agentCount = header.agent_count ?? agents.length;
	const totalTokens = header.total_tokens ?? agents.reduce((sum, a) => sum + a.tokens, 0);
	const durationMs = header.duration_ms ?? Math.max(0, endedAt - startedAt);

	// `running` is an in-flight header state; the RunRecord status union does
	// not include it, so a partial run folds as `stopped` (re-projectable once
	// run_done lands and the header flips).
	const status: RunRecord["status"] = header.status === "running" ? "stopped" : header.status;

	return {
		runId: header.run_id,
		workflowName: header.workflow_name,
		workflowUri: opts?.workflowUri ?? mintWorkflowUri(header.workflow_name),
		status,
		startedAt,
		endedAt,
		durationMs,
		agentCount,
		totalTokens,
		agents,
		synthesisDocId: header.synthesis_doc_id ?? undefined,
	};
}

/**
 * Fold the per-node event rows into `AgentNodeResult[]`. Each node is keyed by
 * its sandbox_id (unique per enqueue); we accumulate queued/started/tool_call/
 * terminal facts in seq order.
 */
function reconstructAgents(events: RunEvent[]): AgentNodeResult[] {
	interface Acc {
		nodeKey?: string;
		sessionId?: string;
		invocationId?: string;
		label: string;
		phaseIndex: number;
		queuedAt: number;
		startedAt: number;
		state: NodeState;
		output: string;
		structured?: unknown;
		model: string;
		turns: number;
		toolCalls: number;
		usedTools: Set<string>;
		tokens: number;
		agentId?: string;
		endedAt: number;
		agentType?: string;
		order: number;
	}

	const byKey = new Map<string, Acc>();
	let order = 0;

	const keyOf = (e: RunEvent): string => e.sandbox_id ?? `${e.label ?? ""}#${e.phase_index ?? 0}`;

	const ensure = (e: RunEvent): Acc => {
		const key = keyOf(e);
		let acc = byKey.get(key);
		if (!acc) {
			acc = {
				label: e.label ?? "",
				phaseIndex: e.phase_index ?? 0,
				queuedAt: e.ts,
				startedAt: e.ts,
				state: "done",
				output: "",
				model: "",
				turns: 0,
				toolCalls: 0,
				usedTools: new Set<string>(),
				tokens: 0,
				endedAt: e.ts,
				order: order++,
			};
			byKey.set(key, acc);
		}
		return acc;
	};

	for (const e of events) {
		// Only node lifecycle/tool events reconstruct agent nodes. Phase/log events
		// can carry labels too, but they are workflow telemetry, not AgentNodeResult.
		if (!NODE_EVENT_TYPES.has(e.type)) {
			continue;
		}
		const acc = ensure(e);
		const payload = (e.payload ?? {}) as Record<string, unknown>;

		switch (e.type) {
			case "node_queued":
				acc.queuedAt = e.ts;
				if (typeof payload.model === "string") acc.model = payload.model;
				if (typeof payload.agentId === "string") acc.agentId = payload.agentId;
				if (typeof payload.agentType === "string") acc.agentType = payload.agentType;
				if (typeof payload.nodeKey === "string") acc.nodeKey = payload.nodeKey;
				if (typeof payload.sessionId === "string") acc.sessionId = payload.sessionId;
				if (typeof payload.invocationId === "string") acc.invocationId = payload.invocationId;
				break;
			case "node_started":
				acc.startedAt = e.ts;
				break;
			case "tool_call":
				// Counted defensively; the terminal SpawnResult tool_calls is canonical.
				if (typeof payload.gate === "string") acc.usedTools.add(payload.gate);
				break;
			case "token_usage":
				if (typeof payload.tokens === "number") acc.tokens = payload.tokens;
				if (typeof payload.turns === "number") acc.turns = payload.turns;
				break;
			case "node_done":
			case "error": {
				acc.endedAt = e.ts;
				acc.state = e.type === "error" ? "error" : terminalState(payload);
				if (typeof payload.output === "string") acc.output = payload.output;
				if ("structured_output" in payload) acc.structured = payload.structured_output;
				if (typeof payload.turns === "number") acc.turns = payload.turns;
				if (typeof payload.tokens === "number") acc.tokens = payload.tokens;
				if (typeof payload.tool_calls === "number") acc.toolCalls = payload.tool_calls;
				break;
			}
		}
	}

	return [...byKey.values()]
		.sort((a, b) => a.order - b.order)
		.map((a) => ({
			nodeKey: a.nodeKey,
			sessionId: a.sessionId,
			invocationId: a.invocationId,
			label: a.label,
			phaseIndex: a.phaseIndex,
			state: a.state,
			output: a.output,
			structured: a.structured,
			model: a.model,
			agentId: a.agentId,
			usedTools: [...a.usedTools],
			turns: a.turns,
			toolCalls: a.toolCalls,
			tokens: a.tokens,
			queuedAt: a.queuedAt,
			startedAt: a.startedAt,
			durationMs: Math.max(0, a.endedAt - a.startedAt),
			agentType: a.agentType,
		}));
}

interface RunAgentFoldGroup {
	agentId: string;
	/** Graph-persistent episode for this bounded wave. */
	sessionId: string;
	model: string;
	turns: AgentNodeResult[];
	tools: string[];
}

function serializeRunAgentSubject(header: RunHeader, run: RunRecord): string {
	const groups = groupRunAgents(run.agents, run.runId);
	const blocks: string[] = [];
	for (const group of groups) {
		blocks.push(runAgentBlock(group));
		blocks.push(runMonovocalVoiceBlock(group.agentId));
		blocks.push(runSessionBlock(header, group));
		blocks.push(runEpisodeBlock(header, run, group));
		group.turns.forEach((turn, index) => {
			blocks.push(runTurnBlock(run.runId, group, turn, index + 1));
		});
		group.tools.forEach((tool) => {
			blocks.push(runToolBlock(group.agentId, tool));
		});
	}
	return `${AGENT_PREFIXES}\nINSERT DATA {\n${blocks.join("\n")}\n}`;
}

export function serializeRunAgentBindings(run: RunRecord): string {
	const blocks: string[] = [];
	const runUri = mintRunUri(run.runId);
	for (const group of groupRunAgents(run.agents, run.runId)) {
		blocks.push(
			`${workflowIri(runUri)} wf:boundToAgent ${workflowIri(
				mintAgentRunEpisodeUri(group.agentId, group.sessionId, run.runId),
			)} .`,
		);
		group.turns.forEach((turn, index) => {
			blocks.push(
				`${workflowIri(mintAgentRunUri(run.runId, turn.label))} wf:boundToAgent ${workflowIri(
					mintAgentRunTurnUri(group.agentId, group.sessionId, run.runId, index + 1),
				)} .`,
			);
		});
	}
	return `${WORKFLOW_PREFIXES}\nINSERT DATA {\n${blocks.join("\n")}\n}`;
}

function groupRunAgents(agents: RunRecord["agents"], runId: string): RunAgentFoldGroup[] {
	const byAgent = new Map<string, RunAgentFoldGroup>();
	for (const agent of agents) {
		if (!agent.agentId) {
			throw new Error(
				`foldRunToAgentSubject: node ${JSON.stringify(agent.label)} has no agentId in journal payload`,
			);
		}
		let group = byAgent.get(agent.agentId);
		if (!group) {
			group = { agentId: agent.agentId, sessionId: runId, model: agent.model, turns: [], tools: [] };
			byAgent.set(agent.agentId, group);
		}
		group.turns.push(agent);
		for (const tool of agent.usedTools ?? []) {
			if (!group.tools.includes(tool)) {
				group.tools.push(tool);
			}
		}
	}
	return [...byAgent.values()];
}

function runAgentBlock(group: RunAgentFoldGroup): string {
	const voiceUri = mintVoiceUri(group.agentId, "monovocal");
	return [
		`${agentIri(mintAgentUri(group.agentId))} a agt:Agent, prov:Agent ;`,
		`\tagt:agentId ${agentStr(group.agentId)} ;`,
		`\tagt:voicing agt:Monovocal ;`,
		`\tagt:hasVoice ${agentIri(voiceUri)} .`,
	].join("\n");
}

function runMonovocalVoiceBlock(agentId: string): string {
	const voiceUri = mintVoiceUri(agentId, "monovocal");
	return [
		`${agentIri(voiceUri)} a agt:Voice ;`,
		`\tagt:voiceOf ${agentIri(mintAgentUri(agentId))} ;`,
		`\tagt:voiceId ${agentStr("monovocal")} .`,
	].join("\n");
}

function runSessionBlock(header: RunHeader, group: RunAgentFoldGroup): string {
	const sessionUri = mintAgentSessionUri(group.agentId, group.sessionId);
	const agentUri = mintAgentUri(group.agentId);
	const preds = [
		`agt:ofAgent ${agentIri(agentUri)}`,
		`agt:sessionId ${agentStr(group.sessionId)}`,
		`agt:ownerUserId ${agentStr(header.owner_user_id)}`,
		`agt:graphId ${agentStr(header.graph_id)}`,
		`agt:model ${agentStr(group.model)}`,
		`agt:turnCount ${agentXsdInt(group.turns.length)}`,
	];
	const body = preds.map((p, i) => `\t${p}${i === preds.length - 1 ? " ." : " ;"}`).join("\n");
	return `${agentIri(sessionUri)} a agt:Session ;\n${body}`;
}

function runEpisodeBlock(header: RunHeader, run: RunRecord, group: RunAgentFoldGroup): string {
	const runUri = mintAgentRunEpisodeUri(group.agentId, group.sessionId, run.runId);
	const predicates = [
		`agt:ofAgent ${agentIri(mintAgentUri(group.agentId))}`,
		`agt:ofSession ${agentIri(mintAgentSessionUri(group.agentId, group.sessionId))}`,
		`agt:realizedBy ${agentIri(mintRunUri(run.runId))}`,
		`agt:runId ${agentStr(run.runId)}`,
		`agt:ownerUserId ${agentStr(header.owner_user_id)}`,
		`agt:graphId ${agentStr(header.graph_id)}`,
		`agt:supersedesLegacyRunSession ${agentIri(mintRunSessionUri(group.agentId, run.runId))}`,
		`agt:turnCount ${agentXsdInt(group.turns.length)}`,
	];
	const body = predicates
		.map((predicate, index) => `\t${predicate}${index === predicates.length - 1 ? " ." : " ;"}`)
		.join("\n");
	return `${agentIri(runUri)} a agt:Run ;\n${body}`;
}

function runTurnBlock(runId: string, group: RunAgentFoldGroup, turn: AgentNodeResult, ordinal: number): string {
	const agentId = group.agentId;
	const turnUri = mintAgentRunTurnUri(agentId, group.sessionId, runId, ordinal);
	const sessionUri = mintAgentSessionUri(agentId, group.sessionId);
	const runUri = mintAgentRunEpisodeUri(agentId, group.sessionId, runId);
	const pointers = (turn.usedTools ?? []).map((tool) => `\tagt:usedTool ${agentIri(mintToolUri(agentId, tool))} ;`);
	return [
		`${agentIri(turnUri)} a agt:Turn ;`,
		`\tagt:inSession ${agentIri(sessionUri)} ;`,
		`\tagt:inRun ${agentIri(runUri)} ;`,
		`\tagt:realizedBy ${agentIri(mintAgentRunUri(runId, turn.label))} ;`,
		`\tagt:ordinal ${agentXsdInt(ordinal)} ;`,
		`\tagt:role ${agentStr("node")} ;`,
		`\tagt:turnGrain ${agentStr("node")} ;`,
		`\tagt:nodeLabel ${agentStr(turn.label)} ;`,
		`\tagt:phaseIndex ${agentXsdInt(turn.phaseIndex)} ;`,
		`\tagt:state ${agentStr(turn.state)} ;`,
		...pointers,
		`\tagt:turnTime ${agentXsdDateTime(turn.startedAt)} .`,
	].join("\n");
}

function runToolBlock(agentId: string, tool: string): string {
	const toolUri = mintToolUri(agentId, tool);
	return [
		`${agentIri(toolUri)} a agt:Tool ;`,
		`\tagt:ofAgent ${agentIri(mintAgentUri(agentId))} ;`,
		`\tagt:toolName ${agentStr(tool)} ;`,
		`\tagt:toolStatus ${agentStr("used")} ;`,
		`\tagt:toolAccess ${agentStr("write")} .`,
	].join("\n");
}

function terminalState(payload: Record<string, unknown>): NodeState {
	const status = typeof payload.status === "string" ? payload.status : undefined;
	const state = typeof payload.state === "string" ? payload.state : undefined;
	if (status === "error" || state === "error" || state === "timeout" || state === "killed") {
		return "error";
	}
	if (status === "truncated" || state === "truncated") {
		return "truncated";
	}
	return "done";
}
