// @vitest-environment jsdom
/**
 * The title card and a section card as the published page draws them, edited
 * in place: the story intro with its title, subtitle and byline, the section
 * list under "Sections" with the list turned on, the scroll hint for the
 * layout, and the section card's heading and plain-text body. The story's ID
 * and the section list's switch are the editor's, beside the card.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import * as Y from "yjs";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { changeLanguage: vi.fn() } }),
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

import { TitleCardSettings, TitleCardView, type TitleCardData } from "~/components/features/editor/TitleCardView";
import { SectionCardView } from "~/components/features/editor/SectionCardView";
import { resetTargetSaves } from "~/components/ui/target-saves";

afterEach(() => {
  cleanup();
  resetTargetSaves();
});

function titleCard(over: Partial<TitleCardData> = {}, showSections = false): TitleCardData {
  return {
    story: { id: 1, title: "Your Story", subtitle: "An allegorical map", byline: "Start with this template", show_sections: showSections },
    storyId: "your-story",
    titleYText: null,
    subtitleYText: null,
    bylineYText: null,
    sectionCardCount: 2,
    sectionTitles: ["Sound and Movement", "Back to the Engraving"],
    onToggleShowSections: vi.fn(),
    storyIds: ["your-story"],
    canRenameId: true,
    onRenameId: vi.fn(),
    ...over,
  };
}

describe("the title card", () => {
  it("is the story intro: the title as its heading, then the subtitle and byline, and the arrow-key hint", () => {
    render(<TitleCardView {...titleCard()} layoutMode="horizontal" />);
    const intro = screen.getByTestId("story-intro");
    expect(intro.className).toBe("story-intro");
    expect(intro.querySelector(".intro-floating-card h1.intro-title")?.textContent).toBe("Your Story");
    expect(intro.querySelector("h2.intro-subtitle")?.textContent).toBe("An allegorical map");
    expect(intro.querySelector(".intro-byline")?.textContent?.trim()).toBe("Start with this template");
    expect(intro.querySelector(".intro-hint small")?.textContent).toBe("stage.scroll_hint");
    expect(screen.getByTestId("intro-edit-hint").textContent).toBe("stage.edit_hint_title");
    expect(intro.querySelector(".intro-toc")).toBeNull();
  });

  it("shows the button hint on a vertical layout, as the published page does", () => {
    render(<TitleCardView {...titleCard()} layoutMode="vertical" />);
    expect(screen.getByTestId("story-intro").querySelector(".intro-hint small")?.textContent).toBe("stage.scroll_hint_mobile");
  });

  it("takes the layer 2 colour with the section list on, and lists the section titles under 'Sections'", () => {
    render(<TitleCardView {...titleCard({}, true)} layoutMode="horizontal" />);
    const intro = screen.getByTestId("story-intro");
    expect(intro.className).toBe("story-intro story-intro--toc");
    const nav = screen.getByRole("navigation", { name: "stage.sections_heading" });
    expect(nav.querySelector(".intro-toc-heading")?.textContent).toBe("stage.sections_heading");
    expect(Array.from(nav.querySelectorAll("li")).map((li) => li.textContent)).toEqual(["Sound and Movement", "Back to the Engraving"]);
  });

  it("lists nothing, and keeps the colour, with the list on and no section titles", () => {
    render(<TitleCardView {...titleCard({ sectionTitles: [] }, true)} layoutMode="horizontal" />);
    expect(screen.getByTestId("story-intro").className).toContain("story-intro--toc");
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("does not edit the section titles: they are edited on the section cards", () => {
    render(<TitleCardView {...titleCard({}, true)} layoutMode="horizontal" />);
    const nav = screen.getByRole("navigation", { name: "stage.sections_heading" });
    expect(nav.querySelectorAll("[data-in-place], button, input, a").length).toBe(0);
  });

  it("edits the title, subtitle and byline in place, writing to their Y.Text", async () => {
    const doc = new Y.Doc();
    const texts = { title: doc.getText("title"), subtitle: doc.getText("subtitle"), byline: doc.getText("byline") };
    texts.title.insert(0, "Your Story");
    render(
      <TitleCardView
        {...titleCard()}
        titleYText={texts.title}
        subtitleYText={texts.subtitle}
        bylineYText={texts.byline}
        layoutMode="horizontal"
      />,
    );
    for (const [name, value] of [["title", "The Allegorical Woman"], ["subtitle", "A map"], ["byline", "By Ana"]] as const) {
      fireEvent.click(screen.getByRole("button", { name: `title_card.${name}_label` }));
      const input = await waitFor(() => screen.getByTestId("story-intro").querySelector("input")!);
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
      await waitFor(() => expect(screen.getByTestId("story-intro").querySelector("input")).toBeNull());
      expect(texts[name].toString()).toBe(value);
    }
  });

  it("renders the byline's Markdown as the published intro prints it, with no paragraph around it", () => {
    render(<TitleCardView {...titleCard({ story: { id: 1, title: "T", subtitle: null, byline: "By **Ana**", show_sections: false } })} layoutMode="horizontal" />);
    const byline = screen.getByRole("button", { name: "title_card.byline_label" });
    expect(byline.querySelector("strong")?.textContent).toBe("Ana");
    expect(byline.textContent?.trim()).toBe("By Ana");
    expect(byline.querySelector("p")).toBeNull();
  });

  it("edits the byline as the text it is typed as", async () => {
    const doc = new Y.Doc();
    const byline = doc.getText("byline");
    byline.insert(0, "By **Ana**");
    render(<TitleCardView {...titleCard()} bylineYText={byline} layoutMode="horizontal" />);
    fireEvent.click(screen.getByRole("button", { name: "title_card.byline_label" }));
    const input = await waitFor(() => screen.getByTestId("story-intro").querySelector("input")!);
    expect(input.value).toBe("By **Ana**");
  });

  it("shows an empty subtitle and byline as their muted placeholders, so they can be clicked", () => {
    render(<TitleCardView {...titleCard({ story: { id: 1, title: "T", subtitle: null, byline: null, show_sections: false } })} layoutMode="horizontal" />);
    expect(screen.getByRole("button", { name: "title_card.subtitle_label" }).textContent).toBe("title_card.subtitle_placeholder");
    expect(screen.getByRole("button", { name: "title_card.byline_label" }).textContent).toBe("title_card.byline_placeholder");
  });
});

describe("the title card's settings", () => {
  it("keeps the sections switch, which writes the story's choice", () => {
    const data = titleCard();
    render(<TitleCardSettings {...data} />);
    const toggle = screen.getByRole("switch", { name: "title_card.show_sections_label" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(data.onToggleShowSections).toHaveBeenCalledWith(true);
    expect(screen.queryByText("title_card.show_sections_empty_helper")).toBeNull();
  });

  it("says how to fill the list when the story has no section cards, and keeps the story's ID", () => {
    render(<TitleCardSettings {...titleCard({ sectionCardCount: 0, sectionTitles: [] })} />);
    expect(screen.getByText("title_card.show_sections_empty_helper")).toBeTruthy();
    expect((screen.getByLabelText("title_card.story_id_label") as HTMLInputElement).value).toBe("your-story");
  });
});

describe("a section card", () => {
  function section(over: Partial<Parameters<typeof SectionCardView>[0]> = {}) {
    return (
      <SectionCardView
        step={{ id: 7, question: "Sound **and** Movement", answer: "Now we turn to *sound*." }}
        target="id:7"
        fieldKeyPrefix="step-s-7"
        questionYText={null}
        answerYText={null}
        onSaveField={vi.fn(async () => undefined)}
        glossary={{ terms: new Map(), baseUrl: "" }}
        {...over}
      />
    );
  }

  it("is the framework's centred card: the question as its heading, as escaped plain text", () => {
    render(section());
    const card = screen.getByTestId("section-card");
    expect(card.className).toBe("title-card");
    const heading = card.querySelector(".title-card-inner h2.title-card-heading")!;
    expect(heading.textContent).toBe("Sound **and** Movement");
    expect(heading.querySelector("b, em, strong")).toBeNull();
    expect(screen.getByTestId("intro-edit-hint").textContent).toBe("stage.edit_hint");
  });

  it("renders the answer as the build publishes it, as the step card's answer is: italics as <em>", () => {
    render(section());
    const block = screen.getByRole("button", { name: "section_card.subtitle_label" });
    expect(block.closest(".title-card-body")).not.toBeNull();
    expect(block.querySelector("em")?.textContent).toBe("sound");
    expect(block.textContent).toContain("Now we turn to sound.");
  });

  it("frames nothing: no frame, circle, capture or panel button", () => {
    render(section());
    const card = screen.getByTestId("section-card");
    expect(card.querySelector(".panel-trigger, [data-testid='card-ceiling']")).toBeNull();
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "section_card.heading_label",
      "section_card.subtitle_label",
    ]);
  });

  it("saves a finished field without a Y.Text through onSaveField", async () => {
    const onSaveField = vi.fn(async () => undefined);
    render(section({ onSaveField }));
    fireEvent.click(screen.getByRole("button", { name: "section_card.subtitle_label" }));
    const box = await waitFor(() => screen.getByTestId("section-card").querySelector("textarea")!);
    fireEvent.change(box, { target: { value: "Now we turn to sound." } });
    fireEvent.blur(box);
    await waitFor(() => expect(onSaveField).toHaveBeenCalledWith("answer", "Now we turn to sound."));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "section_card.subtitle_label" }).textContent).toContain("Now we turn to sound."),
    );
    await waitFor(() => expect(screen.getByTestId("section-card").querySelector("textarea")).toBeNull());
  });

  it("keeps the field open with its draft and the error when the save fails", async () => {
    const onSaveField = vi.fn(async () => {
      throw new Error("refused");
    });
    render(section({ onSaveField, saveErrorMessage: "stage.save_failed" }));
    fireEvent.click(screen.getByRole("button", { name: "section_card.heading_label" }));
    const input = await waitFor(() => screen.getByTestId("section-card").querySelector("input")!);
    fireEvent.change(input, { target: { value: "Sound" } });
    fireEvent.blur(input);
    await screen.findByText("stage.save_failed");
    expect(screen.getByTestId("section-card").querySelector("input")?.value).toBe("Sound");
  });
});

describe("the cards' stylesheet", () => {
  const css = readFileSync(join(__dirname, "..", "app/styles/visitor-layer.css"), "utf8");
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf("}", at));
  };

  it("gives the section card's rendered paragraphs the reboot's margin, which Tailwind's preflight removes", () => {
    expect(rule(".visitor-layer .title-card-body p")).toContain("margin: 0 0 1rem;");
  });

  it("scrolls a card taller than the window, centring it with auto margins while it fits", () => {
    const host = rule(".visitor-layer :is(.story-intro, .title-card)");
    expect(host).toContain("overflow-y: auto;");
    expect(host).not.toContain("align-items: center;");
    expect(rule(".visitor-layer :is(.intro-floating-card, .title-card-inner)")).toContain("margin: auto;");
  });
});
