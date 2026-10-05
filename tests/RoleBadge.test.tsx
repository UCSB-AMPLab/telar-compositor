// @vitest-environment jsdom

/**
 * This file pins the RoleBadge wrapper's flex-alignment contract — the
 * outer span must carry `shrink-0` for every variant so the badge keeps its
 * size next to a flex-stretching label — and the instructor variant's colour
 * and label key.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { RoleBadge } from "~/components/features/dashboard/RoleBadge";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("RoleBadge alignment", () => {
  it("RoleBadge wrapper span includes shrink-0 class for flex alignment", () => {
    const { container } = render(<RoleBadge role="collaborator" />);
    const span = container.querySelector("span.shrink-0");
    expect(span).not.toBeNull();
  });

  it("RoleBadge convenor variant also has shrink-0", () => {
    const { container } = render(<RoleBadge role="convenor" />);
    const span = container.querySelector("span.shrink-0");
    expect(span).not.toBeNull();
  });

  it("RoleBadge instructor variant also has shrink-0", () => {
    const { container } = render(<RoleBadge role="instructor" />);
    const span = container.querySelector("span.shrink-0");
    expect(span).not.toBeNull();
  });
});

describe("RoleBadge instructor variant", () => {
  it("renders the amber pill", () => {
    const { container } = render(<RoleBadge role="instructor" />);
    const span = container.querySelector("span");
    expect(span?.className).toContain("bg-amber-100");
    expect(span?.className).toContain("text-amber-800");
  });

  it("labels itself from the team namespace's instructor_label key", () => {
    const { container } = render(<RoleBadge role="instructor" />);
    expect(container.textContent).toBe("instructor_label");
  });
});
