/**
 * A story card's cover is the object the site shows for the story's first
 * content step.
 *
 * A step naming `map` shows, on the published site, the object written
 * `map.jpg` (the framework strips an image extension from both before it
 * matches them), so the cover is that object: its id as written, whether it
 * has an image, and its source, which tells the card whether the object is
 * external and so has no address under the site's tiles.
 *
 * D1 is the repository's migration chain in memory.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "~/db/schema";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";
import { loadHomepageEditorData } from "~/lib/homepage-editor-data.server";

const PROJECT_ID = 42;
let memory: MemoryD1;

function addObject(id: number, objectId: string, sourceUrl: string | null): void {
  memory.raw
    .prepare("INSERT INTO objects (id, project_id, object_id, order_key, title, image_available, source_url) VALUES (?, ?, ?, ?, 'T', 1, ?)")
    .run(id, PROJECT_ID, objectId, `a${id}`, sourceUrl);
}

beforeEach(() => {
  memory = createMemoryD1();
  memory.raw.exec(
    "INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) " +
      "VALUES (7, 7, 'u', 'e', 'e', '2099-01-01', '2099-01-01')",
  );
  memory.raw.exec(`INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (${PROJECT_ID}, 7, 'owner/repo', 5)`);
  memory.raw.exec(
    `INSERT INTO project_config (project_id, url, baseurl, telar_version) VALUES (${PROJECT_ID}, 'https://example.org', '/site', '1.7.0')`,
  );
  memory.raw.exec(`INSERT INTO stories (id, project_id, story_id, title, "order", order_key) VALUES (1, ${PROJECT_ID}, 's1', 'S', 0, 'a1')`);
  memory.raw.exec("INSERT INTO steps (id, story_id, step_number, order_key, kind, object_id) VALUES (1, 1, 1, 's1', 'media', 'map')");
});

afterEach(() => {
  memory.close();
});

async function covers() {
  const db = drizzle(asD1(memory), { schema });
  const data = await loadHomepageEditorData(db as never, { id: PROJECT_ID });
  return data.storyCoverMap;
}

describe("a story card's cover", () => {
  it("is the object map.jpg for a first step naming map", async () => {
    addObject(10, "map.jpg", null);
    expect(await covers()).toEqual({
      1: { thumbnail: null, objectId: "map.jpg", imageAvailable: true, sourceUrl: null },
    });
  });

  it("carries an external object's source", async () => {
    addObject(10, "map.jpg", "https://iiif.example.org/map.jpg/manifest.json");
    expect((await covers())[1]).toMatchObject({ objectId: "map.jpg", sourceUrl: "https://iiif.example.org/map.jpg/manifest.json" });
  });

  it("is the later of two rows the site reads as one", async () => {
    addObject(10, "map", null);
    addObject(11, "map.jpg", null);
    expect((await covers())[1]).toMatchObject({ objectId: "map.jpg" });
  });
});
