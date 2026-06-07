// @vitest-environment jsdom
/**
 * Pins the `InSyncPopover` body — the affirmative "nothing to do" state of the
 * Site Status pill. Asserts the three locked rows (last-published,
 * commit, synced-from-repo), the ok icon swatch tokens, the `View published
 * site` ghost button, and graceful fail-open when the commit message is absent.
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { InSyncPopover } from "~/components/features/site-status/popovers/InSyncPopover";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        "in_sync.title": "Everything is in sync",
        "in_sync.published": "Last published {{time}}",
        "in_sync.commit": "commit {{sha}} — {{msg}}",
        "in_sync.synced": "Synced from repo {{time}}",
        "in_sync.view_site": "View published site",
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

const fullPayload = {
  last_published_at: "2026-05-20T10:00:00Z",
  head_sha: "abc1234def5678",
  last_synced_at: "2026-05-20T10:05:00Z",
  commitMessage: "Publish stories",
};

function renderPopover(props: Parameters<typeof InSyncPopover>[0]) {
  return render(
    <MemoryRouter>
      <InSyncPopover {...props} />
    </MemoryRouter>
  );
}

describe("InSyncPopover", () => {
  it("renders the title", () => {
    renderPopover({ payload: fullPayload, pagesUrl: "https://example.org" });
    expect(screen.getByText("Everything is in sync")).toBeTruthy();
  });

  it("renders three rows: last published, commit, synced from repo", () => {
    const { container } = renderPopover({
      payload: fullPayload,
      pagesUrl: "https://example.org",
    });
    expect(container.textContent).toContain("Last published");
    expect(container.textContent).toContain("commit");
    expect(container.textContent).toContain("Synced from repo");
  });

  it("renders the short commit sha and message", () => {
    const { container } = renderPopover({
      payload: fullPayload,
      pagesUrl: "https://example.org",
    });
    // sha is truncated to 7 chars for display
    expect(container.textContent).toContain("abc1234");
    expect(container.textContent).toContain("Publish stories");
  });

  it("ok icon swatch uses chilca-pale / chilca-deep tokens", () => {
    const { container } = renderPopover({
      payload: fullPayload,
      pagesUrl: "https://example.org",
    });
    const okSwatch = container.querySelector(".bg-chilca-pale.text-chilca-deep");
    expect(okSwatch).not.toBeNull();
  });

  it("renders a 'View published site' ghost button linking to pagesUrl", () => {
    const { container } = renderPopover({
      payload: fullPayload,
      pagesUrl: "https://example.org/site",
    });
    const link = container.querySelector('a[href="https://example.org/site"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain("View published site");
    // ghost styling token
    expect(link?.className).toContain("bg-surface");
  });

  it("fail-open: renders the timestamp rows without crashing when commit message is absent", () => {
    const { container } = renderPopover({
      payload: { ...fullPayload, commitMessage: null },
      pagesUrl: "https://example.org",
    });
    // still shows the timestamp rows
    expect(container.textContent).toContain("Last published");
    expect(container.textContent).toContain("Synced from repo");
  });

  it("does not hardcode a hex colour", () => {
    const { container } = renderPopover({
      payload: fullPayload,
      pagesUrl: "https://example.org",
    });
    expect(/#[0-9A-Fa-f]{6}/.test(container.innerHTML)).toBe(false);
  });
});
