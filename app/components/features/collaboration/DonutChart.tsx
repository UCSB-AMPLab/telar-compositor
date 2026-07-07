/**
 * DonutChart — hand-built SVG donut chart for the Collaboration sidebar.
 *
 * Renders one coloured slice per member using the stroke-dasharray technique.
 * Long-tail clamp: any member with a share < 3% is rendered at 3% visual width;
 * the legend still shows the true percentage.
 * Centre text: project-wide total edit count.
 * Legend: sorted descending by count; convenor rows marked with their role label.
 *
 * No chart library — hand-built SVG only.
 */

import { useTranslation } from "react-i18next";

// SVG geometry constants
const CX = 64;
const CY = 64;
const R = 40;
const STROKE_WIDTH = 24;
const CIRC = 2 * Math.PI * R; // circumference ≈ 251.33

export interface DonutMember {
  userId: number;
  name: string;
  /** Hex-ish colour from PRESENCE_PALETTE */
  color: string;
  /** Lifetime unique fields edited */
  count: number;
  isConvenor: boolean;
}

export interface DonutChartProps {
  members: DonutMember[];
  className?: string;
}

/** Format a ratio (0–1) as a percentage string with one decimal for sub-1% values. */
function formatPercent(ratio: number): string {
  const pct = ratio * 100;
  if (pct === 0) return "0%";
  if (pct < 1) return `${pct.toFixed(1)}%`;
  return `${Math.round(pct)}%`;
}

export function DonutChart({ members, className }: DonutChartProps) {
  const { t } = useTranslation(["collaboration", "team"]);

  const total = members.reduce((sum, m) => sum + m.count, 0);

  // Sort legend descending by count (display order only — slice order follows input)
  const legendSorted = [...members].sort((a, b) => b.count - a.count);

  // Compute display percentages with 3% minimum clamp.
  // If clamped members would push total > 100%, compress non-clamped shares proportionally.
  const rawRatios = members.map((m) => (total > 0 ? m.count / total : 0));
  const MIN_RATIO = 0.03;

  const clampedRatios = rawRatios.map((r) => Math.max(r, MIN_RATIO));
  const clampedSum = clampedRatios.reduce((s, r) => s + r, 0);

  let displayRatios: number[];
  if (clampedSum <= 1 + 1e-9) {
    displayRatios = clampedRatios;
  } else {
    // Some members got clamped; compress non-clamped shares so total stays at 1.
    const clampedCount = rawRatios.filter((r) => r < MIN_RATIO).length;
    const clampedTotal = clampedCount * MIN_RATIO;
    const remaining = 1 - clampedTotal;
    const unclampedRawSum = rawRatios
      .filter((r) => r >= MIN_RATIO)
      .reduce((s, r) => s + r, 0);
    displayRatios = rawRatios.map((r) =>
      r < MIN_RATIO ? MIN_RATIO : unclampedRawSum > 0 ? (r / unclampedRawSum) * remaining : 0
    );
  }

  // Build slice offsets (cumulative); SVG starts at 3 o'clock, rotate -90° to start at 12.
  const slices = members.map((member, i) => {
    const offset = displayRatios.slice(0, i).reduce((s, r) => s + r, 0);
    const displayRatio = displayRatios[i];
    return {
      member,
      rawRatio: rawRatios[i],
      displayRatio,
      offset,
    };
  });

  return (
    <div className={className}>
      <svg
        viewBox="0 0 128 128"
        className="w-full max-w-[128px] mx-auto block"
        role="img"
        aria-label={t("collaboration:donut_aria_label", { total })}
      >
        {/* Background track */}
        <circle
          cx={CX}
          cy={CY}
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE_WIDTH}
          className="text-gray-100"
        />

        {/* Member slices */}
        {slices.map(({ member, displayRatio, offset }) => (
          <circle
            key={member.userId}
            cx={CX}
            cy={CY}
            r={R}
            fill="none"
            stroke={member.color}
            strokeWidth={STROKE_WIDTH}
            strokeDasharray={`${displayRatio * CIRC} ${CIRC}`}
            strokeDashoffset={-offset * CIRC}
            transform="rotate(-90 64 64)"
          />
        ))}

        {/* Centre total */}
        <text
          x={CX}
          y={CY - 6}
          textAnchor="middle"
          dominantBaseline="central"
          className="font-heading text-lg fill-current text-charcoal"
          fontSize="18"
          fontFamily="var(--font-heading, sans-serif)"
        >
          {total}
        </text>
        <text
          x={CX}
          y={CY + 10}
          textAnchor="middle"
          dominantBaseline="central"
          className="fill-current text-fg-muted"
          fontSize="9"
          fontFamily="var(--font-body, sans-serif)"
        >
          {t("collaboration:donut_total_label")}
        </text>
      </svg>

      {/* Legend */}
      <ul className="mt-3 space-y-1">
        {legendSorted.map((member) => {
          const rawRatio = total > 0 ? member.count / total : 0;
          return (
            <li
              key={member.userId}
              className="flex items-center gap-2 font-body text-sm text-charcoal"
            >
              <span
                className="h-2.5 w-2.5 rounded-full shrink-0"
                style={{ backgroundColor: member.color }}
                aria-hidden="true"
              />
              <span className="truncate">
                {member.name}
                {member.isConvenor && ` — ${t("team:role_convenor")}`}
              </span>
              <span className="ml-auto tabular-nums text-xs text-gray-500 shrink-0">
                {formatPercent(rawRatio)} ({member.count})
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
