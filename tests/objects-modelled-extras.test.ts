/**
 * The three places a modelled objects field is kept out of the passthrough
 * blob, and out of the published file as a second column claiming a canonical
 * name the framework folds onto one:
 *
 *   - `promoteModelledExtras`   — the pure repair, what it moves and which
 *                                 side wins when both are populated
 *   - the Durable Object load   — where that repair actually runs, because
 *                                 objects' extra_columns lives in the Y.Doc
 *                                 and a D1 write would be overwritten by the
 *                                 next snapshot
 *   - `serializeObjectsCsv`     — the export guard, second line for a blob
 *                                 that has not been through the repair
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

import { promoteModelledExtras } from "~/lib/extra-columns.server";
import { serializeObjectsCsv } from "~/lib/csv-export.server";
import { getYText } from "~/lib/yjs-helpers";

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

import { ProjectCollaborationDO } from "../workers/collaboration";

// ---------------------------------------------------------------------------
// promoteModelledExtras
// ---------------------------------------------------------------------------

describe("promoteModelledExtras", () => {
  it("fills an empty field from the blob and empties the key out of it", () => {
    const r = promoteModelledExtras({ medium: "oil" }, { object_type: "" });
    expect(r.fields).toEqual({ object_type: "oil" });
    expect(r.extras).toEqual({});
    expect(r.removed).toEqual(["medium"]);
    expect(r.changed).toBe(true);
  });

  // The field is the value the Compositor shows and lets the author edit; the
  // blob's has sat in a passthrough column, invisible, since the import. The
  // file must carry one column per canonical name to build at all, so one of
  // them goes — and the visible one is the least-surprise choice.
  it("keeps a populated field and removes the key, whatever the blob says", () => {
    const r = promoteModelledExtras({ medium: "oil" }, { object_type: "tempera" });
    expect(r.fields).toEqual({});
    expect(r.extras).toEqual({});
    expect(r.removed).toEqual(["medium"]);
    expect(r.changed).toBe(true);
  });

  // Blob key order is the sheet's header order, so this is the same
  // last-position rule the parser applies to two columns claiming one name.
  it("takes the LAST spelling when a blob names one field twice", () => {
    const forward = promoteModelledExtras(
      { medium: "oil", tipo_objeto: "tempera" }, { object_type: "" },
    );
    expect(forward.fields).toEqual({ object_type: "tempera" });
    expect(forward.extras).toEqual({});

    const reversed = promoteModelledExtras(
      { tipo_objeto: "tempera", medium: "oil" }, { object_type: "" },
    );
    expect(reversed.fields).toEqual({ object_type: "oil" });
    expect(reversed.extras).toEqual({});
  });

  it("removes every spelling when the field is already set", () => {
    const r = promoteModelledExtras(
      { medium: "oil", tipo_objeto: "tempera" }, { object_type: "gouache" },
    );
    expect(r.fields).toEqual({});
    expect(r.extras).toEqual({});
    expect(r.removed.sort()).toEqual(["medium", "tipo_objeto"]);
  });

  it("matches a key however the author capitalised or spaced it", () => {
    const r = promoteModelledExtras({ "  Medium  ": "oil" }, { object_type: "" });
    expect(r.fields).toEqual({ object_type: "oil" });
    expect(r.extras).toEqual({});
  });

  it("leaves a column of the author's own entirely alone", () => {
    const r = promoteModelledExtras({ notes: "x" }, { object_type: "" });
    expect(r.extras).toEqual({ notes: "x" });
    expect(r.fields).toEqual({});
    expect(r.removed).toEqual([]);
    expect(r.changed).toBe(false);
  });

  it("promotes iiif_manifest onto source_url under the same rule", () => {
    const empty = promoteModelledExtras({ iiif_manifest: "M" }, { source_url: "" });
    expect(empty.fields).toEqual({ source_url: "M" });
    const populated = promoteModelledExtras({ iiif_manifest: "M" }, { source_url: "S" });
    expect(populated.fields).toEqual({});
    expect(populated.extras).toEqual({});
  });

  // A string written into a flag is what the snapshot's validator refuses,
  // taking the object's whole UPDATE with it.
  it("never writes into a non-text field, and drops the key once the field is set", () => {
    const r = promoteModelledExtras({ destacado: "yes" }, { featured: "false" });
    expect(r.fields).toEqual({});
    expect(r.extras).toEqual({});
    expect(r.removed).toEqual(["destacado"]);
  });

  // Identity is never repaired from a passthrough column: this would rename
  // the row to whatever the blob said.
  it("never writes into object_id, even when the id is blank", () => {
    const r = promoteModelledExtras({ id_objeto: "o2" }, { object_id: "" });
    expect(r.fields).toEqual({});
    expect(r.extras).toEqual({ id_objeto: "o2" });
  });

  it("drops an id_objeto key once the row has an id of its own", () => {
    const r = promoteModelledExtras({ id_objeto: "o2" }, { object_id: "o1" });
    expect(r.fields).toEqual({});
    expect(r.extras).toEqual({});
    expect(r.removed).toEqual(["id_objeto"]);
  });

  // Last NON-EMPTY, not last: an empty alias carries nothing to promote, and
  // the equivalent CSV leaves the field empty rather than blanking it.
  it("skips an empty last alias and promotes the one before it", () => {
    const r = promoteModelledExtras({ medium: "oil", object_type: "" }, { object_type: "" });
    expect(r.fields).toEqual({ object_type: "oil" });
    expect(r.extras).toEqual({});
    expect(r.removed.sort()).toEqual(["medium", "object_type"]);
  });

  it("removes an empty modelled key without writing an empty field", () => {
    const r = promoteModelledExtras({ medium: "  " }, { object_type: "" });
    expect(r.fields).toEqual({});
    expect(r.extras).toEqual({});
    expect(r.changed).toBe(true);
  });

  it("keeps every author column when a blob carries both kinds", () => {
    const r = promoteModelledExtras(
      { medium: "oil", notes: "x", provenance: "y" },
      { object_type: "" },
    );
    expect(r.fields).toEqual({ object_type: "oil" });
    expect(r.extras).toEqual({ notes: "x", provenance: "y" });
  });
});

// ---------------------------------------------------------------------------
// The Durable Object load
// ---------------------------------------------------------------------------

/** A DO instance with a document but no sockets, storage or D1 traffic. */
function makeDO() {
  const ctx = {
    getWebSockets: () => [],
    blockConcurrencyWhile: async (cb: () => Promise<void>) => cb(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  const instance = new ProjectCollaborationDO(ctx as never, {} as never);
  return {
    instance,
    ydoc: (instance as unknown as { ydoc: Y.Doc }).ydoc,
    repair: () =>
      (instance as unknown as { promoteModelledObjectExtras: () => void })
        .promoteModelledObjectExtras(),
  };
}

function addObject(
  ydoc: Y.Doc,
  fields: { extra_columns?: string; object_type?: string; source_url?: string },
): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  ydoc.getArray<Y.Map<unknown>>("objects").push([map]);
  ydoc.transact(() => {
    map.set("_id", 1);
    map.set("object_type", new Y.Text(fields.object_type ?? ""));
    map.set("source_url", fields.source_url ?? "");
    map.set("extra_columns", fields.extra_columns ?? "");
  });
  return map;
}

/** An object Y.Map with NO field keys at all, as a document predating them. */
function addBareObject(ydoc: Y.Doc, extraColumns: string): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  ydoc.getArray<Y.Map<unknown>>("objects").push([map]);
  ydoc.transact(() => {
    map.set("_id", 1);
    map.set("extra_columns", extraColumns);
  });
  return map;
}

describe("the DO's objects extra-columns repair", () => {
  it("repairs a stale blob on load", () => {
    const { ydoc, repair } = makeDO();
    const map = addObject(ydoc, { extra_columns: JSON.stringify({ medium: "oil" }) });
    repair();
    expect((map.get("object_type") as Y.Text).toString()).toBe("oil");
    expect(map.get("extra_columns")).toBe("");
  });

  it("lets the editor's value stand and clears the blob", () => {
    const { ydoc, repair } = makeDO();
    const map = addObject(ydoc, {
      object_type: "tempera",
      extra_columns: JSON.stringify({ medium: "oil" }),
    });
    repair();
    expect((map.get("object_type") as Y.Text).toString()).toBe("tempera");
    expect(map.get("extra_columns")).toBe("");
  });

  it("removes the key when the blob agrees with the field", () => {
    const { ydoc, repair } = makeDO();
    const map = addObject(ydoc, {
      object_type: "oil",
      extra_columns: JSON.stringify({ medium: "oil" }),
    });
    repair();
    expect((map.get("object_type") as Y.Text).toString()).toBe("oil");
    expect(map.get("extra_columns")).toBe("");
  });

  // A blob is JSON a previous writer left, not something whose shape is
  // guaranteed. A throw here would fail the load and every publish behind it.
  it.each([
    ["a number", '{"medium":42}', "42"],
    ["a boolean", '{"medium":true}', "true"],
  ])("promotes %s as its text form", (_label, blob, expected) => {
    const { ydoc, repair } = makeDO();
    const map = addObject(ydoc, { extra_columns: blob });
    repair();
    expect((map.get("object_type") as Y.Text).toString()).toBe(expected);
    expect(map.get("extra_columns")).toBe("");
  });

  it.each([
    ["null", '{"medium":null}'],
    ["an array", '{"medium":[1]}'],
    ["an object", '{"medium":{"a":1}}'],
  ])("drops %s, which has no cell form, without throwing", (_label, blob) => {
    const { ydoc, repair } = makeDO();
    const map = addObject(ydoc, { object_type: "kept", extra_columns: blob });
    expect(() => repair()).not.toThrow();
    expect((map.get("object_type") as Y.Text).toString()).toBe("kept");
    expect(map.get("extra_columns")).toBe("");
  });

  it("keeps the author's own columns in the blob while removing the modelled one", () => {
    const { ydoc, repair } = makeDO();
    const map = addObject(ydoc, {
      extra_columns: JSON.stringify({ medium: "oil", notes: "x" }),
    });
    repair();
    expect(JSON.parse(map.get("extra_columns") as string)).toEqual({ notes: "x" });
  });

  // The property that keeps merely opening a project from dirtying a snapshot
  // or crediting anybody with a contribution.
  it("emits no update at all on a healthy document", () => {
    const { ydoc, repair } = makeDO();
    addObject(ydoc, { extra_columns: JSON.stringify({ notes: "x" }) });
    const updates: Uint8Array[] = [];
    ydoc.on("update", (u: Uint8Array) => updates.push(u));
    repair();
    expect(updates).toEqual([]);
  });

  it("emits one update when there is something to repair", () => {
    const { ydoc, repair } = makeDO();
    addObject(ydoc, { extra_columns: JSON.stringify({ medium: "oil" }) });
    const updates: Uint8Array[] = [];
    ydoc.on("update", (u: Uint8Array) => updates.push(u));
    repair();
    expect(updates).toHaveLength(1);
  });

  it("attributes the repair to nobody", () => {
    const { ydoc, repair } = makeDO();
    addObject(ydoc, { extra_columns: JSON.stringify({ medium: "oil" }) });
    const origins: unknown[] = [];
    ydoc.on("afterTransaction", (tr: Y.Transaction) => origins.push(tr.origin));
    repair();
    expect(origins).toEqual([null]);
  });

  // The repair runs before the document is admitted, so an exception in it
  // fails the load and every publish snapshot behind it — a worse outcome than
  // the stale column it exists to fix. Driven through `documentRepairs`, which
  // is where the wrap lives; the repair itself is made to throw so the wrap is
  // the only thing under test.
  it("does not fail the document's repairs when it throws", () => {
    const { instance } = makeDO();
    const target = instance as unknown as {
      promoteModelledObjectExtras: () => void;
      documentRepairs: () => void;
    };
    target.promoteModelledObjectExtras = () => {
      throw new Error("planted");
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => target.documentRepairs()).not.toThrow();
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  // The representation belongs to the FIELD, not to whatever occupies its key.
  // A document predating the key has nothing there, and a plain string written
  // into a collaborative field is read as absent by `getYText` — the editor
  // then keeps every later edit local instead of sending it.
  it("creates a collaborative field as a Y.Text, not a plain string", () => {
    const { ydoc, repair } = makeDO();
    const map = addBareObject(ydoc, JSON.stringify({ titulo: "Promoted title" }));
    repair();
    const written = map.get("title");
    expect(written).toBeInstanceOf(Y.Text);
    expect((written as Y.Text).toString()).toBe("Promoted title");
    expect(getYText(map, "title")).not.toBeNull();
  });

  it("creates a passthrough field as a plain string", () => {
    const { ydoc, repair } = makeDO();
    const map = addBareObject(ydoc, JSON.stringify({ iiif_manifest: "M" }));
    repair();
    expect(map.get("source_url")).toBe("M");
    expect(map.get("source_url")).not.toBeInstanceOf(Y.Text);
  });

  // Publish already degrades to {} on a corrupt blob, so it emits no column to
  // collide with; rewriting it here would destroy what a recovery might read.
  it("leaves a corrupt blob exactly as it is", () => {
    const { ydoc, repair } = makeDO();
    const map = addObject(ydoc, { extra_columns: "{not json" });
    repair();
    expect(map.get("extra_columns")).toBe("{not json");
  });
});

// ---------------------------------------------------------------------------
// The export guard
// ---------------------------------------------------------------------------

describe("serializeObjectsCsv modelled-column guard", () => {
  // Header COUNTS cannot see the defect: under it the second column is spelled
  // `medium`, so there is still exactly one literal `medium_genre`. The check
  // that distinguishes them is the framework's own, in
  // tests/objects-publish-parity.test.ts. What is asserted here is the part
  // that file cannot see — which value reaches the cell.
  const row = (extra: Record<string, string>) => ({
    object_id: "o1",
    title: "A",
    featured: false,
    creator: null,
    description: null,
    source_url: null,
    period: null,
    year: null,
    medium_genre: "editor value",
    subjects: null,
    source: null,
    credit: null,
    thumbnail: null,
    alt_text: null,
    dimensions: null,
    extra_columns: JSON.stringify(extra),
  });

  const cellsOf = (csv: string) => {
    const lines = csv.split("\n");
    const header = lines[0].split(",");
    const data = lines[2].split(",");
    const out: Record<string, string> = {};
    header.forEach((h, i) => { out[h] = data[i] ?? ""; });
    return out;
  };

  it("publishes the field's value, not a blob key of the same name", () => {
    const cells = cellsOf(serializeObjectsCsv([row({ medium_genre: "stale" })] as never));
    expect(cells.medium_genre).toBe("editor value");
  });

  it("treats a differently-cased blob key the same way", () => {
    const cells = cellsOf(serializeObjectsCsv([row({ Medium_Genre: "stale" })] as never));
    expect(cells.medium_genre).toBe("editor value");
    expect(Object.keys(cells)).not.toContain("Medium_Genre");
  });

  it("still publishes a column the author invented", () => {
    const cells = cellsOf(serializeObjectsCsv([row({ notes: "mine" })] as never));
    expect(cells.notes).toBe("mine");
  });

  it("drops every modelled spelling, not only medium", () => {
    const csv = serializeObjectsCsv([
      row({ medium: "a", object_type: "b", tipo_objeto: "c", iiif_manifest: "d", "crédito": "e" }),
    ] as never);
    const header = csv.split("\n")[0].split(",");
    for (const name of ["medium", "object_type", "tipo_objeto", "iiif_manifest", "crédito"]) {
      expect(header).not.toContain(name);
    }
  });
});
