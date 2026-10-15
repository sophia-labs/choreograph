#!/usr/bin/env -S pnpm exec tsx

/** Minimal terminal chat against a local Choreograph orchestrator.
 *
 * Each turn creates or resumes a real session, posts through the ordinary
 * sandbox route, then polls the persisted Pi message history until the
 * assistant reply lands. This is host-side TypeScript; Python exists only in
 * the checksum-pinned hermetic guest bundle.
 *
 * Usage:
 *   pnpm vm:chat
 *   pnpm vm:chat --model gemma-4-26b-a4b-it-heretic --provider lmstudio
 */

import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

interface ChatArgs {
	model?: string;
	provider?: string;
	session?: string;
	timeoutSeconds: number;
	thinking: boolean;
}

interface MessageBlock {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
}

interface PersistedMessage {
	role: string;
	content: MessageBlock[];
}

const baseUrl = (process.env.CHOREOGRAPH_URL ?? "http://localhost:3456").replace(/\/$/, "");
const serviceSecret = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET ?? "dev-internal-secret";
const userId = process.env.CHOREOGRAPH_USER_ID ?? "owner";

function requiredValue(argv: readonly string[], index: number, option: string): string {
	const value = argv[index + 1];
	if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
	return value;
}

function parseArgs(argv: readonly string[]): ChatArgs {
	const parsed: ChatArgs = { timeoutSeconds: 120, thinking: false };
	for (let index = 0; index < argv.length; index += 1) {
		const option = argv[index];
		switch (option) {
			case "--model":
				parsed.model = requiredValue(argv, index, option);
				index += 1;
				break;
			case "--provider":
				parsed.provider = requiredValue(argv, index, option);
				index += 1;
				break;
			case "--session":
				parsed.session = requiredValue(argv, index, option);
				index += 1;
				break;
			case "--timeout": {
				const value = Number(requiredValue(argv, index, option));
				if (!Number.isFinite(value) || value <= 0) throw new Error("--timeout must be a positive number of seconds");
				parsed.timeoutSeconds = value;
				index += 1;
				break;
			}
			case "--thinking":
				parsed.thinking = true;
				break;
			default:
				throw new Error(`unknown option: ${option}`);
		}
	}
	return parsed;
}

async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
	const response = await fetch(`${baseUrl}${path}`, {
		method,
		headers: {
			"content-type": "application/json",
			"x-internal-service": serviceSecret,
			"x-user-id": userId,
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.timeout(30_000),
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}: ${text}`);
	return JSON.parse(text) as T;
}

const sleep = (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds));

async function messages(sessionId: string): Promise<PersistedMessage[]> {
	const response = await api<{ messages: PersistedMessage[] }>("GET", `/api/sessions/${sessionId}/messages`);
	return response.messages;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	let sessionId = args.session;
	if (!sessionId) {
		const response = await api<{ session: { session_id: string } }>("POST", "/api/sessions", {
			title: "terminal chat",
			...(args.model ? { model: args.model } : {}),
			...(args.provider ? { provider: args.provider } : {}),
		});
		sessionId = response.session.session_id;
	}

	output.write(`session: ${sessionId}  (ctrl-c or /quit to exit)\n\n`);
	const terminal = createInterface({ input, output });
	try {
		for (;;) {
			const content = (await terminal.question("you> ")).trim();
			if (!content || content === "/quit") break;

			const before = (await messages(sessionId)).length;
			await api("POST", `/api/sessions/${sessionId}/message`, { content });

			const deadline = Date.now() + args.timeoutSeconds * 1_000;
			let printed = before + 1;
			let done = false;
			while (Date.now() < deadline && !done) {
				await sleep(1_000);
				const current = await messages(sessionId);
				for (const message of current.slice(printed)) {
					printed += 1;
					if (message.role !== "assistant") continue;
					for (const block of message.content) {
						if (args.thinking && block.type === "thinking" && block.thinking?.trim()) {
							output.write(`\n\u001b[2m[thinking]\n${block.thinking.trim()}\u001b[0m\n`);
						}
						if (block.type === "text" && block.text?.trim()) {
							output.write(`\nassistant> ${block.text.trim()}\n\n`);
						}
						if (block.type === "toolCall" && block.name === "done") done = true;
					}
				}
			}
			if (!done) {
				console.error("no completed reply within timeout; inspect journalctl -u choreograph-dev in the VM");
			}
		}
	} finally {
		terminal.close();
	}
}

main().catch(error => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
