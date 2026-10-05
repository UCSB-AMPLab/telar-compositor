/**
 * cleanPaste.ts — the CodeMirror half of paste cleaning.
 *
 * A clipboard input filter that runs `cleanText` over the plain text of a
 * native paste or drop, so the characters a Telar build rejects never enter an
 * editor's document. Every CodeMirror configuration in the Compositor carries
 * it: both `MarkdownEditor` setups and `InlineHtmlEditor`. `richPaste`
 * dispatches its converted text itself, which bypasses clipboard filters, so
 * it cleans that text on its own.
 *
 * @version v1.5.0-beta
 */

import { EditorView } from "@codemirror/view";
import { cleanText } from "~/lib/unsafe-text";

export const cleanPasteExtension = EditorView.clipboardInputFilter.of((text) => cleanText(text));
