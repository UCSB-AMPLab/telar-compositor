/**
 * PagesSidebar — the left editing sidebar of the Pages route.
 *
 * Structure mirrors the glossary aside: an
 * `<aside>` with a convenor-gated "+ Add page" control and a `<ul>` of rows.
 * Selection is owned by the route (a `selectedKey` prop + `onSelect`
 * callback); this component renders the view and emits intents only.
 *
 * Three kinds of row:
 *   - Pinned Home row: rendered FIRST and NOT part of the sortable
 *     list — it is a separate axis (pinned for editing only; its published
 *     menu position is set in the nav simulator above). Shows a Home glyph,
 *     a Pin icon, and a hover tooltip explaining the mechanic.
 *   - Content page rows: sortable via `useSortable`, copying the row idiom
 *     from `SortablePageTab` (hover-revealed Trash2 guarded by `isConvenor`).
 *   - Untitled rows: pages with an empty title, labelled
 *     "Untitled — needs a title" with a delete affordance, but EXCLUDED from
 *     the sortable id list so they are never reorder targets.
 *
 * This component does NOT own the Yjs writes. The route builds the
 * `sidebarIdToFullIdx` map and supplies `onDragEnd` / `onDelete` / `onAddPage`
 * callbacks plus the DnD `sensors`.
 *
 * @version v1.3.0-beta
 */

import {
  DndContext,
  closestCenter,
  type DragEndEvent,
  type SensorDescriptor,
  type SensorOptions,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Home, Pin, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

/** The route-derived row data for a single content / untitled page. */
export interface PagesSidebarRow {
  /** Stable selection key (from `keyFor`). */
  selectKey: string;
  /** Stable dnd-kit sortable id (from the route's navSortableId scheme). */
  sortableId: string;
  /** Display label — the page title, or the untitled hint for empty titles. */
  label: string;
  /** True when the page has no title yet. */
  isUntitled: boolean;
  /** Whether the current user may delete this row. */
  canDelete: boolean;
}

/** Sentinel selection key for the pinned Home row. */
export const HOME_ROW_KEY = "__home__";

interface PagesSidebarProps {
  /** Titled content pages — sortable. */
  contentRows: PagesSidebarRow[];
  /** Untitled pages — listed with delete, excluded from the sortable axis. */
  untitledRows: PagesSidebarRow[];
  /** Currently-selected row key (HOME_ROW_KEY for the pinned Home row). */
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onDelete: (selectKey: string) => void;
  onAddPage: () => void;
  /** Sidebar reorder — resolved against the route's sidebarIdToFullIdx map. */
  onDragEnd: (event: DragEndEvent) => void;
  sensors: SensorDescriptor<SensorOptions>[];
  /** Convenor gate for add/delete affordances (UX hint only; server gates enforce). */
  isConvenor: boolean;
  /** Disable add when Yjs isn't ready. */
  canAdd: boolean;
  className?: string;
}

/** A single sortable content-page row. */
function SortableSidebarRow({
  row,
  isSelected,
  onSelect,
  onDelete,
  isConvenor,
}: {
  row: PagesSidebarRow;
  isSelected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  isConvenor: boolean;
}) {
  const { t } = useTranslation("pages");
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.sortableId });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <li ref={setNodeRef} style={style}>
      <div className="flex items-center group">
        <button
          type="button"
          onClick={onSelect}
          {...attributes}
          {...listeners}
          className={`flex-1 text-left px-4 py-3 font-body text-sm text-charcoal transition-colors truncate cursor-grab ${
            isSelected ? "bg-cream-dark font-semibold" : "hover:bg-cream-dark"
          } ${isDragging ? "cursor-grabbing" : ""}`}
        >
          {row.label}
        </button>
        {isConvenor && (
          <button
            type="button"
            aria-label={t("delete_page")}
            onClick={onDelete}
            disabled={!row.canDelete}
            className="pr-3 pl-1 py-3 text-gray-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity disabled:cursor-not-allowed disabled:text-gray-200"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
      </div>
    </li>
  );
}

export function PagesSidebar({
  contentRows,
  untitledRows,
  selectedKey,
  onSelect,
  onDelete,
  onAddPage,
  onDragEnd,
  sensors,
  isConvenor,
  canAdd,
  className = "",
}: PagesSidebarProps) {
  const { t } = useTranslation("pages");

  const homeSelected = selectedKey === HOME_ROW_KEY;

  return (
    <aside
      className={`w-60 border-r border-gray-200 flex flex-col h-full bg-cream shrink-0 ${className}`}
    >
      {/* Header: heading + convenor-gated Add page control */}
      <div className="p-3 border-b border-gray-200 space-y-3">
        <h2 className="font-heading text-xs font-semibold text-gray-400 uppercase tracking-wider">
          {t("sidebar_pages_heading")}
        </h2>
        {isConvenor && (
          <button
            type="button"
            onClick={onAddPage}
            disabled={!canAdd}
            className="inline-flex items-center gap-1.5 bg-anil hover:bg-anil-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-4 py-1.5 transition-colors disabled:bg-disabled disabled:text-fg-disabled disabled:cursor-not-allowed"
          >
            <Plus className="w-4 h-4" />
            {t("add_page")}
          </button>
        )}
      </div>

      <ul className="flex-1 overflow-y-auto" role="list">
        {/* Pinned Home row — first, NOT in the sortable context */}
        <li>
          <button
            type="button"
            onClick={() => onSelect(HOME_ROW_KEY)}
            title={t("home_pin_tooltip")}
            className={`w-full flex items-center gap-2 px-4 py-3 font-body text-sm text-charcoal transition-colors ${
              homeSelected ? "bg-cream-dark font-semibold" : "hover:bg-cream-dark"
            }`}
          >
            <Home className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span className="flex-1 text-left truncate">{t("nav_home")}</span>
            <Pin
              className="w-3.5 h-3.5 text-gray-400 shrink-0"
              aria-label={t("home_pin_tooltip")}
            />
          </button>
        </li>

        {/* Content page rows — sortable axis */}
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={contentRows.map((r) => r.sortableId)}
            strategy={verticalListSortingStrategy}
          >
            {contentRows.map((row) => (
              <SortableSidebarRow
                key={row.selectKey}
                row={row}
                isSelected={row.selectKey === selectedKey}
                onSelect={() => onSelect(row.selectKey)}
                onDelete={() => onDelete(row.selectKey)}
                isConvenor={isConvenor}
              />
            ))}
          </SortableContext>
        </DndContext>

        {/* Untitled rows — listed, deletable, NOT sortable */}
        {untitledRows.map((row) => {
          const isSelected = row.selectKey === selectedKey;
          return (
            <li key={row.selectKey}>
              <div className="flex items-center group">
                <button
                  type="button"
                  onClick={() => onSelect(row.selectKey)}
                  className={`flex-1 flex items-center gap-1.5 text-left px-4 py-3 font-body text-sm italic text-gray-500 transition-colors truncate ${
                    isSelected ? "bg-cream-dark" : "hover:bg-cream-dark"
                  }`}
                >
                  <span
                    className="inline-flex items-center justify-center text-xs not-italic font-body text-amber-800 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 flex-shrink-0"
                    aria-hidden="true"
                  >
                    !
                  </span>
                  <span className="truncate">{t("untitled_needs_title")}</span>
                </button>
                {isConvenor && (
                  <button
                    type="button"
                    aria-label={t("delete_page")}
                    onClick={() => onDelete(row.selectKey)}
                    disabled={!row.canDelete}
                    className="pr-3 pl-1 py-3 text-gray-400 hover:text-red-600 opacity-0 group-hover:opacity-100 transition-opacity disabled:cursor-not-allowed disabled:text-gray-200"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
