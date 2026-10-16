// @vitest-environment jsdom
/**
 * The story settings panel: a button in the editor's bar opens it beside the
 * stage, the X and Escape close it, the section-list switch writes the
 * story's choice, and the panel says how to fill the list when the story has
 * no section cards.
 *
 * @version v1.5.5-beta
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
vi.mock("react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("~/hooks/use-media-query", () => ({ useMediaQuery: () => false }));

import { EditorShell } from "~/components/features/editor/EditorShell";
import { StorySettingsPanel } from "~/components/features/editor/StorySettingsPanel";
import type { TitleCardData } from "~/components/features/editor/TitleCardView";

afterEach(cleanup);

function data(over: Partial<TitleCardData> = {}) {
  return {
    story: { id: 1, title: "Your Story", subtitle: null, byline: null, show_sections: false },
    storyId: "your-story",
    sectionCardCount: 2,
    onToggleShowSections: vi.fn(),
    storyIds: ["your-story"],
    canRenameId: true,
    onRenameId: vi.fn(),
    ...over,
  };
}

function mount(over: Partial<TitleCardData> = {}) {
  const d = data(over);
  render(
    <EditorShell
      storyTitle="Your Story"
      sidebar={null}
      stage={<div data-testid="stage" />}
      settings={(close) => <StorySettingsPanel {...d} onClose={close} />}
    />,
  );
  return d;
}

const opener = () => screen.getByRole("button", { name: "story_settings.button" });

describe("the story settings panel", () => {
  it("is closed until the button in the bar is pressed, and the stage stays", () => {
    mount();
    expect(screen.queryByTestId("story-settings")).toBeNull();
    fireEvent.click(opener());
    expect(screen.getByTestId("story-settings")).toBeTruthy();
    expect(opener().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("stage")).toBeTruthy();
  });

  it("closes from the button, from the X, and on Escape", () => {
    mount();
    fireEvent.click(opener());
    fireEvent.click(opener());
    expect(screen.queryByTestId("story-settings")).toBeNull();
    fireEvent.click(opener());
    fireEvent.click(screen.getByRole("button", { name: "story_settings.close" }));
    expect(screen.queryByTestId("story-settings")).toBeNull();
    fireEvent.click(opener());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("story-settings")).toBeNull();
  });

  it("leaves the panel open when Escape cancels the ID editor", () => {
    mount();
    fireEvent.click(opener());
    fireEvent.click(screen.getByRole("button", { name: "change_id" }));
    // The app's React root is the document, where the panel also listens, so
    // only a prevented default keeps the panel open; stopping propagation cannot.
    const notPrevented = fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(notPrevented).toBe(false);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByTestId("story-settings")).toBeTruthy();
  });

  it("writes the section-list switch, and says how to fill the list only when there are no section cards", () => {
    const d = mount();
    fireEvent.click(opener());
    fireEvent.click(screen.getByRole("switch", { name: "story_settings.sections_label" }));
    expect(d.onToggleShowSections).toHaveBeenCalledWith(true);
    expect(screen.queryByText("title_card.show_sections_empty_helper")).toBeNull();
    cleanup();
    mount({ sectionCardCount: 0 });
    fireEvent.click(opener());
    expect(screen.getByText("title_card.show_sections_empty_helper")).toBeTruthy();
  });

  it("shows no button for a shell without settings", () => {
    render(<EditorShell storyTitle="Your Story" sidebar={null} stage={null} />);
    expect(screen.queryByRole("button", { name: "story_settings.button" })).toBeNull();
  });
});
