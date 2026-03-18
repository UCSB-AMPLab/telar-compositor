/**
 * Unit tests for objects-related utilities.
 *
 * Tests cover:
 *   - deriveStatus: all four status values
 *   - generateUniqueObjectSlug: no collision, and -2 suffix on collision
 */

import { describe, it, expect, vi } from "vitest";
import { deriveStatus } from "~/lib/iiif-types";
import { generateUniqueObjectSlug } from "~/lib/slugify";

// ---------------------------------------------------------------------------
// deriveStatus
// ---------------------------------------------------------------------------

describe("deriveStatus", () => {
  it("returns 'missing_from_repo' when missing_from_repo is true (highest priority)", () => {
    const status = deriveStatus({
      title: "X",
      image_available: true,
      missing_from_repo: true,
    });
    expect(status).toBe("missing_from_repo");
  });

  it("returns 'ready' when title present, tiles present, not missing", () => {
    const status = deriveStatus({
      title: "X",
      image_available: true,
      missing_from_repo: false,
    });
    expect(status).toBe("ready");
  });

  it("returns 'no_metadata' when title is null", () => {
    const status = deriveStatus({
      title: null,
      image_available: true,
      missing_from_repo: false,
    });
    expect(status).toBe("no_metadata");
  });

  it("returns 'image_missing' when title is present but image_available is false", () => {
    const status = deriveStatus({
      title: "X",
      image_available: false,
      missing_from_repo: false,
    });
    expect(status).toBe("image_missing");
  });
});

// ---------------------------------------------------------------------------
// generateUniqueObjectSlug
// ---------------------------------------------------------------------------

describe("generateUniqueObjectSlug", () => {
  it("returns the base slug when there is no collision", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as unknown as Parameters<typeof generateUniqueObjectSlug>[2];

    const slug = await generateUniqueObjectSlug("codex-mendoza", 1, mockDb);
    expect(slug).toBe("codex-mendoza");
  });

  it("appends -2 when the base slug already exists", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi
        .fn()
        .mockResolvedValue([{ object_id: "codex-mendoza" }]),
    } as unknown as Parameters<typeof generateUniqueObjectSlug>[2];

    const slug = await generateUniqueObjectSlug("codex-mendoza", 1, mockDb);
    expect(slug).toBe("codex-mendoza-2");
  });

  it("increments suffix until a free slot is found", async () => {
    const mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([
        { object_id: "portrait" },
        { object_id: "portrait-2" },
        { object_id: "portrait-3" },
      ]),
    } as unknown as Parameters<typeof generateUniqueObjectSlug>[2];

    const slug = await generateUniqueObjectSlug("portrait", 1, mockDb);
    expect(slug).toBe("portrait-4");
  });
});
