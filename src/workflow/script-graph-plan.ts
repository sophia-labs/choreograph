/**
 * The `graph-plan-v1` built-in: runs a workflow whose definition is a named RDF graph (`graph-plan.ts`).
 *
 * The host reads the definition graph, compiles it, and refuses unless the caller names the digest
 * of exactly that compiled plan (the person approved what they saw). Each step runs as a read-only
 * agent with a host-bound runtime and Agent Ontology, as the workspace chat's Reader does. The script
 * below is the whole interpreter; it walks data and never evaluates anything from the graph. After
 * the run, `finalizeGraphPlanRun` writes what each step produced, and what each check refused, into
 * the run's own named graph.
 *
 * Testimony with provenance (2026-10-20, plans/2026-10-20-typed-objects D5): the record names, per step, the being
 * the host cast for it (`wf:castAgent`), and per item the sitting that handed it back (`wf:sitting`, the node's
 * label). An agent that never handed back an answer that fit is recorded too (`wf:Unfit`, with the runtime's words),
 * so nothing a step was given disappears without a trace.
 */
import { agentModeRef } from "../agent-runtime/agent-mode.js";
import { createMeaningfulObjectRef } from "../agent-runtime/meaningful-object.js";
import {
	AGENT_ONTOLOGY_BINDING_SCHEMA,
	type AgentOntologyBindingV1,
	validateAgentOntologyBinding,
} from "../agent-runtime/ontology-binding.js";
import {
	AGENT_RUNTIME_BINDING_SCHEMA,
	type AgentRuntimeBindingV2,
	validateResolvedAgentRuntimeBinding,
} from "../agent-runtime/profile.js";
import {
	CANONICAL_AGENT_ID,
	mintAgentUri,
	mintStandaloneAgentId,
	STANDALONE_AGENT_IDENTITY_ALGORITHM,
} from "../agent-subject/agent-ontology.js";
import {
	assertIri,
	compileGraphPlan,
	definitionQuery,
	GRAPH_PLAN_LIMITS,
	GRAPH_PLAN_WORKFLOW_NAME,
	GraphPlanError,
	type GraphPlanSourceV1,
	type GraphPlanStepV1,
	type GraphPlanV1,
	graphPlanDigest,
	localId,
	stepOutputSchema,
	triplesFromSparqlResult,
	WF,
} from "./graph-plan.js";
import type { GraphWriter } from "./graph-writer.js";
import type { WorkflowRunInputs } from "./harness.js";
import { InvocationFault } from "./invocation.js";
import type { RunRecord } from "./types.js";
import {
	WORKSPACE_CHAT_RUNTIME_CONSTRAINTS,
	type WorkspaceChatInferenceV1,
	workspaceReaderFence,
} from "./workspace-chat.js";
import { WORKSPACE_READER_TOOLS_V1 } from "./workspace-chat-contract.js";

export { GRAPH_PLAN_WORKFLOW_NAME };

export const GRAPH_PLAN_SCRIPT = `export const meta = {
	name: "${GRAPH_PLAN_WORKFLOW_NAME}",
	description: "Run a workflow whose definition is a named RDF graph: ordered phases, steps run once or once per item, and checks that pass or refuse each item. The definition is data; this script is the whole interpreter.",
	whenToUse: "Use to run a graph-authored workflow that a person approved by digest.",
	executor: "gated",
	execution: {
		schema: "choreograph.execution-binding.v1",
		controller: "composite",
		modelUse: "agentic",
		isolation: "sandbox",
		effects: "capability-bound",
		reproducibility: "nondeterministic",
		capabilities: ["garden.graph", "choreograph.agent"],
		authority: { minimumRole: "editor", dangerousOps: false },
		mayInvokeChildren: false,
	},
	inputs: {
		type: "object",
		additionalProperties: false,
		required: ["definition", "digest"],
		properties: {
			definition: { type: "string", minLength: 1 },
			digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
			inputs: { type: "object" },
		},
	},
	outputs: {
		type: "object",
		additionalProperties: false,
		required: ["collections", "sittings", "refused", "unfit", "steps"],
		properties: { collections: {}, sittings: {}, refused: {}, unfit: {}, steps: {} },
	},
}

const plan = args.plan
const collections = {}
// Beside each collection, position by position, the sitting that handed back each of its items: the label of the node
// ("Experiment clerk #3"). Kept apart from the items, so the next step is given exactly what was handed back.
const sittings = {}
const refused = []
// An agent that never handed back an answer that fit: which step, which sitting, and the runtime's words. Recorded,
// never dropped.
const unfit = []
const steps = []
const cap = ${GRAPH_PLAN_LIMITS.itemsPerCollection}
const answered = (r) => r && r.structured !== undefined && r.structured !== null
const why = (r) => (r && typeof r.output === "string" && r.output.trim()) || "no answer was handed back"

// A step that answers without calling submit() gets one more chance, told plainly (2026-10-18: three of 26 clerks
// lost their passage this way). The retry is its own node (" again"), so its session and testimony are its own.
const ask = async (prompt, o) => {
	const r = await agent(prompt, o)
	if (r && r.structured !== undefined) return r
	return agent(prompt + "\\n\\nYour last attempt ended without calling submit(). Call submit() now with your answer; if there is nothing to report, submit an empty list.", { ...o, label: o.label + " again" })
}

for (const ph of plan.phases) {
	phase(ph.title)
	await parallel(ph.steps.map((step) => async () => {
		const opts = {
			label: step.label,
			agentType: step.job,
			agentId: step.agent.agentId,
			model: step.agent.model,
			provider: step.agent.provider,
			systemPrompt: step.agent.systemPrompt,
			toolMode: "dynamic",
			graphAccess: "read",
			includeTools: step.agent.includeTools,
			strictToolManifest: false,
			maxTurns: step.agent.maxTurns,
			runtime: step.agent.runtime,
			ontology: step.agent.ontology,
			schema: step.outputSchema,
		}
		if (step.mode === "perItem") {
			const items = collections[step.over] || []
			const madeBy = sittings[step.over] || []
			// One agent node per item, each with its own label (and so its own node key and Agent Session).
			const answers = await pipeline(items.map((item, i) => ({ item, i })), ({ item, i }) => {
				const sitting = step.label + " #" + (i + 1)
				return ask("The item:\\n" + JSON.stringify(item, null, 2), { ...opts, label: sitting }).then((r) => ({ item, i, sitting, r }))
			})
			if (step.checks) {
				// A check passes items; it does not make them. What it passes keeps the sitting of the one who made it.
				const passed = []
				const passedBy = []
				for (const a of answers) {
					const out = a.r && a.r.structured
					if (out && out.ok === true) {
						passed.push(a.item)
						passedBy.push(madeBy[a.i])
					} else refused.push({ step: step.iri, item: a.item, verdict: out || null })
				}
				if (step.produces) {
					collections[step.produces] = passed
					sittings[step.produces] = passedBy
				}
				steps.push({ step: step.iri, runs: items.length, produced: passed.length, refused: items.length - passed.length })
			} else {
				const produced = []
				const producedBy = []
				for (const a of answers) {
					if (!answered(a.r)) {
						unfit.push({ step: step.iri, sitting: a.sitting, violation: why(a.r) })
						continue
					}
					for (const x of a.r.structured.items || []) {
						produced.push(x)
						producedBy.push(a.sitting)
					}
				}
				collections[step.produces] = produced.slice(0, cap)
				sittings[step.produces] = producedBy.slice(0, cap)
				steps.push({ step: step.iri, runs: items.length, produced: produced.length })
			}
			return
		}
		const given = step.consumes.length
			? step.consumes.map((c) => "The collection " + c + ":\\n" + JSON.stringify(collections[c] || [], null, 2)).join("\\n\\n")
			: step.reads && step.reads.length && Object.keys(args.inputs || {}).length === 0
				? "Begin with your sources."
				: "The run input:\\n" + JSON.stringify(args.inputs || {}, null, 2)
		const r = await ask(given, opts)
		if (!answered(r)) unfit.push({ step: step.iri, sitting: step.label, violation: why(r) })
		const items = ((r.structured && r.structured.items) || []).slice(0, cap)
		collections[step.produces] = items
		sittings[step.produces] = items.map(() => step.label)
		steps.push({ step: step.iri, runs: 1, produced: items.length })
	}))
}
return { collections, sittings, refused, unfit, steps }
`;

export interface GraphPlanRequestV1 {
	readonly definition: string;
	readonly digest: string;
	readonly inputs: Record<string, unknown>;
}

export function parseGraphPlanRequest(body: unknown): GraphPlanRequestV1 {
	const record = isRecord(body) ? body : {};
	const source = isRecord(record.workflow_args) ? record.workflow_args : record;
	const definition = typeof source.definition === "string" ? source.definition.trim() : "";
	const digest = typeof source.digest === "string" ? source.digest.trim() : "";
	if (!definition)
		throw new InvocationFault("graph_plan_definition_missing", "name the definition graph (definition)", 400);
	try {
		assertIri(definition, "definition");
	} catch (error) {
		throw new InvocationFault("graph_plan_definition_invalid", (error as Error).message, 400);
	}
	if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
		throw new InvocationFault(
			"graph_plan_digest_missing",
			"name the digest of the plan you approved (digest: sha256:…); a graph plan never runs unapproved",
			400,
		);
	}
	const inputs = isRecord(source.inputs) ? source.inputs : {};
	return { definition, digest, inputs };
}

/** Read and compile the definition graph; refuse unless it compiles to exactly the approved digest. */
export async function loadApprovedGraphPlan(input: {
	readonly graph: GraphWriter;
	readonly graphId: string;
	readonly request: GraphPlanRequestV1;
}): Promise<{ plan: GraphPlanV1; digest: string }> {
	const raw = await input.graph.sparqlQuery(input.graphId, definitionQuery(input.request.definition));
	let plan: GraphPlanV1;
	try {
		plan = compileGraphPlan(triplesFromSparqlResult(raw));
	} catch (error) {
		if (error instanceof GraphPlanError) {
			throw new InvocationFault("graph_plan_invalid", error.message, 422, { problems: error.problems });
		}
		throw error;
	}
	const digest = graphPlanDigest(plan);
	if (digest !== input.request.digest) {
		throw new InvocationFault(
			"graph_plan_digest_mismatch",
			"the definition changed since it was approved: approve the plan as it is now",
			409,
			{ approved: input.request.digest, actual: digest },
		);
	}
	return { plan, digest };
}

export function buildGraphPlanInputs(input: {
	readonly graphId: string;
	readonly graphOwnerPrincipal: string;
	readonly request: GraphPlanRequestV1;
	readonly plan: GraphPlanV1;
	readonly digest: string;
	readonly runtimeBundle: { readonly id: string; readonly digest: string };
	readonly inference: WorkspaceChatInferenceV1;
	readonly liveTools?: readonly string[];
	readonly now?: number;
}): WorkflowRunInputs {
	const { graphId, graphOwnerPrincipal: ownerPrincipal, plan } = input;
	const now = input.now ?? Date.now();
	const fence = workspaceReaderFence(graphId);
	const tools = WORKSPACE_READER_TOOLS_V1.filter((tool) => !input.liveTools || input.liveTools.includes(tool));
	const ref = <Kind extends Parameters<typeof createMeaningfulObjectRef>[0]["kind"]>(
		kind: Kind,
		objectId: string,
		value: unknown,
	) => createMeaningfulObjectRef({ kind, ownerPrincipal, graphId, objectId, version: "1", value });
	const runtimeProfile = ref(
		"agent-runtime-profile",
		`builtin:${GRAPH_PLAN_WORKFLOW_NAME}:runtime-profile`,
		WORKSPACE_CHAT_RUNTIME_CONSTRAINTS,
	);
	const runtime: AgentRuntimeBindingV2 = {
		schema: AGENT_RUNTIME_BINDING_SCHEMA,
		kind: "prime",
		bundle: {
			id: input.runtimeBundle.id,
			digest: input.runtimeBundle.digest.startsWith("sha256:")
				? input.runtimeBundle.digest
				: `sha256:${input.runtimeBundle.digest}`,
		},
		profileRef: runtimeProfile,
		constraints: { ...WORKSPACE_CHAT_RUNTIME_CONSTRAINTS },
	};
	validateResolvedAgentRuntimeBinding(runtime);

	const agentFor = (step: GraphPlanStepV1) => {
		const registeredName = `${GRAPH_PLAN_WORKFLOW_NAME}:${ownerPrincipal}/${graphId}/${plan.name}/${step.id}`;
		const agentId = mintStandaloneAgentId({ name: registeredName });
		const agentUri = mintAgentUri(agentId);
		const systemPrompt = stepSystemPrompt(plan, step);
		const ontology: AgentOntologyBindingV1 = {
			schema: AGENT_ONTOLOGY_BINDING_SCHEMA,
			subject: {
				agentId,
				agentUri,
				observerId: agentId,
				registeredName,
				identityAlgorithm: STANDALONE_AGENT_IDENTITY_ALGORITHM,
			},
			objects: {
				agent: ref("agent", agentUri, { registeredName, agentId, agentUri }),
				geist: ref("geist", `builtin:${GRAPH_PLAN_WORKFLOW_NAME}:${step.id}:geist`, {
					home: graphId,
					observer: agentId,
				}),
				prompt: ref("prompt", `builtin:${GRAPH_PLAN_WORKFLOW_NAME}:${step.id}:prompt`, { systemPrompt }),
				skills: [],
				harness: ref("harness", GRAPH_PLAN_WORKFLOW_NAME, {
					workflow: GRAPH_PLAN_WORKFLOW_NAME,
					plan: input.digest,
				}),
				toolManifest: ref("tool-manifest", `builtin:${GRAPH_PLAN_WORKFLOW_NAME}:reader-tools`, {
					tools: fence.mode.allowsTool,
				}),
				// Host-issued, like the workspace chat's Reader: the built-in mode is the whole authority, and the
				// gateway ACL and the cell's lease still govern every call.
				toolGrant: ref("tool-grant", `builtin:${GRAPH_PLAN_WORKFLOW_NAME}:reader-grant`, {
					issuer: "choreograph-host",
					mode: agentModeRef(fence.mode),
				}),
				runtimeProfile,
			},
			mode: agentModeRef(fence.mode),
			resolvedAt: now,
		};
		validateAgentOntologyBinding(ontology);
		return {
			agentId,
			provider: input.inference.provider,
			model: input.inference.model,
			systemPrompt,
			includeTools: tools,
			maxTurns: runtime.constraints.maxTurns,
			runtime,
			ontology,
		};
	};

	const runnable = {
		...plan,
		phases: plan.phases.map((phase) => ({
			...phase,
			steps: phase.steps.map((step) => ({ ...step, outputSchema: stepOutputSchema(step), agent: agentFor(step) })),
		})),
	};
	// The being cast for each step, by step IRI: what the run record names as `wf:castAgent`. Host facts, never the
	// script's: every sitting of a step runs as this one being.
	const castAgents = Object.fromEntries(
		runnable.phases.flatMap((phase) => phase.steps.map((step) => [step.iri, step.agent.agentId] as const)),
	);
	const first = runnable.phases[0]?.steps[0]?.agent;
	return {
		config: {
			graphId,
			provider: input.inference.provider,
			model: input.inference.model,
			toolMode: "dynamic",
			includeTools: tools,
			strictToolManifest: false,
			...(first ? { agentId: first.agentId, runtime: first.runtime, ontology: first.ontology } : {}),
		},
		args: {
			plan: runnable,
			inputs: input.request.inputs,
			definition: input.request.definition,
			digest: input.digest,
		},
		schemaInput: { definition: input.request.definition, digest: input.digest, inputs: input.request.inputs },
		hostContext: {
			graphPlan: {
				graphId,
				definition: input.request.definition,
				digest: input.digest,
				workflow: plan.workflow,
				name: plan.name,
				castAgents,
			},
		},
	};
}

function stepSystemPrompt(plan: GraphPlanV1, step: GraphPlanStepV1): string {
	const lines = [
		`You are ${step.label} (${step.job}), one step of the workflow "${plan.title}" in this workspace.`,
		"",
		"Your instructions:",
		step.instructions,
		"",
	];
	const sources = (step.reads ?? [])
		.map((iri) => plan.sources?.find((source) => source.iri === iri))
		.filter((source): source is GraphPlanSourceV1 => source !== undefined);
	if (sources.length > 0) {
		lines.push(
			"You read:",
			...sources.map((source) => `- ${source.label}: ${sourceWords(source)}.`),
			"Read it with your tools; your instructions may call it by name.",
			"",
		);
	}
	if (step.checks) {
		lines.push(
			"You check one item at a time. Answer ok: true only if the item meets your instructions exactly; otherwise ok: false, a short reason, and, where it helps, the nearest thing that would be right.",
		);
	} else if (step.mode === "perItem") {
		lines.push(
			"You are given one item. Answer with the items you produce from it (an empty list if there are none).",
		);
	} else {
		lines.push("Answer with the items you produce.");
	}
	if (step.itemClass && !step.checks) lines.push(`Each item you hand back is ${withArticle(itemClassName(step))}.`);
	lines.push(
		"You may read and search this workspace with your tools. You do not write to it; the host records what you answer.",
		"When you have your answer, call submit() with it. That call is your only answer: never reply in plain text, and do not stop without calling submit().",
	);
	return lines.join("\n");
}

/**
 * What a class-bound step's items are called: the class's label when the plan carries one (its derived schema's
 * `title`), else the class IRI's fragment ("DreamReport").
 */
function itemClassName(step: GraphPlanStepV1): string {
	const title = step.itemSchema?.title;
	if (typeof title === "string" && title.trim() && title.length <= 120 && !/[\r\n]/.test(title)) return title.trim();
	const iri = step.itemClass ?? "";
	const hash = iri.lastIndexOf("#");
	return (hash >= 0 ? iri.slice(hash + 1) : "") || localId(iri);
}

function withArticle(name: string): string {
	return `${/^(?!uni|use|usu|eu|one)[aeiou]/i.test(name) ? "an" : "a"} ${name}`;
}

/** Where a source is, in the words a step is given: a document, or a run of its blocks. */
export function sourceWords(source: GraphPlanSourceV1): string {
	const range =
		source.fromBlock && source.toBlock
			? `, from block ${source.fromBlock} through block ${source.toBlock}`
			: source.fromBlock
				? `, from block ${source.fromBlock} to its end`
				: source.toBlock
					? `, from its beginning through block ${source.toBlock}`
					: "";
	return `document ${source.documentId}${range}`;
}

/** The trusted host facts of a graph-plan run (never from the script's args): its home graph and approved plan. */
export function readGraphPlanHostContext(
	value: unknown,
):
	| { readonly graphId: string; readonly definition: string; readonly digest: string; readonly workflow: string }
	| undefined {
	const host = isRecord(value) && isRecord(value.graphPlan) ? value.graphPlan : undefined;
	if (!host) return undefined;
	const { graphId, definition, digest, workflow } = host;
	if (
		typeof graphId !== "string" ||
		typeof definition !== "string" ||
		typeof digest !== "string" ||
		typeof workflow !== "string"
	) {
		return undefined;
	}
	return { graphId, definition, digest, workflow };
}

/** The run's own named graph: what each step produced and what each check refused, as testimony of this run. */
export function graphPlanRunGraphIri(workflowIri: string, runId: string): string {
	return `${workflowIri}:run:${runId.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

interface GraphPlanRunTestimony {
	readonly runId: string;
	readonly status: string;
	readonly definition: string;
	readonly digest: string;
	readonly workflow: string;
	readonly output: unknown;
	/** The being the host cast for each step, by step IRI (`buildGraphPlanInputs`'s host context). */
	readonly castAgents?: Readonly<Record<string, string>>;
}

/** The run's testimony as a SPARQL update into its own named graph (for a cell that grants `sparql_update`). */
export function serializeGraphPlanRun(input: GraphPlanRunTestimony): string {
	const { runGraph, triples } = graphPlanRunTriples(input);
	return `PREFIX wf: <${WF}>\nINSERT DATA { GRAPH <${runGraph}> {\n${triples.join("\n")}\n} }`;
}

/**
 * The same testimony as Turtle, for gardend's `workflow_run_record`, which writes it into the run graph with only
 * document-write scope (a self-hosted gardend gives Compute a member token, which may not `sparql_update`).
 */
export function serializeGraphPlanRunTurtle(input: GraphPlanRunTestimony): string {
	return `@prefix wf: <${WF}> .\n${graphPlanRunTriples(input).triples.join("\n")}\n`;
}

/** An IRI that may stand between angle brackets in Turtle and SPARQL. */
const IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|\\^`]+$/;

function graphPlanRunTriples(input: GraphPlanRunTestimony): { runGraph: string; triples: string[] } {
	const runGraph = graphPlanRunGraphIri(input.workflow, input.runId);
	const run = `<${runGraph}#run>`;
	const out = isRecord(input.output) ? input.output : {};
	const triples: string[] = [
		`${run} a wf:GraphPlanRun ; wf:runId ${lit(input.runId)} ; wf:status ${lit(input.status)} ; wf:definition <${input.definition}> ; wf:definitionDigest ${lit(input.digest)} ; wf:workflow <${input.workflow}> .`,
	];
	const collections = isRecord(out.collections) ? out.collections : {};
	const sittings = isRecord(out.sittings) ? out.sittings : {};
	let n = 0;
	for (const [collection, items] of Object.entries(collections)) {
		if (!Array.isArray(items)) continue;
		const madeBy = sittings[collection];
		items.forEach((item, position) => {
			n += 1;
			const sitting = Array.isArray(madeBy) && typeof madeBy[position] === "string" ? madeBy[position] : undefined;
			triples.push(
				`<${runGraph}#item-${n}> a wf:Item ; wf:partOfRun ${run} ; wf:inCollection <${collection}> ; wf:position ${position} ; wf:json ${lit(JSON.stringify(item))}${sitting ? ` ; wf:sitting ${lit(sitting)}` : ""} .`,
			);
		});
	}
	const refused = Array.isArray(out.refused) ? out.refused : [];
	refused.forEach((r, i) => {
		const rec = isRecord(r) ? r : {};
		const step = typeof rec.step === "string" ? rec.step : "";
		triples.push(
			`<${runGraph}#refused-${i + 1}> a wf:Refusal ; wf:partOfRun ${run} ;${step ? ` wf:checkedBy <${step}> ;` : ""} wf:json ${lit(JSON.stringify(rec.item ?? null))} ; wf:verdict ${lit(JSON.stringify(rec.verdict ?? null))} .`,
		);
	});
	const unfit = Array.isArray(out.unfit) ? out.unfit : [];
	unfit.forEach((u, i) => {
		const rec = isRecord(u) ? u : {};
		const step = typeof rec.step === "string" && IRI.test(rec.step) ? rec.step : undefined;
		const violation =
			typeof rec.violation === "string" && rec.violation.trim() ? rec.violation : "no answer was handed back";
		triples.push(
			`<${runGraph}#unfit-${i + 1}> a wf:Unfit ; wf:partOfRun ${run}${step ? ` ; wf:step <${step}>` : ""}${typeof rec.sitting === "string" ? ` ; wf:sitting ${lit(rec.sitting)}` : ""} ; wf:violation ${lit(violation)} .`,
		);
	});
	const steps = Array.isArray(out.steps) ? out.steps : [];
	steps.forEach((s, i) => {
		const rec = isRecord(s) ? s : {};
		if (typeof rec.step !== "string") return;
		const agentId = input.castAgents?.[rec.step];
		const cast = agentId && CANONICAL_AGENT_ID.test(agentId) ? ` ; wf:castAgent <${mintAgentUri(agentId)}>` : "";
		triples.push(
			`<${runGraph}#step-${i + 1}> a wf:StepRun ; wf:partOfRun ${run} ; wf:step <${rec.step}> ; wf:runs ${Number(rec.runs) || 0} ; wf:produced ${Number(rec.produced) || 0}${rec.refused !== undefined ? ` ; wf:refused ${Number(rec.refused) || 0}` : ""}${cast} .`,
		);
	});
	return { runGraph, triples };
}

export async function finalizeGraphPlanRun(
	run: RunRecord,
	ctx: { graph: GraphWriter; graphId: string; inputs: WorkflowRunInputs },
): Promise<void> {
	const host =
		isRecord(ctx.inputs.hostContext) && isRecord(ctx.inputs.hostContext.graphPlan)
			? ctx.inputs.hostContext.graphPlan
			: undefined;
	if (
		!host ||
		typeof host.workflow !== "string" ||
		typeof host.definition !== "string" ||
		typeof host.digest !== "string"
	)
		return;
	const castAgents = isRecord(host.castAgents)
		? Object.fromEntries(
				Object.entries(host.castAgents).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
			)
		: {};
	const testimony: GraphPlanRunTestimony = {
		runId: run.runId,
		status: String(run.status),
		definition: host.definition,
		digest: host.digest,
		workflow: host.workflow,
		output: run.output,
		castAgents,
	};
	// gardend's own tool first: it needs only document-write scope, which a self-hosted Compute holds. A cell without
	// the tool (older than 2026-10-20) still takes the update, when this host may make one.
	const documentId = host.workflow.startsWith(WORKFLOW_IRI_PREFIX)
		? host.workflow.slice(WORKFLOW_IRI_PREFIX.length)
		: "";
	if (ctx.graph.recordWorkflowRun && /^[A-Za-z0-9_-]{1,128}$/.test(documentId)) {
		try {
			await ctx.graph.recordWorkflowRun(ctx.graphId, {
				documentId,
				runId: run.runId,
				turtle: serializeGraphPlanRunTurtle(testimony),
			});
			return;
		} catch (recordError) {
			try {
				await ctx.graph.sparqlUpdate(ctx.graphId, serializeGraphPlanRun(testimony));
				return;
			} catch (updateError) {
				throw new Error(
					`the run's results could not be written to its graph: workflow_run_record: ${errorText(recordError)}; sparql_update: ${errorText(updateError)}`,
				);
			}
		}
	}
	await ctx.graph.sparqlUpdate(ctx.graphId, serializeGraphPlanRun(testimony));
}

/** A workflow document's IRI is this prefix and its document id (gardend's `workflow_plan_create`). */
const WORKFLOW_IRI_PREFIX = "urn:sophia:wf:";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A SPARQL string literal: JSON's escaping is valid SPARQL ECHAR/UCHAR. */
function lit(value: string): string {
	return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
