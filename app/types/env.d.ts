/**
 * Cloudflare Workers environment bindings.
 *
 * Secrets are set via `wrangler secret put` or `.dev.vars` for local dev.
 * See wrangler.jsonc for binding names.
 */

declare interface Env {
  /** D1 database binding */
  DB: D1Database;

  /** GitHub App OAuth credentials */
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  GITHUB_CALLBACK_URL: string;

  /** GitHub App identity (for installation access tokens) */
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;

  /** AES-256 key for token encryption (64-char hex, 32 bytes) */
  ENCRYPTION_KEY: string;

  /** Cookie session secret */
  SESSION_SECRET: string;

  /** Runtime environment identifier */
  ENVIRONMENT: string;

  /** GitHub App URL slug (e.g. "telar-compositor") */
  GITHUB_APP_SLUG: string;

  /** Durable Object namespace for per-project collaborative editing */
  COLLABORATION: DurableObjectNamespace;

  /** Optional password gate for collaboration features (omit or empty to disable) */
  COLLAB_GATE?: string;
}
