/**
 * Application metrics catalog.
 *
 * All instruments defined here so there's a single source of truth.
 * Uses @opentelemetry/api — calls are no-ops when SDK isn't registered (tests safe).
 */

import { type Counter, type Histogram, metrics, type UpDownCounter } from "@opentelemetry/api";

const meter = metrics.getMeter("sandbox-mgmt");

// ─── Gauges (UpDownCounters — event-driven +1/-1) ────────────────────────

export const activeSandboxes = meter.createUpDownCounter("sandbox_mgmt.active_sandboxes", {
	description: "Number of currently active sandboxes",
	unit: "{sandbox}",
});

export const spawnQueueDepth = meter.createUpDownCounter("sandbox_mgmt.spawn_queue_depth", {
	description: "Number of sandboxes waiting in the spawn queue",
	unit: "{sandbox}",
});

export const internalStageQueueDepth = meter.createUpDownCounter("phanes.transcription.queue_depth", {
	description: "Number of Phanes transcription stages waiting for an ASR sandbox",
	unit: "{job}",
});

// ─── Gauges (Observable — sampled periodically by SDK) ───────────────────

meter
	.createObservableGauge("sandbox_mgmt.process.rss_bytes", {
		description: "Orchestrator process RSS",
		unit: "By",
	})
	.addCallback((obs) => {
		obs.observe(process.memoryUsage().rss);
	});

meter
	.createObservableGauge("sandbox_mgmt.process.heap_used_bytes", {
		description: "Orchestrator process heap used",
		unit: "By",
	})
	.addCallback((obs) => {
		obs.observe(process.memoryUsage().heapUsed);
	});

meter
	.createObservableGauge("sandbox_mgmt.process.uptime_seconds", {
		description: "Orchestrator process uptime",
		unit: "s",
	})
	.addCallback((obs) => {
		obs.observe(process.uptime());
	});

// ─── Counters (monotonic) ────────────────────────────────────────────────

export const spawnsTotal = meter.createCounter("sandbox_mgmt.spawns_total", {
	description: "Total sandboxes spawned",
	unit: "{spawn}",
});

export const spawnErrorsTotal = meter.createCounter("sandbox_mgmt.spawn_errors_total", {
	description: "Total sandbox spawn errors",
	unit: "{error}",
});

export const exitsTotal = meter.createCounter("sandbox_mgmt.exits_total", {
	description: "Total sandbox exits",
	unit: "{exit}",
});

export const killsTotal = meter.createCounter("sandbox_mgmt.kills_total", {
	description: "Total sandbox kills",
	unit: "{kill}",
});

export const cgroupAssignFailuresTotal = meter.createCounter("sandbox_mgmt.cgroup_assign_failures_total", {
	description: "Total cgroup assignment failures",
	unit: "{failure}",
});

export const cgroupStaleCleanups = meter.createCounter("sandbox_mgmt.cgroup_stale_cleanups_total", {
	description: "Total stale cgroups cleaned up",
	unit: "{cleanup}",
});

export const agentRunsTotal = meter.createCounter("sandbox_mgmt.agent_runs_total", {
	description: "Total agent runs started inside sandboxes",
	unit: "{run}",
});

export const agentRunErrorsTotal = meter.createCounter("sandbox_mgmt.agent_run_errors_total", {
	description: "Total agent runs that ended in error",
	unit: "{error}",
});

export const llmRequestsTotal = meter.createCounter("sandbox_mgmt.llm_requests_total", {
	description: "Total LLM requests proxied through the sandbox manager",
	unit: "{request}",
});

export const llmTokensTotal = meter.createCounter("sandbox_mgmt.llm_tokens_total", {
	description: "Total LLM tokens observed on terminal proxy events",
	unit: "{token}",
});

export const toolCallsTotal = meter.createCounter("sandbox_mgmt.tool_calls_total", {
	description: "Total tool calls executed in sandbox agent runs",
	unit: "{call}",
});

export const authContextsTotal = meter.createCounter("sandbox_mgmt.auth_contexts_total", {
	description: "Total auth contexts resolved for sandbox management requests",
	unit: "{context}",
});

export const hostedSessionOperationsTotal = meter.createCounter("sandbox_mgmt.hosted_session_operations_total", {
	description: "Total hosted session lifecycle operations performed by the spike",
	unit: "{operation}",
});

export const hostedSessionFallbacksTotal = meter.createCounter("sandbox_mgmt.hosted_session_fallbacks_total", {
	description: "Total compatibility fallbacks taken during hosted session operations",
	unit: "{fallback}",
});

export const gateCallsTotal = meter.createCounter("sandbox_mgmt.gate_calls_total", {
	description: "Total gate calls dispatched to hosted Mnemosyne proxy",
	unit: "{call}",
});

export const internalStageJobsTotal = meter.createCounter("phanes.transcription.jobs_total", {
	description: "Total completed or cancelled Phanes transcription stage attempts",
	unit: "{job}",
});

// ─── Histograms ──────────────────────────────────────────────────────────

export const sandboxLifetimeSeconds = meter.createHistogram("sandbox_mgmt.sandbox_lifetime_seconds", {
	description: "Sandbox wall-clock lifetime from running to exit",
	unit: "s",
	advice: {
		explicitBucketBoundaries: [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600],
	},
});

export const spawnDurationSeconds = meter.createHistogram("sandbox_mgmt.spawn_duration_seconds", {
	description: "Time from spawn() entry to running state",
	unit: "s",
	advice: {
		explicitBucketBoundaries: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
	},
});

export const spawnQueueWaitSeconds = meter.createHistogram("sandbox_mgmt.spawn_queue_wait_seconds", {
	description: "Time spent waiting in spawn queue before execution starts",
	unit: "s",
	advice: {
		explicitBucketBoundaries: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
	},
});

export const memoryPeakBytes = meter.createHistogram("sandbox_mgmt.memory_peak_bytes", {
	description: "Peak memory usage per sandbox from cgroup",
	unit: "By",
	advice: {
		explicitBucketBoundaries: [
			1_000_000, 5_000_000, 10_000_000, 25_000_000, 50_000_000, 100_000_000, 256_000_000, 512_000_000, 1_000_000_000,
		],
	},
});

export const cpuUsageSeconds = meter.createHistogram("sandbox_mgmt.cpu_usage_seconds", {
	description: "Total CPU time per sandbox from cgroup",
	unit: "s",
	advice: {
		explicitBucketBoundaries: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 30, 60],
	},
});

export const agentRunDurationSeconds = meter.createHistogram("sandbox_mgmt.agent_run_duration_seconds", {
	description: "Wall-clock duration of agent runs",
	unit: "s",
	advice: {
		explicitBucketBoundaries: [1, 5, 10, 30, 60, 120, 300, 600],
	},
});

export const agentTurnsPerRun = meter.createHistogram("sandbox_mgmt.agent_turns_per_run", {
	description: "Number of turns completed by an agent run",
	unit: "{turn}",
	advice: {
		explicitBucketBoundaries: [1, 2, 3, 5, 8, 12, 20, 50],
	},
});

export const llmRequestDurationSeconds = meter.createHistogram("sandbox_mgmt.llm_request_duration_seconds", {
	description: "Duration of proxied LLM requests from request to final chunk",
	unit: "s",
	advice: {
		explicitBucketBoundaries: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
	},
});

export const toolCallDurationSeconds = meter.createHistogram("sandbox_mgmt.tool_call_duration_seconds", {
	description: "Duration of tool call execution inside sandbox agent runs",
	unit: "s",
	advice: {
		explicitBucketBoundaries: [0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
	},
});

export const hostedSessionOperationDurationSeconds = meter.createHistogram(
	"sandbox_mgmt.hosted_session_operation_duration_seconds",
	{
		description: "Duration of hosted session lifecycle operations",
		unit: "s",
		advice: {
			explicitBucketBoundaries: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
		},
	},
);

export const gateCallDurationSeconds = meter.createHistogram("sandbox_mgmt.gate_call_duration_seconds", {
	description: "Duration of gate calls to hosted Mnemosyne proxy",
	unit: "s",
	advice: {
		explicitBucketBoundaries: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
	},
});

export const transcriptionWallSeconds = meter.createHistogram("phanes.transcription.wall_seconds", {
	description: "ASR wrapper wall-clock duration",
	unit: "s",
	advice: {
		explicitBucketBoundaries: [1, 5, 10, 30, 60, 120, 300, 600, 1800, 3600, 10_800],
	},
});

export const transcriptionRtf = meter.createHistogram("phanes.transcription.rtf", {
	description: "ASR wall time divided by captured audio duration",
	unit: "1",
	advice: {
		explicitBucketBoundaries: [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 4, 8],
	},
});

export const transcriptionPeakRssBytes = meter.createHistogram("phanes.transcription.peak_rss_bytes", {
	description: "Peak RSS reported by the ASR child process",
	unit: "By",
	advice: {
		explicitBucketBoundaries: [256_000_000, 512_000_000, 1_000_000_000, 2_000_000_000, 4_000_000_000, 6_000_000_000],
	},
});

// ─── Sessions ───────────────────────────────────────────────────────────

export const sessionCount = meter.createUpDownCounter("sandbox_mgmt.session_count", {
	description: "Number of sessions by status (label: status)",
	unit: "{session}",
});

// ─── SSE Transport ──────────────────────────────────────────────────────

export const sseConnectionsActive = meter.createUpDownCounter("sandbox_mgmt.sse.connections_active", {
	description: "Number of active SSE connections",
	unit: "{connection}",
});

export const sseConnectionsTotal = meter.createCounter("sandbox_mgmt.sse.connections_total", {
	description: "Total SSE connections opened",
	unit: "{connection}",
});

export const sseEventsTotal = meter.createCounter("sandbox_mgmt.sse.events_total", {
	description: "Total SSE events sent to clients",
	unit: "{event}",
});

export const sseDroppedEventsTotal = meter.createCounter("sandbox_mgmt.sse.dropped_events_total", {
	description: "Total SSE events dropped due to backpressure",
	unit: "{event}",
});

export const sseConnectionDurationSeconds = meter.createHistogram("sandbox_mgmt.sse.connection_duration_seconds", {
	description: "Duration of SSE connections from open to close",
	unit: "s",
	advice: {
		explicitBucketBoundaries: [1, 5, 10, 30, 60, 120, 300, 600, 1800],
	},
});

// ─── Catalog Export ─────────────────────────────────────────────────────
// Re-export all instruments as a typed catalog for dependency injection.

export interface MetricsCatalog {
	activeSandboxes: UpDownCounter;
	spawnQueueDepth: UpDownCounter;
	internalStageQueueDepth: UpDownCounter;
	spawnsTotal: Counter;
	spawnErrorsTotal: Counter;
	exitsTotal: Counter;
	killsTotal: Counter;
	cgroupAssignFailuresTotal: Counter;
	cgroupStaleCleanups: Counter;
	agentRunsTotal: Counter;
	agentRunErrorsTotal: Counter;
	llmRequestsTotal: Counter;
	llmTokensTotal: Counter;
	toolCallsTotal: Counter;
	authContextsTotal: Counter;
	hostedSessionOperationsTotal: Counter;
	hostedSessionFallbacksTotal: Counter;
	gateCallsTotal: Counter;
	internalStageJobsTotal: Counter;
	sandboxLifetimeSeconds: Histogram;
	spawnDurationSeconds: Histogram;
	spawnQueueWaitSeconds: Histogram;
	memoryPeakBytes: Histogram;
	cpuUsageSeconds: Histogram;
	agentRunDurationSeconds: Histogram;
	agentTurnsPerRun: Histogram;
	llmRequestDurationSeconds: Histogram;
	toolCallDurationSeconds: Histogram;
	hostedSessionOperationDurationSeconds: Histogram;
	gateCallDurationSeconds: Histogram;
	transcriptionWallSeconds: Histogram;
	transcriptionRtf: Histogram;
	transcriptionPeakRssBytes: Histogram;
	sessionCount: UpDownCounter;
	sseConnectionsActive: UpDownCounter;
	sseConnectionsTotal: Counter;
	sseEventsTotal: Counter;
	sseDroppedEventsTotal: Counter;
	sseConnectionDurationSeconds: Histogram;
}

export const catalog: MetricsCatalog = {
	activeSandboxes,
	spawnQueueDepth,
	internalStageQueueDepth,
	spawnsTotal,
	spawnErrorsTotal,
	exitsTotal,
	killsTotal,
	cgroupAssignFailuresTotal,
	cgroupStaleCleanups,
	agentRunsTotal,
	agentRunErrorsTotal,
	llmRequestsTotal,
	llmTokensTotal,
	toolCallsTotal,
	authContextsTotal,
	hostedSessionOperationsTotal,
	hostedSessionFallbacksTotal,
	gateCallsTotal,
	internalStageJobsTotal,
	sandboxLifetimeSeconds,
	spawnDurationSeconds,
	spawnQueueWaitSeconds,
	memoryPeakBytes,
	cpuUsageSeconds,
	agentRunDurationSeconds,
	agentTurnsPerRun,
	llmRequestDurationSeconds,
	toolCallDurationSeconds,
	hostedSessionOperationDurationSeconds,
	gateCallDurationSeconds,
	transcriptionWallSeconds,
	transcriptionRtf,
	transcriptionPeakRssBytes,
	sessionCount,
	sseConnectionsActive,
	sseConnectionsTotal,
	sseEventsTotal,
	sseDroppedEventsTotal,
	sseConnectionDurationSeconds,
};
