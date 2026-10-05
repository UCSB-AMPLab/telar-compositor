/**
 * The convenor-only config split, enforced where the writes actually land: the
 * Durable Object's Y.Doc.
 *
 * The route action and the config page's own field gates are defence in depth.
 * The Y.Doc is not: `snapshotConfig` writes 23 of the 24 `project_config`
 * columns straight out of the shared document for whoever holds a socket, so a
 * collaborator with a browser console — or any Yjs client — reaches D1 and the
 * published `_config.yml` without the action ever running. Two of the six,
 * `google_sheets_enabled` and `google_sheets_published_url`, have no control on
 * the form at all, so the document is their ONLY write path and the route half
 * guards nothing for them.
 *
 * The failure mode this pins hardest is the opposite one: a collaborator must
 * keep every editorial field — titles, description, author, email, theme, the
 * display toggles, `collection_mode`, `featured_count` — because the homepage
 * autosave and the config page write them through this same map, and a rule
 * that reached them would break editing on every project.
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
// Harness
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
  });
  ydoc.on("afterTransaction", handler);

  return { ydoc, warns, violations };
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
    config.set("logo", "");
    config.set("url", "https://real.example.org");
    config.set("baseurl", "/sitio");
    config.set("story_key", "secreto");
    config.set("include_demo_content", false);
    config.set("google_sheets_enabled", false);
    config.set("google_sheets_published_url", "");
    config.set("collection_mode", false);
    config.set("skip_stories", false);
    config.set("show_on_homepage", true);
    config.set("show_story_steps", true);
    config.set("show_object_credits", true);
    config.set("browse_and_search", true);
    config.set("show_link_on_homepage", true);
    config.set("show_sample_on_homepage", true);
    config.set("featured_count", 4);
  }, null);
  return config;
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
// The trap the model pass sets
// ---------------------------------------------------------------------------

describe("the root-type _item trap", () => {
  it("gives the config root a null _item, so the identity pass's guard skips it", () => {
    const ydoc = new Y.Doc();
    const config = ydoc.getMap<unknown>("config");
    ydoc.transact(() => { config.set("url", "https://x.example.org"); }, null);

    // `extractIdentityMutations` opens with `if (!item || item.deleted) return`.
    // Copied verbatim onto a root type that guard returns on every transaction
    // and the whole pass silently does nothing.
    expect((config as unknown as { _item: unknown })._item).toBeNull();

    // A child of a protected array, by contrast, has one.
    const obj = seedInRoot(ydoc, "objects", { _id: 1, object_id: "olla" });
    expect((obj as unknown as { _item: unknown })._item).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractConfigFieldMutations — the pure pass
// ---------------------------------------------------------------------------

describe("extractConfigFieldMutations", () => {
  function mutationsFor(
    ydoc: Y.Doc,
    role: Role,
    mutate: () => void,
  ) {
    let out: ReturnType<typeof extractConfigFieldMutations> = [];
    const after = (tr: Y.Transaction) => {
      out = extractConfigFieldMutations(ydoc, tr, { userId: 7, role });
    };
    ydoc.on("afterTransaction", after);
    try { ydoc.transact(mutate, fakeSocket(7, role)); }
    finally { ydoc.off("afterTransaction", after); }
    return out;
  }

  it("reports every one of the six with its pre-transaction value", () => {
    for (const key of CONVENOR_ONLY_CONFIG_FIELDS) {
      const ydoc = new Y.Doc();
      const config = seedConfig(ydoc);
      const before = config.get(key);
      const out = mutationsFor(ydoc, "collaborator", () => {
        config.set(key, key === "include_demo_content" || key === "google_sheets_enabled"
          ? true
          : "https://evil.example.org");
      });
      expect(out.map((m) => m.key)).toEqual([key]);
      expect(out[0].previous).toBe(before);
      expect(out[0].yMap).toBe(config);
    }
  });

  it("reports a deletion, which blanks the field just as effectively", () => {
    const ydoc = new Y.Doc();
    const config = seedConfig(ydoc);
    const out = mutationsFor(ydoc, "collaborator", () => { config.delete("url"); });
    expect(out.map((m) => m.key)).toEqual(["url"]);
    expect(out[0].previous).toBe("https://real.example.org");
  });

  it("reports nothing for a convenor", () => {
    const ydoc = new Y.Doc();
    const config = seedConfig(ydoc);
    const out = mutationsFor(ydoc, "convenor", () => {
      config.set("url", "https://new.example.org");
      config.set("google_sheets_enabled", true);
    });
    expect(out).toEqual([]);
  });

  it("reports nothing for the collaborator-writable fields", () => {
    const ydoc = new Y.Doc();
    const config = seedConfig(ydoc);
    const out = mutationsFor(ydoc, "collaborator", () => {
      config.set("theme", "otro");
      config.set("lang", "en");
      config.set("logo", "logo.png");
      config.set("collection_mode", true);
      config.set("featured_count", 9);
      config.set("skip_stories", true);
      config.set("show_on_homepage", false);
    });
    expect(out).toEqual([]);
  });

  it("reports nothing when the write lands on the value already there", () => {
    const ydoc = new Y.Doc();
    const config = seedConfig(ydoc);
    const out = mutationsFor(ydoc, "collaborator", () => {
      config.set("url", "https://real.example.org");
    });
    expect(out).toEqual([]);
  });

  it("ignores a same-named key on a Y.Map that is not the config root", () => {
    const ydoc = new Y.Doc();
    seedConfig(ydoc);
    const obj = seedInRoot(ydoc, "objects", { _id: 1, object_id: "olla", url: "a" });
    const out = mutationsFor(ydoc, "collaborator", () => { obj.set("url", "b"); });
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Through the handler — revert, strike, and the fields that must survive
// ---------------------------------------------------------------------------

describe("convenor-only config fields through the canDelete handler", () => {
  it("reverts a collaborator's write to each of the six and records a strike", () => {
    for (const key of CONVENOR_ONLY_CONFIG_FIELDS) {
      const { ydoc, violations, warns } = makeHarness();
      const config = seedConfig(ydoc);
      const before = config.get(key);
      const ws = fakeSocket(7, "collaborator");

      ydoc.transact(() => {
        config.set(key, typeof before === "boolean" ? !before : "https://evil.example.org");
      }, ws);

      expect(config.get(key)).toBe(before);
      expect(violations).toHaveLength(1);
      expect(warns.join("\n")).toContain("config");
    }
  });

  it("reverts the two fields the form never writes — the unguarded pair", () => {
    const { ydoc, violations } = makeHarness();
    const config = seedConfig(ydoc);
    const ws = fakeSocket(7, "collaborator");

    ydoc.transact(() => {
      config.set("google_sheets_enabled", true);
      config.set("google_sheets_published_url", "https://docs.example.org/mine/pubhtml");
    }, ws);

    expect(config.get("google_sheets_enabled")).toBe(false);
    expect(config.get("google_sheets_published_url")).toBe("");
    expect(violations).toHaveLength(1);
  });

  it("restores a deleted convenor-only field rather than leaving it absent", () => {
    const { ydoc } = makeHarness();
    const config = seedConfig(ydoc);
    ydoc.transact(() => { config.delete("url"); }, fakeSocket(7, "collaborator"));
    expect(config.get("url")).toBe("https://real.example.org");
  });

  it("clears a convenor-only field that was absent before the write", () => {
    const { ydoc } = makeHarness();
    const config = ydoc.getMap<unknown>("config");
    ydoc.transact(() => { config.set("theme", "trama"); }, null);

    ydoc.transact(() => { config.set("story_key", "mio"); }, fakeSocket(7, "collaborator"));
    expect(config.get("story_key")).toBeUndefined();
  });

  it("reverts a shared type parked on a convenor-only key", () => {
    // `snapshotConfig` stringifies whatever it finds, so a Y.Text at `url` is
    // a write to the site's address by another route.
    const { ydoc, violations } = makeHarness();
    const config = seedConfig(ydoc);
    ydoc.transact(() => {
      config.set("url", new Y.Text("https://evil.example.org"));
    }, fakeSocket(7, "collaborator"));
    expect(config.get("url")).toBe("https://real.example.org");
    expect(violations).toHaveLength(1);
  });

  it("treats an instructor as a collaborator here", () => {
    const { ydoc, violations } = makeHarness();
    const config = seedConfig(ydoc);
    ydoc.transact(() => { config.set("baseurl", "/robado"); }, fakeSocket(9, "instructor"));
    expect(config.get("baseurl")).toBe("/sitio");
    expect(violations).toHaveLength(1);
  });

  it("lets a convenor write all six", () => {
    const { ydoc, violations, warns } = makeHarness();
    const config = seedConfig(ydoc);

    ydoc.transact(() => {
      config.set("url", "https://nuevo.example.org");
      config.set("baseurl", "/nuevo");
      config.set("story_key", "otra-clave");
      config.set("google_sheets_enabled", true);
      config.set("google_sheets_published_url", "https://docs.example.org/hoja/pubhtml");
      config.set("include_demo_content", true);
    }, fakeSocket(1, "convenor"));

    expect(config.get("url")).toBe("https://nuevo.example.org");
    expect(config.get("baseurl")).toBe("/nuevo");
    expect(config.get("story_key")).toBe("otra-clave");
    expect(config.get("google_sheets_enabled")).toBe(true);
    expect(config.get("google_sheets_published_url"))
      .toBe("https://docs.example.org/hoja/pubhtml");
    expect(config.get("include_demo_content")).toBe(true);
    expect(violations).toEqual([]);
    expect(warns).toEqual([]);
  });

  it("leaves an ordinary collaborator editing session untouched and unstruck", () => {
    const { ydoc, violations, warns } = makeHarness();
    const config = seedConfig(ydoc);
    const ws = fakeSocket(7, "collaborator");

    // The config page's own field writes, plus the homepage autosave's.
    ydoc.transact(() => {
      (config.get("title") as Y.Text).insert(0, "Nuevo ");
      (config.get("description") as Y.Text).insert(0, "Mas. ");
      (config.get("author") as Y.Text).insert(0, "Otra ");
      (config.get("email") as Y.Text).delete(0, 6);
      config.set("theme", "otro");
      config.set("lang", "en");
      config.set("logo", "logo.png");
      config.set("collection_mode", true);
      config.set("featured_count", 12);
      config.set("skip_stories", true);
      config.set("show_on_homepage", false);
      config.set("show_story_steps", false);
      config.set("show_object_credits", false);
      config.set("browse_and_search", false);
      config.set("show_link_on_homepage", false);
      config.set("show_sample_on_homepage", false);
    }, ws);

    expect((config.get("title") as Y.Text).toString()).toBe("Nuevo Sitio de prueba");
    expect((config.get("description") as Y.Text).toString()).toBe("Mas. Una descripcion");
    expect((config.get("author") as Y.Text).toString()).toBe("Otra Autora");
    expect((config.get("email") as Y.Text).toString()).toBe("@example.org");
    expect(config.get("theme")).toBe("otro");
    expect(config.get("lang")).toBe("en");
    expect(config.get("logo")).toBe("logo.png");
    expect(config.get("collection_mode")).toBe(true);
    expect(config.get("featured_count")).toBe(12);
    expect(config.get("skip_stories")).toBe(true);
    expect(config.get("show_on_homepage")).toBe(false);
    expect(config.get("show_story_steps")).toBe(false);
    expect(config.get("show_object_credits")).toBe(false);
    expect(config.get("browse_and_search")).toBe(false);
    expect(config.get("show_link_on_homepage")).toBe(false);
    expect(config.get("show_sample_on_homepage")).toBe(false);
    expect(violations).toEqual([]);
    expect(warns).toEqual([]);
  });

  it("keeps the editorial fields even in the transaction that trips the rule", () => {
    const { ydoc, violations } = makeHarness();
    const config = seedConfig(ydoc);

    ydoc.transact(() => {
      config.set("theme", "otro");
      config.set("featured_count", 8);
      config.set("url", "https://evil.example.org");
    }, fakeSocket(7, "collaborator"));

    expect(config.get("theme")).toBe("otro");
    expect(config.get("featured_count")).toBe(8);
    expect(config.get("url")).toBe("https://real.example.org");
    expect(violations).toHaveLength(1);
  });

  it("exempts DO-internal writes, which carry no origin", () => {
    const { ydoc, violations } = makeHarness();
    const config = seedConfig(ydoc);
    ydoc.transact(() => {
      config.set("url", "https://desde-d1.example.org");
      config.set("google_sheets_enabled", true);
    });
    expect(config.get("url")).toBe("https://desde-d1.example.org");
    expect(config.get("google_sheets_enabled")).toBe(true);
    expect(violations).toEqual([]);
  });

  it("closes the socket on the third strike inside the window", () => {
    const { ydoc } = makeHarness();
    const config = seedConfig(ydoc);
    const ws = fakeSocket(7, "collaborator");
    for (let i = 0; i < 3; i++) {
      ydoc.transact(() => { config.set("url", `https://evil-${i}.example.org`); }, ws);
    }
    expect(config.get("url")).toBe("https://real.example.org");
    expect(ws.close).toHaveBeenCalledWith(1008, "Repeated unauthorised delete attempts");
  });

  // -------------------------------------------------------------------------
  // Composition with the passes already in the handler
  // -------------------------------------------------------------------------

  it("composes with the identity pass without double-reverting or double-counting", () => {
    const { ydoc, violations, warns } = makeHarness();
    const config = seedConfig(ydoc);
    const victim = seedInRoot(ydoc, "objects", { _id: 1, object_id: "olla" });
    const mine = seedInRoot(ydoc, "objects", { _id: 2, object_id: "vasija" });

    ydoc.transact(() => {
      mine.set("object_id", "olla");           // identity pass
      config.set("url", "https://evil.example.org"); // config pass
    }, fakeSocket(7, "collaborator"));

    expect(mine.get("object_id")).toBe("vasija");
    expect(victim.get("object_id")).toBe("olla");
    expect(config.get("url")).toBe("https://real.example.org");
    // One transaction, one strike.
    expect(violations).toHaveLength(1);
    expect(warns).toHaveLength(1);
  });

  it("composes with the delete pass — a revert of both in one transaction", () => {
    const { ydoc, violations } = makeHarness();
    const config = seedConfig(ydoc);
    seedInRoot(ydoc, "objects", { _id: 1, object_id: "olla", created_by: 99 });
    const objects = ydoc.getArray<Y.Map<unknown>>("objects");

    ydoc.transact(() => {
      objects.delete(0, 1);
      config.set("story_key", "mio");
    }, fakeSocket(7, "collaborator"));

    // The delete pass restores a rebuilt clone, not the tombstoned original.
    expect(objects.length).toBe(1);
    expect(objects.get(0).get("object_id")).toBe("olla");
    expect(config.get("story_key")).toBe("secreto");
    expect(violations).toHaveLength(1);
  });
});
