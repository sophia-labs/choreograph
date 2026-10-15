/** Cloud-2 canonical typed graph-owner grammar (Garden SHACL / gateway guard). */
export const GRAPH_OWNER_PRINCIPAL_PATTERN = /^(?:user|agent|service|organization):[A-Za-z0-9_.@:-]{1,192}$/;

export function isCanonicalGraphOwnerPrincipal(value: unknown): value is string {
	return typeof value === "string" && GRAPH_OWNER_PRINCIPAL_PATTERN.test(value);
}

export function requireCanonicalGraphOwnerPrincipal(value: unknown, label = "graph owner principal"): string {
	if (!isCanonicalGraphOwnerPrincipal(value)) {
		throw new Error(`invalid ${label}: ${JSON.stringify(value)}`);
	}
	return value;
}
