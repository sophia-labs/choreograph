import { createHash } from "node:crypto";
import { canonicalJson } from "@sophia-labs/canonical-json";
import {
	createVerifiedExecutionCapsule,
	type FinalWorkerPromptReceiptV1,
	type ReadOnlyOverlayFileWitnessV1,
	reviewedSkillGuestPath,
	type SkillActivationSelectionV1,
	type SkillReviewApprovalV1,
	type VerifiedExecutionCapsuleV1,
	type VerifiedSkillOverlayV1,
	verifySkillOverlay,
} from "./content-authority-contract.js";
import {
	type MeaningfulObjectRefV1,
	sameMeaningfulObjectRef,
	validateMeaningfulObjectRef,
} from "./meaningful-object.js";

/** Read-only, prequeue I2 admission. It has no filesystem, sandbox, or network authority of its own. */
export const REVIEWED_SKILL_OVERLAY_MANIFEST_SCHEMA = "sophia.reviewed-skill-overlay-manifest.v1" as const;
export const VERIFIED_EXECUTION_CAPSULE_ADMISSION_SCHEMA = "sophia.verified-execution-capsule-admission.v1" as const;

export interface ImmutableCasArtifactFileV1 {
	readonly path: string;
	readonly bytes: Uint8Array;
}

/** The resolver may only return bytes already held by immutable content-addressed storage. */
export interface ImmutableCasArtifactResolver {
	readArtifact(input: {
		readonly artifactRef: MeaningfulObjectRefV1<"release-artifact">;
	}):
		| Promise<Readonly<{ readonly files: readonly ImmutableCasArtifactFileV1[] }> | undefined>
		| Readonly<{ readonly files: readonly ImmutableCasArtifactFileV1[] }>;
}

interface ReviewedSkillOverlayManifestFileV1 {
	readonly path: string;
	readonly digest: string;
}

export interface ReviewedSkillOverlayManifestV1 {
	readonly schema: typeof REVIEWED_SKILL_OVERLAY_MANIFEST_SCHEMA;
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
	/** Every non-manifest file in the sealed artifact, in canonical path order. */
	readonly files: readonly ReviewedSkillOverlayManifestFileV1[];
}

export interface VerifiedExecutionCapsuleAdmissionInputV1 {
	readonly prompt: FinalWorkerPromptReceiptV1;
	readonly overlays: readonly {
		readonly approval: SkillReviewApprovalV1;
		readonly selection: SkillActivationSelectionV1;
	}[];
}

export interface VerifiedExecutionCapsuleAdmissionV1 {
	readonly schema: typeof VERIFIED_EXECUTION_CAPSULE_ADMISSION_SCHEMA;
	readonly capsule: VerifiedExecutionCapsuleV1;
	/** Downstream code receives only sealed read-only witnesses, never CAS handles. */
	readonly overlays: readonly VerifiedSkillOverlayV1[];
}

export type VerifiedExecutionCapsuleAdmissionFaultCode = "artifact_missing" | "artifact_corrupt" | "artifact_poisoned";

export class VerifiedExecutionCapsuleAdmissionFault extends Error {
	constructor(
		readonly code: VerifiedExecutionCapsuleAdmissionFaultCode,
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "VerifiedExecutionCapsuleAdmissionFault";
	}
}

/**
 * Resolve, fully verify, and seal reviewed skill overlays before queueing a
 * sandbox or minting a graph/browser/model resource. The caller owns all later
 * mutation and receives a deterministic capsule rather than mutable CAS state.
 */
export async function admitVerifiedExecutionCapsule(
	input: VerifiedExecutionCapsuleAdmissionInputV1,
	resolver: ImmutableCasArtifactResolver,
): Promise<VerifiedExecutionCapsuleAdmissionV1> {
	const overlays = await Promise.all(
		input.overlays.map(async (requested) => {
			let artifact: Readonly<{ readonly files: readonly ImmutableCasArtifactFileV1[] }> | undefined;
			try {
				artifact = await resolver.readArtifact({ artifactRef: requested.selection.artifactRef });
			} catch (cause) {
				throw admissionFault(
					"artifact_missing",
					"selected reviewed artifact could not be read from immutable CAS",
					{
						artifactRef: requested.selection.artifactRef,
						cause,
					},
				);
			}
			if (!artifact) {
				throw admissionFault("artifact_missing", "selected reviewed artifact is unavailable from immutable CAS", {
					artifactRef: requested.selection.artifactRef,
				});
			}
			const verified = verifyResolvedOverlayArtifact(requested, artifact.files);
			return verifySkillOverlay({
				approval: requested.approval,
				selection: requested.selection,
				artifact: {
					artifactRef: requested.selection.artifactRef,
					observedArtifactDigest: verified.artifactDigest,
					state: "available",
				},
				mount: {
					artifactRef: requested.selection.artifactRef,
					observedArtifactDigest: verified.artifactDigest,
					guestPath: reviewedSkillGuestPath(verified.artifactDigest),
					mode: "ro",
					observedManifestDigest: verified.manifestDigest,
					verifiedFiles: verified.files,
				},
			});
		}),
	);
	return {
		schema: VERIFIED_EXECUTION_CAPSULE_ADMISSION_SCHEMA,
		capsule: createVerifiedExecutionCapsule({ prompt: input.prompt, skills: overlays }),
		overlays,
	};
}

export function digestReviewedSkillOverlayManifest(value: ReviewedSkillOverlayManifestV1): string {
	return digestCanonical(value);
}

/** Reparse mounted manifest bytes before trusting their canonical manifest digest. */
export function digestReviewedSkillOverlayManifestBytes(bytes: Uint8Array): string {
	return digestReviewedSkillOverlayManifest(parseReviewedSkillOverlayManifest(bytes));
}

export function digestReviewedSkillOverlayArtifact(input: {
	readonly manifestDigest: string;
	readonly files: readonly ReviewedSkillOverlayManifestFileV1[];
}): string {
	return digestCanonical({
		schema: "sophia.reviewed-skill-overlay-artifact.v1",
		manifestDigest: input.manifestDigest,
		files: [...input.files].sort((left, right) => left.path.localeCompare(right.path)),
	});
}

function verifyResolvedOverlayArtifact(
	requested: VerifiedExecutionCapsuleAdmissionInputV1["overlays"][number],
	files: readonly ImmutableCasArtifactFileV1[],
): {
	readonly manifestDigest: string;
	readonly artifactDigest: string;
	readonly files: readonly ReadOnlyOverlayFileWitnessV1[];
} {
	const filesByPath = new Map<string, Uint8Array>();
	for (const file of files) {
		assertSafeRelativePath(file.path, "CAS artifact file path");
		if (filesByPath.has(file.path)) {
			throw admissionFault("artifact_corrupt", "CAS artifact contains duplicate file paths", { path: file.path });
		}
		filesByPath.set(file.path, file.bytes);
	}
	const manifestBytes = filesByPath.get("manifest.json");
	if (!manifestBytes) throw admissionFault("artifact_corrupt", "CAS artifact has no manifest.json");
	const manifest = parseReviewedSkillOverlayManifest(manifestBytes);
	const manifestDigest = digestReviewedSkillOverlayManifest(manifest);
	if (
		requested.approval.manifest.manifestDigest !== manifestDigest ||
		requested.selection.manifestDigest !== manifestDigest ||
		requested.approval.manifest.manifestRef.digest !== manifestDigest ||
		!sameMeaningfulObjectRef(requested.approval.manifest.manifestRef, requested.selection.manifestRef)
	) {
		throw admissionFault("artifact_poisoned", "resolved manifest differs from the explicit reviewed selection", {
			expected: requested.selection.manifestDigest,
			actual: manifestDigest,
		});
	}
	if (
		!sameMeaningfulObjectRef(manifest.skillRef, requested.approval.manifest.skillRef) ||
		!sameMeaningfulObjectRef(manifest.skillRef, requested.selection.skillRef) ||
		!sameFileWitness(manifest.disclosure, requested.approval.manifest.disclosure) ||
		!sameFileWitness(manifest.entrypoint, requested.approval.manifest.entrypoint)
	) {
		throw admissionFault("artifact_poisoned", "resolved manifest skill disclosure differs from review approval", {
			artifactRef: requested.selection.artifactRef,
		});
	}
	const declaredPaths = new Set(manifest.files.map((file) => file.path));
	if (declaredPaths.size !== manifest.files.length || declaredPaths.has("manifest.json")) {
		throw admissionFault("artifact_corrupt", "overlay manifest has duplicate or reserved file paths");
	}
	const actualPaths = [...filesByPath.keys()].filter((path) => path !== "manifest.json");
	if (actualPaths.length !== declaredPaths.size || actualPaths.some((path) => !declaredPaths.has(path))) {
		throw admissionFault("artifact_corrupt", "overlay manifest file set differs from CAS artifact", {
			actualPaths,
			declaredPaths: [...declaredPaths],
		});
	}
	for (const file of manifest.files) {
		const bytes = filesByPath.get(file.path);
		if (!bytes || digestBytes(bytes) !== file.digest) {
			throw admissionFault("artifact_poisoned", "CAS artifact file digest differs from its reviewed manifest", {
				path: file.path,
			});
		}
	}
	const artifactDigest = digestReviewedSkillOverlayArtifact({ manifestDigest, files: manifest.files });
	if (artifactDigest !== requested.approval.artifactDigest || artifactDigest !== requested.selection.artifactDigest) {
		throw admissionFault("artifact_poisoned", "CAS artifact digest differs from review approval or selection", {
			expected: requested.selection.artifactDigest,
			actual: artifactDigest,
		});
	}
	return {
		manifestDigest,
		artifactDigest,
		files: manifest.files.map((file) => ({ path: file.path, digest: file.digest })),
	};
}

function parseReviewedSkillOverlayManifest(bytes: Uint8Array): ReviewedSkillOverlayManifestV1 {
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch (cause) {
		throw admissionFault("artifact_corrupt", "overlay manifest is not strict UTF-8 JSON", { cause });
	}
	if (!isRecord(value)) throw admissionFault("artifact_corrupt", "overlay manifest must be an object");
	exactKeys(value, ["schema", "skillRef", "disclosure", "entrypoint", "files"]);
	if (value.schema !== REVIEWED_SKILL_OVERLAY_MANIFEST_SCHEMA) {
		throw admissionFault("artifact_corrupt", "overlay manifest schema is unsupported");
	}
	validateMeaningfulObjectRef(value.skillRef, "skill");
	const disclosure = parseManifestFile(value.disclosure, "disclosure");
	const entrypoint = parseManifestEntrypoint(value.entrypoint);
	if (!Array.isArray(value.files) || value.files.length < 2) {
		throw admissionFault("artifact_corrupt", "overlay manifest must declare its disclosure and entrypoint files");
	}
	const files = value.files.map((file, index) => parseManifestFile(file, `files[${String(index)}]`));
	if (files.some((file, index) => index > 0 && files[index - 1]!.path >= file.path)) {
		throw admissionFault("artifact_corrupt", "overlay manifest files must have unique canonical path order");
	}
	if (
		!files.some((file) => sameFileWitness(file, disclosure)) ||
		!files.some((file) => sameFileWitness(file, entrypoint))
	) {
		throw admissionFault("artifact_corrupt", "overlay manifest does not declare disclosure and entrypoint files");
	}
	return {
		schema: REVIEWED_SKILL_OVERLAY_MANIFEST_SCHEMA,
		skillRef: value.skillRef,
		disclosure,
		entrypoint,
		files,
	};
}

function parseManifestFile(value: unknown, label: string): ReviewedSkillOverlayManifestFileV1 {
	if (!isRecord(value)) throw admissionFault("artifact_corrupt", `${label} must be an object`);
	exactKeys(value, ["path", "digest"]);
	assertSafeRelativePath(value.path, `${label}.path`);
	assertDigest(value.digest, `${label}.digest`);
	return { path: value.path, digest: value.digest };
}

function parseManifestEntrypoint(value: unknown): ReviewedSkillOverlayManifestV1["entrypoint"] {
	if (!isRecord(value)) throw admissionFault("artifact_corrupt", "entrypoint must be an object");
	exactKeys(value, ["path", "exportName", "digest"]);
	assertSafeRelativePath(value.path, "entrypoint.path");
	assertDigest(value.digest, "entrypoint.digest");
	if (typeof value.exportName !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.exportName)) {
		throw admissionFault("artifact_corrupt", "entrypoint.exportName is invalid");
	}
	return { path: value.path, exportName: value.exportName, digest: value.digest };
}

function sameFileWitness(
	left: { readonly path: string; readonly digest: string },
	right: { readonly path: string; readonly digest: string },
): boolean {
	return left.path === right.path && left.digest === right.digest;
}

function digestBytes(bytes: Uint8Array): string {
	return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function digestCanonical(value: unknown): string {
	return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
	const unknown = Object.keys(value).filter((key) => !keys.includes(key));
	if (unknown.length > 0) throw admissionFault("artifact_corrupt", "overlay manifest has unknown fields", { unknown });
}

function assertSafeRelativePath(value: unknown, label: string): asserts value is string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 256 ||
		value.startsWith("/") ||
		value.includes("\\") ||
		value.includes("\0") ||
		value.split("/").some((part) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part))
	) {
		throw admissionFault("artifact_corrupt", `${label} is not a safe relative path`);
	}
}

function assertDigest(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
		throw admissionFault("artifact_corrupt", `${label} must be a lowercase SHA-256 digest`);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function admissionFault(
	code: VerifiedExecutionCapsuleAdmissionFaultCode,
	message: string,
	details?: unknown,
): VerifiedExecutionCapsuleAdmissionFault {
	return new VerifiedExecutionCapsuleAdmissionFault(code, message, details);
}
