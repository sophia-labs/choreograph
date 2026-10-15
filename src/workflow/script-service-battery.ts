import type { WorkflowRunInputs } from "./harness.js";
import { buildServiceBatteryInputs } from "./service-battery.js";

export const SERVICE_BATTERY_WORKFLOW_NAME = "service-battery-durability-v1";
export const SERVICE_BATTERY_RESULT_SCHEMA = "sophia.service.battery-result.v1";

/**
 * The first Garden service battery flow.
 *
 * One story in four verdicts: the document I wrote is the same document read
 * through a different door, it is still the same document — down to its block
 * identities — after the cell died and rehydrated, and the SPARQL face knows
 * about it. The service family (S1) has no slot in the ratified `test_invariant`
 * enum, so it rides the face-coherence ids and is discriminated by `verdict_code`.
 *
 * Three-valued by construction: `pass | fail | inconclusive`, and only the first
 * two become verdict records. The contract has no inconclusive verdict, and a
 * `fail` emitted for a spot kill would poison the metric — so silence is correct.
 *
 * TWO GRAPHS, and the sandbox only ever touches one. `sutGraph` is the
 * disposable system under test: every beat below runs against it, the payload
 * and the findings ledger are written into it, and it may be thrown away and
 * recreated between runs. `recordGraph` is declared here so the pin is visible in
 * the portable program source, but the sandbox holds no capability against it and
 * cannot write it — the record is filed host-side after this program returns
 * (`service-record.ts`). G0 §4.4(d): the graph is a projection, not a side
 * effect, and an editor grant on the durable record never enters a sandbox.
 */
export const SERVICE_BATTERY_SCRIPT = `export const meta = {
	name: "service-battery-durability-v1",
	description: "Replay a graph-stored Garden service scenario across the MCP and HTTP doors and judge cross-door echo, cross-incarnation durability, block identity and SPARQL projection.",
	whenToUse: "Use for obs-svc-* battery cadence runs, on a cadence longer than the cell idle TTL, against a graph exclusive to the battery.",
	executor: "dumb",
	execution: {
		schema: "choreograph.execution-binding.v1",
		controller: "program",
		modelUse: "none",
		isolation: "sandbox",
		effects: "capability-bound",
		reproducibility: "recorded-external",
		runtime: { kind: "node" },
		capabilities: ["mcp", "http"],
		authority: { minimumRole: "editor", dangerousOps: false },
		mayInvokeChildren: false,
	},
	inputs: {
		type: "object",
		additionalProperties: false,
		required: ["scenario", "digest", "sutGraph", "recordGraph"],
		properties: {
			scenario: { type: "object" },
			digest: { type: "string", pattern: "^[0-9a-f]{64}$" },
			sutGraph: { type: "string", pattern: "^obs-svc-[A-Za-z0-9._-]+$" },
			recordGraph: { enum: ["observatory"] },
		},
	},
	outputs: {
		type: "object",
		additionalProperties: false,
		required: ["schema", "scenarioId", "scenarioDigest", "status", "beats", "verdicts", "inconclusive", "ledger"],
		properties: {
			schema: { const: "sophia.service.battery-result.v1" },
			scenarioId: { type: "string" },
			scenarioDigest: { type: "string" },
			status: { enum: ["passed", "failed", "inconclusive"] },
			beats: { type: "array" },
			verdicts: { type: "array" },
			inconclusive: { type: "array" },
			nextExpected: { type: "object" },
			ledger: { type: "object" },
			// Attached by the host after the sandbox returns: whether the run's
			// judgment reached the record graph. Declared but never required, because
			// the program cannot produce it and must validate without it.
			record: { type: "object" },
		},
	},
}

const scenario = args.scenario
const byBeat = {}
const beats = []
const inconclusive = []
const deferredFindings = []

// Every shape below means "the fleet moved, not the face": a transport failure, a
// gateway activation, or a 5xx. None of them is a statement about the document,
// so none of them may become a verdict.
const INCONCLUSIVE_ERROR = /timed out|timeout|graph_activating|econnreset|socket hang up|epipe|etimedout|\\b(?:202|425|429|502|503|504)\\b/i

// The MCP door answers with a CallToolResult envelope and the HTTP face with a
// plain projection record. Scenario refs are written against the envelope, so the
// only normalization is to fill in a structuredContent a text-only cell omitted.
const jsonText = (value) => {
	if (!value || !Array.isArray(value.content)) return undefined
	const text = value.content.map((part) => (part && typeof part.text === "string" ? part.text : "")).join("\\n").trim()
	if (!text) return undefined
	try { return JSON.parse(text) } catch { return undefined }
}
const normalizeValue = (value) => {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return value
	if (value.structuredContent !== undefined) return value
	const parsed = jsonText(value)
	return parsed === undefined ? value : { ...value, structuredContent: parsed }
}
const structured = (value) => (value && value.structuredContent !== undefined ? value.structuredContent : value)
const blockIdsOf = (value) => {
	const payload = structured(value)
	if (!payload || typeof payload !== "object") return null
	if (Array.isArray(payload.block_ids)) return payload.block_ids
	if (Array.isArray(payload.blockIds)) return payload.blockIds
	return null
}

const httpStatus = (action, value) =>
	action.capability === "http" && value && Number.isInteger(value.status) ? value.status : undefined

const classify = (action, settled) => {
	if (!settled.ok) return INCONCLUSIVE_ERROR.test(String(settled.error || "")) ? "inconclusive" : "error"
	const status = httpStatus(action, settled.value)
	if (status === 202) return "inconclusive"
	if (status !== undefined && status >= 500) return "inconclusive"
	return "ok"
}

// A closed reason vocabulary. Reasons are recorded in the run output, so they may
// never carry an observed byte.
const reasonFor = (record) => {
	if (!record) return "missing"
	if (record.class === "ok") return "ok"
	if (record.ok) {
		if (record.status === 202) return "graph_activating"
		if (record.status !== undefined && record.status >= 500) return "server_error"
		return "unexpected_status"
	}
	const text = String(record.error || "")
	if (/graph_activating/i.test(text)) return "graph_activating"
	if (/timed out|timeout|etimedout/i.test(text)) return "timeout"
	if (INCONCLUSIVE_ERROR.test(text)) return "transport"
	return "call_error"
}

const runAction = async (action, overrides) => {
	// Only an INCONCLUSIVE attempt is re-tried, and never past the scenario's
	// licence. There is no sleep primitive in this sandbox, so a retry is a tight
	// loop: a second attempt against a 202 is a probe, a third would be a storm.
	const retries = Number.isInteger(action.retries) ? action.retries : 0
	const callArgs = overrides ? { ...action.args, ...overrides } : action.args
	const startedAt = Date.now()
	let attempts = 0
	let settled = { ok: false, error: "not attempted" }
	let outcome = "inconclusive"
	while (attempts <= retries) {
		attempts += 1
		try {
			const value = await invoke({ capability: action.capability, tool: action.tool, args: callArgs })
			settled = { ok: true, value: normalizeValue(value) }
		} catch (error) {
			settled = { ok: false, error: String((error && error.message) || error) }
		}
		outcome = classify(action, settled)
		if (outcome !== "inconclusive") break
	}
	const endedAt = Date.now()
	return {
		capability: action.capability,
		tool: action.tool,
		ok: settled.ok === true,
		value: settled.ok ? settled.value : undefined,
		error: settled.ok ? undefined : settled.error,
		class: outcome,
		status: settled.ok ? httpStatus(action, settled.value) : undefined,
		startedAt,
		endedAt,
		durationMs: endedAt - startedAt,
		attempts,
	}
}

const runBeat = async (beat, overridesFor) => {
	const startedAt = Date.now()
	const actions = []
	for (const action of beat.actions) {
		actions.push(await runAction(action, overridesFor ? overridesFor(action) : undefined))
	}
	const endedAt = Date.now()
	const record = { id: beat.id, operation: beat.operation, startedAt, endedAt, durationMs: endedAt - startedAt, actions }
	beats.push(record)
	byBeat[beat.id] = record
	return record
}

await journey(scenario.beats, async (beat) => {
	phase(beat.id + ":" + beat.operation)
	if (beat.operation === "findings") {
		// The ledger can only be written once the verdicts exist, and its failure is
		// never the campaign's failure. Defer it out of the judged beat sequence.
		deferredFindings.push(beat)
		return
	}
	await runBeat(beat)
}, { modelUse: "none" })

// B0 is the liveness gate. Without it every downstream classification is a guess
// about a cell that may not have been there, so the run says nothing at all.
const wake = beats.find((beat) => beat.operation === "wake")
const live = wake ? wake.actions.every((action) => action.class === "ok") : false

const scenarioValue = (path) => {
	if (path === "payload.content") return scenario.payload ? scenario.payload.content : undefined
	if (path === "expected.content") return scenario.expected ? scenario.expected.content : undefined
	if (path === "expected.blockIds") return scenario.expected ? scenario.expected.blockIds : undefined
	return undefined
}

const resolve = (ref) => {
	if (ref && typeof ref.scenarioPath === "string") {
		const value = scenarioValue(ref.scenarioPath)
		return { kind: "scenario", scenarioPath: ref.scenarioPath, class: value === undefined ? "missing" : "ok", value }
	}
	const beat = ref ? byBeat[ref.beat] : undefined
	const action = beat ? beat.actions[(ref && ref.action) || 0] : undefined
	if (!action) return { kind: "beat", beat: ref ? ref.beat : "", class: "missing", reason: "missing", value: undefined }
	let value = action
	for (const part of String((ref && ref.path) || "value").split(".")) value = value == null ? value : value[part]
	return { kind: "beat", beat: ref.beat, class: action.class, status: action.status, reason: reasonFor(action), value }
}

const markdown = (value) => String(value == null ? "" : value).replace(/\\r\\n/g, "\\n").split("\\n").map((line) => line.replace(/\\s+$/g, "")).join("\\n").trim() + "\\n"
const idList = (value) => (Array.isArray(value) ? JSON.stringify([...value].map(String).sort()) : null)

const compare = (check, normalize) => {
	const sides = [resolve(check.left), resolve(check.right)]
	// Does this invariant assert the PRIOR incarnation's state? That is what makes
	// a 404 decisive rather than merely unexpected.
	const priorLeg = sides.some((side) => side.kind === "scenario" && side.scenarioPath.indexOf("expected.") === 0)
	for (const side of sides) {
		if (side.kind === "scenario") {
			if (side.class !== "ok") return { result: "inconclusive", reason: "not_licensed" }
			continue
		}
		// A denial is an authority question, a transport failure is the fleet, and
		// an activation is a cell coming back. None is a face defect.
		if (side.class !== "ok") return { result: "inconclusive", beat: side.beat, reason: side.reason }
		if (side.status !== undefined) {
			// A live cell answering "that document does not exist" about the previous
			// incarnation's payload is a decisive read, and it is the flagship
			// durability defect. A routing or authority 404 would have failed B0 too.
			if (side.status === 404 && priorLeg) return { result: "fail", suffix: "missing", beat: side.beat }
			if (side.status !== 200) return { result: "inconclusive", beat: side.beat, reason: "unexpected_status" }
		}
	}
	if (sides[0].value == null || sides[1].value == null) return { result: "inconclusive", reason: "unresolved" }
	const left = normalize(sides[0].value)
	const right = normalize(sides[1].value)
	if (left === null || right === null) return { result: "inconclusive", reason: "unresolved" }
	const passed = left === right
	return { result: passed ? "pass" : "fail", suffix: passed ? "pass" : "fail" }
}

const projection = (check) => {
	const from = byBeat[check.fromBeat]
	const to = byBeat[check.toBeat]
	if (!from || !to) return { result: "inconclusive", reason: "unresolved" }
	for (const beat of [from, to]) {
		const failed = beat.actions.find((action) => action.class !== "ok")
		// An uncertain write makes the projection question vacuous: the document
		// node may be the PREVIOUS run's. Silence rather than a hollow pass.
		if (failed) return { result: "inconclusive", beat: beat.id, reason: reasonFor(failed) }
	}
	const side = resolve(check.ref)
	if (side.class !== "ok") return { result: "inconclusive", beat: side.beat, reason: side.reason }
	const rows = Array.isArray(side.value) ? side.value : null
	if (rows === null) return { result: "inconclusive", beat: side.beat, reason: "unresolved" }
	const lagMs = Math.max(0, to.endedAt - from.endedAt)
	if (rows.length < check.minRows) {
		// An empty result the cell itself flagged is a statement about the QUERY,
		// not about the platform. The cell emits a warning when a pattern could not
		// have matched — e.g. no GRAPH clause against a named-graph-partitioned
		// store, where the default graph holds nothing and the query returns 0 rows
		// in milliseconds. Reading that as projection_missing is how this
		// invariant reported a healthy cell as broken on 2026-08-05.
		//
		// NB: this body is a template literal (see SERVICE_BATTERY_SCRIPT) — no
		// backticks and no dollar-brace anywhere inside it.
		//
		// Defer to the diagnosis rather than overrule it: an instrument that
		// discards the readings it does not expect is not measuring anything.
		const warned = resolve(check.warnRef)
		if (warned.class === "ok" && Array.isArray(warned.value) && warned.value.length > 0) {
			return { result: "inconclusive", beat: side.beat, reason: "projection_query_rejected" }
		}
		return { result: "fail", suffix: "missing", observedMs: lagMs, maximumMs: check.maxMs }
	}
	if (lagMs > check.maxMs) return { result: "fail", suffix: "slow", observedMs: lagMs, maximumMs: check.maxMs }
	return { result: "pass", suffix: "pass", observedMs: lagMs, maximumMs: check.maxMs }
}

// Content survival age: how long this payload has been sitting in the durable
// plane. It anchors the Observatory join that proves a reap intervened.
const survivalMs = () => {
	if (!scenario.expected || !Number.isInteger(scenario.expected.writtenAtMs)) return undefined
	return Math.max(0, Date.now() - scenario.expected.writtenAtMs)
}

const verdicts = []
if (!live) {
	inconclusive.push({ beat: wake ? wake.id : "wake", reason: wake ? reasonFor(wake.actions.find((action) => action.class !== "ok")) : "missing" })
} else {
	for (const check of scenario.invariants) {
		let outcome
		if (check.id === "I1" && check.kind === "markdown_equal") outcome = compare(check, markdown)
		else if (check.id === "I4" && check.kind === "block_identity") outcome = compare(check, idList)
		else if (check.id === "I5" && check.kind === "projection_latency") outcome = projection(check)
		else outcome = { result: "inconclusive", reason: "unsupported_invariant" }
		if (outcome.result === "inconclusive") {
			// The contract has no inconclusive verdict, and a fail emitted for a spot
			// kill would poison the metric. An undecided reading therefore leaves NO
			// verdict record — only a bounded reason in the run output.
			inconclusive.push({ invariant: check.id, code: check.code, reason: outcome.reason || "unresolved", ...(outcome.beat ? { beat: outcome.beat } : {}) })
			continue
		}
		const priorLeg = check.id !== "I5" && [check.left, check.right].some((ref) => ref && typeof ref.scenarioPath === "string" && ref.scenarioPath.indexOf("expected.") === 0)
		const observedMs = outcome.observedMs !== undefined ? outcome.observedMs : (priorLeg ? survivalMs() : undefined)
		verdicts.push({
			invariant: check.id,
			code: check.code,
			result: outcome.result,
			verdictCode: check.code + "_" + outcome.suffix,
			...(observedMs === undefined ? {} : { observedMs }),
			...(outcome.maximumMs === undefined ? {} : { maximumMs: outcome.maximumMs }),
		})
	}
}

// A run that asserted nothing did not pass.
const status = verdicts.some((verdict) => verdict.result === "fail")
	? "failed"
	: (!live || inconclusive.length > 0 || verdicts.length === 0)
		? "inconclusive"
		: "passed"

// The state run k+1 will be handed as its expectation. It exists only when THIS
// run's cross-door echo passed, which is what makes the next run's durability
// question answerable at all.
const echoCheck = scenario.invariants.find((check) => check.kind === "markdown_equal" && check.left && check.left.scenarioPath === "payload.content")
const echoVerdict = echoCheck ? verdicts.find((verdict) => verdict.code === echoCheck.code) : undefined
const echoBeat = echoCheck && echoCheck.right && echoCheck.right.beat ? byBeat[echoCheck.right.beat] : undefined
const echoAction = echoBeat ? echoBeat.actions[(echoCheck.right && echoCheck.right.action) || 0] : undefined
const writeBeat = beats.find((beat) => beat.operation === "write")
const recordBeat = beats.find((beat) => beat.operation === "record-ids")
const readBackIds = (beat) => {
	if (!beat) return null
	const action = beat.actions.find((item) => item.class === "ok" && blockIdsOf(item.value) !== null)
	return action ? blockIdsOf(action.value) : null
}
const nextBlockIds = readBackIds(recordBeat) || readBackIds(writeBeat)
let nextExpected
if (
	echoVerdict && echoVerdict.result === "pass" &&
	echoAction && echoAction.value && typeof echoAction.value.bodySha256 === "string" &&
	nextBlockIds && nextBlockIds.length > 0 && writeBeat
) {
	nextExpected = {
		runId: scenario.runId,
		payloadDocumentId: scenario.payloadDocumentId,
		payloadSha256: echoAction.value.bodySha256,
		blockIds: nextBlockIds.map(String),
		writtenAtMs: writeBeat.endedAt,
	}
}

// Observed content never leaves the sandbox. The projection carries coordinates,
// classifications and bounded integers only.
const projectBeats = () => beats.map((beat) => ({
	id: beat.id,
	operation: beat.operation,
	durationMs: beat.durationMs,
	actions: beat.actions.map((action) => ({
		ok: action.ok,
		class: action.class,
		durationMs: action.durationMs,
		attempts: action.attempts,
		...(action.status === undefined ? {} : { status: action.status }),
	})),
}))

const ledgerMarkdown = [
	"# Sophia service battery findings " + scenario.runId,
	"",
	"Scenario: " + scenario.id,
	"Digest: " + args.digest,
	"Mode: " + (scenario.expected ? "verify" : "seed"),
	"Status: " + status,
	"",
	"## Verdicts",
	JSON.stringify(verdicts, null, 2),
	"",
	"## Inconclusive",
	JSON.stringify(inconclusive, null, 2),
	"",
	"## Beats",
	JSON.stringify(projectBeats(), null, 2),
].join("\\n")

let ledger = { status: "skipped", sutGraph: args.sutGraph }
for (const beat of deferredFindings) {
	const first = beat.actions[0] || {}
	const documentId = String((first.args && first.args.documentId) || "")
	try {
		const record = await runBeat(beat, (action) => (action.tool === "write_document" ? { content: ledgerMarkdown } : undefined))
		const failed = record.actions.find((action) => action.class !== "ok")
		ledger = failed
			? { status: "error", sutGraph: args.sutGraph, documentId, reason: reasonFor(failed) }
			: { status: "written", sutGraph: args.sutGraph, documentId }
	} catch (error) {
		ledger = { status: "error", sutGraph: args.sutGraph, documentId, reason: "call_error" }
	}
}

return {
	schema: "sophia.service.battery-result.v1",
	scenarioId: scenario.id,
	scenarioDigest: args.digest,
	status,
	beats: projectBeats(),
	verdicts,
	inconclusive,
	...(nextExpected === undefined ? {} : { nextExpected }),
	ledger,
}
`;

export function buildServiceBatteryWorkflowInputs(body: unknown, graphId: string): WorkflowRunInputs {
	return buildServiceBatteryInputs(body, graphId);
}
