/**
 * This file pins the creation-time join: a class code entered while a site
 * is being created attaches that site to its course once the project row
 * exists.
 *
 * The join runs after `importRepo` because the row it attaches only exists
 * from that point, and it runs inside the same action so the wizard learns
 * the outcome with the import result. `redeemForSite` already does the
 * writes and already reports a typed state per refusal; what is asserted
 * here is that each of those states survives to the caller as its own
 * outcome, that the site is untouched by a join that fails, and that no
 * code means no redemption attempt at all.
 *
 * It also pins how a sheet the import refuses, and a file it could not read,
 * reach the wizard: each as a validation error of its own, mapped to its own
 * message key.
 *
 * Mocking strategy mirrors `tests/onboarding-project-authz.test.ts`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted above imports by vi.mock)
// ---------------------------------------------------------------------------

/**
 * Returns the course's title for the name lookup, and records deletes so a
 * failed join can be asserted to have cascaded nothing.
 */
function makeDbMock() {
  const deletes: unknown[] = [];
  return {
    deletes,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [{ title: "History 101", github_repo_full_name: "teacher/hist-101" }]),
          get: vi.fn(async () => ({ title: "History 101" })),
        })),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    delete: vi.fn((table: unknown) => {
      deletes.push(table);
      return { where: vi.fn(async () => undefined) };
    }),
    batch: vi.fn(async () => []),
  };
}

let currentDb: ReturnType<typeof makeDbMock>;

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn(() => currentDb) }));

vi.mock("~/middleware/auth.server", () => ({
  authMiddleware: vi.fn(),
  userContext: Symbol("userContext"),
}));

// Creating a course takes the course password, so the session's answer to
// it is driven per test. Joining one does not, which is what the code tests
// below leave locked.
const gate = vi.hoisted(() => ({ unlocked: false }));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({
      get: vi.fn((key: string) =>
        key === "courseGateUnlocked" ? gate.unlocked || undefined : undefined,
      ),
      set: vi.fn(),
    })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));

vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));

vi.mock("~/lib/membership.server", () => ({
  getUserRole: vi.fn(async () => "convenor"),
  requireOwner: vi.fn(async () => undefined),
  requireProjectMember: vi.fn(async () => undefined),
}));

vi.mock("~/lib/config-repair.server", () => ({ repairSiteConfig: vi.fn(async () => "applied") }));

vi.mock("~/lib/github.server", () => ({
  listUserInstallations: vi.fn(),
  listInstallationRepos: vi.fn(),
  getFileContent: vi.fn(async () => "title: Site\n"),
}));

vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(),
  disableGoogleSheetsInConfig: vi.fn((c: string) => c),
  verifySiteUrl: vi.fn(),
  enableGitHubPages: vi.fn(),
  isGoogleSheetsEnabled: vi.fn(() => false),
}));

vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "install-token"),
}));

// The installation reaches the repository; its check has its own suite.
vi.mock("~/lib/onboarding-create-site.server", () => ({
  handleCreateSiteIntents: vi.fn(),
  importScopeRefusal: vi.fn(async () => null),
}));

vi.mock("~/lib/import.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/import.server")>();
  return { ...actual, importRepo: vi.fn() };
});

vi.mock("~/lib/upgrade.server", () => ({
  checkTelarVersion: vi.fn(async () => ({ needsUpgrade: false })),
}));

vi.mock("~/lib/join-codes.server", () => ({ redeemForSite: vi.fn() }));

vi.mock("~/lib/course-membership.server", () => ({
  applyRedemptionSideEffects: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/onboarding";
import { CollidingColumnsRefusal, importRepo } from "~/lib/import.server";
import type { ImportResult } from "~/lib/import.server";
import { SheetUnreadableError } from "~/lib/unreadable-file.server";
import { validationErrorMessage } from "~/components/features/onboarding/StepSync";
import { redeemForSite } from "~/lib/join-codes.server";
import { applyRedemptionSideEffects } from "~/lib/course-membership.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = 7;
const NEW_PROJECT_ID = 42;

/** The shape a successful import returns, trimmed to what the action reads. */
const IMPORTED = {
  valid: true,
  projectId: NEW_PROJECT_ID,
  project: { imported: true, storiesFound: 0 },
  objects: { imported: 0, skipped: 0, warnings: [] },
  stories: { imported: 0, warnings: [] },
  glossary: { imported: 0 },
  pages: { imported: 0 },
  themes: { imported: 0, list: [] },
  sheetsEnabled: false,
  sheetsDisabled: false,
  iiifObjectIds: [],
  audioObjectIds: [],
  videoObjectCount: 0,
  configFields: {},
  orphanStoryIds: [],
};

function post(fields: Record<string, string>) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return action({
    request: new Request("https://compositor.telar.org/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    context: {
      get: vi.fn(() => ({ id: USER_ID, encrypted_access_token: "enc", course_access: gate.unlocked })),
      cloudflare: { env: { ENCRYPTION_KEY: "k", SESSION_SECRET: "s", DB: {} } },
    } as never,
    params: {},
  } as never);
}

function importFields(extra: Record<string, string> = {}) {
  return {
    intent: "import",
    installation_id: "1",
    repo_full_name: "student/group-a",
    ...extra,
  };
}

/** What the side effects report when the collection transferred cleanly. */
const SIDE_EFFECTS = {
  staff: { inserted: 2, skipped: [] },
  preload: { inserted: 12, skippedAlreadyOurs: [], skippedConflict: [], skippedRepoBound: [] },
  enrolled: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  gate.unlocked = false;
  currentDb = makeDbMock();
  vi.mocked(importRepo).mockResolvedValue(IMPORTED as never);
  vi.mocked(applyRedemptionSideEffects).mockResolvedValue(SIDE_EFFECTS as never);
});

// ---------------------------------------------------------------------------
// The kind choice reaching the importer
// ---------------------------------------------------------------------------

describe("onboarding action — the kind choice", () => {
  it("passes kind 'course' through to importRepo", async () => {
    gate.unlocked = true;
    await post(importFields({ kind: "course" }));
    expect(vi.mocked(importRepo).mock.calls[0][0]).toMatchObject({ kind: "course" });
  });

  it("narrows an unknown kind to 'site' rather than passing it on", async () => {
    await post(importFields({ kind: "sneaky" }));
    expect(vi.mocked(importRepo).mock.calls[0][0]).toMatchObject({ kind: "site" });
  });

  it("defaults to 'site' when the form carries no kind", async () => {
    await post(importFields());
    expect(vi.mocked(importRepo).mock.calls[0][0]).toMatchObject({ kind: "site" });
  });
});

// ---------------------------------------------------------------------------
// The join itself
// ---------------------------------------------------------------------------

describe("onboarding action — the creation-time join", () => {
  it("attaches the new site to the course on a valid code", async () => {
    vi.mocked(redeemForSite).mockResolvedValue({
      state: "ok",
      courseProjectId: 9,
      inviteId: 3,
      alreadyAttached: false,
    });

    const result = (await post(importFields({ course_code: "ABCDEF2345" }))) as {
      courseJoin: { state: string; courseProjectId: number; courseName: string };
    };

    expect(redeemForSite).toHaveBeenCalledWith(currentDb, {
      token: "ABCDEF2345",
      childProjectId: NEW_PROJECT_ID,
      userId: USER_ID,
    });
    expect(result.courseJoin).toMatchObject({
      state: "ok",
      courseProjectId: 9,
      courseName: "History 101",
    });
  });

  it("runs the redemption's side effects and reports what the collection did", async () => {
    vi.mocked(redeemForSite).mockResolvedValue({
      state: "ok",
      courseProjectId: 9,
      inviteId: 3,
      alreadyAttached: false,
    });
    vi.mocked(applyRedemptionSideEffects).mockResolvedValue({
      staff: { inserted: 2, skipped: [] },
      preload: {
        inserted: 12,
        skippedAlreadyOurs: [],
        skippedConflict: ["obj-a"],
        skippedRepoBound: ["obj-b", "obj-c"],
      },
      enrolled: true,
    } as never);

    const result = (await post(importFields({ course_code: "ABCDEF2345" }))) as {
      courseJoin: Record<string, unknown>;
    };

    expect(applyRedemptionSideEffects).toHaveBeenCalledWith(
      currentDb,
      expect.anything(),
      { courseProjectId: 9, childProjectId: NEW_PROJECT_ID },
    );
    expect(result.courseJoin).toMatchObject({
      preloaded: 12,
      skippedConflict: 1,
      skippedRepoBound: 2,
    });
  });

  it("never runs the side effects on a refused code", async () => {
    vi.mocked(redeemForSite).mockResolvedValue({ state: "revoked" } as never);
    await post(importFields({ course_code: "ABCDEF2345" }));
    expect(applyRedemptionSideEffects).not.toHaveBeenCalled();
  });

  it("reports a failed collection transfer as 'failed' — re-entering the code repairs it", async () => {
    vi.mocked(redeemForSite).mockResolvedValue({
      state: "ok",
      courseProjectId: 9,
      inviteId: 3,
      alreadyAttached: false,
    });
    vi.mocked(applyRedemptionSideEffects).mockRejectedValue(new Error("preload refused"));

    const result = (await post(importFields({ course_code: "ABCDEF2345" }))) as {
      valid: boolean;
      courseJoin: { state: string };
    };

    expect(result.courseJoin.state).toBe("failed");
    expect(result.valid).toBe(true);
    expect(currentDb.deletes).toEqual([]);
  });

  it("reports 'not_enrolled' rather than 'ok' when the site left the course mid-sequence", async () => {
    vi.mocked(redeemForSite).mockResolvedValue({
      state: "ok",
      courseProjectId: 9,
      inviteId: 3,
      alreadyAttached: false,
    });
    vi.mocked(applyRedemptionSideEffects).mockResolvedValue({
      staff: { inserted: 2, skipped: [] },
      preload: { inserted: 0, skippedAlreadyOurs: [], skippedConflict: [], skippedRepoBound: [] },
      enrolled: false,
    } as never);

    const result = (await post(importFields({ course_code: "ABCDEF2345" }))) as {
      courseJoin: { state: string; courseProjectId?: number; courseName?: string; preloaded?: number };
    };

    expect(result.courseJoin.state).toBe("not_enrolled");
    expect(result.courseJoin).toMatchObject({ courseProjectId: 9, courseName: "History 101" });
    expect(result.courseJoin.preloaded).toBeUndefined();
  });

  it("redeems after the import, never before — the row must exist first", async () => {
    const order: string[] = [];
    vi.mocked(importRepo).mockImplementation(async () => {
      order.push("import");
      return IMPORTED as never;
    });
    vi.mocked(redeemForSite).mockImplementation(async () => {
      order.push("redeem");
      return { state: "ok", courseProjectId: 9, inviteId: 3, alreadyAttached: false };
    });

    vi.mocked(applyRedemptionSideEffects).mockImplementation(async () => {
      order.push("side-effects");
      return SIDE_EFFECTS as never;
    });

    await post(importFields({ course_code: "ABCDEF2345" }));
    // The side effects ingest into the child's document, which a cold Durable
    // Object rebuilds from D1 — so they cannot start before the import has
    // finished writing it.
    expect(order).toEqual(["import", "redeem", "side-effects"]);
  });

  it("attempts no redemption when no code was entered", async () => {
    const result = (await post(importFields())) as { courseJoin?: unknown };
    expect(redeemForSite).not.toHaveBeenCalled();
    expect(result.courseJoin).toBeUndefined();
  });

  it("attempts no redemption for a code of only whitespace", async () => {
    await post(importFields({ course_code: "   " }));
    expect(redeemForSite).not.toHaveBeenCalled();
  });

  it("trims a pasted code before redeeming it", async () => {
    vi.mocked(redeemForSite).mockResolvedValue({
      state: "ok",
      courseProjectId: 9,
      inviteId: 3,
      alreadyAttached: false,
    });
    await post(importFields({ course_code: "  ABCDEF2345 " }));
    expect(vi.mocked(redeemForSite).mock.calls[0][1]).toMatchObject({ token: "ABCDEF2345" });
  });

  it("attempts no redemption when the import produced no project", async () => {
    vi.mocked(importRepo).mockResolvedValue({
      ...IMPORTED,
      valid: false,
      validationError: "already_connected",
      projectId: undefined,
    } as never);

    await post(importFields({ course_code: "ABCDEF2345" }));
    expect(redeemForSite).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Every refusal keeps its own name
// ---------------------------------------------------------------------------

describe("onboarding action — redemption refusals", () => {
  const refusals = [
    "not_found",
    "expired",
    "revoked",
    "consumed",
    "wrong_kind",
    "rate_limited",
    "already_enrolled",
    "not_a_site",
  ] as const;

  for (const state of refusals) {
    it(`reports ${state} as its own outcome`, async () => {
      vi.mocked(redeemForSite).mockResolvedValue({ state } as never);
      const result = (await post(importFields({ course_code: "ABCDEF2345" }))) as {
        courseJoin: { state: string };
      };
      expect(result.courseJoin.state).toBe(state);
    });
  }

  it("gives each refusal a distinct outcome rather than one shared error", async () => {
    const seen = new Set<string>();
    for (const state of refusals) {
      vi.mocked(redeemForSite).mockResolvedValue({ state } as never);
      const result = (await post(importFields({ course_code: "ABCDEF2345" }))) as {
        courseJoin: { state: string };
      };
      seen.add(result.courseJoin.state);
    }
    expect(seen.size).toBe(refusals.length);
  });

  it("reports a throw as 'failed' rather than letting it take down the import", async () => {
    vi.mocked(redeemForSite).mockRejectedValue(new Error("no convenor row"));
    const result = (await post(importFields({ course_code: "ABCDEF2345" }))) as {
      courseJoin: { state: string };
    };
    expect(result.courseJoin.state).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// A failed join leaves the site whole
// ---------------------------------------------------------------------------

describe("onboarding action — a failed join leaves no half-created project", () => {
  it("keeps the imported project and deletes nothing when the code is refused", async () => {
    vi.mocked(redeemForSite).mockResolvedValue({ state: "revoked" } as never);

    const result = (await post(importFields({ course_code: "ABCDEF2345" }))) as {
      valid: boolean;
      projectId: number;
    };

    expect(result.valid).toBe(true);
    expect(result.projectId).toBe(NEW_PROJECT_ID);
    expect(currentDb.deletes).toEqual([]);
  });

  it("keeps the imported project and deletes nothing when redemption throws", async () => {
    vi.mocked(redeemForSite).mockRejectedValue(new Error("boom"));

    const result = (await post(importFields({ course_code: "ABCDEF2345" }))) as {
      valid: boolean;
      projectId: number;
    };

    expect(result.valid).toBe(true);
    expect(result.projectId).toBe(NEW_PROJECT_ID);
    expect(currentDb.deletes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The Sheets-retry path is the same creation
// ---------------------------------------------------------------------------

describe("onboarding action — import_with_url", () => {
  it("carries the kind and joins the course on the retry too", async () => {
    vi.mocked(redeemForSite).mockResolvedValue({
      state: "ok",
      courseProjectId: 9,
      inviteId: 3,
      alreadyAttached: false,
    });

    const result = (await post({
      intent: "import_with_url",
      installation_id: "1",
      repo_full_name: "student/group-a",
      sheets_url: "https://docs.google.com/x/pubhtml",
      kind: "site",
      course_code: "ABCDEF2345",
    })) as { courseJoin: { state: string } };

    expect(vi.mocked(importRepo).mock.calls[0][0]).toMatchObject({ kind: "site" });
    expect(result.courseJoin.state).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// A sheet the first import refuses
// ---------------------------------------------------------------------------

describe("onboarding action — a sheet with two filled columns for one field", () => {
  const refusal = new CollidingColumnsRefusal("objects.csv", "medium_genre", ["medium", "object_type"]);

  it("reports the refusal as a validation error naming the sheet, field and headers", async () => {
    vi.mocked(importRepo).mockRejectedValue(refusal);
    const result = (await post(importFields())) as ImportResult;
    expect(result.valid).toBe(false);
    expect(result.validationError).toBe("colliding_columns");
    expect(result.collidingColumns).toEqual({
      sheet: "objects.csv",
      canonicalName: "medium_genre",
      headers: ["medium", "object_type"],
    });
    expect(redeemForSite).not.toHaveBeenCalled();
  });

  it("lets any other failure through", async () => {
    vi.mocked(importRepo).mockRejectedValue(new Error("network down"));
    await expect(post(importFields())).rejects.toThrow("network down");
  });

  it("maps the refusal to its own message key, with the headers as typed", async () => {
    vi.mocked(importRepo).mockRejectedValue(refusal);
    const result = (await post(importFields())) as ImportResult;
    const t = vi.fn((key: string, options?: Record<string, unknown>) =>
      `${key} ${JSON.stringify(options ?? {})}`,
    );
    const message = validationErrorMessage(result, t);
    expect(t).toHaveBeenCalledWith("step_sync.error_colliding_columns", {
      sheet: "objects.csv",
      field: "medium_genre",
      columns: '"medium", "object_type"',
    });
    expect(message.startsWith("step_sync.error_colliding_columns")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A file the first import could not read
// ---------------------------------------------------------------------------

describe("onboarding action — a file the import could not read", () => {
  it.each([
    [`telar-content/spreadsheets/objects.csv`, "sheet_unreadable", { unreadableSheet: "objects.csv" }],
    ["_data/story-one.csv", "sheet_unreadable", { unreadableSheet: "story-one.csv" }],
    ["telar-content/texts/pages/about.md", "file_unreadable", { unreadableFile: "telar-content/texts/pages/about.md" }],
    [".compositor-ignored", "ignore_list_unreadable", {}],
  ])("answers %s as %s, naming it", async (path, validationError, names) => {
    vi.mocked(importRepo).mockRejectedValue(new SheetUnreadableError(path));

    const result = (await post(importFields({ course_code: "ABC-123" }))) as ImportResult;

    expect(result.valid).toBe(false);
    expect(result.validationError).toBe(validationError);
    expect(result.unreadableSheet).toBe((names as { unreadableSheet?: string }).unreadableSheet);
    expect(result.unreadableFile).toBe((names as { unreadableFile?: string }).unreadableFile);
    expect(result.project.imported).toBe(false);
    expect(redeemForSite).not.toHaveBeenCalled();
  });

  it.each([
    [`telar-content/spreadsheets/glossary.csv`, "step_sync.error_sheet_unreadable", { sheet: "glossary.csv" }],
    ["index.md", "step_sync.error_file_unreadable", { file: "index.md" }],
    [".compositor-ignored", "step_sync.error_ignore_list_unreadable", undefined],
  ])("shows %s with its own sentence", async (path, key, options) => {
    vi.mocked(importRepo).mockRejectedValue(new SheetUnreadableError(path));
    const result = (await post(importFields())) as ImportResult;
    const t = vi.fn((k: string, o?: Record<string, unknown>) => `${k} ${JSON.stringify(o ?? {})}`);

    validationErrorMessage(result, t);

    expect(t.mock.calls).toEqual([options === undefined ? [key] : [key, options]]);
  });
});

// ---------------------------------------------------------------------------
// A site whose default branch is not main
// ---------------------------------------------------------------------------

describe("the sync step — a default branch other than main", () => {
  it("names the branch", () => {
    const t = vi.fn((k: string, o?: Record<string, unknown>) => `${k} ${JSON.stringify(o ?? {})}`);

    validationErrorMessage(
      { ...IMPORTED, valid: false, validationError: "no_main_branch", defaultBranch: "master" } as ImportResult,
      t,
    );

    expect(t.mock.calls).toEqual([["step_sync.error_no_main_branch", { branch: "master" }]]);
  });

  it.each([
    [{ validationError: "no_main_branch", mainBranch: "absent" }, ["step_sync.error_no_main_branch", { branch: "master" }]],
    [{ validationError: "no_main_branch", mainBranch: "site" }, ["step_sync.error_main_beside_default", { branch: "master" }]],
    [{ validationError: "no_main_branch", mainBranch: "not_site" }, ["step_sync.error_main_not_site", { branch: "master" }]],
    [{ validationError: "main_unreadable" }, ["step_sync.error_main_unreadable"]],
    [{ validationError: "rename_pending" }, ["step_sync.error_rename_pending"]],
    [{ validationError: "branch_admin_required" }, ["step_sync.error_branch_admin_required"]],
  ])("says which case %o is", (refusal, call) => {
    const t = vi.fn((k: string, o?: Record<string, unknown>) => `${k} ${JSON.stringify(o ?? {})}`);

    validationErrorMessage({ ...IMPORTED, valid: false, defaultBranch: "master", ...refusal } as ImportResult, t);

    expect(t.mock.calls).toEqual([call]);
  });
});
