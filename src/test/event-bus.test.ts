import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { type BusEvent, createSandboxEventBus, type SandboxEventBus } from "../event-bus.js";

// Minimal SandboxStore stub — only get() is used by the bus
function stubStore(records: Record<string, any> = {}) {
	return {
		get(id: string) {
			return records[id] ?? null;
		},
	} as any;
}

function makeLifecycleEvent(
	sandboxId: string,
	type: "queued" | "spawning" | "running" | "terminal",
	extra: Record<string, unknown> = {},
): BusEvent {
	const base = { sandbox_id: sandboxId, ts: new Date().toISOString() };
	switch (type) {
		case "queued":
			return {
				...base,
				category: "lifecycle",
				type: "queued",
				record: { sandbox_id: sandboxId, state: "queued" } as any,
				...extra,
			};
		case "spawning":
			return { ...base, category: "lifecycle", type: "spawning", ...extra };
		case "running":
			return { ...base, category: "lifecycle", type: "running", pid: 1234, ...extra };
		case "terminal":
			return { ...base, category: "lifecycle", type: "terminal", state: "done" as any, ...extra };
	}
}

function makeAgentEvent(sandboxId: string): BusEvent {
	return {
		category: "agent",
		type: "text",
		sandbox_id: sandboxId,
		ts: new Date().toISOString(),
		event: { type: "text", content: "hello" },
	};
}

describe("SandboxEventBus", () => {
	const SANDBOX_ID = "test-sandbox-001";
	let bus: SandboxEventBus;

	beforeEach(() => {
		bus = createSandboxEventBus(
			stubStore({
				[SANDBOX_ID]: { sandbox_id: SANDBOX_ID, state: "running", template: "agent" },
			}),
		);
	});

	it("emit delivers to subscribers", () => {
		const received: BusEvent[] = [];
		bus.subscribe((e) => received.push(e), { sandbox_id: SANDBOX_ID });

		const event = makeAgentEvent(SANDBOX_ID);
		bus.emit(event);

		// First event is the snapshot, second is our emitted event
		assert.equal(received.length, 2);
		assert.equal(received[1].category, "agent");
		assert.equal(received[1].type, "text");
	});

	it("does not deliver events for other sandboxes", () => {
		const received: BusEvent[] = [];
		bus.subscribe((e) => received.push(e), { sandbox_id: SANDBOX_ID });

		bus.emit(makeAgentEvent("other-sandbox"));

		// Only the snapshot for our sandbox
		assert.equal(received.length, 1);
		assert.equal(received[0].type, "snapshot");
	});

	it("unsubscribe stops delivery", () => {
		const received: BusEvent[] = [];
		const unsub = bus.subscribe((e) => received.push(e), { sandbox_id: SANDBOX_ID });

		unsub();
		bus.emit(makeAgentEvent(SANDBOX_ID));

		// Only the snapshot before unsubscribe
		assert.equal(received.length, 1);
	});

	it("late joiner gets snapshot with recentEvents", () => {
		// Emit 5 events before subscribing
		for (let i = 0; i < 5; i++) {
			bus.emit(makeAgentEvent(SANDBOX_ID));
		}

		const received: BusEvent[] = [];
		bus.subscribe((e) => received.push(e), { sandbox_id: SANDBOX_ID });

		// First event should be snapshot with recent_events
		assert.equal(received[0].category, "system");
		assert.equal(received[0].type, "snapshot");
		const snapshot = received[0] as Extract<BusEvent, { type: "snapshot" }>;
		assert.equal(snapshot.recent_events.length, 5);
	});

	it("replay buffer is bounded", () => {
		const bufferSize = 50;
		const bus = createSandboxEventBus(stubStore({ [SANDBOX_ID]: { sandbox_id: SANDBOX_ID, state: "running" } }), {
			replayBufferSize: bufferSize,
		});

		for (let i = 0; i < 100; i++) {
			bus.emit(makeAgentEvent(SANDBOX_ID));
		}

		const received: BusEvent[] = [];
		bus.subscribe((e) => received.push(e), { sandbox_id: SANDBOX_ID });

		const snapshot = received[0] as Extract<BusEvent, { type: "snapshot" }>;
		assert.equal(snapshot.recent_events.length, bufferSize);
	});

	it("subscriber error does not break other subscribers", () => {
		const received: BusEvent[] = [];

		bus.subscribe(
			() => {
				throw new Error("I'm broken");
			},
			{ sandbox_id: SANDBOX_ID },
		);
		bus.subscribe((e) => received.push(e), { sandbox_id: SANDBOX_ID });

		bus.emit(makeAgentEvent(SANDBOX_ID));

		// Second subscriber still got the snapshot + the event
		assert.equal(received.length, 2);
	});

	it("cleanup removes channel", () => {
		bus.subscribe(() => {}, { sandbox_id: SANDBOX_ID });
		assert.equal(bus.subscriberCount(SANDBOX_ID), 1);

		bus.cleanup(SANDBOX_ID);
		assert.equal(bus.subscriberCount(SANDBOX_ID), 0);
	});

	it("subscriberCount reflects active subscribers", () => {
		assert.equal(bus.subscriberCount(SANDBOX_ID), 0);

		const unsub1 = bus.subscribe(() => {}, { sandbox_id: SANDBOX_ID });
		const unsub2 = bus.subscribe(() => {}, { sandbox_id: SANDBOX_ID });
		bus.subscribe(() => {}, { sandbox_id: SANDBOX_ID });

		assert.equal(bus.subscriberCount(SANDBOX_ID), 3);

		unsub1();
		assert.equal(bus.subscriberCount(SANDBOX_ID), 2);

		unsub2();
		assert.equal(bus.subscriberCount(SANDBOX_ID), 1);
	});

	it("snapshot includes record from store", () => {
		const received: BusEvent[] = [];
		bus.subscribe((e) => received.push(e), { sandbox_id: SANDBOX_ID });

		const snapshot = received[0] as Extract<BusEvent, { type: "snapshot" }>;
		assert.equal(snapshot.record.sandbox_id, SANDBOX_ID);
		assert.equal(snapshot.record.state, "running");
	});

	it("no snapshot if sandbox not in store", () => {
		const bus = createSandboxEventBus(stubStore({}));
		const received: BusEvent[] = [];
		bus.subscribe((e) => received.push(e), { sandbox_id: "nonexistent" });

		// No snapshot delivered
		assert.equal(received.length, 0);
	});

	it("terminal event schedules cleanup", async () => {
		const bus = createSandboxEventBus(stubStore({ [SANDBOX_ID]: { sandbox_id: SANDBOX_ID, state: "done" } }), {
			cleanupDelayMs: 50,
		});

		bus.emit(makeLifecycleEvent(SANDBOX_ID, "terminal"));

		// Channel still exists immediately
		assert.equal(bus.subscriberCount(SANDBOX_ID), 0);

		// Wait for cleanup
		await new Promise((r) => setTimeout(r, 100));

		// Emitting should create a fresh channel (old one cleaned up)
		bus.emit(makeAgentEvent(SANDBOX_ID));
		const received: BusEvent[] = [];
		bus.subscribe((e) => received.push(e), { sandbox_id: SANDBOX_ID });
		const snapshot = received[0] as Extract<BusEvent, { type: "snapshot" }>;
		// Only the event emitted after cleanup, not the terminal event
		assert.equal(snapshot.recent_events.length, 1);
	});
});
