/**
 * This file holds the last failed publish of the browser session, which the
 * bug-report panel attaches so a report filed after a failed publish says
 * which failure it followed and when.
 *
 * Only the error code, the time and the project are kept. The server's
 * message is never kept: it can quote SQL parameters and site configuration,
 * and the report is a public GitHub issue. The server logs the message
 * (`[publish] commit failed`), and the time is what lets a maintainer find
 * that entry in Workers Logs.
 *
 * The project id binds the failure to the site it happened on, so a report
 * filed for another site after a project switch does not carry it. One entry
 * is kept, the most recent, because a report is about what just went wrong.
 *
 * Storage is in-module memory only, never localStorage, for the same reason as
 * `error-capture.ts`: people sharing a device must not see each other's
 * failures.
 *
 * Browser-only — do not rename to `.server.ts`. The SSR import boundary check
 * would block this file from loading on the client, which is where it does its
 * work.
 *
 * @version v1.5.0-beta
 */

export type PublishFailure = {
  error: string;
  at: string; // ISO 8601
  projectId: number;
};

let last: PublishFailure | null = null;

export function recordPublishFailure(error: string, projectId: number): void {
  last = { error, at: new Date().toISOString(), projectId };
}

/** The last failure, when it happened on `projectId`; null otherwise. */
export function getLastPublishFailure(projectId: number | undefined): PublishFailure | null {
  return last && last.projectId === projectId ? last : null;
}

/** Test-only: reset module state. Do NOT call from production code. */
export function __resetPublishFailureForTests(): void {
  last = null;
}
