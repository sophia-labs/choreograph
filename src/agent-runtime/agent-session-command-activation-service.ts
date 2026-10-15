import type {
	AgentSessionCommandActivationClaim,
	AgentSessionCommandActivationRecord,
	AgentSessionCommandRecord,
	RenewAgentSessionCommandActivationLeaseInput,
	SettleAgentSessionCommandActivationInput,
} from "../workflow/runtime-store.js";

export interface AgentSessionCommandActivationStore {
	claimAgentSessionCommandActivation(input: {
		readonly consumer: string;
		readonly leaseMs: number;
		readonly now: number;
	}): Promise<AgentSessionCommandActivationClaim | null>;
	readNextAgentSessionCommandActivationDueAt(now: number): Promise<number | null>;
	renewAgentSessionCommandActivationLease(
		commandId: string,
		input: RenewAgentSessionCommandActivationLeaseInput,
	): Promise<AgentSessionCommandActivationRecord>;
	settleAgentSessionCommandActivation(
		commandId: string,
		input: SettleAgentSessionCommandActivationInput,
	): Promise<AgentSessionCommandActivationRecord>;
	readAgentSessionCommand(commandId: string): Promise<AgentSessionCommandRecord | null>;
	readAgentSessionCommandActivation(commandId: string): Promise<AgentSessionCommandActivationRecord | null>;
}

export interface AgentSessionCommandActivation {
	readonly activation: AgentSessionCommandActivationRecord;
	readonly command: AgentSessionCommandRecord;
	readonly signal: AbortSignal;
}

export interface AgentSessionCommandActivationServiceOptions {
	readonly store: AgentSessionCommandActivationStore;
	readonly consumer: string;
	readonly activate: (input: AgentSessionCommandActivation) => Promise<void>;
	readonly leaseMs?: number;
	readonly retryBaseMs?: number;
	readonly retryMaxMs?: number;
	readonly idlePollMs?: number;
	readonly commandSettleTimeoutMs?: number;
	readonly now?: () => number;
	readonly logger?: Pick<Console, "error" | "warn">;
}

export class AgentSessionCommandActivationTerminalError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AgentSessionCommandActivationTerminalError";
	}
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 30_000;
const DEFAULT_IDLE_POLL_MS = 1_000;
const DEFAULT_COMMAND_SETTLE_TIMEOUT_MS = 30_000;

/**
 * Renewable physical owner for queued commands that must regrow a composted
 * Prime. The command row remains the sole logical request and result authority.
 */
export class AgentSessionCommandActivationService {
	private readonly store: AgentSessionCommandActivationStore;
	private readonly consumer: string;
	private readonly activate: AgentSessionCommandActivationServiceOptions["activate"];
	private readonly leaseMs: number;
	private readonly retryBaseMs: number;
	private readonly retryMaxMs: number;
	private readonly idlePollMs: number;
	private readonly commandSettleTimeoutMs: number;
	private readonly now: () => number;
	private readonly logger: Pick<Console, "error" | "warn">;
	private state: "idle" | "running" | "stopping" | "stopped" = "idle";
	private loop: Promise<void> | null = null;
	private wakeRevision = 0;
	private waiter: (() => void) | null = null;
	private activeAbort: AbortController | null = null;
	private readonly startup: Promise<void>;
	private resolveStartup!: () => void;
	private startupReady = false;

	constructor(options: AgentSessionCommandActivationServiceOptions) {
		this.store = options.store;
		this.consumer = requiredText(options.consumer, "command activation consumer");
		this.activate = options.activate;
		this.leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_LEASE_MS, "command activation lease duration");
		this.retryBaseMs = positiveInteger(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, "command activation retry base");
		this.retryMaxMs = positiveInteger(options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS, "command activation retry maximum");
		if (this.retryMaxMs < this.retryBaseMs) {
			throw new Error("command activation retry maximum cannot be less than its base");
		}
		this.idlePollMs = positiveInteger(options.idlePollMs ?? DEFAULT_IDLE_POLL_MS, "command activation idle poll");
		this.commandSettleTimeoutMs = positiveInteger(
			options.commandSettleTimeoutMs ?? DEFAULT_COMMAND_SETTLE_TIMEOUT_MS,
			"command activation settlement timeout",
		);
		this.now = options.now ?? Date.now;
		this.logger = options.logger ?? console;
		this.startup = new Promise<void>((resolve) => {
			this.resolveStartup = resolve;
		});
	}

	start(): Promise<void> {
		if (this.state === "running") return this.startup;
		if (this.state !== "idle") throw new Error("Agent Session command activation service cannot be restarted");
		this.state = "running";
		this.loop = this.run();
		return this.startup;
	}

	wake(): void {
		this.wakeRevision += 1;
		const waiter = this.waiter;
		this.waiter = null;
		waiter?.();
	}

	async stop(): Promise<void> {
		if (this.state === "idle") {
			this.state = "stopped";
			this.markStartupReady();
			return;
		}
		if (this.state === "stopped") return;
		this.state = "stopping";
		this.activeAbort?.abort(new Error("Agent Session command activation service is stopping"));
		this.wake();
		await this.loop;
		this.state = "stopped";
	}

	private async run(): Promise<void> {
		while (this.state === "running") {
			try {
				const claim = await this.store.claimAgentSessionCommandActivation({
					consumer: this.consumer,
					leaseMs: this.leaseMs,
					now: this.timestamp(),
				});
				if (claim) {
					await this.deliver(claim);
					// Startup readiness is one full iteration, not a drained queue: a backlog of wakes (or a slow one)
					// must not hold the host's HTTP edge closed.
					this.markStartupReady();
					continue;
				}
				const observedWake = this.wakeRevision;
				const now = this.timestamp();
				const nextAvailableAt = await this.store.readNextAgentSessionCommandActivationDueAt(now);
				const waiting = this.waitForWork(observedWake, nextAvailableAt, now);
				this.markStartupReady();
				await waiting;
			} catch (error) {
				this.logger.error(`[command-activation] iteration failed: ${errorMessage(error)}`);
				// A failed iteration still completes startup: one command (or a store) that cannot make progress
				// must not keep the orchestrator from listening (incident 2026-10-13). The loop keeps retrying.
				this.markStartupReady();
				if (this.state !== "running") return;
				await this.waitForWork(this.wakeRevision, this.timestamp() + this.retryBaseMs, this.timestamp());
			}
		}
		this.markStartupReady();
	}

	private async deliver(claim: AgentSessionCommandActivationClaim): Promise<void> {
		const token = requiredText(claim.activation.claim_token, "command activation claim token");
		const consumer = requiredText(claim.activation.consumer, "command activation consumer");
		const controller = new AbortController();
		this.activeAbort = controller;
		let renewalError: unknown = null;
		const renewal = this.renewUntilSettled(claim.activation, token, consumer, (error) => {
			renewalError = error;
			controller.abort(error);
		});
		try {
			await this.activate({ activation: claim.activation, command: claim.command, signal: controller.signal });
			await this.awaitCommandSettlement(claim.command.command_id, controller.signal);
			await renewal.stop();
			if (renewalError) return;
			await this.store.settleAgentSessionCommandActivation(claim.command.command_id, {
				consumer,
				claimToken: token,
				now: this.timestamp(),
				outcome: "completed",
			});
		} catch (error) {
			await renewal.stop();
			if (renewalError) return;
			const durable = await this.store.readAgentSessionCommandActivation(claim.command.command_id);
			if (durable?.state === "completed" || durable?.state === "failed") return;
			await this.settleFailure(claim.activation, token, consumer, error);
		} finally {
			if (this.activeAbort === controller) this.activeAbort = null;
		}
	}

	private renewUntilSettled(
		activation: AgentSessionCommandActivationRecord,
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
					await this.store.renewAgentSessionCommandActivationLease(activation.command_id, {
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
			if (signal.aborted) throw signal.reason ?? new Error("Command activation was aborted");
			const command = await this.store.readAgentSessionCommand(commandId);
			if (!command) throw new AgentSessionCommandActivationTerminalError(`Command vanished: ${commandId}`);
			if (command.state === "completed") return;
			if (command.state === "failed" || command.state === "cancelled" || command.state === "rejected") {
				throw new AgentSessionCommandActivationTerminalError(
					command.error ?? `Command ${commandId} settled ${command.state}`,
				);
			}
			if (Date.now() >= deadline) throw new Error(`Command ${commandId} did not settle durably`);
			await delay(Math.min(10, Math.max(1, deadline - Date.now())), signal);
		}
	}

	private async settleFailure(
		activation: AgentSessionCommandActivationRecord,
		claimToken: string,
		consumer: string,
		error: unknown,
	): Promise<void> {
		const now = this.timestamp();
		const terminal = error instanceof AgentSessionCommandActivationTerminalError;
		const settlement: SettleAgentSessionCommandActivationInput = terminal
			? { consumer, claimToken, now, outcome: "terminal_failure", error: errorMessage(error) }
			: {
					consumer,
					claimToken,
					now,
					outcome: "retryable_failure",
					error: errorMessage(error),
					retryAt: checkedSum(now, retryDelay(activation.attempt, this.retryBaseMs, this.retryMaxMs)),
				};
		try {
			await this.store.settleAgentSessionCommandActivation(activation.command_id, settlement);
		} catch (settleError) {
			this.logger.warn(
				`[command-activation] failed to settle ${activation.command_id}: ${errorMessage(settleError)}`,
			);
		}
	}

	private async waitForWork(observedWake: number, nextAvailableAt: number | null, now: number): Promise<void> {
		if (this.state !== "running" || observedWake !== this.wakeRevision) return;
		const availableDelay =
			nextAvailableAt === null ? this.idlePollMs : nextAvailableAt <= now ? this.retryBaseMs : nextAvailableAt - now;
		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (this.waiter === finish) this.waiter = null;
				resolve();
			};
			const timer = setTimeout(finish, Math.min(this.idlePollMs, availableDelay));
			this.waiter = finish;
			if (this.state !== "running" || observedWake !== this.wakeRevision) finish();
		});
	}

	private markStartupReady(): void {
		if (this.startupReady) return;
		this.startupReady = true;
		this.resolveStartup();
	}

	private timestamp(): number {
		const now = this.now();
		if (!Number.isSafeInteger(now) || now < 0) throw new Error("command activation clock is invalid");
		return now;
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

function checkedSum(left: number, right: number): number {
	const sum = left + right;
	if (!Number.isSafeInteger(sum)) throw new Error("command activation time exceeded safe integer range");
	return sum;
}

function retryDelay(attempt: number, baseMs: number, maxMs: number): number {
	const exponent = Math.min(Math.max(0, attempt - 1), 30);
	return Math.min(maxMs, baseMs * 2 ** exponent);
}

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message.trim() || error.name : String(error).trim();
	return (message || "unknown command activation failure").slice(0, 2_048);
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Command activation wait was aborted"));
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
			reject(signal?.reason ?? new Error("Command activation wait was aborted"));
		};
		const timer = setTimeout(finish, milliseconds);
		signal?.addEventListener("abort", abort, { once: true });
	});
}
