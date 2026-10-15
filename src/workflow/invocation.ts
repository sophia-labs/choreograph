import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

export const EXECUTION_BINDING_SCHEMA = "choreograph.execution-binding.v1" as const;
export const INVOCATION_ENVELOPE_SCHEMA = "choreograph.invocation-envelope.v1" as const;
export const INVOCATION_RECEIPT_SCHEMA = "choreograph.invocation-receipt.v1" as const;

export type ExecutionController = "program" | "agent" | "composite";
export type ExecutionModelUse = "none" | "inference" | "agentic";
export type ExecutionIsolation = "sandbox" | "host-adapter";
export type ExecutionEffects = "pure" | "capability-bound";
export type ExecutionReproducibility = "pure" | "recorded-external" | "nondeterministic";
export type ExecutionMinimumRole = "viewer" | "editor";

/**
 * The canonical, orthogonal execution posture for one executable workflow.
 *
 * This deliberately does not collapse "agent-less" into "deterministic" or
 * "free": transcription and speech synthesis are program-controlled while
 * still model-backed, externally effectful, and billable. The old
 * `executor: gated | dumb` field remains a compatibility face only.
 */
export interface ExecutionBindingV1 {
	readonly schema: typeof EXECUTION_BINDING_SCHEMA;
	readonly controller: ExecutionController;
	readonly modelUse: ExecutionModelUse;
	readonly isolation: ExecutionIsolation;
	readonly effects: ExecutionEffects;
	readonly reproducibility: ExecutionReproducibility;
	readonly runtime?: {
		readonly kind: "node" | "python";
		readonly bundleId?: string;
	};
	/** Named host-mediated capabilities; credentials never enter the sandbox. */
	readonly capabilities: readonly string[];
	readonly authority: {
		readonly minimumRole: ExecutionMinimumRole;
		readonly dangerousOps: boolean;
	};
	/** Whether the implementation is allowed to issue witnessed child invocations. */
	readonly mayInvokeChildren: boolean;
}

/** Author-facing form: every omitted facet receives a conservative default. */
export type ExecutionBindingInput = Omit<
	ExecutionBindingV1,
	"schema" | "capabilities" | "authority" | "mayInvokeChildren"
> & {
	readonly schema?: typeof EXECUTION_BINDING_SCHEMA;
	readonly capabilities?: readonly string[];
	readonly authority?: Partial<ExecutionBindingV1["authority"]>;
	readonly mayInvokeChildren?: boolean;
};

export interface InvocationTargetV1 {
	readonly workflowName: string;
	readonly workflowUri?: string;
	readonly definitionDigest: string;
}

export interface InvocationEnvelopeV1 {
	readonly schema: typeof INVOCATION_ENVELOPE_SCHEMA;
	readonly invocationId: string;
	readonly target: InvocationTargetV1;
	readonly input: unknown;
	readonly actorRef: string;
	readonly graph?: {
		readonly ownerPrincipal?: string;
		readonly graphId: string;
	};
	readonly cause?: {
		readonly kind: "http" | "tool" | "trigger" | "schedule" | "replay" | "invocation";
		readonly ref?: string;
		readonly parentInvocationId?: string;
	};
	readonly idempotencyKey?: string;
	readonly deadlineMs?: number;
	readonly budget?: {
		readonly maxDurationMs?: number;
		readonly maxChildInvocations?: number;
		readonly maxTokens?: number;
	};
}

export interface InvocationEffectV1 {
	readonly capability: string;
	readonly operation: string;
	/** `pending` means the host durably accepted work that has not landed yet. */
	readonly outcome: "ok" | "pending" | "error" | "denied";
}

export interface InvocationReceiptV1 {
	readonly schema: typeof INVOCATION_RECEIPT_SCHEMA;
	readonly invocationId: string;
	readonly target: InvocationTargetV1;
	readonly execution: ExecutionBindingV1;
	readonly status: "completed" | "failed" | "stopped" | "paused";
	readonly startedAt: number;
	readonly endedAt: number;
	readonly durationMs: number;
	readonly output?: unknown;
	readonly error?: InvocationErrorEnvelope;
	readonly childInvocationIds: readonly string[];
	readonly effects: readonly InvocationEffectV1[];
	readonly usage: {
		readonly agentCount: number;
		readonly totalTokens: number;
	};
}

/**
 * The deliberately small child-invocation surface exposed to workflow code.
 * Resolution, authority, budgets, and receipt persistence stay host-side; a
 * workflow may name a target and supply JSON, but cannot smuggle credentials or
 * construct a sandbox directly.
 */
export interface ChildInvocationRequestV1 {
	readonly workflowName: string;
	readonly workflowUri?: string;
	readonly definitionDigest?: string;
	readonly input: unknown;
	readonly idempotencyKey?: string;
	readonly deadlineMs?: number;
}

export interface ChildInvocationResultV1 {
	readonly invocationId: string;
	readonly status: InvocationReceiptV1["status"];
	readonly output?: unknown;
	readonly receipt?: InvocationReceiptV1;
}

/** A host-mediated nested invocation runner. */
export type ChildInvocationRunner = (request: ChildInvocationRequestV1) => Promise<ChildInvocationResultV1>;

export interface InvocationErrorEnvelope {
	readonly code: string;
	readonly message: string;
	readonly details?: unknown;
}

export class InvocationFault extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "InvocationFault";
	}

	toEnvelope(): InvocationErrorEnvelope {
		return {
			code: this.code,
			message: this.message,
			...(this.details === undefined ? {} : { details: this.details }),
		};
	}
}

interface WorkflowExecutionMeta {
	readonly name: string;
	readonly executor?: "gated" | "dumb";
	readonly execution?: ExecutionBindingInput;
}

/** Resolve the canonical binding while keeping the old executor field honest. */
export function resolveExecutionBinding(meta: WorkflowExecutionMeta): ExecutionBindingV1 {
	const canonical = meta.execution
		? normalizeExecutionBinding(meta.name, meta.execution)
		: fromLegacyExecutor(meta.executor);
	if (meta.executor && legacyExecutorFor(canonical) !== meta.executor) {
		throw new InvocationFault(
			"execution_binding_invalid",
			`workflow '${meta.name}' declares contradictory executor and execution bindings`,
			409,
			{ executor: meta.executor, controller: canonical.controller },
		);
	}
	return canonical;
}

export function legacyExecutorFor(binding: ExecutionBindingV1): "gated" | "dumb" {
	return binding.controller === "program" ? "dumb" : "gated";
}

export function executionUsesAgent(binding: ExecutionBindingV1): boolean {
	return binding.controller === "agent" || binding.controller === "composite";
}

function fromLegacyExecutor(executor: "gated" | "dumb" | undefined): ExecutionBindingV1 {
	return executor === "dumb"
		? normalizeExecutionBinding("legacy-dumb-workflow", {
				controller: "program",
				modelUse: "none",
				isolation: "sandbox",
				effects: "pure",
				reproducibility: "pure",
				runtime: { kind: "node" },
			})
		: normalizeExecutionBinding("legacy-gated-workflow", {
				controller: "composite",
				modelUse: "agentic",
				isolation: "sandbox",
				effects: "capability-bound",
				reproducibility: "recorded-external",
				mayInvokeChildren: true,
			});
}

function normalizeExecutionBinding(workflowName: string, input: ExecutionBindingInput): ExecutionBindingV1 {
	if (input.schema !== undefined && input.schema !== EXECUTION_BINDING_SCHEMA) {
		throw invalidBinding(workflowName, `unsupported execution binding schema '${String(input.schema)}'`);
	}
	if (!(["program", "agent", "composite"] as const).includes(input.controller)) {
		throw invalidBinding(workflowName, `unsupported controller '${String(input.controller)}'`);
	}
	if (!(["none", "inference", "agentic"] as const).includes(input.modelUse)) {
		throw invalidBinding(workflowName, `unsupported modelUse '${String(input.modelUse)}'`);
	}
	if (!(["sandbox", "host-adapter"] as const).includes(input.isolation)) {
		throw invalidBinding(workflowName, `unsupported isolation '${String(input.isolation)}'`);
	}
	if (input.controller === "program" && input.modelUse === "agentic") {
		throw invalidBinding(workflowName, "a program controller cannot declare agentic model use");
	}
	if (input.controller === "agent" && input.modelUse !== "agentic") {
		throw invalidBinding(workflowName, "an agent controller must declare agentic model use");
	}
	if (input.controller !== "program" && input.isolation === "host-adapter") {
		throw invalidBinding(workflowName, "agent and composite controllers must be sandbox-isolated");
	}
	if (input.runtime && !(["node", "python"] as const).includes(input.runtime.kind)) {
		throw invalidBinding(workflowName, `unsupported runtime '${String(input.runtime.kind)}'`);
	}
	if (!(["pure", "capability-bound"] as const).includes(input.effects)) {
		throw invalidBinding(workflowName, `unsupported effects '${String(input.effects)}'`);
	}
	if (!(["pure", "recorded-external", "nondeterministic"] as const).includes(input.reproducibility)) {
		throw invalidBinding(workflowName, `unsupported reproducibility '${String(input.reproducibility)}'`);
	}

	const capabilities = [...new Set((input.capabilities ?? []).map((item) => item.trim()).filter(Boolean))].sort();
	if (capabilities.length > 0 && input.effects !== "capability-bound") {
		throw invalidBinding(workflowName, "declared capabilities require effects='capability-bound'");
	}
	if (input.effects === "pure" && input.reproducibility !== "pure") {
		throw invalidBinding(workflowName, "pure execution effects require reproducibility='pure'");
	}
	const minimumRole = input.authority?.minimumRole ?? "editor";
	if (minimumRole !== "viewer" && minimumRole !== "editor") {
		throw invalidBinding(workflowName, `unsupported minimumRole '${String(minimumRole)}'`);
	}

	return {
		schema: EXECUTION_BINDING_SCHEMA,
		controller: input.controller,
		modelUse: input.modelUse,
		isolation: input.isolation,
		effects: input.effects,
		reproducibility: input.reproducibility,
		...(input.runtime
			? {
					runtime: {
						kind: input.runtime.kind,
						...(input.runtime.bundleId ? { bundleId: input.runtime.bundleId } : {}),
					},
				}
			: input.controller === "program" && input.isolation === "sandbox"
				? { runtime: { kind: "node" as const } }
				: {}),
		capabilities,
		authority: {
			minimumRole,
			dangerousOps: input.authority?.dangerousOps ?? false,
		},
		mayInvokeChildren: input.mayInvokeChildren ?? input.controller !== "program",
	};
}

function invalidBinding(workflowName: string, message: string): InvocationFault {
	return new InvocationFault("execution_binding_invalid", `workflow '${workflowName}': ${message}`, 409);
}

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
const validatorCache = new WeakMap<object, ValidateFunction>();

/** Validate a value against an author-declared JSON Schema without echoing content. */
export function assertJsonSchema(
	value: unknown,
	schema: Record<string, unknown> | undefined,
	role: "input" | "output",
): void {
	if (!schema) return;
	let validate = validatorCache.get(schema);
	if (!validate) {
		try {
			validate = ajv.compile(schema);
			validatorCache.set(schema, validate);
		} catch (error) {
			throw new InvocationFault(
				"invalid_schema",
				`workflow ${role} schema is invalid: ${error instanceof Error ? error.message : String(error)}`,
				409,
			);
		}
	}
	if (validate(value)) return;
	const issues = (validate.errors ?? []).map(projectSchemaError);
	throw new InvocationFault(
		role === "input" ? "invalid_input" : "invalid_output",
		`workflow ${role} does not satisfy its declared JSON Schema`,
		role === "input" ? 400 : 500,
		{ issues },
	);
}

function projectSchemaError(error: ErrorObject): Record<string, unknown> {
	return {
		instancePath: error.instancePath,
		schemaPath: error.schemaPath,
		keyword: error.keyword,
		message: error.message ?? "schema violation",
	};
}

export function invocationErrorEnvelope(error: unknown): { error: InvocationErrorEnvelope } {
	if (error instanceof InvocationFault) return { error: error.toEnvelope() };
	return {
		error: {
			code: "execution_error",
			message: error instanceof Error ? error.message : String(error),
		},
	};
}
