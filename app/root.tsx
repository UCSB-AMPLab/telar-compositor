/**
 * Root layout — integrates i18n locale detection.
 *
 * Root loader detects locale from cookie or Accept-Language header and
 * passes it to the <html lang> attribute to prevent hydration mismatches.
 */

import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
} from "react-router";
import type { Route } from "./+types/root";
import { getLocale } from "~/i18n/i18next.server";

import "~/styles/app.css";

export const handle = { i18n: ["common"] };

export async function loader({ request }: Route.LoaderArgs) {
  const locale = await getLocale(request);
  return { locale };
}

export function Layout({ children }: { children: React.ReactNode }) {
  // useLoaderData is undefined during error boundary renders — fall back to "en"
  let locale = "en";
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const data = useLoaderData<typeof loader>();
    if (data?.locale) locale = data.locale;
  } catch {
    // Error boundary context — use default
  }

  return (
    <html lang={locale}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
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
