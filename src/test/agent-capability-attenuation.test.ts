import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attenuateAgentCapabilitiesForRuntime } from "../agent-runtime/capability-attenuation.js";

describe("Agent runtime capability attenuation", () => {
	it("keeps a simple Prime embodiment on workflow inspection only", () => {
		const result = attenuateAgentCapabilitiesForRuntime({
			capabilityNames: ["discord", "workflow"],
			grantedTools: {
				discord: ["search_messages"],
				workflow: ["inspect", "claim_driver", "release_driver", "propose_amendment"],
			},
			allowWorkflowProposals: false,
		});

		assert.deepEqual(result.capabilityNames, ["discord", "workflow"]);
		assert.deepEqual(result.grantedTools, {
			discord: ["search_messages"],
			workflow: ["inspect"],
		});
	});

	it("does not bind an empty workflow backend and preserves the explicit Prime grant", () => {
		const closed = attenuateAgentCapabilitiesForRuntime({
			capabilityNames: ["discord", "workflow"],
			grantedTools: { discord: ["get_message"], workflow: ["propose_amendment"] },
			allowWorkflowProposals: false,
		});
		assert.deepEqual(closed.capabilityNames, ["discord"]);

		const prime = attenuateAgentCapabilitiesForRuntime({
			capabilityNames: ["discord", "workflow"],
			grantedTools: { discord: ["get_message"], workflow: ["inspect", "propose_amendment"] },
			allowWorkflowProposals: true,
		});
		assert.deepEqual(prime.capabilityNames, ["discord", "workflow"]);
		assert.deepEqual(prime.grantedTools.workflow, ["inspect", "propose_amendment"]);
	});
});
