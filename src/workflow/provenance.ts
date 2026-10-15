/**
 * Provenance emitter — turns a RunRecord into contract-valid `wf:` RDF and
 * writes it to the graph via `sparql_update` (INSERT DATA; the platform wraps
 * the GRAPH clause). "Code serializes": the LLM never mints a triple.
 *
 * For the first slice we emit RUN provenance only (wf:Run + wf:AgentRun) and
 * point prov:used at a `urn:sophia:wf` workflow subject we ensure here. Full
 * workflow anatomy (AgentNodes, archetypes, CRDT wires) is deferred to the
 * emporium `workflow_ingest_apply` path — see docs/workflow-engine/SPEC.md §8.
 */

import type { GraphWriter } from "./graph-writer.js";
import type { RunRecord } from "./types.js";
import {
	iri,
	mintAgentRunUri,
	mintRunUri,
	mintWorkflowUri,
	PREFIXES,
	REQUIRED_AGENTRUN_PREDICATES,
	REQUIRED_RUN_PREDICATES,
	str,
	xsdBool,
	xsdDateTime,
	xsdInt,
	xsdLong,
} from "./vocab.js";

/** The transient pre-fan-out shape differs from a final RunRecord only by status. */
export type RunningRunProvenance = Omit<RunRecord, "status"> & { status: "running" };

/**
 * The `wf:Run` (+ `prov:Activity`) triple block for one run — the SHARED shape
 * between the final fold (`serializeRunProvenance`) and the incremental emit
 * (`serializeRunStartedProvenance`). Keeping ONE builder keeps the frozen-vocab
 * predicate set identical across both paths.
 */
function runBlock(run: RunRecord | RunningRunProvenance): string {
	const runUri = mintRunUri(run.runId);
	return [
		`${iri(runUri)} a wf:Run, prov:Activity ;`,
		`\twf:runId ${str(run.runId)} ;`,
		`\twf:workflowName ${str(run.workflowName)} ;`,
		`\twf:status ${str(run.status)} ;`,
		`\twf:totalTokens ${xsdInt(run.totalTokens)} ;`,
		`\twf:agentCount ${xsdInt(run.agentCount)} ;`,
		`\twf:durationMs ${xsdInt(run.durationMs)} ;`,
		`\tprov:used ${iri(run.workflowUri)} ;`,
		`\tprov:startedAtTime ${xsdDateTime(run.startedAt)} ;`,
		`\tprov:endedAtTime ${xsdDateTime(run.endedAt)}${run.synthesisDocId ? " ;" : " ."}`,
		...(run.synthesisDocId ? [`\twf:generatedFile ${str(run.synthesisDocId)} .`] : []),
	].join("\n");
}

/** The `wf:AgentRun` triple block for one agent node — shared (see `runBlock`). */
function agentBlock(runId: string, agent: RunRecord["agents"][number]): string {
	const runUri = mintRunUri(runId);
	const agentUri = mintAgentRunUri(runId, agent.label);
	return [
		`${iri(agentUri)} a wf:AgentRun ;`,
		`\twf:partOfRun ${iri(runUri)} ;`,
		`\twf:label ${str(agent.label)} ;`,
		`\twf:phaseIndex ${xsdInt(agent.phaseIndex)} ;`,
		`\twf:model ${str(agent.model)} ;`,
		`\twf:state ${str(agent.state)} ;`,
		`\twf:tokens ${xsdInt(agent.tokens)} ;`,
		`\twf:toolCalls ${xsdInt(agent.toolCalls)} ;`,
		`\twf:durationMs ${xsdInt(agent.durationMs)} ;`,
		`\twf:queuedAt ${xsdLong(agent.queuedAt)} ;`,
		`\twf:startedAt ${xsdLong(agent.startedAt)} ;`,
		`\twf:cached ${xsdBool(false)}${agent.agentType ? " ;" : " ."}`,
		...(agent.agentType ? [`\twf:agentType ${str(agent.agentType)} .`] : []),
	].join("\n");
}

/** Serialize a run to a single `INSERT DATA { … }` block (with PREFIXes). */
export function serializeRunProvenance(run: RunRecord): string {
	const blocks: string[] = [runBlock(run), ...run.agents.map((agent) => agentBlock(run.runId, agent))];
	return `${PREFIXES}\nINSERT DATA {\n${blocks.join("\n")}\n}`;
}

/**
 * INCREMENTAL provenance: the `wf:Run` row ONLY (no agents), for emission at
 * `run_started` so the graph becomes a live coarse progress feed before any node
 * finishes. Its status is `running`; the final strict replacement installs the
 * terminal status and complete telemetry.
 *
 * Frozen-vocab safe: emits EXACTLY the same `wf:Run`/`prov:Activity` predicates
 * as the final fold (`runBlock`), never a capability/AgentNode predicate. The
 * later final fold re-INSERTs the identical run triples idempotently (RDF set
 * semantics) plus the agent rows.
 */
export function serializeRunStartedProvenance(run: RunRecord | RunningRunProvenance): string {
	return `${PREFIXES}\nINSERT DATA {\n${runBlock(run)}\n}`;
}

/**
 * INCREMENTAL provenance: ONE `wf:AgentRun` row, for emission per node-finish so
 * each completed node lands in the graph as it happens (not only at run_done).
 * The final fold re-INSERTs the identical triples idempotently. Frozen-vocab
 * safe (same `agentBlock` builder as the final fold).
 */
export function serializeAgentRunProvenance(runId: string, agent: RunRecord["agents"][number]): string {
	return `${PREFIXES}\nINSERT DATA {\n${agentBlock(runId, agent)}\n}`;
}

/**
 * Pattern-form delete of a run's subjects, for convergent re-projection. Kept
 * separate because the hosted graph writer scopes one update operation at a
 * time to the graph's user-RDF authority graph.
 */
export function buildRunDelete(run: RunRecord): string {
	const subjects = [mintRunUri(run.runId), ...run.agents.map((a) => mintAgentRunUri(run.runId, a.label))];
	// One DELETE per subject keeps each pattern independent (joined by `\n;\n`).
	return subjects.map((s) => `${PREFIXES}\nDELETE WHERE { ${iri(s)} ?p ?o }`).join("\n;\n");
}

/** Self-check the generated INSERT — required predicates present, no `wf:run` drift. */
export function assertRunSparql(
	sparql: string,
	opts?: { expectAgents?: boolean },
): { ok: boolean; failures: string[] } {
	const failures: string[] = [];
	if (!/INSERT DATA/.test(sparql)) {
		failures.push("missing INSERT DATA");
	}
	// `wf:run` is the v0.1 drift; `wf:runId`/`wf:partOfRun` are fine (no \b match).
	if (/\bwf:run\b/.test(sparql)) {
		failures.push("found forbidden predicate wf:run (must be wf:partOfRun)");
	}
	for (const p of REQUIRED_RUN_PREDICATES) {
		if (!sparql.includes(`${p} `)) {
			failures.push(`run missing predicate ${p}`);
		}
	}
	if (opts?.expectAgents !== false) {
		for (const p of REQUIRED_AGENTRUN_PREDICATES) {
			if (!sparql.includes(`${p} `)) {
				failures.push(`agentRun missing predicate ${p}`);
			}
		}
	}
	return { ok: failures.length === 0, failures };
}

/**
 * Ensure a minimal workflow-definition subject exists for `prov:used`. We use a
 * `urn:sophia:wf` subject (not a document subject) so we never collide with the
 * content materializer, and it travels verbatim. Idempotent.
 */
export async function ensureWorkflowDef(
	graph: GraphWriter,
	graphId: string,
	workflowName: string,
	_description: string,
): Promise<string> {
	const uri = mintWorkflowUri(workflowName);
	// MINIMAL Workflow stub only: `a wf:Workflow ; wf:name`. Emporium is the SOLE
	// filer of the wf: anatomy (description / phases / script / etc.) minted from
	// the workflow definition (the DSL). We deliberately DROP two earlier writes:
	//   - wf:protocolVersion — a Protocol-class predicate; a frozen-vocab VIOLATION
	//     on a wf:Workflow subject (the golden Workflow class does not define it).
	//   - dcterms:description — collided with emporium's wf:description on the same
	//     urn:sophia:wf:{name} subject (dual-author).
	// `_description` is retained for signature stability; emporium owns it now.
	const sparql = [
		PREFIXES,
		"INSERT DATA {",
		`${iri(uri)} a wf:Workflow ;`,
		`\twf:name ${str(workflowName)} .`,
		"}",
	].join("\n");
	// Best-effort delete first for idempotency; ignore pattern-form quirks.
	try {
		await graph.sparqlUpdate(graphId, `${PREFIXES}\nDELETE WHERE { ${iri(uri)} ?p ?o }`);
	} catch {
		// non-fatal — the INSERT DATA below is the source of truth
	}
	await graph.sparqlUpdate(graphId, sparql);
	return uri;
}

/**
 * Emit run provenance as a strict replace: structural self-check, delete every
 * projected subject, then INSERT DATA. A delete failure aborts the insert so a
 * stale projection can never be compounded with a second set of mutable values.
 * The caller treats projection failure as non-fatal to workflow execution.
 */
export async function emitRunProvenance(
	graph: GraphWriter,
	graphId: string,
	run: RunRecord,
): Promise<{ ok: boolean; failures: string[] }> {
	const insert = serializeRunProvenance(run);
	const assertion = assertRunSparql(insert, { expectAgents: run.agents.length > 0 });
	if (!assertion.ok) {
		throw new Error(`provenance assertion failed: ${assertion.failures.join("; ")}`);
	}

	for (const del of buildRunDelete(run).split("\n;\n")) {
		await graph.sparqlUpdate(graphId, del);
	}

	await graph.sparqlUpdate(graphId, insert);
	return assertion;
}
