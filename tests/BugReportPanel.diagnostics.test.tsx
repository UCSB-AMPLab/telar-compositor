// @vitest-environment jsdom
/**
 * This file pins what the bug-report panel attaches about the site and what it
 * asks about recent changes: the repository is pinned and always reaches the
 * body; the site's Telar version, the outside-changes flag, the session's last
 * failed publish and the repository's current name on GitHub each appear only
 * when their source does, can be removed, and reach the body unless removed;
 * the failure and the name read are bound to the displayed project; the name
 * read never holds the panel; and the recent-changes answers reach
 * the body, with "None of these" and "I'm not sure" excluding the rest.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { BugReportPanel } from "../app/components/features/bug-report/BugReportPanel";
import { toggleRecentChange } from "../app/components/features/bug-report/RecentChangesField";
import {
  recordPublishFailure,
  __resetPublishFailureForTests as resetPublishFailure,
} from "../app/lib/publish-failure-capture";

// The remove control's aria-label carries the item's label key, so each
// control can be found by the item it removes.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && typeof opts.item === "string" ? `${key}:${opts.item}` : key,
    i18n: { language: "en" },
  }),
}));

vi.mock("~/hooks/use-toast", () => ({
  useToast: () => ({ showToast: vi.fn(), dismissToast: vi.fn() }),
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const fetchMock = vi.fn();
let openSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetPublishFailure();
  fetchMock.mockReset();
  // No answer by default: the name read is pending for the whole test.
  fetchMock.mockImplementation(() => new Promise(() => {}));
  vi.stubGlobal("fetch", fetchMock);
  openSpy = vi.spyOn(window, "open").mockImplementation(() => null as Window | null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  openSpy.mockRestore();
});

const PROJECT_ID = 7;
const REPOSITORY_LINE =
  "**Repository:** [olympia-m/my-site](https://github.com/olympia-m/my-site)";

function answerName(fullName: string | null, projectId: number = PROJECT_ID) {
  fetchMock.mockImplementation(async () =>
    new Response(JSON.stringify({ projectId, fullName }), { status: 200 }),
  );
}

type PanelProps = Partial<React.ComponentProps<typeof BugReportPanel>>;

async function renderPanel(props: PanelProps = {}) {
  const view = render(
    <BugReportPanel
      open={true}
      onClose={vi.fn()}
      mode="default"
      userLogin="testuser"
      repoFullName="olympia-m/my-site"
      projectId={PROJECT_ID}
      {...props}
    />,
  );
  // Let the name read settle when it answers.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  const details = view.container.querySelector("details");
  if (details) details.open = true;
  return view;
}

function removeControl(labelKey: string): HTMLButtonElement | null {
  return document.querySelector(
    `button[aria-label="attach_remove_aria:${labelKey}"]`,
  );
}

function hasItem(labelKey: string): boolean {
  return Array.from(document.querySelectorAll("details span.font-semibold")).some(
    (el) => el.textContent === labelKey,
  );
}

function submitBody(): string {
  fireEvent.change(screen.getByLabelText("field_what_happened_label"), {
    target: { value: "ten characters at least here" },
  });
  fireEvent.click(screen.getByRole("button", { name: /submit_button/ }));
  const [url] = openSpy.mock.calls[openSpy.mock.calls.length - 1];
  return new URL(url as string).searchParams.get("body") ?? "";
}

describe("BugReportPanel — the repository", () => {
  it("is attached with no remove control, and reaches the body", async () => {
    await renderPanel();
    expect(hasItem("attach_item_repository")).toBe(true);
    expect(removeControl("attach_item_repository")).toBeNull();
    expect(submitBody()).toContain(REPOSITORY_LINE);
  });
});

describe("BugReportPanel — the site's Telar version", () => {
  it("is attached when the loader has one, removable, and in the body unless removed", async () => {
    await renderPanel({ telarVersion: "1.7.0" });
    expect(hasItem("attach_item_telar_version")).toBe(true);
    expect(submitBody()).toContain("| Site's Telar version | `1.7.0` |");
  });

  it("stays out of the body once removed", async () => {
    await renderPanel({ telarVersion: "1.7.0" });
    fireEvent.click(removeControl("attach_item_telar_version")!);
    expect(hasItem("attach_item_telar_version")).toBe(false);
    expect(submitBody()).not.toContain("Site's Telar version");
  });

  it("is not attached without one", async () => {
    await renderPanel();
    expect(hasItem("attach_item_telar_version")).toBe(false);
    expect(submitBody()).not.toContain("Site's Telar version");
  });
});

describe("BugReportPanel — changes outside the Compositor", () => {
  it("is attached with its value only when the head diverged, and in the body", async () => {
    await renderPanel({ headDiverged: true });
    expect(hasItem("attach_item_head_diverged")).toBe(true);
    expect(screen.getByText("attach_value_head_diverged")).toBeTruthy();
    expect(submitBody()).toContain(
      "| Changes outside the Compositor | The repository has commits the Compositor didn't make |",
    );
  });

  it("stays out of the body once removed", async () => {
    await renderPanel({ headDiverged: true });
    fireEvent.click(removeControl("attach_item_head_diverged")!);
    expect(submitBody()).not.toContain("Changes outside the Compositor");
  });

  it("is not attached when the head has not diverged", async () => {
    await renderPanel({ headDiverged: false });
    expect(hasItem("attach_item_head_diverged")).toBe(false);
    expect(submitBody()).not.toContain("Changes outside the Compositor");
  });
});

describe("BugReportPanel — the last failed publish", () => {
  it("is attached with its code and time when this site recorded one, and in the body", async () => {
    recordPublishFailure("publish_failed", PROJECT_ID);
    await renderPanel();
    expect(hasItem("attach_item_last_publish_error")).toBe(true);
    expect(screen.getByText(/^publish_failed \(\d{4}-\d\d-\d\dT/)).toBeTruthy();
    expect(submitBody()).toMatch(/\| Last publish error \| `publish_failed` at \d{4}-\d\d-\d\dT[^|]*\|/);
  });

  it("is not attached to a report about another site", async () => {
    recordPublishFailure("publish_failed", PROJECT_ID + 1);
    await renderPanel();
    expect(hasItem("attach_item_last_publish_error")).toBe(false);
    expect(submitBody()).not.toContain("Last publish error");
  });

  it("stays out of the body once removed", async () => {
    recordPublishFailure("publish_failed", PROJECT_ID);
    await renderPanel();
    fireEvent.click(removeControl("attach_item_last_publish_error")!);
    expect(submitBody()).not.toContain("Last publish error");
  });

  it("is not attached when no publish failed", async () => {
    await renderPanel();
    expect(hasItem("attach_item_last_publish_error")).toBe(false);
    expect(submitBody()).not.toContain("Last publish error");
  });
});

describe("BugReportPanel — the repository's current name on GitHub", () => {
  it("asks the route about the displayed project when the panel opens", async () => {
    await renderPanel();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/repo-identity?projectId=${PROJECT_ID}`,
      expect.anything(),
    );
  });

  it("drops an answer about another project", async () => {
    answerName("someone/else", PROJECT_ID + 1);
    await renderPanel();
    expect(hasItem("attach_item_github_name")).toBe(false);
    expect(submitBody()).not.toContain("someone/else");
  });

  it("is not asked for without a project", async () => {
    await renderPanel({ projectId: undefined });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is attached when GitHub's name differs, removable, and in the body unless removed", async () => {
    answerName("olympia-m/new-site");
    await renderPanel();
    expect(hasItem("attach_item_github_name")).toBe(true);
    expect(screen.getByText("olympia-m/new-site")).toBeTruthy();
    expect(submitBody()).toContain(
      "| Current repository name | [olympia-m/new-site](https://github.com/olympia-m/new-site) |",
    );
  });

  it("stays out of the body once removed", async () => {
    answerName("olympia-m/new-site");
    await renderPanel();
    fireEvent.click(removeControl("attach_item_github_name")!);
    expect(submitBody()).not.toContain("Current repository name");
  });

  it("is not attached when the names agree", async () => {
    answerName("olympia-m/my-site");
    await renderPanel();
    expect(hasItem("attach_item_github_name")).toBe(false);
    expect(submitBody()).not.toContain("Current repository name");
  });

  it("is not asked for without a stored repository", async () => {
    await renderPanel({ repoFullName: undefined });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves the row out and still submits when the read fails", async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError("network down");
    });
    await renderPanel();
    expect(hasItem("attach_item_github_name")).toBe(false);
    const body = submitBody();
    expect(body).toContain(REPOSITORY_LINE);
    expect(body).not.toContain("Current repository name");
  });

  it("leaves the row out and still submits when the route answers an error", async () => {
    fetchMock.mockImplementation(async () => new Response("no", { status: 500 }));
    await renderPanel();
    expect(submitBody()).not.toContain("Current repository name");
  });

  it("opens and submits while the read has not answered", async () => {
    await renderPanel();
    expect(screen.getByText("panel_title")).toBeTruthy();
    expect(submitBody()).toContain(REPOSITORY_LINE);
  });

  it("gives up on a read that does not answer in time", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      fetchMock.mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              aborted = true;
              reject(new DOMException("aborted", "AbortError"));
            });
          }),
      );
      render(
        <BugReportPanel
          open={true}
          onClose={vi.fn()}
          mode="default"
          userLogin="testuser"
          repoFullName="olympia-m/my-site"
          projectId={PROJECT_ID}
        />,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(aborted).toBe(true);
      expect(hasItem("attach_item_github_name")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("BugReportPanel — recent changes", () => {
  it("asks the question after the steps field", async () => {
    await renderPanel();
    const steps = screen.getByLabelText("field_steps_label");
    const question = screen.getByText("recent_changes_label");
    expect(
      steps.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByText("recent_changes_why")).toBeTruthy();
  });

  it("sends the chosen answers to the body", async () => {
    await renderPanel();
    fireEvent.click(screen.getByLabelText("recent_change_renamed"));
    fireEvent.click(screen.getByLabelText("recent_change_upgraded"));
    expect(submitBody()).toContain(
      "### Did any of these happen recently?\n- I renamed my repository on GitHub or moved it to another account\n- I upgraded Telar",
    );
  });

  it("sends no section when nothing is chosen", async () => {
    await renderPanel();
    expect(submitBody()).not.toContain("Did any of these happen recently?");
  });

  it("clears the other answers when 'None of these' is chosen, and clears it when another is", async () => {
    await renderPanel();
    const renamed = screen.getByLabelText("recent_change_renamed") as HTMLInputElement;
    const edited = screen.getByLabelText("recent_change_edited") as HTMLInputElement;
    const none = screen.getByLabelText("recent_change_none") as HTMLInputElement;
    const unsure = screen.getByLabelText("recent_change_unsure") as HTMLInputElement;

    fireEvent.click(renamed);
    fireEvent.click(edited);
    fireEvent.click(none);
    expect([renamed.checked, edited.checked, none.checked]).toEqual([false, false, true]);

    fireEvent.click(unsure);
    expect([none.checked, unsure.checked]).toEqual([false, true]);

    fireEvent.click(edited);
    expect([unsure.checked, edited.checked]).toEqual([false, true]);
    expect(submitBody()).toContain("### Did any of these happen recently?\n- I edited files directly on GitHub");
  });
});

describe("toggleRecentChange", () => {
  it("adds, removes, and keeps the exclusive answers alone", () => {
    expect(toggleRecentChange([], "renamed")).toEqual(["renamed"]);
    expect(toggleRecentChange(["renamed"], "renamed")).toEqual([]);
    expect(toggleRecentChange(["renamed", "edited"], "unsure")).toEqual(["unsure"]);
    expect(toggleRecentChange(["none"], "settings")).toEqual(["settings"]);
    expect(toggleRecentChange(["none"], "unsure")).toEqual(["unsure"]);
  });
});
