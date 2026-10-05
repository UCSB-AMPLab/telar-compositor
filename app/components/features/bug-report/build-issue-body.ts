/**
 * This file is the helper that turns the user form + auto-captured
 * payload into the Markdown body of a GitHub bug-report issue.
 *
 * Opted-out items (empty form fields, env rows whose key appears in
 * `removed`, each recent error whose `errorItemKey` is in `removed`, and
 * the whole errors block when `removed` includes "errors" or no error is
 * left) are omitted entirely — never
 * rendered as empty headers.
 *
 * The repository is the exception: it is written whenever the payload
 * carries one, whatever `removed` holds, private repositories included,
 * because a report that cannot be traced to a site cannot be acted on.
 * It is the body's first line, ahead of the free text, so the URL
 * builder's truncation of a long description cannot cut it.
 *
 * In `mode === "post-crash"` only the FIRST heading switches to
 * "What were you doing when this happened?". Everything else
 * identical.
 *
 * `payload` is treated as read-only; we never spread, assign, or
 * mutate it. Tests assert byte-equivalence of
 * `JSON.stringify(payload)` before/after the call.
 *
 * @version v1.5.0-beta
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
  /** Active project's GitHub repo, "owner/name" — identifies which site/install
   *  a report came from (absent when the reporter has no active project, e.g.
   *  some post-crash contexts). */
  repoFullName?: string;
  buildSha: string;
  environment: string;
  browser: string;
  viewport: string;
  locale: string;
  timestamp: string;
  errors: ReadonlyArray<CapturedError>;
  /** The name GitHub gives the repository now, present only when it differs
   *  from `repoFullName`. */
  githubFullName?: string;
  /** The site's `telar_version` as the Compositor holds it. */
  telarVersion?: string;
  /** Present, and true, only when the repository has commits the Compositor
   *  did not make. */
  headDiverged?: true;
  /** The session's most recent failed publish on this site: its code and
   *  time only, never the server's message. */
  lastPublishFailure?: { error: string; at: string };
};

/** The answers the recent-changes question offers, in the order shown. */
export const RECENT_CHANGES = [
  "renamed",
  "edited",
  "settings",
  "upgraded",
  "none",
  "unsure",
] as const;
export type RecentChange = (typeof RECENT_CHANGES)[number];

/** Issue-body wording of each answer. English, as the rest of the body is. */
const RECENT_CHANGE_TEXT: Record<RecentChange, string> = {
  renamed: "I renamed my repository on GitHub or moved it to another account",
  edited: "I edited files directly on GitHub",
  settings: "I changed the repository's settings or permissions",
  upgraded: "I upgraded Telar",
  none: "None of these",
  unsure: "I'm not sure",
};

export type FormInput = {
  whatHappened: string;
  expected: string;
  steps: string;
  recentChanges?: ReadonlyArray<RecentChange>;
};

const FOOTER =
  "<sub>Submitted via the in-app bug reporter. Items the reporter removed before sending are not included.</sub>";

/** Maintainer GitHub login, @-mentioned in every report so it notifies them
 *  even when filed by someone without permission to be set as an assignee. */
const MAINTAINER = "juancobo";

/** The attachment key of the recent error at `index`, shared by the panel's
 *  list and the body so a removal in one is honoured by the other. */
export function errorItemKey(index: number): string {
  return `error-${index}`;
}

export function buildIssueBody(
  form: FormInput,
  payload: Payload,
  removed: ReadonlySet<string>,
  mode: "default" | "post-crash",
): string {
  const sections: string[] = [];

  if (payload.repoFullName) {
    sections.push(`**Repository:** ${repoLink(payload.repoFullName)}`);
  }

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
  const recent = RECENT_CHANGES.filter((c) => form.recentChanges?.includes(c));
  if (recent.length > 0) {
    sections.push(
      `### Did any of these happen recently?\n${recent
        .map((c) => `- ${RECENT_CHANGE_TEXT[c]}`)
        .join("\n")}`,
    );
  }

  // --- separator
  sections.push("---");

  // Environment table — skip rows whose key is in `removed` (do not mutate
  // payload; build a filtered view).
  const envRows = environmentRows(payload, removed);
  if (envRows.length > 0) {
    const tableLines = ["### Environment", "", "| | |", "|---|---|"];
    for (const [k, v] of envRows) tableLines.push(`| ${k} | ${v} |`);
    sections.push(tableLines.join("\n"));
  }

  // Recent errors — fenced code block; each one the reporter removed is left
  // out, and the section with them when none is left.
  const keptErrors = removed.has("errors")
    ? []
    : payload.errors.filter((_, i) => !removed.has(errorItemKey(i)));
  if (keptErrors.length > 0) {
    const errLines = ["### Recent errors", "", "```"];
    for (const e of keptErrors) {
      errLines.push(e.message);
      if (e.stack) errLines.push(e.stack);
    }
    errLines.push("```");
    sections.push(errLines.join("\n"));
  }

  // Notify the maintainer so reports don't sit unseen.
  sections.push(`_cc @${MAINTAINER}_`);

  // Footer.
  sections.push(FOOTER);

  return sections.join("\n\n");
}

function repoLink(fullName: string): string {
  return `[${fullName}](https://github.com/${fullName})`;
}

/** The Environment table's rows, each left out when `removed` names it. */
function environmentRows(
  payload: Payload,
  removed: ReadonlySet<string>,
): Array<[string, string]> {
  const candidates: Array<[string, string, string | undefined]> = [
    ["url", "URL", `\`${payload.url}\``],
    [
      "githubName",
      "Current repository name",
      payload.githubFullName ? repoLink(payload.githubFullName) : undefined,
    ],
    [
      "telarVersion",
      "Site's Telar version",
      payload.telarVersion ? `\`${payload.telarVersion}\`` : undefined,
    ],
    [
      "headDiverged",
      "Changes outside the Compositor",
      payload.headDiverged
        ? "The repository has commits the Compositor didn't make"
        : undefined,
    ],
    [
      "lastPublishError",
      "Last publish error",
      payload.lastPublishFailure
        ? `\`${payload.lastPublishFailure.error}\` at ${payload.lastPublishFailure.at}`
        : undefined,
    ],
    ["buildSha", "App version", `\`${payload.buildSha}\` (${payload.environment})`],
    ["browser", "Browser", payload.browser],
    ["viewport", "Viewport", payload.viewport],
    ["locale", "Locale", `\`${payload.locale}\``],
    ["timestamp", "Reported at", payload.timestamp],
  ];
  const rows: Array<[string, string]> = [];
  for (const [key, label, value] of candidates) {
    if (value !== undefined && !removed.has(key)) rows.push([label, value]);
  }
  return rows;
}
