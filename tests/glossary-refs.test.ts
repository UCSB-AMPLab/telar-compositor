/**
 * glossary-refs.test.ts — contract spec for buildTermRefIndex and
 * rewriteGlossaryLinks over a synthetic Y.Doc.
 *
 * yjs is pure JS (no DOM), so the synthetic doc is constructed directly here.
 * Scan scope is the framework's three link-bearing surfaces: story layer
 * `content` (NOT layer title/button_label), glossary `definition`
 * cross-refs, and page `body`. The link regex captures group 1 as term_id
 * (`[[term_id|display]]`).
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  buildTermRefIndex,
  rewriteGlossaryLinks,
  countGlossaryLinks,
} from "~/lib/glossary-refs";

// ---------------------------------------------------------------------------
// Synthetic-doc helpers — mirror the Y.Array/Y.Map shapes verified in
// use-structural-ops.ts / _app.glossary.tsx.
// ---------------------------------------------------------------------------

function yText(s: string): Y.Text {
  const t = new Y.Text();
  t.insert(0, s);
  return t;
}

interface LayerSeed {
  layer_number: number;
  content: string;
  title?: string;
  button_label?: string;
}
interface StepSeed {
  step_number: number;
  layers: LayerSeed[];
}
interface StorySeed {
  story_id: string;
  title: string;
  steps: StepSeed[];
}
interface GlossarySeed {
  term_id: string;
  title: string;
  definition: string;
}
interface PageSeed {
  slug: string;
  title: string;
  body: string;
}

function buildDoc(opts: {
  stories?: StorySeed[];
  glossary?: GlossarySeed[];
  pages?: PageSeed[];
}): Y.Doc {
  const doc = new Y.Doc();
  const stories = doc.getArray<Y.Map<unknown>>("stories");
  const glossary = doc.getArray<Y.Map<unknown>>("glossary");
  const pages = doc.getArray<Y.Map<unknown>>("pages");

  for (const s of opts.stories ?? []) {
    const storyMap = new Y.Map<unknown>();
    storyMap.set("story_id", s.story_id);
    storyMap.set("title", yText(s.title));
    const stepsArr = new Y.Array<Y.Map<unknown>>();
    for (const st of s.steps) {
      const stepMap = new Y.Map<unknown>();
      stepMap.set("step_number", st.step_number);
      const layersArr = new Y.Array<Y.Map<unknown>>();
      for (const l of st.layers) {
        const layerMap = new Y.Map<unknown>();
        layerMap.set("layer_number", l.layer_number);
        layerMap.set("content", yText(l.content));
        if (l.title !== undefined) layerMap.set("title", yText(l.title));
        if (l.button_label !== undefined)
          layerMap.set("button_label", yText(l.button_label));
        layersArr.push([layerMap]);
      }
      stepMap.set("layers", layersArr);
      stepsArr.push([stepMap]);
    }
    storyMap.set("steps", stepsArr);
    stories.push([storyMap]);
  }

  for (const g of opts.glossary ?? []) {
    const m = new Y.Map<unknown>();
    m.set("term_id", g.term_id);
    m.set("title", yText(g.title));
    m.set("definition", yText(g.definition));
    glossary.push([m]);
  }

  for (const p of opts.pages ?? []) {
    const m = new Y.Map<unknown>();
    m.set("slug", p.slug);
    m.set("title", yText(p.title));
    m.set("body", yText(p.body));
    pages.push([m]);
  }

  return doc;
}

// Pull the first Y.Text in the doc whose string contains a substring — a
// convenience for asserting post-rewrite contents without re-walking shapes.
function allYTextStrings(doc: Y.Doc): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (v instanceof Y.Text) out.push(v.toString());
    else if (v instanceof Y.Array) v.forEach(walk);
    else if (v instanceof Y.Map) v.forEach(walk);
  };
  walk(doc.getArray("stories"));
  walk(doc.getArray("glossary"));
  walk(doc.getArray("pages"));
  return out;
}

// ---------------------------------------------------------------------------
// buildTermRefIndex
// ---------------------------------------------------------------------------

describe("buildTermRefIndex", () => {
  it("indexes a story-layer-content ref, a page-body ref, and a glossary cross-ref", () => {
    const doc = buildDoc({
      stories: [
        {
          story_id: "story-1",
          title: "The Mita",
          steps: [
            {
              step_number: 2,
              layers: [{ layer_number: 1, content: "See [[mit-a]] here." }],
            },
          ],
        },
      ],
      pages: [{ slug: "about", title: "About", body: "Refs [[mit-a]] too." }],
      glossary: [
        { term_id: "mit-a", title: "Mita", definition: "The labour system." },
        {
          term_id: "encomienda",
          title: "Encomienda",
          definition: "Related to [[mit-a]].",
        },
      ],
    });

    const index = buildTermRefIndex(doc);
    const refs = index.get("mit-a") ?? [];

    const storyRef = refs.find((r) => r.kind === "story");
    expect(storyRef).toBeDefined();
    expect(storyRef!.termId).toBe("mit-a");
    expect(storyRef!.storyId).toBe("story-1");
    expect(storyRef!.stepNumber).toBe(2);
    expect(storyRef!.layerNumber).toBe(1);

    const pageRef = refs.find((r) => r.kind === "page");
    expect(pageRef).toBeDefined();
    expect(pageRef!.pageSlug).toBe("about");
    expect(pageRef!.pageTitle).toBe("About");

    const glossaryRef = refs.find((r) => r.kind === "glossary");
    expect(glossaryRef).toBeDefined();
    expect(glossaryRef!.refTermId).toBe("encomienda");
    expect(glossaryRef!.refTermTitle).toBe("Encomienda");
  });

  it("scans story-layer `content` ONLY — not layer title/button_label (scope guard)", () => {
    const doc = buildDoc({
      stories: [
        {
          story_id: "story-1",
          title: "T",
          steps: [
            {
              step_number: 1,
              layers: [
                {
                  layer_number: 1,
                  content: "no links in body",
                  title: "Heading [[in-title]]",
                  button_label: "Go [[in-button]]",
                },
              ],
            },
          ],
        },
      ],
    });

    const index = buildTermRefIndex(doc);
    expect(index.get("in-title")).toBeUndefined();
    expect(index.get("in-button")).toBeUndefined();
  });

  it("captures group 1 (term_id) for a display-alias `[[term_id|display]]` link", () => {
    const doc = buildDoc({
      pages: [{ slug: "p", title: "P", body: "An alias [[mit-a|the mita]] here." }],
    });
    const index = buildTermRefIndex(doc);
    expect(index.get("mit-a")?.length).toBe(1);
    // The alias display text must NOT be indexed as a term_id of its own.
    expect(index.get("the mita")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// rewriteGlossaryLinks + countGlossaryLinks
// ---------------------------------------------------------------------------

describe("rewriteGlossaryLinks", () => {
  it("rewrites [[old]]→[[new]] across all three surfaces and returns the total occurrence count", () => {
    const doc = buildDoc({
      stories: [
        {
          story_id: "s1",
          title: "T",
          steps: [
            { step_number: 1, layers: [{ layer_number: 1, content: "x [[mit-a]] y" }] },
          ],
        },
      ],
      pages: [{ slug: "p", title: "P", body: "page [[mit-a]] body" }],
      glossary: [
        { term_id: "encomienda", title: "E", definition: "see [[mit-a]] also" },
      ],
    });

    const count = rewriteGlossaryLinks(doc, "mit-a", "mita");
    expect(count).toBe(3);

    const strings = allYTextStrings(doc);
    expect(strings.some((s) => s.includes("[[mit-a]]"))).toBe(false);
    expect(strings.filter((s) => s.includes("[[mita]]")).length).toBe(3);
  });

  it("rewrites multiple occurrences in one Y.Text safely (highest-index-first)", () => {
    // Two occurrences with a length-changing replacement (mit-a → mita) in one
    // Y.Text; a left-to-right rewrite would corrupt the second index.
    const doc = buildDoc({
      pages: [
        { slug: "p", title: "P", body: "first [[mit-a]] then [[mit-a]] end" },
      ],
    });

    const count = rewriteGlossaryLinks(doc, "mit-a", "mita");
    expect(count).toBe(2);

    const body = (doc.getArray<Y.Map<unknown>>("pages").get(0).get("body") as Y.Text).toString();
    expect(body).toBe("first [[mita]] then [[mita]] end");
  });

  it("rewrites the term_id of a display-alias link while preserving the display text", () => {
    const doc = buildDoc({
      pages: [{ slug: "p", title: "P", body: "alias [[mit-a|the mita]] kept" }],
    });

    const count = rewriteGlossaryLinks(doc, "mit-a", "mita");
    expect(count).toBe(1);

    const body = (doc.getArray<Y.Map<unknown>>("pages").get(0).get("body") as Y.Text).toString();
    expect(body).toBe("alias [[mita|the mita]] kept");
  });

  it("leaves unrelated links untouched and returns 0 when the old id is absent", () => {
    const doc = buildDoc({
      pages: [{ slug: "p", title: "P", body: "only [[encomienda]] here" }],
    });
    const count = rewriteGlossaryLinks(doc, "mit-a", "mita");
    expect(count).toBe(0);
    const body = (doc.getArray<Y.Map<unknown>>("pages").get(0).get("body") as Y.Text).toString();
    expect(body).toBe("only [[encomienda]] here");
  });
});

describe("countGlossaryLinks (dry-run for impact panel)", () => {
  it("counts occurrences across surfaces without mutating the doc", () => {
    const doc = buildDoc({
      stories: [
        {
          story_id: "s1",
          title: "T",
          steps: [
            { step_number: 1, layers: [{ layer_number: 1, content: "[[mit-a]] [[mit-a]]" }] },
          ],
        },
      ],
      pages: [{ slug: "p", title: "P", body: "[[mit-a]]" }],
    });

    const before = allYTextStrings(doc);
    const n = countGlossaryLinks(doc, "mit-a");
    expect(n).toBe(3);
    // Dry-run: nothing changed.
    expect(allYTextStrings(doc)).toEqual(before);
  });
});
