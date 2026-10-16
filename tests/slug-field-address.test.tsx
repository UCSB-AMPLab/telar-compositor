// @vitest-environment jsdom
/**
 * A page's address under its title: it is shown as the address the site
 * serves (Jekyll's `:name` of the file name, which differs from the slug when
 * the page was imported from a file name that is not a slug) with a Change address
 * button always visible; the editor takes only the characters a page address
 * holds; an address another page serves is refused with that page's title; an
 * accepted one first warns that links to the old address stop working and
 * changes nothing until the author confirms.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, fireEvent } from "@testing-library/react";
import { SlugField } from "~/components/ui/SlugField";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => `${key}|${JSON.stringify(options ?? {})}`,
  }),
}));

const OTHERS = [
  { slug: "about", title: "About us" },
  { slug: "team_page", title: "" },
];

function setUp(slug = "credits", canChange = true) {
  const onSlugChange = vi.fn();
  render(<SlugField slug={slug} otherPages={OTHERS} canChange={canChange} onSlugChange={onSlugChange} />);
  return { onSlugChange };
}

function typeAddress(value: string): HTMLInputElement {
  fireEvent.click(screen.getByRole("button", { name: /^slug_change_address/ }));
  const input = screen.getByRole("textbox") as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  return input;
}

describe("SlugField address", () => {
  it("shows the served address of Credits", () => {
    setUp("Credits");
    expect(screen.getByText(/slug_address\|\{"address":"credits"\}/)).toBeTruthy();
  });

  it("shows an underscore file name as its hyphenated address", () => {
    setUp("credits_two");
    expect(screen.getByText(/slug_address\|\{"address":"credits-two"\}/)).toBeTruthy();
  });
});

describe("SlugField change", () => {
  it("shows the Change address button at rest", () => {
    setUp();
    expect(screen.getByRole("button", { name: /^slug_change_address/ })).toBeTruthy();
  });

  it("shows no button to someone who may not change the address", () => {
    setUp("credits", false);
    expect(screen.queryByRole("button", { name: /^slug_change_address/ })).toBeNull();
  });

  it("drops characters a page address cannot hold, strips accents and turns a space into a hyphen", () => {
    setUp();
    expect(typeAddress("Año Nuevo!_x/y").value).toBe("ano-nuevoxy");
  });

  it("refuses an address another page serves, naming that page", () => {
    const { onSlugChange } = setUp();
    typeAddress("about");
    expect(screen.getByRole("alert").textContent).toContain('"title":"About us"');
    expect(screen.queryByRole("group")).toBeNull();
    expect(onSlugChange).not.toHaveBeenCalled();
  });

  it("refuses an address another page serves under a different file name, naming it as untitled", () => {
    setUp();
    typeAddress("team-page");
    expect(screen.getByRole("alert").textContent).toContain("untitled");
  });

  it("refuses an address with no letter or number", () => {
    setUp();
    typeAddress("---");
    expect(screen.getByRole("alert").textContent).toContain("slug_invalid");
  });

  it("warns that old links stop working, and changes the address only on confirm", () => {
    const { onSlugChange } = setUp();
    typeAddress("credits-and-thanks");
    expect(screen.getByRole("group").textContent).toContain('"old":"credits","new":"credits-and-thanks"');
    expect(onSlugChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: /^slug_change_address/ })[0]);
    expect(onSlugChange).toHaveBeenCalledWith("credits-and-thanks");
  });

  it("settles hyphens at either end before applying", () => {
    const { onSlugChange } = setUp();
    typeAddress("-thanks-");
    fireEvent.click(screen.getAllByRole("button", { name: /^slug_change_address/ })[0]);
    expect(onSlugChange).toHaveBeenCalledWith("thanks");
  });
});

describe("SlugField reserved addresses", () => {
  it.each(["stories", "objects", "glossary", "assets", "iiif", "telar-content", "Objects"])(
    "refuses %s, which the built site already serves",
    (address) => {
      const { onSlugChange } = setUp();
      typeAddress(address);
      expect(screen.getByRole("alert").textContent).toContain("slug_reserved");
      expect(onSlugChange).not.toHaveBeenCalled();
    },
  );

  it("takes an address that only starts with a reserved one", () => {
    setUp();
    typeAddress("objects-team");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("an imported slug that serves the same address", () => {
  it("says the address does not change, with no broken-link warning", () => {
    setUp("Credits");
    typeAddress("credits");
    const note = screen.getByRole("group").textContent ?? "";
    expect(note).toContain('slug_same_address|{"address":"credits"}');
    expect(note).not.toContain("slug_warning");
  });
});

describe("the Pages route", () => {
  const route = readFileSync(join(__dirname, "../app/routes/_app.pages.tsx"), "utf8");

  it("gates the address on editing a page, as the title and body are, not on deleting it", () => {
    expect(route).toMatch(/<SlugField[^>]*canChange=\{useYjs\}/s);
    expect(route).not.toMatch(/<SlugField[^>]*canDeletePage/s);
  });

  it("takes a new page's address from its title through the reserved-address rule", () => {
    expect(route).toContain("freePageSlug(normaliseSlug(currentTitle)");
  });
});
