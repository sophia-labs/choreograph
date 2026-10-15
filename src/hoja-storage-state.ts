import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STORAGE_KEY = "shrubbery.cognito.tokens.v1";
const DEFAULT_ORIGIN = "https://garden.example.invalid";
const REQUEST_TIMEOUT_MS = 15_000;

interface CognitoAuthenticationResult {
	readonly AccessToken?: unknown;
	readonly IdToken?: unknown;
	readonly RefreshToken?: unknown;
	readonly ExpiresIn?: unknown;
}

interface CognitoEnvelope {
	readonly __type?: unknown;
	readonly message?: unknown;
	readonly ChallengeName?: unknown;
	readonly AuthenticationResult?: CognitoAuthenticationResult;
}

export interface HojaProbeCredentials {
	readonly username: string;
	readonly password: string;
	readonly clientId: string;
	readonly region: string;
	readonly origin?: string;
	readonly endpoint?: string;
}

export interface HojaStorageState {
	readonly cookies: readonly unknown[];
	readonly origins: readonly [
		{
			readonly origin: string;
			readonly localStorage: readonly [{ readonly name: string; readonly value: string }];
		},
	];
}

/** Parse the deliberately simple KEY=VALUE file produced by deploy/load-env.sh. */
export function parseRuntimeEnvironment(source: string): Readonly<Record<string, string>> {
	const values: Record<string, string> = {};
	for (const rawLine of source.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator <= 0) throw new Error("hoja storage state: malformed runtime environment line");
		const key = line.slice(0, separator);
		if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error("hoja storage state: invalid environment key");
		values[key] = line.slice(separator + 1);
	}
	return values;
}

/**
 * Exchange the dedicated probe credential for Cognito tokens and express
 * them in Playwright's storageState shape. Passwords and tokens never enter a
 * workflow envelope; only the browser service receives the resulting file.
 */
export async function mintHojaStorageState(
	credentials: HojaProbeCredentials,
	options: { readonly fetchFn?: typeof fetch; readonly now?: () => number } = {},
): Promise<HojaStorageState> {
	const username = required(credentials.username, "HOJA_PROBE_USERNAME");
	const password = required(credentials.password, "HOJA_PROBE_PASSWORD");
	const clientId = required(credentials.clientId, "COGNITO_CLIENT_ID");
	const region = required(credentials.region, "AWS_DEFAULT_REGION");
	const origin = normalizedOrigin(credentials.origin ?? DEFAULT_ORIGIN);
	const endpoint = credentials.endpoint?.trim() || `https://cognito-idp.${region}.amazonaws.com/`;
	const endpointUrl = new URL(endpoint);
	if (
		endpointUrl.protocol !== "https:" &&
		endpointUrl.hostname !== "127.0.0.1" &&
		endpointUrl.hostname !== "localhost"
	) {
		throw new Error("hoja storage state: Cognito endpoint must use HTTPS");
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	let response: Response;
	try {
		response = await (options.fetchFn ?? fetch)(endpointUrl, {
			method: "POST",
			headers: {
				"content-type": "application/x-amz-json-1.1",
				"x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
			},
			body: JSON.stringify({
				ClientId: clientId,
				AuthFlow: "USER_PASSWORD_AUTH",
				AuthParameters: { USERNAME: username, PASSWORD: password },
			}),
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}

	const envelope = (await response.json().catch(() => ({}))) as CognitoEnvelope;
	if (!response.ok) {
		const type = stringValue(envelope.__type).split("#").pop() || `HTTP ${response.status}`;
		throw new Error(
			`hoja storage state: Cognito ${type}: ${stringValue(envelope.message) || "authentication failed"}`,
		);
	}
	if (typeof envelope.ChallengeName === "string") {
		throw new Error(`hoja storage state: unsupported Cognito challenge ${envelope.ChallengeName}`);
	}

	const result = envelope.AuthenticationResult;
	const accessToken = required(stringValue(result?.AccessToken), "Cognito AccessToken");
	const idToken = required(stringValue(result?.IdToken), "Cognito IdToken");
	const refreshToken = required(stringValue(result?.RefreshToken), "Cognito RefreshToken");
	const expiresIn =
		typeof result?.ExpiresIn === "number" && Number.isFinite(result.ExpiresIn) && result.ExpiresIn > 0
			? result.ExpiresIn
			: 3600;
	const value = JSON.stringify({
		accessToken,
		idToken,
		refreshToken,
		expiresAt: (options.now ?? Date.now)() + Math.round(expiresIn * 1000),
	});
	return {
		cookies: [],
		origins: [{ origin, localStorage: [{ name: STORAGE_KEY, value }] }],
	};
}

export async function writeHojaStorageState(
	environmentFile: string,
	outputFile: string,
	options: { readonly fetchFn?: typeof fetch; readonly now?: () => number } = {},
): Promise<void> {
	const environment = parseRuntimeEnvironment(await readFile(environmentFile, "utf8"));
	const state = await mintHojaStorageState(
		{
			username: environment.HOJA_PROBE_USERNAME ?? "",
			password: environment.HOJA_PROBE_PASSWORD ?? "",
			clientId: environment.COGNITO_CLIENT_ID ?? "",
			region: environment.AWS_DEFAULT_REGION || "us-west-1",
			origin: environment.HOJA_BROWSER_ORIGIN || DEFAULT_ORIGIN,
		},
		options,
	);
	await mkdir(path.dirname(outputFile), { recursive: true, mode: 0o700 });
	const temporary = `${outputFile}.tmp-${process.pid}`;
	await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
	await chmod(temporary, 0o600);
	await rename(temporary, outputFile);
}

function normalizedOrigin(value: string): string {
	const url = new URL(required(value, "HOJA_BROWSER_ORIGIN"));
	if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
		throw new Error("hoja storage state: browser origin must be a bare HTTPS origin");
	}
	return url.origin;
}

function required(value: string, label: string): string {
	const normalized = value.trim();
	if (!normalized) throw new Error(`hoja storage state: ${label} is required`);
	return normalized;
}

function stringValue(value: unknown): string {
	return typeof value === "string" ? value : "";
}

async function main(): Promise<void> {
	const environmentFile = process.argv[2] || "/run/choreograph/env";
	const outputFile = process.argv[3] || "/opt/choreograph/storage-states/hoja.json";
	await writeHojaStorageState(environmentFile, outputFile);
	console.error(`[hoja-auth] wrote authenticated browser storage state to ${outputFile}`);
}

/**
 * ESM resolves the release's `current` symlink before assigning import.meta.url,
 * while process.argv preserves the symlinked path passed by systemd. Compare
 * real paths so the host-side credential mint actually runs on every release.
 */
export function isDirectExecution(moduleUrl: string, argvEntry: string | undefined): boolean {
	if (!argvEntry) return false;
	try {
		return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvEntry);
	} catch {
		return false;
	}
}

if (isDirectExecution(import.meta.url, process.argv[1])) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
