import { createHash } from "node:crypto";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue | undefined };

/**
 * Serialize a JSON value with object keys ordered by JavaScript UTF-16 code
 * units. Arrays retain their order and scalar encoding matches JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
	return serialize(value);
}

function serialize(value: unknown): string {
	if (value === null) return "null";

	const type = typeof value;
	if (type === "number") return Number.isFinite(value as number) ? String(value) : "null";
	if (type === "boolean") return value ? "true" : "false";
	if (type === "string") return JSON.stringify(value);

	if (Array.isArray(value)) {
		return `[${value
			.map((item) => (item === undefined || typeof item === "function" ? "null" : serialize(item)))
			.join(",")}]`;
	}

	if (type === "object") {
		const object = value as Record<string, unknown>;
		const entries: string[] = [];
		for (const key of Object.keys(object).sort()) {
			const item = object[key];
			if (item === undefined || typeof item === "function") continue;
			entries.push(`${JSON.stringify(key)}:${serialize(item)}`);
		}
		return `{${entries.join(",")}}`;
	}

	return "null";
}

/** SHA-256 hex over canonicalJson(value), without an algorithm prefix. */
export function canonicalDigest(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
