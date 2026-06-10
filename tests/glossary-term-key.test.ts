/**
 * Regression: glossary term selection key must be stable across the snapshot's
 * `_id` backfill (telar-compositor#26).
 *
 * A term created this session starts with `_id: null` and a `_temp_id`. The
 * collaboration snapshot persists it and backfills `_id` (null → number) while
 * keeping `_temp_id`. If `termKey` keyed on `_id`, the term's identity would flip
 * mid-edit; the captured `selectedKey` would stop matching, `selectedTerm` would
 * go null, and the open definition editor would unmount — discarding everything
 * typed after the backfill and leaving only the first character or two in the
 * Y.Text. Keying on the immutable `_temp_id` keeps the selection stable.
 */

import { describe, it, expect } from "vitest";
import { termKey, type TermItem } from "~/routes/_app.glossary";

function term(overrides: Partial<TermItem>): TermItem {
  return {
    _id: null,
    _temp_id: null,
    title: "",
    term_id: "",
    definition: "",
    yMap: {} as TermItem["yMap"],
    ...overrides,
  };
}

describe("termKey — identity stable across the _id backfill (#26)", () => {
  it("keeps the SAME key when a session term's _id is backfilled", () => {
    const beforeBackfill = term({ _id: null, _temp_id: "uuid-abc" });
    const afterBackfill = term({ _id: 42, _temp_id: "uuid-abc" });
    // The selection captured before the snapshot must still resolve afterwards.
    expect(termKey(afterBackfill)).toBe(termKey(beforeBackfill));
    expect(termKey(afterBackfill)).toBe("tmp:uuid-abc");
  });

  it("keys D1-loaded terms (no _temp_id) stably on id", () => {
    expect(termKey(term({ _id: 7, _temp_id: null }))).toBe("id:7");
  });

  it("gives distinct terms distinct keys", () => {
    const a = term({ _id: null, _temp_id: "uuid-a" });
    const b = term({ _id: null, _temp_id: "uuid-b" });
    const c = term({ _id: 9, _temp_id: null });
    const keys = new Set([termKey(a), termKey(b), termKey(c)]);
    expect(keys.size).toBe(3);
  });
});
