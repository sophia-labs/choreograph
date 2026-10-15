/**
 * Exam 1, deletions: "the history goes too" was only the prompt's to say. A successful `delete_document`, or a wire
 * removed with `delete`, followed by a dead worker, an abort or a reply that never arrives, left the person no word of
 * what was removed. The host now records the receipt itself: when the cell answers a deletion with success, the host
 * appends a durable, user-visible receipt to the Session's events (`capability.called`, source
 * `host.deletion-receipt`: what was deleted, its title when the cell names one, whether its history went with it, and
 * the sentence to show) BEFORE it hands the answer to the worker. So it survives anything that fails after the deletion.
 *
 * Real runtime store and spawner (`withPricingHarness`); the cell is a backend that answers as garden does; the worker
 * is a pipe that is already gone when the host answers.
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CapabilityBackend } from "../mnemosyne.js";
import type { SandboxSpawner } from "../spawner.js";
import type { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import { seedPricedSession, withPricingHarness } from "./chat-pricing-fixture.js";

/** A cell that answers each tool with the given MCP result, and records what it was asked. */
function cell(answers: Record<string, unknown>) {
	const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
	const backend: CapabilityBackend = {
		capabilityName: "mnemosyne",
		accessLevel: "rw",
		async callTool(tool, args) {
			calls.push({ tool, args });
			if (!(tool in answers)) throw new Error(`unexpected tool ${tool}`);
			return answers[tool];
		},
		async listTools() {
			return [];
		},
		async close() {},
	};
	return { backend, calls };
}

const text = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** A worker that died after asking: every write to it fails. */
const deadWorker = {
	stdin: {
		write() {
			throw new Error("EPIPE: the worker is gone");
		},
	},
	kill() {
		return true;
	},
} as unknown as ChildProcess;

async function deleteThroughHost(
	spawner: SandboxSpawner,
	session: { sessionId: string; generation: number; sandboxId: string },
	backend: CapabilityBackend,
	tool: string,
	args: Record<string, unknown>,
	child: ChildProcess = deadWorker,
	callId = `call-${tool}`,
): Promise<void> {
	const active = {
		record: { sandbox_id: session.sandboxId, template: "agent", state: "running" },
		isAgentRun: true,
		agentRequest: { spawn_id: session.sandboxId, session_id: session.sessionId, generation: session.generation },
		capabilityRegistry: new Map([["mnemosyne", backend]]),
		nextHostResponseId: 0,
	};
	await (
		spawner as unknown as {
			handleGateCall(msg: unknown, child: ChildProcess, active: unknown): Promise<void>;
		}
	)
		.handleGateCall({ kind: "gate_call", call_id: callId, capability: "mnemosyne", tool, args }, child, active)
		.catch(() => {
			// The answer could not be delivered: the worker is gone. The deletion stands, and so must its receipt.
		});
}

/** A live worker that keeps every line the host writes to it, so what the model is told can be read back. */
function listeningWorker() {
	const lines: string[] = [];
	const child = {
		stdin: {
			write(line: string) {
				lines.push(String(line));
				return true;
			},
		},
		kill: () => true,
	} as unknown as ChildProcess;
	return {
		child,
		/** The text of the host's answer to one call. */
		answerTo(callId: string): string {
			const answers = lines
				.flatMap((line) => line.split("\n"))
				.filter((line) => line.trim().startsWith("{"))
				.map((line) => JSON.parse(line) as { kind?: string; call_id?: string })
				.filter((message) => message.kind === "gate_result" && message.call_id === callId);
			return JSON.stringify(answers);
		},
	};
}

/** What the cell answers when garden deletes wires (`mcp_delete_service.rs`, `type: "wires"`). */
const gardenWiresDeleted = (...ids: string[]) =>
	text({
		success: true,
		type: "wires",
		graph_id: "g1",
		deleted: ids.map((id) => ({ wire_id: id, wireId: id, value: { ok: true } })),
		deleted_count: ids.length,
	});

/** Every target any deletion receipt on the Session names, whatever its chunking. */
async function receiptTargets(runtime: WorkflowRuntimeStore, sessionId: string) {
	return (await receipts(runtime, sessionId)).flatMap(
		(event) => event.payload.value.receipt.targets as Array<{ kind: string; id: string; change: string }>,
	);
}

async function receipts(runtime: WorkflowRuntimeStore, sessionId: string) {
	return (await runtime.listAgentSessionEvents(sessionId))
		.map((event) => ({ type: event.type, payload: event.payload as Record<string, any> }))
		.filter((event) => event.payload?.sourceType === "host.deletion-receipt");
}

describe("exam 1: the host records every deletion's receipt, whatever happens after it", () => {
	it("records a document's deletion, with its history gone, though the worker never hears the answer", async () => {
		await withPricingHarness(async ({ runtime, spawner }) => {
			const session = await seedPricedSession(runtime, { suffix: "delete-doc", model: "moonshotai/kimi-k2.5" });
			const { backend, calls } = cell({
				delete_document: text({ documentId: "q3-plan", title: "Q3 plan", deleted: true }),
			});
			await deleteThroughHost(spawner, session, backend, "delete_document", { documentId: "q3-plan" });
			assert.equal(calls.length, 1, "the cell deleted the document");
			const found = await receipts(runtime, session.sessionId);
			assert.equal(found.length, 1, JSON.stringify(found));
			assert.equal(found[0]?.type, "capability.called");
			const receipt = found[0]?.payload.value.receipt;
			assert.deepEqual(receipt.targets, [{ kind: "document", id: "q3-plan", change: "deleted", title: "Q3 plan" }]);
			assert.equal(receipt.historyRemoved, true);
			assert.match(receipt.notice, /Q3 plan/);
			assert.match(receipt.notice, /history/i);
			assert.match(receipt.notice, /cannot be brought back from History/);
		});
	});

	it("records a wire's removal, by id", async () => {
		await withPricingHarness(async ({ runtime, spawner }) => {
			const session = await seedPricedSession(runtime, { suffix: "delete-wire", model: "moonshotai/kimi-k2.5" });
			const { backend } = cell({ delete: text({ deleted: 1 }) });
			await deleteThroughHost(spawner, session, backend, "delete", { type: "wire", wireIds: ["w-12"] });
			const found = await receipts(runtime, session.sessionId);
			assert.equal(found.length, 1, JSON.stringify(found));
			const receipt = found[0]?.payload.value.receipt;
			assert.deepEqual(receipt.targets, [{ kind: "wire", id: "w-12", change: "deleted" }]);
			assert.equal(receipt.historyRemoved, false);
			assert.match(receipt.notice, /w-12/);
		});
	});

	it("records nothing for a deletion the cell refused, and nothing for a write that deletes nothing", async () => {
		await withPricingHarness(async ({ runtime, spawner }) => {
			const session = await seedPricedSession(runtime, { suffix: "delete-refused", model: "moonshotai/kimi-k2.5" });
			const { backend } = cell({
				delete_document: { isError: true, content: [{ type: "text", text: "permission denied" }] },
				write_document: text({ documentId: "notes", revision: 2 }),
			});
			const alive = {
				stdin: { write: () => true },
				kill: () => true,
			} as unknown as ChildProcess;
			await deleteThroughHost(spawner, session, backend, "delete_document", { documentId: "q3-plan" }, alive);
			await deleteThroughHost(
				spawner,
				session,
				backend,
				"write_document",
				{ documentId: "notes", content: "x" },
				alive,
			);
			assert.deepEqual(await receipts(runtime, session.sessionId), []);
		});
	});
});

/**
 * Exam 2, finding C. "Every deletion the cell accepts leaves a durable receipt naming what disappeared" held only for
 * ids the call's arguments named, at most 32, and only if the store took the receipt the first time. The three
 * reproductions of the re-exam, and the repairs' edges.
 */
describe("exam 2, C: every deletion the cell accepts leaves a durable receipt naming what disappeared", () => {
	it("names the wires the cell resolved from a document, which the arguments did not name", async () => {
		await withPricingHarness(async ({ runtime, spawner }) => {
			const session = await seedPricedSession(runtime, { suffix: "wire-by-doc", model: "moonshotai/kimi-k2.5" });
			const { backend, calls } = cell({ delete: gardenWiresDeleted("w-1", "w-2") });
			await deleteThroughHost(spawner, session, backend, "delete", { type: "wire", documentId: "q3-plan" });
			assert.equal(calls.length, 1, "the cell deleted the wires");
			const found = await receipts(runtime, session.sessionId);
			assert.equal(found.length, 1, `one receipt: ${JSON.stringify(found)}`);
			assert.deepEqual(found[0]?.payload.value.receipt.targets, [
				{ kind: "wire", id: "w-1", change: "deleted" },
				{ kind: "wire", id: "w-2", change: "deleted" },
			]);
			assert.match(found[0]?.payload.value.receipt.notice, /w-1.*w-2/);
		});
	});

	it("records all 33 wires of an explicit list, not the first 32", async () => {
		await withPricingHarness(async ({ runtime, spawner }) => {
			const session = await seedPricedSession(runtime, { suffix: "wire-33", model: "moonshotai/kimi-k2.5" });
			const wireIds = Array.from({ length: 33 }, (_, index) => `w-${index + 1}`);
			const { backend } = cell({ delete: gardenWiresDeleted(...wireIds) });
			await deleteThroughHost(spawner, session, backend, "delete", { type: "wires", wireIds });
			const targets = await receiptTargets(runtime, session.sessionId);
			assert.deepEqual(targets.map((target) => target.id).sort(), [...wireIds].sort());
			assert.equal(new Set(targets.map((target) => target.id)).size, 33, "none twice");
		});
	});

	it("records hundreds of wires the cell resolved from a document, chunked, none lost", async () => {
		await withPricingHarness(async ({ runtime, spawner }) => {
			const session = await seedPricedSession(runtime, { suffix: "wire-500", model: "moonshotai/kimi-k2.5" });
			const wireIds = Array.from({ length: 500 }, (_, index) => `w-${index + 1}`);
			const { backend } = cell({ delete: gardenWiresDeleted(...wireIds) });
			await deleteThroughHost(spawner, session, backend, "delete", { type: "wire", documentId: "busy-doc" });
			const targets = await receiptTargets(runtime, session.sessionId);
			assert.deepEqual(targets.map((target) => target.id).sort(), [...wireIds].sort());
		});
	});

	it("retries a receipt the store did not take, with a bounded backoff, and then keeps it", async () => {
		await withPricingHarness(async ({ runtime, spawner }) => {
			const session = await seedPricedSession(runtime, { suffix: "retry", model: "moonshotai/kimi-k2.5" });
			(spawner as unknown as { deletionReceiptRetryDelaysMs: number[] }).deletionReceiptRetryDelaysMs = [1, 1, 1];
			let failures = 2;
			let attempts = 0;
			withFault(runtime, async (args, real) => {
				attempts += 1;
				if (failures-- > 0) throw new Error("SQLITE_BUSY: the store is busy");
				return real(...args);
			});
			const { backend } = cell({
				delete_document: text({ documentId: "q3-plan", title: "Q3 plan", deleted: true }),
			});
			const worker = listeningWorker();
			await deleteThroughHost(spawner, session, backend, "delete_document", { documentId: "q3-plan" }, worker.child);
			assert.equal(attempts, 3, "two failures, then the store took it");
			assert.deepEqual(
				(await receiptTargets(runtime, session.sessionId)).map((target) => target.id),
				["q3-plan"],
			);
		});
	});

	it("when the store never takes the receipt, says so to the model and the person, and keeps a pending record it flushes", async () => {
		await withPricingHarness(async ({ runtime, spawner }) => {
			const session = await seedPricedSession(runtime, { suffix: "never", model: "moonshotai/kimi-k2.5" });
			(spawner as unknown as { deletionReceiptRetryDelaysMs: number[] }).deletionReceiptRetryDelaysMs = [1, 1, 1];
			let broken = true;
			let attempts = 0;
			withFault(runtime, async (args, real) => {
				attempts += 1;
				if (broken) throw new Error("SQLITE_FULL: the disk is full");
				return real(...args);
			});
			const { backend } = cell({
				delete_document: text({ documentId: "q3-plan", title: "Q3 plan", deleted: true }),
				write_document: text({ documentId: "notes", revision: 2 }),
			});
			const worker = listeningWorker();
			await deleteThroughHost(spawner, session, backend, "delete_document", { documentId: "q3-plan" }, worker.child);
			assert.ok(attempts >= 2 && attempts <= 6, `bounded retries, not forever: ${attempts}`);
			assert.deepEqual(await receipts(runtime, session.sessionId), [], "nothing was stored");
			// It is not a swallowed log line: the answer the model gets says the receipt was not kept, and names what went.
			const answer = worker.answerTo("call-delete_document");
			assert.match(answer, /q3-plan/);
			assert.match(answer, /receipt/i);
			assert.match(answer, /could not be (recorded|kept|saved)/i);
			// The record is pending, and the next call on the Session flushes it once the store is back.
			broken = false;
			await deleteThroughHost(
				spawner,
				session,
				backend,
				"write_document",
				{ documentId: "notes", content: "x" },
				worker.child,
			);
			await eventually(() => spawner.pendingDeletionReceiptCount(session.sessionId) === 0, "the background flush");
			assert.deepEqual(
				(await receiptTargets(runtime, session.sessionId)).map((target) => target.id),
				["q3-plan"],
				"the pending receipt was recorded once the store took it",
			);
		});
	});
});

/**
 * Exam 3, finding C (the pending-receipt path exam 2's repair added). Fault injection wraps the real store: whichever
 * method the host appends receipts through (`appendAgentSessionEventOnce` once receipts are idempotent, else
 * `appendAgentSessionEvent`).
 */
type Appender = (...args: any[]) => Promise<number>;
function receiptAppender(runtime: WorkflowRuntimeStore): { name: string; real: Appender } {
	const name = "appendAgentSessionEventOnce" in runtime ? "appendAgentSessionEventOnce" : "appendAgentSessionEvent";
	const target = runtime as unknown as Record<string, Appender>;
	return { name, real: target[name]!.bind(runtime) };
}
function isReceiptWrite(args: any[]): boolean {
	return JSON.stringify(args).includes("host.deletion-receipt");
}
const withFault = (runtime: WorkflowRuntimeStore, behave: (args: any[], real: Appender) => Promise<number>) => {
	const { name, real } = receiptAppender(runtime);
	(runtime as unknown as Record<string, Appender>)[name] = (...args: any[]) =>
		isReceiptWrite(args) ? behave(args, real) : real(...args);
};
/** Background flushes are not awaited by any call: wait (bounded) for a condition. */
async function eventually(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
	for (let waited = 0; waited < 150; waited += 1) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	assert.fail(`timed out waiting for ${what}`);
}
const quick = (spawner: SandboxSpawner) => {
	(spawner as unknown as { deletionReceiptRetryDelaysMs: number[] }).deletionReceiptRetryDelaysMs = [1, 1, 1];
};

describe("exam 3, C: the pending-receipt path loses nothing, duplicates nothing, and survives a restart", () => {
	it("a flush that succeeds removes only what it persisted: a receipt queued while it waited survives", async () => {
		await withPricingHarness(async ({ runtime, spawner }) => {
			const session = await seedPricedSession(runtime, { suffix: "race", model: "moonshotai/kimi-k2.5" });
			quick(spawner);
			let broken = true;
			let armed = false;
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let gated = false;
			let held: Promise<void> | undefined;
			withFault(runtime, async (args, real) => {
				if (armed && !gated && JSON.stringify(args).includes("q3-plan")) {
					gated = true; // F1's persist of R0 waits, then succeeds
					held = gate;
					await gate;
					return real(...args);
				}
				if (broken) throw new Error("SQLITE_BUSY");
				return real(...args);
			});
			const { backend } = cell({
				delete_document: text({ documentId: "q3-plan", title: "Q3 plan", deleted: true }),
				write_document: text({ documentId: "notes", revision: 2 }),
			});
			const worker = listeningWorker();
			// R0 is queued.
			await deleteThroughHost(
				spawner,
				session,
				backend,
				"delete_document",
				{ documentId: "q3-plan" },
				worker.child,
				"c0",
			);
			assert.equal(spawner.pendingDeletionReceiptCount(session.sessionId), 1);
			const flush = () =>
				(
					spawner as unknown as { flushPendingDeletionReceipts(id: string): Promise<void> }
				).flushPendingDeletionReceipts(session.sessionId);
			armed = true;
			const f1 = flush();
			while (!gated) await new Promise((resolve) => setTimeout(resolve, 5));
			const f2 = flush(); // fails: the store is broken for everything but F1's held write
			const { backend: second } = cell({ delete_document: text({ documentId: "q4-plan", deleted: true }) });
			const d1 = deleteThroughHost(
				spawner,
				session,
				second,
				"delete_document",
				{ documentId: "q4-plan" },
				worker.child,
				"c1",
			);
			await new Promise((resolve) => setTimeout(resolve, 80));
			release();
			await Promise.all([f1, f2, d1]);
			void held;
			const persisted = (await receiptTargets(runtime, session.sessionId)).map((target) => target.id);
			assert.ok(persisted.includes("q3-plan"), "R0 was persisted by F1");
			assert.ok(
				persisted.includes("q4-plan") || spawner.pendingDeletionReceiptCount(session.sessionId) >= 1,
				`R1 (q4-plan) is neither persisted nor pending: persisted ${JSON.stringify(persisted)}, pending ${spawner.pendingDeletionReceiptCount(session.sessionId)}`,
			);
			// And it is recorded once the store is back.
			broken = false;
			await deleteThroughHost(
				spawner,
				session,
				backend,
				"write_document",
				{ documentId: "notes", content: "x" },
				worker.child,
				"c2",
			);
			await eventually(() => spawner.pendingDeletionReceiptCount(session.sessionId) === 0, "the background flush");
			assert.deepEqual((await receiptTargets(runtime, session.sessionId)).map((target) => target.id).sort(), [
				"q3-plan",
				"q4-plan",
			]);
		});
	});

	it("an append that commits and then rejects is retried to exactly one receipt", async () => {
		await withPricingHarness(async ({ runtime, spawner }) => {
			const session = await seedPricedSession(runtime, { suffix: "ambiguous", model: "moonshotai/kimi-k2.5" });
			quick(spawner);
			let first = true;
			withFault(runtime, async (args, real) => {
				const seq = await real(...args);
				if (first) {
					first = false;
					throw new Error("connection reset after commit");
				}
				return seq;
			});
			const { backend } = cell({
				delete_document: text({ documentId: "q3-plan", title: "Q3 plan", deleted: true }),
			});
			await deleteThroughHost(
				spawner,
				session,
				backend,
				"delete_document",
				{ documentId: "q3-plan" },
				listeningWorker().child,
			);
			assert.deepEqual(
				(await receiptTargets(runtime, session.sessionId)).map((target) => target.id),
				["q3-plan"],
				"one receipt, not two",
			);
		});
	});

	it("keeps the original tool-call id on a receipt recorded after a failure", async () => {
		await withPricingHarness(async ({ runtime, spawner }) => {
			const session = await seedPricedSession(runtime, { suffix: "attrib", model: "moonshotai/kimi-k2.5" });
			quick(spawner);
			let broken = true;
			withFault(runtime, async (args, real) => {
				if (broken) throw new Error("SQLITE_BUSY");
				return real(...args);
			});
			const { backend } = cell({
				delete_document: text({ documentId: "q3-plan", deleted: true }),
				write_document: text({ documentId: "n", revision: 1 }),
			});
			const worker = listeningWorker().child;
			await deleteThroughHost(
				spawner,
				session,
				backend,
				"delete_document",
				{ documentId: "q3-plan" },
				worker,
				"call-original-7",
			);
			broken = false;
			await deleteThroughHost(
				spawner,
				session,
				backend,
				"write_document",
				{ documentId: "n", content: "x" },
				worker,
				"call-later",
			);
			await eventually(() => spawner.pendingDeletionReceiptCount(session.sessionId) === 0, "the background flush");
			const found = await receipts(runtime, session.sessionId);
			assert.equal(found.length, 1);
			assert.equal(found[0]?.payload.value.callId, "call-original-7");
		});
	});
});

describe("exam 3, C: the keyed append is idempotent and the schema is untouched", () => {
	it("keeps every existing event across a reopen, ignores a repeated key, and never blocks unkeyed events", async () => {
		const { withRuntime, beginChat } = await import("./chat-runtime-fixture.js");
		const { InspectableRuntime } = await import("./chat-runtime-fixture.js");
		await withRuntime(async (runtime, dir) => {
			const chat = await beginChat(runtime, { n: 71 });
			// Events as every earlier release wrote them: no receiptKey, several alike.
			for (let index = 0; index < 3; index += 1) {
				await runtime.appendAgentSessionEvent(chat.sessionId, { type: "note", payload: { value: { n: index } } });
			}
			const before = (await runtime.listAgentSessionEvents(chat.sessionId)).length;
			const keyed = (n: number) => ({ type: "capability.called", payload: { value: { receiptKey: "k1", n } } });
			const first = await runtime.appendAgentSessionEventOnce(chat.sessionId, "k1", keyed(1));
			const again = await runtime.appendAgentSessionEventOnce(chat.sessionId, "k1", keyed(2));
			assert.equal(again, first, "the same key is the same event");
			assert.equal((await runtime.listAgentSessionEvents(chat.sessionId)).length, before + 1);
			await runtime.appendAgentSessionEvent(chat.sessionId, { type: "note", payload: { value: { n: 9 } } });
			// A second host opening the same file re-runs the schema: nothing is lost, and the key still holds.
			const reopened = new InspectableRuntime(join(dir, "runtime.sqlite"));
			await reopened.init();
			assert.equal((await reopened.listAgentSessionEvents(chat.sessionId)).length, before + 2);
			assert.equal(await reopened.appendAgentSessionEventOnce(chat.sessionId, "k1", keyed(3)), first);
			reopened.close();
			await assert.rejects(
				runtime.appendAgentSessionEventOnce(chat.sessionId, "k2", keyed(4)),
				/receiptKey/,
				"the payload must carry the key it is stored under",
			);
		});
	});
});

/**
 * Simplification after exam 5: an ordinary tool call never waits on receipt work. A pending receipt is flushed in the
 * background, triggered by the Session's next gate call and never awaited by it.
 */
describe("exam 5, C: ordinary calls never wait on receipt work", () => {
	it("answers an ordinary call while the store holds a receipt write, and the held flush finishes in the background", async () => {
		await withPricingHarness(async ({ runtime, spawner }) => {
			const session = await seedPricedSession(runtime, { suffix: "nowait", model: "moonshotai/kimi-k2.5" });
			quick(spawner);
			let mode: "broken" | "held" | "open" = "broken";
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			withFault(runtime, async (args, real) => {
				if (mode === "broken") throw new Error("SQLITE_FULL");
				if (mode === "held") await gate;
				return real(...args);
			});
			const { backend } = cell({
				delete_document: text({ documentId: "q3-plan", deleted: true }),
				write_document: text({ documentId: "notes", revision: 2 }),
			});
			const worker = listeningWorker();
			await deleteThroughHost(
				spawner,
				session,
				backend,
				"delete_document",
				{ documentId: "q3-plan" },
				worker.child,
				"c0",
			);
			assert.equal(spawner.pendingDeletionReceiptCount(session.sessionId), 1);
			mode = "held"; // the store is back, but every receipt write is slow
			const answered = deleteThroughHost(
				spawner,
				session,
				backend,
				"write_document",
				{ documentId: "notes", content: "x" },
				worker.child,
				"c-ordinary",
			).then(() => "answered");
			const outcome = await Promise.race([
				answered,
				new Promise<string>((resolve) => setTimeout(() => resolve("waited"), 1_000)),
			]);
			assert.equal(outcome, "answered", "the ordinary call's answer did not wait on the held receipt write");
			assert.match(worker.answerTo("c-ordinary"), /notes/);
			release();
			mode = "open";
			for (let waited = 0; waited < 100 && spawner.pendingDeletionReceiptCount(session.sessionId) > 0; waited += 1) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			assert.deepEqual(
				(await receiptTargets(runtime, session.sessionId)).map((target) => target.id),
				["q3-plan"],
			);
		});
	});

	it("two store instances on one file, racing the same receipt key, leave one event", async () => {
		const { withRuntime, beginChat, InspectableRuntime } = await import("./chat-runtime-fixture.js");
		await withRuntime(async (runtime, dir) => {
			const chat = await beginChat(runtime, { n: 91 });
			const other = new InspectableRuntime(join(dir, "runtime.sqlite"));
			await other.init();
			const event = (n: number) => ({ type: "capability.called", payload: { value: { receiptKey: "k-race", n } } });
			const seqs = await Promise.all(
				Array.from({ length: 6 }, (_, index) =>
					(index % 2 ? other : runtime).appendAgentSessionEventOnce(chat.sessionId, "k-race", event(index)),
				),
			);
			assert.equal(new Set(seqs).size, 1, `one seq: ${seqs.join(",")}`);
			const keyed = (await runtime.listAgentSessionEvents(chat.sessionId)).filter(
				(e) => (e.payload as { value?: { receiptKey?: string } })?.value?.receiptKey === "k-race",
			);
			assert.equal(keyed.length, 1);
			other.close();
		});
	});
});

/** Exam 6: the pending queue is bounded and ages out, flushes coalesce, and only deletion tools are parsed. */
describe("exam 6, C: a bounded pending queue, coalesced flushes, and a deletion-tool guard", () => {
	const knobs = (spawner: SandboxSpawner) =>
		spawner as unknown as {
			maxPendingReceiptsPerSession: number;
			maxPendingReceiptsPerHost: number;
			pendingReceiptTtlMs: number;
		};
	const failingStore = (runtime: WorkflowRuntimeStore) => {
		const state = { broken: true, attempts: 0 };
		withFault(runtime, async (args, real) => {
			state.attempts += 1;
			if (state.broken) throw new Error("SQLITE_FULL");
			return real(...args);
		});
		return state;
	};
	const removeDoc = (id: string) => cell({ delete_document: text({ documentId: id, deleted: true }) }).backend;
	const logging = async <T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> => {
		const lines: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => {
			lines.push(args.map(String).join(" "));
		};
		try {
			return { value: await run(), lines };
		} finally {
			console.error = original;
		}
	};

	it("keeps at most the per-Session cap, dropping the oldest and logging each drop without content", async () => {
		await withPricingHarness(async ({ runtime, spawner }) => {
			const session = await seedPricedSession(runtime, { suffix: "cap", model: "moonshotai/kimi-k2.5" });
			quick(spawner);
			knobs(spawner).maxPendingReceiptsPerSession = 3;
			failingStore(runtime);
			const { lines } = await logging(async () => {
				for (let index = 0; index < 5; index += 1) {
					await deleteThroughHost(
						spawner,
						session,
						removeDoc(`doc-${index}`),
						"delete_document",
						{ documentId: `doc-${index}` },
						listeningWorker().child,
						`call-${index}`,
					);
				}
			});
			assert.equal(spawner.pendingDeletionReceiptCount(session.sessionId), 3);
			const dropped = lines.filter((line) => /dropped/i.test(line));
			assert.equal(dropped.length, 2, lines.join("\n"));
			assert.ok(
				dropped[0]?.includes("call-0") && /dr_[0-9a-f]+/.test(dropped[0] ?? ""),
				"names the call and the receiptKey",
			);
			assert.ok(dropped[1]?.includes("call-1"));
			assert.ok(!dropped.some((line) => line.includes("doc-0")), "never content");
		});
	});

	it("keeps at most the per-host cap across Sessions", async () => {
		await withPricingHarness(async ({ runtime, spawner }) => {
			const one = await seedPricedSession(runtime, { suffix: "host-a", model: "moonshotai/kimi-k2.5" });
			const two = await seedPricedSession(runtime, { suffix: "host-b", model: "moonshotai/kimi-k2.5" });
			quick(spawner);
			knobs(spawner).maxPendingReceiptsPerHost = 3;
			failingStore(runtime);
			await logging(async () => {
				for (let index = 0; index < 5; index += 1) {
					const session = index % 2 ? two : one;
					await deleteThroughHost(
						spawner,
						session,
						removeDoc(`d-${index}`),
						"delete_document",
						{ documentId: `d-${index}` },
						listeningWorker().child,
						`call-${index}`,
					);
				}
			});
			assert.equal(spawner.pendingDeletionReceiptCount(), 3);
		});
	});

	it("does not retry an entry older than the time limit: it is dropped, and logged", async () => {
		await withPricingHarness(async ({ runtime, spawner }) => {
			const session = await seedPricedSession(runtime, { suffix: "ttl", model: "moonshotai/kimi-k2.5" });
			quick(spawner);
			knobs(spawner).pendingReceiptTtlMs = 40;
			const store = failingStore(runtime);
			await deleteThroughHost(
				spawner,
				session,
				removeDoc("q3-plan"),
				"delete_document",
				{ documentId: "q3-plan" },
				listeningWorker().child,
				"call-old",
			);
			assert.equal(spawner.pendingDeletionReceiptCount(session.sessionId), 1);
			await new Promise((resolve) => setTimeout(resolve, 120));
			store.broken = false;
			store.attempts = 0;
			const { lines } = await logging(async () => {
				await (
					spawner as unknown as { flushPendingDeletionReceipts(id: string): Promise<void> }
				).flushPendingDeletionReceipts(session.sessionId);
			});
			assert.equal(store.attempts, 0, "an expired entry is not retried");
			assert.equal(spawner.pendingDeletionReceiptCount(session.sessionId), 0);
			assert.deepEqual(await receiptTargets(runtime, session.sessionId), []);
			assert.ok(
				lines.some((line) => /dropped/i.test(line) && line.includes("call-old")),
				lines.join("\n"),
			);
		});
	});

	it("runs at most one flush per Session at a time: 100 triggers behind a held flush are a bounded number of appends", async () => {
		await withPricingHarness(async ({ runtime, spawner }) => {
			const session = await seedPricedSession(runtime, { suffix: "coalesce", model: "moonshotai/kimi-k2.5" });
			quick(spawner);
			const { backend } = cell({
				delete_document: text({ documentId: "x", deleted: true }),
				write_document: text({ documentId: "notes", revision: 2 }),
			});
			const store = failingStore(runtime);
			await logging(async () => {
				for (let index = 0; index < 100; index += 1) {
					await deleteThroughHost(
						spawner,
						session,
						removeDoc(`doc-${index}`),
						"delete_document",
						{ documentId: `doc-${index}` },
						listeningWorker().child,
						`call-${index}`,
					);
				}
			});
			assert.equal(spawner.pendingDeletionReceiptCount(session.sessionId), 100);
			// The store now holds its first receipt write, then refuses everything.
			let release: () => void = () => {};
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let first = true;
			withFault(runtime, async () => {
				store.attempts += 1;
				if (first) {
					first = false;
					await gate;
				}
				throw new Error("SQLITE_FULL");
			});
			store.attempts = 0;
			const worker = listeningWorker().child;
			await logging(async () => {
				for (let index = 0; index < 101; index += 1) {
					await deleteThroughHost(
						spawner,
						session,
						backend,
						"write_document",
						{ documentId: "notes", content: "x" },
						worker,
						`ord-${index}`,
					);
				}
				release();
				await new Promise((resolve) => setTimeout(resolve, 300));
			});
			assert.ok(store.attempts <= 200, `bounded appends, not one round per trigger: ${store.attempts}`);
			assert.equal(spawner.pendingDeletionReceiptCount(session.sessionId), 100);
		});
	});

	it("parses a result's deleted array only for deletion tools: a write that returns one is not a deletion", async () => {
		await withPricingHarness(async ({ runtime, spawner }) => {
			const session = await seedPricedSession(runtime, { suffix: "guard", model: "moonshotai/kimi-k2.5" });
			quick(spawner);
			(spawner as unknown as { deletionReceiptRetryDelaysMs: number[] }).deletionReceiptRetryDelaysMs = [
				200, 200, 200,
			];
			const store = failingStore(runtime);
			const { backend } = cell({ write_document: gardenWiresDeleted("w-1", "w-2") });
			const worker = listeningWorker();
			const started = Date.now();
			await deleteThroughHost(
				spawner,
				session,
				backend,
				"write_document",
				{ documentId: "notes", content: "x" },
				worker.child,
				"call-w",
			);
			assert.ok(Date.now() - started < 150, "no retries were waited on");
			assert.equal(store.attempts, 0, "no receipt was attempted");
			assert.equal(spawner.pendingDeletionReceiptCount(session.sessionId), 0);
			assert.doesNotMatch(worker.answerTo("call-w"), /Host notice/);
		});
	});
});
