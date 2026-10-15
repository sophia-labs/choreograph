import type { HostedAuthContext } from "../auth.js";
import type { CapabilityBackend } from "../mnemosyne.js";
import type { GrantedCapabilityV1 } from "../workflow/agent-tool-grant.js";
import { InvocationFault } from "../workflow/invocation.js";

export interface CapabilityBindingContext {
	readonly graphId: string;
	/** The already-authorized workflow incarnation this node belongs to. */
	readonly runId?: string;
	/** Canonical typed owner (`user:<sub>`) of the gateway-authorized graph. */
	readonly graphOwner?: string;
	readonly actorRef: string;
	readonly ownerUserId: string;
	/** Declared workflow authority. Backends may attenuate themselves further. */
	readonly authority: {
		readonly minimumRole: "viewer" | "editor";
		readonly dangerousOps: boolean;
	};
	readonly authContext?: HostedAuthContext;
	readonly input?: unknown;
	/** Tool names remaining after manifest, steward grant, and node attenuation. */
	readonly grantedTools?: Readonly<Record<string, readonly string[]>>;
	/** Full signed snapshots for quota and resource-fence enforcement. */
	readonly grantedCapabilities?: readonly GrantedCapabilityV1[];
	/** Domain trigger/object scope used by host adapters to clamp external reads. */
	readonly semanticScope?: unknown;
	/** Agent/observer Meaningful Object coordinates for node-scoped testimony. */
	readonly agentSession?: {
		readonly sessionId: string;
		readonly nodeKey?: string;
		readonly agentId: string;
		readonly ontologyBindingDigest?: string;
	};
}

export type CapabilityFactory = (context: CapabilityBindingContext) => Promise<CapabilityBackend>;

/**
 * Trusted factory registry for invocation capabilities. Workflow source names a
 * capability; only this host catalog decides whether and how it is implemented.
 */
export class HostCapabilityCatalog {
	private readonly factories = new Map<string, CapabilityFactory>();

	register(name: string, factory: CapabilityFactory): this {
		const normalized = name.trim();
		if (!normalized) throw new Error("Capability name must not be empty");
		if (this.factories.has(normalized)) throw new Error(`Capability factory already registered: ${normalized}`);
		this.factories.set(normalized, factory);
		return this;
	}

	list(): readonly string[] {
		return [...this.factories.keys()].sort();
	}

	async bind(
		names: readonly string[],
		context: CapabilityBindingContext,
	): Promise<ReadonlyMap<string, CapabilityBackend>> {
		const bound = new Map<string, CapabilityBackend>();
		try {
			for (const name of names) {
				const factory = this.factories.get(name);
				if (!factory) {
					throw new InvocationFault(
						"capability_unavailable",
						`No host implementation is registered for capability '${name}'`,
						409,
						{ capability: name },
					);
				}
				bound.set(name, await factory(context));
			}
			return bound;
		} catch (error) {
			await Promise.allSettled([...new Set(bound.values())].map((backend) => backend.close()));
			throw error;
		}
	}
}
