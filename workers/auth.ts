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
 * @version v1.2.0-beta
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

    // Check session expiry if present in the payload
    const expires = payload["expires"] as string | undefined;
    if (expires && new Date(expires) < new Date()) return null;

    // Fallback: reject tokens older than 7 days (matches cookie maxAge)
    const createdAt = payload["createdAt"] as string | undefined;
    if (createdAt && Date.now() - new Date(createdAt).getTime() > 7 * 24 * 60 * 60 * 1000) {
      return null;
    }

    // Extract userId — React Router stores it under the key used in the session
    const userId = payload["userId"] as number | undefined;
    if (typeof userId !== "number") return null;

    return userId;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal-marker signing/verification for the worker -> DO /reset flow.
// Internal-marker auth: workers/app.ts signs a HMAC marker the DO recomputes; the DO
// rejects direct reaches that don't carry a fresh signed marker.
// ---------------------------------------------------------------------------

export interface SignedInternalMarker {
  sigHex: string;
  timestamp: number;
}

/**
 * Sign an internal marker for `ws-reset:<projectId>:<timestamp>` with the
 * provided secret. Returns the hex-encoded HMAC and the timestamp (seconds)
 * the worker entry should send as headers.
 */
export async function signInternalMarker(
  projectId: number,
  secret: string,
): Promise<SignedInternalMarker> {
  const timestamp = Math.floor(Date.now() / 1000);
  const message = `ws-reset:${projectId}:${timestamp}`;
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
 * Verify a signed internal marker as forwarded to the DO. Reads the three
 * headers `X-Internal-Auth`, `X-Internal-Timestamp`, `X-Internal-Project`
 * from the request, recomputes the HMAC over `ws-reset:<project>:<ts>`, and
 * checks that the timestamp is within `maxAgeSeconds` of `now()`.
 *
 * Returns null if the marker is valid; otherwise a `Response` with the
 * appropriate 401 status the caller can return directly.
 */
export async function verifyInternalMarker(
  request: Request,
  secret: string,
  maxAgeSeconds = 30,
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
  const message = `ws-reset:${proj}:${tsNum}`;
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
