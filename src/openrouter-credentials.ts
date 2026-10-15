import type { IncomingMessage, ServerResponse } from "node:http";
import { DeleteParameterCommand, GetParameterCommand, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { resolveHostedAuthContext, resolveHostedCallerUserId } from "./auth.js";
import { providerCredentialParameterName } from "./provider-credentials.js";

const SCHEMA = "choreograph.openrouter-api-key.v1";
export interface OpenRouterKeyStore {
	get(owner: string): Promise<string | undefined>;
	put(owner: string, apiKey: string): Promise<void>;
	delete(owner: string): Promise<void>;
}

/** A person's own OpenRouter key: its own credential family and SSM leaf. */
export class SsmOpenRouterKeyStore implements OpenRouterKeyStore {
	constructor(
		private readonly client: Pick<SSMClient, "send">,
		private readonly prefix: string,
		private readonly kmsKeyId: string,
	) {
		providerCredentialParameterName(prefix, "validation", "openrouter");
		if (!kmsKeyId.trim()) throw new Error("Provider credential KMS key is required");
	}
	private name(owner: string): string {
		return providerCredentialParameterName(this.prefix, owner, "openrouter");
	}
	async get(owner: string): Promise<string | undefined> {
		try {
			const result = await this.client.send(
				new GetParameterCommand({ Name: this.name(owner), WithDecryption: true }),
			);
			const record = JSON.parse(result.Parameter?.Value ?? "null");
			if (record?.schema !== SCHEMA || record?.provider !== "openrouter" || record?.kind !== "api-key")
				throw new Error("Invalid stored provider credential");
			return validateOpenRouterKey(record.apiKey);
		} catch (error) {
			if ((error as { name?: string })?.name === "ParameterNotFound") return undefined;
			throw new Error("Provider credential store unavailable");
		}
	}
	async put(owner: string, apiKey: string): Promise<void> {
		const key = validateOpenRouterKey(apiKey);
		await this.client.send(
			new PutParameterCommand({
				Name: this.name(owner),
				Type: "SecureString",
				KeyId: this.kmsKeyId,
				// Validated API-key envelope is <1 KiB; Standard uses existing kms:Encrypt authority.
				Tier: "Standard",
				Overwrite: true,
				Value: JSON.stringify({ schema: SCHEMA, provider: "openrouter", kind: "api-key", apiKey: key }),
			}),
		);
	}
	async delete(owner: string): Promise<void> {
		try {
			await this.client.send(new DeleteParameterCommand({ Name: this.name(owner) }));
		} catch (error) {
			if ((error as { name?: string })?.name !== "ParameterNotFound")
				throw new Error("Provider credential store unavailable");
		}
	}
}

export function configureOpenRouterKeyStore(env: NodeJS.ProcessEnv = process.env): OpenRouterKeyStore | undefined {
	const prefix = env.PROVIDER_CREDENTIALS_SSM_PREFIX?.trim();
	const kms = env.PROVIDER_CREDENTIALS_KMS_KEY_ID?.trim();
	if (!prefix && !kms) return undefined;
	if (!prefix || !kms) throw new Error("Both provider credential SSM prefix and KMS key are required");
	return new SsmOpenRouterKeyStore(new SSMClient({}), prefix, kms);
}

export function validateOpenRouterKey(value: unknown): string {
	if (typeof value !== "string" || !/^sk-or-v1-[A-Za-z0-9_-]{16,512}$/.test(value.trim()))
		throw new Error("Invalid OpenRouter API key");
	return value.trim();
}

/** No cache: replacement/deletion applies to the next inference dispatch. Store failures never fall back. */
export async function selectOpenRouterCredential(
	store: OpenRouterKeyStore | undefined,
	owner: string | undefined,
	platformKey: string | undefined,
	userInferenceEnabled = false,
): Promise<{ apiKey: string | undefined; fundingSource: "platform" | "user" }> {
	if (userInferenceEnabled && store && owner) {
		const key = await store.get(owner);
		if (key !== undefined) return { apiKey: validateOpenRouterKey(key), fundingSource: "user" };
	}
	return { apiKey: platformKey?.trim() || undefined, fundingSource: "platform" };
}

export async function resolveOpenRouterKey(
	store: OpenRouterKeyStore | undefined,
	owner: string | undefined,
	platformKey: string | undefined,
	userInferenceEnabled = false,
): Promise<string | undefined> {
	return (await selectOpenRouterCredential(store, owner, platformKey, userInferenceEnabled)).apiKey;
}

export interface ProviderCredentialRouteOptions {
	store?: OpenRouterKeyStore;
	platformKey?: string;
	userInferenceEnabled?: boolean;
	resolveOwner?: typeof resolveHostedCallerUserId;
}

export async function handleOpenRouterCredential(
	request: IncomingMessage,
	response: ServerResponse,
	options: ProviderCredentialRouteOptions,
): Promise<void> {
	const send = (status: number, body: unknown) => {
		response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
		response.end(JSON.stringify(body));
	};
	const method = request.method;
	if (method !== "GET" && method !== "PUT" && method !== "DELETE") {
		response.setHeader("allow", "GET, PUT, DELETE");
		send(405, { error: "method_not_allowed" });
		return;
	}
	let owner: string;
	try {
		const authContext = resolveHostedAuthContext(request.headers);
		if (!authContext) {
			send(401, { error: "authentication_required" });
			return;
		}
		if (method !== "GET" && authContext.method !== "delegated_bearer") {
			send(403, { error: "human_bearer_required" });
			return;
		}
		owner = await (options.resolveOwner ?? resolveHostedCallerUserId)({
			apiBaseUrl: process.env.MNEMOSYNE_API_BASE_URL ?? "",
			authContext,
		});
	} catch {
		send(401, { error: "authentication_failed" });
		return;
	}
	if (!options.store) {
		send(503, { error: "provider_credential_store_unavailable" });
		return;
	}
	let key: string | undefined;
	if (method === "PUT") {
		try {
			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of request) {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				size += bytes.length;
				if (size > 8192) {
					send(413, { error: "request_body_too_large" });
					return;
				}
				chunks.push(bytes);
			}
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => k !== "apiKey"))
				throw new Error("Invalid body");
			key = validateOpenRouterKey(body.apiKey);
		} catch {
			send(400, { error: "provider_credential_invalid" });
			return;
		}
	}
	try {
		if (method === "PUT") await options.store.put(owner, key!);
		if (method === "DELETE") await options.store.delete(owner);
		const configured =
			method === "PUT" ? true : method === "DELETE" ? false : (await options.store.get(owner)) !== undefined;
		send(200, {
			provider: "openrouter",
			configured,
			effectiveSource:
				configured && options.userInferenceEnabled ? "user" : options.platformKey?.trim() ? "platform" : "none",
		});
	} catch {
		send(503, { error: "provider_credential_store_unavailable" });
	}
}
