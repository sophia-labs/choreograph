import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveAgentLlmProvider } from "../provider-default.js";

describe("host provider default", () => {
	it("preserves the supported environment floor and fails unknown values to openrouter", () => {
		assert.equal(resolveAgentLlmProvider({}), "openrouter");
		assert.equal(resolveAgentLlmProvider({ AGENT_LLM_PROVIDER: "deepseek" }), "deepseek");
		assert.equal(resolveAgentLlmProvider({ AGENT_LLM_PROVIDER: "lmstudio" }), "lmstudio");
		assert.equal(resolveAgentLlmProvider({ AGENT_LLM_PROVIDER: "anthropic" }), "anthropic");
		assert.equal(resolveAgentLlmProvider({ AGENT_LLM_PROVIDER: "unknown" }), "openrouter");
	});
});
