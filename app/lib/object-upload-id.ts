/**
 * The ID of a newly uploaded object: what the upload dialog lets an author
 * type, and what the upload action keeps. Both read the same functions, so the
 * ID the dialog shows is the ID it submits and the ID the action starts from.
 *
 * An ID holds lowercase letters, digits and hyphens. An accented letter is
 * typed as its plain form, and a space or underscore as a hyphen. It becomes
 * the object's page address and the file name of its image, which is why
 * nothing else survives.
 *
 * @version v1.5.5-beta
 */

import { slugify } from "~/lib/slugify";

/** The characters an ID keeps, applied on every keystroke: hyphens stay, so typing one is never undone. */
export function filterTypedUploadId(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-");
}

/** The typed text as an ID: filtered, with no hyphen at either end. */
export function settleUploadId(typed: string): string {
  return filterTypedUploadId(typed).replace(/^-+|-+$/g, "");
}

/**
 * The ID an upload starts from. A blank or unusable one falls back to the
 * title's slug, then to "object" for a title with no letters or digits the
 * slug keeps.
 */
export function uploadIdFor(typed: string, title: string): string {
  return settleUploadId(typed) || slugify(title) || "object";
}
