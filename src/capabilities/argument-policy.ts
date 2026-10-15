/**
 * Host-owned argument policies: the few places where a tool the mode admits has a face the mode must not.
 *
 * A built-in mode (never a graph-authored one) may name one of these on its fence. The mode gate applies it to
 * every call after the tool and graph-scope checks, on the arguments the sandbox sent, before anything reaches
 * the cell. A policy returns a reason to refuse, or undefined to admit.
 */

export type HostArgumentPolicyName = "workspace-writer-v1";

export const HOST_ARGUMENT_POLICIES: ReadonlySet<HostArgumentPolicyName> = new Set(["workspace-writer-v1"]);

export function isHostArgumentPolicyName(value: unknown): value is HostArgumentPolicyName {
	return typeof value === "string" && HOST_ARGUMENT_POLICIES.has(value as HostArgumentPolicyName);
}

/** Returns why the call is refused, or undefined when the policy admits it. */
export function checkHostArgumentPolicy(
	name: HostArgumentPolicyName,
	tool: string,
	args: Readonly<Record<string, unknown>>,
	boundGraphId: string | undefined,
): string | undefined {
	switch (name) {
		case "workspace-writer-v1":
			return workspaceWriterV1(tool, args, boundGraphId);
	}
}

const CUSTOM_CSS_READ_ACTIONS = new Set(["guide", "read"]);
const RENAMEABLE = new Set(["document", "folder"]);
/** The spellings garden's generic delete accepts for a wire (r20261002 `mcp_delete_service.rs`: "wires" | "wire"). */
const DELETABLE_WITH_DELETE = new Set(["wire", "wires"]);

/**
 * The workspace chat's Writer.
 * - `custom_css`: its read face only (`guide`, `read`, or no action, which the cell treats as `guide`). The chat
 *   uses it to learn the graph incarnation, never to restyle the workspace.
 * - `create_wires`: a wire may not point into another graph (top level or any entry of `wires`).
 * - `rename`: a document or a folder, never the graph (whose title the gateway also keeps).
 * - `delete`: wires only (Vera, 2026-10-06, D2: "it can delete just like a human"). A document is deleted with
 *   `delete_document` (D1), blocks with `delete_blocks`; a folder (a hard cascade) and the graph are not the chat's.
 */
function workspaceWriterV1(
	tool: string,
	args: Readonly<Record<string, unknown>>,
	boundGraphId: string | undefined,
): string | undefined {
	if (tool === "custom_css") {
		const action = args.action;
		if (action === undefined || (typeof action === "string" && CUSTOM_CSS_READ_ACTIONS.has(action))) return undefined;
		return "custom_css is admitted only with action 'guide' or 'read'";
	}
	if (tool === "create_wires") {
		const entries: unknown[] = [args];
		if (args.wires !== undefined) {
			if (!Array.isArray(args.wires)) return "create_wires 'wires' must be an array";
			entries.push(...args.wires);
		}
		for (const entry of entries) {
			if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
				return "create_wires entries must be objects";
			}
			const record = entry as Record<string, unknown>;
			for (const key of ["target_graph_id", "targetGraphId", "graph_id", "graphId"]) {
				if (!(key in record)) continue;
				if (boundGraphId === undefined || record[key] !== boundGraphId) {
					return `create_wires ${key}=${JSON.stringify(record[key])} points outside this graph`;
				}
			}
		}
		return undefined;
	}
	if (tool === "delete") {
		const type = args.type;
		if (typeof type === "string" && DELETABLE_WITH_DELETE.has(type.toLowerCase())) return undefined;
		return "delete is admitted only for wires (type 'wire'); delete a document with delete_document and blocks with delete_blocks";
	}
	if (tool === "rename") {
		const type = args.entity_type ?? args.entityType;
		if (typeof type === "string" && RENAMEABLE.has(type.toLowerCase())) return undefined;
		return "rename is admitted only for a document or a folder";
	}
	return undefined;
}
