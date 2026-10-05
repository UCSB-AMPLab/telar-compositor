// @vitest-environment jsdom
/**
 * A layer panel's content drawn on the stage (PanelContent, PanelRendering):
 * the rendered HTML against `renderPanel` for the oracle corpus, widgets
 * filled through portals as the text changes, KaTeX kept to the panel's own
 * HTML and dropped when its generation is replaced, footnote anchors apart
 * across both layers, image addresses read from the site's origin, and the
 * empty panel's placeholder.
 *
 * KaTeX is replaced by a stand-in that typesets `$…$` into a span naming the
 * run that typeset it, honouring the run's ignored classes and its
 * `current` check as KaTeX's auto-render and `renderPanelMath` do, and that
 * waits for the test to let each run finish loading.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { StrictMode } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MathDelimiter, PanelMathRun } from "~/components/ui/markdown-editor/panelMath";
import panelFixture from "./fixtures/panel-rendering.json";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("react-router", () => ({
  useFetcher: () => ({ state: "idle", data: undefined, submit: vi.fn(() => Promise.resolve()) }),
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
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
}));

const runs: Array<{ element: HTMLElement; finish: () => void }> = [];

/** KaTeX's auto-render as far as the tests need it: `$…$` typeset, ignored classes left alone. */
function typeset(element: HTMLElement, ignored: string[], by: string) {
  for (const node of [...element.childNodes]) {
    if (node instanceof HTMLElement) {
      if (ignored.some((c) => node.classList.contains(c))) continue;
      typeset(node, ignored, by);
    } else if (node.nodeType === Node.TEXT_NODE && /\$[^$]+\$/.test(node.textContent ?? "")) {
      const holder = document.createElement("span");
      holder.innerHTML = (node.textContent ?? "").replace(/\$([^$]+)\$/g, `<span class="katex" data-by="${by}">$1</span>`);
      node.replaceWith(...holder.childNodes);
    }
  }
}

vi.mock("~/components/ui/markdown-editor/panelMath", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/components/ui/markdown-editor/panelMath")>();
  return {
    ...actual,
    renderPanelMath: (element: HTMLElement, _delimiters: MathDelimiter[], run: PanelMathRun = {}) =>
      new Promise<void>((resolve) => {
        runs.push({
          element,
          finish: () => {
            if (element.isConnected && run.current?.() !== false) {
              typeset(element, ["katex", ...(run.ignoredClasses ?? [])], element.hasAttribute("data-panel-prose") ? "panel" : "widget");
            }
            resolve();
          },
        });
      }),
  };
});

import { PanelContent } from "~/components/features/editor/PanelContent";
import type { StagePanelLayer } from "~/components/features/editor/StagePanels";
import { LayerContentDrafts } from "~/hooks/use-layer-content-drafts";
import { renderPanel } from "~/lib/card-markdown";
import { parsePanelPreviewConfig, type PanelPreviewConfig } from "~/lib/panel-preview-config";

const glossary = { terms: new Map<string, string>(), baseUrl: "" };
const drafts = new LayerContentDrafts({ projectId: 1, storyKey: "s" }, () => Promise.resolve(undefined), {
  debounceMs: 1500,
  errorMessage: () => "stage.save_failed",
});
const available: PanelPreviewConfig = { ...parsePanelPreviewConfig(null, null), available: true };

function layer(content: string, over: Partial<StagePanelLayer> = {}): StagePanelLayer {
  return {
    key: "L1",
    id: 51,
    layer_number: 1,
    title: null,
    button_label: null,
    content,
    titleYText: null,
    contentYText: null,
    buttonLabelYText: null,
    canDelete: true,
    ...over,
  };
}

function content(value: string, props: { config?: PanelPreviewConfig; siteBaseUrl?: string | null; over?: Partial<StagePanelLayer> } = {}) {
  return (
    <PanelContent
      layer={layer(value, props.over)}
      drafts={drafts}
      glossary={glossary}
      previewConfig={props.config}
      siteBaseUrl={props.siteBaseUrl}
      objects={[]}
      actionUrl="/"
    />
  );
}

const prose = (root: Document | Element = document) => root.querySelector("[data-panel-prose]") as HTMLElement;

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

beforeEach(() => {
  runs.length = 0;
});
afterEach(() => cleanup());

describe("the rendered HTML", () => {
  /** The generation's HTML as renderPanel wrote it: the marks the stage adds, and the widgets drawn into it, taken out. */
  function skeleton(element: HTMLElement): string {
    const copy = element.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("[data-prose-link]").forEach((a) => a.removeAttribute("data-prose-link"));
    copy.querySelectorAll("[data-panel-widget]").forEach((slot) => {
      slot.classList.remove("panel-widget-slot");
      if (!slot.getAttribute("class")) slot.removeAttribute("class");
      slot.replaceChildren();
    });
    return copy.innerHTML;
  }

  it.each(panelFixture.panels.map((c) => [c.name, c.source] as const))("is renderPanel's, before formulas are typeset: %s", (_name, source) => {
    render(content(source));
    const expected = renderPanel(source, {
      glossary,
      baseUrl: "",
      anchor: "panel-1-L1",
      unavailable: "panel.shownAsWritten",
    });
    if (!expected.html.trim() && expected.widgets.length === 0) {
      expect(prose()).toBeNull();
      return;
    }
    expect(skeleton(prose())).toBe(expected.html);
  });

  it("shows the placeholder, muted, for an empty panel", () => {
    render(content("   \n"));
    expect(prose()).toBeNull();
    const placeholder = document.querySelector("[data-panel-content] .text-gray-400");
    expect(placeholder?.textContent).toBe("stage.panel_text_placeholder");
  });
});

describe("widgets through portals", () => {
  const ACCORDION = (a: string, b: string) => `:::accordion\n## ${a}\nText ${a}.\n\n## ${b}\nText ${b}.\n:::`;
  const TABS = ":::tabs\n## First tab\nOne.\n:::";
  const titles = () =>
    [...document.querySelectorAll("[data-panel-widget]")].map((slot) =>
      [...slot.querySelectorAll(".accordion-button, .nav-link")].map((b) => b.textContent).join("|"),
    );

  it.each([
    ["insertion", `Before.\n\n${ACCORDION("A", "B")}`, `Before.\n\n${TABS}\n\n${ACCORDION("A", "B")}`, ["First tab", "A|B"]],
    ["deletion", `${TABS}\n\n${ACCORDION("A", "B")}`, `${ACCORDION("A", "B")}`, ["A|B"]],
    ["reorder", `${TABS}\n\n${ACCORDION("A", "B")}`, `${ACCORDION("A", "B")}\n\n${TABS}`, ["A|B", "First tab"]],
    ["an edit inside a widget only", `Same.\n\n${ACCORDION("A", "B")}`, `Same.\n\n${ACCORDION("A", "C")}`, ["A|C"]],
  ])("follow the text across %s", async (_what, before, after, expected) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(<StrictMode>{content(before)}</StrictMode>);
    rerender(<StrictMode>{content(after)}</StrictMode>);
    await settle();
    expect(titles()).toEqual(expected);
    // Each slot holds one widget, drawn once.
    for (const slot of document.querySelectorAll("[data-panel-widget]")) expect(slot.children).toHaveLength(1);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("draws a widget the framework does not know as its source, said to be shown as written", () => {
    render(content(":::timeline\n## 1900\nA year.\n:::"));
    const slot = document.querySelector("[data-panel-widget]")!;
    expect(slot.querySelector(".cm-panel-unavailable p")!.textContent).toBe("panel.shownAsWritten");
    expect(slot.querySelector("pre")!.textContent).toBe(":::timeline\n## 1900\nA year.\n:::");
  });
});

describe("formulas", () => {
  const SOURCE = "Prose $x$ here.\n\n:::accordion\n## Title\nInside $y$.\n:::";

  it("are typeset in the panel's own HTML, never in a widget's, which typesets its own", async () => {
    render(content(SOURCE, { config: available }));
    await settle();
    // The panel's run finishes first, so a run that reached into a widget
    // would typeset the widget's formula before the widget's own run.
    const panelFirst = [...runs].sort((a, b) => Number(b.element.hasAttribute("data-panel-prose")) - Number(a.element.hasAttribute("data-panel-prose")));
    await act(async () => {
      panelFirst.forEach((run) => run.finish());
    });
    expect(prose().querySelector(':scope > p .katex')!.getAttribute("data-by")).toBe("panel");
    const inWidget = document.querySelector("[data-panel-widget] .katex")!;
    expect(inWidget.getAttribute("data-by")).toBe("widget");
  });

  it("are not typeset before the site's configuration has arrived", async () => {
    render(content(SOURCE));
    await settle();
    expect(runs.filter((run) => run.element.hasAttribute("data-panel-prose"))).toHaveLength(0);
  });

  it("drops a run whose generation was replaced while KaTeX loaded: the content changed", async () => {
    const { rerender } = render(content("Old $a$.", { config: available }));
    await settle();
    const stale = runs.find((run) => run.element.hasAttribute("data-panel-prose"))!;
    rerender(content("New $b$.", { config: available }));
    await settle();
    await act(async () => stale.finish());
    expect(stale.element.querySelector(".katex")).toBeNull();
    const fresh = runs.filter((run) => run.element.hasAttribute("data-panel-prose")).at(-1)!;
    await act(async () => fresh.finish());
    expect(prose().querySelector(".katex")!.textContent).toBe("b");
  });

  it("drops a run whose generation was replaced while KaTeX loaded: the delimiters changed", async () => {
    const { rerender } = render(content("Same $a$.", { config: available }));
    await settle();
    const stale = runs.find((run) => run.element.hasAttribute("data-panel-prose"))!;
    rerender(content("Same $a$.", { config: { ...available, delimiters: available.delimiters.slice(0, 2) } }));
    await settle();
    // The HTML is set afresh for the new delimiters.
    expect(prose()).not.toBe(stale.element);
    await act(async () => stale.finish());
    expect(prose().querySelector(".katex")).toBeNull();
  });
});

describe("footnote anchors", () => {
  it("are apart across both layers' panels", () => {
    const text = "One[^a] and two.\n\n[^a]: The note.";
    render(
      <>
        {content(text)}
        <PanelContent layer={layer(text, { key: "L2", id: 52, layer_number: 2 })} drafts={drafts} glossary={glossary} objects={[]} actionUrl="/" />
      </>,
    );
    const ids = [...document.querySelectorAll("[data-panel-prose] [id]")].map((el) => el.id);
    expect(ids.length).toBeGreaterThan(2);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("image addresses", () => {
  const PROSE = "![a](/assets/a.jpg)\n\n![b](https://images.example/b.jpg)\n\n![c](c.jpg)\n\nInline ![d](/site/d.jpg) here.";
  const WIDGET = ":::accordion\n## Pictures\n![e](/assets/e.jpg) and ![f](https://images.example/f.jpg)\n:::";
  const srcs = (root: Element) => [...root.querySelectorAll("img")].map((img) => img.getAttribute("src"));

  it("are read from the site's origin in the panel's text, under its baseurl, external ones as written", () => {
    render(content(PROSE, { siteBaseUrl: "https://user.github.io/site" }));
    expect(srcs(prose())).toEqual([
      "https://user.github.io/site/assets/a.jpg",
      "https://images.example/b.jpg",
      "https://user.github.io/site/telar-content/objects/c.jpg",
      "https://user.github.io/site/d.jpg",
    ]);
  });

  it("stay the site's own without a site address", () => {
    render(content(PROSE, { siteBaseUrl: null }));
    expect(srcs(prose())).toEqual(["/assets/a.jpg", "https://images.example/b.jpg", "/telar-content/objects/c.jpg", "/site/d.jpg"]);
  });

  it("are read from the site's origin in a widget's Markdown too", async () => {
    render(content(WIDGET, { siteBaseUrl: "https://user.github.io/site" }));
    await settle();
    expect(srcs(document.querySelector("[data-panel-widget]")!)).toEqual([
      "https://user.github.io/site/assets/e.jpg",
      "https://images.example/f.jpg",
    ]);
  });

  it("are not prefixed twice for a carousel, which locates its own", async () => {
    render(content(":::carousel\nimage: https://images.example/g.jpg\n:::", { siteBaseUrl: "https://user.github.io/site" }));
    await settle();
    expect(srcs(document.querySelector("[data-panel-widget]")!)).toEqual(["https://images.example/g.jpg"]);
  });
});

describe("Bootstrap's widget primitives", () => {
  /** Every selector in a stylesheet that names `className`, pseudo-elements left out. */
  function selectorsNaming(file: string, className: string): string[] {
    const css = readFileSync(join(process.cwd(), file), "utf8");
    return css
      .split("}")
      .map((rule) => rule.slice(0, Math.max(0, rule.lastIndexOf("{"))))
      .flatMap((head) => head.slice(head.lastIndexOf("{") + 1).split(","))
      .map((selector) => selector.replace(/::?(after|before)$/, "").trim())
      .filter((selector) => selector.includes(className) && !selector.startsWith("@"));
  }
  const reaches = (el: Element, className: string) =>
    selectorsNaming("app/styles/panel-bootstrap.css", className).some((selector) => {
      try {
        return el.matches(selector);
      } catch {
        return false;
      }
    });

  it("reach the rendered panel's carousel controls and tabs, as they reach the editor's box", async () => {
    render(content(":::carousel\nimage: https://i.example/a.jpg\n---\nimage: https://i.example/b.jpg\n:::\n\n:::tabs\n## A\nx\n\n## B\ny\n:::"));
    await settle();
    expect(reaches(document.querySelector(".carousel-control-prev")!, "carousel-control-prev")).toBe(true);
    expect(reaches(document.querySelector(".carousel-control-next-icon")!, "carousel-control-next-icon")).toBe(true);
    expect(reaches(document.querySelector(".nav-tabs")!, "nav-tabs")).toBe(true);
  });
});

describe("the published panel's prose rules", () => {
  it("give the rendered text heading sizes, paragraph spacing and list markers, which the editor's reset takes away, and leave a widget's navigation list alone", async () => {
    const style = document.createElement("style");
    style.textContent = ["app/styles/panel-bootstrap.css", "app/styles/visitor-layer.css"]
      .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
      .join("\n");
    document.head.appendChild(style);
    try {
      render(
        <div className="visitor-layer">
          <div className="offcanvas stage-panel stage-panel-1">
            {content("## A heading\n\nA paragraph.\n\n- one\n- two\n\n1. first\n\n:::tabs\n## Tab one\nx\n\n## Tab two\ny\n:::")}
          </div>
        </div>,
      );
      await settle();
      const computed = (selector: string) => getComputedStyle(prose().querySelector(selector)!);
      expect(computed("h2").fontSize).toBe("2rem");
      expect(computed("p").marginBottom).toBe("1rem");
      expect(computed("ul").listStyleType || computed("ul").listStyle).toContain("disc");
      expect(computed("ol").listStyleType || computed("ol").listStyle).toContain("decimal");
      // The tabs' navigation list is a control, not prose: the prose list
      // rules neither indent it nor give it markers. (jsdom's own default
      // for a list is a disc, so the rules that set markers are read too.)
      const nav = prose().querySelector("ul.nav")!;
      expect(getComputedStyle(nav).paddingLeft).not.toBe("2rem");
      const listRules = [...style.sheet!.cssRules]
        .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule && /list-style/.test(rule.style.cssText))
        .filter((rule) => rule.selectorText.includes("stage-panel-text"));
      expect(listRules.length).toBeGreaterThan(0);
      for (const rule of listRules) expect(nav.matches(rule.selectorText), rule.selectorText).toBe(false);
    } finally {
      style.remove();
    }
  });
});
