import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "@sophia-labs/canonical-json";
import type { BusEvent } from "../event-bus.js";
import type { CapabilityBackend } from "../mnemosyne.js";

const DEFAULT_LEASE_IDLE_MS = 15 * 60_000;
const DEFAULT_EXECUTE_TIMEOUT_MS = 120_000;

export interface ExecutionCellOutput {
	kind: "stream" | "display" | "result" | "error";
	name?: string;
	text?: string;
	data?: unknown;
	metadata?: unknown;
	error?: { ename: string; evalue: string; traceback: string[] };
}

export interface ExecutionCell {
	schema: "choreograph.compute-cell.v1";
	cellRef: string;
	sessionId: string;
	leaseId: string;
	kernelSandboxId: string;
	inputId: string;
	ordinal: number;
	generation: number;
	code: string;
	status: "ok" | "error" | "aborted";
	executionCount?: number;
	outputs: ExecutionCellOutput[];
	startedAt: number;
	completedAt: number;
	durationMs: number;
	hostRequests: KernelHostRequestTestimony[];
	cellDigest: string;
}

export interface KernelHostRequestTestimony {
	readonly requestId: string;
	readonly inputId: string;
	readonly payload: Record<string, unknown>;
	readonly ok: boolean;
	readonly result?: unknown;
	readonly error?: unknown;
	readonly digest: string;
}

export interface KernelReplayReport {
	readonly method: "journal";
	readonly status: "restored" | "diverged";
	readonly replayedCells: number;
	readonly namespace: string[];
	readonly expectedNamespace: string[];
	readonly divergence?: { readonly cellRef?: string; readonly reason: string };
}

export interface KernelSnapshotCapture {
	readonly pythonVersion: string;
	readonly pythonImplementation: string;
	readonly pythonCacheTag: string;
	readonly dillVersion: string;
	readonly namespace: string[];
	readonly skipped: Record<string, string>;
	readonly payload: Buffer;
}

export interface ExecutionResult {
	stdout: string;
	stderr: string;
	result?: string;
	status: "ok" | "error" | "aborted";
	error?: { ename: string; evalue: string; traceback: string[] };
	durationMs: number;
	cellRef?: string;
}

export interface ExecutionServiceHost {
	/**
	 * The host must durably reserve the exact sandbox before process preparation
	 * and atomically bind running kernel testimony in its observed-spawn hook
	 * before resolving this call.
	 */
	spawnKernel(input: {
		ownerUserId: string;
		timeoutMs: number;
		sessionId: string;
		generation: number;
		activationId: string;
		signal: AbortSignal;
	}): Promise<{ sandboxId: string }>;
	subscribeKernel(sandboxId: string, observer: (event: BusEvent) => void): () => void;
	executeKernel(sandboxId: string, code: string): { inputId: string };
	interruptKernel(sandboxId: string): void;
	killKernel(sandboxId: string): Promise<void>;
	emitCell(agentSandboxId: string, cell: ExecutionCell): void | Promise<void>;
	recordKernelState?(input: {
		sessionId: string;
		generation: number;
		activationId: string;
		state: "running" | "released" | "shutdown" | "faulted" | "cancelled";
		now: number;
	}): void | Promise<void>;
	handleUnexpectedKernelExit?(input: {
		leaseId: string;
		sessionId: string;
		generation: number;
		activationId: string;
		agentSandboxId: string;
		kernelSandboxId: string;
		exitCode: number | null;
		signal: string | null;
	}): void | Promise<void>;
}

export interface AcquireKernelInput {
	sessionId: string;
	agentSandboxId: string;
	ownerUserId: string;
	generation: number;
	activationId: string;
	idleMs?: number;
}

export interface KernelCapabilityInvocation {
	capability: string;
	tool: string;
	args: Record<string, unknown>;
	result: unknown;
}

export class KernelHostRequestFault extends Error {
	readonly retryable = false;

	constructor(
		readonly code: string,
		readonly errorClass: "invalid" | "denied" | "not_found",
		message: string,
	) {
		super(message);
		this.name = "KernelHostRequestFault";
	}
}

export class KernelCleanupUnavailable extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KernelCleanupUnavailable";
	}
}

/** Exact kernel-wrapper launch boundary testimony from the physical host. */
export class KernelSpawnFailure extends Error {
	readonly bodyObserved: boolean;
	readonly sandboxId?: string;
	readonly reaped: boolean;

	constructor(
		message: string,
		input: { bodyObserved: boolean; sandboxId?: string; reaped: boolean; cause?: unknown },
	) {
		super(message, input.cause === undefined ? undefined : { cause: input.cause });
		this.name = "KernelSpawnFailure";
		this.bodyObserved = input.bodyObserved;
		this.sandboxId = input.sandboxId;
		this.reaped = input.reaped;
	}
}

/**
 * The sole kernel→authority lane. It accepts only the typed capability.call
 * envelope and checks both the bound capability and its advertised tool list.
 * No Prime worker object participates in this function.
 */
export async function invokeKernelHostCapability(
	registry: ReadonlyMap<string, CapabilityBackend> | undefined,
	payload: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<KernelCapabilityInvocation> {
	if (payload.type !== "capability.call") {
		throw new KernelHostRequestFault(
			"kernel_host_request_denied",
			"denied",
			`Kernel host request type ${JSON.stringify(payload.type)} is not allowlisted`,
		);
	}
	const capability = typeof payload.capability === "string" ? payload.capability : "";
	const tool = typeof payload.tool === "string" ? payload.tool : "";
	if (!capability || !tool) {
		throw new KernelHostRequestFault(
			"kernel_host_request_invalid",
			"invalid",
			"Kernel capability request requires capability and tool",
		);
	}
	const args =
		payload.args && typeof payload.args === "object" && !Array.isArray(payload.args)
			? (payload.args as Record<string, unknown>)
			: {};
	const backend = registry?.get(capability);
	if (!backend) {
		throw new KernelHostRequestFault("capability_denied", "denied", `Capability ${capability} is not granted`);
	}
	const tools = await backend.listTools();
	if (!tools.some((descriptor) => descriptor.name === tool)) {
		throw new KernelHostRequestFault("capability_denied", "denied", `Tool ${capability}.${tool} is not granted`);
	}
	return { capability, tool, args, result: await backend.callTool(tool, args, signal) };
}

interface PendingExecution {
	inputId: string;
	code: string;
	startedAt: number;
	stdout: string;
	stderr: string;
	result?: string;
	error?: ExecutionResult["error"];
	executionCount?: number;
	outputs: ExecutionCellOutput[];
	hostRequests: KernelHostRequestTestimony[];
	internal: boolean;
	aborted: boolean;
	settled: boolean;
	resolve: (result: ExecutionResult) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	abortCleanup?: () => void;
}

interface KernelLease {
	leaseId: string;
	sessionId: string;
	agentSandboxId: string;
	ownerUserId: string;
	generation: number;
	activationId: string;
	kernelSandboxId: string;
	nextOrdinal: number;
	pending: Map<string, PendingExecution>;
	unsubscribe: () => void;
	expiresAt: number;
	expiryTimer?: ReturnType<typeof setTimeout>;
	/** Inner-kernel death owns the terminal outcome until verified wrapper reap. */
	unexpectedExit?: Extract<BusEvent, { category: "system"; type: "kernel_exit" }>;
	unexpectedRetryTimer?: ReturnType<typeof setTimeout>;
	/** One verified physical reap in flight. Present before the host kill is invoked. */
	termination?: Promise<void>;
}

interface FailedKernelSpawnCleanup {
	readonly input: AcquireKernelInput;
	readonly sandboxId: string;
	readonly failure: KernelSpawnFailure;
	readonly terminalState: "shutdown" | "faulted" | "cancelled" | null;
	reaped: boolean;
}

interface KernelSessionReapFence {
	readonly generation: number;
	readonly activationId: string;
	readonly terminalState: "shutdown" | "faulted" | "cancelled" | null;
}

/**
 * Host-owned leased kernel bodies. Prime workers only hold opaque lease ids;
 * killing or replacing a worker does not kill the independent kernel sandbox.
 */
export class KernelExecutionService {
	private readonly bySession = new Map<string, KernelLease>();
	private readonly byLease = new Map<string, KernelLease>();
	private readonly acquiringBySession = new Map<
		string,
		{
			input: Pick<AcquireKernelInput, "agentSandboxId" | "ownerUserId" | "generation" | "activationId">;
			controller: AbortController;
			promise: Promise<{ leaseId: string; kernelSandboxId: string; expiresAt: number }>;
		}
	>();
	private readonly failedSpawnCleanupBySession = new Map<string, FailedKernelSpawnCleanup>();
	private readonly sessionReapFences = new Map<string, KernelSessionReapFence>();
	private readonly terminationTasks = new Set<Promise<void>>();
	private shuttingDown = false;

	constructor(
		private readonly host: ExecutionServiceHost,
		private readonly now: () => number = Date.now,
	) {}

	async acquire(input: AcquireKernelInput): Promise<{ leaseId: string; kernelSandboxId: string; expiresAt: number }> {
		if (this.shuttingDown) throw new KernelCleanupUnavailable("Kernel execution service is shutting down");
		if (this.sessionReapFences.has(input.sessionId)) {
			throw new KernelCleanupUnavailable("Kernel Session is fenced for verified reap");
		}
		const acquiring = this.acquiringBySession.get(input.sessionId);
		if (acquiring) {
			if (
				acquiring.input.agentSandboxId !== input.agentSandboxId ||
				acquiring.input.ownerUserId !== input.ownerUserId ||
				acquiring.input.generation !== input.generation ||
				acquiring.input.activationId !== input.activationId
			) {
				throw new Error("Concurrent kernel acquisition conflicts with the active Session authority");
			}
			return acquiring.promise;
		}
		const existing = this.bySession.get(input.sessionId);
		if (existing) {
			this.assertLeaseUsable(existing);
			if (input.generation < existing.generation) throw new Error("Stale generation cannot acquire a kernel lease");
			if (input.generation > existing.generation) {
				throw new Error("A new generation must restore the session kernel before acquiring it");
			}
			if (input.activationId !== existing.activationId) {
				throw new Error("A kernel lease cannot cross materialization activations");
			}
			existing.agentSandboxId = input.agentSandboxId;
			this.renew(existing, input.idleMs);
			await this.recordState(existing, "running");
			return this.project(existing);
		}
		const controller = new AbortController();
		let promise!: Promise<{ leaseId: string; kernelSandboxId: string; expiresAt: number }>;
		promise = this.acquireNewLease(input, controller.signal).finally(() => {
			if (this.acquiringBySession.get(input.sessionId)?.promise === promise) {
				this.acquiringBySession.delete(input.sessionId);
			}
		});
		this.acquiringBySession.set(input.sessionId, { input, controller, promise });
		return promise;
	}

	private async acquireNewLease(
		input: AcquireKernelInput,
		signal: AbortSignal,
	): Promise<{ leaseId: string; kernelSandboxId: string; expiresAt: number }> {
		if (signal.aborted || this.sessionReapFences.has(input.sessionId)) {
			throw new KernelCleanupUnavailable("Kernel acquisition was fenced before process preparation");
		}
		const pendingCleanup = this.failedSpawnCleanupBySession.get(input.sessionId);
		if (pendingCleanup) {
			if (
				pendingCleanup.input.agentSandboxId !== input.agentSandboxId ||
				pendingCleanup.input.ownerUserId !== input.ownerUserId ||
				pendingCleanup.input.generation !== input.generation ||
				pendingCleanup.input.activationId !== input.activationId
			) {
				throw new KernelCleanupUnavailable(
					"A failed kernel launch still owns cleanup under different Session authority",
				);
			}
			await this.finishFailedKernelSpawnCleanup(pendingCleanup);
			throw pendingCleanup.failure;
		}
		let spawned: { sandboxId: string };
		try {
			spawned = await this.host.spawnKernel({
				ownerUserId: input.ownerUserId,
				timeoutMs: Math.max(DEFAULT_LEASE_IDLE_MS * 2, (input.idleMs ?? DEFAULT_LEASE_IDLE_MS) * 2),
				sessionId: input.sessionId,
				generation: input.generation,
				activationId: input.activationId,
				signal,
			});
		} catch (error) {
			if (error instanceof KernelSpawnFailure && error.bodyObserved) {
				if (!error.sandboxId) {
					throw new KernelCleanupUnavailable("Observed kernel launch failure lost its cleanup identity");
				}
				const activeFence = this.sessionReapFences.get(input.sessionId);
				const cleanup: FailedKernelSpawnCleanup = {
					input,
					sandboxId: error.sandboxId,
					failure: error,
					terminalState: activeFence ? activeFence.terminalState : "faulted",
					reaped: error.reaped,
				};
				this.failedSpawnCleanupBySession.set(input.sessionId, cleanup);
				await this.finishFailedKernelSpawnCleanup(cleanup);
			}
			throw error;
		}
		const lease: KernelLease = {
			leaseId: `kls_${randomUUID()}`,
			sessionId: input.sessionId,
			agentSandboxId: input.agentSandboxId,
			ownerUserId: input.ownerUserId,
			generation: input.generation,
			activationId: input.activationId,
			kernelSandboxId: spawned.sandboxId,
			nextOrdinal: 0,
			pending: new Map(),
			unsubscribe: () => {},
			expiresAt: 0,
		};
		lease.unsubscribe = this.host.subscribeKernel(lease.kernelSandboxId, (event) => this.observe(lease, event));
		this.bySession.set(lease.sessionId, lease);
		this.byLease.set(lease.leaseId, lease);
		const reapFence = this.sessionReapFences.get(input.sessionId);
		if (this.shuttingDown || reapFence) {
			if (
				reapFence &&
				(reapFence.generation !== input.generation || reapFence.activationId !== input.activationId)
			) {
				await this.expire(lease, "faulted");
				throw new KernelCleanupUnavailable("Kernel acquisition crossed a conflicting Session reap fence");
			}
			await this.expire(lease, reapFence ? reapFence.terminalState : "shutdown");
			throw new KernelCleanupUnavailable(
				this.shuttingDown
					? "Kernel execution service shut down during kernel spawn"
					: "Kernel acquisition was reaped before lease publication",
			);
		}
		this.renew(lease, input.idleMs);
		return this.project(lease);
	}

	private async finishFailedKernelSpawnCleanup(cleanup: FailedKernelSpawnCleanup): Promise<void> {
		if (!cleanup.reaped) {
			await this.host.killKernel(cleanup.sandboxId);
			cleanup.reaped = true;
		}
		if (cleanup.terminalState) {
			await this.host.recordKernelState?.({
				sessionId: cleanup.input.sessionId,
				generation: cleanup.input.generation,
				activationId: cleanup.input.activationId,
				state: cleanup.terminalState,
				now: this.now(),
			});
		}
		if (this.failedSpawnCleanupBySession.get(cleanup.input.sessionId) === cleanup) {
			this.failedSpawnCleanupBySession.delete(cleanup.input.sessionId);
		}
	}

	async execute(leaseId: string, code: string, signal?: AbortSignal, internal = false): Promise<ExecutionResult> {
		const lease = this.requireLease(leaseId);
		this.assertLeaseUsable(lease);
		this.renew(lease);
		const startedAt = this.now();
		const submitted = this.host.executeKernel(lease.kernelSandboxId, code);
		return new Promise<ExecutionResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				const pending = lease.pending.get(submitted.inputId);
				if (!pending || pending.settled) return;
				pending.settled = true;
				lease.pending.delete(submitted.inputId);
				try {
					this.host.interruptKernel(lease.kernelSandboxId);
				} catch {
					// A concurrent verified kernel exit may already have removed the
					// wrapper. Timeout still owns rejection of this pending cell.
				}
				reject(new Error(`Kernel cell ${submitted.inputId} timed out`));
			}, DEFAULT_EXECUTE_TIMEOUT_MS);
			const pending: PendingExecution = {
				inputId: submitted.inputId,
				code,
				startedAt,
				stdout: "",
				stderr: "",
				outputs: [],
				hostRequests: [],
				internal,
				aborted: false,
				settled: false,
				resolve,
				reject,
				timer,
			};
			const abort = () => {
				if (pending.settled) return;
				pending.aborted = true;
				try {
					this.host.interruptKernel(lease.kernelSandboxId);
				} catch {
					// Abort is an in-memory acceleration. The lease termination path
					// independently rejects the pending cell after verified reap.
				}
			};
			lease.pending.set(submitted.inputId, pending);
			if (signal) {
				if (signal.aborted) abort();
				else {
					signal.addEventListener("abort", abort, { once: true });
					pending.abortCleanup = () => signal.removeEventListener("abort", abort);
				}
			}
		});
	}

	interrupt(leaseId: string): void {
		const lease = this.requireLease(leaseId);
		this.assertLeaseUsable(lease);
		this.host.interruptKernel(lease.kernelSandboxId);
		this.renew(lease);
	}

	async release(leaseId: string): Promise<{ retained: true; expiresAt: number }> {
		const lease = this.requireLease(leaseId);
		this.assertLeaseUsable(lease);
		this.renew(lease);
		await this.recordState(lease, "released");
		return { retained: true, expiresAt: lease.expiresAt };
	}

	async shutdown(leaseId: string): Promise<void> {
		const lease = this.requireLease(leaseId);
		await this.expire(lease);
	}

	async cancel(leaseId: string): Promise<void> {
		const lease = this.requireLease(leaseId);
		await this.expire(lease, "cancelled");
	}

	async fault(leaseId: string): Promise<void> {
		const lease = this.requireLease(leaseId);
		await this.expire(lease, "faulted");
	}

	async shutdownAll(): Promise<void> {
		this.shuttingDown = true;
		while (this.acquiringBySession.size > 0) {
			await Promise.allSettled([...this.acquiringBySession.values()].map(({ promise }) => promise));
		}
		const failedSpawnCleanups = await Promise.allSettled(
			[...this.failedSpawnCleanupBySession.values()].map((cleanup) => this.finishFailedKernelSpawnCleanup(cleanup)),
		);
		for (const result of failedSpawnCleanups) {
			if (result.status === "rejected") {
				console.error(`[kernel] failed launch cleanup remains pending: ${String(result.reason)}`);
			}
		}
		const leases = [...this.byLease.values()];
		const results = await Promise.allSettled(leases.map((lease) => this.expire(lease)));
		for (const result of results) {
			if (result.status === "rejected") {
				console.error(`[kernel] durable shutdown testimony deferred to recovery: ${String(result.reason)}`);
			}
		}
		while (this.terminationTasks.size > 0) {
			await Promise.allSettled([...this.terminationTasks]);
		}
		const unreaped = [...this.byLease.values()];
		if (unreaped.length > 0 || this.failedSpawnCleanupBySession.size > 0) {
			throw new KernelCleanupUnavailable(
				`Kernel shutdown did not verify physical reap for ${[
					...unreaped.map((lease) => lease.sessionId),
					...this.failedSpawnCleanupBySession.keys(),
				].join(", ")}`,
			);
		}
	}

	private trackTermination(task: Promise<void>): Promise<void> {
		let tracked!: Promise<void>;
		tracked = task.finally(() => this.terminationTasks.delete(tracked));
		this.terminationTasks.add(tracked);
		return tracked;
	}

	/** Physically reap a kernel after a durable recovery lease replaced the live activation. */
	async reapForRecovery(sessionId: string, generation: number): Promise<boolean> {
		const lease = this.bySession.get(sessionId);
		const acquiring = this.acquiringBySession.get(sessionId);
		const failedCleanup = this.failedSpawnCleanupBySession.get(sessionId);
		const activationId =
			lease?.generation === generation
				? lease.activationId
				: acquiring?.input.generation === generation
					? acquiring.input.activationId
					: failedCleanup?.input.generation === generation
						? failedCleanup.input.activationId
						: undefined;
		if (!activationId) return false;
		return this.reapSessionAcquisition(sessionId, generation, activationId, null);
	}

	/**
	 * Fence both published leases and the acquire continuation that has not yet
	 * published its lease. Callers must await this before terminal worker/body
	 * testimony so a late kernel wrapper cannot escape their physical barrier.
	 */
	async reapSessionAcquisition(
		sessionId: string,
		generation: number,
		activationId: string,
		terminalState: "shutdown" | "faulted" | "cancelled" | null,
	): Promise<boolean> {
		const activeFence = this.sessionReapFences.get(sessionId);
		if (
			activeFence &&
			(activeFence.generation !== generation ||
				activeFence.activationId !== activationId ||
				activeFence.terminalState !== terminalState)
		) {
			throw new KernelCleanupUnavailable("Kernel Session already has a conflicting verified-reap fence");
		}
		const acquiring = this.acquiringBySession.get(sessionId);
		if (acquiring && (acquiring.input.generation !== generation || acquiring.input.activationId !== activationId)) {
			throw new KernelCleanupUnavailable("Kernel acquire belongs to a different materialization activation");
		}
		const fence = activeFence ?? { generation, activationId, terminalState };
		this.sessionReapFences.set(sessionId, fence);
		let owned = false;
		try {
			if (acquiring) {
				owned = true;
				if (!acquiring.controller.signal.aborted) {
					acquiring.controller.abort(
						new KernelCleanupUnavailable("Kernel acquisition was fenced for Session reap"),
					);
				}
				await Promise.allSettled([acquiring.promise]);
			}
			const lease = this.bySession.get(sessionId);
			if (lease) {
				if (lease.generation !== generation || lease.activationId !== activationId) {
					throw new KernelCleanupUnavailable("Published kernel lease crossed the materialization reap fence");
				}
				owned = true;
				await this.expire(lease, terminalState);
			}
			const cleanup = this.failedSpawnCleanupBySession.get(sessionId);
			if (cleanup) {
				if (cleanup.input.generation !== generation || cleanup.input.activationId !== activationId) {
					throw new KernelCleanupUnavailable("Failed kernel spawn cleanup crossed the materialization reap fence");
				}
				owned = true;
				await this.finishFailedKernelSpawnCleanup(cleanup);
			}
			return owned;
		} finally {
			if (this.sessionReapFences.get(sessionId) === fence) this.sessionReapFences.delete(sessionId);
		}
	}

	async probeNamespace(leaseId: string): Promise<string[]> {
		const result = await this.execute(
			leaseId,
			"print(__import__('json').dumps(sorted(name for name in globals() if not name.startswith('_'))))",
			undefined,
			true,
		);
		if (result.status !== "ok") throw new Error("Kernel namespace probe failed");
		return stringArray(parseJsonLine(result.stdout, "kernel namespace probe"), "kernel namespace probe");
	}

	async replayJournal(
		leaseId: string,
		cells: readonly ExecutionCell[],
		expectedNamespace: readonly string[],
	): Promise<KernelReplayReport> {
		let replayedCells = 0;
		for (const cell of cells) {
			const fixtures = cell.hostRequests.map(({ digest: _digest, ...fixture }) => fixture);
			const fixtureJson = JSON.stringify(fixtures);
			const setup = await this.execute(
				leaseId,
				`__import__('rlm').begin_host_replay(__import__('json').loads(${JSON.stringify(fixtureJson)}))`,
				undefined,
				true,
			);
			if (setup.status !== "ok") return replayDivergence(replayedCells, expectedNamespace, cell.cellRef, setup);
			const replayed = await this.execute(leaseId, cell.code, undefined, true);
			const closed = await this.execute(leaseId, "__import__('rlm').end_host_replay()", undefined, true);
			if (replayed.status !== cell.status) {
				return {
					method: "journal",
					status: "diverged",
					replayedCells,
					namespace: await this.probeNamespace(leaseId),
					expectedNamespace: [...expectedNamespace],
					divergence: {
						cellRef: cell.cellRef,
						reason: `status differs: recorded ${cell.status}, replayed ${replayed.status}`,
					},
				};
			}
			if (closed.status !== "ok") return replayDivergence(replayedCells, expectedNamespace, cell.cellRef, closed);
			replayedCells += 1;
		}
		const namespace = await this.probeNamespace(leaseId);
		if (JSON.stringify(namespace) !== JSON.stringify([...expectedNamespace])) {
			return {
				method: "journal",
				status: "diverged",
				replayedCells,
				namespace,
				expectedNamespace: [...expectedNamespace],
				divergence: { reason: "namespace probe differs after journal replay" },
			};
		}
		return {
			method: "journal",
			status: "restored",
			replayedCells,
			namespace,
			expectedNamespace: [...expectedNamespace],
		};
	}

	async captureSnapshot(leaseId: string): Promise<KernelSnapshotCapture> {
		const code = `
import base64 as _sophia_base64, dill as _sophia_dill, json as _sophia_json, platform as _sophia_platform, sys as _sophia_sys, types as _sophia_types
_sophia_saved = {}
_sophia_skipped = {}
for _sophia_name, _sophia_value in list(globals().items()):
    if _sophia_name.startswith('_') or isinstance(_sophia_value, _sophia_types.ModuleType):
        continue
    try:
        _sophia_saved[_sophia_name] = _sophia_dill.dumps(_sophia_value)
    except Exception as _sophia_error:
        _sophia_skipped[_sophia_name] = type(_sophia_error).__name__
_sophia_payload = _sophia_dill.dumps(_sophia_saved)
print("SOPHIA_SNAPSHOT:" + _sophia_json.dumps({
    "pythonVersion": _sophia_platform.python_version(),
    "pythonImplementation": _sophia_platform.python_implementation(),
    "pythonCacheTag": _sophia_sys.implementation.cache_tag,
    "dillVersion": _sophia_dill.__version__,
    "namespace": sorted(name for name in globals() if not name.startswith("_")),
    "skipped": _sophia_skipped,
    "payload": _sophia_base64.b64encode(_sophia_payload).decode("ascii"),
}, sort_keys=True))
`;
		const result = await this.execute(leaseId, code, undefined, true);
		if (result.status !== "ok") throw new Error(`Kernel snapshot failed: ${renderExecutionError(result)}`);
		const parsed = parseMarkedJson(result.stdout, "SOPHIA_SNAPSHOT:", "kernel snapshot");
		if (!isRecord(parsed) || typeof parsed.payload !== "string")
			throw new Error("Kernel snapshot payload is invalid");
		const namespace = stringArray(parsed.namespace, "kernel snapshot namespace");
		const skipped = stringRecord(parsed.skipped, "kernel snapshot skipped map");
		return {
			pythonVersion: requiredString(parsed.pythonVersion, "kernel snapshot pythonVersion"),
			pythonImplementation: requiredString(parsed.pythonImplementation, "kernel snapshot pythonImplementation"),
			pythonCacheTag: requiredString(parsed.pythonCacheTag, "kernel snapshot pythonCacheTag"),
			dillVersion: requiredString(parsed.dillVersion, "kernel snapshot dillVersion"),
			namespace,
			skipped,
			payload: Buffer.from(parsed.payload, "base64"),
		};
	}

	async restoreSnapshot(
		leaseId: string,
		snapshot: KernelSnapshotCapture,
	): Promise<{ status: "restored" | "incompatible" | "corrupt"; namespace: string[]; reason?: string }> {
		const abiResult = await this.execute(
			leaseId,
			"import dill as _sophia_dill, json as _sophia_json, platform as _sophia_platform, sys as _sophia_sys; print(_sophia_json.dumps({'pythonVersion': _sophia_platform.python_version(), 'pythonImplementation': _sophia_platform.python_implementation(), 'pythonCacheTag': _sophia_sys.implementation.cache_tag, 'dillVersion': _sophia_dill.__version__}, sort_keys=True))",
			undefined,
			true,
		);
		if (abiResult.status !== "ok")
			return { status: "incompatible", namespace: [], reason: "kernel ABI probe failed" };
		const abi = parseJsonLine(abiResult.stdout, "kernel ABI probe");
		if (
			!isRecord(abi) ||
			abi.pythonVersion !== snapshot.pythonVersion ||
			abi.pythonImplementation !== snapshot.pythonImplementation ||
			abi.pythonCacheTag !== snapshot.pythonCacheTag ||
			abi.dillVersion !== snapshot.dillVersion
		) {
			return { status: "incompatible", namespace: [], reason: "kernel snapshot ABI differs" };
		}
		const payload = snapshot.payload.toString("base64");
		const restored = await this.execute(
			leaseId,
			`import base64 as _sophia_base64, dill as _sophia_dill
_sophia_saved = _sophia_dill.loads(_sophia_base64.b64decode(${JSON.stringify(payload)}))
for _sophia_name, _sophia_value in _sophia_saved.items():
    globals()[_sophia_name] = _sophia_dill.loads(_sophia_value)
del _sophia_saved
`,
			undefined,
			true,
		);
		if (restored.status !== "ok") {
			return { status: "corrupt", namespace: [], reason: renderExecutionError(restored) };
		}
		const namespace = await this.probeNamespace(leaseId);
		if (JSON.stringify(namespace) !== JSON.stringify(snapshot.namespace)) {
			return { status: "corrupt", namespace, reason: "kernel snapshot namespace probe differs" };
		}
		return { status: "restored", namespace };
	}

	recordHostRequest(
		kernelSandboxId: string,
		inputId: string,
		input: {
			requestId: string;
			payload: Record<string, unknown>;
			ok: boolean;
			result?: unknown;
			error?: unknown;
		},
	): void {
		const lease = [...this.byLease.values()].find((candidate) => candidate.kernelSandboxId === kernelSandboxId);
		const pending = lease?.pending.get(inputId);
		if (!pending || pending.settled || pending.internal) {
			throw new Error(`Kernel host request ${input.requestId} has no journaled execution cell`);
		}
		const unsigned = {
			requestId: input.requestId,
			inputId,
			payload: input.payload,
			ok: input.ok,
			...(input.ok ? { result: input.result ?? null } : { error: input.error ?? null }),
		};
		pending.hostRequests.push({ ...unsigned, digest: digestCanonical(unsigned) });
	}

	getLease(
		leaseId: string,
	): { sessionId: string; kernelSandboxId: string; agentSandboxId: string; activationId: string } | undefined {
		const lease = this.byLease.get(leaseId);
		return lease
			? {
					sessionId: lease.sessionId,
					kernelSandboxId: lease.kernelSandboxId,
					agentSandboxId: lease.agentSandboxId,
					activationId: lease.activationId,
				}
			: undefined;
	}

	getLeaseForSession(sessionId: string):
		| {
				leaseId: string;
				kernelSandboxId: string;
				agentSandboxId: string;
				generation: number;
				activationId: string;
				pending: number;
		  }
		| undefined {
		const lease = this.bySession.get(sessionId);
		return lease
			? {
					leaseId: lease.leaseId,
					kernelSandboxId: lease.kernelSandboxId,
					agentSandboxId: lease.agentSandboxId,
					generation: lease.generation,
					activationId: lease.activationId,
					pending: lease.pending.size,
				}
			: undefined;
	}

	getLeaseForKernel(kernelSandboxId: string):
		| {
				leaseId: string;
				sessionId: string;
				agentSandboxId: string;
				ownerUserId: string;
				generation: number;
				activationId: string;
		  }
		| undefined {
		for (const lease of this.byLease.values()) {
			if (lease.kernelSandboxId === kernelSandboxId) {
				return {
					leaseId: lease.leaseId,
					sessionId: lease.sessionId,
					agentSandboxId: lease.agentSandboxId,
					ownerUserId: lease.ownerUserId,
					generation: lease.generation,
					activationId: lease.activationId,
				};
			}
		}
		return undefined;
	}

	/** A wrapper Sandbox died without an inner Jupyter `kernel_exit` message. */
	async observeKernelSandboxExit(
		kernelSandboxId: string,
		input: { exitCode: number | null; signal: string | null },
	): Promise<void> {
		const lease = [...this.byLease.values()].find((candidate) => candidate.kernelSandboxId === kernelSandboxId);
		if (!lease || lease.termination) return;
		await this.handleUnexpectedKernelExit(lease, {
			category: "system",
			type: "kernel_exit",
			sandbox_id: kernelSandboxId,
			ts: new Date(this.now()).toISOString(),
			kernel: "python3",
			exit_code: input.exitCode,
			signal: input.signal,
		});
	}

	private observe(lease: KernelLease, event: BusEvent): void {
		if (!("category" in event) || event.category !== "system") return;
		if (event.type === "kernel_exit") {
			void this.handleUnexpectedKernelExit(lease, event).catch((error) => {
				console.error(
					`[kernel] failed to settle unexpected exit for ${lease.sessionId}/${String(lease.generation)}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			});
			return;
		}
		if (!("input_id" in event)) return;
		const inputId = typeof event.input_id === "string" ? event.input_id : undefined;
		const pending = inputId ? lease.pending.get(inputId) : undefined;
		if (!pending || pending.settled) return;
		switch (event.type) {
			case "kernel_stream":
				if (event.name === "stderr") pending.stderr += event.text;
				else pending.stdout += event.text;
				pending.outputs.push({ kind: "stream", name: event.name, text: event.text });
				return;
			case "kernel_display":
				pending.outputs.push({ kind: "display", data: event.data, metadata: event.metadata });
				return;
			case "kernel_result":
				pending.executionCount = event.execution_count;
				pending.result = plainText(event.data);
				pending.outputs.push({ kind: "result", data: event.data, metadata: event.metadata });
				return;
			case "kernel_error":
				pending.error = { ename: event.ename, evalue: event.evalue, traceback: event.traceback };
				pending.outputs.push({ kind: "error", error: pending.error });
				return;
			case "kernel_reply":
				pending.executionCount = event.execution_count;
				return;
			case "kernel_idle":
				void this.complete(lease, pending);
				return;
		}
	}

	private async handleUnexpectedKernelExit(
		lease: KernelLease,
		event: Extract<BusEvent, { category: "system"; type: "kernel_exit" }>,
	): Promise<void> {
		if (!lease.unexpectedExit) {
			lease.unexpectedExit = event;
			if (lease.expiryTimer) clearTimeout(lease.expiryTimer);
			lease.expiryTimer = undefined;
		} else {
			event = lease.unexpectedExit;
		}
		if (lease.termination) return lease.termination;
		// kernel_exit is testimony from the inner Jupyter kernel, not from the
		// wrapper Sandbox process/cgroup. Keep the lease visible and mark this as an
		// expected wrapper exit until the host verifies that physical reap.
		const termination = this.trackTermination(
			Promise.resolve().then(async () => {
				await this.host.killKernel(lease.kernelSandboxId);
				if (!this.detachLease(lease, "Kernel body exited unexpectedly")) return;
				let testimonyError: unknown;
				try {
					await this.recordState(lease, "faulted");
				} catch (error) {
					testimonyError = error;
				}
				try {
					await this.host.handleUnexpectedKernelExit?.({
						leaseId: lease.leaseId,
						sessionId: lease.sessionId,
						generation: lease.generation,
						activationId: lease.activationId,
						agentSandboxId: lease.agentSandboxId,
						kernelSandboxId: lease.kernelSandboxId,
						exitCode: event.exit_code ?? null,
						signal: event.signal ?? null,
					});
				} catch (cleanupError) {
					if (testimonyError !== undefined) {
						throw new AggregateError(
							[testimonyError, cleanupError],
							"Unexpected kernel exit lost both durable testimony and worker cleanup",
						);
					}
					throw cleanupError;
				}
				if (testimonyError !== undefined) throw testimonyError;
			}),
		);
		lease.termination = termination;
		try {
			await termination;
		} catch (error) {
			// A failed physical reap leaves the lease and pending calls visible. The
			// same inner-exit testimony is durable in memory for a bounded retry.
			if (!this.shuttingDown && this.byLease.get(lease.leaseId) === lease && lease.termination === termination) {
				if (lease.unexpectedRetryTimer) clearTimeout(lease.unexpectedRetryTimer);
				lease.unexpectedRetryTimer = setTimeout(() => {
					void this.handleUnexpectedKernelExit(lease, event).catch((retryError) => {
						console.error(
							`[kernel] unexpected-exit reap retry failed for ${lease.sessionId}: ${String(retryError)}`,
						);
					});
				}, 1_000);
				lease.unexpectedRetryTimer.unref?.();
			}
			throw error;
		} finally {
			if (lease.termination === termination) lease.termination = undefined;
		}
	}

	private async complete(lease: KernelLease, pending: PendingExecution): Promise<void> {
		if (pending.settled) return;
		pending.settled = true;
		clearTimeout(pending.timer);
		pending.abortCleanup?.();
		lease.pending.delete(pending.inputId);
		const completedAt = this.now();
		const durationMs = Math.max(0, completedAt - pending.startedAt);
		const status: ExecutionCell["status"] = pending.aborted ? "aborted" : pending.error ? "error" : "ok";
		if (pending.internal) {
			pending.resolve({
				stdout: pending.stdout,
				stderr: pending.stderr,
				...(pending.result === undefined ? {} : { result: pending.result }),
				status,
				...(pending.error ? { error: pending.error } : {}),
				durationMs,
			});
			return;
		}
		const ordinal = lease.nextOrdinal++;
		const cellRef = `compute.cell:${lease.sessionId}:${String(lease.generation)}:${ordinal}`;
		const unsignedCell = {
			schema: "choreograph.compute-cell.v1" as const,
			cellRef,
			sessionId: lease.sessionId,
			leaseId: lease.leaseId,
			kernelSandboxId: lease.kernelSandboxId,
			inputId: pending.inputId,
			ordinal,
			generation: lease.generation,
			code: pending.code,
			status,
			...(pending.executionCount === undefined ? {} : { executionCount: pending.executionCount }),
			outputs: pending.outputs,
			startedAt: pending.startedAt,
			completedAt,
			durationMs,
			hostRequests: pending.hostRequests,
		};
		const cell: ExecutionCell = { ...unsignedCell, cellDigest: digestCanonical(unsignedCell) };
		try {
			// The execution journal is part of command durability, not telemetry.
			// Do not acknowledge the kernel call to Prime until its settled cell has
			// reached the host-owned journal.
			await this.host.emitCell(lease.agentSandboxId, cell);
			pending.resolve({
				stdout: pending.stdout,
				stderr: pending.stderr,
				...(pending.result === undefined ? {} : { result: pending.result }),
				status,
				...(pending.error ? { error: pending.error } : {}),
				durationMs: cell.durationMs,
				cellRef,
			});
		} catch (error) {
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		}
	}

	private requireLease(leaseId: string): KernelLease {
		const lease = this.byLease.get(leaseId);
		if (!lease) throw new Error(`Kernel lease not found: ${leaseId}`);
		return lease;
	}

	private renew(lease: KernelLease, idleMs = DEFAULT_LEASE_IDLE_MS): void {
		this.assertLeaseUsable(lease);
		if (lease.expiryTimer) clearTimeout(lease.expiryTimer);
		lease.expiresAt = this.now() + idleMs;
		lease.expiryTimer = setTimeout(() => {
			if (this.shuttingDown) return;
			void this.expire(lease).catch((error) => {
				console.error(`[kernel] idle reap failed for ${lease.sessionId}: ${String(error)}`);
			});
		}, idleMs);
		lease.expiryTimer.unref?.();
	}

	private async expire(
		lease: KernelLease,
		terminalState: "shutdown" | "faulted" | "cancelled" | null = "shutdown",
	): Promise<void> {
		if (this.byLease.get(lease.leaseId) !== lease) return;
		if (lease.unexpectedExit) return this.handleUnexpectedKernelExit(lease, lease.unexpectedExit);
		if (lease.termination) return lease.termination;
		// Defer the actual host call by one microtask so the expected-exit observer
		// sees the termination marker even when a fake/local host emits exit
		// synchronously from killKernel().
		const termination = this.trackTermination(
			Promise.resolve().then(async () => {
				await this.host.killKernel(lease.kernelSandboxId);
				if (!this.detachLease(lease, "Kernel lease expired")) return;
				if (terminalState) await this.recordState(lease, terminalState);
			}),
		);
		lease.termination = termination;
		try {
			await termination;
		} catch (error) {
			// A failed/unverified kill is not terminal testimony. Keep the lease and
			// body visible, and retain the exact requested terminal intent for retry.
			if (!this.shuttingDown && this.byLease.get(lease.leaseId) === lease && lease.termination === termination) {
				lease.termination = undefined;
				lease.expiresAt = this.now() + 1_000;
				lease.expiryTimer = setTimeout(() => {
					void this.expire(lease, terminalState).catch((retryError) => {
						console.error(`[kernel] verified reap retry failed for ${lease.sessionId}: ${String(retryError)}`);
					});
				}, 1_000);
				lease.expiryTimer.unref?.();
			}
			throw error;
		} finally {
			if (lease.termination === termination) lease.termination = undefined;
		}
	}

	private detachLease(lease: KernelLease, reason: string): boolean {
		if (this.byLease.get(lease.leaseId) !== lease) return false;
		this.byLease.delete(lease.leaseId);
		this.bySession.delete(lease.sessionId);
		if (lease.expiryTimer) clearTimeout(lease.expiryTimer);
		if (lease.unexpectedRetryTimer) clearTimeout(lease.unexpectedRetryTimer);
		lease.unsubscribe();
		for (const pending of lease.pending.values()) {
			if (pending.settled) continue;
			pending.settled = true;
			clearTimeout(pending.timer);
			pending.abortCleanup?.();
			pending.reject(new Error(reason));
		}
		lease.pending.clear();
		return true;
	}

	private assertLeaseUsable(lease: KernelLease): void {
		if (this.shuttingDown) {
			throw new KernelCleanupUnavailable("Kernel execution service is shutting down");
		}
		if (this.sessionReapFences.has(lease.sessionId)) {
			throw new KernelCleanupUnavailable(`Kernel ${lease.sessionId} is fenced for verified Session reap`);
		}
		if (lease.unexpectedExit) {
			throw new KernelCleanupUnavailable(`Kernel ${lease.sessionId} is awaiting verified unexpected-exit reap`);
		}
		if (lease.termination) {
			throw new KernelCleanupUnavailable(`Kernel ${lease.sessionId} is already being reaped`);
		}
	}

	private async recordState(
		lease: Pick<KernelLease, "sessionId" | "generation" | "activationId">,
		state: "running" | "released" | "shutdown" | "faulted" | "cancelled",
	): Promise<void> {
		await this.host.recordKernelState?.({
			sessionId: lease.sessionId,
			generation: lease.generation,
			activationId: lease.activationId,
			state,
			now: this.now(),
		});
	}

	private project(lease: KernelLease) {
		return { leaseId: lease.leaseId, kernelSandboxId: lease.kernelSandboxId, expiresAt: lease.expiresAt };
	}
}

function digestCanonical(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function replayDivergence(
	replayedCells: number,
	expectedNamespace: readonly string[],
	cellRef: string,
	result: ExecutionResult,
): KernelReplayReport {
	return {
		method: "journal",
		status: "diverged",
		replayedCells,
		namespace: [],
		expectedNamespace: [...expectedNamespace],
		divergence: { cellRef, reason: renderExecutionError(result) },
	};
}

function parseJsonLine(stdout: string, label: string): unknown {
	const line = stdout
		.trim()
		.split("\n")
		.reverse()
		.find((candidate) => candidate.trim().length > 0);
	if (!line) throw new Error(`${label} returned no JSON`);
	try {
		return JSON.parse(line);
	} catch {
		throw new Error(`${label} returned invalid JSON`);
	}
}

function parseMarkedJson(stdout: string, marker: string, label: string): unknown {
	const line = stdout.split("\n").find((candidate) => candidate.startsWith(marker));
	if (!line) throw new Error(`${label} returned no marked payload`);
	try {
		return JSON.parse(line.slice(marker.length));
	} catch {
		throw new Error(`${label} returned invalid marked JSON`);
	}
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is invalid`);
	return value;
}

function stringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error(`${label} is invalid`);
	}
	return value;
}

function stringRecord(value: unknown, label: string): Record<string, string> {
	if (!isRecord(value) || !Object.values(value).every((item) => typeof item === "string")) {
		throw new Error(`${label} is invalid`);
	}
	return value as Record<string, string>;
}

function renderExecutionError(result: ExecutionResult): string {
	return result.error ? `${result.error.ename}: ${result.error.evalue}` : result.stderr || `status ${result.status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plainText(data: unknown): string | undefined {
	if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
	const value = (data as Record<string, unknown>)["text/plain"];
	return typeof value === "string" ? value : undefined;
}
