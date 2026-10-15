import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { canonicalJson } from "../agent-subject/canonical-json.js";
import { stableJson } from "../workflow/agent-tool-manifest.js";

describe("canonical JSON contract", () => {
	it("uses the bytewise key order shared with the cloud-2 Gateway", () => {
		const witness = {
			builderRecipeDigest: "f540",
			buildPlanDigest: "0c12",
			buildContextBytes: 28_675_585,
		};
		const canonical = '{"buildContextBytes":28675585,"buildPlanDigest":"0c12","builderRecipeDigest":"f540"}';

		assert.equal(stableJson(witness), canonicalJson(witness));
		assert.equal(stableJson(witness), canonical);
		assert.equal(
			createHash("sha256").update(stableJson(witness)).digest("hex"),
			"1690361cad9830297ff5112d42ac157573ae59d5f0cce4244f28e6b48001a16a",
		);
	});
});
