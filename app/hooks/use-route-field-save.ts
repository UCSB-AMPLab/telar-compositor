/**
 * useRouteFieldSave — a text field's save, without a Y.Text, through the
 * route's action.
 *
 * The save is a fetcher submission, not a plain request, because of what the
 * router does around one: before the action runs it interrupts every loader
 * read in flight, and after it the route's loader is read again. A loader
 * read begun before the save therefore never lands, and the value a field
 * receives afterwards is read after the save. A plain request would leave a
 * read begun before it free to arrive afterwards and put the old text back in
 * the field.
 *
 * The hook belongs to a component that outlives the fields asking it to
 * save (the story stage, not a step's card): a field that finishes and then
 * unmounts, because the author selected another step, still has its save
 * sent and settled.
 *
 * Saves run one at a time, in the order asked: a fetcher that submits again
 * abandons the request it had in flight, so two fields finishing together
 * would otherwise lose one of their saves. Each submission carries a nonce
 * the action returns, so a save is settled by its own answer and no other.
 * An answer without `ok`, an answer that is not the action's (a refusal the
 * route did not answer as data), or no answer at all (the action threw)
 * rejects, and so does every save still waiting when the owner unmounts.
 *
 * A save may name the action it posts to, which is otherwise the current
 * route's, and may be withdrawn before it is sent: `withdrawn` is read as the
 * save reaches the front of the queue, and a save withdrawn by then is not
 * submitted and rejects with `WithdrawnSave`. Once submitted (`onSubmit`
 * says when) it cannot be withdrawn and settles by its answer.
 *
 * @version v1.5.0-beta
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { nextStamp } from "~/components/ui/target-saves";

/** What the route's action answers a field save with. */
export interface FieldSaveResult {
  ok: boolean;
  nonce?: string;
}

/** How a save is sent. */
export interface FieldSaveOptions {
  /** Where the save posts; the current route's action when absent. */
  action?: string;
  /** Read as the save reaches the front of the queue: true, and it is not sent. */
  withdrawn?: () => boolean;
  /** Called as the save is submitted, from when it can no longer be withdrawn. */
  onSubmit?: () => void;
}

/** The rejection of a save withdrawn before it was sent. */
export class WithdrawnSave extends Error {
  constructor() {
    super("save withdrawn");
    this.name = "WithdrawnSave";
  }
}

export type RouteFieldSave = (fields: Record<string, string>, options?: FieldSaveOptions) => Promise<number | undefined>;

interface Job {
  fields: Record<string, string>;
  options: FieldSaveOptions;
  nonce: string;
  /** Resolves with the stamp the answer was received at, where the route took one. */
  resolve: (confirmedAt: number | undefined) => void;
  reject: (error: Error) => void;
  /**
   * Set once the router has finished with this job's submission, or the
   * fetcher has been seen busy with it: an idle fetcher with no answer of
   * this job's is then a save that was not answered.
   */
  started: boolean;
}

let counter = 0;

/** The stamp each confirmed save's answer was received at, by nonce, until its save settles. */
const confirmations = new Map<string, number>();

/** The saves submitted and not yet answered, by nonce: each settles its own job. */
const answering = new Map<string, (answer: Partial<FieldSaveResult>) => void>();

/**
 * Stamps a field save's answer as it is received, on the counter the route's
 * reads are stamped on. The route's client action calls this on the action's
 * answer, before the router begins the read the save starts, so any read
 * begun after the answer carries a later stamp, whatever it delivers, and
 * any read begun before it an earlier one. A stamp taken later, when a
 * component sees the answer, would come after the save's own read had begun
 * and put that read, and the newer text another writer stored, behind it.
 * The save settles here too, so the field's own record of it (target-saves)
 * is confirmed before that read can reach the field.
 */
export function stampFieldSaveAnswer(answer: unknown): void {
  const result = (answer ?? {}) as Partial<FieldSaveResult>;
  const { ok, nonce } = result;
  if (typeof nonce !== "string") return;
  const settle = answering.get(nonce);
  // Only a save still waiting for its answer is confirmed: one whose owner
  // has gone, or that has settled already, has nothing left to read it.
  if (!settle) return;
  if (ok === true) confirmations.set(nonce, nextStamp());
  settle(result);
}

/** How many answered saves are held for their owner to read; for tests. */
export function fieldSaveConfirmationsHeld(): number {
  return confirmations.size;
}

export function useRouteFieldSave(): RouteFieldSave {
  const fetcher = useFetcher<FieldSaveResult>();
  const queue = useRef<Job[]>([]);
  const current = useRef<Job | null>(null);
  const submit = useRef(fetcher.submit);
  submit.current = fetcher.submit;
  // A submission can pass from idle to idle between two renders, so the
  // router's own "finished" is what marks it started, with a render to read
  // the answer in.
  const [, setFinished] = useState(0);

  const pump = useCallback(() => {
    if (current.current) return;
    let next = queue.current.shift();
    while (next?.options.withdrawn?.()) {
      next.reject(new WithdrawnSave());
      next = queue.current.shift();
    }
    if (!next) return;
    const job = next;
    current.current = job;
    answering.set(job.nonce, (answer) => finish(job, answer.ok === true));
    job.options.onSubmit?.();
    const action = job.options.action;
    const submitted = submit.current({ ...job.fields, nonce: job.nonce }, action ? { method: "post", action } : { method: "post" });
    void Promise.resolve(submitted).finally(() => {
      job.started = true;
      setFinished((n) => n + 1);
    });
  }, []);

  useEffect(() => {
    const job = current.current;
    if (!job) return;
    // Settled by its answer as soon as the answer arrives, while the router
    // is still reading the loader again: the save's confirmation is then
    // stamped before any read it started delivers, and after any read that
    // began before it.
    if (fetcher.data?.nonce === job.nonce) {
      finish(job, fetcher.data.ok);
      return;
    }
    if (fetcher.state !== "idle") {
      job.started = true;
      return;
    }
    const answer = fetcher.data;
    const answered = answer?.nonce === job.nonce;
    if (!answered && !job.started) return;
    finish(job, answered && answer.ok);
  });

  function finish(job: Job, ok: boolean) {
    if (current.current !== job) return;
    answering.delete(job.nonce);
    current.current = null;
    const confirmedAt = confirmations.get(job.nonce);
    confirmations.delete(job.nonce);
    if (ok) job.resolve(confirmedAt);
    else job.reject(new Error("save failed"));
    // The next save is submitted once the router has finished with this
    // answer, which may be settling it from inside the router's own action.
    setTimeout(pump, 0);
  }

  // Whatever is still waiting when the owner goes can no longer be told its
  // answer, and nothing asked afterwards (a draft its field leaves behind as
  // the editor closes) can be sent: both fail, so the field that asked keeps
  // or reports its draft.
  const alive = useRef(true);
  useEffect(() => {
    // Strict Mode runs this cleanup and the setup again on mount: the owner
    // is alive again after it.
    alive.current = true;
    return () => {
      alive.current = false;
      const waiting = [current.current, ...queue.current].filter((job): job is Job => job !== null);
      waiting.forEach((job) => answering.delete(job.nonce));
      current.current = null;
      queue.current = [];
      waiting.forEach((job) => job.reject(new Error("save not answered")));
    };
  }, []);

  return useCallback(
    (fields: Record<string, string>, options: FieldSaveOptions = {}) =>
      new Promise<number | undefined>((resolve, reject) => {
        if (!alive.current) {
          reject(new Error("save not sent"));
          return;
        }
        counter += 1;
        queue.current.push({ fields, options, nonce: `${Date.now()}-${counter}`, resolve, reject, started: false });
        pump();
      }),
    [pump],
  );
}
