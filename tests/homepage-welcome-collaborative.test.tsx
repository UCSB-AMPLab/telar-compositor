// @vitest-environment jsdom
/**
 * Regression — the homepage Welcome Message editor must be COLLABORATIVE, like
 * every other landing field (stories_heading, objects_heading, objects_intro)
 * and every other long-form editor (page body, layer content, glossary
 * definition).
 *
 * Root cause of the persistence bug: `welcome_body` was the ONLY field the
 * Durable Object's `snapshotToD1` cycle writes to D1 that was NOT wired to its
 * Yjs `Y.Text`. The editor wrote D1 directly (fetcher autosave) while the DO
 * kept snapshotting the stale, unused Yjs `welcome_body` Y.Text back over it —
 * clobbering edits ~every snapshot cycle.
 *
 * Fix: wire the welcome `MarkdownEditor` to its Yjs `Y.Text` (collaborative
 * mode), exactly like its siblings, so edits flow through Yjs and the snapshot
 * persists them. The canned default is shown via a `placeholder` (the localized
 * `WELCOME_BODY_LOCALISED` text) instead of being injected as editable content,
 * matching how the sibling fields surface their defaults.
 *
 * Mock strategy mirrors tests/homepage-live-lang.test.tsx, but uses the REAL
 * `yjs` + REAL `getYText` so the component resolves a real welcome_body Y.Text
 * from the collaboration context.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import * as Y from "yjs";
import { WELCOME_BODY_LOCALISED } from "~/lib/v130-framework-labels";

// A real Y.Doc whose config.landing map holds a welcome_body Y.Text, so the
// component (via REAL getYText) resolves a collaborative text instance.
const ydoc = new Y.Doc();
const configMap = ydoc.getMap<unknown>("config");
const landingMap = new Y.Map<unknown>();
for (const key of ["welcome_body", "stories_heading", "stories_intro", "objects_heading", "objects_intro"]) {
  landingMap.set(key, new Y.Text(""));
}
configMap.set("landing", landingMap);
configMap.set("title", new Y.Text(""));
configMap.set("description", new Y.Text(""));

// Records the props of every MarkdownEditor mounted during a render.
const markdownEditorMounts: Array<Record<string, unknown>> = [];

function makeData() {
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
  }),
}));

vi.mock("~/lib/use-iiif-thumbnail", () => ({ useIiifThumbnail: () => null }));

// Inline fields are not under test here — stub them out.
vi.mock("~/components/ui/InlineTextField", () => ({ InlineTextField: () => null }));
vi.mock("~/components/ui/InlineTextArea", () => ({ InlineTextArea: () => null }));

vi.mock("~/components/ui/MarkdownEditor", () => ({
  MarkdownEditor: (props: Record<string, unknown>) => {
    markdownEditorMounts.push(props);
    return <div data-testid={`md-editor-${props.fieldName as string}`} />;
  },
}));

import { HomepageEditor } from "~/components/features/pages/HomepageEditor";

afterEach(() => {
  cleanup();
  markdownEditorMounts.length = 0;
});

describe("homepage Welcome Message editor — collaborative wiring (regression)", () => {
  it("wires welcome_body to its Yjs Y.Text (collaborative, like its sibling landing fields)", () => {
    render(<HomepageEditor data={makeData() as never} />);

    const welcome = markdownEditorMounts.find((p) => p.fieldName === "welcome_body");
    expect(welcome, "the welcome_body MarkdownEditor should be mounted").toBeTruthy();
    // Collaborative: it must receive the welcome_body Y.Text so edits flow
    // through Yjs (and the DO snapshot persists them instead of clobbering).
    expect(welcome!.yText, "welcome editor must receive a Yjs Y.Text").toBeInstanceOf(Y.Text);
    expect(welcome!.yText).toBe(landingMap.get("welcome_body"));
  });

  it("shows the localized canned default as a placeholder (not injected content)", () => {
    render(<HomepageEditor data={makeData() as never} />);

    const welcome = markdownEditorMounts.find((p) => p.fieldName === "welcome_body");
    expect(welcome!.placeholder).toBe(WELCOME_BODY_LOCALISED.en);
  });

  it("keeps actionUrl=/homepage for the non-collaborative fallback path", () => {
    render(<HomepageEditor data={makeData() as never} />);

    const welcome = markdownEditorMounts.find((p) => p.fieldName === "welcome_body");
    expect(welcome!.actionUrl).toBe("/homepage");
  });
});
