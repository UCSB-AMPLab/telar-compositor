/**
 * This file renders the Connected Sites card — the section on the
 * /account page that lists every project the signed-in user belongs
 * to, one row per project, sorted most-recently-edited first. When
 * the user has no memberships it renders the quiet empty-state card
 * with two onboarding CTAs.
 *
 * Each ProjectRow shows: title + role badge (Coordinador/a for
 * convenor, Colaborador/a for collaborator) + last-edited relative
 * timestamp + collaborator count (other-than-self) + Open link +
 * KebabMenu trigger with per-row Delete project / Leave actions.
 *
 * Relative time uses Intl.RelativeTimeFormat for ≤30 days; absolute
 * Intl.DateTimeFormat short date thereafter.
 *
 * @version v1.3.0-beta
 */

import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { Button } from "~/components/ui/Button";
import { KebabMenu, type KebabMenuItem } from "~/components/ui/KebabMenu";
import { DeleteConfirmationModal } from "~/components/ui/DeleteConfirmationModal";
import { useToast } from "~/hooks/use-toast";
import { formatRelative } from "~/lib/format-relative";

type Role = "convenor" | "collaborator";

export interface ConnectedSitesProject {
  id: number;
  title: string;
  userRole: Role;
  last_edited_at: string | null;
  collaborator_count: number;
}

export interface ConnectedSitesCardProps {
  projects: ConnectedSitesProject[];
  uiLocale: string;
  /**
   * Server-determined "now" timestamp used as the reference for
   * `Intl.RelativeTimeFormat`. Plumbed from the loader so SSR and
   * client hydration produce identical strings (otherwise the worker's
   * and the browser's `Date.now()` diverge by RTT and trip React's
   * hydration mismatch guard).
   */
  nowMs: number;
  /**
   * Shared modal lift — when provided, the route owns the
   * single delete-project modal instance (so both the Connected Sites
   * kebab and the Danger zone inline-link trigger open the SAME modal,
   * no stacking-context / focus-trap duplication). When absent, the
   * existing internal modal is preserved (back-compat for any caller
   * still mounting this card without modal lifting).
   * See _app.account.tsx for the lifted state owner.
   */
  onOpenDeleteProject?: (projectId: number) => void;
}

/**
 * Format a last-edited timestamp.
 *
 * - ≤ 30 days: Intl.RelativeTimeFormat with numeric "auto" (e.g.
 *   "3 hours ago", "yesterday", "2 weeks ago" / "hace 3 horas",
 *   "ayer", "hace 2 semanas").
 * - > 30 days: short localised date (e.g. "Mar 14, 2026" / "14 de
 *   mar de 2026").
 * - null: returns null so the caller can render a fallback.
 */
function formatLastEdited(
  iso: string | null,
  uiLocale: string,
  nowMs: number = Date.now(),
): string | null {
  if (!iso) return null;
  if (Number.isNaN(new Date(iso).getTime())) return null;
  // Delegates to the shared formatRelative (same buckets, plus a UTC-pinned
  // absolute date) so the account list formats relative time identically to
  // the rest of the app and stays hydration-safe given the loader's nowMs.
  return formatRelative(iso, { now: nowMs, locale: uiLocale });
}

interface ProjectRowProps {
  project: ConnectedSitesProject;
  uiLocale: string;
  nowMs: number;
  /**
   * Modal lift: when provided, the kebab "Delete project"
   * item calls this handler instead of opening the row-local modal.
   * The row also skips rendering its internal DeleteConfirmationModal
   * in that mode. See ConnectedSitesCardProps for the route-level
   * owner.
   */
  onOpenDeleteProject?: (projectId: number) => void;
}

/**
 * Build the delete-project active-warning paragraph from a live WS
 * count. Returns `undefined` when count is null (DO unreachable —
 * informational only) or zero (no collaborators connected).
 */
function buildActiveWarning(
  count: number | null,
  t: ReturnType<typeof useTranslation>["t"],
): string | undefined {
  if (count === null || count <= 0) return undefined;
  if (count === 1) return t("delete_project_active_warning_one", { count });
  return t("delete_project_active_warning_other", { count });
}

function ProjectRow({
  project,
  uiLocale,
  nowMs,
  onOpenDeleteProject,
}: ProjectRowProps) {
  const { t } = useTranslation("account");
  const { showToast } = useToast();

  const isConvenor = project.userRole === "convenor";
  const roleLabel = isConvenor
    ? t("role_convenor")
    : t("role_collaborator");
  const badgeClass = isConvenor
    ? "bg-anil text-charcoal"
    : "bg-cream-dark text-charcoal";

  const relative =
    formatLastEdited(project.last_edited_at, uiLocale, nowMs) ?? "—";

  let collabPhrase: string;
  if (project.collaborator_count === 0) {
    collabPhrase = t("collab_count_zero");
  } else if (project.collaborator_count === 1) {
    collabPhrase = t("collab_count_one");
  } else {
    collabPhrase = t("collab_count_other", {
      count: project.collaborator_count,
    });
  }

  const metadata = t("row_metadata", {
    relative,
    collab_phrase: collabPhrase,
  });

  // Delete-project (convenor) state + fetchers
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteFetcher = useFetcher<{ ok: boolean; intent: string }>();
  const wsCountFetcher = useFetcher<{
    ok: boolean;
    intent: string;
    count: number | null;
  }>();
  const wsCount = wsCountFetcher.data?.count ?? null;

  // Leave-project (collaborator) state + fetcher
  const [leaveOpen, setLeaveOpen] = useState(false);
  const leaveFetcher = useFetcher<{ ok: boolean; intent: string }>();

  // Pre-flight live-WS-count fetch on convenor delete-modal open.
  // Informational only — convenor can confirm regardless of the count
  // or fetch outcome. We submit on every false→true transition; the
  // fetcher dedupes if the same intent is in flight.
  useEffect(() => {
    if (deleteOpen) {
      wsCountFetcher.submit(
        { intent: "get-active-ws-count", projectId: String(project.id) },
        { method: "POST" },
      );
    }
    // We deliberately omit wsCountFetcher from the dep list — including
    // it would cause a refetch on every fetcher state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteOpen, project.id]);

  // Toast + close on delete-fetcher response.
  useEffect(() => {
    if (deleteFetcher.state === "idle" && deleteFetcher.data) {
      if (deleteFetcher.data.ok) {
        setDeleteOpen(false);
        showToast({
          message: t("delete_project_toast_success"),
          type: "info",
        });
      } else {
        showToast({
          message: t("delete_project_toast_failure"),
          type: "destructive",
        });
      }
    }
  }, [deleteFetcher.state, deleteFetcher.data, showToast, t]);

  // Toast + close on leave-fetcher response.
  useEffect(() => {
    if (leaveFetcher.state === "idle" && leaveFetcher.data) {
      if (leaveFetcher.data.ok) {
        setLeaveOpen(false);
        showToast({
          message: t("leave_project_toast_success", { title: project.title }),
          type: "info",
        });
      } else {
        showToast({
          message: t("leave_project_toast_failure"),
          type: "destructive",
        });
      }
    }
  }, [leaveFetcher.state, leaveFetcher.data, showToast, t, project.title]);

  // Per-row kebab items: convenor → Delete project; collaborator → Leave.
  // Both destructive; both open their respective modal.
  const kebabItems: KebabMenuItem[] = isConvenor
    ? [
        {
          label: t("kebab_delete_project"),
          // Modal lift: when the route passes
          // `onOpenDeleteProject`, defer to the shared route-level modal
          // so the kebab and the Danger zone inline-link both drive ONE
          // modal instance. Falls back to the row-local modal otherwise
          // (back-compat).
          onClick: () => {
            if (onOpenDeleteProject) {
              onOpenDeleteProject(project.id);
            } else {
              setDeleteOpen(true);
            }
          },
          destructive: true,
        },
      ]
    : [
        {
          label: t("kebab_leave_project"),
          onClick: () => setLeaveOpen(true),
          destructive: true,
        },
      ];

  // Body-text interpolation for the delete modal — pull `{owner}` and
  // `{repo}` out of the github_repo_full_name (the row title is sourced
  // from this field).
  const [owner, repo] = (project.title || "/").split("/");

  return (
    <li className="py-4 flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-base font-body font-medium text-charcoal truncate">
            {project.title}
          </p>
          {/* Role badge only renders for multiplayer projects — on a solo
              project (no other members) the convenor/collaborator
              distinction has no meaning and the badge is visual noise. */}
          {project.collaborator_count > 0 && (
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-heading font-semibold uppercase tracking-wider ${badgeClass}`}
            >
              {roleLabel}
            </span>
          )}
        </div>
        <p className="text-sm font-body text-gray-500 mt-1">{metadata}</p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <Link
          to={`/projects/${project.id}`}
          aria-label={t("row_open_aria", { title: project.title })}
          className="inline-flex items-center gap-1 text-sm font-body font-medium text-charcoal hover:text-terracotta transition-colors"
        >
          {t("row_open_link")}
          <ExternalLink className="w-4 h-4" aria-hidden="true" />
        </Link>

        <KebabMenu
          items={kebabItems}
          ariaLabel={t("row_kebab_aria", { title: project.title })}
        />
      </div>

      {/* Delete-project modal (convenor only) — type-to-confirm gate
          ; pre-flight live-WS warning. When
          the route lifts the modal (`onOpenDeleteProject` provided), the
          row skips its own modal — the route renders ONE shared instance
          covering both this kebab path and the Danger zone inline-link
          trigger. */}
      {isConvenor && !onOpenDeleteProject && (
        <DeleteConfirmationModal
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          entityType="project"
          entityLabel={project.title}
          confirmText={project.title}
          destructiveColor="terracotta"
          titleOverride={t("delete_project_title", { title: project.title })}
          bodyText={t("delete_project_body", { owner, repo })}
          typeInstructionOverride={
            <Trans
              ns="account"
              i18nKey="delete_project_type_instruction"
              values={{ title: project.title }}
              components={[<strong key="t" className="font-semibold" />]}
            />
          }
          contentSummary={buildActiveWarning(wsCount, t)}
          confirmLabel={t("delete_project_confirm_button")}
          onConfirm={() => {
            deleteFetcher.submit(
              { intent: "delete-project", projectId: String(project.id) },
              { method: "POST" },
            );
          }}
        />
      )}

      {/* Leave-project modal (collaborator only) — single-confirm per
          terracotta button matches the rest of the destructive
          register. No `confirmText` so focus moves to Cancel by default. */}
      {!isConvenor && (
        <DeleteConfirmationModal
          open={leaveOpen}
          onClose={() => setLeaveOpen(false)}
          entityType="project"
          entityLabel={project.title}
          destructiveColor="terracotta"
          titleOverride={t("leave_project_title", { title: project.title })}
          bodyText={t("leave_project_body")}
          confirmLabel={t("leave_project_confirm_button")}
          onConfirm={() => {
            leaveFetcher.submit(
              { intent: "leave-project", projectId: String(project.id) },
              { method: "POST" },
            );
          }}
        />
      )}
    </li>
  );
}

export function ConnectedSitesCard({
  projects,
  uiLocale,
  nowMs,
  onOpenDeleteProject,
}: ConnectedSitesCardProps) {
  const { t } = useTranslation("account");

  return (
    <section className="bg-white rounded-lg border border-gray-200 shadow-sm p-6 mt-8">
      <h2 className="text-xl font-heading font-semibold text-charcoal">
        {t("connected_sites_heading")}
      </h2>

      {projects.length > 0 ? (
        <>
          <p className="text-sm font-body text-gray-500 mt-1">
            {t("connected_sites_sort_hint")}
          </p>
          <ul className="divide-y divide-gray-100 mt-4">
            {projects.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                uiLocale={uiLocale}
                nowMs={nowMs}
                onOpenDeleteProject={onOpenDeleteProject}
              />
            ))}
          </ul>
        </>
      ) : (
        <div className="py-8 px-6 text-center">
          <p className="text-base font-body font-medium text-charcoal">
            {t("empty_heading")}
          </p>
          <p className="text-sm font-body text-gray-500 mt-2">
            {t("empty_subtext")}
          </p>
          <div className="mt-4 flex gap-3 justify-center">
            <Link to="/onboarding">
              <Button variant="primary">{t("empty_cta_create")}</Button>
            </Link>
            <Link to="/onboarding">
              <Button variant="secondary">{t("empty_cta_connect")}</Button>
            </Link>
          </div>
        </div>
      )}
    </section>
  );
}
