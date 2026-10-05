/**
 * Accepting GitHub's version of a project row or a glossary term writes only
 * the fields GitHub changed since the recorded sync base, and the conflicting
 * ones the author chose GitHub for. A field changed only in the Compositor
 * keeps the Compositor's value.
 *
 * These run the real check, the dialog's payload builder, the real accept and
 * the real collaboration object against an in-memory database.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
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
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getRepoHead: vi.fn(),
    getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
    getFileAtRef: vi.fn(),
    getFileContent: vi.fn(async () => null),
    getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
  };
});
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));

import { applyFullSyncChanges, computeFullSyncDiff, SyncBaseStale, type FullSyncDiff } from "~/lib/sync.server";
import { buildThreeWayChanges, emptySelections, type ThreeWaySelections } from "~/components/features/dashboard/sync-changes";
import { getFileAtRef, getRepoHead } from "~/lib/github.server";
import { ProjectCollaborationDO } from "../workers/collaboration";
import { PROJECT_ID, SECRET, seedProject } from "./helpers/collaboration-fixture";

const BASE = "b".repeat(40);
const HEAD = "c".repeat(40);
const PROJECT_CSV = "telar-content/spreadsheets/project.csv";
const GLOSSARY_CSV = "telar-content/spreadsheets/glossary.csv";
const USER = 1;

let memory: MemoryD1;
let db: ReturnType<typeof drizzle<typeof schema>>;
let env: Env;

/** project.csv and glossary.csv at the recorded base and at GitHub's head. */
function serveRowSheets(head: { story: string; term: string }): void {
  const files: Record<string, Record<string, string>> = {
    [BASE]: {
      [PROJECT_CSV]: "order,story_id,title,subtitle,byline\n1,s1,Base title,Base sub,Base by\n",
      [GLOSSARY_CSV]: "term_id,title,definition,related_terms\nt1,Base term,Base def,base-rel\n",
    },
    [HEAD]: {
      [PROJECT_CSV]: `order,story_id,title,subtitle,byline\n1,s1,${head.story}\n`,
      [GLOSSARY_CSV]: `term_id,title,definition,related_terms\nt1,${head.term}\n`,
    },
  };
  vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref) => {
    const content = files[ref]?.[path];
    return content === undefined ? { status: "absent" } : { status: "ok", content };
  });
}

function rowAfterAccept(): { title: string; subtitle: string; byline: string } {
  return memory.raw.prepare("SELECT title, subtitle, byline FROM stories WHERE id = 1").get() as never;
}

function termAfterAccept(): { title: string; definition: string; related_terms: string } {
  return memory.raw.prepare("SELECT title, definition, related_terms FROM glossary_terms WHERE id = 1").get() as never;
}

async function checkAndAccept(sel: ThreeWaySelections = emptySelections()): Promise<FullSyncDiff> {
  const diff = await computeFullSyncDiff(PROJECT_ID, "t", "o", "r", db, BASE);
  await applyFullSyncChanges(PROJECT_ID, buildThreeWayChanges(diff, sel), "t", "o", "r", db, USER, env);
  return diff;
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  memory = createMemoryD1();
  seedProject(memory, "text");
  memory.raw.prepare("UPDATE projects SET head_sha = ? WHERE id = ?").run(BASE, PROJECT_ID);
  // The Compositor retitled the story and the term, changed the story's byline
  // and gave the term other related terms.
  memory.raw.exec("UPDATE stories SET title = 'Mine title', subtitle = 'Base sub', byline = 'Mine by' WHERE id = 1");
  memory.raw.exec(
    "UPDATE glossary_terms SET title = 'Mine term', definition = 'Base def', related_terms = 'mine-rel' WHERE id = 1",
  );
  db = drizzle(asD1(memory), { schema });
  vi.mocked(getRepoHead).mockResolvedValue(HEAD);

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
  const doInstance = new ProjectCollaborationDO(
    ctx as unknown as DurableObjectState,
    { DB: asD1(memory), SESSION_SECRET: SECRET, COLLABORATION: {} as unknown } as unknown as Env,
  );
  (doInstance as unknown as { projectId: number }).projectId = PROJECT_ID;
  await (doInstance as unknown as { ensureDocLoaded: () => Promise<void> }).ensureDocLoaded();
  env = {
    SESSION_SECRET: SECRET,
    COLLABORATION: { idFromName: (n: string) => n, get: () => doInstance },
  } as unknown as Env;
});

afterEach(() => {
  memory.close();
});

describe("a field GitHub changed beside one changed only in the Compositor", () => {
  it("lists only GitHub's fields, applies them by default, and keeps the Compositor's", async () => {
    serveRowSheets({ story: "Base title,GitHub sub,Base by", term: "Base term,GitHub def,base-rel" });

    const diff = await checkAndAccept();

    expect(diff.stories.changedStories).toMatchObject([{ story_id: "s1", changedFields: ["subtitle"], conflictFields: [] }]);
    expect(diff.glossary.changed).toMatchObject([{ term_id: "t1", changedFields: ["definition"], conflictFields: [] }]);
    expect(rowAfterAccept()).toEqual({ title: "Mine title", subtitle: "GitHub sub", byline: "Mine by" });
    expect(termAfterAccept()).toEqual({ title: "Mine term", definition: "GitHub def", related_terms: "mine-rel" });
  });
});

describe("a conflict the author resolves with GitHub's version", () => {
  it("takes the conflicting and GitHub-only fields and keeps the Compositor-only ones", async () => {
    // Both sides retitled; GitHub also changed the subtitle and the definition.
    serveRowSheets({ story: "Their title,GitHub sub,Base by", term: "Their term,GitHub def,base-rel" });
    const sel = { ...emptySelections(), storyChoices: { s1: "repo" as const }, glossaryChangedChoices: { t1: "repo" as const } };

    const diff = await checkAndAccept(sel);

    expect(diff.stories.changedStories).toMatchObject([
      { story_id: "s1", changedFields: ["title", "subtitle"], conflictFields: ["title"], conflict: true },
    ]);
    expect(diff.glossary.changed).toMatchObject([
      { term_id: "t1", changedFields: ["title", "definition"], conflictFields: ["title"], conflict: true },
    ]);
    expect(rowAfterAccept()).toEqual({ title: "Their title", subtitle: "GitHub sub", byline: "Mine by" });
    expect(termAfterAccept()).toEqual({ title: "Their term", definition: "GitHub def", related_terms: "mine-rel" });
  });

  it("keeping the Compositor's version still takes the fields only GitHub changed", async () => {
    serveRowSheets({ story: "Their title,GitHub sub,Base by", term: "Their term,GitHub def,base-rel" });

    await checkAndAccept();

    expect(rowAfterAccept()).toEqual({ title: "Mine title", subtitle: "GitHub sub", byline: "Mine by" });
    expect(termAfterAccept()).toEqual({ title: "Mine term", definition: "GitHub def", related_terms: "mine-rel" });
  });
});

describe("a term column D1 alone holds", () => {
  it("takes GitHub's custom columns and keeps the related terms changed only in the Compositor", async () => {
    const header = "term_id,title,definition,related_terms,source_note";
    const files: Record<string, string> = {
      [BASE]: `${header}\nt1,Mine term,Base def,base-rel,Base note\n`,
      [HEAD]: `${header}\nt1,Mine term,Base def,base-rel,GitHub note\n`,
    };
    vi.mocked(getFileAtRef).mockImplementation(async (_t, _o, _r, path, ref) =>
      path === GLOSSARY_CSV && files[ref] !== undefined ? { status: "ok", content: files[ref] } : { status: "absent" },
    );
    memory.raw.exec(`UPDATE glossary_terms SET extra_columns = '{"source_note":"Base note"}' WHERE id = 1`);

    const diff = await checkAndAccept();

    expect(diff.glossary.changed).toMatchObject([{ term_id: "t1", changedFields: ["extra_columns"], conflictFields: [] }]);
    expect(memory.raw.prepare("SELECT related_terms, extra_columns FROM glossary_terms WHERE id = 1").get()).toEqual({
      related_terms: "mine-rel", extra_columns: JSON.stringify({ source_note: "GitHub note" }),
    });
  });
});

describe("an accept posted without per-field choices (a dialog from before them)", () => {
  it("is refused as stale and applies nothing, so head_sha stays", async () => {
    serveRowSheets({ story: "Base title,GitHub sub,Base by", term: "Base term,GitHub def,base-rel" });
    const diff = await computeFullSyncDiff(PROJECT_ID, "t", "o", "r", db, BASE);
    const built = buildThreeWayChanges(diff, emptySelections());
    for (const legacy of [
      { ...built, stories: { ...built.stories, fieldChoices: undefined } },
      { ...built, glossary: { ...built.glossary, fieldChoices: {} } },
    ]) {
      const refusal = await applyFullSyncChanges(PROJECT_ID, legacy, "t", "o", "r", db, USER, env).catch((e: unknown) => e);
      expect(refusal).toBeInstanceOf(SyncBaseStale);
    }
    expect(memory.raw.prepare("SELECT head_sha FROM projects WHERE id = ?").get(PROJECT_ID)).toEqual({ head_sha: BASE });
    expect(rowAfterAccept().subtitle).toBe("Base sub");
  });
});
