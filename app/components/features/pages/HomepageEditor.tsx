/**
 * HomepageEditor — the landing-page editor render body.
 *
 * Extracted from the homepage route so BOTH surfaces can mount the same editor:
 *   - `/homepage` and `/pages/index` (via the thin `_app.homepage.tsx` route
 *     wrapper that keeps the loader/action), and
 *   - the `/pages` two-column shell's pinned Home row.
 *
 * The route module keeps its `loader`/`action` (incl. the `requireProjectMember`
 * gate on `autosave-landing`). Only the render lives here. The `autosave-landing` /
 * `reorder` fetcher submits stay inside this component — they POST to the
 * current route's action, so the component works at whichever route mounts it.
 *
 * The component bundles the live-language observer (config.lang → placeholders),
 * the stories-showcase drag-and-drop, and the featured-objects derivation.
 *
 * @version v1.3.7-beta
 */

import { useTranslation } from "react-i18next";
import { useFetcher, useNavigate } from "react-router";
import { useState, useEffect } from "react";
import { DndContext, closestCenter, DragOverlay } from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { useSortableSensors } from "~/hooks/use-sortable-sensors";
import { ExternalLink, ArrowRight } from "lucide-react";
import { DashboardPreviewSection } from "~/components/features/dashboard/DashboardPreviewSection";
import { StoryCard } from "~/components/features/dashboard/StoryCard";
import { SortableStoryCard } from "~/components/features/dashboard/SortableStoryCard";
import { MarkdownEditor } from "~/components/ui/MarkdownEditor";
import { InlineTextField } from "~/components/ui/InlineTextField";
import { InlineTextArea } from "~/components/ui/InlineTextArea";
import { InlineHtmlEditor } from "~/components/ui/InlineHtmlEditor";
import { useIiifThumbnail } from "~/lib/use-iiif-thumbnail";
import { useCollaborationContext } from "~/hooks/use-collaboration";
import { reorderInPlace } from "~/hooks/use-structural-ops";
import { getYText } from "~/lib/yjs-helpers";
import { LANDING_LABELS, V121_FRONTMATTER_DEFAULTS, WELCOME_BODY_LOCALISED } from "~/lib/v130-framework-labels";
import * as Y from "yjs";

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

export interface HomepageStoryItem {
  id: number;
  story_id: string;
  title: string | null;
  subtitle: string | null;
  byline: string | null;
  private: boolean | null;
  draft: boolean | null;
  updated_at: string | null;
}

export interface HomepageObjectItem {
  id: number;
  object_id: string;
  title: string | null;
  creator: string | null;
  description: string | null;
  source: string | null;
  thumbnail: string | null;
  image_available: boolean | null;
  featured: boolean | null;
}

/**
 * The landing-editor data contract — exactly what the `_app.homepage.tsx`
 * loader returns and what the `/pages` shell passes for the
 * Home row. Kept loose on the nested project/config/landing rows so both the
 * route's serialized loader output and the shell can satisfy it without
 * re-importing Drizzle row types.
 */
export interface HomepageEditorData {
  project: {
    id: number;
    github_pages_url?: string | null;
    last_synced_at?: string | null;
  };
  config: {
    lang?: string | null;
    title?: string | null;
    description?: string | null;
    featured_count?: number | null;
  } | null;
  landing: {
    welcome_body?: string | null;
    stories_heading?: string | null;
    stories_intro?: string | null;
    objects_heading?: string | null;
    objects_intro?: string | null;
  } | null;
  stories: HomepageStoryItem[];
  storyStepCounts: Record<number, number>;
  storyCoverMap: Record<
    number,
    { thumbnail: string | null; objectId: string; imageAvailable: boolean | null }
  >;
  objects: HomepageObjectItem[];
  siteBaseUrl: string | null;
}

/** Per-object card that resolves IIIF thumbnails. */
function HomepageObjectCard({
  obj,
  siteBaseUrl,
}: {
  obj: HomepageObjectItem;
  siteBaseUrl: string | null;
}) {
  const { t } = useTranslation(["homepage", "common"]);
  const needsResolve = !obj.thumbnail && obj.image_available && siteBaseUrl;
  const infoJsonUrl = needsResolve
    ? `${siteBaseUrl}/iiif/objects/${obj.object_id}/info.json`
    : null;
  const resolvedUrl = useIiifThumbnail(infoJsonUrl, 300);

  const storedThumb = obj.thumbnail
    ? obj.thumbnail.replace(/\/full\/[^/]+\//, "/full/!400,400/")
    : null;
  const thumbSrc = storedThumb || resolvedUrl;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden hover:shadow-md transition-shadow">
      <div className="aspect-square bg-cream-dark">
        {thumbSrc ? (
          <img
            src={thumbSrc}
            alt={obj.title ?? t("common:untitled")}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-300 text-xs font-body">
            {t("homepage:no_image")}
          </div>
        )}
      </div>
      <div className="p-2">
        <p className="font-body text-xs text-charcoal leading-snug">
          {obj.title ?? t("common:untitled")}
        </p>
        {obj.creator && (
          <p className="font-body text-[10px] text-gray-500 mt-0.5">{obj.creator}</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HomepageEditor({ data }: { data: HomepageEditorData }) {
  const { t } = useTranslation("dashboard");
  const { t: tHome } = useTranslation("homepage");
  const navigate = useNavigate();
  const fetcher = useFetcher();
  const { ydoc } = useCollaborationContext();

  // Resolve Y.Text for config fields (title, description) and landing fields
  const configYMap = ydoc?.getMap<unknown>("config") ?? null;
  const landingYMap =
    configYMap?.get("landing") instanceof Y.Map
      ? (configYMap.get("landing") as Y.Map<unknown>)
      : null;
  const configTitleYText = getYText(configYMap as Y.Map<unknown> | null, "title");
  const configDescriptionYText = getYText(configYMap as Y.Map<unknown> | null, "description");
  const storiesHeadingYText = getYText(landingYMap, "stories_heading");
  const storiesIntroYText = getYText(landingYMap, "stories_intro");
  const objectsHeadingYText = getYText(landingYMap, "objects_heading");
  const objectsIntroYText = getYText(landingYMap, "objects_intro");
  // welcome_body is collaborative like every other landing field: edits flow
  // through this Y.Text, so the DO's snapshotToD1 persists them instead of
  // clobbering with a stale copy. The canned default is shown via the editor's
  // `placeholder` (below), not injected as content.
  const welcomeBodyYText = getYText(landingYMap, "welcome_body");

  const {
    project,
    config,
    landing,
    stories: loaderStories,
    storyStepCounts,
    storyCoverMap,
    objects: projectObjects,
    siteBaseUrl,
  } = data;

  // Site-locale (config.lang) drives the v1.3.0 framework preview content
  // and the localised landing-field placeholders, NOT the user's UI locale
  // (useTranslation). An EN compositor user editing an ES site must see the
  // Spanish framework defaults that visitors will see on the live site.
  //
  // Read the LIVE Yjs `config.lang`, not the loader snapshot.
  // The Site Settings save writes `lang` to the Yjs config map
  // (_app.config.tsx syncFormToYjs scalarStrings), so a language change must
  // re-render the landing placeholders in-session without a reload. We
  // initialise from the loader `config?.lang` fallback (no-ydoc / SSR safe),
  // then drive `liveSiteLang` from a `config.observeDeep` observer — the same
  // pattern as the title/nav observers in _app.pages.tsx.
  const [liveSiteLang, setLiveSiteLang] = useState<"en" | "es">(
    config?.lang === "es" ? "es" : "en"
  );
  useEffect(() => {
    if (!ydoc) return;
    const cfg = ydoc.getMap<unknown>("config");
    const recompute = () => {
      setLiveSiteLang(cfg.get("lang") === "es" ? "es" : "en");
    };
    recompute();
    cfg.observeDeep(recompute);
    return () => cfg.unobserveDeep(recompute);
  }, [ydoc]);

  // DnD order state (optimistic)
  const [items, setItems] = useState<number[]>(loaderStories.map((s) => s.id));
  const [activeId, setActiveId] = useState<number | null>(null);

  useEffect(() => {
    setItems(loaderStories.map((s) => s.id));
  }, [loaderStories]);

  const storyMap: Record<number, HomepageStoryItem> = {};
  for (const s of loaderStories) {
    storyMap[s.id] = s;
  }

  const sensors = useSortableSensors();

  function handleDragStart(event: DragStartEvent) {
    setActiveId(event.active.id as number);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveId(null);
    if (!over || active.id === over.id) return;

    const oldIndex = items.indexOf(active.id as number);
    const newIndex = items.indexOf(over.id as number);
    const newOrder = arrayMove(items, oldIndex, newIndex);

    setItems(newOrder);
    // Reorder the `stories` Y.Array to match. Without this the next snapshot
    // rewrites `stories.order` from the (unchanged) Y.Array index and clobbers
    // the D1 write below back to the old order. The homepage list is the full
    // stories set ordered by `order`, so these indices map 1:1 to the Y.Array.
    if (ydoc) {
      ydoc.transact(() => {
        reorderInPlace(ydoc.getArray<Y.Map<unknown>>("stories"), oldIndex, newIndex);
      });
    }
    fetcher.submit(
      { intent: "reorder", order: JSON.stringify(newOrder), projectId: String(project.id) },
      { method: "post" }
    );
  }

  const activeStory = activeId ? storyMap[activeId] : null;
  const sortedStories = items.map((id) => storyMap[id]).filter(Boolean) as HomepageStoryItem[];

  const featuredCount = config?.featured_count ?? 4;
  const featuredObjects = projectObjects.filter((o) => o.featured);
  const nonFeaturedObjects = projectObjects.filter((o) => !o.featured);
  const displayObjects = [...featuredObjects, ...nonFeaturedObjects].slice(0, featuredCount);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* View live site link */}
      {project.github_pages_url && (
        <a
          href={project.github_pages_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 font-body text-sm text-charcoal underline"
        >
          <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
          {tHome("view_live_site")}
        </a>
      )}

      {/* 1. Site Description */}
      <DashboardPreviewSection
        heading={t("preview.site_description_heading")}
        explanation={t("preview.site_description_explanation")}
      >
        <div className="space-y-3">
          <div>
            <label className="block font-heading font-semibold text-xs text-gray-400 uppercase tracking-wider mb-1">
              {tHome("title_label")}
            </label>
            <InlineTextField
              initialValue={config?.title ?? ""}
              yText={configTitleYText}
              placeholder={tHome("title_placeholder")}
              className="font-bold text-xl"
              bordered
              fieldKey="homepage-config-title"
            />
          </div>
          <div>
            <label className="block font-heading font-semibold text-xs text-gray-400 uppercase tracking-wider mb-1">
              {tHome("description_label")}
            </label>
            <InlineHtmlEditor
              initialValue={config?.description ?? ""}
              yText={configDescriptionYText}
              placeholder={tHome("description_placeholder")}
            />
          </div>
        </div>
      </DashboardPreviewSection>

      {/* 2. Welcome Message */}
      <DashboardPreviewSection
        heading={t("preview.welcome_heading")}
        explanation={t("preview.welcome_explanation")}
      >
        {/*
          v1.3.0 display contract: the loader replaces landing.welcome_body
          with the lang-pack canned text when the underlying state is
          empty/liquid-block/legacy-v121 (see loader for the three branches).
          So `initialValue` is always either user content or the canned
          markdown the live site would render — no sibling preview block
          needed.
        */}
        <MarkdownEditor
          key={`welcome-${project.id}`}
          initialValue={landing?.welcome_body ?? ""}
          fieldName="welcome_body"
          projectId={project.id}
          intent="autosave-landing"
          // Collaborative like every other landing field: edits flow through
          // this Y.Text and the DO's snapshotToD1 persists them. (Previously
          // welcome_body was the lone landing field NOT wired to Yjs, so the
          // snapshot clobbered the direct-to-D1 autosave with a stale copy.)
          yText={welcomeBodyYText}
          // The canned framework default is shown as a placeholder when empty,
          // matching how the sibling fields surface their defaults — instead of
          // injecting it as editable content. Localised to the live site lang.
          placeholder={WELCOME_BODY_LOCALISED[liveSiteLang]}
          // Non-collaborative fallback only (collab not connected): the
          // autosave POSTs to `/homepage`, the one route whose action handles
          // `autosave-landing`. Without it the fallback defaults to `/dashboard`
          // (no handler) and 400s.
          actionUrl="/homepage"
          objects={projectObjects.map((o) => ({
            object_id: o.object_id,
            title: o.title,
            thumbnail: o.thumbnail,
          }))}
        />
      </DashboardPreviewSection>

      {/* 3. Stories */}
      <DashboardPreviewSection
        heading={t("preview.stories_heading")}
        explanation={t("preview.stories_explanation")}
      >
        <div className="space-y-4">
          <div>
            <InlineTextField
              initialValue={landing?.stories_heading ?? ""}
              yText={storiesHeadingYText}
              placeholder={LANDING_LABELS[liveSiteLang].stories_heading}
              defaultValues={[V121_FRONTMATTER_DEFAULTS.stories_heading]}
              className="font-heading font-bold text-xl"
              bordered
              fieldKey="homepage-stories-heading"
            />
            {(!landing?.stories_heading || landing.stories_heading.trim() === "") && (
              <p className="mt-1 font-body text-xs italic text-charcoal/50">
                {t("preview.empty_default_hint")}
              </p>
            )}
          </div>

          <div>
            {/* Optional intro paragraph for the stories section. Unlike
                objects_intro, the framework has no default for it (index.html
                renders it only when set), so there is no defaultValues literal
                to suppress and the empty-state note says "optional", not
                "a default will show". */}
            <InlineTextArea
              initialValue={landing?.stories_intro ?? ""}
              yText={storiesIntroYText}
              placeholder={t("preview.stories_intro_placeholder")}
              defaultValues={[]}
              className="text-sm text-gray-600"
              bordered
              fieldKey="homepage-stories-intro"
            />
            {(!landing?.stories_intro || landing.stories_intro.trim() === "") && (
              <p className="mt-1 font-body text-xs italic text-charcoal/50">
                {t("preview.stories_intro_hint")}
              </p>
            )}
          </div>

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={items} strategy={rectSortingStrategy}>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {sortedStories.map((story) => (
                  <SortableStoryCard
                    key={story.id}
                    story={story}
                    stepCount={storyStepCounts[story.id] ?? 0}
                    lastSynced={project.last_synced_at ?? null}
                    coverInfo={storyCoverMap[story.id]}
                    siteBaseUrl={siteBaseUrl}
                  />
                ))}
              </div>
            </SortableContext>

            <DragOverlay>
              {activeStory && (
                <StoryCard
                  story={activeStory}
                  stepCount={storyStepCounts[activeStory.id] ?? 0}
                  lastSynced={project.last_synced_at ?? null}
                  isDragOverlay
                  coverInfo={storyCoverMap[activeStory.id]}
                  siteBaseUrl={siteBaseUrl}
                />
              )}
            </DragOverlay>
          </DndContext>

          <div className="flex items-center justify-between pt-2 border-t border-gray-100">
            <a
              href="/stories"
              className="inline-flex items-center gap-1 font-body text-sm text-anil hover:text-anil-hover transition-colors"
            >
              {t("preview.stories_manage")}
              <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </a>
            <button
              type="button"
              onClick={() => navigate("/stories?new=true")}
              className="inline-flex items-center justify-center bg-anil hover:bg-anil-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-5 py-2 transition-colors"
            >
              {t("new_story_button")}
            </button>
          </div>
        </div>
      </DashboardPreviewSection>

      {/* 4. Objects */}
      <DashboardPreviewSection
        heading={t("preview.objects_heading")}
        explanation={t("preview.objects_explanation")}
      >
        <div className="space-y-3">
          <InlineTextField
            initialValue={landing?.objects_heading ?? ""}
            yText={objectsHeadingYText}
            placeholder={LANDING_LABELS[liveSiteLang].objects_heading}
            defaultValues={[V121_FRONTMATTER_DEFAULTS.objects_heading]}
            className="font-heading font-bold text-xl"
            bordered
            fieldKey="homepage-objects-heading"
          />
          {(!landing?.objects_heading || landing.objects_heading.trim() === "") && (
            <p className="mt-1 font-body text-xs italic text-charcoal/50">
              {t("preview.empty_default_hint")}
            </p>
          )}
          <InlineTextArea
            initialValue={landing?.objects_intro ?? ""}
            yText={objectsIntroYText}
            placeholder={LANDING_LABELS[liveSiteLang].objects_intro}
            defaultValues={[V121_FRONTMATTER_DEFAULTS.objects_intro]}
            className="text-sm text-gray-600"
            bordered
            fieldKey="homepage-objects-intro"
          />
          {(!landing?.objects_intro || landing.objects_intro.trim() === "") && (
            <p className="mt-1 font-body text-xs italic text-charcoal/50">
              {t("preview.empty_default_hint")}
            </p>
          )}

          {displayObjects.length > 0 ? (
            <div className="grid grid-cols-3 md:grid-cols-5 gap-3 pt-2">
              {displayObjects.map((obj) => (
                <HomepageObjectCard key={obj.id} obj={obj} siteBaseUrl={siteBaseUrl} />
              ))}
            </div>
          ) : (
            <p className="font-body text-sm text-gray-400 italic pt-2">
              No objects yet — use the Objects tab to add images to your collection.
            </p>
          )}
        </div>
      </DashboardPreviewSection>
    </div>
  );
}
