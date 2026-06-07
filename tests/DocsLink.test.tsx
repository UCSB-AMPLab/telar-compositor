/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => (k === "learn_more" ? "Learn more" : k), i18n: { language: "en" } }),
}));

import { DocsLink } from "~/components/ui/DocsLink";

describe("DocsLink", () => {
  it("renders the default label and calls onOpenDoc with the docId on click", () => {
    const onOpenDoc = vi.fn();
    render(<DocsLink docId="objects" onOpenDoc={onOpenDoc} />);
    const btn = screen.getByRole("button", { name: /learn more/i });
    fireEvent.click(btn);
    expect(onOpenDoc).toHaveBeenCalledWith("objects");
  });

  it("uses an override aria-label when provided", () => {
    render(<DocsLink docId="stories" onOpenDoc={() => {}} ariaLabel="Learn more about stories" />);
    expect(screen.getByRole("button", { name: "Learn more about stories" })).toBeTruthy();
  });

  it("renders a custom visible label when given", () => {
    render(<DocsLink docId="pages" onOpenDoc={() => {}} label="Read the guide" />);
    expect(screen.getByText("Read the guide")).toBeTruthy();
  });
});
