/**
 * This file pins which revision of the repository a publish is built from.
 *
 * A publish has three readers of the same files: the check the author sees,
 * the check the action runs against what is about to be committed, and the
 * assembly that produces the commit. They are only one publish while they read
 * one revision. Reading without a ref takes the repository's DEFAULT branch,
 * which is not necessarily the branch the commit targets — a site whose
 * default is `develop` had its checks run against `main` and its file set
 * built from `develop`, which publishes settings from a branch nobody looked
 * at and turns a blocker into a thrown write.
 *
 * So every file the assembly reads is pinned to the SHA the action resolved at
 * the start — one revision for the whole publish, commit included — and the
 * `_config.yml` the action already read for its own check is handed down
 * rather than read a second time: two reads of one path are two chances to
 * disagree.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const { atRef, withoutRef } = vi.hoisted(() => ({
  atRef: vi.fn(async (_t: string, _o: string, _r: string, path: string, ref: string) => ({
    status: "ok" as const,
    content: path === "_config.yml" ? `title: "on ${ref}"\n` : `# ${path} on ${ref}\n`,
  })),
  withoutRef: vi.fn(async () => "title: \"on the default branch\"\n"),
}));

vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getFileAtRef: atRef, getFileContent: withoutRef };
});

/** The one revision a publish reads everything at. */
const PUBLISH_SHA = "sha-at-the-start";

const GLOSSARY_TERM = { term_id: "loom", title: "Loom", definition: "A frame", related_terms: null, extra_columns: null };

const CONFIG_ROW = {
  project_id: 1,
  title: "A site",
  answer_word_limit: 60,
};

// The five reads the assembly makes, in the order it makes them: stories,
// project_config, project_landing, objects, glossary_terms. The config row
// decides that a `_config.yml` is written at all, and the glossary term that a
// glossary.csv is, and so read.
vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => {
    let limitCalls = 0;
    return {
      select: () => {
        const chain: Record<string, unknown> = {};
        let table = "";
        chain.from = (t: Record<symbol, unknown>) => {
          table = String(t[Symbol.for("drizzle:Name")]);
          return chain;
        };
        chain.where = () =>
          Object.assign(Promise.resolve(table === "glossary_terms" ? [GLOSSARY_TERM] : []), chain);
        // A read ordered with `.orderBy()` (objects, in `objectsSheetOrder`) answers the same rows.
        chain.orderBy = function (this: unknown) { return this; };
        chain.limit = () => {
          limitCalls += 1;
          return Promise.resolve(limitCalls === 1 ? [CONFIG_ROW] : []);
        };
        return chain;
      },
    };
  }),
}));

import { buildPublishFileSet } from "~/lib/publish.server";

/** A landing row, so the assembly writes index.md and reads the one it replaces. */
const LANDING_ROW = { id: 1, project_id: 1, stories_heading: "Stories" };

function build(
  configYml?: string | null,
  config?: Record<string, unknown> | null,
  landing?: Record<string, unknown>,
) {
  return buildPublishFileSet({
    token: "tok",
    owner: "owner",
    repo: "repo",
    ref: PUBLISH_SHA,
    projectId: 1,
    env: { DB: {} } as never,
    ...(configYml === undefined ? {} : { configYml }),
    ...(config === undefined ? {} : { config: config as never }),
    ...(landing === undefined ? {} : { landing: landing as never }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the revision a publish is assembled from", () => {
  it("reads every repository file at the revision it was given", async () => {
    await build();

    expect(withoutRef).not.toHaveBeenCalled();
    expect(atRef).toHaveBeenCalled();
    for (const call of atRef.mock.calls) {
      expect(call[4]).toBe(PUBLISH_SHA);
    }
  });

  it("names the files it reads, so an unpinned one cannot slip back in", async () => {
    await build(undefined, undefined, LANDING_ROW);

    expect(atRef.mock.calls.map((call) => call[3]).sort()).toEqual([
      "_config.yml",
      "index.md",
      "telar-content/spreadsheets/glossary.csv",
      "telar-content/spreadsheets/objects.csv",
      "telar-content/spreadsheets/project.csv",
    ]);
  });

  it("takes the _config.yml the caller already read rather than reading it again", async () => {
    // An unmanaged line, because the managed ones are rewritten from D1 by
    // definition: what this asserts is WHICH file was edited.
    const files = await build('# handed down\ntitle: "x"\nstory_content:\n  answer_word_limit: 60\n');

    expect(atRef.mock.calls.map((call) => call[3])).not.toContain("_config.yml");
    const config = files.find((f) => f.path === "_config.yml");
    expect(config?.content).toContain("# handed down");
  });

  it("writes no config at all when the caller read no file", async () => {
    const files = await build(null);

    expect(files.map((f) => f.path)).not.toContain("_config.yml");
  });
});

// ---------------------------------------------------------------------------
// The project_config row, for the same reason as the file
// ---------------------------------------------------------------------------

/**
 * The write's decision is the row AND the file together: the heal repairs a
 * broken managed line only when the row has a value to write over it. So a row
 * read twice is two chances to disagree exactly as a file read twice is, and
 * the disagreement is a check that passes
 * on one row and a write silently skipped on the other.
 *
 * `telar_theme` is the shortest demonstration. Broken in the file, and with a
 * theme in the row it is rewritten and the file parses; with none, the broken
 * line stands and the publish writes no config at all.
 */
const BROKEN_THEME = 'title: "A site"\ntelar_theme: [bad\n';

describe("the project_config row a publish is assembled from", () => {
  it("takes the row the caller already read rather than reading its own", async () => {
    const files = await build(BROKEN_THEME, { ...CONFIG_ROW, theme: "plain" });

    expect(files.map((f) => f.path)).toContain("_config.yml");
    expect(files.find((f) => f.path === "_config.yml")?.content).toContain(
      'telar_theme: "plain"',
    );
  });

  it("writes no config at all when the caller read no row", async () => {
    const files = await build('title: "A site"\n', null);

    expect(files.map((f) => f.path)).not.toContain("_config.yml");
  });
});
