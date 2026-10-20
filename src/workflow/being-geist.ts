/**
 * A workflow being's Geist (D10, "humane agents"; `plans/2026-10-20-typed-objects/notes-geist-for-beings.md`).
 *
 * Each post of a graph plan is held by a being whose identity is the same in every run of that workflow
 * (`graph-plan-v1:{owner}/{graph}/{plan}/{step}`, `script-graph-plan.ts`). Its agent id is also its memory witness:
 * gardend keeps its memory, Song and valuations in graphs named by that id. This module decides four things: which of
 * those faculties a being is handed, the mode it wears, the ref that names its witness graphs, and the line its prompt
 * gets. The being never chooses its observer. The host binds it on every call, as it binds the graph
 * (`HostedMnemosyneProxy`'s `observerAgentId`), so a being only reads and writes its own.
 */

import {
	type AgentModeFenceV1,
	type AgentModeV1,
	agentModeDigest,
	graphIdFromScopeIri,
	graphScopeIri,
} from "../agent-runtime/agent-mode.js";
import { createMeaningfulObjectRef, type MeaningfulObjectRefV1 } from "../agent-runtime/meaningful-object.js";
import { CANONICAL_AGENT_ID } from "../agent-subject/agent-ontology.js";
import type { HostCapabilityGrantPolicyV1 } from "../capabilities/grant-gate.js";
import { WORKSPACE_READER_TOOLS, workspaceChatGrantTools } from "./workspace-chat.js";
import { WORKSPACE_READER_TOOLS_V1 } from "./workspace-chat-contract.js";

/** The built-in mode a graph plan's beings wear: the Reader's tools, this graph only, and their own memory. */
export const GRAPH_PLAN_BEING_MODE_IRI = "urn:sophia:mode:graph-plan-being";

/**
 * Witness reads a being is handed. A self-hosted Compute holds gardend's member grant, which has `memory.read`, so it
 * may call `recall`. `music` is also `memory.read`, but it is left out: gardend shows an observer that has never sung a
 * seeded verse as its Song (`geist_song_store.rs`), and a being that cannot `sing` would read words it never wrote as
 * its own. `memory_semantic_recall` takes no observer and ranks the commons, so it is no witness tool.
 */
export const BEING_GEIST_READ_TOOLS: readonly string[] = Object.freeze(["recall"]);

/**
 * Witness writes a being is handed. Empty, because the member grant lacks `memory.write` (gardend
 * `loopback_token_grants.rs`: "Not: … memory and index writes"), so every `remember` would be refused with -32003.
 * Vera decides. Once members hold `memory.write`, this becomes `["remember"]`. The step's mode, session, tools and
 * prompt all follow from this list, so no other Choreograph line changes.
 */
export const BEING_GEIST_WRITE_TOOLS: readonly string[] = Object.freeze([]);

/** For tests and for a host that knows better than the default; production reads the constants above. */
export interface BeingGeistOptions {
	readonly writes?: readonly string[];
}

function writesOf(options: BeingGeistOptions): readonly string[] {
	return options.writes ?? BEING_GEIST_WRITE_TOOLS;
}

function sortedUnique(tools: readonly string[]): readonly string[] {
	return Object.freeze([...new Set(tools)].sort());
}

/** The tools a plan step is handed (before the live cell's list narrows them): the frozen Reader's, and its Geist. */
export function graphPlanBeingTools(options: BeingGeistOptions = {}): readonly string[] {
	return sortedUnique([...WORKSPACE_READER_TOOLS_V1, ...BEING_GEIST_READ_TOOLS, ...writesOf(options)]);
}

/** A step writes nothing but its own memory, and only when it is handed a Geist write. */
export function graphPlanBeingGraphAccess(options: BeingGeistOptions = {}): "read" | "write" {
	return writesOf(options).length > 0 ? "write" : "read";
}

/**
 * The mode. Read-only while the being has no Geist write. With one, the mode is a write mode whose exact tool list
 * admits that write and nothing else that writes.
 */
export function graphPlanBeingMode(graphId: string, options: BeingGeistOptions = {}): AgentModeV1 {
	const writes = writesOf(options);
	const scope = graphScopeIri(graphId);
	return {
		iri: GRAPH_PLAN_BEING_MODE_IRI,
		label: "Reader",
		access: writes.length > 0 ? "write" : "read",
		allowsTool: [...sortedUnique([...WORKSPACE_READER_TOOLS, ...BEING_GEIST_READ_TOOLS, ...writes])],
		graphScope: graphIdFromScopeIri(scope) === graphId ? [scope] : [],
		requiresApproval: [],
	};
}

/** The host gate's fence for a plan step. Its read tools are classified read even when a cell omits their scopes. */
export function graphPlanBeingFence(graphId: string, options: BeingGeistOptions = {}): AgentModeFenceV1 {
	const mode = graphPlanBeingMode(graphId, options);
	const writes = new Set(writesOf(options));
	return {
		mode,
		digest: agentModeDigest(mode),
		boundGraphId: graphId,
		trustedReadTools: mode.allowsTool.filter((tool) => !writes.has(tool)),
	};
}

/**
 * The host's whole authority for a plan step: no graph grant, the being's mode, and exactly the tools its spec names
 * (`includeTools`), never more than the mode allows.
 */
export function graphPlanStepGrantPolicy(
	graphId: string,
	includeTools: readonly string[] | undefined,
	options: BeingGeistOptions = {},
): HostCapabilityGrantPolicyV1 {
	const fence = graphPlanBeingFence(graphId, options);
	return { exactTools: { mnemosyne: workspaceChatGrantTools(fence.mode.allowsTool, includeTools) }, mode: fence };
}

export interface BeingWitnessGraphs {
	readonly memory: string;
	readonly song: string;
	readonly salience: string;
}

const GRAPH_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * A being's witness graphs, by gardend's rule: `{graph}:projection:{faculty}:agent:{id}` (gardend `rdf_authority.rs`
 * `*_projection_graph_iri_for`; the Agent Ontology's `agt:membranePattern`). The key is the bare agent id. gardend writes
 * `mem:observedBy` as the agent IRI either way, but an IRI sent as the observer names a different graph.
 */
export function beingWitnessGraphs(graphId: string, agentId: string): BeingWitnessGraphs {
	if (!GRAPH_ID.test(graphId))
		throw new Error(`a being's home graph id is not one gardend names graphs by: ${graphId}`);
	if (!CANONICAL_AGENT_ID.test(agentId))
		throw new Error(`a being's witness key must be a canonical agent id: ${agentId}`);
	const projection = `urn:mnemosyne:local:graph:${graphId}:projection`;
	return {
		memory: `${projection}:memory:agent:${agentId}`,
		song: `${projection}:song:agent:${agentId}`,
		salience: `${projection}:salience:agent:${agentId}`,
	};
}

/**
 * The being's Geist as a Meaningful Object ref: it names the being's memory witness graph (the graph `recall` reads),
 * and its digest covers all three witness graphs and the observer, so the ref resolves without a lookup
 * (`resolveBeingGeist`).
 */
export function beingGeistRef(input: {
	readonly ownerPrincipal: string;
	readonly graphId: string;
	readonly agentId: string;
}): MeaningfulObjectRefV1<"geist"> {
	const witness = beingWitnessGraphs(input.graphId, input.agentId);
	return createMeaningfulObjectRef({
		kind: "geist",
		ownerPrincipal: input.ownerPrincipal,
		graphId: input.graphId,
		objectId: witness.memory,
		version: "1",
		value: { home: input.graphId, observer: input.agentId, witness },
	});
}

const MEMORY_WITNESS =
	/^urn:mnemosyne:local:graph:([A-Za-z0-9][A-Za-z0-9_.-]*):projection:memory:agent:(agent-[0-9a-f]+)$/;

/** The witness graphs a being's Geist ref names, or undefined for a ref that names none (a `builtin:` placeholder). */
export function resolveBeingGeist(
	ref: MeaningfulObjectRefV1<"geist">,
): (BeingWitnessGraphs & { readonly observer: string }) | undefined {
	const match = MEMORY_WITNESS.exec(ref.objectId);
	if (!match || match[1] !== ref.graphId) return undefined;
	return { ...beingWitnessGraphs(match[1], match[2]), observer: match[2] };
}

/**
 * What a being is told about its memory, from the tools it is actually handed (never more). Nothing when it has no
 * Geist tool. It does not promise privacy: gardend also files a witnessed memory in the graph's shared queue.
 */
export function beingMemoryPromptLines(tools: readonly string[]): string[] {
	const reads = tools.includes("recall");
	const writes = tools.includes("remember");
	if (!reads && !writes) return [];
	const has =
		reads && writes
			? "`recall` shows what is in it, and `remember` adds to it (name the blocks a note comes from)"
			: reads
				? "`recall` shows what is in it, which may be empty"
				: "`remember` adds to it (name the blocks a note comes from)";
	return [
		`You have a memory of your own that lasts across runs of this workflow: ${has}. Use it to notice what recurs, to remember what the source is like, and not to repeat a mistake.`,
	];
}
