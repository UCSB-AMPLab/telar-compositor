// @vitest-environment jsdom
/**
 * Regression: the stories-section intro paragraph (`stories_intro`) is rendered
 * by the framework homepage (telar/_layouts/index.html — a `<p class="lead">`
 * shown when set) and round-trips through the snapshot, but had no editor input
 * — only `stories_heading` was bound. Users could not author it. This pins that
 * an InlineTextArea wired to the landing `stories_intro` Y.Text is mounted, so
 * edits flow through Yjs and the snapshot persists them.
 *
 * Mirrors homepage-welcome-collaborative.test.tsx, but records InlineTextArea
 * props (instead of stubbing them out) to assert the binding.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import * as Y from "yjs";

const ydoc = new Y.Doc();
const configMap = ydoc.getMap<unknown>("config");
const landingMap = new Y.Map<unknown>();
for (const key of ["welcome_body", "stories_heading", "stories_intro", "objects_heading", "objects_intro"]) {
  landingMap.set(key, new Y.Text(""));
}
configMap.set("landing", landingMap);
configMap.set("title", new Y.Text(""));
configMap.set("description", new Y.Text(""));

const inlineTextAreaMounts: Array<Record<string, unknown>> = [];

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

vi.mock("~/components/ui/InlineTextField", () => ({ InlineTextField: () => null }));
vi.mock("~/components/ui/InlineTextArea", () => ({
  InlineTextArea: (props: Record<string, unknown>) => {
    inlineTextAreaMounts.push(props);
    return <div data-testid={`inline-textarea-${props.fieldKey as string}`} />;
  },
}));
vi.mock("~/components/ui/MarkdownEditor", () => ({ MarkdownEditor: () => null }));

import { HomepageEditor } from "~/components/features/pages/HomepageEditor";

afterEach(() => {
  cleanup();
  inlineTextAreaMounts.length = 0;
});

describe("homepage stories-section intro editor", () => {
  it("mounts an InlineTextArea wired to the landing stories_intro Y.Text", () => {
    render(<HomepageEditor data={makeData() as never} />);

    const storiesIntro = inlineTextAreaMounts.find((p) => p.fieldKey === "homepage-stories-intro");
    expect(storiesIntro, "a stories_intro InlineTextArea should be mounted").toBeTruthy();
    expect(storiesIntro!.yText, "it must receive a Yjs Y.Text").toBeInstanceOf(Y.Text);
    expect(storiesIntro!.yText).toBe(landingMap.get("stories_intro"));
  });
});
