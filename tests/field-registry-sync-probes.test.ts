/**
 * Field-registry sync sensitivity probes.
 *
 * These tests are GENERATED from FIELD_REGISTRY (app/lib/field-registry.ts):
 * for every field whose `sync` axis declares diff participation, a probe
 * builds a repo/D1 pair where ONLY that field differs (non-empty, distinct
 * sentinels on both sides — the changed-field rule deliberately skips
 * repo-empty values as IIIF-enrichment noise) and asserts the corresponding
 * diff function surfaces the change. Apply-side probes then assert that
 * accepting the change writes the repo value into the D1 update payload.
 *
 * Because the probes iterate the registry rather than a hand-picked list,
 * adding a field to the registry with `sync: { diff: ... }` automatically
 * demands that computeSyncDiff / computeFullSyncDiff / computeGlossarySyncDiff
 * actually compare it — a declaration the code does not honor fails here,
 * which is the whole point: participation is declared once and verified
 * mechanically.
 *
 * Also pinned: the registry's declared sync EXCLUSIONS that are reachable
 * through the same inputs — stories.order (0-based import vs 1-based CSV
 * must not fabricate a diff) and config.telar_version (handled by the
 * dedicated versionChange detector, never the managed-field diff) — plus
 * the semantic (key-order-insensitive) comparison of extra_columns.
 *
 * @version v1.4.1-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock setup (same harness as tests/sync.server.test.ts)
// ---------------------------------------------------------------------------

vi.mock("~/lib/github.server", () => ({
  getFileContent: vi.fn(),
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
  applySyncChanges,
  resolveFullSyncPayload,
  SYNC_FIELDS,
  type SyncField,
} from "~/lib/sync.server";
import { getEntity, type FieldDecl } from "../app/lib/field-registry";


// Shared registry-derived families, fixture builders, mock-DB factories, and
// emptyChanges live in a non-test module so the three-way probe file can reuse
// them without re-declaring a single helper body.
import {
  MockDb, probeSequentialMockDb, createTrackedMockDb, syncOf, syncFamily,
  objectSyncFields, storySyncFields, configSyncFields, glossarySyncFields,
  PROJECT_ID, TOKEN, OWNER, REPO, objectCsvHeader, objectBaseCell, objectMutatedCell,
  probeObjectsCsv, d1ObjectRow, expectedObjectRepoValue, storyCsvHeader, storyBaseCell,
  storyMutatedCell, projectCsv, d1StoryRow, configYamlKey, configValueKind,
  configBaseValue, configMutatedValue, configYml, d1ConfigRow, glossaryCsv,
  d1GlossaryRow, pascalCase, emptyChanges,
} from "./sync-probe-fixtures";


// ---------------------------------------------------------------------------
// Guards — a filter bug that emptied a family would silently generate zero
// probes; pin the families to the code-side field lists.
// ---------------------------------------------------------------------------

describe("registry sync families (generation guards)", () => {
  it("objects family matches the code's SYNC_FIELDS exactly", () => {
    expect(objectSyncFields.map((f) => f.name).sort()).toEqual([...SYNC_FIELDS].sort());
  });

  it("storyFields, config, and glossary families are non-empty", () => {
    expect(storySyncFields.length).toBeGreaterThan(0);
    expect(configSyncFields.length).toBeGreaterThan(0);
    expect(glossarySyncFields.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 1. Objects diff probes — computeSyncDiff
// ---------------------------------------------------------------------------

describe("registry sync probes — objects diff (computeSyncDiff)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  });

  it("baseline: identical repo and D1 produce no changed objects", async () => {
    vi.mocked(githubServer.getFileContent).mockResolvedValue(probeObjectsCsv());
    const mockDb = probeSequentialMockDb([[d1ObjectRow()], [], []]);

    const result = await computeSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, mockDb);

    expect(result.changedObjects).toHaveLength(0);
    expect(result.newObjects).toHaveLength(0);
    expect(result.missingObjects).toHaveLength(0);
  });

  for (const field of objectSyncFields) {
    it(`objects.${field.name}: a repo-only edit surfaces as exactly that changed field`, async () => {
      vi.mocked(githubServer.getFileContent).mockResolvedValue(probeObjectsCsv(field.name));
      const mockDb = probeSequentialMockDb([[d1ObjectRow()], [], []]);

      const result = await computeSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, mockDb);

      expect(result.changedObjects).toHaveLength(1);
      const changed = result.changedObjects[0];
      expect(changed.object_id).toBe("obj-1");
      expect(changed.changedFields).toEqual([field.name as SyncField]);
      const repoVal = changed.repoValues[field.name as SyncField];
      if (field.name === "extra_columns") {
        expect(JSON.parse(String(repoVal))).toEqual({ accession_number: "ACC-MUT" });
      } else {
        expect(repoVal).toBe(expectedObjectRepoValue(field.name));
      }
    });
  }

  it("stability: extra_columns with identical content in a different key order does NOT diff", async () => {
    const csv = [
      "object_id,title,creator,alpha,beta",
      "obj-1,base-title,base-creator,x,y",
    ].join("\n");
    vi.mocked(githubServer.getFileContent).mockResolvedValue(csv);
    // D1 stores the same two custom keys in the OPPOSITE order.
    const row = {
      ...d1ObjectRow(),
      extra_columns: JSON.stringify({ beta: "y", alpha: "x" }),
    };
    const mockDb = probeSequentialMockDb([[row], [], []]);

    const result = await computeSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, mockDb);

    const changed = result.changedObjects.find((o) => o.object_id === "obj-1");
    expect(changed?.changedFields ?? []).not.toContain("extra_columns");
  });
});

// ---------------------------------------------------------------------------
// 2. Story-field diff probes — computeFullSyncDiff
// ---------------------------------------------------------------------------

describe("registry sync probes — storyFields diff (computeFullSyncDiff)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  });

  function mockProjectFiles(projectCsvContent: string) {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return projectCsvContent;
      return null; // no _config.yml, no glossary.csv — those diffs stay empty
    });
  }

  it("baseline: identical repo and D1 produce no changed stories", async () => {
    mockProjectFiles(projectCsv());
    const d1Stories = [d1StoryRow()];
    const mockDb = probeSequentialMockDb([[], [], d1Stories, d1Stories, []]);

    const result = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, mockDb);

    expect(result.stories.changedStories).toHaveLength(0);
  });

  for (const field of storySyncFields) {
    const itemKey = syncOf(field)?.itemKey ?? field.name;
    it(`stories.${field.name}: a repo-only edit surfaces as changed field "${itemKey}"`, async () => {
      mockProjectFiles(projectCsv(field.name));
      const d1Stories = [d1StoryRow()];
      const mockDb = probeSequentialMockDb([[], [], d1Stories, d1Stories, []]);

      const result = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, mockDb);

      expect(result.stories.changedStories).toHaveLength(1);
      const changed = result.stories.changedStories[0];
      expect(changed.story_id).toBe("my-story");
      expect(changed.changedFields).toEqual([itemKey]);
    });
  }

  it("stability: order differing (1-based CSV vs 0-based D1) does NOT surface a story diff", async () => {
    // projectCsv() writes order=1; give D1 the 0-based import value.
    mockProjectFiles(projectCsv());
    const d1Stories = [d1StoryRow({ order: 0 })];
    const mockDb = probeSequentialMockDb([[], [], d1Stories, d1Stories, []]);

    const result = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, mockDb);

    expect(result.stories.changedStories).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Config diff probes — computeFullSyncDiff
// ---------------------------------------------------------------------------

describe("registry sync probes — config diff (computeFullSyncDiff)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  });

  function mockConfigFiles(configYmlContent: string) {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "_config.yml") return configYmlContent;
      return null;
    });
  }

  it("baseline: identical repo and D1 produce no changed config fields", async () => {
    mockConfigFiles(configYml());
    const mockDb = probeSequentialMockDb([[], [], [], [], [d1ConfigRow()]]);

    const result = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, mockDb);

    expect(result.config.changedFields).toHaveLength(0);
  });

  for (const field of configSyncFields) {
    const yamlKey = configYamlKey(field);
    it(`config.${field.name}: a repo-only edit to "${yamlKey}:" surfaces in config.changedFields`, async () => {
      mockConfigFiles(configYml(field.name));
      const mockDb = probeSequentialMockDb([[], [], [], [], [d1ConfigRow()]]);

      const result = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, mockDb);

      expect(result.config.changedFields).toHaveLength(1);
      const change = result.config.changedFields[0];
      expect(change.key).toBe(field.name);
      expect(change.repoValue).toBe(configMutatedValue(field));
      expect(change.d1Value).toBe(configBaseValue(field));
    });
  }

  it("stability: telar_version differing feeds versionChange, never the managed-field diff", async () => {
    mockConfigFiles(configYml() + `\ntelar:\n  version: "9.9.9"`);
    const mockDb = probeSequentialMockDb([
      [],
      [],
      [],
      [],
      [d1ConfigRow({ telar_version: "1.0.0" })],
    ]);

    const result = await computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, mockDb);

    expect(result.config.changedFields.map((f) => f.key)).not.toContain("telar_version");
    expect(result.config.changedFields).toHaveLength(0);
    // The dedicated detector is what carries the divergence.
    expect(result.config.versionChange).not.toBeNull();
    expect(result.config.versionChange!.direction).toBe("ahead");
    expect(result.config.versionChange!.repoVersion).toBe("9.9.9");
  });
});

// ---------------------------------------------------------------------------
// 4. Glossary diff probes — computeGlossarySyncDiff
// ---------------------------------------------------------------------------

describe("registry sync probes — glossary diff (computeGlossarySyncDiff)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockGlossaryFiles(glossaryCsvContent: string) {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/glossary.csv") return glossaryCsvContent;
      return null;
    });
  }

  it("baseline: identical repo and D1 produce no changed terms", async () => {
    mockGlossaryFiles(glossaryCsv());
    const mockDb = probeSequentialMockDb([[d1GlossaryRow()]]);

    const result = await computeGlossarySyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, mockDb);

    expect(result.changed).toHaveLength(0);
    expect(result.added).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
  });

  for (const field of glossarySyncFields) {
    const stem = pascalCase(field.name);
    it(`glossary.${field.name}: a repo-only edit surfaces the term as changed with both values`, async () => {
      mockGlossaryFiles(glossaryCsv(field.name));
      const mockDb = probeSequentialMockDb([[d1GlossaryRow()]]);

      const result = await computeGlossarySyncDiff(PROJECT_ID, TOKEN, OWNER, REPO, mockDb);

      expect(result.changed).toHaveLength(1);
      const changed = result.changed[0] as unknown as Record<string, unknown>;
      expect(changed.term_id).toBe("enc");
      expect(changed[`repo${stem}`]).toBe(`repo-${field.name}`);
      expect(changed[`d1${stem}`]).toBe(`base-${field.name}`);
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Apply-side probes — accepting a repo change writes the repo value
// ---------------------------------------------------------------------------

describe("registry sync probes — objects apply (applySyncChanges)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  });

  for (const field of objectSyncFields) {
    it(`objects.${field.name}: accepting the repo value writes it into the D1 update payload`, async () => {
      vi.mocked(githubServer.getFileContent).mockResolvedValue(probeObjectsCsv(field.name));

      let captured: Record<string, unknown> | null = null;
      const mockDb = createTrackedMockDb({
        responses: [[d1ObjectRow()]],
        onUpdate: (_table, set) => {
          captured = set as Record<string, unknown>;
        },
      });

      await applySyncChanges(
        PROJECT_ID,
        {
          newObjectIds: [],
          changedObjectIds: ["obj-1"],
          fieldChoices: { "obj-1": { [field.name]: "repo" } },
          removedObjectIds: [],
          unregisteredObjectIds: [],
        },
        TOKEN,
        OWNER,
        REPO,
        mockDb,
      );

      expect(captured).not.toBeNull();
      const written = captured![field.name];
      if (field.name === "extra_columns") {
        expect(JSON.parse(String(written))).toEqual({ accession_number: "ACC-MUT" });
      } else {
        expect(written).toBe(expectedObjectRepoValue(field.name));
      }
    });
  }
});


// Full-sync's story/config/glossary content no longer writes D1 directly — it
// is resolved into a typed ingest payload the DO applies. These probes pin the
// resolution layer: every sync-participating field must surface in the payload
// with the registry-correct coerced type. (The DO-side half — the ingest writing
// the Y key and the snapshot binding the D1 column — lives in
// field-registry-do-probes.test.ts.)
describe("registry sync probes — resolve payload (resolveFullSyncPayload)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
    vi.mocked(githubServer.getRepoHead).mockResolvedValue("newsha123");
  });

  // resolveFullSyncPayload reads D1 twice (objects, then project_config).
  const resolveDb = () => probeSequentialMockDb([[], []]);

  for (const field of storySyncFields) {
    const itemKey = syncOf(field)?.itemKey ?? field.name;
    const expected =
      field.name === "private" || field.name === "show_sections" ? true : `repo-${field.name}`;
    it(`stories.${field.name}: resolve emits payload.stories.update["${itemKey}"] = ${JSON.stringify(expected)}`, async () => {
      vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
        if (path === "telar-content/spreadsheets/objects.csv") return "";
        if (path === "telar-content/spreadsheets/project.csv") return projectCsv(field.name);
        return null;
      });

      const changes = emptyChanges();
      changes.stories.accept = ["my-story"];
      const { payload } = await resolveFullSyncPayload(
        PROJECT_ID, changes, TOKEN, OWNER, REPO, resolveDb(),
      );

      expect(payload.stories.update).toHaveLength(1);
      const upd = payload.stories.update[0] as unknown as Record<string, unknown>;
      expect(upd.storyId).toBe("my-story");
      expect(upd[itemKey]).toBe(expected);
    });
  }

  for (const field of configSyncFields) {
    // The resolve path coerces per D1 column type: booleans land as true,
    // featured_count as the integer, strings verbatim.
    const kind = configValueKind(field);
    const expected = kind === "bool" ? true : kind === "int" ? 7 : `repo-${field.name}`;
    it(`config.${field.name}: resolve emits payload.config { key, value: ${JSON.stringify(expected)} }`, async () => {
      vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
        if (path === "telar-content/spreadsheets/objects.csv") return "";
        if (path === "_config.yml") return configYml(field.name);
        return null;
      });

      const changes = emptyChanges();
      changes.config.accept = [field.name];
      const { payload } = await resolveFullSyncPayload(
        PROJECT_ID, changes, TOKEN, OWNER, REPO, resolveDb(),
      );

      const entry = payload.config.find((c) => c.key === field.name);
      expect(entry, `config.${field.name} missing from payload.config`).toBeDefined();
      expect(entry!.value).toBe(expected);
    });
  }

  for (const field of glossarySyncFields) {
    it(`glossary.${field.name}: resolve carries "repo-${field.name}" (payload or residue)`, async () => {
      vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
        if (path === "telar-content/spreadsheets/objects.csv") return "";
        if (path === "telar-content/spreadsheets/glossary.csv") return glossaryCsv(field.name);
        return null;
      });

      const changes = emptyChanges();
      changes.glossary.accept = ["enc"];
      const { payload, residue } = await resolveFullSyncPayload(
        PROJECT_ID, changes, TOKEN, OWNER, REPO, resolveDb(),
      );

      if (field.name === "related_terms") {
        // related_terms is D1-only (never in the Y.Doc) — it rides the residue.
        const r = residue.relatedTermsUpdate.find((x) => x.termId === "enc");
        expect(r, "related_terms missing from residue").toBeDefined();
        expect(r!.relatedTerms).toBe("repo-related_terms");
      } else {
        expect(payload.glossary.update).toHaveLength(1);
        const upd = payload.glossary.update[0] as unknown as Record<string, unknown>;
        expect(upd.termId).toBe("enc");
        expect(upd[field.name]).toBe(`repo-${field.name}`);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 6. L-bug pins (action side) — resolveFullSyncPayload / applyFullSyncChanges
// ---------------------------------------------------------------------------

describe("registry sync probes — L-bug pins (action side)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
    vi.mocked(githubServer.getRepoHead).mockResolvedValue("newsha123");
  });

  it("L1: an inserted object is queued for origin = \"repo\" in the residue", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") {
        return ["object_id,title", "new-obj,New Object"].join("\n");
      }
      return null;
    });

    const changes = emptyChanges();
    changes.objects.newObjectIds = ["new-obj"];
    const { payload, residue } = await resolveFullSyncPayload(
      PROJECT_ID, changes, TOKEN, OWNER, REPO, probeSequentialMockDb([[], []]),
    );

    expect(payload.objects.insert.map((o) => o.object_id)).toContain("new-obj");
    expect(residue.originRepo).toContain("new-obj");
  });

  it("L3: the version heal fires on \"ahead\" with no optional parameter", async () => {
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "_config.yml") return `telar:\n  version: "9.9.9"`;
      return null;
    });

    const { payload, residue } = await resolveFullSyncPayload(
      PROJECT_ID,
      emptyChanges(),
      TOKEN,
      OWNER,
      REPO,
      // objects = [], project_config with an older version.
      probeSequentialMockDb([[], [{ id: 1, project_id: PROJECT_ID, telar_version: "1.0.0" }]]),
    );

    expect(residue.telarVersionHeal).toBe("9.9.9");
    expect(payload.telarVersion).toBe("9.9.9");
  });

  it("L4: an emptied story subtitle is applied (empty string, not skipped)", async () => {
    // project.csv gives my-story a title but an EMPTY subtitle cell.
    const csv = ["order,story_id,title,subtitle", "1,my-story,Kept Title,"].join("\n");
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
      if (path === "telar-content/spreadsheets/objects.csv") return "";
      if (path === "telar-content/spreadsheets/project.csv") return csv;
      return null;
    });

    const changes = emptyChanges();
    changes.stories.accept = ["my-story"];
    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID, changes, TOKEN, OWNER, REPO, probeSequentialMockDb([[], []]),
    );

    expect(payload.stories.update).toHaveLength(1);
    expect(payload.stories.update[0].subtitle).toBe("");
    expect(payload.stories.update[0].title).toBe("Kept Title");
  });
});
