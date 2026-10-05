// @vitest-environment jsdom
/**
 * The Publish page's change summary is a claim about the site's current state,
 * and the loader can only make it when the forced `/snapshot` succeeded.
 *
 * The loader asks the Durable Object to flush the live document to D1 and then
 * diffs D1 against the stored publish snapshot. When that call fails the DO
 * still holds edits D1 has never seen, so the diff describes a state that no
 * longer exists — and it is shown before the action, which refuses on the same
 * failure, ever runs. Worst of all is the up-to-date card: "no changes since
 * your last publish" is the one sentence a stale read must never produce.
 *
 * So the loader reports whether the snapshot ran, and the page says it could
 * not read the current state rather than showing a diff it cannot stand
 * behind. It does NOT block publishing: the action makes its own `/snapshot`
 * call and fails closed there, and a transient failure at load time is no
 * reason to refuse a publish that would succeed.
 *
 * With the state read and nothing changed, Publish stays on where the checks
 * found headings the site misreads, since a publish is what corrects them.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
      objectOrder: { changed: false },
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
      publish_snapshot: null, github_repo_full_name: "owner/repo",
      github_pages_url: "https://owner.github.io/repo", installation_id: 1,
    },
  })),
}));

// The loader only reads rows; every chain terminates in an empty array.
const emptyRows: unknown[] = [];
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.where = () => Object.assign(Promise.resolve(emptyRows), chain);
  chain.limit = () => Promise.resolve(emptyRows);
  return chain;
}
vi.mock("~/lib/db.server", () => ({
  getDb: () => ({
    select: () => makeChain(),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  }),
}));

vi.mock("~/components/features/publish/ChangeSummary", () => ({
  ChangeSummary: () => <div data-testid="change-summary" />,
}));
vi.mock("~/components/features/publish/ValidationChecks", () => ({
  ValidationChecks: () => <div data-testid="validation-checks" />,
}));
vi.mock("~/components/features/publish/CommitMessageEditor", () => ({
  CommitMessageEditor: () => <div data-testid="commit-editor" />,
}));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type DOFetch = (request: Request) => Promise<Response>;

function buildContext(doFetch: DOFetch) {
  const doStub = { fetch: doFetch };
  return {
    get: vi.fn(() => ({ id: 1, github_login: "u", github_name: "U", github_email: "u@e.co" })),
    cloudflare: {
      env: {
        DB: {},
        SESSION_SECRET: "s",
        COLLABORATION: { idFromName: vi.fn(() => "do-id"), get: vi.fn(() => doStub) },
      },
    },
  } as unknown as Record<string, unknown>;
}

async function runLoader(doFetch: DOFetch) {
  const { loader } = await import("~/routes/_app.publish");
  return (await loader({
    request: new Request("https://app/publish", { headers: { Cookie: "" } }),
    context: buildContext(doFetch),
    params: {},
  } as never)) as Record<string, unknown>;
}

async function renderPublish(loaderData: Record<string, unknown>) {
  const mod = (await import("~/routes/_app.publish")) as unknown as {
    default: React.ComponentType<{ loaderData: unknown }>;
  };
  return render(<mod.default loaderData={loaderData as never} />);
}

function makeLoaderData(overrides: Record<string, unknown> = {}) {
  return {
    project: {
      id: 1, head_sha: "old-sha", published_sha: null, last_published_at: null,
      publish_snapshot: null, github_repo_full_name: "owner/repo",
      github_pages_url: "https://owner.github.io/repo", installation_id: 123,
    },
    changeSummary: makeSummary(),
    user: { github_login: "u", github_name: "U", github_email: "u@e.co" },
    snapshotOk: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetFetchers();
  computeChangeSummary.mockReturnValue(makeSummary());
  buildEntityHashes.mockResolvedValue({ version: 4 });
  findEntityMaxUpdatedAt.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => { /* silence the loader log */ });
});

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

describe("publish loader — the forced snapshot's outcome", () => {
  it("reports the snapshot as run when the DO answers 200", async () => {
    const data = await runLoader(async () => new Response("ok", { status: 200 }));
    expect(data.snapshotOk).toBe(true);
    expect(computeChangeSummary).toHaveBeenCalled();
  });

  it("reports the snapshot as NOT run when the DO answers 500", async () => {
    const data = await runLoader(async () => new Response("snapshot_failed", { status: 500 }));
    expect(data.snapshotOk).toBe(false);
  });

  it("reports the snapshot as NOT run when the DO answers 503", async () => {
    const data = await runLoader(async () => new Response("unavailable", { status: 503 }));
    expect(data.snapshotOk).toBe(false);
  });

  it("reports the snapshot as NOT run when the DO cannot be reached at all", async () => {
    const data = await runLoader(async () => { throw new Error("unreachable"); });
    expect(data.snapshotOk).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

describe("Publish page — what it shows when the snapshot could not run", () => {
  it("replaces the diff with an honest notice", async () => {
    await renderPublish(makeLoaderData({ snapshotOk: false }));
    expect(screen.getByText("review.state_unavailable")).toBeTruthy();
    expect(screen.getByText("review.state_unavailable_description")).toBeTruthy();
    expect(screen.queryByTestId("change-summary")).toBeNull();
  });

  it("never claims the site is up to date off a stale read", async () => {
    await renderPublish(
      makeLoaderData({
        snapshotOk: false,
        changeSummary: makeSummary({ isUpToDate: true }),
      }),
    );
    expect(screen.queryByText("review.up_to_date")).toBeNull();
    expect(screen.getByText("review.state_unavailable")).toBeTruthy();
  });

  it("does not let a stale up-to-date read disable publishing", async () => {
    // `publishDisabled` folds in `isUpToDate`, so a stale read that says
    // "nothing changed" locks the author out of publishing the changes the
    // loader could not see. The action makes its own `/snapshot` call and
    // fails closed there; this page must not refuse on its behalf.
    await renderPublish(
      makeLoaderData({
        snapshotOk: false,
        changeSummary: makeSummary({ isUpToDate: true }),
      }),
    );
    const publishButton = screen
      .getByText("publish_section.publish_now")
      .closest("button") as HTMLButtonElement;
    expect(publishButton).toBeTruthy();
    expect(publishButton.disabled).toBe(false);
  });

  it("shows the diff as usual when the snapshot ran", async () => {
    await renderPublish(makeLoaderData({ snapshotOk: true }));
    expect(screen.getByTestId("change-summary")).toBeTruthy();
    expect(screen.queryByText("review.state_unavailable")).toBeNull();
  });

  it("still shows the up-to-date card when the snapshot ran", async () => {
    await renderPublish(
      makeLoaderData({ snapshotOk: true, changeSummary: makeSummary({ isUpToDate: true }) }),
    );
    expect(screen.getByText("review.up_to_date")).toBeTruthy();
    expect(screen.queryByText("review.state_unavailable")).toBeNull();
  });
});

describe("Publish page — headings to correct with nothing else changed", () => {
  const heading = {
    code: "sheet_warning",
    message: "sheet_warning",
    entityId: "objects.csv/0",
    sheetWarning: { code: "header_spelling", headers: ["Object_ID"], names: ["object_id"], sheet: "objects.csv" },
  };

  async function renderChecked(warnings: unknown[]) {
    fetchers.validation.data = { ok: true, intent: "run-validation", validation: { blockers: [], warnings } };
    await renderPublish(makeLoaderData({ snapshotOk: true, changeSummary: makeSummary({ isUpToDate: true }) }));
    return screen.getByText("publish_section.publish_now").closest("button") as HTMLButtonElement;
  }

  it("turns Publish on and says the headings need correcting", async () => {
    const button = await renderChecked([heading]);
    expect(button.disabled).toBe(false);
    expect(screen.getByText("review.header_spelling_title")).toBeTruthy();
    expect(screen.getByText("review.header_spelling_description")).toBeTruthy();
    expect(screen.queryByText("review.up_to_date")).toBeNull();
  });

  it("keeps Publish off and the site up to date without them", async () => {
    const button = await renderChecked([]);
    expect(button.disabled).toBe(true);
    expect(screen.getByText("review.up_to_date")).toBeTruthy();
    expect(screen.queryByText("review.header_spelling_title")).toBeNull();
  });
});
