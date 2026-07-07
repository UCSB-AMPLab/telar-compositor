/**
 * Shared upload types used by both client and server code.
 *
 * Extracted from the (now-removed) UploadImageDialog component so its
 * remaining consumers (AddObjectDialog, the objects route) can keep
 * importing the payload shape without pulling in dead component code.
 */

/** Payload confirmed for a single self-hosted image upload. */
export interface UploadImageConfirmPayload {
  file: File;
  objectId: string;
  title: string;
  creator: string;
  description: string;
  source: string;
  credit: string;
  period: string;
  year: string;
  altText: string;
}
