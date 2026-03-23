/**
 * Upload constants shared between client and server.
 *
 * Extracted from upload.server.ts so they can be imported by client
 * components without pulling in server-only dependencies (githubHeaders,
 * StaleHeadError) through tree-shaking boundaries.
 *
 * Exports:
 *   - ACCEPTED_TYPES: Set of allowed MIME types
 *   - MAX_SIZE_BYTES: maximum allowed file size (25 MB)
 */

/**
 * Accepted image MIME types for upload.
 * Validated client-side before upload and server-side before commit.
 */
export const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/tiff"]);

/**
 * Maximum allowed file size in bytes (25 MB).
 * A 25 MB file encoded as base64 is ~33 MB — within the 128 MB CF Workers memory limit.
 */
export const MAX_SIZE_BYTES = 25 * 1024 * 1024;
