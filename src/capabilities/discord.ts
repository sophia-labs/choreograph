import {
	createMeaningfulObjectRef,
	type MeaningfulObjectKind,
	validateMeaningfulObjectRef,
} from "../agent-runtime/meaningful-object.js";
import type { CapabilityBackend, HostedMcpToolDescriptor } from "../mnemosyne.js";

export interface DiscordCapabilityScopeV2 {
	readonly schema: "sophia.discord-capability-scope.v2";
	readonly datasetEpochId: string;
	readonly contextHandle: string;
	readonly guildHandle: string;
	readonly channelHandles: readonly string[];
	readonly sourceMessageHandle: string;
}

export interface DiscordCapabilityBackendOptions {
	readonly baseUrl: string;
	readonly bearerToken: string;
	readonly scope: DiscordCapabilityScopeV2;
	readonly allowedTools: readonly string[];
	readonly fetchFn?: typeof fetch;
	readonly timeoutMs?: number;
	readonly maxResponseBytes?: number;
}

const TOOLS = [
	{
		name: "get_guild",
		destructive: false,
		description: "Read the bound Discord guild as a privacy-scoped Meaningful Object.",
		inputSchema: { type: "object", additionalProperties: false, properties: {} },
	},
	{
		name: "get_channel",
		destructive: false,
		description: "Read one allowed Discord channel or thread as a pinned Meaningful Object.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["channel_handle"],
			properties: { channel_handle: opaqueHandle("channel") },
		},
	},
	{
		name: "get_message",
		destructive: false,
		description: "Read one Discord message and its author/channel Meaningful Object testimony.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["channel_handle", "message_handle"],
			properties: {
				channel_handle: opaqueHandle("channel"),
				message_handle: opaqueHandle("message"),
			},
		},
	},
	{
		name: "list_channel_messages",
		destructive: false,
		description: "Read a bounded chronological window of messages from one allowed Discord channel.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["channel_handle"],
			properties: {
				channel_handle: opaqueHandle("channel"),
				before_message_handle: opaqueHandle("message"),
				after_message_handle: opaqueHandle("message"),
				limit: { type: "integer", minimum: 1, maximum: 100 },
			},
		},
	},
	{
		name: "search_messages",
		destructive: false,
		description: "Search a bounded recent Discord corpus inside the bound guild/channel fence.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["query"],
			properties: {
				query: { type: "string", minLength: 1, maxLength: 500 },
				channel_handle: opaqueHandle("channel"),
				limit: { type: "integer", minimum: 1, maximum: 50 },
				scan_limit: { type: "integer", minimum: 1, maximum: 1000 },
			},
		},
	},
	{
		name: "get_member",
		destructive: false,
		description: "Read one admitted social identity through an opaque principal handle.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["principal_handle"],
			properties: { principal_handle: opaqueHandle("principal") },
		},
	},
	{
		name: "message_context",
		destructive: false,
		description: "Read a bounded before/after context window around one Discord message.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["channel_handle", "message_handle"],
			properties: {
				channel_handle: opaqueHandle("channel"),
				message_handle: opaqueHandle("message"),
				before: { type: "integer", minimum: 0, maximum: 50 },
				after: { type: "integer", minimum: 0, maximum: 50 },
			},
		},
	},
] as const satisfies readonly HostedMcpToolDescriptor[];

const TOOL_NAMES = new Set<string>(TOOLS.map((tool) => tool.name));

/**
 * Credential-holding Discord edge adapter. The sandbox sees only descriptors
 * and results; the bearer and the Discord bot token remain on trusted hosts.
 */
export class DiscordCapabilityBackend implements CapabilityBackend {
	readonly capabilityName = "discord";
	readonly accessLevel = "ro" as const;
	private readonly baseUrl: URL;
	private readonly allowedTools: ReadonlySet<string>;
	private readonly fetchFn: typeof fetch;
	private readonly timeoutMs: number;
	private readonly maxResponseBytes: number;

	constructor(private readonly options: DiscordCapabilityBackendOptions) {
		this.baseUrl = new URL(ensureTrailingSlash(options.baseUrl));
		if (this.baseUrl.protocol !== "http:" && this.baseUrl.protocol !== "https:") {
			throw new Error("discord: capability base URL must use http or https");
		}
		if (!options.bearerToken.trim()) throw new Error("discord: PHANES_CAPABILITY_TOKEN is required");
		validateScope(options.scope);
		this.allowedTools = new Set(options.allowedTools);
		const unknown = [...this.allowedTools].filter((name) => !TOOL_NAMES.has(name));
		if (unknown.length > 0) throw new Error(`discord: grant names unsupported tools: ${unknown.sort().join(", ")}`);
		if (this.allowedTools.size === 0) throw new Error("discord: the Agent tool grant exposes no Discord reads");
		this.fetchFn = options.fetchFn ?? fetch;
		this.timeoutMs = options.timeoutMs ?? 20_000;
		this.maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
	}

	async listTools(): Promise<readonly HostedMcpToolDescriptor[]> {
		return TOOLS.filter((tool) => this.allowedTools.has(tool.name));
	}

	async callTool(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
		if (!this.allowedTools.has(tool)) throw new Error(`discord: tool '${tool}' is outside the Agent tool grant`);
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const response = await this.fetchFn(new URL("v2/call", this.baseUrl), {
			method: "POST",
			headers: {
				authorization: `Bearer ${this.options.bearerToken}`,
				"content-type": "application/json",
				accept: "application/json",
			},
			body: JSON.stringify({
				schema: "sophia.discord-capability-call.v2",
				tool,
				args,
				scope: this.options.scope,
			}),
			signal: combined,
		});
		const contentLength = Number(response.headers.get("content-length") ?? 0);
		if (Number.isFinite(contentLength) && contentLength > this.maxResponseBytes) {
			throw new Error("discord: Phanes response exceeded the host byte fence");
		}
		const text = await response.text();
		if (Buffer.byteLength(text, "utf8") > this.maxResponseBytes) {
			throw new Error("discord: Phanes response exceeded the host byte fence");
		}
		let value: unknown;
		try {
			value = text ? JSON.parse(text) : {};
		} catch {
			throw new Error(`discord: Phanes returned non-JSON (HTTP ${String(response.status)})`);
		}
		if (!response.ok) {
			const message =
				isRecord(value) && typeof value.error === "string" ? value.error : `HTTP ${String(response.status)}`;
			throw new Error(`discord: ${message}`);
		}
		validateDiscordCapabilityResult(tool, value);
		return value;
	}

	async close(): Promise<void> {}
}

export function discordCapabilityScope(
	value: unknown,
	grantedResourcePrefixes?: readonly string[],
): DiscordCapabilityScopeV2 {
	if (!isRecord(value)) throw new Error("discord: trigger Meaningful Object scope is missing");
	const contextHandle = handle(value.privacy_context_handle ?? value.privacyContextHandle, "ctx", "context");
	const guildHandle = handle(value.guild_handle ?? value.guildHandle, "guild", "guild");
	const sourceChannel = handle(value.channel_handle ?? value.channelHandle, "channel", "channel");
	const declared = Array.isArray(value.channel_handles ?? value.channelHandles)
		? (value.channel_handles ?? value.channelHandles)
		: [];
	const channelHandles = [
		...new Set([sourceChannel, ...declared.map((entry) => handle(entry, "channel", "channel"))]),
	];
	if (grantedResourcePrefixes) {
		const resource = `discord-context:${contextHandle}`;
		if (!grantedResourcePrefixes.some((prefix) => resource.startsWith(prefix))) {
			throw new Error("discord: privacy context is outside the signed steward grant fence");
		}
	}
	const datasetEpoch = isRecord(value.dataset_epoch ?? value.datasetEpoch)
		? (value.dataset_epoch ?? value.datasetEpoch)
		: undefined;
	const datasetEpochId = isRecord(datasetEpoch) ? datasetEpoch.epochId : undefined;
	if (typeof datasetEpochId !== "string" || !/^[0-9a-f]{32}$/.test(datasetEpochId)) {
		throw new Error("discord: dataset epoch id is invalid");
	}
	const scope: DiscordCapabilityScopeV2 = {
		schema: "sophia.discord-capability-scope.v2",
		datasetEpochId,
		contextHandle,
		guildHandle,
		channelHandles,
		sourceMessageHandle: handle(value.message_handle ?? value.messageHandle, "message", "message"),
	};
	validateScope(scope);
	return scope;
}

export function validateDiscordCapabilityResult(tool: string, value: unknown): void {
	switch (tool) {
		case "get_guild":
			validateTestimony(value, new Set(["discord-guild"]));
			return;
		case "get_channel":
			validateTestimony(value, new Set(["discord-channel", "discord-thread"]));
			return;
		case "get_message":
			validateTestimony(value, new Set(["discord-message"]));
			return;
		case "list_channel_messages":
		case "search_messages":
		case "message_context":
			validateCollection(value, "discord-message");
			return;
		case "get_member": {
			validateTestimony(value, new Set(["social-identity"]));
			return;
		}
		default:
			throw new Error(`discord: cannot validate unsupported tool '${tool}'`);
	}
}

function validateCollection(value: unknown, expectedKind: MeaningfulObjectKind): void {
	if (!isRecord(value) || value.schema !== "sophia.meaningful-object-collection.v1") {
		throw new Error("discord: collection result has an unsupported schema");
	}
	assertExactKeys(value, ["schema", "kind", "items", "count"], "collection result");
	if (value.kind !== expectedKind) throw new Error(`discord: collection kind must be ${expectedKind}`);
	if (!Array.isArray(value.items)) throw new Error("discord: collection items must be an array");
	if (value.count !== value.items.length) throw new Error("discord: collection count does not match its items");
	for (const item of value.items) validateTestimony(item, new Set([expectedKind]));
}

function validateTestimony(value: unknown, expectedKinds: ReadonlySet<MeaningfulObjectKind>): void {
	if (!isRecord(value) || value.schema !== "sophia.meaningful-object-testimony.v1") {
		throw new Error("discord: result has an unsupported Meaningful Object testimony schema");
	}
	assertExactKeys(value, ["schema", "object", "value", "evidenceRefs"], "testimony");
	validateMeaningfulObjectRef(value.object);
	if (!expectedKinds.has(value.object.kind)) {
		throw new Error(`discord: testimony kind '${value.object.kind}' does not match the called tool`);
	}
	if (!isRecord(value.value)) throw new Error("discord: testimony value must be an object");
	if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length !== 1) {
		throw new Error("discord: testimony must carry its single Meaningful Object evidence ref");
	}
	validateMeaningfulObjectRef(value.evidenceRefs[0], value.object.kind);
	if (JSON.stringify(value.evidenceRefs[0]) !== JSON.stringify(value.object)) {
		throw new Error("discord: testimony evidence ref does not match its object");
	}
	const recomputed = createMeaningfulObjectRef({
		kind: value.object.kind,
		ownerPrincipal: value.object.ownerPrincipal,
		graphId: value.object.graphId,
		objectId: value.object.objectId,
		version: value.object.version,
		value: value.value,
	});
	if (recomputed.digest !== value.object.digest) {
		throw new Error("discord: Meaningful Object testimony digest does not match its value");
	}
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
	const allowed = new Set(keys);
	const unknown = Object.keys(value).filter((key) => !allowed.has(key));
	const missing = keys.filter((key) => !(key in value));
	if (unknown.length > 0 || missing.length > 0) {
		throw new Error(`discord: ${label} fields are invalid`);
	}
}

function opaqueHandle(prefix: string): Record<string, unknown> {
	return { type: "string", pattern: `^${prefix}_[A-Za-z0-9_-]{24}$` };
}

function handle(value: unknown, prefix: string, label: string): string {
	if (typeof value !== "string" || !new RegExp(`^${prefix}_[A-Za-z0-9_-]{24}$`).test(value)) {
		throw new Error(`discord: opaque ${label} handle is invalid`);
	}
	return value;
}

function validateScope(scope: DiscordCapabilityScopeV2): void {
	if (scope.schema !== "sophia.discord-capability-scope.v2") throw new Error("discord: scope schema is invalid");
	if (!/^[0-9a-f]{32}$/.test(scope.datasetEpochId)) throw new Error("discord: dataset epoch is invalid");
	handle(scope.contextHandle, "ctx", "context");
	handle(scope.guildHandle, "guild", "guild");
	handle(scope.sourceMessageHandle, "message", "message");
	if (scope.channelHandles.length === 0) throw new Error("discord: at least one bound channel is required");
	if (new Set(scope.channelHandles).size !== scope.channelHandles.length) {
		throw new Error("discord: bound channel handles must be unique");
	}
	for (const channel of scope.channelHandles) handle(channel, "channel", "channel");
}

function ensureTrailingSlash(value: string): string {
	return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
