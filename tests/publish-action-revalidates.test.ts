/**
 * The publish action is the only pass whose validation the published content
 * was actually measured against.
 *
 * Two snapshots exist per publish. The loader forces one so it can diff D1, and
 * the action forces its own before assembling the file set. Everything the page
 * computes — the change summary, the checks, the commit message — comes from
 * the loader's, which may have failed or may simply be minutes old, while what
 * ships is whatever the action's snapshot lands in D1. The page's pass is
 * therefore advisory: it describes a state that is not necessarily the one
 * being published, and it runs in the browser, where a direct POST skips it
 * outright.
 *
 * So the blocker check is re-run in the action, after its snapshot and before
 * the file set is built, against the rows that are about to be committed.
 * Content carrying a blocker cannot reach GitHub under a verdict that never saw
 * it, and a clean site is never held back — the re-check refuses only on the
 * blockers the page already refuses on.
 *
 * @version v1.5.0-beta
 */

import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks. Resolved-module-id equality is what vi.mock matches on: the route
// imports signInternalMarker from "../../workers/auth" (app/routes/ → root),
// and this file reaches the same module via "../workers/auth".
// ---------------------------------------------------------------------------

vi.mock("~/middleware/auth.server", () => ({
  userContext: Symbol("userContext"),
}));
// The objects operations a publish finishes first are tested in
// tests/publish-pending-objects.test.ts; here there are none.
vi.mock("~/lib/pending-object-ops.server", () => import("./helpers/pending-object-ops-passthrough"));

// Rows the next `db.select(...)` chain resolves to. The action's re-check
// fetches page rows, story rows, object rows and glossary rows; a test sets
// whichever it wants that check to see. Which row set a given `select(...)` call
// resolves to is decided by the columns it asks for (a `story_id` column means
// the story fetch, an `object_id` column the object fetch, a `term_id` column
// the glossary fetch), not by call order — the fetches run via Promise.all and
// their order is not a contract worth pinning.
const { pageRows, storyRows, objectRows, glossaryRows, stepRows, configRows, layerRows, layersReadFails } =
  vi.hoisted(() => ({
    pageRows: { current: [] as unknown[] },
    storyRows: { current: [] as unknown[] },
    objectRows: { current: [] as unknown[] },
    glossaryRows: { current: [] as unknown[] },
    stepRows: { current: [] as unknown[] },
    configRows: { current: [] as unknown[] },
    layerRows: { current: [] as unknown[] },
    /** Whether the layers query rejects, as a D1 read can. */
    layersReadFails: { current: false },
  }));

vi.mock("~/lib/db.server", () => ({
  getDb: vi.fn(() => ({
    select: (columns?: Record<string, unknown>) => {
      let rows: unknown[];
      // step_number is tested before story_id: the step fetch joins the story
      // in and so asks for both.
      // Step rows come back holding only the columns the select names, as D1
      // returns them, so a blocker input the action does not fetch is absent.
      if (columns && "step_number" in columns) {
        rows = (stepRows.current as Array<Record<string, unknown>>).map((row) =>
          Object.fromEntries(Object.keys(columns).filter((k) => k in row).map((k) => [k, row[k]])),
        );
      }
      else if (columns && "story_id" in columns) rows = storyRows.current;
      else if (columns && "object_id" in columns) rows = objectRows.current;
      else if (columns && "term_id" in columns) rows = glossaryRows.current;
      else if (columns && "step_id" in columns) rows = layerRows.current;
      // A select naming no columns is the whole-row read, and the only one the
      // action makes is the project_config row.
      else if (columns === undefined) rows = configRows.current;
      else rows = pageRows.current;
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.innerJoin = () => chain;
      const failed = layersReadFails.current && columns !== undefined && "step_id" in columns;
      chain.where = () =>
        Object.assign(failed ? Promise.reject(new Error("D1 unavailable")) : Promise.resolve(rows), chain);
      // A read ordered with `.orderBy()` (objects, in `objectsSheetOrder`) answers the same rows.
      chain.orderBy = function (this: unknown) { return this; };
      chain.limit = () => Promise.resolve(rows);
      return chain;
    },
  })),
}));

vi.mock("~/lib/session.server", () => ({
  createSessionStorage: vi.fn(() => ({
    getSession: vi.fn(async () => ({ get: vi.fn(() => 1) })),
  })),
}));

vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn(async () => "tok") }));

vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(async () => ({
    project: {
      id: 7,
      github_repo_full_name: "owner/repo",
      installation_id: 55,
      // The recorded head, the one the repository is at: a publish commits only on it.
      head_sha: "sha-at-the-start",
      publish_snapshot: null,
    },
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

// The publish path reaches GitHub after the file set is built. Stubbed so the
// assertions here are about the action's control flow, not the network.
vi.mock("~/lib/upgrade.server", () => ({
  healMissingFrameworkFiles: vi.fn(async () => []),
}));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(async () => ({ newHeadSha: "new-sha" })),
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));

// The _config.yml the action reads to judge whether it can write the managed
// blocks. Null stands for a repository with no such file, which is a legitimate
// site; `configReadFails` stands for a read that could not find out.
const { configYmlAtRef, configReadFails } = vi.hoisted(() => ({
  configYmlAtRef: { current: null as string | null },
  configReadFails: { current: false },
}));
vi.mock("~/lib/github.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    // The action resolves the revision it publishes before anything else, so
    // every case here needs one; which SHA it is does not matter to them.
    getRepoHead: vi.fn(async () => "sha-at-the-start"),
    // A repository with no story files: a story with no steps is one the
    // kept-columns capture reads, and there is nothing for it to read.
    getSubtreeOids: vi.fn(async () => ({ ok: true, at: () => ({ kind: "absent" }) })),
    getFileAtRef: vi.fn(async (_t: string, _o: string, _r: string, path: string) =>
      configReadFails.current && path === "_config.yml"
        ? { status: "error" }
        : configYmlAtRef.current === null
        ? { status: "absent" }
        : { status: "ok", content: configYmlAtRef.current },
    ),
  };
});

const { buildPublishFileSet } = vi.hoisted(() => ({
  buildPublishFileSet: vi.fn(async () => [] as unknown[]),
}));
vi.mock("~/lib/publish.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, buildPublishFileSet };
});

import { action } from "~/routes/_app.publish";
import { getFileAtRef } from "~/lib/github.server";
import { runPrePublishValidation, UnreadablePageError, UnwritableConfigBlockError } from "~/lib/publish.server";
import { commitFilesToRepo } from "~/lib/commit.server";
import { sha256Hex } from "~/lib/story-canonical";
import enPublish from "~/i18n/locales/en/publish.json";
import esPublish from "~/i18n/locales/es/publish.json";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type DOFetch = (request: Request) => Promise<Response>;

function buildContext(doFetch: DOFetch) {
  const doStub = { fetch: doFetch };
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

function publishRequest(fields: Record<string, string> = {}): Request {
  const form = new FormData();
  form.set("intent", "publish");
  form.set("commitMessage", "Publish site");
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  // The mocked active project's id, string-compared by `resolvePageProject`.
  form.set("siteId", "7");
  return new Request("https://app/publish", {
    method: "POST",
    body: form,
    headers: { Cookie: "" },
  });
}

const snapshotOk: DOFetch = async () => new Response("OK", { status: 200 });

async function runPublish(doFetch: DOFetch = snapshotOk, fields: Record<string, string> = {}) {
  return (await action({
    request: publishRequest(fields),
    context: buildContext(doFetch),
    params: {},
  } as unknown as Parameters<typeof action>[0])) as { error?: string; intent?: string; warnings?: Array<{ code: string; entityId?: string; replacedSettings?: { pageId: number; fingerprint: string } }> };
}

beforeEach(() => {
  vi.clearAllMocks();
  pageRows.current = [];
  storyRows.current = [];
  objectRows.current = [];
  glossaryRows.current = [];
  stepRows.current = [];
  configRows.current = [];
  layerRows.current = [];
  layersReadFails.current = false;
  configYmlAtRef.current = null;
  configReadFails.current = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// The defect
// ---------------------------------------------------------------------------

describe("publish action — the blocker check runs against what is being published", () => {
  it("refuses, and builds no file set, when the post-snapshot rows carry a blocker", async () => {
    // A page with no title cannot be published at all — it has no usable URL
    // and `pageRowsToCommitFiles` drops it. The page's own pass would refuse,
    // but it measured D1 before this snapshot ran.
    pageRows.current = [{ slug: "", title: "" }];

    const res = await runPublish();

    expect(res).toMatchObject({
      ok: false,
      intent: "publish",
      error: "validation_blocked",
    });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  it("refuses before the file set is built, not after the commit", async () => {
    pageRows.current = [
      { slug: "about", title: "About" },
      { slug: "", title: "   " },
    ];

    const res = await runPublish();

    expect(res).toMatchObject({ error: "validation_blocked" });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  it("refuses when the post-snapshot rows carry an untitled, non-draft story", async () => {
    // Same shape as the untitled-page case above: the page's own pass would
    // have refused, but it measured D1 before this snapshot ran.
    storyRows.current = [{ story_id: "weavers", title: null, draft: false }];

    const res = await runPublish();

    expect(res).toMatchObject({
      ok: false,
      intent: "publish",
      error: "validation_blocked",
    });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  it("does not refuse over an untitled DRAFT story", async () => {
    // A draft never reaches the published index, so its missing title
    // cannot ship a blank entry — nothing here for the re-check to block.
    storyRows.current = [{ story_id: "draft-weavers", title: null, draft: true }];

    const res = await runPublish();

    expect(res?.error).not.toBe("validation_blocked");
    expect(buildPublishFileSet).toHaveBeenCalledTimes(1);
  });

  // This call must fetch the object rows. Passing `objects: []` to the
  // re-check would let a reserved-column blocker display in the page's own
  // Checks pass (which does see real object rows) yet never reach this, the
  // pass that actually stops the publish — a blocker that displays but does
  // not enforce.
  it("refuses when the post-snapshot rows carry an object with a reserved column name", async () => {
    objectRows.current = [
      { object_id: "sculpture-1", extra_columns: JSON.stringify({ _metadata: "forged" }) },
    ];

    const res = await runPublish();

    expect(res).toMatchObject({
      ok: false,
      intent: "publish",
      error: "validation_blocked",
    });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  // The same shape for the glossary, and the reason the glossary rows are
  // FETCHED here at all: a re-check handed `glossary: []` would pass a site
  // whose glossary.csv is about to be published with a column the framework's
  // build refuses.
  it("refuses when the post-snapshot rows carry a glossary term with a reserved column name", async () => {
    glossaryRows.current = [
      { term_id: "backstrap-loom", extra_columns: JSON.stringify({ _Metadata: "forged" }) },
    ];

    const res = await runPublish();

    expect(res).toMatchObject({
      ok: false,
      intent: "publish",
      error: "validation_blocked",
    });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  // The blocker's whole point is the file, so this pass has to read the file.
  // Without it a direct submission of this action publishes over a managed
  // block the writer cannot edit, and the writer's answer — before it was made
  // to refuse — was to leave the block alone and say nothing.
  it("refuses when the file it is about to write holds a block it cannot edit", async () => {
    pageRows.current = [{ slug: "about", title: "About" }];
    configYmlAtRef.current = "story_interface:\n  {show_on_homepage: true}\n";

    const res = await runPublish();

    expect(res).toMatchObject({ ok: false, intent: "publish", error: "validation_blocked" });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  // "This repository has no _config.yml" and "we could not find out" are not
  // the same answer, and reading both as no file is how the original symptom is
  // reached without any YAML being wrong: the checks judge nothing, the
  // assembly writes no config, and the publish reports success over settings
  // that never left the compositor.
  it("refuses when it could not find out whether the repository has a _config.yml", async () => {
    pageRows.current = [{ slug: "about", title: "About" }];
    configReadFails.current = true;

    const res = await runPublish();

    expect(res).toMatchObject({ ok: false, intent: "publish", error: "config_unreadable" });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  // A refusal is only a refusal the author can read if the page has a sentence
  // for its code. Without one it falls back to the generic build failure, which
  // is the unexplained refusal this issue is against.
  it("refuses with a code both catalogues have a sentence for", () => {
    for (const catalogue of [enPublish, esPublish]) {
      expect(Object.keys(catalogue.build)).toContain("config_unreadable");
    }
  });

  // The helper reads a 200 carrying no usable content — what GitHub sends for a
  // file past its inline size — as "absent" for a differ and as "error" for a
  // caller that will rewrite the file. This is the caller that rewrites it, so
  // asking for the lenient reading would answer "no _config.yml here" for a file
  // that is merely large, and publish over the settings in it.
  it("reads the file it will rewrite in the mode meant for rewriting", async () => {
    pageRows.current = [{ slug: "about", title: "About" }];
    configYmlAtRef.current = "title: A site\n";

    await runPublish();

    const call = vi
      .mocked(getFileAtRef)
      .mock.calls.find((args) => args[3] === "_config.yml");
    expect(call, "the publish never read _config.yml").toBeDefined();
    expect(call?.[5]).toEqual({ strict: true });
  });

  it("publishes a repository that legitimately has no _config.yml", async () => {
    pageRows.current = [{ slug: "about", title: "About" }];
    configYmlAtRef.current = null;

    const res = await runPublish();

    expect(res?.error).not.toBe("config_unreadable");
    expect(buildPublishFileSet).toHaveBeenCalledTimes(1);
  });

  it("publishes a file whose managed blocks are ordinary indented blocks", async () => {
    pageRows.current = [{ slug: "about", title: "About" }];
    configYmlAtRef.current = "story_interface:\n  show_on_homepage: true\n";

    const res = await runPublish();

    expect(res?.error).not.toBe("validation_blocked");
    expect(buildPublishFileSet).toHaveBeenCalledTimes(1);
  });

  // The check's answer is the file AND the row together: the heal repairs a
  // broken managed line only where the row has a value to write over it. A row
  // read a second time for the write is a second snapshot of it, and a settings
  // save landing between the two turns a check that passed into a write
  // silently skipped — the defect this issue is about, through the other input.
  it("hands the file set the project_config row its check judged", async () => {
    pageRows.current = [{ slug: "about", title: "About" }];
    configRows.current = [{ project_id: 7, title: "A site", theme: "plain" }];
    configYmlAtRef.current = 'title: "A site"\ntelar_theme: [bad\n';

    const res = await runPublish();

    expect(res?.error).not.toBe("validation_blocked");
    expect(buildPublishFileSet).toHaveBeenCalledWith(
      expect.objectContaining({ config: configRows.current[0] }),
    );
  });

  // The residual race: the file passed the check and changed before the write.
  // The writer refuses rather than committing a config that disagrees with D1,
  // and the author is told to reload, where the check names the block.
  it("reports a writer's refusal as a blocked validation, not a failed commit", async () => {
    pageRows.current = [{ slug: "about", title: "About" }];
    buildPublishFileSet.mockRejectedValueOnce(new UnwritableConfigBlockError("story_interface"));

    const res = await runPublish();

    expect(res).toMatchObject({ ok: false, intent: "publish", error: "validation_blocked" });
  });

  // A page never captured has its file read to carry its front matter
  // forward; a read that fails is a publish that stops before any commit,
  // not a page written without its keys.
  it("stops before the commit when a page file could not be read to carry its front matter", async () => {
    pageRows.current = [{ slug: "about", title: "About" }];
    buildPublishFileSet.mockRejectedValueOnce(new UnreadablePageError("telar-content/texts/pages/about.md"));

    const res = await runPublish();

    expect(res).toMatchObject({ ok: false, intent: "publish", error: "page_unreadable" });
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("stops with a code both catalogues have a sentence for", () => {
    for (const catalogue of [enPublish, esPublish]) {
      expect(Object.keys(catalogue.build)).toContain("page_unreadable");
    }
    const route = readFileSync("app/routes/_app.publish.tsx", "utf8");
    expect(route).toContain('["page_unreadable", "build.page_unreadable"]');
  });

  // The re-check fetches extra_columns for the reserved-name blocker; the
  // collision blocker reads the same input, so it is enforced here too.
  it("refuses when the post-snapshot rows carry two columns Telar reads as one field", async () => {
    glossaryRows.current = [
      { term_id: "backstrap-loom", extra_columns: JSON.stringify({ credit: "a", "crédito": "b" }) },
    ];

    const res = await runPublish();

    expect(res).toMatchObject({ ok: false, intent: "publish", error: "validation_blocked" });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The honest paths — a publish this refuses is worse than the defect.
// ---------------------------------------------------------------------------

describe("publish action — a clean site still publishes", () => {
  it("lets a site whose pages all have titles through to the file set", async () => {
    pageRows.current = [
      { slug: "about", title: "About" },
      { slug: "team", title: "Our team" },
    ];

    const res = await runPublish();

    expect(res?.error).not.toBe("validation_blocked");
    expect(buildPublishFileSet).toHaveBeenCalledTimes(1);
  });

  it("lets a site with no pages at all through", async () => {
    pageRows.current = [];

    const res = await runPublish();

    expect(res?.error).not.toBe("validation_blocked");
    expect(buildPublishFileSet).toHaveBeenCalledTimes(1);
  });

  it("lets an object with an ordinary custom column through", async () => {
    objectRows.current = [
      { object_id: "sculpture-1", extra_columns: JSON.stringify({ procedencia: "Bogotá" }) },
    ];

    const res = await runPublish();

    expect(res?.error).not.toBe("validation_blocked");
    expect(buildPublishFileSet).toHaveBeenCalledTimes(1);
  });

  it("lets a glossary term with an ordinary custom column through", async () => {
    glossaryRows.current = [
      { term_id: "backstrap-loom", extra_columns: JSON.stringify({ source_note: "Museo del Oro" }) },
    ];

    const res = await runPublish();

    expect(res?.error).not.toBe("validation_blocked");
    expect(buildPublishFileSet).toHaveBeenCalledTimes(1);
  });

  it("does not re-check when the snapshot already refused the publish", async () => {
    // A failed snapshot is its own refusal, and its error code is what tells
    // the author their edits are still in the session. Re-checking stale rows
    // underneath it could only replace that with a less accurate reason.
    pageRows.current = [{ slug: "", title: "" }];

    const res = await runPublish(async () => new Response("no", { status: 500 }));

    expect(res).toMatchObject({ error: "snapshot_failed" });
  });

  it("does not refuse over the repository moving under the author", async () => {
    // `stale_head` is a blocker the page raises from a live GitHub read. It is
    // not a fact about the content this snapshot just wrote, and HEAD can move
    // between the author reading the page and pressing publish — refusing here
    // would cost them a publish for something they were never shown.
    pageRows.current = [{ slug: "about", title: "About" }];

    const res = await runPublish();

    expect(res?.error).not.toBe("validation_blocked");
    expect(buildPublishFileSet).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// The coupling this re-check depends on
// ---------------------------------------------------------------------------

describe("runPrePublishValidation — the blockers a content re-check must cover", () => {
  it("emits exactly stale_head, page_no_title, story_no_title, step_answer_over_limit, object_reserved_column, glossary_reserved_column, glossary_colliding_columns, story_reserved_column, story_colliding_columns and config_unparseable as blockers", () => {
    // The action re-check fetches page rows, story rows, object rows, glossary
    // rows, step rows, the repository's _config.yml and the project's config
    // row, because those are the inputs that can produce a blocker;
    // `stale_head` is deliberately out of its scope. A new blocker code
    // appearing here means the re-check needs that code's input fetched too, or
    // it will ship content the page would have refused.
    //
    // `config_block_unwritable` cannot join this set: it and
    // `config_unparseable` are answers to one write, and a file the writer
    // refuses outright never reaches the parse. Its own file pins it.
    const codes = new Set<string>();

    const worst = runPrePublishValidation({
      headSha: "a",
      currentRepoHead: "b",
      stories: [
        { story_id: "s1", title: "", private: true, draft: false },
        { story_id: "s2", title: null, private: false, draft: true },
        { story_id: "objects", title: "Objects", private: false, draft: false },
      ],
      steps: [
        { id: 1, step_number: 1, object_id: "o1", x: null, y: null, zoom: null, question: null, answer: null },
        {
          id: 2,
          step_number: 2,
          object_id: "o1",
          x: null,
          y: null,
          zoom: null,
          question: null,
          answer: Array.from({ length: 30 }, () => "x".repeat(52)).join(" "),
          story_id: "s1",
          story_title: "",
          // Kept story columns: one the framework reserves, and two it reads
          // as one, so both story column blockers are exercised.
          extra_columns: JSON.stringify({ _metadata: "x", Note: "a", note: "b" }),
        },
      ],
      objects: [
        { object_id: "o1", title: "", extra_columns: JSON.stringify({ _metadata: "x" }) },
      ],
      pages: [{ slug: "", title: "" }],
      glossary: [
        { term_id: "t1", extra_columns: JSON.stringify({ _metadata: "x" }) },
        // A second term carrying two headers the framework renames together,
        // so the collision blocker is exercised rather than merely listed.
        { term_id: "t2", extra_columns: JSON.stringify({ credit: "a", "crédito": "b" }) },
      ],
      storyKey: null,
      // A tab under an unmanaged key: corruption in a place the heal never
      // touches, so the healed file still will not parse and the publish would
      // write no config at all.
      configYml: 'title: "A site"\ndefaults:\n\tscope: all\n',
      config: { title: "A site" } as never,
    });
    for (const b of worst.blockers) codes.add(b.code);

    expect([...codes].sort()).toEqual([
      "config_unparseable",
      "glossary_colliding_columns",
      "glossary_reserved_column",
      "object_reserved_column",
      "page_no_title",
      "stale_head",
      "step_answer_over_limit",
      "story_colliding_columns",
      "story_id_refused",
      "story_no_title",
      "story_reserved_column",
    ]);
  });
});

describe("publish action — the answer length is re-checked too", () => {
  const stepOf = (answer: string) => [
    {
      id: 1,
      step_number: 1,
      object_id: null,
      x: null,
      y: null,
      zoom: null,
      question: null,
      answer,
      story_id: "s1",
      story_title: "A Story",
    },
  ];
  /** One paragraph of n lines: n words of 52 characters. */
  const lines = (n: number) => Array.from({ length: n }, () => "x".repeat(52)).join(" ");

  it("refuses when a post-snapshot step answer is past the budget", async () => {
    pageRows.current = [{ slug: "about", title: "About" }];
    stepRows.current = stepOf(lines(19));

    const res = await runPublish();

    expect(res).toMatchObject({ error: "validation_blocked" });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  // An answer of exactly the budget is published whole.
  it("lets an answer at the budget through", async () => {
    pageRows.current = [{ slug: "about", title: "About" }];
    stepRows.current = stepOf(lines(18));

    const res = await runPublish();

    expect(res?.error).not.toBe("validation_blocked");
    expect(buildPublishFileSet).toHaveBeenCalledTimes(1);
  });
});

describe("publish action — the kept story columns are re-checked too", () => {
  const stepWith = (extras: Record<string, string>) => [
    {
      id: 1,
      step_number: 1,
      object_id: "o1",
      x: 0.5,
      y: 0.5,
      zoom: 1,
      question: "Q",
      answer: "A",
      extra_columns: JSON.stringify(extras),
      story_id: "s1",
      story_title: "A Story",
    },
  ];

  it("refuses when a post-snapshot story keeps a column the framework reserves", async () => {
    pageRows.current = [{ slug: "about", title: "About" }];
    stepRows.current = stepWith({ _metadata: "x" });

    const res = await runPublish();

    expect(res).toMatchObject({ error: "validation_blocked" });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  it("lets an ordinary kept column through", async () => {
    pageRows.current = [{ slug: "about", title: "About" }];
    stepRows.current = stepWith({ layer3_button: "Más" });

    const res = await runPublish();

    expect(res?.error).not.toBe("validation_blocked");
    expect(buildPublishFileSet).toHaveBeenCalledTimes(1);
  });

  // Step 1 carries `Example`; step 2, with no content of its own, carries
  // `example`, and whether the story CSV writes it depends on its kind and
  // layers.
  const droppedExampleStepRows = (step2: Record<string, unknown> = {}) => [
    { ...stepWith({ Example: "a" })[0], kind: "media" },
    {
      id: 2,
      step_number: 2,
      kind: "media",
      object_id: null,
      x: null,
      y: null,
      zoom: null,
      question: null,
      answer: null,
      extra_columns: '{"example":"b"}',
      story_id: "s1",
      story_title: "A Story",
      ...step2,
    },
  ];

  it("lets through a column only a step the story CSV leaves out carries", async () => {
    pageRows.current = [{ slug: "about", title: "About" }];
    stepRows.current = droppedExampleStepRows();

    const res = await runPublish();

    expect(res?.error).not.toBe("validation_blocked");
    expect(buildPublishFileSet).toHaveBeenCalledTimes(1);
  });

  it("refuses that column when its step is a section, which the story CSV always writes", async () => {
    pageRows.current = [{ slug: "about", title: "About" }];
    stepRows.current = droppedExampleStepRows({ kind: "section" });

    const res = await runPublish();

    expect(res).toMatchObject({ error: "validation_blocked" });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  it("refuses that column, judging every step, when the layers cannot be read", async () => {
    pageRows.current = [{ slug: "about", title: "About" }];
    stepRows.current = droppedExampleStepRows();
    layersReadFails.current = true;

    const res = await runPublish();

    expect(res).toMatchObject({ error: "validation_blocked" });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });
});

describe("publish action — settings the author was not warned of are not replaced", () => {
  // A block the writer cannot read as a mapping: the page is written with its
  // title alone, and `language` is gone from the site.
  const BLOCK = "title: [About\nlanguage: es\n";
  const unreadable = { id: 1, slug: "about", title: "About", body: "", frontmatter: BLOCK };

  /** The acknowledgement the page sends for a warning about `block` on page `pageId`. */
  async function acknowledging(...warned: Array<[number, string]>) {
    const settings = await Promise.all(warned.map(async ([pageId, block]) => ({ pageId, fingerprint: await sha256Hex(block) })));
    return { acknowledgedReplacedPages: JSON.stringify(settings) };
  }

  it("refuses without an acknowledgement, names the page and its block, and builds no file set", async () => {
    pageRows.current = [unreadable, { id: 2, slug: "team", title: "Team", body: "", frontmatter: "title: Team\n" }];

    const res = await runPublish();

    expect(res).toMatchObject({ ok: false, intent: "publish", error: "page_frontmatter_unacknowledged" });
    expect(res.warnings?.map((w) => [w.code, w.entityId, w.replacedSettings])).toEqual([
      ["page_frontmatter_replaced", "about", { pageId: 1, fingerprint: await sha256Hex(BLOCK) }],
    ]);
    expect(buildPublishFileSet).not.toHaveBeenCalled();
    expect(commitFilesToRepo).not.toHaveBeenCalled();
  });

  it("refuses when the acknowledgement names another page", async () => {
    pageRows.current = [unreadable];

    const res = await runPublish(snapshotOk, await acknowledging([2, BLOCK]));

    expect(res).toMatchObject({ error: "page_frontmatter_unacknowledged" });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  it("refuses a page given the warned page's slug since the warning", async () => {
    // The warning was about page 1 at `about`. Page 1 has been fixed and
    // renamed, and page 2 now holds `about` with the very block page 1 had,
    // so only the page tells the two apart.
    pageRows.current = [
      { id: 1, slug: "about-us", title: "About", body: "", frontmatter: "title: About\n" },
      { id: 2, slug: "about", title: "Bio", body: "", frontmatter: BLOCK },
    ];

    const res = await runPublish(snapshotOk, await acknowledging([1, BLOCK]));

    expect(res).toMatchObject({ error: "page_frontmatter_unacknowledged" });
    expect(res.warnings?.map((w) => w.replacedSettings?.pageId)).toEqual([2]);
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  it("refuses the warned page when its block has changed since the warning", async () => {
    pageRows.current = [{ ...unreadable, frontmatter: "title: [About\nlanguage: fr\nlayout: wide\n" }];

    const res = await runPublish(snapshotOk, await acknowledging([1, BLOCK]));

    expect(res).toMatchObject({ error: "page_frontmatter_unacknowledged" });
    expect(buildPublishFileSet).not.toHaveBeenCalled();
  });

  it("publishes when the request acknowledges the page and the block it was warned of", async () => {
    pageRows.current = [unreadable];

    const res = await runPublish(snapshotOk, await acknowledging([1, BLOCK]));

    expect(res?.error).toBeUndefined();
    expect(buildPublishFileSet).toHaveBeenCalledTimes(1);
  });

  it("publishes a site whose pages replace nothing without the field", async () => {
    pageRows.current = [{ id: 2, slug: "team", title: "Team", body: "", frontmatter: "title: Team\nlanguage: es\n" }];

    const res = await runPublish();

    expect(res?.error).toBeUndefined();
    expect(buildPublishFileSet).toHaveBeenCalledTimes(1);
  });
});
