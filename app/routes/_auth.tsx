/**
 * Unauthenticated layout wrapper.
 *
 * Wraps the sign-in page and OAuth callback routes.
 * Cream background, no header or tabs.
 */

import { Outlet } from "react-router";

export default function AuthLayout() {
  return (
    <div className="min-h-screen bg-cream">
      <Outlet />
    </div>
  );
}
