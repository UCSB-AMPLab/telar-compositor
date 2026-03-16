/**
 * Shared i18n configuration for Telar Compositor.
 *
 * Used by both server-side (i18next.server.ts) and client-side (i18next.client.ts)
 * setup to keep language configuration in one place.
 */

export const supportedLanguages = ["en", "es"] as const;

export const fallbackLanguage = "en" as const;

export const defaultNS = "common" as const;

export const namespaces = [
  "common",
  "auth",
  "dashboard",
  "editor",
  "objects",
  "publish",
  "onboarding",
  "config",
  "stories",
] as const;

export type SupportedLanguage = (typeof supportedLanguages)[number];
