// @vitest-environment jsdom

/**
 * The story route's layer panels, with the route's real handlers: opening a layer of another step writes
 * `?step` and `?layer` together, a deep link opens its layer without moving focus, and deleting a
 * layer updates `?layer`.
 *
 * The real route component is mounted on React Router's routes stub, with an
 * in-memory loader and no Y.Doc, as story-stage-stale-loader.test.tsx mounts
 * it: the layers come from the loader, and a layer's delete closes its panel
 * directly.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    object_id: null,
    x: null,
    y: null,
    zoom: null,
    page: null,
    clip_start: null,
    clip_end: null,
    loop: null,
  };
}

function panelLayer(id: number, stepId: number, n: 1 | 2, label: string) {
  return { id, step_id: stepId, layer_number: n, title: null, button_label: label, content: `Text of ${label}` };
}

function snapshot() {
  return {
    story: { id: 1, project_id: 3, story_id: "s1", title: "Story", subtitle: null, byline: null, order: 1, show_sections: false },
    steps: [mediaStep(11, 1), mediaStep(12, 2)],
    layers: [panelLayer(51, 11, 1, "First more"), panelLayer(52, 11, 2, "First deeper"), panelLayer(61, 12, 1, "Second more")],
    objects: [],
    siteBaseUrl: null,
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
  vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
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

/** A click, and the navigation and revalidation it starts. */
async function press(el: Element) {
  fireEvent.click(el);
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

const search = () => new URLSearchParams(screen.getByTestId("search").textContent ?? "");
const panel = (n: 1 | 2) => screen.queryByTestId(`stage-panel-${n}`);

describe("the story route's layer panels", () => {
  it("opening another step's layer writes ?step and ?layer together", async () => {
    await mountEditor("/stories/s1?step=1");
    // The step list's row for step 2's panel, in the static sidebar.
    await press(screen.getAllByText("Second more")[0].closest("button")!);
    expect(search().get("step")).toBe("2");
    expect(search().get("layer")).toBe("1");
    expect(panel(1)).not.toBeNull();
    expect(panel(1)!.textContent).toContain("Text of Second more");
  });

  it("opens the layer a deep link names without moving focus", async () => {
    await mountEditor("/stories/s1?step=1&layer=2");
    expect(panel(2)).not.toBeNull();
    expect(panel(1)!.hasAttribute("inert")).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });

  it("deleting layer 2 leaves layer 1 open and ?layer=1", async () => {
    await mountEditor("/stories/s1?step=1&layer=2");
    await press(panel(2)!.querySelector(".stage-panel-delete")!);
    expect(search().get("layer")).toBe("1");
    expect(panel(2)).toBeNull();
    expect(panel(1)).not.toBeNull();
  });

  it("deleting layer 1 closes it and removes ?layer", async () => {
    await mountEditor("/stories/s1?step=2&layer=1");
    await press(panel(1)!.querySelector(".stage-panel-delete")!);
    expect(search().get("layer")).toBeNull();
    expect(search().get("step")).toBe("2");
    expect(panel(1)).toBeNull();
  });

  it("opening from the card writes ?layer beside ?step, and closing removes it", async () => {
    await mountEditor("/stories/s1?step=1");
    await press(document.querySelector(".text-card .panel-trigger")!);
    expect(search().toString()).toBe("step=1&layer=1");
    await press(panel(1)!.querySelector(".btn-close")!);
    expect(search().toString()).toBe("step=1");
  });

  it("names the second panel as the reason layer 1 cannot be deleted while it exists", async () => {
    await mountEditor("/stories/s1?step=1&layer=1");
    const del = panel(1)!.querySelector(".stage-panel-delete")!;
    expect(del.getAttribute("aria-disabled")).toBe("true");
    expect(del.getAttribute("title")).toBe("layer.cannot_delete_has_layer2");
  });

  it("gives an enabled layer 1 delete no tooltip", async () => {
    await mountEditor("/stories/s1?step=2&layer=1");
    const del = panel(1)!.querySelector(".stage-panel-delete")!;
    expect(del.hasAttribute("aria-disabled")).toBe(false);
    expect(del.hasAttribute("title")).toBe(false);
  });
});
