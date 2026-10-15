import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { canonicalDigest } from "../agent-subject/canonical-json.js";
import { type AgentToolGrantV1, grantDigest } from "../workflow/agent-tool-grant.js";
import { stableJson } from "../workflow/agent-tool-manifest.js";
import {
	BUILD_RECEIPT_SCHEMA,
	type BuildEffectHost,
	BuildEffectWorker,
	type BuildMaterializationRequestV1,
	type BuildMaterializationResponseV1,
	type ChoreographReleaseArtifactV1,
} from "../workflow/build-effect-worker.js";
import { validChoreographReleaseArtifact } from "../workflow/choreograph-release-artifact.js";
import {
	type DomainSourceTurnV1,
	domainSourceTurnDigest,
	domainTriggerDigest,
} from "../workflow/domain-source-turn.js";
import {
	type CommittedDevelopmentTarget,
	type ProposedEffectV1,
	proposedEffectDigest,
	proposedEffectExecutionDigest,
} from "../workflow/proposed-effect.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";

const AGENT = "agent-7068616e65730002";
const OWNER = "user:ada";
const HOME_GRAPH = "shrubbery-domain";
const RECIPE_DIGEST = "9".repeat(64);

function sha(value: unknown): string {
	return createHash("sha256")
		.update(typeof value === "string" ? value : stableJson(value))
		.digest("hex");
}

function grant(recipeDigest = RECIPE_DIGEST, maxConcurrent = 1): AgentToolGrantV1 {
	return {
		schema: "sophia.agent-toolbelt-grant.v1",
		grantId: "grant-shrub-1",
		subjectAgentId: AGENT,
		issuedBy: "user:platform-steward",
		authorityGraphId: "observatory",
		issuedAt: 1,
		status: "active",
		capabilities: [
			{
				capability: "build",
				operations: ["build.plan", "build.start"],
				access: "write",
				approvalPolicy: "notify",
				fence: {
					resourcePrefixes: ["sophia-labs/shrubbery"],
					builderRecipeDigests: [recipeDigest],
					maxPayloadBytes: 1_048_576,
				},
				quota: { maxPerWave: 2, maxConcurrent, maxCostMicrousd: 5_000_000 },
			},
		],
		sourceRefs: ["urn:test:grant"],
	};
}

function target(overrides: Partial<CommittedDevelopmentTarget> = {}): CommittedDevelopmentTarget {
	return {
		ownerPrincipal: OWNER,
		repository: "sophia-labs/shrubbery",
		sourceRevision: "a".repeat(40),
		baseBranch: "main",
		branchName: "agent/shrub-1/fix-hoja",
		scratchGraphId: "dev-shrub1-fix-hoja",
		scenarioDigest: "b".repeat(64),
		builderRecipeId: "shrubbery.planter",
		builderRecipeDigest: RECIPE_DIGEST,
		...overrides,
	};
}

function evidence(
	currentGrant = grant(),
	targetValue = target(),
	operation: "build.plan" | "build.start" = "build.plan",
) {
	const trigger = {
		kind: operation === "build.plan" ? "development.build.requested" : "development.build.planned",
		eventId: `build-${operation}-1`,
		developmentTarget: targetValue,
	};
	const sourceRef = `urn:test:${operation}:1`;
	const sourceTurn: DomainSourceTurnV1 = {
		schema: "sophia.domain-source-turn.v1",
		turnId: `turn:${sha({ ownerPrincipal: OWNER, graphId: HOME_GRAPH, agentId: AGENT, sourceRef })}`,
		sourceRef,
		sourceDigest: sha({ operation }),
		triggerDigest: domainTriggerDigest(trigger),
		contextDigest: sha([]),
		target: { ownerPrincipal: OWNER, graphId: HOME_GRAPH },
		agentId: AGENT,
		actorRef: "agent:shrub-1",
		ingress: { authMethod: "owner" },
		committedAt: 10,
	};
	const effectIndex = 0;
	const idempotencyKey = `effect:${sha({ sourceTurnId: sourceTurn.turnId, effectIndex })}`;
	const proposal: ProposedEffectV1 = {
		schema: "sophia.proposed-effect.v1",
		effectId: operation,
		idempotencyKey,
		capability: "build",
		operation,
		arguments: { ...targetValue, resource: targetValue.repository },
		reason: "prepare or launch the exact content-addressed build",
		evidenceRefs: [sourceRef],
		estimatedCostMicrousd: 2_000_000,
	};
	return {
		idempotencyKey,
		executionDigest: proposedEffectExecutionDigest(proposal),
		proposalDigest: proposedEffectDigest(proposal),
		runId: `wfr-${operation}`,
		graphId: HOME_GRAPH,
		agentId: AGENT,
		actorRef: "agent:shrub-1",
		grantId: currentGrant.grantId,
		grantDocumentId: "grant-shrub-1",
		grantAuthorityGraphId: currentGrant.authorityGraphId,
		grantAuthorityOwnerPrincipal: "user:platform-steward",
		grantDigest: grantDigest(currentGrant),
		definitionDigest: "e".repeat(64),
		sourceTurnId: sourceTurn.turnId,
		sourceTurnDigest: domainSourceTurnDigest(sourceTurn),
		sourceOwnerPrincipal: OWNER,
		sourceTurn,
		capability: "build",
		operation,
		proposal,
		trigger,
		effectIndex,
		now: 100,
	};
}

class RecordingHost implements BuildEffectHost {
	readonly requests: BuildMaterializationRequestV1[] = [];

	constructor(
		readonly currentGrant: AgentToolGrantV1,
		readonly mutate?: (response: BuildMaterializationResponseV1) => BuildMaterializationResponseV1,
	) {}

	async readGrant(): Promise<string> {
		return JSON.stringify(this.currentGrant);
	}

	async materialize(request: BuildMaterializationRequestV1): Promise<BuildMaterializationResponseV1> {
		this.requests.push(structuredClone(request));
		const planDigest = request.target.buildPlanDigest ?? "1".repeat(64);
		const contextDigest = request.target.buildContextDigest ?? "2".repeat(64);
		const contextBytes = request.target.buildContextBytes ?? 4096;
		const response: BuildMaterializationResponseV1 = {
			created: true,
			receipt: {
				schema: BUILD_RECEIPT_SCHEMA,
				receiptId: `build-receipt:${"f".repeat(64)}`,
				requestDigest: canonicalDigest(request),
				effectIdempotencyKey: request.proposal.idempotencyKey,
				sourceTurnId: request.sourceTurn.turnId,
				operation: request.operation,
				ownerPrincipal: request.target.ownerPrincipal,
				repository: request.target.repository,
				sourceRevision: request.target.sourceRevision,
				builderRecipeId: request.target.builderRecipeId,
				builderRecipeDigest: request.target.builderRecipeDigest,
				planDigest,
				contextDigest,
				contextBytes,
				contentKey: "4".repeat(64),
				buildRef: `build:${"4".repeat(64)}`,
				state: request.operation === "build.plan" ? ("planned" as const) : ("queued" as const),
				cacheHit: false,
				estimatedCostMicrousd: request.estimatedCostMicrousd,
				artifactClass: "oci-image",
				imageRepository: "planter-pool",
				observedAtMs: 200,
			},
		};
		return this.mutate?.(response) ?? response;
	}
}

function releaseArtifact(repository: string, sourceRevision: string, contentKey: string): ChoreographReleaseArtifactV1 {
	const sourceComposition = [
		{ repository, revision: sourceRevision, destination: "choreograph" },
		{ repository: "sophia-labs/sophia-agent", revision: "c".repeat(40), destination: "prime-agent-sophia" },
		{ repository: "sophia-labs/soil", revision: "d".repeat(40), destination: "soil" },
	];
	const roles = [
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
	] as const;
	const digestCharacters = "123456789ab";
	const objects = roles.map((role, index) => {
		const objectDigest = digestCharacters.charAt(index).repeat(64);
		return {
			role,
			key:
				role === "host-release"
					? `releases/choreograph-${sourceRevision.slice(0, 12)}.tar.gz`
					: role === "runtime-manifest"
						? `runtime-manifests/runtime-bundles-${sourceRevision.slice(0, 12)}.json`
						: role === "release-metadata"
							? `choreograph-build/${sourceRevision.slice(0, 12)}.metadata.json`
							: role === "terraform-vars"
								? `choreograph-build/${sourceRevision.slice(0, 12)}.tfvars.json`
								: `runtime-bundles/${role.slice("runtime-bundle:".length)}/sha256-${objectDigest}.tar.gz`,
			sha256: objectDigest,
			bytes: index + 1,
		};
	});
	const byRole = new Map(objects.map((object) => [object.role, object]));
	return {
		schema: "sophia.choreograph.release-artifact.v1",
		artifactClass: "choreograph-release",
		bucket: "choreograph-deploy-proof",
		version: sourceRevision.slice(0, 12),
		releaseKey: byRole.get("host-release")?.key ?? "",
		releaseSha256: byRole.get("host-release")?.sha256 ?? "",
		runtimeManifestKey: byRole.get("runtime-manifest")?.key ?? "",
		runtimeManifestSha256: byRole.get("runtime-manifest")?.sha256 ?? "",
		metadataKey: byRole.get("release-metadata")?.key ?? "",
		metadataSha256: byRole.get("release-metadata")?.sha256 ?? "",
		terraformVarsKey: byRole.get("terraform-vars")?.key ?? "",
		terraformVarsSha256: byRole.get("terraform-vars")?.sha256 ?? "",
		stageManifestKey: `choreograph-build/staging/${contentKey}/a1/release-stage.json`,
		stageManifestSha256: "e".repeat(64),
		sourceRevision,
		sourceComposition,
		sourceCompositionDigest: canonicalDigest(sourceComposition),
		contentKey,
		objects,
	};
}

describe("Phanes-standard native-build effect edge", () => {
	it("treats a release artifact as one exact Meaningful Object, including nested shapes", () => {
		const artifact = releaseArtifact("sophia-labs/choreograph", "e".repeat(40), "f".repeat(64));
		assert.equal(validChoreographReleaseArtifact(artifact), true);
		assert.equal(validChoreographReleaseArtifact(null), false);
		assert.equal(validChoreographReleaseArtifact({ ...artifact, ignoredAuthority: true }), false);
		assert.equal(
			validChoreographReleaseArtifact({
				...artifact,
				sourceComposition: [
					{ ...artifact.sourceComposition[0], token: "hidden" },
					...artifact.sourceComposition.slice(1),
				],
			}),
			false,
		);
	});

	it("accepts an ontology-bound Choreograph release artifact without image-shaped fields", async () => {
		const root = mkdtempSync(join(tmpdir(), "build-effect-release-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		const currentGrant = grant();
		const host = new RecordingHost(currentGrant, (response) => {
			const artifact = releaseArtifact(
				response.receipt.repository,
				response.receipt.sourceRevision,
				response.receipt.contentKey,
			);
			return {
				...response,
				receipt: {
					...response.receipt,
					state: "succeeded",
					artifactClass: "choreograph-release",
					imageRepository: undefined,
					artifact,
				},
			};
		});
		try {
			await runtime.init();
			const offered = evidence(currentGrant);
			await runtime.offerEffectHandoff(offered);
			const worker = new BuildEffectWorker(runtime, host, undefined, {
				consumer: "build-test",
				leaseMs: 1_000,
				now: () => 200,
			});
			await worker.runOnce();
			const record = await runtime.getEffectHandoff(offered.idempotencyKey);
			assert.equal(record?.state, "executed");
			assert.equal(
				(record?.completion as { receipt?: { artifact?: { artifactClass?: string } } }).receipt?.artifact
					?.artifactClass,
				"choreograph-release",
			);
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rereads current authority and persists a host-derived build plan receipt", async () => {
		const root = mkdtempSync(join(tmpdir(), "build-effect-plan-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		const currentGrant = grant();
		const host = new RecordingHost(currentGrant);
		try {
			await runtime.init();
			const offered = evidence(currentGrant);
			await runtime.offerEffectHandoff(offered);
			const worker = new BuildEffectWorker(runtime, host, undefined, {
				consumer: "build-test",
				leaseMs: 1_000,
				now: () => 200,
			});
			assert.equal(await worker.runOnce(), true);
			assert.equal(host.requests.length, 1);
			assert.equal(host.requests[0]?.grant.maxConcurrent, 1);
			assert.equal(host.requests[0]?.grant.maxCostMicrousd, 5_000_000);
			assert.equal(host.requests[0]?.target.builderRecipeDigest, RECIPE_DIGEST);
			assert.equal(host.requests[0]?.effectiveProposalDigest, proposedEffectDigest(offered.proposal));
			const record = await runtime.getEffectHandoff(offered.idempotencyKey);
			assert.equal(record?.state, "executed");
			assert.equal((record?.completion as { receipt?: { state?: string } }).receipt?.state, "planned");
			assert.equal(await worker.runOnce(), false);
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("requires a prior host plan witness before build.start reaches the service", async () => {
		const root = mkdtempSync(join(tmpdir(), "build-effect-start-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		const currentGrant = grant();
		const host = new RecordingHost(currentGrant);
		try {
			await runtime.init();
			const offered = evidence(currentGrant, target(), "build.start");
			await runtime.offerEffectHandoff(offered);
			const worker = new BuildEffectWorker(runtime, host, undefined, {
				consumer: "build-test",
				leaseMs: 1_000,
				now: () => 200,
			});
			await worker.runOnce();
			const record = await runtime.getEffectHandoff(offered.idempotencyKey);
			assert.equal(record?.state, "failed-terminal");
			assert.deepEqual(record?.completion, {
				schema: "sophia.build-effect-completion.v1",
				code: "build-plan-digest-required",
			});
			assert.equal(host.requests.length, 0);
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a prior plan witness on build.plan before it reaches the service", async () => {
		const root = mkdtempSync(join(tmpdir(), "build-effect-plan-smuggle-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		const currentGrant = grant();
		const host = new RecordingHost(currentGrant);
		try {
			await runtime.init();
			const offered = evidence(
				currentGrant,
				target({
					buildPlanDigest: "1".repeat(64),
					buildContextDigest: "2".repeat(64),
					buildContextBytes: 4096,
				}),
			);
			await runtime.offerEffectHandoff(offered);
			const worker = new BuildEffectWorker(runtime, host, undefined, {
				consumer: "build-test",
				leaseMs: 1_000,
				now: () => 200,
			});
			await worker.runOnce();
			const record = await runtime.getEffectHandoff(offered.idempotencyKey);
			assert.equal(record?.state, "failed-terminal");
			assert.equal((record?.completion as { code?: string }).code, "build-plan-witness-unexpected");
			assert.equal(host.requests.length, 0);
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a builder receipt whose opaque request or build identity was altered", async () => {
		for (const mutate of [
			(response: BuildMaterializationResponseV1): BuildMaterializationResponseV1 => ({
				...response,
				receipt: { ...response.receipt, requestDigest: "0".repeat(64) },
			}),
			(response: BuildMaterializationResponseV1): BuildMaterializationResponseV1 => ({
				...response,
				receipt: { ...response.receipt, buildRef: `build:${"5".repeat(64)}` },
			}),
		]) {
			const root = mkdtempSync(join(tmpdir(), "build-effect-receipt-"));
			const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
			const currentGrant = grant();
			const host = new RecordingHost(currentGrant, mutate);
			try {
				await runtime.init();
				const offered = evidence(currentGrant);
				await runtime.offerEffectHandoff(offered);
				const worker = new BuildEffectWorker(runtime, host, undefined, {
					consumer: "build-test",
					leaseMs: 1_000,
					now: () => 200,
				});
				await worker.runOnce();
				const record = await runtime.getEffectHandoff(offered.idempotencyKey);
				assert.equal(record?.state, "failed-terminal");
				assert.equal((record?.completion as { code?: string }).code, "build-materialization-witness-mismatch");
				assert.equal(host.requests.length, 1);
			} finally {
				runtime.close();
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	it("refuses recipe drift and missing positive concurrency authority", async () => {
		for (const [currentGrant, expected] of [
			[grant("8".repeat(64)), "grant-build-recipe-denied"],
			[grant(RECIPE_DIGEST, 0), "build-quota-required"],
		] as const) {
			const root = mkdtempSync(join(tmpdir(), "build-effect-fence-"));
			const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
			const host = new RecordingHost(currentGrant);
			try {
				await runtime.init();
				const offered = evidence(currentGrant);
				await runtime.offerEffectHandoff(offered);
				const worker = new BuildEffectWorker(runtime, host, undefined, {
					consumer: "build-test",
					leaseMs: 1_000,
					now: () => 200,
				});
				await worker.runOnce();
				const record = await runtime.getEffectHandoff(offered.idempotencyKey);
				assert.equal(record?.state, "failed-terminal");
				assert.equal((record?.completion as { code?: string }).code, expected);
				assert.equal(host.requests.length, 0);
			} finally {
				runtime.close();
				rmSync(root, { recursive: true, force: true });
			}
		}
	});
});
