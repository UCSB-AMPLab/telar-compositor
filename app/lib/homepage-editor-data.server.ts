/**
 * loadHomepageEditorData — shared server helper that builds the
 * `HomepageEditorData` contract consumed by the `HomepageEditor` component.
 *
 * Extracted from the `_app.homepage.tsx` loader so BOTH surfaces can source
 * the same landing data:
 *   - `/homepage` and `/pages/index` (via the `_app.homepage.tsx` loader), and
 *   - the `/pages` two-column shell's pinned Home row, which reuses this
 *     helper in place.
 *
 * The v1.3.0 display-contract filtering of landing fields (null/liquid/legacy
 * → canned text / placeholder fallthrough) moved here verbatim from the
 * homepage loader. Behaviour is unchanged.
 *
 * @version v1.3.0-beta
 */

import { asc, and, eq, gt, inArray } from "drizzle-orm";
import { stories, steps, project_config, objects, project_landing } from "~/db/schema";
import type { getDb } from "~/lib/db.server";
import {
  WELCOME_BODY_LOCALISED,
  V121_FRONTMATTER_DEFAULTS,
} from "~/lib/v130-framework-labels";
import {
  isV130WelcomeLiquidBlock,
  normalizeBody,
  V121_BODIES,
} from "~/lib/v130-ingest.server";
import type { HomepageEditorData } from "~/components/features/pages/HomepageEditor";

interface ProjectLike {
  id: number;
  github_pages_url?: string | null;
  last_synced_at?: string | null;
}

export async function loadHomepageEditorData(
  db: ReturnType<typeof getDb>,
  project: ProjectLike,
): Promise<HomepageEditorData> {
  const configRows = await db
    .select()
    .from(project_config)
    .where(eq(project_config.project_id, project.id))
    .limit(1);
  const config = configRows[0] ?? null;

  const landingRows = await db
    .select()
    .from(project_landing)
    .where(eq(project_landing.project_id, project.id))
    .limit(1);
  const landingRow = landingRows[0] ?? null;

  // Display contract: a field that still holds the framework default is
  // surfaced as `null` so the editor shows its placeholder instead of editable
  // boilerplate. welcome_body follows the same rule as the other landing
  // fields — the localized canned text is shown as the MarkdownEditor's
  // `placeholder` (see HomepageEditor), never injected as content. (Injecting
  // it previously broke collaborative editing: it seeded a stale value the DO
  // snapshot then clobbered with.) The five branches below recognise every
  // "still the framework default" shape: empty, v1.3.0 liquid block, legacy
  // v1.2.1 literal, and the byte-equal v1.3.0 canned EN/ES text.
  let landing = landingRow;
  if (landingRow) {
    const welcomeBody = landingRow.welcome_body ?? "";
    const welcomeIsDefault =
      welcomeBody.trim() === "" ||
      isV130WelcomeLiquidBlock(welcomeBody) ||
      normalizeBody(welcomeBody) === normalizeBody(V121_BODIES.index) ||
      welcomeBody === WELCOME_BODY_LOCALISED.en ||
      welcomeBody === WELCOME_BODY_LOCALISED.es;
    landing = {
      ...landingRow,
      welcome_body: welcomeIsDefault ? null : landingRow.welcome_body,
      stories_heading:
        landingRow.stories_heading === V121_FRONTMATTER_DEFAULTS.stories_heading
          ? null
          : landingRow.stories_heading,
      objects_heading:
        landingRow.objects_heading === V121_FRONTMATTER_DEFAULTS.objects_heading
          ? null
          : landingRow.objects_heading,
      objects_intro:
        landingRow.objects_intro === V121_FRONTMATTER_DEFAULTS.objects_intro
          ? null
          : landingRow.objects_intro,
    };
  }

  const projectStories = await db
    .select()
    .from(stories)
    .where(eq(stories.project_id, project.id))
    .orderBy(asc(stories.order));

  const projectObjects = await db
    .select()
    .from(objects)
    .where(eq(objects.project_id, project.id));

  const siteBaseUrl = config?.url
    ? `${config.url}${config.baseurl ?? ""}`
    : null;

  // Resolve cover thumbnails for stories from their lowest content step's object
  const storyIds = projectStories.map((s) => s.id);
  const allContentSteps = storyIds.length > 0
    ? await db
        .select({ story_id: steps.story_id, step_number: steps.step_number, object_id: steps.object_id })
        .from(steps)
        .where(and(inArray(steps.story_id, storyIds), gt(steps.step_number, 0)))
        .orderBy(asc(steps.step_number))
    : [];

  const coverSteps: { story_id: number; object_id: string | null }[] = [];
  const seenStories = new Set<number>();
  for (const row of allContentSteps) {
    if (!seenStories.has(row.story_id)) {
      seenStories.add(row.story_id);
      coverSteps.push({ story_id: row.story_id, object_id: row.object_id });
    }
  }

  const storyCoverObjectIds: Record<number, string> = {};
  for (const row of coverSteps) {
    if (row.object_id) storyCoverObjectIds[row.story_id] = row.object_id;
  }

  const coverObjectIdValues = Object.values(storyCoverObjectIds);
  const coverObjects = coverObjectIdValues.length > 0
    ? await db
        .select({ object_id: objects.object_id, thumbnail: objects.thumbnail, image_available: objects.image_available })
        .from(objects)
        .where(and(eq(objects.project_id, project.id), inArray(objects.object_id, coverObjectIdValues)))
    : [];

  const objectThumbnailMap: Record<string, { thumbnail: string | null; image_available: boolean | null }> = {};
  for (const obj of coverObjects) {
    objectThumbnailMap[obj.object_id] = { thumbnail: obj.thumbnail, image_available: obj.image_available };
  }

  const storyCoverMap: Record<number, { thumbnail: string | null; objectId: string; imageAvailable: boolean | null }> = {};
  for (const [storyIdStr, objectId] of Object.entries(storyCoverObjectIds)) {
    const storyId = Number(storyIdStr);
    const objInfo = objectThumbnailMap[objectId];
    if (objInfo) {
      storyCoverMap[storyId] = { thumbnail: objInfo.thumbnail, objectId, imageAvailable: objInfo.image_available };
    }
  }

  // Step counts per story (for StoryCard display)
  const stepCountRows = storyIds.length > 0
    ? await db
        .select({ story_id: steps.story_id, count: steps.id })
        .from(steps)
        .where(and(inArray(steps.story_id, storyIds), gt(steps.step_number, 0)))
    : [];

  const storyStepCounts: Record<number, number> = {};
  for (const row of stepCountRows) {
    storyStepCounts[row.story_id] = (storyStepCounts[row.story_id] ?? 0) + 1;
  }

  return {
    project,
    config,
    landing,
    stories: projectStories,
    storyStepCounts,
    storyCoverMap,
    objects: projectObjects,
    siteBaseUrl,
  } as HomepageEditorData;
}
