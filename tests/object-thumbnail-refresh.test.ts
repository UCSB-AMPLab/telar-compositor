/**
 * A refreshed thumbnail reaches the live document, so the snapshot that
 * follows does not write the old one back to D1.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { writeObjectThumbnail } from "~/lib/object-thumbnail-refresh";

describe("writeObjectThumbnail", () => {
  it("ends with the object's Y.Map holding the new thumbnail", () => {
    const ydoc = new Y.Doc();
    const entry = new Y.Map<unknown>();
    entry.set("_id", 9);
    entry.set("thumbnail", "https://iiif.example/old.jpg");
    ydoc.getArray<Y.Map<unknown>>("objects").push([entry]);

    expect(writeObjectThumbnail(ydoc, 9, "https://iiif.example/new.jpg")).toBe(true);
    expect(entry.get("thumbnail")).toBe("https://iiif.example/new.jpg");
  });

  it("reports false when the document has no entry for the object", () => {
    expect(writeObjectThumbnail(new Y.Doc(), 9, "https://iiif.example/new.jpg")).toBe(false);
    expect(writeObjectThumbnail(null, 9, "https://iiif.example/new.jpg")).toBe(false);
  });
});
