/**
 * A publish of D1 text that holds a character a Telar build rejects commits a
 * clean step file, and records what D1 holds, the same way on every publish.
 *
 * The file set and the commit primitive are both real here: the D1 rows go
 * through `buildPublishFileSet` and `commitFilesToRepo`, and the assertions
 * decode the content sent to GitHub's GraphQL endpoint. Only the reads of the
 * repository and the database are stood in for.
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
// graphqlGitHub stays real, so commitFilesToRepo's request reaches the fetch
// stub below; only the repository reads are answered here.
vi.mock("~/lib/github.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/github.server")>();
  return {
    ...actual,
    getRepoHead: vi.fn(async () => "sha"),
    getFileAtRef: vi.fn(async () => ({ status: "absent" })),
  };
});
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

const { project } = vi.hoisted(() => ({
  project: { publish_snapshot: null as string | null, published_sha: null as string | null },
}));

// `resolvePageProject` and `siteChangedAnswer` are re-implemented here against
// the same mocked `resolveActiveProjectFromRequest`, matching the real
// module's own logic (app/lib/active-project.server.ts), because this file
// mocks the whole module rather than importing its original.
vi.mock("~/lib/active-project.server", () => {
  const resolveActiveProjectFromRequest = vi.fn(async () => ({
    project: {
      id: 7,
      head_sha: "sha",
      published_sha: project.published_sha,
      last_published_at: null,
      publish_snapshot: project.publish_snapshot,
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

const { tableRows, updates } = vi.hoisted(() => ({
  tableRows: { current: {} as Record<string, unknown[]> },
  updates: [] as Array<Record<string, unknown>>,
}));

function tableName(table: unknown): string {
  if (table === null || typeof table !== "object") return "unknown";
  const sym = Object.getOwnPropertySymbols(table).find((s) => s.description === "drizzle:Name");
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
      chain.innerJoin = () => chain;
      chain.where = () => Object.assign(Promise.resolve(rows), chain);
      chain.limit = () => Promise.resolve(rows);
      chain.orderBy = () => Promise.resolve(rows);
      return chain;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: async () => {} };
      },
    }),
    batch: async (statements: unknown[]) => Promise.all(statements),
  }),
}));

import { action } from "~/routes/_app.publish";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const NONCHARACTER = String.fromCharCode(0xfffe);
const LINE_SEPARATOR = String.fromCharCode(0x2028);

function buildContext() {
  const doStub = { fetch: async () => new Response("OK", { status: 200 }) };
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

async function runPublish() {
  const form = new FormData();
  form.set("intent", "publish");
  form.set("commitMessage", "Update site");
  // The mocked active project's id, string-compared by `resolvePageProject`.
  form.set("siteId", "7");
  return (await action({
    request: new Request("https://app/publish", { method: "POST", body: form, headers: { Cookie: "" } }),
    context: buildContext(),
    params: {},
  } as never)) as { ok?: boolean; error?: string };
}

/** Every file each CreateCommit carried, decoded, in commit order. */
function commitsSent(fetchMock: ReturnType<typeof vi.fn>): Array<Record<string, string>> {
  const commits: Array<Record<string, string>> = [];
  for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
    const body = JSON.parse((init?.body as string) ?? "{}");
    if (!String(body.query).includes("CreateCommit")) continue;
    const files: Record<string, string> = {};
    for (const a of body.variables.input.fileChanges.additions as Array<{ path: string; contents: string }>) {
      files[a.path] = Buffer.from(a.contents, "base64").toString("utf-8");
    }
    commits.push(files);
  }
  return commits;
}

function graphqlFetch() {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    const query = String(body.query);
    const json = query.includes("GetHeadOid")
      ? { data: { repository: { ref: { target: { oid: "sha" } } } } }
      : query.includes("SubtreeOids")
        ? { data: { repository: { c0: { __typename: "Commit" }, c0p0: null, c0p1: null } } }
        : query.includes("CheckPaths")
        ? { data: { repository: {} } }
        : { data: { createCommitOnBranch: { commit: { oid: "new-sha", url: "u" } } } };
    return { ok: true, status: 200, json: async () => json, text: async () => "" };
  });
}

function recordedSnapshots(): string[] {
  return updates.filter((u) => typeof u.publish_snapshot === "string").map((u) => u.publish_snapshot as string);
}

function seed(layerContent: string) {
  tableRows.current = {
    stories: [{ id: 1, story_id: "historia", title: "Historia", draft: false, private: false, order: 1 }],
    objects: [{ object_id: "obj-1", title: "Mapa" }],
    project_pages: [],
    glossary_terms: [],
    project_config: [{ project_id: 7, title: "Site", navigation_json: null }],
    project_landing: [],
    steps: [{ id: 11, story_id: 1, step_number: 1, kind: "media", object_id: "obj-1", question: "Pregunta", answer: "Respuesta" }],
    layers: [{ id: 21, step_id: 11, layer_number: 1, title: "Capa", button_label: "Leer", content: layerContent }],
    projects: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  updates.length = 0;
  project.publish_snapshot = null;
  project.published_sha = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a publish of D1 text holding a character a build rejects", () => {
  it("commits a clean step file and records the same snapshot on two consecutive publishes", async () => {
    seed(`Mediterr${NONCHARACTER}anean${LINE_SEPARATOR}sea`);
    const fetchMock = graphqlFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect((await runPublish()).ok).toBe(true);
    const first = recordedSnapshots();
    expect(first).toHaveLength(1);

    project.publish_snapshot = first[0];
    project.published_sha = "new-sha";
    expect((await runPublish()).ok).toBe(true);
    const both = recordedSnapshots();
    expect(both).toHaveLength(2);
    expect(both[1]).toBe(both[0]);

    // Each publish committed, so the check below reads both commits.
    const commits = commitsSent(fetchMock);
    expect(commits).toHaveLength(2);
    for (const files of commits) {
      const stepFiles = Object.entries(files).filter(([path]) => path.startsWith("telar-content/texts/stories/"));
      expect(stepFiles.length).toBe(1);
      const [, content] = stepFiles[0];
      expect(content).toContain("Mediterranean sea");
      for (const text of Object.values(files)) {
        expect(text.includes(NONCHARACTER)).toBe(false);
        expect(text.includes(LINE_SEPARATOR)).toBe(false);
      }
    }
  });

  it("records hashes of what D1 holds, which the cleaned text does not share", async () => {
    const fetchMock = graphqlFetch();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    seed(`Mediterr${NONCHARACTER}anean sea`);
    expect((await runPublish()).ok).toBe(true);
    seed("Mediterranean sea");
    expect((await runPublish()).ok).toBe(true);

    const [dirty, clean] = recordedSnapshots().map((s) => JSON.parse(s) as { entity_hashes: { stories: unknown } });
    expect(dirty.entity_hashes.stories).not.toEqual(clean.entity_hashes.stories);
    // The two commits carried the same step file.
    const commits = commitsSent(fetchMock);
    const stepFile = (files: Record<string, string>) =>
      Object.entries(files).find(([path]) => path.startsWith("telar-content/texts/stories/"))?.[1];
    expect(stepFile(commits[0])).toBe(stepFile(commits[commits.length - 1]));
  });
});
