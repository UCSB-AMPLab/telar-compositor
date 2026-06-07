/**
 * This file renders the Danger Zone card — the terracotta-bordered
 * section beneath the GitHub Access card on the /account page that
 * houses one destructive action: Delete account.
 *
 * Two states:
 *
 *   - Gated state (`convenedProjects.length > 0`): the Delete
 *     account button is disabled. Helper text directs the user to
 *     delete their convened projects first; each convened project is
 *     rendered as an inline button that calls
 *     `onOpenDeleteProject(projectId)`. The route owns ONE shared
 *     delete-project modal driven by that handler so the Connected
 *     Sites kebab and the Danger Zone inline links share a single
 *     modal instance.
 *
 *   - Enabled state (`convenedProjects.length === 0`): the Delete
 *     account button is the terracotta-bordered destructive primary.
 *     On click, opens `DeleteConfirmationModal` with `entityType="account"`,
 *     `confirmText = user.github_login` (case-sensitive no-trim
 *     gate), and `destructiveColor="terracotta"`. On confirm,
 *     submits `intent=delete-account` via `useFetcher` — the
 *     action's happy path redirects to
 *     /signin?reason=account_deleted, so the fetcher's success
 *     branch is unreachable from this component (it unmounts before
 *     the redirect resolves). Only the race-guard failure path runs
 *     client-side: a destructive toast with
 *     `danger_zone.race_guard_error`.
 *
 * @version v1.3.0-beta
 */

import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { DeleteConfirmationModal } from "~/components/ui/DeleteConfirmationModal";
import { useToast } from "~/hooks/use-toast";

export interface DangerZoneCardProps {
  user: { github_login: string };
  /**
   * Projects the user convenes WITH collaborators. Empty array → enabled
   * state; non-empty → gated state. Each entry rendered as an inline
   * button driving the route-level shared delete-project modal. Solo
   * convener projects are NOT in this list — they auto-cascade during
   * delete-account flow.
   */
  convenedProjects: { id: number; title: string }[];
  /**
   * Number of projects the user convenes WITHOUT collaborators. When
   * > 0, the delete-account modal renders the category-warning line
   * `danger_zone.modal_body_solo_line` so the user knows those projects
   * will also be deleted as part of account removal.
   */
  soloConvenedCount: number;
  /**
   * Number of projects the user collaborates on (not convenes). Plumbed
   * into the modal body bullet copy via the `{{count}}` interpolation.
   */
  collaboratorCount: number;
  /**
   * Shared modal handler — the route owns the open-state so this
   * component and ConnectedSitesCard drive ONE modal instance.
   */
  onOpenDeleteProject: (projectId: number) => void;
}

export function DangerZoneCard({
  user,
  convenedProjects,
  soloConvenedCount,
  collaboratorCount,
  onOpenDeleteProject,
}: DangerZoneCardProps) {
  const { t } = useTranslation("account");
  const { showToast } = useToast();
  const [deleteOpen, setDeleteOpen] = useState(false);

  const deleteFetcher = useFetcher<{
    ok: boolean;
    intent: string;
    error?: string;
  }>();

  // Race-guard reaction. The happy path is a redirect from the
  // action, so React Router navigates the page before this fetcher's
  // .data hydrates client-side — the success branch is intentionally
  // absent. Only the convened_projects_exist error path runs here.
  useEffect(() => {
    if (deleteFetcher.state === "idle" && deleteFetcher.data) {
      if (!deleteFetcher.data.ok) {
        showToast({
          message: t("danger_zone.race_guard_error"),
          type: "destructive",
        });
      }
      // ok===true never resolves here — the action's redirect causes a
      // navigation away from /account; this component unmounts before
      // any success-data lands. Keeping the branch absent prevents the
      // dead-code reader confusion that an unreachable
      // `if (data.ok) { ... }` would invite.
    }
  }, [deleteFetcher.state, deleteFetcher.data, showToast, t]);

  const isGated = convenedProjects.length > 0;
  const isPending = deleteFetcher.state !== "idle";

  // Terracotta destructive button styling — matches the
  // DeleteConfirmationModal's `destructiveColor="terracotta"` register
  // exactly. Token-based (no raw hex), Space Grotesk uppercase per the
  // brand button conventions.
  const destructiveButtonClass =
    "inline-flex items-center justify-center gap-2 font-heading font-semibold uppercase tracking-wider rounded-full px-6 py-2.5 text-sm text-white bg-terracotta hover:bg-terracotta/90 transition-colors disabled:bg-disabled disabled:text-fg-disabled disabled:cursor-not-allowed";

  return (
    <section className="bg-white rounded-lg border border-terracotta/40 shadow-sm p-6 mt-8">
      <h2 className="text-xl font-heading font-semibold text-charcoal">
        {t("danger_zone.heading")}
      </h2>
      <p className="text-sm font-body text-gray-500 mt-1">
        {t("danger_zone.body")}
      </p>

      <div className="mt-4">
        <button
          type="button"
          disabled={isGated || isPending}
          onClick={() => setDeleteOpen(true)}
          className={destructiveButtonClass}
        >
          <Trash2 className="w-4 h-4" aria-hidden="true" />
          {t("danger_zone.button_label")}
        </button>
      </div>

      {isGated && (
        <div className="mt-4 text-sm font-body text-gray-600">
          <p>{t("danger_zone.gated_helper")}</p>
          <p className="mt-2">
            <span className="font-medium text-charcoal">
              {t("danger_zone.gated_list_label")}
            </span>{" "}
            {/* Inline buttons — an inline sentence form reads better
                here than a vertical <ul>. Each button calls
                onOpenDeleteProject(id) which drives the route's shared
                delete-project modal. */}
            {convenedProjects.map((p, i) => (
              <span key={p.id}>
                <button
                  type="button"
                  onClick={() => onOpenDeleteProject(p.id)}
                  className="underline text-terracotta hover:text-terracotta/80 font-body cursor-pointer"
                >
                  {p.title}
                </button>
                {i < convenedProjects.length - 1 ? ", " : ""}
              </span>
            ))}
          </p>
        </div>
      )}

      {!isGated && (
        <DeleteConfirmationModal
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          entityType="account"
          entityLabel={user.github_login}
          confirmText={user.github_login}
          destructiveColor="terracotta"
          titleOverride={t("danger_zone.modal_title")}
          bodyText={
            // Append the solo-line category warning when the user
            // convenes any project without collaborators. The modal's
            // bodyText renders with whitespace-pre-line, so a newline
            // separator produces the same visual bullet stack as the
            // existing modal_body entries.
            soloConvenedCount > 0
              ? `${t("danger_zone.modal_body", { count: collaboratorCount })}\n${t("danger_zone.modal_body_solo_line")}`
              : t("danger_zone.modal_body", { count: collaboratorCount })
          }
          typeInstructionOverride={
            <Trans
              ns="account"
              i18nKey="danger_zone.modal_type_instruction"
              values={{ login: user.github_login }}
              components={[<strong key="t" className="font-semibold" />]}
            />
          }
          confirmLabel={t("danger_zone.modal_confirm_button")}
          onConfirm={() => {
            deleteFetcher.submit(
              { intent: "delete-account" },
              { method: "POST" },
            );
          }}
        />
      )}
    </section>
  );
}
