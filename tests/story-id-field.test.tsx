// @vitest-environment jsdom
/**
 * The story ID in the story settings: whoever may delete the story may change
 * its ID, through the Change ID button; the editor takes only the characters
 * the framework accepts; a value the rule refuses says why and changes
 * nothing; an accepted value first shows the warning that the story's address
 * changes at the next publish and that links to the old one stop working, and
 * changes nothing until the author confirms.
 *
 * @version v1.5.5-beta
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

function openEditor(): HTMLInputElement {
  fireEvent.click(screen.getByRole("button", { name: /^change_id/ }));
  return screen.getByRole("textbox") as HTMLInputElement;
}

function typeStoryId(value: string): HTMLInputElement {
  const input = openEditor();
  fireEvent.change(input, { target: { value } });
  return input;
}

describe("StoryIdField", () => {
  it("shows the ID and its address to someone who may not change it, with no button", () => {
    setUp(false);
    expect(screen.queryByRole("button", { name: /^change_id/ })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("blank_template")).toBeTruthy();
    expect(screen.getByText(/title_card\.story_id_address\|\{"id":"blank_template"\}/)).toBeTruthy();
  });

  it("opens an editor holding the current ID when Change ID is pressed", () => {
    setUp();
    expect(openEditor().value).toBe("blank_template");
  });

  it("drops characters the framework refuses as they are typed, and turns a space into a hyphen", () => {
    setUp();
    const input = typeStoryId("Fluid ity!_x");
    expect(input.value).toBe("fluid-ity_x");
  });

  it("types an accented letter as its plain form", () => {
    setUp();
    expect(typeStoryId("Año de la Revolución").value).toBe("ano-de-la-revolucion");
  });

  it("warns before changing, and changes the ID only on confirm", () => {
    const { onRename } = setUp();
    typeStoryId("fluidity");
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("group").textContent).toContain(
      'title_card.story_id_warning|{"old":"blank_template","new":"fluidity"}',
    );
    fireEvent.click(screen.getByRole("button", { name: /^change_id/ }));
    expect(onRename).toHaveBeenCalledWith("fluidity");
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("keeps the old ID when the author cancels", () => {
    const { onRename } = setUp();
    typeStoryId("fluidity");
    fireEvent.click(screen.getByRole("button", { name: /^cancel/ }));
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("blank_template")).toBeTruthy();
  });

  it.each([
    ["maps", "title_card.story_id_taken"],
    ["objects", "title_card.story_id_reserved"],
    ["", "title_card.story_id_invalid"],
  ])("refuses %j with %s and shows no warning", (value, key) => {
    const { onRename } = setUp();
    typeStoryId(value);
    expect(screen.getByRole("alert").textContent).toContain(key);
    expect(screen.queryByRole("group")).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });

  it("says nothing when the ID is left as it was", () => {
    const { onRename } = setUp();
    openEditor();
    expect(screen.queryByRole("group")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });
});
