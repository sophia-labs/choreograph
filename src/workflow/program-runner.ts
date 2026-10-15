import type { HostedAuthContext } from "../auth.js";
import type { SandboxEventBus } from "../event-bus.js";
import type { CapabilityBackend } from "../mnemosyne.js";
import { type CaptureEmitter, captureIdentityForHostedRequest, emitCaptureSoft } from "../observatory-capture.js";
import type { SandboxSpawner } from "../spawner.js";
import type { GraphWriter } from "./graph-writer.js";
import type { WorkflowRunInputs } from "./harness.js";
import { emitHojaResultTestimony, hojaLogicalRunId, indexHojaResultEvidence } from "./hoja-testimony.js";
import {
	assertJsonSchema,
	INVOCATION_RECEIPT_SCHEMA,
	invocationErrorEnvelope,
	resolveExecutionBinding,
} from "./invocation.js";
import type { JournalStore } from "./journal-store.js";
import { WorkflowProgramControlBackend } from "./program-control.js";
import { executeProgramWorkflow } from "./program-executor.js";
import type { WorkflowRegistryEntry } from "./registry.js";
import { isWorkflowPausedError } from "./runtime-control.js";
import type { WorkflowRuntimeStore } from "./runtime-store.js";
import { fileServiceBatteryRecord, serviceRecordFailure } from "./service-record.js";
import { emitServiceResultTestimony } from "./service-testimony.js";
import type { RunRecord } from "./types.js";
import { mintWorkflowUri } from "./vocab.js";

export interface ProgramRunDeps {
	readonly spawner: SandboxSpawner;
	readonly eventBus: SandboxEventBus;
	readonly journal: JournalStore;
	readonly runtime: WorkflowRuntimeStore;
	readonly capture?: CaptureEmitter;
	/** Bind host-owned implementations for the workflow's declared capabilities. */
	readonly bindCapabilities?: (request: {
		readonly names: readonly string[];
		readonly graphId: string;
		readonly graphOwner?: string;
		readonly actorRef: string;
		readonly ownerUserId: string;
		readonly authority: {
			readonly minimumRole: "viewer" | "editor";
			readonly dangerousOps: boolean;
		};
		readonly authContext?: HostedAuthContext;
		readonly input?: unknown;
	}) => Promise<ReadonlyMap<string, CapabilityBackend>>;
	/**
	 * Resolve a writer bound to a workflow's RECORD graph — a second graph, and a
	 * second owner-scoped binding, distinct from the run's own (SUT) graph.
	 *
	 * The program path deliberately has no blanket graph proxy: its single
	 * canonical owner+graph tuple goes only to declared sandbox capabilities. A
	 * flow that judges a disposable graph and files its judgment in a durable one
	 * needs exactly one more edge, and it belongs HERE rather than in the sandbox
	 * — the editor grant on the durable record must never enter a bwrap namespace,
	 * and one host-side writer keeps the record's writes serialized against a
	 * two-permit SPARQL admission layer.
	 */
	readonly recordWriterFor?: (graphId: string) => Promise<GraphWriter>;
}

export interface ProgramRunRequest {
	readonly runId: string;
	readonly invocationId: string;
	readonly actorRef: string;
	readonly ownerUserId: string;
	readonly graphId: string;
	/** Canonical owner of the graph selected at the trusted invocation edge. */
	readonly graphOwner?: string;
	/** Durable Meaningful Object identity supplied by the invocation target. */
	readonly targetWorkflowUri?: string;
	readonly entry: WorkflowRegistryEntry;
	readonly inputs: WorkflowRunInputs;
	readonly timeoutMs?: number;
	readonly authContext?: HostedAuthContext;
}

/**
 * Validate the committed invocation payload before an asynchronous caller is
 * told that a durable run exists. Keep the same check in the runner as a
 * defense-in-depth boundary for direct callers.
 */
export function validateProgramInvocationInput(entry: WorkflowRegistryEntry, inputs: WorkflowRunInputs): void {
	assertJsonSchema(inputs.schemaInput ?? inputs.args ?? {}, entry.compiled.meta.inputs, "input");
}

/**
 * Durable model-free workflow path: runtime instance + journal + sandbox +
 * canonical invocation receipt. It intentionally has no graph or LLM proxy
 * dependency. The canonical owner+graph tuple is passed only to declared host
 * capabilities and remains the journal partition for the durable receipt.
 */
export async function runProgramInvocation(deps: ProgramRunDeps, request: ProgramRunRequest): Promise<RunRecord> {
	const { entry } = request;
	const execution = resolveExecutionBinding(entry.compiled.meta);
	const workflowName = entry.compiled.meta.name;
	const workflowUri = request.targetWorkflowUri ?? mintWorkflowUri(workflowName);
	const startedAt = Date.now();
	const effects: Array<{ capability: string; operation: string; outcome: "ok" | "error" | "denied" }> = [];
	const captureIdentity = captureIdentityForHostedRequest({
		authMethod: request.authContext?.method,
		ownerUserId: request.ownerUserId,
		graphId: request.graphId,
	});
	const testimonyRunId = hojaLogicalRunId(request.inputs.args, request.runId);

	validateProgramInvocationInput(entry, request.inputs);

	await deps.runtime.createWorkflowInstance({
		runId: request.runId,
		workflowName,
		graphId: request.graphId,
		ownerUserId: request.ownerUserId,
		sourceSha256: entry.scriptSha256,
		sourceText: entry.compiled.source,
		inputs: request.inputs,
		startedAt,
		payload: {
			invocationId: request.invocationId,
			actorRef: request.actorRef,
			execution,
		},
	});
	await deps.journal.createRun({
		run_id: request.runId,
		workflow_name: workflowName,
		graph_id: request.graphId,
		owner_user_id: request.ownerUserId,
		status: "running",
		started_at: startedAt,
		payload: {
			invocationId: request.invocationId,
			definitionDigest: entry.scriptSha256,
			execution,
			testimonyRunId,
			...(request.graphOwner ? { graphOwner: request.graphOwner } : {}),
		},
	});
	await deps.journal.appendEvent(request.runId, {
		type: "run_started",
		ts: startedAt,
		payload: { workflowName, invocationId: request.invocationId, execution },
	});

	try {
		const capabilities = execution.capabilities.length
			? await deps.bindCapabilities?.({
					names: execution.capabilities,
					graphId: request.graphId,
					...(request.graphOwner ? { graphOwner: request.graphOwner } : {}),
					actorRef: request.actorRef,
					ownerUserId: request.ownerUserId,
					authority: execution.authority,
					authContext: request.authContext,
					input: request.inputs.args,
				})
			: undefined;
		const program = await executeProgramWorkflow(
			{
				spawner: deps.spawner,
				eventBus: deps.eventBus,
				ownerUserId: request.ownerUserId,
				...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
				capabilities,
				control: new WorkflowProgramControlBackend(deps.runtime, request.runId),
				onEffect: (effect) => effects.push(effect),
				onCapabilityCall: (call) =>
					emitCaptureSoft(deps.capture, {
						kind: "capability.call",
						...captureIdentity,
						outcome: call.outcome,
						durationMs: call.durationMs,
						payload: {
							runId: testimonyRunId,
							sandboxId: call.sandboxId,
							callId: call.callId,
							capability: call.capability,
							tool: call.operation,
						},
					}),
			},
			entry.compiled,
			request.inputs.args ?? {},
		);
		assertJsonSchema(program.output, entry.compiled.meta.outputs, "output");
		const evidenceIndex = indexHojaResultEvidence(program.output);
		emitHojaResultTestimony({
			capture: deps.capture,
			identity: captureIdentity,
			runId: testimonyRunId,
			output: program.output,
		});
		// Both projectors guard on their own result schema and no-op on foreign output, so
		// dispatching is unnecessary — calling both is safe and keeps a new campaign from
		// needing a change here. Without this call a service-battery run completes normally
		// and emits no test.verdict at all, which shows up as EMPTY Observatory metrics
		// rather than failing ones: the failure mode that reads as success.
		emitServiceResultTestimony({
			capture: deps.capture,
			identity: captureIdentity,
			runId: testimonyRunId,
			output: program.output,
		});

		// The durable half of the same testimony, filed AFTER the events and never
		// instead of them: the metric packs join on the event stream, and the named
		// graph is what is still there once the 72-hour window has rolled. A no-op
		// for every workflow whose output is not a battery result, so no other
		// program path changes shape.
		const batteryRecord = await fileServiceBatteryRecord(deps, {
			recordGraph: recordGraphOf(request.inputs.args),
			sutGraph: request.graphId,
			runId: testimonyRunId,
			workflowName,
			output: program.output,
			observedAtMs: startedAt,
			filedAtMs: Date.now(),
		});
		const recordFailure = serviceRecordFailure(batteryRecord);
		const output =
			batteryRecord === undefined
				? program.output
				: { ...(program.output as Record<string, unknown>), record: batteryRecord };

		for (const phase of program.phases) {
			await deps.journal.appendEvent(request.runId, {
				type: "phase_entered",
				phase_index: phase.index,
				payload: { phaseIndex: phase.index, phaseTitle: phase.title, sandboxId: program.sandboxId },
			});
			await deps.journal.appendEvent(request.runId, {
				type: "phase_exited",
				phase_index: phase.index,
				payload: { phaseIndex: phase.index, phaseTitle: phase.title, sandboxId: program.sandboxId },
			});
		}
		for (const line of program.logs) {
			await deps.journal.appendEvent(request.runId, {
				type: "log",
				payload: { msg: line.msg, sandboxId: program.sandboxId },
			});
		}
		if (evidenceIndex.length > 0) {
			await deps.journal.appendEvent(request.runId, {
				type: "evidence_index",
				payload: {
					schema: "sophia.hoja.evidence-index.v1",
					logicalRunId: testimonyRunId,
					refs: evidenceIndex,
				},
			});
		}

		const endedAt = Date.now();
		// A run whose judgment did not reach the record graph did not succeed. The
		// verdicts stay in the output and the CaptureEvents were already emitted —
		// the failure names the RECORD path, never the service under test — but the
		// run reports failed, because a green run over an empty graph is the exact
		// failure mode that reads as success. See `serviceRecordFailure`.
		const receipt = {
			schema: INVOCATION_RECEIPT_SCHEMA,
			invocationId: request.invocationId,
			target: {
				workflowName,
				workflowUri,
				definitionDigest: entry.scriptSha256,
			},
			execution,
			status: recordFailure ? ("failed" as const) : ("completed" as const),
			startedAt,
			endedAt,
			durationMs: Math.max(0, endedAt - startedAt),
			output,
			...(recordFailure ? { error: recordFailure } : {}),
			childInvocationIds: [],
			effects: program.effects,
			usage: { agentCount: 0, totalTokens: 0 },
		};
		const run: RunRecord = {
			runId: request.runId,
			workflowName,
			workflowUri,
			status: recordFailure ? "failed" : "completed",
			startedAt,
			endedAt,
			durationMs: receipt.durationMs,
			agentCount: 0,
			totalTokens: 0,
			agents: [],
			output,
			execution,
			invocationReceipt: receipt,
			scriptSha256: entry.scriptSha256,
			...(recordFailure ? { note: recordFailure.message } : {}),
		};
		await finish(deps, request.runId, run, {
			output,
			receipt,
			...(recordFailure ? { error: recordFailure } : {}),
		});
		return run;
	} catch (error) {
		const endedAt = Date.now();
		const paused = isWorkflowPausedError(error);
		const projected = invocationErrorEnvelope(error).error;
		const receipt = {
			schema: INVOCATION_RECEIPT_SCHEMA,
			invocationId: request.invocationId,
			target: {
				workflowName,
				workflowUri,
				definitionDigest: entry.scriptSha256,
			},
			execution,
			status: paused ? ("paused" as const) : ("failed" as const),
			startedAt,
			endedAt,
			durationMs: Math.max(0, endedAt - startedAt),
			...(paused ? {} : { error: projected }),
			childInvocationIds: [],
			effects,
			usage: { agentCount: 0, totalTokens: 0 },
		};
		const run: RunRecord = {
			runId: request.runId,
			workflowName,
			workflowUri,
			status: paused ? ("paused" as const) : ("failed" as const),
			startedAt,
			endedAt,
			durationMs: receipt.durationMs,
			agentCount: 0,
			totalTokens: 0,
			agents: [],
			execution,
			invocationReceipt: receipt,
			scriptSha256: entry.scriptSha256,
			note: paused ? "paused at a semantic beat boundary" : projected.message,
		};
		await finish(deps, request.runId, run, paused ? { paused: true, receipt } : { error: projected, receipt });
		return run;
	}
}

/**
 * The record graph the run's inputs named. Absent for every workflow that has no
 * record graph — `fileServiceBatteryRecord` then refuses on its own schema guard,
 * so an empty string never reaches a writer.
 */
function recordGraphOf(args: unknown): string {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return "";
	const value = (args as Record<string, unknown>).recordGraph;
	return typeof value === "string" ? value : "";
}

async function finish(
	deps: ProgramRunDeps,
	runId: string,
	run: RunRecord,
	payload: Record<string, unknown>,
): Promise<void> {
	if (run.status === "failed") {
		await deps.journal.appendEvent(runId, { type: "error", payload });
	}
	await deps.journal.appendEvent(runId, {
		type: "run_done",
		ts: run.endedAt,
		payload: { status: run.status, ...payload },
	});
	await deps.journal.finishRun(runId, {
		status: run.status,
		ended_at: run.endedAt,
		duration_ms: run.durationMs,
		agent_count: 0,
		total_tokens: 0,
		synthesis_doc_id: null,
	});
	await deps.runtime.markWorkflowFinished(runId, {
		status: run.status,
		endedAt: run.endedAt,
		frontier: run.status === "paused" ? undefined : { kind: "run-finished", ts: run.endedAt },
	});
}
