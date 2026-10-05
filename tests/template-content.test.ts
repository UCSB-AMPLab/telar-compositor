/**
 * The line between what the template shipped and what a person wrote.
 *
 * Everything here is measured against rows that exist. The fixtures are the
 * real values staging holds — the born-clean Spanish glossary paragraph, the
 * v1 definition with the import's stray quote on the end, the renamed and
 * rewritten term on project 10 — because the failure this module has to avoid
 * is a plausible-looking rule that files somebody's writing under the template,
 * and only real rows show what people actually do to seeded content.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import {
  isTemplateStory,
  isTemplateStep,
  isTemplateObject,
  isTemplateTerm,
  isTemplatePage,
  isTemplateLayer,
  TEMPLATE_PAGE_BODY_HASH_LABELS,
} from "~/lib/template-content.server";
import { V121_BODIES, ACERCA_MD_FULL, hashNormalized, normalizeBody } from "~/lib/v130-ingest.server";

/** The Spanish half a born-clean site keeps, verbatim from staging project 18. */
const BORN_CLEAN_ES_DEFINITION =
  "Telar es un marco de computación mínima que entreteje imágenes IIIF, audio, video y textos en narrativas visuales por capas para humanidades digitales, exposiciones públicas, narrativa comunitaria y proyectos en el salón de clase. Aprende más en [Telar.org](https://telar.org)";

/** The bilingual block the template shipped before June 2026. */
const V1_DEFINITION =
  "Telar is minimal-computing framework for creating layered IIIF visual narratives for digital scholarship, public exhibitions, community storytelling, and classroom projects. Learn more at [Telar.org](https://telar.org)\n\nTelar es un marco de computación mínima para crear narrativas visuales con capas de texto e imágenes IIIF para humanidades digitales, exposiciones públicas y contextos educativos y comunitarios. Aprende más en [Telar.org](https://telar.org)";

describe("the starter story", () => {
  it("is the template's while it still carries the title it asks you to replace", () => {
    expect(isTemplateStory({ story_id: "plantilla_en_blanco", title: "reemplázame con tu título" })).toBe(true);
    expect(isTemplateStory({ story_id: "blank_template", title: "replace me with your title" })).toBe(true);
  });

  it("becomes the user's the moment they title it", () => {
    expect(isTemplateStory({ story_id: "plantilla_en_blanco", title: "Mi historia" })).toBe(false);
  });

  it("is not claimed for a story that merely looks seeded", () => {
    expect(isTemplateStory({ story_id: "mi-historia", title: "replace me with your title" })).toBe(false);
  });
});

describe("the starter story's steps", () => {
  it("are the template's while both cells hold the shipped placeholders", () => {
    expect(isTemplateStep({ object_id: "telar-placeholder", question: "question", answer: "answer" })).toBe(true);
    expect(isTemplateStep({ object_id: "telar-placeholder", question: "pregunta", answer: "respuesta" })).toBe(true);
  });

  it("belong to whoever writes in them", () => {
    // The case the module exists for: 78 of the 79 unattributed seeded steps
    // in the database hold text somebody wrote into a step they did not create.
    expect(isTemplateStep({
      object_id: "telar-placeholder",
      question: "What is happening in this image?",
      answer: "answer",
    })).toBe(false);
  });

  it("stop being the template's once the object is swapped", () => {
    expect(isTemplateStep({ object_id: "mi-objeto", question: "question", answer: "answer" })).toBe(false);
  });

  it("treats a cleared cell as somebody having acted on it", () => {
    expect(isTemplateStep({ object_id: "telar-placeholder", question: null, answer: "answer" })).toBe(false);
  });
});

describe("the placeholder object", () => {
  it("is the template's while it holds the shipped id and title", () => {
    expect(isTemplateObject({ object_id: "telar-placeholder", title: "Telar placeholder" })).toBe(true);
  });

  it("is the user's once retitled", () => {
    expect(isTemplateObject({ object_id: "telar-placeholder", title: "Retrato de una mujer" })).toBe(false);
  });
});

describe("the seeded glossary term", () => {
  it("matches the bilingual block the template ships", () => {
    expect(isTemplateTerm({ term_id: "telar", definition: V1_DEFINITION })).toBe(true);
  });

  it("matches the single paragraph a born-clean site keeps", () => {
    // languageMatchGlossary rewrites the cell to one language at create time,
    // so the block never reaches D1 on a born-clean site.
    expect(isTemplateTerm({ term_id: "telar", definition: BORN_CLEAN_ES_DEFINITION })).toBe(true);
  });

  it("sees past the stray quote the import leaves on the end", () => {
    // Staging project 12 holds exactly this: the shipped text plus a closing
    // CSV quote read as content. Nobody typed that character.
    expect(isTemplateTerm({ term_id: "telar", definition: `${V1_DEFINITION}"` })).toBe(true);
  });

  it("is the user's once they have written in it", () => {
    // Staging project 2: the shipped definition with a sentence added.
    expect(isTemplateTerm({
      term_id: "telar",
      definition: `${V1_DEFINITION}\n\nHere is a change.`,
    })).toBe(false);
  });

  it("is the user's once renamed", () => {
    // Staging project 10, which also edited the text ("creatingx").
    expect(isTemplateTerm({ term_id: "telar-renamed", definition: V1_DEFINITION })).toBe(false);
  });
});

describe("the about pages", () => {
  it("recognises every body the template has shipped", async () => {
    expect(await isTemplatePage({ slug: "about", body: V121_BODIES.about })).toBe(true);
    const acercaBody = ACERCA_MD_FULL.replace(/^---\n[\s\S]*?\n---\n/, "");
    expect(await isTemplatePage({ slug: "acerca", body: acercaBody })).toBe(true);
  });

  it("hands the page back once somebody customises it", async () => {
    // Which the shipped body invites in as many words.
    expect(await isTemplatePage({
      slug: "about",
      body: `${V121_BODIES.about}\n\nThis project was made by the Fall 2026 seminar.`,
    })).toBe(false);
  });

  it("claims nothing from a page the user made", async () => {
    expect(
      await isTemplatePage({
        slug: "image-fixture",
        body: "\nFixture: a page carrying an image given as a bare file name, so the build's image path can be checked on a site with a baseurl.\n\n![Image fixture](figueroa.jpg)\n",
      }),
    ).toBe(false);
    expect(await isTemplatePage({ slug: "credits", body: V121_BODIES.about })).toBe(false);
  });

  it("holds a hash for each literal the compositor still carries", async () => {
    // The hashes are opaque; this is what stops one drifting from the body it
    // was taken from without anything noticing.
    const v121 = await hashNormalized(normalizeBody(V121_BODIES.about));
    const acerca = await hashNormalized(
      normalizeBody(ACERCA_MD_FULL.replace(/^---\n[\s\S]*?\n---\n/, "")),
    );
    expect(TEMPLATE_PAGE_BODY_HASH_LABELS.has(v121)).toBe(true);
    expect(TEMPLATE_PAGE_BODY_HASH_LABELS.has(acerca)).toBe(true);
  });
});

describe("layers", () => {
  it("are never the template's, because it ships none", () => {
    expect(isTemplateLayer()).toBe(false);
  });
});
