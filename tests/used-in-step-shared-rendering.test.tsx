// @vitest-environment jsdom
/**
 * The two screens that list the steps using an object read the same sentence.
 *
 * The object detail page and the objects-tab sync dialog answer the same
 * question — which steps depend on this object — and an author moving between
 * them is looking at one fact. One key (`used_in_step`) and one fallback for an
 * untitled story (`untitled_story`) are what keep that true; two copies of the
 * formatting drift apart silently, because each screen's own tests pass either
 * way.
 *
 * So this renders both, over the same usage refs and the same catalogue, and
 * compares the text. A divergence in wording, in punctuation, or in what an
 * untitled story is called fails here and nowhere else.
 *
 * The object page pulls its server modules in at module scope, which is what
 * the block of `vi.mock` calls below is for; none of them is what the
 * assertions are about.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import * as Y from "yjs";
import type { SyncDiff } from "~/lib/sync.server";

vi.mock("react-i18next", async () => {
  const { catalogueT } = await import("./helpers/catalogue-translator");
  return { useTranslation: () => ({ t: catalogueT("objects", "en") }) };
});

vi.mock("react-router", () => ({
  Link: ({ children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...rest}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useFetcher: () => ({
    state: "idle" as const,
    data: undefined,
    submit: vi.fn(),
    Form: ({ children, ...rest }: React.FormHTMLAttributes<HTMLFormElement>) => (
      <form {...rest}>{children}</form>
    ),
  }),
  redirect: vi.fn(),
  useRouteError: () => null,
  isRouteErrorResponse: () => false,
}));

const ydoc = new Y.Doc();

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({ ydoc, provider: { synced: true } }),
}));
vi.mock("~/hooks/use-structural-ops", () => ({
  useStructuralOps: () => ({ deleteObject: vi.fn() }),
}));

// Presentation-only children of the object page.
vi.mock("~/components/features/objects/IiifViewer", () => ({ IiifViewer: () => null }));
vi.mock("~/components/features/objects/CommitAndBuildModal", () => ({
  CommitAndBuildModal: () => null,
}));
vi.mock("~/components/features/editor/VideoEmbed", () => ({ VideoEmbed: () => null }));
vi.mock("~/components/features/editor/AudioPlayer", () => ({ AudioPlayer: () => null }));
vi.mock("~/components/ui/Switch", () => ({ Switch: () => null }));
vi.mock("~/components/ui/InlineTextField", () => ({ InlineTextField: () => null }));
vi.mock("~/components/ui/InlineTextArea", () => ({ InlineTextArea: () => null }));

// Server modules the object route imports at module scope.
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/lib/active-project.server", () => ({ resolveActiveProjectFromRequest: vi.fn() }));
vi.mock("~/lib/crypto.server", () => ({ decrypt: vi.fn() }));
vi.mock("~/lib/error-capture", () => ({ recordError: vi.fn() }));
vi.mock("~/lib/github.server", () => ({ githubHeaders: vi.fn() }));
vi.mock("~/lib/commit.server", () => ({
  dispatchWorkflow: vi.fn(),
  getJobSteps: vi.fn(),
  mapStepsToBuildPhases: vi.fn(),
}));
vi.mock("~/lib/github-status.server", () => ({ bumpProjectHeadFrom: vi.fn(async () => true) }));
vi.mock("~/lib/github-app.server", () => ({ getInstallationToken: vi.fn() }));
vi.mock("~/lib/object-repo-delete.server", () => ({ deleteObjectFromRepository: vi.fn() }));

import ObjectDetailPage from "~/routes/_app.objects.$objectId";
import { SyncDiffDialog } from "~/components/features/objects/SyncDiffDialog";

afterEach(cleanup);

type StoryUse = { storyTitle: string | null; stepNumber: number };

/** The same two refs both screens are given, one of them untitled. */
const USED_BY: StoryUse[] = [
  { storyTitle: "El río Magdalena", stepNumber: 4 },
  { storyTitle: null, stepNumber: 1 },
];

/** The object page's list entries. */
function objectPageEntries(usedInStories: StoryUse[]): (string | null)[] {
  const loaderData = {
    object: {
      id: 10,
      project_id: 42,
      object_id: "mapa-de-santafe",
      title: "Mapa de Santafé",
      description: null,
      creator: null,
      period: null,
      year: null,
      object_type: null,
      subjects: null,
      source: null,
      credit: null,
      alt_text: null,
      source_url: "objects/mapa-de-santafe/001.jpg",
      featured: false,
      image_available: true,
      missing_from_repo: false,
      course_project_id: null,
      created_by: 7,
    },
    manifestUrl: null,
    infoJsonUrl: null,
    isExternal: false,
    usedInStories,
    rename: { otherIds: [], version: null, stepsRewritten: 0, stepsKept: 0, unresolvedStepValues: [], shared: null },
    siteBase: "https://example.org/site",
    userRole: "convenor" as const,
    currentUserId: 7,
  };
  const props = { loaderData, actionData: undefined };
  const Page = ObjectDetailPage as unknown as (p: typeof props) => React.ReactElement;
  const { container } = render(<Page {...props} />);
  return Array.from(container.querySelectorAll("li")).map((li) => li.textContent);
}

/** The sync dialog's list entries, for an object missing from the repo. */
function syncDialogEntries(usedByStories: StoryUse[]): (string | null)[] {
  const diffData: SyncDiff = {
    newObjects: [],
    changedObjects: [],
    missingObjects: [
      { object_id: "mapa-de-santafe", dbId: 2, title: "Mapa de Santafé", usedByStories },
    ],
    unregisteredFiles: [], reordered: null,
  };
  const { baseElement: container } = render(
    <SyncDiffDialog
      open
      onClose={() => {}}
      diffData={diffData}
      onApply={() => {}}
      isComputing={false}
      isApplying={false}
    />,
  );
  return Array.from(container.querySelectorAll("li")).map((li) => li.textContent);
}

describe("used_in_step — one wording across both screens", () => {
  it("renders the same entries on the object page and in the sync dialog", () => {
    const fromPage = objectPageEntries(USED_BY);
    cleanup();
    const fromDialog = syncDialogEntries(USED_BY);

    expect(fromPage).toEqual(["El río Magdalena — step 4", "Untitled story — step 1"]);
    expect(fromDialog).toEqual(fromPage);
  });

  it("gives an untitled story the story fallback, not the generic one, on both", () => {
    const untitled = [{ storyTitle: null, stepNumber: 1 }];
    const fromPage = objectPageEntries(untitled);
    cleanup();
    const fromDialog = syncDialogEntries(untitled);

    // `common:untitled` renders "Untitled", which is also what an object and a
    // page are called; the entry has to say which kind of thing is untitled.
    expect(fromPage).toEqual(["Untitled story — step 1"]);
    expect(fromDialog).toEqual(fromPage);
  });
});
