// @vitest-environment jsdom
/**
 * Pins the hydration-safety contract of `useRelativeTime`: the value it emits
 * during SSR / first client paint must be a stable, locale- and
 * timezone-independent placeholder (never a formatted date), so the server
 * HTML and the first client render are byte-identical and React #418 cannot
 * fire. The localized relative phrase only appears after mount.
 */
import { describe, it, expect, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { renderHook } from "@testing-library/react";
import { useRelativeTime } from "~/lib/use-relative-time";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "en" } }),
}));

function Probe({ iso, never }: { iso: string | null; never?: string }) {
  return <>{useRelativeTime(iso, never)}</>;
}

describe("useRelativeTime", () => {
  it("emits nothing for a present timestamp during SSR (no date leaks into hydration)", () => {
    // renderToString does not run effects, so the hook is in its pre-mount
    // state — exactly what the server renders and the client first paints.
    const oldIso = "2026-03-01T02:00:00Z";
    expect(renderToString(<Probe iso={oldIso} />)).toBe("");
  });

  it("emits the neverLabel for an absent timestamp during SSR (stable, no mount needed)", () => {
    expect(renderToString(<Probe iso={null} never="Never" />)).toBe("Never");
  });

  it("returns the neverLabel for an absent timestamp after mount", () => {
    const { result } = renderHook(() => useRelativeTime(null, "Never"));
    expect(result.current).toBe("Never");
  });

  it("returns the localized relative phrase after mount", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const { result } = renderHook(() => useRelativeTime(fiveMinAgo));
    expect(result.current).toBe("5 minutes ago");
  });
});
