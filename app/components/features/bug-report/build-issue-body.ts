/**
 * This file is the helper that turns the user form + auto-captured
 * payload into the Markdown body of a GitHub bug-report issue.
 *
 * Opted-out items (empty form fields, env rows whose key appears in
 * `removed`, the whole errors block when `removed` includes
 * "errors" or the array is empty) are omitted entirely — never
 * rendered as empty headers.
 *
 * In `mode === "post-crash"` only the FIRST heading switches to
 * "What were you doing when this happened?". Everything else
 * identical.
 *
 * `payload` is treated as read-only; we never spread, assign, or
 * mutate it. Tests assert byte-equivalence of
 * `JSON.stringify(payload)` before/after the call.
 *
 * @version v1.2.0-beta
 */

export type CapturedError = {
  type: "error" | "unhandledrejection" | "boundary";
  message: string;
  stack?: string;
  timestamp: string;
  route?: string;
};

export type Payload = {
  url: string;
  buildSha: string;
  environment: string;
  browser: string;
  viewport: string;
  locale: string;
  timestamp: string;
  errors: ReadonlyArray<CapturedError>;
};

export type FormInput = {
  whatHappened: string;
  expected: string;
  steps: string;
};

const FOOTER =
  "<sub>Submitted via the in-app bug reporter. Items the reporter removed before sending are not included.</sub>";

export function buildIssueBody(
  form: FormInput,
  payload: Payload,
  removed: ReadonlySet<string>,
  mode: "default" | "post-crash",
): string {
  const sections: string[] = [];

  // First heading switches in post-crash mode.
  const firstHeading =
    mode === "post-crash"
      ? "### What were you doing when this happened?"
      : "### What happened?";
  sections.push(`${firstHeading}\n${form.whatHappened.trim()}`);

  // Optional sections — omit entirely if empty.
  if (form.expected.trim()) {
    sections.push(`### What did you expect?\n${form.expected.trim()}`);
  }
  if (form.steps.trim()) {
    sections.push(`### Steps to reproduce\n${form.steps.trim()}`);
  }

  // --- separator
  sections.push("---");

  // Environment table — skip rows whose key is in `removed` (do not mutate
  // payload; build a filtered view).
  const envRows: Array<[string, string]> = [];
  if (!removed.has("url")) envRows.push(["URL", `\`${payload.url}\``]);
  if (!removed.has("buildSha")) {
    envRows.push([
      "App version",
      `\`${payload.buildSha}\` (${payload.environment})`,
    ]);
  }
  if (!removed.has("browser")) envRows.push(["Browser", payload.browser]);
  if (!removed.has("viewport")) envRows.push(["Viewport", payload.viewport]);
  if (!removed.has("locale")) envRows.push(["Locale", `\`${payload.locale}\``]);
  if (!removed.has("timestamp")) {
    envRows.push(["Reported at", payload.timestamp]);
  }

  if (envRows.length > 0) {
    const tableLines = ["### Environment", "", "| | |", "|---|---|"];
    for (const [k, v] of envRows) tableLines.push(`| ${k} | ${v} |`);
    sections.push(tableLines.join("\n"));
  }

  // Recent errors — fenced code block; skip whole section if empty or removed.
  if (!removed.has("errors") && payload.errors.length > 0) {
    const errLines = ["### Recent errors", "", "```"];
    for (const e of payload.errors) {
      errLines.push(e.message);
      if (e.stack) errLines.push(e.stack);
    }
    errLines.push("```");
    sections.push(errLines.join("\n"));
  }

  // Footer.
  sections.push(FOOTER);

  return sections.join("\n\n");
}
