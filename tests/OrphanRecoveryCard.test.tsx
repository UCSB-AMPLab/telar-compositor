// @vitest-environment jsdom

/**
 * This file pins the RTL contract for the OrphanRecoveryCard component — the
 * Atelier-styled recovery card for stories left on GitHub but absent from
 * project.csv.
 *
 * Covered behaviour:
 *   - Renders only when orphanStoryCount is above zero (don't-render gate); the
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

// i18n mock — mirrors i18next's own pluralisation: a `count` option selects
// `${key}_one` (count === 1) or `${key}_other` (otherwise) and appends the
// `[opt=val]` suffix for every option so tests can also confirm interpolation
// values reached t().
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const hasOpts = opts && typeof opts === "object" && Object.keys(opts).length > 0;
      const resolvedKey =
        hasOpts && "count" in (opts as Record<string, unknown>)
          ? `${key}_${(opts as Record<string, unknown>).count === 1 ? "one" : "other"}`
          : key;
      if (hasOpts) {
        const suffix = Object.entries(opts as Record<string, unknown>)
          .map(([k, v]) => `[${k}=${String(v)}]`)
          .join("");
        return `${resolvedKey}${suffix}`;
      }
      return resolvedKey;
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
/** The options each useFetcher call was given. */
let fetcherOptions: unknown[] = [];

function makeFetcher(): FakeFetcher {
  return {
    state: "idle",
    data: undefined,
    submit: vi.fn(),
    Form: (props) => <form {...props} />,
  };
}

vi.mock("react-router", () => ({
  useFetcher: (opts?: unknown) => {
    fetcherOptions.push(opts);
    return currentFetcher;
  },
}));

import { OrphanRecoveryCard, ORPHAN_RECOVERY_FETCHER_KEY } from "~/components/features/start/OrphanRecoveryCard";

beforeEach(() => {
  currentFetcher = makeFetcher();
  fetcherOptions = [];
});

describe("OrphanRecoveryCard — convenor+populated gating", () => {
  it("returns null when orphanStoryCount is zero (don't-render gate)", () => {
    const { container } = render(<OrphanRecoveryCard orphanStoryCount={0} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the card (eyebrow + body with count) when orphans exist", () => {
    render(<OrphanRecoveryCard orphanStoryCount={2} />);
    expect(screen.getByText("recovery.eyebrow")).toBeTruthy();
    // Body interpolates the count via the t() option suffix.
    expect(screen.getByText("recovery.body_other[count=2]")).toBeTruthy();
  });

  it("uses the singular body key and passes count (not N) for exactly one orphan", () => {
    render(<OrphanRecoveryCard orphanStoryCount={1} />);
    expect(screen.getByText("recovery.body_one[count=1]")).toBeTruthy();
  });

  it("'Restore as drafts' submits intent=restore-orphan-drafts to action /dashboard", () => {
    render(<OrphanRecoveryCard orphanStoryCount={2} />);
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
    render(<OrphanRecoveryCard orphanStoryCount={1} />);
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
      <OrphanRecoveryCard orphanStoryCount={3} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "recovery.primary_cta" }));
    fireEvent.click(screen.getByRole("button", { name: "recovery.ignore_aria" }));
    for (const [payload] of currentFetcher.submit.mock.calls) {
      const keys = Object.keys(payload as Record<string, unknown>);
      // Only the intent key is allowed — no orphan ids smuggled in.
      expect(keys).toEqual(["intent"]);
    }
  });

  // The page, not the card, shows the answer, since a restore that recovers
  // every orphan unmounts the card; so both submit through the fetcher key the
  // page reads.
  it("submits through the keyed fetcher the Start page reads", () => {
    render(<OrphanRecoveryCard orphanStoryCount={1} />);
    expect(fetcherOptions).toEqual([{ key: ORPHAN_RECOVERY_FETCHER_KEY }]);
  });

  it("gives the single-word Ignore action a non-empty accessible name", () => {
    render(<OrphanRecoveryCard orphanStoryCount={1} />);
    const ignoreBtn = screen.getByRole("button", {
      name: "recovery.ignore_aria",
    });
    // The accessible name is the dedicated aria key, not the bare visible word.
    expect(ignoreBtn.getAttribute("aria-label")).toBe("recovery.ignore_aria");
  });
});
