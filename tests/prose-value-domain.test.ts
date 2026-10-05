/**
 * What a prose key may hold, and what D1 does with the rest.
 *
 * The snapshot bound the entity prose columns through a RENDER, which
 * stringifies whatever stands at the key: a container planted at
 * `objects.title` wrote `[object Object]` over the title D1 held, and the site
 * published it. Config already reads its four prose keys through a DOMAIN and
 * leaves a column it cannot read out of the UPDATE; this suite pins that rule
 * extended to the twenty-eight entity prose fields.
 *
 * The rule, in three parts:
 *
 *   - IN DOMAIN is a `Y.Text` that renders — by `instanceof`, so a subclass
 *     standing at the key, which the editor binds and edits in place, persists
 *     — or a plain string, which is what the author sees when the bind is
 *     null. A subclass renders as its characters and neither its embeds nor
 *     its markup, so the type holding a key decides nothing about what the key
 *     means.
 *   - HOLD is `null` bound against `col = COALESCE(?, col)`: D1 keeps the value
 *     it has and the site goes on publishing it. An absent key and an empty
 *     text still CLEAR, because only null holds.
 *   - INSERT has no prior value to hold, so an unreadable one binds `""`. Never
 *     null: `project_pages.title` is NOT NULL and a null there fails the
 *     statement rather than holding anything.
 *
 * A prose key also decides an IDENTIFIER: a glossary term's permanent
 * `term_id` is minted from its title, so what the domain accepts at `title`
 * changes which branch the mint takes — a held title falls back to the term's
 * temp id, and a readable one slugs it.
 *
 * The database is the repository's own migration chain in memory, not a
 * statement recorder, because the claim under test is about what D1 HOLDS
 * after the batch — a recorder can show a null bind and say nothing about
 * whether the column survived it. Each UPDATE case runs twice: against a
 * populated column and against a NULL one, which is where `COALESCE` and a
 * blanket "write the old value back" part company.
 *
 * Selection is the registry's, here as well as in the code under test: the
 * field lists are read off `YDOC_FIELDS`, so a field whose declared kind
 * changes moves in this suite too and cannot be pinned to a stale list.
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

// The sync diff is the real one, so the repo side has to come from somewhere:
// these four are every function `sync.server` reaches GitHub through. Only
// `getFileContent` and `getRepoTree` are on the two-way objects path; the other
// two are stubbed because a factory mock replaces the whole module.
vi.mock("~/lib/github.server", async () => {
  const { strictReadsFromFileContent } = await import("./helpers/strict-sheet-read");
  const getFileContent = vi.fn(async () => "");
  return {
    getFileContent,
    // objects.csv is read strictly at the sync's head, from the file the case
    // serves through getFileContent.
    getFileAtRef: vi.fn(strictReadsFromFileContent(getFileContent, async () => ({ status: "absent" as const }))),
    getRepoTree: vi.fn(async () => ({ tree: [] as unknown[] })),
    getRepoHead: vi.fn(async () => null),
  };
});

import type { ProjectCollaborationDO } from "../workers/collaboration";
import { signInternalMarker } from "../workers/auth";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import { YDOC_FIELDS } from "~/lib/field-registry";
import { readProse } from "~/lib/value-domains";
import { countWords } from "~/lib/contributions";
import { getFileContent } from "~/lib/github.server";
import { computeSyncDiff } from "~/lib/sync.server";
import { serializeObjectsCsv } from "~/lib/csv-export.server";
import { getDb } from "~/lib/db.server";
import { proseInsertBind, proseUpdateBind, resolveActivityEntity } from "../workers/collaboration-helpers";
import {
  PROJECT_ID,
  SECRET,
  type ProseEntity,
  type DocMaps,
  proseFields,
  NOT_NULL_COLUMNS,
  seededText,
  seedProject,
  seedEmptyProject,
  buildDoc,
  locate,
  loadProject,
  plant,
  snapshot,
  loadPlantSnapshot,
} from "./helpers/collaboration-fixture";

// ---------------------------------------------------------------------------
// The values a prose key can hold
// ---------------------------------------------------------------------------

/** A value that converts to no primitive at all: `String(...)` throws on it. */
function unrenderable(): Record<string, unknown> {
  return { toString: null };
}

/**
 * A value that RENDERS, and to something a site would publish.
 *
 * `String(["locked-story"])` is `"locked-story"`, so the render the snapshot
 * used to bind wrote that over the column and the built site carried it. This
 * is the plant the whole change is about, and the one a case using only an
 * unrenderable value cannot distinguish from the render: both a hold and a
 * total render answer `""` for that one.
 */
function renderableContainer(): string[] {
  return ["plantado"];
}

/**
 * A `Y.XmlText` around an embed nothing can convert to a primitive. Its own
 * `toString` walks the embed and throws `TypeError`, and it survives the
 * `yjs_state` round trip, so this is a plant and not a stub.
 *
 * The domain reads it as the characters standing beside the embed, which here
 * is the empty string: the delta converts no embed, so the value's throwing
 * render is never called. The name says what the VALUE does, which is what the
 * cases below plant it for.
 */
function throwingText(host: Y.Map<unknown>, key: string): void {
  const text = new Y.XmlText();
  host.set(key, text);
  text.insertEmbed(0, unrenderable());
}

/**
 * A value that IS `instanceof Y.Text` and whose render throws, with no yjs
 * value behind it.
 *
 * Deliberately a stub, and it has to be one: no value a document can carry
 * reaches the catch in `readProse`, because the delta converts nothing. The
 * catch stands because the render is the value's own code on any subclass, and
 * a guard nothing can exercise is a guard nobody can trust — so the branch is
 * stated here rather than left unproven.
 */
function stubTextWhoseRenderThrows(): Y.Text {
  return Object.create(Y.Text.prototype) as Y.Text;
}

// ---------------------------------------------------------------------------
// The entities, and their prose fields, from the registry
// ---------------------------------------------------------------------------

interface Target {
  entity: ProseEntity;
  table: string;
  /** The row this entity's fixture occupies. */
  where: string;
}

const TARGETS: readonly Target[] = [
  { entity: "stories", table: "stories", where: "id = 1" },
  { entity: "steps", table: "steps", where: "id = 1" },
  { entity: "layers", table: "layers", where: "id = 1" },
  { entity: "objects", table: "objects", where: "id = 1" },
  { entity: "glossary", table: "glossary_terms", where: "id = 1" },
  { entity: "pages", table: "project_pages", where: "id = 1" },
  { entity: "landing", table: "project_landing", where: `project_id = ${PROJECT_ID}` },
];

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/** An internal, marker-signed POST to one of the DO's own routes. */
async function post(
  doInstance: ProjectCollaborationDO,
  op: string,
  body: unknown,
): Promise<Response> {
  const { sigHex, timestamp } = await signInternalMarker(PROJECT_ID, SECRET, op);
  return doInstance.fetch(
    new Request(`https://internal/${op}`, {
      method: "POST",
      headers: {
        "X-Internal-Auth": sigHex,
        "X-Internal-Timestamp": String(timestamp),
        "X-Internal-Project": String(PROJECT_ID),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * An `objects.csv` stating exactly what D1 holds, with `overrides` applied —
 * so the only difference the diff can find is the one the case puts there.
 */
function repoObjectsCsv(overrides: Record<string, unknown>): string {
  const row = onlyRow(memory, "objects");
  return serializeObjectsCsv([{ ...row, ...overrides }] as never);
}

/** The real two-way objects diff, against the repo CSV the mock is serving. */
function objectsDiff() {
  return computeSyncDiff(PROJECT_ID, "token", "owner", "repo", getDb(asD1(memory)));
}

/** One column of one fixture row. */
function columnOf(memory: MemoryD1, target: Target, column: string): unknown {
  const row = memory.raw
    .prepare(`SELECT "${column}" AS v FROM ${target.table} WHERE ${target.where}`)
    .get() as { v: unknown } | undefined;
  return row?.v;
}

/** Every row of one table, for the INSERT cases where ids are minted. */
function onlyRow(memory: MemoryD1, table: string): Record<string, unknown> {
  const rows = memory.raw.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
  expect(rows, `${table} holds ${rows.length} rows, not one`).toHaveLength(1);
  return rows[0];
}

let memory: MemoryD1;

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  memory = createMemoryD1();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 1. The domain itself
// ---------------------------------------------------------------------------

describe("readProse", () => {
  it("takes a Y.Text and returns what it renders", () => {
    // Integrated into a document: a detached `Y.Text` holds its content
    // pending and renders "" until it is, which is a property of yjs and not
    // of the domain.
    const doc = new Y.Doc();
    const host = doc.getMap<unknown>("m");
    host.set("t", new Y.Text("hola"));
    expect(readProse(host.get("t"))).toEqual({ ok: true, value: "hola" });
  });

  it("takes a Y.XmlText, which the editor edits in place wherever one stands", () => {
    const doc = new Y.Doc();
    const host = doc.getMap<unknown>("m");
    const text = new Y.XmlText();
    host.set("t", text);
    text.insert(0, "hola");
    expect(readProse(host.get("t"))).toEqual({ ok: true, value: "hola" });
  });

  // `Y.XmlText.toString()` states more than the characters: it
  // converts every embed to a string and serialises formatting as XML. Both
  // are true answers to "what does this value render as" and rubbish in a CSV
  // cell the site publishes, and both pass a test that asks only whether the
  // value is a `Y.Text`.
  it("takes the characters of a Y.XmlText and neither its embeds nor its markup", () => {
    const doc = new Y.Doc();
    const host = doc.getMap<unknown>("m");
    const embedded = new Y.XmlText();
    const formatted = new Y.XmlText();
    doc.transact(() => {
      host.set("embedded", embedded);
      host.set("formatted", formatted);
      embedded.insert(0, "una vasija ");
      embedded.insertEmbed(11, { image: "vasija.png" });
      formatted.insert(0, "una vasija", { bold: true });
    });

    // What the value's own render says, which is what reached the column.
    expect((host.get("embedded") as Y.Text).toString()).toBe("una vasija [object Object]");
    expect((host.get("formatted") as Y.Text).toString()).toBe("<bold>una vasija</bold>");

    expect(readProse(host.get("embedded"))).toEqual({ ok: true, value: "una vasija " });
    expect(readProse(host.get("formatted"))).toEqual({ ok: true, value: "una vasija" });
  });

  // The reading a plain `Y.Text` already has, which is the whole argument for
  // it: the two types now answer the same question the same way, so what a
  // prose key means does not depend on which of them holds it.
  it("reads an embed out of both types identically", () => {
    const doc = new Y.Doc();
    const host = doc.getMap<unknown>("m");
    const plain = new Y.Text();
    const xml = new Y.XmlText();
    doc.transact(() => {
      host.set("plain", plain);
      host.set("xml", xml);
      for (const text of [plain, xml]) {
        text.insert(0, "una vasija ");
        text.insertEmbed(11, { image: "vasija.png" });
        text.insert(text.length, "de barro");
      }
    });
    expect(readProse(host.get("plain"))).toEqual(readProse(host.get("xml")));
    expect(readProse(host.get("plain"))).toEqual({ ok: true, value: "una vasija de barro" });
  });

  it("takes a plain string, which is what the author sees when the bind is null", () => {
    expect(readProse("hola")).toEqual({ ok: true, value: "hola" });
    expect(readProse("")).toEqual({ ok: true, value: "" });
  });

  it("reads an absent key as missing, and every present value as a value", () => {
    expect(readProse(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(readProse(null)).toEqual({ ok: false, reason: "wrong_type", found: "null" });
  });

  it("refuses a container, a number and a boolean, renderable or not", () => {
    expect(readProse(renderableContainer()))
      .toEqual({ ok: false, reason: "wrong_type", found: "plain-array" });
    expect(readProse({})).toEqual({ ok: false, reason: "wrong_type", found: "plain-object" });
    expect(readProse([])).toEqual({ ok: false, reason: "wrong_type", found: "plain-array" });
    expect(readProse(1810)).toEqual({ ok: false, reason: "wrong_type", found: "number" });
    expect(readProse(false)).toEqual({ ok: false, reason: "wrong_type", found: "boolean" });
    expect(readProse(new Y.Map())).toEqual({ ok: false, reason: "wrong_type", found: "Y.Map" });
  });

  it("reads a value whose own render throws without calling that render", () => {
    const doc = new Y.Doc();
    const host = doc.getMap<unknown>("m");
    throwingText(host, "t");
    expect(() => (host.get("t") as Y.Text).toString()).toThrow(TypeError);
    // The embed is the whole of the value, so the characters beside it are
    // none: the key reads as an empty prose field and clears its column, the
    // same as an empty `Y.Text`.
    expect(readProse(host.get("t"))).toEqual({ ok: true, value: "" });
  });

  it("refuses a render that throws, rather than letting the throw out", () => {
    const read = readProse(stubTextWhoseRenderThrows());
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.reason).toBe("wrong_type");
  });
});


// ---------------------------------------------------------------------------
// 2. HOLD on UPDATE — populated and NULL starting columns
// ---------------------------------------------------------------------------

/** Plant `value()` at every prose key of every entity. */
function plantEverywhere(value: () => unknown): (maps: DocMaps) => void {
  return (maps) => {
    for (const target of TARGETS) {
      for (const { key } of proseFields(target.entity)) {
        maps[target.entity].set(key, value());
      }
    }
  };
}

const PLANTS: ReadonlyArray<readonly [string, () => unknown]> = [
  ["one that renders", renderableContainer],
  ["one that renders nothing", unrenderable],
];

for (const populate of ["text", "null"] as const) {
  const startingFrom = populate === "text" ? "populated" : "NULL";

 for (const [plantName, plantValue] of PLANTS) {
  describe(`a planted prose value (${plantName}) holds every entity column, starting ${startingFrom}`, () => {
    it("leaves every one of the twenty-eight columns exactly as D1 held it", async () => {
      seedProject(memory, populate);
      await loadPlantSnapshot(memory, buildDoc(true), plantEverywhere(plantValue));

      let pinned = 0;
      for (const target of TARGETS) {
        for (const { key, column } of proseFields(target.entity)) {
          const held =
            populate === "text" || NOT_NULL_COLUMNS.has(`${target.entity}.${key}`)
              ? seededText(target.entity, key)
              : null;
          expect(
            columnOf(memory, target, column),
            `${target.table}.${column} did not hold`,
          ).toBe(held);
          pinned += 1;
        }
      }
      // The count is part of the claim: a registry that stopped declaring a
      // field prose would quietly shrink this loop rather than fail it.
      expect(pinned).toBe(28);
    });

    it("writes the prose the document really holds, and holds only the planted column", async () => {
      seedProject(memory, populate);
      await loadPlantSnapshot(memory, buildDoc(true), (maps) => {
        maps.objects.set("description", plantValue());
      });

      const objects = TARGETS.find((t) => t.entity === "objects")!;
      const held = populate === "text" ? seededText("objects", "description") : null;
      expect(columnOf(memory, objects, "description")).toBe(held);
      // Every readable sibling was written from the document, so holding one
      // column is not holding the row.
      expect(columnOf(memory, objects, "title")).toBe("doc objects.title");
      expect(columnOf(memory, objects, "creator")).toBe("doc objects.creator");
      expect(columnOf(memory, objects, "year")).toBe("doc objects.year");
    });
  });
 }
}

/**
 * A `Y.Text` holding only an embed is an EMPTY prose field, and emptiness
 * clears. The rule is stated for the plain type above — "clears a populated
 * column for a Y.Text that holds only an embed" — and the subclass is read
 * against the same rule, so which type stands at a key decides nothing about
 * what the key means.
 *
 * Clearing rather than holding grants a collaborator nothing: anyone who can
 * plant one of these can write an empty plain `Y.Text` at the same key, which
 * clears the column and has since before any of this. What the subclass could
 * do that the plain type could not was freeze a column, and freeze it
 * permanently — the value stands until somebody removes it, and every load
 * after it read the same way.
 */
describe("a Y.Text holding only an embed", () => {
  it("clears its column, and the snapshot runs to completion", async () => {
    seedProject(memory, "text");
    await loadPlantSnapshot(memory, buildDoc(true), (maps) => {
      throwingText(maps.pages, "body");
    });

    const pages = TARGETS.find((t) => t.entity === "pages")!;
    expect(columnOf(memory, pages, "body")).toBe("");
    // The rest of the project persisted, which is what an escaping throw
    // inside the bind would have taken with it.
    expect(columnOf(memory, TARGETS[0], "title")).toBe("doc stories.title");
  });

  it("is read as an empty value, at both bind sites", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<unknown>("m");
    throwingText(map, "title");
    expect(proseUpdateBind("stories", map, "title")).toBe("");
    expect(proseInsertBind("stories", map, "title")).toBe("");
  });

  it("holds the column for a value the domain really cannot read", () => {
    // The hold has a subject still: a container at a prose key is not prose in
    // any reading, so the column keeps what D1 publishes.
    const doc = new Y.Doc();
    const map = doc.getMap<unknown>("m");
    map.set("title", new Y.Map());
    expect(proseUpdateBind("stories", map, "title")).toBeNull();
    expect(proseInsertBind("stories", map, "title")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 3. What is accepted, and still written
// ---------------------------------------------------------------------------

describe("a value the editor can bind is persisted, not held", () => {
  it("writes a plain string at a prose key", async () => {
    seedProject(memory, "text");
    await loadPlantSnapshot(memory, buildDoc(true), (maps) => {
      maps.stories.set("title", "una cadena llana");
    });
    expect(columnOf(memory, TARGETS[0], "title")).toBe("una cadena llana");
  });

  it("writes a Y.XmlText, and keeps writing it across snapshots and in-place edits", async () => {
    seedProject(memory, "text");
    const { doInstance, maps } = await loadProject(memory, buildDoc(true));

    plant(doInstance, maps, () => {
      const text = new Y.XmlText();
      maps.objects.set("title", text);
      text.insert(0, "del repositorio");
    });
    await snapshot(doInstance);
    const objects = TARGETS.find((t) => t.entity === "objects")!;
    expect(columnOf(memory, objects, "title")).toBe("del repositorio");

    // A second snapshot of the unchanged document. D1 agreeing with the
    // document again is what makes the accepted value settled rather than a
    // diff that returns on every read.
    await snapshot(doInstance);
    expect(columnOf(memory, objects, "title")).toBe("del repositorio");

    // And an edit made in place, as the editor's binding makes them.
    plant(doInstance, maps, () => {
      const text = maps.objects.get("title") as Y.Text;
      text.delete(0, text.length);
      text.insert(0, "editado en el sitio");
    });
    await snapshot(doInstance);
    expect(columnOf(memory, objects, "title")).toBe("editado en el sitio");
  });

  it("settles a sync change written into a Y.XmlText, so the differ stops reporting it", async () => {
    seedProject(memory, "text");
    const { doInstance, maps } = await loadProject(memory, buildDoc(true));
    plant(doInstance, maps, () => {
      const text = new Y.XmlText();
      maps.objects.set("title", text);
      text.insert(0, "del sitio");
    });
    await snapshot(doInstance);

    // The repo states a different title for the same object, and nothing else
    // it does not already agree with.
    vi.mocked(getFileContent).mockResolvedValue(
      repoObjectsCsv({ title: "del repositorio" }),
    );
    const before = await objectsDiff();
    expect(before.changedObjects).toHaveLength(1);
    expect(before.changedObjects[0].changedFields).toEqual(["title"]);

    // Accepting it goes through `/ingest-sync`, whose object-update arm calls
    // `replaceYText` — which MUTATES a value that is `instanceof Y.Text`
    // rather than replacing it, so an XmlText stays an XmlText. The route
    // snapshots before it answers.
    const res = await post(doInstance, "ingest-sync", {
      objects: {
        update: [{ objectId: "o1", fields: { title: "del repositorio" }, seen: { title: before.changedObjects[0].d1Values.title } }],
      },
    });
    expect(res.status).toBe(200);
    expect(maps.objects.get("title")).toBeInstanceOf(Y.XmlText);

    // The loop closes: D1 carries the accepted value, so the recomputed diff
    // has nothing left to report. An exact-constructor domain would have
    // refused to persist this XmlText, and the differ would report the same
    // field on every read while the editor went on showing the accepted text.
    const objects = TARGETS.find((t) => t.entity === "objects")!;
    expect(columnOf(memory, objects, "title")).toBe("del repositorio");
    const after = await objectsDiff();
    expect(after.changedObjects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Clearing — hold must swallow neither an empty text nor an absent key
// ---------------------------------------------------------------------------

describe("clearing still clears", () => {
  it("writes an empty column for an empty Y.Text, over a populated one", async () => {
    seedProject(memory, "text");
    await loadPlantSnapshot(memory, buildDoc(true), (maps) => {
      for (const target of TARGETS) {
        for (const { key } of proseFields(target.entity)) {
          maps[target.entity].set(key, new Y.Text(""));
        }
      }
    });
    for (const target of TARGETS) {
      for (const { column } of proseFields(target.entity)) {
        expect(columnOf(memory, target, column), `${target.table}.${column}`).toBe("");
      }
    }
  });

  it("writes an empty column for an absent key, over a populated one", async () => {
    seedProject(memory, "text");
    await loadPlantSnapshot(memory, buildDoc(true), (maps) => {
      for (const target of TARGETS) {
        for (const { key } of proseFields(target.entity)) maps[target.entity].delete(key);
      }
    });
    for (const target of TARGETS) {
      for (const { column } of proseFields(target.entity)) {
        expect(columnOf(memory, target, column), `${target.table}.${column}`).toBe("");
      }
    }
  });
});

/**
 * Two values the rule answers unobviously, pinned so the answers are chosen
 * rather than discovered. Both follow from the domain as stated; neither is
 * what a reader would guess from "hold what cannot be read".
 */
describe("the edges of the domain", () => {
  it("clears a populated column for a Y.Text that holds only an embed", async () => {
    seedProject(memory, "text");
    await loadPlantSnapshot(memory, buildDoc(true), (maps) => {
      const text = new Y.Text();
      maps.stories.set("subtitle", text);
      text.insertEmbed(0, { image: "lamina.jpg" });
    });
    // `Y.Text.toString()` returns the text and skips embeds, so this renders
    // `""` — in domain, and an empty value rather than an unreadable one. The
    // column is cleared, exactly as an empty text clears it.
    expect(columnOf(memory, TARGETS[0], "subtitle")).toBe("");
  });

  it("holds a populated column for a null, which is a value and not an absence", async () => {
    seedProject(memory, "text");
    await loadPlantSnapshot(memory, buildDoc(true), (maps) => {
      maps.stories.set("byline", null);
    });
    // The key is PRESENT and holds something that is not prose, so the column
    // keeps what D1 has. Deleting the key is how a story states it has no
    // byline, and that case clears — see "clearing still clears" above.
    expect(columnOf(memory, TARGETS[0], "byline")).toBe(seededText("stories", "byline"));
  });
});

// ---------------------------------------------------------------------------
// 5. INSERT — "" and never null, for every entity
// ---------------------------------------------------------------------------

describe("on INSERT there is nothing to hold", () => {
  it.each(PLANTS)("binds an empty string for every prose column of every entity (%s)", async (_name, plantValue) => {
    seedEmptyProject(memory);
    await loadPlantSnapshot(memory, buildDoc(false), plantEverywhere(plantValue));

    let pinned = 0;
    for (const target of TARGETS) {
      const row = onlyRow(memory, target.table);
      for (const { column } of proseFields(target.entity)) {
        // `""`, never null: a null bind against `project_pages.title` fails the
        // statement outright, and against every other column it writes NULL
        // where the row an untouched project writes holds an empty string.
        expect(row[column], `${target.table}.${column} on INSERT`).toBe("");
        pinned += 1;
      }
    }
    expect(pinned).toBe(28);
  });

  it("inserts the landing row even though its UPDATE resolves a hold differently", async () => {
    seedEmptyProject(memory);
    await loadPlantSnapshot(memory, buildDoc(false), (maps) => {
      maps.landing.set("welcome_body", unrenderable());
      maps.landing.set("stories_heading", new Y.Text("Historias"));
    });

    // The two statements bound the same five keys from one array before this,
    // so a hold-null placed for the UPDATE reached the INSERT.
    const row = onlyRow(memory, "project_landing");
    expect(row.welcome_body).toBe("");
    expect(row.stories_heading).toBe("Historias");
  });

  it("mints a glossary term_id from the temp id when the title is held", async () => {
    seedEmptyProject(memory);
    await loadPlantSnapshot(memory, buildDoc(false), (maps) => {
      maps.glossary.set("_temp_id", "abcdef0123456789");
      // A plant that RENDERS: the render this replaced would have minted
      // `plantado-abcdef01` as the term's permanent id.
      maps.glossary.set("title", renderableContainer());
    });

    // The INSERT derives a PERMANENT term_id from the rendered title, so the
    // accepted domain decides an identifier and not only a column: with no
    // readable title there is no slug base, and the term is minted under its
    // own temp id rather than under a slug made from a render of the plant.
    const row = onlyRow(memory, "glossary_terms");
    expect(row.title).toBe("");
    expect(row.term_id).toBe("abcdef0123456789");
  });

  it("mints it from the title when the title is readable", async () => {
    seedEmptyProject(memory);
    await loadPlantSnapshot(memory, buildDoc(false), (maps) => {
      maps.glossary.set("_temp_id", "abcdef0123456789");
      maps.glossary.set("title", new Y.Text("Maiz criollo"));
    });
    const row = onlyRow(memory, "glossary_terms");
    expect(row.term_id).toBe("maiz-criollo-abcdef01");
  });
});

// ---------------------------------------------------------------------------
// 6. Lifecycle — hold preserves a column, not a row
// ---------------------------------------------------------------------------

describe("hold preserves a column, not a row", () => {
  it("keeps the adopted row's prose when the incoming value is unreadable", async () => {
    seedProject(memory, "text");
    // A stale `_id` with a live row under the same human key: the flat
    // pipeline claims that row and UPDATEs it. Held fields keep what the
    // adopted row carries; readable ones come from the document.
    await loadPlantSnapshot(memory, buildDoc(true), (maps) => {
      maps.objects.set("_id", 999);
      maps.objects.set("description", renderableContainer());
    });

    const row = onlyRow(memory, "objects");
    expect(row.id).toBe(1);
    expect(row.description).toBe(seededText("objects", "description"));
    expect(row.title).toBe("doc objects.title");
  });

  it("starts a recreated row's held prose empty, because there is nothing to hold", async () => {
    seedProject(memory, "text");
    // A stale `_id` and no live row under the key: the pipeline re-INSERTs
    // under that id, so this is an INSERT and the INSERT rule applies.
    await loadPlantSnapshot(memory, buildDoc(true), (maps) => {
      maps.objects.set("_id", 999);
      maps.objects.set("object_id", "o-new");
      maps.objects.set("year", renderableContainer());
    });

    const row = memory.raw
      .prepare("SELECT * FROM objects WHERE object_id = 'o-new'")
      .get() as Record<string, unknown> | undefined;
    expect(row, "the stale id was not re-inserted").toBeDefined();
    // The branch this case is about, stated rather than assumed: the row is
    // recreated UNDER THE STALE ID, and the row the document left behind is
    // swept. Without both, a plain INSERT beside the surviving row would read
    // as the same pass.
    expect(row!.id).toBe(999);
    expect(memory.raw.prepare("SELECT id FROM objects ORDER BY id").all()).toEqual([{ id: 999 }]);
    expect(row!.year).toBe("");
  });

  it("publishes held prose under a renamed identifier, which the rename decides", async () => {
    seedProject(memory, "text");
    await loadPlantSnapshot(memory, buildDoc(true), (maps) => {
      maps.glossary.set("term_id", "t1-renamed");
      maps.glossary.set("definition", renderableContainer());
    });

    const row = onlyRow(memory, "glossary_terms");
    expect(row.term_id).toBe("t1-renamed");
    expect(row.definition).toBe(seededText("glossary", "definition"));
  });
});

// ---------------------------------------------------------------------------
// 7. Selection is the registry's
// ---------------------------------------------------------------------------

describe("selection comes from the registry, not from a list at the bind site", () => {
  it("reads a key the registry declares ytext against the prose domain", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<unknown>("m");
    map.set("year", 1810);
    expect(proseUpdateBind("objects", map, "year")).toBeNull();
    expect(proseInsertBind("objects", map, "year")).toBe("");
  });

  it("reads a key the registry declares plain as the render it has always been", () => {
    const doc = new Y.Doc();
    const map = doc.getMap<unknown>("m");
    map.set("thumbnail", 1810);
    // `objects.thumbnail` is declared `plain`, so the hold rule does not reach
    // it and the same value binds its render at both sites.
    expect(proseUpdateBind("objects", map, "thumbnail")).toBe("1810");
    expect(proseInsertBind("objects", map, "thumbnail")).toBe("1810");
  });

  it("covers exactly the twenty-eight entity prose fields, config's four excluded", () => {
    const counts = Object.fromEntries(
      TARGETS.map((t) => [t.entity, proseFields(t.entity).length]),
    );
    expect(counts).toEqual({
      stories: 3, steps: 3, layers: 3, objects: 10, glossary: 2, pages: 2, landing: 5,
    });
    // Config's four already hold, through `proseColumn`, and are not this
    // change's business.
    expect(YDOC_FIELDS.config.filter((f) => f.kind === "ytext")).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// 8. What must NOT change
// ---------------------------------------------------------------------------

describe("the hold rule reaches the column binds and nothing else", () => {
  it("leaves the planted value in the document — detection is not repair", async () => {
    seedProject(memory, "text");
    const doInstance = await loadPlantSnapshot(memory, buildDoc(true), (maps) => {
      maps.objects.set("description", unrenderable());
    });
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    expect(ydoc.getArray<Y.Map<unknown>>("objects").get(0).get("description"))
      .toEqual(unrenderable());
  });

  it("still counts words through the render, not through the domain", async () => {
    seedProject(memory, "text");
    // A value the two answers DISAGREE about, present before the load: the
    // render reads `["plantado"]` as one word, the domain reads it as no
    // value at all. On healthy text the two agree, so a case built only from
    // healthy text cannot see which of them the baseline walk uses.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, buildDoc(true));
    doc.transact(() => { locate(doc).objects.set("title", renderableContainer()); });
    const { doInstance } = await loadProject(memory, Y.encodeStateAsUpdate(doc));

    // The baseline is seeded at load, from the same keys, through the total
    // render. Making that exception-safe is separate work that this test
    // does not cover.
    const baseline = (doInstance as unknown as { wordBaseline: Map<string, number> }).wordBaseline;
    expect(baseline.get("objects:1:title")).toBe(1);
    expect(baseline.get("stories:1:title")).toBe(2);
  });

  it("does not disturb the page slug's own COALESCE(NULLIF(...)) rule", async () => {
    seedProject(memory, "text");
    await loadPlantSnapshot(memory, buildDoc(true), (maps) => {
      maps.pages.set("slug", "");
      maps.pages.set("title", renderableContainer());
    });
    const pages = TARGETS.find((t) => t.entity === "pages")!;
    // An empty key keeps the slug D1 holds; the held title keeps its own.
    expect(columnOf(memory, pages, "slug")).toBe("p1");
    expect(columnOf(memory, pages, "title")).toBe(seededText("pages", "title"));
  });

  it("leaves config's four prose columns reading through their own domain", async () => {
    seedProject(memory, "text");
    memory.raw.prepare("UPDATE project_config SET title = ? WHERE project_id = ?")
      .run("Sitio que D1 guarda", PROJECT_ID);
    await loadPlantSnapshot(memory, buildDoc(true), (maps) => {
      const config = (maps.landing.parent as Y.Map<unknown>);
      config.set("title", renderableContainer());
    });
    const row = memory.raw
      .prepare("SELECT title FROM project_config WHERE project_id = ?")
      .get(PROJECT_ID) as { title: string };
    // Held by omission from the UPDATE, which is config's own mechanism and
    // untouched here.
    expect(row.title).toBe("Sitio que D1 guarda");
  });
});

// ---------------------------------------------------------------------------
// 9. A throwing render on the paths outside the column binds
// ---------------------------------------------------------------------------

describe("a throwing render reaching a path outside the column binds", () => {
  it("opens a document whose blob arrives carrying one, and holds the column", async () => {
    seedProject(memory, "text");
    // Built into the blob rather than planted after the load, so the value is
    // present while `seedWordBaseline` walks the prose keys. That walk renders
    // through `yTextToString`, and the walk runs before the document is
    // admitted: a throw there stops the project being opened at all, and
    // nothing below it — the hold, the snapshot, the batch — runs.
    const doc = new Y.Doc();
    Y.applyUpdate(doc, buildDoc(true));
    doc.transact(() => { throwingText(locate(doc).pages, "body"); });

    const { doInstance } = await loadProject(memory, Y.encodeStateAsUpdate(doc));
    await snapshot(doInstance);

    // The field reads as empty, so the first person to write readable words
    // there is credited with all of them; the walk did not stop at the plant.
    const baseline = (doInstance as unknown as { wordBaseline: Map<string, number> }).wordBaseline;
    expect(baseline.get("pages:1:body")).toBe(0);
    expect(baseline.get("pages:1:title")).toBe(countWords("doc pages.title"));
    // The snapshot the load reaches binds the column against its domain, which
    // reads a value holding only an embed as an empty prose field.
    const pages = TARGETS.find((t) => t.entity === "pages")!;
    expect(columnOf(memory, pages, "body")).toBe("");
    // And the rest of the project persists: every other column takes the
    // document's own text.
    expect(columnOf(memory, pages, "title")).toBe("doc pages.title");
    expect(columnOf(memory, TARGETS[0], "title")).toBe("doc stories.title");
  });

  it("labels the activity row empty rather than not writing it", async () => {
    seedProject(memory, "text");
    const { doInstance, maps } = await loadProject(memory, buildDoc(true));
    plant(doInstance, maps, (m) => { throwingText(m.objects, "title"); });
    // The resolver scans the collection for the field path's entity and renders
    // the title it finds. It runs inside the snapshot, before the blob and
    // before the batch, so a throw there loses both.
    (doInstance as unknown as { userFieldSets: Map<number, Set<string>> })
      .userFieldSets.set(1, new Set(["objects:1:title"]));

    await snapshot(doInstance);

    const rows = memory.raw
      .prepare("SELECT entity_type, entity_id, entity_label FROM activity_log WHERE project_id = ?")
      .all(PROJECT_ID) as Array<{ entity_type: string; entity_id: string; entity_label: string | null }>;
    expect(rows).toEqual([{ entity_type: "object", entity_id: "o1", entity_label: null }]);
    // And the column the label would have come from reads the same way the
    // label does: an embed and nothing beside it is an empty field.
    const objects = TARGETS.find((t) => t.entity === "objects")!;
    expect(columnOf(memory, objects, "title")).toBe("");
  });

  it("leaves the activity resolver reading the same keys through the render", async () => {
    seedProject(memory, "text");
    const doInstance = await loadPlantSnapshot(memory, buildDoc(true), (maps) => {
      maps.objects.set("title", renderableContainer());
    });
    const ydoc = (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
    // A render that SUCCEEDS is still the resolver's answer: the column holds
    // against its domain, and the log line carries the render. One answer for
    // D1 and another for a log line, and only a render that THROWS is read as
    // empty.
    const objects = TARGETS.find((t) => t.entity === "objects")!;
    expect(columnOf(memory, objects, "title")).toBe(seededText("objects", "title"));
    expect(resolveActivityEntity(ydoc, "object", "1")).toEqual({
      entityId: "o1",
      entityLabel: "plantado",
    });
  });
});
