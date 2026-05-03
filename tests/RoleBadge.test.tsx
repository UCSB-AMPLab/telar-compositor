// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { RoleBadge } from "~/components/features/dashboard/RoleBadge";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("SC-4: RoleBadge alignment", () => {
  it("SC-4: RoleBadge wrapper span includes shrink-0 class for flex alignment", () => {
    const { container } = render(<RoleBadge role="collaborator" />);
    const span = container.querySelector("span.shrink-0");
    expect(span).not.toBeNull();
  });

  it("SC-4: RoleBadge convenor variant also has shrink-0", () => {
    const { container } = render(<RoleBadge role="convenor" />);
    const span = container.querySelector("span.shrink-0");
    expect(span).not.toBeNull();
  });
});
