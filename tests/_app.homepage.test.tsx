// @vitest-environment jsdom
/**
 * This file pins component-level tests for the `_app.homepage.tsx`
 * editor — specifically the welcome editor's canned-text display, the
 * localised placeholders for stories/objects sections, and the
 * empty-state hint that appears below the empty heading/intro fields.
 *
 * Mock strategy follows tests/InstallationScopePrompt.test.tsx +
 * tests/inline-text-field.test.tsx — react-i18next returns key passthrough
 * (so assertions match i18n keys directly), react-router fakes the loader
 * data + fetcher singleton, and use-collaboration is stubbed to keep the
 * Yjs surface inert.
 *
 * @version v1.3.7-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

// ---------------------------------------------------------------------------
// Loader-data fixture builder — overrideable per test
// ---------------------------------------------------------------------------

interface LoaderDataOverrides {
  configLang?: "en" | "es";
  landingOverrides?: Partial<{
    welcome_body: string | null;
    stories_heading: string | null;
    stories_intro: string | null;
    objects_heading: string | null;
    objects_intro: string | null;
  }>;
}

function makeLoaderData(opts: LoaderDataOverrides = {}) {
  const lang = opts.configLang ?? "en";
  return {
    project: {
      id: 1,
      github_repo_full_name: "owner/repo",
      github_pages_url: null,
    },
    config: {
      project_id: 1,
      lang,
      title: "Test site",
      url: null,
      baseurl: null,
    },
    landing: {
      project_id: 1,
      welcome_body: null,
      stories_heading: null,
      stories_intro: null,
      objects_heading: null,
      objects_intro: null,
      ...(opts.landingOverrides ?? {}),
    },
    stories: [],
    storyStepCounts: {},
    storyCoverMap: {},
    objects: [],
    siteBaseUrl: null,
  };
}

let currentLoaderData: ReturnType<typeof makeLoaderData> = makeLoaderData();

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

vi.mock("~/lib/use-iiif-thumbnail", () => ({
  useIiifThumbnail: () => null,
}));

vi.mock("~/lib/yjs-helpers", () => ({
  getYText: () => null,
}));

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
  createSessionStorage: () => ({
    getSession: () => ({ get: () => undefined }),
  }),
}));

// dnd-kit pieces — return inert wrappers so the homepage's JSX renders.
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

// Stub MarkdownEditor to expose its `initialValue` as a data attribute so
// component tests can assert what the welcome editor was instantiated with —
// without booting CodeMirror. The real editor is unit-tested elsewhere.
vi.mock("~/components/ui/MarkdownEditor", () => ({
  MarkdownEditor: ({
    initialValue,
    fieldName,
  }: {
    initialValue: string;
    fieldName: string;
  }) => (
    <div
      data-testid={`md-editor-${fieldName}`}
      data-initial={initialValue}
    />
  ),
}));

// Lazy-import the route so all vi.mock calls above are in place first.
async function loadHomepage() {
  const mod = (await import("~/routes/_app.homepage")) as unknown as {
    default: React.ComponentType<{ loaderData: unknown }>;
  };
  return mod.default;
}

function renderHomepage(opts: LoaderDataOverrides = {}) {
  currentLoaderData = makeLoaderData(opts);
  return loadHomepage().then((Homepage) =>
    render(
      <Homepage loaderData={currentLoaderData as unknown as never} />,
    ),
  );
}

// ---------------------------------------------------------------------------
// Welcome editor canned-text display
// ---------------------------------------------------------------------------

describe("welcome editor canned-text display", () => {
  // Note on test surface: these tests cover the COMPONENT contract (the
  // MarkdownEditor's initialValue equals whatever landing.welcome_body the
  // loader returns). The LOADER's filter (null/liquid/legacy → canned text)
  // is the loader's responsibility and is verified end-to-end in staging
  // UAT — see 43.1-VERIFICATION.md MH-4. The fixtures below pass the
  // post-loader-filter state directly so the component contract is what's
  // under test here.

  it("welcome editor renders user content when landing.welcome_body has it", async () => {
    const userContent = "## My welcome\n\nUser content I wrote myself.";
    await renderHomepage({
      configLang: "en",
      landingOverrides: { welcome_body: userContent },
    });
    const editor = screen.getByTestId("md-editor-welcome_body");
    expect(editor.getAttribute("data-initial")).toBe(userContent);
  });

  it("welcome editor renders ES canned text when loader resolves welcome_body to it (es site)", async () => {
    // Loader filter behaviour: if welcome_body is empty/liquid/legacy, the
    // loader replaces it with WELCOME_BODY_LOCALISED[siteLang]. The component
    // just consumes the resolved value. We pass the canned ES text directly.
    const cannedEs = "## Bienvenidos a Telar\n\nTelar es una herramienta para crear exhibiciones narrativas y publicar colecciones digitales.";
    await renderHomepage({
      configLang: "es",
      landingOverrides: { welcome_body: cannedEs },
    });
    const editor = screen.getByTestId("md-editor-welcome_body");
    const initial = editor.getAttribute("data-initial") ?? "";
    expect(initial).toContain("## Bienvenidos a Telar");
    expect(initial).toContain("Telar es una herramienta");
  });

  it("NO sibling preview block JSX renders (replaced by in-editor canned text 2026-05-11)", async () => {
    // The pre-2026-05-11 design rendered a sibling muted preview block under
    // an empty editor with the i18n key preview.live_site_preview_heading.
    // The new design puts the canned text IN the editor itself — so neither
    // the heading nor the customise hint should appear in the JSX.
    await renderHomepage({
      configLang: "en",
      landingOverrides: { welcome_body: null },
    });
    expect(screen.queryByText("preview.live_site_preview_heading")).toBeNull();
    expect(screen.queryByText("preview.welcome_customise_hint")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Localised placeholders
// ---------------------------------------------------------------------------

describe("placeholders", () => {
  it("placeholder uses config.lang (es → 'Historias')", async () => {
    await renderHomepage({
      configLang: "es",
      landingOverrides: { stories_heading: null },
    });
    // The hardcoded "Stories" placeholder is swapped for LANDING_LABELS[siteLang]
    // — currently the placeholder is still "Stories" (not "Historias"), so the
    // assertion fails (RED).
    const inputs = screen.queryAllByRole("textbox") as HTMLInputElement[];
    const found = inputs.some((el) => el.placeholder === "Historias");
    expect(found).toBe(true);
  });

  it("stories_intro unchanged", async () => {
    // stories_intro is excluded from the localisation swap (no
    // v1.2.1 default exists; preserve user content per the preservation
    // rule). stories_intro has no UI surface in _app.homepage.tsx, so the
    // contract is structural: only the three fields that DO get a localised
    // placeholder (stories_heading, objects_heading, objects_intro) should
    // surface a LANDING_LABELS value as their placeholder. This test asserts
    // that the count of localised-default placeholders rendered is exactly 3
    // — a regression that accidentally added stories_intro localisation
    // would surface as a 4th match.
    await renderHomepage({
      configLang: "es",
      landingOverrides: {
        welcome_body: null,
        stories_heading: null,
        stories_intro: null,
        objects_heading: null,
        objects_intro: null,
      },
    });
    const inputs = screen.queryAllByRole("textbox") as HTMLInputElement[];
    const localisedPlaceholders = new Set([
      "Historias",
      "Explora los objetos detrás de las historias",
      "Explora {count} objetos presentes en las historias.",
    ]);
    const localisedMatches = inputs
      .map((el) => el.placeholder)
      .filter((p) => localisedPlaceholders.has(p));
    expect(localisedMatches).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Empty-state hint
// ---------------------------------------------------------------------------

describe("empty hint", () => {
  it("renders preview.empty_default_hint below empty heading/intro fields; not under welcome", async () => {
    await renderHomepage({
      configLang: "en",
      landingOverrides: {
        welcome_body: null, // welcome gets canned text, NOT empty hint
        stories_heading: null,
        objects_heading: null,
        objects_intro: null,
      },
    });
    // The preview.empty_default_hint i18n line renders below the three
    // empty heading/intro fields. Until then, the assertion fails (RED).
    const hints = screen.queryAllByText("preview.empty_default_hint");
    expect(hints.length).toBeGreaterThanOrEqual(1);
  });
});
