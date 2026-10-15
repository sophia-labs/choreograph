#!/usr/bin/env -S node --import tsx
/**
 * Write the runtime-bundle manifest for a local (local-native) Choreograph: one `sophia-agent-runtime` bundle whose
 * host path is a Prime source tree and whose digest attests that tree's bytes (`digestSophiaAgentSourceTree`, the same
 * function the spawner checks before every agent spawn).
 *
 *   tsx scripts/local-runtime-manifest.ts <prime-source-dir> [--out <file>] [--host-path <path>]
 *
 * - `<prime-source-dir>`: a Prime (sophia-agent) checkout with its `node_modules` installed; its
 *   `packages/coding-agent/src/sophia/host-worker.ts` is the body's entrypoint.
 * - `--out`: where to write the manifest (default: stdout).
 * - `--host-path`: the mount's `host_path` as written. Default: the Prime directory relative to the manifest's own
 *   directory, so the pair can move together (a relative `host_path` resolves against the manifest's directory).
 *
 * The orchestrator reads the result through `CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST`; point
 * `SOPHIA_AGENT_RUNTIME_ENTRYPOINT` at the same tree's `host-worker.ts`. Any edit to the Prime source afterwards
 * changes the digest, and spawns refuse until the manifest is written again.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
	digestSophiaAgentSourceTree,
	resolveRuntimeBundleDescriptor,
	SOPHIA_AGENT_RUNTIME_BUNDLE_ID,
	SOPHIA_AGENT_RUNTIME_GUEST_ROOT,
} from "../src/runtime-bundles.js";

export const SOPHIA_AGENT_HOST_WORKER = join("packages", "coding-agent", "src", "sophia", "host-worker.ts");

export interface LocalRuntimeManifest {
	readonly bundles: ReadonlyArray<{
		readonly id: string;
		readonly description: string;
		readonly digest: string;
		readonly mounts: ReadonlyArray<{ readonly guest_path: string; readonly mode: "ro"; readonly host_path: string }>;
	}>;
}

/** The manifest for a Prime tree; `hostPath` is written as given. */
export function localRuntimeManifest(primeDir: string, hostPath: string): LocalRuntimeManifest {
	const digest = digestSophiaAgentSourceTree(join(resolve(primeDir), SOPHIA_AGENT_HOST_WORKER));
	return {
		bundles: [
			{
				id: SOPHIA_AGENT_RUNTIME_BUNDLE_ID,
				description: "Sophia agent runtime (Prime), run from source in local-native mode",
				digest: digest.replace(/^sha256:/, ""),
				mounts: [{ guest_path: SOPHIA_AGENT_RUNTIME_GUEST_ROOT, mode: "ro", host_path: hostPath }],
			},
		],
	};
}

function main(argv: string[]): void {
	let primeDir: string | undefined;
	let out: string | undefined;
	let hostPath: string | undefined;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--out" || arg === "--host-path") {
			const value = argv[i + 1];
			if (!value) throw new Error(`${arg} needs a value`);
			if (arg === "--out") out = value;
			else hostPath = value;
			i += 1;
		} else if (arg === "-h" || arg === "--help") {
			console.log("usage: tsx scripts/local-runtime-manifest.ts <prime-source-dir> [--out <file>] [--host-path <path>]");
			return;
		} else if (!primeDir && !arg.startsWith("-")) {
			primeDir = arg;
		} else {
			throw new Error(`unexpected argument: ${arg}`);
		}
	}
	if (!primeDir) throw new Error("usage: tsx scripts/local-runtime-manifest.ts <prime-source-dir> [--out <file>]");
	const prime = resolve(primeDir);
	const outPath = out ? resolve(out) : undefined;
	const written = hostPath ?? (outPath ? relative(dirname(outPath), prime) || "." : prime);
	const manifest = localRuntimeManifest(prime, written);
	const text = `${JSON.stringify(manifest, null, 2)}\n`;
	if (!outPath) {
		process.stdout.write(text);
		return;
	}
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, text);
	// Read it back the way the orchestrator does: the manifest must resolve and attest its own mount.
	process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST = outPath;
	const descriptor = resolveRuntimeBundleDescriptor(SOPHIA_AGENT_RUNTIME_BUNDLE_ID);
	const mount = descriptor.mounts[0]?.hostPath;
	if (!mount || resolve(mount) !== prime) {
		throw new Error(`manifest mount resolves to ${mount}, not ${prime}`);
	}
	console.error(
		`wrote ${outPath}: ${SOPHIA_AGENT_RUNTIME_BUNDLE_ID} sha256:${descriptor.digest} host_path=${isAbsolute(written) ? written : `${written} (relative)`}`,
	);
}

if (process.argv[1]?.endsWith("local-runtime-manifest.ts")) {
	try {
		main(process.argv.slice(2));
	} catch (error) {
		console.error(`local-runtime-manifest: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
