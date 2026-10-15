import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createClient } from "@libsql/client";
import { canonicalJson } from "@sophia-labs/canonical-json";
import {
	AGENT_EMBODIMENT_SCHEMA,
	AGENT_RUNTIME_BINDING_V2_SCHEMA,
	type AgentEmbodimentV1,
	digestAgentRuntimeBindingV2,
	EVALUATION_POLICY_SCHEMA,
	type EvaluationPolicyV1,
} from "../agent-runtime/evolution.js";
import { PersonalEvolutionController } from "../agent-runtime/evolution-controller.js";
import { AgentEvolutionStore } from "../agent-runtime/evolution-store.js";
import { PRIME_EXTENSION_ABI, PRIME_EXTENSION_MANIFEST_SCHEMA } from "../agent-runtime/extension.js";
import { PrimeExtensionBuilder } from "../agent-runtime/extension-builder.js";
import {
	EXTENSION_EVALUATION_SUITE_SCHEMA,
	ExtensionEvaluationCoordinator,
	type ExtensionEvaluationSuiteV1,
} from "../agent-runtime/extension-evaluation.js";
import {
	createMeaningfulObjectRef,
	MEANINGFUL_OBJECT_REF_SCHEMA,
	type MeaningfulObjectKind,
	type MeaningfulObjectRefV1,
} from "../agent-runtime/meaningful-object.js";
import {
	AGENT_ONTOLOGY_BINDING_SCHEMA,
	type AgentOntologyBindingV1,
	digestAgentOntologyBinding,
} from "../agent-runtime/ontology-binding.js";
import {
	AGENT_RUNTIME_BINDING_SCHEMA,
	digestAgentRuntimeBinding,
	PRIME_AGENT_RUNTIME_BASELINE,
} from "../agent-runtime/profile.js";
import { mintAgentUri, STANDALONE_AGENT_IDENTITY_ALGORITHM } from "../agent-subject/agent-ontology.js";
import { AgentEvolutionCapabilityBackend, AgentEvolutionService } from "../capabilities/evolution.js";
import { GitWorktreeProvider } from "../workspace/git-workspace-provider.js";

const roots: string[] = [];
const ownerPrincipal = "user:capability-owner";
const agentId = "agent-0123456789abcdef";
const sessionId = "session-evolution-capability";
const graphId = "g-evolution-capability";

afterEach(() => {
	for (const root of roots.splice(0)) {
		makeWritable(root);
		rmSync(root, { recursive: true, force: true });
	}
});

function makeWritable(path: string): void {
	let metadata: ReturnType<typeof lstatSync>;
	try {
		metadata = lstatSync(path);
	} catch {
		return;
	}
	if (!metadata.isDirectory()) return;
	chmodSync(path, 0o755);
	for (const child of readdirSync(path)) makeWritable(join(path, child));
}

function digest(value: string): string {
	return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function externalRef<Kind extends MeaningfulObjectKind>(
	kind: Kind,
	objectId: string,
	character: string,
): MeaningfulObjectRefV1<Kind> {
	return {
		schema: MEANINGFUL_OBJECT_REF_SCHEMA,
		kind,
		ownerPrincipal,
		graphId,
		objectId,
		version: "1",
		digest: `sha256:${character.repeat(64)}`,
	};
}

function git(repository: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repository, ...args], {
		encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
	}).trim();
}

function makeRepository(): { path: string; revision: string } {
	const path = mkdtempSync(join(tmpdir(), "evolution-capability-source-"));
	roots.push(path);
	execFileSync("git", ["init", "--quiet", path]);
	git(path, "config", "user.email", "evolution-test@example.invalid");
	git(path, "config", "user.name", "Evolution Test");
	writeFileSync(join(path, "README.md"), "personal Agent extension source\n");
	git(path, "add", "--all");
	git(path, "commit", "--quiet", "-m", "baseline");
	return { path, revision: git(path, "rev-parse", "HEAD") };
}

function ontology(profileRef: MeaningfulObjectRefV1<"agent-runtime-profile">): AgentOntologyBindingV1 {
	return {
		schema: AGENT_ONTOLOGY_BINDING_SCHEMA,
		subject: {
			agentId,
			agentUri: mintAgentUri(agentId),
			observerId: agentId,
			registeredName: "capability-prime",
			identityAlgorithm: STANDALONE_AGENT_IDENTITY_ALGORITHM,
		},
		objects: {
			agent: externalRef("agent", agentId, "1"),
			geist: externalRef("geist", "geist", "2"),
			prompt: externalRef("prompt", "prompt", "3"),
			skills: [],
			harness: externalRef("harness", "harness", "4"),
			toolManifest: externalRef("tool-manifest", "tools", "5"),
			toolGrant: externalRef("tool-grant", "grant", "6"),
			runtimeProfile: profileRef,
		},
		resolvedAt: 1_000,
	};
}

describe("AgentEvolutionCapabilityBackend", () => {
	it("refreshes a digest-bound legacy bootstrap before worker execution", async () => {
		const stateRoot = mkdtempSync(join(tmpdir(), "evolution-legacy-bootstrap-state-"));
		roots.push(stateRoot);
		const databasePath = join(stateRoot, "evolution.sqlite");
		const store = new AgentEvolutionStore(databasePath);
		await store.init();
		const profileRef = externalRef("agent-runtime-profile", "prime-profile-current", "a");
		const currentOntology = ontology(profileRef);
		const currentRuntime = {
			schema: AGENT_RUNTIME_BINDING_SCHEMA,
			kind: "prime" as const,
			bundle: { id: "sophia-agent-runtime", digest: `sha256:${"b".repeat(64)}` },
			profileRef,
			constraints: PRIME_AGENT_RUNTIME_BASELINE,
		} as const;
		const legacyRuntime = {
			schema: AGENT_RUNTIME_BINDING_V2_SCHEMA,
			kind: "prime" as const,
			baseBundle: currentRuntime.bundle,
			overlays: [],
			profileRef,
			constraints: { ...PRIME_AGENT_RUNTIME_BASELINE, maxWorkspaceBytes: 1_073_741_824 },
			extensionAbi: PRIME_EXTENSION_ABI,
		};
		const legacyDocument = {
			schema: AGENT_EMBODIMENT_SCHEMA,
			embodimentId: "embodiment-bootstrap-legacy-runtime-contract",
			ownerPrincipal,
			agentId,
			runtimeBinding: legacyRuntime,
			runtimeBindingDigest: `sha256:${createHash("sha256").update(canonicalJson(legacyRuntime)).digest("hex")}`,
			ontologyBinding: currentOntology,
			ontologyBindingDigest: digestAgentOntologyBinding(currentOntology),
			createdAt: 1_000,
		};
		const legacyRef = createMeaningfulObjectRef({
			kind: "embodiment",
			ownerPrincipal,
			graphId,
			objectId: legacyDocument.embodimentId,
			version: "1",
			value: legacyDocument,
		});
		const client = createClient({ url: `file:${databasePath}` });
		await client.execute({
			sql: `INSERT INTO evolution_objects
			        (kind, owner_principal, graph_id, object_id, version, digest, agent_id, document_json, created_at)
			      VALUES ('embodiment', ?, ?, ?, '1', ?, ?, ?, ?)`,
			args: [
				ownerPrincipal,
				graphId,
				legacyDocument.embodimentId,
				legacyRef.digest,
				agentId,
				JSON.stringify(legacyDocument),
				legacyDocument.createdAt,
			],
		});
		await client.execute({
			sql: `INSERT INTO agent_embodiment_heads
			        (owner_principal, agent_id, graph_id, object_id, version, digest, revision, updated_at)
			      VALUES (?, ?, ?, ?, '1', ?, 1, ?)`,
			args: [ownerPrincipal, agentId, graphId, legacyDocument.embodimentId, legacyRef.digest, 1_000],
		});
		client.close();
		const controller = new PersonalEvolutionController({
			store,
			workspaceProvider: {} as never,
			builder: {} as never,
			evaluator: {} as never,
			repository: {
				repositoryId: "unused",
				repositoryPath: "/unused",
				baseRevision: "unused",
				allowedPaths: ["extension"],
				maximumWorkspaceBytes: 1,
				extensionRoot: "extension",
			},
			evaluation: { skillName: "unused", fixtures: [] },
			now: () => 2_000,
		});
		const resolved = await controller.resolveWorkerConfig(
			{
				mode: "agent",
				agent_id: agentId,
				session_id: "session-current-bootstrap",
				generation: 0,
				runtime_binding: currentRuntime,
				runtime_binding_digest: digestAgentRuntimeBinding(currentRuntime),
				agent_ontology: currentOntology,
				agent_ontology_binding_digest: digestAgentOntologyBinding(currentOntology),
			},
			{ ownerUserId: ownerPrincipal.slice("user:".length), graphId },
		);
		assert.equal(Object.hasOwn(resolved.embodiment_binding!.runtimeBinding.constraints, "maxWorkspaceBytes"), false);
		assert.notEqual(resolved.embodiment_ref?.digest, legacyRef.digest);
		assert.equal((await store.getActiveEmbodiment(ownerPrincipal, agentId))?.revision, 2);
		store.close();
	});

	it("runs proposal → workspace → patch → build → independent evaluation without moving the active head", async () => {
		const repository = makeRepository();
		const stateRoot = mkdtempSync(join(tmpdir(), "evolution-capability-state-"));
		const workspaceRoot = mkdtempSync(join(tmpdir(), "evolution-capability-workspace-"));
		const artifactRoot = mkdtempSync(join(tmpdir(), "evolution-capability-artifacts-"));
		roots.push(stateRoot, workspaceRoot, artifactRoot);
		const store = new AgentEvolutionStore(join(stateRoot, "evolution.sqlite"));
		await store.init();
		const provider = new GitWorktreeProvider({ rootDirectory: workspaceRoot, leaseMs: 60_000 });
		const builder = new PrimeExtensionBuilder({ artifactRoot, workspaceProvider: provider });
		let clock = 1_000;
		const now = () => clock++;
		const evaluator = new ExtensionEvaluationCoordinator(builder, { now });

		const profileRef = externalRef("agent-runtime-profile", "prime-profile", "7");
		const runtime = {
			schema: AGENT_RUNTIME_BINDING_V2_SCHEMA,
			kind: "prime" as const,
			baseBundle: { id: "sophia-agent-runtime", digest: `sha256:${"a".repeat(64)}` },
			overlays: [],
			profileRef,
			constraints: PRIME_AGENT_RUNTIME_BASELINE,
			extensionAbi: PRIME_EXTENSION_ABI,
		};
		const incumbentOntology = ontology(profileRef);
		const incumbent: AgentEmbodimentV1 = {
			schema: AGENT_EMBODIMENT_SCHEMA,
			embodimentId: "embodiment-incumbent",
			ownerPrincipal,
			agentId,
			runtimeBinding: runtime,
			runtimeBindingDigest: digestAgentRuntimeBindingV2(runtime),
			ontologyBinding: incumbentOntology,
			ontologyBindingDigest: digestAgentOntologyBinding(incumbentOntology),
			createdAt: now(),
		};
		const incumbentRef = await store.publishEvolutionObject({
			kind: "embodiment",
			graphId,
			version: "1",
			document: incumbent,
			createdAt: incumbent.createdAt,
		});
		await store.initializeActiveEmbodiment({ embodimentRef: incumbentRef, embodiment: incumbent, now: now() });

		const suite: ExtensionEvaluationSuiteV1 = {
			schema: EXTENSION_EVALUATION_SUITE_SCHEMA,
			suiteId: "manifest-summary-v1",
			ownerPrincipal,
			skillName: "summarize-manifest",
			fixtures: [{ caseId: "unordered", input: { value: { z: 1, a: 2 } }, expectedOutput: { keys: ["a", "z"] } }],
			timeoutMs: 2_000,
			maximumOutputBytes: 4_096,
			createdAt: now(),
		};
		const suiteRef = createMeaningfulObjectRef({
			kind: "evaluation-suite",
			ownerPrincipal,
			graphId,
			objectId: suite.suiteId,
			version: "1",
			value: suite,
		});
		const policy: EvaluationPolicyV1 = {
			schema: EVALUATION_POLICY_SCHEMA,
			policyId: "personal-extension-policy",
			policyVersion: "1",
			ownerPrincipal,
			evolutionClass: "extension",
			requiredSuites: [{ suiteRef, required: true }],
			thresholds: { requiredPassRate: 1, maximumNewSecurityFailures: 0 },
			approverPolicy: "owner",
			watchPolicy: { sessions: 3, automaticRollbackOn: ["security-regression"] },
		};
		const policyRef = createMeaningfulObjectRef({
			kind: "evaluation-policy",
			ownerPrincipal,
			graphId,
			objectId: policy.policyId,
			version: policy.policyVersion,
			value: policy,
		});
		const sourceCompositionRef = externalRef("source-composition", "prime-personal-extension-source", "8");
		const service = new AgentEvolutionService({
			store,
			workspaceProvider: provider,
			builder,
			evaluator,
			ownerPrincipal,
			agentId,
			sessionId,
			graphId,
			repository: {
				repositoryId: "prime-personal-extensions",
				repositoryPath: repository.path,
				baseRevision: repository.revision,
				allowedPaths: ["extension"],
				maximumWorkspaceBytes: 1_000_000,
				extensionRoot: "extension",
			},
			sourceCompositionRef,
			evaluationPolicy: policy,
			evaluationPolicyRef: policyRef,
			evaluationSuites: [{ suite, suiteRef }],
			allowedExtensionCapabilities: new Set(),
			now,
		});
		const backend = new AgentEvolutionCapabilityBackend(service);
		const authority = {
			owner_principal: ownerPrincipal,
			agent_id: agentId,
			session_id: sessionId,
			embodiment_ref: incumbentRef,
			expected_embodiment_digest: incumbentRef.digest,
		};
		const proposal = (await backend.callTool("propose", {
			...authority,
			problem_statement: "Manifest summaries are repeatedly implemented ad hoc.",
			rationale: "A deterministic owner extension removes repeated work without widening authority.",
			desired_outcome: "Return stable sorted manifest keys.",
			target_layer: "extension",
			evidence_refs: [],
			non_goals: ["No network", "No constitutional runtime change"],
		})) as { proposal_ref: MeaningfulObjectRefV1<"evolution-proposal"> };
		const workspace = (await backend.callTool("open_workspace", {
			...authority,
			proposal_ref: proposal.proposal_ref,
		})) as {
			workspace_id: string;
			generation: number;
			lease_token: string;
			requires_rematerialization: boolean;
		};
		assert.equal(workspace.requires_rematerialization, true);
		const leaseConfig = await service.workspaceLeaseConfig();
		assert.equal(JSON.stringify(workspace).includes(leaseConfig.hostPath), false, "physical paths are not public");
		const source =
			"def summarize_manifest(input_value):\n    value = input_value['value']\n    return {'keys': sorted(value.keys())}\n";
		mkdirSync(join(leaseConfig.hostPath, "extension", "python"), { recursive: true });
		writeFileSync(join(leaseConfig.hostPath, "extension", "python", "summarizer.py"), source);
		writeFileSync(
			join(leaseConfig.hostPath, "extension", "manifest.json"),
			`${JSON.stringify({
				schema: PRIME_EXTENSION_MANIFEST_SCHEMA,
				extensionId: "manifest-summarizer",
				version: "1.0.0",
				ownerPrincipal,
				abi: PRIME_EXTENSION_ABI,
				displayName: "Manifest summarizer",
				description: "Return stable sorted manifest keys.",
				network: "denied",
				dependencies: [],
				files: [{ path: "python/summarizer.py", digest: digest(source), mode: "0444" }],
				skills: [
					{
						name: "summarize-manifest",
						description: "Sort manifest keys.",
						entrypoint: "summarizer:summarize_manifest",
						inputSchema: {
							type: "object",
							properties: { value: { type: "object" } },
							required: ["value"],
							additionalProperties: false,
						},
						outputSchema: {
							type: "object",
							properties: { keys: { type: "array", items: { type: "string" } } },
							required: ["keys"],
							additionalProperties: false,
						},
						requiredCapabilities: [],
					},
				],
			})}\n`,
		);
		const checkpoint = (await backend.callTool("checkpoint", {
			...authority,
			workspace_id: workspace.workspace_id,
			lease_token: workspace.lease_token,
			generation: workspace.generation,
			summary: "Add a deterministic manifest summarizer.",
		})) as { checkpoint_ref: MeaningfulObjectRefV1<"workspace-checkpoint"> };
		const draft = (await backend.callTool("build_candidate", {
			...authority,
			workspace_id: workspace.workspace_id,
			lease_token: workspace.lease_token,
			generation: workspace.generation,
			checkpoint_ref: checkpoint.checkpoint_ref,
		})) as { candidate_ref: MeaningfulObjectRefV1<"embodiment-candidate"> };
		const evaluated = (await backend.callTool("evaluate_candidate", {
			...authority,
			candidate_ref: draft.candidate_ref,
		})) as { candidate_ref: MeaningfulObjectRefV1<"embodiment-candidate">; state: string };
		assert.equal(evaluated.state, "eligible");
		assert.equal(evaluated.candidate_ref.version, "2");
		const submitted = (await backend.callTool("submit_candidate", {
			...authority,
			candidate_ref: evaluated.candidate_ref,
			reason: "Independent verification passed.",
		})) as { submitted: boolean; self_activation_permitted: boolean };
		assert.equal(submitted.submitted, true);
		assert.equal(submitted.self_activation_permitted, false);
		const unchanged = await store.getActiveEmbodiment(ownerPrincipal, agentId);
		assert.equal(unchanged?.embodimentRef.digest, incumbentRef.digest);
		await assert.rejects(() => backend.callTool("activate", authority), /unknown tool/);

		const controller = new PersonalEvolutionController({
			store,
			workspaceProvider: provider,
			builder,
			evaluator,
			repository: {
				repositoryId: "prime-personal-extensions",
				repositoryPath: repository.path,
				baseRevision: repository.revision,
				allowedPaths: ["extension"],
				maximumWorkspaceBytes: 1_000_000,
				extensionRoot: "extension",
			},
			evaluation: { skillName: suite.skillName, fixtures: suite.fixtures },
			now,
		});
		const promotion = await controller.decidePromotion({
			ownerPrincipal,
			agentId,
			candidateRef: evaluated.candidate_ref,
			verdict: "approved",
			reason: "Exact deterministic testimony is satisfactory.",
			idempotencyKey: "approve-manifest-summarizer",
		});
		const promotionRetry = await controller.decidePromotion({
			ownerPrincipal,
			agentId,
			candidateRef: evaluated.candidate_ref,
			verdict: "approved",
			reason: "A retry cannot rewrite the immutable decision.",
			idempotencyKey: "approve-manifest-summarizer",
		});
		assert.equal(promotionRetry.decisionRef.digest, promotion.decisionRef.digest);

		const canary = await controller.activate({
			ownerPrincipal,
			agentId,
			candidateRef: evaluated.candidate_ref,
			promotionDecisionRef: promotion.decisionRef,
			expectedIncumbentRef: incumbentRef,
			mode: "canary-session",
			idempotencyKey: "canary-manifest-summarizer",
		});
		assert.equal(canary.head.embodimentRef.digest, incumbentRef.digest, "canary does not move the default head");
		const canaryResolved = await store.resolveEmbodiment({
			ownerPrincipal,
			agentId,
			canaryActivationId: canary.activation.activationId,
		});
		assert.equal(canaryResolved?.embodimentRef.digest, canary.activation.nextEmbodimentRef.digest);
		const baseRuntimeBinding = {
			schema: AGENT_RUNTIME_BINDING_SCHEMA,
			kind: runtime.kind,
			bundle: runtime.baseBundle,
			profileRef: runtime.profileRef,
			constraints: runtime.constraints,
		} as const;
		const legacyWorkerConfig = {
			mode: "agent" as const,
			agent_id: agentId,
			session_id: "session-canary-proof",
			generation: 0,
			runtime_binding: baseRuntimeBinding,
			runtime_binding_digest: digestAgentRuntimeBinding(baseRuntimeBinding),
			agent_ontology: incumbentOntology,
			agent_ontology_binding_digest: incumbent.ontologyBindingDigest,
		};
		const canaryWorker = await controller.resolveWorkerConfig(legacyWorkerConfig, {
			ownerUserId: ownerPrincipal.slice("user:".length),
			graphId,
			canaryActivationId: canary.activation.activationId,
		});
		assert.equal(canaryWorker.embodiment_ref?.digest, canary.activation.nextEmbodimentRef.digest);
		assert.equal(canaryWorker.runtime_binding?.schema, AGENT_RUNTIME_BINDING_SCHEMA);

		const activated = await controller.activate({
			ownerPrincipal,
			agentId,
			candidateRef: evaluated.candidate_ref,
			promotionDecisionRef: promotion.decisionRef,
			expectedIncumbentRef: incumbentRef,
			mode: "future-sessions",
			idempotencyKey: "activate-manifest-summarizer",
		});
		assert.equal(activated.head.embodimentRef.digest, activated.activation.nextEmbodimentRef.digest);
		const futureWorker = await controller.resolveWorkerConfig(
			{ ...legacyWorkerConfig, session_id: "session-future-proof" },
			{ ownerUserId: ownerPrincipal.slice("user:".length), graphId },
		);
		assert.equal(futureWorker.embodiment_ref?.digest, activated.activation.nextEmbodimentRef.digest);
		assert.equal(futureWorker.runtime_binding?.schema, AGENT_RUNTIME_BINDING_SCHEMA);
		assert.equal(futureWorker.embodiment_binding?.runtimeBinding.overlays.length, 1);
		const activationRetry = await controller.activate({
			ownerPrincipal,
			agentId,
			candidateRef: evaluated.candidate_ref,
			promotionDecisionRef: promotion.decisionRef,
			expectedIncumbentRef: incumbentRef,
			mode: "future-sessions",
			idempotencyKey: "activate-manifest-summarizer",
		});
		assert.equal(activationRetry.activationRef.digest, activated.activationRef.digest);

		const room = await controller.getCandidate(ownerPrincipal, evaluated.candidate_ref.objectId);
		assert.equal((room.patchSets as unknown[]).length, 1);
		assert.equal((room.verificationRuns as unknown[]).length, 1);
		const patch = await controller
			.readPatchArtifact(ownerPrincipal, `patch-${checkpoint.checkpoint_ref.digest.slice(-32)}`)
			.catch(() => null);
		// The packet carries the exact patch-set id; use it rather than trusting narration.
		const patchSet = (room.patchSets as { document: { patchSetId: string } }[])[0];
		assert.ok(patchSet);
		const exactPatch = await controller.readPatchArtifact(ownerPrincipal, patchSet.document.patchSetId);
		assert.match(Buffer.from(exactPatch.body).toString("utf8"), /summarizer\.py/);
		assert.equal(patch, null, "an unrelated artifact id cannot read candidate bytes");

		const projected: string[] = [];
		const projection = await controller.flushRdfProjection({
			async sparqlUpdate(projectedGraphId, update) {
				assert.equal(projectedGraphId, graphId);
				projected.push(update);
			},
		});
		assert.equal(projection.failed, 0);
		assert.equal(projection.pending, 0);
		assert.ok(projected.every((rdf) => rdf.startsWith("INSERT DATA {\n")));
		assert.ok(projected.some((rdf) => rdf.includes("EmbodimentActivation")));
		assert.ok(
			projected.every((rdf) => !rdf.includes("def summarize_manifest")),
			"source bytes stay out of RDF",
		);

		const rollback = await controller.rollback({
			ownerPrincipal,
			agentId,
			activationRef: activated.activationRef,
			targetEmbodimentRef: incumbentRef,
			reason: "Exercise the owner rollback path.",
			quarantineCurrent: true,
			idempotencyKey: "rollback-manifest-summarizer",
		});
		assert.equal(rollback.head.embodimentRef.digest, incumbentRef.digest);
		await assert.rejects(
			() =>
				controller.activate({
					ownerPrincipal,
					agentId,
					candidateRef: evaluated.candidate_ref,
					promotionDecisionRef: promotion.decisionRef,
					expectedIncumbentRef: incumbentRef,
					mode: "future-sessions",
					idempotencyKey: "reactivate-quarantined-artifact",
				}),
			/quarantined/,
		);
	});

	it("does not advertise owner-only activation or rollback operations", async () => {
		const tools = await new AgentEvolutionCapabilityBackend({} as AgentEvolutionService).listTools();
		assert.equal(
			tools.some((tool) => tool.name === "activate" || tool.name === "rollback"),
			false,
		);
	});

	it("rebinds one pending credentialless workspace into a follow-on Agent session", async () => {
		const repository = makeRepository();
		const stateRoot = mkdtempSync(join(tmpdir(), "evolution-rebind-state-"));
		const workspaceRoot = mkdtempSync(join(tmpdir(), "evolution-rebind-workspace-"));
		const artifactRoot = mkdtempSync(join(tmpdir(), "evolution-rebind-artifacts-"));
		roots.push(stateRoot, workspaceRoot, artifactRoot);
		const store = new AgentEvolutionStore(join(stateRoot, "evolution.sqlite"));
		await store.init();
		const provider = new GitWorktreeProvider({ rootDirectory: workspaceRoot, leaseMs: 60_000 });
		const builder = new PrimeExtensionBuilder({ artifactRoot, workspaceProvider: provider });
		let clock = 10_000;
		const now = () => clock++;
		const controller = new PersonalEvolutionController({
			store,
			workspaceProvider: provider,
			builder,
			evaluator: new ExtensionEvaluationCoordinator(builder, { now }),
			repository: {
				repositoryId: "prime-personal-extensions",
				repositoryPath: repository.path,
				baseRevision: repository.revision,
				allowedPaths: ["extension"],
				maximumWorkspaceBytes: 1_000_000,
				extensionRoot: "extension",
			},
			evaluation: {
				skillName: "future-extension",
				fixtures: [{ caseId: "placeholder", input: {}, expectedOutput: {} }],
			},
			now,
		});
		const profileRef = externalRef("agent-runtime-profile", "prime-profile-rebind", "a");
		const incumbentOntology = ontology(profileRef);
		const runtimeBinding = {
			schema: AGENT_RUNTIME_BINDING_SCHEMA,
			kind: "prime" as const,
			bundle: { id: "sophia-agent-runtime", digest: `sha256:${"a".repeat(64)}` },
			profileRef,
			constraints: PRIME_AGENT_RUNTIME_BASELINE,
		} as const;
		const legacy = {
			mode: "agent" as const,
			agent_id: agentId,
			session_id: "session-author-proposal",
			generation: 0,
			runtime_binding: runtimeBinding,
			runtime_binding_digest: digestAgentRuntimeBinding(runtimeBinding),
			agent_ontology: incumbentOntology,
			agent_ontology_binding_digest: digestAgentOntologyBinding(incumbentOntology),
		};
		const firstWorker = await controller.resolveWorkerConfig(legacy, {
			ownerUserId: ownerPrincipal.slice("user:".length),
			graphId,
		});
		assert.ok(firstWorker.embodiment_ref);
		const context = (boundSessionId: string) => ({
			graphId,
			graphOwner: ownerPrincipal,
			actorRef: `urn:sophia:actor:${ownerPrincipal}`,
			ownerUserId: ownerPrincipal.slice("user:".length),
			authority: { minimumRole: "editor" as const, dangerousOps: false },
			agentSession: { sessionId: boundSessionId, agentId },
		});
		const firstBackend = await controller.bindCapability(context(legacy.session_id));
		const incumbentAuthority = {
			owner_principal: ownerPrincipal,
			agent_id: agentId,
			session_id: legacy.session_id,
			embodiment_ref: firstWorker.embodiment_ref,
			expected_embodiment_digest: firstWorker.embodiment_ref.digest,
		};
		const proposal = (await firstBackend.callTool("propose", {
			...incumbentAuthority,
			problem_statement: "A bounded personal extension is needed.",
			rationale: "The candidate must be authored in a separate mount.",
			desired_outcome: "A deterministic extension artifact.",
			target_layer: "extension",
		})) as { proposal_ref: MeaningfulObjectRefV1<"evolution-proposal"> };
		const opened = (await firstBackend.callTool("open_workspace", {
			...incumbentAuthority,
			proposal_ref: proposal.proposal_ref,
		})) as { workspace_id: string; requires_rematerialization: boolean };
		assert.equal(opened.requires_rematerialization, true);
		const proposalRecord = await store.getEvolutionObject(proposal.proposal_ref);
		assert.equal(proposalRecord?.document.schema, "sophia.evolution-proposal.v1");
		if (!proposalRecord || proposalRecord.document.schema !== "sophia.evolution-proposal.v1") {
			throw new Error("proposal evidence fixture was not stored");
		}
		assert.ok(proposalRecord.document.requestedSourceComposition);
		assert.ok(await store.getEvidenceObject(proposalRecord.document.requestedSourceComposition));
		assert.ok(
			await store.getEvidenceObjectById({
				ownerPrincipal,
				kind: "code-workspace",
				objectId: opened.workspace_id,
			}),
		);

		const secondSessionId = "session-author-candidate";
		const secondWorker = await controller.resolveWorkerConfig(
			{ ...legacy, session_id: secondSessionId, generation: 1 },
			{ ownerUserId: ownerPrincipal.slice("user:".length), graphId },
		);
		assert.equal(secondWorker.candidate_workspace?.workspaceId, opened.workspace_id);
		assert.equal(secondWorker.candidate_workspace?.mountPath, "/candidate");
		const secondBackend = await controller.bindCapability(context(secondSessionId));
		const rebound = (await secondBackend.callTool("open_workspace", {
			owner_principal: ownerPrincipal,
			agent_id: agentId,
			session_id: secondSessionId,
			embodiment_ref: firstWorker.embodiment_ref,
			expected_embodiment_digest: firstWorker.embodiment_ref.digest,
			workspace_id: secondWorker.candidate_workspace?.workspaceId,
			lease_token: secondWorker.candidate_workspace?.leaseToken,
			generation: secondWorker.candidate_workspace?.generation,
			proposal_ref: proposal.proposal_ref,
		})) as { workspace_id: string; requires_rematerialization: boolean };
		assert.equal(rebound.workspace_id, opened.workspace_id);
		assert.equal(rebound.requires_rematerialization, false);
		assert.equal(JSON.stringify(rebound).includes(workspaceRoot), false);
	});

	it("publishes /refine as a reviewable harness candidate, materializes only after activation, and rolls back", async () => {
		const repository = makeRepository();
		const stateRoot = mkdtempSync(join(tmpdir(), "harness-evolution-state-"));
		const workspaceRoot = mkdtempSync(join(tmpdir(), "harness-evolution-workspace-"));
		const artifactRoot = mkdtempSync(join(tmpdir(), "harness-evolution-artifacts-"));
		roots.push(stateRoot, workspaceRoot, artifactRoot);
		const store = new AgentEvolutionStore(join(stateRoot, "evolution.sqlite"));
		await store.init();
		const provider = new GitWorktreeProvider({ rootDirectory: workspaceRoot, leaseMs: 60_000 });
		const builder = new PrimeExtensionBuilder({ artifactRoot, workspaceProvider: provider });
		let clock = 20_000;
		const now = () => clock++;
		const controller = new PersonalEvolutionController({
			store,
			workspaceProvider: provider,
			builder,
			evaluator: new ExtensionEvaluationCoordinator(builder, { now }),
			repository: {
				repositoryId: "prime-personal-extensions",
				repositoryPath: repository.path,
				baseRevision: repository.revision,
				allowedPaths: ["extension"],
				maximumWorkspaceBytes: 1_000_000,
				extensionRoot: "extension",
			},
			evaluation: {
				skillName: "unused-for-harness",
				fixtures: [{ caseId: "placeholder", input: {}, expectedOutput: {} }],
			},
			now,
		});
		const profileRef = externalRef("agent-runtime-profile", "prime-profile-harness", "9");
		const runtime = {
			schema: AGENT_RUNTIME_BINDING_SCHEMA,
			kind: "prime" as const,
			bundle: { id: "sophia-agent-runtime", digest: `sha256:${"a".repeat(64)}` },
			profileRef,
			constraints: PRIME_AGENT_RUNTIME_BASELINE,
		};
		const incumbentOntology = ontology(profileRef);
		const legacyConfig = {
			mode: "agent" as const,
			agent_id: agentId,
			session_id: sessionId,
			generation: 0,
			runtime_binding: runtime,
			runtime_binding_digest: digestAgentRuntimeBinding(runtime),
			agent_ontology: incumbentOntology,
			agent_ontology_binding_digest: digestAgentOntologyBinding(incumbentOntology),
		};
		const incumbentWorker = await controller.resolveWorkerConfig(legacyConfig, {
			ownerUserId: ownerPrincipal.slice("user:".length),
			graphId,
		});
		assert.ok(incumbentWorker.embodiment_ref);
		assert.ok(incumbentWorker.embodiment_binding_digest);
		assert.ok(incumbentWorker.runtime_binding_digest);
		assert.ok(incumbentWorker.agent_ontology_binding_digest);
		const incumbentRef = incumbentWorker.embodiment_ref;
		await assert.rejects(
			() =>
				controller.resolveWorkerConfig(legacyConfig, {
					ownerUserId: ownerPrincipal.slice("user:".length),
					graphId: "another-owner-graph",
				}),
			/authenticated owner or graph/,
		);
		const snapshot = {
			schema: 1 as const,
			entries: [
				{
					id: "directive-proof-style",
					type: "directive",
					content: "Prefer a short executable proof before prose.",
				},
			],
		};
		const refineEvent = {
			name: "refine_complete",
			payload: {
				type: "refine_complete",
				result: {
					id: "refinement-proof-style",
					summary: "Make verification concrete.",
					rationale: "Recent work benefited from executable proof before narration.",
					expectedOutcome: "Fewer plausible but unverified completions.",
					appliedEdits: [
						{
							id: "edit-proof-style",
							type: "add_directive",
							path: "entries/directive-proof-style",
							applied: true,
						},
					],
				},
				harness_snapshot: snapshot,
			},
			session_id: sessionId,
			runtime_binding_digest: incumbentWorker.runtime_binding_digest,
			agent_ontology_binding_digest: incumbentWorker.agent_ontology_binding_digest,
			embodiment_digest: incumbentWorker.embodiment_binding_digest,
		};
		const ingested = await controller.ingestHarnessRefinement({
			ownerUserId: ownerPrincipal.slice("user:".length),
			graphId,
			agentId,
			sessionId,
			event: refineEvent,
			occurredAt: 21_000,
		});
		assert.ok(ingested);
		assert.equal(ingested.state, "eligible");
		assert.equal(
			(await store.getActiveEmbodiment(ownerPrincipal, agentId))?.embodimentRef.digest,
			incumbentRef.digest,
		);
		const retry = await controller.ingestHarnessRefinement({
			ownerUserId: ownerPrincipal.slice("user:".length),
			graphId,
			agentId,
			sessionId,
			event: refineEvent,
			occurredAt: 21_999,
		});
		assert.equal(retry?.candidateRef.digest, ingested.candidateRef.digest, "event replay is idempotent");

		const packet = await controller.getCandidate(ownerPrincipal, ingested.candidateRef.objectId);
		assert.equal((packet.candidate as { document: { targetLayer: string } }).document.targetLayer, "harness");
		const patchSet = (packet.patchSets as { document: { patchSetId: string } }[])[0];
		assert.ok(patchSet);
		const patch = await controller.readPatchArtifact(ownerPrincipal, patchSet.document.patchSetId);
		assert.match(Buffer.from(patch.body).toString("utf8"), /After: sha256:/);
		assert.doesNotMatch(Buffer.from(patch.body).toString("utf8"), /Prefer a short executable proof/);

		const rejected = await controller.decidePromotion({
			ownerPrincipal,
			agentId,
			candidateRef: ingested.candidateRef,
			verdict: "rejected",
			reason: "Exercise the explicit no path.",
			idempotencyKey: "reject-harness-proof",
		});
		await assert.rejects(
			() =>
				controller.activate({
					ownerPrincipal,
					agentId,
					candidateRef: ingested.candidateRef,
					promotionDecisionRef: rejected.decisionRef,
					expectedIncumbentRef: incumbentRef,
					mode: "future-sessions",
					idempotencyKey: "cannot-activate-rejection",
				}),
			/not approved and eligible/,
		);
		const approved = await controller.decidePromotion({
			ownerPrincipal,
			agentId,
			candidateRef: ingested.candidateRef,
			verdict: "approved",
			reason: "The candidate is now accepted for personal use.",
			idempotencyKey: "approve-harness-proof",
		});
		const activation = await controller.activate({
			ownerPrincipal,
			agentId,
			candidateRef: ingested.candidateRef,
			promotionDecisionRef: approved.decisionRef,
			expectedIncumbentRef: incumbentRef,
			mode: "future-sessions",
			idempotencyKey: "activate-harness-proof",
		});
		const evolvedWorker = await controller.resolveWorkerConfig(
			{ ...legacyConfig, session_id: "session-after-harness-activation" },
			{ ownerUserId: ownerPrincipal.slice("user:".length), graphId },
		);
		assert.deepEqual(evolvedWorker.harness_materialization?.snapshot, snapshot);
		assert.equal(evolvedWorker.harness_materialization?.harnessRef.digest, ingested.harnessRef.digest);
		assert.equal(evolvedWorker.agent_ontology?.objects.harness.digest, ingested.harnessRef.digest);

		await controller.rollback({
			ownerPrincipal,
			agentId,
			activationRef: activation.activationRef,
			targetEmbodimentRef: incumbentRef,
			reason: "Restore the prior Layer-H generation.",
			quarantineCurrent: false,
			idempotencyKey: "rollback-harness-proof",
		});
		const restoredWorker = await controller.resolveWorkerConfig(
			{ ...legacyConfig, session_id: "session-after-harness-rollback" },
			{ ownerUserId: ownerPrincipal.slice("user:".length), graphId },
		);
		assert.equal(restoredWorker.embodiment_ref?.digest, incumbentRef.digest);
		assert.equal(restoredWorker.harness_materialization, undefined);
	});
});
