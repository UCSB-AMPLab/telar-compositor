// @vitest-environment jsdom
/**
 * Pins the address `SlugField` shows under a page: the one the site serves
 * (Jekyll's `:name` of the file name), which differs from the slug when the page
 * was imported from a file name that is not a slug.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SlugField } from "~/components/ui/SlugField";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("SlugField address", () => {
  it("shows the served address of Credits", () => {
    render(<SlugField slug="Credits" existingSlugs={new Set()} onSlugChange={() => {}} />);
    expect(screen.getByText("/credits/")).toBeTruthy();
    expect(screen.queryByText("/Credits/")).toBeNull();
  });

  it("shows an underscore file name as its hyphenated address", () => {
    render(<SlugField slug="credits_two" existingSlugs={new Set()} onSlugChange={() => {}} />);
    expect(screen.getByText("/credits-two/")).toBeTruthy();
  });
});
