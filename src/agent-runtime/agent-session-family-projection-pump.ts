import type {
	AgentSessionFamilyProjectionOutboxClaim,
	AgentSessionFamilyProjectionOutboxRecord,
	AgentSessionRecord,
} from "../workflow/runtime-store.js";
import {
	type AgentSessionFamilyGraphProxy,
	buildAgentSessionFamilyProjection,
	buildAgentSessionFamilyProjectionRetirement,
} from "./agent-session-family-graph-projection.js";

/** Durable coordinates from which the host may mint service graph authority. */
export interface AgentSessionFamilyProjectionGraphAuthority {
	readonly rootSessionId: string;
	/** Acting user retained only for gateway on-behalf-of service auth. */
	readonly ownerUserId: string;
	/** Exact typed owner component of the durable graph address. */
	readonly graphOwnerPrincipal: string;
	readonly graphId: string;
}

/**
 * A projection-owned proxy. It must not be borrowed from an Agent body: an
 * outbox claim can outlive every materialization in the family.
 */
export interface AgentSessionFamilyProjectionGraphLease {
	readonly proxy: AgentSessionFamilyGraphProxy;
	close(): Promise<void>;
}

export type AgentSessionFamilyProjectionGraphProxyFactory = (
	authority: AgentSessionFamilyProjectionGraphAuthority,
) => Promise<AgentSessionFamilyProjectionGraphLease>;

export interface AgentSessionFamilyProjectionPumpStore {
	claimAgentSessionFamilyProjectionOutbox(input: {
		readonly consumer: string;
		readonly leaseMs: number;
		readonly now: number;
	}): Promise<AgentSessionFamilyProjectionOutboxClaim | null>;
	readAgentSessionFamilyProjectionOutboxNextAvailableAt(now: number): Promise<number | null>;
	renewAgentSessionFamilyProjectionOutboxLease(input: {
		readonly rootSessionId: string;
		readonly consumer: string;
		readonly claimToken: string;
		readonly leaseMs: number;
		readonly now: number;
	}): Promise<AgentSessionFamilyProjectionOutboxRecord>;
	completeAgentSessionFamilyProjectionOutbox(input: {
		readonly rootSessionId: string;
		readonly consumer: string;
		readonly claimToken: string;
		readonly workKind: "project" | "retire";
		readonly projectedRevision: number;
		readonly now: number;
	}): Promise<AgentSessionFamilyProjectionOutboxRecord>;
	retryAgentSessionFamilyProjectionOutbox(input: {
		readonly rootSessionId: string;
		readonly consumer: string;
		readonly claimToken: string;
		readonly error: string;
		readonly retryAt: number;
		readonly now: number;
	}): Promise<AgentSessionFamilyProjectionOutboxRecord>;
	readAgentSession(sessionId: string): Promise<AgentSessionRecord | null>;
}

export interface AgentSessionFamilyProjectionPumpLogger {
	error(message: string): void;
	warn(message: string): void;
}

export interface AgentSessionFamilyProjectionPumpOptions {
	readonly store: AgentSessionFamilyProjectionPumpStore;
	readonly proxyFactory: AgentSessionFamilyProjectionGraphProxyFactory;
	readonly consumer: string;
	readonly leaseMs?: number;
	readonly retryBaseMs?: number;
	readonly retryMaxMs?: number;
	readonly idlePollMs?: number;
	readonly now?: () => number;
	readonly logger?: AgentSessionFamilyProjectionPumpLogger;
	/**
	 * Whether a family is projected into its graph at all (default: every family). A family the host must not write
	 * for (a Reader workspace chat, exam 1) has its outbox settled without graph authority ever being minted.
	 */
	readonly projects?: (root: AgentSessionRecord) => boolean;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 30_000;
const DEFAULT_IDLE_POLL_MS = 1_000;

/**
 * Crash-safe, execution-independent delivery of Agent Session family display
 * testimony. SQLite is authoritative; this service owns no family state.
 */
export class AgentSessionFamilyProjectionPump {
	private readonly store: AgentSessionFamilyProjectionPumpStore;
	private readonly proxyFactory: AgentSessionFamilyProjectionGraphProxyFactory;
	private readonly consumer: string;
	private readonly leaseMs: number;
	private readonly retryBaseMs: number;
	private readonly retryMaxMs: number;
	private readonly idlePollMs: number;
	private readonly now: () => number;
	private readonly logger: AgentSessionFamilyProjectionPumpLogger;
	private readonly projects: (root: AgentSessionRecord) => boolean;
	private state: "idle" | "running" | "draining" | "stopped" = "idle";
	private loop: Promise<void> | null = null;
	private wakeRevision = 0;
	private waiter: (() => void) | null = null;
	private readonly startup: Promise<void>;
	private resolveStartup!: () => void;
	private startupReady = false;

	constructor(options: AgentSessionFamilyProjectionPumpOptions) {
		this.store = options.store;
		this.proxyFactory = options.proxyFactory;
		this.consumer = requiredText(options.consumer, "projection pump consumer");
		this.leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_LEASE_MS, "projection pump lease duration");
		this.retryBaseMs = positiveInteger(options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS, "projection pump retry base");
		this.retryMaxMs = positiveInteger(options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS, "projection pump retry maximum");
		if (this.retryMaxMs < this.retryBaseMs) {
			throw new Error("projection pump retry maximum cannot be less than its base");
		}
		this.idlePollMs = positiveInteger(options.idlePollMs ?? DEFAULT_IDLE_POLL_MS, "projection pump idle poll");
		this.now = options.now ?? Date.now;
		this.logger = options.logger ?? console;
		this.projects = options.projects ?? (() => true);
		this.startup = new Promise<void>((resolve) => {
			this.resolveStartup = resolve;
		});
	}

	/** Start and resolve only after the initial ready sweep reaches durable emptiness. */
	start(): Promise<void> {
		if (this.state === "running") return this.startup;
		if (this.state !== "idle") throw new Error("Agent Session family projection pump cannot be restarted");
		this.state = "running";
		this.loop = this.run();
		return this.startup;
	}

	/** Non-blocking nudge for a host that knows a durable mutation just committed. */
	wake(): void {
		this.wakeRevision += 1;
		const waiter = this.waiter;
		this.waiter = null;
		waiter?.();
	}

	/** Latch shutdown, drain every ready/coalesced claim, and stop at durable emptiness. */
	async stop(): Promise<void> {
		if (this.state === "idle") {
			this.state = "stopped";
			return;
		}
		if (this.state === "stopped") return;
		this.state = "draining";
		this.wake();
		await this.loop;
		this.state = "stopped";
	}

	private async run(): Promise<void> {
		while (this.state === "running" || this.state === "draining") {
			try {
				const claim = await this.store.claimAgentSessionFamilyProjectionOutbox({
					consumer: this.consumer,
					leaseMs: this.leaseMs,
					now: this.timestamp(),
				});
				if (claim) {
					await this.deliver(claim);
					continue;
				}
				if (this.state === "draining") {
					this.markStartupReady();
					return;
				}

				const observedWake = this.wakeRevision;
				const now = this.timestamp();
				const nextAvailableAt = await this.store.readAgentSessionFamilyProjectionOutboxNextAvailableAt(now);
				if (nextAvailableAt !== null && nextAvailableAt <= now) continue;
				const waiting = this.waitForWork(observedWake, nextAvailableAt, now);
				this.markStartupReady();
				await waiting;
			} catch (error) {
				this.logger.error(`[family-projector] pump iteration failed: ${errorMessage(error)}`);
				if (this.state === "draining") {
					await delay(this.retryBaseMs);
				} else {
					await this.waitForWork(this.wakeRevision, this.timestamp() + this.retryBaseMs, this.timestamp());
				}
			}
		}
	}

	private markStartupReady(): void {
		if (this.startupReady) return;
		this.startupReady = true;
		this.resolveStartup();
	}

	private async deliver(claim: AgentSessionFamilyProjectionOutboxClaim): Promise<void> {
		const work = claim.work;
		const token = requiredText(work.claim_token, "projection outbox claim token");
		const consumer = requiredText(work.consumer, "projection outbox consumer");
		const projectedRevision = nonNegativeInteger(
			work.claimed_projection_revision,
			"projection outbox claimed graph revision",
		);
		let renewalError: unknown = null;
		const renewal = this.renewUntilSettled(work, token, consumer, (error) => {
			renewalError = error;
		});
		let graphApplied = false;
		try {
			const root = await this.store.readAgentSession(work.root_session_id);
			if (!root) throw new Error(`projection root Session not found: ${work.root_session_id}`);
			const authority = durableAuthority(work.root_session_id, root);
			validateClaimAuthority(claim, authority, projectedRevision, root.agent_id);
			if (!this.projects(root)) {
				// Not this family's to project: settle the claim, mint no graph authority, write nothing.
				graphApplied = true;
			} else {
				const graphLease = await this.proxyFactory(authority);
				try {
					const update =
						work.work_kind === "project"
							? buildAgentSessionFamilyProjection(claim.snapshot!)
							: buildAgentSessionFamilyProjectionRetirement({
									graphId: authority.graphId,
									rootSessionId: authority.rootSessionId,
									rootAgentId: requiredText(root.agent_id, "projection root Agent identity"),
									projectionRevision: projectedRevision,
								});
					await graphLease.proxy.callTool("sparql_update", { graphId: authority.graphId, update });
					graphApplied = true;
				} finally {
					try {
						await graphLease.close();
					} catch (error) {
						this.logger.warn(
							`[family-projector] graph proxy close failed for ${work.root_session_id}: ${errorMessage(error)}`,
						);
					}
				}
			}
		} catch (error) {
			await renewal.stop();
			if (renewalError) {
				this.logger.warn(
					`[family-projector] claim lost while projection failed for ${work.root_session_id}: ${errorMessage(renewalError)}`,
				);
				return;
			}
			await this.retry(work, token, consumer, error);
			return;
		}

		await renewal.stop();
		if (!graphApplied || renewalError) {
			this.logger.warn(
				`[family-projector] graph write completed without a live claim for ${work.root_session_id}: ${errorMessage(renewalError)}`,
			);
			return;
		}
		try {
			await this.store.completeAgentSessionFamilyProjectionOutbox({
				rootSessionId: work.root_session_id,
				consumer,
				claimToken: token,
				workKind: work.work_kind,
				projectedRevision,
				now: this.timestamp(),
			});
		} catch (error) {
			// The graph CAS is safe to replay after claim expiry. Leaving this claim
			// intact is more honest than converting a possibly stale token to retry.
			this.logger.warn(
				`[family-projector] completion lost for ${work.root_session_id}; graph CAS will replay: ${errorMessage(error)}`,
			);
		}
	}

	private renewUntilSettled(
		work: AgentSessionFamilyProjectionOutboxRecord,
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
					await this.store.renewAgentSessionFamilyProjectionOutboxLease({
						rootSessionId: work.root_session_id,
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

	private async retry(
		work: AgentSessionFamilyProjectionOutboxRecord,
		claimToken: string,
		consumer: string,
		error: unknown,
	): Promise<void> {
		const attempt = retryAttempt(work.last_error) + 1;
		const exponent = Math.min(attempt - 1, 30);
		const delayMs = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** exponent);
		const now = this.timestamp();
		try {
			await this.store.retryAgentSessionFamilyProjectionOutbox({
				rootSessionId: work.root_session_id,
				consumer,
				claimToken,
				error: `projection pump attempt ${String(attempt)}: ${errorMessage(error)}`.slice(0, 2_048),
				retryAt: now + delayMs,
				now,
			});
		} catch (retryError) {
			this.logger.warn(
				`[family-projector] retry claim lost for ${work.root_session_id}: ${errorMessage(retryError)}`,
			);
		}
	}

	private async waitForWork(observedWake: number, nextAvailableAt: number | null, now: number): Promise<void> {
		if (this.state !== "running" || observedWake !== this.wakeRevision) return;
		const availableDelay = nextAvailableAt === null ? this.idlePollMs : Math.max(0, nextAvailableAt - now);
		const delayMs = Math.min(this.idlePollMs, availableDelay);
		if (delayMs === 0) return;
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
		return nonNegativeInteger(this.now(), "projection pump clock");
	}
}

function durableAuthority(rootSessionId: string, root: AgentSessionRecord): AgentSessionFamilyProjectionGraphAuthority {
	if (root.session_id !== rootSessionId) throw new Error("projection root lookup returned a different Session");
	return {
		rootSessionId,
		ownerUserId: requiredText(root.owner_user_id, "projection root owner"),
		graphOwnerPrincipal: requiredText(root.graph_owner_principal, "projection root graph owner"),
		graphId: requiredText(root.graph_id, "projection root graph"),
	};
}

function validateClaimAuthority(
	claim: AgentSessionFamilyProjectionOutboxClaim,
	authority: AgentSessionFamilyProjectionGraphAuthority,
	projectionRevision: number,
	durableRootAgentId: string | null,
): void {
	if (claim.work.work_kind === "retire") {
		if (claim.snapshot !== null) throw new Error("retirement projection claim cannot carry a family snapshot");
		return;
	}
	if (!claim.snapshot) throw new Error("family projection claim is missing its atomic snapshot");
	if (claim.snapshot.projectionRevision !== projectionRevision) {
		throw new Error("family projection claim snapshot crossed its claimed revision");
	}
	if (claim.snapshot.root.sessionId !== authority.rootSessionId || claim.snapshot.root.graphId !== authority.graphId) {
		throw new Error("family projection claim crossed its durable root authority");
	}
	if (claim.snapshot.root.agentId !== durableRootAgentId) {
		throw new Error("family projection claim crossed its durable root Agent identity");
	}
}

function requiredText(value: string | null, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required`);
	return value;
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
	return value;
}

function nonNegativeInteger(value: number | null, label: string): number {
	if (!Number.isSafeInteger(value) || value === null || value < 0) {
		throw new Error(`${label} must be a non-negative safe integer`);
	}
	return value;
}

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message.trim() || error.name : String(error).trim();
	return message || "unknown family projection failure";
}

function retryAttempt(lastError: string | null): number {
	const match = lastError?.match(/^projection pump attempt ([1-9][0-9]*):/);
	if (!match) return 0;
	const attempt = Number(match[1]);
	return Number.isSafeInteger(attempt) ? attempt : 0;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
