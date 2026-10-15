import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	isPrimeAttachCommandPayload,
	resolveWorkflowCallerContext,
	resolveWorkflowGrantAuthorities,
} from "../orchestrator.js";

const HUMAN_DELEGATION_SECRET = "gateway-exclusive-human-secret";

describe("gateway-authenticated human delegation", () => {
	it("preserves owner ingress only for the exact authenticated owner tuple", () => {
		assert.deepEqual(
			resolveWorkflowCallerContext({
				authMethod: "internal_service",
				ownerUserId: "ada-sub",
				humanDelegation: HUMAN_DELEGATION_SECRET,
				humanDelegationSecret: HUMAN_DELEGATION_SECRET,
				actorRef: "user:ada-sub",
				graphOwnerPrincipal: "user:ada-sub",
			}),
			{ authMethod: "owner" },
		);
	});

	it("rejects poison, adapter masquerade, and every authority mismatch", () => {
		const base = {
			authMethod: "internal_service" as const,
			ownerUserId: "ada-sub",
			humanDelegation: HUMAN_DELEGATION_SECRET,
			humanDelegationSecret: HUMAN_DELEGATION_SECRET,
			actorRef: "user:ada-sub",
			graphOwnerPrincipal: "user:ada-sub",
		};
		for (const mismatch of [
			{ humanDelegation: "caller-supplied-poison" },
			{ humanDelegationSecret: undefined },
			{ triggerAdapter: "vehicle" },
			{ actorRef: "user:someone-else" },
			{ graphOwnerPrincipal: "user:someone-else" },
		]) {
			assert.equal(resolveWorkflowCallerContext({ ...base, ...mismatch }).authMethod, "internal-service");
		}
	});

	it("does not promote a graph Editor to owner", () => {
		assert.equal(
			resolveWorkflowCallerContext({
				authMethod: "internal_service",
				ownerUserId: "editor-sub",
				humanDelegation: HUMAN_DELEGATION_SECRET,
				humanDelegationSecret: HUMAN_DELEGATION_SECRET,
				actorRef: "user:editor-sub",
				graphOwnerPrincipal: "user:ada-sub",
			}).authMethod,
			"internal-service",
		);
	});
});

describe("Vehicle owner ingress", () => {
	it("accepts only an explicitly trusted exact owner tuple", () => {
		assert.deepEqual(
			resolveWorkflowCallerContext({
				authMethod: "internal_service",
				ownerUserId: "ada-sub",
				triggerAdapter: "vehicle",
				actorRef: "user:ada-sub",
				graphOwnerPrincipal: "user:ada-sub",
				trustInternalVehicleAsOwner: true,
			}),
			{ authMethod: "owner" },
		);
	});

	it("keeps every mismatch on the consent-gated internal-service path", () => {
		const base = {
			authMethod: "internal_service" as const,
			ownerUserId: "ada-sub",
			triggerAdapter: "vehicle",
			actorRef: "user:ada-sub",
			graphOwnerPrincipal: "user:ada-sub",
			trustInternalVehicleAsOwner: true,
		};
		for (const mismatch of [
			{ trustInternalVehicleAsOwner: false },
			{ triggerAdapter: "discord" },
			{ actorRef: "user:someone-else" },
			{ graphOwnerPrincipal: "user:someone-else" },
		]) {
			assert.equal(resolveWorkflowCallerContext({ ...base, ...mismatch }).authMethod, "internal-service");
		}
	});

	it("trusts only the authenticated owner's exact home graph in addition to fixed host authorities", () => {
		const configuredAuthorities = [{ ownerPrincipal: "user:platform", graphId: "observatory" }];
		assert.deepEqual(
			resolveWorkflowGrantAuthorities({
				caller: { authMethod: "owner" },
				authenticatedActorRef: "user:ada-sub",
				homeOwnerPrincipal: "user:ada-sub",
				graphId: "personal-prime",
				configuredAuthorities,
			}),
			[...configuredAuthorities, { ownerPrincipal: "user:ada-sub", graphId: "personal-prime" }],
		);
		assert.deepEqual(
			resolveWorkflowGrantAuthorities({
				caller: { authMethod: "internal-service", triggerAdapter: "discord" },
				authenticatedActorRef: "user:ada-sub",
				homeOwnerPrincipal: "user:ada-sub",
				graphId: "personal-prime",
				configuredAuthorities,
			}),
			configuredAuthorities,
		);
		assert.deepEqual(
			resolveWorkflowGrantAuthorities({
				caller: { authMethod: "owner" },
				authenticatedActorRef: "user:editor-sub",
				homeOwnerPrincipal: "user:ada-sub",
				graphId: "personal-prime",
				configuredAuthorities,
			}),
			configuredAuthorities,
		);
	});
});

describe("native Prime attach handshake", () => {
	it("starts only on an actual attach command, not the daemon readiness probe", () => {
		assert.equal(
			isPrimeAttachCommandPayload(Buffer.from('{"type":"command","command":{"id":"1","type":"get_state"}}\n')),
			false,
		);
		assert.equal(
			isPrimeAttachCommandPayload(
				Buffer.from('{"type":"command","command":{"id":"2","type":"attach","activeSessionId":"a"}}\n'),
			),
			true,
		);
		assert.equal(isPrimeAttachCommandPayload(Buffer.from("partial")), false);
	});
});
