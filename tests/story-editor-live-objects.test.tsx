// @vitest-environment jsdom

/**
 * The story route reads the objects it offers from the collaborative document,
 * so an object added after the editor opened is there without a reload.
 *
 * The real route component is mounted on React Router's routes stub with an
 * in-memory loader, as object-id-story-route.test.tsx mounts it; the loader
 * holds no objects and the document receives one after the mount.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRoutesStub, Outlet, useLocation } from "react-router";
import * as Y from "yjs";
import { createOsdFake, withPoint } from "./helpers/osd-fake";
import { unavailablePanelPreview } from "~/lib/panel-preview-config";
import { resetTargetSaves } from "~/components/ui/target-saves";
import { makeObjectYMap } from "~/lib/object-ymap";

const osd = withPoint(createOsdFake());
let doc = new Y.Doc();
/** The provider the collaboration context hands the route: it syncs when a test says so. */
let provider: { synced: boolean; on: (e: string, f: (s: boolean) => void) => void; off: (e: string, f: (s: boolean) => void) => void } | null = null;
const syncListeners = new Set<(s: boolean) => void>();
function makeProvider(synced: boolean) {
  syncListeners.clear();
  return {
    synced,
    on: (_e: string, f: (s: boolean) => void) => void syncListeners.add(f),
    off: (_e: string, f: (s: boolean) => void) => void syncListeners.delete(f),
  };
}
function syncProvider() {
  provider!.synced = true;
  syncListeners.forEach((f) => f(true));
}
vi.mock("openseadragon", () => ({ default: osd.ctor }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en", changeLanguage: vi.fn() } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: doc,
    provider,
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

let fixture: { steps: Array<ReturnType<typeof mediaStep>>; objects: never[] } = { steps: [], objects: [] };

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
  fixture = { steps: [{ ...mediaStep(11, 1), object_id: "film" }], objects: [] };
  doc = new Y.Doc();
  provider = makeProvider(true);
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


function addFilm() {
  doc.getArray<Y.Map<unknown>>("objects").push([filmMap()]);
}

function filmMap() {
  return makeObjectYMap({
    objectId: "film.jpg",
    title: "Film",
    sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    validationState: "valid",
    origin: "compositor",
    orderKey: "a0",
  });
}

const FILM_ROW = {
  object_id: "film.jpg",
  title: "Film",
  thumbnail: null,
  image_available: false,
  source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  alt_text: null,
};

/** Opens the step's object picker and returns the titles it lists. */
async function pickerTitles(): Promise<string[]> {
  await act(async () => {
    fireEvent.click(screen.getAllByLabelText("viewer.change_object")[0]);
  });
  const heading = await screen.findByText("object_picker.title");
  const dialog = heading.closest('[role="dialog"], dialog') ?? heading.parentElement!.parentElement!;
  return Array.from(dialog.querySelectorAll("button"))
    .map((b) => b.textContent ?? "")
    .filter((t) => t.includes("Film"));
}

describe("the story route's objects", () => {
  it("has no video badge for a step naming an object neither the loader nor the document holds", async () => {
    await mountEditor("/stories/s1?step=1");
    expect(screen.queryAllByText(/media\.media_type_video/)).toHaveLength(0);
  });
  it("reads an object added to the document after the editor opened, without a reload", async () => {
    await mountEditor("/stories/s1?step=1");
    act(() => addFilm());
    await waitFor(() => expect(screen.queryAllByText(/media\.media_type_video/).length).toBeGreaterThan(0));
  });
  it("lists an object added to the document after the editor opened in the object picker", async () => {
    await mountEditor("/stories/s1?step=1");
    act(() => addFilm());
    await waitFor(() => expect(screen.queryAllByText(/media\.media_type_video/).length).toBeGreaterThan(0));
    expect(await pickerTitles()).toHaveLength(1);
  });
  it("offers nothing in the picker once the last object is deleted after the document synced", async () => {
    fixture = { ...fixture, objects: [FILM_ROW] as never[] };
    addFilm();
    await mountEditor("/stories/s1?step=1");
    act(() => doc.getArray<Y.Map<unknown>>("objects").delete(0, 1));
    expect(await pickerTitles()).toHaveLength(0);
  });
  it("lists the loader's objects in the picker before the document has synced", async () => {
    fixture = { ...fixture, objects: [FILM_ROW] as never[] };
    provider = makeProvider(false);
    await mountEditor("/stories/s1?step=1");
    expect(await pickerTitles()).toHaveLength(1);
  });
  it("stops offering a loader object the synced document does not hold", async () => {
    fixture = { ...fixture, objects: [FILM_ROW] as never[] };
    provider = makeProvider(false);
    await mountEditor("/stories/s1?step=1");
    act(() => syncProvider());
    expect(await pickerTitles()).toHaveLength(0);
  });
});
