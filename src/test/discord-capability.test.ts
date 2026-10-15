import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createMeaningfulObjectRef } from "../agent-runtime/meaningful-object.js";
import { DiscordCapabilityBackend, discordCapabilityScope } from "../capabilities/discord.js";
import { phanesPrivacyFixture } from "./phanes-privacy-fixture.js";

const EVENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("Discord host capability", () => {
	it("derives an opaque dataset-epoch scope from Privacy Steward testimony", () => {
		const fixture = phanesPrivacyFixture(EVENT_ID);
		assert.deepEqual(discordCapabilityScope(fixture.trigger, ["discord-context:"]), {
			schema: "sophia.discord-capability-scope.v2",
			datasetEpochId: fixture.epochId,
			contextHandle: fixture.contextHandle,
			guildHandle: fixture.guildHandle,
			channelHandles: [fixture.channelHandle, fixture.otherChannelHandle],
			sourceMessageHandle: fixture.messageHandle,
		});
	});

	it("advertises only granted reads and keeps the bearer and coordinates on the host", async () => {
		const fixture = phanesPrivacyFixture(EVENT_ID);
		let observedUrl = "";
		let observedInit: RequestInit | undefined;
		const scope = discordCapabilityScope(fixture.trigger, ["discord-context:"]);
		const backend = new DiscordCapabilityBackend({
			baseUrl: "http://127.0.0.1:8765",
			bearerToken: "host-only-secret",
			scope,
			allowedTools: ["get_message", "message_context"],
			fetchFn: async (input, init) => {
				observedUrl = String(input);
				observedInit = init;
				const value = {
					schema: "sophia.privacy-bound-discord-message.v2",
					epochId: fixture.epochId,
					messageHandle: fixture.messageHandle,
					channelHandle: fixture.channelHandle,
					content: "heliotrope",
				};
				const object = createMeaningfulObjectRef({
					kind: "discord-message",
					ownerPrincipal: "user:phanes-owner",
					graphId: fixture.socialGraphId,
					objectId: `urn:phanes:discord-message:${fixture.messageHandle}`,
					version: "1",
					value,
				});
				return new Response(
					JSON.stringify({
						schema: "sophia.meaningful-object-testimony.v1",
						object,
						value,
						evidenceRefs: [object],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		});

		assert.deepEqual(
			(await backend.listTools()).map((tool) => tool.name),
			["get_message", "message_context"],
		);
		const result = await backend.callTool("get_message", {
			channel_handle: fixture.channelHandle,
			message_handle: fixture.messageHandle,
		});
		assert.equal(observedUrl, "http://127.0.0.1:8765/v2/call");
		assert.equal(new Headers(observedInit?.headers).get("authorization"), "Bearer host-only-secret");
		const body = JSON.parse(String(observedInit?.body));
		assert.deepEqual(body.scope, scope);
		assert.equal(JSON.stringify(body).includes("guild_id"), false);
		assert.equal(JSON.stringify(body).includes("channel_id"), false);
		assert.equal(JSON.stringify(result).includes("host-only-secret"), false);
		await assert.rejects(() => backend.callTool("search_messages", { query: "x" }), /outside the Agent tool grant/);
	});

	it("rejects a context outside the signed Steward resource fence", () => {
		const fixture = phanesPrivacyFixture(EVENT_ID);
		assert.throws(
			() => discordCapabilityScope(fixture.trigger, ["discord-context:ctx_not-this-context"]),
			/outside the signed steward grant fence/,
		);
	});

	it("fails closed when the definition grants no live Discord tools", () => {
		const fixture = phanesPrivacyFixture(EVENT_ID);
		assert.throws(
			() =>
				new DiscordCapabilityBackend({
					baseUrl: "http://127.0.0.1:8765",
					bearerToken: "secret",
					scope: discordCapabilityScope(fixture.trigger),
					allowedTools: [],
				}),
			/the Agent tool grant exposes no Discord reads/,
		);
	});
});
