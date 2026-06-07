// @vitest-environment jsdom
/**
 * The rewritten Publish page's "What we checked" section renders a chilca-pale
 * numbered list of the checks that PASSED (the canonical passed-check label set
 * minus any failing codes — runPrePublishValidation only emits FAILURES, so
 * passed labels are derived from a static set minus the failures), alongside
 * the reworded `page_no_title` blocker that no longer interpolates an empty slug.
 *
 * The passed-check ↔ failing-code mapping lives in ValidationChecks: only
 * `object_metadata` is suppressed by a validation code (`object_no_title`);
 * the other four canonical checks have no code yet and always pass.
 *
 * i18n is mocked as a key-passthrough so assertions key off the translation
 * keys, not the copy. MemoryRouter wraps the render because the stale_head
 * blocker renders a <Link>.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      // Key-passthrough; interpolate {{params}} so we can assert no empty slug.
      if (opts && Object.keys(opts).length > 0) {
        let out = key;
        for (const [k, v] of Object.entries(opts)) {
          out = out.replace(`{{${k}}}`, String(v));
        }
        return out;
      }
      return key;
    },
  }),
}));

import { ValidationChecks } from "~/components/features/publish/ValidationChecks";

const CANONICAL_KEYS = [
  "passed_checks.object_metadata",
  "passed_checks.term_links",
  "passed_checks.iiif_tiles",
  "passed_checks.site_url",
  "passed_checks.telar_version",
];

function renderChecks(validation: Parameters<typeof ValidationChecks>[0]["validation"]) {
  return render(
    <MemoryRouter>
      <ValidationChecks validation={validation} />
    </MemoryRouter>,
  );
}

describe("'What we checked' passed-checks numbered list", () => {
  it("renders the canonical passed-check labels as a numbered list when nothing fails", () => {
    renderChecks({ blockers: [], warnings: [] });
    for (const key of CANONICAL_KEYS) {
      expect(screen.getByText(key)).toBeTruthy();
    }
    // Numbered list: an <ol> wraps the passed checks, one <li> per check.
    const items = document.querySelectorAll("ol li");
    expect(items.length).toBe(CANONICAL_KEYS.length);
  });

  it("omits a check whose failing code appears in validation (passed = canonical set minus failures)", () => {
    // object_no_title warning suppresses the object_metadata passed-check.
    renderChecks({
      blockers: [],
      warnings: [{ code: "object_no_title", message: "object_no_title", entityId: "obj-1", params: { id: "obj-1" } }],
    });
    expect(screen.queryByText("passed_checks.object_metadata")).toBeNull();
    // The other four canonical checks (no validation code) still pass.
    expect(screen.getByText("passed_checks.term_links")).toBeTruthy();
    expect(screen.getByText("passed_checks.iiif_tiles")).toBeTruthy();
    expect(screen.getByText("passed_checks.site_url")).toBeTruthy();
    expect(screen.getByText("passed_checks.telar_version")).toBeTruthy();
    // And the warning itself renders.
    expect(screen.getByText("checks.object_no_title")).toBeTruthy();
  });
});

describe("reworded page_no_title blocker renders without an empty quote", () => {
  it("renders the recovery-oriented page_no_title copy and contains no empty 'Page \"\"' quote", () => {
    renderChecks({
      blockers: [{ code: "page_no_title", message: "page_no_title", entityId: "untitled-1" }],
      warnings: [],
    });
    // The reworded blocker is keyed by `checks.page_no_title` and takes no
    // params — so no slug is interpolated and no empty `Page ""` is rendered.
    expect(screen.getByText("checks.page_no_title")).toBeTruthy();
    expect(document.body.textContent).not.toContain('Page ""');
    expect(document.body.textContent).not.toContain("{{slug}}");
  });
});
