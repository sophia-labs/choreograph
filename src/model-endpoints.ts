/**
 * The providers of each chat voice, as OpenRouter lists them (`GET /api/v1/models/{id}/endpoints`, public, no key), for
 * precision (`chat-precision.ts`). Each listing is kept in memory and in a snapshot file, so a restart does not start
 * blind; a listing older than its time to live (6 h by default) is read again by the next run; one older than a day is
 * not a price and is not served (as the catalogue of voices refuses prices older than a day). Reads are sequential and
 * spaced, and a run stops at the first rate-limit answer. An alias (`~vendor/name-latest`) has no listing of its own.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type ModelEndpointsRow, normalizeEndpointsResponse } from "./chat-precision.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_TTL_MS = 6 * 3_600_000;
const MAX_SERVED_AGE_MS = 24 * 3_600_000;
const SNAPSHOT_SCHEMA = "choreograph.openrouter-model-endpoints.v1";

export interface OpenRouterEndpointsCatalogOptions {
	/** Where the listings are kept between restarts; none keeps them in memory only. */
	readonly snapshotPath?: string;
	readonly baseUrl?: string;
	readonly fetchImpl?: typeof fetch;
	/** A listing older than this is read again by the next run. */
	readonly ttlMs?: number;
	/** The pause between two reads of one run. */
	readonly spacingMs?: number;
	readonly timeoutMs?: number;
	readonly now?: () => number;
}

export interface EndpointsRefreshResult {
	/** Listings read and kept. */
	readonly read: number;
	/** Models OpenRouter has no listing for (404). */
	readonly missing: number;
	/** Reads that failed (network, a bad answer, a rate limit that ended the run). */
	readonly failed: number;
	/** Listings still fresh, aliases, and models not reached because the run ended early. */
	readonly skipped: number;
}

export class OpenRouterEndpointsCatalog {
	private readonly rows = new Map<string, ModelEndpointsRow>();
	private readonly baseUrl: string;
	private readonly fetchImpl: typeof fetch;
	private readonly ttlMs: number;
	private readonly spacingMs: number;
	private readonly timeoutMs: number;
	private readonly now: () => number;
	private timer?: ReturnType<typeof setInterval>;
	private running = false;

	constructor(private readonly options: OpenRouterEndpointsCatalogOptions = {}) {
		this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
		this.fetchImpl = options.fetchImpl ?? fetch;
		this.ttlMs = options.ttlMs !== undefined && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;
		this.spacingMs = options.spacingMs !== undefined && options.spacingMs >= 0 ? options.spacingMs : 500;
		this.timeoutMs = options.timeoutMs ?? 20_000;
		this.now = options.now ?? Date.now;
	}

	/** Load the listings kept on disk; a missing or unreadable snapshot starts empty. */
	async initialize(): Promise<void> {
		if (!this.options.snapshotPath) return;
		try {
			const snapshot = JSON.parse(await readFile(this.options.snapshotPath, "utf8")) as {
				schema?: unknown;
				rows?: unknown;
			};
			if (snapshot.schema !== SNAPSHOT_SCHEMA || !Array.isArray(snapshot.rows)) return;
			for (const row of snapshot.rows as ModelEndpointsRow[]) {
				if (
					row &&
					typeof row.modelId === "string" &&
					typeof row.fetchedAt === "string" &&
					Array.isArray(row.endpoints)
				) {
					this.rows.set(row.modelId, row);
				}
			}
		} catch {
			// a missing or damaged snapshot: start empty and read again
		}
	}

	/** The listing for a model, unless it is older than a day (then it is not a price). */
	endpoints(modelId: string): ModelEndpointsRow | undefined {
		const row = this.rows.get(modelId);
		if (!row) return undefined;
		const age = this.now() - Date.parse(row.fetchedAt);
		return Number.isFinite(age) && age <= MAX_SERVED_AGE_MS ? row : undefined;
	}

	/** Read the listings of `modelIds` that are missing or older than their time to live, one at a time. */
	async refresh(modelIds: readonly string[]): Promise<EndpointsRefreshResult> {
		let read = 0;
		let missing = 0;
		let failed = 0;
		let skipped = 0;
		let first = true;
		for (let index = 0; index < modelIds.length; index++) {
			const id = modelIds[index];
			const kept = this.rows.get(id);
			if (id.startsWith("~") || (kept && this.now() - Date.parse(kept.fetchedAt) < this.ttlMs)) {
				skipped++;
				continue;
			}
			if (!first && this.spacingMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, this.spacingMs));
			first = false;
			let response: Response;
			try {
				const path = id.split("/").map(encodeURIComponent).join("/");
				response = await this.fetchImpl(`${this.baseUrl}/models/${path}/endpoints`, {
					headers: { accept: "application/json" },
					signal: AbortSignal.timeout(this.timeoutMs),
				});
			} catch {
				failed++;
				continue;
			}
			if (response.status === 429) {
				await response.body?.cancel();
				failed++;
				skipped += modelIds.length - index - 1;
				break;
			}
			if (response.status === 404) {
				await response.body?.cancel();
				missing++;
				continue;
			}
			if (!response.ok) {
				await response.body?.cancel();
				failed++;
				continue;
			}
			let row: ModelEndpointsRow | undefined;
			try {
				row = normalizeEndpointsResponse(await response.json(), new Date(this.now()).toISOString());
			} catch {
				row = undefined;
			}
			if (!row || row.modelId !== id) {
				failed++;
				continue;
			}
			this.rows.set(id, row);
			read++;
		}
		if (read > 0) await this.persist();
		return { read, missing, failed, skipped };
	}

	/** Keep the listings of `listModelIds()` fresh on an interval (a run never overlaps the previous one). */
	startBackgroundRefresh(listModelIds: () => Promise<readonly string[]>, intervalMs: number): void {
		if (this.timer || intervalMs <= 0) return;
		const run = async () => {
			if (this.running) return;
			this.running = true;
			try {
				const result = await this.refresh(await listModelIds());
				if (result.read > 0 || result.failed > 0) {
					console.error(
						`[model-endpoints] read ${result.read}, missing ${result.missing}, failed ${result.failed}, skipped ${result.skipped}`,
					);
				}
			} catch (error) {
				console.error(
					`[model-endpoints] refresh failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			} finally {
				this.running = false;
			}
		};
		void run();
		this.timer = setInterval(() => void run(), intervalMs);
		this.timer.unref?.();
	}

	close(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	private async persist(): Promise<void> {
		const path = this.options.snapshotPath;
		if (!path) return;
		const body = JSON.stringify({ schema: SNAPSHOT_SCHEMA, rows: [...this.rows.values()] });
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${process.pid}.tmp`;
		await writeFile(temporary, body, { mode: 0o600 });
		await rename(temporary, path);
	}
}
