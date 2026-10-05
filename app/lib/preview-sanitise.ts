/**
 * preview-sanitise — the policy for author text previewed as the site
 * publishes it: a step card's answer, a layer panel's sections, entries and
 * notes, and a glossary definition.
 *
 * The framework publishes author HTML unsanitised (scripts/telar/markdown.py,
 * "Content trust model"), and the Compositor shows it to every collaborator on
 * a project, so the preview keeps only what the framework's own pipeline
 * writes and what an author's Markdown can produce through it:
 *
 *   - glossary links as `process_glossary_links` writes them
 *     (scripts/telar/glossary.py): `a.glossary-inline-link` with `data-term-id`,
 *     `data-term-url` and `data-demo`, and `span.glossary-link-error` with
 *     `data-term-id`;
 *   - the glossary callout as `_includes/widgets/glossary.html` draws it: the
 *     same link with `data-glossary-kind`, and its icons, an `svg` holding
 *     `path` and `circle` elements with their geometry and stroke
 *     attributes and nothing that addresses anything;
 *   - Python Markdown's `extra` (tables with their cell alignment, definition
 *     lists, abbreviations, footnote references, lists and back links) and
 *     kramdown's GFM output (tables, strikethrough, code spans);
 *   - figures and captions as `process_images` writes them (scripts/telar/
 *     images.py): `figure.telar-image-figure`, `img` with its size class,
 *     `figcaption.telar-image-caption`;
 *   - `span`, `div`, `sup` and `sub`, which the framework and authors both use.
 *
 * Nothing that runs or submits is kept: no script, style, form control,
 * frame or embed, no event handler, and no link or image address whose scheme
 * is anything but http, https or mailto (images: http and https). An
 * address starting `//` is kept, as the site keeps it: it takes the page's
 * own scheme, so it can reach nothing an https address could not. A `style`
 * attribute survives only on a table cell, and only its `text-align`.
 *
 * A glossary link's `data-term-url` is an address the site's script fetches
 * when the link is clicked, so it is held to what the framework writes
 * there: a site-relative path, the baseurl, `/glossary/` and the term's
 * slug. Anything else — a scheme, a `//` or `/\` address, a control
 * character or space — removes the attribute.
 *
 * `app/lib/sanitise-html.ts` is the policy for maintainer Markdown (release
 * notes, docs); it drops `span` and the glossary attributes on purpose and is
 * not this one.
 *
 * @version v1.5.0-beta
 */

import sanitizeHtml from "sanitize-html";

const ALLOWED_TAGS = [
  "h1", "h2", "h3", "h4", "h5", "h6",
  "p", "div", "span", "br", "hr",
  "a", "strong", "em", "b", "i", "u", "s", "del", "ins", "mark", "small",
  "sup", "sub", "code", "kbd", "samp", "var", "abbr", "cite", "q",
  "pre", "blockquote",
  "ul", "ol", "li", "dl", "dt", "dd",
  "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td",
  "figure", "figcaption", "img",
  "svg", "path", "circle",
];

const ALLOWED_ATTRIBUTES: sanitizeHtml.IOptions["allowedAttributes"] = {
  "*": ["id", "class", "title", "lang", "dir"],
  a: ["href", "data-term-id", "data-term-url", "data-demo", "data-glossary-kind"],
  // The parser reads attribute names in lower case; an HTML page reads
  // `viewbox` on an `svg` as `viewBox`.
  svg: ["viewbox", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "aria-hidden", "focusable"],
  path: ["d"],
  circle: ["cx", "cy", "r", "fill"],
  span: ["data-term-id"],
  img: ["src", "alt", "width", "height"],
  ol: ["start"],
  th: ["style", "align", "colspan", "rowspan"],
  td: ["style", "align", "colspan", "rowspan"],
};

const TEXT_ALIGN = [/^(left|right|center)$/];

/**
 * A path on the site itself: one leading `/`, no second `/` or `\` after it, and no whitespace or
 * control character of any kind (Unicode spaces and line separators, DEL and C1 included).
 */
const SITE_PATH = /^\/(?![/\\])[^\s\u0000-\u001F\u007F-\u009F\\]*$/u;

/** Drops a `data-term-url` that is not a site-relative path. Values arrive entity-decoded. */
function termUrlOnSite(tagName: string, attribs: sanitizeHtml.Attributes) {
  const url = attribs["data-term-url"];
  if (url === undefined || SITE_PATH.test(url)) return { tagName, attribs };
  const { "data-term-url": _dropped, ...rest } = attribs;
  return { tagName, attribs: rest };
}

export function previewSanitise(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedStyles: { th: { "text-align": TEXT_ALIGN }, td: { "text-align": TEXT_ALIGN } },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https"] },
    allowedSchemesAppliedToAttributes: ["href", "src", "cite", "data-term-url"],
    allowProtocolRelative: true,
    disallowedTagsMode: "discard",
    transformTags: { a: termUrlOnSite },
  });
}
