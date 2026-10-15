import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { EvidenceStore } from "../evidence-store.js";

test("getThin resolves and verifies a content-addressed manifest", async (context) => {
	const root = await mkdtemp(path.join(os.tmpdir(), "choreograph-evidence-"));
	context.after(() => rm(root, { recursive: true, force: true }));
	const store = EvidenceStore.fromUrl(`${pathToFileURL(root).toString()}/`);
	const ref = await store.put(
		["run-1", "scenario-1", "beat-1", "camoufox"],
		"manifest",
		"json",
		"application/json",
		'{"schema":"sophia.browser-evidence-beat.v1"}\n',
	);

	const blob = await store.getThin({ uri: ref.uri, sha256: ref.sha256 });
	assert.equal(blob.ref.mediaType, "application/json");
	assert.equal(blob.ref.bytes, ref.bytes);
	assert.equal(blob.body.toString("utf8"), '{"schema":"sophia.browser-evidence-beat.v1"}\n');
	await assert.rejects(store.getThin({ uri: ref.uri, sha256: "0".repeat(64) }), /object digest does not match/);
});
