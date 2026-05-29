// @vitest-environment jsdom
/**
 * Regression — the homepage Welcome Message editor must autosave to a route
 * whose action handles `autosave-landing`.
 *
 * BUG: `_app.homepage.tsx` mounted the welcome `MarkdownEditor` without an
 * `actionUrl`, so the editor fell back to MarkdownEditor's `/dashboard`
 * default. The `/dashboard` action has no `autosave-landing` case, so every
 * keystroke's debounced autosave POST hit its `default:` branch and threw
 * `400 Bad Request`, which the route error boundary surfaced as "Something
 * went wrong". These preview sections were relocated from `_app.dashboard.tsx`
 * to `_app.homepage.tsx`, but the editor's autosave target was never updated,
 * so it kept posting to the old `/dashboard` route. The `autosave-landing`
 * handler lives ONLY on the `/homepage` action, so the editor must target
 * `/homepage` explicitly.
 *
 * Mock strategy mirrors tests/_app.homepage.test.tsx (the proven scaffold for
 * rendering the homepage editor in jsdom), but the MarkdownEditor stub records
 * all props so the autosave target can be asserted.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";

// Records the props of every MarkdownEditor mounted during a render.
const markdownEditorMounts: Array<Record<string, unknown>> = [];

function makeLoaderData() {
  return {
    project: {
      id: 1,
      github_repo_full_name: "owner/repo",
      github_pages_url: null,
    },
    config: {
      project_id: 1,
      lang: "en",
      title: "Test site",
      url: null,
      baseurl: null,
    },
    landing: {
      project_id: 1,
      welcome_body: "Hello world",
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
    connected: false,
    publishError: false,
    setIsPublishing: vi.fn(),
    ydoc: null,
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
vi.mock("~/lib/yjs-helpers", () => ({ getYText: () => null }));

vi.mock("yjs", () => ({
  Map: class YMap {
    get() { return null; }
    set() { /* noop */ }
  },
  Text: class YText {},
  Doc: class YDoc {
    getMap() { return null; }
    getText() { return null; }
  },
}));

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

describe("homepage Welcome Message editor — autosave target (regression)", () => {
  it("autosaves welcome_body to /homepage (the only action handling autosave-landing)", async () => {
    const Homepage = await loadHomepage();
    render(<Homepage loaderData={makeLoaderData() as unknown as never} />);

    const welcome = markdownEditorMounts.find((p) => p.fieldName === "welcome_body");
    expect(welcome, "the welcome_body MarkdownEditor should be mounted").toBeTruthy();
    expect(welcome!.intent).toBe("autosave-landing");
    // RED before the fix: `actionUrl` is undefined, so MarkdownEditor falls
    // back to its "/dashboard" default — a route with no autosave-landing
    // handler — and the autosave 400s.
    expect(welcome!.actionUrl).toBe("/homepage");
  });
});
