// @vitest-environment jsdom
/**
 * Start's collaboration cards: the convenor's large invite button, which says
 * what an added person can do or how many already work on the site, and the
 * link to the contribution record on a shared site.
 *
 * @version v1.5.2-beta
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count !== undefined ? `${key}:${options.count}` : key),
  }),
}));
vi.mock("react-router", () => ({
  Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
    <a href={to} className={className}>{children}</a>
  ),
}));

import { ContributionRecordCard, WorkTogetherCard } from "~/components/features/start/CollaborationCards";

describe("WorkTogetherCard", () => {
  it("tells a convenor working alone what an added person can do, and opens the sidebar", () => {
    const onInvite = vi.fn();
    render(<WorkTogetherCard collaboratorCount={0} onInvite={onInvite} />);
    expect(screen.getByText("collab_card.body_solo")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /collab_card.invite/ }));
    expect(onInvite).toHaveBeenCalledOnce();
  });

  it("counts the people already working on the site", () => {
    render(<WorkTogetherCard collaboratorCount={3} onInvite={() => {}} />);
    expect(screen.getByText("collab_card.body:3")).toBeDefined();
    expect(screen.queryByText("collab_card.body_solo")).toBeNull();
  });
});

describe("ContributionRecordCard", () => {
  it("links to the contribution record", () => {
    render(<ContributionRecordCard />);
    expect(screen.getByText("record_card.link").closest("a")?.getAttribute("href")).toBe("/contributions");
  });
});
