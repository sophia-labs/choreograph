import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Ajv from "ajv";
import type { EmbodimentCandidateV1, EvaluationPolicyV1 } from "./evolution.js";
import { validateEmbodimentCandidate, validateEvaluationPolicy } from "./evolution.js";
import { canonicalExtensionJson, PrimeExtensionFault } from "./extension.js";
import type { ExtensionBuildResultV1, PrimeExtensionBuilder } from "./extension-builder.js";
import { createMeaningfulObjectRef, type MeaningfulObjectRefV1, sameMeaningfulObjectRef } from "./meaningful-object.js";

const execFileAsync = promisify(execFile);
const EVALUATOR_PROGRAM = fileURLToPath(new URL("./extension-evaluator.py", import.meta.url));
export const EXTENSION_EVALUATION_SUITE_SCHEMA = "sophia.extension-evaluation-suite.v1" as const;
export const EXTENSION_VERIFICATION_RUN_SCHEMA = "sophia.extension-verification-run.v1" as const;

export interface ExtensionEvaluationSuiteV1 {
	readonly schema: typeof EXTENSION_EVALUATION_SUITE_SCHEMA;
	readonly suiteId: string;
	readonly ownerPrincipal: string;
	readonly skillName: string;
	readonly fixtures: readonly {
		readonly caseId: string;
		readonly input: unknown;
		readonly expectedOutput: unknown;
	}[];
	readonly timeoutMs: number;
	readonly maximumOutputBytes: number;
	readonly createdAt: number;
}

export interface ExtensionVerificationRunV1 {
	readonly schema: typeof EXTENSION_VERIFICATION_RUN_SCHEMA;
	readonly runId: string;
	readonly ownerPrincipal: string;
	readonly agentId: string;
	readonly candidateId: string;
	readonly candidateRuntimeBindingDigest: string;
	readonly artifactRef: MeaningfulObjectRefV1<"release-artifact">;
	readonly artifactDigest: string;
	readonly policyRef: MeaningfulObjectRefV1<"evaluation-policy">;
	readonly suiteRef: MeaningfulObjectRefV1<"evaluation-suite">;
	readonly suiteDigest: string;
	readonly securityIssues: readonly string[];
	readonly cases: readonly {
		readonly caseId: string;
		readonly passed: boolean;
		readonly deterministic: boolean;
		readonly inputSchemaValid: boolean;
		readonly outputSchemaValid: boolean;
		readonly durationMs: number;
		readonly outputDigest?: string;
		readonly failure?: string;
	}[];
	readonly passed: boolean;
	readonly passRate: number;
	readonly newSecurityFailures: number;
	readonly modelCalls: 0;
	readonly tokens: 0;
	readonly costUsdMicros: 0;
	readonly startedAt: number;
	readonly completedAt: number;
}

export interface ExtensionEvaluationResultV1 {
	readonly run: ExtensionVerificationRunV1;
	readonly runRef: MeaningfulObjectRefV1<"verification-run">;
	readonly eligible: boolean;
}

export function validateExtensionVerificationRun(value: unknown): asserts value is ExtensionVerificationRunV1 {
	if (!isRecord(value) || value.schema !== EXTENSION_VERIFICATION_RUN_SCHEMA) {
		throw new PrimeExtensionFault("extension verification run schema is invalid");
	}
	for (const key of ["runId", "ownerPrincipal", "agentId", "candidateId", "candidateRuntimeBindingDigest"] as const) {
		if (typeof value[key] !== "string" || !value[key].trim()) {
			throw new PrimeExtensionFault(`extension verification run ${key} is required`);
		}
	}
	for (const key of ["artifactDigest", "suiteDigest"] as const) {
		if (typeof value[key] !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value[key])) {
			throw new PrimeExtensionFault(`extension verification run ${key} is invalid`);
		}
	}
	if (!isRecord(value.artifactRef) || value.artifactRef.kind !== "release-artifact") {
		throw new PrimeExtensionFault("extension verification run artifact ref is invalid");
	}
	if (!isRecord(value.policyRef) || value.policyRef.kind !== "evaluation-policy") {
		throw new PrimeExtensionFault("extension verification run policy ref is invalid");
	}
	if (!isRecord(value.suiteRef) || value.suiteRef.kind !== "evaluation-suite") {
		throw new PrimeExtensionFault("extension verification run suite ref is invalid");
	}
	if (!Array.isArray(value.securityIssues) || !value.securityIssues.every((item) => typeof item === "string")) {
		throw new PrimeExtensionFault("extension verification security testimony is invalid");
	}
	if (!Array.isArray(value.cases)) throw new PrimeExtensionFault("extension verification cases are invalid");
	if (
		typeof value.passed !== "boolean" ||
		typeof value.passRate !== "number" ||
		value.passRate < 0 ||
		value.passRate > 1
	) {
		throw new PrimeExtensionFault("extension verification verdict is invalid");
	}
	if (value.newSecurityFailures !== value.securityIssues.length) {
		throw new PrimeExtensionFault("extension verification security failure count differs from testimony");
	}
	if (value.modelCalls !== 0 || value.tokens !== 0 || value.costUsdMicros !== 0) {
		throw new PrimeExtensionFault("deterministic extension verification cannot claim model spend");
	}
	if (
		typeof value.startedAt !== "number" ||
		typeof value.completedAt !== "number" ||
		!Number.isSafeInteger(value.startedAt) ||
		!Number.isSafeInteger(value.completedAt) ||
		value.completedAt < value.startedAt
	) {
		throw new PrimeExtensionFault("extension verification timestamps are invalid");
	}
	const passedCases = value.cases.filter((item) => isRecord(item) && item.passed === true).length;
	const computedPassRate = value.cases.length === 0 ? 0 : passedCases / value.cases.length;
	if (computedPassRate !== value.passRate)
		throw new PrimeExtensionFault("extension verification pass rate is inconsistent");
	if (
		value.passed &&
		(value.securityIssues.length !== 0 || value.cases.some((item) => !isRecord(item) || item.passed !== true))
	) {
		throw new PrimeExtensionFault("passing extension verification contains failed evidence");
	}
}

export class ExtensionEvaluationCoordinator {
	constructor(
		private readonly builder: PrimeExtensionBuilder,
		private readonly options: {
			readonly pythonBin?: string;
			readonly bwrapBin?: string;
			readonly now?: () => number;
		} = {},
	) {}

	async evaluate(input: {
		readonly candidate: EmbodimentCandidateV1;
		readonly build: ExtensionBuildResultV1;
		readonly policy: EvaluationPolicyV1;
		readonly policyRef: MeaningfulObjectRefV1<"evaluation-policy">;
		readonly suite: ExtensionEvaluationSuiteV1;
		readonly suiteRef: MeaningfulObjectRefV1<"evaluation-suite">;
		readonly graphId: string;
	}): Promise<ExtensionEvaluationResultV1> {
		validateEmbodimentCandidate(input.candidate);
		validateEvaluationPolicy(input.policy);
		validateSuite(input.suite);
		assertEvaluationBindings(input);
		const startedAt = this.options.now?.() ?? Date.now();
		const installed = await this.builder.resolveArtifact(input.candidate.ownerPrincipal, input.build.artifactRef);
		const skill = input.build.manifest.skills.find((item) => item.name === input.suite.skillName);
		if (!skill) throw new PrimeExtensionFault("evaluation suite names a skill absent from the artifact");
		const [moduleName, functionName] = skill.entrypoint.split(":");
		if (!moduleName || !functionName) throw new PrimeExtensionFault("installed skill entrypoint is malformed");
		const modulePath = moduleName.replaceAll(".", "/");
		const sourcePath = input.build.manifest.files.some((file) => file.path === `python/${modulePath}.py`)
			? join(installed.hostPath, "python", `${modulePath}.py`)
			: join(installed.hostPath, "python", modulePath, "__init__.py");
		const securityIssues = await this.scan(sourcePath, input.suite.timeoutMs);
		const cases: ExtensionVerificationRunV1["cases"][number][] = [];
		if (securityIssues.length === 0) {
			const ajv = new Ajv({ strict: true, allErrors: true });
			const validateInput = ajv.compile(skill.inputSchema);
			const validateOutput = ajv.compile(skill.outputSchema);
			for (const fixture of input.suite.fixtures) {
				const caseStartedAt = this.options.now?.() ?? Date.now();
				const inputSchemaValid = validateInput(fixture.input) as boolean;
				try {
					if (!inputSchemaValid)
						throw new PrimeExtensionFault("evaluation fixture violates the skill input schema");
					const first = await this.run(sourcePath, functionName, fixture.input, input.suite.timeoutMs);
					const second = await this.run(sourcePath, functionName, fixture.input, input.suite.timeoutMs);
					const outputBytes = Buffer.byteLength(canonicalExtensionJson(first));
					if (outputBytes > input.suite.maximumOutputBytes)
						throw new PrimeExtensionFault("extension output exceeds suite limit");
					const deterministic = canonicalExtensionJson(first) === canonicalExtensionJson(second);
					const outputSchemaValid = validateOutput(first) as boolean;
					const expected = canonicalExtensionJson(first) === canonicalExtensionJson(fixture.expectedOutput);
					cases.push({
						caseId: fixture.caseId,
						passed: inputSchemaValid && outputSchemaValid && deterministic && expected,
						deterministic,
						inputSchemaValid,
						outputSchemaValid,
						durationMs: (this.options.now?.() ?? Date.now()) - caseStartedAt,
						outputDigest: sha256(canonicalExtensionJson(first)),
					});
				} catch (error) {
					cases.push({
						caseId: fixture.caseId,
						passed: false,
						deterministic: false,
						inputSchemaValid,
						outputSchemaValid: false,
						durationMs: (this.options.now?.() ?? Date.now()) - caseStartedAt,
						failure: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
		const passedCount = cases.filter((item) => item.passed).length;
		const passRate = input.suite.fixtures.length === 0 ? 0 : passedCount / input.suite.fixtures.length;
		const passed =
			securityIssues.length === 0 &&
			cases.length === input.suite.fixtures.length &&
			passRate >= input.policy.thresholds.requiredPassRate &&
			securityIssues.length <= input.policy.thresholds.maximumNewSecurityFailures;
		const completedAt = this.options.now?.() ?? Date.now();
		const suiteDigest = sha256(canonicalExtensionJson(input.suite));
		const runId = `verification-${sha256(
			canonicalExtensionJson({
				candidateId: input.candidate.candidateId,
				artifactDigest: input.build.artifact.artifactDigest,
				suiteDigest,
			}),
		).slice("sha256:".length, "sha256:".length + 32)}`;
		const run: ExtensionVerificationRunV1 = {
			schema: EXTENSION_VERIFICATION_RUN_SCHEMA,
			runId,
			ownerPrincipal: input.candidate.ownerPrincipal,
			agentId: input.candidate.agentId,
			candidateId: input.candidate.candidateId,
			candidateRuntimeBindingDigest: input.candidate.runtimeBindingDigest,
			artifactRef: input.build.artifactRef,
			artifactDigest: input.build.artifact.artifactDigest,
			policyRef: input.policyRef,
			suiteRef: input.suiteRef,
			suiteDigest,
			securityIssues,
			cases,
			passed,
			passRate,
			newSecurityFailures: securityIssues.length,
			modelCalls: 0,
			tokens: 0,
			costUsdMicros: 0,
			startedAt,
			completedAt,
		};
		const runRef = createMeaningfulObjectRef({
			kind: "verification-run",
			ownerPrincipal: run.ownerPrincipal,
			graphId: input.graphId,
			objectId: runId,
			version: "1",
			value: run,
		});
		return { run, runRef, eligible: passed };
	}

	private async scan(path: string, timeoutMs: number): Promise<string[]> {
		const result = await this.python(["scan", path], timeoutMs);
		if (
			!isRecord(result) ||
			!Array.isArray(result.issues) ||
			!result.issues.every((item) => typeof item === "string")
		) {
			throw new PrimeExtensionFault("security scanner returned malformed testimony");
		}
		return result.issues as string[];
	}

	private async run(path: string, functionName: string, value: unknown, timeoutMs: number): Promise<unknown> {
		const result = await this.python(["run", path, functionName, JSON.stringify(value)], timeoutMs);
		if (!isRecord(result) || !("output" in result))
			throw new PrimeExtensionFault("extension runner returned malformed output");
		return result.output;
	}

	private async python(args: readonly string[], timeoutMs: number): Promise<unknown> {
		try {
			const execution = this.options.bwrapBin
				? buildEvaluatorBwrapCommand(this.options.bwrapBin, this.options.pythonBin ?? "python3", args)
				: {
						executable: this.options.pythonBin ?? "python3",
						args: ["-I", "-S", EVALUATOR_PROGRAM, ...args],
					};
			const result = await execFileAsync(execution.executable, execution.args, {
				env: { PATH: process.env.PATH ?? "/usr/bin:/bin", PYTHONDONTWRITEBYTECODE: "1" },
				timeout: timeoutMs,
				maxBuffer: 1_048_576,
			});
			return JSON.parse(result.stdout) as unknown;
		} catch (error) {
			throw new PrimeExtensionFault("extension evaluator process failed", {
				reason: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

export function buildEvaluatorBwrapCommand(
	bwrapBin: string,
	pythonBin: string,
	evaluatorArgs: readonly string[],
): { readonly executable: string; readonly args: readonly string[] } {
	if (!bwrapBin.trim() || !pythonBin.trim()) throw new PrimeExtensionFault("evaluator runtime command is absent");
	if (evaluatorArgs.length < 2) throw new PrimeExtensionFault("evaluator command is incomplete");
	const sourcePath = evaluatorArgs[1];
	if (!sourcePath || !sourcePath.startsWith("/") || !existsSync(sourcePath)) {
		throw new PrimeExtensionFault("evaluator source path is not an existing absolute file");
	}
	const guestSource = "/candidate/extension.py";
	const guestEvaluator = "/opt/sophia/extension-evaluator.py";
	const systemMounts = ["/usr", "/bin", "/lib", "/lib64"]
		.filter((path) => existsSync(path))
		.flatMap((path) => ["--ro-bind", path, path]);
	const guestArgs = [evaluatorArgs[0]!, guestSource, ...evaluatorArgs.slice(2)];
	return {
		executable: bwrapBin,
		args: [
			"--die-with-parent",
			"--new-session",
			"--unshare-all",
			"--cap-drop",
			"ALL",
			"--clearenv",
			"--setenv",
			"PATH",
			"/usr/local/bin:/usr/bin:/bin",
			"--setenv",
			"PYTHONDONTWRITEBYTECODE",
			"1",
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"--tmpfs",
			"/tmp",
			"--dir",
			"/candidate",
			"--dir",
			"/opt",
			"--dir",
			"/opt/sophia",
			...systemMounts,
			"--ro-bind",
			EVALUATOR_PROGRAM,
			guestEvaluator,
			"--ro-bind",
			sourcePath,
			guestSource,
			"--chdir",
			"/tmp",
			"/usr/bin/env",
			pythonBin,
			"-I",
			"-S",
			guestEvaluator,
			...guestArgs,
		],
	};
}

function assertEvaluationBindings(input: {
	readonly candidate: EmbodimentCandidateV1;
	readonly build: ExtensionBuildResultV1;
	readonly policy: EvaluationPolicyV1;
	readonly policyRef: MeaningfulObjectRefV1<"evaluation-policy">;
	readonly suite: ExtensionEvaluationSuiteV1;
	readonly suiteRef: MeaningfulObjectRefV1<"evaluation-suite">;
}): void {
	if (
		input.candidate.targetLayer !== "extension" ||
		input.policy.evolutionClass !== "extension" ||
		input.candidate.ownerPrincipal !== input.policy.ownerPrincipal ||
		input.suite.ownerPrincipal !== input.candidate.ownerPrincipal ||
		input.build.artifact.ownerPrincipal !== input.candidate.ownerPrincipal
	) {
		throw new PrimeExtensionFault("extension evaluation crosses an owner or evolution-class boundary");
	}
	if (
		!sameMeaningfulObjectRef(input.candidate.evaluationPolicyRef, input.policyRef) ||
		!input.candidate.artifactRefs.some((ref) => sameMeaningfulObjectRef(ref, input.build.artifactRef)) ||
		input.candidate.buildReceiptRef.digest !== input.build.buildReceiptRef.digest
	) {
		throw new PrimeExtensionFault("extension evaluation inputs differ from candidate bindings");
	}
	if (
		input.suiteRef.ownerPrincipal !== input.suite.ownerPrincipal ||
		input.suiteRef.objectId !== input.suite.suiteId ||
		!input.policy.requiredSuites.some((suite) => sameMeaningfulObjectRef(suite.suiteRef, input.suiteRef))
	) {
		throw new PrimeExtensionFault("evaluation suite is not required by the exact policy");
	}
}

function validateSuite(value: ExtensionEvaluationSuiteV1): void {
	if (value.schema !== EXTENSION_EVALUATION_SUITE_SCHEMA)
		throw new PrimeExtensionFault("evaluation suite schema is invalid");
	if (!value.suiteId.trim() || !value.skillName.trim() || !/^user:[^\s]+$/.test(value.ownerPrincipal)) {
		throw new PrimeExtensionFault("evaluation suite identity is invalid");
	}
	if (!Array.isArray(value.fixtures) || value.fixtures.length === 0)
		throw new PrimeExtensionFault("evaluation suite has no fixtures");
	if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 30_000) {
		throw new PrimeExtensionFault("evaluation timeout is invalid");
	}
	if (
		!Number.isSafeInteger(value.maximumOutputBytes) ||
		value.maximumOutputBytes < 1 ||
		value.maximumOutputBytes > 1_048_576
	) {
		throw new PrimeExtensionFault("evaluation output limit is invalid");
	}
	if (new Set(value.fixtures.map((fixture) => fixture.caseId)).size !== value.fixtures.length) {
		throw new PrimeExtensionFault("evaluation fixture ids are duplicated");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
