// @vitest-environment jsdom
/**
 * The glossary route's `save-kinds` intent: what it hands the save, and the
 * writes it refuses before reaching it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const userContext = Symbol("userContext");
vi.mock("~/middleware/auth.server", () => ({ userContext }));
vi.mock("~/lib/db.server", () => ({ getDb: () => ({ db: true }) }));
const resolvePageProject = vi.fn();
vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: vi.fn(),
  resolvePageProject: (...a: unknown[]) => resolvePageProject(...a),
  siteChangedAnswer: (intent: string, site: string) => ({ refused: intent, site }),
}));
const saveGlossaryKinds = vi.fn();
vi.mock("~/lib/glossary-kinds-save.server", () => ({ saveGlossaryKinds: (...a: unknown[]) => saveGlossaryKinds(...a) }));
const readGlossaryKinds = vi.fn();
vi.mock("~/lib/glossary-kinds.server", () => ({ readGlossaryKinds: (...a: unknown[]) => readGlossaryKinds(...a) }));

const user = { id: 7, encrypted_access_token: "enc" };
const context = { get: () => user, cloudflare: { env: { DB: {} } } };
const project = { id: 3, github_repo_full_name: "o/r", head_sha: "abc" };

async function post(fields: Record<string, string>) {
  const { action } = await import("~/routes/_app.glossary");
  const body = new FormData();
  Object.entries(fields).forEach(([k, v]) => body.set(k, v));
  const request = new Request("http://x/glossary", { method: "POST", body });
  return (action as (args: unknown) => Promise<unknown>)({ request, context });
}

beforeEach(() => {
  resolvePageProject.mockReset().mockResolvedValue({ kind: "ok", project, userRole: "collaborator" });
  saveGlossaryKinds.mockReset().mockResolvedValue({ ok: true, stored: "[]", renamed: {} });
  readGlossaryKinds.mockReset();
});

describe("save-kinds", () => {
  it("hands the save the page's site, the member's role, the base and the parsed kinds", async () => {
    const answer = await post({ intent: "save-kinds", siteId: "3", base: "[]", kinds: '[{"id":"a"}]' });
    expect(answer).toEqual({ intent: "save-kinds", ok: true, stored: "[]", renamed: {} });
    const [, request] = saveGlossaryKinds.mock.calls[0];
    expect(request).toMatchObject({ projectId: 3, role: "collaborator", base: "[]", headSha: "abc", kinds: [{ id: "a" }] });
    await request.readRepoKinds();
    expect(readGlossaryKinds).toHaveBeenCalledWith(context.cloudflare.env, "enc", project);
  });

  it("reads an absent base as null and kinds that are not JSON as none", async () => {
    await post({ intent: "save-kinds", siteId: "3", kinds: "{oops" });
    expect(saveGlossaryKinds.mock.calls[0][1]).toMatchObject({ base: null, seenRepo: null, kinds: undefined });
  });

  it("hands the save the config's kinds the page was shown", async () => {
    await post({ intent: "save-kinds", siteId: "3", seenRepo: "[]", kinds: "[]" });
    expect(saveGlossaryKinds.mock.calls[0][1]).toMatchObject({ base: null, seenRepo: "[]" });
  });

  it("writes nothing when the page showed another site", async () => {
    resolvePageProject.mockResolvedValue({ kind: "site_changed", currentSiteName: "o/other" });
    expect(await post({ intent: "save-kinds", siteId: "9", kinds: "[]" })).toEqual({ refused: "save-kinds", site: "o/other" });
    expect(saveGlossaryKinds).not.toHaveBeenCalled();
  });

  it("refuses any other intent", async () => {
    await expect(post({ intent: "something-else" })).rejects.toMatchObject({ status: 400 });
    expect(saveGlossaryKinds).not.toHaveBeenCalled();
  });
});
