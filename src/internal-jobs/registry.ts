import type { ResourceConfig } from "../sandbox-store.js";
import type { PrivateSandboxMount, TemplateId } from "../templates.js";
import type { InternalStageJob, InternalStageKind, InternalStageSubmission } from "./contracts.js";

export interface InternalStageAttemptPlan {
	template: TemplateId;
	privateMounts: readonly PrivateSandboxMount[];
	resources: ResourceConfig;
	timeoutMs: number;
	workerConfig: Record<string, unknown>;
}

export interface InternalStagePromotion {
	resultDigest: string;
	metrics?: Record<string, number>;
}

export interface InternalStageDriver {
	readonly stage: InternalStageKind;
	readonly maxAttempts: number;
	initialModel(submission: InternalStageSubmission): string;
	retryModel(job: InternalStageJob, nextAttempt: number): string;
	validateSubmission(submission: InternalStageSubmission): Promise<void>;
	prepareAttempt(job: InternalStageJob): Promise<InternalStageAttemptPlan>;
	validateAndPromote(job: InternalStageJob): Promise<InternalStagePromotion>;
}

export class InternalStageRegistry {
	private readonly drivers = new Map<InternalStageKind, InternalStageDriver>();

	register(driver: InternalStageDriver): void {
		if (this.drivers.has(driver.stage)) {
			throw new Error(`Internal stage driver already registered: ${driver.stage}`);
		}
		this.drivers.set(driver.stage, driver);
	}

	require(stage: InternalStageKind): InternalStageDriver {
		const driver = this.drivers.get(stage);
		if (!driver) {
			throw new Error(`No internal stage driver registered for ${stage}`);
		}
		return driver;
	}
}
