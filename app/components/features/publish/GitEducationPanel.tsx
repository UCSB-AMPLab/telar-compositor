/**
 * GitEducationPanel — dismissible intro panel explaining what publishing does.
 *
 * Teaches students about git concepts (commit, repository, push) via tooltip
 * glossary using <abbr> elements. Dismissal state stored in localStorage.
 */

import { useEffect, useState } from "react";
import { X, BookOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

const DISMISS_KEY = "telar_publish_intro_dismissed";

interface GitEducationPanelProps {
  className?: string;
}

export function GitEducationPanel({ className = "" }: GitEducationPanelProps) {
  const { t } = useTranslation("publish");
  const [dismissed, setDismissed] = useState(true); // Start dismissed to avoid SSR flash

  useEffect(() => {
    // Check localStorage on mount (client-side only)
    try {
      const stored = localStorage.getItem(DISMISS_KEY);
      setDismissed(stored === "true");
    } catch {
      // localStorage unavailable (SSR or private mode) — keep dismissed
    }
  }, []);

  function handleDismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISS_KEY, "true");
    } catch {
      // Ignore storage errors
    }
  }

  if (dismissed) return null;

  return (
    <div className={`bg-lavender/20 border border-lavender rounded-lg p-4 relative mb-6 ${className}`}>
      {/* Dismiss button */}
      <button
        type="button"
        onClick={handleDismiss}
        aria-label={t("education.dismiss")}
        className="absolute top-3 right-3 text-gray-400 hover:text-charcoal transition-colors"
      >
        <X className="w-4 h-4" />
      </button>

      <div className="flex items-start gap-3 pr-6">
        <BookOpen className="w-5 h-5 text-charcoal flex-shrink-0 mt-0.5" />
        <div>
          <h3 className="font-heading font-semibold text-sm text-charcoal mb-1">
            {t("education.heading")}
          </h3>

          {/* Main explanation with glossary terms */}
          <p className="font-body text-sm text-gray-700 mb-2">
            Publishing saves your changes as a{" "}
            <abbr
              title={t("education.glossary.commit")}
              className="underline decoration-dotted cursor-help"
            >
              commit
            </abbr>{" "}
            to your{" "}
            <abbr
              title={t("education.glossary.repository")}
              className="underline decoration-dotted cursor-help"
            >
              repository
            </abbr>
            , then{" "}
            <abbr
              title={t("education.glossary.push")}
              className="underline decoration-dotted cursor-help"
            >
              pushes
            </abbr>{" "}
            it to GitHub. Think of it like saving a document to the cloud — your site will update automatically.
          </p>

          <a
            href="https://github.blog/developer-skills/programming-languages-and-frameworks/what-is-git-our-beginners-guide-to-version-control/"
            target="_blank"
            rel="noopener noreferrer"
            className="font-body text-sm text-blue-600 hover:underline"
          >
            {t("education.learn_more")} &rarr;
          </a>
        </div>
      </div>
    </div>
  );
}
