/**
 * This file renders the Yjs-backed inline textarea — used wherever
 * the editor needs a multi-line text input that auto-saves through
 * the collaborative document instead of HTTP.
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
 * field (live presence).
 *
 * Shows an authorship indicator ("Last edit: {name}") on hover
 * when no live presence is active on the field.
 *
 * `onDone`, `autoFocus` and `binding` work as on InlineTextField. With
 * `grow` the textarea is as tall as its text, never shorter than `rows`.
 *
 * @version v1.5.0-beta
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as Y from "yjs";
import { useCollaborativeText, type CollaborativeText } from "~/hooks/use-collaborative-text";
import { useSettleShownValue } from "~/hooks/use-settle-shown-value";
import { doneOnEscape, isCompositionKey, type DoneReason } from "~/components/ui/InlineTextField";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { addsRemovedContent, renderAnswer, type GlossaryContext } from "~/lib/answer-preview";
import { ANSWER_BUDGET, BREAK_LINES, LINE_CHARS, MAX_PARAGRAPHS, SMALL_TYPE_LINES, withinBudget } from "~/lib/answer-budget";

export interface InlineTextAreaProps {
  initialValue: string;
  yText: Y.Text | null;
  fieldKey?: string;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  rows?: number;
  bordered?: boolean;
  /**
   * Strings the field should DISPLAY as empty (placeholder takes over) even
   * if the underlying Y.Text or initialValue equals one of them. See
   * InlineTextField for the full rationale; same semantics here.
   */
  defaultValues?: readonly string[];
  /**
   * Whether the field is the step ANSWER, which is the one inline field with a
   * length to speak about: the build cuts it past ANSWER_BUDGET. Off unless
   * asked for — a layer panel and a question have no such ceiling, and a count
   * under them would read as a limit nobody set.
   *
   * On, the field shows the answer's lines and, past the budget, one line
   * about it. Both are ADVICE: nothing here refuses a keystroke and nothing rolls
   * text back. The publish check is where the cut is enforced, and it counts
   * by the same rendering this displays.
   */
  answerLength?: boolean;
  /** The site's glossary, whose link texts an answer's lines count. */
  glossary?: GlossaryContext;
  /**
   * Whether the field answers for an edit that adds something a build would
   * remove from an answer — an image, an embed, a footnote, a table, a code
   * block, a widget. Off unless asked for: it is the step answer that is
   * text only, not every inline field.
   *
   * What "answers for" means depends on how the text arrives, and the
   * difference matters to anyone relying on this:
   *
   *   - An ORDINARY change — typing, a paste, a drop, an undo or a redo —
   *     that adds one of those kinds is REFUSED: nothing is written, and the
   *     field keeps the value it was showing. An undo that brings a removed
   *     kind back is such a change and is refused with the rest, because the
   *     rule is about what an edit adds and not about how it was made.
   *   - A change the browser marks as an input method's — `isComposing`, or a
   *     composition input type — is never refused, only NOTICED: the text
   *     stands and the line under the field says why. Taking a composition
   *     back means writing a whole value into the shared text, which is an
   *     edit every other editor of the document receives, and a collaborator's
   *     sentence has been deleted that way. This is not a rare path: Android
   *     keyboards with suggestions mark ordinary Latin typing as composition,
   *     so on those keyboards the whole rule is advisory.
   *
   * The publish check is the enforcement in every case — it reads the stored
   * answer and blocks, which is also the only thing that can answer for text
   * a collaborator inserts from their own session.
   *
   * Only the removed kinds are answered for. A list, a heading, a block quote
   * or a horizontal rule is taken and left to the publish warning, because the
   * build keeps every word of those and only drops their marks.
   */
  textOnly?: boolean;
  /**
   * The `editor` key of the line shown when `textOnly` refuses a change.
   * Defaults to the answer's line, which points at a layer panel; a field
   * with no layer panel beside it names its own.
   */
  textOnlyMessageKey?: string;
  /** Focus the field when it mounts. */
  autoFocus?: boolean;
  /** Called on blur and on Escape, saying which. */
  onDone?: (reason: DoneReason) => void;
  /** Grow the textarea with its text instead of scrolling it. */
  grow?: boolean;
  /** A binding the caller holds; the field then does not bind `yText` itself. */
  binding?: CollaborativeText;
}

/**
 * The range of `current` that an edit producing `next` replaced, as far as the
 * two values can say.
 *
 * The fallback, for a refusal with no recorded selection behind it. A change
 * event reports the caret AFTER the edit, which says where an insertion ended
 * but nothing about how much a paste replaced, so what changed is bracketed by
 * the common prefix and the common suffix.
 *
 * They bracket the smallest textual difference, which is not always the
 * selection that produced it: replacing `hello` with `hello ![x](y)` looks
 * from the text alone like an insertion AFTER `hello`. Nothing read off the
 * two values can tell those apart — which is why the selection is recorded
 * before the edit and this is only what answers when none was.
 */
function replacedRange(current: string, next: string): [number, number] {
  let start = 0;
  while (start < current.length && start < next.length && current[start] === next[start]) {
    start += 1;
  }
  let fromEnd = 0;
  while (
    fromEnd < current.length - start &&
    fromEnd < next.length - start &&
    current[current.length - 1 - fromEnd] === next[next.length - 1 - fromEnd]
  ) {
    fromEnd += 1;
  }
  return [start, current.length - fromEnd];
}

/**
 * The input types the Input Events spec reserves for composition, which is
 * what an input method's text arrives under.
 *
 * `insertCompositionText` carries each provisional state; `insertFromComposition`
 * carries the text a composition commits — Safari sends that one AFTER
 * `compositionend`, which is why no flag set by those events can be trusted;
 * `deleteCompositionText` and `deleteByComposition` carry the removals a method
 * makes while composing.
 */
const COMPOSITION_INPUT_TYPES = new Set([
  "insertCompositionText",
  "insertFromComposition",
  "deleteCompositionText",
  "deleteByComposition",
]);

/**
 * Whether a change is a composition's, read from the event that carries it.
 *
 * The event is asked, and nothing is remembered between events. A flag set at
 * `compositionstart` has to be cleared by an event that may never arrive — a
 * composition ended after the field lost focus, ended before its own final
 * input, or never ended at all — and each of those left this field judging one
 * text against another it had no business comparing.
 *
 * A change that is not an input event at all carries neither field and is an
 * ordinary edit, which is also what a programmatic value set looks like.
 */
function isCompositionChange(native: Event): boolean {
  const input = native as InputEvent;
  return Boolean(input.isComposing) || COMPOSITION_INPUT_TYPES.has(input.inputType ?? "");
}

/**
 * The line telling an author why the field would not take what they typed.
 *
 * A subcomponent rather than a conditional in the field, so the field's own
 * body stays a single shape and what decides whether a line appears sits
 * beside the line.
 */
function TextOnlyNotice({ shown, messageKey }: { shown: boolean; messageKey: string }) {
  const { t } = useTranslation("editor");
  if (!shown) return null;
  return (
    <p data-testid="answer-text-only" className="font-body text-xs mt-1 text-terracotta" role="status">
      {t(messageKey)}
    </p>
  );
}

/** The bar runs past the budget, so the budget's mark sits inside it. */
const BAR_LINES = ANSWER_BUDGET * 1.25;

const barPercent = (lines: number) => `${(Math.min(lines, BAR_LINES) / BAR_LINES) * 100}%`;

/** Where the bar is marked: past the first mark the site sets the answer in smaller type, past the second it cuts it. */
const BAR_MARKS = [SMALL_TYPE_LINES, ANSWER_BUDGET];

function AnswerBudgetBar({ lines, over }: { lines: number; over: boolean }) {
  return (
    <div data-testid="answer-line-bar" aria-hidden="true" className="relative h-1 mt-1 rounded-full bg-gray-100">
      <div
        data-testid="answer-line-bar-fill"
        className={`h-full rounded-full ${over ? "bg-terracotta" : "bg-gray-300"}`}
        style={{ width: barPercent(lines) }}
      />
      {BAR_MARKS.map((mark) => (
        <span key={mark} data-mark={mark} className="absolute -top-0.5 h-2 w-px bg-gray-400" style={{ left: barPercent(mark) }} />
      ))}
    </div>
  );
}

/** The figures the rule's strings name. */
const RULE = {
  budget: ANSWER_BUDGET,
  max_paragraphs: MAX_PARAGRAPHS,
  line_chars: LINE_CHARS,
  break_lines: BREAK_LINES,
};

const NO_GLOSSARY: GlossaryContext = { terms: new Map(), baseUrl: "" };

/**
 * The answer's lines under the answer, against the budget, and past the
 * budget the one line about it. The lines are the rendered answer's, as the
 * build and the publish check count them, so a glossary link counts the
 * characters it shows.
 *
 * The live region holding that line is mounted whether or not there is a line
 * in it. A `role="status"` element that appears already carrying its text is
 * not reliably announced — the region has to exist before the message lands in
 * it — so what changes at the budget is the region's contents, never the
 * region itself.
 *
 * The bar draws the same number, marked where the smaller type starts and
 * where the budget falls. It is hidden from assistive technology, which has
 * the count and the line.
 */
export function AnswerBudgetCounter({ text, glossary = NO_GLOSSARY }: { text: string; glossary?: GlossaryContext }) {
  const { t } = useTranslation("editor");
  const measure = useMemo(() => renderAnswer(text, glossary).measure, [text, glossary]);
  const { lines } = measure;
  const over = !withinBudget(measure);
  return (
    <>
      <AnswerBudgetBar lines={lines} over={over} />
      <p
        data-testid="answer-line-count"
        data-over-limit={over || undefined}
        title={t("answer_budget_rule", { ...RULE, small_type_lines: SMALL_TYPE_LINES })}
        className={`font-body text-xs mt-1 text-right ${over ? "text-terracotta font-medium" : "text-gray-400"}`}
      >
        {t("answer_budget_count", { lines, budget: ANSWER_BUDGET })}
      </p>
      <p data-testid="answer-length-status" className={over ? "font-body text-xs mt-1 text-terracotta" : ""} role="status">
        {over && <span data-testid="answer-over-hard-limit">{t("answer_over_hard_limit", RULE)}</span>}
      </p>
    </>
  );
}

export function InlineTextArea({
  initialValue,
  yText,
  fieldKey,
  placeholder,
  className = "",
  inputClassName = "",
  rows = 3,
  bordered,
  defaultValues,
  answerLength,
  glossary,
  textOnly,
  textOnlyMessageKey = "answer_text_only",
  autoFocus,
  onDone,
  grow,
  binding,
}: InlineTextAreaProps) {
  const { t } = useTranslation("team");
  const own = useCollaborativeText(binding ? null : yText, initialValue, defaultValues);
  const text = binding ?? own;
  const { value, handleChange, currentValue } = text;
  const { isPublishing, remoteCollaborators, provider, lastEditorByField } = useCollaborationContext();
  const [isHovered, setIsHovered] = useState(false);
  // How many changes this field has refused since it last took one. A COUNT
  // rather than a flag, because two refusals in a row have to be two renders:
  // a flag already true commits none, and the effect that puts the selection
  // back never runs for the second.
  const [refusals, setRefusals] = useState(0);
  // The selection a refused change replaced. React re-renders the textarea
  // with the value it had, and the browser leaves the caret at the end of a
  // value it did not expect to see again — so an author editing the middle of
  // an answer is thrown to the end of it by a refusal.
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const refusedSelection = useRef<[number, number] | null>(null);
  // The selection as it stood before the change now arriving, recorded from
  // the events that precede one: a key going down, the pointer coming up, the
  // selection itself moving. The change event cannot supply it — by then the
  // caret has moved to the end of what was inserted — and the two values
  // cannot always recover it, so it is taken while it is still there.
  //
  // Cleared by every change, accepted or refused, so a refusal is never given
  // a selection from before the previous edit.
  const selectionBeforeChange = useRef<[number, number] | null>(null);
  const recordSelection = () => {
    const box = boxRef.current;
    if (box) selectionBeforeChange.current = [box.selectionStart, box.selectionEnd];
  };
  /** Says the field would not take a change, and where the caret goes back to. */
  const refuse = (selection: [number, number] | null) => {
    refusedSelection.current = selection;
    setRefusals((n) => n + 1);
  };

  // What a settle writes is a composition's text, so it is judged as one:
  // never refused, noticed if it adds a removed kind. One that adds none
  // clears the notice, because a cancelled composition takes back what it had
  // added.
  const settle = useSettleShownValue(boxRef, value, text, (replaced, shown) => {
    if (!textOnly) return;
    if (addsRemovedContent(replaced, shown)) refuse(null);
    else setRefusals(0);
  });

  // Height follows the text: reset, then set to what the text needs.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!grow || !box) return;
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight}px`;
  }, [grow, value]);

  useEffect(() => {
    const selection = refusedSelection.current;
    refusedSelection.current = null;
    if (!selection || !boxRef.current) return;
    boxRef.current.setSelectionRange(selection[0], selection[1]);
  });

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
    settle();
    onDone?.("blur");
  };

  const borderClass = bordered
    ? "rounded-md border border-gray-200 px-3 py-2 bg-white hover:border-gray-300 focus:border-anil"
    : "border-b border-transparent hover:border-gray-200 focus:border-anil";

  return (
    <div
      className="relative"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <textarea
        ref={boxRef}
        value={value}
        onChange={(e) => {
          // Dropping the change IS the refusal: the textarea is controlled, so
          // a change never written re-renders it with the value it had. This
          // catches a paste the same way it catches typing, because a paste
          // arrives here as one change like any other.
          const before = selectionBeforeChange.current;
          selectionBeforeChange.current = null;
          const next = e.target.value;
          // A composed change is measured against the SHARED text as it stands
          // now, because it is not refused and so has to be judged against
          // what the document actually holds: a collaborator's deletion
          // arrives before the render that shows it, and a comparison against
          // the screen counted content that was already gone. An ordinary
          // change is measured against the value the field is showing, which
          // is the value it keeps when the change is refused.
          const composed = isCompositionChange(e.nativeEvent);
          const raised = textOnly && addsRemovedContent(composed ? currentValue() : value, next);
          if (composed) {
            // Composed text stands whatever it says. The notice is the only
            // answer this field gives to it, and only the ordinary path clears
            // one — a later keystroke of the same composition has not undone
            // what an earlier one added.
            if (raised) refuse(null);
            handleChange(next);
            return;
          }
          if (raised) {
            // Nothing is written: the field is controlled, so the value it had
            // is the value it keeps.
            refuse(before ?? replacedRange(value, next));
            return;
          }
          setRefusals(0);
          handleChange(next);
        }}
        onCompositionEnd={settle}
        onSelect={recordSelection}
        onKeyDown={(event) => {
          recordSelection();
          if (event.key === "Escape" && !isCompositionKey(event)) settle();
          doneOnEscape(onDone)(event);
        }}
        autoFocus={autoFocus}
        onMouseUp={recordSelection}
        onFocus={handleFocus}
        onBlur={handleBlur}
        placeholder={placeholder}
        rows={rows}
        disabled={isPublishing}
        aria-disabled={isPublishing || undefined}
        className={`w-full bg-transparent resize-none transition-colors ${grow ? "overflow-hidden" : ""} ${borderClass} ${isPublishing ? "text-fg-disabled cursor-not-allowed" : ""} ${inputClassName} ${className}`}
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
      <TextOnlyNotice shown={refusals > 0} messageKey={textOnlyMessageKey} />
      {answerLength && <AnswerBudgetCounter text={value} glossary={glossary} />}
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
