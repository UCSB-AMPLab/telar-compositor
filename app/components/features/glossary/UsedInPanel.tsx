/**
 * UsedInPanel — the term edit-panel "Used in" section.
 *
 * Renders the TermRef[] rows produced by `buildTermRefIndex` for the selected
 * term. Three row shapes, one per surface:
 *   - story    → `<story title> · Step N · Layer M` (via `used_in_story_ref`)
 *   - page     → `Page: <title>` (via `used_in_page_ref`)
 *   - glossary → `Term: <title>` (via `used_in_term_ref`, a cross-reference)
 * Each row label is a single interpolated i18n string so word order localizes;
 * a missing title falls back to the translated `common:untitled`.
 *
 * Each row is a jump affordance:
 *   - story    → navigate to `/stories/<id>?step=N&layer=M` (we emit the
 *     `?step`/`?layer` params here even though the deep-link read is consumed
 *     by the stories route)
 *   - page     → navigate to `/pages/<slug>`
 *   - glossary → in-route select via `onSelectTerm(refTermId)` — no navigation
 *
 * Zero references render the `not_used` "Not used yet" tag on a neutral
 * cream-dark / vicuña tag (not a warning colour). The header uses the
 * `used_in_n` ICU plural.
 *
 * Pure presentation over the already-tested ref index — no scanning
 * here; the route passes the resolved `refs` for the selected term.
 *
 * @version v1.3.6-beta
 */

import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import type { TermRef } from "~/lib/glossary-refs";

interface UsedInPanelProps {
  /** The TermRef[] for the selected term (from buildTermRefIndex), or []. */
  refs: TermRef[];
  /** In-route select of another glossary term (cross-ref jump). */
  onSelectTerm: (termId: string) => void;
  className?: string;
}

export function UsedInPanel({ refs, onSelectTerm, className = "" }: UsedInPanelProps) {
  const { t } = useTranslation("glossary");
  const navigate = useNavigate();

  return (
    <section className={className}>
      <h3 className="font-heading text-xs font-semibold text-fg-muted uppercase tracking-wider mb-2">
        {refs.length === 0
          ? t("used_in")
          : t("used_in_n", { count: refs.length })}
      </h3>

      {refs.length === 0 ? (
        <span className="inline-block font-body text-xs text-charcoal/70 bg-cream-dark rounded-full px-2.5 py-1">
          {t("not_used")}
        </span>
      ) : (
        <ul className="space-y-1" role="list">
          {refs.map((ref, i) => {
            if (ref.kind === "story") {
              return (
                <li key={`story-${i}`}>
                  <button
                    type="button"
                    onClick={() =>
                      navigate(
                        `/stories/${encodeURIComponent(ref.storyId)}?step=${ref.stepNumber}&layer=${ref.layerNumber}`,
                      )
                    }
                    className="w-full text-left font-body text-sm text-charcoal hover:text-anil-ink hover:underline truncate"
                  >
                    {t("used_in_story_ref", {
                      title: ref.storyTitle || t("common:untitled"),
                      step: ref.stepNumber,
                      layer: ref.layerNumber,
                    })}
                  </button>
                </li>
              );
            }
            if (ref.kind === "page") {
              return (
                <li key={`page-${i}`}>
                  <button
                    type="button"
                    onClick={() => navigate(`/pages/${encodeURIComponent(ref.pageSlug)}`)}
                    className="w-full text-left font-body text-sm text-charcoal hover:text-anil-ink hover:underline truncate"
                  >
                    {t("used_in_page_ref", { title: ref.pageTitle || t("common:untitled") })}
                  </button>
                </li>
              );
            }
            // glossary cross-ref → in-route select (no navigation)
            return (
              <li key={`gloss-${i}`}>
                <button
                  type="button"
                  onClick={() => onSelectTerm(ref.refTermId)}
                  className="w-full text-left font-body text-sm text-charcoal hover:text-anil-ink hover:underline truncate"
                >
                  {t("used_in_term_ref", { title: ref.refTermTitle || t("common:untitled") })}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
