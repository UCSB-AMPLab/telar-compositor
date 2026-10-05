/**
 * PanelRendering — a layer panel's content as a reader of the site is shown
 * it (`renderPanel`, card-markdown.ts), on the framing stage.
 *
 * Each rendering is one generation, keyed by the text, the glossary, the
 * site's preview configuration and where images are read from. A generation
 * sets its sanitised HTML into an element of its own, which React treats as
 * opaque. Once that element is in the page, each `data-panel-widget` marker
 * in it is filled through a portal: `WidgetPreview` for a widget the
 * framework knows, its source with `panel.shownAsWritten` for one it does
 * not. A new generation replaces the element and retires every portal with
 * it, so widgets are drawn again even when an edit changed only a widget and
 * the surrounding HTML is the same.
 *
 * Formulas are typeset by KaTeX in the generation's own HTML only, never in
 * a widget's, which typesets itself: the markers are left out of the run. A
 * run that finishes loading KaTeX after its generation has been replaced
 * does nothing. Typesetting cannot be undone, so a change of delimiters or
 * of whether the preview is available is a new generation, whose HTML is
 * set afresh before it is typeset.
 *
 * Image addresses are read from the site's origin, in the HTML and in every
 * piece of Markdown a widget renders; a carousel locates its own images.
 *
 * The links in the generation's own HTML are marked `data-prose-link`: a
 * covered panel keeps its text and those links in view (visitor-layer.css).
 *
 * `onRendered` is told of each generation once its widgets are in place, with
 * the element holding it.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { WidgetPreview } from "~/components/ui/markdown-editor/WidgetPreview";
import {
  renderPanel,
  typesetPreview,
  widgetImages,
  type GlossaryContext,
  type RenderedPanel,
} from "~/lib/card-markdown";
import { resolveGlossaryLinks } from "~/lib/glossary-links";
import type { PanelPreviewConfig } from "~/lib/panel-preview-config";

/** The class a widget's marker takes, which KaTeX's run over the HTML leaves alone. */
export const WIDGET_SLOT = "panel-widget-slot";

export interface PanelGeneration extends RenderedPanel {
  generation: number;
}

let generations = 0;

/** The site's origin and baseurl, from its configured address. */
export function siteAddress(siteBaseUrl: string | null | undefined): { origin: string | undefined; baseUrl: string } {
  if (!siteBaseUrl) return { origin: undefined, baseUrl: "" };
  try {
    const url = new URL(siteBaseUrl);
    return { origin: url.origin, baseUrl: url.pathname.replace(/\/$/, "") };
  } catch {
    return { origin: undefined, baseUrl: "" };
  }
}

/** A panel's rendering for one text and one configuration. */
export function usePanelGeneration({
  value,
  anchor,
  glossary,
  config,
  siteBaseUrl,
}: {
  value: string;
  anchor: string;
  glossary: GlossaryContext;
  config: PanelPreviewConfig | undefined;
  siteBaseUrl: string | null | undefined;
}): PanelGeneration {
  const { t } = useTranslation("editor");
  const unavailable = t("panel.shownAsWritten");
  const configKey = JSON.stringify(config ?? null);
  return useMemo(() => {
    const { origin, baseUrl } = siteAddress(siteBaseUrl);
    generations += 1;
    return { ...renderPanel(value, { glossary, baseUrl, anchor, unavailable, origin }), generation: generations };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, anchor, glossary, configKey, siteBaseUrl, unavailable]);
}

function ShownAsWritten({ source }: { source: string }) {
  const { t } = useTranslation("editor");
  return (
    <div className="cm-panel-unavailable">
      <p>{t("panel.shownAsWritten")}</p>
      <pre>{source}</pre>
    </div>
  );
}

export function PanelRendering({
  rendered,
  glossary,
  config,
  siteBaseUrl,
  onRendered,
}: {
  rendered: PanelGeneration;
  glossary: GlossaryContext;
  config: PanelPreviewConfig | undefined;
  siteBaseUrl: string | null | undefined;
  onRendered?: (generation: number, element: HTMLElement) => void;
}) {
  const prose = useRef<HTMLDivElement | null>(null);
  const [slots, setSlots] = useState<{ generation: number; elements: HTMLElement[] }>({ generation: 0, elements: [] });
  const current = useRef(rendered.generation);
  current.current = rendered.generation;
  const { generation } = rendered;

  useLayoutEffect(() => {
    const element = prose.current;
    if (!element) return;
    element.querySelectorAll("a").forEach((link) => link.setAttribute("data-prose-link", ""));
    const elements = [...element.querySelectorAll<HTMLElement>("[data-panel-widget]")];
    elements.forEach((slot) => slot.classList.add(WIDGET_SLOT));
    setSlots({ generation, elements });
  }, [generation]);

  const placed = slots.generation === generation;
  // One object per generation: React sets the HTML again whenever it is
  // given a new one, which would drop the widgets drawn into it.
  const html = useMemo(() => ({ __html: rendered.html }), [rendered.html]);

  useEffect(() => {
    const element = prose.current;
    if (!placed || !element) return;
    onRendered?.(generation, element);
    if (!config?.available) return;
    typesetPreview(element, config.delimiters, {
      ignoredClasses: [WIDGET_SLOT],
      current: () => current.current === generation && element.isConnected,
    }).catch(() => {
      // Formulas stay as source if KaTeX cannot load.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed, generation]);

  const links = useMemo(
    () => (html: string) => resolveGlossaryLinks(html, glossary.terms, glossary.baseUrl),
    [glossary],
  );
  const images = useMemo(() => {
    const { origin, baseUrl } = siteAddress(siteBaseUrl);
    return widgetImages(baseUrl, origin);
  }, [siteBaseUrl]);

  return (
    <>
      <div key={generation} ref={prose} data-panel-prose="" dangerouslySetInnerHTML={html} />
      {placed &&
        slots.elements.map((slot) => {
          const n = Number(slot.dataset.panelWidget);
          const part = rendered.widgets[n];
          if (!part) return null;
          return createPortal(
            part.block ? (
              <WidgetPreview block={part.block} siteBaseUrl={siteBaseUrl} preview={config} links={links} images={images} />
            ) : (
              <ShownAsWritten source={part.source} />
            ),
            slot,
            `${generation}-${n}`,
          );
        })}
    </>
  );
}
