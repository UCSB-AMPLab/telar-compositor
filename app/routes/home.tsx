/**
 * Index route — redirects authenticated users to /start, the Atelier
 * front door. The Start tab orients returning users and onboards
 * first-run ones; onboarding still owns the zero-project path and
 * deposits the user on Site settings.
 *
 * Auth middleware on _app.tsx handles the redirect to /signin for
 * unauthenticated users before this loader runs.
 */

import { redirect } from "react-router";

export async function loader() {
  throw redirect("/start");
}

export default function Home() {
  return null;
}
