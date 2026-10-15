import { randomUUID } from "node:crypto";
import Ajv, { type ValidateFunction } from "ajv";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { EvidenceRef, EvidenceStore } from "../evidence-store.js";
import type { CapabilityBackend, HostedMcpToolDescriptor } from "../mnemosyne.js";

const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

const VISUAL_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["schema", "verdict", "confidencePermille", "claims"],
	properties: {
		schema: { type: "string", const: "sophia.hoja.visual-evaluation.v1" },
		verdict: { type: "string", enum: ["pass", "anomaly"] },
		confidencePermille: { type: "integer", minimum: 0, maximum: 1000 },
		claims: {
			type: "array",
			maxItems: 32,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["code", "severity", "summary", "evidenceSha256s"],
				properties: {
					code: {
						type: "string",
						pattern: "^[a-z][a-z0-9_.-]{0,63}$",
						description: "A lowercase machine code matching ^[a-z][a-z0-9_.-]{0,63}$.",
					},
					severity: { type: "string", enum: ["info", "low", "medium", "high", "critical"] },
					summary: { type: "string", minLength: 1, maxLength: 2000 },
					evidenceSha256s: {
						type: "array",
						maxItems: 16,
						items: { type: "string", pattern: "^[a-f0-9]{64}$" },
					},
				},
			},
		},
	},
} as const;

const REFLECTION_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["schema", "hypotheses", "prioritizedFindings", "nextWave"],
	properties: {
		schema: { type: "string", const: "sophia.hoja.wave-reflection.v1" },
		hypotheses: {
			type: "array",
			maxItems: 32,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["code", "summary", "supports"],
				properties: {
					code: {
						type: "string",
						pattern: "^[a-z][a-z0-9_.-]{0,63}$",
						description: "A lowercase machine code matching ^[a-z][a-z0-9_.-]{0,63}$.",
					},
					summary: { type: "string", minLength: 1, maxLength: 4000 },
					supports: { type: "array", maxItems: 64, items: { type: "string", maxLength: 256 } },
				},
			},
		},
		prioritizedFindings: {
			type: "array",
			maxItems: 64,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["priority", "title", "detail", "evidenceSha256s"],
				properties: {
					priority: { type: "integer", minimum: 1, maximum: 1000 },
					title: { type: "string", minLength: 1, maxLength: 500 },
					detail: { type: "string", minLength: 1, maxLength: 8000 },
					evidenceSha256s: {
						type: "array",
						maxItems: 64,
						items: { type: "string", pattern: "^[a-f0-9]{64}$" },
					},
				},
			},
		},
		nextWave: {
			type: "array",
			maxItems: 32,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["objective", "modalityPairs", "operations"],
				properties: {
					objective: { type: "string", minLength: 1, maxLength: 2000 },
					modalityPairs: { type: "array", maxItems: 49, items: { type: "string", maxLength: 128 } },
					operations: {
						type: "array",
						maxItems: 16,
						items: {
							type: "string",
							enum: ["create", "type", "edit-block", "concurrent-edit", "rename", "list", "delete-later"],
						},
					},
				},
			},
		},
	},
} as const;

const ajv = new Ajv({ allErrors: true, strict: true });
const validateVisual = ajv.compile(VISUAL_SCHEMA);
const validateReflection = ajv.compile(REFLECTION_SCHEMA);

export interface EvaluationUsage {
	readonly requestId: string;
	readonly model: string;
	readonly durationMs: number;
	readonly outcome: "ok" | "error";
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
	readonly cacheReadTokens: number;
}

/** What the credit gate needs to know about one provider call, before it is made. */
export interface EvaluationCall {
	readonly requestId: string;
	readonly model: string;
	/** The output cap the provider request carries (`max_completion_tokens`). */
	readonly maxCompletionTokens: number;
	/** Upper-bound estimate of the request's input, tokens. */
	readonly estimatedInputTokens: number;
}

/** The output cap of every evaluator provider request. */
const EVALUATION_MAX_COMPLETION_TOKENS = 8192;
/** An attached screenshot is priced flat: providers tokenize images by their own rules. */
const IMAGE_INPUT_TOKENS = 1_500;

/**
 * A deliberately generous upper bound of the request's input tokens: a third of a token per UTF-8 byte of
 * text, plus a flat allowance per attached image (its base64 body must not be counted as text).
 */
export function estimateEvaluationInputTokens(messages: readonly unknown[]): number {
	let bytes = 0;
	let images = 0;
	const walk = (value: unknown): void => {
		if (typeof value === "string") {
			bytes += Buffer.byteLength(value, "utf8");
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		const part = value as Record<string, unknown>;
		if (part.type === "image_url") {
			images += 1;
			return;
		}
		for (const child of Object.values(part)) walk(child);
	};
	walk(messages);
	return Math.ceil(bytes / 3) + images * IMAGE_INPUT_TOKENS;
}

export interface EvaluationCapabilityOptions {
	readonly capabilityName: string;
	readonly mode: "visual" | "reflection";
	readonly model: string;
	readonly apiKey: string;
	readonly evidenceStore: EvidenceStore;
	readonly apiBaseUrl?: string;
	readonly fetchFn?: typeof fetch;
	readonly onUsage?: (usage: EvaluationUsage) => void;
	/**
	 * Credit admission, awaited once per provider call BEFORE the platform key is used. It throws to refuse
	 * (a refusal is not a usage event); absent = no admission, exactly as before credits.
	 */
	readonly admit?: (call: EvaluationCall) => Promise<void>;
}

/** Host-owned visual/diff/reflection evaluator. Credentials and fat evidence never enter the sandbox. */
export class EvaluationCapabilityBackend implements CapabilityBackend {
	readonly accessLevel = "ro" as const;
	readonly capabilityName: string;
	private readonly mode: "visual" | "reflection";
	private readonly model: string;
	private readonly apiKey: string;
	private readonly evidenceStore: EvidenceStore;
	private readonly endpoint: URL;
	private readonly fetchFn: typeof fetch;
	private readonly onUsage?: (usage: EvaluationUsage) => void;
	private readonly admit?: (call: EvaluationCall) => Promise<void>;

	constructor(options: EvaluationCapabilityOptions) {
		if (!MODEL_ID.test(options.model)) throw new Error("evaluation: invalid configured model id");
		if (!options.apiKey) throw new Error("evaluation: OPENROUTER_API_KEY is required");
		this.capabilityName = options.capabilityName;
		this.mode = options.mode;
		this.model = options.model;
		this.apiKey = options.apiKey;
		this.evidenceStore = options.evidenceStore;
		this.endpoint = new URL(
			"chat/completions",
			ensureTrailingSlash(options.apiBaseUrl ?? "https://openrouter.ai/api/v1/"),
		);
		this.fetchFn = options.fetchFn ?? fetch;
		this.onUsage = options.onUsage;
		this.admit = options.admit;
	}

	async callTool(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		if (tool === "perceptual_diff") return this.perceptualDiff(args);
		if (tool === "evaluate_visual" && this.mode === "visual") return this.evaluateVisual(args, signal);
		if (tool === "reflect_wave" && this.mode === "reflection") return this.reflectWave(args, signal);
		throw new Error(`${this.capabilityName}: unknown or unavailable tool ${JSON.stringify(tool)}`);
	}

	async listTools(): Promise<readonly HostedMcpToolDescriptor[]> {
		const diff: HostedMcpToolDescriptor = {
			name: "perceptual_diff",
			destructive: false,
			description:
				"Compare two host-owned PNG evidence refs and return a thin diff ref plus bounded pixel statistics.",
			inputSchema: {
				type: "object",
				required: ["runId", "scenarioId", "beatId", "left", "right"],
				properties: {
					runId: { type: "string" },
					scenarioId: { type: "string" },
					beatId: { type: "string" },
					left: { type: "object" },
					right: { type: "object" },
				},
			},
		};
		if (this.mode === "visual") {
			return [
				diff,
				{
					name: "evaluate_visual",
					destructive: false,
					description: "Evaluate one browser beat from private screenshot refs with strict structured output.",
					inputSchema: {
						type: "object",
						required: ["runId", "scenarioId", "beatId", "expectation", "screenshots"],
						properties: {
							runId: { type: "string" },
							scenarioId: { type: "string" },
							beatId: { type: "string" },
							expectation: { type: "string" },
							screenshots: { type: "array", minItems: 1, maxItems: 4, items: { type: "object" } },
							diff: { type: "object" },
						},
					},
				},
			];
		}
		return [
			{
				name: "reflect_wave",
				destructive: false,
				description: "Reflect over bounded verdict/anomaly testimony and propose the next adaptive wave.",
				inputSchema: {
					type: "object",
					required: ["runId", "wave"],
					properties: { runId: { type: "string" }, wave: { type: "object" } },
				},
			},
		];
	}

	async close(): Promise<void> {}

	private async perceptualDiff(args: Record<string, unknown>): Promise<unknown> {
		const location = evidenceLocation(args, "cross-engine");
		const [leftBlob, rightBlob] = await Promise.all([
			this.evidenceStore.get(asEvidenceRef(args.left, "left"), MAX_EVIDENCE_BYTES),
			this.evidenceStore.get(asEvidenceRef(args.right, "right"), MAX_EVIDENCE_BYTES),
		]);
		assertPng(leftBlob.ref, "left");
		assertPng(rightBlob.ref, "right");
		const left = PNG.sync.read(leftBlob.body);
		const right = PNG.sync.read(rightBlob.body);
		const width = Math.max(left.width, right.width);
		const height = Math.max(left.height, right.height);
		if (width * height > 40_000_000) throw new Error("evaluation: decoded image exceeds the pixel bound");
		const leftPadded = padPng(left, width, height);
		const rightPadded = padPng(right, width, height);
		const diff = new PNG({ width, height });
		const differentPixels = pixelmatch(leftPadded.data, rightPadded.data, diff.data, width, height, {
			threshold: 0.1,
			includeAA: false,
		});
		const diffRef = await this.evidenceStore.put(
			location,
			"perceptual-diff",
			"png",
			"image/png",
			PNG.sync.write(diff),
		);
		return {
			schema: "sophia.hoja.perceptual-diff.v1",
			left: leftBlob.ref,
			right: rightBlob.ref,
			diff: diffRef,
			width,
			height,
			// dimensionsEqual false is a KNOWN caveat (not a finding) when either
			// side's evidence manifest carries viewportPinned:false (change-set 5).
			dimensionsEqual: left.width === right.width && left.height === right.height,
			differentPixels,
			ratioPermille: Math.round((differentPixels * 1000) / Math.max(1, width * height)),
		};
	}

	private async evaluateVisual(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const runId = evidenceId(args.runId, "runId");
		const scenarioId = evidenceId(args.scenarioId, "scenarioId");
		const beatId = evidenceId(args.beatId, "beatId");
		const expectation = boundedString(args.expectation, "expectation", 4000);
		if (!Array.isArray(args.screenshots) || args.screenshots.length < 1 || args.screenshots.length > 4) {
			throw new Error("evaluation: screenshots must contain 1..4 refs");
		}
		const images = await Promise.all(
			args.screenshots.map(async (value, index) => {
				const record = asRecord(value, `screenshots[${index}]`);
				assertExactKeys(record, ["engine", "ref"], `screenshots[${index}]`);
				const engine = evidenceId(record.engine, `screenshots[${index}].engine`);
				const blob = await this.evidenceStore.get(
					asEvidenceRef(record.ref, `screenshots[${index}].ref`),
					MAX_EVIDENCE_BYTES,
				);
				assertPng(blob.ref, `screenshots[${index}].ref`);
				return { engine, ref: blob.ref, dataUrl: `data:image/png;base64,${blob.body.toString("base64")}` };
			}),
		);
		const digestList = images.map((image) => `${image.engine}:${image.ref.sha256}`).join(", ");
		const text = [
			"You are the L1 visual evaluator for a cross-modal Hoja functional test.",
			"Report only visible anomalies grounded in the supplied screenshots. Cross-engine differences may be intentional; do not invent causes.",
			"Every claim code must be a lowercase machine code beginning with a letter.",
			`run=${runId} scenario=${scenarioId} beat=${beatId}`,
			`expectation=${expectation}`,
			`evidence=${digestList}`,
			args.diff === undefined
				? "mechanical_diff=not supplied"
				: `mechanical_diff=${boundedJson(args.diff, 64 * 1024)}`,
		].join("\n\n");
		const content: Array<Record<string, unknown>> = [{ type: "text", text }];
		for (const image of images) content.push({ type: "image_url", image_url: { url: image.dataUrl } });
		const completion = await this.complete(
			[
				{ role: "system", content: "Return the contracted JSON object and no prose." },
				{ role: "user", content },
			],
			"hoja_visual_evaluation",
			VISUAL_SCHEMA,
			validateVisual,
			signal,
		);
		return { ...completion, runId, scenarioId, beatId };
	}

	private async reflectWave(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		const runId = evidenceId(args.runId, "runId");
		const wave = boundedJson(args.wave, MAX_PROMPT_BYTES);
		const completion = await this.complete(
			[
				{
					role: "system",
					content:
						"You are an L2 Hoja swarm reviewer. Cluster symptoms into falsifiable hypotheses, prioritize evidence-backed findings, and steer the next wave toward unresolved smoke. Every hypothesis code must be a lowercase machine code beginning with a letter. Return only the contracted JSON object.",
				},
				{ role: "user", content: `run=${runId}\n\nwave=${wave}` },
			],
			"hoja_wave_reflection",
			REFLECTION_SCHEMA,
			validateReflection,
			signal,
		);
		return { ...completion, runId };
	}

	private async complete(
		messages: readonly unknown[],
		schemaName: string,
		schema: Readonly<Record<string, unknown>>,
		validate: ValidateFunction,
		signal?: AbortSignal,
	): Promise<{
		model: string;
		requestId: string;
		durationMs: number;
		usage: Record<string, number>;
		result: unknown;
	}> {
		const requestId = randomUUID();
		const startedAt = Date.now();
		let usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0 };
		const requestBody = JSON.stringify({
			model: this.model,
			messages,
			response_format: {
				type: "json_schema",
				json_schema: { name: schemaName, strict: true, schema: portableProviderSchema(schema) },
			},
			provider: { require_parameters: true },
			// GPT-5 routes do not advertise temperature; require_parameters would reject the whole route.
			max_completion_tokens: EVALUATION_MAX_COMPLETION_TOKENS,
		});
		// The credit gate, once per provider call and before the platform key is used. A refusal throws here,
		// outside the try below, so it is not reported as a (zero-cost) usage event.
		await this.admit?.({
			requestId,
			model: this.model,
			maxCompletionTokens: EVALUATION_MAX_COMPLETION_TOKENS,
			estimatedInputTokens: estimateEvaluationInputTokens(messages),
		});
		try {
			// A route that has drifted off its strict-JSON contract gets exactly
			// one bounded retry of the identical request; every other failure
			// class throws immediately.
			for (let attempt = 0; ; attempt += 1) {
				const response = await this.fetchFn(this.endpoint, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${this.apiKey}`,
						"content-type": "application/json",
						"HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER ?? "https://sophia-labs.com",
						"X-OpenRouter-Title": process.env.OPENROUTER_TITLE ?? "Sophia Hoja Swarm",
					},
					body: requestBody,
					signal,
				});
				const payload = (await readBoundedJson(response, 2 * 1024 * 1024)) as Record<string, unknown>;
				if (!response.ok) {
					throw new Error(
						`evaluation: OpenRouter request failed (${response.status}): ${safeProviderError(payload)}`,
					);
				}
				const attemptUsage = parseUsage(payload.usage);
				usage = {
					inputTokens: usage.inputTokens + attemptUsage.inputTokens,
					outputTokens: usage.outputTokens + attemptUsage.outputTokens,
					totalTokens: usage.totalTokens + attemptUsage.totalTokens,
					cacheReadTokens: usage.cacheReadTokens + attemptUsage.cacheReadTokens,
				};
				let result: unknown;
				try {
					result = parseCompletionResult(payload);
				} catch (error) {
					if (error instanceof StructuredOutputParseError && attempt === 0) continue;
					throw error;
				}
				if (!validate(result)) {
					throw new Error(
						`evaluation: model output violated the JSON contract: ${ajv.errorsText(validate.errors)}`,
					);
				}
				const durationMs = Date.now() - startedAt;
				this.onUsage?.({ requestId, model: this.model, durationMs, outcome: "ok", ...usage });
				return { model: this.model, requestId, durationMs, usage, result };
			}
		} catch (error) {
			this.onUsage?.({
				requestId,
				model: this.model,
				durationMs: Date.now() - startedAt,
				outcome: "error",
				...usage,
			});
			throw error;
		}
	}
}

const NON_PORTABLE_PROVIDER_SCHEMA_KEYWORDS = new Set([
	"minLength",
	"maxLength",
	"pattern",
	"minimum",
	"maximum",
	"minItems",
	"maxItems",
]);

/** Providers disagree on validation keywords; structural output is provider-owned, bounds remain host-owned. */
function portableProviderSchema(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(portableProviderSchema);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key]) => !NON_PORTABLE_PROVIDER_SCHEMA_KEYWORDS.has(key))
			.map(([key, child]) => [key, portableProviderSchema(child)]),
	);
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
	const length = Number(response.headers.get("content-length"));
	if (Number.isFinite(length) && length > maxBytes)
		throw new Error("evaluation: provider response exceeds the read bound");
	const bytes = Buffer.from(await response.arrayBuffer());
	if (bytes.byteLength > maxBytes) throw new Error("evaluation: provider response exceeds the read bound");
	try {
		return JSON.parse(bytes.toString("utf8"));
	} catch {
		throw new Error("evaluation: provider returned invalid JSON");
	}
}

const PARSE_SNIPPET_BOUND = 200;

/** A provider returned text where its strict-JSON contract promised JSON. Retryable once. */
class StructuredOutputParseError extends Error {
	constructor(content: string) {
		const snippet = content.slice(0, PARSE_SNIPPET_BOUND).replace(/\s+/g, " ").trim();
		super(`evaluation: structured model output was not JSON (content begins: ${JSON.stringify(snippet)})`);
	}
}

/**
 * Best-effort recovery of a JSON payload from noisy model content: prefer the
 * body of a markdown code fence when one exists, then take the first balanced
 * top-level object/array. Returns undefined when nothing parseable exists —
 * schema validation downstream still polices whatever is recovered.
 */
function extractJsonPayload(content: string): unknown {
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(content);
	for (const candidate of fenced ? [fenced[1], content] : [content]) {
		const value = firstBalancedJson(candidate);
		if (value !== undefined) return value;
	}
	return undefined;
}

function firstBalancedJson(text: string): unknown {
	const start = text.search(/[{[]/);
	if (start < 0) return undefined;
	const open = text[start];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === open) depth += 1;
		else if (ch === close) {
			depth -= 1;
			if (depth === 0) {
				try {
					return JSON.parse(text.slice(start, i + 1));
				} catch {
					return undefined;
				}
			}
		}
	}
	return undefined;
}

function parseCompletionResult(payload: Record<string, unknown>): unknown {
	const choices = payload.choices;
	if (!Array.isArray(choices) || choices.length === 0) throw new Error("evaluation: provider omitted choices");
	const choice = asRecord(choices[0], "choice");
	const message = asRecord(choice.message, "message");
	if (typeof message.content !== "string") throw new Error("evaluation: provider omitted textual structured output");
	try {
		return JSON.parse(message.content);
	} catch {
		const recovered = extractJsonPayload(message.content);
		if (recovered !== undefined) return recovered;
		throw new StructuredOutputParseError(message.content);
	}
}

function parseUsage(value: unknown): {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	cacheReadTokens: number;
} {
	const usage =
		typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const details =
		typeof usage.prompt_tokens_details === "object" && usage.prompt_tokens_details !== null
			? (usage.prompt_tokens_details as Record<string, unknown>)
			: {};
	const inputTokens = nonnegativeInteger(usage.prompt_tokens);
	const outputTokens = nonnegativeInteger(usage.completion_tokens);
	return {
		inputTokens,
		outputTokens,
		totalTokens: nonnegativeInteger(usage.total_tokens) || inputTokens + outputTokens,
		cacheReadTokens: nonnegativeInteger(details.cached_tokens),
	};
}

function nonnegativeInteger(value: unknown): number {
	return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function safeProviderError(payload: Record<string, unknown>): string {
	const error =
		typeof payload.error === "object" && payload.error !== null ? (payload.error as Record<string, unknown>) : {};
	const outer = typeof error.message === "string" ? error.message : "provider error";
	const metadata =
		typeof error.metadata === "object" && error.metadata !== null ? (error.metadata as Record<string, unknown>) : {};
	if (typeof metadata.raw === "string") {
		try {
			const nested = JSON.parse(metadata.raw) as { error?: { message?: unknown } };
			if (typeof nested.error?.message === "string") return `${outer}: ${nested.error.message}`.slice(0, 1000);
		} catch {
			// Provider-owned raw text is not safe to echo; only parsed error.message is admitted.
		}
	}
	return outer.slice(0, 1000);
}

function evidenceLocation(args: Record<string, unknown>, engine: string): [string, string, string, string] {
	return [
		evidenceId(args.runId, "runId"),
		evidenceId(args.scenarioId, "scenarioId"),
		evidenceId(args.beatId, "beatId"),
		engine,
	];
}

function evidenceId(value: unknown, name: string): string {
	if (typeof value !== "string" || !EVIDENCE_ID.test(value)) throw new Error(`evaluation: invalid ${name}`);
	return value;
}

function asEvidenceRef(value: unknown, name: string): EvidenceRef {
	const ref = asRecord(value, name);
	return ref as unknown as EvidenceRef;
}

function assertPng(ref: EvidenceRef, name: string): void {
	if (ref.mediaType !== "image/png") throw new Error(`evaluation: ${name} must be image/png evidence`);
}

function padPng(source: PNG, width: number, height: number): PNG {
	if (source.width === width && source.height === height) return source;
	const result = new PNG({ width, height, fill: true });
	PNG.bitblt(source, result, 0, 0, source.width, source.height, 0, 0);
	return result;
}

function boundedString(value: unknown, name: string, max: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) {
		throw new Error(`evaluation: invalid ${name}`);
	}
	return value;
}

function boundedJson(value: unknown, maxBytes: number): string {
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch {
		throw new Error("evaluation: input must be JSON-serializable");
	}
	if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > maxBytes) {
		throw new Error("evaluation: input exceeds the JSON bound");
	}
	return encoded;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error(`evaluation: ${name} must be an object`);
	return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
	const extra = Object.keys(value).filter((key) => !allowed.includes(key));
	if (extra.length) throw new Error(`evaluation: ${name} has unknown fields: ${extra.sort().join(", ")}`);
}
