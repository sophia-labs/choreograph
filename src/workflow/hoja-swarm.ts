import { canonicalDigest, canonicalJson } from "../agent-subject/canonical-json.js";
import type { WorkflowRunInputs } from "./harness.js";

export const HOJA_SCENARIO_SCHEMA = "sophia.hoja.scenario.v1" as const;
export const HOJA_OPERATIONS = [
	"create",
	"type",
	"edit-block",
	"concurrent-edit",
	"rename",
	"list",
	"delete-later",
] as const;
export const HOJA_INVARIANTS = ["I1", "I2", "I3", "I4", "I5", "I6"] as const;
export const HOJA_CAPABILITIES = ["browser.chromium", "http", "mcp", "yws", "sparql", "soil"] as const;

const HOJA_TOOLS_BY_CAPABILITY: Readonly<Record<(typeof HOJA_CAPABILITIES)[number], ReadonlySet<string>>> = {
	// E1.1: act and screenshot are capability-exposed and now scenario-legal.
	// The capability fence is untouched — this widens what SCENARIOS may
	// declare, never what unbound agents can reach.
	"browser.chromium": new Set(["navigate", "read_a11y_tree", "probe", "act", "screenshot"]),
	http: new Set(["get", "head"]),
	mcp: new Set(["create_document", "write_document", "read_document", "list_documents", "delete_document"]),
	yws: new Set(["snapshot", "append_block", "concurrent_append"]),
	sparql: new Set(["query"]),
	soil: new Set(["roundtrip"]),
};

export type HojaOperation = (typeof HOJA_OPERATIONS)[number];
export type HojaInvariant = (typeof HOJA_INVARIANTS)[number];

export interface CapabilityInvocationV1 {
	readonly capability: (typeof HOJA_CAPABILITIES)[number];
	readonly tool: string;
	readonly args: Readonly<Record<string, unknown>>;
}

export interface HojaScenarioV1 {
	readonly schema: typeof HOJA_SCENARIO_SCHEMA;
	readonly id: string;
	readonly runId: string;
	readonly description?: string;
	readonly beats: readonly Array<{
		readonly id: string;
		readonly operation: HojaOperation;
		readonly mode: "sequential" | "concurrent";
		readonly actions: readonly CapabilityInvocationV1[];
		readonly capture?: boolean;
	}>;
	readonly invariants: readonly Array<
		Readonly<Record<string, unknown>> & { readonly id: HojaInvariant; readonly kind: string }
	>;
}

export interface NormalizedHojaScenario {
	readonly scenario: HojaScenarioV1;
	readonly canonicalJson: string;
	readonly digest: string;
}

/** Validate once on the host; replay bytes and digest are then immutable run inputs. */
export function normalizeHojaScenario(value: unknown): NormalizedHojaScenario {
	const scenario = parseScenario(value);
	const serialized = canonicalJson(scenario);
	return { scenario, canonicalJson: serialized, digest: canonicalDigest(scenario) };
}

export function buildHojaSwarmInputs(value: unknown, graphId: string): WorkflowRunInputs {
	assertHojaGraphId(graphId);
	const request = asRecord(value, "request");
	const body = request.workflow_args === undefined ? request : asRecord(request.workflow_args, "workflow_args");
	const normalized = normalizeHojaScenario(body.scenario);
	const args = { ...normalized, graphId };
	return {
		config: { graphId, model: "none" },
		args,
		schemaInput: { scenario: normalized.scenario, digest: normalized.digest, graphId },
	};
}

export function assertHojaGraphId(graphId: string): void {
	if (!/^obs-hoja-[A-Za-z0-9._-]+$/.test(graphId)) {
		throw Object.assign(new Error("Hoja swarm workflows are restricted to obs-hoja-* campaign graphs"), {
			status: 400,
		});
	}
}

function parseScenario(value: unknown): HojaScenarioV1 {
	const input = asRecord(value, "scenario");
	assertExactKeys(input, ["schema", "id", "runId", "description", "beats", "invariants"], "scenario");
	if (input.schema !== HOJA_SCENARIO_SCHEMA) throw invalid("scenario.schema");
	const id = opaqueId(input.id, "scenario.id");
	const runId = opaqueId(input.runId, "scenario.runId");
	const description =
		input.description === undefined ? undefined : boundedString(input.description, "description", 4000);
	if (!Array.isArray(input.beats) || input.beats.length === 0 || input.beats.length > 256)
		throw invalid("scenario.beats");
	const beats = input.beats.map((value, index) => parseBeat(value, index));
	if (new Set(beats.map((beat) => beat.id)).size !== beats.length) throw invalid("scenario beat ids must be unique");
	if (!Array.isArray(input.invariants) || input.invariants.length > 512) throw invalid("scenario.invariants");
	const invariants = input.invariants.map(parseInvariant);
	validateInvariantReferences(invariants, beats);
	return {
		schema: HOJA_SCENARIO_SCHEMA,
		id,
		runId,
		...(description === undefined ? {} : { description }),
		beats,
		invariants,
	};
}

function parseBeat(value: unknown, index: number): HojaScenarioV1["beats"][number] {
	const input = asRecord(value, `beat[${index}]`);
	assertExactKeys(input, ["id", "operation", "mode", "actions", "capture"], `beat[${index}]`);
	const operation = input.operation as HojaOperation;
	if (!HOJA_OPERATIONS.includes(operation)) throw invalid(`beat[${index}].operation`);
	if (input.mode !== "sequential" && input.mode !== "concurrent") throw invalid(`beat[${index}].mode`);
	if (!Array.isArray(input.actions) || input.actions.length === 0 || input.actions.length > 32) {
		throw invalid(`beat[${index}].actions`);
	}
	return {
		id: opaqueId(input.id, `beat[${index}].id`),
		operation,
		mode: input.mode,
		actions: input.actions.map((action, actionIndex) => parseAction(action, index, actionIndex, operation)),
		...(input.capture === undefined ? {} : { capture: input.capture === true }),
	};
}

function parseAction(value: unknown, beat: number, index: number, operation: HojaOperation): CapabilityInvocationV1 {
	const input = asRecord(value, `beat[${beat}].actions[${index}]`);
	assertExactKeys(input, ["capability", "tool", "args"], `beat[${beat}].actions[${index}]`);
	if (
		typeof input.capability !== "string" ||
		!HOJA_CAPABILITIES.includes(input.capability as CapabilityInvocationV1["capability"])
	) {
		throw invalid(`beat[${beat}].actions[${index}].capability`);
	}
	const args = asRecord(input.args, `beat[${beat}].actions[${index}].args`);
	const bytes = Buffer.byteLength(JSON.stringify(args), "utf8");
	if (bytes > 8 * 1024 * 1024) throw invalid(`beat[${beat}].actions[${index}].args is oversized`);
	const capability = input.capability as CapabilityInvocationV1["capability"];
	const tool = boundedString(input.tool, "tool", 128);
	if (!HOJA_TOOLS_BY_CAPABILITY[capability].has(tool)) {
		throw invalid(`beat[${beat}].actions[${index}] tool '${tool}' is not allowed for ${capability}`);
	}
	if (tool === "delete_document" && operation !== "delete-later") {
		throw invalid(`beat[${beat}].actions[${index}] delete_document is allowed only in delete-later`);
	}
	return {
		capability,
		tool,
		args,
	};
}

function parseInvariant(value: unknown): HojaScenarioV1["invariants"][number] {
	const input = asRecord(value, "invariant");
	if (!HOJA_INVARIANTS.includes(input.id as HojaInvariant)) throw invalid("invariant.id");
	let parsed: Record<string, unknown>;
	switch (input.id as HojaInvariant) {
		case "I1":
			assertExactKeys(input, ["id", "kind", "left", "right"], "I1 invariant");
			if (input.kind !== "markdown_equal") throw invalid("I1 invariant.kind");
			parsed = { id: "I1", kind: "markdown_equal", left: parseRef(input.left), right: parseRef(input.right) };
			break;
		case "I2": {
			assertExactKeys(input, ["id", "kind", "refs"], "I2 invariant");
			if (input.kind !== "face_agreement") throw invalid("I2 invariant.kind");
			if (!Array.isArray(input.refs) || input.refs.length < 2 || input.refs.length > 8)
				throw invalid("I2 invariant.refs");
			parsed = { id: "I2", kind: "face_agreement", refs: input.refs.map(parseRef) };
			break;
		}
		case "I3":
			assertExactKeys(input, ["id", "kind", "ref"], "I3 invariant");
			if (input.kind !== "converged") throw invalid("I3 invariant.kind");
			parsed = { id: "I3", kind: "converged", ref: parseRef(input.ref) };
			break;
		case "I4":
			assertExactKeys(input, ["id", "kind", "left", "right"], "I4 invariant");
			if (input.kind !== "block_identity") throw invalid("I4 invariant.kind");
			parsed = { id: "I4", kind: "block_identity", left: parseRef(input.left), right: parseRef(input.right) };
			break;
		case "I5":
			assertExactKeys(input, ["id", "kind", "ref", "maxMs"], "I5 invariant");
			if (input.kind !== "projection_latency") throw invalid("I5 invariant.kind");
			if (!Number.isInteger(input.maxMs) || (input.maxMs as number) < 1 || (input.maxMs as number) > 120_000)
				throw invalid("I5 invariant.maxMs");
			parsed = { id: "I5", kind: "projection_latency", ref: parseRef(input.ref), maxMs: input.maxMs };
			break;
		case "I6":
			// E1.2: the first invariant kind that can assert on a browser
			// result — a beat's a11y tree (or any browser payload) must
			// contain the given text.
			assertExactKeys(input, ["id", "kind", "ref", "text"], "I6 invariant");
			if (input.kind !== "a11y_contains") throw invalid("I6 invariant.kind");
			parsed = {
				id: "I6",
				kind: "a11y_contains",
				ref: parseRef(input.ref),
				text: boundedString(input.text, "I6 invariant.text", 4000),
			};
			break;
	}
	if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > 64 * 1024) throw invalid("invariant is oversized");
	return parsed as HojaScenarioV1["invariants"][number];
}

interface InvariantRef {
	readonly beat: string;
	readonly action?: number;
	readonly path?: string;
}

function parseRef(value: unknown): InvariantRef {
	const input = asRecord(value, "invariant ref");
	assertExactKeys(input, ["beat", "action", "path"], "invariant ref");
	const beat = boundedString(input.beat, "invariant ref.beat", 128);
	const action = input.action;
	if (action !== undefined && (!Number.isInteger(action) || (action as number) < 0))
		throw invalid("invariant ref.action");
	const path = input.path === undefined ? undefined : boundedString(input.path, "invariant ref.path", 1024);
	return {
		beat,
		...(action === undefined ? {} : { action: action as number }),
		...(path === undefined ? {} : { path }),
	};
}

function validateInvariantReferences(invariants: HojaScenarioV1["invariants"], beats: HojaScenarioV1["beats"]): void {
	const byId = new Map(beats.map((beat) => [beat.id, beat]));
	for (const invariant of invariants) {
		const refs = [
			invariant.left,
			invariant.right,
			invariant.ref,
			...(Array.isArray(invariant.refs) ? invariant.refs : []),
		].filter((value): value is InvariantRef => typeof value === "object" && value !== null);
		for (const ref of refs) {
			const beat = byId.get(ref.beat);
			if (!beat) throw invalid(`invariant ${invariant.id} references unknown beat '${ref.beat}'`);
			const action = ref.action ?? 0;
			if (action >= beat.actions.length)
				throw invalid(`invariant ${invariant.id} references missing action ${action} in beat '${ref.beat}'`);
		}
	}
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalid(`${name} must be an object`);
	return value as Record<string, unknown>;
}

function assertExactKeys(input: Record<string, unknown>, allowed: readonly string[], name: string): void {
	const extras = Object.keys(input).filter((key) => !allowed.includes(key));
	if (extras.length > 0) throw invalid(`${name} has unknown fields: ${extras.sort().join(", ")}`);
}

function opaqueId(value: unknown, name: string): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw invalid(name);
	return value;
}

function boundedString(value: unknown, name: string, max: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) throw invalid(name);
	return value;
}

function invalid(message: string): Error {
	return Object.assign(new Error(`invalid Hoja scenario: ${message}`), { status: 400 });
}
