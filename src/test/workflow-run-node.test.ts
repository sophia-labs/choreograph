import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type BusEvent, createSandboxEventBus } from "../event-bus.js";
import type { SandboxStore } from "../sandbox-store.js";
import type { SpawnOptions } from "../spawner.js";
import {
	awaitNodeResult,
	makeNodeRunner,
	REQUIRED_STRUCTURED_OUTPUT_ERROR,
	resolvePersonalWorkspaceMount,
} from "../workflow/run-node.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

// The event bus only calls store.get() (for the initial snapshot); a stub suffices.
const stubStore = { get: () => undefined } as unknown as SandboxStore;

const spec: AgentNodeSpec = {
	label: "map:d1",
	phaseIndex: 1,
	prompt: "survey d1",
	model: "mistralai/mistral-nemo",
	provider: "openrouter",
	graphId: "g1",
	agentType: "graph-surveyor",
};

const semantic = makeTestAgentSemanticBinding({ graphId: "g1", registeredName: "graph-surveyor" });

describe("personal Prime workspace", () => {
	it("binds the host path read-write only for the configured owner and Prime runtime", () => {
		const root = mkdtempSync(join(tmpdir(), "personal-prime-workspace-test-"));
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		const environment = {
			CHOREOGRAPH_PERSONAL_WORKSPACE_HOST_PATH: workspace,
			CHOREOGRAPH_PERSONAL_WORKSPACE_OWNER_USER_ID: "owner-1",
		};
		try {
			assert.deepEqual(
				resolvePersonalWorkspaceMount({ ownerUserId: "owner-1", runtimeKind: "prime" }, environment),
				{
					hostPath: realpathSync(workspace),
					guestPath: "/workspace",
					mode: "rw",
				},
			);
			assert.equal(
				resolvePersonalWorkspaceMount({ ownerUserId: "owner-2", runtimeKind: "prime" }, environment),
				undefined,
			);
			assert.equal(
				resolvePersonalWorkspaceMount({ ownerUserId: "owner-1", runtimeKind: "simple" }, environment),
				undefined,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function terminalEvent(sandboxId: string): BusEvent {
	return {
		category: "lifecycle",
		type: "terminal",
		sandbox_id: sandboxId,
		ts: new Date(1500).toISOString(),
		state: "done",
		result: {
			spawn_id: sandboxId,
			status: "terminated",
			output: "ok",
			turns: 1,
			tokens: 0,
			tool_calls: 0,
		},
	} as BusEvent;
}

describe("awaitNodeResult", () => {
	it("maps the terminal event's SpawnResult to an AgentNodeResult with telemetry", async () => {
		const bus = createSandboxEventBus(stubStore);
		const pending = awaitNodeResult(bus, "sb-1", spec, 1000, () => 9999);

		bus.emit({
			category: "lifecycle",
			type: "running",
			sandbox_id: "sb-1",
			ts: new Date(1200).toISOString(),
			pid: 42,
		} as BusEvent);
		bus.emit({
			category: "lifecycle",
			type: "terminal",
			sandbox_id: "sb-1",
			ts: new Date(9000).toISOString(),
			state: "done",
			result: {
				spawn_id: "sb-1",
				status: "terminated",
				output: "ok",
				turns: 3,
				tokens: 512,
				tool_calls: 2,
				structured_output: { docId: "d1", relevance: 0.9, keyPoints: ["k"], evidence: ["e"] },
				prime_state: { schema: "sophia.prime-runtime-state.v2", digest: `sha256:${"c".repeat(64)}` },
			},
		} as BusEvent);

		const result = await pending;
		assert.equal(result.label, "map:d1");
		assert.equal(result.phaseIndex, 1);
		assert.equal(result.state, "done");
		assert.equal(result.output, "ok");
		assert.equal(result.turns, 3);
		assert.equal(result.tokens, 512);
		assert.equal(result.toolCalls, 2);
		assert.deepEqual(result.structured, { docId: "d1", relevance: 0.9, keyPoints: ["k"], evidence: ["e"] });
		assert.equal(result.agentType, "graph-surveyor");
		assert.deepEqual(result.primeState, {
			schema: "sophia.prime-runtime-state.v2",
			digest: `sha256:${"c".repeat(64)}`,
		});
		// startedAt comes from the running event; durationMs is non-negative.
		assert.equal(result.startedAt, 1200);
		assert.ok(result.durationMs >= 0);
	});

	it("maps error/timeout/killed terminal states to 'error'", async () => {
		for (const state of ["error", "timeout", "killed"] as const) {
			const bus = createSandboxEventBus(stubStore);
			const pending = awaitNodeResult(bus, `sb-${state}`, spec, 1000, () => 2000);
			bus.emit({
				category: "lifecycle",
				type: "terminal",
				sandbox_id: `sb-${state}`,
				ts: new Date(1500).toISOString(),
				state,
			} as BusEvent);
			const result = await pending;
			assert.equal(result.state, "error", `state ${state} should map to error`);
			assert.equal(result.tokens, 0); // no result payload → zeroed telemetry
		}
	});

	it("maps truncated to 'truncated'", async () => {
		const bus = createSandboxEventBus(stubStore);
		const pending = awaitNodeResult(bus, "sb-trunc", spec, 1000, () => 2000);
		bus.emit({
			category: "lifecycle",
			type: "terminal",
			sandbox_id: "sb-trunc",
			ts: new Date(1500).toISOString(),
			state: "truncated",
			result: { spawn_id: "sb-trunc", status: "truncated", output: "", turns: 8 },
		} as BusEvent);
		const result = await pending;
		assert.equal(result.state, "truncated");
		assert.equal(result.turns, 8);
	});

	it("defensively rejects a schema-bound terminal result without structured output", async () => {
		const bus = createSandboxEventBus(stubStore);
		const pending = awaitNodeResult(
			bus,
			"sb-missing-submit",
			{ ...spec, schema: { type: "object" } },
			1000,
			() => 2000,
		);
		bus.emit(terminalEvent("sb-missing-submit"));

		const result = await pending;
		assert.equal(result.state, "error");
		assert.equal(result.output, REQUIRED_STRUCTURED_OUTPUT_ERROR);
		assert.equal(result.structured, undefined);
	});
});

describe("makeNodeRunner", () => {
	it("forwards a precomputed canonical agent_id in worker_config before enqueue", async () => {
		let captured: SpawnOptions | undefined;
		const spawner = {
			enqueue(opts: SpawnOptions) {
				captured = opts;
				return {
					sandbox_id: "sb-ws7",
					state: "queued",
					template: opts.template,
					queued_at: new Date(1000).toISOString(),
				};
			},
			async awaitSpawnAttempt() {},
		};
		const bus = createSandboxEventBus(stubStore);
		const runner = makeNodeRunner({
			spawner: spawner as never,
			eventBus: bus,
			authContext: { method: "internal_service", userId: "owner-1", internalServiceSecret: "test-secret" },
			ownerUserId: "owner-1",
			mnemosyne: { graphId: "base-graph" },
			now: () => 1000,
		});

		const resultPromise = runner({
			...spec,
			...semantic,
			sessionId: "ags-ws7",
			invocationId: "activation-ws7-exact",
			depth: 2,
			awaitInitialCommand: true,
			includeTools: ["recall"],
			strictToolManifest: true,
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(captured?.worker_config?.agent_id, semantic.agentId);
		assert.equal(captured?.worker_config?.invocation_id, "activation-ws7-exact");
		assert.equal(captured?.worker_config?.provider, "openrouter");
		assert.equal(captured?.worker_config?.depth, 2);
		assert.equal(captured?.worker_config?.await_initial_command, true);
		assert.deepEqual(captured?.worker_config?.include_tools, ["recall"]);
		assert.equal(captured?.worker_config?.strict_tool_manifest, true);
		assert.equal(captured?.worker_config?.wards.require_done_tool, true);
		bus.emit(terminalEvent("sb-ws7"));

		const result = await resultPromise;
		assert.equal(result.state, "done");
	});

	it("leaves headed Prime completion under the attached Vehicle owner's control", async () => {
		let captured: SpawnOptions | undefined;
		const spawner = {
			enqueue(opts: SpawnOptions) {
				captured = opts;
				return {
					sandbox_id: "sb-headed",
					state: "queued",
					template: opts.template,
					queued_at: new Date(1000).toISOString(),
				};
			},
			async awaitSpawnAttempt() {},
		};
		const bus = createSandboxEventBus(stubStore);
		const runner = makeNodeRunner({
			spawner: spawner as never,
			eventBus: bus,
			authContext: { method: "internal_service", userId: "owner-1", internalServiceSecret: "test-secret" },
			ownerUserId: "owner-1",
			mnemosyne: { graphId: "base-graph" },
			now: () => 1000,
		});

		const resultPromise = runner({
			...spec,
			...semantic,
			sessionId: "ags-headed",
			interactionMode: "headed",
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(captured?.worker_config?.interaction_mode, "headed");
		assert.equal(captured?.worker_config?.wards.require_done_tool, false);
		bus.emit(terminalEvent("sb-headed"));
		assert.equal((await resultPromise).state, "done");
	});

	it("attenuates an emanation to read-only graph access", async () => {
		let captured: SpawnOptions | undefined;
		const spawner = {
			enqueue(opts: SpawnOptions) {
				captured = opts;
				return {
					sandbox_id: "sb-read-only",
					state: "queued",
					template: opts.template,
					queued_at: new Date(1000).toISOString(),
				};
			},
			async awaitSpawnAttempt() {},
		};
		const bus = createSandboxEventBus(stubStore);
		const runner = makeNodeRunner({
			spawner: spawner as never,
			eventBus: bus,
			authContext: { method: "internal_service", userId: "owner-1", internalServiceSecret: "test-secret" },
			ownerUserId: "owner-1",
			mnemosyne: {
				graphId: "base-graph",
				capabilities: { reads: true, writes: true, dangerous_ops: false },
			},
			now: () => 1000,
		});

		const resultPromise = runner({
			...spec,
			...semantic,
			sessionId: "ags-read-only",
			graphAccess: "read",
		});
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(captured?.mnemosyne?.capabilities, {
			reads: true,
			writes: false,
			dangerous_ops: false,
		});
		bus.emit(terminalEvent("sb-read-only"));
		assert.equal((await resultPromise).state, "done");
	});

	it("drains semantic event persistence before returning the terminal result", async () => {
		const observed: string[] = [];
		const spawner = {
			enqueue(opts: SpawnOptions) {
				return {
					sandbox_id: "sb-semantic-events",
					state: "queued",
					template: opts.template,
					queued_at: new Date(1000).toISOString(),
				};
			},
			async awaitSpawnAttempt() {},
		};
		const bus = createSandboxEventBus(stubStore);
		const runner = makeNodeRunner({
			spawner: spawner as never,
			eventBus: bus,
			authContext: { method: "internal_service", userId: "owner-1", internalServiceSecret: "test-secret" },
			ownerUserId: "owner-1",
			mnemosyne: { graphId: "g1" },
			now: () => 1000,
			onEvent: async ({ event }) => {
				await Promise.resolve();
				observed.push("category" in event ? `${event.category}.${event.type}` : event.type);
			},
		});

		const resultPromise = runner({ ...spec, ...semantic, sessionId: "ags-semantic-events" });
		await new Promise<void>((resolve) => setImmediate(resolve));
		bus.emit({
			category: "agent",
			type: "prime_event",
			sandbox_id: "sb-semantic-events",
			ts: new Date(1200).toISOString(),
			event: {
				type: "prime_event",
				name: "goal_update",
				payload: { status: "active" },
				session_id: "ags-semantic-events",
				runtime_binding_digest: semantic.runtimeBindingDigest,
				agent_ontology_binding_digest: semantic.ontologyBindingDigest,
			},
		} as BusEvent);
		bus.emit(terminalEvent("sb-semantic-events"));

		assert.equal((await resultPromise).state, "done");
		assert.deepEqual(observed, ["agent.prime_event", "lifecycle.terminal"]);
	});
});
