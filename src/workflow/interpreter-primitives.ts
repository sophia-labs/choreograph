/**
 * Host-side workflow primitives — executor FORM (A).
 *
 * This is the REAL runtime substrate for the workflow DSL. A workflow *script*
 * runs HOST-SIDE in the orchestrator (exactly like the survey/synthesize driver
 * and the tracer do): every `agent()` call is a host Promise over the injected
 * `deps.runNode` seam (a `NodeRunner`). There is NO in-sandbox recursion — an
 * agent node never spawns a child interpreter. The interpreter owns ALL fan-out,
 * so the no-recursive-subagent-spawn invariant (run-node enqueues every node at
 * `max_depth: 0`) holds by construction.
 *
 * The seam: `agent()` materializes an `AgentNodeSpec` (1:1 with the DSL form)
 * and `await deps.runNode(spec)`. `makeNodeRunner` / `withJournal` sit BELOW this
 * module and are untouched — the interpreter depends only on the `NodeRunner`
 * function type, so it is unit-testable with a fake runner (no bwrap).
 *
 * Barrier semantics (load-bearing — the tracer's sequential-await mock is NOT the
 * runtime):
 *   - `parallel(thunks)` is a REAL barrier — `Promise.all`, every branch enqueued
 *     before any is awaited, resolves only when ALL settle.
 *   - `pipeline(items, ...stages)` has NO barrier — each item flows through the
 *     stages as an independent streaming chain; a fast item finishes its whole
 *     pipeline without waiting on a slow sibling.
 *   - `phase(title)` assigns `phaseIndex` by DECLARATION ORDER (1-based) and
 *     carries the title.
 *
 * `contract(name, schema)` is a no-op pass-through for now: it names a schema and
 * returns it unchanged so scripts can already reference contracts. The mint (the
 * Contract vertical, SPEC §7) is a separate thread and deliberately NOT built
 * here.
 */

import { CANONICAL_AGENT_ID } from "../agent-subject/agent-ontology.js";
import type { GraphWriter } from "./graph-writer.js";
import {
	type ChildInvocationRequestV1,
	type ChildInvocationResultV1,
	type ChildInvocationRunner,
	InvocationFault,
} from "./invocation.js";
import { WorkflowPausedError } from "./runtime-control.js";
import type { WorkflowBeatAmendmentKind, WorkflowBeatDecision } from "./runtime-store.js";
import type { AgentNodeResult, AgentNodeSpec, NodeRunner } from "./types.js";

/**
 * The higher-level driver deps a workflow script runs against — the orchestrator
 * passes exactly `{ runNode: runner, graph, runId, now }` where `runner` is the
 * journaled `NodeRunner` from `withJournal`.
 */
export interface WorkflowDeps {
	/** The (journaled) node runner — the ONE seam every `agent()` flows through. */
	runNode: NodeRunner;
	/** Orchestrator-side graph handle for code-serializes writes. Omit in tests. */
	graph?: GraphWriter;
	runId: string;
	now: () => number;
	/** Optional witnessed child-invocation mediator. Never runs inside an agent. */
	invoke?: ChildInvocationRunner;
	/**
	 * Optional telemetry hook called synchronously when the script calls
	 * `phase(title)`. Used by the orchestrator to emit `phase_entered` events
	 * into the journal (and from there onto the live-tail SSE stream).
	 * The previous phase's `phase_exited` event is emitted immediately BEFORE
	 * the new `phase_entered` so consumers see a clean enter/exit sequence.
	 */
	onPhase?: (phase: Phase, previousPhase: Phase | undefined) => void;
	/**
	 * Optional telemetry hook called synchronously when the script calls
	 * `log(msg)`. Used by the orchestrator to emit `log` events into the journal.
	 */
	onLog?: (line: LogLine) => void;
	/** Host-owned semantic beat controller for revision-fenced dynamic amendments. */
	control?: WorkflowBeatController;
}

export interface WorkflowBeatController {
	callTool(tool: "plan" | "enter" | "complete", args: Record<string, unknown>): Promise<WorkflowBeatDecision>;
}

/**
 * Defaults the interpreter folds into every `AgentNodeSpec` so a script's
 * `agent()` calls stay terse. A spec field on `AgentOptions` always wins.
 */
export interface InterpreterConfig {
	/** Graph every node operates on unless an `agent()` overrides it. */
	graphId: string;
	/** Default OpenRouter model id (single id, no provider field). */
	model: string;
	/** Default host-resolved inference provider. */
	provider?: string;
	/** Explicit enduring witness id; model/prompt changes must not remint it. */
	agentId?: string;
	/** Default tool surface. Per-node `toolMode` wins. Defaults to "curated". */
	toolMode?: AgentNodeSpec["toolMode"];
	/** Default strict allowlist for dynamic discovery. */
	includeTools?: string[];
	/** Default fail-closed posture for an unsatisfied dynamic allowlist. */
	strictToolManifest?: boolean;
	/** Default system prompt for nodes that don't set one. */
	systemPrompt?: string;
	/** Default simple/Prime runtime selection for nodes that do not override it. */
	runtime?: AgentNodeSpec["runtime"];
	/** Default pinned Agent Ontology / Meaningful Objects binding. */
	ontology?: AgentNodeSpec["ontology"];
}

/**
 * Per-`agent()` options — every materializable `AgentNodeSpec` field except the
 * `prompt` (the positional arg) and `phaseIndex` (assigned by the current phase).
 * An explicit `phase` handle pins the node to that phase; otherwise the
 * interpreter's current phase is used.
 */
export interface AgentOptions {
	/** Node label — wf:label + (slugged) the agentRun URI suffix. */
	label?: string;
	/** Pin this node to a specific declared phase (overrides the current phase). */
	phase?: Phase;
	/** Override the system prompt for this node. */
	systemPrompt?: string;
	/** Override the model (a single OpenRouter id). */
	model?: string;
	/** Override the provider only when the trusted workflow input pins it. */
	provider?: string;
	/** Run this node through the native Prime daemon instead of one-shot mode. */
	interactionMode?: "headless" | "headed";
	/** Explicit enduring witness id in the current canonical token form. */
	agentId?: string;
	/** Override the graph for this node. */
	graphId?: string;
	/** Mnemosyne tool surface. Default "curated". */
	toolMode?: AgentNodeSpec["toolMode"];
	/** Narrow this node's graph capability. `write` never elevates a read-only run. */
	graphAccess?: AgentNodeSpec["graphAccess"];
	/** Tool names to exclude (dynamic mode only). */
	excludeTools?: string[];
	/** Strict tool allowlist (dynamic mode only). */
	includeTools?: string[];
	/** Fail closed when an included tool is absent at runtime discovery. */
	strictToolManifest?: boolean;
	/** Forced-output JSON Schema (= wf:Contract; run-node's output_schema). */
	schema?: unknown;
	/** Turn budget for this node. */
	maxTurns?: number;
	/** Wall clock for this node's sitting, in ms (never longer than its runtime profile allows). */
	maxWallTimeMs?: number;
	/** Select the bounded simple or constrained Prime execution profile. */
	runtime?: AgentNodeSpec["runtime"];
	/** Override the pinned Agent Ontology / Meaningful Objects binding. */
	ontology?: AgentNodeSpec["ontology"];
	/** Archetype label — wf:agentType. */
	agentType?: string;
	/**
	 * Per-node capability declarations (Contract B / Slice 3).
	 *
	 * Example: { subject: { kind: "web", boundOrigin: "https://garden.example.invalid" } }
	 *
	 * The orchestrator binds each declared capability at spawn time.
	 * "mnemosyne" is always bound implicitly from the session proxy.
	 */
	capabilities?: AgentNodeSpec["capabilities"];
}

/** A declared phase: a 1-based index (by declaration order) + a carried title. */
export interface Phase {
	readonly index: number;
	readonly title: string;
}

/**
 * The outcome an `agent()` call returns to the script: the FULL node result plus
 * a typed `structured` accessor — the schema-validated payload run-node attached.
 * Awaiting `agent(...)` yields this object.
 */
export interface AgentHandle<T = unknown> extends AgentNodeResult {
	/** The schema-validated structured output (when a schema was supplied). */
	readonly structured: T | undefined;
}

/** A logged line — captured in-memory so a harness/test can assert on the trace. */
export interface LogLine {
	ts: number;
	msg: string;
}

export interface JourneyItem {
	readonly id: string;
	readonly [key: string]: unknown;
}

export interface JourneyOptions {
	readonly modelUse?: "none" | "inference" | "agentic";
	/** Trusted definition policy; the sandbox cannot widen this set. */
	readonly allowedAmendments?: readonly WorkflowBeatAmendmentKind[];
}

/** A no-arg async producer of a value — the unit of `parallel`. */
export type Thunk<T> = () => Promise<T>;

/** A pipeline stage: maps the running value for one item to the next value. */
export type Stage<TIn, TOut> = (value: TIn) => Promise<TOut>;

/**
 * The primitive surface a workflow script is handed. All fan-out is host-side
 * Promises over `deps.runNode`.
 */
export interface WorkflowContext {
	/**
	 * Run ONE agent node: materialize an `AgentNodeSpec` from `(prompt, opts)` +
	 * the interpreter defaults + the current/declared phase, then
	 * `await deps.runNode(spec)`. Returns the full result with a typed
	 * `structured` accessor. A host Promise — never an in-sandbox child.
	 */
	agent<T = unknown>(prompt: string, opts?: AgentOptions): Promise<AgentHandle<T>>;
	/** Issue a witnessed child invocation through the host's policy mediator. */
	invoke(request: ChildInvocationRequestV1): Promise<ChildInvocationResultV1>;
	/**
	 * REAL barrier: enqueue every thunk, then `Promise.all`. Resolves only when
	 * ALL branches have settled. Use for fan-out where downstream needs every
	 * result.
	 */
	parallel<T>(thunks: Array<Thunk<T>>): Promise<T[]>;
	/**
	 * NO barrier: stream each item independently through the stages. Each item is
	 * its own chain — a fast item completes the whole pipeline without waiting on
	 * a slow sibling. Returns per-item terminal values (input order preserved).
	 */
	pipeline<T0, T1>(items: T0[], s1: Stage<T0, T1>): Promise<T1[]>;
	pipeline<T0, T1, T2>(items: T0[], s1: Stage<T0, T1>, s2: Stage<T1, T2>): Promise<T2[]>;
	pipeline<T0, T1, T2, T3>(items: T0[], s1: Stage<T0, T1>, s2: Stage<T1, T2>, s3: Stage<T2, T3>): Promise<T3[]>;
	pipeline<T0, T1, T2, T3, T4>(
		items: T0[],
		s1: Stage<T0, T1>,
		s2: Stage<T1, T2>,
		s3: Stage<T2, T3>,
		s4: Stage<T3, T4>,
	): Promise<T4[]>;
	/**
	 * Execute semantic beats through the host's CAS controller. Amendments are
	 * adjudicated only at boundaries; skipped beats never call their handler.
	 */
	journey<T, Item extends JourneyItem>(
		items: readonly Item[],
		handler: (item: Item, decision: WorkflowBeatDecision) => Promise<T>,
		options?: JourneyOptions,
	): Promise<T[]>;
	/**
	 * Declare a phase. Assigns the next 1-based `phaseIndex` by declaration order
	 * and carries the title. Subsequent `agent()` calls (without an explicit
	 * `phase`) attribute to the most recently declared phase.
	 */
	phase(title: string): Phase;
	/** Append a line to the run's in-memory log trace. */
	log(msg: string): void;
	/**
	 * Name a schema as a contract and return it unchanged (no-op pass-through).
	 * The mint (Contract vertical, SPEC §7) is a separate thread.
	 */
	contract<S>(name: string, schema: S): S;

	// ── Read-only introspection (for the harness/tests/provenance roll-up) ──

	/** Every spec the interpreter has materialized, in materialization order. */
	readonly specs: ReadonlyArray<AgentNodeSpec>;
	/** Every node result, in completion order. */
	readonly results: ReadonlyArray<AgentNodeResult>;
	/** The captured log trace. */
	readonly logs: ReadonlyArray<LogLine>;
	/** Phases declared so far, in declaration order. */
	readonly phases: ReadonlyArray<Phase>;
	/**
	 * Resolves once every `agent()` started so far has settled, or after `withinMs`: a stopped run's harness waits here
	 * for the sittings its stop is ending, so their outcomes are recorded before the run's.
	 */
	settle(withinMs: number): Promise<void>;
}

/**
 * Build a workflow context bound to the driver deps + config. The returned
 * object is the primitive surface a script closes over. Stateful (phase counter,
 * spec/result/log capture) and single-run — make a fresh one per run.
 */
export function makeWorkflowContext(deps: WorkflowDeps, config: InterpreterConfig): WorkflowContext {
	const specs: AgentNodeSpec[] = [];
	const results: AgentNodeResult[] = [];
	const logs: LogLine[] = [];
	const phases: Phase[] = [];
	const inflight = new Set<Promise<AgentNodeResult>>();

	/** The phase an unpinned `agent()` attributes to. Phase 1 until declared. */
	let currentPhase: Phase = { index: 1, title: "" };
	/** Auto-label disambiguator so unlabeled nodes still get unique URIs. */
	let autoSeq = 0;

	function phase(title: string): Phase {
		const previousPhase: Phase | undefined = phases.length > 0 ? currentPhase : undefined;
		const declared: Phase = { index: phases.length + 1, title };
		phases.push(declared);
		currentPhase = declared;
		// Telemetry hook — fires synchronously so the journal gets phase_entered
		// in causal order (before any agent() calls attributed to this phase).
		deps.onPhase?.(declared, previousPhase);
		return declared;
	}

	function log(msg: string): void {
		const line: LogLine = { ts: deps.now(), msg };
		logs.push(line);
		// Telemetry hook — fires synchronously so the journal gets log in order.
		deps.onLog?.(line);
	}

	function contract<S>(_name: string, schema: S): S {
		// No-op pass-through: name the schema for the future mint, return verbatim.
		return schema;
	}

	async function agent<T = unknown>(prompt: string, opts: AgentOptions = {}): Promise<AgentHandle<T>> {
		const phaseIndex = (opts.phase ?? currentPhase).index;
		const label = opts.label ?? `node-${phaseIndex}-${++autoSeq}`;

		const spec: AgentNodeSpec = {
			label,
			phaseIndex,
			prompt,
			model: opts.model ?? config.model,
			graphId: opts.graphId ?? config.graphId,
			toolMode: opts.toolMode ?? config.toolMode ?? "curated",
		};
		const provider = opts.provider ?? config.provider;
		if (provider !== undefined) spec.provider = provider;
		if (opts.interactionMode !== undefined) spec.interactionMode = opts.interactionMode;
		// Only set optional fields when present so the spec stays minimal and the
		// `?? default` semantics in run-node aren't pre-empted by `undefined`.
		const systemPrompt = opts.systemPrompt ?? config.systemPrompt;
		if (systemPrompt !== undefined) spec.systemPrompt = systemPrompt;
		const ontology = opts.ontology ?? config.ontology;
		const explicitAgentId = opts.agentId ?? config.agentId ?? ontology?.subject.agentId;
		if (explicitAgentId !== undefined && !CANONICAL_AGENT_ID.test(explicitAgentId)) {
			throw new InvocationFault(
				"invalid_agent_identity",
				"explicit agentId must match the canonical agent-<hex> witness token",
				409,
			);
		}
		if (explicitAgentId !== undefined) spec.agentId = explicitAgentId;
		if (opts.excludeTools !== undefined) spec.excludeTools = opts.excludeTools;
		const includeTools = opts.includeTools ?? config.includeTools;
		if (includeTools !== undefined) spec.includeTools = includeTools;
		const strictToolManifest = opts.strictToolManifest ?? config.strictToolManifest;
		if (strictToolManifest !== undefined) spec.strictToolManifest = strictToolManifest;
		if (opts.graphAccess !== undefined) spec.graphAccess = opts.graphAccess;
		if (opts.schema !== undefined) spec.schema = opts.schema;
		if (opts.maxTurns !== undefined) spec.maxTurns = opts.maxTurns;
		if (opts.maxWallTimeMs !== undefined) spec.maxWallTimeMs = opts.maxWallTimeMs;
		const runtime = opts.runtime ?? config.runtime;
		if (runtime !== undefined) spec.runtime = runtime;
		if (ontology !== undefined) spec.ontology = ontology;
		if (opts.agentType !== undefined) spec.agentType = opts.agentType;
		if (opts.capabilities !== undefined) spec.capabilities = opts.capabilities;

		specs.push(spec);
		const running = deps.runNode(spec);
		inflight.add(running);
		let result: AgentNodeResult;
		try {
			result = await running;
		} finally {
			inflight.delete(running);
		}
		results.push(result);
		return { ...result, structured: result.structured as T | undefined };
	}

	async function settle(withinMs: number): Promise<void> {
		// Real time, not the run's clock: this waits on processes, and a test's clock may not move.
		const deadline = Date.now() + withinMs;
		while (inflight.size > 0 && Date.now() < deadline) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				Promise.allSettled([...inflight]),
				new Promise((resolve) => {
					timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
				}),
			]);
			clearTimeout(timer);
		}
	}

	async function invoke(request: ChildInvocationRequestV1): Promise<ChildInvocationResultV1> {
		if (!deps.invoke) {
			throw new InvocationFault(
				"capability_unavailable",
				"this workflow run has no child-invocation capability binding",
				409,
				{ capability: "choreograph.invoke" },
			);
		}
		return deps.invoke(request);
	}

	async function parallel<T>(thunks: Array<Thunk<T>>): Promise<T[]> {
		// REAL barrier: start every branch, THEN await all. `.map(t => t())` kicks
		// each thunk off eagerly so the agent enqueues happen concurrently; the
		// `Promise.all` is the join point — nothing downstream proceeds until all
		// have settled.
		return Promise.all(thunks.map((t) => t()));
	}

	function pipeline(items: unknown[], ...stages: Array<Stage<unknown, unknown>>): Promise<unknown[]> {
		// NO barrier: each item is an independent chain through the stages. We start
		// every item's chain eagerly and `Promise.all` only to collect terminal
		// values (input order preserved) — there is NO inter-item barrier BETWEEN
		// stages, so a fast item runs stage N+1 while a slow sibling is still on
		// stage N. This is the key difference from `parallel` over a per-stage
		// barrier: the streaming is per-item, not per-stage.
		const runItem = async (item: unknown): Promise<unknown> => {
			let value: unknown = item;
			for (const stage of stages) {
				value = await stage(value);
			}
			return value;
		};
		return Promise.all(items.map(runItem));
	}

	async function journey<T, Item extends JourneyItem>(
		items: readonly Item[],
		handler: (item: Item, decision: WorkflowBeatDecision) => Promise<T>,
		options: JourneyOptions = {},
	): Promise<T[]> {
		const modelUse = options.modelUse ?? "none";
		const allowedAmendments = normalizeAllowedAmendments(options.allowedAmendments);
		let pending = items.map((item) => cloneJourneyItem(item));
		if (new Set(pending.map((item) => item.id)).size !== pending.length) {
			throw new InvocationFault("invalid_journey", "journey item ids must be unique", 400);
		}
		const results: T[] = [];
		while (pending.length > 0) {
			const original = pending[0];
			if (!deps.control) {
				results.push(await handler(original, localJourneyDecision(deps.runId, original)));
				pending.shift();
				continue;
			}
			const policy = allowedAmendments === undefined ? {} : { allowedAmendments };
			const plan = await deps.control.callTool("plan", {
				pendingBeatIds: pending.map((item) => item.id),
				...policy,
			});
			throwIfJourneyPaused(plan, deps.runId, deps.now);
			if (plan.order) pending = reorderJourney(pending, plan.order);
			const selected = pending[0];
			const decision = await deps.control.callTool("enter", {
				beatId: selected.id,
				pendingBeatIds: pending.map((item) => item.id),
				parameters: selected,
				modelUse,
				...policy,
			});
			throwIfJourneyPaused(decision, deps.runId, deps.now);
			pending.shift();
			if (decision.action !== "skip") {
				results.push(await handler((decision.parameters ?? selected) as Item, decision));
			}
			await deps.control.callTool("complete", { beatId: selected.id });
		}
		return results;
	}

	return {
		agent,
		invoke,
		parallel,
		pipeline: pipeline as WorkflowContext["pipeline"],
		journey,
		phase,
		log,
		contract,
		settle,
		get specs() {
			return specs;
		},
		get results() {
			return results;
		},
		get logs() {
			return logs;
		},
		get phases() {
			return phases;
		},
	};
}

const WORKFLOW_AMENDMENT_KINDS = new Set<WorkflowBeatAmendmentKind>(["skip", "reorder", "reparameterize", "directive"]);

function normalizeAllowedAmendments(
	value: readonly WorkflowBeatAmendmentKind[] | undefined,
): readonly WorkflowBeatAmendmentKind[] | undefined {
	if (value === undefined) return undefined;
	const normalized = Array.from(new Set(value));
	if (normalized.some((kind) => !WORKFLOW_AMENDMENT_KINDS.has(kind))) {
		throw new InvocationFault("invalid_journey", "journey names an unsupported amendment kind", 400);
	}
	return normalized;
}

function cloneJourneyItem<Item extends JourneyItem>(value: Item): Item {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		typeof value.id !== "string" ||
		!value.id.trim()
	) {
		throw new InvocationFault("invalid_journey", "every journey item needs a non-empty string id", 400);
	}
	return structuredClone(value);
}

function reorderJourney<Item extends JourneyItem>(pending: Item[], order: readonly string[]): Item[] {
	const byId = new Map(pending.map((item) => [item.id, item]));
	const reordered = order.map((id) => byId.get(id));
	if (reordered.length !== pending.length || reordered.some((item) => item === undefined)) {
		throw new InvocationFault("invalid_journey", "host returned a non-permutation beat order", 500);
	}
	return reordered as Item[];
}

function throwIfJourneyPaused(decision: WorkflowBeatDecision, runId: string, now: () => number): void {
	if (decision.action !== "pause") return;
	throw new WorkflowPausedError(runId, {
		kind: "before-beat",
		...(decision.beatId ? { beatId: decision.beatId } : {}),
		ts: now(),
	});
}

function localJourneyDecision(runId: string, item: JourneyItem): WorkflowBeatDecision {
	return {
		schema: "choreograph.workflow-beat-decision.v1",
		runId,
		revision: 0,
		stage: "enter",
		beatId: item.id,
		action: "continue",
		parameters: item,
		directives: [],
		appliedAmendmentIds: [],
		rejectedAmendmentIds: [],
	};
}

/**
 * `runWorkflow` — the FORM (A) harness. Builds a `WorkflowContext` over the driver
 * deps and runs the script against it. The script is a host-side async function
 * (it closes over the primitives); `runWorkflow` simply provides the context and
 * returns whatever the script returns, alongside the captured run telemetry
 * (specs / results / logs / phases) for the provenance roll-up.
 *
 * This is the general analogue of the survey/synthesize topology: same deps
 * shape, same "agents judge, code serializes" split — but the topology is the
 * script's, not hardcoded. `makeNodeRunner` / `withJournal` / `emitRunProvenance`
 * are reused verbatim above and below this seam.
 */
export interface WorkflowRunResult<R> {
	runId: string;
	value: R;
	specs: ReadonlyArray<AgentNodeSpec>;
	results: ReadonlyArray<AgentNodeResult>;
	logs: ReadonlyArray<LogLine>;
	phases: ReadonlyArray<Phase>;
	startedAt: number;
	endedAt: number;
	durationMs: number;
}

export type WorkflowScript<R> = (ctx: WorkflowContext) => Promise<R>;

export async function runWorkflow<R>(
	deps: WorkflowDeps,
	config: InterpreterConfig,
	script: WorkflowScript<R>,
): Promise<WorkflowRunResult<R>> {
	const ctx = makeWorkflowContext(deps, config);
	const startedAt = deps.now();
	const value = await script(ctx);
	const endedAt = deps.now();
	return {
		runId: deps.runId,
		value,
		specs: ctx.specs,
		results: ctx.results,
		logs: ctx.logs,
		phases: ctx.phases,
		startedAt,
		endedAt,
		durationMs: Math.max(0, endedAt - startedAt),
	};
}
