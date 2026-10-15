/**
 * The body's half of Choreograph's host bridge (`choreograph.prime-host-bridge.v1`): NDJSON over stdin/stdout.
 *
 * The host's half and the message grammar live in `src/agent-runtime/host-protocol.ts`; this file imports that
 * grammar instead of keeping a second copy, so a message the body sends is checked by the same parser the host
 * uses. The body asks; the host answers:
 *   - `inference.request`  → `inference.chunk` responses (the model call happens on the host, with the host's key)
 *   - `capability.request` → one `capability.result` (graph tools and other host-bound capabilities)
 *   - `request.cancel`     → the host stops what it was doing for that request
 * The host commands the body (`runtime.initialize|restore`, `input.*`, `runtime.quiesce`, `goal.*`) and the body
 * reports with events (`turn.*`, `message.*`, `tool.*`, …) and results (`runtime.result`, `command.result`).
 */

import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
	PRIME_HOST_PROTOCOL_VERSION,
	type PrimeGoalHostResponseV1,
	type PrimeHostCommandV1,
	type PrimeHostErrorV1,
	type PrimeHostResponseV1,
	type PrimeHostSpawnRequestV1,
	type PrimeWorkerEventName,
	parsePrimeHostBridgeMessage,
} from "../../../src/agent-runtime/host-protocol.js";
import type { PrimeRuntimeStateV2 } from "../../../src/agent-runtime/result-validation.js";
import type { AgentSpawnResult, ProxyAssistantMessageEvent } from "../../../src/wire-protocol.js";

export const HOST_WIRE_MAX_LINE_BYTES = 8 * 1024 * 1024;

export type ActivationCommand = Extract<PrimeHostCommandV1, { name: "runtime.initialize" | "runtime.restore" }>;
export type SteerCommand = Extract<PrimeHostCommandV1, { name: "input.steer" }>;
export type ResidentCommand = Extract<
	PrimeHostCommandV1,
	{
		name:
			| "input.prompt"
			| "input.follow_up"
			| "input.abort"
			| "runtime.quiesce"
			| "goal.get"
			| "goal.create"
			| "goal.complete";
	}
>;
export type ResidentCommandName = ResidentCommand["name"];

export interface Activation {
	readonly request: PrimeHostSpawnRequestV1;
	readonly sessionRevision: number;
	readonly state?: PrimeRuntimeStateV2;
}

export class HostRequestError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly errorClass: PrimeHostErrorV1["class"],
		readonly retryable: boolean,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "HostRequestError";
	}
}

/** What the body reports, in the host's own event vocabulary (`PRIME_WORKER_EVENT_NAMES`). */
export interface BodyEvent {
	readonly name: PrimeWorkerEventName;
	readonly payload: unknown;
	readonly commandId?: string;
	readonly causationId?: string;
}

type Pending<T> = { resolve: (value: T) => void; reject: (error: Error) => void };

const RESIDENT_COMMANDS = new Set<string>([
	"input.prompt",
	"input.follow_up",
	"input.abort",
	"runtime.quiesce",
	"goal.get",
	"goal.create",
	"goal.complete",
]);

export class HostBridge {
	#reader: Interface | undefined;
	#activation: ActivationCommand | undefined;
	#sequence = 0;
	#nextId = 0;
	readonly #inference = new Map<string, (event: ProxyAssistantMessageEvent) => void>();
	readonly #capabilities = new Map<string, Pending<{ result: unknown; isError: boolean }>>();
	#steerHandler: ((command: SteerCommand) => void) | undefined;
	readonly #pendingSteers: SteerCommand[] = [];
	#commandHandler: ((command: ResidentCommand) => void) | undefined;
	readonly #pendingCommands: ResidentCommand[] = [];
	#shutdownHandler: (() => void) | undefined;
	readonly #inputClosed: Promise<void>;
	#resolveInputClosed!: () => void;

	constructor(
		private readonly input: Readable,
		private readonly output: Writable,
		private readonly log: (line: string) => void = (line) => process.stderr.write(`[agent-body] ${line}\n`),
	) {
		this.#inputClosed = new Promise((resolve) => {
			this.#resolveInputClosed = resolve;
		});
	}

	/** Reads until the first `runtime.initialize` / `runtime.restore`, then keeps dispatching what follows. */
	readActivation(): Promise<Activation> {
		return new Promise<Activation>((resolve, reject) => {
			const reader = createInterface({ input: this.input, crlfDelay: Number.POSITIVE_INFINITY });
			this.#reader = reader;
			let activated = false;
			void (async () => {
				try {
					for await (const line of reader) {
						const message = this.#parse(line);
						if (!message) continue;
						if (!activated) {
							if (
								message.kind === "command" &&
								(message.name === "runtime.initialize" || message.name === "runtime.restore")
							) {
								this.#activation = message;
								activated = true;
								resolve({
									request: message.payload.request,
									sessionRevision: message.payload.sessionRevision,
									...(message.name === "runtime.restore" ? { state: message.payload.state } : {}),
								});
								continue;
							}
							throw new Error("the host must send runtime.initialize or runtime.restore first");
						}
						this.#dispatch(message);
					}
					if (!activated) reject(new Error("the host closed the bridge before activating the body"));
					this.#rejectPending(new Error("the host closed the bridge"));
				} catch (error) {
					const normalized = error instanceof Error ? error : new Error(String(error));
					if (!activated) reject(normalized);
					this.#rejectPending(normalized);
				} finally {
					this.#resolveInputClosed();
				}
			})();
		});
	}

	/** The sequence the next message will carry; a runtime state names the sequence of the result that carries it. */
	get workerSequence(): number {
		return this.#sequence;
	}

	waitForInputClose(): Promise<void> {
		return this.#inputClosed;
	}

	close(): void {
		this.#reader?.close();
		this.#reader = undefined;
		this.#rejectPending(new Error("the bridge is closed"));
	}

	onSteer(handler: (command: SteerCommand) => void): () => void {
		this.#steerHandler = handler;
		while (this.#pendingSteers.length > 0 && this.#steerHandler === handler) handler(this.#pendingSteers.shift()!);
		return () => {
			if (this.#steerHandler === handler) this.#steerHandler = undefined;
		};
	}

	onCommand(handler: (command: ResidentCommand) => void): () => void {
		this.#commandHandler = handler;
		while (this.#pendingCommands.length > 0 && this.#commandHandler === handler) {
			handler(this.#pendingCommands.shift()!);
		}
		return () => {
			if (this.#commandHandler === handler) this.#commandHandler = undefined;
		};
	}

	onShutdown(handler: () => void): void {
		this.#shutdownHandler = handler;
	}

	/**
	 * Ask the host for one model call. The host owns the provider, the key, the budget and the bill; the body sees a
	 * stream of proxy events (`ProxyAssistantMessageEvent`) and nothing else.
	 */
	requestInference(
		model: Record<string, unknown>,
		context: unknown,
		onEvent: (event: ProxyAssistantMessageEvent) => void,
	): { requestId: string; cancel: (reason: string) => void } {
		const requestId = `body-llm-${this.#nextId++}`;
		this.#inference.set(requestId, (event) => {
			if (event.type === "done" || event.type === "error") this.#inference.delete(requestId);
			onEvent(event);
		});
		this.#sendRequest(requestId, "inference.request", { requestId, model, context });
		return {
			requestId,
			cancel: (reason) => {
				if (!this.#inference.delete(requestId)) return;
				this.#sendCancel(requestId, reason);
			},
		};
	}

	/** Call one host-bound capability tool (`mnemosyne.search_documents`, `acp.authority.request_permission`, …). */
	callCapability(
		capability: string,
		tool: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<{ result: unknown; isError: boolean }> {
		const label = `${capability}.${tool}`;
		if (signal?.aborted) {
			return Promise.reject(new HostRequestError(`${label} was cancelled`, "request_cancelled", "cancelled", false));
		}
		const requestId = `body-cap-${this.#nextId++}`;
		return new Promise((resolve, reject) => {
			const onAbort = () => {
				if (!this.#capabilities.delete(requestId)) return;
				this.#sendCancel(requestId, `${label} was cancelled`);
				reject(new HostRequestError(`${label} was cancelled`, "request_cancelled", "cancelled", false));
			};
			this.#capabilities.set(requestId, {
				resolve: (value) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(value);
				},
				reject: (error) => {
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			this.#sendRequest(requestId, "capability.request", { requestId, capability, tool, args });
		});
	}

	emitEvent(event: BodyEvent): void {
		const activation = this.#requireActivation();
		const workerSequence = this.#sequence++;
		this.#send({
			protocol: PRIME_HOST_PROTOCOL_VERSION,
			messageId: `worker.event:${activation.sandboxId}:${activation.generation}:${workerSequence}`,
			sessionId: activation.sessionId,
			sandboxId: activation.sandboxId,
			generation: activation.generation,
			correlationId: event.commandId ?? activation.correlationId,
			causationId: event.causationId ?? activation.messageId,
			...(event.commandId ? { commandId: event.commandId } : {}),
			direction: "worker_to_host",
			kind: "event",
			workerSequence,
			name: event.name,
			payload: event.payload,
		});
	}

	emitResult(result: AgentSpawnResult): void {
		const activation = this.#requireActivation();
		const workerSequence = this.#sequence++;
		this.#send({
			protocol: PRIME_HOST_PROTOCOL_VERSION,
			messageId: `runtime.result:${activation.sandboxId}:${activation.generation}:${workerSequence}`,
			sessionId: activation.sessionId,
			sandboxId: activation.sandboxId,
			generation: activation.generation,
			correlationId: activation.correlationId,
			causationId: activation.messageId,
			direction: "worker_to_host",
			kind: "result",
			workerSequence,
			name: "runtime.result",
			payload: { result },
		});
	}

	emitCommandResult(
		command: ResidentCommand | SteerCommand,
		outcome:
			| { status: "completed"; result?: AgentSpawnResult | PrimeGoalHostResponseV1 }
			| { status: "failed"; error: string },
	): void {
		const activation = this.#requireActivation();
		if (!command.commandId) throw new Error(`${command.name} carries no commandId`);
		const workerSequence = this.#sequence++;
		this.#send({
			protocol: PRIME_HOST_PROTOCOL_VERSION,
			messageId: `command.result:${activation.sandboxId}:${activation.generation}:${workerSequence}`,
			sessionId: activation.sessionId,
			sandboxId: activation.sandboxId,
			generation: activation.generation,
			correlationId: command.commandId,
			causationId: command.messageId,
			commandId: command.commandId,
			direction: "worker_to_host",
			kind: "result",
			workerSequence,
			name: "command.result",
			payload: {
				commandId: command.commandId,
				commandName: command.name,
				status: outcome.status,
				...(outcome.status === "completed" && outcome.result ? { result: outcome.result } : {}),
				...(outcome.status === "failed" ? { error: outcome.error || "the command failed" } : {}),
			},
		});
	}

	/** The host's ids for this materialization (session, sandbox, generation), for the runtime state. */
	get materialization(): { sessionId: string; sandboxId: string; generation: number } {
		const activation = this.#requireActivation();
		return { sessionId: activation.sessionId, sandboxId: activation.sandboxId, generation: activation.generation };
	}

	#parse(line: string): ReturnType<typeof parsePrimeHostBridgeMessage> | undefined {
		const bytes = Buffer.byteLength(line, "utf8");
		if (bytes > HOST_WIRE_MAX_LINE_BYTES)
			throw new Error(`a bridge line exceeds ${HOST_WIRE_MAX_LINE_BYTES} bytes (${bytes})`);
		const trimmed = line.trim();
		if (!trimmed) return undefined;
		const value = JSON.parse(trimmed) as unknown;
		// The host also writes a few control frames outside the bridge grammar to every worker kind
		// (`headed_attach`, `headed_close`, `runtime_close`). They are for other bodies; this one has no headed mode.
		if (typeof value === "object" && value !== null && !Array.isArray(value) && !("protocol" in value)) {
			this.log(`ignored a non-bridge control frame (${String((value as { kind?: unknown }).kind)})`);
			return undefined;
		}
		const message = parsePrimeHostBridgeMessage(value);
		if (message.direction !== "host_to_worker") throw new Error("the host sent a worker-to-host message");
		return message;
	}

	#dispatch(message: ReturnType<typeof parsePrimeHostBridgeMessage>): void {
		const activation = this.#requireActivation();
		if (
			message.sessionId !== activation.sessionId ||
			message.sandboxId !== activation.sandboxId ||
			message.generation !== activation.generation
		) {
			throw new Error("a bridge message does not belong to this materialization");
		}
		if (message.kind === "response") {
			this.#dispatchResponse(message as PrimeHostResponseV1);
			return;
		}
		if (message.kind !== "command") return;
		const command = message as PrimeHostCommandV1;
		if (command.name === "runtime.initialize" || command.name === "runtime.restore") return;
		if (command.name === "input.steer") {
			if (!command.payload.text.trim()) return;
			if (this.#steerHandler) this.#steerHandler(command);
			else this.#pendingSteers.push(command);
			return;
		}
		if (command.name === "runtime.shutdown") {
			this.#shutdownHandler?.();
			return;
		}
		if (RESIDENT_COMMANDS.has(command.name)) {
			const resident = command as ResidentCommand;
			if (this.#commandHandler) this.#commandHandler(resident);
			else this.#pendingCommands.push(resident);
			return;
		}
		// permission.resolve, compact.request, model.change, runtime.snapshot: not sent to this body today.
		this.log(`ignored host command ${command.name}`);
	}

	#dispatchResponse(message: PrimeHostResponseV1): void {
		if (!message.ok) {
			const error = new HostRequestError(
				message.error?.message ?? "the host refused the request",
				message.error?.code ?? "host_request_failed",
				message.error?.class ?? "internal",
				message.error?.retryable ?? false,
				message.error?.details,
			);
			const capability = this.#capabilities.get(message.requestId);
			if (capability) {
				this.#capabilities.delete(message.requestId);
				capability.reject(error);
				return;
			}
			const details = isRecord(message.error?.details) ? message.error.details : undefined;
			this.#inference.get(message.requestId)?.({
				type: "error",
				reason: message.error?.class === "cancelled" ? "aborted" : "error",
				errorMessage: error.message,
				usage: isUsage(details?.usage) ? details.usage : zeroUsage(),
			});
			return;
		}
		const result = message.result;
		if (!isRecord(result) || typeof result.kind !== "string") return;
		if (result.kind === "inference.chunk") {
			const event = result.event;
			if (isRecord(event) && typeof event.type === "string") {
				this.#inference.get(message.requestId)?.(event as ProxyAssistantMessageEvent);
			}
			return;
		}
		if (result.kind === "capability.result") {
			const pending = this.#capabilities.get(message.requestId);
			if (!pending) return;
			this.#capabilities.delete(message.requestId);
			pending.resolve({ result: result.result, isError: result.isError === true });
		}
	}

	#sendRequest(
		requestId: string,
		name: "inference.request" | "capability.request" | "request.cancel",
		payload: object,
	): void {
		const activation = this.#requireActivation();
		const workerSequence = this.#sequence++;
		this.#send({
			protocol: PRIME_HOST_PROTOCOL_VERSION,
			messageId: `worker.request:${activation.sandboxId}:${activation.generation}:${workerSequence}`,
			sessionId: activation.sessionId,
			sandboxId: activation.sandboxId,
			generation: activation.generation,
			correlationId: requestId,
			causationId: activation.messageId,
			direction: "worker_to_host",
			kind: "request",
			workerSequence,
			name,
			payload,
		});
	}

	#sendCancel(targetRequestId: string, reason: string): void {
		const requestId = `body-cancel-${this.#nextId++}`;
		this.#sendRequest(requestId, "request.cancel", { requestId, targetRequestId, reason });
	}

	#requireActivation(): ActivationCommand {
		if (!this.#activation) throw new Error("the body is not activated yet");
		return this.#activation;
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#capabilities.values()) pending.reject(error);
		this.#capabilities.clear();
		for (const [requestId, handler] of this.#inference) {
			this.#inference.delete(requestId);
			handler({ type: "error", reason: "error", errorMessage: error.message, usage: zeroUsage() });
		}
	}

	#send(message: Record<string, unknown>): void {
		// The host parses every line with the same grammar; checking here turns a body bug into a body error
		// instead of a host-side protocol fault that ends the materialization.
		parsePrimeHostBridgeMessage(message);
		this.output.write(`${JSON.stringify(message)}\n`);
	}
}

export function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function isUsage(value: unknown): value is ReturnType<typeof zeroUsage> {
	if (!isRecord(value) || !isRecord(value.cost)) return false;
	return ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => typeof value[key] === "number");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
