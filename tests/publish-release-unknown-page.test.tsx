// @vitest-environment jsdom
/**
 * The Publish page when the latest Telar release cannot be read:
 * the page opens, its Publish button is disabled, and the message says why.
 * The `_app` loader reports the state as `releaseUnknown`. A page loaded
 * before the lookup failed is refused by the action instead, and leaves its
 * publishing state when the refusal arrives.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

let appData: Record<string, unknown> = {};

const stableT = (key: string, opts?: Record<string, unknown>) =>
  opts && typeof opts.repo === "string" ? `${key} ${opts.repo}` : key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: stableT }) }));

vi.mock("react-router", () => ({
  // A fresh object per call, not the stub itself: the page wraps every
  // fetcher through `useSiteFetcher` (`~/lib/page-site`), whose own memo keys
  // on the fetcher object's identity, so a stub mutated in place and handed
  // back by reference would be invisible to it.
  useFetcher: () => { const f = fetchers[FETCHER_SLOTS[fetcherCallIndex % FETCHER_SLOTS.length]]; fetcherCallIndex += 1; return { data: f.data, state: f.state, submit: f.submit }; },
  redirect: (url: string) => ({ url }),
  useOutletContext: () => ({}),
  useRouteLoaderData: () => appData,
  Link: ({ children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...rest}>{children}</a>,
}));

vi.mock("~/hooks/use-role", () => ({ useIsConvenor: () => true, useIsPublisher: () => true, useRole: () => "convenor" }));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ provider: null, isPublishing: false, publishError: false, remoteCollaborators: [], ydoc: null }),
}));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/db.server", () => ({ getDb: () => ({}) }));
vi.mock("~/lib/session.server", () => ({ createSessionStorage: () => ({ getSession: () => ({ get: () => undefined }) }) }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn() }));
vi.mock("~/lib/github.server", () => ({ getRepoHead: vi.fn() }));
vi.mock("~/lib/membership.server", () => ({ resolveActiveProject: vi.fn(), requireOwner: vi.fn() }));
vi.mock("~/lib/activity.server", () => ({ recordActivity: vi.fn() }));
vi.mock("../workers/auth", () => ({ signInternalMarker: vi.fn() }));
vi.mock("~/lib/commit.server", () => ({
  commitFilesToRepo: vi.fn(), listWorkflowRunsBySha: vi.fn(), getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(), StaleHeadError: class StaleHeadError extends Error {},
}));
vi.mock("~/lib/publish.server", () => ({
  computeChangeSummary: vi.fn(), computeStoryDeletions: vi.fn(), runPrePublishValidation: vi.fn(),
  buildPublishFileSet: vi.fn(), buildConfigManagedFields: vi.fn(), buildPageContentHashes: vi.fn(),
  buildEntityHashes: vi.fn(), findEntityMaxUpdatedAt: vi.fn(), ENTITY_HASHES_VERSION: 4,
}));
vi.mock("~/components/features/publish/ChangeSummary", () => ({ ChangeSummary: () => <div data-testid="change-summary" /> }));
vi.mock("~/components/features/publish/ValidationChecks", () => ({ ValidationChecks: () => <div data-testid="validation-checks" /> }));
vi.mock("~/components/features/publish/CommitMessageEditor", () => ({ CommitMessageEditor: () => <div data-testid="commit-editor" /> }));

function makeLoaderData() {
  const empty = { new: [], modified: [], deleted: [] };
  return {
    project: { id: 1, head_sha: "old-sha", published_sha: null, last_published_at: null,
      publish_snapshot: null, github_repo_full_name: "owner/repo",
      github_pages_url: "https://owner.github.io/repo", installation_id: 123 },
    changeSummary: { stories: empty, objects: empty, pages: empty, glossary: empty,
      settings: { changed: [] }, landing: { changed: false }, navigation: { changed: false },
      objectOrder: { changed: false },
      backCompatBootstrap: false, isUpToDate: false },
    user: { github_login: "u", github_name: "U", github_email: "u@e.co" },
  };
}

async function renderPublish() {
  const mod = (await import("~/routes/_app.publish")) as unknown as { default: React.ComponentType<{ loaderData: unknown }> };
  return render(<mod.default loaderData={makeLoaderData() as unknown as never} />);
}

function publishButton(): HTMLButtonElement {
  return screen.getByText("publish_section.publish_now").closest("button") as HTMLButtonElement;
}

beforeEach(() => {
  resetFetchers();
  fetchers.validation.data = { ok: true, intent: "run-validation", validation: { blockers: [], warnings: [] } };
});

describe("Publish page — latest release unknown", () => {
  it("opens with Publish disabled and says why", async () => {
    appData = { repoUnavailable: false, repoFullName: "owner/repo", releaseUnknown: true };

    await renderPublish();

    expect(screen.getByText("release_unknown")).toBeTruthy();
    expect(publishButton().disabled).toBe(true);
  });

  it("offers Publish when the release was read", async () => {
    appData = { repoUnavailable: false, repoFullName: "owner/repo", releaseUnknown: false };

    await renderPublish();

    expect(screen.queryByText("release_unknown")).toBeNull();
    expect(publishButton().disabled).toBe(false);
  });

  it("clears the publishing state on the action's refusal and shows why", async () => {
    // The page loaded while the release could still be read; the lookup
    // failed between the load and the submit.
    appData = { repoUnavailable: false, repoFullName: "owner/repo", releaseUnknown: false };
    const view = await renderPublish();
    const mod = (await import("~/routes/_app.publish")) as unknown as { default: React.ComponentType<{ loaderData: unknown }> };

    fireEvent.click(publishButton());
    expect(fetchers.publish.submit).toHaveBeenCalledTimes(1);
    expect(publishButton().disabled).toBe(true);

    fetchers.publish.data = { ok: false, intent: "publish", error: "release_unknown", projectId: 1 };
    fetcherCallIndex = 0;
    view.rerender(<mod.default loaderData={makeLoaderData() as unknown as never} />);

    expect(publishButton().disabled).toBe(false);
    expect(screen.getByText("release_unknown")).toBeTruthy();
  });
});
