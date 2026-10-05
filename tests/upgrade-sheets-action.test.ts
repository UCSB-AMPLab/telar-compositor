/**
 * The upgrade's sheet stage through the route's action:
 * prepare's question and the lease it ends, the signed challenge the picker
 * posts back, the push that voids it, the repaired sheet in the commit, and
 * the recorded head the upgrade leaves alone when the author chose between
 * columns that both held values, on the full and on the partial path.
 *
 * Signing and hashing are real here, as in
 * upgrade-prepared-state-signing.test.ts: the challenge's verification is
 * under test.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Manifest } from "~/lib/manifest-schema.server";
import type { FileAtRef, TreeEntry } from "~/lib/github.server";

const DIR = "telar-content/spreadsheets";
/** An answer of 19 lines, one over the budget: 19 words of 52 characters. */
const LONG_ANSWER = Array.from({ length: 19 }, () => "x".repeat(52)).join(" ");
const CONFIG = 'telar:\n  version: "1.7.0"\ntelar_language: "en"\n';

const site = vi.hoisted(() => ({
  config: "",
  head: "head-1",
  files: {} as Record<string, string>,
  truncated: false,
  lossy: [] as string[],
  listingFails: false,
  version: "1.7.0",
  stories: ["my-story"],
}));

const configSetCalls: Array<Record<string, unknown>> = [];
const dbMock = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      // The project's stories with the answers of their steps, in editor order.
      leftJoin: vi.fn(() => ({
        where: vi.fn(() => ({ orderBy: vi.fn(async () => site.stories.flatMap((story) => ["Short.", LONG_ANSWER].map((answer, at) => ({ story, stepId: at + 1, answer })))) })),
      })),
      where: vi.fn(() => Object.assign(Promise.resolve([]), { limit: vi.fn(async () => [{ telar_version: site.version }]) })),
    })),
  })),
  update: vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => {
      configSetCalls.push(values);
      return { where: vi.fn(() => Object.assign(Promise.resolve(undefined), { returning: vi.fn(async () => [{ id: 1 }]) })) };
    }),
  })),
};

vi.mock("~/lib/db.server", () => ({ getDb: vi.fn(() => dbMock) }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({ getSession: vi.fn(async () => ({ get: vi.fn(() => undefined) })) })),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "user-token") }));
vi.mock("~/lib/membership.server", () => ({
  requirePublishingRole: vi.fn(async () => undefined),
  resolveActiveProject: vi.fn(async () => ({
    project: { id: 1, installation_id: 42, github_repo_full_name: "student/my-site", github_pages_url: "" },
    userRole: "convenor",
  })),
}));
vi.mock("~/lib/github-app.server", () => ({
  getInstallationToken: vi.fn(async () => "install-token"),
  resolveProjectToken: vi.fn(async () => "install-token"),
}));
vi.mock("~/lib/github.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/github.server")>("~/lib/github.server");
  const entries = (): TreeEntry[] =>
    Object.keys(site.files)
      .filter((path) => path.startsWith(`${DIR}/`))
      .map((path) => ({ path, mode: "100644", type: "blob", sha: `sha-${path}` }) as TreeEntry);
  return {
    ...actual,
    getRepoHead: vi.fn(async () => site.head),
    getRepoTree: vi.fn(async () => ({ tree: site.truncated ? [] : entries(), truncated: site.truncated })),
    listDirectoryEntries: vi.fn(async () => {
      if (site.listingFails) throw new Error("502");
      return entries();
    }),
    getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string): Promise<FileAtRef> => {
      if (path === "_config.yml") return { status: "ok", content: site.config };
      const content = site.files[path];
      if (content === undefined) return { status: "absent" };
      return site.lossy.includes(path) ? { status: "ok", content, lossy: true } : { status: "ok", content };
    }),
  };
});
vi.mock("~/lib/commit.server", async () => ({
  ...(({ cleanCommitContent, disableGoogleSheetsInConfig, SheetsNotDisableableError }) => ({
    cleanCommitContent,
    disableGoogleSheetsInConfig,
    SheetsNotDisableableError,
  }))(await vi.importActual<typeof import("~/lib/commit.server")>("~/lib/commit.server")),
  commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "new-head" })),
  StaleHeadError: class StaleHeadError extends Error {},
  dispatchWorkflow: vi.fn(),
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  getWorkflowRun: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
}));
vi.mock("~/lib/upgrade.server", async () => {
  const actual = await vi.importActual<typeof import("~/lib/upgrade.server")>("~/lib/upgrade.server");
  return {
    ...actual,
    fetchLatestRelease: vi.fn(),
    fetchAllReleases: vi.fn(),
    computeUpgradeDiff: vi.fn(),
    loadManifestChain: vi.fn(),
    // The release's built-in pages, read for their front matter; none here.
    fetchFrameworkFile: vi.fn(async () => ({ kind: "absent" })),
  };
});
vi.mock("~/lib/freeze-lease.server", () => ({
  controlFreezeLease: vi.fn(async () => "applied"),
  newFreezeOperationId: vi.fn(() => "op-test"),
}));
vi.mock("~/lib/github-status.server", async (orig) => {
  const actual = (await orig()) as typeof import("~/lib/github-status.server");
  return {
    ...actual,
    bumpProjectHeadFrom: vi.fn(async () => true),
    readLatestTag: vi.fn(async () => ({ ok: true, tag: "v1.8.0" })),
  };
});

import { action } from "~/routes/_app.upgrade";
import { computeUpgradeDiff, fetchLatestRelease, loadManifestChain } from "~/lib/upgrade.server";
import { commitFilesToRepo } from "~/lib/commit.server";
import { bumpProjectHeadFrom } from "~/lib/github-status.server";
import { controlFreezeLease } from "~/lib/freeze-lease.server";
import { listDirectoryEntries } from "~/lib/github.server";

const CHAIN: Manifest[] = [
  { schema_version: 1, from_version: "1.7.0", to_version: "1.8.0", description: "none", operations: [], manual_steps: { en: [], es: [] } },
];

function upgradeDiffFor(withWorkflow = false) {
  const additions = withWorkflow ? [{ path: ".github/workflows/build.yml", content: "name: build" }] : [];
  return {
    additions,
    deletions: [],
    summary: { layouts: 0, includes: 0, stylesheets: 0, scripts: 0, workflows: additions.length, dataFiles: 0, other: 0, deletions: 0, total: additions.length },
  };
}

function sheetActionRequest(intent: string, fields: Record<string, string> = {}): Request {
  const form = new URLSearchParams({ intent, siteId: "1", ...fields });
  return new Request("https://compositor.telar.org/upgrade", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
}

function sheetActionContext(userId = 7) {
  return {
    get: vi.fn(() => ({ id: userId, encrypted_access_token: "enc" })),
    cloudflare: { env: { ENCRYPTION_KEY: "k", SESSION_SECRET: "sess-secret", GITHUB_APP_ID: "a", GITHUB_PRIVATE_KEY: "p", DB: {} } },
  } as never;
}

type Answer = {
  ok: boolean;
  answer?: string;
  error?: string;
  detail?: Record<string, string>;
  notice?: string | null;
  challenge?: { content: { pending: unknown[] } };
  groups?: Array<{ file: string; positions: number[]; needsChoice: boolean }>;
  prepared?: Record<string, unknown>;
  advancesHead?: boolean;
  sheetReport?: Array<{ kind: string; chosen?: boolean }>;
  answers?: Array<{ story: string; step: string; position: number | null; checks: Array<{ code: string }> }>;
};

async function postSheetAction(intent: string, fields: Record<string, string> = {}, userId = 7): Promise<Answer> {
  return (await action({ request: sheetActionRequest(intent, fields), context: sheetActionContext(userId), params: {} } as never)) as Answer;
}

const prepareSheets = (fields: Record<string, string> = {}, userId = 7) => postSheetAction("upgrade-prepare", fields, userId);
const answerQuestion = (asked: Answer, choices: unknown, userId = 7) =>
  prepareSheets({ challenge: JSON.stringify(asked.challenge), choices: JSON.stringify(choices) }, userId);
const commitSheets = (ready: Answer) => postSheetAction("upgrade-commit", { preparedState: JSON.stringify(ready.prepared) });

function sheetLeaseCalls(): unknown[] {
  return vi.mocked(controlFreezeLease).mock.calls.map((c) => c[3]);
}

const BOTH_HOLD = "step,answer,note,Note\n1,Here.,a,b\n";
const KEEP_NOTE = [{ file: `${DIR}/my-story.csv`, positions: [2, 3], keep: 3 }];

beforeEach(() => {
  vi.clearAllMocks();
  configSetCalls.length = 0;
  site.config = CONFIG;
  site.head = "head-1";
  site.truncated = false;
  site.lossy = [];
  site.listingFails = false;
  site.version = "1.7.0";
  site.stories = ["my-story"];
  site.files = { [`${DIR}/my-story.csv`]: BOTH_HOLD };
  vi.mocked(fetchLatestRelease).mockResolvedValue({ tagName: "v1.8.0", body: "", publishedAt: "2026-03-01T00:00:00Z" } as never);
  vi.mocked(computeUpgradeDiff).mockResolvedValue(upgradeDiffFor() as never);
  vi.mocked(loadManifestChain).mockResolvedValue(CHAIN);
});

describe("the releases the repair is for", () => {
  it("leaves colliding columns alone on an upgrade to 1.7.0, which reads them as it always has", async () => {
    vi.mocked(fetchLatestRelease).mockResolvedValue({ tagName: "v1.7.0", body: "", publishedAt: "2026-03-01T00:00:00Z" } as never);
    vi.mocked(loadManifestChain).mockResolvedValue([{ ...CHAIN[0], from_version: "1.6.0", to_version: "1.7.0" }]);
    const ready = await prepareSheets();
    expect(ready).toMatchObject({ ok: true, answer: "ready" });
    expect(ready.prepared).toMatchObject({ sheetReport: [], advancesHead: true });
    const additions = ready.prepared?.additions as Array<{ path: string }>;
    expect(additions.map((a) => a.path)).not.toContain(`${DIR}/my-story.csv`);
  });

  it("does not list the sheets for a 1.7.0 target, so a truncated tree whose listing fails still prepares", async () => {
    vi.mocked(fetchLatestRelease).mockResolvedValue({ tagName: "v1.7.0", body: "", publishedAt: "2026-03-01T00:00:00Z" } as never);
    vi.mocked(loadManifestChain).mockResolvedValue([{ ...CHAIN[0], from_version: "1.6.0", to_version: "1.7.0" }]);
    site.truncated = true;
    site.listingFails = true;
    expect(await prepareSheets()).toMatchObject({ ok: true, answer: "ready" });
    expect(listDirectoryEntries).not.toHaveBeenCalled();
  });

  it("prepares when the other language's project sheet is not text, since the build never opens it", async () => {
    site.files = {
      [`${DIR}/project.csv`]: "order,story_id,title\n1,s,T\n",
      [`${DIR}/proyecto.csv`]: "\ufffd",
    };
    site.lossy = [`${DIR}/proyecto.csv`];
    expect(await prepareSheets()).toMatchObject({ ok: true, answer: "ready" });
  });

  it("repairs on an upgrade to a 1.8.0 release candidate, which installs 1.8.0", async () => {
    vi.mocked(fetchLatestRelease).mockResolvedValue({ tagName: "v1.8.0-rc.1", body: "", publishedAt: "2026-03-01T00:00:00Z" } as never);
    expect(await prepareSheets()).toMatchObject({ ok: true, answer: "needs_choices" });
  });
});

describe("prepare's question", () => {
  it("asks which column to keep, with a signed challenge, and ends its lease", async () => {
    const asked = await prepareSheets();
    expect(asked).toMatchObject({ ok: true, answer: "needs_choices", notice: null });
    expect(asked.groups).toMatchObject([{ file: `${DIR}/my-story.csv`, positions: [2, 3], needsChoice: false }]);
    expect(asked.challenge?.content.pending).toHaveLength(1);
    expect(sheetLeaseCalls()).toEqual([
      { op: "begin", kind: "upgrade", operationId: "op-test" },
      { op: "end", operationId: "op-test", outcome: "failed" },
    ]);
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("finds every sheet when the tree comes back truncated, by listing the directory on its own", async () => {
    site.truncated = true;
    const asked = await prepareSheets();
    expect(listDirectoryEntries).toHaveBeenCalledWith("install-token", "student", "my-site", "head-1", DIR);
    expect(asked.answer).toBe("needs_choices");
  });

  it("answers the choice with a prepared upgrade that holds a new lease", async () => {
    const asked = await prepareSheets();
    vi.mocked(controlFreezeLease).mockClear();
    const ready = await answerQuestion(asked, KEEP_NOTE);
    expect(ready).toMatchObject({ ok: true, answer: "ready" });
    expect(ready.prepared).toMatchObject({ advancesHead: false, sheetsClean: false });
    expect(sheetLeaseCalls()).toEqual([{ op: "begin", kind: "upgrade", operationId: "op-test" }]);
  });

  it("refuses a challenge that was altered, and one signed for another user", async () => {
    const asked = await prepareSheets();
    const altered = { ...asked.challenge, content: { ...asked.challenge!.content, headOid: "head-9" } };
    expect(await prepareSheets({ challenge: JSON.stringify(altered), choices: JSON.stringify(KEEP_NOTE) })).toMatchObject({
      ok: false,
      error: "invalid_upgrade_challenge",
    });
    expect(await answerQuestion(asked, KEEP_NOTE, 99)).toMatchObject({ ok: false, error: "invalid_upgrade_challenge" });
    expect(await prepareSheets({ challenge: "not json", choices: "[]" })).toMatchObject({ ok: false, error: "invalid_upgrade_challenge" });
  });

  it("asks again when a push lands between the question and the answer, and the choice is void", async () => {
    const asked = await prepareSheets();
    site.head = "head-2";
    const again = await answerQuestion(asked, KEEP_NOTE);
    expect(again).toMatchObject({ ok: true, answer: "needs_choices", notice: "sheets_changed" });
  });

  it("asks again, flagging the group, when the answer names no column of it", async () => {
    const asked = await prepareSheets();
    const again = await answerQuestion(asked, [{ file: `${DIR}/my-story.csv`, positions: [2, 3], keep: 0 }]);
    expect(again).toMatchObject({ answer: "needs_choices", notice: "choice_needed" });
    expect(again.groups?.[0].needsChoice).toBe(true);
  });

  it.each([
    ["a _metadata column", "step,answer,_metadata\n1,Here.,x\n", "sheet_reserved_column", { sheet: "my-story.csv", column: "_metadata" }],
    ["a removal that would change the rows", "step,paso,note,Note\n1,,x,y\n,\n", "sheet_rows_changed", { sheet: "my-story.csv", columns: "paso", reason: "rows_changed" }],
    ["a sheet it cannot split", 'a,A\nx,"y"z\n', "sheet_unreadable_for_repair", { sheet: "my-story.csv", columns: "a, A" }],
  ])("stops by name on %s, and ends its lease", async (_label, text, error, detail) => {
    site.files = { [`${DIR}/my-story.csv`]: text };
    expect(await prepareSheets()).toMatchObject({ ok: false, error, detail });
    expect(sheetLeaseCalls()).toContainEqual({ op: "end", operationId: "op-test", outcome: "failed" });
  });
});

describe("the commit", () => {
  it("writes the author's choice verbatim, and leaves the recorded head where it was", async () => {
    const ready = await answerQuestion(await prepareSheets(), KEEP_NOTE);
    const res = await commitSheets(ready);
    expect(res).toMatchObject({ ok: true, advancesHead: false });
    expect(res.sheetReport).toMatchObject([{ kind: "dropped", chosen: true }]);
    const additions = vi.mocked(commitFilesToRepo).mock.calls[0][4];
    expect(additions).toContainEqual({ path: `${DIR}/my-story.csv`, content: "step,answer,Note\n1,Here.,b\n", verbatim: true });
    expect(bumpProjectHeadFrom).not.toHaveBeenCalled();
    expect(configSetCalls).toContainEqual(expect.objectContaining({ telar_version: "1.8.0" }));
  });

  it("advances the recorded head after dropping an empty column, with no question asked", async () => {
    site.files = { [`${DIR}/my-story.csv`]: "﻿step,answer,note,Note\r\n1,Here.,,b\r\n" };
    const ready = await prepareSheets();
    expect(ready.answer).toBe("ready");
    const res = await commitSheets(ready);
    expect(res).toMatchObject({ ok: true, advancesHead: true });
    expect(vi.mocked(commitFilesToRepo).mock.calls[0][4]).toContainEqual({
      path: `${DIR}/my-story.csv`,
      content: "﻿step,answer,Note\r\n1,Here.,b\r\n",
      verbatim: true,
    });
    expect(bumpProjectHeadFrom).toHaveBeenCalledWith(expect.anything(), 1, "head-1", "new-head");
  });

  describe("on the partial path, where the workflow commit is refused", () => {
    beforeEach(() => {
      vi.mocked(computeUpgradeDiff).mockResolvedValue(upgradeDiffFor(true) as never);
      vi.mocked(commitFilesToRepo)
        .mockResolvedValueOnce({ newHeadSha: "content-head" })
        .mockRejectedValueOnce(new Error("Resource not accessible by integration"));
    });

    it("leaves the recorded head where it was after the author's choice", async () => {
      const ready = await answerQuestion(await prepareSheets(), KEEP_NOTE);
      expect(await commitSheets(ready)).toMatchObject({ ok: false, error: "insufficient_permissions" });
      expect(bumpProjectHeadFrom).not.toHaveBeenCalled();
    });

    it("advances it to the content commit after empty-column drops only", async () => {
      site.files = { [`${DIR}/my-story.csv`]: "step,answer,note,Note\n1,Here.,,b\n" };
      const ready = await prepareSheets();
      expect(await commitSheets(ready)).toMatchObject({ ok: false, error: "insufficient_permissions" });
      expect(bumpProjectHeadFrom).toHaveBeenCalledWith(expect.anything(), 1, "head-1", "content-head");
    });
  });
});

describe("the answers the upgraded site publishes differently", () => {
  const LONG = `step,answer\n1,Short.\n2,${LONG_ANSWER}\n`;
  const answersListed = (answer: Answer) => (answer.answers ?? []).map((a) => [a.story, a.step, a.checks.map((c) => c.code)]);

  it("lists them in the signed prepared upgrade, and the commit carries them to the done screen", async () => {
    site.files = { [`${DIR}/my-story.csv`]: LONG };
    const ready = await prepareSheets();
    expect(answersListed(ready.prepared as Answer)).toEqual([["my-story", "2", ["step_answer_over_limit"]]]);
    const res = await commitSheets(ready);
    expect(res.ok).toBe(true);
    expect(answersListed(res)).toEqual([["my-story", "2", ["step_answer_over_limit"]]]);
  });

  it("gives a step its place in a story the project holds, and none in one it lacks", async () => {
    site.files = { [`${DIR}/my-story.csv`]: LONG };
    expect(((await prepareSheets()).prepared as Answer).answers?.map((a) => a.position)).toEqual([2]);
    site.stories = [];
    expect(((await prepareSheets()).prepared as Answer).answers?.map((a) => a.position)).toEqual([null]);
  });

  it("refuses a commit whose list was changed after signing", async () => {
    site.files = { [`${DIR}/my-story.csv`]: LONG };
    const ready = await prepareSheets();
    const tampered = { ...ready, prepared: { ...ready.prepared, answers: [] } };
    expect(await commitSheets(tampered)).toMatchObject({ ok: false, error: "invalid_prepared_state" });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("lists nothing for a site already on 1.8.0", async () => {
    site.version = "1.8.0";
    site.files = { [`${DIR}/my-story.csv`]: LONG };
    vi.mocked(fetchLatestRelease).mockResolvedValue({ tagName: "v1.8.1", body: "", publishedAt: "2026-03-01T00:00:00Z" } as never);
    vi.mocked(loadManifestChain).mockResolvedValue([{ ...CHAIN[0], from_version: "1.8.0", to_version: "1.8.1" }]);
    const ready = await prepareSheets();
    expect(ready.answer).toBe("ready");
    expect((ready.prepared as Answer).answers).toEqual([]);
  });
});

describe("a site that reads Google Sheets", () => {
  const PUB = "https://docs.google.com/spreadsheets/d/e/PUB/pubhtml";
  const SHEETS_ON = `${CONFIG}google_sheets:\n  enabled: true\n  published_url: "${PUB}"\n`;

  /** The published sheet: its page lists `tabs` by name and gid; each gid's CSV is `csv[gid]`. */
  function publishTabs(tabs: Array<[string, string]>, csv: Record<string, string>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === PUB) return new Response(tabs.map(([name, gid]) => `items.push({name: "${name}", gid: "${gid}"});`).join(""));
        const body = csv[new URL(url).searchParams.get("gid") as string];
        return body === undefined ? new Response("", { status: 404 }) : new Response(body);
      }),
    );
  }

  beforeEach(() => {
    site.config = SHEETS_ON;
    site.files = { [`${DIR}/my-story.csv`]: "step,answer\n1,Here.\n" };
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const answerOffer = (asked: Answer, sheets: string) => prepareSheets({ challenge: JSON.stringify(asked.challenge), sheets });

  it("offers to stop reading Google Sheets where a tab would be refused, ending the lease and committing nothing", async () => {
    publishTabs([["my-story", "1"]], { "1": BOTH_HOLD });
    const asked = await prepareSheets();
    expect(asked).toMatchObject({
      ok: true,
      answer: "needs_sheets_decision",
      notice: null,
      detail: { tabs: "my-story", count: 1, collisions: [{ tab: "my-story", columns: ["note", "Note"] }] },
    });
    expect(sheetLeaseCalls()).toContainEqual({ op: "end", operationId: "op-test", outcome: "failed" });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("stops with the tabs the 1.8.0 build would refuse named when the author keeps Google Sheets", async () => {
    publishTabs([["my-story", "1"]], { "1": BOTH_HOLD });
    const answer = await answerOffer(await prepareSheets(), "keep");
    expect(answer).toMatchObject({
      ok: false,
      error: "sheets_columns_refused",
      detail: { tabs: "my-story", count: 1, collisions: [{ tab: "my-story", columns: ["note", "Note"] }] },
    });
    expect(sheetLeaseCalls()).toContainEqual({ op: "end", operationId: "op-test", outcome: "failed" });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("goes ahead on clean tabs, with the tabs-checked notice signed into the prepared upgrade", async () => {
    publishTabs([["my-story", "1"]], { "1": "step,answer\n1,Here.\n,FALSE\n" });
    const ready = await prepareSheets();
    expect(ready).toMatchObject({ ok: true, answer: "ready" });
    expect(ready.prepared).toMatchObject({ tabsChecked: true, sheetReport: [] });
    const tampered = { ...ready, prepared: { ...ready.prepared, tabsChecked: false } };
    expect(await commitSheets(tampered)).toMatchObject({ ok: false, error: "invalid_prepared_state" });
  });

  it("stops with published_sheet_unreadable, naming nothing, when it lists no tab", async () => {
    publishTabs([], {});
    const answer = await prepareSheets();
    expect(answer).toMatchObject({ ok: false, error: "published_sheet_unreadable" });
    expect((answer as { detail?: unknown }).detail).toBeUndefined();
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("stops with published_tab_unreadable, naming the tab, when a tab cannot be read", async () => {
    publishTabs([["my-story", "1"]], {});
    expect(await prepareSheets()).toMatchObject({ ok: false, error: "published_tab_unreadable", detail: { name: "my-story" } });
  });

  describe("switched off in the upgrade", () => {
    const TAB = "step,answer,note,Note\n1,From the tab.,,x\n";

    beforeEach(() => {
      publishTabs([["proyecto", "1"], ["my-story", "2"]], { "1": "order,story_id\n1,my-story\n", "2": TAB });
      site.files = { [`${DIR}/proyecto.csv`]: "order,story_id\n1,old\n", [`${DIR}/my-story.csv`]: "step,answer\n1,Old.\n" };
    });

    async function switchedOff(): Promise<Answer> {
      const ready = await answerOffer(await prepareSheets(), "off");
      expect(ready).toMatchObject({ ok: true, answer: "ready" });
      return ready;
    }

    it("commits the tabs as the site's CSVs and _config.yml switched off, and only then sets the site's settings", async () => {
      const ready = await switchedOff();
      expect(ready.prepared).toMatchObject({
        sheetsOff: { written: [`${DIR}/my-story.csv`, `${DIR}/project.csv`], deleted: [`${DIR}/proyecto.csv`] },
        readsGoogleSheetsAfter: false,
        tabsChecked: false,
        advancesHead: false,
      });
      expect(configSetCalls).not.toContainEqual(expect.objectContaining({ google_sheets_enabled: false }));
      const res = await commitSheets(ready);
      expect(res).toMatchObject({ ok: true, readsGoogleSheetsAfter: false, sheetsOff: { deleted: [`${DIR}/proyecto.csv`] } });
      const [, , , , additions, , , deletions] = vi.mocked(commitFilesToRepo).mock.calls[0];
      expect(additions).toContainEqual({ path: `${DIR}/my-story.csv`, content: "step,answer,Note\n1,From the tab.,x\n", verbatim: true });
      expect(additions).toContainEqual({ path: `${DIR}/project.csv`, content: "order,story_id\n1,my-story\n", verbatim: true });
      expect(additions.find((a) => a.path === "_config.yml")?.content).toContain("enabled: false");
      expect(additions.map((a) => a.path)).not.toContain(`${DIR}/proyecto.csv`);
      expect(deletions).toEqual([`${DIR}/proyecto.csv`]);
      expect(configSetCalls).toContainEqual(expect.objectContaining({ google_sheets_enabled: false }));
      expect(bumpProjectHeadFrom).not.toHaveBeenCalled();
    });

    it("switches _config.yml off in the content commit, so a refused workflow commit leaves no tab saved while Sheets is on, and a retry finishes off", async () => {
      vi.mocked(computeUpgradeDiff).mockResolvedValue(upgradeDiffFor(true) as never);
      vi.mocked(commitFilesToRepo)
        .mockResolvedValueOnce({ newHeadSha: "content-head" })
        .mockRejectedValueOnce(new Error("Resource not accessible by integration"));
      expect(await commitSheets(await switchedOff())).toMatchObject({ ok: false, error: "insufficient_permissions" });
      const [, , , , additions, , , deletions] = vi.mocked(commitFilesToRepo).mock.calls[0];
      const config = additions.find((a) => a.path === "_config.yml")?.content ?? "";
      expect(config).toBe(`${CONFIG}google_sheets:\n  enabled: false\n  published_url: "${PUB}"\n`);
      expect(additions.map((a) => a.path)).toContain(`${DIR}/project.csv`);
      expect(deletions).toEqual([`${DIR}/proyecto.csv`]);
      expect(configSetCalls).toContainEqual(expect.objectContaining({ google_sheets_enabled: false }));
      expect(bumpProjectHeadFrom).not.toHaveBeenCalled();

      // The retry reads the site as the content commit left it.
      for (const path of deletions ?? []) delete site.files[path];
      for (const a of additions) {
        if (a.path === "_config.yml") site.config = a.content;
        else site.files[a.path] = a.content;
      }
      site.head = "content-head";
      vi.mocked(commitFilesToRepo).mockReset().mockResolvedValue({ newHeadSha: "new-head" });
      const retry = await prepareSheets();
      expect(retry).toMatchObject({ ok: true, answer: "ready", prepared: { readsGoogleSheetsAfter: false, sheetsOff: null } });
      expect((retry.prepared?.additions as Array<{ path: string; content: string }>).find((a) => a.path === "_config.yml")?.content).toContain(
        "enabled: false",
      );
    });

    it("offers again, saying the sheets changed, when a push lands between the offer and the answer", async () => {
      const asked = await prepareSheets();
      site.head = "head-2";
      expect(await answerOffer(asked, "off")).toMatchObject({ ok: true, answer: "needs_sheets_decision", notice: "sheets_changed" });
    });

    it("stops with sheets_switch_unreadable where _config.yml cannot be switched off", async () => {
      site.config = `${CONFIG}google_sheets: {enabled: "True", published_url: "${PUB}"}\n`;
      expect(await answerOffer(await prepareSheets(), "off")).toMatchObject({ ok: false, error: "sheets_switch_unreadable" });
      expect(commitFilesToRepo).not.toHaveBeenCalled();
    });
  });
});
