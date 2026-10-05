/**
 * `objectOrderChange`: GitHub's order of the rows the two sides share, each as
 * its D1 row, or null when D1 already holds them in that order.
 *
 * Where GitHub's file repeats an `object_id`, the Compositor follows the later
 * occurrence, as the site does: occurrences pair with that id's D1 rows from
 * the end, so the document's one row of the id sits at its last occurrence. A
 * row on one side only is not paired and moves nothing.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { githubSheet, objectOrderChange } from "~/lib/objects.server";
import { repeatedIdIssues, sharedSiteIdIssues } from "~/lib/object-id";

type D1Row = { id: number; object_id: string; order_key: string | null };

/** D1 rows in the order given, keyed so that order is their sheet order. */
function d1(...rows: Array<[number, string]>): D1Row[] {
  return rows.map(([id, objectId], i) => ({ id, object_id: objectId, order_key: `a${i}` }));
}

function repo(...ids: string[]): Array<{ object_id: string }> {
  return ids.map((objectId) => ({ object_id: objectId }));
}

describe("objectOrderChange", () => {
  it("is null when the orders are equal", () => {
    expect(objectOrderChange(repo("a", "b", "c"), d1([1, "a"], [2, "b"], [3, "c"]))).toBeNull();
  });

  it("gives GitHub's order with each row's D1 id when two rows are swapped", () => {
    expect(objectOrderChange(repo("b", "a", "c"), d1([1, "a"], [2, "b"], [3, "c"]))).toEqual({
      order: [
        { objectId: "b", docId: 2 },
        { objectId: "a", docId: 1 },
        { objectId: "c", docId: 3 },
      ],
    });
  });

  it("reads D1's order by key, not by the order the rows arrive in", () => {
    const rows: D1Row[] = [
      { id: 1, object_id: "a", order_key: "a2" },
      { id: 2, object_id: "b", order_key: "a1" },
    ];
    expect(objectOrderChange(repo("b", "a"), rows)).toBeNull();
  });

  it("is null for a row on GitHub only", () => {
    expect(objectOrderChange(repo("a", "new", "b"), d1([1, "a"], [2, "b"]))).toBeNull();
  });

  it("is null for a row in the Compositor only", () => {
    expect(objectOrderChange(repo("a", "b"), d1([1, "a"], [9, "mine"], [2, "b"]))).toBeNull();
  });

  it("is null for a row removed on GitHub", () => {
    expect(objectOrderChange(repo("a", "c"), d1([1, "a"], [2, "b"], [3, "c"]))).toBeNull();
  });

  it("pairs each occurrence of an id twice on both sides with the D1 row of its rank", () => {
    // GitHub: map, x, map. D1: map(1), map(2), x(3). The second map on GitHub
    // is D1's second map row.
    expect(objectOrderChange(repo("map", "x", "map"), d1([1, "map"], [2, "map"], [3, "x"]))).toEqual({
      order: [
        { objectId: "map", docId: 1 },
        { objectId: "x", docId: 3 },
        { objectId: "map", docId: 2 },
      ],
    });
  });

  it("reads one of two map rows moved past a third row as a change", () => {
    expect(objectOrderChange(repo("map", "x", "map"), d1([1, "map"], [2, "map"], [3, "x"]))).not.toBeNull();
  });

  it("is null when two map rows exchange places with nothing else moved", () => {
    expect(objectOrderChange(repo("map", "map", "x"), d1([1, "map"], [2, "map"], [3, "x"]))).toBeNull();
  });

  it("reads a site-id collision (map, map.jpg) swapped as a change", () => {
    expect(objectOrderChange(repo("map.jpg", "map"), d1([1, "map"], [2, "map.jpg"]))).toEqual({
      order: [
        { objectId: "map.jpg", docId: 2 },
        { objectId: "map", docId: 1 },
      ],
    });
  });

  it("leaves the first occurrence on GitHub unpaired when D1 holds fewer rows of the id", () => {
    // GitHub: map, map, x, map. D1: x(3), map(1), map(2). The last two
    // occurrences pair with map1 and map2; the first is unpaired.
    const change = objectOrderChange(repo("map", "map", "x", "map"), d1([3, "x"], [1, "map"], [2, "map"]));
    expect(change).toEqual({
      order: [
        { objectId: "map", docId: 1 },
        { objectId: "x", docId: 3 },
        { objectId: "map", docId: 2 },
      ],
    });
  });

  it("places the one row the Compositor holds of a repeated id at GitHub's last occurrence", () => {
    // GitHub: map, x, map. D1 holds one map, before x: GitHub's last map is after x.
    expect(objectOrderChange(repo("map", "x", "map"), d1([1, "map"], [3, "x"]))).toEqual({
      order: [
        { objectId: "x", docId: 3 },
        { objectId: "map", docId: 1 },
      ],
    });
  });

  it("reads the one row after x as GitHub's order when GitHub's last map is after x", () => {
    expect(objectOrderChange(repo("map", "x", "map"), d1([3, "x"], [1, "map"]))).toBeNull();
  });

  it("pairs a later occurrence with a later D1 row, not the first one again", () => {
    // Pairing every occurrence with D1's first row of the id would pair map(1)
    // twice and lose map(2).
    const change = objectOrderChange(repo("x", "map", "map"), d1([1, "map"], [3, "x"], [2, "map"]));
    expect(change?.order.map((e) => e.docId)).toEqual([3, 1, 2]);
  });
});

describe("githubSheet", () => {
  it("names a held row of a repeated id at GitHub's last occurrence only", () => {
    expect(githubSheet(repo("map", "x", "map"), d1([1, "map"], [3, "x"]))).toEqual([
      { objectId: "x", docId: 3 },
      { objectId: "map", docId: 1 },
    ]);
  });

  it("names a new row of a repeated id at its last occurrence only", () => {
    expect(githubSheet(repo("new", "x", "new"), d1([3, "x"]))).toEqual([
      { objectId: "x", docId: 3 },
      { objectId: "new" },
    ]);
  });
});

describe("the site-id warnings for a repeated object_id", () => {
  it("names each repeated id once, in sheet order", () => {
    expect(repeatedIdIssues([{ object_id: "b" }, { object_id: "a" }, { object_id: "b" }, { object_id: "a" }, { object_id: "c" }], "1.8.0"))
      .toEqual([
        { code: "object_id_repeated", id: "b", sameRowEverywhere: true },
        { code: "object_id_repeated", id: "a", sameRowEverywhere: true },
      ]);
  });

  it("does not read one id repeated as two ids the site reads as one", () => {
    expect(sharedSiteIdIssues([{ object_id: "map" }, { object_id: "map" }], "1.7.0")).toEqual([]);
  });
});
