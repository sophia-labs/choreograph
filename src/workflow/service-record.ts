import type { GraphWriter } from "./graph-writer.js";
import type { InvocationErrorEnvelope } from "./invocation.js";
import { SERVICE_BATTERY_RESULT_SCHEMA } from "./script-service-battery.js";
import type { ServiceInvariantId } from "./service-battery.js";
import { SERVICE_INVARIANTS } from "./service-battery.js";
import { iri, str, xsdBool, xsdDateTime, xsdInt } from "./vocab.js";

/**
 * The durable record of a Garden service battery run, as attributed testimony in
 * a named graph inside the RECORD graph.
 *
 * The battery has two graphs and they are not interchangeable. `sutGraph` is the
 * disposable system under test — the battery writes payload documents into it,
 * lets a cell die on top of it, and may throw the whole graph away. `recordGraph`
 * is where the run's judgment is filed, and it must survive exactly the events
 * the SUT is expected not to. Filing the record into the graph under test would
 * mean the durability question and its answer share a fate, which is not a test.
 *
 * This is the second face of the same testimony, not an alternative to the first.
 * `service-testimony.ts` projects the same verdicts into `test.verdict`
 * CaptureEvents; the Observatory metric packs join on those. The stream is a
 * lossy 72-hour echo (`emitCaptureSoft` returns void, suppresses every error and
 * drops newest under queue pressure); this named graph is the part that is still
 * there next month. Both are emitted on every run.
 */

/** `http://mnemosyne.dev/battery#` — the `bat:` vocabulary G0 §2.1 registers. */
export const BAT = "http://mnemosyne.dev/battery#";
export const PROV = "http://www.w3.org/ns/prov#";
export const XSD = "http://www.w3.org/2001/XMLSchema#";

/**
 * The witness. Role-grained, not instance-grained: every service battery run on
 * every host speaks as the same agent, because the analytically interesting
 * disagreement is between the battery and the service, never between two
 * executors of the same script. G0 §8 makes the same call for the hoja swarm.
 */
export const SERVICE_WITNESS_AGENT = "urn:sophia:agent:service-battery";

/**
 * The identity recipe actually used for the digests this record cites.
 * `sophia.battery.canon.v1` (RFC 8785 + a restricted domain) is G0 §3.2 and is
 * NOT implemented — `agent-subject/canonical-json.ts` sorts keys but coerces
 * `NaN`/`Infinity` to null and leans on JS number rendering. Naming the profile
 * we really used is what lets a later reader tell an interim digest from a
 * canon-v1 one instead of silently comparing two different functions.
 */
export const SERVICE_CANON_PROFILE = "choreograph.canonical-json.v0";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GRAPH_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** `IDENTIFIER_PATTERN`, observatory-capture.ts — the same axis the events ride. */
const VERDICT_CODE = /^[a-z][a-z0-9_.-]{0,63}$/;
const BATTERY_OUTCOMES = ["passed", "failed", "inconclusive"] as const;

/**
 * A single named graph per witness, a sibling of G0 §2.2's
 * `…:observatory:testimony:hoja-swarm`, following the same
 * `{graph root}:testimony:{witness agent slug}` convention.
 *
 * `rdf_authority.rs` reserves the graph root, `{root}:projection:*` and
 * `urn:mnemosyne:local:profile:*` and refuses writes there;
 * `user_rdf_target_graph_iri` passes any other IRI through verbatim. `:testimony:`
 * is therefore writable and is already the established lane for attributed
 * claims. The membrane exists so the battery's testimony is attributable to the
 * battery rather than mixed into `observatory`'s general assertions — a reader
 * can drop this one graph and lose exactly the battery's opinions and nothing
 * else, which is what makes the claims defeasible in practice and not just in
 * doctrine.
 *
 * G0 splits the hoja swarm's membrane into seven sub-membranes, one per stratum.
 * The service battery has exactly one stratum — a mechanical prober, no visual
 * evaluator and no reflector — so a `:l0-prober` suffix here would be a
 * distinction with nothing on the other side of it. If the service family ever
 * grows a second stratum, that is when it earns a sub-membrane.
 */
export function serviceTestimonyGraphIri(recordGraph: string): string {
	return `urn:mnemosyne:local:graph:${recordGraph}:testimony:service-battery`;
}

export function serviceRunSubject(runId: string): string {
	return `urn:sophia:battery:run:${runId}`;
}

export function serviceVerdictSubject(runId: string, verdictCode: string): string {
	return `urn:sophia:battery:verdict:${runId}:${verdictCode}`;
}

export type ServiceRecordStatus = "written" | "error" | "unavailable";

/**
 * A closed reason vocabulary, exactly as the run's own inconclusive ledger keeps
 * one. Reasons are written into the run output, so they may never carry a
 * provider message: the operator-facing text lives in the invocation error
 * envelope, which is host telemetry and not testimony.
 */
export type ServiceRecordReason = "no_writer" | "unrecordable" | "denied" | "timeout" | "transport" | "call_error";

export interface ServiceRecordOutcome {
	readonly status: ServiceRecordStatus;
	readonly recordGraph: string;
	readonly namedGraph: string;
	readonly runSubject: string;
	/** Decisive verdicts filed as `bat:Verdict` claims. */
	readonly claimCount: number;
	readonly reason?: ServiceRecordReason;
}

export interface SerializedServiceRecord {
	readonly sparql: string;
	readonly namedGraph: string;
	readonly runSubject: string;
	readonly claimCount: number;
}

export interface ServiceRecordInput {
	readonly recordGraph: string;
	readonly sutGraph: string;
	readonly runId: string;
	readonly workflowName: string;
	readonly output: unknown;
	/** When the run began observing — the host clock at run start. */
	readonly observedAtMs: number;
	/** When this record was filed. */
	readonly filedAtMs: number;
}

/**
 * Serialize one completed battery result as attributed testimony, or return
 * `undefined` for output that is not a battery result or whose coordinates do
 * not survive the fence — the same guard idiom `service-testimony.ts` uses, so a
 * foreign program's output cannot mint battery subjects.
 *
 * Content discipline is identical to the CaptureEvent projection: coordinates,
 * classifications and bounded integers only. The payload text, the block
 * identities, the payload sha256 in `nextExpected` and every error string stay
 * where they were observed. A durable graph is a worse place to leak them than a
 * 72-hour window, not a better one.
 */
export function serializeServiceBatteryRecord(input: ServiceRecordInput): SerializedServiceRecord | undefined {
	if (!isServiceBatteryResult(input.output)) return undefined;
	const output = record(input.output) as Record<string, unknown>;
	const recordGraph = graphId(input.recordGraph);
	const sutGraph = graphId(input.sutGraph);
	const runId = opaque(input.runId);
	const scenarioId = opaque(output.scenarioId);
	const outcome = batteryOutcome(output.status);
	if (!recordGraph || !sutGraph || !runId || !scenarioId || !outcome) return undefined;
	const observedAt = epochMs(input.observedAtMs);
	const filedAt = epochMs(input.filedAtMs);
	if (observedAt === undefined || filedAt === undefined) return undefined;

	const namedGraph = serviceTestimonyGraphIri(recordGraph);
	const runSubject = serviceRunSubject(runId);
	const witness = iri(SERVICE_WITNESS_AGENT);
	const verdicts = array(output.verdicts) ?? [];
	const claims: string[] = [];

	for (const value of verdicts) {
		const verdict = record(value);
		const invariant = serviceInvariant(verdict?.invariant);
		const verdictCode = identifier(verdict?.verdictCode);
		const passed = decisive(verdict?.result);
		// An undecided invariant left a bounded reason in the run output and files
		// no claim, for the same reason it emits no event: the contract has no
		// inconclusive verdict, and a fail recorded for a spot-instance kill would
		// still be a fail a year from now.
		if (!invariant || !verdictCode || passed === undefined) continue;
		const observedMs = safeNonnegativeInteger(verdict?.observedMs);
		const maximumMs = safeNonnegativeInteger(verdict?.maximumMs);
		claims.push(
			subject(serviceVerdictSubject(runId, verdictCode), [
				["a", "bat:Verdict"],
				["bat:partOfRun", iri(runSubject)],
				["bat:witnessAgent", witness],
				["prov:wasAttributedTo", witness],
				["bat:invariant", str(invariant)],
				["bat:verdictCode", str(verdictCode)],
				["bat:passed", xsdBool(passed)],
				// The SUT graph stands in for `bat:Sut` (G0 §4.3), which hashes a full
				// environment manifest this slice does not compute. It is the one part
				// of the condition the run genuinely knows.
				["bat:sutGraph", str(sutGraph)],
				["bat:observedAt", xsdDateTime(observedAt)],
				["bat:filedAt", xsdDateTime(filedAt)],
				...(observedMs === undefined ? [] : ([["bat:observedMs", xsdInt(observedMs)]] as Pair[])),
				...(maximumMs === undefined ? [] : ([["bat:maximumMs", xsdInt(maximumMs)]] as Pair[])),
			]),
		);
	}

	const digest = sha256(output.scenarioDigest);
	const findingsDocument = ledgerDocument(output.ledger);
	const runTriples: Pair[] = [
		["a", "bat:Run"],
		// The lifecycle fold (G0 §2.4), not the judgment: this run reached its end.
		["bat:runState", str("complete")],
		["bat:witnessAgent", witness],
		["prov:wasAttributedTo", witness],
		["bat:workflowName", str(input.workflowName)],
		["bat:runId", str(runId)],
		["bat:scenarioId", str(scenarioId)],
		// The three-valued judgment. `inconclusive` is a real and frequent answer,
		// and a record that could not say it would push the battery back to two
		// values and a lying metric.
		["bat:outcome", str(outcome)],
		["bat:sutGraph", str(sutGraph)],
		["bat:verdictCount", xsdInt(claims.length)],
		["bat:inconclusiveCount", xsdInt((array(output.inconclusive) ?? []).length)],
		["bat:beatCount", xsdInt((array(output.beats) ?? []).length)],
		["bat:observedAt", xsdDateTime(observedAt)],
		["bat:filedAt", xsdDateTime(filedAt)],
	];
	// The exact bytes replayed, hashed. G0 §3.3 keeps this distinct from scenario
	// IDENTITY, which is computed over a stable projection and is not implemented
	// here; calling it `submissionSha256` is the difference between the two names
	// being load-bearing rather than decorative.
	if (digest) {
		runTriples.push(["bat:submissionSha256", str(digest)], ["bat:canonProfile", str(SERVICE_CANON_PROFILE)]);
	}
	if (findingsDocument) runTriples.push(["bat:findingsDocument", str(findingsDocument)]);

	const body = [
		// The membrane describes itself, following the convention already
		// implemented for memory membranes: a reader that finds this graph can tell
		// whose account it is without consulting anything outside it.
		subject(namedGraph, [
			["a", "prov:Entity, bat:PerspectiveGraph"],
			["prov:wasAttributedTo", witness],
		]),
		subject(runSubject, runTriples),
		...claims,
	].join("\n");

	const sparql = [
		`PREFIX bat: <${BAT}>`,
		`PREFIX prov: <${PROV}>`,
		`PREFIX xsd: <${XSD}>`,
		"INSERT DATA {",
		`\tGRAPH <${namedGraph}> {`,
		body,
		"\t}",
		"}",
	].join("\n");

	return { sparql, namedGraph, runSubject, claimCount: claims.length };
}

export interface ServiceRecordDeps {
	/**
	 * Resolve a writer bound to the RECORD graph's own cell. Under gateway
	 * service-auth the `graphId` tool argument is stripped and routing comes from
	 * the owner-scoped proxy URL, so passing `"observatory"` to the SUT-bound
	 * writer would quietly write the SUT. The seam has to be a second binding.
	 */
	readonly recordWriterFor?: (graphId: string) => Promise<GraphWriter>;
}

/**
 * File the record, and report honestly whether it landed.
 *
 * Returns `undefined` for output that is not a battery result, so every other
 * program workflow is untouched.
 */
export async function fileServiceBatteryRecord(
	deps: ServiceRecordDeps,
	input: ServiceRecordInput,
): Promise<ServiceRecordOutcome | undefined> {
	// Only output that is not a battery result at all is a genuine no-op.
	if (!isServiceBatteryResult(input.output)) return undefined;
	const serialized = serializeServiceBatteryRecord(input);
	if (!serialized) {
		// A battery result the fence cannot address is NOT a no-op. Returning
		// `undefined` here would report a green run over an empty graph again, this
		// time arriving through a malformed input rather than a refused write —
		// the same lie by a different door.
		return {
			status: "error",
			recordGraph: input.recordGraph,
			namedGraph: serviceTestimonyGraphIri(input.recordGraph),
			runSubject: serviceRunSubject(input.runId),
			claimCount: 0,
			reason: "unrecordable",
		};
	}
	const base = {
		recordGraph: input.recordGraph,
		namedGraph: serialized.namedGraph,
		runSubject: serialized.runSubject,
		claimCount: serialized.claimCount,
	};
	if (!deps.recordWriterFor) return { ...base, status: "unavailable", reason: "no_writer" };
	try {
		const writer = await deps.recordWriterFor(input.recordGraph);
		// ── INTERIM WRITE SITE ────────────────────────────────────────────────
		// This direct `sparql_update` is the interim form and is meant to be
		// deleted. G0 (the battery record spec §2.0, §4.4d, kept outside this repository)
		// puts a witness-owned, hash-chained commit log in front of the graph and
		// makes a BATTERY SCRIBE the sole writer: the runner commits an envelope,
		// the scribe folds committed envelopes into desired state and diffs it
		// into the graph, and "there is no path where the runner writes the graph
		// directly" (§8). None of that is built, so slice 1 writes the graph
		// itself rather than leaving the run's judgment in a 72-hour event window.
		//
		// The replacement must be a deletion, not a migration. When the scribe
		// lands it writes THIS named graph — `…:{recordGraph}:testimony:service-battery`
		// — with THESE shapes: the `bat:` vocabulary, `bat:Run` + `bat:Verdict`,
		// the same predicates, the same witness agent, the same content
		// discipline. Two things it will do differently, named here so nobody
		// discovers them by surprise:
		//   1. Subject identity. G0 §2.4 mints claims at
		//      `urn:sophia:battery:claim:sha256:{d}` over
		//      pointDigest|witness|runSlug|sutDigest|value|observedAt|evidence.
		//      Slice 1 computes no `bat:Point` and no `bat:Sut`, so it files
		//      logical-id subjects instead. The scribe's rebuild computes desired
		//      state for this whole named graph and diffs, so these interim
		//      subjects are swept by the first rebuild rather than lingering as
		//      duplicates.
		//   2. `bat:sealRef`. G0 requires a seal reference on every testimony
		//      claim, naming the commit envelope it came from. There is no commit
		//      log yet, so there is no seal, and inventing one would be the exact
		//      false testimony the whole design exists to prevent. These rows are
		//      therefore expected to fail `battery_conformance` and to be filed as
		//      violations — which is the correct visible outcome for testimony
		//      written before its fence existed.
		//
		// Mechanics that must hold for this call to land where it says it does:
		// `scopeUpdateToUserRdfGraph` wraps a bare `INSERT DATA` in the cell's
		// `…:user:rdf` graph, and returns the update UNCHANGED when it already
		// carries a literal `GRAPH <…>` clause. Ours always does, so the testimony
		// membrane is the target and not the general user-RDF lane. The cell reads
		// only camelCase `{ graphId, update }`; `GraphWriter.sparqlUpdate` sends
		// exactly that.
		await writer.sparqlUpdate(input.recordGraph, serialized.sparql);
		return { ...base, status: "written" };
	} catch (error) {
		return { ...base, status: "error", reason: classifyRecordError(error) };
	}
}

/**
 * The run's verdict on its own recording.
 *
 * A battery that judged the service and could not file the judgment has done
 * half its job, and the half it skipped is the durable half. G0 §2.0 states the
 * rule this implements and states it so it cannot be quietly walked back:
 * nothing reports success until the record is acknowledged. So the run FAILS.
 *
 * Two things that failure deliberately is not:
 *
 * It is not a verdict about Garden. The `test.verdict` CaptureEvents were
 * already emitted, unchanged, before this ran; the metric packs see exactly what
 * the battery observed. The error code names the record path, the run output
 * still carries every verdict, and no `fail` is invented for an invariant that
 * passed. A record failure that showed up as a Garden defect would poison the
 * same metric the three-valued design exists to protect.
 *
 * It is not silence either, which was the tempting alternative: a `note` on a
 * completed run is exactly the shape nobody reads, and the resulting state —
 * green runs, empty graph — is the failure mode that reads as success. This
 * campaign already has one of those (a battery emitting no testimony shows up as
 * empty Observatory metrics, not failing ones), and one is enough.
 *
 * `unavailable` fails too. A deployment with no record writer bound has not
 * configured the battery, it has configured half of it, and half of it passing
 * quietly is how you end up trusting a record that was never being written.
 */
export function serviceRecordFailure(outcome: ServiceRecordOutcome | undefined): InvocationErrorEnvelope | undefined {
	if (!outcome || outcome.status === "written") return undefined;
	const code = outcome.status === "unavailable" ? "record_write_unavailable" : "record_write_failed";
	const message =
		outcome.status === "unavailable"
			? `the service battery record graph '${outcome.recordGraph}' has no bound writer; the run's verdicts were judged but not filed`
			: outcome.reason === "unrecordable"
				? `the service battery result could not be addressed to a record in '${outcome.recordGraph}'; the run's verdicts were judged but not filed`
				: `writing the service battery record to '${outcome.namedGraph}' failed (${outcome.reason}); the run's verdicts were judged but not filed`;
	return {
		code,
		message,
		details: {
			recordGraph: outcome.recordGraph,
			namedGraph: outcome.namedGraph,
			runSubject: outcome.runSubject,
			claimCount: outcome.claimCount,
			...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
		},
	};
}

/**
 * Classify a writer rejection into the closed reason vocabulary. The shapes are
 * the ones `HostedMnemosyneProxy` actually produces: a 401/403 is rethrown
 * immediately under service-auth (no refresh retry), control-plane failures carry
 * their HTTP status and body, and timeouts are explicit.
 */
function classifyRecordError(error: unknown): ServiceRecordReason {
	const text = String((error as { message?: unknown })?.message ?? error ?? "");
	if (/\b(?:401|403)\b|denied|forbidden|unauthor/i.test(text)) return "denied";
	if (/timed out|timeout|etimedout/i.test(text)) return "timeout";
	if (/graph_activating|econnreset|socket hang up|epipe|\b(?:202|425|429|502|503|504)\b/i.test(text)) {
		return "transport";
	}
	return "call_error";
}

/**
 * The one thing that makes a run this module's business. Kept separate from the
 * rest of the fence so "not a battery result" (a no-op) and "a battery result we
 * cannot address" (a failure) can never be confused for each other.
 */
export function isServiceBatteryResult(output: unknown): boolean {
	return record(output)?.schema === SERVICE_BATTERY_RESULT_SCHEMA;
}

type Pair = readonly [string, string];

function subject(uri: string, triples: readonly Pair[]): string {
	const body = triples.map(([predicate, object]) => `\t\t\t${predicate} ${object}`).join(" ;\n");
	return `\t\t${iri(uri)}\n${body} .`;
}

function decisive(value: unknown): boolean | undefined {
	if (value === "pass") return true;
	if (value === "fail") return false;
	return undefined;
}

function batteryOutcome(value: unknown): string | undefined {
	return typeof value === "string" && (BATTERY_OUTCOMES as readonly string[]).includes(value) ? value : undefined;
}

function ledgerDocument(value: unknown): string | undefined {
	const ledger = record(value);
	if (ledger?.status !== "written") return undefined;
	return opaque(ledger.documentId);
}

function serviceInvariant(value: unknown): ServiceInvariantId | undefined {
	return typeof value === "string" && SERVICE_INVARIANTS.includes(value as ServiceInvariantId)
		? (value as ServiceInvariantId)
		: undefined;
}

function identifier(value: unknown): string | undefined {
	return typeof value === "string" && VERDICT_CODE.test(value) ? value : undefined;
}

function opaque(value: unknown): string | undefined {
	return typeof value === "string" && OPAQUE_ID.test(value) ? value : undefined;
}

function graphId(value: unknown): string | undefined {
	return typeof value === "string" && GRAPH_ID.test(value) ? value : undefined;
}

function sha256(value: unknown): string | undefined {
	return typeof value === "string" && SHA256.test(value) ? value : undefined;
}

function epochMs(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

function safeNonnegativeInteger(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function array(value: unknown): readonly unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}
