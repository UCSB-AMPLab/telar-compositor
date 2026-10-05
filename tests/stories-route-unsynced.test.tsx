// @vitest-environment jsdom
/**
 * The stories page shows the loader's list while the shared document has not
 * synced, and that list is read-only: a toggle or a new story made against it
 * would reach D1 (or nowhere) while the document, which is the source of truth,
 * kept the old values and wrote them back at its next snapshot. After the sync
 * the same controls work.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";
import { EventEmitter } from "node:events";
import * as Y from "yjs";

const fetcherSubmit = vi.fn();
const addStory = vi.fn();
const flushSubmit = vi.fn();

const collab: { current: any } = { current: null };

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock("react-router", () => ({
  redirect: vi.fn(),
  useFetcher: () => ({ state: "idle", data: undefined, submit: fetcherSubmit }),
  useNavigate: () => vi.fn(),
  useOutletContext: () => ({}),
  Link: (p: any) => <a href={String(p.to)}>{p.children}</a>,
}));
vi.mock("~/lib/page-site", () => ({
  useSiteFetcher: () => ({ state: "idle", data: undefined, submit: flushSubmit }),
}));
vi.mock("~/lib/db.server", () => ({ getDb: vi.fn() }));
vi.mock("~/middleware/auth.server", () => ({ userContext: Symbol("userContext") }));
vi.mock("~/lib/active-project.server", () => ({ resolveActiveProjectFromRequest: vi.fn() }));
vi.mock("~/lib/page-site-gate.server", () => ({ gatePageSite: vi.fn() }));
vi.mock("~/lib/membership.server", () => ({ requireProjectMember: vi.fn() }));
vi.mock("~/lib/internal-marker.server", () => ({ makeInternalMarkerHeaders: vi.fn() }));
vi.mock("~/hooks/use-collaboration", () => ({
  FALLBACK_HIGHLIGHT_COLOR: "x",
  useCollaborationContext: () => collab.current,
}));
vi.mock("~/hooks/use-structural-ops", () => ({
  useStructuralOps: () => ({
    addStory,
    canDelete: () => true,
    reorderStories: vi.fn(),
    deleteStory: vi.fn(),
  }),
}));
vi.mock("~/hooks/use-remote-delete-toast", () => ({ useRemoteDeleteToast: () => {} }));

import StoriesPage from "~/routes/_app.stories";

const LOADER_STORY = {
  id: 7,
  story_id: "the-river",
  title: "The river",
  subtitle: null,
  byline: null,
  private: false,
  draft: false,
  updated_at: null,
};

function setup(showNewForm = false) {
  const ydoc = new Y.Doc();
  const provider = new EventEmitter() as any;
  provider.synced = false;
  collab.current = {
    ydoc,
    provider,
    connectionStatus: "connecting",
    remoteCollaborators: [],
  };
  const loaderData: any = {
    project: { id: 1 },
    stories: [LOADER_STORY],
    storyStepCounts: {},
    showNewForm,
    members: [],
    currentUserId: 1,
    userRole: "convenor",
  };
  const view = render(<StoriesPage {...({ loaderData } as any)} />);
  const rerender = () => view.rerender(<StoriesPage {...({ loaderData } as any)} />);
  return { ydoc, provider, rerender };
}

/** What the server sends at first sync: the story, now in the document. */
function syncWithStory(ydoc: Y.Doc, provider: any) {
  act(() => {
    ydoc.transact(() => {
      const m = new Y.Map<unknown>();
      m.set("_id", 7);
      m.set("story_id", "the-river");
      m.set("title", "The river");
      m.set("draft", false);
      m.set("private", false);
      ydoc.getArray<Y.Map<unknown>>("stories").push([m]);
    });
    provider.synced = true;
    provider.emit("sync", true);
  });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("the stories page before the document has synced", () => {
  it("shows the loader's story with its controls disabled and says why", () => {
    setup();
    expect(screen.getByText("The river")).toBeTruthy();
    expect(screen.getByText("loading_state")).toBeTruthy();
    for (const sw of screen.getAllByRole("switch")) expect((sw as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("new_story_button") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("delete_story.title") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("drag_reorder_aria") as HTMLButtonElement).disabled).toBe(true);
  });

  it("changes nothing when a toggle is clicked", () => {
    const { ydoc } = setup();
    for (const sw of screen.getAllByRole("switch")) fireEvent.click(sw);
    expect(fetcherSubmit).not.toHaveBeenCalled();
    expect(ydoc.getArray("stories").length).toBe(0);
  });

  it("does not open a form to lose, and creates nothing", () => {
    setup();
    fireEvent.click(screen.getByText("new_story_button"));
    expect(screen.queryByPlaceholderText("new_story_placeholder")).toBeNull();
    expect(addStory).not.toHaveBeenCalled();
  });
});

describe("the stories page opened with ?new=true before the sync", () => {
  it("holds the form back until the document can take the story", () => {
    const { ydoc, provider } = setup(true);
    expect(screen.queryByPlaceholderText("new_story_placeholder")).toBeNull();
    syncWithStory(ydoc, provider);
    expect(screen.getByPlaceholderText("new_story_placeholder")).toBeTruthy();
  });
});

describe("a form that is open when the document is replaced by an unsynced one", () => {
  it("keeps what was typed, refuses Save meanwhile, and saves it once synced again", () => {
    const { ydoc, provider, rerender } = setup();
    syncWithStory(ydoc, provider);
    fireEvent.click(screen.getByText("new_story_button"));
    fireEvent.change(screen.getByPlaceholderText("new_story_placeholder"), { target: { value: "Fresh story" } });
    fireEvent.change(screen.getByPlaceholderText("new_story_subtitle_placeholder"), { target: { value: "A subtitle" } });
    fireEvent.change(screen.getByPlaceholderText("new_story_byline_placeholder"), { target: { value: "By me" } });

    // A state reset: a new document and provider, nothing received yet.
    const freshProvider = new EventEmitter() as any;
    freshProvider.synced = false;
    const freshDoc = new Y.Doc();
    collab.current = { ...collab.current, ydoc: freshDoc, provider: freshProvider };
    rerender();

    expect((screen.getByPlaceholderText("new_story_placeholder") as HTMLInputElement).value).toBe("Fresh story");
    expect((screen.getByPlaceholderText("new_story_subtitle_placeholder") as HTMLInputElement).value).toBe("A subtitle");
    const save = screen.getByText("save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    fireEvent.keyDown(screen.getByPlaceholderText("new_story_placeholder"), { key: "Enter" });
    expect(addStory).not.toHaveBeenCalled();

    syncWithStory(freshDoc, freshProvider);
    expect((screen.getByText("save") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText("save"));
    expect(addStory).toHaveBeenCalledWith("Fresh story", "fresh-story", "A subtitle", "By me");
  });
});

describe("the stories page after the document has synced", () => {
  it("toggles through the document and creates a story", () => {
    const { ydoc, provider } = setup();
    syncWithStory(ydoc, provider);

    expect(screen.queryByText("loading_state")).toBeNull();
    const [draftSwitch] = screen.getAllByRole("switch");
    expect((draftSwitch as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(draftSwitch);
    expect(ydoc.getArray<Y.Map<unknown>>("stories").get(0).get("draft")).toBe(true);
    expect(fetcherSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("new_story_button"));
    fireEvent.change(screen.getByPlaceholderText("new_story_placeholder"), { target: { value: "Fresh story" } });
    fireEvent.click(screen.getByText("save"));
    expect(addStory).toHaveBeenCalledWith("Fresh story", "fresh-story", "", "");
  });
});
