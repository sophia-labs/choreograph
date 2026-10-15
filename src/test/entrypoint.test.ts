import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { isExecutedDirectly } from "../entrypoint.js";

test("isExecutedDirectly matches direct file execution", () => {
	const root = mkdtempSync(join(tmpdir(), "entrypoint-test-"));
	try {
		const modulePath = join(root, "orchestrator.ts");
		writeFileSync(modulePath, "export {};\n");

		assert.equal(isExecutedDirectly(pathToFileURL(modulePath).href, modulePath), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("isExecutedDirectly resolves symlinked entry paths", () => {
	const root = mkdtempSync(join(tmpdir(), "entrypoint-test-"));
	try {
		const releasesDir = join(root, "releases", "v1");
		const currentDir = join(root, "current");
		mkdirSync(releasesDir, { recursive: true });
		symlinkSync(releasesDir, currentDir);

		const realModulePath = join(releasesDir, "src", "orchestrator.ts");
		mkdirSync(join(releasesDir, "src"), { recursive: true });
		writeFileSync(realModulePath, "export {};\n");

		const symlinkedEntryPath = join(currentDir, "src", "orchestrator.ts");
		assert.equal(isExecutedDirectly(pathToFileURL(realModulePath).href, symlinkedEntryPath), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("isExecutedDirectly returns false without an entry path", () => {
	assert.equal(isExecutedDirectly(import.meta.url, ""), false);
});
