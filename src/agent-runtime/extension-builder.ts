import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	copyFile,
	lstat,
	mkdir,
	mkdtemp,
	opendir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitWorktreeProvider } from "../workspace/git-workspace-provider.js";
import type { PatchAttestationV1, WorkspaceLeaseV1 } from "../workspace/provider.js";
import {
	canonicalExtensionJson,
	digestPrimeExtensionManifest,
	PRIME_EXTENSION_ARTIFACT_SCHEMA,
	PRIME_EXTENSION_BUILD_RECEIPT_SCHEMA,
	PRIME_EXTENSION_SBOM_SCHEMA,
	type PrimeExtensionArtifactV1,
	type PrimeExtensionBuildReceiptV1,
	PrimeExtensionFault,
	type PrimeExtensionManifestV1,
	type PrimeExtensionSbomV1,
	parsePrimeExtensionManifest,
} from "./extension.js";
import { createMeaningfulObjectRef, type MeaningfulObjectRefV1 } from "./meaningful-object.js";

const execFileAsync = promisify(execFile);
const ARTIFACT_RECORD_SCHEMA = "choreograph.prime-extension-artifact-record.v1" as const;
const RECIPE_ID = "sophia-prime-extension-v1" as const;
const RECIPE_DIGEST = sha256(
	"manifest-v1|no-dependencies|no-network|python-compile-isolated|declared-files-only|content-addressed-read-only",
);

export interface ExtensionArtifactRecordV1 {
	readonly schema: typeof ARTIFACT_RECORD_SCHEMA;
	readonly ownerPrincipal: string;
	readonly artifact: PrimeExtensionArtifactV1;
	readonly artifactRef: MeaningfulObjectRefV1<"release-artifact">;
	readonly buildReceipt: PrimeExtensionBuildReceiptV1;
	readonly buildReceiptRef: MeaningfulObjectRefV1<"build-receipt">;
	readonly sbom: PrimeExtensionSbomV1;
	readonly sbomRef: MeaningfulObjectRefV1<"artifact">;
	readonly skillRefs: readonly MeaningfulObjectRefV1<"skill">[];
	quarantinedAt?: number;
	quarantineReason?: string;
}

export interface ExtensionBuildResultV1 {
	readonly manifest: PrimeExtensionManifestV1;
	readonly artifact: PrimeExtensionArtifactV1;
	readonly artifactRef: MeaningfulObjectRefV1<"release-artifact">;
	readonly buildReceipt: PrimeExtensionBuildReceiptV1;
	readonly buildReceiptRef: MeaningfulObjectRefV1<"build-receipt">;
	readonly sbom: PrimeExtensionSbomV1;
	readonly sbomRef: MeaningfulObjectRefV1<"artifact">;
	readonly skillRefs: readonly MeaningfulObjectRefV1<"skill">[];
}

export interface PrimeExtensionBuilderOptions {
	readonly artifactRoot: string;
	readonly workspaceProvider: GitWorktreeProvider;
	readonly pythonBin?: string;
}

export class PrimeExtensionBuilder {
	private readonly root: string;
	private readonly objectRoot: string;
	private readonly recordRoot: string;
	private readonly stagingRoot: string;
	private readonly pythonBin: string;

	constructor(private readonly options: PrimeExtensionBuilderOptions) {
		this.root = validateArtifactRoot(options.artifactRoot);
		this.objectRoot = join(this.root, "objects");
		this.recordRoot = join(this.root, "records");
		this.stagingRoot = join(this.root, "staging");
		this.pythonBin = options.pythonBin?.trim() || "python3";
	}

	async build(input: {
		readonly lease: WorkspaceLeaseV1;
		readonly attestation: PatchAttestationV1;
		readonly ownerPrincipal: string;
		readonly agentId: string;
		readonly graphId: string;
		readonly allowedCapabilities: ReadonlySet<string>;
		readonly extensionRoot?: string;
		readonly now: number;
	}): Promise<ExtensionBuildResultV1> {
		if (
			input.ownerPrincipal !== input.lease.ownerPrincipal ||
			input.agentId !== input.lease.agentId ||
			input.attestation.patchSet.ownerPrincipal !== input.ownerPrincipal ||
			input.attestation.patchSet.agentId !== input.agentId ||
			input.attestation.patchSet.workspaceRef.objectId !== input.lease.workspaceId
		) {
			throw new PrimeExtensionFault("extension build crosses a workspace owner, Agent, or generation boundary");
		}
		const extensionRoot = safeRelativePath(input.extensionRoot ?? "extension", "extensionRoot");
		for (const changed of input.attestation.patchSet.changedPaths) {
			for (const path of [changed.path, ...(changed.previousPath ? [changed.previousPath] : [])]) {
				if (path !== extensionRoot && !path.startsWith(`${extensionRoot}/`)) {
					throw new PrimeExtensionFault(
						"extension build patch contains a path outside the extension source root",
						{
							path,
						},
					);
				}
			}
		}

		const workspacePath = await this.options.workspaceProvider.resolveHostPath(input.lease, input.now);
		const sourceRoot = within(workspacePath, join(workspacePath, extensionRoot));
		const manifestPath = within(sourceRoot, join(sourceRoot, "manifest.json"));
		const manifestBytes = await readFile(manifestPath);
		if (manifestBytes.byteLength > 1_048_576) throw new PrimeExtensionFault("extension manifest is too large");
		let manifestValue: unknown;
		try {
			manifestValue = JSON.parse(manifestBytes.toString("utf8")) as unknown;
		} catch (error) {
			throw new PrimeExtensionFault("extension manifest is not valid JSON", error);
		}
		const manifest = parsePrimeExtensionManifest(manifestValue, {
			ownerPrincipal: input.ownerPrincipal,
			allowedCapabilities: input.allowedCapabilities,
		});
		const actualFiles = await listRegularFiles(sourceRoot);
		const declaredPaths = new Set(["manifest.json", ...manifest.files.map((file) => file.path)]);
		const undeclared = actualFiles.filter((path) => !declaredPaths.has(path));
		const absent = [...declaredPaths].filter((path) => !actualFiles.includes(path));
		if (undeclared.length > 0 || absent.length > 0) {
			throw new PrimeExtensionFault("extension source and manifest file set differ", { undeclared, absent });
		}

		let byteLength = Buffer.byteLength(canonicalExtensionJson(manifest));
		for (const file of manifest.files) {
			const source = within(sourceRoot, join(sourceRoot, ...file.path.split("/")));
			const metadata = await lstat(source);
			if (!metadata.isFile() || metadata.isSymbolicLink()) {
				throw new PrimeExtensionFault("extension source must contain regular files only", { path: file.path });
			}
			const bytes = await readFile(source);
			byteLength += bytes.byteLength;
			if (sha256(bytes) !== file.digest) {
				throw new PrimeExtensionFault("extension file digest differs from manifest", { path: file.path });
			}
			const mode = (metadata.mode & 0o111) === 0 ? "0444" : "0555";
			if (mode !== file.mode)
				throw new PrimeExtensionFault("extension file mode differs from manifest", { path: file.path });
			await this.compilePython(source);
		}

		const manifestDigest = digestPrimeExtensionManifest(manifest);
		const artifactDigest = sha256(
			canonicalExtensionJson({
				format: "sophia.prime-extension-artifact.v1",
				manifestDigest,
				files: manifest.files,
			}),
		);
		const sbomBody = {
			extensionId: manifest.extensionId,
			version: manifest.version,
			dependencies: [] as const,
			files: manifest.files,
		};
		const sbomDigest = sha256(canonicalExtensionJson(sbomBody));
		const sbom: PrimeExtensionSbomV1 = {
			schema: PRIME_EXTENSION_SBOM_SCHEMA,
			...sbomBody,
			digest: sbomDigest,
		};
		const artifactId = `extension-${artifactDigest.slice("sha256:".length, "sha256:".length + 32)}`;
		const artifact: PrimeExtensionArtifactV1 = {
			schema: PRIME_EXTENSION_ARTIFACT_SCHEMA,
			artifactId,
			ownerPrincipal: input.ownerPrincipal,
			extensionId: manifest.extensionId,
			extensionVersion: manifest.version,
			abi: manifest.abi,
			artifactDigest,
			manifestDigest,
			sbomDigest,
			byteLength,
			fileCount: manifest.files.length + 2,
			createdAt: input.now,
		};
		const buildId = `build-${artifactDigest.slice("sha256:".length, "sha256:".length + 32)}`;
		const buildReceipt: PrimeExtensionBuildReceiptV1 = {
			schema: PRIME_EXTENSION_BUILD_RECEIPT_SCHEMA,
			buildId,
			ownerPrincipal: input.ownerPrincipal,
			agentId: input.agentId,
			recipeId: RECIPE_ID,
			recipeDigest: RECIPE_DIGEST,
			sourceSnapshotDigest: input.attestation.patchSet.sourceSnapshotRef.digest,
			patchSetDigest: input.attestation.patchSetRef.digest,
			manifestDigest,
			artifactDigest,
			sbomDigest,
			checks: [
				{ name: "manifest", passed: true },
				{ name: "source-fence", passed: true },
				{ name: "python-compile", passed: true },
				{ name: "capability-subset", passed: true },
				{ name: "immutability", passed: true },
			],
			networkUsed: false,
			builtAt: input.now,
		};
		const artifactRef = createMeaningfulObjectRef({
			kind: "release-artifact",
			ownerPrincipal: input.ownerPrincipal,
			graphId: input.graphId,
			objectId: artifactId,
			version: manifest.version,
			value: artifact,
		});
		const buildReceiptRef = createMeaningfulObjectRef({
			kind: "build-receipt",
			ownerPrincipal: input.ownerPrincipal,
			graphId: input.graphId,
			objectId: buildId,
			version: "1",
			value: buildReceipt,
		});
		const sbomRef = createMeaningfulObjectRef({
			kind: "artifact",
			ownerPrincipal: input.ownerPrincipal,
			graphId: input.graphId,
			objectId: `${artifactId}-sbom`,
			version: "1",
			value: sbom,
		});
		const skillRefs = manifest.skills.map((skill) =>
			createMeaningfulObjectRef({
				kind: "skill",
				ownerPrincipal: input.ownerPrincipal,
				graphId: input.graphId,
				objectId: `${manifest.extensionId}:${skill.name}`,
				version: manifest.version,
				value: { ...skill, extensionArtifactDigest: artifactDigest, abi: manifest.abi },
			}),
		);
		const record: ExtensionArtifactRecordV1 = {
			schema: ARTIFACT_RECORD_SCHEMA,
			ownerPrincipal: input.ownerPrincipal,
			artifact,
			artifactRef,
			buildReceipt,
			buildReceiptRef,
			sbom,
			sbomRef,
			skillRefs,
		};
		await this.materializeArtifact(sourceRoot, manifest, sbom, record);
		return { manifest, artifact, artifactRef, buildReceipt, buildReceiptRef, sbom, sbomRef, skillRefs };
	}

	async resolveArtifact(
		ownerPrincipal: string,
		artifactRef: MeaningfulObjectRefV1<"release-artifact">,
	): Promise<{ readonly hostPath: string; readonly record: ExtensionArtifactRecordV1 }> {
		if (artifactRef.ownerPrincipal !== ownerPrincipal) throw new PrimeExtensionFault("artifact owner mismatch");
		const record = await this.readRecord(ownerPrincipal, artifactRef.digest);
		if (record.artifactRef.digest !== artifactRef.digest || record.artifactRef.objectId !== artifactRef.objectId) {
			throw new PrimeExtensionFault("artifact ref differs from registry record");
		}
		if (record.quarantinedAt !== undefined) throw new PrimeExtensionFault("extension artifact is quarantined");
		const hostPath = this.objectPath(record.artifact.artifactDigest);
		await this.verifyArtifact(hostPath, record);
		return { hostPath, record };
	}

	async quarantine(
		ownerPrincipal: string,
		artifactRef: MeaningfulObjectRefV1<"release-artifact">,
		reason: string,
		now: number,
	): Promise<void> {
		const record = await this.readRecord(ownerPrincipal, artifactRef.digest);
		if (record.artifactRef.digest !== artifactRef.digest) throw new PrimeExtensionFault("artifact ref mismatch");
		record.quarantinedAt = now;
		record.quarantineReason = reason.trim() || "quarantined";
		await this.writeRecord(record);
	}

	private async materializeArtifact(
		sourceRoot: string,
		manifest: PrimeExtensionManifestV1,
		sbom: PrimeExtensionSbomV1,
		record: ExtensionArtifactRecordV1,
	): Promise<void> {
		await this.ensureRoots();
		const destination = this.objectPath(record.artifact.artifactDigest);
		try {
			await stat(destination);
			await this.verifyArtifact(destination, record);
			await this.writeRecord(record);
			return;
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		const stage = await mkdtemp(join(this.stagingRoot, "extension-"));
		try {
			await writeFile(join(stage, "manifest.json"), `${canonicalExtensionJson(manifest)}\n`, { mode: 0o444 });
			await writeFile(join(stage, "sbom.json"), `${canonicalExtensionJson(sbom)}\n`, { mode: 0o444 });
			for (const file of manifest.files) {
				const source = within(sourceRoot, join(sourceRoot, ...file.path.split("/")));
				const target = within(stage, join(stage, ...file.path.split("/")));
				await mkdir(dirname(target), { recursive: true });
				await copyFile(source, target);
				await chmod(target, file.mode === "0555" ? 0o555 : 0o444);
			}
			await rename(stage, destination);
			await makeDirectoriesReadOnly(destination);
			await this.verifyArtifact(destination, record);
			await this.writeRecord(record);
		} catch (error) {
			await chmodTreeWritable(stage).catch(() => {});
			await rm(stage, { recursive: true, force: true });
			throw error;
		}
	}

	private async verifyArtifact(hostPath: string, record: ExtensionArtifactRecordV1): Promise<void> {
		const manifestValue = JSON.parse(await readFile(join(hostPath, "manifest.json"), "utf8")) as unknown;
		const manifest = parsePrimeExtensionManifest(manifestValue, {
			ownerPrincipal: record.ownerPrincipal,
			allowedCapabilities: new Set(
				record.skillRefs.length === 0
					? []
					: (manifestValue as PrimeExtensionManifestV1).skills.flatMap((skill) => skill.requiredCapabilities),
			),
		});
		if (digestPrimeExtensionManifest(manifest) !== record.artifact.manifestDigest) {
			throw new PrimeExtensionFault("installed extension manifest digest mismatch");
		}
		for (const file of manifest.files) {
			const path = within(hostPath, join(hostPath, ...file.path.split("/")));
			if (sha256(await readFile(path)) !== file.digest)
				throw new PrimeExtensionFault("installed extension file digest mismatch");
		}
		const computedArtifactDigest = sha256(
			canonicalExtensionJson({
				format: "sophia.prime-extension-artifact.v1",
				manifestDigest: record.artifact.manifestDigest,
				files: manifest.files,
			}),
		);
		if (computedArtifactDigest !== record.artifact.artifactDigest) {
			throw new PrimeExtensionFault("installed extension artifact digest mismatch");
		}
	}

	private async compilePython(path: string): Promise<void> {
		const script = [
			"import pathlib,resource,sys",
			"limits=((resource.RLIMIT_CORE,0,0),(resource.RLIMIT_CPU,5,6),(resource.RLIMIT_FSIZE,2097152,2097152),(resource.RLIMIT_NOFILE,32,32),(resource.RLIMIT_AS,268435456,268435456))",
			"for resource_id,soft,hard in limits:",
			"    current_soft,current_hard=resource.getrlimit(resource_id)",
			"    bounded_hard=hard if current_hard==resource.RLIM_INFINITY else min(hard,current_hard)",
			"    try:",
			"        resource.setrlimit(resource_id,(min(soft,bounded_hard),bounded_hard))",
			"    except (OSError,ValueError):",
			"        if sys.platform!='darwin' or resource_id!=resource.RLIMIT_AS:",
			"            raise",
			"compile(pathlib.Path(sys.argv[1]).read_bytes(),sys.argv[1],'exec')",
		].join("\n");
		try {
			await execFileAsync(this.pythonBin, ["-I", "-c", script, path], {
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
				maxBuffer: 1_048_576,
			});
		} catch (error) {
			throw new PrimeExtensionFault("extension Python source failed isolated compilation", {
				path: basename(path),
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async ensureRoots(): Promise<void> {
		await mkdir(this.objectRoot, { recursive: true });
		await mkdir(this.recordRoot, { recursive: true });
		await mkdir(this.stagingRoot, { recursive: true });
	}

	private objectPath(digest: string): string {
		return within(this.objectRoot, join(this.objectRoot, digestHex(digest)));
	}

	private recordPath(ownerPrincipal: string, refDigest: string): string {
		const owner = createHash("sha256").update(ownerPrincipal).digest("hex");
		return within(this.recordRoot, join(this.recordRoot, owner, `${digestHex(refDigest)}.json`));
	}

	private async writeRecord(record: ExtensionArtifactRecordV1): Promise<void> {
		await this.ensureRoots();
		const path = this.recordPath(record.ownerPrincipal, record.artifactRef.digest);
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
		await rename(temporary, path);
	}

	private async readRecord(ownerPrincipal: string, refDigest: string): Promise<ExtensionArtifactRecordV1> {
		let parsed: Partial<ExtensionArtifactRecordV1>;
		try {
			parsed = JSON.parse(
				await readFile(this.recordPath(ownerPrincipal, refDigest), "utf8"),
			) as Partial<ExtensionArtifactRecordV1>;
		} catch (error) {
			if (isMissing(error)) throw new PrimeExtensionFault("extension artifact is not installed for this owner");
			throw error;
		}
		if (parsed.schema !== ARTIFACT_RECORD_SCHEMA || parsed.ownerPrincipal !== ownerPrincipal || !parsed.artifactRef) {
			throw new PrimeExtensionFault("extension artifact registry record is malformed");
		}
		return parsed as ExtensionArtifactRecordV1;
	}
}

async function listRegularFiles(root: string): Promise<string[]> {
	const output: string[] = [];
	async function visit(directory: string, prefix: string): Promise<void> {
		const handle = await opendir(directory);
		for await (const item of handle) {
			const path = prefix ? `${prefix}/${item.name}` : item.name;
			const absolute = within(root, join(root, ...path.split("/")));
			const metadata = await lstat(absolute);
			if (metadata.isDirectory()) {
				await visit(absolute, path);
				continue;
			}
			if (!metadata.isFile() || metadata.isSymbolicLink()) {
				throw new PrimeExtensionFault("extension source contains a non-regular file", { path });
			}
			output.push(path);
		}
	}
	await visit(root, "");
	return output.sort();
}

async function makeDirectoriesReadOnly(root: string): Promise<void> {
	const directories: string[] = [root];
	async function visit(directory: string): Promise<void> {
		const handle = await opendir(directory);
		for await (const item of handle) {
			if (!item.isDirectory()) continue;
			const child = join(directory, item.name);
			directories.push(child);
			await visit(child);
		}
	}
	await visit(root);
	for (const directory of directories.reverse()) await chmod(directory, 0o555);
}

async function chmodTreeWritable(root: string): Promise<void> {
	try {
		await chmod(root, 0o755);
	} catch (error) {
		if (isMissing(error)) return;
		throw error;
	}
	const handle = await opendir(root);
	for await (const item of handle) {
		if (item.isDirectory()) await chmodTreeWritable(join(root, item.name));
	}
}

function validateArtifactRoot(value: string): string {
	if (!isAbsolute(value)) throw new PrimeExtensionFault("artifact root must be absolute");
	const root = resolve(value);
	if (root === "/" || root.split("/").filter(Boolean).length < 2)
		throw new PrimeExtensionFault("artifact root is too broad");
	return root;
}

function safeRelativePath(value: string, label: string): string {
	if (
		!value ||
		value.startsWith("/") ||
		value.includes("\\") ||
		value.split("/").some((part) => !part || part === "." || part === "..")
	) {
		throw new PrimeExtensionFault(`${label} is not a safe relative path`);
	}
	return value;
}

function within(root: string, value: string): string {
	const absoluteRoot = resolve(root);
	const absolute = resolve(value);
	const delta = relative(absoluteRoot, absolute);
	if (delta === "" || (!delta.startsWith("..") && !isAbsolute(delta))) return absolute;
	throw new PrimeExtensionFault("extension path escapes its root");
}

function digestHex(value: string): string {
	if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new PrimeExtensionFault("artifact digest is invalid");
	return value.slice("sha256:".length);
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sha256(value: string | Buffer): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
