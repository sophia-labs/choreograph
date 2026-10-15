import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { DeleteParameterCommand, GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import {
	handleOpenRouterCredential,
	type OpenRouterKeyStore,
	resolveOpenRouterKey,
	SsmOpenRouterKeyStore,
} from "../openrouter-credentials.js";

const keyA = "sk-or-v1-fixtureOwnerAAAAAAAA";
const keyB = "sk-or-v1-fixtureOwnerBBBBBBBB";
function fixtureStore() {
	const records = new Map<string, string>();
	const store: OpenRouterKeyStore = {
		get: async (o) => records.get(o),
		put: async (o, k) => {
			records.set(o, k);
		},
		delete: async (o) => {
			records.delete(o);
		},
	};
	return { records, store };
}
test("credential HTTP authority, secrecy, owner separation, invalid body, deletion and failure", async () => {
	const { store, records } = fixtureStore();
	const previous = process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
	process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = "fixture-service";
	const server = createServer((req, res) => {
		void handleOpenRouterCredential(req, res, {
			store,
			platformKey: "platform-fixture",
			resolveOwner: async ({ authContext }) => {
				if (authContext.method === "internal_service") return authContext.userId;
				if (!["owner-a", "owner-b"].includes(authContext.bearerToken))
					throw new Error("sensitive verifier failure");
				return authContext.bearerToken;
			},
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/me/provider-credentials/openrouter`;
	const call = async (method: string, owner?: string, body?: unknown, extra: Record<string, string> = {}) => {
		const response = await fetch(url, {
			method,
			headers: { ...(owner ? { authorization: `Bearer ${owner}` } : {}), ...extra },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
	};
	try {
		assert.equal((await call("GET")).status, 401);
		assert.equal((await call("GET", "invalid")).status, 401);
		assert.deepEqual((await call("GET", "owner-a")).body, {
			provider: "openrouter",
			configured: false,
			effectiveSource: "platform",
		});
		for (const body of [
			{},
			{ apiKey: "" },
			{ apiKey: "bad" },
			{ apiKey: keyA, owner: "owner-b" },
			{ apiKey: keyA, password: "secret" },
		])
			assert.equal((await call("PUT", "owner-a", body)).status, 400);
		assert.equal((await call("PUT", "owner-a", { apiKey: "x".repeat(9000) })).status, 413);
		assert.equal((await call("PUT", "owner-a", { apiKey: keyA })).status, 200);
		assert.equal((await call("PUT", "owner-b", { apiKey: keyB })).status, 200);
		const status = await call("GET", "owner-a");
		assert.deepEqual(status.body, { provider: "openrouter", configured: true, effectiveSource: "platform" });
		assert.equal(status.cache, "no-store");
		assert.equal(JSON.stringify(status).includes(keyA), false);
		const service = { "x-internal-service": "fixture-service", "x-user-id": "owner-a" };
		assert.equal((await call("GET", undefined, undefined, service)).status, 200);
		for (const method of ["PUT", "DELETE"])
			assert.equal(
				(await call(method, "owner-b", method === "PUT" ? { apiKey: keyB } : undefined, service)).status,
				403,
			);
		assert.equal(records.get("owner-a"), keyA);
		assert.equal((await call("DELETE", "owner-a")).body.configured, false);
		assert.equal((await call("DELETE", "owner-a")).status, 200);
		assert.equal(records.get("owner-b"), keyB);
		store.get = async () => {
			throw new Error(keyA);
		};
		const failure = await call("GET", "owner-b");
		assert.equal(failure.status, 503);
		assert.equal(JSON.stringify(failure).includes(keyA), false);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
		if (previous === undefined) delete process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET;
		else process.env.MNEMOSYNE_INTERNAL_SERVICE_SECRET = previous;
	}
});
test("trusted owner inference resolution observes replacement/delete without cache and fails closed", async () => {
	const { store, records } = fixtureStore();
	records.set("a", keyA);
	records.set("b", keyB);
	assert.equal(await resolveOpenRouterKey(store, "a", "platform"), "platform");
	assert.equal(await resolveOpenRouterKey(store, "a", undefined), undefined);
	assert.equal(await resolveOpenRouterKey(store, "a", "platform", true), keyA);
	assert.equal(await resolveOpenRouterKey(store, "b", "platform", true), keyB);
	assert.equal(await resolveOpenRouterKey(store, undefined, "platform", true), "platform");
	records.set("a", keyB);
	assert.equal(await resolveOpenRouterKey(store, "a", "platform", true), keyB);
	await store.delete("a");
	assert.equal(await resolveOpenRouterKey(store, "a", "platform", true), "platform");
	assert.equal(await resolveOpenRouterKey(store, "a", undefined, true), undefined);
	records.set("a", "invalid");
	await assert.rejects(resolveOpenRouterKey(store, "a", "platform", true));
	store.get = async () => {
		throw new Error("unavailable");
	};
	await assert.rejects(resolveOpenRouterKey(store, "a", "platform", true));
});
test("encrypted SSM API-key leaf is owner/provider separated and missing is idempotent", async () => {
	const calls: any[] = [];
	let value: string | undefined;
	const client = {
		send: async (command: any) => {
			calls.push(command);
			if (command instanceof PutParameterCommand) {
				value = command.input.Value;
				return {};
			}
			if (command instanceof GetParameterCommand) {
				if (value === undefined) throw Object.assign(new Error(), { name: "ParameterNotFound" });
				return { Parameter: { Value: value } };
			}
			if (command instanceof DeleteParameterCommand) {
				value = undefined;
				return {};
			}
			throw new Error("unexpected");
		},
	};
	const store = new SsmOpenRouterKeyStore(client as never, "/fixture/credentials", "alias/fixture");
	assert.equal(await store.get("a"), undefined);
	await store.put("a", keyA);
	assert.equal(await store.get("a"), keyA);
	const put = calls.find((c) => c instanceof PutParameterCommand);
	assert.ok(put?.input.Name);
	assert.equal(put.input.Type, "SecureString");
	assert.equal(put.input.Tier, "Standard");
	assert.ok(Buffer.byteLength(put.input.Value!) < 4096);
	assert.equal(put.input.KeyId, "alias/fixture");
	assert.match(put.input.Name, /\/[a-f0-9]{64}\/openrouter$/);
	assert.equal(
		calls.filter((c) => c instanceof GetParameterCommand).every((c) => c.input.WithDecryption),
		true,
	);
	await store.put("a", `sk-or-v1-${"a".repeat(512)}`);
	const largest = calls.at(-1) as PutParameterCommand;
	assert.equal(largest.input.Tier, "Standard");
	assert.ok(Buffer.byteLength(largest.input.Value!) < 4096);
	await assert.rejects(store.put("a", `sk-or-v1-${"a".repeat(513)}`), /Invalid OpenRouter/);
	await store.delete("a");
	assert.equal(await store.get("a"), undefined);
});
