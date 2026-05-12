/**
 * This file holds the redact helper — it strips a narrow class of
 * secrets from error strings before they enter the bug-report
 * capture buffer. The privacy guarantee is "user sees what's being
 * sent and can remove anything", not "we auto-scrub everything."
 *
 * Patterns:
 *   - Email-like  → <email>
 *   - GitHub PATs (gh[pousr]_…) → <github-token>
 *   - JWT-shaped → <jwt>
 *   - Bearer …  → Bearer <token>
 *
 * Order matters: JWT runs before Bearer so a Bearer-wrapped JWT
 * collapses to "Bearer <token>".
 *
 * Project IDs, story slugs, page slugs, and IIIF URLs are
 * deliberately NOT scrubbed — meaningful for debugging; user can
 * drop the URL line.
 *
 * @version v1.2.0-beta
 */

const EMAIL_RE = /\b[\w.+-]+@[\w.-]+\.\w{2,}\b/g;
const GH_TOKEN_RE = /gh[pousr]_[A-Za-z0-9]{36,}/g;
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
// Char class includes `<>` so the second pass also rewrites `Bearer <jwt>`
// (left over from the JWT pass) into `Bearer <token>`.
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=<>-]+/g;

export function redact(input: string): string {
  return input
    .replace(EMAIL_RE, "<email>")
    .replace(GH_TOKEN_RE, "<github-token>")
    .replace(JWT_RE, "<jwt>")
    .replace(BEARER_RE, "Bearer <token>");
}
