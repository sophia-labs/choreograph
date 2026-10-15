/**
 * Emporium runs-ingest CLIENT — the SHACL-gated alternative to the direct
 * `wf:` provenance emit (provenance.ts → sparql_update over MCP).
 *
 * Hosted gateway service-auth selects this path automatically; an explicit
 * `WORKFLOW_EMPORIUM_INGEST_URL` remains available for local/custom routing.
 * The orchestrator files a finished run by POSTing a typed `IngestRequest` to
 * the emporium ingest route INSTEAD of folding the run to SPARQL and writing it
 * via MCP. Emporium's planner diffs the artifact against the live graph and
 * converges to zero ops on a re-file, so no client-side dedupe is needed. The
 * POST is NON-FATAL: a gateway/cell reject must never turn a good run into a 500
 * — exactly the posture of the fold block it replaces. Publication itself is
 * fail-closed: a rejected SHACL ingest does not fall through into the reserved
 * projection graph.
 *
 * The wire contract is the Rust route's typed inbox —
 * `garden-emporium-phase01/src-tauri/src/emporium/schemas.rs` (golden:
 * `minimal_workflow_json`, tests ~:251-332). Every emporium struct is
 * `#[serde(rename_all="camelCase")]` + `#[serde(default)]` and does NOT
 * `deny_unknown_fields`, so undeclared fields are silently dropped. The trap:
 * `RunIn` uses `startTimeMs`/`endTimeMs`, NOT `startedAt`/`endedAt` — a naive
 * `JSON.stringify(run)` would drop the times (no error) and lose
 * `prov:startedAtTime`/`endedAtTime`. `buildIngestRequest` RENAMES them.
 */

import type { RunRecord } from "./types.js";

// ─── Wire shapes (TS mirror of schemas.rs — camelCase as serialized) ─────────

/** Mirror of Rust `AgentTelemetryIn` (camelCase on the wire). */
export interface AgentTelemetryIn {
	label: string;
	phaseIndex: number;
	model: string;
	state: string;
	tokens: number;
	toolCalls: number;
	durationMs: number;
	queuedAt: number;
	startedAt: number;
	/** Hardcoded false: RunRecord carries no per-agent cached field. */
	cached: boolean;
	agentType?: string;
}

/**
 * Mirror of Rust `RunIn` (camelCase on the wire). NOTE the renamed time fields:
 * `startTimeMs` (= RunRecord.startedAt) and `endTimeMs` (= RunRecord.endedAt).
 */
export interface RunIn {
	runId: string;
	status: string;
	startTimeMs: number;
	endTimeMs: number;
	totalTokens: number;
	agentCount: number;
	durationMs: number;
	agents: AgentTelemetryIn[];
}

/**
 * Mirror of Rust `ParsedWorkflow` for the runs-ingest case: its OWN
 * `kind: "run-record"`, an empty anatomy (phases/nodes/edges), and the run
 * telemetry under `run`. `script` is empty (the def-mint owns the source);
 * `scriptSha256` is the sha of the compiled workflow source.
 */
export interface ParsedWorkflow {
	kind: "run-record";
	name: string;
	scriptSha256: string;
	script: string;
	phases: unknown[];
	nodes: unknown[];
	edges: unknown[];
	run: RunIn;
}

/** Mirror of Rust `IngestPayload::Workflow` (tagged on `kind`). */
export interface IngestPayloadWorkflow {
	kind: "workflow";
	parsed: ParsedWorkflow;
}

/** Mirror of Rust `IngestRequest` (top-level body). Carries NO graphId. */
export interface IngestRequest {
	vocab: "workflow";
	dry_run: boolean;
	payload: IngestPayloadWorkflow;
}

/** Generic projection record accepted by Rust `IngestPayload::Generic`. */
export type GenericProjectionRecord = {
	kind: string;
	localId: string;
	[key: string]: unknown;
};

export interface GenericIngestRequest {
	vocab: string;
	dry_run: boolean;
	replace_class?: boolean;
	payload: {
		kind: "generic";
		records: GenericProjectionRecord[];
	};
}

export type EmporiumIngestRequest = IngestRequest | GenericIngestRequest;

/**
 * Resolve the Emporium base URL for one workflow run.
 *
 * The explicit setting is an override for local/custom deployments. In hosted
 * cloud-2 mode the already-authorized gateway is the canonical ingest edge, so
 * service-auth enables Emporium automatically instead of relying on a second
 * opt-in environment variable that production can silently omit.
 */
export function resolveEmporiumIngestBaseUrl(
	gatewayBaseUrl: string | undefined,
	configuredBaseUrl: string | undefined = process.env.WORKFLOW_EMPORIUM_INGEST_URL,
): string | undefined {
	const configured = configuredBaseUrl?.trim();
	if (configured) return configured;
	const gateway = gatewayBaseUrl?.trim();
	return gateway || undefined;
}

// ─── Builder ─────────────────────────────────────────────────────────────────

/**
 * Map a finished `RunRecord` to the EXACT `IngestRequest` shape the emporium
 * route accepts. This is the silent-drop guard: it RENAMES `startedAt→startTimeMs`
 * and `endedAt→endTimeMs` on the run, sets every agent `cached:false`, and stamps
 * the two `kind` discriminators (`payload.kind:"workflow"`, `parsed.kind:"run-record"`).
 * Empty `phases`/`nodes`/`edges` — this is the runs-only client, not the def-mint.
 */
export function buildIngestRequest(run: RunRecord, scriptSha256: string): IngestRequest {
	const agents: AgentTelemetryIn[] = run.agents.map((a) => ({
		label: a.label,
		phaseIndex: a.phaseIndex,
		model: a.model,
		state: a.state,
		tokens: a.tokens,
		toolCalls: a.toolCalls,
		durationMs: a.durationMs,
		queuedAt: a.queuedAt,
		startedAt: a.startedAt,
		cached: false,
		...(a.agentType !== undefined ? { agentType: a.agentType } : {}),
	}));

	const runIn: RunIn = {
		runId: run.runId,
		status: run.status,
		// The rename trap: RunRecord.startedAt/endedAt → RunIn.startTimeMs/endTimeMs.
		startTimeMs: run.startedAt,
		endTimeMs: run.endedAt,
		totalTokens: run.totalTokens,
		agentCount: run.agentCount,
		durationMs: run.durationMs,
		agents,
	};

	return {
		vocab: "workflow",
		dry_run: false,
		payload: {
			kind: "workflow",
			parsed: {
				kind: "run-record",
				name: run.workflowName,
				scriptSha256,
				script: "",
				phases: [],
				nodes: [],
				edges: [],
				run: runIn,
			},
		},
	};
}

// ─── POST client ─────────────────────────────────────────────────────────────

/**
 * Auth for the ingest POST. Gateway mode reuses the MCP path's service-auth
 * (`MNEMOSYNE_SERVICE_TOKEN` as the bearer + `x-pn-on-behalf-of` for the acting
 * user). Local mode uses a loopback bearer. The mode also selects the URL shape.
 */
export type EmporiumIngestAuth =
	| {
			mode: "gateway";
			/** The gateway service token (sent as `Authorization: Bearer …`). */
			serviceToken: string;
			/** Acting end-user — `x-pn-on-behalf-of`. */
			onBehalfOf: string;
			/** Stable typed graph owner; defaults to the acting user. */
			ownerPrincipal?: string;
	  }
	| {
			mode: "local";
			/** Loopback bearer (omit for an unauthenticated local route). */
			bearer?: string;
	  };

export interface PostEmporiumIngestResult {
	ok: boolean;
	status?: number;
	/** Set when the POST failed (non-2xx or threw). Non-fatal — caller logs + continues. */
	error?: string;
	/** The response body text, when one was read. */
	body?: string;
}

/**
 * Build the ingest URL. Gateway mode routes through the canonical owner tuple
 * AND the route's own path param:
 * `{base}/o/{owner}/g/{graphId}/emporium/ingest/{graphId}`.
 * Local mode hits the route directly: `{base}/emporium/ingest/{graphId}`. The body
 * carries no graphId.
 */
export function emporiumIngestUrl(
	baseUrl: string,
	graphId: string,
	mode: "gateway" | "local",
	ownerPrincipal?: string,
): string {
	const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
	const g = encodeURIComponent(graphId);
	if (mode === "gateway") {
		if (!ownerPrincipal) throw new Error("gateway emporium ingest requires a typed graph owner");
		return `${base}/o/${encodeURIComponent(ownerPrincipal)}/g/${g}/emporium/ingest/${g}`;
	}
	return `${base}/emporium/ingest/${g}`;
}

/**
 * POST a built `IngestRequest` to the emporium ingest route. NON-FATAL by
 * contract: never throws — a transport/HTTP failure is returned as
 * `{ ok:false, error }` so the caller logs and continues (a rejected file must
 * not sink a good run). Idempotent on the server (planner diffs to zero ops).
 */
export async function postEmporiumIngest(
	baseUrl: string,
	graphId: string,
	body: EmporiumIngestRequest,
	auth: EmporiumIngestAuth,
	fetchFn: typeof fetch = fetch,
): Promise<PostEmporiumIngestResult> {
	const owner = auth.mode === "gateway" ? (auth.ownerPrincipal ?? `user:${auth.onBehalfOf}`) : undefined;
	const url = emporiumIngestUrl(baseUrl, graphId, auth.mode, owner);

	const headers: Record<string, string> = { "content-type": "application/json" };
	if (auth.mode === "gateway") {
		headers.Authorization = `Bearer ${auth.serviceToken}`;
		headers["x-pn-on-behalf-of"] = auth.onBehalfOf;
	} else if (auth.bearer) {
		headers.Authorization = `Bearer ${auth.bearer}`;
	}

	try {
		const res = await fetchFn(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		});
		const text = await res.text().catch(() => "");
		if (!res.ok) {
			return {
				ok: false,
				status: res.status,
				error: `ingest POST ${res.status}: ${text.slice(0, 400)}`,
				body: text,
			};
		}
		return { ok: true, status: res.status, body: text };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}
