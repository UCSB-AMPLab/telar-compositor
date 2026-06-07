/**
 * RepoUnavailablePopover — the body of the Site Status pill's
 * `repo-unavailable` state. Renders when Telar can no longer reach the
 * project's GitHub repository (deleted / renamed / made private / access
 * removed; see checkRepoAvailability + the _app loader's repo-unavailable gate).
 *
 * It names the repo, reassures that the user's compositor work is safe
 * (stored in D1, independent of the repository), and offers the one real
 * action: convenors get a "Manage repository access on GitHub" link (the
 * generic installations settings page — same destination class as
 * GitHubAccessCard); collaborators, who likely lack repo admin, get a note
 * to ask their convenor instead.
 *
 * Mirrors OutOfSyncPopover's head/body/footer geometry. Terracotta tones
 * (the identity's warmest attention colour; no alarm-red). `popover`
 * namespace. Light mode only; lucide-react only; `~/` imports.
 *
 * @version v1.3.0-beta
 */

import { AlertTriangle, ArrowUpRight } from "lucide-react";
import { useTranslation } from "react-i18next";

/** Generic GitHub installations management page — never invent a new URL. */
const MANAGE_ACCESS_URL = "https://github.com/settings/installations";

export interface RepoUnavailablePopoverProps {
  repoFullName: string | null;
  userRole: "convenor" | "collaborator" | null;
  className?: string;
}

export function RepoUnavailablePopover({
  repoFullName,
  userRole,
  className = "",
}: RepoUnavailablePopoverProps) {
  const { t } = useTranslation("popover");
  const isConvenor = userRole === "convenor";

  return (
    <div className={className}>
      {/* Head */}
      <div className="border-b border-border" style={{ padding: "14px 18px 12px" }}>
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4 text-terracotta shrink-0" aria-hidden="true" />
          <h3 className="font-heading font-bold text-charcoal" style={{ fontSize: "14px", letterSpacing: "-0.005em" }}>
            {t("repo_unavailable.title")}
          </h3>
        </div>
        <p className="font-body text-fg-muted" style={{ fontSize: "12px", marginTop: "6px", lineHeight: 1.45 }}>
          {t("repo_unavailable.body", { repo: repoFullName ?? "" })}
        </p>
      </div>

      {/* Footer: convenor gets the manage link (right-aligned, like other
          popovers); collaborator gets a left-aligned prose note. */}
      <div
        className={`border-t border-border bg-cream flex items-center ${isConvenor ? "justify-end" : "justify-start"}`}
        style={{ padding: "11px 14px 12px" }}
      >
        {isConvenor ? (
          <a
            href={MANAGE_ACCESS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="font-heading font-semibold inline-flex items-center gap-1.5 bg-terracotta text-cream hover:opacity-90 transition-opacity"
            style={{ fontSize: "11px", letterSpacing: "0.04em", textTransform: "uppercase", padding: "6px 14px", borderRadius: "9999px" }}
          >
            {t("repo_unavailable.manage_cta")}
            <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
          </a>
        ) : (
          <p className="font-body text-fg-muted" style={{ fontSize: "12px", lineHeight: 1.45 }}>
            {t("repo_unavailable.collaborator_note")}
          </p>
        )}
      </div>
    </div>
  );
}
