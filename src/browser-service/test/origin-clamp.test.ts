/**
 * Unit tests for origin-clamp logic — no browser required.
 */

import { describe, expect, it } from "vitest";
import { clampUrl, OriginClampError } from "../origin-clamp.js";

describe("clampUrl", () => {
	it("allows same-origin URL", () => {
		expect(clampUrl("https://garden.example.invalid/foo/bar", "https://garden.example.invalid")).toBe(
			"https://garden.example.invalid/foo/bar",
		);
	});

	it("allows same-origin URL with path on bound", () => {
		// boundOrigin is an origin only — path is ignored in comparison
		expect(clampUrl("https://garden.example.invalid/baz", "https://garden.example.invalid/some/path")).toBe(
			"https://garden.example.invalid/baz",
		);
	});

	it("rejects cross-origin URL", () => {
		expect(() => clampUrl("https://evil.com/steal", "https://garden.example.invalid")).toThrow(OriginClampError);
	});

	it("rejects cross-scheme URL (http vs https)", () => {
		expect(() => clampUrl("http://garden.example.invalid/foo", "https://garden.example.invalid")).toThrow(
			OriginClampError,
		);
	});

	it("rejects cross-port URL", () => {
		expect(() => clampUrl("https://garden.example.invalid:8080/foo", "https://garden.example.invalid")).toThrow(
			OriginClampError,
		);
	});

	it("throws on invalid URL", () => {
		expect(() => clampUrl("not a url", "https://garden.example.invalid")).toThrow(OriginClampError);
	});

	it("throws on invalid boundOrigin", () => {
		expect(() => clampUrl("https://garden.example.invalid/foo", "not-an-origin")).toThrow(OriginClampError);
	});
});
