import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AgentSessionFamilyProjectionPump } from "../agent-runtime/agent-session-family-projection-pump.js";
import type { AgentSessionSchedulerService } from "../agent-runtime/agent-session-scheduler-service.js";
import type { AgentSessionChildExecutionService } from "../agent-runtime/child-execution-service.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";

describe("SandboxSpawner durable scheduler lifecycle", () => {
	it("starts after materialization recovery, wakes with durable changes, and stops before child teardown", async () => {
		const directory = mkdtempSync(join(tmpdir(), "scheduler-spawner-lifecycle-"));
		after(() => rmSync(directory, { recursive: true, force: true }));
		const store = new SandboxStore(join(directory, "sandboxes.sqlite"));
		const order: string[] = [];
		let schedulerWakes = 0;
		const child = {
			start: async () => {
				order.push("child.start");
			},
			wake: () => {},
			stop: async () => {
				order.push("child.stop");
			},
			abortExecutions: () => {},
			awaitExecutionDrain: async () => {},
		} as unknown as AgentSessionChildExecutionService;
		const scheduler = {
			start: async () => {
				assert.deepEqual(order, ["child.start"]);
				order.push("scheduler.start");
			},
			wake: () => {
				schedulerWakes += 1;
			},
			stop: async () => {
				order.push("scheduler.stop");
			},
		} as unknown as AgentSessionSchedulerService;
		const projection = {
			start: async () => {
				assert.deepEqual(order, ["child.start", "scheduler.start"]);
				order.push("projection.start");
			},
			wake: () => {},
			stop: async () => {
				order.push("projection.stop");
			},
		} as unknown as AgentSessionFamilyProjectionPump;
		const spawner = new SandboxSpawner(store, { parentPath: "/unused", version: 2 } as never, {
			childExecutionService: child,
			schedulerService: scheduler,
			familyProjectionPump: projection,
		});

		await spawner.start();
		spawner.wakeDurableSupervision();
		assert.equal(schedulerWakes, 1);
		await spawner.shutdownAll();
		assert.ok(order.indexOf("scheduler.stop") < order.indexOf("child.stop"));
		assert.deepEqual(order, [
			"child.start",
			"scheduler.start",
			"projection.start",
			"scheduler.stop",
			"child.stop",
			"projection.stop",
		]);
		store.close();
	});
});
