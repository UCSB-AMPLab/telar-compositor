// @vitest-environment jsdom
/**
 * Content the editor draws but does not own comes back byte for byte: a
 * carousel with fields the editor does not know, a malformed or unclosed
 * one, and formulas, while an author edits the prose around them or one
 * field of the carousel. Carousel images resolve as framework 1.8.0
 * publishes them.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { history } from "@codemirror/commands";
import { act } from "@testing-library/react";
import { panelAuthoring, editPanelBlock } from "../app/components/ui/markdown-editor/panelAuthoring";
import { parsePanel, replacePanelField } from "../app/components/ui/markdown-editor/panelSource";
import { carouselImageSources, carouselSizeClass } from "../app/components/ui/markdown-editor/WidgetPreview";
import { parsePanelPreviewConfig } from "../app/lib/panel-preview-config";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// jsdom has no layout; CodeMirror measures a Range when a view is in the
// document, and an unanswered measure fails after the test has passed.
const emptyRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getClientRects ??= emptyRects;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

const CAROUSEL = [
  ":::carousel",
  "image: first.jpg",
  "# a comment line",
  "alt: First",
  "caption: A *caption* with \\(x^2\\)",
  "focal-point: 40% 60%",
  "credit: Archive",
  "---",
  "caption: an item with no image",
  "---",
  "image: https://example.org/b.jpg",
  "width: 1200",
  "height: 800",
  "unknown: kept",
  ":::",
].join("\n");
const MALFORMED = ":::carousel\nimage: a.jpg\ncaption: never closed";
const MATHS = "Before \\(E=mc^2\\) and $$a \\\\ b$$ after.";

async function mount(doc: string): Promise<EditorView> {
  let view!: EditorView;
  await act(async () => {
    view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc,
        extensions: [markdown(), history(), panelAuthoring({ preview: parsePanelPreviewConfig(null, null) })],
      }),
    });
  });
  return view;
}

async function type(view: EditorView, at: number, text: string): Promise<void> {
  await act(async () => {
    view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type" });
  });
}

describe("preservation", () => {
  it.each([
    ["a carousel with unknown fields and an item with no image", CAROUSEL],
    ["an unclosed carousel", MALFORMED],
    ["formulas", MATHS],
  ])("keeps %s byte for byte while the prose around it is edited", async (_what, block) => {
    const doc = `Opening prose.\n\n${block}\n\nClosing prose.`;
    const view = await mount(doc);
    await type(view, "Opening".length, " edited");
    await type(view, view.state.doc.length, " More.");
    const text = view.state.doc.toString();
    expect(text).toBe(`Opening edited prose.\n\n${block}\n\nClosing prose. More.`);
    await act(async () => view.destroy());
  });

  it("changes only the edited field of a carousel it draws", async () => {
    const view = await mount(CAROUSEL);
    await act(async () => {
      view.dispatch({ effects: editPanelBlock.of({ from: 0, mode: "edit" }) });
    });
    const credit = parsePanel(view.state).widgets[0].sections[0].fields!.credit;
    await act(async () => {
      replacePanelField(view, credit, credit.value, "Archive, 1890");
    });
    expect(view.state.doc.toString()).toBe(CAROUSEL.replace("credit: Archive", "credit: Archive, 1890"));
    await act(async () => view.destroy());
  });

  it("draws an unclosed carousel as its source", async () => {
    const view = await mount(MALFORMED);
    expect(view.dom.querySelector(".cm-panel-box")).toBeNull();
    expect(view.dom.textContent).toContain("caption: never closed");
    await act(async () => view.destroy());
  });
});

describe("carousel images as framework 1.8.0 publishes them", () => {
  const site = "https://owner.github.io/site";
  const at = (...paths: string[]) => paths.map((p) => `${site}/${p}`);
  it.each([
    ["an absolute https URL", "https://example.org/a.jpg", ["https://example.org/a.jpg"]],
    ["an absolute http URL", "http://example.org/a.jpg", ["http://example.org/a.jpg"]],
    [
      "a bare file name, in assets/images/ then telar-content/objects/",
      "Photo.JPG",
      at(
        "assets/images/Photo.JPG", "assets/images/photo.jpg", "assets/images/Photo.jpg",
        "telar-content/objects/Photo.JPG", "telar-content/objects/photo.jpg", "telar-content/objects/Photo.jpg",
      ),
    ],
    [
      "a path with a folder, from the site root then under each folder",
      "telar-content/objects/a.jpg",
      at(
        "telar-content/objects/a.jpg", "telar-content/objects/a.JPG",
        "assets/images/telar-content/objects/a.jpg", "assets/images/telar-content/objects/a.JPG",
        "telar-content/objects/telar-content/objects/a.jpg", "telar-content/objects/telar-content/objects/a.JPG",
      ),
    ],
    [
      "a leading slash, read from the site root",
      "/photo.jpg",
      at("photo.jpg", "photo.JPG", "assets/images/photo.jpg", "assets/images/photo.JPG", "telar-content/objects/photo.jpg", "telar-content/objects/photo.JPG"),
    ],
    [
      "a leading slash that already carries the baseurl, tried without it second",
      "/site/assets/images/a.png",
      at(
        "site/assets/images/a.png", "site/assets/images/a.PNG",
        "assets/images/a.png", "assets/images/a.PNG",
        "assets/images/site/assets/images/a.png", "assets/images/site/assets/images/a.PNG",
        "telar-content/objects/site/assets/images/a.png", "telar-content/objects/site/assets/images/a.PNG",
      ),
    ],
    [
      "an upper-case scheme, which the framework reads as a path",
      "HTTPS://example.org/a.jpg",
      at(
        "HTTPS:/example.org/a.jpg", "https:/example.org/a.jpg", "HTTPS:/example.org/a.JPG",
        "assets/images/HTTPS:/example.org/a.jpg", "assets/images/https:/example.org/a.jpg", "assets/images/HTTPS:/example.org/a.JPG",
        "telar-content/objects/HTTPS:/example.org/a.jpg", "telar-content/objects/https:/example.org/a.jpg", "telar-content/objects/HTTPS:/example.org/a.JPG",
      ),
    ],
  ])("resolves %s", (_what, image, candidates) => {
    expect(carouselImageSources(image, site)?.candidates).toEqual(candidates);
    expect(carouselImageSources(image, `${site}/`)?.candidates).toEqual(candidates);
  });

  it("falls back to the address the site points at when no file is found", () => {
    expect(carouselImageSources("x.jpg", site)?.fallback).toBe(`${site}/assets/images/x.jpg`);
    expect(carouselImageSources("maps/x.jpg", site)?.fallback).toBe(`${site}/maps/x.jpg`);
    expect(carouselImageSources("maps//x.jpg/", site)?.fallback).toBe(`${site}/maps//x.jpg/`);
    expect(carouselImageSources("maps//x.jpg/", site)?.candidates[0]).toBe(`${site}/maps/x.jpg`);
  });

  it("shows no local image when the site's address is unknown", () => {
    expect(carouselImageSources("photo.jpg", null)).toBeNull();
    expect(carouselImageSources("https://example.org/a.jpg", null)?.candidates).toEqual(["https://example.org/a.jpg"]);
  });

  it("sizes by the tallest known image, and as default when none is known", () => {
    expect(carouselSizeClass([])).toBe("default");
    expect(carouselSizeClass([null, null])).toBe("default");
    expect(carouselSizeClass([0.5, null])).toBe("compact");
    expect(carouselSizeClass([0.5, 0.8])).toBe("default");
    expect(carouselSizeClass([1.2])).toBe("tall");
    expect(carouselSizeClass([1.5])).toBe("portrait");
  });
});
