import type { BusEvent, SandboxEventBus } from "../event-bus.js";
import type { CapabilityBackend } from "../mnemosyne.js";
import type { SandboxSpawner } from "../spawner.js";
import type { CompiledWorkflow } from "./harness.js";
import { type InvocationEffectV1, InvocationFault, resolveExecutionBinding } from "./invocation.js";
import { PROGRAM_CONTROL_CAPABILITY } from "./program-control.js";

export interface ProgramExecutionPhase {
	readonly index: number;
	readonly title: string;
}

export interface ProgramExecutionLog {
	readonly msg: string;
}

export interface ProgramExecutionResult {
	readonly sandboxId: string;
	readonly output: unknown;
	readonly phases: readonly ProgramExecutionPhase[];
	readonly logs: readonly ProgramExecutionLog[];
	readonly effects: readonly InvocationEffectV1[];
}

export interface ProgramCapabilityObservation extends InvocationEffectV1 {
	readonly sandboxId: string;
	readonly callId: string;
	readonly durationMs: number;
}

export interface ProgramExecutorDeps {
	readonly spawner: SandboxSpawner;
	readonly eventBus: SandboxEventBus;
	readonly ownerUserId: string;
	readonly timeoutMs?: number;
	/** Host-owned backends keyed by the names declared in meta.execution.capabilities. */
	readonly capabilities?: ReadonlyMap<string, CapabilityBackend>;
	/** Host-only semantic-beat control; never part of the workflow's world toolbelt. */
	readonly control?: CapabilityBackend;
	/** Streams content-free effect testimony to the durable receipt owner. */
	readonly onEffect?: (effect: InvocationEffectV1) => void;
	/** Streams the complete content-free host call coordinate to Observatory. */
	readonly onCapabilityCall?: (observation: ProgramCapabilityObservation) => void;
}

/**
 * Execute a program-controlled workflow in Choreograph's ordinary runtime
 * sandbox. The source receives no Node globals, credentials, graph proxy, or
 * model runner. Host capabilities can be added later through the witnessed
 * `invoke()` protocol; until then both `agent()` and `invoke()` fail closed.
 */
export async function executeProgramWorkflow(
	deps: ProgramExecutorDeps,
	compiled: CompiledWorkflow,
	args: unknown,
): Promise<ProgramExecutionResult> {
	const execution = resolveExecutionBinding(compiled.meta);
	if (execution.controller !== "program" || execution.isolation !== "sandbox") {
		throw new InvocationFault(
			"executor_mismatch",
			`workflow '${compiled.meta.name}' is not a sandboxed program workflow`,
			409,
		);
	}
	if ((execution.runtime?.kind ?? "node") !== "node") {
		throw new InvocationFault(
			"runtime_unavailable",
			`program runtime '${execution.runtime?.kind}' is not yet supported by the workflow executor`,
			409,
		);
	}

	const capabilityBackends = bindProgramCapabilities(execution.capabilities, deps.capabilities, deps.control);
	const code = programSource(compiled.bodySource, args, execution.capabilities);
	const sandbox = await deps.spawner.spawn({
		template: "bare",
		ownerUserId: deps.ownerUserId,
		intent: `workflow:${compiled.meta.name}`,
		timeout_ms: deps.timeoutMs,
		worker_config: { mode: "runtime", runtime: "node" },
		capabilityBackends,
	});

	const effects: InvocationEffectV1[] = [];
	const observedCalls = new Set<string>();
	let unsubscribeEffects = () => {};
	try {
		// `spawn()` returns when the process is running, which is intentionally
		// earlier than the worker's runtime channel subscription. Wait for the
		// protocol-ready event so the first input cannot be lost during startup.
		await waitForRuntimeReady(deps.eventBus, sandbox.sandbox_id, deps.timeoutMs ?? 60_000);
		unsubscribeEffects = deps.eventBus.subscribe(
			(event) => {
				if (!("category" in event) || event.category !== "capability" || event.type !== "call") return;
				if (observedCalls.has(event.call_id)) return;
				observedCalls.add(event.call_id);
				// Semantic control mutates only this run's libSQL control row. It is not
				// a world effect and must not appear in invocation effect receipts.
				if (event.capability === PROGRAM_CONTROL_CAPABILITY) return;
				const effect: InvocationEffectV1 = {
					capability: event.capability,
					operation: event.operation,
					outcome: event.outcome,
				};
				effects.push(effect);
				deps.onEffect?.(effect);
				deps.onCapabilityCall?.({
					...effect,
					sandboxId: event.sandbox_id,
					callId: event.call_id,
					durationMs: event.duration_ms,
				});
			},
			{ sandbox_id: sandbox.sandbox_id },
		);
		const pending = waitForRuntimeResult(deps.eventBus, sandbox.sandbox_id, deps.timeoutMs ?? 60_000);
		const { inputId } = deps.spawner.sendRuntimeInput(sandbox.sandbox_id, code);
		const event = await pending(inputId);
		if (!event.ok) throw runtimeFault(event.error);
		if (typeof event.result_json !== "string") {
			throw new InvocationFault("invalid_output", "program workflow did not return a JSON-serializable value", 500);
		}
		return { ...decodeProgramResult(sandbox.sandbox_id, event.result_json), effects };
	} finally {
		unsubscribeEffects();
		try {
			deps.spawner.closeRuntime(sandbox.sandbox_id);
		} catch {
			// The worker may already be terminal (timeout/runtime error).
		}
	}
}

type RuntimeResultEvent = Extract<BusEvent, { type: "runtime_result" }>;

function waitForRuntimeReady(eventBus: SandboxEventBus, sandboxId: string, timeoutMs: number): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		let unsubscribe = () => {};
		const timer = setTimeout(
			() =>
				finish(() => reject(new InvocationFault("execution_timeout", "program runtime did not become ready", 504))),
			Math.max(1, timeoutMs),
		);
		const finish = (done: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			unsubscribe();
			done();
		};
		const observe = (event: BusEvent) => {
			if (event.type === "runtime_ready") {
				finish(resolve);
				return;
			}
			if (event.type === "snapshot") {
				const ready = event.recent_events.some((recent) => recent.type === "runtime_ready");
				if (ready) finish(resolve);
				return;
			}
			if ("category" in event && event.category === "lifecycle" && event.type === "terminal") {
				finish(() =>
					reject(
						new InvocationFault(
							"sandbox_terminated",
							`program sandbox terminated in state '${event.state}' before runtime ready`,
							500,
						),
					),
				);
			}
		};
		unsubscribe = eventBus.subscribe(observe, { sandbox_id: sandboxId });
		// A replay snapshot may settle synchronously inside subscribe().
		if (settled) unsubscribe();
	});
}

function waitForRuntimeResult(
	eventBus: SandboxEventBus,
	sandboxId: string,
	timeoutMs: number,
): (inputId: string) => Promise<RuntimeResultEvent> {
	let targetInputId: string | undefined;
	let settle: ((event: RuntimeResultEvent) => void) | undefined;
	let reject: ((error: Error) => void) | undefined;
	let buffered: RuntimeResultEvent | undefined;
	let terminalError: Error | undefined;

	const unsubscribe = eventBus.subscribe(
		(event) => {
			if (event.type === "runtime_result") {
				if (!targetInputId || event.input_id === targetInputId) {
					if (settle) settle(event);
					else buffered = event;
				}
				return;
			}
			if ("category" in event && event.category === "lifecycle" && event.type === "terminal") {
				const error = new InvocationFault(
					"sandbox_terminated",
					`program sandbox terminated in state '${event.state}' before producing a result`,
					500,
					{ state: event.state, error: event.error_detail },
				);
				if (reject) reject(error);
				else terminalError = error;
			}
		},
		{ sandbox_id: sandboxId },
	);

	return (inputId) => {
		targetInputId = inputId;
		return new Promise<RuntimeResultEvent>((resolve, rejectPromise) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (fn: () => void) => {
				if (timer) clearTimeout(timer);
				unsubscribe();
				fn();
			};
			settle = (event) => finish(() => resolve(event));
			reject = (error) => finish(() => rejectPromise(error));
			timer = setTimeout(
				() => reject?.(new InvocationFault("execution_timeout", "program workflow timed out", 504)),
				Math.max(1, timeoutMs),
			);
			if (terminalError) reject(terminalError);
			else if (buffered?.input_id === inputId) settle(buffered);
		});
	};
}

function programSource(bodySource: string, args: unknown, capabilities: readonly string[]): string {
	let argsJson: string;
	try {
		argsJson = JSON.stringify(args ?? {});
	} catch {
		throw new InvocationFault("invalid_input", "workflow input must be JSON-serializable", 400);
	}
	if (argsJson === undefined) {
		throw new InvocationFault("invalid_input", "workflow input must be JSON-serializable", 400);
	}
	return `
(async () => {
	const __phases = []
	const __logs = []
	const __capabilities = new Set(${JSON.stringify(capabilities)})
	const args = JSON.parse(${JSON.stringify(argsJson)})
	const phase = (title) => {
		const declared = { index: __phases.length + 1, title: String(title) }
		__phases.push(declared)
		return declared
	}
	const log = (msg) => { __logs.push({ msg: String(msg) }) }
	const contract = (_name, schema) => schema
	const parallel = (thunks) => Promise.all(thunks.map((thunk) => thunk()))
	const pipeline = (items, ...stages) => Promise.all(items.map(async (item) => {
		let value = item
		for (const stage of stages) value = await stage(value)
		return value
	}))
	const agent = async () => {
		throw new Error("CHOREOGRAPH_EXECUTOR_VIOLATION: agent() is unavailable to a program-controlled workflow")
	}
	const __control = (tool, input) => globalThis.__choreographInvoke(${JSON.stringify(PROGRAM_CONTROL_CAPABILITY)}, tool, input)
	const __pauseIfRequested = (decision) => {
		if (decision && decision.action === "pause") {
			throw new Error("CHOREOGRAPH_WORKFLOW_PAUSED: semantic beat boundary")
		}
	}
	const journey = async (items, handler, options = {}) => {
		if (!Array.isArray(items) || typeof handler !== "function") {
			throw new Error("CHOREOGRAPH_JOURNEY_INVALID: journey requires an item array and handler")
		}
		const modelUse = options.modelUse || "none"
		if (!new Set(["none", "inference", "agentic"]).has(modelUse)) {
			throw new Error("CHOREOGRAPH_JOURNEY_INVALID: modelUse must be none, inference, or agentic")
		}
		let pending = items.map((item) => {
			if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.id !== "string") {
				throw new Error("CHOREOGRAPH_JOURNEY_INVALID: every journey item needs a string id")
			}
			return JSON.parse(JSON.stringify(item))
		})
		if (new Set(pending.map((item) => item.id)).size !== pending.length) {
			throw new Error("CHOREOGRAPH_JOURNEY_INVALID: journey item ids must be unique")
		}
		const results = []
		while (pending.length > 0) {
			const plan = await __control("plan", { pendingBeatIds: pending.map((item) => item.id) })
			__pauseIfRequested(plan)
			if (Array.isArray(plan.order)) {
				const byId = new Map(pending.map((item) => [item.id, item]))
				const reordered = plan.order.map((id) => byId.get(id))
				if (reordered.some((item) => !item) || reordered.length !== pending.length) {
					throw new Error("CHOREOGRAPH_JOURNEY_INVALID: host returned a non-permutation order")
				}
				pending = reordered
			}
			const original = pending[0]
			const decision = await __control("enter", {
				beatId: original.id,
				pendingBeatIds: pending.map((item) => item.id),
				parameters: original,
				modelUse,
			})
			__pauseIfRequested(decision)
			pending.shift()
			if (decision.action === "skip") {
				await __control("complete", { beatId: original.id })
				continue
			}
			const value = await handler(decision.parameters || original, decision)
			await __control("complete", { beatId: original.id })
			results.push(value)
		}
		return results
	}
	const invoke = async (capabilityOrEnvelope, operation, input = {}) => {
		let capability = capabilityOrEnvelope
		let tool = operation
		let args = input
		if (capabilityOrEnvelope && typeof capabilityOrEnvelope === "object" && !Array.isArray(capabilityOrEnvelope)) {
			const keys = Object.keys(capabilityOrEnvelope).sort()
			if (JSON.stringify(keys) !== JSON.stringify(["args", "capability", "tool"])) {
				throw new Error("CHOREOGRAPH_CAPABILITY_INVALID: invocation envelope must contain exactly capability, tool, args")
			}
			capability = capabilityOrEnvelope.capability
			tool = capabilityOrEnvelope.tool
			args = capabilityOrEnvelope.args
		}
		const capabilityName = String(capability)
		if (!__capabilities.has(capabilityName)) {
			throw new Error("CHOREOGRAPH_CAPABILITY_UNDECLARED: " + capabilityName)
		}
		if (!args || typeof args !== "object" || Array.isArray(args)) {
			throw new Error("CHOREOGRAPH_CAPABILITY_INVALID: args must be an object")
		}
		return globalThis.__choreographInvoke(capabilityName, String(tool), args)
	}
	const __output = await (async () => {
${bodySource}
	})()
	return { output: __output, phases: __phases, logs: __logs }
})()
`;
}

function runtimeFault(error: string | undefined): InvocationFault {
	const message = error ?? "program workflow failed";
	if (message.includes("CHOREOGRAPH_EXECUTOR_VIOLATION")) {
		return new InvocationFault("executor_violation", "program-controlled workflow attempted to call agent()", 409);
	}
	if (message.includes("CHOREOGRAPH_WORKFLOW_PAUSED")) {
		return new InvocationFault("workflow_paused", "workflow paused at a semantic beat boundary", 409);
	}
	if (message.includes("CHOREOGRAPH_CAPABILITY_UNAVAILABLE")) {
		return new InvocationFault(
			"capability_unavailable",
			"program-controlled workflow attempted an unbound child invocation",
			409,
			{ capability: "choreograph.invoke" },
		);
	}
	if (message.includes("CHOREOGRAPH_CAPABILITY_UNDECLARED")) {
		return new InvocationFault("capability_denied", "program attempted an undeclared capability call", 403);
	}
	if (message.includes("CHOREOGRAPH_CAPABILITY_CALL_FAILED")) {
		return new InvocationFault(
			"capability_error",
			message.replace(/^.*CHOREOGRAPH_CAPABILITY_CALL_FAILED:\s*/, ""),
			502,
		);
	}
	if (message.includes("CHOREOGRAPH_CAPABILITY_INVALID")) {
		return new InvocationFault(
			"invalid_capability_call",
			message.replace(/^.*CHOREOGRAPH_CAPABILITY_INVALID:\s*/, ""),
			400,
		);
	}
	if (message.includes("CHOREOGRAPH_JOURNEY_INVALID")) {
		return new InvocationFault("invalid_journey", message.replace(/^.*CHOREOGRAPH_JOURNEY_INVALID:\s*/, ""), 400);
	}
	return new InvocationFault("execution_error", message, 500);
}

function decodeProgramResult(sandboxId: string, json: string): ProgramExecutionResult {
	let decoded: unknown;
	try {
		decoded = JSON.parse(json);
	} catch {
		throw new InvocationFault("invalid_output", "program workflow returned invalid JSON", 500);
	}
	if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new InvocationFault("invalid_output", "program workflow result wrapper is invalid", 500);
	}
	const record = decoded as Record<string, unknown>;
	return {
		sandboxId,
		output: record.output,
		phases: Array.isArray(record.phases) ? (record.phases as ProgramExecutionPhase[]) : [],
		logs: Array.isArray(record.logs) ? (record.logs as ProgramExecutionLog[]) : [],
		effects: [],
	};
}

function bindProgramCapabilities(
	declared: readonly string[],
	provided: ReadonlyMap<string, CapabilityBackend> | undefined,
	control: CapabilityBackend | undefined,
): ReadonlyMap<string, CapabilityBackend> | undefined {
	const bound = new Map<string, CapabilityBackend>();
	for (const name of declared) {
		const backend = provided?.get(name);
		if (!backend) {
			throw new InvocationFault(
				"capability_unavailable",
				`workflow requires unavailable capability '${name}'`,
				409,
				{ capability: name },
			);
		}
		bound.set(name, backend);
	}
	if (control) {
		if (control.capabilityName !== PROGRAM_CONTROL_CAPABILITY) {
			throw new Error(`program control backend must be named '${PROGRAM_CONTROL_CAPABILITY}'`);
		}
		bound.set(PROGRAM_CONTROL_CAPABILITY, control);
	}
	return bound.size > 0 ? bound : undefined;
}
