// @vitest-environment jsdom
/**
 * The sync dialog's page changes: one entry per page whose
 * file changed on GitHub, beside the story changes, each with the choice of
 * GitHub's version or the author's, and what the accept is sent for it.
 *
 * A change GitHub alone made is taken by default; a conflict is kept by
 * default. A check that could not read the page files lists none, says so,
 * and does not mark the page check concluded, so the accept keeps head_sha.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, within } from "@testing-library/react";
import type { FullSyncDiff } from "~/lib/sync.server";
import type { PageAddition, PageContentChange, PageContentCheck, PageFileChange } from "~/lib/page-content.server";

const submitSpy = vi.fn();
const fetcherData: { current: unknown } = { current: undefined };
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => ({ submit: submitSpy, state: "idle", data: fetcherData.current }),
    useNavigate: () => vi.fn(),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));

import { SyncConfirmModal } from "~/components/features/dashboard/SyncConfirmModal";
import { hasDiffChanges } from "~/components/features/dashboard/sync-changes";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

function change(pageId: number, kind: PageContentChange["kind"]): PageContentChange {
  return { pageId, slug: `page-${pageId}`, title: `Page ${pageId}`, kind, acceptByDefault: kind === "github-only", expected: `hash-${pageId}` };
}

function diffWith(pages: PageContentCheck): FullSyncDiff {
  return {
    objects: { newObjects: [], changedObjects: [], missingObjects: [], unregisteredFiles: [], reordered: null },
    stories: { newStories: [], changedStories: [], missingStories: [], content: { conclusive: true, changes: [], suppressedEditorOnly: 0 } },
    config: { changedFields: [], versionChange: null },
    glossary: { added: [], changed: [], removed: [] },
    pages,
    hasConflicts: false,
    classification: "three-way",
    suppressedEditorOnly: 0,
    unreadableFiles: [],
    headSha: HEAD,
  } as FullSyncDiff;
}

const listed = (...changes: PageContentChange[]): PageContentCheck => ({ conclusive: true, changes, suppressedEditorOnly: 0 });

function renderWithDiff(diff: FullSyncDiff) {
  const view = render(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
  fireEvent.click(screen.getByText("sync_modal.check_changes"));
  fetcherData.current = { ok: true, intent: "compute-full-sync-diff", diff };
  view.rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
  return view;
}

function applied(): Record<string, unknown> {
  fireEvent.click(screen.getByText(/^sync_modal\.apply_(sync|other_changes)$/));
  const call = submitSpy.mock.calls.find(([body]) => (body as { intent?: string }).intent === "apply-full-sync");
  return JSON.parse((call![0] as { changes: string }).changes);
}

const card = (pageId: number) => screen.getByTestId(`page-content-${pageId}`);

beforeEach(() => {
  submitSpy.mockClear();
  fetcherData.current = undefined;
});

describe("the page changes in the dialog", () => {
  it("lists a page GitHub alone changed, taken by default, and offers to apply it", () => {
    renderWithDiff(diffWith(listed(change(5, "github-only"))));
    expect(screen.getByText("sync_modal.changes_found")).toBeTruthy();
    expect(within(card(5)).getByText("Page 5")).toBeTruthy();
    expect((within(card(5)).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    const sent = applied();
    expect(sent.pages).toEqual({ acceptContent: [{ pageId: 5, slug: "page-5", expected: "hash-5" }], takeFiles: [], addFiles: [] });
    expect(sent.pageContentChecked).toBe(true);
  });

  it("keeps the author's version of a page GitHub alone changed when its box is unticked", () => {
    renderWithDiff(diffWith(listed(change(5, "github-only"))));
    fireEvent.click(within(card(5)).getByRole("checkbox"));
    expect(applied().pages).toEqual({ acceptContent: [], takeFiles: [], addFiles: [] });
  });

  it("keeps the author's version of a conflict by default, and sends GitHub's when chosen", () => {
    renderWithDiff(diffWith(listed(change(6, "conflict"))));
    const [repo, mine] = within(card(6)).getAllByRole("radio") as HTMLInputElement[];
    expect(mine.checked).toBe(true);
    expect(repo.checked).toBe(false);
    fireEvent.click(repo);
    expect(applied().pages).toEqual({ acceptContent: [{ pageId: 6, slug: "page-6", expected: "hash-6" }], takeFiles: [], addFiles: [] });
  });

  it("says the page files could not be read, lists none, and does not mark the page check concluded", () => {
    renderWithDiff(diffWith({ conclusive: false, reason: "the page trees came back malformed" }));
    expect(screen.getByText("sync_modal.pages_inconclusive")).toBeTruthy();
    expect(screen.queryByTestId(/^page-content-/)).toBeNull();
    expect(screen.getByText("sync_modal.check_again")).toBeTruthy();
    expect(screen.queryByText("sync_modal.no_changes")).toBeNull();
  });
});

describe("an accept that did not apply a page", () => {
  it("checks again after a page changed while it was reviewed, naming it", () => {
    const view = renderWithDiff(diffWith(listed(change(5, "github-only"))));
    applied();
    fetcherData.current = { ok: false, intent: "apply-full-sync", error: "page_changed_since_review", pageIds: [5] };
    view.rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    const recheck = submitSpy.mock.calls.filter(([body]) => (body as { intent?: string }).intent === "compute-full-sync-diff");
    expect(recheck).toHaveLength(2);
  });

  it("names the page that did not save", () => {
    const view = renderWithDiff(diffWith(listed(change(5, "github-only"))));
    applied();
    fetcherData.current = { ok: false, intent: "apply-full-sync", error: "page_content_failed", pageIds: [5] };
    view.rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    expect(screen.getByText(/sync_modal\.error_page_failed/).textContent).toContain("Page 5");
  });
});

// ---------------------------------------------------------------------------
// Page files on one side only, and pages GitHub added
// ---------------------------------------------------------------------------

function oneSideChange(name: string, kind: PageFileChange["kind"], over: Partial<PageFileChange> = {}): PageFileChange {
  const pageId = Number(name.replace(/\D/g, "")) || 9;
  return { name, pageId, slug: name.replace(/\.md$/, ""), title: `Page ${pageId}`, kind, acceptByDefault: kind === "deleted", expected: `hash-${pageId}`, ...over };
}

const withFiles = (files: PageFileChange[], additions: PageAddition[] = []): PageContentCheck =>
  ({ conclusive: true, changes: [], suppressedEditorOnly: 0, files, additions });
const fileCard = (name: string) => screen.getByTestId(`page-file-${name}`);

describe("the page files on one side only in the dialog", () => {
  it("removes a page GitHub alone deleted by default, with the hash reviewed", () => {
    const deleted = oneSideChange("page-5.md", "deleted", { inMenu: true });
    renderWithDiff(diffWith(withFiles([deleted])));
    expect(within(fileCard("page-5.md")).getByText("sync_modal.page_deleted")).toBeTruthy();
    expect(within(fileCard("page-5.md")).getByText("sync_modal.page_deleted_menu")).toBeTruthy();
    expect((within(fileCard("page-5.md")).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect((applied().pages as Record<string, unknown>).takeFiles).toEqual([
      { name: "page-5.md", pageId: 5, expected: "hash-5" },
    ]);
  });

  it("keeps a page GitHub deleted when its box is unticked, and says the next publish puts it back", () => {
    renderWithDiff(diffWith(withFiles([oneSideChange("page-5.md", "deleted")])));
    fireEvent.click(within(fileCard("page-5.md")).getByRole("checkbox"));
    expect(within(fileCard("page-5.md")).getByText("sync_modal.page_deleted_keep_note")).toBeTruthy();
    expect((applied().pages as Record<string, unknown>).takeFiles).toEqual([]);
  });

  it.each([
    ["deleted-conflict", "sync_modal.page_deleted_conflict", "sync_modal.conflict_delete"],
    ["deleted-renamed-here", "sync_modal.page_deleted_renamed_here", "sync_modal.conflict_delete"],
    ["not-on-github", "sync_modal.page_not_on_github", "sync_modal.conflict_delete"],
    ["deleted-here-edited", "sync_modal.conflict_deleted_here", "sync_modal.conflict_restore"],
  ] as const)("keeps the Compositor's pages for %s by default, and names the file when GitHub's side is chosen", (kind, text, repoLabel) => {
    renderWithDiff(diffWith(withFiles([oneSideChange("page-7.md", kind)])));
    expect(within(fileCard("page-7.md")).getByText(text)).toBeTruthy();
    const [repo, mine] = within(fileCard("page-7.md")).getAllByRole("radio") as HTMLInputElement[];
    expect(mine.checked).toBe(true);
    expect(within(fileCard("page-7.md")).getByText(repoLabel)).toBeTruthy();
    fireEvent.click(repo);
    expect((applied().pages as Record<string, unknown>).takeFiles).toEqual([
      { name: "page-7.md", pageId: 7, expected: "hash-7" },
    ]);
  });

  it.each([
    ["deleted", "sync_modal.page_other_language"],
    ["deleted-conflict", "sync_modal.page_other_language_conflict"],
  ] as const)("says a %s removal the one-language reduction makes is another language's version, naming the page that stays", (kind, text) => {
    renderWithDiff(diffWith(withFiles([oneSideChange("acerca.md", kind, { pageId: 6, otherLanguageOf: "about.md" })])));
    const shown = within(fileCard("acerca.md"));
    expect(shown.getByText(`${text} {"file":"about.md"}`)).toBeTruthy();
    expect(shown.queryByText("sync_modal.page_deleted")).toBeNull();
    expect(shown.queryByText("sync_modal.page_deleted_conflict")).toBeNull();
  });

  it.each([
    ["github-only", "sync_modal.page_takes_language_version"],
    ["conflict", "sync_modal.page_takes_language_version_conflict"],
  ] as const)("says a %s page takes the text of the file its site shows, naming that file", (kind, key) => {
    renderWithDiff(diffWith(listed({ ...change(5, kind), takesLanguageFrom: "acerca.md" })));
    expect(within(card(5)).getByText(`${key} {"file":"acerca.md"}`)).toBeTruthy();
    expect(within(card(5)).queryByText("sync_modal.pages_conflict")).toBeNull();
  });

  it("takes GitHub's file onto a page renamed here as its content, read from the old file", () => {
    renderWithDiff(diffWith(withFiles([oneSideChange("page-7.md", "edited-renamed-here", { slug: "credits" })])));
    expect(within(fileCard("page-7.md")).getByText("sync_modal.page_edited_renamed_here")).toBeTruthy();
    fireEvent.click((within(fileCard("page-7.md")).getAllByRole("radio") as HTMLInputElement[])[0]);
    expect(applied().pages).toEqual({ acceptContent: [{ pageId: 7, slug: "page-7", expected: "hash-7" }], takeFiles: [], addFiles: [] });
  });

  it("lists the pages GitHub added as pre-accepted, with the menu note only when GitHub's menu names the page", () => {
    const additions: PageAddition[] = [
      { name: "about.md", slug: "about", title: "About", menu: { label: "About", after: null } },
      { name: "credits.md", slug: "credits", title: "Credits", menu: null },
    ];
    renderWithDiff(diffWith(withFiles([], additions)));
    const added = screen.getByTestId("pages-added");
    expect(within(added).getAllByText("sync_modal.page_added_menu")).toHaveLength(1);
    expect(screen.getByText("sync_modal.changes_found")).toBeTruthy();
  });

  it("names a page refused as changed while reviewed by its card's title", () => {
    const view = renderWithDiff(diffWith(withFiles([oneSideChange("page-5.md", "deleted")])));
    applied();
    fetcherData.current = { ok: false, intent: "apply-full-sync", error: "page_content_failed", pageIds: [5] };
    view.rerender(<SyncConfirmModal open unpublishedCount={0} onClose={() => {}} />);
    expect(screen.getByText(/sync_modal\.error_page_failed/).textContent).toContain("Page 5");
  });

  it("says a page added on both sides is that, not an edit", () => {
    renderWithDiff(diffWith(listed({ ...change(6, "conflict"), addedBoth: true })));
    expect(within(card(6)).getByText("sync_modal.page_added_both")).toBeTruthy();
  });
});

describe("hasDiffChanges counts the page files", () => {
  it("is true for a diff whose only change is a page GitHub added", () => {
    expect(hasDiffChanges(diffWith(withFiles([], [{ name: "about.md", slug: "about", title: "About" }])))).toBe(true);
    expect(hasDiffChanges(diffWith(withFiles([])))).toBe(false);
  });
});
