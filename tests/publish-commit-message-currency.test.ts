/**
 * The auto-generated commit message must describe the commit it is attached to.
 *
 * Two snapshots run per publish. The loader forces one and builds the change
 * summary from what D1 then holds; the page turns that summary into the commit
 * message. The action forces its own snapshot and publishes whatever D1 holds
 * after it. Edits a collaborator lands in between are therefore in the commit
 * and absent from the message — and the message is the permanent record in
 * GitHub's history, which no later publish can correct.
 *
 * The action's own validation was moved behind its snapshot for this reason.
 * The message was left crossing the same seam.
 *
 * The fix is not to rebuild the message server-side: the message is a rendering
 * of the summary through the author's locale, and rebuilding it would mean a
 * second copy of the loader's whole summary assembly living in the action,
 * kept in step by hand — and would commit wording the author never saw. What
 * the action can do is check whether the state the message was built from is
 * still the state being published, and fall back to the neutral headline when
 * it is not. The author's own typed message is never touched: those are their
 * words about their own publish, not an inventory that can go stale.
 *
 * The commit body carries one more line the assertions below account for:
 * who published — the commit lands under the App's installation
 * token, which carries no per-user identity, so the body is where that goes.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: () => ({ getSession: async () => ({ get: () => 1 }) }),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "tok") }));
// The action reads _config.yml before publishing, to refuse a managed block
// its writer cannot edit. "absent" is the answer that reports nothing, which
// is what these cases are about — the commit message, not the config.
vi.mock("~/lib/github.server", () => ({
  getRepoHead: vi.fn(async () => "sha"),
  getFileAtRef: vi.fn(async () => ({ status: "absent" })),
  // A repository with no story files: a story with no steps is one the
  // kept-columns capture reads, and there is nothing for it to read.
  getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
}));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(),
  requirePublishingRole: vi.fn(async () => {}),
}));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "install-token"),
  resolveProjectToken: vi.fn(async () => "install-token"),
}));
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(async () => ({ sigHex: "sig", timestamp: 1 })),
}));
vi.mock("~/lib/upgrade.server", () => ({
  healMissingFrameworkFiles: vi.fn(async () => []),
  normalizeVersionTag: vi.fn((v: string) => v),
}));

const { commitFilesToRepo } = vi.hoisted(() => ({
  commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "new-sha" })),
}));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo,
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));

vi.mock("~/lib/publish.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, buildPublishFileSet: vi.fn(async () => []) };
});

// `resolvePageProject` and `siteChangedAnswer` are re-implemented here against
// the same mocked `resolveActiveProjectFromRequest`, matching the real
// module's own logic (app/lib/active-project.server.ts), because this file
// mocks the whole module rather than importing its original.
vi.mock("~/lib/active-project.server", () => {
  const resolveActiveProjectFromRequest = vi.fn(async () => ({
    project: {
      id: 7,
      head_sha: "sha",
      published_sha: null,
      last_published_at: null,
      publish_snapshot: null,
      github_repo_full_name: "owner/repo",
      github_pages_url: "https://owner.github.io/repo",
      installation_id: 1,
    },
    userRole: "convenor",
  }));
  return {
    resolveActiveProjectFromRequest,
    resolvePageProject: vi.fn(async (request: Request, env: unknown, userId: number, formData: FormData) => {
      const resolved = await resolveActiveProjectFromRequest();
      if (!resolved) return { kind: "no_project" };
      if (formData.get("siteId") !== String(resolved.project.id)) {
        return { kind: "site_changed", currentSiteName: resolved.project.github_repo_full_name };
      }
      return { kind: "ok", ...resolved };
    }),
    siteChangedAnswer: vi.fn((intent: string, currentSiteName: string) => ({
      ok: false,
      intent,
      error: "site_changed",
      currentSiteName,
    })),
  };
});

// D1 stand-in keyed by drizzle's own table name, so a test can move one table's
// rows between the loader's read and the action's and nothing else changes.
const { tableRows } = vi.hoisted(() => ({
  tableRows: { current: {} as Record<string, unknown[]> },
}));

function tableName(table: unknown): string {
  if (table === null || typeof table !== "object") return "unknown";
  const sym = Object.getOwnPropertySymbols(table).find(
    (s) => s.description === "drizzle:Name",
  );
  return sym ? String((table as Record<symbol, unknown>)[sym]) : "unknown";
}

vi.mock("~/lib/db.server", () => ({
  getDb: () => ({
    select: () => {
      const chain: Record<string, unknown> = {};
      let rows: unknown[] = [];
      chain.from = (table: unknown) => {
        rows = tableRows.current[tableName(table)] ?? [];
        return chain;
      };
      // The step fetch joins stories in; the rows it resolves to are the
      // ones its `from(steps)` already chose.
      chain.innerJoin = () => chain;
      chain.where = () => Object.assign(Promise.resolve(rows), chain);
      chain.limit = () => Promise.resolve(rows);
      chain.orderBy = () => Promise.resolve(rows);
      return chain;
    },
    update: () => ({ set: () => ({ where: async () => {} }) }),
  }),
}));

import { loader, action } from "~/routes/_app.publish";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type DOFetch = (request: Request) => Promise<Response>;
const snapshotOk: DOFetch = async () => new Response("OK", { status: 200 });

function buildContext(doFetch: DOFetch) {
  const doStub = { fetch: doFetch };
  return {
    get: vi.fn(() => ({
      id: 1,
      encrypted_access_token: "x",
      github_login: "u",
      github_name: "U",
      github_email: "u@e.co",
    })),
    cloudflare: {
      env: {
        DB: {},
        SESSION_SECRET: "s",
        ENCRYPTION_KEY: "k",
        COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => doStub) },
      },
    },
  } as unknown as Record<string, unknown>;
}

async function runLoader(): Promise<Record<string, unknown>> {
  return (await loader({
    request: new Request("https://app/publish", { headers: { Cookie: "" } }),
    context: buildContext(snapshotOk),
    params: {},
  } as never)) as Record<string, unknown>;
}

async function runPublish(fields: Record<string, string>) {
  const form = new FormData();
  form.set("intent", "publish");
  // The mocked active project's id, string-compared by `resolvePageProject`.
  form.set("siteId", "7");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return (await action({
    request: new Request("https://app/publish", {
      method: "POST",
      body: form,
      headers: { Cookie: "" },
    }),
    context: buildContext(snapshotOk),
    params: {},
  } as never)) as { ok?: boolean; error?: string };
}

/** The message and body the action actually handed to GitHub. */
function committed(): { message: string; body: string | undefined } {
  expect(commitFilesToRepo).toHaveBeenCalledTimes(1);
  const call = commitFilesToRepo.mock.calls[0] as unknown[];
  return { message: call[5] as string, body: call[6] as string | undefined };
}

// A site with one story and one page. Every table the publish path reads is
// present so the real `buildEntityHashes` runs over a complete shape.
function seedRows(storyTitles: string[]) {
  tableRows.current = {
    stories: storyTitles.map((title, i) => ({
      id: i + 1,
      story_id: `story-${i + 1}`,
      title,
      draft: false,
      private: false,
    })),
    objects: [],
    project_pages: [{ slug: "about", title: "About us", body: "hi", order: 1 }],
    glossary_terms: [],
    project_config: [{ project_id: 7, title: "Site", navigation_json: null }],
    project_landing: [],
    steps: [],
    layers: [],
    projects: [],
  };
}

// Headline and body as the page submits them — two separate form fields.
// Kept to single lines: multipart encoding rewrites a bare newline to CRLF on
// the way through, which would make an equality assertion about the body a
// test of FormData rather than of the action.
const GENERATED_HEADLINE = "Add 1 story";
const GENERATED_BODY = "Added: Story One";
const NEUTRAL = "Update site";
// The publisher line the action appends to every commit body,
// derived from the fixture user's github_login below (GitHub login
// only, never github_name — see app/routes/_app.publish.tsx).
const PUBLISHER_LINE = "Published by @u";

beforeEach(() => {
  vi.clearAllMocks();
  seedRows(["One"]);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// The defect
// ---------------------------------------------------------------------------

describe("publish action — a generated message that no longer describes the commit", () => {
  it("gives the loader a fingerprint of the state the summary was built from", async () => {
    const data = await runLoader();
    expect(typeof data.summaryFingerprint).toBe("string");
    expect((data.summaryFingerprint as string).length).toBeGreaterThan(0);
  });

  it("falls back to the neutral headline when the state moved after the loader read it", async () => {
    // The author opened the page against a one-story site and the message says
    // so. A collaborator's second story lands in D1 before the publish runs;
    // the action's snapshot picks it up and it ships. The message must not go
    // on claiming the commit was one story.
    const data = await runLoader();
    seedRows(["One", "Two"]);

    await runPublish({
      commitMessage: GENERATED_HEADLINE,
      commitBody: GENERATED_BODY,
      summaryFingerprint: data.summaryFingerprint as string,
      fallbackHeadline: NEUTRAL,
    });

    expect(committed()).toEqual({ message: NEUTRAL, body: PUBLISHER_LINE });
  });

  it("falls back when content changed without any entity being added or removed", async () => {
    // The commonest form of drift: somebody kept typing. No counts move, so
    // the headline still reads correctly — but the body names entities by
    // title, and the titles are not what shipped.
    const data = await runLoader();
    seedRows(["One, substantially rewritten"]);

    await runPublish({
      commitMessage: GENERATED_HEADLINE,
      commitBody: GENERATED_BODY,
      summaryFingerprint: data.summaryFingerprint as string,
      fallbackHeadline: NEUTRAL,
    });

    expect(committed().message).toBe(NEUTRAL);
  });
});

// ---------------------------------------------------------------------------
// The honest paths — a publish that loses the author's message, or refuses,
// is worse than the defect.
// ---------------------------------------------------------------------------

describe("publish action — messages that must survive untouched", () => {
  it("keeps the generated message when nothing moved", async () => {
    const data = await runLoader();

    await runPublish({
      commitMessage: GENERATED_HEADLINE,
      commitBody: GENERATED_BODY,
      summaryFingerprint: data.summaryFingerprint as string,
      fallbackHeadline: NEUTRAL,
    });

    expect(committed()).toEqual({
      message: GENERATED_HEADLINE,
      body: `${GENERATED_BODY}\n\n${PUBLISHER_LINE}`,
    });
  });

  it("keeps a message the author typed, even when the state moved", async () => {
    // No fingerprint is submitted for an edited message: it is not an
    // inventory derived from a read, it is what the author chose to say.
    // Replacing it with "Update site" would be its own kind of wrong.
    await runLoader();
    seedRows(["One", "Two"]);

    await runPublish({
      commitMessage: "Fix the dates on the Bogotá photographs",
      commitBody: "Checked against the accession register.",
      fallbackHeadline: NEUTRAL,
    });

    expect(committed()).toEqual({
      message: "Fix the dates on the Bogotá photographs",
      body: `Checked against the accession register.\n\n${PUBLISHER_LINE}`,
    });
  });

  it("publishes normally when no fingerprint is submitted at all", async () => {
    const res = await runPublish({ commitMessage: "Publish site" });

    expect(res).toMatchObject({ ok: true, intent: "publish" });
    expect(committed().message).toBe("Publish site");
  });

  it("does not refuse the publish over drift — it only softens the message", async () => {
    const data = await runLoader();
    seedRows(["One", "Two", "Three"]);

    const res = await runPublish({
      commitMessage: GENERATED_HEADLINE,
      summaryFingerprint: data.summaryFingerprint as string,
      fallbackHeadline: NEUTRAL,
    });

    expect(res).toMatchObject({ ok: true, intent: "publish" });
    expect(commitFilesToRepo).toHaveBeenCalledTimes(1);
  });

  it("falls back to the server default when the client sent no neutral headline", async () => {
    const data = await runLoader();
    seedRows(["One", "Two"]);

    await runPublish({
      commitMessage: GENERATED_HEADLINE,
      summaryFingerprint: data.summaryFingerprint as string,
    });

    expect(committed().message).toBe("Publish site");
  });
});

// ---------------------------------------------------------------------------
// The headline of a publish that corrects headings
// ---------------------------------------------------------------------------

describe("publish action — the headline that says it corrects headings", () => {
  const HEADLINE = "Correct column headings";

  async function publishClaiming(corrected: string[]) {
    const data = await runLoader();
    const { buildPublishFileSet } = await import("~/lib/publish.server");
    vi.mocked(buildPublishFileSet).mockImplementationOnce(async (params) => {
      params.headingsCorrected?.push(...corrected);
      return [];
    });
    await runPublish({
      commitMessage: HEADLINE,
      summaryFingerprint: data.summaryFingerprint as string,
      fallbackHeadline: NEUTRAL,
      correctsHeadings: "1",
    });
  }

  it("keeps it when the files it reads have headings to correct", async () => {
    await publishClaiming(["telar-content/spreadsheets/objects.csv"]);
    expect(committed().message).toBe(HEADLINE);
  });

  it("falls back to the neutral headline when they have none", async () => {
    await publishClaiming([]);
    expect(committed().message).toBe(NEUTRAL);
  });

  it("does not touch a headline that makes no such claim", async () => {
    const data = await runLoader();
    await runPublish({
      commitMessage: GENERATED_HEADLINE,
      summaryFingerprint: data.summaryFingerprint as string,
      fallbackHeadline: NEUTRAL,
    });
    expect(committed().message).toBe(GENERATED_HEADLINE);
  });
});
