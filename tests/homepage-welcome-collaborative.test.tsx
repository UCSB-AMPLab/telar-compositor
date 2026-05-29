// @vitest-environment jsdom
/**
 * Regression — the homepage Welcome Message editor must be COLLABORATIVE, like
 * every other landing field and every other long-form editor.
 *
 * Root cause of the persistence bug: `welcome_body` was the ONLY field the
 * Durable Object's `snapshotToD1` cycle writes to D1 that was NOT wired to its
 * Yjs `Y.Text`. The editor wrote D1 directly (fetcher autosave) while the DO
 * kept snapshotting the stale, unused Yjs `welcome_body` Y.Text back over it,
 * clobbering edits ~every snapshot cycle.
 *
 * Fix: wire the welcome `MarkdownEditor` to its Yjs `Y.Text` (collaborative
 * mode), like its siblings, so edits flow through Yjs and the snapshot
 * persists them. The canned default is shown via a `placeholder` instead of
 * being injected as editable content.
 *
 * Mock strategy mirrors tests/_app.homepage.test.tsx, but uses the REAL `yjs`
 * + REAL `getYText` so the component resolves a real welcome_body Y.Text from
 * the collaboration context.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import * as Y from "yjs";
import { WELCOME_BODY_LOCALISED } from "~/lib/v130-framework-labels";

// A real Y.Doc whose config.landing map holds a welcome_body Y.Text.
const ydoc = new Y.Doc();
const configMap = ydoc.getMap<unknown>("config");
const landingMap = new Y.Map<unknown>();
for (const key of ["welcome_body", "stories_heading", "stories_intro", "objects_heading", "objects_intro"]) {
  landingMap.set(key, new Y.Text(""));
}
configMap.set("landing", landingMap);
configMap.set("title", new Y.Text(""));
configMap.set("description", new Y.Text(""));

const markdownEditorMounts: Array<Record<string, unknown>> = [];

function makeLoaderData() {
  return {
    project: { id: 1, github_repo_full_name: "owner/repo", github_pages_url: null },
    config: { project_id: 1, lang: "en", title: "Test site", url: null, baseurl: null },
    landing: {
      project_id: 1,
      welcome_body: null,
      stories_heading: null,
      stories_intro: null,
      objects_heading: null,
      objects_intro: null,
    },
    stories: [],
    storyStepCounts: {},
    storyCoverMap: {},
    objects: [],
    siteBaseUrl: null,
  };
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

vi.mock("react-router", () => ({
  useFetcher: () => ({
    state: "idle",
    data: undefined,
    submit: vi.fn(),
    Form: (props: React.FormHTMLAttributes<HTMLFormElement>) => <form {...props} />,
  }),
  useLoaderData: () => makeLoaderData(),
  useNavigate: () => vi.fn(),
  redirect: (url: string) => ({ url }),
  Link: ({ children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...rest}>{children}</a>
  ),
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    isPublishing: false,
    remoteCollaborators: [],
    provider: null,
    connected: true,
    publishError: false,
    setIsPublishing: vi.fn(),
    ydoc,
    undoManager: null,
    lastEditorByField: new Map(),
  }),
}));

vi.mock("~/hooks/use-collaborative-text", () => ({
  useCollaborativeText: (_yText: unknown, initialValue: string) => ({
    value: initialValue,
    handleChange: vi.fn(),
  }),
}));

vi.mock("~/lib/use-iiif-thumbnail", () => ({ useIiifThumbnail: () => null }));

vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/db.server", () => ({ getDb: () => ({}) }));
vi.mock("~/lib/membership.server", () => ({
  resolveActiveProject: vi.fn(),
  requireProjectMember: vi.fn(),
}));
vi.mock("~/lib/session.server", () => ({
  createSessionStorage: () => ({ getSession: () => ({ get: () => undefined }) }),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  closestCenter: () => undefined,
  KeyboardSensor: class {},
  PointerSensor: class {},
  useSensor: () => undefined,
  useSensors: () => [],
  DragOverlay: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  sortableKeyboardCoordinates: () => undefined,
  rectSortingStrategy: undefined,
  arrayMove: <T,>(arr: T[]) => arr,
}));

// Inline fields not under test — stub out.
vi.mock("~/components/ui/InlineTextField", () => ({ InlineTextField: () => null }));
vi.mock("~/components/ui/InlineTextArea", () => ({ InlineTextArea: () => null }));

vi.mock("~/components/ui/MarkdownEditor", () => ({
  MarkdownEditor: (props: Record<string, unknown>) => {
    markdownEditorMounts.push(props);
    return <div data-testid={`md-editor-${props.fieldName as string}`} />;
  },
}));

async function loadHomepage() {
  const mod = (await import("~/routes/_app.homepage")) as unknown as {
    default: React.ComponentType<{ loaderData: unknown }>;
  };
  return mod.default;
}

afterEach(() => {
  cleanup();
  markdownEditorMounts.length = 0;
});

describe("homepage Welcome Message editor — collaborative wiring (regression)", () => {
  it("wires welcome_body to its Yjs Y.Text (collaborative, like its sibling landing fields)", async () => {
    const Homepage = await loadHomepage();
    render(<Homepage loaderData={makeLoaderData() as unknown as never} />);

    const welcome = markdownEditorMounts.find((p) => p.fieldName === "welcome_body");
    expect(welcome, "the welcome_body MarkdownEditor should be mounted").toBeTruthy();
    expect(welcome!.yText, "welcome editor must receive a Yjs Y.Text").toBeInstanceOf(Y.Text);
    expect(welcome!.yText).toBe(landingMap.get("welcome_body"));
  });

  it("shows the localized canned default as a placeholder (not injected content)", async () => {
    const Homepage = await loadHomepage();
    render(<Homepage loaderData={makeLoaderData() as unknown as never} />);

    const welcome = markdownEditorMounts.find((p) => p.fieldName === "welcome_body");
    expect(welcome!.placeholder).toBe(WELCOME_BODY_LOCALISED.en);
  });

  it("keeps actionUrl=/homepage for the non-collaborative fallback path", async () => {
    const Homepage = await loadHomepage();
    render(<Homepage loaderData={makeLoaderData() as unknown as never} />);

    const welcome = markdownEditorMounts.find((p) => p.fieldName === "welcome_body");
    expect(welcome!.actionUrl).toBe("/homepage");
  });
});
