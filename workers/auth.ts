/**
 * This file holds the shared auth helpers for the worker entry and
 * the Collaboration Durable Object.
 *
 * Both `workers/app.ts` and `workers/collaboration.ts` need to read
 * the `__compositor_session` cookie and resolve it to a userId.
 * Keeping these helpers in a single module avoids duplication and
 * keeps the cookie format (React Router's HMAC-signed
 * `<base64url(JSON)>.<base64url(HMAC)>` shape) defined in one
 * place.
 *
 * Extracted from `workers/collaboration.ts` so the
 * `/ws/:projectId/reset` route in `workers/app.ts` can gate by
 * session + project membership before forwarding to the DO.
 *
 * Also holds `isProjectId` and `parseCanonicalProjectId`: the worker entry
 * names the collaboration Durable Object from a raw URL path segment
 * (`idFromName` hashes whatever string it is given), while the DO itself
 * re-derives the same id from that segment to gate membership and bind its
 * own identity. Both reads have to agree on which strings count as a
 * project id, or the two layers can be talking about different objects
 * for the "same" project — kept here, imported by both, so there is one
 * definition to agree with rather than two to keep in sync.
 *
 * @version v1.5.0-beta
 */

/**
 * Parse the `__compositor_session` cookie value out of a Cookie header.
 * Returns the URL-decoded raw token, or null if absent.
 */
export function parseSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)__compositor_session=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * A project id: a POSITIVE safe integer. Zero is not a row any project has,
 * and a value outside the safe-integer range cannot round-trip through
 * storage or a query parameter without loss.
 */
export function isProjectId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * Parse a raw `/ws/:projectId` (or `/ws/:projectId/reset`) URL path segment,
 * accepting ONLY the canonical decimal form of a project id: digits only, no
 * leading zero, no sign, no surrounding whitespace, and nothing `Number`
 * would round off or round-trip differently.
 *
 * `idFromName` hashes its input as an opaque string, so "2", "02" and "2abc"
 * each name a DIFFERENT Durable Object. A lenient parse would blur that:
 * `parseInt` reads a leading run of digits and stops, so `parseInt("2abc")`
 * is `2` and `parseInt("02")` is `2` — both would be treated as project 2
 * even though neither is the canonical spelling. `Number`, by contrast,
 * requires the ENTIRE string to be numeric, so `Number("2abc")` is `NaN`
 * (which happens to fail on its own) while `Number("02")` is still `2`.
 * Requiring `^[1-9][0-9]*$` and rejecting a segment whose value doesn't
 * round-trip through `String(Number(segment))` closes both parsers' gaps at
 * once, so exactly one spelling is ever accepted, regardless of which
 * lenient parser a future edit might reach for.
 */
export function parseCanonicalProjectId(segment: string | null | undefined): number | null {
  if (segment === null || segment === undefined) return null;
  if (!/^[1-9][0-9]*$/.test(segment)) return null;
  const value = Number(segment);
  if (String(value) !== segment) return null;
  return isProjectId(value) ? value : null;
}

/** Server-side session lifetime window — matches the cookie maxAge (7 days). */
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Shared server-side session-lifetime guard, used by BOTH auth paths (the
 * websocket auth in getUserIdFromToken below AND the HTTP auth middleware) so a
 * token's enforceable lifetime is checked identically everywhere.
 *
 * A session is valid only when it carries an enforceable lifetime that has not
 * elapsed:
 *   - past an explicit `expires`            -> invalid
 *   - `createdAt` older than the 7-day window -> invalid
 *   - NEITHER field present                  -> invalid (fail closed: no
 *     enforceable lifetime means a copied/leaked cookie would live forever)
 *
 * Stamping `createdAt` at login (see app/routes/_auth.callback.tsx) is what
 * makes legitimate tokens satisfy this; legacy tokens minted before that get a
 * one-time clean logout.
 */
export function isSessionLifetimeValid(
  createdAt: string | undefined,
  expires: string | undefined,
  now: number = Date.now(),
): boolean {
  if (expires && new Date(expires).getTime() < now) return false;
  if (createdAt && now - new Date(createdAt).getTime() > SESSION_MAX_AGE_MS) return false;
  if (!expires && !createdAt) return false;
  return true;
}

/**
 * Validate a React Router cookie session token and return the userId.
 *
 * The token is the raw value of the `__compositor_session` cookie. React
 * Router's `createCookieSessionStorage` produces HMAC-signed cookies in the
 * format `<base64url(JSON payload)>.<base64url(HMAC-SHA256 signature)>`.
 *
 * Returns the userId on success; null on missing/invalid/expired token, or
 * any parse/verify failure.
 */
export async function getUserIdFromToken(
  token: string,
  secret: string,
): Promise<number | null> {
  try {
    const lastDot = token.lastIndexOf(".");
    if (lastDot === -1) return null;

    const payloadB64 = token.slice(0, lastDot);
    const sigB64 = token.slice(lastDot + 1);

    // Verify HMAC-SHA256 signature
    const keyData = new TextEncoder().encode(secret);
    const key = await crypto.subtle.importKey(
      "raw",
      keyData,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );

    const signedData = new TextEncoder().encode(payloadB64);
    const signature = base64urlDecode(sigB64);

    const valid = await crypto.subtle.verify("HMAC", key, signature, signedData);
    if (!valid) return null;

    // Decode payload
    const payloadJson = new TextDecoder().decode(base64urlDecode(payloadB64));
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;

    // Enforce the session lifetime via the shared guard (same rule the HTTP
    // auth middleware applies): reject past-expiry, >7-day-old, or
    // lifetime-less tokens.
    const expires = payload["expires"] as string | undefined;
    const createdAt = payload["createdAt"] as string | undefined;
    if (!isSessionLifetimeValid(createdAt, expires)) return null;

    // Extract userId — React Router stores it under the key used in the session
    const userId = payload["userId"] as number | undefined;
    if (typeof userId !== "number") return null;

    return userId;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal-marker signing/verification.
//
// Originally the worker -> DO /reset flow: workers/app.ts signs a HMAC
// marker the DO recomputes; the DO rejects direct reaches that don't carry
// a fresh signed marker. The same op/projectId/userId binding, plus the
// optional `detail` hash below, also binds a payload a client round-trips
// through the browser to the context it was produced in (see
// _app.upgrade.tsx's upgrade-prepare/upgrade-commit) — a signature minted
// for one project, user, or payload cannot verify against another.
// ---------------------------------------------------------------------------

export interface SignedInternalMarker {
  sigHex: string;
  timestamp: number;
}

/**
 * Build the canonical marker message bound to a single internal operation and
 * target. Both sign and verify derive the message through this one function so
 * the binding can never drift between the two sides.
 *
 * Shape: `<op>:<projectId>:<userId ?? "-">:<timestamp>`, or with `detail` ---
 * `<op>:<projectId>:<userId ?? "-">:<timestamp>:<detail>`.
 *
 * The userId is stringified so a number `5` mints `"5"` — the same string the
 * verifying side reads back from a `?userId=5` query param via
 * `URLSearchParams.get`. Operations with no per-user target use the literal
 * `"-"` on both sides. `detail` is omitted from the message entirely when not
 * given, so every existing caller's signed shape is unchanged; a caller that
 * does pass it (a hash covering a payload the marker is meant to bind) makes
 * a signature minted over one payload unable to verify against another.
 */
function internalMarkerMessage(
  op: string,
  projectId: number | string,
  userId: number | string | null | undefined,
  timestamp: number,
  detail?: string,
): string {
  const userPart = userId === null || userId === undefined ? "-" : String(userId);
  const base = `${op}:${projectId}:${userPart}:${timestamp}`;
  return detail === undefined ? base : `${base}:${detail}`;
}

/**
 * Sign an internal marker bound to a single operation and (optional) user
 * target with the provided secret. Returns the hex-encoded HMAC and the
 * timestamp (seconds) the worker entry should send as headers.
 *
 * The marker signs `<op>:<projectId>:<userId ?? "-">:<timestamp>`, so a marker
 * minted for one op/user cannot be replayed against a different op/user within
 * the freshness window — the verifying side re-derives the same fields from its
 * own request and a mismatch produces a signature failure. Passing `detail`
 * (see internalMarkerMessage) additionally binds the marker to a specific
 * payload — a hash of it, typically — so a valid signature cannot be carried
 * over to a payload it was not minted for.
 */
export async function signInternalMarker(
  projectId: number,
  secret: string,
  op: string,
  userId?: number | string,
  detail?: string,
): Promise<SignedInternalMarker> {
  const timestamp = Math.floor(Date.now() / 1000);
  const message = internalMarkerMessage(op, projectId, userId, timestamp, detail);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  const sigHex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { sigHex, timestamp };
}

/**
 * Verify a signed internal marker. Reads the three headers `X-Internal-Auth`,
 * `X-Internal-Timestamp`, `X-Internal-Project` from the request, recomputes
 * the HMAC over `<expectedOp>:<X-Internal-Project>:<expectedUserId ?? "-">:<ts>`
 * (plus `:<expectedDetail>` when given), and checks that the timestamp is
 * within `maxAgeSeconds` of `now()`.
 *
 * The `expectedOp`, `expectedUserId` and `expectedDetail` are supplied by the
 * verifying caller from its OWN, independently-derived values (e.g. the
 * matched route, the acting user's session id, a hash it recomputes from a
 * payload in hand) — never trusted from a header or the payload itself. A
 * marker minted for a different op, user, or payload therefore recomputes to
 * a different message and fails the signature check — closing replay across
 * operations, user targets, and payloads.
 *
 * Returns null if the marker is valid; otherwise a `Response` with the
 * appropriate 401 status and a body distinguishing a stale marker (timestamp
 * outside the window) from an invalid one (signature mismatch — tampering,
 * or a marker bound to a different op/user/payload) for logging.
 */
export async function verifyInternalMarker(
  request: Request,
  secret: string,
  expectedOp: string,
  expectedUserId?: number | string | null,
  maxAgeSeconds = 30,
  expectedDetail?: string,
): Promise<Response | null> {
  const sigHex = request.headers.get("X-Internal-Auth");
  const ts = request.headers.get("X-Internal-Timestamp");
  const proj = request.headers.get("X-Internal-Project");
  if (!sigHex || !ts || !proj) {
    return new Response("Unauthorized", { status: 401 });
  }
  const tsNum = Number(ts);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > maxAgeSeconds) {
    return new Response("Stale internal marker", { status: 401 });
  }

  const sigPairs = sigHex.match(/.{1,2}/g);
  if (!sigPairs || sigPairs.length === 0) {
    return new Response("Invalid internal marker", { status: 401 });
  }
  const sigBytes = new Uint8Array(sigPairs.map((b) => parseInt(b, 16)));

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const message = internalMarkerMessage(expectedOp, proj, expectedUserId, tsNum, expectedDetail);
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(message));
  if (!ok) return new Response("Invalid internal marker", { status: 401 });
  return null;
}

/**
 * Decode a base64url-encoded string to a Uint8Array.
 * Cloudflare Workers don't have Node.js Buffer, so we use atob.
 */
function base64urlDecode(input: string): Uint8Array<ArrayBuffer> {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
