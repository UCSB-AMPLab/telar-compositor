/**
 * What a client makes of the freeze frames its Durable Object sends.
 *
 * The server holds the freeze (`workers/freeze-lease.ts`) and tells each
 * socket which leases stand, with the time each has left, and which
 * operations ended recently. This turns that into what the page shows: every
 * editor frozen while any lease of a kind stands, whoever holds it; the modal
 * and the error for a kind only for an operation another user holds; and a
 * reload when another user's upgrade has succeeded.
 *
 * Deadlines are local. A lease is kept until `receivedAt + remainingMs` on
 * this client's own clock, so it lifts without a server message and without
 * comparing clocks with anyone.
 *
 * An ended operation is acted on only when this page saw it active. That is
 * what makes a replayed end safe: a page that has just reloaded for an
 * upgrade saw nothing active, so the same end, replayed on its admission,
 * cannot reload it again.
 *
 * @version v1.5.0-beta
 */

/** The kinds of lease that freeze collaborators' editors. */
export type FreezeKind = "publish" | "upgrade";
/**
 * Every kind of lease, for the lock: an `objects` lease stops a publish or
 * upgrade from beginning, and freezes nothing (`workers/freeze-lease.ts`).
 */
export type LockKind = FreezeKind | "objects";
export type FreezeOutcome = "succeeded" | "failed";

/** The frame as the server sends it. */
export interface FreezeFrame {
  leases: Array<{ rev: number; kind: LockKind; userId: number; remainingMs: number }>;
  ended: Array<{ rev: number; kind: LockKind; userId: number; outcome: FreezeOutcome }>;
}

export interface FreezeView {
  leases: Array<{ rev: number; kind: LockKind; userId: number; deadline: number }>;
  /** Revisions this page has seen active and held by another user. */
  seen: ReadonlySet<number>;
  /** Ended revisions this page has already acted on. */
  handled: ReadonlySet<number>;
  errors: Readonly<Record<FreezeKind, boolean>>;
  /** Another user's upgrade this page saw running has succeeded. */
  upgradeSucceeded: boolean;
}

export const EMPTY_FREEZE_VIEW: FreezeView = {
  leases: [],
  seen: new Set(),
  handled: new Set(),
  errors: { publish: false, upgrade: false },
  upgradeSucceeded: false,
};

const KINDS: readonly LockKind[] = ["publish", "upgrade", "objects"];
const isFreezeKind = (kind: LockKind): kind is FreezeKind => kind !== "objects";
const OUTCOMES: readonly FreezeOutcome[] = ["succeeded", "failed"];

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * The frame in `json`, or null when it is not one. Entries that are not
 * well-formed are dropped rather than failing the frame.
 */
export function parseFreezeFrame(json: string): FreezeFrame | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(raw) || !Array.isArray(raw.leases) || !Array.isArray(raw.ended)) return null;
  const leases = raw.leases.filter(
    (l): l is FreezeFrame["leases"][number] =>
      isRecord(l) && isCount(l.rev) && KINDS.includes(l.kind as LockKind) &&
      isCount(l.userId) && isCount(l.remainingMs),
  );
  const ended = raw.ended.filter(
    (e): e is FreezeFrame["ended"][number] =>
      isRecord(e) && isCount(e.rev) && KINDS.includes(e.kind as LockKind) &&
      isCount(e.userId) && OUTCOMES.includes(e.outcome as FreezeOutcome),
  );
  return { leases, ended };
}

/** `view` updated with `frame`, received at `now` by the user `me`. */
export function applyFreezeFrame(
  view: FreezeView,
  frame: FreezeFrame,
  me: number | null,
  now: number,
): FreezeView {
  const seen = new Set(view.seen);
  const handled = new Set(view.handled);
  const errors = { ...view.errors };
  let upgradeSucceeded = view.upgradeSucceeded;

  for (const lease of frame.leases) {
    if (lease.userId === me || seen.has(lease.rev)) continue;
    seen.add(lease.rev);
    // A new operation of a kind supersedes an older one's failure.
    if (isFreezeKind(lease.kind)) errors[lease.kind] = false;
  }
  for (const end of frame.ended) {
    if (end.userId === me || !seen.has(end.rev) || handled.has(end.rev)) continue;
    handled.add(end.rev);
    if (!isFreezeKind(end.kind)) continue;
    if (end.outcome === "failed") errors[end.kind] = true;
    else if (end.kind === "upgrade") upgradeSucceeded = true;
  }

  return {
    leases: frame.leases.map(({ rev, kind, userId, remainingMs }) => ({
      rev,
      kind,
      userId,
      deadline: now + remainingMs,
    })),
    seen,
    handled,
    errors,
    upgradeSucceeded,
  };
}

/** `view` without the leases whose deadline has passed at `now`. */
export function expireFreeze(view: FreezeView, now: number): FreezeView {
  const leases = view.leases.filter((lease) => lease.deadline > now);
  return leases.length === view.leases.length ? view : { ...view, leases };
}

/** The nearest deadline still ahead, or null when nothing stands. */
export function nextFreezeDeadline(view: FreezeView): number | null {
  return view.leases.reduce<number | null>(
    (nearest, lease) => (nearest === null || lease.deadline < nearest ? lease.deadline : nearest),
    null,
  );
}

export function dismissFreezeError(view: FreezeView, kind: FreezeKind): FreezeView {
  return view.errors[kind] ? { ...view, errors: { ...view.errors, [kind]: false } } : view;
}

export interface FreezeReading {
  /** Every editor is read-only: some lease of this kind stands, whoever holds it. */
  frozen: boolean;
  /** The modal shows: a lease of this kind stands that another user holds. */
  heldByOther: boolean;
  /** Who holds that lease, for the line on a waiting button; null when no other user does. */
  heldBy: number | null;
  error: boolean;
}

/** Who else holds a lease of `kind`, for the line on a waiting button; null when no other user does. */
export function readLockHolder(view: FreezeView, kind: LockKind, me: number | null): number | null {
  return view.leases.find((lease) => lease.kind === kind && lease.userId !== me)?.userId ?? null;
}

export function readFreezeView(view: FreezeView, kind: FreezeKind, me: number | null): FreezeReading {
  const ofKind = view.leases.filter((lease) => lease.kind === kind);
  return {
    frozen: ofKind.length > 0,
    heldByOther: ofKind.some((lease) => lease.userId !== me),
    heldBy: ofKind.find((lease) => lease.userId !== me)?.userId ?? null,
    error: view.errors[kind],
  };
}
