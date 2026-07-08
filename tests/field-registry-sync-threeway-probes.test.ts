/**
 * Three-way sync classification probes (base = repo files at head_sha) and the
 * edge pins for the base-availability fallback. Split out of
 * field-registry-sync-probes.test.ts to keep each file within the
 * comprehension threshold; shares the registry-derived fixtures via
 * ./sync-probe-fixtures.
 *
 * @version v1.4.1-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
import {
  computeSyncDiff,
  computeFullSyncDiff,
  computeGlossarySyncDiff,
  resolveFullSyncPayload,
} from "~/lib/sync.server";
import type { FieldDecl } from "../app/lib/field-registry";
import {
  probeSequentialMockDb, syncOf,
  objectSyncFields, storySyncFields, configSyncFields, glossarySyncFields,
  PROJECT_ID, TOKEN, OWNER, REPO, probeObjectsCsv, d1ObjectRow, projectCsv,
  d1StoryRow, configValueKind, configYml, d1ConfigRow, glossaryCsv, d1GlossaryRow,
  emptyChanges,
} from "./sync-probe-fixtures";

// ===========================================================================
// 7. Three-way classification probes (base = repo files at head_sha)
// ===========================================================================

const BASE_REF = "basesha000";
const OBJECTS_PATH = "telar-content/spreadsheets/objects.csv";
const PROJECT_PATH = "telar-content/spreadsheets/project.csv";
const GLOSSARY_PATH = "telar-content/spreadsheets/glossary.csv";
const CONFIG_PATH = "_config.yml";

// --- editor-side (D1) value overrides: a THIRD value distinct from base/repo,
// so a both-changed field is a genuine conflict, not an accidental match. ---

function editorObjectValue(name: string): unknown {
  if (name === "featured") return true;
  if (name === "extra_columns") return JSON.stringify({ accession_number: "ACC-EDIT" });
  return `edit-${name}`;
}
function editorObjectRow(name: string): Record<string, unknown> {
  return { ...d1ObjectRow(), [name]: editorObjectValue(name) };
}

function editorStoryValue(name: string): unknown {
  if (name === "private" || name === "show_sections") return true;
  return `edit-${name}`;
}

function editorConfigValue(f: FieldDecl): string | boolean | number {
  const kind = configValueKind(f);
  if (kind === "bool") return true; // base false, repo true — can't 3-way-conflict a boolean
  if (kind === "int") return 9; // base 4, repo 7, editor 9
  return `edit-${f.name}`;
}

// Booleans (and yes-empty encodings) are binary: if the repo and the editor
// both move off the base they land on the SAME value, so there is no
// both-changed conflict to surface. These fields are excluded from the
// conflict variant only.
const objectConflictCapable = objectSyncFields.filter((f) => f.name !== "featured");
const storyConflictCapable = storySyncFields.filter(
  (f) => f.name !== "private" && f.name !== "show_sections",
);
const configConflictCapable = configSyncFields.filter((f) => configValueKind(f) !== "bool");

// Drives BOTH github readers from one path->content function: getFileContent
// serves the repo HEAD (isBase=false), getFileAtRef serves the base commit
// (isBase=true), mapping a null base to "absent" and non-null to "ok".
// computeFullSyncDiff reads every base file through getFileAtRef; the direct
// computeSyncDiff / computeGlossarySyncDiff probes take base CONTENT as an
// explicit param, so for those the getFileAtRef mock is inert.
function mockByRef(byPath: (path: string, isBase: boolean) => string | null) {
  vi.mocked(githubServer.getFileContent).mockImplementation(
    async (_t, _o, _r, path, ref) => byPath(path, Boolean(ref)),
  );
  vi.mocked(githubServer.getFileAtRef).mockImplementation(async (_t, _o, _r, path) => {
    const c = byPath(path, true);
    return c === null ? { status: "absent" as const } : { status: "ok" as const, content: c };
  });
}

// The base objects.csv content a direct computeSyncDiff probe should receive:
// what mockByRef would have served for the base side of objects.csv.
function baseObjects(byPath: (path: string, isBase: boolean) => string | null): string | null {
  return byPath(OBJECTS_PATH, true);
}
function baseGlossary(byPath: (path: string, isBase: boolean) => string | null): string | null {
  return byPath(GLOSSARY_PATH, true);
}

describe("three-way probes — objects (computeSyncDiff)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  });

  for (const field of objectSyncFields) {
    it(`objects.${field.name}: repo-only → in changedFields, NOT in conflictFields`, async () => {
      mockByRef((path) => (path === OBJECTS_PATH ? probeObjectsCsv(field.name) : null));
      const db = probeSequentialMockDb([[d1ObjectRow()], [], []]);
      // Base = unmutated objects.csv (threaded as content, not a ref).
      const result = await computeSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, probeObjectsCsv());

      const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
      expect(changed?.changedFields).toContain(field.name);
      expect(changed?.conflictFields ?? []).not.toContain(field.name);
    });

    it(`objects.${field.name}: editor-only → suppressed (absent from the diff)`, async () => {
      mockByRef((path) => (path === OBJECTS_PATH ? probeObjectsCsv() : null));
      const db = probeSequentialMockDb([[editorObjectRow(field.name)], [], []]);
      const result = await computeSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, probeObjectsCsv());

      const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
      expect(changed?.changedFields ?? []).not.toContain(field.name);
      expect(result.suppressedEditorOnly ?? 0).toBeGreaterThan(0);
    });
  }

  for (const field of objectConflictCapable) {
    it(`objects.${field.name}: both changed → in conflictFields`, async () => {
      mockByRef((path) => (path === OBJECTS_PATH ? probeObjectsCsv(field.name) : null));
      const db = probeSequentialMockDb([[editorObjectRow(field.name)], [], []]);
      const result = await computeSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, probeObjectsCsv());

      const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
      expect(changed?.changedFields).toContain(field.name);
      expect(changed?.conflictFields).toContain(field.name);
    });
  }
});

describe("three-way probes — stories (computeFullSyncDiff)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  });

  const storyDb = (d1Story: Record<string, unknown>) =>
    probeSequentialMockDb([[], [], [d1Story], [d1Story], []]);

  for (const field of storySyncFields) {
    const itemKey = syncOf(field)?.itemKey ?? field.name;
    it(`stories.${field.name}: repo-only → changed row with conflict=false`, async () => {
      mockByRef((path, isBase) => {
        if (path === OBJECTS_PATH) return "";
        if (path === PROJECT_PATH) return isBase ? projectCsv() : projectCsv(field.name);
        return null;
      });
      const result = await computeFullSyncDiff(
        PROJECT_ID, TOKEN, OWNER, REPO, storyDb(d1StoryRow()), BASE_REF,
      );
      const changed = result.stories.changedStories.find((s) => s.story_id === "my-story");
      expect(changed?.changedFields).toContain(itemKey);
      expect(changed?.conflict).toBe(false);
    });

    it(`stories.${field.name}: editor-only → suppressed`, async () => {
      mockByRef((path, isBase) => {
        if (path === OBJECTS_PATH) return "";
        if (path === PROJECT_PATH) return isBase ? projectCsv() : projectCsv();
        return null;
      });
      const d1 = d1StoryRow({ [field.name]: editorStoryValue(field.name) });
      const result = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, storyDb(d1), BASE_REF);
      expect(result.stories.changedStories).toHaveLength(0);
      expect(result.suppressedEditorOnly).toBeGreaterThan(0);
    });
  }

  for (const field of storyConflictCapable) {
    it(`stories.${field.name}: both changed → conflict=true`, async () => {
      mockByRef((path, isBase) => {
        if (path === OBJECTS_PATH) return "";
        if (path === PROJECT_PATH) return isBase ? projectCsv() : projectCsv(field.name);
        return null;
      });
      const d1 = d1StoryRow({ [field.name]: editorStoryValue(field.name) });
      const result = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, storyDb(d1), BASE_REF);
      const changed = result.stories.changedStories.find((s) => s.story_id === "my-story");
      expect(changed?.conflict).toBe(true);
    });
  }
});

describe("three-way probes — config (computeFullSyncDiff)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  });

  const configDb = (d1Config: Record<string, unknown>) =>
    probeSequentialMockDb([[], [], [], [], [d1Config]]);

  for (const field of configSyncFields) {
    it(`config.${field.name}: repo-only → changed field with conflict=false`, async () => {
      mockByRef((path, isBase) => {
        if (path === OBJECTS_PATH) return "";
        if (path === CONFIG_PATH) return isBase ? configYml() : configYml(field.name);
        return null;
      });
      const result = await computeFullSyncDiff(
        PROJECT_ID, TOKEN, OWNER, REPO, configDb(d1ConfigRow()), BASE_REF,
      );
      const change = result.config.changedFields.find((c) => c.key === field.name);
      expect(change).toBeDefined();
      expect(change?.conflict).toBe(false);
    });

    it(`config.${field.name}: editor-only → suppressed`, async () => {
      mockByRef((path, isBase) => {
        if (path === OBJECTS_PATH) return "";
        if (path === CONFIG_PATH) return isBase ? configYml() : configYml();
        return null;
      });
      const d1 = d1ConfigRow({ [field.name]: editorConfigValue(field) });
      const result = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, configDb(d1), BASE_REF);
      expect(result.config.changedFields.find((c) => c.key === field.name)).toBeUndefined();
      expect(result.suppressedEditorOnly).toBeGreaterThan(0);
    });
  }

  for (const field of configConflictCapable) {
    it(`config.${field.name}: both changed → conflict=true`, async () => {
      mockByRef((path, isBase) => {
        if (path === OBJECTS_PATH) return "";
        if (path === CONFIG_PATH) return isBase ? configYml() : configYml(field.name);
        return null;
      });
      const d1 = d1ConfigRow({ [field.name]: editorConfigValue(field) });
      const result = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, configDb(d1), BASE_REF);
      const change = result.config.changedFields.find((c) => c.key === field.name);
      expect(change?.conflict).toBe(true);
    });
  }
});

describe("three-way probes — glossary (computeGlossarySyncDiff)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const field of glossarySyncFields) {
    it(`glossary.${field.name}: repo-only → changed term with conflict=false`, async () => {
      mockByRef((path) => (path === GLOSSARY_PATH ? glossaryCsv(field.name) : null));
      const db = probeSequentialMockDb([[d1GlossaryRow()]]);
      // Base = unmutated glossary.csv, threaded as content.
      const result = await computeGlossarySyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, glossaryCsv());
      const changed = result.changed.find((t) => t.term_id === "enc");
      expect(changed?.conflict).toBe(false);
    });

    it(`glossary.${field.name}: editor-only → suppressed`, async () => {
      mockByRef((path) => (path === GLOSSARY_PATH ? glossaryCsv() : null));
      const row = { ...d1GlossaryRow(), [field.name]: `edit-${field.name}` };
      const db = probeSequentialMockDb([[row]]);
      const result = await computeGlossarySyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, glossaryCsv());
      expect(result.changed).toHaveLength(0);
      expect(result.suppressedEditorOnly).toBeGreaterThan(0);
    });

    it(`glossary.${field.name}: both changed → conflict=true`, async () => {
      mockByRef((path) => (path === GLOSSARY_PATH ? glossaryCsv(field.name) : null));
      const row = { ...d1GlossaryRow(), [field.name]: `edit-${field.name}` };
      const db = probeSequentialMockDb([[row]]);
      const result = await computeGlossarySyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, glossaryCsv());
      const changed = result.changed.find((t) => t.term_id === "enc");
      expect(changed?.conflict).toBe(true);
    });
  }
});

// ===========================================================================
// 8. Three-way edge pins
// ===========================================================================

describe("three-way edge pins", () => {
  // A full-sync D1 stub: one object row, then empty reads for steps, stories,
  // config, and glossary. Shared by the base-availability pins.
  const fullDb = () => probeSequentialMockDb([[d1ObjectRow()], [], [], [], []]);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
    vi.mocked(githubServer.getRepoHead).mockResolvedValue("newsha123");
  });

  it("base 404 → classification two-way; diff content equals the no-base run", async () => {
    // Head has a genuine repo change (title). With NO base, two-way surfaces it.
    const head = probeObjectsCsv("title");

    // No base ref → two-way.
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) =>
      path === OBJECTS_PATH ? head : null,
    );
    const noBase = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, fullDb());

    // Base ref given but every base fetch 404s (null) → two-way, same content.
    mockByRef((path, isBase) => {
      if (isBase) return null; // GC'd ref: every base path 404s
      return path === OBJECTS_PATH ? head : null;
    });
    const base404 = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, fullDb(), BASE_REF);

    expect(noBase.classification).toBe("two-way");
    expect(base404.classification).toBe("two-way");
    expect(base404.suppressedEditorOnly).toBe(0);
    expect(base404.objects.changedObjects).toEqual(noBase.objects.changedObjects);
    expect(base404.objects.changedObjects[0]?.conflictFields).toEqual([]);
  });

  it("head_sha null (baseRef null) → two-way", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) =>
      path === OBJECTS_PATH ? probeObjectsCsv("title") : null,
    );
    const db = probeSequentialMockDb([[d1ObjectRow()], [], [], [], []]);
    const result = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, null);
    expect(result.classification).toBe("two-way");
  });

  it("alt_text raw base cell: blank base cell is not the fabricated title", async () => {
    // Base alt_text cell BLANK; D1 alt_text holds the object's title (the shape
    // mapObjectsCsv's import fallback would produce). If the base used the
    // title fallback, base==D1 and the field would look editor-unchanged. The
    // raw rule keeps base = "" so the editor's alt_text is seen as a change.
    const base = "object_id,title,alt_text\nobj-1,base-title,";
    const head = "object_id,title,alt_text\nobj-1,base-title,repo-alt";
    mockByRef((path, isBase) => (path === OBJECTS_PATH ? (isBase ? base : head) : null));
    const d1 = { ...d1ObjectRow(), title: "base-title", alt_text: "base-title" };
    const db = probeSequentialMockDb([[d1], [], []]);
    const result = await computeSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, base);

    const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
    // repo alt (repo-alt) ≠ D1 (base-title); base is raw "" so both moved → conflict.
    expect(changed?.changedFields).toContain("alt_text");
    expect(changed?.conflictFields).toContain("alt_text");
  });

  it("extra_columns: base key-order churn is not a change (canonicalised)", async () => {
    // base and repo carry the SAME custom columns in OPPOSITE key order; only
    // D1 genuinely differs. base==repo canonically → the extra_columns move is
    // editor-only and suppressed, never a conflict.
    const base = "object_id,alpha,beta\nobj-1,x,y";
    const head = "object_id,beta,alpha\nobj-1,y,x";
    mockByRef((path, isBase) => (path === OBJECTS_PATH ? (isBase ? base : head) : null));
    const d1 = { ...d1ObjectRow(), extra_columns: JSON.stringify({ alpha: "x", beta: "z" }) };
    const db = probeSequentialMockDb([[d1], [], []]);
    const result = await computeSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, base);

    const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
    expect(changed?.conflictFields ?? []).not.toContain("extra_columns");
    expect(result.suppressedEditorOnly ?? 0).toBeGreaterThan(0);
  });

  it("repo-empty guard precedence: empty repo cell + enriched D1 stays suppressed", async () => {
    // source_url blank in repo and base; D1 holds an enriched value. The
    // repo-empty guard skips it BEFORE classification, so it is neither a
    // change nor counted as an editor-only suppression.
    const base = "object_id,source_url\nobj-1,";
    const head = "object_id,source_url\nobj-1,";
    mockByRef((path, isBase) => (path === OBJECTS_PATH ? (isBase ? base : head) : null));
    const d1 = { ...d1ObjectRow(), source_url: "https://iiif.example/enriched" };
    const db = probeSequentialMockDb([[d1], [], []]);
    const result = await computeSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, base);

    const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
    expect(changed?.changedFields ?? []).not.toContain("source_url");
    expect(result.suppressedEditorOnly ?? 0).toBe(0);
  });

  it("P2: editor-deleted object with repo row identical to base is suppressed (not resurrected)", async () => {
    const csv = probeObjectsCsv(); // obj-1, base cells
    mockByRef((path) => (path === OBJECTS_PATH ? csv : null)); // base == head
    const db = probeSequentialMockDb([[], [], []]); // obj-1 NOT in D1
    const result = await computeSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, csv);

    expect(result.newObjects).toHaveLength(0);
    expect(result.suppressedEditorOnly ?? 0).toBeGreaterThan(0);
  });

  it("editor-deleted object with an edited repo row is a deleted-here conflict", async () => {
    mockByRef((path) => (path === OBJECTS_PATH ? probeObjectsCsv("title") : null));
    const db = probeSequentialMockDb([[], [], []]); // obj-1 NOT in D1, edited in repo
    const result = await computeSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, probeObjectsCsv());

    expect(result.newObjects).toHaveLength(1);
    expect(result.newObjects[0].deletedInCompositor).toBe(true);
  });

  it("P3: an editor-created story (in D1, absent from repo and base) is suppressed from removed", async () => {
    mockByRef((path) => (path === OBJECTS_PATH ? "" : path === PROJECT_PATH ? "" : null));
    const d1Story = d1StoryRow();
    const db = probeSequentialMockDb([[], [], [d1Story], [d1Story], []]);
    const result = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, BASE_REF);

    expect(result.stories.missingStories).toHaveLength(0);
    expect(result.suppressedEditorOnly).toBeGreaterThan(0);
  });

  it("P3: an editor-created glossary term is suppressed from removed", async () => {
    mockByRef((path) => (path === GLOSSARY_PATH ? "" : null));
    const db = probeSequentialMockDb([[d1GlossaryRow()]]);
    const result = await computeGlossarySyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, "");

    expect(result.removed).toHaveLength(0);
    expect(result.suppressedEditorOnly ?? 0).toBeGreaterThan(0);
  });

  it("accept-divergence framing: repo edits now in the base classify editor-only", async () => {
    // After accept-divergence, head_sha jumps to include the repo's edits WITHOUT
    // reconciling D1. Next diff: base == repo (both carry repo-title), D1 still
    // holds the old value → editor-only → suppressed.
    const withRepoTitle = "object_id,title\nobj-1,repo-title";
    mockByRef((path) => (path === OBJECTS_PATH ? withRepoTitle : null)); // base == head
    const d1 = { ...d1ObjectRow(), title: "old-d1-title" };
    const db = probeSequentialMockDb([[d1], [], []]);
    const result = await computeSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, withRepoTitle);

    const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
    expect(changed?.changedFields ?? []).not.toContain("title");
    expect(result.suppressedEditorOnly ?? 0).toBeGreaterThan(0);
  });

  it("one base file error → two-way everywhere, equal to the no-base run", async () => {
    // A transient error on ANY of the four base fetches must force the WHOLE
    // diff two-way — never leave some sub-domains three-way and silently
    // degrade others.
    const head = probeObjectsCsv("title");

    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) =>
      path === OBJECTS_PATH ? head : null,
    );
    const noBase = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, fullDb());

    vi.mocked(githubServer.getFileAtRef).mockImplementation(async (_t, _o, _r, path) => {
      if (path === PROJECT_PATH) return { status: "error" }; // one file errors
      return { status: "ok", content: path === OBJECTS_PATH ? probeObjectsCsv() : "" };
    });
    const baseErr = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, fullDb(), BASE_REF);

    expect(noBase.classification).toBe("two-way");
    expect(baseErr.classification).toBe("two-way");
    expect(baseErr.suppressedEditorOnly).toBe(0);
    expect(baseErr.objects.changedObjects).toEqual(noBase.objects.changedObjects);
    expect(baseErr.objects.changedObjects[0]?.conflictFields).toEqual([]);
  });

  it("objects.csv absent at a valid ref → empty-base semantics", async () => {
    // objects.csv did not exist at the base commit, but other files did → still
    // three-way, with an EMPTY base for objects.
    const head = "object_id,title\nobj-repo,Repo Object";
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === OBJECTS_PATH) return head;
      if (path === PROJECT_PATH) return "";
      return null;
    });
    vi.mocked(githubServer.getFileAtRef).mockImplementation(async (_t, _o, _r, path) => {
      if (path === OBJECTS_PATH) return { status: "absent" };
      return { status: "ok", content: "" };
    });
    // D1 holds obj-d1 (origin repo) present in neither repo nor base.
    const d1Obj = { ...d1ObjectRow(), object_id: "obj-d1", origin: "repo" };
    const db = probeSequentialMockDb([[d1Obj]]);
    const result = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, BASE_REF);

    expect(result.classification).toBe("three-way");
    // Repo row absent from the empty base → new-in-repo.
    expect(result.objects.newObjects.map((o) => o.object_id)).toContain("obj-repo");
    // D1-only row absent from repo AND base → editor-created → suppressed.
    expect(result.objects.missingObjects.map((o) => o.object_id)).not.toContain("obj-d1");
  });

  it("deleted-in-repo + edited-here object → editedInCompositor (not plain removed)", async () => {
    const baseCsv = probeObjectsCsv(); // base has obj-1 with base cells
    mockByRef((path) => (path === OBJECTS_PATH ? "" : null)); // head deleted it
    const d1 = { ...d1ObjectRow(), title: "edited-in-compositor" };
    const db = probeSequentialMockDb([[d1], [], []]);
    const result = await computeSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, baseCsv);

    const missing = result.missingObjects.find((o) => o.object_id === "obj-1");
    expect(missing?.editedInCompositor).toBe(true);
  });

  it("deleted-in-repo, unedited object → plain removed (no editedInCompositor)", async () => {
    const baseCsv = probeObjectsCsv();
    mockByRef((path) => (path === OBJECTS_PATH ? "" : null));
    const db = probeSequentialMockDb([[d1ObjectRow()], [], []]);
    const result = await computeSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, baseCsv);

    const missing = result.missingObjects.find((o) => o.object_id === "obj-1");
    expect(missing).toBeDefined();
    expect(missing?.editedInCompositor).toBeUndefined();
  });

  it("deleted-here + edited story → deletedInCompositor in newStories", async () => {
    mockByRef((path, isBase) => {
      if (path === OBJECTS_PATH) return "";
      if (path === PROJECT_PATH) return isBase ? projectCsv() : projectCsv("title");
      return null;
    });
    const db = probeSequentialMockDb([]);
    const result = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, BASE_REF);

    const s = result.stories.newStories.find((x) => x.story_id === "my-story");
    expect(s?.deletedInCompositor).toBe(true);
  });

  it("deleted-here, unedited story → suppressed (not resurrected)", async () => {
    mockByRef((path) => (path === OBJECTS_PATH ? "" : path === PROJECT_PATH ? projectCsv() : null));
    const db = probeSequentialMockDb([]);
    const result = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, db, BASE_REF);

    expect(result.stories.newStories).toHaveLength(0);
    expect(result.suppressedEditorOnly).toBeGreaterThan(0);
  });

  it("a story conflict resolved as reject leaves the D1 row untouched (no update emitted)", async () => {
    // reject is not carried into the ingest payload — resolveFullSyncPayload
    // only emits accept (update) + insertNew, so a rejected story never writes.
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === OBJECTS_PATH) return "";
      if (path === PROJECT_PATH) return projectCsv("title");
      return null;
    });
    const changes = emptyChanges();
    changes.stories.reject = ["my-story"];
    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID, changes, TOKEN, OWNER, REPO, probeSequentialMockDb([[], []]),
    );
    expect(payload.stories.update).toHaveLength(0);
  });
});

