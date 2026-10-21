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
 * Witness reads a being is handed: `recall` (its memory) and `music` (its Song). Both are `memory.read`, which a
 * self-hosted Compute's member grant holds. gardend shows a witness that has never sung "no Song yet", not a seeded
 * verse (`geist_song_store.rs`), so `music` claims nothing the being did not write. `memory_semantic_recall` is left
 * out: it takes an observer now, but the host does not bind it (`HOST_BOUND_OBSERVER_TOOLS`).
 */
export const BEING_GEIST_READ_TOOLS: readonly string[] = Object.freeze(["music", "recall"]);

/**
 * Witness writes a being is handed: `remember` and `sing`. A self-hosted Compute's own token has no `memory.write`, but
 * its `service.json` says `"agentMemory": true` (`deploy/gardend-service-manifest.mjs`), so gardend adds
 * `memory.write.observed`, which admits these two only for a call that names an agent as its observer. The host binds
 * that observer on every call, so a being writes only its own memory and Song, never the commons. On a gardend that
 * predates the grant the calls are refused (-32003), and the run record folds a refused call as not used.
 * `value` is admitted the same way (`salience.write.observed`) but not handed: nothing in a step asks for valuations.
 */
export const BEING_GEIST_WRITE_TOOLS: readonly string[] = Object.freeze(["remember", "sing"]);

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
 * Geist tool. It says "of your own", not "private": gardend never mixes a witness's memory or Song with another's or
 * with the commons, but anyone who may query the graph's RDF can read them.
 */
export function beingMemoryPromptLines(tools: readonly string[]): string[] {
	const has = (tool: string) => tools.includes(tool);
	const memory =
		has("recall") && has("remember")
			? "`recall` shows what is in it, and `remember` adds to it (name the blocks a note comes from)"
			: has("recall")
				? "`recall` shows what is in it, which may be empty"
				: has("remember")
					? "`remember` adds to it (name the blocks a note comes from)"
					: undefined;
	const song =
		has("music") && has("sing")
			? "`music` shows your Song and `sing` adds a verse to it"
			: has("music")
				? "`music` shows your Song, which may not be sung yet"
				: has("sing")
					? "`sing` adds a verse to your Song"
					: undefined;
	const parts = [memory, song].filter((part): part is string => part !== undefined);
	if (parts.length === 0) return [];
	return [
		`You have a memory of your own that lasts across runs of this workflow: ${parts.join("; ")}. Use it to notice what recurs, to remember what the source is like, and not to repeat a mistake.`,
	];
}
