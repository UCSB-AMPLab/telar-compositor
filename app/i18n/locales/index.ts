import type { Resource } from "i18next";

import enCommon from "./en/common.json";
import enAuth from "./en/auth.json";
import enDashboard from "./en/dashboard.json";

import esCommon from "./es/common.json";
import esAuth from "./es/auth.json";
import esDashboard from "./es/dashboard.json";

export default {
  en: {
    common: enCommon,
    auth: enAuth,
    dashboard: enDashboard,
  },
  es: {
    common: esCommon,
    auth: esAuth,
    dashboard: esDashboard,
  },
} satisfies Resource;
