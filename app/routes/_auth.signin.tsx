/**
 * This file renders the sign-in page — the GitHub OAuth entry
 * point. Every unauthenticated user lands here before they can
 * reach the rest of the app.
 *
 * Split layout: pattern left panel + branded sign-in right panel.
 * Loader redirects to `/dashboard` if a session already exists.
 * Action generates CSRF state, stores it in a cookie, and redirects
 * to the GitHub authorise URL.
 *
 * @version v1.3.0-beta
 */

import { redirect, Form, useNavigation, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { Github, AlertCircle } from "lucide-react";
import type { Route } from "./+types/_auth.signin";
import { createSessionStorage, createStateCookieStorage } from "~/lib/session.server";
import { Footer } from "~/components/layout/Footer";
import { LanguageToggle } from "~/components/ui/LanguageToggle";

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

  // Store a post-OAuth returnTo destination if present in the query string.
  // The callback handler reads this and redirects accordingly.
  const url = new URL(request.url);
  const returnTo = url.searchParams.get("returnTo");
  if (returnTo && returnTo.startsWith("/") && !returnTo.includes("//")) {
    stateSession.set("returnTo", returnTo);
  }

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

export default function SignIn() {
  const { t, i18n } = useTranslation("auth");
  const [searchParams] = useSearchParams();
  const termsHref = i18n.language?.startsWith("es") ? "/terminos.html" : "/terms.html";
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const reason = searchParams.get("reason");
  const errorParam = searchParams.get("error");

  return (
    <div className="min-h-screen flex flex-col">
      {/* Main split layout */}
      <div className="flex-1 flex flex-col md:flex-row">
        {/* Left panel — textile pattern */}
        <div
          className="hidden md:block md:w-2/5 lg:w-1/3 bg-charcoal"
          style={{
            backgroundImage: "url(/patron-oscuro-lila.svg)",
            backgroundSize: "900px",
            backgroundRepeat: "repeat",
            backgroundPosition: "center",
          }}
        />

        {/* Right panel — branding + sign-in */}
        <div className="bg-white flex flex-col flex-1">
          {/* Language toggle — top right */}
          <div className="flex justify-end p-6">
            <LanguageToggle />
          </div>

          {/* Content centred vertically */}
          <div className="flex-1 flex flex-col items-center justify-center px-10 pb-10">
            <div className="w-full max-w-md">
              {/* Logo */}
              <img
                src="/logo-lila-amarillo.svg"
                alt="Telar"
                className="h-auto w-auto mb-8"
              />

              <h1 className="font-heading font-bold text-2xl text-charcoal mb-4">
                {t("signin.title")}
              </h1>
              <p className="font-body text-base text-gray-600 mb-4 leading-relaxed">
                <a
                  href="https://telar.org"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-charcoal font-semibold hover:underline"
                >
                  Telar
                </a>{" "}
                {t("signin.intro")}
              </p>
              <p className="font-body text-base text-gray-600 mb-8 leading-relaxed">
                {t("signin.pitch")}
              </p>

              {/* Error/session banners — the account_deleted branch is handled here.
                  Amber chrome stays: amber is
                  informational here; terracotta is reserved for destructive
                  primary action surfaces. */}
              {(reason === "session_expired" ||
                reason === "account_deleted" ||
                errorParam) && (
                <div className="mb-6 flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <span>
                    {reason === "session_expired"
                      ? t("signin.session_expired")
                      : reason === "account_deleted"
                        ? t("signin.account_deleted")
                        : t("signin.error")}
                  </span>
                </div>
              )}

              <Form method="post">
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full inline-flex items-center justify-center gap-2 bg-charcoal text-white font-heading font-semibold text-sm uppercase tracking-wider rounded-full px-6 py-3 hover:opacity-90 transition-opacity disabled:bg-disabled disabled:text-fg-disabled disabled:cursor-not-allowed"
                >
                  {isSubmitting ? (
                    <span className="w-4 h-4 rounded-full border-2 border-white border-t-anil animate-spin" />
                  ) : (
                    <Github className="w-4 h-4" />
                  )}
                  {t("signin.button")}
                </button>
              </Form>

              <p className="font-body text-xs text-gray-400 text-center mt-4">
                {t("signin.terms_prefix")}{" "}
                <a
                  href={termsHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-gray-600"
                >
                  {t("signin.terms_link")}
                </a>.
              </p>
            </div>
          </div>

          {/* Footer */}
          <div className="px-10 pb-6">
            <p className="font-body text-xs text-gray-400">AMPL · Neogranadina</p>
          </div>
        </div>
      </div>

      {/* Footer — mobile only */}
      <div className="md:hidden">
        <Footer />
      </div>
    </div>
  );
}
