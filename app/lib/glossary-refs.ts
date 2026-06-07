/**
 * This file holds the pure glossary cross-reference engine — the single
 * source of truth for the `[[term_id]]` link regex and the scan / rewrite /
 * count operations the glossary editor and the chip plugin consume. All
 * functions are pure over a `Y.Doc` (and arguments); they carry no React or
 * component state so they can be sampled headlessly in tests.
 *
 * Scan scope is the framework's three link-bearing surfaces:
 *   - story → step → layer `content` Y.Text ONLY (never layer title /
 *     button_label / step question / answer)
 *   - glossary `definition` cross-references
 *   - page `body`
 *
 * The link regex is locked to the framework's authoritative pattern in
 * `telar/scripts/telar/glossary.py`: group 1 captures the term_id, group 2
 * the optional `|display` alias. The framework `.strip()`s the captured
 * term_id, so we `.trim()` it here to match.
 *
 * Exports:
 *   - `LINK_RE` — the locked global link regex (group 1 = term_id)
 *   - `TermRef` — the per-surface reference row union
 *   - `buildTermRefIndex(ydoc)` — one-pass scan → Map<term_id, TermRef[]>
 *   - `rewriteGlossaryLinks(ydoc, oldId, newId)` — in-place rename rewrite in
 *     ONE transaction, highest-index-first; returns the occurrence count
 *   - `countGlossaryLinks(ydoc, termId)` — dry-run occurrence count, no mutation
 *
 * @version v1.3.0-beta
 */

import * as Y from "yjs";
import { getYText } from "~/lib/yjs-helpers";

/**
 * The locked glossary link regex. Group 1 = term_id, group 2 = optional
 * `|display` alias. Mirrors the pattern in `telar/scripts/telar/glossary.py`
 * exactly so the chip, scan, and rewrite never drift from the framework's
 * runtime behaviour.
 *
 * NOTE: this is a global regex and therefore stateful (`lastIndex`). Reset
 * `LINK_RE.lastIndex = 0` before each scan loop, or clone via
 * `new RegExp(LINK_RE.source, LINK_RE.flags)` for a fresh per-call matcher.
 */
export const LINK_RE = /\[\[\s*([^|\]]+?)(?:\s*\|\s*([^|\]]+?))?\s*\]\]/g;

/** A reference to a term from a story layer's `content` body. */
export interface StoryTermRef {
  kind: "story";
  termId: string;
  storyId: string;
  storyTitle: string;
  stepNumber: number;
  layerNumber: number;
}

/** A reference to a term from a page `body`. */
export interface PageTermRef {
  kind: "page";
  termId: string;
  pageSlug: string;
  pageTitle: string;
}

/** A reference to a term from another glossary term's `definition`. */
export interface GlossaryTermRef {
  kind: "glossary";
  termId: string;
  refTermId: string;
  refTermTitle: string;
}

export type TermRef = StoryTermRef | PageTermRef | GlossaryTermRef;

/** A fresh, non-shared matcher so concurrent scans never trip over lastIndex. */
function freshLinkRe(): RegExp {
  return new RegExp(LINK_RE.source, LINK_RE.flags);
}

/**
 * Read a Y.Text from a Y.Map as a string, or "" when the field is absent /
 * not a Y.Text. Uses the shared getYText idiom for the type guard.
 */
function readText(map: Y.Map<unknown>, field: string): string {
  return getYText(map, field)?.toString() ?? "";
}

/**
 * buildTermRefIndex — walk stories→steps→layers (layer `content` ONLY),
 * glossary definitions, and page bodies in ONE pass, pushing a TermRef per
 * regex match keyed by the captured (group 1, trimmed) term_id.
 *
 * Pure: reads the doc, mutates nothing. Returns a Map keyed by term_id.
 */
export function buildTermRefIndex(ydoc: Y.Doc): Map<string, TermRef[]> {
  const index = new Map<string, TermRef[]>();
  const push = (termId: string, ref: TermRef) => {
    const list = index.get(termId);
    if (list) list.push(ref);
    else index.set(termId, [ref]);
  };

  // --- stories → steps → layers (content only) ---
  const stories = ydoc.getArray<Y.Map<unknown>>("stories");
  for (let si = 0; si < stories.length; si++) {
    const story = stories.get(si);
    const storyId = String(story.get("story_id") ?? "");
    const storyTitle = readText(story, "title");
    const steps = story.get("steps");
    if (!(steps instanceof Y.Array)) continue;
    for (let ti = 0; ti < steps.length; ti++) {
      const step = steps.get(ti) as Y.Map<unknown>;
      const stepNumber = Number(step.get("step_number"));
      const layers = step.get("layers");
      if (!(layers instanceof Y.Array)) continue;
      for (let li = 0; li < layers.length; li++) {
        const layer = layers.get(li) as Y.Map<unknown>;
        const layerNumber = Number(layer.get("layer_number"));
        const content = readText(layer, "content"); // content field ONLY
        const re = freshLinkRe();
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          const termId = m[1].trim();
          push(termId, {
            kind: "story",
            termId,
            storyId,
            storyTitle,
            stepNumber,
            layerNumber,
          });
        }
      }
    }
  }

  // --- glossary definitions (cross-refs) ---
  const glossary = ydoc.getArray<Y.Map<unknown>>("glossary");
  for (let gi = 0; gi < glossary.length; gi++) {
    const term = glossary.get(gi);
    const refTermId = String(term.get("term_id") ?? "");
    const refTermTitle = readText(term, "title");
    const definition = readText(term, "definition");
    const re = freshLinkRe();
    let m: RegExpExecArray | null;
    while ((m = re.exec(definition)) !== null) {
      const termId = m[1].trim();
      push(termId, {
        kind: "glossary",
        termId,
        refTermId,
        refTermTitle,
      });
    }
  }

  // --- page bodies ---
  const pages = ydoc.getArray<Y.Map<unknown>>("pages");
  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages.get(pi);
    const pageSlug = String(page.get("slug") ?? "");
    const pageTitle = readText(page, "title");
    const body = readText(page, "body");
    const re = freshLinkRe();
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const termId = m[1].trim();
      push(termId, {
        kind: "page",
        termId,
        pageSlug,
        pageTitle,
      });
    }
  }

  return index;
}

/** A single match against one Y.Text, with the substring slice to replace. */
interface LinkMatch {
  index: number;
  length: number;
  replacement: string;
}

/**
 * Collect the matches in one Y.Text whose group-1 term_id === oldId, producing
 * a replacement string that rewrites only the term_id while preserving the
 * `|display` alias and the surrounding bracket/whitespace shape.
 */
function collectMatches(text: string, oldId: string, newId: string): LinkMatch[] {
  const out: LinkMatch[] = [];
  const re = freshLinkRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1].trim() !== oldId) continue;
    const whole = m[0];
    const display = m[2];
    // Rebuild the token: rewrite term_id (group 1), keep alias display (group 2).
    const replacement =
      display !== undefined ? `[[${newId}|${display.trim()}]]` : `[[${newId}]]`;
    out.push({ index: m.index, length: whole.length, replacement });
  }
  return out;
}

/**
 * Apply in-place delete+insert edits to a Y.Text, highest-index-first so each
 * edit's offsets stay valid as the string length changes. NEVER uses a
 * whole-string `Y.Text` set, which would destroy yCollab cursor positions.
 * Caller must invoke this inside a `ydoc.transact()`.
 */
function applyMatches(yText: Y.Text, matches: LinkMatch[]): void {
  // Sort descending by index so earlier edits don't shift later offsets.
  const ordered = [...matches].sort((a, b) => b.index - a.index);
  for (const { index, length, replacement } of ordered) {
    yText.delete(index, length);
    yText.insert(index, replacement);
  }
}

/** All layer-content / definition / body Y.Texts in the doc (full scan scope). */
function eachLinkBearingText(ydoc: Y.Doc, fn: (t: Y.Text) => void): void {
  const stories = ydoc.getArray<Y.Map<unknown>>("stories");
  for (let si = 0; si < stories.length; si++) {
    const steps = stories.get(si).get("steps");
    if (!(steps instanceof Y.Array)) continue;
    for (let ti = 0; ti < steps.length; ti++) {
      const layers = (steps.get(ti) as Y.Map<unknown>).get("layers");
      if (!(layers instanceof Y.Array)) continue;
      for (let li = 0; li < layers.length; li++) {
        const content = getYText(layers.get(li) as Y.Map<unknown>, "content");
        if (content) fn(content);
      }
    }
  }

  const glossary = ydoc.getArray<Y.Map<unknown>>("glossary");
  for (let gi = 0; gi < glossary.length; gi++) {
    const def = getYText(glossary.get(gi), "definition");
    if (def) fn(def);
  }

  const pages = ydoc.getArray<Y.Map<unknown>>("pages");
  for (let pi = 0; pi < pages.length; pi++) {
    const body = getYText(pages.get(pi), "body");
    if (body) fn(body);
  }
}

/**
 * rewriteGlossaryLinks — rename every `[[oldId]]` / `[[oldId|display]]` to
 * `[[newId]]` / `[[newId|display]]` across all three link-bearing surfaces.
 *
 * All edits run inside ONE `ydoc.transact()` so the shared Y.UndoManager
 * treats the rename as a single undoable operation. Within each Y.Text the
 * matches are applied highest-index-first so length-changing replacements
 * never corrupt later offsets. Display aliases keep their display text; only
 * the term_id (group 1) is rewritten.
 *
 * Returns the total number of occurrences rewritten across the doc.
 */
export function rewriteGlossaryLinks(
  ydoc: Y.Doc,
  oldId: string,
  newId: string,
): number {
  let total = 0;
  ydoc.transact(() => {
    eachLinkBearingText(ydoc, (yText) => {
      const matches = collectMatches(yText.toString(), oldId, newId);
      if (matches.length === 0) return;
      total += matches.length;
      applyMatches(yText, matches);
    });
  });
  return total;
}

/**
 * countGlossaryLinks — dry-run occurrence count of `[[termId]]` across the
 * three surfaces, without mutating the doc. Drives the impact-panel fire
 * condition before a rename is committed.
 */
export function countGlossaryLinks(ydoc: Y.Doc, termId: string): number {
  let total = 0;
  eachLinkBearingText(ydoc, (yText) => {
    const re = freshLinkRe();
    let m: RegExpExecArray | null;
    const text = yText.toString();
    while ((m = re.exec(text)) !== null) {
      if (m[1].trim() === termId) total++;
    }
  });
  return total;
}
