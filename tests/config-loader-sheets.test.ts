/**
 * Pins the config-route loader's wiring of the stranded-sheets-flag heal.
 *
 * The settings page renders the Google Sheets warning from D1's
 * project_config.google_sheets_enabled, a cached copy of the repo's
 * google_sheets.enabled that can strand at true (see
 * sheets-reconcile.server.test.ts for the drift mechanics). The loader
 * must consult reconcileSheetsFlagFromRepo before rendering — and only
 * when D1 claims enabled, so the common already-disabled case costs no
 * GitHub read and no decrypt.
 *
 * @version v1.4.3-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: vi.fn(),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/github.server", () => ({
  getRepoTree: vi.fn(),
  getFileContent: vi.fn(),
  githubHeaders: vi.fn(() => ({})),
}));
vi.mock("~/lib/yaml.server", () => ({ parseYaml: vi.fn() }));
vi.mock("~/lib/sheets-reconcile.server", () => ({
  reconcileSheetsFlagFromRepo: vi.fn(),
}));
vi.mock("~/hooks/use-collaboration", () => ({ useCollaborationContext: vi.fn() }));
vi.mock("~/lib/yjs-helpers", () => ({ getYText: vi.fn() }));

import { loader } from "~/routes/_app.config";
import { getDb } from "~/lib/db.server";
import { decrypt } from "~/lib/crypto.server";
import { resolveActiveProjectFromRequest } from "~/lib/active-project.server";
import { reconcileSheetsFlagFromRepo } from "~/lib/sheets-reconcile.server";

function makeDbMock(configRow: Record<string, unknown> | null) {
  // Two loader queries share this chain: project_config ends in .limit(1),
  // project_themes awaits the where() result directly — so where() returns
  // a themes-resolving promise carrying a limit() that resolves the config.
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => {
        const themesPromise = Promise.resolve([]);
        return Object.assign(themesPromise, {
          limit: vi.fn().mockResolvedValue(configRow ? [configRow] : []),
        });
      }),
    })),
  }));
  return { select } as never;
}

function buildArgs() {
  const user = { id: 7, encrypted_access_token: "enc-token" };
  const env = { ENCRYPTION_KEY: "key", DB: {} };
  return {
    request: new Request("https://compositor.telar.org/config"),
    context: {
      get: vi.fn(() => user),
      cloudflare: { env },
    },
    params: {},
  } as never;
}

function withProject() {
  vi.mocked(resolveActiveProjectFromRequest).mockResolvedValue({
    project: { id: 42, github_repo_full_name: "owner/repo" },
    userRole: "convenor",
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(decrypt).mockResolvedValue("user-token");
  withProject();
});

describe("config loader sheets-flag reconciliation", () => {
  it("D1 flag true + reconcile says disabled: returns the healed value", async () => {
    vi.mocked(getDb).mockReturnValue(makeDbMock({ google_sheets_enabled: true }));
    vi.mocked(reconcileSheetsFlagFromRepo).mockResolvedValue(false);

    const res = (await loader(buildArgs())) as {
      config: { google_sheets_enabled: boolean } | null;
    };

    expect(res.config?.google_sheets_enabled).toBe(false);
    expect(reconcileSheetsFlagFromRepo).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        token: "user-token",
        owner: "owner",
        repo: "repo",
        projectId: 42,
        d1Enabled: true,
      },
    );
  });

  it("D1 flag true + reconcile confirms enabled: value stays true", async () => {
    vi.mocked(getDb).mockReturnValue(makeDbMock({ google_sheets_enabled: true }));
    vi.mocked(reconcileSheetsFlagFromRepo).mockResolvedValue(true);

    const res = (await loader(buildArgs())) as {
      config: { google_sheets_enabled: boolean } | null;
    };

    expect(res.config?.google_sheets_enabled).toBe(true);
  });

  it("D1 flag false: no reconcile call, no decrypt — the common case is free", async () => {
    vi.mocked(getDb).mockReturnValue(makeDbMock({ google_sheets_enabled: false }));

    const res = (await loader(buildArgs())) as {
      config: { google_sheets_enabled: boolean } | null;
    };

    expect(res.config?.google_sheets_enabled).toBe(false);
    expect(reconcileSheetsFlagFromRepo).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("decrypt throws: loader still resolves with the D1 value (no 500)", async () => {
    vi.mocked(getDb).mockReturnValue(makeDbMock({ google_sheets_enabled: true }));
    vi.mocked(decrypt).mockRejectedValue(new Error("GCM auth failed"));

    const res = (await loader(buildArgs())) as {
      config: { google_sheets_enabled: boolean } | null;
    };

    expect(res.config?.google_sheets_enabled).toBe(true);
    expect(reconcileSheetsFlagFromRepo).not.toHaveBeenCalled();
  });
});
