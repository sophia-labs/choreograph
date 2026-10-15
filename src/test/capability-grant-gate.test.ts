import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyHostCapabilityGrantPolicy, gateCapabilityBackend } from "../capabilities/grant-gate.js";
import type { CapabilityBackend } from "../mnemosyne.js";

function backend(): CapabilityBackend & { calls: string[] } {
	const calls: string[] = [];
	return {
		capabilityName: "mnemosyne",
		accessLevel: "ro",
		calls,
		async callTool(tool) {
			calls.push(tool);
			return { ok: true };
		},
		async listTools() {
			return [
				{ name: "recall", destructive: false },
				{ name: "remember", destructive: true },
			];
		},
		async close() {},
	};
}

describe("exact host capability grant gate", () => {
	it("filters discovery and rejects raw calls outside the exact grant", async () => {
		const raw = backend();
		const gated = gateCapabilityBackend(raw, ["recall"]);
		assert.deepEqual(await gated.listTools(), [{ name: "recall", destructive: false }]);
		await gated.callTool("recall", {});
		await assert.rejects(() => gated.callTool("remember", {}), /outside the exact host grant/);
		assert.deepEqual(raw.calls, ["recall"]);
	});

	it("projects the trusted manifest's destructive bit into worker discovery", async () => {
		const gated = gateCapabilityBackend(backend(), ["recall"], undefined, { recall: true });
		assert.deepEqual(await gated.listTools(), [{ name: "recall", destructive: true }]);
	});

	it("pins non-domain runs fail-closed while exempting the permission mechanism", async () => {
		const ordinary = backend();
		const authority: CapabilityBackend = {
			...backend(),
			capabilityName: "acp.authority",
		};
		const gated = applyHostCapabilityGrantPolicy(
			new Map([
				["mnemosyne", ordinary],
				["acp.authority", authority],
			]),
			{ exactTools: {} },
		);

		assert.deepEqual(await gated.get("mnemosyne")?.listTools(), []);
		await assert.rejects(() => gated.get("mnemosyne")!.callTool("recall", {}), /outside the exact host grant/);
		assert.equal(gated.get("acp.authority"), authority);
	});

	it("enforces the steward's per-wave quota before backend dispatch", async () => {
		const raw = backend();
		const gated = gateCapabilityBackend(raw, ["recall"], {
			capability: "mnemosyne",
			operations: ["recall"],
			access: "read",
			approvalPolicy: "ordinary",
			fence: {},
			quota: { maxPerWave: 1, maxConcurrent: 1 },
		});
		await gated.callTool("recall", {});
		await assert.rejects(() => gated.callTool("recall", {}), /quota is exhausted/);
		assert.deepEqual(raw.calls, ["recall"]);
	});
});
