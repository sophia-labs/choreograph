import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createMeaningfulObjectRef } from "../agent-runtime/meaningful-object.js";
import { canonicalDigest } from "../agent-subject/canonical-json.js";
import { type AgentToolGrantV1, grantDigest } from "../workflow/agent-tool-grant.js";
import { stableJson } from "../workflow/agent-tool-manifest.js";
import type { ChoreographReleaseArtifactV1 } from "../workflow/choreograph-release-artifact.js";
import {
	type DomainSourceTurnV1,
	domainSourceTurnDigest,
	domainTriggerDigest,
} from "../workflow/domain-source-turn.js";
import {
	PLATFORM_REALIZATION_RECEIPT_SCHEMA,
	type PlatformRealizationRequestV1,
	type PlatformRealizationResponseV1,
	type PlatformReleaseEffectHost,
	PlatformReleaseEffectWorker,
} from "../workflow/platform-release-effect.js";
import {
	type CommittedPlatformReleaseTarget,
	type ProposedEffectV1,
	proposedEffectDigest,
	proposedEffectExecutionDigest,
} from "../workflow/proposed-effect.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";

const AGENT = "agent-706c6174666f726d01";
const OWNER = "user:ada";
const HOME_GRAPH = "sophia-code-lab";

function sha(value: unknown): string {
	return createHash("sha256")
		.update(typeof value === "string" ? value : stableJson(value))
		.digest("hex");
}

function target(): CommittedPlatformReleaseTarget {
	const sourceRevision = "a".repeat(40);
	const body = {
		system: { name: "cloud2-platform", digest: `sha256:${"1".repeat(64)}` },
		environment: { name: "canary", digest: `sha256:${"2".repeat(64)}` },
		release: { name: "candidate", digest: `sha256:${"3".repeat(64)}` },
		source: { repository: "sophia-labs/cloud", revision: sourceRevision },
		observedState: {
			snapshotDigest: `sha256:${"4".repeat(64)}`,
			planningViewDigest: `sha256:${"5".repeat(64)}`,
		},
		previousRealization: null,
		guards: [],
		actions: [{ actionId: "rollout.platform-release", driver: "legacy-script" }],
	};
	const planDigest = `sha256:${sha(body)}` as const;
	return {
		ownerPrincipal: OWNER,
		resource: "canary/cloud2-platform",
		plan: {
			apiVersion: "sophia.cloud/v1",
			kind: "RealizationPlan",
			digest: planDigest,
			applicable: true,
			body,
			envelope: { createdAt: "2026-08-05T00:00:00Z", plannerVersion: "0.2.0" },
		},
		planDigest,
		confirmation: `apply:canary:cloud2-platform:${planDigest.slice(7, 15)}`,
		sourceRevision,
	};
}

function choreographTarget(): CommittedPlatformReleaseTarget {
	const sourceRevision = "d".repeat(40);
	const platformRevision = "c".repeat(40);
	const version = sourceRevision.slice(0, 12);
	const contentKey = "9".repeat(64);
	const sourceComposition = [
		{ repository: "sophia-labs/choreograph", revision: sourceRevision, destination: "choreograph" },
		{ repository: "sophia-labs/sophia-agent", revision: "e".repeat(40), destination: "prime-agent-sophia" },
		{ repository: "sophia-labs/soil", revision: "f".repeat(40), destination: "soil" },
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
	const objects = roles.map((role, index) => ({
		role,
		key:
			role === "host-release"
				? `releases/choreograph-${version}.tar.gz`
				: role === "runtime-manifest"
					? `runtime-manifests/runtime-bundles-${version}.json`
					: role === "release-metadata"
						? `choreograph-build/releases/${contentKey}/metadata.json`
						: role === "terraform-vars"
							? `choreograph-build/releases/${contentKey}/terraform.auto.tfvars.json`
							: `runtime-bundles/${role.slice("runtime-bundle:".length)}-${version}.tar.gz`,
		sha256: digestCharacters[index]!.repeat(64),
		bytes: 1_024,
	}));
	const byRole = new Map(objects.map((object) => [object.role, object]));
	const artifact: ChoreographReleaseArtifactV1 = {
		schema: "sophia.choreograph.release-artifact.v1",
		artifactClass: "choreograph-release",
		bucket: "choreograph-deploy-20260402192255814600000001",
		version,
		releaseKey: byRole.get("host-release")!.key,
		releaseSha256: byRole.get("host-release")!.sha256,
		runtimeManifestKey: byRole.get("runtime-manifest")!.key,
		runtimeManifestSha256: byRole.get("runtime-manifest")!.sha256,
		metadataKey: byRole.get("release-metadata")!.key,
		metadataSha256: byRole.get("release-metadata")!.sha256,
		terraformVarsKey: byRole.get("terraform-vars")!.key,
		terraformVarsSha256: byRole.get("terraform-vars")!.sha256,
		stageManifestKey: `choreograph-build/staging/${contentKey}/manifest.json`,
		stageManifestSha256: "b".repeat(64),
		sourceRevision,
		sourceComposition,
		sourceCompositionDigest: canonicalDigest(sourceComposition),
		contentKey,
		objects,
	};
	const artifactRef = createMeaningfulObjectRef({
		kind: "release-artifact",
		ownerPrincipal: OWNER,
		graphId: HOME_GRAPH,
		objectId: "choreograph-release",
		version,
		value: artifact,
	});
	const body = {
		system: { name: "choreograph", digest: `sha256:${"1".repeat(64)}` },
		environment: { name: "canary", digest: `sha256:${"2".repeat(64)}` },
		release: { name: `choreograph-${version}`, digest: artifactRef.digest },
		source: { repository: "sophia-labs/cloud", revision: platformRevision },
		observedState: {
			snapshotDigest: `sha256:${"4".repeat(64)}`,
			planningViewDigest: `sha256:${"5".repeat(64)}`,
		},
		previousRealization: null,
		guards: [],
		actions: [
			{
				actionId: "rollout.choreograph-release",
				driver: "terraform-release",
				operation: "terraform-apply",
				target: "terraform/choreograph",
				destructive: true,
				dependsOn: [],
				invocation: {
					kind: "choreograph-release",
					targets: ["aws_launch_template.choreograph[0]", "aws_autoscaling_group.choreograph[0]"],
					artifactRef,
					artifact,
				},
			},
		],
	};
	const planDigest = `sha256:${sha(body)}` as const;
	const plan = {
		apiVersion: "sophia.cloud/v1",
		kind: "RealizationPlan",
		digest: planDigest,
		applicable: true,
		body,
		envelope: { createdAt: "2026-08-06T00:00:00Z", plannerVersion: "0.3.0" },
	};
	return {
		ownerPrincipal: OWNER,
		resource: "canary/choreograph",
		plan,
		planDigest,
		planRef: createMeaningfulObjectRef({
			kind: "deployment-plan",
			ownerPrincipal: OWNER,
			graphId: HOME_GRAPH,
			objectId: "choreograph-canary",
			version: planDigest.slice(7, 19),
			value: plan,
		}),
		confirmation: `apply:canary:choreograph:${planDigest.slice(7, 15)}`,
		sourceRevision: platformRevision,
	};
}

function grant(resource = "canary/cloud2-platform"): AgentToolGrantV1 {
	return {
		schema: "sophia.agent-toolbelt-grant.v1",
		grantId: "grant-cloud-release-v1",
		subjectAgentId: AGENT,
		issuedBy: OWNER,
		authorityGraphId: HOME_GRAPH,
		issuedAt: 1,
		status: "active",
		capabilities: [
			{
				capability: "platform.release",
				operations: ["platform.release.apply"],
				access: "write",
				approvalPolicy: "notify",
				fence: { resourcePrefixes: [resource], maxPayloadBytes: 16_384 },
				quota: { maxPerWave: 1, maxPerDay: 8, maxConcurrent: 1 },
			},
		],
		sourceRefs: ["urn:test:cloud-release-ratification"],
	};
}

function evidence(currentGrant = grant(), releaseTarget = target()) {
	const trigger = {
		kind: "platform.release.requested",
		eventId: "cloud-release-1",
		platformReleaseTarget: releaseTarget,
	};
	const sourceRef = "urn:test:platform-release:1";
	const sourceTurn: DomainSourceTurnV1 = {
		schema: "sophia.domain-source-turn.v1",
		turnId: `turn:${sha({ ownerPrincipal: OWNER, graphId: HOME_GRAPH, agentId: AGENT, sourceRef })}`,
		sourceRef,
		sourceDigest: sha({ sourceRef }),
		triggerDigest: domainTriggerDigest(trigger),
		contextDigest: sha([]),
		target: { ownerPrincipal: OWNER, graphId: HOME_GRAPH },
		agentId: AGENT,
		actorRef: "agent:cloud-release",
		ingress: { authMethod: "owner" },
		committedAt: 10,
	};
	const effectIndex = 0;
	const idempotencyKey = `effect:${sha({ sourceTurnId: sourceTurn.turnId, effectIndex })}`;
	const proposal: ProposedEffectV1 = {
		schema: "sophia.proposed-effect.v1",
		effectId: "apply-platform-release",
		idempotencyKey,
		capability: "platform.release",
		operation: "platform.release.apply",
		arguments: {
			resource: releaseTarget.resource,
			planDigest: releaseTarget.planDigest,
			sourceRevision: releaseTarget.sourceRevision,
			confirmation: releaseTarget.confirmation,
		},
		reason: "apply the owner-confirmed saved cloud-2 plan",
		evidenceRefs: [sourceRef],
	};
	return {
		idempotencyKey,
		executionDigest: proposedEffectExecutionDigest(proposal),
		proposalDigest: proposedEffectDigest(proposal),
		runId: "wfr-platform-release-1",
		graphId: HOME_GRAPH,
		agentId: AGENT,
		actorRef: "agent:cloud-release",
		grantId: currentGrant.grantId,
		grantDocumentId: "grant-cloud-release-v1",
		grantAuthorityGraphId: currentGrant.authorityGraphId,
		grantAuthorityOwnerPrincipal: OWNER,
		grantDigest: grantDigest(currentGrant),
		definitionDigest: "e".repeat(64),
		sourceTurnId: sourceTurn.turnId,
		sourceTurnDigest: domainSourceTurnDigest(sourceTurn),
		sourceOwnerPrincipal: OWNER,
		sourceTurn,
		capability: "platform.release",
		operation: "platform.release.apply",
		proposal,
		trigger,
		effectIndex,
		now: 100,
	};
}

class RecordingHost implements PlatformReleaseEffectHost {
	readonly requests: PlatformRealizationRequestV1[] = [];
	readonly grantsRead: string[] = [];
	state: "queued" | "succeeded" | "failed" = "queued";

	constructor(
		readonly currentGrant: AgentToolGrantV1,
		readonly mutate?: (response: PlatformRealizationResponseV1) => PlatformRealizationResponseV1,
	) {}

	async readGrant(record: { grant_document_id: string }): Promise<string> {
		this.grantsRead.push(record.grant_document_id);
		return JSON.stringify(this.currentGrant);
	}

	async materialize(request: PlatformRealizationRequestV1): Promise<PlatformRealizationResponseV1> {
		this.requests.push(structuredClone(request));
		const succeeded = this.state === "succeeded";
		const failed = this.state === "failed";
		const response: PlatformRealizationResponseV1 = {
			created: this.requests.length === 1,
			receipt: {
				schema: PLATFORM_REALIZATION_RECEIPT_SCHEMA,
				receiptId: `platform-realization-receipt:${"f".repeat(64)}`,
				requestDigest: canonicalDigest(request),
				effectIdempotencyKey: request.proposal.idempotencyKey,
				sourceTurnId: request.sourceTurn.turnId,
				ownerPrincipal: request.target.ownerPrincipal,
				resource: request.target.resource,
				planDigest: request.target.planDigest,
				sourceRevision: request.target.sourceRevision,
				confirmation: request.target.confirmation,
				state: this.state,
				planRef: "s3://platform-next-realizations/realization/plans/plan.json",
				observedAtMs: 200,
				buildId: "platform-next-release-realizer:build-1",
				...(succeeded
					? {
							resultRef: "s3://platform-next-realizations/realization/results/result.json",
							applyReceiptDigest: `sha256:${"7".repeat(64)}`,
							deploymentReceiptRef: {
								schema: "sophia.meaningful-object-ref.v1",
								kind: "deployment-receipt",
								ownerPrincipal: request.target.ownerPrincipal,
								graphId: request.sourceTurn.target.graphId,
								objectId: `deployment-receipt:${"7".repeat(64)}`,
								version: request.target.planDigest.slice(7, 19),
								digest: `sha256:${"7".repeat(64)}`,
							},
							...(request.target.resource === "canary/choreograph"
								? {
										terraformPlanRef:
											"s3://platform-next-realizations/realization/terraform-plans/plan.tfplan",
										terraformPlanDigest: `sha256:${"8".repeat(64)}`,
									}
								: {}),
						}
					: {}),
				...(failed ? { failureCode: "helm-release-failed" } : {}),
			},
		};
		return this.mutate?.(response) ?? response;
	}
}

describe("digest-bound cloud-2 platform release effect edge", () => {
	it("rereads current authority while queued and completes only with an apply receipt", async () => {
		const root = mkdtempSync(join(tmpdir(), "platform-release-effect-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		const currentGrant = grant();
		const host = new RecordingHost(currentGrant);
		const clock = [200];
		try {
			await runtime.init();
			const offered = evidence(currentGrant);
			await runtime.offerEffectHandoff(offered);
			const worker = new PlatformReleaseEffectWorker(runtime, host, undefined, {
				consumer: "platform-release-test",
				leaseMs: 1_000,
				now: () => clock[0]!,
			});
			assert.equal(await worker.runOnce(), true);
			assert.equal((await runtime.getEffectHandoff(offered.idempotencyKey))?.state, "ready");
			assert.equal(host.requests.length, 1);
			assert.deepEqual(host.requests[0]?.grant.allowedOperations, ["platform.release.apply"]);
			assert.equal(host.requests[0]?.grant.approvalMode, "notify");
			assert.equal(host.requests[0]?.proposal.arguments.plan, undefined);

			clock[0] = 2_500;
			host.state = "succeeded";
			assert.equal(await worker.runOnce(), true);
			const completed = await runtime.getEffectHandoff(offered.idempotencyKey);
			assert.equal(completed?.state, "executed");
			assert.equal(
				(completed?.completion as { receipt?: { applyReceiptDigest?: string } }).receipt?.applyReceiptDigest,
				`sha256:${"7".repeat(64)}`,
			);
			assert.equal(host.grantsRead.length, 2);
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("carries a Choreograph deployment plan and release artifact as bound Meaningful Objects", async () => {
		const root = mkdtempSync(join(tmpdir(), "choreograph-release-effect-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		const currentGrant = grant("canary/choreograph");
		const host = new RecordingHost(currentGrant);
		host.state = "succeeded";
		try {
			await runtime.init();
			const offered = evidence(currentGrant, choreographTarget());
			await runtime.offerEffectHandoff(offered);
			const worker = new PlatformReleaseEffectWorker(runtime, host, undefined, {
				consumer: "choreograph-release-test",
				leaseMs: 1_000,
				now: () => 200,
			});
			assert.equal(await worker.runOnce(), true);
			const record = await runtime.getEffectHandoff(offered.idempotencyKey);
			assert.equal(record?.state, "executed");
			assert.equal(host.requests[0]?.target.planRef?.kind, "deployment-plan");
			assert.equal(
				(host.requests[0]?.target.plan.body as { actions?: { invocation?: { artifactRef?: { kind?: string } } }[] })
					.actions?.[0]?.invocation?.artifactRef?.kind,
				"release-artifact",
			);
			assert.equal(
				(record?.completion as { receipt?: { terraformPlanDigest?: string } }).receipt?.terraformPlanDigest,
				`sha256:${"8".repeat(64)}`,
			);
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a broad or changed release grant before contacting the gateway", async () => {
		for (const [currentGrant, expected] of [
			[grant("canary/"), "platform-release-grant-resource-unfenced"],
			[{ ...grant(), status: "revoked" as const }, "platform-release-grant-inactive"],
		] as const) {
			const root = mkdtempSync(join(tmpdir(), "platform-release-grant-"));
			const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
			const host = new RecordingHost(currentGrant);
			try {
				await runtime.init();
				const offered = evidence(currentGrant);
				await runtime.offerEffectHandoff(offered);
				const worker = new PlatformReleaseEffectWorker(runtime, host, undefined, {
					consumer: "platform-release-test",
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

	it("rejects a success receipt without the plan-linked apply proof", async () => {
		const root = mkdtempSync(join(tmpdir(), "platform-release-receipt-"));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		const currentGrant = grant();
		const host = new RecordingHost(currentGrant, (response) => ({
			...response,
			receipt: { ...response.receipt, applyReceiptDigest: undefined },
		}));
		host.state = "succeeded";
		try {
			await runtime.init();
			const offered = evidence(currentGrant);
			await runtime.offerEffectHandoff(offered);
			const worker = new PlatformReleaseEffectWorker(runtime, host, undefined, {
				consumer: "platform-release-test",
				leaseMs: 1_000,
				now: () => 200,
			});
			await worker.runOnce();
			const record = await runtime.getEffectHandoff(offered.idempotencyKey);
			assert.equal(record?.state, "failed-terminal");
			assert.equal((record?.completion as { code?: string }).code, "platform-realization-success-proof-missing");
		} finally {
			runtime.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
