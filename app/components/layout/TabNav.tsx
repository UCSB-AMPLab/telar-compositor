/**
 * This file renders the horizontal tab navigation for the
 * authenticated shell — the bar of flat tabs (Start, Objects, Stories,
 * Glossary, Pages, Site settings, Publish) that sits directly under
 * the header, plus the right-aligned Site link to the published site
 * and a "Docs ↗" link. Start is the leftmost tab and the Atelier front
 * door (/start, the "/" target).
 *
 * Active tab: charcoal underline and text. Space Grotesk, uppercase,
 * xs. Tab icons are untinted — they inherit the tab's grey (inactive) or
 * charcoal (active) text colour, so the bar reads as a clean uniform strip
 * rather than a row of per-content-type accent tints.
 *
 * The Publish tab is hidden from collaborators (the convenor-only publish
 * action is surfaced to them elsewhere); Start is always visible to both
 * roles. Save status lives in the Site Status pill in the header, not here.
 * Presence dots: a coloured dot appears next to a tab label when a remote
 * collaborator is on that route.
 *
 * The global undo/redo cluster and its keyboard handler live here, never in
 * the header — they drive the shared Yjs UndoManager for non-editor
 * (structural) operations, distinct from the per-field undo inside text
 * editors.
 *
 * @version v1.3.7-beta
 */

import { useEffect, useRef, useState } from "react";
import { NavLink } from "react-router";
import { useTranslation } from "react-i18next";
import {
  Sparkles,
  Image,
  BookOpen,
  BookA,
  Settings,
  Upload,
  FileText,
  Globe,
  ArrowUpRight,
  Undo2,
  Redo2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { useUndoControls } from "~/hooks/use-undo-controls";
import { useIsConvenor } from "~/hooks/use-role";

interface Tab {
  key: string;
  to: string;
  icon: React.ElementType;
  labelKey: string;
}

const tabs: Tab[] = [
  { key: "start",    to: "/start",    icon: Sparkles, labelKey: "nav.start" }, // leftmost
  { key: "objects",  to: "/objects",  icon: Image,    labelKey: "nav.objects" },
  { key: "stories",  to: "/stories",  icon: BookOpen, labelKey: "nav.stories" },
  { key: "glossary", to: "/glossary", icon: BookA,    labelKey: "nav.glossary" },
  { key: "pages",    to: "/pages",    icon: FileText, labelKey: "nav.pages" },
  { key: "config",   to: "/config",   icon: Settings, labelKey: "nav.config" }, // label = "Site settings"
  { key: "publish",  to: "/publish",  icon: Upload,   labelKey: "nav.publish" },
];

interface TabNavProps {
  className?: string;
  pagesUrl?: string | null;
  /** Opens the shell DocsDrawer directly from the Docs link. */
  onOpenDoc?: (id: string) => void;
}

export function TabNav({ className = "", pagesUrl = null, onOpenDoc }: TabNavProps) {
  const { t } = useTranslation("common");
  const { t: tCollab } = useTranslation("collaboration");
  const { t: tStructural } = useTranslation("structural");
  const { remoteCollaborators } = useCollaborationContext();
  const { canUndo, canRedo, undo, redo } = useUndoControls();
  const isConvenor = useIsConvenor();

  // Horizontal-scroll affordance: when the tab strip overflows (narrow tablets
  // and phones, worse with longer Spanish labels) a right-edge fade signals
  // there are more tabs/utilities to swipe to.
  const navRef = useRef<HTMLElement>(null);
  const [showRightFade, setShowRightFade] = useState(false);
  const [showLeftFade, setShowLeftFade] = useState(false);
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const update = () => {
      setShowRightFade(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
      setShowLeftFade(el.scrollLeft > 4);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [pagesUrl]);

  // The Publish tab is hidden from collaborators (the "Ask convenor to
  // publish" affordance lives in the Site Status popover instead). This is UX
  // only — the server action stays convenor-gated.
  const visibleTabs = tabs.filter((tab) => tab.key !== "publish" || isConvenor);

  function getTabPresence(tabTo: string) {
    return remoteCollaborators.filter((c) => {
      if (!c.location?.route) return false;
      return c.location.route === tabTo || c.location.route.startsWith(tabTo + "/");
    });
  }

  // Global undo/redo shortcuts. CodeMirror inside MarkdownEditor binds the
  // shared UndoManager via yCollab — we delegate to it by returning early when the
  // keydown originated inside a `.cm-editor`, so CodeMirror's own keymap handles it
  // and drives the same shared manager. Outside editors, Ctrl/Cmd+Z triggers undo,
  // Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y triggers redo.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      const target = e.target as HTMLElement | null;
      const insideEditor = target?.closest?.(".cm-editor");
      if (key === "z" && !e.shiftKey) {
        if (insideEditor) return; // CodeMirror/yCollab handle undo on the shared manager
        e.preventDefault();
        undo();
      } else if (key === "z" && e.shiftKey) {
        if (insideEditor) return;
        e.preventDefault();
        redo();
      } else if (key === "y") {
        if (insideEditor) return;
        e.preventDefault();
        redo();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [undo, redo]);

  return (
    <div className={`relative bg-white border-b border-gray-200 sticky top-14 landscape-compact:top-11 z-20 ${className}`}>
      <nav
        ref={navRef}
        className="overflow-x-auto"
        aria-label={t("common:a11y.main_navigation")}
      >
      <div className="flex items-center justify-between px-3 sm:px-6">
        <ul className="flex items-center min-w-max gap-0">
          {visibleTabs.map(({ key, to, icon: Icon, labelKey }) => (
            <li key={key}>
              <NavLink
                to={to}
                className={({ isActive }) =>
                  `flex items-center gap-1.5 px-4 py-3 font-heading font-semibold text-xs uppercase tracking-wider border-b-2 transition-colors ${
                    isActive
                      ? "text-charcoal border-charcoal"
                      : "text-gray-500 border-transparent hover:text-charcoal"
                  }`
                }
              >
                {({ isActive }) => (
                <>
                <Icon className="w-3.5 h-3.5" />
                {(() => {
                  const tabUsers = getTabPresence(to);
                  if (tabUsers.length === 0) return null;
                  const first = tabUsers[0];
                  return (
                    <span
                      className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ backgroundColor: first.user.color }}
                      aria-label={tCollab("presence_tab_dot_aria", { name: first.user.name })}
                      role="status"
                    />
                  );
                })()}
                {t(labelKey)}
                </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
        <div className="flex items-center">
          {/* Site + Docs — right-aligned utility links grouped with the
              undo/redo cluster. Site opens the published site in a new tab;
              Docs opens the in-product DocsDrawer in place via the shell-level
              onOpenDoc prop. */}
          {pagesUrl && (
            <a
              href={pagesUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t("nav.site_aria")}
              title={t("nav.site_aria")}
              className="flex items-center gap-1.5 px-3 py-3 font-heading font-semibold text-xs uppercase tracking-wider text-gray-500 hover:text-charcoal transition-colors"
            >
              <Globe className="w-3.5 h-3.5" />
              {t("nav.site")}
              <ArrowUpRight className="w-3 h-3 opacity-60" aria-hidden="true" />
            </a>
          )}
          <button
            type="button"
            onClick={() => onOpenDoc?.("start")}
            aria-label={t("nav.docs")}
            title={t("nav.docs")}
            className="flex items-center gap-1.5 px-3 py-3 font-heading font-semibold text-xs uppercase tracking-wider text-gray-500 hover:text-charcoal transition-colors"
          >
            <BookOpen className="w-3.5 h-3.5" />
            {t("nav.docs")}
            <ArrowUpRight className="w-3 h-3 opacity-60" aria-hidden="true" />
          </button>
          {/* Undo/redo buttons. Always rendered; disabled state uses
              greyed-out charcoal tone per Telar identity. No terracotta. */}
          <div className="flex items-center gap-1 ml-2 mr-3">
            <button
              type="button"
              onClick={undo}
              disabled={!canUndo}
              className={`p-1.5 rounded transition-colors ${
                canUndo
                  ? "text-charcoal hover:bg-cream-dark"
                  : "text-gray-300 cursor-not-allowed"
              }`}
              aria-label={tStructural("undo")}
              title={tStructural("undo")}
            >
              <Undo2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!canRedo}
              className={`p-1.5 rounded transition-colors ${
                canRedo
                  ? "text-charcoal hover:bg-cream-dark"
                  : "text-gray-300 cursor-not-allowed"
              }`}
              aria-label={tStructural("redo")}
              title={tStructural("redo")}
            >
              <Redo2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
      </nav>
      {/* Sideways-scroll affordances — a chevron over a solid-to-transparent
          white fade so it reads on the white bar (a plain white fade is
          invisible). Shown only on the edge that has more content to reveal. */}
      {showLeftFade && (
        <div
          className="pointer-events-none absolute left-0 top-0 bottom-px z-10 flex items-center bg-gradient-to-r from-white via-white to-transparent pl-1.5 pr-8"
          aria-hidden="true"
        >
          <ChevronLeft className="w-4 h-4 text-gray-400" />
        </div>
      )}
      {showRightFade && (
        <div
          className="pointer-events-none absolute right-0 top-0 bottom-px z-10 flex items-center bg-gradient-to-l from-white via-white to-transparent pr-1.5 pl-8"
          aria-hidden="true"
        >
          <ChevronRight className="w-4 h-4 text-gray-400" />
        </div>
      )}
    </div>
  );
}
