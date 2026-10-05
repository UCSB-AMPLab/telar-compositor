/**
 * What a layer panel's preview says about itself: that the site's preview
 * settings could not be read, and that the site's Telar predates what the
 * preview shows, with a way to upgrade. Shown at the top of the panel's
 * content, whether the content is open for editing or not.
 *
 * @version v1.5.0-beta
 */
import { Link as RouterLink } from "react-router";
import { useTranslation } from "react-i18next";
import type { PanelPreviewConfig } from "~/lib/panel-preview-config";

export function PanelPreviewNotice({ preview }: { preview?: PanelPreviewConfig }) {
  const { t } = useTranslation("editor");
  if (!preview) return null;
  return (
    <>
      {!preview.available && <p className="text-xs font-body mb-2">{t("panel.previewUnavailable")}</p>}
      {preview.olderFramework && (
        <p className="text-xs font-body mb-2">
          {t("panel.olderFramework", { version: preview.siteVersion })}{" "}
          <RouterLink to="/upgrade" className="underline">
            {t("panel.olderFrameworkLink")}
          </RouterLink>
        </p>
      )}
    </>
  );
}
