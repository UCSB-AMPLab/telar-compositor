/**
 * A row's `updated_at` should mean the row, and its `last_edited_by` should
 * name a person.
 *
 * The snapshot writes every layer of a project in one batch, so binding its own
 * clock gave every layer the same instant — the column was identical across
 * every layer in every project in a cohort, and told a reader nothing about any
 * of them. Nothing in the value says so, which is the part that makes it
 * dangerous rather than merely useless. The actor had no column at all.
 *
 * A field path already carries the row it belongs to
 * (`stories:7:steps:11:layers:91:content`), so the per-path edits the
 * afterTransaction handler records aggregate into a per-row one with nothing new
 * recorded. This is the deriver, and the same path-parsing is what a per-entity
 * contributor tally needs.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import {
  recordPathContribution,
  proseContributorsFromPaths,
  rowEditsFromPaths,
} from "../workers/collaboration-helpers";
import type { EditsByPath } from "../workers/collaboration-helpers";

const T1 = "2026-08-15T10:00:00.000Z";
const T2 = "2026-08-15T11:00:00.000Z";
const T3 = "2026-08-15T12:00:00.000Z";

/** A real `_temp_id` — a v4 UUID, which is what the editor mints. */
const TEMP = "3f2a91c4-8e1d-4b7a-9c3e-2d5f7a1b4c8e";

/**
 * Build the accumulator by replaying edits through the recorder the handler
 * uses, rather than by hand-constructing its interior. A fixture that assembles
 * the structure directly can encode a shape the recorder would never produce.
 */
function edits(...written: Array<[path: string, userId: number, at: string]>): EditsByPath {
  const acc: EditsByPath = new Map();
  for (const [path, userId, at] of written) recordPathContribution(acc, path, userId, at);
  return acc;
}

describe("recording who wrote in a field", () => {
  it("keeps a person's first time and moves their last one forward", () => {
    const acc = edits(
      ["stories:7:title", 4, T1],
      ["stories:7:title", 4, T3],
    );

    expect(acc.get("stories:7:title")!.get(4)).toEqual({ first: T1, last: T3 });
  });

  it("never moves a stamp backwards", () => {
    // Two Durable Object instances can see edits out of order, and a stale
    // stamp overwriting a fresher one would read as the person having gone quiet.
    const acc = edits(
      ["stories:7:title", 4, T3],
      ["stories:7:title", 4, T1],
    );

    expect(acc.get("stories:7:title")!.get(4)).toEqual({ first: T1, last: T3 });
  });

  it("keeps an earlier contributor when somebody else edits the same field", () => {
    // The reason this structure is nested rather than one edit per path. Held
    // flat, the second writer erased the first, and a contributor set derived
    // from it reported one author for work two people did.
    const acc = edits(
      ["stories:7:steps:11:answer", 4, T1],
      ["stories:7:steps:11:answer", 8, T2],
    );

    expect([...acc.get("stories:7:steps:11:answer")!.keys()]).toEqual([4, 8]);
  });
});

describe("deriving a row's last edit from field paths", () => {
  it("names the row the path belongs to", () => {
    const acc = edits(["stories:7:steps:11:layers:91:content", 4, T1]);

    expect(rowEditsFromPaths(acc, "layers")).toEqual(new Map([["91", { at: T1, by: 4 }]]));
  });

  it("takes the latest of a row's fields, since that is when the row changed", () => {
    const acc = edits(
      ["stories:7:steps:11:layers:91:content", 4, T1],
      ["stories:7:steps:11:layers:91:title", 4, T3],
      ["stories:7:steps:11:layers:91:button_label", 4, T2],
    );

    expect(rowEditsFromPaths(acc, "layers")).toEqual(new Map([["91", { at: T3, by: 4 }]]));
  });

  it("carries the actor of the latest field, not of whichever came first", () => {
    // The whole point of keeping the pair together: two people wrote different
    // fields of one panel, and the answer to "who last edited this" is the one
    // who wrote last, whichever field that was.
    const acc = edits(
      ["stories:7:steps:11:layers:91:content", 12, T3],
      ["stories:7:steps:11:layers:91:title", 99, T1],
    );

    expect(rowEditsFromPaths(acc, "layers").get("91")).toEqual({ at: T3, by: 12 });
  });

  it("keeps rows apart", () => {
    const acc = edits(
      ["stories:7:steps:11:layers:91:content", 4, T1],
      ["stories:7:steps:11:layers:92:content", 6, T3],
      ["stories:8:steps:20:layers:93:title", 5, T2],
    );

    expect(rowEditsFromPaths(acc, "layers")).toEqual(
      new Map([
        ["91", { at: T1, by: 4 }],
        ["92", { at: T3, by: 6 }],
        ["93", { at: T2, by: 5 }],
      ]),
    );
  });

  it("answers for a different entity kind from the same paths", () => {
    const acc = edits(
      ["stories:7:steps:11:layers:91:content", 4, T1],
      ["stories:7:steps:12:answer", 6, T3],
    );

    expect(rowEditsFromPaths(acc, "steps")).toEqual(
      new Map([["11", { at: T1, by: 4 }], ["12", { at: T3, by: 6 }]]),
    );
    expect(rowEditsFromPaths(acc, "stories")).toEqual(new Map([["7", { at: T3, by: 6 }]]));
  });

  it("reads a panel's edit as an edit to the step and story holding it", () => {
    // Deliberate. A step whose panel somebody rewrote did change, and the
    // alternative is a step that reads as untouched while its own content moves.
    const acc = edits(["stories:7:steps:11:layers:91:content", 4, T1]);

    expect(rowEditsFromPaths(acc, "steps")).toEqual(new Map([["11", { at: T1, by: 4 }]]));
    expect(rowEditsFromPaths(acc, "stories")).toEqual(new Map([["7", { at: T1, by: 4 }]]));
  });

  it("keys a row the Durable Object has not numbered yet by its temp id", () => {
    // A layer created this session has a temp id until the snapshot INSERTs it.
    // Keeping the key is what lets that INSERT name the person who wrote into
    // it — the ordinary case of a panel somebody adds and immediately fills.
    const acc = edits(
      [`stories:7:steps:11:layers:${TEMP}:content`, 4, T1],
      ["stories:7:steps:11:layers:91:content", 5, T2],
    );

    expect(rowEditsFromPaths(acc, "layers")).toEqual(
      new Map([[TEMP, { at: T1, by: 4 }], ["91", { at: T2, by: 5 }]]),
    );
  });

  it("skips a segment that is neither a row id nor a temp id", () => {
    // The field-path resolver omits an id it cannot render, which collapses the
    // path and leaves a field name where the id should be. Filing an edit under
    // that would attribute one row's writing to another.
    const acc = edits(["stories:7:steps:answer", 4, T1]);

    expect(rowEditsFromPaths(acc, "steps")).toEqual(new Map());
  });

  it("ignores the segment name appearing as a trailing field", () => {
    // `story.steps` is itself a field path when the array changes. There is no
    // id after it, so there is no row to name.
    const acc = edits(["stories:7:steps", 4, T1]);

    expect(rowEditsFromPaths(acc, "steps")).toEqual(new Map());
  });

  it("returns nothing for an entity kind no path mentions", () => {
    const acc = edits(["stories:7:steps:11:answer", 4, T1]);

    expect(rowEditsFromPaths(acc, "layers")).toEqual(new Map());
  });

  it("returns nothing when nothing was edited in this lifetime", () => {
    // The common case after an eviction, and the reason the caller binds NULL
    // and lets SQL keep the stored value.
    expect(rowEditsFromPaths(new Map(), "layers")).toEqual(new Map());
  });
});

describe("deriving everyone who wrote text in a row", () => {
  it("unions contributors across every field of the row", () => {
    // The participation measure. `created_by` answers who MADE the step; this
    // answers who wrote what is in it, and the two diverge as soon as a second
    // person touches it.
    const acc = edits(
      ["stories:7:steps:11:question", 4, T1],
      ["stories:7:steps:11:answer", 8, T2],
      ["stories:7:steps:11:alt_text", 4, T3],
    );

    expect(proseContributorsFromPaths(acc, "steps")).toEqual(
      new Map([["11", new Map([
        [4, { first: T1, last: T3 }],
        [8, { first: T2, last: T2 }],
      ])]]),
    );
  });

  it("credits a panel's writer to the panel and to nothing holding it", () => {
    // `edited` means what a person wrote text in. A panel is its own kind on
    // the record, so its writer is a contributor to the panel; crediting the
    // step as well would put an `edited` on a row whose `words` column is a
    // dash, and the two are the same measurement.
    const acc = edits(["stories:7:steps:11:layers:91:content", 12, T1]);

    expect([...proseContributorsFromPaths(acc, "layers").get("91")!.keys()]).toEqual([12]);
    expect(proseContributorsFromPaths(acc, "steps").has("11")).toBe(false);
    expect(proseContributorsFromPaths(acc, "stories").has("7")).toBe(false);
  });

  it("credits a step's writer to the step and not to its story", () => {
    const acc = edits(["stories:7:steps:11:answer", 4, T1]);

    expect([...proseContributorsFromPaths(acc, "steps").get("11")!.keys()]).toEqual([4]);
    expect(proseContributorsFromPaths(acc, "stories").has("7")).toBe(false);
  });

  it("writes nobody for a change that is not prose", () => {
    // Framing an image, reordering and toggling a flag are changes to the site.
    // They still move `updated_at` and `last_edited_by`; they are not writing.
    const acc = edits(
      ["stories:7:steps:11:zoom", 4, T1],
      ["stories:7:steps:11:order_key", 4, T2],
      ["stories:7:private", 4, T3],
    );

    expect(proseContributorsFromPaths(acc, "steps")).toEqual(new Map());
    expect(proseContributorsFromPaths(acc, "stories")).toEqual(new Map());
    // The same paths still name the row that changed, and by whom.
    expect(rowEditsFromPaths(acc, "steps")).toEqual(new Map([["11", { at: T2, by: 4 }]]));
  });

  it("skips a row id neither derivation can key a row by", () => {
    // A path the resolver could not render an id for. Both derivations refuse
    // it, so no words are credited to a row no contributor row is written for.
    const acc = edits(["stories:7:steps:tmp_a1:answer", 4, T1]);

    expect(proseContributorsFromPaths(acc, "steps")).toEqual(new Map());
    expect(rowEditsFromPaths(acc, "steps")).toEqual(new Map());
  });

  it("takes the earliest first and the latest last across a row's fields", () => {
    const acc = edits(
      ["stories:7:steps:11:answer", 4, T2],
      ["stories:7:steps:11:question", 4, T1],
      ["stories:7:steps:11:alt_text", 4, T3],
    );

    expect(proseContributorsFromPaths(acc, "steps").get("11")!.get(4)).toEqual({
      first: T1,
      last: T3,
    });
  });

  it("keeps rows apart", () => {
    const acc = edits(
      ["stories:7:steps:11:answer", 4, T1],
      ["stories:7:steps:12:answer", 8, T2],
    );

    const rows = proseContributorsFromPaths(acc, "steps");
    expect([...rows.get("11")!.keys()]).toEqual([4]);
    expect([...rows.get("12")!.keys()]).toEqual([8]);
  });

  it("keys a row the Durable Object has not numbered yet by its temp id", () => {
    const acc = edits([`stories:7:steps:${TEMP}:answer`, 4, T1]);

    expect([...proseContributorsFromPaths(acc, "steps").keys()]).toEqual([TEMP]);
  });

  it("returns nothing when this instance has seen no edits", () => {
    // The state of every freshly started Durable Object, and the reason the
    // caller must UNION what it finds into D1 rather than assign it: an empty
    // answer here means "seen nothing", never "nobody contributed".
    expect(proseContributorsFromPaths(new Map(), "steps")).toEqual(new Map());
  });
});
