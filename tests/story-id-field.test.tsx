// @vitest-environment jsdom
/**
 * The story ID on the story's title card: whoever may delete the
 * story may change its ID; a value the rule refuses says why and changes
 * nothing; an accepted value first shows the warning that the story's address
 * changes at the next publish and that links to the old one stop working, and
 * changes nothing until the author confirms.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => `${key}|${JSON.stringify(options ?? {})}`,
    i18n: { language: "en" },
  }),
}));

import { StoryIdField } from "~/components/features/editor/StoryIdField";

function setUp(canRename = true) {
  const onRename = vi.fn();
  render(
    <StoryIdField storyId="blank_template" storyIds={["blank_template", "maps"]} canRename={canRename} onRename={onRename} />,
  );
  return { onRename };
}

function typeStoryId(value: string) {
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

describe("StoryIdField", () => {
  it("shows the ID as text to someone who may not change it", () => {
    setUp(false);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("blank_template")).toBeTruthy();
  });

  it("warns before changing, and changes the ID only on confirm", () => {
    const { onRename } = setUp();
    typeStoryId("  fluidity  ");
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("group").textContent).toContain(
      'title_card.story_id_warning|{"old":"blank_template","new":"fluidity"}',
    );
    fireEvent.click(screen.getByText(/title_card\.story_id_confirm/));
    expect(onRename).toHaveBeenCalledWith("fluidity");
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("keeps the old ID when the author declines", () => {
    const { onRename } = setUp();
    typeStoryId("fluidity");
    fireEvent.click(screen.getByText(/title_card\.story_id_keep/));
    expect(onRename).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("blank_template");
  });

  it.each([
    ["Fluidity", "title_card.story_id_invalid"],
    ["maps", "title_card.story_id_taken"],
    ["objects", "title_card.story_id_reserved"],
  ])("refuses %s with %s and shows no warning", (value, key) => {
    const { onRename } = setUp();
    typeStoryId(value);
    expect(screen.getByRole("alert").textContent).toContain(key);
    expect(screen.queryByRole("group")).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });

  it("does nothing when the ID is left as it was", () => {
    const { onRename } = setUp();
    typeStoryId("blank_template");
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });
});
