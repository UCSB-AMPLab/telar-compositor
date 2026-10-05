// @vitest-environment jsdom

/**
 * TabNav contract. The IA is seven tabs: the leftmost Start tab plus a
 * right-area "Docs ↗" link.
 *
 * Covers the seven tabs in order with Start leftmost (a Docs link is
 * present in the right area), no /dashboard or /homepage tab,
 * untinted tab icons (the active tab stays charcoal), and the
 * Publish tab being hidden for a caller with no project membership
 * (present for every project role alike).
 *
 * @version v1.5.0-beta
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

// The publish-tab gate keys off useIsPublisher(); default "convenor" so
// the baseline includes Publish. Individual tests override the role.
//
// useIsPublisher delegates to the real isPublishingRole rather than
// restating the membership set: a mock that restates it answers from its
// own copy, so the tab gate would keep reporting the old set after the real
// one changed.
const mockRole = vi.fn<() => "convenor" | "collaborator" | "instructor" | null>(() => "convenor");
vi.mock("~/hooks/use-role", async () => {
  const { isPublishingRole } = await import("~/lib/publishing-roles");
  return {
    useIsConvenor: () => mockRole() === "convenor",
    useIsPublisher: () => isPublishingRole(mockRole()),
    useRole: () => mockRole(),
  };
});

function renderTabNav(props: { showCourseTab?: boolean } = {}) {
  return render(
    <MemoryRouter initialEntries={["/objects"]}>
      <TabNav {...props} />
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
    mockRole.mockReturnValue("convenor");
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

  it("Publish tab is present for the convenor", () => {
    mockRole.mockReturnValue("convenor");
    const { container } = renderTabNav();
    const hrefs = Array.from(container.querySelectorAll("nav a[href]")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toContain("/publish");
  });

  it("Publish tab is present for a collaborator", () => {
    mockRole.mockReturnValue("collaborator");
    const { container } = renderTabNav();
    const hrefs = Array.from(container.querySelectorAll("nav a[href]")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toContain("/publish");
  });

  it("Publish tab is present for an instructor", () => {
    mockRole.mockReturnValue("instructor");
    const { container } = renderTabNav();
    const hrefs = Array.from(container.querySelectorAll("nav a[href]")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toContain("/publish");
  });

  it("Publish tab is absent for a caller with no membership", () => {
    mockRole.mockReturnValue(null);
    const { container } = renderTabNav();
    const hrefs = Array.from(container.querySelectorAll("nav a[href]")).map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).not.toContain("/publish");
  });
});

/**
 * The Course tab is the only way into `/course`, and a course that could be
 * created and then never run is the reason it exists.
 *
 * It is off by default because both of its conditions are server-side: whether
 * there is a course to run, and whether the session has answered the course
 * password. The second is why an unconditional tab would be wrong rather than
 * merely eager — `/course` answers a locked session with a bare 403, and the
 * password is answered on the create-site form, so the tab would lead to a
 * wall with no way past it.
 */
describe("TabNav — the Course tab", () => {
  beforeEach(() => {
    mockRole.mockReturnValue("convenor");
  });

  function tabHrefs(container: HTMLElement): string[] {
    return Array.from(container.querySelectorAll("nav a[href]"))
      .map((a) => a.getAttribute("href") ?? "")
      .filter((href) => href.startsWith("/") && !href.includes("?"));
  }

  it("is absent by default", () => {
    const { container } = renderTabNav();
    expect(tabHrefs(container)).not.toContain("/course");
  });

  it("appears when the shell says there is a course to run and the gate is open", () => {
    const { container } = renderTabNav({ showCourseTab: true });
    expect(tabHrefs(container)).toContain("/course");
  });

  it("sits last, after Publish", () => {
    const { container } = renderTabNav({ showCourseTab: true });
    const hrefs = tabHrefs(container);
    expect(hrefs[hrefs.length - 1]).toBe("/course");
  });

  it("is offered to an instructor", () => {
    // The screen decides standing for itself, and a course instructor is not
    // the convenor of the site they are looking at. Hiding the tab by site
    // role would hide the course from the people who run it.
    mockRole.mockReturnValue("instructor");
    const { container } = renderTabNav({ showCourseTab: true });
    expect(tabHrefs(container)).toContain("/course");
  });
});
