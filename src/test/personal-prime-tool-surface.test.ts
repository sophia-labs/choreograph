import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assertPersonalPrimeGraphReadToolsAvailable,
	PERSONAL_PRIME_GRAPH_READ_TOOLS,
} from "../workflow/personal-prime-tool-surface.js";

describe("personal Prime graph tool surface", () => {
	it("contains only graph-scoped tools and excludes gateway control-plane discovery", () => {
		assert.ok(PERSONAL_PRIME_GRAPH_READ_TOOLS.includes("get_workspace"));
		assert.ok(PERSONAL_PRIME_GRAPH_READ_TOOLS.includes("read_document"));
		assert.equal((PERSONAL_PRIME_GRAPH_READ_TOOLS as readonly string[]).includes("list_graphs"), false);
	});

	it("accepts the exact declared surface plus unrelated cell tools", () => {
		assert.doesNotThrow(() =>
			assertPersonalPrimeGraphReadToolsAvailable([...PERSONAL_PRIME_GRAPH_READ_TOOLS, "write_document"]),
		);
	});

	it("fails closed with every missing advertised tool named", () => {
		const available = PERSONAL_PRIME_GRAPH_READ_TOOLS.filter((name) => name !== "quick_orient" && name !== "recall");
		assert.throws(
			() => assertPersonalPrimeGraphReadToolsAvailable(available),
			/error.*missing: quick_orient, recall|personal Prime graph tool surface is unavailable; missing: quick_orient, recall/,
		);
	});
});
