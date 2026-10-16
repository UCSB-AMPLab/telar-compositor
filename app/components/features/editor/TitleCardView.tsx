/**
 * The title card (step 0) on the framing stage: the story intro as the
 * published page draws it (`.story-intro`, `.intro-floating-card`, from the
 * framework's story layout and `_story.scss`), with the title, subtitle and
 * byline edited in place.
 *
 * With the story's section list turned on, the intro takes the layer 2 panel's
 * color (`.story-intro--toc`) and lists the section cards' titles under
 * "Sections" (`.intro-toc`), as the layout lists every step with no object
 * and a question. The list is read from the section cards, so a section's
 * title is edited on its own card, not here. The scroll hint is the one the
 * published page shows for the layout: the arrow-key hint on a horizontal
 * layout, the button hint on a vertical one, where the page always navigates
 * with buttons.
 *
 * The title, subtitle and byline write to the story's Y.Text as they are
 * typed; before the document connects there is no save for them, as there is
 * none in the route. The byline shows its Markdown rendered, as the published
 * intro prints it (`bylineHtml`), and is edited as the text it is typed as.
 *
 * The story's ID and the switch for the section list are the editor's own
 * and have no place on the published intro: `StorySettingsPanel` holds them,
 * beside the stage rather than on it.
 *
 * @version v1.5.5-beta
 */

import { useTranslation } from "react-i18next";
import { PencilLine } from "lucide-react";
import type * as Y from "yjs";
import { IntroText } from "~/components/features/editor/IntroText";
import { bylineHtml } from "~/lib/card-markdown";
import type { LayoutMode } from "~/lib/framing-stage";

/** The title card's data and what it does, as the route holds them. */
export interface TitleCardData {
  story: {
    id: number;
    title: string | null;
    subtitle: string | null;
    byline: string | null;
    show_sections: boolean;
  };
  storyId: string;
  titleYText: Y.Text | null;
  subtitleYText: Y.Text | null;
  bylineYText: Y.Text | null;
  /** Number of kind='section' steps in this story — controls helper-text visibility */
  sectionCardCount: number;
  /** The titles the published intro lists under "Sections": each section card with one, in order. */
  sectionTitles: readonly string[];
  /** Called immediately on toggle; writes to the story Y.Map.show_sections boolean */
  onToggleShowSections: (value: boolean) => void;
  /** Every story's ID in the document, for the ID field's uniqueness check. */
  storyIds: readonly string[];
  canRenameId: boolean;
  onRenameId: (newId: string) => void;
}

/**
 * ShowSectionsSwitch — slimmer inline variant of ToggleField. Reuses the same
 * role="switch" / aria-checked semantics as ToggleField.
 */
export function ShowSectionsSwitch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${
        checked ? "bg-anil" : "bg-gray-200"
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transform transition-transform ${
          checked ? "translate-x-4" : "translate-x-0"
        }`}
      />
    </button>
  );
}

/** The section titles under "Sections", as the published intro lists them. */
function IntroToc({ titles }: { titles: readonly string[] }) {
  const { t } = useTranslation("editor");
  if (titles.length === 0) return null;
  return (
    <nav className="intro-toc" aria-label={t("stage.sections_heading")}>
      <p className="intro-toc-heading">{t("stage.sections_heading")}</p>
      <ul>
        {titles.map((title, i) => (
          <li key={i}>
            <span className="intro-toc-link">{title}</span>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The editor's hint under a card's content: what clicking does. */
export function StageIntroHint({ text }: { text: string }) {
  return (
    <span data-testid="intro-edit-hint" aria-hidden="true" className="stage-intro-hint font-body">
      <PencilLine className="w-3 h-3" aria-hidden="true" />
      {text}
    </span>
  );
}

export function TitleCardView({
  story,
  storyId,
  titleYText,
  subtitleYText,
  bylineYText,
  sectionTitles,
  layoutMode,
}: Pick<TitleCardData, "story" | "storyId" | "titleYText" | "subtitleYText" | "bylineYText" | "sectionTitles"> & {
  /** The published page's layout for the author's window, which decides the scroll hint. */
  layoutMode: LayoutMode;
}) {
  const { t } = useTranslation("editor");
  const toc = story.show_sections;
  const introField = (name: "title" | "subtitle" | "byline", placeholder: string, label: string) => ({
    target: `story:${storyId}:${name}`,
    fieldKey: `story-${storyId}-${name}`,
    placeholder,
    label,
  });

  return (
    <div data-testid="story-intro" className={`story-intro${toc ? " story-intro--toc" : ""}`}>
      <div className="intro-floating-card">
        <h1 className="intro-title">
          <IntroText
            {...introField("title", t("title_card.title_placeholder"), t("title_card.title_label"))}
            pencilLabel={t("stage.edit_title")}
            yText={titleYText}
            initialValue={story.title ?? ""}
          />
        </h1>
        <h2 className="intro-subtitle">
          <IntroText
            {...introField("subtitle", t("title_card.subtitle_placeholder"), t("title_card.subtitle_label"))}
            pencilLabel={t("stage.edit_subtitle")}
            yText={subtitleYText}
            initialValue={story.subtitle ?? ""}
          />
        </h2>
        <div className="intro-byline">
          <IntroText
            {...introField("byline", t("title_card.byline_placeholder"), t("title_card.byline_label"))}
            pencilLabel={t("stage.edit_byline")}
            yText={bylineYText}
            initialValue={story.byline ?? ""}
            renderValue={(value) => <span dangerouslySetInnerHTML={{ __html: bylineHtml(value) }} />}
          />
        </div>
        {toc && <IntroToc titles={sectionTitles} />}
        <div className="intro-hint">
          <small>{t(layoutMode === "vertical" ? "stage.scroll_hint_mobile" : "stage.scroll_hint")}</small>
        </div>
      </div>
    </div>
  );
}
