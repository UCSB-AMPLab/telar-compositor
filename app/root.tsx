/**
 * This file is the root layout — the outermost React shell for every
 * page in the compositor, where i18n locale detection and the global
 * error boundary live.
 *
 * The root loader detects the locale from the `locale` cookie or the
 * Accept-Language header and passes it to the `<html lang>` attribute
 * to prevent hydration mismatches between server and client. The
 * `Layout` component wraps every authenticated and unauthenticated
 * route alike, and exports an `ErrorBoundary` (below) that catches
 * any uncaught throw from a route and renders a recoverable crash
 * screen with a Report-this-crash button wired into the bug-report
 * pipeline.
 *
 * @version v1.2.0-beta
 */

import { useEffect, useState } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
  useRouteError,
  isRouteErrorResponse,
} from "react-router";
import { useTranslation } from "react-i18next";
import type { Route } from "./+types/root";
import { getLocale } from "~/i18n/i18next.server";
import { recordError, type CapturedError } from "~/lib/error-capture";
import { BugReportPanel } from "~/components/features/bug-report/BugReportPanel";
import { ToastProvider } from "~/hooks/use-toast";

import "~/styles/app.css";

export const handle = { i18n: ["common", "bug-report"] };

export async function loader({ request, context }: Route.LoaderArgs) {
  const locale = await getLocale(request);
  const env = (context.cloudflare?.env as Env | undefined)?.ENVIRONMENT ?? "dev";
  return { locale, env };
}

export function Layout({ children }: { children: React.ReactNode }) {
  // useLoaderData is undefined during error boundary renders — fall back.
  let locale = "en";
  let env = "dev";
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const data = useLoaderData<typeof loader>();
    if (data?.locale) locale = data.locale;
    if (data?.env) env = data.env;
  } catch {
    // Error boundary context — use defaults
  }

  return (
    <html lang={locale} data-env={env}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <title>Telar Compositor</title>
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/**
 * Route ErrorBoundary — wraps every route at the root of the
 * authenticated app. When a route throws, this component:
 *
 *   1. Calls `recordError(err, "boundary")` inside a `useEffect`
 *      (the SSR guard: `useEffect` does NOT run during SSR render,
 *      so the browser-only error-capture singleton is never touched
 *      in worker eager-eval).
 *   2. Renders a fallback with Reload + Report-this-crash buttons.
 *   3. On Report click, opens `BugReportPanel` in `mode="post-crash"`
 *      with the captured error pinned and unremovable.
 *
 * The boundary host renders OUTSIDE `_app.tsx`'s shell, so the
 * existing `ToastProvider` mounted in `_app.tsx` is NOT in this React
 * tree — a fresh `ToastProvider` is wrapped around `BugReportPanel`
 * so the submit toast renders in the post-crash flow as well.
 */
export function ErrorBoundary() {
  const error = useRouteError();
  const { t } = useTranslation("bug-report");
  const [panelOpen, setPanelOpen] = useState(false);
  const [captured, setCaptured] = useState<CapturedError | null>(null);

  useEffect(() => {
    // SSR guard: useEffect runs only after client mount.
    recordError(error, "boundary");
    const message =
      error instanceof Error
        ? error.message
        : isRouteErrorResponse(error)
          ? `${error.status} ${error.statusText}`
          : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    setCaptured({
      type: "boundary",
      message,
      stack,
      timestamp: new Date().toISOString(),
      route:
        typeof window !== "undefined"
          ? window.location.pathname + window.location.search
          : undefined,
    });
  }, [error]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-cream p-6">
      <div className="max-w-md w-full bg-white rounded-lg shadow-xl p-6 text-center">
        <h1 className="font-heading text-xl font-semibold text-charcoal">
          {t("crash_title")}
        </h1>
        <p className="font-body text-sm text-gray-600 mt-3">{t("crash_intro")}</p>
        <div className="flex gap-3 justify-center mt-6">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="font-heading text-sm uppercase tracking-wider px-4 py-2 rounded text-charcoal bg-gray-100 hover:bg-gray-200 transition-colors"
          >
            {t("crash_reload")}
          </button>
          <button
            type="button"
            onClick={() => setPanelOpen(true)}
            className="font-heading text-sm uppercase tracking-wider px-4 py-2 rounded text-white bg-terracotta hover:bg-terracotta/90 transition-colors"
          >
            {t("crash_report")}
          </button>
        </div>
      </div>
      {/*
        The boundary host renders OUTSIDE _app.tsx's shell, so the existing
        ToastProvider mounted in _app.tsx is NOT in this React tree. Wrap
        BugReportPanel with a fresh ToastProvider so the submit toast
        renders in the post-crash flow as well (fix B from revision 2026-05-10).
      */}
      <ToastProvider>
        <BugReportPanel
          open={panelOpen}
          onClose={() => setPanelOpen(false)}
          mode="post-crash"
          userLogin=""
          pinnedError={captured}
        />
      </ToastProvider>
    </div>
  );
}
