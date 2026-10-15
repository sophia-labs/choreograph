import type { CaptureEmitter, CaptureIdentity, TestVerdictPayload } from "../observatory-capture.js";
import { emitCaptureSoft } from "../observatory-capture.js";
import { SERVICE_BATTERY_RESULT_SCHEMA } from "./script-service-battery.js";
import type { ServiceInvariantId } from "./service-battery.js";
import { SERVICE_INVARIANTS } from "./service-battery.js";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** `IDENTIFIER_PATTERN`, observatory-capture.ts — the open axis the service family rides. */
const VERDICT_CODE = /^[a-z][a-z0-9_.-]{0,63}$/;

/**
 * Project a completed Garden service battery result into content-free CaptureEvents.
 *
 * The service family (S1 durability, S2 authority, S3 isolation) has no slot in
 * the ratified `test_invariant` enum, so a reading is emitted under the
 * face-coherence id it genuinely is — I1 echo, I4 block identity, I5 projection —
 * and is discriminated on the open `verdict_code` axis. Widening the invariant
 * enum here would break the very contract the Observatory joins on.
 *
 * This flow drives no browser and stores no bytes, so it emits no `test.beat`:
 * there is no engine to name and no evidence to point at, and fabricating either
 * would be false testimony. Observed content, block identities, payload digests
 * and error text stay in the sandbox — testimony carries coordinates,
 * classifications and bounded integers only.
 */
export function emitServiceResultTestimony(input: {
	readonly capture?: CaptureEmitter;
	readonly identity: CaptureIdentity;
	readonly runId: string;
	readonly output: unknown;
}): void {
	if (!input.capture) return;
	const output = record(input.output);
	if (output?.schema !== SERVICE_BATTERY_RESULT_SCHEMA) return;
	const runId = opaque(input.runId);
	const scenarioId = opaque(output.scenarioId);
	if (!runId || !scenarioId) return;

	for (const value of array(output.verdicts) ?? []) {
		const verdict = record(value);
		const invariant = serviceInvariant(verdict?.invariant);
		// The stem is scenario-supplied, so the emitted code is checked against the
		// contract's identifier domain HERE rather than being left to fail
		// silently in the writer, where a dropped line is indistinguishable from a
		// run that simply had nothing to say.
		const verdictCode = identifier(verdict?.verdictCode);
		const passed = decisive(verdict?.result);
		if (!invariant || !verdictCode || passed === undefined) continue;
		emitVerdict(input, {
			runId,
			scenarioId,
			invariant,
			passed,
			verdictCode,
			...boundedTiming(verdict),
		});
	}
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

/**
 * The run is three-valued by construction. Only `pass` and `fail` are statements
 * about the face; an undecided invariant left a bounded reason in the run output
 * and leaves nothing at all on the wire, because the contract has no inconclusive
 * verdict and a `fail` emitted for a spot kill would poison the metric.
 */
function decisive(value: unknown): boolean | undefined {
	if (value === "pass") return true;
	if (value === "fail") return false;
	return undefined;
}

function boundedTiming(
	verdict: Record<string, unknown> | undefined,
): Pick<TestVerdictPayload, "observedMs" | "maximumMs"> {
	const observedMs = safeNonnegativeInteger(verdict?.observedMs);
	const maximumMs = safeNonnegativeInteger(verdict?.maximumMs);
	return {
		...(observedMs === undefined ? {} : { observedMs }),
		...(maximumMs === undefined ? {} : { maximumMs }),
	};
}

function safeNonnegativeInteger(value: unknown): number | undefined {
	return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
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

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function array(value: unknown): readonly unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}
