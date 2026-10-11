/**
 * The upgrade review's file-change cards.
 *
 * Each category of framework file an upgrade adds or changes gets an
 * expandable card listing its paths. Removals are shown in two groups. Telar's
 * development files, the test suite and copies of the upgrade tools that a
 * site made from the template carries and does not use, get a neutral card
 * with a sentence saying so. Every other removal stays on the red "Files to
 * remove" card, since that is the list an author needs to read before
 * upgrading. The grouping is for display only: the upgrade removes both.
 *
 * @version v1.5.3-beta
 */

import { useState } from "react";
import { ChevronDown, Wrench, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";

export function CategoryCard({
  icon: Icon,
  label,
  count,
  countLabel,
  files,
  variant = "default",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
  countLabel: string;
  files: string[];
  variant?: "default" | "danger";
}) {
  const [open, setOpen] = useState(false);
  const bg = variant === "danger" ? "bg-red-50" : "bg-cream-dark";
  const iconColor = variant === "danger" ? "text-red-400" : "text-terracotta";

  return (
    <div className={`${bg} rounded-lg overflow-hidden`}>
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:opacity-80 transition-opacity"
        onClick={() => setOpen((o) => !o)}
      >
        <Icon className={`w-4 h-4 ${iconColor} shrink-0`} />
        <div className="min-w-0 flex-1">
          <p className="font-heading font-semibold text-xs text-charcoal leading-tight">
            {label}
          </p>
          <p className="font-body text-xs text-gray-500">{countLabel}</p>
        </div>
        <ChevronDown className={`w-3 h-3 text-gray-400 shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && files.length > 0 && (
        <div className="px-3 pb-2">
          <ul className="font-body text-xs text-gray-600 space-y-0.5">
            {files.map((f) => (
              <li key={f} className="truncate" title={f}>
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The review summary's cards for files the upgrade removes: the paths the
 * release no longer carries, and Telar's own development files. Each shows
 * only when it has files.
 */
export function DeletionCards({ filesByCategory }: { filesByCategory: Record<string, string[]> }) {
  const { t } = useTranslation("upgrade");
  const deletions = filesByCategory?.deletions ?? [];
  const devFiles = filesByCategory?.devFiles ?? [];
  return (
    <>
      {deletions.length > 0 && (
        <CategoryCard
          icon={XCircle}
          label={t("deletions")}
          count={deletions.length}
          countLabel={t("fileCount", { count: deletions.length })}
          files={deletions}
          variant="danger"
        />
      )}
      {devFiles.length > 0 && (
        <CategoryCard
          icon={Wrench}
          label={t("devFiles")}
          count={devFiles.length}
          countLabel={t("devFilesCount", { count: devFiles.length })}
          files={devFiles}
        />
      )}
    </>
  );
}

/** The line under the cards that says what Telar's development files are. */
export function DevFilesHint({ devFiles }: { devFiles: string[] | undefined }) {
  const { t } = useTranslation("upgrade");
  if ((devFiles?.length ?? 0) === 0) return null;
  return <p className="font-body text-xs text-gray-500 mt-2">{t("devFilesHint")}</p>;
}
