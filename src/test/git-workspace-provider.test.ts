import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { MEANINGFUL_OBJECT_REF_SCHEMA, type MeaningfulObjectRefV1 } from "../agent-runtime/meaningful-object.js";
import { GitWorktreeProvider } from "../workspace/git-workspace-provider.js";
import { WorkspaceFault } from "../workspace/provider.js";

const roots: string[] = [];
const ownerPrincipal = "user:workspace-owner";
const agentId = "agent-0123456789abcdef";
const graphId = "g-workspace";

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(repository: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repository, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
		},
	}).trim();
}

function makeRepository(): { root: string; revision: string } {
	const root = mkdtempSync(join(tmpdir(), "workspace-source-"));
	roots.push(root);
	execFileSync("git", ["init", "--quiet", root]);
	git(root, "config", "user.email", "workspace-test@example.invalid");
	git(root, "config", "user.name", "Workspace Test");
	mkdirSync(join(root, "extension"), { recursive: true });
	writeFileSync(join(root, "extension", "manifest.json"), '{"name":"baseline"}\n');
	writeFileSync(join(root, "README.md"), "human checkout remains untouched\n");
	git(root, "add", "--all");
	git(root, "commit", "--quiet", "-m", "baseline");
	return { root, revision: git(root, "rev-parse", "HEAD") };
}

function proposalRef(): MeaningfulObjectRefV1<"evolution-proposal"> {
	return {
		schema: MEANINGFUL_OBJECT_REF_SCHEMA,
		kind: "evolution-proposal",
		ownerPrincipal,
		graphId,
		objectId: "proposal-workspace-test",
		version: "1",
		digest: `sha256:${"a".repeat(64)}`,
	};
}

function request(repository: { root: string; revision: string }) {
	return {
		ownerPrincipal,
		agentId,
		graphId,
		repositoryId: "personal-extension-repository",
		repositoryPath: repository.root,
		baseRevision: repository.revision,
		allowedPaths: ["extension"],
		maxBytes: 1_000_000,
		proposalRef: proposalRef(),
	};
}

describe("GitWorktreeProvider", () => {
	it("materializes a sanitized detached generation without leaking a host path", async () => {
		const source = makeRepository();
		const providerRoot = mkdtempSync(join(tmpdir(), "workspace-provider-"));
		roots.push(providerRoot);
		const provider = new GitWorktreeProvider({ rootDirectory: providerRoot });
		const materialized = await provider.materialize(request(source), 1_000);
		const hostPath = await provider.resolveHostPath(materialized.lease, 1_001);
		assert.equal(git(hostPath, "rev-parse", "HEAD"), source.revision);
		assert.equal(git(hostPath, "remote"), "");
		assert.doesNotMatch(readFileSync(join(hostPath, ".git", "config"), "utf8"), new RegExp(source.root));
		assert.doesNotMatch(JSON.stringify(materialized), new RegExp(source.root));
		assert.equal(materialized.workspace.mountPath, "/candidate");
		assert.equal(readFileSync(join(source.root, "extension", "manifest.json"), "utf8"), '{"name":"baseline"}\n');
	});

	it("checkpoints exact bytes, restores into a fenced generation, and attests the host-computed patch", async () => {
		const source = makeRepository();
		const providerRoot = mkdtempSync(join(tmpdir(), "workspace-provider-"));
		roots.push(providerRoot);
		const provider = new GitWorktreeProvider({ rootDirectory: providerRoot, leaseMs: 60_000 });
		const materialized = await provider.materialize(request(source), 1_000);
		const hostPath = await provider.resolveHostPath(materialized.lease, 1_001);
		writeFileSync(join(hostPath, "extension", "manifest.json"), '{"name":"improved","entrypoint":"summarize"}\n');
		writeFileSync(join(hostPath, "extension", "summarize.py"), "def summarize(value):\n    return sorted(value)\n");
		const checkpoint = await provider.checkpoint(materialized.lease, 1_002);
		writeFileSync(join(hostPath, "extension", "manifest.json"), "corrupt post-checkpoint bytes\n");
		const restoredLease = await provider.restore(materialized.lease, checkpoint.checkpointRef, 1_003);
		assert.equal(restoredLease.generation, materialized.lease.generation + 1);
		assert.equal(
			readFileSync(join(hostPath, "extension", "manifest.json"), "utf8"),
			'{"name":"improved","entrypoint":"summarize"}\n',
		);
		const attestation = await provider.attestPatch(restoredLease, 1_004);
		assert.deepEqual(
			attestation.patchSet.changedPaths.map((item) => [item.status, item.path]),
			[
				["modified", "extension/manifest.json"],
				["added", "extension/summarize.py"],
			],
		);
		assert.match(attestation.patchSet.patchDigest, /^sha256:[0-9a-f]{64}$/);
		const patch = await provider.readPatchArtifact(attestation.patchArtifactRef, restoredLease, 1_005);
		assert.match(patch.toString("utf8"), /summarize\.py/);
		assert.match(patch.toString("utf8"), /return sorted\(value\)/);
		const replay = await provider.attestPatch(restoredLease, 1_006);
		assert.equal(replay.patchSetRef.digest, attestation.patchSetRef.digest);
		assert.equal(git(source.root, "status", "--porcelain"), "");
	});

	it("denies path-fence, symlink, secret, stale-lease, and quota escapes", async () => {
		const source = makeRepository();
		const providerRoot = mkdtempSync(join(tmpdir(), "workspace-provider-"));
		roots.push(providerRoot);
		const provider = new GitWorktreeProvider({ rootDirectory: providerRoot, leaseMs: 60_000 });
		const materialized = await provider.materialize(request(source), 1_000);
		const hostPath = await provider.resolveHostPath(materialized.lease, 1_001);
		writeFileSync(join(hostPath, "README.md"), "candidate crossed its path fence\n");
		await assert.rejects(() => provider.attestPatch(materialized.lease, 1_002), /outside its fence/);
		writeFileSync(join(hostPath, "README.md"), "human checkout remains untouched\n");
		symlinkSync("../../../../etc/passwd", join(hostPath, "extension", "escape"));
		await assert.rejects(() => provider.checkpoint(materialized.lease, 1_003), WorkspaceFault);
		rmSync(join(hostPath, "extension", "escape"));
		writeFileSync(join(hostPath, "extension", "leak.txt"), `-----BEGIN PRIVATE KEY-----\n${"x".repeat(20)}\n`);
		await assert.rejects(() => provider.attestPatch(materialized.lease, 1_004), /denied secret pattern/);
		await provider.release(materialized.lease, 1_005);
		await assert.rejects(() => provider.resolveHostPath(materialized.lease, 1_006), /expired/);

		const quotaProviderRoot = mkdtempSync(join(tmpdir(), "workspace-provider-quota-"));
		roots.push(quotaProviderRoot);
		const quotaProvider = new GitWorktreeProvider({ rootDirectory: quotaProviderRoot });
		await assert.rejects(
			() => quotaProvider.materialize({ ...request(source), maxBytes: 5 }, 2_000),
			/exceeds its byte quota/,
		);
	});
});
