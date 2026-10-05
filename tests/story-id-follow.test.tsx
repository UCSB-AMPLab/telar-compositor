// @vitest-environment jsdom
/**
 * Everyone with a story open follows its ID when it changes: the
 * editor finds the story's map by its row id, so it keeps editing the same
 * story, and once the document holds a new ID the page asks the Durable
 * Object to write it to D1 and then moves to the new address, keeping the
 * open step and layer. A flush that fails leaves the page where it is. An ID
 * the document already holds when the page subscribes is followed too. The
 * editor's loader looks the story up by the ID in
 * the address, so a page left on the old one would show Not Found at its next
 * load.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { createRoutesStub, useLocation } from "react-router";
import * as Y from "yjs";

import { useFollowStoryId } from "~/hooks/use-follow-story-id";
import { shouldRevalidate } from "~/routes/_app.stories.$storyId";

function storyMap(id: string): Y.Map<unknown> {
  const doc = new Y.Doc();
  const map = new Y.Map<unknown>();
  doc.getArray<Y.Map<unknown>>("stories").push([map]);
  map.set("story_id", id);
  return map;
}

function mountFollowingEditor(
  map: Y.Map<unknown>,
  flushed: string[],
  answer: Record<string, unknown> = { ok: true, intent: "flush-yjs-snapshot" },
) {
  function FollowingEditor() {
    useFollowStoryId(map, "blank_template");
    const { pathname, search } = useLocation();
    return <p data-testid="at">{pathname + search}</p>;
  }
  const Stub = createRoutesStub([
    { path: "/stories/:storyId", Component: FollowingEditor },
    {
      path: "/stories",
      action: async ({ request }) => {
        flushed.push(String((await request.formData()).get("intent")));
        return answer;
      },
    },
  ]);
  render(<Stub initialEntries={["/stories/blank_template?step=2&layer=1"]} />);
}

describe("useFollowStoryId", () => {
  it("flushes the document and then moves to the new address", async () => {
    const map = storyMap("blank_template");
    const flushed: string[] = [];
    mountFollowingEditor(map, flushed);

    act(() => { map.set("story_id", "fluidity"); });

    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/stories/fluidity?step=2&layer=1"));
    expect(flushed).toEqual(["flush-yjs-snapshot"]);
  });

  it("follows an ID the document already holds when the page subscribes", async () => {
    const map = storyMap("fluidity");
    const flushed: string[] = [];
    mountFollowingEditor(map, flushed);

    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/stories/fluidity?step=2&layer=1"));
    expect(flushed).toEqual(["flush-yjs-snapshot"]);
  });

  it("stays at the address when the flush fails, since D1 still holds the old ID", async () => {
    const map = storyMap("blank_template");
    const flushed: string[] = [];
    mountFollowingEditor(map, flushed, { ok: false, intent: "flush-yjs-snapshot", error: "snapshot_failed" });

    act(() => { map.set("story_id", "fluidity"); });

    await waitFor(() => expect(flushed).toEqual(["flush-yjs-snapshot"]));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("at").textContent).toBe("/stories/blank_template?step=2&layer=1");
  });

  it("stays put while the document holds the address's ID, or no ID", async () => {
    const map = storyMap("blank_template");
    const flushed: string[] = [];
    mountFollowingEditor(map, flushed);

    act(() => { map.set("title", "Another field"); map.set("story_id", ""); });

    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId("at").textContent).toBe("/stories/blank_template?step=2&layer=1");
    expect(flushed).toEqual([]);
  });

  it("reads the old address nothing again after the flush, so a loader that no longer finds it does not end the editor", async () => {
    const map = storyMap("process");
    let loads = 0;
    function Editor() {
      useFollowStoryId(map, "fluidity");
      const { pathname, search } = useLocation();
      return <p data-testid="at">{pathname + search}</p>;
    }
    const Stub = createRoutesStub([
      {
        path: "/stories/:storyId",
        Component: Editor,
        ErrorBoundary: () => <p data-testid="at">not found</p>,
        shouldRevalidate,
        loader: ({ params }) => {
          loads += 1;
          if (loads > 1 && params.storyId === "fluidity") throw new Response("Not Found", { status: 404 });
          return null;
        },
      },
      { path: "/stories", action: async () => ({ ok: true, intent: "flush-yjs-snapshot" }) },
    ]);
    render(<Stub initialEntries={["/stories/fluidity?step=2&layer=1"]} />);

    await waitFor(() => expect(screen.getByTestId("at").textContent).toBe("/stories/process?step=2&layer=1"));
  });

  it("still reads another address that a navigation reached while the flush was out", () => {
    const formData = new FormData();
    formData.set("intent", "flush-yjs-snapshot");
    const args = {
      currentUrl: new URL("https://compositor.telar.org/stories/fluidity"),
      nextUrl: new URL("https://compositor.telar.org/stories/river"),
      currentParams: { storyId: "fluidity" },
      nextParams: { storyId: "river" },
      formMethod: "POST",
      formAction: "/stories",
      formData,
      defaultShouldRevalidate: true,
    } as unknown as Parameters<typeof shouldRevalidate>[0];
    expect(shouldRevalidate(args)).toBe(true);
    expect(shouldRevalidate({ ...args, nextUrl: args.currentUrl, nextParams: args.currentParams })).toBe(false);
    const sameStory = { ...args, nextUrl: new URL("https://compositor.telar.org/stories/fluidity/"), nextParams: args.currentParams };
    expect(shouldRevalidate(sameStory)).toBe(false);
  });
});
