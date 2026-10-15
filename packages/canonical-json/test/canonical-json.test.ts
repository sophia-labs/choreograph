import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { canonicalDigest, canonicalJson } from "../src/index.js";

interface GoldenVectors {
	readonly schema: string;
	readonly vectors: ReadonlyArray<{
		readonly name: string;
		readonly value: unknown;
		readonly canonical: string;
		readonly sha256: string;
	}>;
}

const vectors = JSON.parse(
	readFileSync(new URL("../golden-vectors.json", import.meta.url), "utf8"),
) as GoldenVectors;

describe("Sophia canonical JSON", () => {
	it("matches every language-neutral golden vector", () => {
		assert.equal(vectors.schema, "sophia.canonical-json-golden-vectors.v1");
		for (const vector of vectors.vectors) {
			assert.equal(canonicalJson(vector.value), vector.canonical, vector.name);
			assert.equal(canonicalDigest(vector.value), vector.sha256, vector.name);
		}
	});

	it("normalizes values exactly as JSON serialization does at the boundary", () => {
		assert.equal(canonicalJson({ kept: 1, omitted: undefined }), '{"kept":1}');
		assert.equal(canonicalJson([1, undefined]), "[1,null]");
		assert.equal(canonicalJson(Number.NaN), "null");
	});
});
