/**
 * Telling what the Telar template shipped apart from what a person wrote.
 *
 * Every Telar site starts from the same template, and the template is not
 * empty: it seeds a starter story with three placeholder steps, a placeholder
 * object, one glossary term, and an about page in each language. Those rows
 * reach D1 through the same import as everything else and land there
 * unattributed, which leaves a backfill with no way to separate the two claims
 * it has to make — that nobody authored the seeded rows, and that the person
 * working alone on the site authored the rest.
 *
 * Identifier alone cannot make that separation, and the reason is the point of
 * this module. The starter story is where a new user does their first work:
 * they write over the placeholder question and answer rather than deleting the
 * story and starting again, so 78 of the 79 unattributed seeded steps in the
 * database hold text somebody wrote. A rule that reads `plantilla_en_blanco`
 * and stops would file all of it under the template and credit a person with
 * none of their own writing.
 *
 * So a row is the template's only while it still holds what the template
 * shipped. Edit the question, rename the term, rewrite the about page, and it
 * becomes yours — which is the same test `v130-ingest.server.ts` already
 * applies before replacing a page body, and the same one `publish.server.ts`
 * applies before treating a welcome message as still the default.
 *
 * The shipped values are recorded here rather than read from the template at
 * run time: a site created in May must still be recognised against what the
 * template shipped in May, and the live template only knows what it ships now.
 * `tests/template-coupling.live.test.ts` is where drift surfaces.
 *
 * @version v1.5.0-beta
 */

import { hashNormalized, normalizeBody } from "~/lib/v130-ingest.server";
import { STARTER_STORY_SLUGS, PLACEHOLDER_OBJECT_ID } from "~/lib/create-site.server";

/**
 * The starter story's title, per language, exactly as `project.csv` ships it.
 * A user who has replaced it has done the one thing the title asks for.
 */
const STARTER_STORY_TITLES: readonly string[] = [
  "replace me with your title",
  "reemplázame con tu título",
];

/**
 * What the starter story's three steps carry in their question and answer
 * cells. Both languages, and both cells must still hold one of them.
 */
const STARTER_STEP_QUESTIONS: readonly string[] = ["question", "pregunta"];
const STARTER_STEP_ANSWERS: readonly string[] = ["answer", "respuesta"];

/** The placeholder object's title, as `objects.csv` ships it. */
const PLACEHOLDER_OBJECT_TITLE = "telar placeholder";

/** The glossary term the template seeds. */
const TELAR_TERM_ID = "telar";

/**
 * Both definitions the template has shipped for the `telar` term, each a
 * bilingual block: an English paragraph, a blank line, then a Spanish one.
 *
 * Born-clean sites hold a single paragraph rather than the block, because
 * `languageMatchGlossary` rewrites the cell to the language the site was
 * created in. The paragraphs are split out of these same literals below rather
 * than written twice, so the two readings cannot drift apart.
 */
const TELAR_TERM_DEFINITIONS: readonly string[] = [
  "Telar is minimal-computing framework for creating layered IIIF visual narratives for digital scholarship, public exhibitions, community storytelling, and classroom projects. Learn more at [Telar.org](https://telar.org)\n\nTelar es un marco de computación mínima para crear narrativas visuales con capas de texto e imágenes IIIF para humanidades digitales, exposiciones públicas y contextos educativos y comunitarios. Aprende más en [Telar.org](https://telar.org)",
  "Telar (Spanish for 'loom') is a minimal-computing framework that weaves together IIIF images, audio, video, and texts to create layered visual narratives for digital scholarship, public exhibitions, community storytelling, and classroom projects. Learn more at [Telar.org](https://telar.org)\n\nTelar es un marco de computación mínima que entreteje imágenes IIIF, audio, video y textos en narrativas visuales por capas para humanidades digitales, exposiciones públicas, narrativa comunitaria y proyectos en el salón de clase. Aprende más en [Telar.org](https://telar.org)",
];

/** The slugs of the pages the template ships, one per language. */
export const TEMPLATE_PAGE_SLUGS: readonly string[] = ["about", "acerca"];

/**
 * SHA-256 of every about-page body the template has shipped, normalised.
 *
 * Hashes rather than literals because the bodies run to 2.6KB each and five of
 * them would bury everything else in this file. Each is labelled with where it
 * came from, and the two that the compositor still holds verbatim
 * (`V121_BODIES.about`, `ACERCA_MD_FULL`) are checked against these values in
 * `tests/template-content.test.ts`, so a hash cannot quietly stop matching the
 * literal it was taken from.
 */
const TEMPLATE_PAGE_BODY_HASHES: ReadonlyMap<string, string> = new Map([
  ["f8c6d222658abeb6f0f1b962e3b8cd609b2ca631b3d62c6b90abdaaa7f6b5b7d", "about.md — v1.2.1 (V121_BODIES.about)"],
  ["df4d8e3ae236fb8fd20155a057ec5776a25f59b394287f206cfa4fa928ff3cb3", "about.md — v1.3.0 (V130_BODIES.about)"],
  ["28c509e7b701b5b7d732226b290299463e9d38a4f0d67ee5093165c958ab78c5", "about.md — v1.3.1 (OpenSeadragon replaces Tify)"],
  ["1ccd4234a246e350035f5024a6bdc252c5fe65b19fb497028f3bdc6247354207", "acerca.md — v1.3.0 (ACERCA_MD_FULL)"],
  ["33595c388075e3ca0279869f743e5f18602cde72ce47a26a66ebde6c96f9694f", "acerca.md — v1.3.1 (OpenSeadragon replaces Tify)"],
]);

/**
 * A stored cell, reduced to what can be compared.
 *
 * Beyond the CRLF and whitespace `normalizeBody` handles, one trailing double
 * quote is dropped. That quote is an import artefact, not something anyone
 * typed: project 12 on staging holds the v1 `telar` definition character for
 * character with a `"` on the end, from a CSV cell whose closing quote was read
 * as content. Left in, it would file a seeded row as somebody's writing.
 */
function normaliseCell(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return normalizeBody(text).replace(/"$/, "");
}

/** Case-folded comparison, for the short cells where case carries no meaning. */
function folded(value: unknown): string {
  return normaliseCell(value).toLowerCase();
}

/** Every form the `telar` definition takes: both blocks, and each paragraph. */
const TELAR_TERM_FORMS: ReadonlySet<string> = new Set(
  TELAR_TERM_DEFINITIONS.flatMap((block) => [
    normalizeBody(block),
    ...block.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean),
  ]),
);

/**
 * Whether a story row is still the starter story the template ships.
 *
 * Both halves must hold: the slug the template uses AND the title it asks the
 * user to replace. A renamed starter story is the user's story.
 */
export function isTemplateStory(row: { story_id?: unknown; title?: unknown }): boolean {
  return (
    STARTER_STORY_SLUGS.includes(folded(row.story_id)) &&
    STARTER_STORY_TITLES.includes(folded(row.title))
  );
}

/**
 * Whether a step row is still one of the starter story's three seeded steps.
 *
 * The placeholder object, and both text cells untouched. A user who wrote a
 * question over `question` owns the step from that moment, which is the case
 * this whole module exists to get right.
 */
export function isTemplateStep(row: {
  object_id?: unknown;
  question?: unknown;
  answer?: unknown;
}): boolean {
  return (
    folded(row.object_id) === PLACEHOLDER_OBJECT_ID &&
    STARTER_STEP_QUESTIONS.includes(folded(row.question)) &&
    STARTER_STEP_ANSWERS.includes(folded(row.answer))
  );
}

/** Whether an object row is still the seeded placeholder. */
export function isTemplateObject(row: { object_id?: unknown; title?: unknown }): boolean {
  return (
    folded(row.object_id) === PLACEHOLDER_OBJECT_ID &&
    folded(row.title) === PLACEHOLDER_OBJECT_TITLE
  );
}

/** Whether a glossary row is still the seeded `telar` term, in any of its forms. */
export function isTemplateTerm(row: { term_id?: unknown; definition?: unknown }): boolean {
  return folded(row.term_id) === TELAR_TERM_ID && TELAR_TERM_FORMS.has(normaliseCell(row.definition));
}

/**
 * Whether a page row is still an about page the template shipped.
 *
 * Async because the comparison is a hash; see `TEMPLATE_PAGE_BODY_HASHES` for
 * why the bodies are not held verbatim.
 */
export async function isTemplatePage(row: {
  slug?: unknown;
  body?: unknown;
}): Promise<boolean> {
  if (!TEMPLATE_PAGE_SLUGS.includes(folded(row.slug))) return false;
  const body = typeof row.body === "string" ? row.body : "";
  return TEMPLATE_PAGE_BODY_HASHES.has(await hashNormalized(normaliseCell(body)));
}

/**
 * Layers are never the template's: it ships none. Stated as a function so a
 * caller sweeping all six kinds has something to call, and so the claim is
 * somewhere a test can hold it.
 */
/**
 * Whether this row was SEEDED with text the template shipped — which is a
 * weaker and wider test than the predicates above, and answers a different
 * question.
 *
 * Those ask whether a row is STILL the template's, which is what deciding its
 * authorship needs: a row somebody has written over is theirs. This asks whether
 * the template put words in it, which is what counting words needs, and the
 * answer stays yes after an edit. A person who corrects a sentence in the About
 * page has not written the other two hundred and fifty, and there is nothing in
 * the text to say which of them are hers — so the honest count is no count.
 *
 * Measured on staging before this existed: of 371 words a words backfill would
 * have credited, 313 were the shipped glossary definition and the shipped About
 * page. Eighty-four per cent of the total, attributed to somebody who wrote none
 * of it.
 *
 * Identity only — the slug, the term id, the story id — never the body, because
 * the body is exactly what an edit changes.
 */
export function isTemplateSeeded(
  kind: string,
  row: { story_id?: unknown; object_id?: unknown; term_id?: unknown; slug?: unknown; title?: unknown; question?: unknown; answer?: unknown },
): boolean {
  switch (kind) {
    case "story":
      return isTemplateStory(row);
    case "step":
      return isTemplateStep(row as { object_id?: unknown; question?: unknown; answer?: unknown });
    case "object":
      return isTemplateObject(row);
    case "term":
      return typeof row.term_id === "string" && row.term_id.trim().toLowerCase() === TELAR_TERM_ID;
    case "page":
      return typeof row.slug === "string"
        && TEMPLATE_PAGE_SLUGS.includes(row.slug.trim().toLowerCase());
    default:
      return false;
  }
}

export function isTemplateLayer(): boolean {
  return false;
}

/** The labelled hash table, for the test that checks it against the literals. */
export const TEMPLATE_PAGE_BODY_HASH_LABELS = TEMPLATE_PAGE_BODY_HASHES;
