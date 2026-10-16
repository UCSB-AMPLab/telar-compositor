/**
 * A story or glossary term deleted on GitHub that the author deletes here too:
 * the diff names each by its D1 row id and says whether it was edited here
 * since the base; the apply sends a removal only for a row holding the key and
 * the id the author was shown, and never for one back on GitHub; the
 * collaboration object removes the row from the document and the snapshot
 * deletes it from D1.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as Y from "yjs";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

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
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));
vi.mock("~/lib/github.server", () => ({
  getFileContent: vi.fn(),
  getFileAtRef: vi.fn(),
  getRepoTree: vi.fn(),
  getRepoHead: vi.fn(),
  getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
  graphqlGitHub: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
  decodeGitHubContent: vi.fn((s: string) => s),
}));

import * as githubServer from "~/lib/github.server";
import { strictReadsFromFileContent } from "./helpers/strict-sheet-read";
import { applyFullSyncChanges, computeFullSyncDiff, computeGlossarySyncDiff, resolveFullSyncPayload } from "~/lib/sync.server";
import type { FullSyncChanges } from "~/lib/sync.server";
import { ProjectCollaborationDO } from "../workers/collaboration";
import { PROJECT_ID, SECRET, seedProject } from "./helpers/collaboration-fixture";

const PROJECT_PATH = "telar-content/spreadsheets/project.csv";
const GLOSSARY_PATH = "telar-content/spreadsheets/glossary.csv";

function serveRepo(files: Record<string, string>) {
  vi.mocked(githubServer.getFileContent).mockImplementation(
    async (_t: string, _o: string, _r: string, path: string) => files[path] ?? null,
  );
  vi.mocked(githubServer.getFileAtRef).mockImplementation(
    strictReadsFromFileContent(githubServer.getFileContent, async () => ({ status: "absent" })),
  );
  vi.mocked(githubServer.getRepoHead).mockResolvedValue("head-sha" as never);
  vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false } as never);
}

let opened: MemoryD1[] = [];
afterEach(() => {
  for (const memory of opened) memory.close();
  opened = [];
});

/** The fixture project: story `s1` (row 1) with a step and a layer, term `t1` (row 1), and a second story and term. */
function project(): MemoryD1 {
  const memory = createMemoryD1();
  opened.push(memory);
  seedProject(memory, "text");
  memory.raw.prepare('INSERT INTO stories (id, project_id, story_id, title, "order", order_key) VALUES (2, ?, ?, ?, 1, ?)')
    .run(PROJECT_ID, "s2", "Second", "a00002");
  memory.raw.prepare("INSERT INTO glossary_terms (id, project_id, term_id, order_key, title, definition) VALUES (2, ?, ?, ?, ?, '')")
    .run(PROJECT_ID, "t2", "a00002", "Second term");
  return memory;
}

/** project.csv and glossary.csv holding the second story and term only: `s1` and `t1` deleted on GitHub. */
const DELETED_FIRST = {
  [PROJECT_PATH]: "order,story_id,title\n1,s2,Second\n",
  [GLOSSARY_PATH]: "term_id,title,definition\nt2,Second term,\n",
};

function changes(extra: { stories?: unknown; glossary?: unknown } = {}): FullSyncChanges {
  return {
    objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
    stories: { accept: [], reject: [], insertNew: [], ...(extra.stories ? { remove: extra.stories } : {}) },
    config: { accept: [], reject: [] },
    glossary: { accept: [], reject: [], insertNew: [], ...(extra.glossary ? { remove: extra.glossary } : {}) },
    projectId: PROJECT_ID,
    baseSha: null,
  } as FullSyncChanges;
}

describe("the apply's removals", () => {
  const payloadFor = async (memory: MemoryD1, c: FullSyncChanges) =>
    (await resolveFullSyncPayload(PROJECT_ID, c, "t", "o", "r", drizzle(asD1(memory), { schema }), 1, "head-sha")).payload;

  it("names a story and a term by key and D1 id when the row holds both and GitHub no longer has it", async () => {
    serveRepo(DELETED_FIRST);
    const payload = await payloadFor(project(), changes({ stories: [{ id: "s1", dbId: 1 }], glossary: [{ id: "t1", dbId: 1 }] }));
    expect(payload.stories.remove).toEqual([{ storyId: "s1", docId: 1 }]);
    expect(payload.glossary.remove).toEqual([{ termId: "t1", docId: 1 }]);
  });

  it("sends none for a row re-created under another id, or one back on GitHub", async () => {
    serveRepo(DELETED_FIRST);
    const memory = project();
    const reCreated = await payloadFor(memory, changes({ stories: [{ id: "s1", dbId: 9 }], glossary: [{ id: "t1", dbId: 9 }] }));
    expect(reCreated.stories.remove).toBeUndefined();
    expect(reCreated.glossary.remove).toBeUndefined();
    const backOnGitHub = await payloadFor(memory, changes({ stories: [{ id: "s2", dbId: 2 }], glossary: [{ id: "t2", dbId: 2 }] }));
    expect(backOnGitHub.stories.remove).toBeUndefined();
    expect(backOnGitHub.glossary.remove).toBeUndefined();
  });

  it.each([
    ["a list that is not one", { not: "a list" }],
    ["an entry with no id", [{ dbId: 1 }]],
    ["a D1 id that is not a positive integer", [{ id: "s1", dbId: 0 }]],
  ])("refuses the apply for %s", async (_label, remove) => {
    serveRepo(DELETED_FIRST);
    await expect(payloadFor(project(), changes({ stories: remove }))).rejects.toThrow(/stories\.remove is malformed/);
    await expect(payloadFor(project(), changes({ glossary: remove }))).rejects.toThrow(/glossary\.remove is malformed/);
  });
});

/** The collaboration object over `memory`, its document loaded, and a full sync of `c` through it. */
async function openHost(memory: MemoryD1) {
  memory.raw.prepare("UPDATE projects SET head_sha = ? WHERE id = ?").run("b".repeat(40), PROJECT_ID);
  const ctx = {
    getWebSockets: () => [] as unknown[],
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    storage: {
      getAlarm: async () => null,
      setAlarm: async () => {},
      get: async (key: string) => (key === "docGeneration" ? 0 : undefined),
      put: async () => {},
      list: async () => new Map(),
      delete: async () => 0,
    },
    acceptWebSocket: vi.fn(),
  };
  const host = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: asD1(memory), SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (host as unknown as { projectId: number }).projectId = PROJECT_ID;
  await (host as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
  const ydoc = (host as unknown as { ydoc: Y.Doc }).ydoc;
  const stub = { fetch: async (req: Request) => host.fetch(req) };
  const env = { SESSION_SECRET: SECRET, COLLABORATION: { idFromName: (n: string) => n, get: () => stub } } as unknown as Env;
  const db = drizzle(asD1(memory), { schema });
  const keys = (name: string, field: string) => ydoc.getArray<Y.Map<unknown>>(name).toArray().map((m) => m.get(field));
  return {
    stories: () => keys("stories", "story_id"),
    terms: () => keys("glossary", "term_id"),
    sync: async (c: FullSyncChanges) => {
      await applyFullSyncChanges(PROJECT_ID, { ...c, baseSha: "b".repeat(40), headSha: "c".repeat(40) }, "t", "o", "r", db, 1, env);
      await (host as unknown as { snapshotToD1: () => Promise<void> }).snapshotToD1();
    },
  };
}

describe("deleting here too what GitHub deleted", () => {
  it("removes the story, its steps and layers, and the term from the document and D1", async () => {
    const memory = project();
    const host = await openHost(memory);
    serveRepo(DELETED_FIRST);

    await host.sync(changes({ stories: [{ id: "s1", dbId: 1 }], glossary: [{ id: "t1", dbId: 1 }] }));

    expect(host.stories()).toEqual(["s2"]);
    expect(host.terms()).toEqual(["t2"]);
    expect(memory.raw.prepare("SELECT story_id FROM stories ORDER BY id").all()).toEqual([{ story_id: "s2" }]);
    expect(memory.raw.prepare("SELECT COUNT(*) AS n FROM steps").get()).toEqual({ n: 0 });
    expect(memory.raw.prepare("SELECT COUNT(*) AS n FROM layers").get()).toEqual({ n: 0 });
    expect(memory.raw.prepare("SELECT term_id FROM glossary_terms ORDER BY id").all()).toEqual([{ term_id: "t2" }]);
  });

  it("keeps both when the author keeps them", async () => {
    const memory = project();
    const host = await openHost(memory);
    serveRepo(DELETED_FIRST);

    await host.sync(changes());

    expect(host.stories()).toEqual(["s1", "s2"]);
    expect(host.terms()).toEqual(["t1", "t2"]);
    expect(memory.raw.prepare("SELECT COUNT(*) AS n FROM stories").get()).toEqual({ n: 2 });
  });
});

describe("the diff's removed terms", () => {
  const db = (memory: MemoryD1) => drizzle(asD1(memory), { schema });

  it("carry the D1 id, and mark a term edited here since the base", async () => {
    const memory = project();
    serveRepo({ [GLOSSARY_PATH]: "term_id,title,definition\n" });
    // The base holds t1 as D1 does, and t2 with another title: t2 was edited here.
    const base = "term_id,title,definition\nt1,glossary.title as D1 holds it,glossary.definition as D1 holds it\nt2,Before,\n";
    const diff = await computeGlossarySyncDiff(PROJECT_ID, "t", "o", "r", db(memory), base, "head-sha");
    expect(diff.removed).toEqual([
      { term_id: "t1", title: "glossary.title as D1 holds it", dbId: 1 },
      { term_id: "t2", title: "Second term", dbId: 2, editedInCompositor: true },
    ]);
  });

  it("mark none edited in a two-way check", async () => {
    const memory = project();
    serveRepo({ [GLOSSARY_PATH]: "term_id,title,definition\n" });
    const diff = await computeGlossarySyncDiff(PROJECT_ID, "t", "o", "r", db(memory), undefined, "head-sha");
    expect(diff.removed.map((t) => t.editedInCompositor)).toEqual([undefined, undefined]);
  });
});

describe("the diff's missing stories", () => {
  const BASE = "b".repeat(40);

  /** A head whose project.csv holds no story, and a base whose project.csv is `projectCsv`. */
  function serveWithBase(projectCsv: string) {
    serveRepo({ [PROJECT_PATH]: "order,story_id,title\n" });
    vi.mocked(githubServer.getFileAtRef).mockImplementation(
      strictReadsFromFileContent(
        githubServer.getFileContent,
        async (...args: unknown[]) => (args[4] === BASE && args[3] === PROJECT_PATH ? { status: "ok", content: projectCsv } : { status: "absent" }),
        (ref) => ref === BASE,
      ),
    );
  }

  it("carry the D1 id, and mark a story whose row was edited here since the base", async () => {
    const memory = project();
    serveWithBase("order,story_id,title,subtitle,byline\n0,s1,stories.title as D1 holds it,stories.subtitle as D1 holds it,stories.byline as D1 holds it\n1,s2,Before,,\n");
    const diff = await computeFullSyncDiff(PROJECT_ID, "t", "o", "r", drizzle(asD1(memory), { schema }), BASE);
    expect(diff.classification).toBe("three-way");
    expect(diff.stories.missingStories).toEqual([
      { story_id: "s1", title: "stories.title as D1 holds it", dbId: 1 },
      { story_id: "s2", title: "Second", dbId: 2, editedInCompositor: true },
    ]);
  });
});
