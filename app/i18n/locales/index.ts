import type { Resource } from "i18next";

import enCommon from "./en/common.json";
import enAuth from "./en/auth.json";
import enConfig from "./en/config.json";
import enDashboard from "./en/dashboard.json";
import enOnboarding from "./en/onboarding.json";
import enEditor from "./en/editor.json";
import enStories from "./en/stories.json";
import enObjects from "./en/objects.json";
import enPublish from "./en/publish.json";
import enUpgrade from "./en/upgrade.json";

import esCommon from "./es/common.json";
import esAuth from "./es/auth.json";
import esConfig from "./es/config.json";
import esDashboard from "./es/dashboard.json";
import esEditor from "./es/editor.json";
import esOnboarding from "./es/onboarding.json";
import esStories from "./es/stories.json";
import esObjects from "./es/objects.json";
import esPublish from "./es/publish.json";
import esUpgrade from "./es/upgrade.json";

export default {
  en: {
    common: enCommon,
    auth: enAuth,
    config: enConfig,
    dashboard: enDashboard,
    editor: enEditor,
    onboarding: enOnboarding,
    stories: enStories,
    objects: enObjects,
    publish: enPublish,
    upgrade: enUpgrade,
  },
  es: {
    common: esCommon,
    auth: esAuth,
    config: esConfig,
    dashboard: esDashboard,
    editor: esEditor,
    onboarding: esOnboarding,
    stories: esStories,
    objects: esObjects,
    publish: esPublish,
    upgrade: esUpgrade,
  },
} satisfies Resource;
