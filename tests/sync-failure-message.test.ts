/**
 * The full-sync dialog's failure message for every error code the full-sync
 * routes answer: a code with a message maps to its key, and any other code,
 * carrying the server's text or not, shows the general sync failure message
 * and none of that text.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import { syncFailureMessage } from "~/components/features/dashboard/SyncConfirmModal";

const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key} ${JSON.stringify(opts)}` : key);
const GENERAL = "objects:sync_error_toast";

describe("syncFailureMessage", () => {
  it.each([
    ["objects_not_added", {}, "objects:sync_not_added"],
    ["entries_refused", { message: "sync apply refused: entries {x}" }, "sync_modal.error_entries_refused"],
    ["inserts_not_added", {}, "sync_modal.error_terms_not_added"],
  ])("maps %s to its key", (error, extra, key) => {
    expect(syncFailureMessage({ error, ...extra }, t)).toBe(key);
  });

  it("names the sheet and the file a sync could not read", () => {
    expect(syncFailureMessage({ error: "sheet_unreadable", sheet: "a.csv" }, t)).toBe('sync_modal.error_sheet_unreadable {"sheet":"a.csv"}');
    expect(syncFailureMessage({ error: "file_unreadable", file: "_config.yml" }, t)).toBe('sync_modal.error_file_unreadable {"file":"_config.yml"}');
  });

  it("names the list of ignored stories when a sync could not read it", () => {
    expect(syncFailureMessage({ error: "ignore_list_unreadable", message: "raw" }, t)).toBe("sync_modal.error_ignore_list_unreadable");
  });

  it.each([
    "apply_failed",
    "sync_failed",
    "no_project",
    "missing_changes",
    "invalid_changes",
    "accept_divergence_failed",
    "a_code_nobody_mapped",
  ])("shows the general message for %s, never the server's text", (error) => {
    const message = "ingest-sync failed: DO returned 500";
    const shown = syncFailureMessage({ error, message }, t);
    expect(shown).toBe(GENERAL);
    expect(shown).not.toContain("ingest-sync");
  });

  it("shows the general message when a refusal's detail is missing, rather than the code", () => {
    expect(syncFailureMessage({ error: "colliding_columns" }, t)).toBe(GENERAL);
    expect(syncFailureMessage({ error: "sheet_unreadable" }, t)).toBe(GENERAL);
    expect(syncFailureMessage({ error: "file_unreadable" }, t)).toBe(GENERAL);
  });

  it("shows the unknown-error message for an answer with no code, such as an unreachable one", () => {
    expect(syncFailureMessage({ reason: "unreachable", message: "raw text" } as never, t)).toBe("unknown_error");
  });
});
