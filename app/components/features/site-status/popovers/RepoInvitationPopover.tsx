/**
 * RepoInvitationPopover — the body of the Site Status pill's
 * `repo-invitation` state: the member's own invitation to the project's
 * GitHub repository, with the button that accepts it.
 *
 * @version v1.5.0-beta
 */
import { Mail } from "lucide-react";
import { useTranslation } from "react-i18next";
import { RepoInvitationNotice } from "~/components/features/site-status/RepoInvitationNotice";
import type { OwnRepoAccess } from "~/lib/repo-access";

export interface RepoInvitationPopoverProps {
  access: OwnRepoAccess;
  className?: string;
}

export function RepoInvitationPopover({ access, className = "" }: RepoInvitationPopoverProps) {
  const { t } = useTranslation("popover");
  return (
    <div className={className} style={{ padding: "14px 18px 14px" }}>
      <div className="flex items-center gap-2" style={{ marginBottom: "8px" }}>
        <Mail className="w-4 h-4 text-terracotta shrink-0" aria-hidden="true" />
        <h3 className="font-heading font-bold text-charcoal" style={{ fontSize: "14px", letterSpacing: "-0.005em" }}>
          {t("repo_invitation.title")}
        </h3>
      </div>
      <RepoInvitationNotice access={access} sentenceKey="repo_invitation.body" />
    </div>
  );
}
