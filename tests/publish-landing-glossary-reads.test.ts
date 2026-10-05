/**
 * A publish reads the landing page and the glossary it rewrites strictly, and
 * every refusal of the forced snapshot names its project.
 *
 * index.md and glossary.csv are each rewritten from what was read: the landing
 * page keeps the frontmatter lines and body of the file it replaces, and the
 * glossary keeps the sheet's comment and instruction rows. A read that fails is
 * therefore not a missing file. It refuses with `landing_unreadable` or
 * `glossary_unreadable`, commits nothing and ends the lease as failed.
 * index.md is read only when the publish writes it, so a site with no landing
 * row cannot be refused by that read. glossary.csv is read whatever D1 holds,
 * since a copy whose bytes are not valid UTF-8 is written without terms, but
 * with no terms a failed read of it refuses nothing and writes nothing. A
 * strict read keeps a leading byte-order mark, so each file's content drops
 * one before it is used; `_config.yml`, read strictly by the action for the
 * same rewrite, drops one too, or a managed key on its first line is not
 * recognised and is written a second time.
 *
 * D1 is the repository's own migration chain in memory, the file set is the
 * real one, and GitHub and the collaboration object are stand-ins.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

const PROJECT_ID = 1;
const PUBLISH_SHA = "sha-at-the-start";
const INDEX_MD = "index.md";
const GLOSSARY_CSV = "telar-content/spreadsheets/glossary.csv";
const PROJECT_CSV = "telar-content/spreadsheets/project.csv";
const CONFIG_YML = "_config.yml";
const BOM = "﻿";

const EXISTING_INDEX_MD = "---\nlayout: index\ntitle: Home\ncustom_key: kept\n---\n\nThe hand-written welcome.\n";
const EXISTING_GLOSSARY_CSV =
  "term_id,title,definition\nid_termino,titulo,definicion\n# A glossary instruction row,,\nold,Old,Gone\n";

const EXISTING_PROJECT_CSV =
  "order,story_id,title,subtitle,byline,private\norden,id_historia,titulo,subtitulo,firma,privada\n" +
  "#,# Must match the tab name exactly.,Story title,Optional subtitle,Optional attribution,# If yes then users need the key\n" +
  "#,# Debe coincidir con el nombre de la pestaña exactamente.,Título de la historia,Subtítulo opcional,Atribución opcional,# Si sí\n";

const events: string[] = [];
let memory: MemoryD1;

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({ getSession: vi.fn(async () => ({ get: vi.fn(() => 1) })) })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "tok") }));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    // head_sha is the recorded head, the one the repository is at: a publish commits only on it.
    project: { id: 1, github_repo_full_name: "owner/repo", installation_id: 55, publish_snapshot: null, head_sha: "sha-at-the-start" },
    userRole: "convenor",
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
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn(async () => {}) }));
vi.mock("~/lib/upgrade.server", () => ({
  healMissingFrameworkFiles: vi.fn(async () => []),
  fetchFrameworkFilesAtVersion: vi.fn(),
}));

const { getRepoHead, getFileAtRef } = vi.hoisted(() => ({
  getRepoHead: vi.fn(),
  getFileAtRef: vi.fn(),
}));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, getRepoHead, getFileAtRef };
});

const { commitFilesToRepo, StaleHeadError } = vi.hoisted(() => {
  class StaleHeadError extends Error {}
  return { commitFilesToRepo: vi.fn(), StaleHeadError };
});
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo,
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError,
}));

const { controlFreezeLease } = vi.hoisted(() => ({ controlFreezeLease: vi.fn() }));
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease,
  newFreezeOperationId: () => "op-publish",
}));

vi.mock("~/lib/db.server", async () => {
  const { drizzle } = await import("drizzle-orm/d1");
  const schema = await import("~/db/schema");
  return { getDb: () => drizzle(asD1(memory), { schema }) };
});

import { action } from "~/routes/_app.publish";

/** What the collaboration object answers at /snapshot; every other path is a 200. */
let snapshotAnswer: () => Response;

function publishContext() {
  const doStub = {
    fetch: async (req: Request) => {
      if (new URL(req.url).pathname.endsWith("/snapshot")) {
        events.push("snapshot");
        return snapshotAnswer();
      }
      return Response.json({ applied: {}, skipped: {}, failed: {}, refused: {} });
    },
  };
  return {
    get: vi.fn(() => ({ id: 1, encrypted_access_token: "x", github_login: "u" })),
    cloudflare: {
      env: {
        DB: asD1(memory),
        SESSION_SECRET: "s",
        ENCRYPTION_KEY: "k",
        COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => doStub) },
      },
    },
  } as unknown as Parameters<typeof action>[0]["context"];
}

async function publish() {
  const form = new FormData();
  form.set("intent", "publish");
  form.set("commitMessage", "Publish site");
  // The mocked active project's id, string-compared by `resolvePageProject`.
  form.set("siteId", String(PROJECT_ID));
  return (await action({
    request: new Request("https://app/publish", { method: "POST", body: form, headers: { Cookie: "" } }),
    context: publishContext(),
    params: {},
  } as unknown as Parameters<typeof action>[0])) as { ok?: boolean; error?: string; projectId?: number };
}

/** Repository files by path; anything else is absent. */
let repoFiles: Record<string, { status: "ok"; content: string } | { status: "absent" } | { status: "error" }>;

function committed(path: string): string | undefined {
  const files = (commitFilesToRepo.mock.calls[0] as unknown[] | undefined)?.[4] as
    | Array<{ path: string; content: string }>
    | undefined;
  return files?.find((f) => f.path === path)?.content;
}

function readsOf(path: string): unknown[][] {
  return getFileAtRef.mock.calls.filter((call) => (call as unknown[])[3] === path) as unknown[][];
}

function withLandingRow() {
  memory.raw.exec("INSERT INTO project_landing (project_id, stories_heading) VALUES (1, 'Stories')");
}

function withGlossaryTerm() {
  memory.raw.exec(
    "INSERT INTO glossary_terms (project_id, term_id, title, definition, order_key) VALUES (1, 'loom', 'Loom', 'A frame', 'a00001')",
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  events.length = 0;
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  memory.raw.exec(
    "INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (1, 1, 'owner/repo', 55)",
  );
  memory.raw.exec("INSERT INTO project_config (project_id, title) VALUES (1, 'New title')");
  snapshotAnswer = () => new Response("OK", { status: 200 });
  repoFiles = {
    [INDEX_MD]: { status: "ok", content: EXISTING_INDEX_MD },
    [GLOSSARY_CSV]: { status: "ok", content: EXISTING_GLOSSARY_CSV },
  };
  getRepoHead.mockImplementation(async () => (getRepoHead.mock.calls.length === 1 ? PUBLISH_SHA : "sha-that-moved"));
  getFileAtRef.mockImplementation(async (_t: string, _o: string, _r: string, path: string) =>
    repoFiles[path] ?? { status: "absent" },
  );
  commitFilesToRepo.mockImplementation(async () => {
    events.push("commit");
    return { newHeadSha: "new-sha" };
  });
  controlFreezeLease.mockImplementation(async (_e: unknown, _p: unknown, _u: unknown, control: { op: string; outcome?: string }) => {
    events.push(control.op === "begin" ? "lease:begin" : `lease:end:${control.outcome}`);
    return true;
  });
});

afterEach(() => {
  memory.close();
});

describe("a failed read refuses rather than rewriting the file from nothing", () => {
  it.each([
    [INDEX_MD, "landing_unreadable"],
    [GLOSSARY_CSV, "glossary_unreadable"],
    [PROJECT_CSV, "project_unreadable"],
  ])("a failed read of %s refuses %s, commits nothing and ends the lease as failed", async (path, code) => {
    withLandingRow();
    withGlossaryTerm();
    repoFiles[path] = { status: "error" };

    const res = await publish();

    expect(res).toMatchObject({ ok: false, intent: "publish", error: code, projectId: PROJECT_ID });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
    expect(events.at(-1)).toBe("lease:end:failed");
  });
});

describe("24: a failed read of project.csv is the publish's own read", () => {
  it("refuses at the first read of the file, before the deleted-story check reads it", async () => {
    repoFiles[PROJECT_CSV] = { status: "error" };

    const res = await publish();

    expect(res).toMatchObject({ ok: false, error: "project_unreadable" });
    expect(readsOf(PROJECT_CSV)).toHaveLength(1);
    // The assembly's read refused, not the deleted-story check's, which raises
    // UnreadableProjectCsvError for the same code.
    const logged = vi.mocked(console.error).mock.calls.flat().find((a) => a instanceof Error) as Error;
    expect(logged.name).toBe("UnreadablePublishFileError");
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });
});

describe("an absent file publishes as today", () => {
  it("builds index.md from nothing when the site has none", async () => {
    withLandingRow();
    repoFiles = {};

    const res = await publish();

    expect(res).toMatchObject({ ok: true });
    expect(committed(INDEX_MD)).toContain("layout: index");
  });

  it("25: publishes project.csv from its stories when the site has none", async () => {
    repoFiles = {};

    const res = await publish();

    expect(res).toMatchObject({ ok: true });
    expect(committed(PROJECT_CSV)).toContain("order,story_id,title");
  });

  it("writes glossary.csv from its terms when the site has none", async () => {
    withGlossaryTerm();
    repoFiles = {};

    const res = await publish();

    expect(res).toMatchObject({ ok: true });
    expect(committed(GLOSSARY_CSV)).toContain("loom,Loom,A frame");
  });

  it("does not read index.md when the publish does not write it", async () => {
    repoFiles[INDEX_MD] = { status: "error" };

    const res = await publish();

    expect(res).toMatchObject({ ok: true });
    expect(readsOf(INDEX_MD)).toHaveLength(0);
    expect(committed(INDEX_MD)).toBeUndefined();
  });

  it("is not refused by a failed read of glossary.csv when D1 holds no terms", async () => {
    repoFiles[GLOSSARY_CSV] = { status: "error" };

    const res = await publish();

    expect(res).toMatchObject({ ok: true });
    expect(readsOf(GLOSSARY_CSV)).toHaveLength(1);
    expect(committed(GLOSSARY_CSV)).toBeUndefined();
  });
});

describe("a successful read keeps what the file carries", () => {
  it("keeps index.md's frontmatter lines and body", async () => {
    withLandingRow();

    await publish();

    const written = committed(INDEX_MD);
    expect(written).toContain("custom_key: kept");
    expect(written).toContain("The hand-written welcome.");
  });

  it("23: keeps project.csv's instruction rows", async () => {
    repoFiles[PROJECT_CSV] = { status: "ok", content: EXISTING_PROJECT_CSV };

    await publish();

    const written = committed(PROJECT_CSV) ?? "";
    expect(written).toContain("#,# Must match the tab name exactly.");
    expect(written).toContain("#,# Debe coincidir con el nombre de la pestaña exactamente.");
  });

  it("keeps glossary.csv's comment rows", async () => {
    withGlossaryTerm();

    await publish();

    expect(committed(GLOSSARY_CSV)).toContain("# A glossary instruction row");
  });

  it("26: reads all three strictly, at the publish head", async () => {
    withLandingRow();
    withGlossaryTerm();

    await publish();

    for (const path of [INDEX_MD, GLOSSARY_CSV]) {
      expect(readsOf(path)).toHaveLength(1);
      expect(readsOf(path)[0][4]).toBe(PUBLISH_SHA);
      expect(readsOf(path)[0][5]).toEqual({ strict: true });
    }
    // Two reads: the assembly's, and the deleted-story check's.
    expect(readsOf(PROJECT_CSV)).toHaveLength(2);
    for (const read of readsOf(PROJECT_CSV)) {
      expect(read[4]).toBe(PUBLISH_SHA);
      expect(read[5]).toEqual({ strict: true });
    }
  });
});

describe("a byte-order mark the strict read keeps", () => {
  it("keeps a BOM-prefixed index.md's frontmatter lines and body, and writes it without the mark", async () => {
    withLandingRow();
    repoFiles[INDEX_MD] = { status: "ok", content: BOM + EXISTING_INDEX_MD };

    await publish();

    const written = committed(INDEX_MD) ?? "";
    expect(written).toContain("custom_key: kept");
    expect(written).toContain("The hand-written welcome.");
    expect(written.startsWith("---\n")).toBe(true);
  });

  it("recognises a managed key on the first line of a BOM-prefixed _config.yml", async () => {
    repoFiles[CONFIG_YML] = { status: "ok", content: `${BOM}title: "Old title"\ndescription: "d"\n` };

    const res = await publish();

    expect(res).toMatchObject({ ok: true });
    const titles = (committed(CONFIG_YML) ?? "").split("\n").filter((line) => /^﻿?title:/.test(line));
    expect(titles).toEqual(['title: "New title"']);
  });
});

describe("the forced snapshot's refusals name their project", () => {
  it.each([
    ["snapshot_failed", () => new Response("snapshot_failed", { status: 500 })],
    ["snapshot_incomplete", () => new Response("snapshot_incomplete", { status: 500 })],
  ])("%s carries projectId", async (code, answer) => {
    snapshotAnswer = answer;

    const res = await publish();

    expect(res).toEqual({ ok: false, intent: "publish", error: code, projectId: PROJECT_ID });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });
});
