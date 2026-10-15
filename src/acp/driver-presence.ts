/**
 * DriverPresence — the multi-driver authority register at the pure heart of CA-1.
 *
 * CA-1 / S3 — the keystone's substrate-blind core.
 *
 * A CA-1 session can have MANY clients attached (human drivers, observers, the
 * embedded Pi agent). Exactly one of them holds the *driver* role at a time:
 * the right to author privileged session ops (prompt, permission decisions).
 * {@link DriverPresence} is the trait that answers "who is the driver right
 * now?" and arbitrates handoff.
 *
 * The implementation here, {@link InProcessLwwPresence}, is a Last-Writer-Wins
 * register: each `claim(clientId, ts)` competes on a `(ts, clientId)` key —
 * larger `ts` wins; on a tie the lexicographically-SMALLER `clientId` wins (a
 * total, deterministic order, so two clients claiming at the same logical tick
 * converge on the same driver without coordination). `release(clientId)` only
 * vacates the seat if that client is the current driver (a stale release from a
 * since-superseded client is a no-op).
 *
 * SUBSTRATE-BLIND ON PURPOSE — this module imports NO CRDT library (yrs / Loro
 * / yjs). The LWW register IS a CRDT (a join-semilattice over `(ts, clientId)`),
 * but it is a few lines of plain, total code; naming an external substrate here
 * would be premature apparatus. Where ordering authority eventually lives across
 * processes (a real CRDT relay? a single writer? the MO log?) is the deliberately
 * deferred fork that S1's projection already flagged — this slice keeps it open.
 *
 * {@link InProcessLwwPresence.snapshot} returns a DEEP-FROZEN {@link PresenceState}
 * value — the firewall between the live, still-mutating register and the
 * immutable value an arbitration route reads. This mirrors the freeze() firewall
 * in ../agent-subject/intent-log.ts (~:103): a snapshot the consumer cannot
 * accidentally mutate.
 */

/**
 * One client's claim on the driver seat: its `clientId` and the logical
 * timestamp `ts` it claimed at. `(ts, clientId)` is the LWW comparison key.
 */
export interface DriverClaim {
	readonly clientId: string;
	readonly ts: number;
}

/**
 * An immutable, deep-frozen point-in-time read of a {@link DriverPresence}.
 * `currentDriver` is the winning claim's clientId (or `null` when no client has
 * ever claimed). `claim` is the winning {@link DriverClaim} (or `null`). This is
 * the ONLY value an arbitration route reads — never the live register.
 */
export interface PresenceState {
	readonly currentDriver: string | null;
	readonly claim: DriverClaim | null;
}

/**
 * The DriverPresence trait. Substrate-blind: it names no CRDT and no storage
 * engine — only "claim a seat at a tick", "release it", and "read who holds it".
 */
export interface DriverPresence {
	/**
	 * Compete for the driver seat at logical timestamp `ts`. The LWW rule decides
	 * the winner: larger `ts` wins; tie → lexicographically-smaller `clientId`
	 * wins. Returns true iff `clientId` is the driver AFTER this claim is applied.
	 */
	claim(clientId: string, ts: number): boolean;
	/**
	 * Vacate the seat IFF `clientId` currently holds it. A release from a
	 * non-driver (e.g. a since-superseded client) is a no-op. Returns true iff the
	 * seat was actually vacated by this call.
	 */
	release(clientId: string): boolean;
	/** The current driver's clientId, or null if no client has ever claimed. */
	currentDriver(): string | null;
	/** A deep-frozen, immutable snapshot of the register (the firewall value). */
	snapshot(): PresenceState;
}

/**
 * `true` iff claim `a` should win over claim `b` under the LWW rule:
 * larger `ts` wins; on a tie the lexicographically-smaller `clientId` wins.
 * A total order over distinct `(ts, clientId)` pairs.
 */
function beats(a: DriverClaim, b: DriverClaim): boolean {
	if (a.ts !== b.ts) return a.ts > b.ts;
	return a.clientId < b.clientId;
}

/**
 * In-process Last-Writer-Wins driver-presence register.
 *
 * Holds the single current winning claim. A `claim` is applied iff it `beats`
 * the incumbent (or there is no incumbent). This makes `claim` idempotent and
 * order-insensitive: replaying the same set of claims in any order converges on
 * the same driver (the join of the `(ts, clientId)` semilattice).
 */
export class InProcessLwwPresence implements DriverPresence {
	private winner: DriverClaim | null = null;

	claim(clientId: string, ts: number): boolean {
		const candidate: DriverClaim = { clientId, ts };
		if (this.winner === null || beats(candidate, this.winner)) {
			this.winner = candidate;
		}
		return this.winner.clientId === clientId;
	}

	release(clientId: string): boolean {
		if (this.winner !== null && this.winner.clientId === clientId) {
			this.winner = null;
			return true;
		}
		return false;
	}

	currentDriver(): string | null {
		return this.winner === null ? null : this.winner.clientId;
	}

	snapshot(): PresenceState {
		// Deep-freeze: the inner claim AND the wrapping state are frozen, so a
		// consumer holding the snapshot cannot mutate the register's view through it.
		const claim: DriverClaim | null =
			this.winner === null ? null : Object.freeze({ clientId: this.winner.clientId, ts: this.winner.ts });
		return Object.freeze({
			currentDriver: this.winner === null ? null : this.winner.clientId,
			claim,
		});
	}
}

/** The privileged session op a client is trying to author. */
export type AuthorizedOp = "session/prompt" | "session/permission" | "session/steer";

/**
 * Ops that ELECT the driver for a fresh (never-claimed) seat. Authoring a prompt
 * or a steer on an unclaimed session is the act of becoming its driver (the N=1
 * solo case). Answering a permission is NOT driver-electing — only an already-seated
 * driver may decide, so `session/permission` is absent here and never auto-claims.
 */
const DRIVER_ELECTING_OPS: ReadonlySet<AuthorizedOp> = new Set<AuthorizedOp>(["session/prompt", "session/steer"]);

/** A successful authorization: the op is allowed for the requesting client. */
export interface AuthorizeOk {
	readonly ok: true;
	readonly op: AuthorizedOp;
	readonly driver: string;
}

/** A rejected authorization: the requesting client is not the driver. */
export interface AuthorizeDenied {
	readonly ok: false;
	readonly op: AuthorizedOp;
	readonly error: "not_driver";
	readonly driver: string | null;
}

export type AuthorizeResult = AuthorizeOk | AuthorizeDenied;

/**
 * Route-helper: authorize a privileged session `op` for `clientId` against the
 * live presence register.
 *
 * SOLO AUTO-CLAIM (N=1): if NO client has ever claimed the seat AND `op` is a
 * {@link DRIVER_ELECTING_OPS driver-electing op} (prompt/steer), the first
 * authorize() implicitly claims it for the requester at `ts` (default: now).
 * This makes a single-client session behave identically to a baseline session
 * with no explicit authority handshake — the lone client is trivially the driver.
 * A `session/permission` on an unclaimed seat does NOT auto-claim (you cannot
 * answer a permission you were never seated to author).
 *
 * Otherwise the op is allowed IFF `clientId` is the current driver; a non-driver
 * is denied with `{ ok:false, error:"not_driver" }`. The returned `op` echoes
 * which op was authorized (so a multiplexing route can branch on it).
 */
export function authorize(
	presence: DriverPresence,
	op: AuthorizedOp,
	clientId: string,
	ts: number = Date.now(),
): AuthorizeResult {
	// N=1 solo: an unclaimed seat is auto-claimed by the first DRIVER-ELECTING authorizer.
	if (presence.currentDriver() === null && DRIVER_ELECTING_OPS.has(op)) {
		presence.claim(clientId, ts);
	}
	const driver = presence.currentDriver();
	if (driver === clientId) {
		return { ok: true, op, driver };
	}
	return { ok: false, op, error: "not_driver", driver };
}
