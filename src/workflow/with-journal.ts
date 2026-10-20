/**
 * withJournal — wraps the node runner so every node-lifecycle fact is recorded
 * into the run journal (the SOURCE OF TRUTH). Pure observer/decorator over the
 * existing DI seams: the driver control flow is unchanged and NO wf: triples
 * are written here (that is the projection's job, P2).
 *
 * ── Two correctness invariants (load-bearing) ─────────────────────────────
 * 1. The bus subscriber is SYNCHRONOUS (`BusSubscriber = (event) => void`,
 *    event-bus.ts). We must NOT `await` or fire-and-forget async writes inside
 *    the callback — out-of-order writes would corrupt the event sequence.
 *    Instead every event is pushed onto a PER-RUN ordered queue drained by a
 *    SINGLE serial async writer (exactly one outstanding `appendEvent`).
 * 2. `seq` is assigned atomically inside `JournalStore.appendEvent`. The serial
 *    writer additionally guarantees the *order* in which appends are issued
 *    matches the order events arrived, so seq monotonicity tracks causal order.
 *
 * `run_done` must only be appended AFTER the per-run queue drains — see
 * `drain()`; the handler awaits it before `finishRun`.
 *
 * ── token_usage ───────────────────────────────────────────────────────────
 * There is exactly ONE token_usage fact per node, derived from the SAME
 * terminal SpawnResult as `node_done` (not a mid-node incremental stream). We
 * emit them as a terminal pair.
 */

import type { BusEvent, SandboxEventBus } from "../event-bus.js";
import type { LogLine, Phase } from "./interpreter-primitives.js";
import type { AppendEventInput, JournalStore } from "./journal-store.js";
import { makeNodeRunner, type NodeRunnerDeps } from "./run-node.js";
import type { AgentNodeSpec, NodeRunner } from "./types.js";

/** Per-spec context the fold needs to attribute events to a node. */
interface NodeContext {
	label: string;
	phaseIndex: number;
	structuredOutputRequired: boolean;
}

export interface WithJournalResult {
	/** The decorated runner — drop-in for the bare `NodeRunner`. */
	runner: NodeRunner;
	/**
	 * Run-scoped fan-in index: runId → the set of sandbox_ids observed for this
	 * run (a run is K+1 sandboxes; the bus is per-sandbox). In-memory, single
	 * process. This is the fan-IN index only — NO SSE fan-OUT is built here.
	 */
	sandboxIds: ReadonlySet<string>;
	/** Resolves once the per-run serial writer has drained all queued appends. */
	drain: () => Promise<void>;
	/**
	 * WorkflowDeps hook: called by the interpreter when `phase(title)` fires.
	 * Emits `phase_exited` for the outgoing phase (if any) and `phase_entered`
	 * for the new one — both through the same per-run serial writer so they land
	 * in causal order alongside node events.
	 */
	onPhase: (phase: Phase, previousPhase: Phase | undefined) => void;
	/**
	 * WorkflowDeps hook: called by the interpreter when `log(msg)` fires.
	 * Emits a `log` journal event through the per-run serial writer.
	 */
	onLog: (line: LogLine) => void;
}

/**
 * Build a journal-recording runner over the orchestrator deps. Internally calls
 * `makeNodeRunner`, installing an `onEnqueue` hook that (a) records `node_queued`
 * and (b) opens a per-sandbox bus subscription to fold the rest of the node's
 * lifecycle. All writes flow through the per-run serial writer.
 */
export function withJournal(deps: NodeRunnerDeps, journal: JournalStore, runId: string): WithJournalResult {
	const sandboxIds = new Set<string>();

	// ── Per-run serial writer ────────────────────────────────────────────────
	// One outstanding appendEvent at a time. The bus callback is sync, so it
	// only pushes; this chain does the awaiting. Errors are logged, non-fatal.
	let tail: Promise<void> = Promise.resolve();
	let pending = 0;

	function enqueueWrite(event: AppendEventInput): void {
		pending++;
		tail = tail
			.then(() => journal.appendEvent(runId, event))
			.then(() => {})
			.catch((err) => {
				console.error(
					`[with-journal] appendEvent(${event.type}) failed for run ${runId}: ${
						err instanceof Error ? err.message : String(err)
					}`,
				);
			})
			.finally(() => {
				pending--;
			});
	}

	function drain(): Promise<void> {
		// Re-await the tail until it settles with nothing else pending — a burst
		// scheduled during the await is still covered because we re-check.
		const settle = async (): Promise<void> => {
			await tail;
			if (pending > 0) {
				await settle();
			}
		};
		return settle();
	}

	// ── Fold one node's per-sandbox bus subscription into run_events ──────────
	function subscribeNode(eventBus: SandboxEventBus, sandboxId: string, ctx: NodeContext): void {
		let settled = false;
		let unsubscribe: () => void = () => {};

		const base = (): Pick<AppendEventInput, "sandbox_id" | "label" | "phase_index"> => ({
			sandbox_id: sandboxId,
			label: ctx.label,
			phase_index: ctx.phaseIndex,
		});
		const finish = (
			result:
				| Extract<BusEvent, { type: "terminal" }>["result"]
				| Extract<BusEvent, { type: "materialization.result" }>["result"],
			state: string,
			ts: number,
			errorDetail?: string,
		): void => {
			if (settled) return;
			settled = true;
			unsubscribe();
			const rawStatus = typeof result?.status === "string" ? result.status : undefined;
			const errored =
				rawStatus === "error" ||
				state === "error" ||
				state === "timeout" ||
				state === "killed" ||
				(ctx.structuredOutputRequired && result?.structured_output === undefined);
			const terminalPayload = {
				state,
				status: rawStatus,
				turns: typeof result?.turns === "number" ? result.turns : 0,
				tokens: typeof result?.tokens === "number" ? result.tokens : 0,
				tool_calls: typeof result?.tool_calls === "number" ? result.tool_calls : 0,
				output: typeof result?.output === "string" ? result.output : "",
				structured_output: result?.structured_output,
				error_detail: errorDetail,
			};
			enqueueWrite({
				type: errored ? "error" : "node_done",
				ts,
				payload: terminalPayload,
				...base(),
			});
			enqueueWrite({
				type: "token_usage",
				ts,
				payload: { tokens: terminalPayload.tokens, turns: terminalPayload.turns },
				...base(),
			});
		};

		const handle = (event: BusEvent): void => {
			if (!("category" in event)) {
				return;
			}

			if (event.category === "system" && event.type === "snapshot") {
				// A fast sandbox may have terminated before we subscribed — replay
				// the buffered events (mirrors awaitNodeResult's snapshot handling).
				for (const replayed of event.recent_events) {
					handle(replayed);
				}
				return;
			}

			if (event.category === "lifecycle" && event.type === "running") {
				enqueueWrite({ type: "node_started", ts: tsOf(event.ts), ...base() });
				return;
			}

			if (event.category === "agent" && event.type === "tool_call") {
				const inner = event.event;
				const payload = inner.type === "tool_call" ? { gate: inner.gate, args: inner.args } : { type: inner.type };
				enqueueWrite({ type: "tool_call", ts: tsOf(event.ts), payload, ...base() });
				return;
			}

			// The call's outcome, so the run record claims only what happened (a refused `remember` is not a memory).
			// The result itself stays out of the journal.
			if (event.category === "agent" && event.type === "tool_result") {
				const inner = event.event;
				if (inner.type === "tool_result") {
					enqueueWrite({
						type: "tool_result",
						ts: tsOf(event.ts),
						payload: { gate: inner.gate, isError: inner.is_error === true },
						...base(),
					});
				}
				return;
			}

			if (event.category === "agent-runtime" && event.type === "materialization.result") {
				finish(event.result, "done", tsOf(event.ts));
				return;
			}
			if (event.category === "lifecycle" && event.type === "terminal") {
				finish(event.result, event.state, tsOf(event.ts), event.error_detail);
			}
		};

		unsubscribe = eventBus.subscribe(handle, { sandbox_id: sandboxId });
		if (settled) {
			unsubscribe();
		}
	}

	const runner = makeNodeRunner({
		...deps,
		onEnqueue: async ({ spec, sandboxId, queuedAt }) => {
			sandboxIds.add(sandboxId);
			enqueueWrite({
				type: "node_queued",
				ts: queuedAt,
				sandbox_id: sandboxId,
				label: spec.label,
				phase_index: spec.phaseIndex,
				payload: {
					model: spec.model,
					agentId: spec.agentId,
					agentType: spec.agentType,
					runtimeKind: spec.runtime?.kind,
					runtimeBindingDigest: spec.runtimeBindingDigest,
					ontologyBindingDigest: spec.ontologyBindingDigest,
					agentObjectRef: spec.ontology?.objects.agent,
					geistObjectRef: spec.ontology?.objects.geist,
					graphId: spec.graphId,
					nodeKey: spec.nodeKey,
					sessionId: spec.sessionId,
					invocationId: spec.invocationId,
				},
			});
			subscribeNode(deps.eventBus, sandboxId, {
				label: spec.label,
				phaseIndex: spec.phaseIndex,
				structuredOutputRequired: spec.schema !== undefined,
			});
			await deps.onEnqueue?.({ spec, sandboxId, queuedAt });
		},
	});

	// ── v1.1: phase.entered / phase.exited / log hooks ───────────────────────
	// These are called synchronously by the interpreter's phase() / log() shims.
	// They push onto the SAME per-run serial writer as node events, guaranteeing
	// causal order. The journal is the ONE canonical stream; the telemetry emitter
	// is notified from appendEvent after each INSERT.

	function onPhase(phase: Phase, previousPhase: Phase | undefined): void {
		// Emit phase_exited for the outgoing phase before phase_entered.
		if (previousPhase !== undefined) {
			enqueueWrite({
				type: "phase_exited",
				ts: Date.now(),
				payload: { phaseIndex: previousPhase.index, phaseTitle: previousPhase.title },
			});
		}
		enqueueWrite({
			type: "phase_entered",
			ts: Date.now(),
			payload: { phaseIndex: phase.index, phaseTitle: phase.title },
			phase_index: phase.index,
			label: phase.title || undefined,
		});
	}

	function onLog(line: LogLine): void {
		enqueueWrite({
			type: "log",
			ts: line.ts,
			payload: { msg: line.msg },
		});
	}

	return { runner, sandboxIds, drain, onPhase, onLog };
}

/** Parse a bus event's ISO `ts` to epoch ms, defaulting to now on garbage. */
function tsOf(ts: string): number {
	const parsed = Date.parse(ts);
	return Number.isNaN(parsed) ? Date.now() : parsed;
}

/** Convenience for unit tests / callers that only want the runner. */
export function makeJournaledRunner(deps: NodeRunnerDeps, journal: JournalStore, runId: string): NodeRunner {
	return withJournal(deps, journal, runId).runner;
}

export type { AgentNodeSpec };
