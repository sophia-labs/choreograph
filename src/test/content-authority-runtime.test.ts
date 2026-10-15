import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import {
	CONTENT_AUTHORITY_BINDING_SCHEMA,
	type ContentAuthorityBindingV1,
	createFinalWorkerPromptReceipt,
	type SkillActivationSelectionV1,
	type SkillReviewApprovalV1,
	sha256Utf8,
} from "../agent-runtime/content-authority-contract.js";
import { createContentAuthorityAdmissionPort } from "../agent-runtime/content-authority-runtime.js";
import { MEANINGFUL_OBJECT_REF_SCHEMA, type MeaningfulObjectRefV1 } from "../agent-runtime/meaningful-object.js";
import {
	digestReviewedSkillOverlayArtifact,
	digestReviewedSkillOverlayManifest,
	type ImmutableCasArtifactFileV1,
	type ReviewedSkillOverlayManifestV1,
} from "../agent-runtime/verified-execution-capsule-admission.js";
import type { SandboxEventBus } from "../event-bus.js";
import type { SandboxSpawner } from "../spawner.js";
import { makeNodeRunner } from "../workflow/run-node.js";
import { makeRuntimeNodeRunner } from "../workflow/runtime-control.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

const encoder = new TextEncoder();

function ref<Kind extends "prompt" | "skill" | "release-artifact" | "artifact">(
	kind: Kind,
	objectId: string,
	digest: string,
): MeaningfulObjectRefV1<Kind> {
	return {
		schema: MEANINGFUL_OBJECT_REF_SCHEMA,
		kind,
		ownerPrincipal: "user:ada",
		graphId: "prime-lab",
		objectId,
		version: "1",
		digest,
	};
}

function fixture(): {
	readonly binding: ContentAuthorityBindingV1;
	readonly files: readonly ImmutableCasArtifactFileV1[];
} {
	const skillRef = ref("skill", "research", `sha256:${"b".repeat(64)}`);
	const manifest: ReviewedSkillOverlayManifestV1 = {
		schema: "sophia.reviewed-skill-overlay-manifest.v1",
		skillRef,
		disclosure: { path: "skills/research/SKILL.md", digest: sha256Utf8("# Reviewed research skill\n") },
		entrypoint: {
			path: "python/research.ts",
			exportName: "run",
			digest: sha256Utf8("export function run(): void {}\n"),
		},
		files: [
			{ path: "python/research.ts", digest: sha256Utf8("export function run(): void {}\n") },
			{ path: "skills/research/SKILL.md", digest: sha256Utf8("# Reviewed research skill\n") },
		],
	};
	const manifestDigest = digestReviewedSkillOverlayManifest(manifest);
	const artifactDigest = digestReviewedSkillOverlayArtifact({ manifestDigest, files: manifest.files });
	const artifactRef = ref("release-artifact", "research-extension", `sha256:${"c".repeat(64)}`);
	const manifestRef = ref("artifact", "research-extension-manifest", manifestDigest);
	const approval: SkillReviewApprovalV1 = {
		approvalRef: {
			ownerPrincipal: "user:ada",
			graphId: "prime-lab",
			objectId: "review-research-v1",
			version: "1",
			digest: `sha256:${"d".repeat(64)}`,
		},
		state: "approved",
		skillRef,
		artifactRef,
		artifactDigest,
		manifest: {
			manifestRef,
			manifestDigest,
			skillRef,
			disclosure: manifest.disclosure,
			entrypoint: manifest.entrypoint,
		},
	};
	const selection: SkillActivationSelectionV1 = {
		skillRef,
		artifactRef,
		artifactDigest,
		manifestRef,
		manifestDigest,
	};
	const source = "You are the admitted researcher.";
	return {
		binding: {
			schema: CONTENT_AUTHORITY_BINDING_SCHEMA,
			prompt: createFinalWorkerPromptReceipt({
				source: { promptRef: ref("prompt", "research-prompt", sha256Utf8(source)), renderedUtf8: source },
				transforms: [{ transformId: "domain-policy.v1", appendUtf8: "\nReturn proposals only." }],
			}),
			reviewedSkill: { approval, selection },
		},
		files: [
			{ path: "manifest.json", bytes: encoder.encode(JSON.stringify(manifest)) },
			{ path: "skills/research/SKILL.md", bytes: encoder.encode("# Reviewed research skill\n") },
			{ path: "python/research.ts", bytes: encoder.encode("export function run(): void {}\n") },
		],
	};
}

function materializeReadOnlyArtifact(files: readonly ImmutableCasArtifactFileV1[]): string {
	const root = mkdtempSync(join(tmpdir(), "content-authority-artifact-"));
	for (const file of files) {
		const path = join(root, file.path);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, file.bytes);
		chmodSync(path, 0o444);
	}
	chmodSync(join(root, "skills", "research"), 0o555);
	chmodSync(join(root, "skills"), 0o555);
	chmodSync(join(root, "python"), 0o555);
	chmodSync(root, 0o555);
	return root;
}

describe("I2 host content-authority preflight", () => {
	it("orders CAS and physical admission before Session, capability, and queue mutation while preserving legacy execution", async () => {
		const input = fixture();
		const root = materializeReadOnlyArtifact(input.files);
		after(() => {
			chmodSync(root, 0o755);
			chmodSync(join(root, "skills"), 0o755);
			chmodSync(join(root, "skills", "research"), 0o755);
			chmodSync(join(root, "python"), 0o755);
			rmSync(root, { recursive: true, force: true });
		});
		const order: string[] = [];
		const port = createContentAuthorityAdmissionPort({
			cas: {
				readArtifact: () => {
					order.push("cas");
					return { files: input.files };
				},
			},
			mounts: {
				resolveReadOnlyArtifactMount: () => {
					order.push("mount");
					return { hostPath: root };
				},
			},
		});
		const eventBus: SandboxEventBus = {
			emit: () => undefined,
			subscribe: (subscriber, options) => {
				queueMicrotask(() =>
					subscriber({
						category: "lifecycle",
						type: "terminal",
						sandbox_id: options.sandbox_id,
						ts: new Date(0).toISOString(),
						state: "done",
						result: { spawn_id: options.sandbox_id, status: "terminated", output: "ok", turns: 0 },
					}),
				);
				return () => undefined;
			},
			subscriberCount: () => 0,
			cleanup: () => undefined,
		};
		const spawner = {
			enqueue: () => {
				order.push("enqueue");
				return {
					sandbox_id: "sandbox-i",
					state: "queued",
					template: "agent",
					queued_at: new Date(0).toISOString(),
				};
			},
			awaitSpawnAttempt: async () => undefined,
		} as unknown as SandboxSpawner;
		const runtime = {
			readAgentSessionByNodeKey: async () => undefined,
			getWorkflowInstance: async () => undefined,
			beginAgentSession: async () => {
				order.push("begin-session");
				return {};
			},
			claimAgentMaterialization: async () => undefined,
			finishAgentSession: async () => undefined,
			releaseUnboundAgentMaterializationLaunch: async () => false,
		} as never;
		const semantic = makeTestAgentSemanticBinding({ graphId: "prime-lab", registeredName: "i-order" });
		const baseRunner = makeNodeRunner({
			spawner,
			eventBus,
			ownerUserId: "ada",
			mnemosyne: { graphId: "prime-lab", capabilities: { reads: true, writes: false, dangerous_ops: false } },
			contentAuthorityAdmission: port,
			resolveAgentWorkerConfig: async (_spec, config) => {
				order.push("resolve-worker");
				return config;
			},
			bindCapabilities: async () => {
				order.push("bind-capabilities");
				return new Map();
			},
		});
		const runner = makeRuntimeNodeRunner({
			runtime,
			memory: {} as never,
			baseRunner,
			runId: "run-i",
			workflowName: "i-order",
			graphId: "prime-lab",
			ownerUserId: "ada",
			graphOwnerPrincipal: "user:ada",
			contentAuthorityAdmission: port,
			now: () => 1,
		});
		await runner({
			label: "i-node",
			phaseIndex: 1,
			prompt: "perform reviewed work",
			model: "mock:done",
			provider: "openrouter",
			graphId: "prime-lab",
			...semantic,
			contentAuthority: input.binding,
		});
		assert.deepEqual(order, [
			"cas",
			"mount",
			"begin-session",
			"cas",
			"resolve-worker",
			"bind-capabilities",
			"enqueue",
		]);

		order.length = 0;
		await runner({
			label: "legacy-node",
			phaseIndex: 2,
			prompt: "legacy work",
			model: "mock:done",
			provider: "openrouter",
			graphId: "prime-lab",
			...semantic,
		});
		assert.deepEqual(order, ["begin-session", "resolve-worker", "bind-capabilities", "enqueue"]);
	});

	it("keeps partial I authority at zero Session, capability, and queue calls", async () => {
		let sessions = 0;
		let capabilities = 0;
		let queues = 0;
		const semantic = makeTestAgentSemanticBinding({ graphId: "prime-lab", registeredName: "i-partial" });
		const runner = makeRuntimeNodeRunner({
			runtime: {
				readAgentSessionByNodeKey: async () => undefined,
				getWorkflowInstance: async () => undefined,
				beginAgentSession: async () => {
					sessions += 1;
					return {};
				},
			} as never,
			memory: {} as never,
			baseRunner: makeNodeRunner({
				spawner: {
					enqueue: () => {
						queues += 1;
						return {};
					},
				} as never,
				eventBus: {} as SandboxEventBus,
				ownerUserId: "ada",
				mnemosyne: { graphId: "prime-lab" },
				bindCapabilities: async () => {
					capabilities += 1;
					return new Map();
				},
			}),
			runId: "run-partial",
			workflowName: "i-partial",
			graphId: "prime-lab",
			ownerUserId: "ada",
			graphOwnerPrincipal: "user:ada",
		});
		await assert.rejects(() =>
			runner({
				label: "partial-node",
				phaseIndex: 1,
				prompt: "must not run",
				model: "mock:done",
				provider: "openrouter",
				graphId: "prime-lab",
				...semantic,
				verifiedExecutionCapsule: {} as never,
			}),
		);
		assert.deepEqual({ sessions, capabilities, queues }, { sessions: 0, capabilities: 0, queues: 0 });
	});

	it("reads CAS and binds the actual manifest before its caller may begin any mutable phase", async () => {
		const input = fixture();
		const root = materializeReadOnlyArtifact(input.files);
		after(() => {
			chmodSync(root, 0o755);
			chmodSync(join(root, "skills"), 0o755);
			chmodSync(join(root, "skills", "research"), 0o755);
			chmodSync(join(root, "python"), 0o755);
			rmSync(root, { recursive: true, force: true });
		});
		const order: string[] = [];
		const port = createContentAuthorityAdmissionPort({
			cas: {
				readArtifact: () => {
					order.push("cas");
					return { files: input.files };
				},
			},
			mounts: {
				resolveReadOnlyArtifactMount: () => {
					order.push("mount");
					return { hostPath: root };
				},
			},
		});
		const prepared = await port.preflight({ contentAuthority: input.binding } as AgentNodeSpec);
		order.push("begin-session");
		assert.deepEqual(order, ["cas", "mount", "begin-session"]);
		assert.equal(prepared.systemPrompt, input.binding.prompt.finalPromptUtf8);
		assert.ok(prepared.verifiedExecutionCapsule);

		await port.reverify(prepared);
		assert.deepEqual(order, ["cas", "mount", "begin-session", "cas"]);
		const replayedByValue = {
			...prepared,
			verifiedExecutionCapsule: structuredClone(prepared.verifiedExecutionCapsule),
		};
		await assert.rejects(() => port.reverify(replayedByValue), /not sealed by the prequeue admission port/);
		const reconstructed = await port.preflight(replayedByValue);
		await port.reverify(reconstructed);
	});

	it("rejects partial authority before it can resolve CAS or mount anything", async () => {
		let touched = false;
		const port = createContentAuthorityAdmissionPort({
			cas: {
				readArtifact: () => {
					touched = true;
					return undefined;
				},
			},
			mounts: {
				resolveReadOnlyArtifactMount: () => {
					touched = true;
					return { hostPath: "/tmp" };
				},
			},
		});
		await assert.rejects(() => port.preflight({ verifiedExecutionCapsule: {} } as AgentNodeSpec));
		assert.equal(touched, false);
	});

	it("rejects a mounted manifest whose bytes drift after preflight", async () => {
		const input = fixture();
		const root = materializeReadOnlyArtifact(input.files);
		after(() => {
			chmodSync(root, 0o755);
			chmodSync(join(root, "skills"), 0o755);
			chmodSync(join(root, "skills", "research"), 0o755);
			chmodSync(join(root, "python"), 0o755);
			rmSync(root, { recursive: true, force: true });
		});
		const port = createContentAuthorityAdmissionPort({
			cas: { readArtifact: () => ({ files: input.files }) },
			mounts: { resolveReadOnlyArtifactMount: () => ({ hostPath: root }) },
		});
		const prepared = await port.preflight({ contentAuthority: input.binding } as AgentNodeSpec);
		const manifestPath = join(root, "manifest.json");
		chmodSync(root, 0o755);
		chmodSync(manifestPath, 0o644);
		writeFileSync(manifestPath, '{"poison":true}');
		chmodSync(manifestPath, 0o444);
		chmodSync(root, 0o555);
		await assert.rejects(() => port.reverify(prepared), /manifest bytes drifted|overlay manifest/);
	});
});
