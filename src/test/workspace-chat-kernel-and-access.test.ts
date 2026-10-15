/**
 * Two facts about `workspace-chat-v1` the host states and keeps (exam 1, finding 8; the SPA body's F2):
 *
 * - The chat has no persistent kernel. Its prompt says it cannot run code, and it inherited `allowPersistentKernel:
 *   true` from the Prime baseline. The binding the worker is initialized with now says false, and the host refuses
 *   every kernel operation for it, so no kernel tool can work for the model whatever a worker offered.
 * - The registry says, per role, whether the chat writes (`host.access`), from the same rule that binds the mode, so a
 *   client need not infer it from digests.
 *
 * The whole invocation path: real cell, real stores, real spawner (`useInvocationHarness`).
 */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { describe, it } from "node:test";
import { PRIME_HOST_PROTOCOL_VERSION, type PrimeWorkerRequestV1 } from "../agent-runtime/host-protocol.js";
import { listWorkflows } from "../workflow/registry.js";
import {
	buildWorkspaceChatInputs,
	WORKSPACE_CHAT_RUNTIME_CONSTRAINTS,
	WORKSPACE_CHAT_WORKFLOW_NAME,
	workspaceChatHostFacts,
} from "../workflow/workspace-chat.js";
import { useInvocationHarness } from "./chat-runtime-fixture.js";

const ANGELS_EDITOR = { "x-graph-id": "angels", "x-graph-owner": "user:owner-1", "x-sophia-graph-role": "editor" };

describe("exam 1, finding 8: the workspace chat has no persistent kernel", () => {
	const h = useInvocationHarness();

	it("binds a runtime that grants no kernel, for every role", () => {
		assert.equal(WORKSPACE_CHAT_RUNTIME_CONSTRAINTS.allowPersistentKernel, false);
		for (const role of ["owner", "editor", "viewer"] as const) {
			const inputs = buildWorkspaceChatInputs({
				graphId: "angels",
				graphOwnerPrincipal: "user:owner-1",
				request: { text: "hi", trigger: { kind: "m", text: "hi" }, contextRefs: [] },
				runtimeBundle: { id: "sophia-agent-runtime", digest: "a".repeat(64) },
				role,
			});
			const pilot = (inputs.args as { pilot: { runtime: { constraints: { allowPersistentKernel: boolean } } } })
				.pilot;
			assert.equal(pilot.runtime.constraints.allowPersistentKernel, false, role);
		}
	});

	it("initializes the worker with that binding, and refuses every kernel operation the worker asks for", async () => {
		const started = await h.post(h.chat("c2chat.inv.kernel-1"), ANGELS_EDITOR);
		assert.equal(started.statusCode, 202, started.body);
		const session = await h.waitForSession(started.json.runId);
		const spawned = (await h.waitForSpawn(session.session_id)) as unknown as {
			session_id: string;
			generation: number;
			runtime_binding: { constraints: { allowPersistentKernel: boolean } };
		};
		assert.equal(spawned.runtime_binding.constraints.allowPersistentKernel, false);

		// What a worker that offered the model a kernel tool anyway would get from the host: a refusal, nothing run.
		for (const operation of ["acquire", "execute"] as const) {
			const responses: Record<string, unknown>[] = [];
			const child = {
				stdin: {
					write(line: string) {
						responses.push(JSON.parse(line) as Record<string, unknown>);
						return true;
					},
				},
			} as unknown as ChildProcess;
			const request = {
				protocol: PRIME_HOST_PROTOCOL_VERSION,
				messageId: `worker.request:sb-kernel:${spawned.generation}:${operation}`,
				sessionId: spawned.session_id,
				sandboxId: "sb-kernel",
				generation: spawned.generation,
				correlationId: `kernel-${operation}`,
				direction: "worker_to_host",
				kind: "request",
				workerSequence: 0,
				name: "kernel.request",
				payload: { requestId: `kernel-${operation}`, operation, code: "print(1)" },
			} satisfies Extract<PrimeWorkerRequestV1, { name: "kernel.request" }>;
			await (
				h.spawner as unknown as {
					handleKernelRequest(request: unknown, child: ChildProcess, active: unknown): Promise<void>;
				}
			).handleKernelRequest(request, child, {
				record: { sandbox_id: "sb-kernel", template: "agent", state: "running" },
				isAgentRun: true,
				agentRequest: spawned,
				nextHostResponseId: 0,
			});
			assert.equal(responses.length, 1, operation);
			assert.equal(responses[0]?.ok, false, operation);
			assert.equal((responses[0]?.error as { code?: string } | undefined)?.code, "kernel_not_granted", operation);
		}
	});
});

describe("the SPA body's F2: the registry says whether the chat writes, per role", () => {
	it("advertises host.access from the rule that binds the mode", () => {
		const entry = listWorkflows().find((workflow) => workflow.name === WORKSPACE_CHAT_WORKFLOW_NAME) as
			| ({ host?: { access?: unknown } } & Record<string, unknown>)
			| undefined;
		assert.deepEqual(entry?.host?.access, { owner: "write", editor: "write", viewer: "read" });
		assert.deepEqual(workspaceChatHostFacts({}).access, { owner: "write", editor: "write", viewer: "read" });
	});
});
