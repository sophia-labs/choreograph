import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import { createSandboxEventBus, type SandboxEventBus } from "../event-bus.js";
import type { CapabilityBackend, HostedMcpToolDescriptor } from "../mnemosyne.js";
import { CaptureWriter } from "../observatory-capture.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import { compileWorkflow } from "../workflow/harness.js";
import { InvocationFault } from "../workflow/invocation.js";
import { WorkflowProgramControlBackend } from "../workflow/program-control.js";
import { executeProgramWorkflow, type ProgramCapabilityObservation } from "../workflow/program-executor.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";

const PURE_PROGRAM = `export const meta = {
	name: "sum-and-label",
	execution: {
		controller: "program",
		modelUse: "none",
		isolation: "sandbox",
		effects: "pure",
		reproducibility: "pure",
	},
	inputs: {
		type: "object",
		properties: { values: { type: "array", items: { type: "number" } } },
		required: ["values"],
		additionalProperties: false,
	},
	outputs: {
		type: "object",
		properties: { total: { type: "number" }, label: { type: "string" } },
		required: ["total", "label"],
		additionalProperties: false,
	},
}

phase("calculate")
log("adding values")
const partials = await parallel(args.values.map((value) => async () => value))
return { total: partials.reduce((sum, value) => sum + value, 0), label: "sandboxed" }
`;

const ILLEGAL_AGENT_PROGRAM = `export const meta = {
	name: "illegal-agent",
	execution: {
		controller: "program",
		modelUse: "none",
		isolation: "sandbox",
		effects: "pure",
		reproducibility: "pure",
	},
}

await agent("this must not run")
return { unreachable: true }
`;

const CAPABILITY_PROGRAM = `export const meta = {
	name: "capability-echo",
	execution: {
		controller: "program",
		modelUse: "none",
		isolation: "sandbox",
		effects: "capability-bound",
		reproducibility: "recorded-external",
		capabilities: ["test.echo"],
	},
}

const echoed = await invoke({ capability: "test.echo", tool: "echo", args: { value: args.value } })
return { echoed }
`;

const MALFORMED_CAPABILITY_PROGRAM = `export const meta = {
	name: "malformed-capability-envelope",
	execution: {
		controller: "program", modelUse: "none", isolation: "sandbox",
		effects: "capability-bound", reproducibility: "recorded-external",
		capabilities: ["test.echo"],
	},
}
return invoke({ capability: "test.echo", tool: "echo", args: {}, credentials: "never" })
`;

const STEERABLE_JOURNEY_PROGRAM = `export const meta = {
	name: "steerable-journey",
	execution: {
		controller: "program", modelUse: "inference", isolation: "sandbox",
		effects: "capability-bound", reproducibility: "recorded-external",
		capabilities: ["test.gate"],
	},
}
const visits = await journey(args.beats, async (beat, control) => {
	const value = await invoke({ capability: "test.gate", tool: "echo", args: { id: beat.id, value: beat.value } })
	return { id: beat.id, value, directives: control.directives }
}, { modelUse: "inference" })
return { visits }
`;

class EchoCapability implements CapabilityBackend {
	readonly accessLevel = "ro" as const;
	closed = false;
	calls = 0;

	constructor(readonly capabilityName = "test.echo") {}

	async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
		if (tool !== "echo") throw new Error(`unknown tool: ${tool}`);
		this.calls++;
		return args.value;
	}

	async listTools(): Promise<readonly HostedMcpToolDescriptor[]> {
		return [{ name: "echo", inputSchema: { type: "object" } }];
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

class BlockingGateCapability implements CapabilityBackend {
	readonly capabilityName = "test.gate";
	readonly accessLevel = "ro" as const;
	private releaseFirst!: () => void;
	readonly firstStarted = new Promise<void>((resolve) => {
		this.releaseFirst = resolve;
	});
	private first = true;

	async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
		if (tool !== "echo") throw new Error(`unknown tool: ${tool}`);
		if (this.first) {
			this.first = false;
			await new Promise<void>((resolve) => {
				const started = this.releaseFirst;
				this.releaseFirst = resolve;
				started();
			});
		}
		return args.value;
	}

	release(): void {
		this.releaseFirst();
	}

	async listTools(): Promise<readonly HostedMcpToolDescriptor[]> {
		return [{ name: "echo", inputSchema: { type: "object" } }];
	}

	async close(): Promise<void> {}
}

describe("program-controlled workflow executor", { concurrency: false }, () => {
	let tempDir: string;
	let store: SandboxStore;
	let eventBus: SandboxEventBus;
	let spawner: SandboxSpawner;

	before(() => {
		tempDir = mkdtempSync(join(tmpdir(), "choreograph-program-executor-"));
		store = new SandboxStore(join(tempDir, "sandboxes.sqlite"));
		eventBus = createSandboxEventBus(store, { cleanupDelayMs: 0 });
		spawner = new SandboxSpawner(
			store,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{ sandboxMode: "local-native", defaultTimeoutMs: 10_000, eventBus },
		);
	});

	after(async () => {
		await spawner.shutdownAll();
		store.close();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("runs ordinary source through a real runtime sandbox without an agent or model", async () => {
		const result = await executeProgramWorkflow(
			{ spawner, eventBus, ownerUserId: "user-local", timeoutMs: 10_000 },
			compileWorkflow(PURE_PROGRAM),
			{ values: [2, 3, 5] },
		);

		assert.deepEqual(result.output, { total: 10, label: "sandboxed" });
		assert.deepEqual(result.phases, [{ index: 1, title: "calculate" }]);
		assert.deepEqual(result.logs, [{ msg: "adding values" }]);
		const record = store.get(result.sandboxId);
		assert.equal(record?.template, "bare");
		assert.equal(record?.owner_user_id, "user-local");
	});

	it("fails closed if program-controlled source attempts agent execution", async () => {
		await assert.rejects(
			executeProgramWorkflow(
				{ spawner, eventBus, ownerUserId: "user-local", timeoutMs: 10_000 },
				compileWorkflow(ILLEGAL_AGENT_PROGRAM),
				{},
			),
			(error: unknown) => error instanceof InvocationFault && error.code === "executor_violation",
		);
	});

	it("mediates declared capability calls on the host and witnesses their effects", async () => {
		const backend = new EchoCapability();
		const streamedEffects: Array<{ capability: string; operation: string; outcome: string }> = [];
		const observedCalls: ProgramCapabilityObservation[] = [];
		const captureLines: Buffer[] = [];
		const captureSink = new PassThrough();
		captureSink.on("data", (chunk: Buffer) => captureLines.push(chunk));
		const capture = new CaptureWriter({
			sink: captureSink,
			hostId: "program-executor-test",
			heartbeatMs: 0,
		});
		const result = await executeProgramWorkflow(
			{
				spawner,
				eventBus,
				ownerUserId: "user-local",
				timeoutMs: 10_000,
				capabilities: new Map([["test.echo", backend]]),
				onEffect: (effect) => streamedEffects.push(effect),
				onCapabilityCall: (call) => {
					observedCalls.push(call);
					capture.emit({
						kind: "capability.call",
						principal: "service:choreograph",
						outcome: call.outcome,
						durationMs: call.durationMs,
						payload: {
							runId: "program-executor-test-run",
							sandboxId: call.sandboxId,
							callId: call.callId,
							capability: call.capability,
							tool: call.operation,
						},
					});
				},
			},
			compileWorkflow(CAPABILITY_PROGRAM),
			{ value: "from-host" },
		);
		assert.equal(await capture.whenIdle(), true);
		assert.equal(await capture.close(), true);

		assert.deepEqual(result.output, { echoed: "from-host" });
		assert.deepEqual(result.effects, [{ capability: "test.echo", operation: "echo", outcome: "ok" }]);
		assert.deepEqual(streamedEffects, result.effects);
		assert.equal(observedCalls.length, 1);
		assert.equal(Number.isSafeInteger(observedCalls[0]?.durationMs), true);
		assert.deepEqual(capture.counters, { emittedTotal: 1, droppedTotal: 0, nextSeq: 1n });
		const captured = JSON.parse(Buffer.concat(captureLines).toString("utf8")) as {
			duration_ms: number;
			kind: string;
			payload: Record<string, unknown>;
		};
		assert.equal(captured.kind, "capability.call");
		assert.equal(captured.duration_ms, observedCalls[0]?.durationMs);
		assert.equal(captured.payload.call_id, observedCalls[0]?.callId);
	});

	it("refuses a declared capability before spawn when no host binding exists", async () => {
		await assert.rejects(
			executeProgramWorkflow(
				{ spawner, eventBus, ownerUserId: "user-local", timeoutMs: 10_000 },
				compileWorkflow(CAPABILITY_PROGRAM),
				{ value: "unreachable" },
			),
			(error: unknown) =>
				error instanceof InvocationFault &&
				error.code === "capability_unavailable" &&
				(error.details as { capability?: string } | undefined)?.capability === "test.echo",
		);
	});

	it("enforces Contract B as an exact capability/tool/args envelope", async () => {
		await assert.rejects(
			executeProgramWorkflow(
				{
					spawner,
					eventBus,
					ownerUserId: "user-local",
					timeoutMs: 10_000,
					capabilities: new Map([["test.echo", new EchoCapability()]]),
				},
				compileWorkflow(MALFORMED_CAPABILITY_PROGRAM),
				{},
			),
			/invocation envelope must contain exactly capability, tool, args/,
		);
	});

	it("applies a driver amendment during a real sandbox wave at the next semantic beat", async (t) => {
		const runtimeDir = mkdtempSync(join(tmpdir(), "choreograph-program-control-"));
		const runtime = new WorkflowRuntimeStore(join(runtimeDir, "runtime.sqlite"));
		t.after(() => {
			runtime.close();
			rmSync(runtimeDir, { recursive: true, force: true });
		});
		await runtime.init();
		await runtime.createWorkflowInstance({
			runId: "run-mid-wave",
			workflowName: "steerable-journey",
			graphId: "g1",
			ownerUserId: "user-local",
			inputs: {},
			startedAt: 1000,
		});
		const claim = await runtime.claimWorkflowDriver("run-mid-wave", {
			clientId: "vehicle-driver",
			claimTs: 1100,
			now: 1100,
			expectedRevision: 0,
		});
		assert.equal(claim?.control.driverLease?.epoch, 1);

		const gate = new BlockingGateCapability();
		const running = executeProgramWorkflow(
			{
				spawner,
				eventBus,
				ownerUserId: "user-local",
				timeoutMs: 10_000,
				capabilities: new Map([["test.gate", gate]]),
				control: new WorkflowProgramControlBackend(runtime, "run-mid-wave"),
			},
			compileWorkflow(STEERABLE_JOURNEY_PROGRAM),
			{
				beats: [
					{ id: "a", value: 1 },
					{ id: "b", value: 2 },
					{ id: "c", value: 3 },
				],
			},
		);
		await gate.firstStarted;

		let control = await runtime.getWorkflowControl("run-mid-wave");
		assert.equal(control?.currentBeat?.beatId, "a", "the first beat is genuinely in flight");
		const queue = async (
			amendmentId: string,
			kind: "skip" | "reorder" | "reparameterize" | "directive",
			payload: Record<string, unknown>,
			targetBeatId?: string,
		) => {
			control = await runtime.getWorkflowControl("run-mid-wave");
			const result = await runtime.queueWorkflowBeatAmendment("run-mid-wave", {
				clientId: "vehicle-driver",
				amendmentId,
				kind,
				...(targetBeatId ? { targetBeatId } : {}),
				payload,
				expectedRevision: control?.revision ?? -1,
				leaseEpoch: 1,
				now: Date.now(),
			});
			assert.equal(result?.applied, true);
		};
		await queue("reorder-c-b", "reorder", { order: ["c", "b"] });
		await queue("skip-b", "skip", {}, "b");
		await queue("reparam-c", "reparameterize", { parameters: { value: 30 } }, "c");
		await queue("direct-c", "directive", { text: "compare the amended value against the original" }, "c");
		gate.release();

		const result = await running;
		assert.deepEqual(result.output, {
			visits: [
				{ id: "a", value: 1, directives: [] },
				{
					id: "c",
					value: 30,
					directives: ["compare the amended value against the original"],
				},
			],
		});
		assert.deepEqual(
			result.effects,
			[
				{ capability: "test.gate", operation: "echo", outcome: "ok" },
				{ capability: "test.gate", operation: "echo", outcome: "ok" },
			],
			"internal beat control is not misreported as a world effect",
		);
		control = await runtime.getWorkflowControl("run-mid-wave");
		assert.deepEqual(
			control?.amendments.map((amendment) => [amendment.id, amendment.state, amendment.appliedBeatId]),
			[
				["reorder-c-b", "applied", "c"],
				["skip-b", "applied", "b"],
				["reparam-c", "applied", "c"],
				["direct-c", "applied", "c"],
			],
		);
	});

	it("honors a pause request before a real program beat without invoking its world capability", async (t) => {
		const runtimeDir = mkdtempSync(join(tmpdir(), "choreograph-program-pause-"));
		const runtime = new WorkflowRuntimeStore(join(runtimeDir, "runtime.sqlite"));
		t.after(() => {
			runtime.close();
			rmSync(runtimeDir, { recursive: true, force: true });
		});
		await runtime.init();
		await runtime.createWorkflowInstance({
			runId: "run-pause-at-beat",
			workflowName: "steerable-journey",
			graphId: "g1",
			ownerUserId: "user-local",
			inputs: {},
			startedAt: 1000,
		});
		await runtime.requestPause("run-pause-at-beat", { reason: "inspect next beat", now: 1100 });

		const gate = new EchoCapability("test.gate");
		await assert.rejects(
			executeProgramWorkflow(
				{
					spawner,
					eventBus,
					ownerUserId: "user-local",
					timeoutMs: 10_000,
					capabilities: new Map([["test.gate", gate]]),
					control: new WorkflowProgramControlBackend(runtime, "run-pause-at-beat", () => 1200),
				},
				compileWorkflow(STEERABLE_JOURNEY_PROGRAM),
				{ beats: [{ id: "a", value: 1 }] },
			),
			(error: unknown) => error instanceof InvocationFault && error.code === "workflow_paused",
		);

		const instance = await runtime.getWorkflowInstance("run-pause-at-beat");
		assert.equal(instance?.status, "paused");
		assert.deepEqual(JSON.parse(instance?.frontier_json ?? "{}"), {
			kind: "before-beat",
			beatId: "a",
			ts: 1200,
		});
		assert.equal(gate.calls, 0);
	});
});
