// @vitest-environment jsdom

/**
 * WelcomeStrip — role chip and meta-line gating (solo-project fix).
 *
 * A solo owner (collaboratorCount=0) must NOT see the "Convenor" role chip,
 * and must see a simple "created {{year}}" line instead of the full
 * "convened by …" line. With collaborators present (collaboratorCount>0) both
 * the chip and the full convened-by line must appear.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { WelcomeStrip } from "../app/components/features/start/WelcomeStrip";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      // Return "key:param=value" form so assertions can inspect interpolations.
      if (params && Object.keys(params).length) {
        const pairs = Object.entries(params)
          .map(([k, v]) => `${k}=${v}`)
          .join(",");
        return `${key}:${pairs}`;
      }
      return key;
    },
    i18n: { language: "en" },
  }),
}));

const BASE_PROPS = {
  projectName: "My Project",
  summary: "A test summary.",
  role: "convenor" as const,
  convenorName: "Alice",
  createdYear: 2024,
  state: "populated" as const,
};

describe("WelcomeStrip — solo project (collaboratorCount=0)", () => {
  it("does not render the role chip", () => {
    const { container } = render(
      <WelcomeStrip {...BASE_PROPS} collaboratorCount={0} />,
    );
    // The role chip label is "role_chip.convenor"; it must not appear.
    expect(container.textContent).not.toContain("role_chip.convenor");
    expect(container.textContent).not.toContain("role_chip.collaborator");
  });

  it("shows the created_year meta line (not the convened_by line)", () => {
    const { container } = render(
      <WelcomeStrip {...BASE_PROPS} collaboratorCount={0} />,
    );
    // created_year key with year param must be present.
    expect(container.textContent).toContain("welcome.created_year");
    expect(container.textContent).toContain("year=2024");
    // convened_by must NOT appear.
    expect(container.textContent).not.toContain("welcome.convened_by");
  });
});

describe("WelcomeStrip — shared project (collaboratorCount=2)", () => {
  it("renders the role chip", () => {
    const { container } = render(
      <WelcomeStrip {...BASE_PROPS} collaboratorCount={2} />,
    );
    expect(container.textContent).toContain("role_chip.convenor");
  });

  it("shows the full convened_by meta line (not created_year)", () => {
    const { container } = render(
      <WelcomeStrip {...BASE_PROPS} collaboratorCount={2} />,
    );
    expect(container.textContent).toContain("welcome.convened_by");
    expect(container.textContent).toContain("count=2");
    expect(container.textContent).toContain("convenor=Alice");
    expect(container.textContent).not.toContain("welcome.created_year");
  });
});
