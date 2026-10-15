/**
 * The few HTTP helpers the Sobremesa chat routes share. Errors use the same
 * `{ error: { code, message } }` envelope invocations use, so a client parses one
 * shape across `POST /api/invocations`, the chat list, the seed door and the
 * model catalogue.
 */

import type { ServerResponse } from "node:http";

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
	response.statusCode = status;
	response.setHeader("content-type", "application/json; charset=utf-8");
	response.end(JSON.stringify(payload, null, 2));
}

export function sendCodedError(
	response: ServerResponse,
	status: number,
	code: string,
	message: string,
	details?: unknown,
): void {
	sendJson(response, status, { error: { code, message, ...(details === undefined ? {} : { details }) } });
}

/** The first value of a header, trimmed; undefined when absent or blank. */
export function firstHeader(value: string | string[] | undefined): string | undefined {
	const first = Array.isArray(value) ? value[0] : value;
	const trimmed = first?.trim();
	return trimmed ? trimmed : undefined;
}
