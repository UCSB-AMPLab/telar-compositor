/**
 * A sync refuses a sheet in which two or more columns claim one canonical name
 * and each holds values, naming the sheet and the columns, and writes nothing.
 * A sheet in which only one of them holds values syncs with that column. The
 * base revision a three-way diff reads is not refused, so a sheet the author
 * has fixed in the repo still syncs; and since the base cannot say which of
 * its columns the Compositor holds, a value it fed that differs between the
 * Compositor and the repo is a conflict with the repo's value the default.
 *
 * Every path is driven through the real parse, with only GitHub and D1 faked.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));
vi.mock("~/lib/github.server", () => ({
  getFileContent: vi.fn(),
  getFileAtRef: vi.fn(),
  getRepoTree: vi.fn(),
  getRepoHead: vi.fn(),
  graphqlGitHub: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
  decodeGitHubContent: vi.fn((s: string) => s),
}));

import * as githubServer from "~/lib/github.server";
import { strictReadsFromFileContent } from "./helpers/strict-sheet-read";
import { syncIngestRecorder } from "./helpers/sync-ingest-recorder";
import {
  computeSyncDiff,
  applySyncChanges,
  computeFullSyncDiff,
  computeGlossarySyncDiff,
  resolveFullSyncPayload,
  applyFullSyncChanges,
  objectFieldsFedBy,
  repoDefaultsFor,
  storyFieldsFedBy,
  termFieldsFedBy,
} from "~/lib/sync.server";
import type { FullSyncChanges, FullSyncDiff, FullSyncEnv, SyncChanges } from "~/lib/sync.server";
import { CollidingColumnsRefusal } from "~/lib/import.server";
import { probeSequentialMockDb } from "./sync-probe-fixtures";
import {
  buildThreeWayChanges,
  emptySelections,
  objectFieldChoiceOf,
  rowChoiceOf,
} from "~/components/features/dashboard/sync-changes";

const SHEETS = "telar-content/spreadsheets";

const OBJECTS_BOTH = "object_id,title,medium,object_type\nobj-001,First,Oil,Painting\n";
const OBJECTS_FINE = "object_id,title,medium,object_type\nobj-001,First,,Painting\n";
const PROJECT_BOTH = "order,story_id,title,subtitle,subtítulo\n1,story-one,First,One,Uno\n";
const PROJECT_FINE = "order,story_id,title\n1,story-one,First\n";
const STORY_BOTH =
  "step,object,x,y,zoom,question,pregunta,answer\n1,obj-001,0.5,0.5,1,What?,¿Qué?,An answer\n";
const GLOSSARY_BOTH = "term_id,title,definition,definición\nloom,Loom,A frame.,Un marco.\n";

/** Serves the repo's current files by path; every other path is absent. */
function serveRepo(files: Record<string, string>) {
  vi.mocked(githubServer.getFileContent).mockImplementation(
    async (_t: string, _o: string, _r: string, path: string) => files[path] ?? null,
  );
}

/** Serves the base revision's files by path; every other path is absent. */
function serveBase(files: Record<string, string>) {
  vi.mocked(githubServer.getFileAtRef).mockImplementation(strictReadsFromFileContent(githubServer.getFileContent, async (_t: string, _o: string, _r: string, path: string) =>
      path in files ? { status: "ok", content: files[path] } : { status: "absent" }, (ref) => ref === "base-sha"));
}

/**
 * A D1 stand-in whose reads all come back empty and whose writes are counted.
 * Every chained call is awaitable, so any terminal resolves.
 */
function recordingDb() {
  const writes: string[] = [];
  const chain = (): unknown => {
    const node = Promise.resolve([]) as unknown as Promise<unknown[]> & Record<string, unknown>;
    for (const m of ["from", "where", "limit", "orderBy", "set", "values", "returning", "innerJoin", "leftJoin"]) {
      node[m] = () => chain();
    }
    return node;
  };
  const db = {
    select: () => chain(),
    update: () => {
      writes.push("update");
      return chain();
    },
    insert: () => {
      writes.push("insert");
      return chain();
    },
    delete: () => {
      writes.push("delete");
      return chain();
    },
    batch: async () => {
      writes.push("batch");
      return [];
    },
  };
  return { db: db as unknown as Parameters<typeof computeSyncDiff>[4], writes };
}

/** A collaboration DO binding that counts the ingests it is sent. */
function countingEnv() {
  const ingests: string[] = [];
  const env: FullSyncEnv = {
    SESSION_SECRET: "test-secret",
    COLLABORATION: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (req: Request) => {
          ingests.push(req.url);
          return new Response(JSON.stringify({ applied: {}, skipped: {} }), { status: 200 });
        },
      }),
    },
  } as unknown as FullSyncEnv;
  return { env, ingests };
}

async function refusalFrom(p: Promise<unknown>): Promise<CollidingColumnsRefusal> {
  const outcome = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(outcome).toBeInstanceOf(CollidingColumnsRefusal);
  return outcome as CollidingColumnsRefusal;
}

const NO_OBJECT_CHANGES: SyncChanges = {
  newObjectIds: ["obj-001"],
  changedObjectIds: [],
  fieldChoices: {},
  removedObjectIds: [],
  unregisteredObjectIds: [],
};

function fullChanges(overrides: Partial<FullSyncChanges> = {}): FullSyncChanges {
  return {
    objects: { ...NO_OBJECT_CHANGES, newObjectIds: [] },
    stories: { accept: [], reject: [], insertNew: [] },
    config: { accept: [], reject: [] },
    glossary: { accept: [], reject: [], insertNew: [] },
    // A check computed for project 1 against no recorded head, which is what
    // the stand-in database holds.
    projectId: 1,
    baseSha: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  vi.mocked(githubServer.getRepoHead).mockResolvedValue("new-head");
  serveBase({});
});

describe("the objects page's sync", () => {
  it("computeSyncDiff refuses objects.csv, naming the sheet and both columns", async () => {
    serveRepo({ [`${SHEETS}/objects.csv`]: OBJECTS_BOTH });
    const { db, writes } = recordingDb();
    const err = await refusalFrom(computeSyncDiff(1, "t", "o", "r", db));
    expect(err.sheet).toBe("objects.csv");
    expect(err.canonicalName).toBe("medium_genre");
    expect(err.headers).toEqual(["medium", "object_type"]);
    expect(writes).toEqual([]);
  });

  it("applySyncChanges names objetos.csv where that is the site's file", async () => {
    serveRepo({ [`${SHEETS}/objetos.csv`]: OBJECTS_BOTH });
    const { db, writes } = recordingDb();
    const checkedHead = "f".repeat(40);
    vi.mocked(githubServer.getRepoHead).mockResolvedValue(checkedHead);
    const changes = { ...NO_OBJECT_CHANGES, headSha: checkedHead };
    const err = await refusalFrom(applySyncChanges(1, changes, "t", "o", "r", db, syncIngestRecorder().env, 1));
    expect(err.sheet).toBe("objetos.csv");
    expect(writes).toEqual([]);
  });

  it("applySyncChanges refuses objects.csv and writes nothing", async () => {
    serveRepo({ [`${SHEETS}/objects.csv`]: OBJECTS_BOTH });
    const { db, writes } = recordingDb();
    // A check read at GitHub's head, so the apply reaches the sheet.
    const checkedHead = "f".repeat(40);
    vi.mocked(githubServer.getRepoHead).mockResolvedValue(checkedHead);
    const changes = { ...NO_OBJECT_CHANGES, headSha: checkedHead };
    const err = await refusalFrom(applySyncChanges(1, changes, "t", "o", "r", db, syncIngestRecorder().env, 1));
    expect(err.sheet).toBe("objects.csv");
    expect(writes).toEqual([]);
  });

  it("syncs with the column that holds values when only one does, in either order", async () => {
    const { db } = recordingDb();
    serveRepo({ [`${SHEETS}/objects.csv`]: OBJECTS_FINE });
    expect((await computeSyncDiff(1, "t", "o", "r", db)).newObjects[0].object_type).toBe("Painting");
    serveRepo({ [`${SHEETS}/objects.csv`]: "object_id,title,medium,object_type\nobj-001,First,Oil,\n" });
    expect((await computeSyncDiff(1, "t", "o", "r", db)).newObjects[0].object_type).toBe("Oil");
  });
});

describe("the full sync's diff", () => {
  it("refuses objects.csv", async () => {
    serveRepo({ [`${SHEETS}/objects.csv`]: OBJECTS_BOTH });
    const { db, writes } = recordingDb();
    const err = await refusalFrom(computeFullSyncDiff(1, "t", "o", "r", db, null));
    expect(err.sheet).toBe("objects.csv");
    expect(writes).toEqual([]);
  });

  it("refuses project.csv, naming subtitle and subtítulo", async () => {
    serveRepo({ [`${SHEETS}/project.csv`]: PROJECT_BOTH });
    const { db, writes } = recordingDb();
    const err = await refusalFrom(computeFullSyncDiff(1, "t", "o", "r", db, null));
    expect(err.sheet).toBe("project.csv");
    expect(err.headers).toEqual(["subtitle", "subtítulo"]);
    expect(writes).toEqual([]);
  });

  it("refuses glossary.csv, through the glossary diff on its own and within the full diff", async () => {
    serveRepo({ [`${SHEETS}/glossary.csv`]: GLOSSARY_BOTH });
    const { db, writes } = recordingDb();
    const own = await refusalFrom(computeGlossarySyncDiff(1, "t", "o", "r", db));
    expect(own.sheet).toBe("glossary.csv");
    expect(own.headers).toEqual(["definition", "definición"]);
    const full = await refusalFrom(computeFullSyncDiff(1, "t", "o", "r", db, null));
    expect(full.sheet).toBe("glossary.csv");
    expect(writes).toEqual([]);
  });

  // The base is the revision last synced. A sheet the author has since fixed
  // must sync, although the base still holds both columns.
  it("does not refuse a base that holds both columns when the repo's sheets are fixed", async () => {
    serveRepo({
      [`${SHEETS}/objects.csv`]: OBJECTS_FINE,
      [`${SHEETS}/project.csv`]: PROJECT_FINE,
      [`${SHEETS}/glossary.csv`]: "term_id,title,definition\nloom,Loom,A frame.\n",
    });
    serveBase({
      [`${SHEETS}/objects.csv`]: OBJECTS_BOTH,
      [`${SHEETS}/project.csv`]: PROJECT_BOTH,
      [`${SHEETS}/glossary.csv`]: GLOSSARY_BOTH,
    });
    const { db } = recordingDb();
    const diff = await computeFullSyncDiff(1, "t", "o", "r", db, "base-sha");
    expect(diff.classification).toBe("three-way");
    // The base keeps the last of its two columns, "Painting", which is what the
    // repo's object now holds, so the object reads as unchanged since the base.
    expect(diff.objects.newObjects).toEqual([]);
    expect(diff.suppressedEditorOnly).toBe(1);
  });

  it("refuses the repo's sheet in three-way as well, whatever the base holds", async () => {
    serveRepo({ [`${SHEETS}/objects.csv`]: OBJECTS_BOTH });
    serveBase({ [`${SHEETS}/objects.csv`]: OBJECTS_FINE });
    const { db } = recordingDb();
    const err = await refusalFrom(computeFullSyncDiff(1, "t", "o", "r", db, "base-sha"));
    expect(err.sheet).toBe("objects.csv");
  });
});

describe("the full sync's apply", () => {
  it("refuses objects.csv before the ingest and writes nothing", async () => {
    serveRepo({ [`${SHEETS}/objects.csv`]: OBJECTS_BOTH });
    const { db, writes } = recordingDb();
    const { env, ingests } = countingEnv();
    const err = await refusalFrom(
      applyFullSyncChanges(1, fullChanges({ objects: NO_OBJECT_CHANGES }), "t", "o", "r", db, 7, env),
    );
    expect(err.sheet).toBe("objects.csv");
    expect(writes).toEqual([]);
    expect(ingests).toEqual([]);
  });

  it("names objetos.csv and proyecto.csv where those are the site's files", async () => {
    for (const [english, spanish, content, changes] of [
      ["objects.csv", "objetos.csv", OBJECTS_BOTH, fullChanges({ objects: NO_OBJECT_CHANGES })],
      ["project.csv", "proyecto.csv", PROJECT_BOTH, fullChanges()],
    ] as const) {
      serveRepo({ [`${SHEETS}/${spanish}`]: content });
      const { db } = recordingDb();
      const { env } = countingEnv();
      const err = await refusalFrom(applyFullSyncChanges(1, changes, "t", "o", "r", db, 7, env));
      expect(err.sheet, english).toBe(spanish);
    }
  });

  it("refuses project.csv", async () => {
    serveRepo({ [`${SHEETS}/project.csv`]: PROJECT_BOTH });
    const { db, writes } = recordingDb();
    const { env, ingests } = countingEnv();
    const err = await refusalFrom(applyFullSyncChanges(1, fullChanges(), "t", "o", "r", db, 7, env));
    expect(err.sheet).toBe("project.csv");
    expect(writes).toEqual([]);
    expect(ingests).toEqual([]);
  });

  it("refuses a new story's sheet, naming it", async () => {
    serveRepo({ [`${SHEETS}/project.csv`]: PROJECT_FINE, [`${SHEETS}/story-one.csv`]: STORY_BOTH });
    const { db, writes } = recordingDb();
    const { env, ingests } = countingEnv();
    const changes = fullChanges({ stories: { accept: [], reject: [], insertNew: ["story-one"] } });
    const err = await refusalFrom(applyFullSyncChanges(1, changes, "t", "o", "r", db, 7, env));
    expect(err.sheet).toBe("story-one.csv");
    expect(err.headers).toEqual(["question", "pregunta"]);
    expect(writes).toEqual([]);
    expect(ingests).toEqual([]);
  });

  it("refuses glossary.csv when a term is accepted", async () => {
    serveRepo({ [`${SHEETS}/glossary.csv`]: GLOSSARY_BOTH });
    const { db, writes } = recordingDb();
    const { env, ingests } = countingEnv();
    const changes = fullChanges({ glossary: { accept: ["loom"], reject: [], insertNew: [], fieldChoices: { loom: { title: "repo" as const } } } });
    const err = await refusalFrom(applyFullSyncChanges(1, changes, "t", "o", "r", db, 7, env));
    expect(err.sheet).toBe("glossary.csv");
    expect(writes).toEqual([]);
    expect(ingests).toEqual([]);
  });

  it("resolves the payload from the column that holds values when only one does", async () => {
    serveRepo({ [`${SHEETS}/objects.csv`]: OBJECTS_FINE });
    const { db } = recordingDb();
    const { payload } = await resolveFullSyncPayload(
      1, fullChanges({ objects: NO_OBJECT_CHANGES }), "t", "o", "r", db, 7,
    );
    expect(payload.objects.insert[0].object_type).toBe("Painting");
  });
});

// The import refuses a sheet whose colliding columns both hold values, so D1
// holds the value of one of the base's columns, and which one cannot be read
// from the base. Each case gives D1 one of the two and HEAD one of the two.
describe("a base whose colliding columns both hold values", () => {
  /** A three-way diff holding only `parts`, as the modal's builder takes it. */
  function fullDiff(parts: Partial<FullSyncDiff>): FullSyncDiff {
    return {
      objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [], reordered: null },
      stories: { newStories: [], changedStories: [], missingStories: [] },
      config: { changedFields: [], versionChange: null },
      glossary: { added: [], removed: [], changed: [] },
      hasConflicts: false,
      classification: "three-way",
      suppressedEditorOnly: 0,
      unreadableFiles: [],
      ...parts,
    };
  }

  function d1Object(objectType: string, title = "First") {
    return {
      id: 1, project_id: 1, object_id: "obj-001", origin: "repo", missing_from_repo: false,
      title, object_type: objectType, featured: false, image_available: false,
    };
  }

  /** `base` null is no base, the objects page's own two-way diff. */
  async function objectsDiff(d1Type: string, head: string, d1Title?: string, base: string | null = OBJECTS_BOTH) {
    serveRepo({ [`${SHEETS}/objects.csv`]: head });
    const db = probeSequentialMockDb([[d1Object(d1Type, d1Title)], [], []]);
    return computeSyncDiff(1, "t", "o", "r", db, base ?? undefined);
  }

  function expectRepoDefaultObjectConflict(diff: Awaited<ReturnType<typeof objectsDiff>>, repoValue: string | null) {
    expect(diff.changedObjects).toHaveLength(1);
    const [changed] = diff.changedObjects;
    expect(changed).toMatchObject({ conflictFields: ["object_type"], repoDefaultFields: ["object_type"] });
    expect(changed.repoValues.object_type).toBe(repoValue);
    expect(objectFieldChoiceOf(changed, "object_type", emptySelections())).toBe("repo");
    // What an untouched modal posts: GitHub's value for that field alone.
    const posted = buildThreeWayChanges(fullDiff({ objects: diff }), emptySelections());
    expect(posted.objects.fieldChoices).toEqual({ "obj-001": { object_type: "repo" } });
  }

  it("objects: HEAD keeps the first column: a conflict, the repo's value the default", async () => {
    // OBJECTS_BOTH: medium "Oil", then object_type "Painting".
    expectRepoDefaultObjectConflict(await objectsDiff("Painting", "object_id,title,medium\nobj-001,First,Oil\n"), "Oil");
  });

  it("objects: HEAD keeps the last column: a conflict, the repo's value the default", async () => {
    expectRepoDefaultObjectConflict(await objectsDiff("Oil", "object_id,title,object_type\nobj-001,First,Painting\n"), "Painting");
  });

  it("objects: HEAD keeps one column with the cell blank: a conflict, the repo's clearing the default", async () => {
    expectRepoDefaultObjectConflict(await objectsDiff("Painting", "object_id,title,medium\nobj-001,First,\n"), null);
  });

  it("objects: HEAD keeps the column whose value equals D1: nothing", async () => {
    const diff = await objectsDiff("Painting", "object_id,title,object_type\nobj-001,First,Painting\n");
    expect(diff.changedObjects).toEqual([]);
  });

  // An object's accept writes only the fields posted as "repo", so a title
  // edited only in the Compositor is left out of what is posted and kept.
  it("objects: with a title edited only in the Compositor, the accept posts the collided field alone", async () => {
    expectRepoDefaultObjectConflict(
      await objectsDiff("Painting", "object_id,title,medium\nobj-001,First,Oil\n", "First, edited here"),
      "Oil",
    );
  });

  function d1Story(subtitle: string, title = "First") {
    return {
      id: 1, project_id: 1, story_id: "story-one", order: 1, draft: false, updated_at: null,
      title, subtitle, byline: null, private: false, show_sections: false,
    };
  }

  async function projectDiff(d1Subtitle: string, head: string, d1Title?: string, base: string | null = PROJECT_BOTH) {
    serveRepo({ [`${SHEETS}/project.csv`]: head });
    serveBase(base === null ? {} : { [`${SHEETS}/project.csv`]: base });
    const story = d1Story(d1Subtitle, d1Title);
    const db = probeSequentialMockDb([[], [], [story], [story], []]);
    return computeFullSyncDiff(1, "t", "o", "r", db, base === null ? null : "base-sha");
  }

  function expectStoryConflict(diff: Awaited<ReturnType<typeof projectDiff>>, repoSubtitle: string, repoByDefault: boolean) {
    expect(diff.stories.changedStories).toHaveLength(1);
    const [row] = diff.stories.changedStories;
    expect(row).toMatchObject({ story_id: "story-one", conflict: true });
    expect(row.repoByDefault ?? false).toBe(repoByDefault);
    expect(row.repoValues.subtitle).toBe(repoSubtitle);
    const choice = repoByDefault ? "repo" : "d1";
    expect(rowChoiceOf(emptySelections().storyChoices, "story-one", row.repoByDefault)).toBe(choice);
    const posted = buildThreeWayChanges(fullDiff({ stories: diff.stories }), emptySelections());
    expect(posted.stories.accept).toEqual(repoByDefault ? ["story-one"] : []);
    expect(posted.stories.reject).toEqual(repoByDefault ? [] : ["story-one"]);
  }

  it("project: HEAD keeps the first column: a conflict, the repo's row the default", async () => {
    // PROJECT_BOTH: subtitle "One", then subtítulo "Uno".
    expectStoryConflict(await projectDiff("Uno", "order,story_id,title,subtitle\n1,story-one,First,One\n"), "One", true);
  });

  it("project: HEAD keeps the last column: a conflict, the repo's row the default", async () => {
    expectStoryConflict(await projectDiff("One", "order,story_id,title,subtítulo\n1,story-one,First,Uno\n"), "Uno", true);
  });

  it("project: HEAD keeps the column whose value equals D1: nothing", async () => {
    const diff = await projectDiff("One", "order,story_id,title,subtitle\n1,story-one,First,One\n");
    expect(diff.stories.changedStories).toEqual([]);
  });

  // The accept writes the whole row, so taking GitHub's by default would
  // undo the Compositor's title.
  it("project: with a title edited only in the Compositor, a conflict with the Compositor's row the default", async () => {
    const head = "order,story_id,title,subtitle\n1,story-one,First,One\n";
    expectStoryConflict(await projectDiff("Uno", head, "First, edited here"), "One", false);
  });

  function d1Term(definition: string, title = "Loom") {
    return { id: 1, project_id: 1, term_id: "loom", title, definition, related_terms: null, extra_columns: null };
  }

  /** `base` null is no base, the two-way diff. */
  async function glossaryDiff(d1Definition: string, head: string, d1Title?: string, base: string | null = GLOSSARY_BOTH) {
    serveRepo({ [`${SHEETS}/glossary.csv`]: head });
    const db = probeSequentialMockDb([[d1Term(d1Definition, d1Title)]]);
    return computeGlossarySyncDiff(1, "t", "o", "r", db, base ?? undefined, "head-sha");
  }

  function expectTermConflict(diff: Awaited<ReturnType<typeof glossaryDiff>>, repoDefinition: string, repoByDefault: boolean) {
    expect(diff.changed).toHaveLength(1);
    const [term] = diff.changed;
    expect(term).toMatchObject({ term_id: "loom", conflict: true, repoDefinition });
    expect(term.repoByDefault ?? false).toBe(repoByDefault);
    const choice = repoByDefault ? "repo" : "d1";
    expect(rowChoiceOf(emptySelections().glossaryChangedChoices, "loom", term.repoByDefault)).toBe(choice);
    const posted = buildThreeWayChanges(fullDiff({ glossary: diff }), emptySelections());
    expect(posted.glossary.accept).toEqual(repoByDefault ? ["loom"] : []);
    expect(posted.glossary.reject).toEqual(repoByDefault ? [] : ["loom"]);
  }

  it("glossary: HEAD keeps the first column: a conflict, the repo's term the default", async () => {
    // GLOSSARY_BOTH: definition "A frame.", then definición "Un marco.".
    expectTermConflict(await glossaryDiff("Un marco.", "term_id,title,definition\nloom,Loom,A frame.\n"), "A frame.", true);
  });

  it("glossary: HEAD keeps the last column: a conflict, the repo's term the default", async () => {
    expectTermConflict(await glossaryDiff("A frame.", "term_id,title,definición\nloom,Loom,Un marco.\n"), "Un marco.", true);
  });

  it("glossary: HEAD keeps the column whose value equals D1: nothing", async () => {
    const diff = await glossaryDiff("A frame.", "term_id,title,definition\nloom,Loom,A frame.\n");
    expect(diff.changed).toEqual([]);
  });

  it("glossary: with a title edited only in the Compositor, a conflict with the Compositor's term the default", async () => {
    const head = "term_id,title,definition\nloom,Loom,A frame.\n";
    expectTermConflict(await glossaryDiff("Un marco.", head, "Loom, edited here"), "A frame.", false);
  });

  // A collision on the id column leaves the base's rows matched to nothing
  // reliable. Each sheet then holds an item that differs, one only the
  // repository holds and one only D1 holds. An untouched modal keeps the
  // author's version of the first, inserts the second as new, as a sync with
  // no base does, and removes nothing.
  describe("on the id column", () => {
    it("objects: a conflict with the author's value, the new object inserted, nothing removed", async () => {
      serveRepo({ [`${SHEETS}/objects.csv`]: "object_id,title,object_type\nobj-001,First,Oil\nobj-002,Second,Print\n" });
      const kept = { ...d1Object("Painting"), id: 3, object_id: "obj-003", title: "Third" };
      const db = probeSequentialMockDb([[d1Object("Painting"), kept], [], []]);
      const diff = await computeSyncDiff(1, "t", "o", "r", db, "object_id,id_objeto,title,object_type\nold-1,obj-001,First,Oil\n");
      expect(diff.changedObjects).toMatchObject([{ object_id: "obj-001", conflictFields: ["object_type"] }]);
      expect(diff.changedObjects[0].repoDefaultFields).toBeUndefined();
      expect(diff.newObjects).toMatchObject([{ object_id: "obj-002" }]);
      expect(diff.newObjects[0].deletedInCompositor).toBeUndefined();
      expect(diff.missingObjects).toMatchObject([{ object_id: "obj-003", editedInCompositor: true }]);
      const posted = buildThreeWayChanges(fullDiff({ objects: diff }), emptySelections());
      expect(posted.objects.fieldChoices).toEqual({ "obj-001": { object_type: "d1" } });
      expect(posted.objects.newObjectIds).toEqual(["obj-002"]);
      expect(posted.objects.removedObjectIds).toEqual([]);
    });

    it("project: a conflict with the author's row, the new story inserted", async () => {
      serveRepo({ [`${SHEETS}/project.csv`]: "order,story_id,title,subtitle\n1,story-one,First,One\n2,story-two,Second,Two\n" });
      serveBase({ [`${SHEETS}/project.csv`]: "order,story_id,id_historia,title,subtitle\n1,old-1,story-one,First,Uno\n" });
      const d1Stories = [d1Story("Uno"), { ...d1Story("Three"), id: 3, story_id: "story-three", title: "Third" }];
      const db = probeSequentialMockDb([[], [], d1Stories, d1Stories, []]);
      const diff = await computeFullSyncDiff(1, "t", "o", "r", db, "base-sha");
      expect(diff.stories.changedStories).toMatchObject([{ story_id: "story-one", conflict: true }]);
      expect(diff.stories.changedStories[0].repoByDefault).toBeUndefined();
      expect(diff.stories.newStories).toMatchObject([{ story_id: "story-two" }]);
      expect(diff.stories.newStories[0].deletedInCompositor).toBeUndefined();
      expect(diff.stories.missingStories).toMatchObject([{ story_id: "story-three" }]);
      const posted = buildThreeWayChanges(fullDiff({ stories: diff.stories }), emptySelections());
      expect(posted.stories.accept).toEqual([]);
      expect(posted.stories.reject).toEqual(["story-one"]);
      expect(posted.stories.insertNew).toEqual(["story-two"]);
    });

    it("glossary: a conflict with the author's term, the new term inserted", async () => {
      serveRepo({ [`${SHEETS}/glossary.csv`]: "term_id,title,definition\nloom,Loom,A frame.\nwarp,Warp,Threads.\n" });
      const kept = { ...d1Term("Weft threads."), id: 3, term_id: "weft", title: "Weft" };
      const db = probeSequentialMockDb([[d1Term("Un marco."), kept]]);
      const diff = await computeGlossarySyncDiff(
        1, "t", "o", "r", db, "term_id,id_termino,title,definition\nold-1,loom,Loom,Un marco.\n", "head-sha",
      );
      expect(diff.changed).toMatchObject([{ term_id: "loom", conflict: true }]);
      expect(diff.changed[0].repoByDefault).toBeUndefined();
      expect(diff.added).toMatchObject([{ term_id: "warp" }]);
      expect(diff.added[0].deletedInCompositor).toBeUndefined();
      expect(diff.removed).toMatchObject([{ term_id: "weft" }]);
      const posted = buildThreeWayChanges(fullDiff({ glossary: diff }), emptySelections());
      expect(posted.glossary.accept).toEqual([]);
      expect(posted.glossary.reject).toEqual(["loom"]);
      expect(posted.glossary.insertNew).toEqual(["warp"]);
    });
  });

  // The accept writes an object's custom-column blob whole, so GitHub's blob
  // is never the default for it: it would replace the author's other columns.
  // (A custom header repeated in a sheet is kept as a second column, not read
  // as a collision, so the rule is checked on its own.)
  it("objects and glossary: the custom-column blob never takes GitHub's value by default", () => {
    expect(repoDefaultsFor("extra_columns")).toBe(false);
    expect(repoDefaultsFor("object_type")).toBe(true);
    expect(repoDefaultsFor("definition")).toBe(true);
  });
});

// Which fields a colliding column feeds, read through the real mappers.
describe("the fields a collided column feeds", () => {
  const cases: Array<[string, () => Set<string>, string[]]> = [
    ["objects.csv medium_genre", () => objectFieldsFedBy(new Set(["medium_genre"])), ["object_type"]],
    ["objects.csv title", () => objectFieldsFedBy(new Set(["title"])), ["title"]],
    ["objects.csv a custom column", () => objectFieldsFedBy(new Set(["accession_number"])), ["extra_columns"]],
    ["objects.csv iiif_manifest", () => objectFieldsFedBy(new Set(["iiif_manifest"])), ["source_url"]],
    ["objects.csv featured", () => objectFieldsFedBy(new Set(["featured"])), ["featured"]],
    ["objects.csv object_id, the key", () => objectFieldsFedBy(new Set(["object_id"])), []],
    ["project.csv subtitle", () => storyFieldsFedBy(new Set(["subtitle"])), ["subtitle"]],
    ["project.csv private", () => storyFieldsFedBy(new Set(["private"])), ["isPrivate"]],
    ["project.csv show_sections", () => storyFieldsFedBy(new Set(["show_sections"])), ["showSections"]],
    ["glossary.csv definition", () => termFieldsFedBy(new Set(["definition"])), ["definition"]],
    ["glossary.csv a custom column", () => termFieldsFedBy(new Set(["source_note"])), ["extra_columns"]],
  ];
  for (const [name, fed, fields] of cases) {
    it(`${name} feeds ${fields.join(", ") || "nothing"}`, () => {
      expect([...fed()].sort()).toEqual([...fields].sort());
    });
  }
});
