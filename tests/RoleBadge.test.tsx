// @vitest-environment jsdom

/**
 * This file pins the RoleBadge wrapper's flex-alignment contract — the
 * outer span must carry `shrink-0` for both convenor and collaborator
 * variants so the badge keeps its size next to a flex-stretching label.
 *
 * @version v1.0.0-beta
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
});
