/**
 * Shared types for the garden-browser-service.
 *
 * A "session" is one BrowserContext inside a pooled browser process. Engine
 * identity is carried on every session and evidence response so cross-engine
 * results cannot be conflated.
 */

/**
 * Browser engine names. Only Chromium runs. "camoufox" is a retired engine
 * (removed 2026-10-13): the name stays so stored capability descriptors and
 * testimony that carry it still parse, and a request for it answers 503.
 */
export type BrowserEngine = "chromium" | "camoufox";
export const RETIRED_BROWSER_ENGINE_REASON = "retired: the Camoufox engine was removed from this build (2026-10-13)";

export interface BrowserProcessHandle {
	/** Playwright Browser instance */
	browser: import("playwright").Browser;
	engine: BrowserEngine;
	browserVersion: string;
	/** Monotonically incrementing ID for diagnostics */
	id: number;
	/** When this process was launched */
	launchedAt: number;
	/** How many contexts have been created in this process (ever) */
	totalContexts: number;
	/** How many contexts are currently open */
	activeContexts: number;
}

export interface SessionRecord {
	sessionId: string;
	context: import("playwright").BrowserContext;
	page: import("playwright").Page;
	/** The process this context lives in */
	processHandle: BrowserProcessHandle;
	engine: BrowserEngine;
	browserVersion: string;
	/** If provided, navigation is clamped to this origin */
	boundOrigin: string | null;
	createdAt: number;
	/** Snapshot-epoch refs: invalidated whenever the DOM changes */
	lastSnapshotRefs: Map<string, import("playwright").Locator>;
	/** Bounded diagnostics accumulated outside the page realm. */
	consoleErrors: string[];
	pageErrors: string[];
	traceChunk: number;
	/**
	 * Whether the E0.2 pinned viewport was accepted at context mint. Some
	 * engine variants (live: chromium-headless-shell) refuse the pin at
	 * protocol level; the session then mints unpinned and this flag makes the
	 * caveat visible to every downstream dimension consumer.
	 */
	viewportPinned: boolean;
}

/** POST /sessions request body */
export interface CreateSessionRequest {
	/** Browser engine. Defaults to Chromium for backward compatibility. */
	engine?: BrowserEngine;
	/**
	 * Filesystem path (or SSM-resolved path) to a Playwright storageState JSON.
	 * When provided the context is pre-authenticated with those cookies/localStorage.
	 */
	storageStateRef?: string;
	/** Origin the session is allowed to navigate to (e.g. "https://garden.example.invalid") */
	boundOrigin?: string;
}

/** POST /sessions response */
export interface CreateSessionResponse {
	sessionId: string;
	engine: BrowserEngine;
	browserVersion: string;
}

/** GET /sessions response */
export interface SessionListResponse {
	sessions: Array<{
		sessionId: string;
		engine: BrowserEngine;
		browserVersion: string;
		boundOrigin: string | null;
		createdAt: number;
	}>;
}

/** POST /sessions/:id/navigate request */
export interface NavigateRequest {
	action: "url" | "back" | "forward" | "reload";
	/** Required when action === "url" */
	url?: string;
}

/** a11y tree response */
export interface A11yTreeResponse {
	snapshot: string;
	/** Opaque ref tokens keyed by a stable label; used in act requests */
	refs: Record<string, string>;
}

/** POST /sessions/:id/act request */
export interface ActRequest {
	/** Ref token returned by read_a11y_tree */
	ref: string;
	action: "click" | "type" | "select" | "press";
	/** Required for type/select/press */
	value?: string;
	/** Per-character cadence for human-shaped typing, clamped to 0..250ms. */
	delayMs?: number;
}

/** POST /sessions/:id/act response */
export interface ActResponse {
	changed: boolean;
	snapshot: string;
	refs: Record<string, string>;
}

/** POST /sessions/:id/screenshot response (PNG base64) */
export interface ScreenshotResponse {
	data: string;
	mimeType: "image/png";
	engine: BrowserEngine;
	browserVersion: string;
}

/** Fixed, non-scriptable browser probe used as compact L0 evidence. */
export interface BrowserProbeResponse {
	engine: BrowserEngine;
	browserVersion: string;
	url: string;
	title: string;
	readyState: string;
	contentType: string;
	viewport: { width: number; height: number } | null;
	bodyTextSha256: string;
	activeElement: {
		tag: string;
		role: string | null;
		id: string | null;
		ariaLabel: string | null;
	} | null;
	selection: {
		type: string;
		anchorOffset: number;
		focusOffset: number;
		textSha256: string;
	} | null;
	consoleErrors: string[];
	pageErrors: string[];
	unhandledRejections: string[];
	layoutShifts: Array<{ value: number; hadRecentInput: boolean; startTime: number }>;
	mutations: { total: number; added: number; removed: number; attributes: number };
}

/** Internal pool stats */
export interface PoolStats {
	engine: BrowserEngine;
	processes: number;
	activeSessions: number;
	totalSessionsServed: number;
}

export interface BrowserPoolContract {
	readonly engine: BrowserEngine;
	acquireProcess(): Promise<BrowserProcessHandle>;
	releaseProcess(handle: BrowserProcessHandle): Promise<void>;
	close(): Promise<void>;
	stats(): PoolStats;
}
