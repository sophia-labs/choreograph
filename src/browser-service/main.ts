/**
 * garden-browser-service main entry point.
 *
 * Usage:
 *   node --import tsx/esm src/browser-service/main.ts
 *   # or after build:
 *   node dist/browser-service/main.js
 *
 * Environment variables:
 *   BROWSER_SERVICE_HOST   Bind host (default: 127.0.0.1)
 *   BROWSER_SERVICE_PORT   Bind port (default: 7771)
 */

import { BrowserEngineRegistry } from "./engine-registry.js";
import { startServer } from "./server.js";
import { SessionManager } from "./sessions.js";

async function main() {
	console.log("[browser-service] Starting browser engines...");
	const engines = await BrowserEngineRegistry.createFromEnvironment();
	const sessions = new SessionManager(engines);

	const server = await startServer(engines, sessions);

	async function shutdown(signal: string) {
		console.log(`[browser-service] ${signal} received — shutting down`);
		server.close();
		await sessions.closeAll();
		await engines.close();
		console.log("[browser-service] Clean exit");
		process.exit(0);
	}

	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((e) => {
	console.error("[browser-service] Fatal startup error:", e);
	process.exit(1);
});
