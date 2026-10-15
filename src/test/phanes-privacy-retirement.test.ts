import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createPhanesPrivacyRetirementHandler, PhanesPrivacyEpochGate } from "../privacy/phanes-epoch-retirement.js";
import { JournalStore } from "../workflow/journal-store.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import { DOMAIN_AGENT_ACTIVITY_LOOP_NAME } from "../workflow/script-domain-agent-activity-loop.js";

const OLD_EPOCH = "1".repeat(32);
const ACTIVE_EPOCH = "2".repeat(32);

function inputs(epochId: string): Record<string, unknown> {
	return {
		schemaInput: {
			trigger: {
				datasetEpoch: {
					epochId,
					graphId: "phanes-social",
				},
			},
		},
	};
}

describe("Phanes privacy epoch retirement", () => {
	it("terminalizes a restored retired run that has no live workflow driver", async () => {
		const root = mkdtempSync(join(tmpdir(), "phanes-privacy-orphan-retirement-"));
		after(() => rmSync(root, { recursive: true, force: true }));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		const journal = new JournalStore(join(root, "journal.sqlite"));
		await runtime.init();
		await journal.init();
		await runtime.createWorkflowInstance({
			runId: "wfr-restored-orphan",
			workflowName: DOMAIN_AGENT_ACTIVITY_LOOP_NAME,
			graphId: "phanes",
			ownerUserId: "phanes-user",
			inputs: inputs(OLD_EPOCH),
			startedAt: 1,
		});
		await journal.createRun({
			run_id: "wfr-restored-orphan",
			workflow_name: DOMAIN_AGENT_ACTIVITY_LOOP_NAME,
			graph_id: "phanes",
			owner_user_id: "phanes-user",
			status: "running",
			started_at: 1,
		});
		await journal.appendEvent("wfr-restored-orphan", { type: "run_started", ts: 1 });

		const terminalized: Array<{ runId: string; status: string }> = [];
		const markWorkflowFinished = runtime.markWorkflowFinished.bind(runtime);
		runtime.markWorkflowFinished = async (runId, input) => {
			terminalized.push({ runId, status: input.status });
			await markWorkflowFinished(runId, input);
		};
		const handler = createPhanesPrivacyRetirementHandler({
			gate: new PhanesPrivacyEpochGate(),
			runtime,
			journal,
			spawner: { async kill() {} },
			sandboxStore: { purgeSandboxes: () => 0 },
			scope: {
				homeGraphId: "phanes",
				ownerUserId: "phanes-user",
				graphOwnerPrincipal: "user:phanes-owner",
				workflowName: DOMAIN_AGENT_ACTIVITY_LOOP_NAME,
			},
			now: () => 10,
			wait: async () => {
				throw new Error("a driverless restored run must not enter the acknowledgement wait loop");
			},
		});

		const receipt = await handler.retire(ACTIVE_EPOCH);
		assert.deepEqual(terminalized, [{ runId: "wfr-restored-orphan", status: "stopped" }]);
		assert.equal(receipt.retiredRunCount, 1);
		assert.equal(await runtime.getWorkflowInstance("wfr-restored-orphan"), null);
		assert.equal((await journal.readRun("wfr-restored-orphan")).header, null);

		runtime.close();
		journal.close();
	});

	it("purges old runtime/journal testimony and installs a deny-old barrier", async () => {
		const root = mkdtempSync(join(tmpdir(), "phanes-privacy-retirement-"));
		after(() => rmSync(root, { recursive: true, force: true }));
		const runtime = new WorkflowRuntimeStore(join(root, "runtime.sqlite"));
		const journal = new JournalStore(join(root, "journal.sqlite"));
		await runtime.init();
		await journal.init();
		for (const [runId, epochId] of [
			["wfr-old", OLD_EPOCH],
			["wfr-active", ACTIVE_EPOCH],
		] as const) {
			await runtime.createWorkflowInstance({
				runId,
				workflowName: DOMAIN_AGENT_ACTIVITY_LOOP_NAME,
				graphId: "phanes",
				ownerUserId: "phanes-user",
				inputs: inputs(epochId),
				startedAt: 1,
			});
			await runtime.markWorkflowFinished(runId, { status: "completed", endedAt: 2 });
			await runtime.bindPhanesPrivacyEpochRun({
				runId,
				epochId,
				datasetGraphId: "phanes-social",
				sourceEventRef: `urn:phanes:dataset-epoch:${epochId}:source-event:01ARZ3NDEKTSV4RRFFQ69G5FAV`,
				datasetEpoch: {
					epochId,
					graphId: "phanes-social",
				},
				now: 2,
			});
			await runtime.bindPhanesPrivacyEpochRun({
				runId,
				epochId,
				datasetGraphId: "phanes-social",
				sourceEventRef: `urn:phanes:dataset-epoch:${epochId}:source-event:01ARZ3NDEKTSV4RRFFQ69G5FAV`,
				datasetEpoch: {
					epochId,
					graphId: "phanes-social",
				},
				now: 3,
			});
			await journal.createRun({
				run_id: runId,
				workflow_name: DOMAIN_AGENT_ACTIVITY_LOOP_NAME,
				graph_id: "phanes",
				owner_user_id: "phanes-user",
				status: "completed",
				started_at: 1,
			});
			await journal.appendEvent(runId, { type: "run_started", ts: 1 });
		}
		const gate = new PhanesPrivacyEpochGate();
		const sandboxPurgeBatches: string[][] = [];
		const handler = createPhanesPrivacyRetirementHandler({
			gate,
			runtime,
			journal,
			spawner: { async kill() {} },
			sandboxStore: {
				purgeSandboxes(sandboxIds) {
					sandboxPurgeBatches.push([...sandboxIds]);
					return sandboxIds.length;
				},
			},
			scope: {
				homeGraphId: "phanes",
				ownerUserId: "phanes-user",
				graphOwnerPrincipal: "user:phanes-owner",
				workflowName: DOMAIN_AGENT_ACTIVITY_LOOP_NAME,
			},
		});

		const receipt = await handler.retire(ACTIVE_EPOCH);
		assert.equal(receipt.schema, "sophia.privacy-epoch-retirement-receipt.v1");
		assert.equal(receipt.retiredRunCount, 1);
		assert.equal(await runtime.getWorkflowInstance("wfr-old"), null);
		assert.ok(await runtime.getWorkflowInstance("wfr-active"));
		assert.equal((await journal.readRun("wfr-old")).header, null);
		assert.ok((await journal.readRun("wfr-active")).header);
		assert.deepEqual(sandboxPurgeBatches, [[]]);
		await assert.rejects(
			gate.submit(OLD_EPOCH, async () => "no"),
			/retired privacy epoch/,
		);
		assert.equal(await gate.submit(ACTIVE_EPOCH, async () => "yes"), "yes");

		runtime.close();
		journal.close();
	});
});
