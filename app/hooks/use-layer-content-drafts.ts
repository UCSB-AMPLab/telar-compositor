/**
 * useLayerContentDrafts — the one owner of a layer's content while it has
 * no Y.Text, held by the story stage, which outlives every editor that
 * shows the content.
 *
 * With a Y.Text the content is the shared text and the owner is never
 * involved. Without one, the editor reports each change (`edit`) and the
 * owner keeps, per layer:
 *
 *   - `draft`: the latest text the author typed, sent or not;
 *   - one debounce timer, restarted by each edit;
 *   - the sends out, each numbered from the recovery key's counter
 *     (target-saves.ts, `nextSequence`), which no mount of any editor resets;
 *   - `acknowledged`: the text and confirmation stamp of the highest-numbered
 *     send that succeeded, the stamp being the one the route's save resolves
 *     with and never one of the owner's own;
 *   - `failure`: the text and number of the highest-numbered send that
 *     failed, unless a higher-numbered one has succeeded since.
 *
 * A send goes out when the timer fires, on Retry, and when the editor leaves
 * (it closes, is covered, or the step changes): `flush` sends the draft once
 * if the timer is still holding it, and consumes the timer, so the same text
 * never goes twice. Answers are taken by number: a success sets
 * `acknowledged` if it is the newest, and clears a failure below it; a
 * failure below the newest success is ignored. An answer to an older send
 * arriving after a newer one's therefore never shows or keeps the older text.
 *
 * What an editor starts from, and what the rendered panel shows (`view`):
 * the draft when it differs from what was acknowledged, since it is typed,
 * pending or failed; else the acknowledged text, until the loader delivers a
 * value read at or after its stamp; else the loader's value.
 *
 * A failure is also written to target-saves under
 * `project:{id}/layer:{id}/content`, with its number, so a reload offers it
 * again; the owner seeds a layer's draft and failure from it when it first
 * sees the layer, and hears how any send another owner made for the layer
 * settles afterwards: one made before the author left the story and came
 * back.
 *
 * The owner's scope is one project and one story. Each send captures the
 * project, layer, recovery key and action it was made for, so a later switch
 * never redirects it. Closing the scope (the author leaves the story, or the
 * stage moves to another story or project) cancels every timer and writes
 * each draft that is neither acknowledged nor already out to target-saves;
 * the route's save refuses to send once its owner has gone, so nothing is
 * sent on the way out. A draft counts as carried only when it is the text of
 * the newest send out, acknowledged or failed: an author who returns to an
 * older text while a newer send is out still has it kept. A send already out settles against target-saves
 * after the scope has closed.
 *
 * A layer's Y.Text arriving (`takeOver`) cancels its timer and withdraws its
 * sends not yet submitted, keeping the draft; a submitted send stays tracked
 * until it settles. The draft no send carried is then what the panel offers
 * the author to apply to the shared text or discard (`keptAfterTakeOver`). The owner
 * watches the shared document for it, for every layer it still has to send,
 * whether or not that layer's panel is open. Deleting a
 * layer (`retireLayerContent`, called from the route's delete) cancels its
 * timer and forgets it, and marks it deleted for the page, so a late answer
 * cannot bring a failure back for a layer that is gone, even to an owner
 * whose scope has ended. A step change is none of these: the records stay.
 *
 * Discard sets the draft back to what the layer holds and forgets the
 * failure; while a send is out it does nothing, since that send cannot be
 * withdrawn and would land after it.
 *
 * Without a Y.Text the route's save is whole-value and the last write wins.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import * as Y from "yjs";
import {
  clearRecoveredThrough,
  nextSequence,
  recordSequencedFailure,
  recoveredFor,
  sequenceSucceeded,
} from "~/components/ui/target-saves";
import { WithdrawnSave, type FieldSaveOptions } from "~/hooks/use-route-field-save";

/** Sends one save of a layer's content; resolves with the answer's confirmation stamp. */
export type ContentSend = (layerId: number, fields: Record<string, string>, options: FieldSaveOptions) => Promise<number | undefined>;

/** The project and story an owner's records belong to, and where their saves post. */
export interface ContentScope {
  projectId: number;
  storyKey: string;
  actionUrl?: string;
}

interface Job {
  sequence: number;
  text: string;
  /** Submitted to the route: it can no longer be withdrawn and settles by its answer. */
  submitted: boolean;
  withdrawn: boolean;
}

interface LayerRecord {
  layerId: number;
  recoveryKey: string;
  draft: string | null;
  /**
   * The number of the failed send the draft was recovered from, while the
   * author has not typed over it; null for a draft the author typed, or none.
   */
  recoveredFrom: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  acknowledged: { text: string; stamp: number | undefined; sequence: number } | null;
  failure: { text: string; sequence: number } | null;
  jobs: Set<Job>;
  retired: boolean;
}

/** A layer's content as the panel shows and edits it. */
export interface LayerContentView {
  /** What an editor opens on, and what the rendered panel shows. */
  value: string;
  /** The latest send failed, and nothing newer is out. */
  failed: boolean;
  /** A send is out: Discard does nothing until it settles. */
  sending: boolean;
}

/** Where a layer's content draft is kept for recovery. */
export function contentRecoveryKey(projectId: number, layerId: number): string {
  return `project:${projectId}/layer:${layerId}/content`;
}

const live = new Set<LayerContentDrafts>();

/**
 * The recovery keys of deleted layers, for the page. A send still out when
 * its layer is deleted settles against this, whether or not its owner's
 * scope is still live, so its answer cannot bring a draft back.
 */
const retiredKeys = new Set<string>();

/** Forgets a deleted layer's content draft, in every live owner of its project and for sends still out. */
export function retireLayerContent(projectId: number, layerId: number): void {
  if (layerId <= 0) return;
  retiredKeys.add(contentRecoveryKey(projectId, layerId));
  for (const owner of live) if (owner.scope.projectId === projectId) owner.retire(layerId);
  const recoveryKey = contentRecoveryKey(projectId, layerId);
  clearRecoveredThrough(recoveryKey, recoveryKey, Number.MAX_SAFE_INTEGER);
}

/** What became of a send, told to every live owner of its layer. */
type Settlement =
  | { kind: "succeeded"; text: string; sequence: number; stamp: number | undefined }
  | { kind: "failed"; text: string; sequence: number };

/**
 * Tells the live owners other than `from` how a send for `recoveryKey`
 * settled. A send made in a scope that has since ended still reaches the
 * owner of the story the author has come back to, which read the recovery
 * record before the send had failed.
 */
function announce(from: LayerContentDrafts, recoveryKey: string, settlement: Settlement) {
  for (const owner of live) if (owner !== from) owner.heard(recoveryKey, settlement);
}

/** Forgets which layers were deleted; for tests that reuse a layer's id. */
export function forgetRetiredLayers(): void {
  retiredKeys.clear();
}

/** Whether a record's layer has been deleted, by this owner or through any other. */
function isRetired(record: LayerRecord): boolean {
  return record.retired || retiredKeys.has(record.recoveryKey);
}

/**
 * The text of the newest thing known about a record's content: the send out,
 * acknowledged or failed with the highest number. A draft that differs from
 * it is not yet carried by anything, even if it equals an older text.
 */
function newestText(record: LayerRecord): string | undefined {
  const known: Array<{ sequence: number; text: string }> = [...record.jobs].filter((job) => !job.withdrawn);
  if (record.acknowledged) known.push(record.acknowledged);
  if (record.failure) known.push(record.failure);
  return known.sort((a, b) => b.sequence - a.sequence)[0]?.text;
}

export class LayerContentDrafts {
  private records = new Map<number, LayerRecord>();
  private listeners = new Set<() => void>();
  private version = 0;
  private open = true;

  constructor(
    readonly scope: ContentScope,
    private send: ContentSend,
    private options: { debounceMs: number; errorMessage: () => string },
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = () => this.version;

  private changed() {
    this.version += 1;
    this.listeners.forEach((listener) => listener());
  }

  private record(layerId: number): LayerRecord {
    let record = this.records.get(layerId);
    if (record) return record;
    const recoveryKey = contentRecoveryKey(this.scope.projectId, layerId);
    record = {
      layerId,
      recoveryKey,
      draft: null,
      recoveredFrom: null,
      timer: null,
      acknowledged: null,
      failure: null,
      jobs: new Set(),
      retired: false,
    };
    const kept = recoveredFor(recoveryKey, recoveryKey);
    if (kept) {
      record.draft = kept.draft;
      record.recoveredFrom = kept.sequence ?? 0;
      record.failure = { text: kept.draft, sequence: kept.sequence ?? 0 };
    }
    this.records.set(layerId, record);
    return record;
  }

  /** The layer's content as it should be shown, given the loader's value and when the loader read it. */
  view(layerId: number, loaded: string, readStamp: number | undefined): LayerContentView {
    const record = this.record(layerId);
    const acknowledged = record.acknowledged;
    const out = [...record.jobs].filter((job) => !job.withdrawn);
    const failed = !!record.failure && !out.some((job) => job.sequence > record.failure!.sequence);
    let value = loaded;
    if (record.draft !== null && record.draft !== acknowledged?.text) value = record.draft;
    else if (acknowledged && !loaderIsNewer(acknowledged, loaded, readStamp)) value = acknowledged.text;
    return { value, failed, sending: out.length > 0 };
  }

  /** The author typed: the draft is kept and sent once the author pauses. */
  edit(layerId: number, text: string): void {
    const record = this.record(layerId);
    record.draft = text;
    record.recoveredFrom = null;
    if (record.timer) clearTimeout(record.timer);
    record.timer = setTimeout(() => {
      record.timer = null;
      this.dispatch(record);
    }, this.options.debounceMs);
    this.changed();
  }

  /** The editor is leaving: a draft the timer still holds is sent now, once. */
  flush(layerId: number): void {
    const record = this.records.get(layerId);
    if (!record?.timer) return;
    clearTimeout(record.timer);
    record.timer = null;
    this.dispatch(record);
  }

  /** Sends the draft, or the failed text, again, as a new send. */
  retry(layerId: number): void {
    const record = this.record(layerId);
    if (record.timer) clearTimeout(record.timer);
    record.timer = null;
    this.dispatch(record);
  }

  /**
   * Sets the draft back to what the layer holds and forgets its failure;
   * returns false, changing nothing, while a send is out.
   */
  discard(layerId: number): boolean {
    const record = this.record(layerId);
    if ([...record.jobs].some((job) => !job.withdrawn)) return false;
    if (record.timer) clearTimeout(record.timer);
    record.timer = null;
    record.draft = null;
    record.recoveredFrom = null;
    if (record.failure) clearRecoveredThrough(record.recoveryKey, record.recoveryKey, record.failure.sequence);
    record.failure = null;
    this.changed();
    return true;
  }

  /** The layer's Y.Text has arrived: nothing more is sent for it, and its draft is kept. */
  takeOver(layerId: number): void {
    const record = this.records.get(layerId);
    if (!record) return;
    if (record.timer) clearTimeout(record.timer);
    record.timer = null;
    record.jobs.forEach((job) => {
      if (!job.submitted) job.withdrawn = true;
    });
    this.changed();
  }

  /**
   * After the shared text has taken over: the text the author typed that no
   * send carried, once no send is out; null while one is, or for none.
   */
  keptAfterTakeOver(layerId: number): string | null {
    const record = this.records.get(layerId);
    if (!record || [...record.jobs].some((job) => !job.withdrawn)) return null;
    const text = record.draft ?? record.failure?.text ?? null;
    return text !== record.acknowledged?.text ? text : null;
  }

  /** The layers whose content the owner still has to send: a timer holds a draft, or a send is not yet submitted. */
  pendingLayers(): number[] {
    return [...this.records.values()]
      .filter((record) => record.timer || [...record.jobs].some((job) => !job.submitted && !job.withdrawn))
      .map((record) => record.layerId);
  }

  /** The layer has been deleted: its timer and its record go, and so does any draft kept for it. */
  retire(layerId: number): void {
    const record = this.records.get(layerId);
    if (record) {
      if (record.timer) clearTimeout(record.timer);
      record.retired = true;
      this.records.delete(layerId);
    }
    const recoveryKey = contentRecoveryKey(this.scope.projectId, layerId);
    clearRecoveredThrough(recoveryKey, recoveryKey, Number.MAX_SAFE_INTEGER);
    this.changed();
  }

  /**
   * Another owner's send for one of this owner's layers settled. It is taken
   * in number order, as this owner's own answers are; a failure seeds the
   * draft only where the author has not typed since.
   */
  heard(recoveryKey: string, settlement: Settlement): void {
    const record = [...this.records.values()].find((r) => r.recoveryKey === recoveryKey);
    if (!record || isRetired(record)) return;
    if (settlement.kind === "succeeded") this.acknowledge(record, settlement.text, settlement.stamp, settlement.sequence);
    else this.keepFailure(record, settlement.text, settlement.sequence);
    this.changed();
  }

  /**
   * A success, taken by number: the newest is the acknowledged text, and it
   * clears older failures and a recovered draft older than it that the
   * author has not typed over.
   */
  private acknowledge(record: LayerRecord, text: string, stamp: number | undefined, sequence: number) {
    if (!record.acknowledged || sequence > record.acknowledged.sequence) record.acknowledged = { text, stamp, sequence };
    if (record.failure && record.failure.sequence < sequence) record.failure = null;
    if (record.recoveredFrom !== null && record.recoveredFrom < sequence) {
      record.draft = null;
      record.recoveredFrom = null;
    }
  }

  /**
   * A failure, taken by number. A newer one replaces the failure, and the
   * draft too where the draft was recovered rather than typed, so Retry sends
   * the newest text.
   */
  private keepFailure(record: LayerRecord, text: string, sequence: number) {
    const newer = Math.max(record.failure?.sequence ?? -1, record.acknowledged?.sequence ?? -1);
    if (sequence <= newer) return;
    record.failure = { text, sequence };
    if (record.draft !== null && record.recoveredFrom === null) return;
    record.draft = text;
    record.recoveredFrom = sequence;
  }

  /** The scope is in use again (Strict Mode ends and restarts it on mount). */
  reopen(): void {
    this.open = true;
    live.add(this);
  }

  /**
   * The scope has ended: every timer is cancelled, and every draft that is
   * neither acknowledged nor out is kept in target-saves for the next visit.
   */
  close(): void {
    this.open = false;
    live.delete(this);
    for (const record of this.records.values()) {
      if (record.timer) clearTimeout(record.timer);
      record.timer = null;
      const draft = record.draft;
      if (draft === null || draft === newestText(record)) continue;
      const sequence = nextSequence(record.recoveryKey);
      recordSequencedFailure(record.recoveryKey, record.recoveryKey, draft, this.options.errorMessage(), sequence);
    }
  }

  private dispatch(record: LayerRecord) {
    const text = record.draft ?? record.failure?.text;
    if (text === undefined || isRetired(record) || !this.open) return;
    const job: Job = { sequence: nextSequence(record.recoveryKey), text, submitted: false, withdrawn: false };
    record.jobs.add(job);
    const fields = { intent: "autosave-layer", layerId: String(record.layerId), field: "content", value: text };
    const options = {
      action: this.scope.actionUrl,
      withdrawn: () => job.withdrawn,
      onSubmit: () => {
        job.submitted = true;
      },
    };
    this.send(record.layerId, fields, options).then(
      (stamp) => this.succeeded(record, job, stamp),
      (error: unknown) => this.failed(record, job, error),
    );
    this.changed();
  }

  private succeeded(record: LayerRecord, job: Job, stamp: number | undefined) {
    record.jobs.delete(job);
    sequenceSucceeded(record.recoveryKey, record.recoveryKey, job.sequence);
    if (isRetired(record)) return;
    this.acknowledge(record, job.text, stamp, job.sequence);
    announce(this, record.recoveryKey, { kind: "succeeded", text: job.text, sequence: job.sequence, stamp });
    this.changed();
  }

  private failed(record: LayerRecord, job: Job, error: unknown) {
    record.jobs.delete(job);
    if (isRetired(record) || error instanceof WithdrawnSave) {
      this.changed();
      return;
    }
    // target-saves refuses a failure below the last success, and one older
    // than the failure it holds.
    const kept = recordSequencedFailure(record.recoveryKey, record.recoveryKey, job.text, this.options.errorMessage(), job.sequence);
    if (kept && (!record.failure || record.failure.sequence < job.sequence)) {
      record.failure = { text: job.text, sequence: job.sequence };
    }
    if (kept) announce(this, record.recoveryKey, { kind: "failed", text: job.text, sequence: job.sequence });
    this.changed();
  }
}

/**
 * Whether the loader's value replaces an acknowledged text: it was read at or
 * after the save's answer. Without a stamp the acknowledged text is kept
 * until the loader delivers the same text.
 */
function loaderIsNewer(acknowledged: { text: string; stamp: number | undefined }, loaded: string, readStamp: number | undefined) {
  if (acknowledged.stamp === undefined) return loaded === acknowledged.text;
  return readStamp !== undefined && readStamp >= acknowledged.stamp;
}

/** Whether the shared document holds a Y.Text for the layer's content, in the story `storyKey`. */
export function hasSharedContent(ydoc: Y.Doc, storyKey: string, layerId: number): boolean {
  const stories = ydoc.getArray<Y.Map<unknown>>("stories").toArray();
  const story = stories.find((s) => s instanceof Y.Map && String(s.get("story_id") ?? "") === storyKey);
  const steps = story?.get("steps");
  if (!(steps instanceof Y.Array)) return false;
  return steps.toArray().some((step) => {
    const layers = step instanceof Y.Map ? step.get("layers") : null;
    if (!(layers instanceof Y.Array)) return false;
    return layers.toArray().some((layer) => layer instanceof Y.Map && layer.get("_id") === layerId && layer.get("content") instanceof Y.Text);
  });
}

/**
 * Hands every layer the owner still has to send to its Y.Text, wherever that
 * layer is: its panel open or not, its step shown or not.
 */
export function takeOverShared(owner: LayerContentDrafts, ydoc: Y.Doc): void {
  for (const layerId of owner.pendingLayers()) {
    if (hasSharedContent(ydoc, owner.scope.storyKey, layerId)) owner.takeOver(layerId);
  }
}

/**
 * The stage's owner for its project and story; a change of either closes the
 * old owner and starts a new one. Components that show a layer's content
 * subscribe with `useLayerContent`.
 */
export function useLayerContentDrafts({
  scope,
  send,
  errorMessage,
  ydoc = null,
  debounceMs = 1500,
}: {
  scope: ContentScope;
  send: ContentSend;
  errorMessage: string;
  /** The shared document, once collaboration has one: a layer's Y.Text arriving in it takes over. */
  ydoc?: Y.Doc | null;
  debounceMs?: number;
}): LayerContentDrafts {
  const latest = useRef({ send, errorMessage });
  latest.current = { send, errorMessage };
  const { projectId, storyKey, actionUrl } = scope;
  const owner = useMemo(
    () =>
      new LayerContentDrafts(
        { projectId, storyKey, actionUrl },
        (layerId, fields, options) => latest.current.send(layerId, fields, options),
        { debounceMs, errorMessage: () => latest.current.errorMessage },
      ),
    [projectId, storyKey, actionUrl, debounceMs],
  );
  useEffect(() => {
    owner.reopen();
    return () => owner.close();
  }, [owner]);
  useEffect(() => {
    if (!ydoc) return;
    const check = () => takeOverShared(owner, ydoc);
    check();
    ydoc.on("update", check);
    return () => ydoc.off("update", check);
  }, [owner, ydoc]);
  return owner;
}

/** Re-renders whenever the owner's records change. */
export function useLayerContent(owner: LayerContentDrafts | null): void {
  useSyncExternalStore(
    owner ? owner.subscribe : noSubscription,
    owner ? owner.snapshot : noVersion,
    owner ? owner.snapshot : noVersion,
  );
}

const noSubscription = () => () => {};
const noVersion = () => 0;
