/**
 * Every server-side reconciliation key is read by RENDERING whatever the
 * document holds: `deduplicateYArray` takes its key as
 * `String(yArray.get(i).get(entityKey) ?? "")`. Nothing checked what KIND of
 * value stood there, so a `Y.Text`, a plain array, a plain object or a
 * subdocument at a reconciliation key rendered to a colleague's key — and once
 * planted, its contents could be changed without the entity map ever appearing
 * in `tr.changed`, which is what put it beyond every guard.
 *
 * The measured consequence is not a deletion: `deduplicateYArray` deletes only
 * exact-`_id` duplicates and RE-KEYS a human-key collision. The victim's entity
 * becomes `<key>-2` and every reference to the old key — steps, navigation,
 * glossary refs, published CSVs — resolves to the attacker's entity instead.
 *
 * The rule these tests pin is a POSITIVE per-key value domain. A negative test
 * against a list of types is the same defect in a new costume: Yjs stores plain
 * JSON as a map value without wrapping it in an `AbstractType`, so a
 * one-element array at `object_id` answers false to every `instanceof` test and
 * still renders to the victim's key. The array cases below are the ones that
 * catch that.
 *
 * Renaming is untouched, and that is as load-bearing as the rule: `pages.slug`
 * and `glossary.term_id` ship rename features, so the domain constrains the
 * value's KIND and never its content.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";

import {
  makeCanDeleteHandler,
  makeViolationCounter,
  extractIdentityDomainViolations,
  identityDomainKeysFor,
  isIdentityValueInDomain,
  IDENTITY_DOMAIN_KEYS_BY_ROOT,
  IDENTITY_DOMAIN_KEYS_BY_NESTED_KEY,
  DEDUPE_KEY_BY_ROOT,
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

/** Every root, with the human key reconciliation collapses it on. */
const ROOTS: Array<{ root: string; humanKey: string }> =
  [...DEDUPE_KEY_BY_ROOT].map(([root, humanKey]) => ({ root, humanKey }));

/**
 * The value classes no `instanceof` test catches, alongside the one it does.
 * Each is built fresh per use — a Y type can only be integrated once.
 */
const STRUCTURES: Array<{ name: string; make: (rendersAs: string) => unknown }> = [
  { name: "a Y.Text", make: (s) => new Y.Text(s) },
  { name: "a plain JS array", make: (s) => [s] },
  { name: "a plain JS object", make: (s) => ({ toString: () => s }) },
  { name: "a Y.Doc subdocument", make: () => new Y.Doc() },
];

// ---------------------------------------------------------------------------
// The domain itself
// ---------------------------------------------------------------------------

describe("isIdentityValueInDomain", () => {
  it("admits a positive safe integer, null or absence at _id, and nothing else", () => {
    for (const ok of [1, 42, Number.MAX_SAFE_INTEGER, null, undefined]) {
      expect(isIdentityValueInDomain("_id", ok)).toBe(true);
    }
    // NaN is `typeof "number"` and beats the "prefer the persisted copy"
    // tiebreak; 0 is insertRow's refused-INSERT sentinel and never a row id.
    for (const bad of [NaN, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, -Infinity]) {
      expect(isIdentityValueInDomain("_id", bad)).toBe(false);
    }
  });

  it("admits a non-empty string or absence at every other identity key", () => {
    for (const key of ["_temp_id", "object_id", "story_id", "term_id", "slug"]) {
      expect(isIdentityValueInDomain(key, "a-key")).toBe(true);
      expect(isIdentityValueInDomain(key, undefined)).toBe(true);
      // An empty key is one reconciliation refuses to read, and no creation
      // path writes one — all four mint through makeUniqueSlug.
      expect(isIdentityValueInDomain(key, "")).toBe(false);
      expect(isIdentityValueInDomain(key, null)).toBe(false);
      expect(isIdentityValueInDomain(key, 7)).toBe(false);
    }
  });

  it("refuses structure that no instanceof test would catch", () => {
    // The whole reason the rule is positive: only the first of these is an
    // AbstractType, and all four render to the victim's key or to nonsense.
    expect(new Y.Text("victim") instanceof Y.AbstractType).toBe(true);
    expect((["victim"] as unknown) instanceof Y.AbstractType).toBe(false);
    expect(String(["victim"])).toBe("victim");
    for (const { make } of STRUCTURES) {
      expect(isIdentityValueInDomain("object_id", make("victim"))).toBe(false);
      expect(isIdentityValueInDomain("_id", make("7"))).toBe(false);
    }
  });
});

describe("the governed key set", () => {
  it("governs _id, _temp_id and the reconciliation key on every root", () => {
    for (const { root, humanKey } of ROOTS) {
      const keys = IDENTITY_DOMAIN_KEYS_BY_ROOT.get(root);
      expect(keys?.has("_id")).toBe(true);
      expect(keys?.has("_temp_id")).toBe(true);
      expect(keys?.has(humanKey)).toBe(true);
    }
  });

  it("leaves steps.object_id alone — it is a reference, not an identity", () => {
    // The media picker writes it on a pre-existing step map on every pick.
    expect(IDENTITY_DOMAIN_KEYS_BY_NESTED_KEY.get("steps")?.has("object_id")).toBe(false);
    expect(IDENTITY_DOMAIN_KEYS_BY_NESTED_KEY.get("layers")?.has("object_id")).toBe(false);
  });

  it("resolves a map's governed keys from its position, not its contents", () => {
    const ydoc = new Y.Doc();
    const page = seed(ydoc, "pages", { _id: 1, slug: "about" });
    const story = seed(ydoc, "stories", { _id: 1, story_id: "s" });
    let step!: Y.Map<unknown>;
    ydoc.transact(() => {
      const steps = new Y.Array<Y.Map<unknown>>();
      story.set("steps", steps);
      step = new Y.Map<unknown>();
      step.set("_id", 5);
      step.set("object_id", "pot");
      steps.push([step]);
    }, null);

    expect(identityDomainKeysFor(page, ydoc)?.has("slug")).toBe(true);
    expect(identityDomainKeysFor(step, ydoc)?.has("object_id")).toBe(false);
    expect(identityDomainKeysFor(step, ydoc)?.has("_id")).toBe(true);

    const loose = new Y.Map<unknown>();
    ydoc.transact(() => { ydoc.getMap("config").set("x", loose); loose.set("_id", 9); }, null);
    expect(identityDomainKeysFor(loose, ydoc)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The three open routes
// ---------------------------------------------------------------------------

describe("a map BORN carrying structure at its reconciliation key", () => {
  it.each(ROOTS)("removes the born $root map", ({ root, humanKey }) => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    seed(h.ydoc, root, { _id: 10, _temp_id: "victim", [humanKey]: "victim-key" });
    const arr = h.ydoc.getArray<Y.Map<unknown>>(root);

    h.ydoc.transact(() => {
      const forged = new Y.Map<unknown>();
      forged.set("_id", null);
      forged.set("_temp_id", "forged");
      forged.set(humanKey, new Y.Text("victim-key"));
      forged.set("created_by", 2);
      arr.push([forged]);
    }, attacker);

    // The born map is gone; the victim stands, still owning its key.
    expect(arr.length).toBe(1);
    expect(arr.get(0).get(humanKey)).toBe("victim-key");
    expect(h.violations).toHaveLength(1);
  });

  it.each(STRUCTURES)("removes a born objects map keyed by $name", ({ make }) => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    seed(h.ydoc, "objects", { _id: 10, object_id: "pot" });
    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");

    h.ydoc.transact(() => {
      const forged = new Y.Map<unknown>();
      forged.set("_id", null);
      forged.set("object_id", make("pot"));
      arr.push([forged]);
    }, attacker);

    expect(arr.length).toBe(1);
    expect(arr.get(0).get("object_id")).toBe("pot");
    expect(h.violations).toHaveLength(1);
  });

  it.each(STRUCTURES)("removes a born objects map whose _id is $name", ({ make }) => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    seed(h.ydoc, "objects", { _id: 7, object_id: "pot" });
    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");

    h.ydoc.transact(() => {
      const forged = new Y.Map<unknown>();
      forged.set("_id", make("7"));
      forged.set("object_id", "forged-key");
      arr.push([forged]);
    }, attacker);

    expect(arr.length).toBe(1);
    expect(arr.get(0).get("_id")).toBe(7);
    expect(h.violations).toHaveLength(1);
  });

  it.each([
    { label: "NaN", value: NaN },
    { label: "0 — insertRow's refused-INSERT sentinel", value: 0 },
    { label: "-1", value: -1 },
    { label: "1.5", value: 1.5 },
    { label: "MAX_SAFE_INTEGER + 1", value: Number.MAX_SAFE_INTEGER + 1 },
  ])("removes a born objects map whose _id is $label", ({ value }) => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    // The victim is inserted FIRST and is unsaved, which is the arrangement
    // where NaN wins the key: it is `typeof "number"`, so it beats the
    // "prefer the persisted copy" tiebreak against a null `_id`.
    seed(h.ydoc, "objects", { _id: null, object_id: "pot" });
    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");

    h.ydoc.transact(() => {
      const forged = new Y.Map<unknown>();
      forged.set("_id", value);
      forged.set("object_id", "pot");
      arr.push([forged]);
    }, attacker);

    expect(arr.length).toBe(1);
    expect(arr.get(0).get("_id")).toBeNull();
    expect(h.violations).toHaveLength(1);
  });
});

describe("structure assigned to a PRE-EXISTING map's reconciliation key", () => {
  it.each(ROOTS.flatMap(({ root, humanKey }) =>
    STRUCTURES.map((s) => ({ root, humanKey, name: s.name, make: s.make })),
  ))("restores $humanKey on $root against $name", ({ root, humanKey, make }) => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    seed(h.ydoc, root, { _id: 10, [humanKey]: "victim-key" });
    const own = seed(h.ydoc, root, { _id: 11, [humanKey]: "mine", created_by: 2 });

    h.ydoc.transact(() => { own.set(humanKey, make("victim-key")); }, attacker);

    expect(own.get(humanKey)).toBe("mine");
    expect(h.violations).toHaveLength(1);
  });

  it.each(ROOTS)("restores _id on $root against structure", ({ root, humanKey }) => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    const own = seed(h.ydoc, root, { _id: 11, [humanKey]: "mine", created_by: 2 });

    h.ydoc.transact(() => { own.set("_id", ["11"]); }, attacker);

    expect(own.get("_id")).toBe(11);
    expect(h.violations).toHaveLength(1);
  });

  it("restores a map rather than removing it — it is not a born forgery", () => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    const own = seed(h.ydoc, "pages", { _id: 11, slug: "mine", created_by: 2 });
    const arr = h.ydoc.getArray<Y.Map<unknown>>("pages");

    h.ydoc.transact(() => { own.set("slug", new Y.Text("victim")); }, attacker);

    expect(arr.length).toBe(1);
    expect(arr.get(0)).toBe(own);
    expect(own.get("slug")).toBe("mine");
  });

  it("records ONE violation for a transaction that plants several", () => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    const a = seed(h.ydoc, "pages", { _id: 1, slug: "a", created_by: 2 });
    const b = seed(h.ydoc, "glossary", { _id: 1, term_id: "b", created_by: 2 });

    h.ydoc.transact(() => {
      a.set("slug", ["x"]);
      b.set("term_id", ["y"]);
    }, attacker);

    expect(a.get("slug")).toBe("a");
    expect(b.get("term_id")).toBe("b");
    expect(h.violations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The pre-planted case — left to load-time normalisation on purpose
// ---------------------------------------------------------------------------

describe("a value that was ALREADY out of domain", () => {
  it("is not repaired by the guard, which cannot read D1", () => {
    const ydoc = new Y.Doc();
    const attacker = fakeSocket(2, "collaborator");
    const planted = new Y.Text("victim");
    const page = seed(ydoc, "pages", { _id: 1, slug: planted, created_by: 2 });

    let found: ReturnType<typeof extractIdentityDomainViolations> | null = null;
    ydoc.on("afterTransaction", (tr: Y.Transaction) => {
      found = extractIdentityDomainViolations(ydoc, tr);
    });

    // Editing the planted type never touches the entity map, so the ancestry
    // source is the only one that reaches it at all.
    ydoc.transact(() => { planted.insert(0, "z"); }, attacker);

    expect(found!.removals).toHaveLength(0);
    // Reported by no mutation: minting, blanking or guessing a replacement
    // here would destroy the reference. Load-time normalisation owns it.
    expect(found!.mutations).toHaveLength(0);
    expect(page.get("slug")).toBe(planted);
  });
});

// ---------------------------------------------------------------------------
// No regression on the routes that were already closed
// ---------------------------------------------------------------------------

describe("the routes the identity pass already closed", () => {
  it.each([
    { root: "objects", key: "object_id" },
    { root: "stories", key: "story_id" },
  ])("still reverts a Y.Text assigned to a pre-existing $key on $root", ({ root, key }) => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    seed(h.ydoc, root, { _id: 10, [key]: "victim-key" });
    const own = seed(h.ydoc, root, { _id: 11, [key]: "mine", created_by: 2 });

    h.ydoc.transact(() => { own.set(key, new Y.Text("victim-key")); }, attacker);

    expect(own.get(key)).toBe("mine");
    expect(h.violations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Renaming, and the media picker
// ---------------------------------------------------------------------------

describe("what the rule must NOT catch", () => {
  it.each([
    { root: "pages", key: "slug" },
    { root: "glossary", key: "term_id" },
  ])("leaves a $key rename on $root alone", ({ root, key }) => {
    const h = makeHarness();
    const editor = fakeSocket(2, "collaborator");
    const m = seed(h.ydoc, root, { _id: 11, [key]: "old-name", created_by: 2 });

    h.ydoc.transact(() => { m.set(key, "new-name"); }, editor);

    expect(m.get(key)).toBe("new-name");
    expect(h.violations).toHaveLength(0);
    expect(h.warns).toHaveLength(0);
  });

  it("lets the media picker write steps.object_id freely", () => {
    const h = makeHarness();
    const editor = fakeSocket(2, "collaborator");
    const story = seed(h.ydoc, "stories", { _id: 1, story_id: "s", created_by: 2 });
    let step!: Y.Map<unknown>;
    h.ydoc.transact(() => {
      const steps = new Y.Array<Y.Map<unknown>>();
      story.set("steps", steps);
      step = new Y.Map<unknown>();
      step.set("_id", null);
      step.set("_temp_id", "step-1");
      step.set("object_id", "");
      steps.push([step]);
    }, null);

    h.ydoc.transact(() => { step.set("object_id", "a-pot"); }, editor);

    expect(step.get("object_id")).toBe("a-pot");
    expect(h.violations).toHaveLength(0);
  });

  it("lets an ordinary create through — every factory mints a real key", () => {
    const h = makeHarness();
    const editor = fakeSocket(2, "collaborator");
    const arr = h.ydoc.getArray<Y.Map<unknown>>("objects");

    h.ydoc.transact(() => {
      const fresh = new Y.Map<unknown>();
      fresh.set("_id", null);
      fresh.set("_temp_id", "11111111-2222-3333-4444-555555555555");
      fresh.set("object_id", "a-new-pot");
      fresh.set("created_by", 2);
      arr.push([fresh]);
    }, editor);

    expect(arr.length).toBe(1);
    expect(h.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Nested arrays
// ---------------------------------------------------------------------------

describe("nested steps and layers", () => {
  it("removes a born step carrying structure at _id, inside a born story", () => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    const arr = h.ydoc.getArray<Y.Map<unknown>>("stories");
    let steps!: Y.Array<Y.Map<unknown>>;

    h.ydoc.transact(() => {
      const story = new Y.Map<unknown>();
      story.set("_id", null);
      story.set("_temp_id", "s-1");
      story.set("story_id", "a-story");
      story.set("created_by", 2);
      steps = new Y.Array<Y.Map<unknown>>();
      const good = new Y.Map<unknown>();
      good.set("_id", null);
      good.set("_temp_id", "step-good");
      const bad = new Y.Map<unknown>();
      bad.set("_id", new Y.Text("9"));
      bad.set("_temp_id", "step-bad");
      steps.push([good, bad]);
      story.set("steps", steps);
      arr.push([story]);
    }, attacker);

    // The story itself is in domain and stays; only the forged step goes.
    expect(arr.length).toBe(1);
    expect(steps.length).toBe(1);
    expect(steps.get(0).get("_temp_id")).toBe("step-good");
    expect(h.violations).toHaveLength(1);
  });

  it("removes a born layer carrying structure at _temp_id", () => {
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    const story = seed(h.ydoc, "stories", { _id: 1, story_id: "s", created_by: 2 });
    let layers!: Y.Array<Y.Map<unknown>>;
    let steps!: Y.Array<Y.Map<unknown>>;
    h.ydoc.transact(() => {
      steps = new Y.Array<Y.Map<unknown>>();
      const step = new Y.Map<unknown>();
      step.set("_id", null);
      step.set("_temp_id", "step-1");
      layers = new Y.Array<Y.Map<unknown>>();
      step.set("layers", layers);
      steps.push([step]);
      story.set("steps", steps);
    }, null);

    h.ydoc.transact(() => {
      const forged = new Y.Map<unknown>();
      forged.set("_id", null);
      forged.set("_temp_id", ["layer-1"]);
      layers.push([forged]);
    }, attacker);

    expect(layers.length).toBe(0);
    expect(h.violations).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// findDurableReplacements — the sweep reads the RENDERED value
// ---------------------------------------------------------------------------

describe("the replacement sweep", () => {
  it("recognises a born replacement whose key is a Y.Text", () => {
    // A step map: its `object_id` is out of the domain pass's scope (the media
    // picker owns it), so only the sweep's own reading can catch this one.
    const h = makeHarness();
    const attacker = fakeSocket(2, "collaborator");
    const story = seed(h.ydoc, "stories", { _id: 1, story_id: "s", created_by: 1 });
    let steps!: Y.Array<Y.Map<unknown>>;
    h.ydoc.transact(() => {
      steps = new Y.Array<Y.Map<unknown>>();
      const victim = new Y.Map<unknown>();
      victim.set("_id", null);
      victim.set("_temp_id", "victim-step");
      victim.set("object_id", "a-pot");
      victim.set("created_by", 1);
      steps.push([victim]);
      story.set("steps", steps);
    }, null);

    h.ydoc.transact(() => {
      steps.delete(0, 1);
      const replacement = new Y.Map<unknown>();
      replacement.set("_id", null);
      replacement.set("_temp_id", "replacement-step");
      replacement.set("object_id", new Y.Text("a-pot"));
      replacement.set("created_by", 2);
      steps.push([replacement]);
    }, attacker);

    // The victim is restored and the replacement swept: one map, the original.
    expect(steps.length).toBe(1);
    expect(steps.get(0).get("_temp_id")).toBe("victim-step");
    expect(h.violations).toHaveLength(1);
  });
});
