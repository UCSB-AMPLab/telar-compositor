import type { Resource } from "i18next";

import enCommon from "./en/common.json";
import enAuth from "./en/auth.json";
import enConfig from "./en/config.json";
import enDashboard from "./en/dashboard.json";
import enOnboarding from "./en/onboarding.json";

import esCommon from "./es/common.json";
import esAuth from "./es/auth.json";
import esConfig from "./es/config.json";
import esDashboard from "./es/dashboard.json";
import esOnboarding from "./es/onboarding.json";

export default {
  en: {
    common: enCommon,
    auth: enAuth,
    config: enConfig,
    dashboard: enDashboard,
    onboarding: enOnboarding,
  },
  es: {
    common: esCommon,
    auth: esAuth,
    config: esConfig,
    dashboard: esDashboard,
    onboarding: esOnboarding,
  },
} satisfies Resource;
