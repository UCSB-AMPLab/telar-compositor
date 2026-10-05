/**
 * usePersistenceHalt — the client trigger behind the site-status pill's halted
 * state, and the convenor's restore action.
 *
 * A refused upgrade reaches the browser as a closed socket with no body, and
 * `y-websocket` reconnects on any close with a backoff capped at 2.5 seconds, so
 * the connection pill can sit at "connecting" indefinitely and cannot tell a
 * halt from an outage. This hook asks. It reads `/api/persistence` only after a
 * continuous disconnection has lasted long enough to be worth a durable-object
 * round trip, and it stops asking the moment it has an answer.
 *
 * The rules it keeps, each of which a simpler version gets wrong:
 *
 *   - **Everything remembered belongs to one project.** The halt, the confirmed
 *     generation, the outcome and the pending action are all stored under the
 *     project id they were read for, and a tab that selects another project
 *     starts from nothing. A confirmation is submitted for the project it was
 *     read for and for no other, so a restore shown for one project can never
 *     be applied to the one another tab has since selected.
 *   - **What clears the halt.** Only the generation handshake, exposed by the
 *     collaboration context as `admissionEpoch`. `connected` is not proof: a
 *     client at a stale generation is admitted temporarily just to receive the
 *     reset frame. A `halted: false` read is not proof either — it says there is
 *     no durable marker for the current generation, not that the document can
 *     load, and a reset that advanced the generation and failed its rebuild
 *     leaves exactly that, with the convenor still needing the action.
 *     Admission also discards what was read before it, so a halt reported for
 *     the generation the reset replaced cannot be shown as a fresh one.
 *   - **A halt raised again is proved, not inferred.** `haltedAgain` needs a
 *     read that reports `halted: true` at a generation above the one the
 *     restore was confirmed for; anything less is the state the restore
 *     replaced.
 *   - **One scheduler admits every read.** `scheduleRead` checks the teardown
 *     flag and the read in flight, and is the only caller of the fetch. At most
 *     one read is in flight, identified by its token rather than by a shared
 *     boolean, so a completion cannot release a newer read's slot. A request a
 *     person made while another read or the action was in flight is remembered
 *     and runs once; an interval tick is dropped, because the interval asks
 *     again on its own.
 *   - **One ordering policy over every read**, the action's returned readback
 *     included. Each read carries a token issued when it is sent; a response is
 *     dropped when its token is older than the latest applied one or when the
 *     identity it was sent under (project, provider, admission epoch) has
 *     changed. Submitting the action issues the next token to its readback and
 *     invalidates every older read, so a delayed `halted: true` cannot reinstall
 *     a halt that admission already cleared, and a popover read that captured
 *     generation G cannot overwrite a readback that confirmed G+1.
 *   - **The outcome is not the snapshot.** What the reset did is kept and
 *     rendered independently of what the state read says, so an admission or a
 *     provider replacement arriving before the response obsoletes the snapshot
 *     and never the outcome. It is dismissed when the reader has seen it and
 *     closed the popover, which is what gives the other six bodies their turn.
 *   - **The clock is a disconnection clock.** It starts at the first close after
 *     the provider's creation, is not restarted by the `connecting` events every
 *     backoff retry fires, and stops at admission.
 *
 * @version v1.5.0-beta
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import type {
  PersistenceStateAnswer,
  ResetOutcome,
} from "~/routes/api.persistence";

/** How long a connection must be down before the first read is worth making. */
const DISCONNECTION_GRACE_MS = 5_000;
/** The gap between reads while a disconnection continues, before jitter. */
const READ_INTERVAL_MS = 30_000;
/** The upper bound of the jitter added to each gap. */
const READ_JITTER_MS = 5_000;

/**
 * The jitter, behind an indirection so a timing test can stub it to zero.
 * Spreading the reads keeps a project's tabs from waking its object together.
 */
export const persistenceReadJitter = {
  next: () => Math.random() * READ_JITTER_MS,
};

/** A halt as the client remembers it, for as long as nothing has cleared it. */
export interface HaltSnapshot {
  projectId: number;
  reason: string | null;
  at: number | null;
  generation: number | null;
}

export interface PersistenceHaltResult {
  /** Whether a halt is remembered. This is what the pill's state derives from. */
  halted: boolean;
  lastKnownHalt: HaltSnapshot | null;
  /** The last read failed or the object could not answer. Popover-only. */
  stateUnreadable: boolean;
  /** The generation of the last successful read, whatever that read answered. */
  confirmedGeneration: number | null;
  /**
   * What the last applied read answered, or null when there has been none this
   * client could read since the last thing that obsoleted it.
   */
  lastReadHalted: boolean | null;
  /**
   * A read reports a halt at a generation above the one the restore was
   * confirmed for: the rebuild raised a halt of its own rather than the restore
   * having failed to clear the old one.
   */
  haltedAgain: boolean;
  /** What the last restore attempt did, kept apart from the state snapshot. */
  outcome: ResetOutcome | null;
  submitting: boolean;
  checkAgain: () => void;
  restore: (generation: number) => void;
  dismissOutcome: () => void;
}

/** The tuple a response has to still belong to before it may be applied. */
interface ReadIdentity {
  projectId: number | null;
  provider: unknown;
  admissionEpoch: number;
}

/** A read as the applier sees it: an answer, or the fact that there is none. */
type ReadResult = { readable: false } | { readable: true; answer: PersistenceStateAnswer };

/**
 * Why a read is being asked for.
 *
 * An interval tick is dropped while something else is in flight, since the
 * interval will come round again; a request a person made is remembered, and
 * runs once as soon as the slot is free.
 */
type ReadReason = "interval" | "requested";

/** Everything remembered about one project, and nothing about any other. */
interface HaltState {
  /** The project every field below was read for. */
  projectId: number | null;
  lastKnownHalt: HaltSnapshot | null;
  stateUnreadable: boolean;
  confirmedGeneration: number | null;
  lastReadHalted: boolean | null;
  /** The generation the restore in flight, or the last one, was confirmed for. */
  resetGeneration: number | null;
  outcome: ResetOutcome | null;
  /** A restore has been submitted and its answer has not arrived. */
  pending: boolean;
}

const NOTHING_KNOWN: HaltState = {
  projectId: null,
  lastKnownHalt: null,
  stateUnreadable: false,
  confirmedGeneration: null,
  lastReadHalted: null,
  resetGeneration: null,
  outcome: null,
  pending: false,
};

/** Whether an action's `state` field carried a readable answer. */
function readResultOf(
  state: PersistenceStateAnswer | { unreadable: true } | undefined,
): ReadResult {
  if (state === undefined || "unreadable" in state) return { readable: false };
  return { readable: true, answer: state };
}

/** Whether a response's identity differs from the current one. */
function identityChanged(sent: ReadIdentity, now: ReadIdentity): boolean {
  return (
    sent.projectId !== now.projectId ||
    sent.provider !== now.provider ||
    sent.admissionEpoch !== now.admissionEpoch
  );
}

/** Whether the read reported a halt still in force — the only case that stops the clock. */
function readReportsHalt(result: ReadResult): boolean {
  return result.readable && result.answer.halted === true;
}

/** The state one applied read result produces, folded onto the last one. */
function nextStateFor(prev: HaltState, projectId: number, result: ReadResult): HaltState {
  const scoped = prev.projectId === projectId ? prev : { ...NOTHING_KNOWN, projectId };
  if (!result.readable || result.answer.halted === null) {
    // The generation goes with the failed read. A confirm has to carry a
    // generation the object confirmed, or a refused restore would be
    // resent against the same stale number for as long as reads keep
    // failing.
    return { ...scoped, stateUnreadable: true, confirmedGeneration: null, lastReadHalted: null };
  }
  const { halted, reason, at, generation } = result.answer;
  const confirmedGeneration = generation ?? null;
  if (!halted) {
    return { ...scoped, stateUnreadable: false, confirmedGeneration, lastReadHalted: false };
  }
  return {
    ...scoped,
    lastKnownHalt: {
      projectId: result.answer.projectId,
      reason: reason ?? null,
      at: at ?? null,
      generation: confirmedGeneration,
    },
    stateUnreadable: false,
    confirmedGeneration,
    lastReadHalted: true,
  };
}

/**
 * Admission is proof the document is served, so the halt and every read taken
 * before it describe a project state the admission supersedes. The confirmed
 * generation survives: it is a number the object gave, and the convenor may
 * still need it if the connection drops again.
 */
function clearedByAdmission(prev: HaltState): HaltState {
  if (prev.lastKnownHalt === null && !prev.stateUnreadable && prev.lastReadHalted === null) {
    return prev;
  }
  return { ...prev, lastKnownHalt: null, stateUnreadable: false, lastReadHalted: null };
}

/** Whether the state read since the restore proves a halt the restore did not clear. */
function provesHaltAgain(state: HaltState): boolean {
  return (
    state.lastReadHalted === true &&
    state.resetGeneration !== null &&
    state.confirmedGeneration !== null &&
    state.confirmedGeneration > state.resetGeneration
  );
}

export function usePersistenceHalt(projectId: number | null): PersistenceHaltResult {
  const { provider, admissionEpoch } = useCollaborationContext();

  const [stored, setStored] = useState<HaltState>(NOTHING_KNOWN);
  // Everything read for another project is discarded on sight, so a render that
  // precedes the effect below never hands the popover another project's halt.
  const state = stored.projectId === projectId ? stored : NOTHING_KNOWN;

  const identity = useRef<ReadIdentity>({ projectId, provider, admissionEpoch });
  identity.current = { projectId, provider, admissionEpoch };
  const stateRef = useRef<HaltState>(state);
  stateRef.current = state;

  const seq = useRef(0);
  const applied = useRef(0);
  /** The token of the read in flight, or null. A boolean cannot tell two apart. */
  const inFlight = useRef<number | null>(null);
  const submitting = useRef(false);
  const queued = useRef(false);
  const clockStarted = useRef(false);
  const stopped = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const live = useRef(true);
  const scheduleRef = useRef<(reason: ReadReason) => void>(() => {});

  const clearTimer = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  /** Apply one answer, or drop it: the single gate every read passes through. */
  const apply = useCallback(
    (token: number, sent: ReadIdentity, result: ReadResult) => {
      if (!live.current || sent.projectId === null) return;
      if (identityChanged(sent, identity.current)) return;
      if (token < applied.current) return;
      applied.current = token;

      // An answer that still reports a halt is where the reads have done their
      // work; the state now holds until admission, and the popover's Check
      // again is the one way to refresh it.
      if (readReportsHalt(result)) {
        stopped.current = true;
        clearTimer();
      }
      const target = sent.projectId;
      setStored((s) => nextStateFor(s, target, result));
    },
    [clearTimer],
  );

  /** Hand the queue its turn once nothing is in flight. */
  const drainQueue = useCallback(() => {
    if (!queued.current) return;
    queued.current = false;
    scheduleRef.current("requested");
  }, []);

  const readNow = useCallback(async () => {
    const sent = { ...identity.current };
    if (sent.projectId === null) return;
    const token = (seq.current += 1);
    inFlight.current = token;
    let result: ReadResult = { readable: false };
    try {
      const response = await fetch(`/api/persistence?projectId=${sent.projectId}`);
      if (response.ok) {
        result = { readable: true, answer: (await response.json()) as PersistenceStateAnswer };
      }
    } catch {
      // A read that could not be made is a state that could not be read.
    }
    // Only this read's own slot is released: a completion whose token is not
    // the one in flight must not open the gate for the read that is.
    if (inFlight.current === token) inFlight.current = null;
    apply(token, sent, result);
    drainQueue();
  }, [apply, drainQueue]);

  /**
   * The one admission point for a read. Teardown and the read in flight are
   * checked here and nowhere else, so no caller can start a second GET.
   */
  const scheduleRead = useCallback(
    (reason: ReadReason) => {
      if (!live.current) return;
      if (inFlight.current !== null || submitting.current) {
        if (reason !== "interval") queued.current = true;
        return;
      }
      void readNow();
    },
    [readNow],
  );
  scheduleRef.current = scheduleRead;

  /** Arm the next read. Re-arms itself, so the interval survives a slow read. */
  const schedule = useCallback(
    (delay: number) => {
      clearTimer();
      timer.current = setTimeout(() => {
        timer.current = null;
        if (!live.current || stopped.current) return;
        scheduleRead("interval");
        schedule(READ_INTERVAL_MS + persistenceReadJitter.next());
      }, delay);
    },
    [clearTimer, scheduleRead],
  );

  // The disconnection clock. It is armed by the first close after this
  // provider's creation and by a `disconnected` status; the `connecting` events
  // a backoff retry fires reach it and change nothing.
  useEffect(() => {
    live.current = true;
    if (typeof window === "undefined" || !provider || projectId === null) return;
    clockStarted.current = false;
    stopped.current = false;

    const start = () => {
      if (clockStarted.current || stopped.current) return;
      clockStarted.current = true;
      schedule(DISCONNECTION_GRACE_MS);
    };
    const onStatus = (event: { status: string }) => {
      if (event.status === "disconnected") start();
    };
    const target = provider as unknown as {
      on: (event: string, fn: (...args: never[]) => void) => void;
      off: (event: string, fn: (...args: never[]) => void) => void;
    };
    target.on("connection-close", start as (...args: never[]) => void);
    target.on("status", onStatus as (...args: never[]) => void);

    return () => {
      target.off("connection-close", start as (...args: never[]) => void);
      target.off("status", onStatus as (...args: never[]) => void);
      clearTimer();
    };
  }, [provider, projectId, schedule, clearTimer]);

  useEffect(() => () => { live.current = false; }, []);

  // A project the tab has stopped showing takes its halt, its confirmation and
  // its outcome with it.
  useEffect(() => {
    setStored((s) => (s.projectId === projectId ? s : NOTHING_KNOWN));
  }, [projectId]);

  // Admission: the document is being served, so the halt is over and the clock
  // has nothing left to measure. A later disconnection arms it again.
  useEffect(() => {
    if (admissionEpoch === 0) return;
    clearTimer();
    clockStarted.current = false;
    stopped.current = false;
    setStored(clearedByAdmission);
  }, [admissionEpoch, clearTimer]);

  const checkAgain = useCallback(() => scheduleRead("requested"), [scheduleRead]);

  const dismissOutcome = useCallback(() => {
    setStored((s) => (s.outcome === null ? s : { ...s, outcome: null }));
  }, []);

  const restore = useCallback(
    (generation: number) => {
      if (submitting.current) return;
      // The project posted is the one the confirmation was read for, never the
      // one the tab happens to be on now.
      const target = stateRef.current.projectId;
      if (target === null || target !== identity.current.projectId) {
        console.warn(
          `[persistence-halt] restore not sent: the confirmation was read for project ` +
          `${target}, and this tab is on ${identity.current.projectId}`,
        );
        return;
      }
      const sent = { ...identity.current };
      submitting.current = true;
      setStored((s) => ({ ...s, projectId: target, resetGeneration: generation, pending: true }));
      // The readback's token is issued now, so every read already in flight is
      // older than it and cannot overwrite what the action comes back with.
      const token = (seq.current += 1);
      applied.current = token;

      void (async () => {
        const { reset, state: readback } = await submitReset(target, generation);
        submitting.current = false;
        // The outcome is kept whatever the provider or the admission epoch has
        // done since, because it is what the convenor asked for and the answer
        // to it exists. Only a change of project retires it.
        if (live.current) {
          setStored((s) => (s.projectId !== target ? s : { ...s, pending: false, outcome: reset }));
        }
        apply(token, sent, readback);
        drainQueue();
      })();
    },
    [apply, drainQueue],
  );

  return {
    halted: state.lastKnownHalt !== null,
    lastKnownHalt: state.lastKnownHalt,
    stateUnreadable: state.stateUnreadable,
    confirmedGeneration: state.confirmedGeneration,
    lastReadHalted: state.lastReadHalted,
    haltedAgain: provesHaltAgain(state),
    outcome: state.outcome,
    submitting: state.pending,
    checkAgain,
    restore,
    dismissOutcome,
  };
}

/** One reset, and what came back: the outcome and the readback beside it. */
async function submitReset(
  projectId: number,
  generation: number,
): Promise<{ reset: ResetOutcome; state: ReadResult }> {
  try {
    const body = new FormData();
    body.set("intent", "reset");
    body.set("projectId", String(projectId));
    body.set("expectedGeneration", String(generation));
    const response = await fetch("/api/persistence", { method: "POST", body });
    if (!response.ok) {
      return {
        reset: { kind: "failed", status: response.status, body: await response.text() },
        state: { readable: false },
      };
    }
    const report = (await response.json()) as {
      reset: ResetOutcome;
      state: PersistenceStateAnswer | { unreadable: true };
    };
    return { reset: report.reset, state: readResultOf(report.state) };
  } catch {
    // A throw does not prove the reset did not land.
    return { reset: { kind: "uncertain" }, state: { readable: false } };
  }
}
