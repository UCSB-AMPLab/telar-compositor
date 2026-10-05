/**
 * The operation lease: which publish, upgrade or objects commit is running on
 * a project, as the Durable Object records it.
 *
 * A lease does two things while it stands. No other publish or upgrade may
 * begin, so the second person is told who is working instead of being refused
 * with a moved head after the fact. And collaborators' editors wait: a
 * publish reads the site's content to build its commit and again afterwards
 * to record what it published, so an edit landing between the two would be
 * recorded as published without being committed. A lease covers only the
 * requests that read and rewrite the site — a publish's snapshot and commit,
 * an upgrade's prepare and commit — and ends when the commit has landed,
 * never waiting on the Actions build behind it. Only the publish and upgrade
 * actions start, renew or end a lease, through a signed internal request made
 * after their own role checks; a client is told about a lease and cannot
 * assert one.
 *
 * Every lease expires on its own. Those requests take seconds, so the window
 * matters only for a request that died before it could end its lease: past
 * `LEASE_PHASE_MS` from its start or last renewal, and never past
 * `LEASE_MAX_MS`, the lease lifts without anyone ending it.
 *
 * Clients are sent the time a lease has left, never when it ends: they do not
 * share the server's clock, and a deadline read against a clock an hour out
 * would lift the freeze at once or never.
 *
 * @version v1.5.0-beta
 */

/**
 * `objects` is the Objects page's commit of new objects. It takes
 * part in the lock, so no publish or upgrade begins during it and it begins
 * during neither, but collaborators' editors do not wait on it: it reads only
 * objects, and records nothing as published, so an edit landing during it is
 * kept in the document for the next publish. Its end is not replayed to
 * reconnecting clients, since nothing acts on it, and the replay's slots are
 * for the ends a client does act on.
 */
export type LeaseKind = "publish" | "upgrade" | "objects";
export type LeaseOutcome = "succeeded" | "failed";

/**
 * Five minutes. A publish's snapshot and commit, and an upgrade's prepare and
 * commit, take seconds to a minute on a large site; the window clears that
 * comfortably, and is the most a class can lose to a request that died
 * holding it. A lease that runs out while its operation is genuinely running
 * lets a second one begin, and the expected-head check refuses whichever
 * commits second.
 */
export const LEASE_PHASE_MS = 5 * 60 * 1000;

/** Fifteen minutes: the longest any operation may hold a lease, renewals included. */
export const LEASE_MAX_MS = 15 * 60 * 1000;

export interface Lease {
  /** A public number for this operation, so a client can match its end to its start. */
  rev: number;
  kind: LeaseKind;
  userId: number;
  startedAt: number;
  expiresAt: number;
}

export interface EndedLease {
  rev: number;
  kind: LeaseKind;
  userId: number;
  outcome: LeaseOutcome;
  endedAt: number;
}

/**
 * Ten minutes, and ten entries: how long, and how many, ended operations are
 * replayed to a socket on admission. A client that was disconnected when an
 * upgrade finished learns of it only this way, and a reconnect after longer
 * than this is a page that has other reasons to reload.
 */
export const ENDED_KEEP_MS = 10 * 60 * 1000;
export const ENDED_KEEP_COUNT = 10;

/** Everything a Durable Object stores about the freeze. */
export interface LeaseState {
  /** Live leases, keyed by operation id. */
  leases: Record<string, Lease>;
  ended: EndedLease[];
  nextRev: number;
}

export const EMPTY_LEASE_STATE: LeaseState = { leases: {}, ended: [], nextRev: 1 };

/** One request to change the state, as the signed control text names it. */
export type LeaseControl =
  | { op: "begin"; kind: LeaseKind; operationId: string }
  | { op: "renew"; operationId: string }
  | { op: "end"; operationId: string; outcome: LeaseOutcome };

const OPERATION_ID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * The control a `/freeze` request's `control` parameter names, or null for
 * anything else. The same text is bound into the request's signature, so what
 * is parsed here is what the action signed.
 */
export function parseLeaseControl(text: string | null): LeaseControl | null {
  if (text === null) return null;
  const parts = text.split(":");
  const [op, a, b] = parts;
  if (op === "begin" && parts.length === 3 && (a === "publish" || a === "upgrade" || a === "objects") && OPERATION_ID.test(b)) {
    return { op, kind: a, operationId: b };
  }
  if (op === "renew" && parts.length === 2 && OPERATION_ID.test(a)) {
    return { op, operationId: a };
  }
  if (op === "end" && parts.length === 3 && OPERATION_ID.test(a) && (b === "succeeded" || b === "failed")) {
    return { op, operationId: a, outcome: b };
  }
  return null;
}

/** The control text for `control`, which the action signs and sends. */
export function leaseControlText(control: LeaseControl): string {
  if (control.op === "begin") return `begin:${control.kind}:${control.operationId}`;
  if (control.op === "renew") return `renew:${control.operationId}`;
  return `end:${control.operationId}:${control.outcome}`;
}

/** `state` without the leases that have run out, or the ended records that are too old, at `now`. */
export function pruneLeaseState(state: LeaseState, now: number): LeaseState {
  const leases: Record<string, Lease> = {};
  for (const [id, lease] of Object.entries(state.leases)) {
    if (lease.expiresAt > now) leases[id] = lease;
  }
  const ended = state.ended.filter((e) => now - e.endedAt < ENDED_KEEP_MS).slice(-ENDED_KEEP_COUNT);
  return { leases, ended, nextRev: state.nextRev };
}

/**
 * Apply `control`, made by `userId`, at `now`; null when it is refused.
 *
 * Beginning requires that no other lease is live, of either kind and whoever
 * holds it: that is the lock. Renewing or ending a lease requires it to be
 * live and to belong to the same user. An operation id is never broadcast,
 * but it does travel through the
 * holder's page, and the user check is what keeps it useless to anyone else.
 */
export function applyLeaseControl(
  state: LeaseState,
  control: LeaseControl,
  userId: number,
  now: number,
): LeaseState | null {
  const next = pruneLeaseState(state, now);
  if (control.op === "begin") {
    if (Object.keys(next.leases).length > 0) return null;
    next.leases[control.operationId] = {
      rev: next.nextRev,
      kind: control.kind,
      userId,
      startedAt: now,
      expiresAt: now + LEASE_PHASE_MS,
    };
    next.nextRev += 1;
    return next;
  }
  const lease = next.leases[control.operationId];
  if (!lease || lease.userId !== userId) return null;
  if (control.op === "renew") {
    next.leases[control.operationId] = {
      ...lease,
      expiresAt: Math.min(now + LEASE_PHASE_MS, lease.startedAt + LEASE_MAX_MS),
    };
    return next;
  }
  delete next.leases[control.operationId];
  if (lease.kind === "objects") return next;
  next.ended = [
    ...next.ended,
    { rev: lease.rev, kind: lease.kind, userId: lease.userId, outcome: control.outcome, endedAt: now },
  ].slice(-ENDED_KEEP_COUNT);
  return next;
}

/** What a client is told: the live leases with the time each has left, and what ended recently. */
export interface LeaseFrame {
  leases: Array<{ rev: number; kind: LeaseKind; userId: number; remainingMs: number }>;
  ended: Array<{ rev: number; kind: LeaseKind; userId: number; outcome: LeaseOutcome }>;
}

export function leaseFrame(state: LeaseState, now: number): LeaseFrame {
  const live = pruneLeaseState(state, now);
  return {
    leases: Object.values(live.leases).map((lease) => ({
      rev: lease.rev,
      kind: lease.kind,
      userId: lease.userId,
      remainingMs: lease.expiresAt - now,
    })),
    ended: live.ended.map(({ rev, kind, userId, outcome }) => ({ rev, kind, userId, outcome })),
  };
}
