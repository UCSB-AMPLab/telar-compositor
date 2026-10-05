// @vitest-environment jsdom

/**
 * The story route's viewer reads a step's object where the site publishes it.
 *
 * A step naming `codex` shows, on the published site, the self-hosted object
 * written `codex.jpg`, whose tiles the site builds under `codex`. The real
 * route component is mounted on React Router's routes stub with an in-memory
 * loader, as story-route-panels.test.tsx mounts it, and the addresses its
 * viewer asks for are recorded.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createRoutesStub, Outlet, useLocation } from "react-router";
import { createOsdFake, withPoint } from "./helpers/osd-fake";
import { unavailablePanelPreview } from "~/lib/panel-preview-config";
import { resetTargetSaves } from "~/components/ui/target-saves";

const osd = withPoint(createOsdFake());
vi.mock("openseadragon", () => ({ default: osd.ctor }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en", changeLanguage: vi.fn() } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: null,
    provider: null,
    isPublishing: false,
    undoManager: null,
    remoteCollaborators: [],
    lastEditorByField: new Map(),
  }),
  useSetAwarenessLocation: () => () => {},
  FALLBACK_HIGHLIGHT_COLOR: "#000000",
}));
vi.mock("~/hooks/use-structural-ops", () => ({ useStructuralOps: () => null }));
vi.mock("~/hooks/use-toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import StoryEditorPage from "../app/routes/_app.stories.$storyId";

// jsdom has no layout; CodeMirror's coordsAtPos measures a Range.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

function mediaStep(id: number, n: number) {
  return {
    id,
    story_id: 1,
    step_number: n,
    kind: "media",
    question: `Question ${n}`,
    answer: "Answer",
    alt_text: null,
    object_id: null as string | null,
    x: null,
    y: null,
    zoom: null,
    page: null,
    clip_start: null,
    clip_end: null,
    loop: null,
  };
}

interface FixtureObject {
  object_id: string;
  title: string;
  thumbnail: string | null;
  image_available: boolean;
  source_url: string | null;
  alt_text: string | null;
}
const CODEX: FixtureObject = { object_id: "codex.jpg", title: "Codex", thumbnail: null, image_available: true, source_url: null, alt_text: null };
const FILM: FixtureObject = {
  object_id: "film.jpg",
  title: "Film",
  thumbnail: null,
  image_available: false,
  source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  alt_text: null,
};

/** The steps and objects the next mount's loader answers with. */
let fixture: { steps: Array<ReturnType<typeof mediaStep>>; objects: FixtureObject[] } = { steps: [], objects: [] };

function snapshot() {
  return {
    story: { id: 1, project_id: 3, story_id: "s1", title: "Story", subtitle: null, byline: null, order: 1, show_sections: false },
    steps: fixture.steps,
    layers: [],
    objects: fixture.objects,
    siteBaseUrl: "https://example.org/site",
    frameworkVersion: "1.7.0",
    siteLang: "en",
    repoFullName: "owner/site",
    members: [],
    currentUserId: 7,
    userRole: "convenor",
    panelPreview: Promise.resolve(unavailablePanelPreview()),
  };
}

function Shell() {
  const location = useLocation();
  return (
    <>
      <output data-testid="search">{location.search}</output>
      <Outlet />
    </>
  );
}

/** Every address the page fetched. */
const requested: string[] = [];

let restoreSize: () => void = () => {};
beforeEach(() => {
  osd.reset();
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const saved = {
    w: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"),
    h: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight"),
  };
  Object.defineProperty(proto, "clientWidth", { configurable: true, get: () => 1240 });
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: () => 768 });
  vi.stubGlobal("innerWidth", 1440);
  vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  requested.length = 0;
  fixture = { steps: [{ ...mediaStep(11, 1), object_id: "codex" }], objects: [CODEX] };
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return new Response("", { status: 404 });
  }));
  restoreSize = () => {
    if (saved.w) Object.defineProperty(proto, "clientWidth", saved.w);
    if (saved.h) Object.defineProperty(proto, "clientHeight", saved.h);
  };
});
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  resetTargetSaves();
  restoreSize();
  vi.unstubAllGlobals();
});

async function mountEditor(entry: string) {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: Shell,
      children: [{ path: "stories/:storyId", Component: StoryEditorPage as never, loader: (() => snapshot()) as never }],
    },
  ]);
  render(<Stub initialEntries={[entry]} />);
  await screen.findAllByText("Question 1");
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

describe("the story route's viewer", () => {
  it("reads the self-hosted codex.jpg a step naming codex shows, under codex", async () => {
    await mountEditor("/stories/s1?step=1");
    await waitFor(() =>
      expect(requested.some((url) => url.startsWith("https://example.org/site/iiif/objects/codex/"))).toBe(true),
    );
    expect(requested.some((url) => url.includes("/iiif/objects/codex.jpg/"))).toBe(false);
  });
});

describe("the story route's step list", () => {
  it("badges a step naming film as the video film.jpg the site shows for it", async () => {
    fixture = { steps: [{ ...mediaStep(11, 1), object_id: "film" }], objects: [FILM] };
    await mountEditor("/stories/s1?step=1");
    expect(screen.queryAllByText(/media\.media_type_video/).length).toBeGreaterThan(0);
  });
});

describe("the story route's media scene", () => {
  it("is every consecutive step the site shows film.jpg for, whatever form each names it in", async () => {
    fixture = {
      steps: [
        { ...mediaStep(11, 1), object_id: "film" },
        { ...mediaStep(12, 2), object_id: "film.jpg" },
      ],
      objects: [FILM],
    };
    await mountEditor("/stories/s1?step=1");
    expect(screen.queryAllByTestId("scene-card-measure")).toHaveLength(2);
  });
  it("joins a step naming FILM, which only the objects resolve, to one naming film.jpg", async () => {
    fixture = {
      steps: [
        { ...mediaStep(11, 1), object_id: "FILM" },
        { ...mediaStep(12, 2), object_id: "film.jpg" },
      ],
      objects: [FILM],
    };
    await mountEditor("/stories/s1?step=1");
    expect(screen.queryAllByTestId("scene-card-measure")).toHaveLength(2);
  });
});
