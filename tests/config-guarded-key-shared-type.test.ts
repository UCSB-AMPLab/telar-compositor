/**
 * The convenor-only config split, closed against the second mutation surface a
 * shared type brings with it.
 *
 * `extractConfigFieldMutations` keys off `tr.changed` and takes only the entry
 * whose type IS the config root. A value that is itself a shared type is a
 * separate Yjs type with its own entry in `tr.changed`: editing the contents of
 * a `Y.Text` sitting at `url` changes that `Y.Text` and never the root, so a
 * pass scoped to the root never runs. `snapshotConfig` stringifies whatever it
 * finds at the key, so the edited contents reach D1 and the published
 * `_config.yml` with no delete issued and no strike recorded.
 *
 * Nothing legitimate parks a shared type on one of the six. What IS legitimate,
 * and what these tests pin hardest, is the four `Y.Text` fields on the same root
 * — `title`, `description`, `author`, `email` — which every collaborator edits
 * character by character through CodeMirror. That path shares the mechanism the
 * rule now watches, so it is checked here at typing volume as well as once.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

import {
  makeCanDeleteHandler,
  makeViolationCounter,
  extractConfigFieldMutations,
} from "../workers/can-delete";
import { CONVENOR_ONLY_CONFIG_FIELDS } from "../app/lib/config-fields";

// ---------------------------------------------------------------------------
// Harness — same shape as tests/config-convenor-only-do.test.ts
// ---------------------------------------------------------------------------

type Role = "convenor" | "collaborator" | "instructor";

interface FakeWS {
  deserializeAttachment: () => { userId: number; role: Role };
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeSocket(userId: number, role: Role): FakeWS {
  return {
    deserializeAttachment: () => ({ userId, role }),
    send: vi.fn(),
    close: vi.fn(),
  };
}

function makeHarness() {
  const ydoc = new Y.Doc();
  const state = { reverting: false, snapshotting: false };
  const warns: string[] = [];
  const violations: FakeWS[] = [];
  const failures: Array<{ userId: number; failures: readonly string[] }> = [];
  const counter = makeViolationCounter();

  const handler = makeCanDeleteHandler({
    ydoc,
    isSnapshotting: () => state.snapshotting,
    isReverting: () => state.reverting,
    setReverting: (v: boolean) => { state.reverting = v; },
    getSockets: () => [] as unknown as Iterable<WebSocket>,
    broadcastUpdate: () => {},
    recordViolation: (ws: WebSocket) => {
      violations.push(ws as unknown as FakeWS);
      return counter(ws);
    },
    warn: (msg: string) => { warns.push(msg); },
    onEnforcementFailure: (d) => { failures.push(d); },
  });
  ydoc.on("afterTransaction", handler);

  return { ydoc, warns, violations, failures };
}

/**
 * Seed the config root the way `buildFromD1Rows` does: Y.Text for the four
 * character-merged fields, plain scalars for the rest, DO-internal origin.
 */
function seedConfig(ydoc: Y.Doc): Y.Map<unknown> {
  const config = ydoc.getMap<unknown>("config");
  ydoc.transact(() => {
    config.set("title", new Y.Text("Sitio de prueba"));
    config.set("description", new Y.Text("Una descripcion"));
    config.set("author", new Y.Text("Autora"));
    config.set("email", new Y.Text("autora@example.org"));
    config.set("lang", "es");
    config.set("theme", "trama");
    config.set("url", "https://real.example.org");
    config.set("baseurl", "/sitio");
    config.set("story_key", "secreto");
    config.set("include_demo_content", false);
    config.set("google_sheets_enabled", false);
    config.set("google_sheets_published_url", "");
    config.set("collection_mode", false);
    config.set("featured_count", 4);
  }, null);
  return config;
}

/**
 * Park a shared type on a config key with a DO-internal origin — the state a
 * document carries when the value predates this rule. A client that assigns one
 * is caught by the root pass, since assignment changes the root; the planted
 * case is what the contents rule exists for.
 */
function plant<T>(ydoc: Y.Doc, config: Y.Map<unknown>, key: string, value: T): T {
  ydoc.transact(() => { config.set(key, value as unknown); }, null);
  return value;
}

/** Seed a Y.Map into a root array with a DO-internal (null) origin. */
function seedInRoot(
  ydoc: Y.Doc,
  root: string,
  fields: Record<string, unknown>,
): Y.Map<unknown> {
  const arr = ydoc.getArray<Y.Map<unknown>>(root);
  let m!: Y.Map<unknown>;
  ydoc.transact(() => {
    m = new Y.Map<unknown>();
    for (const [k, v] of Object.entries(fields)) m.set(k, v);
    arr.push([m]);
  }, null);
  return m;
}

// ---------------------------------------------------------------------------
// The hole: a shared type's own mutation surface
// ---------------------------------------------------------------------------

describe("a shared type parked at a guarded config key", () => {
  it("catches a Y.Text rewritten in place at `url`", () => {
    const { ydoc, violations } = makeHarness();
    const config = seedConfig(ydoc);
    const text = plant(ydoc, config, "url", new Y.Text("https://real.example.org"));

    ydoc.transact(() => {
      text.delete(0, text.length);
      text.insert(0, "https://evil.example.org");
    }, fakeSocket(7, "collaborator"));

    // The attacker's address must not survive anywhere `snapshotConfig` reads.
    expect(String(config.get("url") ?? "")).not.toContain("evil");
    expect(violations).toHaveLength(1);
  });

  it("catches a deletion inside the Y.Text, which blanks the address", () => {
    const { ydoc, violations } = makeHarness();
    const config = seedConfig(ydoc);
    const text = plant(ydoc, config, "url", new Y.Text("https://real.example.org"));

    ydoc.transact(() => { text.delete(0, text.length); }, fakeSocket(7, "collaborator"));

    expect(violations).toHaveLength(1);
  });

  it("catches a Y.Array pushed at `baseurl`", () => {
    const { ydoc, violations } = makeHarness();
    const config = seedConfig(ydoc);
    const arr = plant(ydoc, config, "baseurl", new Y.Array<unknown>());

    ydoc.transact(() => { arr.push(["/robado"]); }, fakeSocket(7, "collaborator"));

    expect(violations).toHaveLength(1);
    expect(config.get("baseurl")).toBeUndefined();
  });

  it("catches a Y.Map written at `story_key`", () => {
    const { ydoc, violations } = makeHarness();
    const config = seedConfig(ydoc);
    const map = plant(ydoc, config, "story_key", new Y.Map<unknown>());

    ydoc.transact(() => { map.set("toString", "mio"); }, fakeSocket(7, "collaborator"));

    expect(violations).toHaveLength(1);
    expect(config.get("story_key")).toBeUndefined();
  });

  it("catches every one of the six", () => {
    for (const key of CONVENOR_ONLY_CONFIG_FIELDS) {
      const { ydoc, violations } = makeHarness();
      const config = seedConfig(ydoc);
      const text = plant(ydoc, config, key, new Y.Text("original"));

      ydoc.transact(() => { text.insert(0, "evil-"); }, fakeSocket(7, "collaborator"));

      expect(violations, `no strike for ${key}`).toHaveLength(1);
      expect(config.get(key), `value left at ${key}`).toBeUndefined();
    }
  });

  it("catches a Y.XmlText, which no allow-list of the three modelled types reaches", () => {
    const { ydoc, violations } = makeHarness();
    const config = seedConfig(ydoc);
    const xml = plant(ydoc, config, "google_sheets_published_url", new Y.XmlText("real"));

    ydoc.transact(() => { xml.insert(0, "https://evil.example.org "); }, fakeSocket(7, "collaborator"));

    expect(violations).toHaveLength(1);
    expect(config.get("google_sheets_published_url")).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Depth — the level a `_item.parent === configRoot` test alone does not reach
  // -------------------------------------------------------------------------

  it("catches a Y.Text nested one level down, inside a Y.Map at `url`", () => {
    const { ydoc, violations } = makeHarness();
    const config = seedConfig(ydoc);
    const outer = new Y.Map<unknown>();
    const inner = new Y.Text("https://real.example.org");
    ydoc.transact(() => {
      outer.set("toString", inner);
      config.set("url", outer);
    }, null);

    ydoc.transact(() => { inner.insert(0, "https://evil.example.org "); },
      fakeSocket(7, "collaborator"));

    expect(violations).toHaveLength(1);
    expect(config.get("url")).toBeUndefined();
  });

  it("catches a Y.Text two levels down, inside a Y.Map inside a Y.Array at `url`", () => {
    const { ydoc, violations } = makeHarness();
    const config = seedConfig(ydoc);
    const arr = new Y.Array<unknown>();
    const mid = new Y.Map<unknown>();
    const inner = new Y.Text("real");
    ydoc.transact(() => {
      mid.set("toString", inner);
      arr.push([mid]);
      config.set("url", arr);
    }, null);

    ydoc.transact(() => { inner.insert(0, "evil"); }, fakeSocket(7, "collaborator"));

    expect(violations).toHaveLength(1);
    expect(config.get("url")).toBeUndefined();
  });

  it("catches an edit deeper than the walk follows rather than waving it through", () => {
    const { ydoc, violations } = makeHarness();
    const config = seedConfig(ydoc);
    const top = new Y.Map<unknown>();
    let cur = top;
    for (let i = 0; i < 60; i++) {
      const next = new Y.Map<unknown>();
      cur.set("n", next);
      cur = next;
    }
    ydoc.transact(() => { config.set("url", top); }, null);

    ydoc.transact(() => { cur.set("evil", 1); }, fakeSocket(7, "collaborator"));

    expect(violations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// What must NOT change — the normal collaborative path
// ---------------------------------------------------------------------------

describe("the four Y.Text fields every collaborator edits", () => {
  it("leaves a character-by-character typing session on `description` unstruck", () => {
    const { ydoc, violations, warns } = makeHarness();
    const config = seedConfig(ydoc);
    const ws = fakeSocket(7, "collaborator");
    const description = config.get("description") as Y.Text;

    const phrase = "Un sitio sobre la historia del Nuevo Reino de Granada. ";
    for (let round = 0; round < 20; round++) {
      for (const ch of phrase) {
        ydoc.transact(() => { description.insert(description.length, ch); }, ws);
      }
    }

    expect(description.toString()).toBe("Una descripcion" + phrase.repeat(20));
    expect(violations).toEqual([]);
    expect(warns).toEqual([]);
  });

  it("leaves title, author and email edits unstruck, including deletes", () => {
    const { ydoc, violations, warns } = makeHarness();
    const config = seedConfig(ydoc);
    const ws = fakeSocket(7, "collaborator");

    ydoc.transact(() => {
      (config.get("title") as Y.Text).insert(0, "Nuevo ");
      (config.get("author") as Y.Text).delete(0, 6);
      (config.get("author") as Y.Text).insert(0, "Otra autora");
      (config.get("email") as Y.Text).delete(0, 6);
    }, ws);

    expect((config.get("title") as Y.Text).toString()).toBe("Nuevo Sitio de prueba");
    expect((config.get("author") as Y.Text).toString()).toBe("Otra autora");
    expect((config.get("email") as Y.Text).toString()).toBe("@example.org");
    expect(violations).toEqual([]);
    expect(warns).toEqual([]);
  });

  it("leaves a Y.Text at a same-named key on an entity map alone", () => {
    // `url` means nothing outside the config root; the rule is positional.
    const { ydoc, violations, warns } = makeHarness();
    seedConfig(ydoc);
    const obj = seedInRoot(ydoc, "objects", { _id: 1, object_id: "olla" });
    const text = new Y.Text("https://museo.example.org");
    ydoc.transact(() => { obj.set("url", text); }, null);

    ydoc.transact(() => { text.insert(0, "x"); }, fakeSocket(7, "collaborator"));

    expect(text.toString()).toBe("xhttps://museo.example.org");
    expect(violations).toEqual([]);
    expect(warns).toEqual([]);
  });

  it("leaves the `navigation` Y.Array on the SAME root alone", () => {
    // `buildFromD1Rows` puts a Y.Array at `config.navigation` and
    // `NavigationEditor` reorders and rewrites its entries from the browser.
    // It is a shared type on the config root, so a rule scoped to "a shared
    // type under config" rather than "under one of the six" would strike every
    // nav edit on every project.
    const { ydoc, violations, warns } = makeHarness();
    const config = seedConfig(ydoc);
    const nav = new Y.Array<unknown>();
    ydoc.transact(() => {
      nav.push([
        { type: "builtin", key: "home", label: "Inicio", visible: true },
        { type: "page", slug: "acerca", label: "Acerca", visible: true },
      ]);
      config.set("navigation", nav);
    }, null);
    const ws = fakeSocket(7, "collaborator");

    // A reorder, then a field rewrite — both of NavigationEditor's write paths.
    ydoc.transact(() => {
      const item = nav.get(0);
      nav.delete(0, 1);
      nav.insert(1, [item]);
    }, ws);
    ydoc.transact(() => {
      const existing = nav.get(0) as Record<string, unknown>;
      nav.delete(0, 1);
      nav.insert(0, [{ ...existing, label: "Sobre el proyecto" }]);
    }, ws);

    expect(nav.length).toBe(2);
    expect((nav.get(0) as { label: string }).label).toBe("Sobre el proyecto");
    expect(violations).toEqual([]);
    expect(warns).toEqual([]);
  });

  it("leaves a story's own nested Y.Text alone", () => {
    const { ydoc, violations, warns } = makeHarness();
    seedConfig(ydoc);
    const story = seedInRoot(ydoc, "stories", { _id: 1, story_key: "s1" });
    const steps = new Y.Array<Y.Map<unknown>>();
    const step = new Y.Map<unknown>();
    const body = new Y.Text("Texto del paso");
    ydoc.transact(() => {
      step.set("body", body);
      steps.push([step]);
      story.set("steps", steps);
    }, null);

    ydoc.transact(() => { body.insert(0, "Mas "); }, fakeSocket(7, "collaborator"));

    expect(body.toString()).toBe("Mas Texto del paso");
    expect(violations).toEqual([]);
    expect(warns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Roles and origins
// ---------------------------------------------------------------------------

describe("who the contents rule applies to", () => {
  it("lets a convenor edit a shared type parked on any of the six", () => {
    const { ydoc, violations, warns } = makeHarness();
    const config = seedConfig(ydoc);
    const text = plant(ydoc, config, "url", new Y.Text("https://real.example.org"));

    ydoc.transact(() => { text.insert(0, "https://nuevo.example.org "); },
      fakeSocket(1, "convenor"));

    expect(violations).toEqual([]);
    expect(warns).toEqual([]);
  });

  it("treats an instructor as a collaborator", () => {
    const { ydoc, violations } = makeHarness();
    const config = seedConfig(ydoc);
    const text = plant(ydoc, config, "story_key", new Y.Text("secreto"));

    ydoc.transact(() => { text.insert(0, "mio"); }, fakeSocket(9, "instructor"));

    expect(violations).toHaveLength(1);
    expect(config.get("story_key")).toBeUndefined();
  });

  it("exempts DO-internal writes, which carry no origin", () => {
    const { ydoc, violations } = makeHarness();
    const config = seedConfig(ydoc);
    const text = plant(ydoc, config, "url", new Y.Text("https://real.example.org"));

    ydoc.transact(() => { text.insert(0, "https://desde-d1.example.org "); });

    expect(violations).toEqual([]);
    expect(String(config.get("url"))).toContain("desde-d1");
  });

  it("stays out of the way while the DO is snapshotting", () => {
    const ydoc = new Y.Doc();
    const state = { reverting: false, snapshotting: false };
    const violations: FakeWS[] = [];
    const handler = makeCanDeleteHandler({
      ydoc,
      isSnapshotting: () => state.snapshotting,
      isReverting: () => state.reverting,
      setReverting: (v: boolean) => { state.reverting = v; },
      getSockets: () => [] as unknown as Iterable<WebSocket>,
      broadcastUpdate: () => {},
      recordViolation: (ws: WebSocket) => { violations.push(ws as unknown as FakeWS); return false; },
      warn: () => {},
    });
    ydoc.on("afterTransaction", handler);
    const config = seedConfig(ydoc);
    const text = plant(ydoc, config, "url", new Y.Text("real"));

    state.snapshotting = true;
    ydoc.transact(() => { text.insert(0, "x"); }, fakeSocket(7, "collaborator"));
    state.snapshotting = false;

    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Composition with the passes already in the handler
// ---------------------------------------------------------------------------

describe("composition", () => {
  it("counts one strike when the same transaction assigns AND edits a shared type", () => {
    // The root pass sees the assignment and the contents rule sees the edit.
    // One (map, key) pair must produce one mutation, one write and one strike.
    const { ydoc, violations, warns } = makeHarness();
    const config = seedConfig(ydoc);

    ydoc.transact(() => {
      const text = new Y.Text("https://evil.example.org");
      config.set("url", text);
      text.insert(0, "x");
    }, fakeSocket(7, "collaborator"));

    // Assignment carries a real pre-value, so the scalar is restored rather
    // than the key being cleared.
    expect(config.get("url")).toBe("https://real.example.org");
    expect(violations).toHaveLength(1);
    expect(warns.filter((w) => w.includes("[canDelete] reverted"))).toHaveLength(1);
    expect(warns.join("\n")).toContain("1 convenor-only config write(s)");
  });

  it("counts one strike for two shared types at two guarded keys", () => {
    const { ydoc, violations, warns } = makeHarness();
    const config = seedConfig(ydoc);
    const a = plant(ydoc, config, "url", new Y.Text("https://real.example.org"));
    const b = plant(ydoc, config, "baseurl", new Y.Text("/sitio"));

    ydoc.transact(() => { a.insert(0, "x"); b.insert(0, "y"); },
      fakeSocket(7, "collaborator"));

    expect(violations).toHaveLength(1);
    expect(warns.join("\n")).toContain("2 convenor-only config write(s)");
  });

  it("composes with the identity pass without double-counting", () => {
    const { ydoc, violations, warns } = makeHarness();
    const config = seedConfig(ydoc);
    const victim = seedInRoot(ydoc, "objects", { _id: 1, object_id: "olla" });
    const mine = seedInRoot(ydoc, "objects", { _id: 2, object_id: "vasija" });
    const text = plant(ydoc, config, "url", new Y.Text("https://real.example.org"));

    ydoc.transact(() => {
      mine.set("object_id", "olla");
      text.insert(0, "https://evil.example.org ");
    }, fakeSocket(7, "collaborator"));

    expect(mine.get("object_id")).toBe("vasija");
    expect(victim.get("object_id")).toBe("olla");
    expect(config.get("url")).toBeUndefined();
    expect(violations).toHaveLength(1);
    expect(warns.filter((w) => w.includes("[canDelete] reverted"))).toHaveLength(1);
  });

  it("composes with the delete pass in one transaction", () => {
    const { ydoc, violations } = makeHarness();
    const config = seedConfig(ydoc);
    seedInRoot(ydoc, "objects", { _id: 1, object_id: "olla", created_by: 99 });
    const objects = ydoc.getArray<Y.Map<unknown>>("objects");
    const text = plant(ydoc, config, "story_key", new Y.Text("secreto"));

    ydoc.transact(() => {
      objects.delete(0, 1);
      text.insert(0, "mio");
    }, fakeSocket(7, "collaborator"));

    expect(objects.length).toBe(1);
    expect(objects.get(0).get("object_id")).toBe("olla");
    expect(config.get("story_key")).toBeUndefined();
    expect(violations).toHaveLength(1);
  });

  it("never reports an enforcement failure for a value a client can author", () => {
    const { ydoc, failures } = makeHarness();
    const config = seedConfig(ydoc);
    const text = plant(ydoc, config, "url", new Y.Text("https://real.example.org"));

    ydoc.transact(() => { text.insert(0, "x"); }, fakeSocket(7, "collaborator"));

    expect(failures).toEqual([]);
  });

  it("closes the socket on the third strike inside the window", () => {
    const { ydoc } = makeHarness();
    const config = seedConfig(ydoc);
    const ws = fakeSocket(7, "collaborator");
    const texts = ["url", "baseurl", "story_key"].map((k) =>
      plant(ydoc, config, k, new Y.Text("original")));

    for (const t of texts) {
      ydoc.transact(() => { t.insert(0, "x"); }, ws);
    }

    expect(ws.close).toHaveBeenCalledWith(1008, "Repeated unauthorised delete attempts");
  });
});

// ---------------------------------------------------------------------------
// The pure pass
// ---------------------------------------------------------------------------

describe("extractConfigFieldMutations over shared-type contents", () => {
  function mutationsFor(ydoc: Y.Doc, role: Role, mutate: () => void) {
    let out: ReturnType<typeof extractConfigFieldMutations> = [];
    const after = (tr: Y.Transaction) => {
      out = extractConfigFieldMutations(ydoc, tr, { userId: 7, role });
    };
    ydoc.on("afterTransaction", after);
    try { ydoc.transact(mutate, fakeSocket(7, role)); }
    finally { ydoc.off("afterTransaction", after); }
    return out;
  }

  it("reports the guarded key, not the shared type, as the map/key to revert", () => {
    const ydoc = new Y.Doc();
    const config = seedConfig(ydoc);
    const text = plant(ydoc, config, "url", new Y.Text("https://real.example.org"));

    const out = mutationsFor(ydoc, "collaborator", () => { text.insert(0, "x"); });

    expect(out).toHaveLength(1);
    expect(out[0].yMap).toBe(config);
    expect(out[0].key).toBe("url");
    // The pre-transaction value of the KEY is the shared type itself, which the
    // executor cannot write back — it clears the key instead.
    expect(out[0].previous).toBe(text);
  });

  it("reports nothing for a convenor", () => {
    const ydoc = new Y.Doc();
    const config = seedConfig(ydoc);
    const text = plant(ydoc, config, "url", new Y.Text("real"));
    expect(mutationsFor(ydoc, "convenor", () => { text.insert(0, "x"); })).toEqual([]);
  });

  it("reports nothing for the four editorial Y.Text fields", () => {
    const ydoc = new Y.Doc();
    const config = seedConfig(ydoc);
    const out = mutationsFor(ydoc, "collaborator", () => {
      (config.get("title") as Y.Text).insert(0, "a");
      (config.get("description") as Y.Text).insert(0, "b");
      (config.get("author") as Y.Text).insert(0, "c");
      (config.get("email") as Y.Text).insert(0, "d");
    });
    expect(out).toEqual([]);
  });
});
