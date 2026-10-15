import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileWorkflow } from "../workflow/harness.js";
import {
	assertJsonSchema,
	EXECUTION_BINDING_SCHEMA,
	InvocationFault,
	legacyExecutorFor,
	resolveExecutionBinding,
} from "../workflow/invocation.js";

describe("canonical invocation contracts", () => {
	it("keeps controller, model use, effects, and reproducibility orthogonal", () => {
		const execution = resolveExecutionBinding({
			name: "transcribe-audio",
			executor: "dumb",
			execution: {
				schema: EXECUTION_BINDING_SCHEMA,
				controller: "program",
				modelUse: "inference",
				isolation: "sandbox",
				effects: "capability-bound",
				reproducibility: "nondeterministic",
				capabilities: ["audio.transcribe", "audio.read", "audio.transcribe"],
				authority: { minimumRole: "viewer" },
			},
		});

		assert.equal(execution.controller, "program");
		assert.equal(execution.modelUse, "inference");
		assert.equal(execution.effects, "capability-bound");
		assert.equal(execution.reproducibility, "nondeterministic");
		assert.deepEqual(execution.capabilities, ["audio.read", "audio.transcribe"]);
		assert.equal(execution.authority.minimumRole, "viewer");
		assert.equal(legacyExecutorFor(execution), "dumb");
	});

	it("fails closed on contradictory compatibility and canonical faces", () => {
		assert.throws(
			() =>
				resolveExecutionBinding({
					name: "contradictory",
					executor: "gated",
					execution: {
						controller: "program",
						modelUse: "none",
						isolation: "sandbox",
						effects: "pure",
						reproducibility: "pure",
					},
				}),
			(error: unknown) => error instanceof InvocationFault && error.code === "execution_binding_invalid",
		);
	});

	it("returns redacted structured JSON-Schema failures", () => {
		assert.throws(
			() =>
				assertJsonSchema(
					{ secret: "do-not-echo", count: 0 },
					{
						type: "object",
						properties: { count: { type: "integer", minimum: 1 } },
						required: ["count"],
					},
					"input",
				),
			(error: unknown) => {
				assert.ok(error instanceof InvocationFault);
				assert.equal(error.code, "invalid_input");
				assert.doesNotMatch(JSON.stringify(error.details), /do-not-echo/);
				return true;
			},
		);
	});

	it("parses workflow metadata as data instead of executing it on the host", () => {
		delete (globalThis as Record<string, unknown>).__workflowMetaExecuted;
		assert.throws(
			() =>
				compileWorkflow(`export const meta = {
	name: (globalThis.__workflowMetaExecuted = true, "host-code"),
}
return {}
`),
			/data-only|JSON5|invalid character|unexpected/i,
		);
		assert.equal((globalThis as Record<string, unknown>).__workflowMetaExecuted, undefined);
	});
});
