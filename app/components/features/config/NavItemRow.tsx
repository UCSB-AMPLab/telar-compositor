/**
 * NavItemRow — single draggable row in the NavigationEditor.
 *
 * Displays a nav item with drag handle, visibility toggle, editable label,
 * optional URL input (external links), and optional delete button (external links).
 * Built-in and page items have no delete button.
 */

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Eye, EyeOff, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface NavItemData {
  type: string;
  slug?: string;
  key?: string;
  url?: string;
  label: string;
  visible: boolean;
}

interface NavItemRowProps {
  item: NavItemData;
  sortableId: string;
  onLabelChange: (newLabel: string) => void;
  onUrlChange?: (newUrl: string) => void;
  onVisibilityToggle: () => void;
  onDelete?: () => void;
}

export function NavItemRow({
  item,
  sortableId,
  onLabelChange,
  onUrlChange,
  onVisibilityToggle,
  onDelete,
}: NavItemRowProps) {
  const { t } = useTranslation("config");
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: sortableId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  const isHidden = !item.visible;
  const isExternal = item.type === "external";

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 px-3 py-2 border-b border-gray-100 hover:bg-cream-dark/50 ${isDragging ? "opacity-50" : ""}`}
    >
      {/* Drag handle */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={t("drag_reorder_aria")}
        className="flex-shrink-0 p-1 text-gray-400 hover:text-gray-600 cursor-grab active:cursor-grabbing touch-none"
        style={{ minWidth: "44px", minHeight: "32px", display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        <GripVertical className="w-5 h-5" />
      </button>

      {/* Visibility toggle */}
      <button
        type="button"
        onClick={onVisibilityToggle}
        aria-label={isHidden ? t("show_nav_aria") : t("hide_nav_aria")}
        className="flex-shrink-0 p-1 text-gray-400 hover:text-gray-600 transition-colors"
      >
        {isHidden ? (
          <EyeOff className="w-4 h-4" />
        ) : (
          <Eye className="w-4 h-4 text-charcoal" />
        )}
      </button>

      {/* Label + URL inputs */}
      <div className="flex-1 min-w-0">
        <input
          type="text"
          value={item.label}
          onChange={(e) => onLabelChange(e.target.value)}
          className={`w-full font-body text-sm border-none bg-transparent px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-periwinkle rounded ${isHidden ? "text-gray-400" : "text-charcoal"}`}
          placeholder={item.type === "page" ? item.slug ?? "" : item.key ?? ""}
        />
        {isExternal && (
          <input
            type="text"
            value={item.url ?? ""}
            onChange={(e) => onUrlChange?.(e.target.value)}
            placeholder={t("external_link_url_placeholder")}
            className="w-full font-body text-xs text-gray-500 border-none bg-transparent px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-periwinkle rounded mt-0.5"
          />
        )}
      </div>

      {/* Delete button (external links only) */}
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          aria-label={t("remove_link_aria")}
          className="flex-shrink-0 p-1 text-red-400 hover:text-red-600 transition-colors"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </div>
  );
}
