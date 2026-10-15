import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	loadOpenRouterModelCatalog,
	normalizeRawPricing,
	type OpenRouterCatalogPayload,
	type OpenRouterModelRow,
	type OpenRouterOptions,
	selectOpenRouterModels,
} from "./openrouter.js";
import type { TrustedModelDescriptor } from "./wire-protocol.js";

export type { TrustedModelDescriptor } from "./wire-protocol.js";

const SNAPSHOT_SCHEMA_VERSION = 1 as const;
const DEFAULT_TTL_MS = 15 * 60_000;

type CatalogSource = "disk" | "live" | "static";

interface CatalogLoadRequest {
	includeLive: boolean;
	failOnLiveError: boolean;
}

type CatalogLoader = (request: CatalogLoadRequest) => Promise<OpenRouterCatalogPayload>;

export interface ModelCatalogResolver {
	resolveModel(
		provider: string,
		modelId: string,
		options?: { requireTools?: boolean },
	): Promise<TrustedModelDescriptor | undefined>;
	/** Optional trusted enumeration used only for host-admitted headed model pickers. */
	listModels?(provider: string): Promise<readonly TrustedModelDescriptor[]>;
}

/** The rows of a catalogue snapshot, unclamped, with where they came from. */
export interface CatalogueSnapshotRows {
	readonly rows: readonly OpenRouterModelRow[];
	readonly digest: string;
	readonly fetchedAt: string;
	readonly stale: boolean;
	/** True when the provider was asked and did not answer, so only the bundled (not live, not priced) rows are here. */
	readonly bundledOnly: boolean;
	/** The exact bytes the digest names (sha256 of this text is `digest`): what an archive of the snapshot keeps. */
	readonly coreJson: () => string;
}

export interface ResolvedCatalogueRow {
	readonly row: OpenRouterModelRow;
	readonly digest: string;
	readonly fetchedAt: string;
	/** The exact bytes the digest names, so the snapshot a price came from can be archived and verified. */
	readonly coreJson: () => string;
}

export interface OpenRouterCatalogView extends OpenRouterCatalogPayload {
	cache: {
		state: "fresh" | "stale";
		source: CatalogSource;
		age_ms: number;
		ttl_ms: number;
		digest: string;
		refreshing: boolean;
		last_error?: string;
	};
}

export interface OpenRouterModelCatalogOptions {
	snapshotPath: string;
	ttlMs?: number;
	refreshIntervalMs?: number;
	refreshOnInit?: boolean;
	authConfigured?: boolean;
	request?: OpenRouterOptions;
	loadCatalog?: CatalogLoader;
	now?: () => number;
}

interface PersistedCatalogSnapshot {
	schema_version: typeof SNAPSHOT_SCHEMA_VERSION;
	provider: "openrouter";
	fetched_at: string;
	catalog_count: number;
	live_count: number;
	models: OpenRouterModelRow[];
	digest: string;
}

interface RuntimeCatalogSnapshot extends PersistedCatalogSnapshot {
	source: CatalogSource;
}

export class ModelCapabilityError extends Error {
	readonly code = "model_capability_missing";

	constructor(
		readonly provider: string,
		readonly modelId: string,
		readonly capability: string,
	) {
		super(`${provider}/${modelId} does not advertise required capability: ${capability}`);
		this.name = "ModelCapabilityError";
	}
}

/**
 * Trusted host-side OpenRouter catalog.
 *
 * The sandbox never reaches the catalog endpoint. The host hydrates a validated
 * last-known-good snapshot, refreshes it in the background, deduplicates refresh
 * requests, and forwards only a normalized descriptor into an agent spawn.
 */
export class OpenRouterModelCatalog implements ModelCatalogResolver {
	private readonly snapshotPath: string;
	private readonly ttlMs: number;
	private readonly refreshIntervalMs: number;
	private readonly refreshOnInit: boolean;
	private readonly authConfigured: boolean;
	private readonly loadCatalog: CatalogLoader;
	private readonly now: () => number;

	private snapshot?: RuntimeCatalogSnapshot;
	private lastError?: string;
	private initializePromise?: Promise<void>;
	private refreshPromise?: Promise<RuntimeCatalogSnapshot>;
	private refreshTimer?: ReturnType<typeof setInterval>;

	constructor(options: OpenRouterModelCatalogOptions) {
		this.snapshotPath = options.snapshotPath;
		this.ttlMs = positiveDuration(options.ttlMs, DEFAULT_TTL_MS);
		this.refreshIntervalMs = positiveDuration(options.refreshIntervalMs, this.ttlMs, true);
		this.refreshOnInit = options.refreshOnInit ?? true;
		this.authConfigured = options.authConfigured ?? Boolean(options.request?.apiKey);
		this.now = options.now ?? Date.now;
		this.loadCatalog =
			options.loadCatalog ??
			((request) =>
				loadOpenRouterModelCatalog({
					...options.request,
					includeLive: request.includeLive,
					failOnLiveError: request.failOnLiveError,
				}));
	}

	initialize(): Promise<void> {
		if (!this.initializePromise) {
			this.initializePromise = this.initializeInner();
		}
		return this.initializePromise;
	}

	close(): void {
		if (this.refreshTimer) clearInterval(this.refreshTimer);
		this.refreshTimer = undefined;
	}

	refresh(): Promise<RuntimeCatalogSnapshot> {
		if (this.refreshPromise) return this.refreshPromise;

		const pending = this.performRefresh().finally(() => {
			if (this.refreshPromise === pending) this.refreshPromise = undefined;
		});
		this.refreshPromise = pending;
		return pending;
	}

	async list(
		options: { query?: string; limit?: number; sort?: "id" | "prompt_price" } = {},
	): Promise<OpenRouterCatalogView> {
		const snapshot = await this.readySnapshot();
		if (this.isStale(snapshot)) void this.refresh().catch(() => undefined);

		const selected = selectOpenRouterModels(this.toPayload(snapshot), options);
		return {
			...selected,
			cache: this.cacheMetadata(snapshot),
		};
	}

	/**
	 * Every row of the current snapshot, with its provenance and no limit (`list` clamps to 500). A host
	 * that has only booted its bundled catalogue asks the provider for live rows first, because the bundled
	 * rows are not live and carry no live prices; if that fails the static rows are returned as they are
	 * and callers will honestly find them not live.
	 */
	async snapshotRows(): Promise<CatalogueSnapshotRows> {
		const snapshot = await this.currentSnapshot();
		return {
			rows: snapshot.models,
			digest: snapshot.digest,
			fetchedAt: snapshot.fetched_at,
			stale: this.isStale(snapshot),
			bundledOnly: snapshot.source === "static",
			coreJson: () => snapshotCoreJson(snapshot),
		};
	}

	/**
	 * One catalogue row by id or canonical id, with the snapshot it came from. Like `resolveModel` it asks the
	 * provider once more before saying a model is unknown; unlike it, it hands back the row itself, so a caller
	 * can read live prices and modalities, not only the descriptor a spawn needs. `undefined` means the provider
	 * was asked and does not list the model. If it could not be asked, that is an outage and this throws: absence
	 * was never established, so a caller must not tell a person their model does not exist.
	 */
	async resolveRow(modelId: string): Promise<ResolvedCatalogueRow | undefined> {
		if (modelId.trim() === "") return undefined;
		let snapshot = await this.currentSnapshot();
		let row = findModel(snapshot.models, modelId);
		if (!row) {
			snapshot = await this.refresh();
			row = findModel(snapshot.models, modelId);
		}
		const resolvedFrom = snapshot;
		return row
			? {
					row,
					digest: resolvedFrom.digest,
					fetchedAt: resolvedFrom.fetched_at,
					coreJson: () => snapshotCoreJson(resolvedFrom),
				}
			: undefined;
	}

	/** The snapshot to read rows from: never a bundled-only one if a live one can be had. */
	private async currentSnapshot(): Promise<RuntimeCatalogSnapshot> {
		let snapshot = await this.readySnapshot();
		if (snapshot.source === "static") {
			try {
				snapshot = await this.refresh();
			} catch {
				// The bundled rows stay: they are not live, and admission will say so.
			}
		} else if (this.isStale(snapshot)) {
			void this.refresh().catch(() => undefined);
		}
		return snapshot;
	}

	async resolveModel(
		provider: string,
		modelId: string,
		options: { requireTools?: boolean } = {},
	): Promise<TrustedModelDescriptor | undefined> {
		if (provider !== "openrouter" || modelId.startsWith("mock:") || modelId.trim() === "") return undefined;

		let snapshot = await this.readySnapshot();
		if (this.isStale(snapshot)) void this.refresh().catch(() => undefined);

		let row = findModel(snapshot.models, modelId);
		if (!row) {
			try {
				snapshot = await this.refresh();
				row = findModel(snapshot.models, modelId);
			} catch {
				return undefined;
			}
		}
		if (!row) return undefined;

		if (options.requireTools && row.supports_tools === false) {
			throw new ModelCapabilityError(provider, modelId, "tools");
		}

		return descriptorFromRow(row, modelId, snapshot);
	}

	private async initializeInner(): Promise<void> {
		this.snapshot = await this.readSnapshot();

		if (!this.snapshot) {
			try {
				const baseline = await this.loadCatalog({ includeLive: false, failOnLiveError: false });
				this.snapshot = snapshotFromPayload(baseline, "static", false);
			} catch (error) {
				this.rememberError(error, "static catalog bootstrap failed");
			}
		}

		if (this.refreshIntervalMs > 0) {
			this.refreshTimer = setInterval(() => {
				void this.refresh().catch(() => undefined);
			}, this.refreshIntervalMs);
			this.refreshTimer.unref?.();
		}

		if (this.refreshOnInit) void this.refresh().catch(() => undefined);
	}

	private async readySnapshot(): Promise<RuntimeCatalogSnapshot> {
		await this.initialize();
		if (this.snapshot) return this.snapshot;
		return this.refresh();
	}

	private async performRefresh(): Promise<RuntimeCatalogSnapshot> {
		try {
			const payload = await this.loadCatalog({ includeLive: true, failOnLiveError: true });
			const snapshot = snapshotFromPayload(payload, "live", true);
			this.snapshot = snapshot;
			this.lastError = undefined;
			try {
				await this.persistSnapshot(snapshot);
			} catch (error) {
				this.rememberError(error, "catalog snapshot persist failed");
			}
			return snapshot;
		} catch (error) {
			this.rememberError(error, "OpenRouter catalog refresh failed");
			throw error;
		}
	}

	private async readSnapshot(): Promise<RuntimeCatalogSnapshot | undefined> {
		try {
			const value = JSON.parse(await readFile(this.snapshotPath, "utf8")) as unknown;
			return snapshotFromPersisted(value);
		} catch (error) {
			if (isNodeError(error, "ENOENT")) return undefined;
			this.rememberError(error, "ignored invalid catalog snapshot");
			return undefined;
		}
	}

	private async persistSnapshot(snapshot: RuntimeCatalogSnapshot): Promise<void> {
		const persisted: PersistedCatalogSnapshot = {
			schema_version: snapshot.schema_version,
			provider: snapshot.provider,
			fetched_at: snapshot.fetched_at,
			catalog_count: snapshot.catalog_count,
			live_count: snapshot.live_count,
			models: snapshot.models,
			digest: snapshot.digest,
		};
		await mkdir(dirname(this.snapshotPath), { recursive: true });
		const temporaryPath = `${this.snapshotPath}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporaryPath, `${JSON.stringify(persisted)}\n`, { encoding: "utf8", mode: 0o600 });
		await rename(temporaryPath, this.snapshotPath);
	}

	private isStale(snapshot: RuntimeCatalogSnapshot): boolean {
		return snapshot.source === "static" || this.now() - Date.parse(snapshot.fetched_at) >= this.ttlMs;
	}

	private toPayload(snapshot: RuntimeCatalogSnapshot): OpenRouterCatalogPayload {
		return {
			provider: "openrouter",
			fetched_at: snapshot.fetched_at,
			auth_configured: this.authConfigured,
			catalog_count: snapshot.catalog_count,
			live_count: snapshot.live_count,
			models: snapshot.models,
		};
	}

	private cacheMetadata(snapshot: RuntimeCatalogSnapshot): OpenRouterCatalogView["cache"] {
		const ageMs = Math.max(0, this.now() - Date.parse(snapshot.fetched_at));
		return {
			state: this.isStale(snapshot) ? "stale" : "fresh",
			source: snapshot.source,
			age_ms: ageMs,
			ttl_ms: this.ttlMs,
			digest: snapshot.digest,
			refreshing: Boolean(this.refreshPromise),
			...(this.lastError ? { last_error: this.lastError } : {}),
		};
	}

	private rememberError(error: unknown, prefix: string): void {
		const message = error instanceof Error ? error.message : String(error);
		this.lastError = `${prefix}: ${message}`;
	}
}

function snapshotFromPayload(
	payload: OpenRouterCatalogPayload,
	source: CatalogSource,
	requireLive: boolean,
): RuntimeCatalogSnapshot {
	if (payload.provider !== "openrouter") throw new Error(`unexpected catalog provider: ${payload.provider}`);
	const fetchedAt = normalizeTimestamp(payload.fetched_at);
	const models = normalizeRows(payload.models);
	if (models.length === 0) throw new Error("catalog contained no valid models");
	if (requireLive && (payload.live_count <= 0 || !models.some((model) => model.live_available))) {
		throw new Error("live OpenRouter catalog contained no available models");
	}

	const core = {
		schema_version: SNAPSHOT_SCHEMA_VERSION,
		provider: "openrouter" as const,
		fetched_at: fetchedAt,
		catalog_count: nonNegativeInteger(payload.catalog_count),
		live_count: nonNegativeInteger(payload.live_count),
		models,
	};
	return { ...core, digest: digestSnapshot(core), source };
}

function snapshotFromPersisted(value: unknown): RuntimeCatalogSnapshot {
	if (!isRecord(value)) throw new Error("catalog snapshot must be an object");
	if (value.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
		throw new Error(`unsupported catalog snapshot schema: ${String(value.schema_version)}`);
	}
	if (value.provider !== "openrouter") throw new Error(`unexpected catalog provider: ${String(value.provider)}`);

	const core = {
		schema_version: SNAPSHOT_SCHEMA_VERSION,
		provider: "openrouter" as const,
		fetched_at: normalizeTimestamp(value.fetched_at),
		catalog_count: nonNegativeInteger(value.catalog_count),
		live_count: nonNegativeInteger(value.live_count),
		models: normalizeRows(value.models),
	};
	if (core.models.length === 0) throw new Error("catalog snapshot contained no valid models");
	const digest = digestSnapshot(core);
	if (value.digest !== digest) throw new Error("catalog snapshot digest mismatch");
	return { ...core, digest, source: "disk" };
}

function normalizeRows(value: unknown): OpenRouterModelRow[] {
	if (!Array.isArray(value)) throw new Error("catalog models must be an array");
	const rows = value.flatMap((entry) => {
		const row = normalizeRow(entry);
		return row ? [row] : [];
	});
	rows.sort((left, right) => left.id.localeCompare(right.id));
	return rows;
}

function normalizeRow(value: unknown): OpenRouterModelRow | undefined {
	if (!isRecord(value)) return undefined;
	const id = nonEmptyString(value.id);
	if (!id) return undefined;
	const catalogCost = isRecord(value.catalog_cost_per_million)
		? {
				input: nonNegativeNumber(value.catalog_cost_per_million.input),
				output: nonNegativeNumber(value.catalog_cost_per_million.output),
				cacheRead: nonNegativeNumber(value.catalog_cost_per_million.cacheRead),
				cacheWrite: nonNegativeNumber(value.catalog_cost_per_million.cacheWrite),
			}
		: null;

	return {
		id,
		canonical_id: nullableString(value.canonical_id),
		name: nonEmptyString(value.name) ?? id,
		description: nullableString(value.description),
		created: nullableNonNegativeNumber(value.created),
		prompt_price: nullableNonNegativeNumber(value.prompt_price),
		completion_price: nullableNonNegativeNumber(value.completion_price),
		request_price: nullableNonNegativeNumber(value.request_price),
		image_price: nullableNonNegativeNumber(value.image_price),
		cache_read_price: nullableNonNegativeNumber(value.cache_read_price),
		cache_write_price: nullableNonNegativeNumber(value.cache_write_price),
		pricing_raw: normalizeRawPricing(value.pricing_raw),
		context_length: nullablePositiveInteger(value.context_length),
		max_completion_tokens: nullablePositiveInteger(value.max_completion_tokens),
		input_modalities: nullableStringArray(value.input_modalities),
		output_modalities: nullableStringArray(value.output_modalities),
		supported_parameters: nullableStringArray(value.supported_parameters),
		supports_tools: nullableBoolean(value.supports_tools),
		reasoning: nullableBoolean(value.reasoning),
		api: nullableString(value.api),
		base_url: nullableString(value.base_url),
		catalog_cost_per_million: catalogCost,
		live_available: value.live_available === true,
		catalog_available: value.catalog_available === true,
	};
}

function descriptorFromRow(
	row: OpenRouterModelRow,
	requestedId: string,
	snapshot: RuntimeCatalogSnapshot,
): TrustedModelDescriptor {
	const supportedParameters = row.supported_parameters ?? [];
	const input = (row.input_modalities ?? ["text"]).filter(
		(modality): modality is "text" | "image" => modality === "text" || modality === "image",
	);
	const catalogCost = row.catalog_available ? row.catalog_cost_per_million : null;
	const contextWindow = row.context_length ?? 128_000;
	const canonicalId = row.canonical_id ?? (row.id !== requestedId ? row.id : undefined);

	return {
		id: requestedId,
		...(canonicalId && canonicalId !== requestedId ? { canonicalId } : {}),
		name: row.name,
		api: "openai-completions",
		provider: "openrouter",
		reasoning:
			row.reasoning ??
			(supportedParameters.includes("reasoning") || supportedParameters.includes("reasoning_effort")),
		input: input.length > 0 ? input : ["text"],
		cost: catalogCost ?? {
			input: (row.prompt_price ?? 0) * 1_000_000,
			output: (row.completion_price ?? 0) * 1_000_000,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow,
		maxTokens: row.max_completion_tokens ?? Math.min(4_096, contextWindow),
		supportedParameters,
		supportsTools: row.supports_tools,
		catalogDigest: snapshot.digest,
		catalogFetchedAt: snapshot.fetched_at,
	};
}

/** An OpenRouter variant id: `openai/gpt-5:batch`, `qwen/qwen3.8-27b:free`. */
const VARIANT_SUFFIX = /:[a-z0-9_-]+$/i;

/**
 * A model by its id, else by its canonical slug. A canonical slug is shared by a model and its `:batch` or `:free`
 * variants; asked for by slug, the model itself is meant, so it is preferred to its variants.
 */
function findModel(models: OpenRouterModelRow[], modelId: string): OpenRouterModelRow | undefined {
	const exact = models.find((model) => model.id === modelId);
	if (exact) return exact;
	const canonical = models.filter((model) => model.canonical_id === modelId);
	return canonical.find((model) => !VARIANT_SUFFIX.test(model.id)) ?? canonical[0];
}

/** The snapshot without its digest, in the key order the digest is taken over. */
function snapshotCore(snapshot: Omit<PersistedCatalogSnapshot, "digest">): Omit<PersistedCatalogSnapshot, "digest"> {
	return {
		schema_version: snapshot.schema_version,
		provider: snapshot.provider,
		fetched_at: snapshot.fetched_at,
		catalog_count: snapshot.catalog_count,
		live_count: snapshot.live_count,
		models: snapshot.models,
	};
}

function snapshotCoreJson(snapshot: Omit<PersistedCatalogSnapshot, "digest">): string {
	return JSON.stringify(snapshotCore(snapshot));
}

function digestSnapshot(core: Omit<PersistedCatalogSnapshot, "digest">): string {
	return createHash("sha256").update(snapshotCoreJson(core)).digest("hex");
}

function positiveDuration(value: number | undefined, fallback: number, allowZero = false): number {
	if (value == null) return fallback;
	if (!Number.isFinite(value)) return fallback;
	const integer = Math.trunc(value);
	if (allowZero && integer === 0) return 0;
	return integer > 0 ? integer : fallback;
}

function normalizeTimestamp(value: unknown): string {
	if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error("invalid catalog fetched_at");
	return new Date(value).toISOString();
}

function nonNegativeInteger(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function nonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function nullableNonNegativeNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function nullablePositiveInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function nullableString(value: unknown): string | null {
	return nonEmptyString(value) ?? null;
}

function nullableStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	return Array.from(new Set(value.flatMap((entry) => (nonEmptyString(entry) ? [nonEmptyString(entry)!] : []))));
}

function nullableBoolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
