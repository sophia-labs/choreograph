import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { validateMeaningfulObjectRef } from "../agent-runtime/meaningful-object.js";
import { WorkflowCapabilityBackend } from "../capabilities/workflow.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";

describe("ontological workflow capability", () => {
	it("lets a granted Agent Session inspect, claim an empty lease, and CAS-propose a bounded amendment", async () => {
		const dir = mkdtempSync(join(tmpdir(), "workflow-capability-"));
		const runtime = new WorkflowRuntimeStore(join(dir, "runtime.sqlite"));
		after(() => rmSync(dir, { recursive: true, force: true }));
		await runtime.init();
		await runtime.createWorkflowInstance({
			runId: "run-ontology",
			workflowName: "ontological-workflow",
			graphId: "sophia-code-lab",
			ownerUserId: "ada",
			inputs: {},
			startedAt: 100,
		});
		let clock = 1000;
		const backend = new WorkflowCapabilityBackend({
			runtime,
			runId: "run-ontology",
			graphId: "sophia-code-lab",
			ownerPrincipal: "user:ada",
			agentId: "agent-ontology",
			sessionId: "session-ontology",
			nodeKey: "node-attend",
			ontologyBindingDigest: `sha256:${"b".repeat(64)}`,
			allowedTools: ["inspect", "claim_driver", "release_driver", "propose_amendment"],
			now: () => clock++,
		});

		assert.deepEqual(
			(await backend.listTools()).map((tool) => tool.name),
			["inspect", "claim_driver", "release_driver", "propose_amendment"],
		);
		const inspection = (await backend.callTool("inspect", {})) as Record<string, unknown>;
		validateMeaningfulObjectRef(inspection.object, "workflow");

		const unclaimed = (await backend.callTool("propose_amendment", {
			amendment_id: "directive-next",
			kind: "directive",
			payload: { text: "Attend to the newly observed object." },
			expected_revision: 0,
			lease_epoch: 1,
		})) as Record<string, unknown>;
		assert.equal(unclaimed.applied, false);
		assert.equal(unclaimed.reason, "not_driver");

		const claimed = (await backend.callTool("claim_driver", { expected_revision: 0 })) as Record<string, unknown>;
		assert.equal(claimed.applied, true);
		validateMeaningfulObjectRef(claimed.object, "workflow");

		const proposed = (await backend.callTool("propose_amendment", {
			amendment_id: "directive-next",
			kind: "directive",
			payload: { text: "Attend to the newly observed object." },
			expected_revision: 1,
			lease_epoch: 1,
		})) as Record<string, unknown>;
		assert.equal(proposed.applied, true);
		validateMeaningfulObjectRef(proposed.object, "workflow-amendment");
		const control = await runtime.getWorkflowControl("run-ontology");
		assert.equal(control?.revision, 2);
		assert.equal(control?.amendments[0]?.id, "directive-next");
		assert.equal(control?.amendments[0]?.state, "pending");

		await assert.rejects(
			() =>
				backend.callTool("propose_amendment", {
					amendment_id: "widen-grant",
					kind: "reparameterize",
					payload: { parameters: { toolGrant: "admin" } },
					expected_revision: 2,
					lease_epoch: 1,
				}),
			/cannot mutate authority field 'toolGrant'/,
		);
		runtime.close();
	});

	it("never lets an Agent Session displace an existing driver", async () => {
		const dir = mkdtempSync(join(tmpdir(), "workflow-capability-driver-"));
		const runtime = new WorkflowRuntimeStore(join(dir, "runtime.sqlite"));
		after(() => rmSync(dir, { recursive: true, force: true }));
		await runtime.init();
		await runtime.createWorkflowInstance({
			runId: "run-driver",
			workflowName: "wf",
			graphId: "g1",
			ownerUserId: "u1",
			inputs: {},
			startedAt: 1,
		});
		await runtime.claimWorkflowDriver("run-driver", {
			clientId: "vehicle-human",
			now: 2,
			claimTs: 2,
			expectedRevision: 0,
		});
		const backend = new WorkflowCapabilityBackend({
			runtime,
			runId: "run-driver",
			graphId: "g1",
			ownerPrincipal: "user:u1",
			agentId: "agent-a",
			sessionId: "session-a",
			allowedTools: ["claim_driver"],
			now: () => 9999,
		});
		const result = (await backend.callTool("claim_driver", { expected_revision: 1 })) as Record<string, unknown>;
		assert.equal(result.applied, false);
		assert.equal(result.reason, "not_driver");
		assert.equal((await runtime.getWorkflowControl("run-driver"))?.driverLease?.holder, "vehicle-human");
		runtime.close();
	});
});
