/**
 * CommitMessageEditor — editable commit message textarea with Publish button.
 *
 * Shows the auto-generated commit message as the default value. Includes
 * pedagogical help text explaining what a commit message is.
 * The Publish button is inside this component.
 */

import { useState } from "react";
import { Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/Button";

interface CommitMessageEditorProps {
  defaultMessage: string;
  onPublish: (message: string) => void;
  loading?: boolean;
  className?: string;
}

export function CommitMessageEditor({
  defaultMessage,
  onPublish,
  loading = false,
  className = "",
}: CommitMessageEditorProps) {
  const { t } = useTranslation("publish");
  const [message, setMessage] = useState(defaultMessage);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (message.trim()) {
      onPublish(message.trim());
    }
  }

  return (
    <div className={className}>
      <h2 className="font-heading font-semibold text-lg text-charcoal mb-1">
        {t("commit.heading")}
      </h2>
      <p className="font-body text-sm text-gray-600 mb-4">
        {t("commit.description")}
      </p>

      <form onSubmit={handleSubmit}>
        <div className="mb-4">
          <label
            htmlFor="commit-message"
            className="block font-body text-sm font-medium text-charcoal mb-1.5"
          >
            {t("commit.label")}
          </label>
          <textarea
            id="commit-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={8}
            placeholder={t("commit.placeholder")}
            className="w-full font-body text-sm border border-gray-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-periwinkle resize-none"
            disabled={loading}
          />
          <p className="font-body text-xs text-gray-400 mt-1">
            {t("commit.footer_note")}
          </p>
        </div>

        <div className="flex justify-end">
          <Button
            type="submit"
            variant="primary"
            loading={loading}
            disabled={!message.trim() || loading}
          >
            <Upload className="w-4 h-4" />
            {t("commit.publish_button")}
          </Button>
        </div>
      </form>
    </div>
  );
}
