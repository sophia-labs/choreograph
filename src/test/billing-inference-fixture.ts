/**
 * Real-substrate harness for the per-call door (Door B) and the holds — Sobremesa credits.
 *
 * NO MOCKS. A real `SandboxSpawner` (local-native), a real `WorkflowRuntimeStore`, a real
 * `BillingStore` on a real file and the real `CreditAdmission` are driven through the
 * spawner's own `handleLlmRequest`, exactly as the Prime worker's `inference.request`
 * reaches it. Two things stand in for the outside world, both existing house seams:
 * the OpenRouter egress (`llmProxy`, an async generator) and the worker's stdin (a
 * recorder of what the host writes back). This is `agent-session-inference-host.test.ts`'s
 * harness with the credit gate wired in.
 */

import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSessionFamilyProjectionPump } from "../agent-runtime/agent-session-family-projection-pump.js";
import { PRIME_HOST_PROTOCOL_VERSION, type PrimeWorkerRequestV1 } from "../agent-runtime/host-protocol.js";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { type BillingGateMode, CreditAdmission } from "../billing-gate.js";
import type { RateCardV1 } from "../billing-rate-card.js";
import { BillingStore } from "../billing-store.js";
import type { ProxyLlmOptions } from "../openrouter.js";
import type { OpenRouterKeyStore } from "../openrouter-credentials.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import type { ProxyAssistantMessageEvent } from "../wire-protocol.js";
import { ZERO_USAGE } from "../wire-protocol.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

export interface RunningSession {
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

export interface InferenceHarness {
	readonly runtime: WorkflowRuntimeStore;
	readonly billing: BillingStore;
	readonly sandboxStore: SandboxStore;
	readonly spawner: SandboxSpawner;
	/** The gate the spawner was built with; undefined when the harness ran without one. */
	readonly gate: CreditAdmission | undefined;
	readonly dir: string;
	readonly logLines: string[];
	/**
	 * A second spawner over the SAME stores with a fresh gate: what the host looks like after a restart
	 * (holds are in memory and are gone). Not started; shut down with the harness.
	 */
	spawnerWithGate(gate: CreditAdmission | undefined): Promise<SandboxSpawner>;
}

export interface InferenceHarnessOptions {
	/** Gate mode; `"none"` builds the spawner without a credit gate at all. */
	readonly gate?: BillingGateMode | "none";
	/** false = the spawner has no billing sink, so no debit is ever delivered (holds must then persist). */
	readonly automaticBilling?: boolean;
	readonly openRouterKeyStore?: OpenRouterKeyStore;
	readonly openRouterUserInferenceEnabled?: boolean;
	readonly llmProxy?: (
		model: unknown,
		context: unknown,
		options?: ProxyLlmOptions,
	) => AsyncGenerator<ProxyAssistantMessageEvent>;
}

export async function withInferenceHarness(
	run: (harness: InferenceHarness) => Promise<void>,
	options: InferenceHarnessOptions = {},
): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "credit-inference-host-"));
	const runtime = new WorkflowRuntimeStore(join(dir, "runtime.sqlite"));
	const billing = new BillingStore(join(dir, "billing.sqlite"));
	const sandboxStore = new SandboxStore(join(dir, "sandboxes.sqlite"));
	await runtime.init();
	await billing.init();
	const logLines: string[] = [];
	const gateMode = options.gate ?? "enforce";
	const gate =
		gateMode === "none"
			? undefined
			: new CreditAdmission({ billing, mode: gateMode, log: (line) => logLines.push(line) });
	const familyProjectionPump = new AgentSessionFamilyProjectionPump({
		store: runtime,
		consumer: `credit-projection-${Math.random().toString(16).slice(2)}`,
		idlePollMs: 10,
		proxyFactory: async () => ({
			proxy: { callTool: async () => ({}) },
			close: async () => {},
		}),
	});
	const build = (creditGate: CreditAdmission | undefined) =>
		new SandboxSpawner(
			sandboxStore,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{
				openRouterKeyStore: options.openRouterKeyStore,
				openRouterUserInferenceEnabled: options.openRouterUserInferenceEnabled,
				sandboxMode: "local-native",
				workflowRuntime: runtime,
				...(options.automaticBilling === false ? {} : { billing }),
				familyProjectionPump,
				...(creditGate ? { creditGate } : {}),
				...(options.llmProxy ? { llmProxy: options.llmProxy } : {}),
			},
		);
	const spawner = build(gate);
	const extraSpawners: SandboxSpawner[] = [];
	try {
		await spawner.start();
		await run({
			runtime,
			billing,
			sandboxStore,
			spawner,
			gate,
			dir,
			logLines,
			spawnerWithGate: async (creditGate) => {
				// Deliberately NOT started: start() would run recovery over the running session this test
				// seeded. handleLlmRequest needs only the stores, which are shared.
				const extra = build(creditGate);
				extraSpawners.push(extra);
				return extra;
			},
		});
	} finally {
		for (const extra of extraSpawners) await extra.shutdownAll();
		await spawner.shutdownAll();
		billing.close();
		runtime.close();
		sandboxStore.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * A durable Prime session with a running, bound materialization (generation 0). With `pricing` the Session is
 * pinned to that rate card, as a chat admitted from the live catalogue is; without it, a legacy Session priced
 * by the static table.
 */
export async function seedRunningRoot(
	runtime: WorkflowRuntimeStore,
	input: { suffix: string; model: string; provider?: string; pricing?: RateCardV1 },
): Promise<RunningSession> {
	const graphId = `g-credit-call-${input.suffix}`;
	const ownerUserId = `user:credit-call-${input.suffix}`;
	const sessionId = `ags-credit-call-${input.suffix}`;
	const runId = `wfr-credit-call-${input.suffix}`;
	const provider = input.provider ?? "openrouter";
	const pilot = makeTestAgentSemanticBinding({ graphId, kind: "prime", registeredName: `pilot-${input.suffix}` });
	const emanation = makeTestAgentSemanticBinding({
		graphId,
		kind: "simple",
		registeredName: `pilot-${input.suffix}`,
	});
	await runtime.createWorkflowInstance({
		runId,
		workflowName: "credit-call-test",
		graphId,
		ownerUserId,
		inputs: {
			hostContext: {
				schema: "sophia.domain-agent-host-context.v1",
				runtimes: { pilot: pilot.runtime, emanation: emanation.runtime },
				ontologies: { pilot: pilot.ontology, emanation: emanation.ontology },
				emanation: {
					enabled: true,
					provider: "openrouter",
					model: "mock:done",
					maxEmanations: 1,
					maxTurns: emanation.runtime.constraints.maxTurns,
				},
				emanationToolInclude: [],
				systemPrompt: "Test.",
				toolbelt: { tools: [] },
			},
		},
		startedAt: 1,
	});
	const spec: AgentNodeSpec = {
		label: "pilot",
		phaseIndex: 0,
		prompt: "Test inference.",
		model: input.model,
		provider,
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
		workflowName: "credit-call-test",
		graphId,
		ownerUserId,
		graphOwnerPrincipal: ownerUserId,
		spec,
		nodeKey: "pilot",
		frontier: { kind: "before-node", sessionId, ts: 1 },
		now: 1,
	});
	const session: RunningSession = {
		sessionId,
		generation: 0,
		activationId: `activation-${input.suffix}`,
		sandboxId: `sbx-credit-call-${input.suffix}`,
		ownerUserId,
		graphId,
		model: input.model,
		provider,
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

/** The host's in-memory record of the running body; `agentRequest` carries what settlement needs. */
export function activeFor(session: RunningSession) {
	return {
		record: {
			sandbox_id: session.sandboxId,
			template: "agent",
			state: "running",
			owner_user_id: session.ownerUserId,
		},
		isAgentRun: true,
		agentRequest: {
			spawn_id: session.sandboxId,
			session_id: session.sessionId,
			generation: session.generation,
			invocation_id: session.activationId,
			runtime_binding: session.runtime,
		},
		trustedInference: { provider: session.provider, model: session.model },
		runtimeBinding: session.runtime,
		graphId: session.graphId,
		captureIdentity: { principal: "service:choreograph" },
		mockLlmState: { requestCount: 0 },
		nextHostResponseId: 0,
	};
}

/** What the worker's stdin received from the host, decoded. */
export interface WorkerResponse {
	readonly ok?: boolean;
	readonly requestId?: string;
	readonly result?: { kind?: string; event?: { type?: string; errorMessage?: string; reason?: string } };
	readonly error?: {
		code: string;
		class: string;
		message: string;
		retryable: boolean;
		details?: { reason?: string; usage?: unknown };
	};
}

export function responseChild(responses: WorkerResponse[]): ChildProcess {
	return {
		stdin: {
			write(line: string) {
				responses.push(JSON.parse(line) as WorkerResponse);
				return true;
			},
		},
		kill() {
			return true;
		},
	} as unknown as ChildProcess;
}

/** A user message of `chars` characters: the host's input estimate is one token per canonical byte. */
export function contextOf(chars: number): { messages: Array<{ role: string; content: string }> } {
	return { messages: [{ role: "user", content: "a".repeat(chars) }] };
}

/** Send one `inference.request` exactly as the Prime worker does. */
export async function hostInference(
	spawner: SandboxSpawner,
	session: RunningSession,
	active: ReturnType<typeof activeFor>,
	child: ChildProcess,
	requestId: string,
	options: { maxTokens?: number; context?: unknown } = {},
): Promise<void> {
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
			model: {
				id: session.model,
				provider: session.provider,
				api: "openai-completions",
				maxTokens: options.maxTokens ?? 32_000,
			},
			context: options.context ?? contextOf(15_000),
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
}

/** A provider stream that answers with a small, real-shaped completion. */
export function completion(input: number, output: number) {
	return async function* (): AsyncGenerator<ProxyAssistantMessageEvent> {
		yield { type: "start" };
		yield {
			type: "done",
			reason: "stop",
			usage: { ...ZERO_USAGE, input, output, totalTokens: input + output },
		};
	};
}

export async function inferenceOperationIds(runtime: WorkflowRuntimeStore, sessionId: string): Promise<string[]> {
	return (await runtime.listAgentSessionBudgetEntries(sessionId))
		.filter((entry) => entry.kind === "inference_reserved")
		.map((entry) => entry.reference_id);
}

export async function waitForBillingEvent(billing: BillingStore, eventId: string) {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		const event = await billing.getEvent(eventId);
		if (event) return event;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`billing event ${eventId} was not projected`);
}

export async function waitFor(predicate: () => boolean | Promise<boolean>, failure: string): Promise<void> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(failure);
}
