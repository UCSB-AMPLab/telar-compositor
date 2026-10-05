/**
 * Pins the settings-page heal for a stranded google_sheets_enabled flag.
 *
 * The D1 flag can drift from the repo's _config.yml: a disable written to D1
 * directly was clobbered back by a warm collaboration Y.Doc still holding the
 * old `true` (the DO is the sole reconciling writer for config columns). Once
 * the repo reads `enabled: false`, no later push re-fires the disable, so the
 * stale `true`, and the settings-page warning it drives, persists.
 *
 * reconcileSheetsFlagFromRepo is the read-side heal: only when D1 claims
 * Sheets is enabled does it consult the live _config.yml, and only on
 * affirmative repo evidence (fetched content that parses as disabled) does it
 * repair the flag, through the document so that nothing is reset.
 * Fetch failures fail open to the D1 value.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/lib/github.server", () => ({
  getFileContent: vi.fn(),
}));
vi.mock("~/lib/config-repair.server", () => ({
  repairSiteConfig: vi.fn(async () => "applied"),
}));

import { reconcileSheetsFlagFromRepo } from "~/lib/sheets-reconcile.server";
import { getFileContent } from "~/lib/github.server";
import { repairSiteConfig } from "~/lib/config-repair.server";

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

/** A database the heal must not touch itself: the repair owns every write. */
function untouchedDb() {
  const update = vi.fn();
  return { db: { update } as never, update };
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
  it("D1 disabled: returns false without touching GitHub or the config", async () => {
    const { db, update } = untouchedDb();
    const result = await reconcileSheetsFlagFromRepo(db, env, {
      ...opts,
      d1Enabled: false,
    });
    expect(result).toBe(false);
    expect(getFileContent).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(repairSiteConfig).not.toHaveBeenCalled();
  });

  it("D1 enabled but repo disabled (the stranded case): repairs the flag through the document, returns false", async () => {
    vi.mocked(getFileContent).mockResolvedValue(CONFIG_DISABLED);
    const { db, update } = untouchedDb();

    const result = await reconcileSheetsFlagFromRepo(db, env, {
      ...opts,
      d1Enabled: true,
    });

    expect(result).toBe(false);
    expect(getFileContent).toHaveBeenCalledWith(
      "user-token", "owner", "repo", "_config.yml",
    );
    expect(repairSiteConfig).toHaveBeenCalledTimes(1);
    expect(repairSiteConfig).toHaveBeenCalledWith(db, env, 42, { google_sheets_enabled: false });
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps the repo truth it returns when the document does not confirm the repair", async () => {
    // The heal's displayable answer comes from the repo, not from whether the
    // repair landed; the next visit retries it.
    vi.mocked(getFileContent).mockResolvedValue(CONFIG_DISABLED);
    vi.mocked(repairSiteConfig).mockResolvedValue("uncertain");
    const { db } = untouchedDb();

    const result = await reconcileSheetsFlagFromRepo(db, env, { ...opts, d1Enabled: true });

    expect(result).toBe(false);
  });

  it("D1 enabled and repo enabled (consistent): no heal, returns true", async () => {
    vi.mocked(getFileContent).mockResolvedValue(CONFIG_ENABLED);
    const { db } = untouchedDb();

    const result = await reconcileSheetsFlagFromRepo(db, env, {
      ...opts,
      d1Enabled: true,
    });

    expect(result).toBe(true);
    expect(repairSiteConfig).not.toHaveBeenCalled();
  });

  it("config fetch returns null (missing file or non-ok): fails open to the D1 value, no heal", async () => {
    vi.mocked(getFileContent).mockResolvedValue(null);
    const { db } = untouchedDb();

    const result = await reconcileSheetsFlagFromRepo(db, env, {
      ...opts,
      d1Enabled: true,
    });

    expect(result).toBe(true);
    expect(repairSiteConfig).not.toHaveBeenCalled();
  });

  it("config fetch throws (network failure): fails open to the D1 value, no heal", async () => {
    vi.mocked(getFileContent).mockRejectedValue(new Error("fetch failed"));
    const { db } = untouchedDb();

    const result = await reconcileSheetsFlagFromRepo(db, env, {
      ...opts,
      d1Enabled: true,
    });

    expect(result).toBe(true);
    expect(repairSiteConfig).not.toHaveBeenCalled();
  });
});
