/**
 * Parts of the IIIF viewer drawn beside the image: the Viewfinder toggle with
 * its hint, and what stands in for the image while a self-hosted object's
 * tiles are checked or missing.
 *
 * @version v1.5.0-beta
 */

import { useTranslation } from "react-i18next";
import { Crosshair, ImageOff, RefreshCw } from "lucide-react";

/**
 * On the framing stage, whose chrome lays out every control and label
 * together: where the Viewfinder column goes, its measure, and whether its
 * hint shows.
 */
export interface ViewerChrome {
  /** The column's right edge and top, from the pane's right and top edges. */
  viewfinderAt?: { right: number; top: number };
  /** Measure the toggle and the hint, each on its own. */
  viewfinderRef: (el: HTMLElement | null) => void;
  hintRef?: (el: HTMLElement | null) => void;
  showHint: boolean;
}

/**
 * The Viewfinder toggle, with its hint under it while the guides show:
 * top-right, clear of the zoom buttons and the status bar, or where the
 * stage's chrome puts it, with the hint only where the chrome has room for it.
 * On a short landscape phone the hint is dropped.
 */
export function Viewfinder({
  guidesOn,
  onToggle,
  chrome,
}: {
  guidesOn: boolean;
  onToggle: () => void;
  chrome: ViewerChrome | undefined;
}) {
  const { t } = useTranslation("objects");
  return (
    <div data-testid="viewfinder" {...columnPlacement(chrome)}>
      <button
        ref={chrome?.viewfinderRef}
        type="button"
        onClick={onToggle}
        aria-pressed={guidesOn}
        title={t("viewer_viewfinder_toggle")}
        className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 pointer-coarse:min-h-11 font-heading text-[11px] uppercase tracking-wider shadow transition-colors ${
          guidesOn ? "bg-white text-charcoal" : "bg-black/60 text-white/80 hover:bg-black/70"
        }`}
      >
        <Crosshair className="w-3.5 h-3.5" />
        {t("viewer_viewfinder_toggle")}
      </button>
      {guidesOn && <ViewfinderHint chrome={chrome} />}
    </div>
  );
}

/** The Viewfinder column where the stage's chrome puts it, or at the viewer's top right. */
function columnPlacement(chrome: ViewerChrome | undefined) {
  const at = chrome?.viewfinderAt;
  return {
    className: `absolute z-10 flex flex-col items-end gap-1.5${chrome ? "" : " top-14 right-3"}`,
    style: at ? { right: at.right, top: at.top } : undefined,
  };
}

/** The hint under the toggle, unless the stage's chrome has no room for it. */
function ViewfinderHint({ chrome }: { chrome: ViewerChrome | undefined }) {
  const { t } = useTranslation("objects");
  if (chrome && !chrome.showHint) return null;
  return (
    <div ref={chrome?.hintRef} className="max-w-[160px] rounded-lg bg-black/60 px-2.5 py-1.5 font-body text-[11px] leading-tight text-white/90 text-right landscape-compact:hidden">
      {t("viewer_viewfinder_hint")}
    </div>
  );
}

/**
 * What stands in for the image while a self-hosted object's tiles are being
 * checked, and when the check says they are not there: the build that makes
 * them can be started from here, and the check retried once it has run.
 */
export function TilesPlaceholder({
  checking,
  className,
  onGenerateTiles,
  isGenerating,
  onRetry,
}: {
  checking: boolean;
  className: string;
  onGenerateTiles?: () => void;
  isGenerating: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation("objects");
  return (
    <div
      className={`flex flex-col items-center justify-center bg-gray-100 rounded-lg ${className}`}
    >
      {checking ? (
        <>
          <div className="w-6 h-6 border-2 border-anil border-t-transparent rounded-full animate-spin mb-3" />
          <p className="font-body text-sm text-gray-400">
            {t("viewer_checking_tiles")}
          </p>
        </>
      ) : (
        <>
          <ImageOff className="w-12 h-12 text-gray-300 mb-3" />
          <p className="font-body text-sm text-gray-500 text-center max-w-xs mb-3">
            {t("viewer_tiles_unavailable")}
          </p>
          <div className="flex items-center gap-2">
            {onGenerateTiles && (
              <button
                type="button"
                onClick={onGenerateTiles}
                disabled={isGenerating}
                className="inline-flex items-center gap-2 font-heading font-semibold text-xs uppercase tracking-wider text-white bg-terracotta hover:bg-terracotta/90 rounded-full px-4 py-1.5 transition-colors disabled:opacity-50"
              >
                {isGenerating ? (
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <RefreshCw className="w-3.5 h-3.5" />
                )}
                {isGenerating ? t("viewer_generating") : t("viewer_generate_tiles")}
              </button>
            )}
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center gap-2 font-heading font-semibold text-xs uppercase tracking-wider text-charcoal border border-gray-300 rounded-full px-4 py-1.5 hover:bg-gray-50 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              {t("viewer_retry")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
