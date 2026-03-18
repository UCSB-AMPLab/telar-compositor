/**
 * TabNav — horizontal tab navigation for the authenticated shell.
 *
 * Six tabs: Dashboard, Objects, Stories, Glossary, Config, Publish.
 * Active tab: charcoal underline and text. Space Grotesk, uppercase, xs.
 * Save indicator at far right: detects in-flight fetchers globally.
 */

import { NavLink } from "react-router";
import { useTranslation } from "react-i18next";
import {
  LayoutDashboard,
  Image,
  BookOpen,
  BookA,
  Settings,
  Upload,
} from "lucide-react";
import { SaveIndicator } from "~/components/ui/SaveIndicator";

interface Tab {
  key: string;
  to: string;
  icon: React.ElementType;
  labelKey: string;
}

const tabs: Tab[] = [
  { key: "dashboard", to: "/dashboard", icon: LayoutDashboard, labelKey: "nav.dashboard" },
  { key: "config", to: "/config", icon: Settings, labelKey: "nav.config" },
  { key: "objects", to: "/objects", icon: Image, labelKey: "nav.objects" },
  { key: "stories", to: "/stories", icon: BookOpen, labelKey: "nav.stories" },
  { key: "glossary", to: "/glossary", icon: BookA, labelKey: "nav.glossary" },
  { key: "publish", to: "/publish", icon: Upload, labelKey: "nav.publish" },
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
];

interface TabNavProps {
  className?: string;
}

export function TabNav({ className = "" }: TabNavProps) {
  const { t } = useTranslation("common");

  return (
    <nav
      className={`bg-white border-b border-gray-200 overflow-x-auto ${className}`}
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
                {t(labelKey)}
              </NavLink>
            </li>
          ))}
        </ul>
        <SaveIndicator
          intents={ALL_SAVE_INTENTS}
          savingLabel={t("autosave.saving")}
          savedLabel={t("autosave.saved")}
          alwaysShow
          idleLabel={t("autosave.all_saved")}
        />
      </div>
    </nav>
  );
}
