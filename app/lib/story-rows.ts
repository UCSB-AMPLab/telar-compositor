/**
 * Which of a story's steps its CSV carries, and which of a step's layers are
 * panels — the rules publish writes by, in a module the editor can take too.
 *
 * Publish leaves a fully empty step out of the story CSV, so the site has no
 * step for it, and the editor's scenes (`sceneRun`) must leave out the same
 * steps to group as the site does. Both read the predicate from here.
 *
 * @version v1.5.0-beta
 */

import { hasStoryRowContent, parseExtraColumns } from "~/lib/extra-columns";
import { pythonStrip } from "~/lib/python-whitespace";
import { cleanText } from "~/lib/unsafe-text";

/** The fields of a step that decide whether its story CSV carries it. */
export interface StepContent {
  /** Absent reads as a media step. */
  kind?: "media" | "section";
  object_id: string | null;
  question: string | null;
  answer: string | null;
  /** The step's kept cells as stored; absent, empty or corrupt is none. */
  extra_columns?: string | null;
  layers: ReadonlyArray<{ title: string | null; content: string | null }>;
}

/**
 * A layer's body as its file is written: cleaned of the characters a Telar
 * build rejects, then stripped as the framework strips it (`str.strip()` in
 * `_split_frontmatter`, the framework's scripts/telar/markdown.py:99-111), which
 * is also what the import reads back. A layer is written only when this is not
 * empty.
 *
 * Cleaning comes first so that the emission test and the rule guard both see
 * the text as it will be committed: a body of nothing but rejected characters
 * writes no file, and a rule that cleaning makes (`-\uFFFE--`) is guarded.
 * Stripping here matches the framework, which strips a layer body
 * (markdown.py:111, :132), and the import, which reads it back stripped. So a
 * non-empty body is committed with its edges stripped (" Body \n" is written
 * "Body"). A layer whose title and body are both only whitespace or rejected
 * characters is no panel (`isPanel`), writes no file and takes no filename;
 * since filenames are assigned in order, that can shift the fallback name of
 * a later layer whose title duplicates another's.
 *
 * What the story renderer guarantees, with the import's parse:
 *
 * - Compare equality, for any D1 rows: the compare form of the rows equals the
 *   compare form of the files they render to. The import strips cell edges on
 *   both sides alike, so this holds with edge whitespace in any cell. It is
 *   what the change check relies on.
 * - Byte idempotence, render(parse(render(x))) = render(x), for rows whose
 *   text cells, once cleaned, have no whitespace at their edges and whose
 *   steps the import keeps. CSV cells are written as they stand, not
 *   stripped: the framework reads an answer unstripped (stories.py:666-676),
 *   so an answer indented four spaces is a code block on the site, while the
 *   import strips it.
 */
export function layerBody(content: string | null | undefined): string {
  return pythonStrip(cleanText(content ?? ""));
}

/**
 * Whether a layer is a panel, and so written: its title or its body, each
 * cleaned then stripped (`layerBody`), has visible text.
 *
 * The framework decides a panel from `layerN_title` and `layerN_text`: the
 * Layer 1 trigger (the framework's _includes/story-step.html:66), the Layer 2
 * trigger (assets/js/telar-story/panels.js:292) and the keyboard checks
 * (panels.js:360-376). A file holding only a title is read as (title, "")
 * (markdown.py:104), so a title with visible text is a panel with no body.
 *
 * The framework's HTML test is `title != ""` with no strip, so it would render
 * an empty trigger for a title of spaces or of rejected characters. The
 * Compositor publishes panels with visible text only: such a layer is not
 * written, nothing visible is lost, and a blank-title edit on GitHub is not
 * content to the comparison (`title: ""` and `title: " "` compare equal).
 *
 * A button label alone is not a panel either: the trigger's label is read
 * only once the trigger renders (story-step.html:69). The import reads a
 * title-only file back as a layer with that title and no body, so the test
 * agrees with the parse.
 */
export function isPanel(layer: { title: string | null; content: string | null } | null): boolean {
  return layer !== null && (layerBody(layer.title) !== "" || layerBody(layer.content) !== "");
}

/**
 * Returns true if a step is "fully empty" — no content, no object, no layers.
 * Fully empty steps are skipped during publish (they are not valid rows), so
 * the site has no step for them and groups its scenes without them.
 */
export function isFullyEmptyStep(step: StepContent): boolean {
  // A section step is a heading card that is meaningful on its own (its title
  // lives outside object/question/answer/layer content), so it must never be
  // dropped — even when titled-but-otherwise-empty.
  if (step.kind === "section") return false;
  if (step.object_id) return false;
  if (step.question) return false;
  if (step.answer) return false;
  if (step.layers.some((l) => isPanel(l))) return false;
  // A kept cell is content the framework reads: it keeps any row with a
  // non-empty cell, and `layer3_content` is processed like the first two.
  // Cells in the columns it drops first are not (see `hasStoryRowContent`).
  if (hasStoryRowContent(parseExtraColumns(step.extra_columns))) return false;
  return true;
}
