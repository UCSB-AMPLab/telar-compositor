/**
 * TeamMemberRow — one member on the team page: avatar, username, role badge,
 * a line saying where the person stands on the way to the repository, and
 * the controls its viewer has on it. Withdrawing asks once more before it
 * is sent; a refused action says why, and a refused accept links to the
 * invitation on GitHub.
 *
 * @version v1.5.0-beta
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RoleBadge } from "~/components/features/dashboard/RoleBadge";
import { useRelativeTime } from "~/lib/use-relative-time";
import type { TeamActionError, TeamActionResult, TeamRowAction, TeamRowState } from "~/lib/repo-access";

interface TeamMemberRowProps {
  githubId: number;
  username: string;
  role: "convenor" | "collaborator" | "instructor";
  state: TeamRowState;
  /** Why the last add failed; shown as a tooltip on the state line. */
  error?: string | null;
  /** Set when the row was read before the page's check time, or never: the row then says when itself. */
  behind?: { checkedAt: string | null } | null;
  actions?: TeamRowAction[];
  /** The viewer's own row. */
  self?: boolean;
  busy?: boolean;
  /** The last action's answer for this row. */
  result?: TeamActionResult | null;
  onAction?: (action: TeamRowAction) => void;
}

const ACTION_KEYS: Record<TeamRowAction, string> = {
  add: "repo_action_add",
  reissue: "repo_action_reissue",
  revoke: "repo_action_revoke",
  accept: "repo_action_accept",
};

const ERROR_KEYS: Record<TeamActionError, string> = {
  changed: "repo_error_changed",
  instructor: "repo_instructor_note",
  owner: "repo_error_owner",
  failed: "repo_error_failed",
  lapsed: "repo_own_lapsed",
  accept_refused: "repo_accept_fallback",
};

const STATE_KEYS: Record<TeamRowState, string> = {
  invited: "repo_state_invited",
  access: "repo_state_access",
  pending: "repo_state_pending",
  lapsed: "repo_state_lapsed",
  waiting: "repo_state_waiting",
  retrying: "repo_state_retrying",
  stopped: "repo_state_stopped",
  withdrawn: "repo_state_withdrawn",
  before: "repo_state_before",
  unlisted: "repo_state_unlisted",
};

function rowNote(role: TeamMemberRowProps["role"], state: TeamRowState, self: boolean): string | null {
  if (role === "instructor") return "repo_instructor_note";
  if (self && state === "lapsed") return "repo_own_lapsed";
  return null;
}

function TeamRowFreshness({ checkedAt }: { checkedAt: string | null }) {
  const { t } = useTranslation("team");
  const never = t("team_page_never_checked");
  const when = useRelativeTime(checkedAt, never);
  return (
    <span data-freshness className="block font-body text-xs text-gray-400">
      {checkedAt ? (when ? t("team_page_checked", { when }) : null) : never}
    </span>
  );
}

/** An invite link nobody has followed: it names no one, so the row shows the link, not a person. */
export function TeamInvitedRow() {
  const { t } = useTranslation("team");
  return (
    <li className="flex items-center gap-3 px-3 py-2.5 bg-white opacity-70 [&:not(:last-child)]:border-b border-gray-100">
      <span className="w-8 h-8 rounded-full shrink-0 bg-cream-dark" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <span className="block font-body text-sm text-charcoal truncate">{t("repo_invite_label")}</span>
        <span data-state="invited" className="block font-body text-xs text-gray-500">{t(STATE_KEYS.invited)}</span>
      </div>
    </li>
  );
}

function TeamRowResult({ result }: { result: TeamActionResult }) {
  const { t } = useTranslation("team");
  if (result.ok) return null;
  return (
    <span role="alert" className="block font-body text-xs text-red-700 mt-0.5">
      {t(ERROR_KEYS[result.error])}{" "}
      {result.fallbackUrl ? (
        <a href={result.fallbackUrl} target="_blank" rel="noreferrer" className="underline">
          {t("repo_accept_fallback_link")}
        </a>
      ) : null}
    </span>
  );
}

function TeamRowControls({ actions, busy, onAction }: Pick<TeamMemberRowProps, "actions" | "busy" | "onAction">) {
  const { t } = useTranslation("team");
  const [confirming, setConfirming] = useState(false);
  const sendRowAction = (action: TeamRowAction) => {
    setConfirming(false);
    onAction?.(action);
  };
  const button = "font-body text-xs px-2 py-1 rounded border border-gray-200 text-charcoal hover:bg-cream disabled:opacity-50";
  if (confirming) {
    return (
      <span className="flex gap-1 shrink-0">
        <button type="button" disabled={busy} className={button} onClick={() => sendRowAction("revoke")}>{t("repo_action_revoke_confirm")}</button>
        <button type="button" className={button} onClick={() => setConfirming(false)}>{t("repo_action_revoke_cancel")}</button>
      </span>
    );
  }
  return (
    <span className="flex gap-1 shrink-0">
      {(actions ?? []).map((a) => (
        <button key={a} type="button" disabled={busy} className={button} onClick={() => (a === "revoke" ? setConfirming(true) : sendRowAction(a))}>
          {t(ACTION_KEYS[a])}
        </button>
      ))}
    </span>
  );
}

export function TeamMemberRow({ githubId, username, role, state, error, behind, actions, self, busy, result, onAction }: TeamMemberRowProps) {
  const { t } = useTranslation("team");
  const note = rowNote(role, state, self ?? false);
  return (
    <li className="flex items-center gap-3 px-3 py-2.5 bg-white [&:not(:last-child)]:border-b border-gray-100">
      <img
        src={`https://avatars.githubusercontent.com/u/${githubId}?s=64`}
        alt={username}
        className="w-8 h-8 rounded-full shrink-0 bg-cream-dark"
      />
      <div className="flex-1 min-w-0">
        <span className="block font-body text-sm text-charcoal truncate">@{username}</span>
        <span
          data-state={state}
          title={error ?? undefined}
          className="block font-body text-xs text-gray-500"
        >
          {t(STATE_KEYS[state])}
        </span>
        {behind ? <TeamRowFreshness checkedAt={behind.checkedAt} /> : null}
        {note ? <span className="block font-body text-xs text-gray-500">{t(note)}</span> : null}
        {result ? <TeamRowResult result={result} /> : null}
      </div>
      {actions && actions.length > 0 ? <TeamRowControls actions={actions} busy={busy} onAction={onAction} /> : null}
      <RoleBadge role={role} />
    </li>
  );
}
