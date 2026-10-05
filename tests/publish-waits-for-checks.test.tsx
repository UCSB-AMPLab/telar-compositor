// @vitest-environment jsdom
/**
 * The Publish button waits for the pre-publish checks to answer. The action
 * re-checks blockers only, so a publish sent before the checks answer, or
 * after they failed, goes out without the author having seen a warning such
 * as a page whose stored settings the publish replaces. A failed run leaves
 * the checks unanswered, says so, and offers to run them again.
 *
 * A publish names the pages whose settings-replaced warning the author was
 * shown. A publish the action refuses for a page it did not name brings that
 * warning up beside Publish, and the next publish names it.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
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

const appData = { repoUnavailable: false, repoFullName: "owner/repo", releaseUnknown: false };

const stableT = (key: string, opts?: Record<string, unknown>) =>
  opts && typeof opts.repo === "string" ? `${key} ${opts.repo}` : key;
const stableI18n = { language: "en" };
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: stableT, i18n: stableI18n }) }));

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
// The checks list renders inert; the warnings a refused publish brings up
// beside Publish render through the real component.
vi.mock("~/components/features/publish/ValidationChecks", async (orig) => ({
  ...(await orig()),
  ValidationChecks: () => <div data-testid="validation-checks" />,
}));

let snapshotOk = true;

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
    snapshotOk,
  };
}

type Route = { default: React.ComponentType<{ loaderData: unknown }> };

async function renderPublish() {
  const mod = (await import("~/routes/_app.publish")) as unknown as Route;
  return render(<mod.default loaderData={makeLoaderData() as unknown as never} />);
}

/** Re-render with the fetcher state the test has just set. */
async function rerender(view: ReturnType<typeof render>) {
  const mod = (await import("~/routes/_app.publish")) as unknown as Route;
  fetcherCallIndex = 0;
  await act(async () => {
    view.rerender(<mod.default loaderData={makeLoaderData() as unknown as never} />);
  });
}

const ANSWERED = { ok: true, intent: "run-validation", validation: { blockers: [], warnings: [] } };

const validationRuns = () =>
  fetchers.validation.submit.mock.calls.filter((c) => (c[0] as { intent?: string }).intent === "run-validation").length;

function publishButton(): HTMLButtonElement {
  return screen.getByText("publish_section.publish_now").closest("button") as HTMLButtonElement;
}

/** The commit-message editor's own Publish button, opening the editor first. */
function editorPublishButton(): HTMLButtonElement {
  const open = screen.queryByText("publish_section.edit_message");
  if (open) fireEvent.click(open.closest("button") as HTMLButtonElement);
  return screen.getByText("commit.publish_button").closest("button") as HTMLButtonElement;
}

const publishSubmits = () => fetchers.publish.submit.mock.calls.map((c) => c[0] as Record<string, string>);

/** The warning the checks give for a page whose stored settings the publish replaces. */
const REPLACED_ABOUT = {
  code: "page_frontmatter_replaced",
  message: "page_frontmatter_replaced",
  entityId: "about",
  params: { page: "About" },
  replacedSettings: { pageId: 1, fingerprint: "fingerprint-of-about" },
};

/** What a publish sends to acknowledge `REPLACED_ABOUT`. */
const ACKNOWLEDGED_ABOUT = JSON.stringify([{ pageId: 1, fingerprint: "fingerprint-of-about" }]);

beforeEach(() => {
  resetFetchers();
  snapshotOk = true;
});

describe("Publish page — Publish waits for the checks", () => {
  it("keeps Publish disabled while the checks run on mount", async () => {
    await renderPublish();

    expect(validationRuns()).toBe(1);
    expect(publishButton().disabled).toBe(true);
  });

  it("holds back the commit-message editor's Publish until the checks answer", async () => {
    const view = await renderPublish();
    expect(editorPublishButton().disabled).toBe(true);
    fireEvent.submit(editorPublishButton().closest("form") as HTMLFormElement);
    expect(publishSubmits()).toEqual([]);

    fetchers.validation.data = ANSWERED;
    await rerender(view);
    expect(editorPublishButton().disabled).toBe(false);
    fireEvent.submit(editorPublishButton().closest("form") as HTMLFormElement);
    expect(publishSubmits()).toHaveLength(1);
  });

  it("holds back the commit-message editor's Publish over a blocker, as the Publish button is", async () => {
    fetchers.validation.data = {
      ok: true,
      intent: "run-validation",
      validation: { blockers: [{ code: "stale_head", message: "stale_head" }], warnings: [] },
    };
    await renderPublish();

    expect(publishButton().disabled).toBe(true);
    expect(editorPublishButton().disabled).toBe(true);
    fireEvent.submit(editorPublishButton().closest("form") as HTMLFormElement);
    expect(publishSubmits()).toEqual([]);
  });

  it("keeps Publish disabled while a re-run of the checks is in flight", async () => {
    fetchers.validation.data = ANSWERED;
    fetchers.validation.state = "submitting";

    await renderPublish();

    expect(publishButton().disabled).toBe(true);
  });

  it("keeps Publish disabled when the checks failed, says so, and runs them again on request", async () => {
    const view = await renderPublish();
    fetchers.validation.data = { ok: false, intent: "run-validation", error: "validation_failed" };
    await rerender(view);

    expect(publishButton().disabled).toBe(true);
    expect(screen.getByText("checks.failed")).toBeTruthy();
    expect(screen.queryByTestId("validation-checks")).toBeNull();

    fireEvent.click(screen.getByText("checks.run_again").closest("button") as HTMLButtonElement);
    expect(validationRuns()).toBe(2);
    expect(screen.queryByText("checks.failed")).toBeNull();
    expect(publishButton().disabled).toBe(true);
  });

  it("runs the checks again when the author tries again after a failed build", async () => {
    fetchers.validation.data = ANSWERED;
    const view = await renderPublish();
    fireEvent.click(publishButton());
    fetchers.publish.data = { ok: true, intent: "publish", newHeadSha: "publish-sha", commitUrl: "https://gh/commit/1", leftFiles: [] };
    await rerender(view);
    fetchers.poll.data = {
      ok: true, intent: "poll-build", sha: "publish-sha", buildStatus: "completed",
      buildConclusion: "failure", buildUrl: "https://gh/run/1", runId: 7, phases: null,
    };
    await rerender(view);
    const runsBefore = validationRuns();

    fireEvent.click(screen.getByText("failure_card.try_again").closest("button") as HTMLButtonElement);

    expect(validationRuns()).toBe(runsBefore + 1);
    expect(publishButton().disabled).toBe(true);
  });

  it("offers Publish once the checks answer with no blockers", async () => {
    const view = await renderPublish();
    fetchers.validation.data = ANSWERED;
    await rerender(view);

    expect(publishButton().disabled).toBe(false);
  });
});

describe("Publish page — the settings-replaced warnings a publish names", () => {
  it("names the pages the checks warned of with the first publish", async () => {
    fetchers.validation.data = { ok: true, intent: "run-validation", validation: { blockers: [], warnings: [REPLACED_ABOUT] } };
    await renderPublish();

    fireEvent.click(publishButton());

    expect(publishSubmits()[0].acknowledgedReplacedPages).toBe(ACKNOWLEDGED_ABOUT);
  });

  it("names nothing when no page's settings are replaced", async () => {
    fetchers.validation.data = ANSWERED;
    await renderPublish();

    fireEvent.click(publishButton());

    expect(publishSubmits()[0]).not.toHaveProperty("acknowledgedReplacedPages");
  });

  it("shows the warning a refused publish returns, and names its page with the next publish", async () => {
    // The checks answered before the page changed; the action sees the page
    // as it is now.
    fetchers.validation.data = ANSWERED;
    const view = await renderPublish();
    fireEvent.click(publishButton());
    expect(publishSubmits()[0]).not.toHaveProperty("acknowledgedReplacedPages");

    fetchers.publish.data = { ok: false, intent: "publish", error: "page_frontmatter_unacknowledged", warnings: [REPLACED_ABOUT], projectId: 1 };
    await rerender(view);

    expect(screen.getByText("checks.page_frontmatter_replaced")).toBeTruthy();
    expect(screen.queryByText("build.failed_description")).toBeNull();
    expect(publishButton().disabled).toBe(false);

    fireEvent.click(publishButton());
    expect(publishSubmits()[1].acknowledgedReplacedPages).toBe(ACKNOWLEDGED_ABOUT);
  });

  it("goes through on the second publish when the checks could not run, from the commit-message editor too", async () => {
    snapshotOk = false;
    const view = await renderPublish();
    fireEvent.click(publishButton());
    expect(publishSubmits()[0]).not.toHaveProperty("acknowledgedReplacedPages");

    fetchers.publish.data = { ok: false, intent: "publish", error: "page_frontmatter_unacknowledged", warnings: [REPLACED_ABOUT], projectId: 1 };
    await rerender(view);
    expect(screen.getByText("checks.page_frontmatter_replaced")).toBeTruthy();

    fireEvent.click(editorPublishButton());
    expect(publishSubmits()[1].acknowledgedReplacedPages).toBe(ACKNOWLEDGED_ABOUT);
  });
});
