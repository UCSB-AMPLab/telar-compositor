/**
 * The heading a layer panel shows, as the published site derives it.
 *
 * The framework heads a panel with its title, else the label of the button
 * that opens it, else the site language's default label for that button
 * (`getPanelContent` in the framework's assets/js/telar-story/panels.js:
 * `layer1_title || layer1_button || learnMore`, and `goDeeper` for layer 2).
 * The default labels are `buttons.learn_more` and `buttons.go_deeper` in the
 * framework's `_data/languages/{en,es}.yml`; the site's language is
 * `telar_language`, and any value other than `es` reads the English file
 * (`_layouts/story.html:49-53`).
 *
 * A title or label counts when it has visible text: the publish writes
 * neither a title nor a panel of only whitespace (`isPanel`, publish.server.ts).
 *
 * The same rule decides what a publish writes for a panel with no title of
 * its own that must be written, and what the import reads back from it
 * (`derivedHeadingOf`, `readsAsUntitledLayer1`).
 *
 * @version v1.5.0-beta
 */

/** The framework's default button labels, by site language and layer. */
export const PANEL_DEFAULT_LABELS = {
  en: { 1: "Learn more", 2: "Go deeper" },
  es: { 1: "Saber más", 2: "Profundizar" },
} as const;

/** The language file the framework reads for a site's `telar_language`. */
export function siteLanguageOf(lang: string | null | undefined): "en" | "es" {
  return lang === "es" ? "es" : "en";
}

function visible(text: string | null | undefined): text is string {
  return typeof text === "string" && text.trim() !== "";
}

/**
 * The heading the site shows for a panel with no title of its own: its
 * button's label, else the default label in the site's language.
 */
export function derivedHeadingOf(
  layerNumber: number,
  buttonLabel: string | null | undefined,
  lang: string | null | undefined,
): string {
  if (visible(buttonLabel)) return buttonLabel;
  return PANEL_DEFAULT_LABELS[siteLanguageOf(lang)][layerNumber === 2 ? 2 : 1];
}

/** The heading the site shows for a panel: its title, else `derivedHeadingOf`. */
export function panelHeading(
  layerNumber: number,
  title: string | null | undefined,
  buttonLabel: string | null | undefined,
  lang: string | null | undefined,
): string {
  return visible(title) ? title : derivedHeadingOf(layerNumber, buttonLabel, lang);
}

/** A layer as a publish or an import reads it: its title, text and button label, empty or absent alike. */
interface LayerText {
  title?: string | null;
  content?: string | null;
  button_label?: string | null;
}

/** Layer 1's default button label in every language the framework ships. */
const LAYER1_DEFAULT_LABELS: readonly string[] = Object.values(PANEL_DEFAULT_LABELS).map((labels) => labels[1]);

/**
 * Whether layer 1's title reads as no title: layer 1 has no text, its layer
 * 2 has a title or text (so a publish writes layer 1, to draw layer 2's
 * button), and the title is the heading a publish writes for such a layer 1
 * with no title of its own: its button label where it has one, else the
 * default layer-1 label in whichever language the framework ships. The read
 * is the exact inverse of that write, and needs no language, so a file is
 * read the same whichever language the Compositor or the repository states
 * now (import.server.ts `mapStoryCsv`, story-content.server.ts). A title
 * identical to the heading the site derives shows the reader nothing a
 * missing title would not, and reads as none on every side.
 */
export function readsAsUntitledLayer1(layer1: LayerText, layer2: LayerText | null): boolean {
  if (visible(layer1.content) || !visible(layer1.title)) return false;
  if (!layer2 || (!visible(layer2.title) && !visible(layer2.content))) return false;
  return visible(layer1.button_label) ? layer1.title === layer1.button_label : LAYER1_DEFAULT_LABELS.includes(layer1.title);
}
