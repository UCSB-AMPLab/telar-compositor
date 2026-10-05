/**
 * Row identity is minted by the Durable Object alone: no client-origin
 * transaction may change an identity key on a Y.Map that existed before that
 * transaction.
 *
 * The defect this pins: `extractProtectedFieldMutations` guarded `_id` and
 * `object_id` only on course-marked maps, so on an ordinary site a
 * collaborator could rename their own object's `object_id` onto a victim's
 * slug and let the DO's pre-snapshot dedupe finish the job — no delete, no
 * revert, no strike. The rule here is unconditional on a protected root and
 * needs no `Y.snapshot`, so it also covers the convenor path where the
 * course gate deliberately skips the snapshot.
 *
 * The carve-outs are as load-bearing as the rule. `slug` (pages),
 * `term_id` (glossary) and `story_id` (stories) are shipped rename features; `object_id` on a STEP map
 * is what the media picker writes every time a user picks an object. Each has
 * a test here, and each would go red if the rule were widened to cover it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

import {
  makeCanDeleteHandler,
  makeViolationCounter,
  extractIdentityMutations,
  doOwnedIdentityKeysFor,
  DO_OWNED_IDENTITY_KEYS_BY_ROOT,
  DO_OWNED_IDENTITY_KEYS_BY_NESTED_KEY,
} from "../workers/can-delete";

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
  const sockets: FakeWS[] = [];
  const state = { reverting: false, snapshotting: false };
  const warns: string[] = [];
  const violations: FakeWS[] = [];
  const counter = makeViolationCounter();

  const handler = makeCanDeleteHandler({
    ydoc,
    isSnapshotting: () => state.snapshotting,
    isReverting: () => state.reverting,
    setReverting: (v: boolean) => { state.reverting = v; },
    getSockets: () => sockets as unknown as Iterable<WebSocket>,
    broadcastUpdate: () => {},
    recordViolation: (ws: WebSocket) => {
      violations.push(ws as unknown as FakeWS);
      return counter(ws);
    },
    warn: (msg: string) => { warns.push(msg); },
  });
  ydoc.on("afterTransaction", handler);

  return { ydoc, sockets, warns, violations };
}

/** Seed a Y.Map into a root array with a DO-internal (null) origin. */
function seed(
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

/** Deep-clone a Y.Map the way the client's `cloneYMap` does. */
function cloneYMap(source: Y.Map<unknown>): Y.Map<unknown> {
  const clone = new Y.Map<unknown>();
  for (const [key, value] of source.entries()) {
    if (value instanceof Y.Text) clone.set(key, new Y.Text(value.toString()));
    else if (value instanceof Y.Array) {
      const arr = new Y.Array<unknown>();
      for (let i = 0; i < value.length; i++) {
        const child = value.get(i);
        arr.push([child instanceof Y.Map ? cloneYMap(child) : child]);
      }
      clone.set(key, arr);
    } else if (value instanceof Y.Map) clone.set(key, cloneYMap(value));
    else clone.set(key, value);
  }
  return clone;
}

// ---------------------------------------------------------------------------
// The owned-key table itself
// ---------------------------------------------------------------------------

describe("DO-owned identity keys — the table and its carve-outs", () => {
  it("owns _id and _temp_id on every protected root and nested array", () => {
    for (const [, keys] of DO_OWNED_IDENTITY_KEYS_BY_ROOT) {
      expect(keys.has("_id")).toBe(true);
      expect(keys.has("_temp_id")).toBe(true);
    }
    for (const [, keys] of DO_OWNED_IDENTITY_KEYS_BY_NESTED_KEY) {
      expect(keys.has("_id")).toBe(true);
      expect(keys.has("_temp_id")).toBe(true);
    }
  });

  it("owns the human slug ONLY where no rename feature ships", () => {
    // stories: the story editor's title card renames story_id in place. Carve-out.
    expect(DO_OWNED_IDENTITY_KEYS_BY_ROOT.get("stories")?.has("story_id")).toBe(false);
    // objects: object_id is written only by makeObjectYMap at construction.
    expect(DO_OWNED_IDENTITY_KEYS_BY_ROOT.get("objects")?.has("object_id")).toBe(true);
    // glossary: _app.glossary.tsx renames term_id in place. Carve-out.
    expect(DO_OWNED_IDENTITY_KEYS_BY_ROOT.get("glossary")?.has("term_id")).toBe(false);
    // pages: _app.pages.tsx renames slug in place. Carve-out.
    expect(DO_OWNED_IDENTITY_KEYS_BY_ROOT.get("pages")?.has("slug")).toBe(false);
    // steps: the media picker writes object_id on a pre-existing step map
    // every time a user picks media. Carve-out — scoped by root position.
    expect(DO_OWNED_IDENTITY_KEYS_BY_NESTED_KEY.get("steps")?.has("object_id")).toBe(false);
  });

  it("resolves a Y.Map's owned keys from its position, not its contents", () => {
    const ydoc = new Y.Doc();
    const obj = seed(ydoc, "objects", { _id: 1, object_id: "pot" });
    const story = seed(ydoc, "stories", { _id: 1, story_id: "s" });
    const step = new Y.Map<unknown>();
    ydoc.transact(() => {
      const steps = new Y.Array<Y.Map<unknown>>();
      story.set("steps", steps);
      step.set("_id", 5);
      step.set("object_id", "pot");
      steps.push([step]);
    }, null);

    expect(doOwnedIdentityKeysFor(obj, ydoc)?.has("object_id")).toBe(true);
    expect(doOwnedIdentityKeysFor(step, ydoc)?.has("object_id")).toBe(false);
    expect(doOwnedIdentityKeysFor(step, ydoc)?.has("_id")).toBe(true);

    // A Y.Map outside any protected array is not governed at all.
    const loose = new Y.Map<unknown>();
    ydoc.transact(() => { ydoc.getMap("config").set("x", loose); loose.set("_id", 9); }, null);
    expect(doOwnedIdentityKeysFor(loose, ydoc)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// extractIdentityMutations — the pure pass
// ---------------------------------------------------------------------------

describe("extractIdentityMutations", () => {
  function mutationsFor(ydoc: Y.Doc, mutate: () => void) {
    let out: ReturnType<typeof extractIdentityMutations> = [];
    const after = (tr: Y.Transaction) => { out = extractIdentityMutations(ydoc, tr); };
    ydoc.on("afterTransaction", after);
    try { ydoc.transact(mutate, fakeSocket(7, "collaborator")); }
    finally { ydoc.off("afterTransaction", after); }
    return out;
  }

  it("flags an object_id rewrite on a pre-existing object map, with the pre-value", () => {
    const ydoc = new Y.Doc();
    const obj = seed(ydoc, "objects", { _id: 42, object_id: "mine", created_by: 7 });
    const muts = mutationsFor(ydoc, () => { obj.set("object_id", "victim"); });
    expect(muts).toHaveLength(1);
    expect(muts[0]).toMatchObject({ key: "object_id", previous: "mine" });
    expect(muts[0].yMap).toBe(obj);
  });

  it("flags an _id rewrite and reports an absent pre-value as undefined", () => {
    const ydoc = new Y.Doc();
    const obj = seed(ydoc, "objects", { object_id: "mine", created_by: 7 });
    const muts = mutationsFor(ydoc, () => { obj.set("_id", 42); });
    expect(muts).toHaveLength(1);
    expect(muts[0].key).toBe("_id");
    expect(muts[0].previous).toBeUndefined();
  });

  it("lets a born-in-transaction map set every identity key it likes", () => {
    const ydoc = new Y.Doc();
    seed(ydoc, "objects", { _id: 42, object_id: "victim" });
    const objects = ydoc.getArray<Y.Map<unknown>>("objects");
    const muts = mutationsFor(ydoc, () => {
      const fresh = new Y.Map<unknown>();
      fresh.set("_id", null);
      fresh.set("_temp_id", "uuid-new");
      fresh.set("object_id", "brand-new");
      objects.push([fresh]);
    });
    expect(muts).toEqual([]);
  });

  it("does not flag a non-identity field on a pre-existing map", () => {
    const ydoc = new Y.Doc();
    const obj = seed(ydoc, "objects", { _id: 42, object_id: "mine", title: new Y.Text("a") });
    const muts = mutationsFor(ydoc, () => { obj.set("credit", "x"); });
    expect(muts).toEqual([]);
  });

  it("does not flag a rewrite that lands on the same value", () => {
    const ydoc = new Y.Doc();
    const obj = seed(ydoc, "objects", { _id: 42, object_id: "mine" });
    const muts = mutationsFor(ydoc, () => { obj.set("object_id", "mine"); });
    expect(muts).toEqual([]);
  });

  it("ignores a map the same transaction deleted (the delete passes own it)", () => {
    const ydoc = new Y.Doc();
    const obj = seed(ydoc, "objects", { _id: 42, object_id: "mine", created_by: 7 });
    const objects = ydoc.getArray<Y.Map<unknown>>("objects");
    const muts = mutationsFor(ydoc, () => {
      obj.set("object_id", "victim");
      objects.delete(0, 1);
    });
    expect(muts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A rename onto a victim's slug, through the installed handler
// ---------------------------------------------------------------------------

describe("rename onto a victim's slug", () => {
  function seedTwoObjects(ydoc: Y.Doc) {
    const victim = seed(ydoc, "objects", {
      _id: 42, _temp_id: "uuid-victim", object_id: "vasija-muisca", created_by: 1,
      title: new Y.Text("Vasija"),
    });
    const attacker = seed(ydoc, "objects", {
      _id: 99, _temp_id: "uuid-attacker", object_id: "my-thing", created_by: 7,
      title: new Y.Text("Mine"),
    });
    return { victim, attacker };
  }

  it("reverts the rename and records a strike", () => {
    const h = makeHarness();
    const { victim, attacker } = seedTwoObjects(h.ydoc);
    const ws = fakeSocket(7, "collaborator");

    h.ydoc.transact(() => { attacker.set("object_id", "vasija-muisca"); }, ws);

    expect(attacker.get("object_id")).toBe("my-thing");
    expect(victim.get("object_id")).toBe("vasija-muisca");
    expect(h.violations).toHaveLength(1);
    expect(h.warns.join("\n")).toMatch(/reverted/);
  });

  it("reverts the rename even when the same transaction also reorders", () => {
    // The drag is clone-delete-insert; the rename rides on the pre-existing
    // map before it is cloned away. The clone is born in the transaction, so
    // the rule does not reach it — but the rename on the original does.
    const h = makeHarness();
    const { victim, attacker } = seedTwoObjects(h.ydoc);
    const objects = h.ydoc.getArray<Y.Map<unknown>>("objects");
    const ws = fakeSocket(7, "collaborator");

    h.ydoc.transact(() => { attacker.set("object_id", "vasija-muisca"); }, ws);
    expect(attacker.get("object_id")).toBe("my-thing");

    // The reorder alone, in its own transaction, is a faithful move.
    h.ydoc.transact(() => {
      const clone = cloneYMap(objects.get(1));
      objects.delete(1, 1);
      objects.insert(0, [clone]);
    }, ws);

    const slugs = objects.toArray().map((m) => m.get("object_id"));
    expect(slugs).toEqual(["my-thing", "vasija-muisca"]);
    expect(victim.get("_id")).toBe(42);
  });

  it("reverts an _id theft onto a pre-existing map", () => {
    const h = makeHarness();
    const { attacker } = seedTwoObjects(h.ydoc);
    const ws = fakeSocket(7, "collaborator");

    h.ydoc.transact(() => { attacker.set("_id", 42); }, ws);

    expect(attacker.get("_id")).toBe(99);
    expect(h.violations).toHaveLength(1);
  });

  it("catches the rename on a convenor socket, where no snapshot is taken", () => {
    // `beforeTransaction` skips the snapshot for a convenor when the document
    // holds no course item. The identity pass reads pre-values from
    // tr.beforeState, so it does not care.
    const h = makeHarness();
    const { attacker } = seedTwoObjects(h.ydoc);
    h.ydoc.transact(() => { attacker.set("object_id", "vasija-muisca"); }, fakeSocket(2, "convenor"));
    expect(attacker.get("object_id")).toBe("my-thing");
    expect(h.violations).toHaveLength(1);
  });

  it("closes the socket after three identity writes in the window", () => {
    const h = makeHarness();
    const { attacker } = seedTwoObjects(h.ydoc);
    const ws = fakeSocket(7, "collaborator");
    for (const slug of ["a", "b", "c"]) {
      h.ydoc.transact(() => { attacker.set("object_id", slug); }, ws);
    }
    expect(ws.close).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Everything the rule must NOT break
// ---------------------------------------------------------------------------

describe("carve-outs and pass-throughs", () => {
  it("lets a page slug rename through (shipped rename feature)", () => {
    const h = makeHarness();
    const page = seed(h.ydoc, "pages", { _id: 5, slug: "about", created_by: 7 });
    h.ydoc.transact(() => { page.set("slug", "acerca"); }, fakeSocket(7, "collaborator"));
    expect(page.get("slug")).toBe("acerca");
    expect(h.violations).toEqual([]);
  });

  it("lets a glossary term_id rename through (shipped rename feature)", () => {
    const h = makeHarness();
    const term = seed(h.ydoc, "glossary", { _id: 5, term_id: "muisca", created_by: 7 });
    h.ydoc.transact(() => { term.set("term_id", "muysca"); }, fakeSocket(7, "collaborator"));
    expect(term.get("term_id")).toBe("muysca");
    expect(h.violations).toEqual([]);
  });

  it("lets a story_id rename through", () => {
    const h = makeHarness();
    const story = seed(h.ydoc, "stories", { _id: 5, story_id: "blank_template", created_by: 7 });
    h.ydoc.transact(() => { story.set("story_id", "fluidity-of-process"); }, fakeSocket(7, "collaborator"));
    expect(story.get("story_id")).toBe("fluidity-of-process");
    expect(h.violations).toEqual([]);
  });

  it("lets the media picker write object_id on a pre-existing STEP map", () => {
    const h = makeHarness();
    const story = seed(h.ydoc, "stories", { _id: 3, story_id: "s", created_by: 7 });
    let step!: Y.Map<unknown>;
    h.ydoc.transact(() => {
      const steps = new Y.Array<Y.Map<unknown>>();
      story.set("steps", steps);
      step = new Y.Map<unknown>();
      step.set("_id", 11);
      step.set("_temp_id", "uuid-step");
      step.set("object_id", "");
      step.set("created_by", 7);
      steps.push([step]);
    }, null);

    h.ydoc.transact(() => { step.set("object_id", "vasija-muisca"); }, fakeSocket(7, "collaborator"));
    expect(step.get("object_id")).toBe("vasija-muisca");
    expect(h.violations).toEqual([]);
  });

  it("lets the DO's own null-origin _id backfill through", () => {
    const h = makeHarness();
    const obj = seed(h.ydoc, "objects", { _id: null, object_id: "mine", created_by: 7 });
    h.ydoc.transact(() => { obj.set("_id", 42); }, null);
    expect(obj.get("_id")).toBe(42);
    expect(h.violations).toEqual([]);
  });

  it("does not classify a faithful reorder built with cloneYMap", () => {
    const h = makeHarness();
    seed(h.ydoc, "objects", { _id: 42, _temp_id: "a", object_id: "one", created_by: 7, title: new Y.Text("A") });
    seed(h.ydoc, "objects", { _id: 43, _temp_id: "b", object_id: "two", created_by: 7, title: new Y.Text("B") });
    const objects = h.ydoc.getArray<Y.Map<unknown>>("objects");

    h.ydoc.transact(() => {
      const clone = cloneYMap(objects.get(1));
      objects.delete(1, 1);
      objects.insert(0, [clone]);
    }, fakeSocket(7, "collaborator"));

    expect(objects.toArray().map((m) => m.get("object_id"))).toEqual(["two", "one"]);
    expect(objects.toArray().map((m) => m.get("_id"))).toEqual([43, 42]);
    expect(h.violations).toEqual([]);
  });

  it("lets an undo of a delete restore a map carrying its original _id", () => {
    // MEASURED, not assumed: Yjs's UndoManager cannot resurrect the original
    // items, so the restore is a fresh Y.Map whose items post-date the DO's
    // beforeState. It is born-in-transaction on the server side, and the rule
    // — scoped to maps that existed before the transaction — never sees it.
    const h = makeHarness();
    const client = new Y.Doc();
    const undo = new Y.UndoManager([client.getArray("objects")], {
      captureTimeout: 0,
      trackedOrigins: new Set([null]),
    });
    const ws = fakeSocket(7, "collaborator");
    const pump = (from: Y.Doc, to: Y.Doc, origin: unknown) =>
      Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), origin);

    client.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("_id", null);
      m.set("_temp_id", "uuid-1");
      m.set("object_id", "mine");
      m.set("created_by", 7);
      client.getArray<Y.Map<unknown>>("objects").push([m]);
    }, null);
    pump(client, h.ydoc, ws);

    // The DO mints the row id and the client adopts it.
    h.ydoc.transact(() => { h.ydoc.getArray<Y.Map<unknown>>("objects").get(0).set("_id", 42); }, null);
    pump(h.ydoc, client, "provider");

    client.transact(() => { client.getArray("objects").delete(0, 1); }, null);
    pump(client, h.ydoc, ws);
    expect(h.ydoc.getArray("objects").length).toBe(0);

    undo.undo();
    pump(client, h.ydoc, ws);

    const restored = h.ydoc.getArray<Y.Map<unknown>>("objects");
    expect(restored.length).toBe(1);
    expect(restored.get(0).get("_id")).toBe(42);
    expect(restored.get(0).get("object_id")).toBe("mine");
    expect(h.violations).toEqual([]);
  });
});

describe("claim authorship, then delete", () => {
  /**
   * The own-content delete rule reads `created_by` off the deleted map at the
   * before-transaction snapshot. Nothing gated a write to it, so any
   * collaborator took any entity in two ordinary transactions: claim it, then
   * delete it as their own. Reproduced against the real Durable Object during
   * the Wave 1-C review — no revert, no strike, row gone at the next snapshot.
   *
   * `created_by` is not an identity key, but its rule is the identity rule
   * exactly: the client mints it when it creates an entity and may never write
   * it again. That is what this pass already enforces, and why the fix is a
   * table entry rather than a mechanism.
   */

  it("reverts the claim, so the delete that follows is refused", () => {
    const h = makeHarness();
    const victim = seed(h.ydoc, "objects", {
      _id: 42, _temp_id: "uuid-victim", object_id: "vasija-muisca", created_by: 9,
      title: new Y.Text("Vasija"),
    });
    const ws = fakeSocket(2, "collaborator");
    const objects = h.ydoc.getArray<Y.Map<unknown>>("objects");

    // tx1 — claim it.
    h.ydoc.transact(() => { victim.set("created_by", 2); }, ws);
    expect(victim.get("created_by")).toBe(9);
    expect(h.violations).toHaveLength(1);

    // tx2 — the delete the claim was for.
    h.ydoc.transact(() => { objects.delete(0, 1); }, ws);
    expect(objects.length).toBe(1);
    expect(objects.get(0).get("created_by")).toBe(9);
  });

  it("refuses the claim and the delete in one transaction", () => {
    const h = makeHarness();
    seed(h.ydoc, "objects", {
      _id: 42, _temp_id: "uuid-victim", object_id: "vasija-muisca", created_by: 9,
      title: new Y.Text("Vasija"),
    });
    const ws = fakeSocket(2, "collaborator");
    const objects = h.ydoc.getArray<Y.Map<unknown>>("objects");

    h.ydoc.transact(() => {
      objects.get(0).set("created_by", 2);
      objects.delete(0, 1);
    }, ws);

    // The delete pass reads the pre-transaction value, so the claim never
    // helped; the rebuilt map carries the authorship it always had.
    expect(objects.length).toBe(1);
    expect(objects.get(0).get("created_by")).toBe(9);
  });

  it("guards every kind the own-content rule protects", () => {
    // Four roots and both nested arrays: the rule governs all ordinary
    // content, not only the roots the slug-rename cases above cover.
    const h = makeHarness();
    const ws = fakeSocket(2, "collaborator");
    for (const root of ["stories", "objects", "glossary", "pages"]) {
      const m = seed(h.ydoc, root, { _id: 1, _temp_id: `t-${root}`, created_by: 9 });
      h.ydoc.transact(() => { m.set("created_by", 2); }, ws);
      expect(m.get("created_by"), `${root} was claimable`).toBe(9);
    }
  });

  it("guards a step and a layer", () => {
    const h = makeHarness();
    const ws = fakeSocket(2, "collaborator");
    const story = seed(h.ydoc, "stories", { _id: 1, _temp_id: "s1", created_by: 9 });
    let step!: Y.Map<unknown>;
    let layer!: Y.Map<unknown>;
    h.ydoc.transact(() => {
      const steps = new Y.Array<Y.Map<unknown>>();
      step = new Y.Map<unknown>();
      step.set("_id", 10); step.set("_temp_id", "st1"); step.set("created_by", 9);
      const layers = new Y.Array<Y.Map<unknown>>();
      layer = new Y.Map<unknown>();
      layer.set("_id", 20); layer.set("_temp_id", "l1"); layer.set("created_by", 9);
      layers.push([layer]);
      step.set("layers", layers);
      steps.push([step]);
      story.set("steps", steps);
    }, null);

    h.ydoc.transact(() => { step.set("created_by", 2); }, ws);
    h.ydoc.transact(() => { layer.set("created_by", 2); }, ws);

    expect(step.get("created_by")).toBe(9);
    expect(layer.get("created_by")).toBe(9);
  });

  it("lets a creation write its own authorship", () => {
    // The whole client creation surface does this — every factory in
    // use-structural-ops.ts and makeObjectYMap set `created_by` on a map they
    // have just constructed. A guard that reverted it would break entity
    // creation for everyone on the instance.
    const h = makeHarness();
    const ws = fakeSocket(2, "collaborator");
    const objects = h.ydoc.getArray<Y.Map<unknown>>("objects");

    let born!: Y.Map<unknown>;
    h.ydoc.transact(() => {
      born = new Y.Map<unknown>();
      born.set("_id", null);
      born.set("_temp_id", "uuid-new");
      born.set("object_id", "mi-objeto");
      born.set("created_by", 2);
      objects.push([born]);
    }, ws);

    expect(born.get("created_by")).toBe(2);
    expect(h.violations).toHaveLength(0);
  });

  it("lets the Durable Object write authorship on an existing entity", () => {
    // Null origin: the cold rebuild, the ingest and the recovery backfills all
    // write through it, and none of them may be reverted.
    const h = makeHarness();
    const m = seed(h.ydoc, "objects", { _id: 42, _temp_id: "u", created_by: null });

    h.ydoc.transact(() => { m.set("created_by", 9); }, null);

    expect(m.get("created_by")).toBe(9);
    expect(h.violations).toHaveLength(0);
  });

  it("Yjs itself never reports a map born in the transaction", () => {
    // The premise the creation path rests on, pinned because it is Yjs's
    // behaviour rather than ours: `extractIdentityMutations` walks
    // `tr.changed`, and a Y.Map constructed inside the transaction never
    // appears there — its items post-date `tr.beforeState`. The explicit
    // `isInsertedInTransaction` check is a second line, not the load-bearing
    // one, which is why removing it changes no behaviour. If a Yjs upgrade
    // ever changed this, every entity creation on the instance would start
    // being reverted and this test is what would say so.
    const ydoc = new Y.Doc();
    const arr = ydoc.getArray<Y.Map<unknown>>("objects");
    let born!: Y.Map<unknown>;
    let reported: unknown[] = [];
    ydoc.on("afterTransaction", (tr) => {
      reported = [...tr.changed.keys()].filter((t) => t instanceof Y.Map);
    });

    ydoc.transact(() => {
      born = new Y.Map<unknown>();
      born.set("_temp_id", "u1");
      born.set("created_by", 2);
      arr.push([born]);
    }, { userId: 2 });

    expect(reported).toHaveLength(0);
  });

  it("does not charge a strike for a write that changes nothing", () => {
    const h = makeHarness();
    const m = seed(h.ydoc, "objects", { _id: 42, _temp_id: "u", created_by: 9 });
    const ws = fakeSocket(2, "collaborator");

    h.ydoc.transact(() => { m.set("created_by", 9); }, ws);

    expect(m.get("created_by")).toBe(9);
    expect(h.violations).toHaveLength(0);
  });
});
