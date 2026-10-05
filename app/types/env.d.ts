/**
 * Cloudflare Workers environment bindings.
 *
 * Secrets are set via `wrangler secret put` or `.dev.vars` for local dev.
 * See wrangler.jsonc for binding names.
 *
 * @version v1.5.0-beta
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

  /**
   * The framework release this deployment upgrades sites to, named by its
   * GitHub tag. Absent or empty means the newest published release, which is
   * the state production runs in. A tag pins every upgrade-target decision to
   * that one release, prereleases included, so a staging deployment can
   * rehearse an upgrade against a release candidate.
   */
  TELAR_RELEASE_TAG?: string;

  /** Durable Object namespace for per-project collaborative editing */
  COLLABORATION: DurableObjectNamespace;

  /**
   * The deployed version's identity, from Wrangler's `version_metadata`
   * binding. Optional because a configuration without the binding is a
   * configuration the code still has to run under: the diagnostic reports a
   * null build rather than refusing.
   */
  CF_VERSION_METADATA?: { id: string; tag: string; timestamp: string };

  /** Optional password gate for collaboration features (omit or empty to disable) */
  COLLAB_GATE?: string;


  /**
   * Password admitting a session to the course feature — creating and
   * running courses, never joining one. Set on staging, absent in
   * production: an absent or empty value is the closed state, so no
   * session can unlock the feature on a deployment that has not been
   * given a password. Read only by `app/lib/course-gate.server.ts`.
   */
}
