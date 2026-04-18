/**
 * TabNav — horizontal tab navigation for the authenticated shell.
 *
 * Eight tabs: Dashboard, Config, Homepage, Objects, Stories, Pages, Glossary, Publish.
 * Active tab: charcoal underline and text. Space Grotesk, uppercase, xs.
 * Save indicator at far right: detects in-flight fetchers globally.
 * Presence dots: coloured dot appears next to tab label when a remote collaborator
 * is on that route.
 */

import { useEffect } from "react";
import { NavLink, useMatches } from "react-router";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  Image,
  BookOpen,
  BookA,
  Settings,
  Upload,
  Home,
  FileText,
  Globe,
  ArrowUpRight,
  Undo2,
  Redo2,
} from "lucide-react";
import { SaveIndicator } from "~/components/ui/SaveIndicator";
import { useCollaborationContext } from "~/hooks/use-collaboration";

interface Tab {
  key: string;
  to: string;
  icon: React.ElementType;
  labelKey: string;
}

const tabs: Tab[] = [
  { key: "dashboard",  to: "/dashboard",  icon: LayoutDashboard, labelKey: "nav.dashboard" },
  { key: "config",     to: "/config",     icon: Settings,        labelKey: "nav.config" },
  { key: "objects",    to: "/objects",    icon: Image,           labelKey: "nav.objects" },
  { key: "stories",    to: "/stories",    icon: BookOpen,        labelKey: "nav.stories" },
  { key: "glossary",   to: "/glossary",   icon: BookA,           labelKey: "nav.glossary" },
  { key: "homepage",   to: "/homepage",   icon: Home,            labelKey: "nav.homepage" },
  { key: "pages",      to: "/pages",      icon: FileText,        labelKey: "nav.pages" },
  { key: "publish",    to: "/publish",    icon: Upload,          labelKey: "nav.publish" },
];

/** All autosave intents across the app. */
const ALL_SAVE_INTENTS = [
  "autosave-landing",
  "autosave-config",
  "reorder",
  "toggle-draft",
  "toggle-private",
  "autosave-story-field",
  "autosave-step-field",
  "autosave-layer",
  "capture-position",
  "change-object",
  "add-step",
  "delete-step",
  "reorder-steps",
  "create-layer",
  "save-layer",
  "delete-layer",
  "autosave-object-field",
  "autosave-object-featured",
  "toggle-featured",
  "autosave-page-title",
  "autosave-page-body",
];

interface TabNavProps {
  className?: string;
  pagesUrl?: string | null;
}

export function TabNav({ className = "", pagesUrl = null }: TabNavProps) {
  const { t } = useTranslation("common");
  const { t: tCollab } = useTranslation("collaboration");
  const { t: tStructural } = useTranslation("structural");
  const { remoteCollaborators, canUndo, canRedo, undo, redo } =
    useCollaborationContext();
  const matches = useMatches();
  const hideAutosave = matches.some(
    (m) => (m.handle as Record<string, unknown> | undefined)?.hideAutosaveIndicator,
  );

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
    <nav
      className={`bg-white border-b border-gray-200 overflow-x-auto sticky top-14 z-20 ${className}`}
      aria-label="Main navigation"
    >
      <div className="flex items-center justify-between px-6">
        <ul className="flex items-center min-w-max gap-0">
          {tabs.map(({ key, to, icon: Icon, labelKey }) => (
            <li key={key}>
              <NavLink
                to={to}
                end={key === "dashboard"}
                className={({ isActive }) =>
                  `flex items-center gap-1.5 px-4 py-3 font-heading font-medium text-xs uppercase tracking-wider border-b-2 transition-colors ${
                    isActive
                      ? "text-charcoal border-charcoal"
                      : "text-gray-500 border-transparent hover:text-charcoal"
                  }`
                }
              >
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
              </NavLink>
            </li>
          ))}
          {pagesUrl && (
            <li>
              <a
                href={pagesUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t("nav.site_aria")}
                title={t("nav.site_aria")}
                className="flex items-center gap-1.5 px-4 py-3 font-heading font-medium text-xs uppercase tracking-wider border-b-2 border-transparent text-gray-500 hover:text-charcoal transition-colors"
              >
                <Globe className="w-3.5 h-3.5" />
                {t("nav.site")}
                <ArrowUpRight className="w-3 h-3 opacity-60" aria-hidden="true" />
              </a>
            </li>
          )}
        </ul>
        <div className="flex items-center">
          {/* Undo/redo buttons. Always rendered; disabled state uses
              greyed-out charcoal tone per Telar identity. No terracotta. */}
          <div className="flex items-center gap-1 mr-3">
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
          {!hideAutosave && (
            <SaveIndicator
              intents={ALL_SAVE_INTENTS}
              savingLabel={t("autosave.saving")}
              savedLabel={t("autosave.saved")}
              alwaysShow
              idleLabel={t("autosave.all_saved")}
            />
          )}
        </div>
      </div>
    </nav>
  );
}
