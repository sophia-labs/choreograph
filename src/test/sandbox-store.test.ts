import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { type SandboxState, SandboxStore } from "../sandbox-store.js";

describe("SandboxStore", () => {
	let store: SandboxStore;
	let tempDir: string;
	let dbPath: string;

	before(() => {
		tempDir = mkdtempSync(join(tmpdir(), "sandbox-store-test-"));
		dbPath = join(tempDir, "test.sqlite");
		store = new SandboxStore(dbPath);
	});

	after(() => {
		store.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	describe("create()", () => {
		it("generates UUID, sets state=queued, sets queued_at", () => {
			const record = store.create("bare");
			assert.match(record.sandbox_id, /^[0-9a-f]{8}-[0-9a-f]{4}-/);
			assert.equal(record.state, "queued");
			assert.equal(record.template, "bare");
			assert.ok(record.queued_at, "queued_at should be set");
			assert.match(record.queued_at, /^\d{4}-\d{2}-\d{2}T/);
		});

		it("stores resource config", () => {
			const record = store.create("bare", {
				memory_max_bytes: 67108864,
				cpu_quota_us: 50000,
				cpu_period_us: 100000,
				pids_max: 64,
			});
			assert.equal(record.memory_max_bytes, 67108864);
			assert.equal(record.cpu_quota_us, 50000);
			assert.equal(record.cpu_period_us, 100000);
			assert.equal(record.pids_max, 64);
		});

		it("stores intent", () => {
			const record = store.create("bare", undefined, "test intent");
			assert.equal(record.intent, "test intent");
		});

		it("stores ownership metadata", () => {
			const record = store.create("bare", undefined, "owned sandbox", {
				ownerUserId: "ada",
				authMethod: "delegated_bearer",
			});
			assert.equal(record.owner_user_id, "ada");
			assert.equal(record.auth_method, "delegated_bearer");
		});

		it("stores filesystem bundle IDs", () => {
			const record = store.create("bare", undefined, "prewarmed sandbox", {
				filesystems: ["runtime-cache", "toolchain-v1", "runtime-cache"],
			});
			assert.deepEqual(record.filesystems, ["runtime-cache", "toolchain-v1"]);
		});
	});

	describe("get()", () => {
		it("returns record for known ID", () => {
			const created = store.create("bare");
			const fetched = store.get(created.sandbox_id);
			assert.ok(fetched);
			assert.equal(fetched.sandbox_id, created.sandbox_id);
			assert.equal(fetched.state, "queued");
		});

		it("returns undefined for unknown ID", () => {
			assert.equal(store.get("nonexistent-id"), undefined);
		});
	});

	describe("list()", () => {
		it("returns all sandboxes", () => {
			const initialCount = store.list().length;
			store.create("bare");
			store.create("workspace");
			assert.equal(store.list().length, initialCount + 2);
		});

		it("filters by state", () => {
			const record = store.create("bare");
			store.transition(record.sandbox_id, "spawning");
			const spawning = store.list({ state: "spawning" });
			assert.ok(spawning.some((r) => r.sandbox_id === record.sandbox_id));
			const queued = store.list({ state: "queued" });
			assert.ok(!queued.some((r) => r.sandbox_id === record.sandbox_id));
		});
	});

	describe("transition()", () => {
		it("follows valid path: queued → spawning → running → done", () => {
			const record = store.create("bare");
			const id = record.sandbox_id;

			const s1 = store.transition(id, "spawning");
			assert.equal(s1.state, "spawning");

			const s2 = store.transition(id, "running");
			assert.equal(s2.state, "running");

			const s3 = store.transition(id, "done", "clean exit");
			assert.equal(s3.state, "done");
		});

		it("rejects invalid transitions", () => {
			const record = store.create("bare");
			assert.throws(() => store.transition(record.sandbox_id, "done"), /Invalid transition: queued -> done/);
			assert.throws(() => store.transition(record.sandbox_id, "running"), /Invalid transition: queued -> running/);
		});

		it("records audit log in state_transitions", () => {
			const record = store.create("bare");
			const id = record.sandbox_id;
			store.transition(id, "spawning");
			store.transition(id, "running");

			// Query transitions table directly via second connection
			const db2 = new DatabaseSync(dbPath);
			const rows = db2
				.prepare("SELECT from_state, to_state, reason FROM state_transitions WHERE sandbox_id = $id ORDER BY id")
				.all({ id }) as Array<{ from_state: string; to_state: string; reason: string | null }>;
			db2.close();

			assert.equal(rows.length, 2);
			assert.equal(rows[0].from_state, "queued");
			assert.equal(rows[0].to_state, "spawning");
			assert.equal(rows[1].from_state, "spawning");
			assert.equal(rows[1].to_state, "running");
		});

		it("sets timing fields", () => {
			const record = store.create("bare");
			const id = record.sandbox_id;
			assert.ok(record.queued_at);
			assert.equal(record.spawned_at, undefined);

			const s1 = store.transition(id, "spawning");
			assert.ok(s1.spawned_at);
			assert.equal(s1.running_at, undefined);

			const s2 = store.transition(id, "running");
			assert.ok(s2.running_at);
			assert.equal(s2.exited_at, undefined);

			const s3 = store.transition(id, "done");
			assert.ok(s3.exited_at);
		});

		it("terminal states are immutable", () => {
			const record = store.create("bare");
			const id = record.sandbox_id;
			store.transition(id, "spawning");
			store.transition(id, "running");
			store.transition(id, "done");

			assert.throws(() => store.transition(id, "error"), /Invalid transition/);
		});

		it("allows queued → killed (shutdown while queued)", () => {
			const record = store.create("bare");
			const result = store.transition(record.sandbox_id, "killed", "shutdown");
			assert.equal(result.state, "killed");
		});

		it("allows queued → error when sandbox setup fails before spawning", () => {
			const record = store.create("bare");
			const result = store.transition(record.sandbox_id, "error", "cgroup setup failed");
			assert.equal(result.state, "error");
			assert.ok(result.exited_at);
		});

		it("allows running → error, timeout, killed", () => {
			for (const terminal of ["error", "timeout", "killed"] as SandboxState[]) {
				const record = store.create("bare");
				const id = record.sandbox_id;
				store.transition(id, "spawning");
				store.transition(id, "running");
				const result = store.transition(id, terminal);
				assert.equal(result.state, terminal);
			}
		});
	});

	describe("update methods", () => {
		it("updatePid", () => {
			const record = store.create("bare");
			store.updatePid(record.sandbox_id, 12345);
			assert.equal(store.get(record.sandbox_id)!.pid, 12345);
		});

		it("updateCgroupPath", () => {
			const record = store.create("bare");
			store.updateCgroupPath(record.sandbox_id, "/sys/fs/cgroup/test");
			assert.equal(store.get(record.sandbox_id)!.cgroup_path, "/sys/fs/cgroup/test");
		});

		it("updateExitCode", () => {
			const record = store.create("bare");
			store.updateExitCode(record.sandbox_id, 137);
			assert.equal(store.get(record.sandbox_id)!.exit_code, 137);
		});

		it("updateErrorDetail", () => {
			const record = store.create("bare");
			store.updateErrorDetail(record.sandbox_id, "OOM killed");
			assert.equal(store.get(record.sandbox_id)!.error_detail, "OOM killed");
		});
	});

	describe("purgeSandboxes()", () => {
		it("securely removes only the exact retired registry testimony", () => {
			const retired = store.create("agent", undefined, "private Phanes prompt");
			const retained = store.create("agent", undefined, "unrelated prompt");
			store.transition(retired.sandbox_id, "killed", "privacy retirement");

			assert.equal(store.purgeSandboxes([retired.sandbox_id, retired.sandbox_id]), 1);
			assert.equal(store.get(retired.sandbox_id), undefined);
			assert.ok(store.get(retained.sandbox_id));
			assert.throws(() => store.purgeSandboxes(["not-a-sandbox"]), /invalid sandbox id/);
		});
	});

	describe("transitionToSpawning()", () => {
		it("transitions queued→spawning and sets cgroup_path in one call", () => {
			const record = store.create("bare");
			const result = store.transitionToSpawning(record.sandbox_id, "/sys/fs/cgroup/test");
			assert.equal(result.state, "spawning");
			assert.equal(result.cgroup_path, "/sys/fs/cgroup/test");
			assert.ok(result.spawned_at);
		});

		it("rejects if not in queued state", () => {
			const record = store.create("bare");
			store.transition(record.sandbox_id, "spawning");
			assert.throws(() => store.transitionToSpawning(record.sandbox_id, "/test"), /not in queued state/);
		});

		it("records transition in audit log", () => {
			const record = store.create("bare");
			store.transitionToSpawning(record.sandbox_id, "/test");
			const db2 = new DatabaseSync(dbPath);
			const rows = db2
				.prepare("SELECT from_state, to_state FROM state_transitions WHERE sandbox_id = $id")
				.all({ id: record.sandbox_id }) as Array<{ from_state: string; to_state: string }>;
			db2.close();
			assert.equal(rows.length, 1);
			assert.equal(rows[0].from_state, "queued");
			assert.equal(rows[0].to_state, "spawning");
		});
	});

	describe("transitionToRunning()", () => {
		it("transitions spawning→running and sets pid in one call", () => {
			const record = store.create("bare");
			store.transition(record.sandbox_id, "spawning");
			const result = store.transitionToRunning(record.sandbox_id, 12345);
			assert.equal(result.state, "running");
			assert.equal(result.pid, 12345);
			assert.ok(result.running_at);
		});

		it("rejects if not in spawning state", () => {
			const record = store.create("bare");
			assert.throws(() => store.transitionToRunning(record.sandbox_id, 123), /not in spawning state/);
		});
	});

	describe("transitionToTerminal()", () => {
		it("sets state, exit code, usage, and reason in one transaction", () => {
			const record = store.create("bare");
			store.transition(record.sandbox_id, "spawning");
			store.transition(record.sandbox_id, "running");
			const result = store.transitionToTerminal(record.sandbox_id, "done", {
				exitCode: 0,
				usage: { memory_peak_bytes: 50000, cpu_usage_us: 1234 },
				reason: "clean exit",
			});
			assert.equal(result.state, "done");
			assert.equal(result.exit_code, 0);
			assert.equal(result.memory_peak_bytes, 50000);
			assert.equal(result.cpu_usage_us, 1234);
			assert.ok(result.exited_at);
		});

		it("sets error_detail for OOM", () => {
			const record = store.create("bare");
			store.transition(record.sandbox_id, "spawning");
			store.transition(record.sandbox_id, "running");
			const result = store.transitionToTerminal(record.sandbox_id, "error", {
				exitCode: 137,
				errorDetail: "OOM killed",
			});
			assert.equal(result.state, "error");
			assert.equal(result.error_detail, "OOM killed");
		});

		it("rejects if not in running state", () => {
			const record = store.create("bare");
			assert.throws(() => store.transitionToTerminal(record.sandbox_id, "done", {}), /not running/);
		});
	});

	describe("updateResourceUsage", () => {
		it("writes memory and cpu values", () => {
			const record = store.create("bare");
			store.updateResourceUsage(record.sandbox_id, {
				memory_peak_bytes: 12345678,
				cpu_usage_us: 5000,
			});
			const updated = store.get(record.sandbox_id)!;
			assert.equal(updated.memory_peak_bytes, 12345678);
			assert.equal(updated.cpu_usage_us, 5000);
		});

		it("does NOT overwrite existing values with null (COALESCE)", () => {
			const record = store.create("bare");
			// First write — set valid values
			store.updateResourceUsage(record.sandbox_id, {
				memory_peak_bytes: 99999,
				cpu_usage_us: 7777,
			});

			// Second write — undefined values (become null in SQL)
			store.updateResourceUsage(record.sandbox_id, {});

			// Existing values should be preserved
			const after = store.get(record.sandbox_id)!;
			assert.equal(after.memory_peak_bytes, 99999, "memory_peak_bytes should not be overwritten");
			assert.equal(after.cpu_usage_us, 7777, "cpu_usage_us should not be overwritten");
		});

		it("overwrites when new values are provided", () => {
			const record = store.create("bare");
			store.updateResourceUsage(record.sandbox_id, {
				memory_peak_bytes: 1000,
				cpu_usage_us: 100,
			});
			store.updateResourceUsage(record.sandbox_id, {
				memory_peak_bytes: 2000,
				cpu_usage_us: 200,
			});
			const after = store.get(record.sandbox_id)!;
			assert.equal(after.memory_peak_bytes, 2000);
			assert.equal(after.cpu_usage_us, 200);
		});
	});
});
