import { createMeaningfulObjectRef } from "../agent-runtime/meaningful-object.js";
import type { PhanesPrivacyRetirementHandler } from "../internal-jobs/server.js";
import type { JournalStore } from "../workflow/journal-store.js";
import type { PhanesPrivacyRetirementScope, WorkflowRuntimeStore } from "../workflow/runtime-store.js";

const TERMINAL = new Set(["completed", "failed", "stopped", "paused"]);

/** Serializes accepted Phanes triggers against an epoch retirement barrier. */
export class PhanesPrivacyEpochGate {
	private tail: Promise<unknown> = Promise.resolve();
	private activeEpochId?: string;

	async submit<T>(epochId: string, operation: () => Promise<T>): Promise<T> {
		return this.serial(async () => {
			if (this.activeEpochId !== undefined && this.activeEpochId !== epochId) {
				throw new Error("Phanes trigger targets a retired privacy epoch");
			}
			this.activeEpochId = epochId;
			return operation();
		});
	}

	async retire<T>(activeEpochId: string, operation: () => Promise<T>): Promise<T> {
		return this.serial(async () => {
			// Install the deny-old barrier before inventorying. It remains installed
			// even if cleanup fails, so a failed retirement is fail-closed.
			this.activeEpochId = activeEpochId;
			return operation();
		});
	}

	private serial<T>(operation: () => Promise<T>): Promise<T> {
		const run = this.tail.then(operation, operation);
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}
}

export function createPhanesPrivacyRetirementHandler(options: {
	gate: PhanesPrivacyEpochGate;
	runtime: WorkflowRuntimeStore;
	journal: JournalStore;
	spawner: {
		kill(sandboxId: string): Promise<unknown>;
		bus?: { cleanup(sandboxId: string): void };
	};
	sandboxStore: { purgeSandboxes(sandboxIds: readonly string[]): number };
	scope: Omit<PhanesPrivacyRetirementScope, "activeEpochId">;
	now?: () => number;
	wait?: (milliseconds: number) => Promise<void>;
}): PhanesPrivacyRetirementHandler {
	const now = options.now ?? Date.now;
	const wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
	return {
		retire(activeEpochId) {
			return options.gate.retire(activeEpochId, async () => {
				const scope: PhanesPrivacyRetirementScope = { ...options.scope, activeEpochId };
				const deadline = now() + 240_000;
				let plan = await options.runtime.planPhanesPrivacyEpochRetirement(scope);
				while (plan.retiredRunIds.length > 0) {
					for (const runId of plan.retiredRunIds) {
						await options.runtime.requestPause(runId, {
							reason: "privacy-epoch-retirement",
							now: now(),
						});
					}
					for (const sandboxId of plan.sandboxIds) {
						await options.spawner.kill(sandboxId).catch(() => undefined);
					}
					let statuses = await Promise.all(
						plan.retiredRunIds.map((runId) => options.runtime.getWorkflowInstance(runId)),
					);
					// A restored runtime record may have no live workflow driver left to
					// acknowledge the pause request. Once every known sandbox has been
					// terminated, the privacy barrier itself is the authority to adjudicate
					// any such non-terminal testimony as stopped. This durable transition is
					// deliberately scoped to retired epoch runs; active-epoch work is never
					// terminalized here.
					await Promise.all(
						statuses.map((record, index) => {
							if (record === null || TERMINAL.has(record.status)) return Promise.resolve();
							return options.runtime.markWorkflowFinished(plan.retiredRunIds[index], {
								status: "stopped",
								endedAt: now(),
							});
						}),
					);
					statuses = await Promise.all(
						plan.retiredRunIds.map((runId) => options.runtime.getWorkflowInstance(runId)),
					);
					if (statuses.every((record) => record === null || TERMINAL.has(record.status))) break;
					if (now() >= deadline) throw new Error("timed out retiring active Phanes privacy sandboxes");
					await wait(100);
					plan = await options.runtime.planPhanesPrivacyEpochRetirement(scope);
				}

				const finalPlan = await options.runtime.planPhanesPrivacyEpochRetirement(scope);
				const allJournalRunIds = await options.journal.listScopedRunIds({
					workflowName: scope.workflowName,
					graphId: scope.homeGraphId,
					ownerUserId: scope.ownerUserId,
				});
				const activeRuns = new Set(finalPlan.activeRunIds);
				const retiredJournalRunIds = allJournalRunIds.filter((runId) => !activeRuns.has(runId));
				for (const sandboxId of finalPlan.sandboxIds) options.spawner.bus?.cleanup(sandboxId);
				const retiredSandboxes = options.sandboxStore.purgeSandboxes(finalPlan.sandboxIds);
				const runtimeReceipt = await options.runtime.purgePhanesPrivacyEpochs(scope);
				const retiredJournalRuns = await options.journal.purgeRuns(retiredJournalRunIds);
				await options.runtime.secureVacuum();
				await options.journal.secureVacuum();
				const [runtimeSnapshots, journalSnapshots] = await Promise.all([
					options.runtime.replaceS3SnapshotHistory(),
					options.journal.replaceS3SnapshotHistory(),
				]);
				const retiredRunIds = [...new Set([...runtimeReceipt.retiredRunIds, ...retiredJournalRunIds])].sort();
				const projection = {
					activeEpochId,
					retiredRunIds,
					retiredSourceTurnCount: runtimeReceipt.retiredSourceTurnCount,
					retiredEffectCount: runtimeReceipt.retiredEffectCount,
					retiredAgentSessionCount: runtimeReceipt.retiredAgentSessionCount,
					retiredSandboxCount: retiredSandboxes,
					retiredJournalRuns,
					retiredSnapshotVersions: runtimeSnapshots.retiredVersions + journalSnapshots.retiredVersions,
				};
				return {
					schema: "sophia.privacy-epoch-retirement-receipt.v1",
					object: createMeaningfulObjectRef({
						kind: "privacy-runtime-retirement-receipt",
						ownerPrincipal: "service:choreograph",
						graphId: scope.homeGraphId,
						objectId: `urn:choreograph:privacy-epoch-retirement:${activeEpochId}`,
						version: activeEpochId,
						value: projection,
					}),
					...projection,
					retiredRunCount: retiredRunIds.length,
					retiredSnapshotCount:
						Number(runtimeSnapshots.snapshotUrl !== null) + Number(journalSnapshots.snapshotUrl !== null),
				};
			});
		},
	};
}
