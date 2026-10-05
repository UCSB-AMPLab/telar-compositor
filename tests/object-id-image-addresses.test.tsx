// @vitest-environment jsdom
/**
 * Every image address the Compositor builds for a self-hosted object uses the
 * id the site gives it, and an external object keeps its own manifest.
 *
 * A row written `map.jpg` is tiled by the site under `map` (the framework
 * strips the extension from the id before it tiles), so a thumbnail or viewer
 * reading `iiif/objects/map.jpg/…` finds nothing. The id shown and stored
 * stays `map.jpg`.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import React from "react";
import * as Y from "yjs";

const BASE = "https://example.org/site";
const EXTERNAL = "https://iiif.example.org/iiif/map.jpg/manifest.json";

/** Every info.json address a thumbnail asked for, in order. */
const thumbnailRequests: Array<string | null> = [];
vi.mock("~/lib/use-iiif-thumbnail", () => ({
  useIiifThumbnail: (url: string | null) => {
    thumbnailRequests.push(url);
    return null;
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key),
  }),
  Trans: ({ i18nKey }: { i18nKey: string }) => <>{i18nKey}</>,
}));

vi.mock("react-router", () => ({
  useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn(), Form: (p: object) => <form {...p} /> }),
  useNavigate: () => vi.fn(),
  Link: ({ children, to: _to, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string }) => (
    <a {...rest}>{children}</a>
  ),
}));

const ydoc = new Y.Doc();
const configMap = ydoc.getMap<unknown>("config");
const landingMap = new Y.Map<unknown>();
for (const key of ["welcome_body", "stories_heading", "stories_intro", "objects_heading", "objects_intro"]) {
  landingMap.set(key, new Y.Text(""));
}
configMap.set("landing", landingMap);
configMap.set("title", new Y.Text(""));
configMap.set("description", new Y.Text(""));

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
vi.mock("~/components/ui/InlineTextField", () => ({ InlineTextField: () => null }));
vi.mock("~/components/ui/InlineTextArea", () => ({ InlineTextArea: () => null }));
vi.mock("~/components/ui/InlineHtmlEditor", () => ({ InlineHtmlEditor: () => null }));

/** The objects and version the homepage editor hands its markdown editor's image dialog. */
let markdownEditorObjects: unknown[] = [];
let markdownEditorVersion: unknown = undefined;
vi.mock("~/components/ui/MarkdownEditor", () => ({
  MarkdownEditor: (props: { objects?: unknown[]; frameworkVersion?: unknown }) => {
    markdownEditorObjects = props.objects ?? [];
    markdownEditorVersion = props.frameworkVersion;
    return null;
  },
}));

import { ObjectRow, type ObjectRowObject } from "~/components/features/objects/ObjectRow";
import { ObjectPickerDialog } from "~/components/features/editor/ObjectPickerDialog";
import { StoryCard } from "~/components/features/dashboard/StoryCard";
import { HomepageEditor } from "~/components/features/pages/HomepageEditor";
import { ImageInsertDialog } from "~/components/ui/markdown-editor/ImageInsertDialog";

beforeEach(() => {
  thumbnailRequests.length = 0;
  markdownEditorObjects = [];
  markdownEditorVersion = undefined;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function objectRow(overrides: Partial<ObjectRowObject> = {}): ObjectRowObject {
  return {
    id: 1,
    object_id: "map.jpg",
    title: "Map",
    featured: false,
    source_url: null,
    thumbnail: null,
    image_available: true,
    missing_from_repo: false,
    ...overrides,
  };
}

describe("the objects list thumbnail", () => {
  it("reads a self-hosted map.jpg's info.json under map", () => {
    render(<ObjectRow object={objectRow()} onToggleFeatured={vi.fn()} siteBaseUrl={BASE} frameworkVersion="1.7.0" />);
    expect(thumbnailRequests).toContain(`${BASE}/iiif/objects/map/info.json`);
  });

  it("builds no local address for an external map.jpg", () => {
    render(
      <ObjectRow
        object={objectRow({ source_url: EXTERNAL })}
        onToggleFeatured={vi.fn()}
        siteBaseUrl={BASE}
        frameworkVersion="1.7.0"
      />,
    );
    expect(thumbnailRequests.every((url) => url === null)).toBe(true);
  });

  it("names, on a row the site reads as one with another, the other row and the one shown", () => {
    render(
      <ObjectRow
        object={objectRow({ object_id: "map" })}
        onToggleFeatured={vi.fn()}
        siteBaseUrl={BASE}
        frameworkVersion="1.7.0"
        sharedSiteId={{ others: ["map.jpg"], shown: "map.jpg" }}
      />,
    );
    expect(screen.getByText(/site_id_shared/).textContent).toBe(
      `site_id_shared ${JSON.stringify({ others: "map.jpg", shown: "map.jpg" })}`,
    );
  });
});

describe("the object picker thumbnail", () => {
  it("reads a self-hosted map.jpg's info.json under map", () => {
    render(
      <ObjectPickerDialog
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        objects={[{ object_id: "map.jpg", title: "Map", thumbnail: null, image_available: true, source_url: null }]}
        currentObjectId={null}
        siteBaseUrl={BASE}
        frameworkVersion="1.7.0"
      />,
    );
    expect(thumbnailRequests).toContain(`${BASE}/iiif/objects/map/info.json`);
  });

  it("builds no local address for an external map.jpg", () => {
    render(
      <ObjectPickerDialog
        open
        onClose={vi.fn()}
        onSelect={vi.fn()}
        objects={[{ object_id: "map.jpg", title: "Map", thumbnail: null, image_available: true, source_url: EXTERNAL }]}
        currentObjectId={null}
        siteBaseUrl={BASE}
        frameworkVersion="1.7.0"
      />,
    );
    expect(thumbnailRequests.every((url) => url === null)).toBe(true);
  });
});

describe("the story card cover", () => {
  it("reads a self-hosted map.jpg's info.json under map", () => {
    render(
      <StoryCard
        story={{
          id: 1,
          story_id: "s",
          title: "S",
          subtitle: null,
          byline: null,
          private: false,
          draft: false,
          updated_at: null,
        }}
        stepCount={1}
        lastSynced={null}
        coverInfo={{ thumbnail: null, objectId: "map.jpg", imageAvailable: true, sourceUrl: null }}
        siteBaseUrl={BASE}
        frameworkVersion="1.7.0"
      />,
    );
    expect(thumbnailRequests).toContain(`${BASE}/iiif/objects/map/info.json`);
  });

  it("builds no local address for an external cover object", () => {
    render(
      <StoryCard
        story={{
          id: 1,
          story_id: "s",
          title: "S",
          subtitle: null,
          byline: null,
          private: false,
          draft: false,
          updated_at: null,
        }}
        stepCount={1}
        lastSynced={null}
        coverInfo={{ thumbnail: null, objectId: "map.jpg", imageAvailable: true, sourceUrl: EXTERNAL }}
        siteBaseUrl={BASE}
        frameworkVersion="1.7.0"
      />,
    );
    expect(thumbnailRequests.every((url) => url === null)).toBe(true);
  });
});

describe("the homepage editor", () => {
  function homepageData(objects: Array<Record<string, unknown>>, version = "1.7.0") {
    return {
      project: { id: 42, github_pages_url: null, last_synced_at: null },
      config: { lang: "en", title: "T", description: "D", featured_count: 4, telar_version: version },
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
      objects,
      siteBaseUrl: BASE,
    };
  }
  const object = (overrides: Record<string, unknown>) => ({
    id: 1,
    object_id: "map.jpg",
    title: "Map",
    creator: null,
    description: null,
    source: null,
    thumbnail: null,
    image_available: true,
    featured: true,
    source_url: null,
    ...overrides,
  });

  it("reads a self-hosted map.jpg's card thumbnail under map", () => {
    render(<HomepageEditor data={homepageData([object({})]) as never} />);
    expect(thumbnailRequests).toContain(`${BASE}/iiif/objects/map/info.json`);
  });

  it("builds no local card address for an external map.jpg", () => {
    render(<HomepageEditor data={homepageData([object({ source_url: EXTERNAL })]) as never} />);
    expect(thumbnailRequests.every((url) => url === null)).toBe(true);
  });

  it("gives its image dialog each object's source and the site's framework version", () => {
    render(<HomepageEditor data={homepageData([object({ source_url: EXTERNAL })], "1.8.0") as never} />);
    expect(markdownEditorObjects).toEqual([expect.objectContaining({ object_id: "map.jpg", source_url: EXTERNAL })]);
    expect(markdownEditorVersion).toBe("1.8.0");
  });

  it("reads a story card's self-hosted map.heic cover under map on a 1.8.0 site", () => {
    const data = {
      ...homepageData([], "1.8.0"),
      stories: [{ id: 1, story_id: "s", title: "S", subtitle: null, byline: null, private: false, draft: false, updated_at: null }],
      storyStepCounts: { 1: 1 },
      storyCoverMap: { 1: { thumbnail: null, objectId: "map.heic", imageAvailable: true, sourceUrl: null } },
    };
    render(<HomepageEditor data={data as never} />);
    expect(thumbnailRequests).toContain(`${BASE}/iiif/objects/map/info.json`);
  });
});

describe("the image dialog", () => {
  function manifestServer(bodies: Record<string, string>) {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requested.push(url);
        const body = bodies[url];
        if (!body) return new Response("", { status: 404 });
        return new Response(
          JSON.stringify({ items: [{ items: [{ items: [{ body: { id: body, format: "image/jpeg" } }] }] }] }),
          { status: 200 },
        );
      }),
    );
    return requested;
  }

  function insertFrom(objects: React.ComponentProps<typeof ImageInsertDialog>["objects"], pick: string) {
    const onInsert = vi.fn();
    render(
      <ImageInsertDialog
        open
        onClose={vi.fn()}
        onInsert={onInsert}
        objects={objects}
        siteBaseUrl={BASE}
        frameworkVersion="1.7.0"
      />,
    );
    fireEvent.click(screen.getByText("image_dialog.tab_objects"));
    fireEvent.click(screen.getAllByText(pick)[0]);
    return onInsert;
  }

  it("reads a self-hosted map.jpg's manifest under map", async () => {
    const requested = manifestServer({ [`${BASE}/iiif/objects/map/manifest.json`]: `${BASE}/iiif/objects/map/full.jpg` });
    const onInsert = insertFrom(
      [{ object_id: "map.jpg", title: "Map", thumbnail: null, image_available: true, source_url: null }],
      "Map",
    );
    await waitFor(() => expect(onInsert).toHaveBeenCalled());
    expect(requested).toEqual([`${BASE}/iiif/objects/map/manifest.json`]);
    expect(onInsert).toHaveBeenCalledWith(`${BASE}/iiif/objects/map/full.jpg`, "Map");
  });

  it("falls back to the page-1 image under map", async () => {
    manifestServer({});
    const onInsert = insertFrom(
      [{ object_id: "map.jpg", title: "Map", thumbnail: null, image_available: true, source_url: null }],
      "Map",
    );
    await waitFor(() => expect(onInsert).toHaveBeenCalled());
    expect(onInsert).toHaveBeenCalledWith(`${BASE}/iiif/objects/map/page-1/full/max/0/default.jpg`, "Map");
  });

  it("falls back to the page-1 image when it is not known whether the object has one", async () => {
    manifestServer({});
    const onInsert = insertFrom(
      [{ object_id: "map.jpg", title: "Map", thumbnail: null, image_available: null, source_url: null }],
      "Map",
    );
    await waitFor(() => expect(onInsert).toHaveBeenCalled());
    expect(onInsert).toHaveBeenCalledWith(`${BASE}/iiif/objects/map/page-1/full/max/0/default.jpg`, "Map");
  });

  it("shows the image-not-found error for a self-hosted object with no image whose manifest is absent", async () => {
    const requested = manifestServer({});
    const onInsert = insertFrom(
      [{ object_id: "map.jpg", title: "Map", thumbnail: null, image_available: false, source_url: null }],
      "Map",
    );
    await screen.findByText("image_dialog.image_not_found");
    expect(requested).toEqual([`${BASE}/iiif/objects/map/manifest.json`]);
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("still inserts the manifest's image for a self-hosted object flagged as having none", async () => {
    manifestServer({ [`${BASE}/iiif/objects/map/manifest.json`]: `${BASE}/iiif/objects/map/full.jpg` });
    const onInsert = insertFrom(
      [{ object_id: "map.jpg", title: "Map", thumbnail: null, image_available: false, source_url: null }],
      "Map",
    );
    await waitFor(() => expect(onInsert).toHaveBeenCalled());
    expect(onInsert).toHaveBeenCalledWith(`${BASE}/iiif/objects/map/full.jpg`, "Map");
  });

  it.each([
    ["v3 Video", { items: [{ items: [{ items: [{ body: { type: "Video", format: "video/mp4", id: "https://media.test/clip.mp4" } }] }] }] }],
    [
      "v3 Video carrying an image service",
      { items: [{ items: [{ items: [{ body: { type: "Video", format: "video/mp4", id: "https://media.test/clip.mp4", service: [{ id: "https://media.test/iiif/clip", type: "ImageService3" }] } }] }] }] },
    ],
    ["v3 with no type or format", { items: [{ items: [{ items: [{ body: { id: "https://media.test/clip.mp4" } }] }] }] }],
    [
      "v2 audio",
      { sequences: [{ canvases: [{ images: [{ resource: { "@id": "https://media.test/a.mp3", format: "audio/mpeg" } }] }] }] },
    ],
  ])("shows the image-not-found error for an external single-canvas manifest whose body is %s", async (_, manifest) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === EXTERNAL ? new Response(JSON.stringify(manifest), { status: 200 }) : new Response("", { status: 404 }),
      ),
    );
    const onInsert = insertFrom(
      [{ object_id: "map.jpg", title: "External map", thumbnail: null, image_available: true, source_url: EXTERNAL }],
      "External map",
    );
    await screen.findByText("image_dialog.image_not_found");
    expect(onInsert).not.toHaveBeenCalled();
  });

  it.each([
    ["type Image", { type: "Image", id: "https://media.test/a" }],
    ["an image format", { format: "image/png", id: "https://media.test/a" }],
    ["an image service", { id: "https://media.test/a", service: [{ id: "https://media.test/svc", type: "ImageService3" }] }],
  ])("inserts an external manifest's body with %s", async (_, body) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === EXTERNAL
          ? new Response(JSON.stringify({ items: [{ items: [{ items: [{ body }] }] }] }), { status: 200 })
          : new Response("", { status: 404 }),
      ),
    );
    const onInsert = insertFrom(
      [{ object_id: "map.jpg", title: "External map", thumbnail: null, image_available: true, source_url: EXTERNAL }],
      "External map",
    );
    await waitFor(() => expect(onInsert).toHaveBeenCalledWith("https://media.test/a", "External map"));
  });

  it("inserts an external map.jpg's own image, not the self-hosted map's beside it", async () => {
    const requested = manifestServer({ [`${BASE}/iiif/objects/map/manifest.json`]: `${BASE}/iiif/objects/map/full.jpg` });
    const onInsert = insertFrom(
      [
        { object_id: "map", title: "Local map", thumbnail: null, image_available: true, source_url: null },
        {
          object_id: "map.jpg",
          title: "External map",
          thumbnail: "https://iiif.example.org/iiif/map.jpg/full/200,/0/default.jpg",
          image_available: true,
          source_url: EXTERNAL,
        },
      ],
      "External map",
    );
    await waitFor(() => expect(onInsert).toHaveBeenCalled());
    expect(requested).toEqual([]);
    expect(onInsert).toHaveBeenCalledWith("https://iiif.example.org/iiif/map.jpg/full/200,/0/default.jpg", "External map");
  });

  it("inserts an external object with no thumbnail by the image its manifest names", async () => {
    const requested = manifestServer({ [EXTERNAL]: "https://iiif.example.org/iiif/map.jpg/full/max/0/default.jpg" });
    const onInsert = insertFrom(
      [{ object_id: "map.jpg", title: "External map", thumbnail: null, image_available: true, source_url: EXTERNAL }],
      "External map",
    );
    await waitFor(() => expect(onInsert).toHaveBeenCalled());
    expect(requested).toEqual([EXTERNAL]);
    expect(onInsert).toHaveBeenCalledWith("https://iiif.example.org/iiif/map.jpg/full/max/0/default.jpg", "External map");
  });

  it.each([
    ["v3", { id: "https://iiif.example.org/iiif/3/abc", type: "ImageService3", protocol: "http://iiif.io/api/image" }, "max"],
    [
      "v3 by its context",
      { "@context": "http://iiif.io/api/image/3/context.json", id: "https://iiif.example.org/iiif/3/abc", protocol: "http://iiif.io/api/image" },
      "max",
    ],
    ["v2", { "@id": "https://iiif.example.org/iiif/3/abc", protocol: "http://iiif.io/api/image" }, "full"],
    [
      "v2 level 0",
      {
        "@context": "http://iiif.io/api/image/2/context.json",
        "@id": "https://iiif.example.org/iiif/3/abc",
        protocol: "http://iiif.io/api/image",
        profile: ["http://iiif.io/api/image/2/level0.json"],
      },
      "full",
    ],
  ])("inserts an external %s info.json's full image by its service id", async (_, info, size) => {
    const source = "https://iiif.example.org/iiif/3/abc/info.json";
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requested.push(url);
        return url === source ? new Response(JSON.stringify(info), { status: 200 }) : new Response("", { status: 404 });
      }),
    );
    const onInsert = insertFrom(
      [{ object_id: "abc", title: "External image", thumbnail: null, image_available: true, source_url: source }],
      "External image",
    );
    await waitFor(() => expect(onInsert).toHaveBeenCalled());
    expect(requested).toEqual([source]);
    expect(onInsert).toHaveBeenCalledWith(`https://iiif.example.org/iiif/3/abc/full/${size}/0/default.jpg`, "External image");
  });

  it.each([
    [
      "v3",
      {
        items: ["p1", "p2"].map((p) => ({ items: [{ items: [{ body: { id: `https://example.org/${p}.jpg` } }] }] })),
      },
    ],
    [
      "v2",
      {
        sequences: [
          { canvases: ["p1", "p2"].map((p) => ({ images: [{ resource: { "@id": `https://example.org/${p}.jpg` } }] })) },
        ],
      },
    ],
  ])("refuses an external %s manifest with two canvases, as it refuses a self-hosted one", async (_, manifest) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === EXTERNAL ? new Response(JSON.stringify(manifest), { status: 200 }) : new Response("", { status: 404 }),
      ),
    );
    const onInsert = insertFrom(
      [{ object_id: "map.jpg", title: "External map", thumbnail: null, image_available: true, source_url: EXTERNAL }],
      "External map",
    );
    await screen.findByText("image_dialog.pdf_not_supported");
    expect(onInsert).not.toHaveBeenCalled();
  });

  it("refuses an external single-canvas manifest whose image is a PDF, as it refuses a self-hosted one", async () => {
    const manifest = {
      items: [{ items: [{ items: [{ body: { id: "https://example.org/document.pdf", format: "application/pdf" } }] }] }],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === EXTERNAL ? new Response(JSON.stringify(manifest), { status: 200 }) : new Response("", { status: 404 }),
      ),
    );
    const onInsert = insertFrom(
      [{ object_id: "map.jpg", title: "External map", thumbnail: null, image_available: true, source_url: EXTERNAL }],
      "External map",
    );
    await screen.findByText("image_dialog.pdf_not_supported");
    expect(onInsert).not.toHaveBeenCalled();
  });

  describe("a lookup still pending", () => {
    const A = "https://iiif.example.org/a/manifest.json";
    const B = "https://iiif.example.org/b/manifest.json";
    const external = (id: string, source: string) => ({
      object_id: id, title: `Object ${id}`, thumbnail: null, image_available: true, source_url: source,
    });

    /** A fetch whose answer for each address waits until the test releases it. */
    function heldFetch() {
      const release: Record<string, (status: number) => void> = {};
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (url: string) =>
            new Promise<Response>((resolve) => {
              release[url] = (status) =>
                resolve(
                  status === 200
                    ? new Response(
                      JSON.stringify({ items: [{ items: [{ items: [{ body: { id: url.replace("manifest.json", "full.jpg"), type: "Image" } }] }] }] }),
                      { status },
                    )
                    : new Response("", { status }),
                );
            }),
        ),
      );
      return async (url: string, status = 200) => {
        await act(async () => {
          release[url](status);
        });
      };
    }

    function pendingDialog(onInsert: (url: string, alt: string) => void, open = true) {
      return (
        <ImageInsertDialog
          open={open}
          onClose={vi.fn()}
          onInsert={onInsert}
          objects={[external("a", A), external("b", B)]}
          siteBaseUrl={BASE}
          frameworkVersion="1.7.0"
        />
      );
    }

    it("inserts nothing once the dialog is cancelled", async () => {
      const resolve = heldFetch();
      const onInsert = vi.fn();
      render(pendingDialog(onInsert));
      fireEvent.click(screen.getByText("image_dialog.tab_objects"));
      fireEvent.click(screen.getAllByText("Object a")[0]);
      fireEvent.keyDown(document, { key: "Escape" });
      await resolve(A);
      expect(onInsert).not.toHaveBeenCalled();
    });

    it("inserts nothing once the editor has closed the dialog", async () => {
      const resolve = heldFetch();
      const onInsert = vi.fn();
      const { rerender } = render(pendingDialog(onInsert));
      fireEvent.click(screen.getByText("image_dialog.tab_objects"));
      fireEvent.click(screen.getAllByText("Object a")[0]);
      rerender(pendingDialog(onInsert, false));
      await resolve(A);
      expect(onInsert).not.toHaveBeenCalled();
    });

    it.each([200, 404])("inserts nothing for a self-hosted object once the dialog is cancelled (manifest %i)", async (status) => {
      const resolve = heldFetch();
      const onInsert = vi.fn();
      render(
        <ImageInsertDialog
          open
          onClose={vi.fn()}
          onInsert={onInsert}
          objects={[{ object_id: "map", title: "Map", thumbnail: null, image_available: true, source_url: null }]}
          siteBaseUrl={BASE}
          frameworkVersion="1.7.0"
        />,
      );
      fireEvent.click(screen.getByText("image_dialog.tab_objects"));
      fireEvent.click(screen.getAllByText("Map")[0]);
      fireEvent.keyDown(document, { key: "Escape" });
      await resolve(`${BASE}/iiif/objects/map/manifest.json`, status);
      expect(onInsert).not.toHaveBeenCalled();
    });

    it("inserts nothing once the author has switched to the URL tab", async () => {
      const resolve = heldFetch();
      const onInsert = vi.fn();
      render(pendingDialog(onInsert));
      fireEvent.click(screen.getByText("image_dialog.tab_objects"));
      fireEvent.click(screen.getAllByText("Object a")[0]);
      fireEvent.click(screen.getByText("image_dialog.tab_url"));
      await resolve(A);
      expect(onInsert).not.toHaveBeenCalled();
    });

    it("inserts only the object chosen last when it answers first", async () => {
      const resolve = heldFetch();
      const onInsert = vi.fn();
      render(pendingDialog(onInsert));
      fireEvent.click(screen.getByText("image_dialog.tab_objects"));
      fireEvent.click(screen.getAllByText("Object a")[0]);
      fireEvent.click(screen.getAllByText("Object b")[0]);
      await resolve(B);
      await resolve(A);
      expect(onInsert.mock.calls).toEqual([["https://iiif.example.org/b/full.jpg", "Object b"]]);
    });
  });

  it("inserts nothing for an external object with no thumbnail whose manifest cannot be read", async () => {
    const requested = manifestServer({});
    const onInsert = insertFrom(
      [{ object_id: "map.jpg", title: "External map", thumbnail: null, image_available: true, source_url: EXTERNAL }],
      "External map",
    );
    await screen.findByText("image_dialog.image_not_found");
    expect(requested).toEqual([EXTERNAL]);
    expect(onInsert).not.toHaveBeenCalled();
  });
});
