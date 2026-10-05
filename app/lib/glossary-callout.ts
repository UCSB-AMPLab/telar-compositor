/**
 * glossary-callout — the framework's glossary callout, a `:::glossary`
 * block, as the build publishes it: `parse_glossary_widget`
 * (scripts/telar/widgets.py) reads the block, and `_glossary_callout`
 * (scripts/telar/glossary.py) draws it from `_includes/widgets/glossary.html`.
 *
 *   - The block's lines are read as `parse_key_value_block` reads them: each
 *     stripped, a line holding `:` and not opening `#` is a key and a value,
 *     both stripped, the last of a repeated key winning.
 *   - `entry:` names a glossary term as `[[entry]]` does, matched without
 *     case against the kept terms; a missing or unknown entry is marked as an
 *     unknown `[[entry]]` is, with the entry decoded once more for its text.
 *   - `align:` is right (the default), left, derecha or izquierda, compared
 *     with case and accents folded away; any other value is right.
 *   - A known entry is a link carrying the inline link's class and data
 *     attributes, with the kind's id, its icon (the exclamation mark for a
 *     kind without one, a site's own kind), its label in the site's language
 *     and the entry's title, decoded once and then escaped.
 *
 * The output is HTML and must reach the page through `previewSanitise`.
 *
 * @version v1.5.0-beta
 */

import { escapeHtml, glossaryTermUrl } from "~/lib/glossary-links";
import { NO_GLOSSARY_KINDS, foldCaseAndAccents, readKind } from "~/lib/glossary-kinds";
import { findWidgets } from "~/components/ui/markdown-editor/footnoteScopes";
import { htmlUnescape } from "~/lib/html-unescape";
import { pythonStrip } from "~/lib/python-whitespace";
import type { GlossaryContext } from "~/lib/answer-preview";

export type CalloutSide = "right" | "left";

export interface GlossaryCallout {
  entry: string;
  align: CalloutSide;
}

const SIDES: Record<string, CalloutSide> = { right: "right", derecha: "right", left: "left", izquierda: "left" };

/** A `key: value` line of a block's body, with where its value stands in the body. */
interface KeyValueLine {
  key: string;
  value: string;
  from: number;
  to: number;
}

/** A block's `key: value` lines, as `parse_key_value_block` reads them. */
function keyValueLines(body: string): KeyValueLine[] {
  const lines: KeyValueLine[] = [];
  let at = 0;
  for (const raw of body.split("\n")) {
    const lineAt = at;
    at += raw.length + 1;
    const line = pythonStrip(raw);
    const colon = line.indexOf(":");
    if (colon === -1 || line.startsWith("#")) continue;
    const value = pythonStrip(line.slice(colon + 1));
    const from = lineAt + raw.indexOf(line) + (value ? line.indexOf(value, colon + 1) : line.length);
    lines.push({ key: pythonStrip(line.slice(0, colon)), value, from, to: from + value.length });
  }
  return lines;
}

/** A block's `key: value` pairs, the last of a repeated key winning. */
function keyValues(body: string): Map<string, string> {
  return new Map(keyValueLines(body).map((line) => [line.key, line.value]));
}

/**
 * The entry each `:::glossary` block in `text` names, with where the id
 * stands in `text`; a block with no entry names none.
 */
export function glossaryCalloutEntries(text: string): Array<{ id: string; from: number; to: number }> {
  const entries: Array<{ id: string; from: number; to: number }> = [];
  for (const block of findWidgets(text)) {
    if (block.type !== "glossary") continue;
    const line = keyValueLines(text.slice(block.bodyFrom, block.bodyTo)).filter((l) => l.key === "entry").pop();
    if (line?.value) entries.push({ id: line.value, from: block.bodyFrom + line.from, to: block.bodyFrom + line.to });
  }
  return entries;
}

/** The entry and side a `:::glossary` block's body names. */
export function parseGlossaryCallout(body: string): GlossaryCallout {
  const data = keyValues(body);
  const align = data.get("align") ?? "";
  return { entry: data.get("entry") ?? "", align: (align && SIDES[foldCaseAndAccents(align)]) || "right" };
}

/** Each icon of the template, its elements closed explicitly so a parser outside SVG reads them alike. */
const ICONS: Record<string, string> = {
  document:
    '<path d="M6.5 2.75h7.25l4 4V21.25H6.5z"></path><path d="M13.75 2.75v4h4"></path><path d="M9.25 12.25h5.5M9.25 15.75h5.5"></path>',
  bookmark: '<path d="M6.75 3.25h10.5v17.5L12 16.75l-5.25 4z"></path>',
  person: '<circle cx="12" cy="8" r="3.75"></circle><path d="M4.75 20.5c.6-3.9 3.6-6 7.25-6s6.65 2.1 7.25 6"></path>',
  pin: '<path d="M12 21.25s-6.25-6-6.25-11a6.25 6.25 0 0 1 12.5 0c0 5-6.25 11-6.25 11z"></path><circle cx="12" cy="10.25" r="2.25"></circle>',
  alert:
    '<circle cx="12" cy="12" r="8.75"></circle><path d="M12 7.5v5.5"></path><circle cx="12" cy="16.5" r=".6" fill="currentColor"></circle>',
};

const SVG =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
const ARROW = `<svg class="glossary-callout-arrow" ${SVG}><path d="M9 5.5l6.5 6.5L9 18.5"></path></svg>`;

/** The marker of an entry the glossary lacks, as `_missing_entry` writes it. */
function missingEntry(termId: string): string {
  return `<span class="glossary-link-error" data-term-id="${escapeHtml(termId)}">⚠️ [[${escapeHtml(htmlUnescape(termId))}]]</span>`;
}

/** The kind id, icon and label of a term, as the site's kinds give them. */
function kindOf(termId: string, glossary: GlossaryContext): { id: string; icon?: string; label: string } {
  const kinds = glossary.kinds ?? NO_GLOSSARY_KINDS;
  const option = readKind(kinds, glossary.entryKinds?.get(termId) ?? "");
  return option ?? { id: kinds.defaultId, label: "" };
}

/**
 * The callout a block stands for as one line of HTML, `linked`, or the
 * missing-entry marker.
 */
export function glossaryCalloutHtml({ entry, align }: GlossaryCallout, glossary: GlossaryContext): { html: string; linked: boolean } {
  const written = pythonStrip(entry);
  const lower = written.toLowerCase();
  const termId = [...glossary.terms.keys()].find((id) => id.toLowerCase() === lower);
  if (termId === undefined) return { html: missingEntry(written), linked: false };
  const kind = kindOf(termId, glossary);
  const demo = termId.startsWith("demo-") ? ' data-demo="true"' : "";
  const url = glossaryTermUrl(termId, glossary.baseUrl);
  const icon = ICONS[kind.icon ?? ""] ?? ICONS.alert;
  const title = escapeHtml(htmlUnescape(glossary.terms.get(termId)!));
  const html = [
    `<a href="#" class="glossary-inline-link glossary-callout glossary-callout--${align}" data-term-id="${escapeHtml(termId)}"` +
      ` data-term-url="${escapeHtml(url)}" data-glossary-kind="${escapeHtml(kind.id)}"${demo}>`,
    `<svg class="glossary-callout-icon" ${SVG}>${icon}</svg>`,
    '<span class="glossary-callout-text">',
    `<span class="glossary-callout-kind">${escapeHtml(kind.label)}</span>`,
    `<span class="glossary-callout-title">${title}</span>`,
    "</span>",
    ARROW,
    "</a>",
  ].join(" ");
  return { html, linked: true };
}
