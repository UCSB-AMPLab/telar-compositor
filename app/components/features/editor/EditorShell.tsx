/**
 * EditorShell — layout wrapper for the story editor.
 *
 * Escapes the app shell's `p-6` padding with `-m-6` to take the full
 * available viewport height below the header (h-14/56px) and tab nav
 * (~40px), leaving calc(100vh - 6rem) for the editor area.
 *
 * When hideViewer is true (title card), the narrative column expands
 * to fill the space and the viewer is not rendered.
 *
 * Columns:
 *  - Step sidebar: 200px fixed, charcoal background
 *  - Narrative column: 33% (or full width when hideViewer)
 *  - Viewer column: flex-1 remainder, dark background (hidden for title card)
 */

import React from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";

interface EditorShellProps {
  storyTitle: string;
  sidebar: React.ReactNode;
  narrative: React.ReactNode;
  viewer: React.ReactNode;
  hideViewer?: boolean;
}

export function EditorShell({ storyTitle, sidebar, narrative, viewer, hideViewer }: EditorShellProps) {
  const { t } = useTranslation("editor");

  return (
    <div className="-m-6 flex flex-col h-[calc(100vh-6rem)]">
      {/* Breadcrumb bar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-charcoal text-cream text-sm font-body shrink-0">
        <Link to="/dashboard" className="hover:underline">
          {t("breadcrumb.dashboard")}
        </Link>
        <span className="text-cream/50">›</span>
        <span className="truncate">
          {storyTitle || t("breadcrumb.untitled")}
        </span>
      </div>

      {/* Column area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Step sidebar: 200px fixed, charcoal */}
        <div className="w-[200px] shrink-0 bg-charcoal border-r border-gray-700 overflow-y-auto">
          {sidebar}
        </div>

        {hideViewer ? (
          /* Title card: narrative fills remaining space */
          <div className="flex-1 overflow-y-auto">
            {narrative}
          </div>
        ) : (
          <>
            {/* Narrative column: 33% */}
            <div className="basis-1/3 shrink-0 overflow-y-auto">
              {narrative}
            </div>

            {/* Viewer column: flex remainder, dark bg */}
            <div className="flex-1 relative bg-[#1a1a1a]">
              {viewer}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
