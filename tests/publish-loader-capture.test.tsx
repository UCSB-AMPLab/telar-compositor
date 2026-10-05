// @vitest-environment jsdom
/**
 * The Publish page's change summary is computed from the pages' stored front
 * matter: whether a page is a translation decides where its menu entry is
 * written, and so the navigation hash. A page never captured holds none, so
 * the loader captures it, as the Pages loader does, from the pages it reads
 * alongside the hashes. When the capture stored a page, the hashes and the
 * last publish's snapshot (which the capture moved) are read again, so the
 * first load after a capture compares like with like. When every page is
 * captured, nothing extra runs. The snapshot compared is then settled past any
 * page block a publish wrote whose move did not land
 * (`snapshotSettledOnLoad`).
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";

interface FetcherStub { data: unknown; state: "idle" | "submitting" | "loading"; submit: ReturnType<typeof vi.fn>; }
/**
 * One stub per `useFetcher()` call the page makes, named for the slot it fills
 * in declaration order: validation, publish, poll-build, workflow repair,
 * the repair's own build poll.
 */
const FETCHER_SLOTS = ["validation", "publish", "poll", "repair", "repairPoll"] as const;
type FetcherSlot = (typeof FETCHER_SLOTS)[number];
let fetchers: Record<FetcherSlot, FetcherStub> = {} as Record<FetcherSlot, FetcherStub>;
let fetcherCallIndex = 0;
const makeFetcher = (): FetcherStub => ({ data: undefined, state: "idle", submit: vi.fn() });
function resetFetchers() {
  fetchers = {
    validation: makeFetcher(),
    publish: makeFetcher(),
    poll: makeFetcher(),
    repair: makeFetcher(),
    repairPoll: makeFetcher(),
  };
  fetcherCallIndex = 0;
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("react-router", () => ({
  useFetcher: () => { const f = fetchers[FETCHER_SLOTS[fetcherCallIndex % FETCHER_SLOTS.length]]; fetcherCallIndex += 1; return f; },
  redirect: (url: string) => ({ url }),
  useOutletContext: () => ({}),
  useRouteLoaderData: () => ({ repoUnavailable: false, repoFullName: "owner/repo" }),
  Link: ({ children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...rest}>{children}</a>,
}));

vi.mock("~/hooks/use-role", () => ({ useIsConvenor: () => true, useIsPublisher: () => true, useRole: () => "convenor" }));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ provider: null, isPublishing: false, publishError: false, remoteCollaborators: [], ydoc: null }),
}));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/session.server", () => ({ createSessionStorage: () => ({ getSession: () => ({ get: () => undefined }) }) }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn() }));
vi.mock("~/lib/github.server", () => ({ getRepoHead: vi.fn() }));
vi.mock("~/lib/membership.server", () => ({ resolveActiveProject: vi.fn(), requireOwner: vi.fn() }));
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn() }));
vi.mock("../workers/auth", () => ({
  signInternalMarker: vi.fn(async () => ({ sigHex: "sig", timestamp: 1 })),
}));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(), listWorkflowRunsBySha: vi.fn(), getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(), StaleHeadError: class StaleHeadError extends Error {},
}));

const emptyBucket = { new: [], modified: [], deleted: [] };
function makeSummary(overrides: Record<string, unknown> = {}) {
  return {
    stories: emptyBucket, objects: emptyBucket, pages: emptyBucket, glossary: emptyBucket,
    settings: { changed: [] }, landing: { changed: false }, navigation: { changed: false },
    backCompatBootstrap: false, isUpToDate: false,
    ...overrides,
  };
}

const { computeChangeSummary, buildEntityHashes, findEntityMaxUpdatedAt } = vi.hoisted(() => ({
  computeChangeSummary: vi.fn(),
  buildEntityHashes: vi.fn(async () => ({ version: 4 })),
  findEntityMaxUpdatedAt: vi.fn(async () => null),
}));
vi.mock("~/lib/publish.server", () => ({
  computeChangeSummary, buildEntityHashes, findEntityMaxUpdatedAt,
  computeStoryDeletions: vi.fn(), runPrePublishValidation: vi.fn(),
  buildPublishFileSet: vi.fn(), buildConfigManagedFields: vi.fn(),
  buildPageContentHashes: vi.fn(), ENTITY_HASHES_VERSION: 4,
}));

vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: vi.fn(async () => ({
    project: {
      id: 7, head_sha: "sha", published_sha: null, last_published_at: null,
      publish_snapshot: "{\"stale\":true}", github_repo_full_name: "owner/repo",
      github_pages_url: "https://owner.github.io/repo", installation_id: 1,
    },
  })),
}));

// Every read returns no rows, except the capture's read of the pages'
// front matter, which returns one page never captured.
const legacyPage = { id: 21, slug: "acerca", title: "Acerca de Telar", frontmatter: null as string | null, frontmatter_source: "acerca" };
const ACERCA_BLOCK = "\ntitle: Acerca de Telar\nlocalized_for: about.md\nlanguage: es\n";
const MOVED_SNAPSHOT = "{\"moved\":true}";
const rows = vi.hoisted(() => ({ pages: [] as unknown[] }));
function makeChain(rows: unknown[]): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => Object.assign(Promise.resolve(rows), chain);
  chain.limit = () => Promise.resolve(rows);
  return chain;
}
vi.mock("~/lib/db.server", () => ({
  getDb: () => ({
    select: (fields?: Record<string, unknown>) =>
      makeChain(
        fields && "frontmatter" in fields ? rows.pages
        : fields && "publish_snapshot" in fields ? [{ publish_snapshot: MOVED_SNAPSHOT }]
        : [],
      ),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  }),
}));

const { capturePagesOnLoad } = vi.hoisted(() => ({
  capturePagesOnLoad: vi.fn(async (_env: unknown, _user: unknown, _project: unknown, _role: unknown, pages: unknown[]) => pages),
}));
vi.mock("~/lib/page-capture.server", () => ({ capturePagesOnLoad }));

const { snapshotSettledOnLoad } = vi.hoisted(() => ({
  snapshotSettledOnLoad: vi.fn(async (_db: unknown, _id: number, snapshot: string | null) => snapshot),
}));
vi.mock("~/lib/page-written-frontmatter.server", () => ({ snapshotSettledOnLoad, storeWrittenPageFrontmatter: vi.fn() }));


function buildContext() {
  return {
    get: vi.fn(() => ({ id: 1, github_login: "u", github_name: "U", github_email: "u@e.co", encrypted_access_token: "x" })),
    cloudflare: {
      env: {
        DB: {},
        SESSION_SECRET: "s",
        COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => ({ fetch: async () => new Response("ok") })) },
      },
    },
  } as unknown as Record<string, unknown>;
}

async function runLoader() {
  const { loader } = await import("~/routes/_app.publish");
  return (await loader({
    request: new Request("https://app/publish", { headers: { Cookie: "" } }),
    context: buildContext(),
    params: {},
  } as never)) as Record<string, unknown>;
}

const stored = (pages: Array<typeof legacyPage>) =>
  pages.map((p) => (p.id === legacyPage.id ? { ...p, frontmatter: ACERCA_BLOCK } : p));

beforeEach(() => {
  vi.clearAllMocks();
  resetFetchers();
  rows.pages = [legacyPage];
  computeChangeSummary.mockReturnValue(makeSummary());
  buildEntityHashes.mockResolvedValueOnce({ version: 4, before: true } as never);
  buildEntityHashes.mockResolvedValue({ version: 4, after: true } as never);
  findEntityMaxUpdatedAt.mockResolvedValue(null);
  capturePagesOnLoad.mockImplementation(async (_e, _u, _p, _r, pages) => stored(pages as Array<typeof legacyPage>));
  snapshotSettledOnLoad.mockImplementation(async (_db, _id, snapshot) => snapshot);
});

describe("publish loader — pages never captured", () => {
  it("captures them from the pages it reads alongside the hashes", async () => {
    await runLoader();
    expect(capturePagesOnLoad).toHaveBeenCalledTimes(1);
    expect(capturePagesOnLoad.mock.calls[0][4]).toEqual([legacyPage]);
  });

  it("compares hashes read after the capture with the snapshot the capture moved", async () => {
    const data = await runLoader();
    expect(buildEntityHashes).toHaveBeenCalledTimes(2);
    const [state, snapshot] = computeChangeSummary.mock.calls[0] as [{ entityHashes: unknown }, unknown];
    expect(state.entityHashes).toEqual({ version: 4, after: true });
    expect(snapshot).toEqual({ moved: true });
    expect((data.project as { publish_snapshot: string }).publish_snapshot).toBe(MOVED_SNAPSHOT);
  });

  it("reads nothing again when the capture stored no page", async () => {
    capturePagesOnLoad.mockImplementation(async (_e, _u, _p, _r, pages) => pages);
    await runLoader();
    expect(buildEntityHashes).toHaveBeenCalledTimes(1);
    const [state, snapshot] = computeChangeSummary.mock.calls[0] as [{ entityHashes: unknown }, unknown];
    expect(state.entityHashes).toEqual({ version: 4, before: true });
    expect(snapshot).toEqual({ stale: true });
  });

  it("runs no capture when every page is captured", async () => {
    rows.pages = [{ ...legacyPage, frontmatter: ACERCA_BLOCK }];
    await runLoader();
    expect(capturePagesOnLoad).not.toHaveBeenCalled();
    expect(buildEntityHashes).toHaveBeenCalledTimes(1);
  });
});

describe("publish loader — a page block a publish wrote", () => {
  it("compares with the snapshot settled past it, from the snapshot and hashes after the capture", async () => {
    const SETTLED = "{\"settled\":true}";
    snapshotSettledOnLoad.mockResolvedValue(SETTLED);
    const data = await runLoader();
    expect(snapshotSettledOnLoad.mock.calls[0][1]).toBe(7);
    expect(snapshotSettledOnLoad.mock.calls[0][2]).toBe(MOVED_SNAPSHOT);
    const [, snapshot] = computeChangeSummary.mock.calls[0] as [unknown, unknown];
    expect(snapshot).toEqual({ settled: true });
    expect((data.project as { publish_snapshot: string }).publish_snapshot).toBe(SETTLED);
  });
});
