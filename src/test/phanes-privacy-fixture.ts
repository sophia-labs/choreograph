const EPOCH_ID = "1".repeat(32);
const SOCIAL_GRAPH_ID = "phanes-social";
const CONTEXT_HANDLE = `ctx_${"c".repeat(24)}`;
const GUILD_HANDLE = `guild_${"g".repeat(24)}`;
const CHANNEL_HANDLE = `channel_${"h".repeat(24)}`;
const OTHER_CHANNEL_HANDLE = `channel_${"i".repeat(24)}`;
const MESSAGE_HANDLE = `message_${"m".repeat(24)}`;
const RESPONSE_HANDLE = `response_${"r".repeat(24)}`;
const PRINCIPAL_ID = `pseudonym:${"p".repeat(24)}`;
const POLICY_DIGEST = `sha256:${"b".repeat(64)}`;
const MANIFEST_DIGEST = `sha256:${"d".repeat(64)}`;

function ref(kind: string, objectId: string, digest = "a".repeat(64), version = "1") {
	return {
		schema: "sophia.meaningful-object-ref.v1",
		kind,
		ownerPrincipal: "user:phanes-owner",
		graphId: SOCIAL_GRAPH_ID,
		objectId,
		version,
		digest: `sha256:${digest}`,
	};
}

export function phanesPrivacyFixture(eventId: string, digest = "f".repeat(64)) {
	const sourceRef = `urn:phanes:dataset-epoch:${EPOCH_ID}:source-event:${eventId}`;
	const datasetEpoch = {
		schema: "sophia.dataset-epoch.v1",
		object: {
			kind: "dataset-epoch",
			objectId: `urn:phanes:dataset-epoch:${EPOCH_ID}`,
			version: MANIFEST_DIGEST,
		},
		epochId: EPOCH_ID,
		graphId: SOCIAL_GRAPH_ID,
		preferenceRevision: 7,
		policyDigest: POLICY_DIGEST,
		activatedAt: "2026-08-07T12:00:00Z",
		documentCount: 2,
		messageCount: 1,
		manifestDigest: MANIFEST_DIGEST,
	};
	const meaningfulObjects = {
		sourceEvent: ref("privacy-bound-source-event", sourceRef, digest, eventId),
		datasetEpoch: ref("dataset-epoch", datasetEpoch.object.objectId, "a".repeat(64), MANIFEST_DIGEST),
		privacyContext: ref("privacy-context", `urn:phanes:privacy-context:${CONTEXT_HANDLE}`),
		channel: ref("discord-channel", `urn:phanes:discord-channel:${CHANNEL_HANDLE}`),
		message: ref("discord-message", `urn:phanes:discord-message:${MESSAGE_HANDLE}`),
		author: ref("social-identity", `urn:phanes:social-identity:${PRINCIPAL_ID}`),
	};
	const wireTrigger = {
		kind: "discord.message.mention",
		event_id: eventId,
		resource: `discord-context:${CONTEXT_HANDLE}`,
		privacy_context_handle: CONTEXT_HANDLE,
		guild_handle: GUILD_HANDLE,
		channel_handle: CHANNEL_HANDLE,
		channel_handles: [CHANNEL_HANDLE, OTHER_CHANNEL_HANDLE],
		message_handle: MESSAGE_HANDLE,
		response_handle: RESPONSE_HANDLE,
		dataset_epoch: datasetEpoch,
		meaningful_objects: meaningfulObjects,
	};
	const trigger = {
		kind: "discord.message.mention",
		eventId: eventId,
		resource: `discord-context:${CONTEXT_HANDLE}`,
		privacyContextHandle: CONTEXT_HANDLE,
		guildHandle: GUILD_HANDLE,
		channelHandle: CHANNEL_HANDLE,
		channelHandles: [CHANNEL_HANDLE, OTHER_CHANNEL_HANDLE],
		messageHandle: MESSAGE_HANDLE,
		responseHandle: RESPONSE_HANDLE,
		datasetEpoch,
		meaningfulObjects,
	};
	const contextRefs = [...new Set([sourceRef, ...Object.values(meaningfulObjects).map((object) => object.objectId)])];
	return {
		epochId: EPOCH_ID,
		socialGraphId: SOCIAL_GRAPH_ID,
		contextHandle: CONTEXT_HANDLE,
		guildHandle: GUILD_HANDLE,
		channelHandle: CHANNEL_HANDLE,
		otherChannelHandle: OTHER_CHANNEL_HANDLE,
		messageHandle: MESSAGE_HANDLE,
		responseHandle: RESPONSE_HANDLE,
		sourceRef,
		datasetEpoch,
		meaningfulObjects,
		wireTrigger,
		trigger,
		contextRefs,
	};
}
