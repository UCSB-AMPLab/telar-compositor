/**
 * This file is the helper that turns a Markdown body into a
 * prefilled GitHub new-issue URL.
 *
 * Repo target is hardcoded across all environments. Bodies past
 * ~7800 bytes are truncated with a LITERAL `<!-- body truncated -->`
 * marker so we never silently drop content. Truncation is enforced
 * on TWO budgets:
 *   1. raw body byte length ≤ MAX_BODY_BYTES
 *   2. final URL byte length ≤ MAX_URL_BYTES (catches the
 *      percent-encoding expansion of multi-byte unicode — a
 *      7800-byte emoji body expands to ~23 KB once URL-encoded)
 *
 * Title is preserved across both passes — it's a single short
 * summary line and the body is the variable-length payload, so the
 * body is the one we trim when we run out of URL budget.
 *
 * `labels=bug` is the default label.
 *
 * @version v1.2.0-beta
 */

const ISSUE_URL = "https://github.com/UCSB-AMPLab/telar-compositor/issues/new";
const TRUNCATION_MARKER = "<!-- body truncated -->";
const MAX_BODY_BYTES = 7800;
const MAX_URL_BYTES = 8000;
const DEFAULT_TITLE_MAX_LEN = 80;

function makeUrl(body: string, title?: string): string {
  const params = new URLSearchParams({ body, labels: "bug" });
  if (title) params.set("title", title);
  return `${ISSUE_URL}?${params.toString()}`;
}

export function buildIssueUrl(body: string, title?: string): string {
  const encoder = new TextEncoder();
  const markerSuffix = `\n${TRUNCATION_MARKER}`;
  const markerSuffixBytes = encoder.encode(markerSuffix).length;

  let safeBody = body;
  let truncated = encoder.encode(safeBody).length > MAX_BODY_BYTES;

  // Pass 1: enforce raw body byte budget.
  if (truncated) {
    const limit = MAX_BODY_BYTES - markerSuffixBytes;
    while (encoder.encode(safeBody).length > limit) {
      safeBody = safeBody.slice(0, -64);
      if (safeBody.length === 0) break;
    }
  }

  let url = makeUrl(truncated ? `${safeBody}${markerSuffix}` : safeBody, title);

  // Pass 2: enforce URL byte budget — catches percent-encoding blow-up when
  // the body is mostly multi-byte unicode (each emoji becomes %F0%9F%90%9B…).
  while (encoder.encode(url).length > MAX_URL_BYTES) {
    truncated = true;
    safeBody = safeBody.slice(0, -64);
    if (safeBody.length === 0) {
      url = makeUrl(TRUNCATION_MARKER, title);
      break;
    }
    url = makeUrl(`${safeBody}${markerSuffix}`, title);
  }

  return url;
}

/**
 * deriveIssueTitle — turn the user's first textarea answer into a short,
 * single-line GitHub issue title. Empty input returns "" so callers can
 * conditionally omit the param.
 */
export function deriveIssueTitle(
  input: string,
  maxLen = DEFAULT_TITLE_MAX_LEN,
): string {
  const firstLine = input.split(/\r?\n/)[0] ?? "";
  return firstLine.trim().slice(0, maxLen).trim();
}
