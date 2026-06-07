// @vitest-environment jsdom

/**
 * This file pins the RTL contract for the OrphanRecoveryCard component — the
 * Atelier-styled recovery card for stories left on GitHub but absent from
 * project.csv.
 *
 * Covered behaviour:
 *   - Renders only when orphanStoryIds is non-empty (don't-render gate); the
 *     card is convenor + populated only — the page never mounts it for
 *     collaborators or in the empty state, and it returns null on empty input.
 *   - "Restore as drafts" submits a fetcher with intent=restore-orphan-drafts
 *     to action "/dashboard" (the card lives on /start; the action lives on
 *     the /dashboard resource route — server recomputes IDs, none in payload).
 *   - "Ignore" submits a fetcher with intent=ignore-orphans to "/dashboard".
 *   - Neither submit carries any orphan IDs (server recomputes).
 *   - The single-word "Ignore" action has a non-empty accessible name.
 *
 * Mirrors tests/OrphanStoryBanner.test.tsx (the analog).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

// i18n mock — return the key plus a `[opt=val]` suffix for any options so
// tests can assert against the key AND confirm interpolation reached t().
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

// Controllable fetcher mock — the card mounts one useFetcher and submits the
// active CTA's intent through it.
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

import { OrphanRecoveryCard } from "~/components/features/start/OrphanRecoveryCard";

beforeEach(() => {
  currentFetcher = makeFetcher();
});

describe("OrphanRecoveryCard — convenor+populated gating", () => {
  it("returns null when orphanStoryIds is empty (don't-render gate)", () => {
    const { container } = render(<OrphanRecoveryCard orphanStoryIds={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the card (eyebrow + body with count) when orphans exist", () => {
    render(<OrphanRecoveryCard orphanStoryIds={["story-a", "story-b"]} />);
    expect(screen.getByText("recovery.eyebrow")).toBeTruthy();
    // Body interpolates the count via the t() option suffix.
    expect(screen.getByText("recovery.body[N=2]")).toBeTruthy();
  });

  it("'Restore as drafts' submits intent=restore-orphan-drafts to action /dashboard", () => {
    render(<OrphanRecoveryCard orphanStoryIds={["story-a", "story-b"]} />);
    const restoreBtn = screen.getByRole("button", {
      name: "recovery.primary_cta",
    });
    fireEvent.click(restoreBtn);
    expect(currentFetcher.submit).toHaveBeenCalledTimes(1);
    const [payload, options] = currentFetcher.submit.mock.calls[0];
    expect(payload).toMatchObject({ intent: "restore-orphan-drafts" });
    expect(options).toMatchObject({ method: "post", action: "/dashboard" });
  });

  it("'Ignore' submits intent=ignore-orphans to action /dashboard", () => {
    render(<OrphanRecoveryCard orphanStoryIds={["story-a"]} />);
    const ignoreBtn = screen.getByRole("button", {
      name: "recovery.ignore_aria",
    });
    fireEvent.click(ignoreBtn);
    expect(currentFetcher.submit).toHaveBeenCalledTimes(1);
    const [payload, options] = currentFetcher.submit.mock.calls[0];
    expect(payload).toMatchObject({ intent: "ignore-orphans" });
    expect(options).toMatchObject({ method: "post", action: "/dashboard" });
  });

  it("sends no orphan IDs in either payload (server recomputes)", () => {
    render(
      <OrphanRecoveryCard orphanStoryIds={["story-a", "story-b", "story-c"]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "recovery.primary_cta" }));
    fireEvent.click(screen.getByRole("button", { name: "recovery.ignore_aria" }));
    for (const [payload] of currentFetcher.submit.mock.calls) {
      const keys = Object.keys(payload as Record<string, unknown>);
      // Only the intent key is allowed — no orphan ids smuggled in.
      expect(keys).toEqual(["intent"]);
    }
  });

  it("gives the single-word Ignore action a non-empty accessible name", () => {
    render(<OrphanRecoveryCard orphanStoryIds={["story-a"]} />);
    const ignoreBtn = screen.getByRole("button", {
      name: "recovery.ignore_aria",
    });
    // The accessible name is the dedicated aria key, not the bare visible word.
    expect(ignoreBtn.getAttribute("aria-label")).toBe("recovery.ignore_aria");
  });
});
