/**
 * When a person last edited is a fact about them, not about the snapshot.
 *
 * `contributions.last_active` was set to the snapshot's own clock. Every member
 * of a project is written in one snapshot, so they all received the same
 * instant — the field read as though a whole class had been working at the same
 * second, and it was identical across every member of every project in a
 * cohort. Nothing in the value says it is a snapshot artefact, and a teaching
 * view reaching for "when was this student last active" would have been wrong
 * in the most confident way available.
 *
 * The stamp is taken where the difference exists: the `afterTransaction`
 * handler sees the edit itself. Two consequences follow from the handler's
 * scope, and both are deliberate. It runs only for socket-origin transactions,
 * so the runtime's own writes stamp nobody. And it lives for the Durable
 * Object's lifetime, so a fresh instance has no stamps — which reads as "no
 * edits seen here", never as "this person has gone quiet".
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

import {
  buildContributionUpdate,
  makeAfterTransactionHandler,
} from "../workers/collaboration-helpers";
import type { EditsByPath } from "../workers/collaboration-helpers";

const STORED = "2026-08-01T00:00:00.000Z";

function stored() {
  return {
    stories_edited: [],
    objects_edited: [],
    fields_edited: 3,
    sessions: 1,
    last_active: STORED,
  };
}

describe("the stamp on a contribution row", () => {
  it("takes the time of the edit", () => {
    const edited = "2026-08-15T11:22:33.000Z";

    const result = buildContributionUpdate(stored(), new Set(["stories:a:title"]), false, edited);

    expect(result.last_active).toBe(edited);
  });

  it("leaves the stored time alone when this lifetime saw no edit", () => {
    // A fresh Durable Object, or a member who reconnected and did nothing.
    const result = buildContributionUpdate(stored(), undefined, true, undefined);

    expect(result.last_active).toBe(STORED);
  });

  it("never moves backwards", () => {
    // Two instances can snapshot out of order; a stale stamp landing last
    // would read as the person having gone quiet.
    const older = "2026-07-01T00:00:00.000Z";

    const result = buildContributionUpdate(stored(), new Set(["stories:a:title"]), false, older);

    expect(result.last_active).toBe(STORED);
  });

  it("fills in for a member who has no stored time", () => {
    const edited = "2026-08-15T11:22:33.000Z";

    const result = buildContributionUpdate(
      { stories_edited: [], objects_edited: [], fields_edited: 0, sessions: 0, last_active: null },
      new Set(["stories:a:title"]),
      false,
      edited,
    );

    expect(result.last_active).toBe(edited);
  });
});

describe("the handler that takes the stamp", () => {
  function harness(clock: () => string) {
    const ydoc = new Y.Doc();
    const userFieldSets = new Map<number, Set<string>>();
    const lastEditAt = new Map<number, string>();
    const editsByPath: EditsByPath = new Map();
    ydoc.on("afterTransaction", makeAfterTransactionHandler(
      ydoc,
      userFieldSets,
      (origin: unknown) => (origin as { userId?: number } | null)?.userId ?? null,
      lastEditAt,
      clock,
      editsByPath,
    ));
    return { ydoc, userFieldSets, lastEditAt, editsByPath };
  }

  /** A story the resolver can name, so an edit to it produces a field path. */
  function seedStory(ydoc: Y.Doc) {
    const story = new Y.Map<unknown>();
    ydoc.transact(() => {
      story.set("_id", 11);
      story.set("story_id", "a");
      story.set("title", "A");
      ydoc.getArray<unknown>("stories").push([story]);
    }, null);
    return story;
  }

  it("stamps the editing user", () => {
    const h = harness(() => "2026-08-15T11:22:33.000Z");
    const story = seedStory(h.ydoc);

    h.ydoc.transact(() => { story.set("title", "B"); }, { userId: 7 });

    expect(h.lastEditAt.get(7)).toBe("2026-08-15T11:22:33.000Z");
  });

  it("moves the stamp forward on a later edit", () => {
    let t = "2026-08-15T11:22:33.000Z";
    const h = harness(() => t);
    const story = seedStory(h.ydoc);

    h.ydoc.transact(() => { story.set("title", "B"); }, { userId: 7 });
    t = "2026-08-15T12:00:00.000Z";
    h.ydoc.transact(() => { story.set("title", "C"); }, { userId: 7 });

    expect(h.lastEditAt.get(7)).toBe("2026-08-15T12:00:00.000Z");
  });

  it("stamps nobody for the runtime's own writes", () => {
    const h = harness(() => "2026-08-15T11:22:33.000Z");
    const story = seedStory(h.ydoc);

    // Null origin is how the Durable Object writes its own repairs.
    h.ydoc.transact(() => { story.set("title", "B"); }, null);

    expect(h.lastEditAt.size).toBe(0);
  });

  it("records the field path with both the time and the actor", () => {
    // The per-path record is what gives a ROW its own `updated_at` and its
    // `last_edited_by`; the per-person stamp gives a member their
    // `last_active`. All of it comes from this handler and from the same
    // instant, because it describes the same edit.
    const h = harness(() => "2026-08-15T11:22:33.000Z");
    const story = seedStory(h.ydoc);

    h.ydoc.transact(() => { story.set("title", "B"); }, { userId: 7 });

    expect([...h.editsByPath.entries()]).toEqual([
      [
        "stories:11:title",
        new Map([[7, { first: "2026-08-15T11:22:33.000Z", last: "2026-08-15T11:22:33.000Z" }]]),
      ],
    ]);
  });

  it("moves a path's record forward when the same field is edited again", () => {
    let t = "2026-08-15T11:00:00.000Z";
    const h = harness(() => t);
    const story = seedStory(h.ydoc);

    h.ydoc.transact(() => { story.set("title", "B"); }, { userId: 7 });
    t = "2026-08-15T12:00:00.000Z";
    h.ydoc.transact(() => { story.set("title", "C"); }, { userId: 8 });

    // The row changed at the later time, and by the person who made that
    // change. Both writers are kept: the record is per person, so deriving
    // "last edited by" takes the latest of them rather than the second erasing
    // the first — which is what a contributor set needs and a flat record lost.
    expect(h.editsByPath.get("stories:11:title")).toEqual(
      new Map([
        [7, { first: "2026-08-15T11:00:00.000Z", last: "2026-08-15T11:00:00.000Z" }],
        [8, { first: "2026-08-15T12:00:00.000Z", last: "2026-08-15T12:00:00.000Z" }],
      ]),
    );
  });

  it("stamps nobody for a transaction that changed nothing", () => {
    // `last_active` and `fields_edited` stay in lockstep: both come from
    // resolved field paths, so a transaction carrying no change adds no path
    // and must put no time on anyone. Reachable rather than theoretical —
    // Yjs updates are idempotent, so a client re-sending one it already sent
    // opens a transaction whose `changed` map is empty.
    const h = harness(() => "2026-08-15T11:22:33.000Z");
    seedStory(h.ydoc);

    h.ydoc.transact(() => { /* a socket message that turned out to be a no-op */ },
      { userId: 7 });

    expect(h.userFieldSets.get(7)?.size ?? 0).toBe(0);
    expect(h.lastEditAt.size).toBe(0);
  });

  it("stamps one editor without stamping the other", () => {
    let t = "2026-08-15T11:00:00.000Z";
    const h = harness(() => t);
    const story = seedStory(h.ydoc);

    h.ydoc.transact(() => { story.set("title", "B"); }, { userId: 7 });
    t = "2026-08-15T13:00:00.000Z";
    h.ydoc.transact(() => { story.set("subtitle", "S"); }, { userId: 8 });

    // The whole point: two members, two different times.
    expect(h.lastEditAt.get(7)).toBe("2026-08-15T11:00:00.000Z");
    expect(h.lastEditAt.get(8)).toBe("2026-08-15T13:00:00.000Z");
  });
});
