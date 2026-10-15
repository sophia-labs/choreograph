import { createHash } from "node:crypto";
import {
	AgentModeError,
	type AgentModeV1,
	agentModeRef,
	attenuateToolsForMode,
	isModeIri,
	resolveSessionMode,
} from "../agent-runtime/agent-mode.js";
import {
	createFinalWorkerPromptReceipt,
	type FinalWorkerPromptReceiptV1,
} from "../agent-runtime/content-authority-contract.js";
import { type MeaningfulObjectRefV1, sameMeaningfulObjectRef } from "../agent-runtime/meaningful-object.js";
import {
	AGENT_ONTOLOGY_BINDING_SCHEMA,
	type AgentOntologyBindingV1,
	validateAgentOntologyBinding,
} from "../agent-runtime/ontology-binding.js";
import { type AgentRuntimeBindingV2, validateResolvedAgentRuntimeBinding } from "../agent-runtime/profile.js";
import {
	mintAgentUri,
	mintStandaloneAgentId,
	STANDALONE_AGENT_IDENTITY_ALGORITHM,
} from "../agent-subject/agent-ontology.js";
import { isCanonicalGraphOwnerPrincipal } from "../graph-owner-principal.js";
import { READ_ONLY_MNEMOSYNE_TOOLS } from "../mnemosyne.js";
import { readAgentModeCatalogFromGraph } from "./agent-mode-reader.js";
import { type ResolvedAgentPromptV1, resolveAgentPromptBindingStrict } from "./agent-prompt-document.js";
import {
	type AgentToolGrantV1,
	assertGrantedToolbelt,
	effectApprovalPolicyFor,
	type GrantedToolbeltV1,
	grantDigest,
	parseAgentToolGrant,
	parseAgentToolManifest,
	reconcileToolbeltWithGrant,
} from "./agent-tool-grant.js";
import { type AgentToolManifestV0, hashManifest, stableJson } from "./agent-tool-manifest.js";
import { parseDomainSourceCommit } from "./domain-source-turn.js";
import {
	assertDomainTriggerConsentActive,
	type DomainTriggerConsentV1,
	domainTriggerConsentDigest,
	parseDomainTriggerConsent,
} from "./domain-trigger-consent.js";
import { type GraphWriter, unwrapAuthoredJsonDocument } from "./graph-writer.js";

export const DOMAIN_AGENT_DEFINITION_SCHEMA = "sophia.domain-agent-definition.v2" as const;
export const DEFAULT_DOMAIN_AGENT_DEFINITION_ID = "domain-agent-definition";
export const DEFAULT_DOMAIN_PILOT_MODEL = "thinkingmachines/inkling";
export const DEFAULT_DOMAIN_EMANATION_MODEL = "thinkingmachines/inkling-small";
export const DEFAULT_GRANT_AUTHORITY_GRAPH_ID = "observatory";

/** Providers whose credentials and model descriptors the trusted host can bind. */
export type DomainAgentInferenceProviderV1 = "openrouter";

/** Cloud-2 graph identity is the exact `(ownerPrincipal, graphId)` tuple. */
export interface DomainGraphAddressV1 {
	readonly ownerPrincipal: string;
	readonly graphId: string;
}

export interface DomainAgentTriggerBindingV1 {
	readonly kind: string;
	readonly enabled: boolean;
	readonly mode?: string;
	readonly ingress?: "owner" | "internal-service";
	readonly adapter?: string;
	readonly consentRef?: {
		readonly ownerPrincipal: string;
		readonly graphId: string;
		readonly documentId: string;
		readonly expectedDigest: string;
	};
	readonly sourceFence?: {
		readonly resourcePrefixes: readonly string[];
		readonly eventIdRequired?: boolean;
		readonly maxContextRefs?: number;
	};
}

/**
 * A deterministic instrument the freeform pilot may elect to run.
 *
 * The graph pins the complete Meaningful Object target and its input contract.
 * The pilot sees presentation fields plus the input contract and selects only
 * `programId` + JSON input; the trusted host resolves these coordinates again
 * before issuing a child invocation.
 */
export interface DomainAgentProgramBindingV1 {
	readonly programId: string;
	readonly title: string;
	readonly description: string;
	readonly workflowName: string;
	readonly workflowUri: string;
	readonly definitionDigest: string;
	readonly inputSchema: Readonly<Record<string, unknown>>;
	readonly authority: {
		readonly capability: string;
		readonly operation: string;
		readonly access: "read" | "write";
		readonly resourceRef: string;
	};
	readonly graph: { readonly mode: "home" } | { readonly mode: "input-field"; readonly inputField: string };
}

export interface DomainAgentCallerContextV1 {
	readonly authMethod: "owner" | "internal-service";
	readonly triggerAdapter?: string;
}

export type DomainAgentRuntimeSelectionV1 = AgentRuntimeBindingV2;

export interface DomainAgentOntologyDeclarationV1 {
	readonly objects: Omit<AgentOntologyBindingV1["objects"], "runtimeProfile">;
}

export interface DomainAgentRuntimeDeclarationsV1 {
	readonly pilot: DomainAgentRuntimeSelectionV1;
	readonly emanation: DomainAgentRuntimeSelectionV1;
}

export interface DomainAgentDefinitionV1 {
	readonly schema: typeof DOMAIN_AGENT_DEFINITION_SCHEMA;
	readonly registeredName: string;
	readonly agentId: string;
	readonly agentUri: string;
	readonly homeGraphId: string;
	readonly runtimes: DomainAgentRuntimeDeclarationsV1;
	readonly ontology: DomainAgentOntologyDeclarationV1;
	readonly charterDocumentId: string;
	readonly promptBindingDocumentId: string;
	readonly toolManifestDocumentId: string;
	readonly grantRef: {
		readonly ownerPrincipal: string;
		readonly graphId: string;
		readonly documentId: string;
		readonly expectedDigest?: string;
	};
	readonly models?: {
		readonly provider?: DomainAgentInferenceProviderV1;
		readonly pilot?: string;
		readonly emanation?: string;
	};
	readonly budgets: {
		readonly pilotMaxTurns: number;
		readonly emanationMaxTurns: number;
		readonly maxEmanations: number;
		readonly maxProposedEffects: number;
		readonly maxProgramInvocations?: number;
	};
	readonly emanations: {
		readonly enabled: boolean;
		readonly depth: 1;
	};
	readonly triggers: readonly DomainAgentTriggerBindingV1[];
	readonly programs?: readonly DomainAgentProgramBindingV1[];
	readonly responseSchema: Readonly<Record<string, unknown>>;
	/** Graph-authored deterministic fold from a typed result to a host-gated effect. */
	readonly resultEffectBinding?: {
		readonly schema: "sophia.domain-result-effect-binding.v1";
		readonly kind: "discord-placeholder-edit";
		/** Graph-authored deterministic response when the agent wave fails before producing typed output. */
		readonly failureContent?: string;
	};
}

export interface DomainAgentInvocationRequestV1 {
	readonly definitionDocumentId: string;
	readonly trigger: Readonly<Record<string, unknown>>;
	readonly contextRefs: readonly string[];
	/** Owner-selected pilot model for this invocation; the graph binding remains the default. */
	readonly inference?: {
		readonly provider: DomainAgentInferenceProviderV1;
		readonly model: string;
	};
	readonly interactionMode?: "headless" | "headed";
	/**
	 * Choreograph modes v1: an explicit per-session mode. It must be the agent's
	 * `agt:defaultMode` or one of its `agt:mayUseMode`; absent ⇒ the default.
	 */
	readonly modeIri?: string;
	/** External source testimony accepted only from a trusted internal adapter. */
	readonly sourceCommit?: {
		readonly eventId: string;
		readonly sourceRef: string;
		readonly digest: string;
	};
}

export interface ResolvedDomainAgentConfigV1 {
	readonly definition: DomainAgentDefinitionV1;
	readonly definitionDigest: string;
	readonly runtimes: DomainAgentRuntimeDeclarationsV1;
	readonly ontologies: {
		readonly pilot: AgentOntologyBindingV1;
		readonly emanation: AgentOntologyBindingV1;
	};
	readonly charterText: string;
	readonly prompt: ResolvedAgentPromptV1;
	readonly manifest: AgentToolManifestV0;
	readonly grant: AgentToolGrantV1;
	readonly toolbelt: GrantedToolbeltV1;
	readonly pilot: {
		readonly provider: DomainAgentInferenceProviderV1;
		readonly model: string;
		readonly maxTurns: number;
		readonly graphAccess: "read" | "write";
	};
	readonly emanation: {
		readonly enabled: boolean;
		readonly provider: DomainAgentInferenceProviderV1;
		readonly model: string;
		readonly maxEmanations: number;
		readonly maxTurns: number;
	};
	/** Complete graph tool surface admitted to the sovereign pilot. */
	readonly pilotToolInclude: readonly string[];
	/** Read-only attenuation of the same ontology for bounded emanations. */
	readonly emanationToolInclude: readonly string[];
	readonly programs: readonly DomainAgentProgramBindingV1[];
	readonly maxProgramInvocations: number;
	/** Exact final UTF-8 system prompt receipt, built at this sole composition boundary. */
	readonly finalPromptReceipt: FinalWorkerPromptReceiptV1;
	readonly systemPrompt: string;
	readonly triggerBinding: DomainAgentTriggerBindingV1;
	readonly triggerConsent?: DomainTriggerConsentV1;
	/** The session's resolved mode (absent ⇒ the agent declares no modes). */
	readonly mode?: {
		readonly mode: AgentModeV1;
		readonly digest: string;
	};
}

export class DomainAgentConfigError extends Error {
	constructor(
		readonly code:
			| "definition_invalid"
			| "graph_unavailable"
			| "charter_invalid"
			| "trigger_denied"
			| "trigger_ingress_denied"
			| "trigger_source_denied"
			| "trigger_consent_denied"
			| "grant_authority_denied"
			| "grant_digest_mismatch"
			| "inference_selection_denied"
			| "interaction_mode_denied"
			| "model_binding_mismatch"
			| "ontology_binding_mismatch"
			| "mode_denied"
			| "document_missing"
			| "domain_agent_not_provisioned",
		message: string,
		readonly details?: unknown,
		/** HTTP status for host ingress; absent ⇒ the ingress default. */
		readonly status?: number,
	) {
		super(message);
		this.name = "DomainAgentConfigError";
	}
}

export function parseDomainAgentInvocationRequest(body: unknown): DomainAgentInvocationRequestV1 {
	const envelope = record(body, "request body");
	const args = isRecord(envelope.workflow_args)
		? envelope.workflow_args
		: isRecord(envelope.input)
			? envelope.input
			: envelope;
	const trigger = record(args.trigger, "trigger");
	const contextRefs = args.contextRefs ?? args.context_refs ?? [];
	if (!Array.isArray(contextRefs) || contextRefs.some((ref) => !text(ref))) {
		throw invalid("contextRefs must be an array of strings");
	}
	if (args.approvals !== undefined) {
		throw invalid("approvals are host authority state and cannot be supplied in a workflow invocation");
	}
	const sourceCommitRaw = args.sourceCommit ?? args.source_commit;
	const interactionModeRaw = args.interactionMode ?? args.interaction_mode;
	if (interactionModeRaw !== undefined && interactionModeRaw !== "headless" && interactionModeRaw !== "headed") {
		throw invalid("interactionMode must be 'headless' or 'headed'");
	}
	const modeRaw = args.modeIri ?? args.mode_iri;
	if (modeRaw !== undefined && !isModeIri(modeRaw)) {
		throw invalid("modeIri must be a mode IRI (urn:sophia:mode:{slug})");
	}
	const inferenceRaw = args.inference;
	let inference: DomainAgentInvocationRequestV1["inference"];
	if (inferenceRaw !== undefined) {
		const selected = record(inferenceRaw, "inference");
		const provider = selected.provider;
		const model = optionalText(selected.model);
		if (provider !== "openrouter") {
			throw invalid("inference.provider must be 'openrouter'");
		}
		if (!model) throw invalid("inference.model must be a non-empty string");
		inference = { provider, model };
	}
	return {
		definitionDocumentId:
			optionalText(args.definitionDocumentId ?? args.agent_definition_id) ?? DEFAULT_DOMAIN_AGENT_DEFINITION_ID,
		trigger,
		contextRefs,
		...(inference ? { inference } : {}),
		...(interactionModeRaw ? { interactionMode: interactionModeRaw } : {}),
		...(modeRaw === undefined ? {} : { modeIri: modeRaw }),
		...(sourceCommitRaw === undefined ? {} : { sourceCommit: parseDomainSourceCommit(sourceCommitRaw) }),
	};
}

export async function resolveDomainAgentConfig(input: {
	graph: GraphWriter;
	graphId: string;
	homeOwnerPrincipal: string;
	request: DomainAgentInvocationRequestV1;
	graphFor?: (address: DomainGraphAddressV1) => Promise<GraphWriter>;
	/** Host-owned trust root; graph definitions cannot nominate their own grant issuer tuple. */
	trustedGrantAuthorities?: readonly DomainGraphAddressV1[];
	trustedTriggerAdapters?: readonly string[];
	caller?: DomainAgentCallerContextV1;
	now?: number;
}): Promise<ResolvedDomainAgentConfigV1> {
	const now = input.now ?? Date.now();
	let definitionDocument: unknown;
	try {
		definitionDocument = await readJsonDocument(input.graph, input.graphId, input.request.definitionDocumentId);
	} catch (error) {
		if (error instanceof DomainAgentConfigError && error.code === "document_missing") {
			throw new DomainAgentConfigError(
				"domain_agent_not_provisioned",
				`graph '${input.graphId}' has no Domain Agent definition '${input.request.definitionDocumentId}'`,
				{ definitionDocumentId: input.request.definitionDocumentId },
				404,
			);
		}
		throw error;
	}
	const definition = parseDomainAgentDefinition(definitionDocument);
	if (definition.homeGraphId !== input.graphId) {
		throw invalid(
			`definition homeGraphId '${definition.homeGraphId}' does not match invocation graph '${input.graphId}'`,
		);
	}
	const triggerBinding = resolveTriggerBinding(definition, input.request.trigger);
	const trustedGrantAuthorities = input.trustedGrantAuthorities ?? readTrustedGrantAuthorities(process.env);
	const trustedTriggerAdapters = input.trustedTriggerAdapters ?? readTrustedTriggerAdapters(process.env);
	const caller = input.caller ?? { authMethod: "owner" };
	if (input.request.interactionMode === "headed" && caller.authMethod !== "owner") {
		throw new DomainAgentConfigError(
			"interaction_mode_denied",
			"native headed sessions require authenticated owner ingress",
		);
	}
	assertTriggerIngress(triggerBinding, caller, trustedTriggerAdapters);
	const triggerResource = assertTriggerSource(triggerBinding, input.request);
	let triggerConsent: DomainTriggerConsentV1 | undefined;
	if (triggerBinding.consentRef) {
		if (!graphAddressIncluded(trustedGrantAuthorities, triggerBinding.consentRef)) {
			throw new DomainAgentConfigError(
				"trigger_consent_denied",
				`trigger consent graph '${formatGraphAddress(triggerBinding.consentRef)}' is not a trusted Layer 0 authority graph`,
			);
		}
		const consentGraph = graphAddressEquals(triggerBinding.consentRef, {
			ownerPrincipal: input.homeOwnerPrincipal,
			graphId: input.graphId,
		})
			? input.graph
			: input.graphFor
				? await input.graphFor(graphAddressOf(triggerBinding.consentRef))
				: undefined;
		if (!consentGraph) {
			throw new DomainAgentConfigError(
				"graph_unavailable",
				`trigger consent graph '${triggerBinding.consentRef.graphId}' is not available to the host edge`,
			);
		}
		triggerConsent = parseDomainTriggerConsent(
			await readJsonDocument(consentGraph, triggerBinding.consentRef.graphId, triggerBinding.consentRef.documentId),
		);
		if (triggerConsent.authorityGraphId !== triggerBinding.consentRef.graphId) {
			throw new DomainAgentConfigError("trigger_consent_denied", "trigger consent authority graph is inconsistent");
		}
		const digest = domainTriggerConsentDigest(triggerConsent);
		if (digest !== triggerBinding.consentRef.expectedDigest) {
			throw new DomainAgentConfigError(
				"trigger_consent_denied",
				"trigger consent digest does not match the definition pin",
				{
					expected: triggerBinding.consentRef.expectedDigest,
					actual: digest,
				},
			);
		}
		try {
			assertDomainTriggerConsentActive(triggerConsent, {
				agentId: definition.agentId,
				kind: triggerBinding.kind,
				adapter: triggerBinding.adapter ?? "",
				resource: triggerResource,
				contextRefs: input.request.contextRefs,
				now,
			});
		} catch (cause) {
			throw new DomainAgentConfigError("trigger_consent_denied", "trigger is outside its current consent", {
				cause,
			});
		}
	}

	const charter = await readTextDocument(input.graph, input.graphId, definition.charterDocumentId);
	const prompt = await resolveAgentPromptBindingStrict({
		graph: input.graph,
		graphId: input.graphId,
		bindingDocumentId: definition.promptBindingDocumentId,
		expectedRegisteredName: definition.registeredName,
		now,
	});
	const provider = definition.models?.provider ?? "openrouter";
	const pilotModel = definition.models?.pilot ?? DEFAULT_DOMAIN_PILOT_MODEL;
	if (prompt.binding.inference.provider !== provider || prompt.binding.inference.model !== pilotModel) {
		throw new DomainAgentConfigError(
			"model_binding_mismatch",
			"definition model does not match the promoted prompt binding",
			{ definition: { provider, model: pilotModel }, binding: prompt.binding.inference },
		);
	}
	const selectedInference = input.request.inference;
	if (selectedInference && caller.authMethod !== "owner") {
		throw new DomainAgentConfigError(
			"inference_selection_denied",
			"only the authenticated owner may select a per-session inference model",
		);
	}
	if (selectedInference && selectedInference.provider !== provider) {
		throw new DomainAgentConfigError(
			"inference_selection_denied",
			"a per-session selection may change the model but not the graph-bound provider",
			{ definitionProvider: provider, selectedProvider: selectedInference.provider },
		);
	}
	const effectivePilotModel = selectedInference?.model ?? pilotModel;

	const manifest = parseAgentToolManifest(
		await readJsonDocument(input.graph, input.graphId, definition.toolManifestDocumentId),
	);
	if (manifest.agentId !== definition.agentId) throw invalid("tool manifest belongs to a different agent");
	if (!graphAddressIncluded(trustedGrantAuthorities, definition.grantRef)) {
		throw new DomainAgentConfigError(
			"grant_authority_denied",
			`grant graph '${formatGraphAddress(definition.grantRef)}' is not a trusted Layer 0 authority graph`,
			{ trustedGrantAuthorities },
		);
	}

	const authorityGraph = graphAddressEquals(definition.grantRef, {
		ownerPrincipal: input.homeOwnerPrincipal,
		graphId: input.graphId,
	})
		? input.graph
		: input.graphFor
			? await input.graphFor(graphAddressOf(definition.grantRef))
			: undefined;
	if (!authorityGraph) {
		throw new DomainAgentConfigError(
			"graph_unavailable",
			`grant authority graph '${definition.grantRef.graphId}' is not available to the host edge`,
		);
	}
	const grant = parseAgentToolGrant(
		await readJsonDocument(authorityGraph, definition.grantRef.graphId, definition.grantRef.documentId),
	);
	if (grant.authorityGraphId !== definition.grantRef.graphId) throw invalid("grant authorityGraphId is inconsistent");
	const actualGrantDigest = grantDigest(grant);
	if (definition.grantRef.expectedDigest && definition.grantRef.expectedDigest !== actualGrantDigest) {
		throw new DomainAgentConfigError("grant_digest_mismatch", "grant digest does not match the definition pin", {
			expected: definition.grantRef.expectedDigest,
			actual: actualGrantDigest,
		});
	}
	const toolbelt = reconcileToolbeltWithGrant({ manifest, grant, now });
	assertGrantedToolbelt(toolbelt);
	assertDefinitionPromptAuthorityPin(definition, prompt);
	const sessionMode = await resolveDomainSessionMode(input.graph, input.graphId, definition.agentId, input.request);
	const modeRef = sessionMode ? agentModeRef(sessionMode) : undefined;
	const ontologies = {
		pilot: withModeRef(
			buildDomainAgentOntologyBinding(definition, definition.runtimes.pilot.profileRef, prompt, now),
			modeRef,
		),
		emanation: withModeRef(
			buildDomainAgentOntologyBinding(definition, definition.runtimes.emanation.profileRef, prompt, now),
			modeRef,
		),
	};
	assertDomainAgentObjectPins({
		definition,
		ontology: ontologies.pilot,
		runtime: definition.runtimes.pilot,
		homeOwnerPrincipal: input.homeOwnerPrincipal,
		prompt,
		manifest,
		grant,
	});
	assertDomainAgentObjectPins({
		definition,
		ontology: ontologies.emanation,
		runtime: definition.runtimes.emanation,
		homeOwnerPrincipal: input.homeOwnerPrincipal,
		prompt,
		manifest,
		grant,
	});
	const grantedGraphTools = toolbelt.tools.filter((tool) => tool.capability === "mnemosyne" && tool.available);
	// Modes attenuate the granted graph surface (never widen it). The manifest's
	// declared access is the static effect class here; the host gate re-checks
	// against the cell's live requiredScopes at call time.
	const modeAdmitted = sessionMode
		? new Set(
				attenuateToolsForMode(
					grantedGraphTools.map((tool) => tool.name),
					sessionMode,
					(name) => grantedGraphTools.find((tool) => tool.name === name)?.access,
				),
			)
		: undefined;
	const graphTools = modeAdmitted
		? grantedGraphTools.filter((tool) => modeAdmitted.has(tool.name))
		: grantedGraphTools;
	const pilotToolInclude = graphTools.map((tool) => tool.name);
	const emanationToolInclude = graphTools
		.filter((tool) => tool.access === "read" && READ_ONLY_MNEMOSYNE_TOOLS.has(tool.name))
		.map((tool) => tool.name);
	const pilotGraphAccess = graphTools.some((tool) => tool.access === "write") ? "write" : "read";
	const programs = definition.programs ?? [];
	assertProgramBindingsGranted(programs, toolbelt, definition.homeGraphId);
	const maxProgramInvocations = definition.budgets.maxProgramInvocations ?? (programs.length > 0 ? 1 : 0);
	const graphAccessPolicy =
		pilotGraphAccess === "write"
			? "You are executing one bounded activity wave with an exact graph-bound read/write toolbelt. Use writes deliberately and preserve provenance."
			: "You are executing one bounded activity wave. You may inspect through the direct read toolbelt.";
	const programPolicy =
		programs.length > 0
			? "You may select one of the digest-pinned deterministic domain programs supplied by the host."
			: "No deterministic domain program is bound for this activity wave.";
	const finalPromptReceipt = createFinalWorkerPromptReceipt({
		source: {
			promptRef: ontologies.pilot.objects.prompt,
			renderedUtf8: prompt.systemPrompt,
		},
		transforms: [
			{ transformId: "domain-charter.v1", appendUtf8: `\n\n## Ratified domain charter\n${charter}` },
			{ transformId: "domain-toolbelt-access.v1", appendUtf8: `\n\n${graphAccessPolicy}` },
			{ transformId: "domain-program-policy.v1", appendUtf8: `\n${programPolicy}` },
			{
				transformId: "domain-effect-policy.v1",
				appendUtf8: "\nAny world change must be returned as a typed proposed effect. A proposal is not permission.",
			},
		],
	});
	const systemPrompt = finalPromptReceipt.finalPromptUtf8;
	return {
		definition,
		definitionDigest: digestJson(definition),
		runtimes: definition.runtimes,
		ontologies,
		charterText: charter,
		prompt,
		manifest,
		grant,
		toolbelt,
		triggerBinding,
		triggerConsent,
		...(sessionMode && modeRef ? { mode: { mode: sessionMode, digest: modeRef.digest } } : {}),
		pilot: {
			provider,
			model: effectivePilotModel,
			maxTurns: definition.budgets.pilotMaxTurns,
			graphAccess: pilotGraphAccess,
		},
		emanation: {
			enabled: definition.emanations.enabled,
			provider,
			model: definition.models?.emanation ?? DEFAULT_DOMAIN_EMANATION_MODEL,
			maxEmanations: definition.budgets.maxEmanations,
			maxTurns: definition.budgets.emanationMaxTurns,
		},
		pilotToolInclude,
		emanationToolInclude,
		programs,
		maxProgramInvocations,
		finalPromptReceipt,
		systemPrompt,
	};
}

/**
 * Select the session's mode from the agent's own graph. An agent with no mode
 * configuration resolves to undefined (legacy behavior). Every failure — an
 * unreadable catalog, an unknown mode, a mode the agent may not use — rejects
 * the activation loudly; a session never silently runs without its mode.
 */
async function resolveDomainSessionMode(
	graph: GraphWriter,
	graphId: string,
	agentId: string,
	request: DomainAgentInvocationRequestV1,
): Promise<AgentModeV1 | undefined> {
	try {
		const catalog = await readAgentModeCatalogFromGraph(graph, graphId, agentId);
		return resolveSessionMode(catalog, request.modeIri);
	} catch (error) {
		if (!(error instanceof AgentModeError)) throw error;
		const status = error.code === "mode_not_permitted" ? 403 : error.code === "mode_unavailable" ? 503 : 409;
		throw new DomainAgentConfigError(
			"mode_denied",
			error.message,
			{ code: error.code, details: error.details },
			status,
		);
	}
}

function withModeRef(binding: AgentOntologyBindingV1, mode: AgentOntologyBindingV1["mode"]): AgentOntologyBindingV1 {
	if (!mode) return binding;
	const bound: AgentOntologyBindingV1 = { ...binding, mode };
	validateAgentOntologyBinding(bound);
	return bound;
}

function buildDomainAgentOntologyBinding(
	definition: DomainAgentDefinitionV1,
	runtimeProfile: MeaningfulObjectRefV1<"agent-runtime-profile">,
	prompt: ResolvedAgentPromptV1,
	resolvedAt: number,
): AgentOntologyBindingV1 {
	const binding: AgentOntologyBindingV1 = {
		schema: AGENT_ONTOLOGY_BINDING_SCHEMA,
		subject: {
			agentId: definition.agentId,
			agentUri: definition.agentUri,
			observerId: definition.agentId,
			registeredName: definition.registeredName,
			identityAlgorithm: STANDALONE_AGENT_IDENTITY_ALGORITHM,
		},
		objects: {
			...definition.ontology.objects,
			prompt: {
				...definition.ontology.objects.prompt,
				objectId: prompt.executionBinding.bindingId,
				version: prompt.executionBinding.snapshot.snapshotId,
				digest: prefixedSha256(prompt.executionBinding.snapshot.renderedDigest),
			},
			runtimeProfile,
		},
		resolvedAt,
	};
	validateAgentOntologyBinding(binding);
	return binding;
}

/**
 * The definition pins the owner-ratified binding that grants a particular
 * document and model authority. Runtime ontology is then refined to the exact
 * immutable snapshot captured from that document for this session.
 */
function assertDefinitionPromptAuthorityPin(definition: DomainAgentDefinitionV1, prompt: ResolvedAgentPromptV1): void {
	assertObjectPin(
		definition.ontology.objects.prompt,
		{
			objectId: prompt.binding.bindingId,
			version: prompt.binding.snapshot.snapshotId,
			digest: prefixedSha256(prompt.binding.snapshot.renderedDigest),
		},
		"prompt authority",
	);
}

function assertDomainAgentObjectPins(input: {
	definition: DomainAgentDefinitionV1;
	ontology: AgentOntologyBindingV1;
	runtime: DomainAgentRuntimeSelectionV1;
	homeOwnerPrincipal: string;
	prompt: ResolvedAgentPromptV1;
	manifest: AgentToolManifestV0;
	grant: AgentToolGrantV1;
}): void {
	const objects = input.ontology.objects;
	assertObjectPin(
		objects.agent,
		{
			ownerPrincipal: input.homeOwnerPrincipal,
			graphId: input.definition.homeGraphId,
			objectId: input.definition.agentUri,
		},
		"Agent",
	);
	assertObjectPin(
		objects.prompt,
		{
			ownerPrincipal: input.homeOwnerPrincipal,
			graphId: input.definition.homeGraphId,
			objectId: input.prompt.executionBinding.bindingId,
			version: input.prompt.executionBinding.snapshot.snapshotId,
			digest: prefixedSha256(input.prompt.executionBinding.snapshot.renderedDigest),
		},
		"prompt",
	);
	assertObjectPin(
		objects.toolManifest,
		{
			ownerPrincipal: input.homeOwnerPrincipal,
			graphId: input.definition.homeGraphId,
			objectId: input.manifest.manifestId,
			version: String(input.manifest.version),
			digest: prefixedSha256(hashManifest(input.manifest)),
		},
		"tool manifest",
	);
	assertObjectPin(
		objects.toolGrant,
		{
			ownerPrincipal: input.definition.grantRef.ownerPrincipal,
			graphId: input.definition.grantRef.graphId,
			objectId: input.grant.grantId,
			version: String(input.grant.issuedAt),
			digest: prefixedSha256(grantDigest(input.grant)),
		},
		"tool grant",
	);
	if (!sameMeaningfulObjectRef(objects.runtimeProfile, input.runtime.profileRef)) {
		throw ontologyMismatch("runtime selection and Agent ontology pin different runtime profiles", {
			runtimeProfile: input.runtime.profileRef,
			ontologyProfile: objects.runtimeProfile,
		});
	}
}

function assertObjectPin(
	actual: MeaningfulObjectRefV1,
	expected: Partial<Pick<MeaningfulObjectRefV1, "ownerPrincipal" | "graphId" | "objectId" | "version" | "digest">>,
	label: string,
): void {
	for (const [field, value] of Object.entries(expected)) {
		if (actual[field as keyof typeof expected] !== value) {
			throw ontologyMismatch(`${label} Meaningful Object does not match the resolved object`, {
				field,
				expected: value,
				actual: actual[field as keyof MeaningfulObjectRefV1],
			});
		}
	}
}

function prefixedSha256(value: string): string {
	return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function ontologyMismatch(message: string, details?: unknown): DomainAgentConfigError {
	return new DomainAgentConfigError("ontology_binding_mismatch", message, details);
}

function assertProgramBindingsGranted(
	programs: readonly DomainAgentProgramBindingV1[],
	toolbelt: GrantedToolbeltV1,
	homeGraphId: string,
): void {
	for (const program of programs) {
		const capability = toolbelt.capabilities.find(
			(candidate) =>
				candidate.capability === program.authority.capability &&
				(candidate.operations.includes(program.authority.operation) || candidate.operations.includes("*")),
		);
		if (!capability || (program.authority.access === "write" && capability.access !== "write")) {
			throw invalid(`program '${program.programId}' is outside the steward-issued grant`);
		}
		if (effectApprovalPolicyFor(capability, program.authority.operation) === "human-always") {
			throw invalid(
				`program '${program.programId}' needs a proposed-effect approval path, not immediate invocation`,
			);
		}
		if (
			capability.fence.resourcePrefixes?.length &&
			!capability.fence.resourcePrefixes.some((prefix) => program.authority.resourceRef.startsWith(prefix))
		) {
			throw invalid(`program '${program.programId}' resource is outside the steward-issued grant fence`);
		}
		const graphConstrained = Boolean(capability.fence.graphIds?.length || capability.fence.graphIdPrefixes?.length);
		if (program.graph.mode === "input-field" && !graphConstrained) {
			throw invalid(`cross-graph program '${program.programId}' requires a steward-issued graph fence`);
		}
		if (
			program.graph.mode === "home" &&
			graphConstrained &&
			!capability.fence.graphIds?.includes(homeGraphId) &&
			!capability.fence.graphIdPrefixes?.some((prefix) => homeGraphId.startsWith(prefix))
		) {
			throw invalid(`program '${program.programId}' home graph is outside the steward-issued grant fence`);
		}
		if (
			capability.quota.maxPerWave === 0 ||
			capability.quota.maxPerDay === 0 ||
			capability.quota.maxConcurrent === 0
		) {
			throw invalid(`program '${program.programId}' is disabled by its steward-issued quota`);
		}
	}
}

export function readTrustedGrantAuthorities(env: NodeJS.ProcessEnv = process.env): readonly DomainGraphAddressV1[] {
	const encoded = env.DOMAIN_AGENT_TRUSTED_GRANT_AUTHORITIES_JSON?.trim();
	if (encoded) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(encoded);
		} catch (cause) {
			throw new Error("DOMAIN_AGENT_TRUSTED_GRANT_AUTHORITIES_JSON must be valid JSON", { cause });
		}
		if (!Array.isArray(parsed) || parsed.length === 0) {
			throw new Error("DOMAIN_AGENT_TRUSTED_GRANT_AUTHORITIES_JSON must be a non-empty array");
		}
		return uniqueGraphAddresses(parsed.map((entry, index) => parseGraphAddress(entry, `trusted authority ${index}`)));
	}
	const ownerPrincipal = env.DOMAIN_AGENT_GRANT_AUTHORITY_OWNER?.trim();
	const configured = env.DOMAIN_AGENT_GRANT_AUTHORITY_GRAPHS?.split(",")
		.map((graphId) => graphId.trim())
		.filter(Boolean);
	if (!ownerPrincipal) return [];
	assertTypedOwnerPrincipal(ownerPrincipal, "DOMAIN_AGENT_GRANT_AUTHORITY_OWNER");
	const graphIds = configured && configured.length > 0 ? [...new Set(configured)] : [DEFAULT_GRANT_AUTHORITY_GRAPH_ID];
	return graphIds.map((graphId) => ({ ownerPrincipal, graphId: graphIdValue(graphId, "trusted authority graphId") }));
}

export function readTrustedTriggerAdapters(env: NodeJS.ProcessEnv = process.env): readonly string[] {
	return [
		...new Set(
			(env.DOMAIN_AGENT_TRUSTED_TRIGGER_ADAPTERS ?? "")
				.split(",")
				.map((adapter) => adapter.trim())
				.filter(Boolean),
		),
	];
}

export function parseDomainAgentDefinition(value: unknown): DomainAgentDefinitionV1 {
	const input = record(value, "domain agent definition");
	if (input.schema !== DOMAIN_AGENT_DEFINITION_SCHEMA) {
		throw invalid(`expected schema '${DOMAIN_AGENT_DEFINITION_SCHEMA}'`);
	}
	const definition = value as unknown as DomainAgentDefinitionV1;
	for (const [label, field] of [
		["registeredName", definition.registeredName],
		["agentId", definition.agentId],
		["agentUri", definition.agentUri],
		["homeGraphId", definition.homeGraphId],
		["charterDocumentId", definition.charterDocumentId],
		["promptBindingDocumentId", definition.promptBindingDocumentId],
		["toolManifestDocumentId", definition.toolManifestDocumentId],
	] as const) {
		if (!text(field)) throw invalid(`${label} is required`);
	}
	const expectedAgentId = mintStandaloneAgentId({ name: definition.registeredName });
	if (definition.agentId !== expectedAgentId || definition.agentUri !== mintAgentUri(expectedAgentId)) {
		throw invalid("agentId/agentUri do not match registeredName");
	}
	if (!isRecord(definition.runtimes)) throw invalid("runtimes is required");
	for (const role of ["pilot", "emanation"] as const) {
		const runtime = definition.runtimes[role];
		try {
			validateResolvedAgentRuntimeBinding(runtime);
		} catch (cause) {
			throw invalid(
				`runtimes.${role} is not a complete pinned runtime binding: ${cause instanceof Error ? cause.message : String(cause)}`,
			);
		}
	}
	if (!isRecord(definition.ontology) || !isRecord(definition.ontology.objects)) {
		throw invalid("ontology.objects is required");
	}
	try {
		validateAgentOntologyBinding({
			schema: AGENT_ONTOLOGY_BINDING_SCHEMA,
			subject: {
				agentId: definition.agentId,
				agentUri: definition.agentUri,
				observerId: definition.agentId,
				registeredName: definition.registeredName,
				identityAlgorithm: STANDALONE_AGENT_IDENTITY_ALGORITHM,
			},
			objects: {
				...definition.ontology.objects,
				runtimeProfile: definition.runtimes.pilot.profileRef,
			},
			resolvedAt: 0,
		});
	} catch (cause) {
		throw invalid(`ontology.objects is invalid: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	if (
		!isRecord(definition.grantRef) ||
		!text(definition.grantRef.ownerPrincipal) ||
		!text(definition.grantRef.graphId) ||
		!text(definition.grantRef.documentId)
	) {
		throw invalid("grantRef.ownerPrincipal, grantRef.graphId, and grantRef.documentId are required");
	}
	assertTypedOwnerPrincipal(definition.grantRef.ownerPrincipal, "grantRef.ownerPrincipal");
	graphIdValue(definition.grantRef.graphId, "grantRef.graphId");
	if (definition.grantRef.expectedDigest !== undefined && !/^[0-9a-f]{64}$/.test(definition.grantRef.expectedDigest)) {
		throw invalid("grantRef.expectedDigest must be sha256 hex");
	}
	if (definition.models !== undefined) {
		if (
			!isRecord(definition.models) ||
			(definition.models.provider !== undefined && definition.models.provider !== "openrouter")
		) {
			throw invalid("models.provider must be openrouter");
		}
		if (definition.models.pilot !== undefined && !text(definition.models.pilot))
			throw invalid("models.pilot is invalid");
		if (definition.models.emanation !== undefined && !text(definition.models.emanation)) {
			throw invalid("models.emanation is invalid");
		}
	}
	if (!isRecord(definition.budgets)) throw invalid("budgets are required");
	boundedInteger(definition.budgets.pilotMaxTurns, "budgets.pilotMaxTurns", 1, 64);
	boundedInteger(definition.budgets.emanationMaxTurns, "budgets.emanationMaxTurns", 1, 32);
	boundedInteger(definition.budgets.maxEmanations, "budgets.maxEmanations", 0, 8);
	boundedInteger(definition.budgets.maxProposedEffects, "budgets.maxProposedEffects", 0, 64);
	if (definition.budgets.maxProgramInvocations !== undefined) {
		boundedInteger(definition.budgets.maxProgramInvocations, "budgets.maxProgramInvocations", 0, 4);
	}
	if (
		!isRecord(definition.emanations) ||
		typeof definition.emanations.enabled !== "boolean" ||
		definition.emanations.depth !== 1
	) {
		throw invalid("emanations must declare enabled and depth=1");
	}
	if (!Array.isArray(definition.triggers) || definition.triggers.length === 0)
		throw invalid("triggers must be non-empty");
	for (const trigger of definition.triggers) {
		if (!isRecord(trigger) || !text(trigger.kind) || typeof trigger.enabled !== "boolean") {
			throw invalid("every trigger needs kind and enabled");
		}
		if (trigger.ingress !== undefined && trigger.ingress !== "owner" && trigger.ingress !== "internal-service") {
			throw invalid(`trigger '${trigger.kind}' ingress is unsupported`);
		}
		const ingress = trigger.ingress ?? "owner";
		if (ingress === "internal-service" && (!text(trigger.adapter) || !isRecord(trigger.consentRef))) {
			throw invalid(`internal trigger '${trigger.kind}' requires adapter and consentRef`);
		}
		if (ingress === "owner" && (trigger.adapter !== undefined || trigger.consentRef !== undefined)) {
			throw invalid(`owner trigger '${trigger.kind}' cannot claim an internal adapter or consentRef`);
		}
		if (trigger.consentRef !== undefined) {
			const consentRef = record(trigger.consentRef, `trigger '${trigger.kind}' consentRef`);
			if (
				!text(consentRef.ownerPrincipal) ||
				!text(consentRef.graphId) ||
				!text(consentRef.documentId) ||
				!sha256(consentRef.expectedDigest)
			) {
				throw invalid(`trigger '${trigger.kind}' consentRef is invalid`);
			}
			assertTypedOwnerPrincipal(consentRef.ownerPrincipal, `trigger '${trigger.kind}' consentRef.ownerPrincipal`);
			graphIdValue(consentRef.graphId, `trigger '${trigger.kind}' consentRef.graphId`);
		}
		if (trigger.sourceFence !== undefined) parseTriggerSourceFence(trigger.kind, trigger.sourceFence);
	}
	if (definition.programs !== undefined) {
		if (!Array.isArray(definition.programs)) throw invalid("programs must be an array");
		if (definition.programs.length > 16) throw invalid("at most 16 deterministic programs may be bound");
		const programIds = new Set<string>();
		const targets = new Set<string>();
		for (const program of definition.programs) {
			if (!isRecord(program)) throw invalid("every program binding must be an object");
			if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(program.programId)) {
				throw invalid("programId must be a stable 1..128 character identifier");
			}
			for (const field of ["title", "description", "workflowName", "workflowUri"] as const) {
				if (!text(program[field])) throw invalid(`program '${program.programId}' ${field} is required`);
			}
			if (!sha256(program.definitionDigest)) {
				throw invalid(`program '${program.programId}' definitionDigest must be sha256 hex`);
			}
			if (!isRecord(program.inputSchema))
				throw invalid(`program '${program.programId}' inputSchema must be an object`);
			if (
				!isRecord(program.authority) ||
				!text(program.authority.capability) ||
				!text(program.authority.operation) ||
				(program.authority.access !== "read" && program.authority.access !== "write") ||
				!text(program.authority.resourceRef)
			) {
				throw invalid(`program '${program.programId}' authority binding is invalid`);
			}
			if (!isRecord(program.graph) || (program.graph.mode !== "home" && program.graph.mode !== "input-field")) {
				throw invalid(`program '${program.programId}' graph binding is invalid`);
			}
			if (program.graph.mode === "input-field" && !text(program.graph.inputField)) {
				throw invalid(`program '${program.programId}' graph inputField is required`);
			}
			if (programIds.has(program.programId)) throw invalid(`duplicate programId '${program.programId}'`);
			const target = `${program.workflowName}\u0000${program.workflowUri}`;
			if (targets.has(target)) throw invalid(`duplicate program target '${program.workflowName}'`);
			programIds.add(program.programId);
			targets.add(target);
		}
		if ((definition.budgets.maxProgramInvocations ?? 1) === 0 && definition.programs.length > 0) {
			throw invalid("programs require budgets.maxProgramInvocations > 0");
		}
	}
	if (!isRecord(definition.responseSchema)) throw invalid("responseSchema must be an object");
	if (
		definition.resultEffectBinding !== undefined &&
		(!isRecord(definition.resultEffectBinding) ||
			definition.resultEffectBinding.schema !== "sophia.domain-result-effect-binding.v1" ||
			definition.resultEffectBinding.kind !== "discord-placeholder-edit" ||
			(definition.resultEffectBinding.failureContent !== undefined &&
				(!text(definition.resultEffectBinding.failureContent) ||
					definition.resultEffectBinding.failureContent.length > 2_000)))
	) {
		throw invalid("resultEffectBinding is unsupported");
	}
	return definition;
}

function resolveTriggerBinding(
	definition: DomainAgentDefinitionV1,
	trigger: Readonly<Record<string, unknown>>,
): DomainAgentTriggerBindingV1 {
	const kind = optionalText(trigger.kind);
	const binding = kind
		? definition.triggers.find((candidate) => candidate.enabled && candidate.kind === kind)
		: undefined;
	if (!binding) {
		throw new DomainAgentConfigError("trigger_denied", `trigger '${kind ?? "(missing)"}' is not enabled`);
	}
	return binding;
}

function assertTriggerIngress(
	binding: DomainAgentTriggerBindingV1,
	caller: DomainAgentCallerContextV1,
	trustedAdapters: readonly string[],
): void {
	const ingress = binding.ingress ?? "owner";
	if (caller.authMethod !== ingress) {
		throw new DomainAgentConfigError(
			"trigger_ingress_denied",
			`trigger '${binding.kind}' requires ${ingress} ingress`,
		);
	}
	if (ingress === "internal-service") {
		if (!binding.adapter || caller.triggerAdapter !== binding.adapter || !trustedAdapters.includes(binding.adapter)) {
			throw new DomainAgentConfigError(
				"trigger_ingress_denied",
				`trigger adapter is not trusted for '${binding.kind}'`,
				{
					expected: binding.adapter,
					actual: caller.triggerAdapter,
					trustedAdapters,
				},
			);
		}
	}
}

function assertTriggerSource(binding: DomainAgentTriggerBindingV1, request: DomainAgentInvocationRequestV1): string {
	const resource = optionalText(request.trigger.resource) ?? "";
	const fence = binding.sourceFence;
	if (!fence) return resource;
	if (!resource || !fence.resourcePrefixes.some((prefix) => resource.startsWith(prefix))) {
		throw new DomainAgentConfigError(
			"trigger_source_denied",
			`trigger '${binding.kind}' resource is outside its fence`,
			{
				resource,
				resourcePrefixes: fence.resourcePrefixes,
			},
		);
	}
	if (fence.eventIdRequired && !text(request.trigger.eventId)) {
		throw new DomainAgentConfigError("trigger_source_denied", `trigger '${binding.kind}' requires a stable eventId`);
	}
	if (fence.maxContextRefs !== undefined && request.contextRefs.length > fence.maxContextRefs) {
		throw new DomainAgentConfigError("trigger_source_denied", `trigger '${binding.kind}' has too many context refs`);
	}
	return resource;
}

function parseTriggerSourceFence(kind: unknown, value: unknown): void {
	const fence = record(value, `trigger '${String(kind)}' sourceFence`);
	if (!uniqueStrings(fence.resourcePrefixes)) throw invalid(`trigger '${String(kind)}' needs resourcePrefixes`);
	if (fence.eventIdRequired !== undefined && typeof fence.eventIdRequired !== "boolean") {
		throw invalid(`trigger '${String(kind)}' eventIdRequired must be boolean`);
	}
	if (fence.maxContextRefs !== undefined) {
		boundedInteger(fence.maxContextRefs, `trigger '${String(kind)}' maxContextRefs`, 0, 10_000);
	}
}

function parseGraphAddress(value: unknown, label: string): DomainGraphAddressV1 {
	const address = record(value, label);
	const ownerPrincipal = optionalText(address.ownerPrincipal);
	const graphId = optionalText(address.graphId);
	if (!ownerPrincipal || !graphId) throw invalid(`${label} requires ownerPrincipal and graphId`);
	assertTypedOwnerPrincipal(ownerPrincipal, `${label}.ownerPrincipal`);
	return { ownerPrincipal, graphId: graphIdValue(graphId, `${label}.graphId`) };
}

function assertTypedOwnerPrincipal(value: string, label: string): void {
	if (!isCanonicalGraphOwnerPrincipal(value)) {
		throw invalid(`${label} must be a typed cloud graph owner`);
	}
}

function graphIdValue(value: string, label: string): string {
	if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(value)) {
		throw invalid(`${label} must be a valid cloud graph id`);
	}
	return value;
}

function graphAddressEquals(left: DomainGraphAddressV1, right: DomainGraphAddressV1): boolean {
	return left.ownerPrincipal === right.ownerPrincipal && left.graphId === right.graphId;
}

function graphAddressOf(value: DomainGraphAddressV1): DomainGraphAddressV1 {
	return { ownerPrincipal: value.ownerPrincipal, graphId: value.graphId };
}

function graphAddressIncluded(addresses: readonly DomainGraphAddressV1[], candidate: DomainGraphAddressV1): boolean {
	return addresses.some((address) => graphAddressEquals(address, candidate));
}

function uniqueGraphAddresses(addresses: readonly DomainGraphAddressV1[]): readonly DomainGraphAddressV1[] {
	const seen = new Set<string>();
	return addresses.filter((address) => {
		const key = `${address.ownerPrincipal}\u0000${address.graphId}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function formatGraphAddress(address: DomainGraphAddressV1): string {
	return `${address.ownerPrincipal}/${address.graphId}`;
}

async function readJsonDocument(graph: GraphWriter, graphId: string, documentId: string): Promise<unknown> {
	// Garden's `read_document(format: "json")` exports the editor's TipTap/tree
	// structure. Graph-defined contracts are JSON *authored as document text*,
	// whose canonical textual face is markdown even when the source was written
	// with `format: "plain"`. Parse that face rather than the editor envelope.
	const textValue = await readTextDocument(graph, graphId, documentId, "markdown");
	try {
		return JSON.parse(unwrapAuthoredJsonDocument(textValue));
	} catch (cause) {
		throw invalid(`document '${documentId}' contains invalid JSON`, { cause });
	}
}

async function readTextDocument(
	graph: GraphWriter,
	graphId: string,
	documentId: string,
	format: "markdown" | "json" = "markdown",
): Promise<string> {
	try {
		const document = await graph.readDocument(graphId, documentId, { format });
		// An MCP tool error comes back as a result, not a throw.
		const raw = document.raw as { isError?: unknown } | undefined;
		if (raw && typeof raw === "object" && raw.isError === true) {
			throw documentReadFailure(graphId, documentId, document.text ?? "");
		}
		const content = document.text?.trim();
		if (!content) throw new DomainAgentConfigError("charter_invalid", `document '${documentId}' is empty`);
		return content;
	} catch (cause) {
		if (cause instanceof DomainAgentConfigError) throw cause;
		throw documentReadFailure(graphId, documentId, cause instanceof Error ? cause.message : String(cause), cause);
	}
}

/** gardend reports `document not found: <id>` (or a tombstone) for an absent document. */
const DOCUMENT_ABSENT = /\bdocument[ _](?:not[ _]found|tombstoned|does not exist)\b|\bno such document\b/i;

function documentReadFailure(
	graphId: string,
	documentId: string,
	detail: string,
	cause?: unknown,
): DomainAgentConfigError {
	if (DOCUMENT_ABSENT.test(detail) || (detail.includes(documentId) && /\bnot[ _]found\b/i.test(detail))) {
		return new DomainAgentConfigError(
			"document_missing",
			`document '${documentId}' does not exist in graph '${graphId}'`,
			undefined,
			409,
		);
	}
	return new DomainAgentConfigError(
		"graph_unavailable",
		`could not read '${documentId}' from graph '${graphId}'`,
		cause === undefined ? undefined : { cause },
	);
}

function digestJson(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
		throw invalid(`${label} must be an integer from ${minimum} to ${maximum}`);
	}
	return value as number;
}

function uniqueStrings(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.length > 0 && value.every(text) && new Set(value).size === value.length;
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw invalid(`${label} must be an object`);
	return value;
}

function invalid(message: string, details?: unknown): DomainAgentConfigError {
	return new DomainAgentConfigError("definition_invalid", message, details);
}

function optionalText(value: unknown): string | undefined {
	return text(value) ? value.trim() : undefined;
}

function text(value: unknown): value is string {
	return typeof value === "string" && Boolean(value.trim());
}

function sha256(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
