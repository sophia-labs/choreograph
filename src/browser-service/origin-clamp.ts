/**
 * Origin-clamping guard for session navigation.
 *
 * When a session has a `boundOrigin`, any attempt to navigate to a URL outside
 * that origin is rejected. This prevents an agent from driving a session outside
 * the system-under-test (e.g. navigating to attacker-controlled pages that could
 * exfiltrate the stored Cognito session).
 *
 * The check is performed on the URL that the caller explicitly requests — it does
 * not block in-page navigations triggered by the app itself (e.g., client-side
 * router pushes). Those are acceptable because they start from the same origin.
 */

/**
 * Validate that `url` is within `boundOrigin`.
 * Returns the validated URL string.
 * Throws a OriginClampError if the check fails.
 */
export function clampUrl(url: string, boundOrigin: string): string {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new OriginClampError(`Invalid URL: ${JSON.stringify(url)}`);
	}

	let bound: URL;
	try {
		bound = new URL(boundOrigin);
	} catch {
		throw new OriginClampError(`Invalid boundOrigin: ${JSON.stringify(boundOrigin)}`);
	}

	// Origin = protocol + host (includes port)
	if (parsed.origin !== bound.origin) {
		throw new OriginClampError(`Navigation rejected: ${parsed.origin} is outside boundOrigin ${bound.origin}`);
	}
	return url;
}

export class OriginClampError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OriginClampError";
	}
}
