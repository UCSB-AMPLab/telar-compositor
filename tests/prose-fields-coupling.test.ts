/**
 * The two lists of prose fields must name the same fields.
 *
 * One lives with the live capture and is keyed by the document's collection
 * names — `steps`, `glossary`, `pages`. The other lives with the backfill and is
 * keyed by what `entity_contributors` calls the same things — `step`, `term`,
 * `page`. They exist separately because each is read in a different vocabulary,
 * and they are the same list.
 *
 * Nothing else would catch them drifting. A field added to one and not the other
 * makes a word counted live and a word counted by the backfill mean different
 * things, in a column that shows both without saying which is which — and it
 * would show up as a number slightly off, on a page whose numbers nobody can
 * check by hand.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import { proseFieldNames } from "../workers/contribution-metrics";
import { PROSE_COLUMNS } from "~/lib/words-backfill.server";

/** The document's name for each kind, against the contributor table's. */
const SEGMENT_BY_KIND: Record<string, string> = {
  story: "stories",
  step: "steps",
  layer: "layers",
  object: "objects",
  term: "glossary",
  page: "pages",
};

describe("the live capture and the backfill count the same fields", () => {
  it.each(Object.entries(SEGMENT_BY_KIND))(
    "agrees on %s",
    (kind, segment) => {
      expect([...PROSE_COLUMNS[kind]].sort()).toEqual([...proseFieldNames(segment)].sort());
    },
  );

  it("covers every kind the contributor table can hold", () => {
    expect(Object.keys(PROSE_COLUMNS).sort()).toEqual(Object.keys(SEGMENT_BY_KIND).sort());
  });
});
