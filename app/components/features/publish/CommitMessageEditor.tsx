/**
 * CommitMessageEditor — editable commit message textarea with Publish button.
 *
 * Shows the auto-generated commit message as the default value. Includes
 * pedagogical help text explaining what a commit message is.
 * The Publish button is inside this component.
 *
 * @version v1.5.0-beta
 */

import { useState } from "react";
import { Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "~/components/ui/Button";

interface CommitMessageEditorProps {
  defaultMessage: string;
  onPublish: (message: string) => void;
  /** Closes the editor and hands back what was typed. */
  onDone?: (message: string) => void;
  loading?: boolean;
  /** Holds the Publish button back without the busy state `loading` shows. */
  disabled?: boolean;
  className?: string;
}

export function CommitMessageEditor({
  defaultMessage,
  onPublish,
  onDone,
  loading = false,
  disabled = false,
  className = "",
}: CommitMessageEditorProps) {
  const { t } = useTranslation("publish");
  const [message, setMessage] = useState(defaultMessage);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (message.trim() && !disabled) {
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
            className="w-full font-body text-sm border border-gray-200 rounded-lg px-3 py-2 resize-none"
            disabled={loading}
          />
          <p className="font-body text-xs text-gray-400 mt-1">
            {t("commit.footer_note")}
          </p>
        </div>

        <div className="flex items-center justify-between gap-3">
          {onDone ? (
            <Button type="button" variant="secondary" disabled={loading} onClick={() => onDone(message)}>
              {t("publish_section.done_editing")}
            </Button>
          ) : (
            <span />
          )}
          <Button
            type="submit"
            variant="primary"
            loading={loading}
            disabled={!message.trim() || loading || disabled}
          >
            <Upload className="w-4 h-4" />
            {t("commit.publish_button")}
          </Button>
        </div>
      </form>
    </div>
  );
}
