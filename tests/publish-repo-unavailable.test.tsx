// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

interface FetcherStub { data: unknown; state: "idle" | "submitting" | "loading"; submit: ReturnType<typeof vi.fn>; }
let fetchers: FetcherStub[] = [];
let fetcherCallIndex = 0;
const makeFetcher = (): FetcherStub => ({ data: undefined, state: "idle", submit: vi.fn() });
function resetFetchers() { fetchers = [makeFetcher(), makeFetcher(), makeFetcher()]; fetcherCallIndex = 0; }

const stableT = (key: string, opts?: Record<string, unknown>) =>
  opts && typeof opts.repo === "string" ? `${key} ${opts.repo}` : key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: stableT }) }));

vi.mock("react-router", () => ({
  useFetcher: () => { const f = fetchers[fetcherCallIndex % fetchers.length]; fetcherCallIndex += 1; return f; },
  redirect: (url: string) => ({ url }),
  useOutletContext: () => ({}),
  useRouteLoaderData: () => ({ repoUnavailable: true, repoFullName: "owner/repo" }),
  Link: ({ children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...rest}>{children}</a>,
}));

vi.mock("~/hooks/use-role", () => ({ useIsConvenor: () => true, useRole: () => "convenor" }));
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
      backCompatBootstrap: false, isUpToDate: false },
    user: { github_login: "u", github_name: "U", github_email: "u@e.co" },
  };
}

async function renderPublish() {
  const mod = (await import("~/routes/_app.publish")) as unknown as { default: React.ComponentType<{ loaderData: unknown }> };
  return render(<mod.default loaderData={makeLoaderData() as unknown as never} />);
}

beforeEach(() => { resetFetchers(); });

describe("Publish page — repo unavailable", () => {
  it("shows the notice card (not the working sections) with the manage link", async () => {
    const { container } = await renderPublish();
    expect(screen.getByText("repo_unavailable.heading")).toBeTruthy();
    expect(screen.getByText(/repo_unavailable\.lead owner\/repo/)).toBeTruthy();
    expect(screen.getByText("repo_unavailable.manage_cta")).toBeTruthy();
    expect(container.querySelector("a[href='https://github.com/settings/installations']")).toBeTruthy();
    expect(screen.queryByTestId("change-summary")).toBeNull();
    expect(fetchers[0].submit).not.toHaveBeenCalled();
  });
});
