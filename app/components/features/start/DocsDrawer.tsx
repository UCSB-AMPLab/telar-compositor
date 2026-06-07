/**
 * DocsDrawer — the in-product Docs experience.
 *
 * A right-edge slide-in (540px) that renders a vendored telar-docs slice
 * inline, so the user never leaves the compositor to read a doc. Chrome:
 * breadcrumb, drawer title + circular close button (localised aria-label),
 * an actions row ("Open on telar.org" escape hatch + "Next" link), a
 * scrollable sanitised body, and a "See also" list. The doc renders in the
 * compositor's chosen UI language (i18n.language) — no per-panel picker.
 *
 * Overlay/Escape/overlay-click-close is adapted from ui/Dialog.tsx, but the
 * geometry is a right-edge panel with a FLAT backdrop rgba(0,0,0,0.08) — NO
 * backdrop-blur.
 *
 * XSS gate: the doc body is rendered ONLY via the canonical pipeline
 * `sanitiseHtml(marked.parse(body, { async: false, gfm: true }))` before
 * dangerouslySetInnerHTML — never raw. The bodies are build-time vendored
 * (trusted source), but the sanitiser is defence-in-depth and the locked
 * Workers-safe policy.
 *
 * Reverse-tabnabbing: the "Open on telar.org ↗" anchor opens in a new tab
 * with rel="noopener noreferrer".
 *
 * Design tokens only — no hardcoded hex.
 *
 * @version v1.3.0-beta
 */

import { useEffect, useMemo } from "react";
import { marked } from "marked";
import { useTranslation } from "react-i18next";
import { ArrowRight, BookOpen, ExternalLink, X } from "lucide-react";
import { sanitiseHtml } from "~/lib/sanitise-html";
import { DOCS as DEFAULT_DOCS, type DocId, type DocSlice } from "~/lib/docs-content";

type Locale = "en" | "es";

export interface DocsDrawerProps {
  /** Whether the drawer is open. Renders nothing when false. */
  open: boolean;
  /** Which DOC slice to show. null/unknown → renders nothing. */
  docId: DocId | null;
  onClose: () => void;
  /**
   * Swap the drawer to a different doc (used by "See also" links). When
   * omitted, See-also links fall back to opening telar.org in a new tab.
   */
  onOpenDoc?: (docId: DocId) => void;
  /** Override the doc source (tests inject a controlled map). */
  docs?: Partial<Record<DocId, DocSlice>>;
  className?: string;
}

/** Render a markdown body through the canonical sanitised pipeline (XSS gate). */
function renderDocBody(body: string): string {
  return sanitiseHtml(marked.parse(body, { async: false, gfm: true }) as string);
}

export function DocsDrawer({
  open,
  docId,
  onClose,
  onOpenDoc,
  docs = DEFAULT_DOCS,
  className = "",
}: DocsDrawerProps) {
  const { t, i18n } = useTranslation("start");
  // Docs render in the compositor's chosen UI language — there is no per-panel
  // language picker. Falls back to EN for any non-es locale.
  const locale: Locale = i18n.language?.toLowerCase().startsWith("es") ? "es" : "en";

  // Escape-key close (Dialog pattern). Hook order is fixed — declared before
  // any early return.
  useEffect(() => {
    if (!open) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  const doc = docId ? docs[docId] : undefined;

  const body = doc ? (locale === "en" ? doc.bodyEn : doc.bodyEs) : "";
  const html = useMemo(() => (body ? renderDocBody(body) : ""), [body]);

  if (!open || !doc) return null;

  const title = locale === "en" ? doc.titleEn : doc.titleEs;
  // Chapter for the breadcrumb: the segment after /docs/ (best-effort).
  const chapter = title;
  const seeAlso = (doc.seeAlso ?? []).filter((id) => docs[id]);
  const nextId = seeAlso[0];
  const nextDoc = nextId ? docs[nextId] : undefined;

  return (
    <>
      {/* Flat backdrop — rgba(0,0,0,0.08), NO blur. z-35. */}
      <div
        data-docs-backdrop
        className="fixed inset-0 z-[35] bg-[rgba(0,0,0,0.08)]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Right-edge slide-in panel — 540px, surface bg, border-left, shadow. z-40. */}
      <aside
        data-docs-drawer
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`fixed right-0 top-0 z-40 flex h-full w-[540px] max-w-full flex-col border-l border-border bg-surface shadow-[-20px_0_60px_rgba(0,0,0,0.08)] ${className}`}
      >
        {/* Chrome (cream bg, bottom border) */}
        <div className="border-b border-border bg-cream px-[24px] py-[16px]">
          {/* Breadcrumb */}
          <div className="flex items-center gap-1.5 font-mono text-xs text-fg-muted">
            <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
            <span>{t("drawer.breadcrumb", { chapter })}</span>
          </div>

          {/* Title row + close */}
          <div className="mt-2 flex items-start justify-between gap-3">
            <h2 className="font-heading text-[22px] font-semibold leading-tight text-charcoal">
              {title}
            </h2>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("drawer.close")}
              title={t("drawer.close")}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-pill text-fg-muted transition-colors hover:bg-cream-dark hover:text-charcoal"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>

          {/* Actions row */}
          <div className="mt-3 flex flex-wrap items-center gap-4">
            <a
              href={`https://telar.org${doc.href}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-heading text-xs font-semibold uppercase tracking-wider text-anil-ink hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              {t("drawer.open_on_telar")}
            </a>

            {nextDoc && onOpenDoc && nextId && (
              <button
                type="button"
                onClick={() => onOpenDoc(nextId)}
                className="font-heading text-xs font-semibold text-anil-ink hover:underline"
              >
                {t("drawer.next", {
                  title: locale === "en" ? nextDoc.titleEn : nextDoc.titleEs,
                })}
              </button>
            )}
          </div>
        </div>

        {/* Body (scroll) — sanitised markdown prose (XSS gate). */}
        <div className="flex-1 overflow-y-auto px-[24px] py-[20px]">
          <div
            className="docs-prose font-body text-sm leading-[1.6] text-charcoal [&_a]:text-anil-ink [&_a]:underline [&_code]:rounded [&_code]:bg-cream-dark [&_code]:px-1 [&_code]:font-mono [&_code]:text-xs [&_h2]:mt-4 [&_h2]:font-heading [&_h2]:text-base [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-heading [&_h3]:text-sm [&_h3]:uppercase [&_h3]:text-fg-muted [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:mt-2 [&_pre]:mt-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-cream-dark [&_pre]:p-3 [&_ul]:mt-2"
            dangerouslySetInnerHTML={{ __html: html }}
          />

          {/* See also */}
          {seeAlso.length > 0 && (
            <div className="mt-6 border-t border-border pt-4">
              <p className="font-heading text-xs font-semibold uppercase tracking-wider text-fg-muted">
                {t("drawer.see_also")}
              </p>
              <ul className="mt-2 flex flex-col gap-1">
                {seeAlso.map((id) => {
                  const related = docs[id]!;
                  const relTitle = locale === "en" ? related.titleEn : related.titleEs;
                  return (
                    <li key={id}>
                      {onOpenDoc ? (
                        <button
                          type="button"
                          onClick={() => onOpenDoc(id)}
                          className="inline-flex items-center gap-1.5 font-body text-sm text-anil-ink hover:underline"
                        >
                          <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          {relTitle}
                        </button>
                      ) : (
                        <a
                          href={`https://telar.org${related.href}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1.5 font-body text-sm text-anil-ink hover:underline"
                        >
                          <ArrowRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                          {relTitle}
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
