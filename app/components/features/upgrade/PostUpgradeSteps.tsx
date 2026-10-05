/**
 * The upgrade's manual steps on the done stage: which a Compositor user sees,
 * and how they are grouped by what they ask of the reader.
 *
 * @version v1.5.0-beta
 */
import { ExternalLink } from "lucide-react";
import { marked } from "marked";
import { useTranslation } from "react-i18next";
import type { ManualStep } from "~/lib/manifest-schema.server";
import { sanitiseHtml } from "~/lib/sanitise-html";

/**
 * Filter post-upgrade manual steps to those relevant for this compositor
 * viewer. Rules:
 *   - no audience / "all"           → show
 *   - "compositor"                   → show
 *   - "google-sheets"                → show only if the site has GS enabled
 *   - "local"                        → hide (covered automatically by compositor)
 *   - anything else (an audience this build doesn't recognise)
 *                                     → show
 *
 * The last rule matters as much as the first four: `audience` is validated
 * against a known-values allowlist only for its *type*, not its value (see
 * manifest-schema.server.ts) — a manifest may legitimately name an audience
 * newer than this build knows about. Hiding such a step here would silently
 * turn a validation gap into a filtering one: the step would pass
 * validation but never be seen by anyone. Exported as a top-level pure
 * function (rather than a closure over component state) so it is directly
 * testable.
 */
export function isStepVisible(
  step: ManualStep,
  googleSheetsEnabled: boolean,
): boolean {
  const a = step.audience;
  if (!a || a === "all" || a === "compositor") return true;
  if (a === "local") return false;
  if (a === "google-sheets") return googleSheetsEnabled;
  return true; // unrecognised audience: err towards showing
}

/** The visible steps of an upgrade, grouped by what they ask of the reader. */
export interface GroupedSteps {
  actions: ManualStep[];
  optional: ManualStep[];
  /** No kind, or one this build does not know: shown, and never folded into the notes. */
  unclassified: ManualStep[];
  notes: ManualStep[];
}

/**
 * Filters by audience first, then groups by kind. Only actions,
 * optional steps and unclassified ones can stand between the reader and "no
 * manual steps required"; a step whose kind is unknown may ask for something,
 * so it is never counted as a note.
 */
export function groupManualSteps(steps: ManualStep[], googleSheetsEnabled: boolean): GroupedSteps {
  const grouped: GroupedSteps = { actions: [], optional: [], unclassified: [], notes: [] };
  for (const step of steps) {
    if (!isStepVisible(step, googleSheetsEnabled)) continue;
    if (step.kind === "action") grouped.actions.push(step);
    else if (step.kind === "optional") grouped.optional.push(step);
    else if (step.kind === "note") grouped.notes.push(step);
    else grouped.unclassified.push(step);
  }
  return grouped;
}

function StepBody({ step }: { step: ManualStep }) {
  const { t } = useTranslation("upgrade");
  return (
    <>
      <div
        dangerouslySetInnerHTML={{
          // Manual-step descriptions come from bundled / release-asset
          // manifests authored by the framework maintainer; route through
          // sanitiseHtml to harden against an upstream compromise.
          __html: sanitiseHtml(marked.parse(step.description, { async: false, gfm: true }) as string),
        }}
      />
      {step.doc_url && (
        <a
          href={step.doc_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 font-body text-xs text-blue-600 hover:underline"
        >
          {t("manualStepsDocLink")}
          <ExternalLink className="w-3 h-3" />
        </a>
      )}
    </>
  );
}

function StepList({ steps, ordered = false }: { steps: ManualStep[]; ordered?: boolean }) {
  const items = steps.map((step, i) => (
    <li key={i} className="font-body text-sm text-charcoal">
      <StepBody step={step} />
    </li>
  ));
  return ordered ? (
    <ol className="list-decimal pl-6 space-y-3">{items}</ol>
  ) : (
    <ul className="list-disc pl-6 space-y-3">{items}</ul>
  );
}

/**
 * The done stage's account of the upgrade's manual steps: what the reader may
 * need to do, as a numbered list; what they may do; what could not be
 * classified; and what changed, folded away with a count.
 */
export function PostUpgradeSteps({ steps, googleSheetsEnabled }: { steps: ManualStep[]; googleSheetsEnabled: boolean }) {
  const { t } = useTranslation("upgrade");
  const { actions, optional, unclassified, notes } = groupManualSteps(steps, googleSheetsEnabled);
  const nothingToDo = actions.length + optional.length + unclassified.length === 0;
  return (
    <section className="bg-cream-dark rounded-lg p-4 mb-6 space-y-4">
      <h3 className="font-heading font-semibold text-sm text-charcoal">{t("manualStepsHeading")}</h3>
      {nothingToDo && <p className="font-body text-xs text-gray-600">{t("manualStepsEmpty")}</p>}
      {actions.length > 0 && (
        <div>
          <p className="font-body text-sm text-charcoal mb-3">{t("manualStepsIntro")}</p>
          <StepList steps={actions} ordered />
        </div>
      )}
      {optional.length > 0 && (
        <div>
          <p className="font-body text-sm text-charcoal mb-3">{t("manualStepsOptionalIntro")}</p>
          <StepList steps={optional} />
        </div>
      )}
      {unclassified.length > 0 && (
        <div>
          <h4 className="font-heading font-semibold text-sm text-charcoal mb-1">
            {t("manualStepsUnclassifiedHeading")}
          </h4>
          <p className="font-body text-sm text-charcoal mb-3">{t("manualStepsUnclassifiedIntro")}</p>
          <StepList steps={unclassified} />
        </div>
      )}
      {notes.length > 0 && (
        <details>
          <summary className="font-heading font-semibold text-sm text-charcoal cursor-pointer">
            {t("manualStepsNotesToggle", { count: notes.length })}
          </summary>
          <div className="mt-3">
            <StepList steps={notes} />
          </div>
        </details>
      )}
    </section>
  );
}
