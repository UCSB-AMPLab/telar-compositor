// @vitest-environment jsdom
/**
 * The commit-and-build modal reports a registration the committing action
 * already made, and a build that decides only whether the tiles exist
 *.
 *
 * A cancelled or failed build used to leave the objects unregistered and
 * offered "Discard changes" over a commit that had landed; a skipped build
 * ended on Done, which marked the objects' tiles as made. These cases hold
 * the modal to: no registration of its own except the retry, a failed build
 * reported over objects that are there, readiness only from a build that
 * succeeded, and a retry that resumes the build's progress.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ComponentProps } from "react";
import { render, screen, fireEvent } from "@testing-library/react";

/** The data each of the modal's three fetchers answers, in call order. */
const fetcherData: [unknown, unknown, unknown] = [undefined, undefined, undefined];
const submits: Array<Record<string, string>> = [];
let calls = 0;

vi.mock("react-router", () => ({
  // Renders its `to` as an attribute, which is what the cases read.
  Link: ({ children, ...rest }: { children?: unknown; [key: string]: unknown }) => (
    <a {...(rest as object)}>{children as never}</a>
  ),
  useFetcher: () => {
    const index = calls % 3;
    calls += 1;
    return {
      submit: (data: Record<string, string>) => submits.push(data),
      state: "idle",
      data: fetcherData[index],
    };
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

import { CommitAndBuildModal } from "~/components/features/objects/CommitAndBuildModal";

const pending = [{ object_id: "a-title", title: "A Title", featured: false, image_available: false }] as never;

function renderUpload(overrides: Record<string, unknown> = {}) {
  const props = {
    open: true,
    sheetsEnabled: false,
    urlMismatch: null,
    pendingObjects: pending,
    skipCommit: true,
    dispatchRunId: 11,
    dispatchHtmlUrl: "https://gh/run/11",
    registration: { ok: true },
    projectId: 42,
    onClose: vi.fn(),
    onBuildSuccess: vi.fn(),
    onBuildFailed: vi.fn(),
    onRegistered: vi.fn(),
    ...overrides,
  };
  const view = render(<CommitAndBuildModal {...(props as unknown as ComponentProps<typeof CommitAndBuildModal>)} />);
  const rerender = (next: Record<string, unknown> = {}) => {
    Object.assign(props, next);
    view.rerender(<CommitAndBuildModal {...(props as unknown as ComponentProps<typeof CommitAndBuildModal>)} />);
  };
  return { props, rerender };
}

function concluded(conclusion: string) {
  fetcherData[1] = {
    ok: true,
    intent: "poll-build",
    buildStatus: "completed",
    buildConclusion: conclusion,
    buildUrl: "https://gh/run/11",
    runId: 11,
    phases: null,
  };
}

const registrationPosts = () => submits.filter((s) => s.intent === "insert-pending-objects");

beforeEach(() => {
  fetcherData[0] = fetcherData[1] = fetcherData[2] = undefined;
  submits.length = 0;
  calls = 0;
});

describe("an upload whose objects the action registered", () => {
  it("confirms the registration, naming its objects, and tracks the build without registering again", () => {
    const { props } = renderUpload();
    expect(props.onRegistered).toHaveBeenCalledTimes(1);
    expect(props.onRegistered).toHaveBeenCalledWith(pending);
    expect(screen.getByText("commitModal.buildingHeading")).toBeTruthy();
    expect(registrationPosts()).toEqual([]);
  });

  it.each(["cancelled", "failure"])("reports a %s build over objects that are added, with Close", (conclusion) => {
    const { props, rerender } = renderUpload();
    concluded(conclusion);
    rerender();
    expect(screen.getByText("commitModal.addedBuildUnfinishedHeading")).toBeTruthy();
    expect(screen.queryByText("commitModal.discardChanges")).toBeNull();
    fireEvent.click(screen.getByText("commitModal.close"));
    expect(props.onBuildFailed).toHaveBeenCalled();
    expect(registrationPosts()).toEqual([]);
  });

  it("marks the tiles made only when the build succeeded", () => {
    const { props, rerender } = renderUpload();
    concluded("success");
    rerender();
    fireEvent.click(screen.getByText("commitModal.done"));
    expect(props.onBuildSuccess).toHaveBeenCalledWith(true);
  });

  it("marks nothing made when no build was dispatched, and posts nothing", () => {
    const { props } = renderUpload({ dispatchRunId: null, dispatchHtmlUrl: null });
    fireEvent.click(screen.getByText("commitModal.done"));
    expect(props.onBuildSuccess).toHaveBeenCalledWith(false);
    expect(registrationPosts()).toEqual([]);
  });
});

describe("an upload whose registration failed after its commit", () => {
  it("offers the retry, naming the operation, for the committed project, and resumes the running build when it lands", () => {
    const { props, rerender } = renderUpload({ registration: { ok: false, error: "insert_failed", operationId: 31 } });
    expect(screen.getByText("commitModal.insertFailedHeading")).toBeTruthy();
    fireEvent.click(screen.getByText("commitModal.insertRetry"));
    expect(registrationPosts()).toHaveLength(1);
    expect(registrationPosts()[0].projectId).toBe("42");
    // The operation, not the objects: the server finishes only what is owed.
    expect(registrationPosts()[0].operationId).toBe("31");
    expect(registrationPosts()[0]).not.toHaveProperty("pendingObjects");

    fetcherData[2] = { ok: true, intent: "insert-pending-objects" };
    rerender();
    expect(props.onRegistered).toHaveBeenCalledTimes(1);
    expect(screen.getByText("commitModal.buildingHeading")).toBeTruthy();
  });
});

describe("an objects commit whose registration failed", () => {
  it("retries the operation the commit named", () => {
    const { rerender } = renderUpload({ skipCommit: false, registration: null, projectId: null, dispatchRunId: null });
    fireEvent.click(screen.getByText("commitModal.confirm"));
    fetcherData[0] = {
      ok: true, intent: "commit-objects", newHeadSha: "sha-1", projectId: 42, operationId: 44,
      registration: { ok: false, error: "insert_failed", operationId: 44 }, dispatchRunId: 12, dispatchFailed: false,
    };
    rerender();
    fireEvent.click(screen.getByText("commitModal.insertRetry"));
    expect(registrationPosts()[0]).toMatchObject({ operationId: "44", projectId: "42" });
  });
});

describe("the detail page's tile build, with no objects", () => {
  it("posts no registration when the dispatch returned no run", () => {
    renderUpload({ pendingObjects: [], registration: null, projectId: null, dispatchRunId: null });
    expect(registrationPosts()).toEqual([]);
  });

  it("reports a failed build with the build's own heading", () => {
    const { rerender } = renderUpload({ pendingObjects: [], registration: null, projectId: null });
    concluded("failure");
    rerender();
    expect(screen.getByText("buildFailed")).toBeTruthy();
  });
});

const polls = () => submits.filter((s) => s.intent === "poll-build");

describe("reopening for a second upload", () => {
  it("never polls the first upload's build, and a late answer for it is dropped", () => {
    const first = renderUpload({ registration: { ok: false, error: "insert_failed" } });
    expect(polls().map((p) => p.runId)).toEqual(["11"]);
    first.rerender({ open: false });

    const second = [{ object_id: "second", title: "Second", featured: false, image_available: false }];
    submits.length = 0;
    first.rerender({ open: true, pendingObjects: second, registration: { ok: true }, dispatchRunId: null, dispatchHtmlUrl: null });
    expect(polls()).toEqual([]);
    expect(first.props.onRegistered).toHaveBeenLastCalledWith(second);

    // The first build's success arrives late.
    concluded("success");
    first.rerender();
    fireEvent.click(screen.getByText("commitModal.done"));
    expect(first.props.onBuildSuccess).toHaveBeenCalledWith(false);
  });

  it("drops an answer for another run while tracking this one", () => {
    const { props, rerender } = renderUpload();
    fetcherData[1] = {
      ok: true, intent: "poll-build", buildStatus: "completed", buildConclusion: "success",
      buildUrl: null, runId: 99, phases: null,
    };
    rerender();
    expect(screen.getByText("commitModal.buildingHeading")).toBeTruthy();
    expect(props.onBuildSuccess).not.toHaveBeenCalled();
  });
});

describe("the objects commit", () => {
  it("takes the commit's registration and tracks its build", () => {
    const { props, rerender } = renderUpload({ skipCommit: false, registration: null, projectId: null, dispatchRunId: null });
    fireEvent.click(screen.getByText("commitModal.confirm"));
    expect(submits.at(-1)?.intent).toBe("commit-objects");

    fetcherData[0] = {
      ok: true, intent: "commit-objects", newHeadSha: "sha-1", projectId: 42,
      registration: { ok: true }, dispatchRunId: 12, dispatchFailed: false,
    };
    rerender();
    expect(props.onRegistered).toHaveBeenCalledWith(pending);
    expect(screen.getByText("commitModal.buildingHeading")).toBeTruthy();
    expect(polls().at(-1)?.sha).toBe("sha-1");
    expect(registrationPosts()).toEqual([]);

    // The first answer names run 12; a later answer for the same commit names
    // run 13, and is still this commit's build.
    fetcherData[1] = { ok: true, intent: "poll-build", buildStatus: "in_progress", buildConclusion: null, buildUrl: null, runId: 12, phases: null };
    rerender();
    fetcherData[1] = { ok: true, intent: "poll-build", buildStatus: "completed", buildConclusion: "success", buildUrl: null, runId: 13, phases: null };
    rerender();
    fireEvent.click(screen.getByText("commitModal.done"));
    expect(props.onBuildSuccess).toHaveBeenCalledWith(true);
  });
});

// The commit action refuses on a site behind the latest release, or
// when the release cannot be read, before it writes anything.
describe("a commit refused for the site's release", () => {
  function refusedWith(error: string) {
    const view = renderUpload({ skipCommit: false, registration: null, projectId: null, dispatchRunId: null });
    fireEvent.click(screen.getByText("commitModal.confirm"));
    fetcherData[0] = { ok: false, intent: "commit-objects", error };
    view.rerender();
  }

  it("names an upgrade and links to it", () => {
    refusedWith("upgrade_required");
    expect(screen.getByText("repo_write_upgrade_required")).toBeTruthy();
    expect(screen.getByText("upload_upgrade_link").closest("a")?.getAttribute("to")).toBe("/upgrade?from=/objects");
  });

  it("names the convenor, with no link, for a collaborator who cannot complete the upgrade", () => {
    refusedWith("upgrade_awaits_convenor");
    expect(screen.getByText("repo_write_upgrade_awaits_convenor")).toBeTruthy();
    expect(screen.queryByText("upload_upgrade_link")).toBeNull();
  });

  it("says the release cannot be read, with no link", () => {
    refusedWith("release_unknown");
    expect(screen.getByText("repo_write_release_unknown")).toBeTruthy();
    expect(screen.queryByText("upload_upgrade_link")).toBeNull();
  });
});

describe("a build poll refused because another tab switched sites", () => {
  it("closes the dialog rather than leave it tracking a build it can no longer hear", () => {
    fetcherData[1] = { ok: false, intent: "poll-build", error: "site_changed", currentSiteName: "owner/other" };
    const { props } = renderUpload();
    expect(props.onClose).toHaveBeenCalled();
  });
});

describe("a build poll that failed in transit", () => {
  it("keeps tracking the build, does not close or fail it, and takes the next answer", () => {
    const { props, rerender } = renderUpload();
    fetcherData[1] = { ok: false, intent: "poll-build", reason: "unreachable" };
    rerender();
    expect(screen.getByText("commitModal.buildingHeading")).toBeTruthy();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onBuildFailed).not.toHaveBeenCalled();
    concluded("success");
    rerender();
    fireEvent.click(screen.getByText("commitModal.done"));
    expect(props.onBuildSuccess).toHaveBeenCalled();
  });
});

describe("Confirm before the pre-commit check has answered", () => {
  const commitPosts = () => submits.filter((s) => s.intent === "commit-objects");

  it("cannot commit until a check has answered, and then commits with the site's Sheets flag", () => {
    const { rerender } = renderUpload({ skipCommit: false, registration: null, projectId: null, dispatchRunId: null, checkPending: true });
    const confirm = screen.getByText("commitModal.confirm").closest("button")!;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(commitPosts()).toEqual([]);

    rerender({ checkPending: false, sheetsEnabled: true });
    const ready = screen.getByText("commitModal.confirm").closest("button")!;
    expect(ready.disabled).toBe(false);
    fireEvent.click(ready);
    expect(commitPosts()).toHaveLength(1);
    expect(commitPosts()[0].disableSheets).toBe("true");
  });
});
