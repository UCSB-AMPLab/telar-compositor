// @vitest-environment jsdom
/**
 * This file pins the `ConnectionPill` three-state status indicator — the
 * coloured dot in the header that surfaces whether the live-collab websocket
 * is connected, connecting, or offline.
 *
 * HEADER-05 relabel: the three connectionStatus keys are unchanged; the labels
 * read Live / Reconnecting… / Working solo and the dots are chilca / amber-
 * pulse / neutral-cream. Working solo must NOT read as an error (no red).
 *
 * @version v1.3.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConnectionPill } from "~/components/ui/ConnectionPill";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        presence_live: "Live",
        presence_reconnecting: "Reconnecting…",
        presence_working_solo: "Working solo",
        connection_status_tooltip:
          "Your edits are saved locally and will sync when you're back online.",
      };
      return map[key] ?? key;
    },
  }),
}));

describe("ConnectionPill (HEADER-05 relabel)", () => {
  it("status='connected' reads 'Live' on a chilca (green) dot", () => {
    const { container } = render(<ConnectionPill status="connected" />);
    expect(container.querySelector(".bg-chilca")).not.toBeNull();
    expect(screen.getByText("Live")).toBeTruthy();
  });

  it("status='connecting' reads 'Reconnecting…' on an amber animated dot", () => {
    const { container } = render(<ConnectionPill status="connecting" />);
    const dot = container.querySelector(".bg-amber-500");
    expect(dot).not.toBeNull();
    expect(dot?.className).toContain("animate-pulse");
    expect(screen.getByText("Reconnecting…")).toBeTruthy();
  });

  it("status='offline' reads 'Working solo' on a neutral/cream dot (NOT red)", () => {
    const { container } = render(<ConnectionPill status="offline" />);
    expect(screen.getByText("Working solo")).toBeTruthy();
    // Working solo must not read as an error — no red dot anywhere.
    expect(container.querySelector(".bg-red-500")).toBeNull();
    expect(container.querySelector(".bg-cream-dark")).not.toBeNull();
  });

  it("tooltip label renders at font-heading font-semibold", () => {
    const { container } = render(<ConnectionPill status="connected" />);
    const label = screen.getByText("Live");
    expect(label.className).toContain("font-heading");
    expect(label.className).toContain("font-semibold");
    // sanity: it lives inside the role=status tooltip region
    expect(container.querySelector("[role='status']")?.textContent).toContain("Live");
  });

  it("offline tooltip keeps the reassuring sub-text", () => {
    const { container } = render(<ConnectionPill status="offline" />);
    const tooltip = container.querySelector("[role='status']");
    expect(tooltip?.textContent).toContain("Your edits are saved locally");
  });

  it("wrapper div has group class so hover CSS can show tooltip", () => {
    const { container } = render(<ConnectionPill status="connected" />);
    const wrapper = container.firstElementChild;
    expect(wrapper?.className).toContain("group");
  });
});
