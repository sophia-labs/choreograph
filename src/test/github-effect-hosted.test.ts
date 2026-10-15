import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostedGitHubEffectHost, startHostedGitHubEffectWorkerFromEnv } from "../workflow/github-effect-hosted.js";

const BASE = "a".repeat(40);
const BASE_TREE = "b".repeat(40);
const BLOB = "c".repeat(40);
const TREE = "d".repeat(40);
const HEAD = "e".repeat(40);
const EFFECT_KEY = `effect:${"f".repeat(64)}`;
const SCENARIO = "9".repeat(64);

const TARGET = {
	ownerPrincipal: "user:ada",
	repository: "sophia-labs/shrubbery",
	sourceRevision: BASE,
	baseBranch: "main",
	branchName: "agent/shrub-1/fix-hoja",
	scratchGraphId: "dev-shrub1-fix-hoja",
	scenarioDigest: SCENARIO,
} as const;

interface SeenRequest {
	readonly method: string;
	readonly url: URL;
	readonly authorization: string | null;
	readonly body?: unknown;
}

function response(value: unknown, status = 200): Response {
	return new Response(status === 204 ? undefined : JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function scriptedFetch(steps: Array<(request: SeenRequest) => Response>): {
	readonly fetchFn: typeof fetch;
	readonly seen: SeenRequest[];
} {
	const seen: SeenRequest[] = [];
	const fetchFn: typeof fetch = async (input, init) => {
		const headers = new Headers(init?.headers);
		const request: SeenRequest = {
			method: init?.method ?? "GET",
			url: new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url),
			authorization: headers.get("authorization"),
			...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
		};
		seen.push(request);
		const step = steps.shift();
		if (!step) throw new Error(`unexpected ${request.method} ${request.url.pathname}`);
		return step(request);
	};
	return { fetchFn, seen };
}

function host(fetchFn: typeof fetch): HostedGitHubEffectHost {
	return new HostedGitHubEffectHost({
		gatewayBaseUrl: "https://api.garden.example.invalid",
		serviceToken: "service-secret",
		githubToken: "github-secret",
		fetchFn,
	});
}

describe("hosted GitHub effect transport", () => {
	it("creates content-addressed Git objects and advances only the committed agent branch without force", async () => {
		const content = Buffer.from("export const fixed = true\n");
		const script = scriptedFetch([
			(request) => {
				assert.equal(request.method, "GET");
				assert.equal(request.url.pathname, "/repos/sophia-labs/shrubbery/git/ref/heads/agent/shrub-1/fix-hoja");
				return response({}, 404);
			},
			(request) => {
				assert.equal(request.url.pathname, "/repos/sophia-labs/shrubbery/git/ref/heads/main");
				return response({ object: { sha: BASE } });
			},
			(request) => {
				assert.equal(request.url.pathname, `/repos/sophia-labs/shrubbery/git/commits/${BASE}`);
				return response({ sha: BASE, tree: { sha: BASE_TREE }, message: "base" });
			},
			(request) => {
				assert.equal(request.method, "POST");
				assert.equal(request.url.pathname, "/repos/sophia-labs/shrubbery/git/blobs");
				assert.deepEqual(request.body, { content: content.toString("base64"), encoding: "base64" });
				return response({ sha: BLOB }, 201);
			},
			(request) => {
				assert.equal(request.url.pathname, "/repos/sophia-labs/shrubbery/git/trees");
				assert.deepEqual(request.body, {
					base_tree: BASE_TREE,
					tree: [{ path: "packages/domain-kit/src/fix.ts", mode: "100644", type: "blob", sha: BLOB }],
				});
				return response({ sha: TREE }, 201);
			},
			(request) => {
				assert.equal(request.url.pathname, "/repos/sophia-labs/shrubbery/git/commits");
				assert.match(String((request.body as { message: string }).message), /Sophia-Effect: effect:f{64}/);
				assert.match(String((request.body as { message: string }).message), new RegExp(SCENARIO));
				return response({ sha: HEAD, tree: { sha: TREE }, message: "Fix\n\nSophia-Effect" }, 201);
			},
			(request) => {
				assert.equal(request.url.pathname, "/repos/sophia-labs/shrubbery/git/refs");
				assert.deepEqual(request.body, { ref: "refs/heads/agent/shrub-1/fix-hoja", sha: HEAD });
				return response({ object: { sha: HEAD } }, 201);
			},
		]);
		const transport = host(script.fetchFn);
		const result = await transport.pushBranch({
			target: TARGET,
			idempotencyKey: EFFECT_KEY,
			message: "Fix the Hoja regression",
			changes: [
				{
					path: "packages/domain-kit/src/fix.ts",
					mode: "100644",
					contentBase64: content.toString("base64"),
					contentSha256: "not consumed by the transport after worker validation",
				},
			],
		});
		assert.equal(result.headSha, HEAD);
		assert.equal(script.seen.length, 7);
		assert.ok(script.seen.every((request) => request.authorization === "Bearer github-secret"));
		assert.ok(script.seen.every((request) => !JSON.stringify(request.body ?? {}).includes("github-secret")));
	});

	it("recognizes its own branch effect marker after a transport retry instead of writing twice", async () => {
		const script = scriptedFetch([
			() => response({ object: { sha: HEAD } }),
			() =>
				response({
					sha: HEAD,
					tree: { sha: TREE },
					message: `Fix\n\nSophia-Effect: ${EFFECT_KEY}`,
					html_url: `https://github.com/sophia-labs/shrubbery/commit/${HEAD}`,
				}),
		]);
		const result = await host(script.fetchFn).pushBranch({
			target: TARGET,
			idempotencyKey: EFFECT_KEY,
			message: "Fix",
			changes: [{ path: "packages/a.ts", mode: "100644", contentBase64: "YQ==", contentSha256: "x" }],
		});
		assert.equal(result.replayed, true);
		assert.equal(result.headSha, HEAD);
		assert.equal(script.seen.length, 2);
	});

	it("opens, comments on, and human-edge merges an exact head/base pull request with replay markers", async () => {
		const target = { ...TARGET, sourceRevision: HEAD };
		const pull = {
			number: 42,
			state: "open",
			merged: false,
			head: { sha: HEAD, ref: target.branchName },
			base: { ref: target.baseBranch },
			body: "",
			html_url: "https://github.com/sophia-labs/shrubbery/pull/42",
		};
		const script = scriptedFetch([
			() => response({ object: { sha: HEAD } }),
			() => response([]),
			(request) => {
				assert.match(String((request.body as { body: string }).body), /sophia-effect:f{64}/);
				return response({
					...pull,
					body: String((request.body as { body: string }).body),
				});
			},
			() => response(pull),
			() => response([]),
			(request) => {
				assert.match(String((request.body as { body: string }).body), /sophia-effect:f{64}/);
				return response({ html_url: "https://github.com/sophia-labs/shrubbery/pull/42#issuecomment-1" }, 201);
			},
			() => response(pull),
			(request) => {
				assert.deepEqual(request.body, {
					sha: HEAD,
					merge_method: "squash",
					commit_message: `Approved fix\n\nSophia-Effect: ${EFFECT_KEY}`,
				});
				return response({ merged: true, sha: "1".repeat(40) });
			},
		]);
		const transport = host(script.fetchFn);
		const opened = await transport.openPullRequest({
			target,
			idempotencyKey: EFFECT_KEY,
			title: "Fix Hoja",
			body: "Before/after evidence",
		});
		assert.equal(opened.pullNumber, 42);
		const pullTarget = { ...target, pullNumber: 42, expectedHeadSha: HEAD };
		const commented = await transport.commentPullRequest({
			target: pullTarget,
			idempotencyKey: EFFECT_KEY,
			body: "Replay is green",
		});
		assert.match(commented.url, /issuecomment-1/);
		const merged = await transport.mergePullRequest({
			target: pullTarget,
			idempotencyKey: EFFECT_KEY,
			method: "squash",
			message: "Approved fix",
		});
		assert.equal(merged.merged, true);
		assert.equal(script.seen.length, 8);
	});

	it("is disabled by default and never requires a repository token on an inactive host edge", () => {
		assert.equal(startHostedGitHubEffectWorkerFromEnv({} as never, {}), undefined);
	});
});
