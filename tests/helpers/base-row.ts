/**
 * The `projects` row the loader claims and the snapshot writes, for fake D1s.
 *
 * A fake that answers the loader's read alone leaves re-acquisition with
 * nothing to observe: a snapshot whose batch failed would read the row as gone
 * and refuse the write fence instead of retrying the batch. This tracker
 * answers both reads and moves the revision on every standalone conditioned
 * write, which is what such a write does when it lands — and in these fakes
 * every one of them lands.
 *
 * The batch's own advance is deliberately not tracked: it commits with the
 * batch, and a fake whose batch throws has applied none of it.
 *
 * The generation is 0 throughout, matching the storage stubs these fakes are
 * paired with, and the revision starts at 1, matching the one `markLoaded`
 * plants: a row and an instance that disagree about the revision the document
 * was opened at cannot land a single conditioned write.
 *
 * @version v1.5.0-beta
 */

export interface BaseRowTracker {
  /** Answer `first()` for the loader's read and for re-acquisition's. */
  read(sql: string): Record<string, unknown> | undefined;
  /** Record what a standalone conditioned write did to the row. */
  note(sql: string): void;
  /** The revision the row now holds. */
  revision(): number;
}

export interface BaseRowOptions {
  blob?: unknown;
  generation?: number | null;
  seq?: number | null;
  revision?: number;
}

export function trackBaseRow(options: BaseRowOptions = {}): BaseRowTracker {
  const blob = options.blob ?? null;
  let generation = options.generation ?? null;
  let seq = options.seq ?? null;
  let revision = options.revision ?? 1;

  return {
    read(sql: string) {
      if (/^SELECT yjs_state/.test(sql)) {
        return { yjs_state: blob, yjs_generation: generation, yjs_seq: seq, yjs_write: revision };
      }
      if (/^SELECT yjs_generation/.test(sql)) {
        return { yjs_generation: generation, yjs_seq: seq, yjs_write: revision };
      }
      return undefined;
    },
    note(sql: string) {
      if (!/^UPDATE projects SET .*yjs_write = \?/.test(sql)) return;
      revision += 1;
      if (/yjs_generation = \?/.test(sql)) generation = 0;
      if (/yjs_seq = /.test(sql)) seq = 0;
    },
    revision: () => revision,
  };
}
