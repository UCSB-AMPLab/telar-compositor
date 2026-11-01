/**
 * The story order an import stores.
 *
 * The editor ranks a project's stories by `order`, then by row id, and writes
 * that 0-based rank back when it first loads them. The import stores the same
 * rank, so loading the editor changes nothing and a first publish compared
 * with what the import read names no story as changed. The rows keep their
 * own sequence, which is the insert order the rank breaks ties with.
 *
 * @version v1.5.6-beta
 */

import { describe, it, expect } from "vitest";
import { withDenseStoryOrder } from "~/lib/import.server";

const orders = (rows: { id: string; order?: number | null }[]) =>
  withDenseStoryOrder(rows).map((r) => [r.id, r.order]);

describe("withDenseStoryOrder", () => {
  it("turns project.csv's 1-based numbers into the 0-based rank", () => {
    expect(orders([{ id: "a", order: 1 }, { id: "b", order: 2 }])).toEqual([["a", 0], ["b", 1]]);
  });

  it("ranks by the number, keeping the rows where they are", () => {
    expect(orders([{ id: "a", order: 5 }, { id: "b", order: 2 }, { id: "c", order: 9 }])).toEqual([
      ["a", 1],
      ["b", 0],
      ["c", 2],
    ]);
  });

  it("breaks a tie, and an absent number, by the rows' sequence", () => {
    expect(orders([{ id: "a", order: 3 }, { id: "b" }, { id: "c", order: 3 }, { id: "d", order: null }])).toEqual([
      ["a", 2],
      ["b", 0],
      ["c", 3],
      ["d", 1],
    ]);
  });
});
