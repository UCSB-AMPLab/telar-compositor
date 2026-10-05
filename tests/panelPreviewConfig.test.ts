/**
 * The story loader's preview configuration read: only from the project the
 * loader resolved, at its imported commit, kept per project, commit and theme,
 * and never thrown. Adapted from the branch's route test, whose route the
 * loader replaced; its three cases are kept.
 *
 * @version v1.5.0-beta
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ file: vi.fn(), decrypt: vi.fn(), limit: vi.fn() }));
vi.mock("../app/lib/github.server", () => ({ getFileAtRef: mocks.file }));
vi.mock("../app/lib/crypto.server", () => ({ decrypt: mocks.decrypt }));
vi.mock("../app/lib/db.server", () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: mocks.limit }) }) }) }),
}));
import {
  readPanelPreviewConfig,
  clearPanelPreviewCache,
  olderThanPreviewFramework,
} from "../app/lib/panel-preview-config.server";

const env = { DB: {}, ENCRYPTION_KEY: "test" } as unknown as Env;
const project = (head_sha: string | null = "imported-commit") => ({
  id: 7,
  github_repo_full_name: "owner/site",
  head_sha,
});

beforeEach(() => {
  vi.clearAllMocks();
  clearPanelPreviewCache();
  mocks.limit.mockResolvedValue([{ theme: "trama" }]);
  mocks.decrypt.mockResolvedValue("test-token");
  mocks.file.mockResolvedValue({ status: "absent" });
});

it("reads the resolved project's files at the imported commit", async () => {
  const config = await readPanelPreviewConfig(env, "encrypted-test", project());
  expect(config.available).toBe(true);
  expect(mocks.file.mock.calls.map((c) => c.slice(1, 5))).toEqual([
    ["owner", "site", "_data/katex.yml", "imported-commit"],
    ["owner", "site", "_data/themes/trama.yml", "imported-commit"],
    ["owner", "site", "_config.yml", "imported-commit"],
  ]);
});

it("does not present a failed remote read as matching site settings", async () => {
  mocks.file.mockResolvedValue({ status: "error" });
  expect((await readPanelPreviewConfig(env, "encrypted-test", project())).available).toBe(false);
});

it("reports an unusable theme name or repository as unavailable without reading", async () => {
  mocks.limit.mockResolvedValue([{ theme: "../secrets" }]);
  expect((await readPanelPreviewConfig(env, "encrypted-test", project())).available).toBe(false);
  mocks.limit.mockResolvedValue([{ theme: "trama" }]);
  const noRepo = { ...project(), github_repo_full_name: "owner" };
  expect((await readPanelPreviewConfig(env, "encrypted-test", noRepo)).available).toBe(false);
  expect(mocks.file).not.toHaveBeenCalled();
});

it("keeps a complete read for the same commit and theme, and reads again for a new one", async () => {
  await readPanelPreviewConfig(env, "encrypted-test", project());
  await readPanelPreviewConfig(env, "encrypted-test", project());
  expect(mocks.file).toHaveBeenCalledTimes(3);
  await readPanelPreviewConfig(env, "encrypted-test", project("next-commit"));
  expect(mocks.file).toHaveBeenCalledTimes(6);
  mocks.limit.mockResolvedValue([{ theme: "neogranadina" }]);
  await readPanelPreviewConfig(env, "encrypted-test", project("next-commit"));
  expect(mocks.file).toHaveBeenCalledTimes(9);
});

it("never keeps a failed read", async () => {
  mocks.file.mockResolvedValueOnce({ status: "error" });
  await readPanelPreviewConfig(env, "encrypted-test", project());
  const second = await readPanelPreviewConfig(env, "encrypted-test", project());
  expect(second.available).toBe(true);
});

it("answers unavailable instead of throwing when a read fails outright", async () => {
  mocks.decrypt.mockRejectedValue(new Error("bad key"));
  expect((await readPanelPreviewConfig(env, "encrypted-test", project())).available).toBe(false);
});

describe("the site's Telar version", () => {
  const withConfig = (yaml: string) =>
    mocks.file.mockImplementation(async (_t: string, _o: string, _r: string, path: string) =>
      path === "_config.yml" ? { status: "ok", content: yaml } : { status: "absent" },
    );

  it.each([
    ["1.7.2", true],
    ["v1.7.0", true],
    ["0.9.0-beta", true],
    ["1.8.0-rc.1", true],
    ["1.8.0", false],
    ["1.8.1", false],
    ["1.9.0", false],
    ["2.0.0", false],
    [null, false],
    ["", false],
    ["not a version", false],
    ["1.7.2garbage", false],
    ["1.7", false],
    ["1.7.2.1", false],
    ["v1.7.2-", false],
    ["1.7.2 ", false],
    ["1.7.2-rc.1", true],
    ["1.7.2-.", false],
    ["1.7.2-rc..1", false],
    ["1.7.2-rc.", false],
  ])("counts %s as older than the preview's framework: %s", (version, older) => {
    expect(olderThanPreviewFramework(version)).toBe(older);
  });

  it("is read from _config.yml and marks an older site", async () => {
    withConfig("title: A site\ntelar:\n  version: 1.7.1\n");
    const config = await readPanelPreviewConfig(env, "encrypted-test", project());
    expect(config.siteVersion).toBe("1.7.1");
    expect(config.olderFramework).toBe(true);
  });

  it("does not mark a current site", async () => {
    withConfig("telar:\n  version: 1.8.0\n");
    const config = await readPanelPreviewConfig(env, "encrypted-test", project());
    expect(config.olderFramework).toBe(false);
  });

  it.each([
    ["no telar block", "title: A site\n"],
    ["an unparseable version", "telar:\n  version: latest\n"],
    ["unreadable YAML", "telar: [unclosed\n"],
  ])("makes no claim with %s", async (_what, yaml) => {
    withConfig(yaml);
    const config = await readPanelPreviewConfig(env, "encrypted-test", project());
    expect(config.olderFramework).toBe(false);
  });
});
