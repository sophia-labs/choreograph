export interface AttenuatedAgentCapabilitiesV1 {
	readonly capabilityNames: readonly string[];
	readonly grantedTools: Readonly<Record<string, readonly string[]>>;
}

/**
 * Intersect a node's host capabilities with its runtime-profile wards.
 *
 * Workflow inspection remains useful to a closed simple Prime embodiment, but
 * driver and amendment operations are authority-bearing and therefore exist
 * only when the explicit runtime profile permits workflow proposals.
 */
export function attenuateAgentCapabilitiesForRuntime(input: {
	readonly capabilityNames: readonly string[];
	readonly grantedTools: Readonly<Record<string, readonly string[]>>;
	readonly allowWorkflowProposals: boolean;
}): AttenuatedAgentCapabilitiesV1 {
	if (input.allowWorkflowProposals) {
		return {
			capabilityNames: [...input.capabilityNames],
			grantedTools: copyTools(input.grantedTools),
		};
	}
	const workflowTools = (input.grantedTools.workflow ?? []).filter((tool) => tool === "inspect");
	return {
		capabilityNames: input.capabilityNames.filter((name) => name !== "workflow" || workflowTools.length > 0),
		grantedTools: {
			...copyTools(input.grantedTools),
			workflow: workflowTools,
		},
	};
}

function copyTools(tools: Readonly<Record<string, readonly string[]>>): Readonly<Record<string, readonly string[]>> {
	return Object.fromEntries(Object.entries(tools).map(([capability, names]) => [capability, [...names]]));
}
