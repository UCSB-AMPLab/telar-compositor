/**
 * EditorShell — responsive layout wrapper for the story editor.
 *
 * Escapes the app shell's `p-6` padding with `-m-6` to take the full available
 * height below the header + tab nav, leaving calc(100dvh - 6rem) for the editor.
 *
 * Three responsive tiers (mobile-first):
 *  - Phone (< sm): steps live in a slide-over drawer; the narrative and viewer
 *    stack vertically (narrative on top, image below) and the region scrolls.
 *  - Tablet portrait (sm–lg): steps drawer + narrative and viewer side-by-side.
 *  - Desktop / landscape (lg+): the classic three columns — static 200px step
 *    sidebar + narrative (1/3) + viewer (remainder).
 *
 * When `hideViewer` is true (title card) the narrative fills the content area
 * and no viewer pane is shown.
 *
 * On a phone held in portrait (< sm, coarse pointer) a dismissible hint nudges
 * the user to rotate to landscape, where crossing the `sm` breakpoint promotes
 * the stacked layout to the side-by-side Write/View columns. The hint only
 * shows where rotating actually upgrades the layout — i.e. when the viewer is
 * present — and stays dismissed for the rest of the session.
 *
 * Once in `landscape-compact` (phone landscape: short + touch) the surrounding
 * shell slims the header and hides the tab nav, so this shell reclaims that
 * space by growing to `100dvh - 2.75rem` (header only) instead of the default
 * `100dvh - 6rem` (header + tab nav).
 *
 * @version v1.4.0-beta
 */

import React, { useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { PanelLeft, RotateCw, X } from "lucide-react";
import { useMediaQuery } from "~/hooks/use-media-query";

const ROTATE_HINT_DISMISSED_KEY = "telar:editor:rotate-hint-dismissed";

interface EditorShellProps {
  storyTitle: string;
  sidebar: React.ReactNode;
  narrative: React.ReactNode;
  viewer: React.ReactNode;
  hideViewer?: boolean;
}

export function EditorShell({ storyTitle, sidebar, narrative, viewer, hideViewer }: EditorShellProps) {
  const { t } = useTranslation("editor");
  // Open the steps drawer by default so its importance is obvious on entering
  // the editor. It only renders below `lg` (the desktop sidebar is always
  // visible), and `closeDrawerOnTap` dismisses it the moment the user picks a
  // step or taps the content, so it reveals the steps without getting in the way.
  const [drawerOpen, setDrawerOpen] = useState(true);

  // Rotate-to-landscape nudge: only a phone-sized portrait touch screen, and
  // only while the viewer is on screen (where rotating swaps the cramped stack
  // for side-by-side columns). Dismissal persists for the session so it never
  // nags — once the user rotates, the media query stops matching anyway.
  const isPortraitPhone = useMediaQuery(
    "(max-width: 639px) and (orientation: portrait) and (pointer: coarse)"
  );
  const [rotateHintDismissed, setRotateHintDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.sessionStorage?.getItem(ROTATE_HINT_DISMISSED_KEY) === "1";
    } catch {
      // sessionStorage may be unavailable (private mode); treat as not dismissed
      return false;
    }
  });
  const showRotateHint = isPortraitPhone && !hideViewer && !rotateHintDismissed;
  const dismissRotateHint = () => {
    setRotateHintDismissed(true);
    try {
      window.sessionStorage?.setItem(ROTATE_HINT_DISMISSED_KEY, "1");
    } catch {
      /* sessionStorage may be unavailable (private mode); dismissal is best-effort */
    }
  };

  // Tapping a step, "add step", or any navigation inside the drawer reveals its
  // content, so close the drawer on tap. A `click` only fires on a real tap (not
  // a scroll, and not a press-and-hold drag via the dnd TouchSensor), so this
  // closes on selection without interfering with scrolling or reordering. Form
  // fields are excluded so the drawer can host inputs without snapping shut.
  const closeDrawerOnTap = (e: React.MouseEvent) => {
    const el = e.target as HTMLElement;
    if (el.closest("input, textarea, select, [contenteditable]")) return;
    setDrawerOpen(false);
  };

  return (
    <div className="-m-6 flex flex-col h-[calc(100dvh-6rem)] landscape-compact:h-[calc(100dvh-2.75rem)]">
      {/* Breadcrumb / toolbar bar */}
      <div className="flex items-center gap-2 px-2 sm:px-4 py-2 bg-charcoal text-cream text-sm font-body shrink-0">
        {/* Steps drawer toggle — below lg only */}
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="lg:hidden inline-flex items-center justify-center min-w-11 min-h-11 -my-1 rounded text-cream/80 hover:text-cream hover:bg-white/10 transition-colors"
          aria-label={t("shell.steps_open")}
        >
          <PanelLeft className="w-5 h-5" />
        </button>

        <Link to="/dashboard" className="hover:underline shrink-0">
          {t("breadcrumb.dashboard")}
        </Link>
        <span className="text-cream/50">›</span>
        <span className="truncate">{storyTitle || t("breadcrumb.untitled")}</span>
      </div>

      {/* Rotate-to-landscape nudge (phone portrait only) */}
      {showRotateHint && (
        <div className="flex items-center gap-2 px-3 py-2 bg-lavender text-charcoal text-sm font-body shrink-0">
          <RotateCw className="w-4 h-4 shrink-0" />
          <span className="flex-1 leading-snug">{t("shell.rotate_hint")}</span>
          <button
            type="button"
            onClick={dismissRotateHint}
            className="inline-flex items-center justify-center min-w-11 min-h-11 -my-1 rounded text-charcoal/70 hover:text-charcoal hover:bg-black/5 transition-colors"
            aria-label={t("shell.rotate_hint_dismiss")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Column area */}
      <div className="relative flex flex-1 overflow-hidden">
        {/* Steps: static 200px column on lg+ */}
        <div className="hidden lg:block w-[200px] shrink-0 bg-charcoal border-r border-gray-700 overflow-y-auto">
          {sidebar}
        </div>

        {/* Steps drawer (below lg): backdrop + slide-over panel */}
        <div
          className={`lg:hidden absolute inset-0 z-30 bg-black/60 transition-opacity ${
            drawerOpen ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
          onClick={() => setDrawerOpen(false)}
          aria-hidden="true"
        />
        <div
          className={`lg:hidden absolute inset-y-0 left-0 z-40 w-[260px] max-w-[80%] bg-charcoal border-r border-gray-700 overflow-y-auto shadow-xl transition-transform duration-200 ${
            drawerOpen ? "translate-x-0" : "-translate-x-full"
          }`}
          onClick={closeDrawerOnTap}
          role="dialog"
          aria-label={t("shell.steps_open")}
        >
          <div className="flex items-center justify-between gap-2 pl-4 pr-2 py-1.5 sticky top-0 bg-charcoal border-b border-gray-700 z-10">
            <span className="font-heading font-semibold text-xs uppercase tracking-wider text-cream/70">
              {t("shell.steps_heading")}
            </span>
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              className="inline-flex items-center justify-center min-w-11 min-h-11 rounded text-cream/70 hover:text-cream hover:bg-white/10 transition-colors"
              aria-label={t("shell.steps_close")}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          {sidebar}
        </div>

        {/* Content. Phone (< sm): narrative and viewer STACK and the region
            scrolls. Tablet+ (sm–lg): side-by-side columns. Desktop (lg+): the
            static sidebar above + narrative (1/3) + viewer. Wrapped so the
            absolute steps drawer stays put while this region scrolls on phones. */}
        {hideViewer ? (
          /* Title card: narrative fills remaining space */
          <div className="flex-1 min-w-0 overflow-y-auto">{narrative}</div>
        ) : (
          <div className="flex flex-1 min-w-0 flex-col sm:flex-row overflow-y-auto sm:overflow-hidden">
            {/* Narrative (Text) */}
            <div className="sm:basis-1/2 lg:basis-1/3 sm:shrink-0 sm:overflow-y-auto">
              {narrative}
            </div>

            {/* Viewer (Image) — fixed height when stacked so it stays usable;
                fills its column on tablet and up. */}
            <div className="relative bg-charcoal-deep min-h-[60dvh] sm:min-h-0 sm:flex-1">
              {viewer}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
