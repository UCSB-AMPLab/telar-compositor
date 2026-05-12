/**
 * This file pins constants integrity for `app/lib/v130-framework-labels.ts`,
 * the source-of-truth module that holds the framework v1.3.0 landing copy
 * the compositor renders into a freshly-created site's _config.yml.
 *
 * EN values are verbatim from the v1.3.0 lang pack; ES values are verbatim
 * from the v1.3.0 es.yml lang pack (objects_heading/objects_intro/
 * WELCOME_BODY_LOCALISED.es) plus the explicit compositor placeholders
 * `stories_heading` ("Stories" / "Historias").
 *
 * @version v1.2.0-beta
 */

import { describe, it, expect } from "vitest";
import {
  WELCOME_BODY_LOCALISED,
  LANDING_LABELS,
} from "~/lib/v130-framework-labels";

describe("WELCOME_BODY_LOCALISED", () => {
  it("has en + es keys", () => {
    expect(WELCOME_BODY_LOCALISED).toHaveProperty("en");
    expect(WELCOME_BODY_LOCALISED).toHaveProperty("es");
  });

  it("en welcome body is non-empty markdown opening with the demo-site heading", () => {
    expect(WELCOME_BODY_LOCALISED.en).toContain("## Welcome to the Telar demo site");
    expect(WELCOME_BODY_LOCALISED.en).toContain("Telar Compositor");
    expect(WELCOME_BODY_LOCALISED.en.length).toBeGreaterThan(200);
  });

  it("es welcome body is non-empty markdown opening with the Spanish demo-site heading", () => {
    expect(WELCOME_BODY_LOCALISED.es).toContain("## Bienvenidos a Telar");
    expect(WELCOME_BODY_LOCALISED.es).toContain("Telar Compositor");
    expect(WELCOME_BODY_LOCALISED.es.length).toBeGreaterThan(200);
  });
});

describe("LANDING_LABELS", () => {
  it("en has all three keys with the expected compositor + framework values", () => {
    expect(LANDING_LABELS.en.stories_heading).toBe("Stories");
    expect(LANDING_LABELS.en.objects_heading).toBe(
      "See the objects behind the stories",
    );
    expect(LANDING_LABELS.en.objects_intro).toBe(
      "Browse {count} objects featured in the stories.",
    );
  });

  it("es mirrors the en shape", () => {
    expect(Object.keys(LANDING_LABELS.es)).toEqual(
      Object.keys(LANDING_LABELS.en),
    );
  });

  it("es has all three keys with the expected compositor + framework values", () => {
    expect(LANDING_LABELS.es.stories_heading).toBe("Historias");
    expect(LANDING_LABELS.es.objects_heading).toBe(
      "Explora los objetos detrás de las historias",
    );
    expect(LANDING_LABELS.es.objects_intro).toBe(
      "Explora {count} objetos presentes en las historias.",
    );
  });

  it("objects_intro preserves the literal {count} placeholder in both languages", () => {
    expect(LANDING_LABELS.en.objects_intro).toContain("{count}");
    expect(LANDING_LABELS.es.objects_intro).toContain("{count}");
  });
});
