/**
 * The onboarding action's import with the column picker: a Google
 * Sheets tab whose colliding columns each hold values comes back as the group
 * to choose in, and the same import posted again with the choice reads the tab
 * with only the chosen column, committing nothing.
 *
 * The action and the repair run for real; the import itself, the published
 * Sheet and GitHub are faked.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const tabs = vi.hoisted(() => ({
  objects: "object_id,title,medium,object_type\nobj-001,First,Oil,Painting\n",
  /** The tab as the import fetches it again, where it changed after the author chose; else as asked about. */
  refetched: null as string | null,
}));

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn(() => ({})) }));
vi.mock("~/middleware/auth.server", () => ({ authMiddleware: vi.fn(), userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => undefined), set: vi.fn() })),
    commitSession: vi.fn(async () => "cookie"),
  })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/commit.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/commit.server")>("~/lib/commit.server");
  return { ...actual, commitFilesToRepo: vi.fn() };
});
vi.mock("~/lib/github-app.server", () => ({ getInstallationToken: vi.fn(async () => "install-token") }));
vi.mock("~/lib/onboarding-create-site.server", () => ({
  handleCreateSiteIntents: vi.fn(),
  importScopeRefusal: vi.fn(async () => null),
}));
vi.mock("~/lib/sheets.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/sheets.server")>("~/lib/sheets.server");
  return {
    ...actual,
    discoverSheetTabs: vi.fn(async () => [{ name: "objects", gid: "0" }]),
    fetchSheetCsv: vi.fn(async () => tabs.objects),
  };
});
vi.mock("~/lib/import.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/import.server")>();
  return { ...actual, importRepo: vi.fn() };
});
vi.mock("~/lib/join-codes.server", () => ({ redeemForSite: vi.fn() }));
vi.mock("~/lib/course-membership.server", () => ({ applyRedemptionSideEffects: vi.fn() }));

import { action } from "~/routes/onboarding";
import { CollidingColumnsRefusal, TabsChangedError, importRepo, refusedImportResult, type ImportResult } from "~/lib/import.server";
import { commitFilesToRepo } from "~/lib/commit.server";

const SHEET_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-TEST/pubhtml";
const IMPORTED = { ...refusedImportResult({}), valid: true, projectId: 7 } as ImportResult;

function postImport(fields: Record<string, string> = {}) {
  return action({
    request: new Request("https://compositor.telar.org/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ intent: "import", installation_id: "11", repo_full_name: "owner/repo", ...fields }).toString(),
    }),
    context: {
      get: vi.fn(() => ({ id: 3, encrypted_access_token: "enc", course_access: false })),
      cloudflare: { env: { ENCRYPTION_KEY: "k", SESSION_SECRET: "s", DB: {} } },
    } as never,
    params: {},
  } as never) as Promise<ImportResult>;
}

/** The import as it reads the published Sheet: through `readTab`, refusing the tab as it reads it. */
function importReadingTabs() {
  vi.mocked(importRepo).mockImplementation(async (params) => {
    // A refusal out of the read names the published Sheet, as importRepo's own Sheets branch does.
    const tabText = await (params.readTab ?? (async (_name: string, text: string) => text))("objects", tabs.refetched ?? tabs.objects)
      .catch((err: Error) => Promise.reject(Object.assign(err, { publishedSheetsUrl: SHEET_URL })));
    if (tabText.includes("medium")) {
      throw Object.assign(new CollidingColumnsRefusal("objects", "medium_genre", ["medium", "object_type"]), { publishedSheetsUrl: SHEET_URL });
    }
    return IMPORTED;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tabs.refetched = null;
  importReadingTabs();
});

describe("onboarding action — a Google Sheets import with columns read as one field", () => {
  it("offers the tab's group, then imports with the chosen column and commits nothing", async () => {
    const asked = await postImport();
    expect(asked.validationError).toBe("needs_choices");
    expect(asked.sheetChoices?.source).toBe("tabs");

    const choices = JSON.stringify([{ file: "objects", positions: [2, 3], keep: 3 }]);
    const result = await postImport({ sheet_challenge: asked.sheetChoices?.challenge ?? "", sheet_choices: choices });
    expect(result.valid).toBe(true);
    const readTab = vi.mocked(importRepo).mock.calls.at(-1)?.[0].readTab;
    expect(await readTab?.("objects", tabs.objects)).toBe("object_id,title,object_type\nobj-001,First,Painting\n");
    expect(commitFilesToRepo).not.toHaveBeenCalled();
    // A chosen tab the Sheet no longer lists is refused as changed.
    const checkTabs = vi.mocked(importRepo).mock.calls.at(-1)?.[0].checkTabs;
    expect(() => checkTabs?.(["project"])).toThrow(TabsChangedError);
    expect(() => checkTabs?.(["objects"])).not.toThrow();
  });

  it("asks again, applying nothing, when the tab changed between the choice and the import's read", async () => {
    const asked = await postImport();
    const choices = JSON.stringify([{ file: "objects", positions: [2, 3], keep: 3 }]);
    // A value typed into the column the author chose to drop, after choosing.
    tabs.refetched = "object_id,title,medium,object_type\nobj-001,First,Oil,Painting\nobj-002,Second,Ink,\n";
    const result = await postImport({ sheet_challenge: asked.sheetChoices?.challenge ?? "", sheet_choices: choices });
    expect(result.valid).toBe(false);
    expect(result.validationError).toBe("needs_choices");
    expect(result.sheetChoices?.notice).toBe("sheets_changed");
  });
});
