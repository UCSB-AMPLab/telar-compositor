/**
 * toolbar-press — how a Markdown editor toolbar button runs its action from
 * the mouse, the keyboard and assistive technology.
 *
 * The action runs on `click`, the one event every activation ends in: a
 * pointer press, Enter or Space on a focused button, and a screen reader's
 * activate, which in WebKit sends `mousedown`, `mouseup` and `click`. Running
 * it on `mousedown` as well would run it twice for that last one.
 *
 * `mousedown` only prevents its default, so a pointer press does not move
 * focus out of the editor. With focus on the toolbar instead, CodeMirror keeps
 * its selection in the editor state while the editor is blurred, so the
 * action still applies to what the author had selected.
 *
 * @version v1.5.0-beta
 */

import type React from "react";

export interface ToolbarPressHandlers {
  onMouseDown: (event: React.MouseEvent<HTMLElement>) => void;
  onClick: (event: React.MouseEvent<HTMLElement>) => void;
}

/** Props that run `action` once per activation, however it arrives. */
export function toolbarPress(action: () => void, disabled = false): ToolbarPressHandlers {
  return {
    onMouseDown: (event) => {
      event.preventDefault();
    },
    onClick: () => {
      if (!disabled) action();
    },
  };
}
