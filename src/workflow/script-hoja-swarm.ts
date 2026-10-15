import type { WorkflowRunInputs } from "./harness.js";
import { buildHojaSwarmInputs } from "./hoja-swarm.js";

export const HOJA_SWARM_WORKFLOW_NAME = "hoja-cross-modal-swarm-v1";

export const HOJA_SWARM_SCRIPT = `export const meta = {
	name: "hoja-cross-modal-swarm-v1",
	description: "Replay a graph-stored Hoja scenario across every Meaningful Object door with host-mediated semantic beats and judge I1-I5.",
	whenToUse: "Use for obs-hoja-* functional waves after the scenario has been generated and stored as data.",
	executor: "dumb",
	execution: {
		schema: "choreograph.execution-binding.v1",
		controller: "program",
		modelUse: "none",
		isolation: "sandbox",
		effects: "capability-bound",
		reproducibility: "recorded-external",
		runtime: { kind: "node" },
		capabilities: ["browser.chromium", "http", "mcp", "yws", "sparql", "soil", "evaluation.visual", "evaluation.primary", "evaluation.foreign"],
		authority: { minimumRole: "editor", dangerousOps: false },
		mayInvokeChildren: false,
	},
	inputs: {
		type: "object",
		additionalProperties: false,
		required: ["scenario", "digest", "graphId"],
		properties: {
			scenario: { type: "object" },
			digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
			graphId: { type: "string", pattern: "^obs-hoja-[A-Za-z0-9._-]+$" },
		},
	},
	outputs: {
		type: "object",
		additionalProperties: false,
		required: ["schema", "scenarioId", "scenarioDigest", "status", "beats", "verdicts", "evaluations", "reflections", "ledger", "deferredCleanup"],
		properties: {
			schema: { const: "sophia.hoja.swarm-result.v1" },
			scenarioId: { type: "string" },
			scenarioDigest: { type: "string" },
			status: { enum: ["passed", "failed"] },
			beats: { type: "array" },
			verdicts: { type: "array" },
			evaluations: { type: "array" },
			reflections: { type: "array" },
			ledger: { type: "object" },
			deferredCleanup: { type: "array" },
		},
	},
}

const scenario = args.scenario
const byBeat = {}
const beats = []
const deferredCleanup = []

const runAction = async (action) => invoke(action)

await journey(scenario.beats, async (beat) => {
	phase(beat.id + ":" + beat.operation)
	const startedAt = Date.now()
	let results
	if (beat.operation === "delete-later") {
		// Cleanup is an explicit handoff, never an effect of a swarm run. The
		// caller may inspect and separately authorize these exact Contract B
		// actions after the evidence and findings ledger are durable.
		deferredCleanup.push(...beat.actions)
		results = beat.actions.map(() => ({ value: { deferred: true }, durationMs: 0 }))
	} else if (beat.mode === "concurrent") {
		results = await Promise.all(beat.actions.map(async (action) => {
			const started = Date.now()
			const value = await runAction(action)
			return { value, durationMs: Date.now() - started }
		}))
	} else {
		results = []
		for (const action of beat.actions) {
			const started = Date.now()
			const value = await runAction(action)
			results.push({ value, durationMs: Date.now() - started })
		}
	}
	let evidence = []
	let diff = null
	let evaluation = null
	if (beat.capture) {
		evidence = await Promise.all(["browser.chromium"].map((capability) => invoke({
			capability,
			tool: "capture_beat",
			args: { runId: scenario.runId, scenarioId: scenario.id, beatId: beat.id },
		})))
		const screenshots = evidence.map((item) => ({ engine: item.engine, ref: item.evidence.screenshot }))
		if (screenshots.length > 1) {
			diff = await invoke({ capability: "evaluation.visual", tool: "perceptual_diff", args: {
				runId: scenario.runId, scenarioId: scenario.id, beatId: beat.id,
				left: screenshots[0].ref, right: screenshots[1].ref,
			} })
		}
		evaluation = await invoke({ capability: "evaluation.visual", tool: "evaluate_visual", args: {
			runId: scenario.runId, scenarioId: scenario.id, beatId: beat.id,
			expectation: "The Hoja application remains usable and visually coherent after operation " + beat.operation + ".",
			screenshots,
			...(diff ? { diff } : {}),
		} })
	}
	const record = { id: beat.id, operation: beat.operation, mode: beat.mode, durationMs: Date.now() - startedAt, actions: results, evidence, diff, evaluation }
	beats.push(record)
	byBeat[beat.id] = record
}, { modelUse: "none" })

const get = (ref) => {
	let value = byBeat[ref.beat].actions[ref.action || 0]
	for (const part of String(ref.path || "value").split(".")) value = value == null ? value : value[part]
	return value
}
const markdown = (value) => String(value == null ? "" : value).replace(/\\r\\n/g, "\\n").split("\\n").map((line) => line.replace(/\\s+$/g, "")).join("\\n").trim() + "\\n"
const textFromJson = (node) => node == null ? "" : Array.isArray(node) ? node.map(textFromJson).join(" ") : typeof node === "object" ? (node.type === "text" ? String(node.text || "") : textFromJson(node.content || [])) : ""
const faceText = (value) => {
	if (value && typeof value === "object" && typeof value.body === "string") {
		if (String(value.contentType || "").includes("json")) { try { return textFromJson(JSON.parse(value.body)) } catch {} }
		return value.body.replace(/<[^>]+>/g, " ")
	}
	if (typeof value === "string") { try { return textFromJson(JSON.parse(value)) } catch { return value.replace(/<[^>]+>/g, " ") } }
	return textFromJson(value)
}
const normalizedText = (value) => faceText(value).replace(/\\s+/g, " ").trim()
const ids = (value) => Array.isArray(value) ? [...value].map(String).sort() : []

const verdicts = scenario.invariants.map((check) => {
	let passed = false
	let observed = {}
	try {
		if (check.id === "I1" && check.kind === "markdown_equal") {
			const left = markdown(get(check.left)); const right = markdown(get(check.right)); passed = left === right; observed = { left, right }
		} else if (check.id === "I2" && check.kind === "face_agreement") {
			const values = check.refs.map((ref) => normalizedText(get(ref))); passed = values.every((value) => value === values[0]); observed = { values }
		} else if (check.id === "I3" && check.kind === "converged") {
			const value = get(check.ref); passed = value && value.converged === true && value.bothPresent !== false; observed = { converged: value && value.converged, bothPresent: value && value.bothPresent }
		} else if (check.id === "I4" && check.kind === "block_identity") {
			const left = ids(get(check.left)); const right = ids(get(check.right)); passed = JSON.stringify(left) === JSON.stringify(right); observed = { left, right }
		} else if (check.id === "I5" && check.kind === "projection_latency") {
			const action = byBeat[check.ref.beat].actions[check.ref.action || 0]; const value = get(check.ref); passed = action.durationMs <= check.maxMs && value != null; observed = { durationMs: action.durationMs, maxMs: check.maxMs }
		} else if (check.id === "I6" && check.kind === "a11y_contains") {
			const value = get(check.ref); const haystack = typeof value === "string" ? value : JSON.stringify(value == null ? "" : value); passed = haystack.includes(check.text); observed = { text: check.text, found: passed }
		}
	} catch (error) { observed = { error: String(error && error.message || error) } }
	return { invariant: check.id, kind: check.kind, passed, observed }
})

const evaluations = beats.filter((beat) => beat.evaluation).map((beat) => ({
	beatId: beat.id,
	diff: beat.diff,
	evaluation: beat.evaluation,
	evidence: beat.evidence.map((item) => item.manifest),
}))
// E0.1: the wave status consumes the L1 visual verdict. An anomaly carrying a
// high/critical claim fails the run — a scenario must not report passed while
// its own judge testifies the app is unusable.
const visualGate = evaluations.map((entry) => {
	const evaluation = entry.evaluation || {}
	const claims = Array.isArray(evaluation.claims) ? evaluation.claims : []
	const graveClaims = claims.filter((claim) => claim.severity === "high" || claim.severity === "critical")
	return {
		beatId: entry.beatId,
		verdict: evaluation.verdict,
		confidencePermille: evaluation.confidencePermille,
		graveClaims: graveClaims.map((claim) => ({ code: claim.code, severity: claim.severity, summary: claim.summary })),
		passed: evaluation.verdict !== "anomaly" || graveClaims.length === 0,
	}
})
const mechanicalPassed = verdicts.every((verdict) => verdict.passed)
const visualPassed = visualGate.every((entry) => entry.passed)
const wave = {
	schema: "sophia.hoja.wave-summary.v1",
	scenarioId: scenario.id,
	scenarioDigest: args.digest,
	status: mechanicalPassed && visualPassed ? "passed" : "failed",
	beats: beats.map((beat) => ({ id: beat.id, operation: beat.operation, durationMs: beat.durationMs, diff: beat.diff, evaluation: beat.evaluation })),
	verdicts,
}
const reflections = await Promise.all(["evaluation.primary", "evaluation.foreign"].map((capability) => invoke({
	capability,
	tool: "reflect_wave",
	args: { runId: scenario.runId, wave },
})))

const ledgerId = "obs-hoja-findings-" + scenario.runId
const ledgerMarkdown = [
	"# Hoja swarm findings " + scenario.runId,
	"",
	"Scenario: " + scenario.id,
	"Digest: " + args.digest,
	"Status: " + wave.status,
	"",
	"## Mechanical verdicts",
	JSON.stringify(verdicts, null, 2),
	"",
	"## Visual gate (E0.1: L1 verdicts bind the wave status)",
	JSON.stringify(visualGate, null, 2),
	"",
	"## L1 evaluations",
	JSON.stringify(evaluations, null, 2),
	"",
	"## L2 independent reflections",
	JSON.stringify(reflections, null, 2),
].join("\\n")
let ledger
try {
	await invoke({ capability: "mcp", tool: "create_document", args: {
		graphId: args.graphId, documentId: ledgerId, title: "Hoja swarm findings " + scenario.runId,
	} })
	await invoke({ capability: "mcp", tool: "write_document", args: {
		graphId: args.graphId, documentId: ledgerId, title: "Hoja swarm findings " + scenario.runId,
		content: ledgerMarkdown, format: "markdown", awaitDurable: true,
	} })
	ledger = { status: "written", graphId: args.graphId, documentId: ledgerId }
} catch (error) {
	ledger = { status: "error", graphId: args.graphId, documentId: ledgerId, error: String(error && error.message || error) }
}

return {
	schema: "sophia.hoja.swarm-result.v1",
	scenarioId: scenario.id,
	scenarioDigest: args.digest,
	status: wave.status,
	beats,
	verdicts,
	evaluations,
	reflections,
	ledger,
	deferredCleanup,
}
`;

export function buildHojaSwarmWorkflowInputs(body: unknown, graphId: string): WorkflowRunInputs {
	return buildHojaSwarmInputs(body, graphId);
}
