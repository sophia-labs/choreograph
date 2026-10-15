/**
 * `scripts/local-runtime-manifest.ts` writes the runtime-bundle manifest a local (local-native) Choreograph reads:
 * one sophia-agent-runtime bundle whose relative host_path is the Prime tree beside it and whose digest attests that
 * tree. Read back here exactly as the orchestrator reads it, and refused once the source moves.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import {
	digestSophiaAgentSourceTree,
	resolveRuntimeBundleDescriptor,
	SOPHIA_AGENT_RUNTIME_BUNDLE_ID,
} from "../runtime-bundles.js";

const repoRoot = resolve(import.meta.dirname, "..", "..");
const root = mkdtempSync(join(tmpdir(), "local-runtime-manifest-"));
after(() => rmSync(root, { recursive: true, force: true }));

function primeTree(dir: string): string {
	const worker = join(dir, "packages", "coding-agent", "src", "sophia", "host-worker.ts");
	mkdirSync(join(dir, "packages", "coding-agent", "src", "sophia"), { recursive: true });
	writeFileSync(join(dir, "package.json"), '{"name":"prime-agent","private":true}\n');
	writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
	writeFileSync(join(dir, "tsconfig.json"), "{}\n");
	writeFileSync(worker, "export {};\n");
	return worker;
}

describe("local runtime manifest", () => {
	const service = join(root, "services", "choreograph");
	const prime = join(service, "prime");
	const worker = primeTree(prime);
	const out = join(service, "runtime-bundles.json");

	it("writes a relative host_path and the source digest, and the orchestrator resolves it", () => {
		execFileSync(process.execPath, ["--import", "tsx", "scripts/local-runtime-manifest.ts", prime, "--out", out], {
			cwd: repoRoot,
			stdio: "pipe",
		});
		const manifest = JSON.parse(readFileSync(out, "utf8"));
		assert.equal(manifest.bundles.length, 1);
		const [bundle] = manifest.bundles;
		assert.equal(bundle.id, SOPHIA_AGENT_RUNTIME_BUNDLE_ID);
		assert.equal(bundle.mounts[0].host_path, "prime");
		assert.equal(`sha256:${bundle.digest}`, digestSophiaAgentSourceTree(worker));

		const previous = process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST;
		process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST = out;
		try {
			const descriptor = resolveRuntimeBundleDescriptor(SOPHIA_AGENT_RUNTIME_BUNDLE_ID);
			assert.equal(descriptor.digest, bundle.digest);
			assert.equal(descriptor.mounts[0]?.hostPath, prime);

			// An edit to the Prime source after packaging is refused until the manifest is written again.
			writeFileSync(worker, "export const drift = 1;\n");
			assert.throws(
				() => resolveRuntimeBundleDescriptor(SOPHIA_AGENT_RUNTIME_BUNDLE_ID),
				/does not attest its mounted source bytes/,
			);
		} finally {
			if (previous === undefined) delete process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST;
			else process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST = previous;
		}
	});

	it("refuses a directory that is not a Prime tree", () => {
		assert.throws(() =>
			execFileSync(process.execPath, ["--import", "tsx", "scripts/local-runtime-manifest.ts", root], {
				cwd: repoRoot,
				stdio: "pipe",
			}),
		);
	});
});
