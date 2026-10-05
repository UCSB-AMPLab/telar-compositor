/**
 * A re-key inside the Durable Object moves a page's slug; `config.navigation`
 * does not follow it.
 *
 * The DO resolves a human-key collision between two live rows by re-keying the
 * loser (`deduplicateYArray`, `workers/collaboration.ts`) rather than deleting
 * it — deleting was destroying another member's page. The re-key rewrites
 * `pages[i].slug`. It does not rewrite `config.navigation`, which is plain
 * client-owned JSON in the shared document and the authority the published
 * `_data/navigation.yml` is derived from (`navigation_json` →
 * `buildNavigationYml`). Two members renaming their pages onto one free slug
 * therefore leaves the keeper with two menu entries and the re-keyed page with
 * none: its page survives, its link does not.
 *
 * Navigation entries address a page by `slug` and carry no row id, so nothing
 * downstream can re-derive the association on its own — the repair has to be
 * made where the page list and the nav array are both in hand, which is the
 * Pages route.
 *
 * The first block drives the real DO dedupe so the stale-nav state is the one
 * production produces, not a hand-built imitation. The rest pins the honest
 * paths the repair must not disturb: an ordinary rename, a hidden entry, a
 * dangling entry, and repeated runs.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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

import { ProjectCollaborationDO } from "../workers/collaboration";
import { signInternalMarker } from "../workers/auth";
import { reconcileNavPageSlugs, type ReconcilePage } from "~/lib/nav-reconcile";
import { checkD1Bind } from "./helpers/d1-memory";

const TEST_SECRET = "test-session-secret";
const TEST_PROJECT_ID = 42;
const CONVENOR = 1;

// ---------------------------------------------------------------------------
// DO harness — the minimum needed to reach `deduplicateYArray` on a live doc.
// ---------------------------------------------------------------------------

function fakeSocket(userId: number, role: "convenor" | "collaborator") {
  const attachment = { userId, projectId: TEST_PROJECT_ID, role };
  return {
    attachment,
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn(),
    deserializeAttachment: () => attachment,
  };
}

function makeDb() {
  return {
    prepare(sql: string) {
      return {
        bind: (...args: unknown[]) => {
          checkD1Bind(sql, args);
          return {
            first: async () => (sql.includes("yjs_state") ? { yjs_state: null } : null),
            all: async () => ({ results: [] }),
            run: async () => ({}),
          };
        },
      };
    },
  };
}

async function makeDO(sockets: ReturnType<typeof fakeSocket>[]) {
  const ctx = {
    getWebSockets: () => sockets,
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      // The loader and the snapshot read the generation from storage, and a
      // load lists the log prefix before it tags an untagged blob.
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  const env = { DB: makeDb(), SESSION_SECRET: TEST_SECRET, COLLABORATION: {} };
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    env as unknown as Env,
  );
  await new Promise((r) => setTimeout(r, 0));
  return doInstance;
}

async function resetRequest(): Promise<Request> {
  const { sigHex, timestamp } = await signInternalMarker(TEST_PROJECT_ID, TEST_SECRET, "reset");
  return new Request("https://internal/reset", {
    method: "POST",
    headers: {
      "X-Internal-Auth": sigHex,
      "X-Internal-Timestamp": String(timestamp),
      "X-Internal-Project": String(TEST_PROJECT_ID),
    },
  });
}

function liveDoc(doInstance: ProjectCollaborationDO): Y.Doc {
  return (doInstance as unknown as { ydoc: Y.Doc }).ydoc;
}

function seedPage(ydoc: Y.Doc, rowId: number | null, slug: string, title: string): void {
  ydoc.transact(() => {
    const map = new Y.Map<unknown>();
    map.set("_id", rowId);
    map.set("_temp_id", `temp-${title}`);
    map.set("created_by", CONVENOR);
    map.set("slug", slug);
    const titleY = new Y.Text();
    titleY.insert(0, title);
    map.set("title", titleY);
    ydoc.getArray<Y.Map<unknown>>("pages").push([map]);
  }, null);
}

// ---------------------------------------------------------------------------
// Plain-doc helpers — the nav array as production builds it (plain JSON).
// ---------------------------------------------------------------------------

type NavEntry = Record<string, unknown>;

function navArrayOf(ydoc: Y.Doc, entries: NavEntry[]): Y.Array<unknown> {
  const config = ydoc.getMap("config");
  const existing = config.get("navigation");
  if (existing instanceof Y.Array) {
    ydoc.transact(() => {
      existing.delete(0, existing.length);
      existing.insert(0, entries);
    }, null);
    return existing;
  }
  const navArray = new Y.Array<unknown>();
  navArray.push(entries);
  config.set("navigation", navArray);
  return navArray;
}

function pageEntry(slug: string, label: string, visible = true): NavEntry {
  return { type: "page", slug, label, visible };
}

const builtins: NavEntry[] = [
  { type: "builtin", key: "home", label: "Home", visible: true },
  { type: "builtin", key: "collection", label: "Objects", visible: true },
];

function snapshot(navArray: Y.Array<unknown>): NavEntry[] {
  return navArray.toArray() as NavEntry[];
}

function livePages(ydoc: Y.Doc): ReconcilePage[] {
  return ydoc
    .getArray<Y.Map<unknown>>("pages")
    .toArray()
    .map((m) => ({
      slug: (m.get("slug") as string) ?? "",
      title: String(m.get("title") ?? ""),
    }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => { /* silence the dedupe log */ });
});

// ---------------------------------------------------------------------------
// The defect
// ---------------------------------------------------------------------------

describe("navigation after a Durable Object re-key", () => {
  it("leaves the menu pointing at the old slug — the seam this repair covers", async () => {
    const doInstance = await makeDO([fakeSocket(CONVENOR, "convenor")]);
    await doInstance.fetch(await resetRequest());
    const ydoc = liveDoc(doInstance);

    // Two live rows whose owners both renamed onto the same free slug.
    seedPage(ydoc, 10, "about", "About us");
    seedPage(ydoc, 11, "about", "About the project");
    const navArray = navArrayOf(ydoc, [
      ...builtins,
      pageEntry("about", "About us"),
      pageEntry("about", "About the project"),
    ]);

    (doInstance as unknown as {
      deduplicateYArray: (name: string, key: string) => boolean;
    }).deduplicateYArray("pages", "slug");

    // The DO did its job: both pages are still there, under distinct slugs.
    expect(livePages(ydoc).map((p) => p.slug)).toEqual(["about", "about-2"]);

    // The nav array is untouched, and that is the defect: two entries for one
    // page, none for the other.
    expect(snapshot(navArray).filter((e) => e.type === "page").map((e) => e.slug))
      .toEqual(["about", "about"]);
  });

  it("re-points the surplus entry at the re-keyed page", async () => {
    // Two members giving their pages the same title is how the collision
    // usually arises — the slug is generated from the title — and their menu
    // entries are then identical, which is what lets the repair act.
    const doInstance = await makeDO([fakeSocket(CONVENOR, "convenor")]);
    await doInstance.fetch(await resetRequest());
    const ydoc = liveDoc(doInstance);

    seedPage(ydoc, 10, "about", "About us");
    seedPage(ydoc, 11, "about", "About us");
    const navArray = navArrayOf(ydoc, [
      ...builtins,
      pageEntry("about", "About us"),
      pageEntry("about", "About us"),
    ]);

    (doInstance as unknown as {
      deduplicateYArray: (name: string, key: string) => boolean;
    }).deduplicateYArray("pages", "slug");

    const { repointed, removed } = reconcileNavPageSlugs(
      navArray,
      livePages(ydoc),
      { mutate: true, ydoc },
    );

    expect({ repointed, removed }).toEqual({ repointed: 1, removed: 0 });
    expect(snapshot(navArray)).toEqual([
      ...builtins,
      pageEntry("about", "About us"),
      pageEntry("about-2", "About us"),
    ]);
  });

  it("does not use menu order to decide which entry kept the slug", () => {
    // The DO's keeper is decided by D1's row id, not by nav order, so the
    // surviving slug's entry is as likely to be the second in the menu as the
    // first. A group whose entries differ is therefore left whole whichever
    // order it is in — the same input reversed must reach the same verdict.
    const forward = [
      ...builtins,
      pageEntry("about", "About the project"),
      pageEntry("about", "About us"),
    ];
    const reversed = [
      ...builtins,
      pageEntry("about", "About us"),
      pageEntry("about", "About the project"),
    ];
    const pages: ReconcilePage[] = [
      { slug: "about", title: "About us" },
      { slug: "about-2", title: "About the project" },
    ];

    for (const entries of [forward, reversed]) {
      const ydoc = new Y.Doc();
      const navArray = navArrayOf(ydoc, entries.map((e) => ({ ...e })));
      const { repointed, removed } = reconcileNavPageSlugs(navArray, pages, {
        mutate: true,
        ydoc,
      });

      expect({ repointed, removed }).toEqual({ repointed: 0, removed: 0 });
      expect(snapshot(navArray)).toEqual(entries);
    }
  });

  it("preserves the surplus entry's own fields when re-pointing it", () => {
    // Only the slug moves. Everything else the entry carried — a custom label,
    // a hidden flag, a field this module has never heard of — comes with it.
    const ydoc = new Y.Doc();
    const entry = {
      type: "page",
      slug: "about",
      label: "About the project",
      visible: false,
      target: "_self",
    };
    const navArray = navArrayOf(ydoc, [{ ...entry }, { ...entry }]);

    reconcileNavPageSlugs(
      navArray,
      [
        { slug: "about", title: "About us" },
        { slug: "about-2", title: "About the project" },
      ],
      { mutate: true, ydoc },
    );

    expect(snapshot(navArray)[1]).toEqual({ ...entry, slug: "about-2" });
  });

  it("drops a surplus entry only when no re-keyed page can claim it", () => {
    const ydoc = new Y.Doc();
    const navArray = navArrayOf(ydoc, [
      ...builtins,
      pageEntry("about", "About us"),
      pageEntry("about", "About us"),
    ]);

    const { repointed, removed } = reconcileNavPageSlugs(
      navArray,
      [{ slug: "about", title: "About us" }],
      { mutate: true, ydoc },
    );

    expect({ repointed, removed }).toEqual({ repointed: 0, removed: 1 });
    expect(snapshot(navArray)).toEqual([...builtins, pageEntry("about", "About us")]);
  });

  it("converges when two clients both re-point the same surplus entry", () => {
    // Every connected client runs this repair off the same broadcast, and a
    // nav entry is rewritten as delete + insert, so two clients can each land
    // an entry for the re-keyed page. The second pass collapses the pair.
    const ydoc = new Y.Doc();
    const navArray = navArrayOf(ydoc, [
      ...builtins,
      pageEntry("about", "About us"),
      pageEntry("about-2", "About the project"),
      pageEntry("about-2", "About the project"),
    ]);

    const pages: ReconcilePage[] = [
      { slug: "about", title: "About us" },
      { slug: "about-2", title: "About the project" },
    ];
    const { removed } = reconcileNavPageSlugs(navArray, pages, { mutate: true, ydoc });

    expect(removed).toBe(1);
    expect(snapshot(navArray)).toEqual([
      ...builtins,
      pageEntry("about", "About us"),
      pageEntry("about-2", "About the project"),
    ]);
  });
});

// ---------------------------------------------------------------------------
// The honest paths — a repair that disturbs any of these is worse than the
// defect it fixes.
// ---------------------------------------------------------------------------

describe("navigation reconcile — ordinary editing is untouched", () => {
  it("does nothing on a plain rename the client already applied", () => {
    const ydoc = new Y.Doc();
    const navArray = navArrayOf(ydoc, [
      ...builtins,
      pageEntry("team", "Our team"),
      pageEntry("about", "About us"),
    ]);
    const before = snapshot(navArray);

    const result = reconcileNavPageSlugs(
      navArray,
      [
        { slug: "team", title: "Our team" },
        { slug: "about", title: "About us" },
      ],
      { mutate: true, ydoc },
    );

    expect(result).toMatchObject({ repointed: 0, removed: 0 });
    expect(snapshot(navArray)).toEqual(before);
  });

  it("leaves menu order, built-ins, external links and hidden pages alone", () => {
    const ydoc = new Y.Doc();
    const external = { type: "external", url: "https://example.org", label: "Blog", visible: true };
    const entries = [
      pageEntry("about", "About us", false),
      builtins[0],
      external,
      builtins[1],
      pageEntry("team", "Our team"),
    ];
    const navArray = navArrayOf(ydoc, entries);

    const result = reconcileNavPageSlugs(
      navArray,
      [
        { slug: "about", title: "About us" },
        { slug: "team", title: "Our team" },
      ],
      { mutate: true, ydoc },
    );

    expect(result).toMatchObject({ repointed: 0, removed: 0 });
    expect(snapshot(navArray)).toEqual(entries);
  });

  it("never invents an entry for a page that has none", () => {
    // A page can sit outside the menu; the tab bar merges it in for display
    // only. Persisting that merge is a different decision from this repair.
    const ydoc = new Y.Doc();
    const navArray = navArrayOf(ydoc, [...builtins, pageEntry("about", "About us")]);

    const result = reconcileNavPageSlugs(
      navArray,
      [
        { slug: "about", title: "About us" },
        { slug: "about-2", title: "Second page" },
      ],
      { mutate: true, ydoc },
    );

    expect(result).toMatchObject({ repointed: 0, removed: 0 });
    expect(snapshot(navArray)).toEqual([...builtins, pageEntry("about", "About us")]);
  });

  it("leaves a dangling entry for a deleted page alone", () => {
    const ydoc = new Y.Doc();
    const navArray = navArrayOf(ydoc, [...builtins, pageEntry("gone", "Removed page")]);

    const result = reconcileNavPageSlugs(
      navArray,
      [{ slug: "about", title: "About us" }],
      { mutate: true, ydoc },
    );

    expect(result).toMatchObject({ repointed: 0, removed: 0 });
    expect(snapshot(navArray)).toEqual([...builtins, pageEntry("gone", "Removed page")]);
  });

  it("ignores pages that have no slug yet", () => {
    const ydoc = new Y.Doc();
    const navArray = navArrayOf(ydoc, [...builtins, pageEntry("about", "About us")]);

    const result = reconcileNavPageSlugs(
      navArray,
      [
        { slug: "about", title: "About us" },
        { slug: "", title: "" },
        { slug: "   ", title: "Whitespace" },
      ],
      { mutate: true, ydoc },
    );

    expect(result).toMatchObject({ repointed: 0, removed: 0 });
    expect(snapshot(navArray)).toEqual([...builtins, pageEntry("about", "About us")]);
  });

  it("does not write to the document when there is nothing to repair", () => {
    const ydoc = new Y.Doc();
    const navArray = navArrayOf(ydoc, [...builtins, pageEntry("about", "About us")]);
    let updates = 0;
    ydoc.on("update", () => { updates += 1; });

    reconcileNavPageSlugs(navArray, [{ slug: "about", title: "About us" }], {
      mutate: true,
      ydoc,
    });

    expect(updates).toBe(0);
  });

  it("is idempotent — a second pass over a repaired menu changes nothing", () => {
    const ydoc = new Y.Doc();
    const navArray = navArrayOf(ydoc, [
      ...builtins,
      pageEntry("about", "About us"),
      pageEntry("about", "About the project"),
    ]);
    const pages: ReconcilePage[] = [
      { slug: "about", title: "About us" },
      { slug: "about-2", title: "About the project" },
    ];

    reconcileNavPageSlugs(navArray, pages, { mutate: true, ydoc });
    const afterFirst = snapshot(navArray);
    const second = reconcileNavPageSlugs(navArray, pages, { mutate: true, ydoc });

    expect(second).toMatchObject({ repointed: 0, removed: 0 });
    expect(snapshot(navArray)).toEqual(afterFirst);
  });

  it("matches only the re-key's own suffix shape", () => {
    // `about-us` is a slug in its own right, not `about` plus a mint suffix,
    // so a surplus `about` entry must not be handed to it.
    const ydoc = new Y.Doc();
    const navArray = navArrayOf(ydoc, [
      pageEntry("about", "About us"),
      pageEntry("about", "About us"),
    ]);

    const { repointed, removed } = reconcileNavPageSlugs(
      navArray,
      [
        { slug: "about", title: "About us" },
        { slug: "about-us", title: "A different page" },
      ],
      { mutate: true, ydoc },
    );

    expect({ repointed, removed }).toEqual({ repointed: 0, removed: 1 });
    expect(snapshot(navArray)).toEqual([pageEntry("about", "About us")]);
  });

  it("leaves the document alone when mutate is not set", () => {
    const ydoc = new Y.Doc();
    const navArray = navArrayOf(ydoc, [
      pageEntry("about", "About us"),
      pageEntry("about", "About us"),
    ]);

    const { items, repointed } = reconcileNavPageSlugs(navArray, [
      { slug: "about", title: "About us" },
      { slug: "about-2", title: "About the project" },
    ]);

    expect(repointed).toBe(1);
    expect(items.map((i) => i.slug)).toEqual(["about", "about-2"]);
    expect(snapshot(navArray).map((e) => e.slug)).toEqual(["about", "about"]);
  });
});
