import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { kernelHostErrorForBridge, normalizeKernelHostError } from "../spawner.js";

describe("kernel host error bridge boundary", () => {
	it("emits the exact six-class four-field testimony accepted by Rust and Python", () => {
		const cases = [
			["cancelled", "conflict", true, false],
			["deadline", "unavailable", false, true],
			["budget", "denied", true, false],
			["not_found", "not_found", false, false],
		] as const;
		for (const [sourceClass, expectedClass, sourceRetryable, expectedRetryable] of cases) {
			assert.deepEqual(
				normalizeKernelHostError({
					code: `source_${sourceClass}`,
					class: sourceClass,
					message: "Exact bounded testimony",
					retryable: sourceRetryable,
					details: { private: "must not cross the kernel boundary" },
				}),
				{
					code: `source_${sourceClass}`,
					class: expectedClass,
					message: "Exact bounded testimony",
					retryable: expectedRetryable,
				},
			);
		}
	});

	it("rejects unstructured, nonprintable, and noncanonical error testimony", () => {
		assert.throws(() => normalizeKernelHostError("legacy failure"), /structured Prime error testimony/);
		assert.throws(
			() =>
				normalizeKernelHostError({
					code: "invalid code",
					class: "internal",
					message: "failure",
					retryable: false,
				}),
			/invalid characters/,
		);
		assert.throws(
			() =>
				normalizeKernelHostError({
					code: "capability_failed",
					class: "internal",
					message: "line one\nline two",
					retryable: false,
				}),
			/printable ASCII/,
		);
	});

	it("turns rejected testimony into one honest canonical failure instead of hanging the kernel", () => {
		const rejected: unknown[] = [];
		assert.deepEqual(
			kernelHostErrorForBridge("legacy failure", (error) => rejected.push(error)),
			{
				code: "kernel_host_error_invalid",
				class: "internal",
				message: "Kernel host error testimony was invalid",
				retryable: false,
			},
		);
		assert.equal(rejected.length, 1);
	});
});
