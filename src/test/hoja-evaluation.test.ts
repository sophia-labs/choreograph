import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";
import { EvaluationCapabilityBackend } from "../capabilities/evaluation.js";
import { EvidenceStore } from "../evidence-store.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Hoja evidence and evaluation capabilities", () => {
	it("round-trips content-addressed evidence and rejects refs outside the host prefix", async () => {
		const { store, root } = evidenceStore();
		const ref = await store.put(
			["run-1", "scenario-1", "beat-1", "chromium"],
			"probe",
			"json",
			"application/json",
			"{}\n",
		);
		const loaded = await store.get(ref);
		assert.equal(loaded.body.toString("utf8"), "{}\n");
		await assert.rejects(
			() => store.get({ ...ref, uri: pathToFileURL(join(root, "..", "escape.json")).toString() }),
			/outside the configured prefix/,
		);
		await assert.rejects(() => store.get({ ...ref, sha256: "0".repeat(64) }), /digest does not match/);
	});

	it("computes a real PNG diff and sends private screenshots to strict OpenRouter vision input", async () => {
		const { store } = evidenceStore();
		const left = await store.put(
			["run-1", "scenario-1", "beat-1", "chromium"],
			"screenshot",
			"png",
			"image/png",
			png(255, 255, 255),
		);
		const right = await store.put(
			["run-1", "scenario-1", "beat-1", "camoufox"],
			"screenshot",
			"png",
			"image/png",
			png(0, 0, 0),
		);
		let request: Record<string, unknown> | undefined;
		let authorization: string | null = null;
		const usage: unknown[] = [];
		const backend = new EvaluationCapabilityBackend({
			capabilityName: "evaluation.visual",
			mode: "visual",
			model: "openai/gpt-5-mini",
			apiKey: "host-secret",
			evidenceStore: store,
			apiBaseUrl: "https://provider.example/v1/",
			fetchFn: async (_input, init) => {
				authorization = new Headers(init?.headers).get("authorization");
				request = JSON.parse(String(init?.body)) as Record<string, unknown>;
				return completionResponse({
					schema: "sophia.hoja.visual-evaluation.v1",
					verdict: "anomaly",
					confidencePermille: 990,
					claims: [
						{
							code: "cross_engine_diff",
							severity: "high",
							summary: "The frames differ.",
							evidenceSha256s: [left.sha256, right.sha256],
						},
					],
				});
			},
			onUsage: (event) => usage.push(event),
		});
		const diff = (await backend.callTool("perceptual_diff", {
			runId: "run-1",
			scenarioId: "scenario-1",
			beatId: "beat-1",
			left,
			right,
		})) as { differentPixels: number; ratioPermille: number; diff: { uri: string } };
		assert.equal(diff.differentPixels, 4);
		assert.equal(diff.ratioPermille, 1000);
		assert.match(diff.diff.uri, /cross-engine\/perceptual-diff-sha256-/);

		const evaluated = (await backend.callTool("evaluate_visual", {
			runId: "run-1",
			scenarioId: "scenario-1",
			beatId: "beat-1",
			expectation: "Both engines render the same Hoja note.",
			screenshots: [
				{ engine: "chromium", ref: left },
				{ engine: "camoufox", ref: right },
			],
			diff,
		})) as { result: { verdict: string } };
		assert.equal(evaluated.result.verdict, "anomaly");
		assert.equal(authorization, "Bearer host-secret");
		assert.equal(JSON.stringify(evaluated).includes("host-secret"), false);
		const messages = request?.messages as Array<{ content: Array<Record<string, unknown>> }>;
		assert.equal(messages[1].content[0].type, "text", "OpenRouter requires text before image parts");
		assert.equal(messages[1].content.filter((part) => part.type === "image_url").length, 2);
		assert.deepEqual(request?.provider, { require_parameters: true });
		const responseFormat = request?.response_format as {
			type: string;
			json_schema: { schema: Record<string, unknown> };
		};
		assert.equal(responseFormat.type, "json_schema");
		assert.equal(JSON.stringify(responseFormat.json_schema.schema).includes('"maxItems"'), false);
		assert.equal(JSON.stringify(responseFormat.json_schema.schema).includes('"pattern"'), false);
		assert.equal(request?.temperature, undefined, "GPT-5 routes reject temperature when parameters are required");
		assert.equal(usage.length, 1);
	});

	it("runs an independent strict reflection seat without exposing its API key", async () => {
		const { store } = evidenceStore();
		const backend = new EvaluationCapabilityBackend({
			capabilityName: "evaluation.foreign",
			mode: "reflection",
			model: "openai/gpt-5",
			apiKey: "foreign-host-secret",
			evidenceStore: store,
			fetchFn: async () =>
				completionResponse({
					schema: "sophia.hoja.wave-reflection.v1",
					hypotheses: [{ code: "save_echo", summary: "Save echo may reorder the list.", supports: ["beat-1"] }],
					prioritizedFindings: [
						{ priority: 1, title: "Check echo", detail: "Re-run with delayed typing.", evidenceSha256s: [] },
					],
					nextWave: [
						{ objective: "Stress save echo", modalityPairs: ["M1xM4"], operations: ["type", "concurrent-edit"] },
					],
				}),
		});
		const result = (await backend.callTool("reflect_wave", {
			runId: "run-1",
			wave: { verdicts: [{ invariant: "I4", passed: false }] },
		})) as { result: { nextWave: unknown[] } };
		assert.equal(result.result.nextWave.length, 1);
		assert.equal(JSON.stringify(result).includes("foreign-host-secret"), false);
	});

	it("recovers structured output from fenced or prefixed model content", async () => {
		const { store } = evidenceStore();
		const reflection = {
			schema: "sophia.hoja.wave-reflection.v1",
			hypotheses: [{ code: "save_echo", summary: "Save echo may reorder the list.", supports: ["beat-1"] }],
			prioritizedFindings: [
				{ priority: 1, title: "Check echo", detail: "Re-run with delayed typing.", evidenceSha256s: [] },
			],
			nextWave: [
				{ objective: "Stress save echo", modalityPairs: ["M1xM4"], operations: ["type", "concurrent-edit"] },
			],
		};
		for (const noisy of [
			"```json\n" + JSON.stringify(reflection) + "\n```",
			"Here is the contracted reflection you asked for:\n" + JSON.stringify(reflection),
		]) {
			const backend = new EvaluationCapabilityBackend({
				capabilityName: "evaluation.primary",
				mode: "reflection",
				model: "anthropic/claude-opus-4.5",
				apiKey: "primary-host-secret",
				evidenceStore: store,
				fetchFn: async () => rawContentResponse(noisy),
			});
			const result = (await backend.callTool("reflect_wave", {
				runId: "run-1",
				wave: { verdicts: [{ invariant: "I4", passed: false }] },
			})) as { result: { nextWave: unknown[] } };
			assert.equal(result.result.nextWave.length, 1);
		}
	});

	it("retries the provider exactly once on unparseable structured output", async () => {
		const { store } = evidenceStore();
		const reflection = {
			schema: "sophia.hoja.wave-reflection.v1",
			hypotheses: [{ code: "save_echo", summary: "Save echo may reorder the list.", supports: ["beat-1"] }],
			prioritizedFindings: [
				{ priority: 1, title: "Check echo", detail: "Re-run with delayed typing.", evidenceSha256s: [] },
			],
			nextWave: [
				{ objective: "Stress save echo", modalityPairs: ["M1xM4"], operations: ["type", "concurrent-edit"] },
			],
		};
		let recoveredCalls = 0;
		const recovering = new EvaluationCapabilityBackend({
			capabilityName: "evaluation.primary",
			mode: "reflection",
			model: "anthropic/claude-opus-4.5",
			apiKey: "primary-host-secret",
			evidenceStore: store,
			fetchFn: async () => {
				recoveredCalls += 1;
				return recoveredCalls === 1
					? rawContentResponse("The model mused at length and returned no JSON at all.")
					: completionResponse(reflection);
			},
		});
		const recoveredResult = (await recovering.callTool("reflect_wave", {
			runId: "run-1",
			wave: { verdicts: [{ invariant: "I4", passed: false }] },
		})) as { result: { nextWave: unknown[] } };
		assert.equal(recoveredResult.result.nextWave.length, 1);
		assert.equal(recoveredCalls, 2);

		let garbageCalls = 0;
		const garbage = new EvaluationCapabilityBackend({
			capabilityName: "evaluation.primary",
			mode: "reflection",
			model: "anthropic/claude-opus-4.5",
			apiKey: "primary-host-secret",
			evidenceStore: store,
			fetchFn: async () => {
				garbageCalls += 1;
				return rawContentResponse("utter nonsense with no payload, attempt " + garbageCalls);
			},
		});
		await assert.rejects(
			() =>
				garbage.callTool("reflect_wave", {
					runId: "run-1",
					wave: { verdicts: [{ invariant: "I4", passed: false }] },
				}),
			(error: Error) => {
				assert.match(error.message, /structured model output was not JSON/);
				assert.match(error.message, /utter nonsense with no payload/);
				assert.equal(error.message.length < 600, true);
				return true;
			},
		);
		assert.equal(garbageCalls, 2);
	});

	it("surfaces only a parsed nested provider diagnostic", async () => {
		const { store } = evidenceStore();
		const backend = new EvaluationCapabilityBackend({
			capabilityName: "evaluation.primary",
			mode: "reflection",
			model: "openai/gpt-5",
			apiKey: "host-secret",
			evidenceStore: store,
			fetchFn: async () =>
				new Response(
					JSON.stringify({
						error: {
							message: "Provider returned error",
							metadata: {
								raw: JSON.stringify({ error: { message: "Invalid strict schema", private: "do not echo" } }),
							},
						},
					}),
					{ status: 400, headers: { "content-type": "application/json" } },
				),
		});
		await assert.rejects(
			() => backend.callTool("reflect_wave", { runId: "run-1", wave: {} }),
			(error: Error) => error.message.includes("Invalid strict schema") && !error.message.includes("do not echo"),
		);
	});

	it("enforces the full local contract after a provider accepts the portable schema", async () => {
		const { store } = evidenceStore();
		const backend = new EvaluationCapabilityBackend({
			capabilityName: "evaluation.primary",
			mode: "reflection",
			model: "anthropic/claude-opus-4.5",
			apiKey: "host-secret",
			evidenceStore: store,
			fetchFn: async () =>
				completionResponse({
					schema: "sophia.hoja.wave-reflection.v1",
					hypotheses: [{ code: "UPPERCASE", summary: "Invalid local code.", supports: [] }],
					prioritizedFindings: [],
					nextWave: [],
				}),
		});
		await assert.rejects(
			() => backend.callTool("reflect_wave", { runId: "run-1", wave: {} }),
			/model output violated the JSON contract/,
		);
	});
});

function evidenceStore(): { root: string; store: EvidenceStore } {
	const root = mkdtempSync(join(tmpdir(), "hoja-evidence-"));
	roots.push(root);
	return { root, store: EvidenceStore.fromUrl(`${pathToFileURL(root).toString()}/`) };
}

function png(red: number, green: number, blue: number): Buffer {
	const image = new PNG({ width: 2, height: 2 });
	for (let offset = 0; offset < image.data.length; offset += 4) {
		image.data[offset] = red;
		image.data[offset + 1] = green;
		image.data[offset + 2] = blue;
		image.data[offset + 3] = 255;
	}
	return PNG.sync.write(image);
}

function rawContentResponse(content: string): Response {
	return new Response(
		JSON.stringify({
			id: "generation-raw",
			choices: [{ message: { role: "assistant", content } }],
			usage: {
				prompt_tokens: 20,
				completion_tokens: 10,
				total_tokens: 30,
				prompt_tokens_details: { cached_tokens: 0 },
			},
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function completionResponse(result: unknown): Response {
	return new Response(
		JSON.stringify({
			id: "generation-1",
			choices: [{ message: { role: "assistant", content: JSON.stringify(result) } }],
			usage: {
				prompt_tokens: 20,
				completion_tokens: 10,
				total_tokens: 30,
				prompt_tokens_details: { cached_tokens: 2 },
			},
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}
