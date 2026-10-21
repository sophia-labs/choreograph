/**
 * `runWorkflow` — the executor FORM (A) harness (SPEC §9.1, the interpreter slice).
 *
 * This is the general analogue of `runSurveySynthesize`: it replaces the
 * HARDCODED topology with the Workflow-dialect runtime. A Workflow *script* is a
 * portable artifact (`export const meta = {…}` + a top-level async body that ends
 * in `return <value>`, using the globals `agent/parallel/pipeline/phase/log/
 * contract/args`). The harness `new Function`-evals that script against the LIVE
 * primitives (`makeWorkflowContext`) — mirroring the tracer's eval seam
 * (wf-emit/tracer.cjs:59-65) but with REAL bindings over `deps.runNode` instead
 * of recording stubs — and folds the captured telemetry into a `RunRecord`
 * IDENTICAL in shape to what the driver returns.
 *
 * The split is unchanged from the driver: agents judge, CODE serializes. Every
 * `agent()` is a host Promise over `deps.runNode` (the journaled `NodeRunner`);
 * the script never spawns an in-sandbox child (no-recursive-subagent-spawn holds
 * by construction — the interpreter owns ALL fan-out host-side). The synthesis
 * document is written HERE (orchestrator-side), not by an agent, exactly as the
 * driver does — the script merely RETURNS the synthesis payload.
 *
 * `makeNodeRunner` / `withJournal` (below this seam) and `emitRunProvenance`
 * (above it) are reused verbatim — the harness depends only on the `WorkflowDeps`
 * shape and the `RunRecord` contract.
 */

import JSON5 from "json5";
import {
	type InterpreterConfig,
	makeWorkflowContext,
	type WorkflowContext,
	type WorkflowDeps,
} from "./interpreter-primitives.js";
import { assertJsonSchema, type ExecutionBindingInput, resolveExecutionBinding } from "./invocation.js";
import { isWorkflowPausedError, isWorkflowStoppedError } from "./runtime-control.js";
import type { AgentNodeResult, RunRecord } from "./types.js";
import { mintWorkflowUri } from "./vocab.js";

// ── Compiled-script shape ────────────────────────────────────────────────────

/** The declared workflow metadata block (`export const meta = {…}`). */
export interface WorkflowMeta {
	/** Workflow name — becomes `RunRecord.workflowName` and the `prov:used` urn. */
	name: string;
	/** Human description (carried for provenance/registry; unused by the runtime). */
	description?: string;
	/** When this workflow is the right tool (carried for the registry). */
	whenToUse?: string;
	/** Declared phases (title + detail), informational — phase() assigns indices. */
	phases?: Array<{ title: string; detail?: string }>;
	/**
	 * JSON Schema describing the workflow's run inputs (the `workflow_args` shape).
	 * Carried for the api:WorkflowBinding face (L0's EA-3 OpenAPI round-trip) —
	 * surfaced verbatim by `GET /api/workflows/{name}/schema`. Optional; an absent
	 * schema is served as the permissive `{ "type": "object" }` default.
	 */
	inputs?: Record<string, unknown>;
	/**
	 * JSON Schema describing the workflow's output. Carried for the
	 * api:WorkflowBinding face; surfaced by the schema endpoint. Optional —
	 * defaults to the permissive `{ "type": "object" }` when absent.
	 */
	outputs?: Record<string, unknown>;
	/**
	 * Compatibility invocation posture. `"gated"` (default) = agent/composite;
	 * `"dumb"` = program-controlled. The canonical `execution` axes decide the
	 * actual path; this field remains for older WorkflowBinding readers.
	 */
	executor?: "gated" | "dumb";
	/** Canonical orthogonal execution posture; `executor` is compatibility-only. */
	execution?: ExecutionBindingInput;
}

/**
 * The async body a compiled script runs as. The harness invokes it with the bound
 * primitive surface + the run inputs (`args`); it returns the script's `return`
 * value (the workflow output). Mirrors the tracer's `new Function(...primitives,
 * 'args', 'return (async () => { <src> })()')`.
 */
export type CompiledBody = (primitives: WorkflowContext, args: unknown) => Promise<unknown>;

/** A parsed-once Workflow script: its metadata + its eval'd async body. */
export interface CompiledWorkflow {
	meta: WorkflowMeta;
	body: CompiledBody;
	/** The original source (retained for provenance/registry; not re-eval'd). */
	source: string;
	/** Top-level executable body after removing only the `export` keyword. */
	bodySource: string;
}

// ── Compilation (the eval seam) ──────────────────────────────────────────────

/**
 * The names a Workflow script closes over as globals — bound positionally into
 * the `new Function`. Mirrors tracer.cjs:59 (minus `budget`/`workflow`, which are
 * not part of the FORM (A) primitive surface; `contract` is added).
 */
const PRIMITIVE_GLOBALS = ["agent", "invoke", "parallel", "pipeline", "journey", "phase", "log", "contract"] as const;

const META_RE = /export\s+const\s+meta\s*=\s*(\{[\s\S]*?\n\})/;
/** Strip the FIRST top-level `export ` (the meta export) so the body evals clean. */
const FIRST_EXPORT_RE = /^export\s+/m;

/**
 * Compile a Workflow script source into a `CompiledWorkflow`: parse the pure-
 * literal `meta` block and `new Function`-eval the remaining top-level body into a
 * callable async function for the trusted agent/composite interpreter. Parsing
 * happens ONCE; a program-controlled entry instead sends `bodySource` to the bare
 * sandbox and never calls this host-side body.
 *
 * The eval is the same shape the tracer uses, so a script that traces also runs:
 * strip the leading `export ` from the `meta` declaration, wrap the rest as an
 * async IIFE, and bind the primitive globals + `args` positionally.
 */
export function compileWorkflow(source: string): CompiledWorkflow {
	const metaMatch = META_RE.exec(source);
	if (!metaMatch) {
		throw new Error("workflow script has no `export const meta = { … }` block");
	}
	const meta = evalMetaLiteral(metaMatch[1]);
	if (!meta.name || typeof meta.name !== "string") {
		throw new Error("workflow `meta.name` is required and must be a string");
	}

	// Strip the leading top-level `export ` (the meta export) — everything after is
	// the script body, run as an async IIFE so its `return` becomes the value.
	const stripped = source.replace(FIRST_EXPORT_RE, "");
	const ctorArgs = [...PRIMITIVE_GLOBALS, "args"];
	// eslint-disable-next-line no-new-func — the eval seam is the whole point of FORM (A).
	const fn = new Function(...ctorArgs, `return (async () => {\n${stripped}\n})()`) as (
		...args: unknown[]
	) => Promise<unknown>;

	const body: CompiledBody = (primitives, args) =>
		fn(
			primitives.agent.bind(primitives),
			primitives.invoke.bind(primitives),
			primitives.parallel.bind(primitives),
			primitives.pipeline.bind(primitives),
			primitives.journey.bind(primitives),
			primitives.phase.bind(primitives),
			primitives.log.bind(primitives),
			primitives.contract.bind(primitives),
			args,
		);

	return { meta, body, source, bodySource: stripped };
}

/** Parse the data-only `meta` object without executing author-provided code. */
function evalMetaLiteral(literal: string): WorkflowMeta {
	const value = JSON5.parse(literal) as unknown;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("workflow `meta` must be a data-only object literal");
	}
	return value as WorkflowMeta;
}

// ── Run inputs + output convention ───────────────────────────────────────────

/**
 * What the harness needs to run a compiled script. `args` is handed to the script
 * verbatim (its `args` global). The interpreter defaults (`graphId`, `model`,
 * `toolMode`, `systemPrompt`) seed every `agent()` that doesn't override them.
 */
export interface WorkflowRunInputs {
	/** Per-`agent()` defaults folded by the interpreter. */
	config: InterpreterConfig;
	/** The script's `args` global (the run-specific inputs). */
	args?: unknown;
	/** Public/API input face used for `meta.inputs` validation when args are normalized. */
	schemaInput?: unknown;
	/** Trusted host-only state. Never exposed through the workflow script's `args`. */
	hostContext?: unknown;
}

/**
 * The conventional return shape a script uses to hand the orchestrator a synthesis
 * document to serialize (code serializes — the script never writes the doc). All
 * fields optional: a script that returns nothing of this shape simply produces a
 * run with no synthesis doc, exactly like the driver's unit mode.
 */
export interface WorkflowOutput {
	synthesis?: { title?: string; markdown: string };
	/** Optional question/title context for the synthesis-doc header. */
	question?: string;
}

// ── The harness ──────────────────────────────────────────────────────────────

/**
 * Run a compiled Workflow script end-to-end and roll the captured telemetry up
 * into a `RunRecord` — IDENTICAL in shape to `runSurveySynthesize`'s return.
 *
 * `deps.runNode` is the journaled `NodeRunner` the orchestrator built from
 * `withJournal` (NOT a bare `makeNodeRunner` output) — the harness only depends on
 * the function type, so the tee/journal wrapping is transparent here.
 */
export async function runWorkflow(
	deps: WorkflowDeps,
	compiled: CompiledWorkflow,
	inputs: WorkflowRunInputs,
): Promise<RunRecord> {
	const startedAt = deps.now();
	const workflowName = compiled.meta.name;
	const workflowUri = mintWorkflowUri(workflowName);
	const execution = resolveExecutionBinding(compiled.meta);
	assertJsonSchema(inputs.schemaInput ?? inputs.args ?? {}, compiled.meta.inputs, "input");

	const ctx = makeWorkflowContext(deps, inputs.config);
	let returned: unknown;
	let paused: Error | undefined;
	let stopped: Error | undefined;
	try {
		returned = await compiled.body(ctx, inputs.args);
	} catch (err) {
		if (isWorkflowStoppedError(err)) {
			stopped = err as Error;
			// The stop is ending the sittings still live in other branches; record their outcomes before the run's.
			await ctx.settle(STOPPED_RUN_SETTLE_MS);
		} else if (isWorkflowPausedError(err)) {
			paused = err instanceof Error ? err : new Error(String(err));
		} else {
			throw err;
		}
	}
	if (!paused && !stopped) assertJsonSchema(returned, compiled.meta.outputs, "output");

	// ── Code serializes: write the synthesis document (best-effort), exactly as
	// the driver does. The SCRIPT returns the synthesis payload; the orchestrator
	// (here) writes it — agents never call write_document for the artifact.
	const output = asWorkflowOutput(returned);
	let synthesisDocId: string | undefined;
	let note: string | undefined = stopped?.message ?? paused?.message;
	if (!paused && !stopped && deps.graph && output?.synthesis?.markdown) {
		const docId = `wf-synthesis-${deps.runId}`;
		try {
			await deps.graph.writeDocument(inputs.config.graphId, docId, synthDocContent(output));
			synthesisDocId = docId;
		} catch (err) {
			note = `synthesis-doc write failed: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	const agents: AgentNodeResult[] = [...ctx.results];
	const endedAt = deps.now();
	const status: RunRecord["status"] = stopped
		? "stopped"
		: paused
			? "paused"
			: agents.length > 0 && agents.every((a) => a.state === "done")
				? "completed"
				: agents.some((a) => a.state === "error")
					? "failed"
					: agents.length === 0
						? "completed"
						: "stopped";

	return {
		runId: deps.runId,
		workflowName,
		workflowUri,
		status,
		startedAt,
		endedAt,
		durationMs: Math.max(0, endedAt - startedAt),
		agentCount: agents.length,
		totalTokens: agents.reduce((sum, a) => sum + a.tokens, 0),
		agents,
		output: returned,
		execution,
		synthesisDocId,
		synthesisMarkdown: output?.synthesis?.markdown,
		note,
	};
}

/** How long a stopped run waits for the sittings its stop is ending before it records its own end. */
const STOPPED_RUN_SETTLE_MS = 30_000;

function synthDocContent(output: WorkflowOutput): string {
	const synthesis = output.synthesis;
	if (!synthesis) return "";
	const heading = synthesis.title ? `# ${synthesis.title}` : "# Synthesis";
	const lines = [heading, ""];
	if (output.question) {
		lines.push(`*Question: ${output.question}*`, "");
	}
	lines.push(synthesis.markdown);
	return lines.join("\n");
}

/** Coerce a script's return value into the conventional `WorkflowOutput` shape. */
function asWorkflowOutput(value: unknown): WorkflowOutput | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const synthesis = record.synthesis;
	if (synthesis && typeof synthesis === "object") {
		const s = synthesis as Record<string, unknown>;
		if (typeof s.markdown === "string") {
			return {
				synthesis: {
					markdown: s.markdown,
					title: typeof s.title === "string" ? s.title : undefined,
				},
				question: typeof record.question === "string" ? record.question : undefined,
			};
		}
	}
	return undefined;
}
