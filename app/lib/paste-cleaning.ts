/**
 * Paste cleaning for every plain text field in the Compositor: one capture-phase
 * `paste` listener on the document, installed once from `root.tsx`, so the app
 * and onboarding alike are covered without each field opting in. CodeMirror
 * editors clean their own pastes (`cleanPaste.ts`, `richPaste.ts`) and are not
 * text fields, so the listener never sees them as targets.
 *
 * The listener acts only when all of these hold: the target is a `<textarea>`
 * or a text-entry `<input>`; it is neither read-only nor disabled nor marked
 * `data-paste-verbatim`; no composition is in progress; and the pasted text
 * needs cleaning. Any other paste is left entirely to the browser. A field
 * holding a credential, such as the story key, is marked verbatim: cleaning
 * would change the secret without anyone seeing it change. When it acts, it cancels the paste
 * and inserts the cleaned text itself, cut to the room `maxLength` leaves.
 *
 * Insertion goes through `document.execCommand("insertText")`, which keeps the
 * browser's undo and fires the input event React listens for. Where that
 * returns false, `setRangeText` replaces the selection and a bubbling `input`
 * event lets React's value tracker see the change. `email` inputs have no
 * selection API, so the listener leaves them alone: an address never carries
 * these characters, and the commit cleans anything that reaches a file.
 *
 * @version v1.5.0-beta
 */

import { cleanText, needsCleaning } from "~/lib/unsafe-text";

/** Input types a person types free text into. An absent or unknown type reads as "text". */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel"]);

type TextField = HTMLInputElement | HTMLTextAreaElement;

function asTextField(target: EventTarget | null): TextField | null {
  if (target instanceof HTMLTextAreaElement) return target;
  if (target instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(target.type)) return target;
  return null;
}

/** The field's selection, which every type the listener handles has. */
function selectionOf(field: TextField): { start: number; end: number } {
  return { start: field.selectionStart ?? field.value.length, end: field.selectionEnd ?? field.value.length };
}

/**
 * Cuts `text` to at most `room` UTF-16 code units, backing off one unit rather
 * than leaving the high half of a surrogate pair at the end.
 */
function fitToRoom(text: string, room: number): string {
  if (text.length <= room) return text;
  let end = Math.max(0, room);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function insertWithoutCommand(field: TextField, text: string, selection: { start: number; end: number }): void {
  field.setRangeText(text, selection.start, selection.end, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * Handles one paste event under the contract in the module header. `composing`
 * is whether a composition is in progress; clipboard events do not carry it.
 * Returns true when it took the paste over.
 */
export function handleTextFieldPaste(event: ClipboardEvent, composing: boolean): boolean {
  const field = editableField(event.target, composing);
  if (!field) return false;

  const pasted = event.clipboardData?.getData("text/plain") ?? "";
  if (!needsCleaning(pasted)) return false;

  event.preventDefault();

  const selection = selectionOf(field);
  const text = fitToRoom(cleanText(pasted), roomFor(field, selection));
  if (text === "") return true;

  if (!insertWithCommand(text)) insertWithoutCommand(field, text, selection);
  return true;
}

/** The text field a paste targets, or null when it is not one this cleans. */
function editableField(target: EventTarget | null, composing: boolean): TextField | null {
  const field = asTextField(target);
  if (!field || field.readOnly || field.disabled || composing) return null;
  if (field.dataset.pasteVerbatim !== undefined) return null;
  return field;
}

/** How many code units `maxLength` leaves once the selection is replaced. */
function roomFor(field: TextField, selection: { start: number; end: number }): number {
  if (field.maxLength < 0) return Infinity;
  return field.maxLength - (field.value.length - (selection.end - selection.start));
}

/** Inserts through the browser's own editing command, which keeps undo. */
function insertWithCommand(text: string): boolean {
  try {
    return typeof document.execCommand === "function" && document.execCommand("insertText", false, text);
  } catch {
    return false;
  }
}

const installed = new WeakSet<Document>();

/**
 * Installs the listener on `doc` and returns the function that removes it.
 * Composition state is tracked here, in the capture phase like the paste
 * itself, because a paste event does not say whether one is in progress.
 */
export function installPasteCleaning(doc: Document = document): () => void {
  // One listener per document, so a second install cannot insert twice.
  if (installed.has(doc)) return () => {};
  installed.add(doc);
  let composing = false;
  const onCompositionStart = () => { composing = true; };
  const onCompositionEnd = () => { composing = false; };
  const onPaste = (event: Event) => { handleTextFieldPaste(event as ClipboardEvent, composing); };

  doc.addEventListener("compositionstart", onCompositionStart, true);
  doc.addEventListener("compositionend", onCompositionEnd, true);
  doc.addEventListener("paste", onPaste, true);
  return () => {
    doc.removeEventListener("compositionstart", onCompositionStart, true);
    doc.removeEventListener("compositionend", onCompositionEnd, true);
    doc.removeEventListener("paste", onPaste, true);
    installed.delete(doc);
  };
}
