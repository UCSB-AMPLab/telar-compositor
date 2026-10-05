// @vitest-environment jsdom
/**
 * The preview sanitiser keeps what the framework publishes and nothing that
 * runs. Each case reads the sanitised DOM, not the string.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect } from "vitest";
import { previewSanitise } from "~/lib/preview-sanitise";

const dom = (html: string) => {
  const template = document.createElement("template");
  template.innerHTML = previewSanitise(html);
  return template.content;
};

describe("previewSanitise keeps what the framework emits", () => {
  it("keeps a glossary link with its attributes", () => {
    const a = dom(
      '<a href="#" class="glossary-inline-link" data-term-id="IIIF" data-term-url="/site/glossary/iiif/" data-demo="true">IIIF</a>',
    ).querySelector("a")!;
    expect(a.className).toBe("glossary-inline-link");
    expect(a.getAttribute("href")).toBe("#");
    expect(a.dataset.termId).toBe("IIIF");
    expect(a.dataset.termUrl).toBe("/site/glossary/iiif/");
    expect(a.dataset.demo).toBe("true");
  });

  it("keeps the unknown-term marker", () => {
    const span = dom('<span class="glossary-link-error" data-term-id="x">⚠️ [[x]]</span>').querySelector("span")!;
    expect(span.className).toBe("glossary-link-error");
    expect(span.dataset.termId).toBe("x");
    expect(span.textContent).toBe("⚠️ [[x]]");
  });

  it("keeps a glossary callout's kind and icon, and nothing in the icon that runs or addresses anything", () => {
    const a = dom(
      '<a href="#" class="glossary-inline-link glossary-callout" data-glossary-kind="term">' +
        '<svg class="glossary-callout-icon" viewBox="0 0 24 24" stroke-width="1.5" onload="x()">' +
        '<path d="M1 2" style="fill:red"></path><circle cx="1" cy="2" r=".6" fill="currentColor"></circle>' +
        '<script>x()</script><use href="#a"></use></svg></a>',
    ).querySelector("a")!;
    expect(a.dataset.glossaryKind).toBe("term");
    const svg = a.querySelector("svg")!;
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("stroke-width")).toBe("1.5");
    expect(svg.hasAttribute("onload")).toBe(false);
    expect(svg.querySelector("path")!.getAttribute("d")).toBe("M1 2");
    expect(svg.querySelector("path")!.hasAttribute("style")).toBe(false);
    expect(svg.querySelector("circle")!.getAttribute("fill")).toBe("currentColor");
    expect(svg.querySelector("script, use")).toBeNull();
  });

  it("keeps figures, captions and the image size class", () => {
    const figure = dom(
      '<figure class="telar-image-figure"><img src="/telar-content/objects/a.jpg" alt="A" class="img-md"><figcaption class="telar-image-caption">Cap <em>x</em></figcaption></figure>',
    ).querySelector("figure")!;
    expect(figure.querySelector("img")!.getAttribute("src")).toBe("/telar-content/objects/a.jpg");
    expect(figure.querySelector("img")!.className).toBe("img-md");
    expect(figure.querySelector("figcaption em")!.textContent).toBe("x");
  });

  it("keeps footnote references, lists and back links", () => {
    const root = dom(
      '<p>A<sup id="fnref:1"><a class="footnote-ref" href="#fn:1">1</a></sup></p><div class="footnote"><hr><ol><li id="fn:1"><p>N&#160;<a class="footnote-backref" href="#fnref:1" title="Back">&#8617;</a></p></li></ol></div>',
    );
    expect(root.querySelector("sup#fnref\\:1 a.footnote-ref")!.getAttribute("href")).toBe("#fn:1");
    expect(root.querySelector("div.footnote ol li#fn\\:1 a.footnote-backref")!.getAttribute("title")).toBe("Back");
  });

  it("keeps tables with cell alignment and nothing else in style", () => {
    const cell = dom('<table><tr><td style="text-align: left; color: red">x</td></tr></table>').querySelector("td")!;
    expect(cell.style.textAlign).toBe("left");
    expect(cell.style.color).toBe("");
  });
});

describe("previewSanitise drops what runs", () => {
  it("drops scripts, handlers and unsafe schemes", () => {
    const root = dom(
      '<script>alert(1)</script><img src="x" onerror="alert(1)"><a href="javascript:alert(1)">j</a><img src="data:image/png;base64,AA"><iframe src="https://x"></iframe><p style="color:red" onclick="x()">p</p>',
    );
    expect(root.querySelector("script, iframe")).toBeNull();
    expect(root.querySelector("img")!.hasAttribute("onerror")).toBe(false);
    expect(root.querySelector("a")!.hasAttribute("href")).toBe(false);
    expect(root.querySelectorAll("img")[1].hasAttribute("src")).toBe(false);
    expect(root.querySelector("p")!.hasAttribute("style")).toBe(false);
    expect(root.querySelector("p")!.hasAttribute("onclick")).toBe(false);
  });

  it("drops form controls and buttons, keeping their text", () => {
    const root = dom("<button>Go</button><input value=x><form><p>f</p></form>");
    expect(root.querySelector("button, input, form")).toBeNull();
    expect(root.textContent).toContain("Go");
  });
});

describe("a glossary link's data-term-url", () => {
  const PAYLOADS = ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "java&#x09;script:alert(1)", "//evil.example/x", "/\\evil.example/x", " /glossary/x/", "https://evil.example/x", "/glossary/x&#127;/", "/glossary/&#160;x/", "/glossary/x&#x2028;/"];
  const link = (url: string) => `<a href="#" class="glossary-inline-link" data-term-id="t" data-term-url="${url}">T</a>`;

  it.each(PAYLOADS)("drops %s and keeps the link", (url) => {
    const a = dom(link(url)).querySelector("a")!;
    expect(a.hasAttribute("data-term-url")).toBe(false);
    expect(a.dataset.termId).toBe("t");
    expect(a.getAttribute("href")).toBe("#");
  });

  it.each(PAYLOADS)("stays dropped through a second sanitise: %s", (url) => {
    const twice = previewSanitise(previewSanitise(link(url)));
    expect(twice).not.toContain("data-term-url");
  });
});
