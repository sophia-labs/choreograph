/**
 * The workspace chat's contract with its model: which tools it is handed, and the system prompt that
 * describes them. Both are built from one table, so the prompt never names a tool the harness withholds
 * and never leaves a handed-over tool undescribed (`src/test/workspace-chat-contract.test.ts`).
 *
 * Authority is the signed-in person's: owners and editors get the writer manifest, viewers the reader
 * manifest. The host's mode gate (`workspace-chat.ts`) and the cell's signed lease enforce it; this module
 * only says what the model is told and offered.
 */

import { turnTextForModel } from "../agent-runtime/turn-context.js";
import { InvocationFault } from "./invocation.js";

export type WorkspaceChatRole = "owner" | "editor" | "viewer";
export type WorkspaceChatAccess = "read" | "write";

export interface WorkspaceChatToolFamily {
	readonly id: string;
	/** The heading the prompt gives this family; tests look for it. */
	readonly title: string;
	/** Tools whose live required scopes are all reads. Every role gets them. */
	readonly read: readonly string[];
	/** Tools that write. Owners and editors only. */
	readonly write: readonly string[];
}

/**
 * The families, in the order the prompt presents them. Each tool here exists on garden engine r20261002 with
 * the effect class its list claims (pinned by the contract test against a reduced live tools/list).
 */
export const WORKSPACE_CHAT_TOOL_FAMILIES: readonly WorkspaceChatToolFamily[] = Object.freeze([
	{
		id: "find",
		title: "Find",
		read: [
			"search_documents",
			"search_blocks",
			"semantic_search",
			"list_documents",
			"get_workspace",
			"quick_orient",
			"sparql_query",
		],
		write: [],
	},
	{
		id: "read",
		title: "Read",
		read: ["read_document", "read_blocks", "get_block", "query_blocks", "document_digest"],
		write: [],
	},
	{ id: "history", title: "History", read: ["get_document_history", "read_document_at_snapshot"], write: [] },
	{
		id: "documents",
		title: "Write documents",
		read: [],
		write: [
			"create_document",
			"write_document",
			"insert_blocks",
			"update_blocks",
			"edit_block_text",
			"delete_blocks",
			// Vera, 2026-10-06 (D1): a true delete, with a warning. The document's history goes with it.
			"delete_document",
		],
	},
	{ id: "comments", title: "Comments", read: [], write: ["edit_comment"] },
	{ id: "folders", title: "Folders", read: [], write: ["create_folder", "move_documents", "move_folder", "rename"] },
	{
		id: "wires",
		title: "Wires",
		read: ["get_wires", "traverse_wires", "list_wire_predicates"],
		// Vera, 2026-10-06 (D2): a wire is deleted the way a person deletes one, with the generic `delete` and type
		// "wire" (shrubbery's wires panel does the same); the Writer's argument policy admits no other type.
		write: ["create_wires", "delete"],
	},
	{
		id: "values",
		title: "Values",
		read: ["get_values", "get_block_values", "get_important_blocks"],
		write: ["value"],
	},
	{
		id: "artifacts",
		title: "HTML artifacts",
		read: ["read_artifact", "list_artifact_revisions"],
		write: ["create_artifact_text", "write_artifact_text", "restore_artifact_revision", "custom_css"],
	},
	{ id: "surface", title: "Show your work", read: ["surface"], write: [] },
]);

/**
 * Cell tools kept out of chat on purpose, each for a reason the design names (`DESIGN-empowered-chat.md` §3):
 * a graph-wide act, a raw write face, Geist memory, or a tool whose effects the person could not see or undo
 * from a document's history. `sparql_update`, `rdf_load` and `revaluate` also write around the graph's source
 * ledger: a graph under source authority erases those writes on its next `source_push` (garden H1,
 * the Files rudiments return notes, kept outside this repository).
 */
export const WORKSPACE_CHAT_EXCLUDED_TOOLS: readonly string[] = Object.freeze([
	"crdt_operation",
	"sparql_update",
	"sparql_query_named",
	"rdf_load",
	"rdf_dump",
	"create_restore_point",
	"restore_to_restore_point",
	"delete_restore_point",
	"list_restore_points",
	"get_restore_point",
	"diff_restore_points",
	"get_restore_operation",
	"cancel_restore_operation",
	"create_document_once",
	"make_document_editable",
	"ingest_artifact",
	"edit_artifact_image",
	"list_artifact_kinds",
	"flush_crdt",
	"reindex_graph",
	"update_graph",
	"revaluate",
	"emporium_write",
	"emporium_retract",
	"emporium_sweep",
	"workflow_book_apply",
	"workflow_book_compose",
	"source_pull",
	"source_push",
	"source_rebuild",
	"flow_seed_board",
	"propose_domain_ontology",
	"context_bundle",
	"music",
	"recall",
	"remember",
	"remember_batch",
	"sing",
	"care",
	"archive_memories",
	"backfill_memory_projection",
	"memory_semantic_recall",
	"status",
	"agent_self_image",
	"query_graph",
	"cancel_job",
]);

/**
 * The Reader's tool list as it shipped on 2026-09-23 (`workspace-chat-v1` until this release). Frozen: chats
 * begun under it carry its digest and must still wake under exactly these tools.
 */
export const WORKSPACE_READER_TOOLS_V1: readonly string[] = Object.freeze(
	[
		"quick_orient",
		"get_workspace",
		"list_documents",
		"read_document",
		"read_blocks",
		"query_blocks",
		"get_block",
		"get_document_history",
		"document_digest",
		"search_documents",
		"search_blocks",
		"sparql_query",
		"get_wires",
		"traverse_wires",
		"list_wire_predicates",
		"get_important_blocks",
		"get_block_values",
		"get_values",
	].sort(),
);

export function workspaceChatAccessForRole(role: WorkspaceChatRole): WorkspaceChatAccess {
	return role === "viewer" ? "read" : "write";
}

/** The exact tool list for an access level, sorted. */
export function workspaceChatTools(access: WorkspaceChatAccess): readonly string[] {
	const tools = WORKSPACE_CHAT_TOOL_FAMILIES.flatMap((family) =>
		access === "write" ? [...family.read, ...family.write] : [...family.read],
	);
	return Object.freeze([...new Set(tools)].sort());
}

const ROLES: ReadonlySet<string> = new Set(["owner", "editor", "viewer"]);

/** The header the gateway mints the caller's role on the graph in, after its ACL check (platform-next, D4). */
export const GATEWAY_GRAPH_ROLE_HEADER = "x-sophia-graph-role";

/**
 * The gateway's minted role as its header carries it: absent is none, exactly `owner`, `editor` or `viewer` is that
 * role, and anything else is the caller's 400 `graph_role_invalid` (never guessed at). Callers believe it only from
 * the internal service (the gateway), the only party that can authenticate as it.
 */
export function parseGatewayGraphRole(value: string | undefined): WorkspaceChatRole | undefined {
	if (value === undefined) return undefined;
	if (!ROLES.has(value)) {
		throw new InvocationFault("graph_role_invalid", "the caller's graph role must be owner, editor or viewer", 400);
	}
	return value as WorkspaceChatRole;
}

/**
 * Whose authority the chat carries (DESIGN §3, as amended after exam 1).
 *
 * - Rule 1. The gateway may mint the caller's role on the graph (`x-sophia-graph-role`, after its ACL check); when it
 *   does, that is the answer and the only rule. A value that is not exactly a role is the caller's 400
 *   `graph_role_invalid` (the header is read once, so a repeated header is refused before this, as unreadable).
 * - Rule 2, the fallback, only while the gateway does not mint the role and the switch below is off. The caller is the
 *   owner only when it is the graph's owner principal (`ownsGraph`: the gateway's delegated ingress always is, a direct
 *   caller may not be); any other person at the gateway is an editor, because the deployed gateway admits a canonical
 *   invocation only at Editor or above (platform-next r20261004p `gateway/src/routes.rs`,
 *   `ChoreographRoute::CanonicalInvocation => Role::Editor`); a direct caller (no gateway, so no Editor floor) that does
 *   not own the graph is a viewer. The window this leaves open, exactly: a request on the internal-service path that
 *   carries no role is believed to come from a gateway that admits only editors. Only the gateway and in-host services
 *   hold that secret, and the viewer gateway mints the role on every route, so the window closes when the switch is on.
 * - `gatewayRoleRequired` (`CHOREOGRAPH_REQUIRE_GATEWAY_GRAPH_ROLE=true`) retires rule 2: a chat with no minted role is
 *   refused, 403 `graph_role_required` (fail closed: never a guess, not even the Reader). Turn it on once the gateway
 *   that mints the role is live.
 *
 * So, for the claim's clauses: (a) a Writer exists only for a minted owner or editor, or (before the switch) for the
 * graph's owner principal or a person the gateway admitted at Editor; (e) a viewer gets the Reader, and an invalid,
 * unreadable, duplicated or (after the switch) absent role gets no chat at all.
 */
export function resolveWorkspaceChatRole(input: {
	readonly caller: { readonly authMethod: "owner" | "internal-service" };
	/** The caller is the graph's owner principal (the run's actor is the graph owner). */
	readonly ownsGraph: boolean;
	readonly gatewayGraphRole?: string;
	readonly gatewayRoleRequired?: boolean;
}): WorkspaceChatRole {
	if (input.gatewayGraphRole !== undefined) return parseGatewayGraphRole(input.gatewayGraphRole) as WorkspaceChatRole;
	if (input.gatewayRoleRequired) throw graphRoleRequiredFault();
	if (input.caller.authMethod === "owner") return input.ownsGraph ? "owner" : "viewer";
	return "editor";
}

/** Rule 2 retired and no role minted: refused, never guessed. */
export function graphRoleRequiredFault(): InvocationFault {
	return new InvocationFault(
		"graph_role_required",
		"this host requires the gateway to name the caller's role on the graph, and none was sent",
		403,
	);
}

/** Rule 2's retirement switch, from the host's environment: exactly "true" turns it on. */
export function gatewayGraphRoleRequired(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.CHOREOGRAPH_REQUIRE_GATEWAY_GRAPH_ROLE?.trim() === "true";
}

/**
 * The text a turn is given to the model with (`agent-runtime/turn-context.ts`): the person's words, then one note
 * naming what they have open, by id. The host renders it for the model only.
 */
export function renderWorkspaceChatTurnText(text: string, contextRefs: readonly string[]): string {
	return turnTextForModel(text, contextRefs);
}

/** A tool or argument name as the prompt writes it: in backticks, so a tool is never mistaken for a word. */
const code = (name: string) => `\`${name}\``;
const list = (tools: readonly string[]) => tools.map(code).join(", ");

/** Items joined as prose: "a", "a and b", "a, b and c" (or "or"). */
function prose(items: readonly string[], conjunction: "and" | "or"): string {
	if (items.length <= 1) return items.join("");
	return `${items.slice(0, -1).join(", ")} ${conjunction} ${items.at(-1)}`;
}

/** The tools the prompt may name for an access level, given the tools a session is actually handed. */
export function workspaceChatExposedTools(
	access: WorkspaceChatAccess,
	liveTools: readonly string[] | undefined,
): readonly string[] {
	const manifest = workspaceChatTools(access);
	if (liveTools === undefined) return manifest;
	const live = new Set(liveTools);
	return Object.freeze(manifest.filter((tool) => live.has(tool)));
}

/** A workspace chat cannot do its job without these: it refuses to start on a cell that does not serve them. */
export const WORKSPACE_CHAT_REQUIRED_TOOLS: readonly string[] = Object.freeze(["read_document", "search_documents"]);

/**
 * The system prompt. Plain, short, and true of this harness: every tool it names (always in backticks) is one the
 * session is handed, and every tool it is handed is named (exam 1, finding 7: generated from `tools`, the live
 * intersection, not the nominal manifest; absent means the whole manifest). Every rule in "How to work" comes from a
 * failure seen in a real session (DESIGN §6); a clause that needs a tool the session lacks is left out.
 */
export function workspaceChatSystemPrompt(input: {
	readonly graphId: string;
	readonly role: WorkspaceChatRole;
	/** The voice this session speaks with; it signs the comments it writes. */
	readonly model?: string;
	/** The tools the session is handed (the manifest's intersection with the live cell); absent means the manifest. */
	readonly tools?: readonly string[];
}): string {
	const access = workspaceChatAccessForRole(input.role);
	const handed = new Set(workspaceChatExposedTools(access, input.tools));
	const has = (...names: string[]) => names.every((name) => handed.has(name));
	const writeTools = WORKSPACE_CHAT_TOOL_FAMILIES.flatMap((family) => family.write);
	const writes = access === "write" && writeTools.some((tool) => handed.has(tool));
	const family = (id: string) => {
		const found = WORKSPACE_CHAT_TOOL_FAMILIES.find((candidate) => candidate.id === id);
		if (!found) throw new Error(`unknown tool family ${id}`);
		return found;
	};
	const tools = (id: string, part: "read" | "all" = writes ? "all" : "read") => {
		const found = family(id);
		return (part === "all" ? [...found.read, ...found.write] : [...found.read]).filter((tool) => handed.has(tool));
	};
	const signature = `Sophia (${input.model?.trim() || "workspace assistant"})`;

	const intro = writes
		? [
				`You are Sophia, the assistant in the workspace "${input.graphId}". You act for the person you are talking with, with their permissions here: they are ${input.role === "owner" ? "its owner" : "an editor"}, so you can read, search and change it.`,
				"Change things when the person asks you to. For anything large, or anything that removes text, say what you will do before you do it.",
			]
		: access === "write"
			? [
					`You are Sophia, the assistant in the workspace "${input.graphId}". You act for the person you are talking with, with their permissions here: they are ${input.role === "owner" ? "its owner" : "an editor"}.`,
					"You can read and search this workspace, but this workspace offers you no tools to change it right now. If they ask for a change, say exactly what you would change and where.",
				]
			: [
					`You are Sophia, the assistant in the workspace "${input.graphId}". You act for the person you are talking with, with their permissions here.`,
					"You can read and search this workspace, but you cannot change anything here: the person can view this workspace but not edit it. If they ask for a change, say exactly what you would change and where, and that someone with edit rights can make it.",
				];

	const line = (title: string, names: readonly string[], ...clauses: string[]) =>
		names.length === 0
			? []
			: [
					`- ${title}: ${list(names)}.${clauses
						.filter(Boolean)
						.map((clause) => ` ${clause}`)
						.join("")}`,
				];
	const findClauses = [
		has("search_documents") ? `${code("search_documents")} finds documents by title and text` : "",
		has("search_blocks") ? `${code("search_blocks")} finds passages` : "",
		has("semantic_search") ? `${code("semantic_search")} finds by meaning` : "",
		has("list_documents") && has("get_workspace")
			? `${code("list_documents")} and ${code("get_workspace")} show what is here and the folder tree`
			: has("list_documents")
				? `${code("list_documents")} shows what is here`
				: has("get_workspace")
					? `${code("get_workspace")} shows what is here and the folder tree`
					: "",
		has("quick_orient") ? `${code("quick_orient")} gives a short overview` : "",
		has("sparql_query")
			? `${code("sparql_query")} runs SPARQL SELECT over the workspace's RDF (wrap patterns in GRAPH ?g { ... })`
			: "",
	].filter(Boolean);
	const findSentence =
		findClauses.length === 0
			? ""
			: findClauses.length <= 2
				? `${findClauses.join(" and ")}.`
				: `${findClauses.slice(0, -1).join(", ")}, and ${findClauses.at(-1)}.`;
	const wiresReads = tools("wires", "read");
	const artifactNames = tools("artifacts").filter((tool) => tool !== "custom_css");

	const toolLines = [
		"Your tools (call them by these names; you have no others):",
		...line(family("find").title, tools("find"), findSentence),
		...line(family("read").title, tools("read")).map((text) => text),
		...(tools("history").length > 0
			? [`- ${family("history").title}: ${list(tools("history"))} show every saved version of a document.`]
			: []),
		...(writes
			? [
					...line(
						family("documents").title,
						tools("documents"),
						has("write_document")
							? `${code("write_document")} replaces a whole document; to keep JSON, code or other exact text byte for byte, put it in a fenced code block and pass format "markdown".`
							: "",
						has("delete_document")
							? `${code("delete_document")} deletes a whole document and its history with it.`
							: "",
					),
					...(has("edit_comment")
						? [
								`- ${family("comments").title}: ${code("edit_comment")} creates, resolves or deletes a comment. Sign comments you write with author "${signature}".`,
							]
						: []),
					...(tools("folders").length > 0
						? [
								`- ${family("folders").title}: ${list(tools("folders"))}${has("rename") ? " (rename a document or a folder, not the workspace)" : ""}.`,
							]
						: []),
				]
			: []),
		...(writes
			? (() => {
					const parts = [
						wiresReads.length > 0 ? list(wiresReads) : "",
						has("create_wires") ? `${code("create_wires")} makes one` : "",
						has("delete")
							? `${code("delete")} with type "wire" and the wire's id removes one (it removes nothing else here)`
							: "",
					].filter(Boolean);
					if (parts.length === 0) return [];
					const [first, ...rest] = parts;
					const head =
						wiresReads.length > 0
							? `${first}${rest.length > 0 ? `; ${rest.join(", and ")}` : ""}`
							: prose(parts, "and");
					return [`- ${family("wires").title} (typed links between documents and blocks): ${head}.`];
				})()
			: wiresReads.length > 0
				? [`- ${family("wires").title} (typed links between documents and blocks): ${list(wiresReads)}.`]
				: []),
		...(tools("values").length > 0
			? [`- ${family("values").title} (how much a block matters to the person): ${list(tools("values"))}.`]
			: []),
		...(writes
			? artifactNames.length > 0 || has("custom_css")
				? [
						`- ${family("artifacts").title} (live pages in the workspace): ${[
							...(artifactNames.length > 0 ? [list(artifactNames)] : []),
							...(has("custom_css")
								? [`${code("custom_css")} with action "read" only, to learn the workspace's incarnation`]
								: []),
						].join(", and ")}.`,
					]
				: []
			: tools("artifacts").length > 0
				? [`- ${family("artifacts").title} (pages in the workspace): ${list(tools("artifacts"))}.`]
				: []),
		...(has("surface")
			? [
					`- ${family("surface").title}: ${code("surface")} turns a list of actions on documents into links the person can open.`,
				]
			: []),
		writes
			? "You cannot reach other workspaces, browse the web or run code, and you cannot change the workspace's RDF directly (no SPARQL UPDATE, no RDF loads) or recompute its values in bulk: change documents, wires and values with the tools above."
			: "You cannot reach other workspaces, browse the web or run code.",
	];

	const finders = ["search_documents", "list_documents", "get_workspace"].filter((tool) => handed.has(tool)).map(code);
	const alternatives = ["search_blocks", "semantic_search", "list_documents", "get_workspace"]
		.filter((tool) => handed.has(tool))
		.map(code);
	const numbered: string[] = [];
	const rule = (text: string) => {
		numbered.push(`${numbered.filter((entry) => /^\d+\. /.test(entry)).length + 1}. ${text}`);
	};
	rule(
		`Ids are not titles. Documents, blocks, folders and artifacts are named by ids made of letters, digits, hyphens and underscores; a title such as "Q3 plan" is not an id and will be refused. To open something the person names, find its id first with ${prose(finders, "or")}, then read it by that id.`,
	);
	rule(
		`Search before you give up. If a read fails or a search finds nothing, try another way before saying something is not here: ${prose(["a shorter or different query", ...alternatives], "or")}.`,
	);
	if (writes) {
		const smallest = ["edit_block_text", "update_blocks"].filter((tool) => handed.has(tool)).map(code);
		rule(
			[
				`Read before you write. Read the current content right before you change it, and make the smallest change that does the job${smallest.length > 0 ? `: ${prose(smallest, "or")} rather than rewriting a document` : ""}.`,
				...(has("write_document", "read_document")
					? [
							`When you use ${code("write_document")}, pass the revision from your last ${code("read_document")} as ${code("expectedRevision")}.`,
						]
					: []),
				"If a write is refused because the content changed, read it again and reconcile: never overwrite newer work by retrying blindly. If a write is refused for permission, say so plainly and stop trying.",
			].join(" "),
		);
		const history = has("get_document_history", "read_document_at_snapshot");
		const blocksBack = (has("delete_blocks") || has("edit_comment")) && history;
		if (has("delete_blocks") || has("edit_comment") || has("delete_document") || has("delete")) {
			rule(
				[
					"Delete only what the person asked you to delete.",
					...(blocksBack
						? [
								`Deleted blocks and comments stay recoverable: the document's History keeps every saved version (${code("get_document_history")}, ${code("read_document_at_snapshot")}), so after deleting them, name what you removed and say it can be brought back from the document's History.`,
							]
						: []),
					...(has("delete_document")
						? [
								`${blocksBack ? "Deleting a whole document is different: " : ""}${blocksBack ? code("delete_document") : `${code("delete_document")}`} removes the document together with its history, so it cannot be undone from History. Delete a document only when the person has asked for that document; if the request could mean more than one, name the ones you would delete, say their history goes with them, and ask first. Every time you delete a document, say plainly in your reply that its history was deleted with it and that it cannot be brought back from History.`,
							]
						: []),
					...(has("delete")
						? [
								`Remove a wire with ${code("delete")}, type "wire" and the wire's id${has("get_wires") ? ` from ${code("get_wires")}` : ""}, the same way a person removes one.`,
							]
						: []),
				].join(" "),
			);
		}
		if (has("create_artifact_text", "write_artifact_text", "read_artifact")) {
			rule(
				"HTML artifacts are how you make a live view: a page that everyone who has it open sees change as soon as you write a new version, such as a dashboard, a table of what the workspace holds or a status board. Use HTML and CSS only: scripts do not run, nothing loads from the network, and images must be data: URIs.",
			);
			numbered.push(
				`   - You need the workspace's ${code("graph_incarnation")} (the id of this life of the workspace) to create or change one. Take it from ${code("read_artifact")} with ${code("strict_utf8")}: true on any existing HTML or text artifact${has("custom_css") ? `, or from ${code("custom_css")} with action "read"` : ""}. Never invent one.`,
				`   - Create: ${code("create_artifact_text")} with a new ${code("artifact_id")} and a new ${code("operation_id")} that you make up (lowercase letters, digits and hyphens), a filename ending in .html, ${code("mime_type")} "text/html", the ${code("graph_incarnation")} and the complete text; ${code("parent_id")} puts it in a folder.`,
				`   - Change: ${code("read_artifact")} with ${code("strict_utf8")}: true for the current text and its ${code("contentHashSha256")}, then ${code("write_artifact_text")} with ${code("expected_content_sha256")} set to that hash, a new ${code("operation_id")} and the complete new text. If it is refused because the hash changed, someone else changed the page: read it again and merge, never just retry with the new hash. Reuse an ${code("operation_id")} only to repeat the very same request after a timeout.`,
			);
			const revisions = [
				has("list_artifact_revisions") ? `${code("list_artifact_revisions")} shows earlier versions` : "",
				has("restore_artifact_revision")
					? `${code("restore_artifact_revision")} brings one back (it keeps the current version first)`
					: "",
			].filter(Boolean);
			if (revisions.length > 0) numbered.push(`   - ${revisions.join(", and ")}.`);
		}
		const wiresAndValues = [
			has("create_wires")
				? `Wire two documents or blocks with ${code("create_wires")} when one refers to, depends on, contradicts or answers the other and the person would want to follow that link${has("list_wire_predicates") ? `; call ${code("list_wire_predicates")} first and use an existing predicate` : ""}.`
				: "",
			has("value")
				? `Use ${code("value")} to record how much a block matters (importance and valence) when the person says so, not as a guess.`
				: "",
		].filter(Boolean);
		if (wiresAndValues.length > 0) rule(`Wires and values. ${wiresAndValues.join(" ")}`);
		rule(
			has("surface")
				? `Cite and show your work. Name the documents your answer comes from. After you change anything, call ${code("surface")} once with every action of this turn (${code("document_id")}, ${code("block_id")} when there is one, and a short action word such as created, edited, moved, commented or deleted), so the person gets a link to open each change; then say in words what you changed and where an earlier version can be found.`
				: "Cite and show your work. Name the documents your answer comes from. After you change anything, say in words what you changed and where an earlier version can be found.",
		);
	} else {
		rule(
			has("surface")
				? `Cite what you use. Name the documents your answer comes from, and use ${code("surface")} to give the person links to the documents and blocks you mean.`
				: "Cite what you use. Name the documents your answer comes from.",
		);
	}

	const rules = [
		"How to work:",
		...numbered,
		'A message may end with a note in parentheses naming what the person has open; "this document" means the first thing named there.',
		"Answer plainly and briefly. If you did not find something, say so.",
	];

	return [...intro, "", ...toolLines, "", ...rules].join("\n");
}
