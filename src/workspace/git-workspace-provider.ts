import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	opendir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { createMeaningfulObjectRef, type MeaningfulObjectRefV1 } from "../agent-runtime/meaningful-object.js";
import {
	CHANGE_SET_SCHEMA,
	type ChangeSetV1,
	CODE_WORKSPACE_SCHEMA,
	type CodeWorkspaceV1,
	type GitPublicationChangeV1,
	type MaterializedWorkspaceV1,
	PATCH_SET_SCHEMA,
	type PatchAttestationV1,
	type PatchChangedPathV1,
	type PatchSetV1,
	SOURCE_SNAPSHOT_SCHEMA,
	type SourceSnapshotV1,
	WORKSPACE_CHECKPOINT_SCHEMA,
	type WorkspaceCheckpointV1,
	WorkspaceFault,
	type WorkspaceLeaseV1,
	type WorkspaceProvider,
	type WorkspaceSourceRequestV1,
} from "./provider.js";

const execFileAsync = promisify(execFile);
const RECORD_SCHEMA = "choreograph.git-workspace-record.v1" as const;
const CHECKPOINT_MANIFEST_SCHEMA = "choreograph.workspace-checkpoint-manifest.v1" as const;
const DEFAULT_LEASE_MS = 15 * 60_000;
const MAX_PATCH_BYTES = 32 * 1024 * 1024;

interface WorkspaceRecordV1 {
	readonly schema: typeof RECORD_SCHEMA;
	readonly requestDigest: string;
	readonly repositoryPath: string;
	readonly baseRevision: string;
	readonly workspace: CodeWorkspaceV1;
	readonly workspaceRef: MeaningfulObjectRefV1<"code-workspace">;
	readonly sourceSnapshot: SourceSnapshotV1;
	readonly sourceSnapshotRef: MeaningfulObjectRefV1<"source-snapshot">;
	lease: WorkspaceLeaseV1;
	readonly checkpoints: Record<
		string,
		{
			readonly checkpoint: WorkspaceCheckpointV1;
			readonly checkpointRef: MeaningfulObjectRefV1<"workspace-checkpoint">;
		}
	>;
	readonly attestations: Record<string, PatchAttestationV1>;
	readonly publicationChanges: Record<string, readonly GitPublicationChangeV1[]>;
	releasedAt?: number;
}

interface CheckpointFileEntry {
	readonly path: string;
	readonly kind: "file" | "symlink";
	readonly mode: number;
	readonly content?: string;
	readonly target?: string;
}

interface CheckpointManifestV1 {
	readonly schema: typeof CHECKPOINT_MANIFEST_SCHEMA;
	readonly entries: readonly CheckpointFileEntry[];
}

interface ScannedEntry {
	readonly path: string;
	readonly absolutePath: string;
	readonly kind: "file" | "symlink";
	readonly mode: number;
	readonly bytes: number;
	readonly target?: string;
}

export interface GitWorktreeProviderOptions {
	readonly rootDirectory: string;
	readonly gitBin?: string;
	readonly leaseMs?: number;
}

/**
 * Local Git implementation of the host-owned candidate workspace boundary.
 *
 * Despite the historical class name in the design, this uses a sanitized,
 * detached clone rather than `git worktree`: a worktree's `.git` pointer leaks
 * a physical host path and couples the candidate to a human checkout.
 */
export class GitWorktreeProvider implements WorkspaceProvider {
	private readonly rootDirectory: string;
	private readonly workspaceDirectory: string;
	private readonly recordDirectory: string;
	private readonly casDirectory: string;
	private readonly gitBin: string;
	private readonly leaseMs: number;

	constructor(options: GitWorktreeProviderOptions) {
		this.rootDirectory = validateProviderRoot(options.rootDirectory);
		this.workspaceDirectory = join(this.rootDirectory, "workspaces");
		this.recordDirectory = join(this.rootDirectory, "records");
		this.casDirectory = join(this.rootDirectory, "cas");
		this.gitBin = options.gitBin?.trim() || "git";
		this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
		if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1) throw new WorkspaceFault("leaseMs must be positive");
	}

	async materialize(input: WorkspaceSourceRequestV1, now: number): Promise<MaterializedWorkspaceV1> {
		validateSourceRequest(input);
		await this.ensureDirectories();
		const repositoryPath = await realpath(resolve(input.repositoryPath));
		if (!isAbsolute(repositoryPath)) throw new WorkspaceFault("repository path must resolve to an absolute path");
		const baseRevision = (
			await this.git(["-C", repositoryPath, "rev-parse", "--verify", `${input.baseRevision}^{commit}`])
		).trim();
		if (!/^[0-9a-f]{40,64}$/.test(baseRevision))
			throw new WorkspaceFault("base revision did not resolve to a Git commit");
		const treeDigest = (await this.git(["-C", repositoryPath, "rev-parse", `${baseRevision}^{tree}`])).trim();
		if (!/^[0-9a-f]{40,64}$/.test(treeDigest)) throw new WorkspaceFault("base revision tree is invalid");

		const requestDigest = sha256(
			canonicalJson({
				ownerPrincipal: input.ownerPrincipal,
				agentId: input.agentId,
				graphId: input.graphId,
				repositoryId: input.repositoryId,
				baseRevision,
				allowedPaths: normalizeAllowedPaths(input.allowedPaths),
				maxBytes: input.maxBytes,
				proposalDigest: input.proposalRef.digest,
			}),
		);
		const workspaceId = `ws-${requestDigest.slice("sha256:".length, "sha256:".length + 32)}`;
		const existing = await this.readRecordIfPresent(workspaceId);
		if (existing) {
			if (existing.requestDigest !== requestDigest) throw new WorkspaceFault("workspace id collision");
			if (existing.releasedAt !== undefined || existing.lease.expiresAt <= now) {
				existing.lease = mintLease(existing.workspace, now, this.leaseMs, existing.workspace.generation + 1);
				delete existing.releasedAt;
				await this.writeRecord(existing);
			}
			return publicMaterialization(existing);
		}

		const workspaceRoot = this.workspaceRoot(workspaceId);
		const treePath = this.treePath(workspaceId);
		await mkdir(workspaceRoot, { recursive: false });
		try {
			await this.git([
				"clone",
				"--no-local",
				"--no-checkout",
				"--no-tags",
				"--config",
				"core.hooksPath=/dev/null",
				repositoryPath,
				treePath,
			]);
			await this.git(["-C", treePath, "checkout", "--detach", "--force", baseRevision]);
			await this.git(["-C", treePath, "remote", "remove", "origin"]);
			await this.git(["-C", treePath, "config", "--local", "core.hooksPath", "/dev/null"]);
			await this.git(["-C", treePath, "config", "--local", "credential.helper", ""]);
			await this.git(["-C", treePath, "config", "--local", "commit.gpgsign", "false"]);
			await this.git(["-C", treePath, "config", "--local", "tag.gpgsign", "false"]);
			await rm(join(treePath, ".git", "hooks"), { recursive: true, force: true });
			await mkdir(join(treePath, ".git", "hooks"), { recursive: true });
			const configText = await readFile(join(treePath, ".git", "config"), "utf8");
			if (configText.includes(repositoryPath))
				throw new WorkspaceFault("sanitized clone retained its physical source path");

			await scanTree(treePath, input.maxBytes);
			const sourceSnapshot: SourceSnapshotV1 = {
				schema: SOURCE_SNAPSHOT_SCHEMA,
				ownerPrincipal: input.ownerPrincipal,
				agentId: input.agentId,
				repositoryId: input.repositoryId,
				revision: baseRevision,
				treeDigest,
				createdAt: now,
			};
			const sourceSnapshotRef = createMeaningfulObjectRef({
				kind: "source-snapshot",
				ownerPrincipal: input.ownerPrincipal,
				graphId: input.graphId,
				objectId: `${input.repositoryId}:${baseRevision}`,
				version: "1",
				value: sourceSnapshot,
			});
			const workspace: CodeWorkspaceV1 = {
				schema: CODE_WORKSPACE_SCHEMA,
				workspaceId,
				ownerPrincipal: input.ownerPrincipal,
				agentId: input.agentId,
				repositoryId: input.repositoryId,
				sourceSnapshotRef,
				proposalRef: input.proposalRef,
				allowedPaths: normalizeAllowedPaths(input.allowedPaths),
				maxBytes: input.maxBytes,
				generation: 1,
				mountPath: "/candidate",
				createdAt: now,
			};
			const workspaceRef = createMeaningfulObjectRef({
				kind: "code-workspace",
				ownerPrincipal: input.ownerPrincipal,
				graphId: input.graphId,
				objectId: workspaceId,
				version: "1",
				value: workspace,
			});
			const record: WorkspaceRecordV1 = {
				schema: RECORD_SCHEMA,
				requestDigest,
				repositoryPath,
				baseRevision,
				workspace,
				workspaceRef,
				sourceSnapshot,
				sourceSnapshotRef,
				lease: mintLease(workspace, now, this.leaseMs, workspace.generation),
				checkpoints: {},
				attestations: {},
				publicationChanges: {},
			};
			await this.writeRecord(record);
			return publicMaterialization(record);
		} catch (error) {
			await rm(workspaceRoot, { recursive: true, force: true });
			throw error;
		}
	}

	async resolveHostPath(lease: WorkspaceLeaseV1, now = Date.now()): Promise<string> {
		const record = await this.requireLease(lease, now);
		return this.treePath(record.workspace.workspaceId);
	}

	async checkpoint(
		lease: WorkspaceLeaseV1,
		now: number,
	): Promise<{ checkpoint: WorkspaceCheckpointV1; checkpointRef: MeaningfulObjectRefV1<"workspace-checkpoint"> }> {
		const record = await this.requireLease(lease, now);
		const treePath = this.treePath(record.workspace.workspaceId);
		const entries = await scanTree(treePath, record.workspace.maxBytes);
		const manifestEntries: CheckpointFileEntry[] = [];
		for (const entry of entries) {
			if (entry.kind === "symlink") {
				manifestEntries.push({ path: entry.path, kind: "symlink", mode: entry.mode, target: entry.target });
			} else {
				const content = await readFile(entry.absolutePath);
				manifestEntries.push({
					path: entry.path,
					kind: "file",
					mode: entry.mode,
					content: content.toString("base64"),
				});
			}
		}
		const manifest: CheckpointManifestV1 = { schema: CHECKPOINT_MANIFEST_SCHEMA, entries: manifestEntries };
		const bytes = Buffer.from(canonicalJson(manifest));
		const contentDigest = sha256(bytes);
		const prior = record.checkpoints[contentDigest];
		if (prior) return prior;
		await this.writeCas(contentDigest, bytes);
		const checkpointId = `checkpoint-${contentDigest.slice("sha256:".length, "sha256:".length + 32)}`;
		const checkpoint: WorkspaceCheckpointV1 = {
			schema: WORKSPACE_CHECKPOINT_SCHEMA,
			checkpointId,
			workspaceRef: record.workspaceRef,
			ownerPrincipal: record.workspace.ownerPrincipal,
			agentId: record.workspace.agentId,
			generation: lease.generation,
			sourceSnapshotRef: record.sourceSnapshotRef,
			contentDigest,
			byteLength: bytes.byteLength,
			fileCount: manifestEntries.length,
			createdAt: now,
		};
		const checkpointRef = createMeaningfulObjectRef({
			kind: "workspace-checkpoint",
			ownerPrincipal: record.workspace.ownerPrincipal,
			graphId: record.workspaceRef.graphId,
			objectId: checkpointId,
			version: String(lease.generation),
			value: checkpoint,
		});
		record.checkpoints[contentDigest] = { checkpoint, checkpointRef };
		await this.writeRecord(record);
		return { checkpoint, checkpointRef };
	}

	async restore(
		lease: WorkspaceLeaseV1,
		checkpointRef: MeaningfulObjectRefV1<"workspace-checkpoint">,
		now: number,
	): Promise<WorkspaceLeaseV1> {
		const record = await this.requireLease(lease, now);
		const entry = Object.values(record.checkpoints).find(
			(value) =>
				value.checkpointRef.digest === checkpointRef.digest &&
				value.checkpointRef.objectId === checkpointRef.objectId,
		);
		if (!entry) throw new WorkspaceFault("checkpoint does not belong to this workspace");
		const bytes = await readFile(this.casPath(entry.checkpoint.contentDigest));
		if (sha256(bytes) !== entry.checkpoint.contentDigest) throw new WorkspaceFault("checkpoint CAS digest mismatch");
		const manifest = parseCheckpointManifest(bytes);
		const treePath = this.treePath(record.workspace.workspaceId);
		const directory = await opendir(treePath);
		for await (const item of directory) {
			if (item.name === ".git") continue;
			await rm(assertWithin(treePath, join(treePath, item.name)), { recursive: true, force: true });
		}
		for (const item of manifest.entries) {
			const targetPath = assertWithin(treePath, join(treePath, item.path));
			await mkdir(dirname(targetPath), { recursive: true });
			if (item.kind === "symlink") {
				if (item.target === undefined) throw new WorkspaceFault("checkpoint symlink target is absent");
				validateSymlinkTarget(treePath, item.path, item.target);
				await symlink(item.target, targetPath);
			} else {
				if (item.content === undefined) throw new WorkspaceFault("checkpoint file content is absent");
				await writeFile(targetPath, Buffer.from(item.content, "base64"), { mode: item.mode });
				await chmod(targetPath, item.mode);
			}
		}
		await scanTree(treePath, record.workspace.maxBytes);
		const nextGeneration = lease.generation + 1;
		record.lease = mintLease(record.workspace, now, this.leaseMs, nextGeneration);
		await this.writeRecord(record);
		return record.lease;
	}

	async attestPatch(lease: WorkspaceLeaseV1, now: number): Promise<PatchAttestationV1> {
		const record = await this.requireLease(lease, now);
		const treePath = this.treePath(record.workspace.workspaceId);
		const entries = await scanTree(treePath, record.workspace.maxBytes);
		const metaDirectory = join(this.workspaceRoot(record.workspace.workspaceId), "meta");
		await mkdir(join(metaDirectory, "indexes"), { recursive: true });
		const indexPath = assertWithin(metaDirectory, join(metaDirectory, "indexes", `index-${randomUUID()}`));
		try {
			await this.git(["-C", treePath, "read-tree", "HEAD"], { GIT_INDEX_FILE: indexPath });
			await this.git(["-C", treePath, "add", "-A", "--", "."], { GIT_INDEX_FILE: indexPath });
			const head = (await this.git(["-C", treePath, "rev-parse", "HEAD"])).trim();
			if (head !== record.baseRevision) {
				throw new WorkspaceFault("workspace base revision changed after materialization", {
					expected: record.baseRevision,
					actual: head,
				});
			}
			const status = await this.git(
				["-C", treePath, "diff", "--cached", "--name-status", "--find-renames", "-z", "HEAD"],
				{ GIT_INDEX_FILE: indexPath },
			);
			const changedPaths = parseNameStatus(status);
			if (changedPaths.length === 0) throw new WorkspaceFault("candidate workspace has no changes to attest");
			assertChangedPathsAllowed(changedPaths, record.workspace.allowedPaths);
			const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
			const secretFindings = await scanSecrets(changedPaths, entryByPath);
			if (secretFindings.length > 0) {
				throw new WorkspaceFault("candidate patch contains a denied secret pattern", { secretFindings });
			}
			const patch = await this.git(
				["-C", treePath, "diff", "--cached", "--binary", "--full-index", "--find-renames", "HEAD"],
				{ GIT_INDEX_FILE: indexPath, maxBuffer: MAX_PATCH_BYTES },
			);
			const patchBytes = Buffer.from(patch);
			if (patchBytes.byteLength > MAX_PATCH_BYTES) throw new WorkspaceFault("patch exceeds host maximum size");
			const patchDigest = sha256(patchBytes);
			const existing = record.attestations[patchDigest];
			if (existing) return existing;
			await this.writeCas(patchDigest, patchBytes);
			const publicationChanges = await materializePublicationChanges(changedPaths, entryByPath);
			const publicationDigest = sha256(canonicalJson(publicationChanges));

			const patchSetId = `patch-${patchDigest.slice("sha256:".length, "sha256:".length + 32)}`;
			const dependencyFilesChanged = changedPaths
				.map((item) => item.path)
				.filter(isDependencyFile)
				.sort();
			const patchSet: PatchSetV1 = {
				schema: PATCH_SET_SCHEMA,
				patchSetId,
				ownerPrincipal: record.workspace.ownerPrincipal,
				agentId: record.workspace.agentId,
				workspaceRef: record.workspaceRef,
				sourceSnapshotRef: record.sourceSnapshotRef,
				baseRevision: record.baseRevision,
				patchDigest,
				publicationDigest,
				patchBytes: patchBytes.byteLength,
				changedPaths,
				dependencyFilesChanged,
				secretFindings,
				createdAt: now,
			};
			const patchSetRef = createMeaningfulObjectRef({
				kind: "patch-set",
				ownerPrincipal: record.workspace.ownerPrincipal,
				graphId: record.workspaceRef.graphId,
				objectId: patchSetId,
				version: String(lease.generation),
				value: patchSet,
			});
			const changeSetId = `change-${sha256(
				canonicalJson({ proposal: record.workspace.proposalRef.digest, patchSet: patchSetRef.digest }),
			).slice("sha256:".length, "sha256:".length + 32)}`;
			const changedPathsDigest = sha256(canonicalJson(changedPaths));
			const changeSet: ChangeSetV1 = {
				schema: CHANGE_SET_SCHEMA,
				changeSetId,
				ownerPrincipal: record.workspace.ownerPrincipal,
				agentId: record.workspace.agentId,
				proposalRef: record.workspace.proposalRef,
				sourceSnapshotRef: record.sourceSnapshotRef,
				patchSetRefs: [patchSetRef],
				changedPathsDigest,
				createdAt: now,
			};
			const changeSetRef = createMeaningfulObjectRef({
				kind: "change-set",
				ownerPrincipal: record.workspace.ownerPrincipal,
				graphId: record.workspaceRef.graphId,
				objectId: changeSetId,
				version: "1",
				value: changeSet,
			});
			const patchArtifactRef = createMeaningfulObjectRef({
				kind: "artifact",
				ownerPrincipal: record.workspace.ownerPrincipal,
				graphId: record.workspaceRef.graphId,
				objectId: patchSetId,
				version: "1",
				value: {
					mediaType: "text/x-diff",
					digest: patchDigest,
					byteLength: patchBytes.byteLength,
				},
			});
			const attestation = { patchSet, patchSetRef, changeSet, changeSetRef, patchArtifactRef };
			record.attestations[patchDigest] = attestation;
			record.publicationChanges[patchDigest] = publicationChanges;
			await this.writeRecord(record);
			return attestation;
		} finally {
			await rm(indexPath, { force: true });
		}
	}

	async readPatchArtifact(
		ref: MeaningfulObjectRefV1<"artifact">,
		lease: WorkspaceLeaseV1,
		now: number,
	): Promise<Buffer> {
		const record = await this.requireLease(lease, now);
		const attestation = Object.values(record.attestations).find(
			(value) => value.patchArtifactRef.digest === ref.digest && value.patchArtifactRef.objectId === ref.objectId,
		);
		if (!attestation) throw new WorkspaceFault("patch artifact does not belong to this workspace");
		const bytes = await readFile(this.casPath(attestation.patchSet.patchDigest));
		if (sha256(bytes) !== attestation.patchSet.patchDigest)
			throw new WorkspaceFault("patch artifact CAS digest mismatch");
		return bytes;
	}

	async readGitPublicationChanges(
		patchSetRef: MeaningfulObjectRefV1<"patch-set">,
		lease: WorkspaceLeaseV1,
		now: number,
	): Promise<readonly GitPublicationChangeV1[]> {
		const record = await this.requireLease(lease, now);
		const attestation = Object.values(record.attestations).find(
			(value) =>
				value.patchSetRef.digest === patchSetRef.digest && value.patchSetRef.objectId === patchSetRef.objectId,
		);
		if (!attestation) throw new WorkspaceFault("patch set does not belong to this workspace");
		const changes = record.publicationChanges[attestation.patchSet.patchDigest];
		if (!changes || sha256(canonicalJson(changes)) !== attestation.patchSet.publicationDigest) {
			throw new WorkspaceFault("publication changes differ from their host attestation");
		}
		return changes;
	}

	async release(lease: WorkspaceLeaseV1, now: number): Promise<void> {
		const record = await this.requireLease(lease, now);
		record.releasedAt = now;
		record.lease = { ...record.lease, expiresAt: now };
		await this.writeRecord(record);
	}

	private async requireLease(lease: WorkspaceLeaseV1, now: number): Promise<WorkspaceRecordV1> {
		const record = await this.readRecord(lease.workspaceId);
		if (
			record.workspace.ownerPrincipal !== lease.ownerPrincipal ||
			record.workspace.agentId !== lease.agentId ||
			record.lease.generation !== lease.generation ||
			record.lease.token !== lease.token
		) {
			throw new WorkspaceFault("workspace lease is stale or belongs to another principal");
		}
		if (record.releasedAt !== undefined || record.lease.expiresAt <= now)
			throw new WorkspaceFault("workspace lease has expired");
		if (record.lease.expiresAt !== lease.expiresAt) throw new WorkspaceFault("workspace lease is stale");
		return record;
	}

	private async ensureDirectories(): Promise<void> {
		await mkdir(this.workspaceDirectory, { recursive: true });
		await mkdir(this.recordDirectory, { recursive: true });
		await mkdir(this.casDirectory, { recursive: true });
	}

	private workspaceRoot(workspaceId: string): string {
		assertWorkspaceId(workspaceId);
		return assertWithin(this.workspaceDirectory, join(this.workspaceDirectory, workspaceId));
	}

	private treePath(workspaceId: string): string {
		return assertWithin(this.workspaceRoot(workspaceId), join(this.workspaceRoot(workspaceId), "tree"));
	}

	private recordPath(workspaceId: string): string {
		assertWorkspaceId(workspaceId);
		return assertWithin(this.recordDirectory, join(this.recordDirectory, `${workspaceId}.json`));
	}

	private casPath(digest: string): string {
		if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new WorkspaceFault("CAS key must be a sha256 digest");
		return assertWithin(this.casDirectory, join(this.casDirectory, digest.slice("sha256:".length)));
	}

	private async readRecordIfPresent(workspaceId: string): Promise<WorkspaceRecordV1 | null> {
		try {
			return parseWorkspaceRecord(await readFile(this.recordPath(workspaceId), "utf8"));
		} catch (error) {
			if (isMissingFile(error)) return null;
			throw error;
		}
	}

	private async readRecord(workspaceId: string): Promise<WorkspaceRecordV1> {
		const record = await this.readRecordIfPresent(workspaceId);
		if (!record) throw new WorkspaceFault("workspace does not exist");
		return record;
	}

	private async writeRecord(record: WorkspaceRecordV1): Promise<void> {
		await this.ensureDirectories();
		const path = this.recordPath(record.workspace.workspaceId);
		const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
		await rename(temporary, path);
	}

	private async writeCas(digest: string, bytes: Buffer): Promise<void> {
		await this.ensureDirectories();
		if (sha256(bytes) !== digest) throw new WorkspaceFault("CAS write digest mismatch");
		const path = this.casPath(digest);
		try {
			const existing = await readFile(path);
			if (sha256(existing) !== digest) throw new WorkspaceFault("existing CAS object is corrupt");
			return;
		} catch (error) {
			if (!isMissingFile(error)) throw error;
		}
		const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, bytes, { mode: 0o600 });
		await rename(temporary, path);
	}

	private async git(
		args: readonly string[],
		overrides: { readonly GIT_INDEX_FILE?: string; readonly maxBuffer?: number } = {},
	): Promise<string> {
		try {
			const result = await execFileAsync(this.gitBin, [...args], {
				env: {
					...process.env,
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_TERMINAL_PROMPT: "0",
					GIT_ASKPASS: "/bin/false",
					...(overrides.GIT_INDEX_FILE ? { GIT_INDEX_FILE: overrides.GIT_INDEX_FILE } : {}),
				},
				encoding: "utf8",
				maxBuffer: overrides.maxBuffer ?? 16 * 1024 * 1024,
			});
			return result.stdout;
		} catch (error) {
			throw new WorkspaceFault("Git workspace operation failed", {
				operation: args[0],
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

function publicMaterialization(record: WorkspaceRecordV1): MaterializedWorkspaceV1 {
	return {
		workspace: record.workspace,
		workspaceRef: record.workspaceRef,
		sourceSnapshot: record.sourceSnapshot,
		sourceSnapshotRef: record.sourceSnapshotRef,
		lease: record.lease,
	};
}

function mintLease(workspace: CodeWorkspaceV1, now: number, leaseMs: number, generation: number): WorkspaceLeaseV1 {
	return {
		workspaceId: workspace.workspaceId,
		ownerPrincipal: workspace.ownerPrincipal,
		agentId: workspace.agentId,
		generation,
		token: randomBytes(32).toString("base64url"),
		expiresAt: now + leaseMs,
	};
}

async function scanTree(treePath: string, maxBytes: number): Promise<ScannedEntry[]> {
	const entries: ScannedEntry[] = [];
	let totalBytes = 0;
	async function visit(directory: string, relativeDirectory: string): Promise<void> {
		const handle = await opendir(directory);
		for await (const item of handle) {
			if (relativeDirectory === "" && item.name === ".git") continue;
			const relativePath = relativeDirectory ? `${relativeDirectory}/${item.name}` : item.name;
			const absolutePath = assertWithin(treePath, join(treePath, ...relativePath.split("/")));
			const stat = await lstat(absolutePath);
			if (stat.isDirectory()) {
				await visit(absolutePath, relativePath);
				continue;
			}
			if (stat.isSymbolicLink()) {
				const target = await readlink(absolutePath);
				validateSymlinkTarget(treePath, relativePath, target);
				entries.push({
					path: relativePath,
					absolutePath,
					kind: "symlink",
					mode: stat.mode & 0o777,
					bytes: 0,
					target,
				});
				continue;
			}
			if (!stat.isFile()) throw new WorkspaceFault("workspace contains a non-file device", { path: relativePath });
			totalBytes += stat.size;
			if (totalBytes > maxBytes)
				throw new WorkspaceFault("workspace exceeds its byte quota", { maxBytes, totalBytes });
			entries.push({ path: relativePath, absolutePath, kind: "file", mode: stat.mode & 0o777, bytes: stat.size });
		}
	}
	await visit(treePath, "");
	return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function validateSymlinkTarget(treePath: string, linkPath: string, target: string): void {
	if (isAbsolute(target)) throw new WorkspaceFault("workspace symlink has an absolute target", { path: linkPath });
	const resolvedTarget = resolve(treePath, dirname(linkPath), target);
	assertWithin(treePath, resolvedTarget);
}

function parseNameStatus(value: string): PatchChangedPathV1[] {
	const tokens = value.split("\0");
	if (tokens.at(-1) === "") tokens.pop();
	const output: PatchChangedPathV1[] = [];
	for (let index = 0; index < tokens.length; ) {
		const code = tokens[index++];
		if (!code) throw new WorkspaceFault("Git returned an empty change status");
		if (code.startsWith("R") || code.startsWith("C")) {
			const previousPath = normalizeRelativePath(tokens[index++] ?? "", "changed previous path");
			const path = normalizeRelativePath(tokens[index++] ?? "", "changed path");
			output.push({ path, previousPath, status: "renamed" });
			continue;
		}
		const path = normalizeRelativePath(tokens[index++] ?? "", "changed path");
		const status: PatchChangedPathV1["status"] =
			code === "A" ? "added" : code === "D" ? "deleted" : code === "T" ? "type-changed" : "modified";
		output.push({ path, status });
	}
	return output.sort((left, right) => left.path.localeCompare(right.path));
}

function assertChangedPathsAllowed(changedPaths: readonly PatchChangedPathV1[], allowedPaths: readonly string[]): void {
	for (const changed of changedPaths) {
		for (const path of [changed.path, ...(changed.previousPath ? [changed.previousPath] : [])]) {
			if (!allowedPaths.some((allowed) => allowed === "." || path === allowed || path.startsWith(`${allowed}/`))) {
				throw new WorkspaceFault("candidate changed a path outside its fence", { path, allowedPaths });
			}
		}
	}
}

async function scanSecrets(
	changedPaths: readonly PatchChangedPathV1[],
	entries: ReadonlyMap<string, ScannedEntry>,
): Promise<Array<{ path: string; rule: string }>> {
	const findings: Array<{ path: string; rule: string }> = [];
	const rules: ReadonlyArray<{ name: string; pattern: RegExp }> = [
		{ name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
		{ name: "aws-access-key", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
		{ name: "github-token", pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/ },
		{ name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
	];
	for (const changed of changedPaths) {
		const entry = entries.get(changed.path);
		if (!entry || entry.kind !== "file" || entry.bytes > 2 * 1024 * 1024) continue;
		const content = await readFile(entry.absolutePath, "utf8").catch(() => "");
		for (const rule of rules) {
			if (rule.pattern.test(content)) findings.push({ path: changed.path, rule: rule.name });
		}
	}
	return findings;
}

async function materializePublicationChanges(
	changedPaths: readonly PatchChangedPathV1[],
	entries: ReadonlyMap<string, ScannedEntry>,
): Promise<GitPublicationChangeV1[]> {
	const changes: GitPublicationChangeV1[] = [];
	let totalBytes = 0;
	for (const changed of changedPaths) {
		if (changed.previousPath) {
			changes.push({ path: changed.previousPath, mode: "100644", delete: true });
		}
		if (changed.status === "deleted") {
			changes.push({ path: changed.path, mode: "100644", delete: true });
			continue;
		}
		const entry = entries.get(changed.path);
		if (!entry || entry.kind !== "file") {
			throw new WorkspaceFault("Git publication supports regular files only", { path: changed.path });
		}
		const content = await readFile(entry.absolutePath);
		totalBytes += content.byteLength;
		if (totalBytes > 1_048_576) throw new WorkspaceFault("Git publication content exceeds the host limit");
		changes.push({
			path: changed.path,
			mode: (entry.mode & 0o111) === 0 ? "100644" : "100755",
			contentBase64: content.toString("base64"),
			contentSha256: createHash("sha256").update(content).digest("hex"),
		});
	}
	return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function isDependencyFile(path: string): boolean {
	const name = path.split("/").at(-1) ?? path;
	return new Set([
		"package.json",
		"pnpm-lock.yaml",
		"package-lock.json",
		"yarn.lock",
		"Cargo.toml",
		"Cargo.lock",
		"pyproject.toml",
		"uv.lock",
		"requirements.txt",
		"go.mod",
		"go.sum",
	]).has(name);
}

function parseWorkspaceRecord(value: string): WorkspaceRecordV1 {
	const parsed = JSON.parse(value) as Partial<WorkspaceRecordV1>;
	if (
		parsed.schema !== RECORD_SCHEMA ||
		!parsed.workspace ||
		!parsed.workspaceRef ||
		!parsed.sourceSnapshotRef ||
		!parsed.lease
	) {
		throw new WorkspaceFault("workspace record is malformed");
	}
	return { ...parsed, publicationChanges: parsed.publicationChanges ?? {} } as WorkspaceRecordV1;
}

function parseCheckpointManifest(value: Buffer): CheckpointManifestV1 {
	const parsed = JSON.parse(value.toString("utf8")) as Partial<CheckpointManifestV1>;
	if (parsed.schema !== CHECKPOINT_MANIFEST_SCHEMA || !Array.isArray(parsed.entries)) {
		throw new WorkspaceFault("checkpoint manifest is malformed");
	}
	for (const entry of parsed.entries) {
		normalizeRelativePath(entry.path, "checkpoint path");
		if (entry.kind !== "file" && entry.kind !== "symlink")
			throw new WorkspaceFault("checkpoint entry kind is invalid");
	}
	return parsed as CheckpointManifestV1;
}

function validateSourceRequest(input: WorkspaceSourceRequestV1): void {
	if (!/^user:[^\s]+$/.test(input.ownerPrincipal))
		throw new WorkspaceFault("workspace owner must be a user principal");
	if (!/^agent-[a-f0-9]{16,64}$/.test(input.agentId)) throw new WorkspaceFault("workspace Agent id is invalid");
	for (const [label, value] of [
		["graphId", input.graphId],
		["repositoryId", input.repositoryId],
		["repositoryPath", input.repositoryPath],
		["baseRevision", input.baseRevision],
	] as const) {
		if (!value.trim()) throw new WorkspaceFault(`${label} is required`);
	}
	if (!isAbsolute(input.repositoryPath)) throw new WorkspaceFault("repositoryPath must be absolute");
	if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1)
		throw new WorkspaceFault("maxBytes must be positive");
	if (input.proposalRef.ownerPrincipal !== input.ownerPrincipal)
		throw new WorkspaceFault("proposal owner differs from workspace owner");
	if (input.proposalRef.graphId !== input.graphId)
		throw new WorkspaceFault("proposal graph differs from workspace graph");
	normalizeAllowedPaths(input.allowedPaths);
}

function normalizeAllowedPaths(value: readonly string[]): string[] {
	if (value.length === 0) throw new WorkspaceFault("at least one allowed path is required");
	const output = value.map((path) => (path === "." ? "." : normalizeRelativePath(path, "allowed path")));
	return [...new Set(output)].sort();
}

function normalizeRelativePath(value: string, label: string): string {
	if (!value || value.includes("\0") || value.includes("\\") || isAbsolute(value)) {
		throw new WorkspaceFault(`${label} must be a portable relative path`, { value });
	}
	const parsed = normalize(value).split(sep).join("/").replace(/^\.\//, "").replace(/\/$/, "");
	if (!parsed || parsed === "." || parsed === ".." || parsed.startsWith("../") || parsed.includes("/../")) {
		throw new WorkspaceFault(`${label} escapes the workspace`, { value });
	}
	if (parsed === ".git" || parsed.startsWith(".git/"))
		throw new WorkspaceFault(`${label} cannot address Git metadata`);
	return parsed;
}

function validateProviderRoot(value: string): string {
	const root = resolve(value);
	if (!isAbsolute(root) || root === resolve(sep) || root.split(sep).filter(Boolean).length < 2) {
		throw new WorkspaceFault("workspace provider requires a narrow absolute root");
	}
	return root;
}

function assertWithin(root: string, target: string): string {
	const resolvedRoot = resolve(root);
	const resolvedTarget = resolve(target);
	const delta = relative(resolvedRoot, resolvedTarget);
	if (delta === "" || (!delta.startsWith("..") && !isAbsolute(delta))) return resolvedTarget;
	throw new WorkspaceFault("path escapes the workspace provider root", { root: resolvedRoot, target: resolvedTarget });
}

function assertWorkspaceId(value: string): void {
	if (!/^ws-[0-9a-f]{32}$/.test(value)) throw new WorkspaceFault("workspace id is invalid");
}

function isMissingFile(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sha256(value: string | Buffer): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
			.join(",")}}`;
	}
	throw new WorkspaceFault("canonical JSON contains an unsupported value");
}
