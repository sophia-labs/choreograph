/**
 * Vehicle-facing workflow runtime API projections.
 *
 * The runtime store is the durable source of truth. This module owns the stable
 * HTTP wire shapes that thin clients such as Vehicle attach to: workflow
 * instance summary, run agent-session index, and collaborative session document
 * reads. Keep these projections small, camelCase, and CRDT-document friendly.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatSessionFactsV1 } from "../chat-catalogue.js";
import type {
	AgentSessionControlMutationResult,
	AgentSessionDocumentOp,
	AgentSessionEvent,
	AgentSessionRecord,
	WorkflowInstanceRecord,
	WorkflowRuntimeStore,
} from "./runtime-store.js";

const AGENT_SESSION_SSE_POLL_INTERVAL_MS = 500;
const AGENT_SESSION_SSE_HEARTBEAT_INTERVAL_MS = 15_000;

export interface WorkflowRuntimeRunProjection {
	runId: string;
	workflowName: string;
	graphId: string;
	ownerUserId: string;
	status: string;
	sourceSha256: string | null;
	resumeFromRunId: string | null;
	frontier: unknown;
	pauseRequestedAt: number | null;
	pauseReason: string | null;
	startedAt: number;
	updatedAt: number;
	endedAt: number | null;
	payload: unknown;
}

export interface WorkflowRuntimeAgentProjection {
	sessionId: string;
	runId: string;
	workflowName: string;
	graphId: string;
	nodeKey: string;
	label: string;
	phaseIndex: number;
	agentId: string | null;
	sandboxId: string | null;
	model: string;
	status: string;
	frontier: unknown;
	result: unknown;
	runtimeKind: string | null;
	runtimeBinding: unknown;
	runtimeBindingDigest: string | null;
	agentOntologyBinding: unknown;
	agentOntologyBindingDigest: string | null;
	sandboxGeneration: number;
	agentCheckpoint: unknown;
	meaningfulObjects: unknown;
	createdAt: number;
	updatedAt: number;
	completedAt: number | null;
	attach: {
		kind: "agent-session";
		sessionId: string;
		runId: string;
		nodeKey: string;
		objectRef: unknown;
	};
	/** Present for a listed chat: title, resolved model and provider, `createdAt`, `lastActivityAt`. */
	chat?: ChatSessionFactsV1;
}

export interface WorkflowRuntimeAgentEventProjection {
	sessionId: string;
	seq: number;
	ts: number;
	type: string;
	payload: unknown;
}

export interface WorkflowRuntimeDocumentOpProjection {
	sessionId: string;
	revision: number;
	changeId: string;
	ts: number;
	actor: string;
	kind: string;
	patch: unknown;
}

export interface WorkflowRuntimeDocumentBackendProjection {
	schema: unknown;
	backend: unknown;
	crdt: unknown;
	roomId: unknown;
	revision: number;
	changeId: string | null;
}

export interface WorkflowRuntimeAgentControlProjection {
	session: WorkflowRuntimeAgentProjection;
	document: unknown;
	events: WorkflowRuntimeAgentEventProjection[];
	documentOp?: WorkflowRuntimeDocumentOpProjection;
	applied: boolean;
	driver: string | null;
	reason?: string;
}

export function projectRuntimeInstance(instance: WorkflowInstanceRecord): WorkflowRuntimeRunProjection {
	return {
		runId: instance.run_id,
		workflowName: instance.workflow_name,
		graphId: instance.graph_id,
		ownerUserId: instance.owner_user_id,
		status: instance.status,
		sourceSha256: instance.source_sha256,
		resumeFromRunId: instance.resume_from_run_id,
		frontier: parseMaybeJson(instance.frontier_json),
		pauseRequestedAt: instance.pause_requested_at,
		pauseReason: instance.pause_reason,
		startedAt: instance.started_at,
		updatedAt: instance.updated_at,
		endedAt: instance.ended_at,
		payload: parseMaybeJson(instance.payload_json),
	};
}

export function projectAgentSession(
	session: AgentSessionRecord,
	chat?: ChatSessionFactsV1,
): WorkflowRuntimeAgentProjection {
	const document = asRecord(parseMaybeJson(session.document_json));
	const source = asRecord(document.source);
	const runtime = asRecord(document.runtime);
	const meaningfulObjects = asRecord(document.meaningfulObjects);
	return {
		sessionId: session.session_id,
		runId: session.run_id,
		workflowName: session.workflow_name,
		graphId: session.graph_id,
		nodeKey: session.node_key,
		label: session.label,
		phaseIndex: session.phase_index,
		agentId: session.agent_id,
		sandboxId: session.sandbox_id,
		model: session.model,
		status: session.status,
		frontier: parseMaybeJson(session.frontier_json),
		result: parseMaybeJson(session.result_json),
		runtimeKind: typeof runtime.kind === "string" ? runtime.kind : null,
		runtimeBinding: source.runtimeBinding,
		runtimeBindingDigest: typeof source.runtimeBindingDigest === "string" ? source.runtimeBindingDigest : null,
		agentOntologyBinding: source.agentOntologyBinding,
		agentOntologyBindingDigest:
			typeof source.agentOntologyBindingDigest === "string" ? source.agentOntologyBindingDigest : null,
		sandboxGeneration: typeof runtime.sandboxGeneration === "number" ? runtime.sandboxGeneration : 0,
		agentCheckpoint: runtime.checkpoint,
		meaningfulObjects,
		createdAt: session.created_at,
		updatedAt: session.updated_at,
		completedAt: session.completed_at,
		attach: {
			kind: "agent-session",
			sessionId: session.session_id,
			runId: session.run_id,
			nodeKey: session.node_key,
			objectRef: meaningfulObjects.agentSession,
		},
		...(chat ? { chat } : {}),
	};
}

export function projectAgentSessionEvent(event: AgentSessionEvent): WorkflowRuntimeAgentEventProjection {
	return {
		sessionId: event.session_id,
		seq: event.seq,
		ts: event.ts,
		type: event.type,
		payload: event.payload,
	};
}

export function projectAgentSessionDocumentOp(op: AgentSessionDocumentOp): WorkflowRuntimeDocumentOpProjection {
	return {
		sessionId: op.session_id,
		revision: op.rev,
		changeId: op.change_id,
		ts: op.ts,
		actor: op.actor,
		kind: op.kind,
		patch: op.patch,
	};
}

export function projectAgentSessionControlMutation(
	result: AgentSessionControlMutationResult,
): WorkflowRuntimeAgentControlProjection {
	return {
		session: projectAgentSession(result.session),
		document: result.document,
		events: result.events.map(projectAgentSessionEvent),
		documentOp: result.documentOp ? projectAgentSessionDocumentOp(result.documentOp) : undefined,
		applied: result.applied,
		driver: result.driver,
		reason: result.reason,
	};
}

export function projectAgentSessionDocumentBackend(document: unknown): WorkflowRuntimeDocumentBackendProjection {
	const record =
		document && typeof document === "object" && !Array.isArray(document) ? (document as Record<string, unknown>) : {};
	const collab =
		record.collab && typeof record.collab === "object" && !Array.isArray(record.collab)
			? (record.collab as Record<string, unknown>)
			: {};
	return {
		schema: collab.schema ?? "choreograph.agent-session-collab.v1",
		backend: collab.backend ?? "oplog",
		crdt: collab.crdt ?? "loro",
		roomId: collab.roomId,
		revision: typeof collab.revision === "number" ? collab.revision : 0,
		changeId: typeof collab.changeId === "string" ? collab.changeId : null,
	};
}

export function parseMaybeJson(value: unknown): unknown {
	if (typeof value !== "string" || value.length === 0) return undefined;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function resolveAgentSessionSinceCursor(sinceParam: string | null, lastEventId: string | undefined): number {
	const fromQuery = sinceParam != null ? Number.parseInt(sinceParam, 10) : Number.NaN;
	if (Number.isFinite(fromQuery)) {
		return fromQuery;
	}
	const fromHeader = lastEventId != null ? Number.parseInt(lastEventId, 10) : Number.NaN;
	if (Number.isFinite(fromHeader)) {
		return fromHeader;
	}
	return -1;
}

export function resolveAgentSessionRevisionCursor(sinceParam: string | null): number {
	const parsed = sinceParam != null ? Number.parseInt(sinceParam, 10) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

export function isTerminalAgentSessionStatus(status: string | undefined): boolean {
	return status === "completed" || status === "failed" || status === "paused" || status === "restartable";
}

export function writeAgentSessionSseEvent(response: ServerResponse, event: AgentSessionEvent): void {
	const projected = projectAgentSessionEvent(event);
	response.write(`event: ${projected.type}\nid: ${projected.seq}\ndata: ${JSON.stringify(projected)}\n\n`);
}

export function startAgentSessionSseStream(
	request: IncomingMessage,
	response: ServerResponse,
	runtime: WorkflowRuntimeStore,
	sessionId: string,
	since: number,
): void {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
	response.write(":ok\n\n");

	let closed = false;
	let cursor = since;
	let pollTimer: ReturnType<typeof setTimeout> | undefined;
	let draining = false;

	const heartbeat = setInterval(() => {
		if (!closed) {
			response.write(":keepalive\n\n");
		}
	}, AGENT_SESSION_SSE_HEARTBEAT_INTERVAL_MS);

	function cleanup(): void {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		if (pollTimer) clearTimeout(pollTimer);
	}

	request.on("close", cleanup);

	function scheduleNext(): void {
		if (closed) return;
		pollTimer = setTimeout(() => {
			void tick();
		}, AGENT_SESSION_SSE_POLL_INTERVAL_MS);
	}

	async function tick(): Promise<void> {
		if (closed || draining) return;
		draining = true;
		try {
			if (response.writableNeedDrain) {
				return;
			}

			const events = await runtime.listAgentSessionEventsAfter(sessionId, cursor);
			for (const event of events) {
				if (closed) return;
				writeAgentSessionSseEvent(response, event);
				cursor = event.seq;
			}

			const session = await runtime.readAgentSession(sessionId);
			if (isTerminalAgentSessionStatus(session?.status)) {
				const tail = await runtime.listAgentSessionEventsAfter(sessionId, cursor);
				for (const event of tail) {
					if (closed) return;
					writeAgentSessionSseEvent(response, event);
					cursor = event.seq;
				}
				response.end();
				cleanup();
				return;
			}
		} catch (err) {
			if (!closed) {
				response.write(
					`event: error\ndata: ${JSON.stringify({
						error: err instanceof Error ? err.message : String(err),
					})}\n\n`,
				);
				response.end();
				cleanup();
			}
			return;
		} finally {
			draining = false;
		}
		scheduleNext();
	}

	void tick();
}
