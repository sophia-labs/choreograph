import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planInferenceAdmission } from "../agent-runtime/inference-budget.js";

const constraints = {
	maxTokens: 500_000,
	maxPromptTokensPerCall: 240_000,
	maxCompletionTokensPerCall: 32_000,
};

describe("Agent runtime inference budget", () => {
	it("admits a large but bounded prompt without conflating it with session spend", () => {
		assert.deepEqual(
			planInferenceAdmission({
				constraints,
				state: { usedTokens: 80_000, reservedTokens: 0 },
				estimatedInputTokens: 220_000,
				modelContextWindow: 272_000,
				modelMaxOutputTokens: 64_000,
			}),
			{
				inputTokens: 220_000,
				outputTokens: 32_000,
				totalReservedTokens: 252_000,
				effectivePromptLimit: 240_000,
				remainingSessionTokens: 420_000,
			},
		);
	});

	it("classifies per-call prompt overflow as a compaction-triggering context fault", () => {
		assert.throws(
			() =>
				planInferenceAdmission({
					constraints,
					state: { usedTokens: 0, reservedTokens: 0 },
					estimatedInputTokens: 240_001,
					modelContextWindow: 272_000,
					modelMaxOutputTokens: 32_000,
				}),
			/context_length_exceeded/,
		);
	});

	it("reports cumulative session exhaustion independently", () => {
		assert.throws(
			() =>
				planInferenceAdmission({
					constraints,
					state: { usedTokens: 495_000, reservedTokens: 0 },
					estimatedInputTokens: 8_000,
					modelContextWindow: 272_000,
					modelMaxOutputTokens: 32_000,
				}),
			/agent_session_token_budget_exhausted/,
		);
	});
});
