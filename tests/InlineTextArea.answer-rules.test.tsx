// @vitest-environment jsdom
/**
 * This file pins what InlineTextArea does about the answer's two rules: what it
 * says about the answer's LINES against the budget, and its refusal of an edit
 * that adds an image or an embed.
 *
 * The count and the line past the budget are advice and nothing else. Neither
 * refuses a keystroke nor rolls text back — two people editing one Y.Text
 * cannot both be stopped at a line, and the publish check is where the cut is
 * enforced. What they must get right is the number, which is the rendered
 * answer's lines as the build counts them, and where the line appears.
 *
 * The media refusal is not advisory: answers are text only, and the framework
 * drops the media at build. It is an increase that is refused, not a value, so
 * an answer that already carries an image can still be emptied of it.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as Y from "yjs";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    isPublishing: false,
    remoteCollaborators: [],
    provider: null,
    lastEditorByField: new Map(),
  }),
}));

import { InlineTextArea } from "~/components/ui/InlineTextArea";
import enEditor from "~/i18n/locales/en/editor.json";
import esEditor from "~/i18n/locales/es/editor.json";

type FieldProps = { initialValue?: string; textOnly?: boolean; answerLength?: boolean };

function renderField(props: FieldProps) {
  return renderFieldOn(props).rendered;
}

/** The same field, with the shared text a collaborator would be writing into. */
function renderFieldOn(props: FieldProps) {
  const doc = new Y.Doc();
  const yText = doc.getText("answer");
  yText.insert(0, props.initialValue ?? "");
  const rendered = render(
    <InlineTextArea
      initialValue={props.initialValue ?? ""}
      yText={yText}
      answerLength={props.answerLength}
      textOnly={props.textOnly}
    />,
  );
  return { rendered, yText };
}

/** n words the counter reads as n words. */
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

/** One paragraph the counter reads as n lines: n words of 52 characters, 53n - 1 in all. */
const lines = (n: number) => Array.from({ length: n }, () => "x".repeat(52)).join(" ");

const RULE = '"budget":18,"max_paragraphs":5,"line_chars":53,"break_lines":2';
const count = (n: number) => `answer_budget_count:{"lines":${n},"budget":18}`;

const counter = () => screen.queryByTestId("answer-line-count");
const loud = () => screen.queryByTestId("answer-over-hard-limit");

beforeEach(() => {
  cleanup();
});

describe("what the answer field says about its lines", () => {
  const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;

  it("says nothing at all in a field that did not ask for the lines", () => {
    renderField({ initialValue: words(500) });
    expect(counter()).toBeNull();
    expect(loud()).toBeNull();
  });

  it("counts a short answer against the budget, with no line about it", () => {
    renderField({ answerLength: true, initialValue: "one two three" });
    expect(counter()?.textContent).toBe(count(1));
    expect(counter()?.getAttribute("title")).toBe(`answer_budget_rule:{${RULE},"small_type_lines":15}`);
    expect(loud()).toBeNull();
  });

  it("counts each paragraph after the first as two more lines", () => {
    renderField({ answerLength: true, initialValue: "one two\n\nthree\n\nfour" });
    expect(counter()?.textContent).toBe(count(7));
  });

  it("counts a line for each 53 characters of a paragraph, and one for what is left", () => {
    renderField({ answerLength: true, initialValue: `${"x".repeat(53)} ${"x".repeat(52)}` });
    expect(counter()?.textContent).toBe(count(2));
    fireEvent.change(box(), { target: { value: `${"x".repeat(53)} ${"x".repeat(53)}` } });
    expect(counter()?.textContent).toBe(count(3));
  });

  it("counts the characters a glossary link shows, not the reference", () => {
    const glossary = { terms: new Map([["iiif", "International Image Interoperability Framework"]]), baseUrl: "" };
    render(<InlineTextArea initialValue="Look here: The [[iiif]]" yText={null} answerLength glossary={glossary} />);
    expect(counter()?.textContent).toBe(count(2));
  });

  it("counts what the build keeps: markup has no characters, an image counts nothing", () => {
    renderField({ answerLength: true, initialValue: `${"**word** ".repeat(10)}![a](a.jpg)` });
    expect(counter()?.textContent).toBe(count(1));
  });

  // The bar is drawing only: the count and the line carry the number to
  // assistive technology, so the bar is hidden from it.
  it("draws the lines on a bar hidden from assistive technology, marked at the smaller type and the budget", () => {
    renderField({ answerLength: true, initialValue: lines(9) });
    const bar = screen.getByTestId("answer-line-bar");
    expect(bar.getAttribute("aria-hidden")).toBe("true");
    const marks = Array.from(bar.querySelectorAll<HTMLElement>("[data-mark]"));
    expect(marks.map((m) => m.dataset.mark)).toEqual(["15", "18"]);
    expect(marks.map((m) => parseFloat(m.style.left))).toEqual([expect.closeTo(66.667, 3), 80]);
    expect(screen.getByTestId("answer-line-bar-fill").style.width).toBe("40%");
  });

  it("fills the bar to the end past the budget, and no further", () => {
    renderField({ answerLength: true, initialValue: words(5000) });
    expect(screen.getByTestId("answer-line-bar-fill").style.width).toBe("100%");
  });

  it("counts an empty field as zero", () => {
    renderField({ answerLength: true, initialValue: "" });
    expect(counter()?.textContent).toBe(count(0));
  });

  // A role="status" element that appears already holding its text is not
  // reliably announced: the region has to be there before the message lands in
  // it. So the region is mounted from the start and only its contents change.
  it("keeps the live region mounted and empty before there is anything to say", () => {
    renderField({ answerLength: true, initialValue: words(50) });
    const region = screen.getByTestId("answer-length-status");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.textContent).toBe("");
  });

  it("fills that same region rather than mounting a new one when the lines pass the budget", () => {
    renderField({ answerLength: true, initialValue: words(50) });
    const before = screen.getByTestId("answer-length-status");
    fireEvent.change(box(), { target: { value: lines(19) } });
    const after = screen.getByTestId("answer-length-status");
    expect(after).toBe(before);
    expect(after.textContent).toBe(`answer_over_hard_limit:{${RULE}}`);
  });

  it("says nothing at exactly the budget, which the site publishes whole", () => {
    renderField({ answerLength: true, initialValue: lines(18) });
    expect(loud()).toBeNull();
    expect(counter()?.dataset.overLimit).toBeUndefined();
  });

  it("says the site will cut it from 19 lines, and marks the count", () => {
    renderField({ answerLength: true, initialValue: lines(19) });
    expect(loud()).not.toBeNull();
    expect(counter()?.dataset.overLimit).toBe("true");
    expect(counter()?.className).toContain("text-terracotta");
    expect(screen.getByTestId("answer-line-bar-fill").className).toContain("bg-terracotta");
  });

  it("says the site will cut it at six short paragraphs, though the lines are under the budget", () => {
    renderField({ answerLength: true, initialValue: Array.from({ length: 6 }, (_, i) => `w${i}`).join("\n\n") });
    expect(counter()?.textContent).toBe(count(16));
    expect(loud()).not.toBeNull();
    expect(counter()?.dataset.overLimit).toBe("true");
  });

  it("follows what is typed, crossing the budget as the words arrive", () => {
    renderField({ answerLength: true, initialValue: "one" });
    expect(loud()).toBeNull();

    fireEvent.change(box(), { target: { value: lines(19) } });
    expect(box().value).toBe(lines(19));
    expect(counter()?.textContent).toBe(count(19));
    expect(loud()).not.toBeNull();
  });

  // Advice, not a gate. Nothing here refuses a keystroke and nothing rolls a
  // value back, whatever the count says.
  it("takes every keystroke past the budget, and rolls nothing back", () => {
    const { yText } = renderFieldOn({ answerLength: true, initialValue: words(200) });

    fireEvent.change(box(), { target: { value: words(400) } });

    expect(box().value).toBe(words(400));
    expect(yText.toString()).toBe(words(400));
  });
});

describe("the answer field's refusal of an image or an embed", () => {
  const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;

  it("keeps the previous value when an edit adds a markdown image", () => {
    renderField({ textOnly: true, initialValue: "The loom" });

    fireEvent.change(box(), { target: { value: "The loom ![a loom](loom.jpg)" } });

    expect(box().value).toBe("The loom");
  });

  it("keeps the previous value when an image tag is pasted in", () => {
    renderField({ textOnly: true, initialValue: "The loom" });

    fireEvent.change(box(), { target: { value: '<img src="loom.jpg"> The loom' } });

    expect(box().value).toBe("The loom");
  });

  it.each(["iframe", "video", "audio", "embed", "object"])(
    "keeps the previous value when a %s element is added",
    (tag) => {
      renderField({ textOnly: true, initialValue: "The loom" });

      fireEvent.change(box(), { target: { value: `The loom <${tag} src="x"></${tag}>` } });

      expect(box().value).toBe("The loom");
    },
  );

  it("takes the edit when it adds no media", () => {
    renderField({ textOnly: true, initialValue: "The loom" });

    fireEvent.change(box(), { target: { value: "The loom at dawn" } });

    expect(box().value).toBe("The loom at dawn");
  });

  it("takes a bare image URL, which is text", () => {
    renderField({ textOnly: true, initialValue: "See" });

    fireEvent.change(box(), { target: { value: "See https://example.org/loom.jpg" } });

    expect(box().value).toBe("See https://example.org/loom.jpg");
  });

  it("lets an image an answer already carries be removed", () => {
    renderField({ textOnly: true, initialValue: "Before ![a loom](loom.jpg) after" });

    fireEvent.change(box(), { target: { value: "Before after" } });

    expect(box().value).toBe("Before after");
  });

  it("still refuses a second image added beside one already there", () => {
    const initialValue = "![one](a.jpg)";
    renderField({ textOnly: true, initialValue });

    fireEvent.change(box(), { target: { value: "![one](a.jpg) ![two](b.jpg)" } });

    expect(box().value).toBe(initialValue);
  });

  it("refuses nothing in a field that did not ask for the rule", () => {
    renderField({ initialValue: "The loom" });

    fireEvent.change(box(), { target: { value: "The loom ![a loom](loom.jpg)" } });

    expect(box().value).toBe("The loom ![a loom](loom.jpg)");
  });
});

describe("the answer field's refusal of the other removed kinds", () => {
  const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
  const message = () => screen.queryByTestId("answer-text-only");

  it("refuses the third backtick that opens a fence", () => {
    renderField({ textOnly: true, initialValue: "``\ncode\n```" });

    fireEvent.change(box(), { target: { value: "```\ncode\n```" } });

    expect(box().value).toBe("``\ncode\n```");
  });

  it("refuses a pasted table", () => {
    renderField({ textOnly: true, initialValue: "The loom" });

    fireEvent.change(box(), {
      target: { value: "The loom\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n" },
    });

    expect(box().value).toBe("The loom");
  });

  it("refuses a footnote reference to a definition at its closing bracket", () => {
    renderField({ textOnly: true, initialValue: "A claim[^1\n\n[^1]: The source" });

    fireEvent.change(box(), { target: { value: "A claim[^1]\n\n[^1]: The source" } });

    expect(box().value).toBe("A claim[^1\n\n[^1]: The source");
  });

  // With no definition the build publishes the reference as the text it is.
  it("takes a footnote reference with no definition, which is text", () => {
    renderField({ textOnly: true, initialValue: "A claim[^1" });

    fireEvent.change(box(), { target: { value: "A claim[^1]" } });

    expect(box().value).toBe("A claim[^1]");
  });

  it("refuses a footnote definition", () => {
    renderField({ textOnly: true, initialValue: "A claim." });

    fireEvent.change(box(), { target: { value: "A claim.\n\n[^1]: The source\n" } });

    expect(box().value).toBe("A claim.");
  });

  it("refuses a pasted widget", () => {
    renderField({ textOnly: true, initialValue: "The loom" });

    fireEvent.change(box(), {
      target: { value: "The loom\n\n:::glossary\nentry: carta\n:::\n" },
    });

    expect(box().value).toBe("The loom");
    expect(message()?.textContent).toBe("answer_text_only");
  });

  it("refuses the closing line typed into a widget", () => {
    renderField({ textOnly: true, initialValue: "The loom\n\n:::glossary\nentry: carta\n::" });

    fireEvent.change(box(), {
      target: { value: "The loom\n\n:::glossary\nentry: carta\n:::" },
    });

    expect(box().value).toBe("The loom\n\n:::glossary\nentry: carta\n::");
    expect(message()?.textContent).toBe("answer_text_only");
  });

  it("names widgets in the reason it gives, in both catalogues", () => {
    expect(enEditor.answer_text_only).toBe(
      "Answers are text only — put images, tables, code, footnotes and widgets in a layer panel.",
    );
    expect(esEditor.answer_text_only).toBe(
      "Las respuestas son solo texto — pasa imágenes, tablas, código, notas al pie y widgets a un panel de capa.",
    );
  });

  it("takes a list marker, which the build only flattens", () => {
    renderField({ textOnly: true, initialValue: "one" });

    fireEvent.change(box(), { target: { value: "- one" } });

    expect(box().value).toBe("- one");
  });

  it.each(["# A heading", "> A quote", "one\n---\ntwo"])(
    "takes %j, which the build only flattens",
    (next) => {
      renderField({ textOnly: true, initialValue: "one" });

      fireEvent.change(box(), { target: { value: next } });

      expect(box().value).toBe(next);
    },
  );

  it("takes a link", () => {
    renderField({ textOnly: true, initialValue: "See" });

    fireEvent.change(box(), { target: { value: "See [the loom](x)" } });

    expect(box().value).toBe("See [the loom](x)");
  });

  it("shows the reason on a refusal and clears it on the next accepted change", () => {
    renderField({ textOnly: true, initialValue: "The loom" });
    expect(message()).toBeNull();

    fireEvent.change(box(), { target: { value: "The loom ![a](a.jpg)" } });
    expect(message()?.textContent).toBe("answer_text_only");

    fireEvent.change(box(), { target: { value: "The loom at dawn" } });
    expect(message()).toBeNull();
  });

  it("shows no reason in a field that did not ask for the rule", () => {
    renderField({ initialValue: "The loom" });

    fireEvent.change(box(), { target: { value: "The loom ![a](a.jpg)" } });

    expect(message()).toBeNull();
  });
});

describe("what a refusal leaves behind", () => {
  const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;

  it("keeps the caret where the refused insertion began", () => {
    renderField({ textOnly: true, initialValue: "alpha omega" });
    box().setSelectionRange(6, 6);

    fireEvent.change(box(), {
      target: { value: "alpha ![x](y)omega", selectionStart: 13, selectionEnd: 13 },
    });

    expect(box().value).toBe("alpha omega");
    expect([box().selectionStart, box().selectionEnd]).toEqual([6, 6]);
  });

  // "Refuse on presence" and "refuse on increase" differ on exactly this one
  // case, and nothing else in this file distinguishes them.
  it("takes an edit elsewhere in an answer that already holds an image", () => {
    renderField({ textOnly: true, initialValue: "Before ![a](a.jpg) after" });

    fireEvent.change(box(), { target: { value: "Before ![a](a.jpg) after now" } });

    expect(box().value).toBe("Before ![a](a.jpg) after now");
  });

  it.each([
    ["a footnote", "A claim[^1]. More"],
    ["a table", "| a |\n| --- |\nMore"],
    ["a code block", "```\nx\n```\nMore"],
  ])("takes an edit elsewhere in an answer that already holds %s", (_name, initialValue) => {
    renderField({ textOnly: true, initialValue });

    fireEvent.change(box(), { target: { value: `${initialValue} now` } });

    expect(box().value).toBe(`${initialValue} now`);
  });
});

// An IME composes a character over several keystrokes, and every provisional
// state arrives here as an ordinary change. None of them is what the author
// typed: judging them refused text nobody had finished, and the field snapping
// back mid-composition cancels the composition outright on some methods.
//
// What tells them apart is the change event itself — `isComposing`, or an
// input type the Input Events spec reserves for composition — so nothing about
// a composition is remembered between events. A flag would have to be cleared
// by an event that may never arrive: a composition that ends after a blur, one
// whose end the browser sends before the final input, one that is simply never
// ended. Each of those left the field judging the wrong text.
//
// A composition is never taken back, either. Undoing one means writing a whole
// value into the shared text, and that write is what every other editor of the
// document receives: a collaborator's sentence, typed while a composition was
// open, was deleted by the rollback. So composed text stands, the notice says
// what is wrong with it, and the publish check is what refuses to ship it.
describe("text arriving from an input method", () => {
  const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;
  const message = () => screen.queryByTestId("answer-text-only");

  /** One provisional state of a composition, as the browser reports it. */
  const composing = (value: string, inputType = "insertCompositionText") =>
    fireEvent.input(box(), { target: { value }, inputType, isComposing: true });

  /** The final input a composition commits, which carries no isComposing. */
  const committed = (value: string) =>
    fireEvent.input(box(), {
      target: { value },
      inputType: "insertFromComposition",
      isComposing: false,
    });

  it("lets a half-composed state stand without judging it", () => {
    renderField({ textOnly: true, initialValue: "alpha omega" });

    composing("alpha ![x](y");

    expect(box().value).toBe("alpha ![x](y");
    expect(message()).toBeNull();
  });

  // Safari sends the final input AFTER compositionend, and judging it as an
  // ordinary edit refused the closing bracket — leaving the author with text
  // they never typed and the document with a truncated answer.
  it("keeps the text a composition commits after its end, and says what is wrong", () => {
    renderField({ textOnly: true, initialValue: "alpha" });
    composing("alpha ![x](y");
    fireEvent.compositionEnd(box());

    committed("alpha ![x](y)");

    expect(box().value).toBe("alpha ![x](y)");
    expect(message()?.textContent).toBe("answer_text_only");
  });

  it("keeps a collaborator's edit that arrived while a composition was open", () => {
    const { yText } = renderFieldOn({ textOnly: true, initialValue: "alpha omega" });
    composing("alpha ![x](y)");

    // Another editor, writing into the same Y.Text from their own session.
    // Wrapped so the render it causes is committed before the next event, as
    // it would be in a browser.
    act(() => {
      yText.insert(yText.length, " REMOTE");
    });
    committed("alpha ![x](y) REMOTE");

    expect(yText.toString()).toContain(" REMOTE");
    expect(box().value).toContain(" REMOTE");
  });

  it("says nothing about a composition that adds nothing a build would remove", () => {
    renderField({ textOnly: true, initialValue: "alpha " });

    composing("alpha 織");
    committed("alpha 織り");

    expect(box().value).toBe("alpha 織り");
    expect(message()).toBeNull();
  });

  // Nothing is remembered between events, so a composition nobody ended cannot
  // leave later edits passing through unjudged.
  it("judges an ordinary paste that follows a composition nobody ended", () => {
    renderField({ textOnly: true, initialValue: "alpha" });
    composing("alpha 織");

    fireEvent.change(box(), { target: { value: "alpha 織 ![x](y)" } });

    expect(box().value).toBe("alpha 織");
    expect(message()?.textContent).toBe("answer_text_only");
  });

  it("leaves a notice standing when a stray composition end arrives after it", () => {
    renderField({ textOnly: true, initialValue: "alpha" });
    fireEvent.change(box(), { target: { value: "alpha ![x](y)" } });
    expect(message()?.textContent).toBe("answer_text_only");

    fireEvent.compositionEnd(box());

    expect(message()?.textContent).toBe("answer_text_only");
  });

  // A composed change is measured against the SHARED text as it stands at that
  // moment, not against the last thing React drew. A collaborator's deletion
  // arrives through Yjs and the render that shows it is scheduled, not
  // immediate — so a comparison against the screen counted an image that was
  // already gone and let a local one through unremarked. No act() here on
  // purpose: the point is the change that arrives before the render.
  it("notices a composed image when a remote deletion has not been drawn yet", () => {
    const { yText } = renderFieldOn({ textOnly: true, initialValue: "alpha ![remote](r)" });

    yText.delete(5, yText.length - 5);
    composing("alpha ![local](l)");

    expect(yText.toString()).toBe("alpha ![local](l)");
    expect(message()?.textContent).toBe("answer_text_only");
  });

  it("says nothing when a composition adds nothing the shared text did not already hold", () => {
    const { yText } = renderFieldOn({ textOnly: true, initialValue: "alpha ![remote](r)" });

    composing("alpha ![remote](r) more");

    expect(yText.toString()).toBe("alpha ![remote](r) more");
    expect(message()).toBeNull();
  });
});

describe("the selection a refusal restores", () => {
  const box = () => screen.getByRole("textbox") as HTMLTextAreaElement;

  it("restores the same offset on a second consecutive refusal", () => {
    renderField({ textOnly: true, initialValue: "alpha omega" });
    box().setSelectionRange(6, 6);

    fireEvent.change(box(), {
      target: { value: "alpha ![x](y)omega", selectionStart: 13, selectionEnd: 13 },
    });
    expect([box().selectionStart, box().selectionEnd]).toEqual([6, 6]);

    box().setSelectionRange(6, 6);
    fireEvent.change(box(), {
      target: { value: "alpha ![x](y)omega", selectionStart: 13, selectionEnd: 13 },
    });

    expect(box().value).toBe("alpha omega");
    expect([box().selectionStart, box().selectionEnd]).toEqual([6, 6]);
  });

  it("restores a replaced selection's whole extent, not just its start", () => {
    renderField({ textOnly: true, initialValue: "alpha omega" });
    box().setSelectionRange(0, 5);

    fireEvent.change(box(), {
      target: { value: "![x](y) omega", selectionStart: 7, selectionEnd: 7 },
    });

    expect(box().value).toBe("alpha omega");
    expect([box().selectionStart, box().selectionEnd]).toEqual([0, 5]);
  });

  // Comparing the two values finds the smallest textual difference, which is
  // not the selection that produced it: a replacement that BEGINS with the
  // text it replaced looks like an insertion after it. The field records the
  // selection the edit started from instead, and only falls back to the
  // comparison when it has none.
  it("restores a selection whose replacement begins with the text it replaced", () => {
    renderField({ textOnly: true, initialValue: "hello world" });
    box().setSelectionRange(0, 5);
    fireEvent.select(box());

    fireEvent.change(box(), {
      target: { value: "hello ![x](y) world", selectionStart: 13, selectionEnd: 13 },
    });

    expect(box().value).toBe("hello world");
    expect([box().selectionStart, box().selectionEnd]).toEqual([0, 5]);
  });

  it.each([
    ["a key", (el: HTMLTextAreaElement) => fireEvent.keyDown(el, { key: "v" })],
    ["the pointer", (el: HTMLTextAreaElement) => fireEvent.mouseUp(el)],
  ])("records the selection reached by %s too", (_name, reach) => {
    renderField({ textOnly: true, initialValue: "hello world" });
    box().setSelectionRange(0, 5);
    reach(box());

    fireEvent.change(box(), {
      target: { value: "hello ![x](y) world", selectionStart: 13, selectionEnd: 13 },
    });

    expect([box().selectionStart, box().selectionEnd]).toEqual([0, 5]);
  });
});
