// @vitest-environment jsdom
/**
 * Homepage/landing labels follow the site language live. The landing editor
 * currently derives its placeholder language once from the loader snapshot
 * (`siteLang = config?.lang`), so after a language change writes the Yjs
 * `config.lang` map the placeholders stay stale until a full reload.
 *
 * This test mounts the landing editor inside a real Y.Doc, sets `config.lang`
 * to "en" and asserts an EN landing placeholder renders, then mutates the live
 * Yjs value to "es" inside a transact and asserts the placeholder switches to
 * Spanish WITHOUT a remount or loader refetch.
 *
 * The component must replace `siteLang` with a `liveSiteLang` state driven by a
 * `config.observeDeep` observer for the live mutate to take effect.
 *
 * Mock strategy mirrors tests/_app.homepage.test.tsx, but uses the REAL `yjs`
 * module and a REAL Y.Doc (not the inert stub) so observers actually fire.
 *
 * @version v1.3.7-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";
import React from "react";
import * as Y from "yjs";

// A real, shared Y.Doc whose `config` map drives the live language. The
// component resolves `ydoc.getMap("config")` and observes it.
const ydoc = new Y.Doc();
const configMap = ydoc.getMap<unknown>("config");

function makeLoaderData(lang: "en" | "es") {
  return {
    project: { id: 1, github_repo_full_name: "owner/repo", github_pages_url: null },
    config: { project_id: 1, lang, title: "Test site", url: null, baseurl: null },
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

let currentLoaderData = makeLoaderData("en");

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
  useLoaderData: () => currentLoaderData,
  useNavigate: () => vi.fn(),
  redirect: (url: string) => ({ url }),
  Link: ({ children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a {...rest}>{children}</a>
  ),
}));

// The crucial difference from _app.homepage.test.tsx: expose the REAL Y.Doc so
// the observer reads live `config.lang`.
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    isPublishing: false,
    remoteCollaborators: [],
    provider: null,
    connected: false,
    publishError: false,
    setIsPublishing: vi.fn(),
    ydoc,
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

// getYText returns null so the inline fields fall back to their loader
// initialValue + placeholder path (the placeholder is what we assert on).
vi.mock("~/lib/yjs-helpers", () => ({ getYText: () => null }));

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
  MouseSensor: class {},
  TouchSensor: class {},
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
  MarkdownEditor: ({ initialValue, fieldName }: { initialValue: string; fieldName: string }) => (
    <div data-testid={`md-editor-${fieldName}`} data-initial={initialValue} />
  ),
}));

async function loadHomepage() {
  const mod = (await import("~/routes/_app.homepage")) as unknown as {
    default: React.ComponentType<{ loaderData: unknown }>;
  };
  return mod.default;
}

function placeholders(): string[] {
  return (screen.queryAllByRole("textbox") as HTMLInputElement[]).map((el) => el.placeholder);
}

afterEach(() => {
  cleanup();
});

describe("landing labels follow the LIVE Yjs config.lang", () => {
  it("renders an EN placeholder when config.lang starts at 'en'", async () => {
    act(() => {
      ydoc.transact(() => configMap.set("lang", "en"));
    });
    currentLoaderData = makeLoaderData("en");
    const Homepage = await loadHomepage();
    render(<Homepage loaderData={currentLoaderData as unknown as never} />);

    // EN object-heading placeholder from LANDING_LABELS.en.
    expect(placeholders()).toContain("See the objects behind the stories");
  });

  it("switches the placeholder to Spanish when config.lang mutates 'en' → 'es' — no remount, no reload", async () => {
    act(() => {
      ydoc.transact(() => configMap.set("lang", "en"));
    });
    currentLoaderData = makeLoaderData("en");
    const Homepage = await loadHomepage();
    render(<Homepage loaderData={currentLoaderData as unknown as never} />);

    expect(placeholders()).toContain("See the objects behind the stories");

    // Live language change — same mount, no loader refetch. The observer
    // must drive the placeholder to the Spanish label set.
    act(() => {
      ydoc.transact(() => configMap.set("lang", "es"));
    });

    expect(placeholders()).toContain("Explora los objetos detrás de las historias");
    expect(placeholders()).not.toContain("See the objects behind the stories");
  });
});
