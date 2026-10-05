// @vitest-environment jsdom

/**
 * The story route's rename of a story's ID, with the route's real
 * handler and the real structural-ops gate over a real Y.Doc: a confirmed
 * rename writes `story_id` once; an ID another story took after the field
 * checked it is refused by the route's own check; a collaborator who did not
 * create the story is shown the ID and no field.
 *
 * Mounted as story-editor-live-objects.test.tsx mounts the route.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub, Outlet } from "react-router";
import * as Y from "yjs";
import { createOsdFake, withPoint } from "./helpers/osd-fake";
import { unavailablePanelPreview } from "~/lib/panel-preview-config";
import { resetTargetSaves } from "~/components/ui/target-saves";

const osd = withPoint(createOsdFake());
let doc = new Y.Doc();
vi.mock("openseadragon", () => ({ default: osd.ctor }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en", changeLanguage: vi.fn() } }),
  Trans: ({ i18nKey }: { i18nKey: string }) => i18nKey,
}));
vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    ydoc: doc,
    provider: { synced: true, on: () => {}, off: () => {} },
    isPublishing: false,
    undoManager: null,
    remoteCollaborators: [],
    lastEditorByField: new Map(),
  }),
  useSetAwarenessLocation: () => () => {},
  FALLBACK_HIGHLIGHT_COLOR: "#000000",
}));
vi.mock("~/hooks/use-toast", () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import StoryEditorPage from "../app/routes/_app.stories.$storyId";

const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

let viewer: { currentUserId: number; userRole: string } = { currentUserId: 7, userRole: "convenor" };

function renamedStoryLoaderData() {
  return {
    story: { id: 1, project_id: 3, story_id: "blank_template", title: "Story", subtitle: null, byline: null, order: 0, show_sections: false },
    steps: [],
    layers: [],
    objects: [],
    siteBaseUrl: "https://example.org/site",
    frameworkVersion: "1.7.0",
    siteLang: "en",
    repoFullName: "owner/site",
    members: [],
    ...viewer,
    panelPreview: Promise.resolve(unavailablePanelPreview()),
  };
}

function storyMapFor(id: number, storyId: string, createdBy: number): Y.Map<unknown> {
  const map = new Y.Map<unknown>();
  map.set("_id", id);
  map.set("story_id", storyId);
  map.set("created_by", createdBy);
  map.set("title", new Y.Text("Story"));
  map.set("subtitle", new Y.Text(""));
  map.set("byline", new Y.Text(""));
  map.set("steps", new Y.Array<Y.Map<unknown>>());
  return map;
}

/** Every value `story_id` took on the renamed story's map. */
const storyIdWrites: unknown[] = [];

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
  viewer = { currentUserId: 7, userRole: "convenor" };
  doc = new Y.Doc();
  const mine = storyMapFor(1, "blank_template", 7);
  doc.getArray<Y.Map<unknown>>("stories").push([mine, storyMapFor(2, "maps", 7)]);
  storyIdWrites.length = 0;
  mine.observe((event) => {
    if (event.keysChanged.has("story_id")) storyIdWrites.push(mine.get("story_id"));
  });
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

async function mountRenameEditor() {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => <Outlet />,
      children: [
        { path: "stories/:storyId", Component: StoryEditorPage as never, loader: (() => renamedStoryLoaderData()) as never },
        { path: "stories", action: async () => ({ ok: true, intent: "flush-yjs-snapshot" }) },
      ],
    },
  ]);
  render(<Stub initialEntries={["/stories/blank_template"]} />);
  await screen.findByText("title_card.story_id_label");
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

function storyIdInput(): HTMLInputElement | null {
  return document.getElementById("story-id") as HTMLInputElement | null;
}

async function typeAndBlur(value: string) {
  await act(async () => {
    fireEvent.change(storyIdInput()!, { target: { value } });
    fireEvent.blur(storyIdInput()!);
  });
}

describe("renaming a story's ID on the story route", () => {
  it("writes the confirmed ID to the story's map once", async () => {
    await mountRenameEditor();
    await typeAndBlur("fluidity");
    expect(storyIdWrites).toEqual([]);

    await act(async () => { fireEvent.click(screen.getByText("title_card.story_id_confirm")); });

    expect(storyIdWrites).toEqual(["fluidity"]);
  });

  it("refuses an ID another story took after the field checked it", async () => {
    await mountRenameEditor();
    await typeAndBlur("fluidity");
    act(() => { doc.getArray<Y.Map<unknown>>("stories").get(1).set("story_id", "fluidity"); });

    await act(async () => { fireEvent.click(screen.getByText("title_card.story_id_confirm")); });

    expect(storyIdWrites).toEqual([]);
    expect(doc.getArray<Y.Map<unknown>>("stories").get(0).get("story_id")).toBe("blank_template");
  });

  it("shows a collaborator who did not create the story its ID and no field", async () => {
    viewer = { currentUserId: 9, userRole: "collaborator" };
    await mountRenameEditor();
    expect(storyIdInput()).toBeNull();
    expect(screen.getByText("blank_template")).toBeTruthy();
  });

  it("gives the story's creator the field when they are a collaborator", async () => {
    viewer = { currentUserId: 7, userRole: "collaborator" };
    await mountRenameEditor();
    expect(storyIdInput()).not.toBeNull();
  });
});
