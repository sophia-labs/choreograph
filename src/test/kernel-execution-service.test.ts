import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type ExecutionCell,
	type ExecutionServiceHost,
	invokeKernelHostCapability,
	KernelExecutionService,
	KernelHostRequestFault,
	KernelSpawnFailure,
} from "../agent-runtime/execution-service.js";
import type { BusEvent } from "../event-bus.js";
import type { CapabilityBackend } from "../mnemosyne.js";

class FakeKernelHost implements ExecutionServiceHost {
	spawnCount = 0;
	killCount = 0;
	interruptCount = 0;
	emitExitOnKill = false;
	failFaultTestimony = false;
	failShutdownTestimony = false;
	failKill = false;
	unexpectedExits: Parameters<NonNullable<ExecutionServiceHost["handleUnexpectedKernelExit"]>>[0][] = [];
	emittedCells: ExecutionCell[] = [];
	kernelStates: Array<{
		sessionId: string;
		generation: number;
		activationId: string;
		state: "running" | "released" | "shutdown" | "faulted" | "cancelled";
		now: number;
	}> = [];
	private nextInput = 0;
	private readonly observers = new Map<string, (event: BusEvent) => void>();

	async spawnKernel(input: Parameters<ExecutionServiceHost["spawnKernel"]>[0]): Promise<{ sandboxId: string }> {
		const sandboxId = `kernel-${this.spawnCount++}`;
		this.recordKernelState({
			sessionId: input.sessionId,
			generation: input.generation,
			activationId: input.activationId,
			state: "running",
			now: 0,
		});
		return { sandboxId };
	}

	subscribeKernel(sandboxId: string, observer: (event: BusEvent) => void): () => void {
		this.observers.set(sandboxId, observer);
		return () => this.observers.delete(sandboxId);
	}

	executeKernel(): { inputId: string } {
		return { inputId: `input-${this.nextInput++}` };
	}

	interruptKernel(): void {
		this.interruptCount += 1;
	}

	async killKernel(sandboxId: string): Promise<void> {
		this.killCount += 1;
		if (this.failKill) throw new Error("kernel body did not exit");
		if (this.emitExitOnKill) {
			this.emit(sandboxId, { type: "kernel_exit", kernel: "python3", exit_code: 0, signal: null });
		}
	}

	emitCell(_agentSandboxId: string, cell: ExecutionCell): void {
		this.emittedCells.push(cell);
	}

	recordKernelState(input: (typeof this.kernelStates)[number]): void {
		if (this.failFaultTestimony && input.state === "faulted") throw new Error("kernel testimony unavailable");
		if (this.failShutdownTestimony && input.state === "shutdown") throw new Error("shutdown testimony unavailable");
		this.kernelStates.push(input);
	}

	handleUnexpectedKernelExit(input: (typeof this.unexpectedExits)[number]): void {
		this.unexpectedExits.push(input);
	}

	emit(sandboxId: string, event: Record<string, unknown>): void {
		this.observers.get(sandboxId)?.({
			category: "system",
			sandbox_id: sandboxId,
			ts: new Date().toISOString(),
			...event,
		} as BusEvent);
	}
}

describe("KernelExecutionService", () => {
	it("distinguishes zero-body kernel launch failure from verified post-spawn fault testimony", async () => {
		const zeroBodyHost = new FakeKernelHost();
		zeroBodyHost.spawnKernel = async () => {
			throw new KernelSpawnFailure("kernel executable missing", { bodyObserved: false, reaped: true });
		};
		const zeroBodyService = new KernelExecutionService(zeroBodyHost);
		await assert.rejects(
			zeroBodyService.acquire({
				sessionId: "kernel-zero-body",
				agentSandboxId: "worker-zero-body",
				ownerUserId: "u",
				generation: 0,
				activationId: "activation-zero-body",
			}),
			/kernel executable missing/,
		);
		assert.deepEqual(zeroBodyHost.kernelStates, []);

		const observedHost = new FakeKernelHost();
		observedHost.spawnKernel = async () => {
			throw new KernelSpawnFailure("kernel readiness failed", {
				bodyObserved: true,
				sandboxId: "kernel-readiness-failed",
				reaped: true,
			});
		};
		const observedService = new KernelExecutionService(observedHost, () => 42);
		await assert.rejects(
			observedService.acquire({
				sessionId: "kernel-observed-body",
				agentSandboxId: "worker-observed-body",
				ownerUserId: "u",
				generation: 0,
				activationId: "activation-observed-body",
			}),
			/kernel readiness failed/,
		);
		assert.deepEqual(
			observedHost.kernelStates.map((state) => state.state),
			["faulted"],
		);
	});

	it("retains failed kernel-spawn cleanup ownership until late verified reap", async () => {
		const host = new FakeKernelHost();
		host.failKill = true;
		host.spawnKernel = async () => {
			host.spawnCount += 1;
			throw new KernelSpawnFailure("kernel readiness failed before cleanup", {
				bodyObserved: true,
				sandboxId: "kernel-late-spawn-reap",
				reaped: false,
			});
		};
		const service = new KernelExecutionService(host, () => 44);
		const input = {
			sessionId: "kernel-late-spawn-reap-session",
			agentSandboxId: "worker-late-spawn-reap",
			ownerUserId: "u",
			generation: 0,
			activationId: "activation-late-spawn-reap",
		};
		await assert.rejects(service.acquire(input), /did not exit/);
		assert.equal(host.killCount, 1);
		assert.deepEqual(host.kernelStates, [], "terminal testimony waits for verified wrapper reap");
		host.failKill = false;
		await assert.rejects(service.acquire(input), /readiness failed before cleanup/);
		assert.equal(host.killCount, 2, "the next exact acquisition retries only the retained cleanup identity");
		assert.equal(host.spawnCount, 1, "cleanup retry cannot spawn a replacement kernel");
		assert.deepEqual(
			host.kernelStates.map((state) => state.state),
			["faulted"],
		);
	});

	it("makes retained failed-spawn cleanup an exact recovery barrier", async () => {
		const host = new FakeKernelHost();
		host.failKill = true;
		host.spawnKernel = async () => {
			throw new KernelSpawnFailure("bound kernel readiness failed", {
				bodyObserved: true,
				sandboxId: "kernel-recovery-owned-cleanup",
				reaped: false,
			});
		};
		const service = new KernelExecutionService(host, () => 47);
		const authority = {
			sessionId: "kernel-recovery-owned-cleanup-session",
			agentSandboxId: "worker-recovery-owned-cleanup",
			ownerUserId: "u",
			generation: 0,
			activationId: "activation-recovery-owned-cleanup",
		};
		await assert.rejects(service.acquire(authority), /did not exit/);
		await assert.rejects(service.reapForRecovery(authority.sessionId, 0), /did not exit/);
		assert.equal(host.killCount, 2);
		assert.deepEqual(host.kernelStates, [], "recovery cannot testify before verified reap");
		host.failKill = false;
		assert.equal(await service.reapForRecovery(authority.sessionId, 0), true);
		assert.equal(host.killCount, 3);
		assert.deepEqual(
			host.kernelStates.map((state) => state.state),
			["faulted"],
		);
		assert.equal(await service.reapForRecovery(authority.sessionId, 0), false);
	});

	it("coalesces one exact in-flight Session acquisition and rejects conflicting authority", async () => {
		const host = new FakeKernelHost();
		let releaseSpawn!: () => void;
		const spawnReleased = new Promise<void>((resolve) => {
			releaseSpawn = resolve;
		});
		host.spawnKernel = async () => {
			const sandboxId = `kernel-${host.spawnCount++}`;
			await spawnReleased;
			return { sandboxId };
		};
		const service = new KernelExecutionService(host);
		const authority = {
			sessionId: "coalesced-acquire",
			agentSandboxId: "worker-coalesced",
			ownerUserId: "u",
			generation: 0,
			activationId: "activation-coalesced",
		};
		const first = service.acquire(authority);
		const replay = service.acquire(authority);
		await assert.rejects(
			service.acquire({ ...authority, activationId: "activation-conflict" }),
			/concurrent kernel acquisition conflicts/i,
		);
		assert.equal(host.spawnCount, 1);
		releaseSpawn();
		assert.deepEqual(await replay, await first);
		assert.equal(host.spawnCount, 1);
		await service.shutdownAll();
	});

	it("fences pre-bind and pre-publication acquisition for cancellation or unexpected worker reap", async () => {
		const prebindHost = new FakeKernelHost();
		let prebindEntered!: () => void;
		const prebindStarted = new Promise<void>((resolve) => {
			prebindEntered = resolve;
		});
		prebindHost.spawnKernel = async (input) => {
			prebindEntered();
			await new Promise<void>((_resolve, reject) => {
				const aborted = () => reject(input.signal.reason);
				if (input.signal.aborted) aborted();
				else input.signal.addEventListener("abort", aborted, { once: true });
			});
			throw new Error("unreachable");
		};
		const prebindService = new KernelExecutionService(prebindHost);
		const prebindAuthority = {
			sessionId: "cancel-prebind-acquire",
			agentSandboxId: "worker-cancel-prebind",
			ownerUserId: "u",
			generation: 0,
			activationId: "activation-cancel-prebind",
		};
		const prebindAcquire = prebindService.acquire(prebindAuthority);
		await prebindStarted;
		const prebindReap = prebindService.reapSessionAcquisition(
			prebindAuthority.sessionId,
			0,
			prebindAuthority.activationId,
			"cancelled",
		);
		await assert.rejects(prebindAcquire, /fenced for Session reap/);
		assert.equal(await prebindReap, true);
		assert.equal(prebindHost.killCount, 0);
		assert.deepEqual(prebindHost.kernelStates, [], "pre-bind cancellation has no kernel body testimony");
		assert.equal(prebindService.getLeaseForSession(prebindAuthority.sessionId), undefined);

		for (const terminalState of ["cancelled", "faulted"] as const) {
			const host = new FakeKernelHost();
			let spawnEntered!: () => void;
			let releaseSpawn!: () => void;
			const entered = new Promise<void>((resolve) => {
				spawnEntered = resolve;
			});
			const released = new Promise<void>((resolve) => {
				releaseSpawn = resolve;
			});
			host.spawnKernel = async (input) => {
				host.spawnCount += 1;
				host.recordKernelState({ ...input, state: "running", now: 1 });
				spawnEntered();
				await released;
				return { sandboxId: `kernel-${terminalState}-prepublish` };
			};
			const service = new KernelExecutionService(host, () => 2);
			const authority = {
				sessionId: `${terminalState}-prepublish-acquire`,
				agentSandboxId: `worker-${terminalState}-prepublish`,
				ownerUserId: "u",
				generation: 0,
				activationId: `activation-${terminalState}-prepublish`,
			};
			const acquiring = service.acquire(authority);
			await entered;
			const reap = service.reapSessionAcquisition(authority.sessionId, 0, authority.activationId, terminalState);
			assert.equal(service.getLeaseForSession(authority.sessionId), undefined);
			releaseSpawn();
			await assert.rejects(acquiring, /reaped before lease publication/);
			assert.equal(await reap, true);
			assert.equal(host.killCount, 1);
			assert.deepEqual(
				host.kernelStates.map((state) => state.state),
				["running", terminalState],
			);
			assert.equal(service.getLeaseForSession(authority.sessionId), undefined);
		}
	});

	it("reaps a kernel whose spawn resolves after the shutdown latch without installing a lease", async () => {
		const host = new FakeKernelHost();
		let releaseSpawn!: () => void;
		const spawnReleased = new Promise<void>((resolve) => {
			releaseSpawn = resolve;
		});
		host.spawnKernel = async () => {
			host.spawnCount += 1;
			await spawnReleased;
			return { sandboxId: "kernel-shutdown-race" };
		};
		const service = new KernelExecutionService(host);
		const acquiring = service.acquire({
			sessionId: "shutdown-acquire-race",
			agentSandboxId: "worker-shutdown-race",
			ownerUserId: "u",
			generation: 0,
			activationId: "activation-shutdown-race",
		});
		const shutdown = service.shutdownAll();
		releaseSpawn();
		await assert.rejects(acquiring, /shut down during kernel spawn/);
		await shutdown;
		assert.equal(host.killCount, 1);
		assert.equal(service.getLeaseForSession("shutdown-acquire-race"), undefined);
	});

	it("treats an observed wrapper Sandbox exit as the exact unexpected kernel failure", async () => {
		const host = new FakeKernelHost();
		host.interruptKernel = () => {
			throw new Error("kernel wrapper is already gone");
		};
		const service = new KernelExecutionService(host);
		const lease = await service.acquire({
			sessionId: "wrapper-exit",
			agentSandboxId: "worker-wrapper-exit",
			ownerUserId: "u",
			generation: 0,
			activationId: "activation-wrapper-exit",
		});
		const controller = new AbortController();
		const executing = service.execute(lease.leaseId, "await blocked()", controller.signal);
		assert.doesNotThrow(() => controller.abort(new Error("paired worker is closing")));
		await service.observeKernelSandboxExit(lease.kernelSandboxId, { exitCode: 9, signal: "SIGKILL" });
		await assert.rejects(executing, /unexpectedly/);
		assert.equal(service.getLease(lease.leaseId), undefined);
		assert.deepEqual(
			host.kernelStates.map(({ state }) => state),
			["running", "faulted"],
		);
		assert.equal(host.unexpectedExits.length, 1);
	});

	it("keeps a detached unexpected termination visible to shutdown until durable cleanup settles", async () => {
		const host = new FakeKernelHost();
		let enterFaultWrite!: () => void;
		const faultWriteEntered = new Promise<void>((resolve) => {
			enterFaultWrite = resolve;
		});
		let releaseFaultWrite!: () => void;
		const faultWriteReleased = new Promise<void>((resolve) => {
			releaseFaultWrite = resolve;
		});
		host.recordKernelState = async (input) => {
			if (input.state === "faulted") {
				enterFaultWrite();
				await faultWriteReleased;
			}
			host.kernelStates.push(input);
		};
		const service = new KernelExecutionService(host);
		const lease = await service.acquire({
			sessionId: "detached-shutdown-tail",
			agentSandboxId: "worker-detached-tail",
			ownerUserId: "u",
			generation: 0,
			activationId: "activation-detached-tail",
		});
		const exiting = service.observeKernelSandboxExit(lease.kernelSandboxId, { exitCode: 9, signal: "SIGKILL" });
		await faultWriteEntered;
		assert.equal(service.getLease(lease.leaseId), undefined, "lease detaches before durable fault write settles");
		let shutdownFinished = false;
		const shutdown = service.shutdownAll().then(() => {
			shutdownFinished = true;
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
		assert.equal(shutdownFinished, false, "shutdown must retain detached termination ownership");
		releaseFaultWrite();
		await Promise.all([exiting, shutdown]);
		assert.equal(host.unexpectedExits.length, 1);
		assert.deepEqual(
			host.kernelStates.map(({ state }) => state),
			["running", "faulted"],
		);
	});

	it("fences every normal lease operation once verified cancellation reap begins", async () => {
		const host = new FakeKernelHost();
		let enterKill!: () => void;
		const killEntered = new Promise<void>((resolve) => {
			enterKill = resolve;
		});
		let releaseKill!: () => void;
		const killReleased = new Promise<void>((resolve) => {
			releaseKill = resolve;
		});
		host.killKernel = async () => {
			host.killCount += 1;
			enterKill();
			await killReleased;
		};
		const service = new KernelExecutionService(host);
		const lease = await service.acquire({
			sessionId: "cancel-operation-fence",
			agentSandboxId: "worker-operation-fence",
			ownerUserId: "u",
			generation: 0,
			activationId: "activation-operation-fence",
		});
		const cancelling = service.cancel(lease.leaseId);
		await killEntered;
		await assert.rejects(service.execute(lease.leaseId, "print('too late')"), /already being reaped/);
		await assert.rejects(service.release(lease.leaseId), /already being reaped/);
		await assert.rejects(
			service.acquire({
				sessionId: "cancel-operation-fence",
				agentSandboxId: "replacement-worker",
				ownerUserId: "u",
				generation: 0,
				activationId: "activation-operation-fence",
			}),
			/already being reaped/,
		);
		assert.throws(() => service.interrupt(lease.leaseId), /already being reaped/);
		assert.equal(host.executeKernel().inputId, "input-0", "rejected execute did not reach the kernel adapter");
		releaseKill();
		await cancelling;
		assert.equal(host.killCount, 1);
		assert.deepEqual(
			host.kernelStates.map(({ state }) => state),
			["running", "cancelled"],
		);
	});

	it("retains a visible lease and writes no terminal testimony until physical kernel reap is verified", async () => {
		const host = new FakeKernelHost();
		const service = new KernelExecutionService(host);
		const lease = await service.acquire({
			sessionId: "shutdown-uncooperative",
			agentSandboxId: "worker-uncooperative",
			ownerUserId: "u",
			generation: 0,
			activationId: "activation-uncooperative",
		});
		host.failKill = true;
		await assert.rejects(service.shutdown(lease.leaseId), /did not exit/);
		assert.equal(service.getLease(lease.leaseId)?.kernelSandboxId, lease.kernelSandboxId);
		assert.deepEqual(
			host.kernelStates.map(({ state }) => state),
			["running"],
			"failed physical reap must not invent terminal kernel testimony",
		);
		host.failKill = false;
		await service.shutdown(lease.leaseId);
		assert.equal(service.getLease(lease.leaseId), undefined);
		assert.deepEqual(
			host.kernelStates.map(({ state }) => state),
			["running", "shutdown"],
		);
	});

	it("physically reaps every kernel and completes shutdown when durable shutdown testimony is deferred", async () => {
		const host = new FakeKernelHost();
		const service = new KernelExecutionService(host);
		const first = await service.acquire({
			sessionId: "shutdown-a",
			agentSandboxId: "worker-a",
			ownerUserId: "u",
			generation: 0,
			activationId: "activation-a",
		});
		const second = await service.acquire({
			sessionId: "shutdown-b",
			agentSandboxId: "worker-b",
			ownerUserId: "u",
			generation: 0,
			activationId: "activation-b",
		});
		host.failShutdownTestimony = true;
		const originalError = console.error;
		const errors: string[] = [];
		console.error = (...args: unknown[]) => errors.push(args.map(String).join(" "));
		try {
			await service.shutdownAll();
		} finally {
			console.error = originalError;
		}
		assert.equal(host.killCount, 2);
		assert.equal(service.getLease(first.leaseId), undefined);
		assert.equal(service.getLease(second.leaseId), undefined);
		assert.equal(errors.filter((entry) => entry.includes("deferred to recovery")).length, 2);
	});

	it("terminates allowlisted kernel host requests at the capability gate with typed denial", async () => {
		let calls = 0;
		const backend: CapabilityBackend = {
			capabilityName: "mnemosyne",
			accessLevel: "ro",
			listTools: async () => [{ name: "search_documents", destructive: false }],
			callTool: async (tool, args) => {
				calls += 1;
				return { tool, query: args.query, documents: ["doc-1"] };
			},
			close: async () => {},
		};
		const registry = new Map([["mnemosyne", backend]]);
		const granted = await invokeKernelHostCapability(registry, {
			type: "capability.call",
			capability: "mnemosyne",
			tool: "search_documents",
			args: { query: "kernel" },
		});
		assert.deepEqual(granted.result, { tool: "search_documents", query: "kernel", documents: ["doc-1"] });
		assert.equal(calls, 1);
		await assert.rejects(
			() =>
				invokeKernelHostCapability(registry, {
					type: "capability.call",
					capability: "mnemosyne",
					tool: "insert_blocks",
					args: {},
				}),
			(error: unknown) =>
				error instanceof KernelHostRequestFault &&
				error.code === "capability_denied" &&
				error.errorClass === "denied",
		);
		assert.equal(calls, 1, "ungranted tool must never reach the backend");
		await assert.rejects(
			() => invokeKernelHostCapability(registry, { type: "goal.complete" }),
			(error: unknown) => error instanceof KernelHostRequestFault && error.errorClass === "denied",
		);
	});

	it("keeps the leased kernel body across worker replacement and journals completed cells", async () => {
		let now = 1_000;
		const host = new FakeKernelHost();
		const service = new KernelExecutionService(host, () => now);
		const first = await service.acquire({
			sessionId: "session-1",
			agentSandboxId: "worker-1",
			ownerUserId: "u1",
			generation: 0,
			activationId: "activation-0",
			idleMs: 60_000,
		});
		const execution = service.execute(first.leaseId, "x = 40\nx + 2");
		host.emit(first.kernelSandboxId, { type: "kernel_stream", input_id: "input-0", name: "stdout", text: "hello\n" });
		host.emit(first.kernelSandboxId, {
			type: "kernel_result",
			input_id: "input-0",
			data: { "text/plain": "42" },
			execution_count: 1,
		});
		host.emit(first.kernelSandboxId, { type: "kernel_reply", input_id: "input-0", status: "ok", execution_count: 1 });
		service.recordHostRequest(first.kernelSandboxId, "input-0", {
			requestId: "host-1",
			payload: { type: "capability.call", capability: "mnemosyne", tool: "search_documents", args: {} },
			ok: true,
			result: { result: { documents: ["doc-1"] } },
		});
		now = 1_025;
		host.emit(first.kernelSandboxId, { type: "kernel_idle", input_id: "input-0" });
		const result = await execution;
		assert.equal(result.result, "42");
		assert.equal(result.cellRef, "compute.cell:session-1:0:0");
		assert.equal(host.emittedCells[0]?.code, "x = 40\nx + 2");
		assert.deepEqual(
			host.emittedCells[0]?.outputs.map((output) => output.kind),
			["stream", "result"],
		);
		assert.equal(host.emittedCells[0]?.hostRequests.length, 1);
		assert.match(host.emittedCells[0]?.hostRequests[0]?.digest ?? "", /^sha256:[0-9a-f]{64}$/);
		assert.match(host.emittedCells[0]?.cellDigest ?? "", /^sha256:[0-9a-f]{64}$/);

		await service.release(first.leaseId);
		const replacement = await service.acquire({
			sessionId: "session-1",
			agentSandboxId: "worker-2",
			ownerUserId: "u1",
			generation: 0,
			activationId: "activation-0",
			idleMs: 60_000,
		});
		assert.equal(replacement.leaseId, first.leaseId);
		assert.equal(replacement.kernelSandboxId, first.kernelSandboxId);
		assert.equal(host.spawnCount, 1, "worker replacement must not spawn a second kernel");
		assert.equal(host.killCount, 0, "release detaches the worker but retains the leased kernel");
		assert.equal(service.getLease(first.leaseId)?.agentSandboxId, "worker-2");
		await service.shutdown(first.leaseId);
		assert.equal(host.killCount, 1);
		assert.deepEqual(
			host.kernelStates.map(({ sessionId, generation, state }) => ({ sessionId, generation, state })),
			[
				{ sessionId: "session-1", generation: 0, state: "running" },
				{ sessionId: "session-1", generation: 0, state: "released" },
				{ sessionId: "session-1", generation: 0, state: "running" },
				{ sessionId: "session-1", generation: 0, state: "shutdown" },
			],
		);
	});

	it("executes runtime bootstrap cells without projecting them as agent notebook cells", async () => {
		const host = new FakeKernelHost();
		const service = new KernelExecutionService(host);
		const lease = await service.acquire({
			sessionId: "s",
			agentSandboxId: "w",
			ownerUserId: "u",
			generation: 0,
			activationId: "activation-0",
		});
		const execution = service.execute(lease.leaseId, "# runtime bootstrap", undefined, true);
		host.emit(lease.kernelSandboxId, { type: "kernel_reply", input_id: "input-0", status: "ok", execution_count: 1 });
		host.emit(lease.kernelSandboxId, { type: "kernel_idle", input_id: "input-0" });
		const result = await execution;
		assert.equal(result.status, "ok");
		assert.equal(result.cellRef, undefined);
		assert.deepEqual(host.emittedCells, []);
		await service.shutdown(lease.leaseId);
	});

	it("interrupts an aborted cross-body execution immediately", async () => {
		const host = new FakeKernelHost();
		const service = new KernelExecutionService(host);
		const lease = await service.acquire({
			sessionId: "s",
			agentSandboxId: "w",
			ownerUserId: "u",
			generation: 0,
			activationId: "activation-0",
		});
		const controller = new AbortController();
		const execution = service.execute(lease.leaseId, "sleep(60)", controller.signal);
		const started = Date.now();
		controller.abort();
		assert.equal(host.interruptCount, 1);
		assert.ok(Date.now() - started < 10_000);
		host.emit(lease.kernelSandboxId, {
			type: "kernel_error",
			input_id: "input-0",
			ename: "KeyboardInterrupt",
			evalue: "",
			traceback: [],
		});
		host.emit(lease.kernelSandboxId, { type: "kernel_idle", input_id: "input-0" });
		assert.equal((await execution).status, "aborted");
		await service.shutdown(lease.leaseId);
	});

	it("faults an unexpected kernel exit and ignores the exit caused by an expected shutdown", async () => {
		const host = new FakeKernelHost();
		const service = new KernelExecutionService(host, () => 4_000);
		const lease = await service.acquire({
			sessionId: "session-exit",
			agentSandboxId: "worker-exit",
			ownerUserId: "u",
			generation: 2,
			activationId: "activation-exit",
		});
		const execution = service.execute(lease.leaseId, "sleep(60)");
		host.emit(lease.kernelSandboxId, {
			type: "kernel_exit",
			kernel: "python3",
			exit_code: 17,
			signal: null,
		});
		await assert.rejects(execution, /Kernel body exited unexpectedly/);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(service.getLease(lease.leaseId), undefined);
		assert.equal(service.getLeaseForSession("session-exit"), undefined);
		assert.equal(host.killCount, 1, "the inner exit still requires verified wrapper Sandbox reap");
		assert.deepEqual(
			host.kernelStates.map(({ state }) => state),
			["running", "faulted"],
		);
		assert.deepEqual(host.unexpectedExits, [
			{
				leaseId: lease.leaseId,
				sessionId: "session-exit",
				generation: 2,
				activationId: "activation-exit",
				agentSandboxId: "worker-exit",
				kernelSandboxId: lease.kernelSandboxId,
				exitCode: 17,
				signal: null,
			},
		]);

		const expected = await service.acquire({
			sessionId: "session-shutdown",
			agentSandboxId: "worker-shutdown",
			ownerUserId: "u",
			generation: 0,
			activationId: "activation-shutdown",
		});
		host.emitExitOnKill = true;
		await service.shutdown(expected.leaseId);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(host.unexpectedExits.length, 1, "service-driven kernel exit must not double-fault");
		assert.deepEqual(
			host.kernelStates.map(({ state }) => state),
			["running", "faulted", "running", "shutdown"],
		);
	});

	it("keeps an unexpected-exit lease visible until wrapper Sandbox reap is verified", async () => {
		const host = new FakeKernelHost();
		const service = new KernelExecutionService(host);
		const lease = await service.acquire({
			sessionId: "session-unreaped-exit",
			agentSandboxId: "worker-unreaped-exit",
			ownerUserId: "u",
			generation: 0,
			activationId: "activation-unreaped-exit",
			idleMs: 5,
		});
		const execution = service.execute(lease.leaseId, "sleep(60)");
		host.failKill = true;
		host.emit(lease.kernelSandboxId, {
			type: "kernel_exit",
			kernel: "python3",
			exit_code: 9,
			signal: "SIGKILL",
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		await new Promise<void>((resolve) => setTimeout(resolve, 15));
		assert.equal(service.getLease(lease.leaseId)?.kernelSandboxId, lease.kernelSandboxId);
		assert.deepEqual(
			host.kernelStates.map(({ state }) => state),
			["running"],
		);
		assert.equal(host.unexpectedExits.length, 0, "worker/materialization cleanup cannot precede kernel reap");
		await assert.rejects(service.release(lease.leaseId), /awaiting verified unexpected-exit reap/);
		assert.deepEqual(
			host.kernelStates.map(({ state }) => state),
			["running"],
			"the superseded idle timer cannot rewrite unexpected failure as shutdown",
		);

		host.failKill = false;
		host.emit(lease.kernelSandboxId, {
			type: "kernel_exit",
			kernel: "python3",
			exit_code: 9,
			signal: "SIGKILL",
		});
		await assert.rejects(execution, /Kernel body exited unexpectedly/);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(service.getLease(lease.leaseId), undefined);
		assert.deepEqual(
			host.kernelStates.map(({ state }) => state),
			["running", "faulted"],
		);
		assert.equal(host.unexpectedExits.length, 1);
	});

	it("hands unexpected-exit cleanup to the host even when durable kernel testimony fails", async () => {
		const host = new FakeKernelHost();
		host.failFaultTestimony = true;
		const service = new KernelExecutionService(host);
		const lease = await service.acquire({
			sessionId: "session-testimony-failure",
			agentSandboxId: "worker-testimony-failure",
			ownerUserId: "u",
			generation: 0,
			activationId: "activation-testimony-failure",
		});
		host.emit(lease.kernelSandboxId, {
			type: "kernel_exit",
			kernel: "python3",
			exit_code: 9,
			signal: null,
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(service.getLease(lease.leaseId), undefined);
		assert.equal(host.unexpectedExits.length, 1, "physical cleanup/recovery handoff must not depend on the DB write");
		assert.equal(host.unexpectedExits[0]?.activationId, "activation-testimony-failure");
		assert.deepEqual(
			host.kernelStates.map(({ state }) => state),
			["running"],
		);
	});
});
