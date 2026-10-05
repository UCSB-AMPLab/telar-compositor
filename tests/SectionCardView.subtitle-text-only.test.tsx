// @vitest-environment jsdom
/**
 * A section's subtitle is its step's answer, and the build applies the answer
 * rules to it, so the subtitle field refuses what the answer field refuses and
 * says so in words that fit a card with no layer panel. The field opens from
 * the subtitle's text, edited in place.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import * as Y from "yjs";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    isPublishing: false,
    remoteCollaborators: [],
    provider: null,
    ydoc: null,
    undoManager: null,
    lastEditorByField: new Map(),
  }),
}));

import { SectionCardView } from "~/components/features/editor/SectionCardView";
import { resetTargetSaves } from "~/components/ui/target-saves";

beforeEach(() => {
  cleanup();
  resetTargetSaves();
});

function renderSection(answer: string) {
  const doc = new Y.Doc();
  const q = doc.getText("q");
  const a = doc.getText("a");
  a.insert(0, answer);
  render(
    <SectionCardView
      step={{ id: 1, question: "", answer }}
      target="id:1"
      fieldKeyPrefix="step-s-1"
      questionYText={q}
      answerYText={a}
      glossary={{ terms: new Map(), baseUrl: "" }}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "section_card.subtitle_label" }));
  return screen.getAllByRole("textbox").find((el) => el.tagName === "TEXTAREA") as HTMLTextAreaElement;
}

describe("the section subtitle", () => {
  it.each([
    ["an image", "Loom ![a loom](loom.jpg)"],
    ["a table", "Loom\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n"],
    ["a footnote", "Loom[^1]\n\n[^1]: A note."],
  ])("refuses %s and says why", (_n, next) => {
    const box = renderSection("Loom");
    fireEvent.change(box, { target: { value: next } });
    expect(box.value).toBe("Loom");
    expect(screen.getByTestId("answer-text-only").textContent).toBe("section_card.subtitle_text_only");
  });

  it("takes plain text", () => {
    const box = renderSection("Loom");
    fireEvent.change(box, { target: { value: "Loom and thread" } });
    expect(box.value).toBe("Loom and thread");
    expect(screen.queryByTestId("answer-text-only")).toBeNull();
  });
});
