/**
 * html-unescape — Python's `html.unescape`, which the framework applies to
 * image alt text (`process_images`) and to a glossary link's display text
 * (`process_glossary_links`) before escaping them.
 *
 * Numeric references follow Python's rules: code 0, a surrogate or anything
 * past U+10FFFF reads U+FFFD, 13 and 128–159 read as Python's table maps
 * them (Windows-1252), and a control or non-character code Python drops is
 * dropped. A named reference is decoded by the browser's parser where there
 * is a document, which knows every HTML5 name. Without one (a server render)
 * it goes to the decoder `setNamedDecoder` installs, which
 * html-unescape.server.ts sets to `entities`: every HTML5 name, a legacy name
 * without its `;` by longest prefix, an unknown name as written, as Python
 * does. The client bundle does not carry that table. With no decoder
 * installed, only the names in `NAMED` are decoded and any other is left as
 * written.
 *
 * @version v1.5.0-beta
 */

const REFERENCE = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/g;

/** Python's `_invalid_charrefs`. */
const INVALID_CHARREFS: Record<number, string> = {
  0x00: "�", 0x0d: "\r", 0x80: "€", 0x81: "\x81", 0x82: "‚", 0x83: "ƒ",
  0x84: "„", 0x85: "…", 0x86: "†", 0x87: "‡", 0x88: "ˆ", 0x89: "‰",
  0x8a: "Š", 0x8b: "‹", 0x8c: "Œ", 0x8d: "\x8d", 0x8e: "Ž", 0x8f: "\x8f",
  0x90: "\x90", 0x91: "‘", 0x92: "’", 0x93: "“", 0x94: "”", 0x95: "•",
  0x96: "–", 0x97: "—", 0x98: "˜", 0x99: "™", 0x9a: "š", 0x9b: "›",
  0x9c: "œ", 0x9d: "\x9d", 0x9e: "ž", 0x9f: "Ÿ",
};

/** Python's `_invalid_codepoints`, which decode to nothing. */
function droppedCodePoint(n: number): boolean {
  return (
    (n >= 0x1 && n <= 0x8) || n === 0xb || (n >= 0xe && n <= 0x1f) || (n >= 0x7f && n <= 0x9f) ||
    (n >= 0xfdd0 && n <= 0xfdef) || (n & 0xfffe) === 0xfffe
  );
}

/** Names decoded when there is neither a document nor an installed decoder. */
const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  lsqb: "[", rsqb: "]", lbrack: "[", rbrack: "]", vert: "|", verbar: "|", VerticalLine: "|",
};

let namedDecoder: ((reference: string) => string) | null = null;

/** Installs the decoder for named references where there is no document. */
export function setNamedDecoder(decode: (reference: string) => string): void {
  namedDecoder = decode;
}

function numeric(body: string): string {
  const hex = body[1] === "x" || body[1] === "X";
  const n = parseInt(body.slice(hex ? 2 : 1).replace(/;$/, ""), hex ? 16 : 10);
  if (n in INVALID_CHARREFS) return INVALID_CHARREFS[n];
  if ((n >= 0xd800 && n <= 0xdfff) || n > 0x10ffff) return "�";
  if (droppedCodePoint(n)) return "";
  return String.fromCodePoint(n);
}

function named(reference: string, body: string): string {
  if (typeof document !== "undefined") {
    const holder = document.createElement("textarea");
    holder.innerHTML = reference;
    return holder.value;
  }
  if (namedDecoder) return namedDecoder(reference);
  const name = body.slice(0, -1);
  return body.endsWith(";") && Object.hasOwn(NAMED, name) ? NAMED[name] : reference;
}

/** `text` with its character references decoded, as `html.unescape` decodes them. */
export function htmlUnescape(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(REFERENCE, (reference, body: string) => (body[0] === "#" ? numeric(body) : named(reference, body)));
}
