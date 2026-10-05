// @vitest-environment jsdom
/**
 * The homepage editor's objects section, with nothing in the collection yet.
 *
 * The empty state is the one place on the page that tells an author where the
 * next move happens, so it is a catalogue string in both locales rather than a
 * sentence in the JSX. `catalogueT` resolves against the shipped files, so the
 * key missing from either locale fails here rather than shipping as a raw key
 * on the screen.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import * as Y from "yjs";
import type { CatalogueLanguage } from "./helpers/catalogue-translator";

/** The locale the next render reads; each test sets it before rendering. */
let language: CatalogueLanguage = "en";

const ydoc = new Y.Doc();
const configMap = ydoc.getMap<unknown>("config");
const landingMap = new Y.Map<unknown>();
for (const key of [
  "welcome_body",
  "stories_heading",
  "stories_intro",
  "objects_heading",
  "objects_intro",
]) {
  landingMap.set(key, new Y.Text(""));
}
configMap.set("landing", landingMap);
configMap.set("title", new Y.Text(""));
configMap.set("description", new Y.Text(""));

vi.mock("react-i18next", async () => {
  const { catalogueT } = await import("./helpers/catalogue-translator");
  return {
    // The editor holds two namespaces at once (`dashboard` for the section
    // scaffolding, `homepage` for the fields), so the stub has to honour the
    // argument rather than serve one catalogue to both.
    useTranslation: (namespace: string | string[]) => ({
      t: catalogueT(Array.isArray(namespace) ? namespace[0] : namespace, language),
    }),
    Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
  };
});

vi.mock("react-router", () => ({
  useFetcher: () => ({
    state: "idle",
    data: undefined,
    submit: vi.fn(),
    Form: (props: React.FormHTMLAttributes<HTMLFormElement>) => <form {...props} />,
  }),
  useNavigate: () => vi.fn(),
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
    currentValue: () => initialValue,
    lastWriteIsOwn: () => false,
  }),
}));

vi.mock("~/lib/use-iiif-thumbnail", () => ({ useIiifThumbnail: () => null }));
vi.mock("~/components/ui/InlineTextField", () => ({ InlineTextField: () => null }));
vi.mock("~/components/ui/InlineTextArea", () => ({ InlineTextArea: () => null }));
vi.mock("~/components/ui/InlineHtmlEditor", () => ({ InlineHtmlEditor: () => null }));
vi.mock("~/components/ui/MarkdownEditor", () => ({ MarkdownEditor: () => null }));

import { HomepageEditor } from "~/components/features/pages/HomepageEditor";

afterEach(() => {
  cleanup();
  language = "en";
});

/** The editor's data with an empty collection, which is what shows the state. */
function emptyCollection() {
  return {
    project: { id: 42, github_pages_url: null, last_synced_at: null },
    config: { lang: "en", title: "T", description: "D", featured_count: 4 },
    landing: {
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

describe("homepage editor — the objects section with nothing in it", () => {
  it("reads the English empty state from the catalogue", () => {
    render(<HomepageEditor data={emptyCollection() as never} />);

    expect(
      screen.queryByText("No objects yet. Use the Objects tab to add images to your collection."),
    ).not.toBeNull();
  });

  it("reads the Spanish empty state, which names the Objects tab as a tab", () => {
    language = "es";
    render(<HomepageEditor data={emptyCollection() as never} />);

    expect(
      screen.queryByText(
        "Aún no hay objetos. Agrega imágenes a tu colección desde la pestaña de Objetos.",
      ),
    ).not.toBeNull();
  });
});
