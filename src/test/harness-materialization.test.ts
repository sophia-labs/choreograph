import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AGENT_RUNTIME_BINDING_V2_SCHEMA } from "../agent-runtime/evolution.js";
import { PRIME_EXTENSION_ABI } from "../agent-runtime/extension.js";
import { createMeaningfulObjectRef } from "../agent-runtime/meaningful-object.js";
import { resolveHarnessMaterialization } from "../spawner.js";
import { HARNESS_MATERIALIZATION_SCHEMA } from "../wire-protocol.js";
import { makeTestAgentSemanticBinding } from "./agent-semantic-fixture.js";

describe("graph-resolved harness materialization", () => {
	it("admits only the exact content-addressed harness named by the active ontology", () => {
		const legacy = makeTestAgentSemanticBinding({ registeredName: "harness-materialization" });
		const snapshot = {
			schema: 1 as const,
			entries: [{ id: "directive-1", type: "directive", content: "Verify before declaring success." }],
		};
		const priorHarness = legacy.ontology.objects.harness;
		const harnessRef = createMeaningfulObjectRef({
			kind: "harness",
			ownerPrincipal: priorHarness.ownerPrincipal,
			graphId: priorHarness.graphId,
			objectId: priorHarness.objectId,
			version: "refinement-1",
			value: snapshot,
		});
		const ontology = {
			...legacy.ontology,
			objects: { ...legacy.ontology.objects, harness: harnessRef },
		};
		const runtime = {
			schema: AGENT_RUNTIME_BINDING_V2_SCHEMA,
			kind: legacy.runtime.kind,
			baseBundle: legacy.runtime.bundle,
			overlays: [],
			profileRef: legacy.runtime.profileRef,
			constraints: legacy.runtime.constraints,
			extensionAbi: PRIME_EXTENSION_ABI,
		} as const;
		const materialization = {
			schema: HARNESS_MATERIALIZATION_SCHEMA,
			harnessRef,
			snapshot,
		};
		assert.deepEqual(resolveHarnessMaterialization(materialization, { runtime, ontology }), materialization);
		assert.throws(
			() =>
				resolveHarnessMaterialization(
					{ ...materialization, snapshot: { schema: 1, entries: [{ id: "tampered" }] } },
					{ runtime, ontology },
				),
			/digest does not identify its snapshot/,
		);
		assert.throws(
			() => resolveHarnessMaterialization(materialization, { runtime, ontology: legacy.ontology }),
			/differs from the active Agent Ontology/,
		);
	});

	it("accepts harness bytes on the hard-cut runtime profile", () => {
		const legacy = makeTestAgentSemanticBinding({ registeredName: "legacy-harness-materialization" });
		const snapshot = { schema: 1 as const, entries: [] };
		const harnessRef = createMeaningfulObjectRef({
			kind: "harness",
			ownerPrincipal: legacy.ontology.objects.harness.ownerPrincipal,
			graphId: legacy.ontology.objects.harness.graphId,
			objectId: legacy.ontology.objects.harness.objectId,
			version: "1",
			value: snapshot,
		});
		assert.doesNotThrow(() =>
			resolveHarnessMaterialization(
				{ schema: HARNESS_MATERIALIZATION_SCHEMA, harnessRef, snapshot },
				{
					runtime: legacy.runtime,
					ontology: { ...legacy.ontology, objects: { ...legacy.ontology.objects, harness: harnessRef } },
				},
			),
		);
	});
});
