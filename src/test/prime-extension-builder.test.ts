import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	PRIME_EXTENSION_ABI,
	PRIME_EXTENSION_MANIFEST_SCHEMA,
	PrimeExtensionFault,
} from "../agent-runtime/extension.js";
import { PrimeExtensionBuilder } from "../agent-runtime/extension-builder.js";
import { MEANINGFUL_OBJECT_REF_SCHEMA, type MeaningfulObjectRefV1 } from "../agent-runtime/meaningful-object.js";
import { GitWorktreeProvider } from "../workspace/git-workspace-provider.js";

const roots: string[] = [];
const ownerPrincipal = "user:extension-owner";
const agentId = "agent-0123456789abcdef";
const graphId = "g-extension";

afterEach(() => {
	for (const root of roots.splice(0)) {
		makeWritable(root);
		rmSync(root, { recursive: true, force: true });
	}
});

function makeWritable(path: string): void {
	let metadata: ReturnType<typeof lstatSync>;
	try {
		metadata = lstatSync(path);
	} catch {
		return;
	}
	if (!metadata.isDirectory()) return;
	chmodSync(path, 0o755);
	for (const child of readdirSync(path)) makeWritable(join(path, child));
}

function git(repository: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repository, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
	}).trim();
}

function makeRepository(): { root: string; revision: string } {
	const root = mkdtempSync(join(tmpdir(), "extension-source-"));
	roots.push(root);
	execFileSync("git", ["init", "--quiet", root]);
	git(root, "config", "user.email", "extension-test@example.invalid");
	git(root, "config", "user.name", "Extension Test");
	writeFileSync(join(root, "README.md"), "personal extension repository\n");
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
		objectId: "proposal-extension-test",
		version: "1",
		digest: `sha256:${"a".repeat(64)}`,
	};
}

function digest(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function manifestFor(source: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schema: PRIME_EXTENSION_MANIFEST_SCHEMA,
		extensionId: "manifest-summarizer",
		version: "1.0.0",
		ownerPrincipal,
		abi: PRIME_EXTENSION_ABI,
		displayName: "Manifest summarizer",
		description: "Returns a stable sorted summary of manifest keys.",
		network: "denied",
		dependencies: [],
		files: [{ path: "python/summarizer.py", digest: digest(source), mode: "0444" }],
		skills: [
			{
				name: "summarize_manifest",
				description: "Sort manifest keys.",
				entrypoint: "summarizer:summarize_manifest",
				inputSchema: {
					type: "object",
					properties: { value: { type: "object" } },
					required: ["value"],
					additionalProperties: false,
				},
				outputSchema: {
					type: "object",
					properties: { keys: { type: "array", items: { type: "string" } } },
					required: ["keys"],
					additionalProperties: false,
				},
				requiredCapabilities: [],
			},
		],
		...overrides,
	};
}

async function authorCandidate(input?: { manifestOverrides?: Record<string, unknown>; source?: string }) {
	const repository = makeRepository();
	const workspaceRoot = mkdtempSync(join(tmpdir(), "extension-workspace-"));
	const artifactRoot = mkdtempSync(join(tmpdir(), "extension-artifacts-"));
	roots.push(workspaceRoot, artifactRoot);
	const provider = new GitWorktreeProvider({ rootDirectory: workspaceRoot, leaseMs: 60_000 });
	const materialized = await provider.materialize(
		{
			ownerPrincipal,
			agentId,
			graphId,
			repositoryId: "personal-prime-extensions",
			repositoryPath: repository.root,
			baseRevision: repository.revision,
			allowedPaths: ["extension"],
			maxBytes: 1_000_000,
			proposalRef: proposalRef(),
		},
		1_000,
	);
	const hostPath = await provider.resolveHostPath(materialized.lease, 1_001);
	const source =
		input?.source ??
		"def summarize_manifest(input_value):\n    value = input_value['value']\n    return {'keys': sorted(value.keys())}\n";
	mkdirSync(join(hostPath, "extension", "python"), { recursive: true });
	writeFileSync(join(hostPath, "extension", "python", "summarizer.py"), source, { mode: 0o444 });
	writeFileSync(
		join(hostPath, "extension", "manifest.json"),
		`${JSON.stringify(manifestFor(source, input?.manifestOverrides))}\n`,
	);
	const attestation = await provider.attestPatch(materialized.lease, 1_002);
	return {
		provider,
		materialized,
		attestation,
		builder: new PrimeExtensionBuilder({ artifactRoot, workspaceProvider: provider }),
	};
}

describe("PrimeExtensionBuilder", () => {
	it("builds, resolves, mounts, and executes one immutable dependency-free Python skill", async () => {
		const candidate = await authorCandidate();
		const built = await candidate.builder.build({
			lease: candidate.materialized.lease,
			attestation: candidate.attestation,
			ownerPrincipal,
			agentId,
			graphId,
			allowedCapabilities: new Set(),
			now: 1_003,
		});
		assert.equal(built.manifest.dependencies.length, 0);
		assert.equal(built.buildReceipt.networkUsed, false);
		assert.equal(built.buildReceipt.patchSetDigest, candidate.attestation.patchSetRef.digest);
		assert.match(built.artifact.artifactDigest, /^sha256:[0-9a-f]{64}$/);
		const installed = await candidate.builder.resolveArtifact(ownerPrincipal, built.artifactRef);
		assert.equal(statSync(installed.hostPath).mode & 0o222, 0, "artifact root is read-only");
		assert.equal(statSync(join(installed.hostPath, "python", "summarizer.py")).mode & 0o222, 0);
		const result = execFileSync(
			"python3",
			[
				"-I",
				"-c",
				"import json,sys; sys.path.insert(0, sys.argv[1]); from summarizer import summarize_manifest; print(json.dumps(summarize_manifest({'value': {'z': 1, 'a': 2}}), sort_keys=True))",
				join(installed.hostPath, "python"),
			],
			{ encoding: "utf8" },
		).trim();
		assert.equal(result, '{"keys": ["a", "z"]}');
		assert.equal(
			JSON.parse(readFileSync(join(installed.hostPath, "manifest.json"), "utf8")).schema,
			PRIME_EXTENSION_MANIFEST_SCHEMA,
		);
	});

	it("denies undeclared capabilities, runtime dependencies, hidden files, and invalid Python", async () => {
		const capabilityCandidate = await authorCandidate({
			manifestOverrides: {
				skills: [
					{
						name: "summarize_manifest",
						description: "Sort manifest keys.",
						entrypoint: "summarizer:summarize_manifest",
						inputSchema: { type: "object" },
						outputSchema: { type: "object" },
						requiredCapabilities: ["secrets.read"],
					},
				],
			},
		});
		await assert.rejects(
			() =>
				capabilityCandidate.builder.build({
					lease: capabilityCandidate.materialized.lease,
					attestation: capabilityCandidate.attestation,
					ownerPrincipal,
					agentId,
					graphId,
					allowedCapabilities: new Set(),
					now: 1_003,
				}),
			/capability outside/,
		);

		const dependencyCandidate = await authorCandidate({ manifestOverrides: { dependencies: ["requests"] } });
		await assert.rejects(
			() =>
				dependencyCandidate.builder.build({
					lease: dependencyCandidate.materialized.lease,
					attestation: dependencyCandidate.attestation,
					ownerPrincipal,
					agentId,
					graphId,
					allowedCapabilities: new Set(),
					now: 1_003,
				}),
			/dependencies/,
		);

		const hiddenCandidate = await authorCandidate();
		const hiddenPath = await hiddenCandidate.provider.resolveHostPath(hiddenCandidate.materialized.lease, 1_003);
		writeFileSync(join(hiddenPath, "extension", "hidden.py"), "print('hidden')\n");
		const hiddenAttestation = await hiddenCandidate.provider.attestPatch(hiddenCandidate.materialized.lease, 1_004);
		await assert.rejects(
			() =>
				hiddenCandidate.builder.build({
					lease: hiddenCandidate.materialized.lease,
					attestation: hiddenAttestation,
					ownerPrincipal,
					agentId,
					graphId,
					allowedCapabilities: new Set(),
					now: 1_005,
				}),
			/file set differ/,
		);

		const invalidCandidate = await authorCandidate({ source: "def summarize_manifest(:\n    pass\n" });
		await assert.rejects(
			() =>
				invalidCandidate.builder.build({
					lease: invalidCandidate.materialized.lease,
					attestation: invalidCandidate.attestation,
					ownerPrincipal,
					agentId,
					graphId,
					allowedCapabilities: new Set(),
					now: 1_003,
				}),
			PrimeExtensionFault,
		);
	});

	it("enforces owner authorization and artifact quarantine independently of physical dedupe", async () => {
		const candidate = await authorCandidate();
		const built = await candidate.builder.build({
			lease: candidate.materialized.lease,
			attestation: candidate.attestation,
			ownerPrincipal,
			agentId,
			graphId,
			allowedCapabilities: new Set(),
			now: 1_003,
		});
		await assert.rejects(
			() => candidate.builder.resolveArtifact("user:someone-else", built.artifactRef),
			/owner mismatch/,
		);
		await candidate.builder.quarantine(ownerPrincipal, built.artifactRef, "adversarial evaluator failure", 1_004);
		await assert.rejects(() => candidate.builder.resolveArtifact(ownerPrincipal, built.artifactRef), /quarantined/);
	});
});
