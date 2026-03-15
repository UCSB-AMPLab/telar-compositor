/**
 * Sign-in page — GitHub OAuth entry point.
 *
 * Split layout: branded left panel + sign-in form right panel.
 * loader: redirects to /dashboard if already authenticated.
 * action: generates CSRF state, stores in cookie, redirects to GitHub authorize URL.
 */

import { redirect, Form, useNavigation, useSearchParams } from "react-router";
import { Github, AlertCircle } from "lucide-react";
import { useState } from "react";
import type { Route } from "./+types/_auth.signin";
import { createSessionStorage, createStateCookieStorage } from "~/lib/session.server";
import { Footer } from "~/components/layout/Footer";

export const handle = { i18n: ["common", "auth"] };

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = context.cloudflare.env as Env;
  const sessionStorage = createSessionStorage(env.SESSION_SECRET);
  const session = await sessionStorage.getSession(request.headers.get("Cookie"));

  if (session.get("userId")) {
    throw redirect("/dashboard");
  }

  return null;
}

export async function action({ request, context }: Route.ActionArgs) {
  const env = context.cloudflare.env as Env;
  const stateCookieStorage = createStateCookieStorage(env.SESSION_SECRET);

  const state = crypto.randomUUID();
  const stateSession = await stateCookieStorage.getSession();
  stateSession.set("oauth_state", state);

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: env.GITHUB_CALLBACK_URL,
    state,
    scope: "repo read:user user:email",
  });

  const githubUrl = `https://github.com/login/oauth/authorize?${params.toString()}`;

  return redirect(githubUrl, {
    headers: {
      "Set-Cookie": await stateCookieStorage.commitSession(stateSession),
    },
  });
}

const content = {
  en: {
    title: "Welcome to Telar",
    tagline: "Compose visual stories without touching code",
    button: "Sign in with GitHub",
    features: {
      compose: "Compose stories visually with a WYSIWYG editor",
      manage: "Manage images and IIIF objects in one place",
      publish: "Publish to GitHub Pages with one click",
    },
    session_expired: "Your session has expired. Please sign in again.",
    error: "There was a problem signing in. Please check your GitHub permissions and try again.",
    toggle_label: "ES",
    other_lang: "es",
  },
  es: {
    title: "Bienvenido a Telar",
    tagline: "Compone historias visuales sin tocar código",
    button: "Iniciar sesión con GitHub",
    features: {
      compose: "Compone historias visualmente con un editor WYSIWYG",
      manage: "Gestiona imágenes y objetos IIIF en un solo lugar",
      publish: "Publica en GitHub Pages con un clic",
    },
    session_expired: "Tu sesión ha expirado. Por favor inicia sesión de nuevo.",
    error: "Hubo un problema al iniciar sesión. Verifica los permisos de GitHub e intenta de nuevo.",
    toggle_label: "EN",
    other_lang: "en",
  },
};

export default function SignIn() {
  const [searchParams] = useSearchParams();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const reason = searchParams.get("reason");
  const errorParam = searchParams.get("error");

  const [lang, setLang] = useState<"en" | "es">("en");
  const t = content[lang];

  return (
    <div className="min-h-screen flex flex-col">
      {/* Main split layout */}
      <div className="flex-1 flex flex-col md:flex-row">
        {/* Left panel — branded */}
        <div className="bg-cream flex flex-col justify-between p-10 md:w-1/2 lg:w-2/5">
          <div>
            {/* Brand */}
            <div className="mb-10">
              <span className="font-heading font-bold text-2xl tracking-widest text-charcoal uppercase">
                TELAR
              </span>
            </div>

            {/* Tagline */}
            <p className="font-body text-lg text-charcoal mb-8 leading-relaxed">
              {t.tagline}
            </p>

            {/* Feature bullets */}
            <ul className="space-y-4">
              {[t.features.compose, t.features.manage, t.features.publish].map(
                (feature, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="mt-1.5 w-2 h-2 rounded-full bg-charcoal flex-shrink-0" />
                    <span className="font-body text-sm text-charcoal leading-relaxed">
                      {feature}
                    </span>
                  </li>
                )
              )}
            </ul>
          </div>

          {/* Footer in left panel (desktop) */}
          <div className="hidden md:block">
            <p className="font-body text-xs text-gray-400">AMPL · Neogranadina</p>
          </div>
        </div>

        {/* Right panel — sign-in form */}
        <div className="bg-white flex flex-col md:w-1/2 lg:w-3/5">
          {/* Language toggle — top right */}
          <div className="flex justify-end p-6">
            <button
              type="button"
              onClick={() => setLang(lang === "en" ? "es" : "en")}
              className="font-heading font-semibold text-xs uppercase tracking-wider text-charcoal hover:opacity-60 transition-opacity"
              aria-label={`Switch to ${t.toggle_label}`}
            >
              {t.toggle_label}
            </button>
          </div>

          {/* Form centred vertically */}
          <div className="flex-1 flex flex-col items-center justify-center px-10 pb-10">
            <div className="w-full max-w-sm">
              <h1 className="font-heading font-bold text-2xl text-charcoal mb-8">
                {t.title}
              </h1>

              {/* Error/session banners */}
              {(reason === "session_expired" || errorParam) && (
                <div className="mb-6 flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    {reason === "session_expired"
                      ? t.session_expired
                      : t.error}
                  </span>
                </div>
              )}

              <Form method="post">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full inline-flex items-center justify-center gap-2 bg-charcoal text-white font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-6 py-3 hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSubmitting ? (
                    <span className="w-4 h-4 rounded-full border-2 border-white border-t-periwinkle animate-spin" />
                  ) : (
                    <Github className="w-4 h-4" />
                  )}
                  {t.button}
                </button>
              </Form>
            </div>
          </div>
        </div>
      </div>

      {/* Footer — mobile only (desktop shows in left panel) */}
      <div className="md:hidden">
        <Footer />
      </div>
    </div>
  );
}
