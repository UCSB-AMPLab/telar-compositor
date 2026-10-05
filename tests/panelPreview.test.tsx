// @vitest-environment jsdom
/** Fixtures come from the framework pipeline, independent of the browser renderer. @version v1.5.0-beta */
import { afterEach, describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { parsePanel } from "../app/components/ui/markdown-editor/panelSource";
import { WidgetPreview } from "../app/components/ui/markdown-editor/WidgetPreview";
import {
  panelMarkdown,
  panelCaption,
  setPlaceholderStemSource,
} from "../app/components/ui/markdown-editor/panelPreview";
import {
  parseMath,
  loadPanelMath,
} from "../app/components/ui/markdown-editor/panelMath";
import { parsePanelPreviewConfig } from "../app/lib/panel-preview-config";
import fixture from "./fixtures/panel-preview.json";
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
for (const example of fixture.cases)
  it(`matches published ${example.kind} content and layout classes`, () => {
    expect(example.warnings).toEqual([]);
    const block = parsePanel(
      EditorState.create({ doc: example.source, extensions: [markdown()] }),
    ).widgets[0];
    const actual = new DOMParser().parseFromString(
      renderToStaticMarkup(<WidgetPreview block={block} />),
      "text/html",
    );
    const expected = new DOMParser().parseFromString(example.html, "text/html");
    const contentSelectors = [
      ".accordion-button",
      ".accordion-body",
      ".nav-link",
      ".tab-pane-content",
      ".telar-bib-entry",
      ".caption-text",
      ".caption-credit",
    ];
    for (const selector of contentSelectors) {
      const normalise = (doc: Document) =>
        [...doc.querySelectorAll(selector)].map((node) =>
          node.innerHTML.replace(/>\s+</g, "><").trim(),
        );
      expect(normalise(actual), selector).toEqual(normalise(expected));
    }
    const imageInfo = (doc: Document) =>
      [...doc.querySelectorAll("img")].map((img) => [
        img.getAttribute("src"),
        img.getAttribute("alt"),
      ]);
    expect(imageInfo(actual)).toEqual(imageInfo(expected));
    if (example.kind === "carousel")
      expect(actual.querySelector(".carousel-size-compact")).not.toBeNull();
    if (example.kind === "bibliography")
      expect(actual.querySelector(".telar-widget")).toBeNull();
  });
it("sanitises author HTML and dangerous links without altering stored source", () => {
  const source =
    '<img src="javascript:alert(1)" onerror="alert(2)"><script>alert(3)</script>[link](javascript:alert(4))';
  const output = panelMarkdown(source);
  expect(output).not.toMatch(/javascript:|onerror|<script|alert\(3\)/);
});
it("respects configured delimiters, rejects asset URLs and unsupported versions", () => {
  const config = parsePanelPreviewConfig(
    'version: "0.16.21"\njs: https://untrusted.invalid/code.js\ndelimiters:\n  - left: "<<"\n    right: ">>"\n    display: true',
    null,
  );
  expect(config.available).toBe(true);
  expect(
    parseMath("<<x>> $y$", [], config.delimiters).map((m) => m.source),
  ).toEqual(["x"]);
  expect(config).not.toHaveProperty("js");
  expect(parsePanelPreviewConfig('version: "0.1.0"', null).available).toBe(
    false,
  );
});
it("renders chemistry and display equations with the pinned renderer", async () => {
  const katex = await loadPanelMath();
  const html = katex.default.renderToString("\\ce{H2O}", {
    throwOnError: true,
    trust: false,
  });
  expect(html).toContain("katex");
  expect(html).not.toContain("katex-error");
  expect(parseMath("$$x^2$$ and \\(y\\)", []).map((m) => m.display)).toEqual([
    true,
    false,
  ]);
});
it("restores a formula as text, so markup inside one never reaches the editor", () => {
  const doc = new DOMParser().parseFromString(panelMarkdown("Before $$<img src=x onerror=alert(1)>$$ after"), "text/html");
  expect(doc.querySelector("img")).toBeNull();
  expect(doc.body.textContent?.trim()).toBe("Before $$<img src=x onerror=alert(1)>$$ after");
});

describe("a formula restored after sanitising stays text", () => {
  const ATTRIBUTE = `<a title='$$" onmouseover="alert(1)//$$'>hover</a> and $x^2$`;
  const TEXT = "Before $$<img src=x onerror=alert(1)><b>bold</b>$$ after";
  const URL = "See [link]($$javascript:alert(1)$$) and [other](https://example.org/$a_1$)";
  const render = (html: string) => new DOMParser().parseFromString(html, "text/html");
  const handlers = (doc: Document) =>
    [...doc.querySelectorAll("*")].flatMap((e) => [...e.attributes].filter((a) => a.name.startsWith("on")));

  it.each([
    ["panelMarkdown", panelMarkdown],
    ["panelCaption", panelCaption],
  ])("in an attribute, through %s", (_name, convert) => {
    const doc = render(convert(ATTRIBUTE));
    expect(handlers(doc)).toEqual([]);
    expect(doc.querySelector("a")?.getAttribute("title")).toBe(`$$" onmouseover="alert(1)//$$`);
  });

  // The site restores a formula HTML-escaped in every conversion, so a
  // section keeps it as written, as a caption does.
  it.each([
    ["panelMarkdown", panelMarkdown],
    ["panelCaption", panelCaption],
  ])("in text, through %s", (_name, convert) => {
    const doc = render(convert(TEXT));
    expect(doc.querySelector("img, b")).toBeNull();
    expect(handlers(doc)).toEqual([]);
    expect(doc.body.textContent).toContain("$$<img src=x onerror=alert(1)><b>bold</b>$$");
  });

  it.each([
    ["panelMarkdown", panelMarkdown],
    ["panelCaption", panelCaption],
  ])("in a link address, through %s", (_name, convert) => {
    const doc = render(convert(URL));
    const hrefs = [...doc.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "");
    expect(hrefs.every((href) => !/^\s*javascript:/i.test(href))).toBe(true);
    expect(hrefs).toContain("https://example.org/$a_1$");
  });
});

describe("author text that looks like a placeholder", () => {
  const text = (html: string) => new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";

  it("does not crash restoration, alone or in a cycle", () => {
    expect(text(panelMarkdown("$$TLATEX0000END$$"))).toContain("$$TLATEX0000END$$");
    expect(text(panelMarkdown("$$TLATEX1END$$ and $$TLATEX0END$$"))).toContain("$$TLATEX1END$$ and $$TLATEX0END$$");
  });

  it("is never taken for a formula or a reference", () => {
    expect(text(panelMarkdown("TLATEX0END and $x_1$"))).toContain("TLATEX0END and $x_1$");
    const withNotes = panelMarkdown("TFNREF0END and a[^a].\n\n[^a]: Note", "p");
    expect(text(withNotes)).toContain("TFNREF0END and a");
    expect(new DOMParser().parseFromString(withNotes, "text/html").querySelectorAll("a.footnote-ref")).toHaveLength(1);
  });

  it("stays as it is in an attribute", () => {
    const doc = new DOMParser().parseFromString(panelMarkdown('<a title="TLATEX0END">x</a> $x_1$'), "text/html");
    expect(doc.querySelector("a")?.getAttribute("title")).toBe("TLATEX0END");
  });
});

describe("author text that decodes or assembles into a placeholder", () => {
  const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

  it("through an entity, is not taken for a formula", () => {
    expect(parse(panelMarkdown("TLATE&#88;A0END and $x_1$")).body.textContent).toContain("TLATEXA0END and $x_1$");
  });

  it("through an entity, is not taken for a footnote reference", () => {
    const doc = parse(panelMarkdown("TFNRE&#70;A0END and a[^a].\n\n[^a]: Note", "p"));
    expect(doc.body.textContent).toContain("TFNREFA0END and a");
    expect(doc.querySelectorAll("a.footnote-ref")).toHaveLength(1);
    expect(doc.querySelectorAll("a.footnote-backref")).toHaveLength(1);
  });

  it("through a removed tag, is not taken for a formula", () => {
    expect(parse(panelMarkdown("TLA<script>x</script>TEXA0END and $x_1$")).body.textContent).toContain(
      "TLATEXA0END and $x_1$",
    );
  });
});

describe("copies the Markdown parser makes of a placeholder", () => {
  const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

  it("are all restored in an autolink", () => {
    const doc = parse(panelMarkdown("<https://example.org/$x_1$> and \\(x^2\\)"));
    expect(doc.querySelector("a")?.getAttribute("href")).toBe("https://example.org/$x_1$");
    expect(doc.querySelector("a")?.textContent).toBe("https://example.org/$x_1$");
    expect(doc.body.textContent).toContain("and \\(x^2\\)");
  });

  it("are all restored in a reused reference-link destination and title", () => {
    const source = '[a][r] and [b][r] and \\(x^2\\)\n\n[r]: https://example.org/$y_1$ "$t_1$"';
    const doc = parse(panelMarkdown(source));
    const links = [...doc.querySelectorAll("a")];
    expect(links.map((a) => [a.getAttribute("href"), a.getAttribute("title")])).toEqual([
      ["https://example.org/$y_1$", "$t_1$"],
      ["https://example.org/$y_1$", "$t_1$"],
    ]);
    expect(doc.body.textContent).toContain("\\(x^2\\)");
  });

  it("leave footnotes whole beside a reused link", () => {
    const source = "[a][r] and [b][r] and x[^a].\n\n[^a]: Note\n\n[r]: https://example.org/$y_1$";
    const doc = parse(panelMarkdown(source, "p"));
    expect(doc.querySelectorAll("a.footnote-ref")).toHaveLength(1);
    const back = doc.querySelector("a.footnote-backref")!.getAttribute("href")!.slice(1);
    expect(doc.getElementById(back)).not.toBeNull();
  });

  it("are all restored in a caption", () => {
    const doc = parse(panelCaption("<https://example.org/$x_1$> and \\(y^2\\)"));
    expect(doc.querySelector("a")?.getAttribute("href")).toBe("https://example.org/$x_1$");
    expect(doc.body.textContent).toContain("and \\(y^2\\)");
  });
});

describe("a stem any form of the author's text contains", () => {
  const STEM = "AAAAAAAAAAAA";
  let draws = 0;
  afterEach(() => setPlaceholderStemSource(null));
  const forceFirst = () => {
    draws = 0;
    setPlaceholderStemSource(() => (draws++ === 0 ? STEM : "BBBBBBBBBBBB"));
  };
  const text = (html: string) => new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";

  it.each([
    ["as written", `TLATEX${STEM}0END and $x_1$`, `TLATEX${STEM}0END and $x_1$`],
    ["with an entity decoded", `TLATE&#88;${STEM}0END and $x_1$`, `TLATEX${STEM}0END and $x_1$`],
    ["with a tag removed", `TLA<span></span>TEX${STEM}0END and $x_1$`, `TLATEX${STEM}0END and $x_1$`],
    ["as a reference, with an entity decoded", `TFNRE&#70;${STEM}0END and $x_1$`, `TFNREF${STEM}0END and $x_1$`],
  ])("is drawn again when the text holds it %s", (_how, source, shown) => {
    forceFirst();
    expect(text(panelMarkdown(source))).toContain(shown);
    expect(draws).toBe(2);
  });
});

describe("a text whose references cannot be put back", () => {
  it("is shown as written, with the notice, instead of losing its notes", () => {
    const source = '[x](https://example.org "t[^a]") and y[^a].\n\n[^a]: Note';
    const doc = new DOMParser().parseFromString(panelMarkdown(source, "p", "Shown as written"), "text/html");
    const block = doc.querySelector(".cm-panel-unavailable")!;
    expect(block.querySelector("p")?.textContent).toBe("Shown as written");
    expect(block.querySelector("pre")?.textContent).toBe(source);
  });
});

// No forced-stem tests here for text the sanitiser joins (a <script>,
// <style> or comment between two halves of a placeholder), or for a forged
// reference split that way. Such a collision needs a stem the author has
// written, and a real stem is twelve random letters drawn for each
// conversion, which no author can know; placeholderStem states the threat
// model. Forcing the stem tests a case that cannot occur.
it("moves a carousel image to the next address the framework would look in when one fails", async () => {
  const { render, fireEvent, cleanup } = await import("@testing-library/react");
  const source = ":::carousel\nimage: plate.jpg\nalt: A plate\n:::";
  const block = parsePanel(EditorState.create({ doc: source, extensions: [markdown()] })).widgets[0];
  const site = "https://owner.github.io/site";
  const view = render(<WidgetPreview block={block} siteBaseUrl={site} />);
  const src = () => view.container.querySelector("img")?.getAttribute("src");
  expect(src()).toBe(`${site}/assets/images/plate.jpg`);
  fireEvent.error(view.container.querySelector("img")!);
  expect(src()).toBe(`${site}/assets/images/plate.JPG`);
  fireEvent.error(view.container.querySelector("img")!);
  expect(src()).toBe(`${site}/telar-content/objects/plate.jpg`);
  fireEvent.error(view.container.querySelector("img")!);
  expect(src()).toBe(`${site}/telar-content/objects/plate.JPG`);
  fireEvent.error(view.container.querySelector("img")!);
  expect(src()).toBe(`${site}/assets/images/plate.jpg`);
  fireEvent.error(view.container.querySelector("img")!);
  expect(src()).toBe(`${site}/assets/images/plate.jpg`);
  const other = parsePanel(EditorState.create({ doc: source.replace("plate", "other"), extensions: [markdown()] })).widgets[0];
  view.rerender(<WidgetPreview block={other} siteBaseUrl={site} />);
  expect(src()).toBe(`${site}/assets/images/other.jpg`);
  view.rerender(<WidgetPreview block={block} siteBaseUrl={site} />);
  expect(src()).toBe(`${site}/assets/images/plate.jpg`);
  cleanup();
});
