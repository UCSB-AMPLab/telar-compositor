// @vitest-environment jsdom
/**
 * The shared glossary resolver, case by case, and the glossary definition
 * preview that uses it. Whether the resolver writes what the framework
 * writes is checked against the framework's own output in
 * card-markdown-parity.test.tsx; these cases pin the rules one at a time so a
 * failure names the rule.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import * as Y from "yjs";
import {
  glossaryTermSlug,
  glossaryTermsFromDoc,
  resolveGlossaryLinks,
} from "~/lib/glossary-links";
import { CollaborationContext, type CollaborationContextValue } from "~/hooks/use-collaboration";
import { GlossaryPreviewPane } from "~/components/features/glossary/GlossaryPreviewPane";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const terms = new Map([
  ["IIIF", "International Image Interoperability Framework"],
  ["demo-loom", "Loom"],
]);

describe("resolveGlossaryLinks", () => {
  it("matches whatever the casing and writes the stored id", () => {
    expect(resolveGlossaryLinks("[[iiif]]", terms, "/telar")).toBe(
      '<a href="#" class="glossary-inline-link" data-term-id="IIIF" data-term-url="/telar/glossary/iiif/">International Image Interoperability Framework</a>',
    );
  });

  it("uses the display text when one is given, escaped", () => {
    expect(resolveGlossaryLinks("[[ IIIF | a <b> & \"c\" ]]", terms, "")).toContain(
      ">a &lt;b&gt; &amp; &quot;c&quot;</a>",
    );
  });

  it("marks a demo term", () => {
    expect(resolveGlossaryLinks("[[Demo-Loom]]", terms, "")).toContain('data-demo="true"');
  });

  it("marks an unknown term with the author's casing", () => {
    expect(resolveGlossaryLinks("[[Nope|shown]]", terms, "")).toBe(
      '<span class="glossary-link-error" data-term-id="Nope">⚠️ [[Nope]]</span>',
    );
  });

  it("leaves the text alone when the glossary is empty", () => {
    expect(resolveGlossaryLinks("[[iiif]]", new Map(), "")).toBe("[[iiif]]");
  });

  it("strips Python's whitespace around the id, not JavaScript's", () => {
    // U+0085 is whitespace to Python and not to JavaScript.
    expect(resolveGlossaryLinks("[[\u0085iiif\u0085]]", terms, "")).toContain('data-term-id="IIIF"');
  });
});

describe("glossaryTermSlug, as Jekyll names a term's page", () => {
  it.each([
    ["IIIF", "iiif"],
    ["Colonial Period", "colonial-period"],
    ["Café", "café"],
    ["été", "été"],
    ["a -- b!!c", "a-b-c"],
    ["--x--", "x"],
    ["ΟΣ", "οσ"],
    ["año_2", "año-2"],
  ])("%s -> %s", (id, slug) => {
    expect(glossaryTermSlug(id)).toBe(slug);
  });
});

describe("glossaryTermsFromDoc", () => {
  it("keeps what the framework's loader keeps", () => {
    const ydoc = new Y.Doc();
    const glossary = ydoc.getArray<Y.Map<unknown>>("glossary");
    const row = (id: string, title: string) => {
      const m = new Y.Map<unknown>();
      m.set("term_id", id);
      m.set("title", title);
      return m;
    };
    glossary.push([row(" a ", " A "), row("#note", "N"), row("b", ""), row("", "C")]);
    expect([...glossaryTermsFromDoc(ydoc)]).toEqual([["a", "A"]]);
  });
});

describe("GlossaryPreviewPane", () => {
  function pane(definition: string) {
    const ydoc = new Y.Doc();
    const glossary = ydoc.getArray<Y.Map<unknown>>("glossary");
    const term = new Y.Map<unknown>();
    term.set("term_id", "IIIF");
    term.set("title", "Image framework");
    term.set("definition", definition);
    glossary.push([term]);
    const yMap = glossary.get(0);
    const context = { ydoc } as unknown as CollaborationContextValue;
    return render(
      <CollaborationContext.Provider value={context}>
        <GlossaryPreviewPane yMap={yMap} theme="austin" termVersion={0} titleLabel="T" />
      </CollaborationContext.Provider>,
    );
  }

  it("resolves case-insensitively and marks an unknown term", () => {
    const { container } = pane("See [[iiif]] and [[missing]].");
    expect(container.querySelector("a.glossary-inline-link")!.textContent).toBe("Image framework");
    expect(container.querySelector("span.glossary-link-error")!.textContent).toBe("⚠️ [[missing]]");
  });

  it("shows glossary syntax inside code as written", () => {
    const { container } = pane("Type `[[iiif]]` or\n\n    [[missing]]\n\nfor [[iiif]].");
    expect(container.querySelectorAll("a.glossary-inline-link")).toHaveLength(1);
    expect(container.querySelector("span.glossary-link-error")).toBeNull();
    expect([...container.querySelectorAll("code")].map((code) => code.textContent!.trim())).toEqual(["[[iiif]]", "[[missing]]"]);
  });

  it("does not follow a glossary link", () => {
    const { container } = pane("See [[iiif]].");
    const link = container.querySelector("a.glossary-inline-link")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("loads the theme's fonts", () => {
    const { container } = pane("x");
    expect(container.querySelector('link[rel="stylesheet"]')!.getAttribute("href")).toContain("Crimson+Pro");
  });
});

describe("a glossary link in a widget title", () => {
  it("opens the section and is not followed", async () => {
    const { EditorState } = await import("@codemirror/state");
    const { markdown } = await import("@codemirror/lang-markdown");
    const { parsePanel } = await import("~/components/ui/markdown-editor/panelSource");
    const { WidgetPreview } = await import("~/components/ui/markdown-editor/WidgetPreview");
    const state = EditorState.create({ doc: ":::accordion\n## The [[iiif]] standard\nBody.\n\n## Two\nMore.\n:::", extensions: [markdown()] });
    const links = (html: string) => resolveGlossaryLinks(html, terms, "/site");
    const { container } = render(<WidgetPreview block={parsePanel(state).widgets[0]} links={links} />);
    const link = container.querySelector(".accordion-button a.glossary-inline-link")!;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    fireEvent(link, event);
    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector(".accordion-button")!.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("data-term-url after the glossary pass", () => {
  const PAYLOADS = ["javascript:alert(1)", "data:text/html,<script>alert(1)</script>", "java&#x09;script:alert(1)"];

  it.each(PAYLOADS)("a baseurl of %s writes no address that survives the sanitiser", async (baseUrl) => {
    const { previewSanitise } = await import("~/lib/preview-sanitise");
    const html = previewSanitise(resolveGlossaryLinks("See [[iiif]].", terms, baseUrl));
    const a = new DOMParser().parseFromString(html, "text/html").querySelector("a.glossary-inline-link")!;
    expect(a.textContent).toBe(terms.get("IIIF"));
    expect(a.hasAttribute("data-term-url")).toBe(false);
  });

  it.each(PAYLOADS)("an author's raw link with %s survives neither pass of renderPanel", async (url) => {
    const { renderPanel } = await import("~/lib/card-markdown");
    const source = `A <a href="#" class="glossary-inline-link" data-term-id="x" data-term-url="${url}">raw</a> and [[iiif]].`;
    const { html } = renderPanel(source, { glossary: { terms, baseUrl: "/telar" }, baseUrl: "/telar", anchor: "p", unavailable: "" });
    const links = [...new DOMParser().parseFromString(html, "text/html").querySelectorAll("a.glossary-inline-link")];
    expect(links.map((a) => a.getAttribute("data-term-url"))).toEqual([null, "/telar/glossary/iiif/"]);
  });
});
