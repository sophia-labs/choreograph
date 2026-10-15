/**
 * SSE transport — bridges the SandboxEventBus to HTTP ServerResponse objects.
 *
 * Formats BusEvents as SSE wire protocol, manages heartbeats to keep
 * connections alive through proxies, and handles backpressure by dropping
 * events when the client can't keep up.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { BusEvent, SandboxEventBus } from "./event-bus.js";
import {
	sseConnectionDurationSeconds,
	sseConnectionsActive,
	sseConnectionsTotal,
	sseDroppedEventsTotal,
	sseEventsTotal,
} from "./metrics.js";

const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Start an SSE stream for a sandbox. Sets headers, subscribes to the bus,
 * and streams events until the sandbox reaches terminal state or the
 * client disconnects.
 */
export function startSseStream(
	request: IncomingMessage,
	response: ServerResponse,
	bus: SandboxEventBus,
	sandboxId: string,
): void {
	const startTime = performance.now();

	// SSE headers
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache, no-transform",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});

	// Preamble — flush headers through proxies
	response.write(":ok\n\n");

	sseConnectionsTotal.add(1, { sandbox_id: sandboxId });
	sseConnectionsActive.add(1, { sandbox_id: sandboxId });

	let closed = false;

	function cleanup() {
		if (closed) return;
		closed = true;
		clearInterval(heartbeat);
		unsubscribe();
		sseConnectionsActive.add(-1, { sandbox_id: sandboxId });
		sseConnectionDurationSeconds.record((performance.now() - startTime) / 1000, { sandbox_id: sandboxId });
	}

	// Heartbeat to prevent proxy/ALB idle timeout
	const heartbeat = setInterval(() => {
		if (!closed) {
			response.write(":keepalive\n\n");
		}
	}, HEARTBEAT_INTERVAL_MS);

	// Subscribe to bus
	const unsubscribe = bus.subscribe(
		(event) => {
			if (closed) return;

			// Backpressure: drop if socket buffer is full
			if (response.writableNeedDrain) {
				sseDroppedEventsTotal.add(1, {
					sandbox_id: sandboxId,
					category: event.category,
				});
				return;
			}

			writeSseEvent(response, event);
			sseEventsTotal.add(1, {
				sandbox_id: sandboxId,
				category: event.category,
				type: event.type,
			});

			// Close after terminal lifecycle event
			if (event.category === "lifecycle" && event.type === "terminal") {
				// Small delay to ensure the event is flushed
				setTimeout(() => {
					if (!closed) {
						response.end();
						cleanup();
					}
				}, 100);
			}
		},
		{ sandbox_id: sandboxId },
	);

	// Client disconnect
	request.on("close", cleanup);
}

function writeSseEvent(response: ServerResponse, event: BusEvent): void {
	const eventType = `${event.category}:${event.type}`;
	const data = JSON.stringify(event);
	response.write(`event: ${eventType}\nid: ${event.ts}\ndata: ${data}\n\n`);
}
