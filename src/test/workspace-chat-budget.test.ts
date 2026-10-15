/**
 * The chat session's cost budget is the Prime baseline ($1) unless the host sets
 * `CHOREOGRAPH_WORKSPACE_CHAT_MAX_COST_USD`. Hosted sets nothing, so its budget (and the built-in workflow's digest)
 * does not move; a self-host may raise or lower it, never past the Prime platform ceiling.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_RUNTIME_PLATFORM_CEILINGS, PRIME_AGENT_RUNTIME_BASELINE } from "../agent-runtime/profile.js";
import { WORKSPACE_CHAT_RUNTIME_CONSTRAINTS, workspaceChatMaxCostUsdMicros } from "../workflow/workspace-chat.js";

describe("workspace chat cost budget", () => {
	it("is the Prime baseline when unset or blank", () => {
		assert.equal(PRIME_AGENT_RUNTIME_BASELINE.maxCostUsdMicros, 1_000_000);
		assert.equal(workspaceChatMaxCostUsdMicros(undefined), 1_000_000);
		assert.equal(workspaceChatMaxCostUsdMicros("  "), 1_000_000);
	});

	it("takes dollars, whole or decimal", () => {
		assert.equal(workspaceChatMaxCostUsdMicros("5"), 5_000_000);
		assert.equal(workspaceChatMaxCostUsdMicros("2.50"), 2_500_000);
		assert.equal(workspaceChatMaxCostUsdMicros("0.25"), 250_000);
	});

	it("keeps the baseline for a value that is not a positive amount", () => {
		for (const bad of ["0", "-1", "abc", "1e3", "$5", "5 dollars"]) {
			assert.equal(workspaceChatMaxCostUsdMicros(bad), 1_000_000, bad);
		}
	});

	it("holds a value above the Prime ceiling to the ceiling", () => {
		const ceiling = AGENT_RUNTIME_PLATFORM_CEILINGS.prime.maxCostUsdMicros;
		assert.equal(workspaceChatMaxCostUsdMicros("1000"), ceiling);
	});

	it("leaves the bound constraints at the baseline when the environment is unset", () => {
		if (process.env.CHOREOGRAPH_WORKSPACE_CHAT_MAX_COST_USD) return;
		assert.equal(WORKSPACE_CHAT_RUNTIME_CONSTRAINTS.maxCostUsdMicros, 1_000_000);
	});
});
