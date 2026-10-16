/**
 * FirstPublishPopover — the body of the Site Status pill's `first-publish`
 * state, shown while no head is recorded for the site. It says what the first
 * publish does to the site's files; it has no action, since publishing is its
 * own page.
 *
 * `popover` namespace. Light mode only; `~/` imports.
 *
 * @version v1.5.5-beta
 */

import { useTranslation } from "react-i18next";

export interface FirstPublishPopoverProps {
  className?: string;
}

export function FirstPublishPopover({ className = "" }: FirstPublishPopoverProps) {
  const { t } = useTranslation("popover");
  return (
    <div className={className} style={{ padding: "14px 18px 14px" }}>
      <h3 className="font-heading font-bold text-charcoal" style={{ fontSize: "14px", letterSpacing: "-0.005em" }}>
        {t("first_publish.title")}
      </h3>
      <p className="font-body text-fg-muted" style={{ fontSize: "12px", marginTop: "6px", lineHeight: 1.45 }}>
        {t("first_publish.body")}
      </p>
    </div>
  );
}
