/**
 * What the next check shows after a Compositor commit leaves head_sha alone.
 *
 * head_sha is B. An author edits a story on GitHub, making G. A Compositor
 * objects commit builds U on G and registers its object in D1. The commit
 * advances head_sha only from its own parent, G, so head_sha stays at B, and
 * the next check diffs U against B. That check lists G's story edit, which the
 * Compositor never read, and does not list the Compositor's own object as a
 * GitHub change, since D1 already holds it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTableName, Table } from "drizzle-orm";

const repo = vi.hoisted(() => ({
  /** File text by "<ref>:<path>"; absent unless set. */
  files: {} as Record<string, string>,
}));

vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => "U"),
  getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string, ref: string) => {
    const content = repo.files[`${ref}:${path}`];
    return content === undefined ? { status: "absent" } : { status: "ok", content };
  }),
  getFileContent: vi.fn(async (_t: string, _o: string, _r: string, path: string, ref?: string) =>
    repo.files[`${ref ?? "U"}:${path}`] ?? null,
  ),
  getRepoTree: vi.fn(async () => ({ tree: [], truncated: false })),
  // No story subtree at either commit: the story's steps are not in question.
  getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
  listSubtreeEntries: vi.fn(async () => ({ files: new Map(), dirs: new Set() })),
  graphqlGitHub: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
  decodeGitHubContent: vi.fn((s: string) => s),
}));

import { computeFullSyncDiff, hasDivergentChanges } from "~/lib/sync.server";
import { d1ObjectRow, d1StoryRow, probeObjectsCsv, projectCsv, PROJECT_ID } from "./sync-probe-fixtures";

const OBJECTS = "telar-content/spreadsheets/objects.csv";
const PROJECT = "telar-content/spreadsheets/project.csv";

/** A D1 stand-in that answers every query with the rows of the table it reads. */
function dbWith(rowsByTable: Record<string, unknown[]>): never {
  const chainFor = (rows: unknown[]): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") return (resolve: (v: unknown[]) => unknown) => resolve(rows);
          return (...args: unknown[]) => {
            const table = args.find((a) => a instanceof Table);
            return chainFor(table ? rowsByTable[getTableName(table as Table)] ?? [] : rows);
          };
        },
      },
    );
  return chainFor([]) as never;
}

/** objects.csv at U: the base's object and the one the Compositor committed. */
function objectsWithCommitted(): string {
  const [header, row] = probeObjectsCsv().split("\n");
  return [header, row, row.replace(/^obj-1,/, "obj-2,")].join("\n");
}

beforeEach(() => {
  repo.files = {
    [`B:${OBJECTS}`]: probeObjectsCsv(),
    [`B:${PROJECT}`]: projectCsv(),
    // G's story edit, then the Compositor's object on top of it.
    [`U:${OBJECTS}`]: objectsWithCommitted(),
    [`U:${PROJECT}`]: projectCsv("title"),
  };
});

describe("the check after an objects commit left head_sha at B", () => {
  const d1 = () =>
    dbWith({
      objects: [d1ObjectRow(), { ...d1ObjectRow(), id: 2, object_id: "obj-2", origin: "compositor" }],
      stories: [d1StoryRow()],
    });

  it("lists G's story edit", async () => {
    const diff = await computeFullSyncDiff(PROJECT_ID, "tok", "owner", "repo", d1(), "B");
    expect(diff.classification).toBe("three-way");
    expect(diff.stories.changedStories.map((s) => s.story_id)).toEqual(["my-story"]);
    expect(hasDivergentChanges(diff)).toBe(true);
  });

  it("does not list the Compositor's own object as a GitHub change", async () => {
    const diff = await computeFullSyncDiff(PROJECT_ID, "tok", "owner", "repo", d1(), "B");
    const listed = [
      ...diff.objects.newObjects,
      ...diff.objects.changedObjects,
      ...diff.objects.missingObjects,
    ].map((o) => o.object_id);
    expect(listed).not.toContain("obj-2");
    expect(diff.objects.unregisteredFiles).toEqual([]);
  });

  it("would list the object, were it absent from D1: the probe can see objects", async () => {
    const diff = await computeFullSyncDiff(
      PROJECT_ID, "tok", "owner", "repo", dbWith({ objects: [d1ObjectRow()], stories: [d1StoryRow()] }), "B",
    );
    expect(diff.objects.newObjects.map((o) => o.object_id)).toContain("obj-2");
  });
});
