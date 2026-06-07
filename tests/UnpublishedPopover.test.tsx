// @vitest-environment jsdom
/**
 * Pins the `UnpublishedPopover` body — the change manifest grouped by content
 * type. Asserts: one section per non-empty content type (empty ones omitted),
 * per-type section-icon tints (stories anil-ink, objects chilca, glossary
 * caracol), item titles + modified/added tags, the `Review all changes →`
 * linky, and a terracotta `Publish` action that NAVIGATES to /publish (not a
 * one-click commit). The displayed count derives from the SAME ChangeSummary
 * (single source of truth).
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { UnpublishedPopover } from "~/components/features/site-status/popovers/UnpublishedPopover";
import type { ChangeSummary } from "~/lib/publish.server";

// The popover gates its footer on useIsConvenor(). These pins cover the
// convenor path (Publish CTA + review link); the collaborator path is asserted
// in tests/role-gating.test.tsx. Default to convenor here.
vi.mock("~/hooks/use-role", () => ({
  useIsConvenor: () => true,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        "unpublished.title_one": "1 unpublished change",
        "unpublished.title_other": "{{n}} unpublished changes",
        "unpublished.since": "Since last published, {{time}}",
        "unpublished.section.stories": "Stories",
        "unpublished.section.objects": "Objects",
        "unpublished.section.glossary": "Glossary",
        "unpublished.section.pages": "Pages",
        "unpublished.section.settings": "Site settings",
        "unpublished.modified": "modified",
        "unpublished.added": "added",
        "unpublished.review": "Review all changes",
        "unpublished.publish": "Publish",
      };
      let out = map[key] ?? key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          out = out.replace(`{{${k}}}`, String(v));
        }
      }
      return out;
    },
    i18n: { language: "en" },
  }),
}));

function emptyBucket() {
  return { new: [], modified: [], deleted: [] };
}

// A ChangeSummary with only stories + objects populated (the other types empty),
// to prove empty sections are omitted.
const summary: ChangeSummary = {
  isUpToDate: false,
  backCompatBootstrap: false,
  stories: {
    new: [{ story_id: "s1", title: "The First Story" }],
    modified: [{ story_id: "s2", title: "Second Story" }],
    deleted: [],
  },
  objects: {
    new: [{ object_id: "o1", title: "A Painting" }],
    modified: [],
    deleted: [],
  },
  pages: emptyBucket(),
  glossary: emptyBucket(),
  settings: { changed: [] },
  landing: { changed: false },
  navigation: { changed: false },
  fileChanges: { addedStoryFiles: [], removedStoryFiles: [] },
};

function renderPopover(props: Parameters<typeof UnpublishedPopover>[0]) {
  return render(
    <MemoryRouter>
      <UnpublishedPopover {...props} />
    </MemoryRouter>
  );
}

describe("UnpublishedPopover", () => {
  it("renders the pluralised title from the ChangeSummary total", () => {
    const { container } = renderPopover({ summary });
    // 2 stories + 1 object = 3 changes
    expect(container.textContent).toContain("3 unpublished changes");
  });

  it("renders one section per non-empty content type and omits empty ones", () => {
    const { container } = renderPopover({ summary });
    expect(container.textContent).toContain("Stories");
    expect(container.textContent).toContain("Objects");
    // empty types omitted
    expect(container.textContent).not.toContain("Glossary");
    expect(container.textContent).not.toContain("Pages");
    expect(container.textContent).not.toContain("Site settings");
  });

  it("renders item titles for the populated sections", () => {
    const { container } = renderPopover({ summary });
    expect(container.textContent).toContain("The First Story");
    expect(container.textContent).toContain("Second Story");
    expect(container.textContent).toContain("A Painting");
  });

  it("renders modified / added tags", () => {
    const { container } = renderPopover({ summary });
    expect(container.textContent).toContain("modified");
    expect(container.textContent).toContain("added");
  });

  it("stories section icon takes the anil-ink tint", () => {
    const { container } = renderPopover({ summary });
    expect(container.querySelector(".text-anil-ink")).not.toBeNull();
  });

  it("objects section icon takes a chilca tint", () => {
    const { container } = renderPopover({ summary });
    const chilca =
      container.querySelector(".text-chilca") ?? container.querySelector(".bg-chilca");
    expect(chilca).not.toBeNull();
  });

  it("glossary section icon takes the caracol tint when glossary changes exist", () => {
    const withGlossary: ChangeSummary = {
      ...summary,
      glossary: { new: [{ term_id: "g1", title: "Term" }], modified: [], deleted: [] },
    };
    const { container } = renderPopover({ summary: withGlossary });
    const caracol = container.querySelector('[class*="caracol"]');
    expect(caracol).not.toBeNull();
  });

  it("renders a 'Review all changes →' linky", () => {
    renderPopover({ summary });
    expect(screen.getByText(/Review all changes/)).toBeTruthy();
  });

  it("Publish action navigates to /publish (a Link, not a one-click intent submit)", () => {
    const { container } = renderPopover({ summary });
    // The terracotta CTA is the Publish action — both it and the Review linky
    // route to /publish, so disambiguate by the CTA's bg-terracotta token.
    const publishLinks = Array.from(
      container.querySelectorAll('a[href="/publish"]')
    ) as HTMLAnchorElement[];
    expect(publishLinks.length).toBeGreaterThan(0);
    const publishCta = publishLinks.find((a) => a.className.includes("bg-terracotta"));
    expect(publishCta).toBeTruthy();
    expect(publishCta?.textContent).toContain("Publish");
    // it is a Link (anchor), not a button/submit
    expect(publishCta?.tagName).toBe("A");
  });

  it("does not hardcode a hex colour", () => {
    const { container } = renderPopover({ summary });
    expect(/#[0-9A-Fa-f]{6}/.test(container.innerHTML)).toBe(false);
  });
});
