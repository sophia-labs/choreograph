/**
 * Choreograph's agent body: one upstream pi session (`@earendil-works/pi-coding-agent`, pinned exactly) behind the
 * host bridge. It replaces the hosted Prime fork for local Choreograph: the host is unchanged, the body speaks the
 * same bridge, and everything with authority stays on the host (the model key and the call, the graph and its
 * tools, budgets, checkpoints). The body holds a transcript and nothing else.
 *
 * What the hosted Prime body has and this one does not: a persistent IPython kernel, goals, autonomous continuation,
 * recursive child sessions, sealed execution capsules, runtime overlays and candidate workspaces. A request that
 * needs one of those is refused at activation with the reason; a request that merely allows a kernel runs without
 * one.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { PrimeGoalHostResponseV1 } from "../../../src/agent-runtime/host-protocol.js";
import type { AgentSpawnRequest, AgentSpawnResult } from "../../../src/wire-protocol.js";
import { HostBridge, type ResidentCommand, type SteerCommand } from "./bridge.js";
import { createHostProvider, wireModelFor } from "./host-provider.js";
import { createHostToolSurface, type HostToolSurface, render, type TerminalState } from "./host-tools.js";
import { assertRestorableState, runtimeState } from "./state.js";

/** pi's own tools, never offered here: the body's tools are the host's. */
const PI_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"];

interface Counters {
	turns: number;
	toolCalls: number;
	truncated: boolean;
}

interface Completion {
	status: AgentSpawnResult["status"];
	output: string;
	event:
		| { name: "message.completed"; payload: { output: string } }
		| { name: "budget.exhausted"; payload: { output: string; turns: number } }
		| { name: "turn.failed"; payload: { message: string } };
}

export async function runBody(
	input: Readable = process.stdin,
	output: Writable = process.stdout,
	log: (line: string) => void = (line) => process.stderr.write(`[agent-body] ${line}\n`),
): Promise<void> {
	const bridge = new HostBridge(input, output, log);
	let request: AgentSpawnRequest | undefined;
	let root: string | undefined;
	let session: AgentSession | undefined;
	const unsubscribers: Array<() => void> = [];
	try {
		const activation = await bridge.readActivation();
		request = activation.request;
		refuseWhatThisBodyCannotDo(request);
		if (activation.state) assertRestorableState(activation.state, request, activation.sessionRevision);
		if (request.runtime_binding.constraints.allowPersistentKernel) {
			log("the binding allows a persistent kernel; this body has none, so the agent runs without one");
		}

		root = mkdtempSync(join(tmpdir(), "choreograph-body-"));
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true, mode: 0o700 });
		mkdirSync(agentDir, { recursive: true, mode: 0o700 });

		const wire = wireModelFor(request);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: null,
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const host = createHostProvider(bridge, wire);
		modelRuntime.registerNativeProvider(host.provider);

		const surface = await createHostToolSurface(request, bridge);
		const toolNames = surface.tools.map((tool) => tool.name);
		const prompt = systemPromptFor(request);
		const settingsManager = SettingsManager.inMemory({ enableInstallTelemetry: false, retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [
				{
					name: "choreograph-prompt",
					// The host's prompt, exactly: the request's own, the identity it pins, and the completion contract.
					factory: (pi) => {
						pi.on("before_agent_start", () => ({ systemPrompt: prompt }));
					},
				},
			],
		});
		await resourceLoader.reload();
		const sessionManager = activation.state
			? SessionManager.inMemory(cwd, undefined, [
					activation.state.sessionHeader as never,
					...(activation.state.entries as never[]),
				])
			: SessionManager.inMemory(cwd);
		const created = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model: host.model,
			thinkingLevel: "off",
			resourceLoader,
			sessionManager,
			settingsManager,
			customTools: surface.tools,
			tools: toolNames,
			excludeTools: PI_BUILTIN_TOOLS.filter((name) => !toolNames.includes(name)),
		});
		session = created.session;
		await session.bindExtensions({
			onError: (error) => log(`extension ${error.extensionPath} failed on ${error.event}: ${String(error.error)}`),
		});

		const counters: Counters = { turns: 0, toolCalls: 0, truncated: false };
		const live = session;
		const spawnRequest = request;
		unsubscribers.push(live.subscribe((event) => reportEvent(event, spawnRequest, counters, bridge, live)));

		let initialCommandPending = request.await_initial_command === true;
		unsubscribers.push(
			bridge.onSteer((command) => {
				const completesActivation = initialCommandPending;
				if (completesActivation) initialCommandPending = false;
				void steer(live, command)
					.then(async () => {
						bridge.emitEvent({
							name: "input.steer",
							payload: { text: command.payload.text },
							...(command.commandId ? { commandId: command.commandId } : {}),
							causationId: command.messageId,
						});
						if (completesActivation) {
							await live.waitForIdle();
							const completion = classify(spawnRequest, surface.terminal, counters, live);
							bridge.emitEvent(completion.event);
							const result = spawnResult(spawnRequest, live, bridge, counters, surface, completion);
							bridge.emitCommandResult(command, { status: "completed", result });
							bridge.emitResult(result);
							return;
						}
						bridge.emitCommandResult(command, { status: "completed" });
					})
					.catch((error: unknown) => {
						const message = errorMessage(error);
						bridge.emitCommandResult(command, { status: "failed", error: message });
						if (completesActivation) bridge.emitResult(errorResult(spawnRequest, message));
					});
			}),
		);

		let resolveQuiesced!: () => void;
		const quiesced = new Promise<void>((resolve) => {
			resolveQuiesced = resolve;
		});
		bridge.onShutdown(() => resolveQuiesced());
		let tail: Promise<void> = Promise.resolve();
		const subscribeCommands = () =>
			bridge.onCommand((command) => {
				tail = tail.then(async () => {
					const firstStimulus =
						initialCommandPending &&
						(command.name === "input.prompt" || command.name === "input.follow_up" || isGoalCommand(command));
					try {
						const result = await residentCommand(command, spawnRequest, live, bridge, counters, surface);
						bridge.emitCommandResult(command, { status: "completed", result });
						if (firstStimulus) {
							initialCommandPending = false;
							bridge.emitResult(result as AgentSpawnResult);
						}
						if (command.name === "runtime.quiesce") resolveQuiesced();
					} catch (error) {
						const message = errorMessage(error);
						bridge.emitCommandResult(command, { status: "failed", error: message });
						if (firstStimulus) {
							initialCommandPending = false;
							bridge.emitResult(errorResult(spawnRequest, message));
						}
					}
				});
			});

		if (initialCommandPending) {
			// The durable first command is this materialization's first stimulus: listen before anything else runs,
			// so a command queued right behind the activation cannot be lost or overtaken.
			unsubscribers.push(subscribeCommands());
		} else {
			surface.beginCommand();
			await live.prompt(request.intent, { expandPromptTemplates: false, source: "extension" });
			await live.waitForIdle();
			const completion = classify(request, surface.terminal, counters, live);
			bridge.emitEvent(completion.event);
			bridge.emitResult(spawnResult(request, live, bridge, counters, surface, completion));
			unsubscribers.push(subscribeCommands());
		}
		await Promise.race([quiesced, bridge.waitForInputClose()]);
		await tail;
	} catch (error) {
		const message = errorMessage(error);
		if (!request) throw error;
		try {
			bridge.emitEvent({ name: "turn.failed", payload: { message } });
			bridge.emitResult(errorResult(request, message));
		} catch (reportError) {
			log(`could not report the failure (${errorMessage(reportError)}): ${message}`);
		}
	} finally {
		for (const unsubscribe of unsubscribers.reverse()) unsubscribe();
		try {
			session?.dispose();
		} catch {
			// the process is ending either way
		}
		bridge.close();
		if (root) rmSync(root, { recursive: true, force: true });
	}
}

/** Fail at activation, with the reason, for what only the hosted Prime body provides. */
export function refuseWhatThisBodyCannotDo(request: AgentSpawnRequest): void {
	const refuse = (what: string) => {
		throw new Error(`${what} needs the hosted Prime agent body; this Choreograph runs the pi body, which has none`);
	};
	if (request.medium !== "conversation") refuse(`the "${request.medium}" medium`);
	if (request.initial_goal) refuse("a goal");
	if (request.runtime_binding.constraints.allowAutonomousContinuation) refuse("autonomous continuation");
	if (request.verified_execution_capsule) refuse("a sealed execution capsule");
	if ((request.runtime_overlays?.length ?? 0) > 0) refuse("a runtime overlay");
	if (request.candidate_workspace) refuse("a candidate workspace");
}

export function systemPromptFor(request: AgentSpawnRequest): string {
	const base =
		request.system_prompt ??
		`You are ${request.agent_ontology.subject.registeredName}, a Sophia agent. Complete the requested task using only the tools the host grants, then call done().`;
	return [base, attestation(request), completionContract(request)]
		.filter((part): part is string => Boolean(part))
		.join("\n\n");
}

function completionContract(request: AgentSpawnRequest): string | undefined {
	if (request.output_schema) {
		return [
			"# Required completion contract",
			"Complete any necessary work, then call the `submit` tool exactly once with arguments matching its schema.",
			"Do not print, fence, or narrate the final JSON as assistant text. Plain JSON text does not complete this task.",
		].join("\n");
	}
	if (request.wards.require_done_tool) {
		return [
			"# Required completion contract",
			"Complete any necessary work, then call the `done` tool exactly once with the complete result.",
			"Plain assistant text does not complete this task.",
		].join("\n");
	}
	return undefined;
}

function attestation(request: AgentSpawnRequest): string {
	const objects = request.agent_ontology.objects;
	const coordinate = (ref: {
		ownerPrincipal: string;
		graphId: string;
		objectId: string;
		version: string;
		digest: string;
	}) => `${ref.ownerPrincipal}/${ref.graphId}/${ref.objectId}@${ref.version}#${ref.digest}`;
	return [
		"# Sophia semantic authority",
		`Agent/observer: ${request.agent_id}`,
		`Agent Ontology binding: ${request.agent_ontology_binding_digest}`,
		`Runtime binding: ${request.runtime_binding_digest}`,
		...(request.embodiment_binding_digest ? [`Agent Embodiment: ${request.embodiment_binding_digest}`] : []),
		`Geist Meaningful Object: ${coordinate(objects.geist)}`,
		`Prompt Meaningful Object: ${coordinate(objects.prompt)}`,
		`Harness Meaningful Object: ${coordinate(objects.harness)}`,
		`Tool grant Meaningful Object: ${coordinate(objects.toolGrant)}`,
		"These host-pinned identities and grants are authoritative. Never claim a broader identity, graph scope, or tool grant.",
	].join("\n");
}

async function steer(session: AgentSession, command: SteerCommand): Promise<void> {
	// A steer while nothing runs starts a run with it (the host's steer of an idle session is a prompt).
	if (session.isIdle) {
		await session.prompt(command.payload.text, { expandPromptTemplates: false, source: "extension" });
		return;
	}
	await session.steer(command.payload.text, undefined, { source: "extension" });
}

async function residentCommand(
	command: ResidentCommand,
	request: AgentSpawnRequest,
	session: AgentSession,
	bridge: HostBridge,
	counters: Counters,
	surface: HostToolSurface,
): Promise<AgentSpawnResult | PrimeGoalHostResponseV1> {
	if (isGoalCommand(command)) throw new Error("this agent body keeps no goals");
	if (command.name === "input.abort") {
		await session.abort();
		const output = command.payload.reason ?? "Aborted by the session driver.";
		return spawnResult(request, session, bridge, counters, surface, {
			status: "terminated",
			output,
			event: { name: "message.completed", payload: { output } },
		});
	}
	if (command.name === "runtime.quiesce") {
		await session.waitForIdle();
		const output = session.getLastAssistantText() ?? "";
		return spawnResult(request, session, bridge, counters, surface, {
			status: "terminated",
			output,
			event: { name: "message.completed", payload: { output } },
		});
	}
	surface.beginCommand();
	bridge.emitEvent({
		name: command.name,
		payload: { text: command.payload.text },
		...(command.commandId ? { commandId: command.commandId } : {}),
		causationId: command.messageId,
	});
	if (command.name === "input.prompt" || session.isIdle) {
		await session.prompt(command.payload.text, { expandPromptTemplates: false, source: "extension" });
	} else {
		await session.followUp(command.payload.text, undefined, { source: "extension" });
	}
	await session.waitForIdle();
	const completion = classify(request, surface.terminal, counters, session);
	bridge.emitEvent(completion.event);
	return spawnResult(request, session, bridge, counters, surface, completion);
}

function isGoalCommand(
	command: ResidentCommand,
): command is Extract<ResidentCommand, { name: "goal.get" | "goal.create" | "goal.complete" }> {
	return command.name === "goal.get" || command.name === "goal.create" || command.name === "goal.complete";
}

export function reportEvent(
	event: AgentSessionEvent,
	request: AgentSpawnRequest,
	counters: Counters,
	bridge: HostBridge,
	session: Pick<AgentSession, "abort">,
): void {
	switch (event.type) {
		case "turn_start":
			bridge.emitEvent({ name: "turn.started", payload: { turn: counters.turns + 1 } });
			return;
		case "turn_end":
			counters.turns += 1;
			bridge.emitEvent({ name: "turn.completed", payload: { turn: counters.turns } });
			if (counters.turns >= request.runtime_binding.constraints.maxTurns) {
				counters.truncated = true;
				void session.abort();
			}
			return;
		case "message_update": {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta")
				bridge.emitEvent({ name: "message.delta", payload: { delta: update.delta } });
			if (update.type === "thinking_delta")
				bridge.emitEvent({ name: "reasoning.delta", payload: { delta: update.delta } });
			return;
		}
		case "tool_execution_start":
			counters.toolCalls += 1;
			bridge.emitEvent({
				name: "tool.started",
				payload: { tool: event.toolName, args: isPlainObject(event.args) ? event.args : {} },
			});
			return;
		case "tool_execution_end":
			bridge.emitEvent({
				name: event.isError ? "tool.failed" : "tool.completed",
				payload: { tool: event.toolName, result: render(event.result) },
			});
			return;
		case "compaction_start":
			bridge.emitEvent({ name: "compaction.started", payload: { reason: event.reason } });
			return;
		case "compaction_end":
			bridge.emitEvent({ name: "compaction.completed", payload: { reason: event.reason, aborted: event.aborted } });
			return;
		default:
			return;
	}
}

function classify(
	request: AgentSpawnRequest,
	terminal: TerminalState,
	counters: Counters,
	session: AgentSession,
): Completion {
	const fallback = session.getLastAssistantText() ?? "";
	if (terminal.signaled) {
		const output = terminal.output ?? fallback;
		return { status: "terminated", output, event: { name: "message.completed", payload: { output } } };
	}
	const failure = lastModelFailure(session);
	if (failure)
		return { status: "error", output: failure, event: { name: "turn.failed", payload: { message: failure } } };
	if (request.output_schema) {
		const output = "The agent stopped without calling submit() for the required structured result.";
		return { status: "error", output, event: { name: "turn.failed", payload: { message: output } } };
	}
	if (counters.truncated || counters.turns >= request.runtime_binding.constraints.maxTurns) {
		return {
			status: "truncated",
			output: fallback,
			event: { name: "budget.exhausted", payload: { output: fallback, turns: counters.turns } },
		};
	}
	if (request.wards.require_done_tool) {
		const output = "The agent stopped without calling done().";
		return { status: "error", output, event: { name: "turn.failed", payload: { message: output } } };
	}
	return {
		status: "terminated",
		output: fallback,
		event: { name: "message.completed", payload: { output: fallback } },
	};
}

/** A run that ended on a failed model call (the host refused it, the provider failed, the budget ran out). */
function lastModelFailure(session: AgentSession): string | undefined {
	const last = [...session.messages].reverse().find((message) => message.role === "assistant") as
		| AssistantMessage
		| undefined;
	if (!last || last.stopReason !== "error") return undefined;
	return last.errorMessage?.trim() || "The model call failed.";
}

function spawnResult(
	request: AgentSpawnRequest,
	session: AgentSession,
	bridge: HostBridge,
	counters: Counters,
	surface: HostToolSurface,
	completion: Completion,
): AgentSpawnResult {
	const state = runtimeState(request, session.sessionManager, bridge.workerSequence);
	const messages = session.messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	);
	return {
		spawn_id: request.spawn_id,
		status: completion.status,
		output: completion.output,
		turns: counters.turns,
		messages: JSON.parse(JSON.stringify(messages)),
		tokens: tokenTotal(messages),
		tool_calls: counters.toolCalls,
		...(surface.terminal.structuredOutput === undefined
			? {}
			: { structured_output: surface.terminal.structuredOutput }),
		session_id: request.session_id,
		runtime_binding_digest: request.runtime_binding_digest,
		agent_ontology_binding_digest: request.agent_ontology_binding_digest,
		...(request.embodiment_binding_digest ? { embodiment_digest: request.embodiment_binding_digest } : {}),
		...(request.runtime_overlays
			? { runtime_overlay_digests: request.runtime_overlays.map((overlay) => overlay.artifactDigest) }
			: {}),
		prime_state: state,
	};
}

function errorResult(request: AgentSpawnRequest, message: string): AgentSpawnResult {
	return {
		spawn_id: request.spawn_id,
		status: "error",
		output: message,
		turns: 0,
		session_id: request.session_id,
		runtime_binding_digest: request.runtime_binding_digest,
		agent_ontology_binding_digest: request.agent_ontology_binding_digest,
		...(request.embodiment_binding_digest ? { embodiment_digest: request.embodiment_binding_digest } : {}),
		...(request.runtime_overlays
			? { runtime_overlay_digests: request.runtime_overlays.map((overlay) => overlay.artifactDigest) }
			: {}),
	};
}

function tokenTotal(messages: readonly { role: string }[]): number {
	let total = 0;
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const usage = (message as AssistantMessage).usage;
		if (typeof usage?.totalTokens === "number") total += usage.totalTokens;
	}
	return total;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.trim() || "the agent body failed";
}
