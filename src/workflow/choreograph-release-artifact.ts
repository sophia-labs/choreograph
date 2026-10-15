/** Immutable Linux/amd64 host + runtime release testimony produced by cloud-2. */

import { canonicalDigest } from "../agent-subject/canonical-json.js";

export const CHOREOGRAPH_RELEASE_ARTIFACT_SCHEMA = "sophia.choreograph.release-artifact.v1" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OID = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ARTIFACT_FIELDS = new Set([
	"schema",
	"artifactClass",
	"bucket",
	"version",
	"releaseKey",
	"releaseSha256",
	"runtimeManifestKey",
	"runtimeManifestSha256",
	"metadataKey",
	"metadataSha256",
	"terraformVarsKey",
	"terraformVarsSha256",
	"stageManifestKey",
	"stageManifestSha256",
	"sourceRevision",
	"sourceComposition",
	"sourceCompositionDigest",
	"contentKey",
	"objects",
]);
const SOURCE_FIELDS = new Set(["repository", "revision", "destination"]);
const OBJECT_FIELDS = new Set(["role", "key", "sha256", "bytes"]);
const RELEASE_ROLES = new Set([
	"host-release",
	"runtime-bundle:asr-runtime",
	"runtime-bundle:asr-vibeasr-bitnet-model",
	"runtime-bundle:asr-whisper-small-en-model",
	"runtime-bundle:jupyter-bridge",
	"runtime-bundle:python-runtime",
	"runtime-bundle:sophia-agent-runtime",
	"runtime-bundle:sophia-kernel-runtime",
	"release-metadata",
	"terraform-vars",
	"runtime-manifest",
]);

export interface ChoreographReleaseArtifactV1 {
	readonly schema: typeof CHOREOGRAPH_RELEASE_ARTIFACT_SCHEMA;
	readonly artifactClass: "choreograph-release";
	readonly bucket: string;
	readonly version: string;
	readonly releaseKey: string;
	readonly releaseSha256: string;
	readonly runtimeManifestKey: string;
	readonly runtimeManifestSha256: string;
	readonly metadataKey: string;
	readonly metadataSha256: string;
	readonly terraformVarsKey: string;
	readonly terraformVarsSha256: string;
	readonly stageManifestKey: string;
	readonly stageManifestSha256: string;
	readonly sourceRevision: string;
	readonly sourceComposition: readonly {
		readonly repository: string;
		readonly revision: string;
		readonly destination: string;
	}[];
	readonly sourceCompositionDigest: string;
	readonly contentKey: string;
	readonly objects: readonly {
		readonly role: string;
		readonly key: string;
		readonly sha256: string;
		readonly bytes: number;
	}[];
}

export function validChoreographReleaseArtifact(
	value: unknown,
	expected: { readonly repository?: string; readonly sourceRevision?: string; readonly contentKey?: string } = {},
): value is ChoreographReleaseArtifactV1 {
	if (!isRecord(value) || !hasExactKeys(value, ARTIFACT_FIELDS)) return false;
	const artifact = value as unknown as ChoreographReleaseArtifactV1;
	const sources = artifact.sourceComposition;
	const objects = artifact.objects;
	const sourceRevision = expected.sourceRevision ?? artifact.sourceRevision;
	const repository = expected.repository ?? "sophia-labs/choreograph";
	if (
		artifact.schema !== CHOREOGRAPH_RELEASE_ARTIFACT_SCHEMA ||
		artifact.artifactClass !== "choreograph-release" ||
		!isBucket(artifact.bucket) ||
		!GIT_OID.test(sourceRevision) ||
		artifact.version !== sourceRevision.slice(0, 12) ||
		artifact.sourceRevision !== sourceRevision ||
		(expected.contentKey !== undefined && artifact.contentKey !== expected.contentKey) ||
		!SHA256.test(artifact.contentKey) ||
		!SHA256.test(artifact.releaseSha256) ||
		!SHA256.test(artifact.runtimeManifestSha256) ||
		!SHA256.test(artifact.metadataSha256) ||
		!SHA256.test(artifact.terraformVarsSha256) ||
		!SHA256.test(artifact.stageManifestSha256) ||
		!SHA256.test(artifact.sourceCompositionDigest) ||
		!isReleaseKey(artifact.releaseKey) ||
		!isReleaseKey(artifact.runtimeManifestKey) ||
		!isReleaseKey(artifact.metadataKey) ||
		!isReleaseKey(artifact.terraformVarsKey) ||
		!isObjectKey(artifact.stageManifestKey) ||
		!Array.isArray(sources) ||
		sources.length !== 3 ||
		!sources.every((source) => isRecord(source) && hasExactKeys(source, SOURCE_FIELDS)) ||
		sources[0]?.repository !== repository ||
		sources[0]?.revision !== sourceRevision ||
		sources[0]?.destination !== "choreograph" ||
		sources[1]?.repository !== "sophia-labs/sophia-agent" ||
		sources[1]?.destination !== "prime-agent-sophia" ||
		sources[2]?.repository !== "sophia-labs/soil" ||
		sources[2]?.destination !== "soil" ||
		canonicalDigest(sources) !== artifact.sourceCompositionDigest ||
		!sources.every(
			(source) =>
				REPOSITORY.test(source.repository) && GIT_OID.test(source.revision) && isObjectKey(source.destination),
		) ||
		!Array.isArray(objects) ||
		objects.length !== RELEASE_ROLES.size ||
		!artifact.stageManifestKey.startsWith("choreograph-build/staging/")
	) {
		return false;
	}
	const roles = new Set(objects.map((object) => object.role));
	if (roles.size !== RELEASE_ROLES.size || ![...roles].every((role) => RELEASE_ROLES.has(role))) return false;
	if (
		!objects.every(
			(object) =>
				isRecord(object) &&
				hasExactKeys(object, OBJECT_FIELDS) &&
				typeof object.role === "string" &&
				isReleaseKey(object.key) &&
				SHA256.test(object.sha256) &&
				Number.isSafeInteger(object.bytes) &&
				object.bytes > 0 &&
				object.bytes <= 17_179_869_184,
		)
	) {
		return false;
	}
	const byRole = new Map(objects.map((object) => [object.role, object]));
	return (
		byRole.get("host-release")?.key === artifact.releaseKey &&
		byRole.get("host-release")?.sha256 === artifact.releaseSha256 &&
		byRole.get("runtime-manifest")?.key === artifact.runtimeManifestKey &&
		byRole.get("runtime-manifest")?.sha256 === artifact.runtimeManifestSha256 &&
		byRole.get("release-metadata")?.key === artifact.metadataKey &&
		byRole.get("release-metadata")?.sha256 === artifact.metadataSha256 &&
		byRole.get("terraform-vars")?.key === artifact.terraformVarsKey &&
		byRole.get("terraform-vars")?.sha256 === artifact.terraformVarsSha256
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, fields: ReadonlySet<string>): boolean {
	const keys = Object.keys(value);
	return keys.length === fields.size && keys.every((key) => fields.has(key));
}

function isBucket(value: unknown): value is string {
	return typeof value === "string" && /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) && !value.includes("..");
}

function isObjectKey(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 1_024 &&
		!value.startsWith("/") &&
		!value.includes("..") &&
		!value.includes("//") &&
		/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
	);
}

function isReleaseKey(value: unknown): value is string {
	return (
		isObjectKey(value) &&
		["releases/", "runtime-bundles/", "runtime-manifests/", "choreograph-build/"].some((prefix) =>
			value.startsWith(prefix),
		)
	);
}
