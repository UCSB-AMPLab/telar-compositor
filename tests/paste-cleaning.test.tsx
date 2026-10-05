/**
 * @vitest-environment jsdom
 *
 * paste-cleaning.test.tsx — the document-level paste listener that cleans
 * pasted text in every plain text field (`~/lib/paste-cleaning`).
 *
 * jsdom implements neither a real clipboard nor `execCommand("insertText")`,
 * so each paste is a cancelable `paste` event carrying a stub `clipboardData`,
 * and `document.execCommand` is stubbed per case: once as a browser that
 * inserts the text itself and reports success, once as one that reports
 * failure, which is the path to `setRangeText` and the native value setter.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, cleanup, screen } from "@testing-library/react";
import { installPasteCleaning, handleTextFieldPaste } from "~/lib/paste-cleaning";
import { FieldWithHelp } from "~/components/features/config/FieldWithHelp";
import { readFileSync } from "node:fs";

const FFFE = String.fromCharCode(0xfffe);
const NEL = String.fromCharCode(0x85);
const LS = String.fromCharCode(0x2028);
const DIRTY = `Mediterr${FFFE}anean${LS}sea`;
const CLEANED = "Mediterranean sea";

type ExecCommand = (command: string, showUi?: boolean, value?: string) => boolean;

let uninstall: () => void = () => {};
let execCommand: ReturnType<typeof vi.fn<ExecCommand>>;

function stubExecCommand(impl: ExecCommand) {
  execCommand = vi.fn<ExecCommand>(impl);
  Object.defineProperty(document, "execCommand", { configurable: true, writable: true, value: execCommand });
}

/** A browser whose insertText inserts into the focused field and reports success. */
function browserInsert(): ExecCommand {
  return (command, _ui, value) => {
    const field = document.activeElement as HTMLInputElement | HTMLTextAreaElement;
    if (command !== "insertText" || !field) return false;
    field.setRangeText(value ?? "", field.selectionStart ?? 0, field.selectionEnd ?? 0, "end");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  };
}

function paste(target: Element, text: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: { getData: (type: string) => (type === "text/plain" ? text : "") },
  });
  target.dispatchEvent(event);
  return event;
}

function field(html: string): HTMLInputElement | HTMLTextAreaElement {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = html;
  document.body.appendChild(wrapper);
  const el = wrapper.firstElementChild as HTMLInputElement | HTMLTextAreaElement;
  el.focus();
  return el;
}

beforeEach(() => {
  document.body.innerHTML = "";
  uninstall = installPasteCleaning(document);
  stubExecCommand(() => false);
});

afterEach(() => {
  uninstall();
  cleanup();
});

describe("which pastes the listener takes over", () => {
  it.each([
    ["an input with no type", "<input />"],
    ["a text input", '<input type="text" />'],
    ["a search input", '<input type="search" />'],
    ["a url input", '<input type="url" />'],
    ["a tel input", '<input type="tel" />'],
    ["a textarea", "<textarea></textarea>"],
  ])("cleans a paste into %s", (_label, html) => {
    const el = field(html);
    const event = paste(el, DIRTY);
    expect(event.defaultPrevented).toBe(true);
    expect(el.value).toBe(CLEANED);
  });

  it.each([
    ["a password input", '<input type="password" />'],
    ["an email input, which has no selection to replace", '<input type="email" />'],
    ["a field marked verbatim, such as the story key", '<input type="text" data-paste-verbatim="" />'],
    ["a number input", '<input type="number" />'],
    ["a read-only input", '<input type="text" readonly />'],
    ["a disabled textarea", "<textarea disabled></textarea>"],
  ])("leaves a paste into %s to the browser", (_label, html) => {
    const el = field(html);
    const event = paste(el, DIRTY);
    expect(event.defaultPrevented).toBe(false);
    expect(el.value).toBe("");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("leaves a paste on an element that is not a text field alone", () => {
    const div = document.createElement("div");
    div.contentEditable = "true";
    document.body.appendChild(div);
    const event = paste(div, DIRTY);
    expect(event.defaultPrevented).toBe(false);
    expect(div.textContent).toBe("");
  });

  it("leaves a paste during a composition alone, and acts again once it ends", () => {
    const el = field('<input type="text" />');
    el.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    expect(paste(el, DIRTY).defaultPrevented).toBe(false);
    expect(el.value).toBe("");
    el.dispatchEvent(new Event("compositionend", { bubbles: true }));
    expect(paste(el, DIRTY).defaultPrevented).toBe(true);
    expect(el.value).toBe(CLEANED);
  });

  it("leaves a paste with nothing to clean untouched", () => {
    const el = field("<textarea></textarea>");
    const event = paste(el, "Ánfora de terracota\ncon decoración");
    expect(event.defaultPrevented).toBe(false);
    expect(el.value).toBe("");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("is removed by the function install returns", () => {
    uninstall();
    const el = field('<input type="text" />');
    expect(paste(el, DIRTY).defaultPrevented).toBe(false);
    uninstall = () => {};
  });
});

describe("how the cleaned text goes in", () => {
  it("inserts through execCommand when the browser accepts it", () => {
    stubExecCommand(browserInsert());
    const el = field('<input type="text" value="Mar " />');
    el.setSelectionRange(4, 4);
    paste(el, DIRTY);
    expect(execCommand).toHaveBeenCalledWith("insertText", false, CLEANED);
    expect(el.value).toBe(`Mar ${CLEANED}`);
  });

  it("does not insert a second time when execCommand reports success", () => {
    stubExecCommand(() => true);
    const el = field('<input type="text" />');
    paste(el, DIRTY);
    expect(execCommand).toHaveBeenCalledTimes(1);
    expect(el.value).toBe("");
  });

  it("falls back to setRangeText and an input event when execCommand returns false", () => {
    const el = field("<textarea>abc</textarea>");
    el.setSelectionRange(1, 2);
    const onInput = vi.fn();
    document.body.addEventListener("input", onInput);
    paste(el, `x${NEL}y`);
    document.body.removeEventListener("input", onInput);
    expect(execCommand).toHaveBeenCalledTimes(1);
    expect(el.value).toBe("ax yc");
    expect(el.selectionStart).toBe(4);
    expect(onInput).toHaveBeenCalledTimes(1);
  });

  it("falls back when execCommand throws", () => {
    stubExecCommand(() => {
      throw new Error("unsupported");
    });
    const el = field('<input type="url" />');
    paste(el, `https://example.org/${FFFE}mapa`);
    expect(el.value).toBe("https://example.org/mapa");
  });

  it("replaces a selection", () => {
    const el = field('<input type="search" value="uno dos tres" />');
    el.setSelectionRange(4, 7);
    paste(el, `DOS${FFFE}`);
    expect(el.value).toBe("uno DOS tres");
  });
});

describe("maxLength", () => {
  it("cuts the text to the room the limit leaves outside the selection", () => {
    const el = field('<input type="text" maxlength="10" value="abcdef" />');
    el.setSelectionRange(2, 4);
    paste(el, `12${FFFE}345678`);
    // 10 - (6 - 2) = 6 units of room.
    expect(el.value).toBe("ab123456ef");
  });

  it("never cuts between the halves of a surrogate pair", () => {
    const el = field('<input type="text" maxlength="4" value="ab" />');
    el.setSelectionRange(2, 2);
    // Room for two units: "x" and the high half of the pair, which is dropped.
    paste(el, `x\u{1F3FA}${FFFE}`);
    expect(el.value).toBe("abx");
  });

  it("inserts nothing when the field is full", () => {
    const el = field('<textarea maxlength="3">abc</textarea>');
    el.setSelectionRange(3, 3);
    const event = paste(el, `d${FFFE}`);
    expect(event.defaultPrevented).toBe(true);
    expect(el.value).toBe("abc");
    expect(execCommand).not.toHaveBeenCalled();
  });
});

describe("a paste that is entirely unsafe characters", () => {
  it("is cancelled and leaves the field as it was", () => {
    const el = field('<input type="text" value="abc" />');
    el.setSelectionRange(1, 2);
    const event = paste(el, `${FFFE}${FFFE}${String.fromCharCode(0x01)}`);
    expect(event.defaultPrevented).toBe(true);
    expect(el.value).toBe("abc");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("of separating characters inserts their spaces", () => {
    const el = field('<input type="text" value="ab" />');
    el.setSelectionRange(1, 1);
    paste(el, `${LS}${NEL}`);
    expect(el.value).toBe("a  b");
  });
});

describe("a controlled React field", () => {
  function Controlled({ multiline }: { multiline?: boolean }) {
    const [value, setValue] = useState("Mar ");
    return (
      <div>
        {multiline ? (
          <textarea aria-label="field" value={value} onChange={(e) => setValue(e.target.value)} />
        ) : (
          <input aria-label="field" type="text" value={value} onChange={(e) => setValue(e.target.value)} />
        )}
        <output data-testid="state">{value}</output>
      </div>
    );
  }

  it.each([
    ["input", false],
    ["textarea", true],
  ])("updates the %s's state through onChange on the fallback path", (_label, multiline) => {
    render(<Controlled multiline={multiline} />);
    const el = screen.getByLabelText("field") as HTMLInputElement;
    el.focus();
    el.setSelectionRange(4, 4);
    paste(el, DIRTY);
    expect(screen.getByTestId("state").textContent).toBe(`Mar ${CLEANED}`);
    expect(el.value).toBe(`Mar ${CLEANED}`);
  });

  it("updates state through onChange when execCommand inserts", () => {
    stubExecCommand(browserInsert());
    render(<Controlled />);
    const el = screen.getByLabelText("field") as HTMLInputElement;
    el.focus();
    el.setSelectionRange(4, 4);
    paste(el, DIRTY);
    expect(screen.getByTestId("state").textContent).toBe(`Mar ${CLEANED}`);
  });

});

describe("handleTextFieldPaste", () => {
  it("reports whether it took the paste over", () => {
    uninstall();
    uninstall = () => {};
    const el = field('<input type="text" />');
    const make = (text: string) => {
      const event = new Event("paste", { cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, "clipboardData", { value: { getData: () => text } });
      Object.defineProperty(event, "target", { value: el });
      return event;
    };
    expect(handleTextFieldPaste(make("limpio"), false)).toBe(false);
    expect(handleTextFieldPaste(make(DIRTY), true)).toBe(false);
    expect(handleTextFieldPaste(make(DIRTY), false)).toBe(true);
  });
});

describe("installing the listener", () => {
  it("installs once per document, so a paste is inserted once", () => {
    const again = installPasteCleaning(document);
    const el = field("<input />");
    paste(el, DIRTY);
    expect(el.value).toBe(CLEANED);
    again();
    paste(el, DIRTY);
    expect(el.value).toBe(CLEANED + CLEANED);
  });
});

describe("the story key", () => {
  it("keeps a pasted key exactly as pasted", () => {
    render(<FieldWithHelp label="Story key" name="story_key" value="" inputAttributes={{ "data-paste-verbatim": "" }} />);
    const el = screen.getByLabelText("Story key") as HTMLInputElement;
    el.focus();
    const event = paste(el, DIRTY);
    expect(event.defaultPrevented).toBe(false);
  });

  it("is rendered verbatim on the settings page", () => {
    const source = readFileSync("app/routes/_app.config.tsx", "utf8");
    const field = source.slice(source.indexOf('name="story_key"'), source.indexOf("/>", source.indexOf('name="story_key"')));
    expect(field).toContain('"data-paste-verbatim"');
  });
});
