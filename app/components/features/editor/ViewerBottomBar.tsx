/**
 * The story editor's bottom bar over the IIIF viewer: the live coordinates, the
 * page cluster for a multi-page object, Capture and Reset.
 *
 * The arrangement follows the COLUMN's width rather than the viewport's. Between
 * `sm` and `lg` the editor gives the viewer half the screen, so a viewport
 * breakpoint lays out a wide bar inside a narrow pane and the regions overlap;
 * a container query measures the pane the bar actually lives in. At and above
 * 36rem of column width the bar is three regions in a row — coordinates and
 * cluster, Capture, Reset — and below it two rows.
 *
 * The bar reports intent and owns no state: which page is showing, whether
 * Capture is usable and whether there is a framing to reset to are all the
 * column's answers, since only the column knows which viewer instance is in
 * front of the author.
 *
 * @version v1.5.0-beta
 */

import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Camera, ChevronLeft, ChevronRight, Layers, RotateCcw } from "lucide-react";
import { formatPageNumber, pageValues } from "~/lib/iiif-pages";

export interface LiveCoords {
  x: number;
  y: number;
  zoom: number;
}

/** x, y and z to three decimals, or the placeholder before the first open. */
export function CoordinateReadout({ coords }: { coords: LiveCoords | null }) {
  const { t } = useTranslation("editor");
  if (!coords) {
    return <span className="opacity-70">{t("viewer.no_position")}</span>;
  }
  return (
    <>
      <span>x {coords.x.toFixed(3)}</span>
      <span className="mx-0.5 opacity-50">·</span>
      <span>y {coords.y.toFixed(3)}</span>
      <span className="mx-0.5 opacity-50">·</span>
      <span>z {coords.zoom.toFixed(3)}</span>
    </>
  );
}

/**
 * Previous, the `Page n/m` indicator and Change, shown only for a source with
 * more than one page. The arrows browse without persisting anything; Change
 * opens the page chooser, and its button is a persistent focus target for the
 * end of the dialog chain.
 *
 * The cluster wraps within itself. `Página 1.240/1.240` beside three buttons is
 * wider than the coordinates region can hold at a narrow column width, and a
 * cluster that refuses to wrap pushes into Capture instead.
 */
function PageCluster({
  page,
  count,
  onPrev,
  onNext,
  onChange,
  changeButtonRef,
}: {
  page: number;
  count: number;
  onPrev: () => void;
  onNext: () => void;
  onChange: () => void;
  changeButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t, i18n } = useTranslation("editor");
  return (
    <span className="flex flex-wrap items-center gap-x-1 gap-y-1 min-w-0">
      <button
        type="button"
        onClick={onPrev}
        disabled={page <= 0}
        aria-label={t("viewer.prev_page_aria")}
        className="w-6 h-6 flex items-center justify-center rounded text-cream/70 hover:text-cream hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-default"
      >
        <ChevronLeft className="w-3.5 h-3.5" />
      </button>
      <span className="text-qolle-pale tabular-nums">
        {t(
          "viewer.page_indicator",
          pageValues({
            page: formatPageNumber(i18n.language, page + 1),
            count: formatPageNumber(i18n.language, count),
          })
        )}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={page >= count - 1}
        aria-label={t("viewer.next_page_aria")}
        className="w-6 h-6 flex items-center justify-center rounded text-cream/70 hover:text-cream hover:bg-white/10 transition-colors disabled:opacity-30 disabled:cursor-default"
      >
        <ChevronRight className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        ref={changeButtonRef}
        onClick={onChange}
        className="flex items-center gap-1 px-2 py-0.5 rounded text-cream/70 hover:text-cream hover:bg-white/10 transition-colors font-heading text-[11px] uppercase tracking-wider"
      >
        <Layers className="w-3 h-3" />
        {t("viewer.change_page")}
      </button>
    </span>
  );
}

export function ViewerBottomBar({
  coords,
  showPageCluster,
  page,
  pageCount,
  onPrevPage,
  onNextPage,
  onOpenChooser,
  changePageButtonRef,
  captureReady,
  captured,
  onCapture,
  canReset,
  onReset,
}: {
  coords: LiveCoords | null;
  showPageCluster: boolean;
  page: number;
  pageCount: number;
  onPrevPage: () => void;
  onNextPage: () => void;
  onOpenChooser: () => void;
  changePageButtonRef: RefObject<HTMLButtonElement | null>;
  captureReady: boolean;
  captured: boolean;
  onCapture: () => void;
  canReset: boolean;
  onReset: () => void;
}) {
  const { t } = useTranslation("editor");
  return (
    <div className="absolute bottom-3 left-3 right-3 z-10 flex flex-col gap-1 bg-black/60 rounded font-mono text-xs p-1 @[36rem]:grid @[36rem]:grid-cols-3 @[36rem]:items-center @[36rem]:gap-2 @[36rem]:p-1">
      {/* (a) Coordinates and the page cluster — one region, wrapping within itself */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1 min-w-0">
        <span className="text-qolle-pale">
          <CoordinateReadout coords={coords} />
        </span>

        {showPageCluster && (
          <PageCluster
            page={page}
            count={pageCount}
            onPrev={onPrevPage}
            onNext={onNextPage}
            onChange={onOpenChooser}
            changeButtonRef={changePageButtonRef}
          />
        )}
      </div>

      {/* (b) and (c) — one row below the narrow bar; two grid columns in the
          wide bar, where `contents` promotes them to siblings of (a). */}
      <div className="flex items-center justify-between gap-2 px-2 py-1 @[36rem]:contents">
        <button
          type="button"
          onClick={onCapture}
          disabled={!captureReady}
          className="flex items-center gap-1.5 px-4 py-2 bg-qolle text-charcoal hover:bg-qolle-deep rounded-full font-heading font-semibold text-xs uppercase tracking-wider transition-colors disabled:opacity-40 disabled:cursor-default @[36rem]:justify-self-center"
        >
          <Camera className="w-3.5 h-3.5" />
          {captured ? t("viewer.captured") : t("viewer.capture_position")}
        </button>

        <button
          type="button"
          onClick={onReset}
          disabled={!canReset}
          className="flex items-center gap-1.5 px-3 py-2 text-cream/60 hover:text-yellow-300 rounded transition-colors shrink-0 disabled:opacity-30 disabled:cursor-default font-heading text-xs uppercase tracking-wider @[36rem]:justify-self-end"
        >
          <RotateCcw className="w-3 h-3" />
          {t("viewer.reset_position")}
        </button>
      </div>
    </div>
  );
}
