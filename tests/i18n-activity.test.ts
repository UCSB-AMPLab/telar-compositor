/**
 * Parity guard for the activity-feed enum translations.
 *
 * The feed renders `verb` and `entity_type` — stable English enum values from
 * activity.server — through `t("activity.verb.*")` / `t("activity.entity.*")`.
 * If someone adds a new verb or entity type to the enum without adding the
 * matching i18n key, the feed would silently fall back to the raw English
 * token. This test fails the build in that case, in both locales.
 */

import { describe, it, expect } from "vitest";
import {
  ACTIVITY_VERBS,
  ACTIVITY_ENTITY_TYPES,
} from "~/lib/activity.server";
import enStart from "~/i18n/locales/en/start.json";
import esStart from "~/i18n/locales/es/start.json";

const locales = { en: enStart, es: esStart } as Record<string, typeof enStart>;

describe("activity feed i18n parity", () => {
  for (const [name, bundle] of Object.entries(locales)) {
    const activity = (bundle as { activity: { verb: Record<string, string>; entity: Record<string, string>; someone: string } }).activity;

    it(`${name}: every activity verb has a translation`, () => {
      for (const verb of ACTIVITY_VERBS) {
        expect(activity.verb[verb], `missing ${name} activity.verb.${verb}`).toBeTruthy();
      }
    });

    it(`${name}: every activity entity type has a translation`, () => {
      for (const type of ACTIVITY_ENTITY_TYPES) {
        expect(activity.entity[type], `missing ${name} activity.entity.${type}`).toBeTruthy();
      }
    });

    it(`${name}: has an anonymous-actor fallback`, () => {
      expect(activity.someone).toBeTruthy();
    });
  }
});
