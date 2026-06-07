/**
 * This file renders the kebab-menu popover primitive — the
 * vertical-three-dots trigger plus the floating menu that drops
 * out of it. Used by the Connected Sites row and any future
 * row-action surface that needs a compact "more actions" menu.
 *
 * Behaviour:
 *   - Click the trigger to toggle open. Outside-click closes
 *     (mirrors the `Header.tsx` user-menu pattern).
 *   - Escape closes and returns focus to the trigger.
 *   - On open, focus moves to the first non-disabled menu item.
 *   - Arrow Down / Arrow Up cycles through items, skipping
 *     disabled.
 *   - Enter / Space activates the focused item then closes.
 *   - Only one KebabMenu can be open at a time across the page
 *     (a module-scoped registry closes any previously-open menu
 *     when a new one opens).
 *
 * Accessibility:
 *   - Trigger has `aria-haspopup="menu"`, `aria-expanded`,
 *     `aria-label` (from the `ariaLabel` prop).
 *   - Popover has `role="menu"`; items have `role="menuitem"`.
 *   - Destructive items render with `text-terracotta` (NOT
 *     `bg-terracotta` — terracotta backgrounds are reserved for
 *     primary destructive CTAs).
 *
 * @version v1.3.0-beta
 */

import {
  useState,
  useRef,
  useEffect,
  useCallback,
  useId,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { MoreVertical } from "lucide-react";

export interface KebabMenuItem {
  label: string;
  onClick: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

export interface KebabMenuProps {
  items: KebabMenuItem[];
  ariaLabel: string;
  placement?: "bottom-end" | "bottom-start";
  className?: string;
}

// Module-scoped registry: only one KebabMenu open at a time.
let openCloser: (() => void) | null = null;

export function KebabMenu({
  items,
  ariaLabel,
  placement = "bottom-end",
  className = "",
}: KebabMenuProps) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();

  const close = useCallback(() => {
    setOpen(false);
    setFocusedIndex(-1);
  }, []);

  const closeAndReturnFocus = useCallback(() => {
    close();
    triggerRef.current?.focus();
  }, [close]);

  const handleToggle = useCallback(() => {
    setOpen((prev) => {
      const next = !prev;
      if (next) {
        // Close any other open menu first (single-open invariant).
        if (openCloser && openCloser !== close) {
          openCloser();
        }
        openCloser = close;
      } else if (openCloser === close) {
        openCloser = null;
      }
      return next;
    });
  }, [close]);

  // Outside-click + Escape close. Mirror Header.tsx:38-48 idiom.
  useEffect(() => {
    if (!open) return;

    function handleMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (
        popoverRef.current &&
        !popoverRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        close();
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeAndReturnFocus();
      }
    }

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, close, closeAndReturnFocus]);

  // On open: move focus to the first non-disabled item.
  useEffect(() => {
    if (!open) return;
    const firstEnabled = items.findIndex((it) => !it.disabled);
    if (firstEnabled === -1) return;

    const raf = requestAnimationFrame(() => {
      setFocusedIndex(firstEnabled);
      itemRefs.current[firstEnabled]?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, items]);

  // Cleanup the module registry on unmount.
  useEffect(() => {
    return () => {
      if (openCloser === close) openCloser = null;
    };
  }, [close]);

  function handleItemKeyDown(
    e: ReactKeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const direction = e.key === "ArrowDown" ? 1 : -1;
      const total = items.length;
      let next = index;
      // Skip disabled items; bail after a full loop to avoid infinite loop
      // when every item is disabled.
      for (let step = 0; step < total; step += 1) {
        next = (next + direction + total) % total;
        if (!items[next].disabled) break;
      }
      setFocusedIndex(next);
      itemRefs.current[next]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const item = items[index];
      if (item.disabled) return;
      item.onClick();
      closeAndReturnFocus();
    } else if (e.key === "Tab") {
      // Tab out closes the menu (focus naturally moves to next focusable).
      close();
    }
  }

  const placementClass =
    placement === "bottom-end" ? "right-0" : "left-0";

  return (
    <div className={`relative inline-block ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        onClick={handleToggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel}
        className="w-9 h-9 inline-flex items-center justify-center rounded-md text-charcoal hover:bg-cream"
      >
        <MoreVertical className="w-5 h-5" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={popoverRef}
          id={menuId}
          role="menu"
          className={`absolute ${placementClass} mt-1 bg-white border border-gray-200 rounded-lg shadow-lg py-1 min-w-[160px] z-50`}
        >
          {items.map((item, index) => (
            <button
              key={`${item.label}-${index}`}
              ref={(el) => {
                itemRefs.current[index] = el;
              }}
              type="button"
              role="menuitem"
              tabIndex={focusedIndex === index ? 0 : -1}
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                item.onClick();
                closeAndReturnFocus();
              }}
              onKeyDown={(e) => handleItemKeyDown(e, index)}
              className={`w-full text-left px-4 py-2 text-sm font-body hover:bg-cream focus:bg-cream ${
                item.destructive ? "text-terracotta" : "text-charcoal"
              } ${item.disabled ? "text-fg-disabled cursor-not-allowed" : ""}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
