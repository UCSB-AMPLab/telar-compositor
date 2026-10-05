/**
 * RepoInvitationNotice — what the member sees about their own repository
 * invitation, and the button that accepts it. The popover and the welcome
 * modal accept through the same action and share its outcome messages. A lapsed invitation has no button: only a convenor
 * can send a new one. When GitHub refuses the accept, the GitHub invitation
 * page is offered instead.
 *
 * @version v1.5.0-beta
 */
import { useTranslation } from "react-i18next";
import { useAcceptRepoInvitation } from "~/hooks/use-accept-repo-invitation";
import type { OwnRepoAccess, TeamActionResult } from "~/lib/repo-access";

export interface RepoInvitationNoticeProps {
  access: OwnRepoAccess;
  /** The sentence that introduces the invitation where it appears. */
  sentenceKey: "repo_invitation.body";
}

export function AcceptOutcome({ result }: { result: Exclude<TeamActionResult, { ok: true }> }) {
  const { t } = useTranslation("popover");
  if (result.error === "lapsed") return <p role="alert">{t("repo_invitation.lapsed")}</p>;
  if (!result.fallbackUrl) return <p role="alert">{t("repo_invitation.changed")}</p>;
  return (
    <p role="alert">
      {t("repo_invitation.fallback")}{" "}
      <a href={result.fallbackUrl} target="_blank" rel="noopener noreferrer" className="underline">
        {t("repo_invitation.fallback_link")}
      </a>
    </p>
  );
}

export function RepoInvitationNotice({ access, sentenceKey }: RepoInvitationNoticeProps) {
  const { t } = useTranslation("popover");
  const { accept, busy, result } = useAcceptRepoInvitation();
  if (access.stage === "lapsed") {
    return <p className="font-body text-sm leading-relaxed text-charcoal/70">{t("repo_invitation.lapsed")}</p>;
  }
  if (access.stage !== "pending") return null;
  return (
    <div className="flex flex-col gap-2 font-body text-sm leading-relaxed text-charcoal/70">
      <p>{t(sentenceKey)}</p>
      {result && !result.ok ? <AcceptOutcome result={result} /> : null}
      <button
        type="button"
        disabled={busy}
        onClick={accept}
        className="self-start rounded-lg bg-terracotta px-4 py-1.5 font-heading text-sm font-semibold text-cream hover:bg-terracotta-deep transition-colors disabled:opacity-50"
      >
        {t("repo_invitation.accept")}
      </button>
    </div>
  );
}
