/**
 * This file pins the session store of the last failed publish: empty until a
 * failure is recorded, holding only the most recent one, keeping the code, the
 * time and the project and nothing else, and answering only for the project the
 * failure happened on.
 *
 * @version v1.5.0-beta
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  recordPublishFailure,
  getLastPublishFailure,
  __resetPublishFailureForTests,
} from "../app/lib/publish-failure-capture";

beforeEach(() => {
  __resetPublishFailureForTests();
});

describe("publish-failure-capture", () => {
  it("holds nothing before a failure", () => {
    expect(getLastPublishFailure(7)).toBeNull();
  });

  it("keeps the code, the time and the project, and nothing else", () => {
    recordPublishFailure("publish_failed", 7);
    const failure = getLastPublishFailure(7);
    expect(Object.keys(failure ?? {}).sort()).toEqual(["at", "error", "projectId"]);
    expect(failure?.error).toBe("publish_failed");
    expect(failure?.projectId).toBe(7);
    expect(Number.isNaN(Date.parse(failure?.at ?? ""))).toBe(false);
  });

  it("keeps only the most recent failure", () => {
    recordPublishFailure("publish_failed", 7);
    recordPublishFailure("stale_head", 7);
    expect(getLastPublishFailure(7)?.error).toBe("stale_head");
  });

  it("answers only for the project the failure happened on", () => {
    recordPublishFailure("publish_failed", 7);
    expect(getLastPublishFailure(8)).toBeNull();
    expect(getLastPublishFailure(undefined)).toBeNull();
  });
});
