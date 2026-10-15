/**
 * Transport-agnostic event bus for sandbox lifecycle and agent events.
 *
 * The spawner emits BusEvents at every state transition and agent event.
 * Transports (SSE, future webhooks/websockets) subscribe to receive them.
 * The bus holds a bounded replay buffer per sandbox so late joiners get
 * recent history.
 */

import type { ExecutionCell } from "./agent-runtime/execution-service.js";
import type { SandboxRecord, SandboxState, SandboxStore } from "./sandbox-store.js";
import type { AgentSpawnResult, KernelEvent, RuntimeEvent, SandboxEvent } from "./wire-protocol.js";

// ─── Bus Event Types ─────────────────────────────────────────────────────

interface BusEventBase {
	sandbox_id: string;
	ts: string;
}

type SystemWireEvent<T> = BusEventBase & { category: "system" } & T;

// Lifecycle events — emitted by spawner state transitions
export type LifecycleEvent =
	| (BusEventBase & { category: "lifecycle"; type: "queued"; record: SandboxRecord })
	| (BusEventBase & { category: "lifecycle"; type: "spawning" })
	| (BusEventBase & { category: "lifecycle"; type: "running"; pid: number })
	| (BusEventBase & {
			category: "lifecycle";
			type: "terminal";
			state: SandboxState;
			exit_code?: number;
			error_detail?: string;
			/** Final Pi messages from SpawnResult — for session persistence */
			messages?: unknown[];
			/** Full SpawnResult (status/output/turns/tokens/structured_output) — for workflow node telemetry. */
			result?: AgentSpawnResult;
	  });

// Agent events — forwarded from worker SandboxEvent
export type AgentBusEvent = BusEventBase & {
	category: "agent";
	type: SandboxEvent["type"];
	event: SandboxEvent;
};

// System events — worker infrastructure + synthetic snapshot
export type SystemEvent =
	| (BusEventBase & { category: "system"; type: "heartbeat"; iteration?: number })
	| (BusEventBase & { category: "system"; type: "started"; pid?: number })
	| (BusEventBase & { category: "system"; type: "stdout"; text: string })
	| (BusEventBase & { category: "system"; type: "stderr"; text: string })
	| (BusEventBase & { category: "system"; type: "progress"; message: string })
	| SystemWireEvent<Extract<RuntimeEvent, { type: "runtime_ready" }>>
	| SystemWireEvent<Extract<RuntimeEvent, { type: "runtime_busy" }>>
	| SystemWireEvent<Extract<RuntimeEvent, { type: "runtime_stdout" }>>
	| SystemWireEvent<Extract<RuntimeEvent, { type: "runtime_stderr" }>>
	| SystemWireEvent<Extract<RuntimeEvent, { type: "runtime_result" }>>
	| SystemWireEvent<Extract<RuntimeEvent, { type: "runtime_exit" }>>
	| SystemWireEvent<Extract<KernelEvent, { type: "kernel_ready" }>>
	| SystemWireEvent<Extract<KernelEvent, { type: "kernel_busy" }>>
	| SystemWireEvent<Extract<KernelEvent, { type: "kernel_idle" }>>
	| SystemWireEvent<Extract<KernelEvent, { type: "kernel_stream" }>>
	| SystemWireEvent<Extract<KernelEvent, { type: "kernel_display" }>>
	| SystemWireEvent<Extract<KernelEvent, { type: "kernel_result" }>>
	| SystemWireEvent<Extract<KernelEvent, { type: "kernel_error" }>>
	| SystemWireEvent<Extract<KernelEvent, { type: "kernel_reply" }>>
	| SystemWireEvent<Extract<KernelEvent, { type: "kernel_exit" }>>
	| (BusEventBase & {
			category: "system";
			type: "snapshot";
			record: SandboxRecord;
			recent_events: BusEvent[];
	  });

// Authority events — session-scoped multi-driver permission fan-out (CA-1/S6).
// Emitted when the ACP authority backend opens a `request_permission` so every
// session subscriber (the drivers + observers) sees the pending ask and can
// answer. The SSE transport renders the category as the event-type prefix
// (`event: authority:permission`), per the existing writeSseEvent convention.
export type AuthorityEvent = BusEventBase & {
	category: "authority";
	type: "permission";
	/** The pending permission request id (correlates the eventual driver answer). */
	call_id: string;
	/** The tool the agent wants to call (for the driver's decision UI). */
	tool?: string;
	/** The current driver the request is addressed to (null if unclaimed). */
	driver_id: string | null;
};

/**
 * Content-free testimony for one host-mediated capability call. Arguments and
 * results deliberately never enter the shared event stream; receipts need the
 * operation and outcome, not user or graph content.
 */
export type CapabilityEvent = BusEventBase & {
	category: "capability";
	type: "call";
	call_id: string;
	capability: string;
	operation: string;
	outcome: "ok" | "error" | "denied";
	duration_ms: number;
	/** Content-addressed receipt for a successful result; never the result body. */
	result_digest?: string;
	/** Meaningful Objects witnessed in the successful host result. */
	object_refs?: readonly import("./agent-runtime/meaningful-object.js").MeaningfulObjectRefV1[];
	/** Host authority decision when the capability performs a CAS mutation. */
	decision?: "proposed" | "accepted" | "rejected";
	revision?: number;
	reason?: string;
};

export type ExecutionEvent = BusEventBase & {
	category: "execution";
	type: "compute.cell";
	cell: ExecutionCell;
};

/** Resident Prime control-plane results; these do not imply process exit. */
export type AgentRuntimeEvent =
	| (BusEventBase & {
			category: "agent-runtime";
			type: "materialization.result";
			result: AgentSpawnResult;
	  })
	| (BusEventBase & {
			category: "agent-runtime";
			type: "command.result";
			command_id: string;
			command_name: string;
			status: "completed" | "failed";
			result?: AgentSpawnResult;
			error?: string;
	  });

export type BusEvent =
	| LifecycleEvent
	| AgentBusEvent
	| SystemEvent
	| AuthorityEvent
	| CapabilityEvent
	| ExecutionEvent
	| AgentRuntimeEvent;

// ─── Subscriber Interface ────────────────────────────────────────────────

export type BusSubscriber = (event: BusEvent) => void;

export interface SubscribeOptions {
	sandbox_id: string;
}

export interface SandboxEventBus {
	/** Emit an event to all subscribers for that sandbox. */
	emit(event: BusEvent): void;

	/**
	 * Subscribe to events for a sandbox. The subscriber immediately receives
	 * a synthetic `snapshot` event with the current record and replay buffer.
	 * Returns an unsubscribe function.
	 */
	subscribe(subscriber: BusSubscriber, options: SubscribeOptions): () => void;

	/** Number of active subscribers for a sandbox. */
	subscriberCount(sandboxId: string): number;

	/** Remove all state for a sandbox. Call after terminal + grace period. */
	cleanup(sandboxId: string): void;
}

// ─── Implementation ──────────────────────────────────────────────────────

const DEFAULT_REPLAY_BUFFER_SIZE = 200;
const DEFAULT_CLEANUP_DELAY_MS = 30_000;

interface SandboxChannel {
	subscribers: Set<BusSubscriber>;
	recentEvents: BusEvent[];
	cleanupTimer?: ReturnType<typeof setTimeout>;
}

export interface EventBusOptions {
	replayBufferSize?: number;
	cleanupDelayMs?: number;
}

export function createSandboxEventBus(store: SandboxStore, options?: EventBusOptions): SandboxEventBus {
	const channels = new Map<string, SandboxChannel>();
	const replayBufferSize = options?.replayBufferSize ?? DEFAULT_REPLAY_BUFFER_SIZE;
	const cleanupDelayMs = options?.cleanupDelayMs ?? DEFAULT_CLEANUP_DELAY_MS;

	function getOrCreateChannel(sandboxId: string): SandboxChannel {
		let channel = channels.get(sandboxId);
		if (!channel) {
			channel = { subscribers: new Set(), recentEvents: [] };
			channels.set(sandboxId, channel);
		}
		return channel;
	}

	function emit(event: BusEvent): void {
		const channel = getOrCreateChannel(event.sandbox_id);

		// Append to replay buffer (bounded ring)
		channel.recentEvents.push(event);
		if (channel.recentEvents.length > replayBufferSize) {
			channel.recentEvents.splice(0, channel.recentEvents.length - replayBufferSize);
		}

		// Fan out to subscribers
		for (const subscriber of channel.subscribers) {
			try {
				subscriber(event);
			} catch (err) {
				console.error(
					`[event-bus] subscriber error for sandbox ${event.sandbox_id}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// Schedule cleanup after terminal lifecycle events
		// ("category" guard: the runtime_ready BusEvent arm carries no category)
		if ("category" in event && event.category === "lifecycle" && event.type === "terminal") {
			scheduleCleanup(event.sandbox_id, channel);
		}
	}

	function subscribe(subscriber: BusSubscriber, opts: SubscribeOptions): () => void {
		const channel = getOrCreateChannel(opts.sandbox_id);
		channel.subscribers.add(subscriber);

		// Deliver snapshot immediately
		const record = store.get(opts.sandbox_id);
		if (record) {
			const snapshot: BusEvent = {
				category: "system",
				type: "snapshot",
				sandbox_id: opts.sandbox_id,
				ts: new Date().toISOString(),
				record,
				recent_events: [...channel.recentEvents],
			};
			try {
				subscriber(snapshot);
			} catch (err) {
				console.error(
					`[event-bus] snapshot delivery error for sandbox ${opts.sandbox_id}: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		return () => {
			channel.subscribers.delete(subscriber);
		};
	}

	function subscriberCount(sandboxId: string): number {
		return channels.get(sandboxId)?.subscribers.size ?? 0;
	}

	function cleanup(sandboxId: string): void {
		const channel = channels.get(sandboxId);
		if (channel?.cleanupTimer) {
			clearTimeout(channel.cleanupTimer);
		}
		channels.delete(sandboxId);
	}

	function scheduleCleanup(sandboxId: string, channel: SandboxChannel): void {
		if (channel.cleanupTimer) return;
		channel.cleanupTimer = setTimeout(() => {
			// Only clean up if no subscribers remain
			if (channel.subscribers.size === 0) {
				channels.delete(sandboxId);
			} else {
				// Retry later — subscribers still connected
				channel.cleanupTimer = undefined;
				scheduleCleanup(sandboxId, channel);
			}
		}, cleanupDelayMs);
	}

	return { emit, subscribe, subscriberCount, cleanup };
}
