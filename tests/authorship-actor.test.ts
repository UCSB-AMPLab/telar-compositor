/**
 * `created_by_actor` says what made a row when no person did.
 *
 * `created_by` points at a user, so null had to carry three unrelated cases at
 * once: the starter content the Telar template ships, content imported from a
 * repo and authored outside the compositor, and content older than the column.
 * A view built on that must render all three as "unknown", which reads to a
 * student as "nobody" — the one thing it must never say about work somebody did.
 *
 * What these hold to:
 *
 *   - The import writes an actor on every row it inserts, and NEVER writes the
 *     importing user as the author. That user becomes convenor in the same
 *     step, so crediting them for a repo's CSVs — and for whatever anyone later
 *     writes into those rows — is worse than an honest null.
 *   - Template starter content is distinguished from the repo's own.
 *   - The column never enters the Yjs document, so no snapshot SET clause
 *     mentions it and no client can write it.
 *   - An actor this build cannot name reads as unknown, not as a label.
 *
 * @version v1.5.0-beta
 */

import { describe, it, expect } from "vitest";

import {
  AUTHOR_ACTORS,
  isAuthorActor,
  preservedActor,
  readAuthorship,
} from "../app/lib/authorship";
import {
  actorForImportedObject,
  actorForImportedPage,
  actorForImportedStep,
  actorForImportedStory,
  actorForImportedTerm,
} from "../app/lib/import.server";
import { V121_BODIES } from "../app/lib/v130-ingest.server";
import { STARTER_STORY_SLUGS, PLACEHOLDER_OBJECT_ID } from "../app/lib/create-site.server";

describe("reading a row's authorship", () => {
  it("names the person when there is one", () => {
    expect(readAuthorship({ created_by: 7, created_by_actor: null })).toEqual({
      kind: "person",
      userId: 7,
    });
  });

  it("names the actor when no person made the row", () => {
    expect(readAuthorship({ created_by: null, created_by_actor: "telar_template" })).toEqual({
      kind: "actor",
      actor: AUTHOR_ACTORS.telarTemplate,
    });
  });

  it("is unknown when neither column answers", () => {
    // Roughly three-quarters of the steps in the database. Unknown, never
    // nobody — the distinction the whole module exists for.
    expect(readAuthorship({ created_by: null, created_by_actor: null })).toEqual({
      kind: "unknown",
    });
    expect(readAuthorship({})).toEqual({ kind: "unknown" });
  });

  it("prefers a person over an actor if a row somehow carries both", () => {
    // Should not occur — the import writes an actor precisely because it has no
    // person to write. If it ever does, hiding somebody's authorship behind a
    // label is the worse failure.
    expect(readAuthorship({ created_by: 7, created_by_actor: "imported" })).toEqual({
      kind: "person",
      userId: 7,
    });
  });

  it("reads an actor it cannot name as unknown rather than inventing a label", () => {
    // What an older build sees after a rollback, if a newer one added an actor.
    expect(readAuthorship({ created_by: null, created_by_actor: "seeded_by_future" })).toEqual({
      kind: "unknown",
    });
    expect(isAuthorActor("seeded_by_future")).toBe(false);
    expect(isAuthorActor(undefined)).toBe(false);
    expect(isAuthorActor(7)).toBe(false);
  });
});

describe("carrying the actor across a stale-id re-INSERT", () => {
  it("carries a stored value through", () => {
    expect(preservedActor({ created_by_actor: "imported" })).toBe("imported");
  });

  it("carries a value this build cannot name, rather than losing provenance", () => {
    // It is a bound parameter going back into the column it came from, and the
    // read path already treats an unrecognised actor as unknown. Dropping it
    // would lose a real answer to protect against nothing.
    expect(preservedActor({ created_by_actor: "seeded_by_future" })).toBe("seeded_by_future");
  });

  it("binds null when there is nothing to carry", () => {
    expect(preservedActor(undefined)).toBe(null);
    expect(preservedActor({})).toBe(null);
    expect(preservedActor({ created_by_actor: "" })).toBe(null);
    expect(preservedActor({ created_by_actor: 7 })).toBe(null);
  });
});

describe("what the import says made each row", () => {
  /** The titles the template ships alongside its two starter-story slugs. */
  const STARTER_TITLES: Record<string, string> = {
    blank_template: "replace me with your title",
    plantilla_en_blanco: "reemplázame con tu título",
  };

  it("attributes the template's starter story to the template, in both languages", () => {
    // Both slugs, because the template ships one starter story per language and
    // a site created in Spanish carries the Spanish one.
    expect(STARTER_STORY_SLUGS.length).toBeGreaterThan(1);
    for (const slug of STARTER_STORY_SLUGS) {
      expect(actorForImportedStory({ story_id: slug, title: STARTER_TITLES[slug] }))
        .toBe(AUTHOR_ACTORS.telarTemplate);
    }
  });

  it("hands the starter story to the import once it has been titled", () => {
    // The slug survives a rename of the title, and the title is the thing the
    // template asks the user to replace first. A site whose starter story is
    // called something is a site somebody has worked on.
    expect(actorForImportedStory({ story_id: "plantilla_en_blanco", title: "Mi historia" }))
      .toBe(AUTHOR_ACTORS.imported);
  });

  it("attributes the repo's own stories to the import, not to the template", () => {
    expect(actorForImportedStory({ story_id: "mi-historia", title: "Mi historia" }))
      .toBe(AUTHOR_ACTORS.imported);
    expect(actorForImportedStory({ story_id: "blank_template_notes", title: "Notes" }))
      .toBe(AUTHOR_ACTORS.imported);
  });

  it("reads a cell through case and surrounding space", () => {
    // Story ids and titles arrive from a CSV cell, so they carry whatever the
    // sheet had.
    expect(actorForImportedStory({
      story_id: `  ${STARTER_STORY_SLUGS[0].toUpperCase()} `,
      title: "  REPLACE ME WITH YOUR TITLE  ",
    })).toBe(AUTHOR_ACTORS.telarTemplate);
  });

  it("never leaves an imported row without an actor, whatever the cell held", () => {
    // The point of returning an actor rather than a nullable: a row with no
    // person and no actor is indistinguishable from pre-column content, and
    // that is the ambiguity this release exists to remove.
    for (const value of [undefined, null, "", "   ", 7, {}]) {
      expect(actorForImportedStory({ story_id: value, title: value }))
        .toBe(AUTHOR_ACTORS.imported);
      expect(actorForImportedObject({ object_id: value, title: value }))
        .toBe(AUTHOR_ACTORS.imported);
      expect(actorForImportedTerm({ term_id: value, definition: value }))
        .toBe(AUTHOR_ACTORS.imported);
      expect(actorForImportedStep({ object_id: value, question: value, answer: value }, true))
        .toBe(AUTHOR_ACTORS.imported);
    }
  });

  it("attributes the template's placeholder object to the template", () => {
    expect(actorForImportedObject({ object_id: PLACEHOLDER_OBJECT_ID, title: "Telar placeholder" }))
      .toBe(AUTHOR_ACTORS.telarTemplate);
    expect(actorForImportedObject({ object_id: "mi-mapa-1600", title: "Mapa" }))
      .toBe(AUTHOR_ACTORS.imported);
  });

  it("gives a seeded step to the template only while its story is the template's too", () => {
    const seeded = { object_id: PLACEHOLDER_OBJECT_ID, question: "pregunta", answer: "respuesta" };

    expect(actorForImportedStep(seeded, true)).toBe(AUTHOR_ACTORS.telarTemplate);
    // Same cells, but hanging off a story somebody named.
    expect(actorForImportedStep(seeded, false)).toBe(AUTHOR_ACTORS.imported);
  });

  it("gives a written-in step to the import, however seeded its story", () => {
    // The case that matters: people write over the placeholders rather than
    // starting a story of their own.
    expect(actorForImportedStep(
      { object_id: PLACEHOLDER_OBJECT_ID, question: "¿Qué vemos aquí?", answer: "respuesta" },
      true,
    )).toBe(AUTHOR_ACTORS.imported);
  });

  it("recognises the seeded glossary term and nothing else", () => {
    const shipped = "Telar es un marco de computación mínima que entreteje imágenes IIIF, audio, video y textos en narrativas visuales por capas para humanidades digitales, exposiciones públicas, narrativa comunitaria y proyectos en el salón de clase. Aprende más en [Telar.org](https://telar.org)";

    expect(actorForImportedTerm({ term_id: "telar", definition: shipped }))
      .toBe(AUTHOR_ACTORS.telarTemplate);
    expect(actorForImportedTerm({ term_id: "telar", definition: `${shipped} Y algo más.` }))
      .toBe(AUTHOR_ACTORS.imported);
  });

  it("recognises an about page by its body, not by its slug", async () => {
    expect(await actorForImportedPage({ slug: "about", body: V121_BODIES.about }))
      .toBe(AUTHOR_ACTORS.telarTemplate);
    expect(await actorForImportedPage({ slug: "about", body: "# About the Fall 2026 seminar" }))
      .toBe(AUTHOR_ACTORS.imported);
  });
});
