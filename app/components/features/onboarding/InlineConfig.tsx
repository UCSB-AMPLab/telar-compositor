/**
 * InlineConfig — inline config editor within the onboarding wizard.
 *
 * Shows essential config fields only: Site Settings (title, language, theme)
 * and Hosting (URL, baseurl). Pre-populated from importResult.configFields.
 * Submits via fetcher with intent="save_config".
 */

import { useState } from "react";
import { useFetcher } from "react-router";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/Button";
import { ThemeSwatches, type ThemeOption } from "~/components/features/config/ThemeSwatches";

interface InlineConfigProps {
  configFields: Record<string, unknown>;
  projectId: number;
  themes: ThemeOption[];
  onSaved: () => void;
  className?: string;
}

export function InlineConfig({ configFields, projectId, themes, onSaved, className = "" }: InlineConfigProps) {
  const { t } = useTranslation("onboarding");
  const fetcher = useFetcher<{ saved?: boolean }>();

  const [title, setTitle] = useState(String(configFields.title ?? ""));
  const [lang, setLang] = useState(String(configFields.lang ?? "en"));
  const [url, setUrl] = useState(String(configFields.url ?? ""));
  const [baseurl, setBaseurl] = useState(String(configFields.baseurl ?? ""));

  const isSaving = fetcher.state !== "idle";

  // Detect save success and call onSaved
  if (fetcher.data?.saved && !isSaving) {
    onSaved();
  }

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    formData.set("intent", "save_config");
    formData.set("project_id", String(projectId));
    formData.set("title", title);
    formData.set("lang", lang);
    formData.set("url", url);
    formData.set("baseurl", baseurl);
    fetcher.submit(formData, { method: "post", action: "/onboarding" });
  };

  return (
    <div className={`border-t border-gray-100 pt-6 mt-6 ${className}`}>
      <h3 className="font-heading font-semibold text-base text-charcoal mb-4">
        {t("inline_config.heading")}
      </h3>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Site Settings section */}
        <div className="bg-cream rounded-lg p-4 space-y-4">
          {/* Title */}
          <div>
            <label className="block text-sm font-body font-medium text-charcoal mb-1">
              {t("inline_config.site_title")}
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-body text-charcoal focus:outline-none focus:ring-2 focus:ring-periwinkle"
            />
          </div>

          {/* Language */}
          <div>
            <label className="block text-sm font-body font-medium text-charcoal mb-1">
              {t("inline_config.language")}
            </label>
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-body text-charcoal focus:outline-none focus:ring-2 focus:ring-periwinkle bg-white"
            >
              <option value="en">English</option>
              <option value="es">Español</option>
            </select>
          </div>

          {/* Theme */}
          <div>
            <label className="block text-sm font-body font-medium text-charcoal mb-2">
              {t("inline_config.theme")}
            </label>
            <ThemeSwatches name="theme" value={String(configFields.theme ?? "")} themes={themes} />
          </div>
        </div>

        {/* Hosting section */}
        <div className="bg-cream rounded-lg p-4 space-y-4">
          {/* URL */}
          <div>
            <label className="block text-sm font-body font-medium text-charcoal mb-1">
              {t("inline_config.url")}
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-body text-charcoal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-periwinkle"
            />
            <p className="text-xs font-body text-gray-400 mt-1">
              Your GitHub Pages or custom domain URL
            </p>
          </div>

          {/* Base URL */}
          <div>
            <label className="block text-sm font-body font-medium text-charcoal mb-1">
              {t("inline_config.baseurl")}
            </label>
            <input
              type="text"
              value={baseurl}
              onChange={(e) => setBaseurl(e.target.value)}
              placeholder="/my-repo"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm font-body text-charcoal placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-periwinkle"
            />
            <p className="text-xs font-body text-gray-400 mt-1">
              Path prefix for GitHub Pages project sites (e.g. /my-repo)
            </p>
          </div>
        </div>

        <div className="flex justify-end">
          <Button type="submit" variant="primary" loading={isSaving}>
            {t("inline_config.save")}
          </Button>
        </div>
      </form>
    </div>
  );
}
