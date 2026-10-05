/**
 * Upload constants shared between client and server.
 *
 * Separate from upload.server.ts so client components can import them without
 * pulling in server-only dependencies (githubHeaders, StaleHeadError) through
 * tree-shaking boundaries.
 *
 * Which file types may be uploaded is not here: it is one of the three
 * questions `~/lib/file-types` answers, and client and server both read
 * UPLOAD_ACCEPTED_MIME_TYPES from there.
 *
 * Exports:
 *   - MAX_SIZE_BYTES: maximum allowed file size (25 MB)
 *
 * @version v1.5.0-beta
 */

/**
 * Maximum allowed file size in bytes (25 MB).
 * A 25 MB file encoded as base64 is ~33 MB — within the 128 MB CF Workers memory limit.
 */
export const MAX_SIZE_BYTES = 25 * 1024 * 1024;
