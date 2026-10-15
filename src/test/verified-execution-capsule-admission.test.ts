import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createFinalWorkerPromptReceipt,
	reviewedSkillGuestPath,
	type SkillActivationSelectionV1,
	type SkillReviewApprovalV1,
	sha256Utf8,
	verifiedSkillDisclosures,
} from "../agent-runtime/content-authority-contract.js";
import { MEANINGFUL_OBJECT_REF_SCHEMA, type MeaningfulObjectRefV1 } from "../agent-runtime/meaningful-object.js";
import {
	admitVerifiedExecutionCapsule,
	digestReviewedSkillOverlayArtifact,
	digestReviewedSkillOverlayManifest,
	type ImmutableCasArtifactFileV1,
	type ReviewedSkillOverlayManifestV1,
	VerifiedExecutionCapsuleAdmissionFault,
} from "../agent-runtime/verified-execution-capsule-admission.js";

const encoder = new TextEncoder();

function ref<Kind extends "prompt" | "skill" | "release-artifact" | "artifact">(
	kind: Kind,
	objectId: string,
	digest: string,
): MeaningfulObjectRefV1<Kind> {
	return {
		schema: MEANINGFUL_OBJECT_REF_SCHEMA,
		kind,
		ownerPrincipal: "user:ada",
		graphId: "prime-lab",
		objectId,
		version: "1",
		digest,
	};
}

function cloneFiles(files: readonly ImmutableCasArtifactFileV1[]): ImmutableCasArtifactFileV1[] {
	return files.map((file) => ({ path: file.path, bytes: new Uint8Array(file.bytes) }));
}

function fixture(): {
	readonly prompt: ReturnType<typeof createFinalWorkerPromptReceipt>;
	readonly approval: SkillReviewApprovalV1;
	readonly selection: SkillActivationSelectionV1;
	readonly files: readonly ImmutableCasArtifactFileV1[];
} {
	const disclosureBytes = encoder.encode("# Reviewed research skill\n");
	const entrypointBytes = encoder.encode("export function run(): void {}\n");
	const skillRef = ref("skill", "research", `sha256:${"b".repeat(64)}`);
	const manifest: ReviewedSkillOverlayManifestV1 = {
		schema: "sophia.reviewed-skill-overlay-manifest.v1",
		skillRef,
		disclosure: { path: "skills/research/SKILL.md", digest: sha256Utf8("# Reviewed research skill\n") },
		entrypoint: {
			path: "python/research.ts",
			exportName: "run",
			digest: sha256Utf8("export function run(): void {}\n"),
		},
		files: [
			{ path: "python/research.ts", digest: sha256Utf8("export function run(): void {}\n") },
			{ path: "skills/research/SKILL.md", digest: sha256Utf8("# Reviewed research skill\n") },
		],
	};
	const manifestDigest = digestReviewedSkillOverlayManifest(manifest);
	const artifactDigest = digestReviewedSkillOverlayArtifact({ manifestDigest, files: manifest.files });
	const artifactRef = ref("release-artifact", "research-extension", `sha256:${"c".repeat(64)}`);
	const manifestRef = ref("artifact", "research-extension-manifest", manifestDigest);
	const approval: SkillReviewApprovalV1 = {
		approvalRef: {
			ownerPrincipal: "user:ada",
			graphId: "prime-lab",
			objectId: "review-research-v1",
			version: "1",
			digest: `sha256:${"d".repeat(64)}`,
		},
		state: "approved",
		skillRef,
		artifactRef,
		artifactDigest,
		manifest: {
			manifestRef,
			manifestDigest,
			skillRef,
			disclosure: manifest.disclosure,
			entrypoint: manifest.entrypoint,
		},
	};
	const selection: SkillActivationSelectionV1 = {
		skillRef,
		artifactRef,
		artifactDigest,
		manifestRef,
		manifestDigest,
	};
	const source = "You are the admitted researcher.";
	const prompt = createFinalWorkerPromptReceipt({
		source: { promptRef: ref("prompt", "research-prompt", sha256Utf8(source)), renderedUtf8: source },
		transforms: [{ transformId: "domain-policy.v1", appendUtf8: "\nReturn proposals, not ambient changes." }],
	});
	return {
		prompt,
		approval,
		selection,
		files: [
			{ path: "manifest.json", bytes: encoder.encode(JSON.stringify(manifest)) },
			{ path: "skills/research/SKILL.md", bytes: disclosureBytes },
			{ path: "python/research.ts", bytes: entrypointBytes },
		],
	};
}

describe("I2 verified execution-capsule admission", () => {
	it("resolves explicitly selected reviewed CAS bytes into deterministic read-only witnesses before queueing", async () => {
		const input = fixture();
		let reads = 0;
		const resolver = {
			readArtifact: ({ artifactRef }: { readonly artifactRef: MeaningfulObjectRefV1<"release-artifact"> }) => {
				reads += 1;
				assert.deepEqual(artifactRef, input.selection.artifactRef);
				return { files: cloneFiles(input.files) };
			},
		};
		const admitted = await admitVerifiedExecutionCapsule(
			{
				prompt: input.prompt,
				overlays: [{ approval: input.approval, selection: input.selection }],
			},
			resolver,
		);
		const replayedAdmission = await admitVerifiedExecutionCapsule(
			{
				prompt: input.prompt,
				overlays: [{ approval: input.approval, selection: input.selection }],
			},
			resolver,
		);
		assert.equal(reads, 2);
		assert.equal(admitted.schema, "sophia.verified-execution-capsule-admission.v1");
		assert.equal(admitted.overlays[0]?.mount.mode, "ro");
		assert.equal(admitted.overlays[0]?.mount.guestPath, reviewedSkillGuestPath(input.selection.artifactDigest));
		assert.equal(replayedAdmission.capsule.digest, admitted.capsule.digest);
		assert.deepEqual(verifiedSkillDisclosures(admitted.capsule), [
			{
				skillRef: input.selection.skillRef,
				artifactDigest: input.selection.artifactDigest,
				manifestRef: input.selection.manifestRef,
				manifestDigest: input.selection.manifestDigest,
				skillDocumentPath: `${reviewedSkillGuestPath(input.selection.artifactDigest)}/skills/research/SKILL.md`,
				skillDocumentDigest: sha256Utf8("# Reviewed research skill\n"),
				entrypointPath: `${reviewedSkillGuestPath(input.selection.artifactDigest)}/python/research.ts`,
				entrypointExportName: "run",
				entrypointDigest: sha256Utf8("export function run(): void {}\n"),
			},
		]);
	});

	it("fails closed when the selected immutable artifact is unavailable", async () => {
		const input = fixture();
		await assert.rejects(
			() =>
				admitVerifiedExecutionCapsule(
					{
						prompt: input.prompt,
						overlays: [{ approval: input.approval, selection: input.selection }],
					},
					{ readArtifact: () => undefined },
				),
			(error: unknown) =>
				error instanceof VerifiedExecutionCapsuleAdmissionFault && error.code === "artifact_missing",
		);
	});

	it("fails closed when CAS has undeclared bytes or a reviewed file is poisoned", async () => {
		const input = fixture();
		const withExtraFile = [
			...cloneFiles(input.files),
			{ path: "ambient/secret.txt", bytes: encoder.encode("do not discover me") },
		];
		await assert.rejects(
			() =>
				admitVerifiedExecutionCapsule(
					{
						prompt: input.prompt,
						overlays: [{ approval: input.approval, selection: input.selection }],
					},
					{ readArtifact: () => ({ files: withExtraFile }) },
				),
			(error: unknown) =>
				error instanceof VerifiedExecutionCapsuleAdmissionFault && error.code === "artifact_corrupt",
		);
		const poisonedFiles = cloneFiles(input.files);
		const disclosure = poisonedFiles.find((file) => file.path === "skills/research/SKILL.md");
		if (!disclosure) throw new Error("fixture disclosure missing");
		disclosure.bytes = encoder.encode("# Poisoned skill\n");
		await assert.rejects(
			() =>
				admitVerifiedExecutionCapsule(
					{
						prompt: input.prompt,
						overlays: [{ approval: input.approval, selection: input.selection }],
					},
					{ readArtifact: () => ({ files: poisonedFiles }) },
				),
			(error: unknown) =>
				error instanceof VerifiedExecutionCapsuleAdmissionFault && error.code === "artifact_poisoned",
		);
	});

	it("fails closed when an injected manifest moves the reviewed skill coordinate", async () => {
		const input = fixture();
		const files = cloneFiles(input.files);
		const manifest = JSON.parse(new TextDecoder().decode(files[0]?.bytes)) as ReviewedSkillOverlayManifestV1;
		const poisonedManifest = {
			...manifest,
			skillRef: { ...manifest.skillRef, objectId: "ambient-skill" },
		};
		files[0] = { path: "manifest.json", bytes: encoder.encode(JSON.stringify(poisonedManifest)) };
		await assert.rejects(
			() =>
				admitVerifiedExecutionCapsule(
					{
						prompt: input.prompt,
						overlays: [{ approval: input.approval, selection: input.selection }],
					},
					{ readArtifact: () => ({ files }) },
				),
			(error: unknown) =>
				error instanceof VerifiedExecutionCapsuleAdmissionFault && error.code === "artifact_poisoned",
		);
	});
});
