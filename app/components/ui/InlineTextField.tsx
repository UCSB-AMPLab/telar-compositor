/**
 * InlineTextField — Yjs-backed inline text input.
 *
 * Replaced HTTP-based autosave with the useCollaborativeText hook. Mutations
 * write directly to a Y.Text shared type, which syncs to all clients via the
 * Durable Object WebSocket. Falls back to initialValue on SSR or before the
 * WebSocket connects (yText is null).
 *
 * Fields are disabled during publish to enforce the isPublishing lock from
 * CollaborationContext (field locking spec).
 *
 * When fieldKey is provided, the field shows a coloured border and floating
 * name pill when another user is editing the same field (PRES-02).
 *
 * Shows an authorship indicator ("Last edit: {name}") on hover when no live
 * presence is active on the field.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import * as Y from "yjs";
import { useCollaborativeText } from "~/hooks/use-collaborative-text";
import { useCollaborationContext } from "~/hooks/use-collaboration";

export interface InlineTextFieldProps {
  initialValue: string;
  yText: Y.Text | null;
  fieldKey?: string;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  bordered?: boolean;
}

export function InlineTextField({
  initialValue,
  yText,
  fieldKey,
  placeholder,
  className = "",
  inputClassName = "",
  bordered,
}: InlineTextFieldProps) {
  const { t } = useTranslation("team");
  const { value, handleChange } = useCollaborativeText(yText, initialValue);
  const { isPublishing, remoteCollaborators, provider, lastEditorByField } = useCollaborationContext();
  const [isHovered, setIsHovered] = useState(false);

  // Compute which remote users are editing this specific field
  const activeUsers = fieldKey
    ? remoteCollaborators.filter((c) => c.location?.fieldKey === fieldKey)
    : [];
  const firstColor = activeUsers[0]?.user.color ?? null;

  // Authorship indicator: last editor from awareness cache, hidden when live presence is active
  const lastEditor = fieldKey ? (lastEditorByField.get(fieldKey) ?? null) : null;

  // On focus: broadcast that we are editing this field
  const handleFocus = () => {
    if (fieldKey && provider?.awareness) {
      const currentLocation = provider.awareness.getLocalState()?.location as
        | { route: string; storyId: string | null; fieldKey: string | null }
        | undefined;
      provider.awareness.setLocalStateField("location", {
        route: currentLocation?.route ?? "",
        storyId: currentLocation?.storyId ?? null,
        fieldKey,
      });
    }
  };

  // On blur: clear the fieldKey from awareness
  const handleBlur = () => {
    if (fieldKey && provider?.awareness) {
      const currentLocation = provider.awareness.getLocalState()?.location as
        | { route: string; storyId: string | null; fieldKey: string | null }
        | undefined;
      provider.awareness.setLocalStateField("location", {
        route: currentLocation?.route ?? "",
        storyId: currentLocation?.storyId ?? null,
        fieldKey: null,
      });
    }
  };

  const borderClass = bordered
    ? "rounded-md border border-gray-200 px-3 py-2 bg-white hover:border-gray-300 focus:border-periwinkle focus:ring-1 focus:ring-periwinkle"
    : "border-b border-transparent hover:border-gray-200 focus:border-periwinkle";

  return (
    <div
      className="relative"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <input
        type="text"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder={placeholder}
        disabled={isPublishing}
        aria-disabled={isPublishing || undefined}
        className={`w-full bg-transparent focus:outline-none transition-colors ${borderClass} ${isPublishing ? "opacity-50 cursor-not-allowed" : ""} ${inputClassName} ${className}`}
        style={
          firstColor
            ? { outline: `2px solid ${firstColor}`, outlineOffset: "-1px", borderRadius: "4px" }
            : undefined
        }
      />
      {activeUsers.length > 0 && (
        <span
          className="absolute -top-5 right-0 rounded-full px-1.5 py-0.5 font-body text-xs whitespace-nowrap pointer-events-none"
          style={{
            backgroundColor: firstColor + "33",
            color: firstColor!,
          }}
        >
          {activeUsers.map((u) => u.user.name.split(" ")[0]).join(", ")}
        </span>
      )}
      {lastEditor && activeUsers.length === 0 && (
        <span
          className={`absolute -bottom-5 right-0 rounded-full px-1.5 py-0.5 font-body text-xs text-charcoal/60 bg-cream border border-gray-200 whitespace-nowrap pointer-events-none transition-opacity duration-150 ${isHovered ? "opacity-100" : "opacity-0"}`}
          aria-label={t("authorship_aria", { name: lastEditor.name })}
          aria-hidden={!isHovered}
        >
          {t("last_edit_by", { name: lastEditor.name.split(" ")[0] })}
        </span>
      )}
    </div>
  );
}
