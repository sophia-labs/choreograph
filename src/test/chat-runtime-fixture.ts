/**
 * Shared, real-store fixtures for the Sobremesa chat suites (seed store,
 * continuation, inference, pricing). Nothing here is mocked: a temporary SQLite
 * runtime store, real Agent Sessions begun through the store's own API, and the
 * real router driven with in-memory requests. Not a test file (it is outside the
 * `*.test.ts` glob).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before } from "node:test";
import { createClient } from "@libsql/client";
import { createSandboxEventBus, type SandboxEventBus } from "../event-bus.js";
import { OpenRouterModelCatalog } from "../model-catalog.js";
import { routeRequest } from "../orchestrator.js";
import { digestSophiaAgentSourceTree } from "../runtime-bundles.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import { INVOCATION_ENVELOPE_SCHEMA } from "../workflow/invocation.js";
import { JournalStore } from "../workflow/journal-store.js";
import { listWorkflows } from "../workflow/registry.js";
import { type AgentSessionRecord, WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { WORKSPACE_CHAT_WORKFLOW_NAME } from "../workflow/workspace-chat.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";
import { realCatalogue } from "./fixtures/openrouter-real-rows.fixture.js";
import { GardenDocumentCell } from "./garden-document-cell.js";

export class InspectableRuntime extends WorkflowRuntimeStore {
	raw(sql: string, args: unknown[] = []) {
		return this.db.execute({ sql, args: args as never });
	}

	/** Every table's rows as JSON text, keyed by table name: for proving where a string is NOT stored. */
	async dumpTables(): Promise<Record<string, string>> {
		const tables = await this.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'");
		const dump: Record<string, string> = {};
		for (const table of tables.rows) {
			const name = String(table.name);
			const rows = await this.raw(`SELECT * FROM "${name.replaceAll('"', '""')}"`);
			dump[name] = JSON.stringify(rows.rows.map((row) => Object.fromEntries(Object.entries(row))));
		}
		return dump;
	}
}

/**
 * Every table of a SQLite database file, as JSON text keyed by table name, read through a fresh
 * connection: for proving that a string is in no table of the run journal, the sandbox store, or
 * the runtime store (bar the one table that may hold it).
 */
export async function dumpDatabaseFile(path: string): Promise<Record<string, string>> {
	const client = createClient({ url: `file:${path}` });
	try {
		const tables = await client.execute(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
		);
		const dump: Record<string, string> = {};
		for (const table of tables.rows) {
			const name = String(table.name);
			const rows = await client.execute(`SELECT * FROM "${name.replaceAll('"', '""')}"`);
			dump[name] = JSON.stringify(rows.rows.map((row) => Object.fromEntries(Object.entries(row))));
		}
		return dump;
	} finally {
		client.close();
	}
}

export async function withRuntime(run: (runtime: InspectableRuntime, dir: string) => Promise<void>): Promise<void> {
	const dir = mkdtempSync(join(tmpdir(), "chat-runtime-"));
	const runtime = new InspectableRuntime(join(dir, "runtime.sqlite"));
	await runtime.init();
	try {
		await run(runtime, dir);
	} finally {
		runtime.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

export interface ChatFixture {
	readonly n: number;
	readonly owner?: string;
	readonly graphId?: string;
	readonly graphOwner?: string;
	readonly prompt?: string;
	readonly title?: string;
	readonly headed?: boolean;
	readonly model?: string;
	readonly provider?: string;
	readonly now?: number;
	/** Passed straight onto the spec: the seed reference, the pricing pin. */
	readonly spec?: Partial<AgentNodeSpec>;
	/** The invocation inputs the run was started with (what `workflow_instances.inputs_json` will hold). */
	readonly inputs?: Record<string, unknown>;
}

export async function beginChat(runtime: WorkflowRuntimeStore, fixture: ChatFixture) {
	const owner = fixture.owner ?? "user-a";
	const graphId = fixture.graphId ?? "g1";
	const model = fixture.model ?? "google/gemini-2.5-flash";
	const now = fixture.now ?? fixture.n * 1_000;
	const sessionId = `ags-chat-${fixture.n}`;
	const runId = `wfr-chat-${fixture.n}`;
	const nodeKey = "1:pilot-headed";
	await runtime.createWorkflowInstance({
		runId,
		workflowName: "workspace-chat-v1",
		graphId,
		ownerUserId: owner,
		sourceSha256: "sha",
		sourceText: "export const meta = {}",
		inputs: fixture.inputs ?? { config: { graphId, model }, args: {} },
		startedAt: now,
	});
	const semantic = makeTestAgentSemanticBinding({ graphId, kind: "prime", registeredName: `chat-agent-${fixture.n}` });
	const spec: AgentNodeSpec = {
		label: "pilot-headed",
		phaseIndex: 1,
		prompt: fixture.prompt ?? `message ${fixture.n}`,
		model,
		provider: fixture.provider ?? "openrouter",
		graphId,
		toolMode: "none",
		...(fixture.headed === false ? {} : { interactionMode: "headed" as const }),
		...(fixture.title === undefined ? {} : { chat: { title: fixture.title } }),
		...semantic,
		...(fixture.spec ?? {}),
	};
	await runtime.beginAgentSession({
		sessionId,
		runId,
		workflowName: "workspace-chat-v1",
		graphId,
		ownerUserId: owner,
		graphOwnerPrincipal: fixture.graphOwner ?? "user:graph-owner",
		spec,
		nodeKey,
		frontier: { kind: "before-node", nodeKey, sessionId, label: "pilot-headed", phaseIndex: 1, ts: now },
		now,
	});
	return { sessionId, runId, nodeKey, owner, graphId };
}

export function request(
	method: string,
	url: string,
	headers: Record<string, string> = {},
	body?: unknown | Buffer | string,
	chunkSize?: number,
) {
	const raw: Buffer =
		body === undefined
			? Buffer.alloc(0)
			: Buffer.isBuffer(body)
				? body
				: Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
	return {
		method,
		url,
		headers: { host: "localhost", "x-internal-service": "test-secret", "x-user-id": "user-a", ...headers },
		on() {},
		async *[Symbol.asyncIterator]() {
			const size = chunkSize ?? Math.max(1, raw.length);
			for (let offset = 0; offset < raw.length; offset += size) yield raw.subarray(offset, offset + size);
		},
	} as unknown as IncomingMessage;
}

export function recorder() {
	let body = "";
	let statusCode = 0;
	const headers: Record<string, string> = {};
	return {
		get body() {
			return JSON.parse(body || "null") as Record<string, any>;
		},
		get statusCode() {
			return statusCode;
		},
		set statusCode(value: number) {
			statusCode = value;
		},
		headers,
		setHeader(name: string, value: string) {
			headers[name.toLowerCase()] = value;
		},
		end(value?: string) {
			body = value ?? "";
		},
	} as unknown as ServerResponse & { body: Record<string, any>; statusCode: number; headers: Record<string, string> };
}

export type RouteResponse = ReturnType<typeof recorder>;

export async function withRoutes(
	run: (harness: {
		runtime: InspectableRuntime;
		get: (url: string, headers?: Record<string, string>) => Promise<RouteResponse>;
		post: (
			url: string,
			body?: unknown | Buffer | string,
			headers?: Record<string, string>,
			chunkSize?: number,
		) => Promise<RouteResponse>;
	}) => Promise<void>,
	extraContext: Record<string, unknown> = {},
): Promise<void> {
	const previousSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
	process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "test-secret";
	try {
		await withRuntime(async (runtime) => {
			const ctx = { runtime, ...extraContext } as never;
			await run({
				runtime,
				get: async (url, headers) => {
					const response = recorder();
					await routeRequest(request("GET", url, headers), response, ctx);
					return response;
				},
				post: async (url, body, headers, chunkSize) => {
					const response = recorder();
					await routeRequest(request("POST", url, headers, body, chunkSize), response, ctx);
					return response;
				},
			});
		});
	} finally {
		if (previousSecret === undefined) delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		else process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previousSecret;
	}
}

// ─── The whole invocation path: real cell, real stores, real spawner, real catalogue ─────────────

/** What the host would hand a sandbox for one Session's body (the spawner's own request, observed, not replaced). */
export interface SpawnedRequest {
	readonly session_id: string;
	readonly generation: number;
	readonly model: string;
	readonly provider?: string;
	readonly system_prompt?: string;
	readonly model_descriptor?: { readonly id: string; readonly contextWindow: number };
}

export interface InvocationHarness {
	readonly tempDir: string;
	/** The suite's in-process Garden cell (its documents, calls and the role it answers as). */
	readonly cell: GardenDocumentCell;
	readonly runtime: InspectableRuntime;
	readonly journal: JournalStore;
	readonly spawner: SandboxSpawner;
	readonly catalogue: OpenRouterModelCatalog | undefined;
	readonly spawnRequests: readonly SpawnedRequest[];
	/** POST /api/invocations as the person `owner-1` through the real router. */
	post(body: unknown, headers?: Record<string, string>): Promise<{ statusCode: number; body: string; json: any }>;
	/** GET any route (`/api/workflows`, `/api/agent-sessions/<id>`, ...) as the person `owner-1` through the real router. */
	get(url: string, headers?: Record<string, string>): Promise<{ statusCode: number; body: string; json: any }>;
	/** A canonical workspace-chat invocation envelope in the graph `angels`. */
	chat(id: string, input?: Record<string, unknown>): Record<string, unknown>;
	waitForSession(runId: string): Promise<AgentSessionRecord>;
	waitForSpawn(sessionId: string): Promise<SpawnedRequest>;
	/** Let the failing stub sandboxes' runs settle, so failure-path writes are in whatever is scanned next. */
	settle(): Promise<void>;
}

const HARNESS_ENV = [
	"MNEMOSYNE_INTERNAL_SERVICE_SECRET",
	"MNEMOSYNE_MCP_URL",
	"MNEMOSYNE_MCP_ACCESS_TOKEN",
	"MNEMOSYNE_API_BASE_URL",
	"MNEMOSYNE_SERVICE_TOKEN",
	"MNEMOSYNE_GATEWAY_BASE_URL",
	"CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST",
	"SOPHIA_AGENT_RUNTIME_ENTRYPOINT",
	"CHOREOGRAPH_WORKSPACE_CHAT_MODEL",
	"OPENROUTER_MODEL",
	"CHOREOGRAPH_CHAT_SEED_MAX_CHARS",
	"CHOREOGRAPH_CHAT_MODEL_DENYLIST",
	"BILLING_FEE_BPS",
];

class HarnessResponse {
	statusCode = 200;
	headers = new Map<string, string>();
	body = "";
	headersSent = false;
	setHeader(name: string, value: string) {
		this.headers.set(name.toLowerCase(), value);
	}
	writeHead(status: number) {
		this.statusCode = status;
		this.headersSent = true;
	}
	end(chunk?: string) {
		this.headersSent = true;
		if (chunk) this.body += chunk;
	}
	setTimeout(_timeoutMs: number) {}
}

/**
 * Register hooks that stand up the whole invocation path for a suite and tear it down after: a real in-process
 * Garden cell, a sealed local-native runtime tree (its only job is to pass host admission: the sandbox it launches
 * exits at once), real runtime, journal and sandbox stores, a real spawner that resolves seeds from the runtime
 * store, and optionally a real `OpenRouterModelCatalog` fed the real 2026-09-29 catalogue rows.
 */
export function useInvocationHarness(
	options: {
		readonly env?: Readonly<Record<string, string>>;
		readonly catalogue?: boolean;
		/** How old the catalogue's prices are when the suite starts (default: fresh). A day and an hour is stale. */
		readonly catalogueAgeMs?: number;
		/**
		 * A scripted Prime worker (an ES module's source) to seal and launch in place of the stub that exits at once:
		 * for a suite that needs a session to speak. It is written as `host-worker.mjs` and run by node directly.
		 */
		readonly workerSource?: string;
	} = {},
): InvocationHarness {
	const saved: Record<string, string | undefined> = {};
	const workflowTails = new Set<Promise<void>>();
	const spawnRequests: SpawnedRequest[] = [];
	const originalConsoleError = console.error;
	let tempDir = "";
	let cell: GardenDocumentCell | undefined;
	let store: SandboxStore | undefined;
	let eventBus: SandboxEventBus | undefined;
	let spawner: SandboxSpawner | undefined;
	let journal: JournalStore | undefined;
	let runtime: InspectableRuntime | undefined;
	let catalogue: OpenRouterModelCatalog | undefined;

	before(async () => {
		for (const name of [...HARNESS_ENV, ...Object.keys(options.env ?? {})]) saved[name] = process.env[name];
		tempDir = mkdtempSync(join(tmpdir(), "choreograph-invocation-"));
		cell = new GardenDocumentCell();
		await cell.start();
		const runtimeRoot = join(tempDir, "runtime");
		const entry = join(runtimeRoot, "packages", "coding-agent", "src", "sophia");
		mkdirSync(entry, { recursive: true });
		writeFileSync(join(runtimeRoot, "package.json"), "{}\n");
		writeFileSync(join(runtimeRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
		// The attested tree always has its TypeScript entry; a scripted worker is sealed beside it and launched instead.
		writeFileSync(join(entry, "host-worker.ts"), "process.exit(3);\n");
		if (options.workerSource) writeFileSync(join(entry, "host-worker.mjs"), options.workerSource);
		const workerFile = join(entry, options.workerSource ? "host-worker.mjs" : "host-worker.ts");
		const runtimeDigest = digestSophiaAgentSourceTree(join(entry, "host-worker.ts")).slice("sha256:".length);
		const manifest = join(tempDir, "runtime-bundles.json");
		writeFileSync(
			manifest,
			JSON.stringify({
				bundles: [
					{
						id: "sophia-agent-runtime",
						digest: runtimeDigest,
						mounts: [{ guest_path: "/opt/choreograph-runtime/sophia-agent", mode: "ro", host_path: runtimeRoot }],
					},
				],
			}),
		);
		for (const name of HARNESS_ENV) delete process.env[name];
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "shared-secret";
		process.env.MNEMOSYNE_MCP_URL = cell.url;
		process.env.MNEMOSYNE_MCP_ACCESS_TOKEN = "cell-access-token";
		process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST = manifest;
		// local-native mode has no other way to find the runtime it seals and launches: without this the run
		// fails ("SOPHIA_AGENT_RUNTIME_ENTRYPOINT is required") before any sandbox request is built.
		process.env.SOPHIA_AGENT_RUNTIME_ENTRYPOINT = workerFile;
		process.env.CHOREOGRAPH_WORKSPACE_CHAT_MODEL = "test/workspace-model";
		for (const [name, value] of Object.entries(options.env ?? {})) process.env[name] = value;

		store = new SandboxStore(join(tempDir, "sandboxes.sqlite"));
		eventBus = createSandboxEventBus(store, { cleanupDelayMs: 0 });
		runtime = new InspectableRuntime(join(tempDir, "runtime.sqlite"));
		journal = new JournalStore(join(tempDir, "journal.sqlite"));
		if (options.catalogue) {
			catalogue = new OpenRouterModelCatalog({
				snapshotPath: join(tempDir, "openrouter.json"),
				refreshOnInit: false,
				refreshIntervalMs: 0,
				authConfigured: true,
				loadCatalog: async () =>
					realCatalogue(undefined, new Date(Date.now() - (options.catalogueAgeMs ?? 0)).toISOString()),
			});
			await catalogue.initialize();
			await catalogue.refresh();
		}
		spawner = new SandboxSpawner(
			store,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{
				sandboxMode: "local-native",
				defaultTimeoutMs: 10_000,
				eventBus,
				chatSeeds: runtime,
				...(catalogue ? { modelCatalog: catalogue } : {}),
			},
		);
		// Observe, without changing, exactly what the host would hand a sandbox.
		const target = spawner as unknown as {
			buildAgentRequest: (...args: unknown[]) => Promise<{ request: SpawnedRequest }>;
		};
		const buildAgentRequest = target.buildAgentRequest.bind(spawner);
		target.buildAgentRequest = async (...args: unknown[]) => {
			const built = await buildAgentRequest(...args);
			spawnRequests.push(built.request);
			return built;
		};
		await journal.init();
		await runtime.init();
		// The host logs every failed run; the stub sandboxes fail on purpose, so the logs are silenced unless
		// you are looking for why a run failed: HARNESS_DEBUG=1 pnpm exec tsx --test src/test/<suite>.test.ts
		if (!process.env.HARNESS_DEBUG) console.error = () => {};
	});

	after(async () => {
		console.error = originalConsoleError;
		await spawner?.shutdownAll();
		await Promise.race([
			Promise.allSettled([...workflowTails]),
			new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
		]);
		catalogue?.close();
		journal?.close();
		runtime?.close();
		store?.close();
		await cell?.stop();
		rmSync(tempDir, { recursive: true, force: true });
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	const started = <T>(value: T | undefined): T => {
		if (value === undefined) throw new Error("the invocation harness has not started");
		return value;
	};
	const digestOf = (name: string): string => {
		const entry = listWorkflows().find((workflow) => workflow.name === name);
		if (!entry) throw new Error(`${name} is not registered`);
		return entry.definitionDigest;
	};
	const waitFor = async <T>(read: () => Promise<T | undefined> | T | undefined, label: string): Promise<T> => {
		const deadline = Date.now() + 20_000;
		for (;;) {
			const value = await read();
			if (value !== undefined) return value;
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	};

	const send = async (method: string, url: string, body: unknown, headers: Record<string, string>) => {
		const response = new HarnessResponse();
		const incoming = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
			method,
			url,
			headers: {
				"content-type": "application/json",
				"x-internal-service": "shared-secret",
				"x-user-id": "owner-1",
				...headers,
			},
		});
		const ctx = {
			spawner: started(spawner),
			eventBus: started(eventBus),
			journal: started(journal),
			runtime: started(runtime),
			workflowTails,
			...(catalogue ? { modelCatalog: catalogue } : {}),
		};
		await routeRequest(incoming as never, response as never, ctx as never);
		return {
			statusCode: response.statusCode,
			body: response.body,
			json: response.body ? JSON.parse(response.body) : null,
		};
	};

	return {
		get tempDir() {
			return tempDir;
		},
		get cell() {
			return started(cell);
		},
		get runtime() {
			return started(runtime);
		},
		get journal() {
			return started(journal);
		},
		get spawner() {
			return started(spawner);
		},
		get catalogue() {
			return catalogue;
		},
		spawnRequests,
		post: (body, headers = {}) => send("POST", "/api/invocations", body, { prefer: "respond-async", ...headers }),
		get: (url, headers = {}) => send("GET", url, undefined, headers),
		chat(id, input = {}) {
			return {
				schema: INVOCATION_ENVELOPE_SCHEMA,
				invocationId: id,
				target: {
					workflowName: WORKSPACE_CHAT_WORKFLOW_NAME,
					workflowUri: `urn:sophia:wf:${WORKSPACE_CHAT_WORKFLOW_NAME}`,
					definitionDigest: digestOf(WORKSPACE_CHAT_WORKFLOW_NAME),
				},
				input: {
					trigger: {
						kind: "sophia-cluster.message",
						text: "And the Sunday sailing?",
						resource: `graph:angels:chat:${id}`,
					},
					contextRefs: [],
					interactionMode: "headed",
					...input,
				},
				actorRef: "user:owner-1",
				graph: { ownerPrincipal: "user:owner-1", graphId: "angels" },
			};
		},
		waitForSession: (runId) =>
			waitFor(async () => (await started(runtime).listAgentSessionsForRun(runId, "owner-1"))[0], "the chat Session"),
		waitForSpawn: (sessionId) =>
			waitFor(() => spawnRequests.find((request) => request.session_id === sessionId), "the sandbox request"),
		async settle() {
			await Promise.race([
				Promise.allSettled([...workflowTails]),
				new Promise((resolve) => setTimeout(resolve, 10_000).unref()),
			]);
		},
	};
}
