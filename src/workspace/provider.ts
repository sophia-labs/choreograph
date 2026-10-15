import type { MeaningfulObjectRefV1 } from "../agent-runtime/meaningful-object.js";

export const SOURCE_SNAPSHOT_SCHEMA = "sophia.source-snapshot.v1" as const;
export const CODE_WORKSPACE_SCHEMA = "sophia.code-workspace.v1" as const;
export const WORKSPACE_CHECKPOINT_SCHEMA = "sophia.workspace-checkpoint.v1" as const;
export const PATCH_SET_SCHEMA = "sophia.patch-set.v1" as const;
export const CHANGE_SET_SCHEMA = "sophia.change-set.v1" as const;

export interface WorkspaceSourceRequestV1 {
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly graphId: string;
	readonly repositoryId: string;
	/** Trusted-host input. This is never serialized into a public descriptor. */
	readonly repositoryPath: string;
	readonly baseRevision: string;
	readonly allowedPaths: readonly string[];
	readonly maxBytes: number;
	readonly proposalRef: MeaningfulObjectRefV1<"evolution-proposal">;
}

export interface SourceSnapshotV1 {
	readonly schema: typeof SOURCE_SNAPSHOT_SCHEMA;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly repositoryId: string;
	readonly revision: string;
	readonly treeDigest: string;
	readonly createdAt: number;
}

export interface CodeWorkspaceV1 {
	readonly schema: typeof CODE_WORKSPACE_SCHEMA;
	readonly workspaceId: string;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly repositoryId: string;
	readonly sourceSnapshotRef: MeaningfulObjectRefV1<"source-snapshot">;
	readonly proposalRef: MeaningfulObjectRefV1<"evolution-proposal">;
	readonly allowedPaths: readonly string[];
	readonly maxBytes: number;
	readonly generation: number;
	readonly mountPath: "/candidate";
	readonly createdAt: number;
}

export interface WorkspaceLeaseV1 {
	readonly workspaceId: string;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly generation: number;
	readonly token: string;
	readonly expiresAt: number;
}

export interface MaterializedWorkspaceV1 {
	readonly workspace: CodeWorkspaceV1;
	readonly workspaceRef: MeaningfulObjectRefV1<"code-workspace">;
	readonly sourceSnapshot: SourceSnapshotV1;
	readonly sourceSnapshotRef: MeaningfulObjectRefV1<"source-snapshot">;
	readonly lease: WorkspaceLeaseV1;
}

export interface WorkspaceCheckpointV1 {
	readonly schema: typeof WORKSPACE_CHECKPOINT_SCHEMA;
	readonly checkpointId: string;
	readonly workspaceRef: MeaningfulObjectRefV1<"code-workspace">;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly generation: number;
	readonly sourceSnapshotRef: MeaningfulObjectRefV1<"source-snapshot">;
	readonly contentDigest: string;
	readonly byteLength: number;
	readonly fileCount: number;
	readonly createdAt: number;
}

export interface PatchChangedPathV1 {
	readonly path: string;
	readonly status: "added" | "modified" | "deleted" | "renamed" | "type-changed";
	readonly previousPath?: string;
	readonly mode?: string;
}

export interface PatchSetV1 {
	readonly schema: typeof PATCH_SET_SCHEMA;
	readonly patchSetId: string;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly workspaceRef: MeaningfulObjectRefV1<"code-workspace">;
	readonly sourceSnapshotRef: MeaningfulObjectRefV1<"source-snapshot">;
	readonly baseRevision: string;
	readonly patchDigest: string;
	/** Canonical digest of the exact content/mode operations offered to a source host. */
	readonly publicationDigest: string;
	readonly patchBytes: number;
	readonly changedPaths: readonly PatchChangedPathV1[];
	readonly dependencyFilesChanged: readonly string[];
	readonly secretFindings: readonly { readonly path: string; readonly rule: string }[];
	readonly createdAt: number;
}

export interface GitPublicationChangeV1 {
	readonly path: string;
	readonly mode: "100644" | "100755";
	readonly delete?: true;
	readonly contentBase64?: string;
	/** Lowercase, unprefixed SHA-256 for the GitHub Git-data API adapter. */
	readonly contentSha256?: string;
}

export interface ChangeSetV1 {
	readonly schema: typeof CHANGE_SET_SCHEMA;
	readonly changeSetId: string;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly proposalRef: MeaningfulObjectRefV1<"evolution-proposal">;
	readonly sourceSnapshotRef: MeaningfulObjectRefV1<"source-snapshot">;
	readonly patchSetRefs: readonly MeaningfulObjectRefV1<"patch-set">[];
	readonly changedPathsDigest: string;
	readonly createdAt: number;
}

export interface PatchAttestationV1 {
	readonly patchSet: PatchSetV1;
	readonly patchSetRef: MeaningfulObjectRefV1<"patch-set">;
	readonly changeSet: ChangeSetV1;
	readonly changeSetRef: MeaningfulObjectRefV1<"change-set">;
	readonly patchArtifactRef: MeaningfulObjectRefV1<"artifact">;
}

export interface WorkspaceProvider {
	materialize(input: WorkspaceSourceRequestV1, now: number): Promise<MaterializedWorkspaceV1>;
	checkpoint(
		lease: WorkspaceLeaseV1,
		now: number,
	): Promise<{
		checkpoint: WorkspaceCheckpointV1;
		checkpointRef: MeaningfulObjectRefV1<"workspace-checkpoint">;
	}>;
	restore(
		lease: WorkspaceLeaseV1,
		checkpointRef: MeaningfulObjectRefV1<"workspace-checkpoint">,
		now: number,
	): Promise<WorkspaceLeaseV1>;
	attestPatch(lease: WorkspaceLeaseV1, now: number): Promise<PatchAttestationV1>;
	release(lease: WorkspaceLeaseV1, now: number): Promise<void>;
}

export class WorkspaceFault extends Error {
	readonly code = "workspace_invalid";

	constructor(
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "WorkspaceFault";
	}
}
