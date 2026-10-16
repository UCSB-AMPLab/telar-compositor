// @vitest-environment jsdom
/**
 * The publish page's question for a page held in more than one language
 * (`PageLanguageChoice`): the page named with its files, a choice per
 * version with none made, and for a version other than the page's own, what
 * keeping it does to the files.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";

const interpolate = (key: string, opts?: Record<string, unknown>) =>
  opts ? `${key} ${Object.entries(opts).map(([k, v]) => `${k}=${String(v)}`).join(" ")}` : key;
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: interpolate, i18n: { language: "en" } }) }));

import { PageLanguageChoice } from "~/components/features/publish/PageLanguageChoice";

const GROUP = {
  page: { pageId: 5, file: "about.md", title: "About" },
  others: [{ pageId: 6, file: "acerca.md", title: "Acerca de Telar" }],
};

describe("PageLanguageChoice", () => {
  it("names the page and both files, with neither version chosen", () => {
    render(<PageLanguageChoice groups={[GROUP]} choices={{}} onChoose={() => {}} />);
    expect(screen.getByText("language_choice.heading page=About")).toBeTruthy();
    expect(screen.getByText("language_choice.body files=about.md and acerca.md")).toBeTruthy();
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([["about.md", false], ["acerca.md", false]]);
  });

  it("says what keeping the other version does to the files, and nothing for the page's own", () => {
    render(<PageLanguageChoice groups={[GROUP]} choices={{}} onChoose={() => {}} />);
    expect(screen.getByText("language_choice.keep_other_note page=about.md file=acerca.md")).toBeTruthy();
    expect(screen.getAllByText(/language_choice\.keep_other_note/)).toHaveLength(1);
  });

  it("answers the kept file for the page, and shows the choice made", () => {
    const onChoose = vi.fn();
    const view = render(<PageLanguageChoice groups={[GROUP]} choices={{}} onChoose={onChoose} />);
    fireEvent.click(screen.getAllByRole("radio")[1]);
    expect(onChoose).toHaveBeenCalledWith("about.md", "acerca.md");
    view.rerender(<PageLanguageChoice groups={[GROUP]} choices={{ "about.md": "acerca.md" }} onChoose={onChoose} />);
    expect((screen.getAllByRole("radio") as HTMLInputElement[]).map((r) => r.checked)).toEqual([false, true]);
  });

  it("counts the versions of a page held in more than two languages", () => {
    const three = { ...GROUP, others: [...GROUP.others, { pageId: 7, file: "sobre.md", title: "Sobre" }] };
    render(<PageLanguageChoice groups={[three]} choices={{}} onChoose={() => {}} />);
    expect(screen.getByText("language_choice.heading_more page=About number=3")).toBeTruthy();
  });

  it("renders nothing with no such page", () => {
    const { container } = render(<PageLanguageChoice groups={[]} choices={{}} onChoose={() => {}} />);
    expect(container.innerHTML).toBe("");
  });
});
