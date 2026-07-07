/**
 * stories-editor-remote-delete-generic.test.ts — pins the remote-delete
 * toast contract in the Story Editor route (`_app.stories.$storyId.tsx`).
 *
 * A Y.Array delete carries no actor, and awareness only reports who is
 * connected — not who deleted. So both remote-delete toasts here (the active
 * step disappearing, and the parent story disappearing) must stay generic:
 * they use `toast_item_deleted_generic` ("{label} was deleted") and never name
 * a collaborator via the `{name}`-bearing `toast_item_deleted` key.
 *
 * The step toast must also carry no Undo affordance: the shared UndoManager
 * tracks only local origins (see app/lib/undo-manager.ts), so a remote
 * collaborator's delete never enters this client's undo stack and a button
 * wired to it would be a no-op. The prior convenor-only action with an empty
 * onClick was reachable dead UI; it is gone.
 *
 * The route module breaks vitest suite collection when imported (server-only
 * deps in its import graph), so these are source-level assertions against the
 * file text — the same idiom as tests/story-url-sync.test.tsx.
 *
 * @version v1.4.1-beta
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE_SRC = readFileSync(
  join(process.cwd(), "app/routes/_app.stories.$storyId.tsx"),
  "utf8",
);

// The two remote-delete effects live between these anchors. Slicing keeps the
// assertions scoped to the delete-detection region and away from unrelated
// toast usage elsewhere in the file.
const REGION = ROUTE_SRC.slice(
  ROUTE_SRC.indexOf("Remote-delete detection for steps and parent story"),
  ROUTE_SRC.indexOf("For step 0, show step 1's object"),
);

describe("story editor remote-delete toasts stay generic", () => {
  it("locates the remote-delete region", () => {
    expect(REGION.length).toBeGreaterThan(0);
  });

  it("uses the generic key for both the step and the parent-story toast", () => {
    const generic = REGION.match(/toast_item_deleted_generic/g) ?? [];
    expect(generic.length).toBe(2);
  });

  it("never uses the name-bearing toast_item_deleted key", () => {
    // The exact key is always followed by `",` (its interpolation object);
    // `toast_item_deleted_generic` is followed by `_generic"`, so this regex
    // matches only the misattributing variant.
    expect(REGION).not.toMatch(/toast_item_deleted",/);
  });

  it("never reads a collaborator name to attribute the delete", () => {
    expect(REGION).not.toContain("deleterName");
    expect(REGION).not.toContain("remoteCollaboratorsRef");
    expect(REGION).not.toContain(".user.name");
  });

  it("offers no Undo affordance on the remote-delete step toast", () => {
    expect(REGION).not.toContain("toast_item_deleted_undo");
    // No convenor-gated toast action survives in this region.
    expect(REGION).not.toContain('userRole === "convenor"');
    expect(REGION).not.toContain("action:");
  });
});

describe("the retired locale keys have no remaining consumers", () => {
  it("no source file still references toast_item_deleted or toast_item_deleted_undo", () => {
    // Whole-file check on the route that was their last consumer. The exact
    // key call is `tStructural("toast_item_deleted", ...)`; the `",` lookahead
    // excludes the still-used `toast_item_deleted_generic`.
    expect(ROUTE_SRC).not.toMatch(/toast_item_deleted",/);
    expect(ROUTE_SRC).not.toContain("toast_item_deleted_undo");
  });
});
