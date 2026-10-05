/**
 * useKeptDraft — the text an author typed in a standalone Markdown field when
 * shared text replaced it unsaved, held for the Y.Text it was replaced by.
 *
 * Text whose save had not gone, or had failed, is offered at once. Text whose
 * save was out waits for that save's answer: offered if it fails, dropped if
 * it succeeds. The kept text belongs to its Y.Text: it is offered only while
 * the field shows that Y.Text, and waits while the field shows another. A save
 * answer settles only the kept text of the Y.Text its save was sent for.
 *
 * @version v1.5.0-beta
 */
import { useRef, useState } from "react";
import type * as Y from "yjs";

interface KeptDraft {
  text: string;
  target: Y.Text;
  /** Its save was out when the shared text arrived, and has not answered. */
  awaiting: boolean;
}

/** A save that has gone; `target` is the Y.Text that replaced the view it was sent from. */
export interface SentSave {
  target: Y.Text | null;
}

export function useKeptDraft(yText: Y.Text | null) {
  const [kept, setKept] = useState<KeptDraft[]>([]);
  // The newest save sent and not yet answered: the one the fetcher answers.
  const latest = useRef<SentSave | null>(null);
  const answered = (failed: boolean, save: SentSave | null = latest.current) => {
    if (!save) return;
    if (latest.current === save) latest.current = null;
    const settles = (k: KeptDraft) => k.awaiting && k.target === save.target;
    setKept((all) => all.flatMap((k) => (!settles(k) ? [k] : failed ? [{ ...k, awaiting: false }] : [])));
  };
  return {
    shown: kept.find((k) => k.target === yText && !k.awaiting) ?? null,
    /**
     * A save has gone. The fetcher aborts the save still out, whose promise
     * then resolves with no answer, so that save is settled as failed here:
     * whether it reached the server is unknown, and its text is offered back.
     */
    sent: (): SentSave => {
      if (latest.current) answered(true, latest.current);
      latest.current = { target: null };
      return latest.current;
    },
    /** `save` (default: the newest) has answered. */
    answered,
    /** `target` replaced a view holding `typed`; `pending` is a save not yet gone, `failed` the last save's. */
    replaced: (typed: string, target: Y.Text | null, pending: boolean, failed: boolean) => {
      if (!target || typed === target.toString()) return;
      const awaiting = !pending && !!latest.current;
      if (awaiting && latest.current) latest.current.target = target;
      if (pending || awaiting || failed) setKept((all) => [...all.filter((k) => k.target !== target), { text: typed, target, awaiting }]);
    },
    close: () => setKept((all) => all.filter((k) => k.target !== yText)),
  };
}
