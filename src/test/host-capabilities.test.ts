import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { HostCapabilityCatalog } from "../capabilities/catalog.js";
import { createDefaultHostCapabilityCatalog, resolveHttpFaceBaseUrl } from "../capabilities/default-catalog.js";
import { HttpCapabilityBackend, HttpCapabilityDeniedError } from "../capabilities/http.js";
import { SoilCapabilityBackend } from "../capabilities/soil.js";
import { resolveYwsServerUrl } from "../capabilities/yws.js";
import type { CapabilityBackend, HostedMcpToolDescriptor } from "../mnemosyne.js";

const envSnapshot = {
	yws: process.env.CHOREOGRAPH_YWS_SERVER_URL,
	gateway: process.env.MNEMOSYNE_GATEWAY_BASE_URL,
	garden: process.env.GARDEN_HTTP_BASE_URL,
};

afterEach(() => {
	restoreEnv("CHOREOGRAPH_YWS_SERVER_URL", envSnapshot.yws);
	restoreEnv("MNEMOSYNE_GATEWAY_BASE_URL", envSnapshot.gateway);
	restoreEnv("GARDEN_HTTP_BASE_URL", envSnapshot.garden);
});

describe("host capability catalog", () => {
	it("ships every modality in the Hoja swarm contract (Chromium; the Camoufox engine is retired)", () => {
		assert.deepEqual(createDefaultHostCapabilityCatalog().list(), [
			"browser",
			"browser.chromium",
			"discord",
			"evaluation.foreign",
			"evaluation.primary",
			"evaluation.visual",
			"http",
			"mcp",
			"soil",
			"sparql",
			"yws",
		]);
	});

	it("closes already-created backends when a later binding fails", async () => {
		const first = new FakeCapability("first");
		const catalog = new HostCapabilityCatalog()
			.register("first", async () => first)
			.register("broken", async () => {
				throw new Error("factory failed");
			});
		await assert.rejects(
			catalog.bind(["first", "broken"], {
				graphId: "graph-1",
				actorRef: "user:u1",
				ownerUserId: "u1",
				authority: { minimumRole: "viewer", dangerousOps: false },
			}),
			/factory failed/,
		);
		assert.equal(first.closed, true);
	});
});

describe("HTTP face capability", () => {
	it("binds export requests to the canonical owner-scoped graph path", () => {
		process.env.MNEMOSYNE_GATEWAY_BASE_URL = "https://api.garden.example.invalid";
		assert.equal(
			resolveHttpFaceBaseUrl("obs-hoja-canary", "user:probe-sub"),
			"https://api.garden.example.invalid/o/user%3Aprobe-sub/g/obs-hoja-canary/documents/obs-hoja-canary/",
		);
	});

	it("returns a textual face with a digest while retaining credentials host-side", async () => {
		let observedAuthorization: string | null = null;
		const backend = new HttpCapabilityBackend({
			baseUrl: "https://api.example.test/g/graph-1/",
			headers: { Authorization: "Bearer host-secret" },
			fetchFn: async (_input, init) => {
				observedAuthorization = new Headers(init?.headers).get("authorization");
				return new Response("# Seed\n", { status: 200, headers: { "content-type": "text/markdown" } });
			},
		});
		const result = (await backend.callTool("get", { path: "documents/seed/export?format=markdown" })) as {
			body: string;
			bodySha256: string;
		};
		assert.equal(result.body, "# Seed\n");
		assert.match(result.bodySha256, /^[a-f0-9]{64}$/);
		assert.equal(observedAuthorization, "Bearer host-secret");
		assert.equal(JSON.stringify(result).includes("host-secret"), false);
	});

	it("rejects cross-origin URLs and redirect escapes before forwarding", async () => {
		let calls = 0;
		const backend = new HttpCapabilityBackend({
			baseUrl: "https://api.example.test/",
			fetchFn: async () => {
				calls++;
				return new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
			},
		});
		await assert.rejects(() => backend.callTool("get", { url: "https://evil.example/" }), HttpCapabilityDeniedError);
		await assert.rejects(
			() => backend.callTool("get", { path: "/redirect" }),
			(error: unknown) => error instanceof HttpCapabilityDeniedError,
		);
		assert.equal(calls, 1);
	});

	it("keeps requests and redirects inside the bound graph path", async () => {
		let calls = 0;
		const backend = new HttpCapabilityBackend({
			baseUrl: "https://api.example.test/g/graph-1/documents/graph-1/",
			allowedPathPrefixes: ["/g/graph-1/documents/graph-1/"],
			fetchFn: async () => {
				calls++;
				return new Response(null, {
					status: 302,
					headers: { location: "/g/graph-2/documents/graph-2/secret/export" },
				});
			},
		});
		await assert.rejects(
			() => backend.callTool("get", { path: "seed/export" }),
			(error: unknown) => error instanceof HttpCapabilityDeniedError,
		);
		await assert.rejects(
			() => backend.callTool("get", { path: "/g/graph-2/documents/graph-2/secret/export" }),
			HttpCapabilityDeniedError,
		);
		assert.equal(calls, 1);
	});
});

describe("y-websocket capability routing", () => {
	it("derives the exact cloud-2 document room base from the bound graph", () => {
		delete process.env.CHOREOGRAPH_YWS_SERVER_URL;
		process.env.MNEMOSYNE_GATEWAY_BASE_URL = "https://api.garden.example.invalid";
		assert.equal(resolveYwsServerUrl("phanes"), "wss://api.garden.example.invalid/g/phanes/hocuspocus/docs/phanes");
		assert.equal(
			resolveYwsServerUrl("obs-hoja-canary", "user:probe-sub"),
			"wss://api.garden.example.invalid/o/user%3Aprobe-sub/g/obs-hoja-canary/hocuspocus/docs/obs-hoja-canary",
		);
	});

	it("supports an explicit local template without accepting a caller-selected graph", () => {
		process.env.CHOREOGRAPH_YWS_SERVER_URL = "ws://127.0.0.1:9999/g/{graphId}/hocuspocus/docs/{graphId}/";
		assert.equal(resolveYwsServerUrl("local-graph"), "ws://127.0.0.1:9999/g/local-graph/hocuspocus/docs/local-graph");
	});
});

describe("Soil CLI capability", () => {
	const binary = process.env.SOIL_TEST_BIN;
	it("runs an inline markdown roundtrip without leaving an ambient file capability", async () => {
		const temp = mkdtempSync(join(tmpdir(), "soil-inline-roundtrip-"));
		const root = join(temp, "seeds");
		const fake = join(temp, "soil");
		try {
			writeFileSync(fake, '#!/bin/sh\n[ "$1" = roundtrip ] && [ -s "$2" ]\n');
			chmodSync(fake, 0o755);
			mkdirSync(root);
			const backend = await SoilCapabilityBackend.create({ binary: fake, roots: [root] });
			await backend.callTool("roundtrip", { body: "# Inline seed\n\nhello\n" });
			assert.deepEqual(readdirSync(root), []);
		} finally {
			rmSync(temp, { recursive: true, force: true });
		}
	});

	it(
		"projects a real .sd seed through the bounded CLI adapter",
		{ skip: !binary || !existsSync(binary) },
		async () => {
			const root = mkdtempSync(join(tmpdir(), "soil-capability-"));
			try {
				const markdown = join(root, "seed.md");
				const seed = join(root, "seed.sd");
				writeFileSync(markdown, "# A seed\n\nhello\n");
				execFileSync(binary!, ["import", markdown, "--output", seed]);
				const backend = await SoilCapabilityBackend.create({ binary: binary!, roots: [root] });
				const result = (await backend.callTool("export", { path: "seed.sd", face: "json" })) as { body: string };
				const parsed = JSON.parse(result.body) as { type?: string };
				assert.equal(parsed.type, "doc");
				await assert.rejects(() => backend.callTool("export", { path: "../escape.sd" }), /ENOENT|escapes/);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});

class FakeCapability implements CapabilityBackend {
	readonly accessLevel = "ro" as const;
	closed = false;
	constructor(readonly capabilityName: string) {}
	async callTool(): Promise<unknown> {
		return {};
	}
	async listTools(): Promise<readonly HostedMcpToolDescriptor[]> {
		return [];
	}
	async close(): Promise<void> {
		this.closed = true;
	}
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}
