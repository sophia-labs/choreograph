import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { primeRuntimeOverlayEnvelope } from "../spawner.js";
import type { AgentSpawnRequest } from "../wire-protocol.js";

describe("Prime runtime overlay envelope", () => {
	it("omits runtime_overlays for an ordinary v2 Prime without embodiment authority", () => {
		const envelope = primeRuntimeOverlayEnvelope({}, []);
		assert.deepEqual(envelope, {});
		assert.equal(Object.hasOwn(envelope, "runtime_overlays"), false);
	});

	it("retains an explicit empty overlay list for a complete zero-overlay embodiment", () => {
		const request = {
			embodiment_ref: {} as NonNullable<AgentSpawnRequest["embodiment_ref"]>,
			embodiment_binding: {} as NonNullable<AgentSpawnRequest["embodiment_binding"]>,
			embodiment_binding_digest: "a".repeat(64),
		};
		assert.deepEqual(primeRuntimeOverlayEnvelope(request, []), { runtime_overlays: [] });
	});

	it("rejects materializations without embodiment authority", () => {
		assert.throws(
			() => primeRuntimeOverlayEnvelope({}, [{} as NonNullable<AgentSpawnRequest["runtime_overlays"]>[number]]),
			/complete Agent Embodiment authority envelope/,
		);
	});

	it("rejects a partial embodiment authority envelope", () => {
		assert.throws(
			() =>
				primeRuntimeOverlayEnvelope({ embodiment_ref: {} as NonNullable<AgentSpawnRequest["embodiment_ref"]> }, []),
			/incomplete/,
		);
	});
});
