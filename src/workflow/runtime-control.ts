/**
 * Runtime control for pause/restart and Vehicle-facing agent sessions.
 *
 * This layer wraps the ordinary NodeRunner. It does not snapshot processes.
 * Resume works by re-running the deterministic workflow script and replaying
 * completed node sessions from durable results until the first incomplete safe
 * point is reached.
 */

import { createHash } from "node:crypto";
import {
	type ContentAuthorityAdmissionPort,
	isIContentAuthorityNode,
} from "../agent-runtime/content-authority-runtime.js";
import { type MeaningfulObjectRefV1, validateMeaningfulObjectRef } from "../agent-runtime/meaningful-object.js";
import type { AgentMemory } from "../agent-runtime/memory.js";
import type { PrimeRuntimeStateV2 } from "../agent-runtime/result-validation.js";
import {
	AgentSessionChildRunFault,
	parseAgentSessionResult,
	type WorkflowFrontier,
	type WorkflowRuntimeStore,
} from "./runtime-store.js";
import type { AgentNodeResult, AgentNodeSpec, NodeRunner } from "./types.js";

export class WorkflowPausedError extends Error {
	readonly code = "workflow_paused";

	constructor(
		readonly runId: string,
		readonly frontier: WorkflowFrontier,
	) {
		super(`workflow ${runId} paused at ${frontier.kind}${frontier.nodeKey ? `:${frontier.nodeKey}` : ""}`);
		this.name = "WorkflowPausedError";
	}
}

export function isWorkflowPausedError(err: unknown): err is WorkflowPausedError {
	return (
		err instanceof WorkflowPausedError ||
		Boolean(err && typeof err === "object" && (err as { code?: unknown }).code === "workflow_paused")
	);
}

export interface RuntimeNodeRunnerDeps {
	runtime: WorkflowRuntimeStore;
	baseRunner: NodeRunner;
	memory: AgentMemory;
	runId: string;
	workflowName: string;
	graphId: string;
	ownerUserId: string;
	/** Exact graph-address owner; never inferred from the acting user. */
	graphOwnerPrincipal: string;
	/** Exact durable child-run lease fence for hosted recursive execution only. */
	childRunLease?: {
		consumer: string;
		claimToken: string;
	};
	/**
	 * A durable scheduler fire owns the claimed generation across retryable
	 * pre-spawn failures. Leave its no-body reservation intact for the same fire
	 * instead of terminalizing the logical Session or deleting its wake intent.
	 */
	preserveMaterializationOnActivationFailure?: boolean;
	/**
	 * The sole I-authority port. It must complete immutable-CAS admission and
	 * physical read-only mount sealing before this layer creates a Session row.
	 */
	contentAuthorityAdmission?: ContentAuthorityAdmissionPort;
	onIdle?: (spec: AgentNodeSpec) => Promise<void>;
	/** Observational hook after the Session terminal transaction; failures are non-fatal. */
	onDurableSessionTransition?: (spec: AgentNodeSpec, status: "completed" | "failed") => void | Promise<void>;
	now?: () => number;
}

export function makeRuntimeNodeRunner(deps: RuntimeNodeRunnerDeps): NodeRunner {
	const now = deps.now ?? (() => Date.now());

	return async (spec: AgentNodeSpec): Promise<AgentNodeResult> => {
		const nodeKey = spec.nodeKey ?? stableWorkflowNodeKey(spec);
		const sessionId = spec.sessionId ?? stableAgentSessionId(deps.runId, nodeKey);
		const requestedGeneration = spec.sandboxGeneration ?? 0;
		const invocationId = spec.invocationId ?? `${sessionId}:generation:${String(requestedGeneration)}`;
		let enriched: AgentNodeSpec = { ...spec, nodeKey, sessionId, invocationId };

		const cached = await deps.runtime.readAgentSessionByNodeKey(deps.runId, nodeKey);
		const cachedResult =
			cached?.status === "completed" && requestedGeneration === 0 ? parseAgentSessionResult(cached) : undefined;
		if (cachedResult) {
			return { ...cachedResult, nodeKey, sessionId: cached.session_id, invocationId };
		}
		if (requestedGeneration > 0) {
			const checkpoint = await deps.runtime.readLatestAgentCheckpoint(sessionId);
			if (!checkpoint || checkpoint.manifest.generation !== requestedGeneration - 1) {
				throw new Error(`Generation ${String(requestedGeneration)} has no immediately preceding Agent checkpoint`);
			}
			if (
				checkpoint.manifest.runtimeBindingDigest !== spec.runtimeBindingDigest ||
				checkpoint.manifest.ontologyBindingDigest !== spec.ontologyBindingDigest ||
				checkpoint.manifest.compatibility.runtimeBundleDigest !== spec.runtime?.bundle.digest
			) {
				throw new Error("Agent checkpoint is incompatible with the requested semantic runtime");
			}
			enriched = { ...enriched, restoreState: await deps.memory.restorePrimeState(checkpoint) };
		}
		if (isIContentAuthorityNode(enriched)) {
			if (!deps.contentAuthorityAdmission) {
				throw new Error(
					"I-authoritative execution requires an injected immutable-CAS content-authority admission port",
				);
			}
			enriched = await deps.contentAuthorityAdmission.preflight(enriched);
		}

		const beforeFrontier: WorkflowFrontier = {
			kind: "before-node",
			nodeKey,
			sessionId,
			label: spec.label,
			phaseIndex: spec.phaseIndex,
			ts: now(),
		};
		await assertWorkflowCanSchedule(deps.runtime, deps.runId, beforeFrontier);

		const sessionRecord = await deps.runtime.beginAgentSession({
			sessionId,
			runId: deps.runId,
			workflowName: deps.workflowName,
			graphId: deps.graphId,
			ownerUserId: deps.ownerUserId,
			graphOwnerPrincipal: deps.graphOwnerPrincipal,
			spec: enriched,
			nodeKey,
			frontier: beforeFrontier,
			now: beforeFrontier.ts,
		});
		if (deps.childRunLease) {
			const reserved = await deps.runtime.readAgentMaterialization(sessionId, requestedGeneration);
			if (
				!reserved ||
				reserved.activation_id !== invocationId ||
				(reserved.state !== "claimed" && reserved.state !== "running")
			) {
				throw new Error("Hosted child runner lost its exact launch reservation");
			}
		} else {
			await deps.runtime.claimAgentMaterialization(sessionId, {
				generation: requestedGeneration,
				activationId: invocationId,
				now: beforeFrontier.ts,
			});
		}

		try {
			const result = await deps.baseRunner(enriched);
			let finished: AgentNodeResult = { ...result, nodeKey, sessionId, invocationId };
			if (result.primeState) {
				const agentSession = agentSessionObject(sessionRecord.document_json);
				if (!spec.runtime) throw new Error("Agent memory commit requires a resolved runtime bundle");
				const checkpoint = await deps.memory.commitPrimeState({
					ownerPrincipal: deps.graphOwnerPrincipal,
					graphId: deps.graphId,
					agentSession,
					state: result.primeState as PrimeRuntimeStateV2,
					runtimeBundle: spec.runtime.bundle,
					causationId: invocationId,
				});
				finished = { ...finished, primeState: undefined, agentCheckpoint: checkpoint };
			}
			const afterFrontier: WorkflowFrontier = {
				kind: "after-node",
				nodeKey,
				sessionId,
				label: spec.label,
				phaseIndex: spec.phaseIndex,
				ts: now(),
			};
			try {
				await deps.runtime.finishAgentSession(sessionId, {
					result: finished,
					status: result.state === "error" ? "failed" : "completed",
					generation: requestedGeneration,
					activationId: invocationId,
					...(deps.childRunLease
						? {
								childRunConsumer: deps.childRunLease.consumer,
								childRunClaimToken: deps.childRunLease.claimToken,
							}
						: {}),
					now: afterFrontier.ts,
					frontier: afterFrontier,
				});
			} catch (error) {
				if (!(await settledByHostStop(deps.runtime, sessionId, finished, error))) throw error;
			}
			await observeDurableSessionTransition(deps, enriched, result.state === "error" ? "failed" : "completed");
			// A healthy logical failure may intentionally retain a Prime resident.
			// It still needs the same bounded idle/passivation policy as a successful
			// checkpointed turn or its independent kernel can expire underneath it.
			if (finished.agentCheckpoint || result.state === "error") await deps.onIdle?.(enriched);
			return finished;
		} catch (err) {
			if (isWorkflowPausedError(err)) {
				throw err;
			}
			if (deps.preserveMaterializationOnActivationFailure) throw err;
			if (!deps.childRunLease) {
				const released = await deps.runtime.releaseUnboundAgentMaterializationLaunch(sessionId, {
					generation: requestedGeneration,
					activationId: invocationId,
					reason: err instanceof Error ? err.message : String(err),
					now: now(),
				});
				if (released) throw err;
			}
			const failed: AgentNodeResult = {
				nodeKey,
				sessionId,
				invocationId,
				label: spec.label,
				phaseIndex: spec.phaseIndex,
				state: "error",
				output: err instanceof Error ? err.message : String(err),
				model: spec.model,
				agentId: spec.agentId,
				turns: 0,
				toolCalls: 0,
				tokens: 0,
				queuedAt: beforeFrontier.ts,
				startedAt: beforeFrontier.ts,
				durationMs: 0,
				agentType: spec.agentType,
			};
			const frontier: WorkflowFrontier = {
				kind: "after-node",
				nodeKey,
				sessionId,
				label: spec.label,
				phaseIndex: spec.phaseIndex,
				ts: now(),
			};
			await deps.runtime.finishAgentSession(sessionId, {
				result: failed,
				status: "failed",
				generation: requestedGeneration,
				activationId: invocationId,
				...(deps.childRunLease
					? {
							childRunConsumer: deps.childRunLease.consumer,
							childRunClaimToken: deps.childRunLease.claimToken,
						}
					: {}),
				now: frontier.ts,
				frontier,
			});
			await observeDurableSessionTransition(deps, enriched, "failed");
			if (spec.runtime?.kind === "prime") {
				try {
					await deps.onIdle?.(enriched);
				} catch (idleError) {
					console.error(
						`[workflow] failed Agent Session idle transition could not be scheduled for ${sessionId}: ${
							idleError instanceof Error ? idleError.message : String(idleError)
						}`,
					);
				}
			}
			throw err;
		}
	};
}

/**
 * A sitting the host ended (its wall clock, a repeated call, its turn cap, the run's stop) is reaped before its outcome
 * reaches the store, and the store has already settled the Session failed from the body's fault: that first testimony
 * stands, and the sitting's outcome still goes back to the script, so the run goes on (2026-10-21: a timed-out clerk
 * failed its whole run instead of its one item).
 */
async function settledByHostStop(
	runtime: WorkflowRuntimeStore,
	sessionId: string,
	result: AgentNodeResult,
	error: unknown,
): Promise<boolean> {
	if (result.stopped === undefined || result.state !== "error") return false;
	if (!(error instanceof AgentSessionChildRunFault) || error.reason !== "materialization_conflict") return false;
	return (await runtime.readAgentSession(sessionId))?.status === "failed";
}

async function observeDurableSessionTransition(
	deps: RuntimeNodeRunnerDeps,
	spec: AgentNodeSpec,
	status: "completed" | "failed",
): Promise<void> {
	try {
		await deps.onDurableSessionTransition?.(spec, status);
	} catch (error) {
		console.error(
			`[workflow] Agent Session display refresh failed for ${spec.sessionId ?? "unbound"}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function agentSessionObject(documentJson: string): MeaningfulObjectRefV1<"agent-session"> {
	const document = JSON.parse(documentJson) as Record<string, unknown>;
	const meaningfulObjects = document.meaningfulObjects as Record<string, unknown> | undefined;
	const value = meaningfulObjects?.agentSession;
	validateMeaningfulObjectRef(value, "agent-session");
	return value as MeaningfulObjectRefV1<"agent-session">;
}

async function assertWorkflowCanSchedule(
	runtime: WorkflowRuntimeStore,
	runId: string,
	frontier: WorkflowFrontier,
): Promise<void> {
	const instance = await runtime.getWorkflowInstance(runId);
	if (!instance) {
		return;
	}
	if (instance.status === "paused" || instance.status === "pausing" || instance.pause_requested_at != null) {
		await runtime.markPaused(runId, frontier);
		throw new WorkflowPausedError(runId, frontier);
	}
}

export function stableWorkflowNodeKey(spec: Pick<AgentNodeSpec, "phaseIndex" | "label">): string {
	return `${spec.phaseIndex}:${slug(spec.label)}`;
}

export function stableAgentSessionId(runId: string, nodeKey: string): string {
	const digest = createHash("sha256").update(`${runId}:${nodeKey}`).digest("hex").slice(0, 20);
	return `ags_${digest}`;
}

function slug(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}
