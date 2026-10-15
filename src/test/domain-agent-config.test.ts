import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentModeDigest } from "../agent-runtime/agent-mode.js";
import {
	assertFinalWorkerPromptReplay,
	ContentAuthorityContractFault,
} from "../agent-runtime/content-authority-contract.js";
import {
	MEANINGFUL_OBJECT_REF_SCHEMA,
	type MeaningfulObjectKind,
	type MeaningfulObjectRefV1,
} from "../agent-runtime/meaningful-object.js";
import { digestAgentOntologyBinding, validateAgentOntologyBinding } from "../agent-runtime/ontology-binding.js";
import {
	AGENT_RUNTIME_BINDING_SCHEMA,
	PRIME_AGENT_RUNTIME_BASELINE,
	SIMPLE_AGENT_RUNTIME_BASELINE,
} from "../agent-runtime/profile.js";
import { mintAgentUri, mintStandaloneAgentId } from "../agent-subject/agent-ontology.js";
import { promoteAgentPromptBinding } from "../workflow/agent-prompt-document.js";
import { AGENT_TOOL_GRANT_SCHEMA, type AgentToolGrantV1, grantDigest } from "../workflow/agent-tool-grant.js";
import { buildLearner1ToolManifest, hashManifest } from "../workflow/agent-tool-manifest.js";
import {
	DEFAULT_DOMAIN_EMANATION_MODEL,
	DEFAULT_DOMAIN_PILOT_MODEL,
	DOMAIN_AGENT_DEFINITION_SCHEMA,
	DomainAgentConfigError,
	type DomainAgentDefinitionV1,
	parseDomainAgentInvocationRequest,
	resolveDomainAgentConfig,
} from "../workflow/domain-agent-config.js";
import {
	DOMAIN_TRIGGER_CONSENT_SCHEMA,
	type DomainTriggerConsentV1,
	domainTriggerConsentDigest,
} from "../workflow/domain-trigger-consent.js";
import { documentUri, type GraphDocumentRead, type GraphWriter } from "../workflow/graph-writer.js";
import { buildDomainAgentActivityInputs } from "../workflow/script-domain-agent-activity-loop.js";
import { CellRdfStore, seedAgentModes } from "./cell-rdf-store.js";

const HOME_OWNER = "user:shrubbery-specialist";
const PLATFORM_AUTHORITY = { ownerPrincipal: "user:platform-steward", graphId: "observatory" } as const;
const HOST_AUTHORITY = {
	homeOwnerPrincipal: HOME_OWNER,
	trustedGrantAuthorities: [PLATFORM_AUTHORITY],
} as const;

function mo<Kind extends MeaningfulObjectKind>(input: {
	kind: Kind;
	ownerPrincipal?: string;
	graphId?: string;
	objectId: string;
	version: string;
	digest: string;
}): MeaningfulObjectRefV1<Kind> {
	return {
		schema: MEANINGFUL_OBJECT_REF_SCHEMA,
		kind: input.kind,
		ownerPrincipal: input.ownerPrincipal ?? HOME_OWNER,
		graphId: input.graphId ?? "shrubbery-domain",
		objectId: input.objectId,
		version: input.version,
		digest: input.digest.startsWith("sha256:") ? input.digest : `sha256:${input.digest}`,
	};
}

class DocumentGraph implements GraphWriter {
	readonly documents = new Map<string, { content: string; revision: number }>();
	readonly readFormats: Array<{ documentId: string; format: GraphDocumentRead["format"] }> = [];
	/** The cell's RDF face: a real Oxigraph store answering in gardend's shape. */
	readonly rdf = new CellRdfStore();
	async sparqlUpdate(graphId: string, sparql: string): Promise<void> {
		this.rdf.update(graphId, sparql);
	}
	async sparqlQuery(_graphId: string, sparql: string): Promise<unknown> {
		return this.rdf.query(sparql);
	}
	async searchDocuments(): Promise<[]> {
		return [];
	}
	async readDocument(
		graphId: string,
		documentId: string,
		options?: { format?: GraphDocumentRead["format"] },
	): Promise<GraphDocumentRead> {
		const document = this.documents.get(documentId);
		if (!document) throw new Error(`missing ${graphId}/${documentId}`);
		const format = options?.format ?? "markdown";
		this.readFormats.push({ documentId, format });
		return {
			graphId,
			documentId,
			documentUri: documentUri(documentId),
			format,
			// Mirror Garden: `json` is an editor-structure export, not the
			// source text. Contract readers must ask for the markdown face.
			text:
				format === "json"
					? JSON.stringify({ tiptapJson: { type: "doc" }, tree: [], blocks: [] })
					: document.content,
			blocks: [],
			revision: document.revision,
			changeId: `chg-${document.revision}`,
			raw: document,
		};
	}
	async writeDocument(_graphId: string, documentId: string, content: string): Promise<unknown> {
		const previous = this.documents.get(documentId);
		this.documents.set(documentId, { content, revision: (previous?.revision ?? 0) + 1 });
		return {};
	}
	put(documentId: string, value: unknown): void {
		this.documents.set(documentId, {
			content: typeof value === "string" ? value : `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`,
			revision: 1,
		});
	}
}

async function fixture() {
	const home = new DocumentGraph();
	const platform = new DocumentGraph();
	const registeredName = "shrub-1";
	const agentId = mintStandaloneAgentId({ name: registeredName });
	home.put("shrub-1-prompt", "You are shrub-1. Test the smallest complete journey.");
	const promptBinding = await promoteAgentPromptBinding({
		graph: home,
		graphId: "shrubbery-domain",
		promptDocumentId: "shrub-1-prompt",
		bindingDocumentId: "shrub-1-prompt-binding",
		registeredName,
		provider: "openrouter",
		model: DEFAULT_DOMAIN_PILOT_MODEL,
		promotedBy: "user:platform-steward",
		now: 20,
	});
	home.put("shrub-1-prompt-binding", promptBinding);
	home.put(
		"shrub-1-charter",
		"Derive claims from the manifest. Capture evidence for every verdict. Never call an in-scope untested claim complete.",
	);
	const manifest = buildLearner1ToolManifest({
		agentId,
		graphId: "shrubbery-domain",
		ownerUserId: "user:steward",
		now: 1,
	});
	home.put("shrub-1-tool-manifest", manifest);
	const grant: AgentToolGrantV1 = {
		schema: AGENT_TOOL_GRANT_SCHEMA,
		grantId: "grant-shrub-1",
		subjectAgentId: agentId,
		issuedBy: "user:platform-steward",
		authorityGraphId: "observatory",
		issuedAt: 1,
		status: "active",
		capabilities: [
			{
				capability: "mnemosyne",
				operations: ["recall", "search_documents", "remember", "sparql_update", "write_document"],
				access: "write",
				approvalPolicy: "ordinary",
				fence: { graphIds: ["shrubbery-domain"] },
				quota: { maxPerWave: 8 },
			},
			{
				capability: "workflow",
				operations: ["loom_run"],
				access: "write",
				approvalPolicy: "ordinary",
				fence: { graphIds: ["shrubbery-domain"], resourcePrefixes: ["shrubbery:program:"] },
				quota: { maxPerWave: 1, maxConcurrent: 1 },
			},
		],
		sourceRefs: ["urn:sophia:review:grant-shrub-1"],
	};
	platform.put("grant-shrub-1", grant);
	const definition: DomainAgentDefinitionV1 = {
		schema: DOMAIN_AGENT_DEFINITION_SCHEMA,
		registeredName,
		agentId,
		agentUri: mintAgentUri(agentId),
		homeGraphId: "shrubbery-domain",
		runtimes: {
			pilot: {
				schema: AGENT_RUNTIME_BINDING_SCHEMA,
				kind: "prime",
				bundle: { id: "sophia-agent-runtime", digest: `sha256:${"a".repeat(64)}` },
				profileRef: mo({
					kind: "agent-runtime-profile",
					objectId: "runtime-profile-domain-pilot",
					version: "1",
					digest: "8".repeat(64),
				}),
				constraints: PRIME_AGENT_RUNTIME_BASELINE,
			},
			emanation: {
				schema: AGENT_RUNTIME_BINDING_SCHEMA,
				kind: "simple",
				bundle: { id: "sophia-agent-runtime", digest: `sha256:${"a".repeat(64)}` },
				profileRef: mo({
					kind: "agent-runtime-profile",
					objectId: "runtime-profile-domain-emanation",
					version: "1",
					digest: "9".repeat(64),
				}),
				constraints: SIMPLE_AGENT_RUNTIME_BASELINE,
			},
		},
		ontology: {
			objects: {
				agent: mo({
					kind: "agent",
					objectId: mintAgentUri(agentId),
					version: "1",
					digest: "1".repeat(64),
				}),
				geist: mo({ kind: "geist", objectId: "shrub-1-geist", version: "1", digest: "2".repeat(64) }),
				prompt: mo({
					kind: "prompt",
					objectId: promptBinding.bindingId,
					version: promptBinding.snapshot.snapshotId,
					digest: promptBinding.snapshot.renderedDigest,
				}),
				skills: [mo({ kind: "skill", objectId: "domain-attention", version: "1", digest: "3".repeat(64) })],
				harness: mo({
					kind: "harness",
					objectId: "domain-agent-activity-loop-v1",
					version: "1",
					digest: "4".repeat(64),
				}),
				toolManifest: mo({
					kind: "tool-manifest",
					objectId: manifest.manifestId,
					version: String(manifest.version),
					digest: hashManifest(manifest),
				}),
				toolGrant: mo({
					kind: "tool-grant",
					ownerPrincipal: PLATFORM_AUTHORITY.ownerPrincipal,
					graphId: PLATFORM_AUTHORITY.graphId,
					objectId: grant.grantId,
					version: String(grant.issuedAt),
					digest: grantDigest(grant),
				}),
			},
		},
		charterDocumentId: "shrub-1-charter",
		promptBindingDocumentId: "shrub-1-prompt-binding",
		toolManifestDocumentId: "shrub-1-tool-manifest",
		grantRef: {
			...PLATFORM_AUTHORITY,
			documentId: "grant-shrub-1",
			expectedDigest: grantDigest(grant),
		},
		budgets: {
			pilotMaxTurns: 12,
			emanationMaxTurns: 5,
			maxEmanations: 3,
			maxProposedEffects: 8,
			maxProgramInvocations: 1,
		},
		emanations: { enabled: true, depth: 1 },
		triggers: [{ kind: "shrubbery.acceptance.tick", enabled: true, mode: "scheduled-or-manual" }],
		programs: [
			{
				programId: "acceptance",
				title: "Acceptance journey",
				description: "Exercise one stale claim.",
				workflowName: "shrubbery-acceptance-v1",
				workflowUri: "urn:sophia:wf:shrubbery-acceptance-v1",
				definitionDigest: "d".repeat(64),
				inputSchema: { type: "object" },
				authority: {
					capability: "workflow",
					operation: "loom_run",
					access: "write",
					resourceRef: "shrubbery:program:acceptance",
				},
				graph: { mode: "home" },
			},
		],
		responseSchema: {
			type: "object",
			required: ["summary"],
			properties: { summary: { type: "string" } },
			additionalProperties: false,
		},
	};
	home.put("domain-agent-definition", definition);
	return { home, platform, definition, grant };
}

describe("graph-defined Domain Agent configuration", () => {
	it("resolves identity, charter, promoted prompt, toolbelt, grant, and Inkling defaults from graphs", async () => {
		const { home, platform, definition } = await fixture();
		const request = parseDomainAgentInvocationRequest({
			trigger: { kind: "shrubbery.acceptance.tick", reason: "stale claim" },
			context_refs: ["urn:shrub:claim:C1"],
		});
		const resolved = await resolveDomainAgentConfig({
			...HOST_AUTHORITY,
			graph: home,
			graphId: "shrubbery-domain",
			request,
			graphFor: async (address) => {
				assert.deepEqual(address, PLATFORM_AUTHORITY);
				return platform;
			},
			now: 100,
		});

		assert.equal(resolved.definition.agentId, definition.agentId);
		assert.equal(resolved.pilot.model, DEFAULT_DOMAIN_PILOT_MODEL);
		assert.equal(resolved.emanation.model, DEFAULT_DOMAIN_EMANATION_MODEL);
		assert.equal(resolved.maxProgramInvocations, 1);
		assert.equal(resolved.programs[0]?.programId, "acceptance");
		assert.equal(resolved.pilot.graphAccess, "write");
		assert.deepEqual(resolved.pilotToolInclude.sort(), ["recall", "remember", "search_documents"]);
		assert.deepEqual(resolved.emanationToolInclude.sort(), ["recall", "search_documents"]);
		assert.match(resolved.systemPrompt, /Ratified domain charter/);
		assert.match(resolved.systemPrompt, /digest-pinned deterministic domain programs/);
		assert.match(resolved.systemPrompt, /proposal is not permission/i);
		assert.equal(resolved.grant.authorityGraphId, "observatory");
		assert.equal(
			home.readFormats.some((read) => read.format === "json"),
			false,
		);
		assert.equal(
			platform.readFormats.some((read) => read.format === "json"),
			false,
		);
	});

	it("receipts the exact composed worker prompt and rejects transformed-byte replay poison", async () => {
		const { home, platform } = await fixture();
		const resolved = await resolveDomainAgentConfig({
			...HOST_AUTHORITY,
			graph: home,
			graphId: "shrubbery-domain",
			request: parseDomainAgentInvocationRequest({
				trigger: { kind: "shrubbery.acceptance.tick", reason: "receipt" },
				contextRefs: ["urn:shrub:claim:C1"],
			}),
			graphFor: async () => platform,
			now: 100,
		});
		assert.equal(resolved.finalPromptReceipt.finalPromptUtf8, resolved.systemPrompt);
		assert.equal(
			resolved.systemPrompt,
			[
				"You are shrub-1. Test the smallest complete journey.",
				"",
				"## Ratified domain charter",
				"Derive claims from the manifest. Capture evidence for every verdict. Never call an in-scope untested claim complete.",
				"",
				"You are executing one bounded activity wave with an exact graph-bound read/write toolbelt. Use writes deliberately and preserve provenance.",
				"You may select one of the digest-pinned deterministic domain programs supplied by the host.",
				"Any world change must be returned as a typed proposed effect. A proposal is not permission.",
			].join("\n"),
		);
		assert.equal(
			resolved.finalPromptReceipt.source.renderedDigest,
			resolved.finalPromptReceipt.source.promptRef.digest,
		);
		assert.deepEqual(
			resolved.finalPromptReceipt.transforms.map((transform) => transform.transformId),
			["domain-charter.v1", "domain-toolbelt-access.v1", "domain-program-policy.v1", "domain-effect-policy.v1"],
		);
		assert.match(resolved.finalPromptReceipt.transforms[0]!.appendUtf8, /^\n\n## Ratified domain charter\n/);
		assertFinalWorkerPromptReplay(resolved.finalPromptReceipt, resolved.systemPrompt);
		const poisoned = {
			...resolved.finalPromptReceipt,
			transforms: [
				resolved.finalPromptReceipt.transforms[0]!,
				{ ...resolved.finalPromptReceipt.transforms[1]!, appendUtf8: "\n\npoisoned host policy" },
				...resolved.finalPromptReceipt.transforms.slice(2),
			],
		};
		assert.throws(
			() => assertFinalWorkerPromptReplay(poisoned, poisoned.finalPromptUtf8),
			(error: unknown) => error instanceof ContentAuthorityContractFault && error.code === "prompt_digest_mismatch",
		);
	});

	it("rejects a trigger that the graph definition did not enable", async () => {
		const { home, platform } = await fixture();
		await assert.rejects(
			resolveDomainAgentConfig({
				...HOST_AUTHORITY,
				graph: home,
				graphId: "shrubbery-domain",
				request: parseDomainAgentInvocationRequest({ trigger: { kind: "discord.message" } }),
				graphFor: async () => platform,
			}),
			(error: unknown) => error instanceof DomainAgentConfigError && error.code === "trigger_denied",
		);
	});

	it("admits an internal listener event only through a trusted adapter, pinned consent, and source fence", async () => {
		const { home, platform, definition } = await fixture();
		const consent: DomainTriggerConsentV1 = {
			schema: DOMAIN_TRIGGER_CONSENT_SCHEMA,
			consentId: "consent-phanes-discord",
			subjectAgentId: definition.agentId,
			issuedBy: "user:platform-steward",
			authorityGraphId: "observatory",
			adapter: "discord",
			triggerKinds: ["discord.message.mention"],
			sourcePrefixes: ["discord:guild:9044:"],
			issuedAt: 1,
			status: "active",
			maxContextRefs: 4,
			maxContextBytes: 4096,
			retention: "graph-referenced",
			sourceRefs: ["urn:sophia:review:consent-phanes"],
		};
		platform.put("consent-phanes-discord", consent);
		home.put("domain-agent-definition", {
			...definition,
			triggers: [
				{
					kind: "discord.message.mention",
					enabled: true,
					ingress: "internal-service",
					adapter: "discord",
					consentRef: {
						ownerPrincipal: PLATFORM_AUTHORITY.ownerPrincipal,
						graphId: "observatory",
						documentId: "consent-phanes-discord",
						expectedDigest: domainTriggerConsentDigest(consent),
					},
					sourceFence: {
						resourcePrefixes: ["discord:guild:9044:"],
						eventIdRequired: true,
						maxContextRefs: 4,
					},
				},
			],
		});
		const request = parseDomainAgentInvocationRequest({
			trigger: {
				kind: "discord.message.mention",
				eventId: "discord-message-123",
				resource: "discord:guild:9044:channel:12:message:123",
			},
			contextRefs: ["urn:phanes:message:122"],
		});
		const resolved = await resolveDomainAgentConfig({
			...HOST_AUTHORITY,
			graph: home,
			graphId: "shrubbery-domain",
			request,
			graphFor: async () => platform,
			caller: { authMethod: "internal-service", triggerAdapter: "discord" },
			trustedTriggerAdapters: ["discord"],
			now: 100,
		});
		assert.equal(resolved.triggerConsent?.consentId, consent.consentId);
		assert.equal(resolved.triggerBinding.adapter, "discord");

		await assert.rejects(
			resolveDomainAgentConfig({
				...HOST_AUTHORITY,
				graph: home,
				graphId: "shrubbery-domain",
				request,
				graphFor: async () => platform,
				caller: { authMethod: "owner" },
				trustedTriggerAdapters: ["discord"],
			}),
			(error: unknown) => error instanceof DomainAgentConfigError && error.code === "trigger_ingress_denied",
		);
	});

	it("refuses a listener resource outside current consent even when its adapter is trusted", async () => {
		const { home, platform, definition } = await fixture();
		const consent: DomainTriggerConsentV1 = {
			schema: DOMAIN_TRIGGER_CONSENT_SCHEMA,
			consentId: "consent-one-guild",
			subjectAgentId: definition.agentId,
			issuedBy: "user:platform-steward",
			authorityGraphId: "observatory",
			adapter: "discord",
			triggerKinds: ["discord.message.mention"],
			sourcePrefixes: ["discord:guild:allowed:"],
			issuedAt: 1,
			status: "active",
			maxContextRefs: 4,
			maxContextBytes: 4096,
			retention: "graph-referenced",
			sourceRefs: [],
		};
		platform.put("consent-one-guild", consent);
		home.put("domain-agent-definition", {
			...definition,
			triggers: [
				{
					kind: "discord.message.mention",
					enabled: true,
					ingress: "internal-service",
					adapter: "discord",
					consentRef: {
						ownerPrincipal: PLATFORM_AUTHORITY.ownerPrincipal,
						graphId: "observatory",
						documentId: "consent-one-guild",
						expectedDigest: domainTriggerConsentDigest(consent),
					},
					sourceFence: { resourcePrefixes: ["discord:guild:"], eventIdRequired: true, maxContextRefs: 4 },
				},
			],
		});
		await assert.rejects(
			resolveDomainAgentConfig({
				...HOST_AUTHORITY,
				graph: home,
				graphId: "shrubbery-domain",
				request: parseDomainAgentInvocationRequest({
					trigger: {
						kind: "discord.message.mention",
						eventId: "event-1",
						resource: "discord:guild:denied:channel:1:message:2",
					},
				}),
				graphFor: async () => platform,
				caller: { authMethod: "internal-service", triggerAdapter: "discord" },
				trustedTriggerAdapters: ["discord"],
			}),
			(error: unknown) => error instanceof DomainAgentConfigError && error.code === "trigger_consent_denied",
		);
	});

	it("rejects caller-supplied approvals because consent belongs to the host edge", () => {
		assert.throws(
			() =>
				parseDomainAgentInvocationRequest({
					trigger: { kind: "shrubbery.acceptance.tick" },
					approvals: [
						{ effectId: "effect-1", grantId: "grant-shrub-1", approvedBy: "user:forged", approvedAt: 1 },
					],
				}),
			/approvals are host authority state/,
		);
	});

	it("rejects a graph definition that tries to nominate its own grant authority", async () => {
		const { home, definition, grant } = await fixture();
		home.put("self-grant", { ...grant, authorityGraphId: "shrubbery-domain" });
		home.put("domain-agent-definition", {
			...definition,
			grantRef: { ownerPrincipal: HOME_OWNER, graphId: "shrubbery-domain", documentId: "self-grant" },
		});
		await assert.rejects(
			resolveDomainAgentConfig({
				...HOST_AUTHORITY,
				graph: home,
				graphId: "shrubbery-domain",
				request: parseDomainAgentInvocationRequest({ trigger: { kind: "shrubbery.acceptance.tick" } }),
			}),
			(error: unknown) => error instanceof DomainAgentConfigError && error.code === "grant_authority_denied",
		);
	});

	it("refuses the right graph id under the wrong owner before opening a graph proxy", async () => {
		const { home, definition } = await fixture();
		home.put("domain-agent-definition", {
			...definition,
			grantRef: { ...definition.grantRef, ownerPrincipal: "user:lookalike-platform-steward" },
		});
		let graphOpened = false;
		await assert.rejects(
			resolveDomainAgentConfig({
				...HOST_AUTHORITY,
				graph: home,
				graphId: "shrubbery-domain",
				request: parseDomainAgentInvocationRequest({ trigger: { kind: "shrubbery.acceptance.tick" } }),
				graphFor: async () => {
					graphOpened = true;
					throw new Error("must not open an untrusted tuple");
				},
			}),
			(error: unknown) => error instanceof DomainAgentConfigError && error.code === "grant_authority_denied",
		);
		assert.equal(graphOpened, false);
	});
});

describe("Choreograph modes v1 — session mode resolution from the agent's graph", () => {
	const HOME = "shrubbery-domain";
	const MODES = [
		{
			slug: "researcher",
			label: "Researcher",
			access: ["read"],
			// read_document is NOT in the grant: a mode can never widen it.
			allowsTool: ["recall", "search_documents", "remember", "read_document"],
			graphScope: [HOME],
			requiresApproval: ["remember"],
			imageTransform: "sepia",
		},
		{ slug: "editor", label: "Editor", access: ["write"], allowsTool: ["recall", "remember"] },
		{ slug: "admin", label: "Admin", access: ["write"], allowsTool: ["recall", "remember", "search_documents"] },
		{ slug: "vague", label: "Vague", allowsTool: ["recall", "remember"] },
	] as const;

	async function resolveWith(
		seed: Omit<Parameters<typeof seedAgentModes>[2], "agentId">,
		body: Record<string, unknown> = {},
	) {
		const { home, platform, definition } = await fixture();
		seedAgentModes(home.rdf, HOME, { agentId: definition.agentId, ...seed });
		const request = parseDomainAgentInvocationRequest({
			trigger: { kind: "shrubbery.acceptance.tick" },
			...body,
		});
		return {
			definition,
			request,
			resolve: () =>
				resolveDomainAgentConfig({
					...HOST_AUTHORITY,
					graph: home,
					graphId: HOME,
					request,
					graphFor: async () => platform,
					now: 100,
				}),
		};
	}

	it("keeps today's behavior for an agent with no mode configuration", async () => {
		const { resolve } = await resolveWith({ modes: MODES });
		const resolved = await resolve();
		assert.equal(resolved.mode, undefined);
		assert.equal(resolved.ontologies.pilot.mode, undefined);
		assert.deepEqual([...resolved.pilotToolInclude].sort(), ["recall", "remember", "search_documents"]);
		assert.equal(resolved.pilot.graphAccess, "write");
	});

	it("binds agt:defaultMode, intersects it with the grant, and applies the read ceiling", async () => {
		const { resolve, request } = await resolveWith({
			modes: MODES,
			defaultMode: "researcher",
			mayUseModes: ["researcher", "editor"],
		});
		const resolved = await resolve();
		assert.equal(resolved.mode?.mode.iri, "urn:sophia:mode:researcher");
		assert.equal(resolved.mode?.mode.access, "read");
		assert.deepEqual(resolved.mode?.mode.graphScope, ["urn:graph:shrubbery-domain"]);
		assert.deepEqual(resolved.mode?.mode.requiresApproval, ["remember"]);
		// remember is write-class (manifest access) ⇒ dropped by the read ceiling;
		// read_document is outside the grant ⇒ never admitted.
		assert.deepEqual([...resolved.pilotToolInclude].sort(), ["recall", "search_documents"]);
		assert.deepEqual([...resolved.emanationToolInclude].sort(), ["recall", "search_documents"]);
		assert.equal(resolved.pilot.graphAccess, "read");
		const digest = agentModeDigest(resolved.mode!.mode);
		assert.equal(resolved.mode?.digest, digest);
		for (const binding of [resolved.ontologies.pilot, resolved.ontologies.emanation]) {
			assert.deepEqual(binding.mode, { iri: "urn:sophia:mode:researcher", digest });
			validateAgentOntologyBinding(binding);
		}
		// The host context carries the full mode to the gate.
		const inputs = buildDomainAgentActivityInputs({
			graphId: HOME,
			request,
			resolved,
			sourceTurn: {
				schema: "sophia.domain-source-turn.v1",
				turnId: "turn-1",
			} as never,
		});
		assert.deepEqual((inputs.hostContext as { mode?: unknown }).mode, resolved.mode);
	});

	it("keeps the binding digest of a mode-less session byte-identical to pre-modes", async () => {
		const plain = await (await resolveWith({ modes: [] })).resolve();
		const moded = await (await resolveWith({ modes: MODES, defaultMode: "editor" })).resolve();
		assert.equal("mode" in plain.ontologies.pilot, false);
		assert.notEqual(
			digestAgentOntologyBinding(plain.ontologies.pilot),
			digestAgentOntologyBinding(moded.ontologies.pilot),
		);
		const { mode: _mode, ...withoutMode } = moded.ontologies.pilot;
		assert.equal(digestAgentOntologyBinding(withoutMode), digestAgentOntologyBinding(plain.ontologies.pilot));
	});

	it("honors a per-session override drawn from agt:mayUseMode", async () => {
		const { resolve } = await resolveWith(
			{ modes: MODES, defaultMode: "researcher", mayUseModes: ["researcher", "editor"] },
			{ modeIri: "urn:sophia:mode:editor" },
		);
		const resolved = await resolve();
		assert.equal(resolved.mode?.mode.iri, "urn:sophia:mode:editor");
		assert.deepEqual([...resolved.pilotToolInclude].sort(), ["recall", "remember"]);
		assert.equal(resolved.pilot.graphAccess, "write");
	});

	it("rejects loudly a per-session mode outside agt:mayUseMode, even one that exists", async () => {
		const { resolve } = await resolveWith(
			{ modes: MODES, defaultMode: "researcher", mayUseModes: ["researcher", "editor"] },
			{ mode_iri: "urn:sophia:mode:admin" },
		);
		await assert.rejects(
			resolve,
			(error: unknown) =>
				error instanceof DomainAgentConfigError &&
				error.code === "mode_denied" &&
				error.status === 403 &&
				/mode_not_permitted/.test(error.message),
		);
	});

	it("fails closed on an unknown default mode and on usable modes without a default", async () => {
		const unknown = await resolveWith({ modes: MODES, defaultMode: "ghost" });
		await assert.rejects(
			unknown.resolve,
			(error: unknown) => error instanceof DomainAgentConfigError && /mode_unknown/.test(error.message),
		);
		const undecided = await resolveWith({ modes: MODES, mayUseModes: ["researcher", "editor"] });
		await assert.rejects(
			undecided.resolve,
			(error: unknown) => error instanceof DomainAgentConfigError && /mode_required/.test(error.message),
		);
	});

	it("treats a missing agt:access as the read ceiling", async () => {
		const { resolve } = await resolveWith({ modes: MODES, defaultMode: "vague" });
		const resolved = await resolve();
		assert.equal(resolved.mode?.mode.access, "read");
		assert.deepEqual(resolved.pilotToolInclude, ["recall"]);
	});

	it("refuses a malformed per-session mode IRI at the ingress", () => {
		assert.throws(
			() => parseDomainAgentInvocationRequest({ trigger: { kind: "x" }, modeIri: "urn:sophia:mode:NOPE" }),
			(error: unknown) => error instanceof DomainAgentConfigError && error.code === "definition_invalid",
		);
	});
});
