/**
 * This file tests `app/lib/onboarding-create-site.server.ts` — the
 * create-site intent plumbing that drives born-clean provisioning
 * (`commitBornCleanSite`) and maps its graded result onto the action
 * response (bornCleanOk / bornCleanError / langPatchFailed).
 *
 * @version v1.4.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the create-site primitives so we can pin call sequencing without
// going near GitHub. `...actual` keeps the pure helpers (humanizeSlug, error
// classes) real while stubbing the network-touching ones.
vi.mock("~/lib/create-site.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/create-site.server")>();
  return {
    ...actual,
    createSiteFromTemplate: vi.fn(),
    waitForRepoReady: vi.fn(),
    commitBornCleanSite: vi.fn(),
  };
});

vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(),
}));

import { handleCreateSiteIntents } from "~/lib/onboarding-create-site.server";
import {
  createSiteFromTemplate,
  waitForRepoReady,
  commitBornCleanSite,
} from "~/lib/create-site.server";
import { getInstallationToken } from "~/lib/github-app.server";

const TOKEN = "test-token-abc";
const INSTALL_TOKEN = "install-token-xyz";
const ENV = {
  GITHUB_APP_ID: "123",
  GITHUB_PRIVATE_KEY: "key",
} as unknown as Env;

function makeFormData(name: string, owner: string, installationId = 42): FormData {
  const fd = new FormData();
  fd.set("owner", owner);
  fd.set("name", name);
  fd.set("installation_id", String(installationId));
  return fd;
}

const commitMock = commitBornCleanSite as ReturnType<typeof vi.fn>;
const tokenMock = getInstallationToken as ReturnType<typeof vi.fn>;

describe("handleCreateSiteIntents — create-site born-clean plumbing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (createSiteFromTemplate as ReturnType<typeof vi.fn>).mockResolvedValue({
      repoUrl: "https://github.com/me/my-site",
      defaultBranch: "main",
    });
    (waitForRepoReady as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    tokenMock.mockResolvedValue(INSTALL_TOKEN);
  });

  it("happy path: born-clean succeeds → ok, bornCleanOk:true, pagesUrl, no lang warning", async () => {
    commitMock.mockResolvedValueOnce({ ok: true, pagesUrl: "https://me.github.io/my-site" });

    const result = await handleCreateSiteIntents(
      "create-site",
      makeFormData("my-site", "me"),
      TOKEN,
      ENV,
      "en",
    );

    expect(result).toMatchObject({
      ok: true,
      intent: "create-site",
      repoUrl: "https://github.com/me/my-site",
      defaultBranch: "main",
      owner: "me",
      name: "my-site",
      bornCleanOk: true,
      pagesUrl: "https://me.github.io/my-site",
    });
    expect((result as { langPatchFailed?: boolean }).langPatchFailed).toBeFalsy();
  });

  it("derives title/description/theme and passes the installation token", async () => {
    commitMock.mockResolvedValueOnce({ ok: true, pagesUrl: "u" });

    await handleCreateSiteIntents(
      "create-site",
      makeFormData("my-cool-site", "me"),
      TOKEN,
      ENV,
      "en",
    );

    expect(tokenMock).toHaveBeenCalledWith("123", "key", 42);
    expect(commitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        token: TOKEN,
        installationToken: INSTALL_TOKEN,
        owner: "me",
        name: "my-cool-site",
        locale: "en",
        title: "My Cool Site",
        description: "My Cool Site",
        theme: "trama",
      }),
    );
  });

  it("es + commit failure → langPatchFailed:true (language never got written)", async () => {
    commitMock.mockResolvedValue({ ok: false, error: "commit" });

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
      bornCleanOk: false,
      bornCleanError: "commit",
      langPatchFailed: true,
    });
  });

  it("es + pages failure → bornCleanOk:false but langPatchFailed falsy (language committed)", async () => {
    commitMock.mockResolvedValueOnce({ ok: false, error: "pages", pagesUrl: undefined });

    const result = await handleCreateSiteIntents(
      "create-site",
      makeFormData("my-site", "me"),
      TOKEN,
      ENV,
      "es",
    );

    expect(result).toMatchObject({ ok: true, bornCleanOk: false, bornCleanError: "pages" });
    expect((result as { langPatchFailed?: boolean }).langPatchFailed).toBeFalsy();
  });

  it("en + commit failure → ok:true, no language warning", async () => {
    commitMock.mockResolvedValue({ ok: false, error: "commit" });

    const result = await handleCreateSiteIntents(
      "create-site",
      makeFormData("my-site", "me"),
      TOKEN,
      ENV,
      "en",
    );

    expect(result).toMatchObject({ ok: true, bornCleanOk: false });
    expect((result as { langPatchFailed?: boolean }).langPatchFailed).toBeFalsy();
  });

  it("null locale defaults to en", async () => {
    commitMock.mockResolvedValueOnce({ ok: true, pagesUrl: "u" });

    await handleCreateSiteIntents("create-site", makeFormData("my-site", "me"), TOKEN, ENV, null);

    expect(commitMock).toHaveBeenCalledWith(expect.objectContaining({ locale: "en" }));
  });

  it("installation-token failure is caught → ok:true with bornCleanError:provisioning", async () => {
    tokenMock.mockRejectedValue(new Error("jwt decode failed"));

    const result = await handleCreateSiteIntents(
      "create-site",
      makeFormData("my-site", "me"),
      TOKEN,
      ENV,
      "en",
    );

    expect(result).toMatchObject({
      ok: true,
      intent: "create-site",
      bornCleanOk: false,
      bornCleanError: "provisioning",
    });
    expect(commitMock).not.toHaveBeenCalled();
  });

  it("es + provisioning failure (token throws, commit never ran) → langPatchFailed:true", async () => {
    // The config commit never landed, so telar_language was never written — the
    // es "set language manually" nudge must still fire, same as the commit-failure case.
    tokenMock.mockRejectedValue(new Error("jwt decode failed"));

    const result = await handleCreateSiteIntents(
      "create-site",
      makeFormData("my-site", "me"),
      TOKEN,
      ENV,
      "es",
    );

    expect(result).toMatchObject({
      ok: true,
      bornCleanOk: false,
      bornCleanError: "provisioning",
      langPatchFailed: true,
    });
  });

  it("es + pages failure → langPatchFailed falsy (language was committed before pages)", async () => {
    commitMock.mockResolvedValueOnce({ ok: false, error: "pages" });

    const result = await handleCreateSiteIntents(
      "create-site",
      makeFormData("my-site", "me"),
      TOKEN,
      ENV,
      "es",
    );

    expect(result).toMatchObject({ ok: true, bornCleanError: "pages" });
    expect((result as { langPatchFailed?: boolean }).langPatchFailed).toBeFalsy();
  });

  // --- wizard-supplied fields ---------------------------------------------

  it("uses wizard-supplied title/description/theme/author over the derived defaults", async () => {
    commitMock.mockResolvedValueOnce({ ok: true, pagesUrl: "u" });
    const fd = makeFormData("my-site", "me");
    fd.set("title", "My Grand Archive");
    fd.set("description", "Letters and maps, 1500-1800");
    fd.set("theme", "santa-barbara");
    fd.set("author", "Jane Q. Historian");

    await handleCreateSiteIntents("create-site", fd, TOKEN, ENV, "en");

    expect(commitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "My Grand Archive",
        description: "Letters and maps, 1500-1800",
        theme: "santa-barbara",
        author: "Jane Q. Historian",
      }),
    );
  });

  it("takes language from the form, overriding the UI locale", async () => {
    commitMock.mockResolvedValue({ ok: false, error: "commit" });
    const fd = makeFormData("my-site", "me");
    fd.set("language", "es");

    // UI locale is en, but the wizard chose es.
    const result = await handleCreateSiteIntents("create-site", fd, TOKEN, ENV, "en");

    expect(commitMock).toHaveBeenCalledWith(expect.objectContaining({ locale: "es" }));
    // es + commit failure → the language never landed → nudge fires.
    expect(result).toMatchObject({ langPatchFailed: true });
  });

  it("form en overrides a Spanish UI locale", async () => {
    commitMock.mockResolvedValueOnce({ ok: true, pagesUrl: "u" });
    const fd = makeFormData("my-site", "me");
    fd.set("language", "en");

    await handleCreateSiteIntents("create-site", fd, TOKEN, ENV, "es");

    expect(commitMock).toHaveBeenCalledWith(expect.objectContaining({ locale: "en" }));
  });

  it("falls back to the UI locale when the form language is garbage", async () => {
    commitMock.mockResolvedValueOnce({ ok: true, pagesUrl: "u" });
    const fd = makeFormData("my-site", "me");
    fd.set("language", "fr"); // not en/es

    await handleCreateSiteIntents("create-site", fd, TOKEN, ENV, "es");

    expect(commitMock).toHaveBeenCalledWith(expect.objectContaining({ locale: "es" }));
  });

  it("rejects an unknown theme and falls back to trama", async () => {
    commitMock.mockResolvedValueOnce({ ok: true, pagesUrl: "u" });
    const fd = makeFormData("my-site", "me");
    fd.set("theme", "totally-made-up");

    await handleCreateSiteIntents("create-site", fd, TOKEN, ENV, "en");

    expect(commitMock).toHaveBeenCalledWith(expect.objectContaining({ theme: "trama" }));
  });

  it("rejects the hidden 'custom' theme and falls back to trama", async () => {
    commitMock.mockResolvedValueOnce({ ok: true, pagesUrl: "u" });
    const fd = makeFormData("my-site", "me");
    fd.set("theme", "custom");

    await handleCreateSiteIntents("create-site", fd, TOKEN, ENV, "en");

    expect(commitMock).toHaveBeenCalledWith(expect.objectContaining({ theme: "trama" }));
  });

  it("defaults the author to the owner login when the field is blank", async () => {
    commitMock.mockResolvedValueOnce({ ok: true, pagesUrl: "u" });
    const fd = makeFormData("my-site", "me");
    fd.set("author", "   ");

    await handleCreateSiteIntents("create-site", fd, TOKEN, ENV, "en");

    expect(commitMock).toHaveBeenCalledWith(expect.objectContaining({ author: "me" }));
  });

  it("falls back to the humanized slug when the title field is blank", async () => {
    commitMock.mockResolvedValueOnce({ ok: true, pagesUrl: "u" });
    const fd = makeFormData("my-cool-site", "me");
    fd.set("title", "  ");

    await handleCreateSiteIntents("create-site", fd, TOKEN, ENV, "en");

    expect(commitMock).toHaveBeenCalledWith(
      expect.objectContaining({ title: "My Cool Site", description: "My Cool Site" }),
    );
  });

  // --- born-clean single retry on a pre-commit failure (#2a) ---------------
  // A born-clean COMMIT or PROVISIONING failure leaves the config un-committed,
  // so the subsequent import would seed D1 from the live demo Sheet. The commit
  // is idempotent, so a single retry safely clears the dominant (transient)
  // cause before the import runs.

  it("transient commit failure → one retry succeeds → bornCleanOk:true", async () => {
    commitMock
      .mockResolvedValueOnce({ ok: false, error: "commit" })
      .mockResolvedValueOnce({ ok: true, pagesUrl: "https://me.github.io/my-site" });

    const result = await handleCreateSiteIntents(
      "create-site",
      makeFormData("my-site", "me"),
      TOKEN,
      ENV,
      "es",
    );

    expect(commitMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: true,
      bornCleanOk: true,
      pagesUrl: "https://me.github.io/my-site",
    });
    // Retry landed the config, so the es language nudge must NOT fire.
    expect((result as { langPatchFailed?: boolean }).langPatchFailed).toBeFalsy();
  });

  it("transient provisioning failure (token throws once) → retry mints token + commits → bornCleanOk:true", async () => {
    tokenMock
      .mockRejectedValueOnce(new Error("jwt decode failed"))
      .mockResolvedValueOnce(INSTALL_TOKEN);
    commitMock.mockResolvedValue({ ok: true, pagesUrl: "u" });

    const result = await handleCreateSiteIntents(
      "create-site",
      makeFormData("my-site", "me"),
      TOKEN,
      ENV,
      "en",
    );

    expect(tokenMock).toHaveBeenCalledTimes(2);
    expect(commitMock).toHaveBeenCalledTimes(1); // only the second attempt reached commit
    expect(result).toMatchObject({ ok: true, bornCleanOk: true });
  });

  it("persistent commit failure → retried exactly once (bounded), still bornCleanError:commit", async () => {
    commitMock.mockResolvedValue({ ok: false, error: "commit" });

    const result = await handleCreateSiteIntents(
      "create-site",
      makeFormData("my-site", "me"),
      TOKEN,
      ENV,
      "en",
    );

    expect(commitMock).toHaveBeenCalledTimes(2); // one retry, not a loop
    expect(result).toMatchObject({ ok: true, bornCleanOk: false, bornCleanError: "commit" });
  });

  it("non-retryable failure (pages) is NOT retried", async () => {
    commitMock.mockResolvedValue({ ok: false, error: "pages", pagesUrl: undefined });

    const result = await handleCreateSiteIntents(
      "create-site",
      makeFormData("my-site", "me"),
      TOKEN,
      ENV,
      "en",
    );

    expect(commitMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, bornCleanOk: false, bornCleanError: "pages" });
  });
});
