import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NdjsonLineLimitError, PRIME_HOST_WIRE_MAX_LINE_BYTES, parseNdjsonLine } from "../ndjson-line.js";

describe("Prime host-wire NDJSON bounds", () => {
	it("rejects an oversized line before JSON parsing", () => {
		const originalParse = JSON.parse;
		let parseCalls = 0;
		JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
			parseCalls++;
			return originalParse(...args);
		}) as typeof JSON.parse;
		try {
			assert.throws(
				() => parseNdjsonLine("x".repeat(PRIME_HOST_WIRE_MAX_LINE_BYTES + 1)),
				(error: unknown) =>
					error instanceof NdjsonLineLimitError &&
					error.maximum === PRIME_HOST_WIRE_MAX_LINE_BYTES &&
					error.bytes === PRIME_HOST_WIRE_MAX_LINE_BYTES + 1,
			);
			assert.equal(parseCalls, 0);
		} finally {
			JSON.parse = originalParse;
		}
	});

	it("parses an in-bound bridge line", () => {
		assert.deepEqual(parseNdjsonLine('{"protocol":"choreograph.prime-host-bridge.v1"}'), {
			protocol: "choreograph.prime-host-bridge.v1",
		});
	});

	it("rejects malformed JSON", () => {
		assert.throws(() => parseNdjsonLine("{"), SyntaxError);
	});
});
