export const PRIME_HOST_WIRE_MAX_LINE_BYTES = 8 * 1024 * 1024;

export class NdjsonLineLimitError extends Error {
	readonly bytes: number;
	readonly maximum: number;

	constructor(bytes: number, maximum = PRIME_HOST_WIRE_MAX_LINE_BYTES) {
		super(`Prime worker NDJSON line exceeds ${maximum}-byte limit (${bytes} bytes)`);
		this.name = "NdjsonLineLimitError";
		this.bytes = bytes;
		this.maximum = maximum;
	}
}

export function parseNdjsonLine(line: string): unknown | undefined {
	const bytes = Buffer.byteLength(line, "utf8");
	if (bytes > PRIME_HOST_WIRE_MAX_LINE_BYTES) throw new NdjsonLineLimitError(bytes);
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	return JSON.parse(trimmed) as unknown;
}
