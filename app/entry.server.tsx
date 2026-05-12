/**
 * This file is the server-side entry point — renders every request to
 * a streamed HTML response, bootstraps i18next per-request from the
 * loader-resolved locale, and distinguishes bot user-agents from
 * humans so crawlers get a non-streamed response.
 *
 * @version v1.2.0-beta
 */

import type { AppLoadContext, EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { renderToReadableStream } from "react-dom/server";
import { isbot } from "isbot";
import { I18nextProvider } from "react-i18next";
import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import resources from "~/i18n/locales";
import { getLocale } from "~/i18n/i18next.server";

export const streamTimeout = 5_000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: AppLoadContext,
) {
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  const locale = await getLocale(request);
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: "en",
    defaultNS: "common",
    // React already escapes text content automatically when rendering;
    // i18next's default HTML-escape pass is redundant and breaks
    // legitimate characters (e.g. the slash in "Coordinador/a" or
    // "juancobo/telar-uat-es" becomes "&#x2F;").
    interpolation: { escapeValue: false },
  });

  const userAgent = request.headers.get("user-agent");
  let shellRendered = false;
  const body = await renderToReadableStream(
    <I18nextProvider i18n={i18n}>
      <ServerRouter context={routerContext} url={request.url} />
    </I18nextProvider>,
    {
      signal: request.signal,
      onError(error: unknown) {
        responseStatusCode = 500;
        if (shellRendered) {
          console.error(error);
        }
      },
    },
  );
  shellRendered = true;

  if (userAgent && isbot(userAgent)) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");

  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  });
}
