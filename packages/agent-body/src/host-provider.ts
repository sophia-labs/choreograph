/**
 * The model, as the body sees it: a pi provider whose every call is a host bridge `inference.request`.
 *
 * pi 1.2.0 hands a provider a transcript (system messages carry the prompt and the tools); Choreograph's host still
 * speaks pi's earlier request shape, `{ systemPrompt, messages, tools }`, and calls the real provider itself with the
 * host's key, budget and price. This file converts one into the other and turns the host's proxy events back into
 * pi's assistant message events. The body never holds a key and never reaches a network.
 */

import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	createProvider,
	getCurrentSystemPrompt,
	getCurrentTools,
	type Model,
	type Provider,
	parseStreamingJson,
	type SimpleStreamOptions,
	type ToolCall,
	type TranscriptContext,
	toToolDeclaration,
} from "@earendil-works/pi-ai";
import type { AgentSpawnRequest, ProxyAssistantMessageEvent } from "../../../src/wire-protocol.js";
import { type HostBridge, zeroUsage } from "./bridge.js";

/** pi's id for the host-mediated provider and its api. */
export const HOST_PROVIDER_ID = "choreograph-host";
export const HOST_API = "choreograph-host-v1";

/** The model the host is asked for: the request's model, in the shape the host's inference admission reads. */
export interface WireModel {
	readonly id: string;
	readonly name: string;
	readonly api: "openai-completions";
	readonly provider: string;
	readonly baseUrl: string;
	readonly reasoning: boolean;
	readonly input: ("text" | "image")[];
	readonly cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	readonly contextWindow: number;
	readonly maxTokens: number;
}

export function wireModelFor(request: Pick<AgentSpawnRequest, "model" | "provider" | "model_descriptor">): WireModel {
	const descriptor = request.model_descriptor;
	return {
		id: request.model,
		name: descriptor?.name ?? request.model,
		api: "openai-completions",
		provider: request.provider ?? descriptor?.provider ?? "openrouter",
		// The host routes by provider id from its own registry; the body names no network address.
		baseUrl: "host://choreograph",
		reasoning: descriptor?.reasoning ?? false,
		input: descriptor?.input ? [...descriptor.input] : ["text"],
		cost: descriptor?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: descriptor?.contextWindow ?? 128_000,
		maxTokens: descriptor?.maxTokens ?? 4096,
	};
}

/** The request the host's inference proxy reads: pi's earlier `{ systemPrompt, messages, tools }`, as plain JSON. */
export function hostContextFor(context: TranscriptContext): {
	systemPrompt?: string;
	messages: unknown[];
	tools?: unknown[];
} {
	const systemPrompt = getCurrentSystemPrompt(context.messages);
	const tools = getCurrentTools(context.messages).map((tool) => toToolDeclaration(tool));
	const messages = context.messages.filter((message) => message.role !== "system");
	// A JSON round trip: the host digests the request canonically, and typebox schemas carry symbol keys.
	return JSON.parse(
		JSON.stringify({
			...(systemPrompt ? { systemPrompt } : {}),
			messages,
			...(tools.length > 0 ? { tools } : {}),
		}),
	);
}

interface PartialToolCall extends ToolCall {
	partialJson?: string;
}

/**
 * The provider pi registers (`ModelRuntime.registerNativeProvider`) and the one model it serves. Its auth is
 * keyless: the host holds the key.
 */
export function createHostProvider(bridge: HostBridge, wire: WireModel): { provider: Provider; model: Model<string> } {
	const model: Model<string> = {
		id: wire.id,
		name: wire.name,
		api: HOST_API,
		provider: HOST_PROVIDER_ID,
		baseUrl: wire.baseUrl,
		reasoning: wire.reasoning,
		input: [...wire.input],
		cost: { ...wire.cost },
		contextWindow: wire.contextWindow,
		maxTokens: wire.maxTokens,
	};
	const stream = (_model: Model<string>, context: TranscriptContext, options?: SimpleStreamOptions) =>
		streamThroughHost(bridge, wire, context, options);
	const provider = createProvider({
		id: HOST_PROVIDER_ID,
		name: "Choreograph host",
		auth: { apiKey: { name: "Choreograph host (no key in the body)", resolve: async () => ({ auth: {} }) } },
		models: [model],
		api: { stream, streamSimple: stream },
	});
	return { provider, model };
}

export function streamThroughHost(
	bridge: HostBridge,
	wire: WireModel,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const partial: AssistantMessage = {
		role: "assistant",
		stopReason: "stop",
		content: [],
		// The record names the model the host called, so a later turn replays it as that model's own message.
		api: wire.api,
		provider: wire.provider,
		model: wire.id,
		usage: zeroUsage(),
		timestamp: Date.now(),
	};
	const signal = options?.signal;
	let settled = false;
	let handle: ReturnType<HostBridge["requestInference"]> | undefined;
	const finish = (event: AssistantMessageEvent) => {
		if (settled) return;
		settled = true;
		signal?.removeEventListener("abort", onAbort);
		stream.push(event);
	};
	const onAbort = () => {
		handle?.cancel("the body aborted the model call");
		partial.stopReason = "aborted";
		partial.errorMessage = "Aborted";
		finish({ type: "error", reason: "aborted", error: partial });
	};
	if (signal?.aborted) {
		onAbort();
		return stream;
	}
	handle = bridge.requestInference({ ...wire }, hostContextFor(context), (proxyEvent) => {
		if (settled) return;
		const event = assistantEventFor(proxyEvent, partial);
		if (!event) return;
		if (event.type === "done" || event.type === "error") finish(event);
		else stream.push(event);
	});
	signal?.addEventListener("abort", onAbort, { once: true });
	return stream;
}

/** One host proxy event as pi's assistant message event, accumulating into `partial`. */
export function assistantEventFor(
	proxyEvent: ProxyAssistantMessageEvent,
	partial: AssistantMessage,
): AssistantMessageEvent | undefined {
	switch (proxyEvent.type) {
		case "start":
			return { type: "start", partial };
		case "text_start":
			partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
			return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };
		case "text_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type !== "text") throw new Error("the host sent text_delta for a block that is not text");
			content.text += proxyEvent.delta;
			return { type: "text_delta", contentIndex: proxyEvent.contentIndex, delta: proxyEvent.delta, partial };
		}
		case "text_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type !== "text") throw new Error("the host sent text_end for a block that is not text");
			if (proxyEvent.contentSignature) content.textSignature = proxyEvent.contentSignature;
			return { type: "text_end", contentIndex: proxyEvent.contentIndex, content: content.text, partial };
		}
		case "thinking_start":
			partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
			return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };
		case "thinking_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type !== "thinking")
				throw new Error("the host sent thinking_delta for a block that is not thinking");
			content.thinking += proxyEvent.delta;
			return { type: "thinking_delta", contentIndex: proxyEvent.contentIndex, delta: proxyEvent.delta, partial };
		}
		case "thinking_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type !== "thinking")
				throw new Error("the host sent thinking_end for a block that is not thinking");
			if (proxyEvent.contentSignature) content.thinkingSignature = proxyEvent.contentSignature;
			return { type: "thinking_end", contentIndex: proxyEvent.contentIndex, content: content.thinking, partial };
		}
		case "toolcall_start": {
			const toolCall: PartialToolCall = {
				type: "toolCall",
				id: proxyEvent.id,
				name: proxyEvent.toolName,
				arguments: {},
				partialJson: "",
			};
			partial.content[proxyEvent.contentIndex] = toolCall;
			return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };
		}
		case "toolcall_delta": {
			const content = partial.content[proxyEvent.contentIndex] as PartialToolCall | undefined;
			if (content?.type !== "toolCall")
				throw new Error("the host sent toolcall_delta for a block that is not a tool call");
			content.partialJson = `${content.partialJson ?? ""}${proxyEvent.delta}`;
			content.arguments = parseStreamingJson(content.partialJson) || {};
			return { type: "toolcall_delta", contentIndex: proxyEvent.contentIndex, delta: proxyEvent.delta, partial };
		}
		case "toolcall_end": {
			const content = partial.content[proxyEvent.contentIndex] as PartialToolCall | undefined;
			if (content?.type !== "toolCall") return undefined;
			delete content.partialJson;
			return { type: "toolcall_end", contentIndex: proxyEvent.contentIndex, toolCall: content, partial };
		}
		case "done":
			partial.stopReason = proxyEvent.reason;
			partial.usage = { ...proxyEvent.usage, cost: { ...proxyEvent.usage.cost } };
			return { type: "done", reason: proxyEvent.reason, message: partial };
		case "error":
			partial.stopReason = proxyEvent.reason;
			partial.errorMessage =
				proxyEvent.errorMessage ?? (proxyEvent.reason === "aborted" ? "Aborted" : "The model call failed");
			partial.usage = { ...proxyEvent.usage, cost: { ...proxyEvent.usage.cost } };
			return { type: "error", reason: proxyEvent.reason, error: partial };
	}
}
