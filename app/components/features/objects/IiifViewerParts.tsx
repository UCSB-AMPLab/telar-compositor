/**
 * Parts of the IIIF viewer drawn beside the image: the Viewfinder toggle that
 * shows and hides the guides, and what stands in for the image while a
 * self-hosted object's tiles are checked or missing.
 *
 * @version v1.5.2-beta
 */

import { useTranslation } from "react-i18next";
import { Eye, EyeOff, ImageOff, RefreshCw } from "lucide-react";

/**
 * On the framing stage, whose chrome lays out every control and tag
 * together: where the Viewfinder toggle goes, and its measure.
 */
export interface ViewerChrome {
  /** The toggle's right edge and top, from the pane's right and top edges. */
  viewfinderAt?: { right: number; top: number };
  viewfinderRef: (el: HTMLElement | null) => void;
}

/**
 * The Viewfinder toggle: top-right, clear of the zoom buttons and the status
 * bar, or where the stage's chrome puts it. It hides every guide and its tag,
 * so its name stays the same either way and its icon says which state it is in.
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
  const { t } = useTranslation("editor");
  return (
    <div data-testid="viewfinder" {...columnPlacement(chrome)}>
      <button
        ref={chrome?.viewfinderRef}
        type="button"
        onClick={onToggle}
        aria-pressed={guidesOn}
        title={t("stage.guides.toggle")}
        className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 pointer-coarse:min-h-11 font-heading text-[11px] font-semibold uppercase tracking-wider shadow transition-colors ${
          guidesOn ? "bg-white text-charcoal" : "bg-black/60 text-white/80 hover:bg-black/70"
        }`}
      >
        {guidesOn ? <Eye aria-hidden="true" className="w-3.5 h-3.5" /> : <EyeOff aria-hidden="true" className="w-3.5 h-3.5" />}
        {t("stage.guides.toggle")}
      </button>
    </div>
  );
}

/** The Viewfinder toggle where the stage's chrome puts it, or at the viewer's top right. */
function columnPlacement(chrome: ViewerChrome | undefined) {
  const at = chrome?.viewfinderAt;
  return {
    className: `absolute z-10 flex flex-col items-end gap-1.5${chrome ? "" : " top-14 right-3"}`,
    style: at ? { right: at.right, top: at.top } : undefined,
  };
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
