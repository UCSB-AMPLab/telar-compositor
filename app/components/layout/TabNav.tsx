/**
 * TabNav — horizontal tab navigation for the authenticated shell.
 *
 * Six tabs: Dashboard, Objects, Stories, Glossary, Config, Publish.
 * Active tab: charcoal underline and text. Space Grotesk, uppercase, xs.
 * Save indicator at far right: detects in-flight fetchers globally.
 */

import { NavLink, useFetchers } from "react-router";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import {
  LayoutDashboard,
  Image,
  BookOpen,
  BookA,
  Settings,
  Upload,
  Check,
  Loader2,
} from "lucide-react";

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

/** Autosave intents that trigger the save indicator. */
const SAVE_INTENTS = ["autosave-landing", "autosave-config", "reorder", "toggle-draft", "toggle-private"];

function SaveIndicator() {
  const { t } = useTranslation("dashboard");
  const fetchers = useFetchers();
  const [showSaved, setShowSaved] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Check if any save-related fetcher is in flight
  const isSaving = fetchers.some(
    (f) =>
      f.state === "submitting" &&
      f.formData &&
      SAVE_INTENTS.includes(f.formData.get("intent") as string)
  );

  useEffect(() => {
    if (isSaving) {
      // Clear any existing "Saved" timeout
      if (timerRef.current) clearTimeout(timerRef.current);
      setShowSaved(false);
    } else if (!isSaving && showSaved === false) {
      // When saving finishes, briefly show "Saved"
      // Only trigger if we were previously saving
    }
  }, [isSaving]);

  // Track transitions from saving → idle
  const wasSavingRef = useRef(false);
  useEffect(() => {
    if (isSaving) {
      wasSavingRef.current = true;
    } else if (wasSavingRef.current) {
      wasSavingRef.current = false;
      setShowSaved(true);
      timerRef.current = setTimeout(() => setShowSaved(false), 2000);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isSaving]);

  if (!isSaving && !showSaved) return null;

  return (
    <div className="flex items-center gap-1.5 px-4 py-3 font-body text-xs text-gray-400 whitespace-nowrap">
      {isSaving ? (
        <>
          <Loader2 className="w-3 h-3 animate-spin" />
          {t("inline_edit.saving")}
        </>
      ) : (
        <>
          <Check className="w-3 h-3 text-green-500" />
          {t("inline_edit.saved")}
        </>
      )}
    </div>
  );
}

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
        <SaveIndicator />
      </div>
    </nav>
  );
}
