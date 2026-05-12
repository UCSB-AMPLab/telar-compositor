// @vitest-environment jsdom
/**
 * This file pins the RTL contract for the `OrphanStoryBanner` component —
 * the dashboard banner that surfaces stories whose owning page has been
 * deleted and offers a restore-as-drafts or ignore action.
 *
 * Five tests covering the component contract:
 *  1. Returns null when orphanStoryIds is empty.
 *  2. Renders count text when orphanStoryIds has 1 entry — count
 *     interpolation works.
 *  3. Renders count text when orphanStoryIds has 3 entries —
 *     pluralisation interpolation works.
 *  4. Clicking Restore-as-drafts CTA submits a fetcher with
 *     intent=restore-orphan-drafts.
 *  5. Clicking Ignore CTA submits a fetcher with intent=ignore-orphans.
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

// i18n mock — return the key plus a `[opt=val]` suffix for any options
// passed (e.g. `{{count}}`). Lets tests assert against the key AND
// confirm interpolation values reached t() without depending on real
// EN/ES copy.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && typeof opts === "object" && Object.keys(opts).length > 0) {
        const suffix = Object.entries(opts)
          .map(([k, v]) => `[${k}=${String(v)}]`)
          .join("");
        return `${key}${suffix}`;
      }
      return key;
    },
    i18n: { language: "en" },
  }),
}));

// Controllable fetcher mock. The banner mounts one useFetcher and submits
// the active CTA's intent through it. Reset state/data per test via
// `currentFetcher`.
type FakeFetcher = {
  state: "idle" | "submitting" | "loading";
  data: unknown;
  submit: ReturnType<typeof vi.fn>;
  Form: React.ComponentType<React.FormHTMLAttributes<HTMLFormElement>>;
};

let currentFetcher: FakeFetcher;

function makeFetcher(): FakeFetcher {
  return {
    state: "idle",
    data: undefined,
    submit: vi.fn(),
    Form: (props) => <form {...props} />,
  };
}

vi.mock("react-router", () => ({
  useFetcher: () => currentFetcher,
}));

import OrphanStoryBanner from "~/components/features/dashboard/OrphanStoryBanner";

beforeEach(() => {
  currentFetcher = makeFetcher();
});

describe("OrphanStoryBanner", () => {
  it("returns null when orphanStoryIds is empty", () => {
    const { container } = render(<OrphanStoryBanner orphanStoryIds={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders count text with count=1 when orphanStoryIds has 1 entry", () => {
    render(<OrphanStoryBanner orphanStoryIds={["story-a"]} />);
    // Mock's [opt=val] suffix confirms the count option reached t().
    expect(
      screen.getByText("orphan_banner.count_text[count=1]"),
    ).toBeTruthy();
  });

  it("renders count text with count=3 when orphanStoryIds has 3 entries", () => {
    render(
      <OrphanStoryBanner
        orphanStoryIds={["story-a", "story-b", "story-c"]}
      />,
    );
    expect(
      screen.getByText("orphan_banner.count_text[count=3]"),
    ).toBeTruthy();
  });

  it("clicking Restore-as-drafts CTA submits the fetcher with intent=restore-orphan-drafts", () => {
    render(<OrphanStoryBanner orphanStoryIds={["story-a", "story-b"]} />);
    const restoreBtn = screen.getByRole("button", {
      name: "orphan_banner.primary_cta",
    });
    fireEvent.click(restoreBtn);
    expect(currentFetcher.submit).toHaveBeenCalledTimes(1);
    const [payload, options] = currentFetcher.submit.mock.calls[0];
    expect(payload).toMatchObject({ intent: "restore-orphan-drafts" });
    expect(options).toMatchObject({ method: "post" });
  });

  it("clicking Ignore CTA submits the fetcher with intent=ignore-orphans", () => {
    render(<OrphanStoryBanner orphanStoryIds={["story-a"]} />);
    const ignoreBtn = screen.getByRole("button", {
      name: "orphan_banner.secondary_cta",
    });
    fireEvent.click(ignoreBtn);
    expect(currentFetcher.submit).toHaveBeenCalledTimes(1);
    const [payload, options] = currentFetcher.submit.mock.calls[0];
    expect(payload).toMatchObject({ intent: "ignore-orphans" });
    expect(options).toMatchObject({ method: "post" });
  });
});
