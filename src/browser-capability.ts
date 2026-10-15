/**
 * subject.web CapabilityBackend — HTTP client to the garden-browser-service.
 *
 * The browser-service API contract (from ground facts):
 *
 *   POST   /sessions            { storageStateRef?, boundOrigin? } → 201 { sessionId }
 *   GET    /sessions            → 200 [{ sessionId, boundOrigin, createdAt }]
 *   DELETE /sessions/:id        → 204
 *   POST   /sessions/:id/navigate   { action, url? } → 200 { url }
 *   POST   /sessions/:id/read_a11y_tree  → 200 { snapshot, refs }
 *   POST   /sessions/:id/act    { ref, action, value? } → 200 { changed, snapshot, refs }
 *   POST   /sessions/:id/screenshot  { ref? } → 200 { data (base64 PNG), mimeType }
 *   GET    /health              → 200 { ok, stats }
 *
 * The orchestrator mints a browser session at capability-bind time, injects
 * storageState + boundOrigin (the agent never sees session_id or secrets),
 * forwards tool calls, and reaps the session at agent end (close()).
 *
 * Tools surfaced to the agent:
 *   navigate        { action, url? }
 *   read_a11y_tree  (no required args)
 *   act             { ref, action, value? }
 *   screenshot      { ref? }
 *
 * The session_id is kept in the backend and NEVER forwarded to the agent.
 */

import type { BrowserEngine } from "./browser-service/types.js";
import type { EvidenceRef, EvidenceStore } from "./evidence-store.js";
import type { CapabilityBackend, HostedMcpToolDescriptor } from "./mnemosyne.js";

// ─── Browser-service HTTP types (mirrors ground-fact contract) ───────────

interface CreateSessionRequest {
	engine?: BrowserEngine;
	storageStateRef?: string;
	boundOrigin?: string;
}

interface CreateSessionResponse {
	sessionId: string;
	engine?: BrowserEngine;
	browserVersion?: string;
	/** False when the service minted unpinned after an engine refused the E0.2 viewport pin. */
	viewportPinned?: boolean;
}

interface NavigateRequest {
	action: "url" | "back" | "forward" | "reload";
	url?: string;
}

interface NavigateResponse {
	url: string;
}

interface A11yTreeResponse {
	snapshot: string;
	refs: Record<string, string>;
}

interface ActRequest {
	ref: string;
	action: "click" | "type" | "select" | "press";
	value?: string;
	delayMs?: number;
}

interface ActResponse {
	changed: boolean;
	snapshot: string;
	refs: Record<string, string>;
}

interface ScreenshotRequest {
	ref?: string;
}

interface ScreenshotResponse {
	data: string; // base64 PNG
	mimeType: "image/png";
	engine: BrowserEngine;
	browserVersion: string;
}

interface BrowserProbeResponse {
	engine: BrowserEngine;
	browserVersion: string;
	url: string;
	title: string;
	readyState: string;
	contentType: string;
	viewport: { width: number; height: number } | null;
	bodyTextSha256: string;
	activeElement: unknown;
	selection: unknown;
	consoleErrors: string[];
	pageErrors: string[];
	unhandledRejections: string[];
	layoutShifts: Array<{ value: number; hadRecentInput: boolean; startTime: number }>;
	mutations: { total: number; added: number; removed: number; attributes: number };
}

interface BinaryEvidenceResponse {
	data: string;
	mimeType: "image/png" | "application/zip";
	engine: BrowserEngine;
	browserVersion: string;
}

export interface BrowserEvidenceContext {
	readonly runId?: string;
	readonly scenarioId?: string;
}

// ─── Tool descriptors ────────────────────────────────────────────────────

const BROWSER_TOOLS: readonly HostedMcpToolDescriptor[] = [
	{
		name: "navigate",
		destructive: false,
		description: "Navigate the browser: load a URL, go back/forward, or reload the current page.",
		inputSchema: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: ["url", "back", "forward", "reload"],
					description: "Navigation action to perform.",
				},
				url: {
					type: "string",
					description: "URL to navigate to (required when action='url').",
				},
			},
			required: ["action"],
		},
	},
	{
		name: "read_a11y_tree",
		destructive: false,
		description:
			"Capture the accessibility tree of the current page as a YAML snapshot with opaque ref tokens for interactive elements.",
		inputSchema: {
			type: "object",
			properties: {},
		},
	},
	{
		name: "act",
		destructive: true,
		description: "Perform an action on an interactive element identified by a ref token from read_a11y_tree.",
		inputSchema: {
			type: "object",
			properties: {
				ref: {
					type: "string",
					description: "Opaque ref token returned by read_a11y_tree.",
				},
				action: {
					type: "string",
					enum: ["click", "type", "select", "press"],
					description: "Action to perform on the element.",
				},
				value: {
					type: "string",
					description: "Value for type/select/press actions.",
				},
				delayMs: {
					type: "number",
					description: "Optional 0..250ms per-character cadence for human-shaped typing.",
				},
			},
			required: ["ref", "action"],
		},
	},
	{
		name: "screenshot",
		destructive: false,
		description: "Capture a screenshot of the current page or a specific element.",
		inputSchema: {
			type: "object",
			properties: {
				ref: {
					type: "string",
					description: "Optional ref token to screenshot a specific element; omit for full page.",
				},
			},
		},
	},
	{
		name: "probe",
		destructive: false,
		description:
			"Capture fixed, content-minimized browser diagnostics: engine/version, URL, title, ready state, viewport, and a body-text digest.",
		inputSchema: { type: "object", properties: {} },
	},
	{
		name: "capture_beat",
		destructive: false,
		description:
			"Capture a thin-ref L0 evidence bundle for one scenario beat: screenshot, a11y tree, diagnostics, and Playwright trace.",
		inputSchema: {
			type: "object",
			properties: {
				runId: { type: "string" },
				scenarioId: { type: "string" },
				beatId: { type: "string" },
				ref: { type: "string" },
			},
			required: ["beatId"],
		},
	},
];

// ─── BrowserCapabilityBackend ────────────────────────────────────────────

export interface BrowserCapabilityOptions {
	/** Base URL of the garden-browser-service (e.g. http://127.0.0.1:7771). */
	serviceBaseUrl: string;
	/** Engine selected when the service mints the session. Defaults to Chromium. */
	engine?: BrowserEngine;
	/** Registry-facing capability name. Defaults to the legacy subject.web name. */
	capabilityName?: string;
	/** Playwright storageState JSON file path, consumed server-side (never echoed). */
	storageStateRef?: string;
	/** Origin whitelist (e.g. https://garden.example.invalid). */
	boundOrigin?: string;
	/** Access level for this capability binding (enforced at spawn). */
	accessLevel?: "ro" | "rw";
	/** Optional injectable fetch (for testing). */
	fetchFn?: typeof fetch;
	/** Host-owned evidence store; when set, fat browser payloads never cross the sandbox boundary. */
	evidenceStore?: EvidenceStore;
	evidenceContext?: BrowserEvidenceContext;
}

/**
 * CapabilityBackend for `subject.web`.
 *
 * Mints a browser session at construction (via `create()`), forwards tool
 * calls to the garden-browser-service, and reaps the session on `close()`.
 *
 * Do NOT call `callTool()` before `create()`.
 */
export class BrowserCapabilityBackend implements CapabilityBackend {
	readonly capabilityName: string;
	readonly accessLevel: "ro" | "rw";
	readonly engine: BrowserEngine;

	private readonly base: string;
	private readonly storageStateRef?: string;
	private readonly boundOrigin?: string;
	private readonly fetchFn: typeof fetch;
	private readonly evidenceStore?: EvidenceStore;
	private readonly evidenceContext: BrowserEvidenceContext;

	/** Set by create(), used for all subsequent requests. */
	private sessionId: string | undefined;
	/** Change-set 5: false when the service minted this session without the E0.2 viewport pin. */
	private viewportPinned = true;

	constructor(options: BrowserCapabilityOptions) {
		this.capabilityName = options.capabilityName ?? "subject.web";
		this.engine = options.engine ?? "chromium";
		this.base = trimTrailingSlash(options.serviceBaseUrl);
		this.storageStateRef = options.storageStateRef;
		this.boundOrigin = options.boundOrigin;
		this.accessLevel = options.accessLevel ?? "rw";
		this.fetchFn = options.fetchFn ?? fetch;
		this.evidenceStore = options.evidenceStore;
		this.evidenceContext = options.evidenceContext ?? {};
	}

	/**
	 * Mint a browser session.  Must be called once before `callTool()`.
	 * Returns the session-id for logging (never forwarded to the agent).
	 */
	async create(): Promise<{ sessionId: string; engine: BrowserEngine; browserVersion: string }> {
		const body: CreateSessionRequest = {};
		if (this.engine !== "chromium" || this.capabilityName.startsWith("browser.")) body.engine = this.engine;
		if (this.storageStateRef) body.storageStateRef = this.storageStateRef;
		if (this.boundOrigin) body.boundOrigin = this.boundOrigin;

		const resp = await this.doFetch<CreateSessionResponse>("POST", "/sessions", body);
		this.sessionId = resp.sessionId;
		this.viewportPinned = resp.viewportPinned ?? true;
		return {
			sessionId: resp.sessionId,
			engine: resp.engine ?? this.engine,
			browserVersion: resp.browserVersion ?? "unknown",
		};
	}

	async callTool(tool: string, args: Record<string, unknown>, _signal?: AbortSignal): Promise<unknown> {
		if (!this.sessionId) {
			throw new Error("BrowserCapabilityBackend: session not created — call create() first");
		}
		const id = this.sessionId;
		if (this.accessLevel === "ro" && tool === "act") {
			throw new BrowserCapabilityDeniedError("Read-only browser capability cannot perform page actions");
		}

		switch (tool) {
			case "navigate": {
				const req = args as NavigateRequest;
				return this.doFetch<NavigateResponse>("POST", `/sessions/${id}/navigate`, req);
			}
			case "read_a11y_tree": {
				return this.doFetch<A11yTreeResponse>("POST", `/sessions/${id}/read_a11y_tree`, {});
			}
			case "act": {
				const req = args as ActRequest;
				return this.doFetch<ActResponse>("POST", `/sessions/${id}/act`, req);
			}
			case "screenshot": {
				const req = args as ScreenshotRequest;
				const result = await this.doFetch<ScreenshotResponse>("POST", `/sessions/${id}/screenshot`, req);
				if (!this.evidenceStore) return result;
				const location = this.evidenceLocation(args);
				return this.storeBinary(location, "screenshot", "png", result.mimeType, result.data);
			}
			case "probe": {
				return this.doFetch<BrowserProbeResponse>("POST", `/sessions/${id}/probe`, {});
			}
			case "capture_beat":
				return this.captureBeat(id, args);
			default:
				throw new Error(`${this.capabilityName}: unknown tool "${tool}"`);
		}
	}

	private async captureBeat(sessionId: string, args: Record<string, unknown>): Promise<unknown> {
		if (!this.evidenceStore) throw new Error(`${this.capabilityName}: CHOREOGRAPH_EVIDENCE_S3_URL is required`);
		const location = this.evidenceLocation(args);
		const screenshot = await this.doFetch<ScreenshotResponse>("POST", `/sessions/${sessionId}/screenshot`, {
			...(typeof args.ref === "string" ? { ref: args.ref } : {}),
		});
		const a11y = await this.doFetch<A11yTreeResponse>("POST", `/sessions/${sessionId}/read_a11y_tree`, {});
		const probe = await this.doFetch<BrowserProbeResponse>("POST", `/sessions/${sessionId}/probe`, { reset: true });
		const trace = await this.doFetch<BinaryEvidenceResponse>("POST", `/sessions/${sessionId}/trace`, {});

		const [screenshotRef, a11yRef, probeRef, traceRef] = await Promise.all([
			this.storeBinary(location, "screenshot", "png", screenshot.mimeType, screenshot.data),
			this.evidenceStore.put(location, "a11y", "yaml", "application/yaml", a11y.snapshot),
			this.evidenceStore.put(location, "probe", "json", "application/json", `${JSON.stringify(probe)}\n`),
			this.storeBinary(location, "trace", "zip", trace.mimeType, trace.data),
		]);
		const manifest = {
			schema: "sophia.browser-evidence-beat.v1",
			engine: this.engine,
			browserVersion: screenshot.browserVersion,
			// Change-set 5: false when this session minted without the E0.2
			// viewport pin (engine refused it) — dimension mismatches in
			// cross-engine diffs are then a KNOWN caveat, not a finding.
			viewportPinned: this.viewportPinned,
			runId: location[0],
			scenarioId: location[1],
			beatId: location[2],
			evidence: { screenshot: screenshotRef, a11y: a11yRef, probe: probeRef, trace: traceRef },
		};
		const manifestRef = await this.evidenceStore.put(
			location,
			"manifest",
			"json",
			"application/json",
			`${JSON.stringify(manifest)}\n`,
		);
		return { ...manifest, manifest: manifestRef };
	}

	private evidenceLocation(args: Record<string, unknown>): [string, string, string, BrowserEngine] {
		const runId = requiredEvidenceId(args.runId ?? this.evidenceContext.runId, "runId");
		const scenarioId = requiredEvidenceId(args.scenarioId ?? this.evidenceContext.scenarioId, "scenarioId");
		const beatId = requiredEvidenceId(args.beatId, "beatId");
		return [runId, scenarioId, beatId, this.engine];
	}

	private async storeBinary(
		location: readonly string[],
		kind: string,
		extension: string,
		mediaType: string,
		base64: string,
	): Promise<EvidenceRef> {
		if (!this.evidenceStore) throw new Error("browser evidence store is unavailable");
		return this.evidenceStore.put(location, kind, extension, mediaType, Buffer.from(base64, "base64"));
	}

	async listTools(): Promise<readonly HostedMcpToolDescriptor[]> {
		return this.accessLevel === "ro" ? BROWSER_TOOLS.filter((tool) => tool.name !== "act") : BROWSER_TOOLS;
	}

	async close(): Promise<void> {
		const id = this.sessionId;
		if (!id) return;
		this.sessionId = undefined;
		try {
			await this.doFetch<void>("DELETE", `/sessions/${id}`);
		} catch {
			// Best-effort: don't let session cleanup throw
		}
	}

	private async doFetch<T>(method: string, path: string, body?: unknown): Promise<T> {
		const url = `${this.base}${path}`;
		const init: RequestInit = {
			method,
			headers: { "content-type": "application/json" },
		};
		if (body !== undefined && method !== "DELETE") {
			init.body = JSON.stringify(body);
		}

		const response = await this.fetchFn(url, init);

		// DELETE /sessions/:id returns 204 with no body
		if (response.status === 204) {
			return undefined as T;
		}

		const text = await response.text();
		if (!response.ok) {
			let detail = text;
			try {
				const parsed = JSON.parse(text) as { error?: string };
				detail = parsed.error ?? text;
			} catch {
				// keep raw text
			}
			throw new BrowserServiceError(
				response.status,
				`browser-service ${method} ${path}: ${response.status} ${detail}`,
			);
		}
		if (!text) return undefined as T;
		return JSON.parse(text) as T;
	}
}

export class BrowserCapabilityDeniedError extends Error {
	readonly code = "capability_denied";
	readonly status = 403;

	constructor(message: string) {
		super(message);
		this.name = "BrowserCapabilityDeniedError";
	}
}

export class BrowserServiceError extends Error {
	readonly code: "capability_denied" | "browser_service_error";
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "BrowserServiceError";
		this.code = status === 401 || status === 403 ? "capability_denied" : "browser_service_error";
	}
}

/**
 * Resolve the browser-service base URL from options or environment.
 * Falls back to the default localhost bind (127.0.0.1:7771).
 */
export function resolveBrowserServiceUrl(override?: string): string {
	if (override) return override;
	const host = process.env.BROWSER_SERVICE_HOST ?? "127.0.0.1";
	const port = process.env.BROWSER_SERVICE_PORT ?? "7771";
	return `http://${host}:${port}`;
}

function trimTrailingSlash(value: string): string {
	return value.endsWith("/") ? value.slice(0, -1) : value;
}

function requiredEvidenceId(value: unknown, name: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
		throw new Error(`${name} is required and must be an opaque evidence identifier`);
	}
	return value;
}
