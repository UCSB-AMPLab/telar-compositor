// @vitest-environment jsdom
/**
 * Tests for `ChecksMayBeBehindNotice`, the line under the Publish page's
 * checks. It shows only for a finished check whose snapshot did not reach D1,
 * and not on a page that cannot read the site's state or whose check failed.
 *
 * i18n is a key-passthrough, so assertions key off the translation key.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ChecksMayBeBehindNotice } from "~/components/features/publish/ChecksMayBeBehindNotice";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

const BEHIND = { ok: true, intent: "run-validation", snapshotOk: false };

function show(result: Parameters<typeof ChecksMayBeBehindNotice>[0]["result"], stateUnreadable = false, validationFailed = false) {
  render(<ChecksMayBeBehindNotice result={result} stateUnreadable={stateUnreadable} validationFailed={validationFailed} />);
}

describe("ChecksMayBeBehindNotice", () => {
  it("shows for a finished check whose snapshot did not reach D1", () => {
    show(BEHIND);
    expect(screen.getByText("checks.may_be_behind")).toBeTruthy();
  });

  it("is absent when the snapshot reached D1", () => {
    show({ ...BEHIND, snapshotOk: true });
    expect(screen.queryByText("checks.may_be_behind")).toBeNull();
  });

  it("is absent before any check has answered", () => {
    show(undefined);
    expect(screen.queryByText("checks.may_be_behind")).toBeNull();
  });

  it("is absent for a failed answer and for another intent", () => {
    show({ ...BEHIND, ok: false });
    show({ ...BEHIND, intent: "publish" });
    expect(screen.queryByText("checks.may_be_behind")).toBeNull();
  });

  it("is absent when the page cannot read the site's state", () => {
    show(BEHIND, true);
    expect(screen.queryByText("checks.may_be_behind")).toBeNull();
  });

  it("is absent when the check itself failed", () => {
    show(BEHIND, false, true);
    expect(screen.queryByText("checks.may_be_behind")).toBeNull();
  });
});
