import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import {
	type AgentSeedRefV1,
	CHAT_SEED_RENDER_MAX_CHARS,
	CHAT_SEED_SCHEMA,
	composeSeededSystemPrompt,
	parseChatSeedContent,
	renderChatSeed,
	renderChatSeedUnavailable,
} from "../chat-seed.js";
import { createSandboxEventBus, type SandboxEventBus } from "../event-bus.js";
import { routeRequest } from "../orchestrator.js";
import { digestSophiaAgentSourceTree } from "../runtime-bundles.js";
import { SandboxStore } from "../sandbox-store.js";
import { SandboxSpawner } from "../spawner.js";
import { INVOCATION_ENVELOPE_SCHEMA } from "../workflow/invocation.js";
import { JournalStore } from "../workflow/journal-store.js";
import { listWorkflows } from "../workflow/registry.js";
import { WORKSPACE_CHAT_WORKFLOW_NAME, workspaceChatSystemPrompt } from "../workflow/workspace-chat.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";
import { beginChat, dumpDatabaseFile, InspectableRuntime, withRuntime } from "./chat-runtime-fixture.js";
import {
	FORGED_STRUCTURE,
	INJECTED_INSTRUCTIONS,
	SEED_MARKER,
} from "./fixtures/adversarial-chat-seed-strings.fixture.js";
import { GardenDocumentCell, HARNESS_CELL_TOOLS } from "./garden-document-cell.js";

/**
 * The seed through the real router and the real spawner (Sobremesa sub-task 3).
 *
 * A seed is content: an old chat. The brief's rule is that the run journal, the start
 * payload, the event log and the checkpoint never hold its bytes. So a marker placed in
 * the seed is chased through every table of every database the invocation touches, and it
 * may appear in exactly one place: the `chat_seeds` table, and in the request the sandbox
 * is given.
 */

// The route's person reaches the host as the gateway's internal service with no minted role: an editor, so the
// Writer's prompt, signed with the route's House voice.
/** The harness cell serves five tools: the prompt names the Writer's that are live (exam 1, finding 7). */
const BASE_PROMPT = workspaceChatSystemPrompt({
	graphId: "angels",
	role: "editor",
	model: "test/workspace-model",
	tools: HARNESS_CELL_TOOLS,
});
const T0 = 1_790_000_000_000;

interface SeedMessageInput {
	role: "user" | "assistant";
	text: string;
	occurredAt?: string | null;
	voice?: { model: string } | null;
}

function seedBytes(messages: readonly SeedMessageInput[]): Buffer {
	return Buffer.from(JSON.stringify({ schema: CHAT_SEED_SCHEMA, messages }), "utf8");
}

const WINDOW: SeedMessageInput[] = [
	{ role: "user", text: "What did we decide about the ferry timetable?", occurredAt: "2026-07-01T10:00:00Z" },
	{
		role: "assistant",
		text: "You decided to keep the winter schedule until March.",
		occurredAt: "2026-07-01T10:00:05Z",
		voice: { model: "moonshotai/kimi-k2.5" },
	},
	{ role: "user", text: `${SEED_MARKER} ${INJECTED_INSTRUCTIONS[0]}`, occurredAt: "2026-07-03T09:30:00Z" },
	{
		role: "assistant",
		text: FORGED_STRUCTURE[0],
		occurredAt: "2026-07-03T09:30:05Z",
		voice: { model: "moonshotai/kimi-k2.5" },
	},
];

// ─── The spawner, at every activation ────────────────────────────────────────

interface BuildInput {
	readonly sessionId?: string;
	readonly generation: number;
	readonly ownerUserId?: string;
	readonly withSeed?: boolean;
	/** A different host over the same durable store: a restart. */
	readonly spawner?: SandboxSpawner;
}

describe("the system prompt is rebuilt from the durable record at every activation", () => {
	async function withSpawner(
		run: (harness: {
			runtime: InspectableRuntime;
			ref: AgentSeedRefV1;
			newSpawner: () => SandboxSpawner;
			build: (input: BuildInput) => Promise<{ system_prompt?: string }>;
		}) => Promise<void>,
	): Promise<void> {
		await withRuntime(async (runtime, dir) => {
			const stored = await runtime.putChatSeed({ ownerUserId: "user-a", bytes: seedBytes(WINDOW), now: T0 });
			const ref: AgentSeedRefV1 = {
				digest: stored.digest,
				bytes: stored.bytes,
				continuesConversation: {
					archiveConversationUrn: "urn:sophia:archive:conversation:ferry",
					revisionId: "rev-7",
				},
				window: { kept: WINDOW.length, omitted: 5, total: WINDOW.length + 5 },
				renderMaxChars: CHAT_SEED_RENDER_MAX_CHARS,
			};
			const chat = await beginChat(runtime, { n: 1, spec: { seed: ref } });
			const sandboxStore = new SandboxStore(join(dir, "sandboxes.sqlite"));
			const newSpawner = () =>
				new SandboxSpawner(sandboxStore, { parentPath: "/sys/fs/cgroup/test", version: 2 } as never, {
					chatSeeds: runtime,
				});
			const defaultSpawner = newSpawner();
			const semantic = makeTestAgentSemanticBinding({
				graphId: "g1",
				kind: "prime",
				registeredName: "chat-agent-1",
			});
			const build = async (input: BuildInput) => {
				const target: any = input.spawner ?? defaultSpawner;
				const { request } = await target.buildAgentRequest(
					"sandbox-1",
					{ template: "agent", ownerUserId: input.ownerUserId ?? "user-a" },
					{
						mode: "agent",
						model: "google/gemini-2.5-flash",
						provider: "openrouter",
						session_id: input.sessionId ?? chat.sessionId,
						generation: input.generation,
						agent_id: semantic.agentId,
						runtime_binding: semantic.runtime,
						runtime_binding_digest: semantic.runtimeBindingDigest,
						agent_ontology: semantic.ontology,
						agent_ontology_binding_digest: semantic.ontologyBindingDigest,
						system_prompt: BASE_PROMPT,
						...(input.withSeed === false ? {} : { seed_ref: ref }),
					},
				);
				return request as { system_prompt?: string };
			};
			try {
				await run({ runtime, ref, newSpawner, build });
			} finally {
				sandboxStore.close();
			}
		});
	}

	function expectedPrompt(ref: AgentSeedRefV1): string {
		const document = parseChatSeedContent(seedBytes(WINDOW).toString("utf8"));
		const rendering = renderChatSeed({ document, window: ref.window, renderMaxChars: ref.renderMaxChars });
		return composeSeededSystemPrompt(BASE_PROMPT, rendering.text);
	}

	it("appends the framed, quoted window to the host's own prompt, and quotes what an old chat tried to say", async () => {
		await withSpawner(async ({ ref, build }) => {
			const request = await build({ generation: 0 });
			assert.equal(request.system_prompt, expectedPrompt(ref));
			assert.ok(
				request.system_prompt?.startsWith(
					`${BASE_PROMPT}\n\nWhat follows is a transcript of an earlier conversation`,
				),
			);
			const lines = (request.system_prompt ?? "").split("\n");
			for (const line of lines) {
				for (const hostile of [...INJECTED_INSTRUCTIONS, SEED_MARKER, FORGED_STRUCTURE[0]]) {
					if (line.includes(hostile)) assert.ok(line.startsWith("> "), `must be quoted: ${line}`);
				}
			}
			assert.ok(lines.includes("> What did we decide about the ferry timetable?"));
		});
	});

	it("rebuilds the same prompt when the Session is regrown by a fresh host that has never seen it", async () => {
		await withSpawner(async ({ ref, build, newSpawner }) => {
			const first = await build({ generation: 0 });
			const regrown = await build({ generation: 1, spawner: newSpawner() });
			assert.equal(regrown.system_prompt, first.system_prompt);
			assert.equal(regrown.system_prompt, expectedPrompt(ref));
		});
	});

	it("tells the model plainly, and does not fail the Session, when the seed is gone", async () => {
		await withSpawner(async ({ runtime, build }) => {
			await runtime.raw("DELETE FROM chat_seed_claims");
			await runtime.raw("DELETE FROM chat_seeds");
			const request = await build({ generation: 1 });
			assert.equal(request.system_prompt, composeSeededSystemPrompt(BASE_PROMPT, renderChatSeedUnavailable()));
			assert.equal((request.system_prompt ?? "").includes(SEED_MARKER), false);
		});
	});

	it("gives a Session that never claimed the seed nothing of it, even if the record names its digest", async () => {
		await withSpawner(async ({ runtime, build }) => {
			const stranger = await beginChat(runtime, { n: 2 });
			const request = await build({ sessionId: stranger.sessionId, generation: 0 });
			assert.equal(request.system_prompt, composeSeededSystemPrompt(BASE_PROMPT, renderChatSeedUnavailable()));
			assert.equal((request.system_prompt ?? "").includes(SEED_MARKER), false);
		});
	});

	it("gives another identity nothing of it either", async () => {
		await withSpawner(async ({ build }) => {
			const request = await build({ generation: 0, ownerUserId: "user-b" });
			assert.equal(request.system_prompt, composeSeededSystemPrompt(BASE_PROMPT, renderChatSeedUnavailable()));
		});
	});

	it("leaves an ordinary chat's prompt exactly as the host wrote it", async () => {
		await withSpawner(async ({ build }) => {
			const request = await build({ generation: 0, withSeed: false });
			assert.equal(request.system_prompt, BASE_PROMPT);
		});
	});

	it("fails closed rather than starting a plain chat when the host has nothing to resolve a seed with", async () => {
		await withRuntime(async (_runtime, dir) => {
			const sandboxStore = new SandboxStore(join(dir, "sandboxes.sqlite"));
			try {
				const bare: any = new SandboxSpawner(
					sandboxStore,
					{ parentPath: "/sys/fs/cgroup/test", version: 2 } as never,
					{},
				);
				const semantic = makeTestAgentSemanticBinding({
					graphId: "g1",
					kind: "prime",
					registeredName: "chat-agent-1",
				});
				await assert.rejects(
					bare.buildAgentRequest(
						"sandbox-1",
						{ template: "agent", ownerUserId: "user-a" },
						{
							mode: "agent",
							model: "google/gemini-2.5-flash",
							provider: "openrouter",
							session_id: "ags-chat-1",
							generation: 0,
							agent_id: semantic.agentId,
							runtime_binding: semantic.runtime,
							runtime_binding_digest: semantic.runtimeBindingDigest,
							agent_ontology: semantic.ontology,
							agent_ontology_binding_digest: semantic.ontologyBindingDigest,
							system_prompt: BASE_PROMPT,
							seed_ref: {
								digest: `sha256:${"a".repeat(64)}`,
								bytes: 10,
								continuesConversation: { archiveConversationUrn: "urn:x", revisionId: "r" },
								window: { kept: 1, omitted: 0, total: 1 },
								renderMaxChars: CHAT_SEED_RENDER_MAX_CHARS,
							},
						},
					),
					/seed/i,
				);
			} finally {
				sandboxStore.close();
			}
		});
	});
});

// ─── The invocation, end to end ──────────────────────────────────────────────

class ResponseRecorder {
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

function invocationRequest(body: unknown, extraHeaders: Record<string, string> = {}) {
	return Object.assign(Readable.from([JSON.stringify(body)]), {
		method: "POST",
		url: "/api/invocations",
		headers: {
			"content-type": "application/json",
			"x-internal-service": "shared-secret",
			"x-user-id": "owner-1",
			prefer: "respond-async",
			...extraHeaders,
		},
	});
}

function digestOf(name: string): string {
	const entry = listWorkflows().find((workflow) => workflow.name === name);
	assert.ok(entry, `${name} is registered`);
	return entry.definitionDigest;
}

function chatInvocation(id: string, input: Record<string, unknown>) {
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
}

async function waitFor<T>(
	read: () => Promise<T | undefined> | T | undefined,
	label: string,
	timeoutMs = 20_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value !== undefined) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe("POST /api/invocations continuing an old chat", { concurrency: false }, () => {
	const saved: Record<string, string | undefined> = {};
	const ENV = [
		"MNEMOSYNE_INTERNAL_SERVICE_SECRET",
		"MNEMOSYNE_MCP_URL",
		"MNEMOSYNE_MCP_ACCESS_TOKEN",
		"MNEMOSYNE_API_BASE_URL",
		"MNEMOSYNE_SERVICE_TOKEN",
		"MNEMOSYNE_GATEWAY_BASE_URL",
		"CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST",
		"SOPHIA_AGENT_RUNTIME_ENTRYPOINT",
		"CHOREOGRAPH_WORKSPACE_CHAT_MODEL",
		"CHOREOGRAPH_CHAT_SEED_MAX_CHARS",
	];
	let tempDir: string;
	let cell: GardenDocumentCell;
	let store: SandboxStore;
	let eventBus: SandboxEventBus;
	let spawner: SandboxSpawner;
	let journal: JournalStore;
	let runtime: InspectableRuntime;
	const workflowTails = new Set<Promise<void>>();
	const spawnRequests: Array<{ session_id: string; generation: number; model: string; system_prompt?: string }> = [];
	const originalConsoleError = console.error;

	before(async () => {
		for (const name of ENV) saved[name] = process.env[name];
		tempDir = mkdtempSync(join(tmpdir(), "choreograph-chat-continuation-"));
		cell = new GardenDocumentCell();
		await cell.start();
		const runtimeRoot = join(tempDir, "runtime");
		const entry = join(runtimeRoot, "packages", "coding-agent", "src", "sophia");
		mkdirSync(entry, { recursive: true });
		writeFileSync(join(runtimeRoot, "package.json"), "{}\n");
		writeFileSync(join(runtimeRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
		writeFileSync(join(entry, "host-worker.ts"), "process.exit(3);\n");
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
		process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "shared-secret";
		process.env.MNEMOSYNE_MCP_URL = cell.url;
		process.env.MNEMOSYNE_MCP_ACCESS_TOKEN = "cell-access-token";
		process.env.CHOREOGRAPH_RUNTIME_BUNDLE_MANIFEST = manifest;
		// local-native mode finds the runtime it seals and launches only through this variable; without it the
		// run fails before any sandbox request is built.
		process.env.SOPHIA_AGENT_RUNTIME_ENTRYPOINT = join(entry, "host-worker.ts");
		process.env.CHOREOGRAPH_WORKSPACE_CHAT_MODEL = "test/workspace-model";
		delete process.env.CHOREOGRAPH_CHAT_SEED_MAX_CHARS;
		for (const name of ["MNEMOSYNE_API_BASE_URL", "MNEMOSYNE_SERVICE_TOKEN", "MNEMOSYNE_GATEWAY_BASE_URL"]) {
			delete process.env[name];
		}
		store = new SandboxStore(join(tempDir, "sandboxes.sqlite"));
		eventBus = createSandboxEventBus(store, { cleanupDelayMs: 0 });
		runtime = new InspectableRuntime(join(tempDir, "runtime.sqlite"));
		journal = new JournalStore(join(tempDir, "journal.sqlite"));
		spawner = new SandboxSpawner(
			store,
			{ parentPath: "local-native", managerPath: "local-native", controllers: [] },
			{ sandboxMode: "local-native", defaultTimeoutMs: 10_000, eventBus, chatSeeds: runtime },
		);
		// Observe, without changing, exactly what the host would hand a sandbox.
		const buildAgentRequest = (spawner as any).buildAgentRequest.bind(spawner);
		(spawner as any).buildAgentRequest = async (...args: unknown[]) => {
			const built = await buildAgentRequest(...args);
			spawnRequests.push(built.request);
			return built;
		};
		await journal.init();
		await runtime.init();
		console.error = () => {};
	});

	after(async () => {
		console.error = originalConsoleError;
		await spawner.shutdownAll();
		await Promise.race([
			Promise.allSettled([...workflowTails]),
			new Promise((resolve) => setTimeout(resolve, 5_000).unref()),
		]);
		journal.close();
		runtime.close();
		store.close();
		await cell.stop();
		rmSync(tempDir, { recursive: true, force: true });
		for (const name of ENV) {
			if (saved[name] === undefined) delete process.env[name];
			else process.env[name] = saved[name];
		}
	});

	const ctx = () => ({ spawner, eventBus, journal, runtime, workflowTails }) as never;
	const post = async (body: unknown) => {
		const response = new ResponseRecorder();
		await routeRequest(invocationRequest(body) as never, response as never, ctx());
		return response;
	};
	const seedInput = (digest: string, bytes: number, over: Record<string, unknown> = {}) => ({
		seedDigest: digest,
		bytes,
		continuesConversation: { archiveConversationUrn: "urn:sophia:archive:conversation:ferry", revisionId: "rev-7" },
		window: { kept: WINDOW.length, omitted: 5, total: WINDOW.length + 5 },
		title: "Ferry timetable · continued",
		...over,
	});

	it("refuses, before any run exists, a seed that is missing, another person's, mis-sized or mis-windowed", async () => {
		const stored = await runtime.putChatSeed({ ownerUserId: "owner-1", bytes: seedBytes(WINDOW), now: Date.now() });
		const someoneElses = await runtime.putChatSeed({
			ownerUserId: "owner-2",
			bytes: seedBytes([{ role: "user", text: "a private chat of someone else" }]),
			now: Date.now(),
		});
		const runsBefore = await journal.listRuns({ ownerUserId: "owner-1", limit: 100 });
		const cases: Array<[string, Record<string, unknown>, number, string]> = [
			["a digest that never existed", seedInput(`sha256:${"0".repeat(64)}`, 100), 404, "seed_not_found"],
			[
				"another person's seed",
				seedInput(someoneElses.digest, someoneElses.bytes, { window: { kept: 1, omitted: 0, total: 1 } }),
				404,
				"seed_not_found",
			],
			["a wrong byte count", seedInput(stored.digest, stored.bytes + 1), 409, "seed_bytes_mismatch"],
			[
				"a window that is not the document's",
				seedInput(stored.digest, stored.bytes, { window: { kept: 2, omitted: 3, total: 5 } }),
				400,
				"seed_window_mismatch",
			],
			["a malformed seed", { seedDigest: "nope" }, 400, "workspace_chat_input_invalid"],
		];
		for (const [index, [label, seed, status, code]] of cases.entries()) {
			const response = await post(chatInvocation(`c2chat.inv.refused-${index}`, { seed }));
			assert.equal(response.statusCode, status, `${label}: ${response.body}`);
			assert.equal(JSON.parse(response.body).error.code, code, label);
			assert.equal(response.body.includes(SEED_MARKER), false, "an error never quotes a seed");
		}
		assert.deepEqual(
			await journal.listRuns({ ownerUserId: "owner-1", limit: 100 }),
			runsBefore,
			"no run was started",
		);
	});

	it("starts the chat with the seed as a reference, hands the sandbox the framed window, and stores the bytes in one table only", async () => {
		const stored = await runtime.putChatSeed({ ownerUserId: "owner-1", bytes: seedBytes(WINDOW), now: Date.now() });
		const response = await post(
			chatInvocation("c2chat.inv.continue-1", { seed: seedInput(stored.digest, stored.bytes) }),
		);
		assert.equal(response.statusCode, 202, response.body);
		const { runId } = JSON.parse(response.body);
		assert.match(runId, /^wfr-/);

		// The run's start payload: the reference and the title, nothing of the transcript.
		const instance = await runtime.getWorkflowInstance(runId);
		assert.ok(instance);
		assert.equal(instance.inputs_json.includes(SEED_MARKER), false);
		assert.equal(instance.inputs_json.includes("ferry timetable?"), false);
		const inputs = JSON.parse(instance.inputs_json);
		const expectedRef: AgentSeedRefV1 = {
			digest: stored.digest,
			bytes: stored.bytes,
			continuesConversation: {
				archiveConversationUrn: "urn:sophia:archive:conversation:ferry",
				revisionId: "rev-7",
			},
			window: { kept: WINDOW.length, omitted: 5, total: WINDOW.length + 5 },
			renderMaxChars: CHAT_SEED_RENDER_MAX_CHARS,
		};
		assert.deepEqual(inputs.hostContext.seed, expectedRef);
		assert.deepEqual(inputs.hostContext.chat, { title: "Ferry timetable · continued" });

		// The Session exists, has claimed the seed atomically, and the sandbox was handed the framed window.
		const session = await waitFor(
			async () => (await runtime.listAgentSessionsForRun(runId, "owner-1"))[0],
			"the chat Session",
		);
		const handed = await waitFor(
			() => spawnRequests.find((request) => request.session_id === session.session_id),
			"the sandbox request",
		);
		const document = parseChatSeedContent(seedBytes(WINDOW).toString("utf8"));
		assert.equal(handed.model, "test/workspace-model");
		assert.equal(
			handed.system_prompt,
			composeSeededSystemPrompt(
				BASE_PROMPT,
				renderChatSeed({ document, window: expectedRef.window, renderMaxChars: expectedRef.renderMaxChars }).text,
			),
		);
		assert.ok(
			await runtime.readChatSeedForSession({
				sessionId: session.session_id,
				ownerUserId: "owner-1",
				digest: stored.digest,
			}),
			"the Session claimed its seed",
		);

		// The durable record: the reference and the host's own prompt, never the bytes, never the framed prompt.
		const sourceDoc = JSON.parse(session.document_json) as { source: Record<string, unknown> };
		assert.deepEqual(sourceDoc.source.seed, expectedRef);
		assert.equal(
			sourceDoc.source.systemPrompt,
			BASE_PROMPT,
			"the framed prompt is built per activation, never stored",
		);
		const catalogue = await runtime.readChatSessionCatalogue(session.session_id);
		assert.equal(catalogue?.title, "Ferry timetable · continued");
		assert.equal(catalogue?.title_source, "explicit");
		assert.deepEqual(JSON.parse(catalogue?.continues_json ?? "null"), expectedRef.continuesConversation);

		// Let the failing stub sandbox's run settle, so its failure-path writes are in the scan too.
		await Promise.race([
			Promise.allSettled([...workflowTails]),
			new Promise((resolve) => setTimeout(resolve, 10_000).unref()),
		]);

		const runtimeTables = await runtime.dumpTables();
		assert.ok(runtimeTables.chat_seeds.includes(SEED_MARKER), "the seed table holds the bytes");
		for (const [table, text] of Object.entries(runtimeTables)) {
			if (table === "chat_seeds") continue;
			assert.equal(text.includes(SEED_MARKER), false, `runtime table ${table} must not hold seed bytes`);
			assert.equal(
				text.includes("keep the winter schedule until March"),
				false,
				`runtime table ${table} holds transcript text`,
			);
		}
		for (const file of ["journal.sqlite", "sandboxes.sqlite"]) {
			const tables = await dumpDatabaseFile(join(tempDir, file));
			for (const [table, text] of Object.entries(tables)) {
				assert.equal(text.includes(SEED_MARKER), false, `${file} table ${table} must not hold seed bytes`);
				assert.equal(
					text.includes("keep the winter schedule until March"),
					false,
					`${file} table ${table} holds transcript text`,
				);
			}
		}
	});

	it("leaves an ordinary chat untouched: the host's prompt, no claim, no continuation", async () => {
		const claimsBefore = Number((await runtime.raw("SELECT COUNT(*) AS n FROM chat_seed_claims")).rows[0].n);
		const response = await post(chatInvocation("c2chat.inv.plain-1", {}));
		assert.equal(response.statusCode, 202, response.body);
		const { runId } = JSON.parse(response.body);
		const session = await waitFor(
			async () => (await runtime.listAgentSessionsForRun(runId, "owner-1"))[0],
			"the chat Session",
		);
		const handed = await waitFor(
			() => spawnRequests.find((request) => request.session_id === session.session_id),
			"the sandbox request",
		);
		assert.equal(handed.system_prompt, BASE_PROMPT);
		assert.equal(Number((await runtime.raw("SELECT COUNT(*) AS n FROM chat_seed_claims")).rows[0].n), claimsBefore);
		const catalogue = await runtime.readChatSessionCatalogue(session.session_id);
		assert.equal(catalogue?.continues_json, null);
		assert.equal(catalogue?.title_source, "first-message");
		assert.equal(catalogue?.title, "And the Sunday sailing?");
	});
});
