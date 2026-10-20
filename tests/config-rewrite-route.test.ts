/**
 * The publish route's side of the `_config.yml` rewrite: the preview the
 * review dialog asks for, and the publish that carries the fingerprint of the
 * rewrite the author accepted. The publish rebuilds once, from the file and
 * settings row it judged, drops `config_needs_rewrite` only when the rebuilt
 * text's fingerprint is the accepted one, and hands that text to the file set.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/pending-object-ops.server", () => import("./helpers/pending-object-ops-passthrough"));

const { configRows, userRole } = vi.hoisted(() => ({
  configRows: { current: [] as unknown[] },
  userRole: { current: "convenor" as string },
}));

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    select: (columns?: Record<string, unknown>) => {
      // The whole-row read is the project_config row; every other read here
      // is of content this file does not exercise.
      const rows = columns === undefined ? configRows.current : [];
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      chain.where = () => Object.assign(Promise.resolve(rows), chain);
      chain.orderBy = function (this: unknown) { return this; };
      chain.limit = () => Promise.resolve(rows);
      return chain;
    },
  })),
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({ getSession: vi.fn(async () => ({ get: vi.fn(() => 1) })) })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    project: {
      id: 7,
      github_repo_full_name: "owner/repo",
      installation_id: 55,
      head_sha: "sha-at-the-start",
      publish_snapshot: null,
    },
    userRole: userRole.current,
  })),
  requirePublishingRole: vi.fn(async () => {}),
}));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "install-token"),
  resolveProjectToken: vi.fn(async () => "install-token"),
}));
vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(async () => ({ sigHex: "sig", timestamp: 1 })),
}));
vi.mock("~/lib/upgrade-gate.server", () => ({ readRepoWriteGate: vi.fn(async () => "open") }));

// The template every rebuild here reads, at the site's release.
const { templateText } = vi.hoisted(() => ({ templateText: { current: "" } }));
vi.mock("~/lib/upgrade.server", () => ({
  healMissingFrameworkFiles: vi.fn(async () => []),
  fetchFrameworkFile: vi.fn(async () => ({ kind: "found", content: templateText.current })),
  fetchLatestRelease: vi.fn(async () => ({ tagName: "v1.8.2" })),
}));
vi.mock("~/lib/commit.server", async (orig) => ({
  // The rebuild cleans its text as a commit does, with the real function.
  cleanCommitContent: ((await orig()) as Record<string, unknown>).cleanCommitContent,
  commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "new-sha" })),
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));

const { configYmlAtRef } = vi.hoisted(() => ({ configYmlAtRef: { current: null as string | null } }));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getRepoHead: vi.fn(async () => "sha-at-the-start"),
    getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
    getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string) =>
      path === "_config.yml" && configYmlAtRef.current !== null
        ? { status: "ok", content: configYmlAtRef.current }
        : { status: "absent" },
    ),
  };
});

const { buildPublishFileSet } = vi.hoisted(() => ({ buildPublishFileSet: vi.fn(async () => [] as unknown[]) }));
vi.mock("~/lib/publish.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, buildPublishFileSet };
});

import { action } from "~/routes/_app.publish";
import { prepareConfigRewrite } from "~/lib/config-rewrite.server";
import { project_config } from "~/db/schema";

type ProjectConfigRow = typeof project_config.$inferSelect;

const TEMPLATE = `# Site Settings
title: "Telar"
description: "A Telar site."
url: ""
markdown: kramdown
story_interface:
  show_on_homepage: true
`;

/** A managed block in a shape its writer cannot edit: the file needs the rewrite. */
const SITE = `title: "A site"
story_interface: {show_on_homepage: false, custom_child: 1}
custom: keep
`;

const CONFIG = {
  id: 1,
  project_id: 7,
  title: "A site",
  telar_version: "1.8.2",
  show_on_homepage: true,
  collection_mode: false,
  skip_stories: false,
} as unknown as ProjectConfigRow;

function buildContext() {
  const doStub = { fetch: async () => new Response("OK", { status: 200 }) };
  return {
    get: vi.fn(() => ({ id: 1, encrypted_access_token: "x", github_login: "u" })),
    cloudflare: {
      env: {
        DB: {},
        SESSION_SECRET: "s",
        ENCRYPTION_KEY: "k",
        COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => doStub) },
      },
    },
  } as unknown as Parameters<typeof action>[0]["context"];
}

async function post(fields: Record<string, string>) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  form.set("siteId", "7");
  const request = new Request("https://app/publish", { method: "POST", body: form, headers: { Cookie: "" } });
  return (await action({ request, context: buildContext(), params: {} } as unknown as Parameters<typeof action>[0])) as Record<
    string,
    unknown
  >;
}

const publish = (fields: Record<string, string> = {}) => post({ intent: "publish", commitMessage: "Publish site", ...fields });

/** The rewrite as the route builds it, for what a publish is expected to write. */
async function expectedRewrite(site = SITE, config = CONFIG) {
  const rewrite = await prepareConfigRewrite({ frameworkToken: "user-token", site, config });
  if (rewrite.kind !== "ready") throw new Error(`no rewrite: ${rewrite.kind}`);
  return rewrite;
}

beforeEach(() => {
  vi.clearAllMocks();
  configRows.current = [CONFIG];
  configYmlAtRef.current = SITE;
  templateText.current = TEMPLATE;
  userRole.current = "convenor";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("preview-config-rewrite", () => {
  it("returns the report and the fingerprint of the rebuilt text", async () => {
    const expected = await expectedRewrite();
    const res = await post({ intent: "preview-config-rewrite" });
    expect(res).toEqual({
      ok: true,
      intent: "preview-config-rewrite",
      report: expected.report,
      fingerprint: expected.fingerprint,
    });
    expect(expected.report.templateTag).toBe("v1.8.2");
  });

  it("says the template could not be read", async () => {
    const { fetchFrameworkFile } = await import("~/lib/upgrade.server");
    vi.mocked(fetchFrameworkFile).mockResolvedValueOnce({ kind: "failed" });
    expect(await post({ intent: "preview-config-rewrite" })).toMatchObject({
      ok: false,
      error: "template_unavailable",
    });
  });
});

describe("publish with a _config.yml that needs the rewrite", () => {
  it("is blocked without an accepted rewrite", async () => {
    const res = await publish();
    expect(res).toMatchObject({ ok: false, intent: "publish", error: "validation_blocked" });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  it("writes exactly the previewed text when it carries the previewed fingerprint", async () => {
    const preview = await post({ intent: "preview-config-rewrite" });
    const res = await publish({ acknowledgedConfigRewrite: preview.fingerprint as string });
    expect(res.error).toBeUndefined();
    expect(buildPublishFileSet).toHaveBeenCalledTimes(1);
    const expected = await expectedRewrite();
    expect(buildPublishFileSet).toHaveBeenCalledWith(
      expect.objectContaining({ rewrittenConfigYml: expected.text }),
    );
  });

  it("refuses as stale when the file changed after the review, and writes nothing", async () => {
    const preview = await post({ intent: "preview-config-rewrite" });
    configYmlAtRef.current = SITE.replace("custom: keep", "custom: changed on GitHub");
    const res = await publish({ acknowledgedConfigRewrite: preview.fingerprint as string });
    expect(res).toMatchObject({ ok: false, intent: "publish", error: "config_rewrite_stale" });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  it("refuses as stale when the settings changed after the review", async () => {
    const preview = await post({ intent: "preview-config-rewrite" });
    configRows.current = [{ ...CONFIG, title: "Retitled" }];
    const res = await publish({ acknowledgedConfigRewrite: preview.fingerprint as string });
    expect(res).toMatchObject({ error: "config_rewrite_stale" });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  it("writes no rewrite for a file that does not need one, whatever the request carries", async () => {
    configYmlAtRef.current = 'title: "A site"\nstory_interface:\n  show_on_homepage: true\n';
    const preview = await post({ intent: "preview-config-rewrite" });
    const res = await publish({ acknowledgedConfigRewrite: preview.fingerprint as string });
    expect(res.error).toBeUndefined();
    expect(buildPublishFileSet).toHaveBeenCalledWith(expect.objectContaining({ rewrittenConfigYml: undefined }));
  });
});
