/**
 * WelcomeModal — the one-time "you've been added" landing for a new
 * collaborator. While the member's repository invitation is pending or
 * lapsed, the modal has one job, accepting it; otherwise it is the plain
 * welcome. Whether it is open follows the loader's answer for the active
 * project, so a member who reaches the project through the switcher, with the
 * layout already mounted, still sees it. The repository access the loader read
 * decides the layout until the status poll answers; the poll's answer wins.
 *
 * @version v1.5.0-beta
 */
import { useEffect, useRef, useState } from "react";
import { Bug, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AcceptOutcome } from "~/components/features/site-status/RepoInvitationNotice";
import { useAcceptRepoInvitation } from "~/hooks/use-accept-repo-invitation";
import { useSharedGithubStatus } from "~/components/features/site-status/SiteStatusProvider";
import { useSiteFetcher } from "~/lib/page-site";
import type { OwnRepoAccess } from "~/lib/repo-access";

export interface WelcomeModalProps {
  needsWelcome: boolean;
  /** The active project; a dismissal belongs to it. */
  siteId: number | null;
  project: string;
  convenor: string;
  /** The member's repository access as the loader read it. */
  loaderAccess: OwnRepoAccess | null;
  onReport: () => void;
}

const PRIMARY = "rounded-lg bg-terracotta px-4 py-1.5 font-heading text-sm font-semibold text-cream hover:bg-terracotta-deep transition-colors disabled:opacity-50";

function useAcknowledge(close: () => void) {
  const fetcher = useSiteFetcher();
  return () => {
    fetcher.submit({}, { method: "post", action: "/api/welcome-ack" });
    close();
  };
}

function InvitationWelcome({ access, convenor, acknowledge }: { access: OwnRepoAccess; convenor: string; acknowledge: () => void }) {
  const { t } = useTranslation("popover");
  const { accept, busy, result } = useAcceptRepoInvitation();
  const acknowledged = useRef(false);
  const accepted = result?.ok === true;
  useEffect(() => {
    if (accepted && !acknowledged.current) {
      acknowledged.current = true;
      acknowledge();
    }
  }, [accepted, acknowledge]);
  const lapsed = access.stage === "lapsed";
  return (
    <>
      <p className="font-body text-sm leading-relaxed text-charcoal/70">
        {lapsed ? t("repo_invitation.lapsed") : t("repo_invitation.welcome_body", { convenor })}
      </p>
      {lapsed ? null : <p className="font-body text-sm leading-relaxed text-charcoal/70">{t("repo_invitation.welcome_email")}</p>}
      {result && !result.ok ? <AcceptOutcome result={result} /> : null}
      <div className="mt-1 flex items-center justify-end gap-3">
        <button type="button" onClick={acknowledge} className="font-body text-sm text-charcoal/70 underline hover:text-charcoal">
          {t("repo_invitation.later")}
        </button>
        {lapsed ? null : (
          <button type="button" disabled={busy} onClick={accept} className={PRIMARY}>
            {t("repo_invitation.accept")}
          </button>
        )}
      </div>
    </>
  );
}

function PlainWelcome({ convenor, acknowledge, onReport }: { convenor: string; acknowledge: () => void; onReport: () => void }) {
  const { t } = useTranslation("collaboration");
  return (
    <>
      <p className="font-body text-sm leading-relaxed text-charcoal/70">{t("welcome_added_body", { convenor })}</p>
      <div className="mt-1 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onReport}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 font-heading text-sm font-semibold text-anil-ink hover:bg-anil-pale transition-colors"
        >
          <Bug className="h-3.5 w-3.5" aria-hidden="true" />
          {t("beta_report")}
        </button>
        <button type="button" onClick={acknowledge} className={PRIMARY}>
          {t("beta_ack")}
        </button>
      </div>
    </>
  );
}

export function WelcomeModal({ needsWelcome, siteId, project, convenor, loaderAccess, onReport }: WelcomeModalProps) {
  const { t } = useTranslation("collaboration");
  const [dismissed, setDismissed] = useState<ReadonlySet<number | null>>(() => new Set());
  const dismiss = () => setDismissed((prev) => new Set(prev).add(siteId));
  const polled = useSharedGithubStatus();
  const acknowledge = useAcknowledge(dismiss);
  const access = polled && "ownRepoAccess" in polled ? polled.ownRepoAccess ?? null : loaderAccess;
  if (!needsWelcome || dismissed.has(siteId)) return null;
  const invited = access?.stage === "pending" || access?.stage === "lapsed";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/50" onClick={dismiss}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="collab-welcome-title"
        onClick={(e) => e.stopPropagation()}
        className="bg-cream rounded-xl p-6 shadow-lg w-[360px] max-w-[90vw] flex flex-col gap-3"
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-pill bg-caracol-pale text-caracol">
          <Users className="h-5 w-5" aria-hidden="true" />
        </div>
        <h2 id="collab-welcome-title" className="font-heading text-lg font-semibold text-charcoal">
          {t("welcome_added_title", { project })}
        </h2>
        {invited && access ? (
          <InvitationWelcome access={access} convenor={convenor} acknowledge={acknowledge} />
        ) : (
          <PlainWelcome
            convenor={convenor}
            acknowledge={acknowledge}
            onReport={() => {
              dismiss();
              onReport();
            }}
          />
        )}
      </div>
    </div>
  );
}
