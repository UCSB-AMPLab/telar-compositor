// @vitest-environment jsdom

/**
 * TabNav contract. The IA is seven tabs: the leftmost Start tab plus a
 * right-area "Docs ↗" link.
 *
 * Covers the seven tabs in order with Start leftmost (a Docs link is
 * present in the right area), no /dashboard or /homepage tab,
 * untinted tab icons (the active tab stays charcoal), and the
 * Publish tab being hidden for collaborators.
 *
 * @version v1.3.0-beta
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { TabNav } from "~/components/layout/TabNav";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("~/hooks/use-collaboration", () => ({
  useCollaborationContext: () => ({
    remoteCollaborators: [],
    canUndo: false,
    canRedo: false,
    undo: vi.fn(),
    redo: vi.fn(),
  }),
}));

// The publish-tab gate keys off useIsConvenor(); default true so
// the baseline includes Publish. Individual tests override it.
const mockIsConvenor = vi.fn(() => true);
vi.mock("~/hooks/use-role", () => ({
  useIsConvenor: () => mockIsConvenor(),
  useRole: () => (mockIsConvenor() ? "convenor" : "collaborator"),
}));

function renderTabNav() {
  return render(
    <MemoryRouter initialEntries={["/objects"]}>
      <TabNav />
    </MemoryRouter>,
  );
}

/** Tab labels are rendered via the mocked t() that echoes the key. */
const EXPECTED_TAB_KEYS = [
  "nav.start",
  "nav.objects",
  "nav.stories",
  "nav.glossary",
  "nav.pages",
  "nav.config",
  "nav.publish",
];

describe("TabNav — seven-tab IA (Start leftmost)", () => {
  beforeEach(() => {
    mockIsConvenor.mockReturnValue(true);
  });

  it("renders exactly seven primary tabs in order (Start · Objects · Stories · Glossary · Pages · Site settings · Publish)", () => {
    const { container } = renderTabNav();
    const navLinks = Array.from(container.querySelectorAll("nav a[href]")).filter(
      (a) => {
        const href = a.getAttribute("href") ?? "";
        // Exclude the right-aligned external Site link (rendered as a plain
        // anchor to the published site, only present when pagesUrl is set) and
        // the right-area "Docs ↗" link (wired to /start?doc=start —
        // it is a utility link, not a primary tab). Primary tabs are bare
        // routes ("/start", "/objects", …) with no query string.
        return href.startsWith("/") && !href.includes("?");
      },
    );
    const labels = navLinks.map((a) => a.textContent?.trim());
    expect(labels).toEqual(EXPECTED_TAB_KEYS);
  });

  it("Start is the leftmost tab and links to /start", () => {
    const { container } = renderTabNav();
    const firstTab = container.querySelector('nav a[href^="/"]');
    expect(firstTab?.getAttribute("href")).toBe("/start");
    expect(firstTab?.textContent?.trim()).toBe("nav.start");
  });

  it("a Docs button is present in the right area (references nav.docs)", () => {
    const { container } = renderTabNav();
    // The Docs trigger is wired to the shell DocsDrawer via onOpenDoc.
    // It is now a <button>, not an anchor — no href. Identify by aria-label.
    const docsBtn = container.querySelector('button[aria-label="nav.docs"]');
    expect(docsBtn).not.toBeNull();
    expect(docsBtn?.textContent).toContain("nav.docs");
    // No href — it's a button that calls onOpenDoc("start")
    expect(docsBtn?.getAttribute("href")).toBeNull();
  });

  it("no tab links to /dashboard or /homepage", () => {
    const { container } = renderTabNav();
    const hrefs = Array.from(container.querySelectorAll("nav a[href]")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).not.toContain("/dashboard");
    expect(hrefs).not.toContain("/homepage");
  });

  it("tab icons are untinted — no content-accent classes on the nav", () => {
    const { container } = renderTabNav();
    const html = container.innerHTML;
    // The per-content-type accent tints were removed in a UAT polish
    // pass; icons inherit the tab's grey/charcoal text colour.
    expect(html).not.toContain("text-anil-deep"); // was stories
    expect(html).not.toContain("text-chilca"); // was objects
    expect(html).not.toContain("text-caracol"); // was start/glossary
    expect(html).not.toContain("text-terracotta"); // was publish
  });

  it("the active tab text/underline stays charcoal", () => {
    const { container } = renderTabNav();
    const activeLink = container.querySelector('nav a[href="/objects"]');
    expect(activeLink?.className).toContain("text-charcoal");
    expect(activeLink?.className).toContain("border-charcoal");
  });

  it("Publish tab is present when useIsConvenor() is true", () => {
    mockIsConvenor.mockReturnValue(true);
    const { container } = renderTabNav();
    const hrefs = Array.from(container.querySelectorAll("nav a[href]")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toContain("/publish");
  });

  it("Publish tab is absent when useIsConvenor() is false (collaborator)", () => {
    mockIsConvenor.mockReturnValue(false);
    const { container } = renderTabNav();
    const hrefs = Array.from(container.querySelectorAll("nav a[href]")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).not.toContain("/publish");
  });
});
