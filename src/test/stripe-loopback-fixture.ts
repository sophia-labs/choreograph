/**
 * A loopback Stripe for the checkout tests (Sobremesa). NO MOCKS in the code under test.
 *
 * Stripe is the one external boundary these tests stand in for, and they stand in for it the honest way:
 * a REAL HTTP server on 127.0.0.1 that speaks form-encoded Stripe, records every request exactly as it
 * arrived (method, path, headers, decoded form body) and answers canned JSON. The client under test is the
 * real `stripePost` over the real `fetch`, so header names, encoding and the base-URL rule are exercised
 * for real instead of being asserted against a stub `fetchFn`.
 */

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface StripeRequest {
	readonly method: string;
	readonly path: string;
	readonly headers: IncomingHttpHeaders;
	/** The form body, decoded: `{ "metadata[user_id]": "u1", ... }`. */
	readonly form: Record<string, string>;
}

export interface StripeReply {
	readonly status?: number;
	readonly json: Record<string, unknown>;
	/** Hold the answer this long: lets a test keep one call in flight while another starts. */
	readonly delayMs?: number;
}

export type StripeReplies = Record<string, StripeReply | ((request: StripeRequest) => StripeReply)>;

export interface LoopbackStripe {
	readonly baseUrl: string;
	/** Every request, in arrival order. */
	readonly requests: readonly StripeRequest[];
	/** The requests to one path, in arrival order. */
	to(path: string): StripeRequest[];
	close(): Promise<void>;
}

export async function startLoopbackStripe(replies: StripeReplies): Promise<LoopbackStripe> {
	const requests: StripeRequest[] = [];
	const server: Server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const url = new URL(request.url ?? "/", "http://loopback");
			const form: Record<string, string> = {};
			new URLSearchParams(Buffer.concat(chunks).toString("utf8")).forEach((value, key) => {
				form[key] = value;
			});
			const seen: StripeRequest = {
				method: request.method ?? "",
				path: url.pathname,
				headers: request.headers,
				form,
			};
			requests.push(seen);
			const configured = replies[url.pathname];
			const reply: StripeReply =
				typeof configured === "function"
					? configured(seen)
					: (configured ?? { status: 404, json: { error: { message: "no reply configured" } } });
			setTimeout(() => {
				response.statusCode = reply.status ?? 200;
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify(reply.json));
			}, reply.delayMs ?? 0);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		requests,
		to: (path) => requests.filter((request) => request.path === path),
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections?.();
				server.close(() => resolve());
			}),
	};
}
