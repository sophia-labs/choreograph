/**
 * runAgentNode — the workflow engine's foundational primitive, built on the SAME
 * spawn machinery chat uses. It enqueues an agent sandbox with per-node model /
 * tool-surface / forced-schema, subscribes to the event bus, and resolves the
 * node's result (status + telemetry + structured output) from the terminal
 * lifecycle event.
 *
 * The runner is constructed from orchestrator deps and exposed as a `NodeRunner`
 * so drivers depend only on the function type — making them unit-testable with a
 * fake runner (no bwrap required).
 */

import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
	type ContentAuthorityAdmissionPort,
	contentAuthorityPrivateMounts,
	isIContentAuthorityNode,
} from "../agent-runtime/content-authority-runtime.js";
import { validateAgentOntologyBinding } from "../agent-runtime/ontology-binding.js";
import { type AgentRuntimeBindingV2, validateResolvedAgentRuntimeBinding } from "../agent-runtime/profile.js";
import { turnTextForModel } from "../agent-runtime/turn-context.js";
import { authMethodLabel, type HostedAuthContext } from "../auth.js";
import type { HostCapabilityGrantPolicyV1 } from "../capabilities/grant-gate.js";
import type { BusEvent, SandboxEventBus } from "../event-bus.js";
import { type CapabilityBackend, READ_ONLY_MNEMOSYNE_TOOLS } from "../mnemosyne.js";
import type { MnemosyneRequestOptions, SandboxSpawner } from "../spawner.js";
import type { PrivateSandboxMount } from "../templates.js";
import type { AgentWorkerConfig } from "../wire-protocol.js";
import type { AgentNodeResult, AgentNodeSpec, NodeRunner, NodeState } from "./types.js";

export const REQUIRED_STRUCTURED_OUTPUT_ERROR = "required structured output was not submitted";

export interface NodeRunnerDeps {
	spawner: SandboxSpawner;
	eventBus: SandboxEventBus;
	/**
	 * Optional end-user request authority. Durable supervisor work deliberately
	 * omits this and lets the spawner mint service-auth graph backends from the
	 * persisted owner + graph identity.
	 */
	authContext?: HostedAuthContext;
	ownerUserId: string;
	/** Cloud durable supervisors must mint a fresh gateway service-auth proxy. */
	requireGatewayServiceAuth?: boolean;
	/** Base Mnemosyne options (graph, gateway/api base, profile). Graph wins per node. */
	mnemosyne: MnemosyneRequestOptions;
	/** Injectable clock (defaults to Date.now) — keeps callers deterministic in tests. */
	now?: () => number;
	/**
	 * Fires synchronously right after enqueue, exposing the freshly-minted
	 * `sandbox_id` for the spec. The journal decorator (`withJournal`) uses this
	 * to record `node_queued` and to open its own per-sandbox bus subscription
	 * (the tee) — without re-implementing the enqueue path. Best-effort: errors
	 * thrown here are NOT swallowed by the runner, so keep it non-throwing.
	 */
	onEnqueue?: (info: { spec: AgentNodeSpec; sandboxId: string; queuedAt: number }) => void | Promise<void>;
	/** Exact trusted arbitration before the spawner enters a worker adapter/process. */
	preSpawnGate?: (info: { spec: AgentNodeSpec; sandboxId: string; queuedAt: number }) => void | Promise<void>;
	/** Bind durable body testimony only after the OS reports an actual spawned process. */
	onProcessSpawn?: (info: { spec: AgentNodeSpec; sandboxId: string; pid: number }) => void | Promise<void>;
	/** Persist or project sandbox events before the node result is committed. */
	onEvent?: (info: { spec: AgentNodeSpec; sandboxId: string; event: BusEvent }) => void | Promise<void>;
	/** Mint fresh host capability adapters for this node/sandbox generation. */
	bindCapabilities?: (spec: AgentNodeSpec) => Promise<ReadonlyMap<string, CapabilityBackend>>;
	/** Resolve the exact trusted host-gate policy for every bound capability. */
	resolveCapabilityGrantPolicy?: (spec: AgentNodeSpec) => HostCapabilityGrantPolicyV1;
	/** Resolve an active Embodiment and trusted candidate mount before admission. */
	resolveAgentWorkerConfig?: (spec: AgentNodeSpec, config: AgentWorkerConfig) => Promise<AgentWorkerConfig>;
	/** Rechecks a sealed I capsule before capability/resource use and again at pre-spawn. */
	contentAuthorityAdmission?: ContentAuthorityAdmissionPort;
}

export function makeNodeRunner(deps: NodeRunnerDeps): NodeRunner {
	const now = deps.now ?? (() => Date.now());

	return async (spec: AgentNodeSpec): Promise<AgentNodeResult> => {
		const queuedAt = now();
		const semantic = requireExecutableSemanticBinding(spec);
		const personalWorkspaceMount = resolvePersonalWorkspaceMount({
			ownerUserId: deps.ownerUserId,
			runtimeKind: semantic.runtime.kind,
		});
		const isIAuthoritative = isIContentAuthorityNode(spec);
		let reviewedSkillMounts: readonly PrivateSandboxMount[] = [];
		if (isIAuthoritative) {
			if (!deps.contentAuthorityAdmission) {
				throw new Error(
					"I-authoritative execution requires an injected immutable-CAS content-authority admission port",
				);
			}
			await deps.contentAuthorityAdmission.reverify(spec);
			reviewedSkillMounts = contentAuthorityPrivateMounts(spec);
		}
		// What the person has open is the model's to read, never the Session's prompt (D5): the first message carries
		// the note, `spec.prompt` (the transcript, the title, the sandbox's intent) keeps the person's words.
		const modelPrompt = turnTextForModel(spec.prompt, spec.contextRefs);
		const baseWorkerConfig: AgentWorkerConfig = {
			mode: "agent",
			intent: modelPrompt,
			system_prompt: spec.systemPrompt,
			agent_id: semantic.ontology.subject.agentId,
			session_id: semantic.sessionId,
			generation: spec.sandboxGeneration ?? 0,
			...(spec.invocationId === undefined ? {} : { invocation_id: spec.invocationId }),
			depth: spec.depth ?? 0,
			restore_state: spec.restoreState,
			await_initial_command: spec.awaitInitialCommand,
			runtime_binding: semantic.runtime,
			runtime_binding_digest: semantic.runtimeDigest,
			agent_ontology: semantic.ontology,
			agent_ontology_binding_digest: semantic.ontologyDigest,
			initial_goal: spec.initialGoal
				? {
						objective: spec.initialGoal.objective,
						...(spec.initialGoal.tokenBudget === undefined ? {} : { token_budget: spec.initialGoal.tokenBudget }),
					}
				: undefined,
			model: spec.model,
			provider: semantic.provider,
			interaction_mode: spec.interactionMode,
			messages: [{ role: "user", content: [{ type: "text", text: modelPrompt }], timestamp: queuedAt }],
			wards: {
				max_turns: semantic.runtime.constraints.maxTurns,
				max_depth: semantic.runtime.constraints.maxChildDepth,
				// Headed Prime is a persistent owner conversation. Ordinary assistant
				// output completes each turn; the Vehicle detach/close edge completes the
				// workflow. Headless nodes retain the explicit done/submit contract.
				require_done_tool: spec.interactionMode !== "headed" && spec.schema === undefined,
			},
			output_schema: spec.schema,
			tool_mode: spec.toolMode ?? "curated",
			exclude_tools: spec.excludeTools,
			include_tools: spec.includeTools,
			strict_tool_manifest: spec.strictToolManifest,
			capabilities: spec.capabilities,
			verified_execution_capsule: spec.verifiedExecutionCapsule,
			...(spec.seed ? { seed_ref: spec.seed } : {}),
		};
		const workerConfig = deps.resolveAgentWorkerConfig
			? await deps.resolveAgentWorkerConfig(spec, baseWorkerConfig)
			: baseWorkerConfig;
		const capabilityGrantPolicy = deps.resolveCapabilityGrantPolicy?.(spec);
		const capabilityBackends = await deps.bindCapabilities?.(spec);
		let record: ReturnType<SandboxSpawner["enqueue"]>;
		try {
			record = deps.spawner.enqueue({
				template: "agent",
				resources: {},
				timeout_ms: semantic.runtime.constraints.maxWallTimeMs,
				intent: spec.prompt,
				worker_config: workerConfig,
				authContext: deps.authContext,
				ownerUserId: deps.ownerUserId,
				requireGatewayServiceAuth: deps.requireGatewayServiceAuth,
				authMethod: authMethodLabel(deps.authContext),
				mnemosyne: attenuateGraphAccess(deps.mnemosyne, spec),
				capabilityBackends,
				capabilityGrantPolicy,
				preSpawnGate:
					isIAuthoritative || deps.preSpawnGate
						? async ({ sandboxId }) => {
								if (isIAuthoritative) await deps.contentAuthorityAdmission!.reverify(spec);
								await deps.preSpawnGate?.({ spec, sandboxId, queuedAt });
							}
						: undefined,
				onProcessSpawn: deps.onProcessSpawn
					? ({ sandboxId, pid }) => deps.onProcessSpawn?.({ spec, sandboxId, pid })
					: undefined,
				...(personalWorkspaceMount || reviewedSkillMounts.length > 0
					? {
							privateMounts: [
								...reviewedSkillMounts,
								...(personalWorkspaceMount ? [personalWorkspaceMount] : []),
							],
						}
					: {}),
			});
		} catch (error) {
			await Promise.allSettled([...new Set(capabilityBackends?.values() ?? [])].map((backend) => backend.close()));
			throw error;
		}

		await deps.onEnqueue?.({ spec, sandboxId: record.sandbox_id, queuedAt });

		let eventTail: Promise<void> = Promise.resolve();
		let eventFault: unknown;
		const observe = deps.onEvent
			? (event: BusEvent): void => {
					eventTail = eventTail.then(async () => {
						try {
							await deps.onEvent?.({ spec, sandboxId: record.sandbox_id, event });
						} catch (error) {
							eventFault ??= error;
						}
					});
				}
			: undefined;
		let result: AgentNodeResult | undefined;
		let resultFault: unknown;
		try {
			result = await awaitNodeResult(deps.eventBus, record.sandbox_id, spec, queuedAt, now, observe);
		} catch (error) {
			resultFault = error;
		}
		await eventTail;
		// Lifecycle terminal is emitted before capability/cgroup cleanup. Join the
		// exact launch continuation so zero-body failure settlement cannot overtake
		// the verified physical-reap barrier.
		await deps.spawner.awaitSpawnAttempt(record.sandbox_id);
		if (eventFault !== undefined) throw eventFault;
		if (resultFault !== undefined) throw resultFault;
		return result!;
	};
}

export function resolvePersonalWorkspaceMount(
	input: { ownerUserId: string; runtimeKind: AgentRuntimeBindingV2["kind"] },
	environment: NodeJS.ProcessEnv = process.env,
): PrivateSandboxMount | undefined {
	const configuredPath = environment.CHOREOGRAPH_PERSONAL_WORKSPACE_HOST_PATH?.trim();
	const configuredOwner = environment.CHOREOGRAPH_PERSONAL_WORKSPACE_OWNER_USER_ID?.trim();
	if (!configuredPath && !configuredOwner) return undefined;
	if (!configuredPath || !configuredOwner) {
		throw new Error(
			"Personal workspace access requires CHOREOGRAPH_PERSONAL_WORKSPACE_HOST_PATH and " +
				"CHOREOGRAPH_PERSONAL_WORKSPACE_OWNER_USER_ID together",
		);
	}
	if (input.runtimeKind !== "prime" || input.ownerUserId !== configuredOwner) return undefined;
	if (!isAbsolute(configuredPath)) {
		throw new Error("CHOREOGRAPH_PERSONAL_WORKSPACE_HOST_PATH must be absolute");
	}
	const hostPath = realpathSync(configuredPath);
	if (!statSync(hostPath).isDirectory()) {
		throw new Error("CHOREOGRAPH_PERSONAL_WORKSPACE_HOST_PATH must resolve to a directory");
	}
	return { hostPath, guestPath: "/workspace", mode: "rw" };
}

function requireExecutableSemanticBinding(spec: AgentNodeSpec): {
	sessionId: string;
	runtime: AgentRuntimeBindingV2;
	runtimeDigest: string;
	ontology: NonNullable<AgentNodeSpec["ontology"]>;
	ontologyDigest: string;
	provider: string;
} {
	if (!spec.sessionId?.trim()) throw new Error("Executable agent node requires a canonical sessionId");
	if (spec.depth !== undefined && (!Number.isSafeInteger(spec.depth) || spec.depth < 0)) {
		throw new Error("Executable agent node depth must be a non-negative safe integer");
	}
	if (!spec.runtime) throw new Error("Executable agent node requires a resolved runtime binding");
	validateResolvedAgentRuntimeBinding(spec.runtime);
	if (!spec.runtimeBindingDigest) throw new Error("Executable agent node requires its runtime binding digest");
	if (!spec.ontology) throw new Error("Executable agent node requires a complete Agent Ontology binding");
	validateAgentOntologyBinding(spec.ontology);
	if (!spec.ontologyBindingDigest) throw new Error("Executable agent node requires its Agent Ontology binding digest");
	if (!spec.provider?.trim()) throw new Error("Executable agent node requires a host-resolved inference provider");
	return {
		sessionId: spec.sessionId,
		runtime: spec.runtime,
		runtimeDigest: spec.runtimeBindingDigest,
		ontology: spec.ontology,
		ontologyDigest: spec.ontologyBindingDigest,
		provider: spec.provider,
	};
}

/** A node can narrow the run's graph grant, but can never widen it. */
function attenuateGraphAccess(base: MnemosyneRequestOptions, spec: AgentNodeSpec): MnemosyneRequestOptions {
	const graph = { ...base, graphId: spec.graphId };
	if (spec.graphAccess !== "read") return graph;
	return {
		...graph,
		// A read-only session never needs a write tool to start: a Viewer's cell does not serve one, and the default list
		// (`append_to_document`, `remember`) left a Viewer's chat unable to call anything (exam 1, finding 2).
		requiredTools: (base.requiredTools ?? ["search_documents", "read_document"]).filter((tool) =>
			READ_ONLY_MNEMOSYNE_TOOLS.has(tool),
		),
		capabilities: {
			reads: base.capabilities?.reads ?? true,
			writes: false,
			dangerous_ops: false,
		},
	};
}

/** Subscribe to a sandbox's lifecycle and resolve its node result. */
export function awaitNodeResult(
	eventBus: SandboxEventBus,
	sandboxId: string,
	spec: AgentNodeSpec,
	queuedAt: number,
	now: () => number,
	onEvent?: (event: BusEvent) => void,
): Promise<AgentNodeResult> {
	return new Promise<AgentNodeResult>((resolve) => {
		let startedAt = queuedAt;
		let settled = false;
		let unsubscribe: () => void = () => {};

		const finish = (event: Extract<BusEvent, { type: "terminal" }>): void => {
			if (settled) {
				return;
			}
			settled = true;
			unsubscribe();
			resolve(mapTerminal(event, spec, queuedAt, startedAt, now()));
		};
		const finishMaterialization = (event: Extract<BusEvent, { type: "materialization.result" }>): void => {
			if (settled) return;
			settled = true;
			unsubscribe();
			resolve(mapSpawnResult(event.result, "done", undefined, spec, queuedAt, startedAt, now()));
		};

		const handle = (event: BusEvent): void => {
			// Some system bus events (runtime/kernel) carry no `category` field, so
			// guard with `"category" in event` before narrowing.
			if (!("category" in event)) {
				return;
			}
			if (event.category === "system" && event.type === "snapshot") {
				// A fast sandbox may have already terminated before we subscribed —
				// replay the buffered events delivered with the snapshot.
				for (const replayed of event.recent_events) {
					handle(replayed);
				}
				return;
			}
			onEvent?.(event);
			if (event.category === "lifecycle" && event.type === "running") {
				const parsed = Date.parse(event.ts);
				if (!Number.isNaN(parsed)) {
					startedAt = parsed;
				}
			}
			if (event.category === "lifecycle" && event.type === "terminal") {
				finish(event);
			}
			if (event.category === "agent-runtime" && event.type === "materialization.result") {
				finishMaterialization(event);
			}
		};

		unsubscribe = eventBus.subscribe(handle, { sandbox_id: sandboxId });
		// If the terminal already arrived via the snapshot replay above, clean up.
		if (settled) {
			unsubscribe();
		}
	});
}

function mapTerminal(
	event: Extract<BusEvent, { type: "terminal" }>,
	spec: AgentNodeSpec,
	queuedAt: number,
	startedAt: number,
	endedAt: number,
): AgentNodeResult {
	return mapSpawnResult(event.result, event.state, event.error_detail, spec, queuedAt, startedAt, endedAt);
}

function mapSpawnResult(
	result:
		| Extract<BusEvent, { type: "terminal" }>["result"]
		| Extract<BusEvent, { type: "materialization.result" }>["result"],
	sandboxState: string,
	errorDetail: string | undefined,
	spec: AgentNodeSpec,
	queuedAt: number,
	startedAt: number,
	endedAt: number,
): AgentNodeResult {
	const rawStatus = typeof result?.status === "string" ? result.status : undefined;
	const missingRequiredStructuredOutput = spec.schema !== undefined && result?.structured_output === undefined;
	const errored =
		rawStatus === "error" ||
		sandboxState === "error" ||
		sandboxState === "timeout" ||
		sandboxState === "killed" ||
		missingRequiredStructuredOutput;
	const state: NodeState = errored
		? "error"
		: rawStatus === "truncated" || sandboxState === "truncated"
			? "truncated"
			: "done";

	return {
		nodeKey: spec.nodeKey,
		sessionId: spec.sessionId,
		invocationId: spec.invocationId,
		label: spec.label,
		phaseIndex: spec.phaseIndex,
		state,
		output: missingRequiredStructuredOutput
			? REQUIRED_STRUCTURED_OUTPUT_ERROR
			: typeof result?.output === "string"
				? result.output
				: (errorDetail ?? ""),
		structured: result?.structured_output,
		model: spec.model,
		agentId: spec.agentId,
		turns: typeof result?.turns === "number" ? result.turns : 0,
		toolCalls: typeof result?.tool_calls === "number" ? result.tool_calls : 0,
		tokens: typeof result?.tokens === "number" ? result.tokens : 0,
		queuedAt,
		startedAt,
		durationMs: Math.max(0, endedAt - startedAt),
		agentType: spec.agentType,
		primeState: result?.prime_state,
	};
}
