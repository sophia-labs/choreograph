import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalDigest } from "@sophia-labs/canonical-json";
import { SophiaContentStore } from "../agent-runtime/content-store.js";
import { type MeaningfulObjectRefV1, validateMeaningfulObjectRef } from "../agent-runtime/meaningful-object.js";
import { AgentMemory } from "../agent-runtime/memory.js";
import { PRIME_RUNTIME_STATE_SCHEMA, type PrimeRuntimeStateV2 } from "../agent-runtime/result-validation.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

describe("Sophia Agent memory", () => {
	it("spills Prime state to CAS and gives it generation-fenced Meaningful Object identity", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agent-memory-test-"));
		after(() => rmSync(dir, { recursive: true, force: true }));
		const runtime = new WorkflowRuntimeStore(join(dir, "runtime.sqlite"));
		await runtime.init();
		const memory = new AgentMemory(SophiaContentStore.fromUrl(pathToFileURL(join(dir, "cas")).toString()), runtime);
		const spec: AgentNodeSpec = {
			label: "memory",
			phaseIndex: 1,
			prompt: "remember",
			model: "mock:done",
			graphId: "g1",
			sessionId: "session-memory",
			sandboxGeneration: 0,
			invocationId: "activation-0",
			...makeTestAgentSemanticBinding({ graphId: "g1", kind: "prime", registeredName: "memory-agent" }),
		};
		await runtime.createWorkflowInstance({
			runId: "run-memory",
			workflowName: "wf",
			graphId: "g1",
			ownerUserId: "user:test",
			inputs: {},
			startedAt: 1,
		});
		const session = await runtime.beginAgentSession({
			sessionId: spec.sessionId!,
			runId: "run-memory",
			workflowName: "wf",
			graphId: "g1",
			ownerUserId: "user:test",
			graphOwnerPrincipal: "user:test",
			spec,
			nodeKey: "1:memory",
			frontier: { kind: "before-node", ts: 2 },
			now: 2,
		});
		await runtime.claimAgentMaterialization(spec.sessionId!, {
			generation: 0,
			activationId: "activation-0",
			now: 3,
		});
		await runtime.bindAgentSandbox(spec.sessionId!, {
			sandboxId: "sandbox-0",
			generation: 0,
			activationId: "activation-0",
			now: 4,
		});
		await runtime.beginAgentSessionKernelLaunch(spec.sessionId!, 0, {
			activationId: "activation-0",
			sandboxId: "kernel-sandbox-0",
			now: 4,
		});
		await runtime.bindAgentSessionKernelLaunch(spec.sessionId!, 0, {
			activationId: "activation-0",
			sandboxId: "kernel-sandbox-0",
			now: 4,
		});
		const document = JSON.parse(session.document_json) as {
			meaningfulObjects: { agentSession: MeaningfulObjectRefV1<"agent-session"> };
		};
		validateMeaningfulObjectRef(document.meaningfulObjects.agentSession, "agent-session");
		const state = primeState({
			sessionId: spec.sessionId!,
			sandboxId: "sandbox-0",
			generation: 0,
			runtimeBindingDigest: spec.runtimeBindingDigest!,
			ontologyBindingDigest: spec.ontologyBindingDigest!,
			workerSequence: 23,
			largeValue: `memory-payload:${"x".repeat(256 * 1024)}`,
		});
		const checkpoint = await memory.commitPrimeState({
			ownerPrincipal: "user:test",
			graphId: "g1",
			agentSession: document.meaningfulObjects.agentSession,
			state,
			runtimeBundle: spec.runtime!.bundle,
			causationId: "runtime.result:sandbox-0:0:23",
		});

		assert.equal(checkpoint.object.kind, "agent-checkpoint");
		assert.equal(checkpoint.manifest.generation, 0);
		assert.equal(checkpoint.manifest.sessionSequence, 0);
		assert.equal(checkpoint.manifest.workerSequence, 23);
		assert.equal(checkpoint.manifest.compatibility.runtimeBundleDigest, spec.runtime!.bundle.digest);
		assert.ok(checkpoint.manifest.state.bytes > 256 * 1024);
		assert.equal(checkpoint.manifest.stateDigest, state.digest);
		assert.deepEqual(await memory.restorePrimeState(checkpoint), state);
		const stored = await runtime.readAgentSession(spec.sessionId!);
		assert.ok(stored);
		assert.equal(
			stored.document_json.includes("memory-payload:"),
			false,
			"session projection must not embed CAS bytes",
		);

		await runtime.transitionAgentMaterialization(spec.sessionId!, 0, {
			activationId: "activation-0",
			from: "running",
			to: "quiescing",
			now: 5,
		});
		await runtime.transitionAgentMaterialization(spec.sessionId!, 0, {
			activationId: "activation-0",
			from: "quiescing",
			to: "quiescent",
			now: 6,
		});
		await runtime.recordAgentSessionKernelState(spec.sessionId!, 0, {
			activationId: "activation-0",
			state: "shutdown",
			now: 7,
		});
		await runtime.transitionAgentMaterialization(spec.sessionId!, 0, {
			activationId: "activation-0",
			from: "quiescent",
			to: "passivated",
			now: 8,
		});

		const claims = await Promise.allSettled([
			runtime.claimAgentMaterialization(spec.sessionId!, { generation: 1, activationId: "activation-1a", now: 9 }),
			runtime.claimAgentMaterialization(spec.sessionId!, { generation: 1, activationId: "activation-1b", now: 9 }),
		]);
		assert.equal(claims.filter((claim) => claim.status === "fulfilled").length, 1);
		assert.equal(claims.filter((claim) => claim.status === "rejected").length, 1);
		await assert.rejects(
			() =>
				runtime.appendAgentSessionEventForGeneration(spec.sessionId!, 0, "activation-0", {
					type: "message.delta",
				}),
			/not the latest live generation/,
		);

		writeFileSync(fileURLToPath(checkpoint.manifest.state.uri), "corrupt", "utf8");
		await assert.rejects(() => memory.restorePrimeState(checkpoint), /length does not match|digest does not match/);
		runtime.close();
	});
});

function primeState(input: {
	sessionId: string;
	sandboxId: string;
	generation: number;
	runtimeBindingDigest: string;
	ontologyBindingDigest: string;
	workerSequence: number;
	largeValue: string;
}): PrimeRuntimeStateV2 {
	const unsigned = {
		schema: PRIME_RUNTIME_STATE_SCHEMA,
		sessionId: input.sessionId,
		sandboxId: input.sandboxId,
		generation: input.generation,
		runtimeBindingDigest: input.runtimeBindingDigest,
		ontologyBindingDigest: input.ontologyBindingDigest,
		sessionHeader: { type: "session", version: 3, id: input.sessionId, cwd: "/workspace" },
		entries: [
			{
				type: "custom",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-08-07T00:00:00.000Z",
				data: input.largeValue,
			},
		],
		goal: null,
		autonomous: { enabled: false },
		workerSequence: input.workerSequence,
		createdAt: "2026-08-07T00:00:00.000Z",
	};
	return { ...unsigned, digest: `sha256:${canonicalDigest(unsigned)}` };
}
