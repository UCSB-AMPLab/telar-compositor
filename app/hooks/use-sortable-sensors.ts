/**
 * Shared dnd-kit sensor configuration for every sortable list in the compositor.
 *
 * Touch readiness: a bare PointerSensor — or one with only a `distance`
 * constraint — makes any finger-drag immediately start a reorder, hijacking
 * page/list scroll on tablets and phones (you can't scroll a sortable list
 * without grabbing an item). This hook splits by pointer type:
 *   - MouseSensor (distance 8px): desktop drag stays instant.
 *   - TouchSensor (delay 200ms, tolerance 8px): on touch a quick swipe scrolls,
 *     and a brief press-and-hold starts the drag — the standard mobile pattern.
 *   - KeyboardSensor: keeps keyboard reordering accessible.
 *
 * Replaces the five divergent inline sensor setups (NavigationEditor,
 * HomepageEditor, StepSidebar, _app.stories, _app.pages) with one shared config.
 *
 * @version v1.3.7-beta
 */
import {
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

export function useSortableSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );
}
