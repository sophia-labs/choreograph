import path from "node:path";
import type { PersonalEvolutionController } from "../agent-runtime/evolution-controller.js";
import type { HostedAuthContext } from "../auth.js";
import { type CreditAdmission, evaluatorHoldKey } from "../billing-gate.js";
import { computeCost, staticPricingVersion } from "../billing-pricing.js";
import type { BillingStore } from "../billing-store.js";
import { BrowserCapabilityBackend, resolveBrowserServiceUrl } from "../browser-capability.js";
import { EvidenceStore } from "../evidence-store.js";
import { resolveGatewayServiceAuth } from "../mnemosyne.js";
import type { OpenRouterModelCatalog } from "../model-catalog.js";
import { type CaptureEmitter, captureIdentityForHostedRequest, emitCaptureSoft } from "../observatory-capture.js";
import type { WorkflowRuntimeStore } from "../workflow/runtime-store.js";
import { type CapabilityBindingContext, HostCapabilityCatalog } from "./catalog.js";
import { DiscordCapabilityBackend, discordCapabilityScope } from "./discord.js";
import { type EvaluationCall, EvaluationCapabilityBackend, type EvaluationUsage } from "./evaluation.js";
import { createGraphCapability } from "./graph.js";
import { HttpCapabilityBackend } from "./http.js";
import { SoilCapabilityBackend } from "./soil.js";
import { WorkflowCapabilityBackend } from "./workflow.js";
import { YwsCapabilityBackend } from "./yws.js";

export interface DefaultHostCapabilityServices {
	readonly billing?: BillingStore;
	/** The credit gate: the Hoja evaluators ask it before each direct OpenRouter call (Sobremesa). */
	readonly creditGate?: CreditAdmission;
	readonly capture?: CaptureEmitter;
	readonly modelCatalog?: OpenRouterModelCatalog;
	/** Test seam only; production leaves both fields unset. */
	readonly evaluationFetch?: typeof fetch;
	readonly evaluationApiBaseUrl?: string;
	readonly workflowRuntime?: WorkflowRuntimeStore;
	/** Optional, explicitly configured personal Agent evolution authority. */
	readonly evolution?: PersonalEvolutionController;
}

export function createDefaultHostCapabilityCatalog(
	services: DefaultHostCapabilityServices = {},
): HostCapabilityCatalog {
	const catalog = new HostCapabilityCatalog();
	for (const [name, engine] of [
		["browser", "chromium"],
		["browser.chromium", "chromium"],
	] as const) {
		catalog.register(name, async (context) => {
			const evidenceUrl = process.env.CHOREOGRAPH_EVIDENCE_S3_URL?.trim();
			const backend = new BrowserCapabilityBackend({
				serviceBaseUrl: resolveBrowserServiceUrl(),
				engine,
				capabilityName: name,
				boundOrigin: browserBoundOrigin(),
				storageStateRef: process.env.HOJA_BROWSER_STORAGE_STATE_REF?.trim() || undefined,
				evidenceStore: evidenceUrl ? EvidenceStore.fromUrl(evidenceUrl) : undefined,
				evidenceContext: evidenceContext(context.input),
				accessLevel: context.authority.minimumRole === "editor" ? "rw" : "ro",
			});
			await backend.create();
			return backend;
		});
	}

	catalog.register("http", async (context) => {
		const baseUrl = resolveHttpFaceBaseUrl(context.graphId, context.graphOwner);
		return new HttpCapabilityBackend({
			baseUrl,
			allowedOrigins: httpAllowedOrigins(baseUrl),
			allowedPathPrefixes: [new URL(baseUrl).pathname],
			headers: httpAuthHeaders(context),
		});
	});
	catalog.register("discord", async (context) => {
		const baseUrl = process.env.PHANES_CAPABILITY_BASE_URL?.trim();
		const bearerToken = process.env.PHANES_CAPABILITY_TOKEN?.trim();
		if (!baseUrl || !bearerToken) {
			throw new Error("discord: PHANES_CAPABILITY_BASE_URL and PHANES_CAPABILITY_TOKEN are required");
		}
		const discordGrant = context.grantedCapabilities?.find((grant) => grant.capability === "discord");
		return new DiscordCapabilityBackend({
			baseUrl,
			bearerToken,
			scope: discordCapabilityScope(context.semanticScope, discordGrant?.fence.resourcePrefixes),
			allowedTools: context.grantedTools?.discord ?? [],
		});
	});
	if (services.workflowRuntime) {
		catalog.register("workflow", async (context) => {
			if (!context.runId || !context.agentSession) {
				throw new Error("workflow: run and Agent Session bindings are required");
			}
			return new WorkflowCapabilityBackend({
				runtime: services.workflowRuntime!,
				runId: context.runId,
				graphId: context.graphId,
				ownerPrincipal: context.graphOwner ?? `user:${context.ownerUserId}`,
				agentId: context.agentSession.agentId,
				sessionId: context.agentSession.sessionId,
				...(context.agentSession.nodeKey ? { nodeKey: context.agentSession.nodeKey } : {}),
				...(context.agentSession.ontologyBindingDigest
					? { ontologyBindingDigest: context.agentSession.ontologyBindingDigest }
					: {}),
				allowedTools: context.grantedTools?.workflow ?? [],
			});
		});
	}
	if (services.evolution) {
		catalog.register("evolution", (context) => services.evolution!.bindCapability(context));
	}
	catalog.register("mcp", (context) => createGraphCapability({ name: "mcp", ...context }));
	catalog.register("sparql", (context) => createGraphCapability({ name: "sparql", ...context }));
	catalog.register(
		"yws",
		async (context) =>
			new YwsCapabilityBackend({
				graphId: context.graphId,
				graphOwner: context.graphOwner,
				ownerUserId: context.ownerUserId,
				authContext: context.authContext,
				accessLevel: context.authority.minimumRole === "editor" ? "rw" : "ro",
			}),
	);
	catalog.register("soil", async (context) =>
		SoilCapabilityBackend.create({
			binary: process.env.SOIL_BIN?.trim() || "/opt/choreograph/bin/soil",
			roots: soilRoots(),
			accessLevel: context.authority.minimumRole === "editor" ? "rw" : "ro",
			dangerousOps: context.authority.dangerousOps,
		}),
	);
	for (const [name, mode, model] of [
		["evaluation.visual", "visual", process.env.HOJA_L1_MODEL?.trim() || "openai/gpt-5-mini"],
		["evaluation.primary", "reflection", process.env.HOJA_L2_MODEL?.trim() || "anthropic/claude-opus-4.5"],
		["evaluation.foreign", "reflection", process.env.HOJA_FOREIGN_MODEL?.trim() || "openai/gpt-5"],
	] as const) {
		catalog.register(name, async (context) => {
			const evidenceUrl = process.env.CHOREOGRAPH_EVIDENCE_S3_URL?.trim();
			if (!evidenceUrl) throw new Error(`${name}: CHOREOGRAPH_EVIDENCE_S3_URL is required`);
			const apiKey = process.env.OPENROUTER_API_KEY?.trim();
			if (!apiKey) throw new Error(`${name}: OPENROUTER_API_KEY is required`);
			await assertEvaluationModel(services.modelCatalog, model, mode === "visual");
			return new EvaluationCapabilityBackend({
				capabilityName: name,
				mode,
				model,
				apiKey,
				evidenceStore: EvidenceStore.fromUrl(evidenceUrl),
				...(services.evaluationFetch ? { fetchFn: services.evaluationFetch } : {}),
				...(services.evaluationApiBaseUrl ? { apiBaseUrl: services.evaluationApiBaseUrl } : {}),
				onUsage: evaluationUsageObserver(services, context, name),
				...(services.creditGate && context.ownerUserId
					? { admit: evaluationAdmission(services.creditGate, context.ownerUserId) }
					: {}),
			});
		});
	}
	return catalog;
}

/** One provider call's admission: the same gate the chat asks, on the graph owner who pays. */
function evaluationAdmission(gate: CreditAdmission, ownerUserId: string): (call: EvaluationCall) => Promise<void> {
	return (call) =>
		gate.admitEvaluator({
			userId: ownerUserId,
			model: call.model,
			requestId: call.requestId,
			estimatedInputTokens: call.estimatedInputTokens,
			maxCompletionTokens: call.maxCompletionTokens,
		});
}

async function assertEvaluationModel(
	catalog: OpenRouterModelCatalog | undefined,
	model: string,
	requireImage: boolean,
): Promise<void> {
	if (!catalog) return;
	const view = await catalog.list({ query: model, limit: 100 });
	const row = view.models.find((candidate) => candidate.id === model || candidate.canonical_id === model);
	if (!row) throw new Error(`evaluation: configured model is absent from the current OpenRouter catalog: ${model}`);
	if (requireImage && Array.isArray(row.input_modalities) && !row.input_modalities.includes("image")) {
		throw new Error(`evaluation: configured L1 model does not advertise image input: ${model}`);
	}
	if (
		Array.isArray(row.supported_parameters) &&
		!row.supported_parameters.includes("structured_outputs") &&
		!row.supported_parameters.includes("response_format")
	) {
		throw new Error(`evaluation: configured model does not advertise structured outputs: ${model}`);
	}
}

function evaluationUsageObserver(
	services: DefaultHostCapabilityServices,
	context: CapabilityBindingContext,
	template: string,
): (usage: EvaluationUsage) => void {
	const identity = captureIdentityForHostedRequest({
		authMethod: context.authContext?.method,
		ownerUserId: context.ownerUserId,
		graphId: context.graphId,
	});
	return (usage) => {
		// LEGACY PRICE PATH, on purpose (Sobremesa): these calls belong to no Session, so there is no rate card to pin
		// and they keep the static table, Sonnet fallback included (`pricedDefault` shows when it was used). They are
		// the one caller of `computeCost` outside a legacy Session; moving them onto the catalogue is a separate change.
		const cost = computeCost(usage.model, {
			input: usage.inputTokens,
			output: usage.outputTokens,
			cacheRead: usage.cacheReadTokens,
			cacheWrite: 0,
		});
		emitCaptureSoft(services.capture, {
			kind: "llm.call",
			...identity,
			outcome: usage.outcome,
			durationMs: usage.durationMs,
			payload: {
				model: usage.model,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				totalTokens: usage.totalTokens,
				...(usage.cacheReadTokens > 0 ? { cacheReadTokens: usage.cacheReadTokens } : {}),
				costMicroUsd: cost.totalCostMicroUsd,
			},
		});
		// The call's worst-case hold is released once its debit has landed (or there is no ledger to wait for).
		const releaseHold = () => services.creditGate?.releaseHold(evaluatorHoldKey(usage.requestId));
		if (!services.billing) {
			releaseHold();
			return;
		}
		void services.billing
			.recordUsageAndDebit({
				eventId: usage.requestId,
				ts: Date.now(),
				userId: context.ownerUserId || null,
				graphId: context.graphId || null,
				sandboxId: null,
				template,
				provider: "openrouter",
				model: usage.model,
				modelPriced: cost.modelPriced,
				reason: usage.outcome,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cacheReadTokens: usage.cacheReadTokens,
				cacheWriteTokens: 0,
				totalTokens: usage.totalTokens,
				inputCostMicroUsd: cost.inputCostMicroUsd,
				outputCostMicroUsd: cost.outputCostMicroUsd,
				cacheReadCostMicroUsd: cost.cacheReadCostMicroUsd,
				cacheWriteCostMicroUsd: cost.cacheWriteCostMicroUsd,
				providerCostMicroUsd: cost.providerCostMicroUsd,
				markupMicroUsd: cost.markupMicroUsd,
				costMicroUsd: cost.totalCostMicroUsd,
				pricingVersion: staticPricingVersion(),
				pricedDefault: cost.pricedDefault,
			})
			.catch((error) => console.error(`[billing] Hoja evaluator usage capture failed (non-fatal):`, error))
			.finally(releaseHold);
	};
}

function evidenceContext(input: unknown): { runId?: string; scenarioId?: string } {
	if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
	const candidate = input as Record<string, unknown>;
	return {
		...(typeof candidate.runId === "string" ? { runId: candidate.runId } : {}),
		...(typeof candidate.scenarioId === "string" ? { scenarioId: candidate.scenarioId } : {}),
	};
}

function browserBoundOrigin(): string {
	const value =
		process.env.HOJA_BROWSER_ORIGIN?.trim() ??
		process.env.HOJA_BASE_URL?.trim() ??
		process.env.CHOREOGRAPH_BROWSER_BOUND_ORIGIN?.trim();
	if (!value) throw new Error("browser: HOJA_BROWSER_ORIGIN (or HOJA_BASE_URL) is required for origin clamping");
	return new URL(value).origin;
}

export function resolveHttpFaceBaseUrl(graphId: string, graphOwner?: string): string {
	const explicit = process.env.HOJA_HTTP_BASE_URL?.trim();
	if (explicit) {
		const expanded = explicit.replaceAll("{graphId}", encodeURIComponent(graphId));
		return ensureTrailingSlash(expanded);
	}
	const gateway = process.env.MNEMOSYNE_GATEWAY_BASE_URL?.trim();
	if (gateway) {
		const graphPath = graphOwner?.trim()
			? `/o/${encodeURIComponent(graphOwner.trim())}/g/${encodeURIComponent(graphId)}`
			: `/g/${encodeURIComponent(graphId)}`;
		return scopedDocumentBase(gateway, `${graphPath}/documents/${encodeURIComponent(graphId)}/`);
	}
	const directCell = process.env.GARDEN_HTTP_BASE_URL?.trim();
	if (directCell) {
		return scopedDocumentBase(directCell, `/documents/${encodeURIComponent(graphId)}/`);
	}
	throw new Error("http: HOJA_HTTP_BASE_URL or a Garden/gateway base URL is required");
}

function scopedDocumentBase(base: string, suffix: string): string {
	const url = new URL(base);
	url.pathname = `${url.pathname.replace(/\/$/, "")}${suffix}`.replace(/\/+/g, "/");
	url.search = "";
	url.hash = "";
	return url.toString();
}

function ensureTrailingSlash(value: string): string {
	const url = new URL(value);
	if (!url.pathname.endsWith("/")) url.pathname += "/";
	return url.toString();
}

function httpAllowedOrigins(baseUrl: string): readonly string[] {
	const configured = process.env.CHOREOGRAPH_HTTP_ALLOWED_ORIGINS?.trim();
	return configured
		? configured
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean)
		: [new URL(baseUrl).origin];
}

function httpAuthHeaders(context: CapabilityBindingContext): Record<string, string> {
	const serviceAuth = resolveGatewayServiceAuth(context.ownerUserId);
	if (serviceAuth) {
		return {
			Authorization: `Bearer ${serviceAuth.serviceToken}`,
			"x-pn-on-behalf-of": serviceAuth.onBehalfOf,
		};
	}
	const bearer = delegatedBearer(context.authContext);
	return bearer ? { Authorization: `Bearer ${bearer}` } : {};
}

function delegatedBearer(authContext: HostedAuthContext | undefined): string | undefined {
	return authContext?.method === "delegated_bearer" ? authContext.bearerToken : undefined;
}

function soilRoots(): readonly string[] {
	const value = process.env.SOIL_SEED_ROOTS?.trim();
	if (!value) throw new Error("soil: SOIL_SEED_ROOTS is required");
	return value
		.split(path.delimiter)
		.map((item) => item.trim())
		.filter(Boolean);
}
