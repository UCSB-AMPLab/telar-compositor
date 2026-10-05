// @vitest-environment jsdom
/**
 * The Upload tab in the waiting-on-convenor state.
 *
 * Ruling: disable rather than refuse. The tab stays visible (canUpload is
 * still true — the role permits it), but when uploadDisabledReason is set,
 * the functional upload flow (drop zone, file picker) is replaced by the
 * reason text, so the control is never offered and then refused by the
 * server.
 *
 * The upload action's own refusal carries its remedy link, whatever
 * the notice from the page load said.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AddObjectDialog } from "~/components/features/objects/AddObjectDialog";
import { describeUploadNotice, describeUploadRefusalAction, uploadNotice } from "~/lib/upload-notice";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const map: Record<string, string> = {
        tab_iiif: "IIIF manifest",
        tab_upload: "Upload image",
        tab_external: "External media",
        tab_select_label: "Choose a tab",
        add_object_title: "Add object",
        upload_disabled_upgrade_awaits_convenor: "Uploading is unavailable until the convenor upgrades the site.",
        upload_drop_primary: "Drag images here",
      };
      return map[key] ?? key;
    },
  }),
}));

function baseProps(overrides: Partial<Parameters<typeof AddObjectDialog>[0]> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    projectId: 1,
    canUpload: true,
    uploadDisabledReason: null,
    fetchResult: null,
    onFetchUrl: vi.fn(),
    onIiifConfirm: vi.fn(),
    isFetching: false,
    onUploadConfirm: vi.fn(),
    isUploading: false,
    uploadError: null,
    existingObjectIds: [],
    onExternalConfirm: vi.fn(),
    isAdding: false,
    ...overrides,
  };
}

function openUploadTab() {
  const uploadTabButtons = screen.getAllByText("Upload image");
  // The visible button (>=520px row), not the <select><option> also in the DOM.
  const button = uploadTabButtons.find((el) => el.tagName === "BUTTON");
  fireEvent.click(button!);
}

describe("AddObjectDialog — Upload tab, waiting-on-convenor state", () => {
  beforeEach(() => {
    // The last-used tab persists to localStorage per project (jsdom keeps
    // it across tests in this file) — clear it so each test starts on the
    // component's own default tab, not whatever the previous test selected.
    localStorage.clear();
  });

  it("uploadDisabledReason=null: the interactive upload flow renders", () => {
    render(<AddObjectDialog {...baseProps({ uploadDisabledReason: null })} />);
    openUploadTab();

    expect(screen.getByText("Drag images here")).toBeTruthy();
    expect(
      screen.queryByText("Uploading is unavailable until the convenor upgrades the site."),
    ).toBeNull();
  });

  it("uploadDisabledReason set: the reason shows in place of the upload flow — tab stays visible, not hidden", () => {
    render(
      <AddObjectDialog
        {...baseProps({
          uploadDisabledReason: "Uploading is unavailable until the convenor upgrades the site.",
        })}
      />,
    );

    // The tab is still offered (canUpload is still true) — not hidden.
    // Two matches expected: the button row and the small-viewport <select>.
    expect(screen.getAllByText("Upload image")).toHaveLength(2);

    openUploadTab();

    expect(
      screen.getByText("Uploading is unavailable until the convenor upgrades the site."),
    ).toBeTruthy();
    // The functional upload flow is not rendered — nothing to pick a file with.
    expect(screen.queryByText("Drag images here")).toBeNull();
  });

  it("names where the remedy is when it is one the reader can perform", () => {
    // A site behind the latest release: the person can run the upgrade
    // themselves, so the notice carries the way there rather than only the
    // reason.
    render(
      <MemoryRouter>
        <AddObjectDialog
          {...baseProps({
            uploadDisabledReason: "Uploading files needs a Telar upgrade first.",
            uploadDisabledAction: { href: "/upgrade?from=/objects", label: "Upgrade the site" },
          })}
        />
      </MemoryRouter>,
    );
    openUploadTab();

    const link = screen.getByRole("link", { name: "Upgrade the site" });
    expect(link.getAttribute("href")).toBe("/upgrade?from=/objects");
  });

  it("offers no link when the remedy is someone else's", () => {
    render(
      <AddObjectDialog
        {...baseProps({
          uploadDisabledReason: "Ask the convenor to upgrade the site.",
          uploadDisabledAction: null,
        })}
      />,
    );
    openUploadTab();

    expect(screen.queryByRole("link")).toBeNull();
  });
});

// The upload action's own refusal carries its remedy. The notice
// above comes from the load that drew the page; a site that fell behind after
// it is refused by the action while the loader data still says current.
describe("AddObjectDialog — the upload action's refusal", () => {
  const t = (key: string) => (key === "upload_upgrade_link" ? "Upgrade the site" : key);

  beforeEach(() => localStorage.clear());

  function renderRefused(code: string) {
    // Loader data saying current: no notice, so the upload flow is offered.
    const notice = describeUploadNotice(uploadNotice({ needsUpgrade: false, upgradeAwaitsConvenor: false }), t);
    render(
      <MemoryRouter>
        <AddObjectDialog
          {...baseProps({
            uploadDisabledReason: notice.reason,
            uploadDisabledAction: notice.action,
            uploadError: `refused: ${code}`,
            uploadErrorAction: describeUploadRefusalAction(code, t),
          })}
        />
      </MemoryRouter>,
    );
    openUploadTab();
  }

  it("links to the upgrade after an upgrade_required answer with no notice showing", () => {
    renderRefused("upgrade_required");

    expect(screen.getByText("Drag images here")).toBeTruthy();
    expect(screen.getByText("refused: upgrade_required")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Upgrade the site" });
    expect(link.getAttribute("href")).toBe("/upgrade?from=/objects");
  });

  for (const code of ["upgrade_awaits_convenor", "release_unknown", "stale_head"]) {
    it(`offers no link after ${code}`, () => {
      renderRefused(code);

      expect(screen.getByText(`refused: ${code}`)).toBeTruthy();
      expect(screen.queryByRole("link")).toBeNull();
    });
  }
});
