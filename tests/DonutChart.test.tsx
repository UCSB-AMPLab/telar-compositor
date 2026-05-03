// @vitest-environment jsdom
// Donut chart visualisation
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "fs";
import { resolve } from "path";

// Mock react-i18next
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts?.total !== undefined) return `chart:${opts.total}`;
      return key;
    },
  }),
}));

import { DonutChart } from "~/components/features/collaboration/DonutChart";
import type { DonutMember } from "~/components/features/collaboration/DonutChart";

const BASE_MEMBERS: DonutMember[] = [
  { userId: 1, name: "alice", color: "#8B5E3C", count: 600, isConvenor: true },
  { userId: 2, name: "bob", color: "#4A7C9E", count: 399, isConvenor: false },
  { userId: 3, name: "tiny", color: "#6B8E23", count: 1, isConvenor: false },
];

describe("DonutChart", () => {
  it("SC-8: renders one SVG circle slice per member (+1 for background track)", () => {
    const { container } = render(<DonutChart members={BASE_MEMBERS} />);
    const circles = container.querySelectorAll("circle");
    // +1 for the background track circle
    expect(circles.length).toBe(BASE_MEMBERS.length + 1);
  });

  it("SC-8: slice colour matches member.color (PRESENCE_PALETTE)", () => {
    const { container } = render(<DonutChart members={BASE_MEMBERS} />);
    const circles = container.querySelectorAll("circle");
    // Skip the first circle (background track); check the remaining slices
    const sliceColors = Array.from(circles)
      .slice(1)
      .map((c) => c.getAttribute("stroke") ?? c.style.stroke);
    expect(sliceColors).toContain("#8B5E3C");
    expect(sliceColors).toContain("#4A7C9E");
    expect(sliceColors).toContain("#6B8E23");
  });

  it("SC-8: member with rawPercent < 3% is clamped to 3% visual width", () => {
    // tiny has count=1 out of total=1000, rawPercent=0.1% — should be clamped to 3%
    const members: DonutMember[] = [
      { userId: 1, name: "big", color: "#aaa", count: 999, isConvenor: false },
      { userId: 2, name: "tiny", color: "#bbb", count: 1, isConvenor: false },
    ];
    const { container } = render(<DonutChart members={members} />);
    const circles = container.querySelectorAll("circle");
    // Find the tiny member's circle (last non-background circle)
    const tinyCircle = circles[circles.length - 1];
    const dashArray = tinyCircle.getAttribute("stroke-dasharray") ?? "";
    // CIRC = 2 * Math.PI * 40 ≈ 251.33
    const CIRC = 2 * Math.PI * 40;
    const clampedVisual = 0.03 * CIRC;
    // The first number in stroke-dasharray should be approximately clampedVisual
    const firstVal = parseFloat(dashArray.split(" ")[0]);
    expect(firstVal).toBeCloseTo(clampedVisual, 0);
  });

  it("SC-8: legend displays actual rawPercent (e.g. 0.1%), not clamped value", () => {
    const members: DonutMember[] = [
      { userId: 1, name: "big", color: "#aaa", count: 999, isConvenor: false },
      { userId: 2, name: "tiny", color: "#bbb", count: 1, isConvenor: false },
    ];
    render(<DonutChart members={members} />);
    // The legend should show the true percent for tiny: 0.1%
    const legendItems = document.querySelectorAll("li");
    const tinyLegend = Array.from(legendItems).find((li) =>
      li.textContent?.includes("tiny")
    );
    expect(tinyLegend?.textContent).toContain("0.1%");
  });

  it("SC-8: donut centre text equals sum of all member counts", () => {
    const total = BASE_MEMBERS.reduce((sum, m) => sum + m.count, 0); // 1000
    render(<DonutChart members={BASE_MEMBERS} />);
    expect(screen.getByText(String(total))).toBeTruthy();
  });

  it("SC-8: legend is sorted by count DESCENDING", () => {
    render(<DonutChart members={BASE_MEMBERS} />);
    const items = document.querySelectorAll("li");
    const names = Array.from(items).map((li) => {
      const span = li.querySelector("span:nth-child(2)");
      return span?.textContent ?? "";
    });
    // alice (600) should come before bob (399) which before tiny (1)
    const aliceIdx = names.findIndex((n) => n.includes("alice"));
    const bobIdx = names.findIndex((n) => n.includes("bob"));
    const tinyIdx = names.findIndex((n) => n.includes("tiny"));
    expect(aliceIdx).toBeLessThan(bobIdx);
    expect(bobIdx).toBeLessThan(tinyIdx);
  });

  it("SC-8: convenor legend row shows role label next to name", () => {
    render(<DonutChart members={BASE_MEMBERS} />);
    const items = document.querySelectorAll("li");
    const aliceLi = Array.from(items).find((li) => li.textContent?.includes("alice"));
    // Should contain the convenor role key
    expect(aliceLi?.textContent).toContain("team:role_convenor");
  });

  it("SC-8: chart uses no library — only SVG primitives (assertion: no recharts import)", () => {
    const src = readFileSync(
      resolve(__dirname, "../app/components/features/collaboration/DonutChart.tsx"),
      "utf-8"
    );
    expect(src).not.toMatch(/from\s+["']recharts["']/);
    expect(src).not.toMatch(/from\s+["']react-minimal-pie-chart["']/);
    expect(src).not.toMatch(/from\s+["']victory["']/);
    expect(src).not.toMatch(/from\s+["']chart\.js["']/);
  });
});
