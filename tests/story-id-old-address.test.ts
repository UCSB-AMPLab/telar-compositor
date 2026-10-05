/**
 * An address carrying an ID a story held before still opens the story. The
 * editor's loader looks a story up by the ID in the address; when no story of
 * the active project holds it, the project's record of earlier IDs
 * (`story_previous_ids`) names the row that held it, and the loader redirects
 * to that row's current ID, keeping the query. A live story at the ID is
 * opened, never redirected.
 *
 * Run against SQLite with the repository's migrations.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const active = vi.hoisted(() => ({ projectId: 7 }));

vi.mock("~/lib/active-project.server", () => ({
  resolveActiveProjectFromRequest: async () => ({
    project: { id: active.projectId, github_repo_full_name: "o/a" },
    userRole: "convenor",
  }),
}));
vi.mock("~/lib/panel-preview-config.server", () => ({
  readPanelPreviewConfig: () => Promise.resolve(null),
}));

import { loader } from "../app/routes/_app.stories.$storyId";
import { userContext } from "~/middleware/auth.server";
import { createMemoryD1, asD1, type MemoryD1 } from "./helpers/d1-memory";

let memory: MemoryD1;

function seed(): void {
  memory.raw.exec("INSERT INTO users (id, github_id, github_login, encrypted_access_token, encrypted_refresh_token, access_token_expires_at, refresh_token_expires_at) VALUES (1, 1, 'u', 'e', 'e', '2099-01-01', '2099-01-01')");
  memory.raw.exec("INSERT INTO projects (id, user_id, github_repo_full_name, installation_id) VALUES (7, 1, 'o/a', 1), (8, 1, 'o/b', 1)");
}

function addStory(projectId: number, storyId: string): number {
  const row = memory.raw
    .prepare('INSERT INTO stories (project_id, story_id, "order", order_key) VALUES (?, ?, 0, ?) RETURNING id')
    .get(projectId, storyId, `a${storyId}`) as { id: number };
  return row.id;
}

function recordEarlierId(projectId: number, storyId: string, rowId: number): void {
  memory.raw
    .prepare("INSERT INTO story_previous_ids (project_id, story_id, story_row_id, recorded_at) VALUES (?, ?, ?, '2026-10-03T00:00:00.000Z')")
    .run(projectId, storyId, rowId);
}

async function open(storyId: string, search = ""): Promise<{ thrown: Response | null; data: unknown }> {
  const context = {
    get: (key: unknown) => (key === userContext ? { id: 1, encrypted_access_token: "e" } : undefined),
    cloudflare: { env: { DB: asD1(memory) } },
  };
  return loader({
    request: new Request(`https://x.test/stories/${storyId}${search}`),
    params: { storyId },
    context,
  } as never).then(
    (data) => ({ thrown: null, data }),
    (thrown: unknown) => ({ thrown: thrown as Response, data: null }),
  );
}

beforeEach(() => {
  memory = createMemoryD1();
  seed();
  active.projectId = 7;
});
afterEach(() => { memory.close(); });

describe("the editor loader at a story's earlier address", () => {
  it("redirects to the story's current ID, keeping the open step and layer", async () => {
    recordEarlierId(7, "blank_template", addStory(7, "fluidity"));

    const { thrown } = await open("blank_template", "?step=2&layer=1");

    expect(thrown?.status).toBe(302);
    expect(thrown?.headers.get("Location")).toBe("/stories/fluidity?step=2&layer=1");
  });

  it("follows the record of the active project only", async () => {
    recordEarlierId(8, "blank_template", addStory(8, "fluidity"));

    const { thrown } = await open("blank_template");

    expect(thrown?.status).toBe(404);
  });

  it("opens a live story at the ID rather than redirecting to the row that held it before", async () => {
    recordEarlierId(7, "blank_template", addStory(7, "fluidity"));
    const live = addStory(7, "blank_template");

    const { thrown, data } = await open("blank_template");

    expect(thrown).toBeNull();
    expect((data as { story: { id: number } }).story.id).toBe(live);
  });

  it("answers Not Found for an ID no story of the project holds or held", async () => {
    addStory(7, "fluidity");

    const { thrown } = await open("blank_template");

    expect(thrown?.status).toBe(404);
  });
});
