/** Hosted cloud-2 transport for the Phanes-standard GitHub effect worker. */

import { HostedMnemosyneProxy, type HostedServiceAuthConfig } from "../mnemosyne.js";
import { developmentRetryable, developmentTerminal } from "./development-effect.js";
import { type GitHubEffectHost, GitHubEffectWorker, type GitHubFileChangeV1 } from "./github-effect-worker.js";
import { type GraphWriter, makeHostedGraphWriter } from "./graph-writer.js";
import type { CommittedDevelopmentTarget } from "./proposed-effect.js";
import type { EffectHandoffRecord, WorkflowRuntimeStore } from "./runtime-store.js";

const USER_PRINCIPAL = /^user:([A-Za-z0-9_.@:-]{1,192})$/;
const GRAPH_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface HostedGitHubEffectConfig {
	readonly gatewayBaseUrl: string;
	readonly serviceToken: string;
	readonly githubToken: string;
	readonly githubApiBaseUrl?: string;
	readonly requestTimeoutMs?: number;
	readonly fetchFn?: typeof fetch;
}

interface GitHubRef {
	readonly sha: string;
}

interface GitHubCommit {
	readonly sha: string;
	readonly treeSha: string;
	readonly message: string;
	readonly url?: string;
}

interface GitHubPull {
	readonly number: number;
	readonly state: string;
	readonly merged: boolean;
	readonly headSha: string;
	readonly headRef: string;
	readonly baseRef: string;
	readonly body: string;
	readonly url: string;
	readonly mergeCommitSha?: string;
}

interface HostedGraphHandle {
	readonly proxy: HostedMnemosyneProxy;
	readonly writer: GraphWriter;
}

export class HostedGitHubEffectHost implements GitHubEffectHost {
	private readonly gatewayBaseUrl: string;
	private readonly githubApiBaseUrl: string;
	private readonly fetchFn: typeof fetch;
	private readonly requestTimeoutMs: number;
	private readonly grantHandles = new Map<string, Promise<HostedGraphHandle>>();

	constructor(private readonly config: HostedGitHubEffectConfig) {
		this.gatewayBaseUrl = normalizeOrigin(config.gatewayBaseUrl, "GitHub grant gateway");
		this.githubApiBaseUrl = normalizeOrigin(config.githubApiBaseUrl ?? "https://api.github.com", "GitHub API");
		if (!config.serviceToken.trim()) throw new Error("GitHub effect service token is empty");
		if (!config.githubToken.trim()) throw new Error("GitHub effect token is empty");
		this.fetchFn = config.fetchFn ?? fetch;
		this.requestTimeoutMs = positiveInteger(config.requestTimeoutMs ?? 60_000, "GitHub request timeout");
	}

	async readGrant(record: EffectHandoffRecord): Promise<string> {
		const actorSub = requireUserPrincipal(record.grant_authority_owner_principal, "grant authority owner");
		const handle = await this.grantGraph(
			record.grant_authority_owner_principal,
			record.grant_authority_graph_id,
			actorSub,
		);
		const document = await handle.writer.readDocument(record.grant_authority_graph_id, record.grant_document_id, {
			format: "markdown",
		});
		if (!document.text?.trim()) throw developmentRetryable("github-grant-document-empty");
		return document.text;
	}

	async pushBranch(input: {
		readonly target: CommittedDevelopmentTarget;
		readonly idempotencyKey: string;
		readonly message: string;
		readonly changes: readonly GitHubFileChangeV1[];
	}): Promise<{ readonly headSha: string; readonly url?: string; readonly replayed?: boolean }> {
		const marker = effectMarker(input.idempotencyKey);
		const current = await this.readRef(input.target.repository, input.target.branchName);
		if (current && current.sha !== input.target.sourceRevision) {
			const commit = await this.readCommit(input.target.repository, current.sha);
			if (commit.message.includes(marker)) {
				return { headSha: commit.sha, ...(commit.url ? { url: commit.url } : {}), replayed: true };
			}
			throw developmentTerminal("github-branch-moved");
		}
		if (!current) {
			const base = await this.readRef(input.target.repository, input.target.baseBranch);
			if (!base || base.sha !== input.target.sourceRevision) throw developmentTerminal("github-base-revision-moved");
		}

		const parent = await this.readCommit(input.target.repository, input.target.sourceRevision);
		const treeEntries: Array<Record<string, unknown>> = [];
		for (const change of input.changes) {
			if (change.delete) {
				treeEntries.push({ path: change.path, mode: change.mode, type: "blob", sha: null });
				continue;
			}
			const blob = await this.github("POST", `${repoPath(input.target.repository)}/git/blobs`, {
				content: change.contentBase64,
				encoding: "base64",
			});
			const blobSha = objectId(blob, "GitHub blob");
			treeEntries.push({ path: change.path, mode: change.mode, type: "blob", sha: blobSha });
		}
		const treeValue = await this.github("POST", `${repoPath(input.target.repository)}/git/trees`, {
			base_tree: parent.treeSha,
			tree: treeEntries,
		});
		const treeSha = objectId(treeValue, "GitHub tree");
		const commitValue = await this.github("POST", `${repoPath(input.target.repository)}/git/commits`, {
			message: `${input.message}\n\n${marker}\nSophia-Scenario: ${input.target.scenarioDigest}`,
			tree: treeSha,
			parents: [input.target.sourceRevision],
		});
		const commit = parseCommit(commitValue);
		if (current) {
			await this.github(
				"PATCH",
				`${repoPath(input.target.repository)}/git/refs/heads/${refPath(input.target.branchName)}`,
				{
					sha: commit.sha,
					force: false,
				},
			);
		} else {
			await this.github("POST", `${repoPath(input.target.repository)}/git/refs`, {
				ref: `refs/heads/${input.target.branchName}`,
				sha: commit.sha,
			});
		}
		return { headSha: commit.sha, ...(commit.url ? { url: commit.url } : {}) };
	}

	async openPullRequest(input: {
		readonly target: CommittedDevelopmentTarget;
		readonly idempotencyKey: string;
		readonly title: string;
		readonly body: string;
	}): Promise<{
		readonly pullNumber: number;
		readonly headSha: string;
		readonly url: string;
		readonly replayed?: boolean;
	}> {
		const marker = htmlEffectMarker(input.idempotencyKey, input.target.scenarioDigest);
		const branch = await this.readRef(input.target.repository, input.target.branchName);
		if (!branch || branch.sha !== input.target.sourceRevision) throw developmentTerminal("github-pr-head-moved");
		const owner = input.target.repository.split("/", 1)[0]!;
		const query = new URLSearchParams({
			state: "open",
			head: `${owner}:${input.target.branchName}`,
			base: input.target.baseBranch,
			per_page: "100",
		});
		const existingValue = await this.github("GET", `${repoPath(input.target.repository)}/pulls?${query.toString()}`);
		if (!Array.isArray(existingValue)) throw developmentRetryable("github-pr-list-invalid");
		const existing = existingValue.map(parsePull).find((pull) => pull.body.includes(marker));
		if (existing) {
			if (existing.headSha !== branch.sha) throw developmentTerminal("github-pr-head-moved");
			return {
				pullNumber: existing.number,
				headSha: existing.headSha,
				url: existing.url,
				replayed: true,
			};
		}
		if (existingValue.length) throw developmentTerminal("github-pr-conflict");
		const created = parsePull(
			await this.github("POST", `${repoPath(input.target.repository)}/pulls`, {
				title: input.title,
				body: `${input.body}${input.body ? "\n\n" : ""}${marker}`,
				head: input.target.branchName,
				base: input.target.baseBranch,
			}),
		);
		if (created.headSha !== branch.sha) throw developmentTerminal("github-pr-head-moved");
		return { pullNumber: created.number, headSha: created.headSha, url: created.url };
	}

	async commentPullRequest(input: {
		readonly target: CommittedDevelopmentTarget & { readonly pullNumber: number };
		readonly idempotencyKey: string;
		readonly body: string;
	}): Promise<{ readonly pullNumber: number; readonly url: string; readonly replayed?: boolean }> {
		await this.verifyPullTarget(input.target);
		const marker = htmlEffectMarker(input.idempotencyKey, input.target.scenarioDigest);
		const commentsValue = await this.github(
			"GET",
			`${repoPath(input.target.repository)}/issues/${input.target.pullNumber}/comments?per_page=100`,
		);
		if (!Array.isArray(commentsValue)) throw developmentRetryable("github-comments-list-invalid");
		for (const value of commentsValue) {
			if (!isRecord(value) || typeof value.body !== "string" || !value.body.includes(marker)) continue;
			const url = requiredUrl(value.html_url, "GitHub comment");
			return { pullNumber: input.target.pullNumber, url, replayed: true };
		}
		const created = await this.github(
			"POST",
			`${repoPath(input.target.repository)}/issues/${input.target.pullNumber}/comments`,
			{ body: `${input.body}\n\n${marker}` },
		);
		if (!isRecord(created)) throw developmentRetryable("github-comment-response-invalid");
		return { pullNumber: input.target.pullNumber, url: requiredUrl(created.html_url, "GitHub comment") };
	}

	async mergePullRequest(input: {
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
	}> {
		const pull = await this.verifyPullTarget(input.target);
		if (pull.merged) {
			return {
				pullNumber: pull.number,
				headSha: pull.headSha,
				url: pull.url,
				merged: true,
				replayed: true,
			};
		}
		if (pull.state !== "open") throw developmentTerminal("github-pr-not-open");
		const marker = effectMarker(input.idempotencyKey);
		const result = await this.github(
			"PUT",
			`${repoPath(input.target.repository)}/pulls/${input.target.pullNumber}/merge`,
			{
				sha: input.target.expectedHeadSha,
				merge_method: input.method,
				...(input.title ? { commit_title: input.title } : {}),
				commit_message: `${input.message ?? "Merged by a human-approved Sophia Domain Agent effect"}\n\n${marker}`,
			},
		);
		if (!isRecord(result) || result.merged !== true) throw developmentTerminal("github-merge-refused");
		return {
			pullNumber: pull.number,
			headSha: pull.headSha,
			url: pull.url,
			merged: true,
		};
	}

	async close(): Promise<void> {
		const handles = await Promise.allSettled([...this.grantHandles.values()]);
		await Promise.allSettled(
			handles.flatMap((result) => (result.status === "fulfilled" ? [result.value.proxy.close()] : [])),
		);
		this.grantHandles.clear();
	}

	private async verifyPullTarget(
		target: CommittedDevelopmentTarget & { readonly pullNumber: number; readonly expectedHeadSha?: string },
	): Promise<GitHubPull> {
		const pull = parsePull(await this.github("GET", `${repoPath(target.repository)}/pulls/${target.pullNumber}`));
		if (pull.headRef !== target.branchName || pull.baseRef !== target.baseBranch) {
			throw developmentTerminal("github-pr-route-moved");
		}
		if (target.expectedHeadSha && pull.headSha !== target.expectedHeadSha) {
			throw developmentTerminal("github-pr-head-moved");
		}
		return pull;
	}

	private async readRef(repository: string, branch: string): Promise<GitHubRef | undefined> {
		const value = await this.github(
			"GET",
			`${repoPath(repository)}/git/ref/heads/${refPath(branch)}`,
			undefined,
			true,
		);
		if (value === undefined) return undefined;
		if (!isRecord(value) || !isRecord(value.object) || !GIT_OBJECT_ID.test(String(value.object.sha))) {
			throw developmentRetryable("github-ref-response-invalid");
		}
		return { sha: String(value.object.sha) };
	}

	private async readCommit(repository: string, sha: string): Promise<GitHubCommit> {
		return parseCommit(await this.github("GET", `${repoPath(repository)}/git/commits/${sha}`));
	}

	private async github(method: string, path: string, body?: unknown, allow404 = false): Promise<unknown | undefined> {
		let response: Response;
		try {
			response = await this.fetchFn(new URL(path.replace(/^\//, ""), `${this.githubApiBaseUrl}/`), {
				method,
				headers: {
					Authorization: `Bearer ${this.config.githubToken}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": "sophia-choreograph-github-edge",
					...(body === undefined ? {} : { "content-type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(this.requestTimeoutMs),
			});
		} catch (error) {
			throw developmentRetryable("github-api-unavailable", error);
		}
		if (allow404 && response.status === 404) return undefined;
		if (!response.ok) {
			const code = `github-api-http-${response.status}`;
			const rateLimited = response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0";
			if (rateLimited || response.status >= 500) throw developmentRetryable(code);
			throw developmentTerminal(code);
		}
		if (response.status === 204) return {};
		let text: string;
		try {
			text = await response.text();
		} catch (error) {
			throw developmentRetryable("github-api-response-unreadable", error);
		}
		if (!text) return {};
		try {
			return JSON.parse(text) as unknown;
		} catch (error) {
			throw developmentRetryable("github-api-response-invalid-json", error);
		}
	}

	private grantGraph(ownerPrincipal: string, graphId: string, actorSub: string): Promise<HostedGraphHandle> {
		if (!GRAPH_ID.test(graphId)) return Promise.reject(developmentTerminal("github-grant-graph-invalid"));
		const key = `${ownerPrincipal}\0${graphId}\0${actorSub}`;
		const existing = this.grantHandles.get(key);
		if (existing) return existing;
		const created = this.openGrantGraph(ownerPrincipal, graphId, actorSub).catch((error) => {
			this.grantHandles.delete(key);
			throw error;
		});
		this.grantHandles.set(key, created);
		return created;
	}

	private async openGrantGraph(ownerPrincipal: string, graphId: string, actorSub: string): Promise<HostedGraphHandle> {
		const serviceAuth: HostedServiceAuthConfig = {
			serviceToken: this.config.serviceToken,
			gatewayBaseUrl: this.gatewayBaseUrl,
			onBehalfOf: actorSub,
		};
		const proxy = new HostedMnemosyneProxy({
			apiBaseUrl: this.gatewayBaseUrl,
			ownerPrincipal,
			graphId,
			toolProfile: "full",
			runtime: "choreograph-github-edge",
			label: `github-grant:${graphId}`,
			requestTimeoutMs: this.requestTimeoutMs,
			requiredTools: ["read_document"],
			serviceAuth,
			fetchFn: this.fetchFn,
		});
		try {
			await proxy.start();
			return { proxy, writer: makeHostedGraphWriter(proxy) };
		} catch (error) {
			await proxy.close().catch(() => {});
			throw developmentRetryable("github-grant-graph-unavailable", error);
		}
	}
}

export function startHostedGitHubEffectWorkerFromEnv(
	runtime: WorkflowRuntimeStore,
	env: Readonly<Record<string, string | undefined>> = process.env,
	fetchFn: typeof fetch = fetch,
): GitHubEffectWorker | undefined {
	if (!enabled(env.GITHUB_EFFECT_WORKER_ENABLED)) return undefined;
	const host = new HostedGitHubEffectHost({
		gatewayBaseUrl: requiredEnv(env, "MNEMOSYNE_GATEWAY_BASE_URL"),
		serviceToken: requiredEnv(env, "MNEMOSYNE_SERVICE_TOKEN"),
		githubToken: requiredEnv(env, "GITHUB_EFFECT_TOKEN"),
		...(env.GITHUB_API_BASE_URL?.trim() ? { githubApiBaseUrl: env.GITHUB_API_BASE_URL.trim() } : {}),
		requestTimeoutMs: optionalInteger(
			env.GITHUB_EFFECT_REQUEST_TIMEOUT_MS,
			60_000,
			"GITHUB_EFFECT_REQUEST_TIMEOUT_MS",
		),
		fetchFn,
	});
	return new GitHubEffectWorker(runtime, host, undefined, {
		consumer: env.GITHUB_EFFECT_CONSUMER?.trim() || "choreograph-github-edge",
		pollMs: optionalInteger(env.GITHUB_EFFECT_POLL_MS, 1_000, "GITHUB_EFFECT_POLL_MS"),
		leaseMs: optionalInteger(env.GITHUB_EFFECT_LEASE_MS, 60_000, "GITHUB_EFFECT_LEASE_MS"),
		log: (message, error) => console.error(`[github-effect] ${message}`, error ?? ""),
	});
}

function parseCommit(value: unknown): GitHubCommit {
	if (!isRecord(value) || !GIT_OBJECT_ID.test(String(value.sha)) || !isRecord(value.tree)) {
		throw developmentRetryable("github-commit-response-invalid");
	}
	const treeSha = String(value.tree.sha);
	if (!GIT_OBJECT_ID.test(treeSha) || typeof value.message !== "string") {
		throw developmentRetryable("github-commit-response-invalid");
	}
	const url = optionalUrl(value.html_url);
	return { sha: String(value.sha), treeSha, message: value.message, ...(url ? { url } : {}) };
}

function parsePull(value: unknown): GitHubPull {
	if (
		!isRecord(value) ||
		!Number.isSafeInteger(value.number) ||
		Number(value.number) < 1 ||
		typeof value.state !== "string" ||
		!isRecord(value.head) ||
		!isRecord(value.base) ||
		!GIT_OBJECT_ID.test(String(value.head.sha)) ||
		typeof value.head.ref !== "string" ||
		typeof value.base.ref !== "string"
	) {
		throw developmentRetryable("github-pr-response-invalid");
	}
	return {
		number: Number(value.number),
		state: value.state,
		merged: value.merged === true || typeof value.merged_at === "string",
		headSha: String(value.head.sha),
		headRef: value.head.ref,
		baseRef: value.base.ref,
		body: typeof value.body === "string" ? value.body : "",
		url: requiredUrl(value.html_url, "GitHub pull request"),
		...(GIT_OBJECT_ID.test(String(value.merge_commit_sha)) ? { mergeCommitSha: String(value.merge_commit_sha) } : {}),
	};
}

function objectId(value: unknown, label: string): string {
	if (!isRecord(value) || !GIT_OBJECT_ID.test(String(value.sha))) {
		throw developmentRetryable(`${label.toLowerCase().replaceAll(" ", "-")}-response-invalid`);
	}
	return String(value.sha);
}

function repoPath(repository: string): string {
	return `repos/${repository.split("/").map(encodeURIComponent).join("/")}`;
}

function refPath(branch: string): string {
	return branch.split("/").map(encodeURIComponent).join("/");
}

function effectMarker(idempotencyKey: string): string {
	if (!/^effect:[0-9a-f]{64}$/.test(idempotencyKey)) throw developmentTerminal("github-effect-identity-invalid");
	return `Sophia-Effect: ${idempotencyKey}`;
}

function htmlEffectMarker(idempotencyKey: string, scenarioDigest: string): string {
	const effectDigest = effectMarker(idempotencyKey).slice("Sophia-Effect: effect:".length);
	return `<!-- sophia-effect:${effectDigest}; scenario:${scenarioDigest} -->`;
}

function requiredUrl(value: unknown, label: string): string {
	const url = optionalUrl(value);
	if (!url) throw developmentRetryable(`${label.toLowerCase().replaceAll(" ", "-")}-url-invalid`);
	return url;
}

function optionalUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value);
		return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.toString() : undefined;
	} catch {
		return undefined;
	}
}

function normalizeOrigin(value: string, label: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${label} must be an absolute URL`);
	}
	if (!/^https?:$/.test(url.protocol) || !url.host || url.username || url.password || url.search || url.hash) {
		throw new Error(`${label} must be a credential-free http(s) origin`);
	}
	return url.toString().replace(/\/$/, "");
}

function requireUserPrincipal(value: string, label: string): string {
	const match = USER_PRINCIPAL.exec(value);
	if (!match) throw developmentTerminal("github-user-owner-required", new Error(`${label} must be user:<subject>`));
	return match[1]!;
}

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`GitHub effect worker requires ${name}`);
	return value;
}

function optionalInteger(value: string | undefined, fallback: number, label: string): number {
	if (!value?.trim()) return fallback;
	return positiveInteger(Number(value), label);
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
	return value;
}

function enabled(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
