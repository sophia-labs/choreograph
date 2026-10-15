import type {
	AgentSessionCommandRecord,
	AgentSessionScheduleFireClaim,
	AgentSessionScheduleFireRecord,
	RenewAgentSessionScheduleFireLeaseInput,
	SettleAgentSessionScheduleFireInput,
} from "../workflow/runtime-store.js";

export interface AgentSessionSchedulerStore {
	claimDueAgentSessionScheduleFire(input: {
		readonly consumer: string;
		readonly leaseMs: number;
		readonly now: number;
	}): Promise<AgentSessionScheduleFireClaim | null>;
	readNextAgentSessionScheduleDueAt(now: number): Promise<number | null>;
	renewAgentSessionScheduleFireLease(
		fireId: string,
		input: RenewAgentSessionScheduleFireLeaseInput,
	): Promise<AgentSessionScheduleFireRecord>;
	settleAgentSessionScheduleFire(
		fireId: string,
		input: SettleAgentSessionScheduleFireInput,
	): Promise<AgentSessionScheduleFireRecord>;
	readAgentSessionCommand(commandId: string): Promise<AgentSessionCommandRecord | null>;
}

export interface AgentSessionScheduleActivation {
	readonly fire: AgentSessionScheduleFireRecord;
	readonly command: AgentSessionCommandRecord;
	readonly signal: AbortSignal;
}

export interface AgentSessionSchedulerLogger {
	error(message: string): void;
	warn(message: string): void;
}

export interface AgentSessionSchedulerServiceOptions {
	readonly store: AgentSessionSchedulerStore;
	readonly consumer: string;
	readonly activate: (input: AgentSessionScheduleActivation) => Promise<void>;
	readonly leaseMs?: number;
	readonly retryBaseMs?: number;
	readonly retryMaxMs?: number;
	readonly idlePollMs?: number;
	readonly commandSettleTimeoutMs?: number;
	readonly now?: () => number;
	readonly logger?: AgentSessionSchedulerLogger;
}

/** A non-retryable failure of the one logical wake owned by a durable fire. */
export class AgentSessionScheduleActivationTerminalError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AgentSessionScheduleActivationTerminalError";
	}
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 30_000;
const DEFAULT_IDLE_POLL_MS = 1_000;
const DEFAULT_COMMAND_SETTLE_TIMEOUT_MS = 30_000;

/**
 * Claims immutable schedule fires and embodies their already-admitted prompt.
 * SQLite owns every logical coordinate; retries own only physical attempts.
 */
export class AgentSessionSchedulerService {
	private readonly store: AgentSessionSchedulerStore;
	private readonly consumer: string;
	private readonly activate: AgentSessionSchedulerServiceOptions["activate"];
	private readonly leaseMs: number;
	private readonly retryBaseMs: number;
	private readonly retryMaxMs: number;
	private readonly idlePollMs: number;
	private readonly commandSettleTimeoutMs: number;
	private readonly now: () => number;
	private readonly logger: AgentSessionSchedulerLogger;
	private state: "idle" | "running" | "stopping" | "stopped" = "idle";
	private loop: Promise<void> | null = null;
	private wakeRevision = 0;
	private waiter: (() => void) | null = null;
	private activeAbort: AbortController | null = null;
	private readonly startup: Promise<void>;
	private resolveStartup!: () => void;
	private startupReady = false;

	constructor(options: AgentSessionSchedulerServiceOptions) {
		this.store = options.store;
		this.consumer = requiredText(options.consumer, "scheduler consumer");
		this.activate = options.activate;
		this.leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_LEASE_MS, "scheduler lease duration");
		this.retryBaseMs = positiveInteger(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, "scheduler retry base");
		this.retryMaxMs = positiveInteger(options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS, "scheduler retry maximum");
		if (this.retryMaxMs < this.retryBaseMs) {
			throw new Error("scheduler retry maximum cannot be less than its base");
		}
		this.idlePollMs = positiveInteger(options.idlePollMs ?? DEFAULT_IDLE_POLL_MS, "scheduler idle poll");
		this.commandSettleTimeoutMs = positiveInteger(
			options.commandSettleTimeoutMs ?? DEFAULT_COMMAND_SETTLE_TIMEOUT_MS,
			"scheduler command settlement timeout",
		);
		this.now = options.now ?? Date.now;
		this.logger = options.logger ?? console;
		this.startup = new Promise<void>((resolve) => {
			this.resolveStartup = resolve;
		});
	}

	/** Start and resolve after every fire claimable at startup reaches a durable boundary. */
	start(): Promise<void> {
		if (this.state === "running") return this.startup;
		if (this.state !== "idle") throw new Error("Agent Session scheduler cannot be restarted");
		this.state = "running";
		this.loop = this.run();
		return this.startup;
	}

	/** Non-blocking hint after a schedule or relevant Session state commits. */
	wake(): void {
		this.wakeRevision += 1;
		const waiter = this.waiter;
		this.waiter = null;
		waiter?.();
	}

	/** Close admission, release the active claim for retry, and await stable local drain. */
	async stop(): Promise<void> {
		if (this.state === "idle") {
			this.state = "stopped";
			this.markStartupReady();
			return;
		}
		if (this.state === "stopped") return;
		this.state = "stopping";
		this.activeAbort?.abort(new Error("Agent Session scheduler is stopping"));
		this.wake();
		await this.loop;
		this.state = "stopped";
	}

	private async run(): Promise<void> {
		while (this.state === "running") {
			try {
				const claim = await this.store.claimDueAgentSessionScheduleFire({
					consumer: this.consumer,
					leaseMs: this.leaseMs,
					now: this.timestamp(),
				});
				if (claim) {
					await this.deliver(claim);
					continue;
				}

				const observedWake = this.wakeRevision;
				const now = this.timestamp();
				const nextAvailableAt = await this.store.readNextAgentSessionScheduleDueAt(now);
				const waiting = this.waitForWork(observedWake, nextAvailableAt, now);
				this.markStartupReady();
				await waiting;
			} catch (error) {
				this.logger.error(`[scheduler] iteration failed: ${errorMessage(error)}`);
				if (this.state !== "running") return;
				await this.waitForWork(this.wakeRevision, this.timestamp() + this.retryBaseMs, this.timestamp());
			}
		}
		this.markStartupReady();
	}

	private markStartupReady(): void {
		if (this.startupReady) return;
		this.startupReady = true;
		this.resolveStartup();
	}

	private async deliver(claim: AgentSessionScheduleFireClaim): Promise<void> {
		const token = requiredText(claim.fire.claim_token, "schedule fire claim token");
		const consumer = requiredText(claim.fire.consumer, "schedule fire consumer");
		const controller = new AbortController();
		this.activeAbort = controller;
		let renewalError: unknown = null;
		const renewal = this.renewUntilSettled(claim.fire, token, consumer, (error) => {
			renewalError = error;
			controller.abort(error);
		});
		try {
			await this.activate({ fire: claim.fire, command: claim.command, signal: controller.signal });
			await this.awaitCommandSettlement(claim.command.command_id, controller.signal);
			await renewal.stop();
			if (renewalError) {
				this.logger.warn(
					`[scheduler] activation finished after losing fire ${claim.fire.fire_id}: ${errorMessage(renewalError)}`,
				);
				return;
			}
			await this.store.settleAgentSessionScheduleFire(claim.fire.fire_id, {
				consumer,
				claimToken: token,
				now: this.timestamp(),
				outcome: "completed",
			});
		} catch (error) {
			await renewal.stop();
			if (renewalError) {
				this.logger.warn(
					`[scheduler] fire ${claim.fire.fire_id} lost its lease during failure: ${errorMessage(renewalError)}`,
				);
				return;
			}
			await this.settleFailure(claim.fire, token, consumer, error);
		} finally {
			if (this.activeAbort === controller) this.activeAbort = null;
		}
	}

	private renewUntilSettled(
		fire: AgentSessionScheduleFireRecord,
		claimToken: string,
		consumer: string,
		onError: (error: unknown) => void,
	): { stop(): Promise<void> } {
		let stopped = false;
		let releaseWait: (() => void) | null = null;
		const intervalMs = Math.max(1, Math.floor(this.leaseMs / 3));
		const task = (async () => {
			while (!stopped) {
				await new Promise<void>((resolve) => {
					let settled = false;
					const finish = () => {
						if (settled) return;
						settled = true;
						clearTimeout(timer);
						if (releaseWait === finish) releaseWait = null;
						resolve();
					};
					const timer = setTimeout(finish, intervalMs);
					releaseWait = finish;
				});
				if (stopped) return;
				try {
					await this.store.renewAgentSessionScheduleFireLease(fire.fire_id, {
						consumer,
						claimToken,
						leaseMs: this.leaseMs,
						now: this.timestamp(),
					});
				} catch (error) {
					onError(error);
					return;
				}
			}
		})();
		return {
			async stop() {
				stopped = true;
				releaseWait?.();
				await task;
			},
		};
	}

	private async awaitCommandSettlement(commandId: string, signal: AbortSignal): Promise<void> {
		const deadline = Date.now() + this.commandSettleTimeoutMs;
		while (true) {
			if (signal.aborted) throw signal.reason ?? new Error("Schedule activation was aborted");
			const command = await this.store.readAgentSessionCommand(commandId);
			if (!command) {
				throw new AgentSessionScheduleActivationTerminalError(`Schedule command vanished: ${commandId}`);
			}
			if (command.state === "completed") return;
			if (command.state === "failed" || command.state === "cancelled" || command.state === "rejected") {
				throw new AgentSessionScheduleActivationTerminalError(
					command.error ?? `Schedule command ${commandId} settled ${command.state}`,
				);
			}
			if (Date.now() >= deadline) throw new Error(`Schedule command ${commandId} did not settle durably`);
			await delay(Math.min(10, Math.max(1, deadline - Date.now())), signal);
		}
	}

	private async settleFailure(
		fire: AgentSessionScheduleFireRecord,
		claimToken: string,
		consumer: string,
		error: unknown,
	): Promise<void> {
		const now = this.timestamp();
		const terminal = error instanceof AgentSessionScheduleActivationTerminalError;
		const delayMs = retryDelay(fire.attempt, this.retryBaseMs, this.retryMaxMs);
		const settlement: SettleAgentSessionScheduleFireInput = terminal
			? {
					consumer,
					claimToken,
					now,
					outcome: "terminal_failure",
					error: errorMessage(error),
				}
			: {
					consumer,
					claimToken,
					now,
					outcome: "retryable_failure",
					error: errorMessage(error),
					retryAt: checkedSum(now, delayMs),
				};
		try {
			await this.store.settleAgentSessionScheduleFire(fire.fire_id, settlement);
		} catch (settleError) {
			this.logger.warn(
				`[scheduler] failed to settle fire ${fire.fire_id} after activation failure: ${errorMessage(settleError)}`,
			);
		}
	}

	private async waitForWork(observedWake: number, nextAvailableAt: number | null, now: number): Promise<void> {
		if (this.state !== "running" || observedWake !== this.wakeRevision) return;
		const availableDelay =
			nextAvailableAt === null ? this.idlePollMs : nextAvailableAt <= now ? this.retryBaseMs : nextAvailableAt - now;
		const delayMs = Math.min(this.idlePollMs, availableDelay);
		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (this.waiter === finish) this.waiter = null;
				resolve();
			};
			const timer = setTimeout(finish, delayMs);
			this.waiter = finish;
			if (this.state !== "running" || observedWake !== this.wakeRevision) finish();
		});
	}

	private timestamp(): number {
		return nonNegativeInteger(this.now(), "scheduler clock");
	}
}

function requiredText(value: string | null, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
	return value;
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
	return value;
}

function nonNegativeInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
	return value;
}

function checkedSum(left: number, right: number): number {
	const sum = left + right;
	if (!Number.isSafeInteger(sum)) throw new Error("scheduler time exceeded safe integer range");
	return sum;
}

function retryDelay(attempt: number, baseMs: number, maxMs: number): number {
	const exponent = Math.min(Math.max(0, attempt - 1), 30);
	return Math.min(maxMs, baseMs * 2 ** exponent);
}

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message.trim() || error.name : String(error).trim();
	return (message || "unknown schedule activation failure").slice(0, 2_048);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Schedule wait was aborted"));
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			resolve();
		};
		const abort = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(signal?.reason ?? new Error("Schedule wait was aborted"));
		};
		const timer = setTimeout(finish, milliseconds);
		signal?.addEventListener("abort", abort, { once: true });
	});
}
