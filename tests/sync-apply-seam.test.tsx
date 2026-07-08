// @vitest-environment jsdom
/**
 * End-to-end apply-seam pins: a three-way diff → buildThreeWayChanges (the
 * modal's pure selection→changes mapping) → resolveFullSyncPayload (the
 * repo-refetch + coercion that feeds the DO ingest). These pin the apply seam's
 * default: a field the diff never surfaced (an editor-only suppressed field, or
 * a guard-suppressed enrichment field) is NEVER written through with the repo
 * cell, and an accepted alt_text change writes the RAW repo cell, not
 * mapObjectsCsv's title fallback.
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
import type { FullSyncDiff } from "~/lib/sync.server";
import { resolveFullSyncPayload } from "~/lib/sync.server";
import { buildThreeWayChanges } from "~/components/features/dashboard/SyncConfirmModal";
import {
  probeSequentialMockDb,
  emptyThreeWaySelections as emptySel,
  PROJECT_ID,
  TOKEN,
  OWNER,
  REPO,
} from "./sync-probe-fixtures";

const OBJECTS_PATH = "telar-content/spreadsheets/objects.csv";

/** A minimal three-way diff whose only content is one changed object. */
function diffWithChangedObject(
  changedFields: string[],
  d1Values: Record<string, unknown>,
  repoValues: Record<string, unknown>,
): FullSyncDiff {
  return {
    objects: {
      newObjects: [],
      changedObjects: [
        {
          object_id: "obj-1",
          dbId: 1,
          title: "Obj",
          changedFields: changedFields as never,
          conflictFields: [], // repo-only → pre-accepted "repo"
          d1Values: d1Values as never,
          repoValues: repoValues as never,
        },
      ],
      missingObjects: [],
      unregisteredFiles: [],
    },
    stories: { newStories: [], changedStories: [], missingStories: [] },
    config: { changedFields: [], versionChange: null },
    glossary: { added: [], removed: [], changed: [] },
    hasConflicts: false,
    classification: "three-way",
    suppressedEditorOnly: 0,
  };
}

/** resolveFullSyncPayload reads D1 objects then project_config. */
const seamDb = () =>
  probeSequentialMockDb([[{ id: 1, object_id: "obj-1", origin: "repo", title: "mine" }], []]);

describe("apply seam — suppressed fields are never written through", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(githubServer.getRepoTree).mockResolvedValue({ tree: [], truncated: false });
  });

  it("repo-only title accepted, editor-only description absent → title written, description NOT", async () => {
    // The diff surfaced only title (description was editor-only → suppressed and
    // never made it into changedFields).
    const diff = diffWithChangedObject(
      ["title"],
      { title: "mine-title" },
      { title: "repo-title" },
    );
    const changes = buildThreeWayChanges(diff, emptySel());

    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) =>
      path === OBJECTS_PATH
        ? "object_id,title,description\nobj-1,repo-title,base-desc"
        : null,
    );

    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID, changes, TOKEN, OWNER, REPO, seamDb(),
    );

    expect(payload.objects.update).toHaveLength(1);
    const fields = payload.objects.update[0].fields as Record<string, unknown>;
    expect(fields.title).toBe("repo-title");
    expect("description" in fields).toBe(false);
  });

  it("blank repo thumbnail + enriched D1 + accepted title → no thumbnail key", async () => {
    const diff = diffWithChangedObject(
      ["title"],
      { title: "mine-title" },
      { title: "repo-title" },
    );
    const changes = buildThreeWayChanges(diff, emptySel());

    // Repo thumbnail cell is blank; D1 holds an IIIF-enriched value. Because
    // thumbnail is not an accepted field, it must never be written.
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) =>
      path === OBJECTS_PATH
        ? "object_id,title,thumbnail\nobj-1,repo-title,"
        : null,
    );

    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID, changes, TOKEN, OWNER, REPO, seamDb(),
    );

    const fields = payload.objects.update[0].fields as Record<string, unknown>;
    expect(fields.title).toBe("repo-title");
    expect("thumbnail" in fields).toBe(false);
  });

  it("accepted alt_text writes the RAW repo cell, not mapObjectsCsv's title fallback", async () => {
    const diff = diffWithChangedObject(
      ["alt_text"],
      { alt_text: "mine-alt" },
      { alt_text: "repo-alt" },
    );
    const changes = buildThreeWayChanges(diff, emptySel());

    // Repo alt_text cell is BLANK while title is set — mapObjectsCsv would fill
    // alt_text with the title. The raw-cell read must write null (empty), not
    // "Some Title".
    vi.mocked(githubServer.getFileContent).mockImplementation(async (_t, _o, _r, path) =>
      path === OBJECTS_PATH
        ? "object_id,title,alt_text\nobj-1,Some Title,"
        : null,
    );

    const { payload } = await resolveFullSyncPayload(
      PROJECT_ID, changes, TOKEN, OWNER, REPO, seamDb(),
    );

    const fields = payload.objects.update[0].fields as Record<string, unknown>;
    expect("alt_text" in fields).toBe(true);
    expect(fields.alt_text).toBeNull();
    expect(fields.alt_text).not.toBe("Some Title");
  });
});
