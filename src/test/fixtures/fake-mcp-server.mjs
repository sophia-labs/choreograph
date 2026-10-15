#!/usr/bin/env node

const AVAILABLE_TOOLS = (process.env.FAKE_MCP_TOOLS ?? "search_documents,read_document,append_to_document,remember")
	.split(",")
	.map((entry) => entry.trim())
	.filter(Boolean);

let readBuffer = "";

process.stdin.on("data", (chunk) => {
	readBuffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
	drainLines();
});

function drainLines() {
	while (true) {
		const newlineIndex = readBuffer.indexOf("\n");
		if (newlineIndex === -1) {
			return;
		}

		const line = readBuffer.slice(0, newlineIndex).trim();
		readBuffer = readBuffer.slice(newlineIndex + 1);
		if (!line) {
			continue;
		}

		handleMessage(JSON.parse(line));
	}
}

function handleMessage(message) {
	if (message.method === "notifications/initialized") {
		return;
	}

	if (message.method === "initialize") {
		writeMessage({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				protocolVersion: "2025-06-18",
				capabilities: {
					tools: {},
				},
				serverInfo: {
					name: "fake-mnemosyne-mcp",
					version: "0.1.0",
				},
			},
		});
		return;
	}

	if (message.method === "tools/list") {
		writeMessage({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				tools: AVAILABLE_TOOLS.map((name) => ({
					name,
					description: `${name} fixture`,
					inputSchema: {
						type: "object",
					},
				})),
			},
		});
		return;
	}

	if (message.method === "tools/call") {
		const { name, arguments: args } = message.params ?? {};

		if (name === "remember" && typeof args?.content === "string" && args.content.includes("fail")) {
			writeMessage({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					content: [{ type: "text", text: "fixture remember failure" }],
					isError: true,
				},
			});
			return;
		}

		const payload = {
			echoed: {
				name,
				arguments: args,
			},
		};

		writeMessage({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				content: [{ type: "text", text: JSON.stringify(payload) }],
				structuredContent: payload,
				isError: false,
			},
		});
		return;
	}

	writeMessage({
		jsonrpc: "2.0",
		id: message.id,
		error: {
			code: -32601,
			message: `Unknown method: ${message.method}`,
		},
	});
}

function writeMessage(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}
