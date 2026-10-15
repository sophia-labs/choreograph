import { createHash } from "node:crypto";
import { canonicalJson } from "@sophia-labs/canonical-json";

export const MEANINGFUL_OBJECT_REF_SCHEMA = "sophia.meaningful-object-ref.v1" as const;

export type MeaningfulObjectKind =
	| "agent"
	| "agent-session"
	| "agent-checkpoint"
	| "kernel-checkpoint"
	| "computational-workspace"
	| "geist"
	| "prompt"
	| "skill"
	| "harness"
	| "tool-manifest"
	| "tool-grant"
	| "capability"
	| "agent-runtime-profile"
	| "embodiment"
	| "evolution-proposal"
	| "embodiment-candidate"
	| "evaluation-suite"
	| "evaluation-policy"
	| "promotion-decision"
	| "embodiment-activation"
	| "rollback-decision"
	| "workflow"
	| "workflow-node"
	| "workflow-amendment"
	| "activity-loop"
	| "repository"
	| "source-snapshot"
	| "source-composition"
	| "coding-task"
	| "code-workspace"
	| "workspace-checkpoint"
	| "change-set"
	| "patch-set"
	| "branch-publication"
	| "pull-request"
	| "verification-run"
	| "build-recipe"
	| "build-plan"
	| "build-receipt"
	| "release-plan"
	| "release-artifact"
	| "deployment-plan"
	| "deployment-receipt"
	| "artifact"
	| "testimony"
	| "source-event"
	| "privacy-authority"
	| "privacy-policy"
	| "privacy-preference"
	| "privacy-context"
	| "privacy-bound-source-event"
	| "dataset-epoch"
	| "privacy-rebuild-request"
	| "privacy-rebuild-plan"
	| "privacy-rebuild-receipt"
	| "privacy-verification-receipt"
	| "privacy-runtime-run-binding"
	| "privacy-runtime-retirement-receipt"
	| "privacy-social-message-batch"
	| "social-identity"
	| "discord-guild"
	| "discord-channel"
	| "discord-thread"
	| "discord-message"
	| "discord-user"
	| "discord-member"
	| "discord-role"
	| "discord-attachment";

export interface MeaningfulObjectRefV1<Kind extends MeaningfulObjectKind = MeaningfulObjectKind> {
	readonly schema: typeof MEANINGFUL_OBJECT_REF_SCHEMA;
	readonly kind: Kind;
	readonly ownerPrincipal: string;
	readonly graphId: string;
	readonly objectId: string;
	readonly version: string;
	readonly digest: string;
}

export function createMeaningfulObjectRef<Kind extends MeaningfulObjectKind>(input: {
	readonly kind: Kind;
	readonly ownerPrincipal: string;
	readonly graphId: string;
	readonly objectId: string;
	readonly version: string;
	readonly value: unknown;
}): MeaningfulObjectRefV1<Kind> {
	const ref: MeaningfulObjectRefV1<Kind> = {
		schema: MEANINGFUL_OBJECT_REF_SCHEMA,
		kind: input.kind,
		ownerPrincipal: input.ownerPrincipal,
		graphId: input.graphId,
		objectId: input.objectId,
		version: input.version,
		digest: `sha256:${createHash("sha256").update(canonicalJson(input.value)).digest("hex")}`,
	};
	validateMeaningfulObjectRef(ref, input.kind);
	return ref;
}

export class MeaningfulObjectRefFault extends Error {
	readonly code = "meaningful_object_ref_invalid";

	constructor(
		message: string,
		readonly details?: unknown,
	) {
		super(message);
		this.name = "MeaningfulObjectRefFault";
	}
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const KINDS = new Set<string>([
	"agent",
	"agent-session",
	"agent-checkpoint",
	"kernel-checkpoint",
	"computational-workspace",
	"geist",
	"prompt",
	"skill",
	"harness",
	"tool-manifest",
	"tool-grant",
	"capability",
	"agent-runtime-profile",
	"embodiment",
	"evolution-proposal",
	"embodiment-candidate",
	"evaluation-suite",
	"evaluation-policy",
	"promotion-decision",
	"embodiment-activation",
	"rollback-decision",
	"workflow",
	"workflow-node",
	"workflow-amendment",
	"activity-loop",
	"repository",
	"source-snapshot",
	"source-composition",
	"coding-task",
	"code-workspace",
	"workspace-checkpoint",
	"change-set",
	"patch-set",
	"branch-publication",
	"pull-request",
	"verification-run",
	"build-recipe",
	"build-plan",
	"build-receipt",
	"release-plan",
	"release-artifact",
	"deployment-plan",
	"deployment-receipt",
	"artifact",
	"testimony",
	"source-event",
	"privacy-authority",
	"privacy-policy",
	"privacy-preference",
	"privacy-context",
	"privacy-bound-source-event",
	"dataset-epoch",
	"privacy-rebuild-request",
	"privacy-rebuild-plan",
	"privacy-rebuild-receipt",
	"privacy-verification-receipt",
	"privacy-runtime-run-binding",
	"privacy-runtime-retirement-receipt",
	"privacy-social-message-batch",
	"social-identity",
	"discord-guild",
	"discord-channel",
	"discord-thread",
	"discord-message",
	"discord-user",
	"discord-member",
	"discord-role",
	"discord-attachment",
]);

export function validateMeaningfulObjectRef(
	value: unknown,
	expectedKind?: MeaningfulObjectKind,
): asserts value is MeaningfulObjectRefV1 {
	if (!isRecord(value)) throw new MeaningfulObjectRefFault("Meaningful Object ref must be an object");
	const unknown = Object.keys(value).filter(
		(key) => !["schema", "kind", "ownerPrincipal", "graphId", "objectId", "version", "digest"].includes(key),
	);
	if (unknown.length > 0) throw new MeaningfulObjectRefFault("Meaningful Object ref has unknown fields", { unknown });
	if (value.schema !== MEANINGFUL_OBJECT_REF_SCHEMA) {
		throw new MeaningfulObjectRefFault("Meaningful Object ref schema is unsupported", { schema: value.schema });
	}
	if (typeof value.kind !== "string" || !KINDS.has(value.kind)) {
		throw new MeaningfulObjectRefFault("Meaningful Object ref kind is unsupported", { kind: value.kind });
	}
	if (expectedKind !== undefined && value.kind !== expectedKind) {
		throw new MeaningfulObjectRefFault("Meaningful Object ref kind does not match its binding slot", {
			expectedKind,
			actualKind: value.kind,
		});
	}
	for (const key of ["ownerPrincipal", "graphId", "objectId", "version"] as const) {
		if (typeof value[key] !== "string" || value[key].trim().length === 0) {
			throw new MeaningfulObjectRefFault(`Meaningful Object ref.${key} is required`);
		}
	}
	if (typeof value.digest !== "string" || !DIGEST.test(value.digest)) {
		throw new MeaningfulObjectRefFault("Meaningful Object ref.digest must be a lowercase sha256 digest");
	}
}

export function sameMeaningfulObjectRef(
	left: MeaningfulObjectRefV1 | undefined,
	right: MeaningfulObjectRefV1 | undefined,
): boolean {
	if (!left || !right) return left === right;
	return (
		left.schema === right.schema &&
		left.kind === right.kind &&
		left.ownerPrincipal === right.ownerPrincipal &&
		left.graphId === right.graphId &&
		left.objectId === right.objectId &&
		left.version === right.version &&
		left.digest === right.digest
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
