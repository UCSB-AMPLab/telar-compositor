/**
 * richPaste.ts — Rich paste extension for the MarkdownEditor.
 *
 * Intercepts paste events. If the clipboard contains HTML (e.g. from a web
 * page or Google Docs), converts it to markdown via turndown before inserting.
 * Falls back to CodeMirror's default plain-text paste handling otherwise.
 */

import TurndownService from "turndown";
import { EditorView } from "@codemirror/view";

const td = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });

/**
 * A CodeMirror extension that converts pasted HTML to markdown.
 * Handles rich text from web pages; plain text paste is unchanged.
 */
export const richPasteExtension = EditorView.domEventHandlers({
  paste(event, view) {
    const html = event.clipboardData?.getData("text/html");
    if (!html) return false; // Let CodeMirror handle plain text

    event.preventDefault();
    const markdown = td.turndown(html);
    view.dispatch(view.state.replaceSelection(markdown));
    return true;
  },
});
