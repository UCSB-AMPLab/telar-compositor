// @vitest-environment jsdom
/**
 * Pins the `OutOfSyncPopover` body. Asserts: the three diff chips
 * (+ added / ~ changed / – removed) with their diff tokens
 * (chilca / qolle / terracotta), counts from aggregateSyncDiff, a
 * `Review changes` anil-primary action, and a `Keep my version` ghost button
 * that submits the existing `accept-divergence` intent via a POST fetcher —
 * with no new backend intent and no db write introduced in the file.
 *
 * @version v1.4.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import type { FullSyncDiff } from "~/lib/sync.server";

// Capture fetcher.submit calls so we can assert the accept-divergence intent.
const submitSpy = vi.fn();
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => ({
      submit: submitSpy,
      state: "idle",
      data: undefined,
    }),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        "out_of_sync.title": "GitHub has changed",
        "out_of_sync.body":
          "Someone edited the repository directly. Review what changed before publishing.",
        "out_of_sync.diff_label": "What changed",
        "out_of_sync.added": "{{n}} added",
        "out_of_sync.changed": "{{n}} changed",
        "out_of_sync.removed": "{{n}} removed",
        "out_of_sync.keep_mine": "Keep my version",
        "out_of_sync.review": "Review changes",
      };
      let out = map[key] ?? key;
      if (opts) {
        for (const [k, v] of Object.entries(opts)) {
          out = out.replace(`{{${k}}}`, String(v));
        }
      }
      return out;
    },
  }),
}));

import { fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { OutOfSyncPopover } from "~/components/features/site-status/popovers/OutOfSyncPopover";

// FullSyncDiff fixture: 2 new objects, 1 changed story, 1 config field, 1 removed term.
// aggregateSyncDiff → { added: 2, changed: 2, removed: 1 }
const diff: FullSyncDiff = {
  objects: {
    newObjects: [
      { object_id: "o1" } as never,
      { object_id: "o2" } as never,
    ],
    changedObjects: [],
    missingObjects: [],
    unregisteredFiles: [],
  } as never,
  stories: {
    newStories: [],
    changedStories: [{ story_id: "s1" } as never],
    missingStories: [],
  } as never,
  config: { changedFields: [{ key: "title" } as never], versionChange: null } as never,
  glossary: {
    added: [],
    changed: [],
    removed: [{ term_id: "g1" } as never],
  } as never,
  hasConflicts: false,
  classification: "two-way",
  suppressedEditorOnly: 0,
};

function renderPopover(props: Parameters<typeof OutOfSyncPopover>[0]) {
  submitSpy.mockClear();
  return render(
    <MemoryRouter>
      <OutOfSyncPopover {...props} />
    </MemoryRouter>
  );
}

describe("OutOfSyncPopover", () => {
  it("renders the title and body", () => {
    const { container } = renderPopover({ diff });
    expect(container.textContent).toContain("GitHub has changed");
    expect(container.textContent).toContain("Someone edited the repository directly");
  });

  it("renders three diff chips with counts from aggregateSyncDiff", () => {
    const { container } = renderPopover({ diff });
    expect(container.textContent).toContain("2 added");
    expect(container.textContent).toContain("2 changed");
    expect(container.textContent).toContain("1 removed");
  });

  it("added chip uses chilca-pale / chilca-deep tokens", () => {
    const { container } = renderPopover({ diff });
    expect(container.querySelector(".bg-chilca-pale.text-chilca-deep")).not.toBeNull();
  });

  it("changed chip uses qolle-pale / qolle-deep tokens", () => {
    const { container } = renderPopover({ diff });
    expect(container.querySelector(".bg-qolle-pale.text-qolle-deep")).not.toBeNull();
  });

  it("removed chip uses terracotta-pale / terracotta tokens", () => {
    const { container } = renderPopover({ diff });
    expect(container.querySelector(".bg-terracotta-pale.text-terracotta")).not.toBeNull();
  });

  it("Review changes uses the anil primary token", () => {
    const { container } = renderPopover({ diff });
    const review = container.querySelector(".bg-anil");
    expect(review).not.toBeNull();
    expect(review?.textContent).toContain("Review changes");
  });

  it("Keep my version submits intent accept-divergence via a POST fetcher targeting /dashboard", () => {
    const { getByText } = renderPopover({ diff });
    fireEvent.click(getByText("Keep my version"));
    expect(submitSpy).toHaveBeenCalledTimes(1);
    const [body, opts] = submitSpy.mock.calls[0];
    expect(body).toEqual({ intent: "accept-divergence" });
    expect(opts).toMatchObject({ method: "post", action: "/dashboard" });
  });

  it("Review changes deep-links to the Objects-page sync flow by default", () => {
    const { container } = renderPopover({ diff });
    const review = container.querySelector("a.bg-anil");
    expect(review).not.toBeNull();
    expect(review?.getAttribute("href")).toBe("/objects?sync=1");
  });
});
