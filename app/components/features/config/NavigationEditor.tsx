/**
 * NavigationEditor — draggable navigation list for the config page.
 *
 * Reads the Yjs navigation array from the config map and renders a vertically
 * sortable list of nav items. Supports visibility toggling, label editing,
 * external link management (add / delete), and drag-to-reorder — all written
 * back to Yjs.
 *
 * Used inside a ConfigSection on _app.config.tsx.
 */

import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import * as Y from "yjs";

import { useCollaborationContext } from "~/hooks/use-collaboration";
import { NavItemRow, type NavItemData } from "~/components/features/config/NavItemRow";
import { DeleteConfirmationModal } from "~/components/ui/DeleteConfirmationModal";

export function NavigationEditor() {
  const { t } = useTranslation("config");
  const { ydoc, isPublishing } = useCollaborationContext();

  const [deleteIndex, setDeleteIndex] = useState<number | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 10 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Read nav items from Yjs
  const getNavArray = useCallback((): Y.Array<unknown> | null => {
    if (!ydoc) return null;
    const config = ydoc.getMap<unknown>("config");
    const nav = config.get("navigation");
    return nav instanceof Y.Array ? nav : null;
  }, [ydoc]);

  const getItems = (): NavItemData[] => {
    const navArray = getNavArray();
    if (!navArray) return [];
    return navArray.toArray() as NavItemData[];
  };

  const items = getItems();
  const sortableIds = items.map((_, i) => String(i));

  // Drag end — reorder in Y.Array
  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = parseInt(String(active.id));
    const newIndex = parseInt(String(over.id));
    if (isNaN(oldIndex) || isNaN(newIndex)) return;

    const navArray = getNavArray();
    if (!navArray || !ydoc) return;

    ydoc.transact(() => {
      const item = navArray.get(oldIndex);
      navArray.delete(oldIndex, 1);
      navArray.insert(newIndex, [item]);
    });
  }

  // Write a field update back to the Y.Array at given index
  function updateItem(index: number, patch: Partial<NavItemData>) {
    const navArray = getNavArray();
    if (!navArray || !ydoc) return;
    ydoc.transact(() => {
      const existing = navArray.get(index) as NavItemData;
      navArray.delete(index, 1);
      navArray.insert(index, [{ ...existing, ...patch }]);
    });
  }

  function handleLabelChange(index: number, newLabel: string) {
    updateItem(index, { label: newLabel });
  }

  function handleUrlChange(index: number, newUrl: string) {
    updateItem(index, { url: newUrl });
  }

  function handleVisibilityToggle(index: number) {
    const item = items[index];
    if (!item) return;
    updateItem(index, { visible: !item.visible });
  }

  function handleAddExternalLink() {
    const navArray = getNavArray();
    if (!navArray || !ydoc) return;
    ydoc.transact(() => {
      navArray.push([{ type: "external", url: "", label: "", visible: true }]);
    });
  }

  function handleDeleteConfirm() {
    if (deleteIndex === null) return;
    const navArray = getNavArray();
    if (!navArray || !ydoc) return;
    ydoc.transact(() => {
      navArray.delete(deleteIndex, 1);
    });
    setDeleteIndex(null);
  }

  // Recalculate sortable IDs after items change (items index → string ID mapping)
  const itemsWithIds = items.map((item, i) => ({
    item,
    id: String(i),
  }));

  return (
    <div className={isPublishing ? "opacity-50 pointer-events-none" : ""}>
      {items.length === 0 ? (
        <p className="font-body text-sm text-gray-400 py-2">
          {/* Built-ins should always be present — this state is a fallback */}
          {t("navigation_section")}
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={itemsWithIds.map((x) => x.id)}
            strategy={verticalListSortingStrategy}
          >
            <div className="border border-gray-100 rounded-lg overflow-hidden">
              {itemsWithIds.map(({ item, id }, index) => (
                <NavItemRow
                  key={id}
                  item={item}
                  sortableId={id}
                  onLabelChange={(newLabel) => handleLabelChange(index, newLabel)}
                  onUrlChange={
                    item.type === "external"
                      ? (newUrl) => handleUrlChange(index, newUrl)
                      : undefined
                  }
                  onVisibilityToggle={() => handleVisibilityToggle(index)}
                  onDelete={
                    item.type === "external"
                      ? () => setDeleteIndex(index)
                      : undefined
                  }
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      )}

      {/* Add external link */}
      <button
        type="button"
        onClick={handleAddExternalLink}
        disabled={isPublishing}
        className="mt-3 text-sm font-body text-charcoal/60 hover:text-charcoal underline transition-colors disabled:opacity-40"
      >
        {t("add_external_link")}
      </button>

      {/* Delete confirmation modal */}
      <DeleteConfirmationModal
        open={deleteIndex !== null}
        onClose={() => setDeleteIndex(null)}
        onConfirm={handleDeleteConfirm}
        entityType="page"
        entityLabel={deleteIndex !== null ? (items[deleteIndex]?.label || t("add_external_link")) : ""}
        contentSummary={t("delete_nav_item_confirm")}
      />
    </div>
  );
}
