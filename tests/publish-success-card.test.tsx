// @vitest-environment jsdom
/**
 * The rewritten Publish page hands build chrome to the Site Status pill and
 * shows a SINGLE success card only AFTER the build actually completes (honest
 * over snappy — never claim "Published" on commit return, which fires before
 * the GitHub Actions build even starts).
 *
 * The success-card swap is gated on a headless `poll-build` loop watching the
 * build to `buildConclusion === "success"`.
 *
 * Mock strategy mirrors tests/_app.homepage.test.tsx + tests/PublishingPopover
 * .test.tsx: react-i18next key passthrough, a per-fetcher useFetcher mock keyed
 * by call order (validation / publish / poll-build), useIsConvenor → true,
 * useCollaborationContext stubbed inert.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

// ---------------------------------------------------------------------------
// Per-fetcher mock state. The component calls useFetcher() three times in a
// stable order: validationFetcher, publishFetcher, pollFetcher. We hand each
// call its own controllable `data` + a submit spy.
// ---------------------------------------------------------------------------

interface FetcherStub {
  data: unknown;
  state: "idle" | "submitting" | "loading";
  submit: ReturnType<typeof vi.fn>;
}

let fetchers: FetcherStub[] = [];
let fetcherCallIndex = 0;

function makeFetcher(): FetcherStub {
  return { data: undefined, state: "idle", submit: vi.fn() };
}

function resetFetchers() {
  fetchers = [makeFetcher(), makeFetcher(), makeFetcher()];
  fetcherCallIndex = 0;
}

const validationFetcher = () => fetchers[0];
const publishFetcher = () => fetchers[1];
const pollFetcher = () => fetchers[2];

// STABLE `t` identity (module-level singleton). The component's publish-
// response effect depends on `[publishData, t]` and calls setState; a fresh `t`
// per render would change that dep every render and spin an infinite update
// loop. Returning the same function reference every call mirrors real i18next
// (its `t` is stable across renders).
const stableT = (key: string, opts?: Record<string, unknown>) => {
  // Surface interpolated url so the "Published. <url>" assertion can match.
  if (opts && typeof opts.url === "string") return `${key} ${opts.url}`;
  return key;
};
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: stableT }),
}));

vi.mock("react-router", () => ({
  useFetcher: () => {
    // The component calls useFetcher() three times per render in a stable
    // order (validation / publish / poll-build). Map by call position MODULO 3
    // so the same fetcher object (and its submit spy) is returned for the same
    // slot across re-renders — otherwise a second render would hand out fresh
    // stubs and lose the spy history.
    const f = fetchers[fetcherCallIndex % fetchers.length];
    fetcherCallIndex += 1;
    return f;
  },
  redirect: (url: string) => ({ url }),
  useOutletContext: () => ({}),
  useRouteLoaderData: () => null,
  Link: ({ children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...rest}>{children}</a>
  ),
}));

vi.mock("~/hooks/use-role", () => ({
  useIsConvenor: () => true,
  useRole: () => "convenor",
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    provider: null,
    isPublishing: false,
    publishError: false,
    remoteCollaborators: [],
    ydoc: null,
  }),
}));

// Server-only modules imported by the route — stub so import doesn't pull them.
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/db.server", () => ({ getDb: () => ({}) }));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: () => ({ getSession: () => ({ get: () => undefined }) }),
}));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn() }));
vi.mock("~/lib/github.server", () => ({ getRepoHead: vi.fn() }));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(),
  requireOwner: vi.fn(),
}));
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn() }));
vi.mock("../workers/auth", () => ({ signInternalMarker: vi.fn() }));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(),
  listWorkflowRunsBySha: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
  StaleHeadError: class StaleHeadError extends Error {},
}));
vi.mock("~/lib/publish.server", () => ({
  computeChangeSummary: vi.fn(),
  computeStoryDeletions: vi.fn(),
  runPrePublishValidation: vi.fn(),
  buildPublishFileSet: vi.fn(),
  buildConfigManagedFields: vi.fn(),
  buildPageContentHashes: vi.fn(),
  buildEntityHashes: vi.fn(),
  findEntityMaxUpdatedAt: vi.fn(),
  ENTITY_HASHES_VERSION: 4,
}));

// ChangeSummary / ValidationChecks / CommitMessageEditor render inert so the
// page mounts without their internals.
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
// loaderData fixture + helpers
// ---------------------------------------------------------------------------

function makeChangeSummary() {
  const empty = { new: [], modified: [], deleted: [] };
  return {
    stories: empty,
    objects: empty,
    pages: empty,
    glossary: empty,
    settings: { changed: [] },
    landing: { changed: false },
    navigation: { changed: false },
    backCompatBootstrap: false,
    // Not up to date so the Publish section + post-commit states render.
    isUpToDate: false,
  };
}

function makeLoaderData() {
  return {
    project: {
      id: 1,
      head_sha: "old-sha",
      published_sha: null,
      last_published_at: null,
      publish_snapshot: null,
      github_repo_full_name: "owner/repo",
      github_pages_url: "https://owner.github.io/repo",
      installation_id: 123,
    },
    changeSummary: makeChangeSummary(),
    user: { github_login: "u", github_name: "U", github_email: "u@e.co" },
  };
}

async function loadPublish() {
  const mod = (await import("~/routes/_app.publish")) as unknown as {
    default: React.ComponentType<{ loaderData: unknown }>;
  };
  return mod.default;
}

async function renderPublish() {
  const loaderData = makeLoaderData();
  const Publish = await loadPublish();
  return render(<Publish loaderData={loaderData as unknown as never} />);
}

// Drive the publish fetcher to a successful commit (sets publishResult).
function commitSucceeded() {
  publishFetcher().data = {
    ok: true,
    intent: "publish",
    newHeadSha: "new-sha-123",
    commitUrl: "https://github.com/owner/repo/commit/new-sha-123",
  };
}

function pollReturns(
  buildStatus: string,
  buildConclusion: string | null,
  phases: unknown = null,
) {
  pollFetcher().data = {
    ok: true,
    intent: "poll-build",
    buildStatus,
    buildConclusion,
    buildUrl: "https://github.com/owner/repo/actions/runs/1",
    runId: 1,
    phases,
  };
}

beforeEach(() => {
  resetFetchers();
});

describe("success card is gated on build completion", () => {
  it("the success card is ABSENT while buildStatus !== 'completed' (commit returned, build still running) — page shows the inline 5-row progress tracker", async () => {
    commitSucceeded();
    pollReturns("in_progress", null);
    const { container } = await renderPublish();

    // No success heading while the build is still running.
    expect(screen.queryByText("success_card.heading")).toBeNull();
    // The inline progress tracker is shown (the 7-step horizontal stepper).
    expect(container.querySelectorAll("[data-step-node]")).toHaveLength(7);
  });

  it("the inline tracker reflects the polled BUILD_PHASES (Build row in_progress)", async () => {
    commitSucceeded();
    // Real phases: setup/build-js done, build-site running → Build row in_progress.
    pollReturns("in_progress", null, [
      { id: "setup", label: "setup", status: "completed", conclusion: "success" },
      { id: "build-site", label: "build-site", status: "in_progress", conclusion: null },
    ]);
    const { container } = await renderPublish();

    expect(container.querySelectorAll("[data-step-node]")).toHaveLength(7);
    // The stepper caption names the active step. The i18n mock returns keys verbatim.
    expect(screen.getByText("publishing.building")).toBeTruthy();
  });

  it("the success card appears ONLY after a mocked poll-build returns buildStatus 'completed' with buildConclusion 'success'", async () => {
    commitSucceeded();
    pollReturns("completed", "success");
    const { container } = await renderPublish();

    expect(screen.getByText(/success_card\.heading/)).toBeTruthy();
    // Inline tracker gone once complete.
    expect(container.querySelectorAll("[data-step-node]")).toHaveLength(0);
  });

  it("the success card renders 'Published. <url>' with a primary Open button and a secondary View-commit-on-GitHub link", async () => {
    commitSucceeded();
    pollReturns("completed", "success");
    const { container } = await renderPublish();

    // Heading interpolates the live URL.
    expect(screen.getByText(/success_card\.heading https:\/\/owner\.github\.io\/repo/)).toBeTruthy();
    // Primary Open button → pages URL.
    const openLink = container.querySelector('a[href="https://owner.github.io/repo"]');
    expect(openLink).not.toBeNull();
    expect(openLink?.textContent).toContain("success_card.open");
    // Secondary View-commit link → commit URL.
    const commitLink = container.querySelector(
      'a[href="https://github.com/owner/repo/commit/new-sha-123"]',
    );
    expect(commitLink).not.toBeNull();
    expect(commitLink?.textContent).toContain("success_card.view_commit");
  });

  it("a failed build (buildConclusion !== 'success') does NOT render the success card", async () => {
    commitSucceeded();
    pollReturns("completed", "failure");
    await renderPublish();

    expect(screen.queryByText(/success_card\.heading/)).toBeNull();
    // A failure state is shown instead.
    expect(screen.getByText("failure_card.heading")).toBeTruthy();
  });

  it("the in-route BuildTracker is removed — the headless poll fetcher drives the build chrome; the poll fetcher submits poll-build after commit", async () => {
    commitSucceeded();
    pollReturns("in_progress", null);
    await renderPublish();

    // The headless poll loop fires a poll-build submit (with the commit SHA)
    // once a commit SHA exists — proving the page itself drives the build
    // chrome rather than an in-route BuildTracker. render() flushes the
    // publish-response effect (sets publishResult) and the chained poll-loop
    // effect's immediate doPoll() within its act() boundary.
    const submittedPollBuild = pollFetcher().submit.mock.calls.some(
      ([payload]) =>
        payload &&
        typeof payload === "object" &&
        (payload as Record<string, unknown>).intent === "poll-build" &&
        (payload as Record<string, unknown>).sha === "new-sha-123",
    );
    expect(submittedPollBuild).toBe(true);
  });
});
