/**
 * The glossary kinds on the import and sync paths: what the import stores from
 * the repository's top-level `glossary: kinds:`, which differences the sync
 * diff reports, and what accepting one writes. The generic field probes
 * (field-registry-sync-probes) cover the declaration; the cases here pin the
 * canonical comparison, the null column and the unchanged-file publish.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/pending-object-ops.server", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  completePendingObjectOps: vi.fn(async () => ({ ok: true, applied: false, outcomes: new Map() })),
}));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "lease-1"),
}));
vi.mock("~/lib/github.server", () => {
  const getFileContent = vi.fn();
  return {
    getFileContent,
    getFileAtRef: vi.fn(async (...args: unknown[]) => {
      const content = await getFileContent(...args.slice(0, 4));
      return content == null ? { status: "absent" } : { status: "ok", content };
    }),
    getRepoTree: vi.fn(),
    getRepoHead: vi.fn(),
    graphqlGitHub: vi.fn(),
    githubHeaders: vi.fn(() => ({})),
    decodeGitHubContent: vi.fn((s: string) => s),
  };
});

import * as githubServer from "~/lib/github.server";
import { computeFullSyncDiff, extractConfigFields, resolveFullSyncPayload } from "~/lib/sync.server";
import { mapConfigToProjectConfig } from "~/lib/import.server";
import { publishableConfigYaml } from "~/lib/publish.server";
import { repoGlossaryKindsJson } from "~/lib/glossary-kinds-yaml.server";
import type { project_config } from "~/db/schema";
import { load as loadYaml } from "js-yaml";
import { PROJECT_ID, TOKEN, OWNER, REPO, probeSequentialMockDb, emptyChanges } from "./sync-probe-fixtures";

const KINDS = [{ id: "place", label: "Place", heading: "Places", values: ["sitio"] }];
const KINDS_JSON = JSON.stringify(KINDS);

const block = "glossary:\n  kinds:\n    - id: place\n      label: Place\n      heading: Places\n      values: [sitio]\n";
const flow = 'glossary:\n  kinds: [{heading: "Places", id: place, values: ["sitio"], label: "Place"}]\n';

function mockConfig(yml: string) {
  vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) => {
    if (path === "telar-content/spreadsheets/objects.csv") return "";
    if (path === "_config.yml") return yml;
    return null;
  });
}

const diff = (column: string | null) =>
  computeFullSyncDiff(PROJECT_ID, TOKEN, OWNER, REPO,
    probeSequentialMockDb([[], [], [], [], [{ id: 1, project_id: PROJECT_ID, glossary_kinds_json: column }]]));

describe("import: the repository's glossary kinds", () => {
  it("stores the list in the canonical shape", () => {
    const config = loadYaml(`title: T\n${block}`) as Record<string, unknown>;
    expect(mapConfigToProjectConfig(config).glossary_kinds_json).toBe(KINDS_JSON);
  });

  it("keeps an entry the framework would reject", () => {
    const config = loadYaml("glossary:\n  kinds:\n    - id: place\n") as Record<string, unknown>;
    expect(mapConfigToProjectConfig(config).glossary_kinds_json).toBe(
      JSON.stringify([{ id: "place", label: "", heading: "", values: [] }]),
    );
  });

  it("keeps a value that is not a string as the framework's str() writes it, through a publish", () => {
    const repo = "glossary:\n  kinds:\n    - {id: species, label: Species, heading: Species, values: [123, true, taxon]}\n";
    const stored = mapConfigToProjectConfig(loadYaml(repo) as Record<string, unknown>).glossary_kinds_json;
    const values = ["123", "True", "taxon"];
    expect(JSON.parse(stored!)).toEqual([{ id: "species", label: "Species", heading: "Species", values }]);
    // GitHub's label edit, declined: the publish restores the label and keeps every value.
    const published = publishableConfigYaml(repo.replace("label: Species", "label: Taxa"), {
      glossary_kinds_json: stored,
    } as unknown as typeof project_config.$inferSelect);
    const glossary = (loadYaml(published!) as { glossary: { kinds: unknown[] } }).glossary;
    expect(glossary.kinds).toEqual([{ id: "species", label: "Species", heading: "Species", values }]);
  });

  it("leaves the column unset when there is no glossary, no kinds, or no list", () => {
    for (const text of ["title: T\n", "glossary:\n  other: 1\n", "glossary:\n  kinds: place\n", "glossary: []\n"]) {
      expect(mapConfigToProjectConfig(loadYaml(text) as Record<string, unknown>).glossary_kinds_json).toBeUndefined();
    }
  });

  it("does not read the glossary collection entry", () => {
    const config = loadYaml("collections:\n  glossary:\n    kinds: [{id: x, label: X, heading: Xs}]\n") as Record<string, unknown>;
    expect(mapConfigToProjectConfig(config).glossary_kinds_json).toBeUndefined();
  });
});

describe("sync: the repository's glossary kinds against the column", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads block and flow spellings of one list as the same canonical JSON", () => {
    expect(repoGlossaryKindsJson(block)).toBe(KINDS_JSON);
    expect(repoGlossaryKindsJson(flow)).toBe(KINDS_JSON);
    expect(extractConfigFields(flow).glossary_kinds_json).toBe(KINDS_JSON);
  });

  it("shows a hand edit on GitHub", async () => {
    mockConfig(block.replace("Places", "Sites"));
    const result = await diff(KINDS_JSON);
    expect(result.config.changedFields).toEqual([
      expect.objectContaining({
        key: "glossary_kinds_json",
        d1Value: KINDS_JSON,
        repoValue: JSON.stringify([{ ...KINDS[0], heading: "Sites" }]),
      }),
    ]);
  });

  const scalar = block.replace("values: [sitio]", "values: sitio");

  it("keeps whether values was a list: a list edited to a scalar differs from the stored form", () => {
    expect(repoGlossaryKindsJson(scalar)).not.toBe(KINDS_JSON);
    expect(repoGlossaryKindsJson(scalar)).toBe(JSON.stringify([{ ...KINDS[0], values: "sitio" }]));
    expect(repoGlossaryKindsJson(block)).toBe(KINDS_JSON);
  });

  it("shows a list edited to a scalar on GitHub", async () => {
    mockConfig(scalar);
    const result = await diff(KINDS_JSON);
    expect(result.config.changedFields.map((f) => f.key)).toEqual(["glossary_kinds_json"]);
  });

  it("does not show an unchanged valid list", async () => {
    mockConfig(block);
    expect((await diff(KINDS_JSON)).config.changedFields).toEqual([]);
  });

  it("does not show a reformatting", async () => {
    mockConfig(flow);
    expect((await diff(KINDS_JSON)).config.changedFields).toEqual([]);
  });

  it("does not show a column written with other key order or spacing", async () => {
    mockConfig(block);
    const column = '[ {"label":"Place","values":["sitio"],"heading":"Places","id":"place"} ]';
    expect((await diff(column)).config.changedFields).toEqual([]);
  });

  it("shows the list removed on GitHub, with or without its glossary block", async () => {
    for (const yml of ["other: 1\n", "glossary:\n  other: 1\n"]) {
      mockConfig(yml);
      expect((await diff(KINDS_JSON)).config.changedFields).toEqual([
        expect.objectContaining({ key: "glossary_kinds_json", d1Value: KINDS_JSON, repoValue: "[]" }),
      ]);
    }
  });

  it("accepting a removal stores an empty list, which the next publish leaves out", async () => {
    mockConfig("other: 1\n");
    const changes = emptyChanges();
    changes.config.accept = ["glossary_kinds_json"];
    const { residue } = await resolveFullSyncPayload(
      PROJECT_ID, changes, TOKEN, OWNER, REPO, probeSequentialMockDb([[], []]), 1,
    );
    expect(residue.glossaryKindsAccept).toBe("[]");
    const config = { glossary_kinds_json: "[]" } as unknown as typeof project_config.$inferSelect;
    expect(publishableConfigYaml("title: T\n", config)).not.toContain("kinds");
  });

  it("never diffs a null column, however the repository's list reads", async () => {
    for (const yml of [block, "other: 1\n"]) {
      mockConfig(yml);
      expect((await diff(null)).config.changedFields).toEqual([]);
    }
  });

  it("accepting writes the repository's list as canonical JSON to the column's residue", async () => {
    mockConfig(flow.replace("Places", "Sites"));
    const changes = emptyChanges();
    changes.config.accept = ["glossary_kinds_json"];
    const { payload, residue } = await resolveFullSyncPayload(
      PROJECT_ID, changes, TOKEN, OWNER, REPO, probeSequentialMockDb([[], []]), 1,
    );
    expect(residue.glossaryKindsAccept).toBe(JSON.stringify([{ ...KINDS[0], heading: "Sites" }]));
    expect(payload.config).toEqual([]);
  });
});

describe("publish: a list the repository already holds", () => {
  const config = (json: string | null) => ({ glossary_kinds_json: json }) as unknown as typeof project_config.$inferSelect;
  const REPO_YML = `title: "A site"\n${flow}other: 1\n`;

  it("leaves the file exactly as found", () => {
    expect(publishableConfigYaml(REPO_YML, config(KINDS_JSON))).toBe(
      publishableConfigYaml(REPO_YML, config(null)),
    );
  });

  it("rewrites the file once the list differs", () => {
    const written = publishableConfigYaml(REPO_YML, config(JSON.stringify([{ ...KINDS[0], heading: "Sites" }])));
    expect(written).toContain("Sites");
    expect(written).not.toBe(publishableConfigYaml(REPO_YML, config(null)));
  });
});
