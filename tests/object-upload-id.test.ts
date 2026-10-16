/**
 * The ID of a newly uploaded object: the characters typing keeps and the ID an
 * upload starts from. The dialog and the upload action read these same
 * functions, so the cases here are the contract between them.
 *
 * @version v1.5.5-beta
 */

import { describe, it, expect } from "vitest";
import { filterTypedUploadId, settleUploadId, uploadIdFor } from "~/lib/object-upload-id";

describe("filterTypedUploadId", () => {
  it.each([
    ["Mission Bell", "mission-bell"],
    ["mission-bell", "mission-bell"],
    ["IMG_0042", "img-0042"],
    ["Mapa de Santafé", "mapa-de-santafe"],
    ["a #2", "a-2"],
    ["a  --  b", "a-b"],
    ["中文", ""],
  ])("keeps %j as %j", (typed, kept) => {
    expect(filterTypedUploadId(typed)).toBe(kept);
  });

  it("keeps a trailing hyphen, so typing the next word is not undone", () => {
    expect(filterTypedUploadId("mission-")).toBe("mission-");
  });
});

describe("settleUploadId", () => {
  it("drops a hyphen at either end", () => {
    expect(settleUploadId("-mission-bell-")).toBe("mission-bell");
  });

  it("is unchanged by a second settling, so the action leaves a dialog-made ID alone", () => {
    const once = settleUploadId("  Mapa de Santafé #2 ");
    expect(settleUploadId(once)).toBe(once);
  });
});

describe("uploadIdFor", () => {
  it("uses the typed ID when it settles to something", () => {
    expect(uploadIdFor("my-map", "Another title")).toBe("my-map");
  });

  it("falls back to the title's slug when the field is blank or keeps nothing", () => {
    expect(uploadIdFor("", "Mission Bell")).toBe("mission-bell");
    expect(uploadIdFor("中文", "Mission Bell")).toBe("mission-bell");
  });

  it("falls back to object when neither keeps a character", () => {
    expect(uploadIdFor("", "中文")).toBe("object");
  });
});
