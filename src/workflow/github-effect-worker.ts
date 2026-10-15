/** Credential-owning host edge for proposed GitHub writes. */

import { createHash } from "node:crypto";
import {
	DevelopmentEffectError,
	type DevelopmentGrantHost,
	developmentTerminal,
	type ValidatedDevelopmentHandoff,
	validateDevelopmentHandoff,
	verifyCurrentDevelopmentGrant,
} from "./development-effect.js";
import type { CommittedDevelopmentTarget, ProposedEffectV1 } from "./proposed-effect.js";
import type { EffectHandoffRecord, WorkflowRuntimeStore } from "./runtime-store.js";

export const GITHUB_EFFECT_COMPLETION_SCHEMA = "sophia.github-effect-completion.v1" as const;

const GITHUB_OPERATIONS = new Set(["branch.push", "pr.open", "pr.comment", "pr.merge"]);
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_PATH_MODE = new Set(["100644", "100755"]);

export interface GitHubFileChangeV1 {
	readonly path: string;
	readonly mode: "100644" | "100755";
	readonly delete?: true;
	readonly contentBase64?: string;
	readonly contentSha256?: string;
}

export interface GitHubEffectCompletionV1 {
	readonly schema: typeof GITHUB_EFFECT_COMPLETION_SCHEMA;
	readonly idempotencyKey: string;
	readonly operation: "branch.push" | "pr.open" | "pr.comment" | "pr.merge";
	readonly repository: string;
	readonly branchName: string;
	readonly scenarioDigest: string;
	readonly headSha?: string;
	readonly pullNumber?: number;
	readonly url?: string;
	readonly merged?: boolean;
	readonly replayed?: boolean;
}

export interface GitHubEffectHost extends DevelopmentGrantHost {
	pushBranch(input: {
		readonly target: CommittedDevelopmentTarget;
		readonly idempotencyKey: string;
		readonly message: string;
		readonly changes: readonly GitHubFileChangeV1[];
	}): Promise<{ readonly headSha: string; readonly url?: string; readonly replayed?: boolean }>;
	openPullRequest(input: {
		readonly target: CommittedDevelopmentTarget;
		readonly idempotencyKey: string;
		readonly title: string;
		readonly body: string;
	}): Promise<{
		readonly pullNumber: number;
		readonly headSha: string;
		readonly url: string;
		readonly replayed?: boolean;
	}>;
	commentPullRequest(input: {
		readonly target: CommittedDevelopmentTarget & { readonly pullNumber: number };
		readonly idempotencyKey: string;
		readonly body: string;
	}): Promise<{ readonly pullNumber: number; readonly url: string; readonly replayed?: boolean }>;
	mergePullRequest(input: {
		readonly target: CommittedDevelopmentTarget & {
			readonly pullNumber: number;
			readonly expectedHeadSha: string;
		};
		readonly idempotencyKey: string;
		readonly method: "merge" | "squash" | "rebase";
		readonly title?: string;
		readonly message?: string;
	}): Promise<{
		readonly pullNumber: number;
		readonly headSha: string;
		readonly url?: string;
		readonly merged: true;
		readonly replayed?: boolean;
	}>;
	close?(): Promise<void>;
}

export function validateGitHubHandoff(record: EffectHandoffRecord): ValidatedDevelopmentHandoff {
	return validateDevelopmentHandoff(record, { capability: "github", operations: GITHUB_OPERATIONS });
}

export class GitHubEffectExecutor {
	constructor(private readonly host: GitHubEffectHost) {}

	async execute(handoff: ValidatedDevelopmentHandoff): Promise<GitHubEffectCompletionV1> {
		const base = {
			schema: GITHUB_EFFECT_COMPLETION_SCHEMA,
			idempotencyKey: handoff.record.idempotency_key,
			operation: handoff.record.operation as GitHubEffectCompletionV1["operation"],
			repository: handoff.target.repository,
			branchName: handoff.target.branchName,
			scenarioDigest: handoff.target.scenarioDigest,
		};
		switch (handoff.record.operation) {
			case "branch.push": {
				const changes = parseChanges(handoff.proposal);
				const message = boundedText(handoff.proposal.arguments.commitMessage, "commitMessage", 256);
				const result = await this.host.pushBranch({
					target: handoff.target,
					idempotencyKey: handoff.record.idempotency_key,
					message,
					changes,
				});
				return { ...base, ...result };
			}
			case "pr.open": {
				const result = await this.host.openPullRequest({
					target: handoff.target,
					idempotencyKey: handoff.record.idempotency_key,
					title: boundedText(handoff.proposal.arguments.title, "title", 256),
					body: optionalBoundedText(handoff.proposal.arguments.body, "body", 65_536) ?? "",
				});
				return { ...base, ...result };
			}
			case "pr.comment": {
				const target = requirePullTarget(handoff.target);
				const result = await this.host.commentPullRequest({
					target,
					idempotencyKey: handoff.record.idempotency_key,
					body: boundedText(handoff.proposal.arguments.body, "body", 65_536),
				});
				return { ...base, ...result };
			}
			case "pr.merge": {
				const target = requireMergeTarget(handoff.target);
				const method = handoff.proposal.arguments.mergeMethod ?? "squash";
				if (method !== "merge" && method !== "squash" && method !== "rebase") {
					throw developmentTerminal("github-merge-method-invalid");
				}
				const result = await this.host.mergePullRequest({
					target,
					idempotencyKey: handoff.record.idempotency_key,
					method,
					...(handoff.proposal.arguments.title !== undefined
						? { title: boundedText(handoff.proposal.arguments.title, "title", 256) }
						: {}),
					...(handoff.proposal.arguments.message !== undefined
						? { message: boundedText(handoff.proposal.arguments.message, "message", 65_536) }
						: {}),
				});
				return { ...base, ...result };
			}
			default:
				throw developmentTerminal("github-operation-invalid");
		}
	}
}

export class GitHubEffectWorker {
	private timer: ReturnType<typeof setInterval> | undefined;
	private active: Promise<boolean> | undefined;
	private closed = false;

	constructor(
		private readonly runtime: WorkflowRuntimeStore,
		private readonly host: GitHubEffectHost,
		private readonly executor = new GitHubEffectExecutor(host),
		private readonly options: {
			readonly consumer?: string;
			readonly pollMs?: number;
			readonly leaseMs?: number;
			readonly now?: () => number;
			readonly log?: (message: string, error?: unknown) => void;
		} = {},
	) {}

	start(): void {
		if (this.timer || this.closed) return;
		const pollMs = positiveInteger(this.options.pollMs ?? 1_000, "GitHub effect poll interval");
		this.timer = setInterval(() => this.schedule(), pollMs);
		this.timer.unref?.();
		this.schedule();
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.active?.catch(() => {});
		await this.host.close?.();
	}

	async runOnce(): Promise<boolean> {
		const now = this.options.now?.() ?? Date.now();
		const consumer = this.options.consumer ?? "choreograph-github-edge";
		const record = await this.runtime.claimEffectHandoff({
			consumer,
			capabilities: ["github"],
			leaseMs: positiveInteger(this.options.leaseMs ?? 60_000, "GitHub effect lease"),
			now,
		});
		if (!record) return false;
		try {
			const handoff = validateGitHubHandoff(record);
			await verifyCurrentDevelopmentGrant(this.host, handoff, this.options.now?.() ?? Date.now());
			const completion = await this.executor.execute(handoff);
			await this.runtime.completeEffectHandoff({
				idempotencyKey: record.idempotency_key,
				consumer,
				claimToken: requiredClaimToken(record),
				outcome: "executed",
				completion,
				now: this.options.now?.() ?? Date.now(),
			});
		} catch (error) {
			const failure =
				error instanceof DevelopmentEffectError ? error : new DevelopmentEffectError("github-host-failure", true);
			try {
				await this.runtime.completeEffectHandoff({
					idempotencyKey: record.idempotency_key,
					consumer,
					claimToken: requiredClaimToken(record),
					outcome: failure.retryable ? "failed-retryable" : "failed-terminal",
					completion: { schema: GITHUB_EFFECT_COMPLETION_SCHEMA, code: failure.code },
					...(failure.retryable ? { retryAfterMs: retryDelay(record.attempt) } : {}),
					now: this.options.now?.() ?? Date.now(),
				});
			} catch (completionError) {
				this.options.log?.("GitHub effect completion could not be persisted", completionError);
			}
		}
		return true;
	}

	private schedule(): void {
		if (this.closed || this.active) return;
		this.active = this.runOnce()
			.catch((error) => this.options.log?.("GitHub effect worker recovered from a poll failure", error))
			.then(() => true)
			.finally(() => {
				this.active = undefined;
			});
	}
}

function parseChanges(proposal: ProposedEffectV1): GitHubFileChangeV1[] {
	const value = proposal.arguments.changes;
	if (!Array.isArray(value) || !value.length || value.length > 64) {
		throw developmentTerminal("github-changes-invalid");
	}
	const paths = new Set<string>();
	let totalBytes = 0;
	return value.map((entry) => {
		if (!isRecord(entry)) throw developmentTerminal("github-changes-invalid");
		const path = safePath(entry.path);
		if (paths.has(path)) throw developmentTerminal("github-change-path-duplicate");
		paths.add(path);
		const mode = entry.mode ?? "100644";
		if (typeof mode !== "string" || !SAFE_PATH_MODE.has(mode)) {
			throw developmentTerminal("github-change-mode-invalid");
		}
		if (entry.delete === true) {
			if (entry.contentBase64 !== undefined || entry.contentSha256 !== undefined) {
				throw developmentTerminal("github-delete-content-invalid");
			}
			return { path, mode: mode as GitHubFileChangeV1["mode"], delete: true };
		}
		if (typeof entry.contentBase64 !== "string" || typeof entry.contentSha256 !== "string") {
			throw developmentTerminal("github-change-content-missing");
		}
		const content = decodeCanonicalBase64(entry.contentBase64);
		totalBytes += content.byteLength;
		if (totalBytes > 1_048_576) throw developmentTerminal("github-change-content-too-large");
		if (!SHA256.test(entry.contentSha256) || sha256Bytes(content) !== entry.contentSha256) {
			throw developmentTerminal("github-change-content-digest-mismatch");
		}
		return {
			path,
			mode: mode as GitHubFileChangeV1["mode"],
			contentBase64: entry.contentBase64,
			contentSha256: entry.contentSha256,
		};
	});
}

function requirePullTarget(
	target: CommittedDevelopmentTarget,
): CommittedDevelopmentTarget & { readonly pullNumber: number } {
	if (target.pullNumber === undefined) throw developmentTerminal("github-pr-target-missing");
	return target as CommittedDevelopmentTarget & { readonly pullNumber: number };
}

function requireMergeTarget(target: CommittedDevelopmentTarget): CommittedDevelopmentTarget & {
	readonly pullNumber: number;
	readonly expectedHeadSha: string;
} {
	if (target.pullNumber === undefined || !target.expectedHeadSha) {
		throw developmentTerminal("github-merge-target-missing");
	}
	return target as CommittedDevelopmentTarget & { readonly pullNumber: number; readonly expectedHeadSha: string };
}

function boundedText(value: unknown, label: string, maximum: number): string {
	if (typeof value !== "string" || !value.trim() || value.length > maximum || value.includes("\0")) {
		throw developmentTerminal("github-proposal-invalid", new Error(`${label} must be 1-${maximum} safe characters`));
	}
	return value;
}

function optionalBoundedText(value: unknown, label: string, maximum: number): string | undefined {
	if (value === undefined) return undefined;
	return boundedText(value, label, maximum);
}

function safePath(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 1_024 || value.startsWith("/") || value.includes("\\")) {
		throw developmentTerminal("github-change-path-invalid");
	}
	const segments = value.split("/");
	if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes("\0"))) {
		throw developmentTerminal("github-change-path-invalid");
	}
	return value;
}

function decodeCanonicalBase64(value: string): Buffer {
	if (
		!value ||
		value.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
	) {
		throw developmentTerminal("github-change-content-invalid-base64");
	}
	const decoded = Buffer.from(value, "base64");
	if (decoded.toString("base64") !== value) throw developmentTerminal("github-change-content-invalid-base64");
	return decoded;
}

function requiredClaimToken(record: EffectHandoffRecord): string {
	if (!record.claim_token) throw new Error("GitHub effect lease has no claim token");
	return record.claim_token;
}

function retryDelay(attempt: number): number {
	return Math.min(3_600_000, 1_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 11));
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
	return value;
}

function sha256Bytes(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
