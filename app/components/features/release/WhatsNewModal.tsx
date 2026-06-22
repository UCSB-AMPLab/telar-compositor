/**
 * WhatsNewModal — the once-per-release "What's new" login announcement. Pure
 * renderer: prose comes from the `release-notes` i18n namespace keyed by
 * CURRENT_RELEASE.i18nKey; contributor handles come from CURRENT_RELEASE
 * (omitted when empty). `_app.tsx` owns open-state + ack on dismiss.
 *
 * Styling mirrors the added-to-project welcome modal (cream panel, terracotta
 * CTA, charcoal overlay). Escape and overlay-click both dismiss.
 *
 * @version v1.3.7-beta
 */
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, Bug } from "lucide-react";
import { CURRENT_RELEASE } from "~/lib/release-notes";

export interface WhatsNewModalProps {
  open: boolean;
  onDismiss: () => void;
}

export function WhatsNewModal({ open, onDismiss }: WhatsNewModalProps) {
  const { t } = useTranslation("release-notes");

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onDismiss]);

  if (!open) return null;

  const k = CURRENT_RELEASE.i18nKey;
  const title = t(`${k}.title`);
  // Guard: if no content block exists for this release id, render nothing
  // rather than show raw keys (prevents shipping a version bump without copy).
  if (title === `${k}.title`) return null;

  // Coerce to arrays defensively: i18next returns the key string (not an array)
  // if a release block is present but missing features/fixes, which would throw
  // on .map(). The current block is guaranteed well-formed by the i18n parity
  // test; this guards a future version bump that adds copy incompletely.
  const featuresRaw = t(`${k}.features`, { returnObjects: true });
  const fixesRaw = t(`${k}.fixes`, { returnObjects: true });
  const features = Array.isArray(featuresRaw) ? (featuresRaw as string[]) : [];
  const fixes = Array.isArray(fixesRaw) ? (fixesRaw as string[]) : [];
  const contributors = CURRENT_RELEASE.contributors;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/50 p-4"
      onClick={onDismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85dvh] w-[420px] max-w-[90vw] flex-col gap-4 overflow-y-auto rounded-xl bg-cream p-6 shadow-lg"
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-pill bg-lavender text-terracotta">
          <Sparkles className="h-5 w-5" aria-hidden="true" />
        </div>
        <h2 id="whats-new-title" className="font-heading text-lg font-semibold text-charcoal">
          <span>{title}</span>
          <span className="font-normal opacity-60"> · v{CURRENT_RELEASE.id}</span>
        </h2>

        <section className="flex flex-col gap-1.5">
          <h3 className="font-heading text-sm font-semibold uppercase tracking-wide text-charcoal/60">
            {t(`${k}.features_label`)}
          </h3>
          <ul className="list-disc pl-5 font-body text-sm leading-relaxed text-charcoal/80">
            {features.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </section>

        <section className="flex flex-col gap-1.5">
          <h3 className="font-heading text-sm font-semibold uppercase tracking-wide text-charcoal/60">
            {t(`${k}.fixes_label`)}
          </h3>
          <ul className="list-disc pl-5 font-body text-sm leading-relaxed text-charcoal/80">
            {fixes.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </section>

        {contributors.length > 0 && (
          <div className="flex flex-col gap-2 font-body text-sm leading-relaxed text-charcoal/70">
            <p>
              {t(`${k}.thanks_label`)}{" "}
              {contributors.map((handle, i) => (
                <span key={handle}>
                  {i > 0 && ", "}
                  <a
                    href={`https://github.com/${handle}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-terracotta hover:underline"
                  >
                    @{handle}
                  </a>
                </span>
              ))}{" "}
              {t(`${k}.thanks_suffix`)}
            </p>
            <p>
              {t(`${k}.thanks_cta`)}{" "}
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-terracotta align-middle text-cream">
                <Bug className="h-3.5 w-3.5" aria-hidden="true" />
              </span>
            </p>
          </div>
        )}

        <div className="mt-1 flex items-center justify-end">
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-lg bg-terracotta px-4 py-1.5 font-heading text-sm font-semibold text-cream transition-colors hover:bg-terracotta-deep"
          >
            {t(`${k}.dismiss`)}
          </button>
        </div>
      </div>
    </div>
  );
}
