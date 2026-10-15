/**
 * Viewer chat (Vera's D4, 2026-10-06), Choreograph's side. The gateway will admit a person who
 * can only view a graph to start `workspace-chat-v1` and to drive their own workspace-chat sessions, and will mint
 * `x-sophia-graph-role` after its ACL check on every Choreograph route. With the header present it is the only rule:
 *
 * - a viewer starts only the workspace chat, and it is the Reader (`workspace-chat.test.ts`, route level);
 * - a viewer drives only their own workspace-chat sessions (driver, commands, steer, command cancel); any other
 *   session is 403 `viewer_session_refused`, before anything is queued;
 * - a workspace chat begun with edit rights does not speak for someone who can now only view: a turn or a steer is
 *   403 `workspace_chat_role_changed` (a stop, `abort`, is still theirs to send);
 * - an unreadable role is 400 `graph_role_invalid`; the header is believed only from the internal service.
 *
 * Without the header nothing changes (today's gateway admits these routes at Editor only).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CHAT_SEED_SCHEMA } from "../chat-seed.js";
import type { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import type { AgentNodeSpec } from "../workflow/types.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";
import { beginChat, type RouteResponse, withRoutes } from "./chat-runtime-fixture.js";

/** The graph the gateway checked, as it mints it on every graph-scoped route (`beginChat`'s graph and owner). */
const G1 = { "x-graph-id": "g1", "x-graph-owner": "user:graph-owner" };
const VIEWER = { ...G1, "x-sophia-graph-role": "viewer" };
const EDITOR = { ...G1, "x-sophia-graph-role": "editor" };
const spawner = { wakeDurableSupervision() {} };

/** A headed root session of a workflow that is not the workspace chat, owned by the same person. */
async function beginOtherSession(runtime: WorkflowRuntimeStore, n: number) {
	const sessionId = `ags-other-${n}`;
	const runId = `wfr-other-${n}`;
	await runtime.createWorkflowInstance({
		runId,
		workflowName: "domain-agent-activity-loop-v1",
		graphId: "g1",
		ownerUserId: "user-a",
		sourceSha256: "sha",
		sourceText: "export const meta = {}",
		inputs: { config: { graphId: "g1", model: "google/gemini-2.5-flash" }, args: {} },
		startedAt: n * 1_000,
	});
	const spec: AgentNodeSpec = {
		label: "pilot-headed",
		phaseIndex: 1,
		prompt: "hello",
		model: "google/gemini-2.5-flash",
		provider: "openrouter",
		graphId: "g1",
		toolMode: "none",
		interactionMode: "headed",
		graphAccess: "write",
		...makeTestAgentSemanticBinding({ graphId: "g1", kind: "prime", registeredName: `other-agent-${n}` }),
	};
	await runtime.beginAgentSession({
		sessionId,
		runId,
		workflowName: "domain-agent-activity-loop-v1",
		graphId: "g1",
		ownerUserId: "user-a",
		graphOwnerPrincipal: "user:graph-owner",
		spec,
		nodeKey: "1:pilot-headed",
		frontier: {
			kind: "before-node",
			nodeKey: "1:pilot-headed",
			sessionId,
			label: "pilot-headed",
			phaseIndex: 1,
			ts: n * 1_000,
		},
		now: n * 1_000,
	});
	return { sessionId };
}

const command = (id: string, name: string, payload: Record<string, unknown> = { text: "hello" }) => ({
	commandId: id,
	idempotencyKey: id,
	clientId: "spa-1",
	name,
	payload,
});

function refused(response: RouteResponse, status: number, code: string, label: string) {
	assert.equal(response.statusCode, status, `${label}: ${JSON.stringify(response.body)}`);
	assert.equal(response.body.code, code, label);
}

/** The seed door answers in the seed store's own error shape (`{ error: { code, message } }`). */
function refusedSeed(response: RouteResponse, status: number, code: string, label: string) {
	assert.equal(response.statusCode, status, `${label}: ${JSON.stringify(response.body)}`);
	assert.equal(response.body.error?.code, code, label);
}

describe("viewer chat: a viewer drives only their own workspace chats", () => {
	it("drives a Reader workspace chat: claims the driver, sends a turn", async () => {
		await withRoutes(
			async ({ runtime, post }) => {
				const chat = await beginChat(runtime, { n: 1, spec: { graphAccess: "read" } });
				const driver = await post(
					`/api/agent-sessions/${chat.sessionId}/driver`,
					{ action: "claim", clientId: "spa-1" },
					VIEWER,
				);
				assert.equal(driver.statusCode, 200, JSON.stringify(driver.body));
				const turn = await post(
					`/api/agent-sessions/${chat.sessionId}/commands`,
					command("v-turn-1", "follow_up"),
					VIEWER,
				);
				assert.equal(turn.statusCode, 202, JSON.stringify(turn.body));
			},
			{ spawner },
		);
	});

	it("refuses every session write on a session that is not a workspace chat, before anything is queued", async () => {
		await withRoutes(
			async ({ runtime, post }) => {
				const other = await beginOtherSession(runtime, 2);
				const base = `/api/agent-sessions/${other.sessionId}`;
				refused(
					await post(`${base}/driver`, { action: "claim", clientId: "spa-1" }, VIEWER),
					403,
					"viewer_session_refused",
					"driver",
				);
				refused(
					await post(`${base}/commands`, command("v-other-1", "follow_up"), VIEWER),
					403,
					"viewer_session_refused",
					"follow_up",
				);
				refused(
					await post(`${base}/commands`, command("v-other-2", "abort", {}), VIEWER),
					403,
					"viewer_session_refused",
					"abort",
				);
				refused(
					await post(`${base}/steer`, { clientId: "spa-1", text: "go", commandId: "v-other-3" }, VIEWER),
					403,
					"viewer_session_refused",
					"steer",
				);
				refused(
					await post(`${base}/commands/v-other-1/cancel`, { clientId: "spa-1" }, VIEWER),
					403,
					"viewer_session_refused",
					"command cancel",
				);
				for (const id of ["v-other-1", "v-other-2", "v-other-3"]) {
					assert.equal(await runtime.readAgentSessionCommand(id), null, id);
				}
				// The same person at Editor drives it as today.
				const editor = await post(`${base}/commands`, command("e-other-1", "follow_up"), EDITOR);
				assert.equal(editor.statusCode, 202, JSON.stringify(editor.body));
			},
			{ spawner },
		);
	});

	it("does not let a chat begun with edit rights speak for someone who can now only view; a stop is still theirs", async () => {
		await withRoutes(
			async ({ runtime, post }) => {
				const chat = await beginChat(runtime, { n: 3, spec: { graphAccess: "write" } });
				const base = `/api/agent-sessions/${chat.sessionId}`;
				const driver = await post(`${base}/driver`, { action: "claim", clientId: "spa-1" }, VIEWER);
				assert.equal(driver.statusCode, 200, JSON.stringify(driver.body));
				refused(
					await post(`${base}/commands`, command("w-turn-1", "follow_up"), VIEWER),
					403,
					"workspace_chat_role_changed",
					"follow_up",
				);
				refused(
					await post(`${base}/commands`, command("w-turn-2", "prompt"), VIEWER),
					403,
					"workspace_chat_role_changed",
					"prompt",
				);
				refused(
					await post(`${base}/steer`, { clientId: "spa-1", text: "go", commandId: "w-steer-1" }, VIEWER),
					403,
					"workspace_chat_role_changed",
					"steer",
				);
				assert.equal(await runtime.readAgentSessionCommand("w-turn-1"), null);
				const abort = await post(`${base}/commands`, command("w-abort-1", "abort", {}), VIEWER);
				assert.equal(abort.statusCode, 202, JSON.stringify(abort.body));
				// An editor, or a gateway that sends no role (today's), keeps the Writer chat going.
				const editor = await post(`${base}/commands`, command("w-turn-3", "follow_up"), EDITOR);
				assert.equal(editor.statusCode, 202, JSON.stringify(editor.body));
				const unminted = await post(`${base}/commands`, command("w-turn-4", "follow_up"));
				assert.equal(unminted.statusCode, 202, JSON.stringify(unminted.body));
			},
			{ spawner },
		);
	});

	it("refuses a role it cannot read on a session write, as the caller's 400", async () => {
		await withRoutes(
			async ({ runtime, post }) => {
				const chat = await beginChat(runtime, { n: 4, spec: { graphAccess: "read" } });
				for (const bad of ["", "Viewer", "admin"]) {
					refused(
						await post(
							`/api/agent-sessions/${chat.sessionId}/commands`,
							command(`bad-role-${bad}`, "follow_up"),
							{ ...G1, "x-sophia-graph-role": bad },
						),
						400,
						"graph_role_invalid",
						JSON.stringify(bad),
					);
				}
			},
			{ spawner },
		);
	});
});

const SEED = JSON.stringify({
	schema: CHAT_SEED_SCHEMA,
	messages: [{ role: "user", text: "hello", occurredAt: null }],
});

/** Run with rule 2 retired (`CHOREOGRAPH_REQUIRE_GATEWAY_GRAPH_ROLE=true`), restoring the host's setting after. */
async function withRoleRequired(run: () => Promise<void>): Promise<void> {
	const saved = process.env.CHOREOGRAPH_REQUIRE_GATEWAY_GRAPH_ROLE;
	process.env.CHOREOGRAPH_REQUIRE_GATEWAY_GRAPH_ROLE = "true";
	try {
		await run();
	} finally {
		if (saved === undefined) delete process.env.CHOREOGRAPH_REQUIRE_GATEWAY_GRAPH_ROLE;
		else process.env.CHOREOGRAPH_REQUIRE_GATEWAY_GRAPH_ROLE = saved;
	}
}

describe("exam 1: with rule 2 retired, a workspace chat act without exactly one minted role fails closed", () => {
	it("refuses an unminted follow-up, steer, abort, driver claim and command cancel on a Writer chat and on a Reader chat", async () => {
		await withRoleRequired(() =>
			withRoutes(
				async ({ runtime, post }) => {
					for (const [n, graphAccess] of [
						[11, "write"],
						[12, "read"],
					] as const) {
						const chat = await beginChat(runtime, { n, spec: { graphAccess } });
						const base = `/api/agent-sessions/${chat.sessionId}`;
						const label = (act: string) => `${graphAccess} chat, ${act}`;
						refused(
							await post(`${base}/commands`, command(`u-${n}-turn`, "follow_up"), G1),
							403,
							"graph_role_required",
							label("follow_up"),
						);
						refused(
							await post(`${base}/commands`, command(`u-${n}-prompt`, "prompt"), G1),
							403,
							"graph_role_required",
							label("prompt"),
						);
						refused(
							await post(`${base}/commands`, command(`u-${n}-abort`, "abort", {}), G1),
							403,
							"graph_role_required",
							label("abort"),
						);
						refused(
							await post(`${base}/steer`, { clientId: "spa-1", text: "go", commandId: `u-${n}-steer` }, G1),
							403,
							"graph_role_required",
							label("steer"),
						);
						refused(
							await post(`${base}/driver`, { action: "claim", clientId: "spa-1" }, G1),
							403,
							"graph_role_required",
							label("driver claim"),
						);
						refused(
							await post(`${base}/commands/u-${n}-turn/cancel`, { clientId: "spa-1" }, G1),
							403,
							"graph_role_required",
							label("command cancel"),
						);
						refused(
							await post(`${base}/cancel`, { requestId: `u-${n}-cancel`, reason: "stop" }, G1),
							403,
							"graph_role_required",
							label("session cancel"),
						);
						for (const id of [`u-${n}-turn`, `u-${n}-prompt`, `u-${n}-abort`, `u-${n}-steer`]) {
							assert.equal(await runtime.readAgentSessionCommand(id), null, label(id));
						}
						// The same act with the role the gateway minted goes on.
						const minted = await post(`${base}/commands`, command(`m-${n}-turn`, "follow_up"), EDITOR);
						assert.equal(minted.statusCode, 202, `${label("minted")}: ${JSON.stringify(minted.body)}`);
					}
				},
				{ spawner },
			),
		);
	});

	it("refuses an unminted seed, and keeps a minted one the person's", async () => {
		await withRoleRequired(() =>
			withRoutes(async ({ post }) => {
				refusedSeed(await post("/api/chat-seeds", SEED, G1), 403, "graph_role_required", "unminted seed");
				const minted = await post("/api/chat-seeds", SEED, VIEWER);
				assert.equal(minted.statusCode, 201, JSON.stringify(minted.body));
			}),
		);
	});

	it("leaves sessions that are not workspace chats to the services that drive them without a role", async () => {
		await withRoleRequired(() =>
			withRoutes(
				async ({ runtime, post }) => {
					const other = await beginOtherSession(runtime, 13);
					const response = await post(
						`/api/agent-sessions/${other.sessionId}/commands`,
						command("o-13", "follow_up"),
					);
					assert.equal(response.statusCode, 202, JSON.stringify(response.body));
				},
				{ spawner },
			),
		);
	});

	it("refuses a duplicated role header as unreadable, with the switch on or off, before anything is queued", async () => {
		for (const required of [false, true]) {
			const run = () =>
				withRoutes(
					async ({ runtime, post }) => {
						const chat = await beginChat(runtime, { n: 14, spec: { graphAccess: "read" } });
						const twice = { ...G1, "x-sophia-graph-role": ["editor", "viewer"] } as unknown as Record<
							string,
							string
						>;
						refused(
							await post(`/api/agent-sessions/${chat.sessionId}/commands`, command("d-14", "follow_up"), twice),
							400,
							"graph_role_invalid",
							`commands, required=${required}`,
						);
						assert.equal(await runtime.readAgentSessionCommand("d-14"), null);
						refusedSeed(
							await post("/api/chat-seeds", SEED, twice),
							400,
							"graph_role_invalid",
							`seed, required=${required}`,
						);
						// Node joins a repeated header with a comma; that is not a role either.
						refused(
							await post(`/api/agent-sessions/${chat.sessionId}/commands`, command("d-14b", "follow_up"), {
								...G1,
								"x-sophia-graph-role": "viewer, viewer",
							}),
							400,
							"graph_role_invalid",
							`joined, required=${required}`,
						);
					},
					{ spawner },
				);
			if (required) await withRoleRequired(run);
			else await run();
		}
	});
});

/**
 * The gateway's exam (`exam-gw1-gpt-6.1-sol-result.md`, MAJOR): the person `user-a` can only view `notes` (owner
 * `user:owner`) and owns `home`. A request addressed through `home` carries `x-graph-id: home` and a role minted for
 * `home` (`owner`); it must not reach a session that lives on `notes`. Choreograph answers exactly as for a session
 * that does not exist, so the refusal does not say that one exists elsewhere.
 */
describe("the gateway's exam: a session is reached only through its own graph, whatever the role", () => {
	const HOME_AS_OWNER = { "x-graph-id": "home", "x-graph-owner": "user:user-a", "x-sophia-graph-role": "owner" };
	const NOTES = { "x-graph-id": "notes", "x-graph-owner": "user:owner" };

	function notFound(response: RouteResponse, label: string) {
		assert.equal(response.statusCode, 404, `${label}: ${JSON.stringify(response.body)}`);
		assert.deepEqual(response.body, { error: "Agent session not found" }, label);
	}

	it("refuses steer and follow_up into a session on notes addressed through home with role owner", async () => {
		await withRoutes(
			async ({ runtime, post }) => {
				const chat = await beginChat(runtime, {
					n: 21,
					graphId: "notes",
					graphOwner: "user:owner",
					spec: { graphAccess: "read" },
				});
				const base = `/api/agent-sessions/${chat.sessionId}`;
				notFound(
					await post(
						`${base}/steer`,
						{ clientId: "review", text: "continue", commandId: "gw-steer-1" },
						HOME_AS_OWNER,
					),
					"steer",
				);
				notFound(
					await post(`${base}/commands`, command("gw-steer-2", "steer", { text: "continue" }), HOME_AS_OWNER),
					"commands steer",
				);
				notFound(await post(`${base}/commands`, command("gw-turn-1", "follow_up"), HOME_AS_OWNER), "follow_up");
				notFound(await post(`${base}/commands`, command("gw-abort-1", "abort", {}), HOME_AS_OWNER), "abort");
				notFound(await post(`${base}/driver`, { action: "claim", clientId: "review" }, HOME_AS_OWNER), "driver");
				notFound(await post(`${base}/commands/gw-turn-1/cancel`, { clientId: "review" }, HOME_AS_OWNER), "cancel");
				notFound(await post(`${base}/cancel`, { requestId: "gw-c", reason: "x" }, HOME_AS_OWNER), "session cancel");
				for (const id of ["gw-steer-1", "gw-steer-2", "gw-turn-1", "gw-abort-1"]) {
					assert.equal(await runtime.readAgentSessionCommand(id), null, id);
				}
				// The refusal is the answer for a session that does not exist at all.
				notFound(
					await post(`/api/agent-sessions/ags-nowhere/commands`, command("gw-x", "follow_up"), HOME_AS_OWNER),
					"absent",
				);
				// Through its own graph, as the viewer the person is there, the same follow-up is theirs (a Reader chat).
				const own = await post(`${base}/commands`, command("gw-turn-2", "follow_up"), {
					...NOTES,
					"x-sophia-graph-role": "viewer",
				});
				assert.equal(own.statusCode, 202, JSON.stringify(own.body));
			},
			{ spawner },
		);
	});

	it("exam 2, A: a session on bob's notes is not reached through alice's notes (same graph id, another owner), for any route", async () => {
		await withRoutes(
			async ({ runtime, post }) => {
				const chat = await beginChat(runtime, {
					n: 23,
					graphId: "notes",
					graphOwner: "user:bob",
					spec: { graphAccess: "write" },
				});
				const base = `/api/agent-sessions/${chat.sessionId}`;
				const ALICE_NOTES = {
					"x-graph-id": "notes",
					"x-graph-owner": "user:user-a",
					"x-sophia-graph-role": "owner",
				};
				notFound(await post(`${base}/commands`, command("o2-1", "follow_up"), ALICE_NOTES), "follow_up");
				notFound(
					await post(`${base}/steer`, { clientId: "c", text: "go", commandId: "o2-2" }, ALICE_NOTES),
					"steer",
				);
				notFound(await post(`${base}/driver`, { action: "claim", clientId: "c" }, ALICE_NOTES), "driver");
				notFound(await post(`${base}/cancel`, { requestId: "o2-c", reason: "x" }, ALICE_NOTES), "session cancel");
				for (const id of ["o2-1", "o2-2"]) assert.equal(await runtime.readAgentSessionCommand(id), null, id);
				// Through bob's notes, with the role minted for it, the same follow-up is the session's own.
				const own = await post(`${base}/commands`, command("o2-3", "follow_up"), {
					"x-graph-id": "notes",
					"x-graph-owner": "user:bob",
					"x-sophia-graph-role": "editor",
				});
				assert.equal(own.statusCode, 202, JSON.stringify(own.body));
			},
			{ spawner },
		);
	});

	it("keeps a demoted Writer chat from speaking through another graph: the role-changed refusal cannot be laundered", async () => {
		await withRoutes(
			async ({ runtime, post }) => {
				const chat = await beginChat(runtime, {
					n: 22,
					graphId: "notes",
					graphOwner: "user:owner",
					spec: { graphAccess: "write" },
				});
				const base = `/api/agent-sessions/${chat.sessionId}`;
				// Through notes, as a viewer, the Writer chat does not speak.
				refused(
					await post(`${base}/commands`, command("dw-1", "follow_up"), {
						...NOTES,
						"x-sophia-graph-role": "viewer",
					}),
					403,
					"workspace_chat_role_changed",
					"through notes",
				);
				// Through home, with home's owner role, it is not found: neither a follow-up nor a steer is queued.
				notFound(
					await post(`${base}/commands`, command("dw-2", "follow_up"), HOME_AS_OWNER),
					"follow_up through home",
				);
				notFound(
					await post(`${base}/commands`, command("dw-3", "steer", { text: "go" }), HOME_AS_OWNER),
					"steer through home",
				);
				for (const id of ["dw-1", "dw-2", "dw-3"])
					assert.equal(await runtime.readAgentSessionCommand(id), null, id);
			},
			{ spawner },
		);
	});

	it("refuses the reads of a session addressed through another graph, and the session's own graph reads them", async () => {
		await withRoutes(
			async ({ runtime, get }) => {
				const chat = await beginChat(runtime, { n: 23, graphId: "notes", graphOwner: "user:owner" });
				for (const path of ["", "/events", "/commands", "/document-ops"]) {
					notFound(await get(`/api/agent-sessions/${chat.sessionId}${path}`, HOME_AS_OWNER), `GET ${path || "/"}`);
					const own = await get(`/api/agent-sessions/${chat.sessionId}${path}`, {
						...NOTES,
						"x-sophia-graph-role": "viewer",
					});
					assert.equal(own.statusCode, 200, `own GET ${path || "/"}: ${JSON.stringify(own.body)}`);
				}
			},
			{ spawner },
		);
	});

	it("binds a request on the legacy route (no x-graph-owner) to the caller's own graph, as the gateway binds its invocations", async () => {
		await withRoutes(
			async ({ runtime, post }) => {
				const elsewhere = await beginChat(runtime, {
					n: 24,
					graphId: "notes",
					graphOwner: "user:owner",
					spec: { graphAccess: "read" },
				});
				const mine = await beginChat(runtime, {
					n: 25,
					graphId: "notes",
					graphOwner: "user:user-a",
					spec: { graphAccess: "read" },
				});
				const legacy = { "x-graph-id": "notes", "x-sophia-graph-role": "owner" };
				notFound(
					await post(`/api/agent-sessions/${elsewhere.sessionId}/commands`, command("lg-1", "follow_up"), legacy),
					"someone else's notes",
				);
				const own = await post(
					`/api/agent-sessions/${mine.sessionId}/commands`,
					command("lg-2", "follow_up"),
					legacy,
				);
				assert.equal(own.statusCode, 202, JSON.stringify(own.body));
			},
			{ spawner },
		);
	});

	it("refuses a minted role that names no graph, before reading the session", async () => {
		await withRoutes(
			async ({ runtime, post }) => {
				const chat = await beginChat(runtime, { n: 26, spec: { graphAccess: "read" } });
				refused(
					await post(`/api/agent-sessions/${chat.sessionId}/commands`, command("ng-1", "follow_up"), {
						"x-sophia-graph-role": "owner",
					}),
					400,
					"graph_role_invalid",
					"a role without a graph",
				);
				assert.equal(await runtime.readAgentSessionCommand("ng-1"), null);
			},
			{ spawner },
		);
	});
});
