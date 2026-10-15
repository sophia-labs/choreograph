/**
 * Shared real-substrate fixtures for the credit-enforcement tests (Sobremesa).
 *
 * NO MOCKS. What is here is a real orchestrator (`routeRequest`) behind a real loopback
 * HTTP server, a real `BillingStore` on a real file, real `WorkflowRuntimeStore` /
 * `JournalStore` / `SandboxStore`, a real local-native `SandboxSpawner`, and a real
 * Garden-shaped MCP cell speaking HTTP. The only stand-in is the sealed Prime runtime
 * tree whose entrypoint exits at once (the same one `workspace-chat.test.ts` uses): these
 * tests assert what happens BEFORE an agent speaks.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestAgentRuntimeBinding } from "../agent-runtime/profile.js";
import type { CreditAdmission } from "../billing-gate.js";
import type { RateCardV1 } from "../billing-rate-card.js";
import type { BillingStore } from "../billing-store.js";
import { createSandboxEventBus, type SandboxEventBus } from "../event-bus.js";
import { OpenRouterModelCatalog } from "../model-catalog.js";
import { routeRequest } from "../orchestrator.js";
import { digestSophiaAgentSourceTree } from "../runtime-bundles.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import { INVOCATION_ENVELOPE_SCHEMA } from "../workflow/invocation.js";
import { JournalStore } from "../workflow/journal-store.js";
import { listWorkflows } from "../workflow/registry.js";
import { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { WORKSPACE_CHAT_WORKFLOW_NAME } from "../workflow/workspace-chat.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";
import { openBilling } from "./billing-ledger-fixture.js";
import { fullCatalogue } from "./fixtures/openrouter-catalogue.fixture.js";
import { GardenDocumentCell } from "./garden-document-cell.js";

export { drainTo, openBilling, seedBalance, usageEvent } from "./billing-ledger-fixture.js";

export type RouteCtx = Parameters<typeof routeRequest>[2];

// ─── A real orchestrator on loopback ─────────────────────────────────────────

export interface LoopbackOrchestrator {
	readonly baseUrl: string;
	close(): Promise<void>;
}

/** `routeRequest` behind a real HTTP server on 127.0.0.1. `ctxOf` is read per request. */
export async function startLoopbackOrchestrator(ctxOf: () => RouteCtx): Promise<LoopbackOrchestrator> {
	const server: Server = createServer((request, response) => {
		routeRequest(request, response, ctxOf()).catch((error: unknown) => {
			if (response.headersSent) {
				response.end();
				return;
			}
			response.statusCode = 500;
			response.setHeader("content-type", "application/json; charset=utf-8");
			response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}

export interface HttpResult {
	readonly status: number;
	readonly headers: Headers;
	readonly text: string;
	readonly body: unknown;
}

export async function httpJson(
	baseUrl: string,
	method: "GET" | "POST",
	path: string,
	options: { body?: unknown; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: {
			...(options.body === undefined ? {} : { "content-type": "application/json" }),
			...options.headers,
		},
		...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
	});
	const text = await response.text();
	let body: unknown;
	try {
		body = text ? JSON.parse(text) : undefined;
	} catch {
		body = text;
	}
	return { status: response.status, headers: response.headers, text, body };
}

/** The internal-service identity the gateway presents on a person's behalf. */
export const INTERNAL_SECRET = "shared-secret";
export function asPerson(userId: string, extra: Record<string, string> = {}): Record<string, string> {
	return { "x-internal-service": INTERNAL_SECRET, "x-user-id": userId, ...extra };
}

// ─── A durable chat session, without a running body ──────────────────────────

export interface SeededSession {
	readonly sessionId: string;
	readonly runId: string;
	readonly ownerUserId: string;
	readonly graphId: string;
	readonly model: string;
}

/**
 * A real durable Agent Session row (owner, pinned provider/model) with no materialization. With `pricing` it is
 * pinned to that rate card, as a chat admitted from the live catalogue is; without it, a legacy Session.
 */
export async function seedAgentSession(
	runtime: WorkflowRuntimeStore,
	input: { suffix: string; ownerUserId: string; model: string; provider?: string; pricing?: RateCardV1 },
): Promise<SeededSession> {
	const graphId = `g-credit-${input.suffix}`;
	const sessionId = `ags-credit-${input.suffix}`;
	const runId = `wfr-credit-${input.suffix}`;
	const pilot = makeTestAgentSemanticBinding({ graphId, kind: "prime", registeredName: `pilot-${input.suffix}` });
	const emanation = makeTestAgentSemanticBinding({
		graphId,
		kind: "simple",
		registeredName: `pilot-${input.suffix}`,
	});
	await runtime.createWorkflowInstance({
		runId,
		workflowName: "credit-gate-test",
		graphId,
		ownerUserId: input.ownerUserId,
		inputs: {
			hostContext: {
				schema: "sophia.domain-agent-host-context.v1",
				runtimes: { pilot: pilot.runtime, emanation: emanation.runtime },
				ontologies: { pilot: pilot.ontology, emanation: emanation.ontology },
				emanation: {
					enabled: true,
					provider: "openrouter",
					model: "mock:done",
					maxEmanations: 1,
					maxTurns: emanation.runtime.constraints.maxTurns,
				},
				emanationToolInclude: [],
				systemPrompt: "Test.",
				toolbelt: { tools: [] },
			},
		},
		startedAt: 1,
	});
	const spec: AgentNodeSpec = {
		label: "pilot",
		phaseIndex: 0,
		prompt: "Test credit gate.",
		model: input.model,
		provider: input.provider ?? "openrouter",
		graphId,
		sessionId,
		agentId: pilot.agentId,
		runtime: pilot.runtime,
		runtimeBindingDigest: digestAgentRuntimeBinding(pilot.runtime),
		ontology: pilot.ontology,
		ontologyBindingDigest: pilot.ontologyBindingDigest,
		...(input.pricing ? { pricing: input.pricing } : {}),
	};
	await runtime.beginAgentSession({
		sessionId,
		runId,
		workflowName: "credit-gate-test",
		graphId,
		ownerUserId: input.ownerUserId,
		graphOwnerPrincipal: `user:${input.ownerUserId}`,
		spec,
		nodeKey: "pilot",
		frontier: { kind: "before-node", sessionId, ts: 1 },
		now: 1,
	});
	return { sessionId, runId, ownerUserId: input.ownerUserId, graphId, model: input.model };
}

// ─── The workspace chat route, with a real graph cell ────────────────────────

const RIG_ENV = [
	"MNEMOSYNE_INTERNAL_SERVICE_SECRET",
	"MNEMOSYNE_MCP_URL",
	"MNEMOSYNE_MCP_ACCESS_TOKEN",
	"MNEMOSYNE_API_BASE_URL",
	"MNEMOSYNE_SERVICE_TOKEN",
	"MNEMOSYNE_GATEWAY_BASE_URL",
	"CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST",
	"CHOREOGRAPH_WORKSPACE_CHAT_MODEL",
	"OPENROUTER_MODEL",
] as const;

/**
 * Everything `POST /api/invocations` and `POST /api/agent-sessions/:id/commands` need,
 * over real stores and a real loopback orchestrator. `gate` is read per request, so a test
 * swaps it between observe and enforce without rebuilding anything.
 */
export class CreditRouteRig {
	readonly workflowTails = new Set<Promise<void>>();
	gate: CreditAdmission | undefined;
	tempDir!: string;
	cell!: GardenDocumentCell;
	store!: SandboxStore;
	eventBus!: SandboxEventBus;
	spawner!: SandboxSpawner;
	journal!: JournalStore;
	runtime!: WorkflowRuntimeStore;
	billing!: BillingStore;
	server!: LoopbackOrchestrator;
	/** Present when started with `catalogue: true`: the whole real 2026-09-29 catalogue, so a chat is priced from a card. */
	catalogue: OpenRouterModelCatalog | undefined;
	private readonly saved: Record<string, string | undefined> = {};

	async start(options: { workspaceChatModel?: string; catalogue?: boolean } = {}): Promise<void> {
		for (const name of RIG_ENV) this.saved[name] = process.env[name];
		this.tempDir = mkdtempSync(join(tmpdir(), "choreograph-credit-routes-"));
		this.cell = new GardenDocumentCell();
		await this.cell.start();
		// A sealed local-native runtime tree. Its only job is to pass host admission.
		const runtimeRoot = join(this.tempDir, "runtime");
		const entry = join(runtimeRoot, "packages", "coding-agent", "src", "sophia");
		mkdirSync(entry, { recursive: true });
		writeFileSync(join(runtimeRoot, "package.json"), "{}\n");
		writeFileSync(join(runtimeRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
		writeFileSync(join(entry, "host-worker.ts"), "process.exit(3);\n");
		const runtimeDigest = digestSophiaAgentSourceTree(join(entry, "host-worker.ts")).slice("sha256:".length);
		const manifest = join(this.tempDir, "runtime-bundles.json");
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
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = INTERNAL_SECRET;
		process.env.MNEMOSYNE_MCP_URL = this.cell.url;
		process.env.MNEMOSYNE_MCP_ACCESS_TOKEN = "cell-access-token";
		process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST = manifest;
		process.env.CHOREOGRAPH_WORKSPACE_CHAT_MODEL = options.workspaceChatModel ?? "google/gemini-2.5-flash";
		delete process.env.OPENROUTER_MODEL;
		for (const name of ["MNEMOSYNE_API_BASE_URL", "MNEMOSYNE_SERVICE_TOKEN", "MNEMOSYNE_GATEWAY_BASE_URL"]) {
			delete process.env[name];
		}
		this.store = new SandboxStore(join(this.tempDir, "sandboxes.sqlite"));
		this.eventBus = createSandboxEventBus(this.store, { cleanupDelayMs: 0 });
		this.spawner = new SandboxSpawner(
			this.store,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{ sandboxMode: "local-native", defaultTimeoutMs: 10_000, eventBus: this.eventBus },
		);
		this.journal = new JournalStore(join(this.tempDir, "journal.sqlite"));
		this.runtime = new WorkflowRuntimeStore(join(this.tempDir, "runtime.sqlite"));
		await this.journal.init();
		await this.runtime.init();
		this.billing = await openBilling(this.tempDir);
		if (options.catalogue) {
			this.catalogue = new OpenRouterModelCatalog({
				snapshotPath: join(this.tempDir, "openrouter.json"),
				refreshOnInit: false,
				refreshIntervalMs: 0,
				authConfigured: true,
				loadCatalog: async () => fullCatalogue(),
			});
			await this.catalogue.initialize();
			await this.catalogue.refresh();
		}
		this.server = await startLoopbackOrchestrator(() => this.ctx());
	}

	ctx(): RouteCtx {
		return {
			spawner: this.spawner,
			eventBus: this.eventBus,
			journal: this.journal,
			runtime: this.runtime,
			billing: this.billing,
			workflowTails: this.workflowTails,
			...(this.catalogue ? { modelCatalog: this.catalogue } : {}),
			...(this.gate ? { creditGate: this.gate } : {}),
		} as never;
	}

	async stop(): Promise<void> {
		await this.server.close();
		// A headed session stays resident for its driver; stop the host, then give the async tail a bounded moment.
		await this.spawner.shutdownAll();
		await Promise.race([
			Promise.allSettled([...this.workflowTails]),
			new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
		]);
		this.catalogue?.close();
		this.journal.close();
		this.runtime.close();
		this.store.close();
		this.billing.close();
		await this.cell.stop();
		rmSync(this.tempDir, { recursive: true, force: true });
		for (const name of RIG_ENV) {
			if (this.saved[name] === undefined) delete process.env[name];
			else process.env[name] = this.saved[name];
		}
	}
}

function definitionDigest(name: string): string {
	const entry = listWorkflows().find((workflow) => workflow.name === name);
	if (!entry) throw new Error(`workflow ${name} is not registered`);
	return entry.definitionDigest;
}

/**
 * The invocation envelope the SPA sends for a first message in a graph with no Domain Agent.
 * `actorRef` must be the authenticated caller's principal (the route refuses anything else).
 */
export function workspaceChatEnvelope(
	invocationId: string,
	userId: string,
	text = "What is here?",
): Record<string, unknown> {
	return {
		schema: INVOCATION_ENVELOPE_SCHEMA,
		invocationId,
		target: {
			workflowName: WORKSPACE_CHAT_WORKFLOW_NAME,
			workflowUri: `urn:sophia:wf:${WORKSPACE_CHAT_WORKFLOW_NAME}`,
			definitionDigest: definitionDigest(WORKSPACE_CHAT_WORKFLOW_NAME),
		},
		input: {
			trigger: { kind: "sophia-cluster.message", text, resource: `graph:angels:chat:${invocationId}` },
			contextRefs: [],
			interactionMode: "headed",
		},
		actorRef: `user:${userId}`,
		graph: { ownerPrincipal: `user:${userId}`, graphId: "angels" },
	};
}

export { definitionDigest };
