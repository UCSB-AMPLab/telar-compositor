/**
 * DocsLink — a small "Learn more →" affordance that opens the in-product
 * DocsDrawer in place (the drawer is owned by the _app shell; this button
 * calls the shell's openDoc via the route's Outlet context). Styled to match
 * the Start tab's tile-footer link.
 *
 * @version v1.3.0-beta
 */
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react";
import type { DocId } from "~/lib/docs-content";

export interface DocsLinkProps {
  docId: DocId;
  onOpenDoc: (id: DocId) => void;
  /** Visible label; defaults to the shared common.learn_more string. */
  label?: string;
  /** Accessible name override (e.g. "Learn more about objects"). Defaults to the visible label. */
  ariaLabel?: string;
  className?: string;
}

export function DocsLink({ docId, onOpenDoc, label, ariaLabel, className = "" }: DocsLinkProps) {
  const { t } = useTranslation("common");
  const text = label ?? t("learn_more");
  return (
    <button
      type="button"
      onClick={() => onOpenDoc(docId)}
      aria-label={ariaLabel ?? text}
      className={`inline-flex items-center gap-1 font-heading text-xs font-semibold uppercase tracking-wider text-anil-ink hover:underline ${className}`}
    >
      {text}
      <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}
