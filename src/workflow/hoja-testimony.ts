import type { CaptureEmitter, CaptureIdentity, TestVerdictPayload } from "../observatory-capture.js";
import { emitCaptureSoft } from "../observatory-capture.js";
import type { HojaInvariant, HojaOperation } from "./hoja-swarm.js";
import { HOJA_INVARIANTS, HOJA_OPERATIONS } from "./hoja-swarm.js";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EVIDENCE_URI = /^s3:\/\/[a-z0-9][a-z0-9.-]{2,62}\/[A-Za-z0-9._/@%+=,:~-]{1,1024}$/;

interface ThinEvidenceRef {
	readonly uri: string;
	readonly sha256: string;
}

export interface HojaEvidenceIndexEntry extends ThinEvidenceRef {}

/** Prefer the scenario's durable campaign run id over the transport invocation id. */
export function hojaLogicalRunId(input: unknown, fallback: string): string {
	const args = record(input);
	const scenario = record(args?.scenario);
	return opaque(scenario?.runId) ?? fallback;
}

/**
 * Project a completed Hoja result into content-free CaptureEvents.
 *
 * This intentionally understands only the small result-coordinate surface.
 * Observed values, visual claims, model prose, page content, and capability
 * arguments/results never enter testimony.
 */
export function emitHojaResultTestimony(input: {
	readonly capture?: CaptureEmitter;
	readonly identity: CaptureIdentity;
	readonly runId: string;
	readonly output: unknown;
}): void {
	if (!input.capture) return;
	const output = record(input.output);
	if (output?.schema !== "sophia.hoja.swarm-result.v1") return;
	const runId = opaque(input.runId);
	const scenarioId = opaque(output.scenarioId);
	if (!runId || !scenarioId) return;

	for (const value of array(output.beats) ?? []) {
		const beat = record(value);
		const beatId = opaque(beat?.id);
		const operation = hojaOperation(beat?.operation);
		const actions = array(beat?.actions);
		if (!beatId || !operation || !actions) continue;
		for (const captured of array(beat?.evidence) ?? []) {
			const evidence = record(captured);
			const engine = browserEngine(evidence?.engine);
			const manifest = evidenceRef(evidence?.manifest);
			if (!engine || !manifest) continue;
			emitCaptureSoft(input.capture, {
				kind: "test.beat",
				...input.identity,
				outcome: "ok",
				...duration(beat?.durationMs),
				payload: {
					runId,
					scenarioId,
					beatId,
					engine,
					operation,
					actionCount: actions.length,
					evidenceUri: manifest.uri,
					evidenceSha256: manifest.sha256,
				},
			});
		}
	}

	for (const value of array(output.verdicts) ?? []) {
		const verdict = record(value);
		const invariant = hojaInvariant(verdict?.invariant);
		if (!invariant || typeof verdict?.passed !== "boolean") continue;
		const observed = record(verdict.observed);
		emitVerdict(input, {
			runId,
			scenarioId,
			invariant,
			passed: verdict.passed,
			verdictCode: verdict.passed ? "mechanical_pass" : "mechanical_fail",
			...(invariant === "I5" ? boundedTiming(observed) : {}),
		});
	}

	for (const value of array(output.evaluations) ?? []) {
		const evaluation = record(value);
		const beatId = opaque(evaluation?.beatId);
		const completion = record(evaluation?.evaluation);
		const result = record(completion?.result);
		const verdict = result?.verdict;
		if (!beatId || (verdict !== "pass" && verdict !== "anomaly")) continue;
		const ref = evidenceRef(record(evaluation?.diff)?.diff) ?? firstEvidenceRef(evaluation?.evidence);
		emitVerdict(input, {
			runId,
			scenarioId,
			invariant: "L1",
			passed: verdict === "pass",
			verdictCode: verdict === "pass" ? "visual_pass" : "visual_anomaly",
			beatId,
			...(ref ? { evidenceUri: ref.uri, evidenceSha256: ref.sha256 } : {}),
		});
	}

	const reflections = array(output.reflections) ?? [];
	for (const [index, invariant] of (["L2-primary", "L2-foreign"] as const).entries()) {
		const completion = record(reflections[index]);
		const passed = record(completion?.result) !== undefined;
		emitVerdict(input, {
			runId,
			scenarioId,
			invariant,
			passed,
			verdictCode: passed ? "reflection_complete" : "reflection_missing",
		});
	}
}

/**
 * Build the bounded private-evidence allowlist stored with the run journal.
 *
 * The evidence HTTP route checks this index before resolving S3. This is
 * deliberately narrower than recursively walking the complete workflow output:
 * only host-produced browser capture and visual-diff branches may authorize
 * bytes, while evaluator prose and arbitrary capability results may not.
 */
export function indexHojaResultEvidence(outputValue: unknown): readonly HojaEvidenceIndexEntry[] {
	const output = record(outputValue);
	if (output?.schema !== "sophia.hoja.swarm-result.v1") return [];
	const entries = new Map<string, HojaEvidenceIndexEntry>();
	let visited = 0;
	const visit = (value: unknown, depth: number): void => {
		visited += 1;
		if (visited > 16_384 || depth > 12) throw new Error("Hoja evidence index exceeds its structural bound");
		const ref = evidenceRef(value);
		if (ref) entries.set(`${ref.uri}\n${ref.sha256}`, ref);
		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1);
			return;
		}
		const object = record(value);
		if (!object) return;
		for (const child of Object.values(object)) visit(child, depth + 1);
	};
	for (const candidate of array(output.beats) ?? []) {
		const beat = record(candidate);
		if (!beat) continue;
		visit(beat.evidence, 0);
		visit(beat.diff, 0);
	}
	if (entries.size > 2_048) throw new Error("Hoja evidence index contains too many refs");
	return [...entries.values()].sort((left, right) =>
		left.uri === right.uri ? left.sha256.localeCompare(right.sha256) : left.uri.localeCompare(right.uri),
	);
}

function emitVerdict(
	input: { capture?: CaptureEmitter; identity: CaptureIdentity },
	payload: TestVerdictPayload,
): void {
	emitCaptureSoft(input.capture, {
		kind: "test.verdict",
		...input.identity,
		outcome: payload.passed ? "ok" : "error",
		payload,
	});
}

function firstEvidenceRef(value: unknown): ThinEvidenceRef | undefined {
	for (const candidate of array(value) ?? []) {
		const ref = evidenceRef(candidate);
		if (ref) return ref;
	}
	return undefined;
}

function evidenceRef(value: unknown): ThinEvidenceRef | undefined {
	const ref = record(value);
	if (typeof ref?.uri !== "string" || !EVIDENCE_URI.test(ref.uri)) return undefined;
	if (typeof ref.sha256 !== "string" || !SHA256.test(ref.sha256)) return undefined;
	return { uri: ref.uri, sha256: ref.sha256 };
}

function boundedTiming(
	value: Record<string, unknown> | undefined,
): Pick<TestVerdictPayload, "observedMs" | "maximumMs"> {
	const observedMs = safeNonnegativeInteger(value?.durationMs);
	const maximumMs = safeNonnegativeInteger(value?.maxMs);
	return {
		...(observedMs === undefined ? {} : { observedMs }),
		...(maximumMs === undefined ? {} : { maximumMs }),
	};
}

function duration(value: unknown): { durationMs?: number } {
	const durationMs = safeNonnegativeInteger(value);
	return durationMs === undefined ? {} : { durationMs };
}

function safeNonnegativeInteger(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function hojaInvariant(value: unknown): HojaInvariant | undefined {
	return typeof value === "string" && HOJA_INVARIANTS.includes(value as HojaInvariant)
		? (value as HojaInvariant)
		: undefined;
}

function hojaOperation(value: unknown): HojaOperation | undefined {
	return typeof value === "string" && HOJA_OPERATIONS.includes(value as HojaOperation)
		? (value as HojaOperation)
		: undefined;
}

function browserEngine(value: unknown): "chromium" | "camoufox" | undefined {
	return value === "chromium" || value === "camoufox" ? value : undefined;
}

function opaque(value: unknown): string | undefined {
	return typeof value === "string" && OPAQUE_ID.test(value) ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function array(value: unknown): readonly unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}
