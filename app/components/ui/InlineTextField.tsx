/**
 * This file renders the Yjs-backed inline single-line text input —
 * used wherever the editor needs a one-line text field that
 * auto-saves through the collaborative document instead of HTTP.
 *
 * Mutations write directly to a `Y.Text` shared type via the
 * `useCollaborativeText` hook, which syncs to all clients via the
 * Durable Object WebSocket. Falls back to `initialValue` on SSR or
 * before the WebSocket connects (`yText` is null).
 *
 * Fields are disabled during publish to enforce the `isPublishing`
 * lock from `CollaborationContext`.
 *
 * When `fieldKey` is provided, the field shows a coloured border
 * and floating name pill when another user is editing the same
 * field (live presence), and tells the others this author is in it
 * from focus until blur, or until it goes while still focused.
 *
 * Shows an authorship indicator ("Last edit: {name}") on hover
 * when no live presence is active on the field.
 *
 * `onDone` is called when the author finishes with the field: on blur, and
 * on Escape, which stops there so nothing enclosing the field closes too.
 * With `grow` the input is as wide as its text rather than its container.
 * A caller that must keep the text across the field unmounting passes the
 * `binding` it holds instead of letting the field bind `yText` itself.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import * as Y from "yjs";
import { useCollaborativeText, type CollaborativeText } from "~/hooks/use-collaborative-text";
import { useSettleShownValue } from "~/hooks/use-settle-shown-value";
import { useCollaborationContext } from "~/hooks/use-collaboration";

/** How the author finished with a field. */
export type DoneReason = "blur" | "escape";

export interface InlineTextFieldProps {
  initialValue: string;
  yText: Y.Text | null;
  fieldKey?: string;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  bordered?: boolean;
  /** When true, renders a red border + sets aria-invalid. */
  error?: boolean;
  /** Caption shown below the input when `error` is true. */
  errorMessage?: string;
  /**
   * Strings the field should DISPLAY as empty (placeholder takes over) even
   * if the underlying Y.Text or initialValue equals one of them. Used to
   * suppress legacy framework-default literals captured-at-import that the
   * current framework version no longer treats as user content. The Y.Text
   * is left intact until the user edits — handleChange's full-replace
   * transaction cleanly overwrites the legacy default at that point.
   */
  defaultValues?: readonly string[];
  /** Focus the field when it mounts. */
  autoFocus?: boolean;
  /** Called on blur and on Escape, saying which. */
  onDone?: (reason: DoneReason) => void;
  /** Size the input to its text (or its placeholder) instead of its container. */
  grow?: boolean;
  /** A binding the caller holds; the field then does not bind `yText` itself. */
  binding?: CollaborativeText;
  /** The input's id, for a label outside the field. */
  id?: string;
}

/**
 * Whether a key belongs to an input method's composition. Escape during a
 * composition is how the author cancels it, not a request to leave the field.
 * Safari reports those keys as 229 without `isComposing`.
 */
export function isCompositionKey(event: KeyboardEvent<HTMLElement>): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

type Provider = ReturnType<typeof useCollaborationContext>["provider"];

/** Sets the local awareness location's field: `fieldKey` as this author enters it, null as they leave. */
export function setPresence(provider: Provider, fieldKey: string | null) {
  if (!provider?.awareness) return;
  const currentLocation = provider.awareness.getLocalState()?.location as
    | { route: string; storyId: string | null; fieldKey: string | null }
    | undefined;
  provider.awareness.setLocalStateField("location", {
    route: currentLocation?.route ?? "",
    storyId: currentLocation?.storyId ?? null,
    fieldKey,
  });
}

/** Clears `fieldKey` from the local awareness location: this author has left the field. */
function clearPresence(provider: Provider, fieldKey: string | undefined) {
  if (fieldKey) setPresence(provider, null);
}

/**
 * The mounted fields' inputs by awareness key. Two can hold one key for a
 * moment: a field that replaces another in the same commit mounts before the
 * old one's cleanup runs.
 */
const mountedByKey = new Map<string, Set<{ current: HTMLElement | null }>>();

/**
 * Finishes the field on Escape. The key stops at the field, so an enclosing
 * panel or dialog listening for Escape stays open.
 */
export function doneOnEscape(onDone: ((reason: DoneReason) => void) | undefined) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (!onDone || event.key !== "Escape" || isCompositionKey(event)) return;
    event.preventDefault();
    event.stopPropagation();
    onDone("escape");
  };
}

export function InlineTextField({
  initialValue,
  yText,
  fieldKey,
  placeholder,
  className = "",
  inputClassName = "",
  bordered,
  error,
  errorMessage,
  defaultValues,
  autoFocus,
  onDone,
  grow,
  binding,
  id,
}: InlineTextFieldProps) {
  const { t } = useTranslation("team");
  const own = useCollaborativeText(binding ? null : yText, initialValue, defaultValues);
  const text = binding ?? own;
  const { value, handleChange } = text;
  const boxRef = useRef<HTMLInputElement | null>(null);
  const settle = useSettleShownValue(boxRef, value, text);
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
    if (fieldKey) setPresence(provider, fieldKey);
  };

  // On blur: clear the fieldKey from awareness
  const handleBlur = () => {
    clearPresence(provider, fieldKey);
    settle();
    onDone?.("blur");
  };

  // A field that goes while it holds focus (finished with Escape, say) has no
  // blur to clear its presence, so going clears it too: if the location still
  // names this key and no other mounted field of the key holds focus. A field
  // that replaces another of its key in one commit has taken focus before the
  // old one's cleanup runs, so it keeps its presence; its own effect runs
  // after that cleanup, and an effect that finds its input focused says so
  // again, which also covers Strict Mode's second run of the effect on mount.
  const presence = useRef({ provider, fieldKey });
  presence.current = { provider, fieldKey };
  useEffect(() => {
    const key = presence.current.fieldKey;
    if (!key) return;
    const mine = boxRef as { current: HTMLElement | null };
    const fields = mountedByKey.get(key) ?? new Set();
    fields.add(mine);
    mountedByKey.set(key, fields);
    if (boxRef.current && boxRef.current === document.activeElement) setPresence(presence.current.provider, key);
    return () => {
      const still = mountedByKey.get(key) ?? new Set();
      still.delete(mine);
      if (still.size === 0) mountedByKey.delete(key);
      const focusedElsewhere = [...still].some((field) => field.current !== null && field.current === document.activeElement);
      const gone = presence.current.provider;
      const location = gone?.awareness?.getLocalState()?.location as { fieldKey?: string | null } | undefined;
      if (!focusedElsewhere && location?.fieldKey === key) clearPresence(gone, key);
    };
  }, [fieldKey]);

  const borderClass = bordered
    ? "rounded-md border border-gray-200 px-3 py-2 bg-white hover:border-gray-300 focus:border-anil"
    : "border-b border-transparent hover:border-gray-200 focus:border-anil";

  // Red border + a11y when the field is in an error state.
  const errorBorderClass = error ? "border-red-400" : "";

  return (
    <div
      className={grow ? "relative inline-block max-w-full" : "relative"}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <input
        id={id}
        type="text"
        value={value}
        ref={boxRef}
        onChange={(e) => handleChange(e.target.value)}
        onCompositionEnd={settle}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !isCompositionKey(event)) settle();
          doneOnEscape(onDone)(event);
        }}
        autoFocus={autoFocus}
        size={grow ? Math.max(1, (value || placeholder || "").length) : undefined}
        placeholder={placeholder}
        disabled={isPublishing}
        aria-disabled={isPublishing || undefined}
        aria-invalid={error || undefined}
        className={`${grow ? "max-w-full" : "w-full"} bg-transparent transition-colors ${borderClass} ${errorBorderClass} ${isPublishing ? "text-fg-disabled cursor-not-allowed" : ""} ${inputClassName} ${className}`}
        style={
          firstColor
            ? { outline: `2px solid ${firstColor}`, outlineOffset: "-1px", borderRadius: "4px" }
            : undefined
        }
      />
      {error && errorMessage && (
        <p className="text-red-500 text-xs font-body mt-1">{errorMessage}</p>
      )}
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
