/**
 * GlossaryPreviewPane — the "How readers see this" live reader preview.
 *
 * A ~320×200 panel to the right of the definition editor that renders the
 * selected term's definition roughly as it will appear on the published site:
 *
 *   - Subscribes to the term's `definition` Y.Text via `observe` and re-renders
 *     LIVE as the author types — NO debounce, so the preview tracks keystrokes.
 *   - Renders the markdown to HTML through `marked` and ALWAYS routes it through
 *     the Workers-compatible `sanitiseHtml` before it reaches
 *     `dangerouslySetInnerHTML` — never raw user markdown.
 *     `[[other-term]]` references resolve to the target's
 *     TITLE, styled with the theme link colour.
 *   - Theme-aware: `resolvePreviewTokens(theme)` supplies bg / text / link /
 *     heading + body fonts as inline style; an unknown / null theme falls back
 *     to the neutral cream / charcoal set. The active non-Trama theme's web font
 *     is loaded on demand via a `<link rel="stylesheet">` (Google Fonts already
 *     used by the framework themes — not an npm install).
 *
 * @version v1.3.0-beta
 */

import { useEffect, useMemo, useState, useId } from "react";
import { marked } from "marked";
import * as Y from "yjs";
import { useTranslation } from "react-i18next";
import { sanitiseHtml } from "~/lib/sanitise-html";
import { resolvePreviewTokens } from "~/lib/theme-tokens";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { LINK_RE } from "~/lib/glossary-refs";

interface GlossaryPreviewPaneProps {
  /** The selected term's Y.Map (its `definition` Y.Text is observed live). */
  yMap: Y.Map<unknown>;
  /** The project's published theme_id, or null → neutral fallback. */
  theme: string | null | undefined;
  /** Bumped on any glossary doc change — keeps the resolution map fresh. */
  termVersion: number;
  /** The selected term's title, shown as the preview heading. */
  titleLabel: string;
  className?: string;
}

/**
 * Google Fonts stylesheet hrefs for the non-Trama themes, keyed by theme_id.
 * Trama's fonts (Space Grotesk / Roboto Condensed) are already loaded by the
 * app shell, so it needs no on-demand <link>.
 */
const THEME_FONT_HREFS: Record<string, string> = {
  austin:
    "https://fonts.googleapis.com/css2?family=Crimson+Pro:wght@400;600&family=Inter:wght@400;500&display=swap",
  neogranadina:
    "https://fonts.googleapis.com/css2?family=IM+Fell+DW+Pica&family=Mulish:wght@400;500&display=swap",
  paisajes:
    "https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600&family=Source+Sans+Pro:wght@400;600&display=swap",
  "santa-barbara":
    "https://fonts.googleapis.com/css2?family=Roboto+Serif:wght@400;600&family=Nunito+Sans:wght@400;600&display=swap",
};

/** Build a term_id → title map from the glossary Y.Array for [[ref]] resolution. */
function buildTitleMap(ydoc: Y.Doc | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!ydoc) return map;
  const glossary = ydoc.getArray<Y.Map<unknown>>("glossary");
  for (let i = 0; i < glossary.length; i++) {
    const term = glossary.get(i);
    const termId = term.get("term_id");
    if (typeof termId !== "string") continue;
    const rawTitle = term.get("title");
    const title =
      rawTitle instanceof Y.Text
        ? rawTitle.toString()
        : typeof rawTitle === "string"
          ? rawTitle
          : "";
    map.set(termId, title || termId);
  }
  return map;
}

/**
 * Replace `[[term]]` / `[[term|display]]` tokens with the resolved title (or
 * the display alias when present) wrapped in an anchor carrying a stable class.
 * The class is styled via a scoped <style> using the theme link colour. The
 * title text is escaped so it can never inject markup before sanitisation.
 */
function resolveGlossaryRefs(markdown: string, titleMap: Map<string, string>): string {
  const re = new RegExp(LINK_RE.source, LINK_RE.flags);
  return markdown.replace(re, (_whole, rawId: string, display?: string) => {
    const termId = rawId.trim();
    const label = (display?.trim() || titleMap.get(termId) || termId).replace(
      /[<>&]/g,
      (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;"),
    );
    return `<a class="gloss-preview-ref">${label}</a>`;
  });
}

export function GlossaryPreviewPane({
  yMap,
  theme,
  termVersion,
  titleLabel,
  className = "",
}: GlossaryPreviewPaneProps) {
  const { t } = useTranslation("glossary");
  const { ydoc } = useCollaborationContext();
  const scopeId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const scopeClass = `gloss-preview-${scopeId}`;

  const tokens = useMemo(() => resolvePreviewTokens(theme), [theme]);

  // Live definition text — re-render on every Y.Text change (no debounce).
  const [definition, setDefinition] = useState<string>(() => {
    const raw = yMap.get("definition");
    return raw instanceof Y.Text ? raw.toString() : typeof raw === "string" ? raw : "";
  });

  useEffect(() => {
    const raw = yMap.get("definition");
    if (!(raw instanceof Y.Text)) {
      setDefinition(typeof raw === "string" ? raw : "");
      return;
    }
    const sync = () => setDefinition(raw.toString());
    sync();
    raw.observe(sync);
    return () => raw.unobserve(sync);
  }, [yMap]);

  // term_id → title map for [[ref]] resolution (refresh on doc change).
  const titleMap = useMemo(
    () => buildTitleMap(ydoc),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ydoc, termVersion],
  );

  // Render markdown → HTML, always through the sanitiser.
  const html = useMemo(() => {
    const withRefs = resolveGlossaryRefs(definition, titleMap);
    const parsed = marked.parse(withRefs, { async: false, gfm: true }) as string;
    return sanitiseHtml(parsed);
  }, [definition, titleMap]);

  // Load the active non-Trama theme's web font on demand.
  const fontHref = theme ? THEME_FONT_HREFS[theme] : undefined;

  return (
    <aside
      className={`flex flex-col ${className}`}
      style={{ width: 320 }}
      aria-label={t("preview")}
    >
      <h3 className="font-heading text-xs font-semibold text-fg-muted uppercase tracking-wider mb-2">
        {t("preview")}
      </h3>
      {fontHref && <link rel="stylesheet" href={fontHref} />}
      {/* Scoped style: theme link colour for resolved [[refs]] + headings. */}
      <style>{`
        .${scopeClass} { color: ${tokens.text}; font-family: ${tokens.bodyFont}; }
        .${scopeClass} h1, .${scopeClass} h2, .${scopeClass} h3,
        .${scopeClass} h4, .${scopeClass} h5, .${scopeClass} h6 { font-family: ${tokens.headingFont}; }
        .${scopeClass} a, .${scopeClass} .gloss-preview-ref { color: ${tokens.link}; }
        .${scopeClass} .gloss-preview-ref { text-decoration: underline; cursor: default; }
      `}</style>
      <div
        className="rounded-md border border-gray-200 overflow-y-auto p-4 text-sm leading-relaxed"
        style={{ background: tokens.bg, minHeight: 200, maxHeight: 320 }}
      >
        <div className={`${scopeClass} prose-sm`}>
          <p
            className="font-semibold mb-2"
            style={{ fontFamily: tokens.headingFont }}
          >
            {titleLabel}
          </p>
          {/* Sanitised markdown — sanitiseHtml output ONLY. */}
          <div dangerouslySetInnerHTML={{ __html: html }} />
        </div>
      </div>
    </aside>
  );
}
