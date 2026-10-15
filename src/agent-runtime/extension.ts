import { createHash } from "node:crypto";

export const PRIME_EXTENSION_ABI = "sophia.prime-extension.v1" as const;
export const PRIME_EXTENSION_MANIFEST_SCHEMA = "sophia.prime-extension-manifest.v1" as const;
export const PRIME_EXTENSION_BUILD_RECEIPT_SCHEMA = "sophia.prime-extension-build-receipt.v1" as const;
export const PRIME_EXTENSION_ARTIFACT_SCHEMA = "sophia.prime-extension-artifact.v1" as const;
export const PRIME_EXTENSION_SBOM_SCHEMA = "sophia.prime-extension-sbom.v1" as const;

export interface PrimeExtensionFileV1 {
	readonly path: string;
	readonly digest: string;
	readonly mode: "0444" | "0555";
}

export interface PrimeExtensionSkillV1 {
	readonly name: string;
	readonly description: string;
	readonly entrypoint: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
	readonly outputSchema: Readonly<Record<string, unknown>>;
	readonly requiredCapabilities: readonly string[];
}

export interface PrimeExtensionManifestV1 {
	readonly schema: typeof PRIME_EXTENSION_MANIFEST_SCHEMA;
	readonly extensionId: string;
	readonly version: string;
	readonly ownerPrincipal: string;
	readonly abi: typeof PRIME_EXTENSION_ABI;
	readonly displayName: string;
	readonly description: string;
	readonly network: "denied";
	readonly dependencies: readonly [];
	readonly files: readonly PrimeExtensionFileV1[];
	readonly skills: readonly PrimeExtensionSkillV1[];
}

export interface PrimeExtensionSbomV1 {
	readonly schema: typeof PRIME_EXTENSION_SBOM_SCHEMA;
	readonly extensionId: string;
	readonly version: string;
	readonly dependencies: readonly [];
	readonly files: readonly PrimeExtensionFileV1[];
	readonly digest: string;
}

export interface PrimeExtensionBuildReceiptV1 {
	readonly schema: typeof PRIME_EXTENSION_BUILD_RECEIPT_SCHEMA;
	readonly buildId: string;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly recipeId: "sophia-prime-extension-v1";
	readonly recipeDigest: string;
	readonly sourceSnapshotDigest: string;
	readonly patchSetDigest: string;
	readonly manifestDigest: string;
	readonly artifactDigest: string;
	readonly sbomDigest: string;
	readonly checks: readonly {
		readonly name: "manifest" | "source-fence" | "python-compile" | "capability-subset" | "immutability";
		readonly passed: true;
	}[];
	readonly networkUsed: false;
	readonly builtAt: number;
}

export interface PrimeExtensionArtifactV1 {
	readonly schema: typeof PRIME_EXTENSION_ARTIFACT_SCHEMA;
	readonly artifactId: string;
	readonly ownerPrincipal: string;
	readonly extensionId: string;
	readonly extensionVersion: string;
	readonly abi: typeof PRIME_EXTENSION_ABI;
	readonly artifactDigest: string;
	readonly manifestDigest: string;
	readonly sbomDigest: string;
	readonly byteLength: number;
	readonly fileCount: number;
	readonly createdAt: number;
}

export class PrimeExtensionFault extends Error {
	readonly code = "prime_extension_invalid";

	constructor(
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "PrimeExtensionFault";
	}
}

export function parsePrimeExtensionManifest(
	value: unknown,
	input: { readonly ownerPrincipal: string; readonly allowedCapabilities: ReadonlySet<string> },
): PrimeExtensionManifestV1 {
	const manifest = record(value, "extension manifest");
	knownKeys(manifest, [
		"schema",
		"extensionId",
		"version",
		"ownerPrincipal",
		"abi",
		"displayName",
		"description",
		"network",
		"dependencies",
		"files",
		"skills",
	]);
	if (manifest.schema !== PRIME_EXTENSION_MANIFEST_SCHEMA) fault("extension manifest schema is unsupported");
	const extensionId = text(manifest.extensionId, "extensionId");
	if (!/^[a-z][a-z0-9-]{1,63}$/.test(extensionId)) fault("extensionId is invalid");
	const version = text(manifest.version, "version");
	if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/.test(version)) fault("extension version must be semantic");
	const ownerPrincipal = text(manifest.ownerPrincipal, "ownerPrincipal");
	if (ownerPrincipal !== input.ownerPrincipal || !/^user:[^\s]+$/.test(ownerPrincipal)) {
		fault("extension owner differs from the exact user owner");
	}
	if (manifest.abi !== PRIME_EXTENSION_ABI) fault("extension ABI is unsupported");
	const displayName = text(manifest.displayName, "displayName");
	const description = text(manifest.description, "description");
	if (manifest.network !== "denied") fault("extension network policy must be denied");
	if (!Array.isArray(manifest.dependencies) || manifest.dependencies.length !== 0) {
		fault("extension ABI v1 does not permit runtime dependencies");
	}
	if (!Array.isArray(manifest.files) || manifest.files.length === 0) fault("extension must declare files");
	const paths = new Set<string>();
	const files = manifest.files.map((raw, index): PrimeExtensionFileV1 => {
		const file = record(raw, `files[${index}]`);
		knownKeys(file, ["path", "digest", "mode"]);
		const path = extensionPath(file.path, `files[${index}].path`);
		if (!path.startsWith("python/") || !path.endsWith(".py")) {
			fault("extension ABI v1 artifacts may contain Python source files only", { path });
		}
		if (paths.has(path)) fault("extension file path is duplicated", { path });
		paths.add(path);
		const digest = digestString(file.digest, `files[${index}].digest`);
		if (file.mode !== "0444" && file.mode !== "0555") fault("extension file mode is unsupported", { path });
		return { path, digest, mode: file.mode };
	});
	if (!Array.isArray(manifest.skills) || manifest.skills.length === 0)
		fault("extension must declare at least one skill");
	const skillNames = new Set<string>();
	const skills = manifest.skills.map((raw, index): PrimeExtensionSkillV1 => {
		const skill = record(raw, `skills[${index}]`);
		knownKeys(skill, ["name", "description", "entrypoint", "inputSchema", "outputSchema", "requiredCapabilities"]);
		const name = text(skill.name, `skills[${index}].name`);
		if (!/^[a-z][a-z0-9_-]{1,63}$/.test(name) || skillNames.has(name))
			fault("extension skill name is invalid or duplicated");
		skillNames.add(name);
		const skillDescription = text(skill.description, `skills[${index}].description`);
		const entrypoint = text(skill.entrypoint, `skills[${index}].entrypoint`);
		const match = /^([a-zA-Z_][a-zA-Z0-9_.]*):([a-zA-Z_][a-zA-Z0-9_]*)$/.exec(entrypoint);
		if (!match) fault("extension skill entrypoint is invalid", { entrypoint });
		const modulePath = `python/${match[1]?.replaceAll(".", "/")}.py`;
		const packagePath = `python/${match[1]?.replaceAll(".", "/")}/__init__.py`;
		if (!paths.has(modulePath) && !paths.has(packagePath))
			fault("extension skill entrypoint is not declared as a file");
		const inputSchema = jsonSchema(skill.inputSchema, `skills[${index}].inputSchema`);
		const outputSchema = jsonSchema(skill.outputSchema, `skills[${index}].outputSchema`);
		if (!Array.isArray(skill.requiredCapabilities)) fault("requiredCapabilities must be an array");
		const requiredCapabilities = skill.requiredCapabilities.map((item, capabilityIndex) =>
			text(item, `skills[${index}].requiredCapabilities[${capabilityIndex}]`),
		);
		if (new Set(requiredCapabilities).size !== requiredCapabilities.length)
			fault("requiredCapabilities contains duplicates");
		for (const capability of requiredCapabilities) {
			if (!input.allowedCapabilities.has(capability)) {
				fault("extension requests a capability outside the steward-approved subset", { capability });
			}
		}
		return {
			name,
			description: skillDescription,
			entrypoint,
			inputSchema,
			outputSchema,
			requiredCapabilities,
		};
	});
	return {
		schema: PRIME_EXTENSION_MANIFEST_SCHEMA,
		extensionId,
		version,
		ownerPrincipal,
		abi: PRIME_EXTENSION_ABI,
		displayName,
		description,
		network: "denied",
		dependencies: [],
		files,
		skills,
	};
}

export function digestPrimeExtensionManifest(manifest: PrimeExtensionManifestV1): string {
	return sha256(canonicalJson(manifest));
}

function jsonSchema(value: unknown, label: string): Readonly<Record<string, unknown>> {
	const schema = record(value, label);
	assertNoRemoteReferences(schema, label);
	return schema;
}

function assertNoRemoteReferences(value: unknown, label: string): void {
	if (Array.isArray(value)) {
		for (const item of value) assertNoRemoteReferences(item, label);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	for (const [key, item] of Object.entries(value)) {
		if (key === "$ref" && typeof item === "string" && !item.startsWith("#")) {
			fault(`${label} contains a remote schema reference`);
		}
		assertNoRemoteReferences(item, label);
	}
}

function extensionPath(value: unknown, label: string): string {
	const path = text(value, label);
	if (
		path.startsWith("/") ||
		path.includes("\\") ||
		path.includes("\0") ||
		path.split("/").some((part) => !part || part === "." || part === "..")
	) {
		fault(`${label} is not a safe relative path`);
	}
	return path;
}

function digestString(value: unknown, label: string): string {
	const parsed = text(value, label);
	if (!/^sha256:[0-9a-f]{64}$/.test(parsed)) fault(`${label} is not a lowercase sha256 digest`);
	return parsed;
}

function text(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) fault(`${label} is required`);
	return value as string;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) fault(`${label} must be an object`);
	return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
	const set = new Set(allowed);
	const unknown = Object.keys(value).filter((key) => !set.has(key));
	if (unknown.length > 0) fault("extension object contains unknown fields", { unknown });
}

function sha256(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function canonicalExtensionJson(value: unknown): string {
	return canonicalJson(value);
}

function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const object = value as Record<string, unknown>;
		return `{${Object.keys(object)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
			.join(",")}}`;
	}
	fault("extension value is not canonical JSON");
}

function fault(message: string, details?: unknown): never {
	throw new PrimeExtensionFault(message, details);
}
