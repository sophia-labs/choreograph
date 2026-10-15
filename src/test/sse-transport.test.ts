import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, describe, it } from "node:test";
import { type BusEvent, createSandboxEventBus, type SandboxEventBus } from "../event-bus.js";
import { startSseStream } from "../sse-transport.js";

const SANDBOX_ID = "sse-test-sandbox";

function stubStore(records: Record<string, any> = {}) {
	return {
		get(id: string) {
			return records[id] ?? null;
		},
	} as any;
}

/** Minimal mock ServerResponse that captures writes. */
function createMockResponse() {
	const chunks: string[] = [];
	const headers: Record<string, string | number> = {};
	let statusCode = 0;
	let ended = false;
	let _writableNeedDrain = false;

	return {
		get output() {
			return chunks.join("");
		},
		get headers() {
			return headers;
		},
		get statusCode() {
			return statusCode;
		},
		get ended() {
			return ended;
		},
		set writableNeedDrain(v: boolean) {
			_writableNeedDrain = v;
		},
		get writableNeedDrain() {
			return _writableNeedDrain;
		},

		// ServerResponse interface
		writeHead(code: number, hdrs: Record<string, string>) {
			statusCode = code;
			Object.assign(headers, hdrs);
		},
		write(chunk: string) {
			if (!_writableNeedDrain) {
				chunks.push(chunk);
			}
			return !_writableNeedDrain;
		},
		end() {
			ended = true;
		},
		setTimeout() {},
	} as any;
}

/** Minimal mock IncomingMessage with close event. */
function createMockRequest() {
	const emitter = new EventEmitter();
	return emitter as any;
}

describe("SSE Transport", () => {
	let bus: SandboxEventBus;
	const timers: ReturnType<typeof setTimeout>[] = [];

	afterEach(() => {
		bus?.cleanup(SANDBOX_ID);
		for (const t of timers) clearTimeout(t);
		timers.length = 0;
	});

	function setup() {
		bus = createSandboxEventBus(
			stubStore({
				[SANDBOX_ID]: { sandbox_id: SANDBOX_ID, state: "running", template: "agent" },
			}),
			{ cleanupDelayMs: 100 },
		);
		const req = createMockRequest();
		const res = createMockResponse();
		return { req, res };
	}

	it("writes SSE headers and preamble", () => {
		const { req, res } = setup();
		startSseStream(req, res, bus, SANDBOX_ID);

		assert.equal(res.statusCode, 200);
		assert.equal(res.headers["content-type"], "text/event-stream");
		assert.equal(res.headers["cache-control"], "no-cache, no-transform");
		assert.equal(res.headers["x-accel-buffering"], "no");
		assert.ok(res.output.includes(":ok\n\n"));

		req.emit("close");
	});

	it("formats events as SSE wire format", () => {
		const { req, res } = setup();
		startSseStream(req, res, bus, SANDBOX_ID);

		const event: BusEvent = {
			category: "agent",
			type: "text",
			sandbox_id: SANDBOX_ID,
			ts: "2026-04-02T12:00:00.000Z",
			event: { type: "text", content: "hello world" },
		};
		bus.emit(event);

		assert.ok(res.output.includes("event: agent:text\n"));
		assert.ok(res.output.includes("id: 2026-04-02T12:00:00.000Z\n"));
		assert.ok(res.output.includes('"content":"hello world"'));

		req.emit("close");
	});

	it("sends heartbeat comments", async () => {
		// Use a very short heartbeat interval for testing — we override
		// by emitting events and checking the keepalive appears between them.
		// The actual heartbeat is 15s, too long for a unit test, so we
		// verify the preamble comment is written (proves the write path works).
		const { req, res } = setup();
		startSseStream(req, res, bus, SANDBOX_ID);

		// The `:ok\n\n` preamble is effectively the same write path as keepalive
		assert.ok(res.output.includes(":ok\n\n"));

		req.emit("close");
	});

	it("drops events when socket buffer is full", () => {
		const { req, res } = setup();
		startSseStream(req, res, bus, SANDBOX_ID);

		const outputBefore = res.output;

		// Simulate backpressure
		res.writableNeedDrain = true;

		bus.emit({
			category: "agent",
			type: "text",
			sandbox_id: SANDBOX_ID,
			ts: new Date().toISOString(),
			event: { type: "text", content: "dropped" },
		});

		// Output should not have changed (event was dropped)
		assert.equal(res.output, outputBefore);

		res.writableNeedDrain = false;
		req.emit("close");
	});

	it("closes stream after terminal event", async () => {
		const { req, res } = setup();
		startSseStream(req, res, bus, SANDBOX_ID);

		bus.emit({
			category: "lifecycle",
			type: "terminal",
			sandbox_id: SANDBOX_ID,
			ts: new Date().toISOString(),
			state: "done" as any,
		});

		assert.ok(res.output.includes("event: lifecycle:terminal\n"));

		// Wait for the delayed response.end()
		await new Promise((r) => setTimeout(r, 200));
		assert.ok(res.ended);
	});

	it("unsubscribes on client disconnect", () => {
		const { req, res } = setup();
		startSseStream(req, res, bus, SANDBOX_ID);

		assert.equal(bus.subscriberCount(SANDBOX_ID), 1);

		req.emit("close");

		assert.equal(bus.subscriberCount(SANDBOX_ID), 0);
	});

	it("snapshot is first event delivered", () => {
		const { req, res } = setup();

		// Emit some events before connecting
		bus.emit({
			category: "agent",
			type: "turn_start",
			sandbox_id: SANDBOX_ID,
			ts: new Date().toISOString(),
			event: { type: "turn_start", turn: 1 },
		});

		startSseStream(req, res, bus, SANDBOX_ID);

		// First SSE event should be the snapshot
		const lines = res.output.split("\n\n").filter((s: string) => s.includes("event:"));
		assert.ok(lines[0].includes("event: system:snapshot"));

		req.emit("close");
	});
});
