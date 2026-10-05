/**
 * Authorization tests for the config route's action — the approved split.
 *
 * `_app.config` posts the whole site configuration in one form, but the fields
 * do not share one standing. Ruling 6 (2026-08-27) draws the line at anything
 * that changes where the site lives, how it is built, or where its data comes
 * from: `url`, `baseurl`, `story_key`, `google_sheets_enabled`,
 * `google_sheets_published_url` and `include_demo_content` are the convenor's;
 * titles, descriptions, author, email, theme, display toggles,
 * `collection_mode` and `featured_count` stay with any member, matching what
 * the homepage editor's autosave already reaches.
 *
 * So the action splits the submission rather than refusing it: a collaborator's
 * approved fields persist and the six are dropped. Refusing the whole save
 * would make the page unusable for a collaborator, because one form carries
 * both halves.
 *
 * `refresh-themes` is not a config field — it wipes `project_themes` and
 * rebuilds it from the repo — and stays convenor-only.
 *
 * `resolveActiveProjectFromRequest` establishes membership and nothing more —
 * it resolves the session's active project out of the caller's memberships and
 * hands back the role — so the role it returns is what the gate must read.
 * Instructors carry a collaborator's editorial rights and no more.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
// resolvePageProject and siteChangedAnswer are reimplemented here against the
// mocked resolveActiveProjectFromRequest, mirroring active-project.server.ts:
// a same-module call inside the real resolvePageProject binds to the real
// resolveActiveProjectFromRequest, not to a vi.fn() substituted only in this
// mock's returned object, so importOriginal would not let the mock take hold.
vi.mock("~/lib/active-project.server", async () => {
  const { data } = await import("react-router");
  const resolveActiveProjectFromRequest = vi.fn();
  return {
    resolveActiveProjectFromRequest,
    resolvePageProject: vi.fn(
      async (_request: Request, _env: unknown, _userId: number, formData: FormData) => {
        const resolved = await resolveActiveProjectFromRequest();
        if (!resolved) return { kind: "no_project" as const };
        if (formData.get("siteId") !== String((resolved as never as { project: { id: number } }).project.id)) {
          return {
            kind: "site_changed" as const,
            currentSiteName: (resolved as never as { project: { github_repo_full_name: string } })
              .project.github_repo_full_name,
          };
        }
        return { kind: "ok" as const, ...(resolved as object) };
      },
    ),
    siteChangedAnswer: vi.fn((intent: string, currentSiteName: string) =>
      data({ ok: false, intent, error: "site_changed", currentSiteName }, { status: 409 }),
    ),
  };
});
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github.server", () => ({
  getRepoTree: vi.fn(async () => ({ tree: [] })),
  getFileContent: vi.fn(async () => null),
  getFileOnDefaultBranch: vi.fn(async () => ({ status: "absent" })),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/yaml.server", () => ({ parseYaml: vi.fn(() => ({})) }));
vi.mock("~/lib/sheets-reconcile.server", () => ({
  reconcileSheetsFlagFromRepo: vi.fn(),
}));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({ getYText: vi.fn() }));

import { action } from "~/routes/_app.config";
import { getDb } from "~/lib/db.server";
import { getRepoTree, getFileOnDefaultBranch } from "~/lib/github.server";
import { parseYaml } from "~/lib/yaml.server";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { CONVENOR_ONLY_CONFIG_FIELDS } from "~/lib/config-fields";

type Role = "convenor" | "collaborator" | "instructor";

function makeDbMock() {
  const updates: unknown[] = [];
  const sets: Record<string, unknown>[] = [];
  const deletes: unknown[] = [];
  const inserts: unknown[] = [];
  const batches: unknown[][] = [];
  return {
    batches,
    batch: vi.fn(async (ops: unknown[]) => {
      batches.push(ops);
      return [];
    }),
    updates,
    sets,
    deletes,
    inserts,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          Object.assign(Promise.resolve([]), {
            limit: vi.fn().mockResolvedValue([]),
          }),
        ),
      })),
    })),
    update: vi.fn((table: unknown) => {
      updates.push(table);
      return {
        set: vi.fn((values: Record<string, unknown>) => {
          sets.push(values);
          return { where: vi.fn(async () => undefined) };
        }),
      };
    }),
    delete: vi.fn((table: unknown) => {
      deletes.push(table);
      return { where: vi.fn(async () => undefined) };
    }),
    insert: vi.fn((table: unknown) => {
      inserts.push(table);
      return { values: vi.fn(async () => undefined) };
    }),
  };
}

let currentDb: ReturnType<typeof makeDbMock>;

function buildArgs(fields: Record<string, string>) {
  const form = new URLSearchParams();
  // The active project every request must post against: asRole()'s id, string-
  // compared by resolvePageProject. Callers may override it via `fields`.
  form.set("siteId", "42");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  const user = { id: 7, encrypted_access_token: "enc-token" };
  const env = { ENCRYPTION_KEY: "key", DB: {} };
  return {
    request: new Request("https://compositor.telar.org/config", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    context: {
      get: vi.fn(() => user),
      cloudflare: { env },
    },
    params: {},
  } as never;
}

function asRole(role: Role) {
  vi.mocked(resolveActiveProjectFromRequest).mockResolvedValue({
    project: { id: 42, github_repo_full_name: "owner/repo" },
    userRole: role,
  } as never);
}

/** Every field the form posts, with values distinguishable from any default. */
const SAVE_FORM = {
  title: "Rewritten",
  description: "<p>d</p>",
  author: "a",
  email: "e@example.org",
  lang: "es",
  theme: "dark",
  logo: "https://example.org/logo.png",
  show_on_homepage: "false",
  show_story_steps: "false",
  show_object_credits: "false",
  browse_and_search: "false",
  show_link_on_homepage: "false",
  show_sample_on_homepage: "true",
  collection_mode: "true",
  skip_stories: "true",
  featured_count: "9",
  // Still in the form a stale tab would submit, and read by nothing.
  answer_word_limit: "60",
  include_demo_content: "false",
  url: "https://attacker.example",
  baseurl: "/pwned",
  story_key: "secret",
};

/** Field → the value the action should persist for it, given SAVE_FORM. */
const EXPECTED: Record<string, unknown> = {
  title: "Rewritten",
  description: "<p>d</p>",
  author: "a",
  email: "e@example.org",
  lang: "es",
  theme: "dark",
  logo: "https://example.org/logo.png",
  show_on_homepage: false,
  show_story_steps: false,
  show_object_credits: false,
  browse_and_search: false,
  show_link_on_homepage: false,
  show_sample_on_homepage: true,
  collection_mode: true,
  skip_stories: true,
  featured_count: 9,
  include_demo_content: false,
  url: "https://attacker.example",
  baseurl: "/pwned",
  story_key: "secret",
};

const COLLABORATOR_FIELDS = Object.keys(EXPECTED).filter(
  (f) => !CONVENOR_ONLY_CONFIG_FIELDS.has(f),
);

/**
 * The convenor-only fields this form carries. `google_sheets_enabled` and
 * `google_sheets_published_url` are on the approved list but have no control
 * on the page and are absent from the submission, so the action never writes
 * them for anybody — they are enforced where they are actually written, in the
 * Durable Object's snapshot.
 */
const CONVENOR_ONLY_SUBMITTED = Object.keys(EXPECTED).filter((f) =>
  CONVENOR_ONLY_CONFIG_FIELDS.has(f),
);

beforeEach(() => {
  vi.clearAllMocks();
  currentDb = makeDbMock();
  vi.mocked(getDb).mockReturnValue(currentDb as never);
  asRole("convenor");
});

describe("config action: a collaborator's save is split, not refused", () => {
  it.each(COLLABORATOR_FIELDS)("persists %s for a collaborator", async (field) => {
    asRole("collaborator");

    const result = await action(buildArgs(SAVE_FORM));

    expect(result).toMatchObject({ saved: true });
    expect(currentDb.sets.length).toBe(1);
    expect(currentDb.sets[0]).toHaveProperty(field, EXPECTED[field]);
  });

  it.each(CONVENOR_ONLY_SUBMITTED)(
    "drops %s from a collaborator's save",
    async (field) => {
      asRole("collaborator");

      const result = await action(buildArgs(SAVE_FORM));

      expect(currentDb.sets.length).toBe(1);
      expect(currentDb.sets[0]).not.toHaveProperty(field);
      expect(result).toMatchObject({ refusedFields: expect.arrayContaining([field]) });
    },
  );

  it.each(["google_sheets_enabled", "google_sheets_published_url"])(
    "never writes %s for anyone, because the form does not carry it",
    async (field) => {
      for (const role of ["collaborator", "instructor", "convenor"] as Role[]) {
        currentDb = makeDbMock();
        vi.mocked(getDb).mockReturnValue(currentDb as never);
        asRole(role);
        await action(buildArgs(SAVE_FORM));
        expect(currentDb.sets[0], role).not.toHaveProperty(field);
      }
    },
  );

  it("still stamps updated_at on the fields it does persist", async () => {
    asRole("collaborator");

    await action(buildArgs(SAVE_FORM));

    expect(currentDb.sets[0]).toHaveProperty("updated_at");
  });
});

describe("config action: an instructor is treated as a collaborator", () => {
  it.each(COLLABORATOR_FIELDS)("persists %s for an instructor", async (field) => {
    asRole("instructor");

    const result = await action(buildArgs(SAVE_FORM));

    expect(result).toMatchObject({ saved: true });
    expect(currentDb.sets[0]).toHaveProperty(field, EXPECTED[field]);
  });

  it.each(CONVENOR_ONLY_SUBMITTED)(
    "drops %s from an instructor's save",
    async (field) => {
      asRole("instructor");

      await action(buildArgs(SAVE_FORM));

      expect(currentDb.sets[0]).not.toHaveProperty(field);
    },
  );
});

describe("config action: the convenor saves everything", () => {
  it.each(Object.keys(EXPECTED))("persists %s for the convenor", async (field) => {
    const result = await action(buildArgs(SAVE_FORM));

    expect(result).toMatchObject({ saved: true });
    expect(currentDb.sets[0]).toHaveProperty(field, EXPECTED[field]);
  });

  it("refuses nothing", async () => {
    const result = await action(buildArgs(SAVE_FORM));

    expect(result).toMatchObject({ saved: true, refusedFields: [] });
  });
});

describe("config action: standing", () => {
  it("refuses a caller whose role is not one the split knows", async () => {
    vi.mocked(resolveActiveProjectFromRequest).mockResolvedValue({
      project: { id: 42, github_repo_full_name: "owner/repo" },
      userRole: "spectator",
    } as never);

    const result = await action(buildArgs(SAVE_FORM));

    expect(result).toEqual({ saved: false, error: "forbidden" });
    expect(currentDb.updates).toEqual([]);
  });

  it("still reports no_project when the caller has no membership at all", async () => {
    vi.mocked(resolveActiveProjectFromRequest).mockResolvedValue(null);

    const result = await action(buildArgs(SAVE_FORM));

    expect(result).toEqual({ saved: false, error: "No project found" });
    expect(currentDb.updates).toEqual([]);
  });
});

describe("config action: refresh-themes is convenor-only", () => {
  it("refuses a collaborator without wiping project_themes", async () => {
    asRole("collaborator");

    const result = await action(buildArgs({ intent: "refresh-themes" }));

    expect(result).toEqual({
      ok: false,
      intent: "refresh-themes",
      error: "forbidden",
    });
    expect(currentDb.deletes).toEqual([]);
    expect(currentDb.inserts).toEqual([]);
  });

  it("refuses an instructor without wiping project_themes", async () => {
    asRole("instructor");

    const result = await action(buildArgs({ intent: "refresh-themes" }));

    expect(result).toEqual({
      ok: false,
      intent: "refresh-themes",
      error: "forbidden",
    });
    expect(currentDb.deletes).toEqual([]);
  });

  it("lets the convenor refresh", async () => {
    const result = await action(buildArgs({ intent: "refresh-themes" }));

    expect(result).toEqual({ ok: true, intent: "refresh-themes", count: 0 });
    expect(currentDb.deletes.length).toBe(1);
  });
});

// Every theme is read before anything is written, and the rows are
// replaced in one batch.
describe("config action: refresh-themes replaces the themes as one batch", () => {
  const TREE = { tree: [
    { type: "blob", path: "_data/themes/a.yml" },
    { type: "blob", path: "_data/themes/b.yml" },
  ] };

  beforeEach(() => {
    vi.mocked(getRepoTree).mockResolvedValue(TREE as never);
    vi.mocked(parseYaml).mockImplementation(((text: string) => ({ name: text })) as never);
  });

  it("deletes and inserts in a single batch", async () => {
    vi.mocked(getFileOnDefaultBranch).mockImplementation((async (_t: string, _o: string, _r: string, path: string) => ({
      status: "ok",
      content: path,
    })) as never);

    const result = await action(buildArgs({ intent: "refresh-themes" }));

    expect(result).toEqual({ ok: true, intent: "refresh-themes", count: 2 });
    expect(currentDb.batches).toHaveLength(1);
    expect(currentDb.batches[0]).toHaveLength(3);
    expect(currentDb.inserts).toHaveLength(2);
  });

  it("refuses, writing nothing, when any theme file could not be read", async () => {
    vi.mocked(getFileOnDefaultBranch).mockImplementation((async (_t: string, _o: string, _r: string, path: string) =>
      path.endsWith("b.yml") ? { status: "error" } : { status: "ok", content: path }) as never);

    const result = await action(buildArgs({ intent: "refresh-themes" }));

    expect(result).toEqual({ ok: false, intent: "refresh-themes", error: "fetch_failed" });
    expect(currentDb.batches).toEqual([]);
    expect(currentDb.deletes).toEqual([]);
  });

  it("refuses, writing nothing, when the repository's tree listing is truncated", async () => {
    vi.mocked(getRepoTree).mockResolvedValue({ ...TREE, truncated: true } as never);
    vi.mocked(getFileOnDefaultBranch).mockResolvedValue({ status: "ok", content: "x" } as never);

    const result = await action(buildArgs({ intent: "refresh-themes" }));

    expect(result).toEqual({ ok: false, intent: "refresh-themes", error: "fetch_failed" });
    expect(currentDb.batches).toEqual([]);
  });

  it("keeps the old set when the batch fails", async () => {
    vi.mocked(getFileOnDefaultBranch).mockResolvedValue({ status: "ok", content: "x" } as never);
    currentDb.batch.mockImplementationOnce(async (ops: unknown[]) => {
      currentDb.batches.push(ops);
      throw new Error("D1 error");
    });

    const result = await action(buildArgs({ intent: "refresh-themes" }));

    expect(result).toEqual({ ok: false, intent: "refresh-themes", error: "fetch_failed" });
    // The delete and the inserts went to D1 only as the one batch that failed.
    expect(currentDb.batches).toHaveLength(1);
    expect(currentDb.batches[0]).toHaveLength(3);
  });
});

describe("config action: the retired answer word limit", () => {
  // The form no longer carries the field, and the action no longer reads one.
  // A submission that still names it — a stale tab, a hand-built POST — writes
  // nothing to the column and is not an error either: the limit is a constant
  // now, and there is nothing for a site to set.
  it("writes nothing to the column, whatever a submission names", async () => {
    const result = await action(buildArgs({ ...SAVE_FORM, answer_word_limit: "40" }));

    expect(result).toMatchObject({ saved: true });
    expect(currentDb.sets[0]).not.toHaveProperty("answer_word_limit");
  });

  it("refuses nothing for a malformed entry, since nothing reads it", async () => {
    const result = await action(buildArgs({ ...SAVE_FORM, answer_word_limit: "-5" }));

    expect(result).toMatchObject({ saved: true });
    expect(currentDb.sets[0]).not.toHaveProperty("answer_word_limit");
  });
});
