export interface InferenceBudgetConstraints {
	readonly maxTokens: number;
	readonly maxPromptTokensPerCall?: number;
	readonly maxCompletionTokensPerCall?: number;
}

export interface InferenceBudgetState {
	readonly usedTokens: number;
	readonly reservedTokens: number;
}

export interface InferenceAdmissionPlan {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalReservedTokens: number;
	readonly effectivePromptLimit: number;
	readonly remainingSessionTokens: number;
}

/**
 * Keep the model context envelope and the cumulative session meter separate.
 * Prompt overflow is recoverable through Prime compaction; session exhaustion
 * is terminal unless the owner widens the pinned runtime profile.
 */
export function planInferenceAdmission(input: {
	readonly constraints: InferenceBudgetConstraints;
	readonly state: InferenceBudgetState;
	readonly estimatedInputTokens: number;
	readonly modelContextWindow: number;
	readonly modelMaxOutputTokens: number;
}): InferenceAdmissionPlan {
	const requestedOutput = Math.max(
		1,
		Math.min(input.modelMaxOutputTokens, input.constraints.maxCompletionTokensPerCall ?? input.modelMaxOutputTokens),
	);
	const promptLimit = input.constraints.maxPromptTokensPerCall ?? input.modelContextWindow;
	const effectivePromptLimit = Math.min(promptLimit, Math.max(1, input.modelContextWindow - requestedOutput));
	if (input.estimatedInputTokens > effectivePromptLimit) {
		throw new Error(
			`context_length_exceeded: estimated prompt is ${input.estimatedInputTokens} tokens, above the ${effectivePromptLimit} token per-call prompt limit; compact or page capability results before retrying`,
		);
	}
	const remainingSessionTokens = input.constraints.maxTokens - input.state.usedTokens - input.state.reservedTokens;
	const availableOutput = remainingSessionTokens - input.estimatedInputTokens;
	if (availableOutput < 1) {
		throw new Error(
			`agent_session_token_budget_exhausted: ${input.state.usedTokens}/${input.constraints.maxTokens} tokens used; this ${input.estimatedInputTokens} token prompt cannot be admitted`,
		);
	}
	const outputTokens = Math.min(requestedOutput, availableOutput);
	return {
		inputTokens: input.estimatedInputTokens,
		outputTokens,
		totalReservedTokens: input.estimatedInputTokens + outputTokens,
		effectivePromptLimit,
		remainingSessionTokens,
	};
}
