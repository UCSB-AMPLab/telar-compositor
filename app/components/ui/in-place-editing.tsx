/**
 * What InPlaceText and InPlaceMarkdown share: the switch between a rendered
 * block and the field that edits it, who owns the draft, and the block.
 *
 * The wrapper owns the draft. It holds the collaborative binding and hands
 * it to the field, so text typed before the Y.Text connects is kept in the
 * wrapper's state, not the field's, and is still there when the field
 * closes and when it opens again, before any loader has revalidated. A
 * value arriving from the loader replaces the draft only when nothing is
 * waiting to be saved.
 *
 * With `onSave`, finishing the field saves the draft first and closes only
 * once the save has succeeded. A save that fails keeps the field open with
 * the draft in it and the error under it. Unmounting while a changed draft
 * is open sends the save rather than losing it. With a Y.Text the text is
 * saved as it is typed, and the field just closes.
 *
 * A draft belongs to one target (`target`) and one binding. When the target
 * changes, an open draft is left to the target it was written for, with
 * that target's own save, and the new target starts from its own value.
 * When a Y.Text arrives for the same target, collaboration takes over: the
 * shared text is the value, and the draft typed before it is dropped, not
 * saved over it. A save still in flight when either happens resolves
 * against its own target and changes nothing on screen.
 *
 * What a target holds and what is wanted for it live in one record per
 * target (target-saves.ts), shared by every generation and instance: saves
 * to a target run one at a time, always of the latest value wanted, and a
 * field closes only once the text it shows is the text stored.
 *
 * A draft left behind whose save fails, by a field that went before its
 * save landed, is kept for its target (target-saves.ts, `recordRecovered`).
 * The next time a field for that target opens, the draft is in it, with the
 * error and Retry and Discard beneath. Opening it asks for nothing: it is
 * saved only by Retry or by the author editing and finishing, as any draft
 * is. A save of it that succeeds forgets it, and so does Discard, which
 * closes the field on the value the target holds; while any save for the
 * target is out, from this field or another, Discard does nothing, since
 * that save would land after it and could store the text thrown away. Each
 * field forgets only the draft it showed, never a later one recorded in its
 * place. Closing it unedited shows that value and keeps the draft for the
 * next opening. It is kept even if another field stores a newer value
 * meanwhile, so that the author, not the order the saves landed in, decides
 * between them. While a draft waits, the closed block says so under its
 * value. A field with no target has nowhere to come back to, and keeps
 * nothing.
 *
 * The block is focusable. Enter or Space opens the field; Escape in the
 * field closes it and puts focus back on the block. A plain click on a link
 * in the block opens the field like any other click; a click with Cmd or
 * Ctrl held follows the link. An empty value shows the placeholder, muted.
 * Another author's presence on the field outlines the block as it outlines
 * the field.
 *
 * @version v1.5.0-beta
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import * as Y from "yjs";
import { useCollaborativeText, type CollaborativeText } from "~/hooks/use-collaborative-text";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import type { DoneReason } from "~/components/ui/InlineTextField";
import {
  clearRecovered,
  commit,
  nextStamp,
  isPending,
  recordRecovered,
  recoveredFor,
  subscribe,
  targetState,
  watchPending,
  watchRecovered,
  type RecoveredDraft,
  type SaveFn,
} from "~/components/ui/target-saves";

export interface InPlaceCommonProps {
  /**
   * What is being edited, such as a step's question. A change ends the draft
   * for the old target, saving it there, and starts the new one from its
   * value.
   */
  target?: unknown;
  yText: Y.Text | null;
  initialValue: string;
  /** Shown, muted, when the value is empty. */
  placeholder?: string;
  /** Awareness key, for another author's presence outline. */
  fieldKey?: string;
  defaultValues?: readonly string[];
  /**
   * Saves the draft when the field is finished; a rejection keeps it open.
   * Used only without a Y.Text: with one, the text is saved as it is typed.
   */
  onSave?: (value: string) => Promise<unknown> | unknown;
  /** Shown when `onSave` fails, in place of the error's own message. */
  saveErrorMessage?: string;
  /**
   * The project and target as one string, such as `project:12/step:340/question`.
   * A draft whose save fails after its field has gone is kept under it for
   * the tab's session; without it, it is kept in memory only.
   */
  recoveryKey?: string;
  /** Accessible name of the rendered block. */
  label?: string;
  /** Classes of the rendered block. */
  className?: string;
}

/** The colour of the first other author editing `fieldKey`, if any. */
export function usePresenceColour(fieldKey: string | undefined): string | null {
  const { remoteCollaborators } = useCollaborationContext();
  if (!fieldKey) return null;
  return remoteCollaborators.find((c) => c.location?.fieldKey === fieldKey)?.user.color ?? null;
}

export function presenceOutline(colour: string | null) {
  return colour ? { outline: `2px solid ${colour}`, outlineOffset: "-1px", borderRadius: "4px" } : undefined;
}

function messageOf(error: unknown, fallback?: string): string {
  if (fallback) return fallback;
  return error instanceof Error ? error.message : String(error);
}

export interface InPlaceEditing {
  binding: CollaborativeText;
  editing: boolean;
  open: () => void;
  done: (reason: DoneReason) => void;
  error: string | null;
  blockRef: React.RefObject<HTMLDivElement | null>;
  /** The draft whose save failed after its field had gone, shown in the open field. */
  recovered: RecoveredDraft | null;
  /** Saves the field's text as a finish does, whether or not it was edited. */
  retry: () => void;
  /**
   * Forgets the recovered draft and closes on the value the target holds.
   * Does nothing while `saving`: a save already sent would land after it.
   */
  discard: () => void;
  /** A save is wanted or in flight for the target, from this field or any other. */
  saving: boolean;
  /** Closed, the field's target has a recovered draft waiting to be opened. */
  waiting: boolean;
  /** Holds the recovered draft's controls: focus moving into it does not finish the field. */
  noticeRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * One stretch of editing a single target with a single binding. A new
 * generation starts when the target or the Y.Text changes. What the target
 * holds and what is wanted for it are not the generation's to know: they
 * are in the target's record (target-saves.ts), shared with every other
 * generation and instance editing it.
 */
interface Generation {
  target: unknown;
  yText: Y.Text | null;
  /** Reads the draft as this generation's binding holds it. */
  read: () => string;
  /** The save of the target this generation edits. */
  save?: SaveFn;
  /** Where a draft of this generation left behind is kept for the tab's session. */
  recoveryKey?: string;
  /**
   * The recovered draft the field opened on, while it has not closed: a save
   * of its text that succeeds, now or after the generation ends, forgets
   * that draft, and no later one recorded in its place.
   */
  shown: RecoveredDraft | null;
  /**
   * The value the target holds as far as this field knows: the newest, by
   * stamp, of the loader values it received and the values stored for it.
   */
  baseline: string;
  baselineAt: number;
  /** Set when the generation has ended, by a new one or by unmounting. */
  ended: boolean;
  /**
   * The edit count of this generation's commit still out, if one is.
   * Finishing again with no edit since (a blur after Escape, say) waits for
   * it rather than committing the same text as a newer revision, which
   * would put it after another field's later finish.
   */
  outstanding: number | null;
  /**
   * The edit count when the field opened, or when its text was last stored.
   * A field whose count has not moved since was only looked at, and asks
   * for nothing: looking at a field never writes to it.
   */
  quiet: number;
}

export function useInPlaceEditing({
  target,
  yText,
  initialValue,
  defaultValues,
  onSave,
  saveErrorMessage,
  recoveryKey,
}: InPlaceCommonProps): InPlaceEditing {
  const shared = useCollaborativeText(yText, initialValue, defaultValues);
  // Counts the author's edits: every change the field makes bumps it. A
  // commit's outcome is acted on only if no edit has come since it was
  // made; changes the wrapper makes itself (a loader value, an adopted
  // value) are not the author's and do not count.
  const edits = useRef(0);
  // Numbers the field's own commits. Only the latest one's outcome is acted
  // on: an older commit that resolves after the field committed again must
  // not finish again and resend its text over another field's later finish.
  const submissions = useRef(0);
  // The open field's settle (use-settle-shown-value.ts), which the owner runs
  // before it reads the draft: a close the field did not see (the chip's own
  // click, an unmount that runs the owner's cleanup first) would otherwise
  // read text a cancelled composition left in the binding.
  const settleField = useRef<(() => void) | null>(null);
  const settleOpenField = () => settleField.current?.();
  const binding = useMemo<CollaborativeText>(
    () => ({
      ...shared,
      registerSettle: (settle: () => void) => {
        settleField.current = settle;
        return () => {
          if (settleField.current === settle) settleField.current = null;
        };
      },
      handleChange: (value: string) => {
        edits.current += 1;
        shared.handleChange(value);
      },
    }),
    [shared],
  );
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovered, show] = useState<RecoveredDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const noticeRef = useRef<HTMLDivElement | null>(null);
  const blockRef = useRef<HTMLDivElement | null>(null);
  const returnFocus = useRef(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const errorMessageRef = useRef(saveErrorMessage);
  errorMessageRef.current = saveErrorMessage;
  // What this render asks for, read when a generation ends to tell a
  // replaced binding or target from an unmount.
  const latest = useRef({ target, yText });
  latest.current = { target, yText };
  // Records are kept by target; an instance with no target is its own.
  const ownKey = useRef({});
  const keyOf = (generation: Generation) => generation.target ?? ownKey.current;

  const startGeneration = (): Generation => {
    const generation: Generation = {
      target,
      yText,
      read: shared.currentValue,
      save: onSave,
      recoveryKey,
      baseline: shared.currentValue(),
      baselineAt: nextStamp(),
      ended: false,
      outstanding: null,
      quiet: edits.current,
      shown: null,
    };
    return generation;
  };
  const generationRef = useRef<Generation | null>(null);
  if (!generationRef.current) generationRef.current = startGeneration();

  // A generation per target and binding. Ending one leaves an open draft to
  // its target's record, except when collaboration takes over the same
  // target: the shared text is then the value, and the draft is dropped.
  useLayoutEffect(() => {
    const current = generationRef.current!;
    if (current.target !== target || current.yText !== yText) {
      const targetChanged = current.target !== target;
      if (!yText && targetChanged) shared.handleChange(initialValue);
      generationRef.current = startGeneration();
      show(null);
      if (targetChanged) {
        setError(null);
        setEditing(false);
      }
    }
    const generation = generationRef.current!;
    const key = keyOf(generation);
    // Strict Mode ends and restarts the same generation on mount.
    generation.ended = false;
    const unsubscribe = subscribe(key, (stored, stamp) => learn(generation, stored, stamp));
    const unwatch = watchPending(key, setSaving);
    return () => {
      unwatch();
      generation.ended = true;
      leaveDraft(generation, key);
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, yText]);

  /**
   * Takes a value the target holds, from the loader or a save, if it is
   * newer than the baseline. A closed field showing the old baseline shows
   * the new one; a field showing anything else, open or holding a draft that
   * was never saved, keeps it.
   */
  function learn(generation: Generation, value: string, stamp: number) {
    if (stamp <= generation.baselineAt) return;
    const showing = !editingRef.current && generation.read() === generation.baseline;
    generation.baseline = value;
    generation.baselineAt = stamp;
    if (showing) shared.handleChange(value);
  }

  /**
   * An open draft left behind, by unmounting or by a change of target, goes
   * to its target's record unless the author never edited it since the
   * field opened, the field committed it already with no edit since, or it
   * is what the target will hold once its saves land.
   * Equality with a save in flight is not enough: a later value desired
   * behind that save would land over it. Nobody is left to show a failure,
   * so a failure is kept for the next field that opens on the target.
   */
  function leaveDraft(generation: Generation, key: unknown) {
    const next = latest.current;
    const unmounting = next.target === generation.target && next.yText === generation.yText;
    const takenOver = !unmounting && next.target === generation.target && !!next.yText;
    const save = generation.save;
    if (takenOver || generation.yText || !editingRef.current || !save) return;
    // A draft this field already committed, with no edit since, was asked
    // for then; leaving does not ask again, or it would land after another
    // field's later finish.
    if (generation.outstanding === edits.current) return;
    if (generation.quiet === edits.current) return;
    settleOpenField();
    const draft = generation.read();
    const state = targetState(key);
    if (draft === (state.desired ?? state.inflight ?? generation.baseline)) return;
    void commit(key, draft, save).then(
      () => forgetRecovered(generation),
      (err: unknown) => keepLeftBehind(generation, key, draft, err),
    );
  }

  /** Keeps a draft whose save failed after its generation ended, for the target's next opening. */
  function keepLeftBehind(generation: Generation, key: unknown, draft: string, err: unknown) {
    if (generation.target == null) return;
    recordRecovered(key, generation.recoveryKey, draft, messageOf(err, errorMessageRef.current));
  }

  // The generation saves to the target's current callback.
  useLayoutEffect(() => {
    generationRef.current!.save = onSave;
    generationRef.current!.recoveryKey = recoveryKey;
  });

  // Each loader value is received, stamped, as a baseline, whether or not the
  // field is open.
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (yText || loaded.current === initialValue) return;
    const first = loaded.current === null;
    loaded.current = initialValue;
    if (first) return;
    learn(generationRef.current!, initialValue, nextStamp());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialValue, yText]);

  const close = useCallback((reason: DoneReason) => {
    returnFocus.current = reason === "escape";
    generationRef.current!.shown = null;
    setError(null);
    show(null);
    setEditing(false);
  }, []);

  /** The recovered draft's text, or a later one, is stored: nothing is left to recover. */
  function forgetRecovered(generation: Generation) {
    if (!generation.shown) return;
    clearRecovered(keyOf(generation), generation.recoveryKey, generation.shown.id);
    generation.shown = null;
  }

  /**
   * A field opened and never edited asks for nothing: finishing it commits
   * nothing, and it closes once any commit it is already waiting on
   * settles, or at once. Otherwise, finishing closes at once only when the
   * draft is what the target holds
   * and nothing is desired or in flight for it; a pending save of the same
   * text is not a stored one. Otherwise the draft is committed and the field
   * closes when that commit resolves, on the text the target then holds: its
   * own, or a later field's that superseded it, which the field then shows.
   * Any edit made meanwhile, even one that returns to the same text, means
   * the field finishes again with what it holds, so an author's resumed
   * typing is never replaced by another field's value. Only the field's
   * latest commit is acted on. A rejection keeps the field open with the
   * error; a rejection that arrives after the generation ended is kept as a
   * recovered draft.
   */
  const finish = useCallback(
    (reason: DoneReason) => {
      const generation = generationRef.current!;
      if (!editingRef.current) return;
      const save = generation.save;
      if (generation.yText || !save) {
        close(reason);
        return;
      }
      const key = keyOf(generation);
      settleOpenField();
      const draft = generation.read();
      const state = targetState(key);
      if (generation.outstanding === edits.current) return;
      // Opened and never edited: nothing is asked for. The field shows the
      // newest value the target is known to hold, and closes.
      if (generation.quiet === edits.current) {
        if (generation.baseline !== draft) shared.handleChange(generation.baseline);
        close(reason);
        return;
      }
      if (state.desired === undefined && state.inflight === undefined && draft === generation.baseline) {
        forgetRecovered(generation);
        close(reason);
        return;
      }
      const submitted = edits.current;
      const submission = ++submissions.current;
      generation.outstanding = submitted;
      // A new attempt is under way; an earlier failure no longer describes it.
      setError(null);
      commit(key, draft, save).then(
        () => {
          if (generation.ended) forgetRecovered(generation);
          if (generation.ended || submission !== submissions.current) return;
          generation.outstanding = null;
          // The author has edited since, even back to the same text: finish
          // again with what the field holds now, rather than adopt or close.
          if (edits.current !== submitted) {
            finish(reason);
            return;
          }
          // The target now holds this field's text or a later one; the
          // newest is the baseline.
          if (generation.baseline !== draft) shared.handleChange(generation.baseline);
          generation.quiet = edits.current;
          forgetRecovered(generation);
          close(reason);
        },
        (err: unknown) => {
          // The field went before its save failed: nobody is left to show it.
          if (generation.ended) {
            keepLeftBehind(generation, key, draft, err);
            return;
          }
          if (submission !== submissions.current) return;
          generation.outstanding = null;
          const message = messageOf(err, errorMessageRef.current);
          setError(message);
          // A recovered draft that fails again is kept with its new error.
          if (generation.shown) {
            generation.shown = recordRecovered(key, generation.recoveryKey, draft, message);
            show(generation.shown);
          }
        },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [close, shared],
  );

  /**
   * Finishes the field. While a recovered draft is shown, a blur is judged
   * once focus has settled: focus moving to Retry or Discard is not the
   * author finishing.
   */
  const done = useCallback(
    (reason: DoneReason) => {
      const generation = generationRef.current!;
      if (reason !== "blur" || !generation.shown) {
        finish(reason);
        return;
      }
      setTimeout(() => {
        if (generation.ended || generationRef.current !== generation) return;
        if (noticeRef.current?.contains(document.activeElement)) return;
        finish(reason);
      }, 0);
    },
    [finish],
  );

  // Retry is the author asking for the text, as an edit is.
  const retry = useCallback(() => {
    edits.current += 1;
    finish("escape");
  }, [finish]);

  const discard = useCallback(() => {
    const generation = generationRef.current!;
    const key = keyOf(generation);
    // A save already sent for the target, by this field or another showing
    // the same draft, cannot be taken back, and landing after Discard it
    // would store the text the author threw away.
    if (isPending(key)) return;
    if (generation.shown) clearRecovered(key, generation.recoveryKey, generation.shown.id);
    generation.shown = null;
    if (generation.read() !== generation.baseline) shared.handleChange(generation.baseline);
    generation.quiet = edits.current;
    close("escape");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [close, shared]);

  useEffect(() => {
    if (editing || !returnFocus.current) return;
    returnFocus.current = false;
    // A field that closes after its save lands may close long after the
    // Escape; focus goes back to the block only if it went nowhere else.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    blockRef.current?.focus();
  }, [editing]);

  /**
   * Opens the field, with the draft kept for its target if there is one.
   * A kept draft the target already holds is not lost, and is forgotten.
   */
  const open = useCallback(() => {
    const generation = generationRef.current!;
    generation.quiet = edits.current;
    let found: RecoveredDraft | null = null;
    if (!generation.yText && generation.save && generation.target != null) {
      const key = keyOf(generation);
      found = recoveredFor(key, generation.recoveryKey);
      if (found && found.draft === generation.baseline) {
        clearRecovered(key, generation.recoveryKey, found.id);
        found = null;
      }
    }
    generation.shown = found;
    show(found);
    if (found && generation.read() !== found.draft) shared.handleChange(found.draft);
    setEditing(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared]);

  // Whether a draft waits for the target, for the closed block to say so.
  const [waiting, setWaiting] = useState(false);
  const canRecover = !yText && !!onSave && target != null;
  useEffect(() => {
    if (!canRecover) {
      setWaiting(false);
      return;
    }
    const check = () => setWaiting(!!recoveredFor(target, recoveryKey));
    check();
    return watchRecovered(target, recoveryKey, check);
  }, [canRecover, target, recoveryKey]);

  return {
    binding,
    editing,
    open,
    done,
    error,
    blockRef,
    recovered,
    retry,
    discard,
    saving,
    waiting,
    noticeRef,
  };
}

interface InPlaceBlockProps {
  editing: InPlaceEditing;
  empty: boolean;
  placeholder?: string;
  label?: string;
  className?: string;
  fieldKey?: string;
  /**
   * The waiting draft's marker's id, for another control that opens the same
   * field to point at too.
   */
  markerId?: string;
  /** Points at the marker another block for the field draws, and draws none. */
  markerElsewhere?: boolean;
  children: ReactNode;
}

/** The rendered value: focusable, opened by a click, Enter or Space. */
export function InPlaceBlock({
  editing,
  empty,
  placeholder,
  label,
  className = "",
  fieldKey,
  markerId: sharedMarkerId,
  markerElsewhere = false,
  children,
}: InPlaceBlockProps) {
  const { t } = useTranslation("editor");
  const ownMarkerId = useId();
  const markerId = sharedMarkerId ?? ownMarkerId;
  const colour = usePresenceColour(fieldKey);
  const { isPublishing } = useCollaborationContext();
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const link = (event.target as Element).closest("a");
    if (link && (event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    if (!isPublishing) editing.open();
  };
  return (
    <div
      ref={editing.blockRef}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-disabled={isPublishing || undefined}
      aria-describedby={editing.waiting ? markerId : undefined}
      data-in-place=""
      data-empty={empty || undefined}
      data-recovered={editing.waiting || undefined}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (!isPublishing) editing.open();
      }}
      className={`cursor-text ${className}`}
      style={presenceOutline(colour)}
    >
      {empty ? <span className="text-gray-400">{placeholder}</span> : children}
      {editing.waiting && !markerElsewhere && (
        <span id={markerId} data-in-place-marker="" className="block font-body text-xs mt-1 text-terracotta">
          {t("in_place.recovered_marker")}
        </span>
      )}
    </div>
  );
}

/**
 * Under the open field: the error of a save that failed, or a recovered
 * draft's notice, its error, and Retry and Discard.
 */
export function InPlaceSaveError({ editing }: { editing: InPlaceEditing }) {
  if (editing.recovered) return <InPlaceRecoveredDraft editing={editing} />;
  if (!editing.error) return null;
  return (
    <p role="alert" data-testid="in-place-save-error" className="font-body text-xs mt-1 text-terracotta">
      {editing.error}
    </p>
  );
}

/**
 * The buttons keep focus in the field when pressed with a pointer, so the
 * press is not also a blur that finishes it. Focus leaving the notice for
 * anywhere but the field finishes the field.
 */
function InPlaceRecoveredDraft({ editing }: { editing: InPlaceEditing }) {
  const { t } = useTranslation("editor");
  const keepFocus = (event: MouseEvent) => event.preventDefault();
  return (
    <div
      ref={editing.noticeRef}
      data-testid="in-place-recovered"
      className="font-body text-xs mt-1"
      onBlur={(event) => {
        const to = event.relatedTarget as Node | null;
        if (to && event.currentTarget.parentElement?.contains(to)) return;
        editing.done("blur");
      }}
    >
      <p className="text-gray-600">{t("in_place.recovered_notice")}</p>
      <p role="alert" data-testid="in-place-save-error" className="text-terracotta">
        {editing.recovered?.error}
      </p>
      <div className="flex gap-3 mt-1">
        <button type="button" className="text-anil hover:underline" onMouseDown={keepFocus} onClick={editing.retry}>
          {t("in_place.recovered_retry")}
        </button>
        <button
          type="button"
          aria-disabled={editing.saving || undefined}
          className={`text-gray-600 ${editing.saving ? "opacity-50 cursor-not-allowed" : "hover:underline"}`}
          onMouseDown={keepFocus}
          onClick={editing.discard}
        >
          {t("in_place.recovered_discard")}
        </button>
      </div>
    </div>
  );
}
