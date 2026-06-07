// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WhatsNewModal } from "~/components/features/release/WhatsNewModal";

// Mock the release module so we can flip the contributors list per test.
const releaseMock = { id: "1.3.0-beta", i18nKey: "v1_3_0_beta", contributors: [] as string[] };
vi.mock("~/lib/release-notes", () => ({
  get CURRENT_RELEASE() {
    return releaseMock;
  },
}));

// Minimal i18n mock: returns arrays for returnObjects, strings otherwise.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { returnObjects?: boolean }) => {
      const map: Record<string, unknown> = {
        "v1_3_0_beta.title": "New in the compositor",
        "v1_3_0_beta.features_label": "New features",
        "v1_3_0_beta.features": ["Feature A", "Feature B"],
        "v1_3_0_beta.fixes_label": "Fixes",
        "v1_3_0_beta.fixes": ["Fix A"],
        "v1_3_0_beta.thanks_label": "Thanks to",
        "v1_3_0_beta.thanks_suffix": "for reporting bugs and issues.",
        "v1_3_0_beta.thanks_cta": "You can help make things better, using the bug button",
        "v1_3_0_beta.dismiss": "Got it",
      };
      const v = map[key];
      if (opts?.returnObjects) return v as string[];
      return (v as string) ?? key;
    },
  }),
}));

describe("WhatsNewModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<WhatsNewModal open={false} onDismiss={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders title, feature and fix bullets when open", () => {
    releaseMock.contributors = [];
    render(<WhatsNewModal open onDismiss={() => {}} />);
    expect(screen.getByText("New in the compositor")).toBeTruthy();
    expect(screen.getByText("Feature A")).toBeTruthy();
    expect(screen.getByText("Feature B")).toBeTruthy();
    expect(screen.getByText("Fix A")).toBeTruthy();
  });

  it("omits the thanks line when there are no contributors", () => {
    releaseMock.contributors = [];
    render(<WhatsNewModal open onDismiss={() => {}} />);
    expect(screen.queryByText(/Thanks to/)).toBeNull();
    expect(screen.queryByText(/using the bug button/)).toBeNull();
  });

  it("renders contributor handles as GitHub links when present", () => {
    releaseMock.contributors = ["alice", "bob"];
    render(<WhatsNewModal open onDismiss={() => {}} />);
    expect(screen.getByText(/Thanks to/)).toBeTruthy();
    const alice = screen.getByText("@alice") as HTMLAnchorElement;
    expect(alice.getAttribute("href")).toBe("https://github.com/alice");
    expect(screen.getByText("@bob")).toBeTruthy();
  });

  it("renders the thanks suffix and CTA when contributors are present", () => {
    releaseMock.contributors = ["alice"];
    render(<WhatsNewModal open onDismiss={() => {}} />);
    expect(screen.getByText(/for reporting bugs and issues/)).toBeTruthy();
    expect(screen.getByText(/using the bug button/)).toBeTruthy();
  });

  it("calls onDismiss when the Got it button is clicked", () => {
    releaseMock.contributors = [];
    const onDismiss = vi.fn();
    render(<WhatsNewModal open onDismiss={onDismiss} />);
    fireEvent.click(screen.getByText("Got it"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
