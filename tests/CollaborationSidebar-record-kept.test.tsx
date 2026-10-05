// @vitest-environment jsdom
/**
 * The collaboration panel keeps the last record it showed while its read is
 * unreachable, for the active project only.
 *
 * The record fetcher's data is driven directly: a record, then the
 * `{ unreachable: true }` the Contributions route's `clientLoader` answers for
 * a failed read of the panel's record. The panel keeps showing the record, and
 * drops it when the active project changes.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

const fetcherData: { current: unknown } = { current: undefined };
vi.mock("react-router", () => ({
  useFetcher: () => ({ submit: vi.fn(), load: vi.fn(), state: "idle", formData: undefined, data: fetcherData.current }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

const site: { live: number | null } = { live: 1 };
vi.mock("~/lib/page-site", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/page-site")>();
  return { ...actual, usePageSite: () => ({ ...actual.usePageSite(), live: site.live }) };
});

import { CollaborationContext, type CollaborationContextValue } from "~/hooks/use-collaboration";
import { CollaborationSidebar } from "~/components/features/collaboration/CollaborationSidebar";

const KINDS = { added: 1, edited: 2, words: 3 };
const RECORD = {
  currentUserId: 1,
  projectId: 1,
  members: [
    {
      userId: 1,
      displayName: "Ana Recorded",
      color: "#E47A6F",
      role: "convenor",
      former: false,
      kinds: { objects: KINDS, steps: KINDS, glossary: KINDS, pages: KINDS, panels: KINDS },
      editingSeconds: 60,
      writingSeconds: 30,
    },
  ],
};

const CONTEXT = {
  ydoc: null,
  remoteCollaborators: [],
  isPublishing: false,
  isUpgrading: false,
} as unknown as CollaborationContextValue;

function sidebar() {
  return (
    <CollaborationContext.Provider value={CONTEXT}>
      <CollaborationSidebar open onClose={vi.fn()} isConvenor={false} members={[]} seats={{ used: 1, limit: 6 }} />
    </CollaborationContext.Provider>
  );
}

describe("CollaborationSidebar — the record during an outage", () => {
  it("keeps the record through an unreachable answer, and drops it for another project", () => {
    site.live = 1;
    fetcherData.current = RECORD;
    const { rerender } = render(sidebar());
    expect(screen.getByText("Ana Recorded")).toBeTruthy();

    fetcherData.current = { unreachable: true };
    rerender(sidebar());
    expect(screen.getByText("Ana Recorded")).toBeTruthy();

    site.live = 2;
    rerender(sidebar());
    expect(screen.queryByText("Ana Recorded")).toBeNull();
  });

  it("does not keep one project's record for another when the project changes before the outage", () => {
    site.live = 1;
    fetcherData.current = RECORD;
    const { rerender } = render(sidebar());
    expect(screen.getByText("Ana Recorded")).toBeTruthy();

    // The fetcher still holds project 1's answer when project 2 becomes live.
    site.live = 2;
    rerender(sidebar());
    fetcherData.current = { unreachable: true };
    rerender(sidebar());
    expect(screen.queryByText("Ana Recorded")).toBeNull();
  });

  it("keeps a record for the project it names, whoever asked for it", () => {
    // A read the router sends by itself, after an action, never passes through
    // the panel's own load: the answer's own project decides where it is kept.
    site.live = 1;
    fetcherData.current = undefined;
    const { rerender } = render(sidebar());
    // Project 2 becomes live, and the router's own read brings project 2's record.
    site.live = 2;
    fetcherData.current = { ...RECORD, projectId: 2 };
    rerender(sidebar());
    fetcherData.current = { unreachable: true };
    rerender(sidebar());
    expect(screen.getByText("Ana Recorded")).toBeTruthy();

    site.live = 1;
    rerender(sidebar());
    expect(screen.queryByText("Ana Recorded")).toBeNull();
  });
});

