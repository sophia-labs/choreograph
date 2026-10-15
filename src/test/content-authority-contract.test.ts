import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assertFinalWorkerPromptReplay,
	assertVerifiedExecutionCapsuleReplay,
	ContentAuthorityContractFault,
	createFinalWorkerPromptReceipt,
	createVerifiedExecutionCapsule,
	reviewedSkillGuestPath,
	sha256Utf8,
	verifiedSkillDisclosures,
	verifySkillOverlay,
} from "../agent-runtime/content-authority-contract.js";
import { MEANINGFUL_OBJECT_REF_SCHEMA, type MeaningfulObjectRefV1 } from "../agent-runtime/meaningful-object.js";
import { isCanonicalGraphOwnerPrincipal } from "../graph-owner-principal.js";

function ref<Kind extends "prompt" | "skill" | "release-artifact" | "artifact">(
	kind: Kind,
	objectId: string,
	digestCharacter: string,
	version = "1",
): MeaningfulObjectRefV1<Kind> {
	return {
		schema: MEANINGFUL_OBJECT_REF_SCHEMA,
		kind,
		ownerPrincipal: "user:ada",
		graphId: "prime-lab",
		objectId,
		version,
		digest: `sha256:${digestCharacter.repeat(64)}`,
	};
}

const skillRef = ref("skill", "research", "b");
const artifactRef = ref("release-artifact", "research-extension", "c");
const artifactDigest = `sha256:${"d".repeat(64)}`;
const manifestRef = ref("artifact", "research-extension-manifest", "e");

function promptRefFor(renderedUtf8: string): MeaningfulObjectRefV1<"prompt"> {
	return {
		...ref("prompt", "prompt-researcher", "a"),
		digest: sha256Utf8(renderedUtf8),
	};
}

function overlay(
	input: {
		readonly skill?: MeaningfulObjectRefV1<"skill">;
		readonly disclosurePath?: string;
		readonly entrypointPath?: string;
		readonly artifact?: MeaningfulObjectRefV1<"release-artifact">;
		readonly manifest?: MeaningfulObjectRefV1<"artifact">;
	} = {},
) {
	const selectedSkill = input.skill ?? skillRef;
	const selectedArtifact = input.artifact ?? artifactRef;
	const selectedManifest = input.manifest ?? manifestRef;
	const disclosurePath = input.disclosurePath ?? "skills/research/SKILL.md";
	const entrypointPath = input.entrypointPath ?? "python/research.py";
	const disclosureDigest = `sha256:${"f".repeat(64)}`;
	const entrypointDigest = `sha256:${"0".repeat(64)}`;
	const manifest = {
		manifestRef: selectedManifest,
		manifestDigest: selectedManifest.digest,
		skillRef: selectedSkill,
		disclosure: { path: disclosurePath, digest: disclosureDigest },
		entrypoint: { path: entrypointPath, exportName: "run", digest: entrypointDigest },
	};
	return verifySkillOverlay({
		approval: {
			approvalRef: {
				ownerPrincipal: "user:ada",
				graphId: "prime-lab",
				objectId: "review-research-v1",
				version: "1",
				digest: `sha256:${"1".repeat(64)}`,
			},
			state: "approved",
			skillRef: selectedSkill,
			artifactRef: selectedArtifact,
			artifactDigest,
			manifest,
		},
		selection: {
			skillRef: selectedSkill,
			artifactRef: selectedArtifact,
			artifactDigest,
			manifestRef: selectedManifest,
			manifestDigest: selectedManifest.digest,
		},
		artifact: { artifactRef: selectedArtifact, observedArtifactDigest: artifactDigest, state: "available" },
		mount: {
			artifactRef: selectedArtifact,
			observedArtifactDigest: artifactDigest,
			guestPath: reviewedSkillGuestPath(artifactDigest),
			mode: "ro",
			observedManifestDigest: selectedManifest.digest,
			verifiedFiles: [
				{ path: disclosurePath, digest: disclosureDigest },
				{ path: entrypointPath, digest: entrypointDigest },
			],
		},
	});
}

describe("I1/I2 content authority contracts", () => {
	it("uses the shared canonical owner and bounded identifier grammar", () => {
		for (const principal of ["user:ada", "agent:worker-1", "service:choreograph", "organization:sophia-labs"]) {
			assert.equal(isCanonicalGraphOwnerPrincipal(principal), true, principal);
		}
		for (const principal of ["root", "user:with space", "team:ada", "user:"]) {
			assert.equal(isCanonicalGraphOwnerPrincipal(principal), false, principal);
		}
	});

	it("receipts the final exact worker prompt after host composition and replays only those bytes", () => {
		const renderedUtf8 = "You are a careful researcher.";
		const receipt = createFinalWorkerPromptReceipt({
			source: { promptRef: promptRefFor(renderedUtf8), renderedUtf8 },
			transforms: [
				{ transformId: "domain-charter.v1", appendUtf8: "\n\n## Charter\nRemain within the reviewed scope." },
				{ transformId: "host-policy.v1", appendUtf8: "\n\nA proposal is not permission." },
			],
		});
		assert.equal(receipt.source.renderedDigest, sha256Utf8(renderedUtf8));
		assert.equal(
			receipt.finalPromptUtf8,
			"You are a careful researcher.\n\n## Charter\nRemain within the reviewed scope.\n\nA proposal is not permission.",
		);
		assertFinalWorkerPromptReplay(receipt, receipt.finalPromptUtf8);
		assert.throws(
			() => assertFinalWorkerPromptReplay(receipt, `${receipt.finalPromptUtf8}\nambient change`),
			(error: unknown) => error instanceof ContentAuthorityContractFault && error.code === "prompt_replay_drift",
		);
	});

	it("rejects source bytes that differ from the current Domain prompt Meaningful Object pin", () => {
		assert.throws(
			() =>
				createFinalWorkerPromptReceipt({
					source: { promptRef: promptRefFor("reviewed source"), renderedUtf8: "poisoned source" },
				}),
			(error: unknown) => error instanceof ContentAuthorityContractFault && error.code === "prompt_digest_mismatch",
		);
	});

	it("detects receipt poison when a host transform changes after admission", () => {
		const renderedUtf8 = "base";
		const receipt = createFinalWorkerPromptReceipt({
			source: { promptRef: promptRefFor(renderedUtf8), renderedUtf8 },
			transforms: [{ transformId: "policy.v1", appendUtf8: "\nrule" }],
		});
		const poisoned = {
			...receipt,
			transforms: [{ ...receipt.transforms[0]!, appendUtf8: "\nchanged rule" }],
		};
		assert.throws(
			() => assertFinalWorkerPromptReplay(poisoned, poisoned.finalPromptUtf8),
			(error: unknown) => error instanceof ContentAuthorityContractFault && error.code === "prompt_digest_mismatch",
		);
	});

	it("requires separately approved, selected, available, and read-only mounted skill bytes", () => {
		const verified = overlay();
		assert.equal(verified.selection.skillRef.objectId, "research");
		assert.equal(verified.mount.guestPath, reviewedSkillGuestPath(artifactDigest));
		assert.throws(
			() =>
				verifySkillOverlay({
					approval: verified.approval,
					selection: verified.selection,
					artifact: verified.artifact,
					mount: { ...verified.mount, observedArtifactDigest: `sha256:${"2".repeat(64)}` },
				}),
			(error: unknown) => error instanceof ContentAuthorityContractFault && error.code === "overlay_poisoned",
		);
		assert.throws(
			() =>
				verifySkillOverlay({
					approval: verified.approval,
					selection: verified.selection,
					artifact: undefined,
					mount: undefined,
				}),
			(error: unknown) => error instanceof ContentAuthorityContractFault && error.code === "overlay_missing",
		);
	});

	it("binds prompt and manifest-exact skill disclosures into one replayable execution capsule", () => {
		const prompt = createFinalWorkerPromptReceipt({
			source: { promptRef: promptRefFor("base"), renderedUtf8: "base" },
		});
		const capsule = createVerifiedExecutionCapsule({ prompt, skills: [overlay()] });
		assertVerifiedExecutionCapsuleReplay(capsule, "base");
		assert.deepEqual(verifiedSkillDisclosures(capsule), [
			{
				skillRef,
				artifactDigest,
				manifestRef,
				manifestDigest: manifestRef.digest,
				skillDocumentPath: `${reviewedSkillGuestPath(artifactDigest)}/skills/research/SKILL.md`,
				skillDocumentDigest: `sha256:${"f".repeat(64)}`,
				entrypointPath: `${reviewedSkillGuestPath(artifactDigest)}/python/research.py`,
				entrypointExportName: "run",
				entrypointDigest: `sha256:${"0".repeat(64)}`,
			},
		]);
		const poisoned = {
			...capsule,
			skills: [
				{
					...capsule.skills[0]!,
					mount: {
						...capsule.skills[0]!.mount,
						guestPath:
							"/opt/sophia/reviewed-skills/sha256-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					},
				},
			],
		};
		assert.throws(
			() => assertVerifiedExecutionCapsuleReplay(poisoned, "base"),
			(error: unknown) => error instanceof ContentAuthorityContractFault && error.code === "overlay_poisoned",
		);
	});

	it("rejects a second reviewed version of one logical skill", () => {
		const prompt = createFinalWorkerPromptReceipt({
			source: { promptRef: promptRefFor("base"), renderedUtf8: "base" },
		});
		const versionTwo = ref("skill", "research", "3", "2");
		assert.throws(
			() => createVerifiedExecutionCapsule({ prompt, skills: [overlay(), overlay({ skill: versionTwo })] }),
			(error: unknown) => error instanceof ContentAuthorityContractFault && error.code === "duplicate_skill",
		);
	});

	it("rejects multiple reviewed skills carried by one overlay artifact", () => {
		const prompt = createFinalWorkerPromptReceipt({
			source: { promptRef: promptRefFor("base"), renderedUtf8: "base" },
		});
		const otherSkill = ref("skill", "other-research", "4");
		const otherManifest = ref("artifact", "other-research-extension-manifest", "6");
		assert.throws(
			() =>
				createVerifiedExecutionCapsule({
					prompt,
					skills: [overlay(), overlay({ skill: otherSkill, manifest: otherManifest })],
				}),
			(error: unknown) =>
				error instanceof ContentAuthorityContractFault && error.code === "duplicate_overlay_artifact",
		);
	});

	it("rejects conflicting disclosure and entrypoint paths even for distinct skills", () => {
		const prompt = createFinalWorkerPromptReceipt({
			source: { promptRef: promptRefFor("base"), renderedUtf8: "base" },
		});
		const otherSkill = ref("skill", "other-research", "4");
		const otherArtifact = ref("release-artifact", "other-research-extension", "5");
		const otherManifest = ref("artifact", "other-research-extension-manifest", "6");
		assert.throws(
			() =>
				createVerifiedExecutionCapsule({
					prompt,
					skills: [overlay(), overlay({ skill: otherSkill, artifact: otherArtifact, manifest: otherManifest })],
				}),
			(error: unknown) =>
				error instanceof ContentAuthorityContractFault && error.code === "disclosure_path_collision",
		);
		assert.throws(
			() =>
				createVerifiedExecutionCapsule({
					prompt,
					skills: [
						overlay(),
						overlay({
							skill: otherSkill,
							artifact: otherArtifact,
							manifest: otherManifest,
							disclosurePath: "skills/other/SKILL.md",
							entrypointPath: "python/research.py",
						}),
					],
				}),
			(error: unknown) =>
				error instanceof ContentAuthorityContractFault && error.code === "entrypoint_path_collision",
		);
	});
});
