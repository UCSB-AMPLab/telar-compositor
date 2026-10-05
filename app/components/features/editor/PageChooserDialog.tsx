/**
 * PageChooserDialog — how an author names the page of a multi-page object a
 * step shows.
 *
 * A digitised manuscript can run to a thousand pages, so paging one page at a
 * time reaches nothing: the dialog offers a number box that jumps straight to a
 * page and a grid of thumbnails for browsing near where the viewer already is.
 * The grid renders one window of pages at a time, because a thousand tiles is a
 * thousand image requests; the window opens on the page the viewer is showing
 * and moves only when the author asks it to, and a page outside it is still
 * reachable through the box. The window is settled before the first render of
 * any tile, since a tile requests its own thumbnail as it mounts and a window
 * corrected afterwards would already have fetched the wrong one.
 *
 * The dialog reads no manifest of its own. Its page records come from the
 * viewer's source state, so the grid and the image behind it always describe
 * the same revision of the same source. A choice carries the session it was
 * opened under, which is what lets the route refuse a choice whose target moved
 * while the dialog was open.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, ChevronRight, ImageOff, X } from "lucide-react";
import { Dialog } from "~/components/ui/Dialog";
import { useModalFocus } from "~/lib/modal-focus";
import { formatPageNumber, pageValues } from "~/lib/iiif-pages";
import type { ManifestPage } from "~/lib/iiif-pages";
import { thumbnailUrlFromInfo } from "~/lib/use-iiif-thumbnail";

/** How many tiles one window of the grid renders. */
export const PAGE_WINDOW = 48;

/** The smallest thumbnail width worth requesting from an Image API server. */
const THUMBNAIL_MIN_WIDTH = 160;

export interface PageChooserSession {
  selectionKey: string;
  targetKey: string;
  objectId: string;
  sourceKey: string;
}

interface PageChooserDialogProps {
  open: boolean;
  onClose: () => void;
  session: PageChooserSession | null;
  pages: ManifestPage[];
  objectTitle: string | null;
  /** 1-based page stored on the step, or null when it stores none. */
  savedPage: number | null;
  /** 0-based page the source state reports, which after browsing differs from the saved page. */
  effectivePage: number;
  onChoose: (page: number, session: PageChooserSession) => void;
}

/**
 * One page tile. A page whose manifest declares no thumbnail but whose tile
 * source is an Image API `info.json` resolves one from the sizes that server
 * declares, fetched when the tile is rendered — never for a page in a window
 * the author has not opened. A level-0 server answers only its declared sizes,
 * so nothing is requested that the source did not offer.
 */
function PageTile({
  page,
  index,
  isSaved,
  onChoose,
}: {
  page: ManifestPage;
  index: number;
  isSaved: boolean;
  onChoose: (page: number) => void;
}) {
  const { t, i18n } = useTranslation("editor");
  const [resolved, setResolved] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const declared = page.thumbnail ?? null;
  const infoJsonUrl =
    !declared && page.tileSource.endsWith("/info.json") ? page.tileSource : null;

  useEffect(() => {
    if (!infoJsonUrl) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(infoJsonUrl);
        if (!res.ok || cancelled) return;
        const info = (await res.json()) as Record<string, unknown>;
        if (cancelled) return;
        setResolved(thumbnailUrlFromInfo(info, THUMBNAIL_MIN_WIDTH));
      } catch {
        // No thumbnail for this page; the placeholder stands.
      }
    })();
    return () => { cancelled = true; };
  }, [infoJsonUrl]);

  const src = failed ? null : declared ?? resolved;
  const number = index + 1;
  const label = t(
    "page_chooser.page_label",
    pageValues({ page: formatPageNumber(i18n.language, number) })
  );

  return (
    <button
      type="button"
      onClick={() => onChoose(number)}
      aria-current={isSaved ? "true" : undefined}
      className={`group flex flex-col overflow-hidden rounded-lg border-2 text-left transition-colors hover:border-anil ${
        isSaved ? "border-anil bg-anil/10" : "border-gray-100 bg-white hover:bg-gray-50"
      }`}
    >
      <div className="aspect-square w-full bg-gray-100 flex items-center justify-center overflow-hidden">
        {src ? (
          <img
            src={src}
            alt=""
            loading="lazy"
            onError={() => setFailed(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <span className="flex flex-col items-center gap-1 text-gray-400">
            <ImageOff className="w-6 h-6 text-gray-300" />
            <span className="font-body text-[10px]">{t("page_chooser.no_preview")}</span>
          </span>
        )}
      </div>
      <div className="p-2">
        <p className="font-body text-xs font-medium text-charcoal truncate leading-tight">
          {label}
        </p>
        {page.label && (
          <p className="font-body text-[10px] text-gray-400 truncate mt-0.5">
            {page.label}
          </p>
        )}
      </div>
    </button>
  );
}

/** The first page of the window that holds a 0-based page. */
function windowStartFor(effectivePage: number, count: number): number {
  const clamped = Math.min(Math.max(effectivePage, 0), Math.max(count - 1, 0));
  return Math.floor(clamped / PAGE_WINDOW) * PAGE_WINDOW;
}

/**
 * The dialog's own state and body, mounted once per opening.
 *
 * The window is the initial value of state rather than something an effect
 * moves to after the first paint, because a tile fetches its `info.json` as it
 * mounts: a first render at the top of a thousand-page manuscript would request
 * the first forty-eight pages before the effect ever reached the ninetieth.
 * `PageChooserDialog` keys this component by the opening, so every opening is a
 * fresh mount whose first render is already at the right window.
 */
function PageChooserBody({
  onClose,
  session,
  pages,
  objectTitle,
  savedPage,
  effectivePage,
  onChoose,
}: Omit<PageChooserDialogProps, "open"> & { session: PageChooserSession }) {
  const { t, i18n } = useTranslation("editor");
  const { t: tCommon } = useTranslation("common");
  const titleId = useId();
  const errorId = useId();
  const numberBoxRef = useRef<HTMLInputElement>(null);

  const count = pages.length;
  const [windowStart, setWindowStart] = useState(() =>
    windowStartFor(effectivePage, count)
  );
  const [entry, setEntry] = useState("");
  const [invalid, setInvalid] = useState(false);

  const { containerRef, dialogProps } = useModalFocus({
    open: true,
    onClose,
    labelledBy: titleId,
    initialFocusRef: numberBoxRef,
  });

  const choose = (page: number) => {
    onChoose(page, session);
    onClose();
  };

  const submitEntry = () => {
    const parsed = Number(entry.trim());
    if (
      entry.trim() === "" ||
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > count
    ) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    choose(parsed);
  };

  const windowEnd = Math.min(windowStart + PAGE_WINDOW, count);
  const visible = pages.slice(windowStart, windowEnd);
  const title = objectTitle ?? tCommon("untitled");

  return (
    <Dialog open onClose={onClose} className="max-w-3xl p-0" managesOwnFocus>
      <div ref={containerRef} {...dialogProps} tabIndex={-1}>
        {/* Header: name, count, and the number box that reaches any page */}
        <div className="px-5 pt-5 pb-3 border-b border-gray-100">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2
                id={titleId}
                className="font-heading font-semibold text-charcoal text-base"
              >
                {t("page_chooser.title")}
              </h2>
              <p className="font-body text-sm text-gray-500 mt-0.5 truncate">
                {t(
                  "page_chooser.count",
                  pageValues({
                    title,
                    count: formatPageNumber(i18n.language, count),
                  })
                )}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={tCommon("close")}
              className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded text-gray-400 hover:text-charcoal hover:bg-gray-100 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="mt-3 flex items-end gap-2">
            <div className="min-w-0">
              <label
                htmlFor={`${titleId}-go`}
                className="block font-heading text-xs uppercase tracking-wider text-gray-500 mb-1"
              >
                {t("page_chooser.go_to_label")}
              </label>
              <input
                id={`${titleId}-go`}
                ref={numberBoxRef}
                type="text"
                inputMode="numeric"
                value={entry}
                aria-invalid={invalid || undefined}
                aria-describedby={invalid ? errorId : undefined}
                onChange={(e) => { setEntry(e.target.value); setInvalid(false); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitEntry();
                  }
                }}
                className="w-28 px-3 py-2 border border-gray-200 rounded-lg font-body text-sm text-charcoal"
              />
            </div>
            <button
              type="button"
              onClick={submitEntry}
              className="px-4 py-2 bg-anil text-charcoal rounded-full font-heading font-semibold text-xs uppercase tracking-wider hover:bg-anil/80 transition-colors"
            >
              {t("page_chooser.go")}
            </button>
          </div>
          {invalid && (
            <p id={errorId} role="alert" className="mt-2 font-body text-xs text-terracotta">
              {t(
                "page_chooser.invalid_page",
                pageValues({ count: formatPageNumber(i18n.language, count) })
              )}
            </p>
          )}
        </div>

        {/* One window of page tiles */}
        <div className="p-4 max-h-[60vh] overflow-y-auto">
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
            {visible.map((p, i) => {
              const index = windowStart + i;
              return (
                <PageTile
                  key={index}
                  page={p}
                  index={index}
                  isSaved={savedPage === index + 1}
                  onChoose={choose}
                />
              );
            })}
          </div>
        </div>

        {/* Window controls */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-gray-100">
          <button
            type="button"
            onClick={() => setWindowStart((s) => Math.max(0, s - PAGE_WINDOW))}
            disabled={windowStart === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 font-heading text-xs uppercase tracking-wider text-charcoal border border-gray-200 rounded-full hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-default"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            {t("page_chooser.earlier")}
          </button>
          <button
            type="button"
            onClick={() =>
              setWindowStart((s) => (s + PAGE_WINDOW < count ? s + PAGE_WINDOW : s))
            }
            disabled={windowEnd >= count}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 font-heading text-xs uppercase tracking-wider text-charcoal border border-gray-200 rounded-full hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-default"
          >
            {t("page_chooser.later")}
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * The dialog, one mount per opening. The opening counter is the body's key, so
 * an opening is always a fresh mount: its window, its number box and its error
 * start from the state this opening asks for, and a second opening never
 * inherits the window the author left the first one at.
 */
export function PageChooserDialog({ open, session, ...rest }: PageChooserDialogProps) {
  const [opening, setOpening] = useState({ open, id: 0 });
  if (opening.open !== open) {
    setOpening({ open, id: open ? opening.id + 1 : opening.id });
  }

  if (!open || !session) return null;
  return <PageChooserBody key={opening.id} session={session} {...rest} />;
}
