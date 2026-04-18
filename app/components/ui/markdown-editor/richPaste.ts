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
 *
 * Rules applied (in priority order within Turndown):
 *  1. videoIframe — preserve YouTube/Vimeo iframes as raw HTML
 *  2. googleDocsOuterBold — strip docs-internal-guid <b style="font-weight:normal"> wrappers
 *  3. googleDocsInlineBold — convert <span style="font-weight:700"> to **bold**
 *  4. googleDocsInlineItalic — convert <span style="font-style:italic"> to *italic*
 *  5. wordEmptyParagraph — strip <o:p> tags and MsoNormal paragraphs containing only <o:p>
 *  6. wordMsoSpan — strip <span style="mso-*"> wrappers, preserving text
 *  7. wordMsoEmptyParagraph — strip empty MsoNormal paragraphs
 *  8. emptySpan — strip whitespace-only <span> elements (Google Docs detritus)
 *
 * Post-processing normalises smart quotes and typographic dashes to ASCII equivalents.
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

/**
 * Resets the singleton Turndown instance. Exported for test teardown only —
 * prevents rule accumulation across test cases and Vite HMR reloads.
 */
export function _resetTurndownForTests() { td = null; }

/**
 * Returns (and lazily initialises) the Turndown instance with all paste sanitisation rules.
 * Exported as a named export so tests can call it directly without a DOM environment.
 */
export async function getTurndown() {
  if (!td) {
    const TurndownService = (await import("turndown")).default;
    td = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });

    // Rule 1: Preserve YouTube/Vimeo iframes as raw HTML
    td.addRule("videoIframe", {
      filter: (node) =>
        node.nodeName === "IFRAME" &&
        isVideoEmbed((node as HTMLIFrameElement).getAttribute("src") ?? ""),
      replacement: (_content, node) => {
        return `\n\n${(node as HTMLElement).outerHTML}\n\n`;
      },
    });

    // Strip script, style, xml, and other non-content elements entirely
    td.remove(["script", "style", "xml", "noscript", "title", "meta", "link"]);

    // Rule 2: Google Docs outer bold wrapper — <b style="font-weight:normal"> surrounds the
    // entire pasted content and must be stripped without adding bold markers
    td.addRule("googleDocsOuterBold", {
      filter: (node) =>
        node.nodeName === "B" &&
        (node as HTMLElement).getAttribute("style")?.includes("font-weight:normal") === true,
      replacement: (content) => content,
    });

    // Rule 3: Google Docs inline bold spans (font-weight:700 or bold)
    td.addRule("googleDocsInlineBold", {
      filter: (node) => {
        if (node.nodeName !== "SPAN") return false;
        const fw = (node as HTMLElement).style?.fontWeight;
        return fw === "700" || fw === "bold";
      },
      replacement: (content) => {
        const trimmed = content.trim();
        return trimmed ? `**${trimmed}**` : "";
      },
    });

    // Rule 4: Google Docs inline italic spans (font-style:italic)
    td.addRule("googleDocsInlineItalic", {
      filter: (node) => {
        if (node.nodeName !== "SPAN") return false;
        return (node as HTMLElement).style?.fontStyle === "italic";
      },
      replacement: (content) => {
        const trimmed = content.trim();
        return trimmed ? `*${trimmed}*` : "";
      },
    });

    // Rule 5: Word empty paragraph markers — <o:p> tags and MsoNormal paragraphs
    // that contain only <o:p></o:p> produce empty string
    td.addRule("wordEmptyParagraph", {
      filter: (node) => {
        const el = node as HTMLElement;
        // Match <o:p> tags directly
        if (node.nodeName.toLowerCase() === "o:p") return true;
        // Match <p> whose only content is <o:p></o:p>
        if (node.nodeName === "P" && el.innerHTML?.trim() === "<o:p></o:p>") return true;
        return false;
      },
      replacement: () => "",
    });

    // Rule 6: Word MSO-styled spans (mso-* in style attribute) — strip wrapper, keep text
    td.addRule("wordMsoSpan", {
      filter: (node) =>
        node.nodeName === "SPAN" &&
        /mso-/.test((node as HTMLElement).getAttribute("style") ?? ""),
      replacement: (content) => content,
    });

    // Rule 7: Word MsoNormal class paragraphs with no real text content
    td.addRule("wordMsoEmptyParagraph", {
      filter: (node) => {
        if (node.nodeName !== "P") return false;
        const cls = (node as HTMLElement).className ?? "";
        return /^Mso/.test(cls) && !(node as HTMLElement).textContent?.trim();
      },
      replacement: () => "",
    });

    // Rule 8: Empty spans (Google Docs detritus) — whitespace-only spans produce nothing
    td.addRule("emptySpan", {
      filter: (node) =>
        node.nodeName === "SPAN" &&
        !(node as HTMLElement).textContent?.trim(),
      replacement: () => "",
    });
  }
  return td;
}

/**
 * Strips Word conditional comments and XML namespace declarations from pasted HTML.
 * These contain VBA/JS helper functions (msoCommentShow, etc.) that Turndown
 * would otherwise render as visible text.
 */
function stripWordArtefacts(html: string): string {
  return html
    // Remove <!--[if ...]>...<![endif]--> conditional comment blocks (incl. nested)
    .replace(/<!--\[if[^]*?<!\[endif\]-->/gi, "")
    // Remove <?xml ...?> processing instructions
    .replace(/<\?xml[^?]*\?>/gi, "")
    // Remove Word XML namespace tags like <o:p>, <w:Sdt>, <st1:*>, etc.
    .replace(/<\/?\w+:[^>]*>/gi, "")
    // Remove Word comment anchor links — <a name="_msocom_1">, <a name="msocomanchor_1">, etc.
    .replace(/<a[^>]*name="[^"]*mso(?:com|anchor)[^"]*"[^>]*>.*?<\/a>/gi, "")
    // Remove Word comment reference markers like [LCE1], [LC1], etc. left after anchor stripping
    .replace(/\[(?:LCE?\d+|mso\w+)\](?:\[\d+\])?/g, "");
}

/**
 * Normalises smart quotes and typographic dashes to their ASCII/spaced equivalents.
 * Applied as post-processing after Turndown conversion.
 */
function normaliseQuotesAndDashes(text: string): string {
  return text
    .replace(/[\u2018\u2019]/g, "'")          // smart single quotes → '
    .replace(/[\u201C\u201D]/g, '"')           // smart double quotes → "
    .replace(/\u2013/g, " \u2013 ")            // en-dash → spaced en-dash
    .replace(/\u2014/g, " \u2014 ")            // em-dash → spaced em-dash
    .replace(/\[(?:LCE?\d+|mso\w+)\](?:\[\d+\])?/g, "")  // stray Word comment markers
    .replace(/ {2,}/g, " ");                   // collapse any double spaces created above
}

/**
 * A CodeMirror extension that converts pasted HTML to markdown.
 * Handles rich text from web pages; plain text paste is unchanged.
 */
export const richPasteExtension = EditorView.domEventHandlers({
  async paste(event, view) {
    const html = event.clipboardData?.getData("text/html");
    if (!html) return false; // Let CodeMirror handle plain text

    try {
      event.preventDefault();
      const turndown = await getTurndown();
      const cleanHtml = stripWordArtefacts(html);
      let markdown = turndown.turndown(cleanHtml);
      markdown = normaliseQuotesAndDashes(markdown);
      view.dispatch(view.state.replaceSelection(markdown));
    } catch {
      // Fallback: insert plain text so content is not lost
      const plain = event.clipboardData?.getData("text/plain") ?? "";
      if (plain) {
        view.dispatch(view.state.replaceSelection(plain));
      }
    }
    return true;
  },
});
