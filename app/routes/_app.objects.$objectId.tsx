/**
 * Object detail page — IIIF viewer + metadata editor.
 *
 * Layout: two-column — viewer (left ~60%) + scrollable metadata form (right ~40%).
 * Constructs manifest URLs from project config (url + baseurl) for self-hosted
 * objects, or uses source_url directly for external IIIF objects.
 */

import { eq, and } from "drizzle-orm";
import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link, useFetcher, redirect } from "react-router";
import { ArrowLeft, Trash2 } from "lucide-react";
import type { Route } from "./+types/_app.objects.$objectId";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { objects, project_config, projects, steps, stories } from "~/db/schema";
import { createSessionStorage } from "~/lib/session.server";
import { deriveStatus } from "~/lib/iiif-types";
import { Switch } from "~/components/ui/Switch";
import { Button } from "~/components/ui/Button";
import { IiifViewer } from "~/components/features/objects/IiifViewer";

export const handle = { i18n: ["common", "objects"] };

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  // Get active project
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;

  const allProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.user_id, user.id));

  if (allProjects.length === 0) throw redirect("/onboarding");

  const activeProject =
    allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];

  // Fetch the object
  const [object] = await db
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.project_id, activeProject.id),
        eq(objects.object_id, params.objectId)
      )
    )
    .limit(1);

  if (!object) throw new Response("Not found", { status: 404 });

  // Fetch project config for site URL
  const [config] = await db
    .select()
    .from(project_config)
    .where(eq(project_config.project_id, activeProject.id))
    .limit(1);

  // Construct IIIF URLs for self-hosted objects
  const isExternal =
    object.source_url !== null &&
    (object.source_url.startsWith("http://") ||
      object.source_url.startsWith("https://"));

  let manifestUrl: string | null = null;
  let infoJsonUrl: string | null = null;

  if (isExternal) {
    manifestUrl = object.source_url;
  } else if (config?.url) {
    const base = `${config.url}${config.baseurl ?? ""}`;
    manifestUrl = `${base}/iiif/objects/${object.object_id}/manifest.json`;
    infoJsonUrl = `${base}/iiif/objects/${object.object_id}/info.json`;
  }

  // Fetch story usage for this object
  const stepRefs = await db
    .select({
      story_id: steps.story_id,
      step_number: steps.step_number,
    })
    .from(steps)
    .where(eq(steps.object_id, object.object_id));

  const storyIds = [...new Set(stepRefs.map((r) => r.story_id))];
  let storyTitles: Record<number, string | null> = {};
  if (storyIds.length > 0) {
    const storyRows = await db
      .select({ id: stories.id, title: stories.title })
      .from(stories)
      .where(eq(stories.project_id, activeProject.id));
    storyTitles = Object.fromEntries(storyRows.map((s) => [s.id, s.title]));
  }

  const usedInStories = stepRefs.map((ref) => ({
    storyTitle: storyTitles[ref.story_id] ?? null,
    stepNumber: ref.step_number,
  }));

  return {
    object,
    manifestUrl,
    infoJsonUrl,
    isExternal,
    usedInStories,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;

  switch (intent) {
    case "update-object": {
      const objectDbId = Number(formData.get("objectDbId"));
      const title = (formData.get("title") as string | null)?.trim() || null;

      if (!title) {
        return { ok: false, error: "title_required" };
      }

      await db
        .update(objects)
        .set({
          title,
          creator: (formData.get("creator") as string | null)?.trim() || null,
          description:
            (formData.get("description") as string | null)?.trim() || null,
          period: (formData.get("period") as string | null)?.trim() || null,
          year: (formData.get("year") as string | null)?.trim() || null,
          object_type:
            (formData.get("object_type") as string | null)?.trim() || null,
          subjects:
            (formData.get("subjects") as string | null)?.trim() || null,
          source: (formData.get("source") as string | null)?.trim() || null,
          credit: (formData.get("credit") as string | null)?.trim() || null,
          featured: formData.get("featured") === "true",
          updated_at: new Date().toISOString(),
        })
        .where(eq(objects.id, objectDbId));

      return { ok: true, intent: "update-object" };
    }

    case "delete-object": {
      const objectDbId = Number(formData.get("objectDbId"));
      await db.delete(objects).where(eq(objects.id, objectDbId));
      throw redirect("/objects");
    }

    default:
      throw new Response("Bad request", { status: 400 });
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ObjectDetailPage({ loaderData }: Route.ComponentProps) {
  const { object, manifestUrl, infoJsonUrl, isExternal, usedInStories } =
    loaderData;
  const { t } = useTranslation("objects");
  const fetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const status = deriveStatus({
    title: object.title,
    image_available: object.image_available,
    missing_from_repo: object.missing_from_repo,
  });

  const isSaving =
    fetcher.state !== "idle" &&
    fetcher.formData?.get("intent") === "update-object";

  const actionError =
    fetcher.data &&
    typeof fetcher.data === "object" &&
    "error" in fetcher.data
      ? (fetcher.data as { error: string }).error
      : null;

  const titleError = actionError === "title_required";

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const titleValue = (
      form.elements.namedItem("title") as HTMLInputElement
    )?.value?.trim();
    if (!titleValue) {
      titleInputRef.current?.focus();
      return;
    }
    fetcher.submit(new FormData(form), { method: "post" });
  }

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)]">
      {/* Breadcrumb bar */}
      <div className="flex items-center gap-3 mb-4 shrink-0">
        <Link
          to="/objects"
          className="inline-flex items-center gap-1.5 font-heading text-sm text-gray-500 hover:text-charcoal transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          {t("breadcrumb_objects")}
        </Link>
        <span className="text-gray-300">/</span>
        <span className="font-heading text-sm font-semibold text-charcoal truncate">
          {object.title || object.object_id}
        </span>
      </div>

      {/* Two-column layout */}
      <div className="flex gap-6 flex-1 min-h-0">
        {/* Left — IIIF viewer */}
        <div className="w-3/5 shrink-0">
          <IiifViewer
            manifestUrl={manifestUrl}
            infoJsonUrl={infoJsonUrl}
            isSelfHosted={!isExternal}
            alt={object.title ?? object.object_id}
            className="w-full h-full"
          />
        </div>

        {/* Right — metadata form */}
        <div className="w-2/5 overflow-y-auto bg-white rounded-xl border border-gray-100 flex flex-col">
          <div className="flex-1 p-6">
            <fetcher.Form method="post" onSubmit={handleSubmit} id="edit-object-form">
              <input type="hidden" name="intent" value="update-object" />
              <input type="hidden" name="objectDbId" value={object.id} />

              {/* Status badge */}
              <div className="mb-4">
                <StatusBadge status={status} />
              </div>

              {/* Object ID — read-only */}
              <div className="mb-4">
                <FieldLabel htmlFor="field-object-id">Object ID</FieldLabel>
                <p
                  id="field-object-id"
                  className="font-mono text-sm text-gray-500 bg-gray-100 px-3 py-2 rounded-lg truncate"
                  title={object.object_id}
                >
                  {object.object_id}
                </p>
              </div>

              {/* Title */}
              <div className="mb-4">
                <FieldLabel htmlFor="field-title" required>
                  {t("field_title")}
                </FieldLabel>
                <input
                  ref={titleInputRef}
                  id="field-title"
                  name="title"
                  type="text"
                  required
                  defaultValue={object.title ?? ""}
                  className={titleError ? inputError : inputNormal}
                  key={object.id}
                />
                {titleError && (
                  <p className="mt-1 text-xs text-red-500 font-body">
                    {t("field_title_required")}
                  </p>
                )}
              </div>

              {/* Description */}
              <div className="mb-4">
                <FieldLabel htmlFor="field-description">
                  {t("field_description")}
                </FieldLabel>
                <textarea
                  id="field-description"
                  name="description"
                  rows={3}
                  defaultValue={object.description ?? ""}
                  className={`${inputNormal} resize-none`}
                  key={object.id}
                />
              </div>

              {/* Creator */}
              <div className="mb-4">
                <FieldLabel htmlFor="field-creator">
                  {t("field_creator")}
                </FieldLabel>
                <input
                  id="field-creator"
                  name="creator"
                  type="text"
                  defaultValue={object.creator ?? ""}
                  className={inputNormal}
                  key={object.id}
                />
              </div>

              {/* Period + Year */}
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div>
                  <FieldLabel htmlFor="field-period">
                    {t("field_period")}
                  </FieldLabel>
                  <input
                    id="field-period"
                    name="period"
                    type="text"
                    defaultValue={object.period ?? ""}
                    className={inputNormal}
                    key={object.id}
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="field-year">
                    {t("field_year")}
                  </FieldLabel>
                  <input
                    id="field-year"
                    name="year"
                    type="text"
                    defaultValue={object.year ?? ""}
                    className={inputNormal}
                    key={object.id}
                  />
                </div>
              </div>

              {/* Object Type */}
              <div className="mb-4">
                <FieldLabel htmlFor="field-object-type">
                  {t("field_object_type")}
                </FieldLabel>
                <input
                  id="field-object-type"
                  name="object_type"
                  type="text"
                  defaultValue={object.object_type ?? ""}
                  className={inputNormal}
                  key={object.id}
                />
              </div>

              {/* Subjects */}
              <div className="mb-4">
                <FieldLabel htmlFor="field-subjects">
                  {t("field_subjects")}
                </FieldLabel>
                <input
                  id="field-subjects"
                  name="subjects"
                  type="text"
                  defaultValue={object.subjects ?? ""}
                  className={inputNormal}
                  key={object.id}
                />
              </div>

              {/* Source */}
              <div className="mb-4">
                <FieldLabel htmlFor="field-source">
                  {t("field_source")}
                </FieldLabel>
                <input
                  id="field-source"
                  name="source"
                  type="text"
                  defaultValue={object.source ?? ""}
                  className={inputNormal}
                  key={object.id}
                />
              </div>

              {/* Credit */}
              <div className="mb-4">
                <FieldLabel htmlFor="field-credit">
                  {t("field_credit")}
                </FieldLabel>
                <input
                  id="field-credit"
                  name="credit"
                  type="text"
                  defaultValue={object.credit ?? ""}
                  className={inputNormal}
                  key={object.id}
                />
              </div>

              {/* Source URL — read-only */}
              {object.source_url && (
                <div className="mb-4">
                  <FieldLabel htmlFor="field-source-url">
                    {t("field_source_url")}
                  </FieldLabel>
                  <p
                    id="field-source-url"
                    className="font-body text-sm text-gray-500 bg-gray-100 px-3 py-2 rounded-lg truncate"
                    title={object.source_url}
                  >
                    {object.source_url}
                  </p>
                </div>
              )}

              {/* Featured toggle */}
              <div className="flex items-center justify-between mb-4">
                <FieldLabel htmlFor="field-featured">
                  {t("field_featured")}
                </FieldLabel>
                <FeaturedToggle defaultChecked={object.featured ?? false} />
              </div>

              {/* Story usage */}
              {usedInStories.length > 0 && (
                <div className="mb-4">
                  <p className="font-body text-xs font-medium text-gray-600 mb-1">
                    {t("used_in_stories")}
                  </p>
                  <ul className="space-y-1">
                    {usedInStories.map((ref: { storyTitle: string | null; stepNumber: number }, i: number) => (
                      <li
                        key={i}
                        className="font-body text-xs text-gray-500 bg-gray-50 px-3 py-1.5 rounded"
                      >
                        {ref.storyTitle || "Untitled"} — step {ref.stepNumber}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </fetcher.Form>
          </div>

          {/* Sticky action bar */}
          <div className="sticky bottom-0 bg-white border-t border-gray-100 px-6 py-3 flex gap-3 shrink-0">
            <Button
              type="submit"
              form="edit-object-form"
              variant="primary"
              loading={isSaving}
              disabled={isSaving}
              className="flex-1"
            >
              {t("save_button")}
            </Button>
            <Link
              to="/objects"
              className="
                flex-1 text-center font-heading font-semibold text-sm uppercase tracking-wider
                border border-gray-200 text-charcoal rounded-full px-6 py-2.5
                hover:bg-cream transition-colors
              "
            >
              {t("discard_button")}
            </Link>
            <button
              type="button"
              onClick={() => setShowDeleteConfirm(true)}
              className="p-2.5 rounded-full border border-red-200 text-red-500 hover:bg-red-50 transition-colors"
              title={t("delete_button")}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>

          {/* Delete confirmation modal */}
          {showDeleteConfirm && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
              <div className="bg-white rounded-xl shadow-lg p-6 max-w-sm w-full mx-4">
                <h3 className="font-heading font-semibold text-lg text-charcoal mb-2">
                  {t("delete_title")}
                </h3>
                <p className="font-body text-sm text-gray-600 mb-5">
                  {t("delete_description", { title: object.title || object.object_id })}
                </p>
                <div className="flex gap-3 justify-end">
                  <button
                    type="button"
                    onClick={() => setShowDeleteConfirm(false)}
                    className="font-heading font-semibold text-sm uppercase tracking-wider border border-gray-200 text-charcoal rounded-full px-6 py-2.5 hover:bg-cream transition-colors"
                  >
                    {t("delete_cancel")}
                  </button>
                  <deleteFetcher.Form method="post">
                    <input type="hidden" name="intent" value="delete-object" />
                    <input type="hidden" name="objectDbId" value={object.id} />
                    <button
                      type="submit"
                      className="font-heading font-semibold text-sm uppercase tracking-wider bg-red-500 hover:bg-red-600 text-white rounded-full px-6 py-2.5 transition-colors"
                    >
                      {t("delete_confirm")}
                    </button>
                  </deleteFetcher.Form>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers (local to this route)
// ---------------------------------------------------------------------------

const inputBase =
  "w-full font-body text-sm text-charcoal border rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-periwinkle focus:border-transparent transition-colors";
const inputNormal = `${inputBase} border-gray-200`;
const inputError = `${inputBase} border-red-400 ring-1 ring-red-400`;

function FieldLabel({
  htmlFor,
  required,
  children,
}: {
  htmlFor: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className="block font-body text-xs font-medium text-gray-600 mb-1"
    >
      {children}
      {required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  );
}

function StatusBadge({
  status,
}: {
  status: ReturnType<typeof deriveStatus>;
}) {
  const { t } = useTranslation("objects");

  const config: Record<
    ReturnType<typeof deriveStatus>,
    { label: string; dotClass: string; badgeClass: string }
  > = {
    ready: {
      label: t("status_ready"),
      dotClass: "bg-green-500",
      badgeClass: "bg-green-50 text-green-700",
    },
    no_metadata: {
      label: t("status_no_metadata"),
      dotClass: "bg-amber-400",
      badgeClass: "bg-amber-50 text-amber-700",
    },
    image_missing: {
      label: t("status_image_missing"),
      dotClass: "bg-gray-400",
      badgeClass: "bg-gray-100 text-gray-600",
    },
    missing_from_repo: {
      label: t("status_missing_from_repo"),
      dotClass: "bg-red-500",
      badgeClass: "bg-red-50 text-red-700",
    },
  };

  const { label, dotClass, badgeClass } = config[status];

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs rounded-full px-2.5 py-0.5 ${badgeClass}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotClass}`} />
      {label}
    </span>
  );
}

function FeaturedToggle({ defaultChecked }: { defaultChecked: boolean }) {
  const { t } = useTranslation("objects");
  const [checked, setChecked] = useState(defaultChecked);

  return (
    <div className="flex items-center gap-2">
      <input
        type="hidden"
        name="featured"
        value={checked ? "true" : "false"}
      />
      <Switch
        checked={checked}
        onChange={setChecked}
        label={checked ? t("unmark_featured") : t("mark_featured")}
      />
    </div>
  );
}
