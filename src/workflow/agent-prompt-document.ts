import { createHash } from "node:crypto";
import {
	mintAgentUri,
	mintStandaloneAgentId,
	STANDALONE_AGENT_IDENTITY_ALGORITHM,
} from "../agent-subject/agent-ontology.js";
import { stableJson } from "./agent-tool-manifest.js";
import {
	type GraphDocumentRead,
	type GraphWriter,
	unwrapAuthoredJsonDocument,
	writeJsonDocument,
} from "./graph-writer.js";

export const AGENT_PROMPT_SNAPSHOT_SCHEMA = "sophia.agent-prompt-snapshot.v1" as const;
export const AGENT_PROMPT_BINDING_SCHEMA = "sophia.agent-prompt-binding.v1" as const;

export interface AgentPromptBlockRefV1 {
	readonly blockId?: string;
	readonly blockUri?: string;
	readonly role?: string;
	readonly digest?: string;
}

export interface AgentPromptSnapshotV1 {
	readonly schema: typeof AGENT_PROMPT_SNAPSHOT_SCHEMA;
	readonly snapshotId: string;
	readonly graphId: string;
	readonly documentId: string;
	readonly documentUri: string;
	readonly renderedText: string;
	readonly renderedDigest: string;
	readonly revision?: number;
	readonly changeId?: string;
	readonly blocks: readonly AgentPromptBlockRefV1[];
	readonly renderedAt: number;
}

export interface AgentPromptBindingV1 {
	readonly schema: typeof AGENT_PROMPT_BINDING_SCHEMA;
	readonly bindingId: string;
	readonly agentId: string;
	readonly agentUri: string;
	readonly registeredName: string;
	readonly identityAlgorithm: typeof STANDALONE_AGENT_IDENTITY_ALGORITHM;
	readonly promptRole: "system";
	readonly promptDocumentId: string;
	readonly snapshot: AgentPromptSnapshotV1;
	readonly inference: {
		readonly provider: string;
		readonly model: string;
	};
	readonly status: "active" | "superseded" | "retired";
	readonly promotedAt: number;
	readonly promotedBy: string;
}

export interface ResolvedAgentPromptV1 {
	/** Active graph-authored authority that names the editable prompt document. */
	readonly binding: AgentPromptBindingV1;
	/** Immutable binding synthesized for this resolution and carried by the session. */
	readonly executionBinding: AgentPromptBindingV1;
	readonly currentSnapshot: AgentPromptSnapshotV1;
	readonly dirty: boolean;
	/** Current Garden text captured immutably for the newly-created session. */
	readonly systemPrompt: string;
}

export class PromptGraphError extends Error {
	readonly code: "graph_unavailable" | "document_invalid" | "binding_invalid";
	readonly graphId: string;
	readonly documentId: string;

	constructor(
		code: PromptGraphError["code"],
		message: string,
		context: { graphId: string; documentId: string; cause?: unknown },
	) {
		super(message, context.cause === undefined ? undefined : { cause: context.cause });
		this.name = "PromptGraphError";
		this.code = code;
		this.graphId = context.graphId;
		this.documentId = context.documentId;
	}
}

export function buildAgentPromptSnapshot(document: GraphDocumentRead, now = Date.now()): AgentPromptSnapshotV1 {
	const renderedText = renderPromptDocument(document);
	if (!renderedText) {
		throw new PromptGraphError("document_invalid", `prompt document '${document.documentId}' is empty`, {
			graphId: document.graphId,
			documentId: document.documentId,
		});
	}
	const renderedDigest = digestText(renderedText);
	const snapshotSeed = {
		graphId: document.graphId,
		documentId: document.documentId,
		revision: document.revision,
		changeId: document.changeId,
		renderedDigest,
	};
	return {
		schema: AGENT_PROMPT_SNAPSHOT_SCHEMA,
		snapshotId: `aps_${digestJson(snapshotSeed).slice(0, 24)}`,
		graphId: document.graphId,
		documentId: document.documentId,
		documentUri: document.documentUri,
		renderedText,
		renderedDigest,
		revision: document.revision,
		changeId: document.changeId,
		blocks: document.blocks.map((block) => ({
			blockId: block.blockId,
			blockUri: block.blockUri,
			role: typeof block.attrs?.role === "string" ? block.attrs.role : undefined,
			digest: block.text ? digestText(block.text.trim()) : undefined,
		})),
		renderedAt: now,
	};
}

export function buildAgentPromptBinding(input: {
	registeredName: string;
	provider: string;
	model: string;
	snapshot: AgentPromptSnapshotV1;
	promotedBy: string;
	promotedAt?: number;
}): AgentPromptBindingV1 {
	const registeredName = requireText(input.registeredName, "registeredName");
	const provider = requireText(input.provider, "provider");
	const model = requireText(input.model, "model");
	const promotedBy = requireText(input.promotedBy, "promotedBy");
	const agentId = mintStandaloneAgentId({ name: registeredName });
	const bindingSeed = {
		agentId,
		provider,
		model,
		snapshotId: input.snapshot.snapshotId,
		renderedDigest: input.snapshot.renderedDigest,
	};
	return {
		schema: AGENT_PROMPT_BINDING_SCHEMA,
		bindingId: `apb_${digestJson(bindingSeed).slice(0, 24)}`,
		agentId,
		agentUri: mintAgentUri(agentId),
		registeredName,
		identityAlgorithm: STANDALONE_AGENT_IDENTITY_ALGORITHM,
		promptRole: "system",
		promptDocumentId: input.snapshot.documentId,
		snapshot: input.snapshot,
		inference: { provider, model },
		status: "active",
		promotedAt: input.promotedAt ?? input.snapshot.renderedAt,
		promotedBy,
	};
}

/**
 * Read an active binding and its current source document. The active binding is
 * the owner's authority over the prompt document and inference tuple; the
 * document's current text is snapshotted for this new session. Later edits are
 * visible only to later resolutions. Every graph or shape error aborts the wave.
 */
export async function resolveAgentPromptBindingStrict(input: {
	graph: GraphWriter;
	graphId: string;
	bindingDocumentId: string;
	expectedRegisteredName?: string;
	now?: number;
}): Promise<ResolvedAgentPromptV1> {
	// Garden's JSON read face is the TipTap editor envelope. Prompt bindings are
	// JSON authored as document text, so resolve them through canonical markdown.
	const bindingDocument = await readDocumentStrict(input.graph, input.graphId, input.bindingDocumentId, "markdown");
	const binding = parseAgentPromptBinding(documentJson(bindingDocument), {
		graphId: input.graphId,
		documentId: input.bindingDocumentId,
	});
	if (input.expectedRegisteredName && binding.registeredName !== input.expectedRegisteredName) {
		throw bindingError(
			`prompt binding belongs to '${binding.registeredName}', not '${input.expectedRegisteredName}'`,
			input.graphId,
			input.bindingDocumentId,
		);
	}
	const currentDocument = await readDocumentStrict(input.graph, input.graphId, binding.promptDocumentId, "markdown");
	const currentSnapshot = buildAgentPromptSnapshot(currentDocument, input.now);
	const executionBinding = buildAgentPromptBinding({
		registeredName: binding.registeredName,
		provider: binding.inference.provider,
		model: binding.inference.model,
		snapshot: currentSnapshot,
		promotedBy: binding.promotedBy,
		promotedAt: input.now,
	});
	return {
		binding,
		executionBinding,
		currentSnapshot,
		dirty: currentSnapshot.renderedDigest !== binding.snapshot.renderedDigest,
		systemPrompt: currentSnapshot.renderedText,
	};
}

/** Promote the current graph document into a new immutable executable binding. */
export async function promoteAgentPromptBinding(input: {
	graph: GraphWriter;
	graphId: string;
	promptDocumentId: string;
	bindingDocumentId: string;
	registeredName: string;
	provider: string;
	model: string;
	promotedBy: string;
	now?: number;
}): Promise<AgentPromptBindingV1> {
	const document = await readDocumentStrict(input.graph, input.graphId, input.promptDocumentId, "markdown");
	const snapshot = buildAgentPromptSnapshot(document, input.now);
	const binding = buildAgentPromptBinding({
		registeredName: input.registeredName,
		provider: input.provider,
		model: input.model,
		snapshot,
		promotedBy: input.promotedBy,
		promotedAt: input.now,
	});
	try {
		await writeJsonDocument(input.graph, input.graphId, input.bindingDocumentId, binding);
	} catch (cause) {
		throw new PromptGraphError(
			"graph_unavailable",
			`could not publish prompt binding '${input.bindingDocumentId}' in graph '${input.graphId}'`,
			{ graphId: input.graphId, documentId: input.bindingDocumentId, cause },
		);
	}
	return binding;
}

export function parseAgentPromptBinding(
	value: unknown,
	context: { graphId: string; documentId: string },
): AgentPromptBindingV1 {
	if (!isRecord(value) || value.schema !== AGENT_PROMPT_BINDING_SCHEMA) {
		throw bindingError(`expected schema '${AGENT_PROMPT_BINDING_SCHEMA}'`, context.graphId, context.documentId);
	}
	const registeredName = requireBindingText(value.registeredName, "registeredName", context);
	const agentId = requireBindingText(value.agentId, "agentId", context);
	if (agentId !== mintStandaloneAgentId({ name: registeredName })) {
		throw bindingError("agentId does not match the registered-name identity", context.graphId, context.documentId);
	}
	if (value.agentUri !== mintAgentUri(agentId)) {
		throw bindingError("agentUri does not match agentId", context.graphId, context.documentId);
	}
	if (value.identityAlgorithm !== STANDALONE_AGENT_IDENTITY_ALGORITHM) {
		throw bindingError("unsupported identityAlgorithm", context.graphId, context.documentId);
	}
	if (value.status !== "active") {
		throw bindingError("prompt binding is not active", context.graphId, context.documentId);
	}
	const snapshot = parseSnapshot(value.snapshot, context);
	if (value.promptDocumentId !== snapshot.documentId) {
		throw bindingError("promptDocumentId does not match snapshot", context.graphId, context.documentId);
	}
	if (!isRecord(value.inference)) {
		throw bindingError("inference must be an object", context.graphId, context.documentId);
	}
	const binding = value as unknown as AgentPromptBindingV1;
	const expectedBinding = buildAgentPromptBinding({
		registeredName,
		provider: requireBindingText(value.inference.provider, "inference.provider", context),
		model: requireBindingText(value.inference.model, "inference.model", context),
		snapshot,
		promotedBy: requireBindingText(value.promotedBy, "promotedBy", context),
		promotedAt: requireBindingNumber(value.promotedAt, "promotedAt", context),
	});
	if (binding.bindingId !== expectedBinding.bindingId) {
		throw bindingError("bindingId does not match binding content", context.graphId, context.documentId);
	}
	return binding;
}

export function documentJson(document: GraphDocumentRead): unknown {
	if (!document.text?.trim()) {
		throw new PromptGraphError("document_invalid", `document '${document.documentId}' has no JSON content`, {
			graphId: document.graphId,
			documentId: document.documentId,
		});
	}
	try {
		return JSON.parse(unwrapAuthoredJsonDocument(document.text));
	} catch (cause) {
		throw new PromptGraphError("document_invalid", `document '${document.documentId}' contains invalid JSON`, {
			graphId: document.graphId,
			documentId: document.documentId,
			cause,
		});
	}
}

async function readDocumentStrict(
	graph: GraphWriter,
	graphId: string,
	documentId: string,
	format: "markdown" | "json",
): Promise<GraphDocumentRead> {
	try {
		return await graph.readDocument(graphId, documentId, { format });
	} catch (cause) {
		throw new PromptGraphError(
			"graph_unavailable",
			`graph unavailable while reading '${documentId}' from '${graphId}'`,
			{ graphId, documentId, cause },
		);
	}
}

function parseSnapshot(value: unknown, context: { graphId: string; documentId: string }): AgentPromptSnapshotV1 {
	if (!isRecord(value) || value.schema !== AGENT_PROMPT_SNAPSHOT_SCHEMA) {
		throw bindingError("prompt snapshot schema is invalid", context.graphId, context.documentId);
	}
	const snapshot = value as unknown as AgentPromptSnapshotV1;
	const digest = digestText(requireBindingText(value.renderedText, "snapshot.renderedText", context));
	if (digest !== value.renderedDigest) {
		throw bindingError("snapshot renderedDigest does not match renderedText", context.graphId, context.documentId);
	}
	const seed = {
		graphId: requireBindingText(value.graphId, "snapshot.graphId", context),
		documentId: requireBindingText(value.documentId, "snapshot.documentId", context),
		revision: typeof value.revision === "number" ? value.revision : undefined,
		changeId: typeof value.changeId === "string" ? value.changeId : undefined,
		renderedDigest: digest,
	};
	if (value.snapshotId !== `aps_${digestJson(seed).slice(0, 24)}`) {
		throw bindingError("snapshotId does not match snapshot content", context.graphId, context.documentId);
	}
	return snapshot;
}

function renderPromptDocument(document: GraphDocumentRead): string {
	const direct = document.text?.trim();
	if (direct) return direct;
	return document.blocks
		.map((block) => block.text?.trim())
		.filter((text): text is string => Boolean(text))
		.join("\n\n")
		.trim();
}

function digestText(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function digestJson(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function requireText(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`${label} must be a non-empty string`);
	return normalized;
}

function requireBindingText(value: unknown, label: string, context: { graphId: string; documentId: string }): string {
	if (typeof value !== "string" || !value.trim()) {
		throw bindingError(`${label} must be a non-empty string`, context.graphId, context.documentId);
	}
	return value;
}

function requireBindingNumber(value: unknown, label: string, context: { graphId: string; documentId: string }): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw bindingError(`${label} must be a finite number`, context.graphId, context.documentId);
	}
	return value;
}

function bindingError(message: string, graphId: string, documentId: string): PromptGraphError {
	return new PromptGraphError("binding_invalid", message, { graphId, documentId });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
