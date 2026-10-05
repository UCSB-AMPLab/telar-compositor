/**
 * GlossaryPreviewPane — the "How readers see this" live reader preview.
 *
 * A ~320×200 panel to the right of the definition editor that renders the
 * selected term's definition roughly as it will appear on the published site:
 *
 *   - Subscribes to the term's `definition` Y.Text via `observe` and re-renders
 *     LIVE as the author types — NO debounce, so the preview tracks keystrokes.
 *   - Renders the markdown to HTML through `marked`, then resolves
 *     `[[term]]` references in the HTML as the framework's glossary pages do
 *     (Markdown first, then `process_glossary_links`) through the shared
 *     resolver in `~/lib/glossary-links`: case-insensitive, the anchor the
 *     site publishes, and `⚠️ [[term]]` for a term the glossary lacks. The
 *     result ALWAYS goes through `previewSanitise` before it reaches
 *     `dangerouslySetInnerHTML`, never raw user markdown.
 *   - A resolved link's `href` is `#` and its `data-term-url` belongs to the
 *     published site, so a click on one does nothing here: the preview is
 *     on the Compositor's origin, not the site's.
 *   - Theme-aware: `resolvePreviewTokens(theme)` supplies bg / text / link /
 *     heading + body fonts as inline style; an unknown / null theme falls back
 *     to the neutral cream / charcoal set. The active theme's web font is
 *     loaded on demand through `themeFontHref`.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useMemo, useState, useId } from "react";
import { marked } from "marked";
import * as Y from "yjs";
import { useTranslation } from "react-i18next";
import { previewSanitise } from "~/lib/preview-sanitise";
import { resolvePreviewTokens } from "~/lib/theme-tokens";
import { themeFontHref } from "~/lib/theme-fonts";
import { glossaryTermsFromDoc, holdGlossaryLinks, resolveGlossaryLinks } from "~/lib/glossary-links";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { StableHtml } from "~/components/ui/StableHtml";

interface GlossaryPreviewPaneProps {
  /** The selected term's Y.Map (its `definition` Y.Text is observed live). */
  yMap: Y.Map<unknown>;
  /** The project's published theme_id, or null → neutral fallback. */
  theme: string | null | undefined;
  /** Bumped on any glossary doc change — keeps the resolution map fresh. */
  termVersion: number;
  /** The selected term's title, shown as the preview heading. */
  titleLabel: string;
  /** What the site shows above the title for the entry's kind; none where the site has no kinds. */
  kindLabel?: string;
  className?: string;
}


export function GlossaryPreviewPane({
  yMap,
  theme,
  termVersion,
  titleLabel,
  kindLabel,
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

  // The terms the site would link, refreshed on any glossary change.
  const terms = useMemo(
    () => glossaryTermsFromDoc(ydoc),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ydoc, termVersion],
  );

  // Markdown, then glossary links, then the sanitiser. The baseurl is left
  // empty: the link's address is the site's, and nothing here follows it.
  const html = useMemo(() => {
    const parsed = marked.parse(definition, { async: false, gfm: true }) as string;
    return previewSanitise(resolveGlossaryLinks(parsed, terms, ""));
  }, [definition, terms]);

  const fontHref = themeFontHref(theme);

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
      {/* Scoped style: theme link colour for glossary links + headings. */}
      <style>{`
        .${scopeClass} { color: ${tokens.text}; font-family: ${tokens.bodyFont}; }
        .${scopeClass} h1, .${scopeClass} h2, .${scopeClass} h3,
        .${scopeClass} h4, .${scopeClass} h5, .${scopeClass} h6 { font-family: ${tokens.headingFont}; }
        .${scopeClass} a { color: ${tokens.link}; }
        .${scopeClass} .glossary-inline-link { text-decoration: underline; cursor: default; }
      `}</style>
      <div
        className="rounded-md border border-gray-200 overflow-y-auto p-4 text-sm leading-relaxed"
        style={{ background: tokens.bg, minHeight: 200, maxHeight: 320 }}
      >
        <div className={`${scopeClass} prose-sm`}>
          {kindLabel && <p className="text-xs uppercase tracking-wider opacity-70 mb-1">{kindLabel}</p>}
          <p
            className="font-semibold mb-2"
            style={{ fontFamily: tokens.headingFont }}
          >
            {titleLabel}
          </p>
          {/* Sanitised markdown — previewSanitise output ONLY. */}
          <StableHtml onClick={holdGlossaryLinks} html={html} />
        </div>
      </div>
    </aside>
  );
}
