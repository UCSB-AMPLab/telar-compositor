/**
 * A minted glossary `term_id` is one no other term holds.
 *
 * A minted `term_id` is PERMANENT: it is written back onto the Y.Map, published
 * into `glossary.csv`, and is what a `[[term]]` reference resolves against. Two
 * terms minted onto one identifier are therefore not a cosmetic duplicate —
 * `glossary_terms` has no UNIQUE index to refuse the second, so both rows
 * persist, and the next snapshot's dedupe pass re-keys one of them, moving an
 * identifier the site already carries.
 *
 * Both halves of the candidate — the temp id and the readable title — are
 * client-writable, so two terms can state the same pair, and a candidate can
 * land on a key another term already holds. A minted candidate is checked
 * against every identifier D1 holds for the project, every one the document
 * carries, and every one this snapshot has already allocated; an adopted
 * term_id is left verbatim, because a rename is the author's.
 *
 * The database is the repository's own migration chain in memory, and the
 * document is built from the field registry, for the same reason the prose
 * value-domain suite uses them: the claim under test is about what D1 HOLDS
 * after the batch, which a statement recorder cannot show.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { createMemoryD1, type MemoryD1 } from "./helpers/d1-memory";
import {
  type DocMaps,
  buildDoc,
  loadPlantSnapshot,
  seedEmptyProject,
  seedProject,
} from "./helpers/collaboration-fixture";

let memory: MemoryD1;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  memory = createMemoryD1();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a minted term_id is one no other term holds", () => {
  /** A second, unkeyed glossary term beside the fixture's own. */
  function secondTerm(maps: DocMaps, tempId: string, title: unknown): void {
    const term = new Y.Map<unknown>();
    term.set("_id", null);
    term.set("term_id", "");
    term.set("_temp_id", tempId);
    term.set("order_key", "a00002");
    term.set("definition", new Y.Text(""));
    (maps.glossary.parent as Y.Array<Y.Map<unknown>>).push([term]);
    term.set("title", title);
  }

  it("separates two unkeyed terms that name the same temp id", async () => {
    seedEmptyProject(memory);
    await loadPlantSnapshot(memory, buildDoc(false), (maps) => {
      maps.glossary.set("_temp_id", "mismo-temporal");
      // Two held titles: neither yields a slug base, so both candidates fall
      // to the shared temp id.
      maps.glossary.set("title", ["uno"]);
      secondTerm(maps, "mismo-temporal", ["dos"]);
    });

    const rows = memory.raw
      .prepare("SELECT term_id FROM glossary_terms ORDER BY id")
      .all() as Array<{ term_id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].term_id).toBe("mismo-temporal");
    expect(rows[1].term_id).toBe("mismo-temporal-2");
  });

  it("separates two terms whose readable titles and temp id both agree", async () => {
    seedEmptyProject(memory);
    await loadPlantSnapshot(memory, buildDoc(false), (maps) => {
      maps.glossary.set("_temp_id", "abcdef0123456789");
      maps.glossary.set("title", new Y.Text("Maiz criollo"));
      secondTerm(maps, "abcdef0123456789", new Y.Text("Maiz criollo"));
    });

    const rows = memory.raw
      .prepare("SELECT term_id FROM glossary_terms ORDER BY id")
      .all() as Array<{ term_id: string }>;
    expect(rows[0].term_id).toBe("maiz-criollo-abcdef01");
    expect(rows[1].term_id).toBe("maiz-criollo-abcdef01-2");
  });

  it("avoids an identifier another term in the document carries but D1 does not yet", async () => {
    seedEmptyProject(memory);
    // Neither term has a row, so D1 can name no identifier at all. The keyed
    // term's `alfa` is ADOPTED rather than minted, so the only place the mint
    // below can learn of it is the document.
    await loadPlantSnapshot(memory, buildDoc(false), (maps) => {
      maps.glossary.set("term_id", "alfa");
      secondTerm(maps, "alfa", ["plantado"]);
    });

    const rows = memory.raw
      .prepare("SELECT term_id FROM glossary_terms ORDER BY id")
      .all() as Array<{ term_id: string }>;
    expect(rows.map((r) => r.term_id)).toEqual(["alfa", "alfa-2"]);
  });

  it("avoids an identifier D1 holds for a term the document no longer carries", async () => {
    seedProject(memory, "text");
    // The fixture's term leaves the document in the same edit that adds the
    // new one, so no Y.Map states `t1` and only D1 can. Its row is swept as an
    // orphan at the end of this pass, but the INSERT is issued first, and an
    // identifier a `[[t1]]` reference still resolves against is not free to
    // hand to a different term.
    await loadPlantSnapshot(memory, buildDoc(true), (maps) => {
      const array = maps.glossary.parent as Y.Array<Y.Map<unknown>>;
      secondTerm(maps, "t1", ["plantado"]);
      array.delete(0, 1);
    });

    const rows = memory.raw
      .prepare("SELECT term_id FROM glossary_terms ORDER BY id")
      .all() as Array<{ term_id: string }>;
    expect(rows.map((r) => r.term_id)).toEqual(["t1-2"]);
  });

  it("avoids an identifier D1 already holds for this project", async () => {
    seedProject(memory, "text");
    // The fixture's row 1 holds `t1`, and its Y.Map holds the same. A new term
    // whose temp id is that identifier must not be minted onto it.
    await loadPlantSnapshot(memory, buildDoc(true), (maps) => {
      secondTerm(maps, "t1", ["plantado"]);
    });

    const rows = memory.raw
      .prepare("SELECT term_id FROM glossary_terms ORDER BY id")
      .all() as Array<{ term_id: string }>;
    expect(rows.map((r) => r.term_id)).toEqual(["t1", "t1-2"]);
  });
});
