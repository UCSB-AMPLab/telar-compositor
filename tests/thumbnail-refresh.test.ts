/**
 * An external object's stored thumbnail that fails to load is replaced by the
 * manifest's current one, so a corrected manifest heals the object.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi } from "vitest";
import { refreshedThumbnail } from "~/lib/thumbnail-refresh.server";

const manifest = (thumbnail: string | undefined) =>
  vi.fn(async () => ({ ok: true as const, metadata: { thumbnail } }) as never);

describe("refreshedThumbnail", () => {
  it("returns the manifest's thumbnail when it differs from the stored one", async () => {
    const fetchManifest = manifest("https://iiif.example/img/full/200,/0/default.jpg");

    expect(
      await refreshedThumbnail({ source_url: "https://iiif.example/manifest", thumbnail: "https://iiif.example/img/full/150,/0/default.jpg" }, fetchManifest),
    ).toBe("https://iiif.example/img/full/200,/0/default.jpg");
    expect(fetchManifest).toHaveBeenCalledWith("https://iiif.example/manifest");
  });

  it("returns null when the manifest still advertises the stored thumbnail", async () => {
    const same = "https://iiif.example/img/full/150,/0/default.jpg";

    expect(await refreshedThumbnail({ source_url: "https://iiif.example/manifest", thumbnail: same }, manifest(same))).toBeNull();
  });

  it("returns null when the manifest cannot be read or names no thumbnail, and for an object with no source", async () => {
    const failing = vi.fn(async () => ({ ok: false, error: "network_error" }) as never);

    expect(await refreshedThumbnail({ source_url: "https://iiif.example/manifest", thumbnail: "x" }, failing)).toBeNull();
    expect(await refreshedThumbnail({ source_url: "https://iiif.example/manifest", thumbnail: "x" }, manifest(undefined))).toBeNull();
    expect(await refreshedThumbnail({ source_url: null, thumbnail: "x" }, manifest("y"))).toBeNull();
  });
});
