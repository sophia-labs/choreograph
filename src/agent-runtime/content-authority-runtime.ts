import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PrivateSandboxMount } from "../templates.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import {
	assertContentAuthorityBinding,
	assertVerifiedExecutionCapsuleReplay,
	type ContentAuthorityBindingV1,
	type VerifiedExecutionCapsuleV1,
} from "./content-authority-contract.js";
import {
	admitVerifiedExecutionCapsule,
	digestReviewedSkillOverlayManifestBytes,
	type ImmutableCasArtifactResolver,
} from "./verified-execution-capsule-admission.js";

/**
 * Physical CAS resolution is a host-only port. The durable capsule stores no
 * host path and no caller can choose a guest path.
 */
export interface ReviewedSkillArtifactMountResolver {
	resolveReadOnlyArtifactMount(input: {
		readonly artifactRef: ContentAuthorityBindingV1["reviewedSkill"]["selection"]["artifactRef"];
		readonly artifactDigest: string;
	}): Promise<{ readonly hostPath: string }> | { readonly hostPath: string };
}

export interface ContentAuthorityAdmissionPort {
	/** Must run before durable session creation, capability binding, or queue admission. */
	preflight(spec: AgentNodeSpec): Promise<AgentNodeSpec>;
	/** Re-reads CAS and the sealed physical mount before capability/resource use and OS spawn. */
	reverify(spec: AgentNodeSpec): Promise<void>;
}

/** Host composition injects both ports; neither review nor selection is inferred here. */
export interface ContentAuthorityAdmissionPortInput {
	readonly cas: ImmutableCasArtifactResolver;
	readonly mounts: ReviewedSkillArtifactMountResolver;
}

const sealedCapsules = new WeakSet<VerifiedExecutionCapsuleV1>();
const mountsBySpec = new WeakMap<AgentNodeSpec, readonly PrivateSandboxMount[]>();

export function createContentAuthorityAdmissionPort(
	input: ContentAuthorityAdmissionPortInput,
): ContentAuthorityAdmissionPort {
	return {
		async preflight(spec): Promise<AgentNodeSpec> {
			const binding = requireContentAuthorityBinding(spec);
			const admission = await admit(binding, input.cas);
			if (spec.verifiedExecutionCapsule && spec.verifiedExecutionCapsule.digest !== admission.capsule.digest) {
				throw new Error("Content-authority preflight drifted from its persisted verified capsule");
			}
			const mounts = await materializeReadOnlyMounts(binding, admission.capsule, input.mounts);
			const prepared: AgentNodeSpec = {
				...spec,
				systemPrompt: binding.prompt.finalPromptUtf8,
				verifiedExecutionCapsule: admission.capsule,
			};
			sealedCapsules.add(admission.capsule);
			mountsBySpec.set(prepared, mounts);
			return prepared;
		},
		async reverify(spec): Promise<void> {
			const binding = requireContentAuthorityBinding(spec);
			const admitted = await admit(binding, input.cas);
			const capsule = spec.verifiedExecutionCapsule;
			if (!capsule || capsule.digest !== admitted.capsule.digest) {
				throw new Error("Content-authority replay drifted from its persisted verified capsule");
			}
			assertVerifiedExecutionCapsuleReplay(capsule, binding.prompt.finalPromptUtf8);
			if (!sealedCapsules.has(capsule)) {
				throw new Error("Verified execution capsule was not sealed by the prequeue admission port");
			}
			const mounts = mountsBySpec.get(spec);
			if (!mounts || mounts.length !== capsule.skills.length) {
				throw new Error("Verified execution capsule has no sealed read-only mount witness");
			}
			for (let index = 0; index < capsule.skills.length; index += 1) {
				verifyMountedArtifact(mounts[index]!, capsule.skills[index]!);
			}
		},
	};
}

/** An I-authoritative node has a private mount only after the preflight port seals it. */
export function contentAuthorityPrivateMounts(spec: AgentNodeSpec): readonly PrivateSandboxMount[] {
	const mounts = mountsBySpec.get(spec);
	if (!mounts) throw new Error("I-authoritative node has no sealed read-only reviewed-skill mount");
	return mounts;
}

/** Queue admission uses this to reject forged, merely self-consistent capsules. */
export function isSealedVerifiedExecutionCapsule(value: VerifiedExecutionCapsuleV1): boolean {
	return sealedCapsules.has(value);
}

export function isIContentAuthorityNode(spec: AgentNodeSpec): boolean {
	return spec.contentAuthority !== undefined || spec.verifiedExecutionCapsule !== undefined;
}

function requireContentAuthorityBinding(spec: AgentNodeSpec): ContentAuthorityBindingV1 {
	if (!spec.contentAuthority) {
		if (!spec.contentAuthority && spec.verifiedExecutionCapsule) {
			throw new Error("Verified execution capsule is invalid without its explicit content-authority binding");
		}
		throw new Error("I-authoritative execution requires an explicit complete content-authority binding");
	}
	assertContentAuthorityBinding(spec.contentAuthority);
	if (spec.systemPrompt !== undefined && spec.systemPrompt !== spec.contentAuthority.prompt.finalPromptUtf8) {
		throw new Error("I-authoritative execution may not override the sealed final worker prompt bytes");
	}
	return spec.contentAuthority;
}

async function admit(
	binding: ContentAuthorityBindingV1,
	cas: ImmutableCasArtifactResolver,
): ReturnType<typeof admitVerifiedExecutionCapsule> {
	return admitVerifiedExecutionCapsule(
		{
			prompt: binding.prompt,
			overlays: [binding.reviewedSkill],
		},
		cas,
	);
}

async function materializeReadOnlyMounts(
	binding: ContentAuthorityBindingV1,
	capsule: VerifiedExecutionCapsuleV1,
	resolver: ReviewedSkillArtifactMountResolver,
): Promise<readonly PrivateSandboxMount[]> {
	if (capsule.skills.length !== 1) throw new Error("I2 admits exactly one reviewed skill artifact");
	const overlay = capsule.skills[0]!;
	if (overlay.selection.artifactDigest !== binding.reviewedSkill.selection.artifactDigest) {
		throw new Error("Verified execution capsule artifact differs from the explicit reviewed selection");
	}
	const resolved = await resolver.resolveReadOnlyArtifactMount({
		artifactRef: overlay.selection.artifactRef,
		artifactDigest: overlay.selection.artifactDigest,
	});
	if (!isAbsolute(resolved.hostPath)) throw new Error("Reviewed skill artifact mount path must be absolute");
	const hostPath = realpathSync(resolved.hostPath);
	const mount: PrivateSandboxMount = { hostPath, guestPath: overlay.mount.guestPath, mode: "ro" };
	verifyMountedArtifact(mount, overlay);
	return [mount];
}

function verifyMountedArtifact(
	mount: PrivateSandboxMount,
	overlay: VerifiedExecutionCapsuleV1["skills"][number],
): void {
	if (mount.mode !== "ro" || mount.guestPath !== overlay.mount.guestPath) {
		throw new Error("Reviewed skill mount differs from its sealed read-only witness");
	}
	const root = resolve(mount.hostPath);
	const rootMetadata = lstatSync(root);
	if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink() || (rootMetadata.mode & 0o222) !== 0) {
		throw new Error("Reviewed skill artifact root is not a read-only non-symlink directory");
	}
	const expected = new Map(overlay.mount.verifiedFiles.map((file) => [file.path, file.digest]));
	const actual = listReadOnlyFiles(root);
	if (!actual.has("manifest.json") || actual.size !== expected.size + 1) {
		throw new Error("Reviewed skill artifact file set drifted from the sealed manifest witness");
	}
	const observedManifestDigest = digestReviewedSkillOverlayManifestBytes(
		readFileSync(safeChild(root, "manifest.json")),
	);
	if (observedManifestDigest !== overlay.mount.observedManifestDigest) {
		throw new Error("Reviewed skill artifact manifest bytes drifted from the sealed manifest witness");
	}
	for (const [path, digest] of expected) {
		const absolute = safeChild(root, path);
		if (!actual.has(path) || sha256(readFileSync(absolute)) !== digest) {
			throw new Error(`Reviewed skill artifact file digest drifted: ${path}`);
		}
	}
}

function listReadOnlyFiles(root: string): Set<string> {
	const files = new Set<string>();
	const visit = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolute = safeChild(root, relative(root, join(directory, entry.name)).split(sep).join("/"));
			const metadata = lstatSync(absolute);
			if (metadata.isSymbolicLink() || (metadata.mode & 0o222) !== 0) {
				throw new Error("Reviewed skill artifact contains a writable or symlink entry");
			}
			if (metadata.isDirectory()) visit(absolute);
			else if (metadata.isFile()) files.add(relative(root, absolute).split(sep).join("/"));
			else throw new Error("Reviewed skill artifact contains a non-regular entry");
		}
	};
	visit(root);
	return files;
}

function safeChild(root: string, path: string): string {
	if (
		!path ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.split("/").some((part) => !part || part === "." || part === "..")
	) {
		throw new Error("Reviewed skill artifact path is unsafe");
	}
	const candidate = resolve(root, path);
	if (!candidate.startsWith(`${root}${sep}`)) throw new Error("Reviewed skill artifact path escapes its root");
	return candidate;
}

function sha256(value: Uint8Array): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
