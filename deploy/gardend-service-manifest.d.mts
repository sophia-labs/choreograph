/** Types for `gardend-service-manifest.mjs`, gardend's manifest for Choreograph (`service.json`). */

export declare const NODE_FLOOR: string;

export declare const SERVICE: {
	readonly serviceId: string;
	readonly displayName: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly requires: { readonly node: string };
	readonly workingDir: string;
	readonly healthPath: string;
	readonly proxyMount: string;
	readonly autostart: boolean;
	readonly agentMemory: boolean;
	readonly env: readonly { readonly name: string; readonly value: string }[];
};
