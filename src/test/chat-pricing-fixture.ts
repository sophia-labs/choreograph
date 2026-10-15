/**
 * The host's inference path with real stores, for the pricing suites: a real runtime store and billing store on
 * temporary files, a real spawner, and the spawner's own `llmProxy` seam standing in for the provider's network
 * (the one thing a test may not call). A pinned or a legacy Session is seeded through the store's own API, a
 * worker's `inference.request` is handled by the spawner's own handler, and the billing event that comes out of the
 * durable outbox is read back from the billing store. Nothing is mocked. Not a test file (it is outside the
 * `*.test.ts` glob); the same harness as `agent-session-inference-host.test.ts`, with the pin added.
 */

import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSessionFamilyProjectionPump } from "../agent-runtime/agent-session-family-projection-pump.js";
import { PRIME_HOST_PROTOCOL_VERSION, type PrimeWorkerRequestV1 } from "../agent-runtime/host-protocol.js";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import type { RateCardV1 } from "../billing-rate-card.js";
import { BillingStore } from "../billing-store.js";
import type { ChatModelHealth } from "../chat-model-health.js";
import type { CaptureEmitter } from "../observatory-capture.js";
import type { ProxyLlmOptions } from "../openrouter.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import type { ProxyAssistantMessageEvent } from "../wire-protocol.js";
import { ZERO_USAGE } from "../wire-protocol.js";
import type { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";
import { InspectableRuntime } from "./chat-runtime-fixture.js";

export interface PricedSession {
	readonly sessionId: string;
	readonly generation: number;
	readonly activationId: string;
	readonly sandboxId: string;
	readonly ownerUserId: string;
	readonly graphId: string;
	readonly model: string;
	readonly provider: string;
	readonly runtime: ReturnType<typeof makeTestAgentSemanticBinding>["runtime"];
}

export type LlmProxy = (
	model: unknown,
	context: unknown,
	options?: ProxyLlmOptions,
) => AsyncGenerator<ProxyAssistantMessageEvent>;

export interface PricingHarness {
	readonly runtime: InspectableRuntime;
	readonly billing: BillingStore;
	readonly spawner: SandboxSpawner;
}

export async function withPricingHarness(
	run: (harness: PricingHarness) => Promise<void>,
	options: {
		readonly llmProxy?: LlmProxy;
		readonly capture?: CaptureEmitter;
		readonly chatModelHealth?: Pick<ChatModelHealth, "record">;
		/** Extra spawner options. */
		readonly spawnerOptions?: Record<string, unknown>;
	} = {},
): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "chat-pricing-host-"));
	const runtime = new InspectableRuntime(join(directory, "runtime.sqlite"));
	const billing = new BillingStore(join(directory, "billing.sqlite"));
	const sandboxStore = new SandboxStore(join(directory, "sandboxes.sqlite"));
	await runtime.init();
	await billing.init();
	const familyProjectionPump = new AgentSessionFamilyProjectionPump({
		store: runtime,
		consumer: `pricing-projection-${Math.random().toString(16).slice(2)}`,
		idlePollMs: 10,
		proxyFactory: async () => ({ proxy: { callTool: async () => ({}) }, close: async () => {} }),
	});
	const spawner = new SandboxSpawner(
		sandboxStore,
		{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
		{
			sandboxMode: "local-native",
			workflowRuntime: runtime,
			billing,
			familyProjectionPump,
			...(options.llmProxy ? { llmProxy: options.llmProxy } : {}),
			...(options.capture ? { capture: options.capture } : {}),
			...(options.chatModelHealth ? { chatModelHealth: options.chatModelHealth } : {}),
			...(options.spawnerOptions ?? {}),
		},
	);
	try {
		await spawner.start();
		await run({ runtime, billing, spawner });
	} finally {
		await spawner.shutdownAll();
		billing.close();
		runtime.close();
		sandboxStore.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

/** A running root Session (materialized, sandbox bound), pinned to `pricing` when a card is given. */
export async function seedPricedSession(
	runtime: WorkflowRuntimeStore,
	input: { readonly suffix: string; readonly model: string; readonly pricing?: RateCardV1 },
): Promise<PricedSession> {
	const graphId = `g-pricing-${input.suffix}`;
	const ownerUserId = `user:pricing-${input.suffix}`;
	const sessionId = `ags-pricing-${input.suffix}`;
	const runId = `wfr-pricing-${input.suffix}`;
	const pilot = makeTestAgentSemanticBinding({ graphId, kind: "prime", registeredName: `pilot-${input.suffix}` });
	await runtime.createWorkflowInstance({
		runId,
		workflowName: "pricing-host-test",
		graphId,
		ownerUserId,
		inputs: { hostContext: { schema: "sophia.pricing-host-test.v1" } },
		startedAt: 1,
	});
	const spec: AgentNodeSpec = {
		label: "pilot",
		phaseIndex: 0,
		prompt: "Test pricing.",
		model: input.model,
		provider: "openrouter",
		graphId,
		sessionId,
		agentId: pilot.agentId,
		runtime: pilot.runtime,
		runtimeBindingDigest: digestAgentRuntimeBinding(pilot.runtime),
		ontology: pilot.ontology,
		ontologyBindingDigest: pilot.ontologyBindingDigest,
		...(input.pricing ? { pricing: input.pricing } : {}),
	};
	await runtime.beginAgentSession({
		sessionId,
		runId,
		workflowName: "pricing-host-test",
		graphId,
		ownerUserId,
		graphOwnerPrincipal: ownerUserId,
		spec,
		nodeKey: "pilot",
		frontier: { kind: "before-node", sessionId, ts: 1 },
		now: 1,
	});
	const session: PricedSession = {
		sessionId,
		generation: 0,
		activationId: `activation-${input.suffix}`,
		sandboxId: `sbx-pricing-${input.suffix}`,
		ownerUserId,
		graphId,
		model: input.model,
		provider: "openrouter",
		runtime: pilot.runtime,
	};
	await runtime.claimAgentMaterialization(sessionId, {
		generation: session.generation,
		activationId: session.activationId,
		now: 2,
	});
	await runtime.bindAgentSandbox(sessionId, {
		generation: session.generation,
		activationId: session.activationId,
		sandboxId: session.sandboxId,
		now: 3,
	});
	return session;
}

export interface Usage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead?: number;
	readonly cacheWrite?: number;
}

/**
 * A provider stream that answers with `usage` and stops. `during` runs between the start of the stream and its
 * terminal event, that is between the host's reservation and its settlement.
 */
export function proxyAnswering(usage: Usage, during?: () => Promise<void>): LlmProxy {
	return async function* () {
		yield { type: "start" };
		if (during) await during();
		const cacheRead = usage.cacheRead ?? 0;
		const cacheWrite = usage.cacheWrite ?? 0;
		yield {
			type: "done",
			reason: "stop",
			usage: {
				...ZERO_USAGE,
				input: usage.input,
				output: usage.output,
				cacheRead,
				cacheWrite,
				totalTokens: usage.input + usage.output + cacheRead + cacheWrite,
			},
		};
	};
}

/** Hand the spawner one worker `inference.request` for `session`, as the sandbox's Prime worker would. */
export async function runInference(
	spawner: SandboxSpawner,
	session: PricedSession,
	requestId: string,
	maxTokens = 64,
	context: unknown = { messages: [{ role: "user", content: "hello" }] },
	/** Fields the worker asserts on the model beyond the Session's id and provider (default: the openai-completions API). */
	assertedModel: Record<string, unknown> = { api: "openai-completions" },
): Promise<Record<string, unknown>[]> {
	const responses: Record<string, unknown>[] = [];
	const child = {
		stdin: {
			write(line: string) {
				responses.push(JSON.parse(line) as Record<string, unknown>);
				return true;
			},
		},
		kill() {
			return true;
		},
	} as unknown as ChildProcess;
	const active = {
		record: {
			sandbox_id: session.sandboxId,
			template: "agent",
			state: "running",
			owner_user_id: session.ownerUserId,
		},
		isAgentRun: true,
		agentRequest: { spawn_id: session.sandboxId, session_id: session.sessionId, generation: session.generation },
		trustedInference: { provider: session.provider, model: session.model },
		runtimeBinding: session.runtime,
		graphId: session.graphId,
		captureIdentity: { principal: "service:choreograph" },
		mockLlmState: { requestCount: 0 },
		nextHostResponseId: 0,
	};
	const request = {
		protocol: PRIME_HOST_PROTOCOL_VERSION,
		messageId: `worker.request:${session.sandboxId}:${session.generation}:${requestId}`,
		sessionId: session.sessionId,
		sandboxId: session.sandboxId,
		generation: session.generation,
		correlationId: requestId,
		direction: "worker_to_host",
		kind: "request",
		workerSequence: 0,
		name: "inference.request",
		payload: {
			requestId,
			model: { id: session.model, provider: session.provider, maxTokens, ...assertedModel },
			context,
		},
	} satisfies Extract<PrimeWorkerRequestV1, { name: "inference.request" }>;
	await (
		spawner as unknown as {
			handleLlmRequest(
				sandboxId: string,
				request: Extract<PrimeWorkerRequestV1, { name: "inference.request" }>,
				child: ChildProcess,
				active: unknown,
			): Promise<void>;
		}
	).handleLlmRequest(session.sandboxId, request, child, active);
	return responses;
}

export function isTerminalResponse(response: Record<string, unknown>): boolean {
	const result = response.result as { kind?: unknown; event?: { type?: unknown } } | undefined;
	return result?.kind === "inference.chunk" && (result.event?.type === "done" || result.event?.type === "error");
}

export async function inferenceOperationId(runtime: WorkflowRuntimeStore, sessionId: string): Promise<string> {
	const entry = (await runtime.listAgentSessionBudgetEntries(sessionId)).find(
		(candidate) => candidate.kind === "inference_reserved",
	);
	if (!entry) throw new Error(`no inference was reserved for ${sessionId}`);
	return entry.reference_id;
}

export async function waitForBillingEvent(billing: BillingStore, eventId: string) {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		const event = await billing.getEvent(eventId);
		if (event) return event;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`billing event ${eventId} was not projected: a reader priced it differently from the settlement`);
}
