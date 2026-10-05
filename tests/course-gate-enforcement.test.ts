/**
 * This file pins what the course password actually covers: running a
 * course, never joining one (ruling 20).
 *
 * Three surfaces exist behind F1-a and F1-b. Creating a course project and
 * managing a course's join codes are running it, and are refused without
 * the password. Redeeming a class code is joining, and is the one flow that
 * reaches people who have never seen the app — so it is asserted to work
 * with no password at all, on a session that has answered nothing.
 *
 * The refusal is asserted on the server's own answer rather than on
 * anything the form rendered: the loader flag exists so the wizard knows
 * what to offer, and a submission that ignores it must still be refused.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — mirrors tests/onboarding-course-join.test.ts
// ---------------------------------------------------------------------------

const gate = vi.hoisted(() => ({ unlocked: false }));

function makeDbMock() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [
            { title: "History 101", github_repo_full_name: "teacher/hist-101" },
          ]),
          get: vi.fn(async () => ({ title: "History 101" })),
        })),
      })),
    })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) })),
    delete: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    batch: vi.fn(async () => []),
  };
}

let currentDb: ReturnType<typeof makeDbMock>;

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn(() => currentDb) }));

vi.mock("~/middleware/auth.server", () => ({
  authMiddleware: vi.fn(),
  userContext: Symbol("userContext"),
}));

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
  getUserProjects: vi.fn(async () => []),
  requireOwner: vi.fn(async () => undefined),
  requireProjectMember: vi.fn(async () => undefined),
  requireCourseCodeManager: vi.fn(async () => ({
    project: { id: 9, kind: "course" },
    role: "convenor",
  })),
}));

vi.mock("~/lib/config-repair.server", () => ({ repairSiteConfig: vi.fn(async () => "applied") }));

vi.mock("~/lib/github.server", () => ({
  listUserInstallations: vi.fn(),
  listInstallationRepos: vi.fn(),
  getFileContent: vi.fn(async () => "title: Site\n"),
  getRepoHead: vi.fn(),
  checkRepoAvailability: vi.fn(),
  searchUsers: vi.fn(),
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
  return {
    ...actual,
    importRepo: vi.fn(),
    deleteProjectCascade: vi.fn(),
    resolveLayerFileReferences: vi.fn(),
    mapStoryCsv: vi.fn(),
    scanRepoOrphanStoryIds: vi.fn(),
  };
});

vi.mock("~/lib/upgrade.server", () => ({
  checkTelarVersion: vi.fn(async () => ({ needsUpgrade: false })),
}));

vi.mock("~/lib/join-codes.server", () => ({
  redeemForSite: vi.fn(),
  createCode: vi.fn(async () => ({ token: "ABCDEF2345", id: 3 })),
  isLegacyInviteToken: vi.fn(() => true),
}));

vi.mock("~/lib/course-membership.server", () => ({
  applyRedemptionSideEffects: vi.fn(),
}));

vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: vi.fn(async () => ({
    project: { id: 5, kind: "site" },
    userRole: "convenor",
  })),
}));

vi.mock("~/lib/sync.server", () => ({
  checkRepairingLegacyIds: vi.fn(async (_env: unknown, _project: unknown, _user: unknown, run: () => Promise<unknown>) => run()),
  computeFullSyncDiff: vi.fn(),
  hasDivergentChanges: vi.fn(() => false),
  applyFullSync: vi.fn(),
}));

vi.mock("~/lib/activity.server", () => ({ logActivity: vi.fn() }));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

import { action as onboardingAction, loader as onboardingLoader } from "~/routes/onboarding";
import { action as dashboardAction } from "~/routes/_app.dashboard";
import { importRepo } from "~/lib/import.server";
import { redeemForSite } from "~/lib/join-codes.server";
import { applyRedemptionSideEffects } from "~/lib/course-membership.server";
import { createCode } from "~/lib/join-codes.server";
import { requireCourseCodeManager } from "~/lib/membership.server";

const USER_ID = 7;
const NEW_PROJECT_ID = 42;

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

const SIDE_EFFECTS = {
  staff: { inserted: 2, skipped: [] },
  preload: { inserted: 12, skippedAlreadyOurs: [], skippedConflict: [], skippedRepoBound: [] },
  enrolled: true,
};

function makeArgs(url: string, fields: Record<string, string>) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return {
    request: new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }),
    context: {
      get: vi.fn(() => ({ id: USER_ID, encrypted_access_token: "enc", course_access: gate.unlocked })),
      cloudflare: {
        env: { ENCRYPTION_KEY: "k", SESSION_SECRET: "s", DB: {} },
      },
    },
    params: {},
  } as never;
}

const postOnboarding = (fields: Record<string, string>) =>
  onboardingAction(makeArgs("https://compositor.telar.org/onboarding", fields));

const postDashboard = (fields: Record<string, string>) =>
  dashboardAction(makeArgs("https://compositor.telar.org/dashboard", fields));

function importFields(extra: Record<string, string> = {}) {
  return {
    intent: "import",
    installation_id: "1",
    repo_full_name: "student/group-a",
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  gate.unlocked = false;
  currentDb = makeDbMock();
  vi.mocked(importRepo).mockResolvedValue(IMPORTED as never);
  vi.mocked(applyRedemptionSideEffects).mockResolvedValue(SIDE_EFFECTS as never);
});

// ---------------------------------------------------------------------------
// Creating a course
// ---------------------------------------------------------------------------

describe("creating a course takes the password", () => {
  it("refuses a course with 403 and never reaches the importer", async () => {
    await expect(postOnboarding(importFields({ kind: "course" }))).rejects.toMatchObject({
      status: 403,
    });
    expect(importRepo).not.toHaveBeenCalled();
  });

  it("admits a course once the session has answered", async () => {
    gate.unlocked = true;
    await postOnboarding(importFields({ kind: "course" }));
    expect(vi.mocked(importRepo).mock.calls[0][0]).toMatchObject({ kind: "course" });
  });

  it("leaves creating an ordinary site untouched", async () => {
    await postOnboarding(importFields());
    expect(vi.mocked(importRepo).mock.calls[0][0]).toMatchObject({ kind: "site" });
  });
});

// ---------------------------------------------------------------------------
// Joining a course
// ---------------------------------------------------------------------------

describe("redeeming a class code takes no password", () => {
  beforeEach(() => {
    vi.mocked(redeemForSite).mockResolvedValue({
      state: "ok",
      courseProjectId: 9,
      inviteId: 3,
      alreadyAttached: false,
    } as never);
  });

  it("attaches the new site to its course on a locked session", async () => {
    const result = (await postOnboarding(
      importFields({ course_code: "ABCDEF2345" }),
    )) as { courseJoin: { state: string; courseProjectId: number } };

    expect(gate.unlocked).toBe(false);
    expect(redeemForSite).toHaveBeenCalledWith(currentDb, {
      token: "ABCDEF2345",
      childProjectId: NEW_PROJECT_ID,
      userId: USER_ID,
    });
    expect(result.courseJoin).toMatchObject({ state: "ok", courseProjectId: 9 });
  });

  it("runs the redemption's side effects on a locked session", async () => {
    await postOnboarding(importFields({ course_code: "ABCDEF2345" }));
    expect(applyRedemptionSideEffects).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Running a course
// ---------------------------------------------------------------------------

describe("a course's join codes take the password", () => {
  it("refuses create-code before it looks up standing", async () => {
    await expect(
      postDashboard({ intent: "create-code", projectId: "9", role: "collaborator" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(requireCourseCodeManager).not.toHaveBeenCalled();
    expect(createCode).not.toHaveBeenCalled();
  });

  it("issues a code once the session has answered", async () => {
    gate.unlocked = true;
    const result = (await postDashboard({
      intent: "create-code",
      projectId: "9",
      role: "collaborator",
    })) as { ok: boolean; code: string };
    expect(result.ok).toBe(true);
    expect(createCode).toHaveBeenCalled();
  });

  it("refuses revoke-code before it reads the code", async () => {
    await expect(
      postDashboard({ intent: "revoke-code", projectId: "9", inviteId: "3" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(requireCourseCodeManager).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// What the browser is told
// ---------------------------------------------------------------------------

describe("the onboarding loader reports access, and carries no secret to report", () => {
  function loaderArgs() {
    return {
      request: new Request("https://compositor.telar.org/onboarding?force=1"),
      context: {
        get: vi.fn(() => ({
          id: USER_ID,
          encrypted_access_token: "enc",
          github_id: 1,
          github_login: "student",
          github_name: "Student",
          github_email: "s@example.com",
          course_access: gate.unlocked,
        })),
        cloudflare: {
          env: {
            ENCRYPTION_KEY: "k",
            SESSION_SECRET: "s",
            DB: {},
            GITHUB_APP_SLUG: "app"
          },
        },
      },
      params: {},
    } as never;
  }

  beforeEach(() => {
    currentDb = {
      ...makeDbMock(),
      select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => []) })) })),
    } as never;
  });

  it("returns courseGateOpen false on a session that has not answered", async () => {
    const data = (await onboardingLoader(loaderArgs())) as Record<string, unknown>;
    expect(data.courseGateOpen).toBe(false);
    expect(JSON.stringify(data)).not.toContain("seminario");
  });

  it("returns courseGateOpen true once it has, and still no password", async () => {
    gate.unlocked = true;
    const data = (await onboardingLoader(loaderArgs())) as Record<string, unknown>;
    expect(data.courseGateOpen).toBe(true);
    expect(JSON.stringify(data)).not.toContain("seminario");
  });
});
