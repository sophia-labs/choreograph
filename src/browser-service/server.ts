/**
 * garden-browser-service HTTP server.
 *
 * Plain HTTP (no TLS — TLS terminates at the ALB / nginx reverse proxy on the host).
 * Binds to localhost only (configurable via BROWSER_SERVICE_HOST / BROWSER_SERVICE_PORT).
 *
 * Routes:
 *   GET  /health                           → 200 { ok: true, stats }
 *   POST /sessions                         → 201 { sessionId }
 *   GET  /sessions                         → 200 [{ sessionId, boundOrigin, createdAt }]
 *   DELETE /sessions/:id                   → 204
 *   POST /sessions/:id/navigate            → 200 { url }
 *   POST /sessions/:id/read_a11y_tree      → 200 { snapshot, refs }
 *   POST /sessions/:id/act                 → 200 { changed, snapshot, refs }
 *   POST /sessions/:id/screenshot          → 200 { data: base64, mimeType }
 *
 * Auth: raw secrets are never returned. The storageStateRef is consumed server-side
 * at context-mint time; it is never echoed back to callers.
 *
 * The service is intentionally simple — no frameworks, just node:http. This keeps
 * the binary footprint small and the startup time fast (<100ms).
 */

import { createHash } from "node:crypto";
import { readFile, unlink } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { captureSnapshot, performAct, takeScreenshot } from "./a11y.js";
import { clampUrl, OriginClampError } from "./origin-clamp.js";
import type { SessionManager } from "./sessions.js";
import type { ActRequest, CreateSessionRequest, NavigateRequest } from "./types.js";

const HOST = process.env.BROWSER_SERVICE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.BROWSER_SERVICE_PORT ?? 7771);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readBody(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
		});
		req.on("end", () => {
			try {
				resolve(data ? JSON.parse(data) : {});
			} catch (e) {
				reject(e);
			}
		});
		req.on("error", reject);
	});
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
	const json = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(json),
	});
	res.end(json);
}

function err(res: http.ServerResponse, status: number, message: string): void {
	send(res, status, { error: message });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface BrowserFleetHealth {
	stats(): unknown;
}

export function createRouter(sessions: SessionManager, fleet: BrowserFleetHealth) {
	return async function router(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const method = req.method ?? "GET";
		const url = req.url ?? "/";
		// Strip query string
		const path = url.split("?")[0];

		try {
			// GET /health
			if (method === "GET" && path === "/health") {
				send(res, 200, { ok: true, stats: fleet.stats() });
				return;
			}

			// POST /sessions
			if (method === "POST" && path === "/sessions") {
				const body = (await readBody(req)) as CreateSessionRequest;
				const record = await sessions.createSession({
					engine: body.engine,
					storageStateRef: body.storageStateRef,
					boundOrigin: body.boundOrigin,
				});
				send(res, 201, {
					sessionId: record.sessionId,
					engine: record.engine,
					browserVersion: record.browserVersion,
					viewportPinned: record.viewportPinned,
				});
				return;
			}

			// GET /sessions
			if (method === "GET" && path === "/sessions") {
				const list = sessions.list().map((r) => ({
					sessionId: r.sessionId,
					engine: r.engine,
					browserVersion: r.browserVersion,
					boundOrigin: r.boundOrigin,
					createdAt: r.createdAt,
				}));
				send(res, 200, list);
				return;
			}

			// DELETE /sessions/:id
			const deleteMatch = /^\/sessions\/([^/]+)$/.exec(path);
			if (method === "DELETE" && deleteMatch) {
				const sessionId = deleteMatch[1];
				await sessions.closeSession(sessionId);
				res.writeHead(204);
				res.end();
				return;
			}

			// Session-scoped routes: /sessions/:id/<action>
			const sessionMatch = /^\/sessions\/([^/]+)\/(.+)$/.exec(path);
			if (sessionMatch) {
				const [, sessionId, action] = sessionMatch;
				const session = sessions.get(sessionId);
				if (!session) {
					err(res, 404, `Session not found: ${sessionId}`);
					return;
				}

				// POST /sessions/:id/navigate
				if (method === "POST" && action === "navigate") {
					const body = (await readBody(req)) as NavigateRequest;
					const { page, boundOrigin } = session;

					switch (body.action) {
						case "url": {
							if (!body.url) {
								err(res, 400, "url required for action=url");
								return;
							}
							let targetUrl = body.url;
							if (boundOrigin) {
								try {
									targetUrl = clampUrl(body.url, boundOrigin);
								} catch (e) {
									if (e instanceof OriginClampError) {
										err(res, 403, e.message);
										return;
									}
									throw e;
								}
							}
							await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
							send(res, 200, { url: page.url() });
							return;
						}
						case "back":
							await page.goBack({ waitUntil: "domcontentloaded" });
							send(res, 200, { url: page.url() });
							return;
						case "forward":
							await page.goForward({ waitUntil: "domcontentloaded" });
							send(res, 200, { url: page.url() });
							return;
						case "reload":
							await page.reload({ waitUntil: "domcontentloaded" });
							send(res, 200, { url: page.url() });
							return;
						default:
							err(res, 400, `Unknown navigation action: ${(body as { action: unknown }).action}`);
							return;
					}
				}

				// POST /sessions/:id/read_a11y_tree
				if (method === "POST" && action === "read_a11y_tree") {
					const result = await captureSnapshot(session);
					send(res, 200, { ...result, engine: session.engine, browserVersion: session.browserVersion });
					return;
				}

				// POST /sessions/:id/act
				if (method === "POST" && action === "act") {
					const body = (await readBody(req)) as ActRequest;
					if (!body.ref || !body.action) {
						err(res, 400, "ref and action required");
						return;
					}
					const result = await performAct(session, body.ref, body.action, body.value, body.delayMs);
					send(res, 200, { ...result, engine: session.engine, browserVersion: session.browserVersion });
					return;
				}

				// POST /sessions/:id/screenshot
				if (method === "POST" && action === "screenshot") {
					const body = (await readBody(req).catch(() => ({}))) as { ref?: string };
					const png = await takeScreenshot(session.page, session, body.ref);
					send(res, 200, {
						data: png.toString("base64"),
						mimeType: "image/png",
						engine: session.engine,
						browserVersion: session.browserVersion,
					});
					return;
				}

				// POST /sessions/:id/probe — fixed L0 diagnostics, never arbitrary JS.
				if (method === "POST" && action === "probe") {
					const body = (await readBody(req).catch(() => ({}))) as { reset?: boolean };
					const probe = await session.page.evaluate<{
						title: string;
						readyState: string;
						contentType: string;
						bodyText: string;
						viewport: { width: number; height: number } | null;
						activeElement: {
							tag: string;
							role: string | null;
							id: string | null;
							ariaLabel: string | null;
						} | null;
						selection: { type: string; anchorOffset: number; focusOffset: number; text: string } | null;
						unhandledRejections: string[];
						layoutShifts: Array<{ value: number; hadRecentInput: boolean; startTime: number }>;
						mutations: { total: number; added: number; removed: number; attributes: number };
					}>(`(() => {
						const state = globalThis.__sophiaL0 || { mutations: { total: 0, added: 0, removed: 0, attributes: 0 }, layoutShifts: [], unhandledRejections: [] };
						const active = document.activeElement;
						const selection = globalThis.getSelection?.();
						const result = {
						title: document.title,
						readyState: document.readyState,
						contentType: document.contentType,
						bodyText: document.body?.innerText ?? "",
						viewport: typeof window.innerWidth === "number" && typeof window.innerHeight === "number"
							? { width: window.innerWidth, height: window.innerHeight }
							: null,
						activeElement: active ? { tag: active.tagName.toLowerCase(), role: active.getAttribute("role"), id: active.id || null, ariaLabel: active.getAttribute("aria-label") } : null,
						selection: selection ? { type: selection.type, anchorOffset: selection.anchorOffset, focusOffset: selection.focusOffset, text: selection.toString().slice(0, 4096) } : null,
						unhandledRejections: [...state.unhandledRejections],
						layoutShifts: [...state.layoutShifts],
						mutations: { ...state.mutations },
					};
						if (${body.reset === true ? "true" : "false"}) {
							state.unhandledRejections.length = 0;
							state.layoutShifts.length = 0;
							state.mutations = { total: 0, added: 0, removed: 0, attributes: 0 };
						}
						return result;
					})()`);
					const consoleErrors = [...session.consoleErrors];
					const pageErrors = [...session.pageErrors];
					if (body.reset === true) {
						session.consoleErrors.length = 0;
						session.pageErrors.length = 0;
					}
					send(res, 200, {
						engine: session.engine,
						browserVersion: session.browserVersion,
						url: session.page.url(),
						title: probe.title,
						readyState: probe.readyState,
						contentType: probe.contentType,
						viewport: probe.viewport,
						bodyTextSha256: createHash("sha256").update(probe.bodyText).digest("hex"),
						activeElement: probe.activeElement,
						selection: probe.selection
							? {
									...probe.selection,
									text: undefined,
									textSha256: createHash("sha256").update(probe.selection.text).digest("hex"),
								}
							: null,
						consoleErrors,
						pageErrors,
						unhandledRejections: probe.unhandledRejections,
						layoutShifts: probe.layoutShifts,
						mutations: probe.mutations,
					});
					return;
				}

				// POST /sessions/:id/trace — close one trace chunk and immediately
				// begin the next so every beat gets an independently addressable zip.
				if (method === "POST" && action === "trace") {
					const tracePath = nodePath.join(
						tmpdir(),
						`sophia-trace-${session.sessionId}-${session.traceChunk++}.zip`,
					);
					await session.context.tracing.stopChunk({ path: tracePath });
					const trace = await readFile(tracePath);
					await unlink(tracePath).catch(() => {});
					await session.context.tracing.startChunk();
					send(res, 200, {
						data: trace.toString("base64"),
						mimeType: "application/zip",
						engine: session.engine,
						browserVersion: session.browserVersion,
					});
					return;
				}

				err(res, 404, `Unknown action: ${action}`);
				return;
			}

			err(res, 404, "Not found");
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			console.error("[browser-service] Unhandled error:", e);
			const status = typeof e === "object" && e !== null && (e as { status?: unknown }).status === 503 ? 503 : 500;
			err(res, status, message);
		}
	};
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

export async function startServer(fleet: BrowserFleetHealth, sessions: SessionManager): Promise<http.Server> {
	const router = createRouter(sessions, fleet);
	const server = http.createServer((req, res) => {
		router(req, res).catch((e) => {
			console.error("[browser-service] Fatal router error:", e);
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "application/json" });
			}
			res.end(JSON.stringify({ error: "Internal server error" }));
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.listen(PORT, HOST, () => resolve());
		server.once("error", reject);
	});

	console.log(`[browser-service] Listening on http://${HOST}:${PORT}`);
	return server;
}
