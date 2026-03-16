/**
 * Story Editor placeholder — navigated to from the dashboard Edit button.
 *
 * Full story editor implementation deferred to Phase 5.
 */

import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { Route } from "./+types/_app.stories.$storyId";

export const handle = { i18n: ["common"] };

export default function StoryEditorPage({ params }: Route.ComponentProps) {
  const { t } = useTranslation("dashboard");

  return (
    <div className="max-w-2xl mx-auto px-6 py-16 text-center">
      <h1 className="font-heading text-3xl font-semibold text-charcoal mb-3">
        Story Editor
      </h1>
      <p className="font-body text-charcoal mb-2">
        Story: <code className="font-mono text-sm bg-cream-dark px-2 py-0.5 rounded">{params.storyId}</code>
      </p>
      <p className="font-body text-charcoal mb-8">
        Coming in Phase 5
      </p>
      <Link
        to="/dashboard"
        className="inline-flex items-center justify-center font-heading font-semibold text-sm uppercase tracking-wider text-charcoal underline hover:no-underline"
      >
        {t("back_to_dashboard")}
      </Link>
    </div>
  );
}
