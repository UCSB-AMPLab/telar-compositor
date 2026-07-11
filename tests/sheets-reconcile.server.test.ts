/**
 * Pins the settings-page heal for a stranded google_sheets_enabled flag.
 *
 * The D1 flag can drift from the repo's _config.yml: the objects-commit
 * disable path wrote D1 directly, and a warm collaboration Y.Doc still
 * holding the old `true` clobbered the write back on its next snapshot
 * (the DO is the sole reconciling writer for config columns). Once the
 * repo reads `enabled: false`, no later push re-fires the disable, so the
 * stale D1 `true` — and the settings-page warning it drives — persists
 * indefinitely.
 *
 * reconcileSheetsFlagFromRepo is the read-side heal: only when D1 claims
 * Sheets is enabled does it consult the live _config.yml, and only on
 * affirmative repo evidence (fetched content that parses as disabled) does
 * it repair D1 AND reset the collab doc so the repair cannot be clobbered
 * again. Fetch failures fail open to the D1 value.
 *
 * @version v1.4.3-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/github.server", () => ({
  getFileContent: vi.fn(),
}));
vi.mock("~/lib/collab-reset.server", () => ({
  resetCollabDocIfBlobExists: vi.fn(async () => {}),
}));

import { reconcileSheetsFlagFromRepo } from "~/lib/sheets-reconcile.server";
import { getFileContent } from "~/lib/github.server";
import { resetCollabDocIfBlobExists } from "~/lib/collab-reset.server";

const CONFIG_DISABLED = `title: Site
google_sheets:
  enabled: false
  published_url: "https://docs.google.com/x/pubhtml"
`;

const CONFIG_ENABLED = `title: Site
google_sheets:
  enabled: true
  published_url: "https://docs.google.com/x/pubhtml"
`;

function makeDbMock() {
  const where = vi.fn().mockResolvedValue({});
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { db: { update } as never, update, set, where };
}

const env = {} as never;
const opts = {
  token: "user-token",
  owner: "owner",
  repo: "repo",
  projectId: 42,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reconcileSheetsFlagFromRepo", () => {
  it("D1 disabled: returns false without touching GitHub or D1", async () => {
    const { db, update } = makeDbMock();
    const result = await reconcileSheetsFlagFromRepo(db, env, {
      ...opts,
      d1Enabled: false,
    });
    expect(result).toBe(false);
    expect(getFileContent).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(resetCollabDocIfBlobExists).not.toHaveBeenCalled();
  });

  it("D1 enabled but repo disabled (the stranded case): heals D1, resets the collab doc, returns false", async () => {
    vi.mocked(getFileContent).mockResolvedValue(CONFIG_DISABLED);
    const { db, update, set } = makeDbMock();

    const result = await reconcileSheetsFlagFromRepo(db, env, {
      ...opts,
      d1Enabled: true,
    });

    expect(result).toBe(false);
    expect(getFileContent).toHaveBeenCalledWith(
      "user-token", "owner", "repo", "_config.yml",
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ google_sheets_enabled: false }),
    );
    expect(resetCollabDocIfBlobExists).toHaveBeenCalledWith(db, env, 42);
  });

  it("D1 enabled and repo enabled (consistent): no heal, returns true", async () => {
    vi.mocked(getFileContent).mockResolvedValue(CONFIG_ENABLED);
    const { db, update } = makeDbMock();

    const result = await reconcileSheetsFlagFromRepo(db, env, {
      ...opts,
      d1Enabled: true,
    });

    expect(result).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(resetCollabDocIfBlobExists).not.toHaveBeenCalled();
  });

  it("config fetch returns null (missing file or non-ok): fails open to the D1 value, no heal", async () => {
    vi.mocked(getFileContent).mockResolvedValue(null);
    const { db, update } = makeDbMock();

    const result = await reconcileSheetsFlagFromRepo(db, env, {
      ...opts,
      d1Enabled: true,
    });

    expect(result).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(resetCollabDocIfBlobExists).not.toHaveBeenCalled();
  });

  it("config fetch throws (network failure): fails open to the D1 value, no heal", async () => {
    vi.mocked(getFileContent).mockRejectedValue(new Error("fetch failed"));
    const { db, update } = makeDbMock();

    const result = await reconcileSheetsFlagFromRepo(db, env, {
      ...opts,
      d1Enabled: true,
    });

    expect(result).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(resetCollabDocIfBlobExists).not.toHaveBeenCalled();
  });

  it("heal write throws: fails open (returns the repo truth for display) without propagating", async () => {
    vi.mocked(getFileContent).mockResolvedValue(CONFIG_DISABLED);
    const where = vi.fn().mockRejectedValue(new Error("D1 unavailable"));
    const set = vi.fn(() => ({ where }));
    const db = { update: vi.fn(() => ({ set })) } as never;

    const result = await reconcileSheetsFlagFromRepo(db, env, {
      ...opts,
      d1Enabled: true,
    });

    // Repo affirmatively says disabled — display that truth even if the
    // D1 repair failed; the next visit retries the heal.
    expect(result).toBe(false);
  });
});
