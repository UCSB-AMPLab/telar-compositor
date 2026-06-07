/**
 * WelcomeStrip — the Start-tab welcome card.
 *
 * Populated state: eyebrow, project title, summary, a role chip (convenor =
 * caracol; collaborator = cream-dark/charcoal), a convened-by meta line, and
 * the orientation action chips (tour / what-is-compositor / what-is-IIIF).
 *
 * Empty (first-run) state: the role-specific 3-step setup checklist in an
 * anil-pale box, swapped in for the summary + chips.
 *
 * The orientation chips open the DocsDrawer (onOpenDoc): "What is the
 * compositor?" → DOC.intro; "What is IIIF?" → DOC.iiif. (The "Watch 3-min tour"
 * chip was removed — no tour video exists, so it pointed at getting-started
 * docs that the "What is the compositor?" chip already covers.)
 *
 * Design tokens only — no hardcoded hex.
 *
 * @version v1.3.0-beta
 */

import { BookOpen, Map, Users, Github } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface WelcomeStripProps {
  projectName: string;
  summary: string;
  role: "convenor" | "collaborator";
  convenorName: string;
  collaboratorCount: number;
  createdYear: number;
  state: "populated" | "empty";
  /** Open the DocsDrawer at a DOC key (orientation chips). */
  onOpenDoc?: (docKey: string) => void;
  /** Open the collaboration sidebar (convenor-only "Add collaborators" pill). */
  onAddCollaborators?: () => void;
  className?: string;
}

export function WelcomeStrip({
  projectName,
  summary,
  role,
  convenorName,
  collaboratorCount,
  createdYear,
  state,
  onOpenDoc,
  onAddCollaborators,
  className = "",
}: WelcomeStripProps) {
  const { t } = useTranslation("start");
  const isConvenor = role === "convenor";
  const isEmpty = state === "empty";

  // Eyebrow + title vary in the collaborator-empty (invited) variant.
  const eyebrow =
    !isConvenor && isEmpty ? t("welcome.eyebrow_collab_empty") : t("welcome.eyebrow_default");
  const title =
    !isConvenor && isEmpty
      ? t("welcome.title_collab_empty", { project: projectName })
      : projectName;

  // Role chip — token pairs.
  const roleChipClass = isConvenor
    ? "bg-caracol-pale text-caracol"
    : "bg-cream-dark text-charcoal";
  const roleChipLabel = isConvenor ? t("role_chip.convenor") : t("role_chip.collaborator");

  // Role-specific checklist (empty state).
  const checklist = isConvenor
    ? {
        heading: t("checklist.convenor_heading"),
        steps: [
          t("checklist.convenor_step1"),
          t("checklist.convenor_step2"),
          t("checklist.convenor_step3"),
        ],
      }
    : {
        heading: t("checklist.collaborator_heading"),
        steps: [
          t("checklist.collaborator_step1"),
          t("checklist.collaborator_step2"),
          t("checklist.collaborator_step3"),
        ],
      };

  return (
    <section
      className={`flex flex-wrap items-start justify-between gap-6 rounded-lg border border-border bg-surface px-[24px] py-[22px] ${className}`}
    >
      {/* Main column */}
      <div className="flex-1 min-w-[280px]">
        <p className="font-heading font-semibold text-xs uppercase tracking-wider text-caracol">
          {eyebrow}
        </p>
        <div className="mt-1 flex items-center gap-3 flex-wrap">
          <h1 className="font-heading font-semibold text-[28px] leading-[1.15] text-charcoal">
            {title}
          </h1>
          {/* Open the project's repo on GitHub. projectName is always the
              owner/repo full name, so the link is valid in every state. */}
          <a
            href={`https://github.com/${projectName}`}
            target="_blank"
            rel="noreferrer"
            aria-label={t("welcome.open_repo_github")}
            title={t("welcome.open_repo_github")}
            className="inline-flex items-center text-fg-muted hover:text-charcoal transition-colors"
          >
            <Github className="w-4 h-4" aria-hidden="true" />
          </a>
          {/* Role chip — only shown when the project has collaborators.
              A solo owner is "convenor" in the data but showing the label has
              no meaning until someone else joins (mirrors ConnectedSitesCard). */}
          {collaboratorCount > 0 && (
            <span
              className={`inline-flex items-center rounded-pill px-2.5 py-0.5 font-heading font-semibold text-xs ${roleChipClass}`}
            >
              {roleChipLabel}
            </span>
          )}
        </div>

        {/* Convened-by / created meta line */}
        <p className="mt-1 font-mono text-xs text-fg-muted">
          {collaboratorCount > 0
            ? t("welcome.convened_by", {
                convenor: convenorName,
                count: collaboratorCount,
                year: createdYear,
              })
            : t("welcome.created_year", { year: createdYear })}
        </p>

        {isEmpty ? (
          /* First-run: role-specific checklist (anil-pale box) */
          <div className="mt-4 rounded-lg bg-anil-pale px-[16px] py-[14px]">
            <p className="font-heading font-semibold text-xs uppercase tracking-wider text-anil-ink">
              {checklist.heading}
            </p>
            <ol className="mt-2 flex flex-col gap-2">
              {checklist.steps.map((stepText, i) => (
                <li key={i} className="flex gap-2 font-body text-sm text-charcoal">
                  <span className="font-heading font-semibold text-anil-ink shrink-0">
                    {i + 1}.
                  </span>
                  <span>{stepText}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          /* Populated: descriptive summary */
          <p className="mt-3 font-body text-sm text-charcoal">{summary}</p>
        )}
      </div>

      {/* Orientation action chips (right) — open the DocsDrawer. */}
      <div className="flex flex-col items-stretch gap-2 shrink-0">
        <button
          type="button"
          onClick={() => onOpenDoc?.("intro")}
          className="inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 font-heading font-semibold text-xs text-fg-muted hover:bg-anil-pale transition-colors"
        >
          <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
          {t("orientation.what_is_compositor")}
        </button>
        <button
          type="button"
          onClick={() => onOpenDoc?.("narrative")}
          className="inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 font-heading font-semibold text-xs text-fg-muted hover:bg-anil-pale transition-colors"
        >
          <Map className="w-3.5 h-3.5" aria-hidden="true" />
          {t("orientation.plan_narrative")}
        </button>
        {isConvenor && onAddCollaborators && (
          <button
            type="button"
            onClick={onAddCollaborators}
            className="inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 font-heading font-semibold text-xs bg-caracol-pale text-caracol hover:text-caracol-deep transition-colors"
          >
            <Users className="w-3.5 h-3.5" aria-hidden="true" />
            {t("orientation.add_collaborators")}
          </button>
        )}
      </div>
    </section>
  );
}
