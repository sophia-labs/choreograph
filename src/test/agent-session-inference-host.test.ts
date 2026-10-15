import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentSessionFamilyProjectionPump } from "../agent-runtime/agent-session-family-projection-pump.js";
import { PRIME_HOST_PROTOCOL_VERSION, type PrimeWorkerRequestV1 } from "../agent-runtime/host-protocol.js";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
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

describe("Agent Session inference host", { concurrency: false }, () => {
	it("dispatches exact admitted context and ignores worker funding while BYOK is disabled", async () => {
		let observedContext: unknown;
		await withHarness(
			async ({ runtime, spawner, billing }) => {
				const session = await seedRunningRoot(runtime, {
					suffix: "provider-context",
					model: "google/gemini-2.5-flash",
				});
				const responses: Record<string, unknown>[] = [];
				await hostInference(
					spawner,
					session,
					activeFor(session),
					responseChild(responses),
					"req-provider-context",
					{ fundingSource: "user", ownerUserId: "forged-worker" },
				);

				assert.deepEqual(observedContext, {
					messages: [{ role: "user", content: "hello" }],
				});
				assert.equal(responses.some(terminalResponse), true);
				const operation = await inferenceOperationId(runtime, session.sessionId);
				const event = await waitForBillingEvent(billing, operation);
				assert.equal(event.fundingSource, "platform");
				assert.ok(event.costMicroUsd > 0);
				assert.equal((await billing.getCredit(session.ownerUserId))?.lifetimeUsageMicroUsd, event.costMicroUsd);
			},
			{
				openRouterKeyStore: {
					get: async () => {
						throw new Error("Disabled BYOK must not read user credentials");
					},
					put: async () => {},
					delete: async () => {},
				},
				llmProxy: async function* (_model, context) {
					observedContext = context;
					yield { type: "start" };
					yield {
						type: "done",
						reason: "stop",
						usage: { ...ZERO_USAGE, input: 1000, output: 500, totalTokens: 1500 },
					};
				},
			},
		);
	});

	it("resolves a user key only from the durable admitted owner, never active-process assertions", async () => {
		let readOwner: string | undefined;
		let dispatchedKey: string | undefined;
		await withHarness(
			async ({ runtime, spawner, billing }) => {
				const session = await seedRunningRoot(runtime, { suffix: "owner-key", model: "google/gemini-2.5-flash" });
				await hostInference(
					spawner,
					session,
					activeFor(session, { ownerUserId: "forged", graphId: "forged" }),
					responseChild([]),
					"owner-key-request",
				);
				assert.equal(readOwner, session.ownerUserId);
				assert.equal(dispatchedKey, "sk-or-v1-fixtureOwnerAAAAAAAA");
				const operation = await inferenceOperationId(runtime, session.sessionId);
				const event = await waitForBillingEvent(billing, operation);
				assert.equal(event.fundingSource, "user");
				assert.ok(event.providerCostMicroUsd > 0);
				assert.equal(await billing.getCredit(session.ownerUserId), undefined);
			},
			{
				openRouterUserInferenceEnabled: true,
				openRouterKeyStore: {
					get: async (owner) => {
						readOwner = owner;
						return "sk-or-v1-fixtureOwnerAAAAAAAA";
					},
					put: async () => {},
					delete: async () => {},
				},
				llmProxy: async function* (_model, _context, options) {
					dispatchedKey = options?.apiKey;
					yield {
						type: "done",
						reason: "stop",
						usage: { ...ZERO_USAGE, input: 1000, output: 500, totalTokens: 1500 },
					};
				},
			},
		);
	});

	it("keeps the provider's generation id on the billing event, and never calls Pi's own arithmetic the provider's report", async () => {
		// Defect guarded (price-gap/FINDINGS.md, 2026-10-01): `provider_reported_cost_micro_usd` held Pi's `usage.cost`,
		// which Pi computes from a static price table in its catalogue ($0.68/$3.41/$0.34 per M for Kimi K2.6), not what
		// OpenRouter charged ($0.434/$1.828/$0.073 at Baidu, where the calls were served): a phantom 2.26x "gap". And the
		// generation id that would let the real charge be looked up was dropped before settlement.
		const GEN_ID = "gen-1790893024-TZYksidy0cQRoBKpJHBH";
		await withHarness(
			async ({ runtime, spawner, billing }) => {
				const session = await seedRunningRoot(runtime, {
					suffix: "generation-id",
					model: "google/gemini-2.5-flash",
				});
				await hostInference(
					spawner,
					session,
					activeFor(session, { ownerUserId: session.ownerUserId, graphId: session.graphId }),
					responseChild([]),
					"generation-id-request",
				);
				const operation = await inferenceOperationId(runtime, session.sessionId);
				const event = await waitForBillingEvent(billing, operation);
				assert.equal(event.providerGenerationId, GEN_ID);
				assert.equal(event.providerReportedCostMicroUsd, null, "Pi's arithmetic is not the provider's report");
			},
			{
				llmProxy: async function* () {
					yield {
						type: "done",
						reason: "stop",
						responseId: GEN_ID,
						usage: {
							...ZERO_USAGE,
							input: 1000,
							output: 500,
							totalTokens: 1500,
							cost: { input: 0.00068, output: 0.001705, cacheRead: 0, cacheWrite: 0, total: 0.002385 },
						},
					} as ProxyAssistantMessageEvent;
				},
			},
		);
	});

	it("durably reserves before provider dispatch, settles before the terminal response, and projects root billing", async () => {
		await withHarness(async ({ runtime, billing, spawner }) => {
			const session = await seedRunningRoot(runtime, { suffix: "ordered", model: "mock:done" });
			const order: string[] = [];
			wrapRuntimeMutation(runtime, "reserveAgentSessionInferenceBudget", order, "reserve");
			wrapRuntimeMutation(runtime, "settleAgentSessionInferenceBudget", order, "settle");
			const active = activeFor(session, { ownerUserId: "forged-user", graphId: "forged-graph" });
			const responses: Record<string, unknown>[] = [];
			const child = responseChild(responses, (response) => {
				if (response.ok === true && terminalResponse(response)) order.push("terminal");
			});

			await hostInference(spawner, session, active, child, "req-ordered");

			assert.ok(order.indexOf("reserve") >= 0);
			assert.ok(order.indexOf("settle") > order.indexOf("reserve"));
			assert.ok(order.indexOf("terminal") > order.indexOf("settle"));
			const operationId = await inferenceOperationId(runtime, session.sessionId);
			const reservation = await runtime.readAgentSessionInferenceReservation(operationId);
			assert.equal(reservation?.state, "settled");
			const billed = await waitForBillingEvent(billing, operationId);
			assert.equal(billed.userId, session.ownerUserId, "durable Session identity wins over active process fields");
			assert.equal(billed.graphId, session.graphId);
			assert.equal(billed.childRunId, null);
			assert.equal(billed.allocationId, null);
			assert.equal(billed.providerReportedCostMicroUsd, null, "Pi's arithmetic is not the provider's report");
		});
	});

	it("projects exact durable child-run and allocation provenance", async () => {
		await withHarness(async ({ runtime, billing, spawner }) => {
			const parent = await seedRunningRoot(runtime, { suffix: "child", model: "mock:done" });
			const admitted = await runtime.admitAgentSessionChild(parent.sessionId, {
				requestId: "spawn-child",
				parentGeneration: parent.generation,
				parentActivationId: parent.activationId,
				parentSandboxId: parent.sandboxId,
				prompt: "Inspect the child billing path.",
				causationId: "cause-spawn-child",
				now: 10,
			});
			assert.equal(admitted.decision, "accepted");
			if (admitted.decision !== "accepted") return;
			const childRunClaim = await runtime.claimAgentSessionChildRun(admitted.run.child_run_id, {
				consumer: "inference-child-worker",
				leaseMs: 100,
				now: 11,
			});
			assert.equal(childRunClaim.claimed, true);
			const childSession = {
				sessionId: admitted.child.session_id,
				generation: 0,
				activationId: admitted.run.child_run_id,
				sandboxId: "sbx-inference-child-body",
				ownerUserId: admitted.child.owner_user_id,
				graphId: admitted.child.graph_id,
				model: admitted.spec.model,
				provider: admitted.spec.provider ?? "openrouter",
				runtime: admitted.spec.runtime!,
			};
			await runtime.claimAgentSessionChildMaterialization(admitted.run.child_run_id, {
				consumer: childRunClaim.run.consumer!,
				claimToken: childRunClaim.run.claim_token!,
				generation: 0,
				activationId: childSession.activationId,
				now: 12,
			});
			await runtime.bindAgentSandbox(childSession.sessionId, {
				generation: 0,
				activationId: childSession.activationId,
				sandboxId: childSession.sandboxId,
				childRunConsumer: childRunClaim.run.consumer!,
				childRunClaimToken: childRunClaim.run.claim_token!,
				now: 13,
			});

			await hostInference(
				spawner,
				childSession,
				activeFor(childSession, { ownerUserId: "forged-child-user", graphId: "forged-child-graph" }),
				responseChild([]),
				"req-child-inference",
			);

			const operationId = await inferenceOperationId(runtime, childSession.sessionId);
			const billed = await waitForBillingEvent(billing, operationId);
			assert.equal(billed.userId, admitted.child.owner_user_id);
			assert.equal(billed.graphId, admitted.child.graph_id);
			assert.equal(billed.childRunId, admitted.run.child_run_id);
			assert.equal(billed.allocationId, admitted.admission.budget_allocation_id);
		});
	});

	it("rejects immutable Session model drift before the provider is dispatched", async () => {
		await withHarness(async ({ runtime, spawner }) => {
			const session = await seedRunningRoot(runtime, { suffix: "drift", model: "openai/gpt-5-mini" });
			const active = activeFor({ ...session, model: "mock:done" });
			const responses: Record<string, unknown>[] = [];

			await hostInference(
				spawner,
				{ ...session, model: "mock:done" },
				active,
				responseChild(responses),
				"req-drift",
			);

			assert.equal(active.mockLlmState.requestCount, 0, "provider generator was never entered");
			assert.equal(
				(await runtime.listAgentSessionBudgetEntries(session.sessionId)).filter(
					(entry) => entry.kind === "inference_reserved",
				).length,
				0,
			);
			assert.equal(responses.length, 1);
			assert.equal(responses[0]?.ok, false);
		});
	});

	it("marks a dispatched provider failure indeterminate before returning the error", async () => {
		await withHarness(async ({ runtime, spawner }) => {
			const session = await seedRunningRoot(runtime, { suffix: "indeterminate", model: "mock:unsupported" });
			const order: string[] = [];
			wrapRuntimeMutation(runtime, "markAgentSessionInferenceBudgetIndeterminate", order, "indeterminate");
			const responses: Record<string, unknown>[] = [];
			const child = responseChild(responses, () => order.push("error"));

			await hostInference(spawner, session, activeFor(session), child, "req-indeterminate");

			assert.deepEqual(order, ["indeterminate", "error"]);
			const operationId = await inferenceOperationId(runtime, session.sessionId);
			assert.equal((await runtime.readAgentSessionInferenceReservation(operationId))?.state, "indeterminate");
			assert.equal(responses[0]?.ok, false);
		});
	});

	it("projects reserved then settled family revisions without coupling the terminal response to graph failure", async () => {
		const updates: string[] = [];
		let firstProjectionSeen!: () => void;
		const firstProjection = new Promise<void>((resolve) => {
			firstProjectionSeen = resolve;
		});
		await withHarness(
			async ({ runtime, spawner }) => {
				const session = await seedRunningRoot(runtime, { suffix: "family-projection", model: "mock:done" });
				const mutable = runtime as unknown as {
					settleAgentSessionInferenceBudget: WorkflowRuntimeStore["settleAgentSessionInferenceBudget"];
				};
				const settle = mutable.settleAgentSessionInferenceBudget.bind(runtime);
				mutable.settleAgentSessionInferenceBudget = async (...args) => {
					await firstProjection;
					return settle(...args);
				};
				const responses: Record<string, unknown>[] = [];
				await hostInference(
					spawner,
					session,
					activeFor(session),
					responseChild(responses),
					"req-family-projection",
				);
				await waitFor(() => updates.length >= 2, "settled family projection was not attempted");

				const revisions = updates.map(projectionBudgetRevision);
				assert.ok(revisions[0]! < revisions.at(-1)!, "family projection revisions advance monotonically");
				assert.ok(
					terminalResponse(responses.at(-1)!),
					"graph failure did not suppress the provider terminal frame",
				);
			},
			{
				projectionCall: async (name, arguments_) => {
					assert.equal(name, "sparql_update");
					updates.push(String(arguments_.update));
					if (updates.length === 1) firstProjectionSeen();
					if (updates.length > 1) throw new Error("display graph unavailable");
					return {};
				},
			},
		);
	});

	it("restarts before claim expiry and automatically delivers when the durable lease becomes available", async () => {
		await withHarness(
			async ({ runtime, billing, sandboxStore, spawner }) => {
				const session = await seedRunningRoot(runtime, { suffix: "restart-wake", model: "mock:done" });
				await hostInference(spawner, session, activeFor(session), responseChild([]), "req-restart-wake");
				const operationId = await inferenceOperationId(runtime, session.sessionId);
				const claimed = await runtime.claimAgentSessionInferenceBillingOutbox({
					consumer: "crashed-host",
					leaseMs: 80,
					now: Date.now(),
				});
				assert.equal(claimed?.operation_id, operationId);
				const restarted = new SandboxSpawner(
					sandboxStore,
					{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
					{ sandboxMode: "local-native", workflowRuntime: runtime, billing, billingOutboxLeaseMs: 25 },
				);
				try {
					const billed = await waitForBillingEvent(billing, operationId);
					assert.equal(billed.inferenceOperationId, operationId);
				} finally {
					await restarted.shutdownAll();
				}
			},
			{ automaticBilling: false },
		);
	});

	it("recovers a transient billing sink failure without another inference or restart", async () => {
		await withHarness(
			async ({ runtime, billing, spawner }) => {
				let attempts = 0;
				const mutable = billing as unknown as {
					recordUsageAndDebit: BillingStore["recordUsageAndDebit"];
				};
				const record = mutable.recordUsageAndDebit.bind(billing);
				mutable.recordUsageAndDebit = async (event) => {
					attempts += 1;
					if (attempts === 1) throw new Error("temporary sink outage");
					return record(event);
				};
				const session = await seedRunningRoot(runtime, { suffix: "sink-retry", model: "mock:done" });
				await hostInference(spawner, session, activeFor(session), responseChild([]), "req-sink-retry");
				const operationId = await inferenceOperationId(runtime, session.sessionId);

				await waitForBillingEvent(billing, operationId);
				assert.ok(attempts >= 2, "the durable lease wake retried the transient sink failure");
			},
			{ billingOutboxLeaseMs: 25 },
		);
	});

	it("waits for a late inference settlement and performs its final billing drain during shutdown", async () => {
		await withHarness(async ({ runtime, billing, spawner }) => {
			const session = await seedRunningRoot(runtime, { suffix: "shutdown-settle", model: "mock:done" });
			let settlementStarted!: () => void;
			const started = new Promise<void>((resolve) => {
				settlementStarted = resolve;
			});
			let releaseSettlement!: () => void;
			const release = new Promise<void>((resolve) => {
				releaseSettlement = resolve;
			});
			const mutable = runtime as unknown as {
				settleAgentSessionInferenceBudget: WorkflowRuntimeStore["settleAgentSessionInferenceBudget"];
			};
			const settle = mutable.settleAgentSessionInferenceBudget.bind(runtime);
			mutable.settleAgentSessionInferenceBudget = async (...args) => {
				settlementStarted();
				await release;
				return settle(...args);
			};
			const inference = hostInference(
				spawner,
				session,
				activeFor(session),
				responseChild([]),
				"req-shutdown-settle",
			);
			await started;
			let shutdownFinished = false;
			const shutdown = spawner.shutdownAll().then(() => {
				shutdownFinished = true;
			});
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			assert.equal(shutdownFinished, false, "shutdown waits for the tracked inference handler");
			releaseSettlement();
			await Promise.all([inference, shutdown]);

			const operationId = await inferenceOperationId(runtime, session.sessionId);
			assert.ok(await billing.getEvent(operationId), "late settlement was included in the final outbox drain");
		});
	});

	it("never completes a poisoned first-write-wins billing projection", async () => {
		await withHarness(
			async ({ runtime, billing, spawner }) => {
				const session = await seedRunningRoot(runtime, { suffix: "poison", model: "mock:done" });
				await hostInference(spawner, session, activeFor(session), responseChild([]), "req-poison");
				const operationId = await inferenceOperationId(runtime, session.sessionId);
				const oldClaim = await runtime.claimAgentSessionInferenceBillingOutbox({
					consumer: "payload-reader",
					leaseMs: 1,
					now: Date.now() - 60_000,
				});
				assert.equal(oldClaim?.operation_id, operationId);
				assert.equal(await billing.recordUsageAndDebit({ ...oldClaim!.payload, model: "poisoned-model" }), true);
				(spawner as unknown as { billing: BillingStore }).billing = billing;

				await assert.rejects(
					(spawner as unknown as { drainInferenceBillingOutbox(): Promise<void> }).drainInferenceBillingOutbox(),
					/Billing sink conflict/,
				);
				const reclaimed = await runtime.claimAgentSessionInferenceBillingOutbox({
					consumer: "billing-reconciler",
					leaseMs: 30_000,
					now: Date.now() + 31_000,
				});
				assert.equal(reclaimed?.operation_id, operationId, "conflicting projection remains durably undelivered");
			},
			{ automaticBilling: false },
		);
	});
});

interface RunningSession {
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

async function withHarness(
	run: (harness: {
		runtime: WorkflowRuntimeStore;
		billing: BillingStore;
		sandboxStore: SandboxStore;
		spawner: SandboxSpawner;
	}) => Promise<void>,
	options: {
		openRouterKeyStore?: OpenRouterKeyStore;
		openRouterUserInferenceEnabled?: boolean;
		automaticBilling?: boolean;
		billingOutboxLeaseMs?: number;
		projectionCall?: (name: string, arguments_: Record<string, unknown>) => Promise<Record<string, unknown>>;
		llmProxy?: (
			model: unknown,
			context: unknown,
			options?: ProxyLlmOptions,
		) => AsyncGenerator<ProxyAssistantMessageEvent>;
	} = {},
): Promise<void> {
	const directory = mkdtempSync(join(tmpdir(), "agent-inference-host-"));
	const runtime = new WorkflowRuntimeStore(join(directory, "runtime.sqlite"));
	const billing = new BillingStore(join(directory, "billing.sqlite"));
	const sandboxStore = new SandboxStore(join(directory, "sandboxes.sqlite"));
	await runtime.init();
	await billing.init();
	const familyProjectionPump = new AgentSessionFamilyProjectionPump({
		store: runtime,
		consumer: `inference-projection-${Math.random().toString(16).slice(2)}`,
		idlePollMs: 10,
		proxyFactory: async () => ({
			proxy: {
				callTool: options.projectionCall ?? (async () => ({})),
			},
			close: async () => {},
		}),
	});
	const spawner = new SandboxSpawner(
		sandboxStore,
		{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
		{
			openRouterKeyStore: options.openRouterKeyStore,
			openRouterUserInferenceEnabled: options.openRouterUserInferenceEnabled,
			sandboxMode: "local-native",
			workflowRuntime: runtime,
			...(options.billingOutboxLeaseMs === undefined ? {} : { billingOutboxLeaseMs: options.billingOutboxLeaseMs }),
			...(options.automaticBilling === false ? {} : { billing }),
			familyProjectionPump,
			...(options.llmProxy ? { llmProxy: options.llmProxy } : {}),
		},
	);
	try {
		await spawner.start();
		await run({ runtime, billing, sandboxStore, spawner });
	} finally {
		await spawner.shutdownAll();
		billing.close();
		runtime.close();
		sandboxStore.close();
		rmSync(directory, { recursive: true, force: true });
	}
}

async function seedRunningRoot(
	runtime: WorkflowRuntimeStore,
	input: { suffix: string; model: string },
): Promise<RunningSession> {
	const graphId = `g-inference-${input.suffix}`;
	const ownerUserId = `user:inference-${input.suffix}`;
	const sessionId = `ags-inference-${input.suffix}`;
	const runId = `wfr-inference-${input.suffix}`;
	const pilot = makeTestAgentSemanticBinding({ graphId, kind: "prime", registeredName: `pilot-${input.suffix}` });
	const emanation = makeTestAgentSemanticBinding({
		graphId,
		kind: "simple",
		registeredName: `pilot-${input.suffix}`,
	});
	await runtime.createWorkflowInstance({
		runId,
		workflowName: "inference-host-test",
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
		provider: "openrouter",
		graphId,
		sessionId,
		agentId: pilot.agentId,
		runtime: pilot.runtime,
		runtimeBindingDigest: digestAgentRuntimeBinding(pilot.runtime),
		ontology: pilot.ontology,
		ontologyBindingDigest: pilot.ontologyBindingDigest,
	};
	await runtime.beginAgentSession({
		sessionId,
		runId,
		workflowName: "inference-host-test",
		graphId,
		ownerUserId,
		graphOwnerPrincipal: ownerUserId,
		spec,
		nodeKey: "pilot",
		frontier: { kind: "before-node", sessionId, ts: 1 },
		now: 1,
	});
	const session = {
		sessionId,
		generation: 0,
		activationId: `activation-${input.suffix}`,
		sandboxId: `sbx-inference-${input.suffix}`,
		ownerUserId,
		graphId,
		model: input.model,
		provider: "openrouter",
		runtime: pilot.runtime,
	} as const;
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

function activeFor(session: RunningSession, forged?: { ownerUserId: string; graphId: string }) {
	return {
		record: {
			sandbox_id: session.sandboxId,
			template: "agent",
			state: "running",
			owner_user_id: forged?.ownerUserId ?? session.ownerUserId,
		},
		isAgentRun: true,
		agentRequest: {
			spawn_id: session.sandboxId,
			session_id: session.sessionId,
			generation: session.generation,
		},
		trustedInference: { provider: session.provider, model: session.model },
		runtimeBinding: session.runtime,
		graphId: forged?.graphId ?? session.graphId,
		captureIdentity: { principal: "service:choreograph" },
		mockLlmState: { requestCount: 0 },
		nextHostResponseId: 0,
	};
}

function projectionBudgetRevision(update: string): number {
	const match = /ar:budgetAccountRevision "(\d+)"\^\^xsd:long/.exec(update);
	assert.ok(match, "family projection carries the durable budget-account revision");
	return Number(match[1]);
}

async function hostInference(
	spawner: SandboxSpawner,
	session: RunningSession,
	active: ReturnType<typeof activeFor>,
	child: ChildProcess,
	requestId: string,
	untrusted: Record<string, unknown> = {},
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
				maxTokens: 64,
			},
			context: { messages: [{ role: "user", content: "hello" }] },
		},
	} satisfies Extract<PrimeWorkerRequestV1, { name: "inference.request" }>;
	Object.assign(request.payload, untrusted);
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

function responseChild(
	responses: Record<string, unknown>[],
	onWrite?: (response: Record<string, unknown>) => void,
): ChildProcess {
	return {
		stdin: {
			write(line: string) {
				const response = JSON.parse(line) as Record<string, unknown>;
				responses.push(response);
				onWrite?.(response);
				return true;
			},
		},
		kill() {
			return true;
		},
	} as unknown as ChildProcess;
}

function terminalResponse(response: Record<string, unknown>): boolean {
	const result = response.result as { kind?: unknown; event?: { type?: unknown } } | undefined;
	return result?.kind === "inference.chunk" && (result.event?.type === "done" || result.event?.type === "error");
}

function wrapRuntimeMutation(
	runtime: WorkflowRuntimeStore,
	name:
		| "reserveAgentSessionInferenceBudget"
		| "settleAgentSessionInferenceBudget"
		| "markAgentSessionInferenceBudgetIndeterminate",
	order: string[],
	marker: string,
): void {
	const mutable = runtime as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
	const original = mutable[name]!.bind(runtime);
	mutable[name] = async (...args: unknown[]) => {
		const result = await original(...args);
		order.push(marker);
		return result;
	};
}

async function inferenceOperationId(runtime: WorkflowRuntimeStore, sessionId: string): Promise<string> {
	const entry = (await runtime.listAgentSessionBudgetEntries(sessionId)).find(
		(candidate) => candidate.kind === "inference_reserved",
	);
	assert.ok(entry);
	return entry.reference_id;
}

async function waitForBillingEvent(billing: BillingStore, eventId: string) {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const event = await billing.getEvent(eventId);
		if (event) return event;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`billing event ${eventId} was not projected`);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, failure: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(failure);
}
