/**
 * useFirstVisitGuide — the frame's sentence, opened once for someone new to
 * the story editor.
 *
 * The frame is the guide an author most needs explained before capturing a
 * position, so the first time its tag appears its sentence opens by itself.
 * Once the author has dismissed it (closed it from the tag, with Escape, or
 * by opening another tag), that is remembered in `localStorage` and it never
 * opens by itself again. It opens at most once per page load either way, so
 * moving between steps, which closes every sentence, does not bring it back;
 * where storage cannot be read or written (a private window, storage turned
 * off) that once per page load is all there is, and every access is guarded
 * so a refusal never reaches the editor.
 *
 * @version v1.5.2-beta
 */

import { useEffect, useRef } from "react";

export const FRAME_GUIDE_DISMISSED_KEY = "telar:editor:frame-guide-dismissed";

/** Whether the sentence has opened by itself in this page load. */
let openedThisLoad = false;

function dismissedBefore(): boolean {
  try {
    return window.localStorage?.getItem(FRAME_GUIDE_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remember that the author has dismissed the frame's first-visit sentence. */
export function rememberFrameGuideDismissed(): void {
  try {
    window.localStorage?.setItem(FRAME_GUIDE_DISMISSED_KEY, "1");
  } catch {
    /* Without storage the sentence still opens only once in this page load. */
  }
}

/**
 * Calls `open` once, the first time `present` (the frame's tag is on the
 * stage) holds in this page load, unless the sentence was dismissed in an
 * earlier one.
 */
export function useFirstVisitGuide(present: boolean, open: () => void): void {
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!present || openedThisLoad) return;
    openedThisLoad = true;
    if (dismissedBefore()) return;
    openRef.current();
  }, [present]);
}

export function __resetFirstVisitGuideForTests(): void {
  openedThisLoad = false;
}
