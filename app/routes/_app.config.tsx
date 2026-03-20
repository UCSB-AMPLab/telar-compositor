/**
 * Config — full site configuration editor.
 *
 * Reads project_config from D1 and writes updates back.
 * Renders 6 sections: Site Settings, Hosting, Story Interface,
 * Collection Interface, Story Protection, Google Sheets Integration.
 */

import { eq } from "drizzle-orm";
import { Form, Link } from "react-router";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle } from "lucide-react";
import type { Route } from "./+types/_app.config";
import { userContext } from "~/middleware/auth.server";
import { getDb } from "~/lib/db.server";
import { createSessionStorage } from "~/lib/session.server";
import { projects, project_config, project_themes } from "~/db/schema";
import { ConfigSection } from "~/components/features/config/ConfigSection";
import { FieldWithHelp } from "~/components/features/config/FieldWithHelp";
import { ToggleField } from "~/components/features/config/ToggleField";
import { ThemeSwatches } from "~/components/features/config/ThemeSwatches";
import { Button } from "~/components/ui/Button";

export const handle = { i18n: ["common", "config"] };

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  if (!user) throw new Response("Unauthorized", { status: 401 });

  const env = context.cloudflare.env as Env;
  const db = getDb(env.DB);

  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));
  const sessionActiveId = session.get("activeProjectId") as number | undefined;

  const allProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.user_id, user.id));

  if (allProjects.length === 0) {
    return { hasProject: false as const, config: null, themes: [] };
  }

  const project =
    allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];
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

  const allProjects = await db
    .select()
    .from(projects)
    .where(eq(projects.user_id, user.id));

  if (allProjects.length === 0) {
    return { saved: false, error: "No project found" };
  }

  const project =
    allProjects.find((p) => p.id === Number(sessionActiveId)) ?? allProjects[0];
  const formData = await request.formData();

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

export default function ConfigPage({ loaderData, actionData }: Route.ComponentProps) {
  const { t } = useTranslation("config");

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
    <div className="max-w-3xl mx-auto">
      <h1 className="font-heading font-bold text-2xl text-charcoal mb-6">{t("title")}</h1>

      {/* Save success banner */}
      {actionData?.saved && (
        <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-800 rounded-lg px-4 py-3 mb-6 text-sm font-body">
          <CheckCircle className="w-4 h-4 flex-shrink-0" />
          {t("saved")}
        </div>
      )}

      <Form method="post">
        {/* 1. Site Settings */}
        <ConfigSection title={t("sections.site_settings.title")}>
          <FieldWithHelp
            label={t("sections.site_settings.field_title")}
            name="title"
            value={config?.title ?? ""}
            help={t("sections.site_settings.field_title_help")}
          />
          <FieldWithHelp
            label={t("sections.site_settings.field_description")}
            name="description"
            type="textarea"
            value={config?.description ?? ""}
            help={t("sections.site_settings.field_description_help")}
          />
          <FieldWithHelp
            label={t("sections.site_settings.field_author")}
            name="author"
            value={config?.author ?? ""}
          />
          <FieldWithHelp
            label={t("sections.site_settings.field_email")}
            name="email"
            value={config?.email ?? ""}
          />
          <div className="mb-4">
            <label className="font-body font-medium text-sm text-charcoal mb-2 block">
              {t("sections.site_settings.field_theme")}
            </label>
            <p className="text-xs text-gray-400 mb-2">{t("sections.site_settings.field_theme_help")}</p>
            <ThemeSwatches name="theme" value={config?.theme ?? ""} themes={themes} />
          </div>
          <FieldWithHelp
            label={t("sections.site_settings.field_logo")}
            name="logo"
            value={config?.logo ?? ""}
            help={t("sections.site_settings.field_logo_help")}
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
          />
          <ToggleField
            label={t("sections.site_settings.field_demo_content")}
            name="include_demo_content"
            checked={config?.include_demo_content ?? true}
            help={t("sections.site_settings.field_demo_content_help")}
          />
        </ConfigSection>

        {/* 2. Hosting */}
        <ConfigSection title={t("sections.hosting.title")}>
          <FieldWithHelp
            label={t("sections.hosting.field_url")}
            name="url"
            value={config?.url ?? ""}
            help={t("sections.hosting.field_url_help")}
          />
          <FieldWithHelp
            label={t("sections.hosting.field_baseurl")}
            name="baseurl"
            value={config?.baseurl ?? ""}
            help={t("sections.hosting.field_baseurl_help")}
          />
        </ConfigSection>

        {/* 3. Story Interface */}
        <ConfigSection title={t("sections.story_interface.title")}>
          <ToggleField
            label={t("sections.story_interface.field_show_on_homepage")}
            name="show_on_homepage"
            checked={config?.show_on_homepage ?? true}
          />
          <ToggleField
            label={t("sections.story_interface.field_show_story_steps")}
            name="show_story_steps"
            checked={config?.show_story_steps ?? true}
            help={t("sections.story_interface.field_show_story_steps_help")}
          />
          <ToggleField
            label={t("sections.story_interface.field_show_object_credits")}
            name="show_object_credits"
            checked={config?.show_object_credits ?? true}
            help={t("sections.story_interface.field_show_object_credits_help")}
          />
        </ConfigSection>

        {/* 4. Collection Interface */}
        <ConfigSection title={t("sections.collection_interface.title")}>
          <ToggleField
            label={t("sections.collection_interface.field_browse_and_search")}
            name="browse_and_search"
            checked={config?.browse_and_search ?? true}
          />
          <ToggleField
            label={t("sections.collection_interface.field_show_link_on_homepage")}
            name="show_link_on_homepage"
            checked={config?.show_link_on_homepage ?? true}
          />
          <ToggleField
            label={t("sections.collection_interface.field_show_sample_on_homepage")}
            name="show_sample_on_homepage"
            checked={config?.show_sample_on_homepage ?? false}
          />
          <FieldWithHelp
            label={t("sections.collection_interface.field_featured_count")}
            name="featured_count"
            type="number"
            value={config?.featured_count ?? 4}
            help={t("sections.collection_interface.field_featured_count_help")}
          />
        </ConfigSection>

        {/* 5. Story Protection */}
        <ConfigSection title={t("sections.story_protection.title")}>
          <FieldWithHelp
            label={t("sections.story_protection.field_story_key")}
            name="story_key"
            value={config?.story_key ?? ""}
            help={t("sections.story_protection.field_story_key_help")}
          />
        </ConfigSection>

        {/* 6. Google Sheets Integration */}
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

        {/* Save button */}
        <div className="flex justify-end pb-8">
          <Button type="submit">{t("save")}</Button>
        </div>
      </Form>
    </div>
  );
}
