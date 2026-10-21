/**
 * gardend's manifest for Choreograph as its local service `choreograph` (Sophia Compute): the `service.json` that
 * `build-gardend-service.mjs` writes. A module of its own so a test can hand a real gardend the same manifest without
 * building the service (`src/test/being-geist.test.ts`).
 */

/** The oldest Node.js the bundled service runs on. */
export const NODE_FLOOR = "22.19";

export const SERVICE = {
	serviceId: "choreograph",
	displayName: "Sophia Compute",
	command: "node",
	args: ["app/main.mjs"],
	requires: { node: NODE_FLOOR },
	workingDir: ".",
	healthPath: "/health",
	proxyMount: "/services/choreograph",
	// Opt-in: `gardend service enable choreograph` turns it on at boot; a workflow run through gardend starts it.
	autostart: false,
	// A workflow's beings keep their own memory, Song and valuations: gardend adds memory.write.observed and
	// salience.write.observed to this service's own token, which admit those writes only for a call that names an agent
	// as its observer. The host binds every being's observer (`HostedMnemosyneProxy`), so a being writes only its own.
	agentMemory: true,
	env: [
		{ name: "NODE_ENV", value: "production" },
		{ name: "OTEL_SDK_DISABLED", value: "true" },
		{ name: "BILLING_FEE_BPS", value: "0" },
		{ name: "WORKFLOW_DYNAMIC_SOURCE", value: "1" },
		{ name: "CHOREOGRAPH_LOCAL_AGENT_DEFAULTS", value: "1" },
		{ name: "SOPHIA_AGENT_RUNTIME_ENTRYPOINT", value: "body/body.mjs" },
		// Every graph on a gardend belongs to its profile's owner (the master key's identity, `user:owner`).
		{ name: "MNEMOSYNE_GRAPH_OWNER", value: "user:owner" },
	],
};
