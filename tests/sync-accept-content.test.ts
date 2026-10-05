/**
 * The full-sync accept for step and layer content.
 *
 * The accept imports from the commit the check read and no other: every file
 * it reads is at the check's HEAD, each accepted story's content is read
 * strictly there, it sends one ingest with `stories.replaceContent` entries
 * carrying the `expected` hash the check recorded, and it advances head_sha to
 * that HEAD and no later. A story the collaboration object refuses as changed
 * since review leaves head_sha where it was.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));

const gh = vi.hoisted(() => ({
  reads: [] as Array<{ fn: string; path?: string; ref?: unknown; strict?: boolean }>,
  files: {} as Record<string, string>,
  trees: {} as Record<string, Record<string, Record<string, string>>>,
  subtreesFail: false,
  subtreeCommits: [] as string[][],
}));

vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    // A commit lands after the accept starts: it must never be read or recorded.
    getRepoHead: vi.fn(async () => "landed-later"),
    getFileContent: vi.fn(async (_t: string, _o: string, _r: string, path: string, ref?: string) => {
      gh.reads.push({ fn: "getFileContent", path, ref });
      return null;
    }),
    getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string, ref: string, options?: { strict?: boolean }) => {
      gh.reads.push({ fn: "getFileAtRef", path, ref, strict: options?.strict });
      const content = gh.files[`${ref}:${path}`];
      return content === undefined ? { status: "absent" } : { status: "ok", content };
    }),
    getRepoTree: vi.fn(async (_t: string, _o: string, _r: string, ref: string) => {
      gh.reads.push({ fn: "getRepoTree", ref });
      return { tree: [], truncated: false };
    }),
    getSubtreeOids: vi.fn(async (_t: string, _o: string, _r: string, commits: string[]) => {
      for (const ref of commits) gh.reads.push({ fn: "getSubtreeOids", ref });
      gh.subtreeCommits.push([...commits]);
      if (gh.subtreesFail) return { ok: false, reason: "truncated" };
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

import * as githubServer from "~/lib/github.server";
import * as freezeLease from "~/lib/freeze-lease.server";
import { applyFullSyncChanges, StoryContentNotApplied, SyncBaseStale } from "~/lib/sync.server";
import type { FullSyncChanges, FullSyncEnv, SyncIngestPayload } from "~/lib/sync.server";
import { __clearStoryBlobCacheForTest } from "~/lib/story-files.server";
import { projects } from "~/db/schema";
import { SQL } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { runPrePublishValidation } from "~/lib/publish.server";
import { buildThreeWayChanges, emptySelections } from "~/components/features/dashboard/SyncConfirmModal";
import type { FullSyncDiff } from "~/lib/sync.server";

const SHEETS = "telar-content/spreadsheets";
const TEXTS = "telar-content/texts/stories";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

/**
 * A D1 stand-in whose writes are recorded and whose reads answer no rows,
 * except the project row, which holds `recordedHead` as its head_sha.
 *
 * A projects write whose condition compares head_sha is evaluated against the
 * row, as D1 would: it lands, and is recorded in `sets`, only while the row
 * holds that head. `afterProjectRead` runs once the project row has been read,
 * as another writer recording a head in between would.
 */
function recordingDb(recordedHead: string | null = null, afterProjectRead?: (row: { head_sha: string | null }) => void) {
  lastRecordedHead = recordedHead;
  const sets: Array<Record<string, unknown>> = [];
  const row = { head_sha: recordedHead };
  let table: unknown;
  let updating: unknown;
  let pending: Record<string, unknown> | null = null;
  let landed = true;
  const chain: Record<string, unknown> = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") {
        const rows = table === projects ? [{ head_sha: row.head_sha }] : updating === projects && landed ? [{ id: 1 }] : [];
        const read = table === projects;
        table = undefined;
        updating = undefined;
        return (resolve: (v: unknown[]) => unknown) => {
          const answered = resolve(rows);
          if (read) afterProjectRead?.(row);
          return answered;
        };
      }
      if (prop === "update") return (t: unknown) => { updating = t; landed = true; return chain; };
      if (prop === "set") return (payload: Record<string, unknown>) => { pending = payload; return chain; };
      if (prop === "where") return (cond: unknown) => {
        if (pending) {
          landed = updating !== projects || headMatches(cond, row.head_sha);
          if (landed) {
            sets.push(pending);
            if (updating === projects && "head_sha" in pending) row.head_sha = pending.head_sha as string;
          }
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

/** Whether a write's condition, as D1 would evaluate it, holds for a row at `head`. */
function headMatches(cond: unknown, head: string | null): boolean {
  if (!(cond instanceof SQL)) return true;
  const { sql, params } = new SQLiteSyncDialect().sqlToQuery(cond);
  if (/"head_sha" is null/i.test(sql)) return head === null;
  const at = /"head_sha" = \?/.exec(sql);
  if (!at) return true;
  // The head_sha parameter is the one bound after every `?` before it.
  const index = (sql.slice(0, at.index).match(/\?/g) ?? []).length;
  return params[index] === head;
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

/** The head_sha of the stand-in database built last. */
let lastRecordedHead: string | null = null;

/**
 * Changes from a dialog whose check read the story and page files to a
 * conclusion (`storyContentChecked`, `pageContentChecked`), for project 1. The check's base is, by default, the
 * head the stand-in database built last records, as a check just run finds it.
 */
function changes(
  overrides: Partial<FullSyncChanges["stories"]> = {},
  headSha: string | null = HEAD,
  baseSha: string | null = lastRecordedHead,
): FullSyncChanges {
  return {
    projectId: 1,
    baseSha,
    storyContentChecked: true,
    pageContentChecked: true,
    objects: { newObjectIds: [], changedObjectIds: [], fieldChoices: {}, removedObjectIds: [], unregisteredObjectIds: [] },
    stories: { accept: [], reject: [], insertNew: [], ...overrides },
    config: { accept: [], reject: [] },
    glossary: { accept: [], reject: [], insertNew: [] },
    ...(headSha ? { headSha } : {}),
  } as FullSyncChanges;
}

const CSV = "step,object,question,answer,layer1_button,layer1_content\n1,obj,Q1,A1,More,panel.md\n2,obj,Q2,A2,,\n";

beforeEach(() => {
  gh.reads.length = 0;
  gh.subtreesFail = false;
  gh.subtreeCommits.length = 0;
  gh.files = {
    [`${HEAD}:${SHEETS}/s1.csv`]: CSV,
    [`${HEAD}:${TEXTS}/panel.md`]: '---\ntitle: "Panel"\n---\n\nThe panel.',
  };
  gh.trees = { [HEAD]: { [SHEETS]: { "s1.csv": "c1" }, [TEXTS]: { "panel.md": "p1" } } };
  __clearStoryBlobCacheForTest();
  vi.mocked(githubServer.getRepoHead).mockClear();
  vi.mocked(freezeLease.controlFreezeLease).mockClear();
});

describe("the accept of a story's content", () => {
  it("reads at the check's HEAD, sends the content with its expected hash, and advances to that HEAD only", async () => {
    const { db, sets } = recordingDb();
    const sent: SyncIngestPayload[] = [];
    const env = ingestEnv(() => ({ content: { applied: ["s1"], alreadyApplied: [], changedSinceReview: [], failed: [] } }), sent);

    const result = await applyFullSyncChanges(
      1, changes({ acceptContent: ["s1"], contentExpected: { s1: "hash-reviewed" } }), "tok", "o", "r", db, 7, env,
    );

    expect(githubServer.getRepoHead).not.toHaveBeenCalled();
    expect(result.newHeadSha).toBe(HEAD);
    expect(new Set(gh.reads.map((r) => r.ref))).toEqual(new Set([HEAD]));
    expect(gh.reads.some((r) => r.fn === "getFileContent")).toBe(false);
    expect(gh.reads.filter((r) => r.path?.endsWith("s1.csv") || r.path?.endsWith("panel.md")).every((r) => r.strict)).toBe(true);

    const [payload] = sent;
    const entry = (payload.stories as { replaceContent?: Array<Record<string, unknown>> }).replaceContent![0];
    expect(entry).toMatchObject({ storyId: "s1", expected: "hash-reviewed" });
    expect((entry.steps as Array<{ question: string }>).map((s) => s.question)).toEqual(["Q1", "Q2"]);
    expect(entry.layers).toEqual([expect.objectContaining({ step_index: 0, layer_number: 1, title: "Panel", content: "The panel." })]);

    const heads = sets.filter((s) => "head_sha" in s).map((s) => s.head_sha);
    expect(heads).toEqual([HEAD]);
    // The story's steps now come from its spreadsheets CSV, over any older copy the import read.
    expect(sets.filter((s) => "source_path" in s)).toEqual([{ source_path: `${SHEETS}/s1.csv` }]);
  });

  it("does not advance head_sha when a story is refused as changed since review", async () => {
    const { db, sets } = recordingDb();
    const sent: SyncIngestPayload[] = [];
    const env = ingestEnv(() => ({ content: { applied: [], alreadyApplied: [], changedSinceReview: ["s1"], failed: [] } }), sent);

    const accept = applyFullSyncChanges(
      1, changes({ acceptContent: ["s1"], contentExpected: { s1: "hash-reviewed" } }), "tok", "o", "r", db, 7, env,
    );

    await expect(accept).rejects.toBeInstanceOf(StoryContentNotApplied);
    await expect(accept).rejects.toMatchObject({ changedSinceReview: ["s1"] });
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
    expect(sets.some((s) => "source_path" in s)).toBe(false);
  });

  // All or nothing: the collaboration object wrote nothing, so
  // neither does the accept.
  it("writes none of the other changes' residue when it refuses", async () => {
    gh.files[`${HEAD}:${SHEETS}/glossary.csv`] = "term_id,title,definition,related_terms\nt1,Term,Defined,t2\n";
    const { db, sets } = recordingDb();
    const env = ingestEnv(() => ({ content: { applied: [], alreadyApplied: [], changedSinceReview: ["s1"], failed: [] } }), []);
    const withTerm = changes({ acceptContent: ["s1"], contentExpected: { s1: "hash-reviewed" } });
    withTerm.glossary.insertNew = ["t1"];
    await expect(applyFullSyncChanges(1, withTerm, "tok", "o", "r", db, 7, env)).rejects.toBeInstanceOf(StoryContentNotApplied);
    expect(sets.some((s) => s.related_terms === "t2")).toBe(false);
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
  });

  it("does not advance head_sha when a story's content did not reach D1", async () => {
    const { db, sets } = recordingDb();
    const env = ingestEnv(() => ({ content: { applied: [], alreadyApplied: [], changedSinceReview: [], failed: ["s1"] } }), []);
    const accept = applyFullSyncChanges(
      1, changes({ acceptContent: ["s1"], contentExpected: { s1: "hash-reviewed" } }), "tok", "o", "r", db, 7, env,
    );
    await expect(accept).rejects.toMatchObject({ failed: ["s1"], changedSinceReview: [] });
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
  });

  it("sends a story whose step CSV HEAD no longer holds as a story with no steps", async () => {
    delete gh.files[`${HEAD}:${SHEETS}/s1.csv`];
    delete gh.trees[HEAD][SHEETS]["s1.csv"];
    const { db } = recordingDb();
    const sent: SyncIngestPayload[] = [];
    const env = ingestEnv(() => ({ content: { applied: ["s1"], alreadyApplied: [], changedSinceReview: [], failed: [] } }), sent);
    await applyFullSyncChanges(1, changes({ acceptContent: ["s1"], contentExpected: { s1: "h" } }), "tok", "o", "r", db, 7, env);
    const entry = (sent[0].stories as { replaceContent?: Array<Record<string, unknown>> }).replaceContent![0];
    expect(entry).toMatchObject({ steps: [], layers: [] });
  });

  it("refuses a story accepted without the hash its review recorded", async () => {
    const { db } = recordingDb();
    const accept = applyFullSyncChanges(1, changes({ acceptContent: ["s1"] }), "tok", "o", "r", db, 7, ingestEnv(() => ({}), []));
    await expect(accept).rejects.toThrow(/expected/);
  });

  it("with no HEAD from the check, resolves one before reading and never again", async () => {
    const { db, sets } = recordingDb();
    const result = await applyFullSyncChanges(1, changes({}, null), "tok", "o", "r", db, 7, ingestEnv(() => ({}), []));
    expect(githubServer.getRepoHead).toHaveBeenCalledTimes(1);
    expect(result.newHeadSha).toBe("landed-later");
    expect(new Set(gh.reads.map((r) => r.ref))).toEqual(new Set(["landed-later"]));
    expect(sets.filter((s) => "head_sha" in s).map((s) => s.head_sha)).toEqual(["landed-later"]);
  });

  it.each([
    ["not hex", "check-head"],
    ["uppercase", HEAD.toUpperCase()],
    ["39 characters", HEAD.slice(1)],
    ["41 characters", `${HEAD}0`],
    ["a ref name", "main"],
    ["a path", "../0123456789abcdef0123456789abcdef0123"],
    ["an empty string", ""],
    ["a number", 12345],
  ])("refuses a headSha that is %s before anything is read or written", async (_label, headSha) => {
    const { db, sets } = recordingDb();
    const sent: SyncIngestPayload[] = [];
    const accept = applyFullSyncChanges(
      1, { ...changes({ acceptContent: ["s1"], contentExpected: { s1: "h" } }), headSha } as unknown as FullSyncChanges,
      "tok", "o", "r", db, 7, ingestEnv(() => ({}), sent),
    );
    await expect(accept).rejects.toThrow(/headSha/);
    expect(freezeLease.controlFreezeLease).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(sets).toEqual([]);
    expect(gh.reads).toEqual([]);
    expect(githubServer.getRepoHead).not.toHaveBeenCalled();
  });
});

describe("head_sha after the accept, when the story files cannot be read", () => {
  const BASE = "fedcba9876543210fedcba9876543210fedcba98";
  const emptyAnswer = () => ({ content: { applied: [], alreadyApplied: [], changedSinceReview: [], failed: [] } });

  it("applies the other changes and leaves head_sha when the story trees do not conclude", async () => {
    gh.subtreesFail = true;
    const { db, sets } = recordingDb(BASE);
    const sent: SyncIngestPayload[] = [];
    const result = await applyFullSyncChanges(1, changes(), "tok", "o", "r", db, 7, ingestEnv(emptyAnswer, sent));
    expect(sent).toHaveLength(1);
    expect(result).toMatchObject({ newHeadSha: null, storyFilesInconclusive: true });
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
    // The accept's page check first, then the story trees.
    expect(gh.subtreeCommits).toEqual([[BASE, HEAD], [BASE, HEAD]]);
  });

  it("advances head_sha when they conclude, reading the recorded base and the check's HEAD", async () => {
    const { db, sets } = recordingDb(BASE);
    const result = await applyFullSyncChanges(1, changes(), "tok", "o", "r", db, 7, ingestEnv(emptyAnswer, []));
    expect(result).toMatchObject({ newHeadSha: HEAD, storyFilesInconclusive: false });
    expect(sets.filter((s) => "head_sha" in s).map((s) => s.head_sha)).toEqual([HEAD]);
    // The accept's page check first, then the story trees.
    expect(gh.subtreeCommits).toEqual([[BASE, HEAD], [BASE, HEAD]]);
  });

  it("reads HEAD's trees alone when no head is recorded, and holds the same way", async () => {
    gh.subtreesFail = true;
    const { db, sets } = recordingDb(null);
    const result = await applyFullSyncChanges(1, changes(), "tok", "o", "r", db, 7, ingestEnv(emptyAnswer, []));
    expect(result.storyFilesInconclusive).toBe(true);
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
    expect(gh.subtreeCommits).toEqual([[HEAD], [HEAD]]);
  });

  it("refuses a check whose base is no longer the recorded head, ingesting nothing", async () => {
    // The check compared G against BASE; another writer has since recorded MOVED.
    const MOVED = "3333333333333333333333333333333333333333";
    const { db, sets } = recordingDb(MOVED);
    const sent: SyncIngestPayload[] = [];
    const accept = applyFullSyncChanges(1, changes({}, HEAD, BASE), "tok", "o", "r", db, 7, ingestEnv(emptyAnswer, sent));
    await expect(accept).rejects.toBeInstanceOf(SyncBaseStale);
    expect(sent).toEqual([]);
    expect(sets).toEqual([]);
    expect(freezeLease.controlFreezeLease).not.toHaveBeenCalled();
  });

  it("refuses a check computed against no base once a head is recorded", async () => {
    const { db } = recordingDb(BASE);
    const sent: SyncIngestPayload[] = [];
    await expect(
      applyFullSyncChanges(1, changes({}, HEAD, null), "tok", "o", "r", db, 7, ingestEnv(emptyAnswer, sent)),
    ).rejects.toBeInstanceOf(SyncBaseStale);
    expect(sent).toEqual([]);
  });

  it("refuses a payload with no base, as an older page sends", async () => {
    const { db } = recordingDb(BASE);
    const sent: SyncIngestPayload[] = [];
    const { baseSha: _dropped, ...older } = changes();
    await expect(
      applyFullSyncChanges(1, older as FullSyncChanges, "tok", "o", "r", db, 7, ingestEnv(emptyAnswer, sent)),
    ).rejects.toBeInstanceOf(SyncBaseStale);
    expect(sent).toEqual([]);
  });

  it("refuses a check of another project", async () => {
    const { db } = recordingDb(BASE);
    const sent: SyncIngestPayload[] = [];
    await expect(
      applyFullSyncChanges(1, { ...changes(), projectId: 2 }, "tok", "o", "r", db, 7, ingestEnv(emptyAnswer, sent)),
    ).rejects.toBeInstanceOf(SyncBaseStale);
    expect(sent).toEqual([]);
  });

  it("applies and advances from the base when it is still the recorded head", async () => {
    const { db, row } = recordingDb(BASE);
    const sent: SyncIngestPayload[] = [];
    const result = await applyFullSyncChanges(1, changes({}, HEAD, BASE), "tok", "o", "r", db, 7, ingestEnv(emptyAnswer, sent));
    expect(sent).toHaveLength(1);
    expect(result).toEqual({ newHeadSha: HEAD, storyFilesInconclusive: false, pageFilesInconclusive: false });
    expect(row.head_sha).toBe(HEAD);
  });

  it("keeps a head recorded between the apply's read and its write, and records none of its own", async () => {
    // Keep my version takes no lease: it can record a head while the apply
    // runs, here after the base is checked again under the lease (the third
    // read of the project row, after the accept's page check reads the
    // record), so only the compare-and-set write can see it.
    const KEPT = "2222222222222222222222222222222222222222";
    let projectReads = 0;
    const { db, sets, row } = recordingDb(BASE, (r) => {
      projectReads++;
      if (projectReads === 3) r.head_sha = KEPT;
    });
    const result = await applyFullSyncChanges(1, changes(), "tok", "o", "r", db, 7, ingestEnv(emptyAnswer, []));
    expect(row.head_sha).toBe(KEPT);
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
    expect(result).toEqual({ newHeadSha: null, storyFilesInconclusive: false, pageFilesInconclusive: false });
  });

  it("advances from the head it read, and stamps the sync with it", async () => {
    const { db, sets, row } = recordingDb(BASE);
    await applyFullSyncChanges(1, changes(), "tok", "o", "r", db, 7, ingestEnv(emptyAnswer, []));
    expect(row.head_sha).toBe(HEAD);
    expect(sets.find((s) => "head_sha" in s)).toMatchObject({ head_sha: HEAD, gh_checked_at: null, last_synced_at: expect.any(String) });
  });

  it.each([
    ["says the story files were not read, when they were", false, true],
    ["says they were read, when they were not", true, false],
  ])("ignores a made-up client flag that %s", async (_label, fail, flag) => {
    gh.subtreesFail = fail;
    const { db, sets } = recordingDb(BASE);
    const withFlag = { ...changes(), storyFilesInconclusive: flag, storyFilesRead: !flag } as unknown as FullSyncChanges;
    const result = await applyFullSyncChanges(1, withFlag, "tok", "o", "r", db, 7, ingestEnv(emptyAnswer, []));
    expect(result.storyFilesInconclusive).toBe(fail);
    expect(sets.some((s) => "head_sha" in s)).toBe(!fail);
  });
});

describe("head_sha after the accept, when the check the dialog showed could not read the story files", () => {
  const BASE = "fedcba9876543210fedcba9876543210fedcba98";
  const emptyAnswer = () => ({ content: { applied: [], alreadyApplied: [], changedSinceReview: [], failed: [] } });
  const diffWithContent = (content: unknown) => ({
    objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [] },
    stories: { newStories: [], changedStories: [], missingStories: [], content },
    config: { changedFields: [], versionChange: null },
    glossary: { added: [], changed: [], removed: [] },
    pages: { conclusive: true, changes: [], suppressedEditorOnly: 0 },
    hasConflicts: false, classification: "three-way", suppressedEditorOnly: 0, headSha: HEAD, projectId: 1, baseSha: BASE,
  }) as unknown as FullSyncDiff;

  it("holds head_sha when the check failed at the tree read, even though the accept's tree read succeeds", async () => {
    const shown = buildThreeWayChanges(diffWithContent({ conclusive: false, reason: "the story trees came back truncated" }), emptySelections());
    const { db, sets } = recordingDb(BASE);
    const result = await applyFullSyncChanges(1, JSON.parse(JSON.stringify(shown)), "tok", "o", "r", db, 7, ingestEnv(emptyAnswer, []));
    expect(gh.subtreesFail).toBe(false);
    expect(result).toMatchObject({ newHeadSha: null, storyFilesInconclusive: true });
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
  });

  it("advances head_sha when the check was conclusive and the accept's trees conclude", async () => {
    const shown = buildThreeWayChanges(diffWithContent({ conclusive: true, changes: [], suppressedEditorOnly: 0 }), emptySelections());
    const { db, sets } = recordingDb(BASE);
    const result = await applyFullSyncChanges(1, JSON.parse(JSON.stringify(shown)), "tok", "o", "r", db, 7, ingestEnv(emptyAnswer, []));
    expect(result).toMatchObject({ newHeadSha: HEAD, storyFilesInconclusive: false });
    expect(sets.filter((s) => "head_sha" in s).map((s) => s.head_sha)).toEqual([HEAD]);
  });

  it.each([
    ["absent, as an older dialog sends it", undefined],
    ["false", false],
    ["a string", "true"],
  ])("holds head_sha when the flag is %s", async (_label, flag) => {
    const { db, sets } = recordingDb(BASE);
    const { storyContentChecked: _dropped, ...rest } = changes();
    const sent = (flag === undefined ? rest : { ...rest, storyContentChecked: flag }) as FullSyncChanges;
    const result = await applyFullSyncChanges(1, sent, "tok", "o", "r", db, 7, ingestEnv(emptyAnswer, []));
    expect(result).toMatchObject({ newHeadSha: null, storyFilesInconclusive: true });
    expect(sets.some((s) => "head_sha" in s)).toBe(false);
  });
});

describe("story ids that name Object.prototype's own properties", () => {
  it.each(["constructor", "__proto__"])("accepts GitHub's content for %s with the hash its review recorded", async (id) => {
    gh.files[`${HEAD}:${SHEETS}/${id}.csv`] = CSV;
    gh.trees[HEAD][SHEETS][`${id}.csv`] = "c-proto";
    const diff = {
      objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [] },
      stories: {
        newStories: [], changedStories: [], missingStories: [],
        content: {
          conclusive: true, suppressedEditorOnly: 0,
          changes: [{ story_id: id, title: "Story", kind: "github-only", acceptByDefault: true,
            summary: { d1Steps: 1, headSteps: 2, changedSteps: 1 }, expected: `hash-${id}` }],
        },
      },
      config: { changedFields: [], versionChange: null },
      glossary: { added: [], changed: [], removed: [] },
      pages: { conclusive: true, changes: [], suppressedEditorOnly: 0 },
      hasConflicts: false, classification: "three-way", suppressedEditorOnly: 0, headSha: HEAD, projectId: 1, baseSha: null,
    } as unknown as FullSyncDiff;
    const built = buildThreeWayChanges(diff, emptySelections());
    const wire = JSON.parse(JSON.stringify(built)) as FullSyncChanges;
    expect(wire.stories.acceptContent).toEqual([id]);
    expect(Object.hasOwn(wire.stories.contentExpected!, id)).toBe(true);

    const { db } = recordingDb();
    const sent: SyncIngestPayload[] = [];
    const env = ingestEnv(() => ({ content: { applied: [id], alreadyApplied: [], changedSinceReview: [], failed: [] } }), sent);
    const result = await applyFullSyncChanges(1, wire, "tok", "o", "r", db, 7, env);
    expect(result.newHeadSha).toBe(HEAD);
    expect(sent[0].stories.replaceContent).toEqual([expect.objectContaining({ storyId: id, expected: `hash-${id}` })]);
  });

  it("refuses a story whose hash is only inherited", async () => {
    const { db } = recordingDb();
    const wire = { ...changes({ acceptContent: ["constructor"] }), stories: { ...changes().stories, acceptContent: ["constructor"], contentExpected: {} } };
    const accept = applyFullSyncChanges(1, wire as FullSyncChanges, "tok", "o", "r", db, 7, ingestEnv(() => ({}), []));
    await expect(accept).rejects.toThrow(/expected/);
  });
});

describe("an unreadable story kept as the Compositor's version", () => {
  it("leaves nothing blocking publish: the accept records the check's HEAD, which the stale-head check compares", async () => {
    const BASE = "fedcba9876543210fedcba9876543210fedcba98";
    const diff = {
      objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [] },
      stories: {
        newStories: [], changedStories: [], missingStories: [],
        content: {
          conclusive: true,
          suppressedEditorOnly: 0,
          changes: [{
            story_id: "s1", title: "Story", kind: "unreadable", acceptByDefault: false,
            reason: { code: "layer_reference_directory", reference: "x" },
            summary: { d1Steps: 2, headSteps: null, changedSteps: 0 }, expected: "hash-s1",
          }],
        },
      },
      config: { changedFields: [], versionChange: null },
      glossary: { added: [], changed: [], removed: [] },
      pages: { conclusive: true, changes: [], suppressedEditorOnly: 0 },
      hasConflicts: false, classification: "three-way", suppressedEditorOnly: 0, headSha: HEAD, projectId: 1, baseSha: BASE,
    } as unknown as FullSyncDiff;
    const kept = buildThreeWayChanges(diff, emptySelections());
    expect(kept.stories.acceptContent).toEqual([]);

    const { db, sets } = recordingDb(BASE);
    const sent: SyncIngestPayload[] = [];
    const result = await applyFullSyncChanges(1, kept, "tok", "o", "r", db, 7, ingestEnv(() => ({}), sent));
    expect(sent[0].stories.replaceContent).toBeUndefined();
    const recorded = sets.find((s) => "head_sha" in s)?.head_sha as string;
    expect(recorded).toBe(HEAD);
    expect(result.newHeadSha).toBe(HEAD);

    const blockers = (repoHead: string) => runPrePublishValidation({
      headSha: recorded, currentRepoHead: repoHead, stories: [], steps: [], objects: [], pages: [], glossary: [],
    }).blockers.map((b) => b.code);
    expect(blockers(HEAD)).not.toContain("stale_head");
    // A commit landing after the check still blocks, as it should.
    expect(blockers("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toContain("stale_head");
  });
});

