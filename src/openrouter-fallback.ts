/**
 * The one retry a call gets when OpenRouter cannot serve it at or under the Session's card (Vera's ruling, 2026-10-01:
 * "dearer one, bill actual").
 *
 * Every call of a Session priced from the catalogue carries the card as a price ceiling (`openRouterRoutingForRateCard`).
 * When no provider at or under it is up, OpenRouter answers 404 "No endpoints found that satisfy the max price for this
 * request" (or "... with quantization: ..." under a full-precision rule) before any part of a reply exists. That answer,
 * and only that answer, earns one retry with the ceiling removed and the card's quantization rule kept
 * (`openRouterFallbackRouting`); the retry runs through the usage tap so the host learns what OpenRouter charged, and the
 * call is settled at that charge plus the card's fee (`priceAtProviderReport`). A retry is never retried: its answer,
 * whatever it is, is the call's.
 */
import type { ProxyAssistantMessageEvent } from "./wire-protocol.js";

const NO_ENDPOINTS = /\bNo endpoints found\b/i;
/**
 * OpenRouter's refusal of a call no endpoint can serve with the parameters it sends (`require_parameters`, which every
 * Session's routing asks for: its tools must be served). The price is not the reason, so it earns no retry.
 */
const PARAMETERS_REFUSAL = /\bcan handle the requested parameters\b/i;

/** OpenRouter's routing refusal: no provider serves the request under its constraints (price, quantization). */
export function isPriceCeilingRefusal(event: ProxyAssistantMessageEvent): boolean {
	return (
		event.type === "error" &&
		typeof event.errorMessage === "string" &&
		NO_ENDPOINTS.test(event.errorMessage) &&
		!PARAMETERS_REFUSAL.test(event.errorMessage)
	);
}

/**
 * Yield `first`'s events; if its first event other than `start` is OpenRouter's routing refusal, discard it (and any
 * `start` before it) and yield the events of `retry()` instead. Anything else passes through exactly as it came.
 */
export async function* withPriceCeilingFallback(
	first: AsyncIterable<ProxyAssistantMessageEvent>,
	retry: () => AsyncIterable<ProxyAssistantMessageEvent>,
): AsyncGenerator<ProxyAssistantMessageEvent> {
	const iterator = first[Symbol.asyncIterator]();
	const held: ProxyAssistantMessageEvent[] = [];
	for (;;) {
		const next = await iterator.next();
		if (next.done) {
			for (const event of held) yield event;
			return;
		}
		const event = next.value;
		if (event.type === "start") {
			held.push(event);
			continue;
		}
		if (isPriceCeilingRefusal(event)) {
			await iterator.return?.();
			yield* retry();
			return;
		}
		for (const heldEvent of held) yield heldEvent;
		yield event;
		break;
	}
	for (;;) {
		const next = await iterator.next();
		if (next.done) return;
		yield next.value;
	}
}
