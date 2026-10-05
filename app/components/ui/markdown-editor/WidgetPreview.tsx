/**
 * Widget previews mirror Telar's Jinja templates and initial interaction state.
 * IDs belong to each mounted preview, so multiple panels can contain tabs and
 * accordions without sharing ARIA targets. Author text is sanitised separately.
 *
 * A carousel resolves its images as framework 1.8.0 publishes them
 * (`parse_carousel_widget` and `locate_image`, scripts/telar/widgets.py and
 * images.py): a value starting with `http://` or `https://` is used as
 * written; a value with a folder in it is read from the site root, then from
 * `assets/images/` and `telar-content/objects/`, as Python's `Path` reads it;
 * a bare file name is looked for in `assets/images/` and then
 * `telar-content/objects/`. The framework picks the file on disk at build
 * time. The preview cannot list the site's files, so it loads each candidate
 * address from the published site in the framework's order, letter-case
 * variants included, and shows the first that loads; when none does, it shows
 * the address the site points at. An item without an image is skipped. The
 * size class comes from the tallest image whose size is known, from declared
 * whole-number dimensions or from the loaded image, and is `default` when none
 * is.
 *
 * Formulas are typeset only once the site's preview configuration has
 * arrived and is usable.
 *
 * `links`, when given, is the glossary pass the framework runs over the
 * published panel, applied to every section, entry, note, caption and credit,
 * and to accordion and tab titles. A title is the `## ` line's text stripped
 * (`parse_markdown_sections`), escaped as the Jinja template escapes it, and
 * then passed through the glossary, so a `[[term]]` in it is a link and any
 * other markup in it is text. A click on a title never follows a link in it.
 *
 * `images`, when given, rewrites the image addresses of every piece of
 * Markdown the preview renders (sections, entries, notes, captions and
 * credits), after the glossary pass: the framing stage reads them from the
 * site's origin. A carousel's own images are located as above and are not
 * passed through it.
 *
 * @version v1.5.0-beta
 */
import { useId, useRef, useState, useEffect, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { previewSanitise } from "~/lib/preview-sanitise";
import { StableHtml } from "~/components/ui/StableHtml";
import { pythonStrip } from "~/lib/python-whitespace";
import type { PanelPreviewConfig } from "~/lib/panel-preview-config";
import { renderPanelMath } from "./panelMath";
import type { PanelSection, PanelWidget } from "./panelSource";
import { panelMarkdown, panelCaption, type HtmlTransform } from "./panelPreview";

/** A section or entry, one footnote conversion; `anchor` keeps its note anchors apart. */
const html = (source: string, anchor: string, written: string, links?: HtmlTransform) =>
  panelMarkdown(source, anchor, written, links);

/** What every widget kind is drawn from. */
interface WidgetProps {
  block: PanelWidget;
  id: string;
  links?: HtmlTransform;
}

/** The notice for a part shown as written because it cannot be previewed. */
function useShownAsWritten(): string {
  const { t } = useTranslation("editor");
  return t("panel.shownAsWritten");
}
/** A carousel field's value as the framework reads it, stripped; "" when absent. */
const fieldText = (section: PanelSection, key: string) => section.fields?.[key]?.value.trim() ?? "";
const bodyOf = (section: PanelSection) => section.body?.value ?? "";
const JINJA_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&#34;", "'": "&#39;" };

/** A section title as the site publishes it: escaped by the template, then the glossary pass. */
function titleHtml(section: PanelSection, links?: HtmlTransform) {
  const escaped = pythonStrip(section.title?.value ?? "").replace(/[&<>"']/g, (c) => JINJA_ESCAPES[c]);
  return previewSanitise(links ? links(escaped) : escaped);
}

const BARE_IMAGE_FOLDERS = ["assets/images", "telar-content/objects"];

/** The paths `_find_file` tries under `folder`, in its order: exact, lower-case name, all lower case, then the extension in each case. */
function caseVariants(folder: string, path: string): string[] {
  const join = (p: string) => (folder ? `${folder}/${p}` : p);
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  const stem = path.slice(0, slash + 1 + (dot > 0 ? dot : name.length));
  const ext = dot > 0 ? name.slice(dot) : "";
  const variants = [path, path.slice(0, slash + 1) + name.toLowerCase(), path.toLowerCase()];
  if (ext) variants.push(stem + ext.toUpperCase(), stem + ext.toLowerCase());
  return variants.map(join);
}

/** A relative path as Python's `Path` reads it: no empty or `.` segments, so no doubled or trailing slash. */
const pathlibPath = (path: string) => path.split("/").filter((part) => part && part !== ".").join("/");

/** The site's baseurl, the path of its address with no trailing slash. */
function sitePath(site: string): string {
  try {
    return new URL(site).pathname.replace(/\/$/, "");
  } catch {
    return site.startsWith("/") ? site : "";
  }
}

/**
 * Where a carousel image may be, and where the site points when it is nowhere.
 * `candidates` are the addresses in the order `locate_image` looks for the
 * file, each read as `Path` reads it; `fallback` is the address the site
 * publishes when no file is found, which `locate_image` writes as given for a
 * value with a folder in it. Null when the site's address is unknown.
 */
export function carouselImageSources(
  image: string,
  siteBaseUrl?: string | null,
): { candidates: string[]; fallback: string } | null {
  if (image.startsWith("http://") || image.startsWith("https://")) return { candidates: [image], fallback: image };
  if (!siteBaseUrl) return null;
  const site = siteBaseUrl.replace(/\/$/, "");
  const at = (path: string) => `${site}/${path}`;
  if (!image.includes("/")) {
    const paths = BARE_IMAGE_FOLDERS.flatMap((folder) => caseVariants(folder, image));
    return { candidates: [...new Set(paths)].map(at), fallback: at(`${BARE_IMAGE_FOLDERS[0]}/${image}`) };
  }
  const relative = image.replace(/^\/+/, "");
  const baseurl = sitePath(site);
  const withoutBase =
    baseurl && image.startsWith(`${baseurl}/`) ? pathlibPath(image.slice(baseurl.length)) : null;
  const found = pathlibPath(relative);
  const paths = [
    ...caseVariants("", found),
    ...(withoutBase !== null ? caseVariants("", withoutBase) : []),
    ...BARE_IMAGE_FOLDERS.flatMap((folder) => caseVariants(folder, found)),
  ];
  return { candidates: [...new Set(paths)].map(at), fallback: at(relative) };
}

/** The addresses the preview tries in turn: each candidate, then the published fallback. */
function carouselImageAttempts(image: string, siteBaseUrl?: string | null): string[] {
  const sources = carouselImageSources(image, siteBaseUrl);
  if (!sources) return [];
  const { candidates, fallback } = sources;
  return candidates.at(-1) === fallback ? candidates : [...candidates, fallback];
}

/** Declared width and height as the framework reads them: positive whole numbers. */
function declaredRatio(section: PanelSection): number | null {
  const [width, height] = [fieldText(section, "width"), fieldText(section, "height")];
  const whole = /^[+-]?\d+$/;
  if (!whole.test(width) || !whole.test(height)) return null;
  const [w, h] = [Number(width), Number(height)];
  return w > 0 && h > 0 ? h / w : null;
}

export function carouselSizeClass(ratios: Array<number | null>): string {
  const known = ratios.filter((r): r is number => r !== null);
  if (!known.length) return "default";
  const tallest = Math.max(...known);
  if (tallest < 0.6) return "compact";
  if (tallest < 1) return "default";
  return tallest < 1.5 ? "tall" : "portrait";
}

function useMath(root: RefObject<HTMLDivElement | null>, block: PanelWidget, preview?: PanelPreviewConfig) {
  useEffect(() => {
    if (root.current && preview?.available) renderPanelMath(root.current, preview.delimiters).catch(() => {});
  }, [block, preview]);
}

function Bibliography({ block, id, links }: WidgetProps) {
  const written = useShownAsWritten();
  return (
    <>
      {block.sections.map((section, i) => (
        <StableHtml key={i} className="telar-bib-entry" html={html(bodyOf(section), `${id}-${i}`, written, links)} />
      ))}
    </>
  );
}

function Accordion({ block, id, links }: WidgetProps) {
  const written = useShownAsWritten();
  const [expanded, setExpanded] = useState(-1);
  return (
    <div className="accordion" id={`accordion-${id}`}>
      {block.sections.map((section, i) => (
        <div key={i} className="accordion-item">
          <h3 className="accordion-header" id={`heading-${id}-${i}`}>
            <StableHtml
              as="button"
              type="button"
              className={`accordion-button ${expanded !== i ? "collapsed" : ""}`}
              aria-expanded={expanded === i}
              aria-controls={`collapse-${id}-${i}`}
              onClick={(event) => {
                event.preventDefault();
                setExpanded(expanded === i ? -1 : i);
              }}
              html={titleHtml(section, links)}
            />
          </h3>
          <div
            id={`collapse-${id}-${i}`}
            className={`accordion-collapse collapse ${expanded === i ? "show" : ""}`}
            hidden={expanded !== i}
            aria-labelledby={`heading-${id}-${i}`}
          >
            <StableHtml className="accordion-body" html={html(bodyOf(section), `${id}-${i}`, written, links)} />
          </div>
        </div>
      ))}
    </div>
  );
}

const TAB_KEYS: Record<string, (i: number, n: number) => number> = {
  ArrowRight: (i, n) => (i + 1) % n,
  ArrowLeft: (i, n) => (i - 1 + n) % n,
  Home: () => 0,
  End: (_i, n) => n - 1,
};

function Tabs({ block, id, links }: WidgetProps) {
  const written = useShownAsWritten();
  const [active, setActive] = useState(0);
  const count = block.sections.length;
  const index = Math.min(active, Math.max(0, count - 1));
  const moveTabFocus = (event: React.KeyboardEvent<HTMLElement>, i: number) => {
    const move = TAB_KEYS[event.key];
    if (!move) return;
    event.preventDefault();
    const next = move(i, count);
    setActive(next);
    event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [next]?.focus();
  };
  return (
    <>
      <ul className="nav nav-tabs" role="tablist">
        {block.sections.map((section, i) => (
          <li key={i} className="nav-item" role="presentation">
            <StableHtml
              as="button"
              type="button"
              role="tab"
              id={`tab-${id}-${i}-tab`}
              aria-selected={index === i}
              aria-controls={`tab-${id}-${i}`}
              tabIndex={index === i ? 0 : -1}
              className={`nav-link ${index === i ? "active" : ""}`}
              onClick={(event) => {
                event.preventDefault();
                setActive(i);
              }}
              onKeyDown={(event) => moveTabFocus(event, i)}
              html={titleHtml(section, links)}
            />
          </li>
        ))}
      </ul>
      <div className="tab-content">
        {block.sections.map((section, i) => (
          <div
            key={i}
            className={`tab-pane fade ${index === i ? "show active" : ""}`}
            hidden={index !== i}
            id={`tab-${id}-${i}`}
            role="tabpanel"
            aria-labelledby={`tab-${id}-${i}-tab`}
          >
            <StableHtml className="tab-pane-content" html={html(bodyOf(section), `${id}-${i}`, written, links)} />
          </div>
        ))}
      </div>
    </>
  );
}

function CarouselCaption({ caption, credit, links }: { caption: string; credit: string; links?: HtmlTransform }) {
  const written = useShownAsWritten();
  if (!caption && !credit) return null;
  return (
    <div className="carousel-caption-below">
      {caption && <StableHtml as="p" className="caption-text" html={panelCaption(caption, written, links)} />}
      {credit && (
        <p className="caption-credit">
          <StableHtml as="small" html={panelCaption(credit, written, links)} />
        </p>
      )}
    </div>
  );
}

function CarouselItem({
  section,
  active,
  siteBaseUrl,
  onRatio,
  links,
}: {
  section: PanelSection;
  active: boolean;
  siteBaseUrl?: string | null;
  onRatio: (image: string, ratio: number) => void;
  links?: HtmlTransform;
}) {
  const image = fieldText(section, "image");
  const candidates = carouselImageAttempts(image, siteBaseUrl);
  const [tried, setTried] = useState({ image, index: 0 });
  if (tried.image !== image) setTried({ image, index: 0 });
  const index = tried.image === image ? tried.index : 0;
  const src = candidates[index];
  const caption = fieldText(section, "caption");
  const credit = fieldText(section, "credit");
  return (
    <div className={`carousel-item ${active ? "active" : ""}`} hidden={!active}>
      <div className="carousel-image-container">
        {src && (
          <img
            className="d-block carousel-image"
            src={src}
            alt={fieldText(section, "alt")}
            onError={() => {
              if (index + 1 < candidates.length) setTried({ image, index: index + 1 });
            }}
            onLoad={(event) => {
              const img = event.currentTarget;
              if (img.naturalWidth && img.naturalHeight) onRatio(image, img.naturalHeight / img.naturalWidth);
            }}
          />
        )}
      </div>
      <CarouselCaption caption={caption} credit={credit} links={links} />
    </div>
  );
}

/**
 * A horizontal swipe moves the carousel. The click a browser may send after
 * the swipe is the swipe's, not a click on the carousel, and goes no further.
 */
function useSwipe(go: (offset: number) => void) {
  const start = useRef<number | null>(null);
  const swipedAt = useRef<number | null>(null);
  return {
    onTouchStart: (e: React.TouchEvent) => {
      start.current = e.touches[0]?.clientX ?? null;
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const end = e.changedTouches[0]?.clientX;
      if (start.current !== null && end !== undefined && Math.abs(end - start.current) > 40) {
        go(end < start.current ? 1 : -1);
        swipedAt.current = Date.now();
      }
      start.current = null;
    },
    onClickCapture: (e: React.MouseEvent) => {
      const at = swipedAt.current;
      swipedAt.current = null;
      if (at === null || Date.now() - at > 600) return;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

function Carousel({ block, siteBaseUrl, links }: { block: PanelWidget; siteBaseUrl?: string | null; links?: HtmlTransform }) {
  const { t } = useTranslation("editor");
  const [active, setActive] = useState(0);
  const [measured, setMeasured] = useState<Record<string, number>>({});
  const items = block.sections.filter((s) => s.fields?.image);
  const index = Math.min(active, Math.max(0, items.length - 1));
  const go = (offset: number) => setActive((index + offset + items.length) % items.length);
  const swipe = useSwipe(go);
  const size = carouselSizeClass(
    items.map((s) => declaredRatio(s) ?? measured[fieldText(s, "image")] ?? null),
  );
  const onRatio = (image: string, ratio: number) => setMeasured((m) => ({ ...m, [image]: ratio }));
  return (
    <div className={`carousel slide carousel-size-${size}`} {...swipe}>
      <div className="carousel-indicators">
        {items.map((_, i) => (
          <button
            type="button"
            key={i}
            aria-label={`${i + 1}`}
            aria-current={index === i ? "true" : undefined}
            className={index === i ? "active" : ""}
            onClick={() => setActive(i)}
          />
        ))}
      </div>
      <div className="carousel-inner">
        {items.map((section, i) => (
          <CarouselItem key={i} section={section} active={index === i} siteBaseUrl={siteBaseUrl} onRatio={onRatio} links={links} />
        ))}
      </div>
      <button type="button" className="carousel-control-prev" aria-label={t("panel.previous")} onClick={() => go(-1)}>
        <span className="carousel-control-prev-icon" aria-hidden="true" />
      </button>
      <button type="button" className="carousel-control-next" aria-label={t("panel.next")} onClick={() => go(1)}>
        <span className="carousel-control-next-icon" aria-hidden="true" />
      </button>
    </div>
  );
}

/** The glossary pass and then the image addresses, as one pass over rendered Markdown. */
function afterConversion(links?: HtmlTransform, images?: HtmlTransform): HtmlTransform | undefined {
  if (!images) return links;
  return (html) => images(links ? links(html) : html);
}

export function WidgetPreview({
  block,
  siteBaseUrl,
  preview,
  links: glossaryLinks,
  images,
}: {
  block: PanelWidget;
  siteBaseUrl?: string | null;
  preview?: PanelPreviewConfig;
  links?: HtmlTransform;
  images?: HtmlTransform;
}) {
  const links = afterConversion(glossaryLinks, images);
  const root = useRef<HTMLDivElement>(null);
  useMath(root, block, preview);
  const id = useId().replace(/[^\w-]/g, "");
  if (block.kind === "bibliography")
    return (
      <div ref={root} className="telar-widget-bibliography">
        <Bibliography block={block} id={id} links={links} />
      </div>
    );
  const body =
    block.kind === "accordion" ? (
      <Accordion block={block} id={id} links={links} />
    ) : block.kind === "tabs" ? (
      <Tabs block={block} id={id} links={links} />
    ) : (
      <Carousel block={block} siteBaseUrl={siteBaseUrl} links={links} />
    );
  return (
    <div ref={root} className={`telar-widget telar-widget-${block.kind}`}>
      {body}
    </div>
  );
}
