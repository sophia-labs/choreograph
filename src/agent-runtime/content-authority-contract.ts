import { createHash } from "node:crypto";
import { canonicalJson } from "@sophia-labs/canonical-json";
import { isCanonicalGraphOwnerPrincipal } from "../graph-owner-principal.js";
import {
	type MeaningfulObjectRefV1,
	sameMeaningfulObjectRef,
	validateMeaningfulObjectRef,
} from "./meaningful-object.js";

/**
 * I1/I2 keystone: final worker bytes, not a mutable document, are prompt
 * authority. Review approval, CAS availability, activation selection, and a
 * read-only mount remain separate facts until this contract joins them into a
 * replayable execution capsule.
 */
export const FINAL_WORKER_PROMPT_RECEIPT_SCHEMA = "sophia.final-worker-prompt-receipt.v1" as const;
export const CONTENT_AUTHORITY_BINDING_SCHEMA = "sophia.content-authority-binding.v1" as const;
export const VERIFIED_SKILL_OVERLAY_SCHEMA = "sophia.verified-skill-overlay.v1" as const;
export const VERIFIED_EXECUTION_CAPSULE_SCHEMA = "sophia.verified-execution-capsule.v1" as const;
export const REVIEWED_SKILL_GUEST_ROOT = "/opt/sophia/reviewed-skills" as const;

export interface PromptSourceReceiptV1 {
	readonly promptRef: MeaningfulObjectRefV1<"prompt">;
	/** Exact UTF-8 text emitted by the source renderer selected by promptRef. */
	readonly renderedUtf8: string;
	/** Current Domain prompt pins require this to equal promptRef.digest exactly. */
	readonly renderedDigest: string;
}

export interface PromptTransformInputV1 {
	/** Stable identifier for the host-owned composition rule, never prose alone. */
	readonly transformId: string;
	/** Exact UTF-8 bytes appended by that rule. */
	readonly appendUtf8: string;
}

export interface PromptTransformReceiptV1 extends PromptTransformInputV1 {
	readonly appendDigest: string;
	readonly inputDigest: string;
	readonly outputDigest: string;
}

export interface FinalWorkerPromptReceiptV1 {
	readonly schema: typeof FINAL_WORKER_PROMPT_RECEIPT_SCHEMA;
	readonly source: PromptSourceReceiptV1;
	readonly transforms: readonly PromptTransformReceiptV1[];
	/** The one exact UTF-8 string supplied to Prime's systemPrompt. */
	readonly finalPromptUtf8: string;
	readonly finalPromptDigest: string;
}

export interface ContentAuthorityRefV1 {
	readonly ownerPrincipal: string;
	readonly graphId: string;
	readonly objectId: string;
	readonly version: string;
	readonly digest: string;
}

/** A reviewed approval says what may run; it does not activate or mount it. */
export interface SkillReviewApprovalV1 {
	readonly approvalRef: ContentAuthorityRefV1;
	readonly state: "approved";
	readonly skillRef: MeaningfulObjectRefV1<"skill">;
	readonly artifactRef: MeaningfulObjectRefV1<"release-artifact">;
	readonly artifactDigest: string;
	readonly manifest: SkillOverlayManifestV1;
}

/** I2 begins with exactly one reviewed skill per mounted overlay artifact. */
export const MAX_REVIEWED_SKILLS_PER_OVERLAY = 1;

/**
 * A digest-pinned manifest coordinate and the two exact paths Prime may use.
 * No caller may turn a skill name into a filesystem search.
 */
export interface SkillOverlayManifestV1 {
	readonly manifestRef: MeaningfulObjectRefV1<"artifact">;
	readonly manifestDigest: string;
	readonly skillRef: MeaningfulObjectRefV1<"skill">;
	readonly disclosure: {
		readonly path: string;
		readonly digest: string;
	};
	readonly entrypoint: {
		readonly path: string;
		readonly exportName: string;
		readonly digest: string;
	};
}

/** CAS availability is an observed byte fact, not an approval decision. */
export interface ArtifactAvailabilityWitnessV1 {
	readonly artifactRef: MeaningfulObjectRefV1<"release-artifact">;
	readonly observedArtifactDigest: string;
	readonly state: "available";
}

/** Selection is activation state and requires its own explicit authoritative input. */
export interface SkillActivationSelectionV1 {
	readonly skillRef: MeaningfulObjectRefV1<"skill">;
	readonly artifactRef: MeaningfulObjectRefV1<"release-artifact">;
	readonly artifactDigest: string;
	readonly manifestRef: MeaningfulObjectRefV1<"artifact">;
	readonly manifestDigest: string;
}

/**
 * The one opt-in boundary for I authority. It is intentionally complete: a
 * prompt receipt without the reviewed selection, or a selection without the
 * receipt, is not an I-authoritative execution.
 */
export interface ContentAuthorityBindingV1 {
	readonly schema: typeof CONTENT_AUTHORITY_BINDING_SCHEMA;
	readonly prompt: FinalWorkerPromptReceiptV1;
	readonly reviewedSkill: {
		readonly approval: SkillReviewApprovalV1;
		readonly selection: SkillActivationSelectionV1;
	};
}

/** The sandbox boundary must attest a read-only mount of the selected bytes. */
export interface ReadOnlyOverlayMountWitnessV1 {
	readonly artifactRef: MeaningfulObjectRefV1<"release-artifact">;
	readonly observedArtifactDigest: string;
	readonly guestPath: string;
	readonly mode: "ro";
	readonly observedManifestDigest: string;
	readonly verifiedFiles: readonly ReadOnlyOverlayFileWitnessV1[];
}

/** Exact file facts emitted only after the generalized verifier has read bytes. */
export interface ReadOnlyOverlayFileWitnessV1 {
	readonly path: string;
	readonly digest: string;
}

export interface VerifiedSkillOverlayV1 {
	readonly schema: typeof VERIFIED_SKILL_OVERLAY_SCHEMA;
	readonly approval: SkillReviewApprovalV1;
	readonly selection: SkillActivationSelectionV1;
	readonly artifact: ArtifactAvailabilityWitnessV1;
	readonly mount: ReadOnlyOverlayMountWitnessV1;
}

export interface VerifiedExecutionCapsuleV1 {
	readonly schema: typeof VERIFIED_EXECUTION_CAPSULE_SCHEMA;
	readonly prompt: FinalWorkerPromptReceiptV1;
	readonly skills: readonly VerifiedSkillOverlayV1[];
	readonly digest: string;
}

/** The only skill-to-path projection a Prime composition root may disclose. */
export interface VerifiedSkillDisclosureV1 {
	readonly skillRef: MeaningfulObjectRefV1<"skill">;
	readonly artifactDigest: string;
	readonly manifestRef: MeaningfulObjectRefV1<"artifact">;
	readonly manifestDigest: string;
	readonly skillDocumentPath: string;
	readonly skillDocumentDigest: string;
	readonly entrypointPath: string;
	readonly entrypointExportName: string;
	readonly entrypointDigest: string;
}

export type ContentAuthorityFaultCode =
	| "content_authority_invalid"
	| "prompt_digest_mismatch"
	| "prompt_replay_drift"
	| "review_not_approved"
	| "review_selection_mismatch"
	| "overlay_missing"
	| "overlay_poisoned"
	| "overlay_not_read_only"
	| "duplicate_skill"
	| "duplicate_overlay_artifact"
	| "disclosure_path_collision"
	| "entrypoint_path_collision"
	| "capsule_digest_mismatch";

export class ContentAuthorityContractFault extends Error {
	constructor(
		readonly code: ContentAuthorityFaultCode,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "ContentAuthorityContractFault";
	}
}

export function sha256Utf8(value: string): string {
	assertUtf8(value, "value");
	return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function createFinalWorkerPromptReceipt(input: {
	readonly source: {
		readonly promptRef: MeaningfulObjectRefV1<"prompt">;
		readonly renderedUtf8: string;
	};
	readonly transforms?: readonly PromptTransformInputV1[];
}): FinalWorkerPromptReceiptV1 {
	validateBoundMeaningfulObjectRef(input.source.promptRef, "prompt");
	assertNonEmptyUtf8(input.source.renderedUtf8, "source.renderedUtf8");
	const renderedDigest = sha256Utf8(input.source.renderedUtf8);
	if (input.source.promptRef.digest !== renderedDigest) {
		throw fault("prompt_digest_mismatch", "prompt Meaningful Object does not pin the rendered source bytes", {
			expected: renderedDigest,
			actual: input.source.promptRef.digest,
		});
	}
	const source: PromptSourceReceiptV1 = {
		promptRef: input.source.promptRef,
		renderedUtf8: input.source.renderedUtf8,
		renderedDigest,
	};
	const transformIds = new Set<string>();
	let finalPromptUtf8 = source.renderedUtf8;
	let inputDigest = source.renderedDigest;
	const transforms = (input.transforms ?? []).map((transform): PromptTransformReceiptV1 => {
		assertOpaqueContentId(transform.transformId, "transform.transformId");
		if (transformIds.has(transform.transformId)) {
			throw fault("content_authority_invalid", "prompt transform identifiers must be unique", {
				transformId: transform.transformId,
			});
		}
		transformIds.add(transform.transformId);
		assertUtf8(transform.appendUtf8, `transform '${transform.transformId}' appendUtf8`);
		const appendDigest = sha256Utf8(transform.appendUtf8);
		finalPromptUtf8 += transform.appendUtf8;
		const outputDigest = sha256Utf8(finalPromptUtf8);
		const receipt = { ...transform, appendDigest, inputDigest, outputDigest };
		inputDigest = outputDigest;
		return receipt;
	});
	return {
		schema: FINAL_WORKER_PROMPT_RECEIPT_SCHEMA,
		source,
		transforms,
		finalPromptUtf8,
		finalPromptDigest: sha256Utf8(finalPromptUtf8),
	};
}

export function assertFinalWorkerPromptReceipt(receipt: FinalWorkerPromptReceiptV1): void {
	assertExactKeys(
		receipt,
		["schema", "source", "transforms", "finalPromptUtf8", "finalPromptDigest"],
		"final worker prompt receipt",
	);
	if (receipt.schema !== FINAL_WORKER_PROMPT_RECEIPT_SCHEMA) {
		throw fault("content_authority_invalid", "final worker prompt receipt schema is unsupported");
	}
	assertExactKeys(receipt.source, ["promptRef", "renderedUtf8", "renderedDigest"], "prompt source receipt");
	validateBoundMeaningfulObjectRef(receipt.source.promptRef, "prompt");
	assertNonEmptyUtf8(receipt.source.renderedUtf8, "receipt.source.renderedUtf8");
	assertDigest(receipt.source.renderedDigest, "receipt.source.renderedDigest");
	if (
		sha256Utf8(receipt.source.renderedUtf8) !== receipt.source.renderedDigest ||
		receipt.source.promptRef.digest !== receipt.source.renderedDigest
	) {
		throw fault("prompt_digest_mismatch", "source rendered digest does not match its exact UTF-8 bytes");
	}
	const transformIds = new Set<string>();
	let finalPromptUtf8 = receipt.source.renderedUtf8;
	let inputDigest = receipt.source.renderedDigest;
	for (const transform of receipt.transforms) {
		assertExactKeys(
			transform,
			["transformId", "appendUtf8", "appendDigest", "inputDigest", "outputDigest"],
			"prompt transform receipt",
		);
		assertOpaqueContentId(transform.transformId, "receipt transformId");
		if (transformIds.has(transform.transformId)) {
			throw fault("content_authority_invalid", "prompt transform identifiers must be unique", {
				transformId: transform.transformId,
			});
		}
		transformIds.add(transform.transformId);
		assertUtf8(transform.appendUtf8, `receipt transform '${transform.transformId}' appendUtf8`);
		if (sha256Utf8(transform.appendUtf8) !== transform.appendDigest || transform.inputDigest !== inputDigest) {
			throw fault("prompt_digest_mismatch", "prompt transform receipt has drifted", {
				transformId: transform.transformId,
			});
		}
		finalPromptUtf8 += transform.appendUtf8;
		inputDigest = sha256Utf8(finalPromptUtf8);
		if (transform.outputDigest !== inputDigest) {
			throw fault("prompt_digest_mismatch", "prompt transform output digest has drifted", {
				transformId: transform.transformId,
			});
		}
	}
	if (receipt.finalPromptUtf8 !== finalPromptUtf8 || receipt.finalPromptDigest !== inputDigest) {
		throw fault("prompt_digest_mismatch", "final worker prompt receipt does not reconstruct exact final bytes");
	}
}

/** Reject a restart/replay unless it supplies exactly the originally admitted bytes. */
export function assertFinalWorkerPromptReplay(receipt: FinalWorkerPromptReceiptV1, replayedUtf8: string): void {
	assertFinalWorkerPromptReceipt(receipt);
	assertUtf8(replayedUtf8, "replayedUtf8");
	if (replayedUtf8 !== receipt.finalPromptUtf8 || sha256Utf8(replayedUtf8) !== receipt.finalPromptDigest) {
		throw fault("prompt_replay_drift", "restart/replay must reuse the exact final worker prompt bytes");
	}
}

export function assertContentAuthorityBinding(binding: ContentAuthorityBindingV1): void {
	assertExactKeys(binding, ["schema", "prompt", "reviewedSkill"], "content authority binding");
	if (binding.schema !== CONTENT_AUTHORITY_BINDING_SCHEMA) {
		throw fault("content_authority_invalid", "content authority binding schema is unsupported");
	}
	assertExactKeys(binding.reviewedSkill, ["approval", "selection"], "reviewed skill binding");
	assertFinalWorkerPromptReceipt(binding.prompt);
	validateSkillReviewApproval(binding.reviewedSkill.approval);
	validateSkillSelection(binding.reviewedSkill.selection);
	assertReviewSelectionMatch(binding.reviewedSkill.approval, binding.reviewedSkill.selection);
}

/** The host, never a graph/caller, derives the sole reviewed-artifact mount coordinate. */
export function reviewedSkillGuestPath(artifactDigest: string): `${typeof REVIEWED_SKILL_GUEST_ROOT}/sha256-${string}` {
	assertDigest(artifactDigest, "reviewed skill artifact digest");
	return `${REVIEWED_SKILL_GUEST_ROOT}/sha256-${artifactDigest.slice("sha256:".length)}`;
}

export function verifySkillOverlay(input: {
	readonly approval: SkillReviewApprovalV1;
	readonly selection: SkillActivationSelectionV1;
	readonly artifact: ArtifactAvailabilityWitnessV1 | undefined;
	readonly mount: ReadOnlyOverlayMountWitnessV1 | undefined;
}): VerifiedSkillOverlayV1 {
	validateSkillReviewApproval(input.approval);
	validateSkillSelection(input.selection);
	if (!input.artifact || !input.mount) {
		throw fault("overlay_missing", "selected reviewed skill requires both CAS availability and a mount witness");
	}
	validateArtifactAvailability(input.artifact);
	validateMount(input.mount);
	const { approval, selection, artifact, mount } = input;
	assertReviewSelectionMatch(approval, selection);
	if (
		!sameMeaningfulObjectRef(selection.artifactRef, artifact.artifactRef) ||
		!sameMeaningfulObjectRef(selection.artifactRef, mount.artifactRef) ||
		selection.artifactDigest !== artifact.observedArtifactDigest ||
		selection.artifactDigest !== mount.observedArtifactDigest ||
		selection.manifestDigest !== mount.observedManifestDigest ||
		!hasVerifiedFile(mount, approval.manifest.disclosure) ||
		!hasVerifiedFile(mount, approval.manifest.entrypoint)
	) {
		throw fault("overlay_poisoned", "CAS availability or mount bytes differ from the selected reviewed artifact");
	}
	return { schema: VERIFIED_SKILL_OVERLAY_SCHEMA, approval, selection, artifact, mount };
}

export function createVerifiedExecutionCapsule(input: {
	readonly prompt: FinalWorkerPromptReceiptV1;
	readonly skills: readonly VerifiedSkillOverlayV1[];
}): VerifiedExecutionCapsuleV1 {
	assertFinalWorkerPromptReceipt(input.prompt);
	const skills = input.skills.map((skill) => {
		assertExactKeys(skill, ["schema", "approval", "selection", "artifact", "mount"], "verified skill overlay");
		if (skill.schema !== VERIFIED_SKILL_OVERLAY_SCHEMA) {
			throw fault("content_authority_invalid", "verified skill overlay schema is unsupported");
		}
		return verifySkillOverlay(skill);
	});
	const skillKeys = new Set<string>();
	const artifactKeys = new Set<string>();
	const disclosurePaths = new Set<string>();
	const entrypointPaths = new Set<string>();
	for (const skill of skills) {
		const key = logicalSkillKey(skill.selection.skillRef);
		if (skillKeys.has(key))
			throw fault("duplicate_skill", "execution capsule has a duplicate selected skill", { key });
		skillKeys.add(key);
		const artifactKey = fullMeaningfulObjectKey(skill.selection.artifactRef);
		if (artifactKeys.has(artifactKey)) {
			throw fault("duplicate_overlay_artifact", "I2 permits exactly one reviewed skill per overlay artifact", {
				artifactKey,
			});
		}
		artifactKeys.add(artifactKey);
		const disclosurePath = skillDisclosurePath(skill.mount.guestPath, skill.approval.manifest.disclosure.path);
		if (disclosurePaths.has(disclosurePath)) {
			throw fault("disclosure_path_collision", "execution capsule maps multiple skills to one disclosure path", {
				disclosurePath,
			});
		}
		disclosurePaths.add(disclosurePath);
		const entrypointPath = skillDisclosurePath(skill.mount.guestPath, skill.approval.manifest.entrypoint.path);
		if (entrypointPaths.has(entrypointPath)) {
			throw fault("entrypoint_path_collision", "execution capsule maps multiple skills to one entrypoint path", {
				entrypointPath,
			});
		}
		entrypointPaths.add(entrypointPath);
	}
	const unsigned = { schema: VERIFIED_EXECUTION_CAPSULE_SCHEMA, prompt: input.prompt, skills };
	return { ...unsigned, digest: digestCanonical(unsigned) };
}

export function assertVerifiedExecutionCapsuleReplay(
	capsule: VerifiedExecutionCapsuleV1,
	replayedFinalPromptUtf8: string,
): void {
	assertExactKeys(capsule, ["schema", "prompt", "skills", "digest"], "verified execution capsule");
	if (capsule.schema !== VERIFIED_EXECUTION_CAPSULE_SCHEMA) {
		throw fault("content_authority_invalid", "verified execution capsule schema is unsupported");
	}
	assertFinalWorkerPromptReplay(capsule.prompt, replayedFinalPromptUtf8);
	const rebuilt = createVerifiedExecutionCapsule({ prompt: capsule.prompt, skills: capsule.skills });
	if (rebuilt.digest !== capsule.digest) {
		throw fault("capsule_digest_mismatch", "execution capsule has drifted and may not be replayed");
	}
}

/**
 * Deliberately derives disclosure from a verified capsule rather than from
 * ambient skill discovery or a name-only ontology filter.
 */
export function verifiedSkillDisclosures(capsule: VerifiedExecutionCapsuleV1): readonly VerifiedSkillDisclosureV1[] {
	assertVerifiedExecutionCapsuleReplay(capsule, capsule.prompt.finalPromptUtf8);
	return capsule.skills.map((skill) => ({
		skillRef: skill.selection.skillRef,
		artifactDigest: skill.selection.artifactDigest,
		manifestRef: skill.approval.manifest.manifestRef,
		manifestDigest: skill.approval.manifest.manifestDigest,
		skillDocumentPath: skillDisclosurePath(skill.mount.guestPath, skill.approval.manifest.disclosure.path),
		skillDocumentDigest: skill.approval.manifest.disclosure.digest,
		entrypointPath: skillDisclosurePath(skill.mount.guestPath, skill.approval.manifest.entrypoint.path),
		entrypointExportName: skill.approval.manifest.entrypoint.exportName,
		entrypointDigest: skill.approval.manifest.entrypoint.digest,
	}));
}

/**
 * Frozen minimal wiring plan. These are future owners/leases, not permissions
 * for this letter to alter the named files.
 */
export const CONTENT_AUTHORITY_MINIMAL_IMPLEMENTATION_PLAN = [
	{
		file: "src/agent-runtime/content-authority-contract.ts",
		owner: "Terra I",
		change: "Pure I1/I2 receipt, verified overlay, poison, and replay contract.",
	},
	{
		file: "src/workflow/domain-agent-config.ts",
		owner: "future composition lease",
		change: "Build and persist the final worker-prompt receipt when host charter/policy segments are composed.",
	},
	{
		file: "src/agent-runtime/verified-execution-capsule-admission.ts (new)",
		owner: "future content-admission lease",
		change:
			"Resolve approved selections from CAS, recompute artifact bytes, and seal read-only staging mounts before calling the spawner.",
	},
	{
		file: "src/workflow/types.ts + src/workflow/run-node.ts",
		owner: "future composition lease",
		change:
			"Carry the immutable execution capsule into AgentWorkerConfig without recomposition or ambient skill discovery.",
	},
	{
		file: "src/workflow/runtime-store.ts",
		owner: "Terra G/root lease",
		change:
			"Persist the final prompt receipt and verified capsule with the durable materialization so restart never recompiles them.",
	},
	{
		file: "src/spawner.ts",
		owner: "Terra G/root lease",
		change:
			"Require the sealed capsule before queue creation or any proxy/browser/catalog resource minting; mount only its verified paths.",
	},
	{
		file: "packages/coding-agent/src/sophia/host-protocol.ts",
		owner: "Prime Sophia composition owner",
		change: "Carry the receipt/capsule and verified skill disclosures on the Sophia host protocol.",
	},
	{
		file: "packages/coding-agent/src/sophia/host-worker.ts",
		owner: "Prime Sophia composition owner",
		change:
			"Before workspace/agent/session creation, recheck final prompt receipt and capsule digest; disclose only the verified skill-to-mounted-path mapping.",
	},
] as const;

function validateSkillReviewApproval(value: SkillReviewApprovalV1): void {
	assertExactKeys(
		value,
		["approvalRef", "state", "skillRef", "artifactRef", "artifactDigest", "manifest"],
		"skill review approval",
	);
	validateContentAuthorityRef(value.approvalRef, "approvalRef");
	if (value.state !== "approved") throw fault("review_not_approved", "skill review is not approved");
	validateBoundMeaningfulObjectRef(value.skillRef, "skill");
	validateBoundMeaningfulObjectRef(value.artifactRef, "release-artifact");
	assertDigest(value.artifactDigest, "approval.artifactDigest");
	validateSkillOverlayManifest(value.manifest);
	if (!sameMeaningfulObjectRef(value.skillRef, value.manifest.skillRef)) {
		throw fault("review_selection_mismatch", "review approval skill and manifest skill differ");
	}
}

function validateSkillSelection(value: SkillActivationSelectionV1): void {
	assertExactKeys(
		value,
		["skillRef", "artifactRef", "artifactDigest", "manifestRef", "manifestDigest"],
		"skill activation selection",
	);
	validateBoundMeaningfulObjectRef(value.skillRef, "skill");
	validateBoundMeaningfulObjectRef(value.artifactRef, "release-artifact");
	assertDigest(value.artifactDigest, "selection.artifactDigest");
	validateBoundMeaningfulObjectRef(value.manifestRef, "artifact");
	assertDigest(value.manifestDigest, "selection.manifestDigest");
}

function validateArtifactAvailability(value: ArtifactAvailabilityWitnessV1): void {
	assertExactKeys(value, ["artifactRef", "observedArtifactDigest", "state"], "artifact availability witness");
	validateBoundMeaningfulObjectRef(value.artifactRef, "release-artifact");
	if (value.state !== "available") throw fault("overlay_missing", "selected artifact is not available from CAS");
	assertDigest(value.observedArtifactDigest, "artifact.observedArtifactDigest");
}

function validateMount(value: ReadOnlyOverlayMountWitnessV1): void {
	assertExactKeys(
		value,
		["artifactRef", "observedArtifactDigest", "guestPath", "mode", "observedManifestDigest", "verifiedFiles"],
		"read-only overlay mount witness",
	);
	validateBoundMeaningfulObjectRef(value.artifactRef, "release-artifact");
	assertDigest(value.observedArtifactDigest, "mount.observedArtifactDigest");
	assertDigest(value.observedManifestDigest, "mount.observedManifestDigest");
	if (value.mode !== "ro") throw fault("overlay_not_read_only", "selected overlay mount must be read-only");
	if (value.guestPath !== reviewedSkillGuestPath(value.observedArtifactDigest)) {
		throw fault("overlay_poisoned", "reviewed skill mount must use the host-derived artifact digest path");
	}
	const paths = new Set<string>();
	for (const file of value.verifiedFiles) {
		assertExactKeys(file, ["path", "digest"], "read-only overlay file witness");
		assertSafeOverlayRelativePath(file.path, "mount.verifiedFiles.path");
		assertDigest(file.digest, `mount verified file '${file.path}' digest`);
		if (paths.has(file.path)) {
			throw fault("overlay_poisoned", "mount verifier emitted a duplicate file witness", { path: file.path });
		}
		paths.add(file.path);
	}
}

function assertReviewSelectionMatch(approval: SkillReviewApprovalV1, selection: SkillActivationSelectionV1): void {
	if (
		!sameMeaningfulObjectRef(approval.skillRef, selection.skillRef) ||
		!sameMeaningfulObjectRef(approval.artifactRef, selection.artifactRef) ||
		approval.artifactDigest !== selection.artifactDigest ||
		!sameMeaningfulObjectRef(approval.manifest.manifestRef, selection.manifestRef) ||
		approval.manifest.manifestDigest !== selection.manifestDigest
	) {
		throw fault("review_selection_mismatch", "activation selection is not exactly the reviewed skill artifact");
	}
}

function validateContentAuthorityRef(value: ContentAuthorityRefV1, label: string): void {
	assertExactKeys(value, ["ownerPrincipal", "graphId", "objectId", "version", "digest"], label);
	if (!isCanonicalGraphOwnerPrincipal(value.ownerPrincipal)) {
		throw fault("content_authority_invalid", `${label}.ownerPrincipal is not canonical`);
	}
	assertGraphId(value.graphId, `${label}.graphId`);
	assertOpaqueContentId(value.objectId, `${label}.objectId`);
	assertOpaqueContentId(value.version, `${label}.version`);
	assertDigest(value.digest, `${label}.digest`);
}

function validateSkillOverlayManifest(value: SkillOverlayManifestV1): void {
	assertExactKeys(
		value,
		["manifestRef", "manifestDigest", "skillRef", "disclosure", "entrypoint"],
		"skill overlay manifest",
	);
	validateBoundMeaningfulObjectRef(value.manifestRef, "artifact");
	assertDigest(value.manifestDigest, "manifest.manifestDigest");
	if (value.manifestRef.digest !== value.manifestDigest) {
		throw fault("overlay_poisoned", "manifest Meaningful Object does not pin its declared manifest digest");
	}
	validateBoundMeaningfulObjectRef(value.skillRef, "skill");
	assertExactKeys(value.disclosure, ["path", "digest"], "manifest disclosure");
	assertSafeOverlayRelativePath(value.disclosure.path, "manifest.disclosure.path");
	assertDigest(value.disclosure.digest, "manifest.disclosure.digest");
	assertExactKeys(value.entrypoint, ["path", "exportName", "digest"], "manifest entrypoint");
	assertSafeOverlayRelativePath(value.entrypoint.path, "manifest.entrypoint.path");
	assertOpaqueContentId(value.entrypoint.exportName, "manifest.entrypoint.exportName");
	assertDigest(value.entrypoint.digest, "manifest.entrypoint.digest");
}

function hasVerifiedFile(
	mount: ReadOnlyOverlayMountWitnessV1,
	expected: { readonly path: string; readonly digest: string },
): boolean {
	return mount.verifiedFiles.some((file) => file.path === expected.path && file.digest === expected.digest);
}

function skillDisclosurePath(guestPath: string, relativePath: string): string {
	assertSafeOverlayRelativePath(relativePath, "skill disclosure path");
	return `${guestPath}/${relativePath}`;
}

function digestCanonical(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function logicalSkillKey(value: MeaningfulObjectRefV1<"skill">): string {
	return [value.ownerPrincipal, value.graphId, value.objectId].join("\0");
}

function fullMeaningfulObjectKey(value: MeaningfulObjectRefV1): string {
	return [value.kind, value.ownerPrincipal, value.graphId, value.objectId, value.version, value.digest].join("\0");
}

function validateBoundMeaningfulObjectRef<Kind extends MeaningfulObjectRefV1["kind"]>(
	value: unknown,
	expectedKind: Kind,
): asserts value is MeaningfulObjectRefV1<Kind> {
	validateMeaningfulObjectRef(value, expectedKind);
	const ref = value as MeaningfulObjectRefV1<Kind>;
	if (!isCanonicalGraphOwnerPrincipal(ref.ownerPrincipal)) {
		throw fault("content_authority_invalid", "Meaningful Object owner principal is not canonical", {
			ownerPrincipal: ref.ownerPrincipal,
		});
	}
	assertGraphId(ref.graphId, "Meaningful Object graphId");
	assertOpaqueContentId(ref.objectId, "Meaningful Object objectId");
	assertOpaqueContentId(ref.version, "Meaningful Object version");
}

function assertDigest(value: string, label: string): void {
	if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
		throw fault("content_authority_invalid", `${label} must be a lowercase SHA-256 digest`);
	}
}

function assertGraphId(value: string, label: string): void {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
		throw fault("content_authority_invalid", `${label} is not a bounded canonical graph identifier`);
	}
}

function assertOpaqueContentId(value: string, label: string): void {
	if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
		throw fault("content_authority_invalid", `${label} is not a bounded canonical content identifier`);
	}
}

function assertSafeOverlayRelativePath(value: string, label: string): void {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 256 ||
		value.startsWith("/") ||
		value.includes("\\") ||
		value.includes("\0") ||
		value.split("/").some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part))
	) {
		throw fault("content_authority_invalid", `${label} is not a safe bounded relative overlay path`);
	}
}

function assertNonEmptyUtf8(value: string, label: string): void {
	assertUtf8(value, label);
	if (!value) throw fault("content_authority_invalid", `${label} must not be empty`);
}

function assertUtf8(value: string, label: string): void {
	if (typeof value !== "string" || Buffer.from(value, "utf8").toString("utf8") !== value) {
		throw fault("content_authority_invalid", `${label} must be an exact UTF-8 string without lone surrogates`);
	}
}

/** Persisted authority material is closed: a decoder may not silently discard fields. */
function assertExactKeys(value: unknown, keys: readonly string[], label: string): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw fault("content_authority_invalid", `${label} must be an object`);
	}
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw fault("content_authority_invalid", `${label} has missing or unknown fields`, { actual, expected });
	}
}

function fault(code: ContentAuthorityFaultCode, message: string, details?: unknown): ContentAuthorityContractFault {
	return new ContentAuthorityContractFault(code, message, details);
}
