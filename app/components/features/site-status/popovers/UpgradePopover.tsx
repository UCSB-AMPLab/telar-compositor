/**
 * UpgradePopover — the framework-upgrade body of the Site Status pill, the
 * analog of the retired UpgradeBanner. Renders the title
 * (`Telar {version} available`), a current-version sub-line, a `What's new`
 * bullet list (terracotta markers), a `Learn more →` linky, and the role-gated
 * upgrade affordance.
 *
 * Role gate: when `userRole === "convenor"` the terracotta `Run upgrade` CTA is
 * shown (links to the existing `/upgrade` flow, which confirms). Otherwise
 * collaborators see the inert cream `Convenor needs to upgrade` line
 * (bg-cream-dark / text-charcoal, NOT a button).
 *
 * The What's-new notes are supplied per-release at render time (the pill passes
 * them from the upgrade loader) — they are NOT hardcoded i18n strings.
 *
 * @version v1.3.0-beta
 */

import { Link } from "react-router";
import { ArrowRight, ArrowUpCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface UpgradePopoverProps {
  /** The newest available framework version (e.g. "1.3.0" or a tag). */
  latestVersion: string;
  /** The site's current framework version. */
  currentVersion: string;
  /** Per-release "What's new" notes, supplied at render time (not i18n). */
  whatsNew?: string[];
  /** Only convenors get the Run-upgrade CTA. */
  userRole: "convenor" | "collaborator" | null;
  /** Optional external link for the "Learn more" linky. */
  learnMoreUrl?: string | null;
  className?: string;
}

export function UpgradePopover({
  latestVersion,
  currentVersion,
  whatsNew = [],
  userRole,
  learnMoreUrl,
  className = "",
}: UpgradePopoverProps) {
  const { t } = useTranslation("popover");
  const isConvenor = userRole === "convenor";

  return (
    <div className={className}>
      {/* Head */}
      <div className="border-b border-border" style={{ padding: "14px 18px 12px" }}>
        <h3 className="font-heading font-bold text-charcoal" style={{ fontSize: "14px", letterSpacing: "-0.005em" }}>
          {t("upgrade.title", { version: latestVersion })}
        </h3>
        <p className="font-body text-fg-muted" style={{ fontSize: "12px", marginTop: "2px" }}>
          {t("upgrade.from", { current: currentVersion })}
        </p>
      </div>

      {/* Body: What's new */}
      <div style={{ padding: "12px 18px 14px" }}>
        <p
          className="font-heading font-semibold text-charcoal uppercase"
          style={{ fontSize: "11px", letterSpacing: "0.04em", marginBottom: "8px" }}
        >
          {t("upgrade.what_changed")}
        </p>
        {whatsNew.length > 0 && (
          <ul className="flex flex-col" style={{ gap: "6px" }}>
            {whatsNew.map((note, i) => (
              <li key={i} className="flex items-baseline" style={{ gap: "8px" }}>
                <span className="text-terracotta shrink-0" aria-hidden="true">•</span>
                <span className="font-body text-charcoal" style={{ fontSize: "12px", lineHeight: 1.45 }}>
                  {note}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Footer: Learn-more linky (left) + role-gated affordance (right) */}
      <div
        className="border-t border-border bg-cream flex items-center justify-between"
        style={{ padding: "11px 14px 12px", gap: "8px" }}
      >
        {learnMoreUrl ? (
          <a
            href={learnMoreUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-heading font-semibold inline-flex items-center gap-1 text-anil-ink hover:underline"
            style={{ fontSize: "12.5px" }}
          >
            {t("upgrade.learn_more")}
            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
          </a>
        ) : (
          <span />
        )}

        {isConvenor ? (
          <Link
            to="/upgrade"
            className="font-heading font-semibold inline-flex items-center gap-1.5 bg-terracotta text-surface hover:bg-terracotta-deep transition-colors"
            style={{ fontSize: "11px", letterSpacing: "0.04em", textTransform: "uppercase", padding: "6px 14px", borderRadius: "9999px" }}
          >
            <ArrowUpCircle className="w-3.5 h-3.5" aria-hidden="true" />
            {t("upgrade.run")}
          </Link>
        ) : (
          <span
            className="font-body bg-cream-dark text-charcoal"
            style={{ fontSize: "12px", padding: "6px 14px", borderRadius: "0.375rem" }}
          >
            {t("upgrade.convenor_needed")}
          </span>
        )}
      </div>
    </div>
  );
}
