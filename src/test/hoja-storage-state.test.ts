import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { isDirectExecution, mintHojaStorageState, parseRuntimeEnvironment } from "../hoja-storage-state.js";

test("parseRuntimeEnvironment preserves values after the first equals sign", () => {
	assert.deepEqual(parseRuntimeEnvironment("A=one=two\nB=three\n"), { A: "one=two", B: "three" });
});

test("isDirectExecution recognizes a systemd argv path through the current-release symlink", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "hoja-storage-main-"));
	try {
		const releaseDirectory = path.join(directory, "releases", "abc123", "src");
		const currentDirectory = path.join(directory, "current");
		await mkdir(releaseDirectory, { recursive: true });
		const modulePath = path.join(releaseDirectory, "hoja-storage-state.ts");
		await writeFile(modulePath, "export {};\n");
		await symlink(path.join(directory, "releases", "abc123"), currentDirectory, "dir");

		assert.equal(
			isDirectExecution(pathToFileURL(modulePath).href, path.join(currentDirectory, "src", "hoja-storage-state.ts")),
			true,
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("mintHojaStorageState emits the exact Shrubbery Cognito localStorage contract", async () => {
	let request: { target: string | null; body: unknown } | undefined;
	const state = await mintHojaStorageState(
		{
			username: "probe@example.test",
			password: "secret-password",
			clientId: "client-id",
			region: "us-west-1",
		},
		{
			now: () => 1_000,
			fetchFn: async (_url, init) => {
				request = {
					target: new Headers(init?.headers).get("x-amz-target"),
					body: JSON.parse(String(init?.body)),
				};
				return new Response(
					JSON.stringify({
						AuthenticationResult: {
							AccessToken: "access",
							IdToken: "id",
							RefreshToken: "refresh",
							ExpiresIn: 3600,
						},
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			},
		},
	);

	assert.equal(request?.target, "AWSCognitoIdentityProviderService.InitiateAuth");
	assert.deepEqual(request?.body, {
		ClientId: "client-id",
		AuthFlow: "USER_PASSWORD_AUTH",
		AuthParameters: { USERNAME: "probe@example.test", PASSWORD: "secret-password" },
	});
	assert.equal(state.origins[0].origin, "https://garden.example.invalid");
	assert.equal(state.origins[0].localStorage[0].name, "shrubbery.cognito.tokens.v1");
	assert.deepEqual(JSON.parse(state.origins[0].localStorage[0].value), {
		accessToken: "access",
		idToken: "id",
		refreshToken: "refresh",
		expiresAt: 3_601_000,
	});
});

test("mintHojaStorageState fails closed on a Cognito challenge", async () => {
	await assert.rejects(
		mintHojaStorageState(
			{
				username: "probe",
				password: "password",
				clientId: "client",
				region: "us-west-1",
			},
			{
				fetchFn: async () =>
					new Response(JSON.stringify({ ChallengeName: "NEW_PASSWORD_REQUIRED" }), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			},
		),
		/unsupported Cognito challenge NEW_PASSWORD_REQUIRED/,
	);
});
