/**
 * Index route — redirects authenticated users to /dashboard.
 *
 * Auth middleware on _app.tsx handles the redirect to /signin for
 * unauthenticated users before this loader runs.
 */

import { redirect } from "react-router";

export async function loader() {
  throw redirect("/dashboard");
}

export default function Home() {
  return null;
}
