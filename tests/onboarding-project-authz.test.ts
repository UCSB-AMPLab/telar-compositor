/**
 * Tests for the onboarding action's project-scoped intents — convenor-only
 * guards on every branch that reads a `project_id` out of the submitted form.
 *
 * `save_config`, `check-site-config`, `fix-site-config` and
 * `complete-onboarding` each take the target project straight from the form,
 * and between them they rewrite that project's title, lang, theme, url and
 * baseurl — url/baseurl being the published site's address. A signed-in
 * caller substituting a project id they have no standing on must be refused.
 *
 * The standing is convenor, not membership: `importRepo` inserts the
 * importing user's `project_members` row with role `convenor` at the moment
 * the project row is created, so a user legitimately mid-onboarding is always
 * the convenor of the project the wizard is acting on. A collaborator, an
 * instructor and a non-member therefore have no legitimate business on any of
 * these intents, and are refused with the same payload a project that does not
 * exist would produce, so no refusal reports whether a project id is real.
 *
 * Mocking strategy mirrors `tests/onboarding-unlink-authz.test.ts`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (hoisted above imports by vi.mock)
// ---------------------------------------------------------------------------

type DbMock = ReturnType<typeof makeDbMock>;

/**
 * `existingRow` is the project row an id lookup finds — a row for a project
 * that exists, `undefined` for one that does not. Every write the action
 * issues is recorded on `updates` / `deletes` so a refusal can be asserted to
 * have left D1 untouched.
 */
function makeDbMock(existingRow: Record<string, unknown> | undefined) {
  const updates: unknown[] = [];
  const deletes: unknown[] = [];
  return {
    updates,
    deletes,
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() =>
          Object.assign(
            Promise.resolve(existingRow ? [existingRow] : ([] as unknown[])),
            { get: vi.fn(async () => existingRow) },
          ),
        ),
      })),
    })),
    update: vi.fn((table: unknown) => {
      updates.push(table);
      return { set: vi.fn(() => ({ where: vi.fn(async () => undefined) })) };
    }),
    delete: vi.fn((table: unknown) => {
      deletes.push(table);
      return { where: vi.fn(async () => undefined) };
    }),
    batch: vi.fn(async () => []),
  };
}

let currentDb: DbMock;

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => currentDb),
}));

vi.mock("~/middleware/auth.server", () => ({
  authMiddleware: vi.fn(),
  userContext: Symbol("userContext"),
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined), set: vi.fn() })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));

vi.mock("~/lib/crypto.server", () => ({
  decrypt: vi.fn(async () => "user-token"),
}));

vi.mock("~/lib/membership.server", () => ({
  getUserRole: vi.fn(async () => null),
  requireOwner: vi.fn(async () => undefined),
  requireProjectMember: vi.fn(async () => undefined),
}));

vi.mock("~/lib/config-repair.server", () => ({
  repairSiteConfig: vi.fn(async () => "applied"),
}));

vi.mock("~/lib/github.server", () => ({
  listUserInstallations: vi.fn(),
  listInstallationRepos: vi.fn(),
  getFileContent: vi.fn(async () => "title: Site\nurl: \"https://x.github.io\"\n"),
}));

vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "sha-new" })),
  disableGoogleSheetsInConfig: vi.fn((c: string) => c),
  SheetsNotDisableableError: class SheetsNotDisableableError extends Error {},
  verifySiteUrl: vi.fn(async () => ({
    pagesEnabled: true,
    match: true,
    pagesUrl: "https://owner.github.io/repo/",
    configUrl: "https://owner.github.io/repo",
  })),
  enableGitHubPages: vi.fn(async () => ({ pagesUrl: "https://owner.github.io/repo/" })),
  isGoogleSheetsEnabled: vi.fn(() => false),
}));

vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "install-token"),
}));

vi.mock("~/lib/import.server", () => ({ importRepo: vi.fn() }));
vi.mock("~/lib/upgrade.server", () => ({ checkTelarVersion: vi.fn() }));
// Completion reads the site's version to decide whether to hand over to its
// upgrade (tests/onboarding-upgrade-handoff.test.ts covers that). Here every
// site reads as current, because what is under test is who may complete.
vi.mock("~/lib/upgrade-gate.server", () => ({ siteNeedsUpgrade: vi.fn(async () => false) }));
vi.mock("~/lib/onboarding-create-site.server", () => ({
  handleCreateSiteIntents: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

import { action } from "~/routes/onboarding";
import { getUserRole } from "~/lib/membership.server";
import { repairSiteConfig } from "~/lib/config-repair.server";
import { verifySiteUrl, disableGoogleSheetsInConfig, SheetsNotDisableableError } from "~/lib/commit.server";
import { commitFilesToRepo, enableGitHubPages } from "~/lib/commit.server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A project that exists in D1, convened by OWNER_ID. */
const EXISTING_PROJECT_ID = 42;
/** A project id with no row in D1 at all. */
const ABSENT_PROJECT_ID = 4242;

const OWNER_ID = 7;
const INTRUDER_ID = 99;

const PROJECT_ROW = {
  id: EXISTING_PROJECT_ID,
  github_repo_full_name: "owner/repo",
  installation_id: 11,
  origin: "imported",
};

function buildRequest(formFields: Record<string, string>): Request {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(formFields)) {
    form.set(key, value);
  }
  return new Request("https://compositor.telar.org/onboarding", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function buildContext(userId: number) {
  const env = {
    ENCRYPTION_KEY: "key",
    SESSION_SECRET: "sess-secret",
    GITHUB_APP_ID: "app-id",
    GITHUB_PRIVATE_KEY: "pk",
    DB: {},
  };
  return {
    get: vi.fn(() => ({ id: userId, encrypted_access_token: "enc-token" })),
    cloudflare: { env },
  } as unknown as Parameters<typeof action>[0]["context"];
}

function post(
  userId: number,
  fields: Record<string, string>,
  { exists = true }: { exists?: boolean } = {},
) {
  currentDb = makeDbMock(exists ? PROJECT_ROW : undefined);
  return action({
    request: buildRequest(fields),
    context: buildContext(userId),
    params: {},
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  currentDb = makeDbMock(PROJECT_ROW);
});

// ---------------------------------------------------------------------------
// The ungated write intents
// ---------------------------------------------------------------------------

/**
 * Each entry is one form-taking intent, the form it is submitted with, and
 * the payload every refused caller must receive.
 */
const GATED_INTENTS: Array<{
  name: string;
  fields: Record<string, string>;
  refusal: unknown;
}> = [
  {
    name: "save_config",
    fields: {
      intent: "save_config",
      project_id: String(EXISTING_PROJECT_ID),
      title: "Hijacked",
      lang: "es",
      theme: "dark",
      url: "https://attacker.example",
      baseurl: "/pwned",
    },
    refusal: { saved: false, error: "not_found" },
  },
  {
    name: "fix-site-config",
    fields: {
      intent: "fix-site-config",
      project_id: String(EXISTING_PROJECT_ID),
      fixSheets: "true",
      fixUrl: "true",
      pagesUrl: "https://attacker.example/x/",
    },
    refusal: { ok: false, intent: "fix-site-config", error: "not_found" },
  },
  {
    name: "complete-onboarding",
    fields: {
      intent: "complete-onboarding",
      project_id: String(EXISTING_PROJECT_ID),
    },
    refusal: { ok: false, intent: "complete-onboarding", error: "not_found" },
  },
  {
    name: "check-site-config",
    fields: {
      intent: "check-site-config",
      project_id: String(EXISTING_PROJECT_ID),
    },
    refusal: {
      ok: true,
      intent: "check-site-config",
      sheetsEnabled: false,
      urlMismatch: null,
    },
  },
];

describe("onboarding action: project-scoped intents are convenor-only", () => {
  for (const { name, fields, refusal } of GATED_INTENTS) {
    describe(name, () => {
      it("refuses a non-member and writes nothing to D1", async () => {
        vi.mocked(getUserRole).mockResolvedValue(null);

        const result = await post(INTRUDER_ID, fields);

        expect(result).toEqual(refusal);
        expect(currentDb.updates).toEqual([]);
        expect(currentDb.deletes).toEqual([]);
      });

      it("refuses a collaborator and writes nothing to D1", async () => {
        vi.mocked(getUserRole).mockResolvedValue("collaborator");

        const result = await post(INTRUDER_ID, fields);

        expect(result).toEqual(refusal);
        expect(currentDb.updates).toEqual([]);
        expect(currentDb.deletes).toEqual([]);
      });

      it("refuses an instructor and writes nothing to D1", async () => {
        vi.mocked(getUserRole).mockResolvedValue("instructor");

        const result = await post(INTRUDER_ID, fields);

        expect(result).toEqual(refusal);
        expect(currentDb.updates).toEqual([]);
        expect(currentDb.deletes).toEqual([]);
      });

      it("checks the caller's role on the project id from the form", async () => {
        vi.mocked(getUserRole).mockResolvedValue(null);

        await post(INTRUDER_ID, fields);

        expect(vi.mocked(getUserRole)).toHaveBeenCalledWith(
          currentDb,
          EXISTING_PROJECT_ID,
          INTRUDER_ID,
        );
      });

      it("gives a non-member of a real project the same refusal as an absent project", async () => {
        vi.mocked(getUserRole).mockResolvedValue(null);
        const foreign = await post(INTRUDER_ID, fields);

        vi.mocked(getUserRole).mockResolvedValue(null);
        const absent = await post(
          INTRUDER_ID,
          { ...fields, project_id: String(ABSENT_PROJECT_ID) },
          { exists: false },
        );

        expect(foreign).toEqual(absent);
        expect(currentDb.updates).toEqual([]);
      });

      it("refuses a missing or non-numeric project_id before touching the db", async () => {
        for (const bad of ["", "abc", "0", "-1"]) {
          vi.mocked(getUserRole).mockResolvedValue("convenor");

          const result = await post(
            OWNER_ID,
            { ...fields, project_id: bad },
            { exists: false },
          );

          expect(result).toEqual(refusal);
          expect(vi.mocked(getUserRole)).not.toHaveBeenCalled();
          expect(currentDb.updates).toEqual([]);
          // No read either. A garbage id must be refused on its shape, before
          // any query — including the project lookup the read-only intents
          // would otherwise issue, which is the only thing that distinguishes
          // a gated `check-site-config` from an ungated one on this input.
          expect(currentDb.select).not.toHaveBeenCalled();
          vi.clearAllMocks();
        }
      });
    });
  }
});

// ---------------------------------------------------------------------------
// The legitimate flow — the convenor must still get all the way through
// ---------------------------------------------------------------------------

describe("onboarding action: the convenor's flow is unbroken", () => {
  beforeEach(() => {
    vi.mocked(getUserRole).mockResolvedValue("convenor");
  });

  it("save_config writes the config and reports saved", async () => {
    const result = await post(OWNER_ID, {
      intent: "save_config",
      project_id: String(EXISTING_PROJECT_ID),
      title: "My Site",
      lang: "es",
      theme: "sepia",
      url: "https://owner.github.io",
      baseurl: "/repo",
    });

    expect(result).toEqual({ saved: true });
    expect(currentDb.updates.length).toBe(1);
  });

  it("check-site-config reports on the real repo", async () => {
    const result = (await post(OWNER_ID, {
      intent: "check-site-config",
      project_id: String(EXISTING_PROJECT_ID),
    })) as { ok: boolean; intent: string; pagesNotEnabled?: boolean };

    expect(result.ok).toBe(true);
    expect(result.intent).toBe("check-site-config");
    // The full-check shape carries pagesNotEnabled; the refusal shape does not.
    expect(result.pagesNotEnabled).toBe(false);
  });

  it("check-site-config answers unreachable, not Pages off, when the Pages read failed", async () => {
    vi.mocked(verifySiteUrl).mockResolvedValueOnce({
      pagesEnabled: false,
      match: false,
      pagesUrl: "",
      configUrl: "https://owner.github.io/repo",
      readFailed: true,
    });

    const result = await post(OWNER_ID, {
      intent: "check-site-config",
      project_id: String(EXISTING_PROJECT_ID),
    });

    expect(result).toEqual({ ok: false, reason: "unreachable", intent: "check-site-config" });
  });

  it("check-site-config does not report Pages as off when the Pages read was refused", async () => {
    vi.mocked(verifySiteUrl).mockResolvedValueOnce({ pagesEnabled: false, match: false, pagesUrl: "", configUrl: "x", readRefused: true });

    const result = await post(OWNER_ID, { intent: "check-site-config", project_id: String(EXISTING_PROJECT_ID) });

    expect(result).toMatchObject({ ok: true, pagesNotEnabled: false, urlMismatch: null });
  });

  it("check-site-config still reports Pages as off when GitHub says it is not enabled (404)", async () => {
    vi.mocked(verifySiteUrl).mockResolvedValueOnce({ pagesEnabled: false, match: false, pagesUrl: "", configUrl: "x" });

    const result = await post(OWNER_ID, { intent: "check-site-config", project_id: String(EXISTING_PROJECT_ID) });

    expect(result).toMatchObject({ ok: true, pagesNotEnabled: true });
  });

  it("fix-site-config refuses, committing nothing, when Sheets cannot be turned off", async () => {
    vi.mocked(commitFilesToRepo).mockClear();
    vi.mocked(disableGoogleSheetsInConfig).mockImplementationOnce(() => {
      throw new SheetsNotDisableableError();
    });

    const result = await post(OWNER_ID, {
      intent: "fix-site-config",
      project_id: String(EXISTING_PROJECT_ID),
      fixSheets: "true",
    });

    expect(result).toEqual({ ok: false, intent: "fix-site-config", error: "sheets_not_disableable" });
    expect(vi.mocked(commitFilesToRepo)).not.toHaveBeenCalled();
  });

  it("fix-site-config leaves Pages as it was when Sheets cannot be turned off", async () => {
    vi.mocked(enableGitHubPages).mockClear();
    vi.mocked(disableGoogleSheetsInConfig).mockImplementationOnce(() => {
      throw new SheetsNotDisableableError();
    });

    const result = await post(OWNER_ID, {
      intent: "fix-site-config",
      project_id: String(EXISTING_PROJECT_ID),
      fixSheets: "true",
      enablePages: "true",
    });

    expect(result).toEqual({ ok: false, intent: "fix-site-config", error: "sheets_not_disableable" });
    expect(vi.mocked(enableGitHubPages)).not.toHaveBeenCalled();
  });

  it("fix-site-config repairs the repo, then the config through the document", async () => {
    const result = await post(OWNER_ID, {
      intent: "fix-site-config",
      project_id: String(EXISTING_PROJECT_ID),
      fixSheets: "true",
      fixUrl: "true",
      pagesUrl: "https://owner.github.io/repo/",
    });

    expect(result).toEqual({ ok: true, intent: "fix-site-config" });
    expect(vi.mocked(repairSiteConfig)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(repairSiteConfig)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      EXISTING_PROJECT_ID,
      { google_sheets_enabled: false, url: "https://owner.github.io", baseurl: "/repo" },
    );
    expect(vi.mocked(commitFilesToRepo).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(repairSiteConfig).mock.invocationCallOrder[0],
    );
  });

  it("fix-site-config advances objects_read_sha with its head write only where the record is the head it replaces", async () => {
    await post(OWNER_ID, {
      intent: "fix-site-config",
      project_id: String(EXISTING_PROJECT_ID),
      fixSheets: "true",
    });

    const write = currentDb.update.mock.results[0].value as { set: ReturnType<typeof vi.fn> };
    const payload = write.set.mock.calls[0][0] as Record<string, unknown>;
    const { SQLiteSyncDialect } = await import("drizzle-orm/sqlite-core");
    const rendered = new SQLiteSyncDialect().sqlToQuery(payload.objects_read_sha as never);
    expect(rendered.sql).toBe(
      'CASE WHEN "projects"."objects_read_sha" = "projects"."head_sha" THEN ? ELSE "projects"."objects_read_sha" END',
    );
    expect(rendered.params).toEqual([payload.head_sha]);
  });

  it("complete-onboarding marks the project complete and sets the session cookie", async () => {
    const result = (await post(OWNER_ID, {
      intent: "complete-onboarding",
      project_id: String(EXISTING_PROJECT_ID),
    })) as Response;

    expect(result).toBeInstanceOf(Response);
    expect(result.headers.get("Set-Cookie")).toBe("cookie");
    expect(await result.json()).toEqual({
      ok: true,
      intent: "complete-onboarding",
    });
    expect(currentDb.updates.length).toBe(1);
  });

  it("runs the whole wizard tail in order: save -> check -> fix -> complete", async () => {
    const steps: unknown[] = [];

    steps.push(
      await post(OWNER_ID, {
        intent: "save_config",
        project_id: String(EXISTING_PROJECT_ID),
        title: "My Site",
        lang: "en",
      }),
    );
    const check = (await post(OWNER_ID, {
      intent: "check-site-config",
      project_id: String(EXISTING_PROJECT_ID),
    })) as { ok: boolean };
    steps.push(check);
    steps.push(
      await post(OWNER_ID, {
        intent: "fix-site-config",
        project_id: String(EXISTING_PROJECT_ID),
        fixUrl: "true",
        pagesUrl: "https://owner.github.io/repo/",
      }),
    );
    const done = (await post(OWNER_ID, {
      intent: "complete-onboarding",
      project_id: String(EXISTING_PROJECT_ID),
    })) as Response;

    expect(steps[0]).toEqual({ saved: true });
    expect((steps[1] as { ok: boolean }).ok).toBe(true);
    expect(steps[2]).toEqual({ ok: true, intent: "fix-site-config" });
    expect(done.status).toBe(200);
  });
});

describe("fix-site-config keeps its own result whatever the repair answers", () => {
  // The repository commit has landed; the repair is best-effort and writes D1
  // itself when the document does not confirm it, so its answer must not
  // reach the caller.
  it.each([["applied"], ["refused"], ["uncertain"]])("returns ok when the repair is %s", async (answer) => {
    vi.mocked(getUserRole).mockResolvedValue("convenor");
    vi.mocked(repairSiteConfig).mockResolvedValue(answer as never);

    const result = await post(OWNER_ID, {
      intent: "fix-site-config",
      project_id: String(EXISTING_PROJECT_ID),
      fixSheets: "true",
    });

    expect(result).toEqual({ ok: true, intent: "fix-site-config" });
    expect(vi.mocked(repairSiteConfig)).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      EXISTING_PROJECT_ID,
      { google_sheets_enabled: false },
    );
  });

  it("repairs nothing when it fixed nothing", async () => {
    vi.mocked(getUserRole).mockResolvedValue("convenor");
    const result = await post(OWNER_ID, {
      intent: "fix-site-config",
      project_id: String(EXISTING_PROJECT_ID),
    });
    expect(result).toEqual({ ok: true, intent: "fix-site-config" });
    expect(vi.mocked(repairSiteConfig)).not.toHaveBeenCalled();
  });

  it("repairs nothing when the commit fails", async () => {
    vi.mocked(getUserRole).mockResolvedValue("convenor");
    vi.mocked(commitFilesToRepo).mockRejectedValueOnce(new Error("GitHub GraphQL error: 502"));
    await post(OWNER_ID, {
      intent: "fix-site-config",
      project_id: String(EXISTING_PROJECT_ID),
      fixSheets: "true",
      fixUrl: "true",
      pagesUrl: "https://owner.github.io/repo/",
    }).catch(() => undefined);
    expect(vi.mocked(repairSiteConfig)).not.toHaveBeenCalled();
  });
});
