/**
 * Data-only graph projection for a durable Agent Session family.
 *
 * The runtime store is authoritative. This serializer exposes only the sealed
 * Shrubbery `agent.session-family` Face's allowlisted F1/F2/F3/F4/F5 coordinates in
 * the exact user-RDF graph. It intentionally contains no UX/layout triples,
 * prompt content, model coordinates, binding/request digests, owner identity,
 * child run identifiers, or sandbox/body identifiers.
 */
import { mintAgentSessionUri } from "../agent-subject/agent-ontology.js";
import type {
	AgentSessionChildBudgetSliceV1,
	AgentSessionFamilyProjectionAdmission,
	AgentSessionFamilyProjectionChild,
	AgentSessionFamilyProjectionSnapshot,
} from "../workflow/runtime-store.js";
import { str, userRdfGraphIri, xsdBool, xsdDateTime, xsdLong } from "../workflow/vocab.js";
import { isModeIri } from "./agent-mode.js";

export const AGENT_RUNTIME_NS = "http://sophia.ai/agent-runtime#";

const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const AGENT_NS = "http://mnemosyne.dev/agent#";
const PROV_NS = "http://www.w3.org/ns/prov#";
const XSD_NS = "http://www.w3.org/2001/XMLSchema#";
const GRAPH_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const RELATION_ID = /^asr_[0-9a-f]{64}$/;
const SESSION_STATES = new Set(["open", "closing", "closed", "faulted"]);
const CHILD_RUN_STATES = new Set(["queued", "claimed", "cancelling", "completed", "failed", "cancelled"]);
const ALLOCATION_STATES = new Set(["reserved", "accounting_hold", "settled", "released"]);
const MATERIALIZATION_STATES = new Set([
	"claimed",
	"running",
	"quiescing",
	"quiescent",
	"passivated",
	"completed",
	"faulted",
	"cancelled",
]);
const KERNEL_STATES = new Set(["running", "released", "shutdown", "faulted", "cancelled"]);
const MATERIALIZATION_FAULT_KINDS = new Set([
	"worker_spawn",
	"worker_exit",
	"worker_timeout",
	"worker_oom",
	"worker_protocol",
	"kernel_fault",
	"quiescence_fault",
	"checkpoint_fault",
	"replay_divergence",
	"host_invariant",
]);
const SESSION_PROJECTION_PREDICATES = [
	"ar:sessionState",
	"ar:materializationGeneration",
	"ar:materializationState",
	"ar:workerState",
	"ar:kernelState",
	"ar:materializationFaultKind",
	"ar:materializationRecoverable",
	"agt:ranInMode",
] as const;
const ROOT_AGGREGATE_PREDICATES = [
	"ar:directAcceptedChildren",
	"ar:maxChildren",
	"ar:occupiedChildren",
	"ar:maxConcurrentChildren",
	"ar:budgetCostSpentUsdMicros",
	"ar:budgetCostReservedUsdMicros",
	"ar:budgetCostRemainingUsdMicros",
	"ar:budgetCostMaxUsdMicros",
	"ar:budgetAccountExhausted",
	"ar:budgetAccountRevision",
] as const;

export interface AgentSessionFamilyProjectionRetirement {
	readonly graphId: string;
	readonly rootSessionId: string;
	readonly rootAgentId: string;
	readonly projectionRevision: number;
}

export interface AgentSessionFamilyGraphProxy {
	callTool(name: string, arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export interface AgentSessionFamilyProjectionStore {
	readAgentSessionFamilyProjection(sessionId: string): Promise<AgentSessionFamilyProjectionSnapshot | null>;
}

/** Stable projection-owned relation subject. Session subjects use canonical `agt:` identity minting. */
export function agentSessionFamilyRelationIri(relationId: string): string {
	if (!RELATION_ID.test(relationId))
		throw new Error(`invalid Agent Session relation id: ${JSON.stringify(relationId)}`);
	return `urn:sophia:agent-session-relation:${relationId}`;
}

/** Pure, deterministic replacement update matching Shrubbery's committed Face query. */
export function buildAgentSessionFamilyProjection(snapshot: AgentSessionFamilyProjectionSnapshot): string {
	const children = validateAndSortSnapshot(snapshot);
	const rootIri = sessionIri(snapshot.root.sessionId, snapshot.root.agentId);
	const childSessionIris = children.map((child) => sessionIri(child.child.sessionId, child.child.agentId));
	const sessionIris = [rootIri, ...childSessionIris];
	const relationIris = children.map((child) => agentSessionFamilyRelationIri(child.relationId));
	const userGraph = userRdfGraphIri(snapshot.root.graphId);
	const sessionBlocks = [
		sessionBlock(
			rootIri,
			snapshot.root.sessionId,
			snapshot.root.sessionState,
			[...materializationPredicates(snapshot.root), ...ranInModePredicates(snapshot.root.modeIri)],
			snapshot.projectionRevision,
			rootAggregatePredicates(snapshot),
		),
		...children.map((child) =>
			sessionBlock(
				sessionIri(child.child.sessionId, child.child.agentId),
				child.child.sessionId,
				child.child.sessionState,
				[...materializationPredicates(child), ...ranInModePredicates(child.child.modeIri)],
			),
		),
	].join("\n");
	const relationBlocks = children.map((child) => relationBlock(snapshot, child)).join("\n");
	const deleteRelations =
		relationIris.length === 0
			? ""
			: `\n  OPTIONAL {\n    VALUES ?managedRelation { ${relationIris.map(iri).join(" ")} }\n    GRAPH <${userGraph}> { ?managedRelation ?oldRelationPredicate ?oldRelationObject . }\n  }`;

	return `PREFIX rdf: <${RDF_NS}>
PREFIX agt: <${AGENT_NS}>
PREFIX ar: <${AGENT_RUNTIME_NS}>
PREFIX prov: <${PROV_NS}>
PREFIX xsd: <${XSD_NS}>
DELETE {
  GRAPH <${userGraph}> {
    <${rootIri}> ar:projectionRevision ?oldProjectionRevision .
    <${rootIri}> ?managedRootPredicate ?oldRootValue .
	?managedSession ?managedSessionPredicate ?oldSessionValue .
    ?managedRelation ?oldRelationPredicate ?oldRelationObject .
  }
}
INSERT {
  GRAPH <${userGraph}> {
${indent(sessionBlocks, 4)}${relationBlocks ? `\n${indent(relationBlocks, 4)}` : ""}
  }
}
WHERE {
  FILTER NOT EXISTS {
    GRAPH <${userGraph}> { <${rootIri}> ar:projectionRevision ?blockingProjectionRevision . }
    FILTER (?blockingProjectionRevision >= ${xsdLong(snapshot.projectionRevision)})
  }
  OPTIONAL {
    GRAPH <${userGraph}> { <${rootIri}> ar:projectionRevision ?oldProjectionRevision . }
  }
  OPTIONAL {
    VALUES ?managedRootPredicate { ${ROOT_AGGREGATE_PREDICATES.join(" ")} }
    GRAPH <${userGraph}> { <${rootIri}> ?managedRootPredicate ?oldRootValue . }
  }
  OPTIONAL {
	VALUES ?managedSession { ${sessionIris.map(iri).join(" ")} }
	VALUES ?managedSessionPredicate { ${SESSION_PROJECTION_PREDICATES.join(" ")} }
	GRAPH <${userGraph}> { ?managedSession ?managedSessionPredicate ?oldSessionValue . }
  }${deleteRelations}
}`;
}

/**
 * Monotone old-root tombstone. It removes only the coordinates that make a
 * Session a family aggregate root and retains the Session, body, and immutable
 * relation testimony. A delayed project at revision M cannot cross a retire at
 * revision R when R >= M.
 */
export function buildAgentSessionFamilyProjectionRetirement(
	retirement: AgentSessionFamilyProjectionRetirement,
): string {
	validateProjectionCoordinates(retirement.graphId, retirement.projectionRevision);
	const rootIri = sessionIri(retirement.rootSessionId, retirement.rootAgentId);
	const userGraph = userRdfGraphIri(retirement.graphId);
	return `PREFIX ar: <${AGENT_RUNTIME_NS}>
PREFIX xsd: <${XSD_NS}>
DELETE {
  GRAPH <${userGraph}> {
    <${rootIri}> ar:projectionRevision ?oldProjectionRevision .
    <${rootIri}> ?managedRootPredicate ?oldRootValue .
  }
}
INSERT {
  GRAPH <${userGraph}> {
    <${rootIri}> ar:projectionRevision ${xsdLong(retirement.projectionRevision)} .
  }
}
WHERE {
  FILTER NOT EXISTS {
    GRAPH <${userGraph}> { <${rootIri}> ar:projectionRevision ?blockingProjectionRevision . }
    FILTER (?blockingProjectionRevision >= ${xsdLong(retirement.projectionRevision)})
  }
  OPTIONAL {
    GRAPH <${userGraph}> { <${rootIri}> ar:projectionRevision ?oldProjectionRevision . }
  }
  OPTIONAL {
    VALUES ?managedRootPredicate { ${ROOT_AGGREGATE_PREDICATES.join(" ")} }
    GRAPH <${userGraph}> { <${rootIri}> ?managedRootPredicate ?oldRootValue . }
  }
}`;
}

/** Write one family replacement to its exact graph authority. */
export async function projectAgentSessionFamily(
	proxy: AgentSessionFamilyGraphProxy,
	snapshot: AgentSessionFamilyProjectionSnapshot,
): Promise<void> {
	await proxy.callTool("sparql_update", {
		graphId: snapshot.root.graphId,
		update: buildAgentSessionFamilyProjection(snapshot),
	});
}

/** Convenience seam for the non-fatal host transition hook. */
export async function projectAgentSessionFamilyFromStore(
	proxy: AgentSessionFamilyGraphProxy,
	store: AgentSessionFamilyProjectionStore,
	sessionId: string,
): Promise<void> {
	const snapshot = await store.readAgentSessionFamilyProjection(sessionId);
	if (!snapshot) throw new Error(`Agent Session family member not found: ${sessionId}`);
	await projectAgentSessionFamily(proxy, snapshot);
}

function relationBlock(
	snapshot: AgentSessionFamilyProjectionSnapshot,
	child: AgentSessionFamilyProjectionChild,
): string {
	const relationIri = agentSessionFamilyRelationIri(child.relationId);
	const parent =
		child.parentSessionId === snapshot.root.sessionId
			? snapshot.root
			: childrenById(snapshot).get(child.parentSessionId)?.child;
	if (!parent) throw new Error(`Agent Session relation ${child.relationId} has no projected parent`);
	const predicates = [
		`ar:parentSession ${iri(sessionIri(parent.sessionId, parent.agentId))}`,
		`ar:childSession ${iri(sessionIri(child.child.sessionId, child.child.agentId))}`,
		`ar:childName ${str(child.childName)}`,
		`ar:depth ${xsdLong(child.depth)}`,
		`ar:registrationStatus ${str("registered")}`,
		...(child.admission ? admissionPredicates(child.admission, child.childRunState!) : []),
		`prov:generatedAtTime ${xsdDateTime(child.registeredAt)}`,
	];
	return `${iri(relationIri)} a ar:ChildSessionRelation ;\n${predicates
		.map((predicate, index) => `  ${predicate}${index === predicates.length - 1 ? " ." : " ;"}`)
		.join("\n")}`;
}

function admissionPredicates(
	admission: AgentSessionFamilyProjectionAdmission,
	childRunState: NonNullable<AgentSessionFamilyProjectionChild["childRunState"]>,
): string[] {
	const { budget } = admission;
	return [
		`ar:admissionStatus ${str("admitted")}`,
		`ar:runtimeKind ${str(admission.runtimeKind)}`,
		`ar:childRunState ${str(childRunState)}`,
		`ar:allocationState ${str(admission.allocationState)}`,
		...(admission.allocationHoldKind === null ? [] : [`ar:allocationHoldKind ${str(admission.allocationHoldKind)}`]),
		...(admission.settledActualCostUsdMicros === null
			? []
			: [`ar:settledActualCostUsdMicros ${xsdLong(admission.settledActualCostUsdMicros)}`]),
		`ar:allocatedTurns ${xsdLong(budget.maxTurns)}`,
		`ar:allocatedWallTimeMs ${xsdLong(budget.maxWallTimeMs)}`,
		`ar:allocatedTokens ${xsdLong(budget.maxTokens)}`,
		`ar:allocatedCostUsdMicros ${xsdLong(budget.maxCostUsdMicros)}`,
		`ar:allocatedArtifactBytes ${xsdLong(budget.maxArtifactBytes)}`,
	];
}

/** Choreograph modes v1 audit: `<session> agt:ranInMode <mode>` (at most one). */
function ranInModePredicates(modeIri: string | undefined): string[] {
	if (modeIri === undefined) return [];
	if (!isModeIri(modeIri)) throw new Error(`invalid Agent Session mode IRI: ${JSON.stringify(modeIri)}`);
	return [`agt:ranInMode ${iri(modeIri)}`];
}

function sessionBlock(
	sessionIriValue: string,
	sessionId: string,
	sessionState: string,
	materialization: readonly string[],
	projectionRevision: number | null = null,
	additionalPredicates: readonly string[] = [],
): string {
	const predicates = [
		`agt:sessionId ${str(sessionId)}`,
		`ar:sessionState ${str(sessionState)}`,
		...(projectionRevision === null ? [] : [`ar:projectionRevision ${xsdLong(projectionRevision)}`]),
		...materialization,
		...additionalPredicates,
	];
	return `${iri(sessionIriValue)} a agt:Session ;\n${predicates
		.map((predicate, index) => `  ${predicate}${index === predicates.length - 1 ? " ." : " ;"}`)
		.join("\n")}`;
}

function rootAggregatePredicates(snapshot: AgentSessionFamilyProjectionSnapshot): string[] {
	const { root } = snapshot;
	return [
		`ar:directAcceptedChildren ${xsdLong(root.directAcceptedChildren)}`,
		`ar:maxChildren ${xsdLong(root.maxChildren)}`,
		`ar:occupiedChildren ${xsdLong(root.occupiedChildren)}`,
		`ar:maxConcurrentChildren ${xsdLong(root.maxConcurrentChildren)}`,
		`ar:budgetCostSpentUsdMicros ${xsdLong(root.budgetCostSpentUsdMicros)}`,
		`ar:budgetCostReservedUsdMicros ${xsdLong(root.budgetCostReservedUsdMicros)}`,
		`ar:budgetCostRemainingUsdMicros ${xsdLong(root.budgetCostRemainingUsdMicros)}`,
		`ar:budgetCostMaxUsdMicros ${xsdLong(root.budgetCostMaxUsdMicros)}`,
		`ar:budgetAccountExhausted ${xsdBool(root.budgetAccountExhausted)}`,
		`ar:budgetAccountRevision ${xsdLong(root.budgetAccountRevision)}`,
	];
}

function validateAndSortSnapshot(
	snapshot: AgentSessionFamilyProjectionSnapshot,
): readonly AgentSessionFamilyProjectionChild[] {
	validateProjectionCoordinates(snapshot.root.graphId, snapshot.projectionRevision);
	validateSessionState(snapshot.root.sessionState, `family root ${snapshot.root.sessionId}`);
	validateMaterialization(snapshot.root, `family root ${snapshot.root.sessionId}`);
	for (const [name, value] of Object.entries({
		directAcceptedChildren: snapshot.root.directAcceptedChildren,
		maxChildren: snapshot.root.maxChildren,
		occupiedChildren: snapshot.root.occupiedChildren,
		maxConcurrentChildren: snapshot.root.maxConcurrentChildren,
		budgetCostSpentUsdMicros: snapshot.root.budgetCostSpentUsdMicros,
		budgetCostReservedUsdMicros: snapshot.root.budgetCostReservedUsdMicros,
		budgetCostRemainingUsdMicros: snapshot.root.budgetCostRemainingUsdMicros,
		budgetCostMaxUsdMicros: snapshot.root.budgetCostMaxUsdMicros,
		budgetAccountRevision: snapshot.root.budgetAccountRevision,
	})) {
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Error(`Agent Session family root has invalid aggregate field ${name}`);
		}
	}
	if (typeof snapshot.root.budgetAccountExhausted !== "boolean") {
		throw new Error("Agent Session family root has invalid exhausted testimony");
	}
	if (
		snapshot.root.directAcceptedChildren > snapshot.root.maxChildren ||
		snapshot.root.occupiedChildren > snapshot.root.maxConcurrentChildren ||
		snapshot.root.occupiedChildren > snapshot.root.directAcceptedChildren
	) {
		throw new Error("Agent Session family root has divergent child capacity aggregates");
	}
	const committedCost = snapshot.root.budgetCostReservedUsdMicros + snapshot.root.budgetCostSpentUsdMicros;
	if (!Number.isSafeInteger(committedCost)) {
		throw new Error("Agent Session family root has invalid aggregate cost arithmetic");
	}
	const overLimit = committedCost > snapshot.root.budgetCostMaxUsdMicros;
	if (overLimit && !snapshot.root.budgetAccountExhausted) {
		throw new Error("Agent Session family root suppresses exhausted over-limit testimony");
	}
	const expectedRemaining = Math.max(0, snapshot.root.budgetCostMaxUsdMicros - committedCost);
	if (snapshot.root.budgetCostRemainingUsdMicros !== expectedRemaining) {
		throw new Error("Agent Session family root has a divergent remaining cost budget");
	}
	sessionIri(snapshot.root.sessionId, snapshot.root.agentId);
	const children = [...snapshot.children].sort(
		(left, right) =>
			left.depth - right.depth ||
			left.registeredAt - right.registeredAt ||
			left.child.sessionId.localeCompare(right.child.sessionId),
	);
	const knownDepth = new Map<string, number>([[snapshot.root.sessionId, 0]]);
	const childIds = new Set<string>();
	const relationIds = new Set<string>();
	for (const child of children) {
		agentSessionFamilyRelationIri(child.relationId);
		sessionIri(child.child.sessionId, child.child.agentId);
		if (relationIds.has(child.relationId) || childIds.has(child.child.sessionId)) {
			throw new Error("Agent Session family projection repeats a relation or child Session");
		}
		relationIds.add(child.relationId);
		childIds.add(child.child.sessionId);
		if (child.child.graphId !== snapshot.root.graphId) {
			throw new Error(`Agent Session family child ${child.child.sessionId} crossed its graph authority boundary`);
		}
		const parentDepth = knownDepth.get(child.parentSessionId);
		if (parentDepth === undefined || child.depth !== parentDepth + 1) {
			throw new Error(`Agent Session family relation ${child.relationId} has a dishonest depth`);
		}
		if (!Number.isSafeInteger(child.registeredAt) || child.registeredAt < 0) {
			throw new Error(`Agent Session family relation ${child.relationId} has an invalid registration time`);
		}
		if (!child.childName) throw new Error(`Agent Session family relation ${child.relationId} has no child name`);
		validateSessionState(child.child.sessionState, `family child ${child.child.sessionId}`);
		validateMaterialization(child, `family child ${child.child.sessionId}`);
		if (child.admission) {
			if (
				child.admission.childName !== child.childName ||
				child.admission.depth !== child.depth ||
				(child.admission.runtimeKind !== "simple" && child.admission.runtimeKind !== "prime")
			) {
				throw new Error(`Agent Session family relation ${child.relationId} has a divergent admission`);
			}
			validateBudget(child.admission.budget, child.relationId);
			if (!child.childRunState || !CHILD_RUN_STATES.has(child.childRunState)) {
				throw new Error(`Agent Session family relation ${child.relationId} has invalid child run testimony`);
			}
			if (!ALLOCATION_STATES.has(child.admission.allocationState)) {
				throw new Error(`Agent Session family relation ${child.relationId} has invalid allocation state`);
			}
			if (
				(child.admission.allocationState === "accounting_hold" &&
					child.admission.allocationHoldKind !== "unresolved_child_reservations") ||
				(child.admission.allocationState !== "accounting_hold" && child.admission.allocationHoldKind !== null)
			) {
				throw new Error(
					`Agent Session family relation ${child.relationId} has dishonest accounting hold testimony`,
				);
			}
			if (
				(child.admission.allocationState === "settled") !==
				(child.admission.settledActualCostUsdMicros !== null)
			) {
				throw new Error(`Agent Session family relation ${child.relationId} has dishonest settled cost testimony`);
			}
			if (
				child.admission.settledActualCostUsdMicros !== null &&
				(!Number.isSafeInteger(child.admission.settledActualCostUsdMicros) ||
					child.admission.settledActualCostUsdMicros < 0)
			) {
				throw new Error(`Agent Session family relation ${child.relationId} has invalid settled cost testimony`);
			}
		} else if (child.childRunState !== null) {
			throw new Error(`Agent Session family relation ${child.relationId} has orphaned child run testimony`);
		}
		knownDepth.set(child.child.sessionId, child.depth);
	}
	return children;
}

function validateProjectionCoordinates(graphId: string, projectionRevision: number): void {
	if (!GRAPH_ID.test(graphId)) {
		throw new Error(`Agent Session family graph id is invalid: ${JSON.stringify(graphId)}`);
	}
	if (!Number.isSafeInteger(projectionRevision) || projectionRevision < 0) {
		throw new Error("Agent Session family projection revision must be a non-negative safe integer");
	}
}

function validateSessionState(state: string, label: string): void {
	if (!SESSION_STATES.has(state)) throw new Error(`Agent Session ${label} has invalid Session state`);
}

function validateMaterialization(
	value: Pick<
		AgentSessionFamilyProjectionChild,
		| "materializationGeneration"
		| "materializationState"
		| "workerState"
		| "kernelState"
		| "materializationFaultKind"
		| "materializationRecoverable"
	>,
	label: string,
): void {
	const required = [value.materializationGeneration, value.materializationState, value.workerState];
	const present = required.filter((coordinate) => coordinate !== null).length;
	if (present !== 0 && present !== required.length) {
		throw new Error(`Agent Session ${label} has partial materialization testimony`);
	}
	if (present === 0) {
		if (
			value.kernelState !== null ||
			value.materializationFaultKind !== null ||
			value.materializationRecoverable !== null
		) {
			throw new Error(`Agent Session ${label} has orphaned materialization testimony`);
		}
		return;
	}
	if (!Number.isSafeInteger(value.materializationGeneration) || value.materializationGeneration! < 0) {
		throw new Error(`Agent Session ${label} has invalid materialization generation`);
	}
	if (!MATERIALIZATION_STATES.has(value.materializationState!)) {
		throw new Error(`Agent Session ${label} has invalid materialization state`);
	}
	if (!MATERIALIZATION_STATES.has(value.workerState!)) {
		throw new Error(`Agent Session ${label} has invalid worker state`);
	}
	if (value.kernelState !== null && !KERNEL_STATES.has(value.kernelState)) {
		throw new Error(`Agent Session ${label} has invalid kernel state`);
	}
	const faultPairPresent = value.materializationFaultKind !== null && value.materializationRecoverable !== null;
	if (
		(value.materializationFaultKind === null) !== (value.materializationRecoverable === null) ||
		(value.materializationState === "faulted") !== faultPairPresent
	) {
		throw new Error(`Agent Session ${label} has dishonest fault testimony`);
	}
	if (value.materializationFaultKind !== null && !MATERIALIZATION_FAULT_KINDS.has(value.materializationFaultKind)) {
		throw new Error(`Agent Session ${label} has invalid materialization fault kind`);
	}
	if (value.materializationRecoverable !== null && typeof value.materializationRecoverable !== "boolean") {
		throw new Error(`Agent Session ${label} has invalid materialization recoverable testimony`);
	}
}

function materializationPredicates(
	value: Pick<
		AgentSessionFamilyProjectionChild,
		| "materializationGeneration"
		| "materializationState"
		| "workerState"
		| "kernelState"
		| "materializationFaultKind"
		| "materializationRecoverable"
	>,
): string[] {
	if (value.materializationState === null) return [];
	return [
		`ar:materializationGeneration ${xsdLong(value.materializationGeneration!)}`,
		`ar:materializationState ${str(value.materializationState)}`,
		`ar:workerState ${str(value.workerState!)}`,
		...(value.kernelState === null ? [] : [`ar:kernelState ${str(value.kernelState)}`]),
		...(value.materializationFaultKind === null
			? []
			: [
					`ar:materializationFaultKind ${str(value.materializationFaultKind)}`,
					`ar:materializationRecoverable ${xsdBool(value.materializationRecoverable!)}`,
				]),
	];
}

function validateBudget(budget: AgentSessionChildBudgetSliceV1, relationId: string): void {
	if (budget.schema !== "choreograph.agent-session-child-budget.v1") {
		throw new Error(`Agent Session relation ${relationId} has invalid budget schema`);
	}
	for (const [name, value] of Object.entries(budget)) {
		if (name === "schema") continue;
		if (!Number.isSafeInteger(value) || value < 0) {
			throw new Error(`Agent Session relation ${relationId} has invalid budget field ${name}`);
		}
	}
}

function childrenById(
	snapshot: AgentSessionFamilyProjectionSnapshot,
): ReadonlyMap<string, AgentSessionFamilyProjectionChild> {
	return new Map(snapshot.children.map((child) => [child.child.sessionId, child]));
}

function sessionIri(sessionId: string, agentId: string | null): string {
	if (!agentId) throw new Error(`Agent Session ${sessionId} has no registered Agent identity`);
	return mintAgentSessionUri(agentId, sessionId);
}

function iri(value: string): string {
	return `<${value}>`;
}

function indent(value: string, spaces: number): string {
	const prefix = " ".repeat(spaces);
	return value
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
}
