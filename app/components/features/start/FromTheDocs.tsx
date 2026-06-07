/**
 * FromTheDocs — the role/state-aware "From the docs" reading list.
 *
 * A full-width card with a section heading + hint and a tile grid. The docs
 * come from the role×state reading-list table. Each tile shows a lucide icon
 * (anil-deep), heading, description, and a source line (doc href).
 * Titles/descriptions follow the compositor's chosen UI language. Clicking a
 * tile calls onOpenDoc(docId) — it opens the DocsDrawer overlay, it does NOT
 * navigate (the tiles are buttons, never links).
 *
 * Design tokens only — no hardcoded hex.
 *
 * @version v1.3.0-beta
 */

import { Trans, useTranslation } from "react-i18next";
import {
  BookOpen,
  Compass,
  FileText,
  Image as ImageIcon,
  Map as MapIcon,
  RefreshCw,
  Upload,
  Video,
  Wand2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { DOCS, type DocId } from "~/lib/docs-content";

export interface FromTheDocsProps {
  role: "convenor" | "collaborator";
  state: "populated" | "empty";
  onOpenDoc: (docId: DocId) => void;
  className?: string;
}

/**
 * Reading lists — five docs in order per role×state cell. Five items so the
 * six workflow areas are all covered, and so Configuration / Custom pages /
 * Glossary appear.
 */
const READING_LISTS: Record<
  "convenor" | "collaborator",
  Record<"populated" | "empty", DocId[]>
> = {
  collaborator: {
    empty: ["intro", "narrative", "stories", "markdown", "glossary"],
    populated: ["stories", "markdown", "video", "glossary", "narrative"],
  },
  convenor: {
    empty: ["start", "configure", "objects", "narrative", "iiif"],
    populated: ["stories", "refine", "publish", "pages", "sync"],
  },
};

/** Per-doc tile icon (lucide). All tinted anil-deep. */
const DOC_ICON: Record<DocId, LucideIcon> = {
  configure: Compass,
  objects: ImageIcon,
  stories: BookOpen,
  glossary: BookOpen,
  pages: FileText,
  publish: Upload,
  intro: Compass,
  iiif: ImageIcon,
  start: Compass,
  narrative: MapIcon,
  markdown: FileText,
  refine: Wand2,
  video: Video,
  sync: RefreshCw,
};

export function FromTheDocs({ role, state, onOpenDoc, className = "" }: FromTheDocsProps) {
  const { t, i18n } = useTranslation("start");
  // Titles follow the compositor's chosen UI language (descriptions already do,
  // via the from_docs.desc_* keys).
  const isEs = i18n.language?.toLowerCase().startsWith("es");
  const docIds = READING_LISTS[role][state];

  return (
    <section
      className={`rounded-lg border border-border bg-surface px-[28px] py-[24px] ${className}`}
    >
      <div className="mb-4">
        <h2 className="font-heading text-xs font-semibold uppercase tracking-wider text-fg-muted">
          {t("section.from_the_docs")}
        </h2>
        <p className="font-body text-sm italic text-fg-subtle">
          <Trans
            ns="start"
            i18nKey="from_docs.hint"
            components={{
              docsLink: (
                <a
                  href="https://telar.org/docs"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-anil-ink underline"
                />
              ),
            }}
          />
        </p>
      </div>

      {/* 5-up tile grid, 10px gap (design-locked exception). */}
      <div className="grid grid-cols-1 gap-[10px] sm:grid-cols-2 lg:grid-cols-5">
        {docIds.map((id) => {
          const doc = DOCS[id];
          const Icon = DOC_ICON[id];
          return (
            <button
              key={id}
              type="button"
              data-doc-tile={id}
              onClick={() => onOpenDoc(id)}
              className="group flex flex-col gap-2 rounded-lg border border-border bg-surface px-[16px] py-[14px] text-left transition-colors hover:border-border-strong hover:bg-cream"
            >
              <Icon className="h-4 w-4 text-anil-deep" aria-hidden="true" />
              <span className="font-heading text-sm font-semibold text-charcoal">
                {isEs ? doc.titleEs : doc.titleEn}
              </span>
              <span className="font-body text-xs text-fg-muted">{t(`from_docs.desc_${id}`)}</span>
              <span className="mt-1 flex items-center font-mono text-xs text-fg-subtle">
                <span className="truncate">{doc.href}</span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
