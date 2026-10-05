/**
 * The full-sync accept for page files.
 *
 * The accept reads each accepted page's file strictly at the check's HEAD,
 * parses it as the import does, and sends one ingest with
 * `pages.replaceContent` entries carrying the `expected` hash the check
 * recorded. head_sha advances to that HEAD only when the check the dialog
 * showed read the page files to a conclusion, the page trees conclude now,
 * and every accepted page was applied; a page the collaboration object
 * refuses, as changed since review or as malformed, or fails to save, keeps
 * it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));

const gh = vi.hoisted(() => ({
  reads: [] as Array<{ fn: string; path?: string; ref?: unknown; strict?: boolean }>,
  files: {} as Record<string, string>,
  trees: {} as Record<string, Record<string, Record<string, string>>>,
  subtreesFail: false,
  subtreeCommits: [] as Array<{ commits: string[]; paths: string[] }>,
  /** "<ref>:<path>" reads that fail. */
  failing: new Set<string>(),
}));

vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getRepoHead: vi.fn(async () => "landed-later"),
    getFileContent: vi.fn(async () => null),
    getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string, ref: string, options?: { strict?: boolean }) => {
      gh.reads.push({ fn: "getFileAtRef", path, ref, strict: options?.strict });
      if (gh.failing.has(`${ref}:${path}`)) return { status: "error" };
      const content = gh.files[`${ref}:${path}`];
      return content === undefined ? { status: "absent" } : { status: "ok", content };
    }),
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
    getSubtreeOids: vi.fn(async (_t: string, _o: string, _r: string, commits: string[], paths: string[]) => {
      gh.subtreeCommits.push({ commits: [...commits], paths: [...paths] });
      if (gh.subtreesFail && paths.includes(PAGES)) return { ok: false, reason: "malformed" };
      return {
        ok: true,
        at: (commit: string, path: string) =>
          gh.trees[commit]?.[path] ? { kind: "tree", oid: `${commit}|${path}` } : { kind: "absent" },
      };
    }),
    listSubtreeEntries: vi.fn(async (_t: string, _o: string, _r: string, oid: string) => {
      const [commit, path] = oid.split("|");
      return { files: new Map(Object.entries(gh.trees[commit]?.[path] ?? {})), dirs: new Set() };
    }),
  };
});

import { applyFullSyncChanges, PageContentNotApplied, SyncEntriesRefused } from "~/lib/sync.server";
import type { FullSyncChanges, FullSyncDiff, FullSyncEnv, SyncIngestPayload } from "~/lib/sync.server";
import { __clearStoryBlobCacheForTest } from "~/lib/story-files.server";
import { project_config, project_pages, projects } from "~/db/schema";
import { buildThreeWayChanges, emptySelections } from "~/components/features/dashboard/SyncConfirmModal";
import { InsertsNotAdded, SyncBaseStale } from "~/lib/sync.server";
import { checkPageFiles, keptPageFilesRecordJson } from "~/lib/page-files-check.server";
import type { PageCheckScope } from "~/lib/page-files-check.server";
import { parsePageMarkdown } from "~/lib/import.server";
import { pageContentAsLoaded, pageRawHash } from "~/lib/page-canonical";

const PAGES = "telar-content/texts/pages";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const ABOUT = readFileSync(resolve(__dirname, "fixtures/pages/telar/about.md"), "utf8");
const EDITED = ABOUT.replace("# About Telar\n", "# About Telar\n\nEdited on GitHub.\n");

/**
 * A D1 stand-in: the project row holds `recordedHead`, and a head write lands
 * only while it still does; `project_pages` answers `pages`; every other read
 * answers no rows.
 */
function recordingDb(
  recordedHead: string | null,
  pages: unknown[] = [{ id: 5, slug: "about", title: "About" }],
  stored: { config?: Record<string, unknown>; project?: Record<string, unknown> } = {},
) {
  const sets: Array<Record<string, unknown>> = [];
  const row = { head_sha: recordedHead };
  let table: unknown;
  let updating: unknown;
  let pending: Record<string, unknown> | null = null;
  const chain: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        const rows = table === projects ? [{ ...stored.project, head_sha: row.head_sha }]
          : table === project_pages ? pages
          : table === project_config ? (stored.config ? [stored.config] : [])
          : updating === projects ? [{ id: 1 }] : [];
        table = undefined;
        updating = undefined;
        return (resolve: (v: unknown[]) => unknown) => resolve(rows);
      }
      if (prop === "update") return (t: unknown) => { updating = t; return chain; };
      if (prop === "set") return (payload: Record<string, unknown>) => { pending = payload; return chain; };
      if (prop === "where") return () => {
        if (pending) {
          sets.push(pending);
          if (updating === projects && "head_sha" in pending) row.head_sha = HEAD;
          pending = null;
        }
        return chain;
      };
      if (prop === "from") return (t: unknown) => { table = t; return chain; };
      return () => chain;
    },
  });
  return { db: chain as never, sets, row };
}

function ingestEnv(answer: (p: SyncIngestPayload) => unknown, capture: SyncIngestPayload[]): FullSyncEnv {
  return {
    SESSION_SECRET: "test-secret",
    COLLABORATION: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (req: Request) => {
          const payload = JSON.parse(await req.text()) as SyncIngestPayload;
          capture.push(payload);
          return new Response(JSON.stringify(answer(payload)), { status: 200 });
        },
      }),
    },
  } as unknown as FullSyncEnv;
}

function changes(overrides: Partial<FullSyncChanges> = {}): FullSyncChanges {
  return {
    projectId: 1,
    baseSha: BASE,
    headSha: HEAD,
    storyContentChecked: true,
    pageContentChecked: true,
    objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
    stories: { accept: [], reject: [], insertNew: [] },
    config: { accept: [], reject: [] },
    glossary: { accept: [], reject: [], insertNew: [] },
    pages: { acceptContent: [{ pageId: 5, slug: "about", expected: "hash-reviewed" }] },
    ...overrides,
  } as FullSyncChanges;
}

const applied = (ids: number[]) => () => ({ pageContent: { applied: ids, alreadyApplied: [], changedSinceReview: [], failed: [] } });

beforeEach(() => {
  gh.reads.length = 0;
  gh.subtreesFail = false;
  gh.subtreeCommits.length = 0;
  gh.failing.clear();
  gh.files = { [`${HEAD}:${PAGES}/about.md`]: EDITED, [`${BASE}:${PAGES}/about.md`]: ABOUT };
  gh.trees = { [HEAD]: { [PAGES]: { "about.md": "a2" } }, [BASE]: { [PAGES]: { "about.md": "a1" } } };
  __clearStoryBlobCacheForTest();
});

describe("the accept of a page's content", () => {
  it("reads the page strictly at the check's HEAD, sends GitHub's version with its expected hash, and advances to that HEAD", async () => {
    const { db, row } = recordingDb(BASE);
    const sent: SyncIngestPayload[] = [];
    const result = await applyFullSyncChanges(1, changes(), "tok", "o", "r", db, 7, ingestEnv(applied([5]), sent));

    // The accept's own check reads the file at HEAD and the base; the content
    // it sends is the HEAD file that check read.
    const pageReads = gh.reads.filter((r) => r.path?.startsWith(`${PAGES}/`));
    expect(pageReads).toEqual([
      { fn: "getFileAtRef", path: `${PAGES}/about.md`, ref: HEAD, strict: true },
      { fn: "getFileAtRef", path: `${PAGES}/about.md`, ref: BASE, strict: true },
    ]);
    // The body is the file after its fence and the blank line below it, with
    // the file's trailing newline dropped, cut from the file as text rather
    // than through the parser under test.
    const body = EDITED.slice(EDITED.indexOf("# About Telar")).replace(/\n$/, "");
    expect(sent[0].pages?.replaceContent).toEqual([
      { pageId: 5, expected: "hash-reviewed", title: "About", frontmatter: "\ntitle: About\n", body },
    ]);
    expect(result).toEqual({ newHeadSha: HEAD, storyFilesInconclusive: false, pageFilesInconclusive: false });
    expect(row.head_sha).toBe(HEAD);
  });

  it("keeps the indentation of a code block that opens the page, dropping only the blank lines above it and the whitespace after it", async () => {
    gh.files = { [`${HEAD}:${PAGES}/about.md`]: "---\ntitle: About\n---\n\n\n    const x = 1;\n    const y = 2;\n\nAfter.\n\n" };
    const { db } = recordingDb(BASE);
    const sent: SyncIngestPayload[] = [];
    await applyFullSyncChanges(1, changes(), "tok", "o", "r", db, 7, ingestEnv(applied([5]), sent));
    expect(sent[0].pages?.replaceContent).toEqual([
      {
        pageId: 5,
        expected: "hash-reviewed",
        title: "About",
        frontmatter: "\ntitle: About\n",
        body: "    const x = 1;\n    const y = 2;\n\nAfter.",
      },
    ]);
  });

  it("keeps head_sha when a page is refused as changed since review", async () => {
    const { db, sets } = recordingDb(BASE);
    const env = ingestEnv(() => ({ pageContent: { applied: [], alreadyApplied: [], changedSinceReview: [5], failed: [] } }), []);
    const accept = applyFullSyncChanges(1, changes(), "tok", "o", "r", db, 7, env);
    await expect(accept).rejects.toBeInstanceOf(PageContentNotApplied);
    await expect(accept).rejects.toMatchObject({ changedSinceReview: [5], failed: [] });
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
  });

  // An entry the ingest's boundary refused holds the whole accept back.
  it("keeps head_sha and refuses the accept whole when the ingest refused a page entry as malformed", async () => {
    const { db, sets } = recordingDb(BASE);
    const env = ingestEnv(() => ({ refused: { pageReplaceContent: [0] }, pageContent: { applied: [], alreadyApplied: [], changedSinceReview: [], failed: [] } }), []);
    const accept = applyFullSyncChanges(1, changes(), "tok", "o", "r", db, 7, env);
    await expect(accept).rejects.toBeInstanceOf(SyncEntriesRefused);
    await expect(accept).rejects.toMatchObject({ refused: { pageReplaceContent: [0] } });
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
  });

  // The page's content was written and D1 does not show it: the rest of the
  // ingest has landed, and the record stays where it was.
  it("keeps head_sha when a page's content did not reach D1 after the write", async () => {
    const { db, sets } = recordingDb(BASE);
    const env = ingestEnv(() => ({ pageContent: { applied: [], alreadyApplied: [], changedSinceReview: [], failed: [5] } }), []);
    const accept = applyFullSyncChanges(1, changes(), "tok", "o", "r", db, 7, env);
    await expect(accept).rejects.toBeInstanceOf(PageContentNotApplied);
    await expect(accept).rejects.toMatchObject({ changedSinceReview: [], failed: [5] });
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
  });

  it("advances when the page was already applied, as a replay finds it", async () => {
    const { db, row } = recordingDb(BASE);
    const env = ingestEnv(() => ({ pageContent: { applied: [], alreadyApplied: [5], changedSinceReview: [], failed: [] } }), []);
    await applyFullSyncChanges(1, changes(), "tok", "o", "r", db, 7, env);
    expect(row.head_sha).toBe(HEAD);
  });

  it("refuses an accepted page whose file is no longer at the checked commit, sending nothing", async () => {
    delete gh.trees[HEAD][PAGES]["about.md"];
    const { db, sets } = recordingDb(BASE);
    const sent: SyncIngestPayload[] = [];
    await expect(applyFullSyncChanges(1, changes(), "tok", "o", "r", db, 7, ingestEnv(applied([5]), sent))).rejects.toThrow(/about\.md/);
    expect(sent).toEqual([]);
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
  });

  it.each([
    ["no expected hash", { pageId: 5, slug: "about" }],
    ["a slug that names a subfolder", { pageId: 5, slug: "../about", expected: "h" }],
    ["an id that is not a row id", { pageId: "5", slug: "about", expected: "h" }],
  ])("refuses an accepted page with %s before anything is sent", async (_label, entry) => {
    const { db } = recordingDb(BASE);
    const sent: SyncIngestPayload[] = [];
    const accept = applyFullSyncChanges(1, changes({ pages: { acceptContent: [entry] } } as never), "tok", "o", "r", db, 7, ingestEnv(applied([5]), sent));
    await expect(accept).rejects.toThrow();
    expect(sent).toEqual([]);
  });
});

describe("head_sha and the page files the check read", () => {
  it.each([
    ["absent, as an older dialog sends it", undefined],
    ["false", false],
  ])("holds head_sha when the dialog's page check flag is %s", async (_label, flag) => {
    const { db, sets } = recordingDb(BASE);
    const { pageContentChecked: _dropped, ...rest } = changes({ pages: { acceptContent: [] } });
    const sent = (flag === undefined ? rest : { ...rest, pageContentChecked: flag }) as FullSyncChanges;
    const result = await applyFullSyncChanges(1, sent, "tok", "o", "r", db, 7, ingestEnv(applied([]), []));
    expect(result).toEqual({ newHeadSha: null, storyFilesInconclusive: false, pageFilesInconclusive: true });
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
  });

  it("holds head_sha when the page trees do not conclude now, whatever the dialog says", async () => {
    gh.subtreesFail = true;
    const { db, sets } = recordingDb(BASE);
    const result = await applyFullSyncChanges(1, changes({ pages: { acceptContent: [] } }), "tok", "o", "r", db, 7, ingestEnv(applied([]), []));
    expect(result).toEqual({ newHeadSha: null, storyFilesInconclusive: false, pageFilesInconclusive: true });
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
    expect(gh.subtreeCommits.filter((c) => c.paths.includes(PAGES)).map((c) => c.commits)).toEqual([[BASE, HEAD]]);
  });

  it("reads the page tree when the Compositor holds no page, since a page GitHub added matters there", async () => {
    gh.trees[HEAD][PAGES] = {};
    gh.trees[BASE][PAGES] = {};
    const { db, row } = recordingDb(BASE, []);
    await applyFullSyncChanges(1, changes({ pages: { acceptContent: [] } }), "tok", "o", "r", db, 7, ingestEnv(applied([]), []));
    expect(gh.subtreeCommits.filter((c) => c.paths.includes(PAGES)).map((c) => c.commits)).toEqual([[BASE, HEAD]]);
    expect(row.head_sha).toBe(HEAD);
  });
});

describe("what the dialog sends for its page choices", () => {
  const diff = (pages: unknown) =>
    ({
      objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [] },
      stories: { newStories: [], changedStories: [], missingStories: [], content: { conclusive: true, changes: [], suppressedEditorOnly: 0 } },
      config: { changedFields: [], versionChange: null },
      glossary: { added: [], changed: [], removed: [] },
      pages,
      hasConflicts: false, classification: "three-way", suppressedEditorOnly: 0, headSha: HEAD, projectId: 1, baseSha: BASE,
    }) as unknown as FullSyncDiff;

  it("takes a GitHub-only page by default and keeps a conflict, marking the page check concluded", () => {
    const built = buildThreeWayChanges(diff({
      conclusive: true, suppressedEditorOnly: 0,
      changes: [
        { pageId: 5, slug: "about", title: "About", kind: "github-only", acceptByDefault: true, expected: "h5" },
        { pageId: 6, slug: "acerca", title: "Acerca", kind: "conflict", acceptByDefault: false, expected: "h6" },
      ],
    }), emptySelections());
    expect(built.pages).toEqual({ acceptContent: [{ pageId: 5, slug: "about", expected: "h5" }], takeFiles: [], addFiles: [] });
    expect(built.pageContentChecked).toBe(true);
  });

  it("does not mark the page check concluded when it was not, and the accept then holds head_sha", async () => {
    const built = buildThreeWayChanges(diff({ conclusive: false, reason: "the page trees came back malformed" }), emptySelections());
    expect(built.pageContentChecked).toBeUndefined();
    const { db, sets } = recordingDb(BASE);
    const result = await applyFullSyncChanges(1, JSON.parse(JSON.stringify(built)), "tok", "o", "r", db, 7, ingestEnv(applied([]), []));
    expect(result.pageFilesInconclusive).toBe(true);
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Page files on one side only: GitHub's menu, the accept, the record
// ---------------------------------------------------------------------------

const ACERCA = readFileSync(resolve(__dirname, "fixtures/pages/telar/acerca.md"), "utf8");
const CREDITS = ABOUT.replace("title: About", "title: Credits");
/** The template's `_data/navigation.yml`, its custom page example uncommented. */
const TEMPLATE_MENU = `menu:
  - title_en: Home
    titulo_es: Inicio
    url: /

  - title_en: Objects
    titulo_es: Objetos
    url: /objects/

  - title_en: Glossary
    titulo_es: Glosario
    url: /glossary/

  - title_en: About
    titulo_es: Acerca de
    url: /about/
`;
const SAVED_MENU = [
  { type: "builtin", key: "home", label: "Home", visible: true },
  { type: "builtin", key: "glossary", label: "Glossary", visible: true },
  { type: "builtin", key: "collection", label: "Objects", visible: true },
];

/** The row the import stores for `file` at `slug`. */
const importedPageRow = (id: number, slug: string, file: string) => ({ id, slug, frontmatter_source: null, ...parsePageMarkdown(file, slug) });

/** GitHub added about.md and credits.md since the base. */
function githubAddedTwo() {
  gh.trees = { [BASE]: { [PAGES]: {} }, [HEAD]: { [PAGES]: { "about.md": "a1", "credits.md": "k1" } } };
  gh.files = {
    [`${HEAD}:${PAGES}/about.md`]: ABOUT,
    [`${HEAD}:${PAGES}/credits.md`]: CREDITS,
    [`${HEAD}:_data/navigation.yml`]: TEMPLATE_MENU,
  };
}

const scope = (over: Partial<PageCheckScope> = {}): PageCheckScope =>
  ({ d1: [], record: null, publishedSlugs: [], saved: SAVED_MENU as never, siteLanguage: "en", ...over });

const noPageChoices = (addFiles = ["about.md", "credits.md"]) => changes({ pages: { acceptContent: [], addFiles } });

describe("a page GitHub added, and GitHub's menu", () => {
  it("gets the entry GitHub's menu gives it, after the saved entry for the item before it, labelled in the site's language", async () => {
    githubAddedTwo();
    const check = await checkPageFiles({ token: "t", owner: "o", repo: "r" }, scope({ siteLanguage: "es" }), BASE, HEAD);
    if (!check.conclusive) throw new Error(check.reason);
    expect(check.additions?.map(({ frontmatter: _f, ...a }) => a)).toEqual([
      { name: "about.md", slug: "about", title: "About", menu: { label: "Acerca de", after: { type: "builtin", key: "glossary" } } },
      { name: "credits.md", slug: "credits", title: "Credits", menu: null },
    ]);
  });

  it("gets none when GitHub has no menu file, and is still taken", async () => {
    githubAddedTwo();
    delete gh.files[`${HEAD}:_data/navigation.yml`];
    const check = await checkPageFiles({ token: "t", owner: "o", repo: "r" }, scope(), BASE, HEAD);
    expect(check.conclusive && check.additions?.map((a) => [a.slug, a.menu])).toEqual([["about", null], ["credits", null]]);
  });

  it("makes the check inconclusive when the menu file cannot be read", async () => {
    githubAddedTwo();
    gh.failing.add(`${HEAD}:_data/navigation.yml`);
    const check = await checkPageFiles({ token: "t", owner: "o", repo: "r" }, scope(), BASE, HEAD);
    expect(check.conclusive).toBe(false);
  });
});

describe("the accept of the pages GitHub added", () => {
  const insertedAnswer = (ids: Record<string, number>) => () => ({ insertedPages: ids });

  it("inserts them from its own check, and writes the record with the head in one statement", async () => {
    githubAddedTwo();
    const { db, sets } = recordingDb(BASE, [], { config: { navigation: JSON.stringify(SAVED_MENU), lang: "en" } });
    const sent: SyncIngestPayload[] = [];
    const result = await applyFullSyncChanges(1, noPageChoices(), "tok", "o", "r", db, 7, ingestEnv(insertedAnswer({ about: 11, credits: 12 }), sent));
    expect(sent[0].pages?.insert).toEqual([
      expect.objectContaining({ slug: "about", title: "About", created_by: null, menu: { label: "About", after: { type: "builtin", key: "glossary" } } }),
      expect.objectContaining({ slug: "credits", title: "Credits", created_by: null }),
    ]);
    expect(sent[0].pages?.insert?.[1]).not.toHaveProperty("menu");
    expect(result.newHeadSha).toBe(HEAD);
    const headWrite = sets.find((s) => "head_sha" in s)!;
    expect(JSON.parse(headWrite.page_files_json as string)).toEqual({ commit: HEAD, files: { "about.md": 11, "credits.md": 12 } });
  });

  it("keeps head_sha when an insert was skipped for a page made at that address since the check", async () => {
    githubAddedTwo();
    const { db, sets } = recordingDb(BASE, []);
    const env = ingestEnv(() => ({ heldBack: true, skipped: { pageInsert: ["about"] } }), []);
    await expect(applyFullSyncChanges(1, noPageChoices(), "tok", "o", "r", db, 7, env)).rejects.toThrow();
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
  });

  it("keeps head_sha when the ingest names no page for an insert", async () => {
    githubAddedTwo();
    const { db, sets } = recordingDb(BASE, []);
    const env = ingestEnv(insertedAnswer({ about: 11 }), []);
    await expect(applyFullSyncChanges(1, noPageChoices(), "tok", "o", "r", db, 7, env)).rejects.toBeInstanceOf(InsertsNotAdded);
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
  });

  it("adds nothing a client names: a choice its own check does not list refuses the accept, sending nothing", async () => {
    githubAddedTwo();
    const { db } = recordingDb(BASE, []);
    const sent: SyncIngestPayload[] = [];
    const forged = changes({ pages: { acceptContent: [], takeFiles: [{ name: "history.md", pageId: 99, expected: "x" }] } });
    await expect(applyFullSyncChanges(1, forged, "tok", "o", "r", db, 7, ingestEnv(insertedAnswer({}), sent))).rejects.toBeInstanceOf(PageContentNotApplied);
    expect(sent).toEqual([]);
  });

  it("refuses the accept when a page was made at a reviewed addition's address since the check, sending nothing", async () => {
    githubAddedTwo();
    const { db, sets } = recordingDb(BASE, [importedPageRow(8, "about", ABOUT)]);
    const sent: SyncIngestPayload[] = [];
    const accept = applyFullSyncChanges(1, noPageChoices(), "tok", "o", "r", db, 7, ingestEnv(insertedAnswer({ credits: 12 }), sent));
    await expect(accept).rejects.toMatchObject({ changedSinceReview: [8] });
    expect(sent).toEqual([]);
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
  });

  it("refuses the accept when the check lists an addition the dialog did not show, sending nothing", async () => {
    githubAddedTwo();
    const { db, sets } = recordingDb(BASE, []);
    const sent: SyncIngestPayload[] = [];
    const accept = applyFullSyncChanges(1, noPageChoices(["about.md"]), "tok", "o", "r", db, 7, ingestEnv(insertedAnswer({ about: 11, credits: 12 }), sent));
    await expect(accept).rejects.toBeInstanceOf(SyncBaseStale);
    expect(sent).toEqual([]);
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
  });

  it("restores a page deleted here that GitHub edited, from the check's file, and maps the file to the new page", async () => {
    gh.trees = { [BASE]: { [PAGES]: { "about.md": "a1" } }, [HEAD]: { [PAGES]: { "about.md": "a2" } } };
    const { db, sets } = recordingDb(BASE, [], { project: { record: JSON.stringify({ commit: BASE, files: { "about.md": 7 } }) } });
    const sent: SyncIngestPayload[] = [];
    const take = changes({ pages: { acceptContent: [], takeFiles: [{ name: "about.md", pageId: 7, expected: "" }], addFiles: [] } });
    await applyFullSyncChanges(1, take, "tok", "o", "r", db, 7, ingestEnv(insertedAnswer({ about: 21 }), sent));
    expect(sent[0].pages?.insert).toEqual([expect.objectContaining({ slug: "about", title: "About", created_by: null })]);
    const headWrite = sets.find((s) => "head_sha" in s)!;
    expect(JSON.parse(headWrite.page_files_json as string)).toEqual({ commit: HEAD, files: { "about.md": 21 } });
  });

  it("records a file the last publish named over no record with no page, and does not take it (R9)", async () => {
    githubAddedTwo();
    const { db, sets } = recordingDb(BASE, [], { project: { snapshot: JSON.stringify({ page_slugs: ["credits"] }) } });
    const sent: SyncIngestPayload[] = [];
    await applyFullSyncChanges(1, noPageChoices(["about.md"]), "tok", "o", "r", db, 7, ingestEnv(insertedAnswer({ about: 11 }), sent));
    expect(sent[0].pages?.insert?.map((p) => p.slug)).toEqual(["about"]);
    const headWrite = sets.find((s) => "head_sha" in s)!;
    expect(JSON.parse(headWrite.page_files_json as string).files).toEqual({ "about.md": 11, "credits.md": null });
  });
});

describe("the accept of a page GitHub deleted", () => {
  const about = importedPageRow(5, "about", ABOUT);
  function githubDeletedAbout() {
    gh.trees = { [BASE]: { [PAGES]: { "about.md": "a1" } }, [HEAD]: { [PAGES]: { "credits.md": "k1" } } };
    gh.files = {
      [`${BASE}:${PAGES}/about.md`]: ABOUT,
      [`${HEAD}:${PAGES}/credits.md`]: CREDITS,
      [`${HEAD}:_data/navigation.yml`]: TEMPLATE_MENU,
    };
  }

  it("names the menu entry a removal takes with it", async () => {
    githubDeletedAbout();
    const menu = [...SAVED_MENU, { type: "page", slug: "about", label: "About", visible: true }];
    const check = await checkPageFiles({ token: "t", owner: "o", repo: "r" }, scope({ d1: [about], saved: menu as never }), BASE, HEAD);
    if (!check.conclusive) throw new Error(check.reason);
    expect(check.files?.find((f) => f.name === "about.md")).toMatchObject({ kind: "deleted", inMenu: true });
  });

  it("removes the page by the hash reviewed, and drops the file from the record", async () => {
    githubDeletedAbout();
    const { db, sets } = recordingDb(BASE, [about], { project: { record: JSON.stringify({ commit: BASE, files: { "about.md": 5 } }) } });
    const sent: SyncIngestPayload[] = [];
    const take = changes({ pages: { acceptContent: [], takeFiles: [{ name: "about.md", pageId: 5, expected: "h5" }], addFiles: ["credits.md"] } });
    const env = ingestEnv(() => ({ pageRemove: { applied: [5] }, insertedPages: { credits: 13 } }), sent);
    const result = await applyFullSyncChanges(1, take, "tok", "o", "r", db, 7, env);
    expect(sent[0].pages?.remove).toEqual([{ pageId: 5, slug: "about", expected: "h5" }]);
    expect(result.newHeadSha).toBe(HEAD);
    const headWrite = sets.find((s) => "head_sha" in s)!;
    expect(JSON.parse(headWrite.page_files_json as string).files).toEqual({ "credits.md": 13 });
  });

  it("keeps head_sha when a removal is refused as changed since review", async () => {
    githubDeletedAbout();
    const { db, sets } = recordingDb(BASE, [about]);
    const take = changes({ pages: { acceptContent: [], takeFiles: [{ name: "about.md", pageId: 5, expected: "h5" }], addFiles: ["credits.md"] } });
    const env = ingestEnv(() => ({ heldBack: true, pageRemove: { changedSinceReview: [5] } }), []);
    await expect(applyFullSyncChanges(1, take, "tok", "o", "r", db, 7, env)).rejects.toMatchObject({ changedSinceReview: [5] });
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
  });
});

describe("one file per page: a sister file GitHub added", () => {
  const insertedAnswer = (ids: Record<string, number>) => () => ({ insertedPages: ids });
  /** acerca.md as the Compositor stores it: its block without the two language lines. */
  const ACERCA_AS_PAGE = parsePageMarkdown(ACERCA.replace("localized_for: about.md\nlanguage: es\n", ""), "about");

  function githubAddedAboutAndAcerca() {
    gh.trees = { [BASE]: { [PAGES]: {} }, [HEAD]: { [PAGES]: { "about.md": "a1", "acerca.md": "c1" } } };
    gh.files = {
      [`${HEAD}:${PAGES}/about.md`]: ABOUT,
      [`${HEAD}:${PAGES}/acerca.md`]: ACERCA,
      [`${HEAD}:_data/navigation.yml`]: TEMPLATE_MENU,
    };
  }

  function githubAddedAcerca() {
    gh.trees = { [BASE]: { [PAGES]: { "about.md": "a1" } }, [HEAD]: { [PAGES]: { "about.md": "a1", "acerca.md": "c1" } } };
    gh.files = { [`${HEAD}:${PAGES}/about.md`]: ABOUT, [`${BASE}:${PAGES}/about.md`]: ABOUT, [`${HEAD}:${PAGES}/acerca.md`]: ACERCA };
  }

  it("on a Spanish site takes the added about page from acerca.md, never offers acerca.md, and records it with no page", async () => {
    githubAddedAboutAndAcerca();
    const { db, sets } = recordingDb(BASE, [], { config: { navigation: JSON.stringify(SAVED_MENU), lang: "es" } });
    const sent: SyncIngestPayload[] = [];
    await applyFullSyncChanges(1, noPageChoices(["about.md"]), "tok", "o", "r", db, 7, ingestEnv(insertedAnswer({ about: 11 }), sent));
    expect(sent[0].pages?.insert).toEqual([expect.objectContaining({ slug: "about", ...ACERCA_AS_PAGE })]);
    const headWrite = sets.find((s) => "head_sha" in s)!;
    expect(JSON.parse(headWrite.page_files_json as string).files).toEqual({ "about.md": 11, "acerca.md": null });
  });

  it("on an English site takes about.md as it is and records acerca.md with no page", async () => {
    githubAddedAboutAndAcerca();
    const check = await checkPageFiles({ token: "t", owner: "o", repo: "r" }, scope(), BASE, HEAD);
    if (!check.conclusive) throw new Error(check.reason);
    expect(check.additions?.map((a) => [a.name, a.title, a.readFrom])).toEqual([["about.md", "About", undefined]]);
    expect(check.record?.files).toEqual({ "about.md": null, "acerca.md": null });
  });

  it("on a Spanish site gives a held page acerca.md's text as a change from GitHub, taken by default", async () => {
    githubAddedAcerca();
    const about = importedPageRow(5, "about", ABOUT);
    const check = await checkPageFiles({ token: "t", owner: "o", repo: "r" }, scope({ d1: [about], siteLanguage: "es" }), BASE, HEAD);
    if (!check.conclusive) throw new Error(check.reason);
    const expected = await pageRawHash(pageContentAsLoaded(about));
    expect(check.changes).toEqual([{ pageId: 5, slug: "acerca", title: "About", kind: "github-only", acceptByDefault: true, expected, takesLanguageFrom: "acerca.md" }]);
    expect(check.additions).toEqual([]);
    expect(check.record?.files).toEqual({ "about.md": 5, "acerca.md": null });

    const { db } = recordingDb(BASE, [about], { config: { lang: "es" } });
    const sent: SyncIngestPayload[] = [];
    const accept = changes({ pages: { acceptContent: [{ pageId: 5, slug: "acerca", expected }], addFiles: [] } });
    await applyFullSyncChanges(1, accept, "tok", "o", "r", db, 7, ingestEnv(applied([5]), sent));
    expect(sent[0].pages?.replaceContent).toEqual([{ pageId: 5, expected, ...ACERCA_AS_PAGE }]);
  });

  it("on a Spanish site offers acerca.md's text alone when GitHub also edited about.md, which the site does not show", async () => {
    githubAddedAcerca();
    gh.trees[HEAD][PAGES]["about.md"] = "a2";
    gh.files[`${HEAD}:${PAGES}/about.md`] = EDITED;
    const about = importedPageRow(5, "about", ABOUT);
    const check = await checkPageFiles({ token: "t", owner: "o", repo: "r" }, scope({ d1: [about], siteLanguage: "es" }), BASE, HEAD);
    if (!check.conclusive) throw new Error(check.reason);
    expect(check.changes.map((c) => [c.pageId, c.slug])).toEqual([[5, "acerca"]]);
  });

  it("on a Spanish site offers acerca.md's text as a conflict, the author's version kept, when the held page was edited here", async () => {
    githubAddedAcerca();
    const about = { ...importedPageRow(5, "about", ABOUT), body: "Edited in the Compositor." };
    const check = await checkPageFiles({ token: "t", owner: "o", repo: "r" }, scope({ d1: [about], siteLanguage: "es" }), BASE, HEAD);
    if (!check.conclusive) throw new Error(check.reason);
    expect(check.changes).toEqual([expect.objectContaining({ pageId: 5, slug: "acerca", kind: "conflict", acceptByDefault: false })]);
  });

  it("on an English site offers nothing for acerca.md and records it with no page", async () => {
    githubAddedAcerca();
    const about = importedPageRow(5, "about", ABOUT);
    const check = await checkPageFiles({ token: "t", owner: "o", repo: "r" }, scope({ d1: [about] }), BASE, HEAD);
    if (!check.conclusive) throw new Error(check.reason);
    expect([check.changes, check.additions]).toEqual([[], []]);
    expect(check.record?.files).toEqual({ "about.md": 5, "acerca.md": null });
  });
});

describe("one file per page: a pair the project already holds", () => {
  const ACERCA_AS_PAGE = parsePageMarkdown(ACERCA.replace("localized_for: about.md\nlanguage: es\n", ""), "acerca");
  /** Rows as an import before blocks were stored left them: no front matter in D1. */
  const about = { ...importedPageRow(5, "about", ABOUT), frontmatter: null };
  const acerca = { ...importedPageRow(6, "acerca", ACERCA), frontmatter: null };

  function githubHoldsBoth() {
    gh.trees = { [BASE]: { [PAGES]: { "about.md": "a1", "acerca.md": "c1" } }, [HEAD]: { [PAGES]: { "about.md": "a1", "acerca.md": "c1" } } };
    gh.files = {
      [`${BASE}:${PAGES}/about.md`]: ABOUT, [`${HEAD}:${PAGES}/about.md`]: ABOUT,
      [`${BASE}:${PAGES}/acerca.md`]: ACERCA, [`${HEAD}:${PAGES}/acerca.md`]: ACERCA,
    };
  }
  const check = (d1: unknown[], siteLanguage: string) =>
    checkPageFiles({ token: "t", owner: "o", repo: "r" }, scope({ d1: d1 as never, siteLanguage }), BASE, HEAD);

  const sisterText = (row: { title: string; body: string | null }) => ({ title: row.title, body: row.body, frontmatter: ACERCA_AS_PAGE.frontmatter });
  const hashOf = (row: Parameters<typeof pageContentAsLoaded>[0]) => pageRawHash(pageContentAsLoaded(row));
  const bothApplied = (content: number[], removed: number[]) => () => ({
    pageContent: { applied: content, alreadyApplied: [], changedSinceReview: [], failed: [] }, pageRemove: { applied: removed },
  });

  it("on a Spanish site gives the page the sister's text from the Compositor's copy, edits made here included, and removes the sister with no card of its own", async () => {
    githubHoldsBoth();
    const edited = { ...acerca, body: "Editado aquí." };
    const result = await check([about, edited], "es");
    if (!result.conclusive) throw new Error(result.reason);
    expect(result.files).toEqual([]);
    const expected = await hashOf(about);
    expect(result.changes).toEqual([expect.objectContaining({ pageId: 5, slug: "acerca", kind: "github-only", acceptByDefault: true, expected, takesLanguageFrom: "acerca.md" })]);
    expect(result.record?.files).toEqual({ "about.md": 5, "acerca.md": null });

    const { db } = recordingDb(BASE, [about, edited], { config: { lang: "es" } });
    const sent: SyncIngestPayload[] = [];
    const accept = changes({ pages: { acceptContent: [{ pageId: 5, slug: "acerca", expected }], takeFiles: [], addFiles: [] } });
    await applyFullSyncChanges(1, accept, "tok", "o", "r", db, 7, ingestEnv(bothApplied([5], [6]), sent));
    expect(sent[0].pages?.replaceContent).toEqual([{ pageId: 5, expected, ...sisterText(edited) }]);
    expect(sent[0].pages?.remove).toEqual([{ pageId: 6, slug: "acerca", expected: await hashOf(edited) }]);
  });

  it("on a Spanish site makes the page a conflict when it was edited here, keeping the author's version by default, and removes the sister either way", async () => {
    githubHoldsBoth();
    const edited = { ...about, body: "Edited in the Compositor." };
    const result = await check([edited, acerca], "es");
    if (!result.conclusive) throw new Error(result.reason);
    expect(result.files).toEqual([]);
    expect(result.changes).toEqual([expect.objectContaining({ pageId: 5, kind: "conflict", acceptByDefault: false, takesLanguageFrom: "acerca.md" })]);

    const { db } = recordingDb(BASE, [edited, acerca], { config: { lang: "es" } });
    const sent: SyncIngestPayload[] = [];
    const keep = changes({ pages: { acceptContent: [], takeFiles: [], addFiles: [] } });
    await applyFullSyncChanges(1, keep, "tok", "o", "r", db, 7, ingestEnv(bothApplied([], [6]), sent));
    expect(sent[0].pages?.replaceContent).toBeUndefined();
    expect(sent[0].pages?.remove).toEqual([{ pageId: 6, slug: "acerca", expected: await hashOf(acerca) }]);
  });

  it("on an English site offers the sister's removal alone", async () => {
    githubHoldsBoth();
    const result = await check([about, acerca], "en");
    if (!result.conclusive) throw new Error(result.reason);
    expect(result.files?.map((f) => [f.name, f.kind, f.acceptByDefault, f.otherLanguageOf])).toEqual([["acerca.md", "deleted", true, "about.md"]]);
    expect(result.changes).toEqual([]);

    const { db, sets } = recordingDb(BASE, [about, acerca]);
    const sent: SyncIngestPayload[] = [];
    const expected = await hashOf(acerca);
    const take = changes({ pages: { acceptContent: [], takeFiles: [{ name: "acerca.md", pageId: 6, expected }], addFiles: [] } });
    await applyFullSyncChanges(1, take, "tok", "o", "r", db, 7, ingestEnv(bothApplied([], [6]), sent));
    expect(sent[0].pages).toEqual({ remove: [{ pageId: 6, slug: "acerca", expected }] });
    expect(JSON.parse(sets.find((s) => "head_sha" in s)!.page_files_json as string).files).toEqual({ "about.md": 5, "acerca.md": null });
  });

  it("on an English site makes a sister edited here and kept a page of its own, which the next check leaves alone", async () => {
    githubHoldsBoth();
    const edited = { ...acerca, body: "Editado aquí." };
    const result = await check([about, edited], "en");
    if (!result.conclusive) throw new Error(result.reason);
    expect(result.files).toEqual([expect.objectContaining({ name: "acerca.md", kind: "deleted-conflict", acceptByDefault: false, otherLanguageOf: "about.md" })]);

    const { db, sets } = recordingDb(BASE, [about, edited], { project: { record: JSON.stringify({ commit: BASE, files: { "about.md": 5, "acerca.md": 6 } }) } });
    const sent: SyncIngestPayload[] = [];
    const keep = changes({ pages: { acceptContent: [], takeFiles: [], addFiles: [] } });
    const result2 = await applyFullSyncChanges(1, keep, "tok", "o", "r", db, 7, ingestEnv(bothApplied([6], []), sent));
    const expected = await hashOf(edited);
    expect(sent[0].pages?.replaceContent).toEqual([{ pageId: 6, expected, ...sisterText(edited) }]);
    expect(sent[0].pages?.remove).toBeUndefined();
    expect(result2.newHeadSha).toBe(HEAD);
    const record = JSON.parse(sets.find((s) => "head_sha" in s)!.page_files_json as string);
    expect(record.files).toEqual({ "about.md": 5, "acerca.md": 6 });

    const ownPage = { ...edited, frontmatter: ACERCA_AS_PAGE.frontmatter };
    const next = await checkPageFiles({ token: "t", owner: "o", repo: "r" }, scope({ d1: [about, ownPage] as never, record }), HEAD, HEAD);
    if (!next.conclusive) throw new Error(next.reason);
    expect([next.changes, next.files, next.additions]).toEqual([[], [], []]);
  });
});

describe("Keep my version's record", () => {
  it("records a page GitHub added with no page, so the next publish deletes it (R5)", async () => {
    githubAddedTwo();
    const { db } = recordingDb(BASE, []);
    const json = await keptPageFilesRecordJson(db, 1, { token: "t", owner: "o", repo: "r" }, BASE, HEAD);
    expect(JSON.parse(json!)).toEqual({ commit: HEAD, files: { "about.md": null, "credits.md": null } });
  });

  it("leaves out a page GitHub deleted, which stays a page and the next publish writes back", async () => {
    gh.trees = { [BASE]: { [PAGES]: { "about.md": "a1" } }, [HEAD]: { [PAGES]: {} } };
    gh.files = { [`${BASE}:${PAGES}/about.md`]: ABOUT };
    const { db } = recordingDb(BASE, [importedPageRow(5, "about", ABOUT)]);
    const json = await keptPageFilesRecordJson(db, 1, { token: "t", owner: "o", repo: "r" }, BASE, HEAD);
    expect(JSON.parse(json!)).toEqual({ commit: HEAD, files: {} });
  });

  it("carries the record unchanged when the page trees cannot be read", async () => {
    gh.subtreesFail = true;
    const { db } = recordingDb(BASE, []);
    expect(await keptPageFilesRecordJson(db, 1, { token: "t", owner: "o", repo: "r" }, BASE, HEAD)).toBeUndefined();
  });
});
