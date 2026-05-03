/**
 * Config — site configuration editor with explicit save.
 *
 * Fields update the Yjs config map on change (preventing DO snapshot overwrite).
 * The Save button writes directly to D1 for immediate persistence. Dirty state
 * is tracked — navigating away with unsaved changes shows a confirmation modal.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { eq } from "drizzle-orm";
import { Form, Link, useBlocker, useFetcher, useNavigation } from "react-router";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check, Loader2, RefreshCw } from "lucide-react";
import * as Y from "yjs";
import type { Route } from "./+types/_app.config";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { createSessionStorage } from "~/lib/session.server";
import { project_config, project_themes } from "~/db/schema";
import { resolveActiveProject } from "~/lib/membership.server";
import { decrypt } from "~/lib/crypto.server";
import { getRepoTree, getFileContent } from "~/lib/github.server";
import { parseYaml } from "~/lib/yaml.server";
import { ConfigSection } from "~/components/features/config/ConfigSection";
import { FieldWithHelp } from "~/components/features/config/FieldWithHelp";
import { ToggleField } from "~/components/features/config/ToggleField";
import { ThemeSwatches } from "~/components/features/config/ThemeSwatches";
// NavigationEditor removed — navigation is managed from the Pages tab
import { Button } from "~/components/ui/Button";
import { useCollaborationContext } from "~/hooks/use-collaboration";

export const handle = { i18n: ["common", "config"], hideAutosaveIndicator: true };

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;

  const resolved = await resolveActiveProject(db, user.id, sessionActiveId);
  if (!resolved) {
    return { hasProject: false as const, config: null, themes: [] };
  }
  const { project } = resolved;
  const [configRows, themes] = await Promise.all([
    db
      .select()
      .from(project_config)
      .where(eq(project_config.project_id, project.id))
      .limit(1),
    db
      .select({
        theme_id: project_themes.theme_id,
        name: project_themes.name,
        swatch_color: project_themes.swatch_color,
      })
      .from(project_themes)
      .where(eq(project_themes.project_id, project.id)),
  ]);

  return { hasProject: true as const, config: configRows[0] ?? null, themes };
}

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;

  const resolved = await resolveActiveProject(db, user.id, sessionActiveId);
  if (!resolved) {
    return { saved: false, error: "No project found" };
  }
  const { project } = resolved;
  const formData = await request.formData();
  const intent = formData.get("intent") as string | null;

  if (intent === "refresh-themes") {
    try {
      const token = await decrypt(user.encrypted_access_token, env.ENCRYPTION_KEY);
      const [owner, repo] = project.github_repo_full_name.split("/");
      const { tree } = await getRepoTree(token, owner, repo);
      const themeFiles = tree.filter(
        (entry) =>
          entry.type === "blob" &&
          entry.path.startsWith("_data/themes/") &&
          entry.path.endsWith(".yml"),
      );
      const themeRows: Array<typeof project_themes.$inferInsert> = [];
      for (const entry of themeFiles) {
        const content = await getFileContent(token, owner, repo, entry.path);
        if (!content) continue;
        const parsed = parseYaml(content) as Record<string, unknown> | null;
        if (!parsed) continue;
        const filename = entry.path.split("/").pop()!.replace(/\.yml$/, "");
        const colors = parsed.colors as Record<string, Record<string, string>> | undefined;
        themeRows.push({
          project_id: project.id,
          theme_id: filename,
          name: (parsed.name as string) || filename,
          description: (parsed.description as string) || undefined,
          creator: (parsed.creator as string) || undefined,
          creator_url: (parsed.creator_url as string) || undefined,
          swatch_color: colors?.text?.heading || undefined,
        });
      }
      await db.delete(project_themes).where(eq(project_themes.project_id, project.id));
      if (themeRows.length > 0) {
        for (const row of themeRows) {
          await db.insert(project_themes).values(row);
        }
      }
      return { ok: true, intent: "refresh-themes", count: themeRows.length };
    } catch {
      return { ok: false, intent: "refresh-themes", error: "fetch_failed" };
    }
  }

  await db
    .update(project_config)
    .set({
      title: formData.get("title") as string,
      description: formData.get("description") as string,
      author: formData.get("author") as string,
      email: formData.get("email") as string,
      lang: formData.get("lang") as string,
      theme: formData.get("theme") as string,
      logo: formData.get("logo") as string,
      include_demo_content: formData.get("include_demo_content") === "true",
      url: formData.get("url") as string,
      baseurl: formData.get("baseurl") as string,
      show_on_homepage: formData.get("show_on_homepage") === "true",
      show_story_steps: formData.get("show_story_steps") === "true",
      show_object_credits: formData.get("show_object_credits") === "true",
      browse_and_search: formData.get("browse_and_search") === "true",
      show_link_on_homepage: formData.get("show_link_on_homepage") === "true",
      show_sample_on_homepage: formData.get("show_sample_on_homepage") === "true",
      featured_count: parseInt(formData.get("featured_count") as string) || 4,
      story_key: formData.get("story_key") as string,
      updated_at: new Date().toISOString(),
    })
    .where(eq(project_config.project_id, project.id));

  return { saved: true };
}

function updateYText(yConfig: Y.Map<unknown>, key: string, value: string) {
  const existing = yConfig.get(key);
  if (existing instanceof Y.Text) {
    if (existing.toString() !== value) {
      existing.delete(0, existing.length);
      existing.insert(0, value);
    }
  } else {
    yConfig.set(key, new Y.Text(value));
  }
}

function syncFormToYjs(form: HTMLFormElement, yConfig: Y.Map<unknown>) {
  const fd = new FormData(form);
  const textFields = ["title", "description", "author", "email"];
  for (const key of textFields) {
    updateYText(yConfig, key, fd.get(key) as string);
  }
  const scalarStrings = ["lang", "baseurl", "url", "theme", "logo", "story_key"];
  for (const key of scalarStrings) {
    yConfig.set(key, fd.get(key) as string);
  }
  const booleans = [
    "include_demo_content", "show_on_homepage", "show_story_steps",
    "show_object_credits", "browse_and_search", "show_link_on_homepage",
    "show_sample_on_homepage",
  ];
  for (const key of booleans) {
    yConfig.set(key, fd.get(key) === "true");
  }
  yConfig.set("featured_count", parseInt(fd.get("featured_count") as string) || 4);
}

export default function ConfigPage({ loaderData, actionData }: Route.ComponentProps) {
  const { t } = useTranslation("config");
  const themeFetcher = useFetcher();
  const isRefreshingThemes = themeFetcher.state !== "idle";
  const navigation = useNavigation();
  const { isPublishing, ydoc } = useCollaborationContext();
  const formRef = useRef<HTMLFormElement>(null);

  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [showSaved, setShowSaved] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isSaving = navigation.state === "submitting" &&
    navigation.formData?.get("intent") !== "refresh-themes";

  // After successful save: sync to Yjs, clear dirty, show saved animation
  useEffect(() => {
    if (actionData?.saved) {
      dirtyRef.current = false;
      setDirty(false);
      setShowSaved(true);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => setShowSaved(false), 2000);

      const yConfig = ydoc?.getMap<unknown>("config");
      if (yConfig && formRef.current) {
        syncFormToYjs(formRef.current, yConfig);
      }
    }
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, [actionData, ydoc]);

  const markDirty = useCallback(() => {
    dirtyRef.current = true;
    setDirty(true);
    setShowSaved(false);
  }, []);

  // Also sync individual field changes to Yjs on blur/change
  const onFieldChange = useCallback(
    (name: string, value: string) => {
      markDirty();
      const yConfig = ydoc?.getMap<unknown>("config");
      if (!yConfig) return;
      const textFields = ["title", "description", "author", "email"];
      if (textFields.includes(name)) {
        updateYText(yConfig, name, value);
      } else {
        yConfig.set(name, value);
      }
    },
    [ydoc, markDirty],
  );

  const onBooleanChange = useCallback(
    (name: string, value: boolean) => {
      markDirty();
      const yConfig = ydoc?.getMap<unknown>("config");
      if (!yConfig) return;
      yConfig.set(name, value);
    },
    [ydoc, markDirty],
  );

  // Unsaved changes blocker — uses ref so onSubmit can clear it synchronously
  const blocker = useBlocker(() => dirtyRef.current);

  if (!loaderData.hasProject) {
    return (
      <div className="max-w-3xl mx-auto py-20 text-center">
        <p className="font-body text-gray-500 mb-4">
          Connect a project first to configure your site.
        </p>
        <Link
          to="/onboarding"
          className="inline-flex items-center justify-center bg-periwinkle hover:bg-periwinkle-hover text-charcoal font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-6 py-2.5 transition-colors"
        >
          Connect a Repository
        </Link>
      </div>
    );
  }

  const config = loaderData.config;
  const themes = loaderData.themes;

  return (
    <div className="max-w-3xl mx-auto pb-8">
      <h1 className="font-heading font-bold text-2xl text-charcoal mb-6">{t("title")}</h1>

      <Form method="post" ref={formRef} onSubmit={() => { dirtyRef.current = false; }}>
        {/* 1. Site Settings */}
        <ConfigSection title={t("sections.site_settings.title")}>
          <FieldWithHelp
            label={t("sections.site_settings.field_title")}
            name="title"
            value={config?.title ?? ""}
            help={t("sections.site_settings.field_title_help")}
            onChange={onFieldChange}
          />
          <FieldWithHelp
            label={t("sections.site_settings.field_description")}
            name="description"
            type="textarea"
            value={config?.description ?? ""}
            help={t("sections.site_settings.field_description_help")}
            onChange={onFieldChange}
          />
          <FieldWithHelp
            label={t("sections.site_settings.field_author")}
            name="author"
            value={config?.author ?? ""}
            onChange={onFieldChange}
          />
          <FieldWithHelp
            label={t("sections.site_settings.field_email")}
            name="email"
            value={config?.email ?? ""}
            onChange={onFieldChange}
          />
          <div className="mb-4">
            <label className="font-body font-medium text-sm text-charcoal mb-2 block">
              {t("sections.site_settings.field_theme")}
            </label>
            <p className="text-xs text-gray-400 mb-2">{t("sections.site_settings.field_theme_help")}</p>
            <ThemeSwatches
              name="theme"
              value={config?.theme ?? ""}
              themes={themes}
              onChange={(value) => onFieldChange("theme", value)}
            />
            <button
              type="button"
              onClick={() =>
                themeFetcher.submit(
                  { intent: "refresh-themes" },
                  { method: "post" },
                )
              }
              disabled={isRefreshingThemes}
              className="inline-flex items-center gap-1.5 mt-2 text-xs font-body text-gray-400 hover:text-charcoal transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingThemes ? "animate-spin" : ""}`} />
              {t("sections.site_settings.refresh_themes")}
            </button>
          </div>
          <FieldWithHelp
            label={t("sections.site_settings.field_logo")}
            name="logo"
            value={config?.logo ?? ""}
            help={t("sections.site_settings.field_logo_help")}
            onChange={onFieldChange}
          />
          <FieldWithHelp
            label={t("sections.site_settings.field_language")}
            name="lang"
            type="select"
            value={config?.lang ?? "en"}
            help={t("sections.site_settings.field_language_help")}
            options={[
              { value: "en", label: "English" },
              { value: "es", label: "Español" },
            ]}
            onChange={onFieldChange}
          />
          <ToggleField
            label={t("sections.site_settings.field_demo_content")}
            name="include_demo_content"
            checked={config?.include_demo_content ?? true}
            help={t("sections.site_settings.field_demo_content_help")}
            onChange={onBooleanChange}
          />
        </ConfigSection>

        {/* 2. Hosting */}
        <ConfigSection title={t("sections.hosting.title")}>
          <FieldWithHelp
            label={t("sections.hosting.field_url")}
            name="url"
            value={config?.url ?? ""}
            help={t("sections.hosting.field_url_help")}
            onChange={onFieldChange}
          />
          <FieldWithHelp
            label={t("sections.hosting.field_baseurl")}
            name="baseurl"
            value={config?.baseurl ?? ""}
            help={t("sections.hosting.field_baseurl_help")}
            onChange={onFieldChange}
          />
        </ConfigSection>

        {/* 3. Story Interface */}
        <ConfigSection title={t("sections.story_interface.title")}>
          <ToggleField
            label={t("sections.story_interface.field_show_on_homepage")}
            name="show_on_homepage"
            checked={config?.show_on_homepage ?? true}
            onChange={onBooleanChange}
          />
          <ToggleField
            label={t("sections.story_interface.field_show_story_steps")}
            name="show_story_steps"
            checked={config?.show_story_steps ?? true}
            help={t("sections.story_interface.field_show_story_steps_help")}
            onChange={onBooleanChange}
          />
          <ToggleField
            label={t("sections.story_interface.field_show_object_credits")}
            name="show_object_credits"
            checked={config?.show_object_credits ?? true}
            help={t("sections.story_interface.field_show_object_credits_help")}
            onChange={onBooleanChange}
          />
        </ConfigSection>

        {/* 4. Collection Interface */}
        <ConfigSection title={t("sections.collection_interface.title")}>
          <ToggleField
            label={t("sections.collection_interface.field_browse_and_search")}
            name="browse_and_search"
            checked={config?.browse_and_search ?? true}
            onChange={onBooleanChange}
          />
          <ToggleField
            label={t("sections.collection_interface.field_show_link_on_homepage")}
            name="show_link_on_homepage"
            checked={config?.show_link_on_homepage ?? true}
            onChange={onBooleanChange}
          />
          <ToggleField
            label={t("sections.collection_interface.field_show_sample_on_homepage")}
            name="show_sample_on_homepage"
            checked={config?.show_sample_on_homepage ?? false}
            onChange={onBooleanChange}
          />
          <FieldWithHelp
            label={t("sections.collection_interface.field_featured_count")}
            name="featured_count"
            type="number"
            value={config?.featured_count ?? 4}
            help={t("sections.collection_interface.field_featured_count_help")}
            onChange={(name, value) => {
              markDirty();
              const yConfig = ydoc?.getMap<unknown>("config");
              if (yConfig) yConfig.set(name, parseInt(value) || 4);
            }}
          />
        </ConfigSection>

        {/* 5. Story Protection */}
        <ConfigSection title={t("sections.story_protection.title")}>
          <FieldWithHelp
            label={t("sections.story_protection.field_story_key")}
            name="story_key"
            value={config?.story_key ?? ""}
            help={t("sections.story_protection.field_story_key_help")}
            onChange={onFieldChange}
          />
        </ConfigSection>

        {/* 6. Navigation Menu */}
        <ConfigSection title={t("navigation_menu_title")}>
          <p className="font-body text-sm text-gray-500">
            {t("navigation_menu_description_before")}
            <a href="/pages" className="text-terracotta hover:text-terracotta/80 underline">{t("navigation_menu_pages_link")}</a>
            {t("navigation_menu_description_after")}
          </p>
        </ConfigSection>

        {/* 7. Google Sheets Integration */}
        <ConfigSection title={t("sections.google_sheets.title")}>
          {config?.google_sheets_enabled ? (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-4 py-3 text-sm font-body">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <p>{t("sections.google_sheets.enabled_notice")}</p>
            </div>
          ) : (
            <p className="text-sm font-body text-gray-500">
              {t("sections.google_sheets.disabled_notice")}
            </p>
          )}
        </ConfigSection>

        {/* Save button with state animation */}
        <div className="flex items-center justify-end gap-3 pb-8">
          {showSaved && (
            <span className="inline-flex items-center gap-1.5 font-body text-xs text-green-600">
              <Check className="w-3.5 h-3.5" />
              {t("saved")}
            </span>
          )}
          <Button type="submit" disabled={isPublishing || isSaving} loading={isSaving}>
            {isSaving ? t("saving") : t("save")}
          </Button>
        </div>
      </Form>

      {/* Unsaved changes confirmation modal */}
      {blocker.state === "blocked" && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40" aria-hidden="true" />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-xl max-w-sm w-full p-6">
              <h2 className="font-heading font-semibold text-lg text-charcoal mb-2">
                {t("unsaved_changes.title")}
              </h2>
              <p className="font-body text-sm text-gray-600 mb-6">
                {t("unsaved_changes.message")}
              </p>
              <div className="flex justify-end gap-3">
                <Button variant="secondary" onClick={() => blocker.reset?.()}>
                  {t("unsaved_changes.stay")}
                </Button>
                <Button onClick={() => blocker.proceed?.()}>
                  {t("unsaved_changes.leave")}
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
