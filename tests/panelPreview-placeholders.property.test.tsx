// @vitest-environment jsdom
/**
 * Placeholders against random author text. Each case composes Markdown,
 * raw HTML the sanitiser removes, entities, formulas, footnote references
 * and text shaped like placeholders, some of it split by a tag or an
 * entity. Rendered with the preview's real random stems, each case must
 * produce the same DOM — element tree, text and every decoded attribute —
 * as the same text rendered with a stem no input holds, and no placeholder
 * of either stem may survive into it, a formula found inside another
 * included: the framework publishes that as the author wrote it. Formulas
 * sit in text and in href, src, title and alt, through autolinks, links,
 * images, raw tags and reused reference definitions.
 *
 * The compositions are seeded, so every run checks the same texts.
 *
 * @version v1.5.0-beta
 */
import { afterEach, describe, it, expect } from "vitest";
import {
  panelCaption,
  panelMarkdown,
  setPlaceholderStemSource,
} from "../app/components/ui/markdown-editor/panelPreview";

/** Twelve capitals an author might paste, as from an earlier page. */
const PASTED = "AAAAAAAAAAAA";
const CASES = 3000;

/** mulberry32: a small seeded generator. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MARKDOWN = ["*a*", "**b**", "`c`", "[l](https://e.org/p)", "<https://e.org/u>", "\n\n", "\n", " ", "- i\n", "> q\n"];
const REMOVED = [
  "<script>x</script>",
  "<style>y</style>",
  "<!-- > -->",
  "<!-- z -->",
  "<span>w</span>",
  "<x-y>v</x-y>",
  '<b onclick="q">b</b>',
  '<em data-x="1">e</em>',
  "<div>",
  "</div>",
];
const ENTITIES = ["&#88;", "&#x54;", "&amp;", "&lt;", "&#70;", "&#76;"];
const FORMULAS = ["$x_1$", "\\(y^2\\)", "$$z*w$$", "\\ce{H2O}"];
/** Formulas inside href, src, title and alt: autolinks, links, images, raw tags and reused references. */
const ATTRIBUTES = [
  "<https://e.org/$x_1$>",
  '[l](https://e.org/$x_1$ "t $y_1$")',
  '![alt $x_1$](https://e.org/i.png "$t_1$")',
  '<a href="https://e.org/$x_1$" title="$y^2$">a</a>',
  '<img src="https://e.org/$x_1$.png" alt="$y_1$">',
  '[a][r] and [b][r]\n\n[r]: https://e.org/$x_1$ "$y_1$"\n\n',
  '![i][s] ![j][s]\n\n[s]: https://e.org/$z_1$.png "$w_1$"\n\n',
];
/** Placeholders for the forced stem, whole and in pieces an entity or a tag can join. */
const PIECES = [
  `TLATEX${PASTED}0END`,
  `TFNREF${PASTED}0END`,
  "TLA",
  "TEX",
  `${PASTED}0END`,
  "TFN",
  "REF",
  "TLATE",
  "TFNRE",
  `${PASTED}1END`,
];

/** A whole placeholder for the forced stem, split by something the pipeline removes or decodes. */
function splice(random: () => number): string {
  const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)];
  const [head, tail] = pick([["TLA", "TEX"], ["TFN", "REF"], ["TLATE", "X"], ["TFNRE", "F"]]);
  const joint = pick([...REMOVED, "&#88;", "&#70;", ""]);
  const glued = joint.startsWith("&") ? `${head.slice(0, -1)}${joint}${tail}` : `${head}${joint}${tail}`;
  return `${glued}${PASTED}${Math.floor(random() * 3)}END`;
}

function composition(random: () => number): string {
  const groups = [MARKDOWN, REMOVED, ENTITIES, FORMULAS, FORMULAS, ATTRIBUTES, ATTRIBUTES, PIECES, [""]];
  const length = 3 + Math.floor(random() * 10);
  let text = "";
  for (let i = 0; i < length; i++) {
    const g = Math.floor(random() * groups.length);
    const group = groups[g];
    text += g === groups.length - 1 ? splice(random) : group[Math.floor(random() * group.length)];
  }
  return text;
}

/** The preview's own kind of stem: twelve random capitals from the system's CSPRNG. */
function realStem(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((b) => String.fromCharCode(65 + (b % 26))).join("");
}

/** A render and the stem each of its conversions drew. */
interface Rendered {
  html: string;
  stems: string[];
}

/** Renders with stems from `draw`, recording each conversion's stem. */
function renderWith(draw: (n: number) => string, render: () => string): Rendered {
  const stems: string[] = [];
  setPlaceholderStemSource(() => {
    const stem = draw(stems.length);
    stems.push(stem);
    return stem;
  });
  return { html: render(), stems };
}

/** Stems no input holds, one per conversion, so each conversion is still told apart. */
const safeStem = (n: number) => `ZZZZZZZZZZZ${String.fromCharCode(65 + n)}`;

/** Element tree, text and decoded attributes, as one comparable string. */
function structure(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return JSON.stringify((node as Text).data);
  const children = [...node.childNodes].map(structure).join("");
  if (node.nodeType !== Node.ELEMENT_NODE) return children;
  const element = node as Element;
  const attributes = [...element.attributes]
    .map((a) => `${a.name}=${JSON.stringify(a.value)}`)
    .sort()
    .join(" ");
  return `<${element.localName} ${attributes}>${children}</${element.localName}>`;
}

/** The render's element tree, text and decoded attributes. */
function reading(rendered: Rendered): string {
  // A template, not DOMParser: jsdom slows with every parsed document kept.
  const doc = document.createElement("template");
  doc.innerHTML = rendered.html;
  return structure(doc.content);
}

function survivorsOf(rendered: Rendered): RegExp {
  return new RegExp(`T(?:LATEX|FNREF)(?:${rendered.stems.join("|")})\\d+END`);
}

afterEach(() => setPlaceholderStemSource(null));

describe("placeholders against random author text", () => {
  it(`hold for ${CASES} seeded compositions`, { timeout: 120000 }, () => {
    const random = seeded(20260926);
    for (let n = 0; n < CASES; n++) {
      const body = composition(random);
      const note = `Note ${FORMULAS[n % FORMULAS.length]} ${ATTRIBUTES[n % ATTRIBUTES.length].trim()}`;
      const withNote = `${body} a[^a].\n\n[^a]: ${note}`;
      const renders: Array<() => string> = [
        () => panelMarkdown(body),
        () => panelCaption(body),
        () => panelMarkdown(withNote, `p${n}`, "Shown as written"),
      ];
      for (const render of renders) {
        const real = renderWith(realStem, render);
        const safe = renderWith(safeStem, render);
        const context = `case ${n}: ${JSON.stringify(body)}`;
        expect(reading(real), context).toEqual(reading(safe));
        expect(reading(real), context).not.toMatch(survivorsOf(real));
      }
    }
  });
});
