/**
 * richPaste.ts — Rich paste extension for the MarkdownEditor.
 *
 * Intercepts paste events. If the clipboard contains HTML (e.g. from a web
 * page or Google Docs), converts it to markdown via turndown before inserting.
 * Falls back to CodeMirror's default plain-text paste handling otherwise.
 *
 * Turndown is loaded lazily on first paste to avoid bundling its CJS
 * dependency (@mixmark-io/domino) into the SSR server build, where
 * require() is not available in Cloudflare Workers.
 */

import { EditorView } from "@codemirror/view";

/** Domains whose iframes are preserved as raw HTML on paste. */
const VIDEO_EMBED_DOMAINS = [
  "youtube.com",
  "youtube-nocookie.com",
  "youtu.be",
  "vimeo.com",
  "player.vimeo.com",
];

function isVideoEmbed(src: string): boolean {
  try {
    const host = new URL(src).hostname;
    return VIDEO_EMBED_DOMAINS.some(
      (d) => host === d || host.endsWith(`.${d}`),
    );
  } catch {
    return false;
  }
}

let td: import("turndown").default | null = null;

async function getTurndown() {
  if (!td) {
    const TurndownService = (await import("turndown")).default;
    td = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });

    // Preserve YouTube/Vimeo iframes as raw HTML
    td.addRule("videoIframe", {
      filter: (node) =>
        node.nodeName === "IFRAME" &&
        isVideoEmbed((node as HTMLIFrameElement).getAttribute("src") ?? ""),
      replacement: (_content, node) => {
        return `\n\n${(node as HTMLElement).outerHTML}\n\n`;
      },
    });
  }
  return td;
}

/**
 * A CodeMirror extension that converts pasted HTML to markdown.
 * Handles rich text from web pages; plain text paste is unchanged.
 */
export const richPasteExtension = EditorView.domEventHandlers({
  async paste(event, view) {
    const html = event.clipboardData?.getData("text/html");
    if (!html) return false; // Let CodeMirror handle plain text

    event.preventDefault();
    const turndown = await getTurndown();
    const markdown = turndown.turndown(html);
    view.dispatch(view.state.replaceSelection(markdown));
    return true;
  },
});
