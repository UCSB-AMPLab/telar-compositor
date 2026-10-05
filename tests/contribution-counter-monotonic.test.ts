/**
 * A contribution count may not go down.
 *
 * `contributions.fields_edited` drives the donut in the collaboration sidebar,
 * one slice per member. `userFieldSets` holds the field paths a person has
 * touched, and it lives in the Durable Object's memory: it starts empty on
 * every DO lifetime and is lost on eviction.
 *
 * The counter was written as `fieldSet?.size ?? 0` — the CURRENT lifetime's
 * count, assigned over whatever was stored. So the stored figure survived only
 * until the next snapshot of a fresher, emptier lifetime, and a person who
 * reconnected before their first edit had their count set to zero. Reconnection
 * is constant: a page reload starts a new Yjs client, and members in one cohort
 * reached several hundred sessions each. The observed data matches exactly —
 * a member with 673 sessions held `fields_edited: 1`, while one with two
 * activity rows held 65, having done their work inside a single warm lifetime
 * and not reconnected since.
 *
 * The donut makes the loss worse than a wrong number. Its slices clamp to a 3%
 * minimum, so a member whose count was zeroed draws the same sliver as a member
 * who genuinely did nothing: the chart cannot distinguish lost work from no
 * work, and a teacher reading it cannot either.
 *
 * So the rule here is only that the number never falls. That is deliberately
 * short of correct — a lifetime-exact count needs the field-path set itself to
 * survive eviction, and the metric is a poor proxy for effort in the first
 * place (the sound signals are `created_by` and word counts). It
 * is worth separating the two: whether the number is the RIGHT one is a design
 * question, and whether it destroys what it already knew is not.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import { buildContributionUpdate } from "../workers/collaboration-helpers";

/** What a member's row holds after real work in an earlier DO lifetime. */
function stored(fieldsEdited: number) {
  return {
    stories_edited: ["the-story"],
    objects_edited: [],
    fields_edited: fieldsEdited,
    sessions: 3,
    last_active: "2026-08-01T00:00:00.000Z",
  };
}

describe("a fresh Durable Object lifetime", () => {
  it("keeps the stored count when the member has not edited yet", () => {
    // The reconnect case: `userFieldSets` has no entry for them at all.
    const result = buildContributionUpdate(stored(54), undefined, true);

    expect(result.fields_edited).toBe(54);
  });

  it("keeps it when the member's set exists but is empty", () => {
    const result = buildContributionUpdate(stored(54), new Set(), true);

    expect(result.fields_edited).toBe(54);
  });

  it("keeps it when this lifetime's count is lower than the stored one", () => {
    const result = buildContributionUpdate(stored(54), new Set(["stories:a:title"]), true);

    expect(result.fields_edited).toBe(54);
  });

  it("takes this lifetime's count when it is higher", () => {
    const fieldSet = new Set([
      "stories:a:title",
      "stories:a:subtitle",
      "stories:a:byline",
    ]);

    const result = buildContributionUpdate(stored(2), fieldSet, false);

    expect(result.fields_edited).toBe(3);
  });

  it("counts from zero for a member with no stored figure", () => {
    const result = buildContributionUpdate(
      { stories_edited: [], objects_edited: [], sessions: 0, last_active: null },
      new Set(["stories:a:title", "stories:a:subtitle"]),
      false,
    );

    expect(result.fields_edited).toBe(2);
  });

  it("leaves the neighbouring fields alone", () => {
    const result = buildContributionUpdate(stored(54), undefined, true);

    // `sessions` is a websocket connection count and must never read as
    // participation, but it is still the caller's to increment.
    expect(result.sessions).toBe(4);
    expect(result.stories_edited).toEqual(["the-story"]);
    expect(result.last_active).toBe("2026-08-01T00:00:00.000Z");
  });
});
