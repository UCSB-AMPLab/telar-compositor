/**
 * This file tests `app/lib/onboarding-create-site.server.ts` — the
 * create-site intent plumbing for the post-create `_config.yml` language
 * patch that pins the new site's locale to the user's choice.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the create-site primitives so we can pin call sequencing without
// going near GitHub.
vi.mock("~/lib/create-site.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/create-site.server")>();
  return {
    ...actual,
    createSiteFromTemplate: vi.fn(),
    waitForRepoReady: vi.fn(),
    patchSiteConfigLanguage: vi.fn(),
  };
});

// getInstallationToken is unused by the create-site branch; safe to leave un-mocked.

import { handleCreateSiteIntents } from "~/lib/onboarding-create-site.server";
import {
  createSiteFromTemplate,
  waitForRepoReady,
  patchSiteConfigLanguage,
  GitHubError,
} from "~/lib/create-site.server";

const TOKEN = "test-token-abc";
// Minimal Env stub — the create-site branch never touches env, but the
// signature requires one.
const ENV = {} as Env;

function makeFormData(name: string, owner: string): FormData {
  const fd = new FormData();
  fd.set("owner", owner);
  fd.set("name", name);
  return fd;
}

describe("handleCreateSiteIntents — create-site language patch plumbing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (createSiteFromTemplate as ReturnType<typeof vi.fn>).mockResolvedValue({
      repoUrl: "https://github.com/me/my-site",
      defaultBranch: "main",
    });
    (waitForRepoReady as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it("Test 8 (langPatchFailed plumbing): patch throws → ok:true with langPatchFailed:true", async () => {
    (patchSiteConfigLanguage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new GitHubError("PUT 409", 409),
    );

    const result = await handleCreateSiteIntents(
      "create-site",
      makeFormData("my-site", "me"),
      TOKEN,
      ENV,
      "es",
    );

    expect(result).toMatchObject({
      ok: true,
      intent: "create-site",
      repoUrl: "https://github.com/me/my-site",
      defaultBranch: "main",
      owner: "me",
      name: "my-site",
      langPatchFailed: true,
    });
    expect(patchSiteConfigLanguage).toHaveBeenCalledTimes(1);
    expect(patchSiteConfigLanguage).toHaveBeenCalledWith(TOKEN, "me", "my-site", "es");
  });

  it("Test 9 (no patch on en): patch helper not called; langPatchFailed absent/false", async () => {
    const result = await handleCreateSiteIntents(
      "create-site",
      makeFormData("my-site", "me"),
      TOKEN,
      ENV,
      "en",
    );

    expect(result).toMatchObject({ ok: true, intent: "create-site" });
    expect((result as { langPatchFailed?: boolean }).langPatchFailed).toBeFalsy();
    expect(patchSiteConfigLanguage).not.toHaveBeenCalled();
  });

  it("Test 9b (no patch on null locale): patch helper not called; langPatchFailed absent/false", async () => {
    const result = await handleCreateSiteIntents(
      "create-site",
      makeFormData("my-site", "me"),
      TOKEN,
      ENV,
      null,
    );

    expect(result).toMatchObject({ ok: true, intent: "create-site" });
    expect((result as { langPatchFailed?: boolean }).langPatchFailed).toBeFalsy();
    expect(patchSiteConfigLanguage).not.toHaveBeenCalled();
  });

  it("Test 10 (happy path on es): patch succeeds, langPatchFailed absent/false", async () => {
    (patchSiteConfigLanguage as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    const result = await handleCreateSiteIntents(
      "create-site",
      makeFormData("my-site", "me"),
      TOKEN,
      ENV,
      "es",
    );

    expect(result).toMatchObject({ ok: true, intent: "create-site" });
    expect((result as { langPatchFailed?: boolean }).langPatchFailed).toBeFalsy();
    expect(patchSiteConfigLanguage).toHaveBeenCalledTimes(1);
  });
});
