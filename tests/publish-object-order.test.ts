/**
 * The order of objects in the publish hash.
 *
 * objects.csv's row order reaches the site, and the syncs make the
 * Compositor's order GitHub's, so an order the Compositor holds and has not
 * published is an unpublished change: the ids both the snapshot and D1 hold,
 * in another relative order. An object added or removed is not a reorder, and
 * a first publish never is. The hash is over the sequence of
 * object_id values in sheet order: D1 row ids are not stable across the
 * snapshot's re-insert, and the document holds one row per object_id, so the
 * sequence of ids names every order the site can see. A snapshot written
 * before the order was hashed has no `objectOrder` and reads as unchanged.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  buildEntityHashes,
  computeChangeSummary,
  ENTITY_HASHES_VERSION,
  type CurrentPublishState,
  type EntityHashes,
  type PublishSnapshot,
} from "~/lib/publish.server";
import { sql, type SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { compareSheetOrder } from "~/lib/objects.server";

type ObjectRow = { id: number; order_key: string | null };

/**
 * The row orders the mock can answer, by the SQL an `orderBy` argument renders
 * to. The sheet order is written out rather than read from
 * `objectsSheetOrder`, so a change to either that clause or the argument
 * `buildEntityHashes` passes reaches the test.
 */
const ORDERS: Record<string, (a: ObjectRow, b: ObjectRow) => number> = {
  '"objects"."order_key" asc, "objects"."id" asc': compareSheetOrder,
  '"objects"."id"': (a, b) => a.id - b.id,
};

const dialect = new SQLiteSyncDialect();

/**
 * A db whose six selects answer, in order: stories, objects, pages, glossary,
 * config, landing. A query given an `orderBy` answers its rows in the order
 * its argument names (see `ORDERS`), and throws for any argument it cannot
 * read; any other query answers its rows as given.
 */
function mockDb(objectRows: ObjectRow[]) {
  const responses: ObjectRow[][] = [[], objectRows, [], [], [], []];
  let at = 0;
  type Compare = ((a: ObjectRow, b: ObjectRow) => number) | null;
  const builder = (compare: Compare): Record<string, unknown> => ({
    select: () => mockQuery(compare),
    from: () => mockQuery(compare),
    where: () => mockQuery(compare),
    limit: () => mockQuery(compare),
    orderBy: (clause: SQL) => {
      const text = dialect.sqlToQuery(sql`${clause}`).sql;
      const order = ORDERS[text];
      if (!order) throw new Error(`mockDb cannot order by ${text}`);
      return mockQuery(order);
    },
  });
  const mockQuery = (compare: Compare) => ({
    ...builder(compare),
    then: (resolve: (v: unknown) => unknown) => {
      const rows = responses[at++] ?? [];
      return Promise.resolve(compare ? [...rows].sort(compare) : rows).then(resolve);
    },
  });
  return builder(null) as unknown as Parameters<typeof buildEntityHashes>[0];
}

function row(id: number, objectId: string, orderKey: string | null = null) {
  return { id, object_id: objectId, order_key: orderKey, title: `Title ${objectId}`, featured: false, extra_columns: null };
}

async function orderHash(rows: Array<ReturnType<typeof row>>): Promise<string> {
  return (await buildEntityHashes(mockDb(rows), 1)).objectOrder;
}

describe("buildEntityHashes: objectOrder", () => {
  it("is the sheet order, whatever order D1 answers the rows in", async () => {
    expect(await orderHash([row(1, "a", "a1"), row(2, "b", "a0")])).toBe('["b","a"]');
    expect(await orderHash([row(2, "b", "a0"), row(1, "a", "a1")])).toBe('["b","a"]');
  });

  it("differs when the order keys put the rows in another order", async () => {
    expect(await orderHash([row(1, "a", "a0"), row(2, "b", "a1")])).not.toBe(
      await orderHash([row(1, "a", "a1"), row(2, "b", "a0")]),
    );
  });

  it("orders rows with the same key by D1 row id", async () => {
    expect(await orderHash([row(9, "a", "a0"), row(3, "b", "a0")])).toBe('["b","a"]');
  });

  it("is the same for the same ids in the same order under other D1 row ids", async () => {
    expect(await orderHash([row(1, "a", "a0"), row(2, "b", "a1")])).toBe(
      await orderHash([row(7, "a", "a0"), row(9, "b", "a1")]),
    );
  });

  it("is empty for a site with no objects", async () => {
    expect(await orderHash([])).toBe("");
  });
});

function hashes(overrides: Partial<EntityHashes> = {}): EntityHashes {
  return {
    version: ENTITY_HASHES_VERSION,
    pages: {},
    stories: {},
    objects: { a: "h-a", b: "h-b" },
    glossary: {},
    navigation: "",
    landing: "",
    settings: "",
    objectOrder: '["a","b"]',
    ...overrides,
  };
}

function state(entityHashes: EntityHashes): CurrentPublishState {
  return {
    entityHashes,
    config: null,
    stories: [],
    objects: [
      { object_id: "a", title: "A" },
      { object_id: "b", title: "B" },
    ],
    pages: [],
    glossary: [],
    allStoryIds: [],
  };
}

function snapshot(entity_hashes: Partial<EntityHashes>): PublishSnapshot {
  return { story_ids: [], object_ids: ["a", "b"], config_hash: "", config_managed: {}, entity_hashes } as unknown as PublishSnapshot;
}

describe("computeChangeSummary: objectOrder", () => {
  it("reads an order other than the snapshot's as changed and not up to date", () => {
    const summary = computeChangeSummary(state(hashes({ objectOrder: '["b","a"]' })), snapshot(hashes()));
    expect(summary.objectOrder).toEqual({ changed: true });
    expect(summary.isUpToDate).toBe(false);
  });

  it("reads the snapshot's order as unchanged and up to date", () => {
    const summary = computeChangeSummary(state(hashes()), snapshot(hashes()));
    expect(summary.objectOrder).toEqual({ changed: false });
    expect(summary.isUpToDate).toBe(true);
  });

  it("reads a snapshot with no objectOrder as unchanged", () => {
    const { objectOrder: _, ...older } = hashes();
    const summary = computeChangeSummary(state(hashes({ objectOrder: '["b","a"]' })), snapshot(older));
    expect(summary.objectOrder).toEqual({ changed: false });
    expect(summary.isUpToDate).toBe(true);
  });

  it("leaves the order unchanged when a field changes and the order does not", () => {
    const summary = computeChangeSummary(state(hashes({ objects: { a: "h-a2", b: "h-b" } })), snapshot(hashes()));
    expect(summary.objectOrder).toEqual({ changed: false });
    expect(summary.objects.modified.map((o) => o.object_id)).toEqual(["a"]);
  });

  it("never reads a first publish as a reorder", () => {
    expect(computeChangeSummary(state(hashes()), null).objectOrder).toEqual({ changed: false });
    expect(computeChangeSummary(state(hashes({ objectOrder: "" })), null).objectOrder).toEqual({ changed: false });
  });

  it("does not read an object added since the snapshot as a reorder", () => {
    const summary = computeChangeSummary(state(hashes({ objectOrder: '["a","b","c"]' })), snapshot(hashes()));
    expect(summary.objectOrder).toEqual({ changed: false });
  });

  it("does not read an object removed since the snapshot as a reorder", () => {
    const summary = computeChangeSummary(
      state(hashes({ objectOrder: '["a","c"]' })), snapshot(hashes({ objectOrder: '["a","b","c"]' })),
    );
    expect(summary.objectOrder).toEqual({ changed: false });
  });

  it("reads two ids both sides hold in another relative order as a reorder, whatever else was added", () => {
    const summary = computeChangeSummary(state(hashes({ objectOrder: '["c","b","a"]' })), snapshot(hashes()));
    expect(summary.objectOrder).toEqual({ changed: true });
  });
});
