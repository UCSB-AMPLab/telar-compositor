// @vitest-environment jsdom
/**
 * The manifest check broadcasts three outcomes and the row reports each: a
 * manifest that validates says "valid" rather than leaving the row unchanged.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

import { ManifestValidationNote } from "~/components/features/objects/ManifestValidationNote";

describe("ManifestValidationNote", () => {
  it.each([
    ["pending", "validation_pending"],
    ["valid", "validation_valid"],
    ["error", "validation_error"],
  ] as const)("reports %s", (state, key) => {
    const { container } = render(<ManifestValidationNote state={state} />);
    expect(container.textContent).toBe(key);
  });

  it("says nothing for a row that has not been checked", () => {
    const { container } = render(<ManifestValidationNote state={null} />);
    expect(container.textContent).toBe("");
  });
});
